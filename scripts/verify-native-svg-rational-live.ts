#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = join(projectRoot, "scripts", "fixtures", "native-svg-rational-conic.step");

interface AcceptanceBody { id: number; type: string; name: string | null; edgeIds: string[] }
interface AcceptanceGroup {
  bodyIds: number[];
  instanceIds: number[];
  referenceMeshIds: number[];
  otherNodeKeys: number[];
  childGroupIds: number[];
}
interface AcceptanceState {
  documentToken: string;
  title: string;
  revision: string;
  undoDepth: number;
  redoDepth: number;
  bodies: AcceptanceBody[];
  regions: unknown[];
  construction: unknown;
  materials?: unknown[];
  measurements?: unknown[];
  sectionAnalyses?: unknown[];
  instances?: unknown[];
  referenceMeshes?: unknown[];
  activeGroupId?: number;
  groups?: AcceptanceGroup[];
}
interface CurveStructureResponse {
  curves: Array<{ id: number; segments: Array<{ curveType: string; degree: number | null; rational: boolean | null; periodic: boolean | null; lengthMm: number }> }>;
}
interface SvgExportReport {
  ellipticalArcs: number;
  approximatedSegments: number;
  cubicBezierSegments: number;
  [key: string]: unknown;
}

export interface RationalSvgAcceptanceOptions {
  help: boolean;
  target?: string;
  allowLive: boolean;
  output?: string;
}

export function parseArgs(argv: string[]): RationalSvgAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowLive: false };
  const options: RationalSvgAcceptanceOptions = { help: false, allowLive: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-live") options.allowLive = true;
    else if (argument === "--target") options.target = requireValue(argv, ++index, "--target");
    else if (argument === "--output") options.output = requireValue(argv, ++index, "--output");
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Rational SVG acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowLive) throw new Error("Rational SVG acceptance requires --allow-live");
  if (!options.output) throw new Error("Rational SVG acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-svg-rational-live.ts --help
  node scripts/verify-native-svg-rational-live.ts --target ID --allow-live --output NEW_EMPTY_DIRECTORY

Imports the repository's authored rational quadratic STEP wireframe into an
explicit disposable, empty Plasticity document, checks the native B-Rep and
sample-validated SVG ellipse arc through the production stdio MCP, then undoes
the import and verifies the original empty scene. The final Redo entry belongs
to the disposable fixture; close that test document when finished.`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const svgPath = join(output, "rational-quarter-circle.svg");
  const evidencePath = join(output, "evidence.json");
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), fixture: "authored-rational-quarter-circle", workbenchUsed: false };
  const client = new Client({ name: "plasticity-native-svg-rational-live", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "run-server.ts")],
    cwd: projectRoot,
    env: {
      ...selectedEnvironment(process.env),
      PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223",
      PLASTICITY_REFERENCE_ROOT: join(output, "references"),
    },
    stderr: "pipe",
  }));

  let initial: AcceptanceState | undefined;
  let completed = false;
  let failure: unknown;
  try {
    const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ["plasticity_list_windows", "plasticity_connect", "plasticity_import_step", "plasticity_inspect_curve_structure", "plasticity_inspect_curve_planarity", "plasticity_export_svg", "plasticity_status", "plasticity_undo"]) {
      requireCondition(toolNames.includes(name), `Production MCP did not expose ${name}`);
    }
    const windows = await call<Array<{ targetId: string }>>(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    const initialState = await call<AcceptanceState>(client, "plasticity_connect", { targetId: options.target });
    initial = initialState;
    const emptyGroups = (initialState.groups ?? []).every((group) => group.bodyIds.length === 0 && group.instanceIds.length === 0 && group.referenceMeshIds.length === 0 && group.otherNodeKeys.length === 0 && group.childGroupIds.length === 0);
    requireCondition(initialState.bodies.length === 0 && initialState.regions.length === 0 && initialState.undoDepth === 0 && initialState.redoDepth === 0 &&
      (initialState.instances?.length ?? 0) === 0 && (initialState.referenceMeshes?.length ?? 0) === 0 && (initialState.measurements?.length ?? 0) === 0 &&
      (initialState.sectionAnalyses?.length ?? 0) === 0 && emptyGroups,
      "Rational SVG acceptance requires a disposable empty document with clean Undo and Redo history");
    evidence.initialScene = { bodyCount: initialState.bodies.length, regionCount: initialState.regions.length, undoDepth: initialState.undoDepth, redoDepth: initialState.redoDepth };

    const fixture = await readFile(fixturePath);
    const fixtureHash = createHash("sha256").update(fixture).digest("hex");
    const imported = await call<AcceptanceState>(client, "plasticity_import_step", {
      path: fixturePath,
      intent: "Disposable rational conic SVG acceptance fixture",
      revision: initial.revision,
    });
    const added = imported.bodies.filter((body) => !initialState.bodies.some((before) => before.id === body.id));
    const addedWire = added[0];
    if (added.length !== 1 || !addedWire || addedWire.type !== "Wire") throw new Error("STEP fixture did not add exactly one native Wire");
    requireCondition(imported.undoDepth === initial.undoDepth + 1 && imported.redoDepth === 0, "STEP import did not create exactly one native Undo step");

    const structure = await call<CurveStructureResponse>(client, "plasticity_inspect_curve_structure", { ids: [addedWire.id], revision: imported.revision });
    const curve = structure.curves[0];
    if (!curve || curve.segments.length !== 1) throw new Error("STEP fixture did not produce one curve segment");
    const segment = curve.segments[0];
    if (!segment) throw new Error("STEP fixture curve segment is unavailable");
    requireCondition(segment?.curveType === "BCurve" && segment.degree === 2 && segment.rational === true && segment.periodic === false,
      "STEP fixture was not imported as a rational quadratic BCurve");

    const planarity = await call<{ curves: Array<{ planar: boolean }> }>(client, "plasticity_inspect_curve_planarity", { ids: [addedWire.id], revision: imported.revision });
    requireCondition(planarity.curves?.[0]?.planar === true, "Rational conic fixture is not natively planar");
    const exportReport = await call<SvgExportReport>(client, "plasticity_export_svg", { ids: [addedWire.id], path: svgPath, revision: imported.revision });
    const svg = await readFile(svgPath, "utf8");
    requireCondition(exportReport.ellipticalArcs === 1 && exportReport.approximatedSegments === 0 && exportReport.cubicBezierSegments === 0,
      "Rational BCurve did not export through the conic representation");
    requireCondition(/data-representation="ellipse-fit" data-validation="65-native-brep-samples"/u.test(svg),
      "SVG omitted its sampled-conic validation metadata");
    requireCondition(/<path d="M [^"]+ A [^"]+" data-curve-type="BCurve"/u.test(svg), "SVG rational conic arc path is missing");
    evidence.fixture = { sha256: fixtureHash, bytes: fixture.byteLength };
    evidence.nativeCurve = { bodyType: addedWire.type, segmentType: segment.curveType, degree: segment.degree, rational: segment.rational, periodic: segment.periodic, lengthMm: segment.lengthMm };
    evidence.export = { ...exportReport, svgSha256: createHash("sha256").update(svg).digest("hex"), svgBytes: Buffer.byteLength(svg), sampledNativeValidation: 65 };
  } catch (error) {
    failure = error;
    evidence.failure = boundedError(error);
  } finally {
    if (initial) {
      const baselineState = initial;
      try {
        const status = await call<AcceptanceState>(client, "plasticity_status", {});
        const baselineSignature = sceneSignature(baselineState);
        if (sceneSignature(status) === baselineSignature) {
          evidence.cleanup = { originalSceneRestored: true, undoDepth: status.undoDepth, redoDepth: status.redoDepth, recovery: "scene already matches baseline" };
        } else {
          const added = status.bodies.filter((body) => !baselineState.bodies.some((before) => before.id === body.id));
          const importedWire = added[0];
          if (status.documentToken !== baselineState.documentToken || status.undoDepth !== baselineState.undoDepth + 1 || status.redoDepth !== 0 || added.length !== 1 || importedWire?.type !== "Wire") {
            throw new Error("Import outcome is not uniquely identifiable; inspect Plasticity state before cleanup");
          }
          const restored = await call<AcceptanceState>(client, "plasticity_undo", { intent: "Restore empty scene after rational SVG acceptance", revision: status.revision });
          requireCondition(sceneSignature(restored) === baselineSignature, "Undo did not restore the original empty scene");
          evidence.cleanup = { originalSceneRestored: true, undoDepth: restored.undoDepth, redoDepth: restored.redoDepth, recovery: "one verified STEP import Undo" };
        }
      } catch (error) {
        evidence.cleanup = { originalSceneRestored: false, error: boundedError(error) };
        failure ??= error;
      }
    }
    evidence.completedAt = new Date().toISOString();
    completed = failure === undefined && evidence.cleanup !== undefined;
    await writeFile(completed ? evidencePath : join(output, "failure.json"), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 }).catch((error: unknown) => { failure ??= error; });
    await client.close();
  }
  if (failure) throw failure;
  console.log(JSON.stringify({ ok: true, svg: svgPath, evidence: evidencePath }, null, 2));
}

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const response = await client.callTool({ name, arguments: args });
  const text = toolText(response);
  if ("isError" in response && response.isError) throw new Error(text);
  return JSON.parse(text) as T;
}
function toolText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content");
  const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string");
  if (!item) throw new Error("MCP tool returned no text content");
  return item.text;
}
function sceneSignature(state: AcceptanceState): string { return JSON.stringify({ documentToken: state.documentToken, title: state.title, bodies: state.bodies, regions: state.regions, construction: state.construction, materials: state.materials ?? [], measurements: state.measurements ?? [], sectionAnalyses: state.sectionAnalyses ?? [], instances: state.instances ?? [], referenceMeshes: state.referenceMeshes ?? [], activeGroupId: state.activeGroupId ?? null, groups: state.groups ?? [], undoDepth: state.undoDepth }); }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function requireValue(argv: string[], index: number, name: string): string { const value = argv[index]; if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`); return value; }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 2_000); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
