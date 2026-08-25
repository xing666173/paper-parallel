export interface PdfPageForVision {
  getViewport(input: { scale: number }): { width: number; height: number };
  render(input: { canvasContext: unknown; viewport: unknown; background?: string }): { promise: Promise<unknown> };
}

export interface VisionCanvas {
  width: number;
  height: number;
  getContext(type: '2d'): {
    fillStyle: string;
    fillRect(x: number, y: number, width: number, height: number): void;
  } | null;
  toDataURL(type: 'image/png'): string;
}

export interface RenderPdfPageOptions {
  scale?: number;
  createCanvas?: () => VisionCanvas;
}

function browserCanvas(): VisionCanvas {
  return document.createElement('canvas') as VisionCanvas;
}

export async function renderPdfPageAsPng(
  page: PdfPageForVision,
  options: RenderPdfPageOptions = {},
): Promise<string> {
  const scale = options.scale ?? 2;
  const viewport = page.getViewport({ scale });
  const canvas = (options.createCanvas ?? browserCanvas)();
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法创建页面图像画布');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport, background: '#ffffff' }).promise;
  return canvas.toDataURL('image/png');
}
