import type { CadBinding, Outcome } from "./contracts.ts";
import type { SectionCalculation, SectionBinding, SectionScenarioInput } from "./section-contracts.ts";

export interface SectionScanRankedStation {
  stationIndex: number;
  utilization: number;
  component: string;
}

export interface SectionScanCandidateRecord {
  stationIndex: number;
  offsetMm: number;
  status: Outcome;
  binding: SectionBinding;
  reasons: string[];
  input?: SectionScenarioInput;
  calculation?: SectionCalculation;
  maximumSingleModeUtilization?: number;
  governingComponent?: string;
}

export interface SectionStrengthScanRecord {
  binding: CadBinding;
  scan: {
    startPlane: { originMm: [number, number, number]; normal: [number, number, number]; xDirection: [number, number, number] };
    fromOffsetMm: number;
    toOffsetMm: number;
    spacingMm: number;
    stationCount: number;
  };
  ranking: {
    status: "complete" | "incomplete";
    metric: "maximum-single-mode-utilization";
    rankedStations: SectionScanRankedStation[];
    excludedStationIndices: number[];
    governingStationIndex?: number;
  };
  candidates: SectionScanCandidateRecord[];
}

export interface StoredSectionStrengthScan extends SectionStrengthScanRecord {
  kind: "planar-section-strength-scan";
  id: string;
  createdAt: string;
}
