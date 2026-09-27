import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

type Vector3 = [number, number, number];

export interface NativeSolidProperties {
  id: number;
  versionId: number;
  volumeM3: number;
  surfaceAreaM2: number;
  centroidM: Vector3;
  nativeCheckCodes: number[];
}

export interface SolidPropertiesBodyEvidence {
  id: number;
  versionId: number;
  name: string | null;
  volumeMm3: number;
  surfaceAreaMm2: number;
  volumeCentroidMm: Vector3;
  nativeCheckCodes: number[];
}

export interface SolidPropertiesEvidence {
  sessionId: string;
  documentToken: string;
  revision: string;
  source: "native-brep-mass-properties";
  bodies: SolidPropertiesBodyEvidence[];
  totals: {
    volumeMm3: number;
    surfaceAreaMm2: number;
    volumeWeightedCentroidMm: Vector3;
  };
}

const MAX_SOLIDS = 256;

export async function measureSolidProperties(
  runtime: PlasticityRuntime,
  ids: number[],
  revision: string,
  sessionId: string,
): Promise<SolidPropertiesEvidence> {
  if (!sessionId) throw new Error("MCP session ID is required");
  if (ids.length === 0) throw new Error("At least one Solid body ID is required");
  if (ids.length > MAX_SOLIDS) throw new Error(`At most ${MAX_SOLIDS} Solid bodies can be measured at once`);
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw new Error("Solid body IDs must be positive integers");
  if (new Set(ids).size !== ids.length) throw new Error("Solid body IDs must be unique");

  const before = await runtime.getState();
  if (before.revision !== revision) throw new Error(`Stale revision: expected ${before.revision}, received ${revision}`);
  const requested = validateCurrentSolids(before, ids);
  const native = await collectNativeProperties(runtime, ids);
  const after = await runtime.getState();
  if (!samePersistentState(before, after)) throw new Error("Plasticity document changed during exact solid-property measurement");
  if (native.length !== ids.length) throw new Error("Native solid-property result count does not match the request");

  const bodies = native.map((result, index) => {
    const id = ids[index]!;
    const body = requested.get(id)!;
    validateNativeResult(result, body.id, body.versionId);
    return {
      id,
      versionId: body.versionId,
      name: body.name,
      volumeMm3: result.volumeM3 * 1_000_000_000,
      surfaceAreaMm2: result.surfaceAreaM2 * 1_000_000,
      volumeCentroidMm: result.centroidM.map((value) => value * 1000) as Vector3,
      nativeCheckCodes: result.nativeCheckCodes,
    } satisfies SolidPropertiesBodyEvidence;
  });

  const volumeMm3 = bodies.reduce((sum, body) => sum + body.volumeMm3, 0);
  const surfaceAreaMm2 = bodies.reduce((sum, body) => sum + body.surfaceAreaMm2, 0);
  const volumeWeightedCentroidMm = [0, 1, 2].map((axis) =>
    bodies.reduce((sum, body) => sum + body.volumeMm3 * body.volumeCentroidMm[axis]!, 0) / volumeMm3,
  ) as Vector3;

  return {
    sessionId,
    documentToken: before.documentToken,
    revision: before.revision,
    source: "native-brep-mass-properties",
    bodies,
    totals: { volumeMm3, surfaceAreaMm2, volumeWeightedCentroidMm },
  };
}

async function collectNativeProperties(runtime: PlasticityRuntime, ids: number[]): Promise<NativeSolidProperties[]> {
  return await runtime.read<NativeSolidProperties[]>(`function (args) {
    const find = id => {
      const matches = [];
      for (const [versionId, item] of this.geo.geometryModel) {
        if (this.db.lookupStableId(versionId) === id) matches.push({ versionId, item });
      }
      if (matches.length !== 1 || matches[0].item?.view?.constructor?.name !== 'Solid') {
        throw new Error('Requested current Solid is unavailable: ' + id);
      }
      return matches[0];
    };
    return args.ids.map(id => {
      const { versionId, item } = find(id);
      const collection = this.db.lookupBodyCollection([versionId]);
      if (collection.Size() !== 1) throw new Error('Expected exactly one native Solid collection member: ' + id);
      const properties = collection.EvaluateMassProperties();
      const amounts = Array.from(properties?.amounts ?? [], Number);
      const peripheries = Array.from(properties?.peripheries ?? [], Number);
      if (amounts.length !== 1 || peripheries.length !== 1) {
        throw new Error('Unexpected native mass-property result shape: ' + id);
      }
      const centroid = collection.GetCentroid();
      return {
        id,
        versionId: Number(versionId),
        volumeM3: amounts[0],
        surfaceAreaM2: peripheries[0],
        centroidM: [Number(centroid.x), Number(centroid.y), Number(centroid.z)],
        nativeCheckCodes: Array.from(item.model.Check(), Number),
      };
    });
  }`, [{ ids }]);
}

function validateCurrentSolids(state: RuntimeState, ids: number[]): Map<number, RuntimeState["bodies"][number]> {
  const bodies = new Map(state.bodies.map((body) => [body.id, body]));
  const requested = new Map<number, RuntimeState["bodies"][number]>();
  for (const id of ids) {
    const body = bodies.get(id);
    if (!body) throw new Error(`Unknown current body ID: ${id}`);
    if (body.type !== "Solid") throw new Error(`Exact volume requires a Solid body: ${id}`);
    requested.set(id, body);
  }
  return requested;
}

function validateNativeResult(result: NativeSolidProperties, id: number, versionId: number): void {
  if (result.id !== id || result.versionId !== versionId) throw new Error(`Native solid-property identity mismatch for body ${id}`);
  if (!Number.isFinite(result.volumeM3) || result.volumeM3 <= 0) throw new Error(`Invalid native volume for body ${id}`);
  if (!Number.isFinite(result.surfaceAreaM2) || result.surfaceAreaM2 <= 0) throw new Error(`Invalid native surface area for body ${id}`);
  if (result.centroidM.length !== 3 || !result.centroidM.every(Number.isFinite)) throw new Error(`Invalid native volume centroid for body ${id}`);
  if (!Array.isArray(result.nativeCheckCodes) || result.nativeCheckCodes.some((code) => !Number.isInteger(code))) {
    throw new Error(`Invalid native body-check result for body ${id}`);
  }
  if (result.nativeCheckCodes.length > 0) throw new Error(`Native body check failed for body ${id}`);
}

function samePersistentState(before: RuntimeState, after: RuntimeState): boolean {
  return before.documentToken === after.documentToken &&
    before.revision === after.revision &&
    before.undoDepth === after.undoDepth &&
    before.redoDepth === after.redoDepth &&
    JSON.stringify([...before.bodies].sort((left, right) => left.id - right.id)) ===
      JSON.stringify([...after.bodies].sort((left, right) => left.id - right.id));
}
