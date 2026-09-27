import type { ThreadedReceiverInput } from "./threaded-receiver-contracts.ts";

export function threadedReceiverFixture(): ThreadedReceiverInput {
  const values: Record<string, [number, "mm" | "N" | "ratio", "sourced" | "assumed"]> = {
    "configuration.nominalDiameterMm": [5, "mm", "sourced"],
    "configuration.pitchMm": [0.8, "mm", "sourced"],
    "configuration.engagementMm": [8, "mm", "sourced"],
    "configuration.completeThreadCount": [10, "ratio", "sourced"],
    "loads.axialTensionN": [3_000, "N", "sourced"],
    "capacity.internalThreadStripAllowableN": [12_000, "N", "sourced"],
    "capacity.externalThreadStripAllowableN": [14_000, "N", "sourced"],
    "capacity.fastenerTensileAllowableN": [10_000, "N", "sourced"],
    safetyFactor: [2, "ratio", "assumed"],
  };
  const evidence = Object.entries(values).map(([path, [value, unit, status]]) => ({
    id: path,
    label: path,
    status,
    unit,
    value,
    ...(status === "sourced" ? { sourceUrl: "https://example.test/threaded-joint", sourceHash: "sha256:test" } : {}),
    dependsOn: [],
  }));
  return {
    kind: "threaded-receiver",
    goal: "check an M5 tapped-metal receiver",
    method: "threaded-receiver-axial-v1",
    configuration: {
      threadDesignation: "M5×0.8",
      nominalDiameterMm: 5,
      pitchMm: 0.8,
      engagementMm: 8,
      completeThreadCount: 10,
      receiverType: "tapped-hole",
      capacityBasis: "qualified-shear-area-calculation",
    },
    loads: { axialTensionN: 3_000 },
    capacity: {
      internalThreadStripAllowableN: 12_000,
      externalThreadStripAllowableN: 14_000,
      fastenerTensileAllowableN: 10_000,
      evidenceIds: [
        "capacity.internalThreadStripAllowableN",
        "capacity.externalThreadStripAllowableN",
        "capacity.fastenerTensileAllowableN",
      ],
      suitability: "matched",
    },
    criteria: { requireFastenerTensionBeforeThreadStripping: true },
    safetyFactor: 2,
    evidence,
    assignments: Object.fromEntries(Object.keys(values).map((path) => [path, path])),
    assumptions: [
      "static-axial-load",
      "worst-case-receiver-demand-known",
      "fully-formed-engaged-thread-count-known",
      "capacity-matches-thread-form-class-material-and-engagement",
      "axial-force-includes-applicable-preload",
      "no-prying-bending-or-transverse-load",
    ].map((code) => ({ code, confirmed: true, evidenceIds: [] })),
  };
}
