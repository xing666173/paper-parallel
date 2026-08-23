<script setup lang="ts">
const nav = [
  { to: '/', label: '首页' },
  { to: '/setup', label: '设置' },
  { to: '/workbench', label: '工作台' },
  { to: '/reader', label: '阅读器' },
  { to: '/review', label: '审核' },
];
</script>

<template>
  <div class="app">
    <header class="topbar">
      <strong>论文双子 <small>Paper Parallel</small></strong>
      <nav>
        <router-link v-for="n in nav" :key="n.to" :to="n.to">{{ n.label }}</router-link>
      </nav>
    </header>
    <router-view />
  </div>
</template>

<style scoped>
.app { font-family: 'Microsoft YaHei', system-ui, sans-serif; }
.topbar { display: flex; align-items: center; gap: 18px; background: #101828; color: #fff; padding: 10px 18px; }
.topbar strong { font-size: 15px; }
.topbar small { font-weight: 400; color: #9cc7ff; font-size: 11px; }
nav { display: flex; gap: 6px; }
nav a { color: #cbd5e1; text-decoration: none; font-size: 13px; padding: 4px 10px; border-radius: 4px; }
nav a.router-link-active { background: #1f3a5f; color: #fff; }
</style>
