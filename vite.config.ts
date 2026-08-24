import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// base:'./' 适配 GitHub Pages 任意子路径部署
export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'copy-probes-to-dist',
      closeBundle() {
        // 把无需构建的探针与共享核心一起带进 dist,让 GitHub Pages 上的
        // /probes/P19-e2e-runner.html 等页面直接可用
        copyDir('probes', join('dist', 'probes'), new Set(['assets']));
        copyDir('src/core', join('dist', 'src', 'core'), new Set());
        const typstVendor = join('dist', 'vendor', 'typst');
        mkdirSync(typstVendor, { recursive: true });
        copyFileSync(
          join('node_modules', '@myriaddreamin', 'typst-ts-web-compiler', 'pkg', 'typst_ts_web_compiler_bg.wasm'),
          join(typstVendor, 'typst_ts_web_compiler_bg.wasm'),
        );
        copyFileSync(
          join('node_modules', '@myriaddreamin', 'typst-ts-renderer', 'pkg', 'typst_ts_renderer_bg.wasm'),
          join(typstVendor, 'typst_ts_renderer_bg.wasm'),
        );
      },
    },
  ],
  base: './',
});

function copyDir(src: string, dest: string, skip: Set<string>) {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    if (skip.has(name)) continue;
    const s = join(src, name);
    const d = join(dest, name);
    if (statSync(s).isDirectory()) copyDir(s, d, skip);
    else copyFileSync(s, d);
  }
}
