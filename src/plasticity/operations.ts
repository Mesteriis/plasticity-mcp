import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readFile, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

import { LONG_NATIVE_IMPORT_TIMEOUT_MS, NATIVE_STATE_READ_TIMEOUT_MS, PlasticityRuntime, type RuntimeState } from "./runtime.ts";
import { add, ConstructionGeometry, cross, dot, frameFromOriginNormalX, localPointToWorld, normalize, scale, subtract } from "./construction.ts";
import {
  DatumRegistry,
  type AxisDefinition,
  type DatumAxisRef,
  type DatumPointRef,
  type DatumReference,
  type PlaneDefinition,
  type ReferenceIdentity,
  type ConstructionPlaneRef,
  type PointDefinition,
} from "./references.ts";
import { resolveAxis, resolvePlaneFrame, resolvePoint, type Resolution } from "./semantic.ts";
import { degreesToRadians, millimetersToMeters } from "./units.ts";
import { calculateConeDevelopment, planConeDevelopmentCurves } from "./cone-development.ts";
import { quaternionFromXyzDegrees, type QuaternionXyzw } from "./print-orientation.ts";
import { countActiveCurveSpans } from "./curve-span-count.ts";
import {
  inspectRectangularMember,
  type MemberEvidence,
  type MemberRequest,
} from "./member-geometry.ts";
import {
  inspectPlanarSection,
  type SectionEvidence,
  type SectionRequest,
} from "./section-geometry.ts";
import {
  inspectArbitrarySection,
  type ArbitrarySectionEvidence,
  type ArbitrarySectionRequest,
} from "./arbitrary-section.ts";
import {
  checkBodyInterference,
  type BodyInterferenceEvidence,
  type BodyInterferencePair,
} from "./interference.ts";
import {
  measureSolidProperties,
  type SolidPropertiesEvidence,
} from "./solid-properties.ts";
import {
  measureFaceProperties,
  type FacePropertiesEvidence,
} from "./face-properties.ts";
import {
  inspectSingleFastenerPlate,
  type FastenerPlateEvidence,
  type FastenerPlateRequest,
} from "./fastener-geometry.ts";
import {
  inspectIntegralRectangularPlate,
  type IntegralPlateEvidence,
  type IntegralPlateRequest,
} from "./integral-plate-geometry.ts";
import {
  inspectFastenerGroupGeometry,
  type FastenerGroupGeometryEvidence,
  type FastenerGroupGeometryRequest,
} from "./fastener-group-geometry.ts";
import {
  inspectFastenerGroupLayout,
  type FastenerGroupLayoutEvidence,
  type FastenerGroupLayoutRequest,
} from "./fastener-group-layout.ts";
import {
  measureFastenerGripStack,
  measureLinearEdges,
  measureNonparallelPlanarPolygonFaceClearance,
  measureParallelPlanarFaceClearance,
  measurePlanarFaces,
  measurePointDistance,
  measurePointToCircularEdge,
  measurePointToLinearEdge,
  measurePointToPlanarFace,
  measurePointToSampledCurveEdge,
  type EdgeReference,
  type NativeSampledWireCurveSegment,
  type NativeWireCircularSegment,
  type FastenerGripLayerReference,
  type FaceReference,
  type MeasurementPointReference,
  type WireSegmentReference,
} from "./measurements.ts";
import { MAX_REFERENCE_THREE_MF_ARCHIVE_BYTES, MAX_THREE_MF_ARCHIVE_BYTES, validateReferenceThreeMfArchive, validateThreeMfArchive, type ThreeMfValidation } from "./three-mf.ts";
import { MAX_OBJ_BYTES, validateObj, type ObjValidation } from "./obj.ts";
import { serializeHiddenLineSvg, type HiddenLineProjectionSegment } from "./hiddenline-svg.ts";
import { tessellateCurve } from "./svg-tessellation.ts";
import { analyzeSvgEllipseArc, fitSvgConicEllipse, fitSvgEllipse } from "./svg-ellipse.ts";
import { evaluateSvgCubicBezier, fitSvgCubicBezier, isExactSvgCubicPolynomialDegree, svgCubicBezierBoundsPoints } from "./svg-cubic.ts";

type Vector3 = [number, number, number];
type Vector2 = [number, number];
export type NativeImportUnit = "millimeter" | "centimeter" | "meter" | "inch" | "foot";
export type ReferenceMeshUnit = NativeImportUnit;
export type TopologyMeasurementPointReference = Exclude<MeasurementPointReference, { type: "coordinates" }>;

export interface PlasticitySelection {
  documentToken: string;
  revision: string;
  bodyIds: number[];
  curveIds: number[];
  instanceIds: number[];
  referenceMeshIds: number[];
  groupIds: number[];
  faces: Array<{ bodyId: number | null; faceId: string }>;
  edges: Array<{ bodyId: number | null; edgeId: string }>;
  regionIds: string[];
  curveControlPoints: CurveControlPointReference[];
}

export interface CurveFragmentDescriptor {
  id: string;
  bodyId: number;
  ancestorVersionId: number;
  fragmentViewId: number;
  entityId: number;
  measurementSource: "native-brep";
  startMm: Vector3;
  midpointMm: Vector3;
  endMm: Vector3;
  lengthMm: number;
}

export interface CurveEndpointDescriptor {
  id: string;
  bodyId: number;
  bodyVersionId: number;
  entityId: number;
  measurementSource: "native-brep";
  positionMm: Vector3;
}

export interface CurveVertexDescriptor {
  id: string;
  bodyId: number;
  bodyVersionId: number;
  vertexId: number;
  viewVersionId: string;
  measurementSource: "native-brep";
  positionMm: Vector3;
  endpoint: boolean;
  adjacentEdgeEntityIds: number[];
}

export interface CurveDirectionDescriptor {
  id: number;
  versionId: number;
  measurementSource: "native-brep";
  closed: boolean;
  segments: Array<{
    entityId: number;
    curveType: string;
    startMm: Vector3;
    endMm: Vector3;
    startTangent: Vector3;
    endTangent: Vector3;
    lengthMm: number;
    circleGeometry?: {
      centerMm: Vector3;
      radiusMm: number;
      normal: Vector3;
      reference: Vector3;
      startMm: Vector3;
      midpointMm: Vector3;
      endMm: Vector3;
    };
  }>;
}

export interface CurveSegmentReference {
  bodyId: number;
  segmentEntityId: number;
}

export type CurvatureEdgeReference = EdgeReference | CurveSegmentReference;

export type FaceDraftClassification = "positive" | "negative" | "neutral" | "mixed";

export interface FaceDraftAnalysis {
  face: FaceReference;
  bodyVersionId: number;
  surfaceType: string;
  measurementSource: "native-brep-face-normal-grid";
  classification: FaceDraftClassification;
  sampleCount: number;
  sampleCounts: { positive: number; negative: number; neutral: number };
  minimumSignedDraft: { valueDeg: number; positionMm: Vector3; normal: Vector3 };
  maximumSignedDraft: { valueDeg: number; positionMm: Vector3; normal: Vector3 };
  minimumAbsoluteDraftDeg: number;
  maximumAbsoluteDraftDeg: number;
}

interface NativeFaceDraftSamples {
  face: FaceReference;
  bodyVersionId: number;
  surfaceType: string;
  samples: Array<{ positionMm: Vector3; normal: Vector3 }>;
}

export interface CurveSegmentEndpointReference extends CurveSegmentReference {
  at: "start" | "end";
}

export interface CurveSegmentSampleReference extends CurveSegmentReference {
  normalizedParameter: number;
}

export interface CurveSegmentSampleDescriptor {
  reference: CurveSegmentSampleReference;
  bodyVersionId: number;
  curveType: string;
  measurementSource: "native-brep";
  positionMm: Vector3;
  tangent: Vector3;
}

export interface ShellEdgeEndpointReference extends EdgeReference {
  vertexId: number;
}

export interface CurveStructureDescriptor {
  id: number;
  versionId: number;
  measurementSource: "native-brep";
  segments: Array<{
    entityId: number;
    curveType: string;
    lengthMm: number;
    degree: number | null;
    controlPointCount: number | null;
    spanCount: number | null;
    activeSpanCount: number | null;
    distinctKnotCount: number | null;
    knots: Array<{ normalizedParameter: number; multiplicity: number; withinSegment: boolean }> | null;
    rational: boolean | null;
    periodic: boolean | null;
    circle: { centerMm: Vector3; radiusMm: number; normal: Vector3 } | null;
  }>;
}

export interface SurfaceStructureDescriptor {
  bodyId: number;
  faceId: string;
  bodyVersionId: number;
  measurementSource: "native-brep";
  surfaceType: string;
  trimmed: boolean;
  faceParameterBounds: { uMin: number; uMax: number; vMin: number; vMax: number };
  naturalParameterBounds: { uMin: number; uMax: number; vMin: number; vMax: number } | null;
  bSpline: {
    uDegree: number;
    vDegree: number;
    uSpanCount: number;
    vSpanCount: number;
    uControlPointCount: number;
    vControlPointCount: number;
    rational: boolean;
  } | null;
}

export interface CurvePlanarityDescriptor {
  id: number;
  versionId: number;
  measurementSource: "native-brep";
  planar: boolean;
  plane: { originMm: Vector3; normal: Vector3 } | null;
}

export type CurveControlPointReference =
  | { bodyId: number; kind: "vertex"; pointId: number }
  | { bodyId: number; kind: "control-point"; pointId: number };

export interface CurveControlPointDescriptor {
  id: number;
  versionId: number;
  positionSource: "native-control-handle";
  boundaryVertices: Array<{
    reference: { bodyId: number; kind: "vertex"; pointId: number };
    versionId: string;
    positionMm: Vector3;
    slideDirections: { positiveU: Vector3; negativeU: Vector3 } | null;
  }>;
  interiorControlPoints: Array<{
    reference: { bodyId: number; kind: "control-point"; pointId: number };
    versionId: string;
    positionMm: Vector3;
    slideDirections: { positiveU: Vector3; negativeU: Vector3 } | null;
  }>;
}

export type RebuildCurveOptions =
  | { method: "tolerance"; toleranceMm: number; preserveParameterization?: boolean; preserveChain?: boolean; keepCorners?: boolean }
  | { method: "control-points"; pointCount: number; preserveParameterization?: boolean; preserveChain?: boolean; keepCorners?: boolean }
  | { method: "degree-spans"; degree: number; spans: number; preserveParameterization?: boolean; preserveChain?: boolean; keepCorners?: boolean };

export interface CurveIntersectionDescriptor {
  id: string;
  bodyIds: [number, number];
  bodyVersionIds: [number, number];
  edgeEntityIds: [number, number];
  measurementSource: "native-brep";
  positionMm: Vector3;
}

export interface BodyValidationDescriptor {
  id: number;
  versionId: number;
  type: string;
  name: string | null;
  measurementSource: "native-brep";
  faceCount: number;
  edgeCount: number;
  boundaryEdgeIds: string[];
  closed: boolean;
  nativeCheckCodes: number[];
  nativeValid: boolean;
  printableSolid: boolean;
}

export type AppearanceMaterialInput =
  | { materialId: number }
  | { name: string; colorHex: string; roughness: number; metalness: number; opacity: number };

export interface VertexReference {
  bodyId: number;
  vertexId: number;
}

export interface CreateTextInput {
  text: string;
  fontSizeMm: number;
  originMm: Vector3 | Vector2;
  font?: "inter";
  name?: string;
  revision?: string;
  normal?: Vector3;
  xDirection?: Vector3;
  plane?: ReferenceIdentity;
  angleDegrees?: number;
}

const findView = `const find = id => {
  for (const [versionId, item] of this.geo.geometryModel) {
    if (this.db.lookupStableId(versionId) === id) return item.view;
  }
  throw new Error('Unknown body ID: ' + id);
};`;

const findFaceViews = `${findView}
const selectedFaces = args.faces.map(reference => {
  const view = find(reference.bodyId);
  const index = view.high.faces.versionIds.indexOf(reference.faceId);
  if (index < 0) throw new Error('Stale or unknown face: ' + reference.bodyId + ':' + reference.faceId);
  return view.high.faces.get(index);
});`;

const findEdgeViews = `${findView}
const view = find(args.edges[0].bodyId);
const selectedEdges = args.edges.map(reference => {
  if (reference.bodyId !== args.edges[0].bodyId) throw new Error('Native edge edit requires one body');
  const index = view.high.edges.versionIds.indexOf(reference.edgeId);
  if (index < 0) throw new Error('Stale or unknown edge: ' + reference.bodyId + ':' + reference.edgeId);
  return view.high.edges.get(index);
});`;

const findCurveControlPoints = `const views = new Map();
for (const bodyId of new Set(args.points.map(point => point.bodyId))) {
  for (const [versionId, item] of this.geo.geometryModel) {
    if (this.db.lookupStableId(versionId) === bodyId && item.view?.constructor?.name === 'Wire') {
      views.set(bodyId, item.view);
      break;
    }
  }
  if (!views.has(bodyId)) throw new Error('Unknown current Wire ID: ' + bodyId);
}
const vertices = [];
const cvs = [];
for (const point of args.points) {
  const view = views.get(point.bodyId);
  const collection = point.kind === 'vertex' ? view.vertices : view.cvs;
  const found = Array.from(collection ?? []).find(candidate => Number(candidate.id) === point.pointId);
  if (!found) throw new Error('Unknown current curve control point: ' + point.bodyId + ':' + point.kind + ':' + point.pointId);
  (point.kind === 'vertex' ? vertices : cvs).push(found);
}`;

const findWritableInstanceEmpty = `const find = id => {
  const store = this.db.empties.write;
  const original = store.id2empty.get(id);
  if (original?.constructor?.name !== 'InstanceEmpty') throw new Error('Unknown native instance ID: ' + id);
  const copy = original.clone(false);
  copy.versionId = original.versionId;
  copy.targetKey = original.targetKey;
  copy.kind = original.kind;
  store.id2empty.set(id, copy);
  return copy;
};`;

const commandStart = (commandName: string, factoryName = "Factory") => `
  if (this.executor.isBusy) throw new Error('Plasticity is busy');
  const editor = this;
  let failure;
  const command = new this.commands.${commandName}(this);
  command.remember = false;
  command.execute = async function () {
    try {
      const factory = new ${factoryName}(editor).resource(this);`;

const commandEnd = `
      return await factory.commit();
    } catch (error) {
      failure = error;
      throw error;
    }
  };
  await this.exec(command);
  if (failure) throw failure;`;

export class PlasticityOperations {
  readonly runtime: PlasticityRuntime;
  readonly datumRegistry: DatumRegistry;
  readonly constructionGeometry: ConstructionGeometry;
  private measurementOverlaySignature?: string;

  constructor(runtime: PlasticityRuntime, sessionId: string = randomUUID()) {
    this.runtime = runtime;
    this.datumRegistry = new DatumRegistry(sessionId);
    this.constructionGeometry = new ConstructionGeometry(runtime);
  }

  async state(timeoutMs = NATIVE_STATE_READ_TIMEOUT_MS): Promise<RuntimeState> {
    const state = await this.runtime.getState(timeoutMs);
    const measurements = (state.measurements ?? []).filter((measurement) =>
      measurement.type === "DistanceMeasurement"
      && measurement.first?.positionMm
      && measurement.second?.positionMm
      && measurement.direction
      && measurement.normal
      && measurement.offsetMm.length >= 2
      && typeof measurement.distanceMm === "number"
      && Number.isFinite(measurement.distanceMm),
    );
    const signature = JSON.stringify({
      documentToken: state.documentToken,
      measurements: measurements.map((measurement) => [
        measurement.versionId,
        measurement.first!.positionMm,
        measurement.second!.positionMm,
        measurement.direction,
        measurement.normal,
        measurement.offsetMm.slice(0, 2),
        measurement.distanceMm,
      ]),
    });
    if (this.measurementOverlaySignature !== signature
      && (measurements.length > 0 || this.measurementOverlaySignature !== undefined)
      && this.runtime.isUncertain?.() !== true
      && typeof this.runtime.mutate === "function") {
      await this.runtime.mutate(`function (LineSegmentHelper, Vector3, Vector2, makeAxisAlignedMeasurementPath, args) {
        const nativeLabels = this.measurements.distanceLabels;
        for (const label of nativeLabels.labels.slice()) {
          nativeLabels.group.remove(label);
          label.element?.remove();
        }
        nativeLabels.labels.length = 0;
        nativeLabels.segments.clear();
        this.measurements.distanceSegments.clear();
        const managerKey = '__plasticityMcpDistanceOverlays';
        if (!(this[managerKey] instanceof Map)) Object.defineProperty(this, managerKey, { value: new Map(), configurable: true });
        const manager = this[managerKey];
        const managedLabels = new Set(Array.from(manager.values()).flatMap(tag => tag.labels ?? []));
        for (const label of document.querySelectorAll('[data-plasticity-mcp-distance]')) {
          if (!managedLabels.has(label)) label.remove();
        }
        const tagged = this.helpers.scene.children.filter(helper => helper.userData?.plasticityMcpMeasurementOverlay);
        const viewports = Array.from(this.viewports);
        const currentVersions = new Set(args.measurements.map(measurement => measurement.versionId));
        const overlayKey = (documentToken, versionId) => documentToken + ':' + versionId;
        const removeOverlay = (key, tag) => {
          if (tag.frameId !== undefined) cancelAnimationFrame(tag.frameId);
          for (const label of tag.labels ?? []) label.remove();
          for (const helper of tag.helpers ?? (tag.helper ? [tag.helper] : [])) {
            if (helper.parent) this.helpers.remove(helper);
          }
          manager.delete(key);
        };
        for (const helper of tagged) {
          const tag = helper.userData.plasticityMcpMeasurementOverlay;
          const key = overlayKey(tag.documentToken, tag.versionId);
          tag.helper = helper;
          tag.labels ??= [];
          if (!manager.has(key)) manager.set(key, tag);
        }
        for (const [key, tag] of Array.from(manager.entries())) {
          if (tag.documentToken !== args.documentToken || !currentVersions.has(tag.versionId)) removeOverlay(key, tag);
        }
        for (const measurement of args.measurements) {
          const key = overlayKey(args.documentToken, measurement.versionId);
          const previous = manager.get(key);
          if (previous) removeOverlay(key, previous);
          const first = new Vector3(...measurement.firstMm.map(value => value / 1000));
          const second = new Vector3(...measurement.secondMm.map(value => value / 1000));
          const direction = new Vector3(...measurement.direction);
          const normal = new Vector3(...measurement.normal);
          const offset = new Vector2(...measurement.offsetMm.map(value => value / 1000));
          let displayOffset = offset;
          if (offset.length() < 0.0005) {
            const extent = args.bodyBoundsMm
              .filter(body => body.bodyIds.includes(measurement.firstBodyId) || body.bodyIds.includes(measurement.secondBodyId))
              .map(body => body.boundsMm)
              .filter(Boolean);
            const bounds = extent.length ? {
              min: [0, 1, 2].map(axis => Math.min(...extent.map(value => value.min[axis]))),
              max: [0, 1, 2].map(axis => Math.max(...extent.map(value => value.max[axis]))),
            } : undefined;
            const step = Math.max(measurement.distanceMm * 0.08, 2);
            const maxSpan = bounds ? Math.max(...bounds.max.map((value, axis) => value - bounds.min[axis])) : 0;
            const distances = Array.from(new Set([step, maxSpan * 0.25, maxSpan * 0.5, maxSpan * 0.75, maxSpan, maxSpan + step].filter(value => value >= step))).sort((a, b) => a - b);
            const outsideDistance = point => bounds ? Math.hypot(...point.map((value, axis) => Math.max(bounds.min[axis] - value, 0, value - bounds.max[axis]))) : 0;
            let best;
            for (const distanceMm of distances) {
              for (const candidate of [[distanceMm, 0], [-distanceMm, 0], [0, distanceMm], [0, -distanceMm]]) {
                const candidatePath = makeAxisAlignedMeasurementPath(first, second, direction, normal, new Vector2(candidate[0] / 1000, candidate[1] / 1000));
                const startMm = candidatePath[1].toArray().map(value => value * 1000);
                const endMm = candidatePath[3].toArray().map(value => value * 1000);
                const clearance = Math.min(outsideDistance(startMm), outsideDistance(endMm));
                if (!best || clearance > best.clearance) best = { candidate, clearance, path: candidatePath };
                if (clearance > 0.01) {
                  displayOffset = new Vector2(candidate[0] / 1000, candidate[1] / 1000);
                  break;
                }
              }
              if (displayOffset !== offset) break;
            }
            if (displayOffset === offset && best && best.clearance > 0) {
              displayOffset = new Vector2(best.candidate[0] / 1000, best.candidate[1] / 1000);
            }
            if (displayOffset === offset) displayOffset = new Vector2(0, step / 1000);
          }
          const path = makeAxisAlignedMeasurementPath(first, second, direction, normal, displayOffset);
          const linePairs = [[path[0], path[1]], [path[1], path[3]], [path[3], path[4]]];
          const helpers = linePairs
            .filter(([start, end]) => start.distanceToSquared(end) > 1e-16)
            .map(([start, end]) => {
              const helper = new LineSegmentHelper(this);
              helper.p1.copy(start);
              helper.p2.copy(end);
              return helper;
            });
          const helper = helpers.find(candidate => candidate.p1.distanceToSquared(path[1]) < 1e-16
            && candidate.p2.distanceToSquared(path[3]) < 1e-16);
          const labelPoint = path[1].clone().add(path[3]).multiplyScalar(0.5);
          const labels = viewports.map(viewport => {
            const label = document.createElement('div');
            label.dataset.plasticityMcpDistance = String(measurement.versionId);
            label.textContent = measurement.distanceMm.toFixed(2) + ' mm';
            Object.assign(label.style, {
              position: 'absolute',
              zIndex: '30',
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
              transform: 'translate(-50%, -120%)',
              padding: '2px 6px',
              borderRadius: '4px',
              border: '1px solid rgba(183, 243, 151, 0.7)',
              color: '#eef4f0',
              background: 'rgba(10, 13, 16, 0.9)',
              font: '600 12px ui-sans-serif, system-ui, sans-serif',
              lineHeight: '16px',
            });
            viewport.container.append(label);
            return { viewport, label };
          });
          const tag = {
            documentToken: args.documentToken,
            versionId: measurement.versionId,
            helper,
            helpers,
            labels: labels.map(entry => entry.label),
            frameId: undefined,
          };
          helper.userData.plasticityMcpMeasurementOverlay = tag;
          for (const lineHelper of helpers) lineHelper.userData.plasticityMcpMeasurementOverlay = tag;
          manager.set(key, tag);
          for (const lineHelper of helpers) {
            this.helpers.add(lineHelper);
            lineHelper.render();
            lineHelper.line.material.color.setHex(0xb7f397);
            lineHelper.line.material.depthTest = false;
            lineHelper.line.material.depthWrite = false;
            lineHelper.line.material.linewidth = 2;
            lineHelper.line.renderOrder = 1000;
            lineHelper.line.material.needsUpdate = true;
          }
          const updateLabels = () => {
            if (manager.get(key) !== tag) {
              for (const entry of labels) entry.label.remove();
              return;
            }
            for (const { viewport, label } of labels) {
              const camera = viewport.camera;
              camera.updateMatrixWorld(true);
              const point = labelPoint.clone().project(camera);
              const width = viewport.container.clientWidth;
              const height = viewport.container.clientHeight;
              const visible = width > 0 && height > 0 && point.z >= -1 && point.z <= 1
                && point.x >= -1 && point.x <= 1 && point.y >= -1 && point.y <= 1;
              label.style.display = visible ? 'block' : 'none';
              if (visible) {
                label.style.left = ((point.x + 1) * width / 2) + 'px';
                label.style.top = ((1 - point.y) * height / 2) + 'px';
              }
            }
            tag.frameId = requestAnimationFrame(updateLabels);
          };
          updateLabels();
        }
        for (const viewport of viewports) viewport.setNeedsRender();
      }`, ["LineSegmentHelper", "Vector3", "Vector2", "makeAxisAlignedMeasurementPath"], [{
        documentToken: state.documentToken,
          measurements: measurements.map((measurement) => ({
            versionId: measurement.versionId,
            firstMm: measurement.first!.positionMm!,
            secondMm: measurement.second!.positionMm!,
            firstBodyId: measurement.first!.bodyId,
            secondBodyId: measurement.second!.bodyId,
            direction: measurement.direction!,
            normal: measurement.normal!,
            offsetMm: measurement.offsetMm.slice(0, 2),
            distanceMm: measurement.distanceMm!,
          })),
        bodyBoundsMm: state.bodies.flatMap(body => body.boundsMm ? [{ bodyIds: [body.id], boundsMm: body.boundsMm }] : []),
      }]);
      this.measurementOverlaySignature = signature;
    }
    return state;
  }

  async measurePointDistance(first: MeasurementPointReference, second: MeasurementPointReference, revision: string) {
    return measurePointDistance(await this.state(), first, second, revision);
  }

  async measurePointToLinearEdge(point: MeasurementPointReference, edge: EdgeReference, revision: string) {
    return measurePointToLinearEdge(await this.state(), point, edge, revision);
  }

  async measurePointToSampledCurveEdge(
    point: MeasurementPointReference,
    edgeReference: EdgeReference | WireSegmentReference,
    revision: string,
    requestedToleranceMm = 0.01,
    maxSegments = 2048,
  ) {
    const before = await this.assertRevision(revision);
    if (!Number.isFinite(requestedToleranceMm) || requestedToleranceMm <= 0) throw new Error("Curve approximation tolerance must be positive and finite");
    if (!Number.isInteger(maxSegments) || maxSegments < 64 || maxSegments > 8192) throw new Error("Curve approximation maxSegments must be an integer from 64 to 8192");
    const body = before.bodies.find((candidate) => candidate.id === edgeReference.bodyId);
    let expectedCurveType: string | undefined;
    if ("edgeId" in edgeReference) {
      const edge = body?.edges.find((candidate) => candidate.id === edgeReference.edgeId);
      if (!edge) throw new Error(`Unknown current B-Rep edge: ${edgeReference.bodyId}:${edgeReference.edgeId}`);
      if (edge.line || edge.circle) throw new Error("Sampled curved-edge measurement only accepts non-linear, non-circular B-Rep edges; use the exact line or circle measurement tool");
      expectedCurveType = edge.curveType;
    } else {
      if (body?.type !== "Wire") throw new Error(`Curved Wire segment reference requires a current Wire body: ${edgeReference.bodyId}`);
      if (!Number.isInteger(edgeReference.segmentEntityId) || edgeReference.segmentEntityId <= 0) throw new Error("Wire segment entity ID must be a positive integer");
    }

    const sampled = await this.runtime.readNative<{
      curveType: string;
      lengthMm: number;
      isLine: boolean;
      isCircle: boolean;
      samples: Array<{ normalizedParameter: number; positionMm: [number, number, number] }>;
      maxObservedChordDeviationMm: number;
    }>(`function (args) {
      const mm = value => value * 1000;
      const vector = value => [mm(value.x), mm(value.y), mm(value.z)];
      const pointSegmentDistance = (point, first, second) => {
        const dx = second.x - first.x, dy = second.y - first.y, dz = second.z - first.z;
        const length2 = dx * dx + dy * dy + dz * dz;
        const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - first.x) * dx + (point.y - first.y) * dy + (point.z - first.z) * dz) / length2));
        return Math.hypot(point.x - (first.x + dx * t), point.y - (first.y + dy * t), point.z - (first.z + dz * t));
      };
      let item;
      for (const [versionId, candidate] of this.geo.geometryModel) {
        if (this.db.lookupStableId(versionId) === args.reference.bodyId) { item = candidate; break; }
      }
      if (!item) throw new Error('Curved-edge body is no longer current: ' + args.reference.bodyId);
      let nativeEdge;
      if (args.reference.kind === 'wire-segment') {
        if (item.view?.constructor?.name !== 'Wire') throw new Error('Curved segment source is no longer a Wire: ' + args.reference.bodyId);
        for (const segmentView of Array.from(item.view.segments ?? [])) {
          const candidate = this.db.lookupTopologyItem(segmentView);
          if (Number(candidate?.Id?.()) === args.reference.segmentEntityId) { nativeEdge = candidate; break; }
        }
        if (!nativeEdge) throw new Error('Stale or unknown Wire segment: ' + args.reference.bodyId + ':' + args.reference.segmentEntityId);
      } else {
        if (!['Solid', 'Sheet'].includes(item.view?.constructor?.name)) throw new Error('Curved-edge measurement requires a current Solid or Sheet');
        const edgeViews = item.view.high?.edges;
        if (!edgeViews) throw new Error('Native B-Rep edge views are unavailable');
        const viewIndex = edgeViews.versionIds.indexOf(args.reference.edgeId);
        const edgeView = viewIndex >= 0 ? edgeViews.get(viewIndex) : null;
        if (!edgeView) throw new Error('Stale or unknown B-Rep edge: ' + args.reference.bodyId + ':' + args.reference.edgeId);
        const modelEdges = item.model?.GetEdges?.();
        for (let index = 0; index < (modelEdges?.Size?.() ?? 0); index++) {
          const candidate = modelEdges.Get(index);
          if (candidate.Id() === edgeView.entityId) { nativeEdge = candidate; break; }
        }
        if (!nativeEdge) throw new Error('Native B-Rep edge entity is unavailable');
      }
      const wrappedCurve = nativeEdge.GetCurve();
      const curve = wrappedCurve?.curve ?? wrappedCurve;
      const curveType = String(curve?.constructor?.name ?? 'Unknown');
      const nativeLength = nativeEdge.FindLength();
      const lengthMm = mm(typeof nativeLength === 'number' ? nativeLength : nativeLength?.length);
      if (!Number.isFinite(lengthMm) || lengthMm <= 0) throw new Error('Native curved-edge length is unavailable');
      const isLine = typeof nativeEdge.IsLine === 'function' ? Boolean(nativeEdge.IsLine()) : /line/i.test(curveType);
      const isCircle = typeof nativeEdge.IsCircle === 'function' && Boolean(nativeEdge.IsCircle());
      let segmentCount = 64;
      let maxObservedChordDeviationMm = 0;
      let samples = [];
      for (;;) {
        const nativePoints = Array.from({ length: segmentCount + 1 }, (_unused, index) => nativeEdge.GetPointAndTangent(index / segmentCount).position);
        maxObservedChordDeviationMm = 0;
        for (let index = 0; index < segmentCount; index++) {
          const midpoint = nativeEdge.GetPointAndTangent((index + 0.5) / segmentCount).position;
          maxObservedChordDeviationMm = Math.max(maxObservedChordDeviationMm, mm(pointSegmentDistance(midpoint, nativePoints[index], nativePoints[index + 1])));
        }
        samples = nativePoints.map((position, index) => ({ normalizedParameter: index / segmentCount, positionMm: vector(position) }));
        if (maxObservedChordDeviationMm <= args.requestedToleranceMm || segmentCount >= args.maxSegments) break;
        segmentCount = Math.min(segmentCount * 2, args.maxSegments);
      }
      return { curveType, lengthMm, isLine, isCircle, samples, maxObservedChordDeviationMm };
    }`, [], [{ reference: "edgeId" in edgeReference
      ? { kind: "brep-edge", bodyId: edgeReference.bodyId, edgeId: edgeReference.edgeId }
      : { kind: "wire-segment", bodyId: edgeReference.bodyId, segmentEntityId: edgeReference.segmentEntityId }, requestedToleranceMm, maxSegments }]);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while the curved-edge distance was being measured");
    }
    if (expectedCurveType !== undefined && expectedCurveType !== sampled.curveType) throw new Error("Native curved-edge type no longer matches the current edge reference");
    if (sampled.isLine || sampled.isCircle) throw new Error("Sampled curved-edge measurement only accepts non-linear, non-circular B-Rep edges; use the exact line or circle measurement tool");
    return measurePointToSampledCurveEdge(after, point, edgeReference, revision, sampled.samples, {
      requestedToleranceMm,
      maxObservedChordDeviationMm: sampled.maxObservedChordDeviationMm,
    }, "edgeId" in edgeReference ? undefined : {
      bodyId: edgeReference.bodyId,
      segmentEntityId: edgeReference.segmentEntityId,
      curveType: sampled.curveType,
      lengthMm: sampled.lengthMm,
      linear: sampled.isLine,
      circular: sampled.isCircle,
    });
  }

  async measurePointToCircularEdge(point: MeasurementPointReference, edge: EdgeReference | WireSegmentReference, revision: string) {
    const state = await this.state();
    if ("edgeId" in edge) return measurePointToCircularEdge(state, point, edge, revision);
    const inventory = await this.listCurveDirections();
    if (inventory.revision !== revision || inventory.documentToken !== state.documentToken) throw new Error("Circular Wire segment reference is stale");
    const curve = inventory.curves.find((candidate) => candidate.id === edge.bodyId);
    const segment = curve?.segments.find((candidate) => candidate.entityId === edge.segmentEntityId);
    if (!segment?.circleGeometry) throw new Error("Measurement Wire segment requires exact native circular B-Rep geometry");
    const geometry: NativeWireCircularSegment = {
      segmentEntityId: segment.entityId,
      lengthMm: segment.lengthMm,
      circleGeometry: segment.circleGeometry,
    };
    return measurePointToCircularEdge(state, point, edge, revision, geometry);
  }

  async measurePointToPlanarFace(point: MeasurementPointReference, face: FaceReference, revision: string) {
    return measurePointToPlanarFace(await this.state(), point, face, revision);
  }

  async measurePlanarFaces(first: FaceReference, second: FaceReference, revision: string, angularToleranceDeg = 0.01) {
    return measurePlanarFaces(await this.state(), first, second, revision, angularToleranceDeg);
  }

  async measureParallelPlanarFaceClearance(first: FaceReference, second: FaceReference, revision: string) {
    return measureParallelPlanarFaceClearance(await this.state(), first, second, revision);
  }

  async measureNonparallelPlanarPolygonFaceClearance(first: FaceReference, second: FaceReference, revision: string) {
    return measureNonparallelPlanarPolygonFaceClearance(await this.state(), first, second, revision);
  }

  async measureLinearEdges(first: EdgeReference, second: EdgeReference, revision: string, angularToleranceDeg = 0.01) {
    return measureLinearEdges(await this.state(), first, second, revision, angularToleranceDeg);
  }

  async measureFastenerGripStack(layers: FastenerGripLayerReference[], axis: Vector3, revision: string, angularToleranceDeg = 0.01) {
    return measureFastenerGripStack(await this.state(), layers, axis, revision, angularToleranceDeg);
  }

  async analyzeEdgeCurvature(edges: CurvatureEdgeReference[], revision: string) {
    const state = await this.assertRevision(revision);
    if (edges.length === 0) throw new Error("At least one edge is required for curvature analysis");
    const keys = edges.map((edge) => "edgeId" in edge ? `${edge.bodyId}:shell:${edge.edgeId}` : `${edge.bodyId}:wire:${edge.segmentEntityId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Curvature edge references must be unique");
    const bodyVersions = new Map<number, number>();
    for (const reference of edges) {
      const body = state.bodies.find((candidate) => candidate.id === reference.bodyId);
      if (!body || !["Wire", "Solid", "Sheet"].includes(body.type)) {
        throw new Error(`Unknown current Wire, Solid, or Sheet body ID: ${reference.bodyId}`);
      }
      if (body.type === "Wire") {
        if (!("segmentEntityId" in reference)) {
          throw new Error(`Wire curvature reference ${reference.bodyId} requires a native segmentEntityId`);
        }
      } else {
        if (!("edgeId" in reference) || !body.edges.some((candidate) => candidate.id === reference.edgeId)) {
          throw new Error(`Unknown current edge ID ${"edgeId" in reference ? reference.edgeId : "(missing)"} on body ${reference.bodyId}`);
        }
      }
      bodyVersions.set(body.id, body.versionId);
    }
    const analyses = await this.runtime.readNative(`async function (evalCurvatureMeasurements, Measurement, Target, Landmark, args) {
      const selected = args.edges.map(reference => {
        let item;
        for (const [versionId, candidate] of this.geo.geometryModel) {
          if (this.db.lookupStableId(versionId) === reference.bodyId) { item = candidate; break; }
        }
        if (!item || !['Wire', 'Solid', 'Sheet'].includes(item.view?.constructor?.name)) {
          throw new Error('Unknown current Wire, Solid, or Sheet body ID: ' + reference.bodyId);
        }
        let entityId;
        if (item.view.constructor.name === 'Wire') {
          if (!Number.isInteger(reference.segmentEntityId)) throw new Error('Wire curvature reference requires a native segmentEntityId');
          const modelEdges = item.model?.GetEdges?.();
          for (let index = 0; index < (modelEdges?.Size?.() ?? 0); index += 1) {
            const modelEdge = modelEdges.Get(index);
            if (Number(modelEdge.Id()) === reference.segmentEntityId) { entityId = reference.segmentEntityId; break; }
          }
          if (!Number.isInteger(entityId)) throw new Error('Stale or unknown Wire segment: ' + reference.bodyId + ':' + reference.segmentEntityId);
        } else {
          const edgeIndex = item.view.high.edges.versionIds.indexOf(reference.edgeId);
          if (edgeIndex < 0) throw new Error('Stale or unknown shell edge: ' + reference.edgeId);
          entityId = Number(item.view.high.edges.get(edgeIndex).entityId);
        }
        return {
          reference,
          bodyVersionId: args.bodyVersions.find(candidate => candidate.bodyId === reference.bodyId)?.versionId,
          modelBodyId: Number(item.model.Id()),
          entityId,
        };
      });
      const measurements = selected.map(candidate => {
        const measurement = new Measurement();
        measurement.target = new Target(Landmark.Edge, candidate.entityId, candidate.modelBodyId);
        measurement.tmin = 0;
        measurement.tmax = 1;
        return measurement;
      });
      const evaluated = await evalCurvatureMeasurements(measurements, [], this.analyzer, undefined, undefined);
      if (evaluated.measurements.length !== selected.length || evaluated.views.length !== selected.length) {
        throw new Error('Plasticity curvature measurements and views are inconsistent');
      }
      const zeroTolerancePerMm = 1e-12;
      return selected.map((candidate, index) => {
        const view = evaluated.views[index];
        const edgeIds = Array.from(view.edgeIds ?? [], Number);
        const analysisIndex = edgeIds.findIndex(edgeId => edgeId === candidate.entityId);
        if (analysisIndex < 0 || !view.analyses?.[analysisIndex]) {
          throw new Error('Plasticity returned curvature data for an unexpected edge');
        }
        const analysis = view.analyses[analysisIndex];
        const spikes = Array.from(analysis.spikes ?? [], Number);
        if (spikes.length === 0 || spikes.length % 6 !== 0) {
          throw new Error('Plasticity returned malformed curvature samples');
        }
        const samples = [];
        for (let offset = 0; offset < spikes.length; offset += 6) {
          const positionMm = [spikes[offset] * 1000, spikes[offset + 1] * 1000, spikes[offset + 2] * 1000];
          const vectorPerMm = [spikes[offset + 3] / 1000, spikes[offset + 4] / 1000, spikes[offset + 5] / 1000];
          const curvaturePerMm = Math.hypot(...vectorPerMm);
          if (![...positionMm, ...vectorPerMm, curvaturePerMm].every(Number.isFinite)) {
            throw new Error('Plasticity returned a non-finite curvature sample');
          }
          samples.push({ positionMm, vectorPerMm, curvaturePerMm });
        }
        let minimum = samples[0];
        let maximum = samples[0];
        let sum = 0;
        let minimumPositive = Infinity;
        let containsZeroCurvature = false;
        for (const sample of samples) {
          if (sample.curvaturePerMm < minimum.curvaturePerMm) minimum = sample;
          if (sample.curvaturePerMm > maximum.curvaturePerMm) maximum = sample;
          sum += sample.curvaturePerMm;
          if (sample.curvaturePerMm <= zeroTolerancePerMm) containsZeroCurvature = true;
          else minimumPositive = Math.min(minimumPositive, sample.curvaturePerMm);
        }
        return {
          edge: candidate.reference,
          bodyVersionId: candidate.bodyVersionId,
          measurementSource: 'native-brep-100-samples',
          sampleCount: samples.length,
          minimumCurvaturePerMm: minimum.curvaturePerMm,
          maximumCurvaturePerMm: maximum.curvaturePerMm,
          meanCurvaturePerMm: sum / samples.length,
          minimumCurvatureAtMm: minimum.positionMm,
          maximumCurvatureAtMm: maximum.positionMm,
          maximumCurvatureVectorPerMm: maximum.vectorPerMm,
          minimumRadiusOfCurvatureMm: maximum.curvaturePerMm > zeroTolerancePerMm ? 1 / maximum.curvaturePerMm : null,
          maximumFiniteRadiusOfCurvatureMm: Number.isFinite(minimumPositive) ? 1 / minimumPositive : null,
          containsZeroCurvature,
        };
      });
    }`, ["evalCurvatureMeasurements", "CurvatureMeasurement", "Target", "TopologyLandmark"], [{
      edges,
      bodyVersions: [...bodyVersions].map(([bodyId, versionId]) => ({ bodyId, versionId })),
    }]);
    return { documentToken: state.documentToken, revision: state.revision, analyses };
  }

  async analyzeFaceDraft(
    faces: FaceReference[],
    pullDirection: Vector3,
    minimumDraftDeg: number,
    samplesPerDirection: number,
    revision: string,
  ): Promise<{
    documentToken: string;
    revision: string;
    pullDirection: Vector3;
    minimumDraftDeg: number;
    samplesPerDirection: number;
    analyses: FaceDraftAnalysis[];
    limitation: string;
  }> {
    const before = await this.assertRevision(revision);
    requireTopologySelection(before, faces, "face");
    const invalidBodies = [...new Set(faces.map((reference) => reference.bodyId))].filter((bodyId) => {
      const type = before.bodies.find((body) => body.id === bodyId)?.type;
      return type !== "Solid" && type !== "Sheet";
    });
    if (invalidBodies.length > 0) throw new Error(`Face draft analysis requires current Solid or Sheet bodies: ${invalidBodies.join(", ")}`);
    if (!Number.isFinite(minimumDraftDeg) || minimumDraftDeg <= 0 || minimumDraftDeg >= 90) {
      throw new Error("Minimum draft angle must be greater than 0 and less than 90 degrees");
    }
    if (!Number.isInteger(samplesPerDirection) || samplesPerDirection < 3 || samplesPerDirection > 32) {
      throw new Error("Draft samples per direction must be an integer from 3 through 32");
    }
    const unitPullDirection = normalize(pullDirection, "Draft pull direction");
    const bodyVersions = new Map(before.bodies.map((body) => [body.id, body.versionId]));
    const native = await this.runtime.readNative<NativeFaceDraftSamples[]>(`function (args) {
      const mm = value => value * 1000;
      const vectorMm = value => [mm(value.x), mm(value.y), mm(value.z)];
      const direction = value => [Number(value.x), Number(value.y), Number(value.z)];
      const result = [];
      for (const reference of args.faces) {
        let found;
        for (const [versionId, item] of this.geo.geometryModel) {
          if (this.db.lookupStableId(versionId) === reference.bodyId) { found = [versionId, item]; break; }
        }
        if (!found || !['Solid', 'Sheet'].includes(found[1].view?.constructor?.name)) {
          throw new Error('Unknown current draft-analysis body ID: ' + reference.bodyId);
        }
        const [versionId, item] = found;
        const faceViews = item.view.high.faces;
        const viewIndex = faceViews.versionIds.indexOf(reference.faceId);
        if (viewIndex < 0) throw new Error('Unknown current draft-analysis face: ' + reference.bodyId + ':' + reference.faceId);
        const entityId = Number(faceViews.get(viewIndex).entityId);
        const nativeFaces = item.model.GetFaces();
        let face;
        for (let index = 0; index < nativeFaces.Size(); index += 1) {
          const candidate = nativeFaces.Get(index);
          if (Number(candidate.Id()) === entityId) { face = candidate; break; }
        }
        if (!face) throw new Error('Native draft-analysis face is unavailable: ' + reference.bodyId + ':' + reference.faceId);
        const grid = Array.from(face.EvalGrid(args.samplesPerDirection, args.samplesPerDirection), Number);
        if (grid.length === 0 || grid.length % 3 !== 0 || !grid.every(Number.isFinite)) {
          throw new Error('Plasticity returned malformed native face samples');
        }
        const seed = face.FindUVMidpoint();
        const NativeVector = seed?.position?.constructor;
        if (typeof NativeVector !== 'function') throw new Error('Plasticity native Vector constructor is unavailable');
        const samples = [];
        for (let offset = 0; offset < grid.length; offset += 3) {
          const requested = new NativeVector(grid[offset], grid[offset + 1], grid[offset + 2]);
          const uv = face.FindPointNear(requested);
          const evaluated = face.EvalNormal(uv.u, uv.v);
          const positionMm = vectorMm(evaluated.position);
          const normal = direction(evaluated.normal);
          if (![...positionMm, ...normal].every(Number.isFinite)) {
            throw new Error('Plasticity returned non-finite native face-normal data');
          }
          samples.push({ positionMm, normal });
        }
        result.push({
          face: reference,
          bodyVersionId: Number(versionId),
          surfaceType: String(face.GetSurface()?.surface?.constructor?.name ?? 'Unknown'),
          samples,
        });
      }
      return result;
    }`, [], [{ faces, samplesPerDirection }]);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed during native face draft analysis");
    }
    if (native.length !== faces.length) throw new Error("Native face draft result count does not match the request");
    const analyses = native.map((entry, index) => {
      const reference = faces[index]!;
      if (entry.face.bodyId !== reference.bodyId || entry.face.faceId !== reference.faceId || entry.bodyVersionId !== bodyVersions.get(reference.bodyId)) {
        throw new Error(`Native face draft identity mismatch for ${reference.bodyId}:${reference.faceId}`);
      }
      return summarizeFaceDraftSamples(entry, unitPullDirection, minimumDraftDeg);
    });
    return {
      documentToken: after.documentToken,
      revision: after.revision,
      pullDirection: unitPullDirection,
      minimumDraftDeg,
      samplesPerDirection,
      analyses,
      limitation: "Native B-Rep normals are evaluated at a finite grid of interior face points; extrema between samples, mold parting, release paths, and print support requirements are not proven.",
    };
  }

  async analyzeSurfaceContinuity(
    edges: EdgeReference[],
    revision: string,
    positionToleranceMm = 0.01,
    normalAngleToleranceDeg = 0.1,
    relativeCurvatureTolerance = 0.05,
  ) {
    const state = await this.assertRevision(revision);
    if (edges.length === 0) throw new Error("At least one edge is required for surface continuity analysis");
    const keys = edges.map((edge) => `${edge.bodyId}:${edge.edgeId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Surface continuity edge references must be unique");
    requirePositiveFinite(positionToleranceMm, "Position tolerance");
    requirePositiveFinite(normalAngleToleranceDeg, "Normal angle tolerance");
    requirePositiveFinite(relativeCurvatureTolerance, "Relative curvature tolerance");
    const bodyVersions = new Map<number, number>();
    for (const reference of edges) {
      const body = state.bodies.find((candidate) => candidate.id === reference.bodyId);
      if (!body || (body.type !== "Solid" && body.type !== "Sheet")) {
        throw new Error(`Unknown current Solid or Sheet body ID: ${reference.bodyId}`);
      }
      const edge = body.edges.find((candidate) => candidate.id === reference.edgeId);
      if (!edge) throw new Error(`Unknown current edge ID ${reference.edgeId} on body ${reference.bodyId}`);
      if (edge.faceIds.length !== 2) {
        throw new Error(`Surface continuity edge ${reference.edgeId} on body ${reference.bodyId} must have exactly two adjacent faces`);
      }
      bodyVersions.set(body.id, body.versionId);
    }
    const tolerances = {
      positionMm: positionToleranceMm,
      normalAngleDeg: normalAngleToleranceDeg,
      relativeCurvature: relativeCurvatureTolerance,
    };
    const analyses = await this.runtime.readNative(`async function (Factory, ContinuityType, evalSurfaceContinuityMeasurements, Refresh, args) {
      const selected = args.edges.map(reference => {
        let item;
        for (const [versionId, candidate] of this.geo.geometryModel) {
          if (this.db.lookupStableId(versionId) === reference.bodyId) { item = candidate; break; }
        }
        if (!item || !['Solid', 'Sheet'].includes(item.view?.constructor?.name)) {
          throw new Error('Unknown current Solid or Sheet body ID: ' + reference.bodyId);
        }
        const edgeIndex = item.view.high.edges.versionIds.indexOf(reference.edgeId);
        if (edgeIndex < 0) throw new Error('Stale or unknown edge: ' + reference.edgeId);
        const edge = item.view.high.edges.get(edgeIndex);
        const faceId = topologyId => {
          for (let index = 0; index < item.view.high.faces.versionIds.length; index += 1) {
            const face = item.view.high.faces.get(index);
            if (Number(face.entityId) === Number(topologyId)) return item.view.high.faces.versionIds[index];
          }
          return null;
        };
        return {
          reference,
          bodyVersionId: args.bodyVersions.find(candidate => candidate.bodyId === reference.bodyId)?.versionId,
          modelBodyId: Number(item.model.Id()),
          entityId: Number(edge.entityId),
          edge,
          faceId,
        };
      });
      const factory = new Factory(this);
      factory.g0Tolerance = args.tolerances.positionMm / 1000;
      factory.g1ToleranceDegrees = args.tolerances.normalAngleDeg;
      factory.g2Tolerance = args.tolerances.relativeCurvature;
      factory.continuity = ContinuityType.G2;
      factory.edges = selected.map(candidate => candidate.edge);
      const measurements = await factory.calculate();
      const evaluated = await evalSurfaceContinuityMeasurements(measurements, [], this.analyzer, undefined, undefined);
      if (evaluated.measurements.length !== evaluated.views.length) {
        throw new Error('Plasticity continuity measurements and views are inconsistent');
      }
      const vectorMm = value => [Number(value.x) * 1000, Number(value.y) * 1000, Number(value.z) * 1000];
      return evaluated.measurements.map((measurement, index) => {
        const view = evaluated.views[index];
        const selectedEdge = selected.find(candidate =>
          candidate.modelBodyId === Number(measurement.referenceEdge?.bodyId)
          && candidate.entityId === Number(measurement.referenceEdge?.topologyId));
        if (!selectedEdge) throw new Error('Plasticity returned continuity data for an unexpected edge');
        const firstFaceId = selectedEdge.faceId(measurement.referenceFace?.topologyId);
        const secondFaceId = selectedEdge.faceId(measurement.targetFace?.topologyId);
        if (!firstFaceId || !secondFaceId) throw new Error('Plasticity returned an unknown adjacent face');
        const maximumPositionDeviationMm = Number(view.g0max) * 1000;
        const maximumNormalAngleDeviationDeg = Number(view.g1max) * 180 / Math.PI;
        const maximumRelativeCurvatureDeviation = Number(view.g2max);
        if (![maximumPositionDeviationMm, maximumNormalAngleDeviationDeg, maximumRelativeCurvatureDeviation].every(Number.isFinite)) {
          throw new Error('Plasticity returned a non-finite continuity deviation');
        }
        const G0 = maximumPositionDeviationMm <= args.tolerances.positionMm;
        const G1 = G0 && maximumNormalAngleDeviationDeg <= args.tolerances.normalAngleDeg;
        const G2 = G1 && maximumRelativeCurvatureDeviation <= args.tolerances.relativeCurvature;
        return {
          edge: selectedEdge.reference,
          adjacentFaces: [
            { bodyId: selectedEdge.reference.bodyId, faceId: firstFaceId },
            { bodyId: selectedEdge.reference.bodyId, faceId: secondFaceId },
          ],
          bodyVersionId: selectedEdge.bodyVersionId,
          measurementSource: 'native-brep-100-samples',
          sampleCount: Number(Refresh.Samples),
          maximumPositionDeviationMm,
          maximumPositionDeviationAtMm: vectorMm(view.g0maxBase),
          maximumNormalAngleDeviationDeg,
          maximumNormalAngleDeviationAtMm: vectorMm(view.g1maxBase),
          maximumRelativeCurvatureDeviation,
          maximumRelativeCurvatureDeviationAtMm: vectorMm(view.g2maxBase),
          tolerances: args.tolerances,
          passes: { G0, G1, G2 },
          achievedContinuity: G2 ? 'G2' : G1 ? 'G1' : G0 ? 'G0' : 'discontinuous',
        };
      });
    }`, ["MeasureContinuityFactory", "ContinuityType", "evalSurfaceContinuityMeasurements", "EvalSurfaceContinuityMeasurements_refresh"], [{
      edges,
      tolerances,
      bodyVersions: [...bodyVersions].map(([bodyId, versionId]) => ({ bodyId, versionId })),
    }]);
    return { documentToken: state.documentToken, revision: state.revision, analyses };
  }

  async listMeasurements(): Promise<{
    documentToken: string;
    revision: string;
    measurements: NonNullable<RuntimeState["measurements"]>;
  }> {
    const state = await this.state();
    return { documentToken: state.documentToken, revision: state.revision, measurements: state.measurements ?? [] };
  }

  async listSectionAnalyses(): Promise<{
    documentToken: string;
    revision: string;
    sectionAnalyses: NonNullable<RuntimeState["sectionAnalyses"]>;
  }> {
    const state = await this.state();
    return { documentToken: state.documentToken, revision: state.revision, sectionAnalyses: state.sectionAnalyses ?? [] };
  }

  async createSectionAnalysis(
    originMm: Vector3,
    normal: Vector3,
    xDirection: Vector3 | undefined,
    name: string | undefined,
    revision: string,
  ): Promise<RuntimeState> {
    const current = await this.assertRevision(revision);
    const unitNormal = normalize(normal, "Section analysis normal");
    const preferredX = xDirection ?? leastParallelWorldAxis(unitNormal);
    const frame = frameFromOriginNormalX(originMm, unitNormal, preferredX);
    if ((current.sectionAnalyses ?? []).length > 0) {
      throw new Error("Plasticity already has an active section analysis; delete it before creating another");
    }
    await this.runtime.mutate(`function (SectionAnalysisFactory, Vector3, Matrix4, args) {
      const viewports = Array.from(this.viewports ?? []);
      if (viewports.length === 0 || !this.shading) throw new Error('Plasticity does not expose a usable section-analysis viewport');
      if (this.shading.isSectioned) throw new Error('Plasticity already has an active section analysis; delete it before creating another');
      const section = new SectionAnalysisFactory(this).section;
      const point = new Vector3(...args.point);
      const normal = new Vector3(...args.normal).negate().normalize();
      section.position.copy(point);
      section.originalPosition.copy(point);
      section.plane.setFromNormalAndCoplanarPoint(normal, point);
      section.originalPlane.copy(section.plane);
      section.name = args.name ?? '';
      section.visible = true;
      section.helper.worldPosition.copy(point);
      if (args.xDirection) {
        const x = new Vector3(...args.xDirection).addScaledVector(normal, -new Vector3(...args.xDirection).dot(normal)).normalize();
        const y = new Vector3().crossVectors(normal, x).normalize();
        section.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(normal, x, y));
      }
      section.updateMatrixWorld(true);
      this.shading.section = section;
      for (const viewport of viewports) viewport.setNeedsRender();
      return section.versionId;
    }`, ["SectionAnalysisFactory", "Vector3", "Matrix4"], [{
      point: frame.originMm.map(millimetersToMeters),
      normal: frame.normal,
      xDirection: frame.xDirection,
      name: name ?? null,
    }]);
    return await this.state();
  }

  async deleteSectionAnalysis(id: number, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (!(state.sectionAnalyses ?? []).some((section) => section.id === id)) {
      throw new Error(`Unknown current section analysis ID: ${id}`);
    }
    await this.runtime.mutate(`function (args) {
      const active = this.shading?.section;
      if (!active || Number(active.versionId) !== args.id) throw new Error('Unknown active section analysis ID: ' + args.id);
      this.shading.section = null;
      for (const viewport of this.viewports ?? []) viewport.setNeedsRender();
    }`, [], [{ id }]);
    return await this.state();
  }

  async createVertexDistanceMeasurement(
    first: VertexReference,
    second: VertexReference,
    name: string | undefined,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireVertexReference(state, first, "first");
    requireVertexReference(state, second, "second");
    if (first.bodyId === second.bodyId && first.vertexId === second.vertexId) {
      throw new Error("Distance measurement vertices must be different");
    }
    await this.runtime.mutate(`async function (Factory, args) {
      const editor = this;
      const wanted = new Map(args.vertices.map(reference => [reference.bodyId + ':' + reference.vertexId, reference]));
      const matches = new Map();
      for (const entry of this.snaps.cache.entries ?? []) {
        for (let index = 0; index < (entry.positions?.length ?? 0) / 3; index += 1) {
          const snap = entry.lookup(index);
          if (snap?.constructor?.name !== 'Snaps_ShellVertexSnap') continue;
          const bodyId = this.db.lookupStableId(snap.item?.versionId);
          const vertexId = snap.model?.Id?.();
          const key = bodyId + ':' + vertexId;
          if (wanted.has(key) && !matches.has(key)) matches.set(key, snap);
        }
      }
      const snaps = args.vertices.map(reference => matches.get(reference.bodyId + ':' + reference.vertexId));
      if (snaps.some(snap => !snap)) throw new Error('Plasticity vertex snaps are unavailable for the requested measurement');
      let failure;
      const command = new this.commands.MeasureDistanceCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor);
          factory.p1(snaps[0].position, snaps[0]);
          factory.p2(snaps[1].position, snaps[1]);
          const measurement = await factory.calculate();
          if (args.name) measurement.userData.name = args.name;
          await editor.measurements.update([measurement], [], []);
          for (const viewport of editor.viewports ?? []) viewport.setNeedsRender();
          return measurement;
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["PointToPointMeasurementFactory"], [{ vertices: [first, second], name: name ?? null }]);
    return await this.state();
  }

  async createTopologyDistanceMeasurement(
    first: TopologyMeasurementPointReference,
    second: TopologyMeasurementPointReference,
    name: string | undefined,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    for (const [index, reference] of [first, second].entries()) {
      const body = state.bodies.find((candidate) => candidate.id === reference.bodyId);
      if (!body || !["Solid", "Sheet"].includes(body.type)) {
        throw new Error(`Topology distance point ${index + 1} requires a current Solid or Sheet body: ${reference.bodyId}`);
      }
    }
    const measured = measurePointDistance(state, first, second, revision);
    if (measured.distanceMm <= 1e-9) throw new Error("Distance measurement topology points must be different");
    await this.runtime.mutate(`async function (Factory, args) {
      const editor = this;
      const findItem = bodyId => {
        for (const [versionId, item] of editor.geo.geometryModel) {
          if (editor.db.lookupStableId(versionId) === bodyId) return item;
        }
        throw new Error('Unknown current body ID: ' + bodyId);
      };
      const entityId = (reference, item) => {
        if (reference.type === 'vertex') return reference.vertexId;
        const collection = reference.type === 'edge-midpoint' ? item.view?.high?.edges : item.view?.high?.faces;
        const stableId = reference.type === 'edge-midpoint' ? reference.edgeId : reference.faceId;
        const index = collection?.versionIds?.indexOf(stableId) ?? -1;
        if (index < 0) throw new Error('Stale or unknown topology reference: ' + stableId);
        return Number(collection.get(index).entityId);
      };
      const wanted = args.points.map(reference => {
        const item = findItem(reference.bodyId);
        return { reference, entityId: entityId(reference, item) };
      });
      const snaps = wanted.map(({ reference, entityId }) => {
        for (const entry of editor.snaps.cache.entries ?? []) {
          for (let index = 0; index < (entry.positions?.length ?? 0) / 3; index += 1) {
            const candidate = entry.lookup(index);
            if (editor.db.lookupStableId(candidate?.item?.versionId) !== reference.bodyId) continue;
            if (reference.type === 'vertex'
              && candidate?.constructor?.name === 'Snaps_ShellVertexSnap'
              && Number(candidate.model?.Id?.()) === entityId) return candidate;
            if (reference.type === 'edge-midpoint'
              && candidate?.constructor?.name === 'EdgePointSnap'
              && Number(candidate.model?.Id?.()) === entityId) return candidate;
            if (reference.type === 'face-center'
              && candidate?.constructor?.name === 'Snaps_FaceCenterPointSnap'
              && Number(candidate.faceSnap?.model?.Id?.()) === entityId) return candidate;
          }
        }
        throw new Error('Plasticity topology snap is unavailable for ' + reference.type + ' on body ' + reference.bodyId);
      });
      let failure;
      const command = new this.commands.MeasureDistanceCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor);
          factory.p1(snaps[0].position, snaps[0]);
          factory.p2(snaps[1].position, snaps[1]);
          const measurement = await factory.calculate();
          if (args.name) measurement.userData.name = args.name;
          await editor.measurements.update([measurement], [], []);
          for (const viewport of editor.viewports ?? []) viewport.setNeedsRender();
          return measurement;
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["PointToPointMeasurementFactory"], [{ points: [first, second], name: name ?? null }]);
    return await this.state();
  }

  async createRadiusMeasurement(
    edge: CurvatureEdgeReference,
    name: string | undefined,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    const body = state.bodies.find((candidate) => candidate.id === edge.bodyId);
    if (!body || !["Wire", "Solid", "Sheet"].includes(body.type)) {
      throw new Error(`Unknown current Wire, Solid, or Sheet body ID: ${edge.bodyId}`);
    }
    if (body.type === "Wire") {
      if (!("segmentEntityId" in edge)) {
        throw new Error(`Wire radius measurement ${edge.bodyId} requires a native segmentEntityId`);
      }
    } else {
      if (!("edgeId" in edge)) throw new Error(`Solid or Sheet radius measurement ${edge.bodyId} requires an edgeId`);
      const currentEdge = body.edges.find((candidate) => candidate.id === edge.edgeId);
      if (!currentEdge) throw new Error(`Unknown current edge ID ${edge.edgeId} on body ${edge.bodyId}`);
      if (!currentEdge.circle) throw new Error(`Radius measurement requires a circular edge: ${edge.bodyId}:${edge.edgeId}`);
    }
    await this.runtime.mutate(`async function (Factory, args) {
      const editor = this;
      let item;
      for (const [versionId, candidate] of this.geo.geometryModel) {
        if (this.db.lookupStableId(versionId) === args.edge.bodyId) { item = candidate; break; }
      }
      if (!item || !['Wire', 'Solid', 'Sheet'].includes(item.view?.constructor?.name)) {
        throw new Error('Unknown current Wire, Solid, or Sheet body ID: ' + args.edge.bodyId);
      }
      let entityId;
      let modelEdge;
      const modelEdges = item.model?.GetEdges?.();
      if (item.view.constructor.name === 'Wire') {
        if (!Number.isInteger(args.edge.segmentEntityId)) throw new Error('Wire radius measurement requires a native segmentEntityId');
        entityId = args.edge.segmentEntityId;
      } else {
        const edgeIndex = item.view.high.edges.versionIds.indexOf(args.edge.edgeId);
        if (edgeIndex < 0) throw new Error('Stale or unknown shell edge: ' + args.edge.edgeId);
        entityId = Number(item.view.high.edges.get(edgeIndex).entityId);
      }
      for (let index = 0; index < (modelEdges?.Size?.() ?? 0); index += 1) {
        const candidate = modelEdges.Get(index);
        if (Number(candidate.Id()) === entityId) { modelEdge = candidate; break; }
      }
      if (!modelEdge) throw new Error('Stale or unknown native edge: ' + args.edge.bodyId + ':' + entityId);
      if (!modelEdge.IsCircle()) throw new Error('Radius measurement requires a circular edge');
      let snap;
      for (const entry of this.snaps.cache.entries ?? []) {
        for (let index = 0; index < (entry.positions?.length ?? 0) / 3; index += 1) {
          const candidate = entry.lookup(index);
          if (!['EdgePointSnap', 'CurveSegmentMidpointSnap'].includes(candidate?.constructor?.name)) continue;
          if (this.db.lookupStableId(candidate.item?.versionId) !== args.edge.bodyId) continue;
          if (Number(candidate.model?.Id?.()) !== entityId) continue;
          snap = candidate;
          break;
        }
        if (snap) break;
      }
      if (!snap) throw new Error('Plasticity circular-edge snap is unavailable for the requested radius measurement');
      let failure;
      const command = new this.commands.MeasureRadiusCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor);
          factory.snap = snap;
          const measurement = await factory.calculate();
          if (args.name) measurement.userData.name = args.name;
          await editor.measurements.update([measurement], [], []);
          for (const viewport of editor.viewports ?? []) viewport.setNeedsRender();
          return measurement;
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["RadialMeasurementFactory"], [{ edge, name: name ?? null }]);
    return await this.state();
  }

  async deleteMeasurement(id: number, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (!(state.measurements ?? []).some((measurement) => measurement.id === id)) {
      throw new Error(`Unknown current measurement ID: ${id}`);
    }
    await this.runtime.mutate(`async function (RemoveMeasurementCommand, args) {
      const measurement = this.measurements.lookupByStableId(args.id);
      if (!measurement) throw new Error('Unknown measurement ID: ' + args.id);
      this.selection.selected.removeAll();
      this.selection.selected.addMeasurement(measurement);
      let failure;
      const command = new RemoveMeasurementCommand(this);
      command.remember = false;
      const execute = command.execute.bind(command);
      command.execute = async function () {
        try { return await execute(); }
        catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
      for (const viewport of this.viewports ?? []) viewport.setNeedsRender();
    }`, ["RemoveMeasurementCommand"], [{ id }]);
    return await this.state();
  }

  async listInstances(): Promise<{
    documentToken: string;
    revision: string;
    instances: NonNullable<RuntimeState["instances"]>;
  }> {
    const state = await this.state();
    return { documentToken: state.documentToken, revision: state.revision, instances: state.instances ?? [] };
  }

  async createInstance(bodyId: number, translationMm: Vector3, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (!state.bodies.some((body) => body.id === bodyId)) throw new Error(`Unknown current body ID: ${bodyId}`);
    await this.runtime.mutate(`async function (CreateFactory, MoveFactory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const create = new CreateFactory(editor).resource(this);
          create.items = [find(args.bodyId)];
          const result = await create.commit();
          const created = Array.isArray(result) ? result : [result].filter(Boolean);
          if (created.length !== 1 || created[0]?.constructor?.name !== 'InstanceEmpty') {
            throw new Error('Plasticity did not create exactly one native instance');
          }
          if (args.translation.some(value => value !== 0)) {
            const move = new MoveFactory(editor).resource(this);
            move.empties = created;
            move.move.fromArray(args.translation);
            await move.commit();
          }
          return created;
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["CreateInstanceFactory", "MoveItemAndEmptyFactory"], [{ bodyId, translation: toMeters(translationMm) }]);
    return await this.state();
  }

  async duplicateBodies(ids: number[], translationMm: Vector3, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0 || new Set(ids).size !== ids.length) {
      throw new Error("Body IDs must be a nonempty unique list");
    }
    const current = new Map(state.bodies.map((body) => [body.id, body]));
    const missing = ids.filter((id) => !current.has(id));
    if (missing.length > 0) throw new Error(`Unknown current body IDs: ${missing.join(", ")}`);
    const invalid = ids.filter((id) => !["Solid", "Sheet"].includes(current.get(id)!.type));
    if (invalid.length > 0) throw new Error(`Body duplication requires current Solid or Sheet bodies: ${invalid.join(", ")}`);
    const translation = toMeters(translationMm);
    await this.runtime.mutate(`async function (CreateFactory, MoveFactory, RealizeFactory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const create = new CreateFactory(editor).resource(this);
          create.items = args.ids.map(find);
          const result = await create.commit();
          const created = Array.isArray(result) ? result : [result].filter(Boolean);
          if (created.length === 0 || !created.every(item => item?.constructor?.name === 'InstanceEmpty')) {
            throw new Error('Plasticity did not create native instances for the complete body selection');
          }
          if (args.translation.some(value => value !== 0)) {
            const move = new MoveFactory(editor).resource(this);
            move.empties = created;
            move.move.fromArray(args.translation);
            await move.commit();
          }
          const realize = new RealizeFactory(editor).resource(this);
          realize.empties = created;
          return await realize.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["CreateInstanceFactory", "MoveItemAndEmptyFactory", "RealizeInstanceFactory"], [{ ids, translation }]);
    return await this.state();
  }

  async moveInstances(ids: number[], deltaMm: Vector3, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireInstanceIds(state, ids);
    await this.runtime.mutate(`async function (Factory, args) {
      ${findWritableInstanceEmpty}
      ${commandStart("MoveItemCommand")}
      factory.empties = args.ids.map(find);
      factory.move.fromArray(args.delta);
      ${commandEnd}
    }`, ["MoveItemAndEmptyFactory"], [{ ids, delta: toMeters(deltaMm) }]);
    return await this.state();
  }

  async rotateInstances(ids: number[], pivotMm: Vector3, axis: Vector3, degrees: number, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireInstanceIds(state, ids);
    await this.runtime.mutate(`async function (Factory, Vector, Quaternion, args) {
      ${findWritableInstanceEmpty}
      ${commandStart("RotateItemCommand")}
      factory.empties = args.ids.map(find);
      factory.pivot.fromArray(args.pivot);
      factory.rotation.copy(new Quaternion().setFromAxisAngle(new Vector(...args.axis).normalize(), args.radians));
      ${commandEnd}
    }`, ["RotateItemAndEmptyFactory", "Vector3", "Quaternion"], [{ ids, pivot: toMeters(pivotMm), axis, radians: degreesToRadians(degrees) }]);
    return await this.state();
  }

  async scaleInstances(ids: number[], pivotMm: Vector3, factors: Vector3, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireInstanceIds(state, ids);
    await this.runtime.mutate(`async function (Factory, args) {
      ${findWritableInstanceEmpty}
      ${commandStart("ScaleItemCommand")}
      factory.empties = args.ids.map(find);
      factory.pivot.fromArray(args.pivot);
      factory.scale.fromArray(args.factors);
      ${commandEnd}
    }`, ["ProjectingScaleItemAndEmptyFactory"], [{ ids, pivot: toMeters(pivotMm), factors }]);
    return await this.state();
  }

  async realizeInstances(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireInstanceIds(state, ids);
    await this.runtime.mutate(`async function (Factory, args) {
      const find = id => {
        const empty = this.db.lookupEmptyById(id);
        if (empty?.constructor?.name !== 'InstanceEmpty') throw new Error('Unknown native instance ID: ' + id);
        return empty;
      };
      ${commandStart("GroupSelectedCommand")}
      factory.empties = args.ids.map(find);
      ${commandEnd}
    }`, ["RealizeInstanceFactory"], [{ ids }]);
    return await this.state();
  }

  async deleteInstances(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireInstanceIds(state, ids);
    await this.runtime.mutate(`async function (args) {
      const find = id => {
        const empty = this.db.lookupEmptyById(id);
        if (empty?.constructor?.name !== 'InstanceEmpty') throw new Error('Unknown native instance ID: ' + id);
        return empty;
      };
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      this.selection.selected.removeAll();
      for (const empty of args.ids.map(find)) this.selection.selected.addEmpty(empty);
      const command = new this.commands.DeleteCommand(this);
      command.remember = false;
      let failure;
      const execute = command.execute.bind(command);
      command.execute = async function () {
        try { return await execute(); }
        catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, [], [{ ids }]);
    return await this.state();
  }

  async listReferenceMeshes(): Promise<{
    documentToken: string;
    revision: string;
    referenceMeshes: NonNullable<RuntimeState["referenceMeshes"]>;
  }> {
    const state = await this.state();
    return {
      documentToken: state.documentToken,
      revision: state.revision,
      referenceMeshes: state.referenceMeshes ?? [],
    };
  }

  async moveReferenceMeshes(ids: number[], deltaMm: Vector3, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireReferenceMeshIds(state, ids);
    await this.runtime.mutate(`async function (Factory, args) {
      const find = id => {
        const empty = this.db.lookupEmptyById(id);
        if (empty?.constructor?.name !== 'Empties_ObjectEmpty') throw new Error('Unknown native reference mesh ID: ' + id);
        return empty;
      };
      ${commandStart("MoveItemCommand")}
      factory.empties = args.ids.map(find);
      factory.move.fromArray(args.delta);
      ${commandEnd}
    }`, ["MoveItemAndEmptyFactory"], [{ ids, delta: toMeters(deltaMm) }]);
    return await this.state();
  }

  async rotateReferenceMeshes(ids: number[], pivotMm: Vector3, axis: Vector3, degrees: number, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireReferenceMeshIds(state, ids);
    const unitAxis = normalize(axis, "Reference mesh rotation axis");
    await this.runtime.mutate(`async function (Factory, Vector, Quaternion, args) {
      const find = id => {
        const empty = this.db.lookupEmptyById(id);
        if (empty?.constructor?.name !== 'Empties_ObjectEmpty') throw new Error('Unknown native reference mesh ID: ' + id);
        return empty;
      };
      ${commandStart("RotateItemCommand")}
      factory.empties = args.ids.map(find);
      factory.pivot.fromArray(args.pivot);
      factory.rotation.copy(new Quaternion().setFromAxisAngle(new Vector(...args.axis), args.radians));
      ${commandEnd}
    }`, ["RotateItemAndEmptyFactory", "Vector3", "Quaternion"], [{ ids, pivot: toMeters(pivotMm), axis: unitAxis, radians: degreesToRadians(degrees) }]);
    return await this.state();
  }

  async scaleReferenceMeshes(ids: number[], pivotMm: Vector3, factors: Vector3, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireReferenceMeshIds(state, ids);
    if (factors.some((factor) => !Number.isFinite(factor) || factor <= 0)) {
      throw new Error("Reference mesh scale factors must be positive finite values");
    }
    await this.runtime.mutate(`async function (Factory, args) {
      const find = id => {
        const empty = this.db.lookupEmptyById(id);
        if (empty?.constructor?.name !== 'Empties_ObjectEmpty') throw new Error('Unknown native reference mesh ID: ' + id);
        return empty;
      };
      ${commandStart("ScaleItemCommand")}
      factory.empties = args.ids.map(find);
      factory.pivot.fromArray(args.pivot);
      factory.scale.fromArray(args.factors);
      ${commandEnd}
    }`, ["ProjectingScaleItemAndEmptyFactory"], [{ ids, pivot: toMeters(pivotMm), factors }]);
    return await this.state();
  }

  async deleteReferenceMeshes(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireReferenceMeshIds(state, ids);
    await this.runtime.mutate(`async function (args) {
      const find = id => {
        const empty = this.db.lookupEmptyById(id);
        if (empty?.constructor?.name !== 'Empties_ObjectEmpty') throw new Error('Unknown native reference mesh ID: ' + id);
        return empty;
      };
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      this.selection.selected.removeAll();
      for (const empty of args.ids.map(find)) this.selection.selected.addEmpty(empty);
      const command = new this.commands.DeleteCommand(this);
      command.remember = false;
      let failure;
      const execute = command.execute.bind(command);
      command.execute = async function () {
        try { return await execute(); }
        catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, [], [{ ids }]);
    return await this.state();
  }

  async renameReferenceMesh(id: number, name: string, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireReferenceMeshIds(state, [id]);
    await this.runtime.mutate(`async function (args) {
      const empty = this.db.lookupEmptyById(args.id);
      if (empty?.constructor?.name !== 'Empties_ObjectEmpty') throw new Error('Unknown native reference mesh ID: ' + args.id);
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      this.selection.selected.removeAll();
      const editor = this;
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try { editor.db.nodes.setName(editor.db.nodes.item2key(empty), args.name); }
        catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, [], [{ id, name }]);
    return await this.state();
  }

  async listGroups(): Promise<{
    documentToken: string;
    revision: string;
    activeGroupId: number;
    groups: NonNullable<RuntimeState["groups"]>;
  }> {
    const state = await this.state();
    return {
      documentToken: state.documentToken,
      revision: state.revision,
      activeGroupId: state.activeGroupId ?? 0,
      groups: state.groups ?? [],
    };
  }

  async createGroup(
    bodyIds: number[],
    instanceIds: number[],
    referenceMeshIds: number[],
    groupIds: number[],
    name: string | undefined,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireGroupSelection(state, bodyIds, instanceIds, referenceMeshIds, groupIds);
    await this.runtime.mutate(`async function (args) {
      ${findView}
      const findEmpty = id => {
        const empty = this.db.lookupEmptyById(id);
        if (empty?.constructor?.name !== 'InstanceEmpty') throw new Error('Unknown native instance ID: ' + id);
        return empty;
      };
      const findReferenceMesh = id => {
        const empty = this.db.lookupEmptyById(id);
        if (empty?.constructor?.name !== 'Empties_ObjectEmpty') throw new Error('Unknown native reference mesh ID: ' + id);
        return empty;
      };
      const findGroup = id => {
        const group = this.db.groups.lookupById(id);
        if (!group || id === 0) throw new Error('Unknown or protected group ID: ' + id);
        return group;
      };
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      this.selection.selected.removeAll();
      for (const view of args.bodyIds.map(find)) this.selection.selected.add(view);
      for (const empty of args.instanceIds.map(findEmpty)) this.selection.selected.addEmpty(empty);
      for (const empty of args.referenceMeshIds.map(findReferenceMesh)) this.selection.selected.addEmpty(empty);
      for (const group of args.groupIds.map(findGroup)) this.selection.selected.addGroup(group);
      const editor = this;
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      const execute = command.execute.bind(command);
      command.execute = async function () {
        try {
          const result = await execute();
          const selected = Array.from(editor.selection.selected.groups);
          if (selected.length !== 1) throw new Error('Plasticity did not create exactly one group');
          if (args.name) editor.db.nodes.setName(editor.db.nodes.item2key(selected[0]), args.name);
          return result;
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, [], [{ bodyIds, instanceIds, referenceMeshIds, groupIds, name: name ?? null }]);
    return await this.state();
  }

  async moveToGroup(
    bodyIds: number[],
    instanceIds: number[],
    referenceMeshIds: number[],
    groupIds: number[],
    destinationGroupId: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireGroupSelection(state, bodyIds, instanceIds, referenceMeshIds, groupIds);
    requireGroupIds(state, [destinationGroupId], true);
    for (const groupId of groupIds) {
      if (groupId === destinationGroupId || groupContains(state, groupId, destinationGroupId)) {
        throw new Error(`Moving group ${groupId} to ${destinationGroupId} would create a group cycle`);
      }
    }
    await this.runtime.mutate(`async function (Command, args) {
      ${findView}
      const findEmpty = id => {
        const empty = this.db.lookupEmptyById(id);
        if (empty?.constructor?.name !== 'InstanceEmpty') throw new Error('Unknown native instance ID: ' + id);
        return empty;
      };
      const findReferenceMesh = id => {
        const empty = this.db.lookupEmptyById(id);
        if (empty?.constructor?.name !== 'Empties_ObjectEmpty') throw new Error('Unknown native reference mesh ID: ' + id);
        return empty;
      };
      const findGroup = id => {
        const group = this.db.groups.lookupById(id);
        if (!group) throw new Error('Unknown group ID: ' + id);
        return group;
      };
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      this.selection.selected.removeAll();
      for (const view of args.bodyIds.map(find)) this.selection.selected.add(view);
      for (const empty of args.instanceIds.map(findEmpty)) this.selection.selected.addEmpty(empty);
      for (const empty of args.referenceMeshIds.map(findReferenceMesh)) this.selection.selected.addEmpty(empty);
      for (const group of args.groupIds.map(findGroup)) this.selection.selected.addGroup(group);
      let failure;
      const command = new Command(this, findGroup(args.destinationGroupId));
      command.remember = false;
      const execute = command.execute.bind(command);
      command.execute = async function () {
        try { return await execute(); }
        catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["MoveSelectionToGroupCommand"], [{ bodyIds, instanceIds, referenceMeshIds, groupIds, destinationGroupId }]);
    return await this.state();
  }

  async renameGroup(id: number, name: string, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireGroupIds(state, [id], false);
    await this.runtime.mutate(`async function (args) {
      const group = this.db.groups.lookupById(args.id);
      if (!group || args.id === 0) throw new Error('Unknown or protected group ID: ' + args.id);
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      this.selection.selected.removeAll();
      const editor = this;
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try { editor.db.nodes.setName(editor.db.nodes.item2key(group), args.name); }
        catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, [], [{ id, name }]);
    return await this.state();
  }

  async activateGroup(id: number, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireGroupIds(state, [id], true);
    await this.runtime.mutate(`async function (Command, args) {
      const group = this.db.groups.lookupById(args.id);
      if (!group) throw new Error('Unknown group ID: ' + args.id);
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      let failure;
      const command = new Command(this, group);
      command.remember = false;
      const execute = command.execute.bind(command);
      command.execute = async function () {
        try { return await execute(); }
        catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["ActivateGroupCommand"], [{ id }]);
    return await this.state();
  }

  async dissolveGroups(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireGroupIds(state, ids, false);
    await this.runtime.mutate(`async function (Command, args) {
      const find = id => {
        const group = this.db.groups.lookupById(id);
        if (!group || id === 0) throw new Error('Unknown or protected group ID: ' + id);
        return group;
      };
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      this.selection.selected.removeAll();
      for (const group of args.ids.map(find)) this.selection.selected.addGroup(group);
      let failure;
      const command = new Command(this);
      command.remember = false;
      const execute = command.execute.bind(command);
      command.execute = async function () {
        try { return await execute(); }
        catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["DissolveGroupCommand"], [{ ids }]);
    return await this.state();
  }

  async setNodeVisibility(
    bodyIds: number[],
    instanceIds: number[],
    referenceMeshIds: number[],
    groupIds: number[],
    visible: boolean,
    revision: string,
  ): Promise<RuntimeState> {
    return await this.setNodeFlag("visibility", bodyIds, instanceIds, referenceMeshIds, groupIds, visible, revision);
  }

  async setNodeLocked(
    bodyIds: number[],
    instanceIds: number[],
    referenceMeshIds: number[],
    groupIds: number[],
    locked: boolean,
    revision: string,
  ): Promise<RuntimeState> {
    return await this.setNodeFlag("locked", bodyIds, instanceIds, referenceMeshIds, groupIds, locked, revision);
  }

  private async setNodeFlag(
    flag: "visibility" | "locked",
    bodyIds: number[],
    instanceIds: number[],
    referenceMeshIds: number[],
    groupIds: number[],
    value: boolean,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireGroupSelection(state, bodyIds, instanceIds, referenceMeshIds, groupIds, true);
    await this.runtime.mutate(`async function (args) {
      ${findView}
      const findEmpty = id => {
        const empty = this.db.lookupEmptyById(id);
        if (empty?.constructor?.name !== 'InstanceEmpty') throw new Error('Unknown native instance ID: ' + id);
        return empty;
      };
      const findReferenceMesh = id => {
        const empty = this.db.lookupEmptyById(id);
        if (empty?.constructor?.name !== 'Empties_ObjectEmpty') throw new Error('Unknown native reference mesh ID: ' + id);
        return empty;
      };
      const findGroup = id => {
        const group = this.db.groups.lookupById(id);
        if (!group) throw new Error('Unknown group ID: ' + id);
        return group;
      };
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const keys = [
        ...args.bodyIds.map(id => this.db.nodes.item2key(find(id))),
        ...args.instanceIds.map(id => this.db.nodes.item2key(findEmpty(id))),
        ...args.referenceMeshIds.map(id => this.db.nodes.item2key(findReferenceMesh(id))),
        ...args.groupIds.map(id => this.db.nodes.item2key(findGroup(id))),
      ];
      this.selection.selected.removeAll();
      const editor = this;
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          for (const key of keys) {
            if (args.flag === 'visibility') editor.db.nodes.setVisible(key, args.value);
            else editor.db.nodes.setLocked(key, args.value);
          }
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, [], [{ flag, bodyIds, instanceIds, referenceMeshIds, groupIds, value }]);
    return await this.state();
  }

  async inspectRectangularMember(request: MemberRequest): Promise<MemberEvidence> {
    return await inspectRectangularMember(this.runtime, request, this.datumRegistry.sessionId);
  }

  async inspectPlanarSection(request: SectionRequest): Promise<SectionEvidence> {
    return await inspectPlanarSection(this.runtime, request, this.datumRegistry.sessionId);
  }

  async inspectArbitrarySection(request: ArbitrarySectionRequest): Promise<ArbitrarySectionEvidence> {
    return await inspectArbitrarySection(this.runtime, request, this.datumRegistry.sessionId);
  }

  async checkInterference(pairs: BodyInterferencePair[], revision: string): Promise<BodyInterferenceEvidence> {
    return await checkBodyInterference(this.runtime, pairs, revision, this.datumRegistry.sessionId);
  }

  async measureSolidProperties(ids: number[], revision: string): Promise<SolidPropertiesEvidence> {
    return await measureSolidProperties(this.runtime, ids, revision, this.datumRegistry.sessionId);
  }

  async measureFaceProperties(faces: FaceReference[], revision: string): Promise<FacePropertiesEvidence> {
    return await measureFaceProperties(this.runtime, faces, revision, this.datumRegistry.sessionId);
  }

  async inspectSingleFastenerPlate(request: FastenerPlateRequest): Promise<FastenerPlateEvidence> {
    return await inspectSingleFastenerPlate(this.runtime, request, this.datumRegistry.sessionId);
  }

  async inspectIntegralRectangularPlate(request: IntegralPlateRequest): Promise<IntegralPlateEvidence> {
    return await inspectIntegralRectangularPlate(this.runtime, request, this.datumRegistry.sessionId);
  }

  async inspectFastenerGroup(request: FastenerGroupGeometryRequest): Promise<FastenerGroupGeometryEvidence> {
    return await inspectFastenerGroupGeometry(this.runtime, request, this.datumRegistry.sessionId);
  }

  async inspectFastenerGroupLayout(request: FastenerGroupLayoutRequest): Promise<FastenerGroupLayoutEvidence> {
    return await inspectFastenerGroupLayout(this.runtime, request, this.datumRegistry.sessionId);
  }

  constructionCapabilities(): ReturnType<ConstructionGeometry["capabilities"]> {
    return this.constructionGeometry.capabilities();
  }

  async defineDatumPoint(definition: PointDefinition, revision: string): Promise<DatumPointRef> {
    const state = await this.syncConstructionState(revision);
    return this.datumRegistry.addPoint(definition, requireResolution(resolvePoint(state, definition)));
  }

  async defineDatumAxis(definition: AxisDefinition, revision: string): Promise<DatumAxisRef> {
    const state = await this.syncConstructionState(revision);
    return this.datumRegistry.addAxis(definition, requireResolution(resolveAxis(state, definition, this.datumRegistry)));
  }

  async createConstructionPlane(
    definition: PlaneDefinition,
    name: string | undefined,
    revision: string,
  ): Promise<ConstructionPlaneRef> {
    const state = await this.syncConstructionState(revision);
    const frame = requireResolution(resolvePlaneFrame(state, definition, this.datumRegistry));
    const created = await this.constructionGeometry.createPlane(frame, name, revision);
    this.syncRegistry(created.state);
    return this.datumRegistry.putPlane(created.plane, definition);
  }

  async listConstructionGeometry(): Promise<{
    points: DatumPointRef[];
    axes: DatumAxisRef[];
    planes: ConstructionPlaneRef[];
    activePlaneId: string | null;
    activePlane: ConstructionPlaneRef | null;
  }> {
    const state = await this.state();
    this.syncRegistry(state);
    const activePlane = state.construction.activePlaneId === null
      ? null
      : this.datumRegistry.listPlanes().find((plane) => plane.id === state.construction.activePlaneId) ?? null;
    return {
      points: this.datumRegistry.listPoints(),
      axes: this.datumRegistry.listAxes(),
      planes: this.datumRegistry.listPlanes(),
      activePlaneId: state.construction.activePlaneId,
      activePlane,
    };
  }

  async setConstructionWorkplane(identity: ReferenceIdentity): Promise<RuntimeState> {
    const state = await this.syncConstructionState(identity.revision);
    const plane = this.datumRegistry.requireCurrentPlane(identity, state.documentToken, state.revision);
    const after = await this.constructionGeometry.setWorkplane(plane);
    this.syncRegistry(after);
    return after;
  }

  async removeConstructionPlane(identity: ReferenceIdentity): Promise<RuntimeState> {
    const state = await this.syncConstructionState(identity.revision);
    const plane = this.datumRegistry.requireCurrentPlane(identity, state.documentToken, state.revision);
    if (plane.source === "standard") throw new Error("Standard construction planes cannot be removed");
    const after = await this.constructionGeometry.removePlane(plane.nativeId, state.revision);
    this.datumRegistry.deletePlane(plane.id);
    this.syncRegistry(after);
    return after;
  }

  async refreshDatum(identity: ReferenceIdentity): Promise<DatumPointRef | DatumAxisRef> {
    const state = await this.state();
    this.syncRegistry(state);
    const prior = this.datumRegistry.get(identity.id);
    assertRefreshIdentity(prior, identity, this.datumRegistry.sessionId, state.documentToken);
    if (prior.kind === "datum-point") {
      return this.datumRegistry.refreshPoint(prior.id, requireResolution(resolvePoint(state, prior.definition)));
    }
    if (prior.kind === "datum-axis") {
      return this.datumRegistry.refreshAxis(prior.id, requireResolution(resolveAxis(state, prior.definition, this.datumRegistry, true)));
    }
    throw new Error("Construction planes are synchronized from Plasticity and cannot be refreshed as datums");
  }

  private async syncConstructionState(expectedRevision?: string): Promise<RuntimeState> {
    const state = await this.state();
    if (expectedRevision !== undefined && state.revision !== expectedRevision) {
      throw new Error(`Stale reference: expected revision ${expectedRevision}, current revision is ${state.revision}`);
    }
    this.syncRegistry(state);
    return state;
  }

  private syncRegistry(state: RuntimeState): void {
    this.datumRegistry.sync(state);
    this.datumRegistry.syncPlanes(state.construction.planes);
  }

  private async resolveCurrentPlane(identity: ReferenceIdentity, revision?: string): Promise<ConstructionPlaneRef> {
    const state = await this.syncConstructionState(revision ?? identity.revision);
    return this.datumRegistry.requireCurrentPlane(identity, state.documentToken, state.revision);
  }

  async selection(): Promise<PlasticitySelection> {
    const state = await this.state();
    const selected = await this.runtime.read<Omit<PlasticitySelection, "documentToken" | "revision">>(`function () {
      const selection = this.selection.selected;
      const stableId = view => {
        const versionId = view?.parentItem?.versionId ?? view?.versionId;
        return versionId === undefined ? null : (this.db.lookupStableId(versionId) ?? null);
      };
      return {
        bodyIds: Array.from(selection.items ?? []).map(stableId).filter(Number.isInteger),
        curveIds: Array.from(selection.curveIds ?? []).map(Number).filter(Number.isInteger),
        instanceIds: Array.from(selection.empties ?? [])
          .filter(empty => empty?.constructor?.name === 'InstanceEmpty')
          .map(empty => Number(empty.versionId))
          .filter(Number.isInteger),
        referenceMeshIds: Array.from(selection.empties ?? [])
          .filter(empty => empty?.constructor?.name === 'Empties_ObjectEmpty')
          .map(empty => Number(empty.versionId))
          .filter(Number.isInteger),
        groupIds: Array.from(selection.groups ?? [])
          .map(group => Number(group.versionId))
          .filter(Number.isInteger),
        faces: Array.from(selection.faces ?? []).map(face => ({ bodyId: stableId(face), faceId: String(face.versionId) })),
        edges: Array.from(selection.edges ?? []).map(edge => ({ bodyId: stableId(edge), edgeId: String(edge.versionId) })),
        regionIds: Array.from(selection.regionIds ?? []).map(String),
        curveControlPoints: [
          ...Array.from(selection.curveVertices ?? []).map(vertex => ({ bodyId: stableId(vertex), kind: 'vertex', pointId: Number(vertex.id) })),
          ...Array.from(selection.curveCVs ?? []).map(controlPoint => ({ bodyId: stableId(controlPoint), kind: 'control-point', pointId: Number(controlPoint.id) })),
        ].filter(reference => Number.isInteger(reference.bodyId) && Number.isInteger(reference.pointId)),
      };
    }`);
    return { documentToken: state.documentToken, revision: state.revision, ...selected };
  }

  async listRegions(): Promise<{
    documentToken: string;
    revision: string;
    regions: RuntimeState["regions"];
  }> {
    const state = await this.state();
    return { documentToken: state.documentToken, revision: state.revision, regions: state.regions };
  }

  async listCurveFragments(): Promise<{
    documentToken: string;
    revision: string;
    fragments: CurveFragmentDescriptor[];
  }> {
    const before = await this.state();
    const fragments = await this.runtime.read<CurveFragmentDescriptor[]>(`function () {
      const mm = value => value * 1000;
      const vector = value => [mm(value.x), mm(value.y), mm(value.z)];
      const result = [];
      for (const info of this.fragments.read.modelId2info.values()) {
        const bodyId = this.db.lookupStableId(info.ancestorViewId);
        const fragmentItem = this.geo.geometryModel.get(info.fragmentViewId);
        if (!Number.isInteger(bodyId) || !fragmentItem) continue;
        for (const segment of Array.from(fragmentItem.view?.segments ?? [])) {
          const edge = this.db.lookupTopologyItem(segment);
          const start = edge.GetPointAndTangent(0);
          const midpoint = edge.GetPointAndTangent(0.5);
          const end = edge.GetPointAndTangent(1);
          result.push({
            id: String(segment.versionId),
            bodyId,
            ancestorVersionId: info.ancestorViewId,
            fragmentViewId: info.fragmentViewId,
            entityId: Number(segment.entityId),
            measurementSource: 'native-brep',
            startMm: vector(start.position),
            midpointMm: vector(midpoint.position),
            endMm: vector(end.position),
            lengthMm: mm(edge.FindLength().length),
          });
        }
      }
      return result.sort((left, right) => left.id.localeCompare(right.id));
    }`);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while curve fragments were being listed");
    }
    return { documentToken: after.documentToken, revision: after.revision, fragments };
  }

  async listCurveEndpoints(): Promise<{
    documentToken: string;
    revision: string;
    endpoints: CurveEndpointDescriptor[];
  }> {
    const before = await this.state();
    const endpoints = await this.runtime.read<CurveEndpointDescriptor[]>(`function () {
      const mm = value => value * 1000;
      const vector = value => [mm(value.x), mm(value.y), mm(value.z)];
      const result = [];
      for (const [versionId, item] of this.geo.geometryModel) {
        if (item.view?.constructor?.name !== 'Wire') continue;
        const bodyId = this.db.lookupStableId(versionId);
        if (!Number.isInteger(bodyId)) continue;
        for (const vertex of Array.from(item.view.vertices ?? [])) {
          const model = this.db.lookupTopologyItem(vertex);
          if (!model.IsSpur()) continue;
          result.push({
            id: String(vertex.versionId),
            bodyId,
            bodyVersionId: versionId,
            entityId: Number(vertex.entityId),
            measurementSource: 'native-brep',
            positionMm: vector(model.GetPoint()),
          });
        }
      }
      return result.sort((left, right) => left.id.localeCompare(right.id));
    }`);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while curve endpoints were being listed");
    }
    return { documentToken: after.documentToken, revision: after.revision, endpoints };
  }

  async listCurveVertices(): Promise<{
    documentToken: string;
    revision: string;
    vertices: CurveVertexDescriptor[];
  }> {
    const before = await this.state();
    const vertices = await this.runtime.readNative<CurveVertexDescriptor[]>(`function () {
      const mm = value => value * 1000;
      const vector = value => [mm(value.x), mm(value.y), mm(value.z)];
      const result = [];
      for (const [versionId, item] of this.geo.geometryModel) {
        if (item.view?.constructor?.name !== 'Wire') continue;
        const bodyId = this.db.lookupStableId(versionId);
        if (!Number.isInteger(bodyId)) continue;
        const bodyEdges = item.model?.GetEdges?.();
        for (const view of Array.from(item.view.vertices ?? [])) {
          const vertex = this.db.lookupTopologyItem(view);
          const vertexId = Number(vertex.Id());
          if (!Number.isInteger(vertexId)) continue;
          const adjacentEdgeEntityIds = [];
          for (let index = 0; index < (bodyEdges?.Size?.() ?? 0); index += 1) {
            const edge = bodyEdges.Get(index);
            const ends = edge.GetVertices();
            if (ends.left?.Id?.() !== vertexId && ends.right?.Id?.() !== vertexId) continue;
            const edgeId = Number(edge.Id());
            if (Number.isInteger(edgeId)) adjacentEdgeEntityIds.push(edgeId);
          }
          adjacentEdgeEntityIds.sort((left, right) => left - right);
          result.push({
            id: bodyId + ':' + vertexId,
            bodyId,
            bodyVersionId: Number(versionId),
            vertexId,
            viewVersionId: String(view.versionId),
            measurementSource: 'native-brep',
            positionMm: vector(vertex.GetPoint()),
            endpoint: Boolean(vertex.IsSpur()),
            adjacentEdgeEntityIds,
          });
        }
      }
      return result.sort((left, right) => left.bodyId - right.bodyId || left.vertexId - right.vertexId);
    }`, [], []);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while curve vertices were being listed");
    }
    return { documentToken: after.documentToken, revision: after.revision, vertices };
  }

  async listCurveDirections(): Promise<{
    documentToken: string;
    revision: string;
    curves: CurveDirectionDescriptor[];
  }> {
    const before = await this.state();
    const curves = await this.runtime.readNative<CurveDirectionDescriptor[]>(`function () {
      const mm = value => value * 1000;
      const vector = value => [mm(value.x), mm(value.y), mm(value.z)];
      const direction = value => {
        const length = Math.hypot(value.x, value.y, value.z);
        if (!(length > 0)) throw new Error('Native curve tangent is zero');
        return [value.x / length, value.y / length, value.z / length];
      };
      const result = [];
      for (const [versionId, item] of this.geo.geometryModel) {
        if (item.view?.constructor?.name !== 'Wire') continue;
        const id = this.db.lookupStableId(versionId);
        if (!Number.isInteger(id)) continue;
        const edges = item.model?.GetEdges?.();
        const segments = [];
        for (let index = 0; index < (edges?.Size?.() ?? 0); index += 1) {
          const edge = edges.Get(index);
          const start = edge.GetPointAndTangent(0);
          const end = edge.GetPointAndTangent(1);
          const midpoint = edge.GetPointAndTangent(0.5);
          const nativeCurve = edge.GetCurve();
          const curve = nativeCurve?.curve ?? nativeCurve;
          let circleGeometry = null;
          if (edge.IsCircle()) {
            const info = curve?.GetInfo?.();
            const basis = info?.basis;
            if (basis?.Location && basis?.Axis && basis?.Ref && Number.isFinite(info?.radius) && info.radius > 0) {
              circleGeometry = {
                centerMm: vector(basis.Location),
                radiusMm: mm(info.radius),
                normal: direction(basis.Axis),
                reference: direction(basis.Ref),
                startMm: vector(start.position),
                midpointMm: vector(midpoint.position),
                endMm: vector(end.position),
              };
            }
          }
          segments.push({
            entityId: Number(edge.Id()),
            curveType: curve?.constructor?.name ?? 'Unknown',
            startMm: vector(start.position),
            endMm: vector(end.position),
            startTangent: direction(start.tangent),
            endTangent: direction(end.tangent),
            lengthMm: mm(edge.FindLength().length),
            ...(circleGeometry === null ? {} : { circleGeometry }),
          });
        }
        let closed = true;
        for (const vertex of Array.from(item.view.vertices ?? [])) {
          if (this.db.lookupTopologyItem(vertex).IsSpur()) { closed = false; break; }
        }
        result.push({ id, versionId, measurementSource: 'native-brep', closed, segments });
      }
      return result.sort((left, right) => left.id - right.id);
    }`, [], []);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while curve directions were being listed");
    }
    return { documentToken: after.documentToken, revision: after.revision, curves };
  }

  async evaluateCurveSegments(samples: CurveSegmentSampleReference[], revision: string): Promise<{
    documentToken: string;
    revision: string;
    samples: CurveSegmentSampleDescriptor[];
  }> {
    const before = await this.assertRevision(revision);
    if (samples.length === 0) throw new Error("At least one curve segment sample is required");
    const keys = samples.map((sample) => `${sample.bodyId}:${sample.segmentEntityId}:${sample.normalizedParameter}`);
    if (new Set(keys).size !== keys.length) throw new Error("Curve segment samples must be unique");
    for (const sample of samples) {
      if (before.bodies.find((body) => body.id === sample.bodyId)?.type !== "Wire") {
        throw new Error(`Curve segment evaluation requires a current Wire body: ${sample.bodyId}`);
      }
      if (!Number.isInteger(sample.segmentEntityId) || sample.segmentEntityId <= 0) {
        throw new Error("Curve segment entity ID must be a positive integer");
      }
      if (!Number.isFinite(sample.normalizedParameter) || sample.normalizedParameter < 0 || sample.normalizedParameter > 1) {
        throw new Error("Curve segment normalized parameter must be from 0 to 1");
      }
    }
    const evaluated = await this.runtime.readNative<CurveSegmentSampleDescriptor[]>(`function (args) {
      const mm = value => value * 1000;
      const vector = value => [mm(value.x), mm(value.y), mm(value.z)];
      const direction = value => {
        const length = Math.hypot(value.x, value.y, value.z);
        if (!(length > 0)) throw new Error('Native curve tangent is zero');
        return [value.x / length, value.y / length, value.z / length];
      };
      const result = [];
      for (const reference of args.samples) {
        let found;
        for (const [versionId, item] of this.geo.geometryModel) {
          if (this.db.lookupStableId(versionId) === reference.bodyId) { found = [versionId, item]; break; }
        }
        if (!found || found[1].view?.constructor?.name !== 'Wire') throw new Error('Curve segment source is no longer a Wire: ' + reference.bodyId);
        const [versionId, item] = found;
        let edge;
        for (const candidate of Array.from(item.view.segments ?? [])) {
          const model = this.db.lookupTopologyItem(candidate);
          if (Number(model?.Id?.()) === reference.segmentEntityId) { edge = model; break; }
        }
        if (!edge) throw new Error('Stale or unknown curve segment: ' + reference.bodyId + ':' + reference.segmentEntityId);
        const evaluated = edge.GetPointAndTangent(reference.normalizedParameter);
        const wrapped = edge.GetCurve();
        const curve = wrapped?.curve ?? wrapped;
        result.push({
          reference,
          bodyVersionId: Number(versionId),
          curveType: String(curve?.constructor?.name ?? 'Unknown'),
          measurementSource: 'native-brep',
          positionMm: vector(evaluated.position),
          tangent: direction(evaluated.tangent),
        });
      }
      return result;
    }`, [], [{ samples }]);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while curve segments were being evaluated");
    }
    return { documentToken: after.documentToken, revision: after.revision, samples: evaluated };
  }

  async inspectCurveStructure(ids: number[], revision: string): Promise<{
    documentToken: string;
    revision: string;
    curves: CurveStructureDescriptor[];
  }> {
    const before = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one Wire ID is required");
    if (new Set(ids).size !== ids.length) throw new Error("Wire IDs must be unique");
    const selected = ids.map((id) => before.bodies.find((body) => body.id === id));
    const invalid = ids.filter((_id, index) => selected[index]?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve structure requires current Wire bodies: ${invalid.join(", ")}`);
    const curves = await this.runtime.readNative<CurveStructureDescriptor[]>(`function (args) {
      const countActiveCurveSpans = (${countActiveCurveSpans.toString()});
      const mm = value => value * 1000;
      const result = [];
      for (const wantedId of args.ids) {
        let found;
        for (const [versionId, item] of this.geo.geometryModel) {
          if (this.db.lookupStableId(versionId) === wantedId) { found = [versionId, item]; break; }
        }
        if (!found) throw new Error('Unknown current Wire ID: ' + wantedId);
        const [versionId, item] = found;
        if (item.view?.constructor?.name !== 'Wire') throw new Error('Curve structure requires a Wire: ' + wantedId);
        const edges = item.model?.GetEdges?.();
        const segments = [];
        for (let index = 0; index < (edges?.Size?.() ?? 0); index += 1) {
          const edge = edges.Get(index);
          const wrapped = edge.GetCurve();
          const nativeCurve = wrapped?.curve ?? wrapped;
          let info;
          try { info = nativeCurve?.GetInfo?.(); } catch {}
          const curveType = String(nativeCurve?.constructor?.name ?? 'Unknown');
          let circle = null;
          if (curveType === 'Circle' && info?.basis && Number.isFinite(info.radius) && info.radius > 0) {
            const axis = info.basis.Axis;
            const location = info.basis.Location;
            if ([axis?.x, axis?.y, axis?.z, location?.x, location?.y, location?.z].every(Number.isFinite)) {
              const axisLength = Math.hypot(axis.x, axis.y, axis.z);
              if (axisLength > 0) circle = {
                centerMm: [mm(location.x), mm(location.y), mm(location.z)],
                radiusMm: mm(info.radius),
                normal: [axis.x / axisLength, axis.y / axisLength, axis.z / axisLength],
              };
            }
          }
          let knots = null;
          let activeSpanCount = null;
          if (Number.isInteger(info?.numDistinctKnots) && info.numDistinctKnots > 0 && info?.knotVals && info?.knotMults) {
            const values = [];
            for (let knotIndex = 0; knotIndex < info.numDistinctKnots; knotIndex += 1) {
              const nativeParameter = Number(info.knotVals[knotIndex]);
              const multiplicity = Number(info.knotMults[knotIndex]);
              const normalizedParameter = Number(edge.Normalize(nativeParameter));
              if (!Number.isFinite(normalizedParameter) || !Number.isInteger(multiplicity)) { values.length = 0; break; }
              values.push({
                normalizedParameter,
                multiplicity,
                withinSegment: normalizedParameter >= -1e-12 && normalizedParameter <= 1 + 1e-12,
              });
            }
            if (values.length === info.numDistinctKnots) {
              knots = values;
              activeSpanCount = countActiveCurveSpans(values.filter(value => value.withinSegment).map(value => value.normalizedParameter));
            }
          }
          segments.push({
            entityId: Number(edge.Id()),
            curveType,
            lengthMm: mm(edge.FindLength().length),
            degree: Number.isInteger(info?.degree) ? Number(info.degree) : null,
            controlPointCount: Number.isInteger(info?.numVerts) ? Number(info.numVerts) : null,
            spanCount: Number.isInteger(info?.numSpans) ? Number(info.numSpans) : null,
            activeSpanCount,
            distinctKnotCount: Number.isInteger(info?.numDistinctKnots) ? Number(info.numDistinctKnots) : null,
            knots,
            rational: typeof info?.isRational === 'boolean' ? info.isRational : null,
            periodic: typeof info?.isPeriodic === 'boolean' ? info.isPeriodic : null,
            circle,
          });
        }
        result.push({ id: wantedId, versionId: Number(versionId), measurementSource: 'native-brep', segments });
      }
      return result;
    }`, [], [{ ids }]);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while curve structure was being inspected");
    }
    return { documentToken: after.documentToken, revision: after.revision, curves };
  }

  async inspectSurfaceStructure(faces: FaceReference[], revision: string): Promise<{
    documentToken: string;
    revision: string;
    surfaces: SurfaceStructureDescriptor[];
  }> {
    const before = await this.assertRevision(revision);
    requireTopologySelection(before, faces, "face");
    const invalidBodies = [...new Set(faces.map((reference) => reference.bodyId))].filter((bodyId) => {
      const type = before.bodies.find((body) => body.id === bodyId)?.type;
      return type !== "Solid" && type !== "Sheet";
    });
    if (invalidBodies.length > 0) throw new Error(`Surface structure requires current Solid or Sheet bodies: ${invalidBodies.join(", ")}`);
    const surfaces = await this.runtime.readNative<SurfaceStructureDescriptor[]>(`function (args) {
      const finiteBounds = value => value && ['uMin', 'uMax', 'vMin', 'vMax'].every(key => Number.isFinite(value[key]))
        ? { uMin: Number(value.uMin), uMax: Number(value.uMax), vMin: Number(value.vMin), vMax: Number(value.vMax) }
        : null;
      const result = [];
      for (const reference of args.faces) {
        let found;
        for (const [versionId, item] of this.geo.geometryModel) {
          if (this.db.lookupStableId(versionId) === reference.bodyId) { found = [versionId, item]; break; }
        }
        if (!found) throw new Error('Unknown current surface body ID: ' + reference.bodyId);
        const [versionId, item] = found;
        const faceViews = item.view?.high?.faces;
        const viewIndex = faceViews?.versionIds?.indexOf(reference.faceId) ?? -1;
        if (viewIndex < 0) throw new Error('Unknown current surface face: ' + reference.bodyId + ':' + reference.faceId);
        const faceView = faceViews.get(viewIndex);
        const nativeFaces = item.model?.GetFaces?.();
        let face;
        for (let index = 0; index < (nativeFaces?.Size?.() ?? 0); index += 1) {
          const candidate = nativeFaces.Get(index);
          if (candidate.Id() === faceView.entityId) { face = candidate; break; }
        }
        if (!face) throw new Error('Native surface face is unavailable: ' + reference.bodyId + ':' + reference.faceId);
        const carrier = face.GetSurface();
        const surface = carrier?.surface;
        if (!surface) throw new Error('Native carrier surface is unavailable: ' + reference.bodyId + ':' + reference.faceId);
        const faceBounds = finiteBounds(carrier);
        if (!faceBounds) throw new Error('Native face parameter bounds are unavailable: ' + reference.bodyId + ':' + reference.faceId);
        let info;
        try { info = surface.GetInfo(); } catch {}
        let naturalBounds;
        try { naturalBounds = finiteBounds(surface.GetUVBox()); } catch { naturalBounds = null; }
        const bSpline = surface.constructor?.name === 'BSurf' &&
          ['uDegree', 'vDegree', 'uSpans', 'vSpans', 'uVertices', 'vVertices'].every(key => Number.isInteger(info?.[key]))
          ? {
              uDegree: Number(info.uDegree), vDegree: Number(info.vDegree),
              uSpanCount: Number(info.uSpans), vSpanCount: Number(info.vSpans),
              uControlPointCount: Number(info.uVertices), vControlPointCount: Number(info.vVertices),
              rational: Boolean(info.isRational),
            }
          : null;
        result.push({
          bodyId: reference.bodyId,
          faceId: reference.faceId,
          bodyVersionId: Number(versionId),
          measurementSource: 'native-brep',
          surfaceType: String(surface.constructor?.name ?? 'Unknown'),
          trimmed: !face.IsUntrimmed(),
          faceParameterBounds: faceBounds,
          naturalParameterBounds: naturalBounds,
          bSpline,
        });
      }
      return result;
    }`, [], [{ faces }]);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while surface structure was being inspected");
    }
    return { documentToken: after.documentToken, revision: after.revision, surfaces };
  }

  async inspectCurvePlanarity(ids: number[], revision: string): Promise<{
    documentToken: string;
    revision: string;
    curves: CurvePlanarityDescriptor[];
  }> {
    const before = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one Wire ID is required");
    if (new Set(ids).size !== ids.length) throw new Error("Wire IDs must be unique");
    const invalid = ids.filter((id) => before.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve planarity requires current Wire bodies: ${invalid.join(", ")}`);
    const curves = await this.runtime.readNative<CurvePlanarityDescriptor[]>(`function (args) {
      const mm = value => value * 1000;
      const vector = value => [mm(value.x), mm(value.y), mm(value.z)];
      const direction = value => [value.x, value.y, value.z];
      const result = [];
      for (const wantedId of args.ids) {
        let found;
        for (const [versionId, item] of this.geo.geometryModel) {
          if (this.db.lookupStableId(versionId) === wantedId) { found = [versionId, item]; break; }
        }
        if (!found) throw new Error('Unknown current Wire ID: ' + wantedId);
        const [versionId, item] = found;
        if (item.view?.constructor?.name !== 'Wire') throw new Error('Curve planarity requires a Wire: ' + wantedId);
        const basis = item.model?.FindPlanarBasis?.();
        result.push({
          id: wantedId,
          versionId: Number(versionId),
          measurementSource: 'native-brep',
          planar: Boolean(basis),
          plane: basis ? { originMm: vector(basis.Location), normal: direction(basis.Axis) } : null,
        });
      }
      return result;
    }`, [], [{ ids }]);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while curve planarity was being inspected");
    }
    return { documentToken: after.documentToken, revision: after.revision, curves };
  }

  async listCurveControlPoints(ids: number[], revision: string): Promise<{
    documentToken: string;
    revision: string;
    curves: CurveControlPointDescriptor[];
  }> {
    const before = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one Wire ID is required");
    if (new Set(ids).size !== ids.length) throw new Error("Wire IDs must be unique");
    const invalid = ids.filter((id) => before.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve control points require current Wire bodies: ${invalid.join(", ")}`);
    const curves = await this.runtime.readNative<CurveControlPointDescriptor[]>(`function (SlideFactory, args) {
      const mm = value => value * 1000;
      const position = value => [mm(value.x), mm(value.y), mm(value.z)];
      const direction = value => [value.x, value.y, value.z];
      const slideDirections = (view, kind) => {
        try {
          const factory = new SlideFactory(this);
          if (kind === 'vertex') factory.vertices = [view];
          else factory.cvs = [view];
          const positiveU = direction(factory.orientation.posU);
          const negativeU = direction(factory.orientation.negU);
          if (![...positiveU, ...negativeU].every(Number.isFinite)) return null;
          if (Math.hypot(...positiveU) < 1e-12 || Math.hypot(...negativeU) < 1e-12) return null;
          return { positiveU, negativeU };
        } catch { return null; }
      };
      const result = [];
      let totalApproximationPoints = 0;
      for (const wantedId of args.ids) {
        let found;
        for (const [versionId, item] of this.geo.geometryModel) {
          if (this.db.lookupStableId(versionId) === wantedId) { found = [versionId, item]; break; }
        }
        if (!found) throw new Error('Unknown current Wire ID: ' + wantedId);
        const [versionId, item] = found;
        if (item.view?.constructor?.name !== 'Wire') throw new Error('Curve control points require a Wire: ' + wantedId);
        const boundaryVertices = Array.from(item.view.vertices ?? []).map(vertex => ({
          reference: { bodyId: wantedId, kind: 'vertex', pointId: Number(vertex.id) },
          versionId: String(vertex.versionId),
          positionMm: position(vertex.position),
          slideDirections: slideDirections(vertex, 'vertex'),
        }));
        const interiorControlPoints = Array.from(item.view.cvs ?? []).map(controlPoint => ({
          reference: { bodyId: wantedId, kind: 'control-point', pointId: Number(controlPoint.id) },
          versionId: String(controlPoint.versionId),
          positionMm: position(controlPoint.position),
          slideDirections: slideDirections(controlPoint, 'control-point'),
        }));
        result.push({
          id: wantedId,
          versionId: Number(versionId),
          positionSource: 'native-control-handle',
          boundaryVertices,
          interiorControlPoints,
        });
      }
      return result;
    }`, ["MultiSlideControlPointFactory"], [{ ids }]);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while curve control points were being listed");
    }
    return { documentToken: after.documentToken, revision: after.revision, curves };
  }

  async listCurveIntersections(): Promise<{
    documentToken: string;
    revision: string;
    intersections: CurveIntersectionDescriptor[];
  }> {
    const before = await this.state();
    const intersections = await this.runtime.read<CurveIntersectionDescriptor[]>(`function () {
      const mm = value => value * 1000;
      const result = new Map();
      for (const cross of this.crosses.crosses) {
        const sides = [cross.on1, cross.on2].map(on => {
          const versionId = Number(on.versionId);
          const item = this.geo.geometryModel.get(versionId);
          const bodyId = this.db.lookupStableId(versionId);
          if (!item || item.view?.constructor?.name !== 'Wire' || !Number.isInteger(bodyId)) return null;
          return { bodyId, versionId, edgeEntityId: Number(on.edgeId), parameter: Number(on.t) };
        });
        if (sides.some(side => side === null)) continue;
        sides.sort((left, right) => left.versionId - right.versionId || left.edgeEntityId - right.edgeEntityId || left.parameter - right.parameter);
        const [first, second] = sides;
        const id = first.versionId + ':' + first.edgeEntityId + '@' + first.parameter + '|' + second.versionId + ':' + second.edgeEntityId + '@' + second.parameter;
        result.set(id, {
          id,
          bodyIds: [first.bodyId, second.bodyId],
          bodyVersionIds: [first.versionId, second.versionId],
          edgeEntityIds: [first.edgeEntityId, second.edgeEntityId],
          measurementSource: 'native-brep',
          positionMm: [mm(cross.position.x), mm(cross.position.y), mm(cross.position.z)],
        });
      }
      return Array.from(result.values()).sort((left, right) => left.id.localeCompare(right.id));
    }`);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while curve intersections were being listed");
    }
    return { documentToken: after.documentToken, revision: after.revision, intersections };
  }

  async selectBodies(ids: number[], revision: string): Promise<PlasticitySelection> {
    return await this.selectNodes(ids, [], [], [], revision);
  }

  async selectCurves(ids: number[], revision: string): Promise<PlasticitySelection> {
    const state = await this.assertRevision(revision);
    requireWireBodyIds(state, ids);
    await this.runtime.read(`function (args) {
      ${findView}
      this.selection.selected.removeAll();
      for (const id of args.ids) this.selection.selected.addCurve(find(id));
    }`, [{ ids }]);
    return await this.selection();
  }

  async selectReferenceMeshes(ids: number[], revision: string): Promise<PlasticitySelection> {
    const state = await this.assertRevision(revision);
    requireReferenceMeshIds(state, ids);
    await this.runtime.read(`function (args) {
      const find = id => {
        const empty = this.db.lookupEmptyById(id);
        if (empty?.constructor?.name !== 'Empties_ObjectEmpty') throw new Error('Unknown native reference mesh ID: ' + id);
        return empty;
      };
      this.selection.selected.removeAll();
      for (const empty of args.ids.map(find)) this.selection.selected.addEmpty(empty);
    }`, [{ ids }]);
    return await this.selection();
  }

  async selectNodes(bodyIds: number[], instanceIds: number[], referenceMeshIds: number[], groupIds: number[], revision: string): Promise<PlasticitySelection> {
    const state = await this.assertRevision(revision);
    requireGroupSelection(state, bodyIds, instanceIds, referenceMeshIds, groupIds, true);
    await this.runtime.read(`function (args) {
      ${findView}
      const findEmpty = id => {
        const empty = this.db.lookupEmptyById(id);
        if (empty?.constructor?.name !== 'InstanceEmpty') throw new Error('Unknown native instance ID: ' + id);
        return empty;
      };
      const findReferenceMesh = id => {
        const empty = this.db.lookupEmptyById(id);
        if (empty?.constructor?.name !== 'Empties_ObjectEmpty') throw new Error('Unknown native reference mesh ID: ' + id);
        return empty;
      };
      const findGroup = id => {
        const group = this.db.groups.lookupById(id);
        if (!group) throw new Error('Unknown group ID: ' + id);
        return group;
      };
      this.selection.selected.removeAll();
      for (const view of args.bodyIds.map(find)) this.selection.selected.add(view);
      for (const empty of args.instanceIds.map(findEmpty)) this.selection.selected.addEmpty(empty);
      for (const empty of args.referenceMeshIds.map(findReferenceMesh)) this.selection.selected.addEmpty(empty);
      for (const group of args.groupIds.map(findGroup)) this.selection.selected.addGroup(group);
    }`, [{ bodyIds, instanceIds, referenceMeshIds, groupIds }]);
    return await this.selection();
  }

  async selectFaces(references: FaceReference[], revision: string): Promise<PlasticitySelection> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "face");
    await this.runtime.read(`function (args) {
      ${findView}
      this.selection.selected.removeAll();
      for (const reference of args.references) {
        const view = find(reference.bodyId);
        const index = view.high.faces.versionIds.indexOf(reference.faceId);
        if (index < 0) throw new Error('Unknown current face ID: ' + reference.faceId);
        this.selection.selected.addFace(view.high.faces.get(index));
      }
    }`, [{ references }]);
    return await this.selection();
  }

  async selectEdges(references: EdgeReference[], revision: string): Promise<PlasticitySelection> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "edge");
    await this.runtime.read(`function (args) {
      ${findView}
      this.selection.selected.removeAll();
      for (const reference of args.references) {
        const view = find(reference.bodyId);
        const index = view.high.edges.versionIds.indexOf(reference.edgeId);
        if (index < 0) throw new Error('Unknown current edge ID: ' + reference.edgeId);
        this.selection.selected.addEdge(view.high.edges.get(index));
      }
    }`, [{ references }]);
    return await this.selection();
  }

  async selectCurveControlPoints(references: CurveControlPointReference[], revision: string): Promise<PlasticitySelection> {
    await this.assertCurveControlPointReferences(references, revision);
    await this.runtime.read(`function (args) {
      ${findCurveControlPoints}
      this.selection.selected.removeAll();
      for (const vertex of vertices) this.selection.selected.addVertex(vertex);
      for (const controlPoint of cvs) this.selection.selected.addCurveCV(controlPoint);
    }`, [{ points: references }]);
    return await this.selection();
  }

  async alignPlanarFaces(
    ids: number[],
    sourceReference: FaceReference,
    targetReference: FaceReference,
    relation: "opposed" | "same",
    gapMm: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one moving body ID is required");
    if (new Set(ids).size !== ids.length) throw new Error("Moving body IDs must be unique");
    const currentBodyIds = new Set(state.bodies.map((body) => body.id));
    const missingIds = ids.filter((id) => !currentBodyIds.has(id));
    if (missingIds.length > 0) throw new Error(`Unknown current moving body IDs: ${missingIds.join(", ")}`);
    if (!ids.includes(sourceReference.bodyId)) throw new Error("The source face must belong to a moving body");
    if (ids.includes(targetReference.bodyId)) throw new Error("The target face must remain fixed during alignment");
    if (relation !== "opposed" && relation !== "same") throw new Error(`Unsupported planar-face relation: ${String(relation)}`);
    if (!Number.isFinite(gapMm)) throw new Error("Planar-face alignment gap must be finite");

    const sourceBody = state.bodies.find((body) => body.id === sourceReference.bodyId)!;
    const targetBody = state.bodies.find((body) => body.id === targetReference.bodyId);
    const sourceFace = sourceBody.faces.find((face) => face.id === sourceReference.faceId);
    const targetFace = targetBody?.faces.find((face) => face.id === targetReference.faceId);
    if (!sourceFace) throw new Error(`Unknown current source face: ${sourceReference.bodyId}:${sourceReference.faceId}`);
    if (!targetFace) throw new Error(`Unknown current target face: ${targetReference.bodyId}:${targetReference.faceId}`);
    if (!sourceFace.planar) throw new Error("The source face must be planar");
    if (!targetFace.planar) throw new Error("The target face must be planar");

    const sourceNormal = normalize(sourceFace.normal, "Source face normal");
    const fixedNormal = normalize(targetFace.normal, "Target face normal");
    const targetNormal = relation === "opposed" ? scale(fixedNormal, -1) : fixedNormal;
    const destinationMm = add(targetFace.centerMm, scale(fixedNormal, gapMm));
    const deltaMm = subtract(destinationMm, sourceFace.centerMm);
    await this.runtime.mutate(`async function (RotateFactory, MoveFactory, Vector, Quaternion, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const items = args.ids.map(find);
      this.selection.selected.removeAll();
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const sourceNormal = new Vector(...args.sourceNormal).normalize();
          const targetNormal = new Vector(...args.targetNormal).normalize();
          if (sourceNormal.dot(targetNormal) < 1 - 1e-12) {
            const rotate = new RotateFactory(editor).resource(this);
            rotate.items = items;
            rotate.pivot.fromArray(args.pivot);
            rotate.rotation.copy(new Quaternion().setFromUnitVectors(sourceNormal, targetNormal));
            await rotate.commit();
          }
          if (args.delta.some(value => Math.abs(value) > 1e-12)) {
            const move = new MoveFactory(editor).resource(this);
            move.items = args.ids.map(find);
            move.move.fromArray(args.delta);
            await move.commit();
          }
          return args.ids.map(find);
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["RotateItemAndEmptyFactory", "MoveItemAndEmptyFactory", "Vector3", "Quaternion"], [{
      ids,
      pivot: toMeters(sourceFace.centerMm),
      sourceNormal,
      targetNormal,
      delta: toMeters(deltaMm),
    }]);
    return await this.state();
  }

  async alignCylindricalFaces(
    ids: number[],
    sourceReference: FaceReference,
    targetReference: FaceReference,
    relation: "opposed" | "same",
    axialMode: "preserve" | "anchor",
    axialOffsetMm: number,
    rotationAroundAxisDeg: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one moving body ID is required");
    if (new Set(ids).size !== ids.length) throw new Error("Moving body IDs must be unique");
    const currentBodyIds = new Set(state.bodies.map((body) => body.id));
    const missingIds = ids.filter((id) => !currentBodyIds.has(id));
    if (missingIds.length > 0) throw new Error(`Unknown current moving body IDs: ${missingIds.join(", ")}`);
    if (!ids.includes(sourceReference.bodyId)) throw new Error("The source face must belong to a moving body");
    if (ids.includes(targetReference.bodyId)) throw new Error("The target face must remain fixed during alignment");
    if (relation !== "opposed" && relation !== "same") throw new Error(`Unsupported cylindrical-axis relation: ${String(relation)}`);
    if (axialMode !== "preserve" && axialMode !== "anchor") throw new Error(`Unsupported cylindrical axial mode: ${String(axialMode)}`);
    if (!Number.isFinite(axialOffsetMm)) throw new Error("Cylindrical axial offset must be finite");
    if (axialMode === "preserve" && axialOffsetMm !== 0) throw new Error("Cylindrical axial offset is available only in anchor mode");
    if (!Number.isFinite(rotationAroundAxisDeg)) throw new Error("Cylindrical rotation around axis must be finite");

    const sourceBody = state.bodies.find((body) => body.id === sourceReference.bodyId)!;
    const targetBody = state.bodies.find((body) => body.id === targetReference.bodyId);
    const sourceFace = sourceBody.faces.find((face) => face.id === sourceReference.faceId);
    const targetFace = targetBody?.faces.find((face) => face.id === targetReference.faceId);
    if (!sourceFace) throw new Error(`Unknown current source face: ${sourceReference.bodyId}:${sourceReference.faceId}`);
    if (!targetFace) throw new Error(`Unknown current target face: ${targetReference.bodyId}:${targetReference.faceId}`);
    if (sourceFace.surfaceType !== "Cylinder" || !sourceFace.axisOriginMm || !sourceFace.axisDirection) {
      throw new Error("The source face must be cylindrical with an exact native axis");
    }
    if (targetFace.surfaceType !== "Cylinder" || !targetFace.axisOriginMm || !targetFace.axisDirection) {
      throw new Error("The target face must be cylindrical with an exact native axis");
    }

    const sourceAxis = normalize(sourceFace.axisDirection, "Source cylinder axis");
    const fixedAxis = normalize(targetFace.axisDirection, "Target cylinder axis");
    const targetAxis = relation === "opposed" ? scale(fixedAxis, -1) : fixedAxis;
    const betweenOrigins = subtract(targetFace.axisOriginMm, sourceFace.axisOriginMm);
    const deltaMm = axialMode === "anchor"
      ? subtract(add(targetFace.axisOriginMm, scale(fixedAxis, axialOffsetMm)), sourceFace.axisOriginMm)
      : subtract(betweenOrigins, scale(fixedAxis, betweenOrigins.reduce((sum, value, index) => sum + value * fixedAxis[index]!, 0)));
    await this.runtime.mutate(`async function (RotateFactory, MoveFactory, Vector, Quaternion, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const items = args.ids.map(find);
      this.selection.selected.removeAll();
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const sourceAxis = new Vector(...args.sourceAxis).normalize();
          const targetAxis = new Vector(...args.targetAxis).normalize();
          if (sourceAxis.dot(targetAxis) < 1 - 1e-12) {
            const rotate = new RotateFactory(editor).resource(this);
            rotate.items = items;
            rotate.pivot.fromArray(args.pivot);
            rotate.rotation.copy(new Quaternion().setFromUnitVectors(sourceAxis, targetAxis));
            await rotate.commit();
          }
          if (args.delta.some(value => Math.abs(value) > 1e-12)) {
            const move = new MoveFactory(editor).resource(this);
            move.items = args.ids.map(find);
            move.move.fromArray(args.delta);
            await move.commit();
          }
          if (Math.abs(args.rollRadians) > 1e-12) {
            const roll = new RotateFactory(editor).resource(this);
            roll.items = args.ids.map(find);
            roll.pivot.fromArray(args.targetOrigin);
            roll.rotation.copy(new Quaternion().setFromAxisAngle(new Vector(...args.fixedAxis).normalize(), args.rollRadians));
            await roll.commit();
          }
          return args.ids.map(find);
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["RotateItemAndEmptyFactory", "MoveItemAndEmptyFactory", "Vector3", "Quaternion"], [{
      ids,
      pivot: toMeters(sourceFace.axisOriginMm),
      sourceAxis,
      targetAxis,
      fixedAxis,
      delta: toMeters(deltaMm),
      targetOrigin: toMeters(targetFace.axisOriginMm),
      rollRadians: degreesToRadians(rotationAroundAxisDeg),
    }]);
    return await this.state();
  }

  async alignVertices(
    ids: number[],
    sourceReference: VertexReference,
    targetReference: VertexReference,
    offsetMm: Vector3,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one moving body ID is required");
    if (new Set(ids).size !== ids.length) throw new Error("Moving body IDs must be unique");
    const currentBodyIds = new Set(state.bodies.map((body) => body.id));
    const missingIds = ids.filter((id) => !currentBodyIds.has(id));
    if (missingIds.length > 0) throw new Error(`Unknown current moving body IDs: ${missingIds.join(", ")}`);
    if (!ids.includes(sourceReference.bodyId)) throw new Error("The source vertex must belong to a moving body");
    if (ids.includes(targetReference.bodyId)) throw new Error("The target vertex must remain fixed during alignment");
    if (offsetMm.some((value) => !Number.isFinite(value))) throw new Error("Vertex alignment offset must be finite");
    requireVertexReference(state, sourceReference, "Source vertex");
    requireVertexReference(state, targetReference, "Target vertex");
    const sourceVertex = state.bodies.find((body) => body.id === sourceReference.bodyId)!.vertices!
      .find((vertex) => vertex.id === sourceReference.vertexId)!;
    const targetVertex = state.bodies.find((body) => body.id === targetReference.bodyId)!.vertices!
      .find((vertex) => vertex.id === targetReference.vertexId)!;
    const destinationMm = add(targetVertex.positionMm, offsetMm);
    const deltaMm = subtract(destinationMm, sourceVertex.positionMm);
    if (!deltaMm.some((value) => Math.abs(value) > 1e-12)) {
      throw new Error("Vertex alignment would not move the selected bodies");
    }

    await this.runtime.mutate(`async function (MoveFactory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const items = args.ids.map(find);
      this.selection.selected.removeAll();
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const move = new MoveFactory(editor).resource(this);
          move.items = items;
          move.move.fromArray(args.delta);
          await move.commit();
          return args.ids.map(find);
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["MoveItemAndEmptyFactory"], [{ ids, delta: toMeters(deltaMm) }]);
    return await this.state();
  }

  async alignLinearEdges(
    ids: number[],
    sourceReference: EdgeReference,
    targetReference: EdgeReference,
    relation: "opposed" | "same",
    axialOffsetMm: number,
    rotationAroundAxisDeg: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one moving body ID is required");
    if (new Set(ids).size !== ids.length) throw new Error("Moving body IDs must be unique");
    const currentBodyIds = new Set(state.bodies.map((body) => body.id));
    const missingIds = ids.filter((id) => !currentBodyIds.has(id));
    if (missingIds.length > 0) throw new Error(`Unknown current moving body IDs: ${missingIds.join(", ")}`);
    if (!ids.includes(sourceReference.bodyId)) throw new Error("The source edge must belong to a moving body");
    if (ids.includes(targetReference.bodyId)) throw new Error("The target edge must remain fixed during alignment");
    if (relation !== "opposed" && relation !== "same") throw new Error(`Unsupported linear-edge relation: ${String(relation)}`);
    if (!Number.isFinite(axialOffsetMm)) throw new Error("Linear-edge axial offset must be finite");
    if (!Number.isFinite(rotationAroundAxisDeg)) throw new Error("Linear-edge rotation around axis must be finite");

    const sourceBody = state.bodies.find((body) => body.id === sourceReference.bodyId)!;
    const targetBody = state.bodies.find((body) => body.id === targetReference.bodyId);
    const sourceEdge = sourceBody.edges.find((edge) => edge.id === sourceReference.edgeId);
    const targetEdge = targetBody?.edges.find((edge) => edge.id === targetReference.edgeId);
    if (!sourceEdge) throw new Error(`Unknown current source edge: ${sourceReference.bodyId}:${sourceReference.edgeId}`);
    if (!targetEdge) throw new Error(`Unknown current target edge: ${targetReference.bodyId}:${targetReference.edgeId}`);
    if (!sourceEdge.line) throw new Error("The source edge must be an exact native Line");
    if (!targetEdge.line) throw new Error("The target edge must be an exact native Line");

    const sourceDirection = normalize(sourceEdge.tangent, "Source edge tangent");
    const fixedDirection = normalize(targetEdge.tangent, "Target edge tangent");
    const targetDirection = relation === "opposed" ? scale(fixedDirection, -1) : fixedDirection;
    const destinationMm = add(targetEdge.centerMm, scale(fixedDirection, axialOffsetMm));
    const deltaMm = subtract(destinationMm, sourceEdge.centerMm);
    const directionAlreadyAligned = dot(sourceDirection, targetDirection) >= 1 - 1e-12;
    const translationRequired = deltaMm.some((value) => Math.abs(value) > 1e-12);
    if (directionAlreadyAligned && !translationRequired && Math.abs(rotationAroundAxisDeg) <= 1e-12) {
      throw new Error("Linear-edge alignment would not transform the selected bodies");
    }

    await this.runtime.mutate(`async function (RotateFactory, MoveFactory, Vector, Quaternion, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const items = args.ids.map(find);
      this.selection.selected.removeAll();
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const sourceDirection = new Vector(...args.sourceDirection).normalize();
          const targetDirection = new Vector(...args.targetDirection).normalize();
          if (sourceDirection.dot(targetDirection) < 1 - 1e-12) {
            const rotate = new RotateFactory(editor).resource(this);
            rotate.items = items;
            rotate.pivot.fromArray(args.sourcePivot);
            rotate.rotation.copy(new Quaternion().setFromUnitVectors(sourceDirection, targetDirection));
            await rotate.commit();
          }
          if (args.delta.some(value => Math.abs(value) > 1e-12)) {
            const move = new MoveFactory(editor).resource(this);
            move.items = args.ids.map(find);
            move.move.fromArray(args.delta);
            await move.commit();
          }
          if (Math.abs(args.rollRadians) > 1e-12) {
            const roll = new RotateFactory(editor).resource(this);
            roll.items = args.ids.map(find);
            roll.pivot.fromArray(args.targetPivot);
            roll.rotation.copy(new Quaternion().setFromAxisAngle(new Vector(...args.fixedDirection).normalize(), args.rollRadians));
            await roll.commit();
          }
          return args.ids.map(find);
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["RotateItemAndEmptyFactory", "MoveItemAndEmptyFactory", "Vector3", "Quaternion"], [{
      ids,
      sourcePivot: toMeters(sourceEdge.centerMm),
      targetPivot: toMeters(destinationMm),
      sourceDirection,
      targetDirection,
      fixedDirection,
      delta: toMeters(deltaMm),
      rollRadians: degreesToRadians(rotationAroundAxisDeg),
    }]);
    return await this.state();
  }

  async createBox(originMm: Vector3, sizeMm: Vector3, name?: string, revision?: string): Promise<RuntimeState> {
    if (revision) await this.assertRevision(revision);
    const origin = toMeters(originMm);
    const size = toMeters(sizeMm);
    await this.runtime.mutate(`async function (Factory, Vector, args) {
      ${commandStart("ThreePointBoxCommand")}
      const [x, y, z] = args.origin;
      const [width, depth, height] = args.size;
      factory.p1 = new Vector(x, y, z);
      factory.p2 = new Vector(x + width, y, z);
      factory.p3 = new Vector(x + width, y + depth, z);
      factory.p4 = new Vector(x + width, y + depth, z + height);
      const created = await factory.commit();
      if (args.name && created) for (const view of (Array.isArray(created) ? created : [created])) editor.db.nodes.setName(editor.db.nodes.item2key(view), args.name);
      return created;
      } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["ThreePointBoxFactory", "Vector3"], [{ origin, size, name: name ?? null }]);
    return await this.state();
  }

  async createSphere(centerMm: Vector3, radiusMm: number, name?: string, revision?: string): Promise<RuntimeState> {
    if (revision) await this.assertRevision(revision);
    await this.runtime.mutate(`async function (Factory, args) {
      ${commandStart("SphereCommand")}
      factory.center.fromArray(args.center);
      factory.radius = args.radius;
      const created = await factory.commit();
      if (args.name && created) for (const view of (Array.isArray(created) ? created : [created])) editor.db.nodes.setName(editor.db.nodes.item2key(view), args.name);
      return created;
      } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["PossiblyBooleanSphereFactory"], [{ center: toMeters(centerMm), radius: millimetersToMeters(radiusMm), name: name ?? null }]);
    return await this.state();
  }

  async createCylinder(centerMm: Vector3, radiusMm: number, heightMm: number, name?: string, revision?: string, axis: Vector3 = [0, 0, 1]): Promise<RuntimeState> {
    if (revision) await this.assertRevision(revision);
    await this.runtime.mutate(`async function (Factory, Vector, Quaternion, args) {
      ${commandStart("CylinderCommand")}
      factory.center.fromArray(args.center);
      factory.orientation.copy(new Quaternion().setFromUnitVectors(new Vector(0, 0, 1), new Vector(...args.axis).normalize()));
      factory.radius = args.radius;
      factory.height = args.height;
      const created = await factory.commit();
      if (args.name && created) for (const view of (Array.isArray(created) ? created : [created])) editor.db.nodes.setName(editor.db.nodes.item2key(view), args.name);
      return created;
      } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["PossiblyBooleanCylinderFactory", "Vector3", "Quaternion"], [{ center: toMeters(centerMm), radius: millimetersToMeters(radiusMm), height: millimetersToMeters(heightMm), name: name ?? null, axis }]);
    return await this.state();
  }

  async createCone(
    bottomCenterMm: Vector3,
    bottomRadiusMm: number,
    topRadiusMm: number,
    heightMm: number,
    axis: Vector3,
    radialDirection: Vector3,
    name: string | undefined,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (!Number.isFinite(bottomRadiusMm) || bottomRadiusMm <= 0) throw new Error("Cone bottom radius must be positive");
    if (!Number.isFinite(topRadiusMm) || topRadiusMm < 0) throw new Error("Cone top radius must be nonnegative");
    if (!Number.isFinite(heightMm) || heightMm <= 0) throw new Error("Cone height must be positive");
    if (Math.abs(bottomRadiusMm - topRadiusMm) <= 1e-9) {
      throw new Error("Cone and frustum require unequal radii; use a cylinder for equal radii");
    }
    const frame = frameFromOriginNormalX(bottomCenterMm, axis, radialDirection);
    const bottomOuterMm = add(frame.originMm, scale(frame.xDirection, bottomRadiusMm));
    const topCenterMm = add(frame.originMm, scale(frame.normal, heightMm));
    const profilePointsMm = topRadiusMm === 0
      ? [frame.originMm, bottomOuterMm, topCenterMm]
      : [frame.originMm, bottomOuterMm, add(topCenterMm, scale(frame.xDirection, topRadiusMm)), topCenterMm];
    await this.runtime.mutate(`async function (CurveFactory, RevolveFactory, Vector, CurveType, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.RevolveCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const existingRegionIds = new Set();
          for (const [versionId, item] of editor.geo.geometryModel) {
            if (!editor.geo.automatics.has(versionId) || item.view?.constructor?.name !== 'SketchIsland') continue;
            for (let index = 0; index < (item.view.regions?.length ?? 0); index += 1) {
              const region = item.view.regions.get(index);
              if (region) existingRegionIds.add(String(region.versionId));
            }
          }
          const profile = new CurveFactory(editor).resource(this);
          profile.points = args.points.map(point => new Vector(...point));
          profile.type = CurveType.Polyline;
          profile.closed = true;
          let profiles = await profile.commit();
          profiles = Array.isArray(profiles) ? profiles : [profiles];
          const regions = [];
          for (const [versionId, item] of editor.geo.geometryModel) {
            if (!editor.geo.automatics.has(versionId) || item.view?.constructor?.name !== 'SketchIsland') continue;
            for (let index = 0; index < (item.view.regions?.length ?? 0); index += 1) {
              const region = item.view.regions.get(index);
              if (region && !existingRegionIds.has(String(region.versionId))) regions.push(region);
            }
          }
          if (regions.length !== 1) throw new Error('Cone profile did not create exactly one native Region');
          const revolve = new RevolveFactory(editor).resource(this);
          revolve.regions = regions;
          revolve.origin.fromArray(args.center);
          revolve.axis.fromArray(args.axis).normalize();
          revolve.degrees = 360;
          let created = await revolve.commit();
          created = Array.isArray(created) ? created : [created];
          if (args.name) {
            for (const view of profiles) editor.db.nodes.setName(editor.db.nodes.item2key(view), args.name + ' profile');
            for (const view of created) editor.db.nodes.setName(editor.db.nodes.item2key(view), args.name);
          }
          return created;
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["CurveFactory", "RevolveFactory", "Vector3", "CurveType"], [{
      points: profilePointsMm.map(toMeters),
      center: toMeters(frame.originMm),
      axis: frame.normal,
      name: name ?? null,
    }]);
    return await this.state();
  }

  async createTorus(
    centerMm: Vector3,
    majorRadiusMm: number,
    minorRadiusMm: number,
    axis: Vector3,
    radialDirection: Vector3,
    name: string | undefined,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (!Number.isFinite(minorRadiusMm) || minorRadiusMm <= 0) throw new Error("Torus minor radius must be positive");
    if (!Number.isFinite(majorRadiusMm) || majorRadiusMm <= minorRadiusMm) {
      throw new Error("Ring-torus major radius must be greater than its minor radius");
    }
    const frame = frameFromOriginNormalX(centerMm, axis, radialDirection);
    const profileCenterMm = add(frame.originMm, scale(frame.xDirection, majorRadiusMm));
    await this.runtime.mutate(`async function (CircleFactory, RevolveFactory, Vector, Quaternion, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.RevolveCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const profile = new CircleFactory(editor).resource(this);
          profile.center.fromArray(args.profileCenter);
          profile.orientation.copy(new Quaternion().setFromUnitVectors(
            new Vector(0, 0, 1),
            new Vector(...args.profileNormal).normalize(),
          ));
          profile.point.copy(profile.center).add(new Vector(args.minorRadius, 0, 0).applyQuaternion(profile.orientation));
          let profiles = await profile.commit();
          profiles = Array.isArray(profiles) ? profiles : [profiles];
          const revolve = new RevolveFactory(editor).resource(this);
          revolve.curves = profiles;
          revolve.origin.fromArray(args.center);
          revolve.axis.fromArray(args.axis).normalize();
          revolve.degrees = 360;
          let created = await revolve.commit();
          created = Array.isArray(created) ? created : [created];
          if (args.name) {
            for (const view of profiles) editor.db.nodes.setName(editor.db.nodes.item2key(view), args.name + ' profile');
            for (const view of created) editor.db.nodes.setName(editor.db.nodes.item2key(view), args.name);
          }
          return created;
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["CenterCircleFactory", "RevolveFactory", "Vector3", "Quaternion"], [{
      center: toMeters(frame.originMm),
      profileCenter: toMeters(profileCenterMm),
      profileNormal: frame.yDirection,
      axis: frame.normal,
      minorRadius: millimetersToMeters(minorRadiusMm),
      name: name ?? null,
    }]);
    return await this.state();
  }

  async createPolyline(
    pointsMm: Vector3[] | Vector2[],
    closed: boolean,
    revision?: string,
    plane?: ReferenceIdentity,
  ): Promise<RuntimeState> {
    let worldPoints: Vector3[];
    if (plane) {
      const resolvedPlane = await this.resolveCurrentPlane(plane, revision);
      worldPoints = pointsMm.map((point) => {
        if (point.length !== 2) throw new Error("Plane-local polyline points must contain two coordinates");
        return localPointToWorld(resolvedPlane, point);
      });
    } else {
      if (pointsMm.some((point) => point.length !== 3)) throw new Error("World-space polyline points must contain three coordinates");
      if (revision) await this.assertRevision(revision);
      worldPoints = pointsMm as Vector3[];
    }
    await this.runtime.mutate(`async function (Factory, Vector, CurveType, args) {
      ${commandStart("CurveCommand")}
      factory.points = args.points.map(point => new Vector(...point));
      factory.type = CurveType.Polyline;
      factory.closed = args.closed;
      ${commandEnd}
    }`, ["CurveFactory", "Vector3", "CurveType"], [{ points: worldPoints.map(toMeters), closed }]);
    return await this.state();
  }

  async createNurbsCurve(pointsMm: Vector3[], closed: boolean, revision?: string): Promise<RuntimeState> {
    if (pointsMm.length < 3) throw new Error("NURBS curve requires at least three interpolation points");
    if (revision) await this.assertRevision(revision);
    await this.runtime.mutate(`async function (Factory, Vector, CurveType, args) {
      ${commandStart("CurveCommand")}
      factory.points = args.points.map(point => new Vector(...point));
      factory.type = CurveType.NURBS;
      factory.closed = args.closed;
      ${commandEnd}
    }`, ["CurveFactory", "Vector3", "CurveType"], [{ points: pointsMm.map(toMeters), closed }]);
    return await this.state();
  }

  async createHelix(
    axisStartMm: Vector3,
    axisEndMm: Vector3,
    radiusMm: number,
    turns: number,
    radialDirection: Vector3,
    handedness: "right" | "left",
    revision?: string,
  ): Promise<RuntimeState> {
    if (revision) await this.assertRevision(revision);
    if (!Number.isFinite(radiusMm) || radiusMm <= 0) throw new Error("Helix radius must be positive");
    if (!Number.isFinite(turns) || turns <= 0) throw new Error("Helix turns must be positive");
    const axis = axisEndMm.map((value, index) => value - axisStartMm[index]!) as Vector3;
    const axisLength = Math.hypot(...axis);
    if (!(axisLength > 1e-9)) throw new Error("Helix axis must have nonzero length");
    const axisUnit = axis.map((value) => value / axisLength) as Vector3;
    const projection = radialDirection.reduce((sum, value, index) => sum + value * axisUnit[index]!, 0);
    const radial = radialDirection.map((value, index) => value - projection * axisUnit[index]!) as Vector3;
    const radialLength = Math.hypot(...radial);
    if (!(radialLength > 1e-9)) throw new Error("Helix radial direction must not be parallel to its axis");
    const radiusPointMm = axisEndMm.map((value, index) => value + radial[index]! / radialLength * radiusMm) as Vector3;
    await this.runtime.mutate(`async function (Factory, Vector, args) {
      ${commandStart("SpiralCommand")}
      factory.p1 = new Vector(...args.axisStart);
      factory.p2 = new Vector(...args.axisEnd);
      factory.p3 = new Vector(...args.radiusPoint);
      factory.radius = args.radius;
      factory.turns = args.turns;
      factory.spiralPitch = 0;
      factory.handedness = args.handedness;
      ${commandEnd}
    }`, ["SpiralFactory", "Vector3"], [{
      axisStart: toMeters(axisStartMm),
      axisEnd: toMeters(axisEndMm),
      radiusPoint: toMeters(radiusPointMm),
      radius: millimetersToMeters(radiusMm),
      turns,
      handedness: handedness === "right",
    }]);
    return await this.state();
  }

  async createCircle(
    centerMm: Vector3 | Vector2,
    radiusMm: number,
    revision?: string,
    normal: Vector3 = [0, 0, 1],
    plane?: ReferenceIdentity,
  ): Promise<RuntimeState> {
    let worldCenter: Vector3;
    let worldNormal = normal;
    if (plane) {
      if (centerMm.length !== 2) throw new Error("Plane-local circle centers must contain two coordinates");
      const resolvedPlane = await this.resolveCurrentPlane(plane, revision);
      worldCenter = localPointToWorld(resolvedPlane, centerMm);
      worldNormal = resolvedPlane.normal;
    } else {
      if (centerMm.length !== 3) throw new Error("World-space circle centers must contain three coordinates");
      if (revision) await this.assertRevision(revision);
      worldCenter = centerMm;
    }
    await this.runtime.mutate(`async function (Factory, Vector, Quaternion, args) {
      ${commandStart("CenterCircleCommand")}
      factory.center.fromArray(args.center);
      factory.orientation.copy(new Quaternion().setFromUnitVectors(new Vector(0, 0, 1), new Vector(...args.normal).normalize()));
      factory.point.copy(factory.center).add(new Vector(args.radius, 0, 0).applyQuaternion(factory.orientation));
      ${commandEnd}
    }`, ["CenterCircleFactory", "Vector3", "Quaternion"], [{ center: toMeters(worldCenter), radius: millimetersToMeters(radiusMm), normal: worldNormal }]);
    return await this.state();
  }

  async createTwoPointCircle(
    diameterStartMm: Vector3 | Vector2,
    diameterEndMm: Vector3 | Vector2,
    revision?: string,
    normal: Vector3 = [0, 0, 1],
    plane?: ReferenceIdentity,
  ): Promise<RuntimeState> {
    let diameterStart: Vector3;
    let diameterEnd: Vector3;
    let worldNormal: Vector3;
    if (plane) {
      if (diameterStartMm.length !== 2 || diameterEndMm.length !== 2) {
        throw new Error("Plane-local two-point circle endpoints must contain two coordinates");
      }
      const resolvedPlane = await this.resolveCurrentPlane(plane, revision);
      diameterStart = localPointToWorld(resolvedPlane, diameterStartMm);
      diameterEnd = localPointToWorld(resolvedPlane, diameterEndMm);
      worldNormal = normalize(resolvedPlane.normal, "Two-point circle plane normal");
    } else {
      if (diameterStartMm.length !== 3 || diameterEndMm.length !== 3) {
        throw new Error("World-space two-point circle endpoints must contain three coordinates");
      }
      if (revision) await this.assertRevision(revision);
      diameterStart = diameterStartMm;
      diameterEnd = diameterEndMm;
      worldNormal = normalize(normal, "Two-point circle plane normal");
    }
    const diameter = subtract(diameterEnd, diameterStart);
    const diameterLength = Math.hypot(...diameter);
    if (diameterLength <= 1e-9) throw new Error("Two-point circle diameter endpoints must be distinct");
    if (Math.abs(dot(diameter, worldNormal)) > diameterLength * 1e-9) {
      throw new Error("Two-point circle plane normal must be perpendicular to its diameter");
    }
    await this.runtime.mutate(`async function (Factory, Vector, Quaternion, args) {
      ${commandStart("TwoPointCircleCommand")}
      factory.isKnife = false;
      factory.orientation.copy(new Quaternion().setFromUnitVectors(new Vector(0, 0, 1), new Vector(...args.normal).normalize()));
      factory.p1.fromArray(args.diameterStart);
      factory.p2.fromArray(args.diameterEnd);
      ${commandEnd}
    }`, ["KnifeTwoPointCircleFactory", "Vector3", "Quaternion"], [{
      diameterStart: toMeters(diameterStart),
      diameterEnd: toMeters(diameterEnd),
      normal: worldNormal,
    }]);
    return await this.state();
  }

  async createThreePointCircle(
    firstMm: Vector3 | Vector2,
    secondMm: Vector3 | Vector2,
    thirdMm: Vector3 | Vector2,
    revision?: string,
    plane?: ReferenceIdentity,
  ): Promise<RuntimeState> {
    let first: Vector3;
    let second: Vector3;
    let third: Vector3;
    if (plane) {
      if (firstMm.length !== 2 || secondMm.length !== 2 || thirdMm.length !== 2) {
        throw new Error("Plane-local three-point circle points must contain two coordinates");
      }
      const resolvedPlane = await this.resolveCurrentPlane(plane, revision);
      first = localPointToWorld(resolvedPlane, firstMm);
      second = localPointToWorld(resolvedPlane, secondMm);
      third = localPointToWorld(resolvedPlane, thirdMm);
    } else {
      if (firstMm.length !== 3 || secondMm.length !== 3 || thirdMm.length !== 3) {
        throw new Error("World-space three-point circle points must contain three coordinates");
      }
      if (revision) await this.assertRevision(revision);
      first = firstMm;
      second = secondMm;
      third = thirdMm;
    }
    threePointCircleGeometry(first, second, third, "Three-point circle");
    await this.runtime.mutate(`async function (Factory, args) {
      ${commandStart("ThreePointCircleCommand")}
      factory.isKnife = false;
      factory.p1.fromArray(args.first);
      factory.p2.fromArray(args.second);
      factory.p3.fromArray(args.third);
      ${commandEnd}
    }`, ["KnifeThreePointCircleFactory"], [{
      first: toMeters(first),
      second: toMeters(second),
      third: toMeters(third),
    }]);
    return await this.state();
  }

  async createCenterArc(
    centerMm: Vector3 | Vector2,
    radiusMm: number,
    startAngleDegrees: number,
    sweepAngleDegrees: number,
    revision?: string,
    normal: Vector3 = [0, 0, 1],
    xDirection: Vector3 = [1, 0, 0],
    plane?: ReferenceIdentity,
  ): Promise<RuntimeState> {
    if (!Number.isFinite(radiusMm) || radiusMm <= 0) throw new Error("Arc radius must be positive");
    if (!Number.isFinite(startAngleDegrees)) throw new Error("Arc start angle must be finite");
    if (!Number.isFinite(sweepAngleDegrees) || sweepAngleDegrees === 0 || Math.abs(sweepAngleDegrees) >= 360) {
      throw new Error("Arc sweep angle must be nonzero and have magnitude less than 360 degrees");
    }
    let worldCenter: Vector3;
    let baseX: Vector3;
    let baseY: Vector3;
    let worldNormal: Vector3;
    if (plane) {
      if (centerMm.length !== 2) throw new Error("Plane-local arc centers must contain two coordinates");
      const resolvedPlane = await this.resolveCurrentPlane(plane, revision);
      worldCenter = localPointToWorld(resolvedPlane, centerMm);
      baseX = resolvedPlane.xDirection;
      baseY = resolvedPlane.yDirection;
      worldNormal = resolvedPlane.normal;
    } else {
      if (centerMm.length !== 3) throw new Error("World-space arc centers must contain three coordinates");
      if (revision) await this.assertRevision(revision);
      const frame = frameFromOriginNormalX(centerMm, normal, xDirection);
      worldCenter = frame.originMm;
      baseX = frame.xDirection;
      baseY = frame.yDirection;
      worldNormal = frame.normal;
    }
    const pointAt = (degrees: number): Vector3 => {
      const radians = degreesToRadians(degrees);
      return add(worldCenter, scale(add(scale(baseX, Math.cos(radians)), scale(baseY, Math.sin(radians))), radiusMm));
    };
    const start = pointAt(startAngleDegrees);
    const end = pointAt(startAngleDegrees + sweepAngleDegrees);
    await this.runtime.mutate(`async function (Factory, Vector, Quaternion, args) {
      ${commandStart("CenterPointArcCommand")}
      factory.isKnife = false;
      factory.center.fromArray(args.center);
      factory.orientation.copy(new Quaternion().setFromUnitVectors(new Vector(0, 0, 1), new Vector(...args.normal).normalize()));
      factory.p2.fromArray(args.start);
      factory.p3.fromArray(args.end);
      factory.lastSense = true;
      ${commandEnd}
    }`, ["KnifeCenterPointArcFactory", "Vector3", "Quaternion"], [{
      center: toMeters(worldCenter),
      start: toMeters(start),
      end: toMeters(end),
      normal: sweepAngleDegrees > 0 ? worldNormal : scale(worldNormal, -1),
    }]);
    return await this.state();
  }

  async createThreePointArc(
    startMm: Vector3 | Vector2,
    throughMm: Vector3 | Vector2,
    endMm: Vector3 | Vector2,
    revision?: string,
    plane?: ReferenceIdentity,
  ): Promise<RuntimeState> {
    let start: Vector3;
    let through: Vector3;
    let end: Vector3;
    if (plane) {
      if (startMm.length !== 2 || throughMm.length !== 2 || endMm.length !== 2) {
        throw new Error("Plane-local three-point arc points must contain two coordinates");
      }
      const resolvedPlane = await this.resolveCurrentPlane(plane, revision);
      start = localPointToWorld(resolvedPlane, startMm);
      through = localPointToWorld(resolvedPlane, throughMm);
      end = localPointToWorld(resolvedPlane, endMm);
    } else {
      if (startMm.length !== 3 || throughMm.length !== 3 || endMm.length !== 3) {
        throw new Error("World-space three-point arc points must contain three coordinates");
      }
      if (revision) await this.assertRevision(revision);
      start = startMm;
      through = throughMm;
      end = endMm;
    }
    const { center, normal } = threePointCircleGeometry(start, through, end, "Three-point arc");
    await this.runtime.mutate(`async function (Factory, Vector, Quaternion, args) {
      ${commandStart("ThreePointArcCommand")}
      factory.isKnife = false;
      factory.center.fromArray(args.center);
      factory.orientation.copy(new Quaternion().setFromUnitVectors(new Vector(0, 0, 1), new Vector(...args.normal).normalize()));
      factory.p2.fromArray(args.start);
      factory.p3.fromArray(args.end);
      factory.lastSense = true;
      ${commandEnd}
    }`, ["KnifeCenterPointArcFactory", "Vector3", "Quaternion"], [{
      center: toMeters(center),
      start: toMeters(start),
      end: toMeters(end),
      normal,
    }]);
    return await this.state();
  }

  async createTangentArc(
    bodyId: number,
    segmentEntityId: number,
    startAt: "start" | "end",
    endMm: Vector3 | Vector2,
    flipTangent: boolean,
    revision: string,
    plane?: ReferenceIdentity,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (state.bodies.find((body) => body.id === bodyId)?.type !== "Wire") {
      throw new Error(`Tangent arc requires a current Wire body: ${bodyId}`);
    }
    if (!Number.isInteger(segmentEntityId) || segmentEntityId <= 0) {
      throw new Error("Tangent arc segment entity ID must be a positive integer");
    }
    let worldEnd: Vector3;
    if (plane) {
      if (endMm.length !== 2) throw new Error("Plane-local tangent arc end must contain two coordinates");
      const resolvedPlane = await this.resolveCurrentPlane(plane, revision);
      worldEnd = localPointToWorld(resolvedPlane, endMm);
    } else {
      if (endMm.length !== 3) throw new Error("World-space tangent arc end must contain three coordinates");
      worldEnd = endMm;
    }
    await this.runtime.mutate(`async function (Factory, Vector, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const wire = find(args.bodyId);
      if (wire?.constructor?.name !== 'Wire') throw new Error('Tangent arc source is no longer a Wire');
      let segment;
      let edge;
      for (const candidate of Array.from(wire.segments ?? [])) {
        const model = editor.db.lookupTopologyItem(candidate);
        if (Number(model?.Id?.()) !== args.segmentEntityId) continue;
        segment = candidate;
        edge = model;
        break;
      }
      if (!segment || !edge) throw new Error('Stale or unknown tangent arc segment: ' + args.segmentEntityId);
      const parameter = args.startAt === 'start' ? 0 : 1;
      const anchor = edge.GetPointAndTangent(parameter);
      const endpoint = new Vector(...args.end);
      const dx = endpoint.x - anchor.position.x;
      const dy = endpoint.y - anchor.position.y;
      const dz = endpoint.z - anchor.position.z;
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      if (distanceSquared <= 1e-24) throw new Error('Tangent arc end must differ from its source endpoint');
      const tangent = anchor.tangent;
      const cx = tangent.y * dz - tangent.z * dy;
      const cy = tangent.z * dx - tangent.x * dz;
      const cz = tangent.x * dy - tangent.y * dx;
      if (cx * cx + cy * cy + cz * cz <= 1e-24 * distanceSquared) {
        throw new Error('Tangent arc end must not lie on the source tangent line');
      }
      let failure;
      const command = new editor.commands.TangentArcCommand(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.segment = segment;
          factory.point1.copy(anchor.position);
          factory.point2.copy(endpoint);
          factory.flipTangent = args.flipTangent;
          return await factory.commit();
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["TangentArcFactory", "Vector3"], [{
      bodyId,
      segmentEntityId,
      startAt,
      end: toMeters(worldEnd),
      flipTangent,
    }]);
    return await this.state();
  }

  async createTangentCircle(
    first: CurveSegmentReference,
    second: CurveSegmentReference,
    solutionPointMm: Vector3 | Vector2,
    radiusMm: number,
    revision: string,
    normal: Vector3 = [0, 0, 1],
    plane?: ReferenceIdentity,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (first.bodyId === second.bodyId && first.segmentEntityId === second.segmentEntityId) {
      throw new Error("Tangent-circle segment references must be different");
    }
    if (!Number.isFinite(radiusMm) || radiusMm <= 0) throw new Error("Tangent-circle radius must be positive");
    const invalidBodies = [first, second].filter((reference) =>
      state.bodies.find((body) => body.id === reference.bodyId)?.type !== "Wire");
    if (invalidBodies.length > 0) {
      throw new Error(`Tangent circle requires current Wire bodies: ${invalidBodies.map((reference) => reference.bodyId).join(", ")}`);
    }

    let worldSolutionPoint: Vector3;
    let worldNormal: Vector3;
    if (plane) {
      if (solutionPointMm.length !== 2) throw new Error("Plane-local tangent-circle solution points must contain two coordinates");
      const resolvedPlane = await this.resolveCurrentPlane(plane, revision);
      worldSolutionPoint = localPointToWorld(resolvedPlane, solutionPointMm);
      worldNormal = resolvedPlane.normal;
    } else {
      if (solutionPointMm.length !== 3) throw new Error("World-space tangent-circle solution points must contain three coordinates");
      worldSolutionPoint = solutionPointMm;
      worldNormal = normalize(normal, "Tangent-circle plane normal");
    }

    const report = await this.listCurveDirections();
    if (report.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${report.revision}`);
    }
    for (const reference of [first, second]) {
      const curve = report.curves.find((candidate) => candidate.id === reference.bodyId);
      if (!curve?.segments.some((segment) => segment.entityId === reference.segmentEntityId)) {
        throw new Error(`Stale or unknown tangent-circle segment: ${reference.bodyId}:${reference.segmentEntityId}`);
      }
    }

    await this.runtime.mutate(`async function (Factory, Command, Vector, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const segment = reference => {
        const wire = find(reference.bodyId);
        if (wire?.constructor?.name !== 'Wire') throw new Error('Tangent-circle source is no longer a Wire');
        for (const candidate of Array.from(wire.segments ?? [])) {
          const edge = editor.db.lookupTopologyItem(candidate);
          if (Number(edge?.Id?.()) === reference.segmentEntityId) return candidate;
        }
        throw new Error('Stale or unknown tangent-circle segment: ' + reference.bodyId + ':' + reference.segmentEntityId);
      };
      editor.selection.selected.removeAll();
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.segment1 = segment(args.first);
          factory.segment2 = segment(args.second);
          factory.point.copy(new Vector(...args.solutionPoint));
          factory.normal.copy(new Vector(...args.normal));
          factory.radius = args.radius;
          return await factory.commit();
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["TangentCircleFactory", "TangentCircleCommand", "Vector3"], [{
      first,
      second,
      solutionPoint: toMeters(worldSolutionPoint),
      normal: worldNormal,
      radius: millimetersToMeters(radiusMm),
    }]);
    return await this.state();
  }

  async bridgeCurves(
    first: CurveSegmentEndpointReference,
    second: CurveSegmentEndpointReference,
    startContinuity: "G0" | "G1" | "G2" | "G3",
    endContinuity: "G0" | "G1" | "G2" | "G3",
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    const references = [first, second];
    const invalidBodies = references.filter((reference) =>
      state.bodies.find((body) => body.id === reference.bodyId)?.type !== "Wire");
    if (invalidBodies.length > 0) {
      throw new Error(`Curve Bridge requires current Wire bodies: ${invalidBodies.map((reference) => reference.bodyId).join(", ")}`);
    }
    if (first.bodyId === second.bodyId && first.segmentEntityId === second.segmentEntityId && first.at === second.at) {
      throw new Error("Curve Bridge endpoint references must be different");
    }
    const report = await this.listCurveDirections();
    if (report.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${report.revision}`);
    }
    const resolve = (reference: CurveSegmentEndpointReference): Vector3 => {
      const curve = report.curves.find((candidate) => candidate.id === reference.bodyId);
      const segment = curve?.segments.find((candidate) => candidate.entityId === reference.segmentEntityId);
      if (!segment) throw new Error(`Stale or unknown Curve Bridge segment: ${reference.bodyId}:${reference.segmentEntityId}`);
      return reference.at === "start" ? segment.startMm : segment.endMm;
    };
    const firstPoint = resolve(first);
    const secondPoint = resolve(second);
    if (dot(subtract(secondPoint, firstPoint), subtract(secondPoint, firstPoint)) <= 1e-18) {
      throw new Error("Curve Bridge endpoints must be distinct");
    }
    await this.runtime.mutate(`async function (Factory, Continuity, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const segment = reference => {
        const wire = find(reference.bodyId);
        if (wire?.constructor?.name !== 'Wire') throw new Error('Curve Bridge source is no longer a Wire');
        for (const candidate of Array.from(wire.segments ?? [])) {
          const edge = editor.db.lookupTopologyItem(candidate);
          if (Number(edge?.Id?.()) === reference.segmentEntityId) return candidate;
        }
        throw new Error('Stale or unknown Curve Bridge segment: ' + reference.bodyId + ':' + reference.segmentEntityId);
      };
      let failure;
      const command = new editor.commands.BridgeCurveCommand(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.start = segment(args.first);
          factory.t1 = args.first.at === 'start' ? 0 : 1;
          factory.end = segment(args.second);
          factory.t2 = args.second.at === 'start' ? 0 : 1;
          factory.startCurvature = Continuity[args.startContinuity];
          factory.endCurvature = Continuity[args.endContinuity];
          factory.trim = false;
          factory.pickClosestSenses();
          return await factory.commit();
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["BridgeCurveFactory", "ContinuityType"], [{
      first,
      second,
      startContinuity,
      endContinuity,
    }]);
    return await this.state();
  }

  async bridgeShellEdges(
    first: ShellEdgeEndpointReference,
    second: ShellEdgeEndpointReference,
    startContinuity: "G0" | "G1" | "G2" | "G3",
    endContinuity: "G0" | "G1" | "G2" | "G3",
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    const references = [first, second];
    if (first.bodyId === second.bodyId && first.edgeId === second.edgeId) {
      throw new Error("Shell Edge Bridge requires two different source edges");
    }
    requireTopologySelection(state, references, "edge");
    const resolved = references.map((reference, index) => {
      const body = state.bodies.find((candidate) => candidate.id === reference.bodyId)!;
      if (body.type !== "Solid" && body.type !== "Sheet") {
        throw new Error(`Shell Edge Bridge source ${index + 1} must belong to a Solid or Sheet`);
      }
      const edge = body.edges.find((candidate) => candidate.id === reference.edgeId)!;
      if (!edge.vertexIds.includes(reference.vertexId)) {
        throw new Error(`Shell Edge Bridge vertex ${reference.vertexId} is not an endpoint of ${reference.bodyId}:${reference.edgeId}`);
      }
      const vertex = body.vertices?.find((candidate) => candidate.id === reference.vertexId);
      if (!vertex) throw new Error(`Shell Edge Bridge requires current native B-Rep vertex ${reference.bodyId}:${reference.vertexId}`);
      return { body, edge, vertex };
    });
    const delta = subtract(resolved[1]!.vertex.positionMm, resolved[0]!.vertex.positionMm);
    if (dot(delta, delta) <= 1e-18) throw new Error("Shell Edge Bridge endpoints must be distinct");

    await this.runtime.mutate(`async function (Factory, Command, Continuity, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const edge = reference => {
        const view = find(reference.bodyId);
        if (view?.constructor?.name !== 'Solid' && view?.constructor?.name !== 'Sheet') {
          throw new Error('Shell Edge Bridge source is no longer a Solid or Sheet');
        }
        const index = view.high.edges.versionIds.indexOf(reference.edgeId);
        if (index < 0) throw new Error('Stale or unknown Shell Edge Bridge edge: ' + reference.bodyId + ':' + reference.edgeId);
        return view.high.edges.get(index);
      };
      const matches = (position, expected) => position &&
        (position.x - expected[0]) ** 2 +
        (position.y - expected[1]) ** 2 +
        (position.z - expected[2]) ** 2 <= 1e-18;
      editor.selection.selected.removeAll();
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.edge1 = edge(args.first);
          factory.edge2 = edge(args.second);
          factory.pickClosestVertices();
          if (!matches(factory.startPosition, args.firstPosition)) factory.side1 = !factory.side1;
          if (!matches(factory.endPosition, args.secondPosition)) factory.side2 = !factory.side2;
          if (!matches(factory.startPosition, args.firstPosition) || !matches(factory.endPosition, args.secondPosition)) {
            throw new Error('Requested Shell Edge Bridge endpoints are unavailable');
          }
          factory.startCurvature = Continuity[args.startContinuity];
          factory.endCurvature = Continuity[args.endContinuity];
          factory.lockDistances = true;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["BridgeEdgeFactory", "BridgeEdgeCommand", "ContinuityType"], [{
      first,
      second,
      firstPosition: toMeters(resolved[0]!.vertex.positionMm),
      secondPosition: toMeters(resolved[1]!.vertex.positionMm),
      startContinuity,
      endContinuity,
    }]);
    return await this.state();
  }

  async bridgeCurveVertices(
    first: VertexReference,
    second: VertexReference,
    startContinuity: "G0" | "G1" | "G2" | "G3",
    endContinuity: "G0" | "G1" | "G2" | "G3",
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (first.bodyId === second.bodyId && first.vertexId === second.vertexId) {
      throw new Error("Curve Vertex Bridge endpoint references must be different");
    }
    const bodies = new Map(state.bodies.map((body) => [body.id, body]));
    const references = [first, second];
    const missingBodies = references.filter((reference) => !bodies.has(reference.bodyId));
    if (missingBodies.length > 0) {
      throw new Error(`Unknown current Curve Vertex Bridge body IDs: ${missingBodies.map((reference) => reference.bodyId).join(", ")}`);
    }
    const invalidBodies = references.filter((reference) => bodies.get(reference.bodyId)!.type !== "Wire");
    if (invalidBodies.length > 0) {
      throw new Error(`Curve Vertex Bridge requires current Wire bodies: ${invalidBodies.map((reference) => reference.bodyId).join(", ")}`);
    }
    const inventory = await this.listCurveVertices();
    if (inventory.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${inventory.revision}`);
    }
    const resolved = references.map((reference) => {
      const vertex = inventory.vertices.find((candidate) =>
        candidate.bodyId === reference.bodyId && candidate.vertexId === reference.vertexId);
      if (!vertex) {
        throw new Error(`Stale or unknown Curve Vertex Bridge vertex: ${reference.bodyId}:${reference.vertexId}`);
      }
      if (!vertex.endpoint) {
        throw new Error(`Curve Vertex Bridge requires an open Wire endpoint: ${reference.bodyId}:${reference.vertexId}`);
      }
      return vertex;
    });
    const delta = subtract(resolved[1]!.positionMm, resolved[0]!.positionMm);
    if (dot(delta, delta) <= 1e-18) throw new Error("Curve Vertex Bridge endpoints must be distinct");

    await this.runtime.mutate(`async function (Factory, Command, Continuity, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const vertex = reference => {
        const wire = find(reference.bodyId);
        if (wire?.constructor?.name !== 'Wire') throw new Error('Curve Vertex Bridge source is no longer a Wire');
        for (const candidate of Array.from(wire.vertices ?? [])) {
          const model = editor.db.lookupTopologyItem(candidate);
          if (Number(model?.Id?.()) === reference.vertexId) return candidate;
        }
        throw new Error('Stale or unknown Curve Vertex Bridge vertex: ' + reference.bodyId + ':' + reference.vertexId);
      };
      const matches = (position, expected) => position &&
        (position.x - expected[0]) ** 2 +
        (position.y - expected[1]) ** 2 +
        (position.z - expected[2]) ** 2 <= 1e-18;
      editor.selection.selected.removeAll();
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.vertex1 = vertex(args.first);
          factory.vertex2 = vertex(args.second);
          if (!matches(factory.startPosition, args.firstPosition) || !matches(factory.endPosition, args.secondPosition)) {
            throw new Error('Requested Curve Vertex Bridge endpoints are unavailable');
          }
          factory.startCurvature = Continuity[args.startContinuity];
          factory.endCurvature = Continuity[args.endContinuity];
          factory.lockDistances = true;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["BridgeVertexFactory", "BridgeVertexCommand", "ContinuityType"], [{
      first,
      second,
      firstPosition: toMeters(resolved[0]!.positionMm),
      secondPosition: toMeters(resolved[1]!.positionMm),
      startContinuity,
      endContinuity,
    }]);
    return await this.state();
  }

  async createEllipse(
    centerMm: Vector3 | Vector2,
    majorRadiusMm: number,
    minorRadiusMm: number,
    revision?: string,
    normal: Vector3 = [0, 0, 1],
    xDirection: Vector3 = [1, 0, 0],
    plane?: ReferenceIdentity,
    angleDegrees = 0,
  ): Promise<RuntimeState> {
    if (!Number.isFinite(majorRadiusMm) || majorRadiusMm <= 0) throw new Error("Ellipse major radius must be positive");
    if (!Number.isFinite(minorRadiusMm) || minorRadiusMm <= 0) throw new Error("Ellipse minor radius must be positive");
    if (minorRadiusMm > majorRadiusMm) throw new Error("Ellipse minor radius must not exceed its major radius");
    if (!Number.isFinite(angleDegrees)) throw new Error("Ellipse angle must be finite");
    let worldCenter: Vector3;
    let baseX: Vector3;
    let baseY: Vector3;
    let worldNormal: Vector3;
    if (plane) {
      if (centerMm.length !== 2) throw new Error("Plane-local ellipse centers must contain two coordinates");
      const resolvedPlane = await this.resolveCurrentPlane(plane, revision);
      worldCenter = localPointToWorld(resolvedPlane, centerMm);
      baseX = resolvedPlane.xDirection;
      baseY = resolvedPlane.yDirection;
      worldNormal = resolvedPlane.normal;
    } else {
      if (centerMm.length !== 3) throw new Error("World-space ellipse centers must contain three coordinates");
      if (revision) await this.assertRevision(revision);
      const frame = frameFromOriginNormalX(centerMm, normal, xDirection);
      worldCenter = frame.originMm;
      baseX = frame.xDirection;
      baseY = frame.yDirection;
      worldNormal = frame.normal;
    }
    const radians = degreesToRadians(angleDegrees);
    const majorDirection = add(scale(baseX, Math.cos(radians)), scale(baseY, Math.sin(radians)));
    const minorDirection = add(scale(baseY, Math.cos(radians)), scale(baseX, -Math.sin(radians)));
    const majorPoint = add(worldCenter, scale(majorDirection, majorRadiusMm));
    const minorPoint = add(worldCenter, scale(minorDirection, minorRadiusMm));
    await this.runtime.mutate(`async function (Factory, Vector, Quaternion, args) {
      ${commandStart("EllipseCommand")}
      factory.isKnife = false;
      factory.center.fromArray(args.center);
      factory.orientation.copy(new Quaternion().setFromUnitVectors(new Vector(0, 0, 1), new Vector(...args.normal).normalize()));
      factory.point1.fromArray(args.majorPoint);
      factory.point2.fromArray(args.minorPoint);
      ${commandEnd}
    }`, ["KnifeEllipseFactory", "Vector3", "Quaternion"], [{
      center: toMeters(worldCenter),
      majorPoint: toMeters(majorPoint),
      minorPoint: toMeters(minorPoint),
      normal: worldNormal,
    }]);
    return await this.state();
  }

  async createRegularPolygon(
    centerMm: Vector3 | Vector2,
    radiusMm: number,
    radiusMode: "circumradius" | "inradius",
    vertexCount: number,
    revision?: string,
    normal: Vector3 = [0, 0, 1],
    xDirection: Vector3 = [1, 0, 0],
    plane?: ReferenceIdentity,
    angleDegrees = 0,
  ): Promise<RuntimeState> {
    if (!Number.isFinite(radiusMm) || radiusMm <= 0) throw new Error("Polygon radius must be positive");
    if (!Number.isInteger(vertexCount) || vertexCount < 3 || vertexCount > 256) throw new Error("Polygon vertex count must be an integer from 3 to 256");
    if (radiusMode !== "circumradius" && radiusMode !== "inradius") throw new Error(`Unsupported polygon radius mode: ${String(radiusMode)}`);
    if (!Number.isFinite(angleDegrees)) throw new Error("Polygon angle must be finite");
    let worldCenter: Vector3;
    let baseX: Vector3;
    let baseY: Vector3;
    let worldNormal: Vector3;
    if (plane) {
      if (centerMm.length !== 2) throw new Error("Plane-local polygon centers must contain two coordinates");
      const resolvedPlane = await this.resolveCurrentPlane(plane, revision);
      worldCenter = localPointToWorld(resolvedPlane, centerMm);
      baseX = resolvedPlane.xDirection;
      baseY = resolvedPlane.yDirection;
      worldNormal = resolvedPlane.normal;
    } else {
      if (centerMm.length !== 3) throw new Error("World-space polygon centers must contain three coordinates");
      if (revision) await this.assertRevision(revision);
      const frame = frameFromOriginNormalX(centerMm, normal, xDirection);
      worldCenter = frame.originMm;
      baseX = frame.xDirection;
      baseY = frame.yDirection;
      worldNormal = frame.normal;
    }
    const radians = degreesToRadians(angleDegrees);
    const radialDirection = add(scale(baseX, Math.cos(radians)), scale(baseY, Math.sin(radians)));
    const point = add(worldCenter, scale(radialDirection, radiusMm));
    await this.runtime.mutate(`async function (Factory, Vector, Quaternion, args) {
      ${commandStart("PolygonCommand")}
      factory.isKnife = false;
      factory.center.fromArray(args.center);
      factory.orientation.copy(new Quaternion().setFromUnitVectors(new Vector(0, 0, 1), new Vector(...args.normal).normalize()));
      factory.circumscribedOrInscribed = args.radiusMode === 'circumradius' ? 'inscribed' : 'circumscribed';
      factory.point.fromArray(args.point);
      factory.vertexCount = args.vertexCount;
      ${commandEnd}
    }`, ["KnifePolygonFactory", "Vector3", "Quaternion"], [{
      center: toMeters(worldCenter),
      point: toMeters(point),
      normal: worldNormal,
      radiusMode,
      vertexCount,
    }]);
    return await this.state();
  }

  async createRectangle(
    centerMm: Vector3 | Vector2,
    widthMm: number,
    heightMm: number,
    revision?: string,
    normal: Vector3 = [0, 0, 1],
    xDirection: Vector3 = [1, 0, 0],
    plane?: ReferenceIdentity,
    angleDegrees = 0,
  ): Promise<RuntimeState> {
    if (!Number.isFinite(widthMm) || widthMm <= 0) throw new Error("Rectangle width must be positive");
    if (!Number.isFinite(heightMm) || heightMm <= 0) throw new Error("Rectangle height must be positive");
    const radians = degreesToRadians(angleDegrees);
    let worldCenter: Vector3;
    let baseX: Vector3;
    let baseY: Vector3;
    if (plane) {
      if (centerMm.length !== 2) throw new Error("Plane-local rectangle centers must contain two coordinates");
      const resolvedPlane = await this.resolveCurrentPlane(plane, revision);
      worldCenter = localPointToWorld(resolvedPlane, centerMm);
      baseX = resolvedPlane.xDirection;
      baseY = resolvedPlane.yDirection;
    } else {
      if (centerMm.length !== 3) throw new Error("World-space rectangle centers must contain three coordinates");
      if (revision) await this.assertRevision(revision);
      const frame = frameFromOriginNormalX(centerMm, normal, xDirection);
      worldCenter = frame.originMm;
      baseX = frame.xDirection;
      baseY = frame.yDirection;
    }
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const rectangleX = add(scale(baseX, cosine), scale(baseY, sine));
    const rectangleY = add(scale(baseY, cosine), scale(baseX, -sine));
    const halfWidth = scale(rectangleX, widthMm / 2);
    const halfHeight = scale(rectangleY, heightMm / 2);
    const p1 = subtract(subtract(worldCenter, halfWidth), halfHeight);
    const p2 = add(subtract(worldCenter, halfHeight), halfWidth);
    const p3 = add(add(worldCenter, halfWidth), halfHeight);
    await this.runtime.mutate(`async function (Factory, Vector, args) {
      ${commandStart("ThreePointRectangleCommand")}
      factory.p1 = new Vector(...args.p1);
      factory.p2 = new Vector(...args.p2);
      factory.p3 = new Vector(...args.p3);
      ${commandEnd}
    }`, ["ThreePointRectangleFactory", "Vector3"], [{ p1: toMeters(p1), p2: toMeters(p2), p3: toMeters(p3) }]);
    return await this.state();
  }

  async createText(input: CreateTextInput): Promise<RuntimeState> {
    if (input.text.trim().length === 0) throw new Error("Text must be nonempty");
    if (!Number.isFinite(input.fontSizeMm) || input.fontSizeMm <= 0) throw new Error("Text font size must be positive");
    const font = input.font ?? "inter";
    if (font !== "inter") throw new Error(`Unsupported Plasticity text font: ${font}`);
    const radians = degreesToRadians(input.angleDegrees ?? 0);
    let worldOrigin: Vector3;
    let baseX: Vector3;
    let baseY: Vector3;
    let planeNormal: Vector3;
    if (input.plane) {
      if (input.originMm.length !== 2) throw new Error("Plane-local text origins must contain two coordinates");
      const resolvedPlane = await this.resolveCurrentPlane(input.plane, input.revision);
      worldOrigin = localPointToWorld(resolvedPlane, input.originMm);
      baseX = resolvedPlane.xDirection;
      baseY = resolvedPlane.yDirection;
      planeNormal = resolvedPlane.normal;
    } else {
      if (input.originMm.length !== 3) throw new Error("World-space text origins must contain three coordinates");
      if (input.revision) await this.assertRevision(input.revision);
      const frame = frameFromOriginNormalX(input.originMm, input.normal ?? [0, 0, 1], input.xDirection ?? [1, 0, 0]);
      worldOrigin = frame.originMm;
      baseX = frame.xDirection;
      baseY = frame.yDirection;
      planeNormal = frame.normal;
    }
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const textX = add(scale(baseX, cosine), scale(baseY, sine));
    const textY = add(scale(baseY, cosine), scale(baseX, -sine));
    const rotate = !vectorsNear(textX, [1, 0, 0]) || !vectorsNear(textY, [0, 1, 0]) || !vectorsNear(planeNormal, [0, 0, 1]);
    const move = Math.hypot(...worldOrigin) > 1e-12;
    await this.runtime.mutate(`async function (TextFactory, RotateFactory, MoveFactory, Vector, Matrix, Quaternion, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.CurveCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const text = new TextFactory(editor).resource(this);
          text.text = args.text;
          text.font = args.font;
          text.size = args.size;
          let views = await text.commit();
          views = Array.isArray(views) ? views : [views];
          if (args.rotate) {
            const rotate = new RotateFactory(editor).resource(this);
            rotate.items = views;
            rotate.pivot.fromArray([0, 0, 0]);
            rotate.rotation.copy(new Quaternion().setFromRotationMatrix(
              new Matrix().makeBasis(new Vector(...args.x), new Vector(...args.y), new Vector(...args.z)),
            ));
            const rotated = await rotate.commit();
            views = Array.isArray(rotated) ? rotated : [rotated];
          }
          if (args.move) {
            const move = new MoveFactory(editor).resource(this);
            move.items = views;
            move.move.fromArray(args.origin);
            const moved = await move.commit();
            views = Array.isArray(moved) ? moved : [moved];
          }
          if (args.name) views.forEach((view, index) => editor.db.nodes.setName(
            editor.db.nodes.item2key(view),
            views.length === 1 ? args.name : args.name + ' ' + (index + 1),
          ));
          return views;
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["TextFactory", "RotateItemAndEmptyFactory", "MoveItemAndEmptyFactory", "Vector3", "Matrix4", "Quaternion"], [{
      text: input.text,
      font,
      size: millimetersToMeters(input.fontSizeMm),
      origin: toMeters(worldOrigin),
      x: textX,
      y: textY,
      z: planeNormal,
      rotate,
      move,
      name: input.name ?? null,
    }]);
    return await this.state();
  }

  async move(ids: number[], deltaMm: Vector3, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("MoveItemCommand")}
      factory.items = args.ids.map(find);
      factory.move.fromArray(args.delta);
      ${commandEnd}
    }`, ["MoveItemAndEmptyFactory"], [{ ids, delta: toMeters(deltaMm) }]);
    return await this.state();
  }

  async rotate(ids: number[], pivotMm: Vector3, axis: Vector3, degrees: number, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(`async function (Factory, Vector, Quaternion, args) {
      ${findView}
      ${commandStart("RotateItemCommand")}
      factory.items = args.ids.map(find);
      factory.pivot.fromArray(args.pivot);
      factory.rotation.copy(new Quaternion().setFromAxisAngle(new Vector(...args.axis).normalize(), args.radians));
      ${commandEnd}
    }`, ["RotateItemAndEmptyFactory", "Vector3", "Quaternion"], [{ ids, pivot: toMeters(pivotMm), axis, radians: degreesToRadians(degrees) }]);
    return await this.state();
  }

  async rotateBodiesByXyz(ids: number[], pivotMm: Vector3, rotationDeg: Vector3, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error("At least one unique body ID is required for print orientation");
    for (const id of ids) {
      const body = state.bodies.find((candidate) => candidate.id === id);
      if (!body || body.type !== "Solid" || !body.boundsMm) throw new Error(`Print orientation requires a current bounded native Solid: ${id}`);
    }
    const quaternion: QuaternionXyzw = quaternionFromXyzDegrees(rotationDeg);
    if (Math.hypot(quaternion[0], quaternion[1], quaternion[2]) < 1e-12) throw new Error("Print orientation is zero; no CAD mutation is required");
    await this.runtime.mutate(`async function (Factory, Vector, Quaternion, args) {
      ${findView}
      ${commandStart("RotateItemCommand")}
      factory.items = args.ids.map(find);
      factory.pivot.fromArray(args.pivot);
      factory.rotation.set(args.quaternion[0], args.quaternion[1], args.quaternion[2], args.quaternion[3]);
      ${commandEnd}
    }`, ["RotateItemAndEmptyFactory", "Vector3", "Quaternion"], [{ ids, pivot: toMeters(pivotMm), quaternion }]);
    return await this.state();
  }

  async scale(ids: number[], pivotMm: Vector3, factors: Vector3, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("ScaleItemCommand")}
      factory.items = args.ids.map(find);
      factory.pivot.fromArray(args.pivot);
      factory.scale.fromArray(args.factors);
      ${commandEnd}
    }`, ["ProjectingScaleItemAndEmptyFactory"], [{ ids, pivot: toMeters(pivotMm), factors }]);
    return await this.state();
  }

  async setBlockDimensions(
    id: number,
    widthMm: number,
    lengthMm: number,
    heightMm: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    const body = state.bodies.find((candidate) => candidate.id === id);
    if (body?.type !== "Solid") throw new Error(`Block dimension target must be one current Solid: ${id}`);
    for (const [name, value] of [["widthMm", widthMm], ["lengthMm", lengthMm], ["heightMm", heightMm]] as const) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
    }
    await this.runtime.mutate(`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const view = find(args.id);
      this.selection.selected.removeAll();
      this.selection.selected.add(view);

      let collection = null;
      const base = Object.getPrototypeOf(Factory.prototype);
      const descriptor = Object.getOwnPropertyDescriptor(base, 'collection');
      if (!descriptor?.set) throw new Error('Plasticity block dimension collection is unavailable');
      const marker = '__PLASTICITY_MCP_DIMENSION_COLLECTION__';
      Object.defineProperty(base, 'collection', {
        ...descriptor,
        set(value) { collection = value; throw new Error(marker); },
      });
      const probe = new Command(editor);
      try {
        await probe.execute();
      } catch (error) {
        if (String(error?.message ?? error) !== marker) throw error;
      } finally {
        Object.defineProperty(base, 'collection', descriptor);
        try { probe.cancel(); } catch {}
      }
      if (!collection?.HasBlock?.()) throw new Error('Selected Solid is not recognized by Plasticity as a dimensionable block');

      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.collection = collection;
          factory.width = args.width;
          factory.length = args.length;
          factory.height = args.height;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["DimensionBlockCommand", "DimensionBlockFactory"], [{
      id,
      width: millimetersToMeters(widthMm),
      length: millimetersToMeters(lengthMm),
      height: millimetersToMeters(heightMm),
    }]);
    return await this.state();
  }

  async setRadiusDimension(
    face: { bodyId: number; faceId: string },
    radiusMm: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    const currentFace = state.bodies.find((body) => body.id === face.bodyId)?.faces.find((candidate) => candidate.id === face.faceId);
    if (currentFace?.surfaceType !== "Cylinder" || currentFace.radiusMm === null) {
      throw new Error(`Radius dimension target must be one current cylindrical face: ${face.bodyId}:${face.faceId}`);
    }
    if (!Number.isFinite(radiusMm) || radiusMm <= 0) throw new Error("radiusMm must be a positive finite number");
    await this.runtime.mutate(`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const view = find(args.face.bodyId);
      const index = view.high.faces.versionIds.indexOf(args.face.faceId);
      if (index < 0) throw new Error('Stale or unknown face: ' + args.face.faceId);
      this.selection.selected.removeAll();
      this.selection.selected.addFace(view.high.faces.get(index));

      let collection = null;
      const base = Object.getPrototypeOf(Factory.prototype);
      const descriptor = Object.getOwnPropertyDescriptor(base, 'collection');
      if (!descriptor?.set) throw new Error('Plasticity radius dimension collection is unavailable');
      const marker = '__PLASTICITY_MCP_DIMENSION_COLLECTION__';
      Object.defineProperty(base, 'collection', {
        ...descriptor,
        set(value) { collection = value; throw new Error(marker); },
      });
      const probe = new Command(editor);
      try {
        await probe.execute();
      } catch (error) {
        if (String(error?.message ?? error) !== marker) throw error;
      } finally {
        Object.defineProperty(base, 'collection', descriptor);
        try { probe.cancel(); } catch {}
      }
      if (!collection?.HasRadius?.()) throw new Error('Selected face is not recognized by Plasticity as radius-dimensionable');

      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.collection = collection;
          factory.radius = args.radius;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["DimensionRadiusCommand", "DimensionRadiusFactory"], [{
      face,
      radius: millimetersToMeters(radiusMm),
    }]);
    return await this.state();
  }

  async setRectangleDimensions(
    id: number,
    widthMm: number,
    lengthMm: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    const body = state.bodies.find((candidate) => candidate.id === id);
    if (body?.type !== "Wire" || !state.regions.some((region) => region.sketchWireIds.includes(id))) {
      throw new Error(`Rectangle dimension target must be one current closed planar Wire: ${id}`);
    }
    for (const [name, value] of [["widthMm", widthMm], ["lengthMm", lengthMm]] as const) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
    }
    await this.runtime.mutate(`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const view = find(args.id);
      this.selection.selected.removeAll();
      this.selection.selected.add(view);

      let collection = null;
      const base = Object.getPrototypeOf(Factory.prototype);
      const descriptor = Object.getOwnPropertyDescriptor(base, 'collection');
      if (!descriptor?.set) throw new Error('Plasticity rectangle dimension collection is unavailable');
      const marker = '__PLASTICITY_MCP_DIMENSION_COLLECTION__';
      Object.defineProperty(base, 'collection', {
        ...descriptor,
        set(value) { collection = value; throw new Error(marker); },
      });
      const probe = new Command(editor);
      try {
        await probe.execute();
      } catch (error) {
        if (String(error?.message ?? error) !== marker) throw error;
      } finally {
        Object.defineProperty(base, 'collection', descriptor);
        try { probe.cancel(); } catch {}
      }
      if (!collection?.HasRectangle?.()) throw new Error('Selected Wire is not recognized by Plasticity as a dimensionable rectangle');

      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.collection = collection;
          factory.width = args.width;
          factory.length = args.length;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["DimensionRectangleCommand", "DimensionRectangleFactory"], [{
      id,
      width: millimetersToMeters(widthMm),
      length: millimetersToMeters(lengthMm),
    }]);
    return await this.state();
  }

  async boolean(targetIds: number[], toolIds: number[], operation: "union" | "difference" | "intersection", keepTools: boolean, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (targetIds.some((id) => toolIds.includes(id))) throw new Error("Target and tool IDs must not overlap");
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("BooleanCommand")}
      factory.targets = args.targetIds.map(find);
      factory.tools = args.toolIds.map(find);
      factory.operationType = ({ union: 15903, difference: 15902, intersection: 15901 })[args.operation];
      factory.keepTools = args.keepTools;
      ${commandEnd}
    }`, ["BooleanFactory"], [{ targetIds, toolIds, operation, keepTools }]);
    return await this.state();
  }

  async cutWithFaces(
    targetIds: number[],
    cutterFaces: Array<{ bodyId: number; faceId: string }>,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (targetIds.length === 0) throw new Error("At least one cut target is required");
    const uniqueTargetIds = [...new Set(targetIds)];
    if (uniqueTargetIds.length !== targetIds.length) throw new Error("Cut target IDs must be unique");
    if (cutterFaces.length === 0) throw new Error("At least one cutter face is required");
    const cutterKeys = cutterFaces.map((face) => `${face.bodyId}:${face.faceId}`);
    if (new Set(cutterKeys).size !== cutterKeys.length) throw new Error("Cutter face references must be unique");
    const cutterBodyIds = new Set(cutterFaces.map((face) => face.bodyId));
    if (uniqueTargetIds.some((id) => cutterBodyIds.has(id))) {
      throw new Error("Cut targets and cutter-face bodies must not overlap");
    }
    const invalidTargets = uniqueTargetIds.filter((id) => {
      const type = state.bodies.find((body) => body.id === id)?.type;
      return type !== "Solid" && type !== "Sheet";
    });
    if (invalidTargets.length > 0) {
      throw new Error(`Cut targets must be current Solid or Sheet bodies: ${invalidTargets.join(", ")}`);
    }
    const invalidCutters = cutterFaces.filter((reference) => {
      const body = state.bodies.find((candidate) => candidate.id === reference.bodyId);
      if (body?.type !== "Solid" && body?.type !== "Sheet") return true;
      return body.faces.find((face) => face.id === reference.faceId)?.planar !== true;
    });
    if (invalidCutters.length > 0) {
      throw new Error(`Cut requires current planar cutter faces: ${invalidCutters.map((face) => `${face.bodyId}:${face.faceId}`).join(", ")}`);
    }
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("CutCommand")}
      factory.shells = args.targetIds.map(find);
      factory.faces = args.cutterFaces.map(ref => {
        const view = find(ref.bodyId);
        const index = view.high.faces.versionIds.indexOf(ref.faceId);
        if (index < 0) throw new Error('Stale or unknown cutter face: ' + ref.faceId);
        return view.high.faces.get(index);
      });
      ${commandEnd}
    }`, ["MultiCutFactory"], [{ targetIds: uniqueTargetIds, cutterFaces }]);
    return await this.state();
  }

  async listAppearanceMaterials(): Promise<{
    documentToken: string;
    revision: string;
    materials: NonNullable<RuntimeState["materials"]>;
    assignments: Array<{ bodyId: number; materialId: number }>;
  }> {
    const state = await this.state();
    return {
      documentToken: state.documentToken,
      revision: state.revision,
      materials: state.materials ?? [],
      assignments: state.bodies.map((body) => ({ bodyId: body.id, materialId: body.materialId ?? 0 })),
    };
  }

  async setAppearanceMaterial(
    ids: number[],
    material: AppearanceMaterialInput,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (ids.length === 0) throw new Error("At least one body ID is required");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Appearance body IDs must be unique");
    const missing = uniqueIds.filter((id) => !state.bodies.some((body) => body.id === id));
    if (missing.length > 0) throw new Error(`Appearance requires current body IDs: ${missing.join(", ")}`);
    if ("materialId" in material) {
      if (!Number.isInteger(material.materialId) || material.materialId < 0) {
        throw new Error("Appearance material ID must be a nonnegative integer");
      }
      if (material.materialId !== 0 && !(state.materials ?? []).some((item) => item.id === material.materialId)) {
        throw new Error(`Unknown current appearance material: ${material.materialId}`);
      }
    } else {
      if (!material.name.trim()) throw new Error("Appearance material name is required");
      if (!/^#[0-9a-fA-F]{6}$/.test(material.colorHex)) throw new Error("Appearance color must be #RRGGBB");
      for (const [name, value] of [["roughness", material.roughness], ["metalness", material.metalness], ["opacity", material.opacity]] as const) {
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Appearance ${name} must be between 0 and 1`);
      }
    }
    await this.runtime.mutate(`async function (args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const views = args.ids.map(find);
      this.selection.selected.removeAll();
      let failure;
      let ran = false;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        ran = true;
        try {
          let materialId = args.material.materialId;
          if (materialId === undefined) {
            const appearance = editor.db.materials.default.clone();
            appearance.color.set(args.material.colorHex);
            appearance.roughness = args.material.roughness;
            appearance.metalness = args.material.metalness;
            appearance.opacity = args.material.opacity;
            appearance.transparent = args.material.opacity < 1;
            materialId = editor.db.materials.add(args.material.name, appearance);
          } else if (materialId !== 0 && !editor.db.materials.has(materialId)) {
            throw new Error('Appearance material ID is no longer current: ' + materialId);
          }
          for (const view of views) editor.db.nodes.setMaterial(editor.db.nodes.item2key(view), materialId);
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
      if (!ran) throw new Error('Appearance command did not execute');
    }`, [], [{ ids: uniqueIds, material }]);
    return await this.state();
  }

  async fillet(id: number, edgeIds: string[], radiusMm: number, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("FilletShellCommand")}
      const view = find(args.id);
      const edges = view.high.edges;
      factory.shell = view;
      factory.edges = args.edgeIds.map(id => {
        const index = edges.versionIds.indexOf(id);
        if (index < 0) throw new Error('Stale or unknown edge: ' + id);
        return edges.get(index);
      });
      factory.distance = args.radius;
      ${commandEnd}
    }`, ["FilletShellFactory"], [{ id, edgeIds, radius: millimetersToMeters(radiusMm) }]);
    return await this.state();
  }

  async chamfer(id: number, edgeIds: string[], distanceMm: number, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("FilletShellCommand")}
      const view = find(args.id);
      const edges = view.high.edges;
      factory.shell = view;
      factory.edges = args.edgeIds.map(id => {
        const index = edges.versionIds.indexOf(id);
        if (index < 0) throw new Error('Stale or unknown edge: ' + id);
        return edges.get(index);
      });
      factory.distance = args.distance;
      ${commandEnd}
    }`, ["FilletShellFactory"], [{ id, edgeIds, distance: -millimetersToMeters(distanceMm) }]);
    return await this.state();
  }

  async removeFillets(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (ids.length === 0) throw new Error("At least one Solid or Sheet ID is required");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Shell body IDs must be unique");
    const invalid = uniqueIds.filter((id) => {
      const type = state.bodies.find((body) => body.id === id)?.type;
      return type !== "Solid" && type !== "Sheet";
    });
    if (invalid.length > 0) throw new Error(`Fillet removal requires current Solid or Sheet bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("RemoveFilletsFromShellCommand")}
      factory.shells = args.ids.map(find);
      factory.radius = 0;
      ${commandEnd}
    }`, ["RemoveFilletsFromShellFactory"], [{ ids: uniqueIds }]);
    return await this.state();
  }

  async refilletFaces(faces: Array<{ bodyId: number; faceId: string }>, deltaMm: number, revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (faces.length === 0) throw new Error("At least one recognized fillet face is required");
    const keys = faces.map((face) => `${face.bodyId}:${face.faceId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Fillet face references must be unique");
    if (!Number.isFinite(deltaMm) || deltaMm === 0) throw new Error("Refillet delta must be finite and nonzero");
    const selected = faces.map((reference) =>
      state.bodies.find((body) => body.id === reference.bodyId)?.faces.find((face) => face.id === reference.faceId));
    const missing = faces.filter((_reference, index) => !selected[index]);
    if (missing.length > 0) {
      throw new Error(`Stale or unknown faces: ${missing.map((face) => `${face.bodyId}:${face.faceId}`).join(", ")}`);
    }
    const unrecognized = faces.filter((_reference, index) => selected[index]!.blendRadiusMm === null);
    if (unrecognized.length > 0) {
      throw new Error(`Refillet requires recognized fillet faces: ${unrecognized.map((face) => `${face.bodyId}:${face.faceId}`).join(", ")}`);
    }
    const nonpositive = faces.filter((_reference, index) => selected[index]!.blendRadiusMm! + deltaMm <= 0);
    if (nonpositive.length > 0) throw new Error("Refillet delta must leave every selected face with a positive radius");
    await this.runtime.mutate(`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          const shells = new Set(args.faces.map(ref => find(ref.bodyId)));
          factory.shells = Array.from(shells);
          factory.faces = args.faces.map(ref => {
            const view = find(ref.bodyId);
            const index = view.high.faces.versionIds.indexOf(ref.faceId);
            if (index < 0) throw new Error('Stale or unknown fillet face: ' + ref.faceId);
            return view.high.faces.get(index);
          });
          factory.distance = args.distance;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["RefilletFaceCommand", "RefilletFaceFactory"], [{ faces, distance: millimetersToMeters(deltaMm) }]);
    return await this.state();
  }

  async extrudeFaces(id: number, faceIds: string[], distanceMm: number, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("ExtrudeCommand")}
      const view = find(args.id);
      const faces = view.high.faces;
      factory.faces = args.faceIds.map(id => {
        const index = faces.versionIds.indexOf(id);
        if (index < 0) throw new Error('Stale or unknown face: ' + id);
        return faces.get(index);
      });
      factory.distance1 = args.distance;
      ${commandEnd}
    }`, ["ExtrudeFactory"], [{ id, faceIds, distance: millimetersToMeters(distanceMm) }]);
    return await this.state();
  }

  async extrudeProfile(id: number, distanceMm: number, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("ExtrudeCommand")}
      const view = find(args.id);
      if (view.constructor.name !== 'Wire') throw new Error('Profile must be a Wire');
      const profileItem = Array.from(editor.geo.geometryModel.values()).find(item => item.view === view);
      if (!profileItem?.model?.IsClosed?.()) throw new Error('Profile must be a closed Wire');
      let basis;
      try { basis = editor.curves.lookup(view); } catch { throw new Error('Profile is not planar'); }
      const sketchEntry = Array.from(editor.curves.read.sketch2basis ?? [])
        .find(([, candidateBasis]) => candidateBasis === basis);
      const sketchId = Number(sketchEntry?.[0]);
      if (!Number.isInteger(sketchId)) throw new Error('Profile sketch is unavailable');
      const regions = [];
      for (const [versionId, item] of editor.geo.geometryModel) {
        if (!editor.geo.automatics.has(versionId) || item.view?.constructor?.name !== 'SketchIsland') continue;
        let candidateSketchId;
        try { candidateSketchId = Number(editor.sketches.getSketchId(item.view)); } catch { continue; }
        if (candidateSketchId !== sketchId) continue;
        for (let index = 0; index < (item.view.regions?.length ?? 0); index += 1) {
          const region = item.view.regions.get(index);
          if (region) regions.push(region);
        }
      }
      if (regions.length === 0) throw new Error('Profile is open or has no native region');
      if (regions.length > 1) throw new Error('Profile is ambiguous; use plasticity_list_regions and plasticity_extrude_regions');
      factory.regions = regions;
      factory.distance1 = args.distance;
      ${commandEnd}
    }`, ["ExtrudeFactory"], [{ id, distance: millimetersToMeters(distanceMm) }]);
    return await this.state();
  }

  async extrudeRegions(regionIds: string[], distanceMm: number, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (regionIds.length === 0) throw new Error("At least one Region ID is required");
    const uniqueIds = [...new Set(regionIds)];
    if (uniqueIds.length !== regionIds.length) throw new Error("Region IDs must be unique");
    await this.runtime.mutate(`async function (Factory, args) {
      ${commandStart("ExtrudeCommand")}
      const wanted = new Set(args.regionIds);
      const regions = [];
      for (const [versionId, item] of editor.geo.geometryModel) {
        if (!editor.geo.automatics.has(versionId) || item.view?.constructor?.name !== 'SketchIsland') continue;
        for (let index = 0; index < (item.view.regions?.length ?? 0); index += 1) {
          const region = item.view.regions.get(index);
          if (region && wanted.has(String(region.versionId))) regions.push(region);
        }
      }
      const found = new Set(regions.map(region => String(region.versionId)));
      const missing = args.regionIds.filter(id => !found.has(id));
      if (missing.length > 0) throw new Error('Stale or unknown regions: ' + missing.join(', '));
      factory.regions = regions;
      factory.distance1 = args.distance;
      ${commandEnd}
    }`, ["ExtrudeFactory"], [{ regionIds: uniqueIds, distance: millimetersToMeters(distanceMm) }]);
    return await this.state();
  }

  async offsetPlanarCurves(ids: number[], distanceMm: number, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (!Number.isFinite(distanceMm) || distanceMm === 0) throw new Error("Planar curve offset distance must be nonzero");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) throw new Error("At least one Wire ID is required");
    if (uniqueIds.length !== ids.length) throw new Error("Wire IDs must be unique");
    await this.runtime.mutate(`async function (Factory, args) {
      const findWire = id => {
        for (const [versionId, item] of this.geo.geometryModel) {
          if (this.db.lookupStableId(versionId) !== id) continue;
          if (item.view?.constructor?.name !== 'Wire') throw new Error('Planar curve offset requires Wire bodies');
          return item.view;
        }
        throw new Error('Unknown Wire ID: ' + id);
      };
      ${commandStart("OffsetPlanarCurveCommand")}
      factory.curves = args.ids.map(findWire);
      factory.distance1 = args.distance;
      ${commandEnd}
    }`, ["OffsetPlanarCurvesFactory"], [{ ids: uniqueIds, distance: millimetersToMeters(distanceMm) }]);
    return await this.state();
  }

  async createSlotProfiles(ids: number[], widthMm: number, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (!Number.isFinite(widthMm) || widthMm <= 0) throw new Error("Slot profile width must be positive");
    if (ids.length === 0) throw new Error("At least one Wire ID is required");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Wire IDs must be unique");
    const invalid = uniqueIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Slot profiles require current Wire bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(`async function (Factory, Command, args) {
      ${findView}
      const wires = args.ids.map(id => {
        const view = find(id);
        if (view?.constructor?.name !== 'Wire') throw new Error('Slot profile source is no longer a Wire: ' + id);
        return view;
      });
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.curves = wires;
          factory.width = args.width;
          return await factory.commit();
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["SlotFactory", "SlotCommand"], [{ ids: uniqueIds, width: millimetersToMeters(widthMm) }]);
    return await this.state();
  }

  async offsetRegions(regionIds: string[], offsetsMm: number[], individual: boolean, revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (regionIds.length === 0) throw new Error("At least one Region ID is required");
    const uniqueRegionIds = [...new Set(regionIds)];
    if (uniqueRegionIds.length !== regionIds.length) throw new Error("Region IDs must be unique");
    if (offsetsMm.length < 1 || offsetsMm.length > 2) throw new Error("Region offset requires one or two distances");
    if (offsetsMm.some((value) => !Number.isFinite(value) || value === 0)) throw new Error("Region offset distances must be finite and nonzero");
    if (new Set(offsetsMm).size !== offsetsMm.length) throw new Error("Region offset distances must be unique");
    const selected = uniqueRegionIds.map((id) => state.regions.find((region) => region.id === id));
    const missing = uniqueRegionIds.filter((_id, index) => !selected[index]);
    if (missing.length > 0) throw new Error(`Stale or unknown regions: ${missing.join(", ")}`);
    const islandVersionIds = new Set(selected.map((region) => region!.islandVersionId));
    if (islandVersionIds.size !== 1) throw new Error("Region offsets must belong to the same sketch island");
    const islandVersionId = selected[0]!.islandVersionId;
    await this.runtime.mutate(`async function (Factory, args) {
      ${commandStart("OffsetRegionCommand")}
      const island = editor.geo.geometryModel.get(args.islandVersionId);
      if (!island || island.view?.constructor?.name !== 'SketchIsland') throw new Error('Stale or unknown Region sketch');
      const wanted = new Set(args.regionIds);
      const regions = [];
      for (let index = 0; index < (island.view.regions?.length ?? 0); index += 1) {
        const region = island.view.regions.get(index);
        if (region && wanted.has(String(region.versionId))) regions.push(region);
      }
      const found = new Set(regions.map(region => String(region.versionId)));
      const missing = args.regionIds.filter(id => !found.has(id));
      if (missing.length > 0) throw new Error('Stale or unknown regions: ' + missing.join(', '));
      factory.sketch = island.view;
      factory.regions = regions;
      factory.distance1 = args.distance1;
      factory.distance2 = args.distance2;
      factory.isIndividual = args.individual;
      ${commandEnd}
    }`, ["OffsetRegionFactory"], [{
      regionIds: uniqueRegionIds,
      islandVersionId,
      distance1: millimetersToMeters(offsetsMm[0]!),
      distance2: offsetsMm[1] === undefined ? 0 : millimetersToMeters(offsetsMm[1]),
      individual,
    }]);
    return await this.state();
  }

  async trimCurveFragments(fragmentIds: string[], revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (fragmentIds.length === 0) throw new Error("At least one curve fragment ID is required");
    const uniqueIds = [...new Set(fragmentIds)];
    if (uniqueIds.length !== fragmentIds.length) throw new Error("Curve fragment IDs must be unique");
    await this.runtime.mutate(`async function (Factory, args) {
      ${commandStart("TrimCommand")}
      const wanted = new Set(args.fragmentIds);
      const selected = [];
      for (const info of editor.fragments.read.modelId2info.values()) {
        const fragmentItem = editor.geo.geometryModel.get(info.fragmentViewId);
        if (!fragmentItem) continue;
        for (const segment of Array.from(fragmentItem.view?.segments ?? [])) {
          if (wanted.has(String(segment.versionId))) selected.push(segment);
        }
      }
      const found = new Set(selected.map(segment => String(segment.versionId)));
      const missing = args.fragmentIds.filter(id => !found.has(id));
      if (missing.length > 0) throw new Error('Stale or unknown curve fragments: ' + missing.join(', '));
      factory.segments = selected;
      ${commandEnd}
    }`, ["TrimFactory"], [{ fragmentIds: uniqueIds }]);
    return await this.state();
  }

  async extendCurveEndpoints(endpointIds: string[], distanceMm: number, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (!Number.isFinite(distanceMm) || distanceMm <= 0) throw new Error("Curve extension distance must be positive");
    if (endpointIds.length === 0) throw new Error("At least one curve endpoint ID is required");
    const uniqueIds = [...new Set(endpointIds)];
    if (uniqueIds.length !== endpointIds.length) throw new Error("Curve endpoint IDs must be unique");
    await this.runtime.mutate(`async function (Factory, args) {
      ${commandStart("ExtendCurveCommand")}
      const wanted = new Set(args.endpointIds);
      const selected = [];
      for (const [, item] of editor.geo.geometryModel) {
        if (item.view?.constructor?.name !== 'Wire') continue;
        for (const vertex of Array.from(item.view.vertices ?? [])) {
          if (!wanted.has(String(vertex.versionId))) continue;
          const model = editor.db.lookupTopologyItem(vertex);
          if (!model.IsSpur()) throw new Error('Curve extension requires open Wire endpoints');
          selected.push(vertex);
        }
      }
      const found = new Set(selected.map(vertex => String(vertex.versionId)));
      const missing = args.endpointIds.filter(id => !found.has(id));
      if (missing.length > 0) throw new Error('Stale or unknown curve endpoints: ' + missing.join(', '));
      factory.vertices = selected;
      factory.distance = args.distance;
      ${commandEnd}
    }`, ["MultiExtendVertexFactory"], [{ endpointIds: uniqueIds, distance: millimetersToMeters(distanceMm) }]);
    return await this.state();
  }

  async convertCurveVerticesToControlPoints(vertices: VertexReference[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (vertices.length === 0) throw new Error("At least one curve vertex is required");
    const keys = vertices.map(({ bodyId, vertexId }) => `${bodyId}:${vertexId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Curve vertex references must be unique");
    const invalidBodies = [...new Set(vertices.map(({ bodyId }) => bodyId))]
      .filter((bodyId) => state.bodies.find((body) => body.id === bodyId)?.type !== "Wire");
    if (invalidBodies.length > 0) {
      throw new Error(`Curve vertex conversion requires current Wire bodies: ${invalidBodies.join(", ")}`);
    }
    const listed = await this.listCurveVertices();
    if (listed.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${listed.revision}`);
    }
    const byKey = new Map(listed.vertices.map((vertex) => [vertex.id, vertex]));
    const missing = keys.filter((key) => !byKey.has(key));
    if (missing.length > 0) throw new Error(`Stale or unknown curve vertices: ${missing.join(", ")}`);
    const endpoints = keys.filter((key) => byKey.get(key)?.endpoint);
    if (endpoints.length > 0) {
      throw new Error(`Curve vertex conversion requires interior or closed Wire vertices: ${endpoints.join(", ")}`);
    }
    const invalidDegree = keys.filter((key) => byKey.get(key)?.adjacentEdgeEntityIds.length !== 2);
    if (invalidDegree.length > 0) {
      throw new Error(`Curve vertex conversion requires exactly two adjacent segments: ${invalidDegree.join(", ")}`);
    }
    await this.runtime.mutate(`async function (Factory, Command, args) {
      const editor = this;
      if (editor.executor.isBusy) throw new Error('Plasticity is busy');
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const wanted = new Set(args.vertices.map(reference => reference.bodyId + ':' + reference.vertexId));
          const selected = [];
          const found = new Set();
          for (const [versionId, item] of editor.geo.geometryModel) {
            if (item.view?.constructor?.name !== 'Wire') continue;
            const bodyId = editor.db.lookupStableId(versionId);
            if (!Number.isInteger(bodyId)) continue;
            for (const view of Array.from(item.view.vertices ?? [])) {
              const vertex = editor.db.lookupTopologyItem(view);
              const key = bodyId + ':' + vertex.Id();
              if (!wanted.has(key)) continue;
              if (vertex.IsSpur()) throw new Error('Cannot convert endpoint vertex: ' + key);
              selected.push(view);
              found.add(key);
            }
          }
          const missing = Array.from(wanted).filter(key => !found.has(key));
          if (missing.length > 0) throw new Error('Stale or unknown curve vertices: ' + missing.join(', '));
          const factory = new Factory(editor).resource(this);
          factory.vertices = selected;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["ConvertVertexFactory", "ConvertCommand"], [{ vertices }]);
    return await this.state();
  }

  async filletCurveVertices(vertices: VertexReference[], radiusMm: number, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (!Number.isFinite(radiusMm) || radiusMm <= 0) throw new Error("Curve fillet radius must be positive");
    if (vertices.length === 0) throw new Error("At least one curve vertex is required");
    const keys = vertices.map(({ bodyId, vertexId }) => `${bodyId}:${vertexId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Curve vertex references must be unique");
    const listed = await this.listCurveVertices();
    if (listed.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${listed.revision}`);
    }
    const byKey = new Map(listed.vertices.map((vertex) => [vertex.id, vertex]));
    const missing = keys.filter((key) => !byKey.has(key));
    if (missing.length > 0) throw new Error(`Stale or unknown curve vertices: ${missing.join(", ")}`);
    const endpoints = keys.filter((key) => byKey.get(key)?.endpoint);
    if (endpoints.length > 0) throw new Error(`Curve fillet requires interior or closed Wire vertices: ${endpoints.join(", ")}`);
    const invalidDegree = keys.filter((key) => byKey.get(key)?.adjacentEdgeEntityIds.length !== 2);
    if (invalidDegree.length > 0) throw new Error(`Curve fillet requires exactly two adjacent segments at every vertex: ${invalidDegree.join(", ")}`);
    await this.runtime.mutate(`async function (Factory, args) {
      const host = this;
      const wanted = new Set(args.vertices.map(reference => reference.bodyId + ':' + reference.vertexId));
      const selected = [];
      const found = new Set();
      for (const [versionId, item] of host.geo.geometryModel) {
        if (item.view?.constructor?.name !== 'Wire') continue;
        const bodyId = host.db.lookupStableId(versionId);
        if (!Number.isInteger(bodyId)) continue;
        for (const view of Array.from(item.view.vertices ?? [])) {
          const vertex = host.db.lookupTopologyItem(view);
          const key = bodyId + ':' + vertex.Id();
          if (!wanted.has(key)) continue;
          selected.push(view);
          found.add(key);
        }
      }
      const missing = Array.from(wanted).filter(key => !found.has(key));
      if (missing.length > 0) throw new Error('Stale or unknown curve vertices: ' + missing.join(', '));
      ${commandStart("FilletVertexCommand")}
      factory.vertices = selected;
      factory.radius = args.radius;
      ${commandEnd}
    }`, ["FilletVertexFactory"], [{ vertices, radius: millimetersToMeters(radiusMm) }]);
    return await this.state();
  }

  async unjoinCurves(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (ids.length === 0) throw new Error("At least one Wire ID is required");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Wire IDs must be unique");
    const invalid = uniqueIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve unjoin requires current Wire bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.curves = args.ids.map(find);
          return await factory.commit();
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["UnjoinCurvesCommand", "UnjoinCurvesFactory"], [{ ids: uniqueIds }]);
    return await this.state();
  }

  async duplicateCurves(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (ids.length === 0) throw new Error("At least one Wire ID is required");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Wire IDs must be unique");
    const invalid = uniqueIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve duplication requires current Wire bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.DuplicateCommand(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.curves = args.ids.map(find);
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["CurveDuplicateFactory"], [{ ids: uniqueIds }]);
    return await this.state();
  }

  async createCurvesFromRegions(regionIds: string[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (regionIds.length === 0) throw new Error("At least one Region ID is required");
    const uniqueIds = [...new Set(regionIds)];
    if (uniqueIds.length !== regionIds.length) throw new Error("Region IDs must be unique");
    const current = new Set(state.regions.map((region) => region.id));
    const missing = uniqueIds.filter((id) => !current.has(id));
    if (missing.length > 0) throw new Error(`Stale or unknown Region IDs: ${missing.join(", ")}`);
    await this.runtime.mutate(`async function (Factory, args) {
      const wanted = new Set(args.regionIds);
      const regions = [];
      for (const [, item] of this.geo.geometryModel) {
        if (item.view?.constructor?.name !== 'SketchIsland') continue;
        for (let index = 0; index < (item.view.regions?.length ?? 0); index += 1) {
          const region = item.view.regions.get(index);
          if (region && wanted.has(String(region.versionId))) regions.push(region);
        }
      }
      const found = new Set(regions.map(region => String(region.versionId)));
      const missing = args.regionIds.filter(id => !found.has(id));
      if (missing.length > 0) throw new Error('Stale or unknown Regions: ' + missing.join(', '));
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.DuplicateCommand(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.regions = regions;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["CreateCurvesFromRegionsFactory"], [{ regionIds: uniqueIds }]);
    return await this.state();
  }

  async joinCurves(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (ids.length < 2) throw new Error("At least two Wire IDs are required");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Wire IDs must be unique");
    const invalid = uniqueIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve join requires current Wire bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.curves = args.ids.map(find);
          return await factory.commit();
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["JoinCurvesCommand", "JoinCurvesFactory"], [{ ids: uniqueIds }]);
    return await this.state();
  }

  async rebuildCurves(ids: number[], options: RebuildCurveOptions, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one Wire ID is required");
    if (new Set(ids).size !== ids.length) throw new Error("Wire IDs must be unique");
    const invalid = ids.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve rebuild requires current Wire bodies: ${invalid.join(", ")}`);
    const preserveParameterization = options.preserveParameterization ?? false;
    const preserveChain = options.preserveChain ?? true;
    const keepCorners = options.keepCorners ?? true;
    let method: 0 | 1 | 2;
    let parameters: { tolerance?: number; pointCount?: number; degree?: number; spans?: number };
    switch (options.method) {
      case "tolerance":
        if (!Number.isFinite(options.toleranceMm) || options.toleranceMm <= 0) throw new Error("Curve rebuild tolerance must be positive");
        method = 0;
        parameters = { tolerance: millimetersToMeters(options.toleranceMm) };
        break;
      case "control-points":
        if (!Number.isInteger(options.pointCount) || options.pointCount < 4 || options.pointCount > 10_000) {
          throw new Error("Curve rebuild control-point count must be an integer from 4 to 10000");
        }
        method = 1;
        parameters = { pointCount: options.pointCount };
        break;
      case "degree-spans":
        if (!Number.isInteger(options.degree) || options.degree < 1 || options.degree > 15) {
          throw new Error("Curve rebuild degree must be an integer from 1 to 15");
        }
        if (!Number.isInteger(options.spans) || options.spans < 1 || options.spans > 10_000 || options.degree + options.spans > 10_000) {
          throw new Error("Curve rebuild spans must produce from 2 to 10000 control points with the selected degree");
        }
        method = 2;
        parameters = { degree: options.degree, spans: options.spans };
        break;
      default:
        throw new Error(`Unsupported curve rebuild method: ${String((options as { method?: unknown }).method)}`);
    }
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("RebuildCurveCommand")}
      factory.curves = args.ids.map(find);
      factory.method = args.method;
      factory.preserveParameterization = args.preserveParameterization;
      factory.preserveChain = args.preserveChain;
      factory.keepCorners = args.keepCorners;
      if (args.method === 0) factory.tolerance = args.parameters.tolerance;
      else if (args.method === 1) factory.pointCount = args.parameters.pointCount;
      else {
        factory.degree = args.parameters.degree;
        factory.spans = args.parameters.spans;
      }
      ${commandEnd}
    }`, ["RebuildCurveFactory"], [{
      ids,
      method,
      parameters,
      preserveParameterization,
      preserveChain,
      keepCorners,
    }]);
    return await this.state();
  }

  async raiseCurveDegree(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one Wire ID is required");
    if (new Set(ids).size !== ids.length) throw new Error("Wire IDs must be unique");
    const invalid = ids.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve degree elevation requires current Wire bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(`async function (Factory, Command, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.curves = args.ids.map(find);
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["RaiseDegreeCurveFactory", "RaiseDegreeCurveCommand"], [{ ids }]);
    return await this.state();
  }

  async subdivideCurves(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one Wire ID is required");
    if (new Set(ids).size !== ids.length) throw new Error("Wire IDs must be unique");
    const invalid = ids.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve subdivision requires current Wire bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(`async function (Factory, Command, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.curves = args.ids.map(find);
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["SubdivideCurveFactory", "SubdivideCurveCommand"], [{ ids }]);
    return await this.state();
  }

  async insertCurveKnot(
    reference: CurveSegmentReference,
    normalizedParameter: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (state.bodies.find((body) => body.id === reference.bodyId)?.type !== "Wire") {
      throw new Error(`Curve knot insertion requires a current Wire body: ${reference.bodyId}`);
    }
    if (!Number.isInteger(reference.segmentEntityId) || reference.segmentEntityId <= 0) {
      throw new Error("Curve knot segment entity ID must be a positive integer");
    }
    if (!Number.isFinite(normalizedParameter) || normalizedParameter <= 0 || normalizedParameter >= 1) {
      throw new Error("Curve knot normalized parameter must be greater than 0 and less than 1");
    }
    await this.runtime.mutate(`async function (Factory, Command, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const wire = find(args.reference.bodyId);
      if (wire?.constructor?.name !== 'Wire') throw new Error('Curve knot source is no longer a Wire');
      let segment;
      let edge;
      for (const candidate of Array.from(wire.segments ?? [])) {
        const model = editor.db.lookupTopologyItem(candidate);
        if (Number(model?.Id?.()) !== args.reference.segmentEntityId) continue;
        segment = candidate;
        edge = model;
        break;
      }
      if (!segment || !edge) throw new Error('Stale or unknown curve segment: ' + args.reference.bodyId + ':' + args.reference.segmentEntityId);
      const wrapped = edge.GetCurve();
      const curve = wrapped?.curve ?? wrapped;
      if (curve?.constructor?.name !== 'BCurve') throw new Error('Curve knot insertion requires a native B-Spline segment');
      const nativeParameter = edge.Denormalize(args.normalizedParameter);
      if (!Number.isFinite(nativeParameter)) throw new Error('Native curve parameter is unavailable');

      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.segment = segment;
          const model = factory._segment?.model;
          if (!model) throw new Error('Plasticity 26.1.3 Insert Knot model bridge is unavailable');
          // InsertKnotFactory's public segment setter does not populate its private UI parameter.
          // Keep the native factory transaction, database replacement, and history behavior while
          // supplying the explicit normalized MCP parameter to the same kernel Edge::InsertKnot call.
          factory._segment.model = new Proxy(model, {
            get(target, key) {
              if (key === 'InsertKnot') return () => target.InsertKnot(nativeParameter);
              const value = Reflect.get(target, key, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["InsertKnotFactory", "InsertKnotCommand"], [{ reference, normalizedParameter }]);
    return await this.state();
  }

  async splitCurveSegment(
    reference: CurveSegmentReference,
    normalizedParameter: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (state.bodies.find((body) => body.id === reference.bodyId)?.type !== "Wire") {
      throw new Error(`Curve segment split requires a current Wire body: ${reference.bodyId}`);
    }
    if (!Number.isInteger(reference.segmentEntityId) || reference.segmentEntityId <= 0) {
      throw new Error("Curve split segment entity ID must be a positive integer");
    }
    if (!Number.isFinite(normalizedParameter) || normalizedParameter <= 0 || normalizedParameter >= 1) {
      throw new Error("Curve split normalized parameter must be greater than 0 and less than 1");
    }
    await this.runtime.mutate(`async function (Factory, Command, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const wire = find(args.reference.bodyId);
      if (wire?.constructor?.name !== 'Wire') throw new Error('Curve split source is no longer a Wire');
      let segment;
      let edge;
      for (const candidate of Array.from(wire.segments ?? [])) {
        const model = editor.db.lookupTopologyItem(candidate);
        if (Number(model?.Id?.()) !== args.reference.segmentEntityId) continue;
        segment = candidate;
        edge = model;
        break;
      }
      if (!segment || !edge) throw new Error('Stale or unknown curve segment: ' + args.reference.bodyId + ':' + args.reference.segmentEntityId);
      if (edge.IsPeriodic()) throw new Error('Periodic closed curve segments cannot be split at only one point');

      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.segment = segment;
          const model = factory._segment?.model;
          if (!model) throw new Error('Plasticity 26.1.3 Split Segment model bridge is unavailable');
          // SplitSegmentFactory receives the split parameter only from its private UI command.
          // Preserve the native commit/database/history path and supply the explicit MCP value
          // to the same normalized Edge::SplitAt call used by that factory.
          factory._segment.model = new Proxy(model, {
            get(target, key) {
              if (key === 'SplitAt') return () => target.SplitAt(args.normalizedParameter);
              const value = Reflect.get(target, key, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["SplitSegmentFactory", "SplitSegmentCommand"], [{ reference, normalizedParameter }]);
    return await this.state();
  }

  async planarizeCurves(ids: number[], originMm: Vector3, normal: Vector3, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one Wire ID is required");
    if (new Set(ids).size !== ids.length) throw new Error("Wire IDs must be unique");
    const invalid = ids.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve planarization requires current Wire bodies: ${invalid.join(", ")}`);
    const unitNormal = normalize(normal);
    await this.runtime.mutate(`async function (Factory, Command, Vector, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.curves = args.ids.map(find);
          factory.origin.copy(new Vector(...args.origin));
          factory.normal.copy(new Vector(...args.normal));
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["PlanarizeCurveFactory", "DeformCurveCommand", "Vector3"], [{ ids, origin: toMeters(originMm), normal: unitNormal }]);
    return await this.state();
  }

  async moveCurveControlPoints(
    points: CurveControlPointReference[],
    deltaMm: Vector3,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertCurveControlPointReferences(points, revision);
    if (deltaMm.some((value) => !Number.isFinite(value)) || Math.hypot(...deltaMm) === 0) {
      throw new Error("Curve control point move delta must be a finite nonzero vector");
    }
    await this.runtime.mutate(`async function (Factory, Command, args) {
      ${findCurveControlPoints}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          if (vertices.length > 0) factory.vertices = vertices;
          if (cvs.length > 0) factory.cvs = cvs;
          factory.move.fromArray(args.delta);
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["MultiMoveControlPointFactory", "MoveControlPointCommand"], [{ points, delta: toMeters(deltaMm) }]);
    return await this.state();
  }

  async slideCurveControlPoints(
    points: CurveControlPointReference[],
    direction: "positive-u" | "negative-u",
    distanceMm: number,
    revision: string,
  ): Promise<RuntimeState> {
    const inventory = await this.assertCurveControlPointReferences(points, revision);
    if (!Number.isFinite(distanceMm) || distanceMm <= 0) {
      throw new Error("Curve control point slide distance must be finite and positive");
    }
    const nativeDirection = direction === "positive-u" ? "posU" : direction === "negative-u" ? "negU" : undefined;
    if (!nativeDirection) throw new Error(`Unsupported curve control point slide direction: ${String(direction)}`);
    const slideable = new Set(inventory.curves.flatMap((curve) => [
      ...curve.boundaryVertices.filter((point) => point.slideDirections).map((point) => `${curve.id}:vertex:${point.reference.pointId}`),
      ...curve.interiorControlPoints.filter((point) => point.slideDirections).map((point) => `${curve.id}:control-point:${point.reference.pointId}`),
    ]));
    const unsupported = points.filter((point) => !slideable.has(`${point.bodyId}:${point.kind}:${point.pointId}`));
    if (unsupported.length > 0) {
      throw new Error(`Native slide directions are unavailable for curve control points: ${unsupported.map((point) => `${point.bodyId}:${point.kind}:${point.pointId}`).join(", ")}`);
    }
    await this.runtime.mutate(`async function (Factory, Command, args) {
      ${findCurveControlPoints}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          if (vertices.length > 0) factory.vertices = vertices;
          if (cvs.length > 0) factory.cvs = cvs;
          factory.direction = args.direction;
          factory.distance = args.distance;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["MultiSlideControlPointFactory", "MoveControlPointCommand"], [{
      points,
      direction: nativeDirection,
      distance: millimetersToMeters(distanceMm),
    }]);
    return await this.state();
  }

  async rotateCurveControlPoints(
    points: CurveControlPointReference[],
    pivotMm: Vector3,
    axis: Vector3,
    degrees: number,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertCurveControlPointReferences(points, revision);
    if (!Number.isFinite(degrees) || degrees === 0) throw new Error("Curve control point rotation angle must be finite and nonzero");
    const unitAxis = normalize(axis);
    await this.runtime.mutate(`async function (Factory, Command, Vector, Quaternion, args) {
      ${findCurveControlPoints}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          if (vertices.length > 0) factory.vertices = vertices;
          if (cvs.length > 0) factory.cvs = cvs;
          factory.pivot.fromArray(args.pivot);
          factory.rotation.copy(new Quaternion().setFromAxisAngle(new Vector(...args.axis), args.radians));
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["MultiRotateControlPointFactory", "RotateControlPointCommand", "Vector3", "Quaternion"], [{
      points,
      pivot: toMeters(pivotMm),
      axis: unitAxis,
      radians: degreesToRadians(degrees),
    }]);
    return await this.state();
  }

  async scaleCurveControlPoints(
    points: CurveControlPointReference[],
    pivotMm: Vector3,
    factors: Vector3,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertCurveControlPointReferences(points, revision);
    if (factors.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error("Curve control point scale factors must be finite and positive");
    }
    if (factors.every((value) => value === 1)) throw new Error("Curve control point scale must change at least one factor");
    await this.runtime.mutate(`async function (Factory, Command, args) {
      ${findCurveControlPoints}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          if (vertices.length > 0) factory.vertices = vertices;
          if (cvs.length > 0) factory.cvs = cvs;
          factory.pivot.fromArray(args.pivot);
          factory.scale.fromArray(args.factors);
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["MultiScaleControlPointFactory", "ScaleControlPointCommand"], [{ points, pivot: toMeters(pivotMm), factors }]);
    return await this.state();
  }

  async deleteCurveControlPoints(points: CurveControlPointReference[], revision: string): Promise<RuntimeState> {
    await this.assertCurveControlPointReferences(points, revision);
    if (points.some((point) => point.kind !== "control-point")) {
      throw new Error("Only interior B-Spline control points can be deleted");
    }
    const bodyIds = new Set(points.map((point) => point.bodyId));
    if (bodyIds.size !== 1) throw new Error("Deleted curve control points must belong to one Wire");
    await this.runtime.mutate(`async function (Factory, Command, args) {
      ${findCurveControlPoints}
      if (vertices.length > 0 || cvs.length !== args.points.length) throw new Error('Only interior B-Spline control points can be deleted');
      const view = views.get(args.points[0].bodyId);
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.curve = view;
          factory.cvs = cvs;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["DeleteControlPointFactory", "DeleteControlPointCommand"], [{ points }]);
    return await this.state();
  }

  async reverseCurves(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (ids.length === 0) throw new Error("At least one Wire ID is required");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Wire IDs must be unique");
    const invalid = uniqueIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve reversal requires current Wire bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.curves = args.ids.map(find);
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["ReverseCurveCommand", "ReverseCurveFactory"], [{ ids: uniqueIds }]);
    return await this.state();
  }

  async reverseSheets(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (ids.length === 0) throw new Error("At least one Sheet ID is required");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Sheet IDs must be unique");
    const invalid = uniqueIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Sheet");
    if (invalid.length > 0) throw new Error(`Sheet reversal requires current Sheet bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.sheets = args.ids.map(find);
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["ReverseSheetCommand", "ReverseSheetFactory"], [{ ids: uniqueIds }]);
    return await this.state();
  }

  async createBodyOutlines(
    ids: number[],
    planeIdentity: ReferenceIdentity,
    placement: "source" | "workplane",
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.syncConstructionState(revision);
    if (ids.length === 0) throw new Error("At least one Solid or Sheet is required for body outlines");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Body outline IDs must be unique");
    if (placement !== "source" && placement !== "workplane") {
      throw new Error(`Unsupported body outline placement: ${String(placement)}`);
    }
    const invalid = uniqueIds.filter((id) => {
      const type = state.bodies.find((body) => body.id === id)?.type;
      return type !== "Solid" && type !== "Sheet";
    });
    if (invalid.length > 0) throw new Error(`Body outlines require current Solid or Sheet bodies: ${invalid.join(", ")}`);
    const plane = this.datumRegistry.requireCurrentPlane(planeIdentity, state.documentToken, state.revision);
    const factoryBinding = placement === "source" ? "CreateOutlineFromShellsFactory" : "ProjectOutlineFromShellsFactory";
    await this.runtime.mutate(`async function (Factory, Database, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const viewport = Array.from(this.viewports)[0];
      if (!viewport) throw new Error('Plasticity viewport is unavailable');
      let selected;
      if (args.plane.source === 'standard') {
        selected = Database[args.plane.nativeId];
      } else {
        const snapshot = this.planes.snapshot();
        const idEntries = snapshot.ids instanceof Map ? Array.from(snapshot.ids) : Object.entries(snapshot.ids ?? {});
        const idEntry = idEntries.find(([, nativeId]) => String(nativeId) === args.plane.nativeId);
        const index = idEntry ? Number(idEntry[0]) : undefined;
        selected = snapshot.planes?.[index];
      }
      if (!selected) throw new Error('Construction plane is unavailable: ' + args.plane.nativeId);
      const previous = viewport.constructionPlane;
      viewport.constructionPlane = selected;
      if (viewport.constructionPlane !== selected) throw new Error('Plasticity did not activate the requested outline plane');
      viewport.setNeedsRender();

      const shells = args.ids.map(id => {
        const view = find(id);
        if (view.constructor.name !== 'Solid' && view.constructor.name !== 'Sheet') {
          throw new Error('Body outline inputs must be Solid or Sheet bodies');
        }
        return view;
      });
      const editor = this;
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.shells = shells;
          return await factory.commit();
        } catch (error) {
          failure = error;
          viewport.constructionPlane = previous;
          viewport.setNeedsRender();
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, [factoryBinding, "ConstructionPlaneDatabase"], [{
      ids: uniqueIds,
      plane: { id: plane.id, nativeId: plane.nativeId, source: plane.source },
    }]);
    return await this.state();
  }

  async curvePattern(ids: number[], spineId: number, count: number, revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (ids.length === 0) throw new Error("At least one Solid or Sheet is required for a curve pattern");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Curve-pattern body IDs must be unique");
    const invalid = uniqueIds.filter((id) => {
      const type = state.bodies.find((body) => body.id === id)?.type;
      return type !== "Solid" && type !== "Sheet";
    });
    if (invalid.length > 0) throw new Error(`Curve pattern requires current Solid or Sheet bodies: ${invalid.join(", ")}`);
    if (state.bodies.find((body) => body.id === spineId)?.type !== "Wire") {
      throw new Error(`Curve pattern requires a current Wire spine: ${spineId}`);
    }
    if (!Number.isInteger(count) || count < 2 || count > 1000) {
      throw new Error("Curve-pattern count must be an integer between 2 and 1000");
    }
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          const spine = find(args.spineId);
          if (spine.constructor.name !== 'Wire') throw new Error('Curve pattern spine must be a Wire');
          factory.items = args.ids.map(find);
          factory.curve = spine;
          factory.num = args.count;
          factory.shouldMakeInstances = false;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["CurveArrayFactory"], [{ ids: uniqueIds, spineId, count }]);
    return await this.state();
  }

  async projectCurvesOntoBody(
    targetId: number,
    curveIds: number[],
    direction: Vector3,
    options: { bidirectional?: boolean; occlude?: boolean; completion?: "none" | "edge" | "face-set" },
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (curveIds.length === 0) throw new Error("At least one Wire ID is required");
    const uniqueIds = [...new Set(curveIds)];
    if (uniqueIds.length !== curveIds.length) throw new Error("Wire IDs must be unique");
    if (uniqueIds.includes(targetId)) throw new Error("Projection curves must not include the target body");
    const length = Math.hypot(...direction);
    if (!Number.isFinite(length) || length === 0) throw new Error("Projection direction must be nonzero");
    const normalizedDirection = direction.map((value) => value / length) as Vector3;
    const completion = options.completion ?? "none";
    const completionName = ({ none: "None", edge: "Edge", "face-set": "FaceSet" } as const)[completion];
    if (!completionName) throw new Error(`Unsupported projection completion: ${completion}`);
    await this.runtime.mutate(`async function (Factory, Vector, ProjectionMethod, ProjectionCompletionType, args) {
      const find = id => {
        for (const [versionId, item] of this.geo.geometryModel) {
          if (this.db.lookupStableId(versionId) === id) return item.view;
        }
        throw new Error('Unknown body ID: ' + id);
      };
      ${commandStart("ProjectCurveBodyCommand")}
      const target = find(args.targetId);
      if (target.constructor.name === 'Wire') throw new Error('Projection target must be a surface body');
      const curves = args.curveIds.map(id => {
        const curve = find(id);
        if (curve.constructor.name !== 'Wire') throw new Error('Projection inputs must be Wire bodies');
        return curve;
      });
      factory.target = target;
      factory.curves = curves;
      factory.method = ProjectionMethod.Vector;
      factory.direction.copy(new Vector(...args.direction));
      factory.bidirectional = args.bidirectional;
      factory.occlude = args.occlude;
      factory.complete = ProjectionCompletionType[args.completionName];
      ${commandEnd}
    }`, ["ProjectCurveBodyFactory", "Vector3", "ProjectionMethod", "ProjectionCompletionType"], [{
      targetId,
      curveIds: uniqueIds,
      direction: normalizedDirection,
      bidirectional: options.bidirectional ?? false,
      occlude: options.occlude ?? true,
      completionName,
    }]);
    return await this.state();
  }

  async createBodyIntersectionCurves(targetId: number, toolIds: number[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (toolIds.length === 0) throw new Error("At least one intersection tool body is required");
    const uniqueIds = [...new Set(toolIds)];
    if (uniqueIds.length !== toolIds.length) throw new Error("Intersection tool body IDs must be unique");
    if (uniqueIds.includes(targetId)) throw new Error("The intersection target cannot also be a tool body");
    const targetType = state.bodies.find((body) => body.id === targetId)?.type;
    if (targetType !== "Solid" && targetType !== "Sheet") {
      throw new Error(`Body intersection target must be a current Solid or Sheet: ${targetId}`);
    }
    const invalid = uniqueIds.filter((id) => {
      const type = state.bodies.find((body) => body.id === id)?.type;
      return type !== "Solid" && type !== "Sheet";
    });
    if (invalid.length > 0) throw new Error(`Body intersection tools must be current Solid or Sheet bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.target = find(args.targetId);
          factory.tools = args.toolIds.map(find);
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["ProjectBodyBodyCommand", "ProjectBodyBodyFactory"], [{ targetId, toolIds: uniqueIds }]);
    return await this.state();
  }

  async projectCurvePair(
    firstId: number,
    firstDirection: Vector3,
    secondId: number,
    secondDirection: Vector3,
    projectionDepthMm: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (firstId === secondId) throw new Error("Curve projection requires two distinct Wire bodies");
    for (const id of [firstId, secondId]) {
      if (state.bodies.find((body) => body.id === id)?.type !== "Wire") {
        throw new Error(`Curve projection requires a current Wire body: ${id}`);
      }
    }
    const normalize = (value: Vector3, label: string): Vector3 => {
      const length = Math.hypot(...value);
      if (!Number.isFinite(length) || length === 0) throw new Error(`${label} must be nonzero`);
      return value.map((component) => component / length) as Vector3;
    };
    const first = normalize(firstDirection, "First projection direction");
    const second = normalize(secondDirection, "Second projection direction");
    const crossLength = Math.hypot(
      first[1] * second[2] - first[2] * second[1],
      first[2] * second[0] - first[0] * second[2],
      first[0] * second[1] - first[1] * second[0],
    );
    if (crossLength <= 1e-9) throw new Error("Curve projection directions must not be parallel");
    if (!Number.isFinite(projectionDepthMm) || projectionDepthMm <= 0) {
      throw new Error("Curve projection depth must be positive");
    }
    await this.runtime.mutate(`async function (Command, Factory, Vector, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.curve1 = find(args.firstId);
          factory.curve2 = find(args.secondId);
          factory.extrude1.direction.copy(new Vector(...args.firstDirection));
          factory.extrude1.distance1 = args.projectionDepth;
          factory.extrude1.distance2 = -args.projectionDepth;
          factory.extrude2.direction.copy(new Vector(...args.secondDirection));
          factory.extrude2.distance1 = args.projectionDepth;
          factory.extrude2.distance2 = -args.projectionDepth;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["ProjectCurveCurveCommand", "ProjectCurveCurveFactory", "Vector3"], [{
      firstId,
      firstDirection: first,
      secondId,
      secondDirection: second,
      projectionDepth: millimetersToMeters(projectionDepthMm),
    }]);
    return await this.state();
  }

  async insertIsoparamEdges(
    face: { bodyId: number; faceId: string },
    direction: "u" | "v",
    count: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    const body = state.bodies.find((candidate) => candidate.id === face.bodyId);
    if ((body?.type !== "Solid" && body?.type !== "Sheet") || !body.faceIds.includes(face.faceId)) {
      throw new Error(`Isoparam insertion requires a current Solid or Sheet face: ${face.bodyId}:${face.faceId}`);
    }
    if (!Number.isInteger(count) || count < 1 || count > 1000) {
      throw new Error("Isoparam count must be an integer between 1 and 1000");
    }
    await this.runtime.mutate(`async function (Factory, args) {
      ${findFaceViews}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.IsoparamCommand(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.shell = find(args.faces[0].bodyId);
          factory.face = selectedFaces[0];
          factory.count = args.count;
          if (factory.uOrV !== args.uOrV) factory.toggleUV();
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["IsoparamFactory"], [{ faces: [face], count, uOrV: direction === "u" }]);
    return await this.state();
  }

  async raiseSurfaceDegree(faces: FaceReference[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, faces, "face");
    const invalid = faces.filter((reference) => {
      const body = state.bodies.find((candidate) => candidate.id === reference.bodyId);
      return (body?.type !== "Solid" && body?.type !== "Sheet") ||
        body.faces.find((face) => face.id === reference.faceId)?.surfaceType !== "BSurf";
    });
    if (invalid.length > 0) {
      throw new Error(`Surface degree elevation requires current B-Surface faces: ${invalid.map((face) => `${face.bodyId}:${face.faceId}`).join(", ")}`);
    }
    await this.runtime.mutate(`async function (Factory, Command, args) {
      ${findFaceViews}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.faces = selectedFaces;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["RaiseDegreeFaceFactory", "RaiseDegreeFaceCommand"], [{ faces }]);
    return await this.state();
  }

  async rebuildFace(face: FaceReference, toleranceMm: number, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, [face], "face");
    const body = state.bodies.find((candidate) => candidate.id === face.bodyId);
    if (body?.type !== "Solid" && body?.type !== "Sheet") {
      throw new Error(`Face rebuild requires a current Solid or Sheet body: ${face.bodyId}`);
    }
    if (!Number.isFinite(toleranceMm) || toleranceMm <= 0 || toleranceMm > 10) {
      throw new Error("Face rebuild tolerance must be positive and no greater than 10 mm");
    }
    await this.runtime.mutate(`async function (Factory, Command, RebuildFaceMethod, ChangeEdgeMethod, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const view = find(args.face.bodyId);
      if (view?.constructor?.name !== 'Solid' && view?.constructor?.name !== 'Sheet') {
        throw new Error('Face rebuild source is no longer a Solid or Sheet');
      }
      const index = view.high.faces.versionIds.indexOf(args.face.faceId);
      if (index < 0) throw new Error('Stale or unknown face: ' + args.face.faceId);
      const selectedFace = view.high.faces.get(index);
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.shell = view;
          factory.face = selectedFace;
          factory.method = RebuildFaceMethod.Refit;
          factory.tolerance = args.tolerance;
          factory.changeEdgeMethod = ChangeEdgeMethod.Project;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["RebuildFaceFactory", "RebuildFaceCommand", "RebuildFaceMethod", "ChangeEdgeMethod"], [{
      face,
      tolerance: millimetersToMeters(toleranceMm),
    }]);
    return await this.state();
  }

  async matchFaces(
    faces: FaceReference[],
    replacement: FaceReference,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (faces.length === 0) throw new Error("At least one source face is required for face matching");
    requireTopologySelection(state, [...faces, replacement], "face");
    const invalidBodies = [...new Set([...faces, replacement].map((reference) => reference.bodyId))].filter((bodyId) => {
      const type = state.bodies.find((body) => body.id === bodyId)?.type;
      return type !== "Solid" && type !== "Sheet";
    });
    if (invalidBodies.length > 0) {
      throw new Error(`Face matching requires current Solid or Sheet bodies: ${invalidBodies.join(", ")}`);
    }
    await this.runtime.mutate(`async function (Factory, Command, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const face = reference => {
        const view = find(reference.bodyId);
        if (view?.constructor?.name !== 'Solid' && view?.constructor?.name !== 'Sheet') {
          throw new Error('Face matching input is no longer a Solid or Sheet');
        }
        const index = view.high.faces.versionIds.indexOf(reference.faceId);
        if (index < 0) throw new Error('Stale or unknown matching face: ' + reference.bodyId + ':' + reference.faceId);
        return view.high.faces.get(index);
      };
      const sourceShells = Array.from(new Set(args.faces.map(reference => find(reference.bodyId))));
      const sourceFaces = args.faces.map(face);
      const replacementFace = face(args.replacement);
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.shells = sourceShells;
          factory.faces = sourceFaces;
          factory.replacement = replacementFace;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["MatchFaceFactory", "MatchFaceCommand"], [{ faces, replacement }]);
    return await this.state();
  }

  async untrimFaces(faces: FaceReference[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, faces, "face");
    const invalidBodies = [...new Set(faces.map((reference) => reference.bodyId))].filter((bodyId) => {
      const type = state.bodies.find((body) => body.id === bodyId)?.type;
      return type !== "Solid" && type !== "Sheet";
    });
    if (invalidBodies.length > 0) throw new Error(`Surface untrim requires current Solid or Sheet bodies: ${invalidBodies.join(", ")}`);
    await this.runtime.mutate(`async function (Factory, args) {
      ${findFaceViews}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.UntrimCommand(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.faces = selectedFaces;
          factory.keepEdges = false;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["UntrimFactory"], [{ faces }]);
    return await this.state();
  }

  async imprintCurvesOnBody(
    targetId: number,
    curveIds: number[],
    direction: Vector3,
    options: { bidirectional?: boolean; occlude?: boolean; completion?: "none" | "edge" | "face-set" },
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (curveIds.length === 0) throw new Error("At least one Wire ID is required");
    const uniqueIds = [...new Set(curveIds)];
    if (uniqueIds.length !== curveIds.length) throw new Error("Wire IDs must be unique");
    if (uniqueIds.includes(targetId)) throw new Error("Imprint curves must not include the target body");
    const length = Math.hypot(...direction);
    if (!Number.isFinite(length) || length === 0) throw new Error("Imprint direction must be nonzero");
    const normalizedDirection = direction.map((value) => value / length) as Vector3;
    const completion = options.completion ?? "none";
    const completionName = ({ none: "None", edge: "Edge", "face-set": "FaceSet" } as const)[completion];
    if (!completionName) throw new Error(`Unsupported imprint completion: ${completion}`);
    await this.runtime.mutate(`async function (Factory, Vector, ProjectionMethod, ProjectionCompletionType, args) {
      ${findView}
      ${commandStart("ImprintCurveBodyCommand")}
      const target = find(args.targetId);
      if (target.constructor.name === 'Wire') throw new Error('Imprint target must be a surface body');
      const curves = args.curveIds.map(id => {
        const curve = find(id);
        if (curve.constructor.name !== 'Wire') throw new Error('Imprint inputs must be Wire bodies');
        return curve;
      });
      factory.target = target;
      factory.curves = curves;
      factory.method = ProjectionMethod.Vector;
      factory.direction.copy(new Vector(...args.direction));
      factory.bidirectional = args.bidirectional;
      factory.occlude = args.occlude;
      factory.complete = ProjectionCompletionType[args.completionName];
      ${commandEnd}
    }`, ["ImprintCurveBodyFactory", "Vector3", "ProjectionMethod", "ProjectionCompletionType"], [{
      targetId,
      curveIds: uniqueIds,
      direction: normalizedDirection,
      bidirectional: options.bidirectional ?? false,
      occlude: options.occlude ?? true,
      completionName,
    }]);
    return await this.state();
  }

  async imprintBodies(targetId: number, toolIds: number[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (toolIds.length === 0) throw new Error("At least one imprint tool body is required");
    const uniqueIds = [...new Set(toolIds)];
    if (uniqueIds.length !== toolIds.length) throw new Error("Imprint tool body IDs must be unique");
    if (uniqueIds.includes(targetId)) throw new Error("The imprint target cannot also be a tool body");
    const targetType = state.bodies.find((body) => body.id === targetId)?.type;
    if (targetType !== "Solid" && targetType !== "Sheet") {
      throw new Error(`Body imprint target must be a current Solid or Sheet: ${targetId}`);
    }
    const invalid = uniqueIds.filter((id) => {
      const type = state.bodies.find((body) => body.id === id)?.type;
      return type !== "Solid" && type !== "Sheet";
    });
    if (invalid.length > 0) throw new Error(`Body imprint tools must be current Solid or Sheet bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.target = find(args.targetId);
          factory.tools = args.toolIds.map(find);
          factory.imprintTool = false;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["ImprintBodyBodyCommand", "ImprintBodyBodyFactory"], [{ targetId, toolIds: uniqueIds }]);
    return await this.state();
  }

  async sweepRegions(
    regionIds: string[],
    spineId: number,
    options: {
      alignment?: "normal" | "parallel" | "transport";
      corner?: "miter" | "round";
      twistDegrees?: number;
      scale?: number;
      simplify?: boolean;
    },
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (regionIds.length === 0) throw new Error("At least one Region ID is required");
    const uniqueIds = [...new Set(regionIds)];
    if (uniqueIds.length !== regionIds.length) throw new Error("Region IDs must be unique");
    const selected = uniqueIds.map((id) => state.regions.find((region) => region.id === id));
    const missing = uniqueIds.filter((_id, index) => !selected[index]);
    if (missing.length > 0) throw new Error(`Stale or unknown regions: ${missing.join(", ")}`);
    const spine = state.bodies.find((body) => body.id === spineId);
    if (!spine || spine.type !== "Wire") throw new Error(`Sweep requires a current Wire spine: ${spineId}`);
    if (selected.some((region) => region!.sketchWireIds.includes(spineId))) {
      throw new Error("Sweep spine must not be one of the Region profile curves");
    }
    const scale = options.scale ?? 1;
    if (!Number.isFinite(scale) || scale <= 0) throw new Error("Sweep scale must be positive");
    const twistDegrees = options.twistDegrees ?? 0;
    if (!Number.isFinite(twistDegrees)) throw new Error("Sweep twist must be finite");
    const alignmentName = ({ normal: "Normal", parallel: "Parallel", transport: "Transport" } as const)[options.alignment ?? "normal"];
    const cornerName = ({ miter: "Mitre", round: "Round" } as const)[options.corner ?? "miter"];
    await this.runtime.mutate(`async function (Factory, SweepAlignmentType, SweepCornerType, args) {
      ${commandStart("SweepCommand")}
      const wanted = new Set(args.regionIds);
      const regions = [];
      let spine;
      for (const [versionId, item] of editor.geo.geometryModel) {
        if (editor.db.lookupStableId(versionId) === args.spineId) spine = item.view;
        if (!editor.geo.automatics.has(versionId) || item.view?.constructor?.name !== 'SketchIsland') continue;
        for (let index = 0; index < (item.view.regions?.length ?? 0); index += 1) {
          const region = item.view.regions.get(index);
          if (region && wanted.has(String(region.versionId))) regions.push(region);
        }
      }
      if (!spine || spine.constructor.name !== 'Wire') throw new Error('Stale or unknown sweep spine');
      const found = new Set(regions.map(region => String(region.versionId)));
      const missing = args.regionIds.filter(id => !found.has(id));
      if (missing.length > 0) throw new Error('Stale or unknown regions: ' + missing.join(', '));
      factory.regions = regions;
      factory.spine = spine;
      factory.alignment = SweepAlignmentType[args.alignmentName];
      factory.cornerType = SweepCornerType[args.cornerName];
      factory.twistDegrees = args.twistDegrees;
      factory.scale = args.scale;
      factory.simplify = args.simplify;
      ${commandEnd}
    }`, ["SweepFactory", "SweepAlignmentType", "SweepCornerType"], [{
      regionIds: uniqueIds,
      spineId,
      alignmentName,
      cornerName,
      twistDegrees,
      scale,
      simplify: options.simplify ?? false,
    }]);
    return await this.state();
  }

  async loftRegions(
    regionIds: string[],
    options: { closed?: boolean; simplify?: boolean; guideIds?: number[]; trimGuides?: boolean },
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (regionIds.length < 2) throw new Error("Loft requires at least two Region profiles");
    const uniqueIds = [...new Set(regionIds)];
    if (uniqueIds.length !== regionIds.length) throw new Error("Loft Region IDs must be unique");
    if (options.closed && uniqueIds.length < 3) throw new Error("Closed loft requires at least three Region profiles");
    const selected = uniqueIds.map((id) => state.regions.find((region) => region.id === id));
    const missing = uniqueIds.filter((_id, index) => !selected[index]);
    if (missing.length > 0) throw new Error(`Stale or unknown regions: ${missing.join(", ")}`);
    if (new Set(selected.map((region) => region!.islandVersionId)).size !== selected.length) {
      throw new Error("Loft profiles must come from different sketch islands");
    }
    const guideIds = options.guideIds ?? [];
    if (new Set(guideIds).size !== guideIds.length) throw new Error("Loft guide IDs must be unique");
    const invalidGuides = guideIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalidGuides.length > 0) throw new Error(`Loft guides must be current Wire bodies: ${invalidGuides.join(", ")}`);
    const profileWireIds = new Set(selected.flatMap((region) => region!.sketchWireIds));
    const profileGuides = guideIds.filter((id) => profileWireIds.has(id));
    if (profileGuides.length > 0) throw new Error(`Loft guide must not reuse a profile Wire: ${profileGuides.join(", ")}`);
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("LoftCommand")}
      const available = new Map();
      for (const [versionId, item] of editor.geo.geometryModel) {
        if (!editor.geo.automatics.has(versionId) || item.view?.constructor?.name !== 'SketchIsland') continue;
        for (let index = 0; index < (item.view.regions?.length ?? 0); index += 1) {
          const region = item.view.regions.get(index);
          if (region) available.set(String(region.versionId), region);
        }
      }
      factory.regions = args.regionIds.map(id => {
        const region = available.get(id);
        if (!region) throw new Error('Stale or unknown Region: ' + id);
        return region;
      });
      if (args.guideIds.length > 0) {
        factory.guides = args.guideIds.map(id => {
          const guide = find(id);
          if (guide.constructor.name !== 'Wire') throw new Error('Loft guides must be Wire bodies');
          return guide;
        });
      }
      factory.trimGuides = args.trimGuides;
      factory.closed = args.closed;
      factory.simplify = args.simplify;
      ${commandEnd}
    }`, ["RegionLoftFactory"], [{
      regionIds: uniqueIds,
      guideIds,
      trimGuides: options.trimGuides ?? true,
      closed: options.closed ?? false,
      simplify: options.simplify ?? true,
    }]);
    return await this.state();
  }

  async loftCurves(
    profileIds: number[],
    options: {
      guideIds?: number[];
      trimGuides?: boolean;
      trimProfiles?: boolean;
      closed?: boolean;
      simplify?: boolean;
      curvature?: "natural" | "unconstrained" | "clamped";
      startMagnitude?: number;
      endMagnitude?: number;
    },
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (profileIds.length < 2) throw new Error("Curve loft requires at least two ordered Wire profiles");
    if (new Set(profileIds).size !== profileIds.length) throw new Error("Curve loft profile IDs must be unique");
    if (options.closed && profileIds.length < 3) throw new Error("Closed curve loft requires at least three Wire profiles");
    const invalidProfiles = profileIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalidProfiles.length > 0) throw new Error(`Curve loft profiles must be current Wire bodies: ${invalidProfiles.join(", ")}`);
    const guideIds = options.guideIds ?? [];
    if (new Set(guideIds).size !== guideIds.length) throw new Error("Curve loft guide IDs must be unique");
    const invalidGuides = guideIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalidGuides.length > 0) throw new Error(`Curve loft guides must be current Wire bodies: ${invalidGuides.join(", ")}`);
    const profileSet = new Set(profileIds);
    const profileGuides = guideIds.filter((id) => profileSet.has(id));
    if (profileGuides.length > 0) throw new Error(`Curve loft guide must not reuse a profile Wire: ${profileGuides.join(", ")}`);
    const startMagnitude = options.startMagnitude ?? 1;
    const endMagnitude = options.endMagnitude ?? 1;
    if (!Number.isFinite(startMagnitude) || startMagnitude <= 0 || !Number.isFinite(endMagnitude) || endMagnitude <= 0) {
      throw new Error("Curve loft start and end magnitudes must be finite and positive");
    }
    const curvature = ({ natural: "Natural", unconstrained: "Unconstrained", clamped: "Clamped" } as const)[options.curvature ?? "unconstrained"];

    await this.runtime.mutate(`async function (Factory, Command, Curvature, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      editor.selection.selected.removeAll();
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.profiles = args.profileIds.map(find);
          if (args.guideIds.length > 0) factory.guides = args.guideIds.map(find);
          factory.trimGuides = args.trimGuides;
          factory.trimProfiles = args.trimProfiles;
          factory.closed = args.closed;
          factory.simplify = args.simplify;
          factory.curvature = Curvature[args.curvature];
          factory.startMagnitude = args.startMagnitude;
          factory.endMagnitude = args.endMagnitude;
          factory.join = false;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["CurveLoftFactory", "LoftEdgeCommand", "LoftCurvatureType"], [{
      profileIds,
      guideIds,
      trimGuides: options.trimGuides ?? true,
      trimProfiles: options.trimProfiles ?? true,
      closed: options.closed ?? false,
      simplify: options.simplify ?? true,
      curvature,
      startMagnitude,
      endMagnitude,
    }]);
    return await this.state();
  }

  async loftFaces(
    faces: FaceReference[],
    options: {
      guideIds?: number[];
      trimGuides?: boolean;
      simplify?: boolean;
      startCondition?: "natural" | "unconstrained" | "clamped";
      endCondition?: "natural" | "unconstrained" | "clamped";
      startMagnitude?: number;
      endMagnitude?: number;
    },
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (faces.length < 2) throw new Error("Face loft requires at least two ordered planar faces");
    const keys = faces.map((face) => `${face.bodyId}:${face.faceId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Face loft references must be unique");
    if (new Set(faces.map((face) => face.bodyId)).size !== faces.length) {
      throw new Error("Face loft profiles must come from different source bodies");
    }
    requireTopologySelection(state, faces, "face");
    const bodies = new Map(state.bodies.map((body) => [body.id, body]));
    const invalidBodies = faces.filter((face) => !["Solid", "Sheet"].includes(bodies.get(face.bodyId)!.type));
    if (invalidBodies.length > 0) {
      throw new Error(`Face loft profiles must belong to current Solid or Sheet bodies: ${invalidBodies.map((face) => face.bodyId).join(", ")}`);
    }
    const nonPlanar = faces.filter((reference) => !bodies.get(reference.bodyId)!.faces.find((face) => face.id === reference.faceId)!.planar);
    if (nonPlanar.length > 0) {
      throw new Error(`Face loft currently requires planar profile faces: ${nonPlanar.map((face) => `${face.bodyId}:${face.faceId}`).join(", ")}`);
    }
    const guideIds = options.guideIds ?? [];
    if (new Set(guideIds).size !== guideIds.length) throw new Error("Face loft guide IDs must be unique");
    const invalidGuides = guideIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalidGuides.length > 0) throw new Error(`Face loft guides must be current Wire bodies: ${invalidGuides.join(", ")}`);
    const startMagnitude = options.startMagnitude ?? 1;
    const endMagnitude = options.endMagnitude ?? 1;
    if (!Number.isFinite(startMagnitude) || startMagnitude <= 0 || !Number.isFinite(endMagnitude) || endMagnitude <= 0) {
      throw new Error("Face loft start and end magnitudes must be finite and positive");
    }
    const conditionNames = { natural: "Natural", unconstrained: "Unconstrained", clamped: "Clamped" } as const;
    const startCondition = conditionNames[options.startCondition ?? "unconstrained"];
    const endCondition = conditionNames[options.endCondition ?? "unconstrained"];

    await this.runtime.mutate(`async function (Factory, Command, Curvature, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const face = reference => {
        const view = find(reference.bodyId);
        if (view?.constructor?.name !== 'Solid' && view?.constructor?.name !== 'Sheet') {
          throw new Error('Face loft profile is no longer a Solid or Sheet');
        }
        const index = view.high.faces.versionIds.indexOf(reference.faceId);
        if (index < 0) throw new Error('Stale or unknown Face loft profile: ' + reference.bodyId + ':' + reference.faceId);
        return view.high.faces.get(index);
      };
      editor.selection.selected.removeAll();
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.faces = args.faces.map(face);
          if (args.guideIds.length > 0) {
            factory.guides = args.guideIds.map(id => {
              const guide = find(id);
              if (guide?.constructor?.name !== 'Wire') throw new Error('Face loft guide is no longer a Wire');
              return guide;
            });
          }
          factory.trimGuides = args.trimGuides;
          factory.closed = false;
          factory.simplify = args.simplify;
          factory.startCurvature = Curvature[args.startCondition];
          factory.endCurvature = Curvature[args.endCondition];
          factory.startMagnitude = args.startMagnitude;
          factory.endMagnitude = args.endMagnitude;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["FaceLoftFactory", "LoftSurfaceCommand", "LoftCurvatureType"], [{
      faces,
      guideIds,
      trimGuides: options.trimGuides ?? true,
      simplify: options.simplify ?? true,
      startCondition,
      endCondition,
      startMagnitude,
      endMagnitude,
    }]);
    return await this.state();
  }

  async patchRegions(regionIds: string[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (regionIds.length === 0) throw new Error("At least one Region ID is required");
    const uniqueIds = [...new Set(regionIds)];
    if (uniqueIds.length !== regionIds.length) throw new Error("Region IDs must be unique");
    const availableIds = new Set(state.regions.map((region) => region.id));
    const missing = uniqueIds.filter((id) => !availableIds.has(id));
    if (missing.length > 0) throw new Error(`Stale or unknown regions: ${missing.join(", ")}`);
    await this.runtime.mutate(`async function (Factory, args) {
      ${commandStart("PatchCommand")}
      const wanted = new Set(args.regionIds);
      const regions = [];
      for (const [versionId, item] of editor.geo.geometryModel) {
        if (!editor.geo.automatics.has(versionId) || item.view?.constructor?.name !== 'SketchIsland') continue;
        for (let index = 0; index < (item.view.regions?.length ?? 0); index += 1) {
          const region = item.view.regions.get(index);
          if (region && wanted.has(String(region.versionId))) regions.push(region);
        }
      }
      const found = new Set(regions.map(region => String(region.versionId)));
      const missing = args.regionIds.filter(id => !found.has(id));
      if (missing.length > 0) throw new Error('Stale or unknown regions: ' + missing.join(', '));
      factory.regions = regions;
      ${commandEnd}
    }`, ["PatchRegionFactory"], [{ regionIds: uniqueIds }]);
    return await this.state();
  }

  async patchClosedWires(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0 || new Set(ids).size !== ids.length) {
      throw new Error("Closed-Wire patch IDs must be a nonempty unique list");
    }
    const current = new Map(state.bodies.map((body) => [body.id, body]));
    const missing = ids.filter((id) => !current.has(id));
    if (missing.length > 0) throw new Error(`Unknown current closed-Wire patch body IDs: ${missing.join(", ")}`);
    const invalid = ids.filter((id) => current.get(id)!.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Closed-Wire patching requires current Wire bodies: ${invalid.join(", ")}`);
    const closure = await this.runtime.read<Array<{ id: number; closed: boolean }>>(`function (ids) {
      const wanted = new Set(ids);
      const result = [];
      for (const [versionId, item] of this.geo.geometryModel) {
        const id = this.db.lookupStableId(versionId);
        if (!wanted.has(id)) continue;
        if (item.view?.constructor?.name !== 'Wire') throw new Error('Closed-Wire patch source is no longer a Wire: ' + id);
        result.push({ id, closed: Boolean(item.model?.IsClosed?.()) });
      }
      return result;
    }`, [ids]);
    await this.assertRevision(revision);
    const closureById = new Map(closure.map((item) => [item.id, item.closed]));
    const unresolved = ids.filter((id) => !closureById.has(id));
    if (unresolved.length > 0) throw new Error(`Closed-Wire patch sources changed while being inspected: ${unresolved.join(", ")}`);
    const open = ids.filter((id) => closureById.get(id) !== true);
    if (open.length > 0) throw new Error(`Surface patching requires closed Wire bodies: ${open.join(", ")}`);
    await this.runtime.mutate(`async function (Factory, Command, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const findWire = id => {
        for (const [versionId, item] of editor.geo.geometryModel) {
          if (editor.db.lookupStableId(versionId) !== id) continue;
          if (item.view?.constructor?.name !== 'Wire' || !item.model?.IsClosed?.()) {
            throw new Error('Surface patch source must remain a closed Wire: ' + id);
          }
          return item.view;
        }
        throw new Error('Surface patch source is missing: ' + id);
      };
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const curves = args.ids.map(findWire);
          const factory = new Factory(editor).resource(this);
          factory.curves = curves;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["PatchHoleInWireFactory", "PatchHoleInCurveCommand"], [{ ids }]);
    return await this.state();
  }

  async bridgeSurface(
    first: { bodyId: number; faceId: string; pickPointMm: Vector3 },
    second: { bodyId: number; faceId: string; pickPointMm: Vector3 },
    widthMm: number,
    softness: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (!Number.isFinite(widthMm) || widthMm <= 0) throw new Error("Surface Bridge width must be positive");
    if (!Number.isFinite(softness) || softness <= 0) throw new Error("Surface Bridge softness must be positive");
    if ([...first.pickPointMm, ...second.pickPointMm].some((value) => !Number.isFinite(value))) {
      throw new Error("Surface Bridge pick points must contain finite coordinates");
    }
    if (first.bodyId === second.bodyId) throw new Error("Surface Bridge requires faces from two different Sheet bodies");
    const references = [first, second];
    const invalid = references.filter((reference) => {
      const body = state.bodies.find((candidate) => candidate.id === reference.bodyId);
      return body?.type !== "Sheet" || !body.faceIds.includes(reference.faceId);
    });
    if (invalid.length > 0) {
      throw new Error(`Surface Bridge requires current Sheet faces; stale or unknown: ${invalid.map((reference) => `${reference.bodyId}:${reference.faceId}`).join(", ")}`);
    }
    await this.runtime.mutate(`async function (Factory, Vector, BlendShape, BlendTrim, args) {
      ${findView}
      ${commandStart("BridgeSurfaceCommand")}
      const face = ref => {
        const view = find(ref.bodyId);
        if (view.constructor.name !== 'Sheet') throw new Error('Surface Bridge inputs must be Sheet bodies');
        const index = view.high.faces.versionIds.indexOf(ref.faceId);
        if (index < 0) throw new Error('Stale or unknown Sheet face: ' + ref.faceId);
        return view.high.faces.get(index);
      };
      factory.shape = BlendShape.G2;
      factory.trimBlend = BlendTrim.Both;
      factory.trimWalls = true;
      factory.propagate = true;
      factory.width = args.width;
      factory.softness = args.softness;
      factory.push(face(args.faces[0]), false, new Vector(...args.pickPoints[0]));
      factory.push(face(args.faces[1]), false, new Vector(...args.pickPoints[1]));
      ${commandEnd}
    }`, ["BridgeSurfaceWithPreviewFactory", "Vector3", "BlendShape", "BlendTrim"], [{
      faces: references.map(({ bodyId, faceId }) => ({ bodyId, faceId })),
      pickPoints: references.map(({ pickPointMm }) => toMeters(pickPointMm)),
      width: millimetersToMeters(widthMm),
      softness,
    }]);
    return await this.state();
  }

  async joinSheets(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (ids.length < 2) throw new Error("At least two Sheet IDs are required");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Sheet IDs must be unique");
    const invalid = uniqueIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Sheet");
    if (invalid.length > 0) throw new Error(`Join requires current Sheet bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("JoinSheetsCommand")}
      factory.sheets = args.ids.map(id => {
        const sheet = find(id);
        if (sheet.constructor.name !== 'Sheet') throw new Error('Join inputs must be Sheet bodies');
        return sheet;
      });
      ${commandEnd}
    }`, ["JoinSheetsFactory"], [{ ids: uniqueIds }]);
    return await this.state();
  }

  async createConstrainedSurface(
    pointsMm: Vector3[],
    normals: Vector3[],
    options: {
      toleranceMm?: number;
      angularToleranceDegrees?: number;
      optimization?: "performance" | "smoothness";
    },
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (pointsMm.length < 4) throw new Error("Constrained surface requires at least four points");
    if (normals.length !== pointsMm.length) throw new Error("Constrained surface requires one normal per point");
    if (new Set(pointsMm.map((point) => point.join(","))).size < 4) {
      throw new Error("Constrained surface requires at least four distinct points");
    }
    const normalizedNormals = normals.map((normal) => {
      const length = Math.hypot(...normal);
      if (!Number.isFinite(length) || length === 0) throw new Error("Each constrained-surface normal must be nonzero");
      return normal.map((value) => value / length) as Vector3;
    });
    const toleranceMm = options.toleranceMm ?? 0.01;
    if (!Number.isFinite(toleranceMm) || toleranceMm <= 0) throw new Error("Constrained-surface tolerance must be positive");
    const angularToleranceDegrees = options.angularToleranceDegrees ?? 5;
    if (!Number.isFinite(angularToleranceDegrees) || angularToleranceDegrees <= 0 || angularToleranceDegrees > 90) {
      throw new Error("Constrained-surface angular tolerance must be greater than zero and at most 90 degrees");
    }
    const optimizationName = options.optimization === "smoothness" ? "Smoothness" : "Performance";
    await this.runtime.mutate(`async function (Factory, Vector, ConstrainedSurfaceOptimizationType, args) {
      ${commandStart("ConstrainedSurfaceCommand")}
      factory.points = args.points.map(point => new Vector(...point));
      factory.normals = args.normals.map(normal => new Vector(...normal));
      factory.tolerance = args.tolerance;
      factory.angularToleranceDegrees = args.angularToleranceDegrees;
      factory.optimize = ConstrainedSurfaceOptimizationType[args.optimizationName];
      ${commandEnd}
    }`, ["ConstrainedSurfaceFactory", "Vector3", "ConstrainedSurfaceOptimizationType"], [{
      points: pointsMm.map(toMeters),
      normals: normalizedNormals,
      tolerance: millimetersToMeters(toleranceMm),
      angularToleranceDegrees,
      optimizationName,
    }]);
    return await this.state();
  }

  async extractFaces(faces: Array<{ bodyId: number; faceId: string }>, revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (faces.length === 0) throw new Error("At least one face reference is required");
    const keys = faces.map((face) => `${face.bodyId}:${face.faceId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Face references must be unique");
    const invalid = faces.filter((reference) =>
      !state.bodies.find((body) => body.id === reference.bodyId)?.faceIds.includes(reference.faceId));
    if (invalid.length > 0) {
      throw new Error(`Stale or unknown faces: ${invalid.map((face) => `${face.bodyId}:${face.faceId}`).join(", ")}`);
    }
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("CreateSolidFromFacesCommand")}
      factory.faces = args.faces.map(ref => {
        const view = find(ref.bodyId);
        const index = view.high.faces.versionIds.indexOf(ref.faceId);
        if (index < 0) throw new Error('Stale or unknown face: ' + ref.faceId);
        return view.high.faces.get(index);
      });
      ${commandEnd}
    }`, ["CreateSheetFromFacesFactory"], [{ faces }]);
    return await this.state();
  }

  async unwrapFace(face: FaceReference, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, [face], "face");
    const descriptor = state.bodies.find((body) => body.id === face.bodyId)!.faces.find((candidate) => candidate.id === face.faceId)!;
    if (descriptor.surfaceType !== "Cylinder") {
      throw new Error(`Exact face unwrapping requires an analytic Cylinder face: ${face.bodyId}:${face.faceId}`);
    }
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const view = find(args.face.bodyId);
          const index = view.high.faces.versionIds.indexOf(args.face.faceId);
          if (index < 0) throw new Error('Stale or unknown face: ' + args.face.faceId);
          const selectedFaces = [view.high.faces.get(index)];
          const factory = new Factory(editor).resource(this);
          factory.faces = selectedFaces;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["UnwrapFactory"], [{ face }]);
    return await this.state();
  }

  async analyzeConeDevelopment(face: FaceReference, revision: string): Promise<{
    documentToken: string;
    revision: string;
    measurementSource: "native-brep";
    bodyId: number;
    faceId: string;
    boundaryRadiusMm: [number, number];
    development: ReturnType<typeof calculateConeDevelopment>;
  }> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, [face], "face");
    const body = state.bodies.find((candidate) => candidate.id === face.bodyId)!;
    if (body.type !== "Solid" && body.type !== "Sheet") {
      throw new Error(`Cone development requires a current Solid or Sheet body: ${face.bodyId}`);
    }
    const descriptor = body.faces.find((candidate) => candidate.id === face.faceId)!;
    if (descriptor.surfaceType !== "Cone") {
      throw new Error(`Cone development requires a current native Cone face: ${face.bodyId}:${face.faceId}`);
    }
    if (descriptor.axisOriginMm === null || descriptor.axisDirection === null || descriptor.coneBasisRadiusMm === undefined || descriptor.coneSemiAngleRad === undefined) {
      throw new Error(`Cone face is missing exact native basis parameters: ${face.bodyId}:${face.faceId}`);
    }

    const boundaryEdges = body.edges.filter((edge) => descriptor.edgeIds.includes(edge.id) && edge.faceIds.includes(face.faceId));
    const circularEdges = boundaryEdges.filter((edge) => edge.circle && edge.curveType === "Circle");
    const seamEdges = boundaryEdges.filter((edge) => edge.line && edge.curveType === "Line");
    if (boundaryEdges.length !== 3 || circularEdges.length !== 2 || seamEdges.length !== 1) {
      throw new Error("Cone development currently requires one complete frustum face bounded by two full circles and one straight seam");
    }

    const development = calculateConeDevelopment({
      basisRadiusMm: descriptor.coneBasisRadiusMm,
      semiAngleRad: descriptor.coneSemiAngleRad,
      axisOriginMm: descriptor.axisOriginMm,
      axisDirection: descriptor.axisDirection,
      circularBoundaries: circularEdges.map((edge) => ({ pointOnCircleMm: edge.centerMm, circumferenceMm: edge.lengthMm })),
    });
    const seamSlantLengthMm = seamEdges[0]!.lengthMm;
    if (Math.abs(seamSlantLengthMm - development.slantLengthMm) > 0.01) {
      throw new Error("Cone development seam length does not match the exact frustum slant length");
    }

    return {
      documentToken: state.documentToken,
      revision: state.revision,
      measurementSource: "native-brep",
      bodyId: face.bodyId,
      faceId: face.faceId,
      boundaryRadiusMm: circularEdges.map((edge) => edge.lengthMm / (2 * Math.PI)).sort((first, second) => first - second) as [number, number],
      development,
    };
  }

  async createConeDevelopment(face: FaceReference, originMm: Vector3, revision: string): Promise<{
    documentToken: string;
    revision: string;
    measurementSource: "native-brep";
    sourceFace: FaceReference;
    profileWireId: number;
    sheetBodyId: number;
    originMm: Vector3;
    boundaryRadiusMm: [number, number];
    development: ReturnType<typeof calculateConeDevelopment>;
    sourceAreaMm2: number;
    sheetAreaMm2: number;
    sheetBoundaryLengthsMm: number[];
    validation: BodyValidationDescriptor;
    historySteps: number;
  }> {
    if (originMm.some((value) => !Number.isFinite(value))) throw new Error("Cone development placement origin must be finite");
    const initial = await this.assertRevision(revision);
    const analysis = await this.analyzeConeDevelopment(face, revision);
    const descriptor = initial.bodies.find((body) => body.id === face.bodyId)!.faces.find((candidate) => candidate.id === face.faceId)!;
    const plan = planConeDevelopmentCurves(originMm, analysis.development);
    const sourceProperties = await this.measureFaceProperties([face], revision);
    const sourceAreaMm2 = sourceProperties.faces[0]!.areaMm2;
    const expectedAreaMm2 = Math.PI * (analysis.boundaryRadiusMm[0] + analysis.boundaryRadiusMm[1]) * analysis.development.slantLengthMm;
    if (Math.abs(sourceAreaMm2 - expectedAreaMm2) > Math.max(0.01, expectedAreaMm2 * 1e-6)) {
      throw new Error("Native cone face area does not match the full-frustum lateral area; no development geometry was created");
    }

    const originalBodies = new Map(initial.bodies.map((body) => [body.id, JSON.stringify(body)]));
    let state = initial;
    const createdWireIds: number[] = [];
    const assertOriginalBodiesUnchanged = (next: RuntimeState): void => {
      if (next.documentToken !== initial.documentToken) throw new Error("Plasticity document changed during cone development; inspect the partial result before continuing");
      for (const [id, snapshot] of originalBodies) {
        const current = next.bodies.find((body) => body.id === id);
        if (!current || JSON.stringify(current) !== snapshot) {
          throw new Error(`An original CAD body changed during cone development: ${id}; inspect the partial result before continuing`);
        }
      }
    };
    const createCurve = async (operation: Promise<RuntimeState>): Promise<number> => {
      const before = state;
      const next = await operation;
      assertOriginalBodiesUnchanged(next);
      if (next.undoDepth !== before.undoDepth + 1) {
        throw new Error("Cone development curve did not create exactly one history step; inspect the partial result before continuing");
      }
      const beforeIds = new Set(before.bodies.map((body) => body.id));
      const additions = next.bodies.filter((body) => !beforeIds.has(body.id));
      if (additions.length !== 1 || additions[0]!.type !== "Wire") {
        throw new Error("Cone development expected one new native Wire per curve; inspect the partial result before continuing");
      }
      if (createdWireIds.some((id) => !next.bodies.some((body) => body.id === id))) {
        throw new Error("A previously created cone development curve disappeared; inspect the partial result before continuing");
      }
      createdWireIds.push(additions[0]!.id);
      state = next;
      return additions[0]!.id;
    };

    for (const arc of plan.arcs) {
      await createCurve(this.createCenterArc(arc.centerMm, arc.radiusMm, arc.startAngleDegrees, arc.sweepAngleDegrees, state.revision, plan.normal, plan.xDirection));
    }
    for (const [start, end] of plan.radialSegments) {
      await createCurve(this.createPolyline([start, end], false, state.revision));
    }

    const beforeJoin = state;
    const joined = await this.joinCurves(createdWireIds, beforeJoin.revision);
    assertOriginalBodiesUnchanged(joined);
    if (joined.undoDepth !== beforeJoin.undoDepth + 1) throw new Error("Cone development join did not create exactly one history step; inspect the partial result before continuing");
    const joinedWires = joined.bodies.filter((body) => !originalBodies.has(body.id));
    if (joinedWires.length !== 1 || joinedWires[0]!.type !== "Wire") {
      throw new Error("Native curve join did not produce exactly one development Wire; inspect the partial result before continuing");
    }
    const profileWireId = joinedWires[0]!.id;
    state = joined;

    const beforePatch = state;
    const patched = await this.patchClosedWires([profileWireId], beforePatch.revision);
    assertOriginalBodiesUnchanged(patched);
    if (patched.undoDepth !== beforePatch.undoDepth + 1) throw new Error("Cone development patch did not create exactly one history step; inspect the partial result before continuing");
    const developmentBodies = patched.bodies.filter((body) => !originalBodies.has(body.id));
    const retainedWire = developmentBodies.find((body) => body.id === profileWireId && body.type === "Wire");
    const sheet = developmentBodies.filter((body) => body.type === "Sheet");
    if (!retainedWire || sheet.length !== 1) throw new Error("Native Wire patch did not preserve one profile and create exactly one Sheet; inspect the partial result before continuing");
    const sheetBody = sheet[0]!;
    if (sheetBody.faces.length !== 1 || !sheetBody.faces[0]!.planar || sheetBody.faces[0]!.edgeIds.length !== 4) {
      throw new Error("Cone development Sheet is not one planar four-edge face; inspect the partial result before continuing");
    }
    const sheetEdges = sheetBody.edges.filter((edge) => sheetBody.faces[0]!.edgeIds.includes(edge.id));
    const circularLengths = sheetEdges.filter((edge) => edge.circle).map((edge) => edge.lengthMm).sort((first, second) => first - second);
    const lineLengths = sheetEdges.filter((edge) => edge.line).map((edge) => edge.lengthMm).sort((first, second) => first - second);
    const expectedCircularLengths = [
      analysis.development.innerRadiusMm * analysis.development.includedAngleRad,
      analysis.development.outerRadiusMm * analysis.development.includedAngleRad,
    ].sort((first, second) => first - second);
    if (sheetEdges.length !== 4 || circularLengths.length !== 2 || lineLengths.length !== 2 ||
        circularLengths.some((length, index) => Math.abs(length - expectedCircularLengths[index]!) > 0.01) ||
        lineLengths.some((length) => Math.abs(length - analysis.development.slantLengthMm) > 0.01)) {
      throw new Error("Cone development Sheet boundaries do not match the exact annular-sector profile; inspect the partial result before continuing");
    }

    const validation = await this.validateBodies([sheetBody.id], patched.revision);
    if (!validation.bodies[0]!.nativeValid) throw new Error("Cone development Sheet failed Plasticity native validation; inspect the result before continuing");
    const sheetProperties = await this.measureFaceProperties([{ bodyId: sheetBody.id, faceId: sheetBody.faces[0]!.id }], patched.revision);
    const sheetAreaMm2 = sheetProperties.faces[0]!.areaMm2;
    if (Math.abs(sheetAreaMm2 - expectedAreaMm2) > Math.max(0.01, expectedAreaMm2 * 1e-6)) {
      throw new Error("Developed Sheet area does not match the source conical face; inspect the result before continuing");
    }
    const finalState = await this.assertRevision(patched.revision);
    assertOriginalBodiesUnchanged(finalState);
    if (JSON.stringify(finalState.bodies.find((body) => body.id === sheetBody.id)) !== JSON.stringify(sheetBody)) {
      throw new Error("Development Sheet changed during validation; inspect the result before continuing");
    }

    return {
      documentToken: finalState.documentToken,
      revision: finalState.revision,
      measurementSource: "native-brep",
      sourceFace: face,
      profileWireId,
      sheetBodyId: sheetBody.id,
      originMm,
      boundaryRadiusMm: analysis.boundaryRadiusMm,
      development: analysis.development,
      sourceAreaMm2,
      sheetAreaMm2,
      sheetBoundaryLengthsMm: sheetEdges.map((edge) => edge.lengthMm).sort((first, second) => first - second),
      validation: validation.bodies[0]!,
      historySteps: finalState.undoDepth - initial.undoDepth,
    };
  }

  async deformBodiesBetweenFaces(
    ids: number[],
    sourceFace: FaceReference,
    targetFace: FaceReference,
    options: {
      scaleU: number;
      scaleV: number;
      scaleNormal: number;
      flipUV: boolean;
      flipNormal: boolean;
      mirror: boolean;
    },
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0 || new Set(ids).size !== ids.length) {
      throw new Error("Deformation body IDs must be a nonempty unique list");
    }
    const current = new Map(state.bodies.map((body) => [body.id, body]));
    const missing = ids.filter((id) => !current.has(id));
    if (missing.length > 0) throw new Error(`Unknown current deformation body IDs: ${missing.join(", ")}`);
    const invalid = ids.filter((id) => !["Solid", "Sheet"].includes(current.get(id)!.type));
    if (invalid.length > 0) throw new Error(`Face deformation requires current Solid or Sheet bodies: ${invalid.join(", ")}`);
    if (sourceFace.bodyId === targetFace.bodyId && sourceFace.faceId === targetFace.faceId) {
      throw new Error("Source and target deformation faces must be different");
    }
    requireTopologySelection(state, [sourceFace, targetFace], "face");
    const referenceBodyIds = new Set([sourceFace.bodyId, targetFace.bodyId]);
    const overlapping = ids.filter((id) => referenceBodyIds.has(id));
    if (overlapping.length > 0) {
      throw new Error(`Deformation bodies must be separate from source and target face bodies: ${overlapping.join(", ")}`);
    }
    for (const [name, value] of Object.entries({
      scaleU: options.scaleU,
      scaleV: options.scaleV,
      scaleNormal: options.scaleNormal,
    })) {
      if (!Number.isFinite(value) || value <= 0 || value > 1000) {
        throw new Error(`${name} must be positive and at most 1000`);
      }
    }
    await this.runtime.mutate(`async function (Factory, Command, args) {
      ${findView}
      const findFace = ref => {
        const view = find(ref.bodyId);
        const index = view.high.faces.versionIds.indexOf(ref.faceId);
        if (index < 0) throw new Error('Stale or unknown face: ' + ref.faceId);
        return view.high.faces.get(index);
      };
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.faces = args.ids.flatMap(id => {
            const view = find(id);
            if (view.constructor.name !== 'Solid' && view.constructor.name !== 'Sheet') {
              throw new Error('Face deformation inputs must remain Solid or Sheet bodies');
            }
            return Array.from({ length: view.high.faces.length }, (_, index) => view.high.faces.get(index));
          });
          factory.sourceFace = findFace(args.sourceFace);
          factory.targetFace = findFace(args.targetFace);
          factory.keepTools = true;
          factory.scaleU = args.options.scaleU;
          factory.scaleV = args.options.scaleV;
          factory.scaleNormal = args.options.scaleNormal;
          factory.flipUV = args.options.flipUV;
          factory.flipNormal = args.options.flipNormal;
          factory.mirror = args.options.mirror;
          factory.offsetU = 0;
          factory.offsetV = 0;
          factory.offsetNormal = 0;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["DeformFaceFactory", "DeformFaceCommand"], [{ ids, sourceFace, targetFace, options }]);
    return await this.state();
  }

  async deformCurvesBetweenFaces(
    ids: number[],
    sourceFace: FaceReference,
    targetFace: FaceReference,
    options: {
      scaleU: number;
      scaleV: number;
      scaleNormal: number;
      flipUV: boolean;
      flipNormal: boolean;
      mirror: boolean;
    },
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0 || new Set(ids).size !== ids.length) {
      throw new Error("Deformation curve IDs must be a nonempty unique list");
    }
    const current = new Map(state.bodies.map((body) => [body.id, body]));
    const missing = ids.filter((id) => !current.has(id));
    if (missing.length > 0) throw new Error(`Unknown current deformation curve IDs: ${missing.join(", ")}`);
    const invalid = ids.filter((id) => current.get(id)!.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Curve deformation requires current Wire bodies: ${invalid.join(", ")}`);
    if (sourceFace.bodyId === targetFace.bodyId && sourceFace.faceId === targetFace.faceId) {
      throw new Error("Source and target deformation faces must be different");
    }
    requireTopologySelection(state, [sourceFace, targetFace], "face");
    const referenceBodyIds = new Set([sourceFace.bodyId, targetFace.bodyId]);
    const overlapping = ids.filter((id) => referenceBodyIds.has(id));
    if (overlapping.length > 0) {
      throw new Error(`Deformation curves must be separate from source and target face bodies: ${overlapping.join(", ")}`);
    }
    for (const [name, value] of Object.entries({
      scaleU: options.scaleU,
      scaleV: options.scaleV,
      scaleNormal: options.scaleNormal,
    })) {
      if (!Number.isFinite(value) || value <= 0 || value > 1000) {
        throw new Error(`${name} must be positive and at most 1000`);
      }
    }
    await this.runtime.mutate(`async function (Factory, Command, args) {
      ${findView}
      const findFace = ref => {
        const view = find(ref.bodyId);
        const index = view.high.faces.versionIds.indexOf(ref.faceId);
        if (index < 0) throw new Error('Stale or unknown face: ' + ref.faceId);
        return view.high.faces.get(index);
      };
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.curves = args.ids.map(id => {
            const view = find(id);
            if (view.constructor.name !== 'Wire') throw new Error('Curve deformation inputs must remain Wire bodies');
            return view;
          });
          factory.sourceFace = findFace(args.sourceFace);
          factory.targetFace = findFace(args.targetFace);
          factory.keepTools = true;
          factory.scaleU = args.options.scaleU;
          factory.scaleV = args.options.scaleV;
          factory.scaleNormal = args.options.scaleNormal;
          factory.flipUV = args.options.flipUV;
          factory.flipNormal = args.options.flipNormal;
          factory.mirror = args.options.mirror;
          factory.offsetU = 0;
          factory.offsetV = 0;
          factory.offsetNormal = 0;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["DeformCurveFactory", "DeformCurveCommand"], [{ ids, sourceFace, targetFace, options }]);
    return await this.state();
  }

  async extractEdges(edges: Array<{ bodyId: number; edgeId: string }>, revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (edges.length === 0) throw new Error("At least one edge reference is required");
    const keys = edges.map((edge) => `${edge.bodyId}:${edge.edgeId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Edge references must be unique");
    const invalid = edges.filter((reference) =>
      !state.bodies.find((body) => body.id === reference.bodyId)?.edgeIds.includes(reference.edgeId));
    if (invalid.length > 0) {
      throw new Error(`Stale or unknown edges: ${invalid.map((edge) => `${edge.bodyId}:${edge.edgeId}`).join(", ")}`);
    }
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("DuplicateEdgeAndProjectCommand")}
      factory.edges = args.edges.map(ref => {
        const view = find(ref.bodyId);
        const index = view.high.edges.versionIds.indexOf(ref.edgeId);
        if (index < 0) throw new Error('Stale or unknown edge: ' + ref.edgeId);
        return view.high.edges.get(index);
      });
      ${commandEnd}
    }`, ["CreateCurveFromEdgesFactory"], [{ edges }]);
    return await this.state();
  }

  async unjoinFaces(faces: Array<{ bodyId: number; faceId: string }>, revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (faces.length === 0) throw new Error("At least one face reference is required");
    const keys = faces.map((face) => `${face.bodyId}:${face.faceId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Face references must be unique");
    const invalid = faces.filter((reference) =>
      !state.bodies.find((body) => body.id === reference.bodyId)?.faceIds.includes(reference.faceId));
    if (invalid.length > 0) {
      throw new Error(`Stale or unknown faces: ${invalid.map((face) => `${face.bodyId}:${face.faceId}`).join(", ")}`);
    }
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("UnjoinFacesCommand")}
      factory.faces = args.faces.map(ref => {
        const view = find(ref.bodyId);
        const index = view.high.faces.versionIds.indexOf(ref.faceId);
        if (index < 0) throw new Error('Stale or unknown face: ' + ref.faceId);
        return view.high.faces.get(index);
      });
      ${commandEnd}
    }`, ["UnjoinFacesFactory"], [{ faces }]);
    return await this.state();
  }

  async insertSheet(targetSheetId: number, edgeIds: string[], fillSheetId: number, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (targetSheetId === fillSheetId) throw new Error("Sheet insertion requires two different Sheet bodies");
    const target = state.bodies.find((body) => body.id === targetSheetId);
    const fill = state.bodies.find((body) => body.id === fillSheetId);
    if (target?.type !== "Sheet") throw new Error(`Sheet insertion requires a current target Sheet body: ${targetSheetId}`);
    if (fill?.type !== "Sheet") throw new Error(`Sheet insertion requires a current fill Sheet body: ${fillSheetId}`);
    if (edgeIds.length === 0) throw new Error("Sheet insertion requires at least one target boundary edge");
    const uniqueIds = [...new Set(edgeIds)];
    if (uniqueIds.length !== edgeIds.length) throw new Error("Sheet insertion edge IDs must be unique");
    const selected = uniqueIds.map((edgeId) => target.edges.find((edge) => edge.id === edgeId));
    const missing = uniqueIds.filter((_edgeId, index) => !selected[index]);
    if (missing.length > 0) throw new Error(`Stale or unknown target Sheet edges: ${missing.join(", ")}`);
    const nonBoundary = selected.filter((edge) => edge!.faceIds.length !== 1).map((edge) => edge!.id);
    if (nonBoundary.length > 0) throw new Error(`Sheet insertion requires target boundary edges: ${nonBoundary.join(", ")}`);
    await this.runtime.mutate(`async function (Factory, Command, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          const target = find(args.targetSheetId);
          const fill = find(args.fillSheetId);
          if (target.constructor.name !== 'Sheet' || fill.constructor.name !== 'Sheet') {
            throw new Error('Sheet insertion inputs must remain Sheet bodies');
          }
          factory.sheet = target;
          factory.edges = args.edgeIds.map(id => {
            const index = target.high.edges.versionIds.indexOf(id);
            if (index < 0) throw new Error('Stale or unknown target Sheet edge: ' + id);
            return target.high.edges.get(index);
          });
          factory.fillSheet = fill;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["InsertSheetFactory", "InsertSheetCommand"], [{ targetSheetId, edgeIds: uniqueIds, fillSheetId }]);
    return await this.state();
  }

  async unjoinShells(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0 || new Set(ids).size !== ids.length) {
      throw new Error("Shell body IDs must be a nonempty unique list");
    }
    const current = new Map(state.bodies.map((body) => [body.id, body]));
    const missing = ids.filter((id) => !current.has(id));
    if (missing.length > 0) throw new Error(`Unknown current body IDs: ${missing.join(", ")}`);
    const invalid = ids.filter((id) => !["Solid", "Sheet"].includes(current.get(id)!.type));
    if (invalid.length > 0) throw new Error(`Shell unjoin requires current Solid or Sheet bodies: ${invalid.join(", ")}`);
    const singleFace = ids.filter((id) => current.get(id)!.faceIds.length < 2);
    if (singleFace.length > 0) throw new Error(`Shell unjoin requires bodies with at least two faces: ${singleFace.join(", ")}`);
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("UnjoinShellsCommand")}
      factory.shells = args.ids.map(find);
      ${commandEnd}
    }`, ["UnjoinShellsFactory"], [{ ids }]);
    return await this.state();
  }

  async createSolidFromSheet(id: number, revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (state.bodies.find((body) => body.id === id)?.type !== "Sheet") {
      throw new Error(`Solid creation requires a current Sheet body: ${id}`);
    }
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("CreateSolidFromFacesCommand")}
      const view = find(args.id);
      if (view.constructor.name !== 'Sheet') throw new Error('Solid creation input must be a Sheet body');
      factory.shell = view;
      factory.faces = Array.from({ length: view.high.faces.length }, (_, index) => view.high.faces.get(index));
      ${commandEnd}
    }`, ["CreateSolidFromFacesFactory"], [{ id }]);
    return await this.state();
  }

  async deleteFaces(faces: Array<{ bodyId: number; faceId: string }>, revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (faces.length === 0) throw new Error("At least one face reference is required");
    const keys = faces.map((face) => `${face.bodyId}:${face.faceId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Face references must be unique");
    const invalid = faces.filter((reference) =>
      !state.bodies.find((body) => body.id === reference.bodyId)?.faceIds.includes(reference.faceId));
    if (invalid.length > 0) {
      throw new Error(`Stale or unknown faces: ${invalid.map((face) => `${face.bodyId}:${face.faceId}`).join(", ")}`);
    }
    await this.runtime.mutate(`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.faces = args.faces.map(ref => {
            const view = find(ref.bodyId);
            const index = view.high.faces.versionIds.indexOf(ref.faceId);
            if (index < 0) throw new Error('Stale or unknown face: ' + ref.faceId);
            return view.high.faces.get(index);
          });
          return await factory.commit();
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["DeleteFaceCommand", "DeleteFaceFactory"], [{ faces }]);
    return await this.state();
  }

  async dissolveFaces(faces: Array<{ bodyId: number; faceId: string }>, revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (faces.length === 0) throw new Error("At least one face reference is required");
    const keys = faces.map((face) => `${face.bodyId}:${face.faceId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Face references must be unique");
    const invalid = faces.filter((reference) =>
      !state.bodies.find((body) => body.id === reference.bodyId)?.faceIds.includes(reference.faceId));
    if (invalid.length > 0) {
      throw new Error(`Stale or unknown faces: ${invalid.map((face) => `${face.bodyId}:${face.faceId}`).join(", ")}`);
    }
    await this.runtime.mutate(`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.faces = args.faces.map(ref => {
            const view = find(ref.bodyId);
            const index = view.high.faces.versionIds.indexOf(ref.faceId);
            if (index < 0) throw new Error('Stale or unknown face: ' + ref.faceId);
            return view.high.faces.get(index);
          });
          return await factory.commit();
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["DissolveFaceCommand", "DissolveFaceFactory"], [{ faces }]);
    return await this.state();
  }

  async patchSheetHole(id: number, edgeIds: string[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    const sheet = state.bodies.find((body) => body.id === id);
    if (sheet?.type !== "Sheet") throw new Error(`Hole patch requires a current Sheet body: ${id}`);
    if (edgeIds.length < 3) throw new Error("Sheet-hole patch requires at least three boundary edges");
    const uniqueIds = [...new Set(edgeIds)];
    if (uniqueIds.length !== edgeIds.length) throw new Error("Sheet-hole edge IDs must be unique");
    const selected = uniqueIds.map((edgeId) => sheet.edges.find((edge) => edge.id === edgeId));
    const missing = uniqueIds.filter((_edgeId, index) => !selected[index]);
    if (missing.length > 0) throw new Error(`Stale or unknown Sheet edges: ${missing.join(", ")}`);
    const nonBoundary = selected.filter((edge) => edge!.faceIds.length !== 1).map((edge) => edge!.id);
    if (nonBoundary.length > 0) throw new Error(`Hole patch requires boundary edges: ${nonBoundary.join(", ")}`);
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("PatchCommand")}
      const view = find(args.id);
      if (view.constructor.name !== 'Sheet') throw new Error('Hole patch input must be a Sheet body');
      factory.sheet = view;
      factory.edges = args.edgeIds.map(id => {
        const index = view.high.edges.versionIds.indexOf(id);
        if (index < 0) throw new Error('Stale or unknown Sheet edge: ' + id);
        return view.high.edges.get(index);
      });
      ${commandEnd}
    }`, ["PatchHoleInSheetFactory"], [{ id, edgeIds: uniqueIds }]);
    return await this.state();
  }

  async capSheetHoles(ids: number[], revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (ids.length === 0) throw new Error("At least one Sheet ID is required");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Sheet IDs must be unique");
    const invalid = uniqueIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Sheet");
    if (invalid.length > 0) throw new Error(`Hole capping requires current Sheet bodies: ${invalid.join(", ")}`);
    await this.runtime.mutate(`async function (Command, Factory, args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.sheets = args.ids.map(find);
          return await factory.commit();
        } catch (error) {
          failure = error;
          throw error;
        }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["PatchHolesInSheetCommand", "CapHolesInSheetFactory"], [{ ids: uniqueIds }]);
    return await this.state();
  }

  async extendSheetEdges(id: number, edgeIds: string[], distanceMm: number, revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    const sheet = state.bodies.find((body) => body.id === id);
    if (sheet?.type !== "Sheet") throw new Error(`Sheet extension requires a current Sheet body: ${id}`);
    if (edgeIds.length === 0) throw new Error("Sheet extension requires at least one boundary edge");
    const uniqueIds = [...new Set(edgeIds)];
    if (uniqueIds.length !== edgeIds.length) throw new Error("Sheet extension edge IDs must be unique");
    if (!Number.isFinite(distanceMm) || distanceMm <= 0) throw new Error("Sheet extension distance must be positive");
    const selected = uniqueIds.map((edgeId) => sheet.edges.find((edge) => edge.id === edgeId));
    const missing = uniqueIds.filter((_edgeId, index) => !selected[index]);
    if (missing.length > 0) throw new Error(`Stale or unknown Sheet edges: ${missing.join(", ")}`);
    const nonBoundary = selected.filter((edge) => edge!.faceIds.length !== 1).map((edge) => edge!.id);
    if (nonBoundary.length > 0) throw new Error(`Sheet extension requires boundary edges: ${nonBoundary.join(", ")}`);
    await this.runtime.mutate(`async function (Factory, ExtensionShape, BodyExtensionType, ExtensionLimit, args) {
      ${findView}
      ${commandStart("ExtendSheetCommand")}
      const view = find(args.id);
      if (view.constructor.name !== 'Sheet') throw new Error('Sheet extension input must be a Sheet body');
      factory.edges = args.edgeIds.map(id => {
        const index = view.high.edges.versionIds.indexOf(id);
        if (index < 0) throw new Error('Stale or unknown Sheet edge: ' + id);
        return view.high.edges.get(index);
      });
      factory.distance = args.distance;
      factory.shape = ExtensionShape.Linear;
      factory.type = BodyExtensionType.Distance;
      factory.limit = ExtensionLimit.Minimal;
      factory.modify = true;
      ${commandEnd}
    }`, ["ExtendSheetFactory", "ExtensionShape", "BodyExtensionType", "ExtensionLimit"], [{
      id,
      edgeIds: uniqueIds,
      distance: millimetersToMeters(distanceMm),
    }]);
    return await this.state();
  }

  async validateBodies(ids: number[], revision: string): Promise<{
    documentToken: string;
    revision: string;
    measurementSource: "native-brep";
    bodies: BodyValidationDescriptor[];
  }> {
    const before = await this.state();
    if (before.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${before.revision}`);
    }
    if (ids.length === 0) throw new Error("At least one body ID is required");
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("Body IDs must be unique");
    const bodies = uniqueIds.map((id) => before.bodies.find((body) => body.id === id));
    const missing = uniqueIds.filter((_id, index) => !bodies[index]);
    if (missing.length > 0) throw new Error(`Unknown body IDs: ${missing.join(", ")}`);

    const nativeChecks = await this.runtime.readNative<Array<{ id: number; nativeCheckCodes: number[] }>>(`function (args) {
      const wanted = new Set(args.ids);
      const result = [];
      for (const [versionId, item] of this.geo.geometryModel) {
        const id = this.db.lookupStableId(versionId);
        if (!wanted.has(id)) continue;
        const model = item.model;
        if (!model || typeof model.Check !== 'function') throw new Error('Native Check is unavailable for body ID: ' + id);
        result.push({ id, nativeCheckCodes: Array.from(model.Check(), Number) });
      }
      return result;
    }`, [], [{ ids: uniqueIds }]);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while bodies were being validated");
    }
    const checksById = new Map(nativeChecks.map((entry) => [entry.id, entry.nativeCheckCodes]));
    const unread = uniqueIds.filter((id) => !checksById.has(id));
    if (unread.length > 0) throw new Error(`Native validation did not return body IDs: ${unread.join(", ")}`);

    return {
      documentToken: after.documentToken,
      revision: after.revision,
      measurementSource: "native-brep",
      bodies: bodies.map((body) => {
        const current = body!;
        const nativeCheckCodes = checksById.get(current.id)!;
        const nativeValid = nativeCheckCodes.length === 0;
        // A periodic Solid face may expose its seam edge once through GetFaces(),
        // although the Parasolid body is closed. Trust the native Solid type plus
        // Check() for closure; retain the adjacency heuristic for open Sheets.
        const boundaryEdgeIds = current.type === "Solid"
          ? []
          : current.edges.filter((edge) => edge.faceIds.length === 1).map((edge) => edge.id);
        const closed = current.type === "Solid" ? nativeValid : current.type !== "Wire" && boundaryEdgeIds.length === 0;
        return {
          id: current.id,
          versionId: current.versionId,
          type: current.type,
          name: current.name,
          measurementSource: "native-brep",
          faceCount: current.faces.length,
          edgeCount: current.edges.length,
          boundaryEdgeIds,
          closed,
          nativeCheckCodes,
          nativeValid,
          printableSolid: current.type === "Solid" && closed && nativeValid,
        };
      }),
    };
  }

  async createPipes(spineIds: number[], diameterMm: number, wallThicknessMm: number, revision: string): Promise<RuntimeState> {
    const state = await this.state();
    if (state.revision !== revision) {
      throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
    }
    if (spineIds.length === 0) throw new Error("At least one Wire spine ID is required");
    const uniqueIds = [...new Set(spineIds)];
    if (uniqueIds.length !== spineIds.length) throw new Error("Wire spine IDs must be unique");
    if (!Number.isFinite(diameterMm) || diameterMm <= 0) throw new Error("Pipe diameter must be positive");
    if (!Number.isFinite(wallThicknessMm) || wallThicknessMm < 0) throw new Error("Pipe wall thickness must be nonnegative");
    const invalid = uniqueIds.filter((id) => state.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalid.length > 0) throw new Error(`Pipe requires current Wire spines: ${invalid.join(", ")}`);
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("PipeCommand")}
      const spines = args.spineIds.map(id => {
        const spine = find(id);
        if (spine.constructor.name !== 'Wire') throw new Error('Pipe inputs must be Wire bodies');
        return spine;
      });
      factory.spines = spines;
      factory.diameter = args.diameter;
      factory.thickness = args.thickness;
      ${commandEnd}
    }`, ["PipeFactory"], [{
      spineIds: uniqueIds,
      diameter: millimetersToMeters(diameterMm),
      thickness: millimetersToMeters(wallThicknessMm),
    }]);
    return await this.state();
  }

  async revolveProfile(
    id: number,
    axisOriginMm: Vector3,
    axis: Vector3,
    angleDegrees: number,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("RevolveCommand")}
      const view = find(args.id);
      if (view.constructor.name !== 'Wire') throw new Error('Profile must be a Wire');
      factory.curves = [view];
      factory.origin.fromArray(args.axisOrigin);
      factory.axis.fromArray(args.axis).normalize();
      factory.degrees = args.angleDegrees;
      ${commandEnd}
    }`, ["RevolveFactory"], [{
      id,
      axisOrigin: toMeters(axisOriginMm),
      axis,
      angleDegrees,
    }]);
    return await this.state();
  }

  async thickenSheets(
    ids: number[],
    frontMm: number,
    backMm: number,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("ThickenSheetCommand")}
      const sheets = args.ids.map(find);
      for (const view of sheets) {
        if (view.constructor.name !== 'Sheet') throw new Error('Thicken inputs must be Sheets');
      }
      factory.sheets = sheets;
      factory.front = args.front;
      factory.back = args.back;
      ${commandEnd}
    }`, ["ThickenSheetFactory"], [{
      ids,
      front: millimetersToMeters(frontMm),
      back: millimetersToMeters(backMm),
    }]);
    return await this.state();
  }

  async draftFaces(
    id: number,
    faceIds: string[],
    referenceFace: { bodyId: number; faceId: string },
    angleDegrees: number,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (referenceFace.bodyId === id && faceIds.includes(referenceFace.faceId)) {
      throw new Error("Draft faces must not include the neutral reference face");
    }
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("DraftFaceCommand")}
      const view = find(args.id);
      const faces = view.high.faces;
      factory.faces = args.faceIds.map(id => {
        const index = faces.versionIds.indexOf(id);
        if (index < 0) throw new Error('Stale or unknown draft face: ' + id);
        return faces.get(index);
      });
      const referenceView = find(args.referenceFace.bodyId);
      const referenceFaces = referenceView.high.faces;
      const referenceIndex = referenceFaces.versionIds.indexOf(args.referenceFace.faceId);
      if (referenceIndex < 0) throw new Error('Stale or unknown neutral reference face: ' + args.referenceFace.faceId);
      factory.reference = referenceFaces.get(referenceIndex);
      factory.degrees = args.angleDegrees;
      ${commandEnd}
    }`, ["DraftFaceFactory"], [{ id, faceIds, referenceFace, angleDegrees }]);
    return await this.state();
  }

  async offsetFaces(id: number, faceIds: string[], distanceMm: number, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("OffsetFaceCommand")}
      const view = find(args.id);
      const faces = view.high.faces;
      factory.faces = args.faceIds.map(id => {
        const index = faces.versionIds.indexOf(id);
        if (index < 0) throw new Error('Stale or unknown face: ' + id);
        return faces.get(index);
      });
      factory.distance = args.distance;
      ${commandEnd}
    }`, ["OffsetFaceFactory"], [{ id, faceIds, distance: millimetersToMeters(distanceMm) }]);
    return await this.state();
  }

  async moveFaces(references: FaceReference[], deltaMm: Vector3, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "face");
    if (deltaMm.some((value) => !Number.isFinite(value)) || Math.hypot(...deltaMm) === 0) {
      throw new Error("Face move delta must be a finite nonzero vector");
    }
    await this.runtime.mutate(`async function (Factory, args) {
      ${findFaceViews}
      ${commandStart("MoveFaceCommand")}
      factory.faces = selectedFaces;
      factory.move.fromArray(args.delta);
      ${commandEnd}
    }`, ["MultiMoveFaceFactory"], [{ faces: references, delta: toMeters(deltaMm) }]);
    return await this.state();
  }

  async rotateFaces(
    references: FaceReference[],
    pivotMm: Vector3,
    axis: Vector3,
    degrees: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "face");
    if (pivotMm.some((value) => !Number.isFinite(value))) throw new Error("Face rotation pivot must be finite");
    if (!Number.isFinite(degrees) || degrees === 0) throw new Error("Face rotation angle must be finite and nonzero");
    const unitAxis = normalize(axis, "Face rotation axis");
    await this.runtime.mutate(`async function (Factory, Vector, Quaternion, args) {
      ${findFaceViews}
      ${commandStart("RotateFaceCommand")}
      factory.faces = selectedFaces;
      factory.pivot.fromArray(args.pivot);
      factory.rotation.copy(new Quaternion().setFromAxisAngle(new Vector(...args.axis), args.radians));
      ${commandEnd}
    }`, ["MultiRotateFaceFactory", "Vector3", "Quaternion"], [{
      faces: references,
      pivot: toMeters(pivotMm),
      axis: unitAxis,
      radians: degreesToRadians(degrees),
    }]);
    return await this.state();
  }

  async scaleFaces(
    references: FaceReference[],
    pivotMm: Vector3,
    factors: Vector3,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "face");
    if (pivotMm.some((value) => !Number.isFinite(value))) throw new Error("Face scale pivot must be finite");
    if (factors.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error("Face scale factors must be finite and positive");
    }
    if (factors.every((value) => value === 1)) throw new Error("Face scale must change at least one factor");
    await this.runtime.mutate(`async function (Factory, args) {
      ${findFaceViews}
      ${commandStart("ScaleFaceCommand")}
      factory.faces = selectedFaces;
      factory.pivot.fromArray(args.pivot);
      factory.scale.fromArray(args.factors);
      ${commandEnd}
    }`, ["MultiPlanarizingBasicScaleFaceFactory"], [{ faces: references, pivot: toMeters(pivotMm), factors }]);
    return await this.state();
  }

  async thickenFaces(
    references: FaceReference[],
    frontMm: number,
    backMm: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "face");
    requireSingleTopologyBody(references, "Thickened faces");
    const body = state.bodies.find((candidate) => candidate.id === references[0]!.bodyId)!;
    if (body.type !== "Solid" && body.type !== "Sheet") throw new Error("Native face thickening requires a Solid or Sheet body");
    if (!Number.isFinite(frontMm) || frontMm < 0 || !Number.isFinite(backMm) || backMm < 0) {
      throw new Error("Face-thickening front and back distances must be finite and nonnegative");
    }
    if (frontMm === 0 && backMm === 0) throw new Error("Face thickening requires a positive front or back distance");
    await this.runtime.mutate(`async function (Factory, Command, args) {
      ${findFaceViews}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.faces = selectedFaces;
          factory.front = args.front;
          factory.back = args.back;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["ThickenFaceFactory", "ThickenFaceCommand"], [{
      faces: references,
      front: millimetersToMeters(frontMm),
      back: millimetersToMeters(backMm),
    }]);
    return await this.state();
  }

  async offsetFaceLoops(
    references: FaceReference[],
    distanceMm: number,
    individual: boolean,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "face");
    requireSingleTopologyBody(references, "Offset face loops");
    const body = state.bodies.find((candidate) => candidate.id === references[0]!.bodyId)!;
    if (body.type !== "Solid" && body.type !== "Sheet") throw new Error("Native face-loop offset requires a Solid or Sheet body");
    if (!Number.isFinite(distanceMm) || distanceMm === 0) throw new Error("Face-loop offset distance must be finite and nonzero");
    await this.runtime.mutate(`async function (Factory, Command, args) {
      ${findFaceViews}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.faces = selectedFaces;
          factory.distance = args.distance;
          factory.isIndividual = args.individual;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["OffsetFaceLoopFactory", "OffsetFaceLoopCommand"], [{
      faces: references,
      distance: millimetersToMeters(distanceMm),
      individual,
    }]);
    return await this.state();
  }

  async patchSolidEdgeLoops(references: EdgeReference[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "edge");
    requireSingleTopologyBody(references, "Patched Solid edge loops");
    const body = state.bodies.find((candidate) => candidate.id === references[0]!.bodyId)!;
    if (body.type !== "Solid") throw new Error("Native Solid edge-loop patching requires a Solid body");
    await this.runtime.mutate(`async function (Factory, Command, args) {
      ${findEdgeViews}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.edges = selectedEdges;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["PatchHoleInSolidFactory", "PatchHoleInSolidCommand"], [{ edges: references }]);
    return await this.state();
  }

  async moveEdges(references: EdgeReference[], deltaMm: Vector3, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "edge");
    requireSingleTopologyBody(references, "Moved edges");
    if (deltaMm.some((value) => !Number.isFinite(value)) || Math.hypot(...deltaMm) === 0) {
      throw new Error("Edge move delta must be a finite nonzero vector");
    }
    await this.runtime.mutate(`async function (Factory, Command, args) {
      ${findEdgeViews}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.shell = view;
          factory.edges = selectedEdges;
          factory.move.fromArray(args.delta);
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["MoveEdgeFactory", "MoveEdgeCommand"], [{ edges: references, delta: toMeters(deltaMm) }]);
    return await this.state();
  }

  async offsetEdges(references: EdgeReference[], distanceMm: number, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "edge");
    requireSingleTopologyBody(references, "Offset edges");
    if (!Number.isFinite(distanceMm) || distanceMm === 0) throw new Error("Edge offset distance must be finite and nonzero");
    await this.runtime.mutate(`async function (Factory, Command, args) {
      ${findEdgeViews}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.shell = view;
          factory.edges = selectedEdges;
          factory.distance = args.distance;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["OffsetEdgeFactory", "OffsetEdgeCommand"], [{ edges: references, distance: millimetersToMeters(distanceMm) }]);
    return await this.state();
  }

  async deleteEdges(references: EdgeReference[], revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "edge");
    requireSingleTopologyBody(references, "Deleted edges");
    await this.runtime.mutate(`async function (Factory, Command, args) {
      ${findEdgeViews}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.shell = view;
          factory.edges = selectedEdges;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["DeleteEdgeFactory", "DeleteEdgeCommand"], [{ edges: references }]);
    return await this.state();
  }

  async offsetVertices(references: VertexReference[], distanceMm: number, revision: string): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (references.length === 0) throw new Error("At least one shell vertex reference is required");
    const keys = references.map(({ bodyId, vertexId }) => `${bodyId}:${vertexId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Shell vertex references must be unique");
    if (new Set(references.map(({ bodyId }) => bodyId)).size !== 1) {
      throw new Error("Offset shell vertices must belong to one body");
    }
    for (const [index, reference] of references.entries()) requireVertexReference(state, reference, `vertices[${index}]`);
    const body = state.bodies.find((candidate) => candidate.id === references[0]!.bodyId)!;
    if (body.type !== "Solid" && body.type !== "Sheet") {
      throw new Error("Native shell-vertex offset requires a Solid or Sheet body");
    }
    if (!Number.isFinite(distanceMm) || distanceMm <= 0) {
      throw new Error("Shell-vertex offset distance must be finite and positive");
    }
    await this.runtime.mutate(`async function (Factory, Command, args) {
      const wanted = new Set(args.vertices.map(reference => reference.bodyId + ':' + reference.vertexId));
      const selectedByKey = new Map();
      for (const entry of this.snaps.cache.entries ?? []) {
        for (let index = 0; index < (entry.positions?.length ?? 0) / 3; index += 1) {
          const snap = entry.lookup(index);
          if (snap?.constructor?.name !== 'Snaps_ShellVertexSnap') continue;
          const bodyId = this.db.lookupStableId(snap.item?.versionId);
          const vertexId = snap.model?.Id?.();
          const key = bodyId + ':' + vertexId;
          if (wanted.has(key)) selectedByKey.set(key, snap);
        }
      }
      const missing = Array.from(wanted).filter(key => !selectedByKey.has(key));
      if (missing.length > 0) throw new Error('Stale or unavailable shell vertices: ' + missing.join(', '));
      const selectedSnaps = args.vertices.map(reference => selectedByKey.get(reference.bodyId + ':' + reference.vertexId));
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.vertices = selectedSnaps.map(snap => snap.model);
          if (!factory._vertices || !Array.isArray(factory._vertices.views)) {
            throw new Error('Plasticity 26.1.3 shell-vertex ownership bridge is unavailable');
          }
          factory._vertices.views = selectedSnaps.map(snap => ({ parentItem: snap.item, position: snap.position }));
          factory.distance = args.distance;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["OffsetVertexFactory", "OffsetVertexCommand"], [{ vertices: references, distance: millimetersToMeters(distanceMm) }]);
    return await this.state();
  }

  async rectangularFacePattern(
    references: FaceReference[],
    direction1: Vector3,
    count1: number,
    spacing1Mm: number,
    direction2: Vector3,
    count2: number,
    spacing2Mm: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "face");
    requireSingleTopologyBody(references, "Patterned faces");
    const body = state.bodies.find((candidate) => candidate.id === references[0]!.bodyId)!;
    if (body.type !== "Solid" && body.type !== "Sheet") throw new Error("Native face patterns require a Solid or Sheet body");
    const unitDirection1 = normalize(direction1, "Rectangular face pattern direction1");
    const unitDirection2 = normalize(direction2, "Rectangular face pattern direction2");
    if (!Number.isInteger(count1) || count1 < 2 || count1 > 1000) throw new Error("Rectangular face pattern count1 must be an integer between 2 and 1000");
    if (!Number.isInteger(count2) || count2 < 1 || count2 > 1000) throw new Error("Rectangular face pattern count2 must be an integer between 1 and 1000");
    if (!Number.isFinite(spacing1Mm) || spacing1Mm <= 0) throw new Error("Rectangular face pattern spacing1 must be positive");
    if (!Number.isFinite(spacing2Mm) || spacing2Mm < 0 || (count2 > 1 && spacing2Mm === 0)) throw new Error("Rectangular face pattern spacing2 must be positive when count2 is greater than one");
    if (count2 > 1 && nearlyParallel(unitDirection1, unitDirection2)) throw new Error("Rectangular face pattern directions must not be parallel");
    await this.runtime.mutate(`async function (Factory, Command, Vector, args) {
      ${findFaceViews}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const view = find(args.faces[0].bodyId);
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.shell = view;
          factory.faces = selectedFaces;
          factory.dir1 = new Vector(...args.direction1);
          factory.dir2 = new Vector(...args.direction2);
          factory.mode = 'spacing';
          factory.num1 = args.count1;
          factory.num2 = args.count2;
          factory.distance1 = args.spacing1;
          factory.distance2 = args.spacing2;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["RectangularArrayFacesFactory", "RectangularArrayFacesCommand", "Vector3"], [{
      faces: references,
      direction1: unitDirection1,
      count1,
      spacing1: millimetersToMeters(spacing1Mm),
      direction2: unitDirection2,
      count2,
      spacing2: millimetersToMeters(spacing2Mm),
    }]);
    return await this.state();
  }

  async radialFacePattern(
    references: FaceReference[],
    centerMm: Vector3,
    axis: Vector3,
    count: number,
    sweepDegrees: number,
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    requireTopologySelection(state, references, "face");
    requireSingleTopologyBody(references, "Patterned faces");
    const body = state.bodies.find((candidate) => candidate.id === references[0]!.bodyId)!;
    if (body.type !== "Solid" && body.type !== "Sheet") throw new Error("Native face patterns require a Solid or Sheet body");
    if (centerMm.some((value) => !Number.isFinite(value))) throw new Error("Radial face pattern center must be finite");
    const unitAxis = normalize(axis, "Radial face pattern axis");
    if (!Number.isInteger(count) || count < 2 || count > 1000) throw new Error("Radial face pattern count must be an integer between 2 and 1000");
    if (!Number.isFinite(sweepDegrees) || sweepDegrees <= 0 || sweepDegrees > 360) throw new Error("Radial face pattern sweep must be greater than zero and at most 360 degrees");
    await this.runtime.mutate(`async function (Factory, Command, Vector, args) {
      ${findFaceViews}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const view = find(args.faces[0].bodyId);
      const axis = new Vector(...args.axis);
      const reference = Math.abs(axis.z) < 0.9 ? new Vector(0, 0, 1) : new Vector(0, 1, 0);
      let failure;
      const command = new Command(editor);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.shell = view;
          factory.faces = selectedFaces;
          factory.center = new Vector(...args.center);
          factory.dir1 = reference.cross(axis).normalize();
          factory.dir2 = axis;
          factory.mode = 'total';
          factory.num1 = 1;
          factory.num2 = args.count;
          factory.angle = args.radians;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await editor.exec(command);
      if (failure) throw failure;
    }`, ["RadialArrayFacesFactory", "RadialArrayFacesCommand", "Vector3"], [{
      faces: references,
      center: toMeters(centerMm),
      axis: unitAxis,
      count,
      radians: degreesToRadians(sweepDegrees),
    }]);
    return await this.state();
  }

  async hollowFaces(
    id: number,
    faceIds: string[],
    wallThicknessMm: number,
    direction: "inward" | "outward",
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    const signedThickness = direction === "inward" ? -wallThicknessMm : wallThicknessMm;
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("HollowFacesCommand")}
      const view = find(args.id);
      const faces = view.high.faces;
      factory.faces = args.faceIds.map(id => {
        const index = faces.versionIds.indexOf(id);
        if (index < 0) throw new Error('Stale or unknown face: ' + id);
        return faces.get(index);
      });
      factory.thickness = args.thickness;
      ${commandEnd}
    }`, ["HollowFacesFactory"], [{ id, faceIds, thickness: millimetersToMeters(signedThickness) }]);
    return await this.state();
  }

  async hollowSolids(
    ids: number[],
    wallThicknessMm: number,
    direction: "inward" | "outward",
    revision: string,
  ): Promise<RuntimeState> {
    const state = await this.assertRevision(revision);
    if (ids.length === 0) throw new Error("At least one Solid is required for closed hollowing");
    if (new Set(ids).size !== ids.length) throw new Error("Closed-hollow Solid IDs must be unique");
    if (!Number.isFinite(wallThicknessMm) || wallThicknessMm <= 0) {
      throw new Error("Closed-hollow wall thickness must be positive");
    }
    if (direction !== "inward" && direction !== "outward") {
      throw new Error(`Unsupported closed-hollow direction: ${String(direction)}`);
    }
    const currentSolids = new Set(state.bodies.filter((body) => body.type === "Solid").map((body) => body.id));
    const invalid = ids.filter((id) => !currentSolids.has(id));
    if (invalid.length > 0) throw new Error(`Closed hollowing requires current Solids: ${invalid.join(", ")}`);
    const signedThickness = direction === "inward" ? -wallThicknessMm : wallThicknessMm;
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("HollowSolidsCommand")}
      const solids = args.ids.map(find);
      for (const view of solids) {
        if (view.constructor.name !== 'Solid') throw new Error('Closed hollowing inputs must be Solids');
      }
      factory.solids = solids;
      factory.thickness = args.thickness;
      factory.local = false;
      ${commandEnd}
    }`, ["HollowSolidsFactory"], [{ ids, thickness: millimetersToMeters(signedThickness) }]);
    return await this.state();
  }

  async mirror(
    ids: number[],
    planeOriginMm: Vector3,
    planeNormal: Vector3,
    keepOriginal: boolean,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(`async function (Factory, args) {
      ${findView}
      ${commandStart("MirrorCommand")}
      factory.shells = args.ids.map(find);
      factory.origin.fromArray(args.origin);
      factory.normal.fromArray(args.normal);
      factory.move = !args.keepOriginal;
      ${commandEnd}
    }`, ["MirrorFactory"], [{ ids, origin: toMeters(planeOriginMm), normal: planeNormal, keepOriginal }]);
    return await this.state();
  }

  async rectangularPattern(
    ids: number[],
    direction1: Vector3,
    count1: number,
    spacing1Mm: number,
    direction2: Vector3,
    count2: number,
    spacing2Mm: number,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    if (count2 > 1 && nearlyParallel(direction1, direction2)) throw new Error("Rectangular pattern directions must not be parallel");
    await this.runtime.mutate(`async function (Factory, Vector, args) {
      ${findView}
      ${commandStart("RectangularArrayCommand")}
      factory.items = args.ids.map(find);
      factory.dir1 = new Vector(...args.direction1).normalize();
      factory.dir2 = new Vector(...args.direction2).normalize();
      factory.mode = 'spacing';
      factory.num1 = args.count1;
      factory.num2 = args.count2;
      factory.distance1 = args.spacing1;
      factory.distance2 = args.spacing2;
      ${commandEnd}
    }`, ["RectangularArrayFactory", "Vector3"], [{
      ids,
      direction1,
      count1,
      spacing1: millimetersToMeters(spacing1Mm),
      direction2,
      count2,
      spacing2: millimetersToMeters(spacing2Mm),
    }]);
    return await this.state();
  }

  async radialPattern(
    ids: number[],
    centerMm: Vector3,
    axis: Vector3,
    count: number,
    sweepDegrees: number,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(`async function (Factory, Vector, args) {
      ${findView}
      ${commandStart("RadialArrayCommand")}
      const axis = new Vector(...args.axis).normalize();
      const reference = Math.abs(axis.z) < 0.9 ? new Vector(0, 0, 1) : new Vector(0, 1, 0);
      factory.items = args.ids.map(find);
      factory.center = new Vector(...args.center);
      factory.dir1 = reference.cross(axis).normalize();
      factory.dir2 = axis;
      factory.mode = 'total';
      factory.num1 = 1;
      factory.num2 = args.count;
      factory.angle = args.radians;
      ${commandEnd}
    }`, ["RadialArrayFactory", "Vector3"], [{
      ids,
      center: toMeters(centerMm),
      axis,
      count,
      radians: degreesToRadians(sweepDegrees),
    }]);
    return await this.state();
  }

  async rename(id: number, name: string, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(`async function (args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      const view = find(args.id);
      this.selection.selected.removeAll();
      let failure;
      const command = new this.commands.GroupSelectedCommand(this);
      command.remember = false;
      command.execute = async function () {
        try { editor.db.nodes.setName(editor.db.nodes.item2key(view), args.name); }
        catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, [], [{ id, name }]);
    return await this.state();
  }

  async remove(ids: number[], revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    await this.runtime.mutate(`async function (args) {
      ${findView}
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      this.selection.selected.removeAll();
      for (const view of args.ids.map(find)) this.selection.selected.add(view);
      const command = new this.commands.DeleteCommand(this);
      command.remember = false;
      let failure;
      const execute = command.execute.bind(command);
      command.execute = async function () {
        try { return await execute(); }
        catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, [], [{ ids }]);
    return await this.state();
  }

  async undo(revision?: string): Promise<RuntimeState> {
    if (revision) await this.assertRevision(revision);
    await this.runtime.mutate(`async function () { if (this.executor.isBusy) throw new Error('Plasticity is busy'); await this.undo(); }`, []);
    return await this.state();
  }

  async redo(revision?: string): Promise<RuntimeState> {
    if (revision) await this.assertRevision(revision);
    await this.runtime.mutate(`async function () { if (this.executor.isBusy) throw new Error('Plasticity is busy'); await this.redo(); }`, []);
    return await this.state();
  }

  async exportStep(ids: number[], outputPath: string, revision?: string): Promise<{ path: string; bytes: number }> {
    if (revision) await this.assertRevision(revision);
    const output = resolve(outputPath);
    if (![".step", ".stp"].includes(extname(output).toLowerCase())) throw new Error("STEP output must end in .step or .stp");
    await assertAbsent(output);
    await mkdir(dirname(output), { recursive: true });
    const staging = await mkdtemp(join(dirname(output), ".plasticity-step-"));
    const temporary = join(staging, "geometry.step");
    try {
      await this.runtime.mutate(`async function (Factory, args) {
        ${findView}
        if (this.executor.isBusy) throw new Error('Plasticity is busy');
        const factory = new Factory(this);
        factory.items = args.ids.map(find);
        factory.filePath = args.path;
        await factory.commit();
      }`, ["ExportCadFactory"], [{ ids, path: temporary }]);
      const text = await readFile(temporary, "utf8");
      if (!text.startsWith("ISO-10303-21;") || !text.includes("END-ISO-10303-21;")) throw new Error("Plasticity produced an invalid STEP file");
      await copyFile(temporary, output, constants.COPYFILE_EXCL);
      return { path: output, bytes: (await stat(output)).size };
    } finally {
      if (!this.runtime.isUncertain()) {
        await rm(temporary, { force: true }).catch(() => undefined);
        await rmdir(staging).catch(() => undefined);
      }
    }
  }

  async exportParasolid(
    ids: number[],
    outputPath: string,
    revision: string,
  ): Promise<{ path: string; bytes: number; format: "parasolid-text" | "parasolid-binary" }> {
    const state = await this.assertRevision(revision);
    requireCadExportBodies(state, ids, "Parasolid");
    const output = resolve(outputPath);
    const extension = extname(output).toLowerCase();
    if (extension !== ".x_t" && extension !== ".x_b") throw new Error("Parasolid output must end in .x_t or .x_b");
    await assertAbsent(output);
    await mkdir(dirname(output), { recursive: true });
    const staging = await mkdtemp(join(dirname(output), ".plasticity-parasolid-"));
    const temporary = join(staging, `geometry${extension}`);
    try {
      await this.runtime.mutate(`async function (Factory, args) {
        ${findView}
        if (this.executor.isBusy) throw new Error('Plasticity is busy');
        const factory = new Factory(this);
        factory.items = args.ids.map(find);
        factory.filePath = args.path;
        await factory.commit();
      }`, ["ExportCadFactory"], [{ ids, path: temporary }]);
      const bytes = await validateParasolidPath(temporary, "Plasticity Parasolid output");
      await copyFile(temporary, output, constants.COPYFILE_EXCL);
      return {
        path: output,
        bytes,
        format: extension === ".x_t" ? "parasolid-text" : "parasolid-binary",
      };
    } finally {
      if (!this.runtime.isUncertain()) {
        await rm(temporary, { force: true }).catch(() => undefined);
        await rmdir(staging).catch(() => undefined);
      }
    }
  }

  async exportStl(
    ids: number[],
    outputPath: string,
    revision: string,
    chordToleranceMm: number,
    angleToleranceDegrees: number,
  ): Promise<{ path: string; bytes: number; triangles: number; chordToleranceMm: number; angleToleranceDegrees: number }> {
    await this.assertRevision(revision);
    const output = resolve(outputPath);
    if (extname(output).toLowerCase() !== ".stl") throw new Error("STL output must end in .stl");
    await assertAbsent(output);
    await mkdir(dirname(output), { recursive: true });
    const staging = await mkdtemp(join(dirname(output), ".plasticity-stl-"));
    const temporary = join(staging, "geometry.stl");
    try {
      await this.runtime.mutate(`async function (Factory, args) {
        ${findView}
        if (this.executor.isBusy) throw new Error('Plasticity is busy');
        const factory = new Factory(this);
        factory.shells = args.ids.map(find);
        factory.filePath = args.path;
        factory.unit = 'millimeter';
        factory.curveChordTolerance = args.chordTolerance;
        factory.surfacePlaneTolerance = args.chordTolerance;
        factory.curveChordAngleDegrees = args.angleToleranceDegrees;
        factory.surfacePlaneAngleDegrees = args.angleToleranceDegrees;
        await factory.commit();
      }`, ["STLExportFactory"], [{
        ids,
        path: temporary,
        chordTolerance: millimetersToMeters(chordToleranceMm),
        angleToleranceDegrees,
      }]);
      const temporarySize = (await stat(temporary)).size;
      if (temporarySize === 0 || temporarySize > MAX_THREE_MF_ARCHIVE_BYTES) throw new Error("Plasticity produced an empty or excessively large 3MF archive");
      const data = await readFile(temporary);
      const triangles = validateBinaryStl(data);
      await copyFile(temporary, output, constants.COPYFILE_EXCL);
      return { path: output, bytes: data.length, triangles, chordToleranceMm, angleToleranceDegrees };
    } finally {
      if (!this.runtime.isUncertain()) {
        await rm(temporary, { force: true }).catch(() => undefined);
        await rmdir(staging).catch(() => undefined);
      }
    }
  }

  async export3mf(
    ids: number[],
    outputPath: string,
    revision: string,
    chordToleranceMm: number,
    angleToleranceDegrees: number,
  ): Promise<ThreeMfValidation & {
    path: string;
    bytes: number;
    sourceUnits: "millimeter";
    chordToleranceMm: number;
    angleToleranceDegrees: number;
  }> {
    const state = await this.assertRevision(revision);
    requireMeshExportBodies(state, ids);
    if (!Number.isFinite(chordToleranceMm) || chordToleranceMm <= 0) throw new Error("3MF chord tolerance must be a positive finite millimeter value");
    if (!Number.isFinite(angleToleranceDegrees) || angleToleranceDegrees <= 0 || angleToleranceDegrees > 90) throw new Error("3MF angle tolerance must be within (0, 90] degrees");
    const output = resolve(outputPath);
    if (extname(output).toLowerCase() !== ".3mf") throw new Error("3MF output must end in .3mf");
    await assertAbsent(output);
    await mkdir(dirname(output), { recursive: true });
    const staging = await mkdtemp(join(dirname(output), ".plasticity-3mf-"));
    const temporary = join(staging, "geometry.3mf");
    try {
      await this.runtime.mutate(`async function (Factory, args) {
        ${findView}
        if (this.executor.isBusy) throw new Error('Plasticity is busy');
        const factory = new Factory(this);
        factory.shells = args.ids.map(find);
        factory.filePath = args.path;
        factory.scale = args.scale;
        factory.curveChordTolerance = args.chordTolerance;
        factory.surfacePlaneTolerance = args.chordTolerance;
        factory.curveChordAngleDegrees = args.angleToleranceDegrees;
        factory.surfacePlaneAngleDegrees = args.angleToleranceDegrees;
        await factory.commit();
      }`, ["ThreeMfExportFactory"], [{
        ids,
        path: temporary,
        scale: 0.001,
        chordTolerance: millimetersToMeters(chordToleranceMm),
        angleToleranceDegrees,
      }]);
      const data = await readFile(temporary);
      const validation = validateThreeMfArchive(data);
      await copyFile(temporary, output, constants.COPYFILE_EXCL);
      return {
        path: output,
        bytes: data.length,
        sourceUnits: "millimeter",
        ...validation,
        chordToleranceMm,
        angleToleranceDegrees,
      };
    } finally {
      if (!this.runtime.isUncertain()) {
        await rm(temporary, { force: true }).catch(() => undefined);
        await rmdir(staging).catch(() => undefined);
      }
    }
  }

  async exportObj(
    ids: number[],
    outputPath: string,
    revision: string,
    chordToleranceMm: number,
    angleToleranceDegrees: number,
  ): Promise<ObjValidation & {
    path: string;
    bytes: number;
    sourceUnits: "millimeter";
    upAxis: "z";
    chordToleranceMm: number;
    angleToleranceDegrees: number;
  }> {
    const state = await this.assertRevision(revision);
    requireMeshExportBodies(state, ids, "OBJ");
    if (!Number.isFinite(chordToleranceMm) || chordToleranceMm <= 0) throw new Error("OBJ chord tolerance must be a positive finite millimeter value");
    if (!Number.isFinite(angleToleranceDegrees) || angleToleranceDegrees <= 0 || angleToleranceDegrees > 90) throw new Error("OBJ angle tolerance must be within (0, 90] degrees");
    const output = resolve(outputPath);
    if (extname(output).toLowerCase() !== ".obj") throw new Error("OBJ output must end in .obj");
    await assertAbsent(output);
    await mkdir(dirname(output), { recursive: true });
    const staging = await mkdtemp(join(dirname(output), ".plasticity-obj-"));
    const temporary = join(staging, "geometry.obj");
    try {
      await this.runtime.mutate(`async function (Factory, args) {
        ${findView}
        if (this.executor.isBusy) throw new Error('Plasticity is busy');
        const factory = new Factory(this);
        factory.shells = args.ids.map(find);
        factory.filePath = args.path;
        factory.unit = 'millimeter';
        factory.scale = 1;
        factory.upAxis = 'z';
        factory.showWireframe = false;
        factory.simplify = false;
        factory.curveChordTolerance = args.chordTolerance;
        factory.surfacePlaneTolerance = args.chordTolerance;
        factory.curveChordAngleDegrees = args.angleToleranceDegrees;
        factory.surfacePlaneAngleDegrees = args.angleToleranceDegrees;
        await factory.commit();
      }`, ["OBJExportFactory"], [{
        ids,
        path: temporary,
        chordTolerance: millimetersToMeters(chordToleranceMm),
        angleToleranceDegrees,
      }]);
      const temporarySize = (await stat(temporary)).size;
      if (temporarySize === 0 || temporarySize > MAX_OBJ_BYTES) throw new Error("Plasticity produced an empty or excessively large OBJ file");
      const data = await readFile(temporary);
      const validation = validateObj(data);
      await copyFile(temporary, output, constants.COPYFILE_EXCL);
      return {
        path: output,
        bytes: data.length,
        sourceUnits: "millimeter",
        upAxis: "z",
        ...validation,
        chordToleranceMm,
        angleToleranceDegrees,
      };
    } finally {
      if (!this.runtime.isUncertain()) {
        await rm(temporary, { force: true }).catch(() => undefined);
        await rmdir(staging).catch(() => undefined);
      }
    }
  }

  async exportSvg(ids: number[], outputPath: string, revision: string, curveChordToleranceMm = 0.05, curveChordAngleDegrees = 5): Promise<{
    path: string;
    bytes: number;
    bodies: number;
    lineSegments: number;
    circularSegments: number;
    fullCircles: number;
    fullEllipses: number;
    ellipticalArcs: number;
    cubicBezierSegments: number;
    approximatedSegments: number;
    maxChordDeviationMm: number;
    curveChordToleranceMm: number;
    curveChordAngleDegrees: number;
    sourceUnits: "millimeter";
    boundsMm: { min: [number, number]; max: [number, number]; size: [number, number] };
    pageSizeMm: [number, number];
  }> {
    const before = await this.assertRevision(revision);
    requireWireBodyIds(before, ids);
    if (!Number.isFinite(curveChordToleranceMm) || curveChordToleranceMm <= 0 || curveChordToleranceMm > 5) {
      throw new Error("SVG curve chord tolerance must be within (0, 5] mm");
    }
    if (!Number.isFinite(curveChordAngleDegrees) || curveChordAngleDegrees <= 0 || curveChordAngleDegrees > 30) {
      throw new Error("SVG curve angle tolerance must be within (0, 30] degrees");
    }
    const output = resolve(outputPath);
    if (extname(output).toLowerCase() !== ".svg") throw new Error("SVG output must end in .svg");
    await assertAbsent(output);
    const curves = await this.runtime.readNative<Array<{
      id: number;
      closed: boolean;
      plane: { originMm: Vector3; normal: Vector3 } | null;
      segments: Array<{
        curveType: string;
        startMm: Vector3;
        endMm: Vector3;
        lengthMm: number;
        circle: { centerMm: Vector3; radiusMm: number; normal: Vector3; samplesMm: Vector3[] } | null;
        ellipse: {
          carrierSamplesMm: Vector3[];
          parameterStart: number;
          parameterEnd: number;
          parameterPeriod: number;
          startTangent: Vector3;
        } | null;
        cubicBezierSpans: Array<{
          samplesMm: Vector3[];
          validationSamples: Array<{ parameter: number; positionMm: Vector3 }>;
        }> | null;
        rationalConic: { fitSamplesMm: Vector3[]; validationSamplesMm: Vector3[]; startTangent: Vector3 } | null;
        approximation: { pointsMm: Vector3[]; maxChordDeviationMm: number } | null;
      }>;
    }>>(`function (args) {
      const tessellateCurve = (${tessellateCurve.toString()});
      const isExactSvgCubicPolynomialDegree = (${isExactSvgCubicPolynomialDegree.toString()});
      const mm = value => value * 1000;
      const vector = value => [mm(value.x), mm(value.y), mm(value.z)];
      const directionVector = value => [value.x, value.y, value.z];
      const direction = value => {
        const length = Math.hypot(value.x, value.y, value.z);
        if (!(length > 0)) throw new Error('Native circular curve has a zero plane normal');
        return [value.x / length, value.y / length, value.z / length];
      };
      const result = [];
      let totalApproximationPoints = 0;
      for (const wantedId of args.ids) {
        let found;
        for (const [versionId, item] of this.geo.geometryModel) {
          if (this.db.lookupStableId(versionId) === wantedId) { found = [versionId, item]; break; }
        }
        if (!found) throw new Error('Unknown current Wire ID: ' + wantedId);
        const [versionId, item] = found;
        if (item.view?.constructor?.name !== 'Wire') throw new Error('SVG export requires a Wire: ' + wantedId);
        const basis = item.model?.FindPlanarBasis?.();
        const edges = item.model?.GetEdges?.();
        if (!basis || !edges) throw new Error('SVG export requires a planar native Wire: ' + wantedId);
        let closed = true;
        for (const vertex of Array.from(item.view.vertices ?? [])) {
          if (this.db.lookupTopologyItem(vertex).IsSpur()) { closed = false; break; }
        }
        const segments = [];
        for (let index = 0; index < edges.Size(); index++) {
          const edge = edges.Get(index);
          const wrapped = edge.GetCurve();
          const curve = wrapped?.curve ?? wrapped;
          const curveType = String(curve?.constructor?.name ?? 'Unknown');
          const startEvaluation = edge.GetPointAndTangent(0);
          const endEvaluation = edge.GetPointAndTangent(1);
          let circle = null;
          let ellipse = null;
          let cubicBezierSpans = null;
          let rationalConic = null;
          let approximation = null;
          if (curveType === 'Circle') {
            const info = curve.GetInfo?.();
            const circleBasis = info?.basis;
            if (!circleBasis || !Number.isFinite(info?.radius) || !(info.radius > 0)) {
              throw new Error('Plasticity returned incomplete analytic data for a circular Wire segment');
            }
            circle = {
              centerMm: vector(circleBasis.Location),
              radiusMm: mm(info.radius),
              normal: direction(circleBasis.Axis),
              samplesMm: [0, 0.25, 0.5, 0.75, 1].map(parameter => vector(edge.GetPointAndTangent(parameter).position)),
            };
          } else if (curveType === 'Ellipse') {
            const carrierInterval = curve.GetInterval?.();
            const uMin = Number(wrapped?.uMin);
            const uMax = Number(wrapped?.uMax);
            const carrierMin = Number(carrierInterval?.tmin);
            const carrierMax = Number(carrierInterval?.tmax);
            if ([uMin, uMax, carrierMin, carrierMax].every(Number.isFinite) && uMax !== uMin && carrierMax > carrierMin) {
              const fromMin = curve.GetPoint(uMin);
              const fromMax = curve.GetPoint(uMax);
              const minMatchesStart = Math.hypot(fromMin.x - startEvaluation.position.x, fromMin.y - startEvaluation.position.y, fromMin.z - startEvaluation.position.z) <= 1e-9;
              const maxMatchesStart = Math.hypot(fromMax.x - startEvaluation.position.x, fromMax.y - startEvaluation.position.y, fromMax.z - startEvaluation.position.z) <= 1e-9;
              const minMatchesEnd = Math.hypot(fromMin.x - endEvaluation.position.x, fromMin.y - endEvaluation.position.y, fromMin.z - endEvaluation.position.z) <= 1e-9;
              const maxMatchesEnd = Math.hypot(fromMax.x - endEvaluation.position.x, fromMax.y - endEvaluation.position.y, fromMax.z - endEvaluation.position.z) <= 1e-9;
              let parameterStart = NaN;
              let parameterEnd = NaN;
              if (minMatchesStart && maxMatchesEnd) { parameterStart = uMin; parameterEnd = uMax; }
              else if (maxMatchesStart && minMatchesEnd) { parameterStart = uMax; parameterEnd = uMin; }
              if (Number.isFinite(parameterStart) && Number.isFinite(parameterEnd)) {
                ellipse = {
                  carrierSamplesMm: [0, 0.25, 0.5, 0.75, 1].map(fraction => vector(curve.GetPoint(carrierMin + (carrierMax - carrierMin) * fraction))),
                  parameterStart,
                  parameterEnd,
                  parameterPeriod: carrierMax - carrierMin,
                  startTangent: directionVector(startEvaluation.tangent),
                };
              }
            }
            if (!ellipse) {
              const tessellation = tessellateCurve(parameter => {
                const evaluated = edge.GetPointAndTangent(parameter);
                return { point: vector(evaluated.position), tangent: directionVector(evaluated.tangent) };
              }, args.curveChordToleranceMm, args.curveChordAngleDegrees);
              totalApproximationPoints += tessellation.points.length;
              if (totalApproximationPoints > 200_000) throw new Error('SVG export exceeds the total adaptive-curve point limit');
              approximation = { pointsMm: tessellation.points, maxChordDeviationMm: tessellation.maxChordDeviationMm };
            }
          } else if (curveType === 'BCurve') {
            try {
              const info = curve.GetInfo?.();
              if (info?.isRational === true) {
                const sample = parameter => vector(edge.GetPointAndTangent(parameter).position);
                rationalConic = {
                  fitSamplesMm: [0.1, 0.3, 0.5, 0.7, 0.9].map(sample),
                  validationSamplesMm: Array.from({ length: 65 }, (_, index) => sample(index / 64)),
                  startTangent: directionVector(startEvaluation.tangent),
                };
              }
              // Each non-rational B-spline knot span of degree 1-3 is polynomial
              // and can be represented exactly by an SVG cubic, including periodic
              // curves. The per-span native sample checks below remain the gate.
              if (isExactSvgCubicPolynomialDegree(info?.degree, info?.isRational) && Number.isInteger(info?.numDistinctKnots) && info.numDistinctKnots >= 2 && info.knotVals) {
              const knotParameters = [];
              for (let knotIndex = 0; knotIndex < info.numDistinctKnots; knotIndex++) {
                const parameter = Number(edge.Normalize(Number(info.knotVals[knotIndex])));
                if (Number.isFinite(parameter) && parameter >= -1e-10 && parameter <= 1 + 1e-10) knotParameters.push(Math.max(0, Math.min(1, parameter)));
              }
              knotParameters.push(0, 1);
              const breaks = Array.from(new Set(knotParameters.sort((left, right) => left - right).map(parameter => Number(parameter.toPrecision(14)))));
              if (breaks[0] === 0 && breaks.at(-1) === 1 && breaks.length >= 2 && breaks.length <= 1_025) {
                const sample = parameter => vector(edge.GetPointAndTangent(parameter).position);
                const spans = [];
                for (let spanIndex = 0; spanIndex < breaks.length - 1; spanIndex++) {
                  const start = breaks[spanIndex];
                  const end = breaks[spanIndex + 1];
                  if (!(end > start)) continue;
                  const at = fraction => start + (end - start) * fraction;
                  spans.push({
                    samplesMm: [0, 1 / 3, 2 / 3, 1].map(fraction => sample(at(fraction))),
                    validationSamples: [1 / 8, 1 / 4, 1 / 2, 3 / 4, 7 / 8].map(fraction => ({ parameter: fraction, positionMm: sample(at(fraction)) })),
                  });
                }
                if (spans.length === breaks.length - 1) cubicBezierSpans = spans;
              }
              }
            } catch { cubicBezierSpans = null; }
            if (!cubicBezierSpans) {
              const tessellation = tessellateCurve(parameter => {
                const evaluated = edge.GetPointAndTangent(parameter);
                return { point: vector(evaluated.position), tangent: directionVector(evaluated.tangent) };
              }, args.curveChordToleranceMm, args.curveChordAngleDegrees);
              totalApproximationPoints += tessellation.points.length;
              if (totalApproximationPoints > 200_000) throw new Error('SVG export exceeds the total adaptive-curve point limit');
              approximation = { pointsMm: tessellation.points, maxChordDeviationMm: tessellation.maxChordDeviationMm };
            }
          } else if (curveType !== 'Line') {
            const tessellation = tessellateCurve(parameter => {
              const evaluated = edge.GetPointAndTangent(parameter);
              return { point: vector(evaluated.position), tangent: directionVector(evaluated.tangent) };
            }, args.curveChordToleranceMm, args.curveChordAngleDegrees);
            totalApproximationPoints += tessellation.points.length;
            if (totalApproximationPoints > 200_000) throw new Error('SVG export exceeds the total adaptive-curve point limit');
            approximation = { pointsMm: tessellation.points, maxChordDeviationMm: tessellation.maxChordDeviationMm };
          }
          segments.push({
            curveType,
            startMm: vector(startEvaluation.position),
            endMm: vector(endEvaluation.position),
            lengthMm: mm(edge.FindLength().length),
            circle,
            ellipse,
            cubicBezierSpans,
            rationalConic,
            approximation,
          });
        }
        result.push({ id: wantedId, versionId: Number(versionId), closed, plane: { originMm: vector(basis.Location), normal: direction(basis.Axis) }, segments });
      }
      return result;
    }`, [], [{ ids, curveChordToleranceMm, curveChordAngleDegrees }]);
    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while SVG geometry was being read");
    }
    if (curves.length !== ids.length || curves.some((curve, index) => curve.id !== ids[index])) {
      throw new Error("Plasticity returned an incomplete or reordered SVG Wire set");
    }
    const referencePlane = curves[0]?.plane;
    if (!referencePlane) throw new Error("SVG export requires a planar native Wire");
    const normalLength = Math.hypot(...referencePlane.normal);
    if (!Number.isFinite(normalLength) || normalLength <= 0) throw new Error("SVG Wire has an invalid native plane normal");
    const normal = referencePlane.normal.map((value) => value / normalLength) as Vector3;
    const worldX: Vector3 = [1, 0, 0];
    const worldY: Vector3 = [0, 1, 0];
    const candidate = Math.abs(dot(normal, worldX)) < 0.9 ? worldX : worldY;
    const xProjection = subtract(candidate, scale(normal, dot(candidate, normal)));
    const xAxis = normalize(xProjection);
    const yAxis = cross(normal, xAxis);
    const project = (point: Vector3): [number, number] => {
      if (Math.abs(dot(subtract(point, referencePlane.originMm), normal)) > 1e-6) {
        throw new Error("All exported Wire segments must lie in one common plane");
      }
      const relative = subtract(point, referencePlane.originMm);
      const x = dot(relative, xAxis);
      const y = -dot(relative, yAxis);
      return [Object.is(x, -0) ? 0 : x, Object.is(y, -0) ? 0 : y];
    };
    const paths: string[] = [];
    const points: Array<[number, number]> = [];
    let lineSegments = 0;
    let circularSegments = 0;
    let fullCircles = 0;
    let fullEllipses = 0;
    let ellipticalArcs = 0;
    let cubicBezierSegments = 0;
    let approximatedSegments = 0;
    let maxChordDeviationMm = 0;
    let totalPolylinePoints = 0;
    const angle2d = (point: [number, number], center: [number, number]) => Math.atan2(point[1] - center[1], point[0] - center[0]);
    const positiveAngle = (angle: number) => (angle % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    for (const curve of curves) {
      if (!curve.plane) throw new Error(`SVG export requires a planar native Wire: ${curve.id}`);
      const curveNormalLength = Math.hypot(...curve.plane.normal);
      if (!Number.isFinite(curveNormalLength) || curveNormalLength <= 0) throw new Error(`SVG Wire has an invalid plane normal: ${curve.id}`);
      const curveNormal = curve.plane.normal.map((value) => value / curveNormalLength) as Vector3;
      if (Math.abs(Math.abs(dot(normal, curveNormal)) - 1) > 1e-9 || Math.abs(dot(subtract(curve.plane.originMm, referencePlane.originMm), normal)) > 1e-6) {
        throw new Error("All exported Wires must be coplanar");
      }
      for (const segment of curve.segments) {
        const start = project(segment.startMm);
        const end = project(segment.endMm);
        let exactCubicBezier: { commands: string[]; boundsPoints: [number, number][] } | null = null;
        let exactRationalConic: { ellipse: ReturnType<typeof fitSvgConicEllipse>; arc: { largeArcFlag: 0 | 1; sweepFlag: 0 | 1 } | null; boundsPoints: [number, number][]; full: boolean } | null = null;
        if (segment.curveType === "BCurve" && segment.rationalConic) {
          try {
            const conic = segment.rationalConic;
            if (conic.fitSamplesMm.length === 5 && conic.validationSamplesMm.length >= 9) {
              const ellipse = fitSvgConicEllipse(conic.fitSamplesMm.map(project));
              const validationTolerance = Math.max(1e-7, ellipse.majorRadius * 1e-9);
              const validationPoints = conic.validationSamplesMm.map(project);
              for (const point of validationPoints) {
                const x = (point[0] - ellipse.center[0]) * ellipse.majorAxis[0] + (point[1] - ellipse.center[1]) * ellipse.majorAxis[1];
                const y = (point[0] - ellipse.center[0]) * ellipse.minorAxis[0] + (point[1] - ellipse.center[1]) * ellipse.minorAxis[1];
                if (Math.abs(Math.hypot(x / ellipse.majorRadius, y / ellipse.minorRadius) - 1) * ellipse.majorRadius > validationTolerance) {
                  throw new Error("Rational BCurve validation samples do not lie on one ellipse");
                }
              }
              const parameterAngle = (point: [number, number]): number => Math.atan2(
                ((point[0] - ellipse.center[0]) * ellipse.minorAxis[0] + (point[1] - ellipse.center[1]) * ellipse.minorAxis[1]) / ellipse.minorRadius,
                ((point[0] - ellipse.center[0]) * ellipse.majorAxis[0] + (point[1] - ellipse.center[1]) * ellipse.majorAxis[1]) / ellipse.majorRadius,
              );
              let sweep = 0;
              let direction = 0;
              for (let index = 1; index < validationPoints.length; index++) {
                const difference = parameterAngle(validationPoints[index]!) - parameterAngle(validationPoints[index - 1]!);
                const delta = Math.atan2(Math.sin(difference), Math.cos(difference));
                if (Math.abs(delta) >= Math.PI / 2) throw new Error("Rational BCurve ellipse sweep is under-sampled or ambiguous");
                if (Math.abs(delta) > 1e-10) {
                  const nextDirection = Math.sign(delta);
                  if (direction !== 0 && direction !== nextDirection) throw new Error("Rational BCurve reverses direction on its fitted ellipse");
                  direction = nextDirection;
                }
                sweep += delta;
              }
              const full = Math.abs(Math.abs(sweep) - 2 * Math.PI) <= 1e-6;
              if (!(Math.abs(sweep) > 1e-8) || Math.abs(sweep) > 2 * Math.PI + 1e-6) throw new Error("Rational BCurve ellipse sweep is degenerate or exceeds one turn");
              if (full && (!curve.closed || Math.hypot(end[0] - start[0], end[1] - start[1]) > validationTolerance)) {
                throw new Error("A full rational conic must be a closed native Wire");
              }
              const boundsPoints: [number, number][] = [];
              if (full) {
                const xExtent = Math.hypot(ellipse.majorRadius * ellipse.majorAxis[0], ellipse.minorRadius * ellipse.minorAxis[0]);
                const yExtent = Math.hypot(ellipse.majorRadius * ellipse.majorAxis[1], ellipse.minorRadius * ellipse.minorAxis[1]);
                boundsPoints.push([ellipse.center[0] - xExtent, ellipse.center[1]], [ellipse.center[0] + xExtent, ellipse.center[1]], [ellipse.center[0], ellipse.center[1] - yExtent], [ellipse.center[0], ellipse.center[1] + yExtent]);
              } else {
                const tangent: [number, number] = [dot(conic.startTangent, xAxis), -dot(conic.startTangent, yAxis)];
                const arc = analyzeSvgEllipseArc(ellipse, start, end, tangent, 0, sweep / (2 * Math.PI), 1);
                boundsPoints.push(...arc.boundsPoints);
                exactRationalConic = { ellipse, arc, boundsPoints, full };
              }
              if (full) exactRationalConic = { ellipse, arc: null, boundsPoints, full };
            }
          } catch { exactRationalConic = null; }
        }
        if (segment.curveType === "BCurve" && segment.cubicBezierSpans) {
          const commands: string[] = [];
          const boundsPoints: [number, number][] = [];
          let currentStart: [number, number] | null = null;
          let valid = true;
          for (const span of segment.cubicBezierSpans) {
            if (span.samplesMm.length !== 4 || span.validationSamples.length !== 5) { valid = false; break; }
            const samples = span.samplesMm.map(project);
            const controls = fitSvgCubicBezier(samples);
            const validationScale = Math.max(1, ...controls.flat().map(Math.abs));
            for (const validation of span.validationSamples) {
              const actual = project(validation.positionMm);
              const expected = evaluateSvgCubicBezier(controls, validation.parameter);
              if (Math.hypot(actual[0] - expected[0], actual[1] - expected[1]) > validationScale * 1e-10) {
                valid = false;
                break;
              }
            }
            if (!valid) break;
            const spanStart = controls[0];
            if (currentStart && Math.hypot(currentStart[0] - spanStart[0], currentStart[1] - spanStart[1]) > validationScale * 1e-10) {
              valid = false;
              break;
            }
            if (!currentStart && Math.hypot(start[0] - spanStart[0], start[1] - spanStart[1]) > validationScale * 1e-10) {
              valid = false;
              break;
            }
            if (!currentStart) currentStart = spanStart;
            commands.push(`C ${formatSvgNumber(controls[1][0])} ${formatSvgNumber(controls[1][1])} ${formatSvgNumber(controls[2][0])} ${formatSvgNumber(controls[2][1])} ${formatSvgNumber(controls[3][0])} ${formatSvgNumber(controls[3][1])}`);
            boundsPoints.push(...svgCubicBezierBoundsPoints(controls));
            currentStart = controls[3];
          }
          if (valid && commands.length > 0 && currentStart && Math.hypot(currentStart[0] - end[0], currentStart[1] - end[1]) <= Math.max(1e-8, Math.hypot(...end) * 1e-10)) {
            exactCubicBezier = { commands, boundsPoints };
          }
        }
        if (segment.curveType === "Line") {
          if (Math.hypot(end[0] - start[0], end[1] - start[1]) <= 1e-12) throw new Error("SVG export cannot include zero-length native lines");
          points.push(start, end);
          paths.push(`<path d="M ${formatSvgNumber(start[0])} ${formatSvgNumber(start[1])} L ${formatSvgNumber(end[0])} ${formatSvgNumber(end[1])}"/>`);
          lineSegments += 1;
        } else if (segment.curveType === "Circle" && segment.circle) {
          const circle = segment.circle;
          if (!Number.isFinite(circle.radiusMm) || circle.radiusMm <= 0) throw new Error("SVG circular Wire radius must be positive and finite");
          const circleNormalLength = Math.hypot(...circle.normal);
          if (!Number.isFinite(circleNormalLength) || circleNormalLength <= 0) throw new Error("SVG circular Wire has an invalid plane normal");
          const circleNormal = circle.normal.map((value) => value / circleNormalLength) as Vector3;
          if (Math.abs(Math.abs(dot(normal, circleNormal)) - 1) > 1e-9) throw new Error("SVG circular Wire axis must match its planar profile");
          const center = project(circle.centerMm);
          if (circle.samplesMm.length !== 5) throw new Error("SVG circular Wire requires five exact native curve samples");
          const samples = circle.samplesMm.map(project);
          for (const sample of samples) {
            const distance = Math.hypot(sample[0] - center[0], sample[1] - center[1]);
            if (Math.abs(distance - circle.radiusMm) > Math.max(1e-6, circle.radiusMm * 1e-8)) {
              throw new Error("Native Circle sample does not match its reported exact radius");
            }
          }
          const endpointGap = Math.hypot(end[0] - start[0], end[1] - start[1]);
          if (endpointGap <= Math.max(1e-8, circle.radiusMm * 1e-9)) {
            if (!curve.closed) throw new Error("A full circular SVG element requires a closed native Wire");
            if (Math.abs(segment.lengthMm - 2 * Math.PI * circle.radiusMm) > Math.max(1e-6, segment.lengthMm * 1e-8)) {
              throw new Error("Closed native Circle length does not match its exact radius");
            }
            points.push([center[0] - circle.radiusMm, center[1]], [center[0] + circle.radiusMm, center[1]], [center[0], center[1] - circle.radiusMm], [center[0], center[1] + circle.radiusMm]);
            paths.push(`<circle cx="${formatSvgNumber(center[0])}" cy="${formatSvgNumber(center[1])}" r="${formatSvgNumber(circle.radiusMm)}"/>`);
            circularSegments += 1;
            fullCircles += 1;
            continue;
          }
          if (Math.hypot(samples[0]![0] - start[0], samples[0]![1] - start[1]) > 1e-8 || Math.hypot(samples[4]![0] - end[0], samples[4]![1] - end[1]) > 1e-8) {
            throw new Error("Native circular Wire samples do not match its B-Rep endpoints");
          }
          const startAngle = angle2d(start, center);
          const endAngle = angle2d(end, center);
          const middleAngle = angle2d(samples[2]!, center);
          const ccwSweep = positiveAngle(endAngle - startAngle);
          const middleCcwSweep = positiveAngle(middleAngle - startAngle);
          const sweepFlag = middleCcwSweep < ccwSweep ? 1 : 0;
          const sweep = sweepFlag === 1 ? ccwSweep : 2 * Math.PI - ccwSweep;
          if (!(sweep > 1e-10 && sweep < 2 * Math.PI - 1e-10)) throw new Error("Native circular Wire sweep is degenerate or ambiguous");
          if (Math.abs(segment.lengthMm - circle.radiusMm * sweep) > Math.max(1e-6, segment.lengthMm * 1e-8)) {
            throw new Error("Native circular Wire length does not match its exact SVG arc sweep");
          }
          const largeArcFlag = sweep > Math.PI + 1e-10 ? 1 : 0;
          points.push(start, end);
          for (let quadrant = 0; quadrant < 4; quadrant++) {
            const angle = quadrant * Math.PI / 2;
            const delta = sweepFlag === 1 ? positiveAngle(angle - startAngle) : positiveAngle(startAngle - angle);
            if (delta <= sweep + 1e-10) points.push([center[0] + circle.radiusMm * Math.cos(angle), center[1] + circle.radiusMm * Math.sin(angle)]);
          }
          paths.push(`<path d="M ${formatSvgNumber(start[0])} ${formatSvgNumber(start[1])} A ${formatSvgNumber(circle.radiusMm)} ${formatSvgNumber(circle.radiusMm)} 0 ${largeArcFlag} ${sweepFlag} ${formatSvgNumber(end[0])} ${formatSvgNumber(end[1])}"/>`);
          circularSegments += 1;
        } else if (exactRationalConic) {
          const conic = exactRationalConic;
          points.push(...conic.boundsPoints);
          if (conic.full) {
            paths.push(`<ellipse cx="${formatSvgNumber(conic.ellipse.center[0])}" cy="${formatSvgNumber(conic.ellipse.center[1])}" rx="${formatSvgNumber(conic.ellipse.majorRadius)}" ry="${formatSvgNumber(conic.ellipse.minorRadius)}" transform="rotate(${formatSvgNumber(conic.ellipse.rotationDegrees)} ${formatSvgNumber(conic.ellipse.center[0])} ${formatSvgNumber(conic.ellipse.center[1])})" data-curve-type="BCurve" data-representation="ellipse-fit" data-validation="65-native-brep-samples"/>`);
            fullEllipses += 1;
          } else {
            if (!conic.arc) throw new Error("Validated rational conic arc lost its SVG sweep data");
            paths.push(`<path d="M ${formatSvgNumber(start[0])} ${formatSvgNumber(start[1])} A ${formatSvgNumber(conic.ellipse.majorRadius)} ${formatSvgNumber(conic.ellipse.minorRadius)} ${formatSvgNumber(conic.ellipse.rotationDegrees)} ${conic.arc.largeArcFlag} ${conic.arc.sweepFlag} ${formatSvgNumber(end[0])} ${formatSvgNumber(end[1])}" data-curve-type="BCurve" data-representation="ellipse-fit" data-validation="65-native-brep-samples"/>`);
            ellipticalArcs += 1;
          }
        } else if (exactCubicBezier) {
          points.push(...exactCubicBezier.boundsPoints);
          paths.push(`<path d="M ${formatSvgNumber(start[0])} ${formatSvgNumber(start[1])} ${exactCubicBezier.commands.join(" ")}" data-curve-type="BCurve"/>`);
          cubicBezierSegments += 1;
        } else if (segment.approximation) {
          const { pointsMm, maxChordDeviationMm: segmentDeviation } = segment.approximation;
          if (pointsMm.length < 2 || pointsMm.length > 16_384 || !Number.isFinite(segmentDeviation) || segmentDeviation < 0 || segmentDeviation > curveChordToleranceMm) {
            throw new Error(`SVG approximation for ${segment.curveType} did not meet its point-count or chord-tolerance contract`);
          }
          totalPolylinePoints += pointsMm.length;
          if (totalPolylinePoints > 200_000) throw new Error("SVG export exceeds the total polyline point limit");
          const polyline = pointsMm.map(project);
          if (Math.hypot(polyline[0]![0] - start[0], polyline[0]![1] - start[1]) > 1e-8 || Math.hypot(polyline.at(-1)![0] - end[0], polyline.at(-1)![1] - end[1]) > 1e-8) {
            throw new Error(`SVG approximation endpoints do not match native ${segment.curveType} B-Rep endpoints`);
          }
          if (polyline.some((point, index) => index > 0 && Math.hypot(point[0] - polyline[index - 1]![0], point[1] - polyline[index - 1]![1]) <= 1e-12)) {
            throw new Error(`SVG approximation for ${segment.curveType} contains a zero-length span`);
          }
          const pathData = polyline.map((point, index) => `${index === 0 ? "M" : "L"} ${formatSvgNumber(point[0])} ${formatSvgNumber(point[1])}`).join(" ");
          points.push(...polyline);
          paths.push(`<path d="${pathData}" data-curve-type="${escapeSvgAttribute(segment.curveType)}" data-approximation="adaptive-chord"/>`);
          approximatedSegments += 1;
          maxChordDeviationMm = Math.max(maxChordDeviationMm, segmentDeviation);
        } else if (segment.curveType === "Ellipse" && segment.ellipse) {
          const ellipse = fitSvgEllipse(segment.ellipse.carrierSamplesMm.map(project));
          const parameterSpan = Math.abs(segment.ellipse.parameterEnd - segment.ellipse.parameterStart);
          const isSingleClosedEllipse = curve.closed && curve.segments.length === 1 &&
            Math.abs(parameterSpan - segment.ellipse.parameterPeriod) <= segment.ellipse.parameterPeriod * 1e-8;
          if (isSingleClosedEllipse) {
            if (Math.hypot(end[0] - start[0], end[1] - start[1]) > Math.max(1e-7, ellipse.majorRadius * 1e-8)) {
              throw new Error("Closed native Ellipse endpoints do not meet");
            }
            const xExtent = Math.hypot(ellipse.majorRadius * ellipse.majorAxis[0], ellipse.minorRadius * ellipse.minorAxis[0]);
            const yExtent = Math.hypot(ellipse.majorRadius * ellipse.majorAxis[1], ellipse.minorRadius * ellipse.minorAxis[1]);
            points.push(
              [ellipse.center[0] - xExtent, ellipse.center[1]], [ellipse.center[0] + xExtent, ellipse.center[1]],
              [ellipse.center[0], ellipse.center[1] - yExtent], [ellipse.center[0], ellipse.center[1] + yExtent],
            );
            paths.push(`<ellipse cx="${formatSvgNumber(ellipse.center[0])}" cy="${formatSvgNumber(ellipse.center[1])}" rx="${formatSvgNumber(ellipse.majorRadius)}" ry="${formatSvgNumber(ellipse.minorRadius)}" transform="rotate(${formatSvgNumber(ellipse.rotationDegrees)} ${formatSvgNumber(ellipse.center[0])} ${formatSvgNumber(ellipse.center[1])})"/>`);
            fullEllipses += 1;
          } else {
            const startTangent: [number, number] = [
              dot(segment.ellipse.startTangent, xAxis),
              -dot(segment.ellipse.startTangent, yAxis),
            ];
            const arc = analyzeSvgEllipseArc(
              ellipse, start, end, startTangent,
              segment.ellipse.parameterStart, segment.ellipse.parameterEnd, segment.ellipse.parameterPeriod,
            );
            points.push(...arc.boundsPoints);
            paths.push(`<path d="M ${formatSvgNumber(start[0])} ${formatSvgNumber(start[1])} A ${formatSvgNumber(ellipse.majorRadius)} ${formatSvgNumber(ellipse.minorRadius)} ${formatSvgNumber(ellipse.rotationDegrees)} ${arc.largeArcFlag} ${arc.sweepFlag} ${formatSvgNumber(end[0])} ${formatSvgNumber(end[1])}" data-curve-type="Ellipse"/>`);
            ellipticalArcs += 1;
          }
        } else {
          throw new Error(`SVG export encountered an unsupported native curve: ${segment.curveType}`);
        }
      }
    }
    if (paths.length === 0 || paths.length > 100_000) throw new Error("SVG export requires between 1 and 100000 native curve segments");
    const min: [number, number] = [Infinity, Infinity];
    const max: [number, number] = [-Infinity, -Infinity];
    for (const [x, y] of points) {
      min[0] = Math.min(min[0], x);
      min[1] = Math.min(min[1], y);
      max[0] = Math.max(max[0], x);
      max[1] = Math.max(max[1], y);
    }
    const size: [number, number] = [max[0] - min[0], max[1] - min[1]];
    if (size[0] <= 0 || size[1] <= 0) throw new Error("SVG export requires nonzero width and height");
    const strokeWidthMm = 0.2;
    const paddingMm = strokeWidthMm / 2;
    const pageSizeMm: [number, number] = [size[0] + strokeWidthMm, size[1] + strokeWidthMm];
    const viewBox = [min[0] - paddingMm, min[1] - paddingMm, pageSizeMm[0], pageSizeMm[1]].map(formatSvgNumber).join(" ");
    const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${formatSvgNumber(pageSizeMm[0])}mm" height="${formatSvgNumber(pageSizeMm[1])}mm" viewBox="${viewBox}">\n<g fill="none" stroke="#000000" stroke-width="${formatSvgNumber(strokeWidthMm)}" stroke-linecap="round" stroke-linejoin="round">\n${paths.join("\n")}\n</g>\n</svg>\n`;
    if (Buffer.byteLength(svg) > 16 * 1024 * 1024) throw new Error("SVG export exceeds the 16 MiB output limit");
    await mkdir(dirname(output), { recursive: true });
    const staging = await mkdtemp(join(dirname(output), ".plasticity-svg-"));
    const temporary = join(staging, "geometry.svg");
    try {
      await writeFile(temporary, svg, { flag: "wx" });
      await copyFile(temporary, output, constants.COPYFILE_EXCL);
      return { path: output, bytes: Buffer.byteLength(svg), bodies: curves.length, lineSegments, circularSegments, fullCircles, fullEllipses, ellipticalArcs, cubicBezierSegments, approximatedSegments, maxChordDeviationMm, curveChordToleranceMm, curveChordAngleDegrees, sourceUnits: "millimeter", boundsMm: { min, max, size }, pageSizeMm };
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
      await rmdir(staging).catch(() => undefined);
    }
  }

  async exportHiddenLineSvg(
    ids: number[],
    outputPath: string,
    revision: string,
    curveChordToleranceMm = 0.05,
    curveChordAngleDegrees = 5,
    marginMm = 1,
  ): Promise<{
    path: string;
    bytes: number;
    bodies: number;
    segments: number;
    visibleSegments: number;
    hiddenSegments: number;
    sourceUnits: "millimeter";
    projection: "native-orthographic";
    projectedBoundsMm: { min: [number, number]; max: [number, number]; size: [number, number] };
    curveChordToleranceMm: number;
    curveChordAngleDegrees: number;
  }> {
    const before = await this.assertRevision(revision);
    requireHiddenLineBodies(before, ids);
    if (!Number.isFinite(curveChordToleranceMm) || curveChordToleranceMm <= 0 || curveChordToleranceMm > 5) {
      throw new Error("Hidden-line curve chord tolerance must be within (0, 5] mm");
    }
    if (!Number.isFinite(curveChordAngleDegrees) || curveChordAngleDegrees <= 0 || curveChordAngleDegrees > 30) {
      throw new Error("Hidden-line curve chord angle must be within (0, 30] degrees");
    }
    if (!Number.isFinite(marginMm) || marginMm < 0 || marginMm > 1_000) {
      throw new Error("Hidden-line SVG margin must be between 0 and 1000 mm");
    }
    const output = resolve(outputPath);
    if (extname(output).toLowerCase() !== ".svg") throw new Error("Hidden-line SVG output must end in .svg");
    await assertAbsent(output);

    const projection = await this.runtime.readNative<{
      positions: number[];
      segments: HiddenLineProjectionSegment[];
      scaleXmmPerPixel: number;
      scaleYmmPerPixel: number;
      cameraType: string;
    }>(`async function (Factory, Vector2, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const views = args.ids.map(wantedId => {
        for (const [versionId, item] of this.geo.geometryModel) {
          if (this.db.lookupStableId(versionId) !== wantedId) continue;
          if (item.view?.constructor?.name !== 'Solid') throw new Error('Hidden-line SVG export requires native Solid bodies: ' + wantedId);
          return item.view;
        }
        throw new Error('Unknown current Solid ID: ' + wantedId);
      });
      const factory = new Factory(this);
      try {
        factory.items = views;
        factory.includeBackgroundImage = false;
        factory.useMaterialColors = false;
        factory.curveChordTolerance = args.curveChordTolerance;
        factory.curveChordAngleDegrees = args.curveChordAngleDegrees;
        const bodyData = factory.collectBodyData();
        const viewport = Array.from(this.viewports)[0];
        if (!viewport?.camera) throw new Error('Plasticity viewport camera is unavailable');
        const camera = viewport.camera.clone();
        if (!camera.isOrthographicCamera) throw new Error('Native hidden-line SVG export requires an orthographic Plasticity view');
        camera.updateMatrixWorld(true);
        camera.updateProjectionMatrix();
        const horizontalSpan = camera.right - camera.left;
        const verticalSpan = camera.top - camera.bottom;
        if (!(horizontalSpan > 0) || !(verticalSpan > 0)) throw new Error('Plasticity orthographic camera has invalid bounds');
        const resolutionX = 2048;
        const resolutionY = Math.max(1, Math.round(resolutionX * verticalSpan / horizontalSpan));
        const resolution = new Vector2(resolutionX, resolutionY);
        const projected = await factory.generator.generate(camera, resolution, bodyData.bodyIds, factory, bodyData.transforms);
        if (!projected?.geo || !ArrayBuffer.isView(projected.geo) || !Array.isArray(projected.segments)) {
          throw new Error('Plasticity returned an invalid native hidden-line projection');
        }
        if (projected.geo.length > 600_000 || projected.segments.length > 100_000) {
          throw new Error('Native hidden-line projection exceeds the MCP output limit');
        }
        const matrix = camera.projectionMatrix.elements;
        const p00 = Math.abs(matrix[0]);
        const p11 = Math.abs(matrix[5]);
        if (!(p00 > 0) || !(p11 > 0)) throw new Error('Plasticity orthographic projection matrix is degenerate');
        return {
          positions: Array.from(projected.geo),
          segments: projected.segments.map(segment => ({
            bodyIndex: Number(segment.bodyIndex),
            category: String(segment.category),
            offset: Number(segment.offset),
            count: Number(segment.count),
          })),
          scaleXmmPerPixel: 2000 / (p00 * resolutionX),
          scaleYmmPerPixel: 2000 / (p11 * resolutionY),
          cameraType: camera.isOrthographicCamera ? 'OrthographicCamera' : camera.constructor.name,
        };
      } finally {
        factory.dispose?.();
      }
    }`, ["ExportHiddenLineFactory", "Vector2"], [{
      ids,
      curveChordTolerance: millimetersToMeters(curveChordToleranceMm),
      curveChordAngleDegrees,
    }], NATIVE_STATE_READ_TIMEOUT_MS);

    const after = await this.state();
    if (after.documentToken !== before.documentToken || after.revision !== before.revision) {
      throw new Error("Plasticity document changed while its hidden-line projection was being generated");
    }
    if (projection.cameraType !== "OrthographicCamera") throw new Error("Plasticity did not return an orthographic hidden-line projection");
    const svg = serializeHiddenLineSvg({
      positions: projection.positions,
      segments: projection.segments,
      scaleXmmPerPixel: projection.scaleXmmPerPixel,
      scaleYmmPerPixel: projection.scaleYmmPerPixel,
      marginMm,
    });
    const minimum: [number, number] = [Infinity, Infinity];
    const maximum: [number, number] = [-Infinity, -Infinity];
    for (const segment of projection.segments) {
      for (let point = 0; point < segment.count; point += 1) {
        const index = segment.offset + point * 2;
        const x = projection.positions[index]! * projection.scaleXmmPerPixel;
        const y = -projection.positions[index + 1]! * projection.scaleYmmPerPixel;
        minimum[0] = Math.min(minimum[0], x);
        minimum[1] = Math.min(minimum[1], y);
        maximum[0] = Math.max(maximum[0], x);
        maximum[1] = Math.max(maximum[1], y);
      }
    }
    const size: [number, number] = [maximum[0] - minimum[0], maximum[1] - minimum[1]];
    await mkdir(dirname(output), { recursive: true });
    const staging = await mkdtemp(join(dirname(output), ".plasticity-hidden-line-svg-"));
    const temporary = join(staging, "projection.svg");
    try {
      await writeFile(temporary, svg, { flag: "wx" });
      await copyFile(temporary, output, constants.COPYFILE_EXCL);
      return {
        path: output,
        bytes: Buffer.byteLength(svg),
        bodies: ids.length,
        segments: projection.segments.length,
        visibleSegments: projection.segments.filter(segment => !segment.category.includes("Hidden")).length,
        hiddenSegments: projection.segments.filter(segment => segment.category.includes("Hidden")).length,
        sourceUnits: "millimeter",
        projection: "native-orthographic",
        projectedBoundsMm: {
          min: [0, 0],
          max: size,
          size,
        },
        curveChordToleranceMm,
        curveChordAngleDegrees,
      };
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
      await rmdir(staging).catch(() => undefined);
    }
  }

  async importStep(inputPath: string, revision?: string): Promise<RuntimeState> {
    if (revision) await this.assertRevision(revision);
    const input = await realpath(resolve(inputPath));
    if (![".step", ".stp"].includes(extname(input).toLowerCase())) throw new Error("STEP input must end in .step or .stp");
    if (!(await stat(input)).isFile()) throw new Error("STEP input must be a regular file");
    await this.runtime.mutate(`async function (Factory, Command, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.filePath = args.path;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["ExchangeImportFactory", "ImportCommand"], [{ path: input }], LONG_NATIVE_IMPORT_TIMEOUT_MS);
    return await this.state(LONG_NATIVE_IMPORT_TIMEOUT_MS);
  }

  async importSvg(
    inputPath: string,
    sourceUnit: NativeImportUnit,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    const input = await realpath(resolve(inputPath));
    if (extname(input).toLowerCase() !== ".svg") throw new Error("SVG input must end in .svg");
    const metadata = await stat(input);
    if (!metadata.isFile()) throw new Error("SVG input must be a regular file");
    if (metadata.size === 0) throw new Error("SVG input must not be empty");
    await this.runtime.mutate(`async function (Factory, Command, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.filePath = args.path;
          factory.unit = args.sourceUnit;
          const result = await factory.commit();
          const created = Array.isArray(result) ? result : [result].filter(Boolean);
          if (created.length === 0 || !created.every(item => item?.constructor?.name === 'Wire')) {
            throw new Error('Plasticity did not create editable native Wires for the complete SVG import');
          }
          return result;
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["VectorImportFactory", "ImportCommand"], [{ path: input, sourceUnit }]);
    return await this.state();
  }

  async importReferenceMesh(
    inputPath: string,
    sourceUnit: ReferenceMeshUnit,
    revision: string,
  ): Promise<RuntimeState> {
    await this.assertRevision(revision);
    const input = await realpath(resolve(inputPath));
    const extension = extname(input).toLowerCase();
    if (extension !== ".stl" && extension !== ".obj") {
      throw new Error("Reference mesh input must end in .stl or .obj");
    }
    const metadata = await stat(input);
    if (!metadata.isFile()) throw new Error("Reference mesh input must be a regular file");
    if (metadata.size === 0) throw new Error("Reference mesh input must not be empty");
    await this.runtime.mutate(`async function (Factory, Command, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.filePath = args.path;
          factory.unit = args.sourceUnit;
          const result = await factory.commit();
          const created = Array.isArray(result) ? result : [result].filter(Boolean);
          if (created.length === 0 || !created.every(item => item?.constructor?.name === 'Empties_ObjectEmpty')) {
            throw new Error('Plasticity did not create reference mesh objects for the complete import');
          }
          return result;
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["MeshImportFactory", "ImportCommand"], [{ path: input, sourceUnit }]);
    return await this.state();
  }

  async importReference3mf(inputPath: string, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    const input = await realpath(resolve(inputPath));
    if (extname(input).toLowerCase() !== ".3mf") throw new Error("Reference mesh input must end in .3mf");
    const source = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await source.stat();
      if (!metadata.isFile()) throw new Error("Reference 3MF input must be a regular file");
      if (metadata.size === 0) throw new Error("Reference 3MF input must not be empty");
      if (metadata.size > MAX_REFERENCE_THREE_MF_ARCHIVE_BYTES) throw new Error(`Reference 3MF input exceeds ${MAX_REFERENCE_THREE_MF_ARCHIVE_BYTES} bytes`);
      const archive = Buffer.alloc(metadata.size);
      let position = 0;
      while (position < archive.length) {
        const { bytesRead } = await source.read(archive, position, archive.length - position, position);
        if (bytesRead === 0) throw new Error("Reference 3MF input changed while it was being read");
        position += bytesRead;
      }
      const overflow = Buffer.alloc(1);
      if ((await source.read(overflow, 0, 1, position)).bytesRead !== 0) throw new Error("Reference 3MF input grew beyond its validated size");
      validateReferenceThreeMfArchive(archive);
    } finally {
      await source.close();
    }
    await this.runtime.mutate(`async function (ImporterExporter, Command, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try { return await new ImporterExporter(editor).import3mf(args.path); }
        catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["ImporterExporter", "ImportCommand"], [{ path: input }], LONG_NATIVE_IMPORT_TIMEOUT_MS);
    return await this.state(LONG_NATIVE_IMPORT_TIMEOUT_MS);
  }

  async importParasolid(inputPath: string, revision?: string): Promise<RuntimeState> {
    if (revision) await this.assertRevision(revision);
    const input = await realpath(resolve(inputPath));
    const extension = extname(input).toLowerCase();
    if (extension !== ".x_t" && extension !== ".x_b") throw new Error("Parasolid input must end in .x_t or .x_b");
    await validateParasolidPath(input, "Parasolid input");
    await this.runtime.mutate(`async function (Factory, Command, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.filePath = args.path;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
    }`, ["ParasolidImportFactory", "ImportCommand"], [{ path: input }], LONG_NATIVE_IMPORT_TIMEOUT_MS);
    return await this.state(LONG_NATIVE_IMPORT_TIMEOUT_MS);
  }

  async saveCopy(outputPath: string): Promise<{ path: string; bytes: number }> {
    const output = resolve(outputPath);
    if (extname(output).toLowerCase() !== ".plasticity") throw new Error("Output must end in .plasticity");
    await assertAbsent(output);
    await mkdir(dirname(output), { recursive: true });
    const staging = await mkdtemp(join(dirname(output), ".plasticity-save-"));
    const temporary = join(staging, "document.plasticity");
    try {
      await this.runtime.mutate(`async function (path) { if (this.executor.isBusy) throw new Error('Plasticity is busy'); await this.saver.save(path); }`, [], [temporary]);
      const header = await readFile(temporary);
      if (header.length < 24 || header.subarray(0, 10).toString() !== "plasticity") throw new Error("Plasticity produced an invalid document");
      await copyFile(temporary, output, constants.COPYFILE_EXCL);
      return { path: output, bytes: header.length };
    } finally {
      if (!this.runtime.isUncertain()) {
        await rm(temporary, { force: true }).catch(() => undefined);
        await rmdir(staging).catch(() => undefined);
      }
    }
  }

  async openDocument(inputPath: string, backupPath: string, revision: string): Promise<RuntimeState> {
    await this.assertRevision(revision);
    const input = await realpath(resolve(inputPath));
    if (extname(input).toLowerCase() !== ".plasticity") throw new Error("Input must end in .plasticity");
    const header = await readFile(input);
    if (header.length < 24 || header.subarray(0, 10).toString() !== "plasticity") throw new Error("Input is not a valid Plasticity document");
    await this.saveCopy(backupPath);
    await this.runtime.mutate(`async function (Factory, Command, args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const editor = this;
      let failure;
      const command = new Command(this);
      command.remember = false;
      command.execute = async function () {
        try {
          const factory = new Factory(editor).resource(this);
          factory.filename = args.path;
          return await factory.commit();
        } catch (error) { failure = error; throw error; }
      };
      await this.exec(command);
      if (failure) throw failure;
      this.document.filename = args.path;
    }`, ["OpenFileFactory", "OpenFileCommand"], [{ path: input }]);
    return await this.state();
  }

  async screenshot(outputPath: string): Promise<{ path: string; bytes: number }> {
    const output = resolve(outputPath);
    if (extname(output).toLowerCase() !== ".png") throw new Error("Screenshot output must end in .png");
    await assertAbsent(output);
    await mkdir(dirname(output), { recursive: true });
    await this.runtime.cdp("Page.bringToFront");
    const hidden = await this.runtime.read<boolean>("function () { return document.hidden; }");
    if (hidden) throw new Error("Plasticity renderer is hidden; activate Plasticity and retry the screenshot");
    const frame = await this.runtime.captureScreenshot();
    const data = Buffer.from(frame, "base64");
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (data.length < 24 || !data.subarray(0, 8).equals(pngSignature) || data.toString("ascii", 12, 16) !== "IHDR" ||
      data.readUInt32BE(16) < 1 || data.readUInt32BE(20) < 1) {
      throw new Error("Plasticity returned an invalid PNG screencast frame");
    }
    await writeFile(output, data, { flag: "wx" });
    return { path: output, bytes: data.length };
  }

  async setView(view: "front" | "back" | "left" | "right" | "top" | "bottom" | "isometric", fit: boolean): Promise<unknown> {
    return await this.runtime.read(`async function (args) {
      if (this.executor.isBusy) throw new Error('Plasticity is busy');
      const viewport = Array.from(this.viewports)[0];
      if (!viewport) throw new Error('Plasticity viewport is unavailable');
      if (args.view === 'isometric') {
        const camera = viewport.camera.clone();
        camera.position.copy(viewport.camera.target).add(camera.position.clone().set(1, -1, 1));
        camera.lookAt(viewport.camera.target);
        viewport.orbitControls.setQuaternion(camera.quaternion);
      } else {
        await viewport.navigateToOrientation(({ front: 4, back: 1, left: 3, right: 0, top: 2, bottom: 5 })[args.view]);
      }
      if (args.fit) {
        const bounds = [...this.geo.geometryModel].map(([, item]) => item.model?.FindBox?.()).filter(Boolean);
        if (bounds.length) {
          const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
          for (const box of bounds) for (let i = 0; i < 3; i++) {
            min[i] = Math.min(min[i], [box.min.x, box.min.y, box.min.z][i]);
            max[i] = Math.max(max[i], [box.max.x, box.max.y, box.max.z][i]);
          }
          const center = viewport.camera.target.clone().fromArray(min.map((value, i) => (value + max[i]) / 2));
          const radius = Math.max(1e-6, Math.hypot(...max.map((value, i) => value - min[i])) / 2);
          const camera = viewport.camera;
          const controls = viewport.orbitControls;
          const halfVerticalFov = camera.perspective.fov * Math.PI / 360;
          const halfHorizontalFov = Math.atan(Math.tan(halfVerticalFov) * camera.aspect);
          const limitingFov = Math.min(halfVerticalFov, halfHorizontalFov);
          const distance = limitingFov > 0 ? radius / Math.sin(limitingFov) * 1.4 : radius * 3;
          controls.target.copy(center);
          controls.targetEnd.copy(center);
          controls.focalOffset.set(0, 0, 0);
          controls.focalOffsetEnd.set(0, 0, 0);
          controls.radius = controls.radiusEnd = distance;
          const width = camera.orthographic.right - camera.orthographic.left;
          const height = camera.orthographic.top - camera.orthographic.bottom;
          const zoom = Math.min(width, height) / (radius * 2 * 1.4);
          controls.zoom = controls.zoomEnd = zoom;
          camera.zoom = zoom;
          controls.setNeedsUpdate();
          controls.update(1 / 60);
          camera.updateProjectionMatrix();
        }
      }
      viewport.setNeedsRender();
      return { position: viewport.camera.position.toArray(), target: viewport.camera.target.toArray(), mode: viewport.camera.mode };
    }`, [{ view, fit }]);
  }

  private async assertCurveControlPointReferences(points: CurveControlPointReference[], revision: string): Promise<{
    documentToken: string;
    revision: string;
    curves: CurveControlPointDescriptor[];
  }> {
    await this.assertRevision(revision);
    if (points.length === 0) throw new Error("At least one curve control point is required");
    const keys = points.map((point) => `${point.bodyId}:${point.kind}:${point.pointId}`);
    if (new Set(keys).size !== keys.length) throw new Error("Curve control point references must be unique");
    const bodyIds = [...new Set(points.map((point) => point.bodyId))];
    const inventory = await this.listCurveControlPoints(bodyIds, revision);
    const available = new Set(inventory.curves.flatMap((curve) => [
      ...curve.boundaryVertices.map((point) => `${curve.id}:vertex:${point.reference.pointId}`),
      ...curve.interiorControlPoints.map((point) => `${curve.id}:control-point:${point.reference.pointId}`),
    ]));
    const missing = keys.filter((key) => !available.has(key));
    if (missing.length > 0) throw new Error(`Unknown current curve control point references: ${missing.join(", ")}`);
    return inventory;
  }

  private async assertRevision(expected: string): Promise<RuntimeState> {
    const current = await this.state();
    if (current.revision !== expected) throw new Error(`Stale reference: expected revision ${expected}, current revision is ${current.revision}`);
    return current;
  }
}

function toMeters(vector: Vector3): Vector3 {
  return vector.map(millimetersToMeters) as Vector3;
}

function requirePositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number`);
}

function threePointCircleGeometry(
  first: Vector3,
  second: Vector3,
  third: Vector3,
  label: string,
): { center: Vector3; normal: Vector3 } {
  const firstToSecond = subtract(second, first);
  const firstToThird = subtract(third, first);
  const firstSquared = dot(firstToSecond, firstToSecond);
  const secondSquared = dot(firstToThird, firstToThird);
  if (firstSquared <= 1e-18 || secondSquared <= 1e-18 || dot(subtract(third, second), subtract(third, second)) <= 1e-18) {
    throw new Error(`${label} points must be distinct`);
  }
  const planeVector = cross(firstToSecond, firstToThird);
  const planeSquared = dot(planeVector, planeVector);
  if (Math.sqrt(planeSquared) <= 1e-9) throw new Error(`${label} points are collinear or too close to collinear`);
  const centerOffset = scale(add(
    scale(cross(firstToThird, planeVector), firstSquared),
    scale(cross(planeVector, firstToSecond), secondSquared),
  ), 1 / (2 * planeSquared));
  const center = add(first, centerOffset);
  return {
    center,
    normal: normalize(planeVector, `${label} plane normal`),
  };
}

function requireResolution<T>(resolution: Resolution<T>): T {
  if (resolution.status === "resolved") return resolution.value;
  if (resolution.status === "ambiguous") throw new Error(`Geometry reference is ambiguous: ${resolution.matches} matches`);
  throw new Error(resolution.reason);
}

function summarizeFaceDraftSamples(
  entry: NativeFaceDraftSamples,
  pullDirection: Vector3,
  minimumDraftDeg: number,
): FaceDraftAnalysis {
  if (entry.samples.length === 0) throw new Error(`Native face draft samples are empty for ${entry.face.bodyId}:${entry.face.faceId}`);
  const classified = entry.samples.map((sample) => {
    if (sample.positionMm.length !== 3 || !sample.positionMm.every(Number.isFinite)) {
      throw new Error(`Native face draft position is invalid for ${entry.face.bodyId}:${entry.face.faceId}`);
    }
    const normal = normalize(sample.normal, "Native face draft normal");
    const signedDraftDeg = Math.asin(Math.max(-1, Math.min(1, dot(normal, pullDirection)))) * 180 / Math.PI;
    const classification: Exclude<FaceDraftClassification, "mixed"> = signedDraftDeg >= minimumDraftDeg
      ? "positive"
      : signedDraftDeg <= -minimumDraftDeg
        ? "negative"
        : "neutral";
    return { positionMm: sample.positionMm, normal, signedDraftDeg, classification };
  });
  let minimum = classified[0]!;
  let maximum = classified[0]!;
  let minimumAbsoluteDraftDeg = Math.abs(classified[0]!.signedDraftDeg);
  let maximumAbsoluteDraftDeg = minimumAbsoluteDraftDeg;
  const sampleCounts = { positive: 0, negative: 0, neutral: 0 };
  for (const sample of classified) {
    if (sample.signedDraftDeg < minimum.signedDraftDeg) minimum = sample;
    if (sample.signedDraftDeg > maximum.signedDraftDeg) maximum = sample;
    minimumAbsoluteDraftDeg = Math.min(minimumAbsoluteDraftDeg, Math.abs(sample.signedDraftDeg));
    maximumAbsoluteDraftDeg = Math.max(maximumAbsoluteDraftDeg, Math.abs(sample.signedDraftDeg));
    sampleCounts[sample.classification] += 1;
  }
  const occupied = (Object.keys(sampleCounts) as Array<keyof typeof sampleCounts>).filter((key) => sampleCounts[key] > 0);
  const classification: FaceDraftClassification = occupied.length === 1 ? occupied[0]! : "mixed";
  return {
    face: entry.face,
    bodyVersionId: entry.bodyVersionId,
    surfaceType: entry.surfaceType,
    measurementSource: "native-brep-face-normal-grid",
    classification,
    sampleCount: classified.length,
    sampleCounts,
    minimumSignedDraft: { valueDeg: minimum.signedDraftDeg, positionMm: minimum.positionMm, normal: minimum.normal },
    maximumSignedDraft: { valueDeg: maximum.signedDraftDeg, positionMm: maximum.positionMm, normal: maximum.normal },
    minimumAbsoluteDraftDeg,
    maximumAbsoluteDraftDeg,
  };
}

function leastParallelWorldAxis(normal: Vector3): Vector3 {
  const axes: Vector3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  return axes.reduce((best, candidate) => Math.abs(dot(candidate, normal)) < Math.abs(dot(best, normal)) ? candidate : best);
}

function requireVertexReference(state: RuntimeState, reference: VertexReference, name: string): void {
  const body = state.bodies.find((candidate) => candidate.id === reference.bodyId);
  if (!body?.vertices?.some((vertex) => vertex.id === reference.vertexId)) {
    throw new Error(`${name} must reference a current native B-Rep vertex`);
  }
}

function requireInstanceIds(state: RuntimeState, ids: number[]): void {
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error("Instance IDs must be a nonempty unique list");
  }
  const current = new Set((state.instances ?? []).map((instance) => instance.id));
  const missing = ids.filter((id) => !current.has(id));
  if (missing.length > 0) throw new Error(`Unknown current native instance IDs: ${missing.join(", ")}`);
}

function requireReferenceMeshIds(state: RuntimeState, ids: number[]): void {
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error("Reference mesh IDs must be a nonempty unique list");
  }
  const current = new Set((state.referenceMeshes ?? []).map((mesh) => mesh.id));
  const missing = ids.filter((id) => !current.has(id));
  if (missing.length > 0) throw new Error(`Unknown current reference mesh IDs: ${missing.join(", ")}`);
}

function requireGroupIds(state: RuntimeState, ids: number[], allowRoot: boolean): void {
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error("Group IDs must be a nonempty unique list");
  }
  if (!allowRoot && ids.includes(0)) throw new Error("The root Scene group is protected");
  const current = new Set((state.groups ?? []).map((group) => group.id));
  const missing = ids.filter((id) => !current.has(id));
  if (missing.length > 0) throw new Error(`Unknown current group IDs: ${missing.join(", ")}`);
}

function requireGroupSelection(
  state: RuntimeState,
  bodyIds: number[],
  instanceIds: number[],
  referenceMeshIds: number[],
  groupIds: number[],
  allowRoot = false,
): void {
  if (bodyIds.length + instanceIds.length + referenceMeshIds.length + groupIds.length === 0) {
    throw new Error("A group operation requires at least one body, instance, reference mesh, or group ID");
  }
  if (new Set(bodyIds).size !== bodyIds.length) throw new Error("Body IDs must be unique");
  if (new Set(instanceIds).size !== instanceIds.length) throw new Error("Instance IDs must be unique");
  if (new Set(referenceMeshIds).size !== referenceMeshIds.length) throw new Error("Reference mesh IDs must be unique");
  if (new Set(groupIds).size !== groupIds.length) throw new Error("Group IDs must be unique");
  const currentBodies = new Set(state.bodies.map((body) => body.id));
  const missingBodies = bodyIds.filter((id) => !currentBodies.has(id));
  if (missingBodies.length > 0) throw new Error(`Unknown current body IDs: ${missingBodies.join(", ")}`);
  if (instanceIds.length > 0) requireInstanceIds(state, instanceIds);
  if (referenceMeshIds.length > 0) requireReferenceMeshIds(state, referenceMeshIds);
  if (groupIds.length > 0) requireGroupIds(state, groupIds, allowRoot);
}

function requireMeshExportBodies(state: RuntimeState, ids: number[], format = "3MF"): void {
  if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error(`${format} body IDs must be a nonempty unique list`);
  const bodies = new Map(state.bodies.map((body) => [body.id, body]));
  const missing = ids.filter((id) => !bodies.has(id));
  if (missing.length > 0) throw new Error(`Unknown current body IDs: ${missing.join(", ")}`);
  const invalid = ids.filter((id) => {
    const type = bodies.get(id)!.type;
    return type !== "Solid" && type !== "Sheet";
  });
  if (invalid.length > 0) throw new Error(`${format} export requires current Solid or Sheet bodies: ${invalid.join(", ")}`);
}

function formatSvgNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("SVG coordinates must be finite");
  const rounded = Number(value.toFixed(12));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function escapeSvgAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", "&apos;");
}

function requireWireBodyIds(state: RuntimeState, ids: number[]): void {
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error("Wire IDs must be a nonempty unique list");
  }
  const bodies = new Map(state.bodies.map((body) => [body.id, body]));
  const missing = ids.filter((id) => !bodies.has(id));
  if (missing.length > 0) throw new Error(`Unknown current Wire ID: ${missing.join(", ")}`);
  const invalid = ids.filter((id) => bodies.get(id)!.type !== "Wire");
  if (invalid.length > 0) throw new Error(`Curve selection accepts current Wire IDs only: ${invalid.join(", ")}`);
}

function requireHiddenLineBodies(state: RuntimeState, ids: number[]): void {
  if (ids.length === 0 || ids.length > 128 || new Set(ids).size !== ids.length) {
    throw new Error("Hidden-line body IDs must be a nonempty unique list of at most 128 bodies");
  }
  const bodies = new Map(state.bodies.map((body) => [body.id, body]));
  const missing = ids.filter((id) => !bodies.has(id));
  if (missing.length > 0) throw new Error(`Unknown current body IDs: ${missing.join(", ")}`);
  const invalid = ids.filter((id) => bodies.get(id)!.type !== "Solid");
  if (invalid.length > 0) throw new Error(`Hidden-line export requires current native Solid bodies: ${invalid.join(", ")}`);
}

function requireCadExportBodies(state: RuntimeState, ids: number[], format: string): void {
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error(`${format} body IDs must be a nonempty unique list`);
  }
  const current = new Set(state.bodies.map((body) => body.id));
  const missing = ids.filter((id) => !current.has(id));
  if (missing.length > 0) throw new Error(`Unknown current body IDs: ${missing.join(", ")}`);
}

async function validateParasolidPath(path: string, label: string): Promise<number> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const file = await handle.stat();
    if (!file.isFile()) throw new Error(`${label} must be a regular file`);
    const bytes = Buffer.alloc(Math.min(file.size, 512));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const header = bytes.subarray(0, bytesRead).toString("latin1");
    if (file.size < 96 || !header.startsWith("**") || !header.includes("PARASOLID")) {
      throw new Error("Plasticity produced or received an invalid Parasolid file");
    }
    return file.size;
  } finally {
    await handle.close();
  }
}

function groupContains(state: RuntimeState, ancestorId: number, candidateId: number): boolean {
  const groups = new Map((state.groups ?? []).map((group) => [group.id, group]));
  const pending = [...(groups.get(ancestorId)?.childGroupIds ?? [])];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === candidateId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(groups.get(current)?.childGroupIds ?? []));
  }
  return false;
}

function requireTopologySelection(
  state: RuntimeState,
  references: FaceReference[] | EdgeReference[],
  kind: "face" | "edge",
): void {
  if (references.length === 0) throw new Error(`At least one ${kind} reference is required`);
  const keys = references.map((reference) => `${reference.bodyId}:${kind === "face" ? (reference as FaceReference).faceId : (reference as EdgeReference).edgeId}`);
  if (new Set(keys).size !== keys.length) throw new Error(`${kind === "face" ? "Face" : "Edge"} references must be unique`);
  const missing = references.filter((reference) => {
    const body = state.bodies.find((candidate) => candidate.id === reference.bodyId);
    const id = kind === "face" ? (reference as FaceReference).faceId : (reference as EdgeReference).edgeId;
    return !body || !(kind === "face" ? body.faceIds : body.edgeIds).includes(id);
  });
  if (missing.length > 0) throw new Error(`Unknown current ${kind} references: ${missing.map((reference) => reference.bodyId).join(", ")}`);
}

function requireSingleTopologyBody(references: FaceReference[] | EdgeReference[], label: string): void {
  if (new Set(references.map((reference) => reference.bodyId)).size !== 1) {
    throw new Error(`${label} must belong to one body`);
  }
}

function assertRefreshIdentity(
  record: DatumReference,
  supplied: ReferenceIdentity,
  sessionId: string,
  documentToken: string,
): void {
  if (supplied.sessionId !== sessionId || record.sessionId !== supplied.sessionId) {
    throw new Error("Datum reference belongs to another MCP session");
  }
  if (supplied.documentToken !== documentToken || record.documentToken !== supplied.documentToken) {
    throw new Error("Datum reference belongs to another Plasticity document");
  }
  if (record.id !== supplied.id || record.revision !== supplied.revision) {
    throw new Error(`Stale datum reference identity: ${supplied.id}`);
  }
}

function nearlyParallel(left: Vector3, right: Vector3): boolean {
  const leftLength = Math.hypot(...left);
  const rightLength = Math.hypot(...right);
  const cosine = Math.abs(left.reduce((sum, value, index) => sum + value * right[index]!, 0) / (leftLength * rightLength));
  return cosine > 0.999_999;
}

function vectorsNear(left: Vector3, right: Vector3, tolerance = 1e-12): boolean {
  return left.every((value, index) => Math.abs(value - right[index]!) <= tolerance);
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Refusing to overwrite existing file: ${path}`);
}

function validateBinaryStl(data: Buffer): number {
  if (data.length < 84) throw new Error("Plasticity produced an invalid binary STL file");
  const triangles = data.readUInt32LE(80);
  if (data.length !== 84 + triangles * 50) throw new Error("Plasticity produced a truncated or malformed binary STL file");
  return triangles;
}
