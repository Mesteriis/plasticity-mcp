import type { Evidence, FastenerMemberMethodId, Outcome } from "./contracts.ts";

export interface FastenerMemberInput {
  kind: "fastener-member";
  goal: string;
  method: FastenerMemberMethodId;
  geometry: {
    nominalDiameterMm: number;
    tensileStressAreaMm2: number;
    shearAreaPerPlaneMm2: number;
    shearPlaneCount: 1 | 2;
    shearPlaneLocation: "unthreaded-shank" | "threads";
  };
  loads: {
    axialTensionN: number;
    transverseShearN: number;
  };
  material: {
    id: string;
    name: string;
    tensileLimitMPa?: number;
    shearLimitMPa?: number;
    evidenceIds: string[];
    suitability: "matched" | "unconfirmed" | "mismatch";
  };
  safetyFactor: number;
  evidence: Evidence[];
  assignments: Record<string, string>;
  assumptions: { code: string; confirmed: boolean; evidenceIds: string[] }[];
  binding?: never;
}

export interface FastenerMemberCalculation {
  kind: "fastener-member";
  status: Outcome;
  method: FastenerMemberMethodId;
  methodVersion: "1.0.0";
  inputHash: string;
  stressMPa?: { tension: number; shear: number };
  allowableLoadN?: { tension: number; shear: number };
  loadRatio?: { tension: number; shear: number };
  interactionValue?: number;
  checkedScope: string;
  issues: { code: string; message: string; evidenceIds: string[] }[];
  unchecked: string[];
}
