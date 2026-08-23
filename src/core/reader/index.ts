// ============================================================================
// reader/index.ts —— 对照阅读器核心类型化入口(核心在 reader.core.js)
// ============================================================================
import './reader.core.js';

export interface PositionedBlock {
  id: string;
  pageIndex: number;
  rect: { y: number; h: number };
}

export interface ReaderBlock extends PositionedBlock {
  type: string;
  text: string;
}

export interface ReaderSpan {
  en: string;
  zh: string;
  enBlockId: string;
  zhBlockId: string;
}

export interface SyncCommand {
  side: 'en' | 'zh';
  unitIndex: number;
  blockId: string;
  targetSide: 'en' | 'zh';
  targetBlockIds: string[];
  targetScrollTop: number;
  targetBlockTop: number;
}

interface ReaderCore {
  buildPositionIndex(blocks: PositionedBlock[], pageH: number): any;
  locateBlockAtViewport(idx: any, scrollTop: number, viewportH: number): any;
  buildUnitIndex(units: { enBlockIds: string[]; zhBlockIds: string[] }[]): Map<string, number>;
  resolveSyncCommand(
    enIdx: any,
    zhIdx: any,
    units: { enBlockIds: string[]; zhBlockIds: string[] }[],
    unitIndex: Map<string, number>,
    side: 'en' | 'zh',
    scrollTop: number,
    viewportH: number,
  ): SyncCommand | null;
  createSyncController(lockMs?: number): { shouldSync(side: 'en' | 'zh', now: number): boolean; reset(): void };
  locateSubstringRange(fullText: string, sub: string): { start: number; end: number } | null;
}

const core = (globalThis as any).PaperParallelReader as ReaderCore;

export const buildPositionIndex = core.buildPositionIndex.bind(core) as ReaderCore['buildPositionIndex'];
export const locateBlockAtViewport = core.locateBlockAtViewport.bind(core) as ReaderCore['locateBlockAtViewport'];
export const buildUnitIndex = core.buildUnitIndex.bind(core) as ReaderCore['buildUnitIndex'];
export const resolveSyncCommand = core.resolveSyncCommand.bind(core) as ReaderCore['resolveSyncCommand'];
export const createSyncController = core.createSyncController.bind(core) as ReaderCore['createSyncController'];
export const locateSubstringRange = core.locateSubstringRange.bind(core) as ReaderCore['locateSubstringRange'];
