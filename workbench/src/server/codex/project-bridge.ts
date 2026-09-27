import type { CodexClient } from "./client.ts";
import type { CodexEvent, CodexTurnCompletion } from "./protocol.ts";
import type { ProjectStore } from "../project-store.ts";

export class CodexProjectBridge {
  private readonly client: CodexClient;
  private readonly projects: ProjectStore;
  private readonly projectByThread = new Map<string, string>();
  private readonly resumed = new Set<string>();
  private readonly activeProjects = new Set<string>();

  constructor(client: CodexClient, projects: ProjectStore) {
    this.client = client;
    this.projects = projects;
    for (const project of projects.list()) if (project.codexThreadId) this.projectByThread.set(project.codexThreadId, project.id);
  }

  async submit(projectId: string, text: string): Promise<{ threadId: string; turnId: string; clientUserMessageId: string }> {
    const message = text.trim();
    if (!message || message.length > 100_000) throw new Error("Chat message must contain 1 to 100000 characters");
    if (this.activeProjects.has(projectId)) throw new Error("A Codex turn is already active for this project");
    this.activeProjects.add(projectId);
    let project = this.projects.get(projectId);
    if (!project) { this.activeProjects.delete(projectId); throw new Error(`Project not found: ${projectId}`); }
    this.projects.appendCodexEvent(projectId, { kind: "user.message", text: message });
    try {
      let threadId = project.codexThreadId;
      if (!threadId) {
        const thread = await this.client.startThread({ cwd: project.workspacePath });
        project = this.projects.bindCodexThread(projectId, project.revision, thread.id);
        threadId = thread.id;
        this.resumed.add(threadId);
      } else if (!this.resumed.has(threadId)) {
        await this.client.resumeThread(threadId);
        this.resumed.add(threadId);
      }
      this.projectByThread.set(threadId, projectId);
      const turn = await this.client.startTurn(threadId, [{ type: "text", text: message }]);
      this.projects.appendCodexEvent(projectId, { kind: "turn.started", threadId, turnId: turn.id, clientUserMessageId: turn.clientUserMessageId });
      void turn.completed.then((completion) => this.complete(projectId, completion)).catch((error: unknown) => {
        this.projects.appendCodexEvent(projectId, { kind: "turn.failed", threadId, turnId: turn.id, error: error instanceof Error ? error.message : String(error) });
      }).finally(() => this.activeProjects.delete(projectId));
      return { threadId, turnId: turn.id, clientUserMessageId: turn.clientUserMessageId };
    } catch (error) {
      this.activeProjects.delete(projectId);
      this.projects.appendCodexEvent(projectId, { kind: "turn.failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  handleEvent(event: CodexEvent): void {
    const threadId = findThreadId(event);
    if (!threadId) return;
    const projectId = this.projectByThread.get(threadId);
    if (!projectId) return;
    this.projects.appendCodexEvent(projectId, JSON.parse(JSON.stringify(event)) as Record<string, unknown>);
  }

  respondToApproval(requestId: string | number, result: unknown): void {
    this.client.respondToApproval(requestId, result);
  }

  private complete(projectId: string, completion: CodexTurnCompletion): void {
    this.projects.appendCodexEvent(projectId, { kind: "turn.completed", ...completion });
  }
}

function findThreadId(event: CodexEvent): string | undefined {
  if (typeof event.params !== "object" || event.params === null) return undefined;
  const params = event.params as Record<string, unknown>;
  if (typeof params.threadId === "string") return params.threadId;
  if (typeof params.thread === "object" && params.thread !== null && typeof (params.thread as Record<string, unknown>).id === "string") return (params.thread as Record<string, unknown>).id as string;
  return undefined;
}
