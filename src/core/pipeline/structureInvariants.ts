import type { LayoutRegion, SemanticUnit } from '../../types/models';
import type { DetectedAssetRegion } from '../assets/extract';

export type StructureInvariantStage = 'pre-translation' | 'pre-typst';

export interface StructureInvariantIssue {
  stage: StructureInvariantStage;
  code:
    | 'local-structural.duplicate-unit-id'
    | 'local-structural.duplicate-region-id'
    | 'local-structural.duplicate-asset-id'
    | 'local-structural.unknown-unit-reference'
    | 'local-structural.duplicate-region-reference'
    | 'local-structural.multiple-region-owners'
    | 'local-structural.missing-region-owner'
    | 'local-structural.region-owner-mismatch'
    | 'local-structural.missing-asset-record'
    | 'local-structural.missing-asset-unit'
    | 'local-structural.missing-caption-unit'
    | 'local-structural.marker-namespace-collision';
  severity: 'error';
  entityType: 'unit' | 'region' | 'asset' | 'caption' | 'marker-namespace';
  entityId: string;
  firstSource?: string;
  conflictSource?: string;
  message: string;
  fingerprint: string;
}

export interface ValidatePreparedStructureInput {
  stage: StructureInvariantStage;
  regions: readonly LayoutRegion[];
  units: readonly SemanticUnit[];
  assets: readonly DetectedAssetRegion[];
}

function issue(
  value: Omit<StructureInvariantIssue, 'severity' | 'fingerprint'>,
): StructureInvariantIssue {
  return {
    ...value,
    severity: 'error',
    fingerprint: [
      value.stage,
      value.code,
      value.entityType,
      value.entityId,
      value.firstSource ?? '',
      value.conflictSource ?? '',
    ].join('|').toLocaleLowerCase(),
  };
}

function duplicateIndices<T>(items: readonly T[], identity: (item: T) => string): Map<string, number[]> {
  const indices = new Map<string, number[]>();
  items.forEach((item, index) => {
    const id = identity(item);
    const values = indices.get(id) ?? [];
    values.push(index);
    indices.set(id, values);
  });
  return new Map([...indices].filter(([, values]) => values.length > 1));
}

/** Read-only gate for prepared structure ownership and marker namespaces. */
export function validatePreparedStructure(
  input: ValidatePreparedStructureInput,
): StructureInvariantIssue[] {
  const issues: StructureInvariantIssue[] = [];
  for (const [id, indices] of duplicateIndices(input.units, (unit) => unit.id)) {
    issues.push(issue({
      stage: input.stage, code: 'local-structural.duplicate-unit-id', entityType: 'unit', entityId: id,
      firstSource: `units[${indices[0]}]`, conflictSource: `units[${indices[1]}]`,
      message: `语义单元 ID 重复：${id}`,
    }));
  }
  for (const [id, indices] of duplicateIndices(input.regions, (region) => region.id)) {
    issues.push(issue({
      stage: input.stage, code: 'local-structural.duplicate-region-id', entityType: 'region', entityId: id,
      firstSource: `regions[${indices[0]}]`, conflictSource: `regions[${indices[1]}]`,
      message: `版式区域 ID 重复：${id}`,
    }));
  }
  for (const [id, indices] of duplicateIndices(input.assets, (asset) => asset.id)) {
    issues.push(issue({
      stage: input.stage, code: 'local-structural.duplicate-asset-id', entityType: 'asset', entityId: id,
      firstSource: `assets[${indices[0]}]`, conflictSource: `assets[${indices[1]}]`,
      message: `不可变资产 ID 重复：${id}`,
    }));
  }

  const units = new Map(input.units.map((unit) => [unit.id, unit]));
  const regions = new Map(input.regions.map((region) => [region.id, region]));
  const assets = new Map(input.assets.map((asset) => [asset.id, asset]));
  const ownership = new Map<string, string[]>();
  for (const region of input.regions) {
    const local = new Set<string>();
    region.orderedUnitIds.forEach((unitId, index) => {
      if (!units.has(unitId)) {
        issues.push(issue({
          stage: input.stage, code: 'local-structural.unknown-unit-reference', entityType: 'unit',
          entityId: unitId, conflictSource: `${region.id}.orderedUnitIds[${index}]`,
          message: `版式区域 ${region.id} 引用不存在的语义单元 ${unitId}`,
        }));
        return;
      }
      if (local.has(unitId)) {
        issues.push(issue({
          stage: input.stage, code: 'local-structural.duplicate-region-reference', entityType: 'unit',
          entityId: unitId, firstSource: region.id, conflictSource: `${region.id}.orderedUnitIds[${index}]`,
          message: `语义单元 ${unitId} 在区域 ${region.id} 内重复出现`,
        }));
      }
      local.add(unitId);
      const owners = ownership.get(unitId) ?? [];
      owners.push(region.id);
      ownership.set(unitId, owners);
    });
  }
  for (const unit of input.units) {
    const owners = [...new Set(ownership.get(unit.id) ?? [])];
    if (!regions.has(unit.layoutRegionId)) {
      issues.push(issue({
        stage: input.stage, code: 'local-structural.missing-region-owner', entityType: 'region',
        entityId: unit.layoutRegionId, conflictSource: unit.id,
        message: `语义单元 ${unit.id} 指向不存在的区域 ${unit.layoutRegionId}`,
      }));
    }
    if (owners.length === 0) {
      issues.push(issue({
        stage: input.stage, code: 'local-structural.missing-region-owner', entityType: 'unit',
        entityId: unit.id, conflictSource: unit.layoutRegionId,
        message: `语义单元 ${unit.id} 没有被任何版式区域引用`,
      }));
    } else if (owners.length > 1) {
      issues.push(issue({
        stage: input.stage, code: 'local-structural.multiple-region-owners', entityType: 'unit',
        entityId: unit.id, firstSource: owners[0], conflictSource: owners[1],
        message: `语义单元 ${unit.id} 同时属于多个版式区域`,
      }));
    } else if (owners[0] !== unit.layoutRegionId) {
      issues.push(issue({
        stage: input.stage, code: 'local-structural.region-owner-mismatch', entityType: 'unit',
        entityId: unit.id, firstSource: unit.layoutRegionId, conflictSource: owners[0],
        message: `语义单元 ${unit.id} 的 layoutRegionId 与实际归属不一致`,
      }));
    }
    if (unit.assetId && !assets.has(unit.assetId)) {
      issues.push(issue({
        stage: input.stage, code: 'local-structural.missing-asset-record', entityType: 'asset',
        entityId: unit.assetId, conflictSource: unit.id,
        message: `资产语义单元 ${unit.id} 引用不存在的资产 ${unit.assetId}`,
      }));
    }
  }
  for (const asset of input.assets) {
    if (!input.units.some((unit) => unit.assetId === asset.id)) {
      issues.push(issue({
        stage: input.stage, code: 'local-structural.missing-asset-unit', entityType: 'asset',
        entityId: asset.id, message: `不可变资产 ${asset.id} 没有对应语义单元`,
      }));
    }
    if (asset.captionUnitId && !units.has(asset.captionUnitId)) {
      issues.push(issue({
        stage: input.stage, code: 'local-structural.missing-caption-unit', entityType: 'caption',
        entityId: asset.captionUnitId, conflictSource: asset.id,
        message: `不可变资产 ${asset.id} 引用不存在的标题单元 ${asset.captionUnitId}`,
      }));
    }
  }

  const namespaces = new Map<string, string>();
  for (const unit of input.units.filter((candidate) => Boolean(candidate.sourceText))) {
    const namespace = `${encodeURIComponent(unit.id)}-g-`;
    const previous = namespaces.get(namespace);
    if (previous) {
      issues.push(issue({
        stage: input.stage, code: 'local-structural.marker-namespace-collision',
        entityType: 'marker-namespace', entityId: namespace,
        firstSource: previous, conflictSource: unit.id,
        message: `翻译标记命名空间发生冲突：${namespace}`,
      }));
    } else {
      namespaces.set(namespace, unit.id);
    }
  }
  return issues.sort((left, right) => (
    left.code.localeCompare(right.code) || left.entityId.localeCompare(right.entityId)
  ));
}

export class StructureInvariantError extends Error {
  readonly issues: StructureInvariantIssue[];

  constructor(issues: readonly StructureInvariantIssue[]) {
    super(`结构门禁未通过：${issues.map((item) => `${item.code}(${item.entityId})`).join('；')}`);
    this.name = 'StructureInvariantError';
    this.issues = [...issues];
  }
}

export function assertPreparedStructure(input: ValidatePreparedStructureInput): void {
  const issues = validatePreparedStructure(input);
  if (issues.length) throw new StructureInvariantError(issues);
}
