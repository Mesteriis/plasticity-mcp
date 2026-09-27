import assert from "node:assert/strict";
import { test } from "node:test";

import { validateObj } from "./obj.ts";

test("validates a millimeter OBJ mesh and reports saved bounds", () => {
  const data = Buffer.from(`o box
v 0 0 0
v 20 0 0
v 0 10 5
vt 0 0
vt 1 0
vt 0 1
vn 0 0 1
f 1/1/1 2/2/1 3/3/1
`);
  assert.deepEqual(validateObj(data), {
    objects: 1,
    vertices: 3,
    textureCoordinates: 3,
    normals: 1,
    faces: 1,
    triangles: 1,
    boundsMm: { min: [0, 0, 0], max: [20, 10, 5], size: [20, 10, 5] },
  });
});

test("validates negative OBJ indices and triangulates polygon counts", () => {
  const result = validateObj(Buffer.from("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf -4 -3 -2 -1\n"));
  assert.equal(result.objects, 1);
  assert.equal(result.faces, 1);
  assert.equal(result.triangles, 2);
});

test("rejects empty, malformed, nonfinite, and out-of-range OBJ geometry", () => {
  assert.throws(() => validateObj(Buffer.alloc(0)), /empty/u);
  assert.throws(() => validateObj(Buffer.from("v 0 0 NaN\nf 1 1 1\n")), /finite/u);
  assert.throws(() => validateObj(Buffer.from("v 0 0 0\nv 1 0 0\nf 1 2\n")), /fewer than three/u);
  assert.throws(() => validateObj(Buffer.from("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 4\n")), /out of range/u);
  assert.throws(() => validateObj(Buffer.from("v 0 0 0\n")), /without mesh/u);
});
