<script setup lang="ts">
const cards = [
  { to: '/setup', title: '设置 DeepSeek', desc: 'API Key 仅存本机 localStorage', badge: '先做' },
  { to: '/workbench', title: '翻译工作台', desc: '上传英文/中文 PDF,端到端流水线', badge: '核心' },
  { to: '/reader', title: '对照阅读器', desc: '双向同步滚动 + 句级/词级高亮', badge: '核心' },
  { to: '/review', title: '二次审核', desc: '规则/AI 问题清单与人工门禁', badge: '导出前' },
];
</script>

<template>
  <main class="home">
    <h1>论文双子 <span>Paper Parallel</span></h1>
    <p class="sub">中英双语 PDF 对照阅读器 · 纯静态 · 本地优先</p>
    <div class="grid">
      <router-link v-for="c in cards" :key="c.to" :to="c.to" class="card">
        <span class="badge">{{ c.badge }}</span>
        <h2>{{ c.title }}</h2>
        <p>{{ c.desc }}</p>
      </router-link>
    </div>
    <p class="tip">
      端到端浏览器运行器(无需构建):<a href="./probes/P19-e2e-runner.html" target="_blank">打开 P19</a>
    </p>
  </main>
</template>

<style scoped>
.home { max-width: 900px; margin: 40px auto; padding: 0 20px; font-family: 'Microsoft YaHei', system-ui, sans-serif; }
h1 { margin: 0; font-size: 28px; }
h1 span { font-size: 14px; color: #5b6b7c; font-weight: 400; }
.sub { color: #5b6b7c; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; margin: 24px 0; }
.card { position: relative; display: block; border: 1px solid #d8dee6; border-radius: 8px; padding: 14px; background: #fff; color: inherit; text-decoration: none; }
.card h2 { margin: 8px 0 6px; font-size: 15px; }
.card p { margin: 0; font-size: 12px; color: #5b6b7c; }
.badge { position: absolute; top: 10px; right: 10px; font-size: 10px; background: #0f4c81; color: #fff; padding: 2px 8px; border-radius: 10px; }
.tip { color: #8a97a5; font-size: 12px; }
</style>
