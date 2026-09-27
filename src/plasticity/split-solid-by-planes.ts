import type { RuntimeState } from "./runtime.ts";
import type { PlasticityOperations } from "./operations.ts";
import { SplitSolidByPlaneRecipe, SplitSolidByPlaneRecipeError, type SplitSolidByPlaneInput, type SplitSolidByPlaneResult } from "./split-solid.ts";

type Vector3 = [number, number, number];
type SplitOperations = Pick<PlasticityOperations, "state" | "measureSolidProperties" | "validateBodies" | "createRectangle" | "patchClosedWires" | "cutWithFaces" | "remove">;

export interface SplitSolidByPlanesInput {
  targetId: number;
  planes: Array<Pick<SplitSolidByPlaneInput, "originMm" | "normal" | "xDirection">>;
  revision: string;
}

export interface SplitSolidByPlanesResult {
  recipe: "split-solid-by-planes";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  sourceBodyId: number;
  resultBodyIds: number[];
  cutCount: number;
  undoSteps: number;
  inputVolumeMm3: number;
  resultVolumeMm3: number;
  volumeDifferenceMm3: number;
  cuts: Array<{ targetBodyId: number; planeIndex: number; resultBodyIds: number[]; volumeDifferenceMm3: number }>;
}

export class SplitSolidByPlanesRecipeError extends Error {
  readonly completedCuts: SplitSolidByPlanesResult["cuts"];
  readonly lastConfirmedRevision: string;

  constructor(cause: unknown, completedCuts: SplitSolidByPlanesResult["cuts"], lastConfirmedRevision: string) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Multi-plane Solid split stopped after ${completedCuts.length} completed cuts; partial geometry may remain; last confirmed revision ${lastConfirmedRevision}: ${detail}`, { cause });
    this.name = "SplitSolidByPlanesRecipeError";
    this.completedCuts = completedCuts;
    this.lastConfirmedRevision = lastConfirmedRevision;
  }
}

const MAX_NATIVE_CUTS = 128;

export class SplitSolidByPlanesRecipe {
  private readonly operations: SplitOperations;
  private readonly splitOne: Pick<SplitSolidByPlaneRecipe, "split">;

  constructor(operations: SplitOperations, splitOne: Pick<SplitSolidByPlaneRecipe, "split"> = new SplitSolidByPlaneRecipe(operations)) {
    this.operations = operations;
    this.splitOne = splitOne;
  }

  async split(input: SplitSolidByPlanesInput): Promise<SplitSolidByPlanesResult> {
    const initial = await this.operations.state();
    if (initial.revision !== input.revision) throw new Error(`Stale reference: expected revision ${input.revision}, current revision is ${initial.revision}`);
    const source = initial.bodies.find((body) => body.id === input.targetId);
    if (!source || source.type !== "Solid" || !source.boundsMm) throw new Error(`Multi-plane split requires a current bounded Solid: ${input.targetId}`);
    if (input.planes.length === 0) throw new Error("At least one split plane is required");
    if (input.planes.length > 64) throw new Error("At most 64 ordered split planes are allowed per recipe");

    const sourceProperties = await this.operations.measureSolidProperties([input.targetId], initial.revision);
    const inputVolumeMm3 = sourceProperties.bodies[0]?.volumeMm3;
    if (!(inputVolumeMm3 && Number.isFinite(inputVolumeMm3))) throw new Error("Native source Solid volume is unavailable");

    let pieces = [input.targetId];
    let expectedRevision = initial.revision;
    let lastConfirmedRevision = initial.revision;
    const cuts: SplitSolidByPlanesResult["cuts"] = [];
    let current = initial;
    try {
      for (let planeIndex = 0; planeIndex < input.planes.length; planeIndex += 1) {
        current = await this.requireExpectedState(initial.documentToken, expectedRevision);
        const plane = input.planes[planeIndex]!;
        const candidates = pieces.filter((id) => {
          const body = current.bodies.find((item) => item.id === id);
          return body?.type === "Solid" && body.boundsMm && planeCrossesBounds(body.boundsMm, plane.originMm, plane.normal);
        });
        if (candidates.length === 0) throw new Error(`Split plane ${planeIndex} crosses no current Solid bounds`);
        if (cuts.length + candidates.length > MAX_NATIVE_CUTS) throw new Error(`Split plan would exceed ${MAX_NATIVE_CUTS} native cuts`);

        for (const targetBodyId of candidates) {
          current = await this.requireExpectedState(initial.documentToken, expectedRevision);
          const result: SplitSolidByPlaneResult = await this.splitOne.split({ ...plane, targetId: targetBodyId, revision: expectedRevision });
          if (result.documentToken !== initial.documentToken || result.beforeRevision !== expectedRevision) {
            throw new Error("Single-plane split returned a result for an unexpected document or revision");
          }
          lastConfirmedRevision = result.afterRevision;
          const after = await this.requireExpectedState(initial.documentToken, result.afterRevision);
          if (result.resultBodyIds.length !== 2 || result.resultBodyIds.some((id) => !after.bodies.some((body) => body.id === id && body.type === "Solid"))) {
            throw new Error(`Native cut of body ${targetBodyId} did not leave exactly two current Solid results`);
          }
          pieces = [...pieces.filter((id) => id !== targetBodyId), ...result.resultBodyIds];
          cuts.push({ targetBodyId, planeIndex, resultBodyIds: result.resultBodyIds, volumeDifferenceMm3: result.volumeDifferenceMm3 });
          expectedRevision = result.afterRevision;
          lastConfirmedRevision = result.afterRevision;
          current = after;
        }
      }

      current = await this.requireExpectedState(initial.documentToken, expectedRevision);
      const resultBodyIds = unique(pieces).sort((leftId, rightId) => {
        const left = current.bodies.find((body) => body.id === leftId)?.boundsMm;
        const right = current.bodies.find((body) => body.id === rightId)?.boundsMm;
        if (!left || !right) return leftId - rightId;
        for (let axis = 0; axis < 3; axis += 1) {
          const difference = left.min[axis]! - right.min[axis]!;
          if (Math.abs(difference) > 1e-9) return difference;
        }
        return leftId - rightId;
      });
      if (resultBodyIds.length !== cuts.length + 1) throw new Error("Split result count does not match the number of completed binary cuts");
      const measured = await this.operations.measureSolidProperties(resultBodyIds, current.revision);
      const resultVolumeMm3 = measured.totals.volumeMm3;
      const volumeDifferenceMm3 = Math.abs(resultVolumeMm3 - inputVolumeMm3);
      const toleranceMm3 = Math.max(0.01, inputVolumeMm3 * 1e-8);
      if (!Number.isFinite(resultVolumeMm3) || volumeDifferenceMm3 > toleranceMm3) {
        throw new Error(`Multi-plane split changed native volume by ${volumeDifferenceMm3} mm³; conservation tolerance is ${toleranceMm3} mm³`);
      }
      return {
        recipe: "split-solid-by-planes",
        status: "completed",
        documentToken: current.documentToken,
        beforeRevision: initial.revision,
        afterRevision: current.revision,
        sourceBodyId: input.targetId,
        resultBodyIds,
        cutCount: cuts.length,
        undoSteps: cuts.length * 4,
        inputVolumeMm3,
        resultVolumeMm3,
        volumeDifferenceMm3,
        cuts,
      };
    } catch (error) {
      const failedCutRevision = error instanceof SplitSolidByPlaneRecipeError ? error.lastConfirmedRevision : lastConfirmedRevision;
      throw new SplitSolidByPlanesRecipeError(error, cuts, failedCutRevision);
    }
  }

  private async requireExpectedState(documentToken: string, revision: string): Promise<RuntimeState> {
    const state = await this.operations.state();
    if (state.documentToken !== documentToken) throw new Error("Plasticity document changed during multi-plane split");
    if (state.revision !== revision) throw new Error(`Plasticity revision changed during multi-plane split: expected ${revision}, current ${state.revision}`);
    return state;
  }
}

function planeCrossesBounds(bounds: NonNullable<RuntimeState["bodies"][number]["boundsMm"]>, origin: Vector3, normal: Vector3): boolean {
  const distances: number[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) distances.push((x - origin[0]) * normal[0] + (y - origin[1]) * normal[1] + (z - origin[2]) * normal[2]);
    }
  }
  return Math.min(...distances) < -1e-6 && Math.max(...distances) > 1e-6;
}

function unique(values: number[]): number[] {
  const result = [...new Set(values)];
  if (result.length !== values.length) throw new Error("Multi-plane split produced duplicate body references");
  return result;
}
