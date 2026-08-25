<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import fixture from '../../../tests/fixtures/typst/mixed-paper.json';
import { buildAssetManifest } from '../../core/assets/extract';
import { composeChinesePdf, type CompositionPhase } from '../../core/compose/compose';
import { createProjectRepository } from '../../core/project/repository';
import { runCompositionGate } from '../../core/quality/compositionGate';
import { compileTypstProject } from '../../core/typst/compiler';
import { getTypstRuntimePaths } from '../../core/typst/runtimePaths';

const stage = ref<'starting' | CompositionPhase | 'compiled' | 'failed'>('starting');
const errorMessage = ref('');
const previewUrl = ref('');
const pdfUrl = ref('');

function canvasBlob(label: string): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 260;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#f8fafc';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#1e4e86';
  context.lineWidth = 5;
  context.strokeRect(18, 18, canvas.width - 36, canvas.height - 36);
  context.fillStyle = '#13233b';
  context.font = 'bold 44px sans-serif';
  context.textAlign = 'center';
  context.fillText(label, canvas.width / 2, canvas.height / 2 + 15);
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('Unable to build fixture image')),
    'image/png',
  ));
}

onMounted(async () => {
  try {
    const image = await canvasBlob(fixture.assetLabel);
    const { assets } = await buildAssetManifest([{
      id: 'fig-1', kind: 'figure', pageIndex: 0,
      rect: { x: 72, y: 310, w: 468, h: 140 },
      bytes: new Uint8Array(await image.arrayBuffer()), widthMode: 'span',
      captionUnitId: 'fig-1-caption',
    }]);
    const regions = [
      { id: 'front', mode: 'full-width' as const, sourcePage: 0, bounds: { x: 72, y: 60, w: 468, h: 90 }, orderedUnitIds: ['title'] },
      { id: 'body', mode: 'double' as const, sourcePage: 0, bounds: { x: 72, y: 170, w: 468, h: 460 }, orderedUnitIds: ['body-p1', 'fig-1', 'fig-1-caption'] },
    ];
    const result = await composeChinesePdf({
      projectId: 'typst-smoke',
      metadata: { paperWidth: 612, paperHeight: 792, margin: 58, columnGap: 12 },
      regions,
      units: [
        { id: 'title', kind: 'title', layoutRegionId: 'front', order: 0, text: fixture.title },
        { id: 'body-p1', kind: 'paragraph', layoutRegionId: 'body', order: 1, targetSegments: [{ id: 'body-p1-g-1-t-1', text: fixture.body }] },
        { id: 'fig-1', kind: 'figure', layoutRegionId: 'body', order: 2, assetId: 'fig-1' },
        { id: 'fig-1-caption', kind: 'caption', layoutRegionId: 'body', order: 3, targetSegments: [{ id: 'fig-1-caption-g-1-t-1', text: fixture.caption }] },
      ],
      assets,
    }, {
      compile: (project, signal) => compileTypstProject(project, {
        runtimePaths: getTypstRuntimePaths(import.meta.env.BASE_URL, document.baseURI), signal,
      }),
      saveArtifact: (record) => createProjectRepository().putArtifact(record),
      onProgress: (event) => { stage.value = event.phase; },
    });
    const sourceHashes = Object.fromEntries(assets.map((asset) => [asset.id, asset.sha256]));
    const gate = runCompositionGate({
      pdfHeader: new TextDecoder().decode(result.pdf.slice(0, 5)),
      preview: result.svg,
      sourceAssetHashes: sourceHashes,
      targetAssetHashes: { ...sourceHashes },
      requiredMarkerIds: ['title', 'body-p1-g-1-t-1', 'fig-1', 'fig-1-caption-g-1-t-1'],
      emittedMarkerIds: result.markerIds,
      layoutRegionOrder: ['front', 'body'],
      emittedRegionOrder: regions.map((region) => region.id),
    });
    if (!gate.pass) throw new Error(gate.issues.map((issue) => issue.message).join('; '));
    previewUrl.value = URL.createObjectURL(new Blob([result.svg], { type: 'image/svg+xml' }));
    pdfUrl.value = URL.createObjectURL(new Blob([result.pdf], { type: 'application/pdf' }));
    stage.value = 'compiled';
  } catch (error) {
    stage.value = 'failed';
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
});

onBeforeUnmount(() => {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value);
});
</script>

<template>
  <main class="route-placeholder" :data-stage="stage">
    <h1 data-preview-title>{{ fixture.title }}</h1>
    <p>阶段：{{ stage }}</p>
    <p data-asset-label>{{ fixture.assetLabel }}</p>
    <p v-if="errorMessage" role="alert">{{ errorMessage }}</p>
    <object v-if="previewUrl" :data="previewUrl" type="image/svg+xml" aria-label="Typst smoke preview" />
    <a v-if="pdfUrl" :href="pdfUrl" download="paper-parallel-typst-smoke.pdf">下载 PDF</a>
  </main>
</template>
