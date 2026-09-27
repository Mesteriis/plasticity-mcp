import assert from "node:assert/strict";
import test from "node:test";

import {
  designReferencePrompt,
  DESIGN_REFERENCE_WORKFLOW_RESOURCE,
  strengthPrompt,
  STRENGTH_METHODS_RESOURCE,
  STRENGTH_RECOVERY_RESOURCE,
  STRENGTH_WORKFLOW_RESOURCE,
} from "./instructions.ts";

test("CAD reference intake preserves image uncertainty and keeps Codex as the conversation partner", () => {
  const prompt = designReferencePrompt("Build a bracket from a photo");
  assert.match(prompt, /plasticity_analyze_design_reference/);
  assert.match(prompt, /cannot establish exact millimetre dimensions/i);
  assert.match(prompt, /To return scaleStatus dimensioned or calibrated/i);
  assert.match(prompt, /Give every numeric geometry measurement in mm, mm2, or mm4 its own traceable source/i);
  assert.match(prompt, /one labeled dimension cannot support other guessed dimensions/i);
  assert.match(prompt, /sourceLocator must identify the exact dimension line or annotation in the cited view/i);
  assert.match(prompt, /structured unit and value\/range must match that dimension exactly/i);
  assert.match(prompt, /Put one numeric dimension in each observation/i);
  assert.match(prompt, /Keep dimensions out of articleType and functionalIntent/i);
  assert.match(prompt, /interface or feature description includes one, cite an evidence ID/i);
  assert.match(prompt, /Keep observation IDs unique across supplied and returned evidence/i);
  assert.match(prompt, /answer:<questionId>/);
  assert.match(prompt, /next logical package/i);
  assert.match(prompt, /complete the sufficiently specified, authorized design first/i);
  assert.match(prompt, /accept, reject, or delegate that choice/i);
  assert.match(prompt, /unknown blocks a safe decision about load path, strength, fit, clearance/i);
  assert.match(prompt, /what object is attached/i);
  assert.match(prompt, /Workbench is optional/i);
  assert.match(prompt, /user edits in Plasticity/i);
  assert.match(prompt, /plasticity_import_step/);
  assert.match(prompt, /direct asset URL as `sourceUrl`/);
  assert.match(prompt, /candidate page as optional `sourcePageUrl`/);
  assert.match(prompt, /never guess one/i);
  assert.match(prompt, /reports license and access status separately/i);
  assert.match(prompt, /ask before any purchase/i);
  assert.match(prompt, /plasticity_download_and_import_parasolid/);
  assert.match(prompt, /choose the exact representation and never infer it/i);
  assert.match(prompt, /SHA-256/);
  assert.match(prompt, /plasticity_download_and_import_reference_mesh/);
  assert.match(prompt, /plasticity_list_reference_meshes/);
  assert.match(prompt, /plasticity_construction_history/);
  assert.match(prompt, /durableSyncStatus/);
  assert.match(prompt, /treat all bounds as tessellated reference evidence/i);
  assert.match(prompt, /plasticity_construction_history.*across MCP restarts/i);
  assert.match(prompt, /Build one coherent feature package/i);
  assert.match(prompt, /read actual B-Rep dimensions back/i);
  assert.match(prompt, /sourceImageIndices.*one-based positions/i);
  assert.match(prompt, /views that omit, hide, or leave a feature ambiguous/i);
  assert.match(prompt, /Compare distinct views for agreement/i);
  assert.match(prompt, /Current request: Build a bracket from a photo/);
  assert.match(prompt, /Do not start or submit a physical print/i);
  assert.equal(DESIGN_REFERENCE_WORKFLOW_RESOURCE.includes("Codex remains the user's conversation partner"), true);
});

test("workflow tells Codex to resolve strength facts before CAD changes", () => {
  const prompt = strengthPrompt("Design a bracket from a photo");
  assert.match(prompt, /primary product\/material sources/i);
  assert.match(prompt, /object is supported/i);
  assert.match(prompt, /do not infer exact scale/i);
  assert.match(prompt, /accepted package|explicitly delegated task/i);
  assert.match(prompt, /actual native geometry/i);
  assert.match(prompt, /Workbench is optional/i);
  assert.match(prompt, /unknown material properties/i);
  assert.match(prompt, /critical plane/i);
  assert.match(prompt, /arbitrary plane/i);
  assert.match(prompt, /plasticity_verify_tongue_root_strength/);
  assert.match(prompt, /whole.joint approval/i);
  assert.match(prompt, /whole.part validation/i);
  assert.match(prompt, /plasticity_plan_cohesive_layer_planes/);
  assert.match(prompt, /For layerwise static FEA/);
  assert.match(prompt, /workbench_slicer_layer_path_orientations/);
  assert.match(prompt, /every deposited layer/);
  assert.match(prompt, /pathFrameMapping/);
  assert.match(prompt, /workbench_slicer_interface_heights/);
  assert.match(prompt, /depositionLayerZMm.*firstDepositionLayerZMm/);
  assert.match(prompt, /interfaceOffsetsMm/);
  assert.match(prompt, /same measured orthotropic tensor/);
  assert.match(prompt, /perfectly bonded/);
  assert.match(prompt, /Do not use static FEA to assess delamination/);
  assert.match(prompt, /omitted interfaces remain unanalyzed/i);
  assert.match(prompt, /net pressure/i);
  assert.match(prompt, /edge conditions/i);
  assert.match(prompt, /bearing, shear and tensile allowables/i);
  assert.match(prompt, /layout without criteria is not a pass/i);
  assert.match(prompt, /each fastener’s own vector resultant/i);
  assert.match(prompt, /single-through-fastener plate method assumes one hole/i);
  assert.match(prompt, /never repeat it per hole/i);
});

test("resources include supported, unsupported and stale worked outcomes without print dispatch", () => {
  assert.match(STRENGTH_METHODS_RESOURCE, /axial-rectangle-v1/);
  assert.match(STRENGTH_METHODS_RESOURCE, /cantilever-tip-rectangle-v1/);
  assert.match(STRENGTH_METHODS_RESOURCE, /euler-column-buckling-v1/);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /do not guess K/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /known dimensions/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /photo without scale/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /unsupported ribbed part/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /worked planar rectangle/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /holed section/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /unsupported torsion/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /stale face/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /arbitrary critical plane/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /Codex chat/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /whole.part validation/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /stale report/i);
  assert.doesNotMatch(STRENGTH_WORKFLOW_RESOURCE, /send (?:it )?to (?:the )?printer|start printing/i);
  assert.match(STRENGTH_RECOVERY_RESOURCE, /interrupted request/i);
  assert.match(STRENGTH_RECOVERY_RESOURCE, /new request ID/i);
  assert.match(STRENGTH_RECOVERY_RESOURCE, /plasticity_construction_history/);
  assert.match(STRENGTH_RECOVERY_RESOURCE, /durableSyncStatus/);
  assert.match(STRENGTH_METHODS_RESOURCE, /planar-section-resultants-v1/);
  assert.match(STRENGTH_METHODS_RESOURCE, /biaxial/i);
  assert.match(STRENGTH_METHODS_RESOURCE, /solid circle/i);
  assert.match(STRENGTH_METHODS_RESOURCE, /concentric circular annulus/i);
  assert.match(STRENGTH_METHODS_RESOURCE, /torsional shear/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /simultaneous transverse shear and torsion/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /rectangular enclosure panel/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /not automatically simply supported/i);
  assert.match(STRENGTH_METHODS_RESOURCE, /simply-supported-plate-uniform-pressure-v1/);
  assert.match(STRENGTH_METHODS_RESOURCE, /Navier-series/i);
  assert.match(STRENGTH_METHODS_RESOURCE, /single-fastener-plate-v1/i);
  assert.match(STRENGTH_METHODS_RESOURCE, /fastener-member-v1/i);
  assert.match(STRENGTH_METHODS_RESOURCE, /tongue-root-transverse-v1/i);
  assert.match(STRENGTH_METHODS_RESOURCE, /never validates a tongue-and-groove joint/i);
  assert.match(STRENGTH_METHODS_RESOURCE, /heat-set-insert-retention-v1/i);
  assert.match(STRENGTH_METHODS_RESOURCE, /fastener-group-elastic-in-plane-v1/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /single loaded fastener/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /does not check the fastener/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /R_t² \+ R_s³/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /manufacturer data.*does not automatically qualify/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /load distribution only/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /point of application/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /plasticity_check_fastener_group_layout/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /layout pass covers geometric spacing only/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /plasticity_verify_fastener_group_plate_bearing/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /plasticity_record_fastener_group_test/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /does not produce a design allowable/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /separately supplied external resultant/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /shared-ligament interaction.*remain unchecked/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /selected immutable record ID.*dimensional equivalence tolerance/i);
  assert.match(STRENGTH_WORKFLOW_RESOURCE, /not a statistically reduced allowable, strength pass\/fail/i);
  assert.doesNotMatch(STRENGTH_WORKFLOW_RESOURCE, /until a supported group-plate method exists/i);
});
