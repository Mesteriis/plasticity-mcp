#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface FastenerGroupAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp { client: Client; stderr: string[] }

export function parseFastenerGroupAcceptanceArgs(argv: string[]): FastenerGroupAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: FastenerGroupAcceptanceOptions = { help: false, allowDisposableMutations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--allow-disposable-mutations") options.allowDisposableMutations = true;
    else if (argument === "--target") {
      const value = argv[++index];
      if (!value) throw new Error("--target requires an explicit Plasticity window ID");
      options.target = value;
    } else if (argument === "--output") {
      const value = argv[++index];
      if (!value) throw new Error("--output requires a new directory path");
      options.output = value;
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Live fastener-group acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live fastener-group acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live fastener-group acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-fastener-group-live.ts --help
  node scripts/verify-fastener-group-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, never chooses a window automatically,
uses a separate stdio MCP process, and writes only sanitized evidence to a new directory.`;

async function main(): Promise<void> {
  const options = parseFastenerGroupAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    targetId: options.target!,
    workbenchUsed: false,
  };
  let live: LiveMcp | undefined;
  let initialState: any;
  try {
    live = await startMcp(join(output, "strength-store"));
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initialState = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireCondition(initialState.bodies.length === 0, "Refusing disposable mutations in a nonempty Plasticity document");
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "fastener-group-live-initial-empty" });

    const resolved = await call(live.client, "plasticity_resolve_fastener_designation", {
      designation: "крепится на 4 болта ISO 4017 M5x10 класса 8.8 с гайками",
      jointIntent: "through-bolt-with-nut",
      analysisIntent: "both",
    });
    requireCondition(resolved.thread.nominalDiameterMm === 5 && resolved.thread.pitchMm === 0.8 && resolved.lengthMm === 10, "M5x10 designation did not resolve exactly");
    requireCondition(resolved.headStyle === "external-hex" && resolved.propertyClass === "8.8", "Fastener standard or property class did not resolve");
    requireCondition(resolved.requiredInputs.includes("clearanceHoleDiameterMm"), "Resolver omitted the separate clearance-hole requirement");
    requireCondition(resolved.interpretation.quantity === 4, "Resolver did not preserve the four-fastener quantity");
    requireCondition(resolved.workflow.compatibleTools.includes("plasticity_create_through_hole_pattern"), "Resolver did not route a four-fastener joint to the through-hole pattern recipe");
    evidence.designation = {
      normalizedDesignation: resolved.normalizedDesignation,
      form: resolved.form,
      headStyle: resolved.headStyle,
      propertyClass: resolved.propertyClass,
      requiredInputs: resolved.requiredInputs,
      route: resolved.workflow.route,
    };
    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [60, 40, 8], name: "Disposable four-fastener plate",
      intent: "Approved disposable fastener-group acceptance", revision: initialState.revision,
    });
    const plateId = state.bodies[0].id;
    const initialPlate = state.bodies.find((body: { id: number }) => body.id === plateId);
    const gripFaces = initialPlate.faces.filter((face: any) =>
      face.planar && Math.abs(Math.abs(face.normal[2]) - 1) <= 1e-8
    );
    requireCondition(gripFaces.length === 2, `Expected two plate thickness faces, found ${gripFaces.length}`);
    const grip = await call(live.client, "plasticity_measure_fastener_grip_stack", {
      layers: [{
        id: "plate",
        first: { bodyId: plateId, faceId: gripFaces[0].id },
        second: { bodyId: plateId, faceId: gripFaces[1].id },
      }],
      axis: [0, 0, 1],
      revision: state.revision,
    });
    requireCondition(grip.totalGripMm === 8 && grip.gripItems[0].thicknessMm === 8, "Native grip-stack measurement did not return the exact 8 mm plate thickness");
    const stack = await call(live.client, "plasticity_check_fastener_stack", {
      designation: "крепится на 4 болта ISO 4017 M5x10 класса 8.8 с гайками",
      lengthMeasurement: "under-head",
      gripItems: grip.gripItems,
      receiver: { kind: "nut", nutThicknessMm: 4, minimumProtrusionMm: 1.6 },
    });
    requireCondition(stack.status === "fail", "M5x10 unexpectedly fitted the native 8 mm plate and nut stack");
    requireCondition(stack.minimumRequiredLengthMm === 13.6, "Fastener stack did not return the exact 13.6 mm minimum length");
    requireCondition(stack.issues.some((issue: { code: string }) => issue.code === "FASTENER_TOO_SHORT"), "Fastener stack did not report the short nominal length");
    evidence.fastenerStack = {
      measurementSource: grip.measurementSource,
      measuredRevision: grip.revision,
      layers: grip.layers.map((layer: any) => ({ id: layer.id, bodyId: layer.bodyId, bodyVersionId: layer.bodyVersionId, thicknessMm: layer.thicknessMm })),
      status: stack.status,
      nominalLengthMm: stack.designation.nominalLengthMm,
      gripThicknessMm: stack.gripThicknessMm,
      minimumRequiredLengthMm: stack.minimumRequiredLengthMm,
      minimumLengthMarginMm: stack.minimumLengthMarginMm,
      issueCodes: stack.issues.map((issue: { code: string }) => issue.code),
    };
    const pattern = await call(live.client, "plasticity_create_through_hole_pattern", {
      targetId: plateId,
      entryCentersMm: [[10, 10, 8], [50, 10, 8], [10, 30, 8], [50, 30, 8]],
      axis: [0, 0, -1], holeDiameterMm: 6, throughDepthMm: 8, overshootMm: 0.5,
      intent: "Approved disposable fastener-group acceptance", revision: state.revision,
    });
    requireCondition(pattern.holeCount === 4 && pattern.undoSteps === 5, "Through-hole pattern did not report four holes and five native steps");
    state = await call(live.client, "plasticity_status", {});
    const plate = state.bodies.find((body: { id: number }) => body.id === plateId);
    requireCondition(plate, "Boolean did not retain the plate body");
    const holeFaces = plate.faces.filter((face: any) =>
      face.surfaceType === "Cylinder" && face.radiusMm !== null && Math.abs(face.radiusMm - 3) <= 0.01
    );
    requireCondition(holeFaces.length === 4, `Expected four native cylindrical hole faces, found ${holeFaces.length}`);

    const inspected = await call(live.client, "plasticity_inspect_fastener_group", {
      bodyId: plateId,
      cylindricalFaceIds: holeFaces.map((face: { id: string }) => face.id),
      frame: { originMm: [30, 20, 8], normal: [0, 0, 1], xDirection: [1, 0, 0] },
      revision: state.revision,
    });
    requireCondition(inspected.status === "verified", `Fastener group was not verified: ${JSON.stringify(inspected.reasons)}`);
    requireCondition(inspected.fasteners.length === 4, "Inspector did not return four fasteners");
    const expectedPoints = [[-20, -10], [20, -10], [-20, 10], [20, 10]] as const;
    for (const fastener of inspected.fasteners) {
      near(fastener.diameterMm, 6, 0.01, `${fastener.id} diameter`);
      requireCondition(expectedPoints.some(([x, y]) => Math.abs(fastener.xMm - x) <= 0.01 && Math.abs(fastener.yMm - y) <= 0.01), `Unexpected fastener center ${fastener.xMm},${fastener.yMm}`);
    }
    const boundaryFaces = plate.faces.filter((face: any) =>
      face.planar && face.normal[2] > 1 - 1e-8 && Math.abs(face.boundsMm.min[2] - 8) <= 0.01 && Math.abs(face.boundsMm.max[2] - 8) <= 0.01
    );
    requireCondition(boundaryFaces.length === 1, `Expected one upper rectangular boundary face, found ${boundaryFaces.length}`);
    const opposedFaces = plate.faces.filter((face: any) =>
      face.planar && face.normal[2] < -1 + 1e-8 && Math.abs(face.boundsMm.min[2]) <= 0.01 && Math.abs(face.boundsMm.max[2]) <= 0.01
    );
    requireCondition(opposedFaces.length === 1, `Expected one lower rectangular boundary face, found ${opposedFaces.length}`);
    const layoutRequest = {
      bodyId: plateId,
      boundaryFaceId: boundaryFaces[0].id,
      opposedFaceId: opposedFaces[0].id,
      cylindricalFaceIds: holeFaces.map((face: { id: string }) => face.id),
      frame: { originMm: [30, 20, 8], normal: [0, 0, 1], xDirection: [1, 0, 0] },
      revision: state.revision,
    };
    const measuredLayout = await call(live.client, "plasticity_check_fastener_group_layout", layoutRequest);
    requireCondition(measuredLayout.status === "verified" && measuredLayout.evaluation.status === "measured", "A layout without requirements did not stay measurement-only");
    requireCondition(measuredLayout.measurementSource === "native-brep-opposed-boundaries-and-cylindrical-faces", "Opposed group-plate geometry was not measured from exact native faces");
    near(measuredLayout.plate.thicknessMm, 8, 0.01, "fastener-group plate thickness");
    evidence.groupPlateGeometry = {
      measurementSource: measuredLayout.measurementSource,
      frontFaceId: boundaryFaces[0].id,
      backFaceId: opposedFaces[0].id,
      thicknessMm: measuredLayout.plate.thicknessMm,
      holeCount: measuredLayout.fasteners.length,
    };
    const layout = await call(live.client, "plasticity_check_fastener_group_layout", {
      ...layoutRequest,
      requirements: {
        basis: "SYNTHETIC acceptance criteria; explicit values, not inferred from M5",
        minimumCenterToEdgeMm: 10,
        minimumHoleEdgeClearanceMm: 7,
        minimumCenterSpacingMm: 20,
        minimumHoleLigamentMm: 14,
        envelopes: [{ id: "synthetic-mounting-envelope", diameterMm: 10, minimumBoundaryClearanceMm: 5, minimumMutualClearanceMm: 10 }],
      },
    });
    requireCondition(layout.status === "verified" && layout.evaluation.status === "pass", `Fastener layout did not pass explicit acceptance criteria: ${JSON.stringify(layout.evaluation)}`);
    requireCondition(layout.fasteners.length === 4 && layout.pairs.length === 6, "Fastener layout did not return four holes and six unique pairs");
    for (const fastener of layout.fasteners) {
      near(fastener.minimumCenterToEdgeMm, 10, 0.01, `${fastener.id} minimum center-to-edge`);
      near(fastener.minimumHoleEdgeClearanceMm, 7, 0.01, `${fastener.id} minimum hole-edge clearance`);
    }
    near(Math.min(...layout.pairs.map((pair: any) => pair.centerSpacingMm)), 20, 0.01, "minimum fastener pitch");
    near(Math.min(...layout.pairs.map((pair: any) => pair.holeLigamentMm)), 14, 0.01, "minimum hole ligament");
    near(layout.envelopes[0].minimumBoundaryClearanceMm, 5, 0.01, "minimum mounting-envelope boundary clearance");
    near(layout.envelopes[0].minimumMutualClearanceMm, 10, 0.01, "minimum mounting-envelope mutual clearance");

    const loadEvidence = [
      sourced("load-force-x", "Applied in-plane X force", 100, "N"),
      sourced("load-force-y", "Applied in-plane Y force", 0, "N"),
      sourced("load-point-x", "Load application X", 0, "mm"),
      sourced("load-point-y", "Load application Y", 30, "mm"),
      sourced("load-free-moment", "Applied free moment", 0, "Nmm"),
    ];
    const groupInput = {
      kind: "fastener-group-load",
      goal: "SYNTHETIC live four-fastener load-distribution benchmark",
      method: "fastener-group-elastic-in-plane-v1",
      fasteners: inspected.loadDistributionGeometry.fasteners,
      load: { forceXN: 100, forceYN: 0, applicationPointXmm: 0, applicationPointYmm: 30, freeMomentNmm: 0 },
      evidence: [...inspected.loadDistributionGeometry.evidence, ...loadEvidence],
      assignments: {
        ...inspected.loadDistributionGeometry.assignments,
        "load.forceXN": "load-force-x",
        "load.forceYN": "load-force-y",
        "load.applicationPointXmm": "load-point-x",
        "load.applicationPointYmm": "load-point-y",
        "load.freeMomentNmm": "load-free-moment",
      },
      assumptions: [
        "static-in-plane-load",
        "rigid-attachment-member",
        "identical-fastener-in-plane-stiffness",
        "no-slip-or-clearance-redistribution",
        "fastener-points-represent-load-transfer-centers",
        "load-resultant-is-complete",
      ].map((code) => ({ code, confirmed: true, evidenceIds: [] })),
      binding: inspected.loadDistributionGeometry.binding,
    };
    const report = await call(live.client, "plasticity_verify_fastener_group_load", groupInput);
    requireCondition(report.result.status === "calculated", `Fastener-group distribution returned ${String(report.result.status)}`);
    near(report.result.centroidMm.x, 0, 1e-10, "group centroid X");
    near(report.result.centroidMm.y, 0, 1e-10, "group centroid Y");
    near(report.result.equilibrium.forceResidualN, 0, 1e-10, "group force residual");
    near(report.result.equilibrium.momentResidualNmm, 0, 1e-10, "group moment residual");
    evidence.group = {
      bodyId: plateId,
      faceIds: holeFaces.map((face: { id: string }) => face.id),
      binding: inspected.binding,
      fasteners: inspected.fasteners,
      reportId: report.id,
      recipe: { name: pattern.recipe, holeCount: pattern.holeCount, undoSteps: pattern.undoSteps },
      result: {
        status: report.result.status,
        centroidMm: report.result.centroidMm,
        governing: report.result.governing,
        equilibrium: report.result.equilibrium,
      },
      layout: {
        binding: layout.binding,
        measurementOnlyStatus: measuredLayout.evaluation.status,
        evaluation: layout.evaluation,
        plate: layout.plate,
        fasteners: layout.fasteners,
        pairs: layout.pairs,
        envelopes: layout.envelopes,
      },
    };

    const plateBearingReport = await call(live.client, "plasticity_verify_fastener_group_plate_bearing", {
      group: groupInput,
      netTension: {
        axis: "x",
        demandN: 100,
        tensileDesignAllowableMPa: 10,
        allowableEvidence: sourced("synthetic-net-tension-allowable", "Synthetic acceptance-only net-tension allowable", 10, "MPa"),
        assumptions: {
          uniformMembraneTension: true,
          loadCenteredThroughThickness: true,
          straightCutFailurePath: true,
        },
      },
      plate: {
        boundaryFaceId: boundaryFaces[0].id,
        opposedFaceId: opposedFaces[0].id,
        bearingDesignAllowableMPa: 20,
        allowableEvidence: sourced("synthetic-bearing-allowable", "Synthetic acceptance-only bearing allowable", 20, "MPa"),
        materialConfiguration: "SYNTHETIC acceptance fixture only; not a material qualification",
        materialSuitability: "matched",
        assumptions: {
          homogeneousEquivalentPlate: true,
          nominalBearingContact: true,
          loadCenteredThroughThickness: true,
        },
      },
    });
    requireCondition(plateBearingReport.kind === "fastener-group-plate-bearing" && typeof plateBearingReport.id === "string", "Group-plate bearing tool did not persist an immutable report");
    const plateBearing = plateBearingReport.result;
    requireCondition(plateBearing.status === "conditional", `Group-plate bearing must stay conditional, got ${String(plateBearing.status)}`);
    requireCondition(plateBearing.bearingCheckStatus === "within-allowable", `Synthetic local bearing screen did not stay within its synthetic allowable: ${String(plateBearing.bearingCheckStatus)}`);
    requireCondition(plateBearing.fasteners.length === 4, "Group-plate bearing did not return four per-hole results");
    near(plateBearing.plate.thicknessMm, 8, 0.01, "group-plate bearing measured thickness");
    near(plateBearing.plate.bearingDesignAllowableMPa, 20, 1e-10, "synthetic bearing allowable");
    requireCondition(plateBearing.netSection?.method === "straight-transverse-cut-v1", "Group-plate check omitted its straight-cut net-section result");
    near(plateBearing.netSection.minimumNetWidthMm, 28, 0.01, "group-plate straight-cut net width");
    near(plateBearing.netSection.thicknessMm, 8, 0.01, "group-plate net-section thickness");
    near(plateBearing.netSection.netAreaMm2, 224, 0.01, "group-plate net-section area");
    near(plateBearing.netSection.tensileStressMPa, 100 / 224, 1e-9, "group-plate nominal net tension stress");
    requireCondition(plateBearing.netSection.checkStatus === "within-allowable", "Synthetic straight-cut net-tension screen did not stay within its synthetic allowable");
    requireCondition(plateBearing.unchecked.some((item: string) => /angled\/staggered net-section paths/i.test(item)), "Group-plate check omitted angled/staggered net-section limitations");
    requireCondition(/complete joint remain unchecked/i.test(plateBearing.checkedScope), "Group-plate strength screen overclaimed its scope");
    evidence.groupPlateBearing = {
      status: plateBearing.status,
      bearingCheckStatus: plateBearing.bearingCheckStatus,
      netSection: plateBearing.netSection,
      method: plateBearing.method,
      reportId: plateBearingReport.id,
      inputHash: plateBearing.inputHash,
      measuredThicknessMm: plateBearing.plate.thicknessMm,
      syntheticAllowableMPa: plateBearing.plate.bearingDesignAllowableMPa,
      fasteners: plateBearing.fasteners,
      governing: plateBearing.governing,
      checkedScope: plateBearing.checkedScope,
      unchecked: plateBearing.unchecked,
    };

    const acceptedRevision = state.revision;
    const currentPlateBearing = await call(live.client, "plasticity_fastener_group_plate_bearing_report", { reportId: plateBearingReport.id, current: plateBearingReport.input });
    requireCondition(currentPlateBearing.freshness === "current", "New group-plate bearing report did not verify as current");

    const centeredGroup = {
      ...groupInput,
      load: { ...groupInput.load, applicationPointYmm: 0 },
      evidence: groupInput.evidence.map((item: any) => item.id === "load-point-y" ? { ...item, value: 0 } : item),
    };
    const edgeShearReport = await call(live.client, "plasticity_verify_fastener_group_plate_bearing", {
      ...plateBearingReport.input,
      group: centeredGroup,
      edgeShearOut: {
        shearDesignAllowableMPa: 5,
        allowableEvidence: sourced("synthetic-edge-shear-allowable", "Synthetic acceptance-only two-plane shear-out allowable", 5, "MPa"),
        assumptions: {
          homogeneousEquivalentPlate: true,
          loadCenteredThroughThickness: true,
          twoPlaneShearOut: true,
        },
      },
    });
    const edgeShear = edgeShearReport.result.edgeShearOut;
    requireCondition(edgeShear?.method === "two-plane-loaded-edge-v1", "Group plate report omitted the two-plane edge shear-out screen");
    requireCondition(edgeShear.fasteners.length === 4, "Edge shear-out screen did not evaluate every hole");
    requireCondition(edgeShear.fasteners.every((fastener: any) => fastener.checkStatus !== "unsupported"), "Axis-aligned direct-load acceptance unexpectedly used an unsupported shear-out direction");
    near(Math.max(...edgeShear.fasteners.map((fastener: any) => fastener.nominalShearOutStressMPa)), 25 / 112, 1e-9, "group-plate edge shear-out stress");
    requireCondition(edgeShear.fasteners.some((fastener: any) => fastener.loadedEdge === "+X" && fastener.checkStatus === "conditional"), "Small e/d edge did not remain conditional");
    requireCondition(edgeShearReport.result.status === "conditional", "Group-plate edge shear-out overclaimed an overall pass");
    const currentEdgeShear = await call(live.client, "plasticity_fastener_group_plate_bearing_report", { reportId: edgeShearReport.id, current: edgeShearReport.input });
    requireCondition(currentEdgeShear.freshness === "current", "New edge shear-out report did not verify as current");
    evidence.groupPlateEdgeShearOut = {
      status: edgeShear.status,
      method: edgeShear.method,
      syntheticAllowableMPa: edgeShear.designAllowableMPa,
      fasteners: edgeShear.fasteners,
      governing: edgeShear.governing,
      issues: edgeShear.issues,
      freshnessBeforeEdit: currentEdgeShear.freshness,
    };

    state = await call(live.client, "plasticity_move", {
      ids: [plateId], deltaMm: [1, 0, 0], intent: "Disposable stale fastener-group reference check", revision: state.revision,
    });
    const stale = await call(live.client, "plasticity_inspect_fastener_group", {
      bodyId: plateId,
      cylindricalFaceIds: holeFaces.map((face: { id: string }) => face.id),
      frame: { originMm: [30, 20, 8], normal: [0, 0, 1], xDirection: [1, 0, 0] },
      revision: acceptedRevision,
    });
    requireCondition(stale.status === "unsupported" && stale.reasons.includes("stale-reference"), "Inspector accepted a stale document revision");
    const staleLayout = await call(live.client, "plasticity_check_fastener_group_layout", layoutRequest);
    requireCondition(staleLayout.status === "unsupported" && staleLayout.reasons.includes("stale-reference"), "Layout checker accepted a stale document revision");
    const staleReport = await call(live.client, "plasticity_strength_report", { reportId: report.id, current: report.input });
    requireCondition(staleReport.freshness === "stale", "CAD-bound fastener-group report remained current after a document edit");
    requireCondition(staleReport.reasons.includes("CAD_REVISION_CHANGED") || staleReport.reasons.includes("CAD_TOPOLOGY_CHANGED"), `Unexpected report freshness reasons: ${JSON.stringify(staleReport.reasons)}`);
    const stalePlateBearing = await call(live.client, "plasticity_fastener_group_plate_bearing_report", { reportId: plateBearingReport.id, current: plateBearingReport.input });
    requireCondition(stalePlateBearing.freshness === "stale" && stalePlateBearing.reasons.includes("CAD_REVISION_CHANGED"), "Group-plate bearing report did not become stale after a CAD edit");
    const staleEdgeShear = await call(live.client, "plasticity_fastener_group_plate_bearing_report", { reportId: edgeShearReport.id, current: edgeShearReport.input });
    requireCondition(staleEdgeShear.freshness === "stale" && staleEdgeShear.reasons.includes("CAD_REVISION_CHANGED"), "Group-plate edge shear-out report did not become stale after a CAD edit");
    state = await call(live.client, "plasticity_undo", { intent: "Restore accepted fastener-group plate", revision: state.revision });
    evidence.staleReference = { rejected: true, reasons: stale.reasons, layoutReasons: staleLayout.reasons, reportFreshness: staleReport.freshness, reportReasons: staleReport.reasons, plateBearingReportFreshness: stalePlateBearing.freshness, plateBearingReportReasons: stalePlateBearing.reasons, edgeShearOutReportFreshness: staleEdgeShear.freshness, edgeShearOutReportReasons: staleEdgeShear.reasons };

    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCleanJournal(journal);
    for (let step = 0; step < 6; step += 1) {
      state = await call(live.client, "plasticity_undo", { intent: "Cleanup disposable fastener-group acceptance", revision: state.revision });
    }
    requireCondition(state.documentToken === initialState.documentToken && state.bodies.length === 0, "Cleanup did not restore the empty document");
    const finalJournal = await call(live.client, "plasticity_construction_journal", {});
    requireCleanJournal(finalJournal);
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = {
      restoredEmptyDocument: true,
      sceneContentsRestored: true,
      journalSyncStatus: finalJournal.syncStatus,
      uncertainJournalEntries: finalJournal.entries.filter((entry: { status: string }) => entry.status === "unknown").length,
    };
    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json") }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    if (live && initialState && !evidence.cleanup) {
      evidence.cleanup = await recover(live.client, initialState).catch((cleanupError) => ({ restoredEmptyDocument: false, reason: boundedError(cleanupError) }));
    }
    await writeExclusive(join(output, "failure.json"), sanitizeEvidence(evidence)).catch(() => {});
    throw error;
  } finally {
    await live?.client.close().catch(() => {});
  }
}

function sourced(id: string, label: string, value: number, unit: "mm" | "N" | "Nmm" | "MPa") {
  return {
    id, label, value, unit, status: "sourced",
    sourceUrl: "https://example.invalid/plasticity-mcp-synthetic-acceptance",
    sourceHash: "sha256:synthetic-load-case-not-design-data",
    dependsOn: [],
  };
}

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "run-server.ts")],
    cwd: projectRoot,
    env: { ...selectedEnvironment(process.env), PLASTICITY_STRENGTH_ROOT: storeRoot, PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223" },
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => { stderr.push(String(chunk).slice(-4096)); while (stderr.join("").length > 16384) stderr.shift(); });
  const client = new Client({ name: "plasticity-fastener-group-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const text = toolText(response);
  if ("isError" in response && response.isError) throw new Error(text);
  return JSON.parse(text);
}

function toolText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) throw new Error("MCP tool returned no content");
  const item = response.content.find((entry): entry is { type: "text"; text: string } => typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string");
  if (!item) throw new Error("MCP tool returned no text content");
  return item.text;
}

async function recover(client: Client, initial: any): Promise<Record<string, unknown>> {
  for (let count = 0; count < 16; count += 1) {
    const status = await call(client, "plasticity_status", {});
    if (status.documentToken !== initial.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" };
    if (status.bodies.length === 0) return { restoredEmptyDocument: true };
    const journal = await call(client, "plasticity_construction_journal", {});
    if (journal.syncStatus !== "in-sync" || journal.entries.some((entry: { status: string }) => entry.status === "unknown")) return { restoredEmptyDocument: false, reason: "unsafe-journal" };
    await call(client, "plasticity_undo", { intent: "Recover disposable fastener-group acceptance", revision: status.revision });
  }
  return { restoredEmptyDocument: false, reason: "undo-limit" };
}

function requireCleanJournal(journal: any): void {
  requireCondition(journal.syncStatus === "in-sync", `Construction journal is ${String(journal.syncStatus)}`);
  requireCondition(!journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal contains an uncertain mutation");
}

function stateSummary(state: any): Record<string, unknown> {
  return { documentToken: state.documentToken, revision: state.revision, undoDepth: state.undoDepth, redoDepth: state.redoDepth, bodyCount: state.bodies.length };
}

function near(actual: number, expected: number, tolerance: number, label: string): void {
  requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`);
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]!]] : []));
}

function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4000); }

async function writeExclusive(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(boundedError(error)); process.exitCode = 1; });
}
