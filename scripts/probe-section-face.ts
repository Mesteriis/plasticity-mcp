import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { discoverPlasticityTargets, type PlasticityTarget } from "../src/cdp/discovery.ts";
import { PlasticityOperations } from "../src/plasticity/operations.ts";
import { PlasticityRuntime, type RuntimeState } from "../src/plasticity/runtime.ts";

export type SectionProbeArguments =
  | { help: true; mutate: false }
  | {
      help: false;
      targetId: string;
      mutate: true;
      allowDisposableMutations: true;
      endpoint?: string;
    };

export function parseSectionProbeArgs(arguments_: readonly string[]): SectionProbeArguments {
  if (arguments_.length === 0 || arguments_.includes("--help")) return { help: true, mutate: false };

  let endpoint: string | undefined;
  let targetId: string | undefined;
  let mutate = false;
  let allowDisposableMutations = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--target") targetId = requireArgumentValue(arguments_, ++index, argument);
    else if (argument === "--endpoint") endpoint = requireArgumentValue(arguments_, ++index, argument);
    else if (argument === "--mutate") mutate = true;
    else if (argument === "--allow-disposable-mutations") allowDisposableMutations = true;
    else throw new Error(`Unknown section probe argument: ${argument}`);
  }
  if (!targetId) throw new Error("Section probe mutation requires --target <id>");
  if (!mutate) throw new Error("Section probe requires --mutate");
  if (!allowDisposableMutations) throw new Error("Section probe requires --allow-disposable-mutations");
  return {
    help: false,
    targetId,
    mutate: true,
    allowDisposableMutations: true,
    ...(endpoint === undefined ? {} : { endpoint }),
  };
}

function requireArgumentValue(arguments_: readonly string[], index: number, option: string): string {
  const value = arguments_[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function printUsage(): void {
  process.stdout.write(
    "Usage: node scripts/probe-section-face.ts --target <id> --mutate --allow-disposable-mutations [--endpoint <loopback-url>]\n",
  );
}

interface NativeFaceProbe {
  bodyId: number;
  faceId: string;
  faceConstructor: string | null;
  planar: boolean;
  midpoint: { positionMm: [number, number, number]; normal: [number, number, number] };
  edges: Array<{
    id: string;
    nativeId: number;
    constructor: string | null;
    vertexIds: [number | null, number | null];
    isLine: boolean;
    isCircle: boolean;
    boundaryKind: "line" | "circular-arc" | "full-circle" | "unsupported";
    lengthMm: number;
    samples: {
      start: { positionMm: [number, number, number]; tangent: [number, number, number] };
      end: { positionMm: [number, number, number]; tangent: [number, number, number] };
    };
    curve: {
      constructor: string | null;
      curveConstructor: string | null;
      info: unknown;
    };
  }>;
}

export async function runSectionFaceProbe(options: Exclude<SectionProbeArguments, { help: true }>): Promise<unknown> {
  const endpoint = options.endpoint ?? process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223";
  const targets = await discoverPlasticityTargets(endpoint);
  const target = requireTarget(targets, options.targetId);
  const runtime = await PlasticityRuntime.connect(target);
  try {
    const baseline = await runtime.getState();
    if (baseline.bodies.length > 0 || baseline.regions.length > 0) {
      throw new Error(
        `Section face probe requires an empty document; found ${baseline.bodies.length} bodies and ${baseline.regions.length} regions`,
      );
    }
    const operations = new PlasticityOperations(runtime, "section-face-live-probe");
    try {
      let state = await operations.createBox([0, 0, 0], [20, 10, 5], "Section probe plain box", baseline.revision);
      const plainBox = requireAddedSolid(baseline, state, "plain box");
      const plainTop = requireTopFace(plainBox, 5);
      const plainFace = await inspectNativeFace(runtime, plainBox.id, plainTop.id);
      assertLineBoundary(plainFace);

      const beforeSecondBox = state;
      state = await operations.createBox([30, 0, 0], [20, 10, 5], "Section probe holed box", state.revision);
      const secondBox = requireAddedSolid(beforeSecondBox, state, "second box");
      const beforeCylinder = state;
      state = await operations.createCylinder([40, 5, -1], 2, 7, "Section probe cutter", state.revision);
      const cutter = requireAddedSolid(beforeCylinder, state, "hole cutter");
      state = await operations.boolean([secondBox.id], [cutter.id], "difference", false, state.revision);
      const holedBox = requireBodyAtBounds(state, [30, 0, 0], [50, 10, 5], "holed box");
      const holedTop = requireTopFace(holedBox, 5);
      const holedFace = await inspectNativeFace(runtime, holedBox.id, holedTop.id);
      assertCircleBoundary(holedFace);

      return {
        status: "passed",
        mode: "mutation-proof",
        target: { id: target.id, title: target.title },
        baseline: { documentToken: baseline.documentToken, revision: baseline.revision, undoDepth: baseline.undoDepth },
        units: { positions: "millimetres", tangents: "unitless" },
        plainBox: plainFace,
        holedBox: holedFace,
      };
    } finally {
      if (!runtime.isUncertain()) await cleanupToBaseline(runtime, baseline);
    }
  } finally {
    runtime.close();
  }
}

async function inspectNativeFace(runtime: PlasticityRuntime, bodyId: number, faceId: string): Promise<NativeFaceProbe> {
  return await runtime.readNative<NativeFaceProbe>(`function (args) {
    const mm = value => value * 1000;
    const position = value => [mm(value.x), mm(value.y), mm(value.z)];
    const direction = value => [value.x, value.y, value.z];
    const constructorName = value => value?.constructor?.name ?? null;
    const scalarSnapshot = (value, depth = 0, seen = new Set()) => {
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
      if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
      if (typeof value !== 'object' || depth >= 4 || seen.has(value)) return undefined;
      seen.add(value);
      if (Array.isArray(value)) {
        const result = value.slice(0, 24).map(item => scalarSnapshot(item, depth + 1, seen));
        seen.delete(value);
        return result;
      }
      const result = { $constructor: constructorName(value) };
      for (const key of Object.getOwnPropertyNames(value).sort().slice(0, 48)) {
        let nested;
        try { nested = scalarSnapshot(value[key], depth + 1, seen); } catch { continue; }
        if (nested !== undefined) result[key] = nested;
      }
      for (const key of ['x', 'y', 'z', 'Location', 'Axis', 'XZ', 'YZ', 'Ref']) {
        if (key in result) continue;
        let nested;
        try { nested = scalarSnapshot(value[key], depth + 1, seen); } catch { continue; }
        if (nested !== undefined) result[key] = nested;
      }
      seen.delete(value);
      return result;
    };
    let item;
    for (const [versionId, candidate] of this.geo.geometryModel) {
      if (this.db.lookupStableId(versionId) === args.bodyId) { item = candidate; break; }
    }
    if (!item?.model || !item?.view?.high?.faces || !item?.view?.high?.edges) {
      throw new Error('Native body topology is unavailable: ' + args.bodyId);
    }
    const faceViews = item.view.high.faces;
    const faceIndex = faceViews.versionIds.indexOf(args.faceId);
    if (faceIndex < 0) throw new Error('Stale or unknown face: ' + args.faceId);
    const faceView = faceViews.get(faceIndex);
    const modelFaces = item.model.GetFaces();
    let face;
    for (let index = 0; index < modelFaces.Size(); index += 1) {
      const candidate = modelFaces.Get(index);
      if (candidate.Id() === faceView.entityId) { face = candidate; break; }
    }
    if (!face) throw new Error('Native face entity is unavailable: ' + args.faceId);
    const edgeViews = item.view.high.edges;
    const edgeIdByEntity = new Map();
    for (let index = 0; index < edgeViews.versionIds.length; index += 1) {
      const view = edgeViews.get(index);
      if (view) edgeIdByEntity.set(view.entityId, String(edgeViews.versionIds[index]));
    }
    const sample = (edge, parameter) => {
      const value = edge.GetPointAndTangent(parameter);
      return { positionMm: position(value.position), tangent: direction(value.tangent) };
    };
    const edges = [];
    const faceEdges = face.GetEdges();
    for (let index = 0; index < faceEdges.Size(); index += 1) {
      const edge = faceEdges.Get(index);
      const vertices = edge.GetVertices();
      const curve = edge.GetCurve();
      let info = null;
      if (typeof curve?.curve?.GetInfo === 'function') {
        try { info = scalarSnapshot(curve.curve.GetInfo()); } catch (error) { info = { error: String(error) }; }
      }
      const start = sample(edge, 0);
      const end = sample(edge, 1);
      const endpointsCoincide = Math.hypot(...start.positionMm.map((value, axis) => value - end.positionMm[axis])) <= 1e-9;
      const isLine = Boolean(edge.IsLine());
      const isCircle = Boolean(edge.IsCircle());
      edges.push({
        id: edgeIdByEntity.get(edge.Id()) ?? 'unmapped-edge:' + edge.Id(),
        nativeId: Number(edge.Id()),
        constructor: constructorName(edge),
        vertexIds: [
          Number.isInteger(Number(vertices.left?.Id?.())) ? Number(vertices.left.Id()) : null,
          Number.isInteger(Number(vertices.right?.Id?.())) ? Number(vertices.right.Id()) : null,
        ],
        isLine,
        isCircle,
        boundaryKind: isLine ? 'line' : isCircle ? (endpointsCoincide ? 'full-circle' : 'circular-arc') : 'unsupported',
        lengthMm: mm(edge.FindLength().length),
        samples: { start, end },
        curve: {
          constructor: constructorName(curve),
          curveConstructor: constructorName(curve?.curve),
          info,
        },
      });
    }
    const midpoint = face.FindMidpoint();
    return {
      bodyId: args.bodyId,
      faceId: args.faceId,
      faceConstructor: constructorName(face),
      planar: Boolean(face.IsPlanar()),
      midpoint: { positionMm: position(midpoint.position), normal: direction(midpoint.normal) },
      edges,
    };
  }`, [], [{ bodyId, faceId }]);
}

function requireTarget(targets: PlasticityTarget[], targetId: string): PlasticityTarget {
  const target = targets.find((candidate) => candidate.id === targetId);
  if (!target) throw new Error(`Plasticity target not found: ${targetId}`);
  return target;
}

function requireAddedSolid(before: RuntimeState, after: RuntimeState, label: string): RuntimeState["bodies"][number] {
  const priorIds = new Set(before.bodies.map(({ id }) => id));
  const added = after.bodies.filter((body) => body.type === "Solid" && !priorIds.has(body.id));
  if (added.length !== 1) throw new Error(`${label} expected one added Solid, found ${added.length}`);
  return added[0] as RuntimeState["bodies"][number];
}

function requireBodyAtBounds(
  state: RuntimeState,
  min: [number, number, number],
  max: [number, number, number],
  label: string,
): RuntimeState["bodies"][number] {
  const matches = state.bodies.filter((body) => body.type === "Solid" && boundsMatch(body.boundsMm, min, max));
  if (matches.length !== 1) throw new Error(`${label} expected one Solid at the requested bounds, found ${matches.length}`);
  return matches[0] as RuntimeState["bodies"][number];
}

function boundsMatch(
  bounds: RuntimeState["bodies"][number]["boundsMm"],
  min: [number, number, number],
  max: [number, number, number],
): boolean {
  if (!bounds) return false;
  return [...bounds.min, ...bounds.max].every((value, index) =>
    Math.abs(value - [...min, ...max][index]!) <= 0.01
  );
}

function requireTopFace(body: RuntimeState["bodies"][number], zMm: number): RuntimeState["bodies"][number]["faces"][number] {
  const matches = body.faces.filter((face) =>
    face.planar &&
    Math.abs(face.normal[2] - 1) <= 1e-9 &&
    Math.abs(face.boundsMm.min[2] - zMm) <= 0.01 &&
    Math.abs(face.boundsMm.max[2] - zMm) <= 0.01
  );
  if (matches.length !== 1) throw new Error(`Expected one upward top face on body ${body.id}, found ${matches.length}`);
  return matches[0] as RuntimeState["bodies"][number]["faces"][number];
}

function assertLineBoundary(face: NativeFaceProbe): void {
  const lines = face.edges.filter((edge) => edge.isLine);
  if (lines.length !== 4) throw new Error(`Plain top face expected four native line edges, found ${lines.length}`);
  for (const edge of lines) {
    const delta = edge.samples.start.positionMm.map((value, index) => value - edge.samples.end.positionMm[index]!);
    if (Math.hypot(...delta) <= 0.01) throw new Error(`Line edge ${edge.id} did not expose distinct endpoints`);
  }
}

function assertCircleBoundary(face: NativeFaceProbe): void {
  const circles = face.edges.filter((edge) => edge.isCircle);
  if (circles.length !== 1) throw new Error(`Holed top face expected one native circular boundary, found ${circles.length}`);
  const info = circles[0]?.curve.info;
  const serializedInfo = JSON.stringify(info ?? null);
  if (!serializedInfo || serializedInfo === "null" || serializedInfo === "{}")
    throw new Error("Native circle boundary did not expose GetCurve().curve.GetInfo() scalar data");
  if (!/"radius":0\.002(?:[,}])/.test(serializedInfo) || !/"Location"/.test(serializedInfo) || !/"Axis"/.test(serializedInfo))
    throw new Error("Native circle boundary did not expose radius, centre and basis axis");
  const tangent = circles[0]!.samples.start.tangent;
  if (Math.hypot(...tangent) < 0.999999 || Math.hypot(...face.midpoint.normal) < 0.999999)
    throw new Error("Native circle boundary did not expose tangent and face-normal orientation");
}

async function cleanupToBaseline(runtime: PlasticityRuntime, baseline: RuntimeState): Promise<void> {
  let state = await runtime.getState();
  if (state.documentToken !== baseline.documentToken) throw new Error("Section face probe document changed during cleanup");
  while (state.undoDepth > baseline.undoDepth) {
    state = await runtime.mutate<RuntimeState>(`async function () { await this.undo(); return null; }`, [])
      .then(async () => await runtime.getState());
  }
  if (state.undoDepth !== baseline.undoDepth || state.bodies.length !== 0 || state.regions.length !== 0) {
    throw new Error("Section face probe cleanup did not restore the empty baseline document");
  }
}

async function main(): Promise<void> {
  try {
    const options = parseSectionProbeArgs(process.argv.slice(2));
    if (options.help) {
      printUsage();
      return;
    }
    const report = await runSectionFaceProbe(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
