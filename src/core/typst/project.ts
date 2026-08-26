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
  sourceColumn?: 'left' | 'right' | 'span';
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

function sourceWidth(width: number): string {
  if (!Number.isFinite(width) || width <= 0) throw new Error('Immutable asset width must be positive');
  return `${Math.round(width * 100) / 100}pt`;
}

function boundedAssetWidth(
  asset: ImmutableAsset,
  regionMode: LayoutRegion['mode'],
  metadata: AcademicTemplateOptions,
  rowSize = 1,
): number {
  const margin = metadata.margin ?? Math.max(36, metadata.paperWidth * 0.1);
  const contentWidth = metadata.paperWidth - margin * 2;
  const gutter = metadata.columnGap ?? 12;
  const regionAvailable = regionMode === 'double' && asset.widthMode !== 'span'
    ? (contentWidth - gutter) / 2
    : contentWidth;
  const available = rowSize > 1
    ? (contentWidth - gutter * (rowSize - 1)) / rowSize
    : regionAvailable;
  return Math.min(asset.sourceRect.w, available);
}

export async function buildTypstProject(input: TypstProjectInput): Promise<TypstProject> {
  const unitsById = new Map(input.units.map((unit) => [unit.id, unit]));
  if (unitsById.size !== input.units.length) throw new Error('Duplicate semantic unit ID');
  const assetsById = new Map(input.assets.map((asset) => [asset.id, asset]));
  if (assetsById.size !== input.assets.length) throw new Error('Duplicate immutable asset ID');

  const markerIds: string[] = [];
  const regionBodies: string[] = [];
  let previousSourcePage: number | undefined;
  for (const region of input.regions) {
    if (previousSourcePage !== undefined && region.sourcePage > previousSourcePage) {
      regionBodies.push('#pagebreak(weak: true)');
    }
    previousSourcePage = region.sourcePage;
    const segments: Array<{
      mode: LayoutRegion['mode'];
      rendered: Array<{ content: string; sourceColumn?: TypstSemanticUnit['sourceColumn'] }>;
    }> = [];
    const spanCaptionIds = new Set(input.assets
      .filter((asset) => asset.widthMode === 'span' && asset.captionUnitId)
      .map((asset) => asset.captionUnitId!));
    const regionUnitIds = new Set(region.orderedUnitIds);
    const captionAssets = new Map<string, ImmutableAsset[]>();
    for (const asset of input.assets) {
      if (!asset.captionUnitId || !regionUnitIds.has(asset.id) || !regionUnitIds.has(asset.captionUnitId)) continue;
      const group = captionAssets.get(asset.captionUnitId) ?? [];
      group.push(asset);
      captionAssets.set(asset.captionUnitId, group);
    }
    const horizontalCellCount = region.presentation === 'horizontal'
      ? captionAssets.size + region.orderedUnitIds.filter((unitId) => {
        const unit = unitsById.get(unitId);
        const member = unit?.assetId ? assetsById.get(unit.assetId) : undefined;
        return Boolean(member && !member.captionUnitId);
      }).length
      : 1;
    const consumed = new Set<string>();
    const pushRendered = (
      mode: LayoutRegion['mode'],
      content: string,
      sourceColumn?: TypstSemanticUnit['sourceColumn'],
    ) => {
      const current = segments.at(-1);
      const segment = current?.mode === mode
        ? current
        : (() => {
          const created = { mode, rendered: [] as Array<{ content: string; sourceColumn?: TypstSemanticUnit['sourceColumn'] }> };
          segments.push(created);
          return created;
        })();
      segment.rendered.push({ content, sourceColumn });
    };
    const renderAsset = (unit: TypstSemanticUnit, asset: ImmutableAsset, rowSize = 1) => {
      markerIds.push(unit.id);
      const path = `/assets/${asset.id}.${assetExtension(asset)}`;
      const width = boundedAssetWidth(asset, region.mode, input.metadata, rowSize);
      return `#pp-asset(${quote(encodeURIComponent(unit.id))}, ${quote(path)}, ${sourceWidth(width)}, span: ${asset.widthMode === 'span'})`;
    };

    for (const unitId of region.orderedUnitIds) {
      if (consumed.has(unitId)) continue;
      const unit = unitsById.get(unitId);
      if (!unit) throw new Error(`Layout region ${region.id} references missing unit ${unitId}`);
      if (unit.layoutRegionId !== region.id) throw new Error(`Unit ${unit.id} has a mismatched layout region`);
      const asset = unit.assetId ? assetsById.get(unit.assetId) : undefined;

      const captionId = asset?.captionUnitId ?? (captionAssets.has(unit.id) ? unit.id : undefined);
      const groupedAssets = captionId ? captionAssets.get(captionId) ?? [] : [];
      if (captionId && groupedAssets.length) {
        const caption = unitsById.get(captionId);
        if (!caption) throw new Error(`Immutable asset group references missing caption ${captionId}`);
        const assetUnits = groupedAssets.map((member) => {
          const memberUnit = unitsById.get(member.id);
          if (!memberUnit) throw new Error(`Immutable asset group references missing unit ${member.id}`);
          return { asset: member, unit: memberUnit };
        });
        const memberIds = [captionId, ...assetUnits.map((member) => member.unit.id)];
        memberIds.forEach((id) => consumed.add(id));
        const rowSize = assetUnits.length > 1 ? assetUnits.length : horizontalCellCount;
        const assetCodes = assetUnits.map((member) => renderAsset(member.unit, member.asset, rowSize));
        const assetsContent = assetCodes.length > 1
          ? `#grid(columns: ${assetCodes.length}, gutter: 6pt, ${assetCodes.map((code) => `[${code}]`).join(', ')})`
          : assetCodes[0]!;
        const captionContent = renderTextUnit(caption, markerIds);
        const tableOnly = groupedAssets.every((member) => member.kind === 'table');
        const content = `#pp-asset-group[\n${tableOnly ? `${captionContent}\n${assetsContent}` : `${assetsContent}\n${captionContent}`}\n]`;
        const groupMode: LayoutRegion['mode'] = region.mode === 'double'
          && (groupedAssets.length > 1 || groupedAssets.some((member) => member.widthMode === 'span'))
          ? 'full-width'
          : region.mode;
        const columns = new Set(memberIds.map((id) => unitsById.get(id)?.sourceColumn).filter(Boolean));
        pushRendered(groupMode, content, columns.size === 1 ? [...columns][0] : 'span');
        continue;
      }

      const unitMode = region.mode === 'double' && (asset?.widthMode === 'span' || spanCaptionIds.has(unit.id))
        ? 'full-width'
        : region.mode;
      if (unit.assetId) {
        if (!asset) throw new Error(`Unit ${unit.id} references missing asset ${unit.assetId}`);
        pushRendered(unitMode, renderAsset(unit, asset, horizontalCellCount), unit.sourceColumn);
      } else {
        pushRendered(unitMode, renderTextUnit(unit, markerIds), unit.sourceColumn);
      }
    }
    if (region.presentation === 'horizontal') {
      const cells = segments.flatMap((segment) => segment.rendered.map((item) => item.content));
      if (cells.length) {
        regionBodies.push(`#pp-full-width[\n#grid(columns: ${cells.length}, gutter: 6pt, ${cells.map((cell) => `[${cell}]`).join(', ')})\n]`);
      }
      continue;
    }
    for (const segment of segments) {
      const wrapper = segment.mode === 'double'
        ? 'pp-double'
        : segment.mode === 'full-width' ? 'pp-full-width' : 'pp-single';
      const rendered: string[] = [];
      let previousColumn: TypstSemanticUnit['sourceColumn'];
      for (const item of segment.rendered) {
        if (segment.mode === 'double' && previousColumn === 'left' && item.sourceColumn === 'right') {
          rendered.push('#colbreak()');
        }
        rendered.push(item.content);
        if (item.sourceColumn && item.sourceColumn !== 'span') previousColumn = item.sourceColumn;
      }
      regionBodies.push(`#${wrapper}[\n${rendered.join('\n\n')}\n]`);
    }
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
