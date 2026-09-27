export const MAX_ANALYSIS_IMAGES = 4;

export const CODEX_ERROR_CATEGORIES = [
  "contextWindowExceeded", "sessionBudgetExceeded", "usageLimitExceeded", "rateLimitExceeded",
  "serverOverloaded", "cyberPolicy", "misalignmentPolicyViolation", "internalServerError",
  "unauthorized", "badRequest", "threadRollbackFailed", "sandboxError", "other",
  "httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected",
  "responseTooManyFailedAttempts", "activeTurnNotSteerable",
] as const;

export type CodexErrorCategory = (typeof CODEX_ERROR_CATEGORIES)[number];

export interface AnalysisFailureDiagnostics {
  category?: CodexErrorCategory;
  httpStatusCode?: number;
  message?: string;
}

export type RectangularMethodId =
  | "axial-rectangle-v1"
  | "cantilever-tip-rectangle-v1"
  | "simply-supported-plate-uniform-pressure-v1"
  | "euler-column-buckling-v1";
export type SectionMethodId = "planar-section-resultants-v1";
export type FastenerMethodId = "single-fastener-plate-v1";
export type FastenerMemberMethodId = "fastener-member-v1";
export type InsertRetentionMethodId = "heat-set-insert-retention-v1";
export type FastenerGroupMethodId = "fastener-group-elastic-in-plane-v1";
export type ThreadedReceiverMethodId = "threaded-receiver-axial-v1";
export type TongueRootMethodId = "tongue-root-transverse-v1";
export type MethodId = RectangularMethodId | SectionMethodId | FastenerMethodId | FastenerMemberMethodId | InsertRetentionMethodId | FastenerGroupMethodId | ThreadedReceiverMethodId | TongueRootMethodId;
export type Outcome = "needs-input" | "unsupported" | "conditional" | "pass" | "fail";
export type EvidenceStatus = "measured" | "sourced" | "derived" | "assumed" | "unknown";
export type EvidenceUnit = "mm" | "mm2" | "mm4" | "N" | "Nmm" | "kg" | "MPa" | "deg" | "C" | "ratio" | "m/s2";

export interface Evidence {
  id: string;
  label: string;
  status: EvidenceStatus;
  sourceImageIndices?: number[];
  unit?: EvidenceUnit;
  value?: number;
  range?: [number, number];
  sourceUrl?: string;
  sourceHash?: string;
  sourceLocator?: string;
  dependsOn: string[];
  derivation?: string;
}

export interface Material {
  id: string;
  name: string;
  evidenceIds: string[];
  youngMPa?: number;
  tensileLimitMPa?: number;
  compressiveLimitMPa?: number;
  elasticLimitMPa?: number;
  shearLimitMPa?: number;
  bearingLimitMPa?: number;
  couponRecordId?: string;
  allowablesBasis?: string;
  suitability: "matched" | "unconfirmed" | "mismatch";
  manufacturing: {
    printerId: string;
    profileHash: string;
    orientationDeg: [number, number, number];
    infillPercent: number;
    temperatureC: number;
    effectiveSection: "solid" | "validated-effective" | "unknown";
  };
}

export interface CadBinding {
  sessionId: string;
  documentToken: string;
  revision: string;
  bodyId: number;
}

export interface StrengthInput {
  goal: string;
  method: RectangularMethodId;
  lengthMm?: number;
  widthMm?: number;
  heightMm?: number;
  forceN?: number;
  effectiveLengthFactor?: number;
  pressureMPa?: number;
  poissonRatio?: number;
  material: Material;
  safetyFactor?: number;
  maxDisplacementMm?: number;
  evidence: Evidence[];
  assignments: Record<string, string>;
  assumptions: { code: string; confirmed: boolean; evidenceIds: string[] }[];
  binding?: CadBinding;
}

export interface Calculation {
  status: Outcome;
  method: MethodId;
  methodVersion: string;
  inputHash: string;
  checkedScope: string;
  stressMPa?: number;
  displacementMm?: number;
  strengthUtilization?: number;
  displacementUtilization?: number;
  plate?: {
    flexuralRigidityNmm: number;
    centerMomentsN: { x: number; y: number };
    centerSurfaceStressMPa: { x: number; y: number };
    seriesMaxOddIndex: number;
  };
  buckling?: {
    areaMm2: number;
    secondMomentMm4: number;
    radiusOfGyrationMm: number;
    effectiveLengthMm: number;
    slendernessRatio: number;
    elasticTransitionSlenderness: number;
    criticalLoadN: number;
    criticalStressMPa: number;
    appliedCompressiveStressMPa: number;
    bucklingUtilization: number;
    compressiveUtilization: number;
  };
  issues: { code: string; message: string; evidenceIds: string[] }[];
  unchecked: string[];
}

export interface AnalysisRequest {
  requestId: string;
  prompt: string;
  imagePaths: string[];
  evidence: Evidence[];
  answers: { questionId: string; question: string; answer: string }[];
  context?: StrengthInput;
  analysisMode?: "strength" | "design-reference";
}

export interface DesignInterpretation {
  articleType: string;
  functionalIntent: string;
  scaleStatus: "dimensioned" | "calibrated" | "unscaled" | "unknown";
  interfaces: {
    id: string;
    kind: "mounting" | "contact" | "support" | "connector-access" | "moving-envelope" | "fastener" | "other" | "unknown";
    description: string;
    confidence: "clear" | "probable" | "ambiguous";
    evidenceIds: string[];
  }[];
  featureCandidates: {
    id: string;
    type: "solid" | "sheet" | "hole" | "slot" | "rib" | "boss" | "fillet" | "chamfer" | "connector-opening" | "keepout" | "other" | "unknown";
    description: string;
    confidence: "clear" | "probable" | "ambiguous";
    evidenceIds: string[];
  }[];
}

export interface AnalysisResult {
  observations: Evidence[];
  proposedMethod: MethodId | null;
  questions: { id: string; question: string; resolves: string[]; reason: string }[];
  unsupportedConditions: string[];
  designInterpretation: DesignInterpretation | null;
}
