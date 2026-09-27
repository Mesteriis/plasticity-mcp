#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { discoverPlasticityTargets } from "../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../src/plasticity/runtime.ts";
import { comparePngPixels } from "./png-pixels.ts";
import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface NativeTopologyDistanceAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeTopologyDistanceAcceptanceArgs(argv: string[]): NativeTopologyDistanceAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeTopologyDistanceAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live native topology-distance acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native topology-distance acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native topology-distance acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-topology-distance-live.ts --help
  node scripts/verify-native-topology-distance-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, creates persistent native
face-center and edge-midpoint distance measurements, verifies topology targets,
exact values, their rendered viewport annotation, Undo/Redo, and cleanup, then
writes bounded evidence.`;

async function main(): Promise<void> {
  const options = parseNativeTopologyDistanceAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target!, workbenchUsed: false };
  let live: LiveMcp | undefined;
  let initialState: any;
  try {
    live = await startMcp(join(output, "strength-store"));
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initialState = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireEmpty(initialState, "initial document");
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-topology-distance-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [20, 10, 5],
      intent: "Approved disposable native topology-distance source", revision: initialState.revision,
    });
    const bodyPage = await call(live.client, "plasticity_body_info", { id: state.bodies[0].id });
    requireCondition(bodyPage.revision === state.revision, "Detailed body read used a different revision");
    const box = bodyPage.body;
    requireCondition(box.type === "Solid", `Expected one Solid, received ${String(box.type)}`);
    await call(live.client, "plasticity_set_view", { view: "isometric", fit: true });
    await call(live.client, "plasticity_select_bodies", { ids: [box.id], revision: state.revision });
    await clearSelection(options.target!);
    await delay(250);
    const geometryScreenshot = await captureScreenshot(live.client, options.target!, join(output, "geometry-before-measurements.png"));
    const bottom = onlyFaceAtZ(box, 0, "bottom");
    const top = onlyFaceAtZ(box, 5, "top");
    const topFrontEdge = onlyEdgeAt(box, [10, 0, 5]);
    const frontBottomLeft = onlyVertexAt(box, [0, 0, 0]);
    const frontBottomRight = onlyVertexAt(box, [20, 0, 0]);

    state = await call(live.client, "plasticity_create_topology_distance_measurement", {
      first: { type: "face-center", bodyId: box.id, faceId: bottom.id },
      second: { type: "face-center", bodyId: box.id, faceId: top.id },
      name: "Thickness 5", intent: "Persist exact face-center thickness", revision: state.revision,
    });
    const thickness = onlyMeasurement(state, "Thickness 5");
    verifyDistance(thickness, ["face", "face"], [bottom.id, top.id], 5, "Thickness measurement");

    state = await call(live.client, "plasticity_create_topology_distance_measurement", {
      first: { type: "face-center", bodyId: box.id, faceId: bottom.id },
      second: { type: "edge-midpoint", bodyId: box.id, edgeId: topFrontEdge.id },
      name: "Face to edge", intent: "Persist exact face-center to edge-midpoint distance", revision: state.revision,
    });
    const mixed = onlyMeasurement(state, "Face to edge");
    verifyDistance(mixed, ["face", "edge"], [bottom.id, topFrontEdge.id], Math.sqrt(50), "Mixed topology measurement");
    state = await call(live.client, "plasticity_create_vertex_distance_measurement", {
      first: { bodyId: box.id, vertexId: frontBottomLeft.id },
      second: { bodyId: box.id, vertexId: frontBottomRight.id },
      name: "Width 20",
      intent: "Persist exact visible vertex-to-vertex width dimension",
      revision: state.revision,
    });
    const width = onlyMeasurement(state, "Width 20");
    verifyDistance(width, ["vertex", "vertex"], [frontBottomLeft.id, frontBottomRight.id], 20, "Vertex width measurement");

    const listed = await call(live.client, "plasticity_list_measurements", {});
    requireCondition(listed.measurements.length === 3, "Expected three persistent native distance measurements");
    verifyDistance(onlyMeasurement(listed, "Thickness 5"), ["face", "face"], [bottom.id, top.id], 5, "Listed thickness measurement");
    verifyDistance(onlyMeasurement(listed, "Face to edge"), ["face", "edge"], [bottom.id, topFrontEdge.id], Math.sqrt(50), "Listed mixed measurement");
    verifyDistance(onlyMeasurement(listed, "Width 20"), ["vertex", "vertex"], [frontBottomLeft.id, frontBottomRight.id], 20, "Listed vertex width measurement");
    await call(live.client, "plasticity_select_bodies", { ids: [box.id], revision: state.revision });
    await clearSelection(options.target!);
    await delay(250);
    const overlay = await readMeasurementOverlay(options.target!);
    const visibleLabels = overlay.labels;
    for (const expected of ["5.00 mm", "7.07 mm", "20.00 mm"]) {
      requireCondition(visibleLabels.some((label) => label.text === expected && label.visible && label.insideViewport),
        `Expected a visible in-viewport native measurement label: ${expected}`);
    }
    requireCondition(overlay.segments.length >= 3 && overlay.segments.every((segment) =>
      segment.lengthMm > 0 && segment.colorHex === "b7f397" && !segment.depthTest && segment.linewidth === 2),
      "Expected nonzero native dimension/extension segments for the rendered measurements");
    let annotatedScreenshot: Awaited<ReturnType<typeof captureScreenshot>> | undefined;
    let annotationDifference: ReturnType<typeof comparePngPixels> | undefined;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await delay(100);
      annotatedScreenshot = await captureScreenshot(live.client, options.target!, join(output, `geometry-with-measurements-${attempt + 1}.png`));
      annotationDifference = comparePngPixels(geometryScreenshot.png, annotatedScreenshot.png);
      if (annotationDifference.changedPixelCount > 200) break;
    }
    evidence.measurements = {
      values: listed.measurements,
      visibleLabels,
      visibleSegments: overlay.segments,
      renderedViewport: {
        before: geometryScreenshot.summary,
        after: annotatedScreenshot!.summary,
        pixelDifference: annotationDifference,
      },
    };
    requireCondition(annotationDifference?.changedPixelCount !== undefined && annotationDifference.changedPixelCount > 200,
      `Native measurements did not visibly change the viewport (changed ${annotationDifference?.changedPixelRatio ?? 0})`);

    state = await call(live.client, "plasticity_undo", { intent: "Verify topology-distance Undo", revision: state.revision });
    requireCondition((state.measurements ?? []).length === 2
      && !(state.measurements ?? []).some((measurement: any) => measurement.id === width.id)
      && onlyMeasurement(state, "Thickness 5").id === thickness.id
      && onlyMeasurement(state, "Face to edge").id === mixed.id,
    "Undo did not remove only the last-created vertex width measurement");
    state = await call(live.client, "plasticity_redo", { intent: "Verify topology-distance Redo", revision: state.revision });
    requireCondition((state.measurements ?? []).some((measurement: any) => measurement.id === width.id), "Redo did not restore the vertex width measurement stable ID");
    evidence.undoRedo = { undoRemovedVertexWidth: true, redoRestoredStableMeasurementId: width.id };

    while (state.undoDepth > initialState.undoDepth) state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native topology-distance acceptance", revision: state.revision });
    requireEmpty(state, "cleaned document");
    requireCondition((state.measurements ?? []).length === 0, "Cleanup left persistent measurements");
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = { restoredEmptyDocument: true, measurementsRemoved: true, sceneContentsRestored: true };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json") }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    if (live && initialState && !evidence.cleanup) evidence.cleanup = await recover(live.client, initialState).catch((cleanupError) => ({ restoredEmptyDocument: false, reason: boundedError(cleanupError) }));
    await writeExclusive(join(output, "failure.json"), sanitizeEvidence(evidence)).catch(() => {});
    throw error;
  } finally {
    await live?.client.close().catch(() => {});
  }
}

function onlyBody(state: any, type: string): any { const bodies = state.bodies.filter((body: any) => body.type === type); requireCondition(bodies.length === 1, `Expected one ${type}`); return bodies[0]; }
function onlyFaceAtZ(body: any, z: number, label: string): any { const faces = body.faces.filter((face: any) => Math.abs(face.centerMm[2] - z) <= 1e-6); requireCondition(faces.length === 1, `Expected one ${label} face`); return faces[0]; }
function onlyEdgeAt(body: any, center: [number, number, number]): any { const edges = body.edges.filter((edge: any) => edge.centerMm.every((value: number, index: number) => Math.abs(value - center[index]!) <= 1e-6)); requireCondition(edges.length === 1, "Expected one top-front edge"); return edges[0]; }
function onlyVertexAt(body: any, point: [number, number, number]): any { const vertices = body.vertices.filter((vertex: any) => vertex.positionMm.every((value: number, index: number) => Math.abs(value - point[index]!) <= 1e-6)); requireCondition(vertices.length === 1, `Expected one vertex at ${point.join(",")}`); return vertices[0]; }
function onlyMeasurement(state: any, name: string): any { const measurements = (state.measurements ?? []).filter((measurement: any) => measurement.name === name); requireCondition(measurements.length === 1, `Expected exactly one measurement named ${name}`); return measurements[0]; }
function verifyDistance(measurement: any, types: [string, string], refs: [string, string], distanceMm: number, label: string): void {
  requireCondition(measurement.type === "DistanceMeasurement", `${label} has type ${measurement.type}`);
  requireCondition(measurement.first?.topologyType === types[0] && measurement.second?.topologyType === types[1], `${label} lost topology types`);
  requireCondition(measurement.first?.topologyRefId === refs[0] && measurement.second?.topologyRefId === refs[1], `${label} lost public topology references`);
  near(measurement.distanceMm, distanceMm, 0.000001, `${label} distance`);
}
function requireEmpty(state: any, label: string): void { requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`); requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`); }
async function startMcp(storeRoot: string): Promise<LiveMcp> { const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" }); const stderr: string[] = []; transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); }); const client = new Client({ name: "plasticity-native-topology-distance-live", version: "1.0.0" }); await client.connect(transport); return { client, stderr }; }
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const response = await client.callTool({ name, arguments: args }); const text = toolText(response); if ("isError" in response && response.isError) throw new Error(text); return JSON.parse(text); }
function toolText(response: unknown): string { if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content"); const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"); if (!item) throw new Error("MCP tool returned no text content"); return item.text; }
async function recover(client: Client, initial: any): Promise<Record<string, unknown>> { for (let count = 0; count < 24; count += 1) { const status = await call(client, "plasticity_status", {}); if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" }; if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 && (status.measurements ?? []).length === 0 }; await call(client, "plasticity_undo", { intent: "Recover disposable native topology-distance acceptance", revision: status.revision }); } return { restoredEmptyDocument: false, reason: "undo-limit" }; }
function stateSummary(state: any): Record<string, any> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length, measurementCount: (state.measurements ?? []).length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
async function captureScreenshot(client: Client, targetId: string, path: string): Promise<{ summary: Record<string, unknown>; png: Buffer }> {
  let summary: Record<string, unknown>;
  try {
    const result = await call(client, "plasticity_screenshot", { path });
    requireCondition(Number.isInteger(result.bytes) && result.bytes > 1_000, "Plasticity screenshot is unexpectedly small");
    summary = { path, bytes: result.bytes, width: result.width, height: result.height, captureMethod: "Plasticity MCP" };
  } catch (error) {
    if (process.platform !== "darwin" || !/renderer is hidden/i.test(boundedError(error))) throw error;
    const endpoint = process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223";
    const target = (await discoverPlasticityTargets(endpoint)).find((candidate) => candidate.id === targetId);
    if (!target) throw new Error("Explicit Plasticity target disappeared while capturing its visible window");
    const swift = `import CoreGraphics; let title = CommandLine.arguments.last ?? ""; let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []; let matches = windows.filter { ($0[kCGWindowOwnerName as String] as? String) == "Plasticity" && ($0[kCGWindowName as String] ?? "") as? String == title }; guard matches.count == 1, let number = matches[0][kCGWindowNumber as String] else { fputs("Expected exactly one visible Plasticity window titled \\(title)\\n", stderr); exit(2) }; print(number)`;
    const windowId = execFileSync("swift", ["-e", swift, target.title], { encoding: "utf8" }).trim();
    execFileSync("screencapture", ["-x", "-l", windowId, path]);
    const png = await readFile(path);
    requireCondition(png.length > 1_000, "Visible Plasticity window screenshot is unexpectedly small");
    return { summary: { path, bytes: png.length, captureMethod: "macOS visible Plasticity window (renderer hidden flag)" }, png };
  }
  const png = await readFile(path);
  requireCondition(png.length === summary.bytes, "Saved screenshot size differs from the reported MCP result");
  return { summary, png };
}
async function clearSelection(targetId: string): Promise<void> {
  const endpoint = process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223";
  const target = (await discoverPlasticityTargets(endpoint)).find((candidate) => candidate.id === targetId);
  if (!target) throw new Error("Explicit Plasticity target disappeared while stabilizing the viewport screenshot");
  const runtime = await PlasticityRuntime.connect(target);
  try {
    await runtime.read(`function () {
      this.selection.selected.removeAll();
      Array.from(this.viewports)[0]?.setNeedsRender();
      return true;
    }`);
  } finally { runtime.close(); }
}
async function readMeasurementOverlay(targetId: string): Promise<{
  labels: Array<{ text: string; visible: boolean; insideViewport: boolean }>;
  segments: Array<{ versionId: number; startMm: number[]; endMm: number[]; lengthMm: number; colorHex: string; depthTest: boolean; linewidth: number }>;
}> {
  const endpoint = process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223";
  const target = (await discoverPlasticityTargets(endpoint)).find((candidate) => candidate.id === targetId);
  if (!target) throw new Error("Explicit Plasticity target disappeared while checking measurement labels");
  const runtime = await PlasticityRuntime.connect(target);
  try {
    return await runtime.read(`function () {
      const labels = Array.from(document.querySelectorAll('[data-plasticity-mcp-distance]')).map(label => {
        const rect = label.getBoundingClientRect();
        const viewport = label.closest('plasticity-viewport')?.getBoundingClientRect();
        const visible = getComputedStyle(label).display !== 'none' && rect.width > 0 && rect.height > 0;
        const insideViewport = Boolean(viewport && rect.left >= viewport.left && rect.top >= viewport.top
          && rect.right <= viewport.right && rect.bottom <= viewport.bottom);
        return { text: label.textContent ?? '', visible, insideViewport };
      });
      const segments = this.helpers.scene.children
        .filter(helper => helper.userData?.plasticityMcpMeasurementOverlay && helper.p1 && helper.p2)
        .map(helper => ({ versionId: helper.userData.plasticityMcpMeasurementOverlay.versionId,
          startMm: helper.p1.toArray().map(value => value * 1000),
          endMm: helper.p2.toArray().map(value => value * 1000),
          lengthMm: helper.p1.distanceTo(helper.p2) * 1000,
          colorHex: helper.line.material.color.getHexString(),
          depthTest: helper.line.material.depthTest,
          linewidth: helper.line.material.linewidth }));
      return { labels, segments };
    }`);
  } finally { runtime.close(); }
}
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
