import { describe, expect, it, vi } from 'vitest';
import { renderPdfPageAsPng } from '../../src/core/vision/render';

describe('vision: PDF page rendering', () => {
  it('renders a white high-resolution PNG without depending on DOM globals in the core', async () => {
    const context = { fillStyle: '', fillRect: vi.fn() };
    const canvas = {
      width: 0, height: 0,
      getContext: vi.fn(() => context),
      toDataURL: vi.fn(() => 'data:image/png;base64,PAGE'),
    };
    const render = vi.fn(() => ({ promise: Promise.resolve() }));
    const page = {
      getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale })),
      render,
    };

    await expect(renderPdfPageAsPng(page, {
      scale: 2,
      createCanvas: () => canvas,
    })).resolves.toBe('data:image/png;base64,PAGE');

    expect(canvas).toMatchObject({ width: 1224, height: 1584 });
    expect(context.fillStyle).toBe('#ffffff');
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 1224, 1584);
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ canvasContext: context }));
  });
});
