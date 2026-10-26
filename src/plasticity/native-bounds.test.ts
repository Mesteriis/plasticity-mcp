import assert from "node:assert/strict";
import test from "node:test";
import { NATIVE_BODY_BOUNDS } from "./native-bounds.ts";

const makeReader = (kernel: unknown): any => Function(`return (${NATIVE_BODY_BOUNDS})`)()(kernel);
const points = [4,0,2, -4,0,2, 0,4,2, 0,-4,2, 0,0,4, 0,0,0];
const good = () => ({ ok: 6, errors: new Int32Array(6), extremes: Float64Array.from(points) });

test("native extrema use six lexicographic direction triads and replace conservative body boxes", () => {
  let constructors = 0; let queries = 0;
  class Eval {
    constructor(context: unknown) { assert.equal(context, "context"); constructors += 1; }
    Extremes(ids: Int32Array, directions: Float64Array) {
      assert.deepEqual([...ids], Array(6).fill(42)); assert.equal(directions.length, 54); queries += 1;
      assert.deepEqual([...directions.slice(36, 45)], [0,0,1,1,0,0,0,1,0]);
      return good();
    }
  }
  const read = makeReader({ Eval, Context: { Get: () => "context" } });
  const model = { Id: () => 42, FindBox() { throw new Error("Conservative box must not be read"); } };
  for (const type of ["Solid", "Sheet"]) assert.deepEqual(read(model, type), { box: { min: { x: -4, y: -4, z: 0 }, max: { x: 4, y: 4, z: 4 } }, method: "native-extrema" });
  assert.equal(constructors, 1); assert.equal(queries, 2);
});

test("legacy bodies and Wires retain explicitly identified native box bounds", () => {
  const box = { min: { x: -4.1, y: -4.1, z: -0.4 }, max: { x: 4.1, y: 4.1, z: 4.4 } };
  const model = { FindBox: () => box };
  assert.deepEqual(makeReader({ Eval: class {} })(model, "Solid"), { box, method: "native-box" });
  assert.deepEqual(makeReader({ Eval: class { Extremes() { throw new Error("Wire must retain its own box API"); } } })(model, "Wire"), { box, method: "native-box" });
});

test("failed, incomplete, nonfinite or inverted extrema reject without falling back", () => {
  const inverted = good(); inverted.extremes[3] = 5;
  const nonfinite = good(); nonfinite.extremes[0] = NaN;
  for (const result of [{ ...good(), ok: 5 }, { ...good(), errors: Int32Array.of(1,0,0,0,0,0) }, { ...good(), extremes: Float64Array.of(1) }, nonfinite, inverted]) {
    const read = makeReader({ Eval: class { Extremes() { return result; } }, Context: { Get: () => ({}) } });
    assert.throws(() => read({ Id: () => 42, FindBox() { throw new Error("Fallback forbidden"); } }, "Solid"), /extrema.*(failed|inverted)/);
  }
});

test("invalid native IDs cannot wrap into a different Int32 topology", () => {
  const read = makeReader({ Eval: class { Extremes() { throw new Error("Native query must not run"); } }, Context: { Get: () => ({}) } });
  for (const id of [0, -1, NaN, 2147483648, "42", true]) assert.throws(() => read({ Id: () => id }, "Solid"), /identity unavailable/);
});
