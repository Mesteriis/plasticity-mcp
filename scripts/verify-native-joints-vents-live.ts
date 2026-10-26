#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isolatedAcceptanceEnvironment } from "./verify-native-measure-datum-files-live.ts";

import { hydrateNativeState } from "./native-live-state.ts";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const JOINT_VENT_CASES = ["vent-array", "heat-set-pocket", "pin-pair", "pin-pattern", "snap-fit", "dovetail", "enclosure", "cable-channel", "cable-channel-geometry"] as const;
type JointVentCase = typeof JOINT_VENT_CASES[number];

interface Options { case: JointVentCase; help: boolean; target?: string; output?: string; allowDisposableMutations: boolean }

export function parseNativeJointsVentsAcceptanceArgs(argv: string[]): Options {
  const options: Options = { help: argv.length === 0, allowDisposableMutations: false, case: "vent-array" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target" || argument === "--output" || argument === "--case") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--target") options.target = value;
      else if (argument === "--output") options.output = value;
      else {
        if (!(JOINT_VENT_CASES as readonly string[]).includes(value)) throw new Error(`Unknown catalog case: ${value}`);
        options.case = value as JointVentCase;
      }
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live native-joints-vents acceptance requires --target with an explicit Plasticity window ID");
  if (!options.allowDisposableMutations) throw new Error("Live native-joints-vents acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live native-joints-vents acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-native-joints-vents-live.ts --help
  node scripts/verify-native-joints-vents-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

Cases: ${JOINT_VENT_CASES.join(", ")} (select with --case).
cable-channel-geometry adds six material-envelope probes and a positive overlap
control. It does not relabel conservative FindBox bounds as exact.

No-argument and --help modes do not connect to Plasticity. Live mode requires
an explicit empty disposable document, verifies native joints, vents and cable channels and
mass properties through stdio MCP, checks Undo/Redo, restores the scene, and
writes sanitized evidence.`;

async function main(): Promise<void> {
  const options = parseNativeJointsVentsAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { recursive: false, mode: 0o700 });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), targetId: options.target, workbenchUsed: false };
  let client: Client | undefined;
  let initial: any;
  let state: any;
  try {
    client = await startMcp(join(output, "strength-store"));
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initial = await call(client, "plasticity_connect", { targetId: options.target });
    requireEmpty(initial);
    evidence.initial = summary(initial);
    const snapshot = await call(client, "plasticity_capture_snapshot", { label: "native-joints-vents-acceptance-initial-empty" });

    evidence.case = options.case;
    state = initial;
    const mutate = async (name: string, args: Record<string, unknown>): Promise<any> => {
      const result = await call(client!, name, { ...args, revision: state.revision });
      if (result.status === "completed" && result.afterRevision) {
        state = await call(client!, "plasticity_status", {});
        requireCondition(result.documentToken === state.documentToken && result.afterRevision === state.revision, "Recipe report/current native state mismatch");
      } else state = result;
      return result;
    };
    const paired = ["pin-pair", "pin-pattern", "dovetail", "enclosure"].includes(options.case);
    const size = options.case === "heat-set-pocket" ? [20, 20, 12] : options.case === "snap-fit" ? [5, 20, 10] : options.case.startsWith("cable-channel") ? [30, 20, 10] : [30, 20, 5];
    await mutate("plasticity_create_box", { originMm: [0, 0, 0], sizeMm: size });
    const maleId = state.bodies[0].id;
    let femaleId: number | undefined;
    let spineId: number | undefined;
    if (paired) {
      await mutate("plasticity_create_box", { originMm: [0, 0, 5], sizeMm: [30, 20, 10] });
      femaleId = state.bodies.find((body: any) => body.id !== maleId).id;
    } else if (options.case.startsWith("cable-channel")) {
      await mutate("plasticity_create_polyline", { pointsMm: [[-1, 10, 10], [31, 10, 10]], closed: false });
      spineId = state.bodies.find((body: any) => body.type === "Wire").id;
    }
    const probeIds: number[] = [];
    let positiveControlId: number | undefined;
    if (options.case === "cable-channel-geometry") {
      for (let axis = 0; axis < 3; axis += 1) for (const side of [-1,1]) {
        const origin = [-64,-64,-64]; const probeSize = [128,128,128];
        if (side > 0) { origin[axis] = size[axis]! + 0.00001; probeSize[axis] = 64 - origin[axis]!; }
        else probeSize[axis] = 64 - 0.00001;
        const before = new Set(state.bodies.map((body: any) => body.id));
        await mutate("plasticity_create_box", { originMm: origin, sizeMm: probeSize });
        const added = state.bodies.filter((body: any) => !before.has(body.id)); requireCondition(added.length === 1, "Envelope probe creation failed"); probeIds.push(added[0].id);
      }
      const before = new Set(state.bodies.map((body: any) => body.id));
      await mutate("plasticity_create_box", { originMm: [1,1,9.00101], sizeMm: [1,1,1] });
      positiveControlId = state.bodies.find((body: any) => !before.has(body.id)).id;
    }
    const source = state;
    const sourceSnapshot = await call(client, "plasticity_capture_snapshot", { label: "joint-recipe-source" });
    let steps = 1;
    let report: any;
    switch (options.case) {
      case "vent-array":
        steps = 3;
        report = await mutate("plasticity_create_round_vent_array", { targetId: maleId, firstCenterMm: [5, 5, 5], axis: [0, 0, -1], holeDiameterMm: 3, throughDepthMm: 5, direction1: [1, 0, 0], count1: 3, spacing1Mm: 10, direction2: [0, 1, 0], count2: 2, spacing2Mm: 10 }); break;
      case "heat-set-pocket":
        steps = 4;
        report = await mutate("plasticity_create_heat_set_insert_pocket", { targetId: maleId, entryCenterMm: [10, 10, 12], axis: [0, 0, -1], pilotDiameterMm: 3, pilotDepthMm: 9, insertDiameterMm: 5, insertDepthMm: 6, leadInDiameterMm: 7, leadInDepthMm: 1, materialDepthMm: 12 }); break;
      case "pin-pair": case "pin-pattern": {
        steps = options.case === "pin-pair" ? 4 : 6;
        report = await mutate(options.case === "pin-pair" ? "plasticity_create_locating_pin_pair" : "plasticity_create_locating_pin_pair_pattern", { maleTargetId: maleId, femaleTargetId: femaleId, ...(options.case === "pin-pair" ? { baseCenterMm: [15, 10, 5] } : { baseCentersMm: [[8, 10, 5], [22, 10, 5]] }), axis: [0, 0, 1], pinDiameterMm: 4, pinHeightMm: 4, radialClearanceMm: 0.2, axialClearanceMm: 0.3 }); break;
      }
      case "snap-fit":
        steps = 3;
        report = await mutate("plasticity_create_cantilever_snap_fit", { targetId: maleId, baseCenterMm: [5, 10, 2], beamDirection: [1, 0, 0], thicknessDirection: [0, 0, 1], lengthMm: 10, widthMm: 4, thicknessMm: 2, hookLengthMm: 2, hookHeightMm: 1 }); break;
      case "dovetail":
        steps = 6;
        report = await mutate("plasticity_create_dovetail_joint", { maleTargetId: maleId, femaleTargetId: femaleId, baseCenterMm: [15, 10, 5], axis: [0, 0, 1], widthDirection: [1, 0, 0], rootWidthMm: 6, flareMm: 1, tongueThicknessMm: 4, tongueHeightMm: 4, radialClearanceMm: 0.2, axialClearanceMm: 0.3 }); break;
      case "enclosure":
        steps = 8;
        report = await mutate("plasticity_create_mating_enclosure_joint", { maleTargetId: maleId, femaleTargetId: femaleId, seamOriginMm: [0, 0, 5], outerWidthMm: 30, outerDepthMm: 20, wallThicknessMm: 2, lipThicknessMm: 1, lipHeightMm: 3, clearanceMm: 0.2, overlapMm: 0.25, cutterOvershootMm: 0.25 }); break;
      case "cable-channel-geometry":
      case "cable-channel":
        steps = 2;
        report = await mutate("plasticity_cut_cable_channel", { targetId: maleId, spineIds: [spineId], channelDiameterMm: 4 }); break;
    }
    evidence.recipe = report;
    requireCondition(report.status === "completed" && report.undoSteps === steps && report.steps.length === steps && state.undoDepth === source.undoDepth + steps, "Recipe/native history count mismatch");
    const check = async (): Promise<void> => {
      evidence.observedBodies = state.bodies.map((body: any) => ({ id: body.id, type: body.type, boundsMm: body.boundsMm }));
      const solids = state.bodies.filter((body: any) => body.type === "Solid");
      const wires = state.bodies.filter((body: any) => body.type === "Wire");
      const wireCount = options.case === "dovetail" ? 2 : ["snap-fit", "cable-channel", "cable-channel-geometry"].includes(options.case) ? 1 : 0;
      requireCondition(solids.length === (paired ? 2 : 1) + probeIds.length + (positiveControlId === undefined ? 0 : 1) && wires.length === wireCount && state.bodies.length === solids.length + wires.length, "Unexpected output solids/profiles or leftover cutters");
      requireCondition(solids.some((body: any) => body.id === maleId) && (!paired || solids.some((body: any) => body.id === femaleId)), "Recipe changed target identities");
      requireCondition(report.consumedToolIds.every((id: number) => !state.bodies.some((body: any) => body.id === id)), "Consumed recipe cutter remains in scene");
      if (spineId !== undefined) requireCondition(wires[0]?.id === spineId, "Cable source Wire identity was not retained");
      if (report.profileBodyId) requireCondition(wires.some((body: any) => body.id === report.profileBodyId), "Editable snap profile missing");
      if (report.profileBodyIds) requireCondition(report.profileBodyIds.every((id: number) => wires.some((body: any) => body.id === id)), "Editable dovetail profiles missing");
      const ids = solids.map((body: any) => body.id);
      const validation = await call(client!, "plasticity_validate_bodies", { ids, revision: state.revision });
      requireCondition(validation.bodies.length === solids.length && ids.every((id: number) => validation.bodies.some((body: any) => body.id === id)) && validation.bodies.every((body: any) => body.nativeValid && body.printableSolid), "Recipe failed native Solid validation");
      const mass = await call(client!, "plasticity_measure_solid_properties", { ids, revision: state.revision });
      requireCondition(mass.bodies.length === ids.length && ids.every((id: number) => mass.bodies.some((body: any) => body.id === id)), "Incomplete native mass-property identities");
      const pinCount = options.case === "pin-pattern" ? 2 : 1;
      const maleVolume = options.case === "vent-array" ? 3000 - 67.5 * Math.PI : options.case === "heat-set-pocket" ? 4800 - 50.25 * Math.PI : options.case.startsWith("pin-") ? 3000 + pinCount * 16 * Math.PI : options.case === "snap-fit" ? 1088 : options.case === "dovetail" ? 3112 : options.case === "enclosure" ? 3303.75 : 6000 - 60 * Math.PI;
      const femaleVolume = options.case.startsWith("pin-") ? 6000 - pinCount * 2.2 ** 2 * 4.3 * Math.PI : options.case === "dovetail" ? 6000 - 7.4 * 4.4 * 4.3 : 6000 - 133.65 * 3.25;
      for (const body of mass.bodies.filter((body: any) => body.id === maleId || body.id === femaleId)) near(body.volumeMm3, body.id === maleId ? maleVolume : femaleVolume, options.case.startsWith("cable-channel") ? 0.01 : 0.0001, "recipe volume");
      const male = solids.find((body: any) => body.id === maleId);
      const maximum = paired ? [30, 20, options.case.startsWith("pin-") || options.case === "dovetail" ? 9 : 8] : options.case === "snap-fit" ? [15, 20, 10] : size;
      if (options.case === "cable-channel-geometry") {
        requireCondition(male.boundsMethod === "native-box" || male.boundsMethod === "native-extrema", "Unknown bounds provenance");
        requireCondition([...male.boundsMm.min,...male.boundsMm.max].every((value: number) => Math.abs(value) < 64), "Reported body box exceeds the envelope probe domain");
        if (male.boundsMethod === "native-extrema") { vectorNear(male.boundsMm.min, [0,0,0], 0.00001, "exact minimum"); vectorNear(male.boundsMm.max, maximum, 0.00001, "exact maximum"); }
        for (const original of source.bodies.filter((body: any) => body.id !== maleId)) requireCondition(JSON.stringify(state.bodies.find((body: any) => body.id === original.id)) === JSON.stringify(original), "Recipe changed its retained source or envelope controls");
        const containment = await call(client!, "plasticity_check_interference", { pairs: [...probeIds.map(id => ({ firstBodyId: maleId, secondBodyId: id })), { firstBodyId: positiveControlId, secondBodyId: probeIds[5] }], revision: state.revision });
        requireCondition(containment.source === "native-brep-temporary-intersection" && containment.pairs.length === 7 && containment.pairs.slice(0,6).every((pair: any) => pair.status === "no-volumetric-interference"), "Native material escapes the padded nominal envelope");
        requireCondition(containment.pairs[6].status === "interfere", "Thin positive envelope control was not detected");
        evidence.materialEnvelope = { toleranceMm: 0.00001, positiveControlOverlapMm: 0.001, boundsMethod: male.boundsMethod, reportedBoundsMm: male.boundsMm, containment };
      } else { vectorNear(male.boundsMm.min, [0,0,0], 0.00001, "male minimum"); vectorNear(male.boundsMm.max, maximum, 0.00001, "male maximum"); }
      if (paired) {
        const female = solids.find((body: any) => body.id === femaleId);
        vectorNear(female.boundsMm.min, [0, 0, 5], 0.00001, "female minimum"); vectorNear(female.boundsMm.max, [30, 20, 15], 0.00001, "female maximum");
        const interference = await call(client!, "plasticity_check_interference", { pairs: [{ firstBodyId: maleId, secondBodyId: femaleId }], revision: state.revision });
        evidence.interference = interference;
        requireCondition(interference.source === "native-brep-temporary-intersection" && interference.pairs.length === 1 && interference.pairs[0].status === "no-volumetric-interference", "Synthetic joint halves interfere");
      }
      const radii = male.faces.filter((face: any) => face.surfaceType === "Cylinder").map((face: any) => face.radiusMm).sort((a: number, b: number) => a - b);
      if (options.case === "vent-array") {
        vectorNear(radii, Array(6).fill(1.5), 0.00001, "vent radii");
        const centers = male.faces.filter((face: any) => face.surfaceType === "Cylinder").map((face: any) => face.axisOriginMm.slice(0, 2)).sort((a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]!);
        centers.forEach((point: number[], index: number) => vectorNear(point, [5 + Math.floor(index / 2) * 10, 5 + index % 2 * 10], 0.00001, "vent center"));
      }
      if (options.case === "heat-set-pocket") {
        vectorNear(radii, [1.5, 2.5, 3.5], 0.00001, "pocket radii");
        for (const height of [3, 6, 11]) requireCondition(male.faces.some((face: any) => face.planar && Math.abs(face.centerMm[2] - height) < 0.00001), "Pocket bottom/shoulder missing");
      }
      if (options.case.startsWith("pin-")) {
        vectorNear(radii, Array(pinCount).fill(2), 0.00001, "pin radii");
        const female = solids.find((body: any) => body.id === femaleId);
        vectorNear(female.faces.filter((face: any) => face.surfaceType === "Cylinder").map((face: any) => face.radiusMm), Array(pinCount).fill(2.2), 0.00001, "socket radii");
        for (const owner of [male, female]) {
          const centers = owner.faces.filter((face: any) => face.surfaceType === "Cylinder").map((face: any) => face.axisOriginMm.slice(0, 2)).sort((a: number[], b: number[]) => a[0]! - b[0]!);
          centers.forEach((point: number[], index: number) => vectorNear(point, [pinCount === 1 ? 15 : 8 + index * 14, 10], 0.00001, "pin/socket center"));
        }
        requireCondition(female.faces.some((face: any) => face.planar && Math.abs(face.centerMm[2] - 9.3) < 0.00001), "Socket axial-clearance bottom missing");
      }
      evidence.geometry = { validation: validation.bodies, massProperties: mass.bodies };
    };
    await check();
    const resultIds = state.bodies.map((body: any) => body.id).sort((a: number, b: number) => a - b);
    for (let index = 0; index < steps; index += 1) await mutate("plasticity_undo", {});
    const undone = await call(client, "plasticity_changes_since", { snapshotId: sourceSnapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(undone.diff) && state.undoDepth === source.undoDepth, "Undo did not restore exact recipe source");
    for (let index = 0; index < steps; index += 1) await mutate("plasticity_redo", {});
    requireCondition(JSON.stringify(state.bodies.map((body: any) => body.id).sort((a: number, b: number) => a - b)) === JSON.stringify(resultIds), "Redo changed recipe output IDs");
    await check();
    for (let index = 0; index < steps + source.undoDepth - initial.undoDepth; index += 1) await mutate("plasticity_undo", {});
    requireEmpty(state);
    const changes = await call(client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Initial empty snapshot not restored");
    if (options.case === "cable-channel-geometry") {
      const history = await call(client, "plasticity_construction_history", { limit: 100 });
      const expected = 2 * (source.undoDepth - initial.undoDepth) + 3 * steps + 1;
      requireCondition(history.total === expected && history.entries.length === expected && history.entries.every((entry: any) => entry.status === "completed"), "Durable channel history is incomplete");
      const journal = await call(client, "plasticity_construction_journal", {}); requireCondition(journal.durableSyncStatus === "in-sync", "Durable channel history is out of sync");
      evidence.durableHistory = { events: history.total, syncStatus: journal.durableSyncStatus };
    }
    evidence.undoRedo = true;
    evidence.cleanup = { restoredEmptyDocument: true, sceneContentsRestored: true };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output }));
  } catch (error) {
    evidence.error = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    if (!/timed out|timeout|uncertain/i.test(String(evidence.error)) && client && initial && state && state.documentToken === initial.documentToken) {
      try {
        const current = await call(client, "plasticity_status", {});
        if (current.documentToken === initial.documentToken && current.revision === state.revision && current.undoDepth > initial.undoDepth) {
          let status = current;
          for (let attempt = 0; attempt < 12 && status.undoDepth > initial.undoDepth; attempt += 1) {
            status = await call(client, "plasticity_undo", { intent: "Recover disposable joints-vents acceptance", revision: status.revision });
          }
          evidence.recovery = { restoredEmptyDocument: status.bodies.length === 0 && status.regions.length === 0 };
        }
      } catch { /* Preserve the primary failure; inspect the disposable scene manually if recovery reads fail. */ }
    }
    await writeExclusive(join(output, "failure.json"), sanitizeEvidence(evidence)).catch(() => {});
    throw error;
  } finally { await client?.close().catch(() => {}); }
}

async function startMcp(storeRoot: string): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts", "run-server.ts")], cwd: projectRoot, env: isolatedAcceptanceEnvironment(storeRoot, process.env), stderr: "pipe" });
  const client = new Client({ name: "plasticity-native-joints-vents-live", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const text = toolText(response);
  if ("isError" in response && response.isError) throw new Error(text);
  return await hydrateNativeState(JSON.parse(text), id => call(client, "plasticity_body_info", { id }), (offset, revision) => call(client, "plasticity_list_bodies", { bodyOffset: offset, bodyLimit: 100, expectedRevision: revision }));
}
function toolText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content");
  const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string");
  if (!item) throw new Error("MCP tool returned no text result");
  return item.text;
}
function requireEmpty(state: any): void {
  requireCondition(state.bodies.length === 0 && state.regions.length === 0 && (state.instances ?? []).length === 0 && (state.referenceMeshes ?? []).length === 0, "Refusing joints-vents acceptance in a nonempty Plasticity document");
  requireCondition((state.measurements ?? []).length === 0 && (state.sectionAnalyses ?? []).length === 0, "Refusing joints-vents acceptance while document annotations or section analyses exist");
  requireCondition((state.groups ?? []).every((group: { id: number }) => group.id === 0), "Refusing joints-vents acceptance while non-root groups exist");
}
function summary(state: any): Record<string, unknown> { return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length }; }
function near(actual: number, expected: number, tolerance: number, label: string): void { requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`); }
function vectorNear(actual: unknown, expected: number[], tolerance: number, label: string): void { requireCondition(Array.isArray(actual) && actual.length === expected.length, `${label}: vector length mismatch`); actual.forEach((value, index) => near(value, expected[index]!, tolerance, `${label}[${index}]`)); }
function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function writeExclusive(path: string, value: unknown): Promise<void> { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
