#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureUrl = "https://example.test/synthetic-acceptance-only";
const hash = (n: number) => n.toString(16).padStart(64, "0");

interface Options { help: boolean; target?: string; allowMutations: boolean; output?: string }

export function parseArgs(argv: string[]): Options {
  if (argv.length === 0) return { help: true, allowMutations: false };
  const options: Options = { help: false, allowMutations: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") options.help = true;
    else if (arg === "--allow-disposable-mutations") options.allowMutations = true;
    else if (arg === "--target" || arg === "--output") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--target") options.target = value;
      else options.output = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.help) return options;
  if (!options.target) throw new Error("Pass --target with an explicit Plasticity window ID");
  if (!options.allowMutations) throw new Error("Pass --allow-disposable-mutations for the disposable cohesive fixture");
  if (!options.output) throw new Error("Pass --output with a new evidence directory");
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run accept:cohesive-mixed-mode -- --target WINDOW_ID --allow-disposable-mutations --output NEW_DIRECTORY");
    return;
  }
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts", "run-server.ts")],
    cwd: projectRoot,
    env: {
      ...selectedEnvironment(process.env),
      PLASTICITY_STRENGTH_ROOT: join(output, "strength-store"),
      PLASTICITY_CDP_URL: process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "plasticity-cohesive-mixed-mode-acceptance", version: "1.0.0" });
  const evidence: Record<string, unknown> = { schemaVersion: 1, startedAt: new Date().toISOString(), plasticityVersion: "26.1.3", fixture: "single-material orthotropic box with an oblique mixed-mode layer interface" };
  let acceptanceResult: Record<string, unknown> | undefined;
  let initial: any;
  let revision: string | undefined;
  let ownedUndoSteps = 0;
  try {
    await client.connect(transport);
    const windows = await call(client, "plasticity_list_windows", {});
    requireCondition(windows.some((w: { targetId: string }) => w.targetId === options.target), "Explicit Plasticity window was not found");
    initial = await call(client, "plasticity_connect", { targetId: options.target });
    requireCondition(initial.bodies.length === 0 && initial.regions.length === 0, "Refusing live acceptance in a nonempty document");
    revision = initial.revision;

    const boxResult = await call(client, "plasticity_create_box", {
      originMm: [0, 0, 0], sizeMm: [10, 10, 10], name: "Disposable mixed-mode coupon", intent: "Create a disposable one-material cohesive solver fixture", revision,
    });
    revision = boxResult.revision;
    ownedUndoSteps += 1;
    const createdBox = boxResult.bodies.find((body: any) => body.type === "Solid");
    requireCondition(createdBox, "Plasticity did not create the native box");
    const angle = Math.PI / 4;
    const layerNormal = [Math.sin(angle), 0, Math.cos(angle)];
    const layerTangent = [Math.cos(angle), 0, -Math.sin(angle)];
    const rotated = await call(client, "plasticity_rotate", {
      ids: [createdBox.id], pivotMm: [0, 0, 0], axis: [0, 1, 0], degrees: 45,
      intent: "Rotate the disposable fixture so the print-layer interface is oblique to world axes", revision,
    });
    revision = rotated.revision;
    ownedUndoSteps += 1;
    const tiltedState = await call(client, "plasticity_status", {});
    revision = tiltedState.revision;
    const box = tiltedState.bodies.find((body: any) => body.id === createdBox.id && body.type === "Solid");
    requireCondition(box?.faces?.length, "Plasticity did not return the native box faces");
    const dot3 = (left: number[], right: number[]) => left.reduce((sum, value, axis) => sum + value * right[axis]!, 0);
    const support = box.faces.find((face: any) => face.planar && dot3(face.normal, layerNormal) < -0.99999 && dot3(face.centerMm, layerNormal) < 0.01);
    const loaded = box.faces.find((face: any) => face.planar && dot3(face.normal, layerNormal) > 0.99999 && dot3(face.centerMm, layerNormal) > 9.99);
    requireCondition(support && loaded, "Could not identify exact native support and load faces");
    const process = {
      printerId: "synthetic-acceptance-printer", materialId: "synthetic-acceptance-single-material", profileHash: "a".repeat(64),
      orientationDeg: [0, 45, 0], infillPercent: 100, nozzleTemperatureC: 220, layerHeightMm: 0.2,
    };
    const orthotropic = {
      youngsModulus2MPa: 1_800, youngsModulus3MPa: 900, poissonRatio13: 0.22, poissonRatio23: 0.26,
      shearModulus12MPa: 700, shearModulus13MPa: 350, shearModulus23MPa: 300,
    };
    const properties = { youngModulusMPa: 2_100, shearModulusMPa: 740, tensileStrengthMPa: 31, shearStrengthMPa: 17 };
    const nu12Evidence = {
      id: "base-poisson-ratio-nu12", label: "Synthetic nu12", status: "measured", unit: "ratio", value: 0.3,
      sourceUrl: fixtureUrl, sourceHash: hash(9), sourceLocator: "synthetic/nu12", dependsOn: [],
    };
    const couponEvidence = [
      ...Object.entries(properties).map(([key, value], i) => ({ id: `base-${key}`, label: `Synthetic ${key}`, status: "measured", unit: "MPa", value, sourceUrl: fixtureUrl, sourceHash: hash(i + 1), sourceLocator: `synthetic/${key}`, dependsOn: [] })),
      nu12Evidence,
      ...Object.entries(orthotropic).map(([key, value], i) => ({ id: `ortho-${key}`, label: `Synthetic ${key}`, status: "measured", unit: key.startsWith("poisson") ? "ratio" : "MPa", value, sourceUrl: fixtureUrl, sourceHash: hash(i + 10), sourceLocator: `synthetic/${key}`, dependsOn: [] })),
    ];
    const coupon = await call(client, "plasticity_record_material_coupon_data", {
      process, poissonRatio: 0.3, poissonRatioEvidence: [nu12Evidence.id], properties,
      propertyEvidence: { youngModulusMPa: ["base-youngModulusMPa"], shearModulusMPa: ["base-shearModulusMPa"], tensileStrengthMPa: ["base-tensileStrengthMPa"], shearStrengthMPa: ["base-shearStrengthMPa"] },
      orthotropicMaterial: {
        ...orthotropic, propertyEvidence: Object.fromEntries(Object.keys(orthotropic).map((key) => [key, [`ortho-${key}`]])),
        orientation: { axis1DirectionGlobal: layerTangent, axis2ReferenceDirectionGlobal: [0, 1, 0], buildDirectionGlobal: layerNormal, evidence: { status: "user-confirmed", description: "Synthetic 45-degree acceptance axes only; not physical print-orientation evidence." } },
      },
      evidence: couponEvidence, testStandard: "isolated synthetic solver integration acceptance", specimenCount: 1, testedAt: new Date().toISOString(),
      source: "physical-coupon-test", callerConfirmsPhysicalTests: true,
    });
    const couponId = coupon.record?.id;
    requireCondition(typeof couponId === "string", "Synthetic single-material orthotropic coupon was not recorded");

    const dcb = await recordCurve(client, process, "normal-tension", layerNormal, layerNormal, 1, 0.5, 0, 0.02);
    const enf = await recordCurve(client, process, "interface-shear", layerNormal, layerTangent, 2, 0, 0.4, 0.04);
    const mmb25 = await recordMixedModeCurve(client, process, 3, 0.25, layerNormal, layerTangent);
    const mmb75 = await recordMixedModeCurve(client, process, 4, 0.75, layerNormal, layerTangent);
    const response = await call(client, "plasticity_analyze_cohesive_interface", {
      bodyId: box.id, revision, interfaceTestRecordId: dcb,
      splitPlanes: [{ pointMm: layerNormal.map((component) => component * 5), normalGlobal: layerNormal }],
      layerPlanePlan: {
        processProfileHash: process.profileHash,
        firstInterfacePointMm: layerNormal.map((component) => component * 5),
        buildDirectionGlobal: layerNormal,
        layerHeightMm: 0.2,
        totalLayerCount: 2,
        interfaceLayerIndices: [1],
      },
      supportFaceId: support.id, loadedFaceId: loaded.id, meshSizeMm: 10,
      poissonRatio: 0.3, poissonRatioEvidence: nu12Evidence,
      useOrthotropicBulkProperties: true, modeIIRecordId: enf, mixedModeRecordIds: [mmb25, mmb75],
      initialStiffnessMPaPerMm: 10_000,
      initialStiffnessEvidence: { ...sourced("cohesive-K", 10_000, "MPa/mm"), materialProcess: process },
      prescribedDisplacementGlobalMm: layerNormal.map((component, axis) => 0.01 * component + 0.01 * layerTangent[axis]!), increments: 100,
    }, 600_000);
    requireCondition(response.solver?.solver === "Code_Aster 17.4.0" && response.solver.interpretation === "raw-mixed-mode-cohesive-solver-response", "Production MCP did not return a Code_Aster Turon result");
    requireCondition(response.physicalTest.interfaceKind === "same-material-layer" && response.mesh.volumeCount === 2 && response.mesh.interfaceSurfaceCount === 1, "Production MCP did not preserve the one-interface, one-material fixture");
    requireCondition(response.materialAssignment.negativeSide.process.materialId === process.materialId && response.materialAssignment.positiveSide.process.materialId === process.materialId, "Production MCP mixed different material processes");
    requireCondition(response.strengthPass === false && response.printApproved === false, "Cohesive response must never approve strength or printing");
    const report = await call(client, "plasticity_cohesive_fem_report", { reportId: response.id });
    requireCondition(report.freshness.status === "current", "Mixed-mode report is not current");
    const result = {
      reportId: response.id, boxId: box.id, couponRecordId: couponId, process, interfaceRecords: { dcb, enf, mmb25, mmb75 },
      solver: response.solver.solver, mesh: response.mesh, damage: { maxDamageV3: response.solver.maxDamageV3, maxStateV5: response.solver.maxStateV5 },
      strengthPass: response.strengthPass, printApproved: response.printApproved, freshness: report.freshness,
      limitation: "Synthetic integration fixture only; not physical material qualification or part strength evidence.",
    };
    evidence.result = result;
    acceptanceResult = result;
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (initial) {
      try {
        const state = await call(client, "plasticity_status", {});
        if (ownedUndoSteps > 0 && state.documentToken === initial.documentToken && state.revision === revision) {
          for (let step = 0; step < ownedUndoSteps; step += 1) {
            const afterUndo = await call(client, "plasticity_undo", { intent: "Remove disposable mixed-mode acceptance fixture", revision });
            revision = afterUndo.revision;
          }
          const finalState = await call(client, "plasticity_status", {});
          evidence.cleanup = { restoredEmptyDocument: finalState.bodies.length === 0 && finalState.regions.length === 0, revision: finalState.revision, undoSteps: ownedUndoSteps };
        } else evidence.cleanup = { restoredEmptyDocument: false, reason: "Document changed independently; automatic Undo refused" };
      } catch (error) { evidence.cleanup = { restoredEmptyDocument: false, reason: error instanceof Error ? error.message : String(error) }; }
    }
    try { await client.close(); } catch { /* Preserve the solver or acceptance result. */ }
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(output, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  }
  requireCondition((evidence.cleanup as { restoredEmptyDocument?: boolean } | undefined)?.restoredEmptyDocument === true,
    "Acceptance did not restore the initially empty Plasticity document; inspect evidence.json before continuing");
  console.log(JSON.stringify({ ok: true, ...acceptanceResult }));
}

async function recordCurve(client: Client, process: Record<string, unknown>, testMode: "normal-tension" | "interface-shear", normal: number[], direction: number[], index: number, normalPeak: number, shearPeak: number, energy: number): Promise<string> {
  const peak = Math.hypot(normalPeak, shearPeak);
  const points = [
    { separationMm: 0, tractionMPa: 0 },
    { separationMm: energy / peak, tractionMPa: peak },
    { separationMm: 2 * energy / peak, tractionMPa: 0 },
  ];
  const record = await call(client, "plasticity_record_material_interface_test", {
    materialProcess: process, testMode,
    interfaceNormalGlobal: normal, loadDirectionGlobal: direction,
    testMethod: `Synthetic ${testMode === "normal-tension" ? "DCB" : "ENF"} cohesive integration fixture`,
    testProtocolHash: hash(index + 100), specimenDescription: "Synthetic software-acceptance fixture only.", fixtureDescription: "Not a physical test.",
    measuredPeakStrengthMPa: peak,
    tractionSeparationCurve: { sourceHash: hash(index + 110), sourceLocator: `synthetic/curve-${index}.csv`, points },
    failureLocation: "interface", evidence: [{ id: `synthetic-peak-${index}`, label: "Synthetic acceptance peak", status: "measured", unit: "MPa", value: peak, sourceUrl: fixtureUrl, sourceHash: hash(index + 120), sourceLocator: `synthetic/peak-${index}`, dependsOn: [] }],
    specimenCount: 1, testedAt: new Date().toISOString(), source: "physical-material-interface-test", callerConfirmsPhysicalTests: true,
  });
  if (typeof record.record?.id !== "string") throw new Error(`Could not create synthetic ${testMode} record`);
  return record.record.id;
}

async function recordMixedModeCurve(
  client: Client,
  process: Record<string, unknown>,
  index: number,
  shearEnergyFraction: number,
  normal: number[],
  tangent: number[],
): Promise<string> {
  const modeI = 0.02;
  const modeII = 0.04;
  const total = modeI + (modeII - modeI) * shearEnergyFraction ** 2;
  const normalEnergy = total * (1 - shearEnergyFraction);
  const tangentialEnergy = total * shearEnergyFraction;
  const normalPeak = 0.5;
  const tangentialPeak = 0.4;
  const normalDirection = Math.sqrt(1 - shearEnergyFraction);
  const tangentDirection = Math.sqrt(shearEnergyFraction);
  const directionNorm = Math.hypot(normalDirection, tangentDirection);
  const peak = Math.hypot(normalPeak, tangentialPeak);
  const record = await call(client, "plasticity_record_material_interface_test", {
    materialProcess: process, testMode: "mixed-mode",
    interfaceNormalGlobal: normal,
    loadDirectionGlobal: tangent.map((component, axis) => component * tangentDirection / directionNorm + normal[axis]! * normalDirection / directionNorm),
    testMethod: "Synthetic ASTM D6671 MMB cohesive integration fixture", testProtocolHash: hash(index + 100),
    specimenDescription: "Synthetic same-material software acceptance fixture only.", fixtureDescription: "Not a physical test.",
    measuredPeakStrengthMPa: peak,
    mixedModeTractionSeparationCurve: {
      sourceHash: hash(index + 110), sourceLocator: `synthetic/mmb-${index}.csv`,
      points: [
        { normalSeparationMm: 0, tangentialSeparationMm: 0, normalTractionMPa: 0, tangentialTractionMPa: 0 },
        { normalSeparationMm: normalEnergy / normalPeak, tangentialSeparationMm: tangentialEnergy / tangentialPeak, normalTractionMPa: normalPeak, tangentialTractionMPa: tangentialPeak },
        { normalSeparationMm: 2 * normalEnergy / normalPeak, tangentialSeparationMm: 2 * tangentialEnergy / tangentialPeak, normalTractionMPa: 0, tangentialTractionMPa: 0 },
      ],
    },
    failureLocation: "interface", evidence: [{ id: `synthetic-peak-${index}`, label: "Synthetic acceptance peak", status: "measured", unit: "MPa", value: peak, sourceUrl: fixtureUrl, sourceHash: hash(index + 120), sourceLocator: `synthetic/peak-${index}`, dependsOn: [] }],
    specimenCount: 1, testedAt: new Date().toISOString(), source: "physical-material-interface-test", callerConfirmsPhysicalTests: true,
  });
  if (typeof record.record?.id !== "string") throw new Error("Could not create synthetic mixed-mode record");
  return record.record.id;
}

function sourced(id: string, value: number, unit: string): Record<string, unknown> {
  return { id, label: `Synthetic ${id}`, status: "sourced", unit, value, sourceUrl: fixtureUrl, sourceHash: hash(id.length + 200), sourceLocator: `synthetic/${id}`, dependsOn: [] };
}

async function call(client: Client, name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<any> {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
  const content = (response as { content: Array<{ type: string; text?: string }> }).content;
  const text = content.find((part) => part.type === "text")?.text ?? "";
  if (response.isError) throw new Error(text);
  try { return JSON.parse(text); } catch { throw new Error(`${name} returned invalid JSON: ${text.slice(0, 2_000)}`); }
}

function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(["PATH", "HOME", "TMPDIR", "PLASTICITY_CDP_URL"].flatMap((key) =>
    typeof environment[key] === "string" ? [[key, environment[key]!]] : []));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
