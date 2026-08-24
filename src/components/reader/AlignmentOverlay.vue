<script setup lang="ts">
import type { Rect } from '../../types/models';

defineProps<{
  rects: Rect[];
  zoom: number;
}>();
</script>

<template>
  <div
    data-alignment-overlay
    class="alignment-overlay"
    style="pointer-events: none"
    aria-hidden="true"
  >
    <span
      v-for="(rect, index) in rects"
      :key="index"
      class="alignment-fragment"
      :style="{
        left: `${rect.x * zoom}px`,
        top: `${rect.y * zoom}px`,
        width: `${rect.w * zoom}px`,
        height: `${rect.h * zoom}px`,
      }"
    />
  </div>
</template>

<style scoped>
.alignment-overlay {
  position: absolute;
  inset: 0;
  z-index: 3;
}

.alignment-fragment {
  position: absolute;
  box-sizing: border-box;
  border: 1.5px solid rgba(37, 99, 235, 0.88);
  border-radius: 2px;
  background: rgba(59, 130, 246, 0.13);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.55) inset;
}
</style>
