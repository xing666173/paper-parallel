<script setup lang="ts">
// ============================================================================
// ReaderView.vue —— 双栏对照阅读器(Vue 组件)
// 交互逻辑与 P15 探针一致(已通过浏览器自动演示):锚点反查同步 + 回声抑制 +
// 同步锁 + 句级高亮 + 词级联动。渲染数据由调用方预解析后传入。
// ============================================================================
import { computed, onBeforeUnmount, reactive, ref } from 'vue';
import {
  buildPositionIndex,
  buildUnitIndex,
  resolveSyncCommand,
  createSyncController,
  locateSubstringRange,
  type ReaderBlock,
  type ReaderSpan,
} from '../../core/reader/index';

const props = defineProps<{
  enBlocks: ReaderBlock[];
  zhBlocks: ReaderBlock[];
  units: { enBlockIds: string[]; zhBlockIds: string[] }[];
  spans?: ReaderSpan[];
  pageH?: number;
  viewportH?: number;
  lockMs?: number;
}>();

const pageH = computed(() => props.pageH ?? 1000);
const viewportH = computed(() => props.viewportH ?? 600);
const enScroller = ref<HTMLElement | null>(null);
const zhScroller = ref<HTMLElement | null>(null);

const enIdx = computed(() => buildPositionIndex(props.enBlocks, pageH.value));
const zhIdx = computed(() => buildPositionIndex(props.zhBlocks, pageH.value));
const unitIdx = computed(() => buildUnitIndex(props.units));
const lock = createSyncController(props.lockMs ?? 150);

const activeUnit = ref<number | null>(null);
const activeUnitEls = computed(() => {
  if (activeUnit.value === null) return new Set<string>();
  const u = props.units[activeUnit.value];
  if (!u) return new Set<string>();
  return new Set<string>([...u.enBlockIds.map((id) => 'en:' + id), ...u.zhBlockIds.map((id) => 'zh:' + id)]);
});

let suppressNext: 'en' | 'zh' | '' = '';

function onScroll(side: 'en' | 'zh') {
  if (suppressNext === side) {
    suppressNext = '';
    return;
  }
  const scroller = side === 'en' ? enScroller.value : zhScroller.value;
  if (!scroller) return;
  if (!lock.shouldSync(side, performance.now())) return;
  const cmd = resolveSyncCommand(
    enIdx.value,
    zhIdx.value,
    props.units,
    unitIdx.value,
    side,
    scroller.scrollTop,
    viewportH.value,
  );
  if (!cmd) return;
  activeUnit.value = cmd.unitIndex;
  const other = cmd.targetSide === 'en' ? enScroller.value : zhScroller.value;
  if (other) {
    suppressNext = cmd.targetSide;
    other.scrollTop = cmd.targetScrollTop;
  }
}

interface CharBox {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const charBoxes = reactive<CharBox[]>([]);

function clickWord(span: ReaderSpan) {
  charBoxes.length = 0;
  const el = document.getElementById('en-' + span.enBlockId);
  if (!el) return;
  const range = locateSubstringRange(el.textContent || '', span.en);
  if (!range) return;
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const pad = parseFloat(style.paddingLeft || '0');
  const innerW = Math.max(1, rect.width - pad * 2);
  const chars = Math.max(1, [...(el.textContent || '')].length);
  const per = innerW / chars;
  for (let i = range.start; i < range.end; i++) {
    charBoxes.push({
      key: `${span.enBlockId}:${i}`,
      x: rect.left + pad + i * per,
      y: rect.top + 2,
      w: per,
      h: Math.max(4, rect.height - 4),
    });
  }
}

function zhTextParts(block: ReaderBlock): Array<{ text: string; word?: ReaderSpan }> {
  const spans = (props.spans ?? []).filter((s) => s.zhBlockId === block.id);
  if (!spans.length) return [{ text: block.text }];
  const parts: Array<{ text: string; word?: ReaderSpan }> = [];
  let cursor = 0;
  for (const sp of spans) {
    const idx = block.text.indexOf(sp.zh, cursor);
    if (idx < 0) continue;
    if (idx > cursor) parts.push({ text: block.text.slice(cursor, idx) });
    parts.push({ text: sp.zh, word: sp });
    cursor = idx + sp.zh.length;
  }
  if (cursor < block.text.length) parts.push({ text: block.text.slice(cursor) });
  return parts;
}

const pageCount = computed(() =>
  Math.max(1, ...props.enBlocks.map((b) => b.pageIndex + 1), ...props.zhBlocks.map((b) => b.pageIndex + 1)),
);

onBeforeUnmount(() => {
  charBoxes.length = 0;
  lock.reset();
});
</script>

<template>
  <div class="reader-view">
    <div class="pane">
      <h2>左 · 英文原文</h2>
      <div ref="enScroller" class="scroller" @scroll.passive="onScroll('en')">
        <div class="content" :style="{ height: pageCount * pageH + 'px' }">
          <div v-for="p in pageCount" :key="'enp' + p" class="pagesep" :style="{ top: (p - 1) * pageH + 'px' }">
            第 {{ p }} 页
          </div>
          <div
            v-for="b in enBlocks"
            :id="'en-' + b.id"
            :key="b.id"
            class="blk"
            :class="[b.type, { 'hl-unit': activeUnitEls.has('en:' + b.id) }]"
            :style="{ left: '40px', top: b.pageIndex * pageH + b.rect.y + 'px', width: 'calc(100% - 80px)', height: b.rect.h + 'px' }"
          >
            {{ b.text }}
          </div>
        </div>
      </div>
    </div>

    <div class="pane">
      <h2>右 · 中文译文</h2>
      <div ref="zhScroller" class="scroller" @scroll.passive="onScroll('zh')">
        <div class="content" :style="{ height: pageCount * pageH + 'px' }">
          <div v-for="p in pageCount" :key="'zhp' + p" class="pagesep" :style="{ top: (p - 1) * pageH + 'px' }">
            第 {{ p }} 页
          </div>
          <div
            v-for="b in zhBlocks"
            :id="'zh-' + b.id"
            :key="b.id"
            class="blk"
            :class="[b.type, { 'hl-unit': activeUnitEls.has('zh:' + b.id) }]"
            :style="{ left: '40px', top: b.pageIndex * pageH + b.rect.y + 'px', width: 'calc(100% - 80px)', height: b.rect.h + 'px' }"
          >
            <template v-for="part in zhTextParts(b)">
              <span :class="{ word: part.word }" @click="part.word ? clickWord(part.word) : undefined">
                {{ part.word ? part.word.zh : part.text }}
              </span>
            </template>
          </div>
        </div>
      </div>
    </div>

    <div
      v-for="c in charBoxes"
      :key="c.key"
      class="char"
      :style="{ left: c.x + 'px', top: c.y + 'px', width: c.w + 'px', height: c.h + 'px' }"
    />
  </div>
</template>

<style scoped>
.reader-view {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  position: relative;
  height: 100%;
}
.pane {
  background: #fff;
  border: 1px solid #d8dee6;
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.pane h2 {
  margin: 0;
  padding: 8px 10px;
  font-size: 13px;
  border-bottom: 1px solid #d8dee6;
  background: #f8fafc;
}
.scroller {
  position: relative;
  height: 600px;
  overflow: auto;
}
.content {
  position: relative;
}
.pagesep {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 1px dashed #cbd5e1;
  color: #9aa7b5;
  font-size: 9px;
  text-align: center;
}
.blk {
  position: absolute;
  border: 1px solid #b6c2d0;
  background: #fbfdff;
  padding: 6px 8px;
  font-size: 11px;
  line-height: 1.5;
  overflow: hidden;
  text-align: justify;
}
.blk.section {
  background: #f3e8ff;
  border-color: #a855f7;
  font-weight: 700;
}
.blk.title {
  background: #dbeafe;
  border-color: #3b82f6;
  font-weight: 700;
}
.hl-unit {
  outline: 3px solid #f59e0b;
  outline-offset: -1px;
  background: #fffbeb !important;
}
.word {
  cursor: pointer;
  background: #fef9c3;
  border-bottom: 1px dashed #d97706;
  padding: 0 1px;
}
.word:hover {
  background: #fde68a;
}
.char {
  position: fixed;
  background: rgba(14, 165, 233, 0.35);
  border: 1px solid #0284c7;
  pointer-events: none;
  z-index: 4;
}
</style>
