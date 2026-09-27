export interface WebSocketLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface CdpEnvelope {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
  params?: unknown;
}

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventListeners = new Map<string, Set<(params: unknown) => void>>();
  private closed = false;
  private readonly socket: WebSocketLike;
  private readonly timeoutMs: number;

  constructor(
    socket: WebSocketLike,
    timeoutMs = 10_000,
  ) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("close", () => this.handleClose());
    socket.addEventListener("error", () => this.handleClose());
  }

  static async connect(url: string, timeoutMs = 10_000): Promise<CdpClient> {
    const parsed = new URL(url);
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "localhost";
    if (!loopback || (parsed.protocol !== "ws:" && parsed.protocol !== "wss:")) {
      throw new Error("CDP access is restricted to loopback WebSocket URLs");
    }

    const socket = new WebSocket(parsed);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to CDP")), timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Failed to connect to CDP"));
      }, { once: true });
    });
    return new CdpClient(socket, timeoutMs);
  }

  send(method: string, params?: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.closed || this.socket.readyState !== 1) {
      return Promise.reject(new Error("CDP connection is closed"));
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(new Error("CDP request timeout must be a positive integer"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }));
    });
  }

  async captureScreenshot(timeoutMs = this.timeoutMs): Promise<string> {
    const result = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true }, timeoutMs);
    if (typeof result !== "object" || result === null || !("data" in result) || typeof result.data !== "string") {
      throw new Error("Plasticity returned no screenshot image data");
    }
    return result.data;
  }

  on(method: string, listener: (params: unknown) => void): () => void {
    const listeners = this.eventListeners.get(method) ?? new Set();
    listeners.add(listener);
    this.eventListeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  close(): void {
    this.socket.close();
    this.handleClose();
  }

  private handleMessage(event: unknown): void {
    const data = typeof event === "object" && event !== null && "data" in event ? (event as { data: unknown }).data : undefined;
    if (typeof data !== "string") return;
    let envelope: CdpEnvelope;
    try {
      envelope = JSON.parse(data) as CdpEnvelope;
    } catch {
      return;
    }
    if (envelope.id !== undefined) {
      const request = this.pending.get(envelope.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(envelope.id);
      if (envelope.error) {
        request.reject(new Error(`CDP ${envelope.error.code ?? "error"}: ${envelope.error.message ?? "unknown error"}`));
      } else {
        request.resolve(envelope.result);
      }
      return;
    }
    if (envelope.method) {
      for (const listener of this.eventListeners.get(envelope.method) ?? []) listener(envelope.params);
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("CDP connection closed before the request completed"));
    }
    this.pending.clear();
  }
}
