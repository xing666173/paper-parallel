import type { AiLogEvent } from '../translate/events';
import type { ProjectRepository } from '../project/repository';
import type { TaskSnapshot, Doc, SemanticUnit } from '../../types/models';
import type { ProductionPipelineStages, PipelineValue } from './productionPipeline';
import { getDocument } from '../pdf/runtime';
import { normalizeTextItem } from '../parser/pdfjsAdapter';
import { parsePageItems } from '../parser';
import { buildDoc, type ParsedPage } from '../parser/docBuilder';
import {
  prepareImmutableStructure,
  buildTranslationRequestsFromDoc,
  normalizeDeepSeekTranslationResponse,
  parseDeepSeekTranslationJson,
} from './preparation';
import { extractImmutableAssets } from '../assets/extract';
import { cropPageRegionLossless } from '../assets/crop';
import { buildTranslationBatches, translationLimitsFor } from '../translate/batcher';
import { runTranslationTask } from '../translate/coordinator';
import { chatCompletion } from '../translate/client';
import { buildBatchPrompt, buildSystemPrompt, SYSTEM_PROMPT_VERSION } from '../translate/prompts';
import type { TranslationBlockRequest, TranslationBlockResponse, TranslationRequest } from '../translate/protocol';
import { buildTranslationCacheKey } from '../project/cacheKey';
import { buildSemanticGroups, buildBlockAndAssetAlignmentUnits } from '../align/semanticUnits';
import { buildTypstProject, type TypstProject, type TypstSemanticUnit } from '../typst/project';
import { compileTypstProject, type TypstCompileResult } from '../typst/compiler';
import { getTypstRuntimePaths } from '../typst/runtimePaths';
import { readTargetMarkers } from '../align/targetMarkers';
import { matchTranslatedText, type TargetTextSegment } from '../align/textFallback';
import { resolveSourceGeometry } from '../align/sourceGeometry';
import { buildAlignmentManifest, type AlignmentManifest } from '../align/manifest';
import { runAlignmentGate } from '../quality/alignmentGate';
import type { ImmutableAsset } from '../assets/types';
import { analyzePdfLayoutWithVision } from '../vision/analyze';
import { reconcileVisionLayout } from '../vision/reconcile';
import { serializeVisionPageAnalysis } from '../vision/protocol';

const SESSION_KEY_STORAGE = 'paper-parallel.deepseek-key-session';
const LOCAL_KEY_STORAGE = 'paper-parallel.deepseek-key';

interface BrowserValue extends PipelineValue {
  projectId: string;
  settings: NonNullable<TaskSnapshot['settings']>;
  sourcePdf?: any;
  doc?: Doc;
  prepared?: ReturnType<typeof prepareImmutableStructure>;
  assets?: ImmutableAsset[];
  glossary?: Array<{ source: string; target: string; abbreviation?: string }>;
  requests?: TranslationBlockRequest[];
  translations?: TranslationBlockResponse[];
  typstProject?: TypstProject;
  typstUnits?: TypstSemanticUnit[];
  compiled?: TypstCompileResult;
  manifest?: AlignmentManifest;
  requiredBlocks?: number;
  validatedBlocks?: number;
}

export interface BrowserPipelineStageOptions {
  projectId: string;
  snapshot: TaskSnapshot;
  repository: ProjectRepository;
  apiKey?: string;
  baseUrl?: string;
  concurrency?: number;
  maxRetries?: number;
  onAiEvent?(event: AiLogEvent): void;
  onCompileProgress?(phase: string): void;
}

function value(input: PipelineValue): BrowserValue {
  return input as BrowserValue;
}

function requireValue<T>(item: T | undefined, message: string): T {
  if (item === undefined) throw new Error(message);
  return item;
}

function normalizeDocPages(doc: Doc): Doc {
  return {
    ...doc,
    blocks: doc.blocks.map((block) => ({
      ...block,
      pageIndex: Math.max(0, block.pageIndex - 1),
      fragments: block.fragments?.map((fragment) => ({ ...fragment, pageIndex: Math.max(0, fragment.pageIndex - 1) })),
    })),
    layoutRegions: doc.layoutRegions.map((region) => ({
      ...region, sourcePage: Math.max(0, region.sourcePage - 1), orderedUnitIds: [...region.orderedUnitIds],
    })),
  };
}

function responseGroups(
  request: TranslationBlockRequest,
  response: TranslationBlockResponse,
) {
  return buildSemanticGroups({
    blockId: request.blockId,
    mode: request.alignmentMode,
    sentences: request.sourceSentences,
  }, response.alignmentGroups);
}

function typstTextUnit(
  unit: SemanticUnit,
  request: TranslationBlockRequest,
  response: TranslationBlockResponse,
): TypstSemanticUnit {
  const groups = responseGroups(request, response);
  const targetSegments: TargetTextSegment[] = [];
  groups.forEach((group, groupIndex) => {
    const texts = response.alignmentGroups[groupIndex]?.targetSegments ?? [];
    group.targetUnitIds.forEach((id, segmentIndex) => targetSegments.push({ id, targetText: texts[segmentIndex] ?? '' }));
  });
  return {
    id: unit.id, kind: unit.kind, layoutRegionId: unit.layoutRegionId, order: unit.order,
    targetSegments: targetSegments.map((segment) => ({ id: segment.id, text: segment.targetText })),
  };
}

export function createBrowserPipelineStages(options: BrowserPipelineStageOptions): ProductionPipelineStages {
  const settings = requireValue(options.snapshot.settings, '任务缺少模型与源文件设置');
  const apiKey = options.apiKey
    ?? sessionStorage.getItem(SESSION_KEY_STORAGE)
    ?? localStorage.getItem(LOCAL_KEY_STORAGE)
    ?? '';

  return {
    async parse(input, signal) {
      const current = value(input);
      const artifact = await options.repository.findArtifact(`${options.projectId}:english-pdf`);
      if (!artifact) throw new Error('英文原文 PDF 不存在');
      const loading = getDocument({ data: new Uint8Array(await artifact.blob.arrayBuffer()) });
      signal.addEventListener('abort', () => { void loading.destroy(); }, { once: true });
      const pdf = await loading.promise;
      const pages: ParsedPage[] = [];
      for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex += 1) {
        if (signal.aborted) throw new DOMException('已停止', 'AbortError');
        const page = await pdf.getPage(pageIndex + 1);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const items = content.items
          .filter((item: any) => typeof item?.str === 'string')
          .map((item: any) => normalizeTextItem(item, viewport));
        const parsed = parsePageItems(items, viewport.width, viewport.height);
        pages.push({
          no: pageIndex + 1, w: viewport.width, h: viewport.height,
          layoutMode: parsed.layoutMode,
          blocks: parsed.blocks.map((block) => ({ ...block })),
        });
      }
      const doc = normalizeDocPages(buildDoc(pages, 'en'));
      if (!doc.blocks.length) throw new Error('PDF 没有可用的文字层，暂不支持扫描件');
      return { ...current, settings, sourcePdf: pdf, doc };
    },

    async analyzeLayout(input, signal) {
      const current = value(input);
      const doc = requireValue(current.doc, '解析文档缺失');
      const pdf = requireValue(current.sourcePdf, '源 PDF 缺失');
      if (!apiKey.trim()) throw new Error('Vision Exp 版式识别需要 DeepSeek API Key，请返回上传页重新验证');
      const analyses = await analyzePdfLayoutWithVision({
        pdf,
        baseUrl: options.baseUrl ?? 'https://api.deepseek.com',
        apiKey,
        fileHash: settings.sourceFileHash,
        signal,
        loadCached: async (key) => {
          const artifact = await options.repository.findArtifact(key);
          return artifact ? JSON.parse(await artifact.blob.text()) : undefined;
        },
        saveCached: async (key, _pageIndex, analysis) => options.repository.putArtifact({
          key,
          projectId: options.projectId,
          kind: 'vision-layout',
          blob: new Blob([JSON.stringify(serializeVisionPageAnalysis(analysis))], { type: 'application/json' }),
          updatedAt: Date.now(),
        }),
      });
      const reconciled = reconcileVisionLayout(doc, analyses);
      if (reconciled.unresolved.length) {
        const details = reconciled.unresolved.map((item) => (
          `第 ${item.pageIndex + 1} 页区域 ${item.regionIndex + 1}: ${item.reason}`
        )).join('；');
        throw new Error(`Vision Exp 版式结果未通过本地协调：${details}`);
      }
      const prepared = prepareImmutableStructure(doc, { verifiedAssetRegions: reconciled.assetRegions });
      const assets = await extractImmutableAssets(prepared.assetRegions, {
        crop: async (region) => cropPageRegionLossless(await pdf.getPage(region.pageIndex + 1), region.rect, 4),
      });
      return { ...current, prepared, assets };
    },

    async buildGlossary(input) {
      const current = value(input);
      const doc = requireValue(current.doc, '解析文档缺失');
      const prepared = requireValue(current.prepared, '版式结构缺失');
      const glossary = current.glossary ?? [];
      const requests = buildTranslationRequestsFromDoc({ ...doc, semanticUnits: prepared.units });
      return { ...current, glossary, requests, requiredBlocks: requests.length };
    },

    async translate(input, signal, reportProgress) {
      const current = value(input);
      const doc = requireValue(current.doc, '解析文档缺失');
      const glossary = current.glossary ?? [];
      const requests = requireValue(current.requests, '翻译请求缺失');
      const limits = translationLimitsFor(settings.thinkingMode);
      const batches = buildTranslationBatches(requests, {
        maxInputTokens: limits.maxInputTokens,
        maxBlocks: limits.maxBlocks,
        documentContext: { title: doc.meta.title, layoutMode: doc.layoutMode },
        glossary,
      });
      if (!apiKey.trim()) throw new Error('DeepSeek API Key 不存在，请返回上传页重新验证');
      const cacheKey = (block: TranslationBlockRequest) => buildTranslationCacheKey({
        fileHash: settings.sourceFileHash,
        promptVersion: SYSTEM_PROMPT_VERSION,
        modelId: settings.modelId,
        thinkingMode: settings.thinkingMode,
        glossaryHash: JSON.stringify(glossary),
        blockId: block.blockId,
        sourceText: block.source,
      });
      const streamHeartbeat = new Map<string, { at: number; phase: 'connected' | 'reasoning' | 'content' }>();
      const result = await runTranslationTask({
        projectId: options.projectId,
        modelId: settings.modelId,
        batches,
        concurrency: options.concurrency ?? 2,
        maxRetries: options.maxRetries ?? 2,
        signal,
        request: async (batch, batchSignal) => {
          const requestThinkingMode = batch.recovery?.disableThinking ? 'disabled' : settings.thinkingMode;
          const requestBody: TranslationRequest = {
            documentContext: {
              title: doc.meta.title ?? settings.sourceFileName,
              abstract: doc.semanticUnits.find((unit) => unit.kind === 'abstract')?.sourceText,
              detectedFields: [], sectionPath: '',
            },
            terminologyPolicy: {
              firstOccurrence: '中文名称（English Full Name, ABBR）',
              laterOccurrence: '固定译名或缩写',
            },
            entityPolicy: { authorNames: 'keep', organizationNames: 'translate_when_clear', modelNames: 'keep', productNames: 'keep' },
            glossary,
            ...(batch.recovery ? {
              recoveryContext: {
                reason: batch.recovery.reason,
                validationCodes: batch.recovery.validationCodes ?? [],
                validationDetails: batch.recovery.validationDetails ?? [],
              },
            } : {}),
            blocks: batch.blocks,
          };
          const recoveryInstruction = batch.recovery
            ? [
              'RECOVERY_REQUEST: Correct the previous failed block and return the complete JSON response again.',
              `RECOVERY_REASON: ${batch.recovery.reason}`,
              `VALIDATION_CODES: ${batch.recovery.validationCodes?.join(', ') ?? 'none'}`,
              'Preserve every protected_tokens item exactly, satisfy every alignment requirement, and do not omit content.',
            ].join('\n')
            : '';
          const completion = await chatCompletion({
            baseUrl: options.baseUrl ?? 'https://api.deepseek.com',
            apiKey, model: settings.modelId, thinkingMode: requestThinkingMode,
            responseFormat: 'json_object', signal: batchSignal, timeoutMs: 120_000,
            maxTokens: translationLimitsFor(requestThinkingMode).maxOutputTokens,
            stream: true,
            onStreamProgress: (progress) => {
              const at = Date.now();
              const previous = streamHeartbeat.get(batch.id);
              if (previous && previous.phase === progress.phase && at - previous.at < 2_000) return;
              streamHeartbeat.set(batch.id, { at, phase: progress.phase });
              options.onAiEvent?.({
                type: 'batch-progress', at, batchId: batch.id,
                phase: progress.phase, receivedContentChars: progress.receivedContentChars,
              });
            },
            messages: [
              { role: 'system', content: [buildSystemPrompt(), recoveryInstruction].filter(Boolean).join('\n') },
              { role: 'user', content: buildBatchPrompt(requestBody) },
            ],
          });
          return {
            ...normalizeDeepSeekTranslationResponse(parseDeepSeekTranslationJson(completion.content)),
            usage: completion.usage,
          };
        },
        findCached: async (block) => {
          const cached = await options.repository.findTranslation(cacheKey(block));
          return cached ? {
            blockId: cached.blockId, translation: cached.translation,
            alignmentGroups: cached.alignmentGroups, newTerms: [], warnings: [],
          } : undefined;
        },
        saveValidated: async (record) => options.repository.putTranslation({
          key: cacheKey(requests.find((request) => request.blockId === record.blockId)!),
          projectId: options.projectId, blockId: record.blockId,
          translation: record.translation, alignmentGroups: record.alignmentGroups, validatedAt: Date.now(),
        }),
        onEvent: (event) => {
          options.onAiEvent?.(event);
          if (event.type === 'batch-validated') {
            reportProgress?.({ type: 'validated', count: event.blockIds.length });
          } else if (event.type === 'cache-hit') {
            reportProgress?.({ type: 'validated', count: 1 });
          } else if (event.type === 'retry') {
            reportProgress?.({ type: 'retry', count: 1 });
          } else if (event.type === 'error') {
            reportProgress?.({ type: 'failed', count: event.blockIds.length });
          }
        },
      });
      return {
        ...current, requests, translations: result.translations,
        requiredBlocks: requests.length, validatedBlocks: result.completedBlockIds.length,
      };
    },

    async compose(input) {
      const current = value(input);
      const doc = requireValue(current.doc, '解析文档缺失');
      const prepared = requireValue(current.prepared, '版式结构缺失');
      const requests = requireValue(current.requests, '翻译请求缺失');
      const translations = requireValue(current.translations, '翻译结果缺失');
      const responseById = new Map(translations.map((response) => [response.blockId, response]));
      const requestById = new Map(requests.map((request) => [request.blockId, request]));
      const typstUnits: TypstSemanticUnit[] = prepared.units.map((unit) => {
        if (unit.assetId) return {
          id: unit.id, kind: unit.kind, layoutRegionId: unit.layoutRegionId, order: unit.order, assetId: unit.assetId,
        };
        return typstTextUnit(
          unit,
          requireValue(requestById.get(unit.id), `缺少翻译请求 ${unit.id}`),
          requireValue(responseById.get(unit.id), `缺少翻译结果 ${unit.id}`),
        );
      });
      const typstProject = await buildTypstProject({
        metadata: { paperWidth: doc.meta.paperWidth, paperHeight: doc.meta.paperHeight },
        regions: prepared.regions, units: typstUnits, assets: current.assets ?? [],
      });
      return { ...current, typstProject, typstUnits };
    },

    async compile(input, signal) {
      const current = value(input);
      const project = requireValue(current.typstProject, 'Typst 项目缺失');
      const compiled = await compileTypstProject(project, {
        runtimePaths: getTypstRuntimePaths(import.meta.env.BASE_URL, document.baseURI), signal,
        onProgress: (phase) => options.onCompileProgress?.(phase),
      });
      const records = [
        { key: `${options.projectId}:chinese-pdf`, kind: 'chinese-pdf' as const, blob: new Blob([compiled.pdf], { type: 'application/pdf' }) },
        { key: `${options.projectId}:typst-source`, kind: 'typst-source' as const, blob: new Blob([project.mainContent], { type: 'text/plain' }) },
        { key: `${options.projectId}:typst-preview`, kind: 'typst-preview' as const, blob: new Blob([compiled.svg], { type: 'image/svg+xml' }) },
      ];
      for (const record of records) await options.repository.putArtifact({
        ...record, projectId: options.projectId, updatedAt: Date.now(),
      });
      return { ...current, compiled };
    },

    async align(input) {
      const current = value(input);
      const doc = requireValue(current.doc, '解析文档缺失');
      const compiled = requireValue(current.compiled, '中文 PDF 缺失');
      const requests = requireValue(current.requests, '翻译请求缺失');
      const translations = requireValue(current.translations, '翻译结果缺失');
      const targetLoading = getDocument({ data: compiled.pdf.slice() });
      const targetPdf = await targetLoading.promise;
      const markers = await readTargetMarkers(targetPdf as any);
      const segments: TargetTextSegment[] = [];
      let units = requests.flatMap((request) => {
        const response = translations.find((candidate) => candidate.blockId === request.blockId)!;
        const groups = responseGroups(request, response);
        groups.forEach((group, groupIndex) => group.targetUnitIds.forEach((id, index) => {
          segments.push({ id, targetText: response.alignmentGroups[groupIndex].targetSegments[index] });
        }));
        return groups;
      });
      const immutable = requireValue(current.prepared, '版式结构缺失').units.filter((unit) => Boolean(unit.assetId));
      units.push(...buildBlockAndAssetAlignmentUnits(immutable));
      units = resolveSourceGeometry(units, doc, current.assets ?? []);
      const fallback = await matchTranslatedText(targetPdf as any, segments);
      const manifest = buildAlignmentManifest({
        projectId: options.projectId, units, markers, fallback,
      });
      await options.repository.saveAlignmentManifest(manifest);
      await targetPdf.destroy();
      return { ...current, manifest };
    },

    async validate(input) {
      const current = value(input);
      const compiled = requireValue(current.compiled, '中文 PDF 缺失');
      const manifest = requireValue(current.manifest, '对齐清单缺失');
      const alignment = runAlignmentGate(manifest);
      const pdfCompiled = new TextDecoder().decode(compiled.pdf.slice(0, 5)).startsWith('%PDF-');
      const persisted = Boolean(
        await options.repository.findArtifact(`${options.projectId}:chinese-pdf`)
        && await options.repository.loadAlignmentManifest(options.projectId),
      );
      return {
        requiredBlocks: current.requiredBlocks ?? 0,
        validatedBlocks: current.validatedBlocks ?? 0,
        failedBlocks: 0,
        protectedContentPass: true,
        pdfCompiled,
        assetsPass: true,
        alignmentBuilt: alignment.pass,
        persisted,
      };
    },
  };
}
