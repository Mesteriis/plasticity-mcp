import { CdpClient } from "../cdp/client.ts";
import type { PlasticityTarget } from "../cdp/discovery.ts";
import type { ConstructionPlaneDescriptor } from "./construction.ts";

export const NATIVE_STATE_READ_TIMEOUT_MS = 300_000;
export const LONG_NATIVE_IMPORT_TIMEOUT_MS = 300_000;

interface RemoteObject {
  objectId?: string;
  value?: unknown;
  description?: string;
}

interface PropertyDescriptor {
  name: string;
  value?: RemoteObject;
}

interface CallResult {
  result?: RemoteObject;
  exceptionDetails?: { text?: string; exception?: RemoteObject };
}

export function mutationOutcomeIsUncertain(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /^(?:CDP request timed out:|CDP connection (?:is closed|closed before the request completed))/i.test(error.message);
}

export interface RuntimeState {
  targetId: string;
  title: string;
  documentToken: string;
  revision: string;
  dbVersion: number | null;
  undoDepth: number;
  redoDepth: number;
  materials?: Array<{
    id: number;
    name: string;
    colorHex: string | null;
    roughness: number | null;
    metalness: number | null;
    opacity: number | null;
  }>;
  measurements?: Array<{
    id: number;
    versionId: number;
    type: string;
    name: string | null;
    measurementSource: "native-brep";
    first: { bodyId: number | null; topologyId: number; landmark: number; topologyType?: "vertex" | "edge" | "face" | null; topologyRefId?: number | string | null; positionMm: [number, number, number] | null } | null;
    second: { bodyId: number | null; topologyId: number; landmark: number; topologyType?: "vertex" | "edge" | "face" | null; topologyRefId?: number | string | null; positionMm: [number, number, number] | null } | null;
    distanceMm: number | null;
    direction: [number, number, number] | null;
    normal: [number, number, number] | null;
    offsetMm: number[];
    radiusMm?: number | null;
    diameterMm?: number | null;
  }>;
  sectionAnalyses?: Array<{
    id: number;
    versionId: number;
    name: string | null;
    originMm: [number, number, number];
    normal: [number, number, number];
    visible: boolean;
    registeredViewportCount: number;
  }>;
  instances?: Array<{
    id: number;
    type: "Instance";
    targetKey: number;
    targetName: string | null;
    sourceBodyIds: number[];
    translationMm: [number, number, number];
    rotationQuaternion: [number, number, number, number];
    scale: [number, number, number];
    matrixWorldMm: number[];
    visible: boolean;
    hidden: boolean;
    locked: boolean;
  }>;
  referenceMeshes?: Array<{
    id: number;
    type: "ReferenceMesh";
    name: string | null;
    sourcePath: string;
    sourceFormat: "stl" | "obj" | "3mf" | "unknown";
    measurementSource: "reference-mesh";
    boundsMm: { min: [number, number, number]; max: [number, number, number] } | null;
    translationMm: [number, number, number];
    rotationQuaternion: [number, number, number, number];
    sceneScaleToMeters: [number, number, number];
    vertexEntries: number;
    triangles: number;
    visible: boolean;
    hidden: boolean;
    locked: boolean;
  }>;
  activeGroupId?: number;
  groups?: Array<{
    id: number;
    name: string | null;
    parentId: number | null;
    childGroupIds: number[];
    bodyIds: number[];
    instanceIds: number[];
    referenceMeshIds: number[];
    otherNodeKeys: number[];
    visible: boolean;
    hidden: boolean;
    locked: boolean;
  }>;
  construction: {
    planes: ConstructionPlaneDescriptor[];
    activePlaneId: string | null;
    planeStateToken: string;
    viewStateToken: string;
  };
  regions: Array<{
    id: string;
    entityId: number;
    islandVersionId: number;
    sketchId: number;
    sketchWireIds: number[];
    measurementSource: "render-mesh";
    displayBoundsMm: { min: [number, number, number]; max: [number, number, number] };
  }>;
  bodies: Array<{
    id: number;
    versionId: number;
    type: string;
    name: string | null;
    materialId?: number;
    visible?: boolean;
    hidden?: boolean;
    locked?: boolean;
    boundsMm: { min: [number, number, number]; max: [number, number, number] } | null;
    faceIds: string[];
    edgeIds: string[];
    faces: Array<{
      id: string;
      surfaceType: string;
      planar: boolean;
      centerMm: [number, number, number];
      normal: [number, number, number];
      radiusMm: number | null;
      blendRadiusMm: number | null;
      axisOriginMm: [number, number, number] | null;
      axisDirection: [number, number, number] | null;
      coneBasisRadiusMm?: number;
      coneSemiAngleRad?: number;
      boundsMm: { min: [number, number, number]; max: [number, number, number] };
      edgeIds: string[];
    }>;
    edges: Array<{
      id: string;
      curveType: string;
      line: boolean;
      circle: boolean;
      lengthMm: number;
      centerMm: [number, number, number];
      tangent: [number, number, number];
      boundsMm: { min: [number, number, number]; max: [number, number, number] };
      faceIds: string[];
      vertexIds: number[];
      circleGeometry?: {
        centerMm: [number, number, number];
        radiusMm: number;
        normal: [number, number, number];
        reference: [number, number, number];
        startMm: [number, number, number];
        midpointMm: [number, number, number];
        endMm: [number, number, number];
      };
    }>;
    vertices?: Array<{
      id: number;
      positionMm: [number, number, number];
      edgeIds: string[];
      faceIds: string[];
    }>;
  }>;
}

export class PlasticityRuntime {
  private client: CdpClient;
  private readonly target: PlasticityTarget;
  private editorId: string;
  private readonly bindings = new Map<string, string>();
  private operationTail: Promise<void> = Promise.resolve();
  private uncertain = false;
  private readonly connectClient: (url: string) => Promise<CdpClient>;

  private constructor(client: CdpClient, target: PlasticityTarget, editorId: string, connectClient = CdpClient.connect) {
    this.client = client;
    this.target = target;
    this.editorId = editorId;
    this.connectClient = connectClient;
  }

  static async connect(target: PlasticityTarget): Promise<PlasticityRuntime> {
    const client = await CdpClient.connect(target.webSocketDebuggerUrl);
    const runtime = new PlasticityRuntime(client, target, "", CdpClient.connect);
    try {
      await client.send("Runtime.enable");
      await runtime.refreshNativeReferences();
      return runtime;
    } catch (error) {
      runtime.close();
      throw error;
    }
  }

  getCapabilities(): string[] {
    return [...this.bindings.keys()].sort();
  }

  isUncertain(): boolean {
    return this.uncertain;
  }

  markUncertain(): void {
    this.uncertain = true;
  }

  async reconnect(): Promise<void> {
    await this.enqueue(async () => {
      if (this.uncertain) throw new Error("Previous mutation outcome is uncertain; reconcile before reconnecting");
      const replacement = await this.connectClient(this.target.webSocketDebuggerUrl);
      const previousClient = this.client;
      const previousEditorId = this.editorId;
      const previousBindings = new Map(this.bindings);
      try {
        await replacement.send("Runtime.enable");
        this.client = replacement;
        this.editorId = "";
        this.bindings.clear();
        await this.refreshNativeReferences();
        previousClient.close();
      } catch (error) {
        if (this.client === replacement) {
          this.client = previousClient;
          this.editorId = previousEditorId;
          this.bindings.clear();
          for (const [name, objectId] of previousBindings) this.bindings.set(name, objectId);
        }
        replacement.close();
        throw error;
      }
    });
  }

  async read<T>(functionDeclaration: string, values: unknown[] = [], timeoutMs?: number): Promise<T> {
    return await this.enqueue(() => this.call<T>(functionDeclaration, [], values, timeoutMs));
  }

  async readNative<T>(
    functionDeclaration: string,
    bindingNames: string[],
    values: unknown[] = [],
    timeoutMs?: number,
  ): Promise<T> {
    return await this.enqueue(() => this.call<T>(functionDeclaration, bindingNames, values, timeoutMs));
  }

  async mutate<T>(
    functionDeclaration: string,
    bindingNames: string[],
    values: unknown[] = [],
    timeoutMs?: number,
  ): Promise<T> {
    return await this.enqueue(async () => {
      if (this.uncertain) throw new Error("Previous mutation outcome is uncertain; call reconcile before another mutation");
      try {
        return await this.call<T>(functionDeclaration, bindingNames, values, timeoutMs);
      } catch (error) {
        if (mutationOutcomeIsUncertain(error)) this.uncertain = true;
        throw error;
      }
    });
  }

  async reconcile(timeoutMs = NATIVE_STATE_READ_TIMEOUT_MS): Promise<RuntimeState> {
    const state = await this.getState(timeoutMs);
    this.uncertain = false;
    return state;
  }

  async getState(timeoutMs = NATIVE_STATE_READ_TIMEOUT_MS): Promise<RuntimeState> {
    const result = await this.readNative<Omit<RuntimeState, "targetId" | "title">>(`function (ConstructionPlaneDatabase, Vector, Quaternion) {
      const mm = value => value * 1000;
      const vector = value => [mm(value.x), mm(value.y), mm(value.z)];
      const direction = value => [value.x, value.y, value.z];
      const stableNumber = value => (Object.is(value, -0) ? 0 : value).toPrecision(12);
      const token = value => {
        let hash = 14695981039346656037n;
        for (let index = 0; index < value.length; index += 1) {
          hash ^= BigInt(value.charCodeAt(index));
          hash = BigInt.asUintN(64, hash * 1099511628211n);
        }
        return hash.toString(16).padStart(16, '0');
      };
      const planeDescriptor = (id, nativeId, source, plane) => ({
        id,
        nativeId: String(nativeId),
        name: String(plane.name ?? id),
        source,
        originMm: vector(plane.p),
        normal: direction(plane.n),
        xDirection: direction(plane.x),
        yDirection: direction(plane.y),
      });
      const standardPlaneEntries = [
        ['top', 'Top'],
        ['bottom', 'Bottom'],
        ['left', 'Left'],
        ['right', 'Right'],
        ['front', 'Front'],
        ['back', 'Back'],
      ];
      const planeRecords = standardPlaneEntries.map(([id, key]) => ({
        object: ConstructionPlaneDatabase[key],
        descriptor: planeDescriptor('standard:' + id, key, 'standard', ConstructionPlaneDatabase[key]),
      }));
      const savedSnapshot = this.planes.snapshot();
      const savedIdEntries = savedSnapshot.ids instanceof Map
        ? Array.from(savedSnapshot.ids)
        : Object.entries(savedSnapshot.ids ?? {});
      const savedIds = savedIdEntries.map(([index, nativeId]) => [String(nativeId), Number(index)]);
      for (const [nativeId, index] of savedIds) {
        const plane = savedSnapshot.planes?.[index];
        if (plane) planeRecords.push({
          object: plane,
          descriptor: planeDescriptor('plane:' + nativeId, nativeId, 'saved', plane),
        });
      }
      const planes = planeRecords
        .map(record => record.descriptor)
        .sort((left, right) => (left.source + ':' + left.nativeId).localeCompare(right.source + ':' + right.nativeId));
      const planeStateToken = 'planes:' + token(JSON.stringify(planes.map(plane => [
        plane.id,
        plane.nativeId,
        plane.name,
        plane.source,
        ...plane.originMm.map(stableNumber),
        ...plane.normal.map(stableNumber),
        ...plane.xDirection.map(stableNumber),
        ...plane.yDirection.map(stableNumber),
      ])));
      const viewport = Array.from(this.viewports)[0];
      const active = viewport?.constructionPlane;
      const frameEqual = (left, right) => ['p', 'n', 'x', 'y'].every(key =>
        left?.[key] && right?.[key] && left[key].distanceToSquared(right[key]) <= 1e-24
      );
      const activeRecord = active
        ? (planeRecords.find(record => record.object === active) ?? planeRecords.find(record => frameEqual(record.object, active)))
        : undefined;
      const activePlaneId = activeRecord?.descriptor.id ?? null;
      const activeFrameToken = active
        ? [vector(active.p), direction(active.n), direction(active.x), direction(active.y)].flat().map(stableNumber).join(',')
        : 'none';
      const viewStateToken = ['workplane', activePlaneId ?? 'unregistered', activeFrameToken].join(':');
      const bodies = [...this.geo.geometryModel].map(([versionId, item]) => {
        const bodyType = item.view?.constructor?.name ?? 'Unknown';
        const isBrepShell = bodyType === 'Solid' || bodyType === 'Sheet';
        const isWire = bodyType === 'Wire';
        let box = null;
        if (typeof item.model?.FindBox === 'function') {
          if (isWire) {
            try { box = item.model.FindBox(); } catch {}
          } else box = item.model.FindBox();
        }
        const key = this.db.nodes?.item2key?.(item.view);
        const name = key === undefined ? null : (this.db.nodes?.getName?.(key) ?? null);
        const materialId = key === undefined ? 0 : (this.db.nodes?.getMaterialId?.(key) ?? 0);
        // Wire B-curve segments have their own segmentEntityId API. Some
        // Plasticity rebuild results expose transient high-edge views that are
        // not shell B-Rep topology and can make getBoundingBox throw
        // PK_ERROR_not_an_entity. Only Solid/Sheet topology belongs here.
        const faceViews = isBrepShell ? item.view?.high?.faces : null;
        const edgeViews = isBrepShell ? item.view?.high?.edges : null;
        const faceIdByEntity = new Map();
        const edgeIdByEntity = new Map();
        for (let index = 0; index < (faceViews?.versionIds?.length ?? 0); index += 1) {
          const view = faceViews.get(index);
          if (view) faceIdByEntity.set(view.entityId, String(faceViews.versionIds[index]));
        }
        for (let index = 0; index < (edgeViews?.versionIds?.length ?? 0); index += 1) {
          const view = edgeViews.get(index);
          if (view) edgeIdByEntity.set(view.entityId, String(edgeViews.versionIds[index]));
        }
        const modelFaces = isBrepShell ? item.model?.GetFaces?.() : null;
        const faces = [];
        for (let index = 0; index < (modelFaces?.Size?.() ?? 0); index += 1) {
          const face = modelFaces.Get(index);
          const id = faceIdByEntity.get(face.Id());
          if (!id) continue;
          const midpoint = face.FindMidpoint();
          const surface = face.GetSurface();
          if (!faceViews) continue;
          const viewIndex = faceViews.versionIds.indexOf(id);
          const faceView = viewIndex >= 0 ? faceViews.get(viewIndex) : null;
          if (!faceView) continue;
          const faceBox = faceView.getBoundingBox();
          const faceEdges = face.GetEdges();
          const adjacentEdgeIds = [];
          for (let edgeIndex = 0; edgeIndex < faceEdges.Size(); edgeIndex += 1) {
            const adjacentId = edgeIdByEntity.get(faceEdges.Get(edgeIndex).Id());
            if (adjacentId) adjacentEdgeIds.push(adjacentId);
          }
          const radius = face.GetRadius();
          const blendRadius = face.GetBlendRadius();
          const surfaceType = surface.surface?.constructor?.name ?? 'Unknown';
          let axisOriginMm = null;
          let axisDirection = null;
          let coneBasisRadiusMm = null;
          let coneSemiAngleRad = null;
          if (surfaceType === 'Cylinder' || surfaceType === 'Cone') {
            const info = surface.surface.GetInfo?.();
            const basis = info?.basis;
            if (basis?.Location && basis?.Axis) {
              axisOriginMm = vector(basis.Location);
              axisDirection = direction(basis.Axis);
            }
            if (surfaceType === 'Cone' && Number.isFinite(info?.semiAngle)) {
              coneSemiAngleRad = info.semiAngle;
            }
            if (surfaceType === 'Cone' && Number.isFinite(info?.radius) && info.radius > 0) {
              coneBasisRadiusMm = mm(info.radius);
            }
          }
          faces.push({
            id,
            surfaceType,
            planar: face.IsPlanar(),
            centerMm: vector(midpoint.position),
            normal: direction(midpoint.normal),
            radiusMm: Number.isFinite(radius) && radius > 0 ? mm(radius) : null,
            blendRadiusMm: Number.isFinite(blendRadius) && blendRadius >= 0 ? mm(blendRadius) : null,
            axisOriginMm,
            axisDirection,
            ...(coneBasisRadiusMm === null ? {} : { coneBasisRadiusMm }),
            ...(coneSemiAngleRad === null ? {} : { coneSemiAngleRad }),
            boundsMm: { min: vector(faceBox.min), max: vector(faceBox.max) },
            edgeIds: adjacentEdgeIds,
          });
        }
        const modelEdges = isBrepShell ? item.model?.GetEdges?.() : null;
        const edges = [];
        const verticesById = new Map();
        for (let index = 0; index < (modelEdges?.Size?.() ?? 0); index += 1) {
          const edge = modelEdges.Get(index);
          const id = edgeIdByEntity.get(edge.Id());
          if (!id) continue;
          const midpoint = edge.GetPointAndTangent(0.5);
          const length = edge.FindLength();
          const curve = edge.GetCurve();
          const nativeCurve = curve?.curve ?? curve;
          let circleGeometry = null;
          if (edge.IsCircle()) {
            const info = nativeCurve?.GetInfo?.();
            const basis = info?.basis;
            const location = basis?.Location;
            const axis = basis?.Axis;
            const reference = basis?.Ref;
            if (location && axis && reference && Number.isFinite(info?.radius) && info.radius > 0) {
              const start = edge.GetPointAndTangent(0).position;
              const end = edge.GetPointAndTangent(1).position;
              circleGeometry = {
                centerMm: vector(location),
                radiusMm: mm(info.radius),
                normal: direction(axis),
                reference: direction(reference),
                startMm: vector(start),
                midpointMm: vector(midpoint.position),
                endMm: vector(end),
              };
            }
          }
          if (!edgeViews) continue;
          const viewIndex = edgeViews.versionIds.indexOf(id);
          const edgeView = viewIndex >= 0 ? edgeViews.get(viewIndex) : null;
          if (!edgeView) continue;
          const edgeBox = edgeView.getBoundingBox();
          const adjacentFaces = edge.GetFaces();
          const adjacentFaceIds = [];
          for (let faceIndex = 0; faceIndex < adjacentFaces.Size(); faceIndex += 1) {
            const adjacentId = faceIdByEntity.get(adjacentFaces.Get(faceIndex).Id());
            if (adjacentId) adjacentFaceIds.push(adjacentId);
          }
          const vertices = edge.GetVertices();
          for (const vertex of [vertices.left, vertices.right]) {
            const vertexId = vertex?.Id?.();
            if (!Number.isInteger(vertexId) || verticesById.has(vertexId)) continue;
            const vertexEdges = vertex.GetEdges?.();
            const adjacentVertexEdgeIds = [];
            for (let edgeIndex = 0; edgeIndex < (vertexEdges?.Size?.() ?? 0); edgeIndex += 1) {
              const adjacentId = edgeIdByEntity.get(vertexEdges.Get(edgeIndex).Id());
              if (adjacentId) adjacentVertexEdgeIds.push(adjacentId);
            }
            const vertexFaces = vertex.GetFaces?.();
            const adjacentVertexFaceIds = [];
            for (let faceIndex = 0; faceIndex < (vertexFaces?.Size?.() ?? 0); faceIndex += 1) {
              const adjacentId = faceIdByEntity.get(vertexFaces.Get(faceIndex).Id());
              if (adjacentId) adjacentVertexFaceIds.push(adjacentId);
            }
            verticesById.set(vertexId, {
              id: vertexId,
              positionMm: vector(vertex.GetPoint()),
              edgeIds: adjacentVertexEdgeIds.sort(),
              faceIds: adjacentVertexFaceIds.sort(),
            });
          }
          edges.push({
            id,
            curveType: curve.curve?.constructor?.name ?? 'Unknown',
            line: edge.IsLine(),
            circle: edge.IsCircle(),
            lengthMm: mm(length.length),
            centerMm: vector(midpoint.position),
            tangent: direction(midpoint.tangent),
            boundsMm: { min: vector(edgeBox.min), max: vector(edgeBox.max) },
            faceIds: adjacentFaceIds,
            vertexIds: [vertices.left?.Id?.(), vertices.right?.Id?.()].filter(Number.isInteger),
            ...(circleGeometry === null ? {} : { circleGeometry }),
          });
        }
        const faceIds = Array.from(faceViews?.versionIds ?? []).map(String);
        const edgeIds = Array.from(edgeViews?.versionIds ?? []).map(String);
        return {
          id: this.db.lookupStableId(versionId),
          versionId,
          type: bodyType,
          name,
          materialId,
          visible: key === undefined ? true : Boolean(this.db.nodes?.isVisible?.(key)),
          hidden: key === undefined ? false : Boolean(this.db.nodes?.isHidden?.(key)),
          locked: key === undefined ? false : Boolean(this.db.nodes?.isLocked?.(key)),
          boundsMm: box ? { min: vector(box.min), max: vector(box.max) } : null,
          faceIds,
          edgeIds,
          faces,
          edges,
          vertices: Array.from(verticesById.values()).sort((left, right) => left.id - right.id),
        };
      }).filter(item => Number.isInteger(item.id));
      const materials = this.materials.list().map(([id, info]) => {
        const material = this.materials.get(id);
        return {
          id: Number(id),
          name: String(info.name ?? ''),
          colorHex: typeof material.color?.getHexString === 'function' ? '#' + material.color.getHexString() : null,
          roughness: Number.isFinite(material.roughness) ? Number(material.roughness) : null,
          metalness: Number.isFinite(material.metalness) ? Number(material.metalness) : null,
          opacity: Number.isFinite(material.opacity) ? Number(material.opacity) : null,
        };
      }).filter(material => Number.isInteger(material.id)).sort((left, right) => left.id - right.id);
      const measurementTarget = target => {
        if (!target) return null;
        let bodyId = null;
        let topologyType = null;
        let topologyRefId = null;
        let positionMm = null;
        let radiusMm = null;
        for (const [versionId, item] of this.geo.geometryModel) {
          if (item.model?.Id?.() !== target.bodyId) continue;
          const stableId = this.db.lookupStableId(versionId);
          bodyId = Number.isInteger(stableId) ? stableId : null;
          try {
            const vertices = item.model.GetVertices?.();
            for (let index = 0; index < (vertices?.Size?.() ?? 0); index += 1) {
              const vertex = vertices.Get(index);
              if (vertex?.Id?.() !== target.topologyId) continue;
              positionMm = vector(vertex.GetPoint());
              topologyType = 'vertex';
              topologyRefId = Number(vertex.Id());
              break;
            }
          } catch {}
          if (!positionMm) try {
            const edges = item.model.GetEdges?.();
            for (let index = 0; index < (edges?.Size?.() ?? 0); index += 1) {
              const edge = edges.Get(index);
              if (edge?.Id?.() !== target.topologyId) continue;
              positionMm = vector(edge.GetPointAndTangent(0.5).position);
              topologyType = 'edge';
              const edgeViews = item.view?.high?.edges;
              const edgeViewIndex = Array.from({ length: edgeViews?.versionIds?.length ?? 0 }, (_, viewIndex) => viewIndex)
                .find(viewIndex => Number(edgeViews.get(viewIndex)?.entityId) === Number(target.topologyId));
              topologyRefId = edgeViewIndex === undefined ? null : String(edgeViews.versionIds[edgeViewIndex]);
              const circleRadius = edge.IsCircle?.() ? Number(edge.GetCurve?.()?.curve?.GetInfo?.()?.radius) : NaN;
              radiusMm = Number.isFinite(circleRadius) && circleRadius > 0 ? mm(circleRadius) : null;
              break;
            }
          } catch {}
          if (!positionMm) try {
            const faces = item.model.GetFaces?.();
            for (let index = 0; index < (faces?.Size?.() ?? 0); index += 1) {
              const face = faces.Get(index);
              if (face?.Id?.() !== target.topologyId) continue;
              positionMm = vector(face.FindMidpoint().position);
              topologyType = 'face';
              const faceViews = item.view?.high?.faces;
              const faceViewIndex = Array.from({ length: faceViews?.versionIds?.length ?? 0 }, (_, viewIndex) => viewIndex)
                .find(viewIndex => Number(faceViews.get(viewIndex)?.entityId) === Number(target.topologyId));
              topologyRefId = faceViewIndex === undefined ? null : String(faceViews.versionIds[faceViewIndex]);
              break;
            }
          } catch {}
          break;
        }
        return {
          descriptor: { bodyId, topologyId: Number(target.topologyId), landmark: Number(target.landmark), topologyType, topologyRefId, positionMm },
          radiusMm,
        };
      };
      const measurementSnapshot = this.measurements.snapshot();
      const measurements = Array.from(measurementSnapshot.repo?.measurements ?? []).map(measurement => {
        const firstTarget = measurementTarget(measurement.target1 ?? measurement.target);
        const secondTarget = measurementTarget(measurement.target2);
        const first = firstTarget?.descriptor ?? null;
        const second = secondTarget?.descriptor ?? null;
        const distanceMm = first?.positionMm && second?.positionMm
          ? Math.hypot(
            second.positionMm[0] - first.positionMm[0],
            second.positionMm[1] - first.positionMm[1],
            second.positionMm[2] - first.positionMm[2],
          )
          : null;
        const radial = measurement.constructor?.name === 'RadialMeasurement';
        const offsetMm = radial ? [] : ['x', 'y', 'z']
          .map(key => measurement.offset?.[key])
          .filter(Number.isFinite)
          .map(mm);
        return {
          id: Number(this.measurements.lookupStableId(measurement.versionId)),
          versionId: Number(measurement.versionId),
          type: String(measurement.constructor?.name ?? 'Measurement'),
          name: typeof measurement.userData?.name === 'string' ? measurement.userData.name : null,
          measurementSource: 'native-brep',
          first,
          second,
          distanceMm,
          direction: measurement.direction ? direction(measurement.direction) : null,
          normal: measurement.normal ? direction(measurement.normal) : null,
          offsetMm,
          ...(radial ? {
            radiusMm: firstTarget?.radiusMm ?? null,
            diameterMm: Number.isFinite(firstTarget?.radiusMm) ? firstTarget.radiusMm * 2 : null,
          } : {}),
        };
      }).filter(measurement => Number.isInteger(measurement.id)).sort((left, right) => left.id - right.id);
      const instanceSnapshot = this.db.empties.snapshot();
      const instanceEmpties = Array.from(instanceSnapshot.empties ?? []);
      const instanceInfos = Array.from(instanceSnapshot.infos ?? []);
      const referenceMeshes = instanceEmpties.map((empty, index) => {
        const info = instanceInfos[index];
        if (!empty || info?.tag !== 'Object') return null;
        const stable = this.db.lookupEmptyById(Number(empty.versionId));
        if (stable?.constructor?.name !== 'Empties_ObjectEmpty') return null;
        const sourcePath = String(info.path ?? '');
        const lowerPath = sourcePath.toLowerCase();
        const sourceFormat = lowerPath.endsWith('.stl') ? 'stl' : lowerPath.endsWith('.obj') ? 'obj' : lowerPath.endsWith('.3mf') ? '3mf' : 'unknown';
        const localBox = stable.boundingBox?.clone?.();
        const worldBox = localBox?.applyMatrix4?.(stable.matrixWorld);
        const position = new Vector();
        const rotation = new Quaternion();
        const scale = new Vector();
        stable.matrixWorld.decompose(position, rotation, scale);
        let vertexEntries = 0;
        let triangles = 0;
        stable.traverse?.(node => {
          const geometry = node?.geometry;
          const positions = geometry?.attributes?.position;
          if (!positions || !Number.isFinite(positions.count)) return;
          vertexEntries += Number(positions.count);
          const indexCount = Number(geometry.index?.count);
          triangles += Number.isFinite(indexCount) ? indexCount / 3 : Number(positions.count) / 3;
        });
        const key = this.db.nodes?.item2key?.(stable);
        const pathName = sourcePath.split(/[\\/]/).pop() || null;
        return {
          id: Number(stable.versionId),
          type: 'ReferenceMesh',
          name: key === undefined ? pathName : (this.db.nodes?.getName?.(key) ?? pathName),
          sourcePath,
          sourceFormat,
          measurementSource: 'reference-mesh',
          boundsMm: worldBox ? { min: vector(worldBox.min), max: vector(worldBox.max) } : null,
          translationMm: vector(position),
          rotationQuaternion: [rotation.x, rotation.y, rotation.z, rotation.w],
          sceneScaleToMeters: direction(scale),
          vertexEntries,
          triangles,
          visible: key === undefined ? Boolean(stable.visible) : Boolean(this.db.nodes?.isVisible?.(key)),
          hidden: key === undefined ? !stable.visible : Boolean(this.db.nodes?.isHidden?.(key)),
          locked: key === undefined ? false : Boolean(this.db.nodes?.isLocked?.(key)),
        };
      }).filter(mesh => mesh && Number.isInteger(mesh.id)).sort((left, right) => left.id - right.id);
      const instances = instanceEmpties.map((empty, index) => {
        const info = instanceInfos[index];
        if (!empty || info?.tag !== 'Instance') return null;
        const targetKey = Number(info.targetKey ?? empty.targetKey);
        const sourceBodyIds = [...this.geo.geometryModel]
          .filter(([, item]) => this.db.nodes?.item2key?.(item.view) === targetKey)
          .map(([versionId]) => Number(this.db.lookupStableId(versionId)))
          .filter(Number.isInteger)
          .sort((left, right) => left - right);
        const sourceBodyName = sourceBodyIds
          .map(id => bodies.find(body => body.id === id)?.name)
          .find(name => typeof name === 'string' && name.length > 0) ?? null;
        const position = new Vector();
        const rotation = new Quaternion();
        const scale = new Vector();
        empty.matrixWorld.decompose(position, rotation, scale);
        const matrixWorldMm = Array.from(empty.matrixWorld.elements, Number);
        matrixWorldMm[12] = mm(matrixWorldMm[12]);
        matrixWorldMm[13] = mm(matrixWorldMm[13]);
        matrixWorldMm[14] = mm(matrixWorldMm[14]);
        return {
          id: Number(empty.versionId),
          type: 'Instance',
          targetKey,
          targetName: this.db.nodes?.getName?.(targetKey) || sourceBodyName,
          sourceBodyIds,
          translationMm: vector(position),
          rotationQuaternion: [rotation.x, rotation.y, rotation.z, rotation.w],
          scale: direction(scale),
          matrixWorldMm,
          visible: Boolean(this.db.nodes?.isVisible?.(this.db.nodes.item2key(empty))),
          hidden: Boolean(this.db.nodes?.isHidden?.(this.db.nodes.item2key(empty))),
          locked: Boolean(this.db.nodes?.isLocked?.(this.db.nodes.item2key(empty))),
        };
      }).filter(instance => instance && Number.isInteger(instance.id)).sort((left, right) => left.id - right.id);
      const bodyIdByNodeKey = new Map();
      for (const [versionId, item] of this.geo.geometryModel) {
        const stableId = Number(this.db.lookupStableId(versionId));
        if (!Number.isInteger(stableId)) continue;
        bodyIdByNodeKey.set(Number(this.db.nodes.item2key(item.view)), stableId);
      }
      const instanceIdByNodeKey = new Map();
      for (const empty of instanceEmpties) {
        if (!empty || empty.constructor?.name !== 'InstanceEmpty') continue;
        instanceIdByNodeKey.set(Number(this.db.nodes.item2key(empty)), Number(empty.versionId));
      }
      const referenceMeshIdByNodeKey = new Map();
      for (const empty of instanceEmpties) {
        if (!empty) continue;
        const stable = this.db.lookupEmptyById(Number(empty.versionId));
        if (stable?.constructor?.name !== 'Empties_ObjectEmpty') continue;
        referenceMeshIdByNodeKey.set(Number(this.db.nodes.item2key(stable)), Number(stable.versionId));
      }
      const groupSnapshot = this.db.groups.snapshot();
      const groupIds = Array.from(groupSnapshot.groupIds ?? [], Number);
      const groupChildren = Array.from(groupSnapshot.children ?? [], children => Array.from(children ?? [], Number));
      const groupIdByNodeKey = new Map();
      for (const id of groupIds) {
        const group = this.db.groups.lookupById(id);
        if (group) groupIdByNodeKey.set(Number(this.db.nodes.item2key(group)), id);
      }
      const groups = groupIds.map((id, index) => {
        const group = this.db.groups.lookupById(id);
        if (!group) return null;
        const nodeKey = Number(this.db.nodes.item2key(group));
        const childKeys = groupChildren[index] ?? [];
        const childGroupIds = childKeys.map(key => groupIdByNodeKey.get(key)).filter(Number.isInteger).sort((left, right) => left - right);
        const bodyIds = childKeys.map(key => bodyIdByNodeKey.get(key)).filter(Number.isInteger).sort((left, right) => left - right);
        const instanceIds = childKeys.map(key => instanceIdByNodeKey.get(key)).filter(Number.isInteger).sort((left, right) => left - right);
        const referenceMeshIds = childKeys.map(key => referenceMeshIdByNodeKey.get(key)).filter(Number.isInteger).sort((left, right) => left - right);
        const knownKeys = new Set([
          ...childGroupIds.map(childId => Number(this.db.nodes.item2key(this.db.groups.lookupById(childId)))),
          ...childKeys.filter(key => bodyIdByNodeKey.has(key) || instanceIdByNodeKey.has(key) || referenceMeshIdByNodeKey.has(key)),
        ]);
        return {
          id,
          name: this.db.nodes.getName(nodeKey) ?? null,
          parentId: id === 0 ? null : Number(this.db.groups.getParentId(nodeKey)),
          childGroupIds,
          bodyIds,
          instanceIds,
          referenceMeshIds,
          otherNodeKeys: childKeys.filter(key => !knownKeys.has(key)).sort((left, right) => left - right),
          visible: Boolean(this.db.nodes.isVisible(nodeKey)),
          hidden: Boolean(this.db.nodes.isHidden(nodeKey)),
          locked: Boolean(this.db.nodes.isLocked(nodeKey)),
        };
      }).filter(group => group && Number.isInteger(group.id)).sort((left, right) => left.id - right.id);
      const activeGroupId = Number(groupSnapshot.currentGroupId ?? 0);
      const wireIdsBySketch = new Map();
      for (const [versionId, item] of this.geo.geometryModel) {
        if (item.view?.constructor?.name !== 'Wire') continue;
        const stableId = this.db.lookupStableId(versionId);
        if (!Number.isInteger(stableId)) continue;
        let basis;
        try { basis = this.curves.lookup(item.view); } catch { continue; }
        const sketchEntry = Array.from(this.curves.read.sketch2basis ?? [])
          .find(([, candidateBasis]) => candidateBasis === basis);
        const sketchId = Number(sketchEntry?.[0]);
        if (!Number.isInteger(sketchId)) continue;
        const ids = wireIdsBySketch.get(sketchId) ?? [];
        ids.push(stableId);
        wireIdsBySketch.set(sketchId, ids);
      }
      const regions = [];
      for (const [versionId, item] of this.geo.geometryModel) {
        if (!this.geo.automatics.has(versionId) || item.view?.constructor?.name !== 'SketchIsland') continue;
        let sketchId;
        try { sketchId = Number(this.sketches.getSketchId(item.view)); } catch { continue; }
        if (!Number.isInteger(sketchId)) continue;
        for (let index = 0; index < (item.view.regions?.length ?? 0); index += 1) {
          const region = item.view.regions.get(index);
          if (!region) continue;
          const box = region.getBoundingBox();
          regions.push({
            id: String(region.versionId),
            entityId: Number(region.entityId),
            islandVersionId: versionId,
            sketchId,
            sketchWireIds: [...(wireIdsBySketch.get(sketchId) ?? [])].sort((left, right) => left - right),
            measurementSource: 'render-mesh',
            displayBoundsMm: { min: vector(box.min), max: vector(box.max) },
          });
        }
      }
      regions.sort((left, right) => left.id.localeCompare(right.id));
      const viewports = Array.from(this.viewports ?? []);
      const sectionsByVersion = new Map();
      for (const viewport of viewports) {
        for (const section of viewport.sections ?? []) {
          if (Number.isInteger(Number(section?.versionId))) sectionsByVersion.set(Number(section.versionId), section);
        }
      }
      const sectionAnalyses = Array.from(sectionsByVersion, ([id, section]) => ({
        id,
        versionId: id,
        name: typeof section.name === 'string' && section.name.length > 0 ? section.name : null,
        originMm: vector(section.position),
        normal: direction(section.plane?.normal).map(value => -value),
        visible: Boolean(section.visible),
        registeredViewportCount: viewports.filter(viewport => viewport.sections?.includes(section)).length,
      })).sort((left, right) => left.id - right.id);
      const documentToken = String(this.document?.uuid ?? this.document?.filename ?? 'untitled');
      const dbVersion = Number.isFinite(this.db?.version) ? this.db.version : null;
      const undoDepth = this.history?.undoStack?.length ?? 0;
      const redoDepth = this.history?.redoStack?.length ?? 0;
      const bodyToken = 'bodies:' + token(bodies.map(x => [x.id, x.versionId, x.materialId, x.visible, x.hidden, x.locked].join(':')).join(','));
      const materialToken = 'materials:' + token(JSON.stringify(materials));
      const measurementToken = 'measurements:' + token(JSON.stringify(measurements));
      const instanceToken = 'instances:' + token(JSON.stringify(instances));
      const referenceMeshToken = 'reference-meshes:' + token(JSON.stringify(referenceMeshes));
      const sectionToken = 'sections:' + token(JSON.stringify(sectionAnalyses));
      const groupToken = 'groups:' + token(JSON.stringify([activeGroupId, groups]));
      const revision = [documentToken, dbVersion, undoDepth, redoDepth, bodyToken, planeStateToken, materialToken, measurementToken, instanceToken, referenceMeshToken, sectionToken, groupToken].join('|');
      return {
        documentToken,
        revision,
        dbVersion,
        undoDepth,
        redoDepth,
        materials,
        measurements,
        sectionAnalyses,
        instances,
        referenceMeshes,
        activeGroupId,
        groups,
        construction: { planes, activePlaneId, planeStateToken, viewStateToken },
        regions,
        bodies,
      };
    }`, ["ConstructionPlaneDatabase", "Vector3", "Quaternion"], [], timeoutMs);
    return { targetId: this.target.id, title: this.target.title, ...result };
  }

  close(): void {
    this.client.close();
  }

  async cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return await this.enqueue(() => this.client.send(method, params));
  }

  async captureScreenshot(): Promise<string> {
    return await this.enqueue(() => this.client.captureScreenshot());
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.operationTail;
    let release: (() => void) | undefined;
    this.operationTail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private async refreshNativeReferences(): Promise<void> {
    const handler = await this.client.send("Runtime.evaluate", {
      expression: "document.querySelector('command-log')?.handleCommandStarted",
      returnByValue: false,
    }) as CallResult;
    const handlerId = requireObjectId(handler.result, "Plasticity command log handler");
    const handlerProperties = await getProperties(this.client, handlerId);
    const scopesId = requireObjectId(handlerProperties.internalProperties?.find((property) => property.name === "[[Scopes]]")?.value, "Plasticity command scopes");
    const scopes = await getProperties(this.client, scopesId);
    const scopeIds = scopes.result
      .filter((property) => /^\d+$/.test(property.name))
      .map((property) => property.value?.objectId)
      .filter((value): value is string => typeof value === "string");
    if (scopeIds.length < 2) throw new Error("Plasticity native command scopes were not found");

    const closure = await getProperties(this.client, scopeIds[0] as string);
    const editorId = requireObjectId(
      closure.result.find((property) => property.name === "editor")?.value,
      "Plasticity editor",
    );
    const nativeScope = await getProperties(this.client, scopeIds[1] as string);
    const bindings = new Map<string, string>();
    for (const property of nativeScope.result) {
      if (property.value?.objectId) bindings.set(property.name, property.value.objectId);
    }

    const retained = new Set([editorId, ...bindings.values()]);
    const previous = new Set([this.editorId, ...this.bindings.values()].filter(Boolean));
    this.editorId = editorId;
    this.bindings.clear();
    for (const [name, objectId] of bindings) this.bindings.set(name, objectId);
    const temporary = [
      handlerId,
      scopesId,
      ...objectIds(handlerProperties.result),
      ...objectIds(handlerProperties.internalProperties ?? []),
      ...objectIds(scopes.result),
      ...objectIds(closure.result),
      ...objectIds(nativeScope.result),
    ];
    await this.releaseObjects([...previous, ...temporary], retained);
  }

  private async releaseObjects(objectIds: readonly string[], retained: ReadonlySet<string>): Promise<void> {
    await Promise.all([...new Set(objectIds)].filter((id) => id && !retained.has(id)).map(async (objectId) => {
      await this.client.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
    }));
  }

  private async call<T>(functionDeclaration: string, bindingNames: string[], values: unknown[], timeoutMs?: number): Promise<T> {
    const args: Array<{ objectId?: string; value?: unknown }> = [];
    for (const name of bindingNames) {
      const objectId = this.bindings.get(name);
      if (!objectId) throw new Error(`Plasticity native binding is unavailable: ${name}`);
      args.push({ objectId });
    }
    for (const value of values) args.push({ value });
    const response = await this.client.send("Runtime.callFunctionOn", {
      objectId: this.editorId,
      functionDeclaration,
      arguments: args,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, timeoutMs) as CallResult;
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "unknown renderer error";
      throw new Error(`Plasticity command failed: ${detail}`);
    }
    return response.result?.value as T;
  }
}

async function getProperties(client: CdpClient, objectId: string): Promise<{
  result: PropertyDescriptor[];
  internalProperties?: PropertyDescriptor[];
}> {
  return await client.send("Runtime.getProperties", {
    objectId,
    ownProperties: true,
    accessorPropertiesOnly: false,
  }) as { result: PropertyDescriptor[]; internalProperties?: PropertyDescriptor[] };
}

function requireObjectId(value: RemoteObject | undefined, description: string): string {
  if (!value?.objectId) throw new Error(`${description} is unavailable`);
  return value.objectId;
}

function objectIds(properties: readonly PropertyDescriptor[]): string[] {
  return properties.flatMap((property) => property.value?.objectId ? [property.value.objectId] : []);
}
