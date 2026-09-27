import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectRectangularMember,
  verifyRectangularTopology,
  type MemberFrame,
  type RectangularTopology,
} from "./member-geometry.ts";
import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

const frame: MemberFrame = { lengthAxis: [1, 0, 0], heightAxis: [0, 0, 1] };

test("accepts an exact cuboid and reports frame dimensions", () => {
  assert.deepEqual(verifyRectangularTopology(cuboid(), frame), {
    status: "verified",
    lengthMm: 80,
    widthMm: 20,
    heightMm: 10,
  });
});

test("accepts a rigidly rotated cuboid with mixed topology orientation", () => {
  const source = cuboid();
  const rotate = ([x, y, z]: [number, number, number]): [number, number, number] => [
    (x - y) / Math.SQRT2,
    (x + y) / Math.SQRT2,
    z,
  ];
  const rotated: RectangularTopology = {
    ...source,
    vertices: source.vertices.map((vertex) => ({ ...vertex, pointMm: rotate(vertex.pointMm) })),
    edges: source.edges.map((edge, index) => ({
      ...edge,
      vertices: index % 2 === 0 ? [edge.vertices[1], edge.vertices[0]] : edge.vertices,
      faceIds: index % 2 === 0 ? [edge.faceIds[1]!, edge.faceIds[0]!] : edge.faceIds,
    })),
    faces: source.faces.map((face, index) => ({
      ...face,
      normal: rotate(face.normal),
      edgeIds: index % 2 === 0 ? [...face.edgeIds].reverse() : face.edgeIds,
    })),
  };
  const result = verifyRectangularTopology(rotated, {
    lengthAxis: rotate([1, 0, 0]),
    heightAxis: rotate([0, 0, 1]),
  });
  assert.equal(result.status, "verified");
  if (result.status === "verified") assert.deepEqual(result, { status: "verified", lengthMm: 80, widthMm: 20, heightMm: 10 });
});

test("does not snap a tapered body into a cuboid", () => {
  const topology = cuboid();
  topology.vertices.find((vertex) => vertex.id === 6)!.pointMm[0] = 79.999;
  assert.equal(verifyRectangularTopology(topology, frame).status, "unsupported");
});

test("rejects holes, inner shells, curved edges, missing faces and duplicate vertices", () => {
  const hole = cuboid();
  hole.faces.push({ id: "hole", planar: false, normal: [0, 0, 1], edgeIds: ["h1"] });
  hole.edges.push({ id: "h1", linear: false, vertices: [1, 2], faceIds: ["z1", "hole"] });

  const innerShell = cuboid();
  innerShell.vertices.push({ id: 9, pointMm: [20, 5, 2] });

  const curved = cuboid();
  curved.edges[0] = { ...curved.edges[0]!, linear: false };

  const missingFace = cuboid();
  missingFace.faces.pop();

  const duplicateVertex = cuboid();
  duplicateVertex.vertices[7] = { ...duplicateVertex.vertices[7]!, pointMm: [...duplicateVertex.vertices[6]!.pointMm] };

  for (const topology of [hole, innerShell, curved, missingFace, duplicateVertex]) {
    assert.equal(verifyRectangularTopology(topology, frame).status, "unsupported");
  }
});

test("rejects damaged manifold incidence, inward normals and ambiguous axes", () => {
  const incidence = cuboid();
  incidence.edges[0] = { ...incidence.edges[0]!, faceIds: ["x0", "z0"] };
  assert.equal(verifyRectangularTopology(incidence, frame).status, "unsupported");

  const inward = cuboid();
  inward.faces[0] = { ...inward.faces[0]!, normal: [1, 0, 0] };
  assert.equal(verifyRectangularTopology(inward, frame).status, "unsupported");

  assert.deepEqual(
    verifyRectangularTopology(cuboid(), { lengthAxis: [1, 0, 0], heightAxis: [1, 0, 0] }),
    { status: "unsupported", reasons: ["member-axes-are-not-perpendicular"] },
  );
});

test("keeps native tolerance far below the 0.01 mm acceptance tolerance at large scale", () => {
  const topology = scaleTopology(cuboid(), 1_000);
  const result = verifyRectangularTopology(topology, frame);
  assert.deepEqual(result, { status: "verified", lengthMm: 80_000, widthMm: 20_000, heightMm: 10_000 });

  topology.vertices.find((vertex) => vertex.id === 6)!.pointMm[0] -= 0.001;
  assert.equal(verifyRectangularTopology(topology, frame).status, "unsupported");
});

test("reads exact native topology and ignores display bounds", async () => {
  const state = runtimeState("r1");
  let nativeSource = "";
  const runtime = {
    async getState() { return state; },
    async readNative(source: string) { nativeSource = source; return cuboid(); },
  } as unknown as PlasticityRuntime;

  const evidence = await inspectRectangularMember(runtime, {
    bodyId: 7,
    revision: "r1",
    lengthAxis: [1, 0, 0],
    heightAxis: [0, 0, 1],
  }, "session-1");

  assert.equal(evidence.status, "verified");
  assert.deepEqual(evidence.dimensions, { lengthMm: 80, widthMm: 20, heightMm: 10 });
  assert.deepEqual(evidence.binding, { sessionId: "session-1", documentToken: "doc-1", revision: "r1", bodyId: 7 });
  assert.match(nativeSource, /GetPointAndTangent/);
  assert.match(nativeSource, /GetVertices/);
  assert.match(nativeSource, /\.Check\(/);
  assert.doesNotMatch(nativeSource, /FindBox|getBoundingBox/);
});

test("discards topology when the document changes during collection", async () => {
  let reads = 0;
  const runtime = {
    async getState() { reads += 1; return runtimeState(reads === 1 ? "r1" : "r2"); },
    async readNative() { return cuboid(); },
  } as unknown as PlasticityRuntime;

  const evidence = await inspectRectangularMember(runtime, {
    bodyId: 7,
    revision: "r1",
    lengthAxis: [1, 0, 0],
    heightAxis: [0, 0, 1],
  }, "session-1");

  assert.equal(evidence.status, "unsupported");
  assert.ok(evidence.reasons.includes("stale-reference"));
  assert.equal(evidence.dimensions, undefined);
});

test("PlasticityOperations delegates with its datum registry session", async () => {
  const state = runtimeState("r1");
  const runtime = {
    getCapabilities() { return []; },
    async getState() { return state; },
    async readNative() { return cuboid(); },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-owned");

  const evidence = await operations.inspectRectangularMember({ bodyId: 7, revision: "r1", ...frame });

  assert.equal(evidence.binding.sessionId, "session-owned");
  assert.equal(evidence.status, "verified");
});

function cuboid(): RectangularTopology {
  return {
    solid: true,
    checkCodes: [],
    vertices: [
      { id: 1, pointMm: [0, 0, 0] }, { id: 2, pointMm: [80, 0, 0] },
      { id: 3, pointMm: [0, 20, 0] }, { id: 4, pointMm: [80, 20, 0] },
      { id: 5, pointMm: [0, 0, 10] }, { id: 6, pointMm: [80, 0, 10] },
      { id: 7, pointMm: [0, 20, 10] }, { id: 8, pointMm: [80, 20, 10] },
    ],
    edges: [
      { id: "e1", linear: true, vertices: [1, 2], faceIds: ["y0", "z0"] },
      { id: "e2", linear: true, vertices: [3, 4], faceIds: ["y1", "z0"] },
      { id: "e3", linear: true, vertices: [5, 6], faceIds: ["y0", "z1"] },
      { id: "e4", linear: true, vertices: [7, 8], faceIds: ["y1", "z1"] },
      { id: "e5", linear: true, vertices: [1, 3], faceIds: ["x0", "z0"] },
      { id: "e6", linear: true, vertices: [2, 4], faceIds: ["x1", "z0"] },
      { id: "e7", linear: true, vertices: [5, 7], faceIds: ["x0", "z1"] },
      { id: "e8", linear: true, vertices: [6, 8], faceIds: ["x1", "z1"] },
      { id: "e9", linear: true, vertices: [1, 5], faceIds: ["x0", "y0"] },
      { id: "e10", linear: true, vertices: [2, 6], faceIds: ["x1", "y0"] },
      { id: "e11", linear: true, vertices: [3, 7], faceIds: ["x0", "y1"] },
      { id: "e12", linear: true, vertices: [4, 8], faceIds: ["x1", "y1"] },
    ],
    faces: [
      { id: "x0", planar: true, normal: [-1, 0, 0], edgeIds: ["e5", "e7", "e9", "e11"] },
      { id: "x1", planar: true, normal: [1, 0, 0], edgeIds: ["e6", "e8", "e10", "e12"] },
      { id: "y0", planar: true, normal: [0, -1, 0], edgeIds: ["e1", "e3", "e9", "e10"] },
      { id: "y1", planar: true, normal: [0, 1, 0], edgeIds: ["e2", "e4", "e11", "e12"] },
      { id: "z0", planar: true, normal: [0, 0, -1], edgeIds: ["e1", "e2", "e5", "e6"] },
      { id: "z1", planar: true, normal: [0, 0, 1], edgeIds: ["e3", "e4", "e7", "e8"] },
    ],
  };
}

function scaleTopology(topology: RectangularTopology, factor: number): RectangularTopology {
  return {
    ...topology,
    vertices: topology.vertices.map((vertex) => ({
      ...vertex,
      pointMm: vertex.pointMm.map((value) => value * factor) as [number, number, number],
    })),
  };
}

function runtimeState(revision: string): RuntimeState {
  return {
    targetId: "window-1",
    title: "Untitled - Plasticity",
    documentToken: "doc-1",
    revision,
    dbVersion: revision === "r1" ? 1 : 2,
    undoDepth: 0,
    redoDepth: 0,
    regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p1", viewStateToken: "v1" },
    bodies: [{
      id: 7,
      versionId: 17,
      type: "Solid",
      name: "Member",
      boundsMm: { min: [-500, -500, -500], max: [500, 500, 500] },
      faceIds: [],
      edgeIds: [],
      faces: [],
      edges: [],
    }],
  };
}
