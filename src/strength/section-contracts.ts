import type { Evidence, Material, Outcome, SectionMethodId } from "./contracts.ts";
import type { LocalSectionProperties, SectionLoop } from "./section-geometry.ts";
import type { TorsionSectionModel, DirectShearModel } from "./section-shear.ts";

export interface PointForce {
  id: string;
  forceN: [number, number, number];
  pointMm: [number, number, number];
  evidenceIds: string[];
}

export interface FreeMoment {
  id: string;
  momentNmm: [number, number, number];
  evidenceIds: string[];
}

export interface SectionBinding {
  sessionId: string;
  documentToken: string;
  revision: string;
  bodyId: number;
  faceId?: string;
  plane?: {
    originMm: [number, number, number];
    normal: [number, number, number];
    xDirection: [number, number, number];
  };
  topologySignature: string;
}

export interface SectionScenarioInput {
  kind: "planar-section";
  goal: string;
  method: SectionMethodId;
  frame: {
    originMm: [number, number, number];
    normal: [number, number, number];
    xDirection: [number, number, number];
  };
  loops: SectionLoop[];
  properties: LocalSectionProperties;
  pointForces: PointForce[];
  freeMoments: FreeMoment[];
  material: Material;
  safetyFactor?: number;
  evidence: Evidence[];
  assignments: Record<string, string>;
  assumptions: { code: string; confirmed: boolean; evidenceIds: string[] }[];
  binding?: SectionBinding;
}

export interface SectionCalculation {
  kind: "planar-section";
  status: Outcome;
  method: SectionMethodId;
  methodVersion: "1.0.0" | "1.1.0" | "1.2.0" | "1.3.0";
  inputHash: string;
  resultants: {
    axialN: number;
    shearXN: number;
    shearYN: number;
    bendingXNmm: number;
    bendingYNmm: number;
    torsionNmm: number;
  };
  normalStressMPa?: { minimum: number; maximum: number };
  shearStressMPa?: number;
  shearModel?: DirectShearModel;
  torsionalShearStressMPa?: number;
  torsionModel?: TorsionSectionModel;
  torsionalShearFlowNPerMm?: number;
  torsionalMedianAreaMm2?: number;
  torsionalWallThicknessMm?: number;
  tensileUtilization?: number;
  compressiveUtilization?: number;
  shearUtilization?: number;
  torsionUtilization?: number;
  checkedScope: string;
  issues: { code: string; message: string; evidenceIds: string[] }[];
  unchecked: string[];
}
