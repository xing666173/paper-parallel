<script setup lang="ts">
import ReaderView from '../components/reader/ReaderView.vue';
import type { ReaderBlock, ReaderSpan } from '../core/reader/index';

const enBlocks: ReaderBlock[] = [
  { id: 'ep1', pageIndex: 0, rect: { y: 120, h: 90 }, type: 'title', text: 'A High-Performance Accelerator for ZKVM Trace Generation' },
  { id: 'ep2', pageIndex: 0, rect: { y: 260, h: 140 }, type: 'paragraph', text: 'We propose a hardware accelerator for trace generation. The proposed architecture reduces memory traffic.' },
  { id: 'ep3', pageIndex: 1, rect: { y: 150, h: 120 }, type: 'section', text: '2 Background' },
  { id: 'ep4', pageIndex: 1, rect: { y: 300, h: 140 }, type: 'paragraph', text: 'Prior work uses GPUs for multi-scalar multiplication.' },
];
const zhBlocks: ReaderBlock[] = [
  { id: 'zp1', pageIndex: 0, rect: { y: 130, h: 70 }, type: 'title', text: '面向零知识虚拟机轨迹生成的高性能异构加速器' },
  { id: 'zp2', pageIndex: 0, rect: { y: 240, h: 160 }, type: 'paragraph', text: '我们为执行轨迹生成提出一种硬件加速器。所提架构减少了内存访问。' },
  { id: 'zp3', pageIndex: 1, rect: { y: 160, h: 90 }, type: 'section', text: '2 背景' },
  { id: 'zp4', pageIndex: 1, rect: { y: 280, h: 160 }, type: 'paragraph', text: '已有工作使用 GPU 进行多标量乘法。' },
];
const units = [
  { enBlockIds: ['ep1'], zhBlockIds: ['zp1'] },
  { enBlockIds: ['ep2'], zhBlockIds: ['zp2'] },
  { enBlockIds: ['ep3'], zhBlockIds: ['zp3'] },
  { enBlockIds: ['ep4'], zhBlockIds: ['zp4'] },
];
const spans: ReaderSpan[] = [
  { en: 'hardware accelerator', zh: '硬件加速器', enBlockId: 'ep2', zhBlockId: 'zp2' },
  { en: 'trace generation', zh: '执行轨迹生成', enBlockId: 'ep2', zhBlockId: 'zp2' },
];
</script>

<template>
  <main class="reader-page">
    <h1>对照阅读器(合成演示)</h1>
    <p class="note">滚动任意一侧同步;点击右侧黄色词,左侧对应英文高亮。</p>
    <ReaderView :en-blocks="enBlocks" :zh-blocks="zhBlocks" :units="units" :spans="spans" :page-h="1000" :viewport-h="380" />
  </main>
</template>

<style scoped>
.reader-page { max-width: 1100px; margin: 24px auto; padding: 0 16px; font-family: 'Microsoft YaHei', system-ui, sans-serif; }
h1 { font-size: 20px; }
.note { color: #5b6b7c; font-size: 12px; }
</style>
