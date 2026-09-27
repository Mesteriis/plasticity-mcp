import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
await run(process.platform === "win32" ? "npm.cmd" : "npm", ["--workspace", "workbench", "run", "build"]);
const child = spawn(process.execPath, [resolve(root, "workbench/src/server/main.ts"), ...process.argv.slice(2)], { cwd: root, stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => child.kill(signal));
const code = await new Promise<number>((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (exitCode) => resolveExit(exitCode ?? 1));
});
process.exitCode = code;

async function run(command: string, args: string[]): Promise<void> {
  const code = await new Promise<number>((resolveExit, reject) => {
    const process = spawn(command, args, { cwd: root, stdio: "inherit", env: globalThis.process.env });
    process.once("error", reject);
    process.once("exit", (exitCode) => resolveExit(exitCode ?? 1));
  });
  if (code !== 0) throw new Error(`${command} exited with code ${code}`);
}
