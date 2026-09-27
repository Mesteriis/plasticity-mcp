#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINEAR_TOLERANCE_MM = 0.01;

export interface NativeSketchPrimitivesAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeSketchPrimitivesAcceptanceArgs(argv: string[]): NativeSketchPrimitivesAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: NativeSketchPrimitivesAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live native-sketch-primitives acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-sketch-primitives acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-sketch-primitives acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-sketch-primitives-live.ts --help
  node scripts/verify-native-sketch-primitives-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, never chooses a window
automatically, verifies exact native diameter, three-point, and fixed-radius tangent circles, center, three-point, and tangent arcs,
plus ellipse and regular polygon geometry,
checks Undo/Redo, cleans up with native Undo, and writes sanitized evidence.`;

async function main(): Promise<void> {
  const options = parseNativeSketchPrimitivesAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    targetId: options.target!,
    workbenchUsed: false,
  };
  let live: LiveMcp | undefined;
  let initialState: any;
  try {
    live = await startMcp(join(output, "strength-store"));
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initialState = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireEmptyDocument(initialState, "initial document");
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-sketch-primitives-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_center_arc", {
      centerMm: [0, 0, 0], radiusMm: 10, startAngleDegrees: 0, sweepAngleDegrees: 90,
      intent: "Approved disposable exact positive native arc acceptance", revision: initialState.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 1, "Positive arc did not create exactly one history step");
    const positiveArcId = requireAddedWire(initialState, state, "positive arc").id;
    let curves = await call(live.client, "plasticity_list_curve_directions", {});
    const positiveArc = requireArc(curves, positiveArcId, [10, 0, 0], [0, 10, 0], Math.PI * 5);

    const beforeNegative = state;
    state = await call(live.client, "plasticity_create_center_arc", {
      centerMm: [30, 0, 0], radiusMm: 8, startAngleDegrees: 30, sweepAngleDegrees: -120,
      intent: "Approved disposable exact negative native arc acceptance", revision: state.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 2, "Negative arc did not create exactly one history step");
    const negativeArcId = requireAddedWire(beforeNegative, state, "negative arc").id;
    curves = await call(live.client, "plasticity_list_curve_directions", {});
    const negativeStart = [30 + 8 * Math.cos(Math.PI / 6), 4, 0];
    const negativeEnd = [30, -8, 0];
    const negativeArc = requireArc(curves, negativeArcId, negativeStart, negativeEnd, 8 * 2 * Math.PI / 3);

    const beforeThreePoint = state;
    state = await call(live.client, "plasticity_create_three_point_arc", {
      startMm: [90, 0, 0], throughMm: [80, -10, 0], endMm: [80, 10, 0],
      intent: "Approved disposable exact native three-point major arc acceptance", revision: state.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 3, "Three-point arc did not create exactly one history step");
    const threePointArcBody = requireAddedWire(beforeThreePoint, state, "three-point arc");
    requireBounds(threePointArcBody.boundsMm, [70, -10, 0], [90, 10, 0], "three-point major arc");
    curves = await call(live.client, "plasticity_list_curve_directions", {});
    const threePointArc = requireArc(curves, threePointArcBody.id, [90, 0, 0], [80, 10, 0], 15 * Math.PI);

    const beforeTwoPointCircle = state;
    state = await call(live.client, "plasticity_create_two_point_circle", {
      diameterStartMm: [110, 0, 0], diameterEndMm: [130, 0, 0], normal: [0, 0, 1],
      intent: "Approved disposable exact native diameter-circle acceptance", revision: state.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 4, "Two-point circle did not create exactly one history step");
    const twoPointCircleBody = requireAddedWire(beforeTwoPointCircle, state, "two-point circle");
    requireBounds(twoPointCircleBody.boundsMm, [110, -10, 0], [130, 10, 0], "two-point circle");
    curves = await call(live.client, "plasticity_list_curve_directions", {});
    const twoPointCircle = requireCircle(curves, twoPointCircleBody.id, 20 * Math.PI);
    requireRegionForWire(state, twoPointCircleBody.id, "two-point circle");

    const beforeThreePointCircle = state;
    state = await call(live.client, "plasticity_create_three_point_circle", {
      firstMm: [160, 0, 0], secondMm: [150, 10, 0], thirdMm: [140, 0, 0],
      intent: "Approved disposable exact native three-point-circle acceptance", revision: state.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 5, "Three-point circle did not create exactly one history step");
    const threePointCircleBody = requireAddedWire(beforeThreePointCircle, state, "three-point circle");
    requireBounds(threePointCircleBody.boundsMm, [140, -10, 0], [160, 10, 0], "three-point circle");
    curves = await call(live.client, "plasticity_list_curve_directions", {});
    const threePointCircle = requireCircle(curves, threePointCircleBody.id, 20 * Math.PI);
    requireRegionForWire(state, threePointCircleBody.id, "three-point circle");

    const beforeEllipse = state;
    state = await call(live.client, "plasticity_create_ellipse", {
      centerMm: [0, 30, 0], majorRadiusMm: 20, minorRadiusMm: 10, angleDegrees: 0,
      intent: "Approved disposable exact native ellipse acceptance", revision: state.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 6, "Ellipse did not create exactly one history step");
    const ellipse = requireAddedWire(beforeEllipse, state, "ellipse");
    requireBounds(ellipse.boundsMm, [-20, 20, 0], [20, 40, 0], "ellipse");
    curves = await call(live.client, "plasticity_list_curve_directions", {});
    const ellipseCurve = curves.curves.find((curve: { id: number }) => curve.id === ellipse.id);
    requireCondition(ellipseCurve?.measurementSource === "native-brep" && ellipseCurve.closed === true && ellipseCurve.segments.length === 1, "Ellipse is not one exact closed native curve");
    near(ellipseCurve.segments[0].lengthMm, 96.88448270543226, LINEAR_TOLERANCE_MM, "ellipse perimeter");
    requireRegionForWire(state, ellipse.id, "ellipse");

    const beforePolygon = state;
    state = await call(live.client, "plasticity_create_regular_polygon", {
      centerMm: [50, 30, 0], radiusMm: 10, radiusMode: "inradius", vertexCount: 6, angleDegrees: 0,
      intent: "Approved disposable exact native regular polygon acceptance", revision: state.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 7, "Polygon did not create exactly one history step");
    const polygon = requireAddedWire(beforePolygon, state, "polygon");
    const circumradius = 10 / Math.cos(Math.PI / 6);
    requireBounds(polygon.boundsMm, [50 - circumradius, 20, 0], [50 + circumradius, 40, 0], "polygon");
    curves = await call(live.client, "plasticity_list_curve_directions", {});
    const polygonCurve = curves.curves.find((curve: { id: number }) => curve.id === polygon.id);
    requireCondition(polygonCurve?.measurementSource === "native-brep" && polygonCurve.closed === true && polygonCurve.segments.length === 6, "Polygon is not one exact closed six-segment native Wire");
    const expectedSide = 20 * Math.tan(Math.PI / 6);
    polygonCurve.segments.forEach((segment: { lengthMm: number }, index: number) => near(segment.lengthMm, expectedSide, LINEAR_TOLERANCE_MM, `polygon side ${index}`));
    requireRegionForWire(state, polygon.id, "polygon");

    const beforeSourceLine = state;
    state = await call(live.client, "plasticity_create_polyline", {
      pointsMm: [[0, 60, 0], [20, 60, 0]], closed: false,
      intent: "Approved disposable native tangent-arc source line", revision: state.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 8, "Tangent source line did not create exactly one history step");
    const sourceLine = requireAddedWire(beforeSourceLine, state, "tangent source line");
    curves = await call(live.client, "plasticity_list_curve_directions", {});
    const sourceCurve = curves.curves.find((curve: { id: number }) => curve.id === sourceLine.id);
    requireCondition(sourceCurve?.segments.length === 1, "Tangent source line is not one exact native segment");
    vectorNear(sourceCurve.segments[0].startMm, [0, 60, 0], LINEAR_TOLERANCE_MM, "tangent source start");
    vectorNear(sourceCurve.segments[0].endMm, [20, 60, 0], LINEAR_TOLERANCE_MM, "tangent source end");

    const beforeMinorTangent = state;
    state = await call(live.client, "plasticity_create_tangent_arc", {
      bodyId: sourceLine.id, segmentEntityId: sourceCurve.segments[0].entityId, startAt: "end",
      endMm: [30, 70, 0], flipTangent: false,
      intent: "Approved disposable exact native tangent minor arc acceptance", revision: state.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 9, "Minor tangent arc did not create exactly one history step");
    const minorTangentBody = requireAddedWire(beforeMinorTangent, state, "minor tangent arc");
    requireBounds(minorTangentBody.boundsMm, [20, 60, 0], [30, 70, 0], "minor tangent arc");
    curves = await call(live.client, "plasticity_list_curve_directions", {});
    const minorTangent = requireArc(curves, minorTangentBody.id, [20, 60, 0], [30, 70, 0], 5 * Math.PI);
    vectorNear(minorTangent.startTangent, [1, 0, 0], 1e-9, "minor tangent continuity");

    const beforeMajorTangent = state;
    state = await call(live.client, "plasticity_create_tangent_arc", {
      bodyId: sourceLine.id, segmentEntityId: sourceCurve.segments[0].entityId, startAt: "end",
      endMm: [30, 70, 0], flipTangent: true,
      intent: "Approved disposable exact native tangent major arc acceptance", revision: state.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 10, "Major tangent arc did not create exactly one history step");
    const majorTangentBody = requireAddedWire(beforeMajorTangent, state, "major tangent arc");
    requireBounds(majorTangentBody.boundsMm, [10, 60, 0], [30, 80, 0], "major tangent arc");
    curves = await call(live.client, "plasticity_list_curve_directions", {});
    const majorTangent = requireArc(curves, majorTangentBody.id, [20, 60, 0], [30, 70, 0], 15 * Math.PI);
    vectorNear(majorTangent.startTangent, [-1, 0, 0], 1e-9, "major tangent sense");
    requireCondition(state.regions.some((region: { sketchWireIds: number[] }) =>
      region.sketchWireIds.includes(minorTangentBody.id) && region.sketchWireIds.includes(majorTangentBody.id)),
    "Complementary tangent arcs did not create their closed-loop Region");

    const beforeFirstTangentCircleSource = state;
    state = await call(live.client, "plasticity_create_polyline", {
      pointsMm: [[80, 100, 0], [120, 100, 0]], closed: false,
      intent: "Approved disposable first native tangent-circle source line", revision: state.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 11, "First tangent-circle source line did not create exactly one history step");
    const firstTangentCircleSource = requireAddedWire(beforeFirstTangentCircleSource, state, "first tangent-circle source line");

    const beforeSecondTangentCircleSource = state;
    state = await call(live.client, "plasticity_create_polyline", {
      pointsMm: [[100, 80, 0], [100, 120, 0]], closed: false,
      intent: "Approved disposable second native tangent-circle source line", revision: state.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 12, "Second tangent-circle source line did not create exactly one history step");
    const secondTangentCircleSource = requireAddedWire(beforeSecondTangentCircleSource, state, "second tangent-circle source line");
    curves = await call(live.client, "plasticity_list_curve_directions", {});
    const firstTangentCircleSourceCurve = curves.curves.find((curve: { id: number }) => curve.id === firstTangentCircleSource.id);
    const secondTangentCircleSourceCurve = curves.curves.find((curve: { id: number }) => curve.id === secondTangentCircleSource.id);
    requireCondition(firstTangentCircleSourceCurve?.segments.length === 1 && secondTangentCircleSourceCurve?.segments.length === 1,
      "Tangent-circle sources are not exact single-segment native Wires");

    const beforeTangentCircle = state;
    state = await call(live.client, "plasticity_create_tangent_circle", {
      first: { bodyId: firstTangentCircleSource.id, segmentEntityId: firstTangentCircleSourceCurve.segments[0].entityId },
      second: { bodyId: secondTangentCircleSource.id, segmentEntityId: secondTangentCircleSourceCurve.segments[0].entityId },
      solutionPointMm: [105, 105, 0], radiusMm: 5, normal: [0, 0, 1],
      intent: "Approved disposable exact native fixed-radius tangent-circle acceptance", revision: state.revision,
    });
    requireCondition(state.undoDepth === initialState.undoDepth + 13, "Tangent circle did not create exactly one history step");
    const tangentCircleBody = requireAddedWire(beforeTangentCircle, state, "tangent circle");
    requireBounds(tangentCircleBody.boundsMm, [100, 100, 0], [110, 110, 0], "tangent circle");
    curves = await call(live.client, "plasticity_list_curve_directions", {});
    const tangentCircle = requireCircle(curves, tangentCircleBody.id, 10 * Math.PI);
    requireRegionForWire(state, tangentCircleBody.id, "tangent circle");
    const tangentIntersections = await call(live.client, "plasticity_list_curve_intersections", {});
    const firstTangency = requireIntersection(tangentIntersections, firstTangentCircleSource.id, tangentCircleBody.id, [105, 100, 0], "first tangent-circle source");
    const secondTangency = requireIntersection(tangentIntersections, secondTangentCircleSource.id, tangentCircleBody.id, [100, 105, 0], "second tangent-circle source");

    evidence.geometry = {
      positiveArc: { bodyId: positiveArcId, startMm: positiveArc.startMm, endMm: positiveArc.endMm, lengthMm: positiveArc.lengthMm },
      negativeArc: { bodyId: negativeArcId, startMm: negativeArc.startMm, endMm: negativeArc.endMm, lengthMm: negativeArc.lengthMm },
      threePointMajorArc: { bodyId: threePointArcBody.id, boundsMm: threePointArcBody.boundsMm, startMm: threePointArc.startMm, endMm: threePointArc.endMm, lengthMm: threePointArc.lengthMm },
      twoPointCircle: { bodyId: twoPointCircleBody.id, boundsMm: twoPointCircleBody.boundsMm, circumferenceMm: twoPointCircle.circumferenceMm, region: true },
      threePointCircle: { bodyId: threePointCircleBody.id, boundsMm: threePointCircleBody.boundsMm, circumferenceMm: threePointCircle.circumferenceMm, region: true },
      ellipse: { bodyId: ellipse.id, boundsMm: ellipse.boundsMm, perimeterMm: ellipseCurve.segments[0].lengthMm, region: true },
      polygon: { bodyId: polygon.id, boundsMm: polygon.boundsMm, sideLengthsMm: polygonCurve.segments.map((segment: { lengthMm: number }) => segment.lengthMm), radiusMode: "inradius", region: true },
      tangentArcs: {
        sourceBodyId: sourceLine.id,
        sourceSegmentEntityId: sourceCurve.segments[0].entityId,
        minor: { bodyId: minorTangentBody.id, boundsMm: minorTangentBody.boundsMm, startTangent: minorTangent.startTangent, lengthMm: minorTangent.lengthMm },
        major: { bodyId: majorTangentBody.id, boundsMm: majorTangentBody.boundsMm, startTangent: majorTangent.startTangent, lengthMm: majorTangent.lengthMm },
        complementaryPairRegion: true,
      },
      tangentCircle: {
        bodyId: tangentCircleBody.id,
        boundsMm: tangentCircleBody.boundsMm,
        circumferenceMm: tangentCircle.circumferenceMm,
        radiusMm: 5,
        sources: [
          { bodyId: firstTangentCircleSource.id, segmentEntityId: firstTangentCircleSourceCurve.segments[0].entityId },
          { bodyId: secondTangentCircleSource.id, segmentEntityId: secondTangentCircleSourceCurve.segments[0].entityId },
        ],
        tangencyPointsMm: [firstTangency.positionMm, secondTangency.positionMm],
        region: true,
      },
      measurementSource: "native-brep",
    };

    for (let index = 0; index < 13; index += 1) {
      state = await call(live.client, "plasticity_undo", { intent: "Verify native sketch primitive Undo", revision: state.revision });
    }
    requireEmptyDocument(state, "document after thirteen Undo operations");
    for (let index = 0; index < 13; index += 1) {
      state = await call(live.client, "plasticity_redo", { intent: "Verify native sketch primitive Redo", revision: state.revision });
    }
    const redoneWires = state.bodies.filter((body: { type: string }) => body.type === "Wire");
    evidence.undoRedo = {
      undoRestoredEmptyScene: true,
      redoBodyCount: state.bodies.length,
      redoWireCount: redoneWires.length,
      redoRegionCount: state.regions.length,
      redoBodies: state.bodies.map((body: { id: number; type: string; boundsMm: unknown }) => ({ id: body.id, type: body.type, boundsMm: body.boundsMm })),
    };
    requireCondition(redoneWires.length === 13 && state.regions.length === 7, `Redo did not restore thirteen Wires and seven Regions: ${redoneWires.length} Wires, ${state.regions.length} Regions`);

    while (state.undoDepth > initialState.undoDepth) {
      state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable native sketch primitives acceptance", revision: state.revision });
    }
    requireEmptyDocument(state, "cleaned document");
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true };
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

function requireAddedWire(before: any, after: any, label: string): any {
  const beforeIds = new Set(before.bodies.map((body: { id: number }) => body.id));
  const added = after.bodies.filter((body: { id: number; type: string }) => !beforeIds.has(body.id));
  requireCondition(added.length === 1 && added[0].type === "Wire", `${label} did not add exactly one native Wire`);
  return added[0];
}

function requireArc(report: any, bodyId: number, startMm: number[], endMm: number[], lengthMm: number): { startMm: number[]; endMm: number[]; startTangent: number[]; lengthMm: number } {
  const curve = report.curves.find((candidate: { id: number }) => candidate.id === bodyId);
  requireCondition(curve?.measurementSource === "native-brep" && curve.closed === false && curve.segments.length === 1, `Arc ${bodyId} is not one exact open native curve`);
  const segment = curve.segments[0];
  vectorNear(segment.startMm, startMm, LINEAR_TOLERANCE_MM, `arc ${bodyId} start`);
  vectorNear(segment.endMm, endMm, LINEAR_TOLERANCE_MM, `arc ${bodyId} end`);
  near(segment.lengthMm, lengthMm, LINEAR_TOLERANCE_MM, `arc ${bodyId} length`);
  return { startMm: segment.startMm, endMm: segment.endMm, startTangent: segment.startTangent, lengthMm: segment.lengthMm };
}

function requireCircle(report: any, bodyId: number, circumferenceMm: number): { circumferenceMm: number } {
  const curve = report.curves.find((candidate: { id: number }) => candidate.id === bodyId);
  requireCondition(curve?.measurementSource === "native-brep" && curve.closed === true && curve.segments.length === 1, `Circle ${bodyId} is not one exact closed native curve`);
  near(curve.segments[0].lengthMm, circumferenceMm, LINEAR_TOLERANCE_MM, `circle ${bodyId} circumference`);
  return { circumferenceMm: curve.segments[0].lengthMm };
}

function requireIntersection(report: any, firstBodyId: number, secondBodyId: number, positionMm: number[], label: string): { positionMm: number[] } {
  const bodyIds = [firstBodyId, secondBodyId].sort((left, right) => left - right);
  const matches = report.intersections.filter((candidate: { bodyIds: number[] }) =>
    candidate.bodyIds.length === 2 && candidate.bodyIds[0] === bodyIds[0] && candidate.bodyIds[1] === bodyIds[1]);
  requireCondition(matches.length === 1 && matches[0].measurementSource === "native-brep", `${label} does not have exactly one native intersection with the tangent circle`);
  vectorNear(matches[0].positionMm, positionMm, LINEAR_TOLERANCE_MM, `${label} tangency point`);
  return { positionMm: matches[0].positionMm };
}

function requireRegionForWire(state: any, bodyId: number, label: string): void {
  requireCondition(state.regions.some((region: { sketchWireIds: number[] }) => region.sketchWireIds.includes(bodyId)), `${label} has no associated Region`);
}

function requireBounds(bounds: any, min: number[], max: number[], label: string): void {
  requireCondition(bounds, `${label} has no exact B-Rep bounds`);
  vectorNear(bounds.min, min, LINEAR_TOLERANCE_MM, `${label} minimum bounds`);
  vectorNear(bounds.max, max, LINEAR_TOLERANCE_MM, `${label} maximum bounds`);
}

function requireEmptyDocument(state: any, label: string): void {
  requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0, `${label} is not empty`);
  requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label} contains non-root groups`);
}

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "run-server.ts")],
    cwd: projectRoot,
    env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" },
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-sketch-primitives-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
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

async function recover(client: Client, initial: any): Promise<Record<string, unknown>> {
  for (let count = 0; count < 24; count += 1) {
    const status = await call(client, "plasticity_status", {});
    if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" };
    if (status.undoDepth <= initial.undoDepth) return { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 };
    await call(client, "plasticity_undo", { intent: "Recover disposable native sketch primitives acceptance", revision: status.revision });
  }
  return { restoredEmptyDocument: false, reason: "undo-limit" };
}

function stateSummary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorNear(actual: number[], expected: number[], tolerance: number, label: string): void { requireCondition(actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
