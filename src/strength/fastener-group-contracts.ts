import type { CadBinding, Evidence, FastenerGroupMethodId } from "./contracts.ts";

export interface FastenerGroupBinding extends CadBinding {
  cylindricalFaceIds: string[];
  frame: {
    originMm: [number, number, number];
    normal: [number, number, number];
    xDirection: [number, number, number];
    yDirection: [number, number, number];
  };
  topologySignature: string;
}

export interface FastenerGroupInput {
  kind: "fastener-group-load";
  goal: string;
  method: FastenerGroupMethodId;
  fasteners: { id: string; xMm: number; yMm: number }[];
  shearCapacities?: { fastenerId: string; configuration: string; allowableShearN: number }[];
  load: {
    forceXN: number;
    forceYN: number;
    applicationPointXmm: number;
    applicationPointYmm: number;
    freeMomentNmm: number;
  };
  evidence: Evidence[];
  assignments: Record<string, string>;
  assumptions: { code: string; confirmed: boolean; evidenceIds: string[] }[];
  binding?: FastenerGroupBinding;
}

export interface FastenerGroupCalculation {
  kind: "fastener-group-load";
  status: "needs-input" | "unsupported" | "conditional" | "calculated";
  method: FastenerGroupMethodId;
  methodVersion: "1.0.0";
  inputHash: string;
  centroidMm?: { x: number; y: number };
  totalMomentAboutCentroidNmm?: number;
  polarSumMm2?: number;
  directPerFastenerN?: { x: number; y: number };
  fasteners?: {
    id: string;
    positionMm: { x: number; y: number };
    offsetFromCentroidMm: { x: number; y: number };
    directN: { x: number; y: number };
    momentN: { x: number; y: number };
    resultantN: { x: number; y: number };
    magnitudeN: number;
  }[];
  governing?: { fastenerId: string; shearDemandN: number };
  equilibrium?: { forceResidualN: number; momentResidualNmm: number };
  fastenerShearCheck?: {
    status: "within-allowable" | "exceeds-allowable" | "conditional";
    fasteners: { id: string; configuration: string; shearDemandN: number; allowableShearN: number; utilization: number; evidenceId: string }[];
    governing: { fastenerId: string; utilization: number };
    allowableBasis: "traceable-design-allowable-including-safety-factor";
    checkedScope: string;
    unchecked: string[];
  };
  checkedScope: string;
  issues: { code: string; message: string; evidenceIds: string[] }[];
  unchecked: string[];
}
