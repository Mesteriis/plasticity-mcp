import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateCalculiXMeshFromStep, parseStepFaceMappingResult, readElementSICN, verifyLayerRegionElementSets, verifyMinimumSICNElementLocator, type NativePlanarFaceReference } from "./step-face-mapping.ts";

const face: NativePlanarFaceReference = {
  faceId: "native-face-1",
  surfaceType: "Plane",
  centerMm: [5, 2.5, 4],
  normal: [0, 0, 1],
  boundsMm: { min: [0, 0, 4], max: [10, 5, 4] },
};

function output(mappings = [mapping(face.faceId, 1)], mesh?: object): string {
  const result: Record<string, unknown> = {
    schemaVersion: 1,
    gmshVersion: "4.15.2",
    volumeCount: 1,
    surfaceCount: 6,
    toleranceMm: 0.0001,
    mappings,
  };
  if (mesh) result.mesh = mesh;
  return JSON.stringify(result);
}

function mapping(faceId: string, surfaceEntityTag: number): object {
  return {
    faceId,
    surfaceEntityTag,
    surfaceType: "Plane",
    centerMm: [5, 2.5, 4],
    normal: [0, 0, 1],
    boundsMm: { min: [-0.0000001, -0.0000001, 3.9999999], max: [10.0000001, 5.0000001, 4.0000001] },
    areaMm2: 50,
    maxSignatureErrorMm: 0.0000002,
    normalDot: 1,
  };
}

test("accepts one exact uniquely mapped planar face", () => {
  const result = parseStepFaceMappingResult(output(), [face]);
  assert.equal(result.mappings[0]?.faceId, face.faceId);
  assert.equal(result.mappings[0]?.surfaceEntityTag, 1);
  assert.equal(result.volumeCount, 1);
});

test("rejects an ambiguous or non-bijective native-face mapping", () => {
  assert.throws(() => parseStepFaceMappingResult(output([mapping(face.faceId, 1), mapping(face.faceId, 2)]), [face]), /incomplete face mapping/);
  const second = { ...face, faceId: "native-face-2" };
  assert.throws(() => parseStepFaceMappingResult(output([mapping(face.faceId, 1), mapping(second.faceId, 1)]), [face, second]), /non-bijective/);
});

test("rejects mappings beyond measured tolerance or from unsupported Gmsh versions", () => {
  assert.throws(() => parseStepFaceMappingResult(output([{ ...mapping(face.faceId, 1), maxSignatureErrorMm: 0.001 }]), [face]), /invalid mapping entry/);
  assert.throws(() => parseStepFaceMappingResult(output().replace("4.15.2", "4.16.0"), [face]), /invalid response envelope/);
});

test("accepts bounded C3D4 mesh evidence and rejects inconsistent node-set counts", () => {
  const mesh = {
    meshFile: "/tmp/probe.inp",
    elementSICNFile: "/tmp/probe-sicn.csv",
    meshSizeMm: 1,
    elementFamily: "C3D4",
    nodeCount: 20,
    tetrahedronCount: 12,
    minimumScaledInverseConditionNumber: 0.3,
    minimumSICNElementId: 1,
    minimumSICNElementCentroidMm: [5, 2.5, 2],
    fifthPercentileSampledSICN: 0.4,
    medianSampledSICN: 0.6,
    boundsMm: { min: [0, 0, 0], max: [10, 5, 4] },
    nodeSets: [{ faceId: face.faceId, setName: "FACE_1", nodeCount: 8 }],
    sharedSurfaceNodeCount: 0,
    loadFile: null,
    surfaceLoads: [],
    resultantLoads: [],
    totalResultantN: [0, 0, 0],
    totalResultantMomentNmm: [0, 0, 0],
  };
  const parsed = parseStepFaceMappingResult(output([mapping(face.faceId, 1)], mesh), [face]);
  assert.equal(parsed.mesh?.tetrahedronCount, 12);
  assert.equal(parsed.mesh?.fifthPercentileSampledSICN, 0.4);
  assert.equal(parsed.mesh?.medianSampledSICN, 0.6);
  assert.equal(parsed.mesh?.minimumSICNElementId, 1);
  assert.deepEqual(parsed.mesh?.minimumSICNElementCentroidMm, [5, 2.5, 2]);
  assert.throws(() => parseStepFaceMappingResult(output([mapping(face.faceId, 1)], {
    ...mesh,
    nodeSets: [{ faceId: face.faceId, setName: "FACE_1", nodeCount: 21 }],
  }), [face]), /invalid boundary node set/);
  assert.throws(() => parseStepFaceMappingResult(output([mapping(face.faceId, 1)], {
    ...mesh,
    fifthPercentileSampledSICN: 0.2,
  }), [face]), /inconsistent sampled SICN distribution/);
});

test("requires layer ELSETs to partition every C3D4 element exactly once", () => {
  const groups = [
    { layerIndex: 1, elsetName: "LAYER_1", tetrahedronCount: 1 },
    { layerIndex: 2, elsetName: "LAYER_2", tetrahedronCount: 2 },
  ];
  const meshText = [
    "*NODE", "1,0,0,0", "2,1,0,0", "3,0,1,0", "4,0,0,1", "5,1,1,1", "6,2,1,1",
    "*ELEMENT, TYPE=C3D4, ELSET=SOLID", "10,1,2,3,4", "11,2,3,4,5", "12,2,4,5,6",
    "*ELSET, ELSET=LAYER_1", "10", "*ELSET, ELSET=LAYER_2", "11, 12",
  ].join("\n");
  assert.doesNotThrow(() => verifyLayerRegionElementSets(meshText, groups, new Set([10, 11, 12])));
  assert.throws(() => verifyLayerRegionElementSets(meshText.replace("11, 12", "10, 12"), groups, new Set([10, 11, 12])), /absent or duplicated/);
  assert.throws(() => verifyLayerRegionElementSets(meshText.replace("11, 12", "11"), groups, new Set([10, 11, 12])), /exact partition/);
});

test("rejects unordered or nonparallel layer split planes before starting Gmsh", async () => {
  await assert.rejects(() => generateCalculiXMeshFromStep(
    "/missing.step", [face], [face.faceId], 1, "/tmp/rejected-layer-mesh.inp", undefined, [], undefined, [], undefined,
    [
      { pointMm: [0, 0, 2], normalGlobal: [0, 0, 1] },
      { pointMm: [0, 0, 1], normalGlobal: [0, 0, 1] },
    ],
  ), /ordered and separated/);
  await assert.rejects(() => generateCalculiXMeshFromStep(
    "/missing.step", [face], [face.faceId], 1, "/tmp/rejected-layer-mesh.inp", undefined, [], undefined, [], undefined,
    [
      { pointMm: [0, 0, 1], normalGlobal: [0, 0, 1] },
      { pointMm: [1, 0, 2], normalGlobal: [1, 0, 0] },
    ],
  ), /parallel normals/);
});

test("binds Code_Aster Gmsh physical groups to mapped native Plasticity faces", () => {
  const mesh = {
    meshFile: "/tmp/probe.inp",
    codeAsterMeshFile: "/tmp/probe.msh",
    codeAsterMeshFormat: "GMSH-2.2",
    codeAsterPhysicalGroups: [
      { dimension: 3, tag: 1, name: "GM1", faceId: null },
      { dimension: 2, tag: 1001, name: "GM1001", faceId: face.faceId },
    ],
    elementSICNFile: "/tmp/probe-sicn.csv",
    meshSizeMm: 1,
    elementFamily: "C3D4",
    nodeCount: 20,
    tetrahedronCount: 12,
    minimumScaledInverseConditionNumber: 0.3,
    minimumSICNElementId: 1,
    minimumSICNElementCentroidMm: [5, 2.5, 2],
    fifthPercentileSampledSICN: 0.4,
    medianSampledSICN: 0.6,
    boundsMm: { min: [0, 0, 0], max: [10, 5, 4] },
    nodeSets: [{ faceId: face.faceId, setName: "FACE_1", nodeCount: 8 }],
    sharedSurfaceNodeCount: 0,
    loadFile: null,
    surfaceLoads: [],
    resultantLoads: [],
    totalResultantN: [0, 0, 0],
    totalResultantMomentNmm: [0, 0, 0],
  };
  const parsed = parseStepFaceMappingResult(output([mapping(face.faceId, 1)], mesh), [face]);
  assert.equal(parsed.mesh?.codeAsterMeshFormat, "GMSH-2.2");
  assert.equal(parsed.mesh?.codeAsterPhysicalGroups?.[1]?.faceId, face.faceId);
  assert.throws(() => parseStepFaceMappingResult(output([mapping(face.faceId, 1)], {
    ...mesh,
    codeAsterPhysicalGroups: [{ dimension: 3, tag: 1, name: "GM1", faceId: null }, { dimension: 2, tag: 1001, name: "GM1001", faceId: "stale-face" }],
  }), [face]), /does not match its native Plasticity face binding/);
});

test("binds the reported minimum-SICN element ID and centroid to the emitted C3D4 mesh", () => {
  const deck = [
    "*NODE",
    "1, 0, 0, 0",
    "2, 4, 0, 0",
    "3, 0, 4, 0",
    "4, 0, 0, 4",
    "*ELEMENT, TYPE=C3D4, ELSET=SOLID",
    "1, 1, 2, 3, 4",
  ].join("\n");
  const evidence = { minimumSICNElementId: 1, minimumSICNElementCentroidMm: [1, 1, 1] as [number, number, number] };
  assert.deepEqual([...verifyMinimumSICNElementLocator(deck, evidence, 1)], [1]);
  assert.throws(() => verifyMinimumSICNElementLocator(deck, evidence, 2), /element count does not match/);
  assert.throws(() => verifyMinimumSICNElementLocator(deck, { ...evidence, minimumSICNElementId: 2 }), /absent from the written/);
  assert.throws(() => verifyMinimumSICNElementLocator(deck, { ...evidence, minimumSICNElementCentroidMm: [2, 2, 2] }), /does not match/);
});

test("reads the SICN of a requested stress-peak element and rejects incomplete or duplicate tables", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "plasticity-sicn-table-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "quality.csv");
  await writeFile(path, "elementId,minSICN\n1,0.75\n2,0.5\n3,0.9\n");
  const meshElementIds = new Set([1, 2, 3]);
  assert.equal(await readElementSICN(path, meshElementIds, 3), 0.9);
  assert.equal(await readElementSICN(path, meshElementIds, 1), 0.75);
  await writeFile(path, "elementId,minSICN\n1,0.75\n2,0.5\n2,0.9\n");
  await assert.rejects(readElementSICN(path, meshElementIds, 2), /duplicate element/);
  await writeFile(path, "elementId,minSICN\n1,0.75\n2,0.5\n");
  await assert.rejects(readElementSICN(path, meshElementIds, 2), /expected mesh element IDs/);
  await writeFile(path, "elementId,minSICN\n1,0.75\n2,0.5\n4,0.9\n");
  await assert.rejects(readElementSICN(path, meshElementIds, 2), /invalid SICN row/);
  await writeFile(path, "elementId,minSICN\n1,0.75\n2,-0.5\n3,0.9\n");
  await assert.rejects(readElementSICN(path, meshElementIds, 2), /invalid SICN/);
});

test("validates the resultant represented by a surface-traction transfer", () => {
  const mesh = {
    meshFile: "/tmp/probe.inp",
    elementSICNFile: "/tmp/probe-sicn.csv",
    meshSizeMm: 1,
    elementFamily: "C3D4",
    nodeCount: 20,
    tetrahedronCount: 12,
    minimumScaledInverseConditionNumber: 0.3,
    minimumSICNElementId: 1,
    minimumSICNElementCentroidMm: [5, 2.5, 2],
    fifthPercentileSampledSICN: 0.4,
    medianSampledSICN: 0.6,
    boundsMm: { min: [0, 0, 0], max: [10, 5, 4] },
    nodeSets: [{ faceId: face.faceId, setName: "FACE_1", nodeCount: 8 }],
    sharedSurfaceNodeCount: 0,
    loadFile: "/tmp/probe-loads.inp",
    surfaceLoads: [{ faceId: face.faceId, surfaceAreaMm2: 20, tractionNPerMm2: [100, 0, 0], resultantN: [2000, 0, 0], resultantMomentNmm: [0, 0, 0], loadedNodeCount: 8 }],
    resultantLoads: [],
    totalResultantN: [2000, 0, 0],
    totalResultantMomentNmm: [0, 0, 0],
  };
  const result = parseStepFaceMappingResult(output([mapping(face.faceId, 1)], mesh), [face]);
  assert.deepEqual(result.mesh?.totalResultantN, [2000, 0, 0]);
  assert.throws(() => parseStepFaceMappingResult(output([mapping(face.faceId, 1)], {
    ...mesh,
    totalResultantN: [2100, 0, 0],
  }), [face]), /inconsistent with its mapped face tractions/);
});

test("validates a face force and free moment transfer", () => {
  const mesh = {
    meshFile: "/tmp/probe.inp",
    elementSICNFile: "/tmp/probe-sicn.csv",
    meshSizeMm: 1,
    elementFamily: "C3D4",
    nodeCount: 20,
    tetrahedronCount: 12,
    minimumScaledInverseConditionNumber: 0.3,
    minimumSICNElementId: 1,
    minimumSICNElementCentroidMm: [5, 2.5, 2],
    fifthPercentileSampledSICN: 0.4,
    medianSampledSICN: 0.6,
    boundsMm: { min: [0, 0, 0], max: [10, 5, 4] },
    nodeSets: [{ faceId: face.faceId, setName: "FACE_1", nodeCount: 8 }],
    sharedSurfaceNodeCount: 0,
    loadFile: "/tmp/probe-loads.inp",
    surfaceLoads: [],
    resultantLoads: [{ faceId: face.faceId, forceN: [0, 100, 0], applicationPointMm: [10, 2, 0], momentNmm: [0, 0, 50], appliedMomentAtOriginNmm: [0, 0, 1050] }],
    totalResultantN: [0, 100, 0],
    totalResultantMomentNmm: [0, 0, 1050],
  };
  const result = parseStepFaceMappingResult(output([mapping(face.faceId, 1)], mesh), [face]);
  assert.deepEqual(result.mesh?.totalResultantMomentNmm, [0, 0, 1050]);
  assert.throws(() => parseStepFaceMappingResult(output([mapping(face.faceId, 1)], {
    ...mesh,
    resultantLoads: [{ ...mesh.resultantLoads[0], appliedMomentAtOriginNmm: [0, 0, 0] }],
  }), [face]), /inconsistent applied force moment/);
});
