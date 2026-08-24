# Paper Parallel App and Translation Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the probe-style application shell with a recoverable three-step workflow and a generic, validated, cancellable DeepSeek translation pipeline.

**Architecture:** Vue routes render upload, processing, and reader-placeholder states backed by a Pinia task store and a Dexie repository. Translation is separated into model discovery, generic prompt construction, token-bounded batching, protected-token validation, terminology state, orchestration, and UI event projection.

**Tech Stack:** Vue 3.5, Vue Router 4.4, Pinia 2.2, Dexie 4.0, TypeScript 5.6, Vitest 3, PDF.js 4, native `fetch` and `AbortController`.

**Spec:** `docs/superpowers/specs/2026-08-24-paper-parallel-browser-typesetting-reader-design.md`

## Global Constraints

- Deployment remains a static GitHub Pages site; no owned server is introduced.
- PDF files and project state remain in the browser; DeepSeek receives only translation text, required context, and the glossary.
- Use `deepseek-v4-flash` and `deepseek-v4-pro`; never default to deprecated `deepseek-chat` or `deepseek-reasoner`.
- Thinking mode is an explicit setting independent of model selection.
- Figures, tables, formulas, code, and their internal content are never sent as translatable blocks.
- The fixed system prompt is domain-neutral; paper-specific terminology is supplied through `documentContext` and `glossary`.
- AI logs show request lifecycle, cache, timing, retry, usage, and validation events; they never expose API keys or hidden reasoning.
- Cache identity is `fileHash + promptVersion + modelId + thinkingMode + glossaryHash + blockId`.
- Safe stop aborts active requests and preserves only validated results.
- Automatic navigation to the reader occurs only after the complete quality gate passes.

---

### Task 1: Freeze the task state contract

**Files:**
- Modify: `src/types/models.ts`
- Create: `src/core/task/stateMachine.ts`
- Test: `tests/unit/taskState.spec.ts`

**Interfaces:**
- Consumes: existing `Rect`, `Block`, `Doc`, and `AuditIssue` types.
- Produces: `TaskStage`, `TaskStatus`, `TaskSnapshot`, `TaskEvent`, `createTaskSnapshot()`, and `reduceTaskEvent()`.

- [ ] **Step 1: Write the failing state-machine tests**

```ts
import { describe, expect, it } from 'vitest';
import { createTaskSnapshot, reduceTaskEvent } from '../../src/core/task/stateMachine';

describe('task state machine', () => {
  it('allows the declared happy path and records timestamps', () => {
    let state = createTaskSnapshot('project-1', 1000);
    state = reduceTaskEvent(state, { type: 'START_PARSE', at: 1100 });
    state = reduceTaskEvent(state, { type: 'PARSE_DONE', at: 1200 });
    expect(state.stage).toBe('analyzing-layout');
    expect(state.startedAt).toBe(1100);
    expect(state.updatedAt).toBe(1200);
  });

  it('keeps validated progress when safely stopped', () => {
    let state = createTaskSnapshot('project-1', 1000);
    state = reduceTaskEvent(state, { type: 'START_TRANSLATION', total: 40, at: 1100 });
    state = reduceTaskEvent(state, { type: 'BLOCKS_VALIDATED', count: 12, at: 1200 });
    state = reduceTaskEvent(state, { type: 'STOP_REQUESTED', at: 1300 });
    state = reduceTaskEvent(state, { type: 'STOPPED', at: 1400 });
    expect(state.status).toBe('stopped');
    expect(state.progress.completed).toBe(12);
  });

  it('rejects completion before the quality gate passes', () => {
    const state = createTaskSnapshot('project-1', 1000);
    expect(() => reduceTaskEvent(state, { type: 'QUALITY_PASSED', at: 1200 })).toThrow(
      'QUALITY_PASSED is invalid from idle',
    );
  });
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `npm test -- tests/unit/taskState.spec.ts`

Expected: FAIL because `src/core/task/stateMachine.ts` does not exist.

- [ ] **Step 3: Add the state types to `src/types/models.ts`**

```ts
export type TaskStage =
  | 'idle'
  | 'parsing'
  | 'analyzing-layout'
  | 'building-glossary'
  | 'translating'
  | 'composing'
  | 'compiling'
  | 'aligning'
  | 'validating'
  | 'completed';

export type TaskStatus = 'idle' | 'running' | 'stopping' | 'stopped' | 'failed' | 'completed';

export interface TaskProgress {
  completed: number;
  total: number;
  retries: number;
  failed: number;
}

export interface TaskSnapshot {
  projectId: string;
  stage: TaskStage;
  status: TaskStatus;
  progress: TaskProgress;
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
  error?: string;
}
```

- [ ] **Step 4: Implement explicit transitions in `stateMachine.ts`**

```ts
import type { TaskSnapshot } from '../../types/models';

export type TaskEvent =
  | { type: 'START_PARSE'; at: number }
  | { type: 'PARSE_DONE'; at: number }
  | { type: 'START_TRANSLATION'; total: number; at: number }
  | { type: 'BLOCKS_VALIDATED'; count: number; at: number }
  | { type: 'STOP_REQUESTED'; at: number }
  | { type: 'STOPPED'; at: number }
  | { type: 'FAILED'; error: string; at: number }
  | { type: 'QUALITY_PASSED'; at: number };

export function createTaskSnapshot(projectId: string, at = Date.now()): TaskSnapshot {
  return {
    projectId,
    stage: 'idle',
    status: 'idle',
    progress: { completed: 0, total: 0, retries: 0, failed: 0 },
    createdAt: at,
    updatedAt: at,
  };
}

export function reduceTaskEvent(state: TaskSnapshot, event: TaskEvent): TaskSnapshot {
  if (event.type === 'START_PARSE' && state.stage === 'idle') {
    return { ...state, stage: 'parsing', status: 'running', startedAt: event.at, updatedAt: event.at };
  }
  if (event.type === 'PARSE_DONE' && state.stage === 'parsing') {
    return { ...state, stage: 'analyzing-layout', updatedAt: event.at };
  }
  if (event.type === 'START_TRANSLATION') {
    return {
      ...state,
      stage: 'translating',
      status: 'running',
      progress: { completed: 0, total: event.total, retries: 0, failed: 0 },
      startedAt: state.startedAt ?? event.at,
      updatedAt: event.at,
    };
  }
  if (event.type === 'BLOCKS_VALIDATED' && state.stage === 'translating') {
    return {
      ...state,
      progress: { ...state.progress, completed: state.progress.completed + event.count },
      updatedAt: event.at,
    };
  }
  if (event.type === 'STOP_REQUESTED' && state.status === 'running') {
    return { ...state, status: 'stopping', updatedAt: event.at };
  }
  if (event.type === 'STOPPED' && state.status === 'stopping') {
    return { ...state, status: 'stopped', updatedAt: event.at };
  }
  if (event.type === 'FAILED') {
    return { ...state, status: 'failed', error: event.error, updatedAt: event.at };
  }
  if (event.type === 'QUALITY_PASSED' && state.stage === 'validating') {
    return { ...state, stage: 'completed', status: 'completed', updatedAt: event.at };
  }
  throw new Error(`${event.type} is invalid from ${state.stage}`);
}
```

- [ ] **Step 5: Run the focused and existing type tests**

Run: `npm test -- tests/unit/taskState.spec.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the contract**

```bash
git add src/types/models.ts src/core/task/stateMachine.ts tests/unit/taskState.spec.ts
git commit -m "feat: define recoverable task state machine"
```

---

### Task 2: Add IndexedDB project and translation cache repositories

**Files:**
- Create: `src/core/project/db.ts`
- Create: `src/core/project/cacheKey.ts`
- Create: `src/core/project/repository.ts`
- Test: `tests/unit/cacheKey.spec.ts`
- Test: `tests/unit/projectRepository.spec.ts`

**Interfaces:**
- Consumes: `TaskSnapshot`, the selected source PDF Blob, and translation result records.
- Produces: `buildTranslationCacheKey(input)`, `ProjectRepository`, `saveTask()`, `loadTask()`, `putTranslation()`, `findTranslation()`, `clearProjectTranslation()`, `putArtifact()`, `findArtifact()`.

- [ ] **Step 1: Write deterministic cache-key tests**

```ts
import { describe, expect, it } from 'vitest';
import { buildTranslationCacheKey } from '../../src/core/project/cacheKey';

describe('translation cache identity', () => {
  const base = {
    fileHash: 'sha256:file',
    promptVersion: 'academic-json-v2',
    modelId: 'deepseek-v4-flash',
    thinkingMode: 'disabled' as const,
    glossaryHash: 'sha256:terms',
    blockId: 'sec-1-p-1-s-1',
  };

  it('is stable for equal inputs', () => {
    expect(buildTranslationCacheKey(base)).toBe(buildTranslationCacheKey({ ...base }));
  });

  it.each(['promptVersion', 'modelId', 'thinkingMode', 'glossaryHash', 'blockId'] as const)(
    'changes when %s changes',
    (field) => {
      expect(buildTranslationCacheKey(base)).not.toBe(
        buildTranslationCacheKey({ ...base, [field]: `${base[field]}-changed` }),
      );
    },
  );
});
```

- [ ] **Step 2: Write repository tests with `fake-indexeddb`**

Add `fake-indexeddb@6.2.5` as an exact dev dependency and test that clearing one project leaves another project intact:

```ts
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createProjectRepository } from '../../src/core/project/repository';

describe('project repository', () => {
  beforeEach(async () => indexedDB.deleteDatabase('paper-parallel-test'));

  it('clears only the selected project translation cache', async () => {
    const repo = createProjectRepository('paper-parallel-test');
    await repo.putTranslation({ key: 'a:1', projectId: 'a', blockId: '1', translation: '甲', alignmentGroups: [], validatedAt: 1 });
    await repo.putTranslation({ key: 'b:1', projectId: 'b', blockId: '1', translation: '乙', alignmentGroups: [], validatedAt: 1 });
    await repo.clearProjectTranslation('a');
    expect(await repo.findTranslation('a:1')).toBeUndefined();
    expect((await repo.findTranslation('b:1'))?.translation).toBe('乙');
  });

  it('persists the source PDF independently from translation cache', async () => {
    const repo = createProjectRepository('paper-parallel-test');
    const source = new Blob(['%PDF-source'], { type: 'application/pdf' });
    await repo.putArtifact({
      key: 'a:english-pdf', projectId: 'a', kind: 'english-pdf', blob: source, updatedAt: 1,
    });
    await repo.clearProjectTranslation('a');
    expect((await repo.findArtifact('a:english-pdf'))?.blob.size).toBe(source.size);
  });
});
```

- [ ] **Step 3: Install the test dependency and verify failures**

Run:

```bash
npm install --save-dev --save-exact fake-indexeddb@6.2.5
npm test -- tests/unit/cacheKey.spec.ts tests/unit/projectRepository.spec.ts
```

Expected: FAIL because the repository modules do not exist.

- [ ] **Step 4: Implement the cache key without secrets**

```ts
export interface TranslationCacheIdentity {
  fileHash: string;
  promptVersion: string;
  modelId: string;
  thinkingMode: 'enabled' | 'disabled';
  glossaryHash: string;
  blockId: string;
}

export function buildTranslationCacheKey(value: TranslationCacheIdentity): string {
  return [
    value.fileHash,
    value.promptVersion,
    value.modelId,
    value.thinkingMode,
    value.glossaryHash,
    value.blockId,
  ].map(encodeURIComponent).join(':');
}
```

- [ ] **Step 5: Implement Dexie tables and the repository facade**

```ts
import Dexie, { type EntityTable } from 'dexie';
import type { TaskSnapshot } from '../../types/models';

export interface TranslationCacheRecord {
  key: string;
  projectId: string;
  blockId: string;
  translation: string;
  alignmentGroups: Array<{ sourceSentenceIds: string[]; targetSegments: string[] }>;
  validatedAt: number;
}

export type ProjectArtifactKind = 'english-pdf';

export interface ProjectArtifactRecord {
  key: string;
  projectId: string;
  kind: ProjectArtifactKind;
  blob: Blob;
  updatedAt: number;
}

export class PaperParallelDb extends Dexie {
  tasks!: EntityTable<TaskSnapshot, 'projectId'>;
  translations!: EntityTable<TranslationCacheRecord, 'key'>;
  artifacts!: EntityTable<ProjectArtifactRecord, 'key'>;

  constructor(name = 'paper-parallel') {
    super(name);
    this.version(1).stores({
      tasks: 'projectId,updatedAt',
      translations: 'key,projectId,blockId',
      artifacts: 'key,projectId,kind',
    });
  }
}
```

`createProjectRepository(name)` must instantiate `PaperParallelDb` and expose the seven repository methods named in the Interfaces block. `clearProjectTranslation(projectId)` must execute `db.translations.where('projectId').equals(projectId).delete()` and must not delete the `english-pdf` artifact.

- [ ] **Step 6: Run repository tests and typecheck**

Run: `npm test -- tests/unit/cacheKey.spec.ts tests/unit/projectRepository.spec.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit persistence**

```bash
git add package.json package-lock.json src/core/project tests/unit/cacheKey.spec.ts tests/unit/projectRepository.spec.ts
git commit -m "feat: persist tasks and validated translations"
```

---

### Task 3: Modernize the DeepSeek client and model discovery

**Files:**
- Modify: `src/core/translate/client.ts`
- Modify: `tests/unit/client.spec.ts`

**Interfaces:**
- Consumes: native `fetch` and optional caller `AbortSignal`.
- Produces: `listModels(options): Promise<DeepSeekModel[]>` and an expanded `chatCompletion(options)` supporting JSON output and thinking mode.

- [ ] **Step 1: Replace legacy model assertions with current API behavior**

Add tests for `/models`, `thinking`, JSON output, timeout, and outer abort:

```ts
it('lists current models and excludes deprecated aliases', async () => {
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({
    data: [
      { id: 'deepseek-v4-flash', object: 'model', owned_by: 'deepseek' },
      { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
      { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' },
    ],
  }), { status: 200 })) as typeof fetch;
  const models = await listModels({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', fetchFn });
  expect(models.map((model) => model.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
});

it('sends thinking and JSON response options', async () => {
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"blocks":[]}' } }],
  }), { status: 200 })) as typeof fetch;
  await chatCompletion({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-test',
    model: 'deepseek-v4-pro',
    thinkingMode: 'enabled',
    responseFormat: 'json_object',
    messages: [{ role: 'user', content: 'translate' }],
    fetchFn,
  });
  const body = JSON.parse((fetchFn as any).mock.calls[0][1].body);
  expect(body).toMatchObject({
    model: 'deepseek-v4-pro',
    thinking: { type: 'enabled' },
    response_format: { type: 'json_object' },
  });
  expect(body).not.toHaveProperty('temperature');
});
```

- [ ] **Step 2: Run the client test and confirm failures**

Run: `npm test -- tests/unit/client.spec.ts`

Expected: FAIL because `listModels`, `thinkingMode`, and `responseFormat` are not implemented.

- [ ] **Step 3: Add current model and request types**

```ts
export interface DeepSeekModel {
  id: 'deepseek-v4-flash' | 'deepseek-v4-pro';
  label: 'DeepSeek V4 Flash' | 'DeepSeek V4 Pro';
}

export interface DeepSeekConnectionOptions {
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}
```

- [ ] **Step 4: Implement model discovery and request construction**

Use `new URL('models', normalizedBaseUrlWithSlash)` for model discovery. Filter the response to the two supported IDs, map labels explicitly, and fall back to the same two IDs only when the caller requests an offline fallback. In `chatCompletion`, set `thinking: { type: opts.thinkingMode }`; omit `temperature` when thinking is enabled; set `response_format` only when requested; and expose `timeoutMs` with a default of `120_000`.

The abort handler must normalize timeout errors to `DeepSeek 请求超时` and preserve caller abort as `AbortError`.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- tests/unit/client.spec.ts`

Expected: PASS with no request body containing a deprecated model name.

- [ ] **Step 6: Commit the client update**

```bash
git add src/core/translate/client.ts tests/unit/client.spec.ts
git commit -m "feat: support current DeepSeek models and thinking mode"
```

---

### Task 4: Build the domain-neutral translation protocol

**Files:**
- Create: `src/core/translate/protocol.ts`
- Create: `src/core/translate/prompts.ts`
- Create: `src/core/translate/protected.ts`
- Create: `src/core/align/sourceSentences.ts`
- Test: `tests/unit/translationProtocol.spec.ts`

**Interfaces:**
- Consumes: parsed semantic text blocks.
- Produces: `TranslationRequest`, `TranslationResponse`, `SYSTEM_PROMPT_VERSION`, `buildSourceSentenceCandidates()`, `buildSystemPrompt()`, `buildBatchPrompt()`, `extractProtectedTokens()`, and `validateBatchResponse()`.

- [ ] **Step 1: Write tests for genericity and protected content**

```ts
import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  buildBatchPrompt,
  SYSTEM_PROMPT_VERSION,
} from '../../src/core/translate/prompts';
import { validateBatchResponse } from '../../src/core/translate/protected';
import { buildSourceSentenceCandidates } from '../../src/core/align/sourceSentences';

describe('generic academic translation protocol', () => {
  it('creates stable source candidates before any translation request', () => {
    expect(buildSourceSentenceCandidates('p1', 'First result. Second result!')).toEqual({
      mode: 'sentence-candidates',
      sentences: [
        { id: 'p1-s-1', text: 'First result.' },
        { id: 'p1-s-2', text: 'Second result!' },
      ],
    });
  });

  it('does not hardcode a discipline or paper-specific terminology', () => {
    const prompt = buildSystemPrompt();
    expect(SYSTEM_PROMPT_VERSION).toBe('academic-json-v2');
    expect(prompt).not.toMatch(/zkVM|Zero-Knowledge|计算机体系结构|密码学|医学/);
    expect(prompt).toContain('document_context');
    expect(prompt).toContain('protected_tokens');
  });

  it('places paper-specific terminology only in the batch payload', () => {
    const prompt = buildBatchPrompt({
      documentContext: { title: 'A Medical Study', abstract: 'A trial', detectedFields: ['medicine'], sectionPath: 'Methods' },
      terminologyPolicy: { firstOccurrence: '中文名称（英文全称, 缩写）', laterOccurrence: '固定译名或缩写' },
      entityPolicy: { authorNames: 'keep', organizationNames: 'translate_when_clear', modelNames: 'keep', productNames: 'keep' },
      glossary: [{ source: 'myocardial infarction', target: '心肌梗死' }],
      blocks: [{
        blockId: 'p1',
        kind: 'paragraph',
        source: 'Myocardial infarction affected 12%.',
        alignmentMode: 'sentence-candidates',
        sourceSentences: [{ id: 'p1-s-1', text: 'Myocardial infarction affected 12%.' }],
        protectedTokens: ['12%'],
      }],
    });
    expect(prompt).toContain('心肌梗死');
    expect(prompt).toContain('12%');
  });

  it('rejects changed numbers and protected markers', () => {
    const result = validateBatchResponse(
      [{
        blockId: 'p1', kind: 'paragraph', source: 'Accuracy was 96%. ⟦CITE:4⟧',
        alignmentMode: 'sentence-candidates',
        sourceSentences: [{ id: 'p1-s-1', text: 'Accuracy was 96%. ⟦CITE:4⟧' }],
        protectedTokens: ['96%', '⟦CITE:4⟧'],
      }],
      { blocks: [{
        blockId: 'p1', translation: '准确率为 69%。⟦CITE:5⟧',
        alignmentGroups: [{ sourceSentenceIds: ['p1-s-1'], targetSegments: ['准确率为 69%。⟦CITE:5⟧'] }],
        newTerms: [], warnings: [],
      }] },
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(['protected-token-changed', 'protected-token-changed']);
  });

  it('accepts continuous sentence groups without forcing equal sentence counts', () => {
    const source = [{
      blockId: 'p1', kind: 'paragraph' as const, source: 'First result. Second result. Third result.',
      alignmentMode: 'sentence-candidates' as const,
      sourceSentences: [
        { id: 'p1-s-1', text: 'First result.' },
        { id: 'p1-s-2', text: 'Second result.' },
        { id: 'p1-s-3', text: 'Third result.' },
      ],
      protectedTokens: [],
    }];
    const response = { blocks: [{
      blockId: 'p1',
      translation: '前两个结果合并说明。第三个结果拆成两句。补充说明。',
      alignmentGroups: [
        { sourceSentenceIds: ['p1-s-1', 'p1-s-2'], targetSegments: ['前两个结果合并说明。'] },
        { sourceSentenceIds: ['p1-s-3'], targetSegments: ['第三个结果拆成两句。', '补充说明。'] },
      ],
      newTerms: [], warnings: [],
    }] };
    expect(validateBatchResponse(source, response).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run the protocol test and verify failure**

Run: `npm test -- tests/unit/translationProtocol.spec.ts`

Expected: FAIL because the protocol files do not exist.

- [ ] **Step 3: Define strict request and response types**

```ts
export interface TranslationBlockRequest {
  blockId: string;
  kind: 'title' | 'author' | 'affiliation' | 'abstract' | 'heading' | 'paragraph' | 'list-item' | 'caption' | 'table-title';
  source: string;
  alignmentMode: 'sentence-candidates' | 'paragraph-fallback';
  sourceSentences: Array<{ id: string; text: string }>;
  protectedTokens: string[];
}

export interface TranslationAlignmentGroup {
  sourceSentenceIds: string[];
  targetSegments: string[];
}

export interface TranslationBlockResponse {
  blockId: string;
  translation: string;
  alignmentGroups: TranslationAlignmentGroup[];
  newTerms: Array<{ source: string; target: string; abbreviation?: string }>;
  warnings: string[];
}

export interface TranslationResponse {
  blocks: TranslationBlockResponse[];
}
```

The request must not include `figure`, `table`, `formula`, `code`, `reference`, or `page-furniture` as translatable kinds. Paragraphs, list items, and captions remain whole translation blocks; `sourceSentences` are alignment candidates and must not be sent as independent translation requests.

- [ ] **Step 4: Generate stable source sentence candidates before translation**

Move deterministic source segmentation ahead of batching. `buildSourceSentenceCandidates(blockId, text)` reuses the existing `splitSentences()` logic and accepts sentence mode only when rejoining normalized candidates covers at least 98% of normalized source text. Stable IDs are `${blockId}-s-${oneBasedIndex}`. If the threshold fails or technical punctuation makes boundaries ambiguous, return one candidate `{ id: blockId, text }` with `mode: 'paragraph-fallback'`. These IDs are cached with the block and never delegated to DeepSeek.

- [ ] **Step 5: Implement the fixed system prompt and JSON payload builder**

`buildSystemPrompt()` returns the approved generic rules from the spec: fidelity, domain adaptation through supplied context, glossary precedence, immutable content, unchanged source IDs/order, no layout decisions, and JSON-only output. It explicitly permits natural Chinese sentence splitting and merging, but requires continuous `sourceSentenceIds[]` to continuous `targetSegments[]` groups. `buildBatchPrompt()` returns `JSON.stringify(request)` with no prose concatenation and no API key.

- [ ] **Step 6: Implement deterministic validation**

`validateBatchResponse(sourceBlocks, response)` must verify exact block ID set and order, non-empty translation, all protected tokens, all numbers and citation markers, and absence of extra blocks. For each block, every source sentence ID must occur exactly once across `alignmentGroups`, group IDs must be contiguous and source-ordered, every target segment must be non-empty, and concatenated normalized target segments must equal the normalized `translation`. This admits `1→1`, `1→N`, `N→1`, and `N→M` while rejecting crossed or invented mappings. It returns:

```ts
export interface TranslationValidationResult {
  ok: boolean;
  accepted: TranslationBlockResponse[];
  issues: Array<{ blockId: string; code: string; message: string }>;
}
```

Use exact token occurrence counts, not only `includes`, so duplicate citations and values cannot silently disappear.

- [ ] **Step 7: Run protocol and existing audit tests**

Run: `npm test -- tests/unit/translationProtocol.spec.ts tests/unit/audit.spec.ts`

Expected: PASS.

- [ ] **Step 8: Commit the protocol**

```bash
git add src/core/align/sourceSentences.ts src/core/translate/protocol.ts src/core/translate/prompts.ts src/core/translate/protected.ts tests/unit/translationProtocol.spec.ts
git commit -m "feat: add generic validated translation protocol"
```

---

### Task 5: Add document terminology state and token-bounded batching

**Files:**
- Create: `src/core/translate/terminology.ts`
- Create: `src/core/translate/batcher.ts`
- Test: `tests/unit/terminology.spec.ts`
- Test: `tests/unit/batcher.spec.ts`

**Interfaces:**
- Consumes: document context, translatable blocks, user glossary, and model token budget.
- Produces: `mergeGlossary()`, `markFirstOccurrences()`, and `buildTranslationBatches()`.

- [ ] **Step 1: Write glossary precedence and first-occurrence tests**

```ts
it('user glossary overrides detected and model terms', () => {
  expect(mergeGlossary({
    detected: [{ source: 'trace', target: '轨迹' }],
    model: [{ source: 'trace', target: '执行轨迹' }],
    user: [{ source: 'trace', target: '跟踪记录' }],
  })).toEqual([{ source: 'trace', target: '跟踪记录', sourceType: 'user' }]);
});

it('marks only the first ordered occurrence in the whole document', () => {
  const marked = markFirstOccurrences(
    [{ blockId: 'a', source: 'A trace is produced.' }, { blockId: 'b', source: 'The trace is stored.' }],
    [{ source: 'trace', target: '执行轨迹', abbreviation: 'Trace' }],
  );
  expect(marked[0].firstTermIds).toEqual(['trace']);
  expect(marked[1].firstTermIds).toEqual([]);
});
```

- [ ] **Step 2: Write batching tests**

```ts
it('keeps order and never splits a block across batches', () => {
  const batches = buildTranslationBatches(
    [
      { blockId: 'a', kind: 'paragraph', source: 'a'.repeat(100), protectedTokens: [] },
      { blockId: 'b', kind: 'paragraph', source: 'b'.repeat(100), protectedTokens: [] },
      { blockId: 'c', kind: 'paragraph', source: 'c'.repeat(100), protectedTokens: [] },
    ],
    { maxInputTokens: 80, estimateTokens: (text) => Math.ceil(text.length / 4) },
  );
  expect(batches.flatMap((batch) => batch.blocks.map((block) => block.blockId))).toEqual(['a', 'b', 'c']);
  expect(batches.every((batch) => batch.estimatedTokens <= 80)).toBe(true);
});
```

- [ ] **Step 3: Run tests and verify missing modules**

Run: `npm test -- tests/unit/terminology.spec.ts tests/unit/batcher.spec.ts`

Expected: FAIL.

- [ ] **Step 4: Implement normalized glossary merging**

Normalize source terms with Unicode NFKC and case-folding, preserve the winning spelling, and enforce precedence `user > detected > model`. `markFirstOccurrences()` must process blocks in document order and return immutable copies.

- [ ] **Step 5: Implement token-bounded batches**

Use a conservative default estimator of `Math.ceil([...text].length / 2.5)` for mixed Chinese/English payloads. Account for serialized document context and glossary before accepting blocks. A single oversized block becomes a one-block batch marked `oversized: true`; it is never silently split because IDs and sentence mapping must remain stable.

- [ ] **Step 6: Run the focused tests**

Run: `npm test -- tests/unit/terminology.spec.ts tests/unit/batcher.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit terminology and batching**

```bash
git add src/core/translate/terminology.ts src/core/translate/batcher.ts tests/unit/terminology.spec.ts tests/unit/batcher.spec.ts
git commit -m "feat: manage terminology and translation batches"
```

---

### Task 6: Replace serial block translation with a cancellable coordinator

**Files:**
- Create: `src/core/translate/events.ts`
- Create: `src/core/translate/coordinator.ts`
- Modify: `src/core/translate/index.ts`
- Test: `tests/unit/coordinator.spec.ts`

**Interfaces:**
- Consumes: batches, `chatCompletion`, cache repository, validation, and a caller `AbortSignal`.
- Produces: `runTranslationTask(options): Promise<TranslationTaskResult>` and typed `AiLogEvent` events.

- [ ] **Step 1: Write coordinator tests for cache, retry, progress, and abort**

```ts
it('persists only validated batches and emits lifecycle events', async () => {
  const events: string[] = [];
  const saved: string[] = [];
  const result = await runTranslationTask({
    projectId: 'p1',
    batches: [{ id: 'batch-1', blocks: [sourceBlock], estimatedTokens: 40, oversized: false }],
    concurrency: 2,
    maxRetries: 2,
    request: async () => ({ blocks: [{
      blockId: 'b1',
      translation: '准确率为 96%。',
      alignmentGroups: [{ sourceSentenceIds: ['b1-s-1'], targetSegments: ['准确率为 96%。'] }],
      newTerms: [], warnings: [],
    }], usage: { promptTokens: 20, completionTokens: 8 } }),
    findCached: async () => undefined,
    saveValidated: async (record) => saved.push(record.blockId),
    onEvent: (event) => events.push(event.type),
  });
  expect(result.completedBlockIds).toEqual(['b1']);
  expect(saved).toEqual(['b1']);
  expect(events).toEqual(['batch-started', 'batch-received', 'batch-validated', 'cache-written']);
});

it('aborts active work without starting queued batches', async () => {
  const controller = new AbortController();
  const started: string[] = [];
  await expect(runTranslationTask({
    projectId: 'p1',
    batches: twoBatches,
    concurrency: 1,
    maxRetries: 0,
    signal: controller.signal,
    request: async (batch) => {
      started.push(batch.id);
      controller.abort();
      throw new DOMException('Stopped', 'AbortError');
    },
    findCached: async () => undefined,
    saveValidated: async () => undefined,
    onEvent: () => undefined,
  })).rejects.toMatchObject({ name: 'AbortError' });
  expect(started).toEqual(['batch-1']);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm test -- tests/unit/coordinator.spec.ts`

Expected: FAIL because `runTranslationTask` does not exist.

- [ ] **Step 3: Define safe log events**

```ts
export type AiLogEvent =
  | { type: 'batch-started'; at: number; batchId: string; blockIds: string[]; modelId: string }
  | { type: 'batch-received'; at: number; batchId: string; elapsedMs: number; promptTokens: number; completionTokens: number }
  | { type: 'batch-validated'; at: number; batchId: string; blockIds: string[] }
  | { type: 'cache-hit'; at: number; blockId: string }
  | { type: 'cache-written'; at: number; blockId: string }
  | { type: 'retry'; at: number; batchId: string; attempt: number; reason: string }
  | { type: 'error'; at: number; batchId: string; message: string };
```

No event type may carry `apiKey`, raw authorization headers, or `reasoning_content`.

- [ ] **Step 4: Implement a bounded worker pool**

Use an index protected by the JavaScript event loop and create exactly `Math.min(concurrency, batches.length)` async workers. Each worker checks the signal before taking a batch, resolves cached blocks first, requests the remaining block subset, validates the full response, writes each accepted block, and retries only the failed batch. Abort errors are rethrown immediately and never retried.

- [ ] **Step 5: Export the coordinator and remove new callers from `runResumableTranslation`**

Keep legacy exports temporarily for probe regression, but application routes must import `runTranslationTask`. Add a deprecation comment to `runResumableTranslation` stating that it remains probe-only until the final migration plan removes the dependency.

- [ ] **Step 6: Run coordinator, legacy pipeline, and session tests**

Run: `npm test -- tests/unit/coordinator.spec.ts tests/unit/pipeline.spec.ts tests/unit/session.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit the coordinator**

```bash
git add src/core/translate/events.ts src/core/translate/coordinator.ts src/core/translate/index.ts tests/unit/coordinator.spec.ts
git commit -m "feat: coordinate batched cancellable translation"
```

---

### Task 7: Project task store, AI log projection, and ETA calculation

**Files:**
- Create: `src/core/task/metrics.ts`
- Create: `src/stores/task.ts`
- Modify: `src/main.ts`
- Test: `tests/unit/taskMetrics.spec.ts`
- Test: `tests/unit/taskStore.spec.ts`

**Interfaces:**
- Consumes: `TaskEvent`, `AiLogEvent`, and project repository methods.
- Produces: `estimateRemainingMs(samples, remainingTokens)`, `useTaskStore()`, `start()`, `safeStop()`, `resume()`, and `clearTranslationCache()`.

- [ ] **Step 1: Add Pinia test activation and metrics assertions**

```ts
import { createPinia, setActivePinia } from 'pinia';

beforeEach(() => setActivePinia(createPinia()));

it('projects safe AI events but drops secret-like fields', () => {
  const store = useTaskStore();
  store.recordAiEvent({ type: 'batch-started', at: 1, batchId: 'b1', blockIds: ['x'], modelId: 'deepseek-v4-flash' });
  expect(store.aiLog[0].message).toContain('b1');
  expect(JSON.stringify(store.aiLog)).not.toContain('sk-');
});

it('estimates from recent throughput and returns null without samples', () => {
  expect(estimateRemainingMs([], 1000)).toBeNull();
  expect(estimateRemainingMs([{ tokens: 100, elapsedMs: 2000 }, { tokens: 200, elapsedMs: 4000 }], 300)).toBe(6000);
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `npm test -- tests/unit/taskMetrics.spec.ts tests/unit/taskStore.spec.ts`

Expected: FAIL.

- [ ] **Step 3: Implement robust ETA calculation**

Keep the most recent eight successful samples, discard zero-token/zero-time samples, calculate median milliseconds per token, and return `null` until two samples exist. The UI renders `正在估算` for `null`.

- [ ] **Step 4: Implement the Pinia store**

The store owns `current`, `aiLog`, `abortController`, `throughputSamples`, and `lastResponseAt`. `safeStop()` dispatches `STOP_REQUESTED`, aborts the controller, waits for the coordinator promise to settle, dispatches `STOPPED`, and persists the snapshot. `recordAiEvent()` maps each event to a fixed Chinese message template rather than rendering arbitrary server strings.

- [ ] **Step 5: Install Pinia in the app root**

```ts
import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';

createApp(App).use(createPinia()).use(router).mount('#app');
```

- [ ] **Step 6: Run store tests and typecheck**

Run: `npm test -- tests/unit/taskMetrics.spec.ts tests/unit/taskStore.spec.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the store**

```bash
git add src/core/task/metrics.ts src/stores/task.ts src/main.ts tests/unit/taskMetrics.spec.ts tests/unit/taskStore.spec.ts
git commit -m "feat: project task progress and safe AI logs"
```

---

### Task 8: Replace the app shell and upload/settings page

**Files:**
- Modify: `package.json`
- Modify: `vitest.config.ts`
- Modify: `src/App.vue`
- Modify: `src/router/index.ts`
- Create: `src/styles/app.css`
- Create: `src/views/UploadView.vue`
- Create: `src/components/upload/PdfDropzone.vue`
- Create: `src/components/upload/TranslationSettings.vue`
- Test: `tests/components/UploadView.spec.ts`

**Interfaces:**
- Consumes: DeepSeek `listModels`, project repository, and task store.
- Produces: validated project creation and navigation to `/task/:projectId/process`.

- [ ] **Step 1: Install Vue component test dependencies**

Run:

```bash
npm install --save-dev --save-exact @vue/test-utils@2.4.11 jsdom@30.0.1
```

- [ ] **Step 2: Write the upload page component test**

```ts
// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { expect, it } from 'vitest';
import UploadView from '../../src/views/UploadView.vue';

it('shows current DeepSeek choices and omits probe content', async () => {
  const wrapper = mount(UploadView, {
    global: { stubs: { RouterLink: true } },
  });
  expect(wrapper.text()).toContain('上传英文论文');
  expect(wrapper.text()).toContain('DeepSeek V4 Flash');
  expect(wrapper.text()).toContain('DeepSeek V4 Pro');
  expect(wrapper.text()).not.toContain('deepseek-chat');
  expect(wrapper.text()).not.toContain('无文件合成演示');
  expect(wrapper.text()).not.toContain('所有文件仅在浏览器中处理');
});
```

- [ ] **Step 3: Configure component tests and verify failure**

Set `vitest.config.ts` to keep Node as the default environment; the file pragma above selects jsdom only for component tests. Run `npm test -- tests/components/UploadView.spec.ts` and confirm it fails because the view does not exist.

- [ ] **Step 4: Build the three-step application shell**

`App.vue` must render plain product text, route-derived steps `上传论文`, `翻译排版`, `对照阅读`, and `router-view`. Import `src/styles/app.css` once from `main.ts`. Do not retain the five-item demo navigation.

- [ ] **Step 5: Build upload controls with exact settings**

`TranslationSettings.vue` accepts `models`, `modelValue`, `thinkingMode`, `apiKey`, and `saveKey`; emits updates and `test-connection`. `PdfDropzone.vue` accepts only one `application/pdf` file and emits `selected`. `UploadView.vue` computes a SHA-256 file hash with `crypto.subtle.digest`, creates a project, saves the PDF Blob through `putArtifact({ kind: 'english-pdf', ... })`, and routes only after a file and successful connection test exist.

- [ ] **Step 6: Replace router records**

```ts
const routes = [
  { path: '/', name: 'upload', component: () => import('../views/UploadView.vue') },
  { path: '/task/:projectId/process', name: 'process', component: () => import('../views/ProcessingView.vue') },
  { path: '/task/:projectId/read', name: 'reader', component: () => import('../views/ReaderTaskView.vue') },
];
```

Create temporary `ProcessingView.vue` and `ReaderTaskView.vue` shells containing only route title, project ID, and back navigation; Task 9 replaces the processing shell, and the third implementation plan replaces the reader shell.

- [ ] **Step 7: Run component, type, and build checks**

Run: `npm test -- tests/components/UploadView.spec.ts && npm run typecheck && npm run build`

Expected: PASS and no production route imports old demo views.

- [ ] **Step 8: Commit the new shell**

```bash
git add package.json package-lock.json vitest.config.ts src/App.vue src/main.ts src/router src/styles src/views src/components/upload tests/components/UploadView.spec.ts
git commit -m "feat: replace probe shell with upload workflow"
```

---

### Task 9: Build the processing dashboard with progress, AI logs, and safe stop

**Files:**
- Create: `src/components/processing/ProgressSummary.vue`
- Create: `src/components/processing/StageTimeline.vue`
- Create: `src/components/processing/AiLogPanel.vue`
- Create: `src/components/processing/PaperPreview.vue`
- Modify: `src/views/ProcessingView.vue`
- Test: `tests/components/ProcessingView.spec.ts`

**Interfaces:**
- Consumes: `useTaskStore()`, persisted task state, English page preview, and accepted translated blocks.
- Produces: visible progress/ETA/logs, `safeStop()`, task resume, and a successful-processing event.

- [ ] **Step 1: Write processing UI tests**

```ts
// @vitest-environment jsdom
it('keeps progress and shows a bounded AI log panel', () => {
  const wrapper = mount(ProcessingView, { global: testAppGlobals('/task/p1/process') });
  expect(wrapper.text()).toContain('总体进度');
  expect(wrapper.text()).toContain('预计剩余');
  expect(wrapper.text()).toContain('AI 日志');
  expect(wrapper.text()).toContain('安全停止');
  expect(wrapper.text()).toContain('仅显示任务事件，不显示思维过程');
});

it('does not label a failed quality gate as complete', async () => {
  const store = useTaskStore();
  store.current = { ...validatingTask, status: 'failed', error: '2 个受保护标记不一致' };
  const wrapper = mount(ProcessingView, { global: testAppGlobals('/task/p1/process') });
  expect(wrapper.text()).not.toContain('处理完成');
  expect(wrapper.text()).toContain('2 个受保护标记不一致');
});
```

- [ ] **Step 2: Run the component test and confirm failure**

Run: `npm test -- tests/components/ProcessingView.spec.ts`

Expected: FAIL.

- [ ] **Step 3: Implement focused presentation components**

- `ProgressSummary.vue`: progress bar, completed/total, elapsed, ETA, last response, success/retry/failure counters, and safe-stop action.
- `StageTimeline.vue`: the eight states from the spec, with only completed/current/pending visual states.
- `AiLogPanel.vue`: most recent 200 projected events, auto-scroll toggle, copy button, and no arbitrary HTML rendering.
- `PaperPreview.vue`: PDF canvas or accepted text preview only; it never synthesizes diagram contents.

- [ ] **Step 4: Connect processing to the coordinator**

On route load, `ProcessingView.vue` loads the project and snapshot, resumes cached translation, and starts only the first incomplete stage. The view stores the running promise, calls `store.safeStop()` from the button, and registers a `beforeRouteLeave` confirmation only while status is `running` or `stopping`.

- [ ] **Step 5: Run component and coordinator tests**

Run: `npm test -- tests/components/ProcessingView.spec.ts tests/unit/coordinator.spec.ts tests/unit/taskStore.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit the processing dashboard**

```bash
git add src/components/processing src/views/ProcessingView.vue tests/components/ProcessingView.spec.ts
git commit -m "feat: show recoverable translation progress and AI logs"
```

---

### Task 10: Complete the phase-one workflow and regression gate

**Files:**
- Modify: `src/views/ReaderTaskView.vue`
- Create: `src/core/task/completion.ts`
- Create: `tests/integration/translation-workflow.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: task snapshot, translation validation summary, and router.
- Produces: `canEnterReader(summary): boolean`, automatic navigation, preserved back navigation, and a phase-one reader placeholder.

- [ ] **Step 1: Write the completion-gate integration test**

```ts
import { describe, expect, it } from 'vitest';
import { canEnterReader } from '../../src/core/task/completion';

describe('phase-one completion gate', () => {
  it('requires all mandatory translation checks', () => {
    expect(canEnterReader({
      requiredBlocks: 100,
      validatedBlocks: 100,
      failedBlocks: 0,
      protectedContentPass: true,
      pdfCompiled: false,
      assetsPass: false,
      alignmentBuilt: false,
      persisted: true,
    })).toBe(false);
  });

  it('passes only the complete summary', () => {
    expect(canEnterReader({
      requiredBlocks: 100,
      validatedBlocks: 100,
      failedBlocks: 0,
      protectedContentPass: true,
      pdfCompiled: true,
      assetsPass: true,
      alignmentBuilt: true,
      persisted: true,
    })).toBe(true);
  });
});
```

- [ ] **Step 2: Implement the pure completion predicate**

Return true only when counts are equal, failures are zero, and all five booleans are true. This deliberately remains false during phase one because PDF compilation and alignment are delivered by later plans.

- [ ] **Step 3: Implement reader-placeholder navigation semantics**

`ReaderTaskView.vue` loads the project ID, shows `返回翻译任务`, `重新选择文件`, and a confirmed `清除翻译缓存` action. It must not claim to render the final PDF yet; display `排版与阅读器将在下一实施阶段接入` when `canEnterReader` is false. The processing view watches for a future true completion summary and calls `router.replace({ name: 'reader', params: { projectId } })` exactly once.

- [ ] **Step 4: Document phase-one behavior**

Update README setup instructions, current DeepSeek model names, local-only cache behavior, and explicitly state that `deepseek-chat` is unsupported.

- [ ] **Step 5: Run the full phase-one gate**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Expected: all existing and new tests pass; the production bundle contains upload/process/read routes; no application view links to P19.

- [ ] **Step 6: Commit phase one**

```bash
git add src/core/task/completion.ts src/views/ReaderTaskView.vue tests/integration/translation-workflow.spec.ts README.md
git commit -m "feat: complete browser translation workflow foundation"
```

## Phase-One Review Checklist

- The app has no active route to the old setup/workbench/reader demo views.
- Model discovery and request bodies use only V4 IDs.
- A paper-specific term appears only in dynamic context or glossary tests, never in the fixed prompt.
- Active requests abort on safe stop; validated cache survives.
- AI logs contain no API key, authorization header, or hidden reasoning.
- The UI cannot display completion before later PDF and alignment gates are true.
