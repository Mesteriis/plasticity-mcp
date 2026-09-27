import assert from "node:assert/strict";
import test from "node:test";

import { rigidBodyConstraintRank } from "./rigid-body-constraints.ts";

const boundsMm = { min: [0, 0, 0] as [number, number, number], max: [10, 10, 10] as [number, number, number] };

test("counts rigid-body modes removed by real mesh nodes on supported faces", () => {
  const mesh = `*NODE
1, 0, 0, 0
2, 10, 0, 0
3, 10, 10, 0
4, 0, 10, 0
5, 0, 0, 10
*ELEMENT, TYPE=C3D4, ELSET=SOLID
*NSET, NSET=FACE_1
1, 2, 3, 4
*NSET, NSET=FACE_2
1, 5
`;
  assert.equal(rigidBodyConstraintRank(mesh, [{ nodeSetName: "FACE_1", axes: [1, 2, 3] }], boundsMm), 6);
  assert.equal(rigidBodyConstraintRank(mesh, [{ nodeSetName: "FACE_2", axes: [1, 2, 3] }], boundsMm), 5);
  assert.equal(rigidBodyConstraintRank(mesh, [{ nodeSetName: "FACE_1", axes: [3] }], boundsMm), 3);
});

test("rejects a support set that has no corresponding node coordinates", () => {
  assert.throws(
    () => rigidBodyConstraintRank("*NODE\n1, 0, 0, 0\n*NSET, NSET=OTHER\n1\n", [{ nodeSetName: "FACE_1", axes: [1, 2, 3] }], boundsMm),
    /no mesh nodes/,
  );
});
