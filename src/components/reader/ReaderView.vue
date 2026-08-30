<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import PdfPane, { type PdfPageMetric } from './PdfPane.vue';
import ReaderToolbar from './ReaderToolbar.vue';
import { buildPdfPositionIndex, createSyncController, resolvePdfSyncCommand, shouldSuppressScrollEcho } from '../../core/reader';
import type { AlignmentManifest } from '../../core/align/manifest';

type PaneHandle = { scrollToPosition(top: number): void; scrollToPage(pageIndex: number): void; getScroller(): HTMLElement | null };
const props = withDefaults(defineProps<{
  englishPdf: Blob; chinesePdf: Blob; manifest: AlignmentManifest;
  initialPageCounts?: { en: number; zh: number }; chineseFilename?: string;
}>(), { initialPageCounts: () => ({ en: 0, zh: 0 }), chineseFilename: '中文论文.pdf' });
const emit = defineEmits<{ return: []; choose: []; clear: []; 'download-package': []; error: [message: string] }>();

const enPane = ref<PaneHandle>();
const zhPane = ref<PaneHandle>();
const pageCounts = ref({ ...props.initialPageCounts });
const pageMetrics = ref<{ en: PdfPageMetric[]; zh: PdfPageMetric[] }>({ en: [], zh: [] });
const pages = ref({ en: 0, zh: 0 });
const zoom = ref({ en: 1, zh: 1 });
const syncEnabled = ref(true);
const highlightsEnabled = ref(true);
function hasGeometry(sets: AlignmentManifest['units'][number]['source']): boolean {
  return sets.some((set) => set.rects.length > 0);
}
function isPairedUnit(unit: AlignmentManifest['units'][number]): boolean {
  return unit.status !== 'unmatched' && hasGeometry(unit.source) && hasGeometry(unit.target);
}
const pairedUnits = computed(() => props.manifest.units.filter(isPairedUnit));
const activeUnitId = ref(props.manifest.units.find(isPairedUnit)?.id ?? '');
const lock = createSyncController(120);
let suppressNext: 'en' | 'zh' | '' = '';
let animationFrame = 0;
let pendingScroll: { side: 'en' | 'zh'; scrollTop: number; viewportHeight: number } | undefined;

const activeUnit = computed(() => pairedUnits.value.find((unit) => unit.id === activeUnitId.value));
const enActiveRects = computed(() => highlightsEnabled.value ? activeUnit.value?.source ?? [] : []);
const zhActiveRects = computed(() => highlightsEnabled.value ? activeUnit.value?.target ?? [] : []);
const enGeometry = computed(() => pairedUnits.value.map((unit) => ({ id: unit.id, rects: unit.source })));
const zhGeometry = computed(() => pairedUnits.value.map((unit) => ({ id: unit.id, rects: unit.target })));

function offsetsFor(side: 'en' | 'zh'): number[] {
  const offsets: number[] = [];
  let offset = 18;
  for (let index = 0; index < pageCounts.value[side]; index += 1) {
    offsets.push(offset);
    offset += (pageMetrics.value[side][index]?.height ?? 792) * zoom.value[side] + 18;
  }
  return offsets;
}
function indexFor(side: 'en' | 'zh') {
  return buildPdfPositionIndex(props.manifest.units, side, offsetsFor(side), zoom.value[side]);
}
function paneFor(side: 'en' | 'zh') { return side === 'en' ? enPane.value : zhPane.value; }

function runSync(payload: typeof pendingScroll) {
  if (!payload || !syncEnabled.value) return;
  if (suppressNext === payload.side) { suppressNext = ''; return; }
  if (!lock.shouldSync(payload.side, performance.now())) return;
  const targetSide = payload.side === 'en' ? 'zh' : 'en';
  const targetPane = paneFor(targetSide);
  const targetScroller = targetPane?.getScroller();
  if (!targetPane || !targetScroller) return;
  const command = resolvePdfSyncCommand({
    side: payload.side, viewportCenter: payload.scrollTop + payload.viewportHeight / 2,
    sourceIndex: indexFor(payload.side), targetIndex: indexFor(targetSide),
    targetViewportHeight: targetScroller.clientHeight, targetScrollHeight: targetScroller.scrollHeight,
  });
  if (!command) return;
  activeUnitId.value = command.unitId;
  if (shouldSuppressScrollEcho(targetScroller.scrollTop, command.targetScrollTop)) {
    suppressNext = targetSide;
    targetPane.scrollToPosition(command.targetScrollTop);
  }
}
function onPaneScroll(payload: NonNullable<typeof pendingScroll>) {
  pendingScroll = payload;
  if (animationFrame) return;
  animationFrame = requestAnimationFrame(() => {
    animationFrame = 0;
    const next = pendingScroll;
    pendingScroll = undefined;
    runSync(next);
  });
}
function onUnitClick(unitId: string, sourceSide: 'en' | 'zh') {
  activeUnitId.value = unitId;
  if (!syncEnabled.value) return;
  const targetSide = sourceSide === 'en' ? 'zh' : 'en';
  const target = indexFor(targetSide).byId.get(unitId);
  const targetPane = paneFor(targetSide);
  const scroller = targetPane?.getScroller();
  if (target && targetPane && scroller) targetPane.scrollToPosition(Math.max(0, target.anchor - scroller.clientHeight / 2));
}
function onLoaded(side: 'en' | 'zh', payload: { pageCount: number; pageMetrics: PdfPageMetric[] }) {
  pageCounts.value = { ...pageCounts.value, [side]: payload.pageCount };
  pageMetrics.value = { ...pageMetrics.value, [side]: payload.pageMetrics };
}
function stepPage(side: 'en' | 'zh', delta: number) {
  const next = Math.max(0, Math.min(pageCounts.value[side] - 1, pages.value[side] + delta));
  pages.value = { ...pages.value, [side]: next };
  paneFor(side)?.scrollToPage(next);
}
function stepZoom(side: 'en' | 'zh', delta: number) {
  zoom.value = { ...zoom.value, [side]: Math.max(.5, Math.min(2.5, Number((zoom.value[side] + delta).toFixed(2)))) };
}
function fitWidth(side: 'en' | 'zh') {
  const scroller = paneFor(side)?.getScroller();
  const width = pageMetrics.value[side][pages.value[side]]?.width ?? 612;
  if (scroller) zoom.value = { ...zoom.value, [side]: Math.max(.5, Math.min(2.5, (scroller.clientWidth - 40) / width)) };
}
function downloadChinese() {
  const url = URL.createObjectURL(props.chinesePdf);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = props.chineseFilename; anchor.click();
  URL.revokeObjectURL(url);
}
onBeforeUnmount(() => { if (animationFrame) cancelAnimationFrame(animationFrame); lock.reset(); });
</script>

<template>
  <section class="reader-view">
    <ReaderToolbar
      :en-page="pages.en" :en-page-count="pageCounts.en" :zh-page="pages.zh" :zh-page-count="pageCounts.zh"
      :en-zoom="zoom.en" :zh-zoom="zoom.zh" :sync-enabled="syncEnabled" :highlights-enabled="highlightsEnabled"
      @return="emit('return')" @choose="emit('choose')" @clear="emit('clear')"
      @download-chinese="downloadChinese" @download-package="emit('download-package')"
      @page-step="stepPage" @zoom-step="stepZoom" @fit-width="fitWidth"
      @update:sync-enabled="syncEnabled = $event" @update:highlights-enabled="highlightsEnabled = $event"
    />
    <div class="pdf-workspace">
      <PdfPane ref="enPane" side="en" title="英文原文" :pdf-blob="englishPdf" :page-count="pageCounts.en"
        :page-metrics="pageMetrics.en" :active-rects="enActiveRects" :unit-geometry="enGeometry" :zoom="zoom.en"
        @loaded="onLoaded('en', $event)" @scroll="onPaneScroll" @page-change="pages.en = $event"
        @unit-click="onUnitClick" @error="emit('error', $event)" />
      <PdfPane ref="zhPane" side="zh" title="中文译文" :pdf-blob="chinesePdf" :page-count="pageCounts.zh"
        :page-metrics="pageMetrics.zh" :active-rects="zhActiveRects" :unit-geometry="zhGeometry" :zoom="zoom.zh"
        @loaded="onLoaded('zh', $event)" @scroll="onPaneScroll" @page-change="pages.zh = $event"
        @unit-click="onUnitClick" @error="emit('error', $event)" />
    </div>
  </section>
</template>

<style scoped>
.reader-view { height: calc(100vh - 70px); display: flex; flex-direction: column; background: #eef2f6; }
.pdf-workspace { min-height: 0; flex: 1; display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 12px; padding: 12px; }
@media (max-width: 900px) { .reader-view { height: auto; min-height: calc(100vh - 70px); }.pdf-workspace { grid-template-columns: 1fr; grid-template-rows: 70vh 70vh; } }
</style>
