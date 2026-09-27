#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface NativeSvgCircularAcceptanceOptions { help: boolean; target?: string; allowLive: boolean; output?: string }

export function parseNativeSvgCircularAcceptanceArgs(argv: string[]): NativeSvgCircularAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowLive: false };
  const options: NativeSvgCircularAcceptanceOptions = { help: false, allowLive: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-live") options.allowLive = true;
    else if (argument === "--target") options.target = requireValue(argv, ++index, "--target");
    else if (argument === "--output") options.output = requireValue(argv, ++index, "--output");
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Native circular SVG acceptance requires an explicit --target Plasticity window ID");
  if (!options.allowLive) throw new Error("Native circular SVG acceptance requires --allow-live");
  if (!options.output) throw new Error("Native circular SVG acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-svg-circular-export-live.ts --help
  node scripts/verify-native-svg-circular-export-live.ts --target ID --allow-live --output NEW_DIRECTORY

No-argument and --help modes are inert. Live mode requires the dedicated
SVG export probe scene (Solid “SVG export probe”, Wire “Rectangle.001”, one
Region), creates one 5 mm circle and one 220-degree 5 mm arc through stdio
MCP, checks exact B-Rep readback and SVG primitives, then undoes only those
two known successful operations.`;

async function main(): Promise<void> {
  const options = parseNativeSvgCircularAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const circlePath = join(output, "native-circle.svg");
  const arcPath = join(output, "native-circular-profile.svg");
  const evidencePath = join(output, "evidence.json");
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target, workbenchUsed: false };
  let client: Client | undefined;
  let initial: any;
  let circleState: any;
  let arcState: any;
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(projectRoot, "scripts", "run-server.ts")],
      cwd: projectRoot,
      env: { ...selectedEnvironment(process.env), PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" },
      stderr: "pipe",
    });
    client = new Client({ name: "plasticity-native-svg-circular-export-live", version: "1.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    for (const name of ["plasticity_list_windows", "plasticity_connect", "plasticity_create_circle", "plasticity_create_center_arc", "plasticity_inspect_curve_structure", "plasticity_inspect_curve_planarity", "plasticity_list_curve_directions", "plasticity_export_svg", "plasticity_undo", "plasticity_status"]) {
      requireCondition(tools.tools.some((tool) => tool.name === name), `MCP did not expose ${name}`);
    }
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initial = await call(client, "plasticity_connect", { targetId: options.target });
    const fixtureSolid = initial.bodies.find((body: any) => body.id === 2 && body.type === "Solid" && body.name === "SVG export probe");
    const fixtureWire = initial.bodies.find((body: any) => body.id === 3 && body.type === "Wire" && body.name === "Rectangle.001");
    requireCondition(fixtureSolid && fixtureWire && initial.bodies.length === 2 && initial.regions.length === 1, "Refusing to mutate: target is not the dedicated two-body SVG probe document");
    evidence.initial = stateSummary(initial);

    circleState = await call(client, "plasticity_create_circle", { centerMm: [100, 100, 0], radiusMm: 5, normal: [0, 0, 1], intent: "Disposable live acceptance of exact circular SVG export", revision: initial.revision });
    const circleId = onlyNewWireId(initial, circleState);
    const arcStateCreated = await call(client, "plasticity_create_center_arc", { centerMm: [130, 100, 0], radiusMm: 5, startAngleDegrees: 30, sweepAngleDegrees: 220, normal: [0, 0, 1], xDirection: [1, 0, 0], intent: "Disposable live acceptance of exact circular SVG export", revision: circleState.revision });
    arcState = arcStateCreated;
    const arcId = onlyNewWireId(circleState, arcStateCreated);

    const structure = await call(client, "plasticity_inspect_curve_structure", { ids: [circleId, arcId], revision: arcStateCreated.revision });
    const circleSegment = soleSegment(structure, circleId);
    const arcSegment = soleSegment(structure, arcId);
    const planarity = await call(client, "plasticity_inspect_curve_planarity", { ids: [circleId, arcId], revision: arcStateCreated.revision });
    const circlePlane = planarity.curves.find((curve: any) => curve.id === circleId);
    const arcPlane = planarity.curves.find((curve: any) => curve.id === arcId);
    requireCondition(circlePlane?.planar && arcPlane?.planar && circlePlane.plane && arcPlane.plane, "Native B-Rep planarity readback is incomplete");
    const directions = await call(client, "plasticity_list_curve_directions", {});
    const nativeArc = directions.curves.find((curve: any) => curve.id === arcId);
    requireCondition(nativeArc?.measurementSource === "native-brep" && nativeArc.segments.length === 1, "Exact native arc endpoints and tangent are unavailable");
    requireCondition(circleSegment.curveType === "Circle" && circleSegment.circle, "Native full circle was not reported as an analytic Circle");
    requireCondition(arcSegment.curveType === "Circle" && arcSegment.circle, "Native trimmed arc was not reported as an analytic Circle");
    vectorNear(circleSegment.circle.centerMm, [100, 100, 0], 1e-6, "full-circle native center");
    vectorNear(arcSegment.circle.centerMm, [130, 100, 0], 1e-6, "arc native center");
    near(circleSegment.circle.radiusMm, 5, 1e-7, "full-circle native radius");
    near(arcSegment.circle.radiusMm, 5, 1e-7, "arc native radius");
    vectorNear(circleSegment.circle.normal, [0, 0, 1], 1e-9, "native circle normal");
    near(circleSegment.lengthMm, 10 * Math.PI, 1e-6, "native circumference");
    near(arcSegment.lengthMm, 5 * 220 * Math.PI / 180, 1e-6, "native arc length");

    const report = await call(client, "plasticity_export_svg", { ids: [circleId, arcId], path: arcPath, revision: arcStateCreated.revision });
    const afterExport = await call(client, "plasticity_status", {});
    for (const field of ["targetId", "documentToken", "revision", "undoDepth", "redoDepth"] as const) requireCondition(arcStateCreated[field] === afterExport[field], `SVG export changed Plasticity ${field}`);
    const svg = await readFile(arcPath, "utf8");
    requireCondition(report.bodies === 2 && report.lineSegments === 0 && report.circularSegments === 2 && report.fullCircles === 1, "SVG report does not distinguish one full circle and one trimmed arc");
    requireCondition(report.sourceUnits === "millimeter", "SVG report omitted millimeter units");
    const circleTag = svg.match(/<circle cx="([^"]+)" cy="([^"]+)" r="([^"]+)"\/>/u);
    requireCondition(circleTag, "SVG is missing the exact full-circle primitive");
    const frame = svgFrame(circlePlane.plane.normal);
    const projectedCircleCenter = project(circleSegment.circle.centerMm, circlePlane.plane.originMm, frame.xAxis, frame.yAxis);
    vectorNear([Number(circleTag[1]), Number(circleTag[2]), Number(circleTag[3])], [...projectedCircleCenter, 5], 1e-9, "full-circle SVG primitive versus native B-Rep center");
    const arcMatch = svg.match(/<path d="M ([^ ]+) ([^ ]+) A ([^ ]+) ([^ ]+) 0 ([01]) ([01]) ([^ ]+) ([^ ]+)"\/>/u);
    requireCondition(arcMatch, "SVG is missing a native circular arc primitive");
    const [startX, startY, rx, ry, largeArc, sweep, endX, endY] = arcMatch.slice(1).map(Number);
    near(rx!, 5, 1e-9, "SVG arc x radius");
    near(ry!, 5, 1e-9, "SVG arc y radius");
    requireCondition(largeArc === 1, "220-degree native arc was not exported with the large-arc flag");
    const projectedStart = project(nativeArc.segments[0].startMm, circlePlane.plane.originMm, frame.xAxis, frame.yAxis);
    const projectedEnd = project(nativeArc.segments[0].endMm, circlePlane.plane.originMm, frame.xAxis, frame.yAxis);
    vectorNear([startX!, startY!, endX!, endY!], [...projectedStart, ...projectedEnd], 1e-6, "SVG arc endpoints versus exact native B-Rep endpoints");
    const projectedTangent = projectVector(nativeArc.segments[0].startTangent, frame.xAxis, frame.yAxis);
    const projectedArcCenter = project(arcSegment.circle.centerMm, circlePlane.plane.originMm, frame.xAxis, frame.yAxis);
    const projectedRadial: [number, number] = [projectedStart[0] - projectedArcCenter[0], projectedStart[1] - projectedArcCenter[1]];
    const signedScreenSweep = projectedRadial[0] * projectedTangent[1] - projectedRadial[1] * projectedTangent[0];
    requireCondition((signedScreenSweep > 0 ? 1 : 0) === sweep, "SVG sweep flag disagrees with the exact native B-Rep start tangent");
    const chordAngle = 2 * Math.asin(Math.hypot(endX! - startX!, endY! - startY!) / 10);
    near(5 * (largeArc ? 2 * Math.PI - chordAngle : chordAngle), arcSegment.lengthMm, 1e-6, "SVG arc path length versus exact native edge length");
    requireCondition(sweep === 0 || sweep === 1, "SVG sweep flag is invalid");
    const bounds = report.boundsMm;
    vectorNear(bounds.size, [130 + 5 * Math.cos(30 * Math.PI / 180) - 95, 10], 1e-6, "combined exact SVG bounds");
    evidence.native = { circle: circleSegment, arc: arcSegment, exactMeasurementSource: "native-brep" };
    evidence.export = { report, sha256: createHash("sha256").update(svg).digest("hex"), fullCircleTag: circleTag[0], arcTag: arcMatch[0], nativeArcLengthMatchesSvgArc: true, documentUnchangedDuringExport: true };
  } catch (error) {
    evidence.failure = boundedError(error);
  } finally {
    if (client && initial && circleState && arcState) {
      try {
        const beforeUndo = await call(client, "plasticity_status", {});
        requireCondition(beforeUndo.documentToken === initial.documentToken, "Refusing cleanup because the connected document changed");
        requireCondition(beforeUndo.undoDepth === initial.undoDepth + 2, "Refusing cleanup because history does not contain exactly the two known successful test operations");
        let current = beforeUndo;
        for (let count = 0; count < 2; count += 1) current = await call(client, "plasticity_undo", { intent: "Remove one known temporary native circle or arc from the dedicated SVG acceptance scene", revision: current.revision });
        requireCondition(current.documentToken === initial.documentToken && current.bodies.length === initial.bodies.length && current.regions.length === initial.regions.length, "Undo cleanup did not restore the original fixture scene");
        requireCondition(current.bodies.map((body: any) => `${body.id}:${body.type}:${body.name}`).join("|") === initial.bodies.map((body: any) => `${body.id}:${body.type}:${body.name}`).join("|"), "Undo cleanup changed original body identities");
        requireCondition(current.undoDepth === initial.undoDepth, "Undo cleanup did not restore the original undo depth");
        evidence.cleanup = { undoneKnownOperations: 2, originalBodiesRestored: true, undoDepthRestored: true };
      } catch (error) { evidence.cleanupFailure = boundedError(error); }
    }
    await client?.close().catch(() => {});
  }
  evidence.completedAt = new Date().toISOString();
  const failed = typeof evidence.failure === "string" || typeof evidence.cleanupFailure === "string";
  await writeFile(join(output, failed ? "failure.json" : "evidence.json"), `${JSON.stringify(sanitizeEvidence(evidence), null, 2)}\n`, { flag: "wx", mode: 0o600 });
  if (failed) throw new Error(String(evidence.failure ?? evidence.cleanupFailure));
  console.log(JSON.stringify({ ok: true, output, svg: arcPath, evidence: evidencePath }, null, 2));
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const text = toolText(response);
  if ("isError" in response && response.isError) throw new Error(text);
  return JSON.parse(text);
}
function toolText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content");
  const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string");
  if (!item) throw new Error("MCP tool returned no text content");
  return item.text;
}
function onlyNewWireId(before: any, after: any): number {
  const previous = new Set(before.bodies.map((body: { id: number }) => body.id));
  const added = after.bodies.filter((body: { id: number; type: string }) => !previous.has(body.id) && body.type === "Wire");
  requireCondition(added.length === 1, "Each circle/arc command must add exactly one native Wire");
  return added[0].id;
}
function soleSegment(structure: any, id: number): any {
  const curve = structure.curves.find((item: { id: number }) => item.id === id);
  requireCondition(curve?.measurementSource === "native-brep" && curve.segments.length === 1, `Expected exactly one native B-Rep segment on Wire ${id}`);
  return curve.segments[0];
}
function stateSummary(state: any): Record<string, unknown> { return { targetId: state.targetId, documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodies: state.bodies.map((body: any) => ({ id: body.id, type: body.type, name: body.name })), regionCount: state.regions.length }; }
function vectorNear(actual: number[], expected: number[], tolerance: number, label: string): void { requireCondition(actual.length === expected.length, `${label} has the wrong number of coordinates`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function svgFrame(normalValues: number[]): { normal: [number, number, number]; xAxis: [number, number, number]; yAxis: [number, number, number] } {
  const normal = normalize3(normalValues);
  const candidate: [number, number, number] = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const projected = sub3(candidate, scale3(normal, dot3(candidate, normal)));
  const xAxis = normalize3(projected);
  return { normal, xAxis, yAxis: cross3(normal, xAxis) };
}
function project(point: number[], origin: number[], xAxis: number[], yAxis: number[]): [number, number] { const relative = sub3(point, origin); return [dot3(relative, xAxis), -dot3(relative, yAxis)]; }
function projectVector(vector: number[], xAxis: number[], yAxis: number[]): [number, number] { return [dot3(vector, xAxis), -dot3(vector, yAxis)]; }
function dot3(a: number[], b: number[]): number { return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!; }
function cross3(a: number[], b: number[]): [number, number, number] { return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!]; }
function sub3(a: number[], b: number[]): [number, number, number] { return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!]; }
function scale3(a: number[], amount: number): [number, number, number] { return [a[0]! * amount, a[1]! * amount, a[2]! * amount]; }
function normalize3(a: number[]): [number, number, number] { const length = Math.hypot(...a); requireCondition(length > 0 && Number.isFinite(length), "Native B-Rep returned an invalid plane axis"); return [a[0]! / length, a[1]! / length, a[2]! / length]; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label} expected ${expected} ± ${tolerance}, got ${actual}`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function boundedError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000); }
function requireValue(argv: string[], index: number, option: string): string { const value = argv[index]; if (!value) throw new Error(`${option} requires a value`); return value; }
function selectedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv { return Object.fromEntries(Object.entries(environment).filter(([key]) => key.startsWith("PLASTICITY_") || key === "PATH" || key === "HOME" || key === "TMPDIR")); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
