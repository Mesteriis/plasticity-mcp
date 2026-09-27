import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeState } from "./runtime.ts";
import {
  PrintedThreadRecipes,
  PrintedThreadCalibrationRecipeError,
  PrintedThreadPairRecipeError,
  PrintedThreadRecipeError,
  printedThreadGeometry,
  type PrintedExternalThreadInput,
  type PrintedHexPairInput,
  type PrintedHexNutInput,
  type PrintedHexScrewInput,
  type PrintedInternalThreadInput,
  type PrintedThreadCalibrationInput,
} from "./printed-thread-recipes.ts";

test("derives a bounded rounded print profile without treating M size as a standard thread", () => {
  assert.deepEqual(printedThreadGeometry({ nominalDiameterMm: 5, pitchMm: 1.25, threadDepthMm: 0.6, profileClearanceMm: 0.15 }), {
    profile: "rounded-print-v1",
    nominalCrestDiameterMm: 5,
    coreDiameterMm: 3.8,
    helixDiameterMm: 4.4,
    maleProfileDiameterMm: 0.66,
    femaleBoreDiameterMm: 4.1,
    femaleGrooveDiameterMm: 0.96,
    femaleGrooveOuterDiameterMm: 5.36,
    pitchMm: 1.25,
    profileClearanceMm: 0.15,
  });
});

test("creates a standalone exact external rounded thread and clips it to its crest envelope", async () => {
  const initial = state("r0", []);
  const states = [
    state("r1", [solid(1)]),
    state("r2", [solid(1), wire(2)]),
    state("r3", [solid(1), wire(2), solid(3)]),
    state("r4", [solid(1), wire(2)]),
    state("r5", [solid(1), wire(2), solid(4)]),
    state("r6", [solid(1), wire(2)]),
  ];
  const fake = new FakeOperations(initial, states);
  const result = await new PrintedThreadRecipes(fake as never).createExternalThread(externalInput());

  assert.equal(result.recipe, "printed-external-thread");
  assert.equal(result.resultBodyId, 1);
  assert.equal(result.helixBodyId, 2);
  assert.equal(result.undoSteps, 6);
  assert.deepEqual(result.consumedToolIds, [3, 4]);
  assert.deepEqual(fake.calls.map((call) => call.name), ["createCylinder", "createHelix", "createPipes", "boolean", "createCylinder", "boolean"]);
  assert.deepEqual(fake.calls[1]!.args.slice(0, 4), [[0, 0, 0], [0, 0, 8], 2.2, 6.4]);
  assert.deepEqual(fake.calls[2]!.args.slice(0, 3), [[2], 0.66, 0]);
  assert.deepEqual(fake.calls[5]!.args.slice(0, 4), [[1], [4], "intersection", false]);
});

test("cuts a clearance-expanded internal rounded thread into one current Solid", async () => {
  const initial = state("r0", [solid(10)]);
  const states = [
    state("r1", [solid(10), solid(11)]),
    state("r2", [solid(10), solid(11), wire(12)]),
    state("r3", [solid(10), solid(11), wire(12), solid(13)]),
    state("r4", [solid(10), wire(12)]),
  ];
  const fake = new FakeOperations(initial, states);
  const result = await new PrintedThreadRecipes(fake as never).cutInternalThread(internalInput());

  assert.equal(result.recipe, "printed-internal-thread");
  assert.equal(result.targetId, 10);
  assert.equal(result.helixBodyId, 12);
  assert.deepEqual(result.consumedToolIds, [11, 13]);
  assert.deepEqual(fake.calls.map((call) => call.name), ["createCylinder", "createHelix", "createPipes", "boolean"]);
  assert.equal(fake.calls[0]!.args[1], 2.05);
  assert.equal(fake.calls[2]!.args[1], 0.96);
  assert.deepEqual(fake.calls[3]!.args.slice(0, 4), [[10], [11, 13], "difference", false]);
});

test("creates a hex nut and applies the same explicit internal thread recipe", async () => {
  const initial = state("r0", []);
  const states = [
    state("r1", [wire(20)], [region("region-20", 20)]),
    state("r2", [wire(20), solid(21)], [region("region-20", 20)]),
    state("r3", [wire(20), solid(21), solid(22)], [region("region-20", 20)]),
    state("r4", [wire(20), solid(21), solid(22), wire(23)], [region("region-20", 20)]),
    state("r5", [wire(20), solid(21), solid(22), wire(23), solid(24)], [region("region-20", 20)]),
    state("r6", [wire(20), solid(21), wire(23)], [region("region-20", 20)]),
  ];
  const fake = new FakeOperations(initial, states);
  const result = await new PrintedThreadRecipes(fake as never).createHexNut(nutInput());

  assert.equal(result.recipe, "printed-hex-nut");
  assert.equal(result.resultBodyId, 21);
  assert.equal(result.profileBodyId, 20);
  assert.equal(result.helixBodyId, 23);
  assert.equal(result.undoSteps, 6);
  assert.deepEqual(fake.calls.map((call) => call.name), ["createPolyline", "extrudeRegions", "createCylinder", "createHelix", "createPipes", "boolean"]);
});

test("adds an overlapping wrenchable hex head to the printable external thread", async () => {
  const initial = state("r0", []);
  const states = [
    state("r1", [solid(1)]),
    state("r2", [solid(1), wire(2)]),
    state("r3", [solid(1), wire(2), solid(3)]),
    state("r4", [solid(1), wire(2)]),
    state("r5", [solid(1), wire(2), solid(4)]),
    state("r6", [solid(1), wire(2)]),
    state("r7", [solid(1), wire(2), wire(5)], [region("region-5", 5)]),
    state("r8", [solid(1), wire(2), wire(5), solid(6)], [region("region-5", 5)]),
    state("r9", [solid(1), wire(2), wire(5)], [region("region-5", 5)]),
  ];
  const fake = new FakeOperations(initial, states);
  const result = await new PrintedThreadRecipes(fake as never).createHexScrew(screwInput());

  assert.equal(result.recipe, "printed-hex-screw");
  assert.equal(result.resultBodyId, 1);
  assert.equal(result.headProfileBodyId, 5);
  assert.equal(result.helixBodyId, 2);
  assert.equal(result.undoSteps, 9);
  assert.deepEqual(fake.calls.slice(-3).map((call) => call.name), ["createPolyline", "extrudeRegions", "boolean"]);
  assert.equal(fake.calls.at(-2)!.args[1], 3.2);
  assert.deepEqual(fake.calls.at(-1)!.args.slice(0, 4), [[1], [6], "union", false]);
});

test("creates a complete printed hex pair with one shared thread definition", async () => {
  const initial = state("r0", []);
  const states = [
    state("r1", [solid(1)]),
    state("r2", [solid(1), wire(2)]),
    state("r3", [solid(1), wire(2), solid(3)]),
    state("r4", [solid(1), wire(2)]),
    state("r5", [solid(1), wire(2), solid(4)]),
    state("r6", [solid(1), wire(2)]),
    state("r7", [solid(1), wire(2), wire(5)], [region("region-5", 5)]),
    state("r8", [solid(1), wire(2), wire(5), solid(6)], [region("region-5", 5)]),
    state("r9", [solid(1), wire(2), wire(5)], [region("region-5", 5)]),
    state("r10", [solid(1), wire(2), wire(5), wire(20)], [region("region-20", 20)]),
    state("r11", [solid(1), wire(2), wire(5), wire(20), solid(21)], [region("region-20", 20)]),
    state("r12", [solid(1), wire(2), wire(5), wire(20), solid(21), solid(22)], [region("region-20", 20)]),
    state("r13", [solid(1), wire(2), wire(5), wire(20), solid(21), solid(22), wire(23)], [region("region-20", 20)]),
    state("r14", [solid(1), wire(2), wire(5), wire(20), solid(21), solid(22), wire(23), solid(24)], [region("region-20", 20)]),
    state("r15", [solid(1), wire(2), wire(5), wire(20), solid(21), wire(23)], [region("region-20", 20)]),
  ];
  const fake = new FakeOperations(initial, states);
  const result = await new PrintedThreadRecipes(fake as never).createHexPair(pairInput());

  assert.equal(result.recipe, "printed-hex-pair");
  assert.equal(result.screw.resultBodyId, 1);
  assert.equal(result.nut.resultBodyId, 21);
  assert.equal(result.beforeRevision, "r0");
  assert.equal(result.afterRevision, "r15");
  assert.equal(result.undoSteps, 15);
  assert.equal(result.steps.length, 15);
  assert.equal(result.geometry.profileClearanceMm, 0.15);
  assert.deepEqual(fake.calls.map((call) => call.name), [
    "createCylinder", "createHelix", "createPipes", "boolean", "createCylinder", "boolean",
    "createPolyline", "extrudeRegions", "boolean",
    "createPolyline", "extrudeRegions", "createCylinder", "createHelix", "createPipes", "boolean",
  ]);
});

test("validates the complete printed pair before creating its screw", async () => {
  const input = pairInput();
  input.nutAcrossFlatsMm = 5.5;
  const fake = new FakeOperations(state("r0", []), []);
  await assert.rejects(new PrintedThreadRecipes(fake as never).createHexPair(input), /nut wall/i);
  assert.equal(fake.calls.length, 0);
});

test("creates one screw and an ordered clearance ladder of printable nuts", async () => {
  const screwBodies = [solid(1), wire(2), wire(5)];
  const firstNutBodies = [...screwBodies, wire(20), solid(21), wire(23)];
  const states = [
    state("r1", [solid(1)]),
    state("r2", [solid(1), wire(2)]),
    state("r3", [solid(1), wire(2), solid(3)]),
    state("r4", [solid(1), wire(2)]),
    state("r5", [solid(1), wire(2), solid(4)]),
    state("r6", [solid(1), wire(2)]),
    state("r7", [solid(1), wire(2), wire(5)], [region("region-5", 5)]),
    state("r8", [solid(1), wire(2), wire(5), solid(6)], [region("region-5", 5)]),
    state("r9", screwBodies, [region("region-5", 5)]),
    state("r10", [...screwBodies, wire(20)], [region("region-5", 5), region("region-20", 20)]),
    state("r11", [...screwBodies, wire(20), solid(21)], [region("region-5", 5), region("region-20", 20)]),
    state("r12", [...screwBodies, wire(20), solid(21), solid(22)], [region("region-5", 5), region("region-20", 20)]),
    state("r13", [...screwBodies, wire(20), solid(21), solid(22), wire(23)], [region("region-5", 5), region("region-20", 20)]),
    state("r14", [...screwBodies, wire(20), solid(21), solid(22), wire(23), solid(24)], [region("region-5", 5), region("region-20", 20)]),
    state("r15", firstNutBodies, [region("region-5", 5), region("region-20", 20)]),
    state("r16", [...firstNutBodies, wire(30)], [region("region-5", 5), region("region-20", 20), region("region-30", 30)]),
    state("r17", [...firstNutBodies, wire(30), solid(31)], [region("region-5", 5), region("region-20", 20), region("region-30", 30)]),
    state("r18", [...firstNutBodies, wire(30), solid(31), solid(32)], [region("region-5", 5), region("region-20", 20), region("region-30", 30)]),
    state("r19", [...firstNutBodies, wire(30), solid(31), solid(32), wire(33)], [region("region-5", 5), region("region-20", 20), region("region-30", 30)]),
    state("r20", [...firstNutBodies, wire(30), solid(31), solid(32), wire(33), solid(34)], [region("region-5", 5), region("region-20", 20), region("region-30", 30)]),
    state("r21", [...firstNutBodies, wire(30), solid(31), wire(33)], [region("region-5", 5), region("region-20", 20), region("region-30", 30)]),
  ];
  const fake = new FakeOperations(state("r0", []), states);
  const result = await new PrintedThreadRecipes(fake as never).createCalibrationSet(calibrationInput());

  assert.equal(result.recipe, "printed-thread-calibration-set");
  assert.equal(result.qualificationStatus, "requires-physical-fit-test");
  assert.equal(result.screw.resultBodyId, 1);
  assert.deepEqual(result.samples.map((sample) => ({ id: sample.id, clearance: sample.profileClearanceMm, bodyId: sample.nut.resultBodyId })), [
    { id: "tight", clearance: 0.1, bodyId: 21 },
    { id: "normal", clearance: 0.2, bodyId: 31 },
  ]);
  assert.deepEqual(result.samples.map((sample) => sample.nut.geometry.femaleBoreDiameterMm), [4, 4.2]);
  assert.equal(result.beforeRevision, "r0");
  assert.equal(result.afterRevision, "r21");
  assert.equal(result.undoSteps, 21);
  assert.equal(result.steps.length, 21);
  assert.equal(fake.calls.filter((call) => call.name === "createPolyline").length, 3);
});

test("validates every calibration sample before creating its screw", async () => {
  const duplicateClearance = calibrationInput();
  duplicateClearance.samples[1]!.profileClearanceMm = duplicateClearance.samples[0]!.profileClearanceMm;
  const duplicateFake = new FakeOperations(state("r0", []), []);
  await assert.rejects(new PrintedThreadRecipes(duplicateFake as never).createCalibrationSet(duplicateClearance), /clearances must be unique/i);
  assert.equal(duplicateFake.calls.length, 0);

  const weakWall = calibrationInput();
  weakWall.nutMinimumWallThicknessMm = 1.75;
  weakWall.samples[1]!.profileClearanceMm = 0.29;
  const wallFake = new FakeOperations(state("r0", []), []);
  await assert.rejects(new PrintedThreadRecipes(wallFake as never).createCalibrationSet(weakWall), /nut wall/i);
  assert.equal(wallFake.calls.length, 0);
});

test("preserves an uncertain native outcome through pair and calibration wrappers", () => {
  const nativeTimeout = new PrintedThreadRecipeError(
    "Printed hex nut recipe",
    6,
    new Error("CDP request timed out: Runtime.callFunctionOn"),
    [],
    "r9",
  );
  assert.equal(nativeTimeout.uncertain, true);
  const screw = { resultBodyId: 1 } as never;
  assert.equal(new PrintedThreadPairRecipeError(nativeTimeout, screw, "r9").uncertain, true);
  assert.equal(new PrintedThreadCalibrationRecipeError(nativeTimeout, screw, [], "r9").uncertain, true);
});

test("rejects overlapping turns, an unprintable nut wall, and stale targets before mutation", async () => {
  const external = externalInput();
  external.threadDepthMm = 1.2;
  await assert.rejects(new PrintedThreadRecipes(new FakeOperations(state("r0", []), []) as never).createExternalThread(external), /profile diameter.*pitch/i);

  const nut = nutInput();
  nut.acrossFlatsMm = 6;
  await assert.rejects(new PrintedThreadRecipes(new FakeOperations(state("r0", []), []) as never).createHexNut(nut), /wall/i);

  await assert.rejects(new PrintedThreadRecipes(new FakeOperations(state("r1", [solid(10)]), []) as never).cutInternalThread(internalInput()), /stale/i);
});

function externalInput(): PrintedExternalThreadInput {
  return {
    axisStartMm: [0, 0, 0], axis: [0, 0, 1], radialDirection: [1, 0, 0],
    threadLengthMm: 8, nominalDiameterMm: 5, pitchMm: 1.25, threadDepthMm: 0.6,
    handedness: "right", name: "Printed M5-like stud", revision: "r0",
  };
}

function internalInput(): PrintedInternalThreadInput {
  return {
    targetId: 10, entryCenterMm: [0, 0, 0], axis: [0, 0, 1], radialDirection: [1, 0, 0],
    materialDepthMm: 8, nominalDiameterMm: 5, pitchMm: 1.25, threadDepthMm: 0.6,
    profileClearanceMm: 0.15, cutterOvershootMm: 0.5, handedness: "right", revision: "r0",
  };
}

function nutInput(): PrintedHexNutInput {
  return {
    entryCenterMm: [0, 0, 0], axis: [0, 0, 1], flatNormalDirection: [1, 0, 0],
    radialDirection: [1, 0, 0], acrossFlatsMm: 9, thicknessMm: 8, minimumWallThicknessMm: 1.5,
    nominalDiameterMm: 5, pitchMm: 1.25, threadDepthMm: 0.6, profileClearanceMm: 0.15,
    cutterOvershootMm: 0.5, handedness: "right", revision: "r0",
  };
}

function screwInput(): PrintedHexScrewInput {
  return {
    ...externalInput(),
    headAcrossFlatsMm: 9,
    headHeightMm: 3,
    junctionOverlapMm: 0.2,
    flatNormalDirection: [1, 0, 0],
    name: "Printed matching hex screw",
  };
}

function pairInput(): PrintedHexPairInput {
  return {
    screwAxisStartMm: [0, 0, 0], nutEntryCenterMm: [15, 0, 0],
    axis: [0, 0, 1], radialDirection: [1, 0, 0], flatNormalDirection: [1, 0, 0],
    threadLengthMm: 8, nominalDiameterMm: 5, pitchMm: 1.25, threadDepthMm: 0.6,
    handedness: "right", screwHeadAcrossFlatsMm: 9, screwHeadHeightMm: 3,
    screwJunctionOverlapMm: 0.2, nutAcrossFlatsMm: 9, nutThicknessMm: 8,
    nutMinimumWallThicknessMm: 1.5, profileClearanceMm: 0.15, cutterOvershootMm: 0.5,
    screwName: "Printed matching hex screw", revision: "r0",
  };
}

function calibrationInput(): PrintedThreadCalibrationInput {
  const pair = pairInput();
  return {
    screwAxisStartMm: pair.screwAxisStartMm,
    axis: pair.axis,
    radialDirection: pair.radialDirection,
    threadLengthMm: pair.threadLengthMm,
    nominalDiameterMm: pair.nominalDiameterMm,
    pitchMm: pair.pitchMm,
    threadDepthMm: pair.threadDepthMm,
    handedness: pair.handedness,
    flatNormalDirection: pair.flatNormalDirection,
    screwHeadAcrossFlatsMm: pair.screwHeadAcrossFlatsMm,
    screwHeadHeightMm: pair.screwHeadHeightMm,
    screwJunctionOverlapMm: pair.screwJunctionOverlapMm,
    nutAcrossFlatsMm: pair.nutAcrossFlatsMm,
    nutThicknessMm: pair.nutThicknessMm,
    nutMinimumWallThicknessMm: pair.nutMinimumWallThicknessMm,
    cutterOvershootMm: pair.cutterOvershootMm,
    screwName: "Calibration screw",
    samples: [
      { id: "tight", nutEntryCenterMm: [15, 0, 0], profileClearanceMm: 0.1 },
      { id: "normal", nutEntryCenterMm: [30, 0, 0], profileClearanceMm: 0.2 },
    ],
    revision: "r0",
  };
}

class FakeOperations {
  readonly calls: Array<{ name: string; args: unknown[] }> = [];
  private index = 0;
  private readonly initial: RuntimeState;
  private readonly states: RuntimeState[];
  private current: RuntimeState;
  constructor(initial: RuntimeState, states: RuntimeState[]) {
    this.initial = initial;
    this.states = states;
    this.current = initial;
  }
  async state(): Promise<RuntimeState> { return this.current; }
  async createCylinder(...args: unknown[]): Promise<RuntimeState> { return this.next("createCylinder", args); }
  async createHelix(...args: unknown[]): Promise<RuntimeState> { return this.next("createHelix", args); }
  async createPipes(...args: unknown[]): Promise<RuntimeState> { return this.next("createPipes", args); }
  async boolean(...args: unknown[]): Promise<RuntimeState> { return this.next("boolean", args); }
  async createPolyline(...args: unknown[]): Promise<RuntimeState> { return this.next("createPolyline", args); }
  async extrudeRegions(...args: unknown[]): Promise<RuntimeState> { return this.next("extrudeRegions", args); }
  private next(name: string, args: unknown[]): RuntimeState {
    this.calls.push({ name, args });
    const state = this.states[this.index++];
    if (!state) throw new Error(`Unexpected ${name}`);
    this.current = state;
    return state;
  }
}

function state(revision: string, bodies: Array<Record<string, unknown>>, regions: Array<Record<string, unknown>> = []): RuntimeState {
  return { targetId: "window", title: "Untitled - Plasticity", documentToken: "document", revision, dbVersion: 1, undoDepth: 0, redoDepth: 0, construction: {} as RuntimeState["construction"], bodies, regions } as RuntimeState;
}

function solid(id: number): Record<string, unknown> { return { id, versionId: id + 100, type: "Solid", name: null, boundsMm: { min: [0, 0, 0], max: [1, 1, 1] }, faceIds: [], edgeIds: [], faces: [], edges: [] }; }
function wire(id: number): Record<string, unknown> { return { ...solid(id), type: "Wire" }; }
function region(id: string, wireId: number): Record<string, unknown> { return { id, sketchWireIds: [wireId], displayBoundsMm: { min: [-5, -5, 0], max: [5, 5, 0] } }; }
