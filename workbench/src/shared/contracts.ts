export type Id = string;
export type Sha256 = string;
export type IsoTimestamp = string;
export type Vector3Mm = [number, number, number];

export type MeasurementSource =
  | "native-brep"
  | "display-mesh"
  | "reference-document"
  | "user"
  | "assumption";

export type Confidence =
  | "verified"
  | "probable"
  | "approximate"
  | "assumed"
  | "measurement-required";

export type ReviewStatus = "verified" | "needs-review" | "assumed" | "invalid";

export interface Project {
  id: Id;
  name: string;
  workspacePath: string;
  revision: number;
  codexThreadId?: string | undefined;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export type PairingRole = "view" | "annotate" | "edit";
export type PairingGrantKind = "link" | "session";

export interface PairingGrant {
  id: string;
  projectId: Id;
  role: PairingRole;
  kind: PairingGrantKind;
  expiresAt: IsoTimestamp;
  createdAt: IsoTimestamp;
}

export interface Artifact {
  hash: Sha256;
  bytes: number;
  mediaType: string;
  originalName: string;
  createdAt: IsoTimestamp;
}

export interface GeometryRef {
  bodyId: number;
  faceId?: string | undefined;
  edgeId?: string | undefined;
}

export interface Measurement {
  key: string;
  label: string;
  value: number;
  actual?: number | undefined;
  tolerance?: number | undefined;
  unit: "mm" | "deg" | "count" | "%";
  source: MeasurementSource;
  confidence: Confidence;
  status: ReviewStatus;
  linkedEntities?: GeometryRef[] | undefined;
  input?: {
    min?: number | undefined;
    max?: number | undefined;
    step?: number | undefined;
  } | undefined;
}

export interface ModelBodyMapping {
  bodyId: number;
  name?: string | undefined;
  meshIndex?: number | undefined;
  faceIds?: string[] | undefined;
}

export interface ModelVersionInput {
  plasticityDocumentToken: string;
  plasticityRevision: string;
  stepArtifactHash: Sha256;
  screenshotArtifactHashes?: Sha256[] | undefined;
  measurements: Measurement[];
  bodyMappings?: ModelBodyMapping[] | undefined;
}

export interface ModelVersion extends ModelVersionInput {
  id: Id;
  projectId: Id;
  number: number;
  createdAt: IsoTimestamp;
}

export interface DimensionRow extends Measurement {}

export interface RequirementRow {
  key: string;
  label: string;
  value: string;
  status: ReviewStatus;
  linkedEntities?: GeometryRef[] | undefined;
}

export interface AssumptionRow {
  key: string;
  label: string;
  value: string;
  confidence: Confidence;
  status: ReviewStatus;
  linkedEntities?: GeometryRef[] | undefined;
}

export interface SourceRow {
  key: string;
  label: string;
  url?: string | undefined;
  artifactHash?: Sha256 | undefined;
  confidence: Confidence;
  status: ReviewStatus;
}

export interface ValidationRow {
  key: string;
  label: string;
  severity: "info" | "warning" | "error";
  status: "pass" | "fail" | "unknown";
  message: string;
  linkedEntities?: GeometryRef[] | undefined;
}

export interface ComparisonRow {
  key: string;
  label: string;
  before?: string | number | undefined;
  after?: string | number | undefined;
  unit?: "mm" | "deg" | "count" | "%" | undefined;
  status: "added" | "removed" | "changed" | "unchanged";
  linkedEntities?: GeometryRef[] | undefined;
}

export type StructuredBlockInput =
  | { type: "dimensions"; title: string; rows: DimensionRow[] }
  | { type: "requirements"; title: string; rows: RequirementRow[] }
  | { type: "assumptions"; title: string; rows: AssumptionRow[] }
  | { type: "sources"; title: string; rows: SourceRow[] }
  | { type: "validation"; title: string; rows: ValidationRow[] }
  | { type: "comparison"; title: string; rows: ComparisonRow[] };

export type StructuredBlock = StructuredBlockInput & {
  id: Id;
  projectId: Id;
  createdAt: IsoTimestamp;
};

export interface CameraSnapshot {
  id: Id;
  projection: "perspective" | "orthographic";
  positionMm: Vector3Mm;
  targetMm: Vector3Mm;
  up: [number, number, number];
  viewMatrix: number[];
  projectionMatrix: number[];
  viewport: [number, number];
}

export type AnnotationAnchor =
  | { kind: "world"; pointMm: Vector3Mm }
  | { kind: "body"; bodyId: number; pointMm: Vector3Mm }
  | { kind: "face"; bodyId: number; faceId: string; pointMm: Vector3Mm }
  | { kind: "edge"; bodyId: number; edgeId: string; pointMm: Vector3Mm }
  | { kind: "screen"; cameraId: string; point: [number, number] };

export interface InkPoint {
  point: [number, number];
  pressure: number;
  tilt: [number, number];
  timestampMs: number;
}

export interface AnnotationInput {
  kind: "pen" | "highlighter" | "arrow" | "marker" | "note" | "dimension";
  text?: string | undefined;
  anchor: AnnotationAnchor;
  camera?: CameraSnapshot | undefined;
  stroke?: InkPoint[] | undefined;
}

export interface AnnotationBatchInput {
  expectedRevision: number;
  modelVersionId: Id;
  annotations: AnnotationInput[];
}

export interface Annotation extends AnnotationInput {
  id: Id;
  projectId: Id;
  modelVersionId: Id;
  remapStatus: "exact" | "required" | "unmapped";
  createdAt: IsoTimestamp;
}

export interface DimensionChangeBatchInput {
  expectedRevision: number;
  blockId: Id;
  changes: Array<{ key: string; value: number }>;
}

export interface DimensionChangeBatch extends DimensionChangeBatchInput {
  id: Id;
  projectId: Id;
  createdAt: IsoTimestamp;
}

export type ReferenceSourceKind =
  | "official-manufacturer-cad"
  | "official-documentation"
  | "official-distributor-cad"
  | "established-cad-library"
  | "verified-community-cad"
  | "functional-envelope"
  | "scaled-image";

export type ReferenceFormat = "step" | "parasolid" | "iges" | "drawing-pdf" | "stl" | "obj" | "image" | "other";

export interface ReferenceDimension {
  key: string;
  label: string;
  value?: number | undefined;
  unit: "mm" | "deg" | "count";
  confidence: Confidence;
  critical: boolean;
  sourceLocator?: string | undefined;
  note?: string | undefined;
}

export interface ReferenceInput {
  label: string;
  sourceKind: ReferenceSourceKind;
  format: ReferenceFormat;
  sourceUrl?: string | undefined;
  artifactHash?: Sha256 | undefined;
  license?: string | undefined;
  overallConfidence: Confidence;
  dimensions: ReferenceDimension[];
  sceneRole: "locked-reference" | "functional-envelope";
  bodyIds?: number[] | undefined;
}

export interface ReferenceRecord extends ReferenceInput {
  id: Id;
  projectId: Id;
  retrievedAt: IsoTimestamp;
  createdAt: IsoTimestamp;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ConstructionJournalEntry {
  id: Id;
  operation: string;
  intent: string | null;
  input: JsonValue;
  documentToken: string;
  beforeRevision: string;
  afterDocumentToken: string | null;
  afterRevision: string | null;
  status: "completed" | "failed" | "unknown";
  diff: JsonValue | null;
  error: string | null;
  occurredAt: IsoTimestamp;
}

export interface ConstructionJournalInput {
  documentToken: string;
  revision: string;
  syncStatus: "empty" | "in-sync" | "manual-edit-detected" | "document-changed";
  entries: ConstructionJournalEntry[];
}

export interface ConstructionJournalRecord extends ConstructionJournalInput {
  id: Id;
  projectId: Id;
  createdAt: IsoTimestamp;
}

export interface PrinterProfile {
  id: Id;
  vendor: string;
  model: string;
  buildVolumeMm: Vector3Mm;
  buildOriginMm?: Vector3Mm | undefined;
  nozzleDiameterMm: number;
  nozzleMaterial?: string | undefined;
  connection?: {
    kind: "moonraker" | "bambu-lan" | "manual";
    host?: string | undefined;
    port?: number | undefined;
  } | undefined;
  source: "installed-slicer" | "user" | "verified-device";
}

export interface MaterialProfile {
  id: Id;
  name: string;
  type: string;
  vendor: string;
  nozzleTemperatureC: number;
  bedTemperatureC: number;
  densityGcm3?: number | undefined;
  maxVolumetricSpeedMm3s?: number | undefined;
  color?: string | undefined;
  jointClearanceMm?: number | undefined;
  source: "installed-slicer" | "user";
}

export interface SlicerProfile {
  id: Id;
  slicer: "creality-print" | "orca-slicer" | "bambu-studio";
  name: string;
  layerHeightMm: number;
  nominalInfillPercent?: number | undefined;
  sparseInfillPattern?: string | undefined;
  wallLoops?: number | undefined;
  topShellLayers?: number | undefined;
  bottomShellLayers?: number | undefined;
  qualityTarget?: "draft" | "standard" | "fine" | "strong" | "custom" | undefined;
  supportsEnabled?: boolean | undefined;
  dimensionalScalePercent?: number | undefined;
  holeCompensationMm?: number | undefined;
  machineConfigPath: string;
  processConfigPath: string;
  filamentConfigPath: string;
  source: "installed-slicer" | "user";
}

export interface ManufacturingProfile {
  printer: PrinterProfile;
  material: MaterialProfile;
  slicer: SlicerProfile;
  functionalIntent?: "prototype" | "visual" | "functional" | "load-bearing" | "heat-resistant" | undefined;
  expectedLoadN?: number | undefined;
}

export interface ManufacturingProfileRegistrationInput {
  profile: ManufacturingProfile;
  verification: "official" | "imported" | "user-verified" | "draft";
  sourceUrl?: string | undefined;
  notes?: string | undefined;
}

export type ManufacturingProfileRegistrationRequest = ManufacturingProfileRegistrationInput | {
  discoveredProfile: { printerId: string; materialId: string; slicerId: string };
  verification: "official" | "imported" | "user-verified" | "draft";
  sourceUrl?: string | undefined;
  notes?: string | undefined;
};

export interface ManufacturingProfileRecord extends ManufacturingProfileRegistrationInput {
  id: Id;
  /** Stable hash of the profile metadata and immutable printer/process/filament configs. */
  profileHash: Sha256;
  configHashes: {
    machine: Sha256;
    process: Sha256;
    filament: Sha256;
  };
  createdAt: IsoTimestamp;
}

export type SplitJointKind = "flat" | "alignment-pins" | "tongue-and-groove" | "dovetail" | "screws-and-inserts";
export type DfmAxis = "x" | "y" | "z";

export interface DfmProtectedZone {
  id: string;
  sourceId: string;
  basis: "strength-report" | "user-marked";
  axis: DfmAxis;
  minMm: number;
  maxMm: number;
}

export interface DfmCutOffsets {
  axis: DfmAxis;
  offsetsMm: number[];
}

export interface DfmInput {
  sizeMm: Vector3Mm;
  minimumWallMm?: number | undefined;
  minimumHoleDiameterMm?: number | undefined;
  maximumOverhangDeg?: number | undefined;
  split?: {
    bedMarginMm?: number | undefined;
    joint?: SplitJointKind | undefined;
    clearanceMm?: number | undefined;
    /** Coordinates are measured from the minimum bound after the returned orientation is applied. */
    protectedZones?: DfmProtectedZone[] | undefined;
    /** Full explicit cut set in the oriented local bounds; each axis needs segmentCount - 1 offsets. */
    cutOffsetsMm?: DfmCutOffsets[] | undefined;
  } | undefined;
}

export interface ManufacturingAssessmentRequest {
  dfm: DfmInput;
  profile?: ManufacturingProfile | undefined;
  profileHash?: Sha256 | undefined;
}

export interface DfmFinding {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  measured?: number | undefined;
  limit?: number | undefined;
  unit?: "mm" | "deg" | undefined;
}

export interface DfmReport {
  printable: boolean;
  orientation: { rotationDeg: Vector3Mm; sizeMm: Vector3Mm; score: number };
  needsSplit: boolean;
  profileCompensation: {
    dimensionalScalePercent: number;
    holeCompensationMm: number;
    jointClearanceMm: number | null;
    supportsEnabled: boolean | null;
  };
  splitPlan?: {
    orientedSizeMm: Vector3Mm;
    usableBuildVolumeMm: Vector3Mm;
    segmentCounts: [number, number, number];
    cutOffsetsMm: Array<{ axis: "x" | "y" | "z"; offsetsMm: number[] }>;
    segmentSizeMm: Vector3Mm;
    maximumSegmentSizeMm: Vector3Mm;
    partCount: number;
    joint: SplitJointKind | null;
    clearanceMm: number | null;
    jointOptions: SplitJointKind[];
    cutOffsetsSource: "balanced" | "explicit";
    protectedZones: DfmProtectedZone[];
    cutConflicts: Array<{ zoneId: string; sourceId: string; axis: DfmAxis; cutOffsetMm: number; zoneMinMm: number; zoneMaxMm: number }>;
  } | undefined;
  findings: DfmFinding[];
}

export interface SliceJobRequest {
  expectedRevision: number;
  sourceArtifactHash: Sha256;
  profile?: ManufacturingProfile | undefined;
  profileHash?: Sha256 | undefined;
  dfm: DfmInput;
}

export interface SlicePartsBatchRequest {
  expectedRevision: number;
  profile?: ManufacturingProfile | undefined;
  profileHash?: Sha256 | undefined;
  parts: Array<{
    label: string;
    sourceArtifactHash: Sha256;
    dfm: DfmInput;
  }>;
}

export interface SlicePartsBatchResult {
  status: "completed" | "partial";
  items: Array<{
    label: string;
    sourceArtifactHash: Sha256;
    job?: SliceJob | undefined;
    failure?: string | undefined;
  }>;
}

export interface SliceSummary {
  layers?: number | undefined;
  /** First actual extrusion Z for each marked layer, in the slicer's build-frame coordinates. */
  depositionLayerZMm?: number[] | undefined;
  /** XY path orientation tensor summaries computed from deposited linear moves and supported circular arcs; layerIndex is 1-based. */
  depositionLayerPathOrientations?: DepositionLayerPathOrientation[] | undefined;
  estimatedSeconds?: number | undefined;
  filamentLengthMm?: number | undefined;
  filamentMassG?: number | undefined;
  boundsMm?: { min: Vector3Mm; max: Vector3Mm } | undefined;
  boundsSource?: "slicer-header" | "slicer-object-metadata" | "extrusion-path-estimate" | undefined;
  toolpathBoundsMm?: { min: Vector3Mm; max: Vector3Mm } | undefined;
}

export interface DepositionLayerPathOrientation {
  layerIndex: number;
  planarPathLengthMm: number;
  /** Major eigenvector of the length-weighted 2D orientation tensor, modulo 180 degrees. Null means no dominant axis. */
  principalDirectionDeg: number | null;
  /** Eigenvalue gap divided by trace: 0 is directionally balanced, 1 is unidirectional. */
  directionalConcentration: number | null;
  curvedExtrusionMoves: number;
  coverage: "complete-linear" | "complete-planar" | "partial-curved" | "no-planar-extrusion";
}

export interface SliceInterfaceLayerHeights {
  jobId: Id;
  profileHash?: Sha256 | undefined;
  sourceArtifactHash: Sha256;
  gcodeArtifactHash: Sha256;
  layerCount: number;
  coordinateFrame: "slicer-build";
  firstDepositionLayerZMm: number;
  interfaces: Array<{
    interfaceLayerIndex: number;
    depositionLayerZMm: number;
    relativeOffsetMm: number;
    depositionPathOrientation?: DepositionLayerPathOrientation | undefined;
  }>;
}

export interface SliceLayerPathOrientations {
  jobId: Id;
  profileHash?: Sha256 | undefined;
  sourceArtifactHash: Sha256;
  gcodeArtifactHash: Sha256;
  layerCount: number;
  coordinateFrame: "slicer-build";
  layers: Array<{
    layerIndex: number;
    depositionLayerZMm: number;
    pathOrientation: DepositionLayerPathOrientation;
  }>;
}

export type SliceJobState = "slicing" | "ready" | "failed" | "approved" | "submitting" | "submitted" | "unknown";

export interface SliceJob {
  id: Id;
  projectId: Id;
  projectRevision: number;
  sourceArtifactHash: Sha256;
  gcodeArtifactHash?: Sha256 | undefined;
  profileHash?: Sha256 | undefined;
  profile: ManufacturingProfile;
  dfmReport: DfmReport;
  summary?: SliceSummary | undefined;
  state: SliceJobState;
  failure?: string | undefined;
  approvedAt?: IsoTimestamp | undefined;
  submittedAt?: IsoTimestamp | undefined;
  remoteFilename?: string | undefined;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface PrinterStatus {
  identity: { vendor: string; model: string; hostname?: string | undefined; host: string };
  connected: boolean;
  state: string;
  stateMessage?: string | undefined;
  observedAt: IsoTimestamp;
}

export interface PrinterSubmissionObservation {
  outcome: "submitted" | "stored" | "absent" | "unknown";
  expectedRemoteFilename: string;
  observedActiveFilename?: string | undefined;
  printerState?: string | undefined;
  message: string;
  observedAt: IsoTimestamp;
}

export interface PrintSubmissionReconciliation {
  job: SliceJob;
  observation: PrinterSubmissionObservation;
}

export type WorkbenchEventPayload =
  | { type: "project.updated"; project: Project }
  | { type: "model-version.published"; version: ModelVersion }
  | { type: "structured-block.published"; block: StructuredBlock }
  | { type: "annotations.submitted"; annotations: Annotation[] }
  | { type: "dimension-changes.submitted"; batch: DimensionChangeBatch }
  | { type: "reference.registered"; reference: ReferenceRecord }
  | { type: "construction-journal.published"; journal: ConstructionJournalRecord }
  | { type: "manufacturing.job-updated"; job: SliceJob }
  | { type: "codex.event"; event: Record<string, unknown> }
  | { type: "status.published"; status: string };

export interface WorkbenchEvent {
  sequence: number;
  projectId: Id;
  occurredAt: IsoTimestamp;
  payload: WorkbenchEventPayload;
}
