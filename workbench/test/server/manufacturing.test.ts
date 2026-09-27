import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import type { ManufacturingProfile, PrinterSubmissionObservation } from "../../src/shared/contracts.ts";
import { manufacturingProfileSchema } from "../../src/shared/schemas.ts";
import { ArtifactStore } from "../../src/server/artifact-store.ts";
import { openDatabase } from "../../src/server/database.ts";
import { createWorkbenchServer } from "../../src/server/http-server.ts";
import { WorkbenchApiClient } from "../../src/server/mcp/client.ts";
import { assessPrintability } from "../../src/server/manufacturing/dfm.ts";
import { MoonrakerPrinter, type PrinterAdapter } from "../../src/server/manufacturing/printer.ts";
import { assertSlicedBoundsFit, createRemoteGcodeFilename, ManufacturingService } from "../../src/server/manufacturing/service.ts";
import { CrealityPrintSlicer, OrcaFamilySlicer, parseGcodeSummary, type SlicerAdapter } from "../../src/server/manufacturing/slicer.ts";
import { ManufacturingJobStore } from "../../src/server/manufacturing/store.ts";
import { discoverManufacturingProfiles } from "../../src/server/manufacturing/profile-registry.ts";
import { ManufacturingProfileStore } from "../../src/server/manufacturing/profile-store.ts";
import { SqliteProjectStore } from "../../src/server/project-store.ts";

test("manufacturing profiles accept named third-party printer vendors", () => {
  const profile = fixtureProfile("/profiles");
  profile.printer.vendor = "Prusa Research";
  profile.slicer.nominalInfillPercent = 100;
  profile.slicer.wallLoops = 20;
  assert.equal(manufacturingProfileSchema.parse(profile).printer.vendor, "Prusa Research");
  assert.equal(manufacturingProfileSchema.parse(profile).slicer.nominalInfillPercent, 100);
  assert.equal(manufacturingProfileSchema.safeParse({ ...profile, slicer: { ...profile.slicer, nominalInfillPercent: 100.01 } }).success, false);
  assert.equal(manufacturingProfileSchema.safeParse({ ...profile, slicer: { ...profile.slicer, wallLoops: 21 } }).success, false);
});

test("DFM selects a fitting orientation and proposes splitting oversized parts", () => {
  const profile = fixtureProfile("/profiles");
  const fitted = assessPrintability({ sizeMm: [230, 40, 10], minimumWallMm: 0.6 }, profile);
  assert.equal(fitted.printable, true);
  assert.equal(fitted.orientation.sizeMm[2], 10);
  assert.ok(fitted.orientation.rotationDeg[2] > 0);
  assert.ok(fitted.orientation.sizeMm[0] <= 220 && fitted.orientation.sizeMm[1] <= 220);
  assert.equal(fitted.findings.some((finding) => finding.code === "thin-wall"), true);

  const oversized = assessPrintability({ sizeMm: [300, 260, 240] }, profile);
  assert.equal(oversized.printable, false);
  assert.equal(oversized.needsSplit, true);
  assert.equal(oversized.findings[0]?.code, "outside-build-volume");
  assert.ok(oversized.splitPlan);
  assert.equal(oversized.splitPlan.partCount, 4);
  assert.equal(oversized.splitPlan.joint, null);
  assert.equal(oversized.findings.some((finding) => finding.code === "split-joint-required"), true);
});

test("DFM split plans honor bed margin, selected joints, and exact segment counts", () => {
  const report = assessPrintability({
    sizeMm: [500, 100, 20],
    split: { bedMarginMm: 5, joint: "alignment-pins", clearanceMm: 0.25 },
  }, fixtureProfile("/profiles"));
  assert.equal(report.printable, false);
  assert.ok(report.splitPlan);
  assert.deepEqual(report.splitPlan.usableBuildVolumeMm, [210, 210, 240]);
  assert.equal(report.splitPlan.partCount, 3);
  assert.deepEqual(report.splitPlan.segmentCounts, [3, 1, 1]);
  assert.deepEqual(report.splitPlan.cutOffsetsMm, [{ axis: "x", offsetsMm: [166.666667, 333.333333] }]);
  assert.equal(report.splitPlan.joint, "alignment-pins");
  assert.equal(report.splitPlan.clearanceMm, 0.25);
});

test("DFM reports cuts through protected strength zones and honors explicit seam offsets", () => {
  const protectedZone = {
    id: "critical-bracket-root",
    sourceId: "strength-report:bracket-root:v3",
    basis: "strength-report" as const,
    axis: "x" as const,
    minMm: 160,
    maxMm: 175,
  };
  const balanced = assessPrintability({
    sizeMm: [500, 100, 20],
    split: { bedMarginMm: 5, joint: "screws-and-inserts", protectedZones: [protectedZone] },
  }, fixtureProfile("/profiles"));
  assert.equal(balanced.splitPlan?.cutOffsetsSource, "balanced");
  assert.deepEqual(balanced.splitPlan?.cutConflicts, [{
    zoneId: "critical-bracket-root", sourceId: "strength-report:bracket-root:v3", axis: "x",
    cutOffsetMm: 166.666667, zoneMinMm: 160, zoneMaxMm: 175,
  }]);
  assert.equal(balanced.findings.some((finding) => finding.code === "split-cut-through-protected-zone" && finding.severity === "warning"), true);

  const adjusted = assessPrintability({
    sizeMm: [500, 100, 20],
    split: {
      bedMarginMm: 5,
      joint: "screws-and-inserts",
      protectedZones: [protectedZone],
      cutOffsetsMm: [{ axis: "x", offsetsMm: [140, 330] }],
    },
  }, fixtureProfile("/profiles"));
  assert.equal(adjusted.splitPlan?.cutOffsetsSource, "explicit");
  assert.deepEqual(adjusted.splitPlan?.cutOffsetsMm, [{ axis: "x", offsetsMm: [140, 330] }]);
  assert.deepEqual(adjusted.splitPlan?.maximumSegmentSizeMm, [190, 100, 20]);
  assert.deepEqual(adjusted.splitPlan?.cutConflicts, []);
  assert.equal(adjusted.findings.some((finding) => finding.code === "split-cut-through-protected-zone"), false);
});

test("DFM rejects explicit cut plans that exceed build volume or reference out-of-bounds zones", () => {
  assert.throws(() => assessPrintability({
    sizeMm: [500, 100, 20],
    split: { bedMarginMm: 5, cutOffsetsMm: [{ axis: "x", offsetsMm: [100, 320] }] },
  }, fixtureProfile("/profiles")), /larger than the usable build volume/u);
  assert.throws(() => assessPrintability({
    sizeMm: [500, 100, 20],
    split: { protectedZones: [{ id: "bad", sourceId: "report:1", basis: "strength-report", axis: "x", minMm: 490, maxMm: 501 }] },
  }, fixtureProfile("/profiles")), /extends beyond oriented x bounds/u);
  assert.throws(() => assessPrintability({
    sizeMm: [100, 100, 20],
    split: { cutOffsetsMm: [{ axis: "x", offsetsMm: [50] }] },
  }, fixtureProfile("/profiles")), /already fits the printer/u);
});

test("DFM carries immutable material and slicer calibration into the split plan", () => {
  const profile = fixtureProfile("/profiles");
  profile.material.jointClearanceMm = 0.22;
  profile.slicer.dimensionalScalePercent = 100.4;
  profile.slicer.holeCompensationMm = 0.15;
  profile.slicer.supportsEnabled = false;
  const report = assessPrintability({ sizeMm: [500, 100, 20], split: { joint: "tongue-and-groove" } }, profile);
  assert.equal(report.splitPlan?.clearanceMm, 0.22);
  assert.deepEqual(report.profileCompensation, {
    dimensionalScalePercent: 100.4,
    holeCompensationMm: 0.15,
    jointClearanceMm: 0.22,
    supportsEnabled: false,
  });
  assert.equal(report.findings.some((finding) => finding.code === "joint-clearance-required"), false);
});

test("sliced bounds are required and must fit the selected printer", () => {
  const profile = fixtureProfile("/profiles");
  assert.doesNotThrow(() => assertSlicedBoundsFit({ boundsMm: { min: [0, 0, 0], max: [220, 220, 250] }, boundsSource: "slicer-header" }, profile));
  assert.throws(() => assertSlicedBoundsFit({}, profile), /lacks model-bound metadata/i);
  assert.throws(() => assertSlicedBoundsFit({ boundsMm: { min: [0, 0, 0], max: [220, 220, 250] }, boundsSource: "extrusion-path-estimate" }, profile), /cannot certify printer fit/i);
  assert.throws(
    () => assertSlicedBoundsFit({ boundsMm: { min: [0, 0, 0], max: [220.02, 200, 20] }, boundsSource: "slicer-header" }, profile),
    /exceeds printer build volume/i,
  );
  assert.throws(
    () => assertSlicedBoundsFit({ boundsMm: { min: [100, 0, 0], max: [320, 20, 20] }, boundsSource: "slicer-header" }, profile),
    /exceeds printer build volume/i,
  );
});

test("slices from an immutable profile hash and preserves that identity on the job", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-slice-profile-hash-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "workbench.sqlite"));
  context.after(() => database.close());
  const projects = new SqliteProjectStore(database);
  const artifacts = new ArtifactStore(join(root, "artifacts"), database);
  const project = projects.create("Profile hash slice", join(root, "projects", "profile-hash-slice"));
  const source = await artifacts.put(Readable.from("solid part"), { mediaType: "model/stl", originalName: "part.stl" });
  artifacts.attachToProject(project.id, source.hash);
  const profile = fixtureProfile(root);
  await Promise.all([
    writeFile(profile.slicer.machineConfigPath, JSON.stringify({ type: "machine" })),
    writeFile(profile.slicer.processConfigPath, JSON.stringify({ layer_height: 0.2 })),
    writeFile(profile.slicer.filamentConfigPath, JSON.stringify({ filament_type: ["PLA"] })),
  ]);
  const profileStore = new ManufacturingProfileStore(database, join(root, "registry"));
  const catalog = { profiles: [profile], records: [], adapters: [] };
  let usedProfile: ManufacturingProfile | undefined;
  const slicer: SlicerAdapter = {
    id: "creality-print",
    async slice(_sourcePath, _sourceName, selectedProfile) {
      usedProfile = selectedProfile;
      return {
        gcode: Buffer.from("gcode"), filename: "part.gcode",
        summary: {
          layers: 4, depositionLayerZMm: [0.2, 0.4, 0.6, 0.8],
          depositionLayerPathOrientations: [
            { layerIndex: 1, planarPathLengthMm: 20, principalDirectionDeg: 0, directionalConcentration: 1, curvedExtrusionMoves: 0, coverage: "complete-linear" },
            { layerIndex: 2, planarPathLengthMm: 20, principalDirectionDeg: 90, directionalConcentration: 1, curvedExtrusionMoves: 0, coverage: "complete-linear" },
            { layerIndex: 3, planarPathLengthMm: 20, principalDirectionDeg: 45, directionalConcentration: 0.8, curvedExtrusionMoves: 0, coverage: "complete-linear" },
            { layerIndex: 4, planarPathLengthMm: 20, principalDirectionDeg: null, directionalConcentration: 0, curvedExtrusionMoves: 0, coverage: "complete-linear" },
          ],
          boundsMm: { min: [0, 0, 0], max: [20, 10, 3] }, boundsSource: "slicer-header",
        }, log: "sliced",
      };
    },
  };
  const service = new ManufacturingService(
    new ManufacturingJobStore(database), projects, artifacts,
    catalog, profileStore,
    new Map([["creality-print", slicer]]), new Map(),
  );

  const record = await service.registerProfile({
    discoveredProfile: { printerId: profile.printer.id, materialId: profile.material.id, slicerId: profile.slicer.id },
    verification: "user-verified",
  });
  assert.equal(service.assess({ sizeMm: [20, 10, 3] }, undefined, record.profileHash).printable, true);

  const job = await service.slice(project.id, {
    expectedRevision: 0,
    sourceArtifactHash: source.hash,
    profileHash: record.profileHash,
    dfm: { sizeMm: [20, 10, 3] },
  });
  assert.equal(usedProfile?.slicer.machineConfigPath, record.profile.slicer.machineConfigPath);
  assert.equal(job.profileHash, record.profileHash);
  assert.equal(new ManufacturingJobStore(database).get(job.id)?.profileHash, record.profileHash);
  assert.deepEqual(service.interfaceLayerHeights(project.id, job.id, [1, 3]), {
    jobId: job.id,
    profileHash: record.profileHash,
    sourceArtifactHash: source.hash,
    gcodeArtifactHash: job.gcodeArtifactHash,
    layerCount: 4,
    coordinateFrame: "slicer-build",
    firstDepositionLayerZMm: 0.2,
    interfaces: [
      {
        interfaceLayerIndex: 1, depositionLayerZMm: 0.2, relativeOffsetMm: 0,
        depositionPathOrientation: { layerIndex: 1, planarPathLengthMm: 20, principalDirectionDeg: 0, directionalConcentration: 1, curvedExtrusionMoves: 0, coverage: "complete-linear" },
      },
      {
        interfaceLayerIndex: 3, depositionLayerZMm: 0.6, relativeOffsetMm: 0.4,
        depositionPathOrientation: { layerIndex: 3, planarPathLengthMm: 20, principalDirectionDeg: 45, directionalConcentration: 0.8, curvedExtrusionMoves: 0, coverage: "complete-linear" },
      },
    ],
  });
  assert.deepEqual(service.layerPathOrientations(project.id, job.id, [1, 2, 4]), {
    jobId: job.id,
    profileHash: record.profileHash,
    sourceArtifactHash: source.hash,
    gcodeArtifactHash: job.gcodeArtifactHash,
    layerCount: 4,
    coordinateFrame: "slicer-build",
    layers: [
      { layerIndex: 1, depositionLayerZMm: 0.2, pathOrientation: job.summary!.depositionLayerPathOrientations![0] },
      { layerIndex: 2, depositionLayerZMm: 0.4, pathOrientation: job.summary!.depositionLayerPathOrientations![1] },
      { layerIndex: 4, depositionLayerZMm: 0.8, pathOrientation: job.summary!.depositionLayerPathOrientations![3] },
    ],
  });
  const http = createWorkbenchServer({
    ownerToken: "a".repeat(43),
    projects, artifacts, manufacturing: service,
    config: { host: "127.0.0.1", port: 0, projectsRoot: root, maxJsonBytes: 1024 * 1024 },
  });
  const address = await http.listen();
  context.after(async () => await http.close());
  assert.deepEqual(await new WorkbenchApiClient(address.origin, "a".repeat(43)).interfaceLayerHeights(project.id, job.id, [1, 3]),
    service.interfaceLayerHeights(project.id, job.id, [1, 3]));
  assert.deepEqual(await new WorkbenchApiClient(address.origin, "a".repeat(43)).layerPathOrientations(project.id, job.id, [1, 2, 4]),
    service.layerPathOrientations(project.id, job.id, [1, 2, 4]));
  assert.throws(() => service.interfaceLayerHeights(project.id, job.id, [4]), /between 1 and 3/);
  assert.throws(() => service.layerPathOrientations(project.id, job.id, [5]), /between 1 and 4/);
  await assert.rejects(() => service.slice(project.id, {
    expectedRevision: 0, sourceArtifactHash: source.hash, profileHash: "f".repeat(64), dfm: { sizeMm: [20, 10, 3] },
  }), /immutable manufacturing profile not found/i);
});

test("batch slicing prevalidates all parts, then creates independent jobs and reports per-part failures", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-batch-slice-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "workbench.sqlite"));
  context.after(() => database.close());
  const projects = new SqliteProjectStore(database);
  const artifacts = new ArtifactStore(join(root, "artifacts"), database);
  const project = projects.create("Multipart bracket", root);
  const attached = await Promise.all(["left.stl", "middle.stl", "right.stl"].map(async (name) => {
    const artifact = await artifacts.put(Readable.from(`solid ${name}`), { mediaType: "model/stl", originalName: name });
    artifacts.attachToProject(project.id, artifact.hash);
    return artifact;
  }));
  const profile = fixtureProfile(root);
  const calls: string[] = [];
  const slicer: SlicerAdapter = {
    id: "creality-print" as const,
    async slice(_sourcePath: string, sourceName: string) {
      calls.push(sourceName);
      if (sourceName === "middle.stl") throw new Error("simulated slicer failure");
      return {
        gcode: Buffer.from(sampleGcode()),
        filename: "part.gcode",
        summary: { boundsMm: { min: [100, 100, 0], max: [120, 120, 10] }, boundsSource: "slicer-header" },
        log: "sliced",
      };
    },
  };
  const jobs = new ManufacturingJobStore(database);
  const service = new ManufacturingService(
    jobs,
    projects,
    artifacts,
    { profiles: [profile], records: [], adapters: [] },
    new ManufacturingProfileStore(database, join(root, "registry")),
    new Map([["creality-print", slicer]]),
    new Map(),
  );
  const baseRequest = {
    expectedRevision: 0,
    profile,
    parts: attached.map((artifact, index) => ({
      label: ["Left", "Middle", "Right"][index]!,
      sourceArtifactHash: artifact.hash,
      dfm: { sizeMm: [20, 20, 10] as [number, number, number] },
    })),
  };

  await assert.rejects(
    () => service.sliceParts(project.id, { ...baseRequest, parts: baseRequest.parts.map((part, index) => index === 2 ? { ...part, dfm: { sizeMm: [300, 260, 240] } } : part) }),
    /DFM check failed for Right/,
  );
  assert.deepEqual(calls, []);
  assert.equal(jobs.list(project.id).length, 0);

  const result = await service.sliceParts(project.id, baseRequest);
  assert.equal(result.status, "partial");
  assert.deepEqual(calls, ["left.stl", "middle.stl", "right.stl"]);
  assert.equal(result.items[0]?.job?.state, "ready");
  assert.equal(result.items[1]?.job?.state, "failed");
  assert.equal(result.items[1]?.failure, "simulated slicer failure");
  assert.equal(result.items[2]?.job?.state, "ready");
  assert.equal(jobs.list(project.id).length, 3);
  assert.equal(result.items.some((item) => item.job?.state === "approved" || item.job?.state === "submitted"), false);
});

test("parses Orca/Bambu layer markers and extrusion bounds from G-code", () => {
  const summary = parseGcodeSummary([
    "; total layer number: 2",
    "; max_z_height: 5.00",
    "G90", "M83",
    "; CHANGE_LAYER",
    "G1 X10 Y20 Z0.2 E0.4",
    "G3 X30 Y20 I10 J0 E0.2",
    "; CHANGE_LAYER",
    "G1 X30 Y35 Z0.4 E0.2",
  ].join("\n"));
  assert.equal(summary.layers, 2);
  assert.deepEqual(summary.boundsMm, { min: [10, 10, 0], max: [30, 35, 5] });
  assert.equal(summary.boundsSource, "extrusion-path-estimate");
  assert.deepEqual(summary.toolpathBoundsMm, { min: [10, 10, 0.2], max: [30, 35, 0.4] });
  assert.deepEqual(summary.depositionLayerZMm, [0.2, 0.4]);
});

test("includes signed-radius arc extrema in extrusion bounds", () => {
  const summary = parseGcodeSummary([
    "G90", "M83", "G92 X10 Y0 Z0", ";LAYER_CHANGE",
    "G17 G3 X0 Y10 R-10 Z0.2 E1",
  ].join("\n"));

  assert.deepEqual(summary.toolpathBoundsMm, { min: [0, 0, 0.2], max: [20, 20, 0.2] });
  assert.deepEqual(summary.boundsMm, { min: [0, 0, 0.2], max: [20, 20, 0.2] });
  assert.equal(summary.boundsSource, "extrusion-path-estimate");
});

test("records actual G-code deposition Z values for nonuniform slicer layers", () => {
  const summary = parseGcodeSummary([
    "; total layer number: 3",
    "G90", "M82",
    ";LAYER_CHANGE",
    "G1 Z0.24 F600", "G1 X10 Y10 E1",
    ";LAYER_CHANGE",
    "G1 Z0.42 F600", "G1 X20 Y10 E2",
    ";LAYER_CHANGE",
    "G1 Z0.66 F600", "G1 X20 Y20 E3",
  ].join("\n"));
  assert.deepEqual(summary.depositionLayerZMm, [0.24, 0.42, 0.66]);
});

test("summarizes per-layer planar deposition-road directions from extrusion moves", () => {
  const summary = parseGcodeSummary([
    "; total layer number: 2", "G90", "M82", ";LAYER_CHANGE",
    "G1 X10 Y0 Z0.2 E1", "G1 X20 Y0 E2", "G1 X20 Y10 E3",
    ";LAYER_CHANGE", "G1 X20 Y20 Z0.4 E4",
  ].join("\n"));

  assert.deepEqual(summary.depositionLayerPathOrientations, [
    { layerIndex: 1, planarPathLengthMm: 30, principalDirectionDeg: 0, directionalConcentration: 0.333333, curvedExtrusionMoves: 0, coverage: "complete-linear" },
    { layerIndex: 2, planarPathLengthMm: 10, principalDirectionDeg: 90, directionalConcentration: 1, curvedExtrusionMoves: 0, coverage: "complete-linear" },
  ]);
});

test("wraps a rounded 180-degree principal road axis back to zero degrees", () => {
  const summary = parseGcodeSummary([
    "G90", "M82", "G92 X100 Y0 E0", ";LAYER_CHANGE",
    "G1 X0 Y0.0000001 Z0.2 E1",
  ].join("\n"));

  assert.equal(summary.depositionLayerPathOrientations?.[0]?.principalDirectionDeg, 0);
});

test("leaves the principal road axis undefined when a layer has balanced orthogonal paths", () => {
  const summary = parseGcodeSummary([
    "; total layer number: 1", "G90", "M82", ";LAYER_CHANGE",
    "G1 X10 Y0 Z0.2 E1", "G1 X10 Y10 E2",
  ].join("\n"));

  assert.deepEqual(summary.depositionLayerPathOrientations, [
    { layerIndex: 1, planarPathLengthMm: 20, principalDirectionDeg: null, directionalConcentration: 0, curvedExtrusionMoves: 0, coverage: "complete-linear" },
  ]);
});

test("marks layer-road direction as partial when G-code deposits along unsupported splines", () => {
  const summary = parseGcodeSummary([
    "; total layer number: 2", "G90", "M83", ";LAYER_CHANGE",
    "G5 X20 Y0 I5 J0 P5 Q0 E1",
    ";LAYER_CHANGE", "G1 X20 Y10 Z0.4 E1",
  ].join("\n"));

  assert.deepEqual(summary.depositionLayerPathOrientations, [
    { layerIndex: 1, planarPathLengthMm: 0, principalDirectionDeg: null, directionalConcentration: null, curvedExtrusionMoves: 1, coverage: "partial-curved" },
    { layerIndex: 2, planarPathLengthMm: 10, principalDirectionDeg: 90, directionalConcentration: 1, curvedExtrusionMoves: 0, coverage: "complete-linear" },
  ]);
});

test("integrates a circular extrusion arc into the exact per-layer road orientation", () => {
  const summary = parseGcodeSummary([
    "G90", "M82", "G92 X10 Y0 Z0 E0", ";LAYER_CHANGE",
    "G3 X0 Y10 I-10 J0 Z0.2 E1",
  ].join("\n"));

  assert.deepEqual(summary.depositionLayerPathOrientations, [
    {
      layerIndex: 1,
      planarPathLengthMm: 15.707963,
      principalDirectionDeg: 135,
      directionalConcentration: 0.63662,
      curvedExtrusionMoves: 1,
      coverage: "complete-planar",
    },
  ]);
});

test("integrates a short radius-format circular extrusion arc", () => {
  const summary = parseGcodeSummary([
    "G90", "M82", "G92 X10 Y0 Z0 E0", ";LAYER_CHANGE",
    "G17 G3 X0 Y10 R10 Z0.2 E1",
  ].join("\n"));

  assert.deepEqual(summary.depositionLayerPathOrientations, [
    {
      layerIndex: 1,
      planarPathLengthMm: 15.707963,
      principalDirectionDeg: 135,
      directionalConcentration: 0.63662,
      curvedExtrusionMoves: 1,
      coverage: "complete-planar",
    },
  ]);
});

test("uses a negative radius to select the major circular extrusion arc", () => {
  const summary = parseGcodeSummary([
    "G90", "M82", "G92 X10 Y0 Z0 E0", ";LAYER_CHANGE",
    "G3 X0 Y10 R-10 Z0.2 E1",
  ].join("\n"));

  assert.deepEqual(summary.depositionLayerPathOrientations, [
    {
      layerIndex: 1,
      planarPathLengthMm: 47.12389,
      principalDirectionDeg: 45,
      directionalConcentration: 0.212207,
      curvedExtrusionMoves: 1,
      coverage: "complete-planar",
    },
  ]);
});

test("integrates clockwise radius-format arcs and selects their signed sweep", () => {
  const summary = parseGcodeSummary([
    "G90", "M82", "G92 X10 Y0 Z0 E0", ";LAYER_CHANGE",
    "G2 X0 Y10 R10 Z0.2 E1",
    "G2 X10 Y20 R-10 E2",
  ].join("\n"));

  assert.deepEqual(summary.depositionLayerPathOrientations, [
    {
      layerIndex: 1,
      planarPathLengthMm: 62.831853,
      principalDirectionDeg: 135,
      directionalConcentration: 0.31831,
      curvedExtrusionMoves: 2,
      coverage: "complete-planar",
    },
  ]);
});

test("handles the semicircle boundary for both signed radius formats", () => {
  for (const command of ["G3 X-10 Y0 R10 E1", "G2 X-10 Y0 R-10 E1"]) {
    const summary = parseGcodeSummary([
      "G90", "M82", "G92 X10 Y0 Z0 E0", ";LAYER_CHANGE", command,
    ].join("\n"));

    assert.deepEqual(summary.depositionLayerPathOrientations, [
      {
        layerIndex: 1,
        planarPathLengthMm: 31.415927,
        principalDirectionDeg: null,
        directionalConcentration: 0,
        curvedExtrusionMoves: 1,
        coverage: "complete-planar",
      },
    ]);
  }
});

test("keeps non-XY arcs and absolute I/J center arcs out of the layer XY estimate", () => {
  const nonXy = parseGcodeSummary([
    "G90", "M82", "G92 X10 Y0 Z0 E0", ";LAYER_CHANGE",
    "G18 G2 X0 Y10 I-10 J0 Z0.2 E1",
  ].join("\n"));
  const absoluteCenter = parseGcodeSummary([
    "G90", "M82", "G92 X10 Y0 Z0 E0", ";LAYER_CHANGE",
    "G90.1 G3 X0 Y10 I0 J0 Z0.2 E1",
  ].join("\n"));

  for (const summary of [nonXy, absoluteCenter]) {
    assert.deepEqual(summary.depositionLayerPathOrientations, [
      {
        layerIndex: 1,
        planarPathLengthMm: 0,
        principalDirectionDeg: null,
        directionalConcentration: null,
        curvedExtrusionMoves: 1,
        coverage: "partial-curved",
      },
    ]);
  }
});

test("keeps impossible, mixed-format, and zero-radius arcs partial", () => {
  const summary = parseGcodeSummary([
    "G90", "M82", "G92 X10 Y0 Z0 E0", ";LAYER_CHANGE",
    "G3 X0 Y10 R4 Z0.2 E1", // Chord exceeds the specified diameter.
    "G3 X0 Y10 I-10 J0 R10 E2", // Center-offset and radius forms cannot mix.
    "G3 X0 Y10 R10 E3", // Radius format cannot describe a full circle.
  ].join("\n"));

  assert.deepEqual(summary.depositionLayerPathOrientations, [
    {
      layerIndex: 1,
      planarPathLengthMm: 0,
      principalDirectionDeg: null,
      directionalConcentration: null,
      curvedExtrusionMoves: 3,
      coverage: "partial-curved",
    },
  ]);
});

test("keeps extrusion Bézier splines partial", () => {
  const summary = parseGcodeSummary([
    "G90", "M82", "G92 X10 Y0 Z0 E0", ";LAYER_CHANGE",
    "G5.1 X0 Y10 I-3 J0 P0 Q3 Z0.2 E1",
  ].join("\n"));

  assert.deepEqual(summary.depositionLayerPathOrientations, [
    {
      layerIndex: 1,
      planarPathLengthMm: 0,
      principalDirectionDeg: null,
      directionalConcentration: null,
      curvedExtrusionMoves: 1,
      coverage: "partial-curved",
    },
  ]);
});

test("keeps G5.2/G5.3 NURBS blocks partial instead of treating them as linear", () => {
  const summary = parseGcodeSummary([
    "G90", "M82", "G92 X10 Y0 Z0 E0", ";LAYER_CHANGE",
    "G5.2 P1 L3",
    "X8 Y3 P1", "X4 Y7 P1", "X0 Y10 P1",
    "G5.3 X0 Y10 Z0.2 E1",
  ].join("\n"));

  assert.deepEqual(summary.depositionLayerPathOrientations, [
    {
      layerIndex: 1,
      planarPathLengthMm: 0,
      principalDirectionDeg: null,
      directionalConcentration: null,
      curvedExtrusionMoves: 1,
      coverage: "partial-curved",
    },
  ]);
});

test("keeps multi-turn circular G-code arcs partial instead of undercounting their path", () => {
  const summary = parseGcodeSummary([
    "G90", "M82", "G92 X10 Y0 Z0 E0", ";LAYER_CHANGE",
    "G3 X0 Y10 I-10 J0 P2 Z0.2 E1",
  ].join("\n"));

  assert.deepEqual(summary.depositionLayerPathOrientations, [
    { layerIndex: 1, planarPathLengthMm: 0, principalDirectionDeg: null, directionalConcentration: null, curvedExtrusionMoves: 1, coverage: "partial-curved" },
  ]);
});

test("omits the G-code deposition Z schedule when layer markers do not cover every declared layer", () => {
  const summary = parseGcodeSummary([
    "; total layer number: 3",
    "G90", "M83", ";LAYER_CHANGE",
    "G1 X10 Y20 Z0.2 E0.4", ";LAYER_CHANGE",
    "G1 X20 Y30 Z0.4 E0.4",
  ].join("\n"));
  assert.equal(summary.depositionLayerZMm, undefined);
});

test("uses Orca object polygons for model fit bounds and keeps extrusion bounds separate", () => {
  const summary = parseGcodeSummary([
    "; total layer number: 25",
    "; max_z_height: 5.00",
    "EXCLUDE_OBJECT_DEFINE NAME=model.stl_id_0_copy_0 CENTER=110,110 POLYGON=[[100,105],[120,105],[120,115],[100,115],[100,105]]",
    "G90", "M83", ";LAYER_CHANGE",
    "G1 X100.4 Y105.4 Z0.2 E0.4",
    "G1 X119.6 Y105.4 E0.8",
    "G1 X119.6 Y114.6 E1.2",
    "G1 X100.4 Y114.6 E1.6",
    "G1 X100.4 Y105.4 E2.0",
  ].join("\n"));
  assert.deepEqual(summary.boundsMm, { min: [100, 105, 0], max: [120, 115, 5] });
  assert.equal(summary.boundsSource, "slicer-object-metadata");
  assert.deepEqual(summary.toolpathBoundsMm, { min: [100.4, 105.4, 0.2], max: [119.6, 114.6, 0.2] });
});

test("unions every Orca object polygon when reporting the arranged model bounds", () => {
  const summary = parseGcodeSummary([
    "; max_z_height: 8.00",
    "EXCLUDE_OBJECT_DEFINE NAME=left CENTER=0,0 POLYGON=[[-5,20],[5,20],[5,30],[-5,30],[-5,20]]",
    "EXCLUDE_OBJECT_DEFINE NAME=right CENTER=10,40 POLYGON=[[5,35],[15,35],[15,45],[5,45],[5,35]]",
  ].join("\n"));
  assert.deepEqual(summary.boundsMm, { min: [-5, 20, 0], max: [15, 45, 8] });
  assert.equal(summary.boundsSource, "slicer-object-metadata");
});

test("Creality Print adapter copies profiles and parses the produced G-code", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-slicer-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const source = join(root, "part.stl");
  const profile = fixtureProfile(root);
  await Promise.all([
    writeFile(source, "solid part\nendsolid part\n"),
    writeFile(profile.slicer.machineConfigPath, "{}"),
    writeFile(profile.slicer.processConfigPath, "{}"),
    writeFile(profile.slicer.filamentConfigPath, "{}"),
  ]);
  let observedArgs: string[] = [];
  const slicer = new CrealityPrintSlicer("/Applications/Creality Print", async (_executable, args, options) => {
    observedArgs = args;
    await writeFile(join(options.cwd, "output", "plate_1.gcode"), sampleGcode());
    return { stdout: "sliced", stderr: "" };
  });
  const result = await slicer.slice(source, "part.stl", profile, join(root, "job"));
  assert.equal(observedArgs.includes("--slice"), true);
  assert.deepEqual(observedArgs.slice(observedArgs.indexOf("--datadir"), observedArgs.indexOf("--datadir") + 2), ["--datadir", join(root, "job", "slicer-data")]);
  assert.equal(observedArgs.at(-1), join(root, "job", "model.stl"));
  assert.equal(result.summary.layers, 50);
  assert.equal(result.summary.estimatedSeconds, 557);
  assert.equal(result.summary.filamentMassG, 2.12);
  await assert.rejects(
    () => slicer.slice(source, "part.step", profile, join(root, "unsupported-job")),
    /Creality Print 7\.2 CLI input must be STL, OBJ, or AMF/,
  );
});

test("discovers Creality profiles and CLI from an explicitly selected app bundle", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-creality-app-profile-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const profilesRoot = join(root, "Contents", "Resources", "profiles", "Creality");
  const machinePath = join(profilesRoot, "machine", "Creality K1C 0.4 nozzle.json");
  const processPath = join(profilesRoot, "process", "0.20mm Standard @Creality K1C 0.4 nozzle.json");
  const filamentPath = join(profilesRoot, "filament", "Generic PLA @Creality K1C 0.4 nozzle.json");
  const executable = join(root, "Contents", "MacOS", "CrealityPrint");
  await Promise.all([
    mkdir(join(profilesRoot, "machine"), { recursive: true }),
    mkdir(join(profilesRoot, "process"), { recursive: true }),
    mkdir(join(profilesRoot, "filament"), { recursive: true }),
    mkdir(join(root, "Contents", "MacOS"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(machinePath, JSON.stringify({ printer_model: "Creality K1C", printable_area: ["220x220"], printable_height: 250, nozzle_diameter: ["0.4"] })),
    writeFile(processPath, JSON.stringify({ name: "0.20mm Standard @Creality K1C 0.4 nozzle", layer_height: 0.2 })),
    writeFile(filamentPath, JSON.stringify({ name: "Generic PLA", filament_type: ["PLA"] })),
    writeFile(executable, "test CLI"),
  ]);

  const catalog = await discoverManufacturingProfiles({
    crealityProfilesRoot: profilesRoot,
    crealityExecutable: executable,
  });

  assert.equal(catalog.adapters.find((adapter) => adapter.id === "creality-print")?.executable, executable);
  assert.equal(catalog.profiles[0]?.printer.model, "Creality K1C");
  assert.equal(catalog.profiles[0]?.slicer.nominalInfillPercent, undefined);
  assert.equal(catalog.profiles[0]?.slicer.sparseInfillPattern, undefined);
  assert.equal(catalog.profiles[0]?.slicer.wallLoops, undefined);
  assert.equal(catalog.profiles[0]?.slicer.machineConfigPath, machinePath);
});

test("discovers multiple machine-compatible Creality filaments instead of pinning K1C to Generic PLA", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-creality-filaments-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const profilesRoot = join(root, "profiles", "Creality");
  const executable = join(root, "CrealityPrint");
  const machineName = "Creality K1C 0.4 nozzle";
  const machinePath = join(profilesRoot, "machine", `${machineName}.json`);
  const processName = "0.20mm Standard @Creality K1C 0.4 nozzle";
  const processPath = join(profilesRoot, "process", `${processName}.json`);
  await Promise.all([
    mkdir(join(profilesRoot, "machine"), { recursive: true }),
    mkdir(join(profilesRoot, "process"), { recursive: true }),
    mkdir(join(profilesRoot, "filament"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(machinePath, JSON.stringify({
      name: machineName, printer_model: "Creality K1C", printable_area: ["0x0", "220x0", "220x220", "0x220"],
      printable_height: 250, nozzle_diameter: ["0.4"], default_filament_profile: ["Hyper PLA @Creality K1C 0.4 nozzle"],
    })),
    writeFile(processPath, JSON.stringify({
      name: processName, layer_height: 0.2, sparse_infill_density: "15%", sparse_infill_pattern: "grid",
      wall_loops: "2", top_shell_layers: "5", bottom_shell_layers: "3",
    })),
    writeFile(join(profilesRoot, "filament", "fdm_filament_pla.json"), JSON.stringify({
      name: "fdm_filament_pla", filament_type: ["PLA"], filament_vendor: ["Generic"], nozzle_temperature: "210", hot_plate_temp: "50",
    })),
    writeFile(join(profilesRoot, "filament", "Generic PLA @Creality K1C 0.4 nozzle.json"), JSON.stringify({
      name: "Generic PLA @Creality K1C 0.4 nozzle", inherits: "fdm_filament_pla", compatible_printers: [machineName],
    })),
    writeFile(join(profilesRoot, "filament", "CR-PLA @Creality K1C 0.4 nozzle.json"), JSON.stringify({
      name: "CR-PLA @Creality K1C 0.4 nozzle", inherits: "fdm_filament_pla", compatible_printers: [machineName],
      filament_vendor: ["Creality"], nozzle_temperature: "220", hot_plate_temp: "50",
    })),
    writeFile(join(profilesRoot, "filament", "Hyper PLA @Creality K1C 0.4 nozzle.json"), JSON.stringify({
      name: "Hyper PLA @Creality K1C 0.4 nozzle", inherits: "fdm_filament_pla", compatible_printers: [machineName],
      filament_vendor: ["Creality"], nozzle_temperature: "230", hot_plate_temp: "50",
    })),
    writeFile(join(profilesRoot, "filament", "CR-PLA @Creality K2 0.4 nozzle.json"), JSON.stringify({
      name: "CR-PLA @Creality K2 0.4 nozzle", inherits: "fdm_filament_pla", compatible_printers: ["Creality K2 0.4 nozzle"],
      filament_vendor: ["Creality"], nozzle_temperature: "220", hot_plate_temp: "50",
    })),
    writeFile(executable, "test CLI"),
  ]);

  const catalog = await discoverManufacturingProfiles({ crealityProfilesRoot: profilesRoot, crealityExecutable: executable });
  const k1cProfiles = catalog.profiles.filter((profile) => profile.slicer.slicer === "creality-print" && profile.printer.model === "Creality K1C");

  assert.deepEqual(k1cProfiles.map((profile) => profile.material.name).sort(), ["CR-PLA", "Generic PLA", "Hyper PLA"]);
  assert.equal(k1cProfiles.find((profile) => profile.material.name === "CR-PLA")?.material.vendor, "Creality");
  assert.equal(new Set(k1cProfiles.map((profile) => profile.slicer.id)).size, 3);
  assert.ok(k1cProfiles.every((profile) => profile.slicer.layerHeightMm === 0.2));
  assert.ok(k1cProfiles.every((profile) => profile.slicer.nominalInfillPercent === 15));
  assert.ok(k1cProfiles.every((profile) => profile.slicer.sparseInfillPattern === "grid"));
  assert.ok(k1cProfiles.every((profile) => profile.slicer.wallLoops === 2));
  assert.ok(k1cProfiles.every((profile) => profile.slicer.topShellLayers === 5 && profile.slicer.bottomShellLayers === 3));
  assert.equal(k1cProfiles.find((profile) => profile.material.name === "Hyper PLA")?.material.nozzleTemperatureC, 230);
  assert.ok(k1cProfiles.find((profile) => profile.material.name === "CR-PLA")?.slicer.filamentConfigPath.endsWith("CR-PLA @Creality K1C 0.4 nozzle.json"));
});

test("Orca-family adapters use immutable profiles and produce one inspectable G-code", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-orca-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const source = join(root, "part.stl");
  const profile = fixtureProfile(root);
  profile.slicer.slicer = "orca-slicer";
  await Promise.all([
    writeFile(source, "solid part\nendsolid part\n"),
    writeFile(profile.slicer.machineConfigPath, "{}"),
    writeFile(profile.slicer.processConfigPath, "{}"),
    writeFile(profile.slicer.filamentConfigPath, "{}"),
  ]);
  let observedArgs: string[] = [];
  const slicer = new OrcaFamilySlicer("orca-slicer", "/Applications/OrcaSlicer", async (_executable, args, options) => {
    observedArgs = args;
    await writeFile(join(options.cwd, "output", "plate_1.gcode"), sampleGcode());
    return { stdout: "sliced", stderr: "" };
  });
  const result = await slicer.slice(source, "part.stl", profile, join(root, "job"));
  assert.deepEqual(observedArgs.slice(-3, -1), ["--outputdir", join(root, "job", "output")]);
  assert.equal(observedArgs.includes("--orient"), true);
  assert.equal(result.summary.layers, 50);
  await assert.rejects(() => slicer.slice(source, "part.step", profile, join(root, "unsupported")), /Orca\/Bambu CLI input/);
});

test("approval is bound to the exact project revision and cannot be reused after edits", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-print-approval-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "workbench.sqlite"));
  context.after(() => database.close());
  const projects = new SqliteProjectStore(database);
  const artifacts = new ArtifactStore(join(root, "artifacts"), database);
  const project = projects.create("Approved bracket", root);
  const source = await artifacts.put(Readable.from("solid"), { mediaType: "model/stl", originalName: "part.stl" });
  const gcode = await artifacts.put(Readable.from(sampleGcode()), { mediaType: "text/x-gcode", originalName: "part.gcode" });
  artifacts.attachToProject(project.id, source.hash);
  artifacts.attachToProject(project.id, gcode.hash);
  const store = new ManufacturingJobStore(database);
  const report = assessPrintability({ sizeMm: [20, 20, 10] }, fixtureProfile(root));
  const created = store.create(project.id, 0, source.hash, fixtureProfile(root), report);
  store.complete(created.id, gcode.hash, parseGcodeSummary(sampleGcode()));
  const approved = store.approve(created.id, 0);
  assert.equal(approved.state, "approved");
  projects.publishStatus(project.id, 0, "Geometry changed");
  assert.throws(() => store.beginSubmission(created.id, 1), /project changed after approval/i);
});

test("an unavailable Bambu adapter does not turn an approved job into an uncertain submission", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-bambu-unavailable-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "workbench.sqlite"));
  context.after(() => database.close());
  const projects = new SqliteProjectStore(database);
  const artifacts = new ArtifactStore(join(root, "artifacts"), database);
  const project = projects.create("Bambu bracket", root);
  const profile = fixtureProfile(root);
  profile.printer = {
    ...profile.printer,
    id: "bambu-a1",
    vendor: "Bambu Lab",
    model: "Bambu Lab A1",
    buildVolumeMm: [256, 256, 256],
    connection: { kind: "bambu-lan", host: "192.168.1.80", port: 8883 },
  };
  profile.slicer = { ...profile.slicer, slicer: "orca-slicer" };
  const source = await artifacts.put(Readable.from("solid"), { mediaType: "model/stl", originalName: "part.stl" });
  const gcode = await artifacts.put(Readable.from(sampleGcode()), { mediaType: "text/x-gcode", originalName: "part.gcode" });
  artifacts.attachToProject(project.id, source.hash);
  artifacts.attachToProject(project.id, gcode.hash);
  const jobs = new ManufacturingJobStore(database);
  const job = jobs.create(project.id, 0, source.hash, profile, assessPrintability({ sizeMm: [20, 20, 10] }, profile));
  jobs.complete(job.id, gcode.hash, parseGcodeSummary(sampleGcode()));
  jobs.approve(job.id, 0);
  const service = new ManufacturingService(
    jobs,
    projects,
    artifacts,
    { profiles: [profile], records: [], adapters: [] },
    new ManufacturingProfileStore(database, join(root, "registry")),
    new Map(),
    new Map(),
  );

  await assert.rejects(() => service.submit(project.id, job.id), /Direct Bambu LAN status and print control are not available/);
  assert.equal(jobs.get(job.id)?.state, "approved");
});

test("approval is bound to the exact DFM warning set", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-print-warning-approval-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "workbench.sqlite"));
  context.after(() => database.close());
  const projects = new SqliteProjectStore(database);
  const artifacts = new ArtifactStore(join(root, "artifacts"), database);
  const project = projects.create("Warning-bound bracket", root);
  const source = await artifacts.put(Readable.from("solid"), { mediaType: "model/stl", originalName: "part.stl" });
  const gcode = await artifacts.put(Readable.from(sampleGcode()), { mediaType: "text/x-gcode", originalName: "part.gcode" });
  artifacts.attachToProject(project.id, source.hash);
  artifacts.attachToProject(project.id, gcode.hash);
  const store = new ManufacturingJobStore(database);
  const report = assessPrintability({ sizeMm: [20, 20, 10] }, fixtureProfile(root));
  const created = store.create(project.id, 0, source.hash, fixtureProfile(root), report);
  store.complete(created.id, gcode.hash, parseGcodeSummary(sampleGcode()));
  store.approve(created.id, 0);
  database.prepare("UPDATE manufacturing_jobs SET dfm_report_json = ? WHERE id = ?").run(
    JSON.stringify({ ...report, findings: [{ code: "new-warning", severity: "warning", message: "Changed after approval" }] }),
    created.id,
  );
  assert.throws(() => store.beginSubmission(created.id, 0), /does not match the exact G-code, profile, warnings/i);
});

test("Moonraker reconciliation distinguishes submitted, stored, absent, and unreadable outcomes", async () => {
  const profile = fixtureProfile("/profiles").printer;
  const expected = "bracket-0123456789ab.gcode";
  const scenarios = [
    {
      name: "submitted",
      printStats: { result: { status: { print_stats: { filename: expected, state: "printing" } } } },
      files: [{ path: expected }],
      outcome: "submitted",
    },
    {
      name: "stored",
      printStats: { result: { status: { print_stats: { filename: "", state: "standby" } } } },
      files: { result: [{ path: expected }] },
      outcome: "stored",
    },
    {
      name: "absent",
      printStats: { result: { status: { print_stats: { filename: "", state: "standby" } } } },
      files: { result: { files: [{ path: "other.gcode" }] } },
      outcome: "absent",
    },
    {
      name: "another print is active",
      printStats: { result: { status: { print_stats: { filename: "other.gcode", state: "printing" } } } },
      files: { result: [] },
      outcome: "unknown",
    },
    {
      name: "missing print stats",
      printStats: { result: { status: {} } },
      files: { result: [] },
      outcome: "unknown",
    },
  ] as const;

  for (const scenario of scenarios) {
    const requests: Array<{ url: string; method: string }> = [];
    const printer = new MoonrakerPrinter(async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET" });
      const payload = url.includes("objects/query") ? scenario.printStats : scenario.files;
      return Response.json(payload);
    });
    const observation = await printer.reconcileSubmission(profile, expected);
    assert.equal(observation.outcome, scenario.outcome, scenario.name);
    assert.equal(observation.expectedRemoteFilename, expected);
    assert.equal(requests.length, 2);
    assert.equal(requests.every((request) => request.method === "GET"), true);
    assert.equal(requests.some((request) => request.url.includes("upload") || request.url.includes("print/start")), false);
  }

  const unreadable = new MoonrakerPrinter(async () => new Response("offline", { status: 503 }));
  const observation = await unreadable.reconcileSubmission(profile, expected);
  assert.equal(observation.outcome, "unknown");
  assert.match(observation.message, /HTTP 503/);
});

test("Moonraker status uses print_stats and blocks submission while another job is active", async () => {
  const profile = fixtureProfile("/profiles").printer;
  const requests: Array<{ url: string; method: string }> = [];
  const printer = new MoonrakerPrinter(async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET" });
    if (url.endsWith("/info") && !url.includes(":7125")) return Response.json({ model: "K1C" });
    if (url.includes("objects/query")) return Response.json({ result: { status: { print_stats: { filename: "other.gcode", state: "printing", message: "Printing" } } } });
    if (url.includes("printer/info")) return Response.json({ result: { state: "ready", hostname: "k1c" } });
    throw new Error(`Unexpected request: ${url}`);
  });

  const status = await printer.status(profile);
  assert.equal(status.state, "printing");
  assert.equal(status.stateMessage, "Printing");
  await assert.rejects(() => printer.uploadAndStart(profile, new Uint8Array([1, 2, 3]), "blocked.gcode"), /not idle: printing/i);
  assert.equal(requests.some((request) => request.method === "POST"), false);
});

test("Creality K1 uploads through the vendor endpoint before starting through Moonraker", async () => {
  const profile = fixtureProfile("/profiles").printer;
  let multipartKeys: string[] = [];
  let uploadUrl: string | undefined;
  let startedFilename: string | undefined;
  const printer = new MoonrakerPrinter(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/info") && !url.includes(":7125")) return Response.json({ model: "K1C" });
    if (url.includes("objects/query")) return Response.json({ result: { status: { print_stats: { filename: "", state: "standby" } } } });
    if (url.includes("printer/info")) return Response.json({ result: { state: "ready", hostname: "k1c" } });
    if (url.includes("/upload/")) {
      uploadUrl = url;
      assert.ok(init?.body instanceof FormData);
      multipartKeys = [...init.body.keys()];
      return new Response("ok");
    }
    if (url.includes("print/start")) {
      startedFilename = JSON.parse(String(init?.body)).filename;
      return Response.json({ result: "ok" });
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  const result = await printer.uploadAndStart(profile, new Uint8Array([1, 2, 3]), "ordered.gcode");

  assert.equal(uploadUrl, "http://10.0.0.2/upload/ordered.gcode");
  assert.deepEqual(multipartKeys, ["file"]);
  assert.equal(startedFilename, "ordered.gcode");
  assert.equal(result.remoteFilename, "ordered.gcode");
});

test("generic Moonraker uploads use the standard file endpoint", async () => {
  const profile = fixtureProfile("/profiles").printer;
  profile.vendor = "custom";
  profile.model = "Voron 2.4";
  let uploadUrl: string | undefined;
  let multipartKeys: string[] = [];
  const printer = new MoonrakerPrinter(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/info") && !url.includes(":7125")) return Response.json({ model: "Voron 2.4" });
    if (url.includes("objects/query")) return Response.json({ result: { status: { print_stats: { filename: "", state: "standby" } } } });
    if (url.includes("printer/info")) return Response.json({ result: { state: "ready", hostname: "voron" } });
    if (url.includes("files/upload")) {
      uploadUrl = url;
      assert.ok(init?.body instanceof FormData);
      multipartKeys = [...init.body.keys()];
      return Response.json({ item: { path: "accepted.gcode" } });
    }
    if (url.includes("print/start")) return Response.json({ result: "ok" });
    throw new Error(`Unexpected request: ${url}`);
  });

  const result = await printer.uploadAndStart(profile, new Uint8Array([1, 2, 3]), "requested.gcode");

  assert.equal(uploadUrl, "http://10.0.0.2:7125/server/files/upload");
  assert.deepEqual(multipartKeys, ["file"]);
  assert.equal(result.remoteFilename, "accepted.gcode");
});

test("printer filenames remain short ASCII for localized project names", () => {
  assert.equal(
    createRemoteGcodeFilename(
      "Пластина 80 × 40 × 8 с отверстиями",
      "e815d11e-b67b-4645-976b-aa3954836626",
      "9c113a5c8615e340e825a4e23e9072cded11c81512149f163d772762a354ae09",
    ),
    "80-40-8-e815d11e-9c113a5c8615.gcode",
  );
  assert.equal(
    createRemoteGcodeFilename("Кронштейн", "e815d11e-rest", "9c113a5c8615rest"),
    "plasticity-e815d11e-9c113a5c8615.gcode",
  );
  assert.equal(
    createRemoteGcodeFilename("Crème bracket / v2", "01234567-rest", "abcdef0123456789"),
    "creme-bracket-v2-01234567-abcdef012345.gcode",
  );
});

test("unknown submissions become approved only after confirmed absence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-print-reconcile-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "workbench.sqlite"));
  context.after(() => database.close());
  const projects = new SqliteProjectStore(database);
  const artifacts = new ArtifactStore(join(root, "artifacts"), database);
  const project = projects.create("Reconciled bracket", root);
  const source = await artifacts.put(Readable.from("solid"), { mediaType: "model/stl", originalName: "part.stl" });
  const gcode = await artifacts.put(Readable.from(sampleGcode()), { mediaType: "text/x-gcode", originalName: "part.gcode" });
  artifacts.attachToProject(project.id, source.hash);
  artifacts.attachToProject(project.id, gcode.hash);
  const store = new ManufacturingJobStore(database);
  const report = assessPrintability({ sizeMm: [20, 20, 10] }, fixtureProfile(root));
  const created = store.create(project.id, 0, source.hash, fixtureProfile(root), report);
  store.complete(created.id, gcode.hash, parseGcodeSummary(sampleGcode()));
  store.approve(created.id, 0);
  store.beginSubmission(created.id, 0);
  store.uncertain(created.id, "timeout");

  const restored = store.reconcileAbsent(created.id, 0);
  assert.equal(restored.state, "approved");
  assert.equal(restored.failure, undefined);
  store.beginSubmission(created.id, 0);
  store.uncertain(created.id, "connection reset");
  const submitted = store.reconcileSubmitted(created.id, "reconciled.gcode");
  assert.equal(submitted.state, "submitted");
  assert.equal(submitted.remoteFilename, "reconciled.gcode");
  assert.equal(submitted.failure, undefined);
});

test("service reconciliation never uploads and only transitions on conclusive evidence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-print-service-reconcile-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "workbench.sqlite"));
  context.after(() => database.close());
  const projects = new SqliteProjectStore(database);
  const artifacts = new ArtifactStore(join(root, "artifacts"), database);
  const project = projects.create("Service bracket", root);
  const profile = fixtureProfile(root);
  const source = await artifacts.put(Readable.from("solid"), { mediaType: "model/stl", originalName: "part.stl" });
  const gcode = await artifacts.put(Readable.from(sampleGcode()), { mediaType: "text/x-gcode", originalName: "part.gcode" });
  artifacts.attachToProject(project.id, source.hash);
  artifacts.attachToProject(project.id, gcode.hash);
  const jobs = new ManufacturingJobStore(database);
  const created = jobs.create(project.id, 0, source.hash, profile, assessPrintability({ sizeMm: [20, 20, 10] }, profile));
  jobs.complete(created.id, gcode.hash, parseGcodeSummary(sampleGcode()));
  jobs.approve(created.id, 0);
  jobs.beginSubmission(created.id, 0);
  jobs.uncertain(created.id, "timeout");

  let outcome: PrinterSubmissionObservation["outcome"] = "absent";
  let reconcileCalls = 0;
  let uploadCalls = 0;
  const printer: PrinterAdapter = {
    connectionKind: "moonraker",
    async status() {
      return { identity: { vendor: "Creality", model: "Creality K1C", host: "10.0.0.2" }, connected: true, state: "ready", observedAt: new Date().toISOString() };
    },
    async uploadAndStart() {
      uploadCalls += 1;
      throw new Error("must not upload during reconciliation");
    },
    async reconcileSubmission(_printerProfile, expectedRemoteFilename) {
      reconcileCalls += 1;
      return { outcome, expectedRemoteFilename, message: outcome, observedAt: new Date().toISOString() };
    },
  };
  const service = new ManufacturingService(
    jobs,
    projects,
    artifacts,
    { profiles: [profile], records: [], adapters: [] },
    new ManufacturingProfileStore(database, join(root, "registry")),
    new Map(),
    new Map([["moonraker", printer]]),
  );

  const absent = await service.reconcileSubmission(project.id, created.id);
  assert.equal(absent.job.state, "approved");
  assert.match(absent.observation.expectedRemoteFilename, new RegExp(`${created.id.slice(0, 8)}-${gcode.hash.slice(0, 12)}\\.gcode$`));
  jobs.beginSubmission(created.id, 0);
  jobs.uncertain(created.id, "connection reset");
  outcome = "stored";
  const stored = await service.reconcileSubmission(project.id, created.id);
  assert.equal(stored.job.state, "unknown");
  outcome = "submitted";
  const submitted = await service.reconcileSubmission(project.id, created.id);
  assert.equal(submitted.job.state, "submitted");
  assert.equal(reconcileCalls, 3);
  assert.equal(uploadCalls, 0);
});

test("preserves a third-party vendor while copying configs into an immutable registry", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-profile-registry-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const database = openDatabase(join(root, "workbench.sqlite"));
  context.after(() => database.close());
  const source = join(root, "source");
  await Promise.all([
    writeFile(`${source}-machine.json`, JSON.stringify({ printer_model: "Prusa MK4" })),
    writeFile(`${source}-process.json`, JSON.stringify({ layer_height: 0.2 })),
    writeFile(`${source}-filament.json`, JSON.stringify({ filament_type: ["PLA"] })),
  ]);
  const profile = fixtureProfile(root);
  profile.printer.id = "custom-220";
  profile.printer.vendor = "Prusa Research";
  profile.printer.model = "Prusa MK4";
  profile.slicer.machineConfigPath = `${source}-machine.json`;
  profile.slicer.processConfigPath = `${source}-process.json`;
  profile.slicer.filamentConfigPath = `${source}-filament.json`;
  const store = new ManufacturingProfileStore(database, join(root, "registry"));
  const record = await store.register({ profile, verification: "draft", notes: "Needs dimensional calibration" });

  assert.notEqual(record.profile.slicer.machineConfigPath, profile.slicer.machineConfigPath);
  assert.equal(record.profile.printer.vendor, "Prusa Research");
  assert.equal(record.configHashes.machine.length, 64);
  assert.match(record.profileHash, /^[a-f0-9]{64}$/);
  assert.equal(store.list()[0]?.profileHash, record.profileHash);
  assert.equal(store.list()[0]?.verification, "draft");
  await assert.rejects(() => store.register({ profile, verification: "draft" }), /unique/i);

  const changedProfile = structuredClone(profile);
  changedProfile.slicer.id = "custom-process-revised";
  await writeFile(`${source}-process.json`, JSON.stringify({ layer_height: 0.16 }));
  const changedRecord = await store.register({ profile: changedProfile, verification: "draft", notes: "Updated process preset" });
  assert.notEqual(changedRecord.configHashes.process, record.configHashes.process);
  assert.notEqual(changedRecord.profileHash, record.profileHash);
});

test("discovers a compatible Bambu profile and resolves its inherited full CLI configs", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-bambu-profiles-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const resources = join(root, "resources");
  const profiles = join(resources, "profiles");
  const bbl = join(profiles, "BBL");
  await mkdir(profiles, { recursive: true });
  const writeJson = async (relative: string, value: unknown) => {
    const path = join(bbl, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(value));
  };
  await writeFile(join(profiles, "BBL.json"), JSON.stringify({
    name: "Bambulab",
    machine_list: [
      { name: "Bambu Lab A1 0.4 nozzle", sub_path: "machine/a1-04.json" },
      { name: "A1 common", sub_path: "machine/common.json" },
      { name: "machine start", sub_path: "machine/start.json" },
      { name: "outside machine", sub_path: "../../outside.json" },
    ],
    process_list: [
      { name: "0.20mm Standard @BBL A1", sub_path: "process/standard.json" },
      { name: "process base", sub_path: "process/base.json" },
    ],
    filament_list: [
      { name: "Generic PLA @BBL A1", sub_path: "filament/pla.json" },
      { name: "Generic PLA @base", sub_path: "filament/base.json" },
    ],
  }));
  await writeFile(join(resources, "outside.json"), JSON.stringify({ type: "machine", printer_model: "Untrusted Outside", nozzle_diameter: ["0.4"] }));
  await Promise.all([
    writeJson("machine/common.json", { type: "machine", name: "A1 common", printable_area: ["0x0", "256x0", "256x256", "0x256"], printable_height: "256", common_setting: "base" }),
    writeJson("machine/start.json", { type: "machine", name: "machine start", machine_start_gcode: "G28" }),
    writeJson("machine/a1-04.json", { type: "machine", name: "Bambu Lab A1 0.4 nozzle", inherits: "A1 common", include: ["machine start"], printer_model: "Bambu Lab A1", nozzle_diameter: ["0.4"], default_print_profile: "0.20mm Standard @BBL A1", default_filament_profile: ["Generic PLA @BBL A1"] }),
    writeJson("process/base.json", { type: "process", name: "process base", layer_height: "0.2", enable_support: "0", wall_loops: "3" }),
    writeJson("process/standard.json", { type: "process", name: "0.20mm Standard @BBL A1", inherits: "process base", compatible_printers: ["Bambu Lab A1 0.4 nozzle"], enable_support: "1" }),
    writeJson("filament/base.json", { type: "filament", name: "Generic PLA @base", filament_type: ["PLA"], filament_vendor: ["Generic"], filament_density: "1.24", nozzle_temperature: ["215"], filament_max_volumetric_speed: "15" }),
    writeJson("filament/pla.json", { type: "filament", name: "Generic PLA @BBL A1", inherits: "Generic PLA @base", compatible_printers: ["Bambu Lab A1 0.4 nozzle"], hot_plate_temp: ["65"] }),
    writeFile(join(root, "BambuStudio"), "binary"),
  ]);

  const catalog = await discoverManufacturingProfiles({
    bambuStudioResourcesRoot: resources,
    bambuStudioExecutable: join(root, "BambuStudio"),
    resolvedProfilesRoot: join(root, "resolved"),
  });

  assert.equal(catalog.adapters.find((adapter) => adapter.id === "bambu-studio")?.available, true);
  assert.equal(catalog.profiles.filter((candidate) => candidate.slicer.slicer === "bambu-studio" && candidate.printer.vendor === "Bambu Lab").length, 1);
  const profile = catalog.profiles.find((candidate) => candidate.slicer.slicer === "bambu-studio" && candidate.printer.vendor === "Bambu Lab");
  assert.ok(profile);
  assert.equal(profile.printer.vendor, "Bambu Lab");
  assert.deepEqual(profile.printer.buildVolumeMm, [256, 256, 256]);
  assert.equal(profile.material.type, "PLA");
  assert.equal(profile.slicer.layerHeightMm, 0.2);
  assert.equal(profile.slicer.supportsEnabled, true);
  assert.equal(profile.slicer.slicer, "bambu-studio");
  const [machine, process, filament] = await Promise.all([
    readFile(profile.slicer.machineConfigPath, "utf8").then(JSON.parse),
    readFile(profile.slicer.processConfigPath, "utf8").then(JSON.parse),
    readFile(profile.slicer.filamentConfigPath, "utf8").then(JSON.parse),
  ]);
  assert.equal(machine.inherits, undefined);
  assert.equal(machine.common_setting, "base");
  assert.equal(machine.machine_start_gcode, "G28");
  assert.equal(process.wall_loops, "3");
  assert.equal(process.enable_support, "1");
  assert.equal(filament.filament_density, "1.24");
  assert.equal(filament.hot_plate_temp[0], "65");
  const source = join(root, "part.stl");
  await writeFile(source, "solid part\nendsolid part\n");
  let observedArgs: string[] = [];
  const slicer = new OrcaFamilySlicer("bambu-studio", join(root, "BambuStudio"), async (_executable, args, options) => {
    observedArgs = args;
    const machineAndProcess = args[args.indexOf("--load-settings") + 1]!.split(";");
    const [resolvedMachine, resolvedProcess] = await Promise.all(machineAndProcess.map((path) => readFile(path, "utf8").then(JSON.parse)));
    assert.equal(resolvedMachine.machine_start_gcode, "G28");
    assert.equal(resolvedProcess.wall_loops, "3");
    await writeFile(join(options.cwd, "output", "plate_1.gcode"), sampleGcode());
    return { stdout: "sliced", stderr: "" };
  });
  const sliced = await slicer.slice(source, "part.stl", profile, join(root, "slice-job"));
  assert.equal(observedArgs.includes(join(root, "slice-job", "slicer-data")), true);
  assert.equal(sliced.summary.layers, 50);
});

test("discovers Orca vendor manifests and every compatible default material", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-orca-vendor-profiles-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const resources = join(root, "resources");
  const profiles = join(resources, "profiles");
  const vendorRoot = join(profiles, "Prusa Research");
  const libraryRoot = join(profiles, "OrcaFilamentLibrary");
  const writeJson = async (base: string, relative: string, value: unknown) => {
    const path = join(base, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(value));
  };
  await mkdir(profiles, { recursive: true });
  await Promise.all([
    writeJson(profiles, "Prusa Research.json", {
      name: "Prusa Research",
      machine_list: [
        { name: "Prusa MK4 0.4 nozzle", sub_path: "machine/mk4.json" },
        { name: "fdm_machine_common", sub_path: "machine/common.json" },
      ],
      process_list: [
        { name: "0.20mm Standard @Prusa MK4", sub_path: "process/standard.json" },
        { name: "fdm_process_common", sub_path: "process/common.json" },
      ],
      filament_list: [],
    }),
    writeJson(profiles, "OrcaFilamentLibrary.json", {
      filament_list: [
        { name: "Generic PLA @System", sub_path: "filament/pla.json" },
        { name: "Generic PETG @System", sub_path: "filament/petg.json" },
        { name: "fdm_filament_base", sub_path: "filament/base.json" },
      ],
    }),
    writeJson(vendorRoot, "machine/common.json", {
      type: "machine", printable_area: ["0x0", "250x0", "250x210", "0x210"], printable_height: "220",
    }),
    writeJson(vendorRoot, "machine/mk4.json", {
      type: "machine", name: "Prusa MK4 0.4 nozzle", inherits: "fdm_machine_common",
      printer_model: "Prusa MK4", nozzle_diameter: ["0.4"],
      default_print_profile: "0.20mm Standard @Prusa MK4 (0.4 nozzle)",
      default_filament_profile: ["Generic PLA @System", "Generic PETG @System"],
    }),
    writeJson(vendorRoot, "process/common.json", { type: "process", wall_loops: "3" }),
    writeJson(vendorRoot, "process/standard.json", {
      type: "process", name: "0.20mm Standard @Prusa MK4", inherits: "fdm_process_common",
      layer_height: "0.2", enable_support: "0", compatible_printers: ["Prusa MK4 0.4 nozzle"],
    }),
    writeJson(libraryRoot, "filament/base.json", { type: "filament", filament_type: ["PLA"], filament_vendor: ["Generic"] }),
    writeJson(libraryRoot, "filament/pla.json", {
      type: "filament", name: "Generic PLA @System", inherits: "fdm_filament_base",
      nozzle_temperature: ["215"], hot_plate_temp: ["60"], filament_density: "1.24", compatible_printers: [],
    }),
    writeJson(libraryRoot, "filament/petg.json", {
      type: "filament", name: "Generic PETG @System", inherits: "fdm_filament_base",
      filament_type: ["PETG"], nozzle_temperature: ["240"], hot_plate_temp: ["80"], compatible_printers: [],
    }),
    writeFile(join(root, "OrcaSlicer"), "binary"),
  ]);

  const catalog = await discoverManufacturingProfiles({
    orcaSlicerResourcesRoot: resources,
    orcaSlicerExecutable: join(root, "OrcaSlicer"),
    resolvedProfilesRoot: join(root, "resolved"),
  });
  const discovered = catalog.profiles.filter((candidate) => candidate.printer.model === "Prusa MK4");
  assert.equal(discovered.length, 2);
  assert.deepEqual(discovered.map((candidate) => candidate.material.type).sort(), ["PETG", "PLA"]);
  assert.ok(discovered.every((candidate) => candidate.printer.vendor === "Prusa Research"));
  assert.ok(discovered.every((candidate) => candidate.printer.buildVolumeMm.join(",") === "250,210,220"));
  assert.ok(discovered.every((candidate) => candidate.slicer.slicer === "orca-slicer"));
  const pla = discovered.find((candidate) => candidate.material.type === "PLA");
  assert.ok(pla);
  const [machine, process, filament] = await Promise.all([
    readFile(pla.slicer.machineConfigPath, "utf8").then(JSON.parse),
    readFile(pla.slicer.processConfigPath, "utf8").then(JSON.parse),
    readFile(pla.slicer.filamentConfigPath, "utf8").then(JSON.parse),
  ]);
  assert.equal(machine.printable_height, "220");
  assert.equal(process.wall_loops, "3");
  assert.equal(filament.filament_type[0], "PLA");
});

function fixtureProfile(root: string): ManufacturingProfile {
  return {
    printer: { id: "k1c", vendor: "Creality", model: "Creality K1C", buildVolumeMm: [220, 220, 250], nozzleDiameterMm: 0.4, connection: { kind: "moonraker", host: "10.0.0.2", port: 7125 }, source: "user" },
    material: { id: "pla", name: "Generic PLA", type: "PLA", vendor: "Generic", nozzleTemperatureC: 220, bedTemperatureC: 50, source: "user" },
    slicer: { id: "standard", slicer: "creality-print", name: "0.20 Standard", layerHeightMm: 0.2, machineConfigPath: join(root, "machine.json"), processConfigPath: join(root, "process.json"), filamentConfigPath: join(root, "filament.json"), source: "user" },
  };
}

function sampleGcode(): string {
  return [
    "; total layer number: 50",
    "; MINX = 100.00", "; MINY = 100.00", "; MINZ = 0.00",
    "; MAXX = 120.00", "; MAXY = 120.00", "; MAXZ = 10.00",
    "; filament used [mm] = 703.45",
    "; filament used [g] = 2.12",
    "; estimated printing time (normal mode) = 9m 17s",
  ].join("\n");
}
