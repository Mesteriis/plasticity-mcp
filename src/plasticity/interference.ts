import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

type Vector3 = [number, number, number];

export interface BodyInterferencePair {
  firstBodyId: number;
  secondBodyId: number;
}

export interface NativeIntersectionBody {
  type: string;
  faceCount: number;
  boundsMm: { min: Vector3; max: Vector3 };
  nativeCheckCodes: number[];
}

export interface NativeInterferencePairResult extends BodyInterferencePair {
  outcome: "intersection" | "no-effect" | "error";
  intersectionBodies?: NativeIntersectionBody[];
  error?: string;
}

export interface BodyInterferencePairEvidence extends BodyInterferencePair {
  status: "interfere" | "no-volumetric-interference" | "unsupported";
  intersectionBodies?: NativeIntersectionBody[];
  reasons: string[];
}

export interface BodyInterferenceEvidence {
  sessionId: string;
  documentToken: string;
  revision: string;
  source: "native-brep-temporary-intersection";
  pairs: BodyInterferencePairEvidence[];
}

interface TemporaryIds {
  firstVersionId: number;
  firstStableId: number;
  secondVersionId: number;
  secondStableId: number;
}

const MAX_PAIRS = 256;
let nextTemporaryVersionId = 2_146_000_001;

export async function checkBodyInterference(
  runtime: PlasticityRuntime,
  pairs: BodyInterferencePair[],
  revision: string,
  sessionId: string,
): Promise<BodyInterferenceEvidence> {
  if (!sessionId) throw new Error("MCP session ID is required");
  if (pairs.length === 0) throw new Error("At least one body pair is required");
  if (pairs.length > MAX_PAIRS) throw new Error(`At most ${MAX_PAIRS} body pairs can be checked at once`);
  const before = await runtime.getState();
  if (before.revision !== revision) throw new Error(`Stale revision: expected ${before.revision}, received ${revision}`);
  validatePairs(before, pairs);

  const temporaryIds = pairs.map(() => allocateTemporaryIds());
  const native = await collectNativeIntersections(runtime, pairs, temporaryIds);
  const after = await runtime.getState();
  if (!samePersistentState(before, after)) {
    return evidence(sessionId, before, pairs.map((pair) => ({
      ...pair,
      status: "unsupported",
      reasons: ["document-changed-during-interference-check"],
    })));
  }
  if (native.length !== pairs.length) {
    return evidence(sessionId, before, pairs.map((pair) => ({
      ...pair,
      status: "unsupported",
      reasons: ["native-result-count-mismatch"],
    })));
  }

  return evidence(sessionId, before, pairs.map((pair, index) => interpret(pair, native[index]!)));
}

async function collectNativeIntersections(
  runtime: PlasticityRuntime,
  pairs: BodyInterferencePair[],
  temporaryIds: TemporaryIds[],
): Promise<NativeInterferencePairResult[]> {
  return await runtime.readNative<NativeInterferencePairResult[]>(`async function (BooleanFactory, kernel_Solid, args) {
    const mm = value => value * 1000;
    const point = value => [mm(value.x), mm(value.y), mm(value.z)];
    const findModel = id => {
      const matches = [];
      for (const [versionId, item] of this.geo.geometryModel) {
        if (this.db.lookupStableId(versionId) === id) matches.push(item);
      }
      if (matches.length !== 1 || matches[0].view?.constructor?.name !== 'Solid') {
        throw new Error('Requested current Solid is unavailable');
      }
      return matches[0].model;
    };
    const inspectPair = async (pair, ids) => {
      const temporary = this.geo.makeTemporary();
      Object.defineProperty(temporary, 'primaryPartition', { value: this.geo.primaryPartition });
      const temporaryDatabase = Object.create(this.db);
      Object.defineProperty(temporaryDatabase, 'geo', { value: temporary });
      const temporaryEditor = Object.create(this);
      Object.defineProperties(temporaryEditor, {
        geo: { value: temporary },
        db: { value: temporaryDatabase },
      });
      let firstCopy;
      let secondCopy;
      let firstView;
      let secondView;
      let factory;
      let output;
      let cleanupFailed = false;
      try {
        firstCopy = findModel(pair.firstBodyId).Clone();
        secondCopy = findModel(pair.secondBodyId).Clone();
        const usedVersions = new Set(temporary.geometryModel.keys());
        while (usedVersions.has(ids.firstVersionId) || temporary.hasStableId(ids.firstStableId) ||
          usedVersions.has(ids.secondVersionId) || temporary.hasStableId(ids.secondStableId)) {
          ids.firstVersionId -= 4;
          ids.firstStableId -= 4;
          ids.secondVersionId -= 4;
          ids.secondStableId -= 4;
        }
        const firstCvs = firstCopy.GetCVs();
        const secondCvs = secondCopy.GetCVs();
        const views = await this.views.build([
          { model: firstCopy, cvs: firstCvs, versionId: ids.firstVersionId, stableId: ids.firstStableId },
          { model: secondCopy, cvs: secondCvs, versionId: ids.secondVersionId, stableId: ids.secondStableId },
        ], 'real');
        firstView = views[0];
        secondView = views[1];
        await temporary.addItem(firstCopy, firstCvs, firstView, ids.firstStableId, 'user');
        await temporary.addItem(secondCopy, secondCvs, secondView, ids.secondStableId, 'user');
        factory = new BooleanFactory(temporaryEditor);
        factory.targets = [firstView];
        factory.tools = [secondView];
        factory.operationType = 15901;
        factory.keepTools = false;
        try {
          const calculated = await factory.calculate(factory.partition);
          const results = Array.isArray(calculated) ? calculated : [calculated].filter(Boolean);
          const intersectionBodies = results.map(body => {
            const box = body?.FindBox?.();
            return {
              type: String(body?.constructor?.name ?? 'Unknown'),
              faceCount: Number(body?.GetFaces?.().Size?.() ?? -1),
              boundsMm: box ? { min: point(box.min), max: point(box.max) } : null,
              nativeCheckCodes: Array.from(body?.Check?.() ?? [-1], Number),
            };
          });
          output = { ...pair, outcome: 'intersection', intersectionBodies };
        } catch (error) {
          const message = String(error?.message ?? error);
          output = /Operation has no effect/i.test(message)
            ? { ...pair, outcome: 'no-effect', error: 'Operation has no effect' }
            : { ...pair, outcome: 'error', error: message.slice(0, 240) };
        }
      } catch (error) {
        output = { ...pair, outcome: 'error', error: String(error?.message ?? error).slice(0, 240) };
      } finally {
        try { if (factory) await factory.cancel(); } catch { cleanupFailed = true; }
        try {
          if (secondView && temporary.geometryModel.has(ids.secondVersionId)) await temporary.removeItem(secondView, 'user');
        } catch { cleanupFailed = true; }
        try {
          if (firstView && temporary.geometryModel.has(ids.firstVersionId)) await temporary.removeItem(firstView, 'user');
        } catch { cleanupFailed = true; }
        try {
          if (typeof kernel_Solid.Exists !== 'function') throw new Error('Solid existence check is unavailable');
          const idsToRemove = [firstCopy, secondCopy].filter(Boolean).map(body => body.Id()).filter(id => kernel_Solid.Exists(id));
          if (idsToRemove.length > 0) kernel_Solid.Remove(idsToRemove);
        } catch { cleanupFailed = true; }
      }
      return cleanupFailed ? { ...pair, outcome: 'error', error: 'Temporary native cleanup failed' } : output;
    };
    const results = [];
    for (let index = 0; index < args.pairs.length; index += 1) {
      results.push(await inspectPair(args.pairs[index], args.temporaryIds[index]));
    }
    return results;
  }`, ["BooleanFactory", "kernel_Solid"], [{ pairs, temporaryIds }]);
}

function validatePairs(state: RuntimeState, pairs: BodyInterferencePair[]): void {
  const bodies = new Map(state.bodies.map((body) => [body.id, body]));
  const seen = new Set<string>();
  for (const pair of pairs) {
    if (!Number.isInteger(pair.firstBodyId) || pair.firstBodyId <= 0 || !Number.isInteger(pair.secondBodyId) || pair.secondBodyId <= 0) {
      throw new Error("Interference body IDs must be positive integers");
    }
    if (pair.firstBodyId === pair.secondBodyId) throw new Error("An interference pair must contain two different bodies");
    const key = [pair.firstBodyId, pair.secondBodyId].sort((left, right) => left - right).join(":");
    if (seen.has(key)) throw new Error(`Duplicate unordered interference pair: ${key}`);
    seen.add(key);
    const first = bodies.get(pair.firstBodyId);
    const second = bodies.get(pair.secondBodyId);
    if (!first || !second) throw new Error(`Unknown current body in interference pair: ${key}`);
    if (first.type !== "Solid" || second.type !== "Solid") throw new Error(`Interference checks require two Solid bodies: ${key}`);
  }
}

function interpret(pair: BodyInterferencePair, native: NativeInterferencePairResult): BodyInterferencePairEvidence {
  if (native.firstBodyId !== pair.firstBodyId || native.secondBodyId !== pair.secondBodyId) {
    return { ...pair, status: "unsupported", reasons: ["native-pair-mismatch"] };
  }
  if (native.outcome === "no-effect") {
    return { ...pair, status: "no-volumetric-interference", reasons: ["native-intersection-has-no-volume"] };
  }
  if (native.outcome !== "intersection") {
    return { ...pair, status: "unsupported", reasons: ["native-intersection-failed"] };
  }
  const bodies = native.intersectionBodies ?? [];
  if (bodies.length === 0) return { ...pair, status: "unsupported", reasons: ["empty-native-intersection-result"] };
  if (bodies.some((body) => body.type !== "SolidBody" || body.faceCount <= 0 || !validBounds(body.boundsMm))) {
    return { ...pair, status: "unsupported", reasons: ["invalid-native-intersection-result"] };
  }
  if (bodies.some((body) => body.nativeCheckCodes.length > 0)) {
    return { ...pair, status: "unsupported", reasons: ["native-check-failed"] };
  }
  return { ...pair, status: "interfere", intersectionBodies: bodies, reasons: [] };
}

function validBounds(bounds: NativeIntersectionBody["boundsMm"]): boolean {
  return Boolean(bounds) && [...bounds.min, ...bounds.max].every(Number.isFinite) &&
    bounds.min.every((value, index) => value <= bounds.max[index]!);
}

function evidence(
  sessionId: string,
  state: RuntimeState,
  pairs: BodyInterferencePairEvidence[],
): BodyInterferenceEvidence {
  return {
    sessionId,
    documentToken: state.documentToken,
    revision: state.revision,
    source: "native-brep-temporary-intersection",
    pairs,
  };
}

function allocateTemporaryIds(): TemporaryIds {
  if (nextTemporaryVersionId < 1_500_000_001) nextTemporaryVersionId = 2_146_000_001;
  const firstVersionId = nextTemporaryVersionId;
  nextTemporaryVersionId -= 4;
  return {
    firstVersionId,
    firstStableId: firstVersionId - 1,
    secondVersionId: firstVersionId - 2,
    secondStableId: firstVersionId - 3,
  };
}

function samePersistentState(before: RuntimeState, after: RuntimeState): boolean {
  return before.documentToken === after.documentToken &&
    before.revision === after.revision &&
    before.undoDepth === after.undoDepth &&
    before.redoDepth === after.redoDepth &&
    bodyIdentity(before) === bodyIdentity(after);
}

function bodyIdentity(state: RuntimeState): string {
  return JSON.stringify([...state.bodies]
    .sort((left, right) => left.id - right.id)
    .map((body) => ({
      id: body.id,
      versionId: body.versionId,
      type: body.type,
      name: body.name,
      materialId: body.materialId ?? null,
      visible: body.visible ?? null,
      hidden: body.hidden ?? null,
      locked: body.locked ?? null,
      faceIds: [...body.faceIds].sort(),
      edgeIds: [...body.edgeIds].sort(),
    })));
}
