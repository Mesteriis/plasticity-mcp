#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toleranceMm = 1e-6;

interface Options { help: boolean; target?: string; allowDisposableMutations: boolean; output?: string }
interface LiveMcp { client: Client; stderr: string[] }

export function parseNativeSvgImportAcceptanceArgs(argv: string[]): Options {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: Options = { help: false, allowDisposableMutations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target") options.target = requireValue(argv, ++index, "--target");
    else if (argument === "--output") options.output = requireValue(argv, ++index, "--output");
    else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live SVG-import acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live SVG-import acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live SVG-import acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-svg-import-live.ts --help
  node scripts/verify-native-svg-import-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

Live mode refuses a nonempty Plasticity document, imports one disposable SVG
through the public MCP in millimeters and inches, verifies exact native Wire
geometry, Region and direct-profile extrusion, Undo/Redo, and restores the empty
document.`;

async function main(): Promise<void> {
  const options = parseNativeSvgImportAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const svgPath = join(output, "profile-20x10.svg");
  await writeFile(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><path d="M 0 0 L 20 0 L 20 10 L 0 10 Z" fill="none" stroke="black"/></svg>\n', { flag: "wx", mode: 0o600 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target!, workbenchUsed: false };
  let live: LiveMcp | undefined;
  let initial: any;
  try {
    live = await startMcp(join(output, "strength-store"));
    const tools = await live.client.listTools();
    for (const name of ["plasticity_import_svg", "plasticity_create_rectangle", "plasticity_create_polyline", "plasticity_list_curve_directions", "plasticity_extrude_regions", "plasticity_extrude_profile", "plasticity_validate_bodies", "plasticity_undo", "plasticity_redo"]) {
      requireCondition(tools.tools.some((tool) => tool.name === name), `MCP did not expose ${name}`);
    }
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initial = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireEmpty(initial, "initial scene");
    evidence.initial = summary(initial);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "native-svg-import-live-initial-empty" });

    let state = await call(live.client, "plasticity_import_svg", {
      path: svgPath, sourceUnit: "millimeter", intent: "Import disposable exact SVG profile in millimeters", revision: initial.revision,
    });
    requireCondition(state.undoDepth === initial.undoDepth + 1, "SVG import did not create exactly one history step");
    const millimeterWire = onlyWire(state, "millimeter SVG import");
    boundsSizeNear(millimeterWire.boundsMm, [20, 10, 0], "millimeter SVG Wire");
    requireCondition(state.regions.length === 1 && state.regions[0].sketchWireIds.includes(millimeterWire.id), "Closed SVG did not create one associated Region");
    const millimeterRegionId = state.regions[0].id;
    const directions = await call(live.client, "plasticity_list_curve_directions", {});
    const curve = directions.curves.find((candidate: { id: number }) => candidate.id === millimeterWire.id);
    requireCondition(curve?.measurementSource === "native-brep" && curve.closed === true && curve.segments.length === 4, "Imported SVG is not one exact closed four-segment B-Rep Wire");
    const segmentLengths = curve.segments.map((segment: { lengthMm: number }) => segment.lengthMm).toSorted((left: number, right: number) => left - right);
    [10, 10, 20, 20].forEach((expected, index) => near(segmentLengths[index], expected, toleranceMm, `SVG segment ${index}`));

    state = await call(live.client, "plasticity_extrude_regions", {
      regionIds: [state.regions[0].id], distanceMm: 8, intent: "Prove the imported SVG Region is an editable native extrusion profile", revision: state.revision,
    });
    const solid = onlyBodyOfType(state, "Solid", "SVG Region extrusion");
    boundsSizeNear(solid.boundsMm, [20, 10, 8], "extruded SVG Solid");
    const validation = await call(live.client, "plasticity_validate_bodies", { ids: [solid.id], revision: state.revision });
    requireCondition(validation.bodies.length === 1 && validation.bodies[0].nativeValid && validation.bodies[0].printableSolid, "Extruded SVG Solid failed native validation");
    const created = summary(state);
    state = await call(live.client, "plasticity_undo", { intent: "Verify SVG extrusion Undo", revision: state.revision });
    requireCondition(!state.bodies.some((body: { type: string }) => body.type === "Solid"), "Extrusion Undo did not remove the SVG-derived Solid");
    boundsSizeNear(onlyWire(state, "extrusion Undo").boundsMm, [20, 10, 0], "SVG Wire after extrusion Undo");
    state = await call(live.client, "plasticity_redo", { intent: "Verify SVG extrusion Redo", revision: state.revision });
    const redoneSolid = onlyBodyOfType(state, "Solid", "extrusion Redo");
    requireCondition(redoneSolid.id === solid.id, "Extrusion Redo did not restore the stable Solid ID");
    boundsSizeNear(redoneSolid.boundsMm, [20, 10, 8], "SVG Solid after Redo");
    state = await undoToDepth(live.client, state, initial.undoDepth, "Clean SVG geometry before direct-profile extrusion");
    requireEmpty(state, "before direct-profile extrusion");

    state = await call(live.client, "plasticity_create_rectangle", {
      centerMm: [5, 7, 0], widthMm: 30, heightMm: 18, intent: "Create a closed exact profile for direct extrusion", revision: state.revision,
    });
    const directProfile = onlyWire(state, "native rectangle profile");
    boundsSizeNear(directProfile.boundsMm, [30, 18, 0], "native rectangle profile");
    requireCondition(state.regions.length === 1 && state.regions[0].sketchWireIds.includes(directProfile.id), "Native rectangle did not create one associated Region");
    state = await call(live.client, "plasticity_extrude_profile", {
      id: directProfile.id, distanceMm: 12, intent: "Verify direct closed-Wire profile extrusion", revision: state.revision,
    });
    const directSolid = onlyBodyOfType(state, "Solid", "direct-profile extrusion");
    boundsSizeNear(directSolid.boundsMm, [30, 18, 12], "direct-profile Solid");
    const directValidation = await call(live.client, "plasticity_validate_bodies", { ids: [directSolid.id], revision: state.revision });
    requireCondition(directValidation.bodies.length === 1 && directValidation.bodies[0].nativeValid && directValidation.bodies[0].printableSolid, "Direct-profile extrusion failed native Solid validation");
    state = await call(live.client, "plasticity_undo", { intent: "Verify direct-profile extrusion Undo", revision: state.revision });
    requireCondition(!state.bodies.some((body: { type: string }) => body.type === "Solid"), "Direct-profile extrusion Undo did not remove its Solid");
    boundsSizeNear(onlyWire(state, "direct-profile extrusion Undo").boundsMm, [30, 18, 0], "profile Wire after extrusion Undo");
    state = await call(live.client, "plasticity_redo", { intent: "Verify direct-profile extrusion Redo", revision: state.revision });
    const redoneDirectSolid = onlyBodyOfType(state, "Solid", "direct-profile extrusion Redo");
    requireCondition(redoneDirectSolid.id === directSolid.id, "Direct-profile extrusion Redo did not restore the stable Solid ID");
    boundsSizeNear(redoneDirectSolid.boundsMm, [30, 18, 12], "direct-profile Solid after Redo");
    evidence.directProfileExtrusion = {
      profileBodyId: directProfile.id, profileBoundsMm: directProfile.boundsMm,
      solidBodyId: directSolid.id, solidBoundsMm: directSolid.boundsMm, validation: directValidation.bodies[0],
      history: { undoRestoredProfile: true, redoRestoredStableSolidId: true },
    };
    state = await undoToDepth(live.client, state, initial.undoDepth, "Clean direct-profile extrusion acceptance");
    requireEmpty(state, "after direct-profile extrusion cleanup");

    state = await call(live.client, "plasticity_create_polyline", {
      pointsMm: [[0, 0, 0], [10, 0, 0]], closed: false, intent: "Create a disposable open Wire to test extrusion rejection", revision: state.revision,
    });
    const openProfile = onlyWire(state, "open profile guard fixture");
    const rejectedExtrusion = await live.client.callTool({ name: "plasticity_extrude_profile", arguments: {
      id: openProfile.id, distanceMm: 8, intent: "Ensure an open Wire cannot be extruded as a closed profile", revision: state.revision,
    } });
    requireCondition("isError" in rejectedExtrusion && rejectedExtrusion.isError === true, "Direct-profile extrusion accepted an open Wire");
    requireCondition(/closed Wire/u.test(toolText(rejectedExtrusion)), "Open-profile rejection did not explain the required closed Wire");
    const afterRejectedExtrusion = await call(live.client, "plasticity_status", {});
    requireCondition(afterRejectedExtrusion.revision === state.revision && afterRejectedExtrusion.undoDepth === state.undoDepth, "Rejected open-profile extrusion changed the document or history");
    requireCondition(afterRejectedExtrusion.bodies.length === 1 && afterRejectedExtrusion.bodies[0].id === openProfile.id, "Rejected open-profile extrusion changed the open Wire");
    evidence.openProfileRejectedWithoutMutation = true;
    state = await undoToDepth(live.client, afterRejectedExtrusion, initial.undoDepth, "Clean open Wire guard fixture");
    requireEmpty(state, "after open-profile guard cleanup");

    evidence.millimeter = {
      wireBodyId: millimeterWire.id,
      wireBoundsMm: millimeterWire.boundsMm,
      regionId: millimeterRegionId,
      segmentLengthsMm: segmentLengths,
      extrusion: { solidBodyId: solid.id, boundsMm: solid.boundsMm, validation: validation.bodies[0] },
      history: { created, undoRestoredWire: true, redoRestoredStableSolidId: true },
    };

    state = await undoToDepth(live.client, state, initial.undoDepth, "Clean up millimeter SVG acceptance");
    requireEmpty(state, "post-millimeter cleanup");
    state = await call(live.client, "plasticity_import_svg", {
      path: svgPath, sourceUnit: "inch", intent: "Verify explicit inch scaling for SVG coordinate values", revision: state.revision,
    });
    const inchWire = onlyWire(state, "inch SVG import");
    boundsSizeNear(inchWire.boundsMm, [508, 254, 0], "inch SVG Wire");
    requireCondition(state.regions.length === 1, "Inch SVG did not create one closed Region");
    evidence.inch = { wireBodyId: inchWire.id, wireBoundsMm: inchWire.boundsMm, expectedScaleToMillimeters: 25.4 };
    state = await undoToDepth(live.client, state, initial.undoDepth, "Clean up inch SVG acceptance");
    requireEmpty(state, "post-inch cleanup");

    const additionalUnits: Record<string, number> = { centimeter: 10, meter: 1000, foot: 304.8 };
    const additionalUnitEvidence: Record<string, unknown> = {};
    for (const [sourceUnit, scaleToMillimeters] of Object.entries(additionalUnits)) {
      state = await call(live.client, "plasticity_import_svg", {
        path: svgPath, sourceUnit, intent: `Verify explicit ${sourceUnit} scaling for SVG coordinate values`, revision: state.revision,
      });
      const wire = onlyWire(state, `${sourceUnit} SVG import`);
      boundsSizeNear(wire.boundsMm, [20 * scaleToMillimeters, 10 * scaleToMillimeters, 0], `${sourceUnit} SVG Wire`);
      requireCondition(state.regions.length === 1, `${sourceUnit} SVG did not create one closed Region`);
      additionalUnitEvidence[sourceUnit] = { wireBoundsMm: wire.boundsMm, scaleToMillimeters };
      state = await undoToDepth(live.client, state, initial.undoDepth, `Clean up ${sourceUnit} SVG acceptance`);
      requireEmpty(state, `post-${sourceUnit} cleanup`);
    }
    evidence.additionalUnits = additionalUnitEvidence;
    requireEmpty(state, "final cleanup");

    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial snapshot after cleanup");
    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCondition(journal.syncStatus === "in-sync", "Construction journal is not synchronized after SVG cleanup");
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true, journal: journal.syncStatus };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json") }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    if (live && initial) evidence.cleanup = await recover(live.client, initial).catch((cleanupError) => ({ restoredEmptyDocument: false, reason: boundedError(cleanupError) }));
    await writeExclusive(join(output, "failure.json"), sanitizeEvidence(evidence)).catch(() => {});
    throw error;
  } finally {
    await live?.client.close().catch(() => {});
  }
}

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" }, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-native-svg-import-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const message = toolText(response);
  if ("isError" in response && response.isError) throw new Error(message);
  return JSON.parse(message);
}

function toolText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content");
  const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string");
  if (!item) throw new Error("MCP tool returned no text content");
  return item.text;
}

function onlyWire(state: any, label: string): any {
  const wires = state.bodies.filter((body: { type: string }) => body.type === "Wire");
  requireCondition(wires.length === 1 && state.bodies.length === 1, `${label}: expected one Wire and no other bodies`);
  return wires[0];
}

function onlyBodyOfType(state: any, type: string, label: string): any {
  const matches = state.bodies.filter((body: { type: string }) => body.type === type);
  requireCondition(matches.length === 1, `${label}: expected one ${type}, found ${matches.length}`);
  return matches[0];
}

function boundsSizeNear(bounds: any, expected: number[], label: string): void {
  requireCondition(bounds?.min?.length === 3 && bounds?.max?.length === 3, `${label}: native bounds are unavailable`);
  bounds.max.forEach((value: number, index: number) => near(value - bounds.min[index], expected[index]!, toleranceMm, `${label}[${index}]`));
}

function requireEmpty(state: any, label: string): void {
  requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0 && (state.referenceMeshes ?? []).length === 0, `${label}: expected no scene geometry`);
  requireCondition((state.groups ?? []).filter((group: { id: number }) => group.id !== 0).length === 0, `${label}: expected no non-root groups`);
}

async function undoToDepth(client: Client, initialState: any, depth: number, intent: string): Promise<any> {
  let state = initialState;
  for (let count = 0; state.undoDepth > depth && count < 16; count += 1) state = await call(client, "plasticity_undo", { intent, revision: state.revision });
  requireCondition(state.undoDepth === depth, `Undo cleanup did not reach initial depth ${depth}`);
  return state;
}

async function recover(client: Client, initial: any): Promise<Record<string, unknown>> {
  const state = await undoToDepth(client, await call(client, "plasticity_status", {}), initial.undoDepth, "Recover disposable SVG acceptance");
  return { restoredEmptyDocument: state.documentToken === initial.documentToken && state.bodies.length === 0 && state.regions.length === 0 };
}

function summary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length, regionCount: state.regions.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function requireValue(argv: string[], index: number, option: string): string { const value = argv[index]; if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`); return value; }
function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : [])); }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
