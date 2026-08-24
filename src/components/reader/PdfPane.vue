<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
} from 'vue';
import AlignmentOverlay from './AlignmentOverlay.vue';
import { getDocument, type PDFDocumentProxy, type RenderTask } from '../../core/pdf/runtime';
import type { AlignmentRectSet } from '../../types/models';

export interface PdfPageMetric {
  width: number;
  height: number;
}

export interface PdfUnitGeometry {
  id: string;
  rects: AlignmentRectSet[];
}

const props = withDefaults(defineProps<{
  side: 'en' | 'zh';
  title: string;
  pdfBlob?: Blob;
  pageCount?: number;
  pageMetrics?: PdfPageMetric[];
  visiblePages?: number[];
  activeRects: AlignmentRectSet[];
  unitGeometry?: PdfUnitGeometry[];
  zoom: number;
}>(), {
  pdfBlob: undefined,
  pageCount: 0,
  pageMetrics: () => [],
  visiblePages: undefined,
  unitGeometry: () => [],
});

const emit = defineEmits<{
  scroll: [payload: { side: 'en' | 'zh'; scrollTop: number; viewportHeight: number }];
  'page-change': [pageIndex: number];
  'unit-click': [unitId: string, side: 'en' | 'zh'];
  loaded: [payload: { pageCount: number; pageMetrics: PdfPageMetric[] }];
  error: [message: string];
}>();

const scroller = ref<HTMLElement | null>(null);
const pdf = shallowRef<PDFDocumentProxy>();
const measuredMetrics = ref<PdfPageMetric[]>([]);
const internalVisible = ref<number[]>([0]);
const currentPage = ref(0);
const canvases = new Map<number, HTMLCanvasElement>();
const renderTasks = new Map<number, RenderTask>();
let loadingTask: ReturnType<typeof getDocument> | undefined;
let loadGeneration = 0;

const effectivePageCount = computed(() => pdf.value?.numPages ?? props.pageCount ?? 0);
const metrics = computed(() => measuredMetrics.value.length ? measuredMetrics.value : props.pageMetrics);
const baseVisible = computed(() => props.visiblePages ?? internalVisible.value);
const renderPages = computed(() => {
  const pages = new Set<number>();
  for (const page of baseVisible.value) {
    for (let offset = -2; offset <= 2; offset += 1) {
      const candidate = page + offset;
      if (candidate >= 0 && candidate < effectivePageCount.value) pages.add(candidate);
    }
  }
  return pages;
});

function metricFor(pageIndex: number): PdfPageMetric {
  return metrics.value[pageIndex] ?? metrics.value[0] ?? { width: 612, height: 792 };
}

function pageStyle(pageIndex: number) {
  const metric = metricFor(pageIndex);
  return {
    width: `${metric.width * props.zoom}px`,
    height: `${metric.height * props.zoom}px`,
  };
}

function activeRectsFor(pageIndex: number) {
  return props.activeRects.find((set) => set.page === pageIndex)?.rects ?? [];
}

function cancelRender(pageIndex: number) {
  const task = renderTasks.get(pageIndex);
  if (task) {
    task.cancel();
    renderTasks.delete(pageIndex);
  }
}

function cancelAllRenders() {
  for (const pageIndex of renderTasks.keys()) cancelRender(pageIndex);
}

async function renderPage(pageIndex: number) {
  const document = pdf.value;
  const canvas = canvases.get(pageIndex);
  if (!document || !canvas || !renderPages.value.has(pageIndex)) return;
  cancelRender(pageIndex);
  const page = await document.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: props.zoom });
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.floor(viewport.width * pixelRatio);
  canvas.height = Math.floor(viewport.height * pixelRatio);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  const context = canvas.getContext('2d');
  if (!context) return;
  const task = page.render({
    canvasContext: context,
    viewport,
    transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
  });
  renderTasks.set(pageIndex, task);
  try {
    await task.promise;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'RenderingCancelledException') throw error;
  } finally {
    if (renderTasks.get(pageIndex) === task) renderTasks.delete(pageIndex);
  }
}

function setCanvas(pageIndex: number, element: unknown) {
  if (element instanceof HTMLCanvasElement) {
    canvases.set(pageIndex, element);
    void renderPage(pageIndex);
  } else {
    canvases.delete(pageIndex);
    cancelRender(pageIndex);
  }
}

async function loadPdf(blob?: Blob) {
  loadGeneration += 1;
  const generation = loadGeneration;
  cancelAllRenders();
  canvases.clear();
  await loadingTask?.destroy();
  loadingTask = undefined;
  await pdf.value?.destroy();
  pdf.value = undefined;
  measuredMetrics.value = [];
  if (!blob) return;

  try {
    const data = new Uint8Array(await blob.arrayBuffer());
    const task = getDocument({ data });
    loadingTask = task;
    const document = await task.promise;
    if (generation !== loadGeneration) {
      await document.destroy();
      return;
    }
    pdf.value = document;
    const nextMetrics: PdfPageMetric[] = [];
    for (let pageIndex = 0; pageIndex < document.numPages; pageIndex += 1) {
      const page = await document.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 1 });
      nextMetrics.push({ width: viewport.width, height: viewport.height });
    }
    measuredMetrics.value = nextMetrics;
    emit('loaded', { pageCount: document.numPages, pageMetrics: nextMetrics });
    await nextTick();
    await Promise.all([...renderPages.value].map((pageIndex) => renderPage(pageIndex)));
  } catch (error) {
    if (generation === loadGeneration) emit('error', error instanceof Error ? error.message : '无法加载 PDF');
  }
}

function pageTop(pageIndex: number): number {
  let top = 0;
  for (let index = 0; index < pageIndex; index += 1) top += metricFor(index).height * props.zoom + 18;
  return top;
}

function updateVisiblePages() {
  const element = scroller.value;
  if (!element || props.visiblePages) return;
  const center = element.scrollTop + element.clientHeight / 2;
  let nearest = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let pageIndex = 0; pageIndex < effectivePageCount.value; pageIndex += 1) {
    const metric = metricFor(pageIndex);
    const pageCenter = pageTop(pageIndex) + metric.height * props.zoom / 2;
    const candidateDistance = Math.abs(pageCenter - center);
    if (candidateDistance < distance) {
      nearest = pageIndex;
      distance = candidateDistance;
    }
  }
  internalVisible.value = [nearest];
  if (currentPage.value !== nearest) {
    currentPage.value = nearest;
    emit('page-change', nearest);
  }
}

function onScroll() {
  updateVisiblePages();
  const element = scroller.value;
  if (element) emit('scroll', { side: props.side, scrollTop: element.scrollTop, viewportHeight: element.clientHeight });
}

function nearestUnit(pageIndex: number, x: number, y: number): string | undefined {
  let best: { id: string; distance: number } | undefined;
  for (const unit of props.unitGeometry) {
    const page = unit.rects.find((set) => set.page === pageIndex);
    for (const rect of page?.rects ?? []) {
      const centerX = rect.x + rect.w / 2;
      const centerY = rect.y + rect.h / 2;
      const inside = x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
      const distance = inside ? 0 : Math.hypot(centerX - x, centerY - y);
      if (!best || distance < best.distance) best = { id: unit.id, distance };
    }
  }
  return best?.id;
}

function onPageClick(pageIndex: number, event: MouseEvent) {
  const target = event.currentTarget as HTMLElement;
  const bounds = target.getBoundingClientRect();
  const unitId = nearestUnit(pageIndex, (event.clientX - bounds.left) / props.zoom, (event.clientY - bounds.top) / props.zoom);
  if (unitId) emit('unit-click', unitId, props.side);
}

function scrollToPosition(scrollTop: number) {
  if (scroller.value) scroller.value.scrollTop = Math.max(0, scrollTop);
}

function scrollToPage(pageIndex: number) {
  scrollToPosition(pageTop(Math.max(0, Math.min(pageIndex, effectivePageCount.value - 1))));
  updateVisiblePages();
}

watch(() => props.pdfBlob, (blob) => { void loadPdf(blob); }, { immediate: true });
watch([renderPages, () => props.zoom], async () => {
  cancelAllRenders();
  await nextTick();
  await Promise.all([...renderPages.value].map((pageIndex) => renderPage(pageIndex)));
});

onBeforeUnmount(() => {
  loadGeneration += 1;
  cancelAllRenders();
  void loadingTask?.destroy();
  void pdf.value?.destroy();
});

defineExpose({ scrollToPosition, scrollToPage, getScroller: () => scroller.value });
</script>

<template>
  <section class="pdf-pane" :data-pdf-side="side">
    <header class="pane-heading">
      <strong>{{ title }}</strong>
      <span>第 {{ Math.min(currentPage + 1, Math.max(1, effectivePageCount)) }} / {{ effectivePageCount }} 页</span>
    </header>
    <div ref="scroller" class="pdf-scroller" @scroll.passive="onScroll">
      <div class="page-stack">
        <article
          v-for="pageIndex in effectivePageCount"
          :key="pageIndex - 1"
          :data-page="pageIndex - 1"
          class="pdf-page"
          :class="{ 'is-spacer': !renderPages.has(pageIndex - 1) }"
          :style="pageStyle(pageIndex - 1)"
          @click="onPageClick(pageIndex - 1, $event)"
        >
          <canvas
            v-if="renderPages.has(pageIndex - 1)"
            :ref="(element) => setCanvas(pageIndex - 1, element)"
            :aria-label="`${title}第 ${pageIndex} 页`"
          />
          <AlignmentOverlay
            v-if="activeRectsFor(pageIndex - 1).length"
            :rects="activeRectsFor(pageIndex - 1)"
            :zoom="zoom"
          />
        </article>
      </div>
    </div>
  </section>
</template>

<style scoped>
.pdf-pane {
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #d9e1ea;
  border-radius: 12px;
  background: #e9eef4;
}

.pane-heading {
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 14px;
  border-bottom: 1px solid #d9e1ea;
  background: #fff;
  color: #334155;
  font-size: 13px;
}

.pdf-scroller {
  flex: 1;
  overflow: auto;
  overscroll-behavior: contain;
}

.page-stack {
  min-width: max-content;
  padding: 18px;
}

.pdf-page {
  position: relative;
  margin: 0 auto 18px;
  overflow: hidden;
  background: #fff;
  box-shadow: 0 2px 10px rgba(15, 23, 42, 0.14);
}

.pdf-page canvas {
  display: block;
}

.pdf-page.is-spacer::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(110deg, #fff 25%, #f8fafc 45%, #fff 65%);
}
</style>
