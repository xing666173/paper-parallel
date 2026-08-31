<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { compileTypstProject } from '../../core/typst/compiler';
import { getTypstRuntimePaths } from '../../core/typst/runtimePaths';

const stage = ref<'loading' | 'compiling' | 'compiled' | 'failed'>('loading');
const errorMessage = ref('');
const pdfUrl = ref('');

onMounted(async () => {
  try {
    const mainResponse = await fetch('/__prototype/main.typ');
    if (!mainResponse.ok) throw new Error(`Prototype Typst source unavailable: ${mainResponse.status}`);
    const mainContent = await mainResponse.text();
    const assetPaths = [...new Set([...mainContent.matchAll(/"(\/assets\/[^"]+)"/g)]
      .map((match) => match[1]!))];
    const files = new Map<string, Uint8Array>();
    files.set('/main.typ', new TextEncoder().encode(mainContent));
    files.set('/paper-parallel.json', new TextEncoder().encode(JSON.stringify({ version: 1 })));
    for (const assetPath of assetPaths) {
      const response = await fetch(`/__prototype${assetPath}`);
      if (!response.ok) throw new Error(`Prototype asset unavailable: ${assetPath}`);
      files.set(assetPath, new Uint8Array(await response.arrayBuffer()));
    }
    stage.value = 'compiling';
    const result = await compileTypstProject({
      mainContent,
      files,
      markerIds: [],
      regionIds: [],
    }, {
      runtimePaths: getTypstRuntimePaths(import.meta.env.BASE_URL, document.baseURI),
    });
    pdfUrl.value = URL.createObjectURL(new Blob([result.pdf], { type: 'application/pdf' }));
    stage.value = 'compiled';
  } catch (error) {
    stage.value = 'failed';
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
});

onBeforeUnmount(() => {
  if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value);
});
</script>

<template>
  <main class="route-placeholder" :data-stage="stage">
    <h1>单栏 Typst 样稿</h1>
    <p>阶段：{{ stage }}</p>
    <p v-if="errorMessage" role="alert">{{ errorMessage }}</p>
    <a v-if="pdfUrl" :href="pdfUrl" download="zktracer-single-column-prototype.pdf">下载 PDF</a>
  </main>
</template>
