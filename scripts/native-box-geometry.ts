import assert from "node:assert/strict";
import type { RuntimeState } from "../src/plasticity/runtime.ts";

/** Verify the closed analytic box topology without treating FindBox as tight. */
export function verifyNativeBoxGeometry(body: RuntimeState["bodies"][number], minimum: number[], maximum: number[], toleranceMm = 0.00001) {
  assert.equal(body.type, "Solid");
  assert(Number.isFinite(toleranceMm) && toleranceMm > 0 && minimum.length === 3 && maximum.length === 3 && minimum.every((value, axis) => Number.isFinite(value) && Number.isFinite(maximum[axis]) && maximum[axis]! > value), "Invalid nominal box frame/tolerance");
  const vertices = body.vertices ?? [];
  assert.equal(vertices.length, 8, "Expected eight native box vertices");
  assert.equal(body.edges.length, 12, "Expected twelve native box edges");
  assert.equal(body.faces.length, 6, "Expected six native box faces");
  const expected = Array.from({ length: 8 }, (_, mask) => minimum.map((value, axis) => mask & (1 << axis) ? maximum[axis]! : value));
  const near = (a: number, b: number) => Number.isFinite(a) && Math.abs(a - b) <= toleranceMm;
  const matched = new Set<number>();
  const byId = new Map(vertices.map(vertex => [vertex.id, vertex]));
  assert.equal(byId.size, 8, "Duplicate native vertex identity");
  for (const vertex of vertices) {
    const index = expected.findIndex(point => point.every((value, axis) => near(vertex.positionMm[axis]!, value)));
    assert(index >= 0 && !matched.has(index), "Native vertex does not match a unique nominal box corner"); matched.add(index);
  }
  const edgeById = new Map(body.edges.map(edge => [edge.id, edge]));
  assert.equal(edgeById.size, 12, "Duplicate native edge identity");
  const faceById = new Map(body.faces.map(face => [face.id,face]));
  assert.equal(faceById.size,6,"Duplicate native face identity");
  const pairs = new Set<string>();
  for (const edge of body.edges) {
    assert(["Line","SPCurve"].includes(edge.curveType), "Unsupported box edge carrier");
    assert.equal(edge.vertexIds.length, 2);
    const [first, second] = edge.vertexIds.map(id => byId.get(id));
    assert(first && second && first.id !== second.id, "Box edge has invalid native endpoints");
    const differences = first.positionMm.map((value, axis) => value - second.positionMm[axis]!);
    assert.equal(differences.filter(value => Math.abs(value) > toleranceMm).length, 1, "Box edge is not parallel to a nominal axis");
    assert(near(edge.lengthMm, Math.hypot(...differences)), "Box edge length does not match its endpoints");
    const axis = differences.findIndex(value => Math.abs(value) > toleranceMm);
    assert(edge.tangent.every((value, index) => Number.isFinite(value) && Math.abs(Math.abs(value) - (index === axis ? 1 : 0)) <= 1e-8), "Box edge tangent is not axial");
    assert.equal(edge.faceIds.length,2,"Box edge needs exactly two supporting faces");
    assert.equal(new Set(edge.faceIds).size,2,"Box edge needs two distinct supporting faces");
    const carriers = edge.faceIds.map(id => faceById.get(id));
    assert(carriers.every(face => face?.planar && face.surfaceType === "Plane" && face.edgeIds.includes(edge.id)), "Box edge is missing its supporting planes");
    const [a,b] = carriers;
    assert(Math.abs(a!.normal.reduce((sum,value,index) => sum + value*b!.normal[index]!,0)) <= 1e-8, "Box edge planes do not constrain a straight intersection");
    for (const carrier of carriers) for(let coordinate=0;coordinate<3;coordinate++) {
      if(Math.abs(carrier!.normal[coordinate]!) > 1-1e-8) assert(near(edge.centerMm[coordinate]!,carrier!.centerMm[coordinate]!), "Box edge midpoint is off its supporting plane");
    }
    const pair = [first.id, second.id].sort((a,b) => a-b).join(":"); assert(!pairs.has(pair), "Duplicate geometric box edge"); pairs.add(pair);
  }
  const sides = new Set<string>();
  for (const face of body.faces) {
    assert(face.planar && face.surfaceType === "Plane", "Box face is not an analytic plane");
    const axis = face.normal.findIndex(value => Math.abs(Math.abs(value) - 1) <= 1e-8);
    assert(axis >= 0 && face.normal.every((value, index) => index === axis || Math.abs(value) <= 1e-8), "Box face normal is not axial");
    const side = `${axis}:${Math.sign(face.normal[axis]!)}`; assert(!sides.has(side), "Duplicate oriented box face"); sides.add(side);
    const coordinate = face.normal[axis]! < 0 ? minimum[axis]! : maximum[axis]!;
    assert(near(face.centerMm[axis]!, coordinate), "Box face carrier is off the nominal plane");
    assert.equal(face.edgeIds.length, 4, "Box face has extra boundary references");
    assert.equal(new Set(face.edgeIds).size, 4, "Box face is not a four-edge boundary");
    const faceVertices = new Set<number>();
    for (const id of face.edgeIds) {
      const edge = edgeById.get(id); assert(edge, "Box face references an unknown edge");
      for (const vertexId of edge.vertexIds) {
        const vertex = byId.get(vertexId)!; assert(near(vertex.positionMm[axis]!, coordinate), "Box face boundary is off-plane"); faceVertices.add(vertexId);
      }
    }
    assert.equal(faceVertices.size, 4, "Box face is not bounded by four corners");
  }
  return { method: "native-planar-topology", vertexCount: 8, planeConstrainedEdgeCount: 12, nativeLineEdgeCount: body.edges.filter(edge => edge.line).length, planarFaceCount: 6, minimum, maximum, toleranceMm };
}
