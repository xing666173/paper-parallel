import type { PdfContentGateResult } from './pdfContentGate';

export interface PersistValidatedOutputsOptions<TArtifact extends { key: string }, TManifest> {
  contentGate: PdfContentGateResult;
  alignmentPass: boolean;
  alignmentError: string;
  visualPass: boolean;
  visualError: string;
  artifacts: readonly TArtifact[];
  manifest: TManifest;
  commit(artifacts: readonly TArtifact[], manifest: TManifest): Promise<unknown>;
}

export async function persistValidatedOutputs<TArtifact extends { key: string }, TManifest>(
  options: PersistValidatedOutputsOptions<TArtifact, TManifest>,
): Promise<void> {
  if (!options.contentGate.pass) {
    throw new Error(`PDF 内容质量门未通过：${options.contentGate.issues.map((issue) => issue.message).join('；')}`);
  }
  if (!options.alignmentPass) {
    throw new Error(options.alignmentError || '对齐质量门未通过');
  }
  if (!options.visualPass) {
    throw new Error(`视觉质检未通过：${options.visualError || 'Vision Exp 发现严重页面缺陷'}`);
  }
  await options.commit(options.artifacts, options.manifest);
}
