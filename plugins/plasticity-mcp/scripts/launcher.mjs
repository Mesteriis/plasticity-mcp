import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const target = {
  plasticity: "scripts/run-server.ts",
  workbench: "workbench/scripts/run-mcp.ts",
}[process.argv[2]];

if (!target) {
  process.stderr.write("Unknown Plasticity MCP server.\n");
  process.exit(2);
}

try {
  const root = (await readFile(join(homedir(), ".plasticity-mcp", "codex-repository"), "utf8")).trim();
  if (!root) throw new Error("Repository path is empty");
  process.chdir(root);
  if (process.argv[2] === "plasticity") process.argv.push("--compact-tools");
  await import(pathToFileURL(join(root, target)).href);
} catch (error) {
  process.stderr.write(`Plasticity MCP could not start: ${error instanceof Error ? error.message : String(error)}\nRun npm run setup:codex in the repository and try again.\n`);
  process.exitCode = 1;
}
