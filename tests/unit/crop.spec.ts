import { afterEach, describe, expect, it, vi } from 'vitest';
import { cropPageRegionLossless, type RenderablePdfPage } from '../../src/core/assets/crop';
import { extractImmutableAssets } from '../../src/core/assets/extract';

class FakeCanvas {
  static all: FakeCanvas[] = [];
  initialWidth: number;
  initialHeight: number;
  context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn(), save: vi.fn(), restore: vi.fn() };
  constructor(public width: number, public height: number) {
    this.initialWidth = width;
    this.initialHeight = height;
    FakeCanvas.all.push(this);
  }
  getContext() { return this.context; }
  convertToBlob() { return Promise.resolve(new Blob(['pixels'], { type: 'image/png' })); }
}
function canvasEnvironment() {
  FakeCanvas.all = [];
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
}
function pageWithRender(render = vi.fn(() => ({ promise: Promise.resolve() }))) {
  return {
    getViewport: ({ scale }: { scale: number }) => ({ width: 3000 * scale, height: 3000 * scale }),
    render,
  } as unknown as RenderablePdfPage;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('bounded region rendering', () => {
  it('renders only a tiny crop of a large page and releases its bitmap', async () => {
    canvasEnvironment();
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    await cropPageRegionLossless(pageWithRender(render), { x: 100, y: 200, w: 10, h: 10 }, 6);
    expect(FakeCanvas.all).toHaveLength(1);
    expect(FakeCanvas.all[0]).toMatchObject({ initialWidth: 60, initialHeight: 60, width: 0, height: 0 });
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ transform: [1, 0, 0, 1, -600, -1200] }));
  });

  it('reduces scale to satisfy both pixel count and dimension budgets', async () => {
    canvasEnvironment();
    await cropPageRegionLossless(pageWithRender(), { x: 0, y: 0, w: 3000, h: 1000 }, 6, [], [], {
      maxPixels: 500_000, maxDimension: 1000,
    });
    const canvas = FakeCanvas.all[0]!;
    expect(canvas.initialWidth).toBeLessThanOrEqual(1000);
    expect(canvas.initialWidth * canvas.initialHeight).toBeLessThanOrEqual(500_000);
    expect(canvas.width).toBe(0);
  });

  it('retains fractional boundary pixels and uses the same origin for erase masks', async () => {
    canvasEnvironment();
    await cropPageRegionLossless(pageWithRender(), { x: 100.75, y: 200.75, w: 10, h: 10 }, 2, [
      { x: 101, y: 201, w: 1.25, h: 1.25 },
    ]);
    expect(FakeCanvas.all[0]).toMatchObject({ initialWidth: 21, initialHeight: 21 });
    expect(FakeCanvas.all[0]!.context.fillRect).toHaveBeenCalledWith(1, 1, 3, 3);
  });

  it('keeps masked rectangles in crop-local pixel coordinates and clears both canvases', async () => {
    canvasEnvironment();
    await cropPageRegionLossless(pageWithRender(), { x: 100, y: 200, w: 30, h: 20 }, 2, [], [
      { x: 105, y: 202, w: 5, h: 3 },
    ]);
    expect(FakeCanvas.all).toHaveLength(2);
    expect(FakeCanvas.all[1]!.context.drawImage).toHaveBeenCalledWith(FakeCanvas.all[0], 10, 4, 10, 6, 10, 4, 10, 6);
    expect(FakeCanvas.all.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
  });

  it.each(['abort', 'timeout'] as const)('cancels a non-settling render on %s and releases the canvas', async (mode) => {
    canvasEnvironment();
    vi.useFakeTimers();
    const controller = new AbortController();
    const cancel = vi.fn();
    const page = pageWithRender(vi.fn(() => ({ promise: new Promise<void>(() => {}), cancel })));
    const result = cropPageRegionLossless(page, { x: 0, y: 0, w: 10, h: 10 }, 4, [], [], {
      signal: controller.signal, timeoutMs: 30,
    });
    const rejection = expect(result).rejects.toMatchObject({ name: mode === 'abort' ? 'AbortError' : 'AsyncOperationTimeoutError' });
    if (mode === 'abort') controller.abort();
    else await vi.advanceTimersByTimeAsync(31);
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
    expect(FakeCanvas.all.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
  });

  it('also bounds a stalled PNG encoder', async () => {
    canvasEnvironment();
    vi.useFakeTimers();
    vi.spyOn(FakeCanvas.prototype, 'convertToBlob').mockImplementation(() => new Promise(() => {}));
    const result = cropPageRegionLossless(pageWithRender(), { x: 0, y: 0, w: 10, h: 10 }, 4, [], [], { timeoutMs: 20 });
    const rejection = expect(result).rejects.toMatchObject({ name: 'AsyncOperationTimeoutError' });
    await vi.advanceTimersByTimeAsync(21);
    await rejection;
    expect(FakeCanvas.all[0]!.width).toBe(0);
  });

  it('stops sibling workers on the first asset failure even if a crop ignores cancellation', async () => {
    const failure = new Error('first crop failed');
    const signals: AbortSignal[] = [];
    const crop = vi.fn(async (region: { id: string }, signal: AbortSignal) => {
      signals.push(signal);
      if (region.id === '0') throw failure;
      return await new Promise<Blob>(() => {});
    });
    const regions = Array.from({ length: 20 }, (_, index) => ({
      id: String(index), kind: 'figure' as const, pageIndex: 0,
      rect: { x: 0, y: 0, w: 10, h: 10 }, widthMode: 'column' as const,
    }));
    await expect(extractImmutableAssets(regions, { crop, concurrency: 2 })).rejects.toBe(failure);
    expect(crop).toHaveBeenCalledTimes(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});
