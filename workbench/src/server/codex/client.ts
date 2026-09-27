import { randomUUID } from "node:crypto";

import {
  type CodexEvent,
  type CodexInput,
  type CodexTurnCompletion,
  codexInputSchema,
  initializeResultSchema,
  threadResultSchema,
  turnResultSchema,
} from "./protocol.ts";
import { JsonRpcProcess } from "../../../../src/codex/json-rpc.ts";

export interface CodexTurnJournal {
  requested(clientMessageId: string, threadId: string, input: CodexInput[]): void;
  started(clientMessageId: string, turnId: string): void;
  completed(clientMessageId: string): void;
  failed(clientMessageId: string, error: string): void;
}

export interface CodexClientOptions {
  executable?: string;
  args?: string[];
  cwd?: string;
  journal?: CodexTurnJournal;
  onEvent?: (event: CodexEvent) => void;
}

export interface CodexTurnHandle {
  id: string;
  clientUserMessageId: string;
  completed: Promise<CodexTurnCompletion>;
}

interface TurnWaiter {
  clientMessageId: string;
  threadId: string;
  resolve(completion: CodexTurnCompletion): void;
  reject(error: Error): void;
}

export class CodexClient {
  private readonly rpc: JsonRpcProcess;
  private readonly journal: CodexTurnJournal | undefined;
  private readonly onEvent: ((event: CodexEvent) => void) | undefined;
  private readonly turns = new Map<string, TurnWaiter>();
  private readonly earlyCompletions = new Map<string, CodexTurnCompletion>();

  private constructor(rpc: JsonRpcProcess, options: CodexClientOptions) {
    this.rpc = rpc;
    this.journal = options.journal;
    this.onEvent = options.onEvent;
    rpc.onNotification((method, params) => this.handleNotification(method, params));
    rpc.onRequest((requestId, method, params) => {
      this.onEvent?.({ type: "request", requestId, method, params });
    });
    rpc.onClose((error) => {
      for (const waiter of this.turns.values()) {
        this.journal?.failed(waiter.clientMessageId, error.message);
        waiter.reject(error);
      }
      this.turns.clear();
    });
  }

  static async start(options: CodexClientOptions = {}): Promise<CodexClient> {
    const executable = options.executable ?? "codex";
    const args = options.args ?? ["app-server", "--stdio"];
    const rpc = new JsonRpcProcess({
      executable,
      args,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: allowedEnvironment(process.env),
    });
    const client = new CodexClient(rpc, options);
    const initialized = await rpc.request("initialize", {
      clientInfo: { name: "plasticity-workbench", title: "Plasticity Workbench", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    initializeResultSchema.parse(initialized);
    rpc.notify("initialized", {});
    return client;
  }

  async startThread(input: { cwd: string }): Promise<{ id: string }> {
    const result = threadResultSchema.parse(await this.rpc.request("thread/start", {
      cwd: input.cwd,
    }));
    return { id: result.thread.id };
  }

  async resumeThread(threadId: string): Promise<{ id: string }> {
    const result = threadResultSchema.parse(await this.rpc.request("thread/resume", { threadId }));
    return { id: result.thread.id };
  }

  async startTurn(threadId: string, input: CodexInput[]): Promise<CodexTurnHandle> {
    const parsedInput = input.map((item) => codexInputSchema.parse(item));
    const clientUserMessageId = randomUUID();
    this.journal?.requested(clientUserMessageId, threadId, parsedInput);
    let result: ReturnType<typeof turnResultSchema.parse>;
    try {
      result = turnResultSchema.parse(await this.rpc.request("turn/start", {
        threadId,
        input: parsedInput,
        clientUserMessageId,
      }));
    } catch (error) {
      this.journal?.failed(clientUserMessageId, asError(error).message);
      throw error;
    }
    const turnId = result.turn.id;
    this.journal?.started(clientUserMessageId, turnId);
    let resolveCompletion!: (completion: CodexTurnCompletion) => void;
    let rejectCompletion!: (error: Error) => void;
    const completed = new Promise<CodexTurnCompletion>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    this.turns.set(turnId, {
      clientMessageId: clientUserMessageId,
      threadId,
      resolve: resolveCompletion,
      reject: rejectCompletion,
    });
    const early = this.earlyCompletions.get(turnId);
    if (early) {
      this.earlyCompletions.delete(turnId);
      this.completeTurn(early);
    }
    return { id: turnId, clientUserMessageId, completed };
  }

  respondToApproval(requestId: string | number, result: unknown): void {
    this.rpc.respond(requestId, result);
  }

  close(): Promise<void> {
    return this.rpc.close();
  }

  private handleNotification(method: string, params: unknown): void {
    this.onEvent?.({ type: "notification", method, params });
    if (method !== "turn/completed" || !isRecord(params) || !isRecord(params.turn)) return;
    if (typeof params.turn.id !== "string") return;
    const completion: CodexTurnCompletion = {
      threadId: typeof params.threadId === "string" ? params.threadId : "",
      turnId: params.turn.id,
      status: typeof params.turn.status === "string" ? params.turn.status : "completed",
    };
    if (!this.turns.has(completion.turnId)) {
      this.earlyCompletions.set(completion.turnId, completion);
      return;
    }
    this.completeTurn(completion);
  }

  private completeTurn(completion: CodexTurnCompletion): void {
    const waiter = this.turns.get(completion.turnId);
    if (!waiter) return;
    this.turns.delete(completion.turnId);
    this.journal?.completed(waiter.clientMessageId);
    waiter.resolve({ ...completion, threadId: completion.threadId || waiter.threadId });
  }
}

const ENVIRONMENT_ALLOWLIST = [
  "HOME", "CODEX_HOME", "PATH", "SHELL", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE",
] as const;

function allowedEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ENVIRONMENT_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
