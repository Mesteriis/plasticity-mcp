import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PairingGrant, PairingGrantKind, PairingRole } from "../shared/contracts.ts";

export interface IssuedToken {
  id: string;
  raw: string;
  projectId: string;
  role: PairingRole;
  expiresAt: string;
}

interface PairingRow {
  token_hash: string;
  project_id: string;
  role: PairingRole;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  kind: PairingGrantKind;
}

const ROLE_LEVEL: Record<PairingRole, number> = { view: 0, annotate: 1, edit: 2 };

export class PairingService {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  issue(projectId: string, role: PairingRole, ttlMs: number, now = Date.now(), kind: PairingGrantKind = "link"): IssuedToken {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 7 * 24 * 60 * 60 * 1_000) {
      throw new Error("Pairing token lifetime must be from 1 ms through 7 days");
    }
    if (!this.database.prepare("SELECT id FROM projects WHERE id = ?").get(projectId)) {
      throw new Error(`Project not found: ${projectId}`);
    }
    const raw = randomBytes(32).toString("base64url");
    const tokenHash = digest(raw).toString("hex");
    const expiresAt = new Date(now + ttlMs).toISOString();
    this.database.prepare(`
      INSERT INTO pairing_tokens (token_hash, project_id, role, expires_at, created_at, kind)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(tokenHash, projectId, role, expiresAt, new Date(now).toISOString(), kind);
    return { id: tokenHash, raw, projectId, role, expiresAt };
  }

  authorize(raw: string, projectId: string, requiredRole: PairingRole, now = Date.now()): IssuedToken {
    const row = this.lookup(raw);
    if (!row) throw new Error("Invalid pairing token");
    if (row.project_id !== projectId) throw new Error("Pairing token does not have permission for this project");
    if (row.revoked_at) throw new Error("Pairing token was revoked");
    if (Date.parse(row.expires_at) < now) throw new Error("Pairing token expired");
    if (ROLE_LEVEL[row.role] < ROLE_LEVEL[requiredRole]) {
      throw new Error(`Pairing token does not have ${requiredRole} permission`);
    }
    return { id: row.token_hash, raw, projectId: row.project_id, role: row.role, expiresAt: row.expires_at };
  }

  exchange(raw: string, now = Date.now()): IssuedToken {
    const row = this.lookup(raw);
    if (!row) throw new Error("Invalid pairing token");
    if (row.revoked_at) throw new Error("Pairing token was revoked");
    const remaining = Date.parse(row.expires_at) - now;
    if (remaining < 0) throw new Error("Pairing token expired");
    this.revoke(raw, now);
    return this.issue(row.project_id, row.role, remaining, now, "session");
  }

  revoke(raw: string, now = Date.now()): void {
    const row = this.lookup(raw);
    if (!row) throw new Error("Invalid pairing token");
    this.database.prepare("UPDATE pairing_tokens SET revoked_at = ? WHERE token_hash = ?")
      .run(new Date(now).toISOString(), row.token_hash);
  }

  list(projectId: string, now = Date.now()): PairingGrant[] {
    return (this.database.prepare(`
      SELECT token_hash, project_id, role, expires_at, created_at, kind
      FROM pairing_tokens
      WHERE project_id = ? AND revoked_at IS NULL AND expires_at >= ?
      ORDER BY created_at DESC
    `).all(projectId, new Date(now).toISOString()) as unknown as PairingRow[]).map(toGrant);
  }

  revokeById(projectId: string, id: string, now = Date.now()): boolean {
    if (!/^[a-f0-9]{64}$/.test(id)) return false;
    const result = this.database.prepare(`
      UPDATE pairing_tokens SET revoked_at = ?
      WHERE token_hash = ? AND project_id = ? AND revoked_at IS NULL
    `).run(new Date(now).toISOString(), id, projectId);
    return result.changes === 1;
  }

  url(origin: string, token: IssuedToken): string {
    const url = new URL("/pair", origin);
    if (url.protocol !== "http:") throw new Error("LAN pairing origin must use HTTP");
    url.searchParams.set("code", token.raw);
    return url.toString();
  }

  private lookup(raw: string): PairingRow | undefined {
    if (!raw || raw.length > 256) return undefined;
    const tokenDigest = digest(raw);
    const row = this.database.prepare("SELECT * FROM pairing_tokens WHERE token_hash = ?")
      .get(tokenDigest.toString("hex")) as PairingRow | undefined;
    if (!row) return undefined;
    const storedDigest = Buffer.from(row.token_hash, "hex");
    if (storedDigest.length !== tokenDigest.length || !timingSafeEqual(storedDigest, tokenDigest)) return undefined;
    return row;
  }
}

function toGrant(row: PairingRow): PairingGrant {
  return {
    id: row.token_hash,
    projectId: row.project_id,
    role: row.role,
    kind: row.kind,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function digest(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}
