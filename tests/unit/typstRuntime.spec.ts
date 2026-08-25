import { describe, expect, it } from 'vitest';
import { getTypstRuntimePaths } from '../../src/core/typst/runtimePaths';

describe('Typst runtime paths', () => {
  it('honors a GitHub Pages subpath', () => {
    expect(getTypstRuntimePaths('/paper-parallel/')).toEqual({
      compilerWasm: '/paper-parallel/vendor/typst/typst_ts_web_compiler_bg.wasm',
      rendererWasm: '/paper-parallel/vendor/typst/typst_ts_renderer_bg.wasm',
      fontFiles: ['/paper-parallel/vendor/typst/noto-serif-sc-400.woff'],
    });
  });

  it('normalizes a relative Vite base', () => {
    expect(getTypstRuntimePaths('./')).toEqual({
      compilerWasm: './vendor/typst/typst_ts_web_compiler_bg.wasm',
      rendererWasm: './vendor/typst/typst_ts_renderer_bg.wasm',
      fontFiles: ['./vendor/typst/noto-serif-sc-400.woff'],
    });
  });

  it('anchors a relative Vite base to the deployed document before sending paths to a worker', () => {
    expect(getTypstRuntimePaths(
      './',
      'https://xing666173.github.io/paper-parallel/index.html',
    )).toEqual({
      compilerWasm: 'https://xing666173.github.io/paper-parallel/vendor/typst/typst_ts_web_compiler_bg.wasm',
      rendererWasm: 'https://xing666173.github.io/paper-parallel/vendor/typst/typst_ts_renderer_bg.wasm',
      fontFiles: ['https://xing666173.github.io/paper-parallel/vendor/typst/noto-serif-sc-400.woff'],
    });
  });

  it('does not create a protocol-relative URL at the site root', () => {
    expect(getTypstRuntimePaths('/').compilerWasm).toBe('/vendor/typst/typst_ts_web_compiler_bg.wasm');
  });
});
