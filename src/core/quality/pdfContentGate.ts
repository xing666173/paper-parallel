import { getDocument } from '../pdf/runtime';

export type PdfContentIssueCode =
  | 'blank-page'
  | 'chinese-text-missing'
  | 'page-count-excessive'
  | 'pdf-empty'
  | 'translation-coverage-low';

export interface PdfContentIssue {
  code: PdfContentIssueCode;
  message: string;
}

export interface PdfContentGateInput {
  pageTexts: readonly string[];
  pageDrawableCounts?: readonly number[];
  expectedTranslations: readonly string[];
  maximumPages: number;
  minimumCoverage?: number;
}

export interface PdfContentGateResult {
  pass: boolean;
  coverage: number;
  chineseCharacters: number;
  issues: PdfContentIssue[];
}

function compact(value: string): string {
  return value.normalize('NFKC').replace(/[\s\u200b-\u200d\ufeff]+/g, '');
}

export function runPdfContentGate(input: PdfContentGateInput): PdfContentGateResult {
  const issues: PdfContentIssue[] = [];
  const allText = compact(input.pageTexts.join('\n'));
  const chineseCharacters = [...allText.matchAll(/\p{Script=Han}/gu)].length;
  const expected = input.expectedTranslations.map(compact).filter((text) => text.length >= 4);
  const hits = expected.filter((text) => allText.includes(text)).length;
  const coverage = expected.length ? hits / expected.length : 1;

  if (!input.pageTexts.length) {
    issues.push({ code: 'pdf-empty', message: '中文 PDF 没有页面' });
  }
  const blankPages = input.pageTexts.flatMap((text, pageIndex) => (
    compact(text).length === 0 && (input.pageDrawableCounts?.[pageIndex] ?? 0) === 0 ? [pageIndex + 1] : []
  ));
  if (blankPages.length) {
    issues.push({ code: 'blank-page', message: `中文 PDF 存在空白页：${blankPages.join(', ')}` });
  }
  if (input.pageTexts.length > input.maximumPages) {
    issues.push({
      code: 'page-count-excessive',
      message: `中文 PDF 页数异常：${input.pageTexts.length} 页，安全上限 ${input.maximumPages} 页`,
    });
  }
  if (expected.length && chineseCharacters < Math.max(4, Math.floor(expected.join('').match(/\p{Script=Han}/gu)?.length ?? 0) * 0.25)) {
    issues.push({ code: 'chinese-text-missing', message: '中文 PDF 的可提取中文正文不足' });
  }
  if (coverage < (input.minimumCoverage ?? 0.85)) {
    issues.push({
      code: 'translation-coverage-low',
      message: `中文 PDF 仅找到 ${hits}/${expected.length} 个已校验译文块`,
    });
  }

  const order: PdfContentIssueCode[] = [
    'pdf-empty', 'blank-page', 'page-count-excessive', 'chinese-text-missing', 'translation-coverage-low',
  ];
  issues.sort((left, right) => order.indexOf(left.code) - order.indexOf(right.code));
  return { pass: issues.length === 0, coverage, chineseCharacters, issues };
}

export interface CompiledPdfInspection {
  pageTexts: string[];
  pageDrawableCounts: number[];
}

export async function inspectCompiledPdf(pdfBytes: Uint8Array): Promise<CompiledPdfInspection> {
  const loading = getDocument({ data: pdfBytes.slice() });
  const pdf = await loading.promise;
  const pageTexts: string[] = [];
  const pageDrawableCounts: number[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pageTexts.push(content.items
        .filter((item: any) => typeof item?.str === 'string')
        .map((item: any) => item.str)
        .join(' '));
      const operators = await page.getOperatorList();
      pageDrawableCounts.push(operators.fnArray.length);
    }
    return { pageTexts, pageDrawableCounts };
  } finally {
    await pdf.destroy();
  }
}
