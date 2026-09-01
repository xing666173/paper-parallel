import type { LayoutRepairAction } from '../typst/project';
import type { VisionFinalIssue } from '../vision/finalReview';
import type { CrossPageAssetGroup } from '../vision/crossPageRelations';

export interface QualityAttemptReport {
  attempt: 0 | 1 | 2;
  pass: boolean;
  reviewedPages: number;
  issues: VisionFinalIssue[];
  actions: LayoutRepairAction[];
}

export interface SourceLayoutCorrectionAttempt {
  pageIndex: number;
  round: 1 | 2;
  basePlanVersion: string;
  patchId?: string;
  errorFingerprints: string[];
  outcome: 'patched' | 'accepted' | 'rejected' | 'request-failed';
  networkAttempts: number;
  promptTokens: number;
  completionTokens: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface SourceLayoutQualityReport {
  schemaVersion: 1;
  pass: boolean;
  pagePlans: Array<{
    pageIndex: number;
    planVersion: string;
    planDigest: string;
    origin: 'initial' | 'correction-1' | 'correction-2';
    recoveryActions: Array<{ type: string; regionId: string; reason: string }>;
  }>;
  correctionAttempts: SourceLayoutCorrectionAttempt[];
  initialAnalysisCalls: number;
  initialPromptTokens: number;
  initialCompletionTokens: number;
  correctionCallsUsed: number;
  maxCorrectionCalls: number;
  promptTokens: number;
  completionTokens: number;
  unresolvedIssues: Array<{
    pageIndex: number;
    regionId?: string;
    code: string;
    reason: string;
    fingerprint: string;
  }>;
  crossPageAssetGroups: CrossPageAssetGroup[];
}

export interface QualityReport {
  schemaVersion: 1 | 2;
  projectId: string;
  layoutProfileVersion: string;
  pass: boolean;
  createdAt: number;
  attempts: QualityAttemptReport[];
  /** Absent only on legacy reports created before source-plan provenance existed. */
  sourceLayout?: SourceLayoutQualityReport;
}
