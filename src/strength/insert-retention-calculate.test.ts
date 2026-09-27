import assert from "node:assert/strict";
import test from "node:test";

import { calculateInsertRetention } from "./insert-retention-calculate.ts";
import { insertRetentionFixture } from "./insert-retention-fixtures.test.ts";

test("checks axial pullout against a matched per-insert qualification", () => {
  const result = calculateInsertRetention(insertRetentionFixture());
  assert.equal(result.status, "pass");
  assert.deepEqual(result.utilization, { pullout: 0.5, torqueOut: 0 });
  assert.equal(result.minimumHoleDepthGuidanceMm, 5);
  assert.match(result.checkedScope, /one installed heat-set insert/i);
});

test("reports a failed pullout and torque-out independently", () => {
  const pullout = insertRetentionFixture();
  pullout.demands.axialPulloutPerInsertN = 250;
  pullout.evidence.find((item) => item.id === "demands.axialPulloutPerInsertN")!.value = 250;
  const pulloutResult = calculateInsertRetention(pullout);
  assert.equal(pulloutResult.status, "fail");
  assert.equal(pulloutResult.utilization?.pullout, 1.25);
  assert.ok(pulloutResult.issues.some((issue) => issue.code === "PULLOUT_CAPACITY_EXCEEDED"));

  const torque = insertRetentionFixture();
  torque.demands = { axialPulloutPerInsertN: 0, torquePerInsertNmm: 1_100 };
  torque.evidence.find((item) => item.id === "demands.axialPulloutPerInsertN")!.value = 0;
  torque.evidence.find((item) => item.id === "demands.torquePerInsertNmm")!.value = 1_100;
  const torqueResult = calculateInsertRetention(torque);
  assert.equal(torqueResult.status, "fail");
  assert.equal(torqueResult.utilization?.torqueOut, 1.1);
  assert.ok(torqueResult.issues.some((issue) => issue.code === "TORQUE_OUT_CAPACITY_EXCEEDED"));
});

test("simultaneous pullout and torque remain conditional without an interaction model", () => {
  const input = insertRetentionFixture();
  input.demands.torquePerInsertNmm = 500;
  input.evidence.find((item) => item.id === "demands.torquePerInsertNmm")!.value = 500;
  const result = calculateInsertRetention(input);
  assert.equal(result.status, "conditional");
  assert.deepEqual(result.utilization, { pullout: 0.5, torqueOut: 0.5 });
  assert.ok(result.issues.some((issue) => issue.code === "COMBINED_RETENTION_INTERACTION_UNVERIFIED"));
});

test("keeps manufacturer data for another host process conditional or unsupported", () => {
  const unconfirmed = insertRetentionFixture();
  unconfirmed.capacity.suitability = "unconfirmed";
  assert.equal(calculateInsertRetention(unconfirmed).status, "conditional");

  const mismatch = insertRetentionFixture();
  mismatch.capacity.suitability = "mismatch";
  assert.equal(calculateInsertRetention(mismatch).status, "unsupported");
});

test("flags insufficient blind-hole depth without hiding the capacity check", () => {
  const input = insertRetentionFixture();
  input.configuration.holeDepthMm = 4.5;
  input.evidence.find((item) => item.id === "configuration.holeDepthMm")!.value = 4.5;
  const result = calculateInsertRetention(input);
  assert.equal(result.status, "conditional");
  assert.equal(result.utilization?.pullout, 0.5);
  assert.ok(result.issues.some((issue) => issue.code === "HOLE_DEPTH_BELOW_GUIDANCE"));
});

test("requires traceable capacity evidence", () => {
  const input = insertRetentionFixture();
  input.evidence = input.evidence.map((item) => {
    if (item.id !== "capacity.pulloutN") return item;
    const { sourceLocator: _sourceLocator, ...rest } = item;
    return { ...rest, status: "assumed" as const };
  });
  const result = calculateInsertRetention(input);
  assert.equal(result.status, "needs-input");
  assert.ok(result.issues.some((issue) => issue.code === "CAPACITY_EVIDENCE_REQUIRED"));
});

test("refuses non-finite derived results instead of serializing them", () => {
  const input = insertRetentionFixture();
  input.configuration.insertLengthMm = Number.MAX_VALUE;
  input.configuration.threadPitchMm = Number.MAX_VALUE;
  input.evidence.find((item) => item.id === "configuration.insertLengthMm")!.value = Number.MAX_VALUE;
  input.evidence.find((item) => item.id === "configuration.threadPitchMm")!.value = Number.MAX_VALUE;
  const result = calculateInsertRetention(input);
  assert.equal(result.status, "unsupported");
  assert.equal(result.minimumHoleDepthGuidanceMm, undefined);
  assert.equal(result.utilization, undefined);
  assert.ok(result.issues.some((issue) => issue.code === "COMPUTATION_OVERFLOW"));
});

test("schema rejects no-load scenarios and unknown installation methods", async () => {
  const { insertRetentionInputSchema } = await import("./insert-retention-schemas.ts");
  const noLoad = insertRetentionFixture();
  noLoad.demands = { axialPulloutPerInsertN: 0, torquePerInsertNmm: 0 };
  noLoad.evidence.find((item) => item.id === "demands.axialPulloutPerInsertN")!.value = 0;
  assert.equal(insertRetentionInputSchema.safeParse(noLoad).success, false);
  const invalid = { ...insertRetentionFixture(), configuration: { ...insertRetentionFixture().configuration, installationMethod: "glue" } };
  assert.equal(insertRetentionInputSchema.safeParse(invalid).success, false);
});
