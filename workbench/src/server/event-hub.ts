import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

import type { WorkbenchEvent } from "../shared/contracts.ts";
import type { PairingService } from "./pairing.ts";
import type { ProjectStore } from "./project-store.ts";

export interface ProjectEventHubOptions {
  heartbeatMs?: number;
  maxEventBytes?: number;
}

interface Client {
  socket: WebSocket;
  projectId: string;
  resumed: boolean;
  alive: boolean;
}

export class ProjectEventHub {
  private readonly server: Server;
  private readonly projects: ProjectStore;
  private readonly pairing: PairingService;
  private readonly clients = new Set<Client>();
  private readonly webSockets: WebSocketServer;
  private readonly maxEventBytes: number;
  private readonly heartbeat: NodeJS.Timeout;
  private readonly unsubscribe: () => void;
  private readonly upgradeHandler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

  constructor(
    server: Server,
    projects: ProjectStore,
    pairing: PairingService,
    options: ProjectEventHubOptions = {},
  ) {
    this.server = server;
    this.projects = projects;
    this.pairing = pairing;
    this.maxEventBytes = options.maxEventBytes ?? 1024 * 1024;
    this.webSockets = new WebSocketServer({ noServer: true, maxPayload: this.maxEventBytes });
    this.upgradeHandler = (request, socket, head) => this.upgrade(request, socket, head);
    server.on("upgrade", this.upgradeHandler);
    this.unsubscribe = projects.subscribe((event) => this.publish(event));
    this.heartbeat = setInterval(() => this.pingClients(), options.heartbeatMs ?? 20_000);
    this.heartbeat.unref();
  }

  publish(event: WorkbenchEvent): void {
    const message = serialize({ type: "event", event }, this.maxEventBytes);
    for (const client of this.clients) {
      if (client.projectId === event.projectId && client.resumed && client.socket.readyState === client.socket.OPEN) {
        client.socket.send(message);
      }
    }
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    this.unsubscribe();
    this.server.off("upgrade", this.upgradeHandler);
    for (const client of this.clients) client.socket.close(1001, "Workbench stopping");
    this.clients.clear();
    await new Promise<void>((resolve) => this.webSockets.close(() => resolve()));
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "/", "http://workbench.local");
    const match = /^\/api\/projects\/([^/]+)\/events\/ws$/.exec(url.pathname);
    if (!match?.[1]) return rejectUpgrade(socket, 404, "Not Found");
    const projectId = decodeURIComponent(match[1]);
    const raw = url.searchParams.get("token") ?? tokenFromCookie(request.headers.cookie);
    try {
      if (!raw) throw new Error("Missing token");
      this.pairing.authorize(raw, projectId, "view");
    } catch {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    this.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      const client: Client = { socket: webSocket, projectId, resumed: false, alive: true };
      this.clients.add(client);
      webSocket.on("pong", () => { client.alive = true; });
      webSocket.once("message", (data) => this.resume(client, data));
      webSocket.on("close", () => this.clients.delete(client));
      webSocket.on("error", () => this.clients.delete(client));
    });
  }

  private resume(client: Client, raw: RawData): void {
    try {
      const message = JSON.parse(raw.toString()) as { type?: unknown; after?: unknown };
      if (message.type !== "resume" || !Number.isSafeInteger(message.after) || (message.after as number) < 0) {
        throw new Error("Invalid resume request");
      }
      for (const event of this.projects.eventsAfter(client.projectId, message.after as number)) {
        client.socket.send(serialize({ type: "event", event }, this.maxEventBytes));
      }
      client.resumed = true;
      client.socket.send(serialize({ type: "ready" }, this.maxEventBytes));
    } catch (error) {
      client.socket.close(1008, error instanceof Error ? error.message : "Invalid resume request");
    }
  }

  private pingClients(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.socket.terminate();
        this.clients.delete(client);
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }
}

function serialize(value: unknown, maxBytes: number): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > maxBytes) throw new Error(`Workbench event exceeds ${maxBytes} bytes`);
  return serialized;
}

function tokenFromCookie(cookie: string | undefined): string | null {
  if (!cookie) return null;
  for (const item of cookie.split(";")) {
    const [name, ...parts] = item.trim().split("=");
    if (name === "workbench_session") return decodeURIComponent(parts.join("="));
  }
  return null;
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}
