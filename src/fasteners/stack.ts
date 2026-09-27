import { z } from "zod";

import { resolveFastenerDesignation } from "./designation.ts";

const gripItemSchema = z.object({
  id: z.string().trim().min(1).max(120),
  thicknessMm: z.number().finite().positive(),
}).strict();

const nutReceiverSchema = z.object({
  kind: z.literal("nut"),
  nutThicknessMm: z.number().finite().positive(),
  minimumProtrusionMm: z.number().finite().nonnegative(),
  maximumProtrusionMm: z.number().finite().nonnegative().optional(),
}).strict();

const threadedJointIntentSchema = z.enum([
  "machine-screw-into-heat-set-insert",
  "machine-screw-into-tapped-metal",
  "machine-screw-into-printed-plastic",
  "self-tapping-into-plastic",
]);

const threadedReceiverSchema = z.object({
  kind: z.literal("threaded"),
  jointIntent: threadedJointIntentSchema,
  requiredEngagementMm: z.number().finite().positive(),
  threadEngagementCapacityMm: z.number().finite().positive(),
  maximumInsertionDepthMm: z.number().finite().positive().optional(),
  minimumTipClearanceMm: z.number().finite().nonnegative().default(0),
  maximumProtrusionMm: z.number().finite().nonnegative().optional(),
}).strict();

export const fastenerStackInputSchema = z.object({
  designation: z.string().trim().min(1).max(500),
  lengthMeasurement: z.enum(["under-head", "overall"]),
  headAxialLengthMm: z.number().finite().positive().optional(),
  gripItems: z.array(gripItemSchema).min(1).max(64),
  receiver: z.discriminatedUnion("kind", [nutReceiverSchema, threadedReceiverSchema]),
}).strict().superRefine((input, context) => {
  const itemIds = input.gripItems.map((item) => item.id);
  if (new Set(itemIds).size !== itemIds.length) {
    context.addIssue({ code: "custom", path: ["gripItems"], message: "Grip item IDs must be unique" });
  }
  if (input.lengthMeasurement === "overall" && input.headAxialLengthMm === undefined) {
    context.addIssue({ code: "custom", path: ["headAxialLengthMm"], message: "Overall length requires an explicit head axial length" });
  }
  if (input.lengthMeasurement === "under-head" && input.headAxialLengthMm !== undefined) {
    context.addIssue({ code: "custom", path: ["headAxialLengthMm"], message: "Head axial length applies only to an overall-length designation" });
  }
  if (input.receiver.kind === "nut"
    && input.receiver.maximumProtrusionMm !== undefined
    && input.receiver.maximumProtrusionMm < input.receiver.minimumProtrusionMm) {
    context.addIssue({ code: "custom", path: ["receiver", "maximumProtrusionMm"], message: "Maximum protrusion must be at least the minimum protrusion" });
  }
});

export type FastenerStackInput = z.input<typeof fastenerStackInputSchema>;

export interface FastenerStackIssue {
  code:
    | "FASTENER_LENGTH_UNRESOLVED"
    | "JOINT_INTENT_CONFLICT"
    | "HEAD_LENGTH_EXCEEDS_NOMINAL_LENGTH"
    | "FASTENER_TOO_SHORT"
    | "PROTRUSION_EXCEEDS_MAXIMUM"
    | "INSUFFICIENT_THREAD_ENGAGEMENT"
    | "FASTENER_BOTTOMS_OUT"
    | "THREAD_PROTRUSION_EXCEEDS_MAXIMUM";
  message: string;
}

interface NutStackResult {
  kind: "nut";
  nutThicknessMm: number;
  actualProtrusionMm: number;
  minimumProtrusionMm: number;
  maximumProtrusionMm?: number;
}

interface ThreadedStackResult {
  kind: "threaded";
  jointIntent: z.infer<typeof threadedJointIntentSchema>;
  insertionMm: number;
  actualEngagementMm: number;
  engagementMarginMm: number;
  requiredEngagementMm: number;
  threadEngagementCapacityMm: number;
  remainingTipClearanceMm?: number;
  minimumTipClearanceMm: number;
  protrusionBeyondThreadsMm?: number;
  maximumProtrusionMm?: number;
}

export interface FastenerStackResult {
  status: "pass" | "fail" | "needs-input" | "unsupported";
  designation: {
    original: string;
    normalized?: string;
    nominalDiameterMm?: number;
    pitchMm?: number;
    nominalLengthMm?: number;
  };
  lengthMeasurement: "under-head" | "overall";
  headAxialLengthMm?: number;
  gripItems: Array<{ id: string; thicknessMm: number }>;
  gripThicknessMm: number;
  usableUnderHeadLengthMm?: number;
  minimumRequiredLengthMm?: number;
  minimumLengthMarginMm?: number;
  receiver?: NutStackResult | ThreadedStackResult;
  issues: FastenerStackIssue[];
  nextAction: string;
  rules: string[];
}

export function checkFastenerStack(rawInput: FastenerStackInput): FastenerStackResult {
  const input = fastenerStackInputSchema.parse(rawInput);
  const jointIntent = input.receiver.kind === "nut" ? "through-bolt-with-nut" : input.receiver.jointIntent;
  const resolution = resolveFastenerDesignation({
    designation: input.designation,
    jointIntent,
    analysisIntent: "geometry",
    decisionMode: "ask-user",
  });
  const gripThicknessMm = clean(input.gripItems.reduce((total, item) => total + item.thicknessMm, 0));
  const designation = {
    original: resolution.original,
    ...(resolution.normalizedDesignation === undefined ? {} : { normalized: resolution.normalizedDesignation }),
    ...(resolution.thread.nominalDiameterMm === undefined ? {} : { nominalDiameterMm: resolution.thread.nominalDiameterMm }),
    ...(resolution.thread.pitchMm === undefined ? {} : { pitchMm: resolution.thread.pitchMm }),
    ...(resolution.lengthMm === undefined ? {} : { nominalLengthMm: resolution.lengthMm }),
  };
  const base = {
    designation,
    lengthMeasurement: input.lengthMeasurement,
    ...(input.headAxialLengthMm === undefined ? {} : { headAxialLengthMm: input.headAxialLengthMm }),
    gripItems: input.gripItems.map((item) => ({ ...item })),
    gripThicknessMm,
    rules: [
      "The selected product standard defines whether nominal length is measured under the head or overall.",
      "Grip items must include every clamped layer and washer between the head bearing plane and the receiver.",
      "A passing stack check proves only axial length compatibility; strength, preload, access, fit, thread stripping, and printed-part behavior require separate evidence.",
    ],
  };

  if (resolution.status === "unsupported") {
    return {
      ...base,
      status: "unsupported",
      issues: [{ code: "FASTENER_LENGTH_UNRESOLVED", message: "The designation does not provide a supported ISO metric nominal length." }],
      nextAction: "Resolve a supported metric fastener designation and its nominal length before creating dependent geometry.",
    };
  }
  if (resolution.issues.some((issue) => issue.code === "JOINT_INTENT_CONFLICT")) {
    return {
      ...base,
      status: "needs-input",
      issues: [{ code: "JOINT_INTENT_CONFLICT", message: "The designation phrase and structured receiver describe different joint types." }],
      nextAction: "Resolve whether the fastener uses a nut, insert, tapped metal, or plastic thread before checking its length.",
    };
  }
  if (resolution.lengthMm === undefined) {
    return {
      ...base,
      status: "needs-input",
      issues: [{ code: "FASTENER_LENGTH_UNRESOLVED", message: "Fastener length is missing or ambiguous in the designation." }],
      nextAction: "Ask whether the ambiguous trailing value is pitch or length, or obtain the exact nominal length from the selected part.",
    };
  }

  const headAxialLengthMm = input.headAxialLengthMm ?? 0;
  const usableUnderHeadLengthMm = clean(resolution.lengthMm - headAxialLengthMm);
  if (usableUnderHeadLengthMm <= 0) {
    return {
      ...base,
      status: "needs-input",
      usableUnderHeadLengthMm,
      issues: [{ code: "HEAD_LENGTH_EXCEEDS_NOMINAL_LENGTH", message: "The stated head axial length leaves no usable length below the head." }],
      nextAction: "Verify the product drawing, its length datum, and the head axial length before modifying CAD.",
    };
  }

  return input.receiver.kind === "nut"
    ? checkNutStack(input.receiver, base, usableUnderHeadLengthMm, headAxialLengthMm)
    : checkThreadedStack(input.receiver, base, usableUnderHeadLengthMm, headAxialLengthMm);
}

function checkNutStack(
  receiver: z.output<typeof nutReceiverSchema>,
  base: Omit<FastenerStackResult, "status" | "issues" | "nextAction">,
  usableUnderHeadLengthMm: number,
  headAxialLengthMm: number,
): FastenerStackResult {
  const gripThicknessMm = base.gripThicknessMm;
  const actualProtrusionMm = clean(usableUnderHeadLengthMm - gripThicknessMm - receiver.nutThicknessMm);
  const minimumRequiredUnderHeadMm = clean(gripThicknessMm + receiver.nutThicknessMm + receiver.minimumProtrusionMm);
  const minimumRequiredLengthMm = clean(minimumRequiredUnderHeadMm + headAxialLengthMm);
  const minimumLengthMarginMm = clean(usableUnderHeadLengthMm - minimumRequiredUnderHeadMm);
  const issues: FastenerStackIssue[] = [];
  if (actualProtrusionMm < receiver.minimumProtrusionMm) {
    issues.push({ code: "FASTENER_TOO_SHORT", message: `The fastener is ${clean(-minimumLengthMarginMm)} mm shorter than the required nut stack and minimum protrusion.` });
  }
  if (receiver.maximumProtrusionMm !== undefined && actualProtrusionMm > receiver.maximumProtrusionMm) {
    issues.push({ code: "PROTRUSION_EXCEEDS_MAXIMUM", message: `The fastener protrudes ${clean(actualProtrusionMm - receiver.maximumProtrusionMm)} mm beyond the allowed maximum.` });
  }
  return {
    ...base,
    status: issues.length === 0 ? "pass" : "fail",
    usableUnderHeadLengthMm,
    minimumRequiredLengthMm,
    minimumLengthMarginMm,
    receiver: {
      kind: "nut",
      nutThicknessMm: receiver.nutThicknessMm,
      actualProtrusionMm,
      minimumProtrusionMm: receiver.minimumProtrusionMm,
      ...(receiver.maximumProtrusionMm === undefined ? {} : { maximumProtrusionMm: receiver.maximumProtrusionMm }),
    },
    issues,
    nextAction: issues.length === 0
      ? "The nominal length fits the stated stack. Continue with separate fit, access, preload, fastener-strength, and surrounding-part checks."
      : "Select a longer qualified fastener or revise the explicit grip, nut, washer, recess, and protrusion dimensions; then run this check again before modifying CAD.",
  };
}

function checkThreadedStack(
  receiver: z.output<typeof threadedReceiverSchema>,
  base: Omit<FastenerStackResult, "status" | "issues" | "nextAction">,
  usableUnderHeadLengthMm: number,
  headAxialLengthMm: number,
): FastenerStackResult {
  const insertionMm = clean(usableUnderHeadLengthMm - base.gripThicknessMm);
  const actualEngagementMm = clean(Math.max(0, Math.min(insertionMm, receiver.threadEngagementCapacityMm)));
  const minimumRequiredUnderHeadMm = clean(base.gripThicknessMm + receiver.requiredEngagementMm);
  const minimumRequiredLengthMm = clean(minimumRequiredUnderHeadMm + headAxialLengthMm);
  const minimumLengthMarginMm = clean(usableUnderHeadLengthMm - minimumRequiredUnderHeadMm);
  const engagementMarginMm = clean(actualEngagementMm - receiver.requiredEngagementMm);
  const remainingTipClearanceMm = receiver.maximumInsertionDepthMm === undefined
    ? undefined
    : clean(receiver.maximumInsertionDepthMm - insertionMm);
  const protrusionBeyondThreadsMm = receiver.maximumProtrusionMm === undefined
    ? undefined
    : clean(Math.max(0, insertionMm - receiver.threadEngagementCapacityMm));
  const issues: FastenerStackIssue[] = [];
  if (actualEngagementMm < receiver.requiredEngagementMm) {
    issues.push({ code: "INSUFFICIENT_THREAD_ENGAGEMENT", message: `Available engagement is ${clean(receiver.requiredEngagementMm - actualEngagementMm)} mm below the required value.` });
  }
  if (remainingTipClearanceMm !== undefined && remainingTipClearanceMm < receiver.minimumTipClearanceMm) {
    issues.push({ code: "FASTENER_BOTTOMS_OUT", message: `The stated insertion leaves ${remainingTipClearanceMm} mm tip clearance, below the required ${receiver.minimumTipClearanceMm} mm.` });
  }
  if (protrusionBeyondThreadsMm !== undefined && protrusionBeyondThreadsMm > receiver.maximumProtrusionMm!) {
    issues.push({ code: "THREAD_PROTRUSION_EXCEEDS_MAXIMUM", message: `The fastener extends ${clean(protrusionBeyondThreadsMm - receiver.maximumProtrusionMm!)} mm beyond the allowed threaded receiver envelope.` });
  }
  return {
    ...base,
    status: issues.length === 0 ? "pass" : "fail",
    usableUnderHeadLengthMm,
    minimumRequiredLengthMm,
    minimumLengthMarginMm,
    receiver: {
      kind: "threaded",
      jointIntent: receiver.jointIntent,
      insertionMm,
      actualEngagementMm,
      engagementMarginMm,
      requiredEngagementMm: receiver.requiredEngagementMm,
      threadEngagementCapacityMm: receiver.threadEngagementCapacityMm,
      ...(remainingTipClearanceMm === undefined ? {} : { remainingTipClearanceMm }),
      minimumTipClearanceMm: receiver.minimumTipClearanceMm,
      ...(protrusionBeyondThreadsMm === undefined ? {} : { protrusionBeyondThreadsMm }),
      ...(receiver.maximumProtrusionMm === undefined ? {} : { maximumProtrusionMm: receiver.maximumProtrusionMm }),
    },
    issues,
    nextAction: issues.length === 0
      ? "The nominal length fits the stated threaded stack. Continue with separate thread-capacity, fastener-strength, access, and surrounding-part checks."
      : "Change the qualified fastener length, grip/recess stack, receiver engagement, or blind depth; then run this check again before modifying CAD.",
  };
}

function clean(value: number): number {
  return Object.is(value, -0) ? 0 : Math.round(value * 1e12) / 1e12;
}
