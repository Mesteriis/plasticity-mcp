import type { PlasticityOperations } from "./operations.ts";
import type { RuntimeState } from "./runtime.ts";
import { SplitSolidByPlanesRecipe, type SplitSolidByPlanesResult } from "./split-solid-by-planes.ts";

type Vector3 = [number, number, number];
type SplitOperations = Pick<PlasticityOperations, "state" | "measureSolidProperties" | "validateBodies" | "createRectangle" | "patchClosedWires" | "cutWithFaces" | "remove">;

export interface SplitSolidToVolumeInput {
  targetId: number;
  usableBuildVolumeMm: Vector3;
  revision: string;
}

export interface SplitSolidToVolumeResult {
  recipe: "split-solid-to-build-volume";
  status: "completed";
  documentToken: string;
  beforeRevision: string;
  afterRevision: string;
  sourceBodyId: number;
  resultBodyIds: number[];
  segmentCounts: Vector3;
  expectedGridCellCount: number;
  partBoundsMm: Array<{ id: number; boundsMm: NonNullable<RuntimeState["bodies"][number]["boundsMm"]> }>;
  split: SplitSolidByPlanesResult;
}

export class SplitSolidToVolumeRecipe {
  private readonly operations: SplitOperations;
  private readonly splitGrid: Pick<SplitSolidByPlanesRecipe, "split">;

  constructor(operations: SplitOperations, splitGrid: Pick<SplitSolidByPlanesRecipe, "split"> = new SplitSolidByPlanesRecipe(operations)) {
    this.operations = operations;
    this.splitGrid = splitGrid;
  }

  async split(input: SplitSolidToVolumeInput): Promise<SplitSolidToVolumeResult> {
    const initial = await this.operations.state();
    if (initial.revision !== input.revision) throw new Error(`Stale reference: expected revision ${input.revision}, current revision is ${initial.revision}`);
    const source = initial.bodies.find((body) => body.id === input.targetId);
    if (!source || source.type !== "Solid" || !source.boundsMm) throw new Error(`Print-volume split requires a current bounded Solid: ${input.targetId}`);
    if (!input.usableBuildVolumeMm.every((value) => Number.isFinite(value) && value > 0)) throw new Error("Usable build volume must contain three positive finite millimeter dimensions");

    const extents = source.boundsMm.max.map((value, axis) => value - source.boundsMm!.min[axis]!) as Vector3;
    const segmentCounts = extents.map((extent, axis) => Math.ceil(extent / input.usableBuildVolumeMm[axis]!)) as Vector3;
    const expectedGridCellCount = segmentCounts.reduce((product, count) => product * count, 1);
    const planeCount = segmentCounts.reduce((sum, count) => sum + count - 1, 0);
    if (expectedGridCellCount === 1) throw new Error("Current Solid already fits inside the supplied usable build volume; no cut is needed");
    if (planeCount > 64) throw new Error(`Even grid would require ${planeCount} planes; maximum supported is 64`);
    if (expectedGridCellCount > 129) throw new Error(`Even grid would require ${expectedGridCellCount} cells; maximum supported is 129`);

    const axes: Array<{ normal: Vector3; xDirection: Vector3 }> = [
      { normal: [1, 0, 0], xDirection: [0, 1, 0] },
      { normal: [0, 1, 0], xDirection: [1, 0, 0] },
      { normal: [0, 0, 1], xDirection: [1, 0, 0] },
    ];
    const planes = segmentCounts.flatMap((count, axis) => Array.from({ length: count - 1 }, (_, cutIndex) => ({
      originMm: source.boundsMm!.min.map((value, coordinate) => coordinate === axis
        ? value + extents[axis]! * (cutIndex + 1) / count
        : value) as Vector3,
      ...axes[axis]!,
    })));
    const split = await this.splitGrid.split({ targetId: input.targetId, planes, revision: input.revision });
    const current = await this.operations.state();
    if (current.documentToken !== initial.documentToken || current.revision !== split.afterRevision) {
      throw new Error(`Plasticity changed after the grid split; expected revision ${split.afterRevision}, current revision is ${current.revision}`);
    }
    const partBoundsMm = split.resultBodyIds.map((id) => {
      const body = current.bodies.find((candidate) => candidate.id === id);
      if (!body || body.type !== "Solid" || !body.boundsMm) throw new Error(`Grid result ${id} is not a current bounded Solid`);
      return { id, boundsMm: body.boundsMm };
    });
    const oversized = partBoundsMm.filter(({ boundsMm }) => boundsMm.max.some((value, axis) =>
      value - boundsMm.min[axis]! > input.usableBuildVolumeMm[axis]! + 0.01));
    if (oversized.length > 0) {
      throw new Error(`Grid split completed but ${oversized.length} parts still exceed the usable build volume; inspect the current scene before further edits`);
    }

    return {
      recipe: "split-solid-to-build-volume",
      status: "completed",
      documentToken: current.documentToken,
      beforeRevision: initial.revision,
      afterRevision: current.revision,
      sourceBodyId: input.targetId,
      resultBodyIds: split.resultBodyIds,
      segmentCounts,
      expectedGridCellCount,
      partBoundsMm,
      split,
    };
  }
}
