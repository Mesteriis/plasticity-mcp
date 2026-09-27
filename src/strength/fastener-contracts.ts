import type { CadBinding, Evidence, FastenerMethodId, Material, Outcome } from "./contracts.ts";

export interface FastenerBinding extends CadBinding {
  frontFaceId: string;
  backFaceId: string;
  loadDirection: [number, number, number];
  topologySignature: string;
}

export interface FastenerPlateGeometry {
  thicknessMm: number;
  holeDiameterMm: number;
  loadedEdgeDistanceMm: number;
  oppositeEdgeDistanceMm: number;
  grossWidthMm: number;
  sideClearancesMm: [number, number];
}

export interface FastenerScenarioInput {
  kind: "single-fastener-plate";
  goal: string;
  method: FastenerMethodId;
  geometry: FastenerPlateGeometry;
  loadN: number;
  material: Material;
  safetyFactor: number;
  evidence: Evidence[];
  assignments: Record<string, string>;
  assumptions: { code: string; confirmed: boolean; evidenceIds: string[] }[];
  binding?: FastenerBinding;
}

export interface FastenerCalculation {
  kind: "single-fastener-plate";
  status: Outcome;
  method: FastenerMethodId;
  methodVersion: "1.0.0";
  inputHash: string;
  stressMPa?: { bearing: number; shearOut: number; netTension: number };
  utilization?: { bearing: number; shearOut: number; netTension: number };
  geometryRatios: { edgeDistanceToDiameter: number; widthToDiameter: number };
  checkedScope: string;
  issues: { code: string; message: string; evidenceIds: string[] }[];
  unchecked: string[];
}
