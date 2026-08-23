import { describe, it, expect } from 'vitest';
import {
  buildPositionIndex,
  buildUnitIndex,
  resolveSyncCommand,
  createSyncController,
  locateSubstringRange,
} from '../../src/core/reader/index';

const pageH = 1000;
const viewportH = 300;
const enBlocks = [
  { id: 'ep1', pageIndex: 0, rect: { y: 100, h: 80 } },
  { id: 'ep2', pageIndex: 1, rect: { y: 200, h: 80 } },
  { id: 'ep3', pageIndex: 2, rect: { y: 300, h: 80 } },
];
const zhBlocks = [
  { id: 'zp1', pageIndex: 0, rect: { y: 500, h: 100 } },
  { id: 'zp2', pageIndex: 1, rect: { y: 100, h: 100 } },
  { id: 'zp3', pageIndex: 1, rect: { y: 600, h: 100 } },
];
const units = [
  { enBlockIds: ['ep1'], zhBlockIds: ['zp1'] },
  { enBlockIds: ['ep2'], zhBlockIds: ['zp2'] },
  { enBlockIds: ['ep3'], zhBlockIds: ['zp3'] },
];

function setup() {
  const enIdx = buildPositionIndex(enBlocks, pageH);
  const zhIdx = buildPositionIndex(zhBlocks, pageH);
  const unitIdx = buildUnitIndex(units);
  return { enIdx, zhIdx, unitIdx };
}

describe('reader: 锚点反查同步', () => {
  it('右->左与左->右:目标滚动按对方块中心计算并钳制', () => {
    const { enIdx, zhIdx, unitIdx } = setup();
    const c1 = resolveSyncCommand(enIdx, zhIdx, units, unitIdx, 'zh', 400, viewportH);
    expect(c1).toMatchObject({ unitIndex: 0, targetBlockIds: ['ep1'], targetScrollTop: 0 });
    const c2 = resolveSyncCommand(enIdx, zhIdx, units, unitIdx, 'zh', 1000, viewportH);
    expect(c2!.targetScrollTop).toBeCloseTo(1090);
    const c3 = resolveSyncCommand(enIdx, zhIdx, units, unitIdx, 'en', 2200, viewportH);
    expect(c3!.targetScrollTop).toBeCloseTo(1500);
    expect(c3!.targetSide).toBe('zh');
  });

  it('同步锁:同侧锁定期抑制,对侧放行,过期解锁', () => {
    const lock = createSyncController(150);
    expect(lock.shouldSync('zh', 0)).toBe(true);
    expect(lock.shouldSync('zh', 50)).toBe(false);
    expect(lock.shouldSync('en', 80)).toBe(true);
    expect(lock.shouldSync('zh', 200)).toBe(true);
  });
});

describe('reader: 词级联动定位', () => {
  it('原文精确定位与多空格归一化回退', () => {
    expect(locateSubstringRange('We propose a hardware accelerator for trace generation.', 'hardware accelerator')).toEqual({ start: 13, end: 33 });
    expect(locateSubstringRange('我们为执行轨迹生成提出一种硬件加速器。', '硬件加速器')?.start).toBe(13);
    expect(locateSubstringRange('We propose  a   hardware accelerator here.', 'hardware accelerator')?.start).toBe(16);
    expect(locateSubstringRange('nothing here', 'missing')).toBeNull();
  });
});
