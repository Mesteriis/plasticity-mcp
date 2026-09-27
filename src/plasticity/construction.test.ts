import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cross,
  ConstructionGeometry,
  distance,
  dot,
  frameFromOriginNormalX,
  frameFromThreePoints,
  localPointToWorld,
  normalizePlaneSnapshotIds,
  offsetFrame,
  planeToken,
  rotateFrameAboutAxis,
  type ConstructionPlaneDescriptor,
  type Vector3,
} from "./construction.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

const EPSILON = 1e-9;

function assertVectorClose(actual: Vector3, expected: Vector3, tolerance = EPSILON): void {
  actual.forEach((value, index) => {
    assert.ok(
      Math.abs(value - expected[index]!) <= tolerance,
      `axis ${index}: expected ${expected[index]}, received ${value}`,
    );
  });
}

test("normalizes an explicit frame into a right-handed orthonormal basis", () => {
  const frame = frameFromOriginNormalX([10, 20, 30], [0, 0, 5], [2, 0, 1]);

  assert.deepEqual(frame.originMm, [10, 20, 30]);
  assertVectorClose(frame.normal, [0, 0, 1]);
  assertVectorClose(frame.xDirection, [1, 0, 0]);
  assertVectorClose(frame.yDirection, [0, 1, 0]);
  assert.ok(dot(cross(frame.xDirection, frame.yDirection), frame.normal) > 0.999999);
});

test("rejects degenerate explicit frames before constructing a basis", () => {
  assert.throws(() => frameFromOriginNormalX([0, 0, 0], [0, 0, 0], [1, 0, 0]), /normal.*zero/i);
  assert.throws(() => frameFromOriginNormalX([0, 0, 0], [0, 0, 1], [0, 0, 2]), /parallel/i);
  assert.throws(() => frameFromOriginNormalX([0, 0, 0], [0, 0, 1], [1e-12, 0, 2]), /parallel/i);
});

test("constructs, offsets, rotates, and evaluates plane-local coordinates", () => {
  const frame = frameFromThreePoints([0, 0, 0], [1, 1, 0], [0, 0, 1]);
  const world = localPointToWorld(frame, [4, -2, 0]);
  const expected = [Math.SQRT2 * 2, Math.SQRT2 * 2, -2] as Vector3;
  assertVectorClose(world, expected);

  const offset = offsetFrame(frame, 12.5);
  assertVectorClose(offset.originMm, [frame.normal[0] * 12.5, frame.normal[1] * 12.5, frame.normal[2] * 12.5]);

  const axis = { originMm: [0, 0, 0] as Vector3, direction: frame.xDirection };
  const rotated = rotateFrameAboutAxis(frame, axis, 30);
  assert.ok(Math.abs(distance(rotated.originMm, axis.originMm) - distance(frame.originMm, axis.originMm)) <= EPSILON);
  assert.ok(dot(cross(rotated.xDirection, rotated.yDirection), rotated.normal) > 0.999999);
});

test("rejects coincident and nearly collinear three-point planes", () => {
  assert.throws(() => frameFromThreePoints([0, 0, 0], [0, 0, 0], [0, 1, 0]), /coincident/i);
  assert.throws(() => frameFromThreePoints([0, 0, 0], [1, 0, 0], [2, 1e-12, 0]), /collinear/i);
});

test("rejects a rotation axis that is not coplanar", () => {
  const frame = frameFromOriginNormalX([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  assert.throws(
    () => rotateFrameAboutAxis(frame, { originMm: [0, 0, 1], direction: [1, 0, 0] }, 30),
    /coplanar/i,
  );
});

test("creates a deterministic token and canonicalizes negative zero", () => {
  const plane: ConstructionPlaneDescriptor = {
    id: "custom:7",
    nativeId: "7",
    name: "Fixture",
    source: "saved",
    originMm: [-0, 2, 3],
    normal: [0, 0, 1],
    xDirection: [1, 0, 0],
    yDirection: [0, 1, 0],
  };

  assert.equal(planeToken([plane]), planeToken([{ ...plane, originMm: [0, 2, 3] }]));
  assert.doesNotMatch(planeToken([plane]), /-0/);
  assert.ok(planeToken([plane]).length < 32);
});

test("decodes Plasticity plane snapshot IDs as array-index to native-ID mappings", () => {
  assert.deepEqual(normalizePlaneSnapshotIds({ 0: 1, 1: 4 }), [["1", 0], ["4", 1]]);
  assert.deepEqual(normalizePlaneSnapshotIds(new Map([[0, 2], [1, 8]])), [["2", 0], ["8", 1]]);
});

test("creates a native plane with one millimetre-to-metre conversion and unique read-back", async () => {
  const frame = frameFromOriginNormalX([10, 20, 30], [0, 0, 1], [1, 0, 0]);
  const created = savedPlane("plane:7", "7", frame);
  const fake = new FakeRuntime([runtimeState("r1", []), runtimeState("r2", [created])]);
  const adapter = new ConstructionGeometry(fake as unknown as PlasticityRuntime);

  const result = await adapter.createPlane(frame, "Fixture", "r1");

  assert.equal(result.plane.nativeId, "7");
  assert.deepEqual(fake.mutations[0]?.bindings, [
    "SaveConstructionPlaneCommand",
    "ConstructionPlaneSnap",
    "Vector3",
  ]);
  assert.match(fake.mutations[0]?.source ?? "", /planes\.begin\(\)/);
  assert.match(fake.mutations[0]?.source ?? "", /planes\.commit\(\)/);
  assert.match(fake.mutations[0]?.source ?? "", /plane\.name = args\.name/);
  assert.deepEqual(fake.mutations[0]?.values, [{
    name: "Fixture",
    point: [0.01, 0.02, 0.03],
    normal: [0, 0, 1],
    xDirection: [1, 0, 0],
  }]);
});

test("rejects stale plane writes and protected standard planes before mutation", async () => {
  const fake = new FakeRuntime([runtimeState("current", [])]);
  const adapter = new ConstructionGeometry(fake as unknown as PlasticityRuntime);
  const frame = frameFromOriginNormalX([0, 0, 0], [0, 0, 1], [1, 0, 0]);

  await assert.rejects(adapter.createPlane(frame, undefined, "old"), /stale/i);
  await assert.rejects(adapter.removePlane("Top", "current"), /standard/i);
  assert.equal(fake.mutations.length, 0);
});

test("rejects non-unique native plane read-back with observed ID sets", async () => {
  const frame = frameFromOriginNormalX([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const fake = new FakeRuntime([
    runtimeState("r1", []),
    runtimeState("r2", [savedPlane("plane:7", "7", frame), savedPlane("plane:8", "8", frame)]),
  ]);
  const adapter = new ConstructionGeometry(fake as unknown as PlasticityRuntime);

  await assert.rejects(adapter.createPlane(frame, undefined, "r1"), /before=.*after=/i);
  assert.equal(fake.mutations.length, 1);
  assert.equal(fake.isUncertain(), true);
});

test("passes through a timed-out create without retrying it", async () => {
  const frame = frameFromOriginNormalX([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const fake = new FakeRuntime([runtimeState("r1", [])]);
  fake.mutationError = new Error("Plasticity CDP command timed out");
  const adapter = new ConstructionGeometry(fake as unknown as PlasticityRuntime);

  await assert.rejects(adapter.createPlane(frame, undefined, "r1"), /timed out/i);
  assert.equal(fake.mutations.length, 1);
  assert.equal(fake.getStateCalls, 1);
});

test("rejects a background Plasticity target before native mutation", async () => {
  const frame = frameFromOriginNormalX([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const fake = new FakeRuntime([runtimeState("r1", [])]);
  fake.focused = false;
  const adapter = new ConstructionGeometry(fake as unknown as PlasticityRuntime);

  await assert.rejects(adapter.createPlane(frame, undefined, "r1"), /foreground/i);
  assert.equal(fake.mutations.length, 0);
});

test("removes a saved plane through the native remove command contract", async () => {
  const frame = frameFromOriginNormalX([0, 0, 10], [0, 0, 1], [1, 0, 0]);
  const fake = new FakeRuntime([runtimeState("r1", [savedPlane("plane:7", "7", frame)]), runtimeState("r2", [])]);
  const adapter = new ConstructionGeometry(fake as unknown as PlasticityRuntime);

  const result = await adapter.removePlane("7", "r1");

  assert.equal(result.revision, "r2");
  assert.deepEqual(fake.mutations[0]?.bindings, ["RemovePlaneCommand"]);
  assert.deepEqual(fake.mutations[0]?.values, [{ nativeId: "7" }]);
  assert.match(fake.mutations[0]?.source ?? "", /planes\.begin\(\)/);
  assert.match(fake.mutations[0]?.source ?? "", /planes\.commit\(\)/);
});

test("marks removal uncertain when read-back switches documents", async () => {
  const frame = frameFromOriginNormalX([0, 0, 10], [0, 0, 1], [1, 0, 0]);
  const before = runtimeState("r1", [savedPlane("plane:7", "7", frame)]);
  const after = runtimeState("r2", []);
  after.documentToken = "other-document";
  const fake = new FakeRuntime([before, after]);

  await assert.rejects(new ConstructionGeometry(fake as unknown as PlasticityRuntime).removePlane("7", "r1"), /uncertain.*document changed/i);
  assert.equal(fake.isUncertain(), true);
});

test("capability-gates active workplane control and uses the verified accessor", async () => {
  const frame = frameFromOriginNormalX([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const plane = savedPlane("plane:7", "7", frame);
  const unavailable = new FakeRuntime([runtimeState("r1", [plane])], []);
  await assert.rejects(
    new ConstructionGeometry(unavailable as unknown as PlasticityRuntime).setWorkplane(plane),
    /unavailable/i,
  );
  assert.equal(unavailable.nativeReads.length, 0);

  const available = new FakeRuntime([runtimeState("r1", [plane]), runtimeState("r1", [plane])]);
  await new ConstructionGeometry(available as unknown as PlasticityRuntime).setWorkplane(plane);
  assert.deepEqual(available.mutations[0]?.bindings, ["ConstructionPlaneDatabase"]);
  assert.deepEqual(available.mutations[0]?.values, [{ id: "plane:7", nativeId: "7", source: "saved" }]);
});

test("routes workplane changes through the uncertainty-aware mutation path", async () => {
  const plane = savedPlane("plane:7", "7", frameFromOriginNormalX([0, 0, 0], [0, 0, 1], [1, 0, 0]));
  const fake = new FakeRuntime([runtimeState("r1", [plane])]);
  fake.mutationError = new Error("Plasticity CDP command timed out");
  await assert.rejects(new ConstructionGeometry(fake as unknown as PlasticityRuntime).setWorkplane(plane), /timed out/i);
  assert.equal(fake.mutations.length, 1);
});

class FakeRuntime {
  readonly mutations: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  readonly nativeReads: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  mutationError: Error | undefined;
  focused = true;
  uncertain = false;
  getStateCalls = 0;
  private readonly states: RuntimeState[];
  private readonly capabilities: string[];

  constructor(states: RuntimeState[], capabilities = [
    "SaveConstructionPlaneCommand",
    "RemovePlaneCommand",
    "ConstructionPlaneDatabase",
    "ConstructionPlaneSnap",
    "Vector3",
  ]) {
    this.states = [...states];
    this.capabilities = capabilities;
  }

  getCapabilities(): string[] {
    return [...this.capabilities];
  }

  async getState(): Promise<RuntimeState> {
    this.getStateCalls += 1;
    const state = this.states.shift();
    if (!state) throw new Error("Fake runtime state queue is empty");
    return state;
  }

  async mutate(source: string, bindings: string[], values: unknown[]): Promise<unknown> {
    if (this.uncertain) throw new Error("Previous mutation outcome is uncertain; call reconcile before another mutation");
    this.mutations.push({ source, bindings, values });
    if (this.mutationError) throw this.mutationError;
    return undefined;
  }

  markUncertain(): void { this.uncertain = true; }

  isUncertain(): boolean { return this.uncertain; }

  async read(): Promise<boolean> {
    return this.focused;
  }

  async readNative(source: string, bindings: string[], values: unknown[]): Promise<unknown> {
    this.nativeReads.push({ source, bindings, values });
    return undefined;
  }
}

function runtimeState(revision: string, savedPlanes: ConstructionPlaneDescriptor[]): RuntimeState {
  const planes = [standardTop(), ...savedPlanes];
  return {
    targetId: "window-1",
    title: "Untitled - Plasticity",
    documentToken: "document-1",
    revision,
    dbVersion: 1,
    undoDepth: 0,
    redoDepth: 0,
    regions: [],
    bodies: [],
    construction: {
      planes,
      activePlaneId: "standard:top",
      planeStateToken: planeToken(planes),
      viewStateToken: "workplane:standard:top",
    },
  };
}

function savedPlane(id: string, nativeId: string, frame: ReturnType<typeof frameFromOriginNormalX>): ConstructionPlaneDescriptor {
  return { id, nativeId, name: `Custom plane ${nativeId}`, source: "saved", ...frame };
}

function standardTop(): ConstructionPlaneDescriptor {
  return {
    id: "standard:top",
    nativeId: "Top",
    name: "XY",
    source: "standard",
    ...frameFromOriginNormalX([0, 0, 0], [0, 0, 1], [1, 0, 0]),
  };
}
