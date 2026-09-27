import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { z, ZodError } from "zod";
import QRCode from "qrcode";

import { annotationBatchSchema, constructionJournalInputSchema, dfmInputSchema, dimensionChangeBatchSchema, manufacturingAssessmentRequestSchema, manufacturingProfileRegistrationSchema, manufacturingProfileSchema, modelVersionInputSchema, referenceInputSchema, sha256Schema, sliceInterfaceLayerHeightsRequestSchema, sliceJobRequestSchema, sliceLayerPathOrientationsRequestSchema, slicePartsBatchRequestSchema, structuredBlockInputSchema } from "../shared/schemas.ts";
import type { ArtifactStore } from "./artifact-store.ts";
import { isPrivateIpv4, type WorkbenchConfig } from "./config.ts";
import type { PairingService } from "./pairing.ts";
import type { ManufacturingService } from "./manufacturing/service.ts";
import { ownerTokenMatches } from "./owner-auth.ts";
import { ProjectRevisionConflict, type ProjectStore } from "./project-store.ts";

export interface WorkbenchServerDependencies {
  ownerToken: string;
  projects: ProjectStore;
  artifacts: ArtifactStore;
  pairing?: PairingService;
  config: WorkbenchConfig;
  webRoot?: string;
  manufacturing?: ManufacturingService;
}

export interface WorkbenchListenAddress {
  host: string;
  port: number;
  origin: string;
}

export interface WorkbenchHttpServer {
  readonly server: Server;
  listen(): Promise<WorkbenchListenAddress>;
  close(): Promise<void>;
}

class RequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
  }
}

const createProjectSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();
const blockRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  block: structuredBlockInputSchema,
}).strict();
const versionRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  version: modelVersionInputSchema,
}).strict();
const statusRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  status: z.string().trim().min(1).max(4_000),
}).strict();
const referenceRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  reference: referenceInputSchema,
}).strict();
const constructionJournalRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  journal: constructionJournalInputSchema,
}).strict();

export function createWorkbenchServer(dependencies: WorkbenchServerDependencies): WorkbenchHttpServer {
  const { projects, artifacts, pairing, config, webRoot, manufacturing, ownerToken } = dependencies;
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => sendFailure(response, error));
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isPrivateClientAddress(request.socket.remoteAddress ?? "")) {
      throw new RequestError(403, "network_forbidden", "Workbench accepts clients only from loopback or a private IPv4 network");
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new RequestError(503, "not_ready", "Workbench is not ready");
    const expectedOrigin = `http://${config.host}:${address.port}`;
    if (request.headers.host !== `${config.host}:${address.port}`) {
      throw new RequestError(403, "host_forbidden", "Workbench host is not allowed");
    }
    if ((request.headers.origin && request.headers.origin !== expectedOrigin) || request.headers["sec-fetch-site"] === "cross-site") {
      throw new RequestError(403, "origin_forbidden", "Request origin is not allowed");
    }
    const url = new URL(request.url ?? "/", "http://workbench.local");
    const method = request.method ?? "GET";
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (url.pathname === "/api/owner/session" && method === "POST") {
      const input = z.object({ token: z.string() }).strict().parse(await readJson(request, config.maxJsonBytes));
      if (!ownerTokenMatches(ownerToken, input.token)) throw new RequestError(403, "owner_forbidden", "Owner access denied");
      response.setHeader("set-cookie", `workbench_owner=${encodeURIComponent(ownerToken)}; HttpOnly; SameSite=Strict; Path=/`);
      sendJson(response, 200, { role: "owner" });
      return;
    }

    if (segments.length === 3 && segments[0] === "api" && segments[1] === "pair" && segments[2] === "exchange" && method === "POST") {
      if (!pairing) throw new RequestError(404, "not_found", "Pairing is not enabled");
      const input = z.object({ code: z.string().min(1).max(256) }).strict().parse(await readJson(request, config.maxJsonBytes));
      const session = pairing.exchange(input.code);
      response.setHeader("set-cookie", `workbench_session=${encodeURIComponent(session.raw)}; HttpOnly; SameSite=Strict; Path=/`);
      sendJson(response, 200, { projectId: session.projectId, role: session.role, expiresAt: session.expiresAt });
      return;
    }

    if (method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (method === "GET" && !url.pathname.startsWith("/api/")) {
      if (!webRoot) throw new RequestError(404, "not_found", "Web application is not built");
      await serveWeb(response, webRoot, url.pathname);
      return;
    }
    if (segments.length === 2 && segments[0] === "api" && segments[1] === "projects") {
      if (method === "GET") {
        if (!isOwnerRequest(request, ownerToken, expectedOrigin)) throw new RequestError(403, "project_list_forbidden", "Project listing is available only to the owner");
        sendJson(response, 200, projects.list());
        return;
      }
      if (method === "POST") {
        if (!isOwnerRequest(request, ownerToken, expectedOrigin)) throw new RequestError(403, "project_create_forbidden", "Projects can be created only by the owner");
        const input = createProjectSchema.parse(await readJson(request, config.maxJsonBytes));
        const directory = join(config.projectsRoot, randomUUID());
        await mkdir(directory, { recursive: true });
        sendJson(response, 201, projects.create(input.name, directory));
        return;
      }
    }
    if (segments[0] !== "api" || segments[1] !== "projects" || !segments[2]) {
      throw new RequestError(404, "not_found", "Route not found");
    }

    const projectId = segments[2];
    const project = projects.get(projectId);
    if (!project) throw new RequestError(404, "project_not_found", `Project not found: ${projectId}`);

    const requiredRole = method === "GET" ? "view"
      : segments[3] === "annotations" || segments[3] === "dimension-changes" ? "annotate"
      : "edit";
    authorizeProjectRequest(request, pairing, projectId, requiredRole, ownerToken, expectedOrigin);

    if (segments.length === 3 && method === "GET") {
      sendJson(response, 200, { project, events: projects.eventsAfter(projectId, 0) });
      return;
    }
    if (segments.length === 4 && segments[3] === "pairings" && method === "POST") {
      if (!pairing) throw new RequestError(404, "not_found", "Pairing is not enabled");
      if (!isOwnerRequest(request, ownerToken, expectedOrigin)) throw new RequestError(403, "pairing_forbidden", "Pairing links can be created only by the owner");
      const input = z.object({
        role: z.enum(["view", "annotate", "edit"]),
        ttlMs: z.number().int().positive().max(7 * 24 * 60 * 60 * 1_000),
      }).strict().parse(await readJson(request, config.maxJsonBytes));
      const token = pairing.issue(projectId, input.role, input.ttlMs);
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : config.port;
      const host = config.host === "127.0.0.1" ? (request.headers.host ?? `${config.host}:${port}`) : `${config.host}:${port}`;
      const pairingUrl = pairing.url(`http://${host}`, token);
      sendJson(response, 201, {
        id: token.id,
        projectId: token.projectId,
        role: token.role,
        expiresAt: token.expiresAt,
        url: pairingUrl,
        qrDataUrl: await QRCode.toDataURL(pairingUrl, { margin: 1, width: 320 }),
      });
      return;
    }
    if (segments.length === 4 && segments[3] === "pairings" && method === "GET") {
      if (!pairing) throw new RequestError(404, "not_found", "Pairing is not enabled");
      if (!isOwnerRequest(request, ownerToken, expectedOrigin)) throw new RequestError(403, "pairing_forbidden", "Pairing sessions can be viewed only by the owner");
      sendJson(response, 200, pairing.list(projectId));
      return;
    }
    if (segments.length === 5 && segments[3] === "pairings" && method === "DELETE") {
      if (!pairing) throw new RequestError(404, "not_found", "Pairing is not enabled");
      if (!isOwnerRequest(request, ownerToken, expectedOrigin)) throw new RequestError(403, "pairing_forbidden", "Pairing sessions can be revoked only by the owner");
      if (!pairing.revokeById(projectId, segments[4]!)) throw new RequestError(404, "pairing_not_found", "Active pairing session not found");
      response.statusCode = 204;
      response.end();
      return;
    }
    if (segments.length === 5 && segments[3] === "manufacturing" && segments[4] === "profiles" && method === "GET") {
      if (!manufacturing) throw new RequestError(503, "manufacturing_unavailable", "Manufacturing service is not configured");
      sendJson(response, 200, manufacturing.profiles());
      return;
    }
    if (segments.length === 5 && segments[3] === "manufacturing" && segments[4] === "profiles" && method === "POST") {
      if (!manufacturing) throw new RequestError(503, "manufacturing_unavailable", "Manufacturing service is not configured");
      if (!isOwnerRequest(request, ownerToken, expectedOrigin)) throw new RequestError(403, "profile_registration_forbidden", "Manufacturing profiles can be registered only by the owner");
      const input = manufacturingProfileRegistrationSchema.parse(await readJson(request, config.maxJsonBytes));
      sendJson(response, 201, await manufacturing.registerProfile(input));
      return;
    }
    if (segments.length === 5 && segments[3] === "manufacturing" && segments[4] === "assess" && method === "POST") {
      if (!manufacturing) throw new RequestError(503, "manufacturing_unavailable", "Manufacturing service is not configured");
      const input = manufacturingAssessmentRequestSchema.parse(await readJson(request, config.maxJsonBytes));
      sendJson(response, 200, manufacturing.assess(input.dfm, input.profile, input.profileHash));
      return;
    }
    if (segments.length === 5 && segments[3] === "manufacturing" && segments[4] === "jobs" && method === "GET") {
      if (!manufacturing) throw new RequestError(503, "manufacturing_unavailable", "Manufacturing service is not configured");
      sendJson(response, 200, manufacturing.list(projectId));
      return;
    }
    if (segments.length === 5 && segments[3] === "manufacturing" && segments[4] === "jobs" && method === "POST") {
      if (!manufacturing) throw new RequestError(503, "manufacturing_unavailable", "Manufacturing service is not configured");
      const input = sliceJobRequestSchema.parse(await readJson(request, config.maxJsonBytes));
      sendJson(response, 201, await manufacturing.slice(projectId, input));
      return;
    }
    if (segments.length === 6 && segments[3] === "manufacturing" && segments[4] === "jobs" && segments[5] === "batch" && method === "POST") {
      if (!manufacturing) throw new RequestError(503, "manufacturing_unavailable", "Manufacturing service is not configured");
      const input = slicePartsBatchRequestSchema.parse(await readJson(request, config.maxJsonBytes));
      sendJson(response, 201, await manufacturing.sliceParts(projectId, input));
      return;
    }
    if (segments.length === 7 && segments[3] === "manufacturing" && segments[4] === "jobs" && segments[6] === "interface-heights" && method === "POST") {
      if (!manufacturing) throw new RequestError(503, "manufacturing_unavailable", "Manufacturing service is not configured");
      const input = sliceInterfaceLayerHeightsRequestSchema.parse(await readJson(request, config.maxJsonBytes));
      sendJson(response, 200, manufacturing.interfaceLayerHeights(projectId, segments[5]!, input.interfaceLayerIndices));
      return;
    }
    if (segments.length === 7 && segments[3] === "manufacturing" && segments[4] === "jobs" && segments[6] === "layer-path-orientations" && method === "POST") {
      if (!manufacturing) throw new RequestError(503, "manufacturing_unavailable", "Manufacturing service is not configured");
      const input = sliceLayerPathOrientationsRequestSchema.parse(await readJson(request, config.maxJsonBytes));
      sendJson(response, 200, manufacturing.layerPathOrientations(projectId, segments[5]!, input.layerIndices));
      return;
    }
    if (segments.length === 7 && segments[3] === "manufacturing" && segments[4] === "jobs" && segments[6] === "approve" && method === "POST") {
      if (!isOwnerRequest(request, ownerToken, expectedOrigin)) throw new RequestError(403, "approval_forbidden", "Print approval requires the owner");
      if (!manufacturing) throw new RequestError(503, "manufacturing_unavailable", "Manufacturing service is not configured");
      const input = z.object({ confirmed: z.literal(true) }).strict().parse(await readJson(request, config.maxJsonBytes));
      try { sendJson(response, 200, manufacturing.approve(projectId, segments[5]!, input.confirmed)); }
      catch (error) { throw manufacturingConflict(error); }
      return;
    }
    if (segments.length === 7 && segments[3] === "manufacturing" && segments[4] === "jobs" && segments[6] === "submit" && method === "POST") {
      if (!isOwnerRequest(request, ownerToken, expectedOrigin)) throw new RequestError(403, "submission_forbidden", "Print submission requires the owner");
      if (!manufacturing) throw new RequestError(503, "manufacturing_unavailable", "Manufacturing service is not configured");
      try { sendJson(response, 200, await manufacturing.submit(projectId, segments[5]!)); }
      catch (error) { throw manufacturingConflict(error); }
      return;
    }
    if (segments.length === 7 && segments[3] === "manufacturing" && segments[4] === "jobs" && segments[6] === "reconcile" && method === "POST") {
      if (!manufacturing) throw new RequestError(503, "manufacturing_unavailable", "Manufacturing service is not configured");
      try { sendJson(response, 200, await manufacturing.reconcileSubmission(projectId, segments[5]!)); }
      catch (error) { throw manufacturingConflict(error); }
      return;
    }
    if (segments.length === 5 && segments[3] === "manufacturing" && segments[4] === "printer-status" && method === "POST") {
      if (!manufacturing) throw new RequestError(503, "manufacturing_unavailable", "Manufacturing service is not configured");
      const input = z.object({ profile: manufacturingProfileSchema }).strict().parse(await readJson(request, config.maxJsonBytes));
      sendJson(response, 200, await manufacturing.printerStatus(input.profile));
      return;
    }
    if (segments.length === 4 && segments[3] === "blocks" && method === "POST") {
      const input = blockRequestSchema.parse(await readJson(request, config.maxJsonBytes));
      sendJson(response, 201, projects.addStructuredBlock(projectId, input.expectedRevision, input.block));
      return;
    }
    if (segments.length === 4 && segments[3] === "references" && method === "GET") {
      sendJson(response, 200, projects.listReferences(projectId));
      return;
    }
    if (segments.length === 4 && segments[3] === "references" && method === "POST") {
      const input = referenceRequestSchema.parse(await readJson(request, config.maxJsonBytes));
      sendJson(response, 201, projects.addReference(projectId, input.expectedRevision, input.reference));
      return;
    }
    if (segments.length === 4 && segments[3] === "construction-journals" && method === "GET") {
      sendJson(response, 200, projects.listConstructionJournals(projectId));
      return;
    }
    if (segments.length === 4 && segments[3] === "construction-journals" && method === "POST") {
      const input = constructionJournalRequestSchema.parse(await readJson(request, config.maxJsonBytes));
      sendJson(response, 201, projects.addConstructionJournal(projectId, input.expectedRevision, input.journal));
      return;
    }
    if (segments.length === 4 && segments[3] === "versions" && method === "POST") {
      const input = versionRequestSchema.parse(await readJson(request, config.maxJsonBytes));
      sendJson(response, 201, projects.addModelVersion(projectId, input.expectedRevision, input.version));
      return;
    }
    if (segments.length === 4 && segments[3] === "annotations" && method === "POST") {
      const input = annotationBatchSchema.parse(await readJson(request, config.maxJsonBytes));
      sendJson(response, 201, projects.addAnnotationBatch(projectId, input));
      return;
    }
    if (segments.length === 4 && segments[3] === "dimension-changes" && method === "POST") {
      const input = dimensionChangeBatchSchema.parse(await readJson(request, config.maxJsonBytes));
      sendJson(response, 201, projects.addDimensionChanges(projectId, input));
      return;
    }
    if (segments.length === 4 && segments[3] === "status" && method === "POST") {
      const input = statusRequestSchema.parse(await readJson(request, config.maxJsonBytes));
      sendJson(response, 201, projects.publishStatus(projectId, input.expectedRevision, input.status));
      return;
    }
    if (segments.length === 4 && segments[3] === "assets" && method === "POST") {
      if ((request.headers["content-type"] ?? "").startsWith("application/json")) {
        throw new RequestError(400, "invalid_artifact_upload", "Upload raw artifact bytes; filesystem paths are not accepted");
      }
      const encodedName = request.headers["x-file-name-encoded"];
      const originalName = typeof encodedName === "string" ? decodeArtifactName(encodedName) : singleHeader(request, "x-file-name");
      const mediaType = (request.headers["content-type"] ?? "application/octet-stream").split(";")[0] ?? "application/octet-stream";
      const artifact = await artifacts.put(request, { originalName, mediaType });
      artifacts.attachToProject(projectId, artifact.hash);
      sendJson(response, 201, artifact);
      return;
    }
    if (segments.length === 5 && segments[3] === "assets" && method === "GET") {
      const hash = sha256Schema.safeParse(segments[4]);
      if (!hash.success || !artifacts.isAttachedToProject(projectId, hash.data)) {
        throw new RequestError(403, "artifact_forbidden", "Artifact is not available to this project");
      }
      const artifact = artifacts.get(hash.data);
      if (!artifact) throw new RequestError(403, "artifact_forbidden", "Artifact is not available to this project");
      response.writeHead(200, {
        "content-type": artifact.mediaType,
        "content-length": artifact.bytes,
        "content-disposition": `inline; filename="${artifact.originalName.replaceAll('"', "")}"`,
        "x-content-type-options": "nosniff",
      });
      (await artifacts.open(hash.data)).pipe(response);
      return;
    }
    if (segments.length === 4 && segments[3] === "events" && method === "GET") {
      const after = Number(url.searchParams.get("after") ?? "0");
      if (!Number.isSafeInteger(after) || after < 0) throw new RequestError(400, "invalid_sequence", "Event sequence must be a nonnegative integer");
      sendJson(response, 200, projects.eventsAfter(projectId, after));
      return;
    }
    throw new RequestError(404, "not_found", "Route not found");
  }

  return {
    server,
    listen: async () => await new Promise<WorkbenchListenAddress>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(config.port, config.host, () => {
        server.off("error", onError);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Workbench HTTP server did not expose a TCP address"));
          return;
        }
        resolve({ host: config.host, port: address.port, origin: `http://${config.host}:${address.port}` });
      });
    }),
    close: async () => {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function serveWeb(response: ServerResponse, webRoot: string, pathname: string): Promise<void> {
  const root = resolve(webRoot);
  const requested = pathname === "/" || !extname(pathname) ? "index.html" : pathname.replace(/^\/+/, "");
  const path = resolve(root, requested);
  if (path !== root && !path.startsWith(`${root}/`)) throw new RequestError(403, "asset_forbidden", "Invalid web asset path");
  let data: Buffer;
  try { data = await readFile(path); }
  catch { throw new RequestError(404, "not_found", "Web asset not found"); }
  const contentType = ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".wasm": "application/wasm", ".png": "image/png" } as Record<string, string>)[extname(path)] ?? "application/octet-stream";
  response.writeHead(200, { "content-type": contentType, "content-length": data.byteLength, "x-content-type-options": "nosniff" });
  response.end(data);
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw new RequestError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const sourceChunk of request) {
    const chunk = Buffer.from(sourceChunk);
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new RequestError(413, "body_too_large", `JSON body exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  if (bytes === 0) throw new RequestError(400, "invalid_json", "A JSON body is required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RequestError(400, "invalid_json", "Request body is not valid JSON");
  }
}

function singleHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || !value.trim()) throw new RequestError(400, "missing_header", `${name} header is required`);
  return value;
}

function decodeArtifactName(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new RequestError(400, "invalid_artifact_name", "Encoded artifact file name is invalid"); }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.byteLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(data);
}

function sendFailure(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : new Error(String(error)));
    return;
  }
  if (error instanceof ProjectRevisionConflict) {
    sendJson(response, 409, {
      error: { code: "revision_conflict", message: error.message },
      currentRevision: error.currentRevision,
    });
    return;
  }
  if (error instanceof RequestError) {
    sendJson(response, error.status, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof ZodError) {
    sendJson(response, 400, {
      error: { code: "validation_error", message: "Request validation failed", issues: error.issues },
    });
    return;
  }
  sendJson(response, 500, {
    error: { code: "internal_error", message: "Internal error" },
  });
}

function manufacturingConflict(error: unknown): RequestError {
  return new RequestError(409, "manufacturing_conflict", error instanceof Error ? error.message : String(error));
}

export function isPrivateClientAddress(address: string): boolean {
  if (address === "::1") return true;
  const ipv4 = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return isPrivateIpv4(ipv4);
}

function authorizeProjectRequest(
  request: IncomingMessage,
  pairing: PairingService | undefined,
  projectId: string,
  requiredRole: "view" | "annotate" | "edit",
  ownerToken: string,
  expectedOrigin: string,
): void {
  if (isOwnerRequest(request, ownerToken, expectedOrigin)) return;
  const raw = tokenFromCookie(request.headers.cookie);
  try {
    if (!pairing || !raw) throw new Error("Missing project session");
    if (request.method !== "GET" && request.headers.origin !== expectedOrigin) throw new Error("Request origin is required");
    pairing.authorize(raw, projectId, requiredRole);
  } catch (error) {
    throw new RequestError(403, "project_forbidden", error instanceof Error ? error.message : "Project access denied");
  }
}

function isOwnerRequest(request: IncomingMessage, ownerToken: string, expectedOrigin: string): boolean {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ") && ownerTokenMatches(ownerToken, authorization.slice(7))) return true;
  const cookie = tokenFromCookie(request.headers.cookie, "workbench_owner");
  return ownerTokenMatches(ownerToken, cookie)
    && (request.method === "GET" || request.headers.origin === expectedOrigin);
}

function tokenFromCookie(cookie: string | undefined, tokenName = "workbench_session"): string | undefined {
  if (!cookie) return undefined;
  for (const item of cookie.split(";")) {
    const [name, ...parts] = item.trim().split("=");
    if (name === tokenName) return decodeURIComponent(parts.join("="));
  }
  return undefined;
}
