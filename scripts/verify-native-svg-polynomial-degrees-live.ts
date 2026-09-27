#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
interface Options { help: boolean; target?: string; allowDisposableMutations: boolean; output?: string }

export function parseArgs(argv: string[]): Options {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: Options = { help: false, allowDisposableMutations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target") options.target = requireValue(argv, ++index, "--target");
    else if (argument === "--output") options.output = requireValue(argv, ++index, "--output");
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Polynomial SVG acceptance requires an explicit --target Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Polynomial SVG acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Polynomial SVG acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-svg-polynomial-degrees-live.ts --help
  node scripts/verify-native-svg-polynomial-degrees-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help this command performs no connection or mutation.
Live mode requires an explicitly selected empty Plasticity document, creates a
disposable cubic Wire, rebuilds it as non-rational degree-1 and degree-2
B-splines, verifies each exact SVG cubic span against independent native B-Rep
samples, checks Undo/Redo, and restores the empty scene. Creating the disposable
fixture replaces any prior Redo branch in that test document.`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidencePath = join(output, "evidence.json");
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target, workbenchUsed: false };
  const client = new Client({ name: "plasticity-native-svg-polynomial-degrees-live", version: "1.0.0" });
  const mutationStates: any[] = [];
  let initial: any;
  let failure: unknown;
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [join(projectRoot, "scripts", "run-server.ts")],
      cwd: projectRoot,
      env: { ...selectedEnvironment(process.env), PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" },
      stderr: "pipe",
    }));
    const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
    for (const name of ["plasticity_list_windows", "plasticity_connect", "plasticity_create_nurbs_curve", "plasticity_rebuild_curves", "plasticity_inspect_curve_structure", "plasticity_inspect_curve_planarity", "plasticity_list_curve_directions", "plasticity_evaluate_curve_segments", "plasticity_export_svg", "plasticity_status", "plasticity_undo", "plasticity_redo"]) {
      requireCondition(names.has(name), `Production MCP did not expose ${name}`);
    }
    const windows = await call<Array<{ targetId: string }>>(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initial = await call(client, "plasticity_connect", { targetId: options.target });
    requireEmpty(initial);
    evidence.initial = stateSummary(initial);
    const baselineSignature = sceneSignature(initial);

    let state = initial;
    let degreeTwoWireId: number | undefined;
    const reports: Record<string, unknown>[] = [];
    for (const fixture of [{ degree: 1, spans: 6 }, { degree: 2, spans: 4 }]) {
      const beforeCreate = state;
      const yOffset = fixture.degree === 1 ? 0 : 100;
      state = await call<any>(client, "plasticity_create_nurbs_curve", {
        pointsMm: [[0, yOffset, 0], [10, yOffset + 15, 0], [20, yOffset - 10, 0], [30, yOffset + 20, 0], [40, yOffset - 5, 0], [50, yOffset + 10, 0], [60, yOffset, 0]],
        closed: false, intent: `Disposable exact polynomial SVG degree-${fixture.degree} source`, revision: state.revision,
      });
      requireCondition(state.undoDepth === beforeCreate.undoDepth + 1, `Degree-${fixture.degree} source creation did not add one history step`);
      mutationStates.push(state);
      const added = state.bodies.filter((body: any) => !beforeCreate.bodies.some((before: any) => before.id === body.id) && body.type === "Wire");
      requireCondition(added.length === 1, `Degree-${fixture.degree} source did not create exactly one native Wire`);
      const wireId = added[0].id as number;
      const source = await curveStructure(client, wireId, state.revision);
      requireCondition(source.segments.length === 1 && source.segments[0].degree === 3 && source.segments[0].rational === false,
        `Degree-${fixture.degree} source is not a single non-rational cubic B-curve`);
      evidence[`degree${fixture.degree}Source`] = compactCurve(source.segments[0]);

      const undoDepthBeforeRebuild = state.undoDepth;
      state = await call<any>(client, "plasticity_rebuild_curves", {
        ids: [wireId], method: "degree-spans", degree: fixture.degree, spans: fixture.spans,
        intent: `Disposable exact polynomial SVG degree ${fixture.degree} acceptance rebuild`, revision: state.revision,
      });
      requireCondition(state.undoDepth === undoDepthBeforeRebuild + 1 && state.redoDepth === 0, `Degree-${fixture.degree} rebuild did not add exactly one native history step`);
      mutationStates.push(state);
      const structure = await curveStructure(client, wireId, state.revision);
      const segments = structure.segments as any[];
      const activeSpanCount = segments.reduce((sum, segment) => sum + segment.activeSpanCount, 0);
      requireCondition(segments.length > 0 && segments.every((segment) => segment.curveType === "BCurve" && segment.degree === fixture.degree && segment.rational === false && segment.periodic === false),
        `Native rebuild did not produce only non-rational degree-${fixture.degree} B-curve segments`);
      requireCondition(activeSpanCount === fixture.spans, `Native rebuild returned ${activeSpanCount} active spans instead of ${fixture.spans}`);

      const directions = await call<any>(client, "plasticity_list_curve_directions", {});
      const native = directions.curves?.find((curve: any) => curve.id === wireId);
      requireCondition(native?.measurementSource === "native-brep" && native.segments?.length === segments.length, "Native B-Rep segment identities do not match curve structure");
      const planarity = await call<any>(client, "plasticity_inspect_curve_planarity", { ids: [wireId], revision: state.revision });
      requireCondition(planarity.curves?.[0]?.planar === true, "Native planar projection basis is unavailable");
      const svgPath = join(output, `polynomial-degree-${fixture.degree}.svg`);
      const report = await call<any>(client, "plasticity_export_svg", {
        ids: [wireId], path: svgPath, curveChordToleranceMm: 0.02, curveChordAngleDegrees: 5, revision: state.revision,
      });
      requireCondition(report.cubicBezierSegments === segments.length && report.approximatedSegments === 0,
        `Degree-${fixture.degree} B-curve was not exported as exact cubic Bezier spans`);
      requireCondition(report.maxChordDeviationMm === 0, "Exact polynomial path reported polyline approximation deviation");
      const svg = await readFile(svgPath, "utf8");
      const paths = [...svg.matchAll(/<path d="([^"]+)" data-curve-type="BCurve"\/>/gu)].map((match) => match[1]!);
      requireCondition(paths.length === segments.length, `Degree-${fixture.degree} SVG paths do not match native B-curve segment count`);
      const fractions = [0.137, 0.5, 0.863];
      const requests: any[] = [];
      const expectedSamples: Array<{ span: number[]; startPoint: [number, number]; fraction: number }> = [];
      let totalSvgSpans = 0;
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
        const segment = segments[segmentIndex]!;
        const data = paths[segmentIndex]!;
        const move = data.match(/^M ([-+\d.eE]+) ([-+\d.eE]+)/u);
        const svgSpans = [...data.matchAll(/C ([-+\d.eE]+) ([-+\d.eE]+) ([-+\d.eE]+) ([-+\d.eE]+) ([-+\d.eE]+) ([-+\d.eE]+)/gu)].map((match) => match.slice(1).map(Number));
        requireCondition(move && svgSpans.length === segment.activeSpanCount && svgSpans.every((span: number[]) => span.every(Number.isFinite)),
          `Degree-${fixture.degree} SVG cubic commands do not match segment ${segmentIndex}'s native knot spans`);
        const knotParameters = segment.knots.map((knot: any) => knot.normalizedParameter);
        requireCondition(knotParameters.length === segment.activeSpanCount + 1 && knotParameters[0] === 0 && knotParameters.at(-1) === 1,
          `Degree-${fixture.degree} normalized knot breaks are inconsistent with segment ${segmentIndex}`);
        const firstPoint: [number, number] = move!.slice(1).map(Number) as [number, number];
        for (let spanIndex = 0; spanIndex < segment.activeSpanCount; spanIndex += 1) {
          const start = knotParameters[spanIndex]!;
          const end = knotParameters[spanIndex + 1]!;
          for (const fraction of fractions) {
            requests.push({ bodyId: wireId, segmentEntityId: native.segments[segmentIndex].entityId, normalizedParameter: start + (end - start) * fraction });
            expectedSamples.push({ span: svgSpans[spanIndex]!, startPoint: spanIndex === 0 ? firstPoint : svgSpans[spanIndex - 1]!.slice(4, 6) as [number, number], fraction });
          }
        }
        totalSvgSpans += svgSpans.length;
      }
      requireCondition(totalSvgSpans === fixture.spans, `Degree-${fixture.degree} SVG emitted ${totalSvgSpans} spans instead of ${fixture.spans}`);
      const exact = await call<any>(client, "plasticity_evaluate_curve_segments", { samples: requests, revision: state.revision });
      requireCondition(exact.samples.length === requests.length, "Native B-Rep evaluation omitted exact validation samples");
      let maxErrorMm = 0;
      for (let sampleIndex = 0; sampleIndex < expectedSamples.length; sampleIndex += 1) {
        const actual = projectWorldToSvg(exact.samples[sampleIndex].positionMm, planarity.curves[0].plane);
        const expected = expectedSamples[sampleIndex]!;
        const point = evaluateCubic([...expected.startPoint, ...expected.span] as number[], expected.fraction);
        maxErrorMm = Math.max(maxErrorMm, Math.hypot(actual[0] - point[0], actual[1] - point[1]));
      }
      requireCondition(maxErrorMm <= 1e-7, `Degree-${fixture.degree} SVG differs from independent native samples by ${maxErrorMm} mm`);
      reports.push({
        degree: fixture.degree, nativeCurveSegmentCount: segments.length, spanCount: activeSpanCount, svgCubicCommands: totalSvgSpans,
        exactNativeSamples: exact.samples.length, maxSampleErrorMm: maxErrorMm,
        approximationDeviationReportedMm: report.maxChordDeviationMm,
        svgSha256: createHash("sha256").update(svg).digest("hex"),
      });
      if (fixture.degree === 2) degreeTwoWireId = wireId;
    }
    evidence.polynomialDegreeExports = reports;

    if (degreeTwoWireId === undefined) throw new Error("Degree-2 acceptance fixture was not created");
    state = await call<any>(client, "plasticity_undo", { intent: "Verify degree-2 SVG fixture Undo", revision: state.revision });
    const undone = await curveStructure(client, degreeTwoWireId, state.revision);
    requireCondition(undone.segments.length === 1 && undone.segments[0].degree === 3 && undone.segments[0].rational === false, "Undo did not restore the degree-2 source cubic");
    state = await call<any>(client, "plasticity_redo", { intent: "Verify degree-2 SVG fixture Redo", revision: state.revision });
    const redone = await curveStructure(client, degreeTwoWireId, state.revision);
    requireCondition(redone.segments.every((segment: any) => segment.degree === 2 && segment.rational === false), "Redo did not restore the degree-2 B-curve");
    evidence.undoRedo = { undoRestoredDegree2SourceCubic: true, redoRestoredDegree2Result: true };

    while (mutationStates.length > 0) {
      const expected = mutationStates.at(-1)!;
      const actual = await call<any>(client, "plasticity_status", {});
      requireCondition(actual.targetId === initial.targetId && actual.documentToken === initial.documentToken && sceneSignature(actual) === sceneSignature(expected),
        "Test document changed outside the verifier's tracked native history; cleanup stopped without Undo");
      state = await call<any>(client, "plasticity_undo", { intent: "Restore empty document after polynomial SVG acceptance", revision: actual.revision });
      mutationStates.pop();
    }
    requireCondition(sceneSignature(state) === baselineSignature, "Cleanup did not restore the original empty document");
    evidence.cleanup = {
      restoredEmptyDocument: true,
      undoDepthRestored: state.undoDepth === initial.undoDepth,
      undoDepth: state.undoDepth,
      redoDepthBefore: initial.redoDepth,
      redoDepthAfter: state.redoDepth,
      priorRedoBranchReplacedByDisposableFixtures: initial.redoDepth > 0,
    };
    evidence.completedAt = new Date().toISOString();
    await writeFile(evidencePath, `${JSON.stringify(sanitizeEvidence(evidence), null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ ok: true, output, evidence: evidencePath }, null, 2));
  } catch (error) {
    failure = error;
    evidence.failure = boundedError(error);
    await writeFile(join(output, "failure.json"), `${JSON.stringify(sanitizeEvidence(evidence), null, 2)}\n`, { flag: "wx", mode: 0o600 }).catch(() => {});
    throw error;
  } finally {
    if (initial && mutationStates.length > 0) {
      while (mutationStates.length > 0) {
        const expected = mutationStates.at(-1)!;
        const actual = await call<any>(client, "plasticity_status", {}).catch(() => null);
        if (!actual || actual.targetId !== initial.targetId || actual.documentToken !== initial.documentToken || sceneSignature(actual) !== sceneSignature(expected)) break;
        const restored = await call<any>(client, "plasticity_undo", { intent: "Guarded cleanup after polynomial SVG acceptance", revision: actual.revision }).catch(() => null);
        if (!restored) break;
        mutationStates.pop();
      }
    }
    await client.close().catch(() => {});
  }
  if (failure) throw failure;
}

async function curveStructure(client: Client, id: number, revision: string): Promise<any> {
  const result = await call<any>(client, "plasticity_inspect_curve_structure", { ids: [id], revision });
  const curve = result.curves?.[0];
  requireCondition(curve?.segments?.length > 0 && curve.measurementSource === "native-brep", "Expected a native Wire B-curve");
  return curve;
}
async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const response = await client.callTool({ name, arguments: args });
  const content = (response as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const text = content.find((item) => item.type === "text")?.text;
  if (response.isError || !text) throw new Error(text ?? `MCP tool ${name} returned no text`);
  return JSON.parse(text) as T;
}
function requireEmpty(state: any): void {
  requireCondition(state.bodies.length === 0 && state.regions.length === 0,
    "Live polynomial SVG acceptance requires an empty document");
  requireCondition((state.instances ?? []).length === 0 && (state.referenceMeshes ?? []).length === 0 && (state.measurements ?? []).length === 0 && (state.sectionAnalyses ?? []).length === 0,
    "Live polynomial SVG acceptance requires no instances, references, measurements, or section analyses");
  requireCondition((state.groups ?? []).filter((group: any) => group.id !== 0).length === 0, "Live polynomial SVG acceptance requires no custom groups");
}
function sceneSignature(state: any): string {
  return JSON.stringify({ documentToken: state.documentToken, title: state.title, bodies: state.bodies, regions: state.regions,
    construction: state.construction, materials: state.materials ?? [], measurements: state.measurements ?? [],
    sectionAnalyses: state.sectionAnalyses ?? [], instances: state.instances ?? [], referenceMeshes: state.referenceMeshes ?? [],
    activeGroupId: state.activeGroupId ?? null, groups: state.groups ?? [], undoDepth: state.undoDepth });
}
function stateSummary(state: any): Record<string, unknown> { return { targetId: state.targetId, documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyIds: state.bodies.map((body: any) => body.id) }; }
function compactCurve(curve: any): Record<string, unknown> { return { curveType: curve.curveType, degree: curve.degree, controlPointCount: curve.controlPointCount, spanCount: curve.spanCount, rational: curve.rational, periodic: curve.periodic }; }
function projectWorldToSvg(pointMm: number[], plane: { originMm: number[]; normal: number[] }): [number, number] {
  const length = Math.hypot(...plane.normal);
  const normal = plane.normal.map((value) => value / length);
  const candidate = Math.abs(normal[0]!) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const alongNormal = candidate[0]! * normal[0]! + candidate[1]! * normal[1]! + candidate[2]! * normal[2]!;
  const xProjected = candidate.map((value, index) => value - normal[index]! * alongNormal);
  const xLength = Math.hypot(...xProjected);
  const xAxis = xProjected.map((value) => value / xLength);
  const yAxis = [normal[1]! * xAxis[2]! - normal[2]! * xAxis[1]!, normal[2]! * xAxis[0]! - normal[0]! * xAxis[2]!, normal[0]! * xAxis[1]! - normal[1]! * xAxis[0]!];
  const relative = pointMm.map((value, index) => value - plane.originMm[index]!);
  return [relative.reduce((sum, value, index) => sum + value * xAxis[index]!, 0), -relative.reduce((sum, value, index) => sum + value * yAxis[index]!, 0)];
}
function evaluateCubic(values: number[], parameter: number): [number, number] {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = values; const inverse = 1 - parameter;
  return [inverse ** 3 * x0! + 3 * inverse ** 2 * parameter * x1! + 3 * inverse * parameter ** 2 * x2! + parameter ** 3 * x3!,
    inverse ** 3 * y0! + 3 * inverse ** 2 * parameter * y1! + 3 * inverse * parameter ** 2 * y2! + parameter ** 3 * y3!];
}
function boundedError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function requireValue(argv: string[], index: number, option: string): string { const value = argv[index]; if (!value) throw new Error(`${option} requires a value`); return value; }
function selectedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv { return Object.fromEntries(Object.entries(environment).filter(([key]) => key.startsWith("PLASTICITY_") || key === "PATH" || key === "HOME" || key === "TMPDIR")); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
