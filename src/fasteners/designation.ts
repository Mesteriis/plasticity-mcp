import { z } from "zod";

export const jointIntentValues = [
  "unknown",
  "through-bolt-with-nut",
  "machine-screw-into-heat-set-insert",
  "machine-screw-into-tapped-metal",
  "machine-screw-into-printed-plastic",
  "self-tapping-into-plastic",
  "printed-threaded-pair",
] as const;

export const mountingIntentValues = ["unknown", "fixed", "adjustable", "pivot"] as const;
export const fastenerDecisionModeValues = ["ask-user", "agent-may-select-qualified"] as const;

export const fastenerDesignationInputSchema = z.object({
  designation: z.string().trim().min(1).max(500),
  jointIntent: z.enum(jointIntentValues).default("unknown"),
  mountingIntent: z.enum(mountingIntentValues).default("unknown"),
  analysisIntent: z.enum(["geometry", "strength", "both"]).default("both"),
  decisionMode: z.enum(fastenerDecisionModeValues).default("ask-user"),
}).strict();

export type FastenerDesignationInput = z.input<typeof fastenerDesignationInputSchema>;
type ParsedFastenerDesignationInput = z.output<typeof fastenerDesignationInputSchema>;
type JointIntent = ParsedFastenerDesignationInput["jointIntent"];
type MountingIntent = ParsedFastenerDesignationInput["mountingIntent"];
type AnalysisIntent = ParsedFastenerDesignationInput["analysisIntent"];
type DecisionMode = ParsedFastenerDesignationInput["decisionMode"];

type HeadStyle = "unknown" | "external-hex" | "socket-head-cap" | "button" | "pan" | "countersunk" | "headless";
type FastenerForm = "unknown" | "screw-unspecified" | "bolt-unspecified" | "stud" | "self-tapping-screw" | "hex-head-screw" | "hex-head-bolt" | "socket-head-cap-screw" | "button-head-screw" | "pan-head-screw" | "countersunk-screw" | "set-screw";
type DriveStyle = "unknown" | "external-hex" | "hexagon-socket" | "hexalobular-socket" | "cross-recessed";
type PointStyle = "flat" | "truncated-cone" | "dog" | "cup";

interface StandardDescriptor {
  family: "ISO" | "DIN" | "GOST";
  number: string;
  sourceUrl?: string;
}

interface StandardRule {
  form: FastenerForm;
  headStyle: HeadStyle;
  driveStyle: DriveStyle;
  pointStyle?: PointStyle;
  sourceUrl?: string;
}

export interface FastenerDesignationResolution {
  status: "resolved" | "needs-input" | "unsupported";
  original: string;
  normalizedDesignation?: string;
  form: FastenerForm;
  headStyle: HeadStyle;
  driveStyle: DriveStyle;
  pointStyle?: PointStyle;
  thread: {
    system: "ISO-metric" | "custom-rounded-print" | "unknown";
    nominalDiameterMm?: number;
    pitchMm?: number;
    pitchSource?: "explicit" | "catalog-coarse-default";
  };
  lengthMm?: number;
  ambiguousTrailingValueMm?: number;
  standard?: StandardDescriptor;
  propertyClass?: string;
  jointIntent: JointIntent;
  analysisIntent: AnalysisIntent;
  interpretation: {
    quantity?: number;
    jointIntentSource: "explicit" | "designation-phrase" | "unresolved";
    mountingIntent: MountingIntent;
    mountingIntentSource: "explicit" | "designation-phrase" | "unresolved";
    decisionMode: DecisionMode;
  };
  workflow: {
    route: string;
    compatibleTools: string[];
    sequence: string[];
  };
  requiredInputs: string[];
  questions: { id: string; question: string; reason: string; resolves: string[] }[];
  questionPackages: FastenerQuestionPackage[];
  nextQuestionPackage?: FastenerQuestionPackage;
  issues: { code: string; message: string }[];
  nextAction: {
    kind: "ask-user" | "resolve-qualified-data" | "modify-cad";
    instruction: string;
  };
  sourceUrls: string[];
  rules: string[];
}

export interface FastenerQuestionPackage {
  id: "strength-basis" | "joint-definition" | "hardware-selection" | "feature-geometry";
  phase: "strength" | "joint" | "hardware" | "geometry";
  instruction: string;
  questions: FastenerDesignationResolution["questions"];
}

const ISO_262_URL = "https://www.iso.org/standard/85105.html";
const ISO_261_URL = "https://www.iso.org/standard/4165.html";
const COARSE_THREAD_DATA_URL = "https://www.trfastenings.com/knowledge-base/thread-geometries/metric-coarse-standard";

const COARSE_PITCH_MM = new Map<number, number>([
  [1.6, 0.35],
  [2, 0.4],
  [2.5, 0.45],
  [3, 0.5],
  [3.5, 0.6],
  [4, 0.7],
  [4.5, 0.75],
  [5, 0.8],
  [6, 1],
  [7, 1],
  [8, 1.25],
  [10, 1.5],
  [12, 1.75],
  [14, 2],
  [16, 2],
  [18, 2.5],
  [20, 2.5],
  [22, 2.5],
  [24, 3],
]);

const STANDARD_RULES: Record<string, StandardRule> = {
  "ISO:4014": { form: "hex-head-bolt", headStyle: "external-hex", driveStyle: "external-hex", sourceUrl: "https://www.iso.org/standard/72579.html" },
  "ISO:4017": { form: "hex-head-screw", headStyle: "external-hex", driveStyle: "external-hex", sourceUrl: "https://www.iso.org/obp/ui#iso:std:iso:4017:ed-6:v1:en" },
  "ISO:4026": { form: "set-screw", headStyle: "headless", driveStyle: "hexagon-socket", pointStyle: "flat", sourceUrl: "https://www.iso.org/standard/88194.html" },
  "ISO:4027": { form: "set-screw", headStyle: "headless", driveStyle: "hexagon-socket", pointStyle: "truncated-cone", sourceUrl: "https://www.iso.org/standard/88195.html" },
  "ISO:4028": { form: "set-screw", headStyle: "headless", driveStyle: "hexagon-socket", pointStyle: "dog", sourceUrl: "https://www.iso.org/standard/88196.html" },
  "ISO:4029": { form: "set-screw", headStyle: "headless", driveStyle: "hexagon-socket", pointStyle: "cup", sourceUrl: "https://www.iso.org/standard/88197.html" },
  "ISO:4762": { form: "socket-head-cap-screw", headStyle: "socket-head-cap", driveStyle: "hexagon-socket", sourceUrl: "https://www.iso.org/standard/34460.html" },
  "DIN:912": { form: "socket-head-cap-screw", headStyle: "socket-head-cap", driveStyle: "hexagon-socket" },
  "ISO:7380-1": { form: "button-head-screw", headStyle: "button", driveStyle: "hexagon-socket", sourceUrl: "https://www.iso.org/standard/78699.html" },
  "ISO:7380-2": { form: "button-head-screw", headStyle: "button", driveStyle: "hexagon-socket", sourceUrl: "https://www.iso.org/standard/78700.html" },
  "ISO:7045": { form: "pan-head-screw", headStyle: "pan", driveStyle: "cross-recessed", sourceUrl: "https://www.iso.org/standard/57372.html" },
  "ISO:7046-1": { form: "countersunk-screw", headStyle: "countersunk", driveStyle: "cross-recessed", sourceUrl: "https://www.iso.org/standard/57373.html" },
  "ISO:10642": { form: "countersunk-screw", headStyle: "countersunk", driveStyle: "hexagon-socket", sourceUrl: "https://www.iso.org/standard/90795.html" },
  "ISO:14581": { form: "countersunk-screw", headStyle: "countersunk", driveStyle: "hexalobular-socket", sourceUrl: "https://www.iso.org/standard/78695.html" },
  "ISO:14583": { form: "pan-head-screw", headStyle: "pan", driveStyle: "hexalobular-socket", sourceUrl: "https://www.iso.org/standard/56457.html" },
};

export function resolveFastenerDesignation(rawInput: FastenerDesignationInput): FastenerDesignationResolution {
  const input = fastenerDesignationInputSchema.parse(rawInput);
  const original = input.designation;
  const normalizedText = original.replaceAll(",", ".").replace(/[×хХ]/gu, "x");
  const phraseJointIntent = inferJointIntent(normalizedText);
  const jointIntent = input.jointIntent === "unknown" ? phraseJointIntent : input.jointIntent;
  const jointIntentSource = input.jointIntent !== "unknown"
    ? "explicit" as const
    : phraseJointIntent !== "unknown"
      ? "designation-phrase" as const
      : "unresolved" as const;
  const phraseMountingIntent = inferMountingIntent(normalizedText);
  const mountingIntent = input.mountingIntent === "unknown" ? phraseMountingIntent : input.mountingIntent;
  const mountingIntentSource = input.mountingIntent !== "unknown"
    ? "explicit" as const
    : phraseMountingIntent !== "unknown"
      ? "designation-phrase" as const
      : "unresolved" as const;
  const quantity = parseQuantity(normalizedText);
  const printedPair = jointIntent === "printed-threaded-pair";
  const issues: FastenerDesignationResolution["issues"] = [];
  const questions: FastenerDesignationResolution["questions"] = [];
  const requiredInputs = new Set<string>();
  const sourceUrls = new Set<string>(printedPair ? [] : [ISO_261_URL, ISO_262_URL, COARSE_THREAD_DATA_URL]);
  const metric = /(?:^|[^A-Za-z0-9])M\s*(\d+(?:\.\d+)?)(?:\s*x\s*(\d+(?:\.\d+)?))?(?:\s*x\s*(\d+(?:\.\d+)?))?/iu.exec(normalizedText);
  if (!metric && !printedPair) {
    issues.push({ code: "UNSUPPORTED_THREAD_SYSTEM", message: "Only ISO metric M-thread designations are supported by this resolver." });
    return {
      status: "unsupported",
      original,
      form: inferNaturalForm(normalizedText),
      headStyle: inferNaturalHeadStyle(normalizedText),
      driveStyle: inferNaturalDriveStyle(normalizedText),
      thread: { system: "unknown" },
      jointIntent,
      analysisIntent: input.analysisIntent,
      interpretation: {
        ...(quantity === undefined ? {} : { quantity }),
        jointIntentSource,
        mountingIntent,
        mountingIntentSource,
        decisionMode: input.decisionMode,
      },
      workflow: { route: "unsupported-thread-system", compatibleTools: [], sequence: [] },
      requiredInputs: [],
      questions: [],
      questionPackages: [],
      issues,
      nextAction: { kind: "ask-user", instruction: "Provide a supported ISO metric fastener designation before selecting CAD geometry." },
      sourceUrls: [...sourceUrls],
      rules: ["Do not convert an unsupported thread system into a metric size."],
    };
  }

  const nominalDiameterMm = metric === null ? undefined : parseNumber(metric[1]!);
  const firstTrailing = metric?.[2] === undefined ? undefined : parseNumber(metric[2]);
  const secondTrailing = metric?.[3] === undefined ? undefined : parseNumber(metric[3]);
  const coarsePitch = nominalDiameterMm === undefined || printedPair ? undefined : COARSE_PITCH_MM.get(nominalDiameterMm);
  let pitchMm: number | undefined;
  let pitchSource: "explicit" | "catalog-coarse-default" | undefined;
  let lengthMm: number | undefined;
  let ambiguousTrailingValueMm: number | undefined;

  if (nominalDiameterMm === undefined) {
    issues.push({ code: "CUSTOM_THREAD_DIAMETER_REQUIRED", message: "The printed threaded pair needs an explicit nominal crest diameter." });
    questions.push({
      id: "printed-thread-diameter",
      question: "What nominal crest diameter and usable threaded length should the printed screw have?",
      reason: "The custom print profile cannot derive its envelope from an undimensioned request.",
      resolves: ["thread.nominalDiameterMm", "lengthMm"],
    });
  }
  if (secondTrailing !== undefined) {
    pitchMm = firstTrailing;
    pitchSource = "explicit";
    lengthMm = secondTrailing;
  } else if (firstTrailing !== undefined) {
    if (isAmbiguousSingleTrailing(nominalDiameterMm!, firstTrailing, coarsePitch)) {
      ambiguousTrailingValueMm = firstTrailing;
      issues.push({ code: "AMBIGUOUS_PITCH_OR_LENGTH", message: `The trailing value ${firstTrailing} mm could be a fine pitch or a very short fastener length.` });
      questions.push({
        id: "pitch-or-length",
        question: "Does the value after M describe thread pitch or fastener length?",
        reason: "A two-number metric designation is ambiguous for this value.",
        resolves: ["thread.pitchMm", "lengthMm"],
      });
    } else {
      lengthMm = firstTrailing;
      if (coarsePitch !== undefined) {
        pitchMm = coarsePitch;
        pitchSource = "catalog-coarse-default";
      }
    }
  } else if (coarsePitch !== undefined) {
    pitchMm = coarsePitch;
    pitchSource = "catalog-coarse-default";
  }
  if (pitchMm === undefined && ambiguousTrailingValueMm === undefined && !printedPair) {
    issues.push({ code: "PITCH_REQUIRED", message: "Thread pitch is not explicit and no coarse-pitch catalog entry is available for this diameter." });
    questions.push({ id: "thread-pitch", question: "What is the thread pitch?", reason: "The resolver cannot select a pitch for this diameter.", resolves: ["thread.pitchMm"] });
  }
  if (lengthMm === undefined && ambiguousTrailingValueMm === undefined) {
    issues.push({ code: "LENGTH_REQUIRED", message: "Fastener length is not present in the designation." });
    questions.push({ id: "fastener-length", question: "What is the nominal fastener length?", reason: "Length controls engagement and available stack thickness.", resolves: ["lengthMm"] });
  }

  const standard = parseStandard(normalizedText);
  const standardRule = standard ? STANDARD_RULES[`${standard.family}:${standard.number}`] : undefined;
  if (standard && standardRule) {
    if (standardRule.sourceUrl) {
      standard.sourceUrl = standardRule.sourceUrl;
      sourceUrls.add(standardRule.sourceUrl);
    }
  } else if (standard) {
    issues.push({ code: "STANDARD_NOT_CATALOGUED", message: `${standard.family} ${standard.number} was recognized but its head geometry is not in the bounded resolver catalog.` });
  }
  let form = standardRule?.form ?? inferNaturalForm(normalizedText);
  let headStyle = standardRule?.headStyle ?? inferNaturalHeadStyle(normalizedText);
  const driveStyle = standardRule?.driveStyle ?? inferNaturalDriveStyle(normalizedText);
  const pointStyle = standardRule?.pointStyle;
  if (headStyle !== "unknown" && form === "screw-unspecified") form = naturalFormForHead(headStyle);
  if (form === "stud") headStyle = "headless";
  if (form === "set-screw") {
    issues.push({
      code: "SET_SCREW_TENSION_LIMITATION",
      message: "The selected set-screw family is not intended to carry tensile load; resolve the actual load path before using it in a strength decision.",
    });
    requiredInputs.add("driverAccessEnvelopeMm");
    requiredInputs.add("matingContactSurfaceAndRetentionRequirement");
    questions.push({
      id: "set-screw-contact",
      question: "What surface does the set screw contact, what must it retain or adjust, and may its point mark or plastically indent that surface?",
      reason: "Flat, cone, dog, and cup points transfer load differently and can require a flat, recess, or locating hole in the mating part.",
      resolves: ["matingContactSurfaceAndRetentionRequirement", "pointStyleSuitability"],
    });
  }
  const propertyClass = parsePropertyClass(normalizedText);

  if (input.jointIntent !== "unknown" && phraseJointIntent !== "unknown" && input.jointIntent !== phraseJointIntent) {
    issues.push({ code: "JOINT_INTENT_CONFLICT", message: `The explicit joint intent ${input.jointIntent} conflicts with the designation phrase ${phraseJointIntent}.` });
    questions.push({
      id: "joint-intent-conflict",
      question: "Which receiving feature is actually used for this fastener?",
      reason: "The supplied joint intent conflicts with the natural-language attachment description.",
      resolves: ["jointIntent"],
    });
  }
  if (jointIntent === "unknown") {
    questions.push({
      id: "joint-target",
      question: "What receives the thread: a nut, a heat-set insert, tapped metal, printed plastic, a self-tapping pilot, or a fully printed mating nut?",
      reason: "The receiving feature determines the CAD recipe and required fit dimensions.",
      resolves: ["jointIntent"],
    });
  }
  if (headStyle === "unknown") {
    questions.push({
      id: "head-standard",
      question: "What head style or exact ISO/DIN/manufacturer part number is required?",
      reason: "M diameter and length do not define the head envelope or recess.",
      resolves: ["headStandard", "headStyle"],
    });
  }
  if (input.analysisIntent !== "geometry" && propertyClass === undefined && !printedPair) {
    questions.push({
      id: "property-class",
      question: "What property class or material/grade is the fastener?",
      reason: "Nominal M size does not define tensile or shear capacity.",
      resolves: ["propertyClass", "fastenerMaterial"],
    });
  }
  if (input.analysisIntent !== "geometry") {
    requiredInputs.add("worstCaseFastenerLoads");
    requiredInputs.add("joinedMaterialsAndProcess");
    requiredInputs.add("safetyFactorAndFailureConsequence");
    questions.push(
      {
        id: "strength-load-case",
        question: "What does this fastening hold, and what are the worst credible tension, shear, moment, impact, or repeated loads on it?",
        reason: "The fastener size and surrounding thickness cannot be checked before the load path is known.",
        resolves: ["worstCaseFastenerLoads", "loadPath"],
      },
      {
        id: "strength-material-process",
        question: "What are the joined materials, available thicknesses, and printer/material/profile/orientation for every printed member?",
        reason: "Plate, boss, insert, and thread capacity depend on the actual material and manufacturing direction.",
        resolves: ["joinedMaterialsAndProcess", "availableMaterialDepthMm"],
      },
      {
        id: "strength-acceptance",
        question: "What happens if the joint slips or fails, and what safety factor or acceptance basis should apply?",
        reason: "Failure consequence determines the required margin and whether the bounded screening methods are sufficient.",
        resolves: ["safetyFactorAndFailureConsequence"],
      },
    );
  }
  if (jointIntent !== "unknown" && mountingIntent === "unknown") {
    questions.push({
      id: "mounting-purpose",
      question: "Is this joint fixed, adjustable, or intended to pivot?",
      reason: "The functional motion selects a round hole, a slot, or a pivot clearance and bearing check.",
      resolves: ["mountingIntent"],
    });
  }

  const workflow = buildWorkflow(jointIntent, headStyle, mountingIntent, requiredInputs, quantity);
  addUnique(workflow.compatibleTools, "plasticity_check_fastener_group_layout");
  if (input.analysisIntent !== "geometry") {
    addUnique(workflow.compatibleTools, "plasticity_calculate_fastener_member_strength");
    addUnique(workflow.compatibleTools, "plasticity_distribute_fastener_group_load");
    addUnique(workflow.compatibleTools, "plasticity_inspect_fastener_group");
    addUnique(workflow.compatibleTools, "plasticity_verify_fastener_group_load");
    requiredInputs.add(printedPair ? "printedFastenerAllowableLoads" : "fastenerGradeAllowables");
    requiredInputs.add("effectiveTensileAndShearAreasMm2");
    if (form !== "set-screw" && ["through-bolt-with-nut", "machine-screw-into-heat-set-insert", "machine-screw-into-tapped-metal", "printed-threaded-pair"].includes(jointIntent)) {
      addUnique(workflow.compatibleTools, "plasticity_calculate_threaded_receiver_strength");
      requiredInputs.add("threadedReceiverAllowableLoads");
      requiredInputs.add("completeThreadEngagement");
      workflow.sequence.push("Check internal-thread stripping, external-thread stripping, and fastener tension with plasticity_calculate_threaded_receiver_strength using configuration-matched allowable loads; never infer capacity from the M designation alone.");
    }
  }
  addWorkflowQuestions(jointIntent, headStyle, mountingIntent, questions);
  const questionPackages = buildQuestionPackages(questions);

  const descriptorComplete = nominalDiameterMm !== undefined
    && ambiguousTrailingValueMm === undefined
    && pitchMm !== undefined
    && lengthMm !== undefined
    && headStyle !== "unknown"
    && jointIntent !== "unknown"
    && !issues.some((issue) => issue.code === "JOINT_INTENT_CONFLICT")
    && (input.analysisIntent === "geometry" || printedPair || propertyClass !== undefined);
  const normalizedDesignation = nominalDiameterMm === undefined
    ? undefined
    : printedPair
      ? `custom-rounded Ø${formatNumber(nominalDiameterMm)}${pitchMm === undefined ? "" : `×P${formatNumber(pitchMm)}`}${lengthMm === undefined ? "" : `×L${formatNumber(lengthMm)}`}`
      : pitchMm === undefined
        ? `M${formatNumber(nominalDiameterMm)}${lengthMm === undefined ? "" : `×${formatNumber(lengthMm)}`}`
        : `M${formatNumber(nominalDiameterMm)}×${formatNumber(pitchMm)}${lengthMm === undefined ? "" : `×${formatNumber(lengthMm)}`}`;
  return {
    status: descriptorComplete ? "resolved" : "needs-input",
    original,
    ...(normalizedDesignation === undefined ? {} : { normalizedDesignation }),
    form,
    headStyle,
    driveStyle,
    ...(pointStyle === undefined ? {} : { pointStyle }),
    thread: {
      system: printedPair ? "custom-rounded-print" : "ISO-metric",
      ...(nominalDiameterMm === undefined ? {} : { nominalDiameterMm }),
      ...(pitchMm === undefined ? {} : { pitchMm }),
      ...(pitchSource === undefined ? {} : { pitchSource }),
    },
    ...(lengthMm === undefined ? {} : { lengthMm }),
    ...(ambiguousTrailingValueMm === undefined ? {} : { ambiguousTrailingValueMm }),
    ...(standard === undefined ? {} : { standard }),
    ...(propertyClass === undefined ? {} : { propertyClass }),
    jointIntent,
    analysisIntent: input.analysisIntent,
    interpretation: {
      ...(quantity === undefined ? {} : { quantity }),
      jointIntentSource,
      mountingIntent,
      mountingIntentSource,
      decisionMode: input.decisionMode,
    },
    workflow,
    requiredInputs: [...requiredInputs],
    questions,
    questionPackages,
    ...(questionPackages[0] === undefined ? {} : { nextQuestionPackage: questionPackages[0] }),
    issues,
    nextAction: selectNextAction(input.decisionMode, questions, requiredInputs),
    sourceUrls: [...sourceUrls],
    rules: [
      "Nominal thread diameter is not a clearance-hole, pilot-hole, insert-pocket, head-recess, or nut-envelope dimension.",
      "Do not create or modify CAD until the joint intent and every manufacturing-critical diameter/depth are explicit.",
      "Prefer the exact manufacturer part record; otherwise use a current applicable standard and record its edition/source.",
      "Interpret nominal fastener length using the selected product standard; head style can change whether length is measured under the head or overall.",
      "Apply fit, printer/material/profile compensation, and strength evidence separately from nominal thread parsing.",
      "For strength or combined analysis, resolve the strength-basis question package before selecting final CAD thicknesses or fastening geometry.",
      ...(printedPair ? ["The rounded-print profile is a custom matched pair, not ISO metric hardware; an M-like crest diameter does not establish commercial compatibility.", "One interference-free indexed pose does not prove full helical travel or printed fit; qualify profile clearance with the selected printer, material, profile, orientation, and a calibration specimen."] : []),
      ...(form === "set-screw" ? ["The selected ISO set-screw family is not intended for tensile load; do not treat its thread designation or point style as tensile-capacity evidence."] : []),
    ],
  };
}

function buildQuestionPackages(questions: FastenerDesignationResolution["questions"]): FastenerQuestionPackage[] {
  const packageDefinitions: Array<{
    id: FastenerQuestionPackage["id"];
    phase: FastenerQuestionPackage["phase"];
    instruction: string;
    includes(questionId: string): boolean;
  }> = [
    {
      id: "strength-basis",
      phase: "strength",
      instruction: "Ask this compact functional package first. Do not select final thickness, fastener capacity, or fastening geometry until it is resolved.",
      includes: (id) => id.startsWith("strength-"),
    },
    {
      id: "joint-definition",
      phase: "joint",
      instruction: "Resolve how the parts are joined and whether relative motion is required.",
      includes: (id) => id === "joint-target" || id === "joint-intent-conflict" || id === "mounting-purpose" || id === "adjustment-travel" || id === "set-screw-contact",
    },
    {
      id: "hardware-selection",
      phase: "hardware",
      instruction: "Resolve the exact standard or product and only the hardware properties not available from a qualified source.",
      includes: (id) => ["pitch-or-length", "thread-pitch", "fastener-length", "head-standard", "property-class", "insert-part", "plastic-thread-system"].includes(id),
    },
    {
      id: "feature-geometry",
      phase: "geometry",
      instruction: "Resolve the remaining qualified feature dimensions, then call the dedicated native recipe and verify exact B-Rep geometry.",
      includes: () => true,
    },
  ];
  const remaining = [...questions];
  const packages: FastenerQuestionPackage[] = [];
  for (const definition of packageDefinitions) {
    const selected = remaining.filter((question) => definition.includes(question.id));
    if (selected.length === 0) continue;
    packages.push({ id: definition.id, phase: definition.phase, instruction: definition.instruction, questions: selected });
    const selectedIds = new Set(selected.map((question) => question.id));
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (selectedIds.has(remaining[index]!.id)) remaining.splice(index, 1);
    }
  }
  return packages;
}

function buildWorkflow(jointIntent: JointIntent, headStyle: HeadStyle, mountingIntent: MountingIntent, required: Set<string>, quantity: number | undefined): FastenerDesignationResolution["workflow"] {
  const compatibleTools: string[] = [];
  const sequence: string[] = [];
  if (headStyle !== "headless") required.add("headAndDriverEnvelopeMm");
  if (jointIntent !== "unknown") compatibleTools.push("plasticity_measure_fastener_grip_stack");
  if (jointIntent === "printed-threaded-pair") {
    compatibleTools.push(
      "plasticity_check_fastener_stack",
      "plasticity_match_printed_thread_qualification",
      "plasticity_list_printed_thread_qualifications",
      "plasticity_record_printed_thread_qualification",
      "plasticity_create_printed_hex_pair",
      "plasticity_create_printed_thread_calibration_set",
      "plasticity_create_printed_external_thread",
      "plasticity_cut_printed_internal_thread",
      "plasticity_create_printed_hex_screw",
      "plasticity_create_printed_hex_nut",
      "plasticity_validate_bodies",
      "plasticity_check_interference",
    );
    sequence.push(
      "Resolve loads and failure consequence before selecting the printed screw diameter, engagement, nut wall, or head envelope.",
      "Choose one explicit custom rounded-print pitch, depth, handedness, and normal profile clearance for both mating parts; do not substitute the ISO coarse pitch from an M-like diameter.",
      "Create a complete hex screw-and-nut pair with plasticity_create_printed_hex_pair, or use the separate low-level tools when only one side is needed; validate both exact native Solids and check an explicitly aligned assembly pose for volumetric interference.",
      "Match the exact printer, material, slicer profile, nozzle, layer height, orientation, rounded thread definition, and engagement with plasticity_match_printed_thread_qualification. If no physical qualification matches, create a clearance ladder with plasticity_create_printed_thread_calibration_set, physically test full travel, and record the selected result with plasticity_record_printed_thread_qualification.",
    );
    required.add("printedThreadPitchMm");
    required.add("printedThreadDepthMm");
    required.add("profileClearanceMm");
    required.add("printerMaterialProfileOrientation");
    required.add("threadEngagementMm");
    required.add("screwHeadDimensionsMm");
    required.add("nutAcrossFlatsThicknessAndMinimumWallMm");
    return { route: "printed-threaded-pair", compatibleTools, sequence };
  }
  if (jointIntent === "through-bolt-with-nut") {
    compatibleTools.push("plasticity_check_fastener_stack", "plasticity_create_through_hole", "plasticity_create_cylinder", "plasticity_boolean");
    if (quantity !== undefined && quantity > 1 && mountingIntent !== "adjustable") {
      compatibleTools.push("plasticity_create_hex_nut_pocket_pattern");
    } else {
      compatibleTools.push("plasticity_create_hex_nut_pocket");
    }
    sequence.push("Measure modeled clamped layers with plasticity_measure_fastener_grip_stack, add every explicit unmodeled washer or layer, resolve nut thickness and required protrusion, then call plasticity_check_fastener_stack before creating dependent geometry.");
    if (mountingIntent === "adjustable") {
      if (quantity !== undefined && quantity > 1) {
        compatibleTools.push("plasticity_create_slotted_hole_pattern");
        required.add("holeEntryCentersMm");
        sequence.push(`Resolve common adjustment travel and direction, then create all ${quantity} exact slots in one plasticity_create_slotted_hole_pattern call at explicit centers.`);
      } else {
        compatibleTools.push("plasticity_create_slotted_hole");
        sequence.push("Resolve adjustment travel and direction, then create an exact slot with an explicit finished width.");
      }
      required.add("slotOverallLengthMm");
      required.add("slotDirection");
    } else {
      if (quantity !== undefined && quantity > 1) {
        compatibleTools.unshift("plasticity_create_through_hole_pattern");
        required.add("holeEntryCentersMm");
        sequence.push(`Call plasticity_create_through_hole_pattern once for all ${quantity} explicit entry centers, using the selected finished clearance diameter and actual material depth.`);
      } else {
        sequence.push("Call plasticity_create_through_hole with the selected finished clearance diameter and actual material depth.");
      }
    }
    sequence.push(quantity !== undefined && quantity > 1 && mountingIntent !== "adjustable"
      ? `If the nuts must be trapped or recessed, resolve their common across-flats envelope and call plasticity_create_hex_nut_pocket_pattern once for all ${quantity} explicit centers.`
      : "If the nut must be trapped or recessed, resolve its across-flats envelope and cut an oriented hex pocket.", "Verify exact hole diameter and access envelopes from native B-Rep.");
    required.add("clearanceHoleDiameterMm");
    required.add("throughDepthMm");
    required.add("nutAndWasherEnvelopeMm");
    if (headStyle === "socket-head-cap" || headStyle === "button" || headStyle === "pan") {
      if (quantity !== undefined && quantity > 1 && mountingIntent !== "adjustable") {
        compatibleTools.push("plasticity_create_counterbore_pattern");
        sequence.push(`Call plasticity_create_counterbore_pattern once for all ${quantity} explicit centers when every head recess uses the same qualified dimensions.`);
      } else {
        compatibleTools.push("plasticity_create_counterbore");
      }
      required.add("headRecessDiameterMm");
      required.add("headRecessDepthMm");
    } else if (headStyle === "countersunk") {
      if (quantity !== undefined && quantity > 1 && mountingIntent !== "adjustable") {
        compatibleTools.push("plasticity_create_countersink_pattern");
        sequence.push(`Call plasticity_create_countersink_pattern once for all ${quantity} explicit centers when every countersink uses the same qualified dimensions.`);
      } else {
        compatibleTools.push("plasticity_create_countersink");
      }
      required.add("countersinkMajorDiameterMm");
      required.add("countersinkIncludedAngleDeg");
    }
    return { route: "through-fastener", compatibleTools, sequence };
  }
  if (jointIntent === "machine-screw-into-heat-set-insert") {
    compatibleTools.push("plasticity_check_fastener_stack", "plasticity_calculate_heat_set_insert_retention", "plasticity_create_cylinder", "plasticity_boolean");
    compatibleTools.push("plasticity_create_split_screw_insert_joint");
    if (quantity !== undefined && quantity > 1 && mountingIntent !== "adjustable") {
      compatibleTools.push("plasticity_create_heat_set_insert_pocket_pattern", "plasticity_create_through_hole_pattern");
      required.add("holeEntryCentersMm");
    } else {
      compatibleTools.push("plasticity_create_heat_set_insert_pocket", "plasticity_create_through_hole");
    }
    sequence.push("Resolve the exact insert part, manufacturer pocket dimensions, and installation/process qualification.", "Check the resolved screw length against the complete grip stack and the insert's explicit minimum and maximum usable engagement.");
    sequence.push("When the two split Solid halves and paired coaxial stations are available, prefer plasticity_create_split_screw_insert_joint to make all clearance holes and insert pockets together; its insert geometry is explicit and never derived from the M designation.");
    sequence.push(quantity !== undefined && quantity > 1 && mountingIntent !== "adjustable"
      ? `Create all ${quantity} equal insert pockets with plasticity_create_heat_set_insert_pocket_pattern and the mating clearance holes with plasticity_create_through_hole_pattern at explicit centers.`
      : "Create the insert pocket from catalog/process dimensions and create the mating clearance hole.");
    sequence.push("Check insert retention and fastener member capacity separately.");
    required.add("insertPartNumber");
    required.add("insertPocketDimensionsMm");
    required.add("matingClearanceHoleDiameterMm");
    required.add("threadEngagementMm");
    required.add("minimumAndMaximumInsertEngagementMm");
    return { route: "heat-set-insert", compatibleTools, sequence };
  }
  if (jointIntent === "machine-screw-into-tapped-metal") {
    compatibleTools.push("plasticity_check_fastener_stack", "plasticity_create_through_hole", "plasticity_calculate_fastener_member_strength");
    if (quantity !== undefined && quantity > 1 && mountingIntent !== "adjustable") {
      compatibleTools.push("plasticity_create_blind_hole_pattern");
      required.add("holeEntryCentersMm");
    } else {
      compatibleTools.push("plasticity_create_blind_hole");
    }
    sequence.push("Confirm tapped-hole class, engagement, thread representation, and whether the hole is blind or through.", "Check nominal screw length against the complete grip stack, engagement, and blind-hole tip clearance.");
    sequence.push(quantity !== undefined && quantity > 1 && mountingIntent !== "adjustable"
      ? `Create all ${quantity} equal blind tap-drill or modeled minor-diameter holes in one plasticity_create_blind_hole_pattern call using explicit entry centers.`
      : "Create only the explicitly specified tap-drill or modeled minor-diameter geometry with the matching dedicated hole recipe.");
    sequence.push("Check internal and external thread stripping plus fastener tension with plasticity_calculate_threaded_receiver_strength after qualified allowable loads are available.");
    required.add("tapDrillOrModeledThreadDimensionsMm");
    required.add("threadEngagementMm");
    required.add("holeTermination");
    return { route: "tapped-metal", compatibleTools, sequence };
  }
  if (jointIntent === "machine-screw-into-printed-plastic") {
    compatibleTools.push("plasticity_check_fastener_stack");
    if (quantity !== undefined && quantity > 1 && mountingIntent !== "adjustable") {
      compatibleTools.push("plasticity_create_screw_boss_pattern", "plasticity_create_blind_hole_pattern");
      required.add("bossBaseCentersMm");
    } else {
      compatibleTools.push("plasticity_create_screw_boss", "plasticity_create_blind_hole");
    }
    sequence.push("Choose modeled thread, thread-forming screw, self-tapping screw, or insert explicitly.", "Check nominal screw length against the complete grip stack and qualified engagement envelope.");
    sequence.push(quantity !== undefined && quantity > 1 && mountingIntent !== "adjustable"
      ? `Create all ${quantity} equal bosses and pilots in one plasticity_create_screw_boss_pattern call at explicit base centers; use plasticity_create_blind_hole_pattern only when the bosses already exist.`
      : "Use qualified pilot and boss dimensions for the chosen material/profile.");
    sequence.push("Verify the resulting native geometry.");
    required.add("plasticThreadStrategy");
    required.add("qualifiedPilotAndBossDimensionsMm");
    return { route: "printed-plastic-thread", compatibleTools, sequence };
  }
  if (jointIntent === "self-tapping-into-plastic") {
    compatibleTools.push("plasticity_check_fastener_stack");
    if (quantity !== undefined && quantity > 1 && mountingIntent !== "adjustable") {
      compatibleTools.push("plasticity_create_screw_boss_pattern", "plasticity_create_blind_hole_pattern");
      required.add("bossBaseCentersMm");
    } else {
      compatibleTools.push("plasticity_create_screw_boss", "plasticity_create_blind_hole");
    }
    sequence.push("Resolve the exact self-tapping screw family and manufacturer pilot guidance.", "Check nominal screw length against the complete grip stack and qualified engagement envelope.");
    sequence.push(quantity !== undefined && quantity > 1 && mountingIntent !== "adjustable"
      ? `Create all ${quantity} equal bosses and qualified pilots in one plasticity_create_screw_boss_pattern call at explicit base centers; use plasticity_create_blind_hole_pattern only when the bosses already exist.`
      : "Create the qualified pilot and boss.");
    sequence.push("Keep pull-out, splitting, creep, and repeated assembly outside a geometric pass.");
    required.add("manufacturerPartNumber");
    required.add("qualifiedPilotAndBossDimensionsMm");
    return { route: "self-tapping-plastic", compatibleTools, sequence };
  }
  return { route: "joint-intent-required", compatibleTools, sequence: ["Resolve what receives the thread before selecting a CAD operation."] };
}

function addWorkflowQuestions(jointIntent: JointIntent, headStyle: HeadStyle, mountingIntent: MountingIntent, questions: FastenerDesignationResolution["questions"]): void {
  if (jointIntent === "printed-threaded-pair") {
    questions.push({
      id: "printed-thread-profile",
      question: "Which printer, material, slicing profile, print orientation, pitch, thread depth, and tested normal profile clearance should define the matched printed pair?",
      reason: "Printable engagement and clearance depend on the complete process; an M-like crest diameter does not define this custom rounded profile.",
      resolves: ["printerMaterialProfileOrientation", "printedThreadPitchMm", "printedThreadDepthMm", "profileClearanceMm"],
    });
  }
  if (jointIntent === "through-bolt-with-nut") {
    questions.push({ id: "clearance-fit", question: "What clearance fit and manufacturing process should define the through-hole?", reason: "Nominal thread diameter is not the finished clearance-hole diameter.", resolves: ["clearanceHoleDiameterMm"] });
    questions.push({ id: "head-recess", question: "Must the head be flush or recessed, and is washer/nut access required?", reason: "Head and tool access change the surrounding geometry.", resolves: ["headRecess", "nutAndWasherEnvelopeMm"] });
  }
  if (mountingIntent === "adjustable") {
    questions.push({ id: "adjustment-travel", question: "How much adjustment travel is required, and in which direction?", reason: "Slot length and orientation must follow the required motion and preserve edge distance and bearing area.", resolves: ["slotOverallLengthMm", "slotDirection"] });
  }
  if (jointIntent === "machine-screw-into-heat-set-insert") {
    questions.push({ id: "insert-part", question: "What exact heat-set insert part number and installation process will be used?", reason: "Thread size alone does not define insert body or pocket dimensions.", resolves: ["insertPartNumber", "insertPocketDimensionsMm"] });
  }
  if (jointIntent === "machine-screw-into-printed-plastic" || jointIntent === "self-tapping-into-plastic") {
    questions.push({ id: "plastic-thread-system", question: "What exact screw/thread strategy and qualified pilot/boss dimensions will be used?", reason: "Printed plastic pilot size depends on screw family, material, profile, orientation, and reuse requirements.", resolves: ["plasticThreadStrategy", "qualifiedPilotAndBossDimensionsMm"] });
  }
  if (jointIntent === "machine-screw-into-tapped-metal") {
    questions.push({ id: "tapped-hole-termination", question: "Is the tapped hole blind or through, and what material depth is available?", reason: "Termination selects the exact hole recipe and prevents an intended blind pilot from breaking through.", resolves: ["holeTermination", "materialDepthMm"] });
  }
  if (headStyle === "countersunk") {
    questions.push({ id: "countersink-geometry", question: "What exact countersink major diameter and included angle does the selected standard or part require?", reason: "A countersunk head cannot be represented by nominal thread diameter.", resolves: ["countersinkMajorDiameterMm", "countersinkIncludedAngleDeg"] });
  }
}

function inferJointIntent(text: string): JointIntent {
  if (/(?:напечат|печат(?:ь|ать|н)|printed)/iu.test(text)
      && /винт|болт|screw|bolt/iu.test(text)
      && /гайк|ответн\S*\s+(?:част|детал)|mating\s+(?:nut|part)|printed\s+nut/iu.test(text)) return "printed-threaded-pair";
  if (/термовстав|термозаклад|heat[- ]?set\s+insert/iu.test(text)) return "machine-screw-into-heat-set-insert";
  if (/саморез|self[- ]?tapping/iu.test(text)) return "self-tapping-into-plastic";
  if (/(?:резьб\S*|нарезан\S*)\s+(?:отверст\S*\s+)?(?:в\s+)?металл|tapped\s+metal/iu.test(text)) return "machine-screw-into-tapped-metal";
  if (/(?:печатн\S*|напечатан\S*)\s+пластик|printed\s+plastic/iu.test(text)) return "machine-screw-into-printed-plastic";
  if (/(?:^|\s)(?:с|под)\s+гайк\S*|with\s+(?:a\s+)?nut|through[- ]?bolt/iu.test(text)) return "through-bolt-with-nut";
  return "unknown";
}

function inferMountingIntent(text: string): MountingIntent {
  if (/регулир|настроечн|продолговат|овальн\S*\s+отверст|\bslot(?:ted)?\b/iu.test(text)) return "adjustable";
  if (/шарнир|поворотн|враща|\bpivot\b|\bhinge\b/iu.test(text)) return "pivot";
  if (/крепит|креплен|крепёж|закреп|фиксир|attach|mount|fasten/iu.test(text)) return "fixed";
  return "unknown";
}

function parseQuantity(text: string): number | undefined {
  const descriptors = "(?:(?:[\\p{L}-]+)\\s+){0,3}";
  const numeric = new RegExp(`(?:^|\\s)(\\d{1,3})\\s*(?:шт\\.?\\s*)?${descriptors}(?=болт|винт|саморез|screw|bolt)`, "iu").exec(text);
  if (numeric) return Number(numeric[1]);
  const words: Array<[RegExp, number]> = [
    [new RegExp(`(?:^|\\s)(?:два|две|two)\\s+${descriptors}(?=болт|винт|саморез|screw|bolt)`, "iu"), 2],
    [new RegExp(`(?:^|\\s)(?:три|three)\\s+${descriptors}(?=болт|винт|саморез|screw|bolt)`, "iu"), 3],
    [new RegExp(`(?:^|\\s)(?:четыре|four)\\s+${descriptors}(?=болт|винт|саморез|screw|bolt)`, "iu"), 4],
  ];
  return words.find(([pattern]) => pattern.test(text))?.[1];
}

function selectNextAction(decisionMode: DecisionMode, questions: FastenerDesignationResolution["questions"], requiredInputs: Set<string>): FastenerDesignationResolution["nextAction"] {
  if (requiredInputs.size === 0 && questions.length === 0) {
    return { kind: "modify-cad", instruction: "Create the resolved feature, then verify its exact native B-Rep dimensions." };
  }
  const functionalQuestionRemains = questions.some((question) =>
    question.id.startsWith("strength-")
    || ["joint-target", "joint-intent-conflict", "mounting-purpose", "adjustment-travel"].includes(question.id));
  if (functionalQuestionRemains) {
    return { kind: "ask-user", instruction: "Ask only the first unresolved functional question package before researching hardware details or modifying CAD." };
  }
  if (decisionMode === "agent-may-select-qualified") {
    return { kind: "resolve-qualified-data", instruction: "Resolve ordinary missing dimensions from the exact manufacturer catalog or applicable standard, record sources and assumptions, then ask only about choices that affect function or strength." };
  }
  return { kind: "ask-user", instruction: "Ask the smallest logical package of unresolved functional questions before modifying CAD." };
}

function parseStandard(text: string): StandardDescriptor | undefined {
  const match = /(?:^|\s)(ISO|DIN|GOST|ГОСТ)\s*-?\s*(\d+(?:-\d+)?)(?=\s|$)/iu.exec(text);
  if (!match) return undefined;
  const family = match[1]!.toUpperCase() === "ГОСТ" ? "GOST" : match[1]!.toUpperCase() as StandardDescriptor["family"];
  return { family, number: match[2]! };
}

function parsePropertyClass(text: string): string | undefined {
  const match = /(?:^|\s)(?:класс(?:а)?(?:\s+прочности)?|property\s+class|class)?\s*(4\.6|4\.8|5\.6|5\.8|6\.8|8\.8|9\.8|10\.9|12\.9)(?=\s|$)/iu.exec(text);
  return match?.[1];
}

function inferNaturalForm(text: string): FastenerForm {
  if (/саморез|self[- ]?tapping/iu.test(text)) return "self-tapping-screw";
  if (/шпильк|\bstud\b/iu.test(text)) return "stud";
  const head = inferNaturalHeadStyle(text);
  if (head !== "unknown") return naturalFormForHead(head);
  if (/\bbolt\b|болт/iu.test(text)) return "bolt-unspecified";
  if (/\bscrew\b|винт/iu.test(text)) return "screw-unspecified";
  return "unknown";
}

function inferNaturalHeadStyle(text: string): HeadStyle {
  if (/потайн|countersunk/iu.test(text)) return "countersunk";
  if (/socket[- ]?head|цилиндр\S*\s+голов\S*.*(?:шестигран|hex)|(?:шестигран|hex).*цилиндр\S*\s+голов/iu.test(text)) return "socket-head-cap";
  if (/button[- ]?head|полукругл\S*\s+голов/iu.test(text)) return "button";
  if (/pan[- ]?head/iu.test(text)) return "pan";
  if (/hex[- ]?head|шестигранн\S*\s+голов/iu.test(text)) return "external-hex";
  if (/set[- ]?screw|установочн\S*\s+винт|без\s+голов/iu.test(text)) return "headless";
  return "unknown";
}

function inferNaturalDriveStyle(text: string): DriveStyle {
  if (/hexalobular|torx|торкс/iu.test(text)) return "hexalobular-socket";
  if (/cross[- ]?recess|phillips|pozidriv|крестов/iu.test(text)) return "cross-recessed";
  if (/socket[- ]?head|hexagon[- ]?socket|internal[- ]?hex|внутренн\S*\s+шестигран|под\s+шестигран/iu.test(text)) return "hexagon-socket";
  if (/hex[- ]?head|шестигранн\S*\s+голов/iu.test(text)) return "external-hex";
  return "unknown";
}

function naturalFormForHead(head: HeadStyle): FastenerForm {
  if (head === "external-hex") return "hex-head-screw";
  if (head === "socket-head-cap") return "socket-head-cap-screw";
  if (head === "button") return "button-head-screw";
  if (head === "pan") return "pan-head-screw";
  if (head === "countersunk") return "countersunk-screw";
  if (head === "headless") return "set-screw";
  return "screw-unspecified";
}

function isAmbiguousSingleTrailing(nominalDiameterMm: number, value: number, coarsePitchMm: number | undefined): boolean {
  return value <= (coarsePitchMm ?? nominalDiameterMm / 4);
}

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid fastener designation number: ${value}`);
  return parsed;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(/0+$/u, "").replace(/\.$/u, "");
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}
