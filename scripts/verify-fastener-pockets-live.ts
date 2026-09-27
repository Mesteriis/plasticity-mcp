#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface FastenerPocketAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseFastenerPocketAcceptanceArgs(argv: string[]): FastenerPocketAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: FastenerPocketAcceptanceOptions = { help: false, allowDisposableMutations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target") {
      const value = argv[++index];
      if (!value) throw new Error("--target requires an explicit Plasticity window ID");
      options.target = value;
    } else if (argument === "--output") {
      const value = argv[++index];
      if (!value) throw new Error("--output requires a new directory path");
      options.output = value;
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live fastener-pocket acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live fastener-pocket acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live fastener-pocket acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-fastener-pockets-live.ts --help
  node scripts/verify-fastener-pockets-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, never chooses a window automatically,
uses a separate stdio MCP process, and writes only sanitized evidence to a new directory.`;

async function main(): Promise<void> {
  const options = parseFastenerPocketAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    targetId: options.target!,
    workbenchUsed: false,
  };
  let live: LiveMcp | undefined;
  let initialState: any;
  try {
    live = await startMcp(join(output, "strength-store"));
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initialState = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireCondition(initialState.bodies.length === 0, "Refusing disposable mutations in a nonempty Plasticity document");
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "fastener-pockets-live-initial-empty" });

    const strengthFirst = await call(live.client, "plasticity_resolve_fastener_designation", {
      designation: "крепится на винт m5х10",
    });
    requireCondition(strengthFirst.analysisIntent === "both", "Resolver did not default to combined strength and geometry intent");
    requireCondition(strengthFirst.nextQuestionPackage?.id === "strength-basis", "Resolver did not put the strength-basis question package first");
    requireCondition(strengthFirst.nextQuestionPackage.questions.length === 3, "Strength-basis package did not contain the three bounded functional questions");

    const resolved = await call(live.client, "plasticity_resolve_fastener_designation", {
      designation: "винт ISO 10642 M5x10",
      jointIntent: "through-bolt-with-nut",
      analysisIntent: "geometry",
    });
    requireCondition(resolved.workflow.compatibleTools.includes("plasticity_create_countersink"), "Resolver did not route a countersunk screw to the countersink recipe");
    requireCondition(resolved.workflow.compatibleTools.includes("plasticity_create_through_hole"), "Resolver did not route a through fastener to the dedicated through-hole recipe");
    requireCondition(resolved.workflow.compatibleTools.includes("plasticity_create_hex_nut_pocket"), "Resolver did not expose the optional nut-pocket recipe");
    requireCondition(!resolved.workflow.compatibleTools.includes("plasticity_create_slotted_hole"), "Resolver proposed an adjustment slot for a fixed fastening request");
    const adjustableResolved = await call(live.client, "plasticity_resolve_fastener_designation", {
      designation: "регулируемое крепление на 2 болта M5x10 с гайками",
      analysisIntent: "geometry",
    });
    requireCondition(adjustableResolved.workflow.compatibleTools.includes("plasticity_create_slotted_hole_pattern"), "Resolver did not route multiple adjustable fasteners to the slot-pattern recipe");
    requireCondition(!adjustableResolved.workflow.compatibleTools.includes("plasticity_create_slotted_hole"), "Resolver retained the single-slot recipe for a grouped adjustable request");
    const tappedResolved = await call(live.client, "plasticity_resolve_fastener_designation", {
      designation: "винт DIN 912 M5x10 в резьбовое отверстие в металле",
      analysisIntent: "geometry",
    });
    requireCondition(tappedResolved.workflow.compatibleTools.includes("plasticity_create_blind_hole"), "Resolver did not expose the blind-hole recipe for a tapped-metal request");
    const tappedPatternResolved = await call(live.client, "plasticity_resolve_fastener_designation", {
      designation: "крепится на 2 установочных винта ISO 4029 M5x10 в резьбовые отверстия в металле",
      analysisIntent: "geometry",
    });
    requireCondition(tappedPatternResolved.workflow.compatibleTools.includes("plasticity_create_blind_hole_pattern"), "Resolver did not route multiple fixed tapped fasteners to the blind-hole pattern recipe");
    const insertPatternResolved = await call(live.client, "plasticity_resolve_fastener_designation", {
      designation: "крепится на 2 винта M3x10 в латунные термовставки",
      analysisIntent: "geometry",
    });
    requireCondition(insertPatternResolved.workflow.compatibleTools.includes("plasticity_create_heat_set_insert_pocket_pattern"), "Resolver did not route multiple fixed heat-set inserts to the grouped pocket recipe");
    requireCondition(insertPatternResolved.workflow.compatibleTools.includes("plasticity_create_through_hole_pattern"), "Resolver did not route the mating side of a repeated insert joint to grouped clearance holes");
    const bossPatternResolved = await call(live.client, "plasticity_resolve_fastener_designation", {
      designation: "крепится на 2 самореза M4x16 в печатный пластик",
      analysisIntent: "geometry",
    });
    requireCondition(bossPatternResolved.workflow.compatibleTools.includes("plasticity_create_screw_boss_pattern"), "Resolver did not route multiple fixed printed-plastic fasteners to the grouped screw-boss recipe");
    requireCondition(!bossPatternResolved.workflow.compatibleTools.includes("plasticity_create_screw_boss"), "Resolver retained the single screw-boss recipe for a grouped request");
    const socketPatternResolved = await call(live.client, "plasticity_resolve_fastener_designation", {
      designation: "крепится на 2 винта DIN 912 M4x16 с гайками",
      analysisIntent: "geometry",
    });
    requireCondition(socketPatternResolved.workflow.compatibleTools.includes("plasticity_create_counterbore_pattern"), "Resolver did not route multiple fixed socket-head screws to the counterbore pattern recipe");
    requireCondition(socketPatternResolved.workflow.compatibleTools.includes("plasticity_create_hex_nut_pocket_pattern"), "Resolver did not route multiple fixed captive nuts to the hex-pocket pattern recipe");
    const countersinkPatternResolved = await call(live.client, "plasticity_resolve_fastener_designation", {
      designation: "крепится на 2 винта ISO 10642 M5x10 с гайками",
      analysisIntent: "geometry",
    });
    requireCondition(countersinkPatternResolved.workflow.compatibleTools.includes("plasticity_create_countersink_pattern"), "Resolver did not route multiple fixed countersunk screws to the countersink pattern recipe");

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [40, 30, 8], name: "Disposable fastener pocket plate",
      intent: "Approved disposable fastener-pocket acceptance", revision: initialState.revision,
    });
    const plateId = state.bodies.find((body: { type: string }) => body.type === "Solid")?.id;
    requireCondition(Number.isInteger(plateId), "Plate creation did not return a Solid");

    state = await call(live.client, "plasticity_create_box", {
      originMm: [50, 0, 0], sizeMm: [40, 20, 8], name: "Disposable counterbore pattern plate",
      intent: "Approved disposable counterbore-pattern acceptance", revision: state.revision,
    });
    const counterborePlateId = state.bodies.find((body: { name: string }) => body.name === "Disposable counterbore pattern plate")?.id;
    requireCondition(Number.isInteger(counterborePlateId), "Counterbore-pattern plate creation did not return a Solid");
    const counterborePattern = await call(live.client, "plasticity_create_counterbore_pattern", {
      targetId: counterborePlateId, entryCentersMm: [[60, 10, 8], [80, 10, 8]], axis: [0, 0, -1],
      throughDiameterMm: 4, counterboreDiameterMm: 8, counterboreDepthMm: 3,
      throughDepthMm: 8, overshootMm: 0.5,
      intent: "Approved disposable counterbore-pattern acceptance", revision: state.revision,
    });
    requireCondition(counterborePattern.holeCount === 2 && counterborePattern.undoSteps === 5, "Counterbore pattern did not report two holes and five native steps");
    state = await call(live.client, "plasticity_status", {});
    const afterCounterborePattern = inspectCounterborePattern(state, counterborePlateId);
    const counterborePatternValidation = await call(live.client, "plasticity_validate_bodies", { ids: [counterborePlateId], revision: state.revision });
    requireCondition(counterborePatternValidation.bodies[0]?.printableSolid === true, "Native B-Rep Check did not accept the counterbore-pattern plate as a closed printable Solid");
    for (let step = 0; step < 5; step += 1) {
      state = await call(live.client, "plasticity_undo", { intent: "Verify counterbore-pattern undo", revision: state.revision });
    }
    requireCondition(counterborePatternFaces(state, counterborePlateId).length === 0, "Undo retained counterbore-pattern faces");
    for (let step = 0; step < 5; step += 1) {
      state = await call(live.client, "plasticity_redo", { intent: "Verify counterbore-pattern redo", revision: state.revision });
    }
    const counterborePatternAfterRedo = inspectCounterborePattern(state, counterborePlateId);

    state = await call(live.client, "plasticity_create_box", {
      originMm: [100, 0, 0], sizeMm: [40, 20, 8], name: "Disposable countersink pattern plate",
      intent: "Approved disposable countersink-pattern acceptance", revision: state.revision,
    });
    const countersinkPlateId = state.bodies.find((body: { name: string }) => body.name === "Disposable countersink pattern plate")?.id;
    requireCondition(Number.isInteger(countersinkPlateId), "Countersink-pattern plate creation did not return a Solid");
    const countersinkPattern = await call(live.client, "plasticity_create_countersink_pattern", {
      targetId: countersinkPlateId, entryCentersMm: [[110, 10, 8], [130, 10, 8]],
      axis: [0, 0, -1], radialDirection: [1, 0, 0],
      throughDiameterMm: 5.5, countersinkMajorDiameterMm: 10.4, includedAngleDeg: 90,
      throughDepthMm: 8, overshootMm: 0.5,
      intent: "Approved disposable countersink-pattern acceptance", revision: state.revision,
    });
    near(countersinkPattern.countersinkDepthMm, 2.45, 1e-9, "grouped countersink derived depth");
    requireCondition(countersinkPattern.holeCount === 2 && countersinkPattern.undoSteps === 7, "Countersink pattern did not report two holes and seven native steps");
    state = await call(live.client, "plasticity_status", {});
    requireCondition(countersinkPattern.profileBodyIds.every((id: number) => state.bodies.some((body: { id: number; type: string }) => body.id === id && body.type === "Wire")), "Countersink-pattern source profiles were not preserved as Wires");
    const afterCountersinkPattern = inspectCountersinkPattern(state, countersinkPlateId);
    const countersinkPatternValidation = await call(live.client, "plasticity_validate_bodies", { ids: [countersinkPlateId], revision: state.revision });
    requireCondition(countersinkPatternValidation.bodies[0]?.printableSolid === true, "Native B-Rep Check did not accept the countersink-pattern plate as a closed printable Solid");
    for (let step = 0; step < 7; step += 1) {
      state = await call(live.client, "plasticity_undo", { intent: "Verify countersink-pattern undo", revision: state.revision });
    }
    requireCondition(countersinkPatternFaces(state, countersinkPlateId).length === 0, "Undo retained countersink-pattern faces");
    for (let step = 0; step < 7; step += 1) {
      state = await call(live.client, "plasticity_redo", { intent: "Verify countersink-pattern redo", revision: state.revision });
    }
    const countersinkPatternAfterRedo = inspectCountersinkPattern(state, countersinkPlateId);

    state = await call(live.client, "plasticity_create_box", {
      originMm: [150, 0, 0], sizeMm: [40, 20, 8], name: "Disposable hex pocket pattern plate",
      intent: "Approved disposable hex-pocket-pattern acceptance", revision: state.revision,
    });
    const hexPatternPlateId = state.bodies.find((body: { name: string }) => body.name === "Disposable hex pocket pattern plate")?.id;
    requireCondition(Number.isInteger(hexPatternPlateId), "Hex-pocket-pattern plate creation did not return a Solid");
    const hexPocketPattern = await call(live.client, "plasticity_create_hex_nut_pocket_pattern", {
      targetId: hexPatternPlateId, entryCentersMm: [[160, 10, 8], [180, 10, 8]],
      axis: [0, 0, -1], flatNormalDirection: [1, 0, 0],
      acrossFlatsMm: 8, pocketDepthMm: 4, materialDepthMm: 8, overshootMm: 0.5,
      intent: "Approved disposable hex-pocket-pattern acceptance", revision: state.revision,
    });
    requireCondition(hexPocketPattern.pocketCount === 2 && hexPocketPattern.undoSteps === 5, "Hex nut pocket pattern did not report two pockets and five native steps");
    state = await call(live.client, "plasticity_status", {});
    requireCondition(hexPocketPattern.profileBodyIds.every((id: number) => state.bodies.some((body: { id: number; type: string }) => body.id === id && body.type === "Wire")), "Hex-pocket-pattern source profiles were not preserved as Wires");
    const afterHexPocketPattern = inspectHexPocketPattern(state, hexPatternPlateId);
    const hexPocketPatternValidation = await call(live.client, "plasticity_validate_bodies", { ids: [hexPatternPlateId], revision: state.revision });
    requireCondition(hexPocketPatternValidation.bodies[0]?.printableSolid === true, "Native B-Rep Check did not accept the hex-pocket-pattern plate as a closed printable Solid");
    for (let step = 0; step < 5; step += 1) {
      state = await call(live.client, "plasticity_undo", { intent: "Verify hex-pocket-pattern undo", revision: state.revision });
    }
    requireCondition(hexNutPocketPatternSideFaces(state, hexPatternPlateId).length === 0, "Undo retained hex-pocket-pattern faces");
    for (let step = 0; step < 5; step += 1) {
      state = await call(live.client, "plasticity_redo", { intent: "Verify hex-pocket-pattern redo", revision: state.revision });
    }
    const hexPocketPatternAfterRedo = inspectHexPocketPattern(state, hexPatternPlateId);

    state = await call(live.client, "plasticity_create_box", {
      originMm: [200, 0, 0], sizeMm: [40, 20, 8], name: "Disposable blind hole pattern plate",
      intent: "Approved disposable blind-hole-pattern acceptance", revision: state.revision,
    });
    const blindPatternPlateId = state.bodies.find((body: { name: string }) => body.name === "Disposable blind hole pattern plate")?.id;
    requireCondition(Number.isInteger(blindPatternPlateId), "Blind-hole-pattern plate creation did not return a Solid");
    const blindHolePattern = await call(live.client, "plasticity_create_blind_hole_pattern", {
      targetId: blindPatternPlateId, entryCentersMm: [[210, 10, 8], [230, 10, 8]], axis: [0, 0, -1],
      holeDiameterMm: 4.2, holeDepthMm: 5, materialDepthMm: 8, overshootMm: 0.5,
      intent: "Approved disposable qualified blind-hole-pattern acceptance", revision: state.revision,
    });
    requireCondition(blindHolePattern.holeCount === 2 && blindHolePattern.undoSteps === 3, "Blind hole pattern did not report two holes and three native steps");
    state = await call(live.client, "plasticity_status", {});
    const afterBlindHolePattern = inspectBlindHolePattern(state, blindPatternPlateId);
    const blindHolePatternValidation = await call(live.client, "plasticity_validate_bodies", { ids: [blindPatternPlateId], revision: state.revision });
    requireCondition(blindHolePatternValidation.bodies[0]?.printableSolid === true, "Native B-Rep Check did not accept the blind-hole-pattern plate as a closed printable Solid");
    for (let step = 0; step < 3; step += 1) {
      state = await call(live.client, "plasticity_undo", { intent: "Verify blind-hole-pattern undo", revision: state.revision });
    }
    requireCondition(blindHolePatternFaces(state, blindPatternPlateId).length === 0, "Undo retained blind-hole-pattern faces");
    for (let step = 0; step < 3; step += 1) {
      state = await call(live.client, "plasticity_redo", { intent: "Verify blind-hole-pattern redo", revision: state.revision });
    }
    const blindHolePatternAfterRedo = inspectBlindHolePattern(state, blindPatternPlateId);

    state = await call(live.client, "plasticity_create_box", {
      originMm: [250, 0, 0], sizeMm: [40, 20, 12], name: "Disposable insert pocket pattern plate",
      intent: "Approved disposable insert-pocket-pattern acceptance", revision: state.revision,
    });
    const insertPatternPlateId = state.bodies.find((body: { name: string }) => body.name === "Disposable insert pocket pattern plate")?.id;
    requireCondition(Number.isInteger(insertPatternPlateId), "Insert-pocket-pattern plate creation did not return a Solid");
    const insertPocketPattern = await call(live.client, "plasticity_create_heat_set_insert_pocket_pattern", {
      targetId: insertPatternPlateId, entryCentersMm: [[260, 10, 12], [280, 10, 12]], axis: [0, 0, -1],
      pilotDiameterMm: 3, pilotDepthMm: 8,
      insertDiameterMm: 4.6, insertDepthMm: 6,
      leadInDiameterMm: 5.4, leadInDepthMm: 1,
      materialDepthMm: 12, overshootMm: 0.5,
      intent: "Approved disposable qualified insert-pocket-pattern acceptance", revision: state.revision,
    });
    requireCondition(insertPocketPattern.pocketCount === 2 && insertPocketPattern.undoSteps === 7, "Insert pocket pattern did not report two pockets and seven native steps");
    state = await call(live.client, "plasticity_status", {});
    const afterInsertPocketPattern = inspectInsertPocketPattern(state, insertPatternPlateId);
    const insertPocketPatternValidation = await call(live.client, "plasticity_validate_bodies", { ids: [insertPatternPlateId], revision: state.revision });
    requireCondition(insertPocketPatternValidation.bodies[0]?.printableSolid === true, "Native B-Rep Check did not accept the insert-pocket-pattern plate as a closed printable Solid");
    for (let step = 0; step < 7; step += 1) {
      state = await call(live.client, "plasticity_undo", { intent: "Verify insert-pocket-pattern undo", revision: state.revision });
    }
    requireCondition(insertPocketPatternFaces(state, insertPatternPlateId).length === 0, "Undo retained insert-pocket-pattern faces");
    for (let step = 0; step < 7; step += 1) {
      state = await call(live.client, "plasticity_redo", { intent: "Verify insert-pocket-pattern redo", revision: state.revision });
    }
    const insertPocketPatternAfterRedo = inspectInsertPocketPattern(state, insertPatternPlateId);

    state = await call(live.client, "plasticity_create_box", {
      originMm: [300, 0, 0], sizeMm: [50, 30, 4], name: "Disposable screw boss pattern support",
      intent: "Approved disposable screw-boss-pattern acceptance", revision: state.revision,
    });
    const bossPatternSupportId = state.bodies.find((body: { name: string }) => body.name === "Disposable screw boss pattern support")?.id;
    requireCondition(Number.isInteger(bossPatternSupportId), "Screw-boss-pattern support creation did not return a Solid");
    const screwBossPattern = await call(live.client, "plasticity_create_screw_boss_pattern", {
      targetId: bossPatternSupportId, baseCentersMm: [[312, 15, 4], [338, 15, 4]], axis: [0, 0, 1],
      outerDiameterMm: 10, heightMm: 10, holeDiameterMm: 3, holeDepthMm: 8,
      baseOverlapMm: 0.5, cutterOvershootMm: 0.5,
      intent: "Approved disposable qualified screw-boss-pattern acceptance", revision: state.revision,
    });
    requireCondition(screwBossPattern.bossCount === 2 && screwBossPattern.undoSteps === 6, "Screw boss pattern did not report two bosses and six native steps");
    state = await call(live.client, "plasticity_status", {});
    const afterScrewBossPattern = inspectScrewBossPattern(state, bossPatternSupportId);
    const screwBossPatternValidation = await call(live.client, "plasticity_validate_bodies", { ids: [bossPatternSupportId], revision: state.revision });
    requireCondition(screwBossPatternValidation.bodies[0]?.printableSolid === true, "Native B-Rep Check did not accept the screw-boss-pattern support as a closed printable Solid");
    for (let step = 0; step < 6; step += 1) {
      state = await call(live.client, "plasticity_undo", { intent: "Verify screw-boss-pattern undo", revision: state.revision });
    }
    requireCondition(screwBossPatternFaces(state, bossPatternSupportId).length === 0, "Undo retained screw-boss-pattern faces");
    for (let step = 0; step < 6; step += 1) {
      state = await call(live.client, "plasticity_redo", { intent: "Verify screw-boss-pattern redo", revision: state.revision });
    }
    const screwBossPatternAfterRedo = inspectScrewBossPattern(state, bossPatternSupportId);

    state = await call(live.client, "plasticity_create_box", {
      originMm: [360, 0, 0], sizeMm: [50, 40, 8], name: "Disposable slotted hole pattern plate",
      intent: "Approved disposable slotted-hole-pattern acceptance", revision: state.revision,
    });
    const slotPatternPlateId = state.bodies.find((body: { name: string }) => body.name === "Disposable slotted hole pattern plate")?.id;
    requireCondition(Number.isInteger(slotPatternPlateId), "Slotted-hole-pattern plate creation did not return a Solid");
    const slottedHolePattern = await call(live.client, "plasticity_create_slotted_hole_pattern", {
      targetId: slotPatternPlateId, entryCentersMm: [[385, 10, 8], [385, 30, 8]],
      axis: [0, 0, -1], slotDirection: [1, 0, 0],
      overallLengthMm: 20, widthMm: 6, throughDepthMm: 8, overshootMm: 0.5,
      intent: "Approved disposable qualified slotted-hole-pattern acceptance", revision: state.revision,
    });
    requireCondition(slottedHolePattern.slotCount === 2 && slottedHolePattern.undoSteps === 9, "Slotted hole pattern did not report two slots and nine native steps");
    near(slottedHolePattern.centerDistanceMm, 14, 1e-9, "slot pattern center distance");
    state = await call(live.client, "plasticity_status", {});
    requireCondition(slottedHolePattern.profileBodyIds.every((id: number) => state.bodies.some((body: { id: number; type: string }) => body.id === id && body.type === "Wire")), "Slotted-hole-pattern source profiles were not preserved as Wires");
    const afterSlottedHolePattern = inspectSlottedHolePattern(state, slotPatternPlateId);
    const slottedHolePatternValidation = await call(live.client, "plasticity_validate_bodies", { ids: [slotPatternPlateId], revision: state.revision });
    requireCondition(slottedHolePatternValidation.bodies[0]?.printableSolid === true, "Native B-Rep Check did not accept the slotted-hole-pattern plate as a closed printable Solid");
    for (let step = 0; step < 9; step += 1) {
      state = await call(live.client, "plasticity_undo", { intent: "Verify slotted-hole-pattern undo", revision: state.revision });
    }
    requireCondition(slottedHolePatternCylinderFaces(state, slotPatternPlateId).length === 0, "Undo retained slotted-hole-pattern end faces");
    for (let step = 0; step < 9; step += 1) {
      state = await call(live.client, "plasticity_redo", { intent: "Verify slotted-hole-pattern redo", revision: state.revision });
    }
    const slottedHolePatternAfterRedo = inspectSlottedHolePattern(state, slotPatternPlateId);

    const throughHole = await call(live.client, "plasticity_create_through_hole", {
      targetId: plateId, entryCenterMm: [20, 25, 8], axis: [0, 0, -1],
      holeDiameterMm: 5.5, throughDepthMm: 8, overshootMm: 0.5,
      intent: "Approved disposable dedicated through-hole acceptance", revision: state.revision,
    });
    requireCondition(throughHole.undoSteps === 2, "Through-hole did not report two native history steps");
    state = await call(live.client, "plasticity_status", {});
    const afterThroughHole = inspectThroughHole(state, plateId);
    const throughValidation = await call(live.client, "plasticity_validate_bodies", { ids: [plateId], revision: state.revision });
    requireCondition(throughValidation.bodies[0]?.printableSolid === true, "Native B-Rep Check did not accept the through-hole plate as a closed printable Solid");
    state = await call(live.client, "plasticity_undo", { intent: "Verify through-hole undo", revision: state.revision });
    requireCondition(throughHoleFaces(state, plateId).length === 0, "Undo retained the dedicated through-hole");
    state = await call(live.client, "plasticity_redo", { intent: "Verify through-hole redo", revision: state.revision });
    const throughHoleAfterRedo = inspectThroughHole(state, plateId);

    const blindHole = await call(live.client, "plasticity_create_blind_hole", {
      targetId: plateId, entryCenterMm: [5, 25, 8], axis: [0, 0, -1],
      holeDiameterMm: 4.2, holeDepthMm: 5, materialDepthMm: 8, overshootMm: 0.5,
      intent: "Approved disposable qualified blind-hole acceptance", revision: state.revision,
    });
    requireCondition(blindHole.undoSteps === 2, "Blind hole did not report two native history steps");
    state = await call(live.client, "plasticity_status", {});
    const afterBlindHole = inspectBlindHole(state, plateId);
    const blindValidation = await call(live.client, "plasticity_validate_bodies", { ids: [plateId], revision: state.revision });
    requireCondition(blindValidation.bodies[0]?.printableSolid === true, "Native B-Rep Check did not accept the blind-hole plate as a closed printable Solid");
    state = await call(live.client, "plasticity_undo", { intent: "Verify blind-hole undo", revision: state.revision });
    requireCondition(blindHoleFaces(state, plateId).length === 0, "Undo retained the dedicated blind hole");
    state = await call(live.client, "plasticity_redo", { intent: "Verify blind-hole redo", revision: state.revision });
    const blindHoleAfterRedo = inspectBlindHole(state, plateId);

    const countersink = await call(live.client, "plasticity_create_countersink", {
      targetId: plateId, entryCenterMm: [12, 15, 8], axis: [0, 0, -1], radialDirection: [1, 0, 0],
      throughDiameterMm: 5.5, countersinkMajorDiameterMm: 10.4, includedAngleDeg: 90,
      throughDepthMm: 8, overshootMm: 0.5,
      intent: "Approved disposable countersink acceptance", revision: state.revision,
    });
    near(countersink.countersinkDepthMm, 2.45, 1e-9, "derived countersink depth");
    requireCondition(countersink.undoSteps === 4, "Countersink did not report four native history steps");
    state = await call(live.client, "plasticity_status", {});
    requireCondition(state.bodies.find((body: { id: number; type: string }) => body.id === countersink.profileBodyId && body.type === "Wire"), "Countersink source profile was not preserved as a Wire");
    const afterCountersink = inspectCountersink(state, plateId);

    const pocket = await call(live.client, "plasticity_create_hex_nut_pocket", {
      targetId: plateId, entryCenterMm: [28, 15, 8], axis: [0, 0, -1], flatNormalDirection: [1, 0, 0],
      acrossFlatsMm: 8, pocketDepthMm: 4, materialDepthMm: 8, overshootMm: 0.5,
      intent: "Approved disposable hex nut pocket acceptance", revision: state.revision,
    });
    requireCondition(pocket.undoSteps === 3, "Hex nut pocket did not report three native history steps");
    state = await call(live.client, "plasticity_status", {});
    requireCondition(state.bodies.find((body: { id: number; type: string }) => body.id === pocket.profileBodyId && body.type === "Wire"), "Hex nut pocket source profile was not preserved as a Wire");
    const afterPocket = inspectHexPocket(state, plateId);
    const validation = await call(live.client, "plasticity_validate_bodies", { ids: [plateId], revision: state.revision });
    requireCondition(validation.bodies[0]?.printableSolid === true, "Native B-Rep Check did not accept the plate as a closed printable Solid");

    state = await call(live.client, "plasticity_undo", { intent: "Verify hex pocket undo", revision: state.revision });
    const afterUndo = inspectCountersink(state, plateId);
    requireCondition(hexPocketSideFaces(state, plateId).length === 0, "Undo retained hex pocket side faces");
    state = await call(live.client, "plasticity_redo", { intent: "Verify hex pocket redo", revision: state.revision });
    const afterRedo = inspectHexPocket(state, plateId);

    const slot = await call(live.client, "plasticity_create_slotted_hole", {
      targetId: plateId, entryCenterMm: [20, 5, 8], axis: [0, 0, -1], slotDirection: [1, 0, 0],
      overallLengthMm: 20, widthMm: 6, throughDepthMm: 8, overshootMm: 0.5,
      intent: "Approved disposable slotted-hole acceptance", revision: state.revision,
    });
    requireCondition(slot.undoSteps === 5, "Slotted hole did not report five native history steps");
    near(slot.centerDistanceMm, 14, 1e-9, "slot center distance");
    state = await call(live.client, "plasticity_status", {});
    requireCondition(state.bodies.find((body: { id: number; type: string }) => body.id === slot.profileBodyId && body.type === "Wire"), "Slotted-hole source profile was not preserved as a Wire");
    const afterSlot = inspectSlottedHole(state, plateId);
    const slotValidation = await call(live.client, "plasticity_validate_bodies", { ids: [plateId], revision: state.revision });
    requireCondition(slotValidation.bodies[0]?.printableSolid === true, "Native B-Rep Check did not accept the slotted plate as a closed printable Solid");

    state = await call(live.client, "plasticity_undo", { intent: "Verify slotted-hole undo", revision: state.revision });
    requireCondition(slotCylinderFaces(state, plateId).length === 0, "Undo retained the slotted-hole end faces in the target");
    state = await call(live.client, "plasticity_redo", { intent: "Verify slotted-hole redo", revision: state.revision });
    const slotAfterRedo = inspectSlottedHole(state, plateId);

    evidence.designation = {
      normalizedDesignation: resolved.normalizedDesignation,
      headStyle: resolved.headStyle,
      route: resolved.workflow.route,
      fixedRequestExcludesSlot: true,
      adjustableRequestIncludesSlot: true,
      adjustableGroupIncludesSlotPattern: true,
      tappedRequestIncludesBlindHole: true,
      tappedGroupIncludesBlindHolePattern: true,
      insertGroupIncludesPocketAndClearancePatterns: true,
      printedPlasticGroupIncludesScrewBossPattern: true,
      socketGroupIncludesCounterborePattern: true,
      countersunkGroupIncludesCountersinkPattern: true,
      nutGroupIncludesHexPocketPattern: true,
      defaultAnalysisIntent: strengthFirst.analysisIntent,
      firstQuestionPackage: strengthFirst.nextQuestionPackage.id,
      firstQuestionCount: strengthFirst.nextQuestionPackage.questions.length,
    };
    evidence.throughHole = afterThroughHole;
    evidence.counterborePattern = { ...afterCounterborePattern, holeCount: counterborePattern.holeCount, undoSteps: counterborePattern.undoSteps };
    evidence.countersinkPattern = { ...afterCountersinkPattern, holeCount: countersinkPattern.holeCount, depthMm: countersinkPattern.countersinkDepthMm, profileBodyIds: countersinkPattern.profileBodyIds, undoSteps: countersinkPattern.undoSteps };
    evidence.hexNutPocketPattern = { ...afterHexPocketPattern, pocketCount: hexPocketPattern.pocketCount, profileBodyIds: hexPocketPattern.profileBodyIds, undoSteps: hexPocketPattern.undoSteps };
    evidence.blindHolePattern = { ...afterBlindHolePattern, holeCount: blindHolePattern.holeCount, undoSteps: blindHolePattern.undoSteps };
    evidence.heatSetInsertPocketPattern = { ...afterInsertPocketPattern, pocketCount: insertPocketPattern.pocketCount, undoSteps: insertPocketPattern.undoSteps };
    evidence.screwBossPattern = { ...afterScrewBossPattern, bossCount: screwBossPattern.bossCount, undoSteps: screwBossPattern.undoSteps };
    evidence.slottedHolePattern = { ...afterSlottedHolePattern, slotCount: slottedHolePattern.slotCount, centerDistanceMm: slottedHolePattern.centerDistanceMm, profileBodyIds: slottedHolePattern.profileBodyIds, undoSteps: slottedHolePattern.undoSteps };
    evidence.blindHole = afterBlindHole;
    evidence.countersink = { ...afterCountersink, depthMm: countersink.countersinkDepthMm, profileBodyId: countersink.profileBodyId };
    evidence.hexNutPocket = { ...afterPocket, profileBodyId: pocket.profileBodyId };
    evidence.slottedHole = { ...afterSlot, centerDistanceMm: slot.centerDistanceMm, profileBodyId: slot.profileBodyId };
    evidence.history = {
      undoPreservedCountersink: Number(afterUndo.conicalFaceCount) > 0,
      undoRemovedThroughHoleFromTarget: true,
      redoThroughHoleFaceCount: throughHoleAfterRedo.cylinderFaceCount,
      undoRemovedBlindHoleFromTarget: true,
      redoBlindHoleFaceCount: blindHoleAfterRedo.cylinderFaceCount,
      redoHexSideFaceCount: afterRedo.sideFaceCount,
      undoRemovedSlotFromTarget: true,
      redoSlotCylinderFaceCount: slotAfterRedo.cylinderFaceCount,
      undoRemovedCounterborePatternFromTarget: true,
      redoCounterborePatternRecessFaceCount: counterborePatternAfterRedo.recessFaceCount,
      undoRemovedCountersinkPatternFromTarget: true,
      redoCountersinkPatternConicalFaceCount: countersinkPatternAfterRedo.conicalFaceCount,
      undoRemovedHexPocketPatternFromTarget: true,
      redoHexPocketPatternSideFaceCount: hexPocketPatternAfterRedo.sideFaceCount,
      undoRemovedBlindHolePatternFromTarget: true,
      redoBlindHolePatternCylinderFaceCount: blindHolePatternAfterRedo.cylinderFaceCount,
      undoRemovedInsertPocketPatternFromTarget: true,
      redoInsertPocketPatternCylinderFaceCount: insertPocketPatternAfterRedo.cylinderFaceCount,
      undoRemovedScrewBossPatternFromTarget: true,
      redoScrewBossPatternCylinderFaceCount: screwBossPatternAfterRedo.cylinderFaceCount,
      undoRemovedSlottedHolePatternFromTarget: true,
      redoSlottedHolePatternCylinderFaceCount: slottedHolePatternAfterRedo.cylinderFaceCount,
    };
    evidence.validation = { afterCounterborePattern: counterborePatternValidation, afterCountersinkPattern: countersinkPatternValidation, afterHexPocketPattern: hexPocketPatternValidation, afterBlindHolePattern: blindHolePatternValidation, afterInsertPocketPattern: insertPocketPatternValidation, afterScrewBossPattern: screwBossPatternValidation, afterSlottedHolePattern: slottedHolePatternValidation, afterThroughHole: throughValidation, afterBlindHole: blindValidation, afterHexPocket: validation, afterSlottedHole: slotValidation };

    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCleanJournal(journal);
    for (let step = 0; step < 66; step += 1) {
      state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable fastener-pocket acceptance", revision: state.revision });
    }
    requireCondition(state.documentToken === initialState.documentToken && state.bodies.length === 0, "Cleanup did not restore the empty document");
    const finalJournal = await call(live.client, "plasticity_construction_journal", {});
    requireCleanJournal(finalJournal);
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = {
      restoredEmptyDocument: true,
      sceneContentsRestored: true,
      journalSyncStatus: finalJournal.syncStatus,
      uncertainJournalEntries: finalJournal.entries.filter((entry: { status: string }) => entry.status === "unknown").length,
    };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json") }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    if (live && initialState && !evidence.cleanup) {
      evidence.cleanup = await recover(live.client, initialState).catch((cleanupError) => ({ restoredEmptyDocument: false, reason: boundedError(cleanupError) }));
    }
    await writeExclusive(join(output, "failure.json"), sanitizeEvidence(evidence)).catch(() => {});
    throw error;
  } finally {
    await live?.client.close().catch(() => {});
  }
}

function inspectCounterborePattern(state: any, plateId: number): Record<string, number> {
  const plate = state.bodies.find((body: { id: number }) => body.id === plateId);
  requireCondition(plate?.type === "Solid", "Counterbore-pattern result is not the original Solid");
  const faces = counterborePatternFaces(state, plateId);
  const throughFaces = faces.filter((face: any) => Math.abs(face.radiusMm - 2) <= 0.01);
  const recessFaces = faces.filter((face: any) => Math.abs(face.radiusMm - 4) <= 0.01);
  requireCondition(throughFaces.length === 2, `Expected two exact R2 through walls, found ${throughFaces.length}`);
  requireCondition(recessFaces.length === 2, `Expected two exact R4 counterbore walls, found ${recessFaces.length}`);
  for (const face of throughFaces) {
    requireCondition(face.boundsMm.min[2] <= 0.01 && Math.abs(face.boundsMm.max[2] - 5) <= 0.01, "Counterbore-pattern through wall does not span the remaining 5 mm material");
  }
  for (const face of recessFaces) {
    requireCondition(Math.abs(face.boundsMm.min[2] - 5) <= 0.01 && face.boundsMm.max[2] >= 7.99, "Counterbore-pattern recess wall is not exactly 3 mm deep");
  }
  const expectedCenters: Array<[number, number]> = [[60, 10], [80, 10]];
  for (const face of [...throughFaces, ...recessFaces]) {
    requireCondition(expectedCenters.some(([x, y]) => Math.abs(face.axisOriginMm[0] - x) <= 0.01 && Math.abs(face.axisOriginMm[1] - y) <= 0.01), `Unexpected counterbore-pattern center ${JSON.stringify(face.axisOriginMm)}`);
  }
  return { throughFaceCount: throughFaces.length, recessFaceCount: recessFaces.length };
}

function counterborePatternFaces(state: any, plateId: number): any[] {
  const plate = state.bodies.find((body: { id: number }) => body.id === plateId);
  return plate?.faces.filter((face: any) => face.surfaceType === "Cylinder"
    && face.radiusMm !== null
    && (Math.abs(face.radiusMm - 2) <= 0.01 || Math.abs(face.radiusMm - 4) <= 0.01)) ?? [];
}

function inspectCountersinkPattern(state: any, plateId: number): Record<string, number> {
  const plate = state.bodies.find((body: { id: number }) => body.id === plateId);
  requireCondition(plate?.type === "Solid", "Countersink-pattern result is not the original Solid");
  const faces = countersinkPatternFaces(state, plateId);
  const conicalFaces = faces.filter((face: any) => /cone/i.test(face.surfaceType));
  const boreFaces = faces.filter((face: any) => face.surfaceType === "Cylinder" && face.radiusMm !== null && Math.abs(face.radiusMm - 2.75) <= 0.01);
  requireCondition(conicalFaces.length === 2, `Expected two native conical countersink faces, found ${conicalFaces.length}`);
  requireCondition(boreFaces.length === 2, `Expected two exact R2.75 through walls, found ${boreFaces.length}`);
  const expectedCenters: Array<[number, number]> = [[110, 10], [130, 10]];
  for (const [x, y] of expectedCenters) {
    const bore = boreFaces.find((face: any) => face.axisOriginMm
      && Math.abs(face.axisOriginMm[0] - x) <= 0.01
      && Math.abs(face.axisOriginMm[1] - y) <= 0.01);
    requireCondition(bore, `No exact grouped countersink bore was found at ${x},${y}`);
    requireCondition(bore.boundsMm.min[2] <= 0.01 && Math.abs(bore.boundsMm.max[2] - 5.55) <= 0.01, `Grouped countersink bore at ${x},${y} has the wrong axial span`);
  }
  const majorEdges = plate.edges.filter((edge: any) => edge.circle && Math.abs(edge.lengthMm - Math.PI * 10.4) <= 0.01);
  requireCondition(majorEdges.length === 2, `Expected two exact Ø10.4 countersink entry edges, found ${majorEdges.length}`);
  return { conicalFaceCount: conicalFaces.length, boreFaceCount: boreFaces.length, majorEdgeCount: majorEdges.length };
}

function countersinkPatternFaces(state: any, plateId: number): any[] {
  const plate = state.bodies.find((body: { id: number }) => body.id === plateId);
  if (!plate) return [];
  return plate.faces.filter((face: any) => /cone/i.test(face.surfaceType)
    || (face.surfaceType === "Cylinder" && face.radiusMm !== null && Math.abs(face.radiusMm - 2.75) <= 0.01));
}

function inspectHexPocketPattern(state: any, plateId: number): Record<string, number> {
  const plate = state.bodies.find((body: { id: number }) => body.id === plateId);
  requireCondition(plate?.type === "Solid", "Hex-pocket-pattern result is not the original Solid");
  const sideFaces = hexNutPocketPatternSideFaces(state, plateId);
  requireCondition(sideFaces.length === 12, `Expected twelve native hex-pocket side faces, found ${sideFaces.length}`);
  const centers: Array<[number, number]> = [[160, 10], [180, 10]];
  for (const face of sideFaces) {
    const center = centers.reduce((closest, candidate) =>
      Math.hypot(face.centerMm[0] - candidate[0], face.centerMm[1] - candidate[1])
        < Math.hypot(face.centerMm[0] - closest[0], face.centerMm[1] - closest[1]) ? candidate : closest);
    const offset = Math.abs((face.centerMm[0] - center[0]) * face.normal[0] + (face.centerMm[1] - center[1]) * face.normal[1]);
    near(offset, 4, 0.01, `grouped hex pocket face ${face.id} across-flats half-distance`);
  }
  const sideLength = 8 / Math.sqrt(3);
  const hexEdges = plate.edges.filter((edge: any) => edge.line && Math.abs(edge.lengthMm - sideLength) <= 0.01);
  requireCondition(hexEdges.length >= 12, `Expected at least twelve exact grouped hex edges, found ${hexEdges.length}`);
  const floorFaces = plate.faces.filter((face: any) => face.planar
    && Math.abs(Math.abs(face.normal[2]) - 1) <= 1e-6
    && Math.abs(face.centerMm[2] - 4) <= 0.01
    && centers.some(([x, y]) => Math.hypot(face.centerMm[0] - x, face.centerMm[1] - y) < 5));
  requireCondition(floorFaces.length === 2, `Expected two exact 4 mm deep grouped hex-pocket floors, found ${floorFaces.length}`);
  return { sideFaceCount: sideFaces.length, exactSideEdgeCount: hexEdges.length, floorFaceCount: floorFaces.length };
}

function hexNutPocketPatternSideFaces(state: any, plateId: number): any[] {
  const plate = state.bodies.find((body: { id: number }) => body.id === plateId);
  if (!plate) return [];
  const centers: Array<[number, number]> = [[160, 10], [180, 10]];
  return plate.faces.filter((face: any) => face.planar
    && Math.abs(face.normal[2]) <= 1e-6
    && face.centerMm[2] > 3.9 && face.centerMm[2] < 8.1
    && centers.some(([x, y]) => Math.hypot(face.centerMm[0] - x, face.centerMm[1] - y) < 6));
}

function inspectThroughHole(state: any, plateId: number): Record<string, number> {
  const plate = state.bodies.find((body: { id: number }) => body.id === plateId);
  requireCondition(plate?.type === "Solid", "Through-hole result is not the original Solid");
  const cylinders = throughHoleFaces(state, plateId);
  requireCondition(cylinders.length === 1, `Expected one exact dedicated through-hole face, found ${cylinders.length}`);
  const face = cylinders[0];
  requireCondition(face.boundsMm.min[2] <= 0.01 && face.boundsMm.max[2] >= 7.99, "Dedicated through-hole is not through the 8 mm plate");
  const edges = plate.edges.filter((edge: any) => edge.circle
    && Math.abs(edge.lengthMm - Math.PI * 5.5) <= 0.01
    && face.edgeIds.includes(edge.id));
  requireCondition(edges.length === 2, `Expected two exact Ø5.5 through-hole edges, found ${edges.length}`);
  return { cylinderFaceCount: cylinders.length, exactCircularEdgeCount: edges.length };
}

function throughHoleFaces(state: any, plateId: number): any[] {
  const plate = state.bodies.find((body: { id: number }) => body.id === plateId);
  if (!plate) return [];
  return plate.faces.filter((face: any) => face.surfaceType === "Cylinder"
    && face.radiusMm !== null && Math.abs(face.radiusMm - 2.75) <= 0.01
    && face.axisOriginMm && Math.hypot(face.axisOriginMm[0] - 20, face.axisOriginMm[1] - 25) <= 0.01
    && face.axisDirection && Math.abs(Math.abs(face.axisDirection[2]) - 1) <= 1e-6);
}

function inspectBlindHole(state: any, plateId: number): Record<string, number> {
  const plate = state.bodies.find((body: { id: number }) => body.id === plateId);
  requireCondition(plate?.type === "Solid", "Blind-hole result is not the original Solid");
  const cylinders = blindHoleFaces(state, plateId);
  requireCondition(cylinders.length === 1, `Expected one exact dedicated blind-hole face, found ${cylinders.length}`);
  const face = cylinders[0];
  requireCondition(face.boundsMm.min[2] >= 2.99 && face.boundsMm.min[2] <= 3.01 && face.boundsMm.max[2] >= 7.99, "Blind hole does not end at the exact 5 mm depth");
  const edges = plate.edges.filter((edge: any) => edge.circle
    && Math.abs(edge.lengthMm - Math.PI * 4.2) <= 0.01
    && face.edgeIds.includes(edge.id));
  requireCondition(edges.length === 2, `Expected two exact Ø4.2 blind-hole edges, found ${edges.length}`);
  const floors = plate.faces.filter((candidate: any) => candidate.planar
    && Math.hypot(candidate.centerMm[0] - 5, candidate.centerMm[1] - 25) <= 0.01
    && Math.abs(candidate.centerMm[2] - 3) <= 0.01
    && Math.abs(Math.abs(candidate.normal[2]) - 1) <= 1e-6);
  requireCondition(floors.length === 1, `Expected one exact blind-hole floor at Z=3 mm, found ${floors.length}`);
  return { cylinderFaceCount: cylinders.length, exactCircularEdgeCount: edges.length, floorFaceCount: floors.length };
}

function inspectBlindHolePattern(state: any, plateId: number): Record<string, number> {
  const plate = state.bodies.find((body: { id: number }) => body.id === plateId);
  requireCondition(plate?.type === "Solid", "Blind-hole-pattern result is not the original Solid");
  const cylinders = blindHolePatternFaces(state, plateId);
  requireCondition(cylinders.length === 2, `Expected two exact blind-hole-pattern cylinder faces, found ${cylinders.length}`);
  for (const centerX of [210, 230]) {
    const face = cylinders.find((candidate: any) => candidate.axisOriginMm && Math.abs(candidate.axisOriginMm[0] - centerX) <= 0.01);
    requireCondition(face, `No exact R2.1 blind-hole cylinder was found at X=${centerX} mm`);
    requireCondition(face.boundsMm.min[2] >= 2.99 && face.boundsMm.min[2] <= 3.01 && face.boundsMm.max[2] >= 7.99, `Blind hole at X=${centerX} mm does not end at the exact 5 mm depth`);
  }
  const exactEdges = plate.edges.filter((edge: any) => edge.circle
    && Math.abs(edge.lengthMm - Math.PI * 4.2) <= 0.01
    && cylinders.some((face: any) => face.edgeIds.includes(edge.id)));
  requireCondition(exactEdges.length === 4, `Expected four exact Ø4.2 blind-hole-pattern edges, found ${exactEdges.length}`);
  const floors = plate.faces.filter((face: any) => face.planar
    && [210, 230].some((centerX) => Math.hypot(face.centerMm[0] - centerX, face.centerMm[1] - 10) <= 0.01)
    && Math.abs(face.centerMm[2] - 3) <= 0.01
    && Math.abs(Math.abs(face.normal[2]) - 1) <= 1e-6);
  requireCondition(floors.length === 2, `Expected two exact blind-hole-pattern floors at Z=3 mm, found ${floors.length}`);
  return { cylinderFaceCount: cylinders.length, exactCircularEdgeCount: exactEdges.length, floorFaceCount: floors.length };
}

function blindHolePatternFaces(state: any, plateId: number): any[] {
  const plate = state.bodies.find((body: { id: number }) => body.id === plateId);
  if (!plate) return [];
  return plate.faces.filter((face: any) => face.surfaceType === "Cylinder"
    && face.radiusMm !== null && Math.abs(face.radiusMm - 2.1) <= 0.01
    && face.axisOriginMm && [210, 230].some((centerX) => Math.hypot(face.axisOriginMm[0] - centerX, face.axisOriginMm[1] - 10) <= 0.01)
    && face.axisDirection && Math.abs(Math.abs(face.axisDirection[2]) - 1) <= 1e-6);
}

function inspectInsertPocketPattern(state: any, plateId: number): Record<string, number> {
  const plate = state.bodies.find((body: { id: number }) => body.id === plateId);
  requireCondition(plate?.type === "Solid", "Insert-pocket-pattern result is not the original Solid");
  const cylinders = insertPocketPatternFaces(state, plateId);
  requireCondition(cylinders.length === 6, `Expected six exact insert-pocket-pattern cylinder faces, found ${cylinders.length}`);
  const stages = [
    { radiusMm: 1.5, minZ: 4, maxZ: 6 },
    { radiusMm: 2.3, minZ: 6, maxZ: 11 },
    { radiusMm: 2.7, minZ: 11, maxZ: 12 },
  ];
  for (const centerX of [260, 280]) {
    for (const stage of stages) {
      const face = cylinders.find((candidate: any) => candidate.axisOriginMm
        && Math.abs(candidate.axisOriginMm[0] - centerX) <= 0.01
        && Math.abs(candidate.radiusMm - stage.radiusMm) <= 0.01);
      requireCondition(face, `No exact R${stage.radiusMm} insert-pocket wall was found at X=${centerX} mm`);
      requireCondition(Math.abs(face.boundsMm.min[2] - stage.minZ) <= 0.01 && Math.abs(face.boundsMm.max[2] - stage.maxZ) <= 0.01, `Insert-pocket stage R${stage.radiusMm} at X=${centerX} has unexpected depth bounds`);
    }
  }
  const exactEdges = plate.edges.filter((edge: any) => edge.circle
    && [3, 4.6, 5.4].some((diameter) => Math.abs(edge.lengthMm - Math.PI * diameter) <= 0.01)
    && cylinders.some((face: any) => face.edgeIds.includes(edge.id)));
  requireCondition(exactEdges.length === 12, `Expected twelve exact insert-pocket-pattern circular edges, found ${exactEdges.length}`);
  const floors = plate.faces.filter((face: any) => face.planar
    && [260, 280].some((centerX) => Math.hypot(face.centerMm[0] - centerX, face.centerMm[1] - 10) <= 0.01)
    && Math.abs(face.centerMm[2] - 4) <= 0.01
    && Math.abs(Math.abs(face.normal[2]) - 1) <= 1e-6);
  requireCondition(floors.length === 2, `Expected two exact insert-pocket-pattern floors at Z=4 mm, found ${floors.length}`);
  return { cylinderFaceCount: cylinders.length, exactCircularEdgeCount: exactEdges.length, floorFaceCount: floors.length };
}

function inspectScrewBossPattern(state: any, supportId: number): Record<string, number> {
  const support = state.bodies.find((body: { id: number }) => body.id === supportId);
  requireCondition(support?.type === "Solid", "Screw-boss-pattern result is not the original Solid");
  const cylinders = screwBossPatternFaces(state, supportId);
  const outerFaces = cylinders.filter((face: any) => Math.abs(face.radiusMm - 5) <= 0.01);
  const pilotFaces = cylinders.filter((face: any) => Math.abs(face.radiusMm - 1.5) <= 0.01);
  requireCondition(outerFaces.length === 2, `Expected two exact R5 screw-boss walls, found ${outerFaces.length}`);
  requireCondition(pilotFaces.length === 2, `Expected two exact R1.5 screw-boss pilot walls, found ${pilotFaces.length}`);
  for (const centerX of [312, 338]) {
    const outer = outerFaces.find((face: any) => face.axisOriginMm && Math.abs(face.axisOriginMm[0] - centerX) <= 0.01);
    const pilot = pilotFaces.find((face: any) => face.axisOriginMm && Math.abs(face.axisOriginMm[0] - centerX) <= 0.01);
    requireCondition(outer, `No exact R5 boss wall was found at X=${centerX} mm`);
    requireCondition(pilot, `No exact R1.5 pilot wall was found at X=${centerX} mm`);
    requireCondition(Math.abs(outer.boundsMm.min[2] - 4) <= 0.01 && Math.abs(outer.boundsMm.max[2] - 14) <= 0.01, `Boss at X=${centerX} has unexpected axial bounds`);
    requireCondition(Math.abs(pilot.boundsMm.min[2] - 6) <= 0.01 && Math.abs(pilot.boundsMm.max[2] - 14) <= 0.01, `Pilot at X=${centerX} has unexpected axial bounds`);
  }
  const floors = support.faces.filter((face: any) => face.planar
    && [312, 338].some((centerX) => Math.hypot(face.centerMm[0] - centerX, face.centerMm[1] - 15) <= 0.01)
    && Math.abs(face.centerMm[2] - 6) <= 0.01
    && Math.abs(Math.abs(face.normal[2]) - 1) <= 1e-6);
  requireCondition(floors.length === 2, `Expected two exact screw-boss pilot floors at Z=6 mm, found ${floors.length}`);
  return { cylinderFaceCount: cylinders.length, outerFaceCount: outerFaces.length, pilotFaceCount: pilotFaces.length, floorFaceCount: floors.length };
}

function screwBossPatternFaces(state: any, supportId: number): any[] {
  const support = state.bodies.find((body: { id: number }) => body.id === supportId);
  if (!support) return [];
  return support.faces.filter((face: any) => face.surfaceType === "Cylinder"
    && face.radiusMm !== null && [1.5, 5].some((radius) => Math.abs(face.radiusMm - radius) <= 0.01)
    && face.axisOriginMm && [312, 338].some((centerX) => Math.hypot(face.axisOriginMm[0] - centerX, face.axisOriginMm[1] - 15) <= 0.01)
    && face.axisDirection && Math.abs(Math.abs(face.axisDirection[2]) - 1) <= 1e-6);
}

function inspectSlottedHolePattern(state: any, plateId: number): Record<string, number> {
  const plate = state.bodies.find((body: { id: number }) => body.id === plateId);
  requireCondition(plate?.type === "Solid", "Slotted-hole-pattern result is not the original Solid");
  const cylinders = slottedHolePatternCylinderFaces(state, plateId);
  requireCondition(cylinders.length === 4, `Expected four exact slotted-hole-pattern end faces, found ${cylinders.length}`);
  const expectedEnds: Array<[number, number]> = [[378, 10], [392, 10], [378, 30], [392, 30]];
  for (const [x, y] of expectedEnds) {
    const face = cylinders.find((candidate: any) => candidate.axisOriginMm
      && Math.abs(candidate.axisOriginMm[0] - x) <= 0.01
      && Math.abs(candidate.axisOriginMm[1] - y) <= 0.01);
    requireCondition(face, `No exact R3 grouped slot end was found at ${x},${y}`);
    requireCondition(face.boundsMm.min[2] <= 0.01 && face.boundsMm.max[2] >= 7.99, `Grouped slot end at ${x},${y} is not through the 8 mm plate`);
  }
  const expectedWalls: Array<[number, number]> = [[385, 7], [385, 13], [385, 27], [385, 33]];
  const straightFaces = plate.faces.filter((face: any) => face.planar
    && expectedWalls.some(([x, y]) => Math.abs(face.centerMm[0] - x) <= 0.01 && Math.abs(face.centerMm[1] - y) <= 0.01)
    && Math.abs(face.centerMm[2] - 4) <= 0.01
    && Math.abs(face.normal[2]) <= 1e-6);
  requireCondition(straightFaces.length === 4, `Expected four exact grouped slot walls, found ${straightFaces.length}`);
  const straightEdges = plate.edges.filter((edge: any) => edge.line
    && Math.abs(edge.lengthMm - 14) <= 0.01
    && [7, 13, 27, 33].some((y) => Math.abs(edge.centerMm[1] - y) <= 0.01));
  requireCondition(straightEdges.length === 8, `Expected eight exact 14 mm grouped slot edges, found ${straightEdges.length}`);
  return { cylinderFaceCount: cylinders.length, straightFaceCount: straightFaces.length, exactStraightEdgeCount: straightEdges.length };
}

function slottedHolePatternCylinderFaces(state: any, plateId: number): any[] {
  const plate = state.bodies.find((body: { id: number }) => body.id === plateId);
  if (!plate) return [];
  return plate.faces.filter((face: any) => face.surfaceType === "Cylinder"
    && face.radiusMm !== null && Math.abs(face.radiusMm - 3) <= 0.01
    && face.axisOriginMm && [10, 30].some((y) => Math.abs(face.axisOriginMm[1] - y) <= 0.01)
    && [378, 392].some((x) => Math.abs(face.axisOriginMm[0] - x) <= 0.01)
    && face.axisDirection && Math.abs(Math.abs(face.axisDirection[2]) - 1) <= 1e-6);
}

function insertPocketPatternFaces(state: any, plateId: number): any[] {
  const plate = state.bodies.find((body: { id: number }) => body.id === plateId);
  if (!plate) return [];
  return plate.faces.filter((face: any) => face.surfaceType === "Cylinder"
    && face.radiusMm !== null && [1.5, 2.3, 2.7].some((radius) => Math.abs(face.radiusMm - radius) <= 0.01)
    && face.axisOriginMm && [260, 280].some((centerX) => Math.hypot(face.axisOriginMm[0] - centerX, face.axisOriginMm[1] - 10) <= 0.01)
    && face.axisDirection && Math.abs(Math.abs(face.axisDirection[2]) - 1) <= 1e-6);
}

function blindHoleFaces(state: any, plateId: number): any[] {
  const plate = state.bodies.find((body: { id: number }) => body.id === plateId);
  if (!plate) return [];
  return plate.faces.filter((face: any) => face.surfaceType === "Cylinder"
    && face.radiusMm !== null && Math.abs(face.radiusMm - 2.1) <= 0.01
    && face.axisOriginMm && Math.hypot(face.axisOriginMm[0] - 5, face.axisOriginMm[1] - 25) <= 0.01
    && face.axisDirection && Math.abs(Math.abs(face.axisDirection[2]) - 1) <= 1e-6);
}

function inspectCountersink(state: any, plateId: number): Record<string, number> {
  const plate = state.bodies.find((body: { id: number }) => body.id === plateId);
  requireCondition(plate?.type === "Solid", "Countersink result is not the original Solid");
  const conicalFaces = plate.faces.filter((face: { surfaceType: string }) => /cone/i.test(face.surfaceType));
  const boreFaces = plate.faces.filter((face: { surfaceType: string; radiusMm: number | null }) => face.surfaceType === "Cylinder" && face.radiusMm !== null && Math.abs(face.radiusMm - 2.75) <= 0.01);
  const majorEdges = plate.edges.filter((edge: { circle: boolean; lengthMm: number }) => edge.circle && Math.abs(edge.lengthMm - Math.PI * 10.4) <= 0.01);
  const boreEdges = plate.edges.filter((edge: { circle: boolean; lengthMm: number }) => edge.circle && Math.abs(edge.lengthMm - Math.PI * 5.5) <= 0.01);
  requireCondition(conicalFaces.length >= 1, "No native conical countersink face was found");
  requireCondition(boreFaces.length >= 1, "No exact Ø5.5 native cylindrical through face was found");
  requireCondition(majorEdges.length >= 1, "No exact Ø10.4 circular countersink edge was found");
  requireCondition(boreEdges.length >= 1, "No exact Ø5.5 circular bore edge was found");
  return { conicalFaceCount: conicalFaces.length, boreFaceCount: boreFaces.length, majorEdgeCount: majorEdges.length, boreEdgeCount: boreEdges.length };
}

function inspectHexPocket(state: any, plateId: number): Record<string, number> {
  inspectCountersink(state, plateId);
  const sideFaces = hexPocketSideFaces(state, plateId);
  requireCondition(sideFaces.length === 6, `Expected six native hex pocket side faces, found ${sideFaces.length}`);
  for (const face of sideFaces) {
    const offset = Math.abs((face.centerMm[0] - 28) * face.normal[0] + (face.centerMm[1] - 15) * face.normal[1]);
    near(offset, 4, 0.01, `hex pocket face ${face.id} across-flats half-distance`);
  }
  const plate = state.bodies.find((body: { id: number }) => body.id === plateId);
  const sideLength = 8 / Math.sqrt(3);
  const hexEdges = plate.edges.filter((edge: { line: boolean; lengthMm: number }) => edge.line && Math.abs(edge.lengthMm - sideLength) <= 0.01);
  requireCondition(hexEdges.length >= 6, `Expected at least six exact hex edges, found ${hexEdges.length}`);
  const bottomFaces = plate.faces.filter((face: any) => face.planar && Math.abs(Math.abs(face.normal[2]) - 1) <= 1e-6
    && Math.hypot(face.centerMm[0] - 28, face.centerMm[1] - 15) < 5 && Math.abs(face.centerMm[2] - 4) <= 0.01);
  requireCondition(bottomFaces.length >= 1, "No exact 4 mm deep hex pocket floor was found");
  return { sideFaceCount: sideFaces.length, exactSideEdgeCount: hexEdges.length, bottomFaceCount: bottomFaces.length };
}

function hexPocketSideFaces(state: any, plateId: number): any[] {
  const plate = state.bodies.find((body: { id: number }) => body.id === plateId);
  if (!plate) return [];
  return plate.faces.filter((face: any) => face.planar && Math.abs(face.normal[2]) <= 1e-6
    && Math.hypot(face.centerMm[0] - 28, face.centerMm[1] - 15) < 6
    && face.centerMm[2] > 3.9 && face.centerMm[2] < 8.1);
}

function inspectSlottedHole(state: any, plateId: number): Record<string, number> {
  const plate = state.bodies.find((body: { id: number }) => body.id === plateId);
  requireCondition(plate?.type === "Solid", "Slotted-hole result is not the original Solid");
  const cylinders = slotCylinderFaces(state, plateId);
  requireCondition(cylinders.length === 2, `Expected two native cylindrical slot-end faces, found ${cylinders.length}`);
  for (const [x, y] of [[13, 5], [27, 5]] as const) {
    const face = cylinders.find((candidate: any) => candidate.axisOriginMm
      && Math.abs(candidate.axisOriginMm[0] - x) <= 0.01
      && Math.abs(candidate.axisOriginMm[1] - y) <= 0.01);
    requireCondition(face, `No exact R3 cylindrical slot end was found at ${x},${y}`);
    requireCondition(face.boundsMm.min[2] <= 0.01 && face.boundsMm.max[2] >= 7.99, `Slot end at ${x},${y} is not through the 8 mm plate`);
  }
  const straightFaces = plate.faces.filter((face: any) => face.planar
    && Math.abs(face.centerMm[0] - 20) <= 0.01
    && (Math.abs(face.centerMm[1] - 2) <= 0.01 || Math.abs(face.centerMm[1] - 8) <= 0.01)
    && Math.abs(face.centerMm[2] - 4) <= 0.01
    && Math.abs(face.normal[2]) <= 1e-6);
  requireCondition(straightFaces.length === 2, `Expected two straight native slot walls, found ${straightFaces.length}`);
  const straightEdges = plate.edges.filter((edge: any) => edge.line
    && Math.abs(edge.lengthMm - 14) <= 0.01
    && (Math.abs(edge.centerMm[1] - 2) <= 0.01 || Math.abs(edge.centerMm[1] - 8) <= 0.01));
  requireCondition(straightEdges.length === 4, `Expected four exact 14 mm slot edges, found ${straightEdges.length}`);
  return { cylinderFaceCount: cylinders.length, straightFaceCount: straightFaces.length, exactStraightEdgeCount: straightEdges.length };
}

function slotCylinderFaces(state: any, plateId: number): any[] {
  const plate = state.bodies.find((body: { id: number }) => body.id === plateId);
  if (!plate) return [];
  return plate.faces.filter((face: any) => face.surfaceType === "Cylinder"
    && face.radiusMm !== null && Math.abs(face.radiusMm - 3) <= 0.01
    && face.axisOriginMm && Math.abs(face.axisOriginMm[1] - 5) <= 0.01
    && face.axisDirection && Math.abs(Math.abs(face.axisDirection[2]) - 1) <= 1e-6);
}

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "run-server.ts")],
    cwd: projectRoot,
    env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" },
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-fastener-pockets-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const text = toolText(response);
  if ("isError" in response && response.isError) throw new Error(text);
  return JSON.parse(text);
}

function toolText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content");
  const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string");
  if (!item) throw new Error("MCP tool returned no text content");
  return item.text;
}

async function recover(client: Client, initial: any): Promise<Record<string, unknown>> {
  for (let count = 0; count < 80; count += 1) {
    const status = await call(client, "plasticity_status", {});
    if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" };
    if (status.bodies.length === 0) return { restoredEmptyDocument: true };
    const journal = await call(client, "plasticity_construction_journal", {});
    if (journal.entries.some((entry: { status: string }) => entry.status === "unknown")) return { restoredEmptyDocument: false, reason: "unsafe-journal" };
    const lastEntry = journal.entries.at(-1);
    const observedFailedMutation = lastEntry?.status === "failed"
      && lastEntry.afterDocumentToken === status.documentToken
      && lastEntry.afterRevision === status.revision
      && lastEntry.diff !== null;
    if (journal.syncStatus !== "in-sync" && !observedFailedMutation) return { restoredEmptyDocument: false, reason: "unsafe-journal" };
    await call(client, "plasticity_undo", { intent: "Recover disposable fastener-pocket acceptance", revision: status.revision });
  }
  return { restoredEmptyDocument: false, reason: "undo-limit" };
}

function requireCleanJournal(journal: any): void {
  requireCondition(journal.syncStatus === "in-sync", `Construction journal is ${String(journal.syncStatus)}`);
  requireCondition(!journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal contains an uncertain mutation");
}

function stateSummary(state: any): Record<string, unknown> {
  return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length };
}

function near(actual: number, expected: number, tolerance: number, label: string): void {
  requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`);
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : []));
}

function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }

async function writeExclusive(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
}
