import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";
import type { FaceReference } from "./measurements.ts";

type Vector3 = [number, number, number];

export interface NativeFaceProperties {
  face: FaceReference;
  bodyVersionId: number;
  entityId: number;
  surfaceType: string;
  planar: boolean;
  areaM2: number;
  boundaryLengthM: number;
  areaCentroidM: Vector3;
  loopCount: number;
  innerLoopCount: number;
  nativeCheckCodes: number[];
}

export interface FacePropertiesEvidence {
  sessionId: string;
  documentToken: string;
  revision: string;
  source: "native-brep-face-mass-properties";
  faces: Array<{
    face: FaceReference;
    bodyVersionId: number;
    bodyName: string | null;
    entityId: number;
    surfaceType: string;
    planar: boolean;
    areaMm2: number;
    boundaryLengthMm: number;
    areaCentroidMm: Vector3;
    loopCount: number;
    innerLoopCount: number;
    nativeCheckCodes: number[];
  }>;
  totals: {
    areaMm2: number;
    summedBoundaryLengthMm: number;
    areaWeightedCentroidMm: Vector3;
  };
  limitation: string;
}

const MAX_FACES = 256;

export async function measureFaceProperties(
  runtime: PlasticityRuntime,
  faces: FaceReference[],
  revision: string,
  sessionId: string,
): Promise<FacePropertiesEvidence> {
  if (!sessionId) throw new Error("MCP session ID is required");
  if (faces.length === 0) throw new Error("At least one face is required");
  if (faces.length > MAX_FACES) throw new Error(`At most ${MAX_FACES} faces can be measured at once`);
  const keys = faces.map(({ bodyId, faceId }) => `${bodyId}:${faceId}`);
  if (new Set(keys).size !== keys.length) throw new Error("Face references must be unique");

  const before = await runtime.getState();
  if (before.revision !== revision) throw new Error(`Stale revision: expected ${before.revision}, received ${revision}`);
  const current = validateCurrentFaces(before, faces);
  const native = await collectNativeProperties(runtime, faces);
  const after = await runtime.getState();
  if (!samePersistentState(before, after)) throw new Error("Plasticity document changed during exact face-property measurement");
  if (native.length !== faces.length) throw new Error("Native face-property result count does not match the request");

  const measured = native.map((result, index) => {
    const reference = faces[index]!;
    const body = current.get(reference.bodyId)!;
    validateNativeResult(result, reference, body.versionId);
    return {
      face: reference,
      bodyVersionId: body.versionId,
      bodyName: body.name,
      entityId: result.entityId,
      surfaceType: result.surfaceType,
      planar: result.planar,
      areaMm2: result.areaM2 * 1_000_000,
      boundaryLengthMm: result.boundaryLengthM * 1000,
      areaCentroidMm: result.areaCentroidM.map((value) => value * 1000) as Vector3,
      loopCount: result.loopCount,
      innerLoopCount: result.innerLoopCount,
      nativeCheckCodes: result.nativeCheckCodes,
    };
  });
  const areaMm2 = measured.reduce((sum, face) => sum + face.areaMm2, 0);
  const summedBoundaryLengthMm = measured.reduce((sum, face) => sum + face.boundaryLengthMm, 0);
  const areaWeightedCentroidMm = [0, 1, 2].map((axis) =>
    measured.reduce((sum, face) => sum + face.areaMm2 * face.areaCentroidMm[axis]!, 0) / areaMm2,
  ) as Vector3;

  return {
    sessionId,
    documentToken: before.documentToken,
    revision: before.revision,
    source: "native-brep-face-mass-properties",
    faces: measured,
    totals: { areaMm2, summedBoundaryLengthMm, areaWeightedCentroidMm },
    limitation: "Summed boundary length counts every selected face boundary independently; shared edges are counted once for each selected face that uses them.",
  };
}

async function collectNativeProperties(runtime: PlasticityRuntime, faces: FaceReference[]): Promise<NativeFaceProperties[]> {
  return await runtime.read<NativeFaceProperties[]>(`function (args) {
    const find = reference => {
      const matches = [];
      for (const [versionId, item] of this.geo.geometryModel) {
        if (this.db.lookupStableId(versionId) === reference.bodyId) matches.push({ versionId, item });
      }
      if (matches.length !== 1 || !['Solid', 'Sheet'].includes(matches[0].item?.view?.constructor?.name)) {
        throw new Error('Requested current Solid or Sheet is unavailable: ' + reference.bodyId);
      }
      return matches[0];
    };
    return args.faces.map(reference => {
      const { versionId, item } = find(reference);
      const faceViews = item.view.high.faces;
      const viewIndex = faceViews.versionIds.indexOf(reference.faceId);
      if (viewIndex < 0) throw new Error('Requested current face is unavailable: ' + reference.bodyId + ':' + reference.faceId);
      const entityId = Number(faceViews.get(viewIndex).entityId);
      const collection = this.db.lookupFaceCollection([reference.faceId]);
      if (collection.Size() !== 1) throw new Error('Expected exactly one native face: ' + reference.bodyId + ':' + reference.faceId);
      const face = collection.Get(0);
      if (Number(face.Id()) !== entityId || Number(face.GetBody().Id()) !== Number(item.model.Id())) {
        throw new Error('Native face identity mismatch: ' + reference.bodyId + ':' + reference.faceId);
      }
      const properties = collection.EvaluateMassProperties();
      const amounts = Array.from(properties?.amounts ?? [], Number);
      const peripheries = Array.from(properties?.peripheries ?? [], Number);
      if (amounts.length !== 1 || peripheries.length !== 1) {
        throw new Error('Unexpected native face mass-property result shape: ' + reference.bodyId + ':' + reference.faceId);
      }
      const centroid = collection.GetCentroid();
      return {
        face: reference,
        bodyVersionId: Number(versionId),
        entityId,
        surfaceType: String(face.GetSurface()?.surface?.constructor?.name ?? 'Unknown'),
        planar: Boolean(face.IsPlanar()),
        areaM2: amounts[0],
        boundaryLengthM: peripheries[0],
        areaCentroidM: [Number(centroid.x), Number(centroid.y), Number(centroid.z)],
        loopCount: Number(face.GetLoops().length),
        innerLoopCount: Number(face.GetInnerLoops().length),
        nativeCheckCodes: Array.from(face.Check(), Number),
      };
    });
  }`, [{ faces }]);
}

function validateCurrentFaces(
  state: RuntimeState,
  faces: FaceReference[],
): Map<number, RuntimeState["bodies"][number]> {
  const bodies = new Map(state.bodies.map((body) => [body.id, body]));
  const requested = new Map<number, RuntimeState["bodies"][number]>();
  for (const reference of faces) {
    const body = bodies.get(reference.bodyId);
    if (!body) throw new Error(`Unknown current body ID: ${reference.bodyId}`);
    if (body.type !== "Solid" && body.type !== "Sheet") {
      throw new Error(`Exact face properties require a Solid or Sheet body: ${reference.bodyId}`);
    }
    if (!body.faceIds.includes(reference.faceId)) {
      throw new Error(`Unknown current face ID ${reference.faceId} on body ${reference.bodyId}`);
    }
    requested.set(body.id, body);
  }
  return requested;
}

function validateNativeResult(result: NativeFaceProperties, reference: FaceReference, bodyVersionId: number): void {
  if (result.face.bodyId !== reference.bodyId || result.face.faceId !== reference.faceId || result.bodyVersionId !== bodyVersionId) {
    throw new Error(`Native face-property identity mismatch for ${reference.bodyId}:${reference.faceId}`);
  }
  if (!Number.isInteger(result.entityId) || result.entityId <= 0) throw new Error(`Invalid native entity ID for ${reference.bodyId}:${reference.faceId}`);
  if (!Number.isFinite(result.areaM2) || result.areaM2 <= 0) throw new Error(`Invalid native area for ${reference.bodyId}:${reference.faceId}`);
  if (!Number.isFinite(result.boundaryLengthM) || result.boundaryLengthM <= 0) throw new Error(`Invalid native boundary length for ${reference.bodyId}:${reference.faceId}`);
  if (result.areaCentroidM.length !== 3 || !result.areaCentroidM.every(Number.isFinite)) throw new Error(`Invalid native area centroid for ${reference.bodyId}:${reference.faceId}`);
  if (!Number.isInteger(result.loopCount) || !Number.isInteger(result.innerLoopCount) || result.loopCount < 1 || result.innerLoopCount < 0 || result.innerLoopCount >= result.loopCount) {
    throw new Error(`Invalid native face-loop counts for ${reference.bodyId}:${reference.faceId}`);
  }
  if (!Array.isArray(result.nativeCheckCodes) || result.nativeCheckCodes.some((code) => !Number.isInteger(code))) {
    throw new Error(`Invalid native face-check result for ${reference.bodyId}:${reference.faceId}`);
  }
  if (result.nativeCheckCodes.length > 0) throw new Error(`Native face check failed for ${reference.bodyId}:${reference.faceId}`);
}

function samePersistentState(before: RuntimeState, after: RuntimeState): boolean {
  return before.documentToken === after.documentToken &&
    before.revision === after.revision &&
    before.undoDepth === after.undoDepth &&
    before.redoDepth === after.redoDepth &&
    JSON.stringify([...before.bodies].sort((left, right) => left.id - right.id)) ===
      JSON.stringify([...after.bodies].sort((left, right) => left.id - right.id));
}
