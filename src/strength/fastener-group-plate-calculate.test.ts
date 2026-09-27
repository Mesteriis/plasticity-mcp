import assert from "node:assert/strict";
import test from "node:test";

import type { FastenerGroupLayoutEvidence } from "../plasticity/fastener-group-layout.ts";
import { fastenerGroupFixture } from "./fastener-group-fixtures.test.ts";
import { calculateFastenerGroupPlateBearing, type FastenerGroupPlateBearingInput } from "./fastener-group-plate-calculate.ts";

test("reports only a conditional local bearing screen for a native multi-hole group", () => {
  const input = scenario();
  const result = calculateFastenerGroupPlateBearing(input, layout(input));

  assert.equal(result.status, "conditional");
  assert.equal(result.bearingCheckStatus, "within-allowable");
  assert.equal(result.fasteners?.length, 4);
  assert.equal(result.plate?.thicknessMm, 8);
  assert.ok(result.fasteners?.every((fastener) => fastener.utilization < 1));
  assert.match(result.checkedScope, /not a multi-hole plate or complete-joint strength pass/i);
  assert.ok(result.unchecked.some((item) => /multi-hole net-section/i.test(item)));
  assert.ok(result.unchecked.some((item) => /shared inter-hole ligament/i.test(item)));
});

test("fails a traceable local bearing scenario when any hole exceeds its allowable", () => {
  const input = scenario();
  input.plate.bearingDesignAllowableMPa = 0.01;
  input.plate.allowableEvidence = {
    ...input.plate.allowableEvidence,
    value: 0.01,
  };
  const result = calculateFastenerGroupPlateBearing(input, layout(input));

  assert.equal(result.status, "fail");
  assert.equal(result.bearingCheckStatus, "exceeds-allowable");
  assert.ok(result.fasteners?.some((fastener) => fastener.utilization > 1));
  assert.ok(result.issues.some((issue) => issue.code === "PLATE_BEARING_ALLOWABLE_EXCEEDED"));
});

test("does not call an assumed or untraceable allowable within limits", () => {
  const input = scenario();
  input.plate.materialSuitability = "unconfirmed";
  input.plate.allowableEvidence = {
    ...input.plate.allowableEvidence,
    status: "assumed",
    dependsOn: [],
  };
  const result = calculateFastenerGroupPlateBearing(input, layout(input));

  assert.equal(result.status, "needs-input");
  assert.equal(result.bearingCheckStatus, "conditional");
  assert.ok(result.issues.some((issue) => issue.code === "BEARING_ALLOWABLE_EVIDENCE_REQUIRED"));
});

test("does not claim failure or pass when the allowable evidence value does not match", () => {
  const input = scenario();
  input.plate.bearingDesignAllowableMPa = 0.01;
  const result = calculateFastenerGroupPlateBearing(input, layout(input));

  assert.equal(result.status, "needs-input");
  assert.equal(result.bearingCheckStatus, "conditional");
  assert.ok(result.issues.some((issue) => issue.code === "BEARING_ALLOWABLE_EVIDENCE_REQUIRED"));
});

test("rejects geometry bound to another native fastener group", () => {
  const input = scenario();
  const evidence = layout(input);
  evidence.binding.groupTopologySignature = "different-group";
  const result = calculateFastenerGroupPlateBearing(input, evidence);

  assert.equal(result.status, "unsupported");
  assert.ok(result.issues.some((issue) => issue.code === "CAD_BINDING_MISMATCH"));
});

function scenario(): FastenerGroupPlateBearingInput {
  const group = fastenerGroupFixture();
  const frame = { originMm: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], xDirection: [1, 0, 0] as [number, number, number], yDirection: [0, 1, 0] as [number, number, number] };
  group.binding = {
    sessionId: "session-1",
    documentToken: "doc-1",
    revision: "r1",
    bodyId: 7,
    cylindricalFaceIds: group.fasteners.map((fastener) => fastener.id),
    frame,
    topologySignature: "group-topology",
  };
  return {
    group,
    plate: {
      boundaryFaceId: "front",
      opposedFaceId: "back",
      bearingDesignAllowableMPa: 20,
      allowableEvidence: {
        id: "bearing-allowable",
        label: "Configuration-matched bearing design allowable",
        status: "sourced",
        unit: "MPa",
        value: 20,
        sourceUrl: "https://example.test/allowable",
        sourceHash: "sha256:source",
        dependsOn: [],
      },
      materialConfiguration: "printer/material/profile/orientation test configuration",
      materialSuitability: "matched",
      assumptions: {
        homogeneousEquivalentPlate: true,
        nominalBearingContact: true,
        loadCenteredThroughThickness: true,
      },
    },
  };
}

function layout(input: FastenerGroupPlateBearingInput): FastenerGroupLayoutEvidence {
  return {
    status: "verified",
    binding: {
      sessionId: input.group.binding!.sessionId,
      documentToken: input.group.binding!.documentToken,
      revision: input.group.binding!.revision,
      bodyId: input.group.binding!.bodyId,
      boundaryFaceId: input.plate.boundaryFaceId,
      opposedFaceId: input.plate.opposedFaceId,
      cylindricalFaceIds: [...input.group.binding!.cylindricalFaceIds],
      groupTopologySignature: input.group.binding!.topologySignature,
      frame: structuredClone(input.group.binding!.frame),
      topologySignature: "layout-topology",
    },
    measurementSource: "native-brep-opposed-boundaries-and-cylindrical-faces",
    plate: {
      boundaryFaceId: input.plate.boundaryFaceId,
      opposedFaceId: input.plate.opposedFaceId,
      frame: { originMm: [0, 0, 8], normal: [0, 0, 1], xDirection: [1, 0, 0], yDirection: [0, 1, 0] },
      boundsMm: { minX: -30, maxX: 30, minY: -20, maxY: 20 },
      sizeMm: { x: 60, y: 40 },
      thicknessMm: 8,
    },
    fasteners: input.group.fasteners.map((fastener) => ({
      id: fastener.id,
      faceId: fastener.id,
      centerMm: [fastener.xMm, fastener.yMm, 4],
      localCenterMm: { x: fastener.xMm, y: fastener.yMm },
      holeDiameterMm: 6,
      centerToEdgesMm: { minX: 30 + fastener.xMm, maxX: 30 - fastener.xMm, minY: 20 + fastener.yMm, maxY: 20 - fastener.yMm },
      holeEdgeClearancesMm: { minX: 27 + fastener.xMm, maxX: 27 - fastener.xMm, minY: 17 + fastener.yMm, maxY: 17 - fastener.yMm },
      minimumCenterToEdgeMm: 10,
      minimumHoleEdgeClearanceMm: 7,
    })),
    reasons: [],
  };
}
