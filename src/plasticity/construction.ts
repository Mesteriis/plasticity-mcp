export type Vector3 = [number, number, number];

export interface PlaneFrame {
  originMm: Vector3;
  normal: Vector3;
  xDirection: Vector3;
  yDirection: Vector3;
}

export interface ConstructionPlaneDescriptor extends PlaneFrame {
  id: string;
  nativeId: string;
  name: string;
  source: "standard" | "saved";
}

export interface AxisLine {
  originMm: Vector3;
  direction: Vector3;
}

export const GEOMETRY_EPSILON = 1e-9;

const STANDARD_NATIVE_IDS = new Set(["top", "bottom", "left", "right", "front", "back"]);
const REQUIRED_PLANE_BINDINGS = ["SaveConstructionPlaneCommand", "RemovePlaneCommand", "ConstructionPlaneSnap", "Vector3"];

export function normalizePlaneSnapshotIds(
  ids: ReadonlyMap<number, unknown> | Record<string, unknown>,
): Array<[nativeId: string, planeIndex: number]> {
  const entries = ids instanceof Map ? [...ids.entries()] : Object.entries(ids);
  return entries.map(([planeIndex, nativeId]) => [String(nativeId), Number(planeIndex)]);
}

export class ConstructionGeometry {
  private readonly runtime: PlasticityRuntime;

  constructor(runtime: PlasticityRuntime) {
    this.runtime = runtime;
  }

  capabilities(): {
    constructionPlanes: { available: boolean; reason: string | null };
    activeWorkplane: { available: boolean; reason: string | null };
  } {
    const available = new Set(this.runtime.getCapabilities());
    const missingPlanes = REQUIRED_PLANE_BINDINGS.filter((binding) => !available.has(binding));
    const activeAvailable = available.has("ConstructionPlaneDatabase");
    return {
      constructionPlanes: {
        available: missingPlanes.length === 0,
        reason: missingPlanes.length === 0 ? null : `Missing native bindings: ${missingPlanes.join(", ")}`,
      },
      activeWorkplane: {
        available: activeAvailable,
        reason: activeAvailable ? null : "Plasticity active workplane control is unavailable in 26.1.3",
      },
    };
  }

  async createPlane(
    frame: PlaneFrame,
    name: string | undefined,
    revision: string,
  ): Promise<{ plane: ConstructionPlaneDescriptor; state: RuntimeState }> {
    const capability = this.capabilities().constructionPlanes;
    if (!capability.available) throw new Error(capability.reason as string);
    await this.requireForeground();
    const before = await this.requireRevision(revision);
    const normalized = frameFromOriginNormalX(frame.originMm, frame.normal, frame.xDirection);
    const beforeIds = savedNativeIds(before);
    await this.runtime.mutate(`async function (SaveCommand, ConstructionPlane, Vector, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const plane = new ConstructionPlane(
        new Vector(...args.normal),
        new Vector(...args.point),
        new Vector(...args.xDirection),
      );
      const editor = this;
      let failure;
      const command = new SaveCommand(this, plane);
      command.remember = false;
      command.execute = async function () {
        editor.planes.begin();
        try {
          const saved = editor.planes.add(plane);
          if (args.name) {
            plane.name = args.name;
            if (saved && typeof saved === 'object') saved.name = args.name;
          }
          editor.planes.commit();
          return saved;
        } catch (error) {
          failure = error;
          try { editor.planes.rollback(); } catch {}
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["SaveConstructionPlaneCommand", "ConstructionPlaneSnap", "Vector3"], [{
      name: name ?? null,
      point: normalized.originMm.map(millimetersToMeters),
      normal: normalized.normal,
      xDirection: normalized.xDirection,
    }]);
    try {
      const state = await this.runtime.getState();
      if (state.documentToken !== before.documentToken) {
        throw new Error(`Plasticity document changed during construction plane creation: ${before.documentToken} -> ${state.documentToken}`);
      }
      const afterIds = savedNativeIds(state);
      const added = [...afterIds].filter((id) => !beforeIds.has(id));
      if (added.length !== 1) {
        throw new Error(`Native plane read-back was not unique: before=${JSON.stringify([...beforeIds])}, after=${JSON.stringify([...afterIds])}`);
      }
      const plane = state.construction.planes.find(
        (candidate) => candidate.source === "saved" && candidate.nativeId === added[0],
      );
      if (!plane) {
        throw new Error(`Native plane read-back failed: before=${JSON.stringify([...beforeIds])}, after=${JSON.stringify([...afterIds])}`);
      }
      assertFrameClose(plane, normalized);
      return { plane, state };
    } catch (error) {
      this.runtime.markUncertain();
      throw uncertainVerificationError("construction plane creation", error);
    }
  }

  async removePlane(nativeId: string, revision: string): Promise<RuntimeState> {
    if (STANDARD_NATIVE_IDS.has(nativeId.toLowerCase())) throw new Error("Standard construction planes cannot be removed");
    const capability = this.capabilities().constructionPlanes;
    if (!capability.available) throw new Error(capability.reason as string);
    await this.requireForeground();
    const before = await this.requireRevision(revision);
    const matches = before.construction.planes.filter(
      (plane) => plane.source === "saved" && plane.nativeId === nativeId,
    );
    if (matches.length !== 1) throw new Error(`Unknown or ambiguous saved construction plane ID: ${nativeId}`);
    await this.runtime.mutate(`async function (RemoveCommand, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const snapshot = this.planes.snapshot();
      const idEntries = snapshot.ids instanceof Map ? Array.from(snapshot.ids) : Object.entries(snapshot.ids ?? {});
      const idEntry = idEntries.find(([, nativeId]) => String(nativeId) === args.nativeId);
      const index = idEntry ? Number(idEntry[0]) : undefined;
      const plane = snapshot.planes?.[index];
      if (!plane) throw new Error('Unknown saved construction plane ID: ' + args.nativeId);
      const editor = this;
      let failure;
      const command = new RemoveCommand(this);
      command.remember = false;
      command.execute = async function () {
        editor.planes.begin();
        try {
          const removed = editor.planes.remove(plane);
          editor.planes.commit();
          return removed;
        } catch (error) {
          failure = error;
          try { editor.planes.rollback(); } catch {}
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["RemovePlaneCommand"], [{ nativeId }]);
    try {
      const state = await this.runtime.getState();
      if (state.documentToken !== before.documentToken) {
        throw new Error(`Plasticity document changed during construction plane removal: ${before.documentToken} -> ${state.documentToken}`);
      }
      if (state.construction.planes.some((plane) => plane.source === "saved" && plane.nativeId === nativeId)) {
        throw new Error(`Plasticity did not remove saved construction plane: ${nativeId}`);
      }
      return state;
    } catch (error) {
      this.runtime.markUncertain();
      throw uncertainVerificationError("construction plane removal", error);
    }
  }

  async setWorkplane(plane: ConstructionPlaneDescriptor): Promise<RuntimeState> {
    const capability = this.capabilities().activeWorkplane;
    if (!capability.available) throw new Error(capability.reason as string);
    await this.requireForeground();
    const current = await this.runtime.getState();
    const observed = current.construction.planes.find((candidate) =>
      candidate.source === plane.source &&
      (plane.source === "standard" ? candidate.id === plane.id : candidate.nativeId === plane.nativeId)
    );
    if (!observed) throw new Error(`Construction plane is not present in the current document: ${plane.id}`);
    assertFrameClose(observed, plane);
    await this.runtime.mutate(`function (Database, args) {
      const viewport = Array.from(this.viewports)[0];
      if (!viewport) throw new Error('Plasticity viewport is unavailable');
      let selected;
      if (args.source === 'standard') {
        selected = Database[args.nativeId];
      } else {
        const snapshot = this.planes.snapshot();
        const idEntries = snapshot.ids instanceof Map ? Array.from(snapshot.ids) : Object.entries(snapshot.ids ?? {});
        const idEntry = idEntries.find(([, nativeId]) => String(nativeId) === args.nativeId);
        const index = idEntry ? Number(idEntry[0]) : undefined;
        selected = snapshot.planes?.[index];
      }
      if (!selected) throw new Error('Construction plane is unavailable: ' + args.nativeId);
      viewport.constructionPlane = selected;
      if (viewport.constructionPlane !== selected) throw new Error('Plasticity did not activate the requested construction plane');
      viewport.setNeedsRender();
    }`, ["ConstructionPlaneDatabase"], [{ id: observed.id, nativeId: observed.nativeId, source: observed.source }]);
    try {
      return await this.runtime.getState();
    } catch (error) {
      this.runtime.markUncertain();
      throw uncertainVerificationError("active workplane change", error);
    }
  }

  private async requireRevision(expected: string): Promise<RuntimeState> {
    const current = await this.runtime.getState();
    if (current.revision !== expected) {
      throw new Error(`Stale reference: expected revision ${expected}, current revision is ${current.revision}`);
    }
    return current;
  }

  private async requireForeground(): Promise<void> {
    const focused = await this.runtime.read<boolean>(`function () { return document.hasFocus(); }`);
    if (!focused) {
      throw new Error("The selected Plasticity window must be in the foreground before a native construction operation");
    }
  }
}

function uncertainVerificationError(operation: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${operation} outcome is uncertain because native read-back failed: ${message}`);
}

export function dot(left: Vector3, right: Vector3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

export function cross(left: Vector3, right: Vector3): Vector3 {
  return canonicalVector([
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ]);
}

export function add(left: Vector3, right: Vector3): Vector3 {
  return canonicalVector([left[0] + right[0], left[1] + right[1], left[2] + right[2]]);
}

export function subtract(left: Vector3, right: Vector3): Vector3 {
  return canonicalVector([left[0] - right[0], left[1] - right[1], left[2] - right[2]]);
}

export function scale(value: Vector3, factor: number): Vector3 {
  assertFiniteNumber(factor, "Scale factor");
  return canonicalVector([value[0] * factor, value[1] * factor, value[2] * factor]);
}

export function distance(left: Vector3, right: Vector3): number {
  return magnitude(subtract(left, right));
}

export function normalize(value: Vector3, label = "Direction"): Vector3 {
  assertFiniteVector(value, label);
  const length = magnitude(value);
  if (length <= GEOMETRY_EPSILON) throw new Error(`${label} is zero or too short`);
  return canonicalVector([value[0] / length, value[1] / length, value[2] / length]);
}

export function frameFromOriginNormalX(
  originMm: Vector3,
  normal: Vector3,
  xDirection: Vector3,
): PlaneFrame {
  assertFiniteVector(originMm, "Plane origin");
  const unitNormal = normalize(normal, "Plane normal");
  assertFiniteVector(xDirection, "Plane x direction");
  const projectedX = subtract(xDirection, scale(unitNormal, dot(xDirection, unitNormal)));
  if (magnitude(projectedX) <= GEOMETRY_EPSILON) {
    throw new Error("Plane x direction is parallel to the plane normal");
  }
  const unitX = normalize(projectedX, "Plane x direction");
  const unitY = normalize(cross(unitNormal, unitX), "Plane y direction");
  return {
    originMm: canonicalVector(originMm),
    normal: unitNormal,
    xDirection: unitX,
    yDirection: unitY,
  };
}

export function frameFromThreePoints(first: Vector3, second: Vector3, third: Vector3): PlaneFrame {
  assertFiniteVector(first, "First plane point");
  assertFiniteVector(second, "Second plane point");
  assertFiniteVector(third, "Third plane point");
  const firstToSecond = subtract(second, first);
  const firstToThird = subtract(third, first);
  if (magnitude(firstToSecond) <= GEOMETRY_EPSILON || magnitude(firstToThird) <= GEOMETRY_EPSILON) {
    throw new Error("Construction plane points are coincident");
  }
  const normal = cross(firstToSecond, firstToThird);
  if (magnitude(normal) <= GEOMETRY_EPSILON) throw new Error("Construction plane points are collinear");
  return frameFromOriginNormalX(first, normal, firstToSecond);
}

export function offsetFrame(frame: PlaneFrame, offsetMm: number): PlaneFrame {
  assertFiniteNumber(offsetMm, "Plane offset");
  return {
    ...frame,
    originMm: add(frame.originMm, scale(frame.normal, offsetMm)),
  };
}

export function rotateFrameAboutAxis(frame: PlaneFrame, axis: AxisLine, angleDegrees: number): PlaneFrame {
  assertFiniteNumber(angleDegrees, "Rotation angle");
  const unitAxis = normalize(axis.direction, "Rotation axis direction");
  const originPlaneDistance = Math.abs(dot(subtract(axis.originMm, frame.originMm), frame.normal));
  const directionPlaneDistance = Math.abs(dot(unitAxis, frame.normal));
  if (originPlaneDistance > GEOMETRY_EPSILON || directionPlaneDistance > GEOMETRY_EPSILON) {
    throw new Error("Rotation axis must be coplanar with the construction plane");
  }
  const radians = angleDegrees * Math.PI / 180;
  const relativeOrigin = subtract(frame.originMm, axis.originMm);
  const rotatedOrigin = add(axis.originMm, rotateVector(relativeOrigin, unitAxis, radians));
  const rotatedNormal = rotateVector(frame.normal, unitAxis, radians);
  const rotatedX = rotateVector(frame.xDirection, unitAxis, radians);
  return frameFromOriginNormalX(rotatedOrigin, rotatedNormal, rotatedX);
}

export function localPointToWorld(
  frame: PlaneFrame,
  local: readonly [number, number] | readonly [number, number, number],
): Vector3 {
  const [x, y, z = 0] = local;
  assertFiniteNumber(x, "Local x coordinate");
  assertFiniteNumber(y, "Local y coordinate");
  assertFiniteNumber(z, "Local z coordinate");
  return add(
    add(frame.originMm, scale(frame.xDirection, x)),
    add(scale(frame.yDirection, y), scale(frame.normal, z)),
  );
}

export function planeToken(planes: readonly ConstructionPlaneDescriptor[]): string {
  const records = [...planes]
    .sort((left, right) => `${left.source}:${left.nativeId}`.localeCompare(`${right.source}:${right.nativeId}`))
    .map((plane) => [
      plane.id,
      plane.nativeId,
      plane.name,
      plane.source,
      ...plane.originMm.map(stableNumber),
      ...plane.normal.map(stableNumber),
      ...plane.xDirection.map(stableNumber),
      ...plane.yDirection.map(stableNumber),
    ]);
  return `planes:${fnv1a64(JSON.stringify(records))}`;
}

function rotateVector(value: Vector3, unitAxis: Vector3, radians: number): Vector3 {
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return add(
    add(scale(value, cosine), scale(cross(unitAxis, value), sine)),
    scale(unitAxis, dot(unitAxis, value) * (1 - cosine)),
  );
}

function magnitude(value: Vector3): number {
  return Math.hypot(value[0], value[1], value[2]);
}

function stableNumber(value: number): string {
  return canonical(value).toPrecision(12);
}

function fnv1a64(value: string): string {
  let hash = 14_695_981_039_346_656_037n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n);
  }
  return hash.toString(16).padStart(16, "0");
}

function canonicalVector(value: Vector3): Vector3 {
  return [canonical(value[0]), canonical(value[1]), canonical(value[2])];
}

function canonical(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function assertFiniteVector(value: Vector3, label: string): void {
  value.forEach((component) => assertFiniteNumber(component, label));
}

function assertFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
}

function savedNativeIds(state: RuntimeState): Set<string> {
  return new Set(
    state.construction.planes
      .filter((plane) => plane.source === "saved")
      .map((plane) => plane.nativeId),
  );
}

function assertFrameClose(actual: PlaneFrame, expected: PlaneFrame): void {
  if (distance(actual.originMm, expected.originMm) > 0.01) {
    throw new Error(`Construction plane origin differs from requested frame: ${JSON.stringify(actual.originMm)}`);
  }
  for (const [label, left, right] of [
    ["normal", actual.normal, expected.normal],
    ["x direction", actual.xDirection, expected.xDirection],
    ["y direction", actual.yDirection, expected.yDirection],
  ] as const) {
    if (distance(left, right) > 1e-6) throw new Error(`Construction plane ${label} differs from requested frame`);
  }
}
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";
import { millimetersToMeters } from "./units.ts";
