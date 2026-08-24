export interface TypstRuntimePaths {
  compilerWasm: string;
  rendererWasm: string;
  fontFiles: string[];
}

export function getTypstRuntimePaths(baseUrl: string): TypstRuntimePaths {
  const trimmed = baseUrl.replace(/^\/+|\/+$/g, '');
  const base = baseUrl === './' ? './' : trimmed ? `/${trimmed}/` : '/';
  return {
    compilerWasm: `${base}vendor/typst/typst_ts_web_compiler_bg.wasm`,
    rendererWasm: `${base}vendor/typst/typst_ts_renderer_bg.wasm`,
    fontFiles: [`${base}vendor/typst/noto-serif-sc-400.woff`],
  };
}
