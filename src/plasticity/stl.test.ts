import assert from "node:assert/strict";
import test from "node:test";

import { validateStl } from "./stl.ts";

test("validates binary STL triangles and finite vertex bounds", () => {
  const data = Buffer.alloc(134);
  data.write("binary triangle", 0, "ascii");
  data.writeUInt32LE(1, 80);
  const values = [0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0];
  values.forEach((value, index) => data.writeFloatLE(value, 84 + index * 4));
  data.writeUInt16LE(0, 132);
  assert.deepEqual(validateStl(data), {
    triangles: 1,
    bounds: { min: [0, 0, 0], max: [2, 3, 0] },
    format: "binary",
  });
});

test("validates ASCII STL facets and rejects truncated or non-finite meshes", () => {
  const data = Buffer.from(`solid sample\n facet normal 0 0 1\n outer loop\n vertex 0 0 0\n vertex 2 0 0\n vertex 0 3 0\n endloop\n endfacet\nendsolid sample\n`);
  assert.deepEqual(validateStl(data), {
    triangles: 1,
    bounds: { min: [0, 0, 0], max: [2, 3, 0] },
    format: "ascii",
  });
  assert.throws(() => validateStl(Buffer.from("solid empty\nendsolid empty\n")), /no complete triangles/i);
  assert.throws(() => validateStl(Buffer.from("solid sample\nfacet normal NaN 0 1\nendsolid sample\n")), /must be finite/i);
  assert.throws(() => validateStl(Buffer.from("solid sample\nfacet normal 0 0 1\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendfacet\nendsolid sample\n")), /malformed vertex|closed loop/i);
});
