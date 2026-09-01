import type { MarkerInvariantIssue } from '../pipeline/markerInvariants';
import type { StructureInvariantIssue } from '../pipeline/structureInvariants';

export interface StructureDiagnosticReport {
  schemaVersion: 1;
  projectId: string;
  createdAt: number;
  errorName: 'StructureInvariantError' | 'MarkerInvariantError';
  issues: Array<StructureInvariantIssue | MarkerInvariantIssue>;
}
