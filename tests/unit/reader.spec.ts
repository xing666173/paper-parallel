import { describe, it, expect } from 'vitest';
import {
  buildPositionIndex,
  buildUnitIndex,
  resolveSyncCommand,
  createSyncController,
  locateSubstringRange,
  buildReaderModel,
  buildMeasuredPositionIndex,
  shouldSuppressScrollEcho,
  clampScrollTop,
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

describe('reader: DOM 坐标归一化', () => {
  it('DOM 测量坐标先减去内容区起点再参与同步', () => {
    const index = buildMeasuredPositionIndex([
      { id: 'e1', top: 620, height: 80 },
      { id: 'e2', top: 730, height: 90 },
    ], 500);

    expect(index.sorted.map((block) => ({ id: block.id, top: block.absTop, bottom: block.absBottom }))).toEqual([
      { id: 'e1', top: 120, bottom: 200 },
      { id: 'e2', top: 230, bottom: 320 },
    ]);
  });

  it('目标滚动值未变化时不留下回声抑制标记', () => {
    expect(shouldSuppressScrollEcho(120, 120)).toBe(false);
    expect(shouldSuppressScrollEcho(120, 120.2)).toBe(false);
    expect(shouldSuppressScrollEcho(120, 150)).toBe(true);
  });

  it('目标位置先钳制到实际滚动范围再判断是否产生回声', () => {
    expect(clampScrollTop(-20, 1000, 400)).toBe(0);
    expect(clampScrollTop(500, 1000, 400)).toBe(500);
    expect(clampScrollTop(900, 1000, 400)).toBe(600);
    expect(shouldSuppressScrollEcho(600, clampScrollTop(900, 1000, 400))).toBe(false);
  });
});

describe('reader: 项目包转真实阅读模型', () => {
  it('没有页面坐标时仍生成可滚动双栏并保留有效对齐', () => {
    const model = buildReaderModel({
      enDoc: {
        blocks: [
          { id: 'e-title', type: 'title', text: 'Paper title', order: 0 },
          { id: 'e-body', type: 'paragraph', text: 'First sentence. Second sentence.', order: 1 },
        ],
      },
      zhDoc: {
        blocks: [
          { id: 'z-title', type: 'title', text: '论文标题', order: 0 },
          { id: 'z-body', type: 'paragraph', text: '第一句。第二句。', order: 1 },
        ],
      },
      units: [
        { enBlockIds: ['e-title'], zhBlockIds: ['z-title'] },
        { enBlockIds: ['e-body'], zhBlockIds: ['z-body'] },
      ],
    });

    expect(model.enBlocks.map((block) => block.id)).toEqual(['e-title', 'e-body']);
    expect(model.zhBlocks.map((block) => block.id)).toEqual(['z-title', 'z-body']);
    expect(model.units).toHaveLength(2);
    expect(model.stats).toEqual({ enBlocks: 2, zhBlocks: 2, matchedUnits: 2, unmatchedEn: 0, unmatchedZh: 0 });
    expect(model.enBlocks[1].rect.y).toBeGreaterThan(model.enBlocks[0].rect.y);
    expect(Number.isFinite(model.enBlocks[1].rect.h)).toBe(true);
  });

  it('剔除失效引用并明确标注仍需展示的未匹配块', () => {
    const model = buildReaderModel({
      enDoc: { blocks: [{ id: 'e1', type: 'paragraph', text: 'Matched' }, { id: 'e2', type: 'paragraph', text: 'Unmatched' }] },
      zhDoc: { blocks: [{ id: 'z1', type: 'paragraph', text: '已匹配' }] },
      units: [
        { enBlockIds: ['e1'], zhBlockIds: ['z1'] },
        { enBlockIds: ['missing-en'], zhBlockIds: ['z1'] },
      ],
    });

    expect(model.units).toEqual([{ enBlockIds: ['e1'], zhBlockIds: ['z1'] }]);
    expect(model.enBlocks.map((block) => ({ id: block.id, matched: block.matched, unitIndex: block.unitIndex }))).toEqual([
      { id: 'e1', matched: true, unitIndex: 0 },
      { id: 'e2', matched: false, unitIndex: null },
    ]);
    expect(model.stats.unmatchedEn).toBe(1);
  });

  it('损坏的对齐 ID 字段按空数组处理而不是中断阅读器', () => {
    expect(() => buildReaderModel({
      enDoc: { blocks: [{ id: 'e1', type: 'paragraph', text: 'English' }] },
      zhDoc: { blocks: [{ id: 'z1', type: 'paragraph', text: '中文' }] },
      units: [
        { enBlockIds: 'e1' as unknown as string[], zhBlockIds: null as unknown as string[] },
        { enBlockIds: ['e1'], zhBlockIds: ['z1'] },
      ],
    })).not.toThrow();
  });
});
