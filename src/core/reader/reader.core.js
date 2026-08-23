// ============================================================================
// reader.core.js —— 对照阅读器核心(浏览器 / Node 通用,零依赖)
// 对应实施计划 Sprint 5:
//   - 锚点反查同步(绝不按百分比):视口位置 -> 块 -> 对齐单元 -> 对方块
//   - 同步锁:同一方向滚动只发一次命令,锁定期内忽略循环回弹
//   - 词级联动:按文本子串定位字符区间(span 校验已由 align 层完成)
// ============================================================================

/**
 * 把带 pageIndex+rect 的块展开为绝对 Y 位置索引。
 * @param {Array<{id:string,pageIndex:number,rect:{y:number,h:number}}>} blocks
 * @param {number} pageH 每页高度(视口 px)
 * @returns {{byId:Map, sorted:Array<{id,absTop,absBottom,pageIndex,rect}>}}
 */
function buildPositionIndex(blocks, pageH) {
  const sorted = blocks.map((b) => ({
    id: b.id,
    absTop: b.pageIndex * pageH + b.rect.y,
    absBottom: b.pageIndex * pageH + b.rect.y + b.rect.h,
    pageIndex: b.pageIndex,
    rect: b.rect,
  }));
  sorted.sort((a, b) => a.absTop - b.absTop);
  const byId = new Map(sorted.map((x) => [x.id, x]));
  return { sorted, byId };
}

/**
 * 定位某侧视口中心所在的块:二分最近块。
 * @param {{sorted:Array,byId:Map}} idx
 * @param {number} scrollTop
 * @param {number} viewportH
 */
function locateBlockAtViewport(idx, scrollTop, viewportH) {
  const center = scrollTop + viewportH / 2;
  let lo = 0;
  let hi = idx.sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (idx.sorted[mid].absTop <= center) lo = mid;
    else hi = mid - 1;
  }
  if (!idx.sorted.length) return null;
  return idx.sorted[Math.max(0, lo)];
}

/**
 * 对齐表:units = [{enBlockIds:[], zhBlockIds:[]}]
 * 建 blockId -> unitIndex 索引。
 * @param {Array<{enBlockIds:string[],zhBlockIds:string[]}>} units
 */
function buildUnitIndex(units) {
  const map = new Map();
  units.forEach((u, i) => {
    for (const id of u.enBlockIds || []) map.set('en:' + id, i);
    for (const id of u.zhBlockIds || []) map.set('zh:' + id, i);
  });
  return map;
}

/**
 * 锚点反查 + 计算对方滚动目标。
 * @param {Object} enIdx @param {Object} zhIdx
 * @param {Array} units @param {Map} unitIndex
 * @param {'en'|'zh'} side
 * @param {number} scrollTop
 * @param {number} viewportH
 * @returns {{side, unitIndex:number, blockId:string, targetSide:'en'|'zh', targetBlockIds:string[], targetScrollTop:number}|null}
 */
function resolveSyncCommand(enIdx, zhIdx, units, unitIndex, side, scrollTop, viewportH) {
  const idx = side === 'en' ? enIdx : zhIdx;
  const block = locateBlockAtViewport(idx, scrollTop, viewportH);
  if (!block) return null;
  const ui = unitIndex.get(side + ':' + block.id);
  if (ui === undefined || !units[ui]) return null;
  const unit = units[ui];
  const targetSide = side === 'en' ? 'zh' : 'en';
  const targetBlockIds = unit[targetSide === 'en' ? 'enBlockIds' : 'zhBlockIds'];
  if (!targetBlockIds || !targetBlockIds.length) return null;
  const targetIdx = targetSide === 'en' ? enIdx : zhIdx;
  const targets = targetBlockIds.map((id) => targetIdx.byId.get(id)).filter(Boolean);
  if (!targets.length) return null;
  const first = targets[0];
  const targetCenter = first.absTop + first.rect.h / 2;
  const targetScrollTop = Math.max(0, targetCenter - viewportH / 2);
  return { side, unitIndex: ui, blockId: block.id, targetSide, targetBlockIds, targetScrollTop, targetBlockTop: first.absTop };
}

/**
 * 同步锁:同侧滚动在 lockMs 内只允许一次命令;对侧始终允许。
 */
function createSyncController(lockMs = 150) {
  let lockedSide = null;
  let lockUntil = 0;
  return {
    /** @returns {boolean} 是否应执行同步命令 */
    shouldSync(side, now) {
      if (lockedSide === side && now < lockUntil) return false;
      lockedSide = side;
      lockUntil = now + lockMs;
      return true;
    },
    reset() {
      lockedSide = null;
      lockUntil = 0;
    },
  };
}

/**
 * 词级联动:在目标块文本中定位子串的字符区间。
 * @param {string} fullText
 * @param {string} sub
 * @returns {{start:number,end:number}|null}
 */
function locateSubstringRange(fullText, sub) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s\u3000]+/g, ' ').trim();
  const ft = norm(fullText);
  const st = norm(sub);
  if (!st) return null;
  // 归一化后索引可能与原文错位:先试原文精确,再退回归一化文本近似区间
  const direct = String(fullText || '').indexOf(sub);
  if (direct >= 0) return { start: direct, end: direct + sub.length };
  const idx = ft.indexOf(st);
  if (idx < 0) return null;
  return { start: idx, end: idx + st.length };
}

const __rootReader = typeof globalThis !== 'undefined' ? globalThis : this;
__rootReader.PaperParallelReader = {
  buildPositionIndex,
  locateBlockAtViewport,
  buildUnitIndex,
  resolveSyncCommand,
  createSyncController,
  locateSubstringRange,
};
