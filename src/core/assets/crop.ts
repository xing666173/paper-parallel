import type { Rect } from '../../types/models';

interface PdfViewportLike { width: number; height: number }
interface PdfRenderTaskLike { promise: Promise<unknown> }
export interface RenderablePdfPage {
  getViewport(options: { scale: number }): PdfViewportLike;
  render(options: { canvasContext: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D; viewport: PdfViewportLike }): PdfRenderTaskLike;
}

type CanvasTarget = HTMLCanvasElement | OffscreenCanvas;

function createCanvas(width: number, height: number): CanvasTarget {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error('Canvas is unavailable in this browser');
}

function context2d(canvas: CanvasTarget): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to create a 2D canvas context');
  return context as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}

function exportPng(canvas: CanvasTarget): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: 'image/png' });
  }
  const htmlCanvas = canvas as HTMLCanvasElement;
  return new Promise((resolve, reject) => {
    htmlCanvas.toBlob((blob: Blob | null) => {
      if (blob) resolve(blob);
      else reject(new Error('Unable to encode immutable PNG asset'));
    }, 'image/png');
  });
}

export async function cropPageRegionLossless(
  page: RenderablePdfPage,
  rect: Rect,
  scale = 4,
): Promise<Blob> {
  const viewport = page.getViewport({ scale });
  const source = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvasContext: context2d(source), viewport }).promise;

  const target = createCanvas(Math.max(1, Math.ceil(rect.w * scale)), Math.max(1, Math.ceil(rect.h * scale)));
  const targetContext = context2d(target);
  targetContext.drawImage(
    source,
    Math.floor(rect.x * scale),
    Math.floor(rect.y * scale),
    Math.ceil(rect.w * scale),
    Math.ceil(rect.h * scale),
    0,
    0,
    Math.ceil(rect.w * scale),
    Math.ceil(rect.h * scale),
  );
  return exportPng(target);
}
