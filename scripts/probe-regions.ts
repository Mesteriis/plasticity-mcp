import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { discoverPlasticityTargets, type PlasticityTarget } from "../src/cdp/discovery.ts";
import { PlasticityOperations } from "../src/plasticity/operations.ts";
import { PlasticityRuntime, type RuntimeState } from "../src/plasticity/runtime.ts";

const REQUIRED_BINDINGS = ["CurveFactory", "CenterCircleFactory", "ExtrudeFactory", "Vector3", "Quaternion"] as const;
const LINEAR_TOLERANCE_MM = 0.01;

export interface RegionProbeArguments {
  endpoint: string;
  mutate: boolean;
  targetId: string | undefined;
}

export function parseRegionProbeArguments(arguments_: readonly string[]): RegionProbeArguments {
  let endpoint = process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223";
  let mutate = false;
  let targetId: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--mutate") mutate = true;
    else if (argument === "--target") targetId = requireArgumentValue(arguments_, ++index, "--target");
    else if (argument === "--endpoint") endpoint = requireArgumentValue(arguments_, ++index, "--endpoint");
    else throw new Error(`Unknown region probe argument: ${argument}`);
  }
  if (mutate && !targetId) throw new Error("Region probe --mutate requires --target <id>");
  return { endpoint, mutate, targetId };
}

export async function runRegionProbe(options: RegionProbeArguments): Promise<unknown> {
  const targets = await discoverPlasticityTargets(options.endpoint);
  const target = selectTarget(targets, options.targetId);
  const runtime = await PlasticityRuntime.connect(target);
  try {
    const capabilities = runtime.getCapabilities();
    const requiredBindings = Object.fromEntries(REQUIRED_BINDINGS.map((name) => [name, capabilities.includes(name)]));
    const missing = REQUIRED_BINDINGS.filter((name) => !requiredBindings[name]);
    if (missing.length > 0) throw new Error(`Missing Plasticity region bindings: ${missing.join(", ")}`);
    const state = await runtime.getState();
    const report = {
      target: { id: target.id, title: target.title },
      availableTargets: targets.map(({ id, title }) => ({ id, title })),
      requiredBindings,
      documentToken: state.documentToken,
      revision: state.revision,
      bodies: state.bodies.map(({ id, type, name }) => ({ id, type, name })),
      regions: state.regions,
    };
    if (!options.mutate) return { mode: "read-only", status: "available", ...report };
    const mutationProof = await proveNativeRegions(runtime, state);
    return { mode: "mutation-proof", status: "passed", ...report, mutationProof };
  } finally {
    runtime.close();
  }
}

async function proveNativeRegions(runtime: PlasticityRuntime, baseline: RuntimeState): Promise<unknown> {
  if (baseline.bodies.length > 0 || baseline.regions.length > 0) {
    throw new Error(`Region mutation proof requires an empty document; found ${baseline.bodies.length} bodies and ${baseline.regions.length} regions`);
  }
  const operations = new PlasticityOperations(runtime, "region-live-probe");
  const proof: Record<string, unknown> = {};
  try {
    let state = await operations.createPolyline(
      [[0, 0, 0], [20, 0, 0], [20, 10, 0], [0, 10, 0]],
      true,
      baseline.revision,
    );
    const rectangleWire = requireSingleBody(state, "Wire", "rectangle profile");
    if (state.regions.length !== 1 || !state.regions[0]?.sketchWireIds.includes(rectangleWire.id)) {
      throw new Error(`Rectangle did not produce one associated native region: ${JSON.stringify(state.regions)}`);
    }
    const rectangleRegion = state.regions[0];
    state = await operations.extrudeProfile(rectangleWire.id, 12, state.revision);
    const rectangleSolid = requireSingleBody(state, "Solid", "rectangle extrusion");
    assertBounds(rectangleSolid.boundsMm, [0, 0, 0], [20, 10, 12], "rectangle solid");
    if (rectangleSolid.faces.length !== 6 || rectangleSolid.edges.length !== 12) {
      throw new Error(`Rectangle solid topology mismatch: ${rectangleSolid.faces.length} faces, ${rectangleSolid.edges.length} edges`);
    }
    const extrudedRevision = state.revision;
    state = await operations.undo(state.revision);
    if (state.bodies.some((body) => body.type === "Solid")) throw new Error("Undo did not remove the rectangle Solid");
    state = await operations.redo(state.revision);
    const redoneRectangle = requireSingleBody(state, "Solid", "redone rectangle extrusion");
    assertBounds(redoneRectangle.boundsMm, [0, 0, 0], [20, 10, 12], "redone rectangle solid");
    proof.rectangle = {
      region: rectangleRegion,
      extrudedRevision,
      solid: compactBody(rectangleSolid),
      redone: compactBody(redoneRectangle),
    };
    await cleanupTo(runtime, baseline.undoDepth);

    state = await runtime.getState();
    state = await operations.createCircle([0, 0, 0], 10, state.revision);
    state = await operations.createCircle([0, 0, 0], 3, state.revision);
    if (state.regions.length !== 2) throw new Error(`Expected disc and annulus regions, found ${state.regions.length}`);
    const annulus = state.regions.toSorted((left, right) => displayArea(right) - displayArea(left))[0];
    if (!annulus) throw new Error("Annulus region is unavailable");
    state = await operations.extrudeRegions([annulus.id], 8, state.revision);
    const annularSolid = requireSingleBody(state, "Solid", "annular extrusion");
    assertBounds(annularSolid.boundsMm, [-10, -10, 0], [10, 10, 8], "annular solid");
    if (annularSolid.faces.length !== 4 || annularSolid.edges.length !== 4) {
      throw new Error(`Annular solid topology mismatch: ${annularSolid.faces.length} faces, ${annularSolid.edges.length} edges`);
    }
    state = await operations.undo(state.revision);
    if (state.bodies.some((body) => body.type === "Solid")) throw new Error("Undo did not remove the annular Solid");
    state = await operations.redo(state.revision);
    const redoneAnnulus = requireSingleBody(state, "Solid", "redone annular extrusion");
    assertBounds(redoneAnnulus.boundsMm, [-10, -10, 0], [10, 10, 8], "redone annular solid");
    proof.annulus = {
      regions: state.regions,
      selectedRegionId: annulus.id,
      solid: compactBody(annularSolid),
      redone: compactBody(redoneAnnulus),
    };
    await cleanupTo(runtime, baseline.undoDepth);

    state = await runtime.getState();
    state = await operations.createPolyline(
      [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]],
      true,
      state.revision,
    );
    state = await operations.createPolyline(
      [[20, 0, 0], [30, 0, 0], [30, 10, 0], [20, 10, 0]],
      true,
      state.revision,
    );
    if (state.regions.length !== 2) throw new Error(`Expected two disjoint regions, found ${state.regions.length}`);
    const disjointRegions = state.regions.toSorted((left, right) => left.displayBoundsMm.min[0] - right.displayBoundsMm.min[0]);
    state = await operations.extrudeRegions(disjointRegions.map(({ id }) => id), 5, state.revision);
    const disjointSolids = requireBodies(state, "Solid", 2, "multi-region extrusion")
      .toSorted((left, right) => left.boundsMm!.min[0] - right.boundsMm!.min[0]);
    assertBounds(disjointSolids[0]!.boundsMm, [0, 0, 0], [10, 10, 5], "left multi-region solid");
    assertBounds(disjointSolids[1]!.boundsMm, [20, 0, 0], [30, 10, 5], "right multi-region solid");
    state = await operations.undo(state.revision);
    if (state.bodies.some((body) => body.type === "Solid")) throw new Error("Undo did not remove both multi-region Solids");
    state = await operations.redo(state.revision);
    const redoneDisjoint = requireBodies(state, "Solid", 2, "redone multi-region extrusion")
      .toSorted((left, right) => left.boundsMm!.min[0] - right.boundsMm!.min[0]);
    assertBounds(redoneDisjoint[0]!.boundsMm, [0, 0, 0], [10, 10, 5], "redone left multi-region solid");
    assertBounds(redoneDisjoint[1]!.boundsMm, [20, 0, 0], [30, 10, 5], "redone right multi-region solid");
    proof.multipleRegions = {
      selectedRegionIds: disjointRegions.map(({ id }) => id),
      solids: disjointSolids.map(compactBody),
      redone: redoneDisjoint.map(compactBody),
    };
    await cleanupTo(runtime, baseline.undoDepth);

    state = await runtime.getState();
    state = await operations.createPolyline([[0, 0, 0], [20, 0, 0]], false, state.revision);
    const openWire = requireSingleBody(state, "Wire", "open profile");
    const beforeRejectedExtrusion = { revision: state.revision, undoDepth: state.undoDepth };
    let rejection = "";
    try {
      await operations.extrudeProfile(openWire.id, 8, state.revision);
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error);
    }
    if (!/closed Wire/i.test(rejection)) throw new Error(`Open profile rejection mismatch: ${rejection || "no error"}`);
    state = await runtime.getState();
    if (state.undoDepth !== beforeRejectedExtrusion.undoDepth || state.bodies.length !== 1) {
      throw new Error("Rejected open profile changed Plasticity history or geometry");
    }
    proof.openProfileRejection = { ...beforeRejectedExtrusion, error: rejection };
    return proof;
  } finally {
    if (!runtime.isUncertain()) await cleanupTo(runtime, baseline.undoDepth);
  }
}

function requireSingleBody(state: RuntimeState, type: string, label: string): RuntimeState["bodies"][number] {
  return requireBodies(state, type, 1, label)[0] as RuntimeState["bodies"][number];
}

function requireBodies(state: RuntimeState, type: string, count: number, label: string): RuntimeState["bodies"] {
  const matches = state.bodies.filter((body) => body.type === type);
  if (matches.length !== count) throw new Error(`${label} expected ${count} ${type} bodies, found ${matches.length}`);
  return matches;
}

function assertBounds(
  bounds: RuntimeState["bodies"][number]["boundsMm"],
  expectedMin: [number, number, number],
  expectedMax: [number, number, number],
  label: string,
): void {
  if (!bounds) throw new Error(`${label} has no native B-Rep bounds`);
  for (let axis = 0; axis < 3; axis += 1) {
    if (
      Math.abs(bounds.min[axis]! - expectedMin[axis]!) > LINEAR_TOLERANCE_MM ||
      Math.abs(bounds.max[axis]! - expectedMax[axis]!) > LINEAR_TOLERANCE_MM
    ) throw new Error(`${label} bounds mismatch: ${JSON.stringify(bounds)}`);
  }
}

function compactBody(body: RuntimeState["bodies"][number]): object {
  return { id: body.id, type: body.type, boundsMm: body.boundsMm, faceCount: body.faces.length, edgeCount: body.edges.length };
}

function displayArea(region: RuntimeState["regions"][number]): number {
  const { min, max } = region.displayBoundsMm;
  return (max[0] - min[0]) * (max[1] - min[1]);
}

async function cleanupTo(runtime: PlasticityRuntime, undoDepth: number): Promise<void> {
  let state = await runtime.getState();
  while (state.undoDepth > undoDepth) {
    await runtime.mutate(`async function () { await this.undo(); }`, []);
    state = await runtime.getState();
  }
  if (state.bodies.length > 0 || state.regions.length > 0) throw new Error("Region probe cleanup did not restore the empty document");
}

function selectTarget(targets: PlasticityTarget[], targetId: string | undefined): PlasticityTarget {
  if (targets.length === 0) throw new Error("No Plasticity document windows are exposed on the CDP endpoint");
  if (targetId) {
    const target = targets.find((candidate) => candidate.id === targetId);
    if (!target) throw new Error(`Plasticity target not found: ${targetId}`);
    return target;
  }
  return [...targets].sort((left, right) => left.id.localeCompare(right.id))[0] as PlasticityTarget;
}

function requireArgumentValue(arguments_: readonly string[], index: number, option: string): string {
  const value = arguments_[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

async function main(): Promise<void> {
  try {
    const report = await runRegionProbe(parseRegionProbeArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ status: "failed", error: message }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
