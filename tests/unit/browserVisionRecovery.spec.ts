import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserPipelineStages } from '../../src/core/pipeline/browserStages';
import { createTaskSnapshot } from '../../src/core/task/stateMachine';
import type { ProjectRepository } from '../../src/core/project/repository';
import type { Doc, TaskSnapshot } from '../../src/types/models';
import type { VisionPagePlan } from '../../src/core/vision/pagePlan';
import type { SourceLayoutQualityReport } from '../../src/core/quality/report';
import type { AiLogEvent } from '../../src/core/translate/events';

const doubles = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../../src/core/translate/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/core/translate/client')>(),
  chatCompletion: doubles.complete,
}));
vi.mock('../../src/core/vision/render', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/core/vision/render')>(),
  renderPdfPageAsPng: vi.fn(async () => 'data:image/png;base64,bG9jYWw='),
}));
vi.mock('../../src/core/assets/crop', () => ({
  cropPageRegionLossless: vi.fn(async () => new Blob(['local-pixel-fixture'], { type: 'image/png' })),
}));
vi.mock('../../src/core/pdf/runtime', () => ({ getDocument: vi.fn(), OPS: {} }));

function fixtureDoc(): Doc {
  const text = 'Ordinary body text remains readable and translatable in this document.';
  return {
    id: 'en', role: 'en', pageCount: 1,
    pages: [{ pageIndex: 0, width: 1000, height: 1000, columns: [] }],
    blocks: [{ id: 'body', docId: 'en', type: 'paragraph', pageIndex: 0,
      rect: { x: 100, y: 930, w: 700, h: 30 }, text, order: 0,
      splitAllowed: true, widthMode: 'span' }],
    layoutRegions: [{ id: 'region', mode: 'full-width', sourcePage: 0,
      bounds: { x: 50, y: 50, w: 900, h: 920 }, orderedUnitIds: ['body'] }],
    semanticUnits: [{ id: 'body', kind: 'paragraph', sourceText: text,
      protectedTokens: [], layoutRegionId: 'region', order: 0 }],
    layoutMode: 'single', meta: { paperWidth: 1000, paperHeight: 1000 },
  };
}

function reply(content: unknown) {
  return { content: JSON.stringify(content), usage: { promptTokens: 1, completionTokens: 1 } };
}

function stageHarness(initialRegion: Record<string, unknown>, change: (round: number) => Record<string, unknown>) {
  type Artifact = Parameters<ProjectRepository['putArtifact']>[0];
  const artifacts = new Map<string, Artifact>();
  const events: AiLogEvent[] = [];
  const settings: NonNullable<TaskSnapshot['settings']> = {
    sourceFileHash: 'local-vision-test', sourceFileName: 'local.pdf', modelId: 'deepseek-v4-flash',
    thinkingMode: 'disabled', maxVisionCorrectionCalls: 4,
  };
  doubles.complete.mockImplementation(async (request) => {
    const prompt = request.messages[0].content[0].text as string;
    if (!prompt.includes('Base plan:')) return reply({ page: 1, layout: 'single', regions: [initialRegion] });
    const base = JSON.parse(prompt.match(/^Base plan: (.*)$/m)![1]) as VisionPagePlan;
    const round = Number(prompt.match(/Correction round: (\d)/)![1]);
    return reply({ schema_version: 1, patch_id: `local-round-${round}`, page: 1,
      base_plan_version: base.planVersion, round,
      operations: [{ type: 'update-region', region_id: base.regions[0]!.id, changes: change(round) }] });
  });
  const stages = createBrowserPipelineStages({
    projectId: 'vision-test', apiKey: 'local-test-placeholder',
    snapshot: { ...createTaskSnapshot('vision-test', 1), settings },
    repository: {
      findArtifact: async (key: string) => artifacts.get(key),
      putArtifact: async (value: Artifact) => { artifacts.set(value.key, value); },
    } as ProjectRepository,
    onAiEvent: (event) => events.push(event),
  });
  return {
    artifacts, events,
    run: () => stages.analyzeLayout({
      projectId: 'vision-test', settings, doc: fixtureDoc(),
      sourcePdf: { numPages: 1, getPage: async () => ({ cleanup() {} }) },
      sourceBitmapRegions: new Map(),
    }, new AbortController().signal),
    report: async () => JSON.parse(await artifacts.get('vision-test:vision-diagnostic')!.blob.text()) as SourceLayoutQualityReport,
    plans: async (kind: Artifact['kind']) => Promise.all([...artifacts.values()]
      .filter((artifact) => artifact.kind === kind)
      .map(async (artifact) => JSON.parse(await artifact.blob.text()) as VisionPagePlan)),
  };
}

describe('browser source-layout recovery', () => {
  beforeEach(() => { doubles.complete.mockReset(); });

  it('uses round two when fixing the first error exposes a different error on the same region', async () => {
    const harness = stageHarness({
      type: 'table', bbox: [100, 0, 800, 800], column: 'full', confidence: 0.99,
    }, (round) => ({ bbox: round === 1 ? [100, 20, 800, 780] : [100, 20, 800, 580] }));

    await harness.run();

    const report = await harness.report();
    expect(report.pass).toBe(true);
    expect(report.correctionCallsUsed).toBe(2);
    expect(report.correctionAttempts.map((attempt) => [attempt.round, attempt.outcome]))
      .toEqual([[1, 'rejected'], [2, 'accepted']]);
    expect((await harness.plans('accepted-page-plan'))[0]!.regions[0]!.bbox).toEqual([100, 20, 800, 580]);
    expect(doubles.complete).toHaveBeenCalledTimes(3);
    expect(harness.events.filter((event) => event.type === 'vision-correction-stopped')).toEqual([]);
  });

  it('rejects confidence-only corrections while keeping the unresolved figure and failed diagnostic', async () => {
    const harness = stageHarness({
      type: 'figure', bbox: [100, 100, 800, 800], column: 'full', confidence: 0.99,
    }, () => ({ confidence: 0.1 }));

    await expect(harness.run()).rejects.toMatchObject({
      name: 'RecoverablePipelineError', pauseReason: 'vision-protocol-retries-exhausted',
    });

    expect(await harness.plans('accepted-page-plan')).toEqual([]);
    const recovered = await harness.plans('recovered-page-plan');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.regions).toHaveLength(1);
    expect(recovered[0]!.regions[0]!.confidence).toBe(0.99);
    expect(recovered[0]!.recoveryActions).toEqual([]);
    const report = await harness.report();
    expect(report.pass).toBe(false);
    expect(report.unresolvedIssues[0]!.code).toBe('source-plan.page-coverage-excessive');
    expect(report.correctionAttempts[0]!.outcome).toBe('request-failed');
  });

  it('pauses on low-confidence content without deleting it or claiming a passed source plan', async () => {
    const harness = stageHarness({
      type: 'display_formula', bbox: [100, 300, 700, 20], column: 'full', confidence: 0.5,
    }, () => { throw new Error('Uncertain content must not enter a geometry-only correction'); });

    await expect(harness.run()).rejects.toMatchObject({
      name: 'RecoverablePipelineError', pauseReason: 'source-layout-unresolved',
      visionAttempt: { pageIndex: 0, correctionRound: 0, errorCode: 'source-plan.unresolved' },
    });

    expect(await harness.plans('accepted-page-plan')).toEqual([]);
    const recovered = await harness.plans('recovered-page-plan');
    expect(recovered[0]!.regions).toHaveLength(1);
    expect(recovered[0]!.recoveryActions).toEqual([]);
    const report = await harness.report();
    expect(report.pass).toBe(false);
    expect(report.unresolvedIssues[0]!.code).toBe('source-plan.low-confidence');
    expect(report.correctionAttempts).toEqual([]);
    expect(doubles.complete).toHaveBeenCalledOnce();
  });
});
