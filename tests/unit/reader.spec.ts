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
  buildPdfPositionIndex,
  resolvePdfSyncCommand,
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

describe('reader: 独立 PDF 语义矩形同步', () => {
  const manifestUnits = [
    {
      id: 'sec-3-p-2-s-1',
      source: [{ page: 3, rects: [{ x: 40, y: 100, w: 200, h: 40 }] }],
      target: [{ page: 5, rects: [{ x: 40, y: 220, w: 200, h: 60 }] }],
    },
    {
      id: 'sec-3-p-3-s-1',
      source: [{ page: 4, rects: [{ x: 40, y: 300, w: 200, h: 40 }] }],
      target: [{ page: 6, rects: [{ x: 40, y: 500, w: 200, h: 60 }] }],
    },
  ];
  const enIndex = buildPdfPositionIndex(manifestUnits, 'en', [0, 1000, 2000, 3000, 4000], 1);
  const zhIndex = buildPdfPositionIndex(manifestUnits, 'zh', [0, 1100, 2200, 3300, 4400, 5500, 6600], 1);

  it('按语义锚点把英文第 4 页映射到中文第 6 页', () => {
    const command = resolvePdfSyncCommand({
      side: 'en', viewportCenter: 3120,
      sourceIndex: enIndex, targetIndex: zhIndex,
      targetViewportHeight: 700,
    });
    expect(command).toMatchObject({
      targetSide: 'zh', unitId: 'sec-3-p-2-s-1', targetPage: 5,
    });
  });

  it('在长段落的前后语义单元之间线性插值', () => {
    const sourceIndex = buildPdfPositionIndex([
      { id: 'a', source: [{ page: 0, rects: [{ x: 0, y: 80, w: 10, h: 40 }] }], target: [] },
      { id: 'b', source: [{ page: 0, rects: [{ x: 0, y: 280, w: 10, h: 40 }] }], target: [] },
    ], 'en', [0], 1);
    const targetIndex = buildPdfPositionIndex([
      { id: 'a', source: [], target: [{ page: 0, rects: [{ x: 0, y: 180, w: 10, h: 40 }] }] },
      { id: 'b', source: [], target: [{ page: 0, rects: [{ x: 0, y: 580, w: 10, h: 40 }] }] },
    ], 'zh', [0], 1);
    const command = resolvePdfSyncCommand({
      side: 'en', viewportCenter: 200,
      sourceIndex, targetIndex, targetViewportHeight: 100,
    })!;
    expect(command.targetScrollTop).toBeGreaterThan(150);
    expect(command.targetScrollTop).toBeLessThan(550);
    expect(command.targetScrollTop).toBeCloseTo(350);
  });

  it('保留一个单元的全部矩形片段用于高亮', () => {
    const index = buildPdfPositionIndex([{
      id: 'multi',
      source: [{ page: 0, rects: [
        { x: 10, y: 20, w: 30, h: 10 },
        { x: 10, y: 34, w: 40, h: 10 },
      ] }],
      target: [],
    }], 'en', [100], 2);
    expect(index.byId.get('multi')?.fragments).toHaveLength(2);
    expect(index.byId.get('multi')?.anchor).toBe(150);
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
