import type { LayoutRepairAction } from '../typst/project';
import type { VisionFinalIssue } from '../vision/finalReview';

export interface QualityAttemptReport {
  attempt: 0 | 1 | 2;
  pass: boolean;
  reviewedPages: number;
  issues: VisionFinalIssue[];
  actions: LayoutRepairAction[];
}

export interface QualityReport {
  schemaVersion: 1;
  projectId: string;
  layoutProfileVersion: string;
  pass: boolean;
  createdAt: number;
  attempts: QualityAttemptReport[];
}
