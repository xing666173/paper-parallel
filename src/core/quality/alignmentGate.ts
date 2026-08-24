import type { AlignmentManifest } from '../align/manifest';

export type AlignmentGateIssueCode = 'unit-unmatched' | 'unit-low-confidence' | 'paragraph-fallback';

export interface AlignmentGateIssue {
  code: AlignmentGateIssueCode;
  unitId: string;
  severity: 'error' | 'warn';
  message: string;
}

export interface AlignmentGateResult {
  pass: boolean;
  verified: boolean;
  issues: AlignmentGateIssue[];
}

export function runAlignmentGate(manifest: AlignmentManifest): AlignmentGateResult {
  const issues: AlignmentGateIssue[] = [];
  for (const unit of manifest.units) {
    if (unit.status === 'unmatched') {
      issues.push({
        code: 'unit-unmatched', unitId: unit.id, severity: 'error',
        message: `未能定位对齐单元 ${unit.id}`,
      });
    } else if (unit.status === 'low-confidence') {
      issues.push({
        code: 'unit-low-confidence', unitId: unit.id, severity: 'warn',
        message: `对齐单元 ${unit.id} 的几何匹配置信度偏低`,
      });
    }
    if (unit.relation === 'paragraph-fallback') {
      issues.push({
        code: 'paragraph-fallback', unitId: unit.id, severity: 'warn',
        message: `对齐单元 ${unit.id} 已降级为段落级`,
      });
    }
  }
  issues.sort((left, right) => left.unitId.localeCompare(right.unitId) || left.code.localeCompare(right.code));
  return {
    pass: !issues.some((issue) => issue.severity === 'error'),
    verified: issues.length === 0,
    issues,
  };
}
