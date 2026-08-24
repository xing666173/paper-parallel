<script setup lang="ts">
import { useRoute } from 'vue-router';
const route = useRoute();
</script>

<template>
  <main class="route-placeholder">
    <p class="eyebrow">TRANSLATION TASK</p>
    <h1>翻译排版</h1>
    <p>任务 {{ route.params.projectId }}</p>
    <RouterLink to="/">返回上传</RouterLink>
  </main>
</template>
