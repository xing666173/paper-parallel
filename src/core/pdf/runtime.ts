import { GlobalWorkerOptions, getDocument, OPS } from 'pdfjs-dist';

GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export { getDocument, OPS };
export type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
