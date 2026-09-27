#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
interface Options { help: boolean; target?: string; allowDisposableMutations: boolean; output?: string }

export function parseNonparallelClearanceArgs(argv: string[]): Options {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: Options = { help: false, allowDisposableMutations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target") {
      const value = argv[++index];
      if (!value) throw new Error("--target requires an explicit Plasticity window ID");
      options.target = value;
    } else if (argument === "--output") {
      const value = argv[++index];
      if (!value) throw new Error("--output requires a new directory path");
      options.output = value;
    }
    else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live nonparallel-clearance acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live nonparallel-clearance acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live nonparallel-clearance acceptance requires --output with a new directory");
  return options;
}

async function main(): Promise<void> {
  const options = parseNonparallelClearanceArgs(process.argv.slice(2));
  if (options.help) { console.log("Usage: node scripts/verify-nonparallel-planar-clearance-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY"); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "scripts", "run-server.ts")],
    cwd: root,
    env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: join(output, "strength-store"), PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" },
    stderr: "pipe",
  });
  const client = new Client({ name: "plasticity-nonparallel-clearance-live", version: "1.0.0" });
  let initial: any;
  let state: any;
  let snapshotId: string | undefined;
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target, workbenchUsed: false };
  try {
    await client.connect(transport);
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initial = await call(client, "plasticity_connect", { targetId: options.target });
    requireCondition(initial.bodies.length === 0 && initial.regions.length === 0 && (initial.instances ?? []).length === 0, "Refusing disposable mutations in a nonempty Plasticity document");
    requireCondition((initial.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, "Refusing mutations while non-root groups exist");
    evidence.initial = { documentToken: initial.documentToken, revision: initial.revision, undoDepth: initial.undoDepth };
    const snapshot = await call(client, "plasticity_capture_snapshot", { label: "nonparallel-planar-clearance-empty" });
    snapshotId = snapshot.snapshotId;
    state = initial;

    const base = await createBox(client, state.revision, "Clearance base", [0, 0, 0]); state = base.state;
    const crossing = await createBox(client, state.revision, "Clearance crossing", [22, 0, 0]); state = crossing.state;
    state = await call(client, "plasticity_rotate", { ids: [crossing.id], pivotMm: [32, 10, 2.5], axis: [0, 0, 1], degrees: 30, intent: "Prepare intersecting oblique clearance fixture", revision: state.revision });
    const separated = await createBox(client, state.revision, "Clearance separated", [28, 0, 0]); state = separated.state;
    state = await call(client, "plasticity_rotate", { ids: [separated.id], pivotMm: [38, 10, 2.5], axis: [0, 0, 1], degrees: 30, intent: "Prepare separated oblique clearance fixture", revision: state.revision });

    const detailed = await call(client, "plasticity_list_bodies", { bodyOffset: 0, bodyLimit: 100, expectedRevision: state.revision });
    const baseBody = bodyById(detailed.bodies, base.id);
    const crossingBody = bodyById(detailed.bodies, crossing.id);
    const separatedBody = bodyById(detailed.bodies, separated.id);
    const baseFace = baseBody.faces.find((face: any) => face.planar && Math.abs(face.centerMm[0] - 20) < 1e-6 && Math.abs(Math.abs(face.normal[0]) - 1) < 1e-6);
    requireCondition(baseFace, "Could not resolve the exact planar base face from native B-Rep");
    const targetNormal = [-Math.cos(Math.PI / 6), -Math.sin(Math.PI / 6), 0];
    const obliqueFace = (body: any) => body.faces.find((face: any) => face.planar
      && Math.abs(face.normal[0] * targetNormal[0]! + face.normal[1] * targetNormal[1]! + face.normal[2] * targetNormal[2]! - 1) < 1e-7);
    const crossingFace = obliqueFace(crossingBody);
    const separatedFace = obliqueFace(separatedBody);
    requireCondition(crossingFace && separatedFace, "Could not resolve exact oblique planar faces from native B-Rep");
    const intersection = await call(client, "plasticity_measure_nonparallel_planar_polygon_clearance", {
      first: { bodyId: base.id, faceId: baseFace.id }, second: { bodyId: crossing.id, faceId: crossingFace.id }, revision: state.revision,
    });
    const gap = await call(client, "plasticity_measure_nonparallel_planar_polygon_clearance", {
      first: { bodyId: base.id, faceId: baseFace.id }, second: { bodyId: separated.id, faceId: separatedFace.id }, revision: state.revision,
    });
    requireCondition(intersection.exact && intersection.minimumDistanceMm === 0, "Intersecting nonparallel face regions did not return exact zero clearance");
    near(gap.closestPointsMm.first[0], 20, 0.01, "base closest X");
    near(gap.closestPointsMm.second[0], 38 - 10 * Math.cos(Math.PI / 6) - 10 * Math.sin(Math.PI / 6), 0.01, "oblique closest X");
    near(gap.closestPointsMm.second[1], 10 - 10 * Math.sin(Math.PI / 6) + 10 * Math.cos(Math.PI / 6), 0.01, "oblique closest Y");
    near(gap.closestPointsMm.first[1], gap.closestPointsMm.second[1], 0.01, "base closest Y");
    near(gap.closestPointsMm.first[2], gap.closestPointsMm.second[2], 0.01, "closest Z positions");
    requireCondition(gap.closestPointsMm.first[2] >= -0.01 && gap.closestPointsMm.first[2] <= 5.01, "Closest point left the finite face bounds");
    near(gap.minimumDistanceMm, 38 - 10 * Math.cos(Math.PI / 6) - 10 * Math.sin(Math.PI / 6) - 20, 0.01, "oblique face clearance");
    const holedBase = await createBox(client, state.revision, "Clearance holed base", [60, 0, 0]); state = holedBase.state;
    const squareCutter = await createBox(client, state.revision, "Clearance square cutter", [67.5, 7.5, -1], [5, 5, 7]); state = squareCutter.state;
    state = await call(client, "plasticity_boolean", {
      targetIds: [holedBase.id], toolIds: [squareCutter.id], operation: "difference", keepTools: false,
      intent: "Create a disposable polygonal through-hole for native face-clearance acceptance", revision: state.revision,
    });
    const probe = await createBox(client, state.revision, "Clearance hole probe", [70, 8, -1], [0.1, 4, 7]); state = probe.state;
    const detailedWithHole = await call(client, "plasticity_list_bodies", { bodyOffset: 0, bodyLimit: 100, expectedRevision: state.revision });
    const holedBody = bodyById(detailedWithHole.bodies, holedBase.id);
    const holedTopFace = holedBody.faces.find((face: any) => face.planar && Math.abs(face.centerMm[2] - 5) < 1e-6
      && face.normal[2] > 1 - 1e-6 && face.edgeIds.length === 8);
    requireCondition(holedTopFace, "Could not resolve the exact native top face with one square through-hole");
    const probeBody = bodyById(detailedWithHole.bodies, probe.id);
    const probeFace = probeBody.faces.find((face: any) => face.planar && Math.abs(face.centerMm[0] - 70) < 1e-6
      && Math.abs(Math.abs(face.normal[0]) - 1) < 1e-6);
    requireCondition(probeFace, "Could not resolve the exact native face crossing the square-hole opening");
    const holeClearance = await call(client, "plasticity_measure_nonparallel_planar_polygon_clearance", {
      first: { bodyId: holedBase.id, faceId: holedTopFace.id }, second: { bodyId: probe.id, faceId: probeFace.id }, revision: state.revision,
    });
    near(holeClearance.minimumDistanceMm, 0.5, 0.01, "square-hole face clearance");
    requireCondition(holeClearance.exact === true, "Polygonal-hole clearance was not reported as exact");
    evidence.measurements = {
      intersection, separated: gap, polygonalHole: holeClearance,
      nativeTopology: {
        baseBodyId: base.id, baseFaceId: baseFace.id, crossingBodyId: crossing.id, crossingFaceId: crossingFace.id,
        separatedBodyId: separated.id, separatedFaceId: separatedFace.id,
        holedBaseBodyId: holedBase.id, holedTopFaceId: holedTopFace.id, probeBodyId: probe.id, probeFaceId: probeFace.id,
      },
    };
    const afterRead = await call(client, "plasticity_status", {});
    requireCondition(afterRead.revision === state.revision && afterRead.undoDepth === state.undoDepth, "Read-only clearance changed document revision or Undo depth");

    while (state.undoDepth > initial.undoDepth) state = await call(client, "plasticity_undo", { intent: "Cleanup nonparallel planar-clearance fixtures", revision: state.revision });
    requireCondition(state.bodies.length === 0 && state.regions.length === 0, "Undo cleanup did not restore an empty document");
    const diff = await call(client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(diff.diff), "Scene contents differ from the initial empty snapshot");
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json") }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    if (initial) evidence.reconciledState = await reconcileFailure(client, initial, snapshotId).catch((failure) => ({ available: false, reason: boundedError(failure) }));
    await writeExclusive(join(output, "failure.json"), sanitizeEvidence(evidence)).catch(() => {});
    throw error;
  } finally { await client.close().catch(() => {}); }
}

async function createBox(client: Client, revision: string, name: string, originMm: [number, number, number], sizeMm: [number, number, number] = [20, 20, 5]): Promise<{ state: any; id: number }> {
  const state = await call(client, "plasticity_create_box", { originMm, sizeMm, name, intent: "Disposable nonparallel-clearance acceptance geometry", revision });
  return { state, id: bodyIdNamed(state.bodies, name) };
}
function bodyIdNamed(bodies: any[], name: string): number { const body = bodies.find((candidate) => candidate.name === name); requireCondition(body && Number.isInteger(body.id), `Could not find body ${name}`); return body.id; }
function bodyById(bodies: any[], id: number): any { const body = bodies.find((candidate) => candidate.id === id); requireCondition(body, `Could not read native B-Rep body ${id}`); return body; }
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const text = toolText(response); if ("isError" in response && response.isError) throw new Error(text); return JSON.parse(text); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 16; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 }; await call(client, "plasticity_undo", { intent: "Recover nonparallel planar-clearance acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
async function reconcileFailure(client: Client, initial: any, snapshotId?: string): Promise<Record<string, unknown>> {
  const status = await call(client, "plasticity_status", {});
  const changes = snapshotId ? await call(client, "plasticity_changes_since", { snapshotId }) : undefined;
  return {
    available: true,
    sameDocument: status.documentToken === initial.documentToken,
    state: { documentToken: status.documentToken, revision: status.revision, undoDepth: status.undoDepth, redoDepth: status.redoDepth, bodyCount: status.bodies.length },
    bodyIds: status.bodies.map((body: any) => body.id),
    sceneChanged: changes ? hasSceneContentChanges(changes.diff) : null,
    note: "Failure reconciliation is read-only; inspect before any manual recovery action.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
