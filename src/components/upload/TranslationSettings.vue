<script setup lang="ts">
import type { DeepSeekModel } from '../../core/translate/client';

defineProps<{
  models: DeepSeekModel[];
  modelValue: string;
  thinkingMode: 'enabled' | 'disabled';
  apiKey: string;
  saveKey: boolean;
  testing: boolean;
  connectionStatus: 'idle' | 'success' | 'error';
}>();

defineEmits<{
  'update:modelValue': [value: string];
  'update:thinkingMode': [value: 'enabled' | 'disabled'];
  'update:apiKey': [value: string];
  'update:saveKey': [value: boolean];
  'test-connection': [];
}>();
</script>

<template>
  <section class="upload-block settings-block">
    <div class="section-heading">
      <span class="section-index">2</span>
      <div>
        <h2>选择翻译模型</h2>
        <p>连接 DeepSeek 并设置本次翻译方式</p>
      </div>
    </div>
    <div class="settings-grid">
      <label class="field">
        <span>模型</span>
        <select :value="modelValue" @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)">
          <option v-for="model in models" :key="model.id" :value="model.id">{{ model.label }}</option>
        </select>
      </label>
      <label class="field">
        <span>思考模式</span>
        <select
          :value="thinkingMode"
          @change="$emit('update:thinkingMode', ($event.target as HTMLSelectElement).value as 'enabled' | 'disabled')"
        >
          <option value="disabled">关闭</option>
          <option value="enabled">开启</option>
        </select>
      </label>
      <label class="field api-field">
        <span>API Key</span>
        <input
          data-field="api-key"
          type="password"
          autocomplete="off"
          placeholder="sk-..."
          :value="apiKey"
          @input="$emit('update:apiKey', ($event.target as HTMLInputElement).value)"
        >
      </label>
    </div>
    <div class="connection-row">
      <label class="check-field">
        <input
          type="checkbox"
          :checked="saveKey"
          @change="$emit('update:saveKey', ($event.target as HTMLInputElement).checked)"
        >
        <span>在本机保存 Key</span>
      </label>
      <button
        class="button secondary"
        data-action="test-connection"
        type="button"
        :disabled="testing || !apiKey.trim()"
        @click="$emit('test-connection')"
      >
        {{ testing ? '正在测试…' : '测试连接' }}
      </button>
      <span v-if="connectionStatus === 'success'" class="connection-state success">连接成功</span>
      <span v-else-if="connectionStatus === 'error'" class="connection-state error">连接失败</span>
    </div>
  </section>
</template>
