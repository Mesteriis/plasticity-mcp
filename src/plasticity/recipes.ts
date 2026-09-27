import { mutationOutcomeIsUncertain, type RuntimeState } from "./runtime.ts";
import type { PlasticityOperations } from "./operations.ts";

type Vector3 = [number, number, number];

export type RecipeOperations = Pick<PlasticityOperations, "state" | "createBox" | "createCylinder" | "createPolyline" | "extrudeRegions" | "rectangularPattern" | "createPipes" | "fillet" | "boolean"> & {
  revolveProfile?: PlasticityOperations["revolveProfile"];
};

export interface CountersinkRecipeInput {
  targetId: number;
  entryCenterMm: Vector3;
  axis: Vector3;
  radialDirection: Vector3;
  throughDiameterMm: number;
  countersinkMajorDiameterMm: number;
  includedAngleDeg: number;
  throughDepthMm: number;
  overshootMm: number;
  revision: string;
}

export interface CountersinkRecipeResult {
  recipe: "countersink";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  countersinkDepthMm: number;
  profileBodyId: number;
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface CountersinkPatternRecipeInput {
  targetId: number;
  entryCentersMm: Vector3[];
  axis: Vector3;
  radialDirection: Vector3;
  throughDiameterMm: number;
  countersinkMajorDiameterMm: number;
  includedAngleDeg: number;
  throughDepthMm: number;
  overshootMm: number;
  revision: string;
}

export interface CountersinkPatternRecipeResult {
  recipe: "countersink-pattern";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  holeCount: number;
  countersinkDepthMm: number;
  profileBodyIds: number[];
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface HexNutPocketRecipeInput {
  targetId: number;
  entryCenterMm: Vector3;
  axis: Vector3;
  flatNormalDirection: Vector3;
  acrossFlatsMm: number;
  pocketDepthMm: number;
  materialDepthMm: number;
  overshootMm: number;
  revision: string;
}

export interface HexNutPocketRecipeResult {
  recipe: "hex-nut-pocket";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  profileBodyId: number;
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface HexNutPocketPatternRecipeInput {
  targetId: number;
  entryCentersMm: Vector3[];
  axis: Vector3;
  flatNormalDirection: Vector3;
  acrossFlatsMm: number;
  pocketDepthMm: number;
  materialDepthMm: number;
  overshootMm: number;
  revision: string;
}

export interface HexNutPocketPatternRecipeResult {
  recipe: "hex-nut-pocket-pattern";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  pocketCount: number;
  profileBodyIds: number[];
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface SlottedHoleRecipeInput {
  targetId: number;
  entryCenterMm: Vector3;
  axis: Vector3;
  slotDirection: Vector3;
  overallLengthMm: number;
  widthMm: number;
  throughDepthMm: number;
  overshootMm: number;
  revision: string;
}

export interface SlottedHoleRecipeResult {
  recipe: "slotted-hole";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  centerDistanceMm: number;
  profileBodyId: number;
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface SlottedHolePatternRecipeInput {
  targetId: number;
  entryCentersMm: Vector3[];
  axis: Vector3;
  slotDirection: Vector3;
  overallLengthMm: number;
  widthMm: number;
  throughDepthMm: number;
  overshootMm: number;
  revision: string;
}

export interface SlottedHolePatternRecipeResult {
  recipe: "slotted-hole-pattern";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  slotCount: number;
  centerDistanceMm: number;
  profileBodyIds: number[];
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface CounterboreRecipeInput {
  targetId: number;
  entryCenterMm: Vector3;
  axis: Vector3;
  throughDiameterMm: number;
  counterboreDiameterMm: number;
  counterboreDepthMm: number;
  throughDepthMm: number;
  overshootMm: number;
  revision: string;
}

export interface CounterborePatternRecipeInput {
  targetId: number;
  entryCentersMm: Vector3[];
  axis: Vector3;
  throughDiameterMm: number;
  counterboreDiameterMm: number;
  counterboreDepthMm: number;
  throughDepthMm: number;
  overshootMm: number;
  revision: string;
}

export interface ThroughHoleRecipeInput {
  targetId: number;
  entryCenterMm: Vector3;
  axis: Vector3;
  holeDiameterMm: number;
  throughDepthMm: number;
  overshootMm: number;
  revision: string;
}

export interface ThroughHoleRecipeResult {
  recipe: "through-hole";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface ThroughHolePatternRecipeInput {
  targetId: number;
  entryCentersMm: Vector3[];
  axis: Vector3;
  holeDiameterMm: number;
  throughDepthMm: number;
  overshootMm: number;
  revision: string;
}

export interface ThroughHolePatternRecipeResult {
  recipe: "through-hole-pattern";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  holeCount: number;
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface BlindHoleRecipeInput {
  targetId: number;
  entryCenterMm: Vector3;
  axis: Vector3;
  holeDiameterMm: number;
  holeDepthMm: number;
  materialDepthMm: number;
  overshootMm: number;
  revision: string;
}

export interface BlindHoleRecipeResult {
  recipe: "blind-hole";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface BlindHolePatternRecipeInput {
  targetId: number;
  entryCentersMm: Vector3[];
  axis: Vector3;
  holeDiameterMm: number;
  holeDepthMm: number;
  materialDepthMm: number;
  overshootMm: number;
  revision: string;
}

export interface BlindHolePatternRecipeResult {
  recipe: "blind-hole-pattern";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  holeCount: number;
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface RecipeStep {
  operation:
    | "create-countersink-profile"
    | "revolve-countersink-cutter"
    | "create-hex-pocket-profile"
    | "extrude-hex-pocket-cutter"
    | "create-slot-profile"
    | "extrude-slot-center-cutter"
    | "create-slot-end-cutter"
    | "create-through-cutter"
    | "create-counterbore-cutter"
    | "create-blind-cutter"
    | "create-pilot-cutter"
    | "create-insert-cutter"
    | "create-lead-in-cutter"
    | "create-boss-body"
    | "union-boss-to-target"
    | "create-boss-hole-cutter"
    | "create-rib-profile"
    | "extrude-rib"
    | "union-rib-to-target"
    | "create-vent-cutter"
    | "pattern-vent-cutters"
    | "create-snap-profile"
    | "extrude-snap-body"
    | "union-snap-to-target"
    | "create-hinge-barrel"
    | "create-hinge-bore-cutter"
    | "hollow-hinge-barrel"
    | "union-hinge-to-target"
    | "create-cable-channel-cutters"
    | "create-connector-profile"
    | "extrude-connector-cutter"
    | "round-connector-cutter"
    | "create-male-lip-outer"
    | "create-male-lip-inner"
    | "form-male-lip"
    | "union-male-lip"
    | "create-female-groove-outer"
    | "create-female-groove-inner"
    | "form-female-groove"
    | "cut-female-groove"
    | "create-locating-pin"
    | "union-locating-pin"
    | "create-locating-socket-cutter"
    | "cut-locating-socket"
    | "create-tongue-profile"
    | "extrude-tongue"
    | "union-tongue"
    | "create-groove-profile"
    | "extrude-groove-cutter"
    | "cut-groove"
    | "create-dovetail-male-profile"
    | "extrude-dovetail-male"
    | "union-dovetail-male"
    | "create-dovetail-female-profile"
    | "extrude-dovetail-female-cutter"
    | "cut-dovetail-female"
    | "boolean-difference";
  beforeRevision: string;
  afterRevision: string;
  affectedBodyIds: number[];
}

export interface CounterboreRecipeResult {
  recipe: "counterbore";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface CounterborePatternRecipeResult {
  recipe: "counterbore-pattern";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  holeCount: number;
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface HeatSetInsertPocketRecipeInput {
  targetId: number;
  entryCenterMm: Vector3;
  axis: Vector3;
  pilotDiameterMm: number;
  pilotDepthMm: number;
  insertDiameterMm: number;
  insertDepthMm: number;
  leadInDiameterMm: number;
  leadInDepthMm: number;
  materialDepthMm: number;
  overshootMm: number;
  revision: string;
}

export interface HeatSetInsertPocketRecipeResult {
  recipe: "heat-set-insert-pocket";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface HeatSetInsertPocketPatternRecipeInput {
  targetId: number;
  entryCentersMm: Vector3[];
  axis: Vector3;
  pilotDiameterMm: number;
  pilotDepthMm: number;
  insertDiameterMm: number;
  insertDepthMm: number;
  leadInDiameterMm: number;
  leadInDepthMm: number;
  materialDepthMm: number;
  overshootMm: number;
  revision: string;
}

export interface HeatSetInsertPocketPatternRecipeResult {
  recipe: "heat-set-insert-pocket-pattern";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  pocketCount: number;
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface ScrewBossRecipeInput {
  targetId: number;
  baseCenterMm: Vector3;
  axis: Vector3;
  outerDiameterMm: number;
  heightMm: number;
  holeDiameterMm: number;
  holeDepthMm: number;
  baseOverlapMm: number;
  cutterOvershootMm: number;
  revision: string;
}

export interface ScrewBossRecipeResult {
  recipe: "screw-boss";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface ScrewBossPatternRecipeInput {
  targetId: number;
  baseCentersMm: Vector3[];
  axis: Vector3;
  outerDiameterMm: number;
  heightMm: number;
  holeDiameterMm: number;
  holeDepthMm: number;
  baseOverlapMm: number;
  cutterOvershootMm: number;
  revision: string;
}

export interface ScrewBossPatternRecipeResult {
  recipe: "screw-boss-pattern";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  bossCount: number;
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface RibRecipeInput {
  targetId: number;
  profilePointsMm: Vector3[];
  thicknessMm: number;
  revision: string;
}

export interface RibRecipeResult {
  recipe: "rib";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  profileBodyId: number;
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface RoundVentArrayRecipeInput {
  targetId: number;
  firstCenterMm: Vector3;
  axis: Vector3;
  holeDiameterMm: number;
  throughDepthMm: number;
  direction1: Vector3;
  count1: number;
  spacing1Mm: number;
  direction2: Vector3;
  count2: number;
  spacing2Mm: number;
  overshootMm: number;
  revision: string;
}

export interface RoundVentArrayRecipeResult {
  recipe: "round-vent-array";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  resultBodyIds: number[];
  consumedToolIds: number[];
  holeCount: number;
  undoSteps: number;
  steps: RecipeStep[];
}

export interface CantileverSnapFitRecipeInput {
  targetId: number;
  baseCenterMm: Vector3;
  beamDirection: Vector3;
  thicknessDirection: Vector3;
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  hookLengthMm: number;
  hookHeightMm: number;
  baseOverlapMm: number;
  revision: string;
}

export interface CantileverSnapFitRecipeResult {
  recipe: "cantilever-snap-fit";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  profileBodyId: number;
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface HingeBarrelRecipeInput {
  targetId: number;
  axisStartMm: Vector3;
  axis: Vector3;
  lengthMm: number;
  outerDiameterMm: number;
  pinBoreDiameterMm: number;
  cutterOvershootMm: number;
  revision: string;
}

export interface HingeBarrelRecipeResult {
  recipe: "hinge-barrel";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface CableChannelRecipeInput {
  targetId: number;
  spineIds: number[];
  channelDiameterMm: number;
  revision: string;
}

export interface CableChannelRecipeResult {
  recipe: "cable-channel";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  spineIds: number[];
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface ConnectorOpeningRecipeInput {
  targetId: number;
  entryCenterMm: Vector3;
  axis: Vector3;
  widthDirection: Vector3;
  widthMm: number;
  heightMm: number;
  cornerRadiusMm: number;
  throughDepthMm: number;
  overshootMm: number;
  revision: string;
}

export interface ConnectorOpeningRecipeResult {
  recipe: "connector-opening";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  profileBodyId: number;
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface MatingEnclosureJointRecipeInput {
  maleTargetId: number;
  femaleTargetId: number;
  seamOriginMm: Vector3;
  outerWidthMm: number;
  outerDepthMm: number;
  wallThicknessMm: number;
  lipThicknessMm: number;
  lipHeightMm: number;
  clearanceMm: number;
  overlapMm: number;
  cutterOvershootMm: number;
  revision: string;
}

export interface MatingEnclosureJointRecipeResult {
  recipe: "mating-enclosure-joint";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  maleTargetId: number;
  femaleTargetId: number;
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface LocatingPinPairRecipeInput {
  maleTargetId: number;
  femaleTargetId: number;
  baseCenterMm: Vector3;
  axis: Vector3;
  pinDiameterMm: number;
  pinHeightMm: number;
  radialClearanceMm: number;
  axialClearanceMm: number;
  baseOverlapMm: number;
  cutterOvershootMm: number;
  revision: string;
}

export interface LocatingPinPairRecipeResult {
  recipe: "locating-pin-pair";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  maleTargetId: number;
  femaleTargetId: number;
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface LocatingPinPairPatternRecipeInput extends Omit<LocatingPinPairRecipeInput, "baseCenterMm"> {
  baseCentersMm: Vector3[];
}

export interface LocatingPinPairPatternRecipeResult extends Omit<LocatingPinPairRecipeResult, "recipe"> {
  recipe: "locating-pin-pair-pattern";
  pinCount: number;
}

export interface SplitScrewInsertJointRecipeInput {
  maleTargetId: number;
  femaleTargetId: number;
  screwEntryCentersMm: Vector3[];
  insertEntryCentersMm: Vector3[];
  axis: Vector3;
  fastenerDesignation: string;
  screwLengthMm: number;
  minimumEngagementMm: number;
  maximumEngagementMm: number;
  insertPartNumber: string;
  insertThreadNominalDiameterMm: number;
  insertThreadPitchMm: number;
  insertSourceUrl: string;
  holeDiameterMm: number;
  maleThroughDepthMm: number;
  holeOvershootMm: number;
  pilotDiameterMm: number;
  pilotDepthMm: number;
  insertDiameterMm: number;
  insertDepthMm: number;
  leadInDiameterMm: number;
  leadInDepthMm: number;
  femaleMaterialDepthMm: number;
  insertOvershootMm: number;
  revision: string;
}

export interface SplitScrewInsertJointRecipeResult {
  recipe: "split-screw-insert-joint";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  maleTargetId: number;
  femaleTargetId: number;
  fastenerDesignation: string;
  insertPartNumber: string;
  insertThreadNominalDiameterMm: number;
  insertThreadPitchMm: number;
  insertSourceUrl: string;
  fastenerCount: number;
  screwEngagementMm: number;
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface TongueGrooveJointRecipeInput {
  tongueTargetId: number;
  grooveTargetId: number;
  baseCenterMm: Vector3;
  axis: Vector3;
  widthDirection: Vector3;
  tongueWidthMm: number;
  tongueThicknessMm: number;
  tongueHeightMm: number;
  radialClearanceMm: number;
  axialClearanceMm: number;
  baseOverlapMm: number;
  cutterOvershootMm: number;
  revision: string;
}

export interface TongueGrooveJointRecipeResult {
  recipe: "tongue-groove-joint";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  tongueTargetId: number;
  grooveTargetId: number;
  profileBodyIds: number[];
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export interface DovetailJointRecipeInput {
  maleTargetId: number;
  femaleTargetId: number;
  baseCenterMm: Vector3;
  axis: Vector3;
  widthDirection: Vector3;
  rootWidthMm: number;
  flareMm: number;
  tongueThicknessMm: number;
  tongueHeightMm: number;
  radialClearanceMm: number;
  axialClearanceMm: number;
  baseOverlapMm: number;
  cutterOvershootMm: number;
  revision: string;
}

export interface DovetailJointRecipeResult {
  recipe: "dovetail-joint";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  maleTargetId: number;
  femaleTargetId: number;
  rootWidthMm: number;
  tipWidthMm: number;
  profileBodyIds: number[];
  resultBodyIds: number[];
  consumedToolIds: number[];
  undoSteps: number;
  steps: RecipeStep[];
}

export class CountersinkRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Countersink recipe failed after ${completedSteps.length}/4 confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "CountersinkRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class CountersinkPatternRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string, totalSteps: number) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Countersink pattern recipe failed after ${completedSteps.length}/${totalSteps} confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "CountersinkPatternRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class HexNutPocketRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Hex nut pocket recipe failed after ${completedSteps.length}/3 confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "HexNutPocketRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class HexNutPocketPatternRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string, totalSteps: number) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Hex nut pocket pattern recipe failed after ${completedSteps.length}/${totalSteps} confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "HexNutPocketPatternRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class SlottedHoleRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Slotted hole recipe failed after ${completedSteps.length}/5 confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "SlottedHoleRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class SlottedHolePatternRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string, totalSteps: number) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Slotted hole pattern recipe failed after ${completedSteps.length}/${totalSteps} confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "SlottedHolePatternRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class CounterboreRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Counterbore recipe failed after ${completedSteps.length}/3 confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "CounterboreRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class CounterborePatternRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string, totalSteps: number) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Counterbore pattern recipe failed after ${completedSteps.length}/${totalSteps} confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "CounterborePatternRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class ThroughHoleRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Through-hole recipe failed after ${completedSteps.length}/2 confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "ThroughHoleRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class ThroughHolePatternRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string, totalSteps: number) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Through-hole pattern recipe failed after ${completedSteps.length}/${totalSteps} confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "ThroughHolePatternRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class BlindHoleRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Blind-hole recipe failed after ${completedSteps.length}/2 confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "BlindHoleRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class BlindHolePatternRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string, totalSteps: number) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Blind-hole pattern recipe failed after ${completedSteps.length}/${totalSteps} confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "BlindHolePatternRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class HeatSetInsertPocketRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Heat-set insert pocket recipe failed after ${completedSteps.length}/4 confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "HeatSetInsertPocketRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class HeatSetInsertPocketPatternRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string, totalSteps: number) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Heat-set insert pocket pattern recipe failed after ${completedSteps.length}/${totalSteps} confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "HeatSetInsertPocketPatternRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class ScrewBossRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Screw boss recipe failed after ${completedSteps.length}/4 confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "ScrewBossRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class ScrewBossPatternRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string, totalSteps: number) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Screw boss pattern recipe failed after ${completedSteps.length}/${totalSteps} confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "ScrewBossPatternRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class RibRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Rib recipe failed after ${completedSteps.length}/3 confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "RibRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class RoundVentArrayRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string, totalSteps: number) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Round vent array recipe failed after ${completedSteps.length}/${totalSteps} confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "RoundVentArrayRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class CantileverSnapFitRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string) {
    const uncertain = mutationOutcomeIsUncertain(cause) || (cause instanceof RibRecipeError && cause.uncertain);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Cantilever snap-fit recipe failed after ${completedSteps.length}/3 confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "CantileverSnapFitRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class HingeBarrelRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Hinge barrel recipe failed after ${completedSteps.length}/4 confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "HingeBarrelRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class CableChannelRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Cable channel recipe failed after ${completedSteps.length}/2 confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "CableChannelRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class ConnectorOpeningRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string, totalSteps: number) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Connector opening recipe failed after ${completedSteps.length}/${totalSteps} confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "ConnectorOpeningRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class MatingEnclosureJointRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Mating enclosure joint recipe failed after ${completedSteps.length}/8 confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "MatingEnclosureJointRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class LocatingPinPairRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Locating pin pair recipe failed after ${completedSteps.length}/4 confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "LocatingPinPairRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class LocatingPinPairPatternRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string, totalSteps: number) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Locating pin pattern recipe failed after ${completedSteps.length}/${totalSteps} confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "LocatingPinPairPatternRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class SplitScrewInsertJointRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string, totalSteps: number) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Split screw-and-insert recipe failed after ${completedSteps.length}/${totalSteps} confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "SplitScrewInsertJointRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class TongueGrooveJointRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Tongue and groove joint recipe failed after ${completedSteps.length}/6 confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "TongueGrooveJointRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class DovetailJointRecipeError extends Error {
  readonly completedSteps: RecipeStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, completedSteps: RecipeStep[], lastConfirmedRevision: string) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`Dovetail joint recipe failed after ${completedSteps.length}/6 confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "DovetailJointRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class PlasticityRecipes {
  private readonly operations: RecipeOperations;

  constructor(operations: RecipeOperations) {
    this.operations = operations;
  }

  async createCountersink(input: CountersinkRecipeInput): Promise<CountersinkRecipeResult> {
    const countersinkDepthMm = validateCountersink(input);
    if (!this.operations.revolveProfile) throw new Error("Countersink requires native profile revolve support");
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.targetId, input.revision, "Countersink");

    const axis = normalize(input.axis);
    const radial = normalize(input.radialDirection);
    const profileStart = subtract(input.entryCenterMm, scale(axis, input.overshootMm));
    const majorRadius = input.countersinkMajorDiameterMm / 2;
    const throughRadius = input.throughDiameterMm / 2;
    const transition = add(input.entryCenterMm, scale(axis, countersinkDepthMm));
    const profilePoints: Vector3[] = [
      add(profileStart, scale(radial, throughRadius)),
      add(profileStart, scale(radial, majorRadius)),
      add(input.entryCenterMm, scale(radial, majorRadius)),
      add(transition, scale(radial, throughRadius)),
    ];
    const completedSteps: RecipeStep[] = [];
    let current = initial;
    let profileBodyId = 0;
    let throughCutterBodyId = 0;
    let countersinkCutterBodyId = 0;
    try {
      const beforeThrough = current;
      current = await this.operations.createCylinder(
        profileStart,
        throughRadius,
        input.throughDepthMm + input.overshootMm * 2,
        undefined,
        current.revision,
        axis,
      );
      throughCutterBodyId = requireSingleAddedBody(beforeThrough, current, "countersink through-hole cutter");
      completedSteps.push(step("create-through-cutter", beforeThrough, current, [throughCutterBodyId]));

      const beforeProfile = current;
      current = await this.operations.createPolyline(profilePoints, true, current.revision);
      profileBodyId = requireSingleAddedBody(beforeProfile, current, "countersink profile", "Wire");
      completedSteps.push(step("create-countersink-profile", beforeProfile, current, [profileBodyId]));

      const beforeRevolve = current;
      current = await this.operations.revolveProfile(profileBodyId, input.entryCenterMm, axis, 360, current.revision);
      countersinkCutterBodyId = requireSingleAddedBody(beforeRevolve, current, "revolved countersink cutter");
      completedSteps.push(step("revolve-countersink-cutter", beforeRevolve, current, [countersinkCutterBodyId]));

      const beforeBoolean = current;
      current = await this.operations.boolean([input.targetId], [throughCutterBodyId, countersinkCutterBodyId], "difference", false, current.revision);
      const resultBodyIds = requireRecipeResult(initial, current, input.targetId, [throughCutterBodyId, countersinkCutterBodyId]);
      if (current.bodies.find((body) => body.id === profileBodyId)?.type !== "Wire") {
        throw new Error(`Countersink profile was not preserved as a Wire: ${profileBodyId}`);
      }
      completedSteps.push(step("boolean-difference", beforeBoolean, current, resultBodyIds));

      return {
        recipe: "countersink",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        targetId: input.targetId,
        countersinkDepthMm,
        profileBodyId,
        resultBodyIds,
        consumedToolIds: [throughCutterBodyId, countersinkCutterBodyId],
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof CountersinkRecipeError) throw error;
      throw new CountersinkRecipeError(error, completedSteps, current.revision);
    }
  }

  async createCountersinkPattern(input: CountersinkPatternRecipeInput): Promise<CountersinkPatternRecipeResult> {
    const countersinkDepthMm = validateCountersinkPattern(input);
    if (!this.operations.revolveProfile) throw new Error("Countersink pattern requires native profile revolve support");
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.targetId, input.revision, "Countersink pattern");

    const axis = normalize(input.axis);
    const radial = normalize(input.radialDirection);
    const majorRadius = input.countersinkMajorDiameterMm / 2;
    const throughRadius = input.throughDiameterMm / 2;
    const completedSteps: RecipeStep[] = [];
    const profileBodyIds: number[] = [];
    const cutterBodyIds: number[] = [];
    const totalSteps = input.entryCentersMm.length * 3 + 1;
    let current = initial;
    try {
      for (const center of input.entryCentersMm) {
        const profileStart = subtract(center, scale(axis, input.overshootMm));
        const transition = add(center, scale(axis, countersinkDepthMm));
        const profilePoints: Vector3[] = [
          add(profileStart, scale(radial, throughRadius)),
          add(profileStart, scale(radial, majorRadius)),
          add(center, scale(radial, majorRadius)),
          add(transition, scale(radial, throughRadius)),
        ];

        const beforeThrough = current;
        current = await this.operations.createCylinder(
          profileStart,
          throughRadius,
          input.throughDepthMm + input.overshootMm * 2,
          undefined,
          current.revision,
          axis,
        );
        const throughCutterBodyId = requireSingleAddedBody(beforeThrough, current, "countersink pattern through-hole cutter");
        cutterBodyIds.push(throughCutterBodyId);
        completedSteps.push(step("create-through-cutter", beforeThrough, current, [throughCutterBodyId]));

        const beforeProfile = current;
        current = await this.operations.createPolyline(profilePoints, true, current.revision);
        const profileBodyId = requireSingleAddedBody(beforeProfile, current, "countersink pattern profile", "Wire");
        profileBodyIds.push(profileBodyId);
        completedSteps.push(step("create-countersink-profile", beforeProfile, current, [profileBodyId]));

        const beforeRevolve = current;
        current = await this.operations.revolveProfile(profileBodyId, center, axis, 360, current.revision);
        const countersinkCutterBodyId = requireSingleAddedBody(beforeRevolve, current, "revolved countersink pattern cutter");
        cutterBodyIds.push(countersinkCutterBodyId);
        completedSteps.push(step("revolve-countersink-cutter", beforeRevolve, current, [countersinkCutterBodyId]));
      }

      const beforeBoolean = current;
      current = await this.operations.boolean([input.targetId], cutterBodyIds, "difference", false, current.revision);
      const resultBodyIds = requireRecipeResult(initial, current, input.targetId, cutterBodyIds);
      for (const profileBodyId of profileBodyIds) {
        if (current.bodies.find((body) => body.id === profileBodyId)?.type !== "Wire") {
          throw new Error(`Countersink pattern profile was not preserved as a Wire: ${profileBodyId}`);
        }
      }
      completedSteps.push(step("boolean-difference", beforeBoolean, current, resultBodyIds));

      return {
        recipe: "countersink-pattern",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        targetId: input.targetId,
        holeCount: input.entryCentersMm.length,
        countersinkDepthMm,
        profileBodyIds,
        resultBodyIds,
        consumedToolIds: cutterBodyIds,
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof CountersinkPatternRecipeError) throw error;
      throw new CountersinkPatternRecipeError(error, completedSteps, current.revision, totalSteps);
    }
  }

  async createHexNutPocket(input: HexNutPocketRecipeInput): Promise<HexNutPocketRecipeResult> {
    validateHexNutPocket(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.targetId, input.revision, "Hex nut pocket");

    const axis = normalize(input.axis);
    const flatNormal = normalize(input.flatNormalDirection);
    const around = normalize(cross(axis, flatNormal));
    const profileCenter = subtract(input.entryCenterMm, scale(axis, input.overshootMm));
    const apothem = input.acrossFlatsMm / 2;
    const radius = input.acrossFlatsMm / Math.sqrt(3);
    const halfRadius = radius / 2;
    const profilePoints: Vector3[] = [
      add(add(profileCenter, scale(flatNormal, apothem)), scale(around, halfRadius)),
      add(profileCenter, scale(around, radius)),
      add(subtract(profileCenter, scale(flatNormal, apothem)), scale(around, halfRadius)),
      subtract(subtract(profileCenter, scale(flatNormal, apothem)), scale(around, halfRadius)),
      subtract(profileCenter, scale(around, radius)),
      subtract(add(profileCenter, scale(flatNormal, apothem)), scale(around, halfRadius)),
    ];
    const completedSteps: RecipeStep[] = [];
    let current = initial;
    let profileBodyId = 0;
    let cutterBodyId = 0;
    try {
      const beforeProfile = current;
      current = await this.operations.createPolyline(profilePoints, true, current.revision);
      profileBodyId = requireSingleAddedBody(beforeProfile, current, "hex nut pocket profile", "Wire");
      const previousRegionIds = new Set(beforeProfile.regions.map((region) => region.id));
      const regions = current.regions.filter((region) => !previousRegionIds.has(region.id));
      if (regions.length !== 1) throw new Error(`Expected one newly created closed Region for hex nut pocket profile ${profileBodyId}, found ${regions.length}`);
      completedSteps.push(step("create-hex-pocket-profile", beforeProfile, current, [profileBodyId]));

      const beforeExtrude = current;
      current = await this.operations.extrudeRegions([regions[0]!.id], input.pocketDepthMm + input.overshootMm, current.revision);
      cutterBodyId = requireSingleAddedBody(beforeExtrude, current, "extruded hex nut pocket cutter");
      completedSteps.push(step("extrude-hex-pocket-cutter", beforeExtrude, current, [cutterBodyId]));

      const beforeBoolean = current;
      current = await this.operations.boolean([input.targetId], [cutterBodyId], "difference", false, current.revision);
      const resultBodyIds = requireRecipeResult(initial, current, input.targetId, [cutterBodyId]);
      if (current.bodies.find((body) => body.id === profileBodyId)?.type !== "Wire") {
        throw new Error(`Hex nut pocket profile was not preserved as a Wire: ${profileBodyId}`);
      }
      completedSteps.push(step("boolean-difference", beforeBoolean, current, resultBodyIds));

      return {
        recipe: "hex-nut-pocket",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        targetId: input.targetId,
        profileBodyId,
        resultBodyIds,
        consumedToolIds: [cutterBodyId],
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof HexNutPocketRecipeError) throw error;
      throw new HexNutPocketRecipeError(error, completedSteps, current.revision);
    }
  }

  async createHexNutPocketPattern(input: HexNutPocketPatternRecipeInput): Promise<HexNutPocketPatternRecipeResult> {
    validateHexNutPocketPattern(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.targetId, input.revision, "Hex nut pocket pattern");

    const axis = normalize(input.axis);
    const flatNormal = normalize(input.flatNormalDirection);
    const around = normalize(cross(axis, flatNormal));
    const apothem = input.acrossFlatsMm / 2;
    const radius = input.acrossFlatsMm / Math.sqrt(3);
    const halfRadius = radius / 2;
    const completedSteps: RecipeStep[] = [];
    const profileBodyIds: number[] = [];
    const cutterBodyIds: number[] = [];
    const totalSteps = input.entryCentersMm.length * 2 + 1;
    let current = initial;
    try {
      for (const center of input.entryCentersMm) {
        const profileCenter = subtract(center, scale(axis, input.overshootMm));
        const profilePoints: Vector3[] = [
          add(add(profileCenter, scale(flatNormal, apothem)), scale(around, halfRadius)),
          add(profileCenter, scale(around, radius)),
          add(subtract(profileCenter, scale(flatNormal, apothem)), scale(around, halfRadius)),
          subtract(subtract(profileCenter, scale(flatNormal, apothem)), scale(around, halfRadius)),
          subtract(profileCenter, scale(around, radius)),
          subtract(add(profileCenter, scale(flatNormal, apothem)), scale(around, halfRadius)),
        ];

        const beforeProfile = current;
        current = await this.operations.createPolyline(profilePoints, true, current.revision);
        const profileBodyId = requireSingleAddedBody(beforeProfile, current, "hex nut pocket pattern profile", "Wire");
        profileBodyIds.push(profileBodyId);
        const previousRegionIds = new Set(beforeProfile.regions.map((region) => region.id));
        const regions = current.regions.filter((region) => !previousRegionIds.has(region.id));
        if (regions.length !== 1) throw new Error(`Expected one newly created closed Region for hex nut pocket pattern profile ${profileBodyId}, found ${regions.length}`);
        completedSteps.push(step("create-hex-pocket-profile", beforeProfile, current, [profileBodyId]));

        const beforeExtrude = current;
        current = await this.operations.extrudeRegions([regions[0]!.id], input.pocketDepthMm + input.overshootMm, current.revision);
        const cutterBodyId = requireSingleAddedBody(beforeExtrude, current, "extruded hex nut pocket pattern cutter");
        cutterBodyIds.push(cutterBodyId);
        completedSteps.push(step("extrude-hex-pocket-cutter", beforeExtrude, current, [cutterBodyId]));
      }

      const beforeBoolean = current;
      current = await this.operations.boolean([input.targetId], cutterBodyIds, "difference", false, current.revision);
      const resultBodyIds = requireRecipeResult(initial, current, input.targetId, cutterBodyIds);
      for (const profileBodyId of profileBodyIds) {
        if (current.bodies.find((body) => body.id === profileBodyId)?.type !== "Wire") {
          throw new Error(`Hex nut pocket pattern profile was not preserved as a Wire: ${profileBodyId}`);
        }
      }
      completedSteps.push(step("boolean-difference", beforeBoolean, current, resultBodyIds));

      return {
        recipe: "hex-nut-pocket-pattern",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        targetId: input.targetId,
        pocketCount: input.entryCentersMm.length,
        profileBodyIds,
        resultBodyIds,
        consumedToolIds: cutterBodyIds,
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof HexNutPocketPatternRecipeError) throw error;
      throw new HexNutPocketPatternRecipeError(error, completedSteps, current.revision, totalSteps);
    }
  }

  async createSlottedHole(input: SlottedHoleRecipeInput): Promise<SlottedHoleRecipeResult> {
    validateSlottedHole(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.targetId, input.revision, "Slotted hole");

    const axis = normalize(input.axis);
    const slotDirection = normalize(input.slotDirection);
    const widthDirection = normalize(cross(axis, slotDirection));
    const centerDistanceMm = input.overallLengthMm - input.widthMm;
    const profileCenter = subtract(input.entryCenterMm, scale(axis, input.overshootMm));
    const profilePoints = rectanglePoints(profileCenter, slotDirection, widthDirection, centerDistanceMm, input.widthMm);
    const cutterDepthMm = input.throughDepthMm + input.overshootMm * 2;
    const completedSteps: RecipeStep[] = [];
    const consumedToolIds: number[] = [];
    let current = initial;
    let profileBodyId = 0;
    try {
      const beforeProfile = current;
      current = await this.operations.createPolyline(profilePoints, true, current.revision);
      profileBodyId = requireSingleAddedBody(beforeProfile, current, "slotted hole center profile", "Wire");
      completedSteps.push(step("create-slot-profile", beforeProfile, current, [profileBodyId]));
      const region = selectProfileRegion(current, profileBodyId, profilePoints, "slotted hole");

      const beforeExtrude = current;
      current = await this.operations.extrudeRegions([region.id], cutterDepthMm, current.revision);
      const centerCutterId = requireSingleAddedBody(beforeExtrude, current, "slotted hole center cutter");
      consumedToolIds.push(centerCutterId);
      completedSteps.push(step("extrude-slot-center-cutter", beforeExtrude, current, [centerCutterId]));

      for (const sign of [-1, 1] as const) {
        const beforeEnd = current;
        const endCenter = add(profileCenter, scale(slotDirection, sign * centerDistanceMm / 2));
        current = await this.operations.createCylinder(
          endCenter,
          input.widthMm / 2,
          cutterDepthMm,
          undefined,
          current.revision,
          axis,
        );
        const endCutterId = requireSingleAddedBody(beforeEnd, current, "slotted hole end cutter");
        consumedToolIds.push(endCutterId);
        completedSteps.push(step("create-slot-end-cutter", beforeEnd, current, [endCutterId]));
      }

      const beforeBoolean = current;
      current = await this.operations.boolean([input.targetId], consumedToolIds, "difference", false, current.revision);
      const resultBodyIds = requireRecipeResult(initial, current, input.targetId, consumedToolIds);
      if (current.bodies.find((body) => body.id === profileBodyId)?.type !== "Wire") {
        throw new Error(`Slotted hole profile was not preserved as a Wire: ${profileBodyId}`);
      }
      completedSteps.push(step("boolean-difference", beforeBoolean, current, resultBodyIds));

      return {
        recipe: "slotted-hole",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        targetId: input.targetId,
        centerDistanceMm,
        profileBodyId,
        resultBodyIds,
        consumedToolIds,
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof SlottedHoleRecipeError) throw error;
      throw new SlottedHoleRecipeError(error, completedSteps, current.revision);
    }
  }

  async createSlottedHolePattern(input: SlottedHolePatternRecipeInput): Promise<SlottedHolePatternRecipeResult> {
    validateSlottedHolePattern(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.targetId, input.revision, "Slotted hole pattern");

    const axis = normalize(input.axis);
    const slotDirection = normalize(input.slotDirection);
    const widthDirection = normalize(cross(axis, slotDirection));
    const centerDistanceMm = input.overallLengthMm - input.widthMm;
    const cutterDepthMm = input.throughDepthMm + input.overshootMm * 2;
    const completedSteps: RecipeStep[] = [];
    const profileBodyIds: number[] = [];
    const consumedToolIds: number[] = [];
    const totalSteps = input.entryCentersMm.length * 4 + 1;
    let current = initial;
    try {
      for (const entryCenter of input.entryCentersMm) {
        const profileCenter = subtract(entryCenter, scale(axis, input.overshootMm));
        const profilePoints = rectanglePoints(profileCenter, slotDirection, widthDirection, centerDistanceMm, input.widthMm);

        const beforeProfile = current;
        current = await this.operations.createPolyline(profilePoints, true, current.revision);
        const profileBodyId = requireSingleAddedBody(beforeProfile, current, "slotted hole pattern center profile", "Wire");
        profileBodyIds.push(profileBodyId);
        completedSteps.push(step("create-slot-profile", beforeProfile, current, [profileBodyId]));
        const region = selectProfileRegion(current, profileBodyId, profilePoints, "slotted hole pattern");

        const beforeExtrude = current;
        current = await this.operations.extrudeRegions([region.id], cutterDepthMm, current.revision);
        const centerCutterId = requireSingleAddedBody(beforeExtrude, current, "slotted hole pattern center cutter");
        consumedToolIds.push(centerCutterId);
        completedSteps.push(step("extrude-slot-center-cutter", beforeExtrude, current, [centerCutterId]));

        for (const sign of [-1, 1] as const) {
          const beforeEnd = current;
          const endCenter = add(profileCenter, scale(slotDirection, sign * centerDistanceMm / 2));
          current = await this.operations.createCylinder(
            endCenter,
            input.widthMm / 2,
            cutterDepthMm,
            undefined,
            current.revision,
            axis,
          );
          const endCutterId = requireSingleAddedBody(beforeEnd, current, "slotted hole pattern end cutter");
          consumedToolIds.push(endCutterId);
          completedSteps.push(step("create-slot-end-cutter", beforeEnd, current, [endCutterId]));
        }
      }

      const beforeBoolean = current;
      current = await this.operations.boolean([input.targetId], consumedToolIds, "difference", false, current.revision);
      const resultBodyIds = requireRecipeResult(initial, current, input.targetId, consumedToolIds);
      for (const profileBodyId of profileBodyIds) {
        if (current.bodies.find((body) => body.id === profileBodyId)?.type !== "Wire") {
          throw new Error(`Slotted hole pattern profile was not preserved as a Wire: ${profileBodyId}`);
        }
      }
      completedSteps.push(step("boolean-difference", beforeBoolean, current, resultBodyIds));

      return {
        recipe: "slotted-hole-pattern",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        targetId: input.targetId,
        slotCount: input.entryCentersMm.length,
        centerDistanceMm,
        profileBodyIds,
        resultBodyIds,
        consumedToolIds,
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof SlottedHolePatternRecipeError) throw error;
      throw new SlottedHolePatternRecipeError(error, completedSteps, current.revision, totalSteps);
    }
  }

  async createCounterbore(input: CounterboreRecipeInput): Promise<CounterboreRecipeResult> {
    validateCounterbore(input);
    const initial = await this.operations.state();
    if (initial.revision !== input.revision) {
      throw new Error(`Stale reference: expected revision ${input.revision}, current revision is ${initial.revision}`);
    }
    const target = initial.bodies.find((body) => body.id === input.targetId);
    if (!target) throw new Error(`Unknown target body ID: ${input.targetId}`);
    if (target.type !== "Solid") throw new Error(`Counterbore target must be a Solid: ${input.targetId}`);

    const axis = normalize(input.axis);
    const cutterStart = subtract(input.entryCenterMm, scale(axis, input.overshootMm));
    const completedSteps: RecipeStep[] = [];
    let current = initial;
    try {
      const through = await this.operations.createCylinder(
        cutterStart,
        input.throughDiameterMm / 2,
        input.throughDepthMm + input.overshootMm * 2,
        undefined,
        current.revision,
        axis,
      );
      const throughId = requireSingleAddedBody(current, through, "through-hole cutter");
      completedSteps.push(step("create-through-cutter", current, through, [throughId]));
      current = through;

      const counterbore = await this.operations.createCylinder(
        cutterStart,
        input.counterboreDiameterMm / 2,
        input.counterboreDepthMm + input.overshootMm,
        undefined,
        current.revision,
        axis,
      );
      const counterboreId = requireSingleAddedBody(current, counterbore, "counterbore cutter");
      completedSteps.push(step("create-counterbore-cutter", current, counterbore, [counterboreId]));
      current = counterbore;

      const result = await this.operations.boolean(
        [input.targetId],
        [throughId, counterboreId],
        "difference",
        false,
        current.revision,
      );
      const resultBodyIds = requireRecipeResult(initial, result, input.targetId, [throughId, counterboreId]);
      completedSteps.push(step("boolean-difference", current, result, resultBodyIds));
      current = result;

      return {
        recipe: "counterbore",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        targetId: input.targetId,
        resultBodyIds,
        consumedToolIds: [throughId, counterboreId],
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof CounterboreRecipeError) throw error;
      throw new CounterboreRecipeError(error, completedSteps, current.revision);
    }
  }

  async createCounterborePattern(input: CounterborePatternRecipeInput): Promise<CounterborePatternRecipeResult> {
    validateCounterborePattern(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.targetId, input.revision, "Counterbore pattern");

    const axis = normalize(input.axis);
    const completedSteps: RecipeStep[] = [];
    const cutterIds: number[] = [];
    const totalSteps = input.entryCentersMm.length * 2 + 1;
    let current = initial;
    try {
      for (const center of input.entryCentersMm) {
        const cutterStart = subtract(center, scale(axis, input.overshootMm));
        const through = await this.operations.createCylinder(
          cutterStart,
          input.throughDiameterMm / 2,
          input.throughDepthMm + input.overshootMm * 2,
          undefined,
          current.revision,
          axis,
        );
        const throughId = requireSingleAddedBody(current, through, "counterbore pattern through cutter");
        cutterIds.push(throughId);
        completedSteps.push(step("create-through-cutter", current, through, [throughId]));
        current = through;

        const counterbore = await this.operations.createCylinder(
          cutterStart,
          input.counterboreDiameterMm / 2,
          input.counterboreDepthMm + input.overshootMm,
          undefined,
          current.revision,
          axis,
        );
        const counterboreId = requireSingleAddedBody(current, counterbore, "counterbore pattern recess cutter");
        cutterIds.push(counterboreId);
        completedSteps.push(step("create-counterbore-cutter", current, counterbore, [counterboreId]));
        current = counterbore;
      }

      const result = await this.operations.boolean(
        [input.targetId],
        cutterIds,
        "difference",
        false,
        current.revision,
      );
      const resultBodyIds = requireRecipeResult(initial, result, input.targetId, cutterIds);
      completedSteps.push(step("boolean-difference", current, result, resultBodyIds));
      current = result;

      return {
        recipe: "counterbore-pattern",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        targetId: input.targetId,
        holeCount: input.entryCentersMm.length,
        resultBodyIds,
        consumedToolIds: cutterIds,
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof CounterborePatternRecipeError) throw error;
      throw new CounterborePatternRecipeError(error, completedSteps, current.revision, totalSteps);
    }
  }

  async createThroughHole(input: ThroughHoleRecipeInput): Promise<ThroughHoleRecipeResult> {
    validateThroughHole(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.targetId, input.revision, "Through-hole");

    const axis = normalize(input.axis);
    const cutterStart = subtract(input.entryCenterMm, scale(axis, input.overshootMm));
    const completedSteps: RecipeStep[] = [];
    let current = initial;
    try {
      const through = await this.operations.createCylinder(
        cutterStart,
        input.holeDiameterMm / 2,
        input.throughDepthMm + input.overshootMm * 2,
        undefined,
        current.revision,
        axis,
      );
      const throughId = requireSingleAddedBody(current, through, "through-hole cutter");
      completedSteps.push(step("create-through-cutter", current, through, [throughId]));
      current = through;

      const result = await this.operations.boolean(
        [input.targetId],
        [throughId],
        "difference",
        false,
        current.revision,
      );
      const resultBodyIds = requireRecipeResult(initial, result, input.targetId, [throughId]);
      completedSteps.push(step("boolean-difference", current, result, resultBodyIds));
      current = result;

      return {
        recipe: "through-hole",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        targetId: input.targetId,
        resultBodyIds,
        consumedToolIds: [throughId],
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof ThroughHoleRecipeError) throw error;
      throw new ThroughHoleRecipeError(error, completedSteps, current.revision);
    }
  }

  async createThroughHolePattern(input: ThroughHolePatternRecipeInput): Promise<ThroughHolePatternRecipeResult> {
    validateThroughHolePattern(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.targetId, input.revision, "Through-hole pattern");

    const axis = normalize(input.axis);
    const completedSteps: RecipeStep[] = [];
    const cutterIds: number[] = [];
    const totalSteps = input.entryCentersMm.length + 1;
    let current = initial;
    try {
      for (const center of input.entryCentersMm) {
        const cutterStart = subtract(center, scale(axis, input.overshootMm));
        const cutter = await this.operations.createCylinder(
          cutterStart,
          input.holeDiameterMm / 2,
          input.throughDepthMm + input.overshootMm * 2,
          undefined,
          current.revision,
          axis,
        );
        const cutterId = requireSingleAddedBody(current, cutter, "through-hole pattern cutter");
        cutterIds.push(cutterId);
        completedSteps.push(step("create-through-cutter", current, cutter, [cutterId]));
        current = cutter;
      }

      const result = await this.operations.boolean(
        [input.targetId],
        cutterIds,
        "difference",
        false,
        current.revision,
      );
      const resultBodyIds = requireRecipeResult(initial, result, input.targetId, cutterIds);
      completedSteps.push(step("boolean-difference", current, result, resultBodyIds));
      current = result;

      return {
        recipe: "through-hole-pattern",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        targetId: input.targetId,
        holeCount: input.entryCentersMm.length,
        resultBodyIds,
        consumedToolIds: cutterIds,
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof ThroughHolePatternRecipeError) throw error;
      throw new ThroughHolePatternRecipeError(error, completedSteps, current.revision, totalSteps);
    }
  }

  async createBlindHole(input: BlindHoleRecipeInput): Promise<BlindHoleRecipeResult> {
    validateBlindHole(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.targetId, input.revision, "Blind-hole");

    const axis = normalize(input.axis);
    const cutterStart = subtract(input.entryCenterMm, scale(axis, input.overshootMm));
    const completedSteps: RecipeStep[] = [];
    let current = initial;
    try {
      const cutter = await this.operations.createCylinder(
        cutterStart,
        input.holeDiameterMm / 2,
        input.holeDepthMm + input.overshootMm,
        undefined,
        current.revision,
        axis,
      );
      const cutterId = requireSingleAddedBody(current, cutter, "blind-hole cutter");
      completedSteps.push(step("create-blind-cutter", current, cutter, [cutterId]));
      current = cutter;

      const result = await this.operations.boolean(
        [input.targetId],
        [cutterId],
        "difference",
        false,
        current.revision,
      );
      const resultBodyIds = requireRecipeResult(initial, result, input.targetId, [cutterId]);
      completedSteps.push(step("boolean-difference", current, result, resultBodyIds));
      current = result;

      return {
        recipe: "blind-hole",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        targetId: input.targetId,
        resultBodyIds,
        consumedToolIds: [cutterId],
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof BlindHoleRecipeError) throw error;
      throw new BlindHoleRecipeError(error, completedSteps, current.revision);
    }
  }

  async createBlindHolePattern(input: BlindHolePatternRecipeInput): Promise<BlindHolePatternRecipeResult> {
    validateBlindHolePattern(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.targetId, input.revision, "Blind-hole pattern");

    const axis = normalize(input.axis);
    const completedSteps: RecipeStep[] = [];
    const cutterIds: number[] = [];
    const totalSteps = input.entryCentersMm.length + 1;
    let current = initial;
    try {
      for (const center of input.entryCentersMm) {
        const cutterStart = subtract(center, scale(axis, input.overshootMm));
        const cutter = await this.operations.createCylinder(
          cutterStart,
          input.holeDiameterMm / 2,
          input.holeDepthMm + input.overshootMm,
          undefined,
          current.revision,
          axis,
        );
        const cutterId = requireSingleAddedBody(current, cutter, "blind-hole pattern cutter");
        cutterIds.push(cutterId);
        completedSteps.push(step("create-blind-cutter", current, cutter, [cutterId]));
        current = cutter;
      }

      const result = await this.operations.boolean(
        [input.targetId],
        cutterIds,
        "difference",
        false,
        current.revision,
      );
      const resultBodyIds = requireRecipeResult(initial, result, input.targetId, cutterIds);
      completedSteps.push(step("boolean-difference", current, result, resultBodyIds));
      current = result;

      return {
        recipe: "blind-hole-pattern",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        targetId: input.targetId,
        holeCount: input.entryCentersMm.length,
        resultBodyIds,
        consumedToolIds: cutterIds,
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof BlindHolePatternRecipeError) throw error;
      throw new BlindHolePatternRecipeError(error, completedSteps, current.revision, totalSteps);
    }
  }

  async createHeatSetInsertPocket(input: HeatSetInsertPocketRecipeInput): Promise<HeatSetInsertPocketRecipeResult> {
    validateHeatSetInsertPocket(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.targetId, input.revision, "Heat-set insert pocket");

    const axis = normalize(input.axis);
    const cutterStart = subtract(input.entryCenterMm, scale(axis, input.overshootMm));
    const completedSteps: RecipeStep[] = [];
    const cutterIds: number[] = [];
    let current = initial;
    try {
      const cutters: Array<{ operation: RecipeStep["operation"]; diameterMm: number; depthMm: number; label: string }> = [
        { operation: "create-pilot-cutter", diameterMm: input.pilotDiameterMm, depthMm: input.pilotDepthMm, label: "pilot cutter" },
        { operation: "create-insert-cutter", diameterMm: input.insertDiameterMm, depthMm: input.insertDepthMm, label: "insert cutter" },
        { operation: "create-lead-in-cutter", diameterMm: input.leadInDiameterMm, depthMm: input.leadInDepthMm, label: "lead-in cutter" },
      ];
      for (const cutter of cutters) {
        const after = await this.operations.createCylinder(
          cutterStart,
          cutter.diameterMm / 2,
          cutter.depthMm + input.overshootMm,
          undefined,
          current.revision,
          axis,
        );
        const cutterId = requireSingleAddedBody(current, after, cutter.label);
        cutterIds.push(cutterId);
        completedSteps.push(step(cutter.operation, current, after, [cutterId]));
        current = after;
      }

      const result = await this.operations.boolean(
        [input.targetId],
        cutterIds,
        "difference",
        false,
        current.revision,
      );
      const resultBodyIds = requireRecipeResult(initial, result, input.targetId, cutterIds);
      completedSteps.push(step("boolean-difference", current, result, resultBodyIds));
      current = result;

      return {
        recipe: "heat-set-insert-pocket",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        targetId: input.targetId,
        resultBodyIds,
        consumedToolIds: cutterIds,
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof HeatSetInsertPocketRecipeError) throw error;
      throw new HeatSetInsertPocketRecipeError(error, completedSteps, current.revision);
    }
  }

  async createHeatSetInsertPocketPattern(input: HeatSetInsertPocketPatternRecipeInput): Promise<HeatSetInsertPocketPatternRecipeResult> {
    validateHeatSetInsertPocketPattern(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.targetId, input.revision, "Heat-set insert pocket pattern");

    const axis = normalize(input.axis);
    const completedSteps: RecipeStep[] = [];
    const cutterIds: number[] = [];
    const totalSteps = input.entryCentersMm.length * 3 + 1;
    let current = initial;
    try {
      const cutterDefinitions: Array<{ operation: RecipeStep["operation"]; diameterMm: number; depthMm: number; label: string }> = [
        { operation: "create-pilot-cutter", diameterMm: input.pilotDiameterMm, depthMm: input.pilotDepthMm, label: "pattern pilot cutter" },
        { operation: "create-insert-cutter", diameterMm: input.insertDiameterMm, depthMm: input.insertDepthMm, label: "pattern insert cutter" },
        { operation: "create-lead-in-cutter", diameterMm: input.leadInDiameterMm, depthMm: input.leadInDepthMm, label: "pattern lead-in cutter" },
      ];
      for (const center of input.entryCentersMm) {
        const cutterStart = subtract(center, scale(axis, input.overshootMm));
        for (const definition of cutterDefinitions) {
          const after = await this.operations.createCylinder(
            cutterStart,
            definition.diameterMm / 2,
            definition.depthMm + input.overshootMm,
            undefined,
            current.revision,
            axis,
          );
          const cutterId = requireSingleAddedBody(current, after, definition.label);
          cutterIds.push(cutterId);
          completedSteps.push(step(definition.operation, current, after, [cutterId]));
          current = after;
        }
      }

      const result = await this.operations.boolean(
        [input.targetId],
        cutterIds,
        "difference",
        false,
        current.revision,
      );
      const resultBodyIds = requireRecipeResult(initial, result, input.targetId, cutterIds);
      completedSteps.push(step("boolean-difference", current, result, resultBodyIds));
      current = result;

      return {
        recipe: "heat-set-insert-pocket-pattern",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        targetId: input.targetId,
        pocketCount: input.entryCentersMm.length,
        resultBodyIds,
        consumedToolIds: cutterIds,
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof HeatSetInsertPocketPatternRecipeError) throw error;
      throw new HeatSetInsertPocketPatternRecipeError(error, completedSteps, current.revision, totalSteps);
    }
  }

  async createScrewBoss(input: ScrewBossRecipeInput): Promise<ScrewBossRecipeResult> {
    validateScrewBoss(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.targetId, input.revision, "Screw boss");

    const axis = normalize(input.axis);
    const completedSteps: RecipeStep[] = [];
    const consumedToolIds: number[] = [];
    let current = initial;
    try {
      const boss = await this.operations.createCylinder(
        subtract(input.baseCenterMm, scale(axis, input.baseOverlapMm)),
        input.outerDiameterMm / 2,
        input.heightMm + input.baseOverlapMm,
        undefined,
        current.revision,
        axis,
      );
      const bossId = requireSingleAddedBody(current, boss, "screw boss body");
      consumedToolIds.push(bossId);
      completedSteps.push(step("create-boss-body", current, boss, [bossId]));
      current = boss;

      const united = await this.operations.boolean(
        [input.targetId],
        [bossId],
        "union",
        false,
        current.revision,
      );
      const unitedBodyIds = requireRecipeResult(initial, united, input.targetId, [bossId]);
      completedSteps.push(step("union-boss-to-target", current, united, unitedBodyIds));
      current = united;

      const top = add(input.baseCenterMm, scale(axis, input.heightMm + input.cutterOvershootMm));
      const inwardAxis = scale(axis, -1);
      const cutter = await this.operations.createCylinder(
        top,
        input.holeDiameterMm / 2,
        input.holeDepthMm + input.cutterOvershootMm,
        undefined,
        current.revision,
        inwardAxis,
      );
      const cutterId = requireSingleAddedBody(current, cutter, "screw boss hole cutter");
      consumedToolIds.push(cutterId);
      completedSteps.push(step("create-boss-hole-cutter", current, cutter, [cutterId]));
      current = cutter;

      const result = await this.operations.boolean(
        [input.targetId],
        [cutterId],
        "difference",
        false,
        current.revision,
      );
      const resultBodyIds = requireRecipeResult(initial, result, input.targetId, [cutterId]);
      completedSteps.push(step("boolean-difference", current, result, resultBodyIds));
      current = result;

      return {
        recipe: "screw-boss",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        targetId: input.targetId,
        resultBodyIds,
        consumedToolIds,
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof ScrewBossRecipeError) throw error;
      throw new ScrewBossRecipeError(error, completedSteps, current.revision);
    }
  }

  async createScrewBossPattern(input: ScrewBossPatternRecipeInput): Promise<ScrewBossPatternRecipeResult> {
    validateScrewBossPattern(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.targetId, input.revision, "Screw boss pattern");

    const axis = normalize(input.axis);
    const inwardAxis = scale(axis, -1);
    const completedSteps: RecipeStep[] = [];
    const bossIds: number[] = [];
    const cutterIds: number[] = [];
    const totalSteps = input.baseCentersMm.length * 2 + 2;
    let current = initial;
    try {
      for (const center of input.baseCentersMm) {
        const boss = await this.operations.createCylinder(
          subtract(center, scale(axis, input.baseOverlapMm)),
          input.outerDiameterMm / 2,
          input.heightMm + input.baseOverlapMm,
          undefined,
          current.revision,
          axis,
        );
        const bossId = requireSingleAddedBody(current, boss, "screw boss pattern body");
        bossIds.push(bossId);
        completedSteps.push(step("create-boss-body", current, boss, [bossId]));
        current = boss;
      }

      const united = await this.operations.boolean(
        [input.targetId],
        bossIds,
        "union",
        false,
        current.revision,
      );
      const unitedBodyIds = requireRecipeResult(initial, united, input.targetId, bossIds);
      completedSteps.push(step("union-boss-to-target", current, united, unitedBodyIds));
      current = united;

      for (const center of input.baseCentersMm) {
        const top = add(center, scale(axis, input.heightMm + input.cutterOvershootMm));
        const cutter = await this.operations.createCylinder(
          top,
          input.holeDiameterMm / 2,
          input.holeDepthMm + input.cutterOvershootMm,
          undefined,
          current.revision,
          inwardAxis,
        );
        const cutterId = requireSingleAddedBody(current, cutter, "screw boss pattern hole cutter");
        cutterIds.push(cutterId);
        completedSteps.push(step("create-boss-hole-cutter", current, cutter, [cutterId]));
        current = cutter;
      }

      const result = await this.operations.boolean(
        [input.targetId],
        cutterIds,
        "difference",
        false,
        current.revision,
      );
      const resultBodyIds = requireRecipeResult(initial, result, input.targetId, cutterIds);
      completedSteps.push(step("boolean-difference", current, result, resultBodyIds));
      current = result;

      return {
        recipe: "screw-boss-pattern",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        targetId: input.targetId,
        bossCount: input.baseCentersMm.length,
        resultBodyIds,
        consumedToolIds: [...bossIds, ...cutterIds],
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof ScrewBossPatternRecipeError) throw error;
      throw new ScrewBossPatternRecipeError(error, completedSteps, current.revision, totalSteps);
    }
  }

  async createRib(input: RibRecipeInput): Promise<RibRecipeResult> {
    validateRib(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.targetId, input.revision, "Rib");

    const completedSteps: RecipeStep[] = [];
    let current = initial;
    let profileBodyId = 0;
    let ribBodyId = 0;
    try {
      const beforeProfile = current;
      current = await this.operations.createPolyline(input.profilePointsMm, true, current.revision);
      profileBodyId = requireSingleAddedBody(beforeProfile, current, "rib profile", "Wire");
      const matchingRegions = current.regions.filter((region) => region.sketchWireIds.includes(profileBodyId));
      if (matchingRegions.length !== 1) {
        throw new Error(`Expected one closed Region for rib profile ${profileBodyId}, found ${matchingRegions.length}`);
      }
      completedSteps.push(step("create-rib-profile", beforeProfile, current, [profileBodyId]));

      const beforeExtrude = current;
      current = await this.operations.extrudeRegions([matchingRegions[0]!.id], input.thicknessMm, current.revision);
      ribBodyId = requireSingleAddedBody(beforeExtrude, current, "extruded rib");
      completedSteps.push(step("extrude-rib", beforeExtrude, current, [ribBodyId]));

      const beforeUnion = current;
      current = await this.operations.boolean([input.targetId], [ribBodyId], "union", false, current.revision);
      const resultBodyIds = requireRecipeResult(initial, current, input.targetId, [ribBodyId]);
      completedSteps.push(step("union-rib-to-target", beforeUnion, current, resultBodyIds));

      return {
        recipe: "rib",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        targetId: input.targetId,
        profileBodyId,
        resultBodyIds,
        consumedToolIds: [ribBodyId],
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof RibRecipeError) throw error;
      throw new RibRecipeError(error, completedSteps, current.revision);
    }
  }

  async createRoundVentArray(input: RoundVentArrayRecipeInput): Promise<RoundVentArrayRecipeResult> {
    validateRoundVentArray(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.targetId, input.revision, "Round vent array");

    const axis = normalize(input.axis);
    const direction1 = normalize(input.direction1);
    const direction2 = normalize(input.direction2);
    const cutterStart = subtract(input.firstCenterMm, scale(axis, input.overshootMm));
    const holeCount = input.count1 * input.count2;
    const totalSteps = holeCount > 1 ? 3 : 2;
    const completedSteps: RecipeStep[] = [];
    let current = initial;
    try {
      const beforeCutter = current;
      current = await this.operations.createCylinder(
        cutterStart,
        input.holeDiameterMm / 2,
        input.throughDepthMm + input.overshootMm * 2,
        undefined,
        current.revision,
        axis,
      );
      const seedId = requireSingleAddedBody(beforeCutter, current, "vent cutter");
      completedSteps.push(step("create-vent-cutter", beforeCutter, current, [seedId]));

      if (holeCount > 1) {
        const beforePattern = current;
        current = await this.operations.rectangularPattern(
          [seedId],
          direction1,
          input.count1,
          input.spacing1Mm,
          direction2,
          input.count2,
          input.spacing2Mm,
          current.revision,
        );
        const patternedIds = addedBodyIds(initial, current, "Solid");
        if (patternedIds.length !== holeCount) {
          throw new Error(`Expected ${holeCount} patterned vent cutters, found ${patternedIds.length}`);
        }
        completedSteps.push(step("pattern-vent-cutters", beforePattern, current, patternedIds));
      }

      const cutterIds = addedBodyIds(initial, current, "Solid");
      if (cutterIds.length !== holeCount) {
        throw new Error(`Expected ${holeCount} vent cutters before Boolean, found ${cutterIds.length}`);
      }
      const beforeBoolean = current;
      current = await this.operations.boolean([input.targetId], cutterIds, "difference", false, current.revision);
      const resultBodyIds = requireRecipeResult(initial, current, input.targetId, cutterIds);
      completedSteps.push(step("boolean-difference", beforeBoolean, current, resultBodyIds));

      return {
        recipe: "round-vent-array",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        targetId: input.targetId,
        resultBodyIds,
        consumedToolIds: cutterIds,
        holeCount,
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof RoundVentArrayRecipeError) throw error;
      throw new RoundVentArrayRecipeError(error, completedSteps, current.revision, totalSteps);
    }
  }

  async createCantileverSnapFit(input: CantileverSnapFitRecipeInput): Promise<CantileverSnapFitRecipeResult> {
    validateCantileverSnapFit(input);
    const beam = normalize(input.beamDirection);
    const thickness = normalize(input.thicknessDirection);
    const widthDirection = normalize(cross(beam, thickness));
    const profilePlaneOffset = scale(widthDirection, -input.widthMm / 2);
    const point = (along: number, above: number): Vector3 => add(
      add(input.baseCenterMm, scale(beam, along)),
      add(scale(thickness, above), profilePlaneOffset),
    );
    const profilePointsMm: Vector3[] = [
      point(-input.baseOverlapMm, 0),
      point(input.lengthMm, 0),
      point(input.lengthMm, input.thicknessMm + input.hookHeightMm),
      point(input.lengthMm - input.hookLengthMm, input.thicknessMm + input.hookHeightMm),
      point(input.lengthMm - input.hookLengthMm, input.thicknessMm),
      point(-input.baseOverlapMm, input.thicknessMm),
    ];
    try {
      const rib = await this.createRib({
        targetId: input.targetId,
        profilePointsMm,
        thicknessMm: input.widthMm,
        revision: input.revision,
      });
      const operationMap: Partial<Record<RecipeStep["operation"], RecipeStep["operation"]>> = {
        "create-rib-profile": "create-snap-profile",
        "extrude-rib": "extrude-snap-body",
        "union-rib-to-target": "union-snap-to-target",
      };
      const steps = rib.steps.map((entry) => ({ ...entry, operation: operationMap[entry.operation] ?? entry.operation }));
      return {
        recipe: "cantilever-snap-fit",
        status: "completed",
        documentToken: rib.documentToken,
        beforeRevision: rib.beforeRevision,
        afterRevision: rib.afterRevision,
        targetId: rib.targetId,
        profileBodyId: rib.profileBodyId,
        resultBodyIds: rib.resultBodyIds,
        consumedToolIds: rib.consumedToolIds,
        undoSteps: rib.undoSteps,
        steps,
      };
    } catch (error) {
      if (error instanceof CantileverSnapFitRecipeError) throw error;
      if (error instanceof RibRecipeError) {
        const operationMap: Partial<Record<RecipeStep["operation"], RecipeStep["operation"]>> = {
          "create-rib-profile": "create-snap-profile",
          "extrude-rib": "extrude-snap-body",
          "union-rib-to-target": "union-snap-to-target",
        };
        const steps = error.completedSteps.map((entry) => ({ ...entry, operation: operationMap[entry.operation] ?? entry.operation }));
        throw new CantileverSnapFitRecipeError(error, steps, error.lastConfirmedRevision);
      }
      throw new CantileverSnapFitRecipeError(error, [], input.revision);
    }
  }

  async createHingeBarrel(input: HingeBarrelRecipeInput): Promise<HingeBarrelRecipeResult> {
    validateHingeBarrel(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.targetId, input.revision, "Hinge barrel");

    const axis = normalize(input.axis);
    const completedSteps: RecipeStep[] = [];
    let current = initial;
    let barrelId = 0;
    let boreId = 0;
    try {
      const beforeBarrel = current;
      current = await this.operations.createCylinder(
        input.axisStartMm,
        input.outerDiameterMm / 2,
        input.lengthMm,
        undefined,
        current.revision,
        axis,
      );
      barrelId = requireSingleAddedBody(beforeBarrel, current, "hinge barrel");
      completedSteps.push(step("create-hinge-barrel", beforeBarrel, current, [barrelId]));

      const beforeBore = current;
      current = await this.operations.createCylinder(
        subtract(input.axisStartMm, scale(axis, input.cutterOvershootMm)),
        input.pinBoreDiameterMm / 2,
        input.lengthMm + input.cutterOvershootMm * 2,
        undefined,
        current.revision,
        axis,
      );
      boreId = requireSingleAddedBody(beforeBore, current, "hinge bore cutter");
      completedSteps.push(step("create-hinge-bore-cutter", beforeBore, current, [boreId]));

      const beforeHollow = current;
      current = await this.operations.boolean([barrelId], [boreId], "difference", false, current.revision);
      const hollowBodyIds = requireRecipeResult(initial, current, barrelId, [boreId]);
      completedSteps.push(step("hollow-hinge-barrel", beforeHollow, current, hollowBodyIds));

      const beforeUnion = current;
      current = await this.operations.boolean([input.targetId], [barrelId], "union", false, current.revision);
      const resultBodyIds = requireRecipeResult(initial, current, input.targetId, [barrelId]);
      completedSteps.push(step("union-hinge-to-target", beforeUnion, current, resultBodyIds));

      return {
        recipe: "hinge-barrel",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        targetId: input.targetId,
        resultBodyIds,
        consumedToolIds: [boreId, barrelId],
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof HingeBarrelRecipeError) throw error;
      throw new HingeBarrelRecipeError(error, completedSteps, current.revision);
    }
  }

  async cutCableChannel(input: CableChannelRecipeInput): Promise<CableChannelRecipeResult> {
    validateCableChannel(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.targetId, input.revision, "Cable channel");
    const invalidSpines = input.spineIds.filter((id) => initial.bodies.find((body) => body.id === id)?.type !== "Wire");
    if (invalidSpines.length > 0) throw new Error(`Cable channel requires current Wire spines: ${invalidSpines.join(", ")}`);

    const completedSteps: RecipeStep[] = [];
    let current = initial;
    try {
      const beforePipes = current;
      current = await this.operations.createPipes(input.spineIds, input.channelDiameterMm, 0, current.revision);
      const cutterIds = addedBodyIds(initial, current, "Solid");
      if (cutterIds.length !== input.spineIds.length) {
        throw new Error(`Expected ${input.spineIds.length} cable-channel cutters, found ${cutterIds.length}`);
      }
      completedSteps.push(step("create-cable-channel-cutters", beforePipes, current, cutterIds));

      const beforeBoolean = current;
      current = await this.operations.boolean([input.targetId], cutterIds, "difference", false, current.revision);
      const resultBodyIds = requireRecipeResult(initial, current, input.targetId, cutterIds);
      completedSteps.push(step("boolean-difference", beforeBoolean, current, resultBodyIds));

      return {
        recipe: "cable-channel",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        targetId: input.targetId,
        spineIds: [...input.spineIds],
        resultBodyIds,
        consumedToolIds: cutterIds,
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof CableChannelRecipeError) throw error;
      throw new CableChannelRecipeError(error, completedSteps, current.revision);
    }
  }

  async createConnectorOpening(input: ConnectorOpeningRecipeInput): Promise<ConnectorOpeningRecipeResult> {
    validateConnectorOpening(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.targetId, input.revision, "Connector opening");

    const axis = normalize(input.axis);
    const widthDirection = normalize(input.widthDirection);
    const heightDirection = normalize(cross(axis, widthDirection));
    const profileCenter = subtract(input.entryCenterMm, scale(axis, input.overshootMm));
    const halfWidth = scale(widthDirection, input.widthMm / 2);
    const halfHeight = scale(heightDirection, input.heightMm / 2);
    const profilePointsMm: Vector3[] = [
      subtract(subtract(profileCenter, halfWidth), halfHeight),
      subtract(add(profileCenter, halfWidth), halfHeight),
      add(add(profileCenter, halfWidth), halfHeight),
      add(subtract(profileCenter, halfWidth), halfHeight),
    ];
    const cutterDepthMm = input.throughDepthMm + input.overshootMm * 2;
    const totalSteps = input.cornerRadiusMm > 0 ? 4 : 3;
    const completedSteps: RecipeStep[] = [];
    let current = initial;
    let profileBodyId = 0;
    let cutterId = 0;
    try {
      const beforeProfile = current;
      current = await this.operations.createPolyline(profilePointsMm, true, current.revision);
      profileBodyId = requireSingleAddedBody(beforeProfile, current, "connector opening profile", "Wire");
      const matchingRegions = current.regions.filter((region) => region.sketchWireIds.includes(profileBodyId));
      if (matchingRegions.length !== 1) {
        throw new Error(`Expected one closed Region for connector opening profile ${profileBodyId}, found ${matchingRegions.length}`);
      }
      completedSteps.push(step("create-connector-profile", beforeProfile, current, [profileBodyId]));

      const beforeExtrude = current;
      current = await this.operations.extrudeRegions([matchingRegions[0]!.id], cutterDepthMm, current.revision);
      cutterId = requireSingleAddedBody(beforeExtrude, current, "connector opening cutter");
      completedSteps.push(step("extrude-connector-cutter", beforeExtrude, current, [cutterId]));

      if (input.cornerRadiusMm > 0) {
        const cutter = current.bodies.find((body) => body.id === cutterId);
        if (!cutter) throw new Error(`Connector opening cutter disappeared: ${cutterId}`);
        const longitudinalEdgeIds = cutter.edges.filter((edge) => {
          if (!edge.line) return false;
          const tangentLength = Math.hypot(...edge.tangent);
          return tangentLength > 1e-9 && Math.abs(Math.abs(dot(edge.tangent, axis) / tangentLength) - 1) < 1e-6;
        }).map((edge) => edge.id);
        if (longitudinalEdgeIds.length !== 4) {
          throw new Error(`Expected four longitudinal connector-cutter edges, found ${longitudinalEdgeIds.length}`);
        }
        const beforeRound = current;
        current = await this.operations.fillet(cutterId, longitudinalEdgeIds, input.cornerRadiusMm, current.revision);
        completedSteps.push(step("round-connector-cutter", beforeRound, current, [cutterId]));
      }

      const beforeBoolean = current;
      current = await this.operations.boolean([input.targetId], [cutterId], "difference", false, current.revision);
      const resultBodyIds = requireRecipeResult(initial, current, input.targetId, [cutterId]);
      completedSteps.push(step("boolean-difference", beforeBoolean, current, resultBodyIds));

      return {
        recipe: "connector-opening",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        targetId: input.targetId,
        profileBodyId,
        resultBodyIds,
        consumedToolIds: [cutterId],
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof ConnectorOpeningRecipeError) throw error;
      throw new ConnectorOpeningRecipeError(error, completedSteps, current.revision, totalSteps);
    }
  }

  async createMatingEnclosureJoint(input: MatingEnclosureJointRecipeInput): Promise<MatingEnclosureJointRecipeResult> {
    validateMatingEnclosureJoint(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.maleTargetId, input.revision, "Mating enclosure male half");
    requireCurrentSolid(initial, input.femaleTargetId, input.revision, "Mating enclosure female half");

    const maleOuterInset = input.wallThicknessMm - input.overlapMm;
    const maleInnerInset = input.wallThicknessMm + input.lipThicknessMm;
    const femaleOuterInset = input.wallThicknessMm - input.overlapMm - input.clearanceMm;
    const femaleInnerInset = input.wallThicknessMm + input.lipThicknessMm + input.clearanceMm;
    const maleOuterOrigin: Vector3 = add(input.seamOriginMm, [maleOuterInset, maleOuterInset, -input.overlapMm]);
    const maleOuterSize: Vector3 = [input.outerWidthMm - maleOuterInset * 2, input.outerDepthMm - maleOuterInset * 2, input.lipHeightMm + input.overlapMm];
    const maleInnerOrigin: Vector3 = add(input.seamOriginMm, [maleInnerInset, maleInnerInset, -input.overlapMm - input.cutterOvershootMm]);
    const maleInnerSize: Vector3 = [input.outerWidthMm - maleInnerInset * 2, input.outerDepthMm - maleInnerInset * 2, input.lipHeightMm + input.overlapMm + input.cutterOvershootMm * 2];
    const femaleOuterOrigin: Vector3 = add(input.seamOriginMm, [femaleOuterInset, femaleOuterInset, -input.cutterOvershootMm]);
    const femaleOuterSize: Vector3 = [input.outerWidthMm - femaleOuterInset * 2, input.outerDepthMm - femaleOuterInset * 2, input.lipHeightMm + input.cutterOvershootMm * 2];
    const femaleInnerOrigin: Vector3 = add(input.seamOriginMm, [femaleInnerInset, femaleInnerInset, -input.cutterOvershootMm * 2]);
    const femaleInnerSize: Vector3 = [input.outerWidthMm - femaleInnerInset * 2, input.outerDepthMm - femaleInnerInset * 2, input.lipHeightMm + input.cutterOvershootMm * 4];

    const completedSteps: RecipeStep[] = [];
    const consumedToolIds: number[] = [];
    let current = initial;
    try {
      const beforeMaleOuter = current;
      current = await this.operations.createBox(maleOuterOrigin, maleOuterSize, undefined, current.revision);
      const maleLipId = requireSingleAddedBody(beforeMaleOuter, current, "male lip outer");
      consumedToolIds.push(maleLipId);
      completedSteps.push(step("create-male-lip-outer", beforeMaleOuter, current, [maleLipId]));

      const beforeMaleInner = current;
      current = await this.operations.createBox(maleInnerOrigin, maleInnerSize, undefined, current.revision);
      const maleInnerId = requireSingleAddedBody(beforeMaleInner, current, "male lip inner cutter");
      consumedToolIds.push(maleInnerId);
      completedSteps.push(step("create-male-lip-inner", beforeMaleInner, current, [maleInnerId]));

      const beforeMaleRing = current;
      current = await this.operations.boolean([maleLipId], [maleInnerId], "difference", false, current.revision);
      requireSolid(current, maleLipId, "Male lip ring");
      requireAbsent(current, [maleInnerId], "Male lip inner cutter");
      completedSteps.push(step("form-male-lip", beforeMaleRing, current, [maleLipId]));

      const beforeMaleUnion = current;
      current = await this.operations.boolean([input.maleTargetId], [maleLipId], "union", false, current.revision);
      requireSolid(current, input.maleTargetId, "Mating enclosure male half");
      requireAbsent(current, [maleLipId], "Male lip ring");
      completedSteps.push(step("union-male-lip", beforeMaleUnion, current, [input.maleTargetId]));

      const beforeFemaleOuter = current;
      current = await this.operations.createBox(femaleOuterOrigin, femaleOuterSize, undefined, current.revision);
      const femaleGrooveId = requireSingleAddedBody(beforeFemaleOuter, current, "female groove outer cutter");
      consumedToolIds.push(femaleGrooveId);
      completedSteps.push(step("create-female-groove-outer", beforeFemaleOuter, current, [femaleGrooveId]));

      const beforeFemaleInner = current;
      current = await this.operations.createBox(femaleInnerOrigin, femaleInnerSize, undefined, current.revision);
      const femaleInnerId = requireSingleAddedBody(beforeFemaleInner, current, "female groove inner cutter");
      consumedToolIds.push(femaleInnerId);
      completedSteps.push(step("create-female-groove-inner", beforeFemaleInner, current, [femaleInnerId]));

      const beforeFemaleRing = current;
      current = await this.operations.boolean([femaleGrooveId], [femaleInnerId], "difference", false, current.revision);
      requireSolid(current, femaleGrooveId, "Female groove ring cutter");
      requireAbsent(current, [femaleInnerId], "Female groove inner cutter");
      completedSteps.push(step("form-female-groove", beforeFemaleRing, current, [femaleGrooveId]));

      const beforeFemaleCut = current;
      current = await this.operations.boolean([input.femaleTargetId], [femaleGrooveId], "difference", false, current.revision);
      const resultBodyIds = requirePairedSolidResult(initial, current, input.maleTargetId, input.femaleTargetId, consumedToolIds, "Mating enclosure joint");
      completedSteps.push(step("cut-female-groove", beforeFemaleCut, current, [input.femaleTargetId]));

      return {
        recipe: "mating-enclosure-joint",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        maleTargetId: input.maleTargetId,
        femaleTargetId: input.femaleTargetId,
        resultBodyIds,
        consumedToolIds,
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof MatingEnclosureJointRecipeError) throw error;
      throw new MatingEnclosureJointRecipeError(error, completedSteps, current.revision);
    }
  }

  async createLocatingPinPair(input: LocatingPinPairRecipeInput): Promise<LocatingPinPairRecipeResult> {
    validateLocatingPinPair(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.maleTargetId, input.revision, "Locating pin male half");
    requireCurrentSolid(initial, input.femaleTargetId, input.revision, "Locating pin female half");

    const axis = normalize(input.axis);
    const cutterStart = subtract(input.baseCenterMm, scale(axis, input.cutterOvershootMm));
    const completedSteps: RecipeStep[] = [];
    const consumedToolIds: number[] = [];
    let current = initial;
    try {
      const beforePin = current;
      current = await this.operations.createCylinder(
        subtract(input.baseCenterMm, scale(axis, input.baseOverlapMm)),
        input.pinDiameterMm / 2,
        input.pinHeightMm + input.baseOverlapMm,
        undefined,
        current.revision,
        axis,
      );
      const pinId = requireSingleAddedBody(beforePin, current, "locating pin");
      consumedToolIds.push(pinId);
      completedSteps.push(step("create-locating-pin", beforePin, current, [pinId]));

      const beforePinUnion = current;
      current = await this.operations.boolean([input.maleTargetId], [pinId], "union", false, current.revision);
      requireSolid(current, input.maleTargetId, "Locating pin male half");
      requireAbsent(current, [pinId], "Locating pin body");
      completedSteps.push(step("union-locating-pin", beforePinUnion, current, [input.maleTargetId]));

      const beforeSocket = current;
      current = await this.operations.createCylinder(
        cutterStart,
        input.pinDiameterMm / 2 + input.radialClearanceMm,
        input.pinHeightMm + input.axialClearanceMm + input.cutterOvershootMm,
        undefined,
        current.revision,
        axis,
      );
      const socketCutterId = requireSingleAddedBody(beforeSocket, current, "locating socket cutter");
      consumedToolIds.push(socketCutterId);
      completedSteps.push(step("create-locating-socket-cutter", beforeSocket, current, [socketCutterId]));

      const beforeSocketCut = current;
      current = await this.operations.boolean([input.femaleTargetId], [socketCutterId], "difference", false, current.revision);
      const resultBodyIds = requirePairedSolidResult(initial, current, input.maleTargetId, input.femaleTargetId, consumedToolIds, "Locating pin pair");
      completedSteps.push(step("cut-locating-socket", beforeSocketCut, current, [input.femaleTargetId]));

      return {
        recipe: "locating-pin-pair",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        maleTargetId: input.maleTargetId,
        femaleTargetId: input.femaleTargetId,
        resultBodyIds,
        consumedToolIds,
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof LocatingPinPairRecipeError) throw error;
      throw new LocatingPinPairRecipeError(error, completedSteps, current.revision);
    }
  }

  async createLocatingPinPairPattern(input: LocatingPinPairPatternRecipeInput): Promise<LocatingPinPairPatternRecipeResult> {
    validateLocatingPinPairPattern(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.maleTargetId, input.revision, "Locating pin male half");
    requireCurrentSolid(initial, input.femaleTargetId, input.revision, "Locating pin female half");

    const axis = normalize(input.axis);
    const completedSteps: RecipeStep[] = [];
    const pinIds: number[] = [];
    const socketCutterIds: number[] = [];
    const consumedToolIds: number[] = [];
    const totalSteps = input.baseCentersMm.length * 2 + 2;
    let current = initial;
    try {
      for (const baseCenterMm of input.baseCentersMm) {
        const beforePin = current;
        current = await this.operations.createCylinder(
          subtract(baseCenterMm, scale(axis, input.baseOverlapMm)),
          input.pinDiameterMm / 2,
          input.pinHeightMm + input.baseOverlapMm,
          undefined,
          current.revision,
          axis,
        );
        const pinId = requireSingleAddedBody(beforePin, current, "locating pin pattern body");
        pinIds.push(pinId);
        consumedToolIds.push(pinId);
        completedSteps.push(step("create-locating-pin", beforePin, current, [pinId]));
      }

      const beforePinUnion = current;
      current = await this.operations.boolean([input.maleTargetId], pinIds, "union", false, current.revision);
      requireSolid(current, input.maleTargetId, "Locating pin male half");
      requireAbsent(current, pinIds, "Locating pin pattern bodies");
      completedSteps.push(step("union-locating-pin", beforePinUnion, current, [input.maleTargetId]));

      for (const baseCenterMm of input.baseCentersMm) {
        const beforeSocket = current;
        current = await this.operations.createCylinder(
          subtract(baseCenterMm, scale(axis, input.cutterOvershootMm)),
          input.pinDiameterMm / 2 + input.radialClearanceMm,
          input.pinHeightMm + input.axialClearanceMm + input.cutterOvershootMm,
          undefined,
          current.revision,
          axis,
        );
        const socketCutterId = requireSingleAddedBody(beforeSocket, current, "locating socket pattern cutter");
        socketCutterIds.push(socketCutterId);
        consumedToolIds.push(socketCutterId);
        completedSteps.push(step("create-locating-socket-cutter", beforeSocket, current, [socketCutterId]));
      }

      const beforeSocketCut = current;
      current = await this.operations.boolean([input.femaleTargetId], socketCutterIds, "difference", false, current.revision);
      const resultBodyIds = requirePairedSolidResult(initial, current, input.maleTargetId, input.femaleTargetId, consumedToolIds, "Locating pin pattern");
      completedSteps.push(step("cut-locating-socket", beforeSocketCut, current, [input.femaleTargetId]));

      return {
        recipe: "locating-pin-pair-pattern",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        maleTargetId: input.maleTargetId,
        femaleTargetId: input.femaleTargetId,
        pinCount: input.baseCentersMm.length,
        resultBodyIds,
        consumedToolIds,
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof LocatingPinPairPatternRecipeError) throw error;
      throw new LocatingPinPairPatternRecipeError(error, completedSteps, current.revision, totalSteps);
    }
  }

  async createSplitScrewInsertJoint(input: SplitScrewInsertJointRecipeInput): Promise<SplitScrewInsertJointRecipeResult> {
    validateSplitScrewInsertJoint(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.maleTargetId, input.revision, "Split screw male half");
    requireCurrentSolid(initial, input.femaleTargetId, input.revision, "Split screw female half");

    const count = input.screwEntryCentersMm.length;
    const totalSteps = (count === 1 ? 2 : count + 1) + (count === 1 ? 4 : count * 3 + 1);
    const completedSteps: RecipeStep[] = [];
    const consumedToolIds: number[] = [];
    let currentRevision = initial.revision;
    let current = initial;
    try {
      const holes = count === 1
        ? await this.createThroughHole({
          targetId: input.maleTargetId,
          entryCenterMm: input.screwEntryCentersMm[0]!,
          axis: input.axis,
          holeDiameterMm: input.holeDiameterMm,
          throughDepthMm: input.maleThroughDepthMm,
          overshootMm: input.holeOvershootMm,
          revision: currentRevision,
        })
        : await this.createThroughHolePattern({
          targetId: input.maleTargetId,
          entryCentersMm: input.screwEntryCentersMm,
          axis: input.axis,
          holeDiameterMm: input.holeDiameterMm,
          throughDepthMm: input.maleThroughDepthMm,
          overshootMm: input.holeOvershootMm,
          revision: currentRevision,
        });
      completedSteps.push(...holes.steps);
      consumedToolIds.push(...holes.consumedToolIds);
      currentRevision = holes.afterRevision;
      current = await this.operations.state();
      if (current.revision !== currentRevision) throw new Error(`Plasticity changed after male clearance holes: expected ${currentRevision}, found ${current.revision}`);

      const pockets = count === 1
        ? await this.createHeatSetInsertPocket({
          targetId: input.femaleTargetId,
          entryCenterMm: input.insertEntryCentersMm[0]!,
          axis: input.axis,
          pilotDiameterMm: input.pilotDiameterMm,
          pilotDepthMm: input.pilotDepthMm,
          insertDiameterMm: input.insertDiameterMm,
          insertDepthMm: input.insertDepthMm,
          leadInDiameterMm: input.leadInDiameterMm,
          leadInDepthMm: input.leadInDepthMm,
          materialDepthMm: input.femaleMaterialDepthMm,
          overshootMm: input.insertOvershootMm,
          revision: currentRevision,
        })
        : await this.createHeatSetInsertPocketPattern({
          targetId: input.femaleTargetId,
          entryCentersMm: input.insertEntryCentersMm,
          axis: input.axis,
          pilotDiameterMm: input.pilotDiameterMm,
          pilotDepthMm: input.pilotDepthMm,
          insertDiameterMm: input.insertDiameterMm,
          insertDepthMm: input.insertDepthMm,
          leadInDiameterMm: input.leadInDiameterMm,
          leadInDepthMm: input.leadInDepthMm,
          materialDepthMm: input.femaleMaterialDepthMm,
          overshootMm: input.insertOvershootMm,
          revision: currentRevision,
        });
      completedSteps.push(...pockets.steps);
      consumedToolIds.push(...pockets.consumedToolIds);
      currentRevision = pockets.afterRevision;
      current = await this.operations.state();
      if (current.revision !== currentRevision) throw new Error(`Plasticity changed after insert pockets: expected ${currentRevision}, found ${current.revision}`);

      const resultBodyIds = requirePairedSolidResult(initial, current, input.maleTargetId, input.femaleTargetId, consumedToolIds, "Split screw-and-insert joint");
      return {
        recipe: "split-screw-insert-joint",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        maleTargetId: input.maleTargetId,
        femaleTargetId: input.femaleTargetId,
        fastenerDesignation: input.fastenerDesignation,
        insertPartNumber: input.insertPartNumber,
        insertThreadNominalDiameterMm: input.insertThreadNominalDiameterMm,
        insertThreadPitchMm: input.insertThreadPitchMm,
        insertSourceUrl: input.insertSourceUrl,
        fastenerCount: count,
        screwEngagementMm: input.screwLengthMm - input.maleThroughDepthMm,
        resultBodyIds,
        consumedToolIds,
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof SplitScrewInsertJointRecipeError) throw error;
      if (typeof error === "object" && error !== null) {
        const partial = error as { completedSteps?: unknown; lastConfirmedRevision?: unknown };
        if (Array.isArray(partial.completedSteps)) completedSteps.push(...partial.completedSteps as RecipeStep[]);
        if (typeof partial.lastConfirmedRevision === "string") currentRevision = partial.lastConfirmedRevision;
      }
      throw new SplitScrewInsertJointRecipeError(error, completedSteps, currentRevision, totalSteps);
    }
  }

  async createTongueGrooveJoint(input: TongueGrooveJointRecipeInput): Promise<TongueGrooveJointRecipeResult> {
    validateTongueGrooveJoint(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.tongueTargetId, input.revision, "Tongue target");
    requireCurrentSolid(initial, input.grooveTargetId, input.revision, "Groove target");

    const axis = normalize(input.axis);
    const widthDirection = normalize(input.widthDirection);
    const thicknessDirection = normalize(cross(axis, widthDirection));
    const tongueCenter = subtract(input.baseCenterMm, scale(axis, input.baseOverlapMm));
    const grooveCenter = subtract(input.baseCenterMm, scale(axis, input.cutterOvershootMm));
    const tonguePoints = rectanglePoints(tongueCenter, widthDirection, thicknessDirection, input.tongueWidthMm, input.tongueThicknessMm);
    const groovePoints = rectanglePoints(
      grooveCenter,
      widthDirection,
      thicknessDirection,
      input.tongueWidthMm + input.radialClearanceMm * 2,
      input.tongueThicknessMm + input.radialClearanceMm * 2,
    );
    const completedSteps: RecipeStep[] = [];
    const profileBodyIds: number[] = [];
    const consumedToolIds: number[] = [];
    let current = initial;
    try {
      const beforeTongueProfile = current;
      current = await this.operations.createPolyline(tonguePoints, true, current.revision);
      const tongueProfileId = requireSingleAddedBody(beforeTongueProfile, current, "tongue profile", "Wire");
      profileBodyIds.push(tongueProfileId);
      const tongueRegions = current.regions.filter((region) => region.sketchWireIds.includes(tongueProfileId));
      if (tongueRegions.length !== 1) throw new Error(`Expected one closed Region for tongue profile ${tongueProfileId}, found ${tongueRegions.length}`);
      completedSteps.push(step("create-tongue-profile", beforeTongueProfile, current, [tongueProfileId]));

      const beforeTongueExtrude = current;
      current = await this.operations.extrudeRegions([tongueRegions[0]!.id], input.tongueHeightMm + input.baseOverlapMm, current.revision);
      const tongueId = requireSingleAddedBody(beforeTongueExtrude, current, "tongue body");
      consumedToolIds.push(tongueId);
      completedSteps.push(step("extrude-tongue", beforeTongueExtrude, current, [tongueId]));

      const beforeTongueUnion = current;
      current = await this.operations.boolean([input.tongueTargetId], [tongueId], "union", false, current.revision);
      requireSolid(current, input.tongueTargetId, "Tongue target");
      requireAbsent(current, [tongueId], "Tongue body");
      completedSteps.push(step("union-tongue", beforeTongueUnion, current, [input.tongueTargetId]));

      const beforeGrooveProfile = current;
      current = await this.operations.createPolyline(groovePoints, true, current.revision);
      const grooveProfileId = requireSingleAddedBody(beforeGrooveProfile, current, "groove profile", "Wire");
      profileBodyIds.push(grooveProfileId);
      const grooveRegions = current.regions.filter((region) => region.sketchWireIds.includes(grooveProfileId));
      if (grooveRegions.length === 0) throw new Error(`Expected at least one closed Region for groove profile ${grooveProfileId}`);
      completedSteps.push(step("create-groove-profile", beforeGrooveProfile, current, [grooveProfileId]));

      const beforeGrooveExtrude = current;
      current = await this.operations.extrudeRegions(
        grooveRegions.map((region) => region.id),
        input.tongueHeightMm + input.axialClearanceMm + input.cutterOvershootMm,
        current.revision,
      );
      const grooveCutterId = requireSingleAddedBody(beforeGrooveExtrude, current, "groove cutter");
      consumedToolIds.push(grooveCutterId);
      completedSteps.push(step("extrude-groove-cutter", beforeGrooveExtrude, current, [grooveCutterId]));

      const beforeGrooveCut = current;
      current = await this.operations.boolean([input.grooveTargetId], [grooveCutterId], "difference", false, current.revision);
      const resultBodyIds = requirePairedSolidResult(initial, current, input.tongueTargetId, input.grooveTargetId, consumedToolIds, "Tongue and groove joint");
      completedSteps.push(step("cut-groove", beforeGrooveCut, current, [input.grooveTargetId]));

      return {
        recipe: "tongue-groove-joint",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        tongueTargetId: input.tongueTargetId,
        grooveTargetId: input.grooveTargetId,
        profileBodyIds,
        resultBodyIds,
        consumedToolIds,
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof TongueGrooveJointRecipeError) throw error;
      throw new TongueGrooveJointRecipeError(error, completedSteps, current.revision);
    }
  }

  async createDovetailJoint(input: DovetailJointRecipeInput): Promise<DovetailJointRecipeResult> {
    validateDovetailJoint(input);
    const initial = await this.operations.state();
    requireCurrentSolid(initial, input.maleTargetId, input.revision, "Dovetail male target");
    requireCurrentSolid(initial, input.femaleTargetId, input.revision, "Dovetail female target");

    const axis = normalize(input.axis);
    const widthDirection = normalize(input.widthDirection);
    const thicknessDirection = normalize(cross(axis, widthDirection));
    const maleCenter = subtract(input.baseCenterMm, scale(axis, input.baseOverlapMm));
    const femaleCenter = subtract(input.baseCenterMm, scale(axis, input.cutterOvershootMm));
    const malePoints = dovetailPoints(maleCenter, widthDirection, thicknessDirection, input.rootWidthMm, input.flareMm, input.tongueThicknessMm);
    const femalePoints = dovetailPoints(
      femaleCenter,
      widthDirection,
      thicknessDirection,
      input.rootWidthMm + input.radialClearanceMm * 2,
      input.flareMm,
      input.tongueThicknessMm + input.radialClearanceMm * 2,
    );
    const completedSteps: RecipeStep[] = [];
    const profileBodyIds: number[] = [];
    const consumedToolIds: number[] = [];
    let current = initial;
    try {
      const beforeMaleProfile = current;
      current = await this.operations.createPolyline(malePoints, true, current.revision);
      const maleProfileId = requireSingleAddedBody(beforeMaleProfile, current, "dovetail male profile", "Wire");
      profileBodyIds.push(maleProfileId);
      const maleRegion = selectProfileRegion(current, maleProfileId, malePoints, "dovetail male");
      completedSteps.push(step("create-dovetail-male-profile", beforeMaleProfile, current, [maleProfileId]));

      const beforeMaleExtrude = current;
      current = await this.operations.extrudeRegions([maleRegion.id], input.tongueHeightMm + input.baseOverlapMm, current.revision);
      const maleToolId = requireSingleAddedBody(beforeMaleExtrude, current, "dovetail male body");
      consumedToolIds.push(maleToolId);
      completedSteps.push(step("extrude-dovetail-male", beforeMaleExtrude, current, [maleToolId]));

      const beforeMaleUnion = current;
      current = await this.operations.boolean([input.maleTargetId], [maleToolId], "union", false, current.revision);
      requireSolid(current, input.maleTargetId, "Dovetail male target");
      requireAbsent(current, [maleToolId], "Dovetail male body");
      completedSteps.push(step("union-dovetail-male", beforeMaleUnion, current, [input.maleTargetId]));

      const beforeFemaleProfile = current;
      current = await this.operations.createPolyline(femalePoints, true, current.revision);
      const femaleProfileId = requireSingleAddedBody(beforeFemaleProfile, current, "dovetail female profile", "Wire");
      profileBodyIds.push(femaleProfileId);
      const femaleRegions = current.regions.filter((region) => region.sketchWireIds.includes(femaleProfileId));
      if (femaleRegions.length === 0) throw new Error(`Expected at least one closed Region for dovetail female profile ${femaleProfileId}`);
      completedSteps.push(step("create-dovetail-female-profile", beforeFemaleProfile, current, [femaleProfileId]));

      const beforeFemaleExtrude = current;
      current = await this.operations.extrudeRegions(femaleRegions.map((region) => region.id), input.tongueHeightMm + input.axialClearanceMm + input.cutterOvershootMm, current.revision);
      const femaleToolId = requireSingleAddedBody(beforeFemaleExtrude, current, "dovetail female cutter");
      consumedToolIds.push(femaleToolId);
      completedSteps.push(step("extrude-dovetail-female-cutter", beforeFemaleExtrude, current, [femaleToolId]));

      const beforeFemaleCut = current;
      current = await this.operations.boolean([input.femaleTargetId], [femaleToolId], "difference", false, current.revision);
      const resultBodyIds = requirePairedSolidResult(initial, current, input.maleTargetId, input.femaleTargetId, consumedToolIds, "Dovetail joint");
      completedSteps.push(step("cut-dovetail-female", beforeFemaleCut, current, [input.femaleTargetId]));

      return {
        recipe: "dovetail-joint",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        maleTargetId: input.maleTargetId,
        femaleTargetId: input.femaleTargetId,
        rootWidthMm: input.rootWidthMm,
        tipWidthMm: input.rootWidthMm + input.flareMm * 2,
        profileBodyIds,
        resultBodyIds,
        consumedToolIds,
        undoSteps: completedSteps.length,
        steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof DovetailJointRecipeError) throw error;
      throw new DovetailJointRecipeError(error, completedSteps, current.revision);
    }
  }
}

function validateCountersink(input: CountersinkRecipeInput): number {
  const depth = validateCountersinkGeometry(input);
  if (input.entryCenterMm.some((value) => !Number.isFinite(value))) throw new Error("Countersink entry center must contain finite values");
  return depth;
}

function validateCountersinkPattern(input: CountersinkPatternRecipeInput): number {
  if (input.entryCentersMm.length < 2 || input.entryCentersMm.length > 64) throw new Error("Countersink pattern requires between 2 and 64 entry centers");
  const depth = validateCountersinkGeometry(input);
  for (const center of input.entryCentersMm) {
    if (center.some((value) => !Number.isFinite(value))) throw new Error("Countersink pattern centers must contain finite values");
  }
  for (let first = 0; first < input.entryCentersMm.length; first += 1) {
    for (let second = first + 1; second < input.entryCentersMm.length; second += 1) {
      if (Math.hypot(...subtract(input.entryCentersMm[first]!, input.entryCentersMm[second]!)) <= 1e-9) {
        throw new Error(`Countersink pattern centers must be distinct: ${first} and ${second}`);
      }
    }
  }
  return depth;
}

function validateCountersinkGeometry(input: Omit<CountersinkRecipeInput, "entryCenterMm">): number {
  if (!Number.isInteger(input.targetId) || input.targetId <= 0) throw new Error("Countersink target ID must be a positive integer");
  for (const [name, value] of [
    ["through diameter", input.throughDiameterMm],
    ["major diameter", input.countersinkMajorDiameterMm],
    ["through depth", input.throughDepthMm],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Countersink ${name} must be positive`);
  }
  if (!Number.isFinite(input.includedAngleDeg) || input.includedAngleDeg <= 0 || input.includedAngleDeg >= 180) {
    throw new Error("Countersink included angle must be greater than 0 and less than 180 degrees");
  }
  if (!Number.isFinite(input.overshootMm) || input.overshootMm < 0) throw new Error("Countersink overshoot must be nonnegative");
  if (input.countersinkMajorDiameterMm <= input.throughDiameterMm) {
    throw new Error("Countersink major diameter must be greater than through diameter");
  }
  const axis = normalize(input.axis);
  const radial = normalize(input.radialDirection);
  if (Math.abs(dot(axis, radial)) > 1e-6) {
    throw new Error("Countersink radial direction must be perpendicular to its cutting axis");
  }
  const depth = (input.countersinkMajorDiameterMm - input.throughDiameterMm)
    / (2 * Math.tan(input.includedAngleDeg * Math.PI / 360));
  if (!Number.isFinite(depth) || depth <= 0 || depth >= input.throughDepthMm) {
    throw new Error("Countersink depth derived from diameters and included angle must be less than through depth");
  }
  return depth;
}

function validateHexNutPocket(input: HexNutPocketRecipeInput): void {
  validateHexNutPocketGeometry(input);
  if (input.entryCenterMm.some((value) => !Number.isFinite(value))) throw new Error("Hex nut pocket entry center must contain finite values");
}

function validateHexNutPocketPattern(input: HexNutPocketPatternRecipeInput): void {
  if (input.entryCentersMm.length < 2 || input.entryCentersMm.length > 128) throw new Error("Hex nut pocket pattern requires between 2 and 128 entry centers");
  validateHexNutPocketGeometry(input);
  for (const center of input.entryCentersMm) {
    if (center.some((value) => !Number.isFinite(value))) throw new Error("Hex nut pocket pattern centers must contain finite values");
  }
  for (let first = 0; first < input.entryCentersMm.length; first += 1) {
    for (let second = first + 1; second < input.entryCentersMm.length; second += 1) {
      if (Math.hypot(...subtract(input.entryCentersMm[first]!, input.entryCentersMm[second]!)) <= 1e-9) {
        throw new Error(`Hex nut pocket pattern centers must be distinct: ${first} and ${second}`);
      }
    }
  }
}

function validateHexNutPocketGeometry(input: Omit<HexNutPocketRecipeInput, "entryCenterMm">): void {
  if (!Number.isInteger(input.targetId) || input.targetId <= 0) throw new Error("Hex nut pocket target ID must be a positive integer");
  for (const [name, value] of [["across-flats size", input.acrossFlatsMm], ["depth", input.pocketDepthMm], ["material depth", input.materialDepthMm]] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Hex nut pocket ${name} must be positive`);
  }
  if (input.pocketDepthMm >= input.materialDepthMm) throw new Error("Hex nut pocket depth must be less than material depth");
  if (!Number.isFinite(input.overshootMm) || input.overshootMm < 0) throw new Error("Hex nut pocket overshoot must be nonnegative");
  const axis = normalize(input.axis);
  const flatNormal = normalize(input.flatNormalDirection);
  if (Math.abs(dot(axis, flatNormal)) > 1e-6) {
    throw new Error("Hex nut pocket flat normal direction must be perpendicular to its cutting axis");
  }
}

function validateSlottedHole(input: SlottedHoleRecipeInput): void {
  if (!Number.isInteger(input.targetId) || input.targetId <= 0) throw new Error("Slotted hole target ID must be a positive integer");
  if (input.entryCenterMm.some((value) => !Number.isFinite(value))) throw new Error("Slotted hole entry center must contain finite values");
  for (const [name, value] of [
    ["overall length", input.overallLengthMm],
    ["width", input.widthMm],
    ["through depth", input.throughDepthMm],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Slotted hole ${name} must be positive`);
  }
  if (input.overallLengthMm <= input.widthMm) throw new Error("Slotted hole overall length must be greater than width");
  if (!Number.isFinite(input.overshootMm) || input.overshootMm < 0) throw new Error("Slotted hole overshoot must be nonnegative");
  const axis = normalize(input.axis);
  const slotDirection = normalize(input.slotDirection);
  if (Math.abs(dot(axis, slotDirection)) > 1e-6) {
    throw new Error("Slotted hole direction must be perpendicular to its cutting axis");
  }
}

function validateSlottedHolePattern(input: SlottedHolePatternRecipeInput): void {
  if (input.entryCentersMm.length < 2 || input.entryCentersMm.length > 64) throw new Error("Slotted hole pattern requires between 2 and 64 entry centers");
  validateSlottedHole({ ...input, entryCenterMm: input.entryCentersMm[0]! });
  for (const center of input.entryCentersMm) {
    if (center.some((value) => !Number.isFinite(value))) throw new Error("Slotted hole pattern centers must contain finite values");
  }
  for (let first = 0; first < input.entryCentersMm.length; first += 1) {
    for (let second = first + 1; second < input.entryCentersMm.length; second += 1) {
      if (Math.hypot(...subtract(input.entryCentersMm[first]!, input.entryCentersMm[second]!)) <= 1e-9) {
        throw new Error(`Slotted hole pattern centers must be distinct: ${first} and ${second}`);
      }
    }
  }
}

function validateCounterbore(input: CounterboreRecipeInput): void {
  validateCounterboreGeometry(input);
  if (input.entryCenterMm.some((value) => !Number.isFinite(value))) throw new Error("Counterbore entry center must contain finite values");
}

function validateCounterboreGeometry(input: Omit<CounterboreRecipeInput, "entryCenterMm">): void {
  if (!Number.isInteger(input.targetId) || input.targetId <= 0) throw new Error("Counterbore target ID must be a positive integer");
  for (const [name, value] of [
    ["through diameter", input.throughDiameterMm],
    ["counterbore diameter", input.counterboreDiameterMm],
    ["counterbore depth", input.counterboreDepthMm],
    ["through depth", input.throughDepthMm],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Counterbore ${name} must be positive`);
  }
  if (!Number.isFinite(input.overshootMm) || input.overshootMm < 0) throw new Error("Counterbore overshoot must be nonnegative");
  if (input.counterboreDiameterMm <= input.throughDiameterMm) {
    throw new Error("Counterbore diameter must be greater than through diameter");
  }
  if (input.counterboreDepthMm >= input.throughDepthMm) {
    throw new Error("Counterbore depth must be less than through depth");
  }
  normalize(input.axis);
}

function validateCounterborePattern(input: CounterborePatternRecipeInput): void {
  if (input.entryCentersMm.length < 2 || input.entryCentersMm.length > 128) throw new Error("Counterbore pattern requires between 2 and 128 entry centers");
  validateCounterboreGeometry(input);
  for (const center of input.entryCentersMm) {
    if (center.some((value) => !Number.isFinite(value))) throw new Error("Counterbore pattern centers must contain finite values");
  }
  for (let first = 0; first < input.entryCentersMm.length; first += 1) {
    for (let second = first + 1; second < input.entryCentersMm.length; second += 1) {
      if (Math.hypot(...subtract(input.entryCentersMm[first]!, input.entryCentersMm[second]!)) <= 1e-9) {
        throw new Error(`Counterbore pattern centers must be distinct: ${first} and ${second}`);
      }
    }
  }
}

function validateThroughHole(input: ThroughHoleRecipeInput): void {
  if (!Number.isInteger(input.targetId) || input.targetId <= 0) throw new Error("Through-hole target ID must be a positive integer");
  if (input.entryCenterMm.some((value) => !Number.isFinite(value))) throw new Error("Through-hole entry center must contain finite values");
  for (const [name, value] of [
    ["diameter", input.holeDiameterMm],
    ["through depth", input.throughDepthMm],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Through-hole ${name} must be positive`);
  }
  if (!Number.isFinite(input.overshootMm) || input.overshootMm < 0) throw new Error("Through-hole overshoot must be nonnegative");
  normalize(input.axis);
}

function validateThroughHolePattern(input: ThroughHolePatternRecipeInput): void {
  if (!Number.isInteger(input.targetId) || input.targetId <= 0) throw new Error("Through-hole pattern target ID must be a positive integer");
  if (input.entryCentersMm.length < 2 || input.entryCentersMm.length > 256) throw new Error("Through-hole pattern requires between 2 and 256 entry centers");
  for (const center of input.entryCentersMm) {
    if (center.some((value) => !Number.isFinite(value))) throw new Error("Through-hole pattern centers must contain finite values");
  }
  for (let first = 0; first < input.entryCentersMm.length; first += 1) {
    for (let second = first + 1; second < input.entryCentersMm.length; second += 1) {
      if (Math.hypot(...subtract(input.entryCentersMm[first]!, input.entryCentersMm[second]!)) <= 1e-9) {
        throw new Error(`Through-hole pattern centers must be distinct: ${first} and ${second}`);
      }
    }
  }
  for (const [name, value] of [["diameter", input.holeDiameterMm], ["through depth", input.throughDepthMm]] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Through-hole pattern ${name} must be positive`);
  }
  if (!Number.isFinite(input.overshootMm) || input.overshootMm < 0) throw new Error("Through-hole pattern overshoot must be nonnegative");
  normalize(input.axis);
}

function validateBlindHole(input: BlindHoleRecipeInput): void {
  if (!Number.isInteger(input.targetId) || input.targetId <= 0) throw new Error("Blind-hole target ID must be a positive integer");
  if (input.entryCenterMm.some((value) => !Number.isFinite(value))) throw new Error("Blind-hole entry center must contain finite values");
  for (const [name, value] of [
    ["diameter", input.holeDiameterMm],
    ["depth", input.holeDepthMm],
    ["material depth", input.materialDepthMm],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Blind-hole ${name} must be positive`);
  }
  if (input.holeDepthMm >= input.materialDepthMm) throw new Error("Blind-hole depth must be less than material depth");
  if (!Number.isFinite(input.overshootMm) || input.overshootMm < 0) throw new Error("Blind-hole overshoot must be nonnegative");
  normalize(input.axis);
}

function validateBlindHolePattern(input: BlindHolePatternRecipeInput): void {
  if (!Number.isInteger(input.targetId) || input.targetId <= 0) throw new Error("Blind-hole pattern target ID must be a positive integer");
  if (input.entryCentersMm.length < 2 || input.entryCentersMm.length > 256) throw new Error("Blind-hole pattern requires between 2 and 256 entry centers");
  for (const center of input.entryCentersMm) {
    if (center.some((value) => !Number.isFinite(value))) throw new Error("Blind-hole pattern centers must contain finite values");
  }
  for (let first = 0; first < input.entryCentersMm.length; first += 1) {
    for (let second = first + 1; second < input.entryCentersMm.length; second += 1) {
      if (Math.hypot(...subtract(input.entryCentersMm[first]!, input.entryCentersMm[second]!)) <= 1e-9) {
        throw new Error(`Blind-hole pattern centers must be distinct: ${first} and ${second}`);
      }
    }
  }
  for (const [name, value] of [
    ["diameter", input.holeDiameterMm],
    ["depth", input.holeDepthMm],
    ["material depth", input.materialDepthMm],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Blind-hole pattern ${name} must be positive`);
  }
  if (input.holeDepthMm >= input.materialDepthMm) throw new Error("Blind-hole pattern depth must be less than material depth");
  if (!Number.isFinite(input.overshootMm) || input.overshootMm < 0) throw new Error("Blind-hole pattern overshoot must be nonnegative");
  normalize(input.axis);
}

function validateHeatSetInsertPocket(input: HeatSetInsertPocketRecipeInput): void {
  if (!Number.isInteger(input.targetId) || input.targetId <= 0) throw new Error("Heat-set insert pocket target ID must be a positive integer");
  for (const [name, value] of [
    ["pilot diameter", input.pilotDiameterMm],
    ["pilot depth", input.pilotDepthMm],
    ["insert diameter", input.insertDiameterMm],
    ["insert depth", input.insertDepthMm],
    ["lead-in diameter", input.leadInDiameterMm],
    ["lead-in depth", input.leadInDepthMm],
    ["material depth", input.materialDepthMm],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Heat-set insert pocket ${name} must be positive`);
  }
  if (!Number.isFinite(input.overshootMm) || input.overshootMm < 0) throw new Error("Heat-set insert pocket overshoot must be nonnegative");
  if (input.pilotDiameterMm >= input.insertDiameterMm) {
    throw new Error("Heat-set insert pocket pilot diameter must be less than insert diameter");
  }
  if (input.insertDiameterMm >= input.leadInDiameterMm) {
    throw new Error("Heat-set insert pocket insert diameter must be less than lead-in diameter");
  }
  if (input.leadInDepthMm >= input.insertDepthMm) {
    throw new Error("Heat-set insert pocket lead-in depth must be less than insert depth");
  }
  if (input.insertDepthMm >= input.pilotDepthMm) {
    throw new Error("Heat-set insert pocket insert depth must be less than pilot depth");
  }
  if (input.pilotDepthMm >= input.materialDepthMm) {
    throw new Error("Heat-set insert pocket pilot depth must be less than material depth");
  }
  normalize(input.axis);
}

function validateHeatSetInsertPocketPattern(input: HeatSetInsertPocketPatternRecipeInput): void {
  if (input.entryCentersMm.length < 2 || input.entryCentersMm.length > 64) throw new Error("Heat-set insert pocket pattern requires between 2 and 64 entry centers");
  validateHeatSetInsertPocket({ ...input, entryCenterMm: input.entryCentersMm[0]! });
  for (const center of input.entryCentersMm) {
    if (center.some((value) => !Number.isFinite(value))) throw new Error("Heat-set insert pocket pattern centers must contain finite values");
  }
  for (let first = 0; first < input.entryCentersMm.length; first += 1) {
    for (let second = first + 1; second < input.entryCentersMm.length; second += 1) {
      if (Math.hypot(...subtract(input.entryCentersMm[first]!, input.entryCentersMm[second]!)) <= 1e-9) {
        throw new Error(`Heat-set insert pocket pattern centers must be distinct: ${first} and ${second}`);
      }
    }
  }
}

function validateScrewBoss(input: ScrewBossRecipeInput): void {
  if (!Number.isInteger(input.targetId) || input.targetId <= 0) throw new Error("Screw boss target ID must be a positive integer");
  for (const [name, value] of [
    ["outer diameter", input.outerDiameterMm],
    ["height", input.heightMm],
    ["hole diameter", input.holeDiameterMm],
    ["hole depth", input.holeDepthMm],
    ["base overlap", input.baseOverlapMm],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Screw boss ${name} must be positive`);
  }
  if (!Number.isFinite(input.cutterOvershootMm) || input.cutterOvershootMm < 0) {
    throw new Error("Screw boss cutter overshoot must be nonnegative");
  }
  if (input.holeDiameterMm >= input.outerDiameterMm) {
    throw new Error("Screw boss hole diameter must be less than outer diameter");
  }
  if (input.holeDepthMm > input.heightMm) {
    throw new Error("Screw boss hole depth must not exceed boss height");
  }
  normalize(input.axis);
}

function validateScrewBossPattern(input: ScrewBossPatternRecipeInput): void {
  if (input.baseCentersMm.length < 2 || input.baseCentersMm.length > 64) throw new Error("Screw boss pattern requires between 2 and 64 base centers");
  validateScrewBoss({ ...input, baseCenterMm: input.baseCentersMm[0]! });
  for (const center of input.baseCentersMm) {
    if (center.some((value) => !Number.isFinite(value))) throw new Error("Screw boss pattern centers must contain finite values");
  }
  for (let first = 0; first < input.baseCentersMm.length; first += 1) {
    for (let second = first + 1; second < input.baseCentersMm.length; second += 1) {
      if (Math.hypot(...subtract(input.baseCentersMm[first]!, input.baseCentersMm[second]!)) <= 1e-9) {
        throw new Error(`Screw boss pattern centers must be distinct: ${first} and ${second}`);
      }
    }
  }
}

function validateRib(input: RibRecipeInput): void {
  if (!Number.isInteger(input.targetId) || input.targetId <= 0) throw new Error("Rib target ID must be a positive integer");
  if (!Number.isFinite(input.thicknessMm) || input.thicknessMm === 0) throw new Error("Rib thickness must be nonzero");
  if (input.profilePointsMm.length < 3) throw new Error("Rib profile requires at least three points");
  if (input.profilePointsMm.some((point) => point.some((value) => !Number.isFinite(value)))) {
    throw new Error("Rib profile points must contain finite values");
  }
  const origin = input.profilePointsMm[0]!;
  let normal: Vector3 | undefined;
  for (let first = 1; first < input.profilePointsMm.length - 1 && !normal; first += 1) {
    for (let second = first + 1; second < input.profilePointsMm.length && !normal; second += 1) {
      const candidate = cross(subtract(input.profilePointsMm[first]!, origin), subtract(input.profilePointsMm[second]!, origin));
      if (Math.hypot(...candidate) > 1e-9) normal = normalize(candidate);
    }
  }
  if (!normal) throw new Error("Rib profile points must define a non-collinear plane");
  const coplanarityToleranceMm = 1e-6;
  for (const point of input.profilePointsMm) {
    const distance = Math.abs(dot(subtract(point, origin), normal));
    if (distance > coplanarityToleranceMm) throw new Error("Rib profile points must be coplanar");
  }
}

function validateRoundVentArray(input: RoundVentArrayRecipeInput): void {
  if (!Number.isInteger(input.targetId) || input.targetId <= 0) throw new Error("Round vent array target ID must be a positive integer");
  for (const [name, value] of [
    ["hole diameter", input.holeDiameterMm],
    ["through depth", input.throughDepthMm],
    ["direction 1 spacing", input.spacing1Mm],
    ["direction 2 spacing", input.spacing2Mm],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Round vent array ${name} must be positive`);
  }
  for (const [name, count] of [["count 1", input.count1], ["count 2", input.count2]] as const) {
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error(`Round vent array ${name} must be an integer from 1 to 20`);
  }
  if (!Number.isFinite(input.overshootMm) || input.overshootMm < 0) throw new Error("Round vent array overshoot must be nonnegative");
  const axis = normalize(input.axis);
  const direction1 = normalize(input.direction1);
  const direction2 = normalize(input.direction2);
  if (Math.abs(dot(axis, direction1)) > 1e-6 || Math.abs(dot(axis, direction2)) > 1e-6) {
    throw new Error("Round vent array directions must lie in the entry plane perpendicular to the hole axis");
  }
  if (input.count1 > 1 && input.spacing1Mm <= input.holeDiameterMm) {
    throw new Error("Round vent array direction 1 spacing must exceed the hole diameter");
  }
  if (input.count2 > 1 && input.spacing2Mm <= input.holeDiameterMm) {
    throw new Error("Round vent array direction 2 spacing must exceed the hole diameter");
  }
  if (input.count2 > 1 && Math.abs(dot(direction1, direction2)) > 1 - 1e-9) {
    throw new Error("Round vent array pattern directions must not be parallel when direction 2 is active");
  }
}

function validateCantileverSnapFit(input: CantileverSnapFitRecipeInput): void {
  if (!Number.isInteger(input.targetId) || input.targetId <= 0) throw new Error("Cantilever snap-fit target ID must be a positive integer");
  for (const [name, value] of [
    ["length", input.lengthMm],
    ["width", input.widthMm],
    ["thickness", input.thicknessMm],
    ["hook length", input.hookLengthMm],
    ["hook height", input.hookHeightMm],
    ["base overlap", input.baseOverlapMm],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Cantilever snap-fit ${name} must be positive`);
  }
  if (input.hookLengthMm >= input.lengthMm) throw new Error("Cantilever snap-fit hook length must be less than beam length");
  const beam = normalize(input.beamDirection);
  const thickness = normalize(input.thicknessDirection);
  if (Math.abs(dot(beam, thickness)) > 1e-6) {
    throw new Error("Cantilever snap-fit beam and thickness directions must be perpendicular");
  }
}

function validateHingeBarrel(input: HingeBarrelRecipeInput): void {
  if (!Number.isInteger(input.targetId) || input.targetId <= 0) throw new Error("Hinge barrel target ID must be a positive integer");
  for (const [name, value] of [
    ["length", input.lengthMm],
    ["outer diameter", input.outerDiameterMm],
    ["pin bore diameter", input.pinBoreDiameterMm],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Hinge barrel ${name} must be positive`);
  }
  if (!Number.isFinite(input.cutterOvershootMm) || input.cutterOvershootMm < 0) {
    throw new Error("Hinge barrel cutter overshoot must be nonnegative");
  }
  if (input.pinBoreDiameterMm >= input.outerDiameterMm) {
    throw new Error("Hinge barrel pin bore diameter must be less than outer diameter");
  }
  normalize(input.axis);
}

function validateCableChannel(input: CableChannelRecipeInput): void {
  if (!Number.isInteger(input.targetId) || input.targetId <= 0) throw new Error("Cable channel target ID must be a positive integer");
  if (!Number.isFinite(input.channelDiameterMm) || input.channelDiameterMm <= 0) throw new Error("Cable channel diameter must be positive");
  if (input.spineIds.length === 0) throw new Error("Cable channel requires at least one spine");
  if (input.spineIds.some((id) => !Number.isInteger(id) || id <= 0)) throw new Error("Cable channel spine IDs must be positive integers");
  if (new Set(input.spineIds).size !== input.spineIds.length) throw new Error("Cable channel spine IDs must be unique");
  if (input.spineIds.includes(input.targetId)) throw new Error("Cable channel target must not also be a spine");
}

function validateConnectorOpening(input: ConnectorOpeningRecipeInput): void {
  if (!Number.isInteger(input.targetId) || input.targetId <= 0) throw new Error("Connector opening target ID must be a positive integer");
  if (input.entryCenterMm.some((value) => !Number.isFinite(value))) throw new Error("Connector opening entry center must contain finite values");
  for (const [name, value] of [
    ["width", input.widthMm],
    ["height", input.heightMm],
    ["through depth", input.throughDepthMm],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Connector opening ${name} must be positive`);
  }
  if (!Number.isFinite(input.cornerRadiusMm) || input.cornerRadiusMm < 0) throw new Error("Connector opening corner radius must be nonnegative");
  if (!Number.isFinite(input.overshootMm) || input.overshootMm < 0) throw new Error("Connector opening overshoot must be nonnegative");
  if (input.cornerRadiusMm >= Math.min(input.widthMm, input.heightMm) / 2) {
    throw new Error("Connector opening corner radius must be less than half its width and height");
  }
  const axis = normalize(input.axis);
  const widthDirection = normalize(input.widthDirection);
  if (Math.abs(dot(axis, widthDirection)) > 1e-6) {
    throw new Error("Connector opening width direction must be perpendicular to its cutting axis");
  }
}

function validateMatingEnclosureJoint(input: MatingEnclosureJointRecipeInput): void {
  if (!Number.isInteger(input.maleTargetId) || input.maleTargetId <= 0) throw new Error("Mating enclosure male target ID must be a positive integer");
  if (!Number.isInteger(input.femaleTargetId) || input.femaleTargetId <= 0) throw new Error("Mating enclosure female target ID must be a positive integer");
  if (input.maleTargetId === input.femaleTargetId) throw new Error("Mating enclosure halves must be different Solid bodies");
  if (input.seamOriginMm.some((value) => !Number.isFinite(value))) throw new Error("Mating enclosure seam origin must contain finite values");
  for (const [name, value] of [
    ["outer width", input.outerWidthMm],
    ["outer depth", input.outerDepthMm],
    ["wall thickness", input.wallThicknessMm],
    ["lip thickness", input.lipThicknessMm],
    ["lip height", input.lipHeightMm],
    ["overlap", input.overlapMm],
    ["cutter overshoot", input.cutterOvershootMm],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Mating enclosure ${name} must be positive`);
  }
  if (!Number.isFinite(input.clearanceMm) || input.clearanceMm < 0) throw new Error("Mating enclosure clearance must be nonnegative");
  if (input.wallThicknessMm <= input.overlapMm + input.clearanceMm) {
    throw new Error("Mating enclosure wall thickness must exceed overlap plus clearance");
  }
  const requiredInset = input.wallThicknessMm + input.lipThicknessMm + input.clearanceMm;
  if (input.outerWidthMm <= requiredInset * 2 || input.outerDepthMm <= requiredInset * 2) {
    throw new Error("Mating enclosure outer dimensions are too small for the wall, lip, and clearance");
  }
}

function validateLocatingPinPair(input: LocatingPinPairRecipeInput): void {
  if (!Number.isInteger(input.maleTargetId) || input.maleTargetId <= 0) throw new Error("Locating pin male target ID must be a positive integer");
  if (!Number.isInteger(input.femaleTargetId) || input.femaleTargetId <= 0) throw new Error("Locating pin female target ID must be a positive integer");
  if (input.maleTargetId === input.femaleTargetId) throw new Error("Locating pin halves must be different Solid bodies");
  if (input.baseCenterMm.some((value) => !Number.isFinite(value))) throw new Error("Locating pin base center must contain finite values");
  for (const [name, value] of [
    ["diameter", input.pinDiameterMm],
    ["height", input.pinHeightMm],
    ["base overlap", input.baseOverlapMm],
    ["cutter overshoot", input.cutterOvershootMm],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Locating pin ${name} must be positive`);
  }
  if (!Number.isFinite(input.radialClearanceMm) || input.radialClearanceMm < 0) throw new Error("Locating pin radial clearance must be nonnegative");
  if (!Number.isFinite(input.axialClearanceMm) || input.axialClearanceMm < 0) throw new Error("Locating pin axial clearance must be nonnegative");
  normalize(input.axis);
}

function validateLocatingPinPairPattern(input: LocatingPinPairPatternRecipeInput): void {
  if (input.baseCentersMm.length < 2 || input.baseCentersMm.length > 64) throw new Error("Locating pin pattern requires 2-64 base centers");
  validateLocatingPinPair({ ...input, baseCenterMm: input.baseCentersMm[0] ?? [Number.NaN, Number.NaN, Number.NaN] });
  for (const [index, center] of input.baseCentersMm.entries()) {
    if (center.some((value) => !Number.isFinite(value))) throw new Error(`Locating pin base center ${index} must contain finite values`);
    for (let previous = 0; previous < index; previous += 1) {
      const priorCenter = input.baseCentersMm[previous]!;
      if (Math.hypot(...center.map((value, axisIndex) => value - priorCenter[axisIndex]!)) <= 1e-9) {
        throw new Error(`Locating pin base centers must be distinct; index ${index} duplicates index ${previous}`);
      }
    }
  }
}

function validateSplitScrewInsertJoint(input: SplitScrewInsertJointRecipeInput): void {
  if (!Number.isInteger(input.maleTargetId) || input.maleTargetId <= 0) throw new Error("Split screw male target ID must be a positive integer");
  if (!Number.isInteger(input.femaleTargetId) || input.femaleTargetId <= 0) throw new Error("Split screw female target ID must be a positive integer");
  if (input.maleTargetId === input.femaleTargetId) throw new Error("Split screw halves must be different Solid bodies");
  if (input.screwEntryCentersMm.length < 1 || input.screwEntryCentersMm.length > 64) throw new Error("Split screw-and-insert joint requires 1-64 matched stations");
  if (input.screwEntryCentersMm.length !== input.insertEntryCentersMm.length) throw new Error("Split screw and insert center counts must match");
  if (!input.fastenerDesignation.trim()) throw new Error("Split screw-and-insert joint requires a resolved fastener designation");
  if (!input.insertPartNumber.trim()) throw new Error("Split screw-and-insert joint requires the exact insert part number");
  let insertSource: URL;
  try {
    insertSource = new URL(input.insertSourceUrl);
  } catch {
    throw new Error("Split screw-and-insert joint requires a manufacturer or qualified insert source URL");
  }
  if (insertSource.protocol !== "https:") throw new Error("Insert source URL must use HTTPS");

  for (const [name, value] of [
    ["screw length", input.screwLengthMm],
    ["minimum engagement", input.minimumEngagementMm],
    ["maximum engagement", input.maximumEngagementMm],
    ["insert thread nominal diameter", input.insertThreadNominalDiameterMm],
    ["insert thread pitch", input.insertThreadPitchMm],
    ["hole diameter", input.holeDiameterMm],
    ["male through depth", input.maleThroughDepthMm],
    ["pilot diameter", input.pilotDiameterMm],
    ["pilot depth", input.pilotDepthMm],
    ["insert diameter", input.insertDiameterMm],
    ["insert depth", input.insertDepthMm],
    ["lead-in diameter", input.leadInDiameterMm],
    ["lead-in depth", input.leadInDepthMm],
    ["female material depth", input.femaleMaterialDepthMm],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Split screw ${name} must be positive`);
  }
  for (const [name, value] of [["hole overshoot", input.holeOvershootMm], ["insert overshoot", input.insertOvershootMm]] as const) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Split screw ${name} must be nonnegative`);
  }
  if (input.minimumEngagementMm > input.maximumEngagementMm) throw new Error("Minimum screw engagement must not exceed maximum engagement");
  const screwEngagementMm = input.screwLengthMm - input.maleThroughDepthMm;
  if (screwEngagementMm < input.minimumEngagementMm - 1e-9 || screwEngagementMm > input.maximumEngagementMm + 1e-9) {
    throw new Error(`Resolved screw length provides ${screwEngagementMm} mm engagement, outside the explicit ${input.minimumEngagementMm}-${input.maximumEngagementMm} mm insert range`);
  }
  if (input.maximumEngagementMm > input.insertDepthMm - input.leadInDepthMm + 1e-9) {
    throw new Error("Maximum screw engagement exceeds the insert pocket depth after its lead-in");
  }

  const axis = normalize(input.axis);
  validateThroughHole({
    targetId: input.maleTargetId,
    entryCenterMm: input.screwEntryCentersMm[0]!,
    axis,
    holeDiameterMm: input.holeDiameterMm,
    throughDepthMm: input.maleThroughDepthMm,
    overshootMm: input.holeOvershootMm,
    revision: input.revision,
  });
  validateHeatSetInsertPocket({
    targetId: input.femaleTargetId,
    entryCenterMm: input.insertEntryCentersMm[0]!,
    axis,
    pilotDiameterMm: input.pilotDiameterMm,
    pilotDepthMm: input.pilotDepthMm,
    insertDiameterMm: input.insertDiameterMm,
    insertDepthMm: input.insertDepthMm,
    leadInDiameterMm: input.leadInDiameterMm,
    leadInDepthMm: input.leadInDepthMm,
    materialDepthMm: input.femaleMaterialDepthMm,
    overshootMm: input.insertOvershootMm,
    revision: input.revision,
  });

  for (let index = 0; index < input.screwEntryCentersMm.length; index += 1) {
    const screwCenter = input.screwEntryCentersMm[index]!;
    const insertCenter = input.insertEntryCentersMm[index]!;
    const delta = subtract(insertCenter, screwCenter);
    const axialDistance = dot(delta, axis);
    const lateralDistance = Math.hypot(...subtract(delta, scale(axis, axialDistance)));
    if (axialDistance <= 0 || lateralDistance > 0.01 || Math.abs(axialDistance - input.maleThroughDepthMm) > 0.01) {
      throw new Error(`Split screw and insert centers must be coaxial and separated by the measured male through-depth within 0.01 mm (station ${index})`);
    }
    if (screwCenter.some((value) => !Number.isFinite(value)) || insertCenter.some((value) => !Number.isFinite(value))) {
      throw new Error(`Split screw-and-insert station ${index} must contain finite coordinates`);
    }
    for (let previous = 0; previous < index; previous += 1) {
      if (Math.hypot(...subtract(screwCenter, input.screwEntryCentersMm[previous]!)) <= 1e-9
        || Math.hypot(...subtract(insertCenter, input.insertEntryCentersMm[previous]!)) <= 1e-9) {
        throw new Error(`Split screw-and-insert centers must be distinct; station ${index} duplicates station ${previous}`);
      }
    }
  }
}

function validateTongueGrooveJoint(input: TongueGrooveJointRecipeInput): void {
  if (!Number.isInteger(input.tongueTargetId) || input.tongueTargetId <= 0) throw new Error("Tongue target ID must be a positive integer");
  if (!Number.isInteger(input.grooveTargetId) || input.grooveTargetId <= 0) throw new Error("Groove target ID must be a positive integer");
  if (input.tongueTargetId === input.grooveTargetId) throw new Error("Tongue and groove targets must be different Solid bodies");
  if (input.baseCenterMm.some((value) => !Number.isFinite(value))) throw new Error("Tongue and groove base center must contain finite values");
  for (const [name, value] of [
    ["tongue width", input.tongueWidthMm],
    ["tongue thickness", input.tongueThicknessMm],
    ["tongue height", input.tongueHeightMm],
    ["base overlap", input.baseOverlapMm],
    ["cutter overshoot", input.cutterOvershootMm],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Tongue and groove ${name} must be positive`);
  }
  if (!Number.isFinite(input.radialClearanceMm) || input.radialClearanceMm < 0) throw new Error("Tongue and groove radial clearance must be nonnegative");
  if (!Number.isFinite(input.axialClearanceMm) || input.axialClearanceMm < 0) throw new Error("Tongue and groove axial clearance must be nonnegative");
  const axis = normalize(input.axis);
  const widthDirection = normalize(input.widthDirection);
  if (Math.abs(dot(axis, widthDirection)) > 1e-6) throw new Error("Tongue and groove width direction must be perpendicular to the mating axis");
}

function validateDovetailJoint(input: DovetailJointRecipeInput): void {
  if (!Number.isInteger(input.maleTargetId) || input.maleTargetId <= 0) throw new Error("Dovetail male target ID must be a positive integer");
  if (!Number.isInteger(input.femaleTargetId) || input.femaleTargetId <= 0) throw new Error("Dovetail female target ID must be a positive integer");
  if (input.maleTargetId === input.femaleTargetId) throw new Error("Dovetail halves must be different Solid bodies");
  if (input.baseCenterMm.some((value) => !Number.isFinite(value))) throw new Error("Dovetail base center must contain finite values");
  for (const [name, value] of [
    ["root width", input.rootWidthMm],
    ["flare", input.flareMm],
    ["tongue thickness", input.tongueThicknessMm],
    ["tongue height", input.tongueHeightMm],
    ["base overlap", input.baseOverlapMm],
    ["cutter overshoot", input.cutterOvershootMm],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Dovetail ${name} must be positive`);
  }
  if (!Number.isFinite(input.radialClearanceMm) || input.radialClearanceMm < 0) throw new Error("Dovetail radial clearance must be nonnegative");
  if (!Number.isFinite(input.axialClearanceMm) || input.axialClearanceMm < 0) throw new Error("Dovetail axial clearance must be nonnegative");
  const axis = normalize(input.axis);
  const widthDirection = normalize(input.widthDirection);
  if (Math.abs(dot(axis, widthDirection)) > 1e-6) throw new Error("Dovetail width direction must be perpendicular to the mating axis");
}

function requireCurrentSolid(state: RuntimeState, targetId: number, revision: string, operation: string): void {
  if (state.revision !== revision) {
    throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
  }
  const target = state.bodies.find((body) => body.id === targetId);
  if (!target) throw new Error(`Unknown target body ID: ${targetId}`);
  if (target.type !== "Solid") throw new Error(`${operation} target must be a Solid: ${targetId}`);
}

function requireSingleAddedBody(before: RuntimeState, after: RuntimeState, label: string, type = "Solid"): number {
  requireSameDocument(before, after);
  const beforeIds = new Set(before.bodies.map((body) => body.id));
  const added = after.bodies.filter((body) => !beforeIds.has(body.id));
  if (added.length !== 1 || added[0]!.type !== type) {
    throw new Error(`Expected one ${type} ${label}, found ${added.length}`);
  }
  return added[0]!.id;
}

function addedBodyIds(before: RuntimeState, after: RuntimeState, type: string): number[] {
  requireSameDocument(before, after);
  const beforeIds = new Set(before.bodies.map((body) => body.id));
  return after.bodies.filter((body) => !beforeIds.has(body.id) && body.type === type).map((body) => body.id).sort((left, right) => left - right);
}

function requireRecipeResult(initial: RuntimeState, after: RuntimeState, targetId: number, cutterIds: number[]): number[] {
  requireSameDocument(initial, after);
  const remainingIds = new Set(after.bodies.map((body) => body.id));
  const unmodifiedContextIds = initial.bodies.filter((body) => body.id !== targetId).map((body) => body.id);
  const missingContext = unmodifiedContextIds.filter((id) => !remainingIds.has(id));
  if (missingContext.length > 0) throw new Error(`Recipe changed unrelated bodies: ${missingContext.join(", ")}`);
  const remainingCutters = cutterIds.filter((id) => remainingIds.has(id));
  if (remainingCutters.length > 0) throw new Error(`Recipe cutters were not consumed: ${remainingCutters.join(", ")}`);
  const context = new Set(unmodifiedContextIds);
  const results = after.bodies.filter((body) => !context.has(body.id) && body.type === "Solid").map((body) => body.id);
  if (results.length !== 1) throw new Error(`Expected one Solid recipe result, found ${results.length}`);
  return results;
}

function requireSolid(state: RuntimeState, id: number, label: string): void {
  if (state.bodies.find((body) => body.id === id)?.type !== "Solid") throw new Error(`${label} is not a current Solid: ${id}`);
}

function requireAbsent(state: RuntimeState, ids: number[], label: string): void {
  const remaining = ids.filter((id) => state.bodies.some((body) => body.id === id));
  if (remaining.length > 0) throw new Error(`${label} was not consumed: ${remaining.join(", ")}`);
}

function requirePairedSolidResult(
  initial: RuntimeState,
  after: RuntimeState,
  firstTargetId: number,
  secondTargetId: number,
  consumedToolIds: number[],
  label: string,
): number[] {
  requireSameDocument(initial, after);
  requireSolid(after, firstTargetId, `${label} first target`);
  requireSolid(after, secondTargetId, `${label} second target`);
  requireAbsent(after, consumedToolIds, `${label} temporary geometry`);
  const targetIds = new Set([firstTargetId, secondTargetId]);
  const remainingIds = new Set(after.bodies.map((body) => body.id));
  const missingContext = initial.bodies.filter((body) => !targetIds.has(body.id) && !remainingIds.has(body.id)).map((body) => body.id);
  if (missingContext.length > 0) throw new Error(`${label} recipe changed unrelated bodies: ${missingContext.join(", ")}`);
  return [firstTargetId, secondTargetId];
}

function requireSameDocument(before: RuntimeState, after: RuntimeState): void {
  if (before.documentToken !== after.documentToken) throw new Error("Plasticity document changed during recipe execution");
}

function step(operation: RecipeStep["operation"], before: RuntimeState, after: RuntimeState, affectedBodyIds: number[]): RecipeStep {
  requireSameDocument(before, after);
  return { operation, beforeRevision: before.revision, afterRevision: after.revision, affectedBodyIds };
}

function rectanglePoints(center: Vector3, widthDirection: Vector3, heightDirection: Vector3, widthMm: number, heightMm: number): Vector3[] {
  const halfWidth = scale(widthDirection, widthMm / 2);
  const halfHeight = scale(heightDirection, heightMm / 2);
  return [
    subtract(subtract(center, halfWidth), halfHeight),
    subtract(add(center, halfWidth), halfHeight),
    add(add(center, halfWidth), halfHeight),
    add(subtract(center, halfWidth), halfHeight),
  ];
}

function dovetailPoints(center: Vector3, widthDirection: Vector3, heightDirection: Vector3, rootWidthMm: number, flareMm: number, thicknessMm: number): Vector3[] {
  const rootHalf = scale(widthDirection, rootWidthMm / 2);
  const tipHalf = scale(widthDirection, rootWidthMm / 2 + flareMm);
  const halfThickness = scale(heightDirection, thicknessMm / 2);
  return [
    subtract(subtract(center, rootHalf), halfThickness),
    subtract(add(center, rootHalf), halfThickness),
    add(add(center, tipHalf), halfThickness),
    add(subtract(center, tipHalf), halfThickness),
  ];
}

function selectProfileRegion(state: RuntimeState, profileBodyId: number, profilePointsMm: Vector3[], label: string): RuntimeState["regions"][number] {
  const candidates = state.regions.filter((region) => region.sketchWireIds.includes(profileBodyId));
  const expected = pointBounds(profilePointsMm);
  const matching = candidates.filter((region) => boundsNear(region.displayBoundsMm, expected, 0.05));
  if (matching.length !== 1) {
    throw new Error(`Expected one closed Region matching ${label} profile ${profileBodyId}, found ${matching.length} of ${candidates.length} candidates`);
  }
  return matching[0]!;
}

function pointBounds(points: Vector3[]): { min: Vector3; max: Vector3 } {
  return {
    min: [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis]!))) as Vector3,
    max: [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis]!))) as Vector3,
  };
}

function boundsNear(actual: { min: Vector3; max: Vector3 }, expected: { min: Vector3; max: Vector3 }, toleranceMm: number): boolean {
  return [0, 1, 2].every((axis) => Math.abs(actual.min[axis]! - expected.min[axis]!) <= toleranceMm
    && Math.abs(actual.max[axis]! - expected.max[axis]!) <= toleranceMm);
}

function normalize(vector: Vector3): Vector3 {
  if (vector.some((value) => !Number.isFinite(value))) throw new Error("Recipe axis must contain finite values");
  const length = Math.hypot(...vector);
  if (!(length > 1e-9)) throw new Error("Recipe axis must be nonzero");
  return vector.map((value) => value / length) as Vector3;
}

function scale(vector: Vector3, factor: number): Vector3 {
  return vector.map((value) => {
    const result = value * factor;
    return Object.is(result, -0) ? 0 : result;
  }) as Vector3;
}

function subtract(left: Vector3, right: Vector3): Vector3 {
  return left.map((value, index) => value - right[index]!) as Vector3;
}

function add(left: Vector3, right: Vector3): Vector3 {
  return left.map((value, index) => value + right[index]!) as Vector3;
}

function dot(left: Vector3, right: Vector3): number {
  return left.reduce((sum, value, index) => sum + value * right[index]!, 0);
}

function cross(left: Vector3, right: Vector3): Vector3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}
