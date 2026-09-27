import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

export interface JsonRpcOptions {
  executable: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface JsonRpcRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

type NotificationListener = (method: string, params: unknown) => void;
type RequestListener = (id: string | number, method: string, params: unknown) => void;
type CloseListener = (error: Error) => void;

export class JsonRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly requestListeners = new Set<RequestListener>();
  private readonly closeListeners = new Set<CloseListener>();
  private nextId = 1;
  private stdoutBuffer = Buffer.alloc(0);
  private stderr = "";
  private failure: Error | undefined;
  private closing = false;

  constructor(options: JsonRpcOptions) {
    this.child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
    });
    this.child.on("error", (error) => this.fail(new Error(`Failed to start app-server: ${error.message}`)));
    this.child.on("exit", (code, signal) => {
      if (this.failure) return;
      if (this.closing) return;
      const detail = signal ? `signal ${signal}` : `code ${String(code)}`;
      const suffix = this.stderr.trim() ? `: ${this.stderr.trim()}` : "";
      this.fail(new Error(`app-server exited with ${detail}${suffix}`));
    });
  }

  request(method: string, params: unknown, options: JsonRpcRequestOptions = {}): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (options.signal?.aborted) return Promise.reject(abortError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onAbort = (): void => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup();
        reject(abortError());
      };
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          pending.cleanup();
          reject(new Error(`app-server request timed out after ${options.timeoutMs} ms: ${method}`));
        }, options.timeoutMs);
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(asError(error));
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  respond(id: string | number, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: string | number, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onRequest(listener: RequestListener): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  onClose(listener: CloseListener): () => void {
    this.closeListeners.add(listener);
    if (this.failure) queueMicrotask(() => listener(this.failure as Error));
    return () => this.closeListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.closing = true;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 2_000);
    await exited;
    clearTimeout(timer);
  }

  private write(message: unknown): void {
    if (this.failure) throw this.failure;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consume(chunk: Buffer): void {
    if (this.failure) return;
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    if (this.stdoutBuffer.length > MAX_LINE_BYTES && this.stdoutBuffer.indexOf(10) < 0) {
      this.fail(new Error(`app-server JSON-RPC line exceeds ${MAX_LINE_BYTES} bytes`));
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf(10);
      if (newline < 0) return;
      if (newline > MAX_LINE_BYTES) {
        this.fail(new Error(`app-server JSON-RPC line exceeds ${MAX_LINE_BYTES} bytes`));
        return;
      }
      const line = this.stdoutBuffer.subarray(0, newline).toString("utf8");
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (!line.trim()) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(new Error("app-server emitted invalid JSON"));
        return;
      }
      try {
        this.dispatch(message);
      } catch (error) {
        this.fail(asError(error));
        return;
      }
    }
  }

  private dispatch(value: unknown): void {
    if (!isRecord(value) || (value.jsonrpc !== undefined && value.jsonrpc !== "2.0")) throw new Error("Invalid app-server JSON-RPC message");
    if ("method" in value) {
      if (typeof value.method !== "string") throw new Error("Invalid app-server JSON-RPC method");
      if ("id" in value) {
        if (typeof value.id !== "number" && typeof value.id !== "string") throw new Error("Invalid app-server request ID");
        for (const listener of this.requestListeners) listener(value.id, value.method, value.params);
      } else {
        for (const listener of this.notificationListeners) listener(value.method, value.params);
      }
      return;
    }
    if (typeof value.id !== "number") throw new Error("Invalid app-server response ID");
    const pending = this.pending.get(value.id);
    if (!pending) throw new Error(`Unexpected app-server response ID ${value.id}`);
    this.pending.delete(value.id);
    pending.cleanup();
    if ("error" in value) {
      pending.reject(new Error(`app-server request failed: ${formatRpcError(value.error)}`));
    } else if ("result" in value) {
      pending.resolve(value.result);
    } else {
      throw new Error("Invalid app-server response payload");
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = this.closing ? new Error("app-server closed") : error;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(this.failure);
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener(this.failure);
    if (!this.closing && this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatRpcError(value: unknown): string {
  if (isRecord(value) && typeof value.message === "string") return value.message;
  return JSON.stringify(value);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function abortError(): Error {
  const error = new Error("app-server request aborted");
  error.name = "AbortError";
  return error;
}
