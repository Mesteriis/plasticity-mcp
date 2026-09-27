import assert from "node:assert/strict";
import { test } from "node:test";

import { checkFastenerStack, fastenerStackInputSchema } from "./stack.ts";

test("checks a nut joint directly from an M5x10 designation", () => {
  const result = checkFastenerStack({
    designation: "болт ISO 4017 M5x10 с гайкой",
    lengthMeasurement: "under-head",
    gripItems: [
      { id: "bracket", thicknessMm: 2 },
      { id: "housing-wall", thicknessMm: 2 },
    ],
    receiver: {
      kind: "nut",
      nutThicknessMm: 4,
      minimumProtrusionMm: 1.6,
      maximumProtrusionMm: 3,
    },
  });

  assert.equal(result.status, "pass");
  assert.equal(result.designation.normalized, "M5×0.8×10");
  assert.equal(result.gripThicknessMm, 4);
  assert.equal(result.usableUnderHeadLengthMm, 10);
  assert.deepEqual(result.receiver, {
    kind: "nut",
    nutThicknessMm: 4,
    actualProtrusionMm: 2,
    minimumProtrusionMm: 1.6,
    maximumProtrusionMm: 3,
  });
  assert.equal(result.minimumRequiredLengthMm, 9.6);
  assert.equal(result.minimumLengthMarginMm, 0.4);
  assert.deepEqual(result.issues, []);
});

test("reports that M5x10 cannot span a thick nut joint", () => {
  const result = checkFastenerStack({
    designation: "4 болта ISO 4017 M5x10 класса 8.8 с гайками",
    lengthMeasurement: "under-head",
    gripItems: [{ id: "plate", thicknessMm: 8 }],
    receiver: { kind: "nut", nutThicknessMm: 4, minimumProtrusionMm: 1.6 },
  });

  assert.equal(result.status, "fail");
  assert.equal(result.minimumRequiredLengthMm, 13.6);
  assert.equal(result.minimumLengthMarginMm, -3.6);
  assert.equal(result.receiver?.kind, "nut");
  if (result.receiver?.kind !== "nut") assert.fail("expected a nut receiver result");
  assert.equal(result.receiver.actualProtrusionMm, -2);
  assert.deepEqual(result.issues.map((issue) => issue.code), ["FASTENER_TOO_SHORT"]);
  assert.match(result.nextAction, /longer qualified fastener/i);
});

test("checks threaded engagement and blind-hole bottoming separately", () => {
  const passing = checkFastenerStack({
    designation: "винт DIN 912 M5x8 в резьбовое отверстие в металле",
    lengthMeasurement: "under-head",
    gripItems: [{ id: "cover", thicknessMm: 3 }],
    receiver: {
      kind: "threaded",
      jointIntent: "machine-screw-into-tapped-metal",
      requiredEngagementMm: 4,
      threadEngagementCapacityMm: 5,
      maximumInsertionDepthMm: 6,
      minimumTipClearanceMm: 1,
    },
  });
  assert.equal(passing.status, "pass");
  assert.deepEqual(passing.receiver, {
    kind: "threaded",
    jointIntent: "machine-screw-into-tapped-metal",
    insertionMm: 5,
    actualEngagementMm: 5,
    engagementMarginMm: 1,
    requiredEngagementMm: 4,
    threadEngagementCapacityMm: 5,
    remainingTipClearanceMm: 1,
    minimumTipClearanceMm: 1,
  });

  const bottoming = checkFastenerStack({
    designation: "винт DIN 912 M5x10 в резьбовое отверстие в металле",
    lengthMeasurement: "under-head",
    gripItems: [{ id: "cover", thicknessMm: 3 }],
    receiver: {
      kind: "threaded",
      jointIntent: "machine-screw-into-tapped-metal",
      requiredEngagementMm: 4,
      threadEngagementCapacityMm: 5,
      maximumInsertionDepthMm: 6,
      minimumTipClearanceMm: 1,
    },
  });
  assert.equal(bottoming.status, "fail");
  assert.deepEqual(bottoming.issues.map((issue) => issue.code), ["FASTENER_BOTTOMS_OUT"]);
  assert.equal(bottoming.receiver?.kind, "threaded");
  if (bottoming.receiver?.kind !== "threaded") assert.fail("expected a threaded receiver result");
  assert.equal(bottoming.receiver.remainingTipClearanceMm, -1);

  const insufficientReceiver = checkFastenerStack({
    designation: "винт DIN 912 M5x10 в резьбовое отверстие в металле",
    lengthMeasurement: "under-head",
    gripItems: [{ id: "cover", thicknessMm: 2 }],
    receiver: {
      kind: "threaded",
      jointIntent: "machine-screw-into-tapped-metal",
      requiredEngagementMm: 4,
      threadEngagementCapacityMm: 3,
    },
  });
  assert.equal(insufficientReceiver.status, "fail");
  assert.equal(insufficientReceiver.minimumLengthMarginMm, 4);
  assert.equal(insufficientReceiver.receiver?.kind, "threaded");
  if (insufficientReceiver.receiver?.kind !== "threaded") assert.fail("expected a threaded receiver result");
  assert.equal(insufficientReceiver.receiver.engagementMarginMm, -1);
  assert.deepEqual(insufficientReceiver.issues.map((issue) => issue.code), ["INSUFFICIENT_THREAD_ENGAGEMENT"]);
});

test("converts an overall countersunk length only with an explicit head axial length", () => {
  const result = checkFastenerStack({
    designation: "винт ISO 10642 M5x10 в термовставку",
    lengthMeasurement: "overall",
    headAxialLengthMm: 2.5,
    gripItems: [{ id: "lid", thicknessMm: 2 }],
    receiver: {
      kind: "threaded",
      jointIntent: "machine-screw-into-heat-set-insert",
      requiredEngagementMm: 4,
      threadEngagementCapacityMm: 5,
      minimumTipClearanceMm: 0,
    },
  });

  assert.equal(result.status, "pass");
  assert.equal(result.usableUnderHeadLengthMm, 7.5);
  assert.equal(result.receiver?.kind, "threaded");
  if (result.receiver?.kind !== "threaded") assert.fail("expected a threaded receiver result");
  assert.equal(result.receiver.insertionMm, 5.5);
  assert.equal(result.receiver.actualEngagementMm, 5);
  assert.equal(result.receiver.engagementMarginMm, 1);
});

test("keeps an ambiguous designation as needs-input and validates stack structure", () => {
  const result = checkFastenerStack({
    designation: "винт M10x1",
    lengthMeasurement: "under-head",
    gripItems: [{ id: "part", thicknessMm: 2 }],
    receiver: { kind: "nut", nutThicknessMm: 8, minimumProtrusionMm: 2 },
  });
  assert.equal(result.status, "needs-input");
  assert.equal(result.usableUnderHeadLengthMm, undefined);
  assert.deepEqual(result.issues.map((issue) => issue.code), ["FASTENER_LENGTH_UNRESOLVED"]);

  const conflict = checkFastenerStack({
    designation: "болт M5x10 с гайкой",
    lengthMeasurement: "under-head",
    gripItems: [{ id: "part", thicknessMm: 2 }],
    receiver: {
      kind: "threaded",
      jointIntent: "machine-screw-into-heat-set-insert",
      requiredEngagementMm: 4,
      threadEngagementCapacityMm: 5,
    },
  });
  assert.equal(conflict.status, "needs-input");
  assert.deepEqual(conflict.issues.map((issue) => issue.code), ["JOINT_INTENT_CONFLICT"]);

  assert.equal(fastenerStackInputSchema.safeParse({
    designation: "M5x10",
    lengthMeasurement: "overall",
    gripItems: [{ id: "part", thicknessMm: 2 }],
    receiver: { kind: "nut", nutThicknessMm: 4, minimumProtrusionMm: 1 },
  }).success, false);
  assert.equal(fastenerStackInputSchema.safeParse({
    designation: "M5x10",
    lengthMeasurement: "under-head",
    gripItems: [{ id: "part", thicknessMm: 2 }, { id: "part", thicknessMm: 1 }],
    receiver: { kind: "nut", nutThicknessMm: 4, minimumProtrusionMm: 2, maximumProtrusionMm: 1 },
  }).success, false);
});
