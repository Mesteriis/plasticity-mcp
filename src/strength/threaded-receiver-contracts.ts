import type { Evidence, Outcome, ThreadedReceiverMethodId } from "./contracts.ts";

export interface ThreadedReceiverInput {
  kind: "threaded-receiver";
  goal: string;
  method: ThreadedReceiverMethodId;
  configuration: {
    threadDesignation: string;
    nominalDiameterMm: number;
    pitchMm: number;
    engagementMm: number;
    completeThreadCount: number;
    receiverType: "tapped-hole" | "nut" | "threaded-insert";
    capacityBasis: "specified-assembly-load" | "dedicated-test" | "qualified-shear-area-calculation";
  };
  loads: {
    axialTensionN: number;
  };
  capacity: {
    internalThreadStripAllowableN: number;
    externalThreadStripAllowableN: number;
    fastenerTensileAllowableN: number;
    evidenceIds: string[];
    suitability: "matched" | "unconfirmed" | "mismatch";
  };
  criteria: {
    requireFastenerTensionBeforeThreadStripping: boolean;
  };
  safetyFactor: number;
  evidence: Evidence[];
  assignments: Record<string, string>;
  assumptions: { code: string; confirmed: boolean; evidenceIds: string[] }[];
  binding?: never;
}

export interface ThreadedReceiverCalculation {
  kind: "threaded-receiver";
  status: Outcome;
  method: ThreadedReceiverMethodId;
  methodVersion: "1.0.0";
  inputHash: string;
  factoredDemandN?: number;
  utilization?: {
    internalThreadStrip: number;
    externalThreadStrip: number;
    fastenerTension: number;
  };
  governing?: {
    mode: "internal-thread-strip" | "external-thread-strip" | "fastener-tension";
    allowableLoadN: number;
    utilization: number;
  };
  failureHierarchy?: {
    status: "fastener-tension-before-thread-stripping" | "thread-stripping-before-fastener-tension";
    minimumThreadStripAllowableN: number;
    fastenerTensileAllowableN: number;
    marginN: number;
  };
  checkedScope: string;
  issues: { code: string; message: string; evidenceIds: string[] }[];
  unchecked: string[];
}
