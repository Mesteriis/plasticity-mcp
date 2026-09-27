import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { calculate } from "./calculate.ts";
import { calculateSection } from "./section-calculate.ts";
import { calculateSingleFastener } from "./fastener-calculate.ts";
import { fastenerScenarioFixture } from "./fastener-fixtures.test.ts";
import { calculateFastenerMember } from "./fastener-member-calculate.ts";
import { fastenerMemberFixture } from "./fastener-member-fixtures.test.ts";
import { calculateInsertRetention } from "./insert-retention-calculate.ts";
import { insertRetentionFixture } from "./insert-retention-fixtures.test.ts";
import { calculateFastenerGroupLoad } from "./fastener-group-calculate.ts";
import { fastenerGroupFixture } from "./fastener-group-fixtures.test.ts";
import { calculateThreadedReceiver } from "./threaded-receiver-calculate.ts";
import { threadedReceiverFixture } from "./threaded-receiver-fixtures.test.ts";
import { calculateTongueRoot } from "./tongue-root-calculate.ts";
import { tongueRootFixture } from "./tongue-root-fixtures.test.ts";
import { syntheticEulerColumnInput, syntheticInput, syntheticPlateInput, withAssignedValue } from "./fixtures.test.ts";
import { rectangleLoop, sectionScenarioFixture } from "./section-fixtures.test.ts";
import type { SectionStrengthScanRecord } from "./section-scan-contracts.ts";
import { inputHash, reportView, StrengthStore } from "./store.ts";

test("reports round-trip through exclusive private files", async (context) => {
  const root = await temporaryRoot(context);
  const store = new StrengthStore(root);
  const input = syntheticInput("axial-rectangle-v1");
  const saved = await store.saveReport(input, calculate(input));
  assert.deepEqual(await store.readReport(saved.id), saved);
  const mode = (await lstat(join(root, "reports", `${saved.id}.json`))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("reads a literal legacy report without adding a kind discriminator", async (context) => {
  const root = await temporaryRoot(context);
  const input = syntheticInput("axial-rectangle-v1");
  const legacy = {
    id: "legacy-report",
    createdAt: "2026-09-21T00:00:00.000Z",
    input,
    result: calculate(input),
  };
  await mkdir(join(root, "reports"), { recursive: true });
  await writeFile(join(root, "reports", "legacy-report.json"), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

  const read = await new StrengthStore(root).readReport("legacy-report");
  assert.deepEqual(read, legacy);
  assert.equal("kind" in read, false);
  assert.equal(read.input.method, "axial-rectangle-v1");
});

test("plate reports round-trip and pressure or thickness changes make them stale", async (context) => {
  const root = await temporaryRoot(context);
  const store = new StrengthStore(root);
  const input = syntheticPlateInput();
  const saved = await store.saveReport(input, calculate(input));
  assert.deepEqual(await store.readReport(saved.id), saved);
  assert.equal(saved.result.plate?.seriesMaxOddIndex, 401);

  const changedPressure = structuredClone(input);
  changedPressure.pressureMPa = 0.002;
  changedPressure.evidence.find((item) => item.id === "pressure")!.value = 0.002;
  assert.equal(reportView(saved, changedPressure).freshness, "stale");

  const changedThickness = structuredClone(input);
  changedThickness.heightMm = 3;
  changedThickness.evidence.find((item) => item.id === "height")!.value = 3;
  assert.equal(reportView(saved, changedThickness).freshness, "stale");
});

test("Euler column report round-trips its separate buckling and crushing checks", async (context) => {
  const store = new StrengthStore(await temporaryRoot(context));
  const input = syntheticEulerColumnInput();
  const saved = await store.saveReport(input, calculate(input));
  const read = await store.readReport(saved.id);
  assert.deepEqual(read, saved);
  if ("kind" in read) throw new Error("Expected rectangular strength report");
  assert.equal(read.result.method, "euler-column-buckling-v1");
  assert.ok(read.result.buckling);
  assert.equal(read.result.buckling.compressiveUtilization, 100 / 3000);
});

test("section reports round-trip immutably through private files", async (context) => {
  const root = await temporaryRoot(context);
  const store = new StrengthStore(root);
  const input = sectionScenarioFixture();
  const saved = await store.saveSectionReport(input, calculateSection(input));
  assert.equal(saved.kind, "planar-section");
  assert.deepEqual(await store.readReport(saved.id), saved);
  input.pointForces[0]!.forceN[2] = 999;
  assert.equal(saved.input.pointForces[0]!.forceN[2], 100);
  const mode = (await lstat(join(root, "reports", `${saved.id}.json`))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("persists the versioned Bredt-Batho single-cell torsion result", async (context) => {
  const store = new StrengthStore(await temporaryRoot(context));
  const input = sectionScenarioFixture({
    loops: [rectangleLoop(-10, -5, 20, 10), rectangleLoop(-9, -4, 18, 8)],
    forceN: [0, 0, 0],
    freeMoments: [[0, 0, 100]],
    thinWallAssumption: true,
  });
  const calculation = calculateSection(input);
  const report = await store.saveSectionReport(input, calculation);
  const read = await store.readReport(report.id);
  if (!("kind" in read) || read.kind !== "planar-section") throw new Error("Expected a planar-section report");
  assert.equal(read.result.methodVersion, "1.3.0");
  assert.equal(read.result.torsionModel, "thin-walled-rectangular-single-cell");
  assert.equal(read.result.torsionalMedianAreaMm2, 171);
  assert.equal(read.result.torsionalWallThicknessMm, 1);
  assert.equal(read.result.torsionalShearFlowNPerMm, 100 / (2 * 171));
});

test("single-fastener reports round-trip and bind both faces and topology", async (context) => {
  const root = await temporaryRoot(context);
  const store = new StrengthStore(root);
  const base = fastenerScenarioFixture();
  const input = {
    ...base,
    binding: {
      sessionId: "s1",
      documentToken: "d1",
      revision: "r1",
      bodyId: 7,
      frontFaceId: "front",
      backFaceId: "back",
      loadDirection: [1, 0, 0] as [number, number, number],
      topologySignature: "fastener-signature",
    },
  };
  const saved = await store.saveFastenerReport(input, calculateSingleFastener(input));
  assert.deepEqual(await store.readReport(saved.id), saved);
  assert.equal(reportView(saved, structuredClone(input)).freshness, "current");
  assert.deepEqual(reportView(saved, { ...input, binding: { ...input.binding, backFaceId: "other" } }).reasons, ["CAD_FACE_CHANGED"]);
  assert.deepEqual(reportView(saved, { ...input, binding: { ...input.binding, topologySignature: "changed" } }).reasons, ["CAD_TOPOLOGY_CHANGED"]);
  assert.deepEqual(reportView(saved, { ...input, binding: { ...input.binding, loadDirection: [0, 1, 0] } }).reasons, ["CAD_LOAD_DIRECTION_CHANGED"]);
});

test("fastener-member reports round-trip and become stale when the load or allowables change", async (context) => {
  const root = await temporaryRoot(context);
  const store = new StrengthStore(root);
  const input = fastenerMemberFixture();
  const saved = await store.saveFastenerMemberReport(input, calculateFastenerMember(input));
  assert.deepEqual(await store.readReport(saved.id), saved);
  assert.equal(reportView(saved, structuredClone(input)).freshness, "current");

  const changedLoad = structuredClone(input);
  changedLoad.loads.axialTensionN = 1_100;
  changedLoad.evidence.find((item) => item.id === "loads.axialTensionN")!.value = 1_100;
  assert.deepEqual(reportView(saved, changedLoad).reasons, ["TASK_OR_MATERIAL_CHANGED"]);

  const changedMaterial = structuredClone(input);
  changedMaterial.material.tensileLimitMPa = 450;
  changedMaterial.evidence.find((item) => item.id === "material.tensileLimitMPa")!.value = 450;
  assert.deepEqual(reportView(saved, changedMaterial).reasons, ["TASK_OR_MATERIAL_CHANGED"]);
});

test("threaded-receiver reports round-trip and become stale with engagement or capacity changes", async (context) => {
  const root = await temporaryRoot(context);
  const store = new StrengthStore(root);
  const input = threadedReceiverFixture();
  const saved = await store.saveThreadedReceiverReport(input, calculateThreadedReceiver(input));
  assert.deepEqual(await store.readReport(saved.id), saved);
  assert.equal(reportView(saved, structuredClone(input)).freshness, "current");

  const changedEngagement = structuredClone(input);
  changedEngagement.configuration.engagementMm = 8.8;
  changedEngagement.configuration.completeThreadCount = 11;
  changedEngagement.evidence.find((item) => item.id === "configuration.engagementMm")!.value = 8.8;
  changedEngagement.evidence.find((item) => item.id === "configuration.completeThreadCount")!.value = 11;
  assert.deepEqual(reportView(saved, changedEngagement).reasons, ["TASK_OR_MATERIAL_CHANGED"]);

  const changedCapacity = structuredClone(input);
  changedCapacity.capacity.internalThreadStripAllowableN = 11_000;
  changedCapacity.evidence.find((item) => item.id === "capacity.internalThreadStripAllowableN")!.value = 11_000;
  assert.deepEqual(reportView(saved, changedCapacity).reasons, ["TASK_OR_MATERIAL_CHANGED"]);
});

test("tongue-root reports round-trip and become stale when the load changes", async (context) => {
  const root = await temporaryRoot(context);
  const store = new StrengthStore(root);
  const input = tongueRootFixture();
  const saved = await store.saveTongueRootReport(input, calculateTongueRoot(input));
  assert.deepEqual(await store.readReport(saved.id), saved);
  assert.equal(reportView(saved, structuredClone(input)).freshness, "current");

  const changed = structuredClone(input);
  changed.loads.transverseForceN = 11;
  changed.evidence.find((item) => item.id === "loads.transverseForceN")!.value = 11;
  assert.deepEqual(reportView(saved, changed).reasons, ["TASK_OR_MATERIAL_CHANGED"]);
});

test("native-bound tongue-root reports become stale when the section plane or topology changes", async (context) => {
  const root = await temporaryRoot(context);
  const store = new StrengthStore(root);
  const input = tongueRootFixture();
  input.binding = {
    sessionId: "session-1",
    documentToken: "doc-1",
    revision: "r1",
    bodyId: 7,
    plane: { originMm: [2, 0, 0], normal: [1, 0, 0], xDirection: [0, 1, 0] },
    topologySignature: "section-before",
  };
  const saved = await store.saveTongueRootReport(input, calculateTongueRoot(input));
  assert.equal(reportView(saved, structuredClone(input)).freshness, "current");

  const changedPlane = structuredClone(input);
  changedPlane.binding!.plane.originMm[0] = 2.5;
  assert.ok(reportView(saved, changedPlane).reasons.includes("CAD_SECTION_PLANE_CHANGED"));

  const changedTopology = structuredClone(input);
  changedTopology.binding!.topologySignature = "section-after";
  assert.ok(reportView(saved, changedTopology).reasons.includes("CAD_TOPOLOGY_CHANGED"));
});

test("tongue-root reports become stale when the printer or slicer profile changes", async (context) => {
  const root = await temporaryRoot(context);
  const store = new StrengthStore(root);
  const input = tongueRootFixture();
  const saved = await store.saveTongueRootReport(input, calculateTongueRoot(input));
  const changedProfile = structuredClone(input);
  changedProfile.material.manufacturing.printerId = "bambu-lab";
  changedProfile.material.manufacturing.profileHash = "c".repeat(64);
  assert.deepEqual(reportView(saved, changedProfile).reasons, ["TASK_OR_MATERIAL_CHANGED"]);
});

test("heat-set insert retention reports round-trip and bind the qualification configuration", async (context) => {
  const root = await temporaryRoot(context);
  const store = new StrengthStore(root);
  const input = insertRetentionFixture();
  const saved = await store.saveInsertRetentionReport(input, calculateInsertRetention(input));
  assert.deepEqual(await store.readReport(saved.id), saved);
  assert.equal(reportView(saved, structuredClone(input)).freshness, "current");

  const changedProcess = structuredClone(input);
  changedProcess.configuration.installationProcessId = "other-process";
  assert.deepEqual(reportView(saved, changedProcess).reasons, ["TASK_OR_MATERIAL_CHANGED"]);

  const changedCapacity = structuredClone(input);
  changedCapacity.capacity.pulloutN = 350;
  changedCapacity.evidence.find((item) => item.id === "capacity.pulloutN")!.value = 350;
  assert.deepEqual(reportView(saved, changedCapacity).reasons, ["TASK_OR_MATERIAL_CHANGED"]);
});

test("fastener-group reports round-trip and become stale when positions or loads change", async (context) => {
  const root = await temporaryRoot(context);
  const store = new StrengthStore(root);
  const input = fastenerGroupFixture();
  const saved = await store.saveFastenerGroupReport(input, calculateFastenerGroupLoad(input));
  assert.deepEqual(await store.readReport(saved.id), saved);
  assert.equal(reportView(saved, structuredClone(input)).freshness, "current");

  const changedPosition = structuredClone(input);
  changedPosition.fasteners[0]!.xMm = -25;
  changedPosition.evidence.find((item) => item.id === "fasteners.0.xMm")!.value = -25;
  assert.deepEqual(reportView(saved, changedPosition).reasons, ["TASK_OR_MATERIAL_CHANGED"]);

  const changedLoad = structuredClone(input);
  changedLoad.load.forceXN = 120;
  changedLoad.evidence.find((item) => item.id === "load.forceXN")!.value = 120;
  assert.deepEqual(reportView(saved, changedLoad).reasons, ["TASK_OR_MATERIAL_CHANGED"]);
});

test("fastener-group reports bind selected cylindrical faces and frame", async (context) => {
  const root = await temporaryRoot(context);
  const store = new StrengthStore(root);
  const input = fastenerGroupFixture();
  input.binding = {
    sessionId: "session-1",
    documentToken: "doc-1",
    revision: "r1",
    bodyId: 7,
    cylindricalFaceIds: ["A", "B", "C", "D"],
    frame: { originMm: [0, 0, 0], normal: [0, 0, 1], xDirection: [1, 0, 0], yDirection: [0, 1, 0] },
    topologySignature: "group-signature",
  };
  const saved = await store.saveFastenerGroupReport(input, calculateFastenerGroupLoad(input));
  assert.equal(reportView(saved, structuredClone(input)).freshness, "current");

  const changed = structuredClone(input);
  changed.binding!.topologySignature = "changed-signature";
  assert.deepEqual(reportView(saved, changed).reasons, ["CAD_TOPOLOGY_CHANGED"]);
});

test("reads a stored planar-section 1.0.0 report without a shear-model field", async (context) => {
  const root = await temporaryRoot(context);
  const input = sectionScenarioFixture({ forceN: [20, 0, 0] });
  const current = calculateSection(input);
  const { shearModel: _newField, ...legacyResult } = current;
  const legacy = {
    kind: "planar-section" as const,
    id: "legacy-section-report",
    createdAt: "2026-09-21T00:00:00.000Z",
    input,
    result: { ...legacyResult, methodVersion: "1.0.0" as const },
  };
  await mkdir(join(root, "reports"), { recursive: true });
  await writeFile(join(root, "reports", "legacy-section-report.json"), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

  assert.deepEqual(await new StrengthStore(root).readReport("legacy-section-report"), legacy);
});

test("reads a stored planar-section 1.1.0 shear report without torsion fields", async (context) => {
  const root = await temporaryRoot(context);
  const input = sectionScenarioFixture({ forceN: [20, 0, 0] });
  const current = calculateSection(input);
  const {
    torsionalShearStressMPa: _torsionalStress,
    torsionModel: _torsionModel,
    torsionUtilization: _torsionUtilization,
    ...legacyResult
  } = current;
  const legacy = {
    kind: "planar-section" as const,
    id: "legacy-section-shear-report",
    createdAt: "2026-09-21T00:00:00.000Z",
    input,
    result: { ...legacyResult, methodVersion: "1.1.0" as const },
  };
  await mkdir(join(root, "reports"), { recursive: true });
  await writeFile(join(root, "reports", "legacy-section-shear-report.json"), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

  assert.deepEqual(await new StrengthStore(root).readReport("legacy-section-shear-report"), legacy);
});

test("input hashes are key-order independent, finite and normalize negative zero", () => {
  assert.equal(inputHash({ a: -0, b: 2 }), inputHash({ b: 2, a: 0 }));
  assert.notEqual(inputHash({ orientation: [0, 0, 0] }), inputHash({ orientation: [0, 90, 0] }));
  assert.throws(() => inputHash({ value: Number.NaN }), /finite/);
});

test("report freshness requires task, material and CAD identity", async (context) => {
  const root = await temporaryRoot(context);
  const store = new StrengthStore(root);
  const input = { ...syntheticInput("axial-rectangle-v1"), binding: { sessionId: "s1", documentToken: "d1", revision: "r1", bodyId: 7 } };
  const report = await store.saveReport(input, calculate(input));
  assert.deepEqual(reportView(report), { report, freshness: "unverified", reasons: ["NO_CURRENT_INPUT"] });
  assert.equal(reportView(report, structuredClone(input)).freshness, "current");
  assert.deepEqual(reportView(report, { ...input, binding: { ...input.binding, revision: "r2" } }).reasons, ["CAD_REVISION_CHANGED"]);
  assert.deepEqual(reportView(report, { ...input, binding: { ...input.binding, sessionId: "s2" } }).reasons, ["CAD_SESSION_CHANGED"]);
  const changedProfile = { ...input, material: { ...input.material, manufacturing: { ...input.material.manufacturing, orientationDeg: [0, 90, 0] as [number, number, number] } } };
  assert.deepEqual(reportView(report, changedProfile).reasons, ["TASK_OR_MATERIAL_CHANGED"]);
});

test("request IDs claim once and conflicting payloads are rejected", async (context) => {
  const root = await temporaryRoot(context);
  const store = new StrengthStore(root);
  assert.equal(await store.beginRequest("request-1", "hash-1"), true);
  assert.equal(await store.beginRequest("request-1", "hash-1"), false);
  await assert.rejects(() => store.beginRequest("request-1", "hash-2"), /conflict/i);
  await store.finishRequest({
    id: "request-1",
    inputHash: "hash-1",
    state: "completed",
    result: { observations: [], proposedMethod: null, questions: [], unsupportedConditions: [], designInterpretation: null },
  });
  assert.equal((await store.readRequest("request-1")).state, "completed");
});

test("a requested record from a stopped owner becomes interrupted and is never claimed", async (context) => {
  const root = await temporaryRoot(context);
  await mkdir(join(root, "requests"), { recursive: true });
  await writeFile(join(root, "requests", "orphan.json"), JSON.stringify({
    id: "orphan",
    inputHash: "same-hash",
    state: "requested",
    owner: { pid: 999_999_999, nonce: "dead-owner" },
  }), { mode: 0o600 });
  const store = new StrengthStore(root);
  assert.equal(await store.beginRequest("orphan", "same-hash"), false);
  assert.equal((await store.readRequest("orphan")).state, "interrupted");
  assert.equal(await store.beginRequest("orphan", "same-hash"), false);
});

test("a second store does not interrupt an active owner process", async (context) => {
  const root = await temporaryRoot(context);
  const owner = new StrengthStore(root);
  const observer = new StrengthStore(root);
  assert.equal(await owner.beginRequest("active", "same-hash"), true);
  assert.equal(await observer.beginRequest("active", "same-hash"), false);
  assert.equal((await observer.readRequest("active")).state, "requested");
  await assert.rejects(() => observer.finishRequest({ id: "active", inputHash: "same-hash", state: "failed", errorCode: "NOT_OWNER" }), /another process/);
});

test("store rejects traversal, symlinks and invalid persisted JSON", async (context) => {
  const root = await temporaryRoot(context);
  const store = new StrengthStore(root);
  await assert.rejects(() => store.readReport("../outside"), /invalid/i);
  await mkdir(join(root, "reports"), { recursive: true });
  const target = join(root, "target.json");
  await writeFile(target, "{}", { mode: 0o600 });
  await symlink(target, join(root, "reports", "linked.json"));
  await assert.rejects(() => store.readReport("linked"), /symbolic link/i);
  await writeFile(join(root, "reports", "broken.json"), "{}", { mode: 0o600 });
  await assert.rejects(() => store.readReport("broken"), /invalid stored report/i);
  await chmod(target, 0o600);
});

test("changed numeric input makes an unbound report stale", async (context) => {
  const root = await temporaryRoot(context);
  const store = new StrengthStore(root);
  const input = syntheticInput("axial-rectangle-v1");
  const report = await store.saveReport(input, calculate(input));
  const changed = withAssignedValue(input, "forceN", 2);
  assert.equal(reportView(report, changed).freshness, "stale");
});

test("section freshness binds the face and topology and detects engineering-input changes", async (context) => {
  const root = await temporaryRoot(context);
  const store = new StrengthStore(root);
  const base = sectionScenarioFixture();
  const input = {
    ...base,
    binding: {
      sessionId: "s1",
      documentToken: "d1",
      revision: "r1",
      bodyId: 7,
      faceId: "face-1",
      topologySignature: base.properties.topologySignature,
    },
  };
  const report = await store.saveSectionReport(input, calculateSection(input));
  assert.equal(reportView(report, structuredClone(input)).freshness, "current");
  assert.deepEqual(reportView(report, { ...input, binding: { ...input.binding, sessionId: "s2" } }).reasons, ["CAD_SESSION_CHANGED"]);
  assert.deepEqual(reportView(report, { ...input, binding: { ...input.binding, documentToken: "d2" } }).reasons, ["CAD_DOCUMENT_CHANGED"]);
  assert.deepEqual(reportView(report, { ...input, binding: { ...input.binding, revision: "r2" } }).reasons, ["CAD_REVISION_CHANGED"]);
  assert.deepEqual(reportView(report, { ...input, binding: { ...input.binding, bodyId: 8 } }).reasons, ["CAD_BODY_CHANGED"]);
  assert.deepEqual(reportView(report, { ...input, binding: { ...input.binding, faceId: "face-2" } }).reasons, ["CAD_FACE_CHANGED"]);
  assert.deepEqual(reportView(report, { ...input, binding: { ...input.binding, topologySignature: "changed" } }).reasons, ["CAD_TOPOLOGY_CHANGED"]);

  const changedMaterial = { ...input, material: { ...input.material, tensileLimitMPa: 11 } };
  assert.deepEqual(reportView(report, changedMaterial).reasons, ["TASK_OR_MATERIAL_CHANGED"]);
  const changedPrinter = { ...input, material: { ...input.material, manufacturing: { ...input.material.manufacturing, profileHash: "new-profile" } } };
  assert.deepEqual(reportView(report, changedPrinter).reasons, ["TASK_OR_MATERIAL_CHANGED"]);
  const changedOrientation = { ...input, material: { ...input.material, manufacturing: { ...input.material.manufacturing, orientationDeg: [0, 90, 0] as [number, number, number] } } };
  assert.deepEqual(reportView(report, changedOrientation).reasons, ["TASK_OR_MATERIAL_CHANGED"]);
  const changedLoad = structuredClone(input);
  changedLoad.pointForces[0]!.forceN[2] = 101;
  assert.deepEqual(reportView(report, changedLoad).reasons, ["TASK_OR_MATERIAL_CHANGED"]);
});

test("section freshness binds an arbitrary plane and detects plane changes", async (context) => {
  const root = await temporaryRoot(context);
  const store = new StrengthStore(root);
  const base = sectionScenarioFixture();
  const input = {
    ...base,
    binding: {
      sessionId: "s1",
      documentToken: "d1",
      revision: "r1",
      bodyId: 7,
      plane: { originMm: [1, 2, 3] as [number, number, number], normal: [0, 0, 1] as [number, number, number], xDirection: [1, 0, 0] as [number, number, number] },
      topologySignature: base.properties.topologySignature,
    },
  };
  const report = await store.saveSectionReport(input, calculateSection(input));
  assert.equal(reportView(report, structuredClone(input)).freshness, "current");
  const changedPlane = { ...input, binding: { ...input.binding, plane: { ...input.binding.plane, originMm: [1, 2, 4] as [number, number, number] } } };
  assert.deepEqual(reportView(report, changedPlane).reasons, ["CAD_PLANE_CHANGED"]);
  const { plane: _plane, ...faceBinding } = input.binding;
  const changedSource = { ...input, binding: { ...faceBinding, faceId: "face-1" } };
  assert.deepEqual(reportView(report, changedSource).reasons, ["CAD_FACE_CHANGED", "CAD_SECTION_SOURCE_CHANGED"]);
});

test("section-strength scan reports round-trip exact inputs, calculations and station rankings", async (context) => {
  const root = await temporaryRoot(context);
  const store = new StrengthStore(root);
  const base = sectionScenarioFixture();
  const candidates = [1, 2].map((offsetMm, stationIndex) => {
    const plane = { ...base.frame, originMm: [0, 0, offsetMm] as [number, number, number] };
    const input = {
      ...base,
      frame: plane,
      binding: {
        sessionId: "s1",
        documentToken: "d1",
        revision: "r1",
        bodyId: 7,
        plane,
        topologySignature: base.properties.topologySignature,
      },
    };
    const calculation = calculateSection(input);
    return {
      stationIndex,
      offsetMm,
      status: calculation.status,
      binding: input.binding,
      reasons: [],
      input,
      calculation,
      maximumSingleModeUtilization: 0.5,
      governingComponent: "tension",
    };
  });
  const record: SectionStrengthScanRecord = {
    binding: { sessionId: "s1", documentToken: "d1", revision: "r1", bodyId: 7 },
    scan: {
      startPlane: base.frame,
      fromOffsetMm: 1,
      toOffsetMm: 2,
      spacingMm: 1,
      stationCount: 2,
    },
    ranking: {
      status: "complete",
      metric: "maximum-single-mode-utilization",
      rankedStations: [
        { stationIndex: 0, utilization: 0.5, component: "tension" },
        { stationIndex: 1, utilization: 0.5, component: "tension" },
      ],
      excludedStationIndices: [],
      governingStationIndex: 0,
    },
    candidates,
  };
  const report = await store.saveSectionStrengthScan(record);
  assert.equal(report.kind, "planar-section-strength-scan");
  assert.deepEqual(await store.readSectionStrengthScan(report.id), report);
  const mode = (await lstat(join(root, "section-scans", `${report.id}.json`))).mode & 0o777;
  assert.equal(mode, 0o600);
  await assert.rejects(() => store.saveSectionStrengthScan({
    ...record,
    candidates: [{ ...candidates[0]!, calculation: { ...candidates[0]!.calculation, inputHash: "0".repeat(64) } }, candidates[1]!],
  }), /input hash/i);
});

async function temporaryRoot(context: test.TestContext): Promise<string> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "plasticity-strength-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
