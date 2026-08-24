import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// base:'./' 适配 GitHub Pages 任意子路径部署
export default defineConfig({
  worker: { format: 'es' },
  plugins: [
    vue(),
    {
      name: 'serve-and-copy-local-typst-runtime',
      configureServer(server) {
        const vendorFiles = new Map([
          ['/vendor/typst/typst_ts_web_compiler_bg.wasm', {
            path: join('node_modules', '@myriaddreamin', 'typst-ts-web-compiler', 'pkg', 'typst_ts_web_compiler_bg.wasm'),
            type: 'application/wasm',
          }],
          ['/vendor/typst/typst_ts_renderer_bg.wasm', {
            path: join('node_modules', '@myriaddreamin', 'typst-ts-renderer', 'pkg', 'typst_ts_renderer_bg.wasm'),
            type: 'application/wasm',
          }],
          ['/vendor/typst/noto-serif-sc-400.woff', {
            path: join('node_modules', '@fontsource', 'noto-serif-sc', 'files', 'noto-serif-sc-chinese-simplified-400-normal.woff'),
            type: 'font/woff',
          }],
        ]);
        server.middlewares.use((request, response, next) => {
          const vendor = vendorFiles.get(request.url?.split('?')[0] ?? '');
          if (!vendor) return next();
          response.setHeader('Content-Type', vendor.type);
          response.end(readFileSync(vendor.path));
        });
      },
      closeBundle() {
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
        copyFileSync(
          join('node_modules', '@fontsource', 'noto-serif-sc', 'files', 'noto-serif-sc-chinese-simplified-400-normal.woff'),
          join(typstVendor, 'noto-serif-sc-400.woff'),
        );
      },
    },
  ],
  base: './',
});
