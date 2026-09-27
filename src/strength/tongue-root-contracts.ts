import type { Evidence, Material, Outcome, TongueRootMethodId } from "./contracts.ts";

export interface TongueRootBinding {
  sessionId: string;
  documentToken: string;
  revision: string;
  bodyId: number;
  plane: { originMm: [number, number, number]; normal: [number, number, number]; xDirection: [number, number, number] };
  topologySignature: string;
}

export interface TongueRootInput {
  kind: "tongue-root";
  goal: string;
  method: TongueRootMethodId;
  geometry: { rootWidthMm: number; rootThicknessMm: number; leverArmMm: number };
  loads: { transverseForceN: number };
  material: {
    id: string;
    name: string;
    youngModulusMPa: number;
    shearModulusMPa: number;
    tensileAllowableMPa: number;
    shearAllowableMPa: number;
    suitability: "matched" | "unconfirmed" | "mismatch";
    evidenceIds: string[];
    couponRecordId?: string;
    allowablesBasis?: string;
    manufacturing: Material["manufacturing"];
  };
  shearCorrectionFactor: number;
  safetyFactor: number;
  maxDeflectionMm: number;
  evidence: Evidence[];
  assignments: Record<string, string>;
  assumptions: { code: string; confirmed: boolean; evidenceIds: string[] }[];
  binding?: TongueRootBinding;
}

export interface TongueRootCalculation {
  kind: "tongue-root";
  status: Outcome;
  method: TongueRootMethodId;
  methodVersion: "1.0.0";
  inputHash: string;
  stressMPa?: { rootBending: number; maximumTransverseShear: number };
  deflectionMm?: { bending: number; shear: number; total: number };
  utilization?: { bending: number; shear: number; deflection: number; governing: number };
  checkedScope: string;
  issues: { code: string; message: string; evidenceIds: string[] }[];
  unchecked: string[];
}
