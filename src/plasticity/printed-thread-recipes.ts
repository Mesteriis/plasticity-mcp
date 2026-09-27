import { add, cross, normalize, scale, subtract, type Vector3 } from "./construction.ts";
import type { PlasticityOperations } from "./operations.ts";
import { mutationOutcomeIsUncertain, type RuntimeState } from "./runtime.ts";

export type PrintedThreadHandedness = "right" | "left";

interface PrintedThreadDefinition {
  nominalDiameterMm: number;
  pitchMm: number;
  threadDepthMm: number;
  handedness: PrintedThreadHandedness;
  radialDirection: Vector3;
}

export interface PrintedExternalThreadInput extends PrintedThreadDefinition {
  axisStartMm: Vector3;
  axis: Vector3;
  threadLengthMm: number;
  name?: string | undefined;
  revision: string;
}

export interface PrintedInternalThreadInput extends PrintedThreadDefinition {
  targetId: number;
  entryCenterMm: Vector3;
  axis: Vector3;
  materialDepthMm: number;
  profileClearanceMm: number;
  cutterOvershootMm: number;
  revision: string;
}

export interface PrintedHexNutInput extends PrintedThreadDefinition {
  entryCenterMm: Vector3;
  axis: Vector3;
  flatNormalDirection: Vector3;
  acrossFlatsMm: number;
  thicknessMm: number;
  minimumWallThicknessMm: number;
  profileClearanceMm: number;
  cutterOvershootMm: number;
  revision: string;
}

export interface PrintedHexScrewInput extends PrintedExternalThreadInput {
  flatNormalDirection: Vector3;
  headAcrossFlatsMm: number;
  headHeightMm: number;
  junctionOverlapMm: number;
}

export interface PrintedHexPairInput extends PrintedThreadDefinition {
  screwAxisStartMm: Vector3;
  nutEntryCenterMm: Vector3;
  axis: Vector3;
  threadLengthMm: number;
  flatNormalDirection: Vector3;
  screwHeadAcrossFlatsMm: number;
  screwHeadHeightMm: number;
  screwJunctionOverlapMm: number;
  nutAcrossFlatsMm: number;
  nutThicknessMm: number;
  nutMinimumWallThicknessMm: number;
  profileClearanceMm: number;
  cutterOvershootMm: number;
  screwName?: string | undefined;
  revision: string;
}

export interface PrintedThreadCalibrationSampleInput {
  id: string;
  nutEntryCenterMm: Vector3;
  profileClearanceMm: number;
}

export interface PrintedThreadCalibrationInput extends PrintedThreadDefinition {
  screwAxisStartMm: Vector3;
  axis: Vector3;
  threadLengthMm: number;
  flatNormalDirection: Vector3;
  screwHeadAcrossFlatsMm: number;
  screwHeadHeightMm: number;
  screwJunctionOverlapMm: number;
  nutAcrossFlatsMm: number;
  nutThicknessMm: number;
  nutMinimumWallThicknessMm: number;
  cutterOvershootMm: number;
  screwName?: string | undefined;
  samples: PrintedThreadCalibrationSampleInput[];
  revision: string;
}

export interface PrintedThreadGeometry {
  profile: "rounded-print-v1";
  nominalCrestDiameterMm: number;
  coreDiameterMm: number;
  helixDiameterMm: number;
  maleProfileDiameterMm: number;
  femaleBoreDiameterMm: number;
  femaleGrooveDiameterMm: number;
  femaleGrooveOuterDiameterMm: number;
  pitchMm: number;
  profileClearanceMm: number;
}

export interface PrintedThreadStep {
  operation:
    | "create-thread-core"
    | "create-thread-helix"
    | "create-thread-ridge"
    | "union-thread-ridge"
    | "create-thread-envelope"
    | "clip-thread-envelope"
    | "create-thread-bore-cutter"
    | "create-thread-groove-cutter"
    | "cut-internal-thread"
    | "create-nut-profile"
    | "extrude-nut-blank"
    | "create-screw-head-profile"
    | "extrude-screw-head"
    | "union-screw-head";
  beforeRevision: string;
  afterRevision: string;
  affectedBodyIds: number[];
}

export interface PrintedExternalThreadResult {
  recipe: "printed-external-thread";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  resultBodyId: number;
  helixBodyId: number;
  consumedToolIds: number[];
  turns: number;
  geometry: PrintedThreadGeometry;
  undoSteps: number;
  steps: PrintedThreadStep[];
}

export interface PrintedInternalThreadResult {
  recipe: "printed-internal-thread";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  targetId: number;
  helixBodyId: number;
  consumedToolIds: number[];
  turns: number;
  geometry: PrintedThreadGeometry;
  undoSteps: number;
  steps: PrintedThreadStep[];
}

export interface PrintedHexNutResult {
  recipe: "printed-hex-nut";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  resultBodyId: number;
  profileBodyId: number;
  helixBodyId: number;
  consumedToolIds: number[];
  turns: number;
  geometry: PrintedThreadGeometry;
  minimumWallThicknessMm: number;
  actualMinimumWallThicknessMm: number;
  undoSteps: number;
  steps: PrintedThreadStep[];
}

export interface PrintedHexScrewResult {
  recipe: "printed-hex-screw";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  resultBodyId: number;
  helixBodyId: number;
  headProfileBodyId: number;
  consumedToolIds: number[];
  turns: number;
  geometry: PrintedThreadGeometry;
  undoSteps: number;
  steps: PrintedThreadStep[];
}

export interface PrintedHexPairResult {
  recipe: "printed-hex-pair";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  screw: PrintedHexScrewResult;
  nut: PrintedHexNutResult;
  geometry: PrintedThreadGeometry;
  undoSteps: number;
  steps: PrintedThreadStep[];
}

export interface PrintedThreadCalibrationSampleResult {
  id: string;
  profileClearanceMm: number;
  nut: PrintedHexNutResult;
}

export interface PrintedThreadCalibrationResult {
  recipe: "printed-thread-calibration-set";
  status: "completed";
  qualificationStatus: "requires-physical-fit-test";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  screw: PrintedHexScrewResult;
  samples: PrintedThreadCalibrationSampleResult[];
  undoSteps: number;
  steps: PrintedThreadStep[];
}

type ThreadRecipeOperations = Pick<PlasticityOperations,
  "state" | "createCylinder" | "createHelix" | "createPipes" | "boolean" | "createPolyline" | "extrudeRegions"
>;

export class PrintedThreadRecipeError extends Error {
  readonly completedSteps: PrintedThreadStep[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(recipe: string, totalSteps: number, cause: unknown, completedSteps: PrintedThreadStep[], lastConfirmedRevision: string) {
    const uncertain = mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "partial geometry remains";
    super(`${recipe} failed after ${completedSteps.length}/${totalSteps} confirmed steps; ${state}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "PrintedThreadRecipeError";
    this.completedSteps = [...completedSteps];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class PrintedThreadPairRecipeError extends Error {
  readonly screwResult: PrintedHexScrewResult;
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, screwResult: PrintedHexScrewResult, lastConfirmedRevision: string) {
    const uncertain = cause instanceof PrintedThreadRecipeError ? cause.uncertain : mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "the completed screw and any confirmed nut geometry remain";
    super(`Printed hex pair failed after the screw completed; ${state}; screw body ${screwResult.resultBodyId}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "PrintedThreadPairRecipeError";
    this.screwResult = screwResult;
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class PrintedThreadCalibrationRecipeError extends Error {
  readonly screwResult: PrintedHexScrewResult;
  readonly completedSamples: PrintedThreadCalibrationSampleResult[];
  readonly lastConfirmedRevision: string;
  readonly uncertain: boolean;

  constructor(cause: unknown, screwResult: PrintedHexScrewResult, completedSamples: PrintedThreadCalibrationSampleResult[], lastConfirmedRevision: string) {
    const uncertain = cause instanceof PrintedThreadRecipeError ? cause.uncertain : mutationOutcomeIsUncertain(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const state = uncertain ? "the last native result is uncertain" : "the completed screw and confirmed calibration nuts remain";
    super(`Printed thread calibration set failed after ${completedSamples.length} nut samples; ${state}; screw body ${screwResult.resultBodyId}; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "PrintedThreadCalibrationRecipeError";
    this.screwResult = screwResult;
    this.completedSamples = [...completedSamples];
    this.lastConfirmedRevision = lastConfirmedRevision;
    this.uncertain = uncertain;
  }
}

export class PrintedThreadRecipes {
  private readonly operations: ThreadRecipeOperations;

  constructor(operations: ThreadRecipeOperations) {
    this.operations = operations;
  }

  async createExternalThread(input: PrintedExternalThreadInput): Promise<PrintedExternalThreadResult> {
    const geometry = validateExternal(input);
    const initial = await this.operations.state();
    requireRevision(initial, input.revision);
    const axis = normalize(input.axis, "Thread axis");
    const radial = perpendicularDirection(axis, input.radialDirection, "Thread radial direction");
    const axisEnd = add(input.axisStartMm, scale(axis, input.threadLengthMm));
    const turns = input.threadLengthMm / input.pitchMm;
    const completedSteps: PrintedThreadStep[] = [];
    const consumedToolIds: number[] = [];
    let current = initial;
    let resultBodyId = 0;
    let helixBodyId = 0;
    try {
      let before = current;
      current = await this.operations.createCylinder(input.axisStartMm, geometry.coreDiameterMm / 2, input.threadLengthMm, input.name, current.revision, axis);
      resultBodyId = requireSingleAddedBody(before, current, "thread core", "Solid");
      completedSteps.push(step("create-thread-core", before, current, [resultBodyId]));

      before = current;
      current = await this.operations.createHelix(input.axisStartMm, axisEnd, geometry.helixDiameterMm / 2, turns, radial, input.handedness, current.revision);
      helixBodyId = requireSingleAddedBody(before, current, "thread helix", "Wire");
      completedSteps.push(step("create-thread-helix", before, current, [helixBodyId]));

      before = current;
      current = await this.operations.createPipes([helixBodyId], geometry.maleProfileDiameterMm, 0, current.revision);
      const ridgeBodyId = requireSingleAddedBody(before, current, "thread ridge", "Solid");
      consumedToolIds.push(ridgeBodyId);
      completedSteps.push(step("create-thread-ridge", before, current, [ridgeBodyId]));

      before = current;
      current = await this.operations.boolean([resultBodyId], [ridgeBodyId], "union", false, current.revision);
      requireSolid(current, resultBodyId, "External thread");
      requireAbsent(current, [ridgeBodyId], "External thread ridge");
      completedSteps.push(step("union-thread-ridge", before, current, [resultBodyId]));

      before = current;
      current = await this.operations.createCylinder(input.axisStartMm, input.nominalDiameterMm / 2, input.threadLengthMm, undefined, current.revision, axis);
      const envelopeBodyId = requireSingleAddedBody(before, current, "thread crest envelope", "Solid");
      consumedToolIds.push(envelopeBodyId);
      completedSteps.push(step("create-thread-envelope", before, current, [envelopeBodyId]));

      before = current;
      current = await this.operations.boolean([resultBodyId], [envelopeBodyId], "intersection", false, current.revision);
      requireThreadResult(initial, current, resultBodyId, helixBodyId, consumedToolIds);
      completedSteps.push(step("clip-thread-envelope", before, current, [resultBodyId]));
      return {
        recipe: "printed-external-thread", status: "completed", documentToken: current.documentToken,
        beforeRevision: initial.revision, afterRevision: current.revision, resultBodyId, helixBodyId,
        consumedToolIds, turns, geometry, undoSteps: completedSteps.length, steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof PrintedThreadRecipeError) throw error;
      throw new PrintedThreadRecipeError("Printed external thread recipe", 6, error, completedSteps, current.revision);
    }
  }

  async cutInternalThread(input: PrintedInternalThreadInput): Promise<PrintedInternalThreadResult> {
    const geometry = validateInternal(input);
    const initial = await this.operations.state();
    requireRevision(initial, input.revision);
    requireSolid(initial, input.targetId, "Internal thread target");
    const result = await this.cutInternal(input, geometry, initial, []);
    return {
      recipe: "printed-internal-thread", status: "completed", documentToken: result.current.documentToken,
      beforeRevision: initial.revision, afterRevision: result.current.revision, targetId: input.targetId,
      helixBodyId: result.helixBodyId, consumedToolIds: result.consumedToolIds,
      turns: result.turns, geometry, undoSteps: result.steps.length, steps: result.steps,
    };
  }

  async createHexNut(input: PrintedHexNutInput): Promise<PrintedHexNutResult> {
    const geometry = validateNut(input);
    const initial = await this.operations.state();
    requireRevision(initial, input.revision);
    const axis = normalize(input.axis, "Nut axis");
    const flatNormal = perpendicularDirection(axis, input.flatNormalDirection, "Nut flat-normal direction");
    const around = normalize(cross(axis, flatNormal), "Nut profile direction");
    const profilePoints = hexagonPoints(input.entryCenterMm, flatNormal, around, input.acrossFlatsMm);
    const completedSteps: PrintedThreadStep[] = [];
    let current = initial;
    let profileBodyId = 0;
    let nutBodyId = 0;
    try {
      let before = current;
      current = await this.operations.createPolyline(profilePoints, true, current.revision);
      profileBodyId = requireSingleAddedBody(before, current, "printed nut profile", "Wire");
      const newRegions = newlyAddedRegions(before, current, profileBodyId);
      completedSteps.push(step("create-nut-profile", before, current, [profileBodyId]));

      before = current;
      current = await this.operations.extrudeRegions([newRegions[0]!.id], input.thicknessMm, current.revision);
      nutBodyId = requireSingleAddedBody(before, current, "printed nut blank", "Solid");
      completedSteps.push(step("extrude-nut-blank", before, current, [nutBodyId]));

      const cutInput: PrintedInternalThreadInput = {
        targetId: nutBodyId,
        entryCenterMm: input.entryCenterMm,
        axis,
        radialDirection: input.radialDirection,
        materialDepthMm: input.thicknessMm,
        nominalDiameterMm: input.nominalDiameterMm,
        pitchMm: input.pitchMm,
        threadDepthMm: input.threadDepthMm,
        profileClearanceMm: input.profileClearanceMm,
        cutterOvershootMm: input.cutterOvershootMm,
        handedness: input.handedness,
        revision: current.revision,
      };
      const cut = await this.cutInternal(cutInput, geometry, current, completedSteps);
      current = cut.current;
      requireThreadResult(initial, current, nutBodyId, cut.helixBodyId, cut.consumedToolIds, [profileBodyId]);
      const actualMinimumWallThicknessMm = input.acrossFlatsMm / 2 - geometry.femaleGrooveOuterDiameterMm / 2;
      return {
        recipe: "printed-hex-nut", status: "completed", documentToken: current.documentToken,
        beforeRevision: initial.revision, afterRevision: current.revision, resultBodyId: nutBodyId,
        profileBodyId, helixBodyId: cut.helixBodyId, consumedToolIds: cut.consumedToolIds,
        turns: cut.turns, geometry, minimumWallThicknessMm: input.minimumWallThicknessMm,
        actualMinimumWallThicknessMm, undoSteps: cut.steps.length, steps: cut.steps,
      };
    } catch (error) {
      if (error instanceof PrintedThreadRecipeError) throw error;
      throw new PrintedThreadRecipeError("Printed hex nut recipe", 6, error, completedSteps, current.revision);
    }
  }

  async createHexScrew(input: PrintedHexScrewInput): Promise<PrintedHexScrewResult> {
    validateHexScrew(input);
    const initial = await this.operations.state();
    requireRevision(initial, input.revision);
    let external: PrintedExternalThreadResult;
    try {
      external = await this.createExternalThread(input);
    } catch (error) {
      throw error;
    }
    let current = await this.operations.state();
    if (current.documentToken !== external.documentToken || current.revision !== external.afterRevision) {
      throw new Error("Plasticity document changed after creating the printed screw thread");
    }
    const completedSteps = [...external.steps];
    const consumedToolIds = [...external.consumedToolIds];
    const axis = normalize(input.axis, "Screw axis");
    const flatNormal = perpendicularDirection(axis, input.flatNormalDirection, "Screw head flat-normal direction");
    const around = normalize(cross(axis, flatNormal), "Screw head profile direction");
    const headBase = subtract(input.axisStartMm, scale(axis, input.headHeightMm));
    const profilePoints = hexagonPoints(headBase, flatNormal, around, input.headAcrossFlatsMm);
    let headProfileBodyId = 0;
    try {
      let before = current;
      current = await this.operations.createPolyline(profilePoints, true, current.revision);
      headProfileBodyId = requireSingleAddedBody(before, current, "printed screw head profile", "Wire");
      const regions = newlyAddedRegions(before, current, headProfileBodyId);
      completedSteps.push(step("create-screw-head-profile", before, current, [headProfileBodyId]));

      before = current;
      current = await this.operations.extrudeRegions([regions[0]!.id], input.headHeightMm + input.junctionOverlapMm, current.revision);
      const headBodyId = requireSingleAddedBody(before, current, "printed screw head", "Solid");
      consumedToolIds.push(headBodyId);
      completedSteps.push(step("extrude-screw-head", before, current, [headBodyId]));

      before = current;
      current = await this.operations.boolean([external.resultBodyId], [headBodyId], "union", false, current.revision);
      requireThreadResult(initial, current, external.resultBodyId, external.helixBodyId, consumedToolIds, [headProfileBodyId]);
      completedSteps.push(step("union-screw-head", before, current, [external.resultBodyId]));
      return {
        recipe: "printed-hex-screw", status: "completed", documentToken: current.documentToken,
        beforeRevision: initial.revision, afterRevision: current.revision, resultBodyId: external.resultBodyId,
        helixBodyId: external.helixBodyId, headProfileBodyId, consumedToolIds,
        turns: external.turns, geometry: external.geometry, undoSteps: completedSteps.length, steps: completedSteps,
      };
    } catch (error) {
      if (error instanceof PrintedThreadRecipeError) throw error;
      throw new PrintedThreadRecipeError("Printed hex screw recipe", 9, error, completedSteps, current.revision);
    }
  }

  async createHexPair(input: PrintedHexPairInput): Promise<PrintedHexPairResult> {
    const screwInput: PrintedHexScrewInput = {
      axisStartMm: input.screwAxisStartMm,
      axis: input.axis,
      radialDirection: input.radialDirection,
      threadLengthMm: input.threadLengthMm,
      nominalDiameterMm: input.nominalDiameterMm,
      pitchMm: input.pitchMm,
      threadDepthMm: input.threadDepthMm,
      handedness: input.handedness,
      flatNormalDirection: input.flatNormalDirection,
      headAcrossFlatsMm: input.screwHeadAcrossFlatsMm,
      headHeightMm: input.screwHeadHeightMm,
      junctionOverlapMm: input.screwJunctionOverlapMm,
      name: input.screwName,
      revision: input.revision,
    };
    const nutInput: PrintedHexNutInput = {
      entryCenterMm: input.nutEntryCenterMm,
      axis: input.axis,
      radialDirection: input.radialDirection,
      nominalDiameterMm: input.nominalDiameterMm,
      pitchMm: input.pitchMm,
      threadDepthMm: input.threadDepthMm,
      handedness: input.handedness,
      flatNormalDirection: input.flatNormalDirection,
      acrossFlatsMm: input.nutAcrossFlatsMm,
      thicknessMm: input.nutThicknessMm,
      minimumWallThicknessMm: input.nutMinimumWallThicknessMm,
      profileClearanceMm: input.profileClearanceMm,
      cutterOvershootMm: input.cutterOvershootMm,
      revision: input.revision,
    };

    // Validate both members before the first native mutation. A bad nut must not
    // leave a valid screw behind as an avoidable partial recipe.
    validateHexScrew(screwInput);
    const geometry = validateNut(nutInput);
    const initial = await this.operations.state();
    requireRevision(initial, input.revision);

    const screw = await this.createHexScrew(screwInput);
    let afterScrew: RuntimeState | undefined;
    try {
      afterScrew = await this.operations.state();
      if (afterScrew.documentToken !== screw.documentToken || afterScrew.revision !== screw.afterRevision) {
        throw new Error("Plasticity document changed after creating the printed pair screw");
      }
      const nut = await this.createHexNut({ ...nutInput, revision: afterScrew.revision });
      if (nut.documentToken !== initial.documentToken) throw new Error("Plasticity document changed while creating the printed pair nut");
      return {
        recipe: "printed-hex-pair",
        status: "completed",
        documentToken: nut.documentToken,
        beforeRevision: initial.revision,
        afterRevision: nut.afterRevision,
        screw,
        nut,
        geometry,
        undoSteps: screw.undoSteps + nut.undoSteps,
        steps: [...screw.steps, ...nut.steps],
      };
    } catch (error) {
      throw new PrintedThreadPairRecipeError(error, screw, afterScrew?.revision ?? screw.afterRevision);
    }
  }

  async createCalibrationSet(input: PrintedThreadCalibrationInput): Promise<PrintedThreadCalibrationResult> {
    const screwInput: PrintedHexScrewInput = {
      axisStartMm: input.screwAxisStartMm,
      axis: input.axis,
      radialDirection: input.radialDirection,
      threadLengthMm: input.threadLengthMm,
      nominalDiameterMm: input.nominalDiameterMm,
      pitchMm: input.pitchMm,
      threadDepthMm: input.threadDepthMm,
      handedness: input.handedness,
      flatNormalDirection: input.flatNormalDirection,
      headAcrossFlatsMm: input.screwHeadAcrossFlatsMm,
      headHeightMm: input.screwHeadHeightMm,
      junctionOverlapMm: input.screwJunctionOverlapMm,
      name: input.screwName,
      revision: input.revision,
    };
    validateHexScrew(screwInput);
    validateCalibrationSamples(input.samples);
    const nutInputs = input.samples.map((sample): PrintedHexNutInput => ({
      entryCenterMm: sample.nutEntryCenterMm,
      axis: input.axis,
      radialDirection: input.radialDirection,
      nominalDiameterMm: input.nominalDiameterMm,
      pitchMm: input.pitchMm,
      threadDepthMm: input.threadDepthMm,
      handedness: input.handedness,
      flatNormalDirection: input.flatNormalDirection,
      acrossFlatsMm: input.nutAcrossFlatsMm,
      thicknessMm: input.nutThicknessMm,
      minimumWallThicknessMm: input.nutMinimumWallThicknessMm,
      profileClearanceMm: sample.profileClearanceMm,
      cutterOvershootMm: input.cutterOvershootMm,
      revision: input.revision,
    }));
    for (const nut of nutInputs) validateNut(nut);
    const initial = await this.operations.state();
    requireRevision(initial, input.revision);

    const screw = await this.createHexScrew(screwInput);
    const completedSamples: PrintedThreadCalibrationSampleResult[] = [];
    let lastConfirmedRevision = screw.afterRevision;
    try {
      let current = await this.operations.state();
      if (current.documentToken !== screw.documentToken || current.revision !== screw.afterRevision) {
        throw new Error("Plasticity document changed after creating the calibration screw");
      }
      for (let index = 0; index < nutInputs.length; index += 1) {
        const sample = input.samples[index]!;
        const nut = await this.createHexNut({ ...nutInputs[index]!, revision: current.revision });
        if (nut.documentToken !== initial.documentToken) throw new Error(`Plasticity document changed while creating calibration sample ${sample.id}`);
        completedSamples.push({ id: sample.id, profileClearanceMm: sample.profileClearanceMm, nut });
        lastConfirmedRevision = nut.afterRevision;
        current = await this.operations.state();
        if (current.documentToken !== nut.documentToken || current.revision !== nut.afterRevision) {
          throw new Error(`Plasticity document changed after creating calibration sample ${sample.id}`);
        }
      }
      return {
        recipe: "printed-thread-calibration-set",
        status: "completed",
        qualificationStatus: "requires-physical-fit-test",
        documentToken: initial.documentToken,
        beforeRevision: initial.revision,
        afterRevision: lastConfirmedRevision,
        screw,
        samples: completedSamples,
        undoSteps: screw.undoSteps + completedSamples.reduce((sum, sample) => sum + sample.nut.undoSteps, 0),
        steps: [screw, ...completedSamples.map((sample) => sample.nut)].flatMap((result) => result.steps),
      };
    } catch (error) {
      throw new PrintedThreadCalibrationRecipeError(error, screw, completedSamples, lastConfirmedRevision);
    }
  }

  private async cutInternal(
    input: PrintedInternalThreadInput,
    geometry: PrintedThreadGeometry,
    initial: RuntimeState,
    previousSteps: PrintedThreadStep[],
  ): Promise<{ current: RuntimeState; helixBodyId: number; consumedToolIds: number[]; turns: number; steps: PrintedThreadStep[] }> {
    const axis = normalize(input.axis, "Thread axis");
    const radial = perpendicularDirection(axis, input.radialDirection, "Thread radial direction");
    const extendedStart = subtract(input.entryCenterMm, scale(axis, input.cutterOvershootMm));
    const extendedLength = input.materialDepthMm + input.cutterOvershootMm * 2;
    const extendedEnd = add(extendedStart, scale(axis, extendedLength));
    const turns = extendedLength / input.pitchMm;
    const completedSteps = [...previousSteps];
    const consumedToolIds: number[] = [];
    let current = initial;
    let helixBodyId = 0;
    try {
      let before = current;
      current = await this.operations.createCylinder(extendedStart, geometry.femaleBoreDiameterMm / 2, extendedLength, undefined, current.revision, axis);
      const boreBodyId = requireSingleAddedBody(before, current, "thread bore cutter", "Solid");
      consumedToolIds.push(boreBodyId);
      completedSteps.push(step("create-thread-bore-cutter", before, current, [boreBodyId]));

      before = current;
      current = await this.operations.createHelix(extendedStart, extendedEnd, geometry.helixDiameterMm / 2, turns, radial, input.handedness, current.revision);
      helixBodyId = requireSingleAddedBody(before, current, "internal thread helix", "Wire");
      completedSteps.push(step("create-thread-helix", before, current, [helixBodyId]));

      before = current;
      current = await this.operations.createPipes([helixBodyId], geometry.femaleGrooveDiameterMm, 0, current.revision);
      const grooveBodyId = requireSingleAddedBody(before, current, "thread groove cutter", "Solid");
      consumedToolIds.push(grooveBodyId);
      completedSteps.push(step("create-thread-groove-cutter", before, current, [grooveBodyId]));

      before = current;
      current = await this.operations.boolean([input.targetId], consumedToolIds, "difference", false, current.revision);
      requireThreadResult(initial, current, input.targetId, helixBodyId, consumedToolIds);
      completedSteps.push(step("cut-internal-thread", before, current, [input.targetId]));
      return { current, helixBodyId, consumedToolIds, turns, steps: completedSteps };
    } catch (error) {
      if (error instanceof PrintedThreadRecipeError) throw error;
      const total = previousSteps.length + 4;
      throw new PrintedThreadRecipeError(previousSteps.length > 0 ? "Printed hex nut recipe" : "Printed internal thread recipe", total, error, completedSteps, current.revision);
    }
  }
}

export function printedThreadGeometry(input: Pick<PrintedThreadDefinition, "nominalDiameterMm" | "pitchMm" | "threadDepthMm"> & { profileClearanceMm: number }): PrintedThreadGeometry {
  const coreDiameterMm = input.nominalDiameterMm - input.threadDepthMm * 2;
  const helixDiameterMm = input.nominalDiameterMm - input.threadDepthMm;
  const maleProfileDiameterMm = input.threadDepthMm * 1.1;
  const femaleBoreDiameterMm = coreDiameterMm + input.profileClearanceMm * 2;
  const femaleGrooveDiameterMm = maleProfileDiameterMm + input.profileClearanceMm * 2;
  return {
    profile: "rounded-print-v1",
    nominalCrestDiameterMm: clean(input.nominalDiameterMm),
    coreDiameterMm: clean(coreDiameterMm),
    helixDiameterMm: clean(helixDiameterMm),
    maleProfileDiameterMm: clean(maleProfileDiameterMm),
    femaleBoreDiameterMm: clean(femaleBoreDiameterMm),
    femaleGrooveDiameterMm: clean(femaleGrooveDiameterMm),
    femaleGrooveOuterDiameterMm: clean(helixDiameterMm + femaleGrooveDiameterMm),
    pitchMm: clean(input.pitchMm),
    profileClearanceMm: clean(input.profileClearanceMm),
  };
}

function validateExternal(input: PrintedExternalThreadInput): PrintedThreadGeometry {
  validateCommon(input, input.threadLengthMm, 0);
  validatePoint(input.axisStartMm, "Thread axis start");
  return printedThreadGeometry({ ...input, profileClearanceMm: 0 });
}

function validateInternal(input: PrintedInternalThreadInput): PrintedThreadGeometry {
  if (!Number.isInteger(input.targetId) || input.targetId <= 0) throw new Error("Internal thread target ID must be a positive integer");
  validateCommon(input, input.materialDepthMm, input.profileClearanceMm);
  validatePoint(input.entryCenterMm, "Thread entry center");
  positive(input.cutterOvershootMm, "Thread cutter overshoot");
  return printedThreadGeometry(input);
}

function validateNut(input: PrintedHexNutInput): PrintedThreadGeometry {
  const geometry = validateInternal({ ...input, targetId: 1, materialDepthMm: input.thicknessMm });
  positive(input.acrossFlatsMm, "Nut across-flats size");
  positive(input.minimumWallThicknessMm, "Nut minimum wall thickness");
  const actualWall = input.acrossFlatsMm / 2 - geometry.femaleGrooveOuterDiameterMm / 2;
  if (actualWall + 1e-9 < input.minimumWallThicknessMm) {
    throw new Error(`Nut wall ${clean(actualWall)} mm is below the required ${input.minimumWallThicknessMm} mm`);
  }
  return geometry;
}

function validateHexScrew(input: PrintedHexScrewInput): void {
  validateExternal(input);
  positive(input.headAcrossFlatsMm, "Screw head across-flats size");
  positive(input.headHeightMm, "Screw head height");
  positive(input.junctionOverlapMm, "Screw head junction overlap");
  if (input.headAcrossFlatsMm <= input.nominalDiameterMm) throw new Error("Screw head across-flats size must exceed the thread crest diameter");
  if (input.junctionOverlapMm >= Math.min(input.headHeightMm, input.pitchMm)) {
    throw new Error("Screw head junction overlap must be less than both head height and thread pitch");
  }
}

function validateCalibrationSamples(samples: PrintedThreadCalibrationSampleInput[]): void {
  if (!Array.isArray(samples) || samples.length < 2 || samples.length > 8) throw new Error("Printed thread calibration set requires 2 to 8 nut samples");
  const ids = new Set<string>();
  for (const sample of samples) {
    if (typeof sample.id !== "string" || sample.id.trim().length === 0) throw new Error("Calibration sample ID must be nonempty");
    if (ids.has(sample.id)) throw new Error(`Calibration sample IDs must be unique: ${sample.id}`);
    ids.add(sample.id);
    validatePoint(sample.nutEntryCenterMm, `Calibration sample ${sample.id} center`);
    if (!Number.isFinite(sample.profileClearanceMm) || sample.profileClearanceMm < 0) throw new Error(`Calibration sample ${sample.id} profile clearance must be nonnegative`);
  }
  for (let first = 0; first < samples.length; first += 1) {
    for (let second = first + 1; second < samples.length; second += 1) {
      const a = samples[first]!;
      const b = samples[second]!;
      if (Math.abs(a.profileClearanceMm - b.profileClearanceMm) <= 1e-9) throw new Error(`Calibration profile clearances must be unique: ${a.id} and ${b.id}`);
      const distanceSquared = a.nutEntryCenterMm.reduce((sum, value, index) => sum + (value - b.nutEntryCenterMm[index]!) ** 2, 0);
      if (distanceSquared <= 1e-12) throw new Error(`Calibration nut centers must be unique: ${a.id} and ${b.id}`);
    }
  }
}

function validateCommon(input: PrintedThreadDefinition, lengthMm: number, profileClearanceMm: number): void {
  positive(input.nominalDiameterMm, "Thread nominal crest diameter");
  positive(input.pitchMm, "Thread pitch");
  positive(input.threadDepthMm, "Thread depth");
  positive(lengthMm, "Thread length");
  if (!Number.isFinite(profileClearanceMm) || profileClearanceMm < 0) throw new Error("Thread profile clearance must be nonnegative");
  if (input.nominalDiameterMm / 2 <= input.threadDepthMm) throw new Error("Thread depth must be less than the nominal radius");
  const geometry = printedThreadGeometry({ ...input, profileClearanceMm });
  if (geometry.maleProfileDiameterMm >= input.pitchMm) throw new Error("Male rounded profile diameter must be less than thread pitch to prevent overlapping turns");
  if (geometry.femaleGrooveDiameterMm >= input.pitchMm) throw new Error("Female rounded profile diameter plus clearance must be less than thread pitch to prevent overlapping turns");
  if (lengthMm / input.pitchMm > 10_000) throw new Error("Thread turn count exceeds 10000");
  normalize(input.radialDirection, "Thread radial direction");
}

function newlyAddedRegions(before: RuntimeState, after: RuntimeState, profileBodyId: number): RuntimeState["regions"] {
  const previous = new Set(before.regions.map((region) => region.id));
  const regions = after.regions.filter((region) => !previous.has(region.id) && region.sketchWireIds.includes(profileBodyId));
  if (regions.length !== 1) throw new Error(`Expected one new Region for printed nut profile ${profileBodyId}, found ${regions.length}`);
  return regions;
}

function hexagonPoints(center: Vector3, flatNormal: Vector3, around: Vector3, acrossFlatsMm: number): Vector3[] {
  const apothem = acrossFlatsMm / 2;
  const radius = acrossFlatsMm / Math.sqrt(3);
  const halfRadius = radius / 2;
  return [
    add(add(center, scale(flatNormal, apothem)), scale(around, halfRadius)),
    add(center, scale(around, radius)),
    add(subtract(center, scale(flatNormal, apothem)), scale(around, halfRadius)),
    subtract(subtract(center, scale(flatNormal, apothem)), scale(around, halfRadius)),
    subtract(center, scale(around, radius)),
    subtract(add(center, scale(flatNormal, apothem)), scale(around, halfRadius)),
  ];
}

function perpendicularDirection(axis: Vector3, direction: Vector3, label: string): Vector3 {
  const normalized = normalize(direction, label);
  const projection = normalized.reduce((sum, value, index) => sum + value * axis[index]!, 0);
  return normalize(normalized.map((value, index) => value - projection * axis[index]!) as Vector3, label);
}

function requireRevision(state: RuntimeState, revision: string): void {
  if (state.revision !== revision) throw new Error(`Stale reference: expected revision ${revision}, current revision is ${state.revision}`);
}

function requireSingleAddedBody(before: RuntimeState, after: RuntimeState, label: string, type: "Solid" | "Wire"): number {
  requireSameDocument(before, after);
  const previous = new Set(before.bodies.map((body) => body.id));
  const added = after.bodies.filter((body) => !previous.has(body.id));
  if (added.length !== 1 || added[0]!.type !== type) throw new Error(`Expected one ${type} ${label}, found ${added.length}`);
  return added[0]!.id;
}

function requireThreadResult(initial: RuntimeState, after: RuntimeState, resultBodyId: number, helixBodyId: number, consumedIds: number[], preservedIds: number[] = []): void {
  requireSameDocument(initial, after);
  requireSolid(after, resultBodyId, "Printed thread result");
  if (after.bodies.find((body) => body.id === helixBodyId)?.type !== "Wire") throw new Error(`Printed thread helix was not preserved as a Wire: ${helixBodyId}`);
  for (const id of preservedIds) if (!after.bodies.some((body) => body.id === id)) throw new Error(`Printed thread source geometry was not preserved: ${id}`);
  requireAbsent(after, consumedIds, "Printed thread tools");
  const allowedChanged = new Set([resultBodyId]);
  const afterIds = new Set(after.bodies.map((body) => body.id));
  const missingContext = initial.bodies.filter((body) => !allowedChanged.has(body.id) && !afterIds.has(body.id)).map((body) => body.id);
  if (missingContext.length > 0) throw new Error(`Printed thread recipe changed unrelated bodies: ${missingContext.join(", ")}`);
}

function requireSolid(state: RuntimeState, id: number, label: string): void {
  if (state.bodies.find((body) => body.id === id)?.type !== "Solid") throw new Error(`${label} is not a current Solid: ${id}`);
}

function requireAbsent(state: RuntimeState, ids: number[], label: string): void {
  const remaining = ids.filter((id) => state.bodies.some((body) => body.id === id));
  if (remaining.length > 0) throw new Error(`${label} were not consumed: ${remaining.join(", ")}`);
}

function requireSameDocument(before: RuntimeState, after: RuntimeState): void {
  if (before.documentToken !== after.documentToken) throw new Error("Plasticity document changed during printed thread recipe");
}

function step(operation: PrintedThreadStep["operation"], before: RuntimeState, after: RuntimeState, affectedBodyIds: number[]): PrintedThreadStep {
  requireSameDocument(before, after);
  return { operation, beforeRevision: before.revision, afterRevision: after.revision, affectedBodyIds };
}

function validatePoint(point: Vector3, label: string): void {
  if (point.some((value) => !Number.isFinite(value))) throw new Error(`${label} must contain finite values`);
}

function positive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
}

function clean(value: number): number {
  const rounded = Math.round(value * 1e12) / 1e12;
  return Object.is(rounded, -0) ? 0 : rounded;
}
