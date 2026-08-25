import type { PdfContentGateResult } from './pdfContentGate';

export interface PersistValidatedOutputsOptions<TArtifact extends { key: string }, TManifest> {
  contentGate: PdfContentGateResult;
  alignmentPass: boolean;
  alignmentError: string;
  artifacts: readonly TArtifact[];
  manifest: TManifest;
  putArtifact(artifact: TArtifact): Promise<unknown>;
  saveAlignmentManifest(manifest: TManifest): Promise<unknown>;
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
  for (const artifact of options.artifacts) await options.putArtifact(artifact);
  await options.saveAlignmentManifest(options.manifest);
}
