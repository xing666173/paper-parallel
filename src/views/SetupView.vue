<script setup lang="ts">
import { ref } from 'vue';
import { chatCompletion } from '../core/translate/index';

const baseUrl = ref('https://api.deepseek.com');
const apiKey = ref(localStorage.getItem('paper-parallel.dsKey') || '');
const model = ref('deepseek-chat');
const saveKey = ref(Boolean(apiKey.value));
const status = ref('');
const testing = ref(false);

function persist() {
  if (saveKey.value && apiKey.value.trim()) localStorage.setItem('paper-parallel.dsKey', apiKey.value.trim());
  else localStorage.removeItem('paper-parallel.dsKey');
}

async function testConnection() {
  persist();
  testing.value = true;
  status.value = '测试中…';
  try {
    const r = await chatCompletion({
      baseUrl: baseUrl.value,
      apiKey: apiKey.value.trim(),
      model: model.value.trim() || 'deepseek-chat',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 1,
    });
    status.value = `✅ 连通成功,模型返回:${r.content.slice(0, 30)}`;
  } catch (e) {
    status.value = `❌ ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <main class="setup">
    <h1>设置 DeepSeek</h1>
    <p class="note">Key 只保存在本机浏览器 localStorage,不会上传到任何服务器。</p>
    <label>Base URL<input v-model="baseUrl" type="text"></label>
    <label>模型<input v-model="model" type="text"></label>
    <label>API Key<input v-model="apiKey" type="password" placeholder="sk-..."></label>
    <label class="inline"><input v-model="saveKey" type="checkbox"> 保存到本机</label>
    <button :disabled="testing" @click="testConnection">{{ testing ? '测试中…' : '测试连接' }}</button>
    <p class="status">{{ status }}</p>
  </main>
</template>

<style scoped>
.setup { max-width: 520px; margin: 40px auto; padding: 0 20px; font-family: 'Microsoft YaHei', system-ui, sans-serif; }
h1 { font-size: 22px; }
.note { color: #5b6b7c; font-size: 12px; }
label { display: block; margin: 12px 0 4px; font-size: 13px; color: #5b6b7c; }
input { width: 100%; padding: 8px 10px; border: 1px solid #d8dee6; border-radius: 5px; font-size: 13px; }
.inline { display: flex; align-items: center; gap: 6px; }
.inline input { width: auto; }
button { margin-top: 14px; padding: 8px 18px; border: 0; border-radius: 5px; background: #0f4c81; color: #fff; font-size: 13px; cursor: pointer; }
.status { margin-top: 12px; font-size: 13px; color: #1c2733; white-space: pre-wrap; }
</style>
