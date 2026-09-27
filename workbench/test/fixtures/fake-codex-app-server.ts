import { appendFileSync } from "node:fs";

const mode = process.argv[2] ?? "--complete-turn";
const logPath = process.argv[3];
let buffered = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffered += chunk;
  while (true) {
    const newline = buffered.indexOf("\n");
    if (newline < 0) return;
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> };
    if (logPath) appendFileSync(logPath, `${message.method}\n`);
    if (message.id === undefined) {
      if (message.method === "initialized" && mode === "--malformed-after-init") process.stdout.write("not-json\n");
      continue;
    }
    if (message.method === "initialize") {
      send({ id: message.id, result: { userAgent: "fake-codex/1", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    } else if (message.method === "thread/start") {
      send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-1" } } });
    } else if (message.method === "thread/resume") {
      send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: String(message.params?.threadId) } } });
    } else if (message.method === "turn/start") {
      send({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-1" } } });
      if (mode === "--crash-after-turn") {
        setTimeout(() => process.exit(42), 5);
      } else {
        setTimeout(() => send({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: { threadId: message.params?.threadId, turn: { id: "turn-1", status: "completed" } },
        }), 5);
      }
    }
  }
});

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
