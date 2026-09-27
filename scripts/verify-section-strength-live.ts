#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { Evidence } from "../src/strength/contracts.ts";
import type { SectionScenarioInput } from "../src/strength/section-contracts.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface SectionAcceptanceOptions {
  help: boolean;
  target?: string;
  allowDisposableMutations: boolean;
  output?: string;
}

interface LiveMcp {
  client: Client;
  transport: StdioClientTransport;
  stderr: string[];
}

interface AcceptanceEvidence {
  schemaVersion: 1;
  startedAt: string;
  completedAt?: string;
  targetId: string;
  initial: unknown;
  rectangle?: unknown;
  candidateSections?: unknown;
  sectionScan?: unknown;
  sectionStrengthScan?: unknown;
  sectionStrengthScanStaleness?: unknown;
  circle?: unknown;
  circleTorsion?: unknown;
  annulus?: unknown;
  annulusTorsion?: unknown;
  thinWallTorsion?: unknown;
  holed?: unknown;
  arbitraryPlane?: unknown;
  staleAndHistory?: unknown;
  cleanup?: unknown;
  workbenchUsed: false;
  failure?: string;
}

export function parseSectionAcceptanceArgs(argv: string[]): SectionAcceptanceOptions {
  if (argv.length === 0) return { help: true, allowDisposableMutations: false };
  const options: SectionAcceptanceOptions = { help: false, allowDisposableMutations: false };
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
  if (!options.target) throw new Error("Live section acceptance requires --target with an explicit window ID");
  if (!options.allowDisposableMutations) throw new Error("Live section acceptance requires --allow-disposable-mutations");
  if (!options.output) throw new Error("Live section acceptance requires --output with a new directory");
  return options;
}

const HELP = `Usage:
  node scripts/verify-section-strength-live.ts --help
  node scripts/verify-section-strength-live.ts --target ID --allow-disposable-mutations --output NEW_DIRECTORY

With no arguments or --help, this command performs no connection and no mutation.
Live mode refuses a nonempty Plasticity document, never chooses a window automatically,
uses a separate stdio MCP process, and writes only sanitized evidence to a new directory.`;

async function main(): Promise<void> {
  const options = parseSectionAcceptanceArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const evidence: AcceptanceEvidence = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    targetId: options.target!,
    initial: null,
    workbenchUsed: false,
  };
  let live: LiveMcp | undefined;
  let initialState: any;
  try {
    live = await startMcp(join(output, "strength-store"));
    const windows = await call(live.client, "plasticity_list_windows", {});
    requireCondition(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    initialState = await call(live.client, "plasticity_connect", { targetId: options.target });
    requireCondition(Array.isArray(initialState.bodies) && initialState.bodies.length === 0, "Refusing disposable mutations in a nonempty Plasticity document");
    evidence.initial = stateSummary(initialState);
    const snapshot = await call(live.client, "plasticity_capture_snapshot", { label: "section-strength-live-initial-empty" });

    let state = await call(live.client, "plasticity_create_box", {
      originMm: [0, 0, 0],
      sizeMm: [20, 10, 5],
      name: "Disposable exact section rectangle",
      intent: "Approved disposable planar-section acceptance",
      revision: initialState.revision,
    });
    const rectangleBody = onlyAddedBody(state, []);
    const rectangleFace = await findTopFace(live.client, rectangleBody.id, state.revision, 4);
    const rectangle = await inspectSection(live.client, rectangleBody.id, rectangleFace.id, state.revision);
    requireVerifiedSection(rectangle);
    near(rectangle.properties.areaMm2, 200, 1e-8, "rectangle area");
    near(rectangle.properties.ixxMm4, 1666.6666666667, 1e-8, "rectangle Ixx");
    near(rectangle.properties.iyyMm4, 6666.6666666667, 1e-8, "rectangle Iyy");

    const candidateSections = await call(live.client, "plasticity_inspect_arbitrary_sections", {
      bodyId: rectangleBody.id,
      revision: state.revision,
      planes: [
        { originMm: [10, 5, 2.5], normal: [0, 0, 1], xDirection: [1, 0, 0] },
        { originMm: [10, 5, 2.5], normal: [1, 0, 0], xDirection: [0, 1, 0] },
        { originMm: [10, 5, 2.5], normal: [0, 1, 0], xDirection: [1, 0, 0] },
      ],
    });
    requireCondition(candidateSections.status === "complete", "Candidate section inspection did not complete");
    requireCondition(candidateSections.sections.length === 3, "Candidate section inspection lost a plane");
    for (const [index, expectedArea] of [200, 50, 100].entries()) {
      requireVerifiedSection(candidateSections.sections[index]);
      near(candidateSections.sections[index].properties.areaMm2, expectedArea, 1e-8, `candidate section ${index} area`);
      requireCondition(candidateSections.sections[index].binding.revision === state.revision, `Candidate section ${index} has a mixed CAD revision`);
    }
    evidence.candidateSections = {
      revision: candidateSections.binding.revision,
      areasMm2: candidateSections.sections.map((section: any) => section.properties.areaMm2),
      statuses: candidateSections.sections.map((section: any) => section.status),
    };
    const sectionScan = await call(live.client, "plasticity_scan_arbitrary_sections", {
      bodyId: rectangleBody.id,
      revision: state.revision,
      startPlane: { originMm: [0, 5, 2.5], normal: [1, 0, 0], xDirection: [0, 1, 0] },
      fromOffsetMm: 1,
      toOffsetMm: 19,
      stationCount: 3,
    });
    requireCondition(sectionScan.scan.spacingMm === 9, "Section scan did not report the expected station spacing");
    requireCondition(sectionScan.sections.length === 3, "Section scan lost a station");
    for (const [index, section] of sectionScan.sections.entries()) {
      requireVerifiedSection(section);
      near(section.properties.areaMm2, 50, 1e-8, `section scan station ${index} area`);
      requireCondition(section.binding.revision === state.revision, `Section scan station ${index} has a mixed CAD revision`);
    }
    evidence.sectionScan = {
      scan: sectionScan.scan,
      originsMm: sectionScan.sections.map((section: any) => section.binding.plane.originMm),
      areasMm2: sectionScan.sections.map((section: any) => section.properties.areaMm2),
    };
    const {
      kind: _kind,
      frame: _frame,
      loops: _loops,
      properties: _properties,
      binding: _binding,
      ...sectionScenario
    } = sectionBenchmark(rectangle);
    const sectionStrengthScan = await call(live.client, "plasticity_scan_section_strength", {
      bodyId: rectangleBody.id,
      revision: state.revision,
      startPlane: { originMm: [0, 5, 2.5], normal: [1, 0, 0], xDirection: [0, 1, 0] },
      fromOffsetMm: 1,
      toOffsetMm: 19,
      stationCount: 3,
      scenario: sectionScenario,
    });
    requireCondition(sectionStrengthScan.candidates.length === 3, "Strength scan lost a station");
    requireCondition(sectionStrengthScan.ranking.status === "complete", `Strength scan ranking was incomplete: ${JSON.stringify(sectionStrengthScan.ranking.excludedStationIndices)}`);
    requireCondition(sectionStrengthScan.ranking.governingStationIndex === 0, `Unexpected governing section station ${String(sectionStrengthScan.ranking.governingStationIndex)}`);
    requireCondition(sectionStrengthScan.candidates.every((candidate: any) =>
      candidate.calculation?.issues.some((issue: { code: string }) => issue.code === "MATERIAL_UNCONFIRMED"),
    ), "Synthetic material uncertainty was not retained in every station calculation");
    requireCondition(typeof sectionStrengthScan.scanReportId === "string", "Strength scan did not save an immutable scan report");
    const sectionStrengthScanReport = await call(live.client, "plasticity_section_strength_scan_report", {
      scanReportId: sectionStrengthScan.scanReportId,
    });
    requireCondition(sectionStrengthScanReport.freshness === "current", `Saved strength scan did not re-verify as current: ${JSON.stringify(sectionStrengthScanReport.reasons)}`);
    requireCondition(sectionStrengthScanReport.report.candidates.length === 3, "Saved strength scan lost candidate stations");
    requireCondition(sectionStrengthScanReport.report.candidates.every((candidate: any) => candidate.input && candidate.calculation), "Saved strength scan omitted exact candidate inputs or calculations");
    evidence.sectionStrengthScan = {
      reportId: sectionStrengthScan.scanReportId,
      freshnessBeforeEdit: sectionStrengthScanReport.freshness,
      scan: sectionStrengthScan.scan,
      ranking: sectionStrengthScan.ranking,
      stations: sectionStrengthScan.candidates.map((candidate: any) => ({
        stationIndex: candidate.stationIndex,
        offsetMm: candidate.offsetMm,
        status: candidate.status,
        maximumSingleModeUtilization: candidate.maximumSingleModeUtilization,
        governingComponent: candidate.governingComponent,
        properties: candidate.properties,
        issueCodes: candidate.calculation.issues.map((issue: { code: string }) => issue.code),
      })),
    };

    const rectangleInput = sectionBenchmark(rectangle);
    const rectangleScenario = await call(live.client, "plasticity_calculate_section_strength", { ...rectangleInput });
    requireCondition(rectangleScenario.input.binding === undefined, "Unbound section scenario retained a caller CAD binding");
    requireCondition(rectangleScenario.result.status === "conditional", `Rectangle scenario returned ${rectangleScenario.result.status}`);
    const rectangleReport = await call(live.client, "plasticity_verify_section_strength", { ...rectangleInput });
    requireCondition(rectangleReport.result.status === "conditional", `Verified rectangle returned ${rectangleReport.result.status}`);
    near(rectangleReport.result.resultants.axialN, 100, 1e-10, "rectangle axial resultant");
    near(rectangleReport.result.resultants.shearXN, 2, 1e-10, "rectangle shear resultant");
    near(rectangleReport.result.resultants.bendingYNmm, -500, 1e-8, "rectangle bending resultant");
    near(rectangleReport.result.normalStressMPa.minimum, -0.25, 1e-9, "rectangle minimum normal stress");
    near(rectangleReport.result.normalStressMPa.maximum, 1.25, 1e-9, "rectangle maximum normal stress");
    near(rectangleReport.result.shearStressMPa, 0.015, 1e-12, "rectangle shear stress");
    evidence.rectangle = {
      bodyId: rectangleBody.id,
      faceId: rectangleFace.id,
      reportId: rectangleReport.id,
      properties: sectionPropertySummary(rectangle),
      result: resultSummary(rectangleReport.result),
    };

    const arbitrary = await call(live.client, "plasticity_inspect_arbitrary_section", {
      bodyId: rectangleBody.id,
      revision: state.revision,
      plane: { originMm: [10, 5, 2.5], normal: [1, 0, 0], xDirection: [0, 1, 0] },
    });
    requireVerifiedSection(arbitrary);
    near(arbitrary.properties.areaMm2, 50, 1e-8, "arbitrary-plane area");
    const arbitraryReport = await call(live.client, "plasticity_verify_section_strength", {
      ...sectionBenchmark(arbitrary),
    });
    requireCondition(arbitraryReport.input.binding.plane !== undefined, "Arbitrary report lost its plane binding");
    requireCondition(arbitraryReport.input.binding.faceId === undefined, "Arbitrary report was incorrectly converted to a face binding");
    near(arbitraryReport.input.properties.areaMm2, 50, 1e-8, "verified arbitrary-plane area");
    near(arbitraryReport.result.resultants.axialN, 2, 1e-10, "arbitrary-plane axial resultant");
    near(arbitraryReport.result.resultants.shearYN, 100, 1e-10, "arbitrary-plane transverse resultant");
    near(arbitraryReport.result.resultants.bendingXNmm, -500, 1e-8, "arbitrary-plane bending resultant");
    near(arbitraryReport.result.normalStressMPa.minimum, -11.96, 1e-8, "arbitrary-plane minimum normal stress");
    near(arbitraryReport.result.normalStressMPa.maximum, 12.04, 1e-8, "arbitrary-plane maximum normal stress");
    near(arbitraryReport.result.shearStressMPa, 3, 1e-10, "arbitrary-plane shear stress");
    const arbitraryFreshness = await call(live.client, "plasticity_strength_report", {
      reportId: arbitraryReport.id,
      current: arbitraryReport.input,
    });
    requireCondition(arbitraryFreshness.freshness === "current", `Arbitrary report did not re-verify as current: ${JSON.stringify(arbitraryFreshness.reasons)}`);
    evidence.arbitraryPlane = {
      reportId: arbitraryReport.id,
      binding: arbitraryReport.input.binding,
      properties: sectionPropertySummary(arbitrary),
      result: resultSummary(arbitraryReport.result),
      freshnessBeforeEdit: arbitraryFreshness.freshness,
    };

    state = await call(live.client, "plasticity_create_cylinder", {
      centerMm: [35, 5, 0],
      radiusMm: 5,
      heightMm: 5,
      axis: [0, 0, 1],
      name: "Disposable exact circular section",
      intent: "Approved disposable circular-section acceptance",
      revision: state.revision,
    });
    const circleBody = onlyAddedBody(state, [rectangleBody.id]);
    const circleFace = await findTopFace(live.client, circleBody.id, state.revision, 1);
    const circle = await inspectSection(live.client, circleBody.id, circleFace.id, state.revision);
    requireVerifiedSection(circle);
    near(circle.properties.areaMm2, 25 * Math.PI, 1e-8, "circle area");
    near(circle.properties.ixxMm4, 156.25 * Math.PI, 1e-8, "circle Ixx");
    near(circle.properties.iyyMm4, 156.25 * Math.PI, 1e-8, "circle Iyy");
    const circleReport = await call(live.client, "plasticity_verify_section_strength", { ...sectionBenchmark(circle, { axialForceN: 0 }) });
    requireCondition(circleReport.result.status === "conditional", `Circular shear result returned ${circleReport.result.status}`);
    requireCondition(circleReport.result.methodVersion === "1.3.0", `Circular shear used passport ${String(circleReport.result.methodVersion)}`);
    requireCondition(circleReport.result.shearModel === "solid-circle", `Unexpected circular shear model ${String(circleReport.result.shearModel)}`);
    near(circleReport.result.shearStressMPa, 8 / (75 * Math.PI), 1e-12, "circle shear stress");
    evidence.circle = {
      bodyId: circleBody.id,
      faceId: circleFace.id,
      reportId: circleReport.id,
      properties: sectionPropertySummary(circle),
      result: resultSummary(circleReport.result),
    };
    const circleTorsionReport = await call(live.client, "plasticity_verify_section_strength", {
      ...sectionBenchmark(circle, { axialForceN: 0, transverseShearN: 0, torsionNmm: 100 }),
    });
    requireCondition(circleTorsionReport.result.status === "conditional", `Circular torsion result returned ${circleTorsionReport.result.status}`);
    requireCondition(circleTorsionReport.result.torsionModel === "solid-circle", `Unexpected circular torsion model ${String(circleTorsionReport.result.torsionModel)}`);
    near(circleTorsionReport.result.torsionalShearStressMPa, 100 * 5 / (2 * 156.25 * Math.PI), 1e-12, "circle torsional shear stress");
    evidence.circleTorsion = {
      reportId: circleTorsionReport.id,
      result: resultSummary(circleTorsionReport.result),
    };

    state = await call(live.client, "plasticity_create_cylinder", {
      centerMm: [55, 5, 0],
      radiusMm: 5,
      heightMm: 5,
      axis: [0, 0, 1],
      name: "Disposable exact annular section",
      intent: "Approved disposable annular-section acceptance",
      revision: state.revision,
    });
    const annulusBody = onlyAddedBody(state, [rectangleBody.id, circleBody.id]);
    const withAnnulusCutter = await call(live.client, "plasticity_create_cylinder", {
      centerMm: [55, 5, -1],
      radiusMm: 3,
      heightMm: 7,
      axis: [0, 0, 1],
      name: "Disposable annular section cutter",
      intent: "Approved disposable annular-section acceptance",
      revision: state.revision,
    });
    const annulusCutter = onlyAddedBody(withAnnulusCutter, [rectangleBody.id, circleBody.id, annulusBody.id]);
    state = await call(live.client, "plasticity_boolean", {
      targetIds: [annulusBody.id],
      toolIds: [annulusCutter.id],
      operation: "difference",
      keepTools: false,
      intent: "Approved disposable annular-section acceptance",
      revision: withAnnulusCutter.revision,
    });
    const annulusFace = await findTopFace(live.client, annulusBody.id, state.revision, 2);
    const annulus = await inspectSection(live.client, annulusBody.id, annulusFace.id, state.revision);
    requireVerifiedSection(annulus);
    near(annulus.properties.areaMm2, 16 * Math.PI, 1e-8, "annulus area");
    near(annulus.properties.ixxMm4, 136 * Math.PI, 1e-8, "annulus Ixx");
    near(annulus.properties.iyyMm4, 136 * Math.PI, 1e-8, "annulus Iyy");
    const annulusReport = await call(live.client, "plasticity_verify_section_strength", { ...sectionBenchmark(annulus, { axialForceN: 0 }) });
    requireCondition(annulusReport.result.status === "conditional", `Annular shear result returned ${annulusReport.result.status}`);
    requireCondition(annulusReport.result.shearModel === "concentric-circular-annulus", `Unexpected annular shear model ${String(annulusReport.result.shearModel)}`);
    near(annulusReport.result.shearStressMPa, 2 / (16 * Math.PI) * (4 / 3) * (49 / 34), 1e-12, "annulus shear stress");
    evidence.annulus = {
      bodyId: annulusBody.id,
      faceId: annulusFace.id,
      reportId: annulusReport.id,
      properties: sectionPropertySummary(annulus),
      result: resultSummary(annulusReport.result),
    };
    const annulusTorsionReport = await call(live.client, "plasticity_verify_section_strength", {
      ...sectionBenchmark(annulus, { axialForceN: 0, transverseShearN: 0, torsionNmm: 100 }),
    });
    requireCondition(annulusTorsionReport.result.status === "conditional", `Annular torsion result returned ${annulusTorsionReport.result.status}`);
    requireCondition(annulusTorsionReport.result.torsionModel === "concentric-circular-annulus", `Unexpected annular torsion model ${String(annulusTorsionReport.result.torsionModel)}`);
    near(annulusTorsionReport.result.torsionalShearStressMPa, 100 * 5 / (272 * Math.PI), 1e-12, "annulus torsional shear stress");
    evidence.annulusTorsion = {
      reportId: annulusTorsionReport.id,
      result: resultSummary(annulusTorsionReport.result),
    };

    state = await call(live.client, "plasticity_create_box", {
      originMm: [100, 0, 0],
      sizeMm: [20, 10, 5],
      name: "Disposable uniform thin-wall single-cell section",
      intent: "Approved disposable thin-wall torsion acceptance",
      revision: state.revision,
    });
    const thinWallBody = onlyAddedBody(state, [rectangleBody.id, circleBody.id, annulusBody.id]);
    const thinWallCutterState = await call(live.client, "plasticity_create_box", {
      originMm: [101, 1, -1],
      sizeMm: [18, 8, 7],
      name: "Disposable thin-wall section cutter",
      intent: "Approved disposable thin-wall torsion acceptance",
      revision: state.revision,
    });
    const thinWallCutter = onlyAddedBody(thinWallCutterState, [rectangleBody.id, circleBody.id, annulusBody.id, thinWallBody.id]);
    state = await call(live.client, "plasticity_boolean", {
      targetIds: [thinWallBody.id],
      toolIds: [thinWallCutter.id],
      operation: "difference",
      keepTools: false,
      intent: "Approved disposable thin-wall torsion acceptance",
      revision: thinWallCutterState.revision,
    });
    const thinWallFace = await findTopFace(live.client, thinWallBody.id, state.revision, 8);
    const thinWallSection = await inspectSection(live.client, thinWallBody.id, thinWallFace.id, state.revision);
    requireVerifiedSection(thinWallSection);
    near(thinWallSection.properties.areaMm2, 56, 1e-8, "thin-wall rectangle section area");
    const thinWallReport = await call(live.client, "plasticity_verify_section_strength", {
      ...sectionBenchmark(thinWallSection, { axialForceN: 0, transverseShearN: 0, torsionNmm: 100, thinWallTorsion: true }),
    });
    requireCondition(thinWallReport.result.torsionModel === "thin-walled-rectangular-single-cell", `Unexpected thin-wall torsion model ${String(thinWallReport.result.torsionModel)}; section=${JSON.stringify(thinWallSection.loops)}`);
    near(thinWallReport.result.torsionalMedianAreaMm2, 171, 1e-8, "thin-wall median area");
    near(thinWallReport.result.torsionalWallThicknessMm, 1, 1e-8, "thin-wall thickness");
    near(thinWallReport.result.torsionalShearFlowNPerMm, 100 / (2 * 171), 1e-10, "thin-wall shear flow");
    near(thinWallReport.result.torsionalShearStressMPa, 100 / (2 * 171), 1e-10, "thin-wall torsional shear");
    evidence.thinWallTorsion = {
      bodyId: thinWallBody.id,
      reportId: thinWallReport.id,
      properties: sectionPropertySummary(thinWallSection),
      result: resultSummary(thinWallReport.result),
    };

    state = await call(live.client, "plasticity_create_box", {
      originMm: [70, 0, 0],
      sizeMm: [20, 10, 5],
      name: "Disposable exact holed section",
      intent: "Approved disposable planar-section acceptance",
      revision: state.revision,
    });
    const holedBody = onlyAddedBody(state, [rectangleBody.id, circleBody.id, annulusBody.id, thinWallBody.id]);
    const withCutter = await call(live.client, "plasticity_create_cylinder", {
      centerMm: [80, 5, -1],
      radiusMm: 2,
      heightMm: 7,
      axis: [0, 0, 1],
      name: "Disposable section hole cutter",
      intent: "Approved disposable planar-section acceptance",
      revision: state.revision,
    });
    const cutter = onlyAddedBody(withCutter, [rectangleBody.id, circleBody.id, annulusBody.id, thinWallBody.id, holedBody.id]);
    state = await call(live.client, "plasticity_boolean", {
      targetIds: [holedBody.id],
      toolIds: [cutter.id],
      operation: "difference",
      keepTools: false,
      intent: "Approved disposable planar-section acceptance",
      revision: withCutter.revision,
    });
    const holedFace = await findTopFace(live.client, holedBody.id, state.revision, 5);
    const holed = await inspectSection(live.client, holedBody.id, holedFace.id, state.revision);
    requireVerifiedSection(holed);
    near(holed.properties.areaMm2, 200 - 4 * Math.PI, 1e-8, "holed area");
    near(holed.properties.ixxMm4, 1666.6666666667 - 4 * Math.PI, 1e-8, "holed Ixx");
    near(holed.properties.iyyMm4, 6666.6666666667 - 4 * Math.PI, 1e-8, "holed Iyy");
    requireCondition(holed.properties.innerLoopCount === 1, "Holed section did not expose one inner loop");
    const holedReport = await call(live.client, "plasticity_verify_section_strength", { ...sectionBenchmark(holed) });
    requireCondition(holedReport.result.status === "unsupported", `Holed shear result returned ${holedReport.result.status}`);
    requireCondition(holedReport.result.normalStressMPa !== undefined, "Holed section lost nominal normal-stress values");
    requireCondition(holedReport.result.issues.some((issue: { code: string }) => issue.code === "SECTION_FAMILY_SHEAR_UNSUPPORTED"), "Holed section did not retain unsupported direct shear");
    evidence.holed = {
      bodyId: holedBody.id,
      faceId: holedFace.id,
      reportId: holedReport.id,
      properties: sectionPropertySummary(holed),
      result: resultSummary(holedReport.result),
    };

    state = await call(live.client, "plasticity_scale", {
      ids: [rectangleBody.id],
      pivotMm: [0, 0, 0],
      factors: [1, 1, 0.8],
      intent: "Approved disposable section staleness check",
      revision: state.revision,
    });
    const stale = await call(live.client, "plasticity_strength_report", {
      reportId: rectangleReport.id,
      current: rectangleReport.input,
    });
    requireCondition(stale.freshness === "stale", "Old section report did not become stale after native body change");
    requireCondition(stale.reasons.includes("CAD_REVISION_CHANGED") || stale.reasons.includes("CAD_TOPOLOGY_CHANGED"), `Unexpected stale reasons: ${JSON.stringify(stale.reasons)}`);
    const staleArbitrary = await call(live.client, "plasticity_strength_report", {
      reportId: (evidence.arbitraryPlane as { reportId: string }).reportId,
      current: arbitraryReport.input,
    });
    requireCondition(staleArbitrary.freshness === "stale", "Arbitrary section report remained current after its Solid changed");
    requireCondition(staleArbitrary.reasons.includes("CAD_REVISION_CHANGED"), `Arbitrary report did not expose its changed Plasticity revision: ${JSON.stringify(staleArbitrary.reasons)}`);
    const staleStrengthScan = await call(live.client, "plasticity_section_strength_scan_report", {
      scanReportId: sectionStrengthScan.scanReportId,
    });
    requireCondition(staleStrengthScan.freshness === "stale", "Saved section-strength scan remained current after its Solid changed");
    requireCondition(staleStrengthScan.reasons.includes("CAD_REVISION_CHANGED"), `Section-strength scan did not expose its changed Plasticity revision: ${JSON.stringify(staleStrengthScan.reasons)}`);
    evidence.arbitraryPlane = { ...evidence.arbitraryPlane as object, staleReasonsAfterEdit: staleArbitrary.reasons };
    evidence.sectionStrengthScanStaleness = { freshnessAfterEdit: staleStrengthScan.freshness, reasons: staleStrengthScan.reasons };

    state = await call(live.client, "plasticity_undo", { intent: "Verify section scale Undo", revision: state.revision });
    const undoSection = await inspectCurrentTop(live.client, rectangleBody.id, state.revision, 4);
    near(undoSection.properties.centroidMm[2], 5, 0.01, "Undo top face Z");
    state = await call(live.client, "plasticity_redo", { intent: "Verify section scale Redo", revision: state.revision });
    const redoSection = await inspectCurrentTop(live.client, rectangleBody.id, state.revision, 4);
    near(redoSection.properties.centroidMm[2], 4, 0.01, "Redo top face Z");
    evidence.staleAndHistory = {
      staleReasons: stale.reasons,
      undoAreaMm2: undoSection.properties.areaMm2,
      undoCentroidZMm: undoSection.properties.centroidMm[2],
      redoAreaMm2: redoSection.properties.areaMm2,
      redoCentroidZMm: redoSection.properties.centroidMm[2],
    };

    const journal = await call(live.client, "plasticity_construction_journal", {});
    requireCleanJournal(journal);
    for (const intent of [
      "Cleanup disposable scale",
      "Cleanup disposable Boolean",
      "Cleanup disposable cutter",
      "Cleanup disposable holed box",
      "Cleanup disposable thin-wall Boolean",
      "Cleanup disposable thin-wall cutter",
      "Cleanup disposable thin-wall section",
      "Cleanup disposable annulus Boolean",
      "Cleanup disposable annulus cutter",
      "Cleanup disposable annulus cylinder",
      "Cleanup disposable circular cylinder",
      "Cleanup disposable rectangle",
    ]) {
      state = await call(live.client, "plasticity_undo", { intent, revision: state.revision });
    }
    requireCondition(state.documentToken === initialState.documentToken, "Cleanup switched Plasticity documents");
    requireCondition(state.bodies.length === 0, "Cleanup did not restore the empty document");
    const finalJournal = await call(live.client, "plasticity_construction_journal", {});
    requireCleanJournal(finalJournal);
    const changes = await call(live.client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
    requireCondition(!hasSceneContentChanges(changes.diff), "Scene content differs from the initial empty snapshot after cleanup");
    evidence.cleanup = {
      restoredEmptyDocument: true,
      sceneContentsRestored: true,
      journalSyncStatus: finalJournal.syncStatus,
      uncertainJournalEntries: finalJournal.entries.filter((entry: { status: string }) => entry.status === "unknown").length,
      revisionChanged: changes.diff.fromRevision !== changes.diff.toRevision,
    };

    evidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), sanitizeEvidence(evidence));
    console.log(JSON.stringify({ ok: true, output, evidence: join(output, "evidence.json") }, null, 2));
  } catch (error) {
    evidence.failure = boundedError(error);
    if (live && initialState && !evidence.cleanup) {
      evidence.cleanup = await recoverDisposableScene(live.client, initialState).catch((cleanupError) => ({
        restoredEmptyDocument: false,
        reason: boundedError(cleanupError),
      }));
    }
    await writeExclusive(join(output, "failure.json"), sanitizeEvidence(evidence)).catch(() => {});
    throw error;
  } finally {
    await live?.client.close().catch(() => {});
  }
}

async function startMcp(storeRoot: string): Promise<LiveMcp> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "run-server.ts")],
    cwd: projectRoot,
    env: {
      ...selectedEnvironment(process.env),
      PLASTICITY_STRENGTH_ROOT: storeRoot,
      PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223",
    },
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => {
    stderr.push(String(chunk).slice(-4_096));
    while (stderr.join("").length > 16_384) stderr.shift();
  });
  const client = new Client({ name: "plasticity-section-strength-live", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport, stderr };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  if ("isError" in response && response.isError) throw new Error(toolText(response));
  return JSON.parse(toolText(response));
}

function toolText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response) || !Array.isArray(response.content)) {
    throw new Error("MCP tool returned no content");
  }
  const item = response.content.find((entry): entry is { type: "text"; text: string } =>
    typeof entry === "object" && entry !== null && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"
  );
  if (!item) throw new Error("MCP tool returned no text content");
  return item.text;
}

async function findTopFace(client: Client, bodyId: number, revision: string, edgeCount: number): Promise<any> {
  const found = await call(client, "plasticity_find_faces", {
    revision,
    query: {
      bodyIds: [bodyId],
      planar: true,
      normal: { vector: [0, 0, 1], toleranceDeg: 0.01, oriented: true },
      edgeCount,
    },
  });
  requireCondition(found.count === 1, `Expected one top face on body ${bodyId}, found ${found.count}`);
  return found.matches[0];
}

async function inspectSection(client: Client, bodyId: number, faceId: string, revision: string): Promise<any> {
  return await call(client, "plasticity_inspect_planar_section", {
    bodyId,
    faceId,
    revision,
    xDirection: [1, 0, 0],
  });
}

async function inspectCurrentTop(client: Client, bodyId: number, revision: string, edgeCount: number): Promise<any> {
  const face = await findTopFace(client, bodyId, revision, edgeCount);
  const section = await inspectSection(client, bodyId, face.id, revision);
  requireVerifiedSection(section);
  return section;
}

function sectionBenchmark(
  section: any,
  options: { axialForceN?: number; transverseShearN?: number; torsionNmm?: number; thinWallTorsion?: boolean } = {},
): SectionScenarioInput {
  requireVerifiedSection(section);
  const { centroidMm: _centroidMm, source: _source, ...properties } = section.properties;
  const evidence: Evidence[] = [];
  const assignments: Record<string, string> = {};
  const add = (path: string, value: number, unit: NonNullable<Evidence["unit"]>, status: Evidence["status"], sourceLocator?: string): string => {
    const id = `live-${path.replaceAll(/[^A-Za-z0-9]+/g, "-")}`;
    evidence.push({ id, label: `SYNTHETIC acceptance ${path}`, status, unit, value, ...(sourceLocator ? { sourceLocator } : {}), dependsOn: [] });
    assignments[path] = id;
    return id;
  };
  const sectionReference = section.binding.faceId
    ? `face=${section.binding.faceId}`
    : `section=${section.binding.topologySignature}`;
  const nativeLocator = `plasticity-section:${section.binding.bodyId}/${sectionReference}@${section.binding.revision}`;
  add("properties.areaMm2", properties.areaMm2, "mm2", "measured", nativeLocator);
  add("properties.centroidLocalMm.x", properties.centroidLocalMm[0], "mm", "measured", nativeLocator);
  add("properties.centroidLocalMm.y", properties.centroidLocalMm[1], "mm", "measured", nativeLocator);
  add("properties.ixxMm4", properties.ixxMm4, "mm4", "measured", nativeLocator);
  add("properties.iyyMm4", properties.iyyMm4, "mm4", "measured", nativeLocator);
  add("properties.ixyMm4", properties.ixyMm4, "mm4", "measured", nativeLocator);

  const centroid = section.properties.centroidMm as [number, number, number];
  const pointForces = [
    { id: "axial-eccentric", forceN: [0, 0, options.axialForceN ?? 100] as [number, number, number], pointMm: [centroid[0] + 5, centroid[1], centroid[2]] as [number, number, number] },
    { id: "centroid-shear", forceN: [options.transverseShearN ?? 2, 0, 0] as [number, number, number], pointMm: [...centroid] as [number, number, number] },
  ].map((force) => {
    const evidenceIds: string[] = [];
    for (const [index, axis] of ["x", "y", "z"].entries()) {
      evidenceIds.push(add(`pointForces.${force.id}.forceN.${axis}`, force.forceN[index]!, "N", "assumed"));
      evidenceIds.push(add(`pointForces.${force.id}.pointMm.${axis}`, force.pointMm[index]!, "mm", "assumed"));
    }
    return { ...force, evidenceIds };
  });
  const freeMoments = options.torsionNmm === undefined ? [] : [{
    id: "torsion",
    momentNmm: [0, 0, options.torsionNmm] as [number, number, number],
    evidenceIds: (["x", "y", "z"] as const).map((axis, index) =>
      add(`freeMoments.torsion.momentNmm.${axis}`, index === 2 ? options.torsionNmm! : 0, "Nmm", "assumed")),
  }];
  const tensile = add("material.tensileLimitMPa", 10, "MPa", "sourced", "synthetic-software-acceptance-fixture");
  const compressive = add("material.compressiveLimitMPa", 10, "MPa", "sourced", "synthetic-software-acceptance-fixture");
  const shear = add("material.shearLimitMPa", 5, "MPa", "sourced", "synthetic-software-acceptance-fixture");
  add("safetyFactor", 2, "ratio", "assumed");
  const loadEvidence = [...pointForces, ...freeMoments].flatMap((load) => load.evidenceIds);
  return {
    kind: "planar-section",
    goal: "SYNTHETIC live planar-section benchmark; not printable material data",
    method: "planar-section-resultants-v1",
    frame: structuredClone(section.frame),
    loops: structuredClone(section.loops),
    properties: structuredClone(properties),
    pointForces,
    freeMoments,
    material: {
      id: "synthetic-live-section-material",
      name: "SYNTHETIC acceptance material; not for printing",
      evidenceIds: [tensile, compressive, shear],
      tensileLimitMPa: 10,
      compressiveLimitMPa: 10,
      shearLimitMPa: 5,
      suitability: "unconfirmed",
      manufacturing: {
        printerId: "synthetic-none",
        profileHash: "synthetic-not-printable",
        orientationDeg: [0, 0, 0],
        infillPercent: 100,
        temperatureC: 20,
        effectiveSection: "solid",
      },
    },
    safetyFactor: 2,
    evidence,
    assignments,
    assumptions: [
      { code: "static-load", confirmed: true, evidenceIds: loadEvidence },
      { code: "homogeneous-equivalent-section", confirmed: true, evidenceIds: [tensile, compressive, shear] },
      { code: "section-resultants-represent-load-path", confirmed: true, evidenceIds: loadEvidence },
      ...(options.thinWallTorsion ? [{ code: "THIN_WALLED_SINGLE_CELL_TORSION", confirmed: true, evidenceIds: [] }] : []),
    ],
    binding: structuredClone(section.binding),
  };
}

function onlyAddedBody(state: any, existingIds: number[]): any {
  const body = state.bodies.find((candidate: { id: number }) => !existingIds.includes(candidate.id));
  requireCondition(body !== undefined, "Expected one newly created body");
  requireCondition(state.bodies.filter((candidate: { id: number }) => !existingIds.includes(candidate.id)).length === 1, `Creation produced an ambiguous body set: ${JSON.stringify(state.bodies.map((candidate: { id: number; name?: string }) => ({ id: candidate.id, name: candidate.name, existing: existingIds.includes(candidate.id) })))}`);
  return body;
}

function requireVerifiedSection(section: any): void {
  requireCondition(section?.status === "verified", `Section inspection failed: ${JSON.stringify(section?.reasons ?? [])}`);
  requireCondition(section.frame && section.properties && Array.isArray(section.loops), "Verified section omitted exact geometry");
}

function requireCleanJournal(journal: any): void {
  requireCondition(journal.syncStatus === "in-sync", `Construction journal is ${String(journal.syncStatus)}`);
  requireCondition(!journal.entries.some((entry: { status: string }) => entry.status === "unknown"), "Construction journal contains an uncertain mutation");
}

function sectionPropertySummary(section: any): Record<string, unknown> {
  return {
    areaMm2: section.properties.areaMm2,
    centroidMm: section.properties.centroidMm,
    centroidLocalMm: section.properties.centroidLocalMm,
    ixxMm4: section.properties.ixxMm4,
    iyyMm4: section.properties.iyyMm4,
    ixyMm4: section.properties.ixyMm4,
    innerLoopCount: section.properties.innerLoopCount,
    boundaryKinds: section.properties.boundaryKinds,
    rectangular: section.properties.rectangular,
    topologySignature: section.properties.topologySignature,
    source: section.properties.source,
  };
}

function resultSummary(result: any): Record<string, unknown> {
  return {
    status: result.status,
    resultants: result.resultants,
    normalStressMPa: result.normalStressMPa,
    shearStressMPa: result.shearStressMPa,
    shearModel: result.shearModel,
    torsionalShearStressMPa: result.torsionalShearStressMPa,
    torsionModel: result.torsionModel,
    torsionalShearFlowNPerMm: result.torsionalShearFlowNPerMm,
    torsionalMedianAreaMm2: result.torsionalMedianAreaMm2,
    torsionalWallThicknessMm: result.torsionalWallThicknessMm,
    torsionUtilization: result.torsionUtilization,
    methodVersion: result.methodVersion,
    issueCodes: result.issues.map((issue: { code: string }) => issue.code),
    unchecked: result.unchecked,
  };
}

function near(actual: number, expected: number, tolerance: number, label: string): void {
  requireCondition(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`);
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function hasSceneContentChanges(diff: {
  documentChanged: boolean;
  added: unknown[];
  removed: unknown[];
  modified: unknown[];
  constructionPlanesAdded: unknown[];
  constructionPlanesRemoved: unknown[];
  constructionPlanesModified: unknown[];
  activeWorkplaneChanged: unknown | null;
  materialsChanged?: boolean;
  measurementsChanged?: boolean;
  instancesChanged?: boolean;
  referenceMeshesChanged?: boolean;
  groupsChanged?: boolean;
}): boolean {
  return diff.documentChanged
    || diff.added.length > 0
    || diff.removed.length > 0
    || diff.modified.length > 0
    || diff.constructionPlanesAdded.length > 0
    || diff.constructionPlanesRemoved.length > 0
    || diff.constructionPlanesModified.length > 0
    || diff.activeWorkplaneChanged !== null
    || diff.materialsChanged === true
    || diff.measurementsChanged === true
    || diff.instancesChanged === true
    || diff.referenceMeshesChanged === true
    || diff.groupsChanged === true;
}

export function sanitizeEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeEvidence(item));
  if (typeof value !== "object" || value === null) return value;
  const forbidden = new Set(["password", "secret", "credential", "accessCode", "prompt", "fullPrompt", "nativeDump", "nativeObject", "rawNative"]);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !forbidden.has(key))
    .map(([key, entry]) => [key, sanitizeEvidence(entry)]));
}

function stateSummary(state: any): Record<string, unknown> {
  return {
    revision: state.revision,
    bodyCount: state.bodies.length,
    undoDepth: state.undoDepth,
    redoDepth: state.redoDepth,
  };
}

async function recoverDisposableScene(client: Client, initialState: any): Promise<Record<string, unknown>> {
  let state = await call(client, "plasticity_status", {});
  if (state.documentToken !== initialState.documentToken) return { restoredEmptyDocument: false, reason: "document-changed" };
  const journal = await call(client, "plasticity_construction_journal", {});
  if (journal.syncStatus === "manual-edit-detected" || journal.entries.some((entry: { status: string }) => entry.status === "unknown")) {
    return { restoredEmptyDocument: false, reason: "manual-or-uncertain-edit-detected" };
  }
  let undoCount = 0;
  while (state.bodies.length > 0 && state.undoDepth > initialState.undoDepth && undoCount < 64) {
    state = await call(client, "plasticity_undo", { intent: "Section acceptance failure cleanup", revision: state.revision });
    undoCount += 1;
  }
  return {
    restoredEmptyDocument: state.documentToken === initialState.documentToken && state.bodies.length === 0,
    bodyCount: state.bodies.length,
    undoCount,
  };
}

async function writeExclusive(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

function selectedEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["CODEX_HOME", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE", "LANG", "LC_ALL"]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, " ").slice(0, 1_000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(boundedError(error));
    process.exitCode = 1;
  });
}
