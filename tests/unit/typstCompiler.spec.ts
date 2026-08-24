import { describe, expect, it } from 'vitest';
import { compileTypstProject } from '../../src/core/typst/compiler';
import type { TypstWorkerRequest, TypstWorkerResponse } from '../../src/core/typst/messages';
import type { TypstProject } from '../../src/core/typst/project';

const project: TypstProject = {
  mainContent: 'Hello',
  files: new Map([['/main.typ', new TextEncoder().encode('Hello')]]),
  markerIds: ['title'],
  regionIds: ['front'],
};
const runtimePaths = { compilerWasm: './compiler.wasm', rendererWasm: './renderer.wasm' };

class FakeTypstWorker {
  onmessage: ((event: MessageEvent<TypstWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  request?: TypstWorkerRequest;

  constructor(private neverComplete = false) {}

  postMessage(request: TypstWorkerRequest): void {
    this.request = request;
    if (this.neverComplete) return;
    queueMicrotask(() => this.onmessage?.({ data: {
      type: 'done', requestId: request.requestId,
      pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46]), svg: '<svg></svg>',
    } } as MessageEvent<TypstWorkerResponse>));
  }

  terminate(): void { this.terminated = true; }
}

describe('Typst compiler worker host', () => {
  it('maps project files, returns PDF/SVG, and terminates after completion', async () => {
    const worker = new FakeTypstWorker();
    const result = await compileTypstProject(project, {
      workerFactory: () => worker as unknown as Worker,
      runtimePaths,
    });
    expect(result.pdf.slice(0, 4)).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    expect(result.svg).toContain('<svg');
    expect(worker.request?.files[0]).toMatchObject({ path: '/main.typ' });
    expect(worker.terminated).toBe(true);
  });

  it('terminates the worker on abort', async () => {
    const worker = new FakeTypstWorker(true);
    const controller = new AbortController();
    const promise = compileTypstProject(project, {
      workerFactory: () => worker as unknown as Worker,
      runtimePaths,
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(true);
  });
});
