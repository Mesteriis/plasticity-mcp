import assert from "node:assert/strict";
import test from "node:test";

import { confirmedLayerOrthotropicFrames, createCohesiveLayerPlanePlan } from "./layer-plane-plan.ts";

const profileHash = "a".repeat(64);

test("creates exact parallel interface planes from the confirmed print axis and slicer layer height", () => {
  const result = createCohesiveLayerPlanePlan({
    processProfileHash: profileHash,
    firstInterfacePointMm: [10, 20, 1],
    buildDirectionGlobal: [0, 0, 1],
    layerHeightMm: 0.2,
    totalLayerCount: 5,
    interfaceLayerIndices: [1, 2, 3, 4],
  });

  assert.deepEqual(result.planes.map((plane) => plane.pointMm), [
    [10, 20, 1], [10, 20, 1.2], [10, 20, 1.4], [10, 20, 1.6],
  ]);
  assert.ok(result.planes.every((plane) => plane.normalGlobal[2] === 1));
  assert.equal(result.coverage, "all-layer-interfaces");
});

test("uses actual nonuniform deposition offsets when supplied from a completed slice", () => {
  const result = createCohesiveLayerPlanePlan({
    processProfileHash: profileHash,
    firstInterfacePointMm: [10, 20, 1],
    buildDirectionGlobal: [0, 0, 1],
    layerHeightMm: 0.2,
    totalLayerCount: 4,
    interfaceLayerIndices: [1, 2, 3],
    interfaceOffsetsMm: [0, 0.18, 0.42],
  });
  assert.deepEqual(result.planes.map((plane) => plane.pointMm), [
    [10, 20, 1], [10, 20, 1.18], [10, 20, 1.42],
  ]);
  assert.deepEqual(result.plan.interfaceOffsetsMm, [0, 0.18, 0.42]);
});

test("retains selected G-code road directions as traceable evidence without treating them as material properties", () => {
  const depositionPathEvidence = {
    jobId: "slice-job-17",
    profileHash,
    sourceArtifactHash: "b".repeat(64),
    gcodeArtifactHash: "c".repeat(64),
    layerCount: 5,
    coordinateFrame: "slicer-build" as const,
    firstDepositionLayerZMm: 0.2,
    interfaces: [1, 2, 3, 4].map((interfaceLayerIndex) => ({
      interfaceLayerIndex,
      depositionLayerZMm: 0.2 * interfaceLayerIndex,
      relativeOffsetMm: 0.2 * (interfaceLayerIndex - 1),
      depositionPathOrientation: {
        layerIndex: interfaceLayerIndex,
        planarPathLengthMm: 120,
        principalDirectionDeg: interfaceLayerIndex % 2 ? 0 : 90,
        directionalConcentration: 0.8,
        curvedExtrusionMoves: 0,
        coverage: "complete-linear" as const,
      },
    })),
  };
  const result = createCohesiveLayerPlanePlan({
    processProfileHash: profileHash,
    firstInterfacePointMm: [0, 0, 1],
    buildDirectionGlobal: [0, 0, 1],
    layerHeightMm: 0.2,
    totalLayerCount: 5,
    interfaceLayerIndices: [1, 2, 3, 4],
    interfaceOffsetsMm: [0, 0.2, 0.4, 0.6],
    depositionPathEvidence,
  });
  assert.deepEqual(result.plan.depositionPathEvidence, depositionPathEvidence);
  assert.equal("layerMaterialFrames" in result, false);
  assert.match(result.limitation, /road directions are provenance only/i);
  assert.throws(() => createCohesiveLayerPlanePlan({
    ...result.plan,
    depositionPathEvidence: { ...depositionPathEvidence, profileHash: "d".repeat(64) },
  }), /profile hash/i);
  assert.throws(() => createCohesiveLayerPlanePlan({
    ...result.plan,
    interfaceOffsetsMm: [0, 0.2, 0.4, 0.7],
  }), /G-code path evidence/);
  assert.throws(() => createCohesiveLayerPlanePlan({
    ...result.plan,
    depositionPathEvidence: {
      ...depositionPathEvidence,
      interfaces: depositionPathEvidence.interfaces.map((item, index) => index === 0
        ? { ...item, depositionPathOrientation: { ...item.depositionPathOrientation, layerIndex: 2 } }
        : item),
    },
  }), /match its selected interface layer/i);
});

test("maps slicer road directions into candidate global material frames only with an explicit confirmed frame mapping", () => {
  const result = createCohesiveLayerPlanePlan({
    processProfileHash: profileHash,
    firstInterfacePointMm: [0, 0, 1],
    buildDirectionGlobal: [0, 0, 1],
    layerHeightMm: 0.2,
    totalLayerCount: 3,
    interfaceLayerIndices: [1, 2],
    interfaceOffsetsMm: [0, 0.2],
    pathFrameMapping: {
      slicerXDirectionGlobal: [0, 1, 0],
      evidence: { status: "user-confirmed", description: "Confirmed slicer X maps to the CAD global Y axis." },
    },
    depositionPathEvidence: {
      jobId: "slice-job-18", profileHash,
      sourceArtifactHash: "b".repeat(64), gcodeArtifactHash: "c".repeat(64),
      layerCount: 3, coordinateFrame: "slicer-build", firstDepositionLayerZMm: 0.2,
      interfaces: [0, 90].map((principalDirectionDeg, index) => ({
        interfaceLayerIndex: index + 1,
        depositionLayerZMm: 0.2 * (index + 1),
        relativeOffsetMm: 0.2 * index,
        depositionPathOrientation: {
          layerIndex: index + 1, planarPathLengthMm: 100, principalDirectionDeg,
          directionalConcentration: 0.9, curvedExtrusionMoves: 0, coverage: "complete-linear" as const,
        },
      })),
    },
  });

  const frames = result.layerMaterialFrames;
  assert.ok(frames);
  assert.ok(Math.abs(frames[0]!.axis1DirectionGlobal[1] - 1) < 1e-12);
  assert.ok(Math.abs(frames[1]!.axis1DirectionGlobal[1]) < 1e-12);
  assert.ok(Math.abs(frames[0]!.axis1DirectionGlobal[0]) < 1e-12);
  assert.ok(Math.abs(frames[1]!.axis1DirectionGlobal[0] + 1) < 1e-12);
  assert.deepEqual(frames.map((frame) => frame?.axis3DirectionGlobal), [[0, 0, 1], [0, 0, 1]]);
  assert.ok(frames.every((frame) => frame?.applicability === "candidate-material-axes-only"));
});

test("marks complete per-layer G-code frames solver-mapped only after explicit coupon-axis confirmation", () => {
  const result = createCohesiveLayerPlanePlan({
    processProfileHash: profileHash,
    firstInterfacePointMm: [0, 0, 1],
    buildDirectionGlobal: [0, 0, 1],
    layerHeightMm: 0.2,
    totalLayerCount: 3,
    interfaceLayerIndices: [1, 2],
    pathFrameMapping: {
      slicerXDirectionGlobal: [1, 0, 0],
      evidence: { status: "user-confirmed", description: "Confirmed slicer X maps to the CAD global X axis." },
    },
    roadAxisMapping: {
      status: "user-confirmed",
      couponAxis1Meaning: "dominant-deposition-road-direction",
      evidence: { description: "Confirmed coupon axis 1 represents the dominant deposited-road direction." },
    },
    layerPathEvidence: {
      jobId: "slice-job-19", profileHash,
      sourceArtifactHash: "b".repeat(64), gcodeArtifactHash: "c".repeat(64),
      layerCount: 3, coordinateFrame: "slicer-build",
      layers: [0, 90, 45].map((principalDirectionDeg, index) => ({
        layerIndex: index + 1,
        depositionLayerZMm: 0.2 * (index + 1),
        pathOrientation: {
          layerIndex: index + 1, planarPathLengthMm: 100, principalDirectionDeg,
          directionalConcentration: 0.9, curvedExtrusionMoves: 0, coverage: "complete-linear" as const,
        },
      })),
    },
  });

  const frames = result.layerMaterialFrames;
  assert.ok(frames);
  assert.deepEqual(frames.map((frame) => frame?.layerIndex), [1, 2, 3]);
  assert.ok(Math.abs(frames[2]!.axis1DirectionGlobal[0] - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(frames[2]!.axis1DirectionGlobal[1] - Math.SQRT1_2) < 1e-12);
  assert.equal(frames[2]?.applicability, "user-confirmed-road-axis-mapping");
  assert.match(result.limitation, /one shared measured orthotropic tensor/);
  assert.match(result.limitation, /does not assign different materials/);
  const solverFrames = confirmedLayerOrthotropicFrames(result.plan);
  assert.deepEqual(solverFrames.map((frame) => frame.layerIndex), [1, 2, 3]);
  assert.deepEqual(solverFrames.map((frame) => frame.orientation.axis1DirectionGlobal), frames.map((frame) => frame!.axis1DirectionGlobal));
  assert.throws(() => confirmedLayerOrthotropicFrames({ ...result.plan, roadAxisMapping: undefined }), /user-confirmed coupon road-axis mapping/);
});

test("accepts a fully integrated circular-arc direction as layerwise solver evidence", () => {
  const result = createCohesiveLayerPlanePlan({
    processProfileHash: profileHash,
    firstInterfacePointMm: [0, 0, 1],
    buildDirectionGlobal: [0, 0, 1],
    layerHeightMm: 0.2,
    totalLayerCount: 3,
    interfaceLayerIndices: [1, 2],
    pathFrameMapping: {
      slicerXDirectionGlobal: [1, 0, 0],
      evidence: { status: "user-confirmed", description: "Confirmed slicer X maps to the CAD global X axis." },
    },
    roadAxisMapping: {
      status: "user-confirmed",
      couponAxis1Meaning: "dominant-deposition-road-direction",
      evidence: { description: "Confirmed coupon axis 1 represents the dominant deposited-road direction." },
    },
    layerPathEvidence: {
      jobId: "slice-job-arcs", profileHash,
      sourceArtifactHash: "b".repeat(64), gcodeArtifactHash: "c".repeat(64),
      layerCount: 3, coordinateFrame: "slicer-build",
      layers: [
        { layerIndex: 1, depositionLayerZMm: 0.2, pathOrientation: { layerIndex: 1, planarPathLengthMm: 15.707963, principalDirectionDeg: 135, directionalConcentration: 0.63662, curvedExtrusionMoves: 1, coverage: "complete-planar" } },
        { layerIndex: 2, depositionLayerZMm: 0.4, pathOrientation: { layerIndex: 2, planarPathLengthMm: 100, principalDirectionDeg: 0, directionalConcentration: 1, curvedExtrusionMoves: 0, coverage: "complete-linear" } },
        { layerIndex: 3, depositionLayerZMm: 0.6, pathOrientation: { layerIndex: 3, planarPathLengthMm: 100, principalDirectionDeg: 90, directionalConcentration: 1, curvedExtrusionMoves: 0, coverage: "complete-linear" } },
      ],
    },
  });

  assert.equal(result.layerMaterialFrames?.[0]?.coverage, "complete-planar");
  assert.ok(Math.abs(result.layerMaterialFrames![0]!.axis1DirectionGlobal[0] + Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(result.layerMaterialFrames![0]!.axis1DirectionGlobal[1] - Math.SQRT1_2) < 1e-12);
  assert.equal(confirmedLayerOrthotropicFrames(result.plan).length, 3);
});

test("rejects incomplete short layer schedules and mismatched slice provenance", () => {
  const evidence = {
    jobId: "slice-job-20", profileHash,
    sourceArtifactHash: "b".repeat(64), gcodeArtifactHash: "c".repeat(64),
    layerCount: 3, coordinateFrame: "slicer-build" as const,
    layers: [0, 90, 45].map((principalDirectionDeg, index) => ({
      layerIndex: index + 1,
      depositionLayerZMm: 0.2 * (index + 1),
      pathOrientation: {
        layerIndex: index + 1, planarPathLengthMm: 100, principalDirectionDeg,
        directionalConcentration: 0.9, curvedExtrusionMoves: 0, coverage: "complete-linear" as const,
      },
    })),
  };
  const input = {
    processProfileHash: profileHash,
    firstInterfacePointMm: [0, 0, 1] as [number, number, number],
    buildDirectionGlobal: [0, 0, 1] as [number, number, number],
    layerHeightMm: 0.2,
    totalLayerCount: 3,
    interfaceLayerIndices: [1, 2],
    layerPathEvidence: evidence,
  };

  assert.throws(() => createCohesiveLayerPlanePlan({
    ...input, layerPathEvidence: { ...evidence, layers: evidence.layers.slice(0, 2) },
  }), /include every deposited layer/i);
  assert.throws(() => createCohesiveLayerPlanePlan({
    ...input, layerPathEvidence: { ...evidence, profileHash: "d".repeat(64) },
  }), /profile hash/i);
  assert.throws(() => createCohesiveLayerPlanePlan({
    ...input,
    depositionPathEvidence: {
      jobId: "other-job", profileHash,
      sourceArtifactHash: "b".repeat(64), gcodeArtifactHash: "c".repeat(64),
      layerCount: 3, coordinateFrame: "slicer-build", firstDepositionLayerZMm: 0.2,
      interfaces: [1, 2].map((interfaceLayerIndex) => ({
        interfaceLayerIndex, depositionLayerZMm: 0.2 * interfaceLayerIndex,
        relativeOffsetMm: 0.2 * (interfaceLayerIndex - 1),
        depositionPathOrientation: {
          layerIndex: interfaceLayerIndex, planarPathLengthMm: 100,
          principalDirectionDeg: 0, directionalConcentration: 0.9,
          curvedExtrusionMoves: 0, coverage: "complete-linear" as const,
        },
      })),
    },
  }), /same Workbench slice job and artifacts/i);
});

test("keeps sampled interfaces explicitly incomplete when a print exceeds the full-stack interface cap", () => {
  const result = createCohesiveLayerPlanePlan({
    processProfileHash: profileHash,
    firstInterfacePointMm: [0, 0, 0],
    buildDirectionGlobal: [Math.SQRT1_2, 0, Math.SQRT1_2],
    layerHeightMm: 0.16,
    totalLayerCount: 300,
    interfaceLayerIndices: [1, 150, 299],
  });

  result.planes[1]!.pointMm.forEach((coordinate, axis) => {
    const expected = [0.16 * 149 * Math.SQRT1_2, 0, 0.16 * 149 * Math.SQRT1_2][axis]!;
    assert.ok(Math.abs(coordinate - expected) < 1e-12);
  });
  assert.equal(result.coverage, "selected-interfaces-only");
  assert.match(result.limitation, /omitted layer interfaces are not analyzed/i);
});

test("supports complete layerwise plans through 256 layers and rejects larger evidence arrays", () => {
  const totalLayerCount = 256;
  const layerPathEvidence = {
    jobId: "slice-job-256", profileHash,
    sourceArtifactHash: "b".repeat(64), gcodeArtifactHash: "c".repeat(64),
    layerCount: totalLayerCount, coordinateFrame: "slicer-build" as const,
    layers: Array.from({ length: totalLayerCount }, (_, index) => ({
      layerIndex: index + 1,
      depositionLayerZMm: (index + 1) * 0.2,
      pathOrientation: {
        layerIndex: index + 1, planarPathLengthMm: 100,
        principalDirectionDeg: index % 2 ? 90 : 0,
        directionalConcentration: 0.9, curvedExtrusionMoves: 0,
        coverage: "complete-linear" as const,
      },
    })),
  };
  const result = createCohesiveLayerPlanePlan({
    processProfileHash: profileHash,
    firstInterfacePointMm: [0, 0, 0], buildDirectionGlobal: [0, 0, 1],
    layerHeightMm: 0.2, totalLayerCount,
    interfaceLayerIndices: Array.from({ length: totalLayerCount - 1 }, (_, index) => index + 1),
    interfaceOffsetsMm: Array.from({ length: totalLayerCount - 1 }, (_, index) => index * 0.2),
    layerPathEvidence,
    pathFrameMapping: {
      slicerXDirectionGlobal: [1, 0, 0],
      evidence: { status: "user-confirmed", description: "Confirmed slicer X axis maps to CAD global X." },
    },
    roadAxisMapping: {
      status: "user-confirmed",
      couponAxis1Meaning: "dominant-deposition-road-direction",
      evidence: { description: "The measured coupon axis follows the dominant deposited road." },
    },
  });

  assert.equal(result.coverage, "all-layer-interfaces");
  assert.equal(result.layerMaterialFrames?.length, totalLayerCount);
  assert.equal(result.planes.length, totalLayerCount - 1);
  assert.throws(() => createCohesiveLayerPlanePlan({
    processProfileHash: profileHash,
    firstInterfacePointMm: [0, 0, 0], buildDirectionGlobal: [0, 0, 1],
    layerHeightMm: 0.2, totalLayerCount: 257,
    interfaceLayerIndices: Array.from({ length: 256 }, (_, index) => index + 1),
    layerPathEvidence: { ...layerPathEvidence, layerCount: 257 },
  }));
});

test("normalizes near-unit build directions before accumulating many layer offsets", () => {
  const result = createCohesiveLayerPlanePlan({
    processProfileHash: profileHash,
    firstInterfacePointMm: [0, 0, 0],
    buildDirectionGlobal: [0, 0, 1 + 5e-7],
    layerHeightMm: 0.2,
    totalLayerCount: 2_000_000,
    interfaceLayerIndices: [1, 1_999_999],
  });

  assert.equal(result.planes[1]?.pointMm[2], 0.2 * 1_999_998);
  assert.deepEqual(result.planes[1]?.normalGlobal, [0, 0, 1]);
  assert.deepEqual(result.plan.buildDirectionGlobal, [0, 0, 1]);
});

test("rejects invalid axes, unsorted indices, incomplete small stacks, and more than 32 planes", () => {
  const valid = {
    processProfileHash: profileHash,
    firstInterfacePointMm: [0, 0, 0] as [number, number, number],
    buildDirectionGlobal: [0, 0, 1] as [number, number, number],
    layerHeightMm: 0.2,
    totalLayerCount: 4,
    interfaceLayerIndices: [1, 2, 3],
  };

  assert.throws(() => createCohesiveLayerPlanePlan({ ...valid, buildDirectionGlobal: [0, 0, 2] }));
  assert.throws(() => createCohesiveLayerPlanePlan({ ...valid, interfaceLayerIndices: [2, 1, 3] }));
  assert.throws(() => createCohesiveLayerPlanePlan({ ...valid, interfaceLayerIndices: [1, 3] }));
  assert.throws(() => createCohesiveLayerPlanePlan({ ...valid, interfaceOffsetsMm: [0, 0.2] }));
  assert.throws(() => createCohesiveLayerPlanePlan({ ...valid, interfaceOffsetsMm: [0.1, 0.2, 0.3] }));
  assert.throws(() => createCohesiveLayerPlanePlan({ ...valid, interfaceOffsetsMm: [0, 0.4, 0.3] }));
  assert.throws(() => createCohesiveLayerPlanePlan({
    ...valid,
    pathFrameMapping: {
      slicerXDirectionGlobal: [0, 0, 1],
      evidence: { status: "user-confirmed", description: "Slicer frame mapping confirmed by user." },
    },
  }), /mapping requires matching G-code/i);
  assert.throws(() => createCohesiveLayerPlanePlan({
    ...valid,
    totalLayerCount: 100,
    interfaceLayerIndices: Array.from({ length: 33 }, (_, index) => index + 1),
  }));
});
