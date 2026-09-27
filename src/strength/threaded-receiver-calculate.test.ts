import assert from "node:assert/strict";
import test from "node:test";

import { calculateThreadedReceiver } from "./threaded-receiver-calculate.ts";
import { threadedReceiverFixture } from "./threaded-receiver-fixtures.test.ts";

test("checks both thread-stripping modes and fastener tension from explicit qualified loads", () => {
  const result = calculateThreadedReceiver(threadedReceiverFixture());
  assert.equal(result.status, "pass");
  assert.equal(result.factoredDemandN, 6_000);
  assert.deepEqual(result.utilization, { internalThreadStrip: 0.5, externalThreadStrip: 3 / 7, fastenerTension: 0.6 });
  assert.deepEqual(result.governing, { mode: "fastener-tension", allowableLoadN: 10_000, utilization: 0.6 });
  assert.deepEqual(result.failureHierarchy, {
    status: "fastener-tension-before-thread-stripping",
    minimumThreadStripAllowableN: 12_000,
    fastenerTensileAllowableN: 10_000,
    marginN: 2_000,
  });
  assert.match(result.checkedScope, /internal and external thread stripping/i);
});

test("fails when the factored axial demand exceeds either thread-stripping allowable", () => {
  const input = threadedReceiverFixture();
  input.capacity.internalThreadStripAllowableN = 5_000;
  input.evidence.find((item) => item.id === "capacity.internalThreadStripAllowableN")!.value = 5_000;
  const result = calculateThreadedReceiver(input);
  assert.equal(result.status, "fail");
  assert.equal(result.utilization?.internalThreadStrip, 1.2);
  assert.ok(result.issues.some((issue) => issue.code === "INTERNAL_THREAD_STRIP_LIMIT_EXCEEDED"));
  assert.ok(result.issues.some((issue) => issue.code === "FAILURE_MODE_REQUIREMENT_NOT_MET"));
});

test("keeps a weaker thread-stripping mode conditional when the user did not require tensile failure first", () => {
  const input = threadedReceiverFixture();
  input.capacity.internalThreadStripAllowableN = 9_000;
  input.evidence.find((item) => item.id === "capacity.internalThreadStripAllowableN")!.value = 9_000;
  input.criteria.requireFastenerTensionBeforeThreadStripping = false;
  const result = calculateThreadedReceiver(input);
  assert.equal(result.status, "conditional");
  assert.ok(result.issues.some((issue) => issue.code === "THREAD_STRIPPING_GOVERNS_FAILURE_MODE"));
});

test("requires direct traceability and a matched capacity configuration", () => {
  const input = threadedReceiverFixture();
  const evidence = input.evidence.find((item) => item.id === "capacity.externalThreadStripAllowableN")!;
  evidence.status = "assumed";
  delete evidence.sourceUrl;
  delete evidence.sourceHash;
  input.capacity.suitability = "unconfirmed";
  const result = calculateThreadedReceiver(input);
  assert.equal(result.status, "needs-input");
  assert.ok(result.issues.some((issue) => issue.code === "CAPACITY_EVIDENCE_REQUIRED"));
  assert.ok(result.issues.some((issue) => issue.code === "CAPACITY_CONFIGURATION_UNCONFIRMED"));
});

test("rejects analytical strip capacities for a procured nut or insert", () => {
  for (const receiverType of ["nut", "threaded-insert"] as const) {
    const input = threadedReceiverFixture();
    input.configuration.receiverType = receiverType;
    const result = calculateThreadedReceiver(input);
    assert.equal(result.status, "unsupported");
    assert.ok(result.issues.some((issue) => issue.code === "PROCURED_RECEIVER_REQUIRES_SPECIFIED_OR_TESTED_LOAD"));
  }
});

test("schema rejects inconsistent complete-thread count and a zero axial demand", async () => {
  const { threadedReceiverInputSchema } = await import("./threaded-receiver-schemas.ts");
  const count = threadedReceiverFixture();
  count.configuration.completeThreadCount = 11;
  count.evidence.find((item) => item.id === "configuration.completeThreadCount")!.value = 11;
  assert.equal(threadedReceiverInputSchema.safeParse(count).success, false);

  const noLoad = threadedReceiverFixture();
  noLoad.loads.axialTensionN = 0;
  noLoad.evidence.find((item) => item.id === "loads.axialTensionN")!.value = 0;
  assert.equal(threadedReceiverInputSchema.safeParse(noLoad).success, false);
});
