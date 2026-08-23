import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// base:'./' 适配 GitHub Pages 任意子路径部署
export default defineConfig({
  plugins: [vue()],
  base: './',
});
