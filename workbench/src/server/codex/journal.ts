import type { DatabaseSync } from "node:sqlite";

import type { CodexTurnJournal } from "./client.ts";
import type { CodexInput } from "./protocol.ts";

export type CodexTurnState = "requested" | "started" | "completed" | "failed";

export interface CodexTurnRecord {
  clientMessageId: string;
  threadId: string;
  turnId?: string;
  input: CodexInput[];
  state: CodexTurnState;
  error?: string;
  requestedAt: string;
  updatedAt: string;
}

interface CodexTurnRow {
  client_message_id: string;
  thread_id: string;
  turn_id: string | null;
  input_json: string;
  state: CodexTurnState;
  error: string | null;
  requested_at: string;
  updated_at: string;
}

export class SqliteCodexTurnJournal implements CodexTurnJournal {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  requested(clientMessageId: string, threadId: string, input: CodexInput[]): void {
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO codex_turns (
        client_message_id, thread_id, input_json, state, requested_at, updated_at
      ) VALUES (?, ?, ?, 'requested', ?, ?)
    `).run(clientMessageId, threadId, JSON.stringify(input), now, now);
  }

  started(clientMessageId: string, turnId: string): void {
    this.update(clientMessageId, "started", turnId);
  }

  completed(clientMessageId: string): void {
    this.update(clientMessageId, "completed");
  }

  failed(clientMessageId: string, error: string): void {
    const result = this.database.prepare(`
      UPDATE codex_turns SET state = 'failed', error = ?, updated_at = ?
      WHERE client_message_id = ? AND state IN ('requested', 'started')
    `).run(error, new Date().toISOString(), clientMessageId);
    if (result.changes === 0) throw new Error(`Codex turn cannot be marked failed: ${clientMessageId}`);
  }

  failPending(error: string): number {
    const result = this.database.prepare(`
      UPDATE codex_turns SET state = 'failed', error = ?, updated_at = ?
      WHERE state IN ('requested', 'started')
    `).run(error, new Date().toISOString());
    return Number(result.changes);
  }

  get(clientMessageId: string): CodexTurnRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM codex_turns WHERE client_message_id = ?
    `).get(clientMessageId) as CodexTurnRow | undefined;
    if (!row) return undefined;
    return {
      clientMessageId: row.client_message_id,
      threadId: row.thread_id,
      ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
      input: JSON.parse(row.input_json) as CodexInput[],
      state: row.state,
      ...(row.error === null ? {} : { error: row.error }),
      requestedAt: row.requested_at,
      updatedAt: row.updated_at,
    };
  }

  private update(clientMessageId: string, state: "started" | "completed", turnId?: string): void {
    const result = state === "started"
      ? this.database.prepare(`
          UPDATE codex_turns SET state = ?, turn_id = ?, updated_at = ?
          WHERE client_message_id = ? AND state = 'requested'
        `).run(state, turnId as string, new Date().toISOString(), clientMessageId)
      : this.database.prepare(`
          UPDATE codex_turns SET state = ?, updated_at = ?
          WHERE client_message_id = ? AND state = 'started'
        `).run(state, new Date().toISOString(), clientMessageId);
    if (result.changes === 0) throw new Error(`Invalid Codex turn transition to ${state}: ${clientMessageId}`);
  }
}
