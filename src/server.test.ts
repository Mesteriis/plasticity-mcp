import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { AnalysisClient } from "./codex/analysis-client.ts";
import { createCompactServer, createServer as createPlasticityServer, PlasticitySession, strengthDependenciesForSession, type SessionLike } from "./server.ts";
import { diffScenes } from "./plasticity/change-tracker.ts";
import { frameFromOriginNormalX } from "./plasticity/construction.ts";
import { PlasticityOperations } from "./plasticity/operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./plasticity/runtime.ts";
import { PrintedThreadQualificationStore } from "./printing/thread-qualification.ts";
import { StepImportReferenceStore } from "./plasticity/import-reference-store.ts";
import { ConstructionHistoryStore } from "./plasticity/construction-history.ts";
import { StrengthStore } from "./strength/store.ts";
import { FemReportStore } from "./strength/fem/fem-report-store.ts";
import { type StoredCohesiveReport } from "./strength/fem/cohesive-report-store.ts";
import { verifyCohesiveReportEvidence } from "./strength/fem/cohesive-report-evidence.ts";
import type { InterfaceTestInput } from "./strength/interface-test.ts";
import type { MaterialCouponQualificationInput } from "./strength/material-qualification.ts";

const createServer = (
  session?: SessionLike,
  strength?: Parameters<typeof createPlasticityServer>[1],
  qualifications?: PrintedThreadQualificationStore,
  references?: StepImportReferenceStore,
) => createPlasticityServer(session, strength, qualifications, references, null);

test("wait_for_change ignores revision-only wakes until the scene diff is reportable", async () => {
  const session = new PlasticitySession();
  let calls = 0;
  session.changesSince = async () => {
    calls += 1;
    const sceneChanged = calls > 1;
    return {
      timedOut: false,
      diff: { changed: true, revisionChanged: true, sceneChanged },
      current: {},
    } as unknown as Awaited<ReturnType<typeof session.changesSince>>;
  };

  const result = await session.waitForChange("test-snapshot", 2_000);

  assert.equal(calls, 2);
  assert.equal(result.timedOut, false);
  assert.equal(result.diff.sceneChanged, true);
});

test("cohesive report evidence freshness rechecks the immutable interface test and exact coupons", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-cohesive-freshness-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new StrengthStore(root);
  const process = { printerId: "creality-k1c", materialId: "pla-layer-test", profileHash: "a".repeat(64), orientationDeg: [0, 0, 0] as [number, number, number], infillPercent: 100, infillPattern: "grid", wallLoops: 2, topShellLayers: 5, bottomShellLayers: 3, nozzleTemperatureC: 220, layerHeightMm: 0.2 };
  const interfaceInput: InterfaceTestInput = {
    interfaceKind: "same-material-layer", materialAProcess: process, materialBProcess: process,
    testMode: "normal-tension", fractureMethod: "dcb-mode-i", interfaceNormalGlobal: [0, 0, 1], loadDirectionGlobal: [0, 0, 1],
    testMethod: "ASTM D5528 DCB", testProtocolHash: "b".repeat(64),
    specimenDescription: "Same-material printed coupon separated at one layer interface.",
    fixtureDescription: "Axial grips pull the layers apart along the interface normal.", measuredPeakStrengthMPa: 2.4,
    tractionSeparationCurve: {
      sourceHash: "c".repeat(64), sourceLocator: "curve.csv!A2:B5",
      points: [{ separationMm: 0, tractionMPa: 0 }, { separationMm: 0.01, tractionMPa: 2.4 }, { separationMm: 0.04, tractionMPa: 1.2 }, { separationMm: 0.08, tractionMPa: 0 }],
    },
    failureLocation: "interface",
    evidence: [{ id: "interface-strength", label: "Measured layer-interface peak", status: "measured", value: 2.4, unit: "MPa", sourceHash: "d".repeat(64), sourceLocator: "test.pdf p.4", dependsOn: [] }],
    specimenCount: 5, testedAt: "2026-09-24T10:00:00.000Z", source: "physical-material-interface-test", callerConfirmsPhysicalTests: true,
  };
  const testRecord = await store.materialInterfaceTests.record(interfaceInput);
  const coupon = await store.materialQualifications.record(cohesiveCouponInput(process, 2000));
  const assignment = {
    testMaterial: "A" as const, process, couponRecordId: coupon.record.id, youngsModulusMPa: 2000, poissonRatio: 0.3,
    poissonRatioEvidence: { id: "nu", label: "Poisson ratio", status: "measured" as const, value: 0.3, unit: "ratio" as const, sourceUrl: "https://example.test/poisson", sourceHash: "e".repeat(64), sourceLocator: "p.2", dependsOn: [] },
  };
  const report = {
    input: { interfaceTestRecordId: testRecord.record.id },
    physicalTest: { recordId: testRecord.record.id, interfaceKind: testRecord.record.interfaceKind, materialAProcess: process, materialBProcess: process, curveSourceHash: "c".repeat(64), curveSourceLocator: "curve.csv!A2:B5", measuredCurveSummary: { peakStrengthMPa: 2.4, fractureEnergyNPerMm: 0.09 } },
    couponRecordIds: { materialA: coupon.record.id, materialB: coupon.record.id },
    materialAssignment: { negativeSide: assignment, positiveSide: { ...assignment, testMaterial: "B" as const } },
  } as unknown as StoredCohesiveReport;
  await verifyCohesiveReportEvidence(report, store.materialInterfaceTests, store.materialQualifications);

  await store.materialQualifications.record(cohesiveCouponInput(process, 2100));
  await assert.rejects(verifyCohesiveReportEvidence(report, store.materialInterfaceTests, store.materialQualifications), /missing, conflicting/);
  await store.materialInterfaceTests.record({
    ...interfaceInput,
    tractionSeparationCurve: {
      ...interfaceInput.tractionSeparationCurve!,
      points: [
        { separationMm: 0, tractionMPa: 0 }, { separationMm: 0.01, tractionMPa: 2.4 },
        { separationMm: 0.04, tractionMPa: 1 }, { separationMm: 0.08, tractionMPa: 0 },
      ],
    },
  });
  await assert.rejects(verifyCohesiveReportEvidence(report, store.materialInterfaceTests, store.materialQualifications), /unique exact match/);
});

function cohesiveCouponInput(process: MaterialCouponQualificationInput["process"], modulus: number): MaterialCouponQualificationInput {
  const properties = { youngModulusMPa: modulus, shearModulusMPa: 800, tensileStrengthMPa: 30, shearStrengthMPa: 20 };
  const keys = Object.entries(properties) as Array<[keyof typeof properties, number]>;
  const evidence = keys.map(([key, value], index) => ({
    id: `cohesive-coupon-${modulus}-${index}`, label: key, status: "measured" as const, value, unit: "MPa" as const,
    sourceUrl: "https://example.test/coupon.pdf", sourceHash: `${index + 1}`.repeat(64), sourceLocator: `coupon.pdf!${key}`, dependsOn: [],
  }));
  return {
    process, properties,
    propertyEvidence: {
      youngModulusMPa: [evidence[0]!.id], shearModulusMPa: [evidence[1]!.id],
      tensileStrengthMPa: [evidence[2]!.id], shearStrengthMPa: [evidence[3]!.id],
    },
    evidence, testStandard: "ISO-527", specimenCount: 5, testedAt: "2026-09-24T10:00:00.000Z",
    source: "physical-coupon-test", callerConfirmsPhysicalTests: true,
  };
}

test("MCP initializes, lists tools, and validates tool input", async () => {
  const fake = {
    async windows() { return [{ id: "window-1", title: "Untitled - Plasticity", url: "file:///app_window/index.html" }]; },
    async connect() { return {}; },
    get() { throw new Error("not connected"); },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; },
    async changesSince() { return {}; },
    async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const instructions = client.getInstructions() ?? "";
  assert.match(instructions, /If the needed operation is missing from the client's visible tool list, call plasticity_call with toolName="catalog"/);
  assert.match(instructions, /photos and sketches, treat observations as references, not exact dimensions/i);
  assert.match(instructions, /Ask one compact, decision-relevant question package at a time/i);
  assert.match(instructions, /Keep strength checks proportional to risk/i);
  assert.match(instructions, /plasticity_measure_nonparallel_planar_polygon_clearance when both trimmed faces have simple straight-edged loops; concave outlines, holes, and multiple loops are supported/i);
  assert.match(instructions, /Workbench is optional; the user may inspect the model in Plasticity and continue in Codex/i);
  assert.match(instructions, /wait for the user's explicit confirmation before calling any print-submission tool/i);

  const tools = await client.listTools();
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_box"));
  const downloadImport = tools.tools.find((tool) => tool.name === "plasticity_download_and_import_step");
  assert.equal(downloadImport?.annotations?.openWorldHint, true);
  assert.equal(downloadImport?.annotations?.destructiveHint, true);
  const listReferenceAssets = tools.tools.find((tool) => tool.name === "plasticity_list_reference_assets");
  assert.equal(listReferenceAssets?.annotations?.openWorldHint, true);
  assert.equal(listReferenceAssets?.annotations?.destructiveHint, false);
  const listBodies = tools.tools.find((tool) => tool.name === "plasticity_list_bodies");
  assert.match(listBodies?.description ?? "", /cone faces.*basis radius.*axis origin\/direction.*semi-angle in radians/i);
  const nonparallelClearance = tools.tools.find((tool) => tool.name === "plasticity_measure_nonparallel_planar_polygon_clearance");
  assert.match(nonparallelClearance?.description ?? "", /Concave outlines, holes and multiple nested\/disjoint loops are supported.*512 boundary vertices and 4096 exact decomposition triangles/i);
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_cone"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_torus"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_two_point_circle"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_three_point_circle"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_slot_profiles"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_export_step"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_export_parasolid"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_import_parasolid"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_list_cad_reference_imports"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_get_cad_reference_import"));
  const downloadParasolid = tools.tools.find((tool) => tool.name === "plasticity_download_and_import_parasolid");
  assert.equal(downloadParasolid?.annotations?.openWorldHint, true);
  assert.equal(downloadParasolid?.annotations?.destructiveHint, true);
  const downloadReferenceMesh = tools.tools.find((tool) => tool.name === "plasticity_download_and_import_reference_mesh");
  assert.equal(downloadReferenceMesh?.annotations?.openWorldHint, true);
  assert.equal(downloadReferenceMesh?.annotations?.destructiveHint, true);
  assert.match(downloadReferenceMesh?.description ?? "", /not native B-rep/i);
  const downloadReference3mf = tools.tools.find((tool) => tool.name === "plasticity_download_and_import_reference_3mf");
  assert.equal(downloadReference3mf?.annotations?.openWorldHint, true);
  assert.equal(downloadReference3mf?.annotations?.destructiveHint, true);
  assert.match(downloadReference3mf?.description ?? "", /approximate reference mesh.*embedded 3MF unit/i);
  assert(tools.tools.some((tool) => tool.name === "plasticity_import_svg"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_import_reference_mesh"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_import_reference_3mf"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_export_stl"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_export_3mf"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_export_obj"));
  const nonDestructiveOutputs = [
    "plasticity_screenshot",
    "plasticity_save_copy",
    "plasticity_export_step",
    "plasticity_export_parasolid",
    "plasticity_export_stl",
    "plasticity_export_3mf",
    "plasticity_export_obj",
    "plasticity_export_svg",
    "plasticity_export_hiddenline_svg",
  ];
  for (const name of nonDestructiveOutputs) {
    const output = tools.tools.find((tool) => tool.name === name);
    assert.equal(output?.annotations?.readOnlyHint, false, `${name} writes a new artifact and is not read-only`);
    assert.equal(output?.annotations?.destructiveHint, false, `${name} refuses overwrites and must not be marked destructive`);
  }
  const matchFaces = tools.tools.find((tool) => tool.name === "plasticity_match_faces");
  assert.equal(matchFaces?.annotations?.readOnlyHint, false);
  assert.equal(matchFaces?.annotations?.destructiveHint, true, "surface replacement edits native CAD and remains destructive");
  const exportSvg = tools.tools.find((tool) => tool.name === "plasticity_export_svg");
  assert.match(exportSvg?.description ?? "", /non-rational polynomial BCurves of integer degree 1 through 3/i);
  assert(tools.tools.some((tool) => tool.name === "plasticity_export_hiddenline_svg"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_changes_since"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_construction_history"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_rectangular_pattern"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_radial_pattern"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_cut_with_faces"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_split_solid_by_plane"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_split_solid_by_planes"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_split_solid_to_build_volume"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_list_appearance_materials"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_set_appearance_material"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_set_block_dimensions"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_set_radius_dimension"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_set_rectangle_dimensions"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_measure_point_distance"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_measure_point_to_linear_edge"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_measure_point_to_curved_edge"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_measure_point_to_circular_edge"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_measure_point_to_planar_face"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_measure_planar_faces"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_measure_fastener_grip_stack"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_measure_linear_edges"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_analyze_edge_curvature"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_analyze_face_draft"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_measure_face_properties"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_analyze_surface_continuity"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_list_measurements"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_vertex_distance_measurement"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_topology_distance_measurement"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_radius_measurement"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_delete_measurement"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_list_section_analyses"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_section_analysis"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_delete_section_analysis"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_list_instances"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_instance"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_duplicate_bodies"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_move_instances"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_rotate_instances"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_scale_instances"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_orient_bodies_for_print"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_realize_instances"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_delete_instances"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_list_reference_meshes"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_select_reference_meshes"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_move_reference_meshes"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_rotate_reference_meshes"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_scale_reference_meshes"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_delete_reference_meshes"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_list_groups"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_select_nodes"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_select_faces"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_select_edges"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_select_curve_control_points"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_align_planar_faces"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_align_cylindrical_faces"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_align_vertices"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_align_linear_edges"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_check_interference"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_measure_solid_properties"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_group"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_move_to_group"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_rename_group"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_activate_group"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_dissolve_groups"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_set_visibility"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_set_locked"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_chamfer"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_remove_fillets"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_refillet_faces"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_revolve_profile"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_thicken_sheets"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_hollow_solids"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_draft_faces"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_move_faces"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_rotate_faces"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_scale_faces"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_thicken_faces"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_offset_face_loops"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_patch_solid_edge_loops"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_move_edges"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_offset_edges"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_delete_edges"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_offset_vertices"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_rectangular_face_pattern"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_radial_face_pattern"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_list_regions"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_extrude_regions"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_offset_planar_curves"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_offset_regions"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_list_curve_fragments"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_trim_curve_fragments"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_list_curve_endpoints"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_list_curve_vertices"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_list_curve_directions"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_evaluate_curve_segments"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_inspect_curve_structure"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_inspect_curve_planarity"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_list_curve_control_points"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_move_curve_control_points"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_slide_curve_control_points"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_rotate_curve_control_points"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_scale_curve_control_points"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_delete_curve_control_points"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_list_curve_intersections"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_extend_curve_endpoints"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_convert_curve_vertices_to_control_points"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_fillet_curve_vertices"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_unjoin_curves"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_join_curves"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_rebuild_curves"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_raise_curve_degree"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_subdivide_curves"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_insert_curve_knot"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_split_curve_segment"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_planarize_curves"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_reverse_curves"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_reverse_sheets"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_body_outlines"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_curve_pattern"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_project_curves_onto_body"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_body_intersection_curves"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_project_curve_pair"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_insert_isoparam_edges"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_inspect_surface_structure"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_raise_surface_degree"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_rebuild_face"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_match_faces"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_untrim_faces"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_imprint_curves_on_body"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_imprint_bodies"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_sweep_regions"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_loft_regions"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_loft_curves"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_loft_faces"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_patch_regions"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_patch_closed_wires"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_join_sheets"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_bridge_surface"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_constrained_surface"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_extract_faces"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_unwrap_face"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_analyze_cone_development"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_cone_development"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_deform_bodies_between_faces"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_deform_curves_between_faces"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_extract_edges"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_unjoin_faces"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_insert_sheet"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_unjoin_shells"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_solid_from_sheet"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_delete_faces"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_dissolve_faces"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_patch_sheet_hole"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_cap_sheet_holes"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_extend_sheet_edges"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_validate_bodies"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_pipes"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_nurbs_curve"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_helix"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_center_arc"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_three_point_arc"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_tangent_arc"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_tangent_circle"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_bridge_curves"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_bridge_curve_vertices"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_bridge_shell_edges"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_ellipse"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_regular_polygon"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_rectangle"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_text"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_duplicate_curves"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_curves_from_regions"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_counterbore"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_counterbore_pattern"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_through_hole"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_through_hole_pattern"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_blind_hole"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_blind_hole_pattern"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_countersink"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_countersink_pattern"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_hex_nut_pocket"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_hex_nut_pocket_pattern"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_printed_external_thread"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_cut_printed_internal_thread"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_printed_hex_nut"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_printed_hex_screw"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_printed_hex_pair"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_printed_thread_calibration_set"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_record_printed_thread_qualification"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_list_printed_thread_qualifications"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_match_printed_thread_qualification"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_slotted_hole"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_slotted_hole_pattern"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_heat_set_insert_pocket"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_heat_set_insert_pocket_pattern"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_screw_boss"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_screw_boss_pattern"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_resolve_fastener_designation"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_check_fastener_stack"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_inspect_fastener_group"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_check_fastener_group_layout"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_rib"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_round_vent_array"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_cantilever_snap_fit"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_hinge_barrel"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_cut_cable_channel"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_connector_opening"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_mating_enclosure_joint"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_locating_pin_pair"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_locating_pin_pair_pattern"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_split_screw_insert_joint"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_tongue_groove_joint"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_create_dovetail_joint"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_strength_methods"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_construction_history"));
  assert(tools.tools.some((tool) => tool.name === "plasticity_verify_member_strength"));
  for (const name of [
    "plasticity_define_datum_point",
    "plasticity_define_datum_axis",
    "plasticity_create_construction_plane",
    "plasticity_list_construction_geometry",
    "plasticity_set_workplane",
    "plasticity_remove_construction_plane",
    "plasticity_refresh_datum",
  ]) assert(tools.tools.some((tool) => tool.name === name), `missing tool ${name}`);
  const svgToolDescription = tools.tools.find((tool) => tool.name === "plasticity_export_svg")?.description ?? "";
  assert.match(svgToolDescription, /Degree-1 and degree-2 non-rational fixtures have live production stdio verification/i);
  assert.doesNotMatch(svgToolDescription, /still need live acceptance/i);

  const prompts = await client.listPrompts();
  assert(prompts.prompts.some((prompt) => prompt.name === "plasticity_model_from_reference"));
  assert(prompts.prompts.some((prompt) => prompt.name === "plasticity_strength_first"));
  const resources = await client.listResources();
  assert(resources.resources.some((resource) => resource.uri === "plasticity://strength/workflow"));
  const prompt = await client.getPrompt({
    name: "plasticity_model_from_reference",
    arguments: { referenceDescription: "dimensioned bracket sketch", defaultUnits: "mm" },
  });
  assert.match(JSON.stringify(prompt.messages), /Ask concise questions/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_strength_first/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_export_svg.*native Ellipse segments.*quarter-point checks/i);
  assert.match(JSON.stringify(prompt.messages), /Non-rational degree-1 and degree-2 fixtures now also have live production-stdio coverage.*accept:native-svg-polynomial-degrees/i);
  assert.match(JSON.stringify(prompt.messages), /plasticity_export_hiddenline_svg.*native hidden-line projector/i);
  assert.match(JSON.stringify(prompt.messages), /plasticity_analyze_design_reference/);
  assert.match(JSON.stringify(prompt.messages), /single next question package/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_design_reference_request/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_construction_history/);
  assert.match(JSON.stringify(prompt.messages), /durableSyncStatus/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_get_cad_reference_import/);
  assert.match(JSON.stringify(prompt.messages), /persistent provenance record/i);
  assert.match(JSON.stringify(prompt.messages), /direct asset URLs exposed by web-search\/open-page results/i);
  assert.match(JSON.stringify(prompt.messages), /do not invent or construct file URLs/i);
  assert.match(JSON.stringify(prompt.messages), /plasticity_download_and_import_parasolid/);
  assert.match(JSON.stringify(prompt.messages), /never infer it when the candidate omits it/);
  assert.match(JSON.stringify(prompt.messages), /sourcePageUrl/);
  assert.match(JSON.stringify(prompt.messages), /historical document\/revision/i);
  assert.match(JSON.stringify(prompt.messages), /never derive exact millimeters from an unscaled photo or sketch/i);
  assert.match(JSON.stringify(prompt.messages), /Use strength checks at the decision point where they help/);
  assert.match(JSON.stringify(prompt.messages), /Do not require physical coupon campaigns or detailed FEA before making a useful first model/);
  assert.match(JSON.stringify(prompt.messages), /before presenting a load-bearing design as ready to manufacture/);
  assert.match(JSON.stringify(prompt.messages), /one compact logical package at a time/);
  assert.match(JSON.stringify(prompt.messages), /Workbench is optional; keep the conversation in Codex/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_resolve_fastener_designation/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_check_fastener_stack/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_check_fastener_group_layout/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_measure_fastener_grip_stack/);
  assert.match(JSON.stringify(prompt.messages), /Before any CAD split or joint mutation, explain why the DFM plan needs multiple parts/);
  assert.match(JSON.stringify(prompt.messages), /Never invent fit clearance/);
  assert.match(JSON.stringify(prompt.messages), /Geometric non-interference is not proof of assembly clearance/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_locating_pin_pair_pattern/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_split_screw_insert_joint/);
  assert.match(JSON.stringify(prompt.messages), /nextQuestionPackage/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_countersink/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_countersink_pattern/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_counterbore_pattern/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_through_hole/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_through_hole_pattern/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_blind_hole/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_blind_hole_pattern/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_heat_set_insert_pocket_pattern/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_screw_boss_pattern/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_hex_nut_pocket/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_hex_nut_pocket_pattern/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_printed_hex_pair/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_printed_thread_calibration_set/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_match_printed_thread_qualification/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_record_printed_thread_qualification/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_center_arc/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_two_point_circle/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_three_point_circle/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_three_point_arc/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_tangent_arc/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_tangent_circle/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_bridge_curves/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_bridge_curve_vertices/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_bridge_shell_edges/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_ellipse/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_regular_polygon/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_inspect_curve_structure/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_inspect_surface_structure/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_raise_surface_degree/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_rebuild_face/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_match_faces/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_untrim_faces/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_unwrap_face/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_analyze_cone_development/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_patch_closed_wires/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_deform_bodies_between_faces/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_deform_curves_between_faces/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_unjoin_shells/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_inspect_curve_planarity/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_rebuild_curves/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_raise_curve_degree/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_subdivide_curves/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_insert_curve_knot/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_evaluate_curve_segments/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_split_curve_segment/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_planarize_curves/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_select_curve_control_points/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_slide_curve_control_points/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_move_faces/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_rotate_faces/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_scale_faces/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_thicken_faces/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_offset_face_loops/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_patch_solid_edge_loops/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_move_edges/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_offset_edges/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_delete_edges/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_offset_vertices/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_rectangular_face_pattern/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_radial_face_pattern/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_convert_curve_vertices_to_control_points/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_fillet_curve_vertices/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_hollow_solids/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_body_outlines/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_curve_pattern/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_slotted_hole_pattern/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_bridge_surface/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_loft_curves/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_loft_faces/);
  assert.match(JSON.stringify(prompt.messages), /guideIds/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_set_block_dimensions/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_set_radius_dimension/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_set_rectangle_dimensions/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_measure_point_distance/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_measure_point_to_linear_edge/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_measure_point_to_curved_edge only as an explicitly approximate sampled estimate/);
  assert.match(JSON.stringify(prompt.messages), /Wire segments identified by segmentEntityId/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_measure_point_to_curved_edge/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_measure_point_to_circular_edge/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_measure_point_to_planar_face/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_measure_planar_faces/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_measure_linear_edges/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_analyze_face_draft/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_vertex_distance_measurement/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_topology_distance_measurement/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_section_analysis/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_delete_section_analysis/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_instance/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_duplicate_bodies/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_realize_instances/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_group/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_activate_group/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_select_nodes/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_select_faces/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_select_edges/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_align_planar_faces/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_align_cylindrical_faces/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_align_vertices/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_align_linear_edges/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_check_interference/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_measure_solid_properties/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_measure_face_properties/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_set_visibility/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_duplicate_curves/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_create_curves_from_regions/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_export_parasolid/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_import_parasolid/);
  assert.match(JSON.stringify(prompt.messages), /plasticity_import_reference_mesh/);
  assert.match(JSON.stringify(prompt.messages), /measurementSource=reference-mesh/);

  const fastener = await client.callTool({
    name: "plasticity_resolve_fastener_designation",
    arguments: { designation: "винт m5х10" },
  });
  assert.equal(fastener.isError, undefined);
  assert.match(JSON.stringify(fastener.content), /M5×0\.8×10/);
  assert.match(JSON.stringify(fastener.content), /joint-target/);
  const fastenerText = (fastener.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const fastenerResult = JSON.parse(fastenerText ?? "null") as { analysisIntent: string; nextQuestionPackage: { id: string; questions: unknown[] } };
  assert.equal(fastenerResult.analysisIntent, "both");
  assert.equal(fastenerResult.nextQuestionPackage.id, "strength-basis");
  assert.equal(fastenerResult.nextQuestionPackage.questions.length, 3);

  const printedPairArguments = {
    designation: "печатная пара M5x1.5x10",
    pitchMm: 1.25,
    threadDepthMm: 0.6,
    profileClearanceMm: 0.15,
    screwAxisStartMm: [0, 0, 0],
    nutEntryCenterMm: [15, 0, 0],
    axis: [0, 0, 1],
    flatNormalDirection: [1, 0, 0],
    screwHeadAcrossFlatsMm: 9,
    screwHeadHeightMm: 3,
    screwJunctionOverlapMm: 0.2,
    nutAcrossFlatsMm: 9,
    nutThicknessMm: 8,
    nutMinimumWallThicknessMm: 1.5,
    process: {
      printerId: "Creality K1C",
      materialId: "Generic PLA",
      slicingProfileId: "0.20mm Standard",
      nozzleDiameterMm: 0.4,
      layerHeightMm: 0.2,
      orientation: "both axes vertical",
      clearanceBasis: "qualified calibration specimen",
    },
    sizingBasis: "fit-calibration specimen only",
    revision: "r1",
  };
  const mismatchedPrintedPair = await client.callTool({
    name: "plasticity_create_printed_hex_pair",
    arguments: printedPairArguments,
  });
  assert.equal(mismatchedPrintedPair.isError, true);
  assert.match(JSON.stringify(mismatchedPrintedPair.content), /does not match.*profile pitch/i);
  const standardizedPrintedPair = await client.callTool({
    name: "plasticity_create_printed_hex_pair",
    arguments: { ...printedPairArguments, designation: "ISO 4017 M5x10" },
  });
  assert.equal(standardizedPrintedPair.isError, true);
  assert.match(JSON.stringify(standardizedPrintedPair.content), /must not name.*standard/i);
  const printedCalibrationArguments = {
    designation: "печатная калибровочная пара M5x10",
    pitchMm: 1.25,
    threadDepthMm: 0.6,
    screwAxisStartMm: [0, 0, 0],
    axis: [0, 0, 1],
    flatNormalDirection: [1, 0, 0],
    screwHeadAcrossFlatsMm: 9,
    screwHeadHeightMm: 3,
    screwJunctionOverlapMm: 0.2,
    nutAcrossFlatsMm: 9,
    nutThicknessMm: 8,
    nutMinimumWallThicknessMm: 1.5,
    samples: [
      { id: "tight", nutEntryCenterMm: [15, 0, 0], profileClearanceMm: 0.1 },
      { id: "normal", nutEntryCenterMm: [30, 0, 0], profileClearanceMm: 0.2 },
    ],
    process: {
      printerId: "Creality K1C",
      materialId: "Generic PLA",
      slicingProfileId: "0.20mm Standard",
      nozzleDiameterMm: 0.4,
      layerHeightMm: 0.2,
      orientation: "all thread axes vertical",
      clearanceBasis: "unqualified calibration ladder",
    },
    sizingBasis: "candidate clearances pending physical fit test",
    revision: "r1",
  };
  const duplicatePrintedCalibration = await client.callTool({
    name: "plasticity_create_printed_thread_calibration_set",
    arguments: {
      ...printedCalibrationArguments,
      samples: [
        printedCalibrationArguments.samples[0],
        { ...printedCalibrationArguments.samples[1], profileClearanceMm: 0.1 },
      ],
    },
  });
  assert.equal(duplicatePrintedCalibration.isError, true);
  assert.match(JSON.stringify(duplicatePrintedCalibration.content), /clearances must be unique/i);
  const standardizedPrintedCalibration = await client.callTool({
    name: "plasticity_create_printed_thread_calibration_set",
    arguments: { ...printedCalibrationArguments, designation: "ISO 4017 M5x10" },
  });
  assert.equal(standardizedPrintedCalibration.isError, true);
  assert.match(JSON.stringify(standardizedPrintedCalibration.content), /must not name.*standard/i);
  const boltedJoint = await client.callTool({
    name: "plasticity_resolve_fastener_designation",
    arguments: { designation: "регулируемое крепление на 4 болта M5x10 с гайками" },
  });
  assert.equal(boltedJoint.isError, undefined);
  const boltedJointText = (boltedJoint.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const boltedJointResult = JSON.parse(boltedJointText ?? "null") as {
    jointIntent: string;
    interpretation: { quantity: number; jointIntentSource: string; mountingIntent: string };
    workflow: { compatibleTools: string[] };
  };
  assert.equal(boltedJointResult.jointIntent, "through-bolt-with-nut");
  assert.equal(boltedJointResult.interpretation.jointIntentSource, "designation-phrase");
  assert.equal(boltedJointResult.interpretation.quantity, 4);
  assert.equal(boltedJointResult.interpretation.mountingIntent, "adjustable");
  assert.ok(boltedJointResult.workflow.compatibleTools.includes("plasticity_create_slotted_hole_pattern"));
  const printedMatingPart = await client.callTool({
    name: "plasticity_resolve_fastener_designation",
    arguments: { designation: "нужна печать винта M6x20 и ответной части", mountingIntent: "fixed", analysisIntent: "geometry" },
  });
  assert.equal(printedMatingPart.isError, undefined);
  const printedMatingPartText = (printedMatingPart.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const printedMatingPartResult = JSON.parse(printedMatingPartText ?? "null") as {
    jointIntent: string;
    thread: { system: string; nominalDiameterMm: number; pitchMm?: number };
    workflow: { compatibleTools: string[] };
  };
  assert.equal(printedMatingPartResult.jointIntent, "printed-threaded-pair");
  assert.equal(printedMatingPartResult.thread.system, "custom-rounded-print");
  assert.equal(printedMatingPartResult.thread.nominalDiameterMm, 6);
  assert.equal(printedMatingPartResult.thread.pitchMm, undefined);
  assert.ok(printedMatingPartResult.workflow.compatibleTools.includes("plasticity_create_printed_external_thread"));
  assert.ok(printedMatingPartResult.workflow.compatibleTools.includes("plasticity_cut_printed_internal_thread"));
  const standardizedFastener = await client.callTool({
    name: "plasticity_resolve_fastener_designation",
    arguments: {
      designation: "винт ISO 14581 M5x10 с гайкой",
      mountingIntent: "fixed",
      analysisIntent: "geometry",
    },
  });
  assert.equal(standardizedFastener.isError, undefined);
  const standardizedFastenerText = (standardizedFastener.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const standardizedFastenerResult = JSON.parse(standardizedFastenerText ?? "null") as {
    form: string;
    headStyle: string;
    driveStyle: string;
    standard: { sourceUrl: string };
    workflow: { compatibleTools: string[] };
  };
  assert.equal(standardizedFastenerResult.form, "countersunk-screw");
  assert.equal(standardizedFastenerResult.headStyle, "countersunk");
  assert.equal(standardizedFastenerResult.driveStyle, "hexalobular-socket");
  assert.equal(standardizedFastenerResult.standard.sourceUrl, "https://www.iso.org/standard/78695.html");
  assert.ok(standardizedFastenerResult.workflow.compatibleTools.includes("plasticity_create_countersink"));
  const setScrew = await client.callTool({
    name: "plasticity_resolve_fastener_designation",
    arguments: {
      designation: "установочный винт ISO 4029 M5x10 в резьбовое отверстие в металле",
      mountingIntent: "fixed",
      analysisIntent: "geometry",
    },
  });
  assert.equal(setScrew.isError, undefined);
  const setScrewText = (setScrew.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const setScrewResult = JSON.parse(setScrewText ?? "null") as {
    form: string;
    headStyle: string;
    driveStyle: string;
    pointStyle: string;
    workflow: { route: string; compatibleTools: string[] };
    issues: Array<{ code: string }>;
  };
  assert.equal(setScrewResult.form, "set-screw");
  assert.equal(setScrewResult.headStyle, "headless");
  assert.equal(setScrewResult.driveStyle, "hexagon-socket");
  assert.equal(setScrewResult.pointStyle, "cup");
  assert.equal(setScrewResult.workflow.route, "tapped-metal");
  assert.ok(setScrewResult.workflow.compatibleTools.includes("plasticity_create_blind_hole"));
  assert.ok(setScrewResult.issues.some((issue) => issue.code === "SET_SCREW_TENSION_LIMITATION"));
  const stack = await client.callTool({
    name: "plasticity_check_fastener_stack",
    arguments: {
      designation: "болт ISO 4017 M5x10 с гайкой",
      lengthMeasurement: "under-head",
      gripItems: [{ id: "plate", thicknessMm: 8 }],
      receiver: { kind: "nut", nutThicknessMm: 4, minimumProtrusionMm: 1.6 },
    },
  });
  assert.equal(stack.isError, undefined);
  const stackText = (stack.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const stackResult = JSON.parse(stackText ?? "null") as { status: string; minimumRequiredLengthMm: number; issues: Array<{ code: string }> };
  assert.equal(stackResult.status, "fail");
  assert.equal(stackResult.minimumRequiredLengthMm, 13.6);
  assert.deepEqual(stackResult.issues.map((issue) => issue.code), ["FASTENER_TOO_SHORT"]);
  const invalidFastener = await client.callTool({
    name: "plasticity_resolve_fastener_designation",
    arguments: { designation: "M5x10", holeDiameterMm: 5 },
  });
  assert.equal(invalidFastener.isError, true);
  const invalidFastenerGroup = await client.callTool({
    name: "plasticity_inspect_fastener_group",
    arguments: {
      bodyId: 7,
      cylindricalFaceIds: ["f1", "f1"],
      frame: { originMm: [0, 0, 0], normal: [0, 0, 1], xDirection: [1, 0, 0] },
      revision: "r1",
    },
  });
  assert.equal(invalidFastenerGroup.isError, true);
  const duplicatePinPattern = await client.callTool({
    name: "plasticity_create_locating_pin_pair_pattern",
    arguments: {
      maleTargetId: 7,
      femaleTargetId: 8,
      baseCentersMm: [[0, 0, 0], [0, 0, 0]],
      axis: [0, 0, 1],
      pinDiameterMm: 4,
      pinHeightMm: 6,
      radialClearanceMm: 0.2,
      axialClearanceMm: 0.2,
      revision: "r1",
      intent: "Reject duplicate test centers before any Plasticity mutation",
    },
  });
  assert.equal(duplicatePinPattern.isError, true);
  const malformedSplitScrew = await client.callTool({
    name: "plasticity_create_split_screw_insert_joint",
    arguments: {
      maleTargetId: 7,
      femaleTargetId: 8,
      screwEntryCentersMm: [[0, 0, 0]],
      insertEntryCentersMm: [[0, 0, 8], [0, 0, 8]],
      axis: [0, 0, 1],
      fastenerDesignation: "ISO 4762 M5x12",
      screwLengthMm: 12,
      minimumEngagementMm: 3,
      maximumEngagementMm: 5,
      insertPartNumber: "qualified-test-insert",
      insertThreadNominalDiameterMm: 5,
      insertThreadPitchMm: 0.8,
      insertSourceUrl: "https://manufacturer.example/qualified-test-insert",
      holeDiameterMm: 5.3,
      maleThroughDepthMm: 8,
      pilotDiameterMm: 3,
      pilotDepthMm: 8,
      insertDiameterMm: 4.6,
      insertDepthMm: 6,
      leadInDiameterMm: 5.4,
      leadInDepthMm: 1,
      femaleMaterialDepthMm: 10,
      revision: "r1",
      intent: "Reject a mismatched split screw pattern before Plasticity mutation",
    },
  });
  assert.equal(malformedSplitScrew.isError, true);
  const incompatibleInsertThread = await client.callTool({
    name: "plasticity_create_split_screw_insert_joint",
    arguments: {
      maleTargetId: 7,
      femaleTargetId: 8,
      screwEntryCentersMm: [[0, 0, 0]],
      insertEntryCentersMm: [[0, 0, 8]],
      axis: [0, 0, 1],
      fastenerDesignation: "ISO 4762 M5x12",
      screwLengthMm: 12,
      minimumEngagementMm: 3,
      maximumEngagementMm: 5,
      insertPartNumber: "M5x1.0-test-insert",
      insertThreadNominalDiameterMm: 5,
      insertThreadPitchMm: 1,
      insertSourceUrl: "https://manufacturer.example/m5x1-test-insert",
      holeDiameterMm: 5.3,
      maleThroughDepthMm: 8,
      pilotDiameterMm: 3,
      pilotDepthMm: 8,
      insertDiameterMm: 4.6,
      insertDepthMm: 6,
      leadInDiameterMm: 5.4,
      leadInDepthMm: 1,
      femaleMaterialDepthMm: 10,
      revision: "r1",
      intent: "Reject a thread-pitch mismatch before Plasticity mutation",
    },
  });
  assert.equal(incompatibleInsertThread.isError, true);
  assert.match(JSON.stringify(incompatibleInsertThread.content), /diameter and pitch must exactly match/i);

  const windows = await client.callTool({ name: "plasticity_list_windows", arguments: {} });
  assert.equal(windows.isError, undefined);
  assert.match(JSON.stringify(windows.content), /window-1/);

  const invalid = await client.callTool({
    name: "plasticity_create_box",
    arguments: { originMm: [0, 0, 0], sizeMm: [80, -40, 8] },
  });
  assert.equal(invalid.isError, true);
  const invalidSplitPlane = await client.callTool({
    name: "plasticity_split_solid_by_plane",
    arguments: { targetId: 1, originMm: [0, 0, 0], normal: [1, 0, 0], xDirection: [-2, 0, 0], intent: "Test invalid split frame", revision: "r1" },
  });
  assert.equal(invalidSplitPlane.isError, true);
  const invalidSplitPlanes = await client.callTool({
    name: "plasticity_split_solid_by_planes",
    arguments: { targetId: 1, planes: [], intent: "Test empty split plane list", revision: "r1" },
  });
  assert.equal(invalidSplitPlanes.isError, true);
  const invalidBuildVolume = await client.callTool({
    name: "plasticity_split_solid_to_build_volume",
    arguments: { targetId: 1, usableBuildVolumeMm: [20, 0, 20], intent: "Test invalid build volume", revision: "r1" },
  });
  assert.equal(invalidBuildVolume.isError, true);
  const invalidRegions = await client.callTool({
    name: "plasticity_extrude_regions",
    arguments: { regionIds: [], distanceMm: 8, revision: "r1" },
  });
  assert.equal(invalidRegions.isError, true);
  const invalidOffset = await client.callTool({
    name: "plasticity_offset_planar_curves",
    arguments: { ids: [7], distanceMm: 0, revision: "r1" },
  });
  assert.equal(invalidOffset.isError, true);
  const invalidRegionOffset = await client.callTool({
    name: "plasticity_offset_regions",
    arguments: { regionIds: ["12r34"], offsetsMm: [0], revision: "r1" },
  });
  assert.equal(invalidRegionOffset.isError, true);
  const invalidTrim = await client.callTool({
    name: "plasticity_trim_curve_fragments",
    arguments: { fragmentIds: [], revision: "r1" },
  });
  assert.equal(invalidTrim.isError, true);
  const invalidExtend = await client.callTool({
    name: "plasticity_extend_curve_endpoints",
    arguments: { endpointIds: ["10v42"], distanceMm: 0, revision: "r1" },
  });
  assert.equal(invalidExtend.isError, true);
  const invalidCurveFillet = await client.callTool({
    name: "plasticity_fillet_curve_vertices",
    arguments: { vertices: [{ bodyId: 7, vertexId: 42 }, { bodyId: 7, vertexId: 42 }], radiusMm: 3, revision: "r1" },
  });
  assert.equal(invalidCurveFillet.isError, true);
  const invalidCurveVertexConversion = await client.callTool({
    name: "plasticity_convert_curve_vertices_to_control_points",
    arguments: { vertices: [{ bodyId: 7, vertexId: 42 }, { bodyId: 7, vertexId: 42 }], revision: "r1" },
  });
  assert.equal(invalidCurveVertexConversion.isError, true);
  const invalidClosedHollow = await client.callTool({
    name: "plasticity_hollow_solids",
    arguments: { ids: [7, 7], wallThicknessMm: 2, direction: "inward", revision: "r1" },
  });
  assert.equal(invalidClosedHollow.isError, true);
  const invalidBodyOutlines = await client.callTool({
    name: "plasticity_create_body_outlines",
    arguments: { ids: [7, 7], plane: { id: "standard:top", sessionId: "session", documentToken: "doc", revision: "r1" }, placement: "workplane", revision: "r1" },
  });
  assert.equal(invalidBodyOutlines.isError, true);
  const invalidCurvePattern = await client.callTool({
    name: "plasticity_curve_pattern",
    arguments: { ids: [7], spineId: 9, count: 1, revision: "r1" },
  });
  assert.equal(invalidCurvePattern.isError, true);
  const invalidProjection = await client.callTool({
    name: "plasticity_project_curves_onto_body",
    arguments: { targetId: 7, curveIds: [11], direction: [0, 0, 0], revision: "r1" },
  });
  assert.equal(invalidProjection.isError, true);
  const invalidBodyIntersection = await client.callTool({
    name: "plasticity_create_body_intersection_curves",
    arguments: { targetId: 7, toolIds: [], revision: "r1" },
  });
  assert.equal(invalidBodyIntersection.isError, true);
  const invalidCurvePair = await client.callTool({
    name: "plasticity_project_curve_pair",
    arguments: { firstId: 11, firstDirection: [0, 0, 1], secondId: 12, secondDirection: [0, 1, 0], projectionDepthMm: 0, revision: "r1" },
  });
  assert.equal(invalidCurvePair.isError, true);
  const invalidIsoparam = await client.callTool({
    name: "plasticity_insert_isoparam_edges",
    arguments: { face: { bodyId: 7, faceId: "f1" }, direction: "world-x", count: 3, revision: "r1" },
  });
  assert.equal(invalidIsoparam.isError, true);
  const invalidImprint = await client.callTool({
    name: "plasticity_imprint_curves_on_body",
    arguments: { targetId: 7, curveIds: [11], direction: [0, 0, 0], revision: "r1" },
  });
  assert.equal(invalidImprint.isError, true);
  const invalidPatch = await client.callTool({
    name: "plasticity_patch_regions",
    arguments: { regionIds: [], revision: "r1" },
  });
  assert.equal(invalidPatch.isError, true);
  const invalidJoin = await client.callTool({
    name: "plasticity_join_sheets",
    arguments: { ids: [7], revision: "r1" },
  });
  assert.equal(invalidJoin.isError, true);
  const invalidSurface = await client.callTool({
    name: "plasticity_create_constrained_surface",
    arguments: { pointsMm: [[0, 0, 0]], normals: [[0, 0, 1]], revision: "r1" },
  });
  assert.equal(invalidSurface.isError, true);
  const invalidExtract = await client.callTool({
    name: "plasticity_extract_faces",
    arguments: { faces: [], revision: "r1" },
  });
  assert.equal(invalidExtract.isError, true);
  const invalidUnwrap = await client.callTool({
    name: "plasticity_unwrap_face",
    arguments: { face: { bodyId: 0, faceId: "f1" }, revision: "r1" },
  });
  assert.equal(invalidUnwrap.isError, true);
  const invalidEdgeExtract = await client.callTool({
    name: "plasticity_extract_edges",
    arguments: { edges: [], revision: "r1" },
  });
  assert.equal(invalidEdgeExtract.isError, true);
  const invalidSolidify = await client.callTool({
    name: "plasticity_create_solid_from_sheet",
    arguments: { id: 0, revision: "r1" },
  });
  assert.equal(invalidSolidify.isError, true);
  const invalidShellUnjoin = await client.callTool({
    name: "plasticity_unjoin_shells",
    arguments: { ids: [7, 7], revision: "r1" },
  });
  assert.equal(invalidShellUnjoin.isError, true);
  const invalidSheetInsert = await client.callTool({
    name: "plasticity_insert_sheet",
    arguments: { targetSheetId: 7, edgeIds: ["e1"], fillSheetId: 7, intent: "invalid same body", revision: "r1" },
  });
  assert.equal(invalidSheetInsert.isError, true);
  const invalidDeleteFaces = await client.callTool({
    name: "plasticity_delete_faces",
    arguments: { faces: [], revision: "r1" },
  });
  assert.equal(invalidDeleteFaces.isError, true);
  const invalidSheetPatch = await client.callTool({
    name: "plasticity_patch_sheet_hole",
    arguments: { id: 7, edgeIds: ["e1", "e2"], revision: "r1" },
  });
  assert.equal(invalidSheetPatch.isError, true);
  const invalidSheetCap = await client.callTool({
    name: "plasticity_cap_sheet_holes",
    arguments: { ids: [], revision: "r1" },
  });
  assert.equal(invalidSheetCap.isError, true);
  const invalidCounterbore = await client.callTool({
    name: "plasticity_create_counterbore",
    arguments: {
      targetId: 7, entryCenterMm: [10, 10, 8], axis: [0, 0, -1],
      throughDiameterMm: 8, counterboreDiameterMm: 6,
      counterboreDepthMm: 3, throughDepthMm: 8, revision: "r1",
    },
  });
  assert.equal(invalidCounterbore.isError, true);
  const invalidCountersink = await client.callTool({
    name: "plasticity_create_countersink",
    arguments: {
      targetId: 7, entryCenterMm: [10, 10, 8], axis: [0, 0, -1], radialDirection: [1, 0, 0],
      throughDiameterMm: 6, countersinkMajorDiameterMm: 6, includedAngleDeg: 90,
      throughDepthMm: 8, revision: "r1",
    },
  });
  assert.equal(invalidCountersink.isError, true);
  const invalidCountersinkPattern = await client.callTool({
    name: "plasticity_create_countersink_pattern",
    arguments: {
      targetId: 7, entryCentersMm: [[10, 10, 8], [10, 10, 8]], axis: [0, 0, -1], radialDirection: [1, 0, 0],
      throughDiameterMm: 5.5, countersinkMajorDiameterMm: 10.4, includedAngleDeg: 90,
      throughDepthMm: 8, revision: "r1",
    },
  });
  assert.equal(invalidCountersinkPattern.isError, true);
  const invalidBlindHole = await client.callTool({
    name: "plasticity_create_blind_hole",
    arguments: {
      targetId: 7, entryCenterMm: [10, 10, 8], axis: [0, 0, -1],
      holeDiameterMm: 4.2, holeDepthMm: 8, materialDepthMm: 8, revision: "r1",
    },
  });
  assert.equal(invalidBlindHole.isError, true);
  const invalidBlindHolePattern = await client.callTool({
    name: "plasticity_create_blind_hole_pattern",
    arguments: {
      targetId: 7, entryCentersMm: [[10, 10, 8], [10, 10, 8]], axis: [0, 0, -1],
      holeDiameterMm: 4.2, holeDepthMm: 8, materialDepthMm: 8, revision: "r1",
    },
  });
  assert.equal(invalidBlindHolePattern.isError, true);
  const invalidThroughHolePattern = await client.callTool({
    name: "plasticity_create_through_hole_pattern",
    arguments: {
      targetId: 7, entryCentersMm: [[10, 10, 8], [10, 10, 8]], axis: [0, 0, -1],
      holeDiameterMm: 5.5, throughDepthMm: 8, revision: "r1",
    },
  });
  assert.equal(invalidThroughHolePattern.isError, true);
  const invalidCounterborePattern = await client.callTool({
    name: "plasticity_create_counterbore_pattern",
    arguments: {
      targetId: 7, entryCentersMm: [[10, 10, 8], [10, 10, 8]], axis: [0, 0, -1],
      throughDiameterMm: 4, counterboreDiameterMm: 8, counterboreDepthMm: 3,
      throughDepthMm: 8, revision: "r1",
    },
  });
  assert.equal(invalidCounterborePattern.isError, true);
  const invalidHexNutPocket = await client.callTool({
    name: "plasticity_create_hex_nut_pocket",
    arguments: {
      targetId: 7, entryCenterMm: [10, 10, 8], axis: [0, 0, -1], flatNormalDirection: [0, 0, 1],
      acrossFlatsMm: 8, pocketDepthMm: 4, materialDepthMm: 8, revision: "r1",
    },
  });
  assert.equal(invalidHexNutPocket.isError, true);
  const invalidHexNutPocketPattern = await client.callTool({
    name: "plasticity_create_hex_nut_pocket_pattern",
    arguments: {
      targetId: 7, entryCentersMm: [[10, 10, 8], [10, 10, 8]], axis: [0, 0, -1], flatNormalDirection: [1, 0, 0],
      acrossFlatsMm: 8, pocketDepthMm: 4, materialDepthMm: 8, revision: "r1",
    },
  });
  assert.equal(invalidHexNutPocketPattern.isError, true);
  const invalidSlottedHole = await client.callTool({
    name: "plasticity_create_slotted_hole",
    arguments: {
      targetId: 7, entryCenterMm: [10, 10, 8], axis: [0, 0, -1], slotDirection: [1, 0, 0],
      overallLengthMm: 6, widthMm: 6, throughDepthMm: 8, revision: "r1",
    },
  });
  assert.equal(invalidSlottedHole.isError, true);
  const invalidSlottedHolePattern = await client.callTool({
    name: "plasticity_create_slotted_hole_pattern",
    arguments: {
      targetId: 7, entryCentersMm: [[10, 10, 8], [10, 10, 8]], axis: [0, 0, -1], slotDirection: [1, 0, 0],
      overallLengthMm: 20, widthMm: 6, throughDepthMm: 8, revision: "r1",
    },
  });
  assert.equal(invalidSlottedHolePattern.isError, true);
  const invalidInsertPocket = await client.callTool({
    name: "plasticity_create_heat_set_insert_pocket",
    arguments: {
      targetId: 7, entryCenterMm: [10, 10, 8], axis: [0, 0, -1],
      pilotDiameterMm: 3, pilotDepthMm: 6,
      insertDiameterMm: 4.6, insertDepthMm: 6,
      leadInDiameterMm: 5.4, leadInDepthMm: 1, materialDepthMm: 12, revision: "r1",
    },
  });
  assert.equal(invalidInsertPocket.isError, true);
  const invalidInsertPocketPattern = await client.callTool({
    name: "plasticity_create_heat_set_insert_pocket_pattern",
    arguments: {
      targetId: 7, entryCentersMm: [[10, 10, 12], [10, 10, 12]], axis: [0, 0, -1],
      pilotDiameterMm: 3, pilotDepthMm: 8,
      insertDiameterMm: 4.6, insertDepthMm: 6,
      leadInDiameterMm: 5.4, leadInDepthMm: 1, materialDepthMm: 12, revision: "r1",
    },
  });
  assert.equal(invalidInsertPocketPattern.isError, true);
  const invalidScrewBoss = await client.callTool({
    name: "plasticity_create_screw_boss",
    arguments: {
      targetId: 7, baseCenterMm: [10, 10, 8], axis: [0, 0, 1],
      outerDiameterMm: 10, heightMm: 8,
      holeDiameterMm: 3, holeDepthMm: 9, revision: "r1",
    },
  });
  assert.equal(invalidScrewBoss.isError, true);
  const invalidScrewBossPattern = await client.callTool({
    name: "plasticity_create_screw_boss_pattern",
    arguments: {
      targetId: 7, baseCentersMm: [[10, 10, 8], [10, 10, 8]], axis: [0, 0, 1],
      outerDiameterMm: 10, heightMm: 8,
      holeDiameterMm: 3, holeDepthMm: 6, revision: "r1",
    },
  });
  assert.equal(invalidScrewBossPattern.isError, true);
  const invalidRib = await client.callTool({
    name: "plasticity_create_rib",
    arguments: {
      targetId: 7, profilePointsMm: [[0, 0, 0], [10, 0, 0], [0, 0, 10]],
      thicknessMm: 0, revision: "r1",
    },
  });
  assert.equal(invalidRib.isError, true);
  const invalidVentArray = await client.callTool({
    name: "plasticity_create_round_vent_array",
    arguments: {
      targetId: 7, firstCenterMm: [5, 5, 4], axis: [0, 0, -1],
      holeDiameterMm: 4, throughDepthMm: 4,
      direction1: [1, 0, 0], count1: 3, spacing1Mm: 4,
      direction2: [0, 1, 0], count2: 2, spacing2Mm: 8, revision: "r1",
    },
  });
  assert.equal(invalidVentArray.isError, true);
  const invalidSnapFit = await client.callTool({
    name: "plasticity_create_cantilever_snap_fit",
    arguments: {
      targetId: 7, baseCenterMm: [4, 10, 1],
      beamDirection: [1, 0, 0], thicknessDirection: [0, 0, 1],
      lengthMm: 20, widthMm: 6, thicknessMm: 2,
      hookLengthMm: 20, hookHeightMm: 4, revision: "r1",
    },
  });
  assert.equal(invalidSnapFit.isError, true);
  const invalidHinge = await client.callTool({
    name: "plasticity_create_hinge_barrel",
    arguments: {
      targetId: 7, axisStartMm: [20, 0, 10], axis: [0, 1, 0],
      lengthMm: 4, outerDiameterMm: 8, pinBoreDiameterMm: 8, revision: "r1",
    },
  });
  assert.equal(invalidHinge.isError, true);
  const invalidCableChannel = await client.callTool({
    name: "plasticity_cut_cable_channel",
    arguments: { targetId: 7, spineIds: [7], channelDiameterMm: 6, revision: "r1" },
  });
  assert.equal(invalidCableChannel.isError, true);
  const invalidConnectorOpening = await client.callTool({
    name: "plasticity_create_connector_opening",
    arguments: {
      targetId: 7, entryCenterMm: [10, 10, 10], axis: [0, 0, -1], widthDirection: [1, 0, 0],
      widthMm: 12, heightMm: 8, cornerRadiusMm: 4, throughDepthMm: 10, revision: "r1",
    },
  });
  assert.equal(invalidConnectorOpening.isError, true);
  const invalidMatingJoint = await client.callTool({
    name: "plasticity_create_mating_enclosure_joint",
    arguments: {
      maleTargetId: 7, femaleTargetId: 8, seamOriginMm: [0, 0, 10], outerWidthMm: 40, outerDepthMm: 30,
      wallThicknessMm: 2, lipThicknessMm: 1, lipHeightMm: 2, clearanceMm: 1, overlapMm: 1,
      revision: "r1",
    },
  });
  assert.equal(invalidMatingJoint.isError, true);
  const invalidLocatingPin = await client.callTool({
    name: "plasticity_create_locating_pin_pair",
    arguments: {
      maleTargetId: 7, femaleTargetId: 7, baseCenterMm: [10, 10, 10], axis: [0, 0, 1],
      pinDiameterMm: 5, pinHeightMm: 6, radialClearanceMm: 0.25, axialClearanceMm: 0.75,
      revision: "r1",
    },
  });
  assert.equal(invalidLocatingPin.isError, true);
  const invalidTongueGroove = await client.callTool({
    name: "plasticity_create_tongue_groove_joint",
    arguments: {
      tongueTargetId: 7, grooveTargetId: 7, baseCenterMm: [20, 15, 10], axis: [0, 0, 1], widthDirection: [1, 0, 0],
      tongueWidthMm: 12, tongueThicknessMm: 4, tongueHeightMm: 5,
      radialClearanceMm: 0.25, axialClearanceMm: 0.75, revision: "r1",
    },
  });
  assert.equal(invalidTongueGroove.isError, true);

  await client.close();
  await server.close();
});

test("Codex tool router catalogs and validates every registered operation", async () => {
  let state: RuntimeState = emptyState();
  let createBoxCalls = 0;
  const body: RuntimeState["bodies"][number] = {
    id: 42, versionId: 420, type: "Solid", name: "Routed box",
    boundsMm: { min: [0, 0, 0], max: [10, 20, 30] }, faceIds: [], edgeIds: [], faces: [], edges: [],
  };
  const operations = {
    async state() { return state; },
    async createBox() { createBoxCalls += 1; state = { ...state, revision: "r2", bodies: [body] }; return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "codex-tool-router-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const registered = await client.listTools();
  const router = registered.tools.find((tool) => tool.name === "plasticity_call");
  assert(router);
  assert.equal(registered.tools[0]?.name, "plasticity_call", "the fallback must stay visible to clients that cap large tool lists");
  assert.equal(router.annotations?.destructiveHint, true);
  assert.equal(router.annotations?.openWorldHint, true);
  const catalogResponse = await client.callTool({ name: "plasticity_call", arguments: {
    toolName: "catalog", query: "plasticity_create_box", limit: 1,
  } });
  assert.equal(catalogResponse.isError, undefined);
  const catalog = parseToolJson(catalogResponse);
  assert.equal(catalog.total, 1);
  assert.equal(catalog.tools[0]?.name, "plasticity_create_box");
  assert.equal(typeof catalog.tools[0]?.inputSchema, "object");
  assert.match(catalog.validationNote, /original server-side Zod schema is authoritative/i);

  const catalogNames = new Set<string>();
  let catalogOffset = 0;
  let catalogTotal = 0;
  do {
    const pageResponse = await client.callTool({ name: "plasticity_call", arguments: {
      toolName: "catalog", offset: catalogOffset, limit: 25,
    } });
    assert.equal(pageResponse.isError, undefined);
    const page = parseToolJson(pageResponse);
    catalogTotal = page.total;
    for (const item of page.tools as Array<{ name: string }>) catalogNames.add(item.name);
    catalogOffset = page.nextOffset ?? 0;
    if (page.nextOffset === null) break;
  } while (true);
  assert.equal(catalogTotal, registered.tools.length - 1);
  assert.equal(catalogNames.size, catalogTotal, "catalog pages must cover every registered operation without duplicates");

  const invalid = await client.callTool({ name: "plasticity_call", arguments: {
    toolName: "plasticity_create_box",
    arguments: { originMm: [0, 0, 0], sizeMm: [0, 20, 30], revision: "r1" },
  } });
  assert.equal(invalid.isError, true);
  assert.equal(createBoxCalls, 0, "the registered schema must reject invalid dimensions before invoking CAD");

  const valid = await client.callTool({ name: "plasticity_call", arguments: {
    toolName: "plasticity_create_box",
    arguments: { originMm: [0, 0, 0], sizeMm: [10, 20, 30], revision: "r1" },
  } });
  assert.equal(valid.isError, undefined);
  assert.equal(createBoxCalls, 1);
  assert.equal(state.bodies[0]?.id, 42);

  const directStrength = await client.callTool({ name: "plasticity_strength_methods", arguments: {} });
  const routedStrength = await client.callTool({ name: "plasticity_call", arguments: {
    toolName: "plasticity_strength_methods", arguments: {},
  } });
  assert.equal(routedStrength.isError, undefined);
  assert.deepEqual(parseToolJson(routedStrength), parseToolJson(directStrength));

  const unknown = await client.callTool({ name: "plasticity_call", arguments: { toolName: "not_a_registered_tool", arguments: {} } });
  assert.equal(unknown.isError, true);
  assert.equal(createBoxCalls, 1);
  await client.close(); await server.close();
});

test("compact catalog exposes core tools while routing hidden operations through their original handlers", async () => {
  let state: RuntimeState = emptyState();
  let createBoxCalls = 0;
  const operations = {
    async state() { return state; },
    async createBox() { createBoxCalls += 1; state = { ...state, revision: "r2" }; return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createCompactServer(fake, undefined, undefined, undefined, null);
  const client = new Client({ name: "compact-tool-catalog-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const listed = await client.listTools();
  assert.deepEqual(new Set(listed.tools.map((tool) => tool.name)), new Set([
    "plasticity_call", "plasticity_list_windows", "plasticity_connect", "plasticity_status",
    "plasticity_current_selection", "plasticity_list_bodies", "plasticity_body_info",
    "plasticity_capture_snapshot", "plasticity_changes_since", "plasticity_reconcile",
    "plasticity_screenshot",
  ]));
  assert.equal(listed.tools[0]?.name, "plasticity_call");

  const catalogResponse = await client.callTool({ name: "plasticity_call", arguments: {
    toolName: "catalog", query: "plasticity_create_box",
  } });
  assert.equal(catalogResponse.isError, undefined);
  const catalog = parseToolJson(catalogResponse);
  assert.equal(catalog.total, 1);
  assert.equal(catalog.tools[0]?.name, "plasticity_create_box");

  const invalid = await client.callTool({ name: "plasticity_call", arguments: {
    toolName: "plasticity_create_box",
    arguments: { originMm: [0, 0, 0], sizeMm: [0, 20, 30], revision: "r1" },
  } });
  assert.equal(invalid.isError, true);
  assert.equal(createBoxCalls, 0);
  const valid = await client.callTool({ name: "plasticity_call", arguments: {
    toolName: "plasticity_create_box",
    arguments: { originMm: [0, 0, 0], sizeMm: [10, 20, 30], revision: "r1" },
  } });
  assert.equal(valid.isError, undefined);
  assert.equal(createBoxCalls, 1);

  await client.close(); await server.close();
});

test("MCP persists and exactly matches physical printed-thread qualifications without a Plasticity connection", async () => {
  const fake = {
    async windows() { return []; },
    async connect() { return {}; },
    get() { throw new Error("not connected"); },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const root = await mkdtemp(join(tmpdir(), "plasticity-thread-qualification-mcp-"));
  const server = createServer(fake, undefined, new PrintedThreadQualificationStore(root));
  const client = new Client({ name: "thread-qualification-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const input = {
    process: {
      printerId: "creality-k1c-0.4", materialId: "generic-pla-k1c-0.4", slicingProfileId: "creality-print-k1c-0.20-standard",
      nozzleDiameterMm: 0.4, layerHeightMm: 0.2, orientation: "thread axes vertical", clearanceBasis: "physical ladder 2026-09-23",
    },
    thread: { profile: "rounded-print-v1", nominalCrestDiameterMm: 5, pitchMm: 1.25, threadDepthMm: 0.6, handedness: "right" },
    selectedSampleId: "clearance-0.15", profileClearanceMm: 0.15, fitClass: "normal",
    testedEngagementLengthMm: 12, cyclesCompleted: 20, testedAt: "2026-09-23T10:00:00.000Z",
    source: "physical-calibration-specimen", confirmedPhysicalTest: true,
  };
  const refused = await client.callTool({ name: "plasticity_record_printed_thread_qualification", arguments: { ...input, confirmedPhysicalTest: false } });
  assert.equal(refused.isError, true);
  const recorded = parseToolJson(await client.callTool({ name: "plasticity_record_printed_thread_qualification", arguments: input }));
  assert.equal(recorded.alreadyExisted, false);
  const repeated = parseToolJson(await client.callTool({ name: "plasticity_record_printed_thread_qualification", arguments: input }));
  assert.equal(repeated.alreadyExisted, true);
  assert.equal(repeated.record.id, recorded.record.id);
  const matched = parseToolJson(await client.callTool({ name: "plasticity_match_printed_thread_qualification", arguments: {
    process: input.process, thread: input.thread, requiredEngagementLengthMm: 8, fitClass: "normal",
  } }));
  assert.equal(matched.status, "matched");
  assert.equal(matched.selected.profileClearanceMm, 0.15);
  const wrongNozzle = parseToolJson(await client.callTool({ name: "plasticity_match_printed_thread_qualification", arguments: {
    process: { ...input.process, nozzleDiameterMm: 0.6 }, thread: input.thread, requiredEngagementLengthMm: 8, fitClass: "normal",
  } }));
  assert.equal(wrongNozzle.status, "no-match");
  const listed = parseToolJson(await client.callTool({ name: "plasticity_list_printed_thread_qualifications", arguments: { printerId: input.process.printerId } }));
  assert.equal(listed.records.length, 1);
  const pairArguments = {
    designation: "печатная пара M5x10", pitchMm: 1.25, threadDepthMm: 0.6, profileClearanceMm: 0.2,
    screwAxisStartMm: [0, 0, 0], nutEntryCenterMm: [15, 0, 0], axis: [0, 0, 1], flatNormalDirection: [1, 0, 0],
    screwHeadAcrossFlatsMm: 9, screwHeadHeightMm: 3, screwJunctionOverlapMm: 0.2,
    nutAcrossFlatsMm: 9, nutThicknessMm: 8, nutMinimumWallThicknessMm: 1.5,
    process: input.process, sizingBasis: "physical qualification binding test", qualificationId: recorded.record.id, revision: "r1",
  };
  const wrongClearance = await client.callTool({ name: "plasticity_create_printed_hex_pair", arguments: pairArguments });
  assert.equal(wrongClearance.isError, true);
  assert.match(JSON.stringify(wrongClearance.content), /qualification clearance 0\.15 mm.*requested 0\.2 mm/i);
  const acceptedQualification = await client.callTool({ name: "plasticity_create_printed_hex_pair", arguments: { ...pairArguments, profileClearanceMm: 0.15 } });
  assert.equal(acceptedQualification.isError, true);
  assert.match(JSON.stringify(acceptedQualification.content), /not connected/i);
  assert.doesNotMatch(JSON.stringify(acceptedQualification.content), /qualification.*does not match/i);

  await client.close(); await server.close();
});

test("MCP validates and forwards selected-face shelling parameters", async () => {
  let received: unknown[] | undefined;
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async hollowFaces(...arguments_: unknown[]) { received = arguments_; return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "hollow-faces-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const response = await client.callTool({ name: "plasticity_hollow_faces", arguments: {
    id: 8, faceIds: ["top-face"], wallThicknessMm: 2, direction: "inward", intent: "Create an open enclosure shell", revision: "r1",
  } });
  assert.equal(response.isError, undefined);
  assert.deepEqual(received, [8, ["top-face"], 2, "inward", "r1"]);
  const emptyFaces = await client.callTool({ name: "plasticity_hollow_faces", arguments: { id: 8, faceIds: [], wallThicknessMm: 2, revision: "r1" } });
  const zeroThickness = await client.callTool({ name: "plasticity_hollow_faces", arguments: { id: 8, faceIds: ["top-face"], wallThicknessMm: 0, revision: "r1" } });
  const missingRevision = await client.callTool({ name: "plasticity_hollow_faces", arguments: { id: 8, faceIds: ["top-face"], wallThicknessMm: 2 } });
  assert.equal(emptyFaces.isError, true);
  assert.equal(zeroThickness.isError, true);
  assert.equal(missingRevision.isError, true);
  await client.close(); await server.close();
});

test("MCP creates a sphere using millimeter center and radius inputs", async () => {
  let received: unknown[] | undefined;
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async createSphere(...arguments_: unknown[]) { received = arguments_; return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "sphere-tool-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const response = await client.callTool({ name: "plasticity_create_sphere", arguments: {
    centerMm: [12, -4, 8], radiusMm: 6.5, name: "Ball joint", intent: "Create spherical joint", revision: "r1",
  } });
  assert.equal(response.isError, undefined);
  assert.deepEqual(received, [[12, -4, 8], 6.5, "Ball joint", "r1"]);
  const zeroRadius = await client.callTool({ name: "plasticity_create_sphere", arguments: { centerMm: [0, 0, 0], radiusMm: 0, revision: "r1" } });
  const badCenter = await client.callTool({ name: "plasticity_create_sphere", arguments: { centerMm: [0, 0], radiusMm: 1, revision: "r1" } });
  const missingRevision = await client.callTool({ name: "plasticity_create_sphere", arguments: { centerMm: [0, 0, 0], radiusMm: 1 } });
  assert.equal(zeroRadius.isError, true);
  assert.equal(badCenter.isError, true);
  assert.equal(missingRevision.isError, true);
  await client.close(); await server.close();
});

test("MCP validates and forwards native 3MF export parameters", async () => {
  let received: unknown[] | undefined;
  const operations = {
    async export3mf(...args: unknown[]) {
      received = args;
      return { path: "/tmp/part.3mf", bytes: 1123, modelUnit: "meter", sourceUnits: "millimeter", objects: 1, buildItems: 1, vertices: 8, triangles: 12 };
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; },
    async connect() { return {}; },
    get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; },
    async changesSince() { return {}; },
    async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "3mf-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const response = await client.callTool({ name: "plasticity_export_3mf", arguments: {
      ids: [7], path: "/tmp/part.3mf", chordToleranceMm: 0.08, angleToleranceDegrees: 12, revision: "r1",
    } });
    assert.equal(response.isError, undefined);
    assert.deepEqual(received, [[7], "/tmp/part.3mf", "r1", 0.08, 12]);

    const invalid = await client.callTool({ name: "plasticity_export_3mf", arguments: {
      ids: [7], path: "/tmp/part.3mf", chordToleranceMm: 0, angleToleranceDegrees: 12, revision: "r1",
    } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
  }
});

test("MCP validates and forwards native OBJ export parameters", async () => {
  let received: unknown[] | undefined;
  const operations = {
    async exportObj(...args: unknown[]) {
      received = args;
      return { path: "/tmp/part.obj", bytes: 762, sourceUnits: "millimeter", upAxis: "z", objects: 1, vertices: 8, faces: 12, triangles: 12 };
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "obj-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const response = await client.callTool({ name: "plasticity_export_obj", arguments: {
      ids: [7], path: "/tmp/part.obj", chordToleranceMm: 0.08, angleToleranceDegrees: 12, revision: "r1",
    } });
    assert.equal(response.isError, undefined);
    assert.deepEqual(received, [[7], "/tmp/part.obj", "r1", 0.08, 12]);
    const invalid = await client.callTool({ name: "plasticity_export_obj", arguments: {
      ids: [7], path: "/tmp/part.obj", chordToleranceMm: 0, angleToleranceDegrees: 12, revision: "r1",
    } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close(); await server.close();
  }
});

test("MCP validates and forwards planar native Wire SVG exports", async () => {
  let received: unknown[] | undefined;
  const operations = {
    async exportSvg(...args: unknown[]) {
      received = args;
      return { path: "/tmp/rectangle.svg", bytes: 496, bodies: 1, lineSegments: 4, sourceUnits: "millimeter", boundsMm: { min: [0, -10], max: [20, 0], size: [20, 10] }, pageSizeMm: [20.2, 10.2] };
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "svg-export-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const response = await client.callTool({ name: "plasticity_export_svg", arguments: {
      ids: [7], path: "/tmp/rectangle.svg", revision: "r1",
    } });
    assert.equal(response.isError, undefined);
    assert.deepEqual(received, [[7], "/tmp/rectangle.svg", "r1", 0.05, 5]);
    const invalid = await client.callTool({ name: "plasticity_export_svg", arguments: {
      ids: [7, 7], path: "/tmp/rectangle.svg", revision: "r1",
    } });
    assert.equal(invalid.isError, true);
    const invalidTolerance = await client.callTool({ name: "plasticity_export_svg", arguments: {
      ids: [7], path: "/tmp/rectangle.svg", curveChordToleranceMm: 0, revision: "r1",
    } });
    assert.equal(invalidTolerance.isError, true);
  } finally {
    await client.close(); await server.close();
  }
});

test("MCP validates and forwards native hidden-line SVG export parameters", async () => {
  let received: unknown[] | undefined;
  const operations = {
    async exportHiddenLineSvg(...args: unknown[]) {
      received = args;
      return {
        path: "/tmp/plate-hiddenline.svg",
        bytes: 2_048,
        bodies: 1,
        segments: 12,
        visibleSegments: 10,
        hiddenSegments: 2,
        sourceUnits: "millimeter",
        projection: "native-orthographic",
        projectedBoundsMm: { min: [0, -40], max: [50, 0], size: [50, 40] },
        curveChordToleranceMm: 0.05,
        curveChordAngleDegrees: 5,
      };
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "hiddenline-svg-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const response = await client.callTool({ name: "plasticity_export_hiddenline_svg", arguments: {
      ids: [7], path: "/tmp/plate-hiddenline.svg", revision: "r1",
    } });
    assert.equal(response.isError, undefined);
    assert.deepEqual(received, [[7], "/tmp/plate-hiddenline.svg", "r1", 0.05, 5, 1]);
    const invalid = await client.callTool({ name: "plasticity_export_hiddenline_svg", arguments: {
      ids: [7, 7], path: "/tmp/plate-hiddenline.svg", revision: "r1",
    } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close(); await server.close();
  }
});

test("MCP validates and forwards native Parasolid export parameters", async () => {
  let received: unknown[] | undefined;
  const operations = {
    async exportParasolid(...args: unknown[]) {
      received = args;
      return { path: "/tmp/part.x_t", bytes: 4161, format: "parasolid-text" };
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; },
    async connect() { return {}; },
    get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; },
    async changesSince() { return {}; },
    async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "parasolid-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const response = await client.callTool({ name: "plasticity_export_parasolid", arguments: {
      ids: [7], path: "/tmp/part.x_t", revision: "r1",
    } });
    assert.equal(response.isError, undefined);
    assert.deepEqual(received, [[7], "/tmp/part.x_t", "r1"]);

    const invalid = await client.callTool({ name: "plasticity_export_parasolid", arguments: {
      ids: [], path: "/tmp/part.step", revision: "r1",
    } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
  }
});

test("MCP forwards a valid exact fastener-group inspection", async () => {
  const expected = {
    status: "verified",
    source: "native-brep-cylindrical-faces",
    reasons: [],
    fasteners: [
      { id: "f1", faceId: "f1", xMm: -10, yMm: 0, diameterMm: 6 },
      { id: "f2", faceId: "f2", xMm: 10, yMm: 0, diameterMm: 6 },
    ],
  };
  const fake = {
    async windows() { return []; },
    async connect() { return {}; },
    get() {
      return {
        async inspectFastenerGroup(request: unknown) {
          assert.deepEqual(request, {
            bodyId: 7,
            cylindricalFaceIds: ["f1", "f2"],
            frame: { originMm: [0, 0, 0], normal: [0, 0, 1], xDirection: [1, 0, 0] },
            revision: "r1",
          });
          return expected;
        },
      } as unknown as PlasticityOperations;
    },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; },
    async changesSince() { return {}; },
    async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "fastener-group-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const response = await client.callTool({
    name: "plasticity_inspect_fastener_group",
    arguments: {
      bodyId: 7,
      cylindricalFaceIds: ["f1", "f2"],
      frame: { originMm: [0, 0, 0], normal: [0, 0, 1], xDirection: [1, 0, 0] },
      revision: "r1",
    },
  });
  assert.equal(response.isError, undefined);
  const responseText = (response.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  assert(responseText);
  const parsed = JSON.parse(responseText) as typeof expected;
  assert.equal(parsed.source, "native-brep-cylindrical-faces");
  assert.equal(parsed.fasteners[1]?.xMm, 10);

  await client.close();
});

test("MCP forwards an exact fastener-group layout check with explicit envelope criteria", async () => {
  const expected = {
    status: "verified",
    measurementSource: "native-brep-boundary-and-cylindrical-faces",
    evaluation: { status: "pass", basis: "Manufacturer head and driver dimensions", failures: [] },
    reasons: [],
  };
  const fake = {
    async windows() { return []; },
    async connect() { return {}; },
    get() {
      return {
        async inspectFastenerGroupLayout(request: unknown) {
          assert.deepEqual(request, {
            bodyId: 7,
            boundaryFaceId: "top",
            cylindricalFaceIds: ["f1", "f2"],
            frame: { originMm: [0, 0, 8], normal: [0, 0, 1], xDirection: [1, 0, 0] },
            requirements: {
              basis: "Manufacturer head and driver dimensions",
              minimumHoleEdgeClearanceMm: 3,
              envelopes: [{ id: "driver", diameterMm: 12, minimumBoundaryClearanceMm: 0, minimumMutualClearanceMm: 0 }],
            },
            revision: "r1",
          });
          return expected;
        },
      } as unknown as PlasticityOperations;
    },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; },
    async changesSince() { return {}; },
    async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "fastener-group-layout-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const response = await client.callTool({
    name: "plasticity_check_fastener_group_layout",
    arguments: {
      bodyId: 7,
      boundaryFaceId: "top",
      cylindricalFaceIds: ["f1", "f2"],
      frame: { originMm: [0, 0, 8], normal: [0, 0, 1], xDirection: [1, 0, 0] },
      requirements: {
        basis: "Manufacturer head and driver dimensions",
        minimumHoleEdgeClearanceMm: 3,
        envelopes: [{ id: "driver", diameterMm: 12 }],
      },
      revision: "r1",
    },
  });
  assert.equal(response.isError, undefined);
  const responseText = (response.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  assert(responseText);
  assert.deepEqual(JSON.parse(responseText), expected);

  await client.close();
});

test("MCP forwards exact topology measurement requests", async () => {
  const calls: Array<{ name: string; arguments: unknown[] }> = [];
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async measurePointDistance(...arguments_: unknown[]) {
      calls.push({ name: "points", arguments: arguments_ });
      return { distanceMm: 13, deltaMm: [3, 4, 12], measurementSource: "native-brep" };
    },
    async measurePointToLinearEdge(...arguments_: unknown[]) {
      calls.push({ name: "point-edge", arguments: arguments_ });
      return { finiteSegmentDistanceMm: 2, closestPointMm: [5, 0, 0], measurementSource: "native-brep-and-explicit-coordinates" };
    },
    async measurePointToSampledCurveEdge(...arguments_: unknown[]) {
      calls.push({ name: "point-curved-edge", arguments: arguments_ });
      return { exact: false, estimatedDistanceMm: 1, measurementSource: "native-brep-sampled-polyline" };
    },
    async measurePointToCircularEdge(...arguments_: unknown[]) {
      calls.push({ name: "point-circle", arguments: arguments_ });
      return { finiteArcDistanceMm: 4, closestPointMm: [0, 5, 0], measurementSource: "native-brep-and-explicit-coordinates" };
    },
    async measurePointToPlanarFace(...arguments_: unknown[]) {
      calls.push({ name: "point-face", arguments: arguments_ });
      return { minimumDistanceMm: 3, closestPointMm: [1, 1, 0], measurementSource: "native-brep-and-explicit-coordinates" };
    },
    async measurePlanarFaces(...arguments_: unknown[]) {
      calls.push({ name: "faces", arguments: arguments_ });
      return { separationMm: 8, planeAngleDeg: 0, measurementSource: "native-brep" };
    },
    async measureParallelPlanarFaceClearance(...arguments_: unknown[]) {
      calls.push({ name: "trimmed-face-clearance", arguments: arguments_ });
      return { minimumDistanceMm: 5, inPlaneClearanceMm: 3, exact: true, measurementSource: "native-brep" };
    },
    async measureNonparallelPlanarPolygonFaceClearance(...arguments_: unknown[]) {
      calls.push({ name: "nonparallel-face-clearance", arguments: arguments_ });
      return { minimumDistanceMm: 2, method: "nonparallel-planar-polygon-regions", exact: true, measurementSource: "native-brep" };
    },
    async measureLinearEdges(...arguments_: unknown[]) {
      calls.push({ name: "edges", arguments: arguments_ });
      return { supportingLineDistanceMm: 3, lineAngleDeg: 0, measurementSource: "native-brep" };
    },
    async measureFastenerGripStack(...arguments_: unknown[]) {
      calls.push({ name: "grip", arguments: arguments_ });
      return { totalGripMm: 8, gripItems: [{ id: "plate", thicknessMm: 8 }], measurementSource: "native-brep-planar-faces" };
    },
    async analyzeSurfaceContinuity(...arguments_: unknown[]) {
      calls.push({ name: "continuity", arguments: arguments_ });
      return { documentToken: "doc-1", revision: "r1", analyses: [] };
    },
    async analyzeEdgeCurvature(...arguments_: unknown[]) {
      calls.push({ name: "curvature", arguments: arguments_ });
      return { documentToken: "doc-1", revision: "r1", analyses: [] };
    },
    async analyzeFaceDraft(...arguments_: unknown[]) {
      calls.push({ name: "draft", arguments: arguments_ });
      return { documentToken: "doc-1", revision: "r1", analyses: [] };
    },
    async listMeasurements(...arguments_: unknown[]) {
      calls.push({ name: "list", arguments: arguments_ });
      return { documentToken: "doc-1", revision: "r1", measurements: [] };
    },
    async createVertexDistanceMeasurement(...arguments_: unknown[]) {
      calls.push({ name: "create-persistent", arguments: arguments_ });
      return state;
    },
    async createTopologyDistanceMeasurement(...arguments_: unknown[]) {
      calls.push({ name: "create-topology-distance", arguments: arguments_ });
      return state;
    },
    async createRadiusMeasurement(...arguments_: unknown[]) {
      calls.push({ name: "create-radius", arguments: arguments_ });
      return state;
    },
    async deleteMeasurement(...arguments_: unknown[]) {
      calls.push({ name: "delete-persistent", arguments: arguments_ });
      return state;
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "measurement-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const points = await client.callTool({ name: "plasticity_measure_point_distance", arguments: {
    first: { type: "vertex", bodyId: 7, vertexId: 101 },
    second: { type: "coordinates", pointMm: [3, 4, 12] },
    revision: "r1",
  } });
  const pointEdge = await client.callTool({ name: "plasticity_measure_point_to_linear_edge", arguments: {
    point: { type: "coordinates", pointMm: [5, 2, 0] },
    edge: { bodyId: 7, edgeId: "left" }, revision: "r1",
  } });
  const pointCurvedEdge = await client.callTool({ name: "plasticity_measure_point_to_curved_edge", arguments: {
    point: { type: "coordinates", pointMm: [5, 4, 0] },
    edge: { bodyId: 7, edgeId: "spline" }, requestedToleranceMm: 0.005, maxSegments: 1024, revision: "r1",
  } });
  const pointCurvedWire = await client.callTool({ name: "plasticity_measure_point_to_curved_edge", arguments: {
    point: { type: "coordinates", pointMm: [5, 4, 0] },
    edge: { bodyId: 8, segmentEntityId: 801 }, requestedToleranceMm: 0.02, maxSegments: 512, revision: "r1",
  } });
  const pointCircle = await client.callTool({ name: "plasticity_measure_point_to_circular_edge", arguments: {
    point: { type: "coordinates", pointMm: [0, 10, 0] },
    edge: { bodyId: 7, edgeId: "circle-edge" }, revision: "r1",
  } });
  const pointWireCircle = await client.callTool({ name: "plasticity_measure_point_to_circular_edge", arguments: {
    point: { type: "coordinates", pointMm: [0, 10, 0] },
    edge: { bodyId: 8, segmentEntityId: 801 }, revision: "r1",
  } });
  const pointFace = await client.callTool({ name: "plasticity_measure_point_to_planar_face", arguments: {
    point: { type: "coordinates", pointMm: [1, 1, 3] },
    face: { bodyId: 7, faceId: "top" }, revision: "r1",
  } });
  const faces = await client.callTool({ name: "plasticity_measure_planar_faces", arguments: {
    first: { bodyId: 7, faceId: "bottom" }, second: { bodyId: 7, faceId: "top" }, revision: "r1",
  } });
  const faceClearance = await client.callTool({ name: "plasticity_measure_parallel_planar_face_clearance", arguments: {
    first: { bodyId: 7, faceId: "bottom" }, second: { bodyId: 8, faceId: "side" }, revision: "r1",
  } });
  const nonparallelFaceClearance = await client.callTool({ name: "plasticity_measure_nonparallel_planar_polygon_clearance", arguments: {
    first: { bodyId: 7, faceId: "bottom" }, second: { bodyId: 8, faceId: "side" }, revision: "r1",
  } });
  const edges = await client.callTool({ name: "plasticity_measure_linear_edges", arguments: {
    first: { bodyId: 7, edgeId: "left" }, second: { bodyId: 7, edgeId: "right" }, angularToleranceDeg: 0.1, revision: "r1",
  } });
  const grip = await client.callTool({ name: "plasticity_measure_fastener_grip_stack", arguments: {
    layers: [{ id: "plate", first: { bodyId: 7, faceId: "bottom" }, second: { bodyId: 7, faceId: "top" } }],
    axis: [0, 0, 1], revision: "r1",
  } });
  const continuity = await client.callTool({ name: "plasticity_analyze_surface_continuity", arguments: {
    edges: [{ bodyId: 7, edgeId: "shared" }], positionToleranceMm: 0.02,
    normalAngleToleranceDeg: 0.2, relativeCurvatureTolerance: 0.1, revision: "r1",
  } });
  const curvature = await client.callTool({ name: "plasticity_analyze_edge_curvature", arguments: {
    edges: [{ bodyId: 8, edgeId: "circle" }], revision: "r1",
  } });
  const draft = await client.callTool({ name: "plasticity_analyze_face_draft", arguments: {
    faces: [{ bodyId: 7, faceId: "top" }], pullDirection: [0, 0, 2],
    minimumDraftDeg: 3, samplesPerDirection: 6, revision: "r1",
  } });
  const listed = await client.callTool({ name: "plasticity_list_measurements", arguments: {} });
  const created = await client.callTool({ name: "plasticity_create_vertex_distance_measurement", arguments: {
    first: { bodyId: 7, vertexId: 101 }, second: { bodyId: 7, vertexId: 102 }, name: "Overall width", revision: "r1",
  } });
  const createdTopologyDistance = await client.callTool({ name: "plasticity_create_topology_distance_measurement", arguments: {
    first: { type: "face-center", bodyId: 7, faceId: "bottom" },
    second: { type: "edge-midpoint", bodyId: 7, edgeId: "right" },
    name: "Face to edge", revision: "r1",
  } });
  const createdRadius = await client.callTool({ name: "plasticity_create_radius_measurement", arguments: {
    edge: { bodyId: 8, segmentEntityId: 801 }, name: "Guide radius", revision: "r1",
  } });
  const deleted = await client.callTool({ name: "plasticity_delete_measurement", arguments: { id: 3, revision: "r1" } });

  assert.equal(points.isError, undefined);
  assert.equal(pointEdge.isError, undefined);
  assert.equal(pointCurvedEdge.isError, undefined);
  assert.equal(pointCurvedWire.isError, undefined);
  assert.equal(pointCircle.isError, undefined);
  assert.equal(pointWireCircle.isError, undefined);
  assert.equal(pointFace.isError, undefined);
  assert.equal(faces.isError, undefined);
  assert.equal(faceClearance.isError, undefined);
  assert.equal(nonparallelFaceClearance.isError, undefined);
  assert.equal(edges.isError, undefined);
  assert.equal(grip.isError, undefined);
  assert.equal(continuity.isError, undefined);
  assert.equal(curvature.isError, undefined);
  assert.equal(draft.isError, undefined);
  assert.equal(listed.isError, undefined);
  assert.equal(created.isError, undefined);
  assert.equal(createdTopologyDistance.isError, undefined);
  assert.equal(createdRadius.isError, undefined);
  assert.equal(deleted.isError, undefined);
  assert.deepEqual(calls, [
    { name: "points", arguments: [{ type: "vertex", bodyId: 7, vertexId: 101 }, { type: "coordinates", pointMm: [3, 4, 12] }, "r1"] },
    { name: "point-edge", arguments: [{ type: "coordinates", pointMm: [5, 2, 0] }, { bodyId: 7, edgeId: "left" }, "r1"] },
    { name: "point-curved-edge", arguments: [{ type: "coordinates", pointMm: [5, 4, 0] }, { bodyId: 7, edgeId: "spline" }, "r1", 0.005, 1024] },
    { name: "point-curved-edge", arguments: [{ type: "coordinates", pointMm: [5, 4, 0] }, { bodyId: 8, segmentEntityId: 801 }, "r1", 0.02, 512] },
    { name: "point-circle", arguments: [{ type: "coordinates", pointMm: [0, 10, 0] }, { bodyId: 7, edgeId: "circle-edge" }, "r1"] },
    { name: "point-circle", arguments: [{ type: "coordinates", pointMm: [0, 10, 0] }, { bodyId: 8, segmentEntityId: 801 }, "r1"] },
    { name: "point-face", arguments: [{ type: "coordinates", pointMm: [1, 1, 3] }, { bodyId: 7, faceId: "top" }, "r1"] },
    { name: "faces", arguments: [{ bodyId: 7, faceId: "bottom" }, { bodyId: 7, faceId: "top" }, "r1", 0.01] },
    { name: "trimmed-face-clearance", arguments: [{ bodyId: 7, faceId: "bottom" }, { bodyId: 8, faceId: "side" }, "r1"] },
    { name: "nonparallel-face-clearance", arguments: [{ bodyId: 7, faceId: "bottom" }, { bodyId: 8, faceId: "side" }, "r1"] },
    { name: "edges", arguments: [{ bodyId: 7, edgeId: "left" }, { bodyId: 7, edgeId: "right" }, "r1", 0.1] },
    { name: "grip", arguments: [[{ id: "plate", first: { bodyId: 7, faceId: "bottom" }, second: { bodyId: 7, faceId: "top" } }], [0, 0, 1], "r1", 0.01] },
    { name: "continuity", arguments: [[{ bodyId: 7, edgeId: "shared" }], "r1", 0.02, 0.2, 0.1] },
    { name: "curvature", arguments: [[{ bodyId: 8, edgeId: "circle" }], "r1"] },
    { name: "draft", arguments: [[{ bodyId: 7, faceId: "top" }], [0, 0, 2], 3, 6, "r1"] },
    { name: "list", arguments: [] },
    { name: "create-persistent", arguments: [{ bodyId: 7, vertexId: 101 }, { bodyId: 7, vertexId: 102 }, "Overall width", "r1"] },
    { name: "create-topology-distance", arguments: [{ type: "face-center", bodyId: 7, faceId: "bottom" }, { type: "edge-midpoint", bodyId: 7, edgeId: "right" }, "Face to edge", "r1"] },
    { name: "create-radius", arguments: [{ bodyId: 8, segmentEntityId: 801 }, "Guide radius", "r1"] },
    { name: "delete-persistent", arguments: [3, "r1"] },
  ]);

  const invalid = await client.callTool({ name: "plasticity_measure_point_distance", arguments: {
    first: { type: "vertex", bodyId: 7, vertexId: -1 },
    second: { type: "coordinates", pointMm: [0, 0, 0] },
    revision: "r1",
  } });
  assert.equal(invalid.isError, true);
  await client.close(); await server.close();
});

test("MCP forwards native section-analysis requests", async () => {
  const calls: Array<{ name: string; arguments: unknown[] }> = [];
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async listSectionAnalyses(...arguments_: unknown[]) { calls.push({ name: "list-sections", arguments: arguments_ }); return { documentToken: "doc-1", revision: "r1", sectionAnalyses: [] }; },
    async createSectionAnalysis(...arguments_: unknown[]) { calls.push({ name: "create-section", arguments: arguments_ }); return state; },
    async deleteSectionAnalysis(...arguments_: unknown[]) { calls.push({ name: "delete-section", arguments: arguments_ }); return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "section-analysis-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const listed = await client.callTool({ name: "plasticity_list_section_analyses", arguments: {} });
  const created = await client.callTool({ name: "plasticity_create_section_analysis", arguments: {
    originMm: [0, 0, 5], normal: [0, 0, 1], name: "Mid section", revision: "r1",
  } });
  const deleted = await client.callTool({ name: "plasticity_delete_section_analysis", arguments: { id: 3, revision: "r1" } });

  assert.equal(listed.isError, undefined);
  assert.equal(created.isError, undefined);
  assert.equal(deleted.isError, undefined);
  assert.deepEqual(calls, [
    { name: "list-sections", arguments: [] },
    { name: "create-section", arguments: [[0, 0, 5], [0, 0, 1], undefined, "Mid section", "r1"] },
    { name: "delete-section", arguments: [3, "r1"] },
  ]);
  await client.close(); await server.close();
});

test("MCP forwards native linked-instance requests and validates instance identities", async () => {
  const calls: Array<{ name: string; arguments: unknown[] }> = [];
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async listInstances(...arguments_: unknown[]) {
      calls.push({ name: "list", arguments: arguments_ });
      return { documentToken: state.documentToken, revision: state.revision, instances: [] };
    },
    async createInstance(...arguments_: unknown[]) { calls.push({ name: "create", arguments: arguments_ }); return state; },
    async duplicateBodies(...arguments_: unknown[]) { calls.push({ name: "duplicate-bodies", arguments: arguments_ }); return state; },
    async moveInstances(...arguments_: unknown[]) { calls.push({ name: "move", arguments: arguments_ }); return state; },
    async rotateInstances(...arguments_: unknown[]) { calls.push({ name: "rotate", arguments: arguments_ }); return state; },
    async scaleInstances(...arguments_: unknown[]) { calls.push({ name: "scale", arguments: arguments_ }); return state; },
    async realizeInstances(...arguments_: unknown[]) { calls.push({ name: "realize", arguments: arguments_ }); return state; },
    async deleteInstances(...arguments_: unknown[]) { calls.push({ name: "delete", arguments: arguments_ }); return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "instance-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const responses = await Promise.all([
    client.callTool({ name: "plasticity_list_instances", arguments: {} }),
    client.callTool({ name: "plasticity_create_instance", arguments: { bodyId: 7, revision: "r1" } }),
    client.callTool({ name: "plasticity_duplicate_bodies", arguments: { ids: [7, 8], translationMm: [0, 30, 0], revision: "r1" } }),
    client.callTool({ name: "plasticity_move_instances", arguments: { ids: [0], deltaMm: [5, 0, 0], revision: "r1" } }),
    client.callTool({ name: "plasticity_rotate_instances", arguments: { ids: [0], pivotMm: [30, 0, 0], axis: [0, 0, 1], degrees: 90, revision: "r1" } }),
    client.callTool({ name: "plasticity_scale_instances", arguments: { ids: [0], pivotMm: [30, 0, 0], factors: [2, 1, 1], revision: "r1" } }),
    client.callTool({ name: "plasticity_realize_instances", arguments: { ids: [0], revision: "r1" } }),
    client.callTool({ name: "plasticity_delete_instances", arguments: { ids: [0], revision: "r1" } }),
  ]);
  assert(responses.every((response) => response.isError === undefined));
  assert.deepEqual(calls, [
    { name: "list", arguments: [] },
    { name: "create", arguments: [7, [0, 0, 0], "r1"] },
    { name: "duplicate-bodies", arguments: [[7, 8], [0, 30, 0], "r1"] },
    { name: "move", arguments: [[0], [5, 0, 0], "r1"] },
    { name: "rotate", arguments: [[0], [30, 0, 0], [0, 0, 1], 90, "r1"] },
    { name: "scale", arguments: [[0], [30, 0, 0], [2, 1, 1], "r1"] },
    { name: "realize", arguments: [[0], "r1"] },
    { name: "delete", arguments: [[0], "r1"] },
  ]);

  const negative = await client.callTool({ name: "plasticity_move_instances", arguments: { ids: [-1], deltaMm: [1, 0, 0], revision: "r1" } });
  const duplicate = await client.callTool({ name: "plasticity_delete_instances", arguments: { ids: [0, 0], revision: "r1" } });
  const duplicateBodies = await client.callTool({ name: "plasticity_duplicate_bodies", arguments: { ids: [7, 7], revision: "r1" } });
  assert.equal(negative.isError, true);
  assert.equal(duplicate.isError, true);
  assert.equal(duplicateBodies.isError, true);
  await client.close(); await server.close();
});

test("MCP forwards approximate reference-mesh import, selection, rename, transforms, and deletion", async () => {
  const calls: Array<{ name: string; arguments: unknown[] }> = [];
  const state = emptyState();
  const selection = {
    documentToken: state.documentToken, revision: state.revision, bodyIds: [], instanceIds: [], referenceMeshIds: [0],
    groupIds: [], faces: [], edges: [], regionIds: [], curveControlPoints: [],
  };
  const operations = {
    async state() { return state; },
    async listReferenceMeshes(...arguments_: unknown[]) {
      calls.push({ name: "list", arguments: arguments_ });
      return { documentToken: state.documentToken, revision: state.revision, referenceMeshes: [] };
    },
    async selectReferenceMeshes(...arguments_: unknown[]) { calls.push({ name: "select", arguments: arguments_ }); return selection; },
    async importReferenceMesh(...arguments_: unknown[]) { calls.push({ name: "import", arguments: arguments_ }); return state; },
    async moveReferenceMeshes(...arguments_: unknown[]) { calls.push({ name: "move", arguments: arguments_ }); return state; },
    async rotateReferenceMeshes(...arguments_: unknown[]) { calls.push({ name: "rotate", arguments: arguments_ }); return state; },
    async scaleReferenceMeshes(...arguments_: unknown[]) { calls.push({ name: "scale", arguments: arguments_ }); return state; },
    async renameReferenceMesh(...arguments_: unknown[]) { calls.push({ name: "rename", arguments: arguments_ }); return state; },
    async deleteReferenceMeshes(...arguments_: unknown[]) { calls.push({ name: "delete", arguments: arguments_ }); return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "reference-mesh-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const responses = await Promise.all([
    client.callTool({ name: "plasticity_list_reference_meshes", arguments: {} }),
    client.callTool({ name: "plasticity_select_reference_meshes", arguments: { ids: [0], revision: "r1" } }),
    client.callTool({ name: "plasticity_import_reference_mesh", arguments: { path: "/tmp/phone.stl", sourceUnit: "millimeter", revision: "r1" } }),
    client.callTool({ name: "plasticity_move_reference_meshes", arguments: { ids: [0], deltaMm: [5, 0, 0], revision: "r1" } }),
    client.callTool({ name: "plasticity_rotate_reference_meshes", arguments: { ids: [0], pivotMm: [0, 0, 0], axis: [0, 0, 1], degrees: 90, revision: "r1" } }),
    client.callTool({ name: "plasticity_scale_reference_meshes", arguments: { ids: [0], pivotMm: [0, 0, 0], factors: [2, 1, 1], revision: "r1" } }),
    client.callTool({ name: "plasticity_rename_reference_mesh", arguments: { id: 0, name: "Phone envelope", revision: "r1" } }),
    client.callTool({ name: "plasticity_delete_reference_meshes", arguments: { ids: [0], revision: "r1" } }),
  ]);
  assert(responses.every((response) => response.isError === undefined));
  assert.deepEqual(calls, [
    { name: "list", arguments: [] },
    { name: "select", arguments: [[0], "r1"] },
    { name: "import", arguments: ["/tmp/phone.stl", "millimeter", "r1"] },
    { name: "move", arguments: [[0], [5, 0, 0], "r1"] },
    { name: "rotate", arguments: [[0], [0, 0, 0], [0, 0, 1], 90, "r1"] },
    { name: "scale", arguments: [[0], [0, 0, 0], [2, 1, 1], "r1"] },
    { name: "rename", arguments: [0, "Phone envelope", "r1"] },
    { name: "delete", arguments: [[0], "r1"] },
  ]);

  const duplicate = await client.callTool({ name: "plasticity_move_reference_meshes", arguments: { ids: [0, 0], deltaMm: [1, 0, 0], revision: "r1" } });
  const negative = await client.callTool({ name: "plasticity_delete_reference_meshes", arguments: { ids: [-1], revision: "r1" } });
  const zeroScale = await client.callTool({ name: "plasticity_scale_reference_meshes", arguments: { ids: [0], pivotMm: [0, 0, 0], factors: [1, 0, 1], revision: "r1" } });
  const badUnit = await client.callTool({ name: "plasticity_import_reference_mesh", arguments: { path: "/tmp/phone.stl", sourceUnit: "parsec", revision: "r1" } });
  assert.equal(duplicate.isError, true);
  assert.equal(negative.isError, true);
  assert.equal(zeroScale.isError, true);
  assert.equal(badUnit.isError, true);
  await client.close(); await server.close();
});

test("MCP imports a local 3MF as approximate reference geometry and journals redacted provenance", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-reference-3mf-mcp-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "reference.3mf");
  await writeFile(path, "fixture 3MF payload");
  let state: RuntimeState = { ...emptyState(), referenceMeshes: [] };
  const importedMesh: NonNullable<RuntimeState["referenceMeshes"]>[number] = {
    id: 42, type: "ReferenceMesh", name: "Device reference", sourcePath: path, sourceFormat: "3mf",
    measurementSource: "reference-mesh", boundsMm: { min: [0, 0, 0], max: [10, 20, 3] },
    translationMm: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1], sceneScaleToMeters: [0.001, 0.001, 0.001],
    vertexEntries: 8, triangles: 12, visible: true, hidden: false, locked: false,
  };
  const operations = {
    async state() { return state; },
    async importReference3mf(inputPath: string, revision: string) {
      assert.equal(inputPath, path);
      assert.equal(revision, "r1");
      state = { ...state, revision: "r2", referenceMeshes: [importedMesh] };
      return state;
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const references = new StepImportReferenceStore(join(root, "references"));
  const server = createPlasticityServer(fake, undefined, undefined, references, new ConstructionHistoryStore(join(root, "history")));
  const client = new Client({ name: "reference-3mf-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const response = await client.callTool({
    name: "plasticity_import_reference_3mf",
    arguments: {
      path,
      source: {
        sourceKind: "official-manufacturer-cad", sourceUrl: "https://vendor.example/device.3mf?token=private",
        sourcePageUrl: "https://vendor.example/device?session=private", license: "CC BY 4.0", confidence: "verified",
      },
      intent: "Use as approximate envelope reference", revision: "r1",
    },
  });
  assert.equal(response.isError, undefined);
  const output = JSON.parse((response.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "{}");
  assert.equal(output.approximateReference, true);
  assert.equal(output.measurementSource, "reference-mesh");
  assert.equal(output.referenceArtifactHash, createHash("sha256").update("fixture 3MF payload").digest("hex"));
  assert.equal(output.importedMeshes[0].sourceFormat, "3mf");
  assert.deepEqual(output.importedMeshes[0].boundsMm.max, [10, 20, 3]);
  assert.equal(output.sourceReference.unitSource, "embedded-3mf-model-metadata");
  assert.equal(output.provenancePersisted, true);
  assert.match(output.referenceRecordId, /^[0-9a-f-]{36}$/);
  assert.doesNotMatch(JSON.stringify(output), /token=private|session=private/);
  const persisted = await references.get(output.referenceRecordId);
  assert.equal(persisted.format, "3mf");
  assert.equal(persisted.documentToken, state.documentToken);
  assert.equal(persisted.revision, state.revision);
  assert.deepEqual(persisted.referenceMeshes?.map(({ id, boundsMm }) => ({ id, boundsMm })), [{ id: 42, boundsMm: importedMesh.boundsMm }]);
  await client.close();
  await server.close();
});

test("download-and-import 3MF checks identity before network, hashes the artifact, and keeps provenance approximate", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-reference-3mf-download-mcp-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "downloaded.3mf");
  const contents = Buffer.from("validated 3MF fixture");
  await writeFile(path, contents);
  const expectedHash = createHash("sha256").update(contents).digest("hex");
  let state: RuntimeState = { ...emptyState(), referenceMeshes: [] };
  let downloadCount = 0;
  let importedPath = "";
  const mesh: NonNullable<RuntimeState["referenceMeshes"]>[number] = {
    id: 73, type: "ReferenceMesh", name: "Downloaded 3MF", sourcePath: path, sourceFormat: "3mf",
    measurementSource: "reference-mesh", boundsMm: { min: [0, 0, 0], max: [4, 4, 4] },
    translationMm: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1], sceneScaleToMeters: [0.001, 0.001, 0.001],
    vertexEntries: 8, triangles: 12, visible: true, hidden: false, locked: false,
  };
  const operations = {
    async state() { return state; },
    async importReference3mf(inputPath: string, revision: string) {
      importedPath = inputPath;
      assert.equal(revision, "r1");
      state = { ...state, revision: "r2", referenceMeshes: [mesh] };
      return state;
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const downloader = {
    async download() { throw new Error("wrong download route"); },
    async downloadParasolid() { throw new Error("wrong download route"); },
    async downloadReferenceThreeMf(url: string) {
      downloadCount += 1;
      assert.equal(url, "https://vendor.example/device.3mf?token=source-secret");
      return { path, bytes: contents.length, sha256: expectedHash, sourceUrl: url, finalUrl: "https://cdn.example/device.3mf?sig=redirect-secret", format: "reference-mesh-3mf" as const };
    },
  };
  const server = createPlasticityServer(
    fake, undefined, undefined,
    new StepImportReferenceStore(join(root, "references")),
    new ConstructionHistoryStore(join(root, "history")),
    downloader,
  );
  const client = new Client({ name: "reference-3mf-download-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const response = await client.callTool({
    name: "plasticity_download_and_import_reference_3mf",
    arguments: {
      source: {
        sourceKind: "official-manufacturer-cad", sourceUrl: "https://vendor.example/device.3mf?token=source-secret",
        sourcePageUrl: "https://vendor.example/device?session=page-secret", license: "Commercial terms reviewed", confidence: "verified",
      },
      intent: "Use as an approximate fit reference", revision: "r1",
    },
  });
  assert.equal(response.isError, undefined);
  assert.equal(downloadCount, 1);
  assert.equal(importedPath, path);
  const output = JSON.parse((response.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "{}");
  assert.equal(output.approximateReference, true);
  assert.equal(output.referenceArtifactHash, expectedHash);
  assert.equal(output.sourceReference.format, "3mf");
  assert.equal(output.sourceReference.unitSource, "embedded-3mf-model-metadata");
  assert.equal(output.acquisition.finalUrl, "https://cdn.example/device.3mf?sig=%5Bredacted%5D");
  assert.doesNotMatch(JSON.stringify(output), /source-secret|redirect-secret|page-secret/);
  assert.equal(output.provenancePersisted, true);
  assert.match(output.referenceRecordId, /^[0-9a-f-]{36}$/);
  const persisted = await new StepImportReferenceStore(join(root, "references")).get(output.referenceRecordId);
  assert.equal(persisted.format, "3mf");
  assert.equal(persisted.artifactHash, expectedHash);
  assert.equal(persisted.sourceReference?.sourceUrl, "https://vendor.example/device.3mf?token=%5Bredacted%5D");
  assert.equal(persisted.acquisition?.finalUrl, "https://cdn.example/device.3mf?sig=%5Bredacted%5D");
  assert.deepEqual(persisted.referenceMeshes?.map(({ id, boundsMm }) => ({ id, boundsMm })), [{ id: 73, boundsMm: mesh.boundsMm }]);
  const stale = await client.callTool({
    name: "plasticity_download_and_import_reference_3mf",
    arguments: { source: { sourceKind: "official-manufacturer-cad", sourceUrl: "https://vendor.example/other.3mf", confidence: "verified" }, intent: "Check stale guard", revision: "r1" },
  });
  assert.equal(stale.isError, true);
  assert.equal(downloadCount, 1, "a stale document revision must be rejected before network access");
  await client.close();
  await server.close();

  const restartedServer = createPlasticityServer(
    fake, undefined, undefined,
    new StepImportReferenceStore(join(root, "references")),
    new ConstructionHistoryStore(join(root, "history")),
    downloader,
  );
  const restartedClient = new Client({ name: "reference-3mf-restarted-test-client", version: "1.0.0" });
  const [restartedClientTransport, restartedServerTransport] = InMemoryTransport.createLinkedPair();
  await restartedServer.connect(restartedServerTransport);
  await restartedClient.connect(restartedClientTransport);
  const listed = await restartedClient.callTool({ name: "plasticity_list_cad_reference_imports", arguments: { limit: 10 } });
  const listedData = JSON.parse((listed.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "{}");
  assert.equal(listedData.total, 1);
  assert.equal(listedData.records[0]?.format, "3mf");
  assert.equal(listedData.records[0]?.referenceMeshCount, 1);
  const recovered = await restartedClient.callTool({ name: "plasticity_get_cad_reference_import", arguments: { id: output.referenceRecordId } });
  const recoveredData = JSON.parse((recovered.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "{}");
  assert.equal(recoveredData.format, "3mf");
  assert.equal(recoveredData.historical, true);
  assert.deepEqual(recoveredData.referenceMeshes, persisted.referenceMeshes);
  await restartedClient.close();
  await restartedServer.close();
});

test("MCP validates and forwards native SVG import with explicit source units", async () => {
  let received: unknown[] | undefined;
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async importSvg(...arguments_: unknown[]) { received = arguments_; return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "svg-import-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const response = await client.callTool({ name: "plasticity_import_svg", arguments: {
    path: "/tmp/bracket.svg", sourceUnit: "millimeter", intent: "Import exact bracket profile", revision: "r1",
  } });
  assert.equal(response.isError, undefined);
  assert.deepEqual(received, ["/tmp/bracket.svg", "millimeter", "r1"]);
  const badUnit = await client.callTool({ name: "plasticity_import_svg", arguments: {
    path: "/tmp/bracket.svg", sourceUnit: "parsec", revision: "r1",
  } });
  const missingRevision = await client.callTool({ name: "plasticity_import_svg", arguments: {
    path: "/tmp/bracket.svg", sourceUnit: "millimeter",
  } });
  assert.equal(badUnit.isError, true);
  assert.equal(missingRevision.isError, true);
  await client.close(); await server.close();
});

test("STEP reference import hashes the exact local artifact and records source provenance", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-step-reference-mcp-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "manufacturer-part.step");
  const nonStepPath = join(root, "not-a-step.txt");
  const changedDuringImportPath = join(root, "changing.step");
  const contents = "ISO-10303-21;\nsynthetic acceptance fixture\nEND-ISO-10303-21;\n";
  await writeFile(path, contents);
  await writeFile(nonStepPath, "not a STEP file");
  await writeFile(changedDuringImportPath, contents);
  const canonicalPath = await realpath(path);
  const canonicalChangedDuringImportPath = await realpath(changedDuringImportPath);
  let state = emptyState();
  const importedBody: RuntimeState["bodies"][number] = {
    id: 17, versionId: 170, type: "Solid", name: "Manufacturer bracket",
    boundsMm: { min: [0, 0, 0], max: [40, 20, 5] }, faceIds: ["f1"], edgeIds: ["e1"], faces: [], edges: [],
  };
  const imports: unknown[][] = [];
  const operations = {
    async state() { return state; },
    async importStep(...arguments_: unknown[]) {
      imports.push(arguments_);
      if (arguments_[0] === canonicalChangedDuringImportPath) await writeFile(changedDuringImportPath, `${contents}changed`);
      if (arguments_[0] === canonicalPath) state = { ...state, revision: "r2", bodies: [importedBody] };
      return state;
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const references = new StepImportReferenceStore(join(root, "references"));
  const historyStore = new ConstructionHistoryStore(join(root, "history"));
  const server = createPlasticityServer(fake, undefined, undefined, references, historyStore);
  const client = new Client({ name: "step-reference-import-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const source = {
    sourceKind: "official-manufacturer-cad",
    sourceUrl: "https://manufacturer.example/cad/part.step?token=local-secret",
    sourcePageUrl: "https://manufacturer.example/products/part?session=local-page-secret",
    license: "Test redistribution terms",
    confidence: "verified",
  };
  const response = await client.callTool({ name: "plasticity_import_step", arguments: {
    path, source, intent: "Load the verified manufacturer model as a design reference", revision: "r1",
  } });
  assert.equal(response.isError, undefined);
  const importedText = (response.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const imported = JSON.parse(importedText ?? "{}");
  const expectedHash = createHash("sha256").update(contents).digest("hex");
  assert.deepEqual(imports, [[canonicalPath, "r1"]]);
  assert.equal(imported.targetId, state.targetId);
  assert.equal(imported.revision, "r2");
  assert.deepEqual(imported.importedBodyIds, [17]);
  assert.equal(imported.importedBodyCount, 1);
  assert.equal(imported.dbVersion, state.dbVersion);
  assert.equal("bodies" in imported, false, "Import responses must not include full scene B-Rep arrays");
  assert.equal("faces" in imported, false);
  assert.deepEqual(imported.sourceReference, {
    ...source,
    sourceUrl: "https://manufacturer.example/cad/part.step?token=%5Bredacted%5D",
    sourcePageUrl: "https://manufacturer.example/products/part?session=%5Bredacted%5D",
    artifactHash: expectedHash,
  });
  assert.equal(imported.provenancePersisted, true);
  assert.match(imported.referenceRecordId, /^[0-9a-f-]{36}$/);
  const persisted = await new StepImportReferenceStore(join(root, "references")).get(imported.referenceRecordId);
  assert.equal(persisted.artifactHash, expectedHash);
  assert.equal(persisted.sourceReference?.sourceUrl, "https://manufacturer.example/cad/part.step?token=%5Bredacted%5D");
  assert.equal(persisted.sourceReference?.sourcePageUrl, "https://manufacturer.example/products/part?session=%5Bredacted%5D");
  assert.equal(persisted.documentToken, "doc-1");
  assert.equal(persisted.revision, "r2");
  assert.deepEqual(persisted.bodies, [{
    id: 17, type: "Solid", name: "Manufacturer bracket", boundsMm: { min: [0, 0, 0], max: [40, 20, 5] }, faceCount: 0, edgeCount: 0,
  }]);
  const importList = await client.callTool({ name: "plasticity_list_step_imports", arguments: { limit: 10 } });
  const importListData = JSON.parse((importList.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "{}");
  assert.equal(importListData.total, 1);
  assert.equal(importListData.records[0]?.historical, true);
  const importedRecord = await client.callTool({ name: "plasticity_get_step_import", arguments: { id: imported.referenceRecordId } });
  const importedRecordData = JSON.parse((importedRecord.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "{}");
  assert.equal(importedRecordData.historical, true);
  assert.deepEqual(importedRecordData.bodies, persisted.bodies);
  const journalResponse = await client.callTool({ name: "plasticity_construction_journal", arguments: {} });
  const journalText = (journalResponse.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const journal = JSON.parse(journalText ?? "{}");
  assert.deepEqual(journal.journalPagination, { offset: 0, limit: 20, total: 1, nextOffset: null });
  assert.deepEqual(journal.entries.at(-1)?.input, {
    path: canonicalPath,
    format: "step",
    importedArtifactHash: expectedHash,
    sourceReference: {
      ...source,
      sourceUrl: "https://manufacturer.example/cad/part.step?token=%5Bredacted%5D",
      sourcePageUrl: "https://manufacturer.example/products/part?session=%5Bredacted%5D",
      artifactHash: expectedHash,
    },
  });
  assert.equal(journal.entries[0]?.diff.added[0]?.faceCount, 0);
  assert.equal("faces" in journal.entries[0]?.diff.added[0], false);
  assert.doesNotMatch(JSON.stringify(journal), /local-secret|local-page-secret/);
  const historyResponse = await client.callTool({ name: "plasticity_construction_history", arguments: { limit: 10 } });
  const historyText = (historyResponse.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const history = JSON.parse(historyText ?? "{}");
  assert.equal(history.total, 1);
  assert.equal(history.entries[0]?.status, "completed");
  assert.equal(history.entries[0]?.change.added[0]?.boundsMm.max[0], 40);
  const httpSource = await client.callTool({ name: "plasticity_import_step", arguments: {
    path, source: { ...source, sourceUrl: "http://manufacturer.example/part.step" },
    intent: "reject non-HTTPS provenance", revision: "r1",
  } });
  assert.equal(httpSource.isError, true);
  assert.equal(imports.length, 1);
  const invalidPath = await client.callTool({ name: "plasticity_import_step", arguments: {
    path: nonStepPath, intent: "Reject non-STEP source before hashing", revision: "r1",
  } });
  assert.equal(invalidPath.isError, true);
  assert.equal(imports.length, 1);
  const unregisteredLocalFile = await client.callTool({ name: "plasticity_import_step", arguments: {
    path, intent: "Load a local STEP file without external source details", revision: "r1",
  } });
  const localImportText = (unregisteredLocalFile.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const localImport = JSON.parse(localImportText ?? "{}");
  assert.equal(localImport.importedArtifactHash, expectedHash);
  assert.equal(localImport.provenancePersisted, true);
  assert.equal(localImport.sourceReference, undefined);
  assert.equal(imports.length, 2);
  const changedFileResponse = await client.callTool({ name: "plasticity_import_step", arguments: {
    path: changedDuringImportPath, intent: "Test detection of changed STEP source", revision: "r1",
  } });
  assert.equal(changedFileResponse.isError, true);
  const changedJournalResponse = await client.callTool({ name: "plasticity_construction_journal", arguments: {} });
  const changedJournalText = (changedJournalResponse.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const changedJournal = JSON.parse(changedJournalText ?? "{}");
  assert.equal(changedJournal.entries.at(-1)?.status, "unknown");
  assert.match(changedJournal.entries.at(-1)?.error ?? "", /source identity is uncertain/i);
  assert.equal(changedJournal.durableSyncStatus, "unknown-outcome-requires-inspection");
  await client.close(); await server.close();
});

test("selected-page reference asset discovery is a read-only MCP call with an explicit domain allowlist", async () => {
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { throw new Error("Plasticity must not be used for selected-page asset discovery"); },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  let request: { pageUrl: string; domains: string[] } | undefined;
  const downloader = {
    async download() { throw new Error("Asset discovery must not download a CAD file"); },
    async downloadParasolid() { throw new Error("Asset discovery must not download a CAD file"); },
    async listReferenceAssets(pageUrl: string, allowedDomains: string[]) {
      request = { pageUrl, domains: allowedDomains };
      return {
        assets: [{ url: "https://dl.radxa.com/zero3/model.step.zip", label: "Official 3D STEP archive", format: "step-archive", kind: "editable-cad" as const }],
        omittedQueryAssetCount: 1,
        truncated: false,
      };
    },
  };
  const server = createPlasticityServer(fake, undefined, undefined, undefined, null, downloader);
  const client = new Client({ name: "reference-asset-list-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const response = await client.callTool({ name: "plasticity_list_reference_assets", arguments: {
    sourcePageUrl: "https://docs.radxa.com/zero/zero3/download",
    allowedDomains: ["docs.radxa.com", "dl.radxa.com"],
  } });

  assert.equal(response.isError, undefined);
  assert.deepEqual(request, { pageUrl: "https://docs.radxa.com/zero/zero3/download", domains: ["docs.radxa.com", "dl.radxa.com"] });
  const result = JSON.parse((response.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "{}");
  assert.equal(result.assets[0].url, "https://dl.radxa.com/zero3/model.step.zip");
  assert.equal(result.omittedQueryAssetCount, 1);
  assert.equal(result.truncated, false);
  await client.close();
  await server.close();
});

test("download-and-import step preserves sanitized source provenance and exact native measurements", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-step-download-mcp-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "downloaded.step");
  const contents = "ISO-10303-21;\nsynthetic STEP fixture\nEND-ISO-10303-21;\n";
  await writeFile(path, contents);
  const stateBefore = emptyState();
  let state = stateBefore;
  const importedBody: RuntimeState["bodies"][number] = {
    id: 22, versionId: 220, type: "Solid", name: "Downloaded bracket",
    boundsMm: { min: [0, 0, 0], max: [45, 18, 6] }, faceIds: [], edgeIds: [], faces: [], edges: [],
  };
  let downloadedUrl: string | undefined;
  let downloadCount = 0;
  let importCount = 0;
  let returnWrongHash = false;
  let importedPath: string | undefined;
  const operations = {
    async state() { return state; },
    async importStep(inputPath: string, revision: string) {
      importCount += 1;
      importedPath = inputPath;
      assert.equal(revision, "r1");
      state = { ...state, revision: "r2", bodies: [importedBody] };
      return state;
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const references = new StepImportReferenceStore(join(root, "references"));
  const source = {
    sourceKind: "official-manufacturer-cad",
    sourceUrl: "https://manufacturer.example/cad/model.step.zip?token=secret-value",
    sourcePageUrl: "https://manufacturer.example/products/model?session=page-secret",
    license: "Test redistribution terms",
    confidence: "verified",
  };
  const downloader = {
    async download(url: string) {
      downloadCount += 1;
      downloadedUrl = url;
      return {
        path,
        bytes: Buffer.byteLength(contents),
        sha256: returnWrongHash ? "0".repeat(64) : createHash("sha256").update(contents).digest("hex"),
        sourceUrl: url,
        finalUrl: "https://cdn.example/model.step.zip?signature=hidden",
        format: "step" as const,
        sourceArchive: { sha256: "c".repeat(64), bytes: 3_284, memberPath: "Cad/model.step" },
      };
    },
    async downloadParasolid(url: string) {
      return { path, bytes: Buffer.byteLength(contents), sha256: createHash("sha256").update(contents).digest("hex"), sourceUrl: url, finalUrl: url, format: "parasolid-text" as const };
    },
  };
  const server = createPlasticityServer(fake, undefined, undefined, references, null, downloader);
  const client = new Client({ name: "step-download-mcp-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const response = await client.callTool({ name: "plasticity_download_and_import_step", arguments: {
    source: {
      sourceKind: "official-manufacturer-cad",
      sourceUrl: "https://manufacturer.example/cad/model.step.zip?token=secret-value",
      sourcePageUrl: "https://manufacturer.example/products/model?session=page-secret",
      license: "Test redistribution terms",
      confidence: "verified",
    },
    intent: "Import the verified accessory STEP as a locked reference",
    revision: "r1",
  } });
  assert.equal(response.isError, undefined);
  assert.equal(downloadedUrl, "https://manufacturer.example/cad/model.step.zip?token=secret-value");
  assert.equal(importedPath, await realpath(path));
  const output = JSON.parse((response.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "{}");
  const expectedHash = createHash("sha256").update(contents).digest("hex");
  assert.equal(output.importedArtifactHash, expectedHash);
  assert.equal(output.sourceReference.sourceUrl, "https://manufacturer.example/cad/model.step.zip?token=%5Bredacted%5D");
  assert.equal(output.sourceReference.sourcePageUrl, "https://manufacturer.example/products/model?session=%5Bredacted%5D");
  assert.equal(output.acquisition.finalUrl, "https://cdn.example/model.step.zip?signature=%5Bredacted%5D");
  assert.equal(output.acquisition.bytes, Buffer.byteLength(contents));
  assert.deepEqual(output.acquisition.sourceArchive, { sha256: "c".repeat(64), bytes: 3_284, memberPath: "Cad/model.step" });
  assert.equal(output.provenancePersisted, true);
  assert.deepEqual(output.importedBodyIds, [22]);
  assert.equal(output.importedBodyCount, 1);
  assert.equal("bodies" in output, false, "Downloaded import responses must stay compact too");
  assert.equal(state.revision, "r2");
  assert.deepEqual(state.bodies.map(({ id, boundsMm }) => ({ id, boundsMm })), [{ id: 22, boundsMm: importedBody.boundsMm }]);
  const persisted = await references.get(output.referenceRecordId as string);
  assert.equal(persisted.artifactHash, expectedHash);
  assert.deepEqual(persisted.sourceArchive, { sha256: "c".repeat(64), bytes: 3_284, memberPath: "Cad/model.step" });
  assert.equal(persisted.sourceReference?.sourceUrl, "https://manufacturer.example/cad/model.step.zip?token=%5Bredacted%5D");
  assert.equal(persisted.sourceReference?.sourcePageUrl, "https://manufacturer.example/products/model?session=%5Bredacted%5D");
  returnWrongHash = true;
  const changedArtifact = await client.callTool({ name: "plasticity_download_and_import_step", arguments: { source, revision: "r2" } });
  assert.equal(changedArtifact.isError, true);
  assert.equal(importCount, 1, "Changed or mismatched artifacts must be rejected before Plasticity import");
  assert.equal(state.revision, "r2");
  returnWrongHash = false;
  const staleRevision = await client.callTool({ name: "plasticity_download_and_import_step", arguments: {
    source: { ...source, sourceUrl: "https://manufacturer.example/cad/another.step?token=must-not-fetch" },
    revision: "r1",
  } });
  assert.equal(staleRevision.isError, true);
  assert.equal(downloadCount, 2, "Stale revision must be rejected before network download");
  const journalResponse = await client.callTool({ name: "plasticity_construction_journal", arguments: {} });
  const journal = JSON.parse((journalResponse.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "{}");
  assert.equal(journal.entries.at(-1)?.status, "completed");
  assert.equal(journal.entries.at(-1)?.diff.added[0].boundsMm.max[0], 45);
  assert.doesNotMatch(JSON.stringify(journal), /secret-value|signature=hidden/);
  await client.close(); await server.close();
});

test("download-and-import reference mesh uses explicit units, exact artifact identity, and durable sanitized journal data", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-reference-mesh-download-mcp-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "downloaded.obj");
  const contents = "o phone\nv 0 0 0\nv 72.8 0 0\nv 0 158.4 0\nf 1 2 3\n";
  await writeFile(path, contents);
  let state: RuntimeState = { ...emptyState(), referenceMeshes: [] };
  let downloadCount = 0;
  let importCount = 0;
  let importedPath = "";
  let importedUnit = "";
  const mesh: NonNullable<RuntimeState["referenceMeshes"]>[number] = {
    id: 32, type: "ReferenceMesh", name: "Fold reference", sourcePath: path, sourceFormat: "obj",
    measurementSource: "reference-mesh", boundsMm: { min: [0, 0, 0], max: [72.8, 158.4, 0] },
    translationMm: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1], sceneScaleToMeters: [0.001, 0.001, 0.001],
    vertexEntries: 3, triangles: 1, visible: true, hidden: false, locked: false,
  };
  const operations = {
    async state() { return state; },
    async importReferenceMesh(inputPath: string, sourceUnit: string, revision: string) {
      importCount += 1;
      importedPath = inputPath;
      importedUnit = sourceUnit;
      assert.equal(revision, "r1");
      state = { ...state, revision: "r2", referenceMeshes: [mesh] };
      return state;
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const downloader = {
    async download() { throw new Error("wrong download path"); },
    async downloadParasolid() { throw new Error("wrong download path"); },
    async downloadReferenceMesh(url: string, format: "stl" | "obj") {
      downloadCount += 1;
      assert.equal(url, "https://community.example/files/fold.obj?token=download-secret");
      assert.equal(format, "obj");
      return {
        path, bytes: Buffer.byteLength(contents), sha256: createHash("sha256").update(contents).digest("hex"),
        sourceUrl: url, finalUrl: "https://cdn.example/files/fold.obj?sig=final-secret", format: "reference-mesh-obj" as const,
      };
    },
  };
  const server = createPlasticityServer(
    fake,
    undefined,
    undefined,
    new StepImportReferenceStore(join(root, "references")),
    new ConstructionHistoryStore(join(root, "history")),
    downloader,
  );
  const client = new Client({ name: "reference-mesh-download-mcp-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const response = await client.callTool({
    name: "plasticity_download_and_import_reference_mesh",
    arguments: {
      source: {
        sourceKind: "verified-community-cad",
        sourceUrl: "https://community.example/files/fold.obj?token=download-secret",
        sourcePageUrl: "https://community.example/models/fold?session=page-secret",
        license: "CC BY 4.0",
        confidence: "approximate",
      },
      format: "obj", sourceUnit: "millimeter", intent: "Use the phone shell as an approximate fit reference", revision: "r1",
    },
  });
  assert.equal(response.isError, undefined);
  assert.equal(downloadCount, 1);
  assert.equal(importCount, 1);
  assert.equal(importedPath, path);
  assert.equal(importedUnit, "millimeter");
  const output = JSON.parse((response.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "{}");
  assert.equal(output.referenceArtifactHash, createHash("sha256").update(contents).digest("hex"));
  assert.equal(output.sourceReference.sourceUrl, "https://community.example/files/fold.obj?token=%5Bredacted%5D");
  assert.equal(output.sourceReference.sourcePageUrl, "https://community.example/models/fold?session=%5Bredacted%5D");
  assert.equal(output.sourceReference.exactGeometry, false);
  assert.equal(output.acquisition.finalUrl, "https://cdn.example/files/fold.obj?sig=%5Bredacted%5D");
  assert.equal(output.approximateReference, true);
  assert.equal(output.importedMeshes[0].measurementSource, "reference-mesh");
  assert.deepEqual(output.importedMeshes[0].boundsMm.max, [72.8, 158.4, 0]);
  const historyResponse = await client.callTool({ name: "plasticity_construction_history", arguments: {} });
  const history = JSON.parse((historyResponse.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "{}");
  assert.equal(history.entries[0].operation, "download-and-import-reference-mesh");
  assert.equal(history.entries[0].input.sourceArtifactHash, output.referenceArtifactHash);
  assert.doesNotMatch(JSON.stringify(history), /download-secret|final-secret|page-secret/);
  const stale = await client.callTool({
    name: "plasticity_download_and_import_reference_mesh",
    arguments: { source: { sourceKind: "verified-community-cad", sourceUrl: "https://community.example/other.obj", confidence: "approximate" }, format: "obj", sourceUnit: "millimeter", revision: "r1" },
  });
  assert.equal(stale.isError, true);
  assert.equal(downloadCount, 1, "a stale Plasticity revision must be rejected before network access");
  await client.close(); await server.close();
});

test("download-and-import Parasolid verifies hash, revision, exact bodies, and durable provenance", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-parasolid-download-mcp-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "downloaded.x_t");
  const contents = `**PARASOLID MODEL 1\n${"x".repeat(120)}`;
  await writeFile(path, contents);
  let state = emptyState();
  let importedPath: string | undefined;
  let downloadCount = 0;
  let importCount = 0;
  const importedBody: RuntimeState["bodies"][number] = {
    id: 32, versionId: 320, type: "Solid", name: "Downloaded reference",
    boundsMm: { min: [0, 0, 0], max: [30, 20, 8] }, faceIds: [], edgeIds: [], faces: [], edges: [],
  };
  const operations = {
    async state() { return state; },
    async importParasolid(inputPath: string, revision: string) {
      importCount += 1;
      importedPath = inputPath;
      assert.equal(revision, "r1");
      state = { ...state, revision: "r2", bodies: [importedBody] };
      return state;
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const references = new StepImportReferenceStore(join(root, "references"));
  const downloader = {
    async download(url: string) {
      return { path, bytes: Buffer.byteLength(contents), sha256: createHash("sha256").update(contents).digest("hex"), sourceUrl: url, finalUrl: url, format: "step" as const };
    },
    async downloadParasolid(url: string, representation: "x_t" | "x_b" | "xmt_txt" | "xmt_bin") {
      downloadCount += 1;
      return {
        path, bytes: Buffer.byteLength(contents), sha256: createHash("sha256").update(contents).digest("hex"),
        sourceUrl: url, finalUrl: "https://cdn.example/model.x_t?signature=hidden",
        format: representation === "x_t" || representation === "xmt_txt" ? "parasolid-text" as const : "parasolid-binary" as const,
      };
    },
  };
  const server = createPlasticityServer(fake, undefined, undefined, references, null, downloader);
  const client = new Client({ name: "parasolid-download-mcp-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const source = {
    sourceKind: "official-manufacturer-cad",
    sourceUrl: "https://manufacturer.example/cad/model.xmt_txt?token=secret-value",
    sourcePageUrl: "https://manufacturer.example/products/model",
    license: "Test redistribution terms",
    confidence: "verified",
  };
  const response = await client.callTool({ name: "plasticity_download_and_import_parasolid", arguments: {
    source, representation: "xmt_txt", intent: "Import the explicitly selected reference", revision: "r1",
  } });
  assert.equal(response.isError, undefined);
  assert.equal(downloadCount, 1);
  assert.equal(importCount, 1);
  assert.equal(importedPath, await realpath(path));
  const output = JSON.parse((response.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "{}");
  const expectedHash = createHash("sha256").update(contents).digest("hex");
  assert.equal(output.importedArtifactHash, expectedHash);
  assert.equal(output.sourceReference.sourceUrl, "https://manufacturer.example/cad/model.xmt_txt?token=%5Bredacted%5D");
  assert.equal(output.sourceReference.sourcePageUrl, "https://manufacturer.example/products/model");
  assert.equal(output.provenancePersisted, true);
  assert.equal(output.revision, "r2");
  assert.deepEqual(output.importedBodyIds, [32]);
  assert.equal(output.importedBodyCount, 1);
  assert.equal("bodies" in output, false);
  const persisted = await references.get(output.referenceRecordId as string);
  assert.equal(persisted.format, "parasolid");
  assert.equal(persisted.artifactHash, expectedHash);
  assert.deepEqual(persisted.bodies.map(({ id, boundsMm }) => ({ id, boundsMm })), [{ id: 32, boundsMm: importedBody.boundsMm }]);
  const list = await client.callTool({ name: "plasticity_list_cad_reference_imports", arguments: { limit: 10 } });
  const listData = JSON.parse((list.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "{}");
  assert.equal(listData.total, 1);
  assert.equal(listData.records[0]?.format, "parasolid");
  const record = await client.callTool({ name: "plasticity_get_cad_reference_import", arguments: { id: output.referenceRecordId } });
  const recordData = JSON.parse((record.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "{}");
  assert.equal(recordData.format, "parasolid");
  assert.equal(recordData.historical, true);
  const stale = await client.callTool({ name: "plasticity_download_and_import_parasolid", arguments: {
    source, representation: "xmt_bin", intent: "This call is stale", revision: "r1",
  } });
  assert.equal(stale.isError, true);
  assert.equal(downloadCount, 1, "Stale revision must be rejected before the network download");
  await client.close(); await server.close();
});

test("durable construction history survives MCP recreation and detects manual revision divergence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-construction-history-mcp-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  let state: RuntimeState = emptyState();
  const body: RuntimeState["bodies"][number] = {
    id: 8, versionId: 80, type: "Solid", name: "Agent bracket",
    boundsMm: { min: [0, 0, 0], max: [40, 20, 5] }, faceIds: ["face-1"], edgeIds: ["edge-1"], faces: [], edges: [],
  };
  const operations = {
    async state() { return state; },
    async createBox() { state = { ...state, revision: "r2", bodies: [body] }; return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const store = new ConstructionHistoryStore(join(root, "history"));
  const firstServer = createPlasticityServer(fake, undefined, undefined, undefined, store);
  const firstClient = new Client({ name: "construction-history-client-1", version: "1.0.0" });
  const [firstClientTransport, firstServerTransport] = InMemoryTransport.createLinkedPair();
  await firstServer.connect(firstServerTransport); await firstClient.connect(firstClientTransport);
  const mutation = await firstClient.callTool({ name: "plasticity_create_box", arguments: {
    originMm: [0, 0, 0], sizeMm: [40, 20, 5], intent: "Create the accepted reference-derived bracket body", revision: "r1",
  } });
  assert.equal(mutation.isError, undefined);
  await firstClient.close(); await firstServer.close();

  const secondServer = createPlasticityServer(fake, undefined, undefined, undefined, new ConstructionHistoryStore(join(root, "history")));
  const secondClient = new Client({ name: "construction-history-client-2", version: "1.0.0" });
  const [secondClientTransport, secondServerTransport] = InMemoryTransport.createLinkedPair();
  await secondServer.connect(secondServerTransport); await secondClient.connect(secondClientTransport);
  const persistedResponse = await secondClient.callTool({ name: "plasticity_construction_history", arguments: {} });
  const persisted = JSON.parse((persistedResponse.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "{}");
  assert.equal(persisted.total, 1);
  assert.equal(persisted.entries[0]?.operation, "create-box");
  assert.equal(persisted.entries[0]?.change.added[0]?.boundsMm.max[0], 40);
  let journalResponse = await secondClient.callTool({ name: "plasticity_construction_journal", arguments: {} });
  let journal = JSON.parse((journalResponse.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "{}");
  assert.equal(journal.durableSyncStatus, "in-sync");

  state = { ...state, revision: "r3" };
  journalResponse = await secondClient.callTool({ name: "plasticity_construction_journal", arguments: {} });
  journal = JSON.parse((journalResponse.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "{}");
  assert.equal(journal.durableSyncStatus, "manual-edit-detected");
  assert.equal(journal.latestDurableEvent.afterRevision, "r2");
  await secondClient.close(); await secondServer.close();
});

test("native mutation responses use the reconciled state and include a compact exact scene change", async () => {
  const boundsMm = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
  const face = {
    id: "face-1", surfaceType: "plane", planar: true, centerMm: [0, 0, 0] as [number, number, number],
    normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null,
    axisOriginMm: null, axisDirection: null, boundsMm, edgeIds: ["edge-1"],
  };
  const edge = {
    id: "edge-1", curveType: "line", line: true, circle: false, lengthMm: 1,
    centerMm: [0, 0, 0] as [number, number, number], tangent: [1, 0, 0] as [number, number, number],
    boundsMm, faceIds: ["face-1"], vertexIds: [1, 2],
  };
  const makeBody = (id: number): RuntimeState["bodies"][number] => ({
    id, versionId: id + 100, type: "Solid", name: `Body ${id}`, boundsMm,
    faceIds: ["face-1"], edgeIds: ["edge-1"], faces: [face], edges: [edge],
    vertices: [{ id: 1, positionMm: [0, 0, 0], edgeIds: ["edge-1"], faceIds: ["face-1"] }],
  });
  let state: RuntimeState = { ...emptyState(), bodies: Array.from({ length: 60 }, (_, id) => makeBody(id)) };
  const operations = {
    async state() { return state; },
    async createBox() {
      const staleOperationResult = state;
      state = { ...state, revision: "r2", bodies: [...state.bodies, makeBody(60)] };
      return staleOperationResult;
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "compact-mutation-response-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const response = await client.callTool({ name: "plasticity_create_box", arguments: {
    originMm: [0, 0, 0], sizeMm: [1, 1, 1], revision: "r1",
  } });
  assert.equal(response.isError, undefined);
  const result = JSON.parse((response.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "null");
  assert.equal(result.revision, "r2");
  assert.equal(result.bodyPagination.total, 61);
  assert.equal(result.bodyPagination.limit, 20);
  assert.equal(result.bodyPagination.nextOffset, 20);
  assert.equal(result.bodies.length, 20);
  assert.ok(result.bodies.every((body: Record<string, unknown>) => !("faces" in body) && !("edges" in body)
    && !("faceIds" in body) && !("edgeIds" in body) && !("vertices" in body)));
  assert.deepEqual(result.change.added, [{
    id: 60, versionId: 160, type: "Solid", name: "Body 60", boundsMm,
    faceCount: 1, edgeCount: 1, vertexCount: 1,
  }]);
  assert.equal(result.change.sceneChanged, true);
  assert.equal(result.change.revisionChanged, true);
  assert.doesNotMatch(JSON.stringify(result), /"surfaceType"|"curveType"|"vertexIds"/);
  assert.ok(JSON.stringify(result).length < JSON.stringify(state).length / 5,
    "mutation responses should not repeat the full native B-Rep payload");
  await client.close(); await server.close();
});

test("history storage failure remains visible without converting a completed CAD edit into an apparent failure", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-construction-history-failure-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const invalidStoreRoot = join(root, "not-a-directory");
  await writeFile(invalidStoreRoot, "occupied");
  let state = emptyState();
  const body: RuntimeState["bodies"][number] = {
    id: 9, versionId: 90, type: "Solid", name: "Completed edit",
    boundsMm: { min: [0, 0, 0], max: [10, 10, 10] }, faceIds: [], edgeIds: [], faces: [], edges: [],
  };
  const operations = {
    async state() { return state; },
    async createBox() { state = { ...state, revision: "r2", bodies: [body] }; return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createPlasticityServer(fake, undefined, undefined, undefined, new ConstructionHistoryStore(invalidStoreRoot));
  const client = new Client({ name: "construction-history-failure-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const mutation = await client.callTool({ name: "plasticity_create_box", arguments: {
    originMm: [0, 0, 0], sizeMm: [10, 10, 10], revision: "r1",
  } });
  assert.equal(mutation.isError, undefined);
  assert.equal(state.bodies.length, 1);
  const journalResponse = await client.callTool({ name: "plasticity_construction_journal", arguments: {} });
  const journal = JSON.parse((journalResponse.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "{}");
  assert.equal(journal.entries.at(-1)?.status, "completed");
  assert.equal(journal.durableSyncStatus, "history-unavailable");
  assert.match(journal.journalPersistenceWarnings.at(-1)?.error ?? "", /EEXIST|ENOTDIR/i);
  await client.close(); await server.close();
});

test("MCP validates and forwards native closed-profile extrusion", async () => {
  let received: unknown[] | undefined;
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async extrudeProfile(...arguments_: unknown[]) { received = arguments_; return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "extrude-profile-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const response = await client.callTool({ name: "plasticity_extrude_profile", arguments: {
    id: 21, distanceMm: -8, intent: "Extrude the closed plate profile downwards", revision: "r1",
  } });
  assert.equal(response.isError, undefined);
  assert.deepEqual(received, [21, -8, "r1"]);
  const invalidId = await client.callTool({ name: "plasticity_extrude_profile", arguments: { id: 0, distanceMm: 8, revision: "r1" } });
  const missingRevision = await client.callTool({ name: "plasticity_extrude_profile", arguments: { id: 21, distanceMm: 8 } });
  assert.equal(invalidId.isError, true);
  assert.equal(missingRevision.isError, true);
  await client.close(); await server.close();
});

test("MCP validates and forwards native slot-profile creation", async () => {
  let received: unknown[] | undefined;
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async createSlotProfiles(...arguments_: unknown[]) { received = arguments_; return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "slot-profile-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const response = await client.callTool({ name: "plasticity_create_slot_profiles", arguments: {
    wireIds: [7, 8], widthMm: 6, intent: "Create routed channel profiles", revision: "r1",
  } });
  assert.equal(response.isError, undefined);
  assert.deepEqual(received, [[7, 8], 6, "r1"]);
  const duplicate = await client.callTool({ name: "plasticity_create_slot_profiles", arguments: { wireIds: [7, 7], widthMm: 6, revision: "r1" } });
  const zeroWidth = await client.callTool({ name: "plasticity_create_slot_profiles", arguments: { wireIds: [7], widthMm: 0, revision: "r1" } });
  const missingRevision = await client.callTool({ name: "plasticity_create_slot_profiles", arguments: { wireIds: [7], widthMm: 6 } });
  assert.equal(duplicate.isError, true);
  assert.equal(zeroWidth.isError, true);
  assert.equal(missingRevision.isError, true);
  await client.close(); await server.close();
});

test("MCP validates and forwards native Sheet insertion", async () => {
  const calls: unknown[][] = [];
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async insertSheet(...arguments_: unknown[]) { calls.push(arguments_); return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "sheet-insertion-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const response = await client.callTool({ name: "plasticity_insert_sheet", arguments: {
    targetSheetId: 7, edgeIds: ["e1", "e2", "e3", "e4"], fillSheetId: 8,
    intent: "Close the open enclosure with its fitted cover", revision: "r1",
  } });
  assert.equal(response.isError, undefined);
  assert.deepEqual(calls, [[7, ["e1", "e2", "e3", "e4"], 8, "r1"]]);

  const sameBody = await client.callTool({ name: "plasticity_insert_sheet", arguments: {
    targetSheetId: 7, edgeIds: ["e1"], fillSheetId: 7, revision: "r1",
  } });
  const duplicateEdges = await client.callTool({ name: "plasticity_insert_sheet", arguments: {
    targetSheetId: 7, edgeIds: ["e1", "e1"], fillSheetId: 8, revision: "r1",
  } });
  assert.equal(sameBody.isError, true);
  assert.equal(duplicateEdges.isError, true);
  assert.equal(calls.length, 1);
  await client.close(); await server.close();
});

test("MCP validates and forwards native closed-Wire surface patches", async () => {
  const calls: unknown[][] = [];
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async patchClosedWires(...arguments_: unknown[]) { calls.push(arguments_); return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "closed-wire-patch-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const response = await client.callTool({ name: "plasticity_patch_closed_wires", arguments: {
    ids: [7, 8], intent: "Fill two spatial closed boundaries", revision: "r1",
  } });
  assert.equal(response.isError, undefined);
  assert.deepEqual(calls, [[[7, 8], "r1"]]);
  const duplicate = await client.callTool({ name: "plasticity_patch_closed_wires", arguments: { ids: [7, 7], revision: "r1" } });
  const empty = await client.callTool({ name: "plasticity_patch_closed_wires", arguments: { ids: [], revision: "r1" } });
  assert.equal(duplicate.isError, true);
  assert.equal(empty.isError, true);
  assert.equal(calls.length, 1);
  await client.close(); await server.close();
});

test("MCP validates and forwards preserved native face deformation", async () => {
  const calls: unknown[][] = [];
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async deformBodiesBetweenFaces(...arguments_: unknown[]) { calls.push(arguments_); return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "face-deformation-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const response = await client.callTool({ name: "plasticity_deform_bodies_between_faces", arguments: {
    ids: [7], sourceFace: { bodyId: 8, faceId: "source" }, targetFace: { bodyId: 9, faceId: "target" },
    scaleU: 1.5, flipUV: true, mirror: true,
    intent: "Wrap the raised mark onto the enclosure", revision: "r1",
  } });
  assert.equal(response.isError, undefined);
  assert.deepEqual(calls, [[
    [7], { bodyId: 8, faceId: "source" }, { bodyId: 9, faceId: "target" },
    { scaleU: 1.5, scaleV: 1, scaleNormal: 1, flipUV: true, flipNormal: false, mirror: true }, "r1",
  ]]);

  const sameFace = await client.callTool({ name: "plasticity_deform_bodies_between_faces", arguments: {
    ids: [7], sourceFace: { bodyId: 8, faceId: "same" }, targetFace: { bodyId: 8, faceId: "same" }, revision: "r1",
  } });
  const referenceBody = await client.callTool({ name: "plasticity_deform_bodies_between_faces", arguments: {
    ids: [8], sourceFace: { bodyId: 8, faceId: "source" }, targetFace: { bodyId: 9, faceId: "target" }, revision: "r1",
  } });
  const zeroScale = await client.callTool({ name: "plasticity_deform_bodies_between_faces", arguments: {
    ids: [7], sourceFace: { bodyId: 8, faceId: "source" }, targetFace: { bodyId: 9, faceId: "target" }, scaleNormal: 0, revision: "r1",
  } });
  assert.equal(sameFace.isError, true);
  assert.equal(referenceBody.isError, true);
  assert.equal(zeroScale.isError, true);
  assert.equal(calls.length, 1);
  await client.close(); await server.close();
});

test("MCP validates and forwards preserved native curve deformation", async () => {
  const calls: unknown[][] = [];
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async deformCurvesBetweenFaces(...arguments_: unknown[]) { calls.push(arguments_); return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "curve-deformation-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const response = await client.callTool({ name: "plasticity_deform_curves_between_faces", arguments: {
    ids: [7], sourceFace: { bodyId: 8, faceId: "source" }, targetFace: { bodyId: 9, faceId: "target" },
    scaleV: 0.75, flipNormal: true, mirror: true,
    intent: "Wrap the marking curve onto the enclosure", revision: "r1",
  } });
  assert.equal(response.isError, undefined);
  assert.deepEqual(calls, [[
    [7], { bodyId: 8, faceId: "source" }, { bodyId: 9, faceId: "target" },
    { scaleU: 1, scaleV: 0.75, scaleNormal: 1, flipUV: false, flipNormal: true, mirror: true }, "r1",
  ]]);

  const sameFace = await client.callTool({ name: "plasticity_deform_curves_between_faces", arguments: {
    ids: [7], sourceFace: { bodyId: 8, faceId: "same" }, targetFace: { bodyId: 8, faceId: "same" }, revision: "r1",
  } });
  const referenceBody = await client.callTool({ name: "plasticity_deform_curves_between_faces", arguments: {
    ids: [8], sourceFace: { bodyId: 8, faceId: "source" }, targetFace: { bodyId: 9, faceId: "target" }, revision: "r1",
  } });
  const zeroScale = await client.callTool({ name: "plasticity_deform_curves_between_faces", arguments: {
    ids: [7], sourceFace: { bodyId: 8, faceId: "source" }, targetFace: { bodyId: 9, faceId: "target" }, scaleU: 0, revision: "r1",
  } });
  assert.equal(sameFace.isError, true);
  assert.equal(referenceBody.isError, true);
  assert.equal(zeroScale.isError, true);
  assert.equal(calls.length, 1);
  await client.close(); await server.close();
});

test("MCP validates and forwards native curve-vertex conversion", async () => {
  const calls: unknown[][] = [];
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async convertCurveVerticesToControlPoints(...arguments_: unknown[]) { calls.push(arguments_); return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "convert-curve-vertices-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const vertices = [{ bodyId: 7, vertexId: 42 }, { bodyId: 7, vertexId: 43 }];
  const response = await client.callTool({ name: "plasticity_convert_curve_vertices_to_control_points", arguments: {
    vertices, intent: "Smooth two selected polyline corners", revision: "r1",
  } });
  assert.equal(response.isError, undefined);
  assert.deepEqual(calls, [[vertices, "r1"]]);

  const duplicate = await client.callTool({ name: "plasticity_convert_curve_vertices_to_control_points", arguments: {
    vertices: [vertices[0], vertices[0]], revision: "r1",
  } });
  assert.equal(duplicate.isError, true);
  assert.equal(calls.length, 1);
  await client.close(); await server.close();
});

test("MCP forwards native group hierarchy and node-state requests with strict selection validation", async () => {
  const calls: Array<{ name: string; arguments: unknown[] }> = [];
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async listGroups(...arguments_: unknown[]) {
      calls.push({ name: "list", arguments: arguments_ });
      return { documentToken: state.documentToken, revision: state.revision, activeGroupId: 0, groups: [] };
    },
    async selectNodes(...arguments_: unknown[]) { calls.push({ name: "select", arguments: arguments_ }); return { documentToken: state.documentToken, revision: state.revision, bodyIds: [7], instanceIds: [0], referenceMeshIds: [3], groupIds: [1], faces: [], edges: [], regionIds: [], curveControlPoints: [] }; },
    async selectCurves(...arguments_: unknown[]) { calls.push({ name: "select-curves", arguments: arguments_ }); return { documentToken: state.documentToken, revision: "r1", bodyIds: [], curveIds: [17], instanceIds: [], referenceMeshIds: [], groupIds: [], faces: [], edges: [], regionIds: [], curveControlPoints: [] }; },
    async selectFaces(...arguments_: unknown[]) { calls.push({ name: "select-faces", arguments: arguments_ }); return { documentToken: state.documentToken, revision: state.revision, bodyIds: [], instanceIds: [], groupIds: [], faces: [{ bodyId: 7, faceId: "17f1" }], edges: [], regionIds: [], curveControlPoints: [] }; },
    async selectEdges(...arguments_: unknown[]) { calls.push({ name: "select-edges", arguments: arguments_ }); return { documentToken: state.documentToken, revision: state.revision, bodyIds: [], instanceIds: [], groupIds: [], faces: [], edges: [{ bodyId: 7, edgeId: "17e1" }], regionIds: [], curveControlPoints: [] }; },
    async selectCurveControlPoints(...arguments_: unknown[]) { calls.push({ name: "select-curve-control-points", arguments: arguments_ }); return { documentToken: state.documentToken, revision: state.revision, bodyIds: [], instanceIds: [], groupIds: [], faces: [], edges: [], regionIds: [], curveControlPoints: [{ bodyId: 7, kind: "vertex", pointId: 101 }, { bodyId: 7, kind: "control-point", pointId: 2 }] }; },
    async createGroup(...arguments_: unknown[]) { calls.push({ name: "create", arguments: arguments_ }); return state; },
    async moveToGroup(...arguments_: unknown[]) { calls.push({ name: "move", arguments: arguments_ }); return state; },
    async renameGroup(...arguments_: unknown[]) { calls.push({ name: "rename", arguments: arguments_ }); return state; },
    async activateGroup(...arguments_: unknown[]) { calls.push({ name: "activate", arguments: arguments_ }); return state; },
    async dissolveGroups(...arguments_: unknown[]) { calls.push({ name: "dissolve", arguments: arguments_ }); return state; },
    async setNodeVisibility(...arguments_: unknown[]) { calls.push({ name: "visibility", arguments: arguments_ }); return state; },
    async setNodeLocked(...arguments_: unknown[]) { calls.push({ name: "locked", arguments: arguments_ }); return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "group-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const responses = await Promise.all([
    client.callTool({ name: "plasticity_list_groups", arguments: {} }),
    client.callTool({ name: "plasticity_select_nodes", arguments: { bodyIds: [7], instanceIds: [0], referenceMeshIds: [3], groupIds: [1], revision: "r1" } }),
    client.callTool({ name: "plasticity_select_curves", arguments: { ids: [17], revision: "r1" } }),
    client.callTool({ name: "plasticity_select_faces", arguments: { faces: [{ bodyId: 7, faceId: "17f1" }], revision: "r1" } }),
    client.callTool({ name: "plasticity_select_edges", arguments: { edges: [{ bodyId: 7, edgeId: "17e1" }], revision: "r1" } }),
    client.callTool({ name: "plasticity_select_curve_control_points", arguments: { points: [{ bodyId: 7, kind: "vertex", pointId: 101 }, { bodyId: 7, kind: "control-point", pointId: 2 }], revision: "r1" } }),
    client.callTool({ name: "plasticity_create_group", arguments: { bodyIds: [7], instanceIds: [0], referenceMeshIds: [3], groupIds: [1], name: "Bracket", revision: "r1" } }),
    client.callTool({ name: "plasticity_move_to_group", arguments: { groupIds: [1], destinationGroupId: 2, revision: "r1" } }),
    client.callTool({ name: "plasticity_rename_group", arguments: { id: 1, name: "Module", revision: "r1" } }),
    client.callTool({ name: "plasticity_activate_group", arguments: { id: 2, revision: "r1" } }),
    client.callTool({ name: "plasticity_dissolve_groups", arguments: { ids: [1], revision: "r1" } }),
    client.callTool({ name: "plasticity_set_visibility", arguments: { bodyIds: [7], referenceMeshIds: [3], visible: false, revision: "r1" } }),
    client.callTool({ name: "plasticity_set_locked", arguments: { instanceIds: [0], referenceMeshIds: [3], locked: true, revision: "r1" } }),
  ]);
  assert(responses.every((response) => response.isError === undefined));
  assert.deepEqual(calls, [
    { name: "list", arguments: [] },
    { name: "select", arguments: [[7], [0], [3], [1], "r1"] },
    { name: "select-curves", arguments: [[17], "r1"] },
    { name: "select-faces", arguments: [[{ bodyId: 7, faceId: "17f1" }], "r1"] },
    { name: "select-edges", arguments: [[{ bodyId: 7, edgeId: "17e1" }], "r1"] },
    { name: "select-curve-control-points", arguments: [[{ bodyId: 7, kind: "vertex", pointId: 101 }, { bodyId: 7, kind: "control-point", pointId: 2 }], "r1"] },
    { name: "create", arguments: [[7], [0], [3], [1], "Bracket", "r1"] },
    { name: "move", arguments: [[], [], [], [1], 2, "r1"] },
    { name: "rename", arguments: [1, "Module", "r1"] },
    { name: "activate", arguments: [2, "r1"] },
    { name: "dissolve", arguments: [[1], "r1"] },
    { name: "visibility", arguments: [[7], [], [3], [], false, "r1"] },
    { name: "locked", arguments: [[], [0], [3], [], true, "r1"] },
  ]);

  const empty = await client.callTool({ name: "plasticity_create_group", arguments: { revision: "r1" } });
  const duplicate = await client.callTool({ name: "plasticity_set_visibility", arguments: { groupIds: [1, 1], visible: false, revision: "r1" } });
  const duplicateReference = await client.callTool({ name: "plasticity_set_locked", arguments: { referenceMeshIds: [3, 3], locked: true, revision: "r1" } });
  const rootRename = await client.callTool({ name: "plasticity_rename_group", arguments: { id: 0, name: "No", revision: "r1" } });
  const duplicateFaces = await client.callTool({ name: "plasticity_select_faces", arguments: { faces: [{ bodyId: 7, faceId: "17f1" }, { bodyId: 7, faceId: "17f1" }], revision: "r1" } });
  assert.equal(empty.isError, true);
  assert.equal(duplicate.isError, true);
  assert.equal(duplicateReference.isError, true);
  assert.equal(rootRename.isError, true);
  assert.equal(duplicateFaces.isError, true);
  const duplicateCurvePoints = await client.callTool({ name: "plasticity_select_curve_control_points", arguments: { points: [{ bodyId: 7, kind: "vertex", pointId: 101 }, { bodyId: 7, kind: "vertex", pointId: 101 }], revision: "r1" } });
  assert.equal(duplicateCurvePoints.isError, true);
  assert.equal(calls.length, 13);
  await client.close(); await server.close();
});

test("MCP forwards exact planar-face alignment and rejects duplicate moving bodies", async () => {
  const calls: unknown[][] = [];
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async alignPlanarFaces(...arguments_: unknown[]) { calls.push(arguments_); return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "alignment-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const response = await client.callTool({ name: "plasticity_align_planar_faces", arguments: {
    ids: [7, 9], sourceFace: { bodyId: 7, faceId: "17f1" }, targetFace: { bodyId: 8, faceId: "18f1" }, relation: "opposed", gapMm: 2, intent: "Seat the bracket", revision: "r1",
  } });
  assert.equal(response.isError, undefined);
  assert.deepEqual(calls, [[[7, 9], { bodyId: 7, faceId: "17f1" }, { bodyId: 8, faceId: "18f1" }, "opposed", 2, "r1"]]);

  const duplicate = await client.callTool({ name: "plasticity_align_planar_faces", arguments: {
    ids: [7, 7], sourceFace: { bodyId: 7, faceId: "17f1" }, targetFace: { bodyId: 8, faceId: "18f1" }, relation: "opposed", gapMm: 0, revision: "r1",
  } });
  assert.equal(duplicate.isError, true);
  assert.equal(calls.length, 1);
  await client.close(); await server.close();
});

test("MCP forwards exact native face transforms and validates no-op input", async () => {
  const calls: Array<{ name: string; arguments: unknown[] }> = [];
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async moveFaces(...arguments_: unknown[]) { calls.push({ name: "move", arguments: arguments_ }); return state; },
    async rotateFaces(...arguments_: unknown[]) { calls.push({ name: "rotate", arguments: arguments_ }); return state; },
    async scaleFaces(...arguments_: unknown[]) { calls.push({ name: "scale", arguments: arguments_ }); return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "face-transform-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const faces = [{ bodyId: 7, faceId: "17f1" }];

  const results = await Promise.all([
    client.callTool({ name: "plasticity_move_faces", arguments: { faces, deltaMm: [0, 0, 5], revision: "r1" } }),
    client.callTool({ name: "plasticity_rotate_faces", arguments: { faces, pivotMm: [10, 0, 10], axis: [0, 1, 0], degrees: -10, revision: "r1" } }),
    client.callTool({ name: "plasticity_scale_faces", arguments: { faces, pivotMm: [0, 0, 0], factors: [2, 2, 1], revision: "r1" } }),
  ]);
  assert(results.every((response) => response.isError === undefined));
  assert.deepEqual(calls, [
    { name: "move", arguments: [faces, [0, 0, 5], "r1"] },
    { name: "rotate", arguments: [faces, [10, 0, 10], [0, 1, 0], -10, "r1"] },
    { name: "scale", arguments: [faces, [0, 0, 0], [2, 2, 1], "r1"] },
  ]);

  const noMove = await client.callTool({ name: "plasticity_move_faces", arguments: { faces, deltaMm: [0, 0, 0], revision: "r1" } });
  const noRotate = await client.callTool({ name: "plasticity_rotate_faces", arguments: { faces, pivotMm: [0, 0, 0], axis: [0, 0, 1], degrees: 0, revision: "r1" } });
  const noScale = await client.callTool({ name: "plasticity_scale_faces", arguments: { faces, pivotMm: [0, 0, 0], factors: [1, 1, 1], revision: "r1" } });
  assert.equal(noMove.isError, true);
  assert.equal(noRotate.isError, true);
  assert.equal(noScale.isError, true);
  assert.equal(calls.length, 3);
  await client.close(); await server.close();
});

test("MCP forwards native face thickening, face-loop offsets, and Solid loop patches", async () => {
  const calls: Array<{ name: string; arguments: unknown[] }> = [];
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async thickenFaces(...arguments_: unknown[]) { calls.push({ name: "thicken", arguments: arguments_ }); return state; },
    async offsetFaceLoops(...arguments_: unknown[]) { calls.push({ name: "offset-loops", arguments: arguments_ }); return state; },
    async patchSolidEdgeLoops(...arguments_: unknown[]) { calls.push({ name: "patch-loops", arguments: arguments_ }); return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "face-construction-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const faces = [{ bodyId: 7, faceId: "17f1" }];
  const edges = [{ bodyId: 7, edgeId: "17e1" }];

  const results = await Promise.all([
    client.callTool({ name: "plasticity_thicken_faces", arguments: { faces, frontMm: 2, backMm: 1, revision: "r1" } }),
    client.callTool({ name: "plasticity_offset_face_loops", arguments: { faces, distanceMm: -2, individual: false, revision: "r2" } }),
    client.callTool({ name: "plasticity_patch_solid_edge_loops", arguments: { edges, revision: "r3" } }),
  ]);
  assert(results.every((response) => response.isError === undefined));
  assert.deepEqual(calls, [
    { name: "thicken", arguments: [faces, 2, 1, "r1"] },
    { name: "offset-loops", arguments: [faces, -2, false, "r2"] },
    { name: "patch-loops", arguments: [edges, "r3"] },
  ]);

  const zeroThickness = await client.callTool({ name: "plasticity_thicken_faces", arguments: { faces, frontMm: 0, backMm: 0, revision: "r1" } });
  const zeroOffset = await client.callTool({ name: "plasticity_offset_face_loops", arguments: { faces, distanceMm: 0, revision: "r2" } });
  assert.equal(zeroThickness.isError, true);
  assert.equal(zeroOffset.isError, true);
  assert.equal(calls.length, 3);
  await client.close(); await server.close();
});

test("MCP forwards exact native edge edits and validates no-op input", async () => {
  const calls: Array<{ name: string; arguments: unknown[] }> = [];
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async moveEdges(...arguments_: unknown[]) { calls.push({ name: "move", arguments: arguments_ }); return state; },
    async offsetEdges(...arguments_: unknown[]) { calls.push({ name: "offset", arguments: arguments_ }); return state; },
    async deleteEdges(...arguments_: unknown[]) { calls.push({ name: "delete", arguments: arguments_ }); return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "edge-edit-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const edges = [{ bodyId: 7, edgeId: "17e1" }];

  const moved = await client.callTool({ name: "plasticity_move_edges", arguments: { edges, deltaMm: [0, 0, 5], revision: "r1" } });
  const offset = await client.callTool({ name: "plasticity_offset_edges", arguments: { edges, distanceMm: -2, revision: "r2" } });
  const deleted = await client.callTool({ name: "plasticity_delete_edges", arguments: { edges, revision: "r3" } });
  assert.equal(moved.isError, undefined);
  assert.equal(offset.isError, undefined);
  assert.equal(deleted.isError, undefined);
  assert.deepEqual(calls, [
    { name: "move", arguments: [edges, [0, 0, 5], "r1"] },
    { name: "offset", arguments: [edges, -2, "r2"] },
    { name: "delete", arguments: [edges, "r3"] },
  ]);

  const noMove = await client.callTool({ name: "plasticity_move_edges", arguments: { edges, deltaMm: [0, 0, 0], revision: "r1" } });
  const noOffset = await client.callTool({ name: "plasticity_offset_edges", arguments: { edges, distanceMm: 0, revision: "r1" } });
  assert.equal(noMove.isError, true);
  assert.equal(noOffset.isError, true);
  assert.equal(calls.length, 3);
  await client.close(); await server.close();
});

test("MCP forwards exact native shell-vertex offsets and validates input", async () => {
  const calls: unknown[][] = [];
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async offsetVertices(...arguments_: unknown[]) { calls.push(arguments_); return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "vertex-offset-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const vertices = [{ bodyId: 7, vertexId: 101 }, { bodyId: 7, vertexId: 102 }];

  const result = await client.callTool({ name: "plasticity_offset_vertices", arguments: { vertices, distanceMm: 5, revision: "r1" } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [[vertices, 5, "r1"]]);

  const zero = await client.callTool({ name: "plasticity_offset_vertices", arguments: { vertices, distanceMm: 0, revision: "r1" } });
  const duplicate = await client.callTool({ name: "plasticity_offset_vertices", arguments: { vertices: [vertices[0], vertices[0]], distanceMm: 5, revision: "r1" } });
  assert.equal(zero.isError, true);
  assert.equal(duplicate.isError, true);
  assert.equal(calls.length, 1);
  await client.close(); await server.close();
});

test("MCP forwards native rectangular and radial face patterns", async () => {
  const calls: Array<{ name: string; arguments: unknown[] }> = [];
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async rectangularFacePattern(...arguments_: unknown[]) { calls.push({ name: "rectangular", arguments: arguments_ }); return state; },
    async radialFacePattern(...arguments_: unknown[]) { calls.push({ name: "radial", arguments: arguments_ }); return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "face-pattern-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const faces = [{ bodyId: 7, faceId: "17f1" }, { bodyId: 7, faceId: "17f2" }];

  const rectangular = await client.callTool({ name: "plasticity_rectangular_face_pattern", arguments: { faces, direction1: [1, 0, 0], count1: 3, spacing1Mm: 15, direction2: [0, 1, 0], count2: 2, spacing2Mm: 10, revision: "r1" } });
  const radial = await client.callTool({ name: "plasticity_radial_face_pattern", arguments: { faces, centerMm: [30, 30, 0], axis: [0, 0, 1], count: 4, sweepDegrees: 360, revision: "r2" } });
  assert.equal(rectangular.isError, undefined);
  assert.equal(radial.isError, undefined);
  assert.deepEqual(calls, [
    { name: "rectangular", arguments: [faces, [1, 0, 0], 3, 15, [0, 1, 0], 2, 10, "r1"] },
    { name: "radial", arguments: [faces, [30, 30, 0], [0, 0, 1], 4, 360, "r2"] },
  ]);

  const zeroSpacing = await client.callTool({ name: "plasticity_rectangular_face_pattern", arguments: { faces, direction1: [1, 0, 0], count1: 3, spacing1Mm: 15, direction2: [0, 1, 0], count2: 2, spacing2Mm: 0, revision: "r1" } });
  const tooWideSweep = await client.callTool({ name: "plasticity_radial_face_pattern", arguments: { faces, centerMm: [0, 0, 0], axis: [0, 0, 1], count: 4, sweepDegrees: 361, revision: "r2" } });
  assert.equal(zeroSpacing.isError, true);
  assert.equal(tooWideSweep.isError, true);
  assert.equal(calls.length, 2);
  await client.close(); await server.close();
});

test("MCP forwards cylindrical-axis alignment modes and validates axial offsets", async () => {
  const calls: unknown[][] = [];
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async alignCylindricalFaces(...arguments_: unknown[]) { calls.push(arguments_); return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "cylindrical-alignment-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const response = await client.callTool({ name: "plasticity_align_cylindrical_faces", arguments: {
    ids: [7, 9], sourceFace: { bodyId: 7, faceId: "17f1" }, targetFace: { bodyId: 8, faceId: "18f1" },
    relation: "same", axialMode: "anchor", axialOffsetMm: 2, rotationAroundAxisDeg: 90,
    intent: "Align a bolt with its hole", revision: "r1",
  } });
  assert.equal(response.isError, undefined);
  assert.deepEqual(calls, [[[7, 9], { bodyId: 7, faceId: "17f1" }, { bodyId: 8, faceId: "18f1" }, "same", "anchor", 2, 90, "r1"]]);

  const invalid = await client.callTool({ name: "plasticity_align_cylindrical_faces", arguments: {
    ids: [7], sourceFace: { bodyId: 7, faceId: "17f1" }, targetFace: { bodyId: 8, faceId: "18f1" },
    relation: "same", axialMode: "preserve", axialOffsetMm: 2, revision: "r1",
  } });
  assert.equal(invalid.isError, true);
  assert.equal(calls.length, 1);
  await client.close(); await server.close();
});

test("MCP forwards exact vertex and linear-edge assembly alignments", async () => {
  const calls: Array<{ name: string; arguments: unknown[] }> = [];
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async alignVertices(...arguments_: unknown[]) { calls.push({ name: "vertices", arguments: arguments_ }); return state; },
    async alignLinearEdges(...arguments_: unknown[]) { calls.push({ name: "edges", arguments: arguments_ }); return state; },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "topology-alignment-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const vertexResponse = await client.callTool({ name: "plasticity_align_vertices", arguments: {
    ids: [7, 9], sourceVertex: { bodyId: 7, vertexId: 101 }, targetVertex: { bodyId: 8, vertexId: 201 },
    offsetMm: [1, 2, 3], intent: "Place exact corners", revision: "r1",
  } });
  const edgeResponse = await client.callTool({ name: "plasticity_align_linear_edges", arguments: {
    ids: [7], sourceEdge: { bodyId: 7, edgeId: "17e1" }, targetEdge: { bodyId: 8, edgeId: "18e1" },
    relation: "opposed", axialOffsetMm: 4, rotationAroundAxisDeg: 30, intent: "Seat straight edges", revision: "r2",
  } });
  assert.equal(vertexResponse.isError, undefined);
  assert.equal(edgeResponse.isError, undefined);
  assert.deepEqual(calls, [
    { name: "vertices", arguments: [[7, 9], { bodyId: 7, vertexId: 101 }, { bodyId: 8, vertexId: 201 }, [1, 2, 3], "r1"] },
    { name: "edges", arguments: [[7], { bodyId: 7, edgeId: "17e1" }, { bodyId: 8, edgeId: "18e1" }, "opposed", 4, 30, "r2"] },
  ]);

  const duplicateBodies = await client.callTool({ name: "plasticity_align_vertices", arguments: {
    ids: [7, 7], sourceVertex: { bodyId: 7, vertexId: 101 }, targetVertex: { bodyId: 8, vertexId: 201 }, revision: "r1",
  } });
  const zeroBody = await client.callTool({ name: "plasticity_align_linear_edges", arguments: {
    ids: [], sourceEdge: { bodyId: 7, edgeId: "17e1" }, targetEdge: { bodyId: 8, edgeId: "18e1" }, revision: "r2",
  } });
  assert.equal(duplicateBodies.isError, true);
  assert.equal(zeroBody.isError, true);
  assert.equal(calls.length, 2);
  await client.close(); await server.close();
});

test("plasticity_status returns compact body summaries while exact topology stays in list_bodies", async () => {
  const body: RuntimeState["bodies"][number] = {
    id: 7,
    versionId: 70,
    type: "Solid",
    name: "Bracket",
    boundsMm: { min: [0, 0, 0], max: [20, 10, 5] },
    faceIds: ["f1"],
    edgeIds: ["e1"],
    faces: [{
      id: "f1", surfaceType: "Plane", planar: true, centerMm: [10, 5, 5], normal: [0, 0, 1],
      radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null,
      boundsMm: { min: [0, 0, 5], max: [20, 10, 5] }, edgeIds: ["e1", "e2"],
    }],
    edges: [{
      id: "e1", curveType: "Line", line: true, circle: false, lengthMm: 20,
      centerMm: [10, 0, 0], tangent: [1, 0, 0], boundsMm: { min: [0, 0, 0], max: [20, 0, 0] },
      faceIds: ["f1"], vertexIds: [1, 2],
    }],
    vertices: [{ id: 1, positionMm: [0, 0, 0], edgeIds: ["e1"], faceIds: ["f1"] }],
  };
  let state = { ...emptyState(), bodies: [body, { ...body, id: 8, versionId: 80, name: "Second body" }] };
  const beforeState = { ...emptyState(), revision: "r0", bodies: [
    { ...body, id: 8, versionId: 79, name: "Old second body" },
    { ...body, id: 9, versionId: 90, name: "Removed body" },
  ] };
  const sceneDiff = diffScenes(beforeState, state);
  const operations = { async state() { return state; } } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot(label?: string) { return { snapshotId: "00000000-0000-4000-8000-000000000001", label: label ?? null, capturedAt: "2026-09-26T00:00:00.000Z", state, datums: [] }; }, async changesSince() { return { snapshotId: "00000000-0000-4000-8000-000000000001", label: null, capturedAt: "2026-09-26T00:00:00.000Z", diff: sceneDiff, selection: [], current: state }; }, async waitForChange() { return { timedOut: false, snapshotId: "00000000-0000-4000-8000-000000000001", label: null, capturedAt: "2026-09-26T00:00:00.000Z", diff: sceneDiff, selection: [], current: state }; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "compact-status-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const tools = await client.listTools();
  const connectTool = tools.tools.find((tool) => tool.name === "plasticity_connect");
  assert.match(connectTool?.description ?? "", /compact initial scene summary/i);
  const statusTool = tools.tools.find((tool) => tool.name === "plasticity_status");
  assert.match(statusTool?.description ?? "", /compact document summary/i);
  assert.match(statusTool?.description ?? "", /plasticity_body_info.*plasticity_list_bodies/i);
  assert.match(statusTool?.description ?? "", /expectedRevision/);
  assert(tools.tools.some((tool) => tool.name === "plasticity_body_info"));
  const connectResponse = await client.callTool({ name: "plasticity_connect", arguments: { targetId: "window-1" } });
  const connected = JSON.parse((connectResponse.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "null");
  assert.equal(connected.revision, "r1");
  assert.deepEqual(connected.bodyPagination, { offset: 0, limit: 50, total: 2, nextOffset: null });
  assert.equal("faces" in connected.bodies[0], false, "Connect response must not include full body topology");
  assert.equal("edges" in connected.bodies[0], false);
  const response = await client.callTool({ name: "plasticity_status", arguments: {} });
  assert.equal(response.isError, undefined);
  const result = JSON.parse((response.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "null");
  assert.equal(result.documentToken, "doc-1");
  assert.equal(result.revision, "r1");
  assert.deepEqual(result.bodyPagination, { offset: 0, limit: 50, total: 2, nextOffset: null });
  assert.deepEqual(result.bodies, [{
    id: 7, versionId: 70, type: "Solid", name: "Bracket", boundsMm: body.boundsMm,
    faceCount: 1, edgeCount: 1, vertexCount: 1,
  }, {
    id: 8, versionId: 80, type: "Solid", name: "Second body", boundsMm: body.boundsMm,
    faceCount: 1, edgeCount: 1, vertexCount: 1,
  }]);
  assert.equal("faces" in result.bodies[0], false);
  assert.equal("edges" in result.bodies[0], false);
  assert.equal("vertices" in result.bodies[0], false);
  assert.equal(result.undoDepth, 0);
  assert.equal(result.redoDepth, 0);

  const snapshotResponse = await client.callTool({ name: "plasticity_capture_snapshot", arguments: { label: "pre-edit" } });
  const snapshot = JSON.parse((snapshotResponse.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "null");
  assert.equal(snapshot.revision, "r1");
  assert.equal(snapshot.bodyCount, 2);
  assert.equal(snapshot.trackedDatumCount, 0);
  assert.equal("state" in snapshot, false);

  const firstPageResponse = await client.callTool({ name: "plasticity_status", arguments: { bodyOffset: 0, bodyLimit: 1 } });
  const firstPage = JSON.parse((firstPageResponse.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "null");
  assert.deepEqual(firstPage.bodyPagination, { offset: 0, limit: 1, total: 2, nextOffset: 1 });
  assert.deepEqual(firstPage.bodies.map((item: { id: number }) => item.id), [7]);
  const secondPageResponse = await client.callTool({ name: "plasticity_status", arguments: { bodyOffset: 1, bodyLimit: 1, expectedRevision: firstPage.revision } });
  const secondPage = JSON.parse((secondPageResponse.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "null");
  assert.deepEqual(secondPage.bodyPagination, { offset: 1, limit: 1, total: 2, nextOffset: null });
  assert.deepEqual(secondPage.bodies.map((item: { id: number }) => item.id), [8]);
  const stalePageResponse = await client.callTool({ name: "plasticity_status", arguments: { bodyOffset: 1, bodyLimit: 1, expectedRevision: "stale-revision" } });
  assert.equal(stalePageResponse.isError, true);
  assert.match(JSON.stringify(stalePageResponse.content), /CAD revision changed between status pages/i);

  const detailedResponse = await client.callTool({ name: "plasticity_list_bodies", arguments: {} });
  const detailed = JSON.parse((detailedResponse.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "null");
  assert.equal(detailed.revision, "r1");
  assert.deepEqual(detailed.bodyPagination, { offset: 0, limit: 10, total: 2, nextOffset: null });
  assert.equal(detailed.bodies.length, 2);
  assert.equal(detailed.bodies[0].faces.length, 1);
  assert.equal(detailed.bodies[0].edges.length, 1);
  assert.equal(detailed.bodies[0].vertices.length, 1);
  const detailedFirstPageResponse = await client.callTool({ name: "plasticity_list_bodies", arguments: { bodyOffset: 0, bodyLimit: 1 } });
  const detailedFirstPage = JSON.parse((detailedFirstPageResponse.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "null");
  assert.deepEqual(detailedFirstPage.bodyPagination, { offset: 0, limit: 1, total: 2, nextOffset: 1 });
  assert.deepEqual(detailedFirstPage.bodies.map((item: { id: number }) => item.id), [7]);
  const detailedSecondPageResponse = await client.callTool({ name: "plasticity_list_bodies", arguments: { bodyOffset: 1, bodyLimit: 1, expectedRevision: detailedFirstPage.revision } });
  const detailedSecondPage = JSON.parse((detailedSecondPageResponse.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "null");
  assert.deepEqual(detailedSecondPage.bodyPagination, { offset: 1, limit: 1, total: 2, nextOffset: null });
  assert.deepEqual(detailedSecondPage.bodies.map((item: { id: number }) => item.id), [8]);
  const staleDetailedPageResponse = await client.callTool({ name: "plasticity_list_bodies", arguments: { bodyOffset: 1, bodyLimit: 1, expectedRevision: "stale-revision" } });
  assert.equal(staleDetailedPageResponse.isError, true);
  assert.match(JSON.stringify(staleDetailedPageResponse.content), /CAD revision changed between body pages/i);
  state = { ...state, revision: `revision-${"x".repeat(240)}` };
  const longRevisionPageResponse = await client.callTool({ name: "plasticity_list_bodies", arguments: { bodyOffset: 1, bodyLimit: 1, expectedRevision: state.revision } });
  assert.equal(longRevisionPageResponse.isError, undefined, "Plasticity's composite revision token can exceed ordinary identifier lengths");
  state = { ...state, revision: "r1" };

  const changesTool = tools.tools.find((tool) => tool.name === "plasticity_changes_since");
  assert.match(changesTool?.description ?? "", /changed-body B-Rep descriptors are summarized and paginated/i);
  const changesResponse = await client.callTool({ name: "plasticity_changes_since", arguments: { snapshotId: "00000000-0000-4000-8000-000000000001", bodyOffset: 0, bodyLimit: 1 } });
  const changes = JSON.parse((changesResponse.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "null");
  assert.equal(changes.diff.sceneChanged, true);
  assert.deepEqual(changes.bodyPagination, { offset: 0, limit: 1, total: 3, nextOffset: 1 });
  assert.deepEqual(changes.diff.added.map((item: { id: number }) => item.id), [7]);
  assert.equal(changes.diff.added[0].faceCount, 1);
  assert.equal("faces" in changes.diff.added[0], false);
  assert.equal("bodies" in changes.current, false);
  const nextChangesResponse = await client.callTool({ name: "plasticity_changes_since", arguments: { snapshotId: "00000000-0000-4000-8000-000000000001", bodyOffset: 1, bodyLimit: 1, expectedRevision: "r1" } });
  const nextChanges = JSON.parse((nextChangesResponse.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "null");
  assert.deepEqual(nextChanges.diff.removed.map((item: { id: number }) => item.id), [9]);
  const finalChangesResponse = await client.callTool({ name: "plasticity_changes_since", arguments: { snapshotId: "00000000-0000-4000-8000-000000000001", bodyOffset: 2, bodyLimit: 1, expectedRevision: "r1" } });
  const finalChanges = JSON.parse((finalChangesResponse.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "null");
  assert.deepEqual(finalChanges.diff.modified.map((item: { id: number }) => item.id), [8]);
  assert.equal(finalChanges.diff.modified[0].geometryChanged, true);
  assert.equal("faces" in finalChanges.diff.modified[0].before, false);
  const staleChangesResponse = await client.callTool({ name: "plasticity_changes_since", arguments: { snapshotId: "00000000-0000-4000-8000-000000000001", bodyOffset: 1, bodyLimit: 1, expectedRevision: "stale-revision" } });
  assert.equal(staleChangesResponse.isError, true);
  const waitedChangesResponse = await client.callTool({ name: "plasticity_wait_for_change", arguments: { snapshotId: "00000000-0000-4000-8000-000000000001", bodyOffset: 0, bodyLimit: 1 } });
  const waitedChanges = JSON.parse((waitedChangesResponse.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "null");
  assert.equal(waitedChanges.timedOut, false);
  assert.deepEqual(waitedChanges.bodyPagination, { offset: 0, limit: 1, total: 3, nextOffset: 1 });
  assert.deepEqual(waitedChanges.diff.added.map((item: { id: number }) => item.id), [7]);

  await client.close(); await server.close();
});

test("MCP exposes read-only exact body interference checks and rejects ambiguous pairs", async () => {
  const calls: unknown[][] = [];
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async checkInterference(...arguments_: unknown[]) {
      calls.push(arguments_);
      return { sessionId: "session-1", documentToken: "doc-1", revision: "r1", source: "native-brep-temporary-intersection", pairs: [] };
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "interference-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const listed = await client.listTools();
  const descriptor = listed.tools.find((tool) => tool.name === "plasticity_check_interference");
  assert.equal(descriptor?.annotations?.readOnlyHint, true);
  assert.equal(descriptor?.annotations?.destructiveHint, false);
  assert.match(descriptor?.description ?? "", /does not distinguish touching from separation/i);
  const response = await client.callTool({ name: "plasticity_check_interference", arguments: {
    pairs: [{ firstBodyId: 7, secondBodyId: 8 }], revision: "r1",
  } });
  assert.equal(response.isError, undefined);
  assert.deepEqual(calls, [[[ { firstBodyId: 7, secondBodyId: 8 } ], "r1"]]);

  const duplicate = await client.callTool({ name: "plasticity_check_interference", arguments: {
    pairs: [{ firstBodyId: 7, secondBodyId: 8 }, { firstBodyId: 8, secondBodyId: 7 }], revision: "r1",
  } });
  const self = await client.callTool({ name: "plasticity_check_interference", arguments: {
    pairs: [{ firstBodyId: 7, secondBodyId: 7 }], revision: "r1",
  } });
  assert.equal(duplicate.isError, true);
  assert.equal(self.isError, true);
  assert.equal(calls.length, 1);
  await client.close(); await server.close();
});

test("MCP exposes read-only exact solid properties with unique current body IDs", async () => {
  const calls: unknown[][] = [];
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async measureSolidProperties(...arguments_: unknown[]) {
      calls.push(arguments_);
      return {
        sessionId: "session-1", documentToken: "doc-1", revision: "r1",
        source: "native-brep-mass-properties", bodies: [],
        totals: { volumeMm3: 0, surfaceAreaMm2: 0, volumeWeightedCentroidMm: [0, 0, 0] },
      };
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "solid-properties-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const listed = await client.listTools();
  const descriptor = listed.tools.find((tool) => tool.name === "plasticity_measure_solid_properties");
  assert.equal(descriptor?.annotations?.readOnlyHint, true);
  assert.equal(descriptor?.annotations?.destructiveHint, false);
  assert.match(descriptor?.description ?? "", /native B-Rep/i);
  const response = await client.callTool({ name: "plasticity_measure_solid_properties", arguments: {
    ids: [8, 7], revision: "r1",
  } });
  assert.equal(response.isError, undefined);
  assert.deepEqual(calls, [[[8, 7], "r1"]]);

  const duplicate = await client.callTool({ name: "plasticity_measure_solid_properties", arguments: {
    ids: [7, 7], revision: "r1",
  } });
  assert.equal(duplicate.isError, true);
  assert.equal(calls.length, 1);
  await client.close(); await server.close();
});

test("MCP exposes read-only exact face properties with unique current topology references", async () => {
  const calls: unknown[][] = [];
  const state = emptyState();
  const operations = {
    async state() { return state; },
    async measureFaceProperties(...arguments_: unknown[]) {
      calls.push(arguments_);
      return {
        sessionId: "session-1", documentToken: "doc-1", revision: "r1",
        source: "native-brep-face-mass-properties", faces: [],
        totals: { areaMm2: 0, summedBoundaryLengthMm: 0, areaWeightedCentroidMm: [0, 0, 0] },
      };
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "face-properties-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const listed = await client.listTools();
  const descriptor = listed.tools.find((tool) => tool.name === "plasticity_measure_face_properties");
  assert.equal(descriptor?.annotations?.readOnlyHint, true);
  assert.equal(descriptor?.annotations?.destructiveHint, false);
  assert.match(descriptor?.description ?? "", /native B-Rep/i);
  const response = await client.callTool({ name: "plasticity_measure_face_properties", arguments: {
    faces: [{ bodyId: 8, faceId: "18f2" }, { bodyId: 7, faceId: "17f1" }], revision: "r1",
  } });
  assert.equal(response.isError, undefined);
  assert.deepEqual(calls, [[[{ bodyId: 8, faceId: "18f2" }, { bodyId: 7, faceId: "17f1" }], "r1"]]);

  const duplicate = await client.callTool({ name: "plasticity_measure_face_properties", arguments: {
    faces: [{ bodyId: 7, faceId: "17f1" }, { bodyId: 7, faceId: "17f1" }], revision: "r1",
  } });
  assert.equal(duplicate.isError, true);
  assert.equal(calls.length, 1);
  await client.close(); await server.close();
});

test("server close releases the isolated analysis client", async () => {
  let analysisClosed = false;
  let sessionClosed = false;
  const fake = {
    async windows() { return []; },
    async connect() { return {}; },
    get() { throw new Error("not connected"); },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; },
    async changesSince() { return {}; },
    async waitForChange() { return {}; },
    async close() { sessionClosed = true; },
  } satisfies SessionLike;
  const analysis: AnalysisClient = {
    async fingerprintImages() { return []; },
    async run() { throw new Error("not called"); },
    async close() { analysisClosed = true; },
  };
  const server = createServer(fake, strengthDependenciesForSession(fake, { analysis }));
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  await server.close();

  assert.equal(analysisClosed, true);
  assert.equal(sessionClosed, true);
});

test("a pending Codex analysis does not block other MCP tools", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "plasticity-mcp-analysis-concurrency-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let completeAnalysis!: (result: {
    observations: [];
    proposedMethod: null;
    questions: [];
    unsupportedConditions: [];
    designInterpretation: null;
  }) => void;
  const analysisResult = new Promise<{
    observations: [];
    proposedMethod: null;
    questions: [];
    unsupportedConditions: [];
    designInterpretation: null;
  }>((resolve) => { completeAnalysis = resolve; });
  const fake = {
    async windows() { return [{ id: "window-1", title: "Untitled - Plasticity", url: "file:///app_window/index.html" }]; },
    async connect() { return {}; },
    get() { throw new Error("not connected"); },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; },
    async changesSince() { return {}; },
    async waitForChange() { return {}; },
  } satisfies SessionLike;
  const store = new StrengthStore(join(root, "strength"));
  const analysis: AnalysisClient = {
    async fingerprintImages() { return []; },
    async run(_input, options) {
      markStarted();
      return await Promise.race([
        analysisResult,
        new Promise<never>((_, reject) => options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
      ]);
    },
    async close() {},
  };
  const server = createServer(fake, strengthDependenciesForSession(fake, {
    analysis,
    store,
    femReports: new FemReportStore(join(root, "fem")),
  }));
  const client = new Client({ name: "analysis-concurrency-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const runningAnalysis = client.callTool({
      name: "plasticity_analyze_strength_task",
      arguments: { requestId: "pending-analysis", prompt: "Inspect the evidence", imagePaths: [], evidence: [], answers: [] },
    });
    let startTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      started,
      new Promise<never>((_, reject) => { startTimer = setTimeout(() => reject(new Error("Codex analysis did not start")), 1_000); }),
    ]).finally(() => { if (startTimer) clearTimeout(startTimer); });
    const listWindows = client.callTool({ name: "plasticity_list_windows", arguments: {} });
    let timer: NodeJS.Timeout | undefined;
    const response = await Promise.race([
      listWindows,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MCP tools were blocked by the pending analysis")), 1_000); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    assert.equal(response.isError, undefined);
    const content = (response as { content?: unknown }).content;
    assert.ok(Array.isArray(content));
    const textContent = content.find((item: unknown): item is { type: string; text?: string } =>
      typeof item === "object" && item !== null && "type" in item && item.type === "text");
    const windows = JSON.parse(textContent?.text ?? "[]") as Array<{ targetId: string }>;
    assert.deepEqual(windows.map((window) => window.targetId), ["window-1"]);

    completeAnalysis({ observations: [], proposedMethod: null, questions: [], unsupportedConditions: [], designInterpretation: null });
    const completed = await runningAnalysis;
    assert.equal(completed.isError, undefined);
  } finally {
    completeAnalysis({ observations: [], proposedMethod: null, questions: [], unsupportedConditions: [], designInterpretation: null });
    await client.close();
    await server.close();
  }
});

test("construction tools validate strict definitions and protect standard planes before mutation", async () => {
  let mutated = false;
  const nativeBindings = Array.from({ length: 250 }, (_, index) => `ExtrudeFactory${index}`);
  const top = {
    id: "standard:top",
    nativeId: "top",
    name: "Top",
    source: "standard" as const,
    ...frameFromOriginNormalX([0, 0, 0], [0, 0, 1], [1, 0, 0]),
  };
  const state: RuntimeState = {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [],
    construction: { planes: [top], activePlaneId: top.id, planeStateToken: "p1", viewStateToken: "v1" }, bodies: [],
  };
  const runtime = {
    getCapabilities() { return []; },
    async getState() { return state; },
    async mutate() { mutated = true; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-1");
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations; },
    capabilities() { return { bindings: nativeBindings, operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const invalidCalls = [
    client.callTool({ name: "plasticity_define_datum_axis", arguments: { revision: "r1", definition: { type: "origin-direction", originMm: [0, 0, 0], direction: [0, 0, 0] } } }),
    client.callTool({ name: "plasticity_define_datum_axis", arguments: { revision: "r1", definition: { type: "two-points", firstId: "p", secondId: "p" } } }),
    client.callTool({ name: "plasticity_set_workplane", arguments: { plane: { id: "standard:top" } } }),
    client.callTool({ name: "plasticity_create_construction_plane", arguments: { revision: "r1", definition: { type: "unknown" } } }),
    client.callTool({ name: "plasticity_remove_construction_plane", arguments: { plane: { id: "standard:top", sessionId: "session-1", documentToken: "doc-1", revision: "r1" } } }),
  ];
  for (const call of invalidCalls) assert.equal((await call).isError, true);
  assert.equal(mutated, false);

  const capabilities = parseToolJson(await client.callTool({ name: "plasticity_capabilities", arguments: { limit: 50 } })) as {
    totalBindings: number; matchingBindings: number; offset: number; limit: number; nextOffset: number | null;
    bindings: string[]; operations: Record<string, unknown>;
  };
  assert.equal(capabilities.totalBindings, 250);
  assert.equal(capabilities.matchingBindings, 250);
  assert.equal(capabilities.offset, 0);
  assert.equal(capabilities.limit, 50);
  assert.equal(capabilities.bindings.length, 50);
  assert.equal(capabilities.nextOffset, 50);
  assert.ok(capabilities.operations.constructionPlanes);
  const defaultCapabilities = parseToolJson(await client.callTool({ name: "plasticity_capabilities", arguments: {} })) as {
    limit: number; bindings: string[]; nextOffset: number | null;
  };
  assert.equal(defaultCapabilities.limit, 100);
  assert.equal(defaultCapabilities.bindings.length, 100);
  assert.equal(defaultCapabilities.nextOffset, 100);
  const filteredCapabilities = parseToolJson(await client.callTool({
    name: "plasticity_capabilities", arguments: { query: "Factory24", limit: 25, offset: 0 },
  })) as { matchingBindings: number; bindings: string[]; nextOffset: number | null };
  assert.equal(filteredCapabilities.matchingBindings, 11);
  assert.ok(filteredCapabilities.bindings.every((binding) => binding.includes("Factory24")));
  assert.equal(filteredCapabilities.nextOffset, null);
  await client.close(); await server.close();
});

test("records uncertain construction outcomes and reconciles without resubmitting", async () => {
  const state = emptyState();
  let submissions = 0;
  let reconciliations = 0;
  const operations = {
    runtime: { async reconcile() { reconciliations += 1; return state; } },
    async state() { return state; },
    async createConstructionPlane() {
      submissions += 1;
      throw new Error(submissions === 1
        ? "CDP request timed out after dispatch"
        : "Curve vertex conversion requires interior or closed Wire vertices: 7:42");
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const failed = await client.callTool({ name: "plasticity_create_construction_plane", arguments: {
    revision: "r1", name: " uncertain ",
    definition: { type: "explicit", originMm: [0, 0, 0], normal: [0, 0, 1], xDirection: [1, 0, 0] },
  } });
  assert.equal(failed.isError, true);
  const journal = await client.callTool({ name: "plasticity_construction_journal", arguments: {} });
  const journalText = (journal.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const journalValue = JSON.parse(journalText ?? "null");
  assert.equal(journalValue.entries[0].status, "unknown");
  assert.equal(journalValue.entries[0].afterRevision, "r1");
  assert.equal(journalValue.entries[0].diff.changed, false);
  const rejected = await client.callTool({ name: "plasticity_create_construction_plane", arguments: {
    revision: "r1", name: "rejected",
    definition: { type: "explicit", originMm: [0, 0, 0], normal: [0, 0, 1], xDirection: [1, 0, 0] },
  } });
  assert.equal(rejected.isError, true);
  const journalAfterRejection = await client.callTool({ name: "plasticity_construction_journal", arguments: {} });
  const journalAfterRejectionText = (journalAfterRejection.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const journalAfterRejectionValue = JSON.parse(journalAfterRejectionText ?? "null");
  assert.equal(journalAfterRejectionValue.entries[1].status, "failed");
  const reconciled = await client.callTool({ name: "plasticity_reconcile", arguments: {} });
  assert.equal(reconciled.isError, undefined);
  assert.equal(submissions, 2);
  assert.equal(reconciliations, 1);
  await client.close(); await server.close();
});

test("executes and journals a counterbore recipe through MCP", async () => {
  const target: RuntimeState["bodies"][number] = {
    id: 7, versionId: 70, type: "Solid", name: "Plate", boundsMm: { min: [0, 0, 0], max: [20, 20, 8] },
    faceIds: [], edgeIds: [], faces: [], edges: [],
  };
  let state = { ...emptyState(), bodies: [target] };
  const cylinderCalls: Array<{ revision: string | undefined; radiusMm: number; heightMm: number }> = [];
  const operations = {
    async state() { return state; },
    async createCylinder(_centerMm: [number, number, number], radiusMm: number, heightMm: number, _name?: string, current?: string) {
      cylinderCalls.push({ revision: current, radiusMm, heightMm });
      const id = state.bodies.length + 7;
      state = { ...state, revision: `r${cylinderCalls.length + 1}`, bodies: [...state.bodies, { ...target, id, versionId: id, name: null }] };
      return state;
    },
    async boolean(_targets: number[], tools: number[], _operation: string, _keep: boolean, current: string) {
      assert.equal(current, "r3");
      state = { ...state, revision: "r4", bodies: state.bodies.filter((body) => !tools.includes(body.id)) };
      return state;
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const created = await client.callTool({ name: "plasticity_create_counterbore", arguments: {
    targetId: 7, entryCenterMm: [10, 10, 8], axis: [0, 0, -1],
    throughDiameterMm: 4, counterboreDiameterMm: 8,
    counterboreDepthMm: 3, throughDepthMm: 8, revision: "r1",
  } });
  assert.equal(created.isError, undefined);
  const createdText = (created.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  assert.equal(JSON.parse(createdText ?? "null").undoSteps, 3);
  assert.deepEqual(cylinderCalls, [
    { revision: "r1", radiusMm: 2, heightMm: 9 },
    { revision: "r2", radiusMm: 4, heightMm: 3.5 },
  ]);
  const journal = await client.callTool({ name: "plasticity_construction_journal", arguments: {} });
  const journalText = (journal.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const journalValue = JSON.parse(journalText ?? "null");
  assert.equal(journalValue.entries[0].operation, "recipe-counterbore");
  assert.equal(journalValue.entries[0].status, "completed");
  assert.equal(journalValue.entries[0].afterRevision, "r4");

  await client.close(); await server.close();
});

test("executes and journals a multi-center counterbore pattern through MCP", async () => {
  const target: RuntimeState["bodies"][number] = {
    id: 7, versionId: 70, type: "Solid", name: "Plate", boundsMm: { min: [0, 0, 0], max: [40, 20, 8] },
    faceIds: [], edgeIds: [], faces: [], edges: [],
  };
  let state = { ...emptyState(), bodies: [target] };
  const calls: Array<Record<string, unknown>> = [];
  const operations = {
    async state() { return state; },
    async createCylinder(centerMm: [number, number, number], radiusMm: number, heightMm: number, _name: string | undefined, current: string, axis: [number, number, number]) {
      calls.push({ operation: "createCylinder", centerMm, radiusMm, heightMm, current, axis });
      const id = 8 + calls.length - 1;
      state = { ...state, revision: `r${calls.length + 1}`, bodies: [...state.bodies, { ...target, id, versionId: id, name: null }] };
      return state;
    },
    async boolean(targets: number[], tools: number[], operation: string, keep: boolean, current: string) {
      calls.push({ operation: "boolean", targets, tools, kind: operation, keep, current });
      state = { ...state, revision: "r6", bodies: state.bodies.filter((body) => !tools.includes(body.id)) };
      return state;
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "counterbore-pattern-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const created = await client.callTool({ name: "plasticity_create_counterbore_pattern", arguments: {
    targetId: 7, entryCentersMm: [[10, 10, 8], [30, 10, 8]], axis: [0, 0, -1],
    throughDiameterMm: 4, counterboreDiameterMm: 8,
    counterboreDepthMm: 3, throughDepthMm: 8, revision: "r1",
    intent: "Create two qualified socket-head seats",
  } });
  assert.equal(created.isError, undefined);
  const createdText = (created.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const createdValue = JSON.parse(createdText ?? "null");
  assert.equal(createdValue.recipe, "counterbore-pattern");
  assert.equal(createdValue.holeCount, 2);
  assert.equal(createdValue.undoSteps, 5);
  assert.deepEqual(calls.map((call) => call.operation), ["createCylinder", "createCylinder", "createCylinder", "createCylinder", "boolean"]);
  assert.deepEqual(calls[4], { operation: "boolean", targets: [7], tools: [8, 9, 10, 11], kind: "difference", keep: false, current: "r5" });
  const journal = await client.callTool({ name: "plasticity_construction_journal", arguments: {} });
  const journalText = (journal.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const journalValue = JSON.parse(journalText ?? "null");
  assert.equal(journalValue.entries[0].operation, "recipe-counterbore-pattern");
  assert.equal(journalValue.entries[0].afterRevision, "r6");

  await client.close(); await server.close();
});

test("executes and journals a multi-center countersink pattern through MCP", async () => {
  const target: RuntimeState["bodies"][number] = {
    id: 7, versionId: 70, type: "Solid", name: "Plate", boundsMm: { min: [0, 0, 0], max: [40, 20, 8] },
    faceIds: [], edgeIds: [], faces: [], edges: [],
  };
  let state = { ...emptyState(), bodies: [target] };
  const calls: Array<Record<string, unknown>> = [];
  let nextId = 8;
  let nextRevision = 2;
  const addBody = (type: "Solid" | "Wire") => {
    const id = nextId++;
    state = { ...state, revision: `r${nextRevision++}`, bodies: [...state.bodies, { ...target, id, versionId: id, type, name: null }] };
    return state;
  };
  const operations = {
    async state() { return state; },
    async createCylinder(centerMm: [number, number, number], radiusMm: number, heightMm: number, _name: string | undefined, current: string, axis: [number, number, number]) {
      calls.push({ operation: "createCylinder", centerMm, radiusMm, heightMm, current, axis });
      return addBody("Solid");
    },
    async createPolyline(pointsMm: Array<[number, number, number]>, closed: boolean, current: string) {
      calls.push({ operation: "createPolyline", pointsMm, closed, current });
      return addBody("Wire");
    },
    async revolveProfile(id: number, centerMm: [number, number, number], axis: [number, number, number], angleDegrees: number, current: string) {
      calls.push({ operation: "revolveProfile", id, centerMm, axis, angleDegrees, current });
      return addBody("Solid");
    },
    async boolean(targets: number[], tools: number[], operation: string, keep: boolean, current: string) {
      calls.push({ operation: "boolean", targets, tools, kind: operation, keep, current });
      state = { ...state, revision: `r${nextRevision++}`, bodies: state.bodies.filter((body) => !tools.includes(body.id)) };
      return state;
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "countersink-pattern-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const created = await client.callTool({ name: "plasticity_create_countersink_pattern", arguments: {
    targetId: 7, entryCentersMm: [[10, 10, 8], [30, 10, 8]], axis: [0, 0, -1], radialDirection: [1, 0, 0],
    throughDiameterMm: 5.5, countersinkMajorDiameterMm: 10.4, includedAngleDeg: 90,
    throughDepthMm: 8, revision: "r1", intent: "Create two qualified countersunk seats",
  } });
  assert.equal(created.isError, undefined);
  const createdText = (created.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const createdValue = JSON.parse(createdText ?? "null");
  assert.equal(createdValue.recipe, "countersink-pattern");
  assert.equal(createdValue.holeCount, 2);
  assert.equal(createdValue.undoSteps, 7);
  assert.deepEqual(createdValue.profileBodyIds, [9, 12]);
  assert.deepEqual(calls.map((call) => call.operation), [
    "createCylinder", "createPolyline", "revolveProfile",
    "createCylinder", "createPolyline", "revolveProfile", "boolean",
  ]);
  assert.deepEqual(calls[6], { operation: "boolean", targets: [7], tools: [8, 10, 11, 13], kind: "difference", keep: false, current: "r7" });
  const journal = await client.callTool({ name: "plasticity_construction_journal", arguments: {} });
  const journalText = (journal.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const journalValue = JSON.parse(journalText ?? "null");
  assert.equal(journalValue.entries[0].operation, "recipe-countersink-pattern");
  assert.equal(journalValue.entries[0].afterRevision, "r8");

  await client.close(); await server.close();
});

test("executes and journals a multi-center hex nut pocket pattern through MCP", async () => {
  const target: RuntimeState["bodies"][number] = {
    id: 7, versionId: 70, type: "Solid", name: "Plate", boundsMm: { min: [0, 0, 0], max: [40, 20, 8] },
    faceIds: [], edgeIds: [], faces: [], edges: [],
  };
  let state = { ...emptyState(), bodies: [target] };
  const calls: Array<Record<string, unknown>> = [];
  let nextId = 8;
  let nextRevision = 2;
  const operations = {
    async state() { return state; },
    async createPolyline(pointsMm: Array<[number, number, number]>, closed: boolean, current: string) {
      calls.push({ operation: "createPolyline", pointsMm, closed, current });
      const id = nextId++;
      state = {
        ...state,
        revision: `r${nextRevision++}`,
        bodies: [...state.bodies, { ...target, id, versionId: id, type: "Wire" as const, name: null }],
        regions: [...state.regions, {
          id: `region-${id}`, entityId: id * 10, islandVersionId: id * 10 + 1, sketchId: id * 10 + 2,
          sketchWireIds: [id], measurementSource: "render-mesh" as const,
          displayBoundsMm: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] },
        }],
      };
      return state;
    },
    async extrudeRegions(regionIds: string[], distanceMm: number, current: string) {
      calls.push({ operation: "extrudeRegions", regionIds, distanceMm, current });
      const id = nextId++;
      state = { ...state, revision: `r${nextRevision++}`, bodies: [...state.bodies, { ...target, id, versionId: id, name: null }] };
      return state;
    },
    async boolean(targets: number[], tools: number[], operation: string, keep: boolean, current: string) {
      calls.push({ operation: "boolean", targets, tools, kind: operation, keep, current });
      state = { ...state, revision: `r${nextRevision++}`, bodies: state.bodies.filter((body) => !tools.includes(body.id)) };
      return state;
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "hex-pocket-pattern-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const created = await client.callTool({ name: "plasticity_create_hex_nut_pocket_pattern", arguments: {
    targetId: 7, entryCentersMm: [[10, 10, 8], [30, 10, 8]], axis: [0, 0, -1], flatNormalDirection: [1, 0, 0],
    acrossFlatsMm: 8, pocketDepthMm: 4, materialDepthMm: 8,
    revision: "r1", intent: "Create two qualified captive-nut seats",
  } });
  assert.equal(created.isError, undefined);
  const createdText = (created.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const createdValue = JSON.parse(createdText ?? "null");
  assert.equal(createdValue.recipe, "hex-nut-pocket-pattern");
  assert.equal(createdValue.pocketCount, 2);
  assert.equal(createdValue.undoSteps, 5);
  assert.deepEqual(createdValue.profileBodyIds, [8, 10]);
  assert.deepEqual(calls.map((call) => call.operation), ["createPolyline", "extrudeRegions", "createPolyline", "extrudeRegions", "boolean"]);
  assert.deepEqual(calls[4], { operation: "boolean", targets: [7], tools: [9, 11], kind: "difference", keep: false, current: "r5" });
  const journal = await client.callTool({ name: "plasticity_construction_journal", arguments: {} });
  const journalText = (journal.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const journalValue = JSON.parse(journalText ?? "null");
  assert.equal(journalValue.entries[0].operation, "recipe-hex-nut-pocket-pattern");
  assert.equal(journalValue.entries[0].afterRevision, "r6");

  await client.close(); await server.close();
});

test("executes and journals a dedicated through-hole recipe through MCP", async () => {
  const target: RuntimeState["bodies"][number] = {
    id: 7, versionId: 70, type: "Solid", name: "Plate", boundsMm: { min: [0, 0, 0], max: [20, 20, 8] },
    faceIds: [], edgeIds: [], faces: [], edges: [],
  };
  let state = { ...emptyState(), bodies: [target] };
  const calls: Array<Record<string, unknown>> = [];
  const operations = {
    async state() { return state; },
    async createCylinder(centerMm: [number, number, number], radiusMm: number, heightMm: number, _name: string | undefined, current: string, axis: [number, number, number]) {
      calls.push({ operation: "createCylinder", centerMm, radiusMm, heightMm, current, axis });
      state = { ...state, revision: "r2", bodies: [...state.bodies, { ...target, id: 8, versionId: 8, name: null }] };
      return state;
    },
    async boolean(targets: number[], tools: number[], operation: string, keep: boolean, current: string) {
      calls.push({ operation: "boolean", targets, tools, kind: operation, keep, current });
      state = { ...state, revision: "r3", bodies: state.bodies.filter((body) => !tools.includes(body.id)) };
      return state;
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "through-hole-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const created = await client.callTool({ name: "plasticity_create_through_hole", arguments: {
    targetId: 7, entryCenterMm: [10, 10, 8], axis: [0, 0, -1],
    holeDiameterMm: 5.5, throughDepthMm: 8, revision: "r1",
    intent: "Create the resolved M5 clearance hole",
  } });
  assert.equal(created.isError, undefined);
  const createdText = (created.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  assert.equal(JSON.parse(createdText ?? "null").undoSteps, 2);
  assert.deepEqual(calls, [
    { operation: "createCylinder", centerMm: [10, 10, 8.5], radiusMm: 2.75, heightMm: 9, current: "r1", axis: [0, 0, -1] },
    { operation: "boolean", targets: [7], tools: [8], kind: "difference", keep: false, current: "r2" },
  ]);
  const journal = await client.callTool({ name: "plasticity_construction_journal", arguments: {} });
  const journalText = (journal.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const journalValue = JSON.parse(journalText ?? "null");
  assert.equal(journalValue.entries[0].operation, "recipe-through-hole");
  assert.equal(journalValue.entries[0].status, "completed");
  assert.equal(journalValue.entries[0].afterRevision, "r3");

  await client.close(); await server.close();
});

test("executes and journals a multi-center through-hole pattern through MCP", async () => {
  const target: RuntimeState["bodies"][number] = {
    id: 7, versionId: 70, type: "Solid", name: "Plate", boundsMm: { min: [0, 0, 0], max: [40, 40, 8] },
    faceIds: [], edgeIds: [], faces: [], edges: [],
  };
  let state = { ...emptyState(), bodies: [target] };
  let nextId = 8;
  const calls: Array<Record<string, unknown>> = [];
  const operations = {
    async state() { return state; },
    async createCylinder(centerMm: [number, number, number], radiusMm: number, heightMm: number, _name: string | undefined, current: string, axis: [number, number, number]) {
      calls.push({ operation: "createCylinder", centerMm, radiusMm, heightMm, current, axis });
      const id = nextId++;
      state = { ...state, revision: `r${Number(current.slice(1)) + 1}`, bodies: [...state.bodies, { ...target, id, versionId: id, name: null }] };
      return state;
    },
    async boolean(targets: number[], tools: number[], operation: string, keep: boolean, current: string) {
      calls.push({ operation: "boolean", targets, tools, kind: operation, keep, current });
      state = { ...state, revision: `r${Number(current.slice(1)) + 1}`, bodies: state.bodies.filter((body) => !tools.includes(body.id)) };
      return state;
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "through-hole-pattern-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const created = await client.callTool({ name: "plasticity_create_through_hole_pattern", arguments: {
    targetId: 7, entryCentersMm: [[10, 10, 8], [30, 10, 8], [10, 30, 8], [30, 30, 8]], axis: [0, 0, -1],
    holeDiameterMm: 5.5, throughDepthMm: 8, revision: "r1", intent: "Create four qualified clearance holes",
  } });
  assert.equal(created.isError, undefined);
  const createdText = (created.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const value = JSON.parse(createdText ?? "null");
  assert.equal(value.holeCount, 4);
  assert.equal(value.undoSteps, 5);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.at(-1), { operation: "boolean", targets: [7], tools: [8, 9, 10, 11], kind: "difference", keep: false, current: "r5" });
  const journal = await client.callTool({ name: "plasticity_construction_journal", arguments: {} });
  const journalText = (journal.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const journalValue = JSON.parse(journalText ?? "null");
  assert.equal(journalValue.entries[0].operation, "recipe-through-hole-pattern");
  assert.equal(journalValue.entries[0].afterRevision, "r6");

  await client.close(); await server.close();
});

test("executes and journals a dedicated blind-hole recipe through MCP", async () => {
  const target: RuntimeState["bodies"][number] = {
    id: 7, versionId: 70, type: "Solid", name: "Boss", boundsMm: { min: [0, 0, 0], max: [20, 20, 8] },
    faceIds: [], edgeIds: [], faces: [], edges: [],
  };
  let state = { ...emptyState(), bodies: [target] };
  const calls: Array<Record<string, unknown>> = [];
  const operations = {
    async state() { return state; },
    async createCylinder(centerMm: [number, number, number], radiusMm: number, heightMm: number, _name: string | undefined, current: string, axis: [number, number, number]) {
      calls.push({ operation: "createCylinder", centerMm, radiusMm, heightMm, current, axis });
      state = { ...state, revision: "r2", bodies: [...state.bodies, { ...target, id: 8, versionId: 8, name: null }] };
      return state;
    },
    async boolean(targets: number[], tools: number[], operation: string, keep: boolean, current: string) {
      calls.push({ operation: "boolean", targets, tools, kind: operation, keep, current });
      state = { ...state, revision: "r3", bodies: state.bodies.filter((body) => !tools.includes(body.id)) };
      return state;
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "blind-hole-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const created = await client.callTool({ name: "plasticity_create_blind_hole", arguments: {
    targetId: 7, entryCenterMm: [10, 10, 8], axis: [0, 0, -1],
    holeDiameterMm: 4.2, holeDepthMm: 5, materialDepthMm: 8, revision: "r1",
    intent: "Create the qualified M5 tap-drill pilot",
  } });
  assert.equal(created.isError, undefined);
  const createdText = (created.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  assert.equal(JSON.parse(createdText ?? "null").undoSteps, 2);
  assert.deepEqual(calls, [
    { operation: "createCylinder", centerMm: [10, 10, 8.5], radiusMm: 2.1, heightMm: 5.5, current: "r1", axis: [0, 0, -1] },
    { operation: "boolean", targets: [7], tools: [8], kind: "difference", keep: false, current: "r2" },
  ]);
  const journal = await client.callTool({ name: "plasticity_construction_journal", arguments: {} });
  const journalText = (journal.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const journalValue = JSON.parse(journalText ?? "null");
  assert.equal(journalValue.entries[0].operation, "recipe-blind-hole");
  assert.equal(journalValue.entries[0].status, "completed");
  assert.equal(journalValue.entries[0].afterRevision, "r3");

  await client.close(); await server.close();
});

test("executes and journals a multi-center blind-hole pattern through MCP", async () => {
  const target: RuntimeState["bodies"][number] = {
    id: 7, versionId: 70, type: "Solid", name: "Tapped plate", boundsMm: { min: [0, 0, 0], max: [40, 30, 8] },
    faceIds: [], edgeIds: [], faces: [], edges: [],
  };
  let state = { ...emptyState(), bodies: [target] };
  let nextId = 8;
  const calls: Array<Record<string, unknown>> = [];
  const operations = {
    async state() { return state; },
    async createCylinder(centerMm: [number, number, number], radiusMm: number, heightMm: number, _name: string | undefined, current: string, axis: [number, number, number]) {
      calls.push({ operation: "createCylinder", centerMm, radiusMm, heightMm, current, axis });
      const id = nextId++;
      state = { ...state, revision: `r${Number(current.slice(1)) + 1}`, bodies: [...state.bodies, { ...target, id, versionId: id, name: null }] };
      return state;
    },
    async boolean(targets: number[], tools: number[], operation: string, keep: boolean, current: string) {
      calls.push({ operation: "boolean", targets, tools, kind: operation, keep, current });
      state = { ...state, revision: `r${Number(current.slice(1)) + 1}`, bodies: state.bodies.filter((body) => !tools.includes(body.id)) };
      return state;
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "blind-hole-pattern-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const created = await client.callTool({ name: "plasticity_create_blind_hole_pattern", arguments: {
    targetId: 7, entryCentersMm: [[10, 10, 8], [30, 10, 8]], axis: [0, 0, -1],
    holeDiameterMm: 4.2, holeDepthMm: 5, materialDepthMm: 8, revision: "r1",
    intent: "Create two qualified tap-drill pilots",
  } });
  assert.equal(created.isError, undefined);
  const createdText = (created.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const value = JSON.parse(createdText ?? "null");
  assert.equal(value.holeCount, 2);
  assert.equal(value.undoSteps, 3);
  assert.deepEqual(calls.at(-1), { operation: "boolean", targets: [7], tools: [8, 9], kind: "difference", keep: false, current: "r3" });
  const journal = await client.callTool({ name: "plasticity_construction_journal", arguments: {} });
  const journalText = (journal.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const journalValue = JSON.parse(journalText ?? "null");
  assert.equal(journalValue.entries[0].operation, "recipe-blind-hole-pattern");
  assert.equal(journalValue.entries[0].afterRevision, "r4");

  await client.close(); await server.close();
});

test("executes and journals a multi-center heat-set insert pocket pattern through MCP", async () => {
  const target: RuntimeState["bodies"][number] = {
    id: 7, versionId: 70, type: "Solid", name: "Insert plate", boundsMm: { min: [0, 0, 0], max: [40, 20, 12] },
    faceIds: [], edgeIds: [], faces: [], edges: [],
  };
  let state = { ...emptyState(), bodies: [target] };
  let nextId = 8;
  const calls: Array<Record<string, unknown>> = [];
  const operations = {
    async state() { return state; },
    async createCylinder(centerMm: [number, number, number], radiusMm: number, heightMm: number, _name: string | undefined, current: string, axis: [number, number, number]) {
      calls.push({ operation: "createCylinder", centerMm, radiusMm, heightMm, current, axis });
      const id = nextId++;
      state = { ...state, revision: `r${Number(current.slice(1)) + 1}`, bodies: [...state.bodies, { ...target, id, versionId: id, name: null }] };
      return state;
    },
    async boolean(targets: number[], tools: number[], operation: string, keep: boolean, current: string) {
      calls.push({ operation: "boolean", targets, tools, kind: operation, keep, current });
      state = { ...state, revision: `r${Number(current.slice(1)) + 1}`, bodies: state.bodies.filter((body) => !tools.includes(body.id)) };
      return state;
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "insert-pocket-pattern-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const created = await client.callTool({ name: "plasticity_create_heat_set_insert_pocket_pattern", arguments: {
    targetId: 7, entryCentersMm: [[10, 10, 12], [30, 10, 12]], axis: [0, 0, -1],
    pilotDiameterMm: 3, pilotDepthMm: 8,
    insertDiameterMm: 4.6, insertDepthMm: 6,
    leadInDiameterMm: 5.4, leadInDepthMm: 1, materialDepthMm: 12,
    revision: "r1", intent: "Create two qualified heat-set insert pockets",
  } });
  assert.equal(created.isError, undefined);
  const createdText = (created.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const value = JSON.parse(createdText ?? "null");
  assert.equal(value.pocketCount, 2);
  assert.equal(value.undoSteps, 7);
  assert.equal(calls.length, 7);
  assert.deepEqual(calls.at(-1), { operation: "boolean", targets: [7], tools: [8, 9, 10, 11, 12, 13], kind: "difference", keep: false, current: "r7" });
  const journal = await client.callTool({ name: "plasticity_construction_journal", arguments: {} });
  const journalText = (journal.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const journalValue = JSON.parse(journalText ?? "null");
  assert.equal(journalValue.entries[0].operation, "recipe-heat-set-insert-pocket-pattern");
  assert.equal(journalValue.entries[0].afterRevision, "r8");

  await client.close(); await server.close();
});

test("executes and journals a multi-center screw boss pattern through MCP", async () => {
  const target: RuntimeState["bodies"][number] = {
    id: 7, versionId: 70, type: "Solid", name: "Boss support", boundsMm: { min: [0, 0, 0], max: [50, 30, 4] },
    faceIds: [], edgeIds: [], faces: [], edges: [],
  };
  let state = { ...emptyState(), bodies: [target] };
  let nextId = 8;
  const calls: Array<Record<string, unknown>> = [];
  const operations = {
    async state() { return state; },
    async createCylinder(centerMm: [number, number, number], radiusMm: number, heightMm: number, _name: string | undefined, current: string, axis: [number, number, number]) {
      calls.push({ operation: "createCylinder", centerMm, radiusMm, heightMm, current, axis });
      const id = nextId++;
      state = { ...state, revision: `r${Number(current.slice(1)) + 1}`, bodies: [...state.bodies, { ...target, id, versionId: id, name: null }] };
      return state;
    },
    async boolean(targets: number[], tools: number[], operation: string, keep: boolean, current: string) {
      calls.push({ operation: "boolean", targets, tools, kind: operation, keep, current });
      state = { ...state, revision: `r${Number(current.slice(1)) + 1}`, bodies: state.bodies.filter((body) => !tools.includes(body.id)) };
      return state;
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "screw-boss-pattern-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const created = await client.callTool({ name: "plasticity_create_screw_boss_pattern", arguments: {
    targetId: 7, baseCentersMm: [[12, 15, 4], [38, 15, 4]], axis: [0, 0, 1],
    outerDiameterMm: 10, heightMm: 10, holeDiameterMm: 3, holeDepthMm: 8,
    baseOverlapMm: 0.5, cutterOvershootMm: 0.5,
    revision: "r1", intent: "Create two qualified printed-plastic screw bosses",
  } });
  assert.equal(created.isError, undefined);
  const createdText = (created.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const value = JSON.parse(createdText ?? "null");
  assert.equal(value.bossCount, 2);
  assert.equal(value.undoSteps, 6);
  assert.equal(calls.length, 6);
  assert.deepEqual(calls[2], { operation: "boolean", targets: [7], tools: [8, 9], kind: "union", keep: false, current: "r3" });
  assert.deepEqual(calls.at(-1), { operation: "boolean", targets: [7], tools: [10, 11], kind: "difference", keep: false, current: "r6" });
  const journal = await client.callTool({ name: "plasticity_construction_journal", arguments: {} });
  const journalText = (journal.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const journalValue = JSON.parse(journalText ?? "null");
  assert.equal(journalValue.entries[0].operation, "recipe-screw-boss-pattern");
  assert.equal(journalValue.entries[0].afterRevision, "r7");

  await client.close(); await server.close();
});

test("executes and journals a multi-center slotted hole pattern through MCP", async () => {
  const target: RuntimeState["bodies"][number] = {
    id: 7, versionId: 70, type: "Solid", name: "Adjustable plate", boundsMm: { min: [0, 0, 0], max: [50, 40, 8] },
    faceIds: [], edgeIds: [], faces: [], edges: [],
  };
  let state = { ...emptyState(), bodies: [target] };
  let nextId = 8;
  let nextRevision = 1;
  const calls: Array<Record<string, unknown>> = [];
  const advance = (added: RuntimeState["bodies"], removedIds: number[] = []) => {
    nextRevision += 1;
    state = { ...state, revision: `r${nextRevision}`, bodies: [...state.bodies.filter((body) => !removedIds.includes(body.id)), ...added] };
    return state;
  };
  const operations = {
    async state() { return state; },
    async createPolyline(points: Array<[number, number, number]>, closed: boolean, current: string) {
      calls.push({ operation: "createPolyline", points, closed, current });
      const id = nextId++;
      advance([{ ...target, id, versionId: id, type: "Wire", name: null }]);
      state = { ...state, regions: [...state.regions, {
        id: `region-${id}`, entityId: id * 10, islandVersionId: id * 10 + 1, sketchId: id * 10 + 2,
        sketchWireIds: [id], measurementSource: "render-mesh" as const,
        displayBoundsMm: {
          min: [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis]!))) as [number, number, number],
          max: [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis]!))) as [number, number, number],
        },
      }] };
      return state;
    },
    async extrudeRegions(regionIds: string[], distanceMm: number, current: string) {
      calls.push({ operation: "extrudeRegions", regionIds, distanceMm, current });
      const id = nextId++;
      return advance([{ ...target, id, versionId: id, name: null }]);
    },
    async createCylinder(centerMm: [number, number, number], radiusMm: number, heightMm: number, _name: string | undefined, current: string, axis: [number, number, number]) {
      calls.push({ operation: "createCylinder", centerMm, radiusMm, heightMm, current, axis });
      const id = nextId++;
      return advance([{ ...target, id, versionId: id, name: null }]);
    },
    async boolean(targets: number[], tools: number[], operation: string, keep: boolean, current: string) {
      calls.push({ operation: "boolean", targets, tools, kind: operation, keep, current });
      return advance([], tools);
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "slotted-hole-pattern-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const created = await client.callTool({ name: "plasticity_create_slotted_hole_pattern", arguments: {
    targetId: 7, entryCentersMm: [[20, 10, 8], [20, 30, 8]], axis: [0, 0, -1], slotDirection: [1, 0, 0],
    overallLengthMm: 20, widthMm: 6, throughDepthMm: 8,
    revision: "r1", intent: "Create two qualified adjustment slots",
  } });
  assert.equal(created.isError, undefined);
  const createdText = (created.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const value = JSON.parse(createdText ?? "null");
  assert.equal(value.slotCount, 2);
  assert.equal(value.centerDistanceMm, 14);
  assert.equal(value.undoSteps, 9);
  assert.equal(calls.length, 9);
  assert.deepEqual(calls.at(-1), { operation: "boolean", targets: [7], tools: [9, 10, 11, 13, 14, 15], kind: "difference", keep: false, current: "r9" });
  const journal = await client.callTool({ name: "plasticity_construction_journal", arguments: {} });
  const journalText = (journal.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const journalValue = JSON.parse(journalText ?? "null");
  assert.equal(journalValue.entries[0].operation, "recipe-slotted-hole-pattern");
  assert.equal(journalValue.entries[0].afterRevision, "r10");

  await client.close(); await server.close();
});

test("executes and journals countersink, hex nut pocket, and slotted-hole recipes through MCP", async () => {
  const target: RuntimeState["bodies"][number] = {
    id: 7, versionId: 70, type: "Solid", name: "Bracket", boundsMm: { min: [0, 0, 0], max: [40, 30, 8] },
    faceIds: [], edgeIds: [], faces: [], edges: [],
  };
  const wire = (id: number): RuntimeState["bodies"][number] => ({ ...target, id, versionId: id, type: "Wire", name: null });
  const solid = (id: number): RuntimeState["bodies"][number] => ({ ...target, id, versionId: id, name: null });
  let state = { ...emptyState(), bodies: [target] };
  const calls: string[] = [];
  const operations = {
    async state() { return state; },
    async createCylinder(_center: [number, number, number], _radius: number, _height: number, _name: string | undefined, current: string) {
      calls.push(`cylinder:${current}`);
      const id = current === "r1" ? 8 : current === "r10" ? 15 : 16;
      const nextRevision = current === "r1" ? "r2" : current === "r10" ? "r11" : "r12";
      state = { ...state, revision: nextRevision, bodies: [...state.bodies, solid(id)] };
      return state;
    },
    async createPolyline(points: Array<[number, number, number]>, _closed: boolean, current: string) {
      calls.push(`polyline:${current}`);
      const id = state.revision === "r2" ? 9 : state.revision === "r5" ? 11 : 13;
      const nextRevision = state.revision === "r2" ? "r3" : state.revision === "r5" ? "r6" : "r9";
      state = { ...state, revision: nextRevision, bodies: [...state.bodies, wire(id)], regions: [{
        id: `region-${id}`, entityId: id * 10, islandVersionId: id * 10 + 1, sketchId: id * 10 + 2,
        sketchWireIds: [id], measurementSource: "render-mesh" as const,
        displayBoundsMm: {
          min: [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis]!))) as [number, number, number],
          max: [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis]!))) as [number, number, number],
        },
      }] };
      return state;
    },
    async revolveProfile(_id: number, _origin: [number, number, number], _axis: [number, number, number], _degrees: number, current: string) {
      calls.push(`revolve:${current}`);
      state = { ...state, revision: "r4", bodies: [...state.bodies, solid(10)] };
      return state;
    },
    async extrudeRegions(_ids: string[], _distance: number, current: string) {
      calls.push(`extrude:${current}`);
      const id = current === "r6" ? 12 : 14;
      state = { ...state, revision: current === "r6" ? "r7" : "r10", bodies: [...state.bodies, solid(id)] };
      return state;
    },
    async boolean(_targets: number[], tools: number[], _kind: string, _keep: boolean, current: string) {
      calls.push(`boolean:${current}`);
      const nextRevision = current === "r4" ? "r5" : current === "r7" ? "r8" : "r13";
      state = { ...state, revision: nextRevision, bodies: state.bodies.filter((body) => !tools.includes(body.id)) };
      return state;
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "fastener-pocket-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const countersink = await client.callTool({ name: "plasticity_create_countersink", arguments: {
    targetId: 7, entryCenterMm: [12, 15, 8], axis: [0, 0, -1], radialDirection: [1, 0, 0],
    throughDiameterMm: 5.5, countersinkMajorDiameterMm: 10.4, includedAngleDeg: 90,
    throughDepthMm: 8, revision: "r1",
  } });
  assert.equal(countersink.isError, undefined);
  const countersinkText = (countersink.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  assert.equal(JSON.parse(countersinkText ?? "null").recipe, "countersink");

  const pocket = await client.callTool({ name: "plasticity_create_hex_nut_pocket", arguments: {
    targetId: 7, entryCenterMm: [28, 15, 8], axis: [0, 0, -1], flatNormalDirection: [1, 0, 0],
    acrossFlatsMm: 8, pocketDepthMm: 4, materialDepthMm: 8, revision: "r5",
  } });
  assert.equal(pocket.isError, undefined);
  const pocketText = (pocket.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  assert.equal(JSON.parse(pocketText ?? "null").recipe, "hex-nut-pocket");
  const slot = await client.callTool({ name: "plasticity_create_slotted_hole", arguments: {
    targetId: 7, entryCenterMm: [20, 8, 8], axis: [0, 0, -1], slotDirection: [1, 0, 0],
    overallLengthMm: 16, widthMm: 6, throughDepthMm: 8, revision: "r8",
  } });
  assert.equal(slot.isError, undefined);
  const slotText = (slot.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  assert.equal(JSON.parse(slotText ?? "null").recipe, "slotted-hole");
  assert.deepEqual(calls, [
    "cylinder:r1", "polyline:r2", "revolve:r3", "boolean:r4",
    "polyline:r5", "extrude:r6", "boolean:r7",
    "polyline:r8", "extrude:r9", "cylinder:r10", "cylinder:r11", "boolean:r12",
  ]);

  const journal = await client.callTool({ name: "plasticity_construction_journal", arguments: {} });
  const journalText = (journal.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  const operationsLogged = JSON.parse(journalText ?? "null").entries.map((entry: { operation: string }) => entry.operation);
  assert.deepEqual(operationsLogged, ["recipe-countersink", "recipe-hex-nut-pocket", "recipe-slotted-hole"]);

  await client.close(); await server.close();
});

test("serializes plane-local circle, rectangle, and text inputs and rejects mixed coordinate forms", async () => {
  let nativeArguments: unknown[] | undefined;
  const plane = {
    id: "plane:7", nativeId: "7", name: "Local", source: "saved" as const,
    ...frameFromOriginNormalX([10, 20, 30], [1, 0, 0], [0, 1, 0]),
  };
  const state = emptyState();
  state.construction = { planes: [plane], activePlaneId: plane.id, planeStateToken: "p1", viewStateToken: "v1" };
  state.bodies = [
    { id: 7, versionId: 17, type: "Wire", name: "Guide", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
    { id: 8, versionId: 18, type: "Wire", name: "Second guide", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
  ];
  const directions = [
    { id: 7, versionId: 17, measurementSource: "native-brep" as const, closed: false, segments: [{ entityId: 99, startMm: [0, 0, 0], endMm: [10, 0, 0], startTangent: [1, 0, 0], endTangent: [1, 0, 0], lengthMm: 10 }] },
    { id: 8, versionId: 18, measurementSource: "native-brep" as const, closed: false, segments: [{ entityId: 100, startMm: [0, 0, 0], endMm: [0, 10, 0], startTangent: [0, 1, 0], endTangent: [0, 1, 0], lengthMm: 10 }] },
  ];
  const runtime = {
    getCapabilities() { return []; }, async getState() { return state; },
    async readNative() { return directions; },
    async mutate(_source: string, _bindings: string[], values: unknown[]) { nativeArguments = values; return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-1");
  const identity = (await operations.listConstructionGeometry()).planes[0]!.identity;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const listed = await client.callTool({ name: "plasticity_list_construction_geometry", arguments: {} });
  const listedText = (listed.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  assert.equal(JSON.parse(listedText ?? "null").activePlaneId, "plane:7");
  const created = await client.callTool({ name: "plasticity_create_circle", arguments: { centerMm: [5, 7], radiusMm: 2, plane: identity, revision: "r1" } });
  assert.equal(created.isError, undefined);
  assert.deepEqual(nativeArguments, [{ center: [0.01, 0.025, 0.037], radius: 0.002, normal: [1, 0, 0] }]);
  const mixed = await client.callTool({ name: "plasticity_create_circle", arguments: { centerMm: [10, 25, 37], radiusMm: 2, normal: [1, 0, 0], plane: identity, revision: "r1" } });
  assert.equal(mixed.isError, true);
  const arc = await client.callTool({ name: "plasticity_create_center_arc", arguments: {
    centerMm: [5, 7], radiusMm: 4, startAngleDegrees: 0, sweepAngleDegrees: 90, plane: identity, revision: "r1",
  } });
  assert.equal(arc.isError, undefined);
  assert.deepEqual(nativeArguments, [{
    center: [0.01, 0.025, 0.037], start: [0.01, 0.029, 0.037], end: [0.01, 0.025, 0.041],
    normal: [1, 0, 0],
  }]);
  const fullArc = await client.callTool({ name: "plasticity_create_center_arc", arguments: {
    centerMm: [5, 7], radiusMm: 4, sweepAngleDegrees: 360, plane: identity, revision: "r1",
  } });
  assert.equal(fullArc.isError, true);
  const threePointArc = await client.callTool({ name: "plasticity_create_three_point_arc", arguments: {
    startMm: [4, 0], throughMm: [0, 4], endMm: [-4, 0], plane: identity, revision: "r1",
  } });
  assert.equal(threePointArc.isError, undefined);
  assert.deepEqual(nativeArguments, [{
    center: [0.01, 0.02, 0.03], start: [0.01, 0.024, 0.03], end: [0.01, 0.016, 0.03], normal: [1, 0, 0],
  }]);
  const mixedThreePointArc = await client.callTool({ name: "plasticity_create_three_point_arc", arguments: {
    startMm: [10, 24, 30], throughMm: [10, 20, 34], endMm: [10, 16, 30], plane: identity, revision: "r1",
  } });
  assert.equal(mixedThreePointArc.isError, true);
  const tangentArc = await client.callTool({ name: "plasticity_create_tangent_arc", arguments: {
    bodyId: 7, segmentEntityId: 99, startAt: "end", endMm: [5, 7], plane: identity, revision: "r1",
  } });
  assert.equal(tangentArc.isError, undefined);
  assert.deepEqual(nativeArguments, [{
    bodyId: 7, segmentEntityId: 99, startAt: "end", end: [0.01, 0.025, 0.037], flipTangent: false,
  }]);
  const mixedTangentArc = await client.callTool({ name: "plasticity_create_tangent_arc", arguments: {
    bodyId: 7, segmentEntityId: 99, startAt: "end", endMm: [10, 25, 37], plane: identity, revision: "r1",
  } });
  assert.equal(mixedTangentArc.isError, true);
  const tangentCircle = await client.callTool({ name: "plasticity_create_tangent_circle", arguments: {
    first: { bodyId: 7, segmentEntityId: 99 }, second: { bodyId: 8, segmentEntityId: 100 },
    solutionPointMm: [5, 7], radiusMm: 2, plane: identity, revision: "r1",
  } });
  assert.equal(tangentCircle.isError, undefined);
  assert.deepEqual(nativeArguments, [{
    first: { bodyId: 7, segmentEntityId: 99 }, second: { bodyId: 8, segmentEntityId: 100 },
    solutionPoint: [0.01, 0.025, 0.037], normal: [1, 0, 0], radius: 0.002,
  }]);
  const duplicateTangentCircle = await client.callTool({ name: "plasticity_create_tangent_circle", arguments: {
    first: { bodyId: 7, segmentEntityId: 99 }, second: { bodyId: 7, segmentEntityId: 99 },
    solutionPointMm: [5, 7], radiusMm: 2, plane: identity, revision: "r1",
  } });
  assert.equal(duplicateTangentCircle.isError, true);
  const mixedTangentCircle = await client.callTool({ name: "plasticity_create_tangent_circle", arguments: {
    first: { bodyId: 7, segmentEntityId: 99 }, second: { bodyId: 8, segmentEntityId: 100 },
    solutionPointMm: [10, 25, 37], radiusMm: 2, plane: identity, revision: "r1",
  } });
  assert.equal(mixedTangentCircle.isError, true);
  const ellipse = await client.callTool({ name: "plasticity_create_ellipse", arguments: {
    centerMm: [5, 7], majorRadiusMm: 4, minorRadiusMm: 2, plane: identity, revision: "r1",
  } });
  assert.equal(ellipse.isError, undefined);
  assert.deepEqual(nativeArguments, [{
    center: [0.01, 0.025, 0.037], majorPoint: [0.01, 0.029, 0.037], minorPoint: [0.01, 0.025, 0.039], normal: [1, 0, 0],
  }]);
  const polygon = await client.callTool({ name: "plasticity_create_regular_polygon", arguments: {
    centerMm: [5, 7], radiusMm: 4, radiusMode: "inradius", vertexCount: 6, plane: identity, revision: "r1",
  } });
  assert.equal(polygon.isError, undefined);
  assert.deepEqual(nativeArguments, [{
    center: [0.01, 0.025, 0.037], point: [0.01, 0.029, 0.037], normal: [1, 0, 0], radiusMode: "inradius", vertexCount: 6,
  }]);
  const rectangle = await client.callTool({ name: "plasticity_create_rectangle", arguments: {
    centerMm: [5, 7], widthMm: 4, heightMm: 2, plane: identity, revision: "r1",
  } });
  assert.equal(rectangle.isError, undefined);
  assert.deepEqual(nativeArguments, [{ p1: [0.01, 0.023, 0.036], p2: [0.01, 0.027, 0.036], p3: [0.01, 0.027, 0.038] }]);
  const mixedRectangle = await client.callTool({ name: "plasticity_create_rectangle", arguments: {
    centerMm: [10, 25, 37], widthMm: 4, heightMm: 2, normal: [1, 0, 0], xDirection: [0, 1, 0], plane: identity, revision: "r1",
  } });
  assert.equal(mixedRectangle.isError, true);
  const text = await client.callTool({ name: "plasticity_create_text", arguments: {
    text: "M5", fontSizeMm: 10, originMm: [5, 7], plane: identity, name: "Fastener label", revision: "r1",
  } });
  assert.equal(text.isError, undefined);
  assert.deepEqual(nativeArguments, [{
    text: "M5", font: "inter", size: 0.01, origin: [0.01, 0.025, 0.037],
    x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0], rotate: true, move: true, name: "Fastener label",
  }]);
  const mixedText = await client.callTool({ name: "plasticity_create_text", arguments: {
    text: "M5", fontSizeMm: 10, originMm: [10, 25, 37], normal: [1, 0, 0], plane: identity, revision: "r1",
  } });
  assert.equal(mixedText.isError, true);
  await client.close(); await server.close();
});

test("serializes exact Curve Bridge endpoints and continuity modes", async () => {
  const nativeCalls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const state = emptyState();
  state.bodies = [
    { id: 7, versionId: 17, type: "Wire", name: "First", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
    { id: 8, versionId: 18, type: "Wire", name: "Second", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] },
  ];
  const directions = [
    { id: 7, versionId: 17, measurementSource: "native-brep" as const, closed: false, segments: [{ entityId: 91, startMm: [0, 0, 0], endMm: [10, 0, 0], startTangent: [1, 0, 0], endTangent: [1, 0, 0], lengthMm: 10 }] },
    { id: 8, versionId: 18, measurementSource: "native-brep" as const, closed: false, segments: [{ entityId: 92, startMm: [20, 10, 0], endMm: [30, 10, 0], startTangent: [1, 0, 0], endTangent: [1, 0, 0], lengthMm: 10 }] },
  ];
  const runtime = {
    getCapabilities() { return []; },
    async getState() { return state; },
    async readNative() { return directions; },
    async mutate(source: string, bindings: string[], values: unknown[]) { nativeCalls.push({ source, bindings, values }); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-1");
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const bridged = await client.callTool({ name: "plasticity_bridge_curves", arguments: {
    first: { bodyId: 7, segmentEntityId: 91, at: "end" },
    second: { bodyId: 8, segmentEntityId: 92, at: "start" },
    startContinuity: "G1", endContinuity: "G3", revision: state.revision,
  } });
  assert.equal(bridged.isError, undefined);
  assert.deepEqual(nativeCalls.at(-1)?.values, [{
    first: { bodyId: 7, segmentEntityId: 91, at: "end" },
    second: { bodyId: 8, segmentEntityId: 92, at: "start" },
    startContinuity: "G1", endContinuity: "G3",
  }]);
  const invalid = await client.callTool({ name: "plasticity_bridge_curves", arguments: {
    first: { bodyId: 7, segmentEntityId: 91, at: "end" },
    second: { bodyId: 8, segmentEntityId: 92, at: "start" },
    startContinuity: "C1", revision: state.revision,
  } });
  assert.equal(invalid.isError, true);

  await client.close(); await server.close();
});

test("serializes exact Solid and Sheet edge endpoints for Shell Edge Bridge", async () => {
  const nativeCalls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const firstEdge = { id: "17e1", curveType: "Line", line: true, circle: false, lengthMm: 10, centerMm: [0, 0, 5] as [number, number, number], tangent: [0, 0, 1] as [number, number, number], boundsMm: { min: [0, 0, 0] as [number, number, number], max: [0, 0, 10] as [number, number, number] }, faceIds: ["17f1"], vertexIds: [101, 102] };
  const secondEdge = { ...firstEdge, id: "18e1", centerMm: [20, 10, 25] as [number, number, number], boundsMm: { min: [20, 10, 20] as [number, number, number], max: [20, 10, 30] as [number, number, number] }, faceIds: ["18f1"], vertexIds: [201, 202] };
  const state = emptyState();
  state.bodies = [
    { id: 7, versionId: 17, type: "Solid", name: "First", boundsMm: null, faceIds: firstEdge.faceIds, edgeIds: [firstEdge.id], faces: [], edges: [firstEdge], vertices: [
      { id: 101, positionMm: [0, 0, 0], edgeIds: [firstEdge.id], faceIds: firstEdge.faceIds },
      { id: 102, positionMm: [0, 0, 10], edgeIds: [firstEdge.id], faceIds: firstEdge.faceIds },
    ] },
    { id: 8, versionId: 18, type: "Sheet", name: "Second", boundsMm: null, faceIds: secondEdge.faceIds, edgeIds: [secondEdge.id], faces: [], edges: [secondEdge], vertices: [
      { id: 201, positionMm: [20, 10, 20], edgeIds: [secondEdge.id], faceIds: secondEdge.faceIds },
      { id: 202, positionMm: [20, 10, 30], edgeIds: [secondEdge.id], faceIds: secondEdge.faceIds },
    ] },
  ];
  const runtime = {
    getCapabilities() { return []; }, async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { nativeCalls.push({ source, bindings, values }); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-1");
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const bridged = await client.callTool({ name: "plasticity_bridge_shell_edges", arguments: {
    first: { bodyId: 7, edgeId: "17e1", vertexId: 102 },
    second: { bodyId: 8, edgeId: "18e1", vertexId: 201 },
    startContinuity: "G1", endContinuity: "G3", revision: state.revision,
  } });
  assert.equal(bridged.isError, undefined);
  assert.deepEqual(nativeCalls.at(-1)?.values, [{
    first: { bodyId: 7, edgeId: "17e1", vertexId: 102 },
    second: { bodyId: 8, edgeId: "18e1", vertexId: 201 },
    firstPosition: [0, 0, 0.01], secondPosition: [0.02, 0.01, 0.02],
    startContinuity: "G1", endContinuity: "G3",
  }]);
  const duplicate = await client.callTool({ name: "plasticity_bridge_shell_edges", arguments: {
    first: { bodyId: 7, edgeId: "17e1", vertexId: 101 },
    second: { bodyId: 7, edgeId: "17e1", vertexId: 102 }, revision: state.revision,
  } });
  assert.equal(duplicate.isError, true);
  const invalidContinuity = await client.callTool({ name: "plasticity_bridge_shell_edges", arguments: {
    first: { bodyId: 7, edgeId: "17e1", vertexId: 102 },
    second: { bodyId: 8, edgeId: "18e1", vertexId: 201 }, startContinuity: "C1", revision: state.revision,
  } });
  assert.equal(invalidContinuity.isError, true);

  await client.close(); await server.close();
});

test("serializes exact open Wire vertices for Curve Vertex Bridge", async () => {
  const nativeCalls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const state = emptyState();
  state.bodies = [
    { id: 7, versionId: 17, type: "Wire", name: "First", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] },
    { id: 8, versionId: 18, type: "Wire", name: "Second", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] },
  ];
  const vertices = [
    { id: "7:101", bodyId: 7, bodyVersionId: 17, vertexId: 101, viewVersionId: "17v101", measurementSource: "native-brep", positionMm: [10, 0, 0], endpoint: true, adjacentEdgeEntityIds: [1001] },
    { id: "8:201", bodyId: 8, bodyVersionId: 18, vertexId: 201, viewVersionId: "18v201", measurementSource: "native-brep", positionMm: [20, 10, 0], endpoint: true, adjacentEdgeEntityIds: [2001] },
  ];
  const runtime = {
    getCapabilities() { return []; }, async getState() { return state; }, async readNative() { return vertices; },
    async mutate(source: string, bindings: string[], values: unknown[]) { nativeCalls.push({ source, bindings, values }); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-1");
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const bridged = await client.callTool({ name: "plasticity_bridge_curve_vertices", arguments: {
    first: { bodyId: 7, vertexId: 101 }, second: { bodyId: 8, vertexId: 201 },
    startContinuity: "G1", endContinuity: "G3", revision: state.revision,
  } });
  assert.equal(bridged.isError, undefined);
  assert.deepEqual(nativeCalls.at(-1)?.values, [{
    first: { bodyId: 7, vertexId: 101 }, second: { bodyId: 8, vertexId: 201 },
    firstPosition: [0.01, 0, 0], secondPosition: [0.02, 0.01, 0],
    startContinuity: "G1", endContinuity: "G3",
  }]);
  const duplicate = await client.callTool({ name: "plasticity_bridge_curve_vertices", arguments: {
    first: { bodyId: 7, vertexId: 101 }, second: { bodyId: 7, vertexId: 101 }, revision: state.revision,
  } });
  assert.equal(duplicate.isError, true);
  const invalidContinuity = await client.callTool({ name: "plasticity_bridge_curve_vertices", arguments: {
    first: { bodyId: 7, vertexId: 101 }, second: { bodyId: 8, vertexId: 201 }, startContinuity: "C1", revision: state.revision,
  } });
  assert.equal(invalidContinuity.isError, true);

  await client.close(); await server.close();
});

test("serializes ordered planar face loft profiles and native end conditions", async () => {
  const nativeCalls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const profile = (id: string, z: number) => ({ id, surfaceType: "Plane", planar: true, centerMm: [0, 0, z] as [number, number, number], normal: [0, 0, 1] as [number, number, number], radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null, boundsMm: { min: [-5, -5, z] as [number, number, number], max: [5, 5, z] as [number, number, number] }, edgeIds: [] });
  const state = emptyState();
  state.bodies = [
    { id: 7, versionId: 17, type: "Solid", name: "First", boundsMm: null, faceIds: ["f1"], edgeIds: [], faces: [profile("f1", 0)], edges: [], vertices: [] },
    { id: 8, versionId: 18, type: "Sheet", name: "Second", boundsMm: null, faceIds: ["f2"], edgeIds: [], faces: [profile("f2", 20)], edges: [], vertices: [] },
    { id: 9, versionId: 19, type: "Wire", name: "Guide", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] },
  ];
  const runtime = {
    getCapabilities() { return []; }, async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { nativeCalls.push({ source, bindings, values }); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-1");
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const lofted = await client.callTool({ name: "plasticity_loft_faces", arguments: {
    faces: [{ bodyId: 7, faceId: "f1" }, { bodyId: 8, faceId: "f2" }],
    guideIds: [9], trimGuides: false, simplify: false,
    startCondition: "clamped", endCondition: "natural", startMagnitude: 1.5, endMagnitude: 0.75,
    revision: state.revision,
  } });
  assert.equal(lofted.isError, undefined);
  assert.deepEqual(nativeCalls.at(-1)?.bindings, ["FaceLoftFactory", "LoftSurfaceCommand", "LoftCurvatureType"]);
  assert.deepEqual(nativeCalls.at(-1)?.values, [{
    faces: [{ bodyId: 7, faceId: "f1" }, { bodyId: 8, faceId: "f2" }],
    guideIds: [9], trimGuides: false, simplify: false,
    startCondition: "Clamped", endCondition: "Natural", startMagnitude: 1.5, endMagnitude: 0.75,
  }]);
  const invalid = await client.callTool({ name: "plasticity_loft_faces", arguments: {
    faces: [{ bodyId: 7, faceId: "f1" }, { bodyId: 8, faceId: "f2" }], startCondition: "G1", revision: state.revision,
  } });
  assert.equal(invalid.isError, true);

  await client.close(); await server.close();
});

test("serializes ordered Wire loft profiles, guides, and native curvature", async () => {
  const nativeCalls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const state = emptyState();
  const wire = (id: number) => ({ id, versionId: id + 10, type: "Wire", name: null, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] });
  state.bodies = [wire(7), wire(8), wire(9)];
  const runtime = {
    getCapabilities() { return []; }, async getState() { return state; },
    async mutate(source: string, bindings: string[], values: unknown[]) { nativeCalls.push({ source, bindings, values }); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-1");
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const lofted = await client.callTool({ name: "plasticity_loft_curves", arguments: {
    profileIds: [7, 8], guideIds: [9], trimGuides: false, trimProfiles: false,
    closed: false, simplify: false, curvature: "natural", startMagnitude: 2, endMagnitude: 0.5,
    revision: state.revision,
  } });
  assert.equal(lofted.isError, undefined);
  assert.deepEqual(nativeCalls.at(-1)?.bindings, ["CurveLoftFactory", "LoftEdgeCommand", "LoftCurvatureType"]);
  assert.deepEqual(nativeCalls.at(-1)?.values, [{
    profileIds: [7, 8], guideIds: [9], trimGuides: false, trimProfiles: false,
    closed: false, simplify: false, curvature: "Natural", startMagnitude: 2, endMagnitude: 0.5,
  }]);
  const invalid = await client.callTool({ name: "plasticity_loft_curves", arguments: {
    profileIds: [7, 8], curvature: "G2", revision: state.revision,
  } });
  assert.equal(invalid.isError, true);

  await client.close(); await server.close();
});

test("serializes compact curve inspection and all native rebuild modes", async () => {
  const nativeCalls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const state = emptyState();
  state.bodies = [{ id: 7, versionId: 17, type: "Wire", name: "Guide", boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [] }];
  state.regions = [{ id: "20r1", entityId: 41, islandVersionId: 20, sketchId: 3, sketchWireIds: [7], measurementSource: "render-mesh", displayBoundsMm: { min: [0, 0, 0], max: [20, 10, 0] } }];
  const structure = [{
    id: 7, versionId: 17, measurementSource: "native-brep" as const,
    segments: [{ entityId: 99, curveType: "BCurve", lengthMm: 42, degree: 3, controlPointCount: 7, spanCount: 4, distinctKnotCount: 5, knots: [{ normalizedParameter: 0, multiplicity: 4, withinSegment: true }, { normalizedParameter: 1, multiplicity: 4, withinSegment: true }], rational: false, periodic: false }],
  }];
  const controlPoints = [{
    id: 7, versionId: 17, positionSource: "native-control-handle" as const,
    boundaryVertices: [{ reference: { bodyId: 7, kind: "vertex" as const, pointId: 101 }, versionId: "17v101", positionMm: [0, 0, 0] as [number, number, number], slideDirections: { positiveU: [1, 0, 0] as [number, number, number], negativeU: [-1, 0, 0] as [number, number, number] } }],
    interiorControlPoints: [{ reference: { bodyId: 7, kind: "control-point" as const, pointId: 2 }, versionId: "17c2", positionMm: [10, 20, 0] as [number, number, number], slideDirections: { positiveU: [0, 1, 0] as [number, number, number], negativeU: [0, -1, 0] as [number, number, number] } }],
  }];
  const evaluatedSamples = [{
    reference: { bodyId: 7, segmentEntityId: 99, normalizedParameter: 0.5 }, bodyVersionId: 17,
    curveType: "BCurve", measurementSource: "native-brep" as const,
    positionMm: [12, 8, 0] as [number, number, number], tangent: [1, 0, 0] as [number, number, number],
  }];
  const runtime = {
    getCapabilities() { return []; },
    async getState() { return state; },
    async readNative(source: string, bindings: string[], values: unknown[]) {
      nativeCalls.push({ source, bindings, values });
      return source.includes("FindPlanarBasis")
        ? [{ id: 7, versionId: 17, measurementSource: "native-brep", planar: false, plane: null }]
        : source.includes("reference.normalizedParameter")
          ? evaluatedSamples
        : source.includes("native-control-handle")
          ? controlPoints
        : structure;
    },
    async mutate(source: string, bindings: string[], values: unknown[]) { nativeCalls.push({ source, bindings, values }); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-1");
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const inspected = await client.callTool({ name: "plasticity_inspect_curve_structure", arguments: { ids: [7], revision: state.revision } });
  assert.equal(inspected.isError, undefined);
  const inspectedText = (inspected.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  assert.match(inspectedText ?? "", /"controlPointCount": 7/);
  assert.deepEqual(nativeCalls.at(-1)?.values, [{ ids: [7] }]);
  const evaluated = await client.callTool({ name: "plasticity_evaluate_curve_segments", arguments: {
    samples: [{ bodyId: 7, segmentEntityId: 99, normalizedParameter: 0.5 }], revision: state.revision,
  } });
  assert.equal(evaluated.isError, undefined);
  const evaluatedText = (evaluated.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  assert.match(evaluatedText ?? "", /"positionMm": \[/);
  assert.deepEqual(nativeCalls.at(-1)?.values, [{ samples: [{ bodyId: 7, segmentEntityId: 99, normalizedParameter: 0.5 }] }]);
  const planarity = await client.callTool({ name: "plasticity_inspect_curve_planarity", arguments: { ids: [7], revision: state.revision } });
  assert.equal(planarity.isError, undefined);
  const planarityText = (planarity.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  assert.match(planarityText ?? "", /"planar": false/);
  const listedControlPoints = await client.callTool({ name: "plasticity_list_curve_control_points", arguments: { ids: [7], revision: state.revision } });
  assert.equal(listedControlPoints.isError, undefined);
  const listedControlPointsText = (listedControlPoints.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  assert.match(listedControlPointsText ?? "", /"native-control-handle"/);
  const duplicated = await client.callTool({ name: "plasticity_duplicate_curves", arguments: { ids: [7], revision: state.revision } });
  assert.equal(duplicated.isError, undefined);
  assert.deepEqual(nativeCalls.at(-1)?.bindings, ["CurveDuplicateFactory"]);
  assert.deepEqual(nativeCalls.at(-1)?.values, [{ ids: [7] }]);
  const regionCurves = await client.callTool({ name: "plasticity_create_curves_from_regions", arguments: { regionIds: ["20r1"], revision: state.revision } });
  assert.equal(regionCurves.isError, undefined);
  assert.deepEqual(nativeCalls.at(-1)?.bindings, ["CreateCurvesFromRegionsFactory"]);
  assert.deepEqual(nativeCalls.at(-1)?.values, [{ regionIds: ["20r1"] }]);
  const duplicateRegions = await client.callTool({ name: "plasticity_create_curves_from_regions", arguments: { regionIds: ["20r1", "20r1"], revision: state.revision } });
  assert.equal(duplicateRegions.isError, true);
  const movedControlPoint = await client.callTool({ name: "plasticity_move_curve_control_points", arguments: {
    points: [{ bodyId: 7, kind: "control-point", pointId: 2 }], deltaMm: [0, 10, 5], revision: state.revision,
  } });
  assert.equal(movedControlPoint.isError, undefined);
  assert.deepEqual(nativeCalls.at(-1)?.bindings, ["MultiMoveControlPointFactory", "MoveControlPointCommand"]);
  assert.deepEqual(nativeCalls.at(-1)?.values, [{ points: [{ bodyId: 7, kind: "control-point", pointId: 2 }], delta: [0, 0.01, 0.005] }]);
  const slidControlPoint = await client.callTool({ name: "plasticity_slide_curve_control_points", arguments: {
    points: [{ bodyId: 7, kind: "control-point", pointId: 2 }], direction: "positive-u", distanceMm: 5, revision: state.revision,
  } });
  assert.equal(slidControlPoint.isError, undefined);
  assert.deepEqual(nativeCalls.at(-1)?.bindings, ["MultiSlideControlPointFactory", "MoveControlPointCommand"]);
  assert.deepEqual(nativeCalls.at(-1)?.values, [{ points: [{ bodyId: 7, kind: "control-point", pointId: 2 }], direction: "posU", distance: 0.005 }]);
  const rotatedControlPoint = await client.callTool({ name: "plasticity_rotate_curve_control_points", arguments: {
    points: [{ bodyId: 7, kind: "control-point", pointId: 2 }], pivotMm: [10, 20, 0], axis: [0, 0, 2], degrees: 90, revision: state.revision,
  } });
  assert.equal(rotatedControlPoint.isError, undefined);
  assert.deepEqual(nativeCalls.at(-1)?.bindings, ["MultiRotateControlPointFactory", "RotateControlPointCommand", "Vector3", "Quaternion"]);
  assert.deepEqual(nativeCalls.at(-1)?.values, [{ points: [{ bodyId: 7, kind: "control-point", pointId: 2 }], pivot: [0.01, 0.02, 0], axis: [0, 0, 1], radians: Math.PI / 2 }]);
  const scaledControlPoint = await client.callTool({ name: "plasticity_scale_curve_control_points", arguments: {
    points: [{ bodyId: 7, kind: "control-point", pointId: 2 }], pivotMm: [10, 20, 0], factors: [2, 0.5, 1], revision: state.revision,
  } });
  assert.equal(scaledControlPoint.isError, undefined);
  assert.deepEqual(nativeCalls.at(-1)?.bindings, ["MultiScaleControlPointFactory", "ScaleControlPointCommand"]);
  assert.deepEqual(nativeCalls.at(-1)?.values, [{ points: [{ bodyId: 7, kind: "control-point", pointId: 2 }], pivot: [0.01, 0.02, 0], factors: [2, 0.5, 1] }]);
  const deletedControlPoint = await client.callTool({ name: "plasticity_delete_curve_control_points", arguments: {
    points: [{ bodyId: 7, kind: "control-point", pointId: 2 }], revision: state.revision,
  } });
  assert.equal(deletedControlPoint.isError, undefined);
  assert.deepEqual(nativeCalls.at(-1)?.bindings, ["DeleteControlPointFactory", "DeleteControlPointCommand"]);
  assert.deepEqual(nativeCalls.at(-1)?.values, [{ points: [{ bodyId: 7, kind: "control-point", pointId: 2 }] }]);

  for (const arguments_ of [
    { ids: [7], method: "tolerance", toleranceMm: 0.1, revision: state.revision },
    { ids: [7], method: "control-points", pointCount: 9, preserveChain: false, revision: state.revision },
    { ids: [7], method: "degree-spans", degree: 5, spans: 3, keepCorners: false, revision: state.revision },
  ]) {
    const rebuilt = await client.callTool({ name: "plasticity_rebuild_curves", arguments: arguments_ });
    assert.equal(rebuilt.isError, undefined);
  }
  assert.deepEqual(nativeCalls.slice(-3).map((call) => call.values[0]), [
    { ids: [7], method: 0, parameters: { tolerance: 0.0001 }, preserveParameterization: false, preserveChain: true, keepCorners: true },
    { ids: [7], method: 1, parameters: { pointCount: 9 }, preserveParameterization: false, preserveChain: false, keepCorners: true },
    { ids: [7], method: 2, parameters: { degree: 5, spans: 3 }, preserveParameterization: false, preserveChain: true, keepCorners: false },
  ]);
  const raised = await client.callTool({ name: "plasticity_raise_curve_degree", arguments: { ids: [7], revision: state.revision } });
  const subdivided = await client.callTool({ name: "plasticity_subdivide_curves", arguments: { ids: [7], revision: state.revision } });
  assert.equal(raised.isError, undefined);
  assert.equal(subdivided.isError, undefined);
  assert.deepEqual(nativeCalls.slice(-2).map((call) => call.bindings), [
    ["RaiseDegreeCurveFactory", "RaiseDegreeCurveCommand"],
    ["SubdivideCurveFactory", "SubdivideCurveCommand"],
  ]);
  assert.deepEqual(nativeCalls.slice(-2).map((call) => call.values), [[{ ids: [7] }], [{ ids: [7] }]]);
  const insertedKnot = await client.callTool({ name: "plasticity_insert_curve_knot", arguments: {
    segment: { bodyId: 7, segmentEntityId: 99 }, normalizedParameter: 0.5, revision: state.revision,
  } });
  assert.equal(insertedKnot.isError, undefined);
  assert.deepEqual(nativeCalls.at(-1)?.bindings, ["InsertKnotFactory", "InsertKnotCommand"]);
  assert.deepEqual(nativeCalls.at(-1)?.values, [{ reference: { bodyId: 7, segmentEntityId: 99 }, normalizedParameter: 0.5 }]);
  const invalidKnot = await client.callTool({ name: "plasticity_insert_curve_knot", arguments: {
    segment: { bodyId: 7, segmentEntityId: 99 }, normalizedParameter: 1, revision: state.revision,
  } });
  assert.equal(invalidKnot.isError, true);
  const splitSegment = await client.callTool({ name: "plasticity_split_curve_segment", arguments: {
    segment: { bodyId: 7, segmentEntityId: 99 }, normalizedParameter: 0.5, revision: state.revision,
  } });
  assert.equal(splitSegment.isError, undefined);
  assert.deepEqual(nativeCalls.at(-1)?.bindings, ["SplitSegmentFactory", "SplitSegmentCommand"]);
  assert.deepEqual(nativeCalls.at(-1)?.values, [{ reference: { bodyId: 7, segmentEntityId: 99 }, normalizedParameter: 0.5 }]);
  const planarized = await client.callTool({ name: "plasticity_planarize_curves", arguments: {
    ids: [7], originMm: [0, 0, 5], normal: [0, 0, 2], revision: state.revision,
  } });
  assert.equal(planarized.isError, undefined);
  assert.deepEqual(nativeCalls.at(-1)?.bindings, ["PlanarizeCurveFactory", "DeformCurveCommand", "Vector3"]);
  assert.deepEqual(nativeCalls.at(-1)?.values, [{ ids: [7], origin: [0, 0, 0.005], normal: [0, 0, 1] }]);
  const excessive = await client.callTool({ name: "plasticity_rebuild_curves", arguments: {
    ids: [7], method: "degree-spans", degree: 15, spans: 1000, revision: state.revision,
  } });
  assert.equal(excessive.isError, true);

  await client.close(); await server.close();
});

test("serializes exact surface inspection, degree elevation, face matching, and untrim through MCP", async () => {
  const nativeCalls: Array<{ source: string; bindings: string[]; values: unknown[] }> = [];
  const state = emptyState();
  const face = {
    id: "f1", surfaceType: "BSurf", planar: false,
    centerMm: [10, 10, 5] as [number, number, number], normal: [0, 0, 1] as [number, number, number],
    radiusMm: null, blendRadiusMm: null, axisOriginMm: null, axisDirection: null,
    boundsMm: { min: [0, 0, 0] as [number, number, number], max: [20, 20, 10] as [number, number, number] }, edgeIds: [],
  };
  const replacementFace = {
    ...face, id: "f2", surfaceType: "Cylinder", radiusMm: 20,
    axisOriginMm: [0, 0, 0] as [number, number, number], axisDirection: [0, 0, 1] as [number, number, number],
  };
  state.bodies = [
    { id: 7, versionId: 17, type: "Sheet", name: "Surface", boundsMm: face.boundsMm, faceIds: [face.id], edgeIds: [], faces: [face], edges: [] },
    { id: 8, versionId: 18, type: "Solid", name: "Reference", boundsMm: face.boundsMm, faceIds: [replacementFace.id], edgeIds: [], faces: [replacementFace], edges: [] },
  ];
  const structure = [{
    bodyId: 7, faceId: "f1", bodyVersionId: 17, measurementSource: "native-brep" as const,
    surfaceType: "BSurf", trimmed: true,
    faceParameterBounds: { uMin: -0.01, uMax: 0.01, vMin: -0.005, vMax: 0 },
    naturalParameterBounds: { uMin: -0.01, uMax: 0.01, vMin: -0.005, vMax: 0.012 },
    bSpline: { uDegree: 3, vDegree: 3, uSpanCount: 3, vSpanCount: 2, uControlPointCount: 6, vControlPointCount: 5, rational: false },
  }];
  const runtime = {
    getCapabilities() { return []; },
    async getState() { return state; },
    async readNative(source: string, bindings: string[], values: unknown[]) { nativeCalls.push({ source, bindings, values }); return structure; },
    async mutate(source: string, bindings: string[], values: unknown[]) { nativeCalls.push({ source, bindings, values }); return {}; },
  } as unknown as PlasticityRuntime;
  const operations = new PlasticityOperations(runtime, "session-1");
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "surface-refinement-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const faces = [{ bodyId: 7, faceId: "f1" }];

  const inspected = await client.callTool({ name: "plasticity_inspect_surface_structure", arguments: { faces, revision: state.revision } });
  assert.equal(inspected.isError, undefined);
  const inspectedText = (inspected.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  assert.match(inspectedText ?? "", /"uControlPointCount": 6/);
  assert.deepEqual(nativeCalls.at(-1)?.values, [{ faces }]);

  const raised = await client.callTool({ name: "plasticity_raise_surface_degree", arguments: { faces, revision: state.revision } });
  assert.equal(raised.isError, undefined);
  assert.deepEqual(nativeCalls.at(-1)?.bindings, ["RaiseDegreeFaceFactory", "RaiseDegreeFaceCommand"]);

  const replacement = { bodyId: 8, faceId: "f2" };
  const matched = await client.callTool({ name: "plasticity_match_faces", arguments: { faces, replacement, revision: state.revision } });
  assert.equal(matched.isError, undefined);
  assert.deepEqual(nativeCalls.at(-1)?.bindings, ["MatchFaceFactory", "MatchFaceCommand"]);
  assert.deepEqual(nativeCalls.at(-1)?.values, [{ faces, replacement }]);

  const untrimmed = await client.callTool({ name: "plasticity_untrim_faces", arguments: { faces, revision: state.revision } });
  assert.equal(untrimmed.isError, undefined);
  assert.deepEqual(nativeCalls.at(-1)?.bindings, ["UntrimFactory"]);

  const invalidInspect = await client.callTool({ name: "plasticity_inspect_surface_structure", arguments: { faces: [], revision: state.revision } });
  const invalidRaise = await client.callTool({ name: "plasticity_raise_surface_degree", arguments: { faces: [faces[0], faces[0]], revision: state.revision } });
  const invalidMatch = await client.callTool({ name: "plasticity_match_faces", arguments: { faces, replacement: faces[0], revision: state.revision } });
  assert.equal(invalidInspect.isError, true);
  assert.equal(invalidRaise.isError, true);
  assert.equal(invalidMatch.isError, true);

  await client.close(); await server.close();
});

test("MCP exposes revision-bound exact cone development analysis", async () => {
  const state = emptyState();
  const expected = {
    documentToken: state.documentToken, revision: state.revision, measurementSource: "native-brep",
    bodyId: 8, faceId: "cone-face", boundaryRadiusMm: [6, 12],
    development: { axialHeightMm: 18, innerRadiusMm: 18.973665961010276, outerRadiusMm: 37.94733192202055, includedAngleRad: 1.98691765315922, slantLengthMm: 18.973665961010276 },
  };
  let received: unknown;
  let created: unknown;
  const createdResult = {
    documentToken: state.documentToken, revision: "r2", measurementSource: "native-brep", sourceFace: { bodyId: 8, faceId: "cone-face" },
    profileWireId: 12, sheetBodyId: 13, originMm: [100, 200, 30], boundaryRadiusMm: [6, 12],
    development: expected.development, sourceAreaMm2: 1072.14, sheetAreaMm2: 1072.14,
    sheetBoundaryLengthsMm: [12, 12, 24, 24], validation: { bodyId: 13, nativeValid: true }, historySteps: 6,
  };
  const operations = {
    async state() { return state; },
    async analyzeConeDevelopment(face: unknown, revision: string) {
      received = { face, revision };
      return expected;
    },
    async createConeDevelopment(face: unknown, originMm: unknown, revision: string) {
      created = { face, originMm, revision };
      return createdResult;
    },
  } as unknown as PlasticityOperations;
  const session = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(session);
  const client = new Client({ name: "cone-development-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);

  const result = await client.callTool({
    name: "plasticity_analyze_cone_development",
    arguments: { face: { bodyId: 8, faceId: "cone-face" }, intent: "Flatten this conical frustum", revision: state.revision },
  });
  const text = (result.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(text ?? "{}"), expected);
  assert.deepEqual(received, { face: { bodyId: 8, faceId: "cone-face" }, revision: state.revision });

  const generated = await client.callTool({
    name: "plasticity_create_cone_development",
    arguments: { face: { bodyId: 8, faceId: "cone-face" }, originMm: [100, 200, 30], intent: "Create a planar development", revision: state.revision },
  });
  assert.equal(generated.isError, undefined);
  assert.deepEqual(parseToolJson(generated), createdResult);
  assert.deepEqual(created, { face: { bodyId: 8, faceId: "cone-face" }, originMm: [100, 200, 30], revision: state.revision });
  const invalidOrigin = await client.callTool({
    name: "plasticity_create_cone_development",
    arguments: { face: { bodyId: 8, faceId: "cone-face" }, originMm: [100, Number.NaN, 30], intent: "Create a planar development", revision: state.revision },
  });
  assert.equal(invalidOrigin.isError, true);

  await client.close(); await server.close();
});

function unavailableConstruction() {
  return {
    constructionPlanes: { available: false, reason: "test" },
    activeWorkplane: { available: false, reason: "test" },
  };
}

function parseToolJson(response: unknown): any {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("Tool response has no content array");
  const item = response.content.find((entry): entry is { type: "text"; text: string } =>
    typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string");
  if (!item) throw new Error("Tool response has no JSON text");
  return JSON.parse(item.text);
}

function emptyState(): RuntimeState {
  return {
    targetId: "window-1", title: "Untitled - Plasticity", documentToken: "doc-1", revision: "r1",
    dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [],
    construction: { planes: [], activePlaneId: null, planeStateToken: "p0", viewStateToken: "v0" }, bodies: [],
  };
}

test("orients a rigid Solid group only when its union native bounds match the Workbench recommendation", async () => {
  const firstBody: RuntimeState["bodies"][number] = {
    id: 7, versionId: 70, type: "Solid", name: "Plate A", boundsMm: { min: [0, 0, 0], max: [20, 10, 5] },
    faceIds: [], edgeIds: [], faces: [], edges: [],
  };
  const secondBody: RuntimeState["bodies"][number] = {
    id: 8, versionId: 80, type: "Solid", name: "Plate B", boundsMm: { min: [30, 0, 0], max: [40, 10, 5] },
    faceIds: [], edgeIds: [], faces: [], edges: [],
  };
  let state: RuntimeState = { ...emptyState(), bodies: [firstBody, secondBody] };
  const calls: Array<{ ids: number[]; pivot: number[]; rotation: number[]; revision: string }> = [];
  const operations = {
    async state() { return state; },
    async rotateBodiesByXyz(ids: number[], pivot: number[], rotation: number[], revision: string) {
      calls.push({ ids, pivot, rotation, revision });
      state = {
        ...state,
        revision: "r2",
        bodies: [
          { ...firstBody, boundsMm: { min: [17.5, -15, -2.5], max: [22.5, 5, 7.5] } },
          { ...secondBody, boundsMm: { min: [17.5, 15, -2.5], max: [22.5, 25, 7.5] } },
        ],
      };
      return state;
    },
  } as unknown as PlasticityOperations;
  const fake = {
    async windows() { return []; }, async connect() { return state; }, get() { return operations; },
    capabilities() { return { bindings: [], operations: unavailableConstruction() }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const call = async (expectedSizeMm: number[], bodyIds = [7, 8]) => client.callTool({ name: "plasticity_orient_bodies_for_print", arguments: {
    bodyIds, rotationDeg: [90, 0, 90], expectedSizeMm,
    intent: "Orient the disposable Solid group to match the printer-bed recommendation", revision: "r1",
  } });

  const mismatch = await call([40, 10, 5]);
  assert.equal(mismatch.isError, true);
  assert.equal(calls.length, 0, "a recommendation mismatch must be rejected before CAD mutation");
  const duplicateIds = await call([5, 40, 10], [7, 7]);
  assert.equal(duplicateIds.isError, true, "a body must not be rotated twice by one request");

  const applied = await call([5, 40, 10]);
  assert.equal(applied.isError, undefined);
  const result = JSON.parse((applied.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "null");
  assert.equal(result.status, "verified");
  assert.equal(result.measurementSource, "native-brep");
  assert.equal(result.slicerFitVerified, false);
  assert.deepEqual(calls, [{ ids: [7, 8], pivot: [20, 5, 2.5], rotation: [90, 0, 90], revision: "r1" }]);
  await client.close(); await server.close();
});
