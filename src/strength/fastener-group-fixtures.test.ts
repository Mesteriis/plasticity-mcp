import type { Evidence } from "./contracts.ts";
import type { FastenerGroupInput } from "./fastener-group-contracts.ts";

export function fastenerGroupFixture(): FastenerGroupInput {
  const fasteners = [
    { id: "A", xMm: -20, yMm: -10 },
    { id: "B", xMm: 20, yMm: -10 },
    { id: "C", xMm: -20, yMm: 10 },
    { id: "D", xMm: 20, yMm: 10 },
  ];
  const values: Record<string, [number, "mm" | "N" | "Nmm", Evidence["status"]]> = {
    "fasteners.0.xMm": [-20, "mm", "measured"],
    "fasteners.0.yMm": [-10, "mm", "measured"],
    "fasteners.1.xMm": [20, "mm", "measured"],
    "fasteners.1.yMm": [-10, "mm", "measured"],
    "fasteners.2.xMm": [-20, "mm", "measured"],
    "fasteners.2.yMm": [10, "mm", "measured"],
    "fasteners.3.xMm": [20, "mm", "measured"],
    "fasteners.3.yMm": [10, "mm", "measured"],
    "load.forceXN": [100, "N", "sourced"],
    "load.forceYN": [0, "N", "sourced"],
    "load.applicationPointXmm": [0, "mm", "measured"],
    "load.applicationPointYmm": [30, "mm", "measured"],
    "load.freeMomentNmm": [0, "Nmm", "sourced"],
  };
  const evidence = Object.entries(values).map(([path, [value, unit, status]]) => ({
    id: path,
    label: path,
    status,
    unit,
    value,
    ...(status === "sourced" ? { sourceUrl: "https://example.test/load-case", sourceHash: "sha256:test" } : {}),
    ...(status === "measured" ? { sourceLocator: "cad:test-fixture" } : {}),
    dependsOn: [],
  }));
  return {
    kind: "fastener-group-load",
    goal: "distribute one eccentric in-plane force over four fasteners",
    method: "fastener-group-elastic-in-plane-v1",
    fasteners,
    load: {
      forceXN: 100,
      forceYN: 0,
      applicationPointXmm: 0,
      applicationPointYmm: 30,
      freeMomentNmm: 0,
    },
    evidence,
    assignments: Object.fromEntries(Object.keys(values).map((path) => [path, path])),
    assumptions: [
      "static-in-plane-load",
      "rigid-attachment-member",
      "identical-fastener-in-plane-stiffness",
      "no-slip-or-clearance-redistribution",
      "fastener-points-represent-load-transfer-centers",
      "load-resultant-is-complete",
    ].map((code) => ({ code, confirmed: true, evidenceIds: [] })),
  };
}
