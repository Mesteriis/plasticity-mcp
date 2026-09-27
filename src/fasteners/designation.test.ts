import assert from "node:assert/strict";
import test from "node:test";

import { fastenerDesignationInputSchema, resolveFastenerDesignation } from "./designation.ts";

test("parses a natural-language M5x10 screw without inventing head or hole geometry", () => {
  const result = resolveFastenerDesignation({
    designation: "винт M5x10",
    jointIntent: "unknown",
    analysisIntent: "geometry",
  });
  assert.equal(result.status, "needs-input");
  assert.equal(result.thread.system, "ISO-metric");
  assert.equal(result.thread.nominalDiameterMm, 5);
  assert.equal(result.thread.pitchMm, 0.8);
  assert.equal(result.thread.pitchSource, "catalog-coarse-default");
  assert.equal(result.lengthMm, 10);
  assert.equal(result.form, "screw-unspecified");
  assert.equal(result.headStyle, "unknown");
  assert.equal(result.normalizedDesignation, "M5×0.8×10");
  assert.ok(result.questions.some((question) => question.resolves.includes("jointIntent")));
  assert.ok(result.questions.some((question) => question.resolves.includes("headStandard")));
  assert.equal("holeDiameterMm" in result, false);
});

test("defaults to a compact strength-first question package before joint geometry", () => {
  const result = resolveFastenerDesignation({ designation: "крепится на винт m5х10" });
  assert.equal(result.analysisIntent, "both");
  assert.equal(result.nextQuestionPackage?.id, "strength-basis");
  assert.deepEqual(result.nextQuestionPackage?.questions.map((question) => question.id), [
    "strength-load-case",
    "strength-material-process",
    "strength-acceptance",
  ]);
  assert.equal(result.nextAction.kind, "ask-user");
  assert.ok(result.requiredInputs.includes("worstCaseFastenerLoads"));
  assert.ok(result.questionPackages.some((questionPackage) => questionPackage.id === "joint-definition"));
  assert.ok(result.workflow.compatibleTools.includes("plasticity_check_fastener_group_layout"));
});

test("parses explicit comma-decimal pitch, length, standard and property class", () => {
  const result = resolveFastenerDesignation({
    designation: "болт ISO 4017 M5×0,8×10 класс 8.8",
    jointIntent: "through-bolt-with-nut",
    analysisIntent: "both",
  });
  assert.equal(result.thread.pitchMm, 0.8);
  assert.equal(result.thread.pitchSource, "explicit");
  assert.equal(result.lengthMm, 10);
  assert.deepEqual(result.standard, { family: "ISO", number: "4017", sourceUrl: "https://www.iso.org/obp/ui#iso:std:iso:4017:ed-6:v1:en" });
  assert.equal(result.form, "hex-head-screw");
  assert.equal(result.headStyle, "external-hex");
  assert.equal(result.propertyClass, "8.8");
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_cylinder"));
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_through_hole"));
  assert.ok(result.workflow.compatibleTools.includes("plasticity_check_fastener_stack"));
  assert.ok(result.workflow.compatibleTools.includes("plasticity_measure_fastener_grip_stack"));
  assert.ok(result.workflow.compatibleTools.includes("plasticity_inspect_fastener_group"));
  assert.ok(result.workflow.compatibleTools.includes("plasticity_verify_fastener_group_load"));
  assert.ok(result.requiredInputs.includes("clearanceHoleDiameterMm"));
  assert.ok(result.requiredInputs.includes("nutAndWasherEnvelopeMm"));
});

test("understands a Russian attachment phrase while leaving the unspecified bolt head unresolved", () => {
  const result = resolveFastenerDesignation({
    designation: "крепится на болт M5х10",
    jointIntent: "unknown",
    analysisIntent: "geometry",
  });
  assert.equal(result.form, "bolt-unspecified");
  assert.equal(result.normalizedDesignation, "M5×0.8×10");
  assert.ok(result.questions.some((question) => question.id === "joint-target"));
  assert.ok(result.questions.some((question) => question.id === "head-standard"));
});

test("infers a through joint and a fixed round-hole plan from an explicit nut phrase", () => {
  const result = resolveFastenerDesignation({
    designation: "кронштейн крепится на 4 болта M5x10 с гайками",
    jointIntent: "unknown",
    analysisIntent: "geometry",
  });
  assert.equal(result.jointIntent, "through-bolt-with-nut");
  assert.equal(result.interpretation.jointIntentSource, "designation-phrase");
  assert.equal(result.interpretation.quantity, 4);
  assert.equal(result.interpretation.mountingIntent, "fixed");
  assert.equal(result.interpretation.mountingIntentSource, "designation-phrase");
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_cylinder"));
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_through_hole"));
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_through_hole_pattern"));
  assert.ok(result.requiredInputs.includes("holeEntryCentersMm"));
  assert.equal(result.workflow.compatibleTools.includes("plasticity_create_slotted_hole"), false);
  assert.equal(result.questions.some((question) => question.id === "joint-target"), false);
  assert.equal(result.questionPackages.some((questionPackage) => questionPackage.id === "strength-basis"), false);
});

test("routes an explicitly adjustable multi-bolt joint to one slot pattern", () => {
  const result = resolveFastenerDesignation({
    designation: "регулируемое крепление на два болта M5x10 с гайками",
    jointIntent: "unknown",
    analysisIntent: "geometry",
  });
  assert.equal(result.interpretation.quantity, 2);
  assert.equal(result.interpretation.mountingIntent, "adjustable");
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_slotted_hole_pattern"));
  assert.equal(result.workflow.compatibleTools.includes("plasticity_create_slotted_hole"), false);
  assert.ok(result.requiredInputs.includes("holeEntryCentersMm"));
  assert.ok(result.requiredInputs.includes("slotOverallLengthMm"));
  assert.ok(result.requiredInputs.includes("slotDirection"));
  assert.ok(result.questions.some((question) => question.id === "adjustment-travel"));
});

test("keeps strength questions with the user before delegated heat-set catalog research", () => {
  const result = resolveFastenerDesignation({
    designation: "закрепить винтом M3x10 в латунную термовставку",
    jointIntent: "unknown",
    analysisIntent: "both",
    decisionMode: "agent-may-select-qualified",
  });
  assert.equal(result.jointIntent, "machine-screw-into-heat-set-insert");
  assert.equal(result.interpretation.jointIntentSource, "designation-phrase");
  assert.equal(result.interpretation.decisionMode, "agent-may-select-qualified");
  assert.equal(result.nextAction.kind, "ask-user");
  assert.equal(result.nextQuestionPackage?.id, "strength-basis");
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_heat_set_insert_pocket"));
  assert.ok(result.workflow.compatibleTools.includes("plasticity_check_fastener_stack"));
});

test("delegates ordinary catalog choices after functional intent is explicit for geometry-only work", () => {
  const result = resolveFastenerDesignation({
    designation: "закрепить винтом M3x10 в латунную термовставку",
    jointIntent: "unknown",
    mountingIntent: "fixed",
    analysisIntent: "geometry",
    decisionMode: "agent-may-select-qualified",
  });
  assert.equal(result.nextAction.kind, "resolve-qualified-data");
  assert.match(result.nextAction.instruction, /manufacturer|catalog|standard/i);
});

test("maps DIN 912 to a socket-head counterbore workflow", () => {
  const result = resolveFastenerDesignation({
    designation: "винт DIN 912 M4x20",
    jointIntent: "through-bolt-with-nut",
    analysisIntent: "geometry",
  });
  assert.equal(result.thread.pitchMm, 0.7);
  assert.equal(result.standard?.family, "DIN");
  assert.equal(result.headStyle, "socket-head-cap");
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_counterbore"));
  assert.ok(result.requiredInputs.includes("headRecessDiameterMm"));
  assert.ok(result.requiredInputs.includes("headRecessDepthMm"));
});

test("classifies current ISO screw standards without inventing product dimensions", () => {
  const cases = [
    { standard: "7045", form: "pan-head-screw", headStyle: "pan", driveStyle: "cross-recessed", sourceUrl: "https://www.iso.org/standard/57372.html", tool: "plasticity_create_counterbore" },
    { standard: "7046-1", form: "countersunk-screw", headStyle: "countersunk", driveStyle: "cross-recessed", sourceUrl: "https://www.iso.org/standard/57373.html", tool: "plasticity_create_countersink" },
    { standard: "7380-2", form: "button-head-screw", headStyle: "button", driveStyle: "hexagon-socket", sourceUrl: "https://www.iso.org/standard/78700.html", tool: "plasticity_create_counterbore" },
    { standard: "14583", form: "pan-head-screw", headStyle: "pan", driveStyle: "hexalobular-socket", sourceUrl: "https://www.iso.org/standard/56457.html", tool: "plasticity_create_counterbore" },
    { standard: "14581", form: "countersunk-screw", headStyle: "countersunk", driveStyle: "hexalobular-socket", sourceUrl: "https://www.iso.org/standard/78695.html", tool: "plasticity_create_countersink" },
  ] as const;

  for (const expected of cases) {
    const result = resolveFastenerDesignation({
      designation: `винт ISO ${expected.standard} M5x10 с гайкой`,
      mountingIntent: "fixed",
      analysisIntent: "geometry",
    });
    assert.equal(result.form, expected.form, `ISO ${expected.standard} form`);
    assert.equal(result.headStyle, expected.headStyle, `ISO ${expected.standard} head`);
    assert.equal(result.driveStyle, expected.driveStyle, `ISO ${expected.standard} drive`);
    assert.equal(result.standard?.sourceUrl, expected.sourceUrl, `ISO ${expected.standard} source`);
    assert.ok(result.sourceUrls.includes(expected.sourceUrl), `ISO ${expected.standard} source list`);
    assert.ok(result.workflow.compatibleTools.includes(expected.tool), `ISO ${expected.standard} CAD route`);
    assert.equal(result.issues.some((issue) => issue.code === "STANDARD_NOT_CATALOGUED"), false);
    assert.equal("headDiameterMm" in result, false);
  }
});

test("routes ISO set screws as headless fasteners and preserves their tensile-load limitation", () => {
  const cases = [
    ["4026", "flat", "https://www.iso.org/standard/88194.html"],
    ["4027", "truncated-cone", "https://www.iso.org/standard/88195.html"],
    ["4028", "dog", "https://www.iso.org/standard/88196.html"],
    ["4029", "cup", "https://www.iso.org/standard/88197.html"],
  ] as const;

  for (const [standard, pointStyle, sourceUrl] of cases) {
    const result = resolveFastenerDesignation({
      designation: `установочный винт ISO ${standard} M5x10 в резьбовое отверстие в металле`,
      mountingIntent: "fixed",
      analysisIntent: "geometry",
    });
    assert.equal(result.form, "set-screw", `ISO ${standard} form`);
    assert.equal(result.headStyle, "headless", `ISO ${standard} head`);
    assert.equal(result.driveStyle, "hexagon-socket", `ISO ${standard} drive`);
    assert.equal(result.pointStyle, pointStyle, `ISO ${standard} point`);
    assert.equal(result.standard?.sourceUrl, sourceUrl, `ISO ${standard} source`);
    assert.equal(result.workflow.route, "tapped-metal");
    assert.ok(result.workflow.compatibleTools.includes("plasticity_create_blind_hole"));
    assert.equal(result.requiredInputs.includes("headAndDriverEnvelopeMm"), false);
    assert.ok(result.requiredInputs.includes("driverAccessEnvelopeMm"));
    assert.ok(result.requiredInputs.includes("matingContactSurfaceAndRetentionRequirement"));
    assert.ok(result.questions.some((question) => question.id === "set-screw-contact"));
    assert.ok(result.issues.some((issue) => issue.code === "SET_SCREW_TENSION_LIMITATION"));
    assert.ok(result.rules.some((rule) => /not intended for tensile load/i.test(rule)));
  }
});

test("routes a fixed group of tapped fasteners to one blind-hole pattern", () => {
  const result = resolveFastenerDesignation({
    designation: "4 установочных винта ISO 4029 M5x10 в резьбовые отверстия в металле",
    mountingIntent: "fixed",
    analysisIntent: "geometry",
  });
  assert.equal(result.interpretation.quantity, 4);
  assert.equal(result.jointIntent, "machine-screw-into-tapped-metal");
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_blind_hole_pattern"));
  assert.equal(result.workflow.compatibleTools.includes("plasticity_create_blind_hole"), false);
  assert.ok(result.requiredInputs.includes("holeEntryCentersMm"));
  assert.match(result.workflow.sequence.join(" "), /all 4 .*explicit entry centers/i);
});

test("routes a fixed multi-screw socket-head joint to one counterbore pattern", () => {
  const result = resolveFastenerDesignation({
    designation: "крепится на 4 винта DIN 912 M5x10 с гайками",
    jointIntent: "unknown",
    analysisIntent: "geometry",
  });
  assert.equal(result.interpretation.quantity, 4);
  assert.equal(result.interpretation.mountingIntent, "fixed");
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_counterbore_pattern"));
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_hex_nut_pocket_pattern"));
  assert.equal(result.workflow.compatibleTools.includes("plasticity_create_counterbore"), false);
  assert.equal(result.workflow.compatibleTools.includes("plasticity_create_hex_nut_pocket"), false);
  assert.match(result.workflow.sequence.join(" "), /all 4 explicit centers/i);
});

test("routes countersunk screws and through bolts to exact head and nut pocket recipes", () => {
  const result = resolveFastenerDesignation({
    designation: "винт ISO 10642 M5x10",
    jointIntent: "through-bolt-with-nut",
    analysisIntent: "geometry",
  });
  assert.equal(result.headStyle, "countersunk");
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_countersink"));
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_hex_nut_pocket"));
  assert.equal(result.workflow.compatibleTools.includes("plasticity_create_slotted_hole"), false);
  assert.ok(result.requiredInputs.includes("countersinkMajorDiameterMm"));
  assert.ok(result.requiredInputs.includes("nutAndWasherEnvelopeMm"));
});

test("routes a fixed multi-screw countersunk joint to one countersink pattern", () => {
  const result = resolveFastenerDesignation({
    designation: "крепится на 4 винта ISO 10642 M5x10 с гайками",
    jointIntent: "unknown",
    analysisIntent: "geometry",
  });
  assert.equal(result.interpretation.quantity, 4);
  assert.equal(result.interpretation.mountingIntent, "fixed");
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_countersink_pattern"));
  assert.equal(result.workflow.compatibleTools.includes("plasticity_create_countersink"), false);
  assert.match(result.workflow.sequence.join(" "), /all 4 explicit centers/i);
});

test("routes a machine screw into a heat-set insert without inferring the insert pocket", () => {
  const result = resolveFastenerDesignation({
    designation: "M3x12 socket head screw",
    jointIntent: "machine-screw-into-heat-set-insert",
    analysisIntent: "both",
  });
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_heat_set_insert_pocket"));
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_split_screw_insert_joint"));
  assert.ok(result.workflow.compatibleTools.includes("plasticity_calculate_heat_set_insert_retention"));
  assert.ok(result.requiredInputs.includes("insertPartNumber"));
  assert.ok(result.requiredInputs.includes("insertPocketDimensionsMm"));
  assert.ok(result.questions.some((question) => question.resolves.includes("insertPartNumber")));
});

test("routes a fixed group of heat-set inserts to grouped pocket and clearance-hole recipes", () => {
  const result = resolveFastenerDesignation({
    designation: "крепится на 4 винта M3x10 в латунные термовставки",
    mountingIntent: "fixed",
    analysisIntent: "geometry",
  });
  assert.equal(result.interpretation.quantity, 4);
  assert.equal(result.jointIntent, "machine-screw-into-heat-set-insert");
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_split_screw_insert_joint"));
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_heat_set_insert_pocket_pattern"));
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_through_hole_pattern"));
  assert.ok(result.requiredInputs.includes("minimumAndMaximumInsertEngagementMm"));
  assert.equal(result.workflow.compatibleTools.includes("plasticity_create_heat_set_insert_pocket"), false);
  assert.equal(result.workflow.compatibleTools.includes("plasticity_create_through_hole"), false);
  assert.ok(result.requiredInputs.includes("holeEntryCentersMm"));
});

test("routes tapped and self-tapping blind pilots to the dedicated blind-hole recipe", () => {
  const tapped = resolveFastenerDesignation({
    designation: "винт DIN 912 M5x10 в резьбовое отверстие в металле",
    jointIntent: "unknown",
    analysisIntent: "both",
  });
  assert.equal(tapped.jointIntent, "machine-screw-into-tapped-metal");
  assert.ok(tapped.workflow.compatibleTools.includes("plasticity_create_blind_hole"));
  assert.ok(tapped.workflow.compatibleTools.includes("plasticity_create_through_hole"));
  assert.ok(tapped.workflow.compatibleTools.includes("plasticity_calculate_threaded_receiver_strength"));
  assert.ok(tapped.requiredInputs.includes("holeTermination"));
  assert.ok(tapped.requiredInputs.includes("threadedReceiverAllowableLoads"));
  assert.ok(tapped.requiredInputs.includes("completeThreadEngagement"));
  assert.ok(tapped.questions.some((question) => question.id === "tapped-hole-termination"));
  assert.doesNotMatch(tapped.workflow.sequence.join(" "), /outside the current bounded method/i);

  const selfTapping = resolveFastenerDesignation({
    designation: "саморез M4x16 в печатный пластик",
    jointIntent: "unknown",
    analysisIntent: "geometry",
  });
  assert.equal(selfTapping.jointIntent, "self-tapping-into-plastic");
  assert.ok(selfTapping.workflow.compatibleTools.includes("plasticity_create_blind_hole"));
});

test("routes repeated printed-plastic fasteners to one grouped boss recipe", () => {
  const result = resolveFastenerDesignation({
    designation: "крепится на 4 самореза M4x16 в печатный пластик",
    mountingIntent: "fixed",
    analysisIntent: "geometry",
  });
  assert.equal(result.interpretation.quantity, 4);
  assert.equal(result.jointIntent, "self-tapping-into-plastic");
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_screw_boss_pattern"));
  assert.equal(result.workflow.compatibleTools.includes("plasticity_create_screw_boss"), false);
  assert.ok(result.requiredInputs.includes("bossBaseCentersMm"));
});

test("recognizes a fully printed screw and mating nut as a custom thread pair", () => {
  const result = resolveFastenerDesignation({
    designation: "напечатай винт M8x24 и ответную гайку",
    mountingIntent: "fixed",
    analysisIntent: "geometry",
    decisionMode: "agent-may-select-qualified",
  });
  assert.equal(result.jointIntent, "printed-threaded-pair");
  assert.equal(result.thread.system, "custom-rounded-print");
  assert.equal(result.thread.nominalDiameterMm, 8);
  assert.equal(result.thread.pitchMm, undefined);
  assert.equal(result.lengthMm, 24);
  assert.equal(result.workflow.route, "printed-threaded-pair");
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_printed_hex_pair"));
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_printed_thread_calibration_set"));
  assert.ok(result.workflow.compatibleTools.includes("plasticity_match_printed_thread_qualification"));
  assert.ok(result.workflow.compatibleTools.includes("plasticity_record_printed_thread_qualification"));
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_printed_hex_screw"));
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_printed_hex_nut"));
  assert.ok(result.workflow.compatibleTools.includes("plasticity_check_interference"));
  assert.ok(result.requiredInputs.includes("printedThreadPitchMm"));
  assert.ok(result.requiredInputs.includes("profileClearanceMm"));
  assert.ok(result.questions.some((question) => question.id === "printed-thread-profile"));
  assert.equal(result.questions.some((question) => question.id === "property-class"), false);
  assert.equal(result.sourceUrls.some((url) => /iso\.org/u.test(url)), false);
  assert.ok(result.rules.some((rule) => /not ISO metric/i.test(rule)));
});

test("recognizes a print request with a generic mating part", () => {
  const result = resolveFastenerDesignation({
    designation: "нужна печать винта M6x20 и ответной части",
    mountingIntent: "fixed",
    analysisIntent: "geometry",
  });
  assert.equal(result.jointIntent, "printed-threaded-pair");
  assert.equal(result.thread.system, "custom-rounded-print");
  assert.equal(result.thread.nominalDiameterMm, 6);
  assert.equal(result.thread.pitchMm, undefined);
  assert.equal(result.lengthMm, 20);
  assert.ok(result.workflow.compatibleTools.includes("plasticity_create_printed_external_thread"));
  assert.ok(result.workflow.compatibleTools.includes("plasticity_cut_printed_internal_thread"));
});

test("asks for missing dimensions instead of rejecting an undimensioned printed pair", () => {
  const result = resolveFastenerDesignation({
    designation: "сделай печатный винт и ответную гайку",
    analysisIntent: "geometry",
  });
  assert.equal(result.status, "needs-input");
  assert.equal(result.jointIntent, "printed-threaded-pair");
  assert.equal(result.thread.system, "custom-rounded-print");
  assert.equal(result.workflow.route, "printed-threaded-pair");
  assert.ok(result.questions.some((question) => question.id === "printed-thread-diameter"));
  assert.ok(result.questions.some((question) => question.id === "fastener-length"));
  assert.ok(result.questions.some((question) => question.id === "printed-thread-profile"));
});

test("keeps a single small trailing value ambiguous instead of guessing pitch or length", () => {
  const result = resolveFastenerDesignation({
    designation: "M10x1",
    jointIntent: "unknown",
    analysisIntent: "geometry",
  });
  assert.equal(result.status, "needs-input");
  assert.equal(result.thread.pitchMm, undefined);
  assert.equal(result.lengthMm, undefined);
  assert.equal(result.ambiguousTrailingValueMm, 1);
  assert.ok(result.issues.some((issue) => issue.code === "AMBIGUOUS_PITCH_OR_LENGTH"));
});

test("recognizes a short but plausible M3x3 fastener length", () => {
  const result = resolveFastenerDesignation({
    designation: "винт M3x3",
    jointIntent: "machine-screw-into-tapped-metal",
    analysisIntent: "geometry",
  });
  assert.equal(result.lengthMm, 3);
  assert.equal(result.thread.pitchMm, 0.5);
  assert.equal(result.ambiguousTrailingValueMm, undefined);
});

test("does not ask a stud for a head style", () => {
  const result = resolveFastenerDesignation({
    designation: "шпилька M10x30",
    jointIntent: "through-bolt-with-nut",
    analysisIntent: "geometry",
  });
  assert.equal(result.form, "stud");
  assert.equal(result.headStyle, "headless");
  assert.equal(result.questions.some((question) => question.id === "head-standard"), false);
  assert.equal(result.requiredInputs.includes("headAndDriverEnvelopeMm"), false);
});

test("rejects unsupported imperial designations explicitly", () => {
  const result = resolveFastenerDesignation({
    designation: "1/4-20 UNC bolt",
    jointIntent: "through-bolt-with-nut",
    analysisIntent: "geometry",
  });
  assert.equal(result.status, "unsupported");
  assert.ok(result.issues.some((issue) => issue.code === "UNSUPPORTED_THREAD_SYSTEM"));
});

test("input schema is strict and bounded", () => {
  assert.equal(fastenerDesignationInputSchema.safeParse({ designation: "M5x10", extra: true }).success, false);
  assert.equal(fastenerDesignationInputSchema.safeParse({ designation: "" }).success, false);
  assert.equal(fastenerDesignationInputSchema.safeParse({ designation: "x".repeat(501) }).success, false);
});
