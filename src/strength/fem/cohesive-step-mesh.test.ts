import assert from "node:assert/strict";
import test from "node:test";

import { parseCohesiveStepMeshResult, validateCohesiveStepMeshRequest, type CohesiveStepMeshRequest } from "./cohesive-step-mesh.ts";

const face = (faceId: string, z: number, normal: [number, number, number]) => ({
  faceId,
  surfaceType: "Plane",
  centerMm: [5, 2.5, z] as [number, number, number],
  normal,
  boundsMm: { min: [0, 0, z] as [number, number, number], max: [10, 5, z] as [number, number, number] },
});

const request: CohesiveStepMeshRequest = {
  stepPath: "/tmp/source.step",
  outputPath: "/tmp/work/cohesive.msh",
  splitPlanes: [{ pointMm: [0, 0, 2], normalGlobal: [0, 0, 1] }],
  meshSizeMm: 1.5,
  boundaryFaces: [face("bottom", 0, [0, 0, -1]), face("top", 4, [0, 0, 1])],
};

test("validates native face and split-plane inputs before launching the mesh worker", () => {
  assert.doesNotThrow(() => validateCohesiveStepMeshRequest(request));
  assert.throws(() => validateCohesiveStepMeshRequest({ ...request, outputPath: "relative.msh" }), /absolute/);
  assert.throws(() => validateCohesiveStepMeshRequest({ ...request, meshSizeMm: 0 }), /meshSizeMm/);
  assert.throws(() => validateCohesiveStepMeshRequest({ ...request, layerwiseRegions: "yes" as never }), /layerwiseRegions/);
  assert.throws(() => validateCohesiveStepMeshRequest({ ...request, boundaryFaces: [face("same", 0, [0, 0, -1]), face("same", 4, [0, 0, 1])] }), /unique/);
  assert.throws(() => validateCohesiveStepMeshRequest({ ...request, splitPlanes: [{ pointMm: [0, 0, 2], normalGlobal: [0, 0, 0] }] }), /unit vector/);
  assert.throws(() => validateCohesiveStepMeshRequest({ ...request, splitPlanes: [request.splitPlanes[0]!, { pointMm: [0, 1, 2], normalGlobal: [0, 0, 1] }] }), /ordered and separated/);
  assert.throws(() => validateCohesiveStepMeshRequest({ ...request, splitPlanes: [request.splitPlanes[0]!, { pointMm: [0, 0, 3], normalGlobal: [0, 1, 0] }] }), /parallel normals/);
});

test("accepts only an exact two-region Gmsh response with every requested boundary mapped", () => {
  const response = {
    ok: true,
    gmshVersion: "4.15.2",
    layerwiseRegions: false,
    volumeCount: 2,
    interfaceSurfaceCount: 1,
    splitPlanes: request.splitPlanes,
    meshSizeMm: request.meshSizeMm,
    materialATag: 1,
    materialBTag: 2,
    interfaceSurfaceTags: [3],
    interfaceSurfaceGroups: [{ planeIndex: 0, physicalTag: 3, surfaceEntityTags: [10], triangleCount: 20 }],
    interfaceTriangleCountsByTag: { "3": 20 },
    cohesiveVolumeTag: 1003,
    boundaryGroups: [
      { faceId: "bottom", physicalTag: 1001, name: "GM1001", surfaceEntityTag: 4 },
      { faceId: "top", physicalTag: 1002, name: "GM1002", surfaceEntityTag: 5 },
    ],
    outputPath: request.outputPath,
    materialATetrahedronCount: 100,
    materialBTetrahedronCount: 100,
    interfaceTriangleCount: 20,
    duplicatedNodeCount: 15,
    cohesiveElementCount: 20,
    cohesiveElementIds: Array.from({ length: 20 }, (_item, index) => index + 201),
  };
  const parsed = parseCohesiveStepMeshResult(JSON.stringify(response), request);
  assert.equal(parsed.gmshVersion, "4.15.2");
  assert.equal(parsed.cohesiveElementIds.length, 20);
  assert.equal(parsed.boundaryGroups[1]?.faceId, "top");
  assert.throws(() => parseCohesiveStepMeshResult(JSON.stringify({ ...response, outputPath: "/tmp/other.msh" }), request), /response envelope/);
  assert.throws(() => parseCohesiveStepMeshResult(JSON.stringify({ ...response, volumeCount: 1 }), request), /response envelope/);
  assert.throws(() => parseCohesiveStepMeshResult(JSON.stringify({ ...response, boundaryGroups: response.boundaryGroups.slice(0, 1) }), request), /boundary face/);
  assert.throws(() => parseCohesiveStepMeshResult(JSON.stringify({ ...response, cohesiveElementIds: [201, 201], cohesiveElementCount: 2 }), request), /cohesive element IDs/);
});

test("parses every plane and interface-group count for a multi-region Gmsh response", () => {
  const multiRequest: CohesiveStepMeshRequest = {
    ...request,
    splitPlanes: [request.splitPlanes[0]!, { pointMm: [0, 0, 3], normalGlobal: [0, 0, 1] }],
  };
  const response = {
    ok: true, gmshVersion: "4.15.2", volumeCount: 3, interfaceSurfaceCount: 2, layerwiseRegions: false,
    splitPlanes: multiRequest.splitPlanes, meshSizeMm: multiRequest.meshSizeMm,
    materialATag: 1, materialBTag: 2, interfaceSurfaceTags: [3, 4], cohesiveVolumeTag: 1003,
    interfaceSurfaceGroups: [
      { planeIndex: 0, physicalTag: 3, surfaceEntityTags: [10], triangleCount: 12 },
      { planeIndex: 1, physicalTag: 4, surfaceEntityTags: [11], triangleCount: 14 },
    ],
    interfaceTriangleCountsByTag: { "3": 12, "4": 14 },
    boundaryGroups: [
      { faceId: "bottom", physicalTag: 1001, name: "GM1001", surfaceEntityTag: 4 },
      { faceId: "top", physicalTag: 1002, name: "GM1002", surfaceEntityTag: 5 },
    ],
    outputPath: multiRequest.outputPath, materialATetrahedronCount: 100, materialBTetrahedronCount: 100,
    interfaceTriangleCount: 26, duplicatedNodeCount: 20, cohesiveElementCount: 26,
    cohesiveElementIds: Array.from({ length: 26 }, (_item, index) => index + 201),
  };
  const parsed = parseCohesiveStepMeshResult(JSON.stringify(response), multiRequest);
  assert.equal(parsed.volumeCount, 3);
  assert.deepEqual(parsed.interfaceSurfaceGroups.map((group) => group.triangleCount), [12, 14]);
  assert.equal(parsed.cohesiveElementCount, 26);
});

test("accepts a cohesive tag after the full interface range and rejects a tag colliding with interface four", () => {
  const stackRequest: CohesiveStepMeshRequest = {
    ...request,
    splitPlanes: [2, 3, 4, 5].map((z) => ({ pointMm: [0, 0, z] as [number, number, number], normalGlobal: [0, 0, 1] as [number, number, number] })),
  };
  const interfaceSurfaceTags = [3, 4, 5, 6];
  const response = {
    ok: true, gmshVersion: "4.15.2", volumeCount: 5, interfaceSurfaceCount: 4, layerwiseRegions: false,
    splitPlanes: stackRequest.splitPlanes, meshSizeMm: stackRequest.meshSizeMm,
    materialATag: 1, materialBTag: 2, interfaceSurfaceTags, cohesiveVolumeTag: 1003,
    interfaceSurfaceGroups: interfaceSurfaceTags.map((physicalTag, planeIndex) => ({
      planeIndex, physicalTag, surfaceEntityTags: [10 + planeIndex], triangleCount: 2,
    })),
    interfaceTriangleCountsByTag: { "3": 2, "4": 2, "5": 2, "6": 2 },
    boundaryGroups: [
      { faceId: "bottom", physicalTag: 1001, name: "GM1001", surfaceEntityTag: 20 },
      { faceId: "top", physicalTag: 1002, name: "GM1002", surfaceEntityTag: 21 },
    ],
    outputPath: stackRequest.outputPath, materialATetrahedronCount: 100, materialBTetrahedronCount: 100,
    interfaceTriangleCount: 8, duplicatedNodeCount: 20, cohesiveElementCount: 8,
    cohesiveElementIds: Array.from({ length: 8 }, (_item, index) => index + 201),
  };
  assert.equal(parseCohesiveStepMeshResult(JSON.stringify(response), stackRequest).cohesiveVolumeTag, 1003);
  assert.throws(() => parseCohesiveStepMeshResult(JSON.stringify({ ...response, cohesiveVolumeTag: 6 }), stackRequest), /conflicting cohesive volume physical tag/);
});

test("parses ordered layer volume groups without collapsing them into alternating material groups", () => {
  const layerRequest: CohesiveStepMeshRequest = {
    ...request,
    layerwiseRegions: true,
    splitPlanes: Array.from({ length: 255 }, (_, index) => ({ pointMm: [0, 0, (index + 1) * 0.1] as [number, number, number], normalGlobal: [0, 0, 1] as [number, number, number] })),
  };
  const interfaceSurfaceTags = Array.from({ length: layerRequest.splitPlanes.length }, (_, index) => layerRequest.splitPlanes.length + 2 + index);
  const response = {
    ok: true, gmshVersion: "4.15.2", volumeCount: 256, interfaceSurfaceCount: 255,
    splitPlanes: layerRequest.splitPlanes, meshSizeMm: layerRequest.meshSizeMm,
    materialATag: 1, materialBTag: 2, layerwiseRegions: true,
    layerRegionGroups: Array.from({ length: 256 }, (_, index) => index + 1).map((layerIndex) => ({ layerIndex, physicalTag: layerIndex, name: `GM${layerIndex}`, tetrahedronCount: 20 })),
    interfaceSurfaceTags, cohesiveVolumeTag: 1003,
    interfaceSurfaceGroups: interfaceSurfaceTags.map((physicalTag, planeIndex) => ({ planeIndex, physicalTag, surfaceEntityTags: [10 + planeIndex], triangleCount: 12 })),
    interfaceTriangleCountsByTag: Object.fromEntries(interfaceSurfaceTags.map((tag) => [String(tag), 12])),
    boundaryGroups: [
      { faceId: "bottom", physicalTag: 1001, name: "GM1001", surfaceEntityTag: 6 },
      { faceId: "top", physicalTag: 1002, name: "GM1002", surfaceEntityTag: 7 },
    ],
    outputPath: layerRequest.outputPath, interfaceTriangleCount: 3060,
    duplicatedNodeCount: 3060, cohesiveElementCount: 3060,
    cohesiveElementIds: Array.from({ length: 3060 }, (_item, index) => index + 201),
  };

  const parsed = parseCohesiveStepMeshResult(JSON.stringify(response), layerRequest);
  assert.equal(parsed.layerRegionGroups?.length, 256);
  assert.deepEqual(parsed.layerRegionGroups?.map((group) => group.layerIndex), Array.from({ length: 256 }, (_, index) => index + 1));
  assert.equal(parsed.materialATetrahedronCount, undefined);
  assert.equal(parsed.layerwiseRegions, true);
  assert.throws(() => parseCohesiveStepMeshResult(JSON.stringify({
    ...response, layerRegionGroups: response.layerRegionGroups.slice(0, 2),
  }), layerRequest), /ordered layer-region groups/);
});
