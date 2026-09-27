import { z } from "zod";

import { exactMaterialCouponProcessSchema } from "./material-qualification.ts";

const direction = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).refine((value) => {
  const length = Math.hypot(...value);
  return Math.abs(length - 1) <= 1e-6;
}, "Direction must be a unit vector in the Plasticity global frame");

const scopes = [
  "layerwise-elastic-response",
  "directional-strength-screen",
  "layer-interface-normal-tension",
  "layer-interface-mode-i",
  "layer-interface-mode-ii",
  "layer-interface-mixed-mode",
] as const;

export const materialTestPlanInputSchema = z.object({
  process: exactMaterialCouponProcessSchema,
  scopes: z.array(z.enum(scopes)).min(1).max(scopes.length)
    .refine((values) => new Set(values).size === values.length, "Test-plan scopes must be unique"),
  interfaceNormalGlobal: direction.optional(),
  interfaceShearDirectionGlobal: direction.optional(),
}).strict().superRefine((input, context) => {
  const needsInterface = input.scopes.some((scope) => scope.startsWith("layer-interface-"));
  const needsShearDirection = input.scopes.includes("layer-interface-mode-ii") || input.scopes.includes("layer-interface-mixed-mode");
  if (needsInterface && !input.interfaceNormalGlobal) {
    context.addIssue({ code: "custom", path: ["interfaceNormalGlobal"], message: "Layer-interface plans require the measured interface normal in the global CAD frame" });
  }
  if (needsShearDirection && !input.interfaceShearDirectionGlobal) {
    context.addIssue({ code: "custom", path: ["interfaceShearDirectionGlobal"], message: "Mode-II and mixed-mode plans require the one supported measured in-plane shear direction" });
  }
  if (input.interfaceNormalGlobal && input.interfaceShearDirectionGlobal) {
    const dot = input.interfaceNormalGlobal.reduce((sum, value, axis) => sum + value * input.interfaceShearDirectionGlobal![axis]!, 0);
    if (Math.abs(dot) > 1e-6) {
      context.addIssue({ code: "custom", path: ["interfaceShearDirectionGlobal"], message: "Measured shear direction must lie in the interface plane" });
    }
  }
  if (!needsInterface && input.interfaceNormalGlobal) {
    context.addIssue({ code: "custom", path: ["interfaceNormalGlobal"], message: "An interface normal is only valid for a layer-interface test scope" });
  }
  if (!needsShearDirection && input.interfaceShearDirectionGlobal) {
    context.addIssue({ code: "custom", path: ["interfaceShearDirectionGlobal"], message: "A shear direction is only valid for a Mode-II or mixed-mode layer-interface scope" });
  }
});

export type MaterialTestPlanInput = z.infer<typeof materialTestPlanInputSchema>;

export interface MaterialTestTask {
  id: string;
  kind: "coupon-property" | "biaxial-interaction" | "interface-strength" | "interface-fracture";
  quantity: string;
  materialAxis: string;
  globalDirection?: [number, number, number];
  recordWith?: "plasticity_record_material_coupon_data" | "plasticity_record_material_interface_test";
  provideTo?: "plasticity_analyze_cohesive_interface";
  measurement: string;
  conditions: string[];
}

export interface MaterialTestPlan {
  contractVersion: 1;
  process: MaterialTestPlanInput["process"];
  materialModel: "one-material-orthotropic-bulk-and-same-material-interfaces";
  axisConvention: {
    axis1: "dominant deposited-road direction";
    axis2: "in-build-plane transverse direction";
    axis3: "build direction and layer normal";
    confirmationRequired: true;
  };
  tasks: MaterialTestTask[];
  solverLimits: string[];
  limitations: string[];
}

export function planSingleMaterialStrengthTests(rawInput: MaterialTestPlanInput): MaterialTestPlan {
  const input = materialTestPlanInputSchema.parse(rawInput);
  const tasks: MaterialTestTask[] = [];
  const addCoupon = (id: string, quantity: string, materialAxis: string, measurement: string, conditions: string[] = []) => {
    tasks.push({
      id,
      kind: "coupon-property",
      quantity,
      materialAxis,
      recordWith: "plasticity_record_material_coupon_data",
      measurement,
      conditions: ["Use the exact printer/material/profile/orientation/infill-percentage-and-pattern/wall-loops/top-and-bottom-shell-layers/nozzle-temperature/measured-layer-height identity returned in process.", ...conditions],
    });
  };

  if (input.scopes.includes("layerwise-elastic-response")) {
    addCoupon("E1", "Young's modulus E1", "material axis 1", "Measure tensile stress and axial strain along the confirmed dominant deposited-road axis.");
    addCoupon("E2", "Young's modulus E2", "material axis 2", "Measure tensile stress and axial strain in the build plane, transverse to the deposited-road axis.");
    addCoupon("E3", "Young's modulus E3", "material axis 3", "Measure tensile stress and axial strain along the confirmed build direction, normal to layer interfaces.");
    tasks.push({
      id: "nu12",
      kind: "coupon-property",
      quantity: "Poisson ratio nu12",
      materialAxis: "material axes 1 and 2",
      recordWith: "plasticity_record_material_coupon_data",
      measurement: "Measure transverse strain during the axis-1 tensile test.",
      conditions: [
        "Use the exact printer/material/profile/orientation/infill-percentage-and-pattern/wall-loops/top-and-bottom-shell-layers/nozzle-temperature/measured-layer-height identity returned in process.",
        "Record the exact measured value and measured ratio evidence together as poissonRatio and poissonRatioEvidence; the FEM input must use the same value and evidence from this exact-process coupon record.",
      ],
    });
    addCoupon("nu13", "Poisson ratio nu13", "material axes 1 and 3", "Measure layer-normal transverse strain during the axis-1 tensile test.");
    addCoupon("nu23", "Poisson ratio nu23", "material axes 2 and 3", "Measure layer-normal transverse strain during the axis-2 tensile test.");
    addCoupon("G12", "Shear modulus G12", "material plane 1-2", "Measure shear stress and engineering shear strain in plane 1-2.");
    addCoupon("G13", "Shear modulus G13", "material plane 1-3", "Measure shear stress and engineering shear strain in plane 1-3.");
    addCoupon("G23", "Shear modulus G23", "material plane 2-3", "Measure shear stress and engineering shear strain in plane 2-3.");
  }

  if (input.scopes.includes("directional-strength-screen")) {
    for (const [id, quantity, axis, measurement] of [
      ["X_T", "X tension strength", "material axis 1", "Measure peak tensile stress along material axis 1."],
      ["X_C", "X compression strength", "material axis 1", "Measure peak compressive stress along material axis 1."],
      ["Y_T", "Y tension strength", "material axis 2", "Measure peak tensile stress along material axis 2."],
      ["Y_C", "Y compression strength", "material axis 2", "Measure peak compressive stress along material axis 2."],
      ["Z_T", "Z tension strength", "material axis 3", "Measure peak tensile stress normal to the printed layers."],
      ["Z_C", "Z compression strength", "material axis 3", "Measure peak compressive stress normal to the printed layers."],
      ["XY_S", "XY shear strength", "material plane 1-2", "Measure peak shear stress in plane 1-2."],
      ["XZ_S", "XZ shear strength", "material plane 1-3", "Measure peak shear stress in plane 1-3."],
      ["YZ_S", "YZ shear strength", "material plane 2-3", "Measure peak shear stress in plane 2-3."],
    ] as const) addCoupon(id, quantity, axis, measurement, ["Store the measured peak only; it is not a factored design allowable."]);
    for (const plane of ["12", "13", "23"] as const) {
      tasks.push({
        id: `biaxial-${plane}`,
        kind: "biaxial-interaction",
        quantity: `Tsai-Wu interaction coefficient for plane ${plane}`,
        materialAxis: `biaxial loading in material plane ${plane}`,
        recordWith: "plasticity_record_material_coupon_data",
        measurement: "Measure a biaxial strength test from which the normalized interaction coefficient is derived; preserve the derivation and source evidence.",
        conditions: ["A derived coefficient is accepted only with traceable measured biaxial evidence and dependsOn links."],
      });
    }
  }

  if (input.scopes.includes("layer-interface-normal-tension")) {
    tasks.push({
      id: "layer-normal-tension",
      kind: "interface-strength",
      quantity: "Nominal normal tensile strength across same-material printed layers",
      materialAxis: "confirmed layer-interface normal",
      globalDirection: input.interfaceNormalGlobal!,
      recordWith: "plasticity_record_material_interface_test",
      measurement: "Load a printed tensile specimen quasi-statically along the confirmed layer-interface normal. For each specimen, record peak force in N, measured net cross-section in mm², failure location, and traceable raw force/displacement evidence. Use plasticity_calculate_interface_specimen_strengths to calculate nominal peak stress as force/area (N/mm² = MPa); do not label it local interface traction.",
      conditions: [
        "Use the exact same printer/material/profile/orientation/infill-percentage-and-pattern/wall-loops/top-and-bottom-shell-layers/nozzle-temperature/measured-layer-height process on both sides of the tested interface.",
        "Confirm the specimen build direction and CAD/global mapping so its layer-interface normal matches the requested global direction.",
        "Record testMode=normal-tension and failureLocation=interface only when fracture is observed on the printed layer interface; otherwise record the actual failure location.",
        "Use a clearly named normal-tension coupon protocol; do not identify it as DCB unless the specimen and fixture follow a documented DCB method.",
        "Record one raw result for every specimen, exact specimen count, tested date, protocol hash and source hash/locator; select a representative specimen only when a single direct-strength value is required by the interface-test record.",
        "Report range, mean and sample standard deviation as descriptive specimen statistics only; they are not statistically qualified bounds or design allowables.",
        "This peak-strength test is not fracture energy or a complete traction-separation law and cannot alone calibrate cohesive FEA.",
      ],
    });
  }

  if (input.scopes.includes("layer-interface-mode-i")) {
    tasks.push(interfaceTask("DCB-mode-I", "Mode-I layer-interface fracture", input.interfaceNormalGlobal!, input.interfaceNormalGlobal!, "Record the full compliance-corrected normal traction-separation curve, measured peak and observed failure location; the measured failure must occur at the same-material layer interface."));
  }

  if (input.scopes.includes("layer-interface-mode-ii")) {
    tasks.push({
      id: "ENF-mode-II-energy",
      kind: "interface-fracture",
      quantity: "Exploratory Mode-II layer-interface initiation energy G_IIc",
      materialAxis: "confirmed in-plane shear direction at the layer interface",
      globalDirection: input.interfaceShearDirectionGlobal!,
      measurement: "Use an ENF fixture and record at least three crack-length compliance calibration runs plus one fracture run. Derive each compliance from the initial linear load-displacement slope; record corrected displacement provenance, initial crack length, peak force, specimen geometry and failure location. For raw CSV use plasticity_import_enf_mode_ii_energy_csv with manually selected linear-region records and initiation peak; use plasticity_calculate_enf_mode_ii_energy for already-reduced compliance values.",
      conditions: [
        "Use the same fixture, support span, load point, specimen width/thickness and machine-compliance correction for calibration and fracture runs.",
        "Confirm the shear direction is in the measured global layer-interface plane; use one exact same-material print process and interface normal.",
        "This exploratory Mode-II energy value does not conform to ASTM D7905 for printed PLA and is not a cohesive law or design allowable.",
        "A scalar G_IIc estimate is not a complete Mode-II traction-separation curve and does not satisfy the DCB/ENF/MMB cohesive calibration route.",
      ],
    });
  }

  if (input.scopes.includes("layer-interface-mixed-mode")) {
    tasks.push(interfaceTask("DCB-mode-I", "Mode-I layer-interface fracture", input.interfaceNormalGlobal!, input.interfaceNormalGlobal!, "Record the full compliance-corrected normal traction-separation curve, measured peak and observed failure location at the same-material layer interface."));
    tasks.push(interfaceTask("ENF-mode-II", "Mode-II layer-interface fracture", input.interfaceNormalGlobal!, input.interfaceShearDirectionGlobal!, "Record a full compliance-corrected pure-shear traction-separation curve with interface failure."));
    for (const index of [1, 2]) {
      tasks.push({
        id: `MMB-${index}`,
        kind: "interface-fracture",
        quantity: `Mixed-mode layer-interface fracture at distinct measured energy mix ${index}`,
        materialAxis: "one exact same-material print process on both sides of the interface",
        recordWith: "plasticity_record_material_interface_test",
        measurement: "Use a documented mixed-mode fixture to record the vector normal/tangential traction-separation curve and integrated energy fraction. Determine global load direction from the fixture; do not infer energy mix from a fixture angle. For a separate exploratory initiation-energy partition only, plasticity_calculate_mmb_mode_i_ii_energy requires measured critical force, specimen/lever geometry, same-process flexural and orthotropic moduli, and confirmed material-axis mapping. Raw-force CSV can be previewed with plasticity_import_mmb_mode_i_ii_energy_csv after manually selecting the observed initiation record. Neither path replaces this full curve.",
        conditions: [
          "Use the exact same process identity and interface normal as DCB and ENF.",
          "Keep the measured in-plane shear axis aligned with ENF and the other MMB specimen within one degree.",
          "The two MMB specimens must produce distinct measured tangential energy fractions.",
          "Record the fixture-derived global load direction and hash the test protocol and raw data.",
        ],
      });
    }
    tasks.push({
      id: "cohesive-K",
      kind: "interface-fracture",
      quantity: "initial cohesive stiffness K",
      materialAxis: "normal and measured in-plane shear components",
      provideTo: "plasticity_analyze_cohesive_interface",
      measurement: "Measure or source an explicitly applicable initial traction-separation stiffness with exact unit, value, SHA-256 and source locator.",
      conditions: ["Record K in MPa/mm as measured or sourced evidence on the cohesive-analysis request; K is not stored in the interface-test registry, which records MPa peak traction and separation curves.", "K is not inferred from DCB/ENF/MMB energy fitting."],
    });
  }

  const layerwise = input.scopes.includes("layerwise-elastic-response");
  const mixedMode = input.scopes.includes("layer-interface-mixed-mode");
  const modeII = input.scopes.includes("layer-interface-mode-ii");
  const includesInterface = input.scopes.some((scope) => scope.startsWith("layer-interface-"));
  const uniqueTasks = [...new Map(tasks.map((task) => [task.id, task])).values()];
  return {
    contractVersion: 1,
    process: structuredClone(input.process),
    materialModel: "one-material-orthotropic-bulk-and-same-material-interfaces",
    axisConvention: {
      axis1: "dominant deposited-road direction",
      axis2: "in-build-plane transverse direction",
      axis3: "build direction and layer normal",
      confirmationRequired: true,
    },
    tasks: uniqueTasks,
    solverLimits: [
      ...(layerwise ? ["Layerwise static analysis assigns the same measured orthotropic tensor to each G-code-mapped layer frame and assumes perfectly bonded interfaces; it does not predict delamination."] : []),
      ...(mixedMode ? ["The calibrated Turon law has one tangential response: all ENF/MMB records and the analyzed displacement shear axis must match within one degree; Mode-III or direction-dependent interface shear is unsupported."] : []),
      ...(modeII ? ["The exploratory ENF energy preview is an initiation-energy estimate only; it is not a Mode-II R-curve, traction-separation curve, or usable input to cohesive FEA."] : []),
      ...(input.scopes.includes("layer-interface-normal-tension") ? ["A normal-tension layer-interface coupon supplies a measured peak-strength screen only; it does not supply Mode-I fracture energy, DCB evidence, or a calibrated cohesive law."] : []),
      ...(includesInterface ? ["Cohesive solver output is a raw response and is not a part-strength verdict, design allowable, or print approval."] : []),
    ],
    limitations: [
      "This plan specifies measurements and evidence needed by the selected MCP route; it does not prescribe a specimen standard, fixture dimensions, sample count, or design allowable.",
      "One printer, one material, and one exact print-process profile are used throughout; no multi-material model is planned or calculated.",
      "Any print-axis mapping must be physically established or explicitly confirmed; it is never inferred from a photo or a CAD face.",
    ],
  };
}

function interfaceTask(
  id: string,
  quantity: string,
  interfaceNormalGlobal: [number, number, number],
  loadDirectionGlobal: [number, number, number] | undefined,
  measurement: string,
): MaterialTestTask {
  return {
    id,
    kind: "interface-fracture",
    quantity,
    materialAxis: "one exact same-material print process on both sides of the interface",
    ...(loadDirectionGlobal ? { globalDirection: loadDirectionGlobal } : {}),
    recordWith: "plasticity_record_material_interface_test",
    measurement,
    conditions: [
      "Use one exact material process on both sides, including measured slicer layer height.",
      `Record the interface normal [${interfaceNormalGlobal.join(", ")}] in the global CAD frame.`,
      ...(loadDirectionGlobal ? [`Record load direction [${loadDirectionGlobal.join(", ")}] in the global CAD frame.`] : []),
      "Hash the test protocol and raw data; record fixture, specimen count, tested date and observed failure location.",
      ...(id === "DCB-mode-I" ? [
        "Generic-PLA literature planning reference (not CR-PLA qualification): Lambiase et al. report a DCB specimen length L=125 mm, width=25 mm, initial crack length a=55 mm, and load-line-to-crack-tip distance=30 mm; specimen thickness varied from 4.5 to 7.5 mm depending on material/geometry calculations. Use this only as a starting geometry, then size/check the specimen for the exact process, fixture, and documented method before printing. The paper used five specimens per raster strategy as a study choice, not a standard-required sample count. It describes ASTM D5528-based design but cites D5568 in its conclusion; do not claim formal compliance from this reference. Track crack growth and inspect the fracture plane because printed cracks may migrate or pull out roads. Source: https://doi.org/10.1007/s00170-023-12223-1.",
      ] : []),
    ],
  };
}
