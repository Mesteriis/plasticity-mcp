import { z } from "zod";

export const MAX_LAYERWISE_FEA_LAYERS = 256;
export const MAX_LAYER_INTERFACE_PLANES = MAX_LAYERWISE_FEA_LAYERS - 1;

const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const unitDirection = vector.refine((value) => Math.abs(Math.hypot(...value) - 1) <= 1e-6, "Build direction must be a unit vector");
const depositionPathOrientationSchema = z.object({
  layerIndex: z.number().int().positive(),
  planarPathLengthMm: z.number().finite().nonnegative(),
  principalDirectionDeg: z.number().finite().min(0).lt(180).nullable(),
  directionalConcentration: z.number().finite().min(0).max(1).nullable(),
  curvedExtrusionMoves: z.number().int().nonnegative(),
  coverage: z.enum(["complete-linear", "complete-planar", "partial-curved", "no-planar-extrusion"]),
}).strict().superRefine((orientation, context) => {
  if (orientation.planarPathLengthMm === 0 && (orientation.principalDirectionDeg !== null || orientation.directionalConcentration !== null)) {
    context.addIssue({ code: "custom", path: ["principalDirectionDeg"], message: "A layer without planar extrusion cannot claim an XY road direction or concentration" });
  }
  if (orientation.planarPathLengthMm > 0 && orientation.directionalConcentration === null) {
    context.addIssue({ code: "custom", path: ["directionalConcentration"], message: "Planar extrusion requires a directional concentration measurement" });
  }
  if (orientation.coverage === "complete-linear" && (orientation.curvedExtrusionMoves !== 0 || orientation.planarPathLengthMm <= 0)) {
    context.addIssue({ code: "custom", path: ["coverage"], message: "Complete linear coverage requires planar extrusion and no curved extrusion moves" });
  }
  if (orientation.coverage === "complete-planar" && (orientation.curvedExtrusionMoves === 0 || orientation.planarPathLengthMm <= 0)) {
    context.addIssue({ code: "custom", path: ["coverage"], message: "Complete planar coverage requires measured linear or circular-arc extrusion paths" });
  }
  if (orientation.coverage === "partial-curved" && orientation.curvedExtrusionMoves === 0) {
    context.addIssue({ code: "custom", path: ["coverage"], message: "Partial curved coverage requires at least one curved extrusion move" });
  }
  if (orientation.coverage === "no-planar-extrusion" && (orientation.planarPathLengthMm !== 0 || orientation.curvedExtrusionMoves !== 0)) {
    context.addIssue({ code: "custom", path: ["coverage"], message: "No-planar-extrusion coverage cannot include planar paths or curved extrusion moves" });
  }
});
const depositionPathEvidenceSchema = z.object({
  jobId: z.string().trim().min(1).max(240),
  profileHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceArtifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  gcodeArtifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  layerCount: z.number().int().min(2).max(2_000_000),
  coordinateFrame: z.literal("slicer-build"),
  firstDepositionLayerZMm: z.number().finite(),
  interfaces: z.array(z.object({
    interfaceLayerIndex: z.number().int().positive(),
    depositionLayerZMm: z.number().finite(),
    relativeOffsetMm: z.number().finite().nonnegative(),
    depositionPathOrientation: depositionPathOrientationSchema,
  }).strict()).min(1).max(MAX_LAYER_INTERFACE_PLANES),
}).strict();
const layerPathEvidenceSchema = z.object({
  jobId: z.string().trim().min(1).max(240),
  profileHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceArtifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  gcodeArtifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  layerCount: z.number().int().min(1).max(2_000_000),
  coordinateFrame: z.literal("slicer-build"),
  layers: z.array(z.object({
    layerIndex: z.number().int().positive(),
    depositionLayerZMm: z.number().finite(),
    pathOrientation: depositionPathOrientationSchema,
  }).strict()).min(1).max(MAX_LAYERWISE_FEA_LAYERS),
}).strict();
const pathFrameMappingSchema = z.object({
  slicerXDirectionGlobal: vector,
  evidence: z.object({
    status: z.literal("user-confirmed"),
    description: z.string().trim().min(12).max(1000),
  }).strict(),
}).strict();
const roadAxisMappingSchema = z.object({
  status: z.literal("user-confirmed"),
  couponAxis1Meaning: z.literal("dominant-deposition-road-direction"),
  evidence: z.object({
    description: z.string().trim().min(24).max(1000),
  }).strict(),
}).strict();

export const cohesiveLayerPlanePlanInputSchema = z.object({
  processProfileHash: z.string().regex(/^[a-f0-9]{64}$/),
  firstInterfacePointMm: vector,
  buildDirectionGlobal: unitDirection,
  layerHeightMm: z.number().finite().positive().max(2),
  totalLayerCount: z.number().int().min(2).max(2_000_000),
  interfaceLayerIndices: z.array(z.number().int().positive()).min(1).max(MAX_LAYER_INTERFACE_PLANES),
  interfaceOffsetsMm: z.array(z.number().finite().nonnegative()).min(1).max(MAX_LAYER_INTERFACE_PLANES).optional(),
  depositionPathEvidence: depositionPathEvidenceSchema.optional(),
  layerPathEvidence: layerPathEvidenceSchema.optional(),
  pathFrameMapping: pathFrameMappingSchema.optional(),
  roadAxisMapping: roadAxisMappingSchema.optional(),
}).strict().superRefine((input, context) => {
  const indices = input.interfaceLayerIndices;
  if (indices.some((index, position) => index >= input.totalLayerCount
    || (position > 0 && indices[position - 1]! >= index))) {
    context.addIssue({ code: "custom", path: ["interfaceLayerIndices"], message: "Interface layer indices must be strictly increasing and between 1 and totalLayerCount - 1" });
  }
  const interfaceCount = input.totalLayerCount - 1;
  if (interfaceCount <= MAX_LAYER_INTERFACE_PLANES && (indices.length !== interfaceCount || indices.some((index, position) => index !== position + 1))) {
    context.addIssue({ code: "custom", path: ["interfaceLayerIndices"], message: `When the complete stack has at most ${MAX_LAYER_INTERFACE_PLANES} interfaces, every interface must be included` });
  }
  if (input.interfaceOffsetsMm) {
    if (input.interfaceOffsetsMm.length !== indices.length) {
      context.addIssue({ code: "custom", path: ["interfaceOffsetsMm"], message: "Provide one deposition-height offset for each selected interface layer index" });
    }
    if (Math.abs(input.interfaceOffsetsMm[0]!) > 1e-6) {
      context.addIssue({ code: "custom", path: ["interfaceOffsetsMm", 0], message: "The first interface offset must be zero because firstInterfacePointMm anchors that plane" });
    }
    if (input.interfaceOffsetsMm.some((offset, position) => position > 0 && offset <= input.interfaceOffsetsMm![position - 1]! + 1e-6)) {
      context.addIssue({ code: "custom", path: ["interfaceOffsetsMm"], message: "Deposition-height offsets must be strictly increasing" });
    }
  }
  if (input.depositionPathEvidence) {
    const pathEvidence = input.depositionPathEvidence;
    if (pathEvidence.profileHash !== input.processProfileHash) {
      context.addIssue({ code: "custom", path: ["depositionPathEvidence", "profileHash"], message: "G-code path evidence profile hash must match the layer-plane plan profile hash" });
    }
    if (pathEvidence.layerCount !== input.totalLayerCount) {
      context.addIssue({ code: "custom", path: ["depositionPathEvidence", "layerCount"], message: "G-code path evidence layer count must match the layer-plane plan" });
    }
    if (pathEvidence.interfaces.length !== indices.length || pathEvidence.interfaces.some((item, position) =>
      item.interfaceLayerIndex !== indices[position]
        || item.depositionPathOrientation.layerIndex !== item.interfaceLayerIndex
        || input.interfaceOffsetsMm?.[position] === undefined
        || Math.abs(item.relativeOffsetMm - input.interfaceOffsetsMm[position]!) > 1e-6
        || Math.abs(item.relativeOffsetMm - (item.depositionLayerZMm - pathEvidence.firstDepositionLayerZMm)) > 1e-6)) {
      context.addIssue({ code: "custom", path: ["depositionPathEvidence", "interfaces"], message: "G-code path evidence must contain every selected interface in order and match its selected interface layer" });
    }
    if (!input.interfaceOffsetsMm) {
      context.addIssue({ code: "custom", path: ["interfaceOffsetsMm"], message: "G-code interface evidence can only be attached when its selected relative deposition offsets are used by the layer-plane plan" });
    }
  }
  if (input.layerPathEvidence) {
    const evidence = input.layerPathEvidence;
    if (evidence.profileHash !== input.processProfileHash) {
      context.addIssue({ code: "custom", path: ["layerPathEvidence", "profileHash"], message: "G-code layer path evidence profile hash must match the layer-plane plan profile hash" });
    }
    if (evidence.layerCount !== input.totalLayerCount) {
      context.addIssue({ code: "custom", path: ["layerPathEvidence", "layerCount"], message: "G-code layer path evidence layer count must match the layer-plane plan" });
    }
    const indices = evidence.layers.map((layer) => layer.layerIndex);
    if (evidence.layers.some((layer, position) => layer.layerIndex > evidence.layerCount
      || layer.pathOrientation.layerIndex !== layer.layerIndex
      || (position > 0 && indices[position - 1]! >= layer.layerIndex)
      || (position > 0 && evidence.layers[position - 1]!.depositionLayerZMm >= layer.depositionLayerZMm))) {
      context.addIssue({ code: "custom", path: ["layerPathEvidence", "layers"], message: "G-code layer path evidence must be ordered, unique, within the stack, and have strictly increasing deposition heights" });
    }
    if (evidence.layerCount <= MAX_LAYERWISE_FEA_LAYERS
      && (evidence.layers.length !== evidence.layerCount || indices.some((index, position) => index !== position + 1))) {
      context.addIssue({ code: "custom", path: ["layerPathEvidence", "layers"], message: `For stacks of at most ${MAX_LAYERWISE_FEA_LAYERS} layers, include every deposited layer in order` });
    }
    if (input.depositionPathEvidence && (input.depositionPathEvidence.jobId !== evidence.jobId
      || input.depositionPathEvidence.profileHash !== evidence.profileHash
      || input.depositionPathEvidence.sourceArtifactHash !== evidence.sourceArtifactHash
      || input.depositionPathEvidence.gcodeArtifactHash !== evidence.gcodeArtifactHash
      || input.depositionPathEvidence.layerCount !== evidence.layerCount)) {
      context.addIssue({ code: "custom", path: ["layerPathEvidence"], message: "Interface and per-layer path evidence must identify the same Workbench slice job and artifacts" });
    }
  }
  if (input.pathFrameMapping) {
    const [x, y, z] = input.pathFrameMapping.slicerXDirectionGlobal;
    const build = input.buildDirectionGlobal;
    const buildLength = Math.hypot(...build);
    const buildUnit = build.map((value) => value / buildLength);
    const xLength = Math.hypot(x, y, z);
    if (Math.abs(xLength - 1) > 1e-6) {
      context.addIssue({ code: "custom", path: ["pathFrameMapping", "slicerXDirectionGlobal"], message: "Confirmed slicer X direction must be a unit vector in the CAD global frame" });
    }
    if (Math.abs(x * buildUnit[0]! + y * buildUnit[1]! + z * buildUnit[2]!) > 1e-6) {
      context.addIssue({ code: "custom", path: ["pathFrameMapping", "slicerXDirectionGlobal"], message: "Confirmed slicer X direction must lie in the build plane" });
    }
    if (!input.depositionPathEvidence && !input.layerPathEvidence) {
      context.addIssue({ code: "custom", path: ["pathFrameMapping"], message: "A slicer-to-CAD frame mapping requires matching G-code deposition path evidence" });
    }
  }
  if (input.roadAxisMapping) {
    const evidence = input.layerPathEvidence;
    if (!input.pathFrameMapping || !evidence) {
      context.addIssue({ code: "custom", path: ["roadAxisMapping"], message: "Mapping coupon axis 1 to deposited roads requires both a confirmed slicer-to-CAD frame and full layer-path evidence" });
    } else if (input.totalLayerCount > MAX_LAYERWISE_FEA_LAYERS || evidence.layerCount !== input.totalLayerCount
      || evidence.layers.length !== input.totalLayerCount
      || evidence.layers.some((layer, index) => layer.layerIndex !== index + 1
        || (layer.pathOrientation.coverage !== "complete-linear" && layer.pathOrientation.coverage !== "complete-planar")
        || layer.pathOrientation.principalDirectionDeg === null
        || layer.pathOrientation.directionalConcentration === null
        || layer.pathOrientation.directionalConcentration <= 0)) {
      context.addIssue({ code: "custom", path: ["roadAxisMapping"], message: `Layerwise solver orientation requires complete linear/circular-arc G-code direction evidence for every layer in a stack of at most ${MAX_LAYERWISE_FEA_LAYERS} layers` });
    }
  }
});

export type CohesiveLayerPlanePlanInput = z.infer<typeof cohesiveLayerPlanePlanInputSchema>;

export function createCohesiveLayerPlanePlan(rawInput: CohesiveLayerPlanePlanInput) {
  const input = cohesiveLayerPlanePlanInputSchema.parse(rawInput);
  const directionLength = Math.hypot(...input.buildDirectionGlobal);
  const buildDirectionGlobal = input.buildDirectionGlobal.map((component) => component / directionLength) as [number, number, number];
  const plan = { ...input, buildDirectionGlobal };
  const planes = input.interfaceLayerIndices.map((layerIndex, position) => ({
    pointMm: input.firstInterfacePointMm.map((coordinate, axis) =>
      coordinate + buildDirectionGlobal[axis]! * (input.interfaceOffsetsMm?.[position] ?? input.layerHeightMm * (layerIndex - 1)),
    ) as [number, number, number],
    normalGlobal: buildDirectionGlobal,
  }));
  const solverMappedAxes = Boolean(input.roadAxisMapping);
  const layerMaterialFrames = input.pathFrameMapping && (input.layerPathEvidence || input.depositionPathEvidence)
    ? (input.layerPathEvidence
      ? input.layerPathEvidence.layers.map((item) => candidateLayerMaterialFrame(
        item.pathOrientation,
        input.pathFrameMapping!.slicerXDirectionGlobal,
        buildDirectionGlobal,
        solverMappedAxes,
      ))
      : input.depositionPathEvidence!.interfaces.map((item) => candidateLayerMaterialFrame(
        item.depositionPathOrientation,
        input.pathFrameMapping!.slicerXDirectionGlobal,
        buildDirectionGlobal,
        solverMappedAxes,
      )))
    : undefined;
  const complete = input.totalLayerCount - 1 === input.interfaceLayerIndices.length;
  const frameDescription = solverMappedAxes
    ? "Because the user explicitly confirms that exact-process coupon axis 1 represents the dominant deposited-road direction, the confirmed slicer-to-CAD frame and complete linear/circular-arc G-code direction evidence map one shared measured orthotropic tensor onto each layer's local frame in the Mode-I or Turon solver. This changes orientation only: it does not assign different materials or properties to layers, and the cohesive law remains the same measured, direction-independent interface law at every plane."
    : "G-code road directions are provenance only. Per-layer global material frames, when returned, are geometry-only candidates derived from a confirmed coordinate mapping and G-code direction summaries; they do not alter solver material response. Providing roadAxisMapping is required before frames can be used as solver inputs.";
  return {
    plan,
    planes,
    ...(layerMaterialFrames ? { layerMaterialFrames } : {}),
    coverage: complete ? "all-layer-interfaces" as const : "selected-interfaces-only" as const,
    limitation: complete
      ? `Profile hash, layer height, layer count, build direction, slicer-to-CAD frame mapping and first-interface anchor are caller-supplied; the helper does not fetch slicer state, and the anchor is not verified against CAD until meshing succeeds. ${frameDescription} The same measured cohesive law is repeated at every modeled interface; individual roads, within-layer raster mixtures and layer-dependent material properties are not resolved.`
      : `Profile hash, layer height, layer count, build direction, slicer-to-CAD frame mapping and first-interface anchor are caller-supplied; the helper does not fetch slicer state, and the anchor is not verified against CAD until meshing succeeds. Omitted layer interfaces are not analyzed; this selected-plane solver response cannot establish full-stack delamination resistance. ${frameDescription}`,
  };
}

export function confirmedLayerOrthotropicFrames(rawInput: CohesiveLayerPlanePlanInput): Array<{
  layerIndex: number;
  orientation: {
    axis1DirectionGlobal: [number, number, number];
    axis2ReferenceDirectionGlobal: [number, number, number];
    buildDirectionGlobal: [number, number, number];
  };
}> {
  const plan = createCohesiveLayerPlanePlan(rawInput);
  const frames = plan.layerMaterialFrames;
  if (!plan.plan.roadAxisMapping || !frames || frames.length !== plan.plan.totalLayerCount) {
    throw new Error("Layerwise solver orientation requires the user-confirmed coupon road-axis mapping and complete linear/circular-arc G-code evidence for every layer");
  }
  const completeFrames = frames.filter((frame): frame is NonNullable<typeof frame> => frame !== null);
  if (completeFrames.length !== frames.length || completeFrames.some((frame, index) => frame.layerIndex !== index + 1
      || frame.applicability !== "user-confirmed-road-axis-mapping"
      || (frame.coverage !== "complete-linear" && frame.coverage !== "complete-planar"))) {
    throw new Error("Layerwise solver orientation requires the user-confirmed coupon road-axis mapping and complete linear/circular-arc G-code evidence for every layer");
  }
  return completeFrames.map((frame) => ({
    layerIndex: frame.layerIndex,
    orientation: {
      axis1DirectionGlobal: frame.axis1DirectionGlobal,
      axis2ReferenceDirectionGlobal: frame.axis2DirectionGlobal,
      buildDirectionGlobal: frame.axis3DirectionGlobal,
    },
  }));
}

function candidateLayerMaterialFrame(
  path: z.infer<typeof depositionPathOrientationSchema>,
  slicerXDirectionGlobal: [number, number, number],
  buildDirectionGlobal: [number, number, number],
  solverMappedAxes: boolean,
) {
  if (path.principalDirectionDeg === null) return null;
  const xDirection = normalize(slicerXDirectionGlobal);
  const yDirection = cross(buildDirectionGlobal, xDirection);
  const angle = path.principalDirectionDeg * Math.PI / 180;
  const axis1DirectionGlobal = normalize(xDirection.map((value, axis) =>
    value * Math.cos(angle) + yDirection[axis]! * Math.sin(angle),
  ) as [number, number, number]);
  const axis2DirectionGlobal = normalize(cross(buildDirectionGlobal, axis1DirectionGlobal));
  return {
    layerIndex: path.layerIndex,
    axis1DirectionGlobal,
    axis2DirectionGlobal,
    axis3DirectionGlobal: buildDirectionGlobal,
    directionalConcentration: path.directionalConcentration,
    coverage: path.coverage,
    applicability: solverMappedAxes ? "user-confirmed-road-axis-mapping" as const : "candidate-material-axes-only" as const,
  };
}

function normalize(vector: [number, number, number]): [number, number, number] {
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length) as [number, number, number];
}

function cross(first: [number, number, number], second: [number, number, number]): [number, number, number] {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}
