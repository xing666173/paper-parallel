<script setup lang="ts">
import { computed, ref } from 'vue';

const props = defineProps<{ modelValue: File | null }>();
const emit = defineEmits<{
  'update:modelValue': [file: File | null];
  error: [message: string];
}>();

const dragging = ref(false);
const filename = computed(() => props.modelValue?.name ?? '尚未选择文件');

function acceptFile(file: File | undefined): void {
  if (!file) return;
  if (file.type !== 'application/pdf' && !file.name.toLocaleLowerCase().endsWith('.pdf')) {
    emit('error', '请选择 PDF 文件');
    return;
  }
  emit('update:modelValue', file);
}

function onChange(event: Event): void {
  acceptFile((event.target as HTMLInputElement).files?.[0]);
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  acceptFile(event.dataTransfer?.files[0]);
}
</script>

<template>
  <section class="upload-block">
    <div class="section-heading">
      <span class="section-index">1</span>
      <div>
        <h2>上传英文论文</h2>
        <p>选择一份需要翻译和排版的 PDF</p>
      </div>
    </div>
    <label
      class="pdf-dropzone"
      :class="{ 'is-dragging': dragging, 'has-file': modelValue }"
      @dragenter.prevent="dragging = true"
      @dragover.prevent
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <input data-field="pdf" type="file" accept="application/pdf,.pdf" @change="onChange">
      <span class="dropzone-icon" aria-hidden="true">PDF</span>
      <strong>{{ modelValue ? '已选择论文' : '拖放 PDF 到这里' }}</strong>
      <span>{{ filename }}</span>
      <em>{{ modelValue ? '点击可更换文件' : '或点击浏览文件' }}</em>
    </label>
  </section>
</template>
