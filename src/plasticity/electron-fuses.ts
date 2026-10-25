import { open } from "node:fs/promises";
import { join } from "node:path";

// Electron's v1 fuse schema: https://github.com/electron/fuses/blob/main/src/config.ts
const SENTINEL = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");
const NODE_CLI_INSPECT_INDEX = 3;
const CHUNK_SIZE = 1024 * 1024;

/** Read every fuse wire, including both slices of a universal macOS framework. */
export async function assertNodeInspectorEnabled(applicationPath: string): Promise<void> {
  const binary = join(applicationPath, "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework");
  const handle = await open(binary, "r");
  try {
    const chunk = Buffer.alloc(CHUNK_SIZE + SENTINEL.length - 1);
    let found = false;
    for (let position = 0; ; position += CHUNK_SIZE) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      const data = chunk.subarray(0, bytesRead);
      for (let offset = data.indexOf(SENTINEL); offset !== -1 && offset < CHUNK_SIZE; offset = data.indexOf(SENTINEL, offset + 1)) {
        found = true;
        const wire = Buffer.alloc(2 + 255);
        const read = await handle.read(wire, 0, wire.length, position + offset + SENTINEL.length);
        const version = wire[0];
        const count = wire[1]!;
        if (read.bytesRead < 2 || version !== 1 || count <= NODE_CLI_INSPECT_INDEX || read.bytesRead < 2 + count ||
          !wire.subarray(2, 2 + count).every((byte) => byte === 0x30 || byte === 0x31 || byte === 0x72)) {
          throw new Error("Cannot verify Plasticity's Node inspector support: unrecognized or incomplete Electron fuse wire");
        }
        const state = wire[2 + NODE_CLI_INSPECT_INDEX];
        if (state !== 0x31) {
          throw new Error("This Plasticity build disables or removes EnableNodeCliInspectArguments. The MCP launcher requires --inspect-brk support and cannot start this build with MCP access. The live-tested Plasticity version is 26.1.3. See https://github.com/Mesteriis/plasticity-mcp/issues/10");
        }
      }
      if (bytesRead <= CHUNK_SIZE) break;
    }
    if (!found) throw new Error("Cannot verify Plasticity's Node inspector support: Electron fuse wire was not found");
  } finally {
    await handle.close();
  }
}
