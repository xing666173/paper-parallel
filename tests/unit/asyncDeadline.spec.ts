import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitWithDeadline } from '../../src/core/task/asyncDeadline';

afterEach(() => vi.useRealTimers());

describe('third-party asynchronous operation boundaries', () => {
  it('rejects immediately on abort even when the operation and cancellation ignore it', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const result = awaitWithDeadline(new Promise(() => {}), { signal: controller.signal, onCancel: cancel });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('times out a pending operation and consumes its later rejection', async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const pending = new Promise((_resolve, no) => { reject = no; });
    const result = awaitWithDeadline(pending, { timeoutMs: 30, timeoutMessage: 'render timed out' });
    const rejection = expect(result).rejects.toMatchObject({ name: 'AsyncOperationTimeoutError', message: 'render timed out' });
    await vi.advanceTimersByTimeAsync(31);
    await rejection;
    reject(new Error('late rejection'));
    await Promise.resolve();
  });

  it('does not convert an undefined rejection into success', async () => {
    await expect(awaitWithDeadline(Promise.reject(undefined))).rejects.toBeUndefined();
  });

  it('exits a real PDF.js getOperatorList when document destruction leaves its promise pending', async () => {
    const { getDocument } = await import('pdfjs-dist');
    const data = new Uint8Array(await readFile(new URL('../fixtures/mixed-layout-paper.pdf', import.meta.url)));
    const loading = getDocument({ data });
    const pdf = await loading.promise;
    const page = await pdf.getPage(1);
    const controller = new AbortController();
    const pending = awaitWithDeadline(page.getOperatorList(), { signal: controller.signal, timeoutMs: 5_000 });
    const destruction = loading.destroy();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await awaitWithDeadline(destruction, { timeoutMs: 5_000 });
  });
});
