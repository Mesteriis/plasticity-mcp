import assert from "node:assert/strict";
import { test } from "node:test";

import { BlindHolePatternRecipeError, BlindHoleRecipeError, CounterborePatternRecipeError, CounterboreRecipeError, CountersinkPatternRecipeError, HeatSetInsertPocketPatternRecipeError, HexNutPocketPatternRecipeError, PlasticityRecipes, ScrewBossPatternRecipeError, SlottedHolePatternRecipeError, SlottedHoleRecipeError, ThroughHolePatternRecipeError, ThroughHoleRecipeError } from "./recipes.ts";
import type { RuntimeState } from "./runtime.ts";

test("countersink combines an exact through cutter with a revolved annular cutter", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const target = body(7, "Solid");
  let state = scene("r1", [target]);
  const operations = {
    async state() { return state; },
    async createCylinder(centerMm: [number, number, number], radiusMm: number, heightMm: number, _name: string | undefined, revision: string, axis: [number, number, number]) {
      calls.push({ operation: "createCylinder", centerMm, radiusMm, heightMm, axis, revision });
      state = scene("r2", [target, body(8, "Solid")]);
      return state;
    },
    async createPolyline(pointsMm: Array<[number, number, number]>, closed: boolean, revision: string) {
      calls.push({ operation: "createPolyline", pointsMm, closed, revision });
      state = scene("r3", [target, body(8, "Solid"), body(9, "Wire")]);
      return state;
    },
    async revolveProfile(id: number, axisOriginMm: [number, number, number], axis: [number, number, number], angleDegrees: number, revision: string) {
      calls.push({ operation: "revolveProfile", id, axisOriginMm, axis, angleDegrees, revision });
      state = scene("r4", [target, body(8, "Solid"), body(9, "Wire"), body(10, "Solid")]);
      return state;
    },
    async boolean(targetIds: number[], toolIds: number[], kind: string, keepTools: boolean, revision: string) {
      calls.push({ operation: "boolean", targetIds, toolIds, kind, keepTools, revision });
      state = scene("r5", [target, body(9, "Wire")]);
      return state;
    },
  } as unknown as RecipeOperations;

  const result = await new PlasticityRecipes(operations).createCountersink({
    targetId: 7, entryCenterMm: [10, 12, 8], axis: [0, 0, -2], radialDirection: [1, 0, 0],
    throughDiameterMm: 4, countersinkMajorDiameterMm: 8, includedAngleDeg: 90,
    throughDepthMm: 8, overshootMm: 0.5, revision: "r1",
  });

  assert.deepEqual(calls, [
    { operation: "createCylinder", centerMm: [10, 12, 8.5], radiusMm: 2, heightMm: 9, axis: [0, 0, -1], revision: "r1" },
    { operation: "createPolyline", pointsMm: [
      [12, 12, 8.5], [14, 12, 8.5], [14, 12, 8], [12, 12, 6],
    ], closed: true, revision: "r2" },
    { operation: "revolveProfile", id: 9, axisOriginMm: [10, 12, 8], axis: [0, 0, -1], angleDegrees: 360, revision: "r3" },
    { operation: "boolean", targetIds: [7], toolIds: [8, 10], kind: "difference", keepTools: false, revision: "r4" },
  ]);
  assert.equal(result.recipe, "countersink");
  assert.ok(Math.abs(result.countersinkDepthMm - 2) < 1e-12);
  assert.equal(result.profileBodyId, 9);
  assert.deepEqual(result.consumedToolIds, [8, 10]);
  assert.equal(result.undoSteps, 4);
});

test("countersink rejects a depth that reaches through the target before mutation", async () => {
  const fake = counterboreOperations();
  await assert.rejects(new PlasticityRecipes(fake.operations).createCountersink({
    targetId: 7, entryCenterMm: [10, 12, 8], axis: [0, 0, -1], radialDirection: [1, 0, 0],
    throughDiameterMm: 4, countersinkMajorDiameterMm: 20, includedAngleDeg: 60,
    throughDepthMm: 8, overshootMm: 0.5, revision: "r1",
  }), /countersink depth/i);
  assert.deepEqual(fake.calls, []);
});

test("countersink pattern creates one editable revolved cutter per explicit center", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const target = body(7, "Solid");
  let state = scene("r1", [target]);
  let nextId = 8;
  let revision = 1;
  const advance = (added: ReturnType<typeof body>[], removedIds: number[] = []) => {
    revision += 1;
    state = scene(`r${revision}`, [...state.bodies.filter((candidate) => !removedIds.includes(candidate.id)), ...added]);
    return state;
  };
  const operations = {
    async state() { return state; },
    async createCylinder(centerMm: [number, number, number], radiusMm: number, heightMm: number, _name: string | undefined, currentRevision: string, axis: [number, number, number]) {
      calls.push({ operation: "createCylinder", centerMm, radiusMm, heightMm, axis, revision: currentRevision });
      return advance([body(nextId++, "Solid")]);
    },
    async createPolyline(pointsMm: Array<[number, number, number]>, closed: boolean, currentRevision: string) {
      calls.push({ operation: "createPolyline", pointsMm, closed, revision: currentRevision });
      return advance([body(nextId++, "Wire")]);
    },
    async revolveProfile(id: number, axisOriginMm: [number, number, number], axis: [number, number, number], angleDegrees: number, currentRevision: string) {
      calls.push({ operation: "revolveProfile", id, axisOriginMm, axis, angleDegrees, revision: currentRevision });
      return advance([body(nextId++, "Solid")]);
    },
    async boolean(targetIds: number[], toolIds: number[], kind: string, keepTools: boolean, currentRevision: string) {
      calls.push({ operation: "boolean", targetIds, toolIds, kind, keepTools, revision: currentRevision });
      return advance([], toolIds);
    },
  } as unknown as RecipeOperations;

  const result = await new PlasticityRecipes(operations).createCountersinkPattern({
    targetId: 7, entryCentersMm: [[10, 12, 8], [30, 12, 8]], axis: [0, 0, -1], radialDirection: [1, 0, 0],
    throughDiameterMm: 4, countersinkMajorDiameterMm: 8, includedAngleDeg: 90,
    throughDepthMm: 8, overshootMm: 0.5, revision: "r1",
  });

  assert.equal(result.recipe, "countersink-pattern");
  assert.equal(result.holeCount, 2);
  assert.ok(Math.abs(result.countersinkDepthMm - 2) < 1e-12);
  assert.deepEqual(result.profileBodyIds, [9, 12]);
  assert.deepEqual(result.consumedToolIds, [8, 10, 11, 13]);
  assert.equal(result.undoSteps, 7);
  assert.deepEqual(result.steps.map((item) => item.operation), [
    "create-through-cutter", "create-countersink-profile", "revolve-countersink-cutter",
    "create-through-cutter", "create-countersink-profile", "revolve-countersink-cutter",
    "boolean-difference",
  ]);
  assert.deepEqual(calls.at(-1), {
    operation: "boolean", targetIds: [7], toolIds: [8, 10, 11, 13], kind: "difference", keepTools: false, revision: "r7",
  });
});

test("countersink pattern rejects duplicate centers and reports confirmed partial work", async () => {
  const invalid = counterboreOperations();
  await assert.rejects(new PlasticityRecipes(invalid.operations).createCountersinkPattern({
    targetId: 7, entryCentersMm: [[10, 12, 8], [10, 12, 8]], axis: [0, 0, -1], radialDirection: [1, 0, 0],
    throughDiameterMm: 4, countersinkMajorDiameterMm: 8, includedAngleDeg: 90,
    throughDepthMm: 8, overshootMm: 0.5, revision: "r1",
  }), /centers must be distinct/i);
  assert.deepEqual(invalid.calls, []);

  const target = body(7, "Solid");
  let state = scene("r1", [target]);
  let mutation = 0;
  const failing = {
    async state() { return state; },
    async createCylinder() {
      mutation += 1;
      if (mutation === 5) throw new Error("second profile unavailable");
      state = scene(`r${mutation + 1}`, [...state.bodies, body(7 + mutation, "Solid")]);
      return state;
    },
    async createPolyline() {
      mutation += 1;
      if (mutation === 5) throw new Error("second profile unavailable");
      state = scene(`r${mutation + 1}`, [...state.bodies, body(7 + mutation, "Wire")]);
      return state;
    },
    async revolveProfile() {
      mutation += 1;
      state = scene(`r${mutation + 1}`, [...state.bodies, body(7 + mutation, "Solid")]);
      return state;
    },
    async boolean() { throw new Error("unexpected Boolean"); },
  } as unknown as RecipeOperations;
  await assert.rejects(new PlasticityRecipes(failing).createCountersinkPattern({
    targetId: 7, entryCentersMm: [[10, 12, 8], [30, 12, 8]], axis: [0, 0, -1], radialDirection: [1, 0, 0],
    throughDiameterMm: 4, countersinkMajorDiameterMm: 8, includedAngleDeg: 90,
    throughDepthMm: 8, overshootMm: 0.5, revision: "r1",
  }), (error: unknown) => {
    assert(error instanceof CountersinkPatternRecipeError);
    assert.equal(error.completedSteps.length, 4);
    assert.match(error.message, /4\/7 confirmed steps/);
    assert.equal(error.uncertain, false);
    return true;
  });
});

test("hex nut pocket extrudes an oriented regular hexagon and consumes the cutter", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const target = body(7, "Solid");
  const existingProfile = body(6, "Wire");
  const existingRegion = {
    id: "region-6", entityId: 60, islandVersionId: 61, sketchId: 62, sketchWireIds: [6],
    measurementSource: "render-mesh" as const, displayBoundsMm: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 0] as [number, number, number] },
  };
  let state = { ...scene("r1", [target, existingProfile]), regions: [existingRegion] };
  const operations = {
    async state() { return state; },
    async createPolyline(pointsMm: Array<[number, number, number]>, closed: boolean, revision: string) {
      calls.push({ operation: "createPolyline", pointsMm, closed, revision });
      state = { ...scene("r2", [target, existingProfile, body(8, "Wire")]), regions: [{ ...existingRegion, sketchWireIds: [6, 8] }, {
        id: "region-8", entityId: 80, islandVersionId: 81, sketchId: 82, sketchWireIds: [8],
        measurementSource: "render-mesh" as const, displayBoundsMm: { min: [7, 8.5, 8.5], max: [13, 15.5, 8.5] },
      }] };
      return state;
    },
    async extrudeRegions(regionIds: string[], distanceMm: number, revision: string) {
      calls.push({ operation: "extrudeRegions", regionIds, distanceMm, revision });
      state = { ...state, revision: "r3", bodies: [...state.bodies, body(9, "Solid")] };
      return state;
    },
    async boolean(targetIds: number[], toolIds: number[], kind: string, keepTools: boolean, revision: string) {
      calls.push({ operation: "boolean", targetIds, toolIds, kind, keepTools, revision });
      state = scene("r4", [target, existingProfile, body(8, "Wire")]);
      return state;
    },
  } as unknown as RecipeOperations;
  const radius = 6 / Math.sqrt(3);

  const result = await new PlasticityRecipes(operations).createHexNutPocket({
    targetId: 7, entryCenterMm: [10, 12, 8], axis: [0, 0, -1], flatNormalDirection: [1, 0, 0],
    acrossFlatsMm: 6, pocketDepthMm: 3, materialDepthMm: 8, overshootMm: 0.5, revision: "r1",
  });

  assert.deepEqual(calls, [
    { operation: "createPolyline", pointsMm: [
      [13, 12 - radius / 2, 8.5], [10, 12 - radius, 8.5], [7, 12 - radius / 2, 8.5],
      [7, 12 + radius / 2, 8.5], [10, 12 + radius, 8.5], [13, 12 + radius / 2, 8.5],
    ], closed: true, revision: "r1" },
    { operation: "extrudeRegions", regionIds: ["region-8"], distanceMm: 3.5, revision: "r2" },
    { operation: "boolean", targetIds: [7], toolIds: [9], kind: "difference", keepTools: false, revision: "r3" },
  ]);
  assert.equal(result.recipe, "hex-nut-pocket");
  assert.equal(result.profileBodyId, 8);
  assert.deepEqual(result.consumedToolIds, [9]);
  assert.equal(result.undoSteps, 3);
});

test("hex nut pocket rejects a flat normal parallel to its axis before mutation", async () => {
  const fake = counterboreOperations();
  await assert.rejects(new PlasticityRecipes(fake.operations).createHexNutPocket({
    targetId: 7, entryCenterMm: [10, 12, 8], axis: [0, 0, -1], flatNormalDirection: [0, 0, 2],
    acrossFlatsMm: 8, pocketDepthMm: 4, materialDepthMm: 8, overshootMm: 0.5, revision: "r1",
  }), /perpendicular/i);
  assert.deepEqual(fake.calls, []);
});

test("hex nut pocket rejects a through-depth pocket before mutation", async () => {
  const fake = counterboreOperations();
  await assert.rejects(new PlasticityRecipes(fake.operations).createHexNutPocket({
    targetId: 7, entryCenterMm: [10, 12, 8], axis: [0, 0, -1], flatNormalDirection: [1, 0, 0],
    acrossFlatsMm: 8, pocketDepthMm: 8, materialDepthMm: 8, overshootMm: 0.5, revision: "r1",
  }), /less than material depth/i);
  assert.deepEqual(fake.calls, []);
});

test("hex nut pocket pattern creates one editable profile and cutter per center", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const target = body(7, "Solid");
  let state = scene("r1", [target]);
  let nextId = 8;
  let revision = 1;
  const operations = {
    async state() { return state; },
    async createPolyline(pointsMm: Array<[number, number, number]>, closed: boolean, currentRevision: string) {
      calls.push({ operation: "createPolyline", pointsMm, closed, revision: currentRevision });
      const id = nextId++;
      const sketchWireIds = [...state.bodies.filter((candidate) => candidate.type === "Wire").map((candidate) => candidate.id), id];
      revision += 1;
      state = {
        ...scene(`r${revision}`, [...state.bodies, body(id, "Wire")]),
        regions: [...state.regions.map((region) => ({ ...region, sketchWireIds })), {
          id: `region-${id}`, entityId: id * 10, islandVersionId: id * 10 + 1, sketchId: id * 10 + 2,
          sketchWireIds, measurementSource: "render-mesh" as const,
          displayBoundsMm: { min: [0, 0, 0], max: [1, 1, 1] },
        }],
      };
      return state;
    },
    async extrudeRegions(regionIds: string[], distanceMm: number, currentRevision: string) {
      calls.push({ operation: "extrudeRegions", regionIds, distanceMm, revision: currentRevision });
      const id = nextId++;
      revision += 1;
      state = { ...state, revision: `r${revision}`, bodies: [...state.bodies, body(id, "Solid")] };
      return state;
    },
    async boolean(targetIds: number[], toolIds: number[], kind: string, keepTools: boolean, currentRevision: string) {
      calls.push({ operation: "boolean", targetIds, toolIds, kind, keepTools, revision: currentRevision });
      revision += 1;
      state = { ...state, revision: `r${revision}`, bodies: state.bodies.filter((candidate) => !toolIds.includes(candidate.id)) };
      return state;
    },
  } as unknown as RecipeOperations;

  const result = await new PlasticityRecipes(operations).createHexNutPocketPattern({
    targetId: 7, entryCentersMm: [[10, 12, 8], [30, 12, 8]], axis: [0, 0, -1], flatNormalDirection: [1, 0, 0],
    acrossFlatsMm: 8, pocketDepthMm: 4, materialDepthMm: 8, overshootMm: 0.5, revision: "r1",
  });

  assert.equal(result.recipe, "hex-nut-pocket-pattern");
  assert.equal(result.pocketCount, 2);
  assert.deepEqual(result.profileBodyIds, [8, 10]);
  assert.deepEqual(result.consumedToolIds, [9, 11]);
  assert.equal(result.undoSteps, 5);
  assert.deepEqual(result.steps.map((item) => item.operation), [
    "create-hex-pocket-profile", "extrude-hex-pocket-cutter",
    "create-hex-pocket-profile", "extrude-hex-pocket-cutter", "boolean-difference",
  ]);
  assert.deepEqual(calls.at(-1), {
    operation: "boolean", targetIds: [7], toolIds: [9, 11], kind: "difference", keepTools: false, revision: "r5",
  });
});

test("hex nut pocket pattern rejects duplicate centers and reports confirmed partial work", async () => {
  const invalid = counterboreOperations();
  await assert.rejects(new PlasticityRecipes(invalid.operations).createHexNutPocketPattern({
    targetId: 7, entryCentersMm: [[10, 12, 8], [10, 12, 8]], axis: [0, 0, -1], flatNormalDirection: [1, 0, 0],
    acrossFlatsMm: 8, pocketDepthMm: 4, materialDepthMm: 8, overshootMm: 0.5, revision: "r1",
  }), /centers must be distinct/i);
  assert.deepEqual(invalid.calls, []);

  const target = body(7, "Solid");
  let state = scene("r1", [target]);
  let mutation = 0;
  const failing = {
    async state() { return state; },
    async createPolyline() {
      mutation += 1;
      const id = 7 + mutation;
      state = {
        ...scene(`r${mutation + 1}`, [...state.bodies, body(id, "Wire")]),
        regions: [...state.regions, {
          id: `region-${id}`, entityId: id * 10, islandVersionId: id * 10 + 1, sketchId: id * 10 + 2,
          sketchWireIds: [id], measurementSource: "render-mesh" as const,
          displayBoundsMm: { min: [0, 0, 0], max: [1, 1, 1] },
        }],
      };
      return state;
    },
    async extrudeRegions() {
      mutation += 1;
      if (mutation === 4) throw new Error("second pocket extrusion unavailable");
      state = scene(`r${mutation + 1}`, [...state.bodies, body(7 + mutation, "Solid")]);
      return state;
    },
    async boolean() { throw new Error("unexpected Boolean"); },
  } as unknown as RecipeOperations;
  await assert.rejects(new PlasticityRecipes(failing).createHexNutPocketPattern({
    targetId: 7, entryCentersMm: [[10, 12, 8], [30, 12, 8]], axis: [0, 0, -1], flatNormalDirection: [1, 0, 0],
    acrossFlatsMm: 8, pocketDepthMm: 4, materialDepthMm: 8, overshootMm: 0.5, revision: "r1",
  }), (error: unknown) => {
    assert(error instanceof HexNutPocketPatternRecipeError);
    assert.equal(error.completedSteps.length, 3);
    assert.match(error.message, /3\/5 confirmed steps/);
    assert.equal(error.uncertain, false);
    return true;
  });
});

test("slotted hole combines an editable center profile with two exact round ends", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const target = body(7, "Solid");
  let state = scene("r1", [target]);
  let nextId = 8;
  const operations = {
    async state() { return state; },
    async createPolyline(pointsMm: Array<[number, number, number]>, closed: boolean, revision: string) {
      calls.push({ operation: "createPolyline", pointsMm, closed, revision });
      const id = nextId++;
      state = { ...scene("r2", [target, body(id, "Wire")]), regions: [
        {
          id: "region-from-another-wire-on-the-same-sketch", entityId: 70, islandVersionId: 71, sketchId: 72,
          sketchWireIds: [6, id], measurementSource: "render-mesh" as const,
          displayBoundsMm: { min: [1, 1, 8.5], max: [5, 5, 8.5] },
        },
        {
          id: `region-${id}`, entityId: id * 10, islandVersionId: id * 10 + 1, sketchId: id * 10 + 2,
          sketchWireIds: [6, id], measurementSource: "render-mesh" as const,
          displayBoundsMm: { min: [13.0001, 12.0001, 8.5001], max: [27.0001, 18.0001, 8.5001] },
        },
      ] };
      return state;
    },
    async extrudeRegions(regionIds: string[], distanceMm: number, revision: string) {
      calls.push({ operation: "extrudeRegions", regionIds, distanceMm, revision });
      const id = nextId++;
      state = { ...state, revision: "r3", bodies: [...state.bodies, body(id, "Solid")] };
      return state;
    },
    async createCylinder(centerMm: [number, number, number], radiusMm: number, heightMm: number, _name: string | undefined, revision: string, axis: [number, number, number]) {
      calls.push({ operation: "createCylinder", centerMm, radiusMm, heightMm, axis, revision });
      const id = nextId++;
      state = { ...state, revision: state.revision === "r3" ? "r4" : "r5", bodies: [...state.bodies, body(id, "Solid")] };
      return state;
    },
    async boolean(targetIds: number[], toolIds: number[], kind: string, keepTools: boolean, revision: string) {
      calls.push({ operation: "boolean", targetIds, toolIds, kind, keepTools, revision });
      state = scene("r6", [target, body(8, "Wire")]);
      return state;
    },
  } as unknown as RecipeOperations;

  const result = await new PlasticityRecipes(operations).createSlottedHole({
    targetId: 7, entryCenterMm: [20, 15, 8], axis: [0, 0, -1], slotDirection: [2, 0, 0],
    overallLengthMm: 20, widthMm: 6, throughDepthMm: 8, overshootMm: 0.5, revision: "r1",
  });

  assert.deepEqual(calls, [
    { operation: "createPolyline", pointsMm: [[13, 18, 8.5], [27, 18, 8.5], [27, 12, 8.5], [13, 12, 8.5]], closed: true, revision: "r1" },
    { operation: "extrudeRegions", regionIds: ["region-8"], distanceMm: 9, revision: "r2" },
    { operation: "createCylinder", centerMm: [13, 15, 8.5], radiusMm: 3, heightMm: 9, axis: [0, 0, -1], revision: "r3" },
    { operation: "createCylinder", centerMm: [27, 15, 8.5], radiusMm: 3, heightMm: 9, axis: [0, 0, -1], revision: "r4" },
    { operation: "boolean", targetIds: [7], toolIds: [9, 10, 11], kind: "difference", keepTools: false, revision: "r5" },
  ]);
  assert.equal(result.recipe, "slotted-hole");
  assert.equal(result.centerDistanceMm, 14);
  assert.equal(result.profileBodyId, 8);
  assert.deepEqual(result.consumedToolIds, [9, 10, 11]);
  assert.equal(result.undoSteps, 5);
});

test("slotted hole rejects a circular or out-of-plane definition before mutation", async () => {
  const fake = counterboreOperations();
  await assert.rejects(new PlasticityRecipes(fake.operations).createSlottedHole({
    targetId: 7, entryCenterMm: [20, 15, 8], axis: [0, 0, -1], slotDirection: [0, 0, 1],
    overallLengthMm: 6, widthMm: 6, throughDepthMm: 8, overshootMm: 0.5, revision: "r1",
  }), /overall length/i);
  assert.deepEqual(fake.calls, []);
});

test("slotted hole reports its confirmed profile when Plasticity returns no matching Region", async () => {
  const target = body(7, "Solid");
  let state = scene("r1", [target]);
  const operations = {
    async state() { return state; },
    async createPolyline() {
      state = { ...scene("r2", [target, body(8, "Wire")]), regions: [{
        id: "unrelated-region", entityId: 80, islandVersionId: 81, sketchId: 82,
        sketchWireIds: [8], measurementSource: "render-mesh" as const,
        displayBoundsMm: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 0] as [number, number, number] },
      }] };
      return state;
    },
  } as unknown as RecipeOperations;

  await assert.rejects(new PlasticityRecipes(operations).createSlottedHole({
    targetId: 7, entryCenterMm: [20, 15, 8], axis: [0, 0, -1], slotDirection: [1, 0, 0],
    overallLengthMm: 20, widthMm: 6, throughDepthMm: 8, overshootMm: 0.5, revision: "r1",
  }), (error: unknown) => {
    assert.ok(error instanceof SlottedHoleRecipeError);
    assert.equal(error.completedSteps.length, 1);
    assert.equal(error.completedSteps[0]?.operation, "create-slot-profile");
    assert.match(error.message, /1\/5 confirmed steps/u);
    return true;
  });
});

test("slotted hole pattern creates one editable profile and three cutters per center", async () => {
  const fake = slottedHolePatternOperations();
  const result = await new PlasticityRecipes(fake.operations).createSlottedHolePattern({
    targetId: 7,
    entryCentersMm: [[20, 10, 8], [20, 30, 8]],
    axis: [0, 0, -2],
    slotDirection: [2, 0, 0],
    overallLengthMm: 20,
    widthMm: 6,
    throughDepthMm: 8,
    overshootMm: 0.5,
    revision: "r1",
  });

  assert.equal(result.recipe, "slotted-hole-pattern");
  assert.equal(result.slotCount, 2);
  assert.equal(result.centerDistanceMm, 14);
  assert.deepEqual(result.profileBodyIds, [8, 12]);
  assert.deepEqual(result.consumedToolIds, [9, 10, 11, 13, 14, 15]);
  assert.equal(result.undoSteps, 9);
  assert.deepEqual(result.steps.map((item) => item.operation), [
    "create-slot-profile", "extrude-slot-center-cutter", "create-slot-end-cutter", "create-slot-end-cutter",
    "create-slot-profile", "extrude-slot-center-cutter", "create-slot-end-cutter", "create-slot-end-cutter",
    "boolean-difference",
  ]);
  assert.deepEqual(fake.calls.at(-1), {
    operation: "boolean", targetIds: [7], toolIds: [9, 10, 11, 13, 14, 15], kind: "difference", keepTools: false, revision: "r9",
  });
});

test("slotted hole pattern validates centers and reports confirmed partial work", async () => {
  const invalid = slottedHolePatternOperations();
  await assert.rejects(new PlasticityRecipes(invalid.operations).createSlottedHolePattern({
    targetId: 7, entryCentersMm: [[20, 10, 8], [20, 10, 8]], axis: [0, 0, -1], slotDirection: [1, 0, 0],
    overallLengthMm: 20, widthMm: 6, throughDepthMm: 8, overshootMm: 0.5, revision: "r1",
  }), /centers must be distinct/i);
  assert.deepEqual(invalid.calls, []);

  const failed = slottedHolePatternOperations(6);
  await assert.rejects(new PlasticityRecipes(failed.operations).createSlottedHolePattern({
    targetId: 7, entryCentersMm: [[20, 10, 8], [20, 30, 8]], axis: [0, 0, -1], slotDirection: [1, 0, 0],
    overallLengthMm: 20, widthMm: 6, throughDepthMm: 8, overshootMm: 0.5, revision: "r1",
  }), (error: unknown) => {
    assert(error instanceof SlottedHolePatternRecipeError);
    assert.equal(error.completedSteps.length, 5);
    assert.equal(error.lastConfirmedRevision, "r6");
    assert.match(error.message, /5\/9 confirmed steps/i);
    return true;
  });
});

test("counterbore creates two exact cutters and consumes them in one boolean", async () => {
  const fake = counterboreOperations();
  const recipes = new PlasticityRecipes(fake.operations);

  const result = await recipes.createCounterbore({
    targetId: 7,
    entryCenterMm: [10, 12, 8],
    axis: [0, 0, -2],
    throughDiameterMm: 4,
    counterboreDiameterMm: 8,
    counterboreDepthMm: 3,
    throughDepthMm: 8,
    overshootMm: 0.5,
    revision: "r1",
  });

  assert.deepEqual(fake.calls, [
    { operation: "createCylinder", centerMm: [10, 12, 8.5], radiusMm: 2, heightMm: 9, axis: [0, 0, -1], revision: "r1" },
    { operation: "createCylinder", centerMm: [10, 12, 8.5], radiusMm: 4, heightMm: 3.5, axis: [0, 0, -1], revision: "r2" },
    { operation: "boolean", targetIds: [7], toolIds: [8, 9], kind: "difference", keepTools: false, revision: "r3" },
  ]);
  assert.equal(result.recipe, "counterbore");
  assert.equal(result.status, "completed");
  assert.equal(result.beforeRevision, "r1");
  assert.equal(result.afterRevision, "r4");
  assert.equal(result.undoSteps, 3);
  assert.deepEqual(result.resultBodyIds, [7]);
  assert.deepEqual(result.consumedToolIds, [8, 9]);
  assert.deepEqual(result.steps.map((step) => [step.operation, step.beforeRevision, step.afterRevision]), [
    ["create-through-cutter", "r1", "r2"],
    ["create-counterbore-cutter", "r2", "r3"],
    ["boolean-difference", "r3", "r4"],
  ]);
});

test("counterbore pattern creates paired cutters per center and one final Boolean", async () => {
  const fake = counterboreOperations();
  const result = await new PlasticityRecipes(fake.operations).createCounterborePattern({
    targetId: 7,
    entryCentersMm: [[10, 10, 8], [30, 10, 8]],
    axis: [0, 0, -1],
    throughDiameterMm: 4,
    counterboreDiameterMm: 8,
    counterboreDepthMm: 3,
    throughDepthMm: 8,
    overshootMm: 0.5,
    revision: "r1",
  });

  assert.deepEqual(fake.calls, [
    { operation: "createCylinder", centerMm: [10, 10, 8.5], radiusMm: 2, heightMm: 9, axis: [0, 0, -1], revision: "r1" },
    { operation: "createCylinder", centerMm: [10, 10, 8.5], radiusMm: 4, heightMm: 3.5, axis: [0, 0, -1], revision: "r2" },
    { operation: "createCylinder", centerMm: [30, 10, 8.5], radiusMm: 2, heightMm: 9, axis: [0, 0, -1], revision: "r3" },
    { operation: "createCylinder", centerMm: [30, 10, 8.5], radiusMm: 4, heightMm: 3.5, axis: [0, 0, -1], revision: "r4" },
    { operation: "boolean", targetIds: [7], toolIds: [8, 9, 10, 11], kind: "difference", keepTools: false, revision: "r5" },
  ]);
  assert.equal(result.recipe, "counterbore-pattern");
  assert.equal(result.holeCount, 2);
  assert.equal(result.undoSteps, 5);
  assert.deepEqual(result.consumedToolIds, [8, 9, 10, 11]);
});

test("counterbore pattern validates centers and reports confirmed partial work", async () => {
  const invalid = counterboreOperations();
  await assert.rejects(new PlasticityRecipes(invalid.operations).createCounterborePattern({
    targetId: 7, entryCentersMm: [[10, 10, 8], [10, 10, 8]], axis: [0, 0, -1],
    throughDiameterMm: 4, counterboreDiameterMm: 8, counterboreDepthMm: 3,
    throughDepthMm: 8, overshootMm: 0.5, revision: "r1",
  }), /centers must be distinct/i);
  assert.deepEqual(invalid.calls, []);

  const failed = counterboreOperations(4);
  await assert.rejects(new PlasticityRecipes(failed.operations).createCounterborePattern({
    targetId: 7, entryCentersMm: [[10, 10, 8], [30, 10, 8]], axis: [0, 0, -1],
    throughDiameterMm: 4, counterboreDiameterMm: 8, counterboreDepthMm: 3,
    throughDepthMm: 8, overshootMm: 0.5, revision: "r1",
  }), (error: unknown) => {
    assert(error instanceof CounterborePatternRecipeError);
    assert.equal(error.completedSteps.length, 3);
    assert.equal(error.lastConfirmedRevision, "r4");
    assert.match(error.message, /3\/5 confirmed steps/i);
    return true;
  });
});

test("through-hole creates one exact overshooting cutter and consumes it", async () => {
  const fake = counterboreOperations();
  const recipes = new PlasticityRecipes(fake.operations);

  const result = await recipes.createThroughHole({
    targetId: 7,
    entryCenterMm: [10, 12, 8],
    axis: [0, 0, -2],
    holeDiameterMm: 5.5,
    throughDepthMm: 8,
    overshootMm: 0.5,
    revision: "r1",
  });

  assert.deepEqual(fake.calls, [
    { operation: "createCylinder", centerMm: [10, 12, 8.5], radiusMm: 2.75, heightMm: 9, axis: [0, 0, -1], revision: "r1" },
    { operation: "boolean", targetIds: [7], toolIds: [8], kind: "difference", keepTools: false, revision: "r2" },
  ]);
  assert.equal(result.recipe, "through-hole");
  assert.equal(result.status, "completed");
  assert.equal(result.beforeRevision, "r1");
  assert.equal(result.afterRevision, "r3");
  assert.equal(result.undoSteps, 2);
  assert.deepEqual(result.resultBodyIds, [7]);
  assert.deepEqual(result.consumedToolIds, [8]);
});

test("through-hole validates geometry and reports confirmed partial work", async () => {
  const invalid = counterboreOperations();
  await assert.rejects(new PlasticityRecipes(invalid.operations).createThroughHole({
    targetId: 7, entryCenterMm: [10, 12, 8], axis: [0, 0, 0], holeDiameterMm: 5.5,
    throughDepthMm: 8, overshootMm: 0.5, revision: "r1",
  }), /nonzero|normalize/i);
  assert.deepEqual(invalid.calls, []);

  const failed = counterboreOperations(2);
  await assert.rejects(new PlasticityRecipes(failed.operations).createThroughHole({
    targetId: 7, entryCenterMm: [10, 12, 8], axis: [0, 0, -1], holeDiameterMm: 5.5,
    throughDepthMm: 8, overshootMm: 0.5, revision: "r1",
  }), (error: unknown) => {
    assert(error instanceof ThroughHoleRecipeError);
    assert.equal(error.completedSteps.length, 1);
    assert.equal(error.lastConfirmedRevision, "r2");
    assert.match(error.message, /partial geometry remains/i);
    return true;
  });
});

test("through-hole pattern creates one cutter per explicit center and one final Boolean", async () => {
  const fake = counterboreOperations();
  const result = await new PlasticityRecipes(fake.operations).createThroughHolePattern({
    targetId: 7,
    entryCentersMm: [[10, 10, 8], [30, 10, 8], [10, 30, 8], [30, 30, 8]],
    axis: [0, 0, -1],
    holeDiameterMm: 5.5,
    throughDepthMm: 8,
    overshootMm: 0.5,
    revision: "r1",
  });

  assert.deepEqual(fake.calls, [
    { operation: "createCylinder", centerMm: [10, 10, 8.5], radiusMm: 2.75, heightMm: 9, axis: [0, 0, -1], revision: "r1" },
    { operation: "createCylinder", centerMm: [30, 10, 8.5], radiusMm: 2.75, heightMm: 9, axis: [0, 0, -1], revision: "r2" },
    { operation: "createCylinder", centerMm: [10, 30, 8.5], radiusMm: 2.75, heightMm: 9, axis: [0, 0, -1], revision: "r3" },
    { operation: "createCylinder", centerMm: [30, 30, 8.5], radiusMm: 2.75, heightMm: 9, axis: [0, 0, -1], revision: "r4" },
    { operation: "boolean", targetIds: [7], toolIds: [8, 9, 10, 11], kind: "difference", keepTools: false, revision: "r5" },
  ]);
  assert.equal(result.recipe, "through-hole-pattern");
  assert.equal(result.holeCount, 4);
  assert.equal(result.undoSteps, 5);
  assert.deepEqual(result.consumedToolIds, [8, 9, 10, 11]);
  assert.deepEqual(result.steps.map((step) => step.operation), [
    "create-through-cutter", "create-through-cutter", "create-through-cutter", "create-through-cutter", "boolean-difference",
  ]);
});

test("through-hole pattern rejects duplicate centers and reports confirmed partial work", async () => {
  const invalid = counterboreOperations();
  await assert.rejects(new PlasticityRecipes(invalid.operations).createThroughHolePattern({
    targetId: 7, entryCentersMm: [[10, 10, 8], [10, 10, 8]], axis: [0, 0, -1],
    holeDiameterMm: 5.5, throughDepthMm: 8, overshootMm: 0.5, revision: "r1",
  }), /centers must be distinct/i);
  assert.deepEqual(invalid.calls, []);

  const failed = counterboreOperations(3);
  await assert.rejects(new PlasticityRecipes(failed.operations).createThroughHolePattern({
    targetId: 7, entryCentersMm: [[10, 10, 8], [30, 10, 8], [20, 30, 8]], axis: [0, 0, -1],
    holeDiameterMm: 5.5, throughDepthMm: 8, overshootMm: 0.5, revision: "r1",
  }), (error: unknown) => {
    assert(error instanceof ThroughHolePatternRecipeError);
    assert.equal(error.completedSteps.length, 2);
    assert.equal(error.lastConfirmedRevision, "r3");
    assert.match(error.message, /2\/4 confirmed steps/i);
    return true;
  });
});

test("blind hole creates one exact flat-bottom cutter without crossing the material", async () => {
  const fake = counterboreOperations();
  const result = await new PlasticityRecipes(fake.operations).createBlindHole({
    targetId: 7,
    entryCenterMm: [10, 12, 8],
    axis: [0, 0, -2],
    holeDiameterMm: 4.2,
    holeDepthMm: 5,
    materialDepthMm: 8,
    overshootMm: 0.5,
    revision: "r1",
  });

  assert.deepEqual(fake.calls, [
    { operation: "createCylinder", centerMm: [10, 12, 8.5], radiusMm: 2.1, heightMm: 5.5, axis: [0, 0, -1], revision: "r1" },
    { operation: "boolean", targetIds: [7], toolIds: [8], kind: "difference", keepTools: false, revision: "r2" },
  ]);
  assert.equal(result.recipe, "blind-hole");
  assert.equal(result.status, "completed");
  assert.equal(result.beforeRevision, "r1");
  assert.equal(result.afterRevision, "r3");
  assert.equal(result.undoSteps, 2);
  assert.deepEqual(result.consumedToolIds, [8]);
  assert.deepEqual(result.steps.map((step) => step.operation), ["create-blind-cutter", "boolean-difference"]);
});

test("blind-hole pattern creates one flat-bottom cutter per center and one final Boolean", async () => {
  const fake = counterboreOperations();
  const result = await new PlasticityRecipes(fake.operations).createBlindHolePattern({
    targetId: 7,
    entryCentersMm: [[10, 10, 8], [30, 10, 8], [20, 30, 8]],
    axis: [0, 0, -1],
    holeDiameterMm: 4.2,
    holeDepthMm: 5,
    materialDepthMm: 8,
    overshootMm: 0.5,
    revision: "r1",
  });

  assert.deepEqual(fake.calls, [
    { operation: "createCylinder", centerMm: [10, 10, 8.5], radiusMm: 2.1, heightMm: 5.5, axis: [0, 0, -1], revision: "r1" },
    { operation: "createCylinder", centerMm: [30, 10, 8.5], radiusMm: 2.1, heightMm: 5.5, axis: [0, 0, -1], revision: "r2" },
    { operation: "createCylinder", centerMm: [20, 30, 8.5], radiusMm: 2.1, heightMm: 5.5, axis: [0, 0, -1], revision: "r3" },
    { operation: "boolean", targetIds: [7], toolIds: [8, 9, 10], kind: "difference", keepTools: false, revision: "r4" },
  ]);
  assert.equal(result.recipe, "blind-hole-pattern");
  assert.equal(result.holeCount, 3);
  assert.equal(result.undoSteps, 4);
  assert.deepEqual(result.consumedToolIds, [8, 9, 10]);
  assert.deepEqual(result.steps.map((step) => step.operation), [
    "create-blind-cutter", "create-blind-cutter", "create-blind-cutter", "boolean-difference",
  ]);
});

test("blind-hole pattern rejects invalid centers and reports confirmed partial work", async () => {
  const invalid = counterboreOperations();
  await assert.rejects(new PlasticityRecipes(invalid.operations).createBlindHolePattern({
    targetId: 7, entryCentersMm: [[10, 10, 8], [10, 10, 8]], axis: [0, 0, -1],
    holeDiameterMm: 4.2, holeDepthMm: 5, materialDepthMm: 8, overshootMm: 0.5, revision: "r1",
  }), /centers must be distinct/i);
  await assert.rejects(new PlasticityRecipes(invalid.operations).createBlindHolePattern({
    targetId: 7, entryCentersMm: [[10, 10, 8], [30, 10, 8]], axis: [0, 0, -1],
    holeDiameterMm: 4.2, holeDepthMm: 8, materialDepthMm: 8, overshootMm: 0.5, revision: "r1",
  }), /depth must be less than material depth/i);
  assert.deepEqual(invalid.calls, []);

  const failed = counterboreOperations(3);
  await assert.rejects(new PlasticityRecipes(failed.operations).createBlindHolePattern({
    targetId: 7, entryCentersMm: [[10, 10, 8], [30, 10, 8], [20, 30, 8]], axis: [0, 0, -1],
    holeDiameterMm: 4.2, holeDepthMm: 5, materialDepthMm: 8, overshootMm: 0.5, revision: "r1",
  }), (error: unknown) => {
    assert(error instanceof BlindHolePatternRecipeError);
    assert.equal(error.completedSteps.length, 2);
    assert.equal(error.lastConfirmedRevision, "r3");
    assert.match(error.message, /2\/4 confirmed steps/i);
    return true;
  });
});

test("blind hole rejects breakthrough and reports confirmed partial work", async () => {
  const invalid = counterboreOperations();
  await assert.rejects(new PlasticityRecipes(invalid.operations).createBlindHole({
    targetId: 7, entryCenterMm: [10, 12, 8], axis: [0, 0, -1], holeDiameterMm: 4.2,
    holeDepthMm: 8, materialDepthMm: 8, overshootMm: 0.5, revision: "r1",
  }), /less than material depth/i);
  assert.deepEqual(invalid.calls, []);

  const failed = counterboreOperations(2);
  await assert.rejects(new PlasticityRecipes(failed.operations).createBlindHole({
    targetId: 7, entryCenterMm: [10, 12, 8], axis: [0, 0, -1], holeDiameterMm: 4.2,
    holeDepthMm: 5, materialDepthMm: 8, overshootMm: 0.5, revision: "r1",
  }), (error: unknown) => {
    assert(error instanceof BlindHoleRecipeError);
    assert.equal(error.completedSteps.length, 1);
    assert.equal(error.lastConfirmedRevision, "r2");
    assert.match(error.message, /partial geometry remains/i);
    return true;
  });
});

test("counterbore rejects invalid geometry before the first mutation", async () => {
  const fake = counterboreOperations();
  const recipes = new PlasticityRecipes(fake.operations);

  await assert.rejects(recipes.createCounterbore({
    targetId: 7,
    entryCenterMm: [10, 12, 8],
    axis: [0, 0, -1],
    throughDiameterMm: 8,
    counterboreDiameterMm: 8,
    counterboreDepthMm: 3,
    throughDepthMm: 8,
    overshootMm: 0.5,
    revision: "r1",
  }), /counterbore diameter/i);
  assert.deepEqual(fake.calls, []);
});

test("counterbore stops after a failed step and reports confirmed partial work", async () => {
  const fake = counterboreOperations(2);
  const recipes = new PlasticityRecipes(fake.operations);

  await assert.rejects(recipes.createCounterbore({
    targetId: 7,
    entryCenterMm: [10, 12, 8],
    axis: [0, 0, -1],
    throughDiameterMm: 4,
    counterboreDiameterMm: 8,
    counterboreDepthMm: 3,
    throughDepthMm: 8,
    overshootMm: 0.5,
    revision: "r1",
  }), (error: unknown) => {
    assert(error instanceof CounterboreRecipeError);
    assert.equal(error.completedSteps.length, 1);
    assert.equal(error.lastConfirmedRevision, "r2");
    assert.match(error.message, /partial geometry remains/i);
    return true;
  });
  assert.equal(fake.calls.length, 2);
});

test("heat-set insert pocket creates three concentric cutters and one boolean", async () => {
  const fake = counterboreOperations();
  const recipes = new PlasticityRecipes(fake.operations);

  const result = await recipes.createHeatSetInsertPocket({
    targetId: 7,
    entryCenterMm: [10, 12, 12],
    axis: [0, 0, -1],
    pilotDiameterMm: 3,
    pilotDepthMm: 8,
    insertDiameterMm: 4.6,
    insertDepthMm: 6,
    leadInDiameterMm: 5.4,
    leadInDepthMm: 1,
    materialDepthMm: 12,
    overshootMm: 0.5,
    revision: "r1",
  });

  assert.deepEqual(fake.calls, [
    { operation: "createCylinder", centerMm: [10, 12, 12.5], radiusMm: 1.5, heightMm: 8.5, axis: [0, 0, -1], revision: "r1" },
    { operation: "createCylinder", centerMm: [10, 12, 12.5], radiusMm: 2.3, heightMm: 6.5, axis: [0, 0, -1], revision: "r2" },
    { operation: "createCylinder", centerMm: [10, 12, 12.5], radiusMm: 2.7, heightMm: 1.5, axis: [0, 0, -1], revision: "r3" },
    { operation: "boolean", targetIds: [7], toolIds: [8, 9, 10], kind: "difference", keepTools: false, revision: "r4" },
  ]);
  assert.equal(result.recipe, "heat-set-insert-pocket");
  assert.equal(result.undoSteps, 4);
  assert.equal(result.afterRevision, "r5");
  assert.deepEqual(result.resultBodyIds, [7]);
  assert.deepEqual(result.consumedToolIds, [8, 9, 10]);
  assert.deepEqual(result.steps.map((step) => step.operation), [
    "create-pilot-cutter",
    "create-insert-cutter",
    "create-lead-in-cutter",
    "boolean-difference",
  ]);
});

test("heat-set insert pocket rejects unordered diameters and depths before mutation", async () => {
  const fake = counterboreOperations();
  const recipes = new PlasticityRecipes(fake.operations);

  await assert.rejects(recipes.createHeatSetInsertPocket({
    targetId: 7,
    entryCenterMm: [10, 12, 12],
    axis: [0, 0, -1],
    pilotDiameterMm: 4.6,
    pilotDepthMm: 6,
    insertDiameterMm: 4.6,
    insertDepthMm: 6,
    leadInDiameterMm: 5.4,
    leadInDepthMm: 1,
    materialDepthMm: 12,
    overshootMm: 0.5,
    revision: "r1",
  }), /pilot diameter/i);
  await assert.rejects(recipes.createHeatSetInsertPocket({
    targetId: 7, entryCenterMm: [10, 12, 12], axis: [0, 0, -1],
    pilotDiameterMm: 3, pilotDepthMm: 12, insertDiameterMm: 4.6, insertDepthMm: 6,
    leadInDiameterMm: 5.4, leadInDepthMm: 1, materialDepthMm: 12, overshootMm: 0.5, revision: "r1",
  }), /pilot depth must be less than material depth/i);
  assert.deepEqual(fake.calls, []);
});

test("heat-set insert pocket pattern creates three cutters per center and one final Boolean", async () => {
  const fake = counterboreOperations();
  const result = await new PlasticityRecipes(fake.operations).createHeatSetInsertPocketPattern({
    targetId: 7,
    entryCentersMm: [[10, 10, 12], [30, 10, 12]],
    axis: [0, 0, -1],
    pilotDiameterMm: 3,
    pilotDepthMm: 8,
    insertDiameterMm: 4.6,
    insertDepthMm: 6,
    leadInDiameterMm: 5.4,
    leadInDepthMm: 1,
    materialDepthMm: 12,
    overshootMm: 0.5,
    revision: "r1",
  });

  assert.deepEqual(fake.calls, [
    { operation: "createCylinder", centerMm: [10, 10, 12.5], radiusMm: 1.5, heightMm: 8.5, axis: [0, 0, -1], revision: "r1" },
    { operation: "createCylinder", centerMm: [10, 10, 12.5], radiusMm: 2.3, heightMm: 6.5, axis: [0, 0, -1], revision: "r2" },
    { operation: "createCylinder", centerMm: [10, 10, 12.5], radiusMm: 2.7, heightMm: 1.5, axis: [0, 0, -1], revision: "r3" },
    { operation: "createCylinder", centerMm: [30, 10, 12.5], radiusMm: 1.5, heightMm: 8.5, axis: [0, 0, -1], revision: "r4" },
    { operation: "createCylinder", centerMm: [30, 10, 12.5], radiusMm: 2.3, heightMm: 6.5, axis: [0, 0, -1], revision: "r5" },
    { operation: "createCylinder", centerMm: [30, 10, 12.5], radiusMm: 2.7, heightMm: 1.5, axis: [0, 0, -1], revision: "r6" },
    { operation: "boolean", targetIds: [7], toolIds: [8, 9, 10, 11, 12, 13], kind: "difference", keepTools: false, revision: "r7" },
  ]);
  assert.equal(result.recipe, "heat-set-insert-pocket-pattern");
  assert.equal(result.pocketCount, 2);
  assert.equal(result.undoSteps, 7);
  assert.deepEqual(result.consumedToolIds, [8, 9, 10, 11, 12, 13]);
});

test("heat-set insert pocket pattern validates all centers and reports partial work", async () => {
  const invalid = counterboreOperations();
  await assert.rejects(new PlasticityRecipes(invalid.operations).createHeatSetInsertPocketPattern({
    targetId: 7, entryCentersMm: [[10, 10, 12], [10, 10, 12]], axis: [0, 0, -1],
    pilotDiameterMm: 3, pilotDepthMm: 8, insertDiameterMm: 4.6, insertDepthMm: 6,
    leadInDiameterMm: 5.4, leadInDepthMm: 1, materialDepthMm: 12, overshootMm: 0.5, revision: "r1",
  }), /centers must be distinct/i);
  assert.deepEqual(invalid.calls, []);

  const failed = counterboreOperations(4);
  await assert.rejects(new PlasticityRecipes(failed.operations).createHeatSetInsertPocketPattern({
    targetId: 7, entryCentersMm: [[10, 10, 12], [30, 10, 12]], axis: [0, 0, -1],
    pilotDiameterMm: 3, pilotDepthMm: 8, insertDiameterMm: 4.6, insertDepthMm: 6,
    leadInDiameterMm: 5.4, leadInDepthMm: 1, materialDepthMm: 12, overshootMm: 0.5, revision: "r1",
  }), (error: unknown) => {
    assert(error instanceof HeatSetInsertPocketPatternRecipeError);
    assert.equal(error.completedSteps.length, 3);
    assert.equal(error.lastConfirmedRevision, "r4");
    assert.match(error.message, /3\/7 confirmed steps/i);
    return true;
  });
});

test("screw boss overlaps and unions the support before cutting its pilot hole", async () => {
  const fake = counterboreOperations();
  const recipes = new PlasticityRecipes(fake.operations);

  const result = await recipes.createScrewBoss({
    targetId: 7,
    baseCenterMm: [10, 12, 4],
    axis: [0, 0, 2],
    outerDiameterMm: 10,
    heightMm: 10,
    holeDiameterMm: 3,
    holeDepthMm: 8,
    baseOverlapMm: 0.5,
    cutterOvershootMm: 0.5,
    revision: "r1",
  });

  assert.deepEqual(fake.calls, [
    { operation: "createCylinder", centerMm: [10, 12, 3.5], radiusMm: 5, heightMm: 10.5, axis: [0, 0, 1], revision: "r1" },
    { operation: "boolean", targetIds: [7], toolIds: [8], kind: "union", keepTools: false, revision: "r2" },
    { operation: "createCylinder", centerMm: [10, 12, 14.5], radiusMm: 1.5, heightMm: 8.5, axis: [0, 0, -1], revision: "r3" },
    { operation: "boolean", targetIds: [7], toolIds: [9], kind: "difference", keepTools: false, revision: "r4" },
  ]);
  assert.equal(result.recipe, "screw-boss");
  assert.equal(result.undoSteps, 4);
  assert.equal(result.afterRevision, "r5");
  assert.deepEqual(result.resultBodyIds, [7]);
  assert.deepEqual(result.consumedToolIds, [8, 9]);
  assert.deepEqual(result.steps.map((step) => step.operation), [
    "create-boss-body",
    "union-boss-to-target",
    "create-boss-hole-cutter",
    "boolean-difference",
  ]);
});

test("screw boss rejects a hole deeper than the boss before mutation", async () => {
  const fake = counterboreOperations();
  const recipes = new PlasticityRecipes(fake.operations);

  await assert.rejects(recipes.createScrewBoss({
    targetId: 7,
    baseCenterMm: [10, 12, 4],
    axis: [0, 0, 1],
    outerDiameterMm: 10,
    heightMm: 10,
    holeDiameterMm: 3,
    holeDepthMm: 11,
    baseOverlapMm: 0.5,
    cutterOvershootMm: 0.5,
    revision: "r1",
  }), /hole depth/i);
  assert.deepEqual(fake.calls, []);
});

test("screw boss pattern joins every boss before cutting every pilot", async () => {
  const fake = counterboreOperations();
  const result = await new PlasticityRecipes(fake.operations).createScrewBossPattern({
    targetId: 7,
    baseCentersMm: [[10, 12, 4], [30, 12, 4]],
    axis: [0, 0, 2],
    outerDiameterMm: 10,
    heightMm: 10,
    holeDiameterMm: 3,
    holeDepthMm: 8,
    baseOverlapMm: 0.5,
    cutterOvershootMm: 0.5,
    revision: "r1",
  });

  assert.deepEqual(fake.calls, [
    { operation: "createCylinder", centerMm: [10, 12, 3.5], radiusMm: 5, heightMm: 10.5, axis: [0, 0, 1], revision: "r1" },
    { operation: "createCylinder", centerMm: [30, 12, 3.5], radiusMm: 5, heightMm: 10.5, axis: [0, 0, 1], revision: "r2" },
    { operation: "boolean", targetIds: [7], toolIds: [8, 9], kind: "union", keepTools: false, revision: "r3" },
    { operation: "createCylinder", centerMm: [10, 12, 14.5], radiusMm: 1.5, heightMm: 8.5, axis: [0, 0, -1], revision: "r4" },
    { operation: "createCylinder", centerMm: [30, 12, 14.5], radiusMm: 1.5, heightMm: 8.5, axis: [0, 0, -1], revision: "r5" },
    { operation: "boolean", targetIds: [7], toolIds: [10, 11], kind: "difference", keepTools: false, revision: "r6" },
  ]);
  assert.equal(result.recipe, "screw-boss-pattern");
  assert.equal(result.bossCount, 2);
  assert.equal(result.undoSteps, 6);
  assert.equal(result.afterRevision, "r7");
  assert.deepEqual(result.resultBodyIds, [7]);
  assert.deepEqual(result.consumedToolIds, [8, 9, 10, 11]);
  assert.deepEqual(result.steps.map((item) => item.operation), [
    "create-boss-body", "create-boss-body", "union-boss-to-target",
    "create-boss-hole-cutter", "create-boss-hole-cutter", "boolean-difference",
  ]);
});

test("screw boss pattern validates centers and reports confirmed partial work", async () => {
  const invalid = counterboreOperations();
  await assert.rejects(new PlasticityRecipes(invalid.operations).createScrewBossPattern({
    targetId: 7, baseCentersMm: [[10, 12, 4], [10, 12, 4]], axis: [0, 0, 1],
    outerDiameterMm: 10, heightMm: 10, holeDiameterMm: 3, holeDepthMm: 8,
    baseOverlapMm: 0.5, cutterOvershootMm: 0.5, revision: "r1",
  }), /centers must be distinct/i);
  assert.deepEqual(invalid.calls, []);

  const failed = counterboreOperations(4);
  await assert.rejects(new PlasticityRecipes(failed.operations).createScrewBossPattern({
    targetId: 7, baseCentersMm: [[10, 12, 4], [30, 12, 4]], axis: [0, 0, 1],
    outerDiameterMm: 10, heightMm: 10, holeDiameterMm: 3, holeDepthMm: 8,
    baseOverlapMm: 0.5, cutterOvershootMm: 0.5, revision: "r1",
  }), (error: unknown) => {
    assert(error instanceof ScrewBossPatternRecipeError);
    assert.equal(error.completedSteps.length, 3);
    assert.equal(error.lastConfirmedRevision, "r4");
    assert.match(error.message, /3\/6 confirmed steps/i);
    return true;
  });
});

test("rib creates a closed profile, extrudes its region, and joins the Solid to its support", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const target = body(7, "Solid");
  let state = scene("r1", [target]);
  const operations: RecipeOperations = {
    async state() { return state; },
    async createPolyline(pointsMm, closed, revision) {
      calls.push({ operation: "createPolyline", pointsMm, closed, revision });
      state = { ...scene("r2", [target, body(8, "Wire")]), regions: [{
        id: "region-8", entityId: 80, islandVersionId: 81, sketchId: 82, sketchWireIds: [8],
        measurementSource: "render-mesh", displayBoundsMm: { min: [10, 18, 3.5], max: [30, 18, 14] },
      }] };
      return state;
    },
    async extrudeRegions(regionIds, distanceMm, revision) {
      calls.push({ operation: "extrudeRegions", regionIds, distanceMm, revision });
      state = { ...state, revision: "r3", bodies: [...state.bodies, body(9, "Solid")] };
      return state;
    },
    async boolean(targetIds, toolIds, kind, keepTools, revision) {
      calls.push({ operation: "boolean", targetIds, toolIds, kind, keepTools, revision });
      state = { ...state, revision: "r4", bodies: state.bodies.filter((candidate) => !toolIds.includes(candidate.id)) };
      return state;
    },
    async createCylinder() { throw new Error("unexpected cylinder"); },
    async rectangularPattern() { throw new Error("unexpected pattern"); },
    async createPipes() { throw new Error("unexpected pipe"); },
    async fillet() { throw new Error("unexpected fillet"); },
    async createBox() { throw new Error("unexpected box"); },
  };
  const recipes = new PlasticityRecipes(operations);
  const points: Array<[number, number, number]> = [[10, 18, 3.5], [30, 18, 3.5], [10, 18, 14]];

  const result = await recipes.createRib({ targetId: 7, profilePointsMm: points, thicknessMm: 4, revision: "r1" });

  assert.deepEqual(calls, [
    { operation: "createPolyline", pointsMm: points, closed: true, revision: "r1" },
    { operation: "extrudeRegions", regionIds: ["region-8"], distanceMm: 4, revision: "r2" },
    { operation: "boolean", targetIds: [7], toolIds: [9], kind: "union", keepTools: false, revision: "r3" },
  ]);
  assert.equal(result.recipe, "rib");
  assert.equal(result.profileBodyId, 8);
  assert.deepEqual(result.resultBodyIds, [7]);
  assert.deepEqual(result.consumedToolIds, [9]);
  assert.equal(result.undoSteps, 3);
});

test("rib rejects non-coplanar profile points before mutation", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const operations = {
    async state() { calls.push({ operation: "state" }); return scene("r1", [body(7, "Solid")]); },
    async createPolyline() { calls.push({ operation: "createPolyline" }); return scene("r2", []); },
    async extrudeRegions() { throw new Error("unexpected extrude"); },
    async boolean() { throw new Error("unexpected boolean"); },
    async createCylinder() { throw new Error("unexpected cylinder"); },
    async rectangularPattern() { throw new Error("unexpected pattern"); },
    async createPipes() { throw new Error("unexpected pipe"); },
    async fillet() { throw new Error("unexpected fillet"); },
    async createBox() { throw new Error("unexpected box"); },
  } as RecipeOperations;
  const recipes = new PlasticityRecipes(operations);

  await assert.rejects(recipes.createRib({
    targetId: 7,
    profilePointsMm: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [5, 5, 1]],
    thicknessMm: 2,
    revision: "r1",
  }), /coplanar/i);
  assert.deepEqual(calls, []);
});

test("round vent array patterns one cutter before a single boolean", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const target = body(7, "Solid");
  let state = scene("r1", [target]);
  const operations: RecipeOperations = {
    async state() { return state; },
    async createCylinder(centerMm, radiusMm, heightMm, _name, revision, axis) {
      calls.push({ operation: "createCylinder", centerMm, radiusMm, heightMm, axis, revision });
      state = scene("r2", [target, body(8, "Solid")]);
      return state;
    },
    async rectangularPattern(ids, direction1, count1, spacing1Mm, direction2, count2, spacing2Mm, revision) {
      calls.push({ operation: "rectangularPattern", ids, direction1, count1, spacing1Mm, direction2, count2, spacing2Mm, revision });
      state = scene("r3", [target, ...[8, 9, 10, 11, 12, 13].map((id) => body(id, "Solid"))]);
      return state;
    },
    async boolean(targetIds, toolIds, kind, keepTools, revision) {
      calls.push({ operation: "boolean", targetIds, toolIds, kind, keepTools, revision });
      state = scene("r4", [target]);
      return state;
    },
    async createPolyline() { throw new Error("unexpected polyline"); },
    async extrudeRegions() { throw new Error("unexpected extrusion"); },
    async createPipes() { throw new Error("unexpected pipe"); },
    async fillet() { throw new Error("unexpected fillet"); },
    async createBox() { throw new Error("unexpected box"); },
  };
  const recipes = new PlasticityRecipes(operations);

  const result = await recipes.createRoundVentArray({
    targetId: 7,
    firstCenterMm: [10, 10, 4],
    axis: [0, 0, -1],
    holeDiameterMm: 3,
    throughDepthMm: 4,
    direction1: [1, 0, 0],
    count1: 3,
    spacing1Mm: 6,
    direction2: [0, 1, 0],
    count2: 2,
    spacing2Mm: 7,
    overshootMm: 0.5,
    revision: "r1",
  });

  assert.deepEqual(calls, [
    { operation: "createCylinder", centerMm: [10, 10, 4.5], radiusMm: 1.5, heightMm: 5, axis: [0, 0, -1], revision: "r1" },
    { operation: "rectangularPattern", ids: [8], direction1: [1, 0, 0], count1: 3, spacing1Mm: 6, direction2: [0, 1, 0], count2: 2, spacing2Mm: 7, revision: "r2" },
    { operation: "boolean", targetIds: [7], toolIds: [8, 9, 10, 11, 12, 13], kind: "difference", keepTools: false, revision: "r3" },
  ]);
  assert.equal(result.recipe, "round-vent-array");
  assert.equal(result.holeCount, 6);
  assert.equal(result.undoSteps, 3);
  assert.deepEqual(result.consumedToolIds, [8, 9, 10, 11, 12, 13]);
});

test("round vent array rejects parallel active directions before mutation", async () => {
  const fake = counterboreOperations();
  const recipes = new PlasticityRecipes(fake.operations);
  await assert.rejects(recipes.createRoundVentArray({
    targetId: 7,
    firstCenterMm: [10, 10, 4], axis: [0, 0, -1],
    holeDiameterMm: 3, throughDepthMm: 4,
    direction1: [1, 0, 0], count1: 3, spacing1Mm: 6,
    direction2: [2, 0, 0], count2: 2, spacing2Mm: 7,
    overshootMm: 0.5, revision: "r1",
  }), /parallel/i);
  assert.deepEqual(fake.calls, []);
});

test("cantilever snap fit derives a hook profile and joins it through the rib pipeline", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const target = body(7, "Solid");
  let state = scene("r1", [target]);
  const operations: RecipeOperations = {
    async state() { return state; },
    async createPolyline(pointsMm, closed, revision) {
      calls.push({ operation: "createPolyline", pointsMm, closed, revision });
      state = { ...scene("r2", [target, body(8, "Wire")]), regions: [{
        id: "region-snap", entityId: 80, islandVersionId: 81, sketchId: 82, sketchWireIds: [8],
        measurementSource: "render-mesh", displayBoundsMm: { min: [3.5, 13, 1], max: [24, 13, 7] },
      }] };
      return state;
    },
    async extrudeRegions(regionIds, distanceMm, revision) {
      calls.push({ operation: "extrudeRegions", regionIds, distanceMm, revision });
      state = { ...state, revision: "r3", bodies: [...state.bodies, body(9, "Solid")] };
      return state;
    },
    async boolean(targetIds, toolIds, kind, keepTools, revision) {
      calls.push({ operation: "boolean", targetIds, toolIds, kind, keepTools, revision });
      state = { ...state, revision: "r4", bodies: state.bodies.filter((candidate) => !toolIds.includes(candidate.id)) };
      return state;
    },
    async createCylinder() { throw new Error("unexpected cylinder"); },
    async rectangularPattern() { throw new Error("unexpected pattern"); },
    async createPipes() { throw new Error("unexpected pipe"); },
    async fillet() { throw new Error("unexpected fillet"); },
    async createBox() { throw new Error("unexpected box"); },
  };
  const recipes = new PlasticityRecipes(operations);

  const result = await recipes.createCantileverSnapFit({
    targetId: 7,
    baseCenterMm: [4, 10, 1],
    beamDirection: [1, 0, 0],
    thicknessDirection: [0, 0, 1],
    lengthMm: 20,
    widthMm: 6,
    thicknessMm: 2,
    hookLengthMm: 3,
    hookHeightMm: 4,
    baseOverlapMm: 0.5,
    revision: "r1",
  });

  assert.deepEqual(calls, [
    { operation: "createPolyline", pointsMm: [[3.5, 13, 1], [24, 13, 1], [24, 13, 7], [21, 13, 7], [21, 13, 3], [3.5, 13, 3]], closed: true, revision: "r1" },
    { operation: "extrudeRegions", regionIds: ["region-snap"], distanceMm: 6, revision: "r2" },
    { operation: "boolean", targetIds: [7], toolIds: [9], kind: "union", keepTools: false, revision: "r3" },
  ]);
  assert.equal(result.recipe, "cantilever-snap-fit");
  assert.equal(result.profileBodyId, 8);
  assert.equal(result.undoSteps, 3);
  assert.deepEqual(result.steps.map((step) => step.operation), ["create-snap-profile", "extrude-snap-body", "union-snap-to-target"]);
});

test("cantilever snap fit rejects parallel beam and thickness directions before mutation", async () => {
  const fake = counterboreOperations();
  const recipes = new PlasticityRecipes(fake.operations);
  await assert.rejects(recipes.createCantileverSnapFit({
    targetId: 7, baseCenterMm: [4, 10, 1],
    beamDirection: [1, 0, 0], thicknessDirection: [2, 0, 0],
    lengthMm: 20, widthMm: 6, thicknessMm: 2,
    hookLengthMm: 3, hookHeightMm: 4, baseOverlapMm: 0.5,
    revision: "r1",
  }), /perpendicular/i);
  assert.deepEqual(fake.calls, []);
});

test("hinge barrel hollows one native cylinder and joins it to the support", async () => {
  const fake = counterboreOperations();
  const recipes = new PlasticityRecipes(fake.operations);

  const result = await recipes.createHingeBarrel({
    targetId: 7,
    axisStartMm: [20, 0, 10],
    axis: [0, 2, 0],
    lengthMm: 4,
    outerDiameterMm: 8,
    pinBoreDiameterMm: 3,
    cutterOvershootMm: 0.5,
    revision: "r1",
  });

  assert.deepEqual(fake.calls, [
    { operation: "createCylinder", centerMm: [20, 0, 10], radiusMm: 4, heightMm: 4, axis: [0, 1, 0], revision: "r1" },
    { operation: "createCylinder", centerMm: [20, -0.5, 10], radiusMm: 1.5, heightMm: 5, axis: [0, 1, 0], revision: "r2" },
    { operation: "boolean", targetIds: [8], toolIds: [9], kind: "difference", keepTools: false, revision: "r3" },
    { operation: "boolean", targetIds: [7], toolIds: [8], kind: "union", keepTools: false, revision: "r4" },
  ]);
  assert.equal(result.recipe, "hinge-barrel");
  assert.equal(result.undoSteps, 4);
  assert.deepEqual(result.resultBodyIds, [7]);
  assert.deepEqual(result.consumedToolIds, [9, 8]);
  assert.deepEqual(result.steps.map((step) => step.operation), [
    "create-hinge-barrel",
    "create-hinge-bore-cutter",
    "hollow-hinge-barrel",
    "union-hinge-to-target",
  ]);
});

test("hinge barrel rejects an oversized pin bore before mutation", async () => {
  const fake = counterboreOperations();
  const recipes = new PlasticityRecipes(fake.operations);
  await assert.rejects(recipes.createHingeBarrel({
    targetId: 7, axisStartMm: [20, 0, 10], axis: [0, 1, 0],
    lengthMm: 4, outerDiameterMm: 8, pinBoreDiameterMm: 8,
    cutterOvershootMm: 0.5, revision: "r1",
  }), /pin bore diameter/i);
  assert.deepEqual(fake.calls, []);
});

test("cable channel creates solid pipe cutters and subtracts them from the target", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const target = body(7, "Solid");
  const spine = body(8, "Wire");
  let state = scene("r1", [target, spine]);
  const operations: RecipeOperations = {
    async state() { return state; },
    async createPipes(spineIds, diameterMm, wallThicknessMm, revision) {
      calls.push({ operation: "createPipes", spineIds, diameterMm, wallThicknessMm, revision });
      state = scene("r2", [target, spine, body(9, "Solid")]);
      return state;
    },
    async boolean(targetIds, toolIds, kind, keepTools, revision) {
      calls.push({ operation: "boolean", targetIds, toolIds, kind, keepTools, revision });
      state = scene("r3", [target, spine]);
      return state;
    },
    async createCylinder() { throw new Error("unexpected cylinder"); },
    async createPolyline() { throw new Error("unexpected polyline"); },
    async extrudeRegions() { throw new Error("unexpected extrusion"); },
    async rectangularPattern() { throw new Error("unexpected pattern"); },
    async fillet() { throw new Error("unexpected fillet"); },
    async createBox() { throw new Error("unexpected box"); },
  };
  const recipes = new PlasticityRecipes(operations);

  const result = await recipes.cutCableChannel({ targetId: 7, spineIds: [8], channelDiameterMm: 6, revision: "r1" });

  assert.deepEqual(calls, [
    { operation: "createPipes", spineIds: [8], diameterMm: 6, wallThicknessMm: 0, revision: "r1" },
    { operation: "boolean", targetIds: [7], toolIds: [9], kind: "difference", keepTools: false, revision: "r2" },
  ]);
  assert.equal(result.recipe, "cable-channel");
  assert.equal(result.undoSteps, 2);
  assert.deepEqual(result.spineIds, [8]);
  assert.deepEqual(result.consumedToolIds, [9]);
  assert.deepEqual(result.steps.map((step) => step.operation), ["create-cable-channel-cutters", "boolean-difference"]);
});

test("cable channel rejects a target reused as its path before mutation", async () => {
  const fake = counterboreOperations();
  const recipes = new PlasticityRecipes(fake.operations);
  await assert.rejects(
    recipes.cutCableChannel({ targetId: 7, spineIds: [7], channelDiameterMm: 6, revision: "r1" }),
    /must not also be a spine/i,
  );
  assert.deepEqual(fake.calls, []);
});

test("connector opening extrudes a rounded rectangular cutter and subtracts it", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const target = body(7, "Solid");
  let state = scene("r1", [target]);
  const longitudinalEdges = ["e1", "e2", "e3", "e4"].map((id) => ({
    id, curveType: "Line", line: true, circle: false, lengthMm: 11,
    centerMm: [0, 0, 0] as [number, number, number], tangent: [0, 0, -1] as [number, number, number],
    boundsMm: { min: [0, 0, -0.5] as [number, number, number], max: [0, 0, 10.5] as [number, number, number] },
    faceIds: [], vertexIds: [],
  }));
  const operations: RecipeOperations = {
    async state() { return state; },
    async createPolyline(pointsMm, closed, revision) {
      calls.push({ operation: "createPolyline", pointsMm, closed, revision });
      state = { ...scene("r2", [target, body(8, "Wire")]), regions: [{
        id: "region-8", entityId: 80, islandVersionId: 81, sketchId: 82, sketchWireIds: [8],
        measurementSource: "render-mesh", displayBoundsMm: { min: [4, 6, 10.5], max: [16, 14, 10.5] },
      }] };
      return state;
    },
    async extrudeRegions(regionIds, distanceMm, revision) {
      calls.push({ operation: "extrudeRegions", regionIds, distanceMm, revision });
      state = { ...state, revision: "r3", bodies: [...state.bodies, { ...body(9, "Solid"), edgeIds: longitudinalEdges.map((edge) => edge.id), edges: longitudinalEdges }] };
      return state;
    },
    async fillet(id, edgeIds, radiusMm, revision) {
      calls.push({ operation: "fillet", id, edgeIds, radiusMm, revision });
      state = { ...state, revision: "r4" };
      return state;
    },
    async boolean(targetIds, toolIds, kind, keepTools, revision) {
      calls.push({ operation: "boolean", targetIds, toolIds, kind, keepTools, revision });
      state = { ...state, revision: "r5", bodies: state.bodies.filter((candidate) => !toolIds.includes(candidate.id)) };
      return state;
    },
    async createCylinder() { throw new Error("unexpected cylinder"); },
    async rectangularPattern() { throw new Error("unexpected pattern"); },
    async createPipes() { throw new Error("unexpected pipe"); },
    async createBox() { throw new Error("unexpected box"); },
  };
  const recipes = new PlasticityRecipes(operations);

  const result = await recipes.createConnectorOpening({
    targetId: 7, entryCenterMm: [10, 10, 10], axis: [0, 0, -1], widthDirection: [1, 0, 0],
    widthMm: 12, heightMm: 8, cornerRadiusMm: 2, throughDepthMm: 10, overshootMm: 0.5, revision: "r1",
  });

  assert.deepEqual(calls, [
    { operation: "createPolyline", pointsMm: [[4, 14, 10.5], [16, 14, 10.5], [16, 6, 10.5], [4, 6, 10.5]], closed: true, revision: "r1" },
    { operation: "extrudeRegions", regionIds: ["region-8"], distanceMm: 11, revision: "r2" },
    { operation: "fillet", id: 9, edgeIds: ["e1", "e2", "e3", "e4"], radiusMm: 2, revision: "r3" },
    { operation: "boolean", targetIds: [7], toolIds: [9], kind: "difference", keepTools: false, revision: "r4" },
  ]);
  assert.equal(result.recipe, "connector-opening");
  assert.equal(result.profileBodyId, 8);
  assert.deepEqual(result.resultBodyIds, [7]);
  assert.deepEqual(result.consumedToolIds, [9]);
  assert.equal(result.undoSteps, 4);
  assert.deepEqual(result.steps.map((entry) => entry.operation), ["create-connector-profile", "extrude-connector-cutter", "round-connector-cutter", "boolean-difference"]);
});

test("connector opening rejects a width direction parallel to its cutting axis before mutation", async () => {
  const fake = counterboreOperations();
  const recipes = new PlasticityRecipes(fake.operations);
  await assert.rejects(recipes.createConnectorOpening({
    targetId: 7, entryCenterMm: [10, 10, 10], axis: [0, 0, -1], widthDirection: [0, 0, 1],
    widthMm: 12, heightMm: 8, cornerRadiusMm: 2, throughDepthMm: 10, overshootMm: 0.5, revision: "r1",
  }), /perpendicular/i);
  assert.deepEqual(fake.calls, []);
});

test("connector opening skips the fillet step when corner radius is zero", async () => {
  const target = body(7, "Solid");
  let state = scene("r1", [target]);
  const operations: RecipeOperations = {
    async state() { return state; },
    async createPolyline() {
      state = { ...scene("r2", [target, body(8, "Wire")]), regions: [{
        id: "region-8", entityId: 80, islandVersionId: 81, sketchId: 82, sketchWireIds: [8],
        measurementSource: "render-mesh", displayBoundsMm: { min: [4, 6, 10.5], max: [16, 14, 10.5] },
      }] };
      return state;
    },
    async extrudeRegions() {
      state = { ...state, revision: "r3", bodies: [...state.bodies, body(9, "Solid")] };
      return state;
    },
    async boolean(_targetIds, toolIds) {
      state = { ...state, revision: "r4", bodies: state.bodies.filter((candidate) => !toolIds.includes(candidate.id)) };
      return state;
    },
    async fillet() { throw new Error("unexpected fillet"); },
    async createBox() { throw new Error("unexpected box"); },
    async createCylinder() { throw new Error("unexpected cylinder"); },
    async rectangularPattern() { throw new Error("unexpected pattern"); },
    async createPipes() { throw new Error("unexpected pipe"); },
  };

  const result = await new PlasticityRecipes(operations).createConnectorOpening({
    targetId: 7, entryCenterMm: [10, 10, 10], axis: [0, 0, -1], widthDirection: [1, 0, 0],
    widthMm: 12, heightMm: 8, cornerRadiusMm: 0, throughDepthMm: 10, overshootMm: 0.5, revision: "r1",
  });

  assert.equal(result.undoSteps, 3);
  assert.deepEqual(result.steps.map((entry) => entry.operation), ["create-connector-profile", "extrude-connector-cutter", "boolean-difference"]);
});

test("mating enclosure joint creates a male lip and clearance groove on two existing halves", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const male = body(7, "Solid");
  const female = body(8, "Solid");
  let state = scene("r1", [male, female]);
  let nextBodyId = 9;
  const operations = {
    async state() { return state; },
    async createBox(originMm: [number, number, number], sizeMm: [number, number, number], _name: string | undefined, revision: string) {
      calls.push({ operation: "createBox", originMm, sizeMm, revision });
      const created = body(nextBodyId++, "Solid");
      state = { ...state, revision: `r${Number(state.revision.slice(1)) + 1}`, bodies: [...state.bodies, created] };
      return state;
    },
    async boolean(targetIds: number[], toolIds: number[], kind: string, keepTools: boolean, revision: string) {
      calls.push({ operation: "boolean", targetIds, toolIds, kind, keepTools, revision });
      state = { ...state, revision: `r${Number(state.revision.slice(1)) + 1}`, bodies: state.bodies.filter((candidate) => !toolIds.includes(candidate.id)) };
      return state;
    },
    async createCylinder() { throw new Error("unexpected cylinder"); },
    async createPolyline() { throw new Error("unexpected polyline"); },
    async extrudeRegions() { throw new Error("unexpected extrusion"); },
    async rectangularPattern() { throw new Error("unexpected pattern"); },
    async createPipes() { throw new Error("unexpected pipe"); },
    async fillet() { throw new Error("unexpected fillet"); },
  } satisfies RecipeOperations;

  const result = await new PlasticityRecipes(operations).createMatingEnclosureJoint({
    maleTargetId: 7, femaleTargetId: 8, seamOriginMm: [0, 0, 10], outerWidthMm: 40, outerDepthMm: 30,
    wallThicknessMm: 2, lipThicknessMm: 1, lipHeightMm: 2, clearanceMm: 0.25,
    overlapMm: 0.25, cutterOvershootMm: 0.25, revision: "r1",
  });

  assert.deepEqual(calls, [
    { operation: "createBox", originMm: [1.75, 1.75, 9.75], sizeMm: [36.5, 26.5, 2.25], revision: "r1" },
    { operation: "createBox", originMm: [3, 3, 9.5], sizeMm: [34, 24, 2.75], revision: "r2" },
    { operation: "boolean", targetIds: [9], toolIds: [10], kind: "difference", keepTools: false, revision: "r3" },
    { operation: "boolean", targetIds: [7], toolIds: [9], kind: "union", keepTools: false, revision: "r4" },
    { operation: "createBox", originMm: [1.5, 1.5, 9.75], sizeMm: [37, 27, 2.5], revision: "r5" },
    { operation: "createBox", originMm: [3.25, 3.25, 9.5], sizeMm: [33.5, 23.5, 3], revision: "r6" },
    { operation: "boolean", targetIds: [11], toolIds: [12], kind: "difference", keepTools: false, revision: "r7" },
    { operation: "boolean", targetIds: [8], toolIds: [11], kind: "difference", keepTools: false, revision: "r8" },
  ]);
  assert.equal(result.recipe, "mating-enclosure-joint");
  assert.deepEqual(result.resultBodyIds, [7, 8]);
  assert.deepEqual(result.consumedToolIds, [9, 10, 11, 12]);
  assert.equal(result.undoSteps, 8);
});

test("mating enclosure joint rejects overlap and clearance that consume the wall before mutation", async () => {
  const fake = counterboreOperations();
  const recipes = new PlasticityRecipes(fake.operations);
  await assert.rejects(recipes.createMatingEnclosureJoint({
    maleTargetId: 7, femaleTargetId: 8, seamOriginMm: [0, 0, 10], outerWidthMm: 40, outerDepthMm: 30,
    wallThicknessMm: 2, lipThicknessMm: 1, lipHeightMm: 2, clearanceMm: 1,
    overlapMm: 1, cutterOvershootMm: 0.25, revision: "r1",
  }), /wall thickness/i);
  assert.deepEqual(fake.calls, []);
});

test("locating pin pair joins an exact pin and cuts its clearance socket", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const male = body(7, "Solid");
  const female = body(8, "Solid");
  let state = scene("r1", [male, female]);
  let nextBodyId = 9;
  const operations: RecipeOperations = {
    async state() { return state; },
    async createCylinder(centerMm, radiusMm, heightMm, _name, revision, axis) {
      calls.push({ operation: "createCylinder", centerMm, radiusMm, heightMm, axis, revision });
      const created = body(nextBodyId++, "Solid");
      state = { ...state, revision: `r${Number(state.revision.slice(1)) + 1}`, bodies: [...state.bodies, created] };
      return state;
    },
    async boolean(targetIds, toolIds, kind, keepTools, revision) {
      calls.push({ operation: "boolean", targetIds, toolIds, kind, keepTools, revision });
      state = { ...state, revision: `r${Number(state.revision.slice(1)) + 1}`, bodies: state.bodies.filter((candidate) => !toolIds.includes(candidate.id)) };
      return state;
    },
    async createBox() { throw new Error("unexpected box"); },
    async createPolyline() { throw new Error("unexpected polyline"); },
    async extrudeRegions() { throw new Error("unexpected extrusion"); },
    async rectangularPattern() { throw new Error("unexpected pattern"); },
    async createPipes() { throw new Error("unexpected pipe"); },
    async fillet() { throw new Error("unexpected fillet"); },
  };

  const result = await new PlasticityRecipes(operations).createLocatingPinPair({
    maleTargetId: 7, femaleTargetId: 8, baseCenterMm: [10, 10, 10], axis: [0, 0, 2],
    pinDiameterMm: 5, pinHeightMm: 6, radialClearanceMm: 0.25, axialClearanceMm: 0.75,
    baseOverlapMm: 0.5, cutterOvershootMm: 0.5, revision: "r1",
  });

  assert.deepEqual(calls, [
    { operation: "createCylinder", centerMm: [10, 10, 9.5], radiusMm: 2.5, heightMm: 6.5, axis: [0, 0, 1], revision: "r1" },
    { operation: "boolean", targetIds: [7], toolIds: [9], kind: "union", keepTools: false, revision: "r2" },
    { operation: "createCylinder", centerMm: [10, 10, 9.5], radiusMm: 2.75, heightMm: 7.25, axis: [0, 0, 1], revision: "r3" },
    { operation: "boolean", targetIds: [8], toolIds: [10], kind: "difference", keepTools: false, revision: "r4" },
  ]);
  assert.equal(result.recipe, "locating-pin-pair");
  assert.deepEqual(result.resultBodyIds, [7, 8]);
  assert.deepEqual(result.consumedToolIds, [9, 10]);
  assert.equal(result.undoSteps, 4);
});

test("locating pin pair rejects the same body on both sides before mutation", async () => {
  const fake = counterboreOperations();
  const recipes = new PlasticityRecipes(fake.operations);
  await assert.rejects(recipes.createLocatingPinPair({
    maleTargetId: 7, femaleTargetId: 7, baseCenterMm: [10, 10, 10], axis: [0, 0, 1],
    pinDiameterMm: 5, pinHeightMm: 6, radialClearanceMm: 0.25, axialClearanceMm: 0.75,
    baseOverlapMm: 0.5, cutterOvershootMm: 0.5, revision: "r1",
  }), /different Solid bodies/i);
  assert.deepEqual(fake.calls, []);
});

test("locating pin pattern creates all male pins and female sockets as one paired native recipe", async () => {
  const calls: Array<Record<string, unknown>> = [];
  let state = scene("r1", [body(7, "Solid"), body(8, "Solid")]);
  let nextId = 9;
  const operations = {
    async state() { return state; },
    async createCylinder(centerMm: [number, number, number], radiusMm: number, heightMm: number, _name: string | undefined, revision: string, axis: [number, number, number]) {
      calls.push({ operation: "createCylinder", centerMm, radiusMm, heightMm, revision, axis });
      const id = nextId++;
      state = { ...state, revision: `r${Number(state.revision.slice(1)) + 1}`, bodies: [...state.bodies, body(id, "Solid")] };
      return state;
    },
    async boolean(targetIds: number[], toolIds: number[], kind: string, keepTools: boolean, revision: string) {
      calls.push({ operation: "boolean", targetIds, toolIds, kind, keepTools, revision });
      state = { ...state, revision: `r${Number(state.revision.slice(1)) + 1}`, bodies: state.bodies.filter((candidate) => !toolIds.includes(candidate.id)) };
      return state;
    },
  } as unknown as RecipeOperations;

  const result = await new PlasticityRecipes(operations).createLocatingPinPairPattern({
    maleTargetId: 7, femaleTargetId: 8, baseCentersMm: [[10, 10, 10], [30, 10, 10]], axis: [0, 0, 2],
    pinDiameterMm: 5, pinHeightMm: 6, radialClearanceMm: 0.25, axialClearanceMm: 0.75,
    baseOverlapMm: 0.5, cutterOvershootMm: 0.5, revision: "r1",
  });

  assert.deepEqual(calls, [
    { operation: "createCylinder", centerMm: [10, 10, 9.5], radiusMm: 2.5, heightMm: 6.5, revision: "r1", axis: [0, 0, 1] },
    { operation: "createCylinder", centerMm: [30, 10, 9.5], radiusMm: 2.5, heightMm: 6.5, revision: "r2", axis: [0, 0, 1] },
    { operation: "boolean", targetIds: [7], toolIds: [9, 10], kind: "union", keepTools: false, revision: "r3" },
    { operation: "createCylinder", centerMm: [10, 10, 9.5], radiusMm: 2.75, heightMm: 7.25, revision: "r4", axis: [0, 0, 1] },
    { operation: "createCylinder", centerMm: [30, 10, 9.5], radiusMm: 2.75, heightMm: 7.25, revision: "r5", axis: [0, 0, 1] },
    { operation: "boolean", targetIds: [8], toolIds: [11, 12], kind: "difference", keepTools: false, revision: "r6" },
  ]);
  assert.equal(result.pinCount, 2);
  assert.deepEqual(result.resultBodyIds, [7, 8]);
  assert.deepEqual(result.consumedToolIds, [9, 10, 11, 12]);
  assert.equal(result.undoSteps, 6);
});

test("locating pin pattern rejects duplicate centers before native mutation", async () => {
  const fake = counterboreOperations();
  await assert.rejects(new PlasticityRecipes(fake.operations).createLocatingPinPairPattern({
    maleTargetId: 7, femaleTargetId: 8, baseCentersMm: [[10, 10, 10], [10, 10, 10]], axis: [0, 0, 1],
    pinDiameterMm: 5, pinHeightMm: 6, radialClearanceMm: 0.25, axialClearanceMm: 0.75,
    baseOverlapMm: 0.5, cutterOvershootMm: 0.5, revision: "r1",
  }), /centers must be distinct/i);
  assert.deepEqual(fake.calls, []);
});

test("split screw-and-insert recipe cuts aligned clearance holes and matching insert pockets", async () => {
  const calls: Array<Record<string, unknown>> = [];
  let state = scene("r1", [body(7, "Solid"), body(8, "Solid")]);
  let nextId = 9;
  const operations = {
    async state() { return state; },
    async createCylinder(centerMm: [number, number, number], radiusMm: number, heightMm: number, _name: string | undefined, revision: string, axis: [number, number, number]) {
      calls.push({ operation: "createCylinder", centerMm, radiusMm, heightMm, revision, axis });
      const id = nextId++;
      state = { ...state, revision: `r${Number(state.revision.slice(1)) + 1}`, bodies: [...state.bodies, body(id, "Solid")] };
      return state;
    },
    async boolean(targetIds: number[], toolIds: number[], kind: string, keepTools: boolean, revision: string) {
      calls.push({ operation: "boolean", targetIds, toolIds, kind, keepTools, revision });
      state = { ...state, revision: `r${Number(state.revision.slice(1)) + 1}`, bodies: state.bodies.filter((candidate) => !toolIds.includes(candidate.id)) };
      return state;
    },
  } as unknown as RecipeOperations;

  const result = await new PlasticityRecipes(operations).createSplitScrewInsertJoint({
    maleTargetId: 7, femaleTargetId: 8,
    screwEntryCentersMm: [[10, 10, 0]], insertEntryCentersMm: [[10, 10, 8]], axis: [0, 0, 1],
    fastenerDesignation: "M5x12", screwLengthMm: 12, minimumEngagementMm: 3, maximumEngagementMm: 5,
    insertPartNumber: "Qualified-M5-heat-set-insert", insertThreadNominalDiameterMm: 5, insertThreadPitchMm: 0.8,
    insertSourceUrl: "https://manufacturer.example/qualified-test-insert",
    holeDiameterMm: 5.3, maleThroughDepthMm: 8, holeOvershootMm: 0.5,
    pilotDiameterMm: 3, pilotDepthMm: 8, insertDiameterMm: 4.6, insertDepthMm: 6,
    leadInDiameterMm: 5.4, leadInDepthMm: 1, femaleMaterialDepthMm: 10, insertOvershootMm: 0.5, revision: "r1",
  });

  assert.deepEqual(calls, [
    { operation: "createCylinder", centerMm: [10, 10, -0.5], radiusMm: 2.65, heightMm: 9, revision: "r1", axis: [0, 0, 1] },
    { operation: "boolean", targetIds: [7], toolIds: [9], kind: "difference", keepTools: false, revision: "r2" },
    { operation: "createCylinder", centerMm: [10, 10, 7.5], radiusMm: 1.5, heightMm: 8.5, revision: "r3", axis: [0, 0, 1] },
    { operation: "createCylinder", centerMm: [10, 10, 7.5], radiusMm: 2.3, heightMm: 6.5, revision: "r4", axis: [0, 0, 1] },
    { operation: "createCylinder", centerMm: [10, 10, 7.5], radiusMm: 2.7, heightMm: 1.5, revision: "r5", axis: [0, 0, 1] },
    { operation: "boolean", targetIds: [8], toolIds: [10, 11, 12], kind: "difference", keepTools: false, revision: "r6" },
  ]);
  assert.equal(result.fastenerCount, 1);
  assert.equal(result.insertPartNumber, "Qualified-M5-heat-set-insert");
  assert.equal(result.insertThreadNominalDiameterMm, 5);
  assert.equal(result.insertThreadPitchMm, 0.8);
  assert.equal(result.insertSourceUrl, "https://manufacturer.example/qualified-test-insert");
  assert.deepEqual(result.resultBodyIds, [7, 8]);
  assert.equal(result.undoSteps, 6);
});

test("split screw-and-insert recipe rejects off-axis stations before native mutation", async () => {
  const fake = counterboreOperations();
  await assert.rejects(new PlasticityRecipes(fake.operations).createSplitScrewInsertJoint({
    maleTargetId: 7, femaleTargetId: 8,
    screwEntryCentersMm: [[10, 10, 0]], insertEntryCentersMm: [[10.1, 10, 8]], axis: [0, 0, 1],
    fastenerDesignation: "M5x12", screwLengthMm: 12, minimumEngagementMm: 3, maximumEngagementMm: 5,
    insertPartNumber: "Qualified-M5-heat-set-insert", insertThreadNominalDiameterMm: 5, insertThreadPitchMm: 0.8,
    insertSourceUrl: "https://manufacturer.example/qualified-test-insert",
    holeDiameterMm: 5.3, maleThroughDepthMm: 8, holeOvershootMm: 0.5,
    pilotDiameterMm: 3, pilotDepthMm: 8, insertDiameterMm: 4.6, insertDepthMm: 6,
    leadInDiameterMm: 5.4, leadInDepthMm: 1, femaleMaterialDepthMm: 10, insertOvershootMm: 0.5, revision: "r1",
  }), /centers must be coaxial/i);
  assert.deepEqual(fake.calls, []);
});

test("tongue and groove joint creates editable profiles with radial and axial clearance", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const first = body(7, "Solid");
  const second = body(8, "Solid");
  let state = scene("r1", [first, second]);
  let nextBodyId = 9;
  const operations: RecipeOperations = {
    async state() { return state; },
    async createPolyline(pointsMm, closed, revision) {
      calls.push({ operation: "createPolyline", pointsMm, closed, revision });
      const id = nextBodyId++;
      const nextRevision = `r${Number(state.revision.slice(1)) + 1}`;
      const createdRegion = {
        id: `region-${id}`, entityId: id * 10, islandVersionId: id * 10 + 1, sketchId: id * 10 + 2,
        sketchWireIds: [id], measurementSource: "render-mesh" as const, displayBoundsMm: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 0] as [number, number, number] },
      };
      state = {
        ...state, revision: nextRevision, bodies: [...state.bodies, body(id, "Wire")],
        regions: id === 11
          ? [{ ...state.regions[0]!, sketchWireIds: [9, 11] }, { ...createdRegion, sketchWireIds: [9, 11] }]
          : [...state.regions, createdRegion],
      };
      return state;
    },
    async extrudeRegions(regionIds, distanceMm, revision) {
      calls.push({ operation: "extrudeRegions", regionIds, distanceMm, revision });
      const id = nextBodyId++;
      state = { ...state, revision: `r${Number(state.revision.slice(1)) + 1}`, bodies: [...state.bodies, body(id, "Solid")] };
      return state;
    },
    async boolean(targetIds, toolIds, kind, keepTools, revision) {
      calls.push({ operation: "boolean", targetIds, toolIds, kind, keepTools, revision });
      state = { ...state, revision: `r${Number(state.revision.slice(1)) + 1}`, bodies: state.bodies.filter((candidate) => !toolIds.includes(candidate.id)) };
      return state;
    },
    async createBox() { throw new Error("unexpected box"); },
    async createCylinder() { throw new Error("unexpected cylinder"); },
    async rectangularPattern() { throw new Error("unexpected pattern"); },
    async createPipes() { throw new Error("unexpected pipe"); },
    async fillet() { throw new Error("unexpected fillet"); },
  };

  const result = await new PlasticityRecipes(operations).createTongueGrooveJoint({
    tongueTargetId: 7, grooveTargetId: 8, baseCenterMm: [20, 15, 10], axis: [0, 0, 1], widthDirection: [1, 0, 0],
    tongueWidthMm: 12, tongueThicknessMm: 4, tongueHeightMm: 5,
    radialClearanceMm: 0.25, axialClearanceMm: 0.75,
    baseOverlapMm: 0.5, cutterOvershootMm: 0.5, revision: "r1",
  });

  assert.deepEqual(calls, [
    { operation: "createPolyline", pointsMm: [[14, 13, 9.5], [26, 13, 9.5], [26, 17, 9.5], [14, 17, 9.5]], closed: true, revision: "r1" },
    { operation: "extrudeRegions", regionIds: ["region-9"], distanceMm: 5.5, revision: "r2" },
    { operation: "boolean", targetIds: [7], toolIds: [10], kind: "union", keepTools: false, revision: "r3" },
    { operation: "createPolyline", pointsMm: [[13.75, 12.75, 9.5], [26.25, 12.75, 9.5], [26.25, 17.25, 9.5], [13.75, 17.25, 9.5]], closed: true, revision: "r4" },
    { operation: "extrudeRegions", regionIds: ["region-9", "region-11"], distanceMm: 6.25, revision: "r5" },
    { operation: "boolean", targetIds: [8], toolIds: [12], kind: "difference", keepTools: false, revision: "r6" },
  ]);
  assert.equal(result.recipe, "tongue-groove-joint");
  assert.deepEqual(result.profileBodyIds, [9, 11]);
  assert.deepEqual(result.resultBodyIds, [7, 8]);
  assert.deepEqual(result.consumedToolIds, [10, 12]);
  assert.equal(result.undoSteps, 6);
});

test("tongue and groove joint rejects a width direction parallel to the mating axis before mutation", async () => {
  const fake = counterboreOperations();
  const recipes = new PlasticityRecipes(fake.operations);
  await assert.rejects(recipes.createTongueGrooveJoint({
    tongueTargetId: 7, grooveTargetId: 8, baseCenterMm: [20, 15, 10], axis: [0, 0, 1], widthDirection: [0, 0, 1],
    tongueWidthMm: 12, tongueThicknessMm: 4, tongueHeightMm: 5,
    radialClearanceMm: 0.25, axialClearanceMm: 0.75,
    baseOverlapMm: 0.5, cutterOvershootMm: 0.5, revision: "r1",
  }), /perpendicular/i);
  assert.deepEqual(fake.calls, []);
});

test("dovetail joint creates a flared male profile and clearance-expanded female cutter", async () => {
  const calls: Array<Record<string, unknown>> = [];
  let state = scene("r1", [body(7, "Solid"), body(8, "Solid")]);
  let nextBodyId = 9;
  const operations: RecipeOperations = {
    async state() { return state; },
    async createPolyline(pointsMm, closed, revision) {
      calls.push({ operation: "createPolyline", pointsMm, closed, revision });
      const id = nextBodyId++;
      const min = [0, 1, 2].map((axis) => Math.min(...pointsMm.map((point) => point[axis]!))) as [number, number, number];
      const max = [0, 1, 2].map((axis) => Math.max(...pointsMm.map((point) => point[axis]!))) as [number, number, number];
      const createdRegion = {
        id: `region-${id}`, entityId: id * 10, islandVersionId: id * 10 + 1, sketchId: id * 10 + 2,
        sketchWireIds: [id], measurementSource: "render-mesh" as const, displayBoundsMm: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 0] as [number, number, number] },
      };
      createdRegion.displayBoundsMm = { min, max };
      state = { ...state, revision: `r${Number(state.revision.slice(1)) + 1}`, bodies: [...state.bodies, body(id, "Wire")], regions: [...state.regions, createdRegion] };
      return state;
    },
    async extrudeRegions(regionIds, distanceMm, revision) {
      calls.push({ operation: "extrudeRegions", regionIds, distanceMm, revision });
      const id = nextBodyId++;
      state = { ...state, revision: `r${Number(state.revision.slice(1)) + 1}`, bodies: [...state.bodies, body(id, "Solid")] };
      return state;
    },
    async boolean(targetIds, toolIds, kind, keepTools, revision) {
      calls.push({ operation: "boolean", targetIds, toolIds, kind, keepTools, revision });
      state = { ...state, revision: `r${Number(state.revision.slice(1)) + 1}`, bodies: state.bodies.filter((candidate) => !toolIds.includes(candidate.id)) };
      return state;
    },
    async createBox() { throw new Error("unexpected box"); },
    async createCylinder() { throw new Error("unexpected cylinder"); },
    async rectangularPattern() { throw new Error("unexpected pattern"); },
    async createPipes() { throw new Error("unexpected pipe"); },
    async fillet() { throw new Error("unexpected fillet"); },
  };

  const result = await new PlasticityRecipes(operations).createDovetailJoint({
    maleTargetId: 7, femaleTargetId: 8, baseCenterMm: [20, 15, 10], axis: [0, 0, 1], widthDirection: [1, 0, 0],
    rootWidthMm: 8, flareMm: 2, tongueThicknessMm: 4, tongueHeightMm: 5,
    radialClearanceMm: 0.2, axialClearanceMm: 0.5, baseOverlapMm: 0.5, cutterOvershootMm: 0.5, revision: "r1",
  });

  assert.deepEqual(calls, [
    { operation: "createPolyline", pointsMm: [[16, 13, 9.5], [24, 13, 9.5], [26, 17, 9.5], [14, 17, 9.5]], closed: true, revision: "r1" },
    { operation: "extrudeRegions", regionIds: ["region-9"], distanceMm: 5.5, revision: "r2" },
    { operation: "boolean", targetIds: [7], toolIds: [10], kind: "union", keepTools: false, revision: "r3" },
    { operation: "createPolyline", pointsMm: [[15.8, 12.8, 9.5], [24.2, 12.8, 9.5], [26.2, 17.2, 9.5], [13.8, 17.2, 9.5]], closed: true, revision: "r4" },
    { operation: "extrudeRegions", regionIds: ["region-11"], distanceMm: 6, revision: "r5" },
    { operation: "boolean", targetIds: [8], toolIds: [12], kind: "difference", keepTools: false, revision: "r6" },
  ]);
  assert.equal(result.recipe, "dovetail-joint");
  assert.deepEqual(result.profileBodyIds, [9, 11]);
  assert.deepEqual(result.resultBodyIds, [7, 8]);
  assert.deepEqual(result.consumedToolIds, [10, 12]);
  assert.equal(result.undoSteps, 6);
});

test("dovetail joint rejects a negative flare before mutation", async () => {
  const fake = counterboreOperations();
  await assert.rejects(new PlasticityRecipes(fake.operations).createDovetailJoint({
    maleTargetId: 7, femaleTargetId: 8, baseCenterMm: [20, 15, 10], axis: [0, 0, 1], widthDirection: [1, 0, 0],
    rootWidthMm: 8, flareMm: -1, tongueThicknessMm: 4, tongueHeightMm: 5,
    radialClearanceMm: 0.2, axialClearanceMm: 0.5, baseOverlapMm: 0.5, cutterOvershootMm: 0.5, revision: "r1",
  }), /flare must be positive/i);
  assert.deepEqual(fake.calls, []);
});

type RecipeOperations = ConstructorParameters<typeof PlasticityRecipes>[0];

function counterboreOperations(failAtCall?: number): { operations: RecipeOperations; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const target = body(7, "Solid");
  let state = scene("r1", [target]);
  let nextBodyId = 8;
  const maybeFail = () => {
    if (calls.length === failAtCall) throw new Error("native step failed");
  };
  const operations: RecipeOperations = {
    async state() { return state; },
    async createPolyline() { throw new Error("unexpected polyline"); },
    async extrudeRegions() { throw new Error("unexpected extrusion"); },
    async rectangularPattern() { throw new Error("unexpected pattern"); },
    async createPipes() { throw new Error("unexpected pipe"); },
    async fillet() { throw new Error("unexpected fillet"); },
    async createBox() { throw new Error("unexpected box"); },
    async createCylinder(centerMm, radiusMm, heightMm, _name, revision, axis) {
      calls.push({ operation: "createCylinder", centerMm, radiusMm, heightMm, axis, revision });
      maybeFail();
      const id = nextBodyId++;
      state = scene(`r${Number(state.revision.slice(1)) + 1}`, [...state.bodies, body(id, "Solid")]);
      return state;
    },
    async boolean(targetIds, toolIds, kind, keepTools, revision) {
      calls.push({ operation: "boolean", targetIds, toolIds, kind, keepTools, revision });
      maybeFail();
      state = scene(`r${Number(state.revision.slice(1)) + 1}`, state.bodies.filter((candidate) => !toolIds.includes(candidate.id)));
      return state;
    },
  };
  return { operations, calls };
}

function slottedHolePatternOperations(failAtCall?: number): { operations: RecipeOperations; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const target = body(7, "Solid");
  let state = scene("r1", [target]);
  let nextBodyId = 8;
  let revision = 1;
  const maybeFail = () => {
    if (calls.length === failAtCall) throw new Error("native slot pattern step failed");
  };
  const advance = (added: ReturnType<typeof body>[], removedIds: number[] = []) => {
    revision += 1;
    state = { ...state, revision: `r${revision}`, bodies: [...state.bodies.filter((candidate) => !removedIds.includes(candidate.id)), ...added] };
    return state;
  };
  const operations: RecipeOperations = {
    async state() { return state; },
    async createPolyline(pointsMm, closed, currentRevision) {
      calls.push({ operation: "createPolyline", pointsMm, closed, revision: currentRevision });
      maybeFail();
      const id = nextBodyId++;
      const bounds = {
        min: [0, 1, 2].map((axis) => Math.min(...pointsMm.map((point) => point[axis]!))) as [number, number, number],
        max: [0, 1, 2].map((axis) => Math.max(...pointsMm.map((point) => point[axis]!))) as [number, number, number],
      };
      advance([body(id, "Wire")]);
      state = { ...state, regions: [...state.regions, {
        id: `region-${id}`, entityId: id * 10, islandVersionId: id * 10 + 1, sketchId: id * 10 + 2,
        sketchWireIds: [id], measurementSource: "render-mesh" as const, displayBoundsMm: bounds,
      }] };
      return state;
    },
    async extrudeRegions(regionIds, distanceMm, currentRevision) {
      calls.push({ operation: "extrudeRegions", regionIds, distanceMm, revision: currentRevision });
      maybeFail();
      return advance([body(nextBodyId++, "Solid")]);
    },
    async createCylinder(centerMm, radiusMm, heightMm, _name, currentRevision, axis) {
      calls.push({ operation: "createCylinder", centerMm, radiusMm, heightMm, axis, revision: currentRevision });
      maybeFail();
      return advance([body(nextBodyId++, "Solid")]);
    },
    async boolean(targetIds, toolIds, kind, keepTools, currentRevision) {
      calls.push({ operation: "boolean", targetIds, toolIds, kind, keepTools, revision: currentRevision });
      maybeFail();
      return advance([], toolIds);
    },
    async rectangularPattern() { throw new Error("unexpected pattern"); },
    async createPipes() { throw new Error("unexpected pipe"); },
    async fillet() { throw new Error("unexpected fillet"); },
    async createBox() { throw new Error("unexpected box"); },
  };
  return { operations, calls };
}

function scene(revision: string, bodies: RuntimeState["bodies"]): RuntimeState {
  return {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision,
    dbVersion: Number(revision.slice(1)), undoDepth: Number(revision.slice(1)) - 1, redoDepth: 0,
    construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" },
    regions: [], bodies,
  };
}

function body(id: number, type: string): RuntimeState["bodies"][number] {
  return { id, versionId: id, type, name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] };
}
