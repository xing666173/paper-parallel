import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export async function extractPdfText(pdfBytes: Uint8Array): Promise<string> {
  const loading = getDocument({ data: pdfBytes.slice() });
  const pdf = await loading.promise;
  try {
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items
        .filter((item): item is typeof item & { str: string } => 'str' in item && typeof item.str === 'string')
        .map((item) => item.str)
        .join(' '));
    }
    return pages.join('\n');
  } finally {
    await pdf.destroy();
  }
}

export async function assertPdfContainsText(pdfBytes: Uint8Array, expected: string): Promise<void> {
  const text = await extractPdfText(pdfBytes);
  if (!text.includes(expected)) {
    throw new Error(`Downloaded PDF is missing expected text: ${expected}. Extracted: ${text.slice(0, 200)}`);
  }
}

export async function assertPdfHasDrawableContent(pdfBytes: Uint8Array): Promise<void> {
  const loading = getDocument({ data: pdfBytes.slice() });
  const pdf = await loading.promise;
  try {
    const page = await pdf.getPage(1);
    const operators = await page.getOperatorList();
    if (operators.fnArray.length === 0) throw new Error('Downloaded PDF first page has no drawing operators');
  } finally {
    await pdf.destroy();
  }
}
