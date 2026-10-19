/** WebAssembly module imports handled by wrangler's CompiledWasm rule. */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

/** Binary data imports handled by wrangler's Data rule. */
declare module "*.se1" {
  const data: ArrayBuffer;
  export default data;
}

/** The patched Emscripten glue module. */
declare module "*.mjs" {
  const createModule: (options?: Record<string, unknown>) => Promise<any>;
  export default createModule;
}
