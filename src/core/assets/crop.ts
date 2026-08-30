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
  eraseRects: readonly Rect[] = [],
  preserveRects: readonly Rect[] = [],
): Promise<Blob> {
  const viewport = page.getViewport({ scale });
  const source = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvasContext: context2d(source), viewport }).promise;

  const target = createCanvas(Math.max(1, Math.ceil(rect.w * scale)), Math.max(1, Math.ceil(rect.h * scale)));
  const targetContext = context2d(target);
  const cropWidth = Math.ceil(rect.w * scale);
  const cropHeight = Math.ceil(rect.h * scale);
  if (preserveRects.length) {
    targetContext.fillStyle = '#ffffff';
    targetContext.fillRect(0, 0, cropWidth, cropHeight);
    for (const preserve of preserveRects) {
      const left = Math.max(rect.x, preserve.x);
      const top = Math.max(rect.y, preserve.y);
      const right = Math.min(rect.x + rect.w, preserve.x + preserve.w);
      const bottom = Math.min(rect.y + rect.h, preserve.y + preserve.h);
      if (right <= left || bottom <= top) continue;
      const sourceX = Math.floor(left * scale);
      const sourceY = Math.floor(top * scale);
      const sourceRight = Math.ceil(right * scale);
      const sourceBottom = Math.ceil(bottom * scale);
      const width = sourceRight - sourceX;
      const height = sourceBottom - sourceY;
      targetContext.drawImage(
        source,
        sourceX,
        sourceY,
        width,
        height,
        sourceX - Math.floor(rect.x * scale),
        sourceY - Math.floor(rect.y * scale),
        width,
        height,
      );
    }
  } else {
    targetContext.drawImage(
      source,
      Math.floor(rect.x * scale),
      Math.floor(rect.y * scale),
      cropWidth,
      cropHeight,
      0,
      0,
      cropWidth,
      cropHeight,
    );
  }
  if (eraseRects.length && !preserveRects.length) {
    targetContext.save();
    targetContext.fillStyle = '#ffffff';
    for (const erase of eraseRects) {
      const left = Math.max(rect.x, erase.x);
      const top = Math.max(rect.y, erase.y);
      const right = Math.min(rect.x + rect.w, erase.x + erase.w);
      const bottom = Math.min(rect.y + rect.h, erase.y + erase.h);
      if (right <= left || bottom <= top) continue;
      targetContext.fillRect(
        Math.floor((left - rect.x) * scale),
        Math.floor((top - rect.y) * scale),
        Math.ceil((right - left) * scale),
        Math.ceil((bottom - top) * scale),
      );
    }
    targetContext.restore();
  }
  return exportPng(target);
}
