import type { Evidence, InsertRetentionMethodId, Outcome } from "./contracts.ts";

export interface InsertRetentionInput {
  kind: "heat-set-insert-retention";
  goal: string;
  method: InsertRetentionMethodId;
  configuration: {
    insertId: string;
    threadDesignation: string;
    insertLengthMm: number;
    threadPitchMm: number;
    holeDiameterMm: number;
    holeDepthMm: number;
    hostMaterialId: string;
    printerId: string;
    profileHash: string;
    orientationDeg: [number, number, number];
    installationMethod: "heat" | "ultrasonic";
    installationProcessId: string;
  };
  demands: {
    axialPulloutPerInsertN: number;
    torquePerInsertNmm: number;
  };
  capacity: {
    pulloutN: number;
    torqueOutNmm: number;
    evidenceIds: string[];
    suitability: "matched" | "unconfirmed" | "mismatch";
  };
  safetyFactor: number;
  evidence: Evidence[];
  assignments: Record<string, string>;
  assumptions: { code: string; confirmed: boolean; evidenceIds: string[] }[];
  binding?: never;
}

export interface InsertRetentionCalculation {
  kind: "heat-set-insert-retention";
  status: Outcome;
  method: InsertRetentionMethodId;
  methodVersion: "1.0.0";
  inputHash: string;
  utilization?: { pullout: number; torqueOut: number };
  factoredDemand?: { pulloutN: number; torqueNmm: number };
  minimumHoleDepthGuidanceMm?: number;
  checkedScope: string;
  issues: { code: string; message: string; evidenceIds: string[] }[];
  unchecked: string[];
}
