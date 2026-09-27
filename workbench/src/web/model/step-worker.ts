/// <reference lib="webworker" />
import occtFactory from "occt-import-js";
import wasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";

const MAX_STEP_BYTES = 128 * 1024 * 1024;

self.onmessage = (event: MessageEvent<{ id: string; bytes: ArrayBuffer }>) => {
  void convert(event.data.id, event.data.bytes);
};

async function convert(id: string, bytes: ArrayBuffer): Promise<void> {
  try {
    if (bytes.byteLength > MAX_STEP_BYTES) throw new Error(`STEP file exceeds ${MAX_STEP_BYTES} bytes`);
    const occt = await occtFactory({ locateFile: () => wasmUrl });
    const result = occt.ReadStepFile(new Uint8Array(bytes), {
      linearUnit: "millimeter",
      linearDeflectionType: "absolute_value",
      linearDeflection: 0.05,
      angularDeflection: 0.5,
    });
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
}

export {};
