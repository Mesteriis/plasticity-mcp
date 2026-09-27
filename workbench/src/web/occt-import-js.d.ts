declare module "occt-import-js" {
  interface OcctModule { ReadStepFile(bytes: Uint8Array, options: Record<string, unknown>): unknown; }
  export default function createOcct(options?: { locateFile?(path: string): string }): Promise<OcctModule>;
}

declare module "occt-import-js/dist/occt-import-js.wasm?url" {
  const url: string;
  export default url;
}
