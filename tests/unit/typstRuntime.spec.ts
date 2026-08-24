import { describe, expect, it } from 'vitest';
import { getTypstRuntimePaths } from '../../src/core/typst/runtimePaths';

describe('Typst runtime paths', () => {
  it('honors a GitHub Pages subpath', () => {
    expect(getTypstRuntimePaths('/paper-parallel/')).toEqual({
      compilerWasm: '/paper-parallel/vendor/typst/typst_ts_web_compiler_bg.wasm',
      rendererWasm: '/paper-parallel/vendor/typst/typst_ts_renderer_bg.wasm',
    });
  });

  it('normalizes a relative Vite base', () => {
    expect(getTypstRuntimePaths('./')).toEqual({
      compilerWasm: './vendor/typst/typst_ts_web_compiler_bg.wasm',
      rendererWasm: './vendor/typst/typst_ts_renderer_bg.wasm',
    });
  });
});
