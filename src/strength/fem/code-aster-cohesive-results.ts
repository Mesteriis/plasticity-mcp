export interface CodeAsterCohesiveResultsInput {
  displacementTable: string;
  reactionTable: string;
  stateVariableTable: string;
  cohesiveElementIds: readonly number[];
  displacementComponent?: "DX" | "DY" | "DZ";
  displacementScale?: number;
  allowSolverRenumberedElementIds?: boolean;
  modeILaw?: "CZM_EXP_REG" | "CZM_LIN_REG";
}

export type CodeAsterV3Interpretation = "damage-variable-0-to-1" | "state-variable-2-means-fully-broken";

export interface CodeAsterCohesiveResults {
  solverVersion: string;
  displacementHistory: Array<{ order: number; time: number; minMm: number; maxMm: number }>;
  reactionHistory: Array<{ order: number; time: number; xN: number; yN: number; zN: number }>;
  interfaceStateHistory: Array<{
    order: number;
    time: number;
    elementCount: number;
    variables: Record<"V3" | "V7" | "V8" | "V9", { min: number; max: number }>;
  }>;
  v3Interpretation: CodeAsterV3Interpretation;
  interpretation: "raw-cohesive-solver-response";
}

type Increment = { order: number; time: number };
type Range = { min: number; max: number };

const STATE_VARIABLES = ["V3", "V7", "V8", "V9"] as const;

export function parseCodeAsterCohesiveResults(input: CodeAsterCohesiveResultsInput): CodeAsterCohesiveResults {
  const expectedElementIds = new Set(input.cohesiveElementIds);
  if (expectedElementIds.size === 0 || expectedElementIds.size !== input.cohesiveElementIds.length
    || [...expectedElementIds].some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("Declared cohesive element IDs must be unique positive safe integers");
  }

  const versions = [input.displacementTable, input.reactionTable, input.stateVariableTable].map(solverVersion);
  if (versions.some((version) => version !== versions[0])) throw new Error("Cohesive result tables must use the same Code_Aster version");

  const displacementScale = input.displacementScale ?? 1;
  if (!Number.isFinite(displacementScale) || displacementScale === 0) {
    throw new Error("Displacement projection scale must be finite and nonzero");
  }
  const displacements = parseDisplacementTable(input.displacementTable, input.displacementComponent ?? "DZ", displacementScale);
  const reactions = parseReactionTable(input.reactionTable);
  const interfaceStates = parseStateVariableTable(input.stateVariableTable, expectedElementIds, input.allowSolverRenumberedElementIds ?? false);
  if (displacements.length === 0 || reactions.length === 0 || interfaceStates.length === 0) {
    throw new Error("Cohesive result tables contain no parsed result increments");
  }
  const displacementOrders = new Set(displacements.map(({ order }) => order));
  const reactionOrders = new Set(reactions.map(({ order }) => order));
  const stateOrders = new Set(interfaceStates.map(({ order }) => order));
  if (!sameNumberSet(displacementOrders, reactionOrders) || !sameNumberSet(displacementOrders, stateOrders)) {
    throw new Error("Displacement, reaction and interface-state tables must contain the same result increments");
  }

  return {
    solverVersion: versions[0]!,
    displacementHistory: displacements,
    reactionHistory: reactions,
    interfaceStateHistory: interfaceStates,
    v3Interpretation: input.modeILaw === "CZM_LIN_REG" ? "state-variable-2-means-fully-broken" : "damage-variable-0-to-1",
    interpretation: "raw-cohesive-solver-response",
  };
}

function parseDisplacementTable(
  text: string,
  component: "DX" | "DY" | "DZ",
  scale: number,
): CodeAsterCohesiveResults["displacementHistory"] {
  const increments = new Map<number, Increment & { minMm?: number; maxMm?: number }>();
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 9 || fields[0] !== "TOP_DISPLACEMENT") continue;
    if (fields[2] !== "DEPL" || fields[7] !== component || !["MIN", "MAX"].includes(fields[5]!)) continue;
    const order = positiveOrZeroInteger(fields[3]!, "displacement result order");
    const time = finiteNumber(fields[4]!, "displacement time");
    const value = finiteNumber(fields[8]!, "displacement");
    const increment = getIncrement(increments, order, time);
    const key = fields[5] === "MIN" ? "minMm" : "maxMm";
    if (increment[key] !== undefined) throw new Error(`Duplicate ${fields[5]} displacement extremum at result order ${order}`);
    increment[key] = value * scale;
  }
  return [...increments.values()].sort(byOrder).map((increment) => {
    if (increment.minMm === undefined || increment.maxMm === undefined) {
      throw new Error(`Displacement table is missing a valid min/max pair at result order ${increment.order}`);
    }
    return {
      order: increment.order,
      time: increment.time,
      minMm: Math.min(increment.minMm, increment.maxMm),
      maxMm: Math.max(increment.minMm, increment.maxMm),
    };
  });
}

function parseReactionTable(text: string): CodeAsterCohesiveResults["reactionHistory"] {
  const increments = new Map<number, Increment & { xN: number; yN: number; zN: number }>();
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8 || fields[0] !== "BOTTOM_REACTION") continue;
    if (fields[2] !== "REAC_NODA") continue;
    const order = positiveOrZeroInteger(fields[3]!, "reaction result order");
    const time = finiteNumber(fields[4]!, "reaction time");
    if (increments.has(order)) throw new Error(`Duplicate reaction resultant at result order ${order}`);
    increments.set(order, {
      order,
      time,
      xN: finiteNumber(fields[5]!, "X reaction"),
      yN: finiteNumber(fields[6]!, "Y reaction"),
      zN: finiteNumber(fields[7]!, "Z reaction"),
    });
  }
  return [...increments.values()].sort(byOrder);
}

function parseStateVariableTable(
  text: string,
  expectedElementIds: ReadonlySet<number>,
  allowSolverRenumberedElementIds: boolean,
): CodeAsterCohesiveResults["interfaceStateHistory"] {
  const increments = new Map<number, Increment & { elements: Set<number>; variables: Record<(typeof STATE_VARIABLES)[number], Range> }>();
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 14 || fields[1] !== "VARI_ELGA") continue;
    // Code_Aster 15.2 emits M<id>; 17.4 emits renumbered mesh-cell IDs without M.
    const match = /^(?:M)?(\d+)$/.exec(fields[4]!);
    if (!match) continue;
    const elementId = positiveOrZeroInteger(match[1]!, "cohesive element ID");
    if (!allowSolverRenumberedElementIds && !expectedElementIds.has(elementId)) continue;

    const time = finiteNumber(fields[2]!, "interface-state time");
    const order = positiveOrZeroInteger(fields[3]!, "interface-state result order");
    let increment = increments.get(order);
    if (!increment) {
      increment = { order, time, elements: new Set(), variables: emptyRanges() };
      increments.set(order, increment);
    } else if (increment.time !== time) {
      throw new Error(`Conflicting interface-state times at result order ${order}`);
    }
    increment.elements.add(elementId);
    for (let index = 0; index < STATE_VARIABLES.length; index += 1) {
      const variable = STATE_VARIABLES[index]!;
      addToRange(increment.variables[variable], finiteNumber(fields[10 + index]!, variable));
    }
  }

  return [...increments.values()].sort(byOrder).map((increment) => {
    if (increment.elements.size !== expectedElementIds.size) {
      throw new Error(`Interface-state table at result order ${increment.order} does not contain every declared cohesive element`);
    }
    return {
      order: increment.order,
      time: increment.time,
      elementCount: increment.elements.size,
      variables: increment.variables,
    };
  });
}

function solverVersion(text: string): string {
  const match = /#ASTER\s+(\d+\.\d+\.\d+)/.exec(text);
  if (!match) throw new Error("Cohesive result table is missing its Code_Aster version");
  return match[1]!;
}

function finiteNumber(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be finite in Code_Aster output`);
  return number;
}

function positiveOrZeroInteger(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a nonnegative safe integer in Code_Aster output`);
  return number;
}

function getIncrement<T extends Increment>(map: Map<number, T>, order: number, time: number): T {
  let increment = map.get(order);
  if (!increment) {
    increment = { order, time } as T;
    map.set(order, increment);
  } else if (increment.time !== time) {
    throw new Error(`Conflicting result times at result order ${order}`);
  }
  return increment;
}

function emptyRanges(): Record<(typeof STATE_VARIABLES)[number], Range> {
  return { V3: { min: Infinity, max: -Infinity }, V7: { min: Infinity, max: -Infinity }, V8: { min: Infinity, max: -Infinity }, V9: { min: Infinity, max: -Infinity } };
}

function addToRange(range: Range, value: number): void {
  range.min = Math.min(range.min, value);
  range.max = Math.max(range.max, value);
}

function byOrder(left: Increment, right: Increment): number {
  return left.order - right.order;
}

function sameNumberSet(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
