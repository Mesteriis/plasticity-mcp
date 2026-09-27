import type { InsertRetentionInput } from "./insert-retention-contracts.ts";

export function insertRetentionFixture(): InsertRetentionInput {
  const values: Record<string, [number, "mm" | "N" | "Nmm" | "ratio", "measured" | "sourced" | "assumed"]> = {
    "configuration.insertLengthMm": [4, "mm", "sourced"],
    "configuration.threadPitchMm": [0.5, "mm", "sourced"],
    "configuration.holeDiameterMm": [4.6, "mm", "measured"],
    "configuration.holeDepthMm": [6, "mm", "measured"],
    "demands.axialPulloutPerInsertN": [100, "N", "sourced"],
    "demands.torquePerInsertNmm": [0, "Nmm", "sourced"],
    "capacity.pulloutN": [400, "N", "measured"],
    "capacity.torqueOutNmm": [2_000, "Nmm", "measured"],
    safetyFactor: [2, "ratio", "assumed"],
  };
  const evidence = Object.entries(values).map(([path, [value, unit, status]]) => ({
    id: path,
    label: path,
    status,
    unit,
    value,
    ...(status === "sourced" ? { sourceUrl: "https://example.test/insert", sourceHash: "sha256:test" } : {}),
    ...(status === "measured" ? { sourceLocator: "qualification:test-coupon" } : {}),
    dependsOn: [],
  }));
  return {
    kind: "heat-set-insert-retention",
    goal: "check one installed M3 heat-set insert",
    method: "heat-set-insert-retention-v1",
    configuration: {
      insertId: "insert-m3-test",
      threadDesignation: "M3x0.5",
      insertLengthMm: 4,
      threadPitchMm: 0.5,
      holeDiameterMm: 4.6,
      holeDepthMm: 6,
      hostMaterialId: "pla-test",
      printerId: "creality-k1c",
      profileHash: "profile-test",
      orientationDeg: [0, 0, 0],
      installationMethod: "heat",
      installationProcessId: "process-test",
    },
    demands: { axialPulloutPerInsertN: 100, torquePerInsertNmm: 0 },
    capacity: {
      pulloutN: 400,
      torqueOutNmm: 2_000,
      evidenceIds: ["capacity.pulloutN", "capacity.torqueOutNmm"],
      suitability: "matched",
    },
    safetyFactor: 2,
    evidence,
    assignments: Object.fromEntries(Object.keys(values).map((path) => [path, path])),
    assumptions: [
      "static-load",
      "worst-case-per-insert-demand-known",
      "insert-installed-flush",
      "screw-does-not-bottom-out",
      "installation-process-matches-qualification",
      "hole-boss-and-host-match-qualification",
    ].map((code) => ({ code, confirmed: true, evidenceIds: [] })),
  };
}
