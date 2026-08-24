<script setup lang="ts">
import { useRoute } from 'vue-router';
const route = useRoute();
</script>

<template>
  <main class="route-placeholder">
    <p class="eyebrow">BILINGUAL READER</p>
    <h1>对照阅读</h1>
    <p>任务 {{ route.params.projectId }}</p>
    <RouterLink :to="{ name: 'process', params: { projectId: route.params.projectId } }">返回翻译任务</RouterLink>
  </main>
</template>
