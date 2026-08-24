<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const activeStep = computed(() => {
  if (route.name === 'reader') return 3;
  if (route.name === 'process') return 2;
  return 1;
});
const steps = ['上传论文', '翻译排版', '对照阅读'];
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="brand">论文双子 <small>PAPER PARALLEL</small></div>
      <ol class="workflow-steps" aria-label="任务步骤">
        <li v-for="(step, index) in steps" :key="step" :class="{ 'is-active': activeStep === index + 1 }">
          <span>{{ index + 1 }}</span>{{ step }}
        </li>
      </ol>
    </header>
    <RouterView />
  </div>
</template>
