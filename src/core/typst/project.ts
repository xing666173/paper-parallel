import type { ImmutableAsset } from '../assets/types';
import { verifyAssetHash } from '../assets/hash';
import type { LayoutRegion, SemanticUnitKind } from '../../types/models';
import { escapeTypstString, escapeTypstText } from './escape';
import { buildAcademicTemplate, type AcademicTemplateOptions } from './template';

export interface TypstTargetSegment {
  id: string;
  text: string;
}

export interface TypstSemanticUnit {
  id: string;
  kind: SemanticUnitKind;
  layoutRegionId: string;
  order: number;
  text?: string;
  targetSegments?: TypstTargetSegment[];
  assetId?: string;
}

export interface TypstProjectInput {
  metadata: AcademicTemplateOptions;
  regions: readonly LayoutRegion[];
  units: readonly TypstSemanticUnit[];
  assets: readonly ImmutableAsset[];
}

export interface TypstProject {
  mainContent: string;
  files: Map<string, Uint8Array>;
  markerIds: string[];
  regionIds: string[];
}

function quote(value: string): string {
  return `"${escapeTypstString(value)}"`;
}

function renderTextUnit(unit: TypstSemanticUnit, markerIds: string[]): string {
  const segments = unit.targetSegments?.length
    ? unit.targetSegments
    : [{ id: unit.id, text: unit.text ?? '' }];
  const marked = segments.map((segment) => {
    markerIds.push(segment.id);
    return `#pp-unit(${quote(encodeURIComponent(segment.id))})[${escapeTypstText(segment.text)}]`;
  }).join('\n');
  if (unit.kind === 'title') return `#pp-title[${marked}]`;
  if (unit.kind === 'author' || unit.kind === 'affiliation') return `#pp-author[${marked}]`;
  if (unit.kind === 'heading') return `#pp-heading[${marked}]`;
  if (unit.kind === 'caption' || unit.kind === 'table-title') return `#pp-caption[${marked}]`;
  if (unit.kind === 'reference') return `#pp-reference[${marked}]`;
  return marked;
}

function assetExtension(asset: ImmutableAsset): string {
  return asset.mimeType === 'image/jpeg' ? 'jpg' : 'png';
}

export async function buildTypstProject(input: TypstProjectInput): Promise<TypstProject> {
  const unitsById = new Map(input.units.map((unit) => [unit.id, unit]));
  if (unitsById.size !== input.units.length) throw new Error('Duplicate semantic unit ID');
  const assetsById = new Map(input.assets.map((asset) => [asset.id, asset]));
  if (assetsById.size !== input.assets.length) throw new Error('Duplicate immutable asset ID');

  const markerIds: string[] = [];
  const regionBodies: string[] = [];
  for (const region of input.regions) {
    const renderedUnits: string[] = [];
    for (const unitId of region.orderedUnitIds) {
      const unit = unitsById.get(unitId);
      if (!unit) throw new Error(`Layout region ${region.id} references missing unit ${unitId}`);
      if (unit.layoutRegionId !== region.id) throw new Error(`Unit ${unit.id} has a mismatched layout region`);
      if (unit.assetId) {
        const asset = assetsById.get(unit.assetId);
        if (!asset) throw new Error(`Unit ${unit.id} references missing asset ${unit.assetId}`);
        markerIds.push(unit.id);
        const path = `/assets/${asset.id}.${assetExtension(asset)}`;
        renderedUnits.push(`#pp-asset(${quote(encodeURIComponent(unit.id))}, ${quote(path)}, span: ${asset.widthMode === 'span'})`);
      } else {
        renderedUnits.push(renderTextUnit(unit, markerIds));
      }
    }
    const wrapper = region.mode === 'double'
      ? 'pp-double'
      : region.mode === 'full-width' ? 'pp-full-width' : 'pp-single';
    regionBodies.push(`#${wrapper}[\n${renderedUnits.join('\n\n')}\n]`);
  }

  if (new Set(markerIds).size !== markerIds.length) throw new Error('Duplicate Typst marker ID');
  const mainContent = `${buildAcademicTemplate(input.metadata)}\n${regionBodies.join('\n\n')}\n`;
  const files = new Map<string, Uint8Array>();
  const addFile = (path: string, bytes: Uint8Array): void => {
    if (files.has(path)) throw new Error(`Duplicate Typst project path: ${path}`);
    files.set(path, bytes);
  };

  for (const asset of input.assets) {
    if (!(await verifyAssetHash(asset))) throw new Error(`Immutable asset hash mismatch: ${asset.id}`);
    addFile(`/assets/${asset.id}.${assetExtension(asset)}`, new Uint8Array(await asset.blob.arrayBuffer()));
  }
  const encoder = new TextEncoder();
  addFile('/main.typ', encoder.encode(mainContent));
  addFile('/paper-parallel.json', encoder.encode(JSON.stringify({
    version: 1,
    markerIds,
    regionIds: input.regions.map((region) => region.id),
    assets: input.assets.map((asset) => ({ id: asset.id, sha256: asset.sha256 })),
  })));
  return {
    mainContent,
    files,
    markerIds,
    regionIds: input.regions.map((region) => region.id),
  };
}
