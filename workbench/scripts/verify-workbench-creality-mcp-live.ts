#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { DfmReport, ManufacturingProfile, PrinterProfile, PrinterSubmissionObservation, PrinterStatus, Project } from "../src/shared/contracts.ts";
import { ArtifactStore } from "../src/server/artifact-store.ts";
import { openDatabase } from "../src/server/database.ts";
import { createWorkbenchServer } from "../src/server/http-server.ts";
import { ManufacturingJobStore } from "../src/server/manufacturing/store.ts";
import { ManufacturingService } from "../src/server/manufacturing/service.ts";
import { discoverManufacturingProfiles } from "../src/server/manufacturing/profile-registry.ts";
import { ManufacturingProfileStore } from "../src/server/manufacturing/profile-store.ts";
import { CrealityPrintSlicer, OrcaFamilySlicer } from "../src/server/manufacturing/slicer.ts";
import { SqliteProjectStore } from "../src/server/project-store.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface WorkbenchCrealityMcpLiveOptions {
  help: boolean;
  input?: string;
  plasticityTarget?: string;
  splitNative?: boolean;
  splitJoint?: "flat" | "alignment-pins" | "tongue-and-groove" | "dovetail" | "screws-and-inserts";
  output?: string;
  batchParts: number;
  executable?: string;
  resourcesRoot?: string;
  slicer?: "creality-print" | "orca-slicer" | "bambu-studio";
  printerVendor?: string;
  printerModel?: string;
  material?: string;
}

export function parseWorkbenchCrealityMcpLiveArgs(argv: string[], environment: NodeJS.ProcessEnv = process.env): WorkbenchCrealityMcpLiveOptions {
  const options: WorkbenchCrealityMcpLiveOptions = {
    help: argv.length === 0,
    batchParts: 1,
    ...(environment.CREALITY_PRINT_EXECUTABLE ? { executable: environment.CREALITY_PRINT_EXECUTABLE } : {}),
    ...(environment.CREALITY_PRINT_RESOURCES_ROOT ? { resourcesRoot: environment.CREALITY_PRINT_RESOURCES_ROOT } : {}),
    slicer: "creality-print",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--split-native") options.splitNative = true;
    else if (argument === "--split-joint") {
      const value = argv[++index];
      if (value !== "flat" && value !== "alignment-pins" && value !== "tongue-and-groove" && value !== "dovetail" && value !== "screws-and-inserts") throw new Error("--split-joint must be flat, alignment-pins, tongue-and-groove, dovetail, or screws-and-inserts");
      options.splitJoint = value;
    }
    else if (argument === "--slicer") {
      const value = argv[++index];
      if (value !== "creality-print" && value !== "orca-slicer" && value !== "bambu-studio") throw new Error("--slicer must be creality-print, orca-slicer, or bambu-studio");
      options.slicer = value;
    } else if (argument === "--batch-parts") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 2 || value > 32) throw new Error("--batch-parts must be an integer from 2 to 32");
      options.batchParts = value;
    } else if (argument === "--plasticity-target" || argument === "--printer-vendor" || argument === "--printer-model" || argument === "--material" || argument === "--input" || argument === "--output" || argument === "--executable" || argument === "--resources-root") {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === "--input") options.input = value;
      else if (argument === "--plasticity-target") options.plasticityTarget = value;
      else if (argument === "--output") options.output = value;
      else if (argument === "--executable") options.executable = value;
      else if (argument === "--resources-root") options.resourcesRoot = value;
      else if (argument === "--printer-vendor") options.printerVendor = value;
      else if (argument === "--printer-model") options.printerModel = value;
      else options.material = value;
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (options.splitNative && !options.plasticityTarget) throw new Error("--split-native requires --plasticity-target");
  if (options.splitNative && !options.splitJoint) throw new Error("--split-native requires an explicit --split-joint choice");
  if (options.splitJoint && !options.splitNative) throw new Error("--split-joint requires --split-native");
  if ((!options.input && !options.plasticityTarget) || (options.input && options.plasticityTarget) || !options.output || !options.executable || !options.resourcesRoot) {
    throw new Error("Provide exactly one of --input or --plasticity-target, plus --output, --executable, and --resources-root (or the matching CREALITY_PRINT_* environment variables)");
  }
  return options;
}

export function selectLayerIndicesForOrientationAcceptance(layerCount: number): number[] {
  if (!Number.isSafeInteger(layerCount) || layerCount < 1) throw new Error("Layer count must be a positive safe integer");
  if (layerCount <= 33) return Array.from({ length: layerCount }, (_, index) => index + 1);
  return [...new Set([1, Math.floor(layerCount / 2), layerCount])].sort((left, right) => left - right);
}

const HELP = `Usage:
  node workbench/scripts/verify-workbench-creality-mcp-live.ts --help
  node workbench/scripts/verify-workbench-creality-mcp-live.ts --input PLASTICITY_EXPORT.stl|3mf --output NEW_DIRECTORY --executable /path/to/Slicer --resources-root /path/to/Slicer.app/Contents/Resources [--batch-parts 2..32] [--slicer creality-print|orca-slicer|bambu-studio] [--printer-vendor VENDOR] [--printer-model MODEL] [--material EXACT_NAME]
  node workbench/scripts/verify-workbench-creality-mcp-live.ts --plasticity-target EXPLICIT_WINDOW_ID --output NEW_DIRECTORY --executable /path/to/CrealityPrint --resources-root /path/to/CrealityPrint.app/Contents/Resources [--split-native --split-joint flat|alignment-pins|tongue-and-groove|dovetail|screws-and-inserts]

Starts an isolated Workbench HTTP service and the real stdio Workbench MCP
client. In Plasticity mode it creates a disposable Solid, asks Workbench for
the selected printer's orientation, applies that exact recommendation, exports
STL, re-assesses fit, and slices the result. With --split-native it creates an
oversized Solid, applies the recommendation, splits it to the selected build
volume, optionally builds the explicitly selected joint, exports every native
part separately, and batch-slices those distinct artifacts. The
screws-and-inserts case uses a small synthetic seam fixture because an actual
long-axis split may not leave enough depth for a standard screw; its pocket
dimensions do not qualify a production insert/process fit. Input mode accepts
an existing Plasticity STL or 3MF. Both paths verify the G-code preview and
approval gate. No printer is contacted.`;

async function main(): Promise<void> {
  const options = parseWorkbenchCrealityMcpLiveArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  let inputPath = options.input ? resolve(options.input) : undefined;
  const output = resolve(options.output!);
  const executable = resolve(options.executable!);
  const resourcesRoot = resolve(options.resourcesRoot!);
  const slicerId = options.slicer ?? "creality-print";
  const printerVendor = options.printerVendor ?? (slicerId === "creality-print" ? "Creality" : undefined);
  const printerModel = options.printerModel ?? (slicerId === "creality-print" ? "k1c" : undefined);
  if (slicerId !== "creality-print" && (!printerVendor || !printerModel)) {
    throw new Error(`--printer-vendor and --printer-model are required when --slicer is ${slicerId}`);
  }
  if (inputPath) validateWorkbenchInputPath(inputPath, slicerId);
  let modelBytes = inputPath ? await readFile(inputPath) : undefined;
  if (modelBytes?.byteLength === 0) throw new Error("Input model is empty");
  await mkdir(output, { recursive: false, mode: 0o700 });
  const dataRoot = join(output, "workbench-data");
  const projectsRoot = join(dataRoot, "projects");
  await mkdir(projectsRoot, { recursive: true, mode: 0o700 });

  const database = openDatabase(join(dataRoot, "workbench.sqlite"));
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let plasticityClient: Client | undefined;
  let plasticityTransport: StdioClientTransport | undefined;
  let http: ReturnType<typeof createWorkbenchServer> | undefined;
  const printerCalls = { uploadAndStart: 0, reconcileSubmission: 0 };
  let nativeOrientationEvidence: Record<string, unknown> | undefined;
  let protectedZoneAssessment: DfmReport | undefined;
  let nativeParts: Array<{ path: string; bytes: Buffer<ArrayBufferLike>; sizeMm: [number, number, number]; bodyId: number; boundsMm: any }> | undefined;
  let nativeJointResults: any[] = [];
  let nativeInitialState: any;
  let nativeLastRevision: string | undefined;
  try {
    const projects = new SqliteProjectStore(database);
    const artifacts = new ArtifactStore(join(dataRoot, ".artifacts"), database);
    const catalog = await discoverManufacturingProfiles({
      ...(slicerId === "creality-print" ? { crealityProfilesRoot: join(resourcesRoot, "profiles", "Creality"), crealityExecutable: executable } : {}),
      ...(slicerId === "orca-slicer" ? { orcaSlicerResourcesRoot: resourcesRoot, orcaSlicerExecutable: executable } : {}),
      ...(slicerId === "bambu-studio" ? { bambuStudioResourcesRoot: resourcesRoot, bambuStudioExecutable: executable } : {}),
      resolvedProfilesRoot: join(dataRoot, ".resolved-manufacturing-profiles"),
    });
    const adapter = catalog.adapters.find((candidate) => candidate.id === slicerId);
    assert.equal(adapter?.available, true, `selected ${slicerId} app must be available`);
    const profileMatches = (candidate: ManufacturingProfile) => candidate.slicer.slicer === slicerId
      && (!printerVendor || candidate.printer.vendor.toLowerCase().includes(printerVendor.toLowerCase()))
      && (!printerModel || candidate.printer.model.toLowerCase().includes(printerModel.toLowerCase()));
    const matchingProfiles = catalog.profiles.filter(profileMatches);
    const profile = options.material
      ? matchingProfiles.find((candidate) => candidate.material.name.toLowerCase() === options.material!.toLowerCase())
      : matchingProfiles.find((candidate) => candidate.material.name.toLowerCase() === "generic pla") ?? matchingProfiles[0];
    assert.ok(profile, `installed ${[printerVendor, printerModel, options.material].filter(Boolean).join(" ") || "printer profile"} must be discovered for ${slicerId}`);
    const slicer = slicerId === "creality-print"
      ? new CrealityPrintSlicer(executable)
      : new OrcaFamilySlicer(slicerId, executable);
    const manufacturing = new ManufacturingService(
      new ManufacturingJobStore(database),
      projects,
      artifacts,
      catalog,
      new ManufacturingProfileStore(database, join(dataRoot, ".manufacturing-profiles")),
      new Map([[slicerId, slicer]]),
      new Map([["moonraker", noSubmitPrinter(printerCalls)]]),
    );
    http = createWorkbenchServer({
      projects,
      artifacts,
      manufacturing,
      config: { host: "127.0.0.1", port: 0, projectsRoot, maxJsonBytes: 1024 * 1024 },
    });
    const address = await http.listen();

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(repoRoot, "workbench", "scripts", "run-mcp.ts")],
      cwd: repoRoot,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        WORKBENCH_ORIGIN: address.origin,
      },
      stderr: "pipe",
    });
    const stderr: string[] = [];
    transport.stderr?.on("data", (chunk) => stderr.push(String(chunk).slice(-4096)));
    client = new Client({ name: "plasticity-workbench-creality-live-acceptance", version: "1.0.0" });
    await client.connect(transport);
    const listed = await client.listTools();
    for (const name of ["workbench_create_project", "workbench_upload_project_artifact", "workbench_manufacturing_profiles", "workbench_register_manufacturing_profile", "workbench_slicer_interface_heights", "workbench_slicer_layer_path_orientations", "workbench_assess_printability", "workbench_slice_model", "workbench_slice_parts", "workbench_print_jobs", "workbench_submit_approved_print"]) {
      assert.ok(listed.tools.some((tool) => tool.name === name), `MCP tool ${name} must be listed`);
    }

    const project = await callTool<Project>(client, "workbench_create_project", { name: `Plasticity ${profile.printer.model} CLI acceptance` });
    await mkdir(project.workspacePath, { recursive: true });
    const profileCatalog = await callTool<{ profiles: ManufacturingProfile[] }>(client, "workbench_manufacturing_profiles", {
      projectId: project.id,
      slicer: slicerId,
      printerVendor,
      ...(printerModel ? { printerModel } : {}),
      material: profile.material.name,
    });
    const mcpProfile = profileCatalog.profiles.find((candidate) => candidate.printer.id === profile.printer.id
      && candidate.material.id === profile.material.id && candidate.slicer.id === profile.slicer.id);
    assert.ok(mcpProfile, `MCP must expose the discovered ${profile.printer.model} profile`);
    assert.equal(mcpProfile.printer.id, profile.printer.id);
    assert.equal(mcpProfile.material.id, profile.material.id);
    assert.equal(mcpProfile.slicer.id, profile.slicer.id);
    assert.equal(mcpProfile.slicer.nominalInfillPercent, profile.slicer.nominalInfillPercent);
    assert.equal(mcpProfile.slicer.sparseInfillPattern, profile.slicer.sparseInfillPattern);
    assert.equal(mcpProfile.slicer.wallLoops, profile.slicer.wallLoops);
    assert.equal(mcpProfile.slicer.topShellLayers, profile.slicer.topShellLayers);
    assert.equal(mcpProfile.slicer.bottomShellLayers, profile.slicer.bottomShellLayers);
    assert.equal(mcpProfile.slicer.layerHeightMm, profile.slicer.layerHeightMm);
    const registeredProfile = await callTool<{ profileHash: string }>(client, "workbench_register_manufacturing_profile", {
      projectId: project.id,
      registration: {
        discoveredProfile: { printerId: mcpProfile.printer.id, materialId: mcpProfile.material.id, slicerId: mcpProfile.slicer.id },
        verification: "draft",
        notes: "Ephemeral live acceptance profile copied from the installed slicer catalog",
      },
    });
    assert.match(registeredProfile.profileHash, /^[a-f0-9]{64}$/);
    if (options.splitJoint === "screws-and-inserts") {
      protectedZoneAssessment = await callTool<DfmReport>(client, "workbench_assess_printability", {
        projectId: project.id,
        dfm: {
          sizeMm: [500, 100, 20],
          split: {
            bedMarginMm: 5,
            joint: "screws-and-inserts",
            protectedZones: [{
              id: "acceptance-marked-zone",
              sourceId: "acceptance-fixture:critical-region",
              basis: "user-marked",
              axis: "x",
              minMm: 160,
              maxMm: 175,
            }],
            cutOffsetsMm: [{ axis: "x", offsetsMm: [140, 330] }],
          },
        },
        profileHash: registeredProfile.profileHash,
      });
      assert.equal(protectedZoneAssessment.splitPlan?.cutOffsetsSource, "explicit");
      assert.deepEqual(protectedZoneAssessment.splitPlan?.cutOffsetsMm, [{ axis: "x", offsetsMm: [140, 330] }]);
      assert.deepEqual(protectedZoneAssessment.splitPlan?.cutConflicts, []);
      assert.deepEqual(protectedZoneAssessment.splitPlan?.maximumSegmentSizeMm, [190, 100, 20]);
    }

    let dfmSizeMm: [number, number, number] = [20, 10, 5];
    let printability: DfmReport;
    if (options.plasticityTarget) {
      const nativeMcpStderr: string[] = [];
      plasticityTransport = new StdioClientTransport({
        command: process.execPath,
        args: [join(repoRoot, "scripts", "run-server.ts")],
        cwd: repoRoot,
        env: {
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
          ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
          ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
          PLASTICITY_STRENGTH_ROOT: join(dataRoot, "plasticity-strength"),
          PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223",
        },
        stderr: "pipe",
      });
      plasticityTransport.stderr?.on("data", (chunk) => nativeMcpStderr.push(String(chunk).slice(-4096)));
      plasticityClient = new Client({ name: "plasticity-workbench-orientation-live-acceptance", version: "1.0.0" });
      await plasticityClient.connect(plasticityTransport);
      const nativeTools = await plasticityClient.listTools();
      for (const name of ["plasticity_list_windows", "plasticity_connect", "plasticity_create_box", "plasticity_orient_bodies_for_print", "plasticity_split_solid_to_build_volume", "plasticity_split_solid_by_plane", "plasticity_create_locating_pin_pair_pattern", "plasticity_create_tongue_groove_joint", "plasticity_create_dovetail_joint", "plasticity_create_split_screw_insert_joint", "plasticity_check_interference", "plasticity_validate_bodies", "plasticity_export_stl", "plasticity_status", "plasticity_undo"]) {
        assert.ok(nativeTools.tools.some((tool) => tool.name === name), `Plasticity MCP tool ${name} must be listed`);
      }
      const windows = await callTool<Array<{ targetId: string }>>(plasticityClient, "plasticity_list_windows", {});
      assert.ok(windows.some((window) => window.targetId === options.plasticityTarget), "Explicit Plasticity target must be available");
      const nativeInitial = await callTool<any>(plasticityClient, "plasticity_connect", { targetId: options.plasticityTarget });
      nativeInitialState = nativeInitial;
      nativeLastRevision = nativeInitial.revision;
      assert.ok(nativeInitial.bodies.length === 0 && nativeInitial.regions.length === 0, "Plasticity target must be empty before disposable modeling");
      const screwInsertFixture = options.splitJoint === "screws-and-inserts";
      const nativeSourceSize: [number, number, number] = options.splitNative ? (screwInsertFixture ? [30, 30, 20] : [500, 120, 20]) : [221, 40, 5];
      const nativeCreated = await callTool<any>(plasticityClient, "plasticity_create_box", {
        originMm: [0, 0, 0], sizeMm: nativeSourceSize, name: options.splitNative ? "Workbench split E2E acceptance" : "Workbench orientation E2E acceptance",
        intent: "Create a disposable model for the live Plasticity-to-Workbench print preparation route", revision: nativeInitial.revision,
      });
      nativeLastRevision = nativeCreated.revision;
      assert.equal(nativeCreated.bodies.length, 1);
      const nativeBody = nativeCreated.bodies[0]!;
      const sourceSizeMm = sizeOfBounds(nativeBody.boundsMm);
      assert.ok(sameVector(sourceSizeMm, nativeSourceSize, 0.01), `Native source B-Rep size is ${sourceSizeMm.join(" × ")} mm`);
      const sourcePrintability = await callTool<DfmReport>(client, "workbench_assess_printability", {
        projectId: project.id, dfm: { sizeMm: sourceSizeMm, ...(options.splitNative ? { split: { bedMarginMm: 5, joint: options.splitJoint!, ...(options.splitJoint !== "flat" ? { clearanceMm: 0.2 } : {}) } } : {}) }, profileHash: registeredProfile.profileHash,
      });
      assert.equal(sourcePrintability.needsSplit, Boolean(options.splitNative && !screwInsertFixture), options.splitNative && !screwInsertFixture ? `The oversized native model ${JSON.stringify({ sourceSizeMm, orientation: sourcePrintability.orientation, buildVolumeMm: mcpProfile.printer.buildVolumeMm })} should require splitting` : "The native acceptance model should fit before the explicit seam fixture split");
      if (!options.splitNative) assert.ok(sourcePrintability.orientation.rotationDeg.some((angle) => Math.abs(angle) > 0), "Workbench should recommend a nontrivial bed orientation for the native bounds");
      if (!options.splitNative) assert.ok(sourcePrintability.orientation.sizeMm.every((value, axis) => value <= mcpProfile.printer.buildVolumeMm[axis]!));
      const nativeOriented = screwInsertFixture
        ? {
          status: "unchanged",
          revision: nativeCreated.revision,
          measuredBoundsMm: nativeBody.boundsMm,
          measuredSizeMm: sourceSizeMm,
          rotationDeg: [0, 0, 0],
        }
        : sourcePrintability.orientation.rotationDeg.every((angle) => Math.abs(angle) < 1e-9)
        ? {
          status: "unchanged",
          revision: nativeCreated.revision,
          measuredBoundsMm: nativeBody.boundsMm,
          measuredSizeMm: sourceSizeMm,
          rotationDeg: sourcePrintability.orientation.rotationDeg,
        }
        : await callTool<any>(plasticityClient, "plasticity_orient_bodies_for_print", {
          bodyIds: [nativeBody.id],
          rotationDeg: sourcePrintability.orientation.rotationDeg,
          expectedSizeMm: sourcePrintability.orientation.sizeMm,
          intent: "Apply the exact orientation returned by Workbench DFM to this native Solid", revision: nativeCreated.revision,
        });
      nativeLastRevision = nativeOriented.revision;
      assert.ok(nativeOriented.status === "verified" || nativeOriented.status === "unchanged", "Workbench's exact orientation must be applied or confirmed as already aligned");
      assert.ok(sameVector(nativeOriented.measuredSizeMm, screwInsertFixture ? sourceSizeMm : sourcePrintability.orientation.sizeMm, 0.01));
      dfmSizeMm = nativeOriented.measuredSizeMm;
      printability = await callTool<DfmReport>(client, "workbench_assess_printability", {
        projectId: project.id, dfm: { sizeMm: dfmSizeMm, ...(options.splitNative ? { split: { bedMarginMm: 5, joint: options.splitJoint!, ...(options.splitJoint !== "flat" ? { clearanceMm: 0.2 } : {}) } } : {}) }, profileHash: registeredProfile.profileHash,
      });
      assert.equal(printability.needsSplit, Boolean(options.splitNative && !screwInsertFixture), "Re-assessed native bounds should agree with the Workbench split recommendation");
      if (options.splitNative) {
        let nativeSplit: any;
        if (screwInsertFixture) {
          const splitOriginMm: [number, number, number] = [
            (nativeOriented.measuredBoundsMm.min[0] + nativeOriented.measuredBoundsMm.max[0]) / 2,
            (nativeOriented.measuredBoundsMm.min[1] + nativeOriented.measuredBoundsMm.max[1]) / 2,
            (nativeOriented.measuredBoundsMm.min[2] + nativeOriented.measuredBoundsMm.max[2]) / 2,
          ];
          const split = await callTool<any>(plasticityClient, "plasticity_split_solid_by_plane", {
            targetId: nativeBody.id,
            originMm: splitOriginMm,
            normal: [1, 0, 0],
            xDirection: [0, 1, 0],
            intent: "Create one synthetic seam fixture for testing the native screw/insert recipe and Workbench print pipeline",
            revision: nativeOriented.revision,
          });
          const splitState = await callTool<any>(plasticityClient, "plasticity_status", {});
          nativeSplit = {
            ...split,
            partBoundsMm: split.resultBodyIds.map((id: number) => {
              const body = splitState.bodies.find((candidate: any) => candidate.id === id);
              assert.ok(body?.boundsMm, `Split result ${id} must expose exact native bounds`);
              return { id, boundsMm: body.boundsMm };
            }),
          };
        } else {
          assert.ok(printability.splitPlan, "Workbench must provide a split plan for the oversized native Solid");
          nativeSplit = await callTool<any>(plasticityClient, "plasticity_split_solid_to_build_volume", {
            targetId: nativeBody.id,
            usableBuildVolumeMm: printability.splitPlan.usableBuildVolumeMm,
            intent: "Split the oriented disposable test Solid to the exact usable volume recommended by Workbench DFM",
            revision: nativeOriented.revision,
          });
        }
        nativeLastRevision = nativeSplit.afterRevision;
        assert.ok(nativeSplit.resultBodyIds.length > 1, "native split must produce multiple Solid parts");
        nativeParts = [];
        for (const part of nativeSplit.partBoundsMm as Array<{ id: number; boundsMm: any }>) {
          const sizeMm = sizeOfBounds(part.boundsMm);
          if (printability.splitPlan) assert.ok(sizeMm.every((value, axis) => value <= printability.splitPlan!.usableBuildVolumeMm[axis]! + 0.01), "exact native split part must fit usable build volume");
        }
        const splitInterfaces = findSplitInterfaces(nativeSplit.partBoundsMm);
        assert.equal(splitInterfaces.length, nativeSplit.resultBodyIds.length - 1, "even grid split must expose every adjacent interface");
        if (options.splitJoint === "tongue-and-groove") {
          for (const joint of splitInterfaces) {
            const tongueGroove = await callTool<any>(plasticityClient, "plasticity_create_tongue_groove_joint", {
              tongueTargetId: joint.lowerBodyId,
              grooveTargetId: joint.upperBodyId,
              baseCenterMm: joint.baseCenterMm,
              axis: joint.axis,
              widthDirection: joint.widthDirection,
              tongueWidthMm: joint.tongueWidthMm,
              tongueThicknessMm: joint.tongueThicknessMm,
              tongueHeightMm: 10,
              radialClearanceMm: 0.2,
              axialClearanceMm: 0.2,
              baseOverlapMm: 0.5,
              cutterOvershootMm: 0.5,
              intent: "Add the explicitly selected acceptance-test tongue-and-groove joint to this native split seam; dimensions and 0.2 mm clearances are test-fixture inputs, not production recommendations",
              revision: nativeLastRevision,
            });
            nativeLastRevision = tongueGroove.afterRevision;
            nativeJointResults.push({ interface: joint, result: tongueGroove });
          }
        } else if (options.splitJoint === "alignment-pins") {
          for (const joint of splitInterfaces) {
            const centers = joint.baseCenterMm.slice() as [number, number, number];
            const offset = joint.tongueWidthMm / 4;
            const firstCenter = [...centers] as [number, number, number];
            const secondCenter = [...centers] as [number, number, number];
            const widthAxis = joint.widthDirection.findIndex((value) => value !== 0);
            if (widthAxis < 0) throw new Error("Split interface has no in-plane width direction for locating pins");
            firstCenter[widthAxis] = firstCenter[widthAxis]! - offset;
            secondCenter[widthAxis] = secondCenter[widthAxis]! + offset;
            const pins = await callTool<any>(plasticityClient, "plasticity_create_locating_pin_pair_pattern", {
              maleTargetId: joint.lowerBodyId,
              femaleTargetId: joint.upperBodyId,
              baseCentersMm: [firstCenter, secondCenter],
              axis: joint.axis,
              pinDiameterMm: 4,
              pinHeightMm: Math.min(10, joint.tongueThicknessMm - 2),
              radialClearanceMm: 0.2,
              axialClearanceMm: 0.2,
              baseOverlapMm: 0.5,
              cutterOvershootMm: 0.5,
              intent: "Add two explicitly selected acceptance-test alignment pins to this native split seam; dimensions and 0.2 mm clearances are test-fixture inputs, not production recommendations",
              revision: nativeLastRevision,
            });
            nativeLastRevision = pins.afterRevision;
            nativeJointResults.push({ interface: joint, result: pins });
          }
        } else if (options.splitJoint === "dovetail") {
          for (const joint of splitInterfaces) {
            const dovetail = await callTool<any>(plasticityClient, "plasticity_create_dovetail_joint", {
              maleTargetId: joint.lowerBodyId,
              femaleTargetId: joint.upperBodyId,
              baseCenterMm: joint.baseCenterMm,
              axis: joint.axis,
              widthDirection: joint.widthDirection,
              rootWidthMm: 30,
              flareMm: 5,
              tongueThicknessMm: joint.tongueThicknessMm,
              tongueHeightMm: 10,
              radialClearanceMm: 0.2,
              axialClearanceMm: 0.2,
              baseOverlapMm: 0.5,
              cutterOvershootMm: 0.5,
              intent: "Add the explicitly selected acceptance-test dovetail joint to this native split seam; dimensions and 0.2 mm clearances are test-fixture inputs, not production recommendations",
              revision: nativeLastRevision,
            });
            nativeLastRevision = dovetail.afterRevision;
            nativeJointResults.push({ interface: joint, result: dovetail });
          }
        } else if (options.splitJoint === "screws-and-inserts") {
          for (const joint of splitInterfaces) {
            const male = nativeSplit.partBoundsMm.find((part: any) => part.id === joint.lowerBodyId)!;
            const female = nativeSplit.partBoundsMm.find((part: any) => part.id === joint.upperBodyId)!;
            const maleThroughDepthMm = male.boundsMm.max[joint.seamAxis]! - male.boundsMm.min[joint.seamAxis]!;
            const screwLengthMm = maleThroughDepthMm + 5;
            const screwEntryCenterMm = joint.baseCenterMm.slice() as [number, number, number];
            screwEntryCenterMm[joint.seamAxis] = male.boundsMm.min[joint.seamAxis]!;
            const femaleMaterialDepthMm = female.boundsMm.max[joint.seamAxis]! - joint.baseCenterMm[joint.seamAxis]!;
            assert.ok(Math.abs(screwLengthMm - Math.round(screwLengthMm)) <= 1e-6, "Synthetic acceptance fixture must produce a whole-millimeter ISO screw length");
            const screwInsert: any = await callTool<any>(plasticityClient, "plasticity_create_split_screw_insert_joint", {
              maleTargetId: joint.lowerBodyId,
              femaleTargetId: joint.upperBodyId,
              screwEntryCentersMm: [screwEntryCenterMm],
              insertEntryCentersMm: [joint.baseCenterMm],
              axis: joint.axis,
              fastenerDesignation: `ISO 4762 M5x${Math.round(screwLengthMm)}`,
              screwLengthMm,
              minimumEngagementMm: 3,
              maximumEngagementMm: 5,
              insertPartNumber: "synthetic-acceptance-fixture-M5-P0.8",
              insertThreadNominalDiameterMm: 5,
              insertThreadPitchMm: 0.8,
              insertSourceUrl: "https://www.ruthex.de/products/ruthex-gewindeeinsatz-m5-50-stuck-rx-m5x9-5-messing-gewindebuchsen",
              holeDiameterMm: 5.3,
              maleThroughDepthMm,
              holeOvershootMm: 0.5,
              pilotDiameterMm: 6.2,
              pilotDepthMm: 11,
              insertDiameterMm: 7,
              insertDepthMm: 9.5,
              leadInDiameterMm: 7.4,
              leadInDepthMm: 1,
              femaleMaterialDepthMm: Math.max(12, femaleMaterialDepthMm),
              insertOvershootMm: 0.5,
              intent: "Use explicitly synthetic insert dimensions to test the native joint and Workbench batch-slicing route; do not infer production fit or strength",
              revision: nativeLastRevision,
            });
            nativeLastRevision = screwInsert.afterRevision;
            assert.equal(screwInsert.screwEngagementMm, 5);
            nativeJointResults.push({ interface: joint, result: screwInsert });
          }
        }
        const nativeAfterJoints = await callTool<any>(plasticityClient, "plasticity_status", {});
        assert.equal(nativeAfterJoints.revision, nativeLastRevision, "Plasticity changed while checking native split joints");
        const finalSolidBodies = nativeAfterJoints.bodies.filter((body: any) => body.type === "Solid");
        assert.deepEqual(finalSolidBodies.map((body: any) => body.id).sort((a: number, b: number) => a - b), nativeSplit.resultBodyIds.slice().sort((a: number, b: number) => a - b), "joint recipes must preserve each split Solid identity");
        const expectedSceneBodyIds = [...nativeSplit.resultBodyIds, ...nativeJointResults.flatMap((item) => item.result.profileBodyIds ?? [])].sort((a, b) => a - b);
        assert.deepEqual(nativeAfterJoints.bodies.map((body: any) => body.id).sort((a: number, b: number) => a - b), expectedSceneBodyIds, "only split Solids and editable joint profile Wires may remain");
        const updatedParts = finalSolidBodies.map((body: any) => ({ id: body.id, boundsMm: body.boundsMm }));
        const nativeInterference = options.splitJoint === "alignment-pins" || options.splitJoint === "tongue-and-groove" || options.splitJoint === "dovetail" || options.splitJoint === "screws-and-inserts"
          ? await callTool<any>(plasticityClient, "plasticity_check_interference", {
            pairs: splitInterfaces.map((joint) => ({ firstBodyId: joint.lowerBodyId, secondBodyId: joint.upperBodyId })),
            revision: nativeAfterJoints.revision,
          })
          : undefined;
        if (nativeInterference) assert.ok(nativeInterference.pairs.every((pair: any) => pair.status === "no-volumetric-interference"), JSON.stringify(nativeInterference.pairs));
        const nativeValidation = await callTool<any>(plasticityClient, "plasticity_validate_bodies", {
          ids: nativeSplit.resultBodyIds,
          revision: nativeAfterJoints.revision,
        });
        assert.ok(nativeValidation.bodies.every((body: any) => body.type === "Solid" && body.nativeValid && body.closed && body.printableSolid && body.nativeCheckCodes.length === 0), JSON.stringify(nativeValidation.bodies));
        nativeParts = [];
        for (const part of updatedParts) {
          const sizeMm = sizeOfBounds(part.boundsMm);
          const allowedBuildVolumeMm = printability.splitPlan?.usableBuildVolumeMm ?? mcpProfile.printer.buildVolumeMm;
          assert.ok(sizeMm.every((value, axis) => value <= allowedBuildVolumeMm[axis]! + 0.01), `jointed Solid ${part.id} must still fit usable volume`);
          const partPrintability: DfmReport = await callTool<DfmReport>(client, "workbench_assess_printability", {
            projectId: project.id,
            dfm: { sizeMm, split: { bedMarginMm: 5, joint: options.splitJoint!, ...(options.splitJoint !== "flat" ? { clearanceMm: 0.2 } : {}) } },
            profileHash: registeredProfile.profileHash,
          });
          assert.equal(partPrintability.printable, true, `jointed part ${part.id} must pass DFM`);
          const partPath = join(output, `plasticity-part-${part.id}.stl`);
          await callTool(plasticityClient, "plasticity_export_stl", {
            ids: [part.id], path: partPath, chordToleranceMm: 0.05, angleToleranceDegrees: 15, revision: nativeAfterJoints.revision,
          });
          const partBytes = await readFile(partPath);
          assert.ok(partBytes.byteLength > 0);
          assertBoundsMatch(binaryStlBounds(partBytes), part.boundsMm, 0.01, `jointed part ${part.id} STL versus native B-Rep`);
          nativeParts.push({ path: partPath, bytes: partBytes, sizeMm, bodyId: part.id, boundsMm: part.boundsMm });
        }
        assert.equal(nativeParts.length, nativeSplit.resultBodyIds.length);
        inputPath = nativeParts[0]!.path;
        modelBytes = Buffer.from(nativeParts[0]!.bytes);
        nativeOrientationEvidence = {
          targetId: options.plasticityTarget,
          sourceBoundsMm: nativeBody.boundsMm,
          sourceSizeMm,
          sourcePrintability,
          appliedOrientation: nativeOriented,
          reassessedPrintability: printability,
          nativeSplit,
          nativeJointResults,
          nativeInterference,
          nativeValidation,
          exportedParts: nativeParts.map((part) => ({ bodyId: part.bodyId, path: part.path, sizeMm: part.sizeMm, boundsMm: part.boundsMm, bytes: part.bytes.byteLength, sha256: createHash("sha256").update(part.bytes).digest("hex") })),
        };
      } else {
        assert.equal(printability.printable, true, "Re-assessed oriented native geometry must fit the selected profile");
        inputPath = join(output, "plasticity-oriented.stl");
        await callTool(plasticityClient, "plasticity_export_stl", {
          ids: [nativeBody.id], path: inputPath, chordToleranceMm: 0.05, angleToleranceDegrees: 15, revision: nativeOriented.revision,
        });
        modelBytes = await readFile(inputPath);
        assert.ok(modelBytes.byteLength > 0);
        const exportedStlBoundsMm = binaryStlBounds(modelBytes);
        assertBoundsMatch(exportedStlBoundsMm, nativeOriented.measuredBoundsMm, 0.01, "Plasticity STL versus native B-Rep");
        nativeOrientationEvidence = {
          targetId: options.plasticityTarget,
          sourceBoundsMm: nativeBody.boundsMm,
          sourceSizeMm,
          sourcePrintability,
          appliedOrientation: nativeOriented,
          reassessedPrintability: printability,
          exportedStl: { path: inputPath, bytes: modelBytes.byteLength, boundsMm: exportedStlBoundsMm },
        };
      }
      let cleanup = await callTool<any>(plasticityClient, "plasticity_status", {});
      assert.equal(cleanup.documentToken, nativeInitial.documentToken, "Plasticity document changed during orientation acceptance");
      assert.equal(cleanup.revision, nativeLastRevision, "Plasticity changed after native export; refusing to undo user edits");
      if (nativeParts) {
        const expectedSceneBodyIds = [...nativeParts.map((part) => part.bodyId), ...nativeJointResults.flatMap((item) => item.result.profileBodyIds ?? [])].sort((a, b) => a - b);
        assert.deepEqual(cleanup.bodies.map((body: any) => body.id).sort((a: number, b: number) => a - b), expectedSceneBodyIds, "Plasticity scene changed unexpectedly before cleanup");
      } else assert.equal(cleanup.bodies.length, 1, "Plasticity scene changed unexpectedly before cleanup");
      while (cleanup.undoDepth > nativeInitial.undoDepth) {
        cleanup = await callTool<any>(plasticityClient, "plasticity_undo", {
          intent: "Restore the explicitly empty Plasticity scene after Workbench orientation acceptance", revision: cleanup.revision,
        });
      }
      assert.equal(cleanup.bodies.length, 0, "Plasticity acceptance did not restore the empty scene");
      assert.equal(cleanup.regions.length, 0);
      if (nativeOrientationEvidence) Object.assign(nativeOrientationEvidence, { restoredEmptyDocument: true, mcpStderrBytes: nativeMcpStderr.join("").length });
      if (nativeOrientationEvidence && protectedZoneAssessment) Object.assign(nativeOrientationEvidence, { protectedZoneAssessment });
    } else {
      printability = await callTool<DfmReport>(client, "workbench_assess_printability", {
        projectId: project.id, dfm: { sizeMm: dfmSizeMm }, profileHash: registeredProfile.profileHash,
      });
    }
    if (!inputPath || !modelBytes) throw new Error("An input artifact must be available before upload");
    const preparedInputPath = inputPath;
    const preparedModelBytes = modelBytes;
    validateWorkbenchInputPath(inputPath, slicerId);
    assert.ok(printability!, "Workbench DFM assessment must complete before slicing");

    const inputParts: Array<{ path: string; bytes: Buffer<ArrayBufferLike>; sizeMm: [number, number, number]; bodyId?: number }> = nativeParts ?? Array.from({ length: options.batchParts }, () => ({ path: preparedInputPath, bytes: preparedModelBytes, sizeMm: dfmSizeMm }));
    const partCount = inputParts.length;
    const sourceFiles = inputParts.map((part, index) => partCount === 1
      ? basename(part.path)
      : nativeParts ? `plasticity-part-${part.bodyId}.stl` : `batch-part-${index + 1}${part.path.toLowerCase().endsWith(".3mf") ? ".3mf" : ".stl"}`);
    await Promise.all(sourceFiles.map(async (name, index) => await writeFile(join(project.workspacePath, name), inputParts[index]!.bytes, { flag: "wx", mode: 0o600 })));
    const sources = await Promise.all(sourceFiles.map(async (relativePath, index) => {
      const source = await callTool<{ hash: string; bytes: number; originalName: string }>(client!, "workbench_upload_project_artifact", {
        projectId: project.id,
        relativePath,
      });
      assert.equal(source.bytes, inputParts[index]!.bytes.byteLength);
      return { ...source, sizeMm: inputParts[index]!.sizeMm, bodyId: nativeParts?.[index]?.bodyId };
    }));
    const source = sources[0]!;
    if (nativeParts) assert.equal(new Set(sources.map((part) => part.hash)).size, nativeParts.length, "each native split Solid must upload as a distinct artifact hash");

    type Job = {
      id: string;
      state: string;
      gcodeArtifactHash?: string;
      sourceArtifactHash: string;
      profileHash?: string;
      summary?: { layers?: number; depositionLayerZCount?: number; depositionLayerPathOrientationCount?: number; boundsMm?: { min: number[]; max: number[] } };
    };
    const sliceJobs = partCount === 1
      ? [await callTool<Job>(client, "workbench_slice_model", {
        projectId: project.id,
        request: {
          expectedRevision: project.revision,
          sourceArtifactHash: source.hash,
          profileHash: registeredProfile.profileHash,
          dfm: { sizeMm: source.sizeMm },
        },
      })]
      : (await callTool<{ status: string; items: Array<{ label: string; job?: Job; failure?: string }> }>(client!, "workbench_slice_parts", {
        projectId: project.id,
        request: {
          expectedRevision: project.revision,
          profileHash: registeredProfile.profileHash,
          parts: sources.map((part, index) => ({
            label: `Test part ${index + 1}`,
            sourceArtifactHash: part.hash,
            dfm: options.splitNative
              ? { sizeMm: part.sizeMm, split: { bedMarginMm: 5, joint: options.splitJoint!, ...(options.splitJoint !== "flat" ? { clearanceMm: 0.2 } : {}) } }
              : { sizeMm: part.sizeMm },
          })),
        },
      }).then((result) => {
        assert.equal(result.status, "completed");
        assert.equal(result.items.length, partCount);
        assert.ok(result.items.every((item) => item.job?.state === "ready"), JSON.stringify(result.items.map(({ label, failure }) => ({ label, failure }))));
        return result.items.map((item) => item.job!);
      }));
    assert.equal(sliceJobs.length, partCount);
    const previewAssets: Array<{ jobId: string; layers: number; boundsMm: { min: number[]; max: number[] }; previewSizeMm: number[]; extrusionMoves: number; sha256: string; bytes: number }> = [];
    const interfaceHeightEvidence: Array<{
      jobId: string; profileHash: string; gcodeArtifactHash: string; layerCount: number;
      selectedInterfaceHeights: number[]; relativeOffsetsMm: number[]; firstDepositionLayerZMm: number;
      selectedPathOrientations: Array<{ layerIndex: number; principalDirectionDeg: number | null; directionalConcentration: number | null; coverage: string }>;
      selectedLayerPaths: Array<{ layerIndex: number; depositionLayerZMm: number; principalDirectionDeg: number | null; directionalConcentration: number | null; coverage: string }>;
    }> = [];
    for (const job of sliceJobs) {
      assert.equal(job.state, "ready");
      assert.ok(job.gcodeArtifactHash);
      assert.equal(job.profileHash, registeredProfile.profileHash, "slice job must retain the selected immutable profile identity");
      assert.ok(sources.some((candidate) => candidate.hash === job.sourceArtifactHash));
      assert.ok((job.summary?.layers ?? 0) > 0, "slicer must report a positive layer count");
      assert.equal(job.summary?.depositionLayerZCount, job.summary?.layers, "MCP summary must confirm a complete deposition height schedule without returning the full schedule");
      assert.equal(job.summary?.depositionLayerPathOrientationCount, job.summary?.layers, "MCP summary must confirm a complete path direction schedule without returning the full schedule");
      const previewResponse = await fetch(`${address.origin}/api/projects/${encodeURIComponent(project.id)}/assets/${job.gcodeArtifactHash}`);
      assert.equal(previewResponse.status, 200, "Workbench G-code preview asset endpoint must return the attached G-code");
      assert.equal(previewResponse.headers.get("content-type"), "text/x-gcode");
      const gcode = await previewResponse.text();
      const previewLayers = (gcode.match(/^;\s*(?:LAYER_CHANGE|CHANGE_LAYER)\s*$/gm) ?? []).length;
      assert.ok(previewLayers > 0, "preview G-code must contain layer markers");
      assert.equal(previewLayers, job.summary?.layers, "G-code preview layer markers must match the slicer summary");
      const boundsMm = job.summary?.boundsMm;
      assert.ok(boundsMm, "slicer must report model bounds from generated G-code");
      const previewSizeMm = sizeOfBounds(boundsMm);
      assert.ok(previewSizeMm.every((value, axis) => value <= mcpProfile.printer.buildVolumeMm[axis]! + 0.01), "generated G-code bounds must fit the selected printer build volume");
      const expectedPart = sources.find((candidate) => candidate.hash === job.sourceArtifactHash);
      assert.ok(expectedPart, "sliced job must resolve to its exact uploaded source artifact");
      const expectedDimensions = expectedPart.sizeMm.slice().sort((left, right) => left - right);
      const actualDimensions = previewSizeMm.slice().sort((left, right) => left - right);
      assert.ok(sameVector(actualDimensions, expectedDimensions, 0.05), `slicer-oriented bounds ${actualDimensions.join(" × ")} must match source-part bounds ${expectedDimensions.join(" × ")} within 0.05 mm`);
      const extrusionMoves = gcode.split(/\r?\n/).filter((line) => /^G[01]\s/.test(line) && /(?:^|\s)E-?(?:\d+(?:\.\d*)?|\.\d+)/.test(line)).length;
      assert.ok(extrusionMoves > 0, "preview G-code must contain extrusion moves");
      const layerCount = job.summary!.layers!;
      const interfaceLayerIndices = [...new Set([1, Math.floor(layerCount / 2), layerCount - 1])].sort((left, right) => left - right);
      const heights: {
        jobId: string;
        profileHash?: string;
        gcodeArtifactHash: string;
        layerCount: number;
        coordinateFrame: string;
        firstDepositionLayerZMm: number;
        interfaces: Array<{
          interfaceLayerIndex: number; depositionLayerZMm: number; relativeOffsetMm: number;
          depositionPathOrientation?: { layerIndex: number; planarPathLengthMm: number; principalDirectionDeg: number | null; directionalConcentration: number | null; curvedExtrusionMoves: number; coverage: "complete-linear" | "complete-planar" | "partial-curved" | "no-planar-extrusion" };
        }>;
      } = await callTool(client, "workbench_slicer_interface_heights", { projectId: project.id, jobId: job.id, interfaceLayerIndices });
      assert.equal(heights.jobId, job.id);
      assert.equal(heights.profileHash, registeredProfile.profileHash);
      assert.equal(heights.gcodeArtifactHash, job.gcodeArtifactHash);
      assert.equal(heights.layerCount, layerCount);
      assert.equal(heights.coordinateFrame, "slicer-build");
      assert.deepEqual(heights.interfaces.map((item) => item.interfaceLayerIndex), interfaceLayerIndices);
      assert.ok(heights.interfaces.every((item) => item.depositionPathOrientation
        && item.depositionPathOrientation.layerIndex === item.interfaceLayerIndex
        && Number.isFinite(item.depositionPathOrientation.planarPathLengthMm)
        && Number.isInteger(item.depositionPathOrientation.curvedExtrusionMoves)
        && (item.depositionPathOrientation.coverage === "complete-linear"
          || item.depositionPathOrientation.coverage === "complete-planar"
          || item.depositionPathOrientation.coverage === "partial-curved"
          || item.depositionPathOrientation.coverage === "no-planar-extrusion")),
      "each selected interface must return its deposition-layer XY road orientation and honest coverage");
      assert.ok(heights.interfaces.every((item, index) => Number.isFinite(item.depositionLayerZMm)
        && item.depositionLayerZMm >= heights.firstDepositionLayerZMm
        && Math.abs(item.relativeOffsetMm - (item.depositionLayerZMm - heights.firstDepositionLayerZMm)) <= 1e-9
        && (index === 0 || (item.depositionLayerZMm > heights.interfaces[index - 1]!.depositionLayerZMm
          && item.relativeOffsetMm > heights.interfaces[index - 1]!.relativeOffsetMm))));
      assert.equal(heights.interfaces[0]?.relativeOffsetMm, 0);
      const selectedLayerIndices = selectLayerIndicesForOrientationAcceptance(layerCount);
      const layerPaths: {
        jobId: string; profileHash?: string; gcodeArtifactHash: string; layerCount: number; coordinateFrame: string;
        layers: Array<{ layerIndex: number; depositionLayerZMm: number; pathOrientation: { layerIndex: number; planarPathLengthMm: number; principalDirectionDeg: number | null; directionalConcentration: number | null; curvedExtrusionMoves: number; coverage: "complete-linear" | "complete-planar" | "partial-curved" | "no-planar-extrusion" } }>;
      } = await callTool(client, "workbench_slicer_layer_path_orientations", { projectId: project.id, jobId: job.id, layerIndices: selectedLayerIndices });
      assert.equal(layerPaths.jobId, job.id);
      assert.equal(layerPaths.profileHash, registeredProfile.profileHash);
      assert.equal(layerPaths.gcodeArtifactHash, job.gcodeArtifactHash);
      assert.equal(layerPaths.layerCount, layerCount);
      assert.equal(layerPaths.coordinateFrame, "slicer-build");
      assert.deepEqual(layerPaths.layers.map((item) => item.layerIndex), selectedLayerIndices);
      assert.equal(layerPaths.layers.at(-1)?.layerIndex, layerCount, "the final deposited layer must be queryable");
      assert.ok(layerPaths.layers.every((item) => item.pathOrientation.layerIndex === item.layerIndex
        && Number.isFinite(item.depositionLayerZMm)
        && Number.isFinite(item.pathOrientation.planarPathLengthMm)
        && Number.isInteger(item.pathOrientation.curvedExtrusionMoves)
        && (item.pathOrientation.coverage === "complete-linear"
          || item.pathOrientation.coverage === "complete-planar"
          || item.pathOrientation.coverage === "partial-curved"
          || item.pathOrientation.coverage === "no-planar-extrusion")));
      interfaceHeightEvidence.push({
        jobId: job.id,
        profileHash: registeredProfile.profileHash,
        gcodeArtifactHash: job.gcodeArtifactHash,
        layerCount,
        selectedInterfaceHeights: heights.interfaces.map((item) => item.depositionLayerZMm),
        relativeOffsetsMm: heights.interfaces.map((item) => item.relativeOffsetMm),
        firstDepositionLayerZMm: heights.firstDepositionLayerZMm,
        selectedPathOrientations: heights.interfaces.map((item) => ({
          layerIndex: item.depositionPathOrientation!.layerIndex,
          planarPathLengthMm: item.depositionPathOrientation!.planarPathLengthMm,
          principalDirectionDeg: item.depositionPathOrientation!.principalDirectionDeg,
          directionalConcentration: item.depositionPathOrientation!.directionalConcentration,
          curvedExtrusionMoves: item.depositionPathOrientation!.curvedExtrusionMoves,
          coverage: item.depositionPathOrientation!.coverage,
        })),
        selectedLayerPaths: layerPaths.layers.map((item) => ({
          layerIndex: item.layerIndex,
          depositionLayerZMm: item.depositionLayerZMm,
          planarPathLengthMm: item.pathOrientation.planarPathLengthMm,
          principalDirectionDeg: item.pathOrientation.principalDirectionDeg,
          directionalConcentration: item.pathOrientation.directionalConcentration,
          curvedExtrusionMoves: item.pathOrientation.curvedExtrusionMoves,
          coverage: item.pathOrientation.coverage,
        })),
      });
      previewAssets.push({
        jobId: job.id,
        layers: previewLayers,
        boundsMm,
        previewSizeMm,
        extrusionMoves,
        sha256: createHash("sha256").update(gcode).digest("hex"),
        bytes: Buffer.byteLength(gcode),
      });
    }

    for (const job of sliceJobs) {
      const deniedSubmission = await client.callTool({
        name: "workbench_submit_approved_print",
        arguments: { projectId: project.id, jobId: job.id },
      });
      const deniedText = responseText(deniedSubmission);
      assert.ok(deniedSubmission.isError || /not approved|not ready|not approved/i.test(deniedText), "submission must be rejected while the job is awaiting browser approval");
    }
    const listedJobs = await callTool<Array<{ id: string; state: string }>>(client, "workbench_print_jobs", { projectId: project.id });
    assert.ok(sliceJobs.every((candidate) => listedJobs.find((record) => record.id === candidate.id)?.state === "ready"));
    assert.deepEqual(printerCalls, { uploadAndStart: 0, reconcileSubmission: 0 });

    const evidence = {
      schemaVersion: 1,
      startedAt: new Date().toISOString(),
      project: { id: project.id, revision: project.revision },
      source: { originalName: source.originalName, bytes: source.bytes, sha256: source.hash },
      sources: sources.map(({ originalName, bytes, hash }) => ({ originalName, bytes, sha256: hash })),
      profile: { printer: mcpProfile.printer, material: mcpProfile.material, slicer: mcpProfile.slicer },
      registeredProfileHash: registeredProfile.profileHash,
      jobs: sliceJobs.map((job) => ({ id: job.id, state: job.state, sourceArtifactHash: job.sourceArtifactHash, gcodeArtifactHash: job.gcodeArtifactHash, summary: job.summary })),
      job: { id: sliceJobs[0]!.id, state: sliceJobs[0]!.state, gcodeArtifactHash: sliceJobs[0]!.gcodeArtifactHash, summary: sliceJobs[0]!.summary },
      gcodePreview: { endpointStatus: 200, ...previewAssets[0]! },
      gcodePreviews: previewAssets,
      slicerInterfaceHeights: interfaceHeightEvidence,
      dfm: printability!,
      ...(nativeOrientationEvidence ? { nativeOrientation: nativeOrientationEvidence } : {}),
      submitWithoutApproval: { rejected: true, allJobStatesRemainReady: true },
      printerContacted: false,
      printStarted: false,
      completedAt: new Date().toISOString(),
      ...(stderr.length ? { mcpStderrBytes: stderr.join("\n").length } : {}),
    };
    const evidencePath = join(output, "evidence.json");
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ ok: true, evidence: evidencePath, projectId: project.id, jobs: sliceJobs.length, state: "ready", layers: previewAssets.map((asset) => asset.layers) }, null, 2));
  } finally {
    if (plasticityClient && nativeInitialState && nativeLastRevision) {
      try {
        let recoveryState = await callTool<any>(plasticityClient, "plasticity_status", {});
        if (recoveryState.documentToken === nativeInitialState.documentToken && recoveryState.revision === nativeLastRevision) {
          while (recoveryState.undoDepth > nativeInitialState.undoDepth) {
            recoveryState = await callTool<any>(plasticityClient, "plasticity_undo", {
              intent: "Recover disposable Workbench orientation acceptance in the original Plasticity document",
              revision: recoveryState.revision,
            });
          }
          assert.ok(recoveryState.bodies.length === 0 && recoveryState.regions.length === 0, "Plasticity recovery did not restore the initial empty scene");
        }
      } catch {
        // Preserve the primary acceptance failure; uncertain or user-changed CAD state is never undone automatically.
      }
    }
    await plasticityClient?.close().catch(() => {});
    await plasticityTransport?.close().catch(() => {});
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    await http?.close().catch(() => {});
    database.close();
  }
}

export function validateWorkbenchInputPath(inputPath: string, slicer: "creality-print" | "orca-slicer" | "bambu-studio"): void {
  const extension = inputPath.split(".").at(-1)?.toLowerCase();
  if (extension !== "stl" && extension !== "3mf") throw new Error("Input must be a Plasticity-exported STL or 3MF");
  if (extension === "3mf" && slicer === "creality-print") throw new Error("Creality Print live acceptance only supports Plasticity-exported STL");
}

function noSubmitPrinter(calls: { uploadAndStart: number; reconcileSubmission: number }) {
  return {
    connectionKind: "moonraker" as const,
    async status(_profile: PrinterProfile): Promise<PrinterStatus> {
      throw new Error("Printer status is intentionally unavailable in this slicing-only acceptance");
    },
    async uploadAndStart(_profile: PrinterProfile, _gcode: Uint8Array, _name: string): Promise<{ remoteFilename: string }> {
      calls.uploadAndStart += 1;
      throw new Error("This acceptance must never start a print");
    },
    async reconcileSubmission(_profile: PrinterProfile, expectedRemoteFilename: string): Promise<PrinterSubmissionObservation> {
      calls.reconcileSubmission += 1;
      return {
        outcome: "unknown",
        expectedRemoteFilename,
        message: "This acceptance must never contact a printer",
        observedAt: new Date().toISOString(),
      };
    },
  };
}

async function callTool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const response = await client.callTool({ name, arguments: args });
  const text = responseText(response);
  if (response.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text) as T;
}

function sizeOfBounds(bounds: { min: number[]; max: number[] }): [number, number, number] {
  return bounds.max.map((value, axis) => value - bounds.min[axis]!) as [number, number, number];
}

export function findSplitInterfaces(parts: Array<{ id: number; boundsMm: { min: number[]; max: number[] } }>): Array<{
  lowerBodyId: number;
  upperBodyId: number;
  seamAxis: number;
  baseCenterMm: [number, number, number];
  axis: [number, number, number];
  widthDirection: [number, number, number];
  tongueWidthMm: number;
  tongueThicknessMm: number;
}> {
  const interfaces: ReturnType<typeof findSplitInterfaces> = [];
  for (let first = 0; first < parts.length; first += 1) {
    for (let second = first + 1; second < parts.length; second += 1) {
      const firstPart = parts[first]!;
      const secondPart = parts[second]!;
      for (let seamAxis = 0; seamAxis < 3; seamAxis += 1) {
        let lower = firstPart;
        let upper = secondPart;
        if (Math.abs(firstPart.boundsMm.max[seamAxis]! - secondPart.boundsMm.min[seamAxis]!) > 0.01) {
          if (Math.abs(secondPart.boundsMm.max[seamAxis]! - firstPart.boundsMm.min[seamAxis]!) > 0.01) continue;
          lower = secondPart;
          upper = firstPart;
        }
        const overlap: Array<{ axis: number; min: number; max: number; span: number }> = [];
        let touchesAcrossFace = true;
        for (let axis = 0; axis < 3; axis += 1) {
          if (axis === seamAxis) continue;
          const min = Math.max(lower.boundsMm.min[axis]!, upper.boundsMm.min[axis]!);
          const max = Math.min(lower.boundsMm.max[axis]!, upper.boundsMm.max[axis]!);
          if (max - min <= 0.01) { touchesAcrossFace = false; break; }
          overlap.push({ axis, min, max, span: max - min });
        }
        if (!touchesAcrossFace) continue;
        const width = overlap.slice().sort((a, b) => b.span - a.span)[0]!;
        const thickness = overlap.find((item) => item.axis !== width.axis)!;
        const tongueWidthMm = Math.min(40, width.span - 10);
        const tongueThicknessMm = Math.min(6, thickness.span - 4);
        if (tongueWidthMm <= 0 || tongueThicknessMm <= 0) throw new Error("Split seam is too small for the explicit test tongue-and-groove profile");
        const baseCenterMm = [0, 0, 0] as [number, number, number];
        baseCenterMm[seamAxis] = (lower.boundsMm.max[seamAxis]! + upper.boundsMm.min[seamAxis]!) / 2;
        for (const item of overlap) baseCenterMm[item.axis] = (item.min + item.max) / 2;
        const axis = [0, 0, 0] as [number, number, number];
        axis[seamAxis] = 1;
        const widthDirection = [0, 0, 0] as [number, number, number];
        widthDirection[width.axis] = 1;
        interfaces.push({ lowerBodyId: lower.id, upperBodyId: upper.id, seamAxis, baseCenterMm, axis, widthDirection, tongueWidthMm, tongueThicknessMm });
      }
    }
  }
  return interfaces.sort((a, b) => a.seamAxis - b.seamAxis || a.baseCenterMm[a.seamAxis]! - b.baseCenterMm[b.seamAxis]!);
}

function sameVector(actual: number[], expected: number[], tolerance: number): boolean {
  return Array.isArray(actual) && actual.length === 3 && actual.every((value, axis) => Number.isFinite(value) && Math.abs(value - expected[axis]!) <= tolerance);
}

function binaryStlBounds(bytes: Buffer): { min: [number, number, number]; max: [number, number, number] } {
  if (bytes.byteLength < 84) throw new Error("Plasticity binary STL is truncated");
  const triangleCount = bytes.readUInt32LE(80);
  if (triangleCount < 1 || bytes.byteLength !== 84 + triangleCount * 50) throw new Error("Plasticity binary STL triangle count does not match its file size");
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const triangleOffset = 84 + triangle * 50;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const offset = triangleOffset + 12 + vertex * 12;
      for (let axis = 0; axis < 3; axis += 1) {
        const value = bytes.readFloatLE(offset + axis * 4);
        if (!Number.isFinite(value)) throw new Error("Plasticity binary STL contains a non-finite vertex");
        min[axis] = Math.min(min[axis]!, value);
        max[axis] = Math.max(max[axis]!, value);
      }
    }
  }
  return { min: min as [number, number, number], max: max as [number, number, number] };
}

function assertBoundsMatch(actual: { min: number[]; max: number[] }, expected: { min: number[]; max: number[] }, tolerance: number, label: string): void {
  for (let axis = 0; axis < 3; axis += 1) {
    assert.ok(Math.abs(actual.min[axis]! - expected.min[axis]!) <= tolerance, `${label} minimum axis ${axis}: expected ${expected.min[axis]} ± ${tolerance}, got ${actual.min[axis]}`);
    assert.ok(Math.abs(actual.max[axis]! - expected.max[axis]!) <= tolerance, `${label} maximum axis ${axis}: expected ${expected.max[axis]} ± ${tolerance}, got ${actual.max[axis]}`);
  }
}

function responseText(response: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = response.content as Array<{ type: string; text?: string }>;
  return content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error((error instanceof Error ? error.message : String(error)).slice(0, 4_000)); process.exitCode = 1; });
}
