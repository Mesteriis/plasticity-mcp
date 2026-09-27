import { randomUUID } from "node:crypto";

import {
  normalize,
  type AxisLine,
  type ConstructionPlaneDescriptor,
  type Vector3,
} from "./construction.ts";

export type PointDefinition =
  | { type: "coordinates"; pointMm: Vector3 }
  | { type: "face-center"; bodyId: number; faceId: string }
  | { type: "edge-midpoint"; bodyId: number; edgeId: string };

export type AxisDefinition =
  | { type: "two-points"; firstId: string; secondId: string }
  | { type: "origin-direction"; originMm: Vector3; direction: Vector3 }
  | { type: "linear-edge"; bodyId: number; edgeId: string }
  | { type: "cylindrical-face"; bodyId: number; faceId: string };

export type PlaneDefinition =
  | { type: "explicit"; originMm: Vector3; normal: Vector3; xDirection: Vector3 }
  | { type: "three-points"; firstId: string; secondId: string; thirdId: string }
  | { type: "planar-face"; bodyId: number; faceId: string; offsetMm: number }
  | { type: "offset"; planeId: string; offsetMm: number }
  | { type: "rotated"; planeId: string; axisId: string; angleDegrees: number };

export interface ReferenceIdentity {
  id: string;
  sessionId: string;
  documentToken: string;
  revision: string;
}

interface ReferenceRecord extends ReferenceIdentity {
  identity: ReferenceIdentity;
  refreshedFromId: string | null;
}

export interface DatumPointRef extends ReferenceRecord {
  kind: "datum-point";
  pointMm: Vector3;
  definition: PointDefinition;
}

export interface DatumAxisRef extends ReferenceRecord, AxisLine {
  kind: "datum-axis";
  definition: AxisDefinition;
}

export interface ConstructionPlaneRef extends ReferenceRecord, ConstructionPlaneDescriptor {
  kind: "construction-plane";
  definition: PlaneDefinition | { type: "standard" };
}

export type DatumReference = DatumPointRef | DatumAxisRef | ConstructionPlaneRef;

const STANDARD_PLANE_IDS = new Set([
  "standard:top",
  "standard:bottom",
  "standard:left",
  "standard:right",
  "standard:front",
  "standard:back",
]);

export class DatumRegistry {
  readonly sessionId: string;
  private documentToken: string | undefined;
  private revision: string | undefined;
  private readonly points = new Map<string, DatumPointRef>();
  private readonly axes = new Map<string, DatumAxisRef>();
  private readonly planes = new Map<string, ConstructionPlaneRef>();
  private readonly planeDefinitions = new Map<string, PlaneDefinition>();

  constructor(sessionId: string) {
    if (!sessionId) throw new Error("Datum registry session ID is required");
    this.sessionId = sessionId;
  }

  sync(state: { documentToken: string; revision: string }): void {
    if (this.documentToken !== undefined && state.documentToken !== this.documentToken) this.clear();
    this.documentToken = state.documentToken;
    this.revision = state.revision;
  }

  addPoint(definition: PointDefinition, pointMm: Vector3): DatumPointRef {
    const identity = this.nextIdentity();
    const record: DatumPointRef = {
      ...identity,
      identity,
      kind: "datum-point",
      pointMm: cloneVector(pointMm),
      definition: clone(definition),
      refreshedFromId: null,
    };
    this.points.set(record.id, record);
    return record;
  }

  addAxis(definition: AxisDefinition, axis: AxisLine): DatumAxisRef {
    return this.storeAxis(definition, axis, null);
  }

  refreshPoint(id: string, pointMm: Vector3): DatumPointRef {
    const prior = this.requirePointRecord(id);
    if (prior.definition.type === "coordinates") throw new Error("Coordinate datum points are immutable and do not require refresh");
    const identity = this.nextIdentity();
    const refreshed: DatumPointRef = {
      ...identity,
      identity,
      kind: "datum-point",
      pointMm: cloneVector(pointMm),
      definition: clone(prior.definition),
      refreshedFromId: prior.id,
    };
    this.points.set(refreshed.id, refreshed);
    return refreshed;
  }

  refreshAxis(id: string, axis: AxisLine): DatumAxisRef {
    const prior = this.requireAxisRecord(id);
    if (prior.definition.type === "origin-direction") throw new Error("Coordinate datum axes are immutable and do not require refresh");
    return this.storeAxis(prior.definition, axis, prior.id);
  }

  syncPlanes(descriptors: readonly ConstructionPlaneDescriptor[]): void {
    this.assertSynced();
    this.planes.clear();
    for (const descriptor of descriptors) this.storePlane(descriptor);
  }

  putPlane(descriptor: ConstructionPlaneDescriptor, definition: PlaneDefinition): ConstructionPlaneRef {
    if (STANDARD_PLANE_IDS.has(descriptor.id) || descriptor.source === "standard") {
      throw new Error("Standard construction planes cannot be replaced");
    }
    this.planeDefinitions.set(descriptor.nativeId, clone(definition));
    return this.storePlane(descriptor);
  }

  deletePlane(id: string): ConstructionPlaneRef {
    if (STANDARD_PLANE_IDS.has(id)) throw new Error("Standard construction planes cannot be removed");
    const plane = this.getPlane(id);
    this.planes.delete(id);
    this.planeDefinitions.delete(plane.nativeId);
    return plane;
  }

  get(id: string): DatumReference {
    const record = this.points.get(id) ?? this.axes.get(id) ?? this.planes.get(id);
    if (!record) throw new Error(`Unknown datum reference: ${id}`);
    return record;
  }

  getPlane(id: string): ConstructionPlaneRef {
    const plane = this.planes.get(id);
    if (!plane) throw new Error(`Unknown construction plane reference: ${id}`);
    return plane;
  }

  listPoints(): DatumPointRef[] {
    return [...this.points.values()];
  }

  listAxes(): DatumAxisRef[] {
    return [...this.axes.values()];
  }

  listPlanes(): ConstructionPlaneRef[] {
    return [...this.planes.values()];
  }

  requireCurrentPoint(identity: ReferenceIdentity, documentToken: string, revision: string): DatumPointRef {
    this.assertCurrentIdentity(identity, documentToken, revision);
    const point = this.points.get(identity.id);
    if (!point) throw new Error(`Unknown datum point reference: ${identity.id}`);
    this.assertRecordIdentity(point, identity);
    return point;
  }

  requireCurrentAxis(identity: ReferenceIdentity, documentToken: string, revision: string): DatumAxisRef {
    this.assertCurrentIdentity(identity, documentToken, revision);
    const axis = this.axes.get(identity.id);
    if (!axis) throw new Error(`Unknown datum axis reference: ${identity.id}`);
    this.assertRecordIdentity(axis, identity);
    return axis;
  }

  requireCurrentPlane(identity: ReferenceIdentity, documentToken: string, revision: string): ConstructionPlaneRef {
    this.assertCurrentIdentity(identity, documentToken, revision);
    const plane = this.planes.get(identity.id);
    if (!plane) throw new Error(`Unknown construction plane reference: ${identity.id}`);
    this.assertRecordIdentity(plane, identity);
    return plane;
  }

  private storeAxis(definition: AxisDefinition, axis: AxisLine, refreshedFromId: string | null): DatumAxisRef {
    const identity = this.nextIdentity();
    const record: DatumAxisRef = {
      ...identity,
      identity,
      kind: "datum-axis",
      originMm: cloneVector(axis.originMm),
      direction: normalize(axis.direction, "Datum axis direction"),
      definition: clone(definition),
      refreshedFromId,
    };
    this.axes.set(record.id, record);
    return record;
  }

  private storePlane(descriptor: ConstructionPlaneDescriptor): ConstructionPlaneRef {
    if (descriptor.source === "standard" && !STANDARD_PLANE_IDS.has(descriptor.id)) {
      throw new Error(`Unknown standard construction plane ID: ${descriptor.id}`);
    }
    if (descriptor.source === "saved" && STANDARD_PLANE_IDS.has(descriptor.id)) {
      throw new Error(`Saved construction plane cannot use reserved ID: ${descriptor.id}`);
    }
    const identity = this.identity(descriptor.id);
    const record: ConstructionPlaneRef = {
      ...clone(descriptor),
      ...identity,
      identity,
      kind: "construction-plane",
      definition: descriptor.source === "standard"
        ? { type: "standard" }
        : clone(this.planeDefinitions.get(descriptor.nativeId) ?? {
          type: "explicit",
          originMm: descriptor.originMm,
          normal: descriptor.normal,
          xDirection: descriptor.xDirection,
        }),
      refreshedFromId: null,
    };
    this.planes.set(record.id, record);
    return record;
  }

  private requirePointRecord(id: string): DatumPointRef {
    const point = this.points.get(id);
    if (!point) throw new Error(`Unknown datum point reference: ${id}`);
    return point;
  }

  private requireAxisRecord(id: string): DatumAxisRef {
    const axis = this.axes.get(id);
    if (!axis) throw new Error(`Unknown datum axis reference: ${id}`);
    return axis;
  }

  private nextIdentity(): ReferenceIdentity {
    return this.identity(randomUUID());
  }

  private identity(id: string): ReferenceIdentity {
    this.assertSynced();
    return {
      id,
      sessionId: this.sessionId,
      documentToken: this.documentToken as string,
      revision: this.revision as string,
    };
  }

  private assertCurrentIdentity(identity: ReferenceIdentity, documentToken: string, revision: string): void {
    if (identity.sessionId !== this.sessionId) throw new Error("Datum reference belongs to another MCP session");
    if (identity.documentToken !== documentToken) throw new Error("Datum reference belongs to another Plasticity document");
    if (identity.revision !== revision) {
      throw new Error(`Stale datum reference: expected revision ${identity.revision}, current revision is ${revision}`);
    }
  }

  private assertRecordIdentity(record: ReferenceRecord, supplied: ReferenceIdentity): void {
    if (
      record.sessionId !== supplied.sessionId ||
      record.documentToken !== supplied.documentToken ||
      record.revision !== supplied.revision
    ) {
      throw new Error(`Stale datum reference identity: ${supplied.id}`);
    }
  }

  private assertSynced(): void {
    if (this.documentToken === undefined || this.revision === undefined) {
      throw new Error("Datum registry must be synchronized with a Plasticity document first");
    }
  }

  private clear(): void {
    this.points.clear();
    this.axes.clear();
    this.planes.clear();
    this.planeDefinitions.clear();
  }
}

function cloneVector(value: Vector3): Vector3 {
  return [...value] as Vector3;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
