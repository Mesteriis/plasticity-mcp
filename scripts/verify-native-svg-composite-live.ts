#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
interface Options { help: boolean; target?: string; allowLive: boolean; output?: string }

export function parseArgs(argv: string[]): Options {
  if (argv.length === 0) return { help: true, allowLive: false };
  const options: Options = { help: false, allowLive: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-live") options.allowLive = true;
    else if (argument === "--target") options.target = requireValue(argv, ++index, "--target");
    else if (argument === "--output") options.output = requireValue(argv, ++index, "--output");
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Composite SVG acceptance requires an explicit --target Plasticity window ID");
  if (!options.allowLive) throw new Error("Composite SVG acceptance requires --allow-live");
  if (!options.output) throw new Error("Composite SVG acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-svg-composite-live.ts --help
  node scripts/verify-native-svg-composite-live.ts --target ID --allow-live --output NEW_DIRECTORY

Requires an explicitly selected Plasticity document. Creates and exports two
disposable profiles through the production stdio MCP: a 40 x 30 mm R2 Line/
Circle Wire and a joined closed Wire containing one NURBS and three Lines.
Checks native B-Rep structure, exact SVG commands and adaptive curve tolerance,
verifies Undo/Redo, then restores the original scene.`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const svgPath = join(output, "native-composite-profile.svg");
  const nurbsSvgPath = join(output, "native-nurbs-composite-profile.svg");
  const evidencePath = join(output, "evidence.json");
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target, workbenchUsed: false };
  let client: Client | undefined;
  let initial: any;
  let current: any;
  let expectedRevision: string | undefined;
  try {
    client = new Client({ name: "plasticity-native-svg-composite-live", version: "1.0.0" });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [join(projectRoot, "scripts", "run-server.ts")],
      cwd: projectRoot,
      env: { ...selectedEnvironment(process.env), PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" },
      stderr: "pipe",
    }));
    const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ["plasticity_list_windows", "plasticity_connect", "plasticity_create_polyline", "plasticity_create_nurbs_curve", "plasticity_join_curves", "plasticity_list_curve_vertices", "plasticity_fillet_curve_vertices", "plasticity_list_curve_directions", "plasticity_inspect_curve_structure", "plasticity_inspect_curve_planarity", "plasticity_evaluate_curve_segments", "plasticity_export_svg", "plasticity_undo", "plasticity_redo", "plasticity_status"]) {
      requireCondition(toolNames.includes(name), `MCP did not expose ${name}`);
    }
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initial = await call(client, "plasticity_connect", { targetId: options.target });
    expectedRevision = initial.revision;
    evidence.initial = summary(initial);
    const baseline = sceneSignature(initial);

    current = await call(client, "plasticity_create_polyline", {
      pointsMm: [[-20, -15, 0], [20, -15, 0], [20, 15, 0], [-20, 15, 0]],
      closed: true,
      intent: "Disposable native mixed-segment profile for SVG acceptance",
      revision: currentRevision(current, initial),
    });
    expectedRevision = current.revision;
    const profile = current.bodies.filter((body: { id: number; type: string }) => body.type === "Wire" && !initial.bodies.some((before: { id: number }) => before.id === body.id));
    requireCondition(profile.length === 1, "Rectangle creation did not add exactly one native Wire");
    const sourceWireId = profile[0].id as number;
    const vertices = await call(client, "plasticity_list_curve_vertices", {});
    const corners = vertices.vertices.filter((vertex: { bodyId: number }) => vertex.bodyId === sourceWireId);
    requireCondition(corners.length === 4 && corners.every((vertex: { endpoint: boolean }) => !vertex.endpoint), "Native rectangle did not expose four current interior vertices");

    current = await call(client, "plasticity_fillet_curve_vertices", {
      vertices: corners.map((vertex: { bodyId: number; vertexId: number }) => ({ bodyId: vertex.bodyId, vertexId: vertex.vertexId })),
      radiusMm: 2,
      intent: "Disposable R2 native corner fillet for mixed SVG acceptance",
      revision: current.revision,
    });
    expectedRevision = current.revision;
    const directions = await call(client, "plasticity_list_curve_directions", {});
    const candidateIds = new Set<number>([sourceWireId, ...current.bodies.filter((body: { id: number; type: string }) => body.type === "Wire" && !initial.bodies.some((before: { id: number }) => before.id === body.id)).map((body: { id: number }) => body.id)]);
    const candidate = current.bodies.find((body: { id: number; type: string }) => body.type === "Wire" && candidateIds.has(body.id)
      && directions.curves?.some((curve: { id: number; closed?: boolean; segments?: Array<{ curveType: string }> }) => curve.id === body.id && curve.closed && curve.segments?.length === 8));
    requireCondition(candidate, "Native R2 fillet did not produce one closed eight-segment Wire");
    const native = directions.curves.find((curve: { id: number }) => curve.id === candidate.id);
    const structure = await call(client, "plasticity_inspect_curve_structure", { ids: [candidate.id], revision: current.revision });
    const nativeSegments = structure.curves?.[0]?.segments;
    requireCondition(nativeSegments?.length === 8, "Exact B-Rep structure did not expose all eight native segments");
    const typeCounts = Object.fromEntries(["Line", "Circle"].map((type) => [type, nativeSegments.filter((segment: { curveType: string }) => segment.curveType === type).length]));
    requireCondition(typeCounts.Line === 4 && typeCounts.Circle === 4, `Expected four native Lines and four native circular arcs; received ${JSON.stringify(typeCounts)}`);
    const nativeArcRadii = nativeSegments.filter((segment: { curveType: string }) => segment.curveType === "Circle").map((segment: { circle: { radiusMm: number } | null }) => segment.circle?.radiusMm ?? Number.NaN).toSorted((a: number, b: number) => a - b);
    vectorNear(nativeArcRadii, [2, 2, 2, 2], 1e-6, "Native fillet radii");
    const lengths = nativeSegments.map((segment: { lengthMm: number }) => segment.lengthMm).toSorted((a: number, b: number) => a - b);
    const expectedLengths = [Math.PI, Math.PI, Math.PI, Math.PI, 26, 26, 36, 36].toSorted((a, b) => a - b);
    vectorNear(lengths, expectedLengths, 1e-5, "Native mixed-profile segment lengths");
    const dimensions = candidate.boundsMm.max.map((value: number, axis: number) => value - candidate.boundsMm.min[axis]);
    vectorNear(dimensions, [40, 30, 0], 1e-6, "Native mixed-profile dimensions");
    evidence.nativeProfile = { sourceWireId, resultWireId: candidate.id, closed: native.closed, segmentCount: nativeSegments.length, segmentTypeCounts: typeCounts, segmentLengthsMm: nativeSegments.map((segment: { curveType: string; lengthMm: number }) => ({ type: segment.curveType, lengthMm: segment.lengthMm })), nativeArcRadiiMm: nativeArcRadii, boundsMm: candidate.boundsMm };

    const report = await call(client, "plasticity_export_svg", { ids: [candidate.id], path: svgPath, revision: current.revision });
    const afterExport = await call(client, "plasticity_status", {});
    for (const field of ["targetId", "documentToken", "revision", "undoDepth", "redoDepth"] as const) requireCondition(current[field] === afterExport[field], `SVG export changed Plasticity ${field}`);
    const svg = await readFile(svgPath, "utf8");
    const paths = [...svg.matchAll(/<path d="([^"]+)"\/>/gu)].map((match) => match[1]!);
    const linePaths = paths.filter((path) => /^M [^ ]+ [^ ]+ L [^ ]+ [^ ]+$/u.test(path));
    const arcPaths = paths.filter((path) => / A [^ ]+ [^ ]+ 0 [01] [01] [^ ]+ [^ ]+$/u.test(path));
    requireCondition(paths.length === 8 && linePaths.length === 4 && arcPaths.length === 4, "One SVG profile did not preserve all four exact Lines and four circular arc commands");
    const svgArcRadii = arcPaths.map((path) => {
      const match = path.match(/ A ([^ ]+) ([^ ]+) 0 [01] [01] [^ ]+ [^ ]+$/u);
      requireCondition(match, "SVG circular arc command omitted its exact radii");
      return Number(match[1]);
    }).toSorted((a, b) => a - b);
    vectorNear(svgArcRadii, nativeArcRadii, 1e-12, "SVG arc radii versus native B-Rep");
    requireCondition(report.bodies === 1 && report.lineSegments === 4 && report.circularSegments === 4 && report.approximatedSegments === 0, "SVG report does not match the mixed native Wire structure");
    vectorNear([...report.boundsMm.size], [40, 30], 1e-6, "SVG profile dimensions");
    evidence.svgExport = { report, svgPathCount: paths.length, exactLineCommandCount: linePaths.length, exactArcCommandCount: arcPaths.length, svgArcRadiiMm: svgArcRadii, sha256: createHash("sha256").update(svg).digest("hex"), revisionAndHistoryUnchanged: true };

    current = await call(client, "plasticity_undo", { intent: "Undo disposable SVG profile fillet", revision: current.revision });
    expectedRevision = current.revision;
    const unfilletedDirections = await call(client, "plasticity_list_curve_directions", {});
    const possibleRestoredWires = current.bodies.filter((body: { id: number; type: string }) => body.type === "Wire" && (body.id === sourceWireId || !initial.bodies.some((before: { id: number }) => before.id === body.id)));
    const restoredCandidates = await Promise.all(possibleRestoredWires.map(async (body: { id: number }) => {
      const curve = unfilletedDirections.curves?.find((item: { id: number }) => item.id === body.id);
      if (!curve?.closed || curve.segments?.length !== 4) return null;
      const structure = await call(client!, "plasticity_inspect_curve_structure", { ids: [body.id], revision: current.revision });
      return { id: body.id, curve, structure: structure.curves?.[0] };
    }));
    const unfilleted = restoredCandidates.find((candidate) => candidate?.structure?.segments?.length === 4 && candidate.structure.segments.every((segment: { curveType: string }) => segment.curveType === "Line"));
    evidence.afterFilletUndo = { state: summary(current), candidateIds: possibleRestoredWires.map((body: { id: number }) => body.id), nativeProfileId: unfilleted?.id ?? null, segmentTypes: unfilleted?.structure?.segments?.map((segment: { curveType: string }) => segment.curveType) ?? [] };
    requireCondition(unfilleted, "Undo did not restore the original four-Line profile");
    current = await call(client, "plasticity_redo", { intent: "Redo disposable SVG profile fillet", revision: current.revision });
    expectedRevision = current.revision;
    const redone = await call(client, "plasticity_list_curve_directions", {});
    requireCondition(redone.curves?.some((curve: { id: number; closed?: boolean; segments?: Array<{ curveType: string }> }) => curve.id === candidate.id && curve.closed && curve.segments?.length === 8), "Redo did not restore the same native mixed-profile Wire ID");
    current = await call(client, "plasticity_undo", { intent: "Undo disposable SVG profile fillet for cleanup", revision: current.revision });
    expectedRevision = current.revision;
    current = await call(client, "plasticity_undo", { intent: "Remove disposable SVG profile", revision: current.revision });
    expectedRevision = current.revision;
    requireCondition(sceneSignature(current) === baseline, "Profile cleanup did not restore the original Plasticity scene");

    const nurbsCreated = await call(client, "plasticity_create_nurbs_curve", {
      pointsMm: [[0, 0, 0], [10, 12, 0], [20, -8, 0], [30, 0, 0]],
      closed: false,
      intent: "Disposable NURBS side for a joined adaptive SVG profile",
      revision: current.revision,
    });
    current = nurbsCreated;
    expectedRevision = current.revision;
    const nurbsBody = current.bodies.find((body: { id: number; type: string }) => body.type === "Wire" && !initial.bodies.some((before: { id: number }) => before.id === body.id));
    requireCondition(nurbsBody, "Native NURBS creation did not add a Wire");
    const nurbsId = nurbsBody.id as number;
    current = await call(client, "plasticity_create_polyline", {
      pointsMm: [[30, 0, 0], [30, -10, 0], [0, -10, 0], [0, 0, 0]],
      closed: false,
      intent: "Disposable three-Line side for the joined adaptive SVG profile",
      revision: current.revision,
    });
    expectedRevision = current.revision;
    const lineBody = current.bodies.find((body: { id: number; type: string }) => body.type === "Wire" && body.id !== nurbsId && !initial.bodies.some((before: { id: number }) => before.id === body.id));
    requireCondition(lineBody, "Three-Line polyline creation did not add the second Wire");
    const lineId = lineBody.id as number;
    current = await call(client, "plasticity_join_curves", { ids: [nurbsId, lineId], intent: "Join NURBS and line segments into one closed SVG profile", revision: current.revision });
    expectedRevision = current.revision;
    const joined = current.bodies.filter((body: { id: number; type: string }) => body.type === "Wire" && !initial.bodies.some((before: { id: number }) => before.id === body.id));
    requireCondition(joined.length === 1, `Join Curves did not replace its inputs with one Wire; found ${joined.length}`);
    const joinedId = joined[0].id as number;
    const joinedDirections = await call(client, "plasticity_list_curve_directions", {});
    const joinedNative = joinedDirections.curves?.find((curve: { id: number }) => curve.id === joinedId);
    requireCondition(joinedNative?.measurementSource === "native-brep" && joinedNative.closed && joinedNative.segments?.length === 4, "Joined profile is not one closed four-segment B-Rep Wire");
    const joinedStructure = await call(client, "plasticity_inspect_curve_structure", { ids: [joinedId], revision: current.revision });
    const joinedSegments = joinedStructure.curves?.[0]?.segments;
    requireCondition(joinedSegments?.length === 4, "Joined B-Rep structure does not contain four segments");
    const joinedTypeCounts = Object.fromEntries(["BCurve", "Line"].map((type) => [type, joinedSegments.filter((segment: { curveType: string }) => segment.curveType === type).length]));
    requireCondition(joinedTypeCounts.BCurve === 1 && joinedTypeCounts.Line === 3, `Joined profile is not one native BCurve plus three Lines: ${JSON.stringify(joinedTypeCounts)}`);
    const nurbsSegment = joinedSegments.find((segment: { curveType: string }) => segment.curveType === "BCurve");
    requireCondition(nurbsSegment, "Joined B-Rep did not preserve its native NURBS segment");
    const joinedPlanarity = await call(client, "plasticity_inspect_curve_planarity", { ids: [joinedId], revision: current.revision });
    const joinedPlane = joinedPlanarity.curves?.find((curve: { id: number }) => curve.id === joinedId)?.plane;
    requireCondition(joinedPlane && joinedPlanarity.curves?.find((curve: { id: number }) => curve.id === joinedId)?.planar === true, "Joined NURBS profile does not have an exact native planar B-Rep plane");
    const nurbsProfileExport = await call(client, "plasticity_export_svg", { ids: [joinedId], path: nurbsSvgPath, curveChordToleranceMm: 0.02, curveChordAngleDegrees: 5, revision: current.revision });
    const afterNurbsExport = await call(client, "plasticity_status", {});
    for (const field of ["targetId", "documentToken", "revision", "undoDepth", "redoDepth"] as const) requireCondition(current[field] === afterNurbsExport[field], `Mixed NURBS SVG export changed Plasticity ${field}`);
    requireCondition(nurbsProfileExport.bodies === 1 && nurbsProfileExport.lineSegments === 3 && nurbsProfileExport.approximatedSegments === 1 && nurbsProfileExport.maxChordDeviationMm <= 0.02, "Mixed NURBS SVG export report does not preserve exact lines and the requested approximation tolerance");
    const nurbsSvg = await readFile(nurbsSvgPath, "utf8");
    const adaptivePath = nurbsSvg.match(/<path d="([^"]+)" data-curve-type="(?:BCurve|NurbsCurve)" data-approximation="adaptive-chord"\/>/u)?.[1];
    requireCondition(adaptivePath, "Joined NURBS SVG segment is not marked as an adaptive chord approximation");
    const adaptivePoints = [...adaptivePath.matchAll(/[ML] ([^ ]+) ([^ ]+)/gu)].map((match) => [Number(match[1]), Number(match[2])]);
    requireCondition(adaptivePoints.length >= 3 && adaptivePoints.flat().every(Number.isFinite), "Joined NURBS SVG polyline is too short or has invalid coordinates");
    const exactSamples = await call(client, "plasticity_evaluate_curve_segments", {
      samples: [0.107, 0.283, 0.431, 0.569, 0.713, 0.893].map((normalizedParameter) => ({ bodyId: joinedId, segmentEntityId: nurbsSegment.entityId, normalizedParameter })),
      revision: current.revision,
    });
    const deviations = exactSamples.samples.map((sample: { positionMm: number[] }) => pointPolylineDistanceMm(projectToSvg(sample.positionMm, joinedPlane), adaptivePoints));
    const maxSampleDeviationMm = Math.max(...deviations);
    requireCondition(maxSampleDeviationMm <= 0.02, `Joined NURBS SVG differs from exact B-Rep samples by ${maxSampleDeviationMm} mm`);
    evidence.joinedNurbsProfile = {
      sourceWireIds: [nurbsId, lineId], resultWireId: joinedId,
      nativeSegmentTypes: joinedSegments.map((segment: { curveType: string }) => segment.curveType),
      nativeClosed: joinedNative.closed,
      export: nurbsProfileExport,
      adaptiveSvgPointCount: adaptivePoints.length,
      exactNativeSampleCount: deviations.length,
      maxExactSampleDeviationMm: maxSampleDeviationMm,
      svgSha256: createHash("sha256").update(nurbsSvg).digest("hex"),
    };
    current = await call(client, "plasticity_undo", { intent: "Undo joined NURBS SVG profile", revision: current.revision });
    expectedRevision = current.revision;
    requireCondition(current.bodies.some((body: { id: number }) => body.id === nurbsId) && current.bodies.some((body: { id: number }) => body.id === lineId), "Undo Join Curves did not restore both source Wires");
    current = await call(client, "plasticity_redo", { intent: "Redo joined NURBS SVG profile", revision: current.revision });
    expectedRevision = current.revision;
    requireCondition(current.bodies.some((body: { id: number }) => body.id === joinedId), "Redo Join Curves did not restore the same joined Wire ID");
    current = await call(client, "plasticity_undo", { intent: "Undo joined NURBS SVG profile for cleanup", revision: current.revision });
    expectedRevision = current.revision;
    current = await call(client, "plasticity_undo", { intent: "Remove joined NURBS profile line side", revision: current.revision });
    expectedRevision = current.revision;
    current = await call(client, "plasticity_undo", { intent: "Remove joined NURBS profile curve side", revision: current.revision });
    expectedRevision = current.revision;
    requireCondition(sceneSignature(current) === baseline, "Joined NURBS profile cleanup did not restore the original Plasticity scene");
    evidence.cleanup = { final: summary(current), originalSceneRestored: true, stableFilletWireIdAcrossRedo: true, stableJoinedNurbsWireIdAcrossRedo: true };
    evidence.completedAt = new Date().toISOString();
    await writeFile(evidencePath, `${JSON.stringify(sanitizeEvidence(evidence), null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ ok: true, output, svg: svgPath, evidence: evidencePath }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    await writeFile(join(output, "failure.json"), `${JSON.stringify(sanitizeEvidence(evidence), null, 2)}\n`, { flag: "wx", mode: 0o600 }).catch(() => {});
    throw error;
  } finally {
    if (client && initial && expectedRevision) {
      const status = await call(client, "plasticity_status", {}).catch(() => null);
      if (status && status.targetId === options.target && status.documentToken === initial.documentToken && status.revision === expectedRevision) {
        let cleanupStatus = status;
        while (cleanupStatus.undoDepth > initial.undoDepth) {
          try {
            const restored = await call(client, "plasticity_undo", { intent: "Guarded cleanup of disposable composite SVG acceptance", revision: expectedRevision });
            expectedRevision = restored.revision;
            if (sceneSignature(restored) === sceneSignature(initial)) break;
            const next = await call(client, "plasticity_status", {});
            if (next.targetId !== options.target || next.documentToken !== initial.documentToken || next.revision !== expectedRevision) break;
            if (next.undoDepth >= cleanupStatus.undoDepth) break;
            cleanupStatus = next;
          } catch { break; }
        }
      }
    }
    await client?.close().catch(() => {});
  }
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
function summary(state: any): Record<string, unknown> { return { targetId: state.targetId, documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyIds: state.bodies.map((body: { id: number }) => body.id) }; }
function sceneSignature(state: any): string { return JSON.stringify({ documentToken: state.documentToken, title: state.title, bodies: state.bodies, regions: state.regions, construction: state.construction, materials: state.materials ?? [], measurements: state.measurements ?? [], sectionAnalyses: state.sectionAnalyses ?? [], instances: state.instances ?? [], referenceMeshes: state.referenceMeshes ?? [], activeGroupId: state.activeGroupId ?? null, groups: state.groups ?? [], undoDepth: state.undoDepth }); }
function currentRevision(current: any, initial: any): string { return current?.revision ?? initial.revision; }
function vectorNear(actual: number[], expected: number[], tolerance: number, label: string): void { requireCondition(actual.length === expected.length, `${label} has the wrong number of values`); actual.forEach((value, index) => requireCondition(Number.isFinite(value) && Math.abs(value - expected[index]!) <= tolerance, `${label}[${index}] differs from expected native value`)); }
export function pointPolylineDistanceMm(point: number[], points: number[][]): number {
  requireCondition(point.length === 2 && point.every(Number.isFinite) && points.length >= 2, "Polyline distance requires a finite 2D point and at least one segment");
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!;
    const end = points[index]!;
    const dx = end[0]! - start[0]!;
    const dy = end[1]! - start[1]!;
    const lengthSquared = dx * dx + dy * dy;
    requireCondition(start.length === 2 && end.length === 2 && start.every(Number.isFinite) && end.every(Number.isFinite) && lengthSquared > 0, "Polyline contains an invalid or zero-length segment");
    const projection = Math.max(0, Math.min(1, ((point[0]! - start[0]!) * dx + (point[1]! - start[1]!) * dy) / lengthSquared));
    const nearestX = start[0]! + projection * dx;
    const nearestY = start[1]! + projection * dy;
    minimum = Math.min(minimum, Math.hypot(point[0]! - nearestX, point[1]! - nearestY));
  }
  return minimum;
}
export function projectToSvg(point: number[], plane: { originMm: number[]; normal: number[] }): number[] {
  requireCondition(point.length === 3 && point.every(Number.isFinite) && plane.originMm.length === 3 && plane.normal.length === 3, "SVG projection requires finite 3D point and plane vectors");
  const normalLength = Math.hypot(...plane.normal);
  requireCondition(normalLength > 0 && Number.isFinite(normalLength), "SVG projection plane normal is invalid");
  const normal = plane.normal.map((value) => value / normalLength);
  const candidate = Math.abs(normal[0]!) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const candidateDotNormal = dot(candidate, normal);
  const projectedX = candidate.map((value, index) => value - normal[index]! * candidateDotNormal);
  const xLength = Math.hypot(...projectedX);
  requireCondition(xLength > 0, "SVG projection plane does not define a stable X axis");
  const xAxis = projectedX.map((value) => value / xLength);
  const yAxis = cross(normal, xAxis);
  const relative = point.map((value, index) => value - plane.originMm[index]!);
  requireCondition(Math.abs(dot(relative, normal)) <= 1e-6, "Exact B-Rep sample does not lie on the SVG projection plane");
  return [dot(relative, xAxis), -dot(relative, yAxis)];
}
function dot(left: number[], right: number[]): number { return left.reduce((total, value, index) => total + value * right[index]!, 0); }
function cross(left: number[], right: number[]): number[] { return [left[1]! * right[2]! - left[2]! * right[1]!, left[2]! * right[0]! - left[0]! * right[2]!, left[0]! * right[1]! - left[1]! * right[0]!]; }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function boundedError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000); }
function requireValue(argv: string[], index: number, option: string): string { const value = argv[index]; if (!value) throw new Error(`${option} requires a value`); return value; }
function selectedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv { return Object.fromEntries(Object.entries(environment).filter(([key]) => key.startsWith("PLASTICITY_") || key === "PATH" || key === "HOME" || key === "TMPDIR")); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
