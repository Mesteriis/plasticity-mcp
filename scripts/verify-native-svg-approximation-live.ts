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
  if (!options.target) throw new Error("Native SVG approximation acceptance requires an explicit --target Plasticity window ID");
  if (!options.allowLive) throw new Error("Native SVG approximation acceptance requires --allow-live");
  if (!options.output) throw new Error("Native SVG approximation acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-svg-approximation-live.ts --help
  node scripts/verify-native-svg-approximation-live.ts --target ID --allow-live --output NEW_DIRECTORY

Requires an explicitly selected Plasticity document. Preserves its original
scene, creates only disposable native NURBS, Ellipse and polyline Wires, exports
the profiles with the production stdio MCP, verifies open and periodic exact
cubic BCurves, adaptive fallback and analytic SVG output against native B-Rep samples,
then restores the original scene.`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const svgPath = join(output, "native-nurbs-exact-cubic.svg");
  const evidencePath = join(output, "evidence.json");
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target, workbenchUsed: false };
  let client: Client | undefined;
  let initial: any;
  let current: any;
  let createdId: number | undefined;
  let arcBaseline: any;
  const arcMutationStates: any[] = [];
  try {
    client = new Client({ name: "plasticity-native-svg-approximation-live", version: "1.0.0" });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [join(projectRoot, "scripts", "run-server.ts")],
      cwd: projectRoot,
      env: { ...selectedEnvironment(process.env), PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" },
      stderr: "pipe",
    }));
    const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ["plasticity_list_windows", "plasticity_connect", "plasticity_create_nurbs_curve", "plasticity_create_polyline", "plasticity_bridge_curves", "plasticity_create_ellipse", "plasticity_export_svg", "plasticity_inspect_curve_structure", "plasticity_inspect_curve_planarity", "plasticity_list_curve_directions", "plasticity_evaluate_curve_segments", "plasticity_list_curve_intersections", "plasticity_list_curve_fragments", "plasticity_trim_curve_fragments", "plasticity_undo", "plasticity_redo", "plasticity_status"]) {
      requireCondition(toolNames.includes(name), `MCP did not expose ${name}`);
    }
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initial = await call(client, "plasticity_connect", { targetId: options.target });
    const baseline = sceneSignature(initial);
    evidence.initial = stateSummary(initial);
    evidence.baselineSceneSignature = baseline;

    current = await call(client, "plasticity_create_nurbs_curve", {
      pointsMm: [[0, 0, 0], [10, 12, 0], [20, -8, 0], [30, 0, 0]],
      closed: false,
      intent: "Disposable live acceptance of tolerance-bounded planar SVG export",
      revision: initial.revision,
    });
    const added = current.bodies.filter((body: { id: number; type: string }) => !initial.bodies.some((before: { id: number }) => before.id === body.id) && body.type === "Wire");
    requireCondition(added.length === 1, "NURBS creation did not add exactly one native Wire");
    createdId = added[0].id;
    const structure = await call(client, "plasticity_inspect_curve_structure", { ids: [createdId], revision: current.revision });
    const bcurve = structure.curves?.[0]?.segments?.[0];
    requireCondition(bcurve?.curveType === "BCurve" && bcurve.degree === 3 && bcurve.rational === false && bcurve.periodic === false && bcurve.knots?.length === 2, "Created Wire is not one non-rational single-span cubic B-spline");
    const directions = await call(client, "plasticity_list_curve_directions", {});
    const native = directions.curves?.find((curve: { id: number }) => curve.id === createdId);
    requireCondition(native?.measurementSource === "native-brep" && native.segments?.length === 1, "Native B-Rep endpoints are unavailable for the NURBS Wire");

    const report = await call(client, "plasticity_export_svg", {
      ids: [createdId], path: svgPath, curveChordToleranceMm: 0.02, curveChordAngleDegrees: 5, revision: current.revision,
    });
    const afterExport = await call(client, "plasticity_status", {});
    for (const field of ["targetId", "documentToken", "revision", "undoDepth", "redoDepth"] as const) requireCondition(current[field] === afterExport[field], `SVG export changed Plasticity ${field}`);
    const svg = await readFile(svgPath, "utf8");
    const pathData = svg.match(/<path d="([^"]+)" data-curve-type="BCurve"\/>/u)?.[1];
    requireCondition(pathData, "SVG omitted its exact cubic BCurve path");
    const cubic = pathData.match(/^M ([-+\d.eE]+) ([-+\d.eE]+) C ([-+\d.eE]+) ([-+\d.eE]+) ([-+\d.eE]+) ([-+\d.eE]+) ([-+\d.eE]+) ([-+\d.eE]+)$/u)?.slice(1).map(Number);
    requireCondition(cubic?.length === 8 && cubic.every(Number.isFinite), "SVG BCurve path is not one finite cubic span");
    requireCondition(report.cubicBezierSegments === 1 && report.approximatedSegments === 0, "MCP did not report the exact cubic representation");
    const plane = await call(client, "plasticity_inspect_curve_planarity", { ids: [createdId], revision: current.revision });
    requireCondition(plane.curves?.[0]?.planar === true, "Exact BCurve plane is unavailable");
    const sampleParameters = [0.071, 0.173, 0.293, 0.431, 0.569, 0.713, 0.893];
    const exact = await call(client, "plasticity_evaluate_curve_segments", {
      samples: sampleParameters.map((normalizedParameter) => ({ bodyId: createdId, segmentEntityId: native.segments[0].entityId, normalizedParameter })),
      revision: current.revision,
    });
    const svgSamples = sampleParameters.map((parameter) => evaluateSvgCubic(cubic!, parameter));
    const nativeSamples = exact.samples.map((sample: { positionMm: number[] }) => projectWorldToSvg(sample.positionMm, plane.curves[0].plane));
    const maxSampleErrorMm = Math.max(...nativeSamples.map((point: number[], index: number) => Math.hypot(point[0]! - svgSamples[index]![0], point[1]! - svgSamples[index]![1])));
    requireCondition(maxSampleErrorMm <= 1e-7, `Exact SVG cubic differs from native B-Rep samples by ${maxSampleErrorMm} mm`);
    vectorNear([cubic![6]! - cubic![0]!, cubic![7]! - cubic![1]!], [30, 0], 1e-7, "Exact SVG cubic endpoint delta");
    requireCondition(report.maxChordDeviationMm === 0, "Exact cubic export incorrectly reports polyline deviation");
    requireCondition(report.curveChordToleranceMm === 0.02 && report.curveChordAngleDegrees === 5, "MCP report omitted the requested approximation tolerances");
    requireCondition(svg.includes('width="') && svg.includes("mm\" height=\""), "SVG omitted physical millimeter dimensions");
    requireCondition(report.bytes === Buffer.byteLength(svg), "SVG report byte count differs from the saved artifact");
    evidence.export = {
      report,
      nativeCurve: { type: structure.curves[0].curveType, endpointsMm: native.segments.map((segment: any) => ({ startMm: segment.startMm, endMm: segment.endMm })) },
      exactBRepSampleCount: exact.samples.length,
      maxExactSampleErrorMm: maxSampleErrorMm,
      svgSha256: createHash("sha256").update(svg).digest("hex"),
      documentAndHistoryUnchangedByExport: true,
    };

    current = await call(client, "plasticity_undo", { intent: "Verify SVG approximation fixture Undo", revision: current.revision });
    assertBaseline(current, initial, "Undo did not restore the original scene after the NURBS export test");
    current = await call(client, "plasticity_redo", { intent: "Verify SVG approximation fixture Redo", revision: current.revision });
    requireCondition(current.bodies.some((body: { id: number; type: string }) => body.id === createdId && body.type === "Wire"), "Redo did not restore the same native NURBS Wire ID");
    current = await call(client, "plasticity_undo", { intent: "Restore original scene after SVG approximation acceptance", revision: current.revision });
    assertBaseline(current, initial, "Final NURBS Undo did not restore the original scene");

    const multiSpanPath = join(output, "native-nurbs-multispan-exact-cubic.svg");
    current = await call(client, "plasticity_create_nurbs_curve", {
      pointsMm: [[0, 40, 0], [10, 55, 0], [20, 30, 0], [30, 60, 0], [40, 35, 0], [50, 50, 0], [60, 40, 0]],
      closed: false,
      intent: "Disposable live acceptance of exact multi-span cubic BCurve SVG export",
      revision: current.revision,
    });
    const multiSpanWires = current.bodies.filter((body: { id: number; type: string }) => !initial.bodies.some((before: { id: number }) => before.id === body.id) && body.type === "Wire");
    requireCondition(multiSpanWires.length === 1, "Multi-span NURBS creation did not add exactly one Wire");
    const multiSpanId = multiSpanWires[0].id as number;
    createdId = multiSpanId;
    const multiStructure = await call(client, "plasticity_inspect_curve_structure", { ids: [multiSpanId], revision: current.revision });
    const multiCurve = multiStructure.curves?.[0]?.segments?.[0];
    requireCondition(multiCurve?.curveType === "BCurve" && multiCurve.degree === 3 && multiCurve.rational === false && multiCurve.periodic === false && multiCurve.spanCount >= 2 && multiCurve.knots?.length === multiCurve.spanCount + 1, "Created Wire is not an open multi-span polynomial cubic BCurve");
    const multiDirections = await call(client, "plasticity_list_curve_directions", {});
    const multiNative = multiDirections.curves?.find((curve: { id: number }) => curve.id === multiSpanId);
    requireCondition(multiNative?.measurementSource === "native-brep" && multiNative.segments?.length === 1, "Native B-Rep data is unavailable for the multi-span Wire");
    const multiReport = await call(client, "plasticity_export_svg", {
      ids: [multiSpanId], path: multiSpanPath, curveChordToleranceMm: 0.02, curveChordAngleDegrees: 5, revision: current.revision,
    });
    requireCondition(multiReport.cubicBezierSegments === 1 && multiReport.approximatedSegments === 0, "Multi-span BCurve did not export as an exact cubic path");
    const multiSvg = await readFile(multiSpanPath, "utf8");
    const multiPath = multiSvg.match(/<path d="([^"]+)" data-curve-type="BCurve"\/>/u)?.[1];
    requireCondition(multiPath, "Multi-span SVG cubic path is missing");
    const move = multiPath.match(/^M ([-+\d.eE]+) ([-+\d.eE]+) /u);
    const spans = [...multiPath.matchAll(/C ([-+\d.eE]+) ([-+\d.eE]+) ([-+\d.eE]+) ([-+\d.eE]+) ([-+\d.eE]+) ([-+\d.eE]+)/gu)].map((match) => match.slice(1).map(Number));
    requireCondition(move && spans.length === multiCurve.spanCount && spans.every((span: number[]) => span.every(Number.isFinite)), "SVG cubic commands do not match the native knot-span count");
    const multiPlane = await call(client, "plasticity_inspect_curve_planarity", { ids: [multiSpanId], revision: current.revision });
    requireCondition(multiPlane.curves?.[0]?.planar === true, "Multi-span BCurve plane is unavailable");
    const knotParameters = multiCurve.knots.map((knot: { normalizedParameter: number }) => knot.normalizedParameter);
    const spanFractions = [0.137, 0.5, 0.863];
    const sampleRequests = knotParameters.slice(0, -1).flatMap((start: number, spanIndex: number) => spanFractions.map((fraction) => ({
      bodyId: multiSpanId,
      segmentEntityId: multiNative.segments[0].entityId,
      normalizedParameter: start + (knotParameters[spanIndex + 1]! - start) * fraction,
    })));
    const multiExact = await call(client, "plasticity_evaluate_curve_segments", { samples: sampleRequests, revision: current.revision });
    const startPoint: [number, number] = move!.slice(1).map(Number) as [number, number];
    const expectedSvg = sampleRequests.map((_request: unknown, index: number) => {
      const spanIndex = Math.floor(index / spanFractions.length);
      const values = spans[spanIndex]!;
      const previousEnd = spanIndex === 0 ? startPoint : spans[spanIndex - 1]!.slice(4, 6) as [number, number];
      return evaluateSvgCubic([...previousEnd, ...values] as number[], spanFractions[index % spanFractions.length]!);
    });
    const multiNativeSvg = multiExact.samples.map((sample: { positionMm: number[] }) => projectWorldToSvg(sample.positionMm, multiPlane.curves[0].plane));
    const multiMaxErrorMm = Math.max(...multiNativeSvg.map((point: number[], index: number) => Math.hypot(point[0]! - expectedSvg[index]![0], point[1]! - expectedSvg[index]![1])));
    requireCondition(multiMaxErrorMm <= 1e-7, `Multi-span SVG cubic differs from native B-Rep samples by ${multiMaxErrorMm} mm`);
    evidence.multiSpanExport = {
      report: multiReport,
      nativeDegree: multiCurve.degree,
      nativeSpanCount: multiCurve.spanCount,
      svgCubicCommandCount: spans.length,
      exactBRepSampleCount: multiExact.samples.length,
      maxExactSampleErrorMm: multiMaxErrorMm,
      svgSha256: createHash("sha256").update(multiSvg).digest("hex"),
    };
    current = await call(client, "plasticity_undo", { intent: "Verify and clean up multi-span BCurve SVG fixture", revision: current.revision });
    assertBaseline(current, initial, "Undo did not restore the original scene after multi-span BCurve SVG export");

    const fallbackPath = join(output, "native-degree5-bcurve-adaptive-fallback.svg");
    const firstLineState = await call(client, "plasticity_create_polyline", {
      pointsMm: [[0, 80, 0], [10, 80, 0]], closed: false,
      intent: "Disposable degree-5 BCurve adaptive-fallback source one", revision: current.revision,
    });
    const firstLine = firstLineState.bodies.find((body: { type: string; id: number }) => body.type === "Wire" && !initial.bodies.some((before: { id: number }) => before.id === body.id));
    requireCondition(firstLine, "First Curve Bridge source was not created");
    const secondLineState = await call(client, "plasticity_create_polyline", {
      pointsMm: [[20, 100, 0], [30, 100, 0]], closed: false,
      intent: "Disposable degree-5 BCurve adaptive-fallback source two", revision: firstLineState.revision,
    });
    const secondLine = secondLineState.bodies.find((body: { type: string; id: number }) => body.type === "Wire" && body.id !== firstLine.id && !initial.bodies.some((before: { id: number }) => body.id === before.id));
    requireCondition(secondLine, "Second Curve Bridge source was not created");
    const lineDirections = await call(client, "plasticity_list_curve_directions", {});
    const firstEdge = lineDirections.curves.find((curve: { id: number }) => curve.id === firstLine.id)?.segments?.[0];
    const secondEdge = lineDirections.curves.find((curve: { id: number }) => curve.id === secondLine.id)?.segments?.[0];
    requireCondition(firstEdge?.entityId && secondEdge?.entityId, "Curve Bridge source edge IDs are unavailable");
    current = await call(client, "plasticity_bridge_curves", {
      first: { bodyId: firstLine.id, segmentEntityId: firstEdge.entityId, at: "end" },
      second: { bodyId: secondLine.id, segmentEntityId: secondEdge.entityId, at: "start" },
      startContinuity: "G2", endContinuity: "G2",
      intent: "Disposable degree-5 BCurve adaptive-fallback fixture", revision: secondLineState.revision,
    });
    const bridge = current.bodies.find((body: { type: string; id: number }) => body.type === "Wire" && body.id !== firstLine.id && body.id !== secondLine.id && !initial.bodies.some((before: { id: number }) => body.id === before.id));
    requireCondition(bridge, "G2 Curve Bridge did not create a disposable Wire");
    createdId = bridge.id;
    const bridgeStructure = await call(client, "plasticity_inspect_curve_structure", { ids: [bridge.id], revision: current.revision });
    requireCondition(bridgeStructure.curves?.[0]?.segments?.[0]?.curveType === "BCurve" && bridgeStructure.curves[0].segments[0].degree === 5, "G2 Curve Bridge fixture is not a degree-5 BCurve");
    const fallbackReport = await call(client, "plasticity_export_svg", {
      ids: [bridge.id], path: fallbackPath, curveChordToleranceMm: 0.02, curveChordAngleDegrees: 5, revision: current.revision,
    });
    requireCondition(fallbackReport.cubicBezierSegments === 0 && fallbackReport.approximatedSegments === 1 && fallbackReport.maxChordDeviationMm <= 0.02, "Degree-5 BCurve did not use the requested adaptive fallback");
    const fallbackSvg = await readFile(fallbackPath, "utf8");
    const fallbackData = fallbackSvg.match(/<path d="([^"]+)" data-curve-type="BCurve" data-approximation="adaptive-chord"\/>/u)?.[1];
    requireCondition(fallbackData, "Degree-5 BCurve fallback was not explicitly marked in SVG");
    const fallbackPoints = [...fallbackData.matchAll(/[ML] ([-+\d.eE]+) ([-+\d.eE]+)/gu)].map((match) => match.slice(1).map(Number));
    requireCondition(fallbackPoints.length >= 3 && fallbackPoints.flat().every(Number.isFinite), "Degree-5 BCurve adaptive fallback path is invalid");
    const bridgeDirections = await call(client, "plasticity_list_curve_directions", {});
    const bridgeNative = bridgeDirections.curves.find((curve: { id: number }) => curve.id === bridge.id);
    const bridgePlane = await call(client, "plasticity_inspect_curve_planarity", { ids: [bridge.id], revision: current.revision });
    const fallbackSampleParameters = Array.from({ length: 21 }, (_unused, index) => (index + 0.5) / 21);
    const fallbackExact = await call(client, "plasticity_evaluate_curve_segments", {
      samples: fallbackSampleParameters.map((normalizedParameter) => ({ bodyId: bridge.id, segmentEntityId: bridgeNative.segments[0].entityId, normalizedParameter })),
      revision: current.revision,
    });
    const fallbackSamplePoints = fallbackExact.samples.map((sample: { positionMm: number[] }) => projectWorldToSvg(sample.positionMm, bridgePlane.curves[0].plane));
    const independentMaxDeviationMm = Math.max(...fallbackSamplePoints.map((point: number[]) => distanceToPolyline(point, fallbackPoints)));
    requireCondition(independentMaxDeviationMm <= 0.02 + 1e-7, `Degree-5 BCurve fallback exceeded independent sample tolerance: ${independentMaxDeviationMm} mm`);
    evidence.degree5Fallback = {
      degree: bridgeStructure.curves[0].segments[0].degree,
      report: fallbackReport,
      polylinePointCount: fallbackPoints.length,
      exactNativeSampleCount: fallbackExact.samples.length,
      independentMaxDeviationMm,
      explicitlyMarkedAdaptiveApproximation: true,
    };
    current = await call(client, "plasticity_undo", { intent: "Remove G2 bridge after degree-5 fallback check", revision: current.revision });
    current = await call(client, "plasticity_undo", { intent: "Remove second line after degree-5 fallback check", revision: current.revision });
    current = await call(client, "plasticity_undo", { intent: "Remove first line after degree-5 fallback check", revision: current.revision });
    assertBaseline(current, initial, "Undo did not restore the original scene after degree-5 BCurve fallback test");

    arcBaseline = current;
    const periodicPath = join(output, "native-periodic-cubic-exact.svg");
    current = await call(client, "plasticity_create_nurbs_curve", {
      pointsMm: [[120, 0, 0], [132, 18, 0], [145, 3, 0], [140, -14, 0], [124, -12, 0]], closed: true,
      intent: "Disposable live acceptance of exact periodic cubic SVG export", revision: current.revision,
    });
    arcMutationStates.push(current);
    const periodicAdded = current.bodies.filter((body: { id: number; type: string }) => !arcBaseline.bodies.some((before: { id: number }) => before.id === body.id) && body.type === "Wire");
    requireCondition(periodicAdded.length === 1, "Closed NURBS creation did not add exactly one native Wire");
    const periodicId = periodicAdded[0].id as number;
    createdId = periodicId;
    const periodicStructure = await call(client, "plasticity_inspect_curve_structure", { ids: [periodicId], revision: current.revision });
    const periodicCurve = periodicStructure.curves?.[0]?.segments?.[0];
    requireCondition(periodicCurve?.curveType === "BCurve" && periodicCurve.degree === 3 && periodicCurve.rational === false && periodicCurve.periodic === true, "Closed NURBS fixture did not produce a non-rational periodic cubic BCurve");
    const periodicDirections = await call(client, "plasticity_list_curve_directions", {});
    const periodicNative = periodicDirections.curves?.find((curve: { id: number }) => curve.id === periodicId);
    requireCondition(periodicNative?.measurementSource === "native-brep" && periodicNative.closed === true && periodicNative.segments?.length === 1, "Periodic BCurve native segment reference is unavailable");
    const periodicReport = await call(client, "plasticity_export_svg", {
      ids: [periodicId], path: periodicPath, curveChordToleranceMm: 0.02, curveChordAngleDegrees: 5, revision: current.revision,
    });
    requireCondition(periodicReport.cubicBezierSegments === 1 && periodicReport.approximatedSegments === 0, "Periodic cubic BCurve was not exported as exact cubic spans");
    const periodicSvg = await readFile(periodicPath, "utf8");
    const periodicPathData = periodicSvg.match(/<path d="([^"]+)" data-curve-type="BCurve"\/>/u)?.[1];
    requireCondition(periodicPathData, "Exact periodic BCurve SVG path is missing");
    const periodicMove = periodicPathData.match(/^M ([-+\d.eE]+) ([-+\d.eE]+) /u);
    const periodicSvgSpans = [...periodicPathData.matchAll(/C ([-+\d.eE]+) ([-+\d.eE]+) ([-+\d.eE]+) ([-+\d.eE]+) ([-+\d.eE]+) ([-+\d.eE]+)/gu)].map((match) => match.slice(1).map(Number));
    requireCondition(periodicMove && periodicSvgSpans.length > 1 && periodicSvgSpans.length === periodicCurve.activeSpanCount && periodicSvgSpans.every((span: number[]) => span.every(Number.isFinite)), "Exact periodic BCurve SVG commands do not match the derived active span count");
    // Plasticity's periodic knot list contains wrapped extension knots; verify
    // the SVG locus against native samples and use activeSpanCount, not numSpans.
    const periodicStart: [number, number] = periodicMove.slice(1).map(Number) as [number, number];
    const periodicPolyline: number[][] = [periodicStart];
    for (let spanIndex = 0; spanIndex < periodicSvgSpans.length; spanIndex++) {
      const command = periodicSvgSpans[spanIndex]!;
      const previousEnd = spanIndex === 0 ? periodicStart : periodicSvgSpans[spanIndex - 1]!.slice(4, 6) as [number, number];
      for (let division = 1; division <= 128; division++) periodicPolyline.push(evaluateSvgCubic([...previousEnd, ...command] as number[], division / 128));
    }
    const periodicParameters = Array.from({ length: 251 }, (_unused, index) => index / 250);
    const periodicRequests = periodicParameters.map((normalizedParameter) => ({ bodyId: periodicId, segmentEntityId: periodicNative.segments[0].entityId, normalizedParameter }));
    const periodicPlane = await call(client, "plasticity_inspect_curve_planarity", { ids: [periodicId], revision: current.revision });
    const periodicExact = await call(client, "plasticity_evaluate_curve_segments", { samples: periodicRequests, revision: current.revision });
    const periodicActual = periodicExact.samples.map((sample: { positionMm: number[] }) => projectWorldToSvg(sample.positionMm, periodicPlane.curves[0].plane));
    const periodicMaxErrorMm = Math.max(...periodicActual.map((point: number[]) => distanceToPolyline(point, periodicPolyline)));
    requireCondition(periodicMaxErrorMm <= 0.001, `Exact periodic SVG cubic differs from native B-Rep samples by ${periodicMaxErrorMm} mm`);
    requireCondition(Math.hypot(...periodicSvgSpans.at(-1)!.slice(4, 6).map((value, index) => value - periodicStart[index]!)) <= 1e-7, "Periodic SVG cubic does not return to its starting point");
    evidence.periodicCubicExport = {
      report: periodicReport,
      nativeDegree: periodicCurve.degree,
      nativePeriodic: periodicCurve.periodic,
      nativeSpanCount: periodicCurve.spanCount,
      nativeActiveSpanCount: periodicCurve.activeSpanCount,
      svgCubicCommandCount: periodicSvgSpans.length,
      exactBRepSampleCount: periodicExact.samples.length,
      maxNativeSampleToSvgPolylineDistanceMm: periodicMaxErrorMm,
      svgSha256: createHash("sha256").update(periodicSvg).digest("hex"),
    };
    current = await call(client, "plasticity_undo", { intent: "Restore original scene after periodic BCurve SVG acceptance", revision: current.revision });
    arcMutationStates.pop();
    createdId = undefined;
    assertBaseline(current, arcBaseline, "Periodic BCurve Undo did not restore the original scene");

    const ellipsePath = join(output, "native-ellipse-approximation.svg");
    current = await call(client, "plasticity_create_ellipse", {
      centerMm: [0, 0, 0], majorRadiusMm: 12, minorRadiusMm: 5, angleDegrees: 35,
      intent: "Disposable native Ellipse coverage for adaptive SVG export",
      revision: current.revision,
    });
    const ellipse = current.bodies.filter((body: { id: number; type: string }) => !initial.bodies.some((before: { id: number }) => before.id === body.id) && body.type === "Wire");
    requireCondition(ellipse.length === 1, "Native Ellipse creation did not add exactly one Wire");
    const ellipseId = ellipse[0].id as number;
    createdId = ellipseId;
    const ellipseStructure = await call(client, "plasticity_inspect_curve_structure", { ids: [ellipseId], revision: current.revision });
    requireCondition(ellipseStructure.curves?.[0]?.segments?.length === 1 && ellipseStructure.curves[0].segments[0].curveType === "Ellipse", "Created Wire is not one native Ellipse segment");
    const ellipseDirections = await call(client, "plasticity_list_curve_directions", {});
    const ellipseNative = ellipseDirections.curves?.find((curve: { id: number }) => curve.id === ellipseId);
    requireCondition(ellipseNative?.measurementSource === "native-brep" && ellipseNative.closed && ellipseNative.segments?.length === 1, "Exact closed native Ellipse segment is unavailable");
    const ellipseExport = await call(client, "plasticity_export_svg", {
      ids: [ellipseId], path: ellipsePath, curveChordToleranceMm: 0.02, curveChordAngleDegrees: 5, revision: current.revision,
    });
    requireCondition(ellipseExport.fullEllipses === 1 && ellipseExport.approximatedSegments === 0, "Closed native Ellipse did not export as an exact SVG ellipse");
    const ellipseSvg = await readFile(ellipsePath, "utf8");
    const ellipseMatch = ellipseSvg.match(/<ellipse cx="([^"]+)" cy="([^"]+)" rx="([^"]+)" ry="([^"]+)" transform="rotate\(([^ ]+) ([^ ]+) ([^)]+)\)"\/>/u);
    requireCondition(ellipseMatch, "Closed native Ellipse was not written as one SVG ellipse element");
    const ellipseValues = ellipseMatch.slice(1).map(Number);
    requireCondition(ellipseValues.every(Number.isFinite) && ellipseValues[2]! >= ellipseValues[3]! && ellipseValues[3]! > 0, "Exact SVG ellipse parameters are invalid");
    const exactSamples = await call(client, "plasticity_evaluate_curve_segments", {
      samples: [0.107, 0.283, 0.431, 0.569, 0.713, 0.893].map((normalizedParameter) => ({ bodyId: ellipseId, segmentEntityId: ellipseNative.segments[0].entityId, normalizedParameter })),
      revision: current.revision,
    });
    const [cx, cy, rx, ry, rotationDegrees] = ellipseValues;
    const angle = rotationDegrees! * Math.PI / 180;
    const exactToSvg = exactSamples.samples.map((sample: { positionMm: number[] }) => [sample.positionMm[0]!, -sample.positionMm[1]!]);
    const normalizedEllipseRadii = exactToSvg.map((point: number[]) => {
      const dx = point[0]! - cx!;
      const dy = point[1]! - cy!;
      const localX = Math.cos(angle) * dx + Math.sin(angle) * dy;
      const localY = -Math.sin(angle) * dx + Math.cos(angle) * dy;
      return Math.hypot(localX / rx!, localY / ry!);
    });
    const maxRadialError = Math.max(...normalizedEllipseRadii.map((radius: number) => Math.abs(radius - 1)));
    requireCondition(maxRadialError <= 1e-8, `Native Ellipse samples differ from exact SVG ellipse by normalized radial error ${maxRadialError}`);
    const xExtent = Math.hypot(rx! * Math.cos(angle), ry! * Math.sin(angle));
    const yExtent = Math.hypot(rx! * Math.sin(angle), ry! * Math.cos(angle));
    vectorNear(ellipseExport.boundsMm.min, [cx! - xExtent, cy! - yExtent], 1e-6, "Exact Ellipse projected minimum bounds");
    vectorNear(ellipseExport.boundsMm.max, [cx! + xExtent, cy! + yExtent], 1e-6, "Exact Ellipse projected maximum bounds");
    evidence.ellipseExport = {
      report: ellipseExport,
      nativeCurve: { type: "Ellipse", lengthMm: ellipseNative.segments[0].lengthMm, closed: ellipseNative.closed },
      svgEllipse: { centerMm: [cx, cy], radiiMm: [rx, ry], rotationDegrees },
      exactNativeSampleCount: exactToSvg.length,
      maxNormalizedEllipseRadialError: maxRadialError,
      svgSha256: createHash("sha256").update(ellipseSvg).digest("hex"),
      documentAndHistoryUnchangedByExport: true,
    };
    current = await call(client, "plasticity_undo", { intent: "Restore original scene after Ellipse SVG acceptance", revision: current.revision });
    assertBaseline(current, initial, "Ellipse Undo did not restore the original scene");

    arcBaseline = current;
    const verifyTrimmedEllipse = async (label: string, centerX: number, remove: "shorter" | "longer", expectedLargeArcFlag: 0 | 1): Promise<Record<string, unknown>> => {
      const beforeEllipse = current;
      const ellipseCreated = await call(client!, "plasticity_create_ellipse", {
        centerMm: [centerX, 0, 0], majorRadiusMm: 12, minorRadiusMm: 5, angleDegrees: 35,
        intent: `Disposable native ${label} elliptical-arc fixture`, revision: current.revision,
      });
      current = ellipseCreated;
      arcMutationStates.push(current);
      const addedEllipse = current.bodies.filter((body: { id: number; type: string }) => !beforeEllipse.bodies.some((before: { id: number }) => before.id === body.id) && body.type === "Wire");
      const ellipseId = addedEllipse[0]?.id as number | undefined;
      requireCondition(Number.isInteger(ellipseId), `${label}: native Ellipse creation did not add a Wire`);
      createdId = ellipseId;

      const beforeCutter = current;
      current = await call(client!, "plasticity_create_polyline", {
        pointsMm: [[centerX - 20, 2, 0], [centerX + 20, 2, 0]], closed: false,
        intent: `Disposable native ${label} ellipse-intersection cutter`, revision: current.revision,
      });
      arcMutationStates.push(current);
      const addedWires = current.bodies.filter((body: { id: number; type: string }) => !beforeCutter.bodies.some((before: { id: number }) => before.id === body.id) && body.type === "Wire");
      const cutterId = addedWires[0]?.id as number | undefined;
      requireCondition(Number.isInteger(cutterId), `${label}: line cutter was not created as an independent Wire`);

      const intersections = await call(client!, "plasticity_list_curve_intersections", {});
      const ellipseIntersections = intersections.intersections.filter((item: { bodyIds: number[] }) => item.bodyIds.includes(ellipseId!) && item.bodyIds.includes(cutterId!));
      requireCondition(ellipseIntersections.length === 2, `${label}: expected two exact native intersections, found ${ellipseIntersections.length}`);
      const fragments = await call(client!, "plasticity_list_curve_fragments", {});
      const ellipseFragments = fragments.fragments.filter((fragment: { bodyId: number }) => fragment.bodyId === ellipseId);
      requireCondition(ellipseFragments.length === 2, `${label}: expected two native ellipse fragments, found ${ellipseFragments.length}`);
      const sorted = [...ellipseFragments].sort((left: { lengthMm: number }, right: { lengthMm: number }) => left.lengthMm - right.lengthMm);
      const removeFragment = remove === "shorter" ? sorted[0] : sorted[1];
      const removedLengthMm = removeFragment.lengthMm;
      const retainedLengthMm = (remove === "shorter" ? sorted[1] : sorted[0]).lengthMm;

      current = await call(client!, "plasticity_trim_curve_fragments", {
        fragmentIds: [removeFragment.id], intent: `Retain the ${label} native ellipse arc`, revision: current.revision,
      });
      arcMutationStates.push(current);

      const arcDirections = await call(client!, "plasticity_list_curve_directions", {});
      const arcCandidates = arcDirections.curves?.filter((candidate: { id: number; measurementSource: string; closed: boolean; segments: Array<{ lengthMm: number }> }) =>
        candidate.measurementSource === "native-brep" && candidate.closed === false && candidate.segments?.length === 1 &&
        candidate.segments[0]?.lengthMm !== undefined && Math.abs(candidate.segments[0].lengthMm - retainedLengthMm) <= Math.max(1e-6, retainedLengthMm * 1e-8)) ?? [];
      let native: any;
      for (const candidate of arcCandidates) {
        const candidateStructure = await call(client!, "plasticity_inspect_curve_structure", { ids: [candidate.id], revision: current.revision });
        if (candidateStructure.curves?.[0]?.segments?.length === 1 && candidateStructure.curves[0].segments[0].curveType === "Ellipse") {
          native = { ...candidate, segments: candidate.segments.map((segment: any, index: number) => ({ ...segment, curveType: candidateStructure.curves[0].segments[index].curveType })) };
          break;
        }
      }
      requireCondition(native, `${label}: trimmed native Ellipse carrier data is unavailable; available curves: ${JSON.stringify(arcDirections.curves?.map((candidate: any) => ({ id: candidate.id, closed: candidate.closed, segments: candidate.segments?.map((segment: any) => ({ curveType: segment.curveType, lengthMm: segment.lengthMm })) })))}`);
      const svgPath = join(output, `native-ellipse-${label}-arc.svg`);
      const report = await call(client!, "plasticity_export_svg", {
        ids: [native.id], path: svgPath, curveChordToleranceMm: 0.02, curveChordAngleDegrees: 5, revision: current.revision,
      });
      requireCondition(report.ellipticalArcs === 1 && report.approximatedSegments === 0, `${label}: trimmed native Ellipse was not exported exactly`);
      const svg = await readFile(svgPath, "utf8");
      const path = svg.match(/<path d="([^"]+)" data-curve-type="Ellipse"\/>/u)?.[1];
      const arcMatch = path?.match(/^M ([-+\d.eE]+) ([-+\d.eE]+) A ([-+\d.eE]+) ([-+\d.eE]+) ([-+\d.eE]+) ([01]) ([01]) ([-+\d.eE]+) ([-+\d.eE]+)$/u);
      requireCondition(arcMatch, `${label}: exact SVG elliptical A command is missing or malformed`);
      const numbers = arcMatch.slice(1).map(Number);
      requireCondition(numbers.every(Number.isFinite), `${label}: SVG elliptical arc contains a non-finite parameter`);
      const [sx, sy, rx, ry, rotation, largeArcFlag, sweepFlag, ex, ey] = numbers;
      requireCondition(rx! >= ry! && ry! > 0 && largeArcFlag === expectedLargeArcFlag, `${label}: SVG arc radii or large-arc flag are incorrect`);
      const plane = await call(client!, "plasticity_inspect_curve_planarity", { ids: [native.id], revision: current.revision });
      requireCondition(plane.curves?.[0]?.planar === true && plane.curves[0].plane?.originMm?.length === 3, `${label}: exact native sketch plane is unavailable`);
      const exact = await call(client!, "plasticity_evaluate_curve_segments", {
        samples: [0.107, 0.283, 0.431, 0.569, 0.713, 0.893].map((normalizedParameter) => ({ bodyId: native.id, segmentEntityId: native.segments[0].entityId, normalizedParameter })),
        revision: current.revision,
      });
      const sampledSvg = exact.samples.map((sample: { positionMm: number[] }, index: number) => svgArcPoint(
        [sx!, sy!], [ex!, ey!], rx!, ry!, rotation!, largeArcFlag!, sweepFlag!, [0.107, 0.283, 0.431, 0.569, 0.713, 0.893][index]!,
      ));
      const exactSvgSamples = exact.samples.map((sample: { positionMm: number[] }) => projectWorldToSvg(sample.positionMm, plane.curves[0].plane));
      const sampleErrors = exact.samples.map((_sample: { positionMm: number[] }, index: number) => Math.hypot(sampledSvg[index]![0] - exactSvgSamples[index]![0], sampledSvg[index]![1] - exactSvgSamples[index]![1]));
      const maxSampleErrorMm = Math.max(...sampleErrors);
      requireCondition(maxSampleErrorMm <= 1e-6, `${label}: native arc samples differ from the SVG analytic arc by ${maxSampleErrorMm} mm`);
      return {
        report,
        nativeCurve: { id: native.id, segmentEntityId: native.segments[0].entityId, lengthMm: native.segments[0].lengthMm, retainedFragmentLengthMm: retainedLengthMm, removedFragmentLengthMm: removedLengthMm },
        svgArc: { start: [sx, sy], radiiMm: [rx, ry], rotationDegrees: rotation, largeArcFlag, sweepFlag, end: [ex, ey] },
        exactNativeSampleCount: exact.samples.length,
        maxSampleErrorMm,
        svgSha256: createHash("sha256").update(svg).digest("hex"),
      };
    };

    evidence.ellipseLargeArcExport = await verifyTrimmedEllipse("large", 0, "shorter", 1);
    evidence.ellipseSmallArcExport = await verifyTrimmedEllipse("small", 50, "longer", 0);
    while (arcMutationStates.length > 0) {
      assertBaseline(current, arcMutationStates.at(-1), "Disposable Ellipse arc scene changed outside the tracked native command history");
      current = await call(client, "plasticity_undo", { intent: "Restore original scene after exact Ellipse arc SVG acceptance", revision: current.revision });
      arcMutationStates.pop();
      assertBaseline(current, arcMutationStates.at(-1) ?? arcBaseline, "Undo did not restore the preceding exact Ellipse arc fixture state");
    }
    createdId = undefined;
    assertBaseline(current, initial, "Ellipse arc Undo chain did not restore the original scene");
    evidence.cleanup = {
      final: stateSummary(current),
      originalSceneRestored: true,
      undoDepthRestored: current.undoDepth === initial.undoDepth,
      redoDepthBefore: initial.redoDepth,
      redoDepthAfter: current.redoDepth,
      sameIdRedoVerified: true,
    };
    evidence.completedAt = new Date().toISOString();
    await writeFile(evidencePath, `${JSON.stringify(sanitizeEvidence(evidence), null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ ok: true, output, svg: svgPath, evidence: evidencePath }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    await writeFile(join(output, "failure.json"), `${JSON.stringify(sanitizeEvidence(evidence), null, 2)}\n`, { flag: "wx", mode: 0o600 }).catch(() => {});
    throw error;
  } finally {
    if (client && arcMutationStates.length > 0 && arcBaseline) {
      while (arcMutationStates.length > 0) {
        const status = await call(client, "plasticity_status", {}).catch(() => null);
        const expected = arcMutationStates.at(-1);
        if (!status || status.targetId !== options.target || status.documentToken !== initial?.documentToken || sceneSignature(status) !== sceneSignature(expected)) break;
        const restored = await call(client, "plasticity_undo", { intent: "Guarded cleanup after exact Ellipse arc SVG acceptance", revision: status.revision }).catch(() => null);
        if (!restored) break;
        arcMutationStates.pop();
        const prior = arcMutationStates.at(-1) ?? arcBaseline;
        if (sceneSignature(restored) !== sceneSignature(prior)) break;
        current = restored;
      }
    } else if (client && createdId !== undefined && current?.bodies?.some((body: { id: number }) => body.id === createdId)) {
      const status = await call(client, "plasticity_status", {}).catch(() => null);
      if (status && status.targetId === options.target && status.documentToken === initial?.documentToken && status.bodies?.some((body: { id: number }) => body.id === createdId) && status.revision === current.revision) {
        await call(client, "plasticity_undo", { intent: "Guarded cleanup after SVG approximation acceptance", revision: status.revision }).catch(() => {});
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
function stateSummary(state: any): Record<string, unknown> { return { targetId: state.targetId, documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyIds: state.bodies.map((body: { id: number }) => body.id) }; }
function sceneSignature(state: any): string {
  return JSON.stringify({
    documentToken: state.documentToken,
    title: state.title,
    bodies: state.bodies,
    regions: state.regions,
    construction: state.construction,
    materials: state.materials ?? [],
    measurements: state.measurements ?? [],
    sectionAnalyses: state.sectionAnalyses ?? [],
    instances: state.instances ?? [],
    referenceMeshes: state.referenceMeshes ?? [],
    activeGroupId: state.activeGroupId ?? null,
    groups: state.groups ?? [],
    undoDepth: state.undoDepth,
  });
}
function assertBaseline(actual: any, initial: any, message: string): void {
  requireCondition(sceneSignature(actual) === sceneSignature(initial), message);
}
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function vectorNear(actual: number[], expected: number[], tolerance: number, label: string): void { requireCondition(actual.length === expected.length, `${label} has the wrong number of values`); actual.forEach((value, index) => requireCondition(Number.isFinite(value) && Math.abs(value - expected[index]!) <= tolerance, `${label}[${index}] differs from native B-Rep readback`)); }
function svgArcPoint(start: [number, number], end: [number, number], inputRx: number, inputRy: number, rotationDegrees: number, largeArcFlag: number, sweepFlag: number, fraction: number): [number, number] {
  const phi = rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(phi);
  const sine = Math.sin(phi);
  const dx = (start[0] - end[0]) / 2;
  const dy = (start[1] - end[1]) / 2;
  const xPrime = cosine * dx + sine * dy;
  const yPrime = -sine * dx + cosine * dy;
  const correction = Math.max(1, Math.sqrt(xPrime * xPrime / (inputRx * inputRx) + yPrime * yPrime / (inputRy * inputRy)));
  const rx = inputRx * correction;
  const ry = inputRy * correction;
  const numerator = Math.max(0, rx * rx * ry * ry - rx * rx * yPrime * yPrime - ry * ry * xPrime * xPrime);
  const denominator = rx * rx * yPrime * yPrime + ry * ry * xPrime * xPrime;
  const sign = largeArcFlag === sweepFlag ? -1 : 1;
  const coefficient = denominator === 0 ? 0 : sign * Math.sqrt(numerator / denominator);
  const cxPrime = coefficient * rx * yPrime / ry;
  const cyPrime = -coefficient * ry * xPrime / rx;
  const cx = cosine * cxPrime - sine * cyPrime + (start[0] + end[0]) / 2;
  const cy = sine * cxPrime + cosine * cyPrime + (start[1] + end[1]) / 2;
  const startVector: [number, number] = [(xPrime - cxPrime) / rx, (yPrime - cyPrime) / ry];
  const endVector: [number, number] = [(-xPrime - cxPrime) / rx, (-yPrime - cyPrime) / ry];
  const thetaStart = Math.atan2(startVector[1], startVector[0]);
  const cross = startVector[0] * endVector[1] - startVector[1] * endVector[0];
  const dot = startVector[0] * endVector[0] + startVector[1] * endVector[1];
  let delta = Math.atan2(cross, dot);
  if (sweepFlag === 0 && delta > 0) delta -= 2 * Math.PI;
  if (sweepFlag === 1 && delta < 0) delta += 2 * Math.PI;
  const theta = thetaStart + delta * fraction;
  return [cx + cosine * rx * Math.cos(theta) - sine * ry * Math.sin(theta), cy + sine * rx * Math.cos(theta) + cosine * ry * Math.sin(theta)];
}
function evaluateSvgCubic(values: number[], parameter: number): [number, number] {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = values;
  const inverse = 1 - parameter;
  const a = inverse ** 3;
  const b = 3 * inverse ** 2 * parameter;
  const c = 3 * inverse * parameter ** 2;
  const d = parameter ** 3;
  return [a! * x0! + b * x1! + c * x2! + d * x3!, a! * y0! + b * y1! + c * y2! + d * y3!];
}
function distanceToPolyline(point: number[], polyline: number[][]): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < polyline.length; index += 1) {
    const start = polyline[index - 1]!;
    const end = polyline[index]!;
    const delta = [end[0]! - start[0]!, end[1]! - start[1]!];
    const lengthSquared = delta[0]! * delta[0]! + delta[1]! * delta[1]!;
    const fraction = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point[0]! - start[0]!) * delta[0]! + (point[1]! - start[1]!) * delta[1]!) / lengthSquared));
    minimum = Math.min(minimum, Math.hypot(point[0]! - (start[0]! + fraction * delta[0]!), point[1]! - (start[1]! + fraction * delta[1]!)));
  }
  return minimum;
}
function projectWorldToSvg(pointMm: number[], plane: { originMm: number[]; normal: number[] }): [number, number] {
  const length = Math.hypot(...plane.normal);
  const normal = plane.normal.map((value) => value / length);
  const candidate = Math.abs(normal[0]!) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const alongNormal = candidate[0]! * normal[0]! + candidate[1]! * normal[1]! + candidate[2]! * normal[2]!;
  const xProjected = candidate.map((value, index) => value - normal[index]! * alongNormal);
  const xLength = Math.hypot(...xProjected);
  const xAxis = xProjected.map((value) => value / xLength);
  const yAxis = [
    normal[1]! * xAxis[2]! - normal[2]! * xAxis[1]!,
    normal[2]! * xAxis[0]! - normal[0]! * xAxis[2]!,
    normal[0]! * xAxis[1]! - normal[1]! * xAxis[0]!,
  ];
  const relative = pointMm.map((value, index) => value - plane.originMm[index]!);
  return [relative.reduce((sum, value, index) => sum + value * xAxis[index]!, 0), -relative.reduce((sum, value, index) => sum + value * yAxis[index]!, 0)];
}
function boundedError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000); }
function requireValue(argv: string[], index: number, option: string): string { const value = argv[index]; if (!value) throw new Error(`${option} requires a value`); return value; }
function selectedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv { return Object.fromEntries(Object.entries(environment).filter(([key]) => key.startsWith("PLASTICITY_") || key === "PATH" || key === "HOME" || key === "TMPDIR")); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
