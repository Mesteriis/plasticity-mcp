#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCodeAsterCzmAcceptance, type CodeAsterCzmAcceptance } from "../src/strength/fem/code-aster-czm-acceptance.ts";
import { runCodeAsterCohesiveCase } from "../src/strength/fem/code-aster-cohesive-runner.ts";
import { codeAsterTuronDeckInputFromCalibration } from "../src/strength/fem/code-aster-turon-deck.ts";
import { runCodeAsterTuronCase } from "../src/strength/fem/code-aster-turon-runner.ts";

const IMAGE = "scimulate/code_aster:15.2@sha256:b4a2bf82ef4c52a719187bb6b3c7f6d0ac512da7a66a8bada4bf0c857b104810";
const IMAGE_17 = "simvia/code_aster@sha256:d8d19ea91989eac0d38195bc5795c54c69f530f7196f53d67697ffa57c9106d5";
const ASTER_17 = "/opt/spack/opt/spack/linux-zen2/code-aster-17.4.0-ecm2bfgr5obydotnlte6xilvggppqnap";
const TURON_3D_ACCEPTANCE = new URL("./fem/turon-3d-acceptance.py", import.meta.url);
const aster17TestCommand = (input: string) => ["/bin/bash", "-lc", `source /opt/activate.sh && mkdir -p /tmp/home /tmp/work && cd /tmp/work && ${ASTER_17}/bin/run_aster --test --time_limit 300 ${ASTER_17}/share/aster/tests/${input}.export`];
const CASES = [
  { test: "SSNV199A", input: "ssnv199a", minimumReferenceAssertions: 8, image: IMAGE, command: (input: string) => ["/opt/aster/15.2/bin/run_aster", "--test", `/opt/aster/15.2/share/aster/tests/${input}.export`] },
  { test: "SSNV199B", input: "ssnv199b", minimumReferenceAssertions: 6, image: IMAGE, command: (input: string) => ["/opt/aster/15.2/bin/run_aster", "--test", `/opt/aster/15.2/share/aster/tests/${input}.export`] },
  { test: "SSNV199C", input: "ssnv199c", minimumReferenceAssertions: 6, image: IMAGE, command: (input: string) => ["/opt/aster/15.2/bin/run_aster", "--test", `/opt/aster/15.2/share/aster/tests/${input}.export`] },
  { test: "SSNV199D", input: "ssnv199d", minimumReferenceAssertions: 6, image: IMAGE, command: (input: string) => ["/opt/aster/15.2/bin/run_aster", "--test", `/opt/aster/15.2/share/aster/tests/${input}.export`] },
  { test: "SSNP118S", input: "ssnp118s", minimumReferenceAssertions: 8, image: IMAGE, command: (input: string) => ["/opt/aster/15.2/bin/run_aster", "--test", `/opt/aster/15.2/share/aster/tests/${input}.export`] },
  { test: "SSNV110D", input: "ssnv110d", minimumReferenceAssertions: 4, image: IMAGE_17, command: aster17TestCommand },
  { test: "SSNV110E", input: "ssnv110e", minimumReferenceAssertions: 12, image: IMAGE_17, command: aster17TestCommand },
  { test: "SSNP118H", input: "ssnp118h", minimumReferenceAssertions: 20, image: IMAGE_17, command: aster17TestCommand },
  { test: "SSNP118I", input: "ssnp118i", minimumReferenceAssertions: 20, image: IMAGE_17, command: aster17TestCommand },
  { test: "SSNS110A", input: "ssns110a", minimumReferenceAssertions: 2, image: IMAGE_17, command: aster17TestCommand },
  { test: "SSNS110B", input: "ssns110b", minimumReferenceAssertions: 6, image: IMAGE_17, command: aster17TestCommand },
] as const;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

if (process.argv.slice(2).some((argument) => argument === "--help")) {
  console.log("Run pinned Code_Aster cohesive regressions on linux/amd64: 15.2 SSNV199A-D/SSNP118S and 17.4 SSNV110D/E, SSNP118H/I, SSNS110A/B. SSNP118H/I exercise 3D_INTERFACE cohesive laws; SSNS110A/B exercise steel-concrete CZM_LAB_MIX with GLIS_1D. Use --mode-i-3d-only for the synthetic ramped CZM_EXP_REG/CZM_LIN_REG acceptance, --turon-3d-only for mixed-mode damage, or --turon-orthotropic-only for orthotropic mixed-mode.");
} else if (process.argv.slice(2).includes("--mode-i-3d-only")) {
  console.log(JSON.stringify({ ok: true, syntheticThreeDimensionalModeILaws: await runCodeAsterModeILawAcceptance() }, null, 2));
} else if (process.argv.slice(2).includes("--turon-3d-only")) {
  console.log(JSON.stringify({ ok: true, syntheticThreeDimensionalCzmTuron: await runCodeAster17ThreeDimensionalTuronAcceptance() }, null, 2));
} else if (process.argv.slice(2).includes("--turon-orthotropic-only")) {
  console.log(JSON.stringify({ ok: true, syntheticThreeDimensionalOrthotropicCzmTuron: await runCodeAster17ThreeDimensionalTuronAcceptance(true) }, null, 2));
} else {
  const results: Array<{ test: string } & CodeAsterCzmAcceptance> = [];
  for (const testCase of CASES) {
    const result = await runDocker(testCase);
    if (result.code !== 0) throw new Error(`Code_Aster ${testCase.test} container exited with ${result.signal ?? result.code}: ${result.output.slice(-4_000)}`);
    results.push({ test: testCase.test, ...parseCodeAsterCzmAcceptance(result.output, testCase.minimumReferenceAssertions) });
  }
  const turon3dResult = await runCodeAster17ThreeDimensionalTuronAcceptance();
  console.log(JSON.stringify({
    ok: true,
    solverVersions: [...new Set([...results.map(({ solverVersion }) => solverVersion), turon3dResult.solverVersion])],
    officialBundledTests: results,
    syntheticThreeDimensionalCzmTuron: turon3dResult,
    solverImages: { "15.2": IMAGE.split("@")[1], "17.4": IMAGE_17.split("@")[1] },
    architecture: "linux/amd64",
    containerNetwork: "disabled",
  }, null, 2));
}

async function runCodeAsterModeILawAcceptance(): Promise<{
  solverVersion: string;
  completed: true;
  mesh: { materialATetrahedronCount: number; materialBTetrahedronCount: number; interfaceTriangleCount: number; cohesiveElementCount: number };
  cases: Array<{
    modeILaw: "CZM_EXP_REG" | "CZM_LIN_REG";
    displacementRows: number;
    displacementStartMm: number;
    displacementEndMm: number;
    peakReactionN: number;
    finalReactionN: number;
    initialV3Max: number;
    finalV3Max: number;
    v3Interpretation: string;
  }>;
  scope: string;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "plasticity-czm-mode-i-3d-"));
  try {
    const cases: Array<{
      modeILaw: "CZM_EXP_REG" | "CZM_LIN_REG";
      displacementRows: number;
      displacementStartMm: number;
      displacementEndMm: number;
      peakReactionN: number;
      finalReactionN: number;
      initialV3Max: number;
      finalV3Max: number;
      v3Interpretation: string;
    }> = [];
    let meshSummary: Record<string, unknown> | undefined;
    for (const modeILaw of ["CZM_EXP_REG", "CZM_LIN_REG"] as const) {
      const caseWorkspace = join(workspace, modeILaw.toLowerCase());
      await mkdir(caseWorkspace);
      const generated = await runLocal("python3", [TURON_3D_ACCEPTANCE.pathname, caseWorkspace]);
      if (generated.code !== 0) throw new Error(`Could not generate the synthetic 3D cohesive mesh: ${generated.output.slice(-4_000)}`);
      const currentMeshSummary = JSON.parse(generated.output) as Record<string, unknown>;
      if (currentMeshSummary.materialATetrahedronCount !== 48 || currentMeshSummary.materialBTetrahedronCount !== 48
        || currentMeshSummary.interfaceTriangleCount !== 8 || currentMeshSummary.cohesiveElementCount !== 8) {
        throw new Error("Synthetic Mode-I mesh did not contain the expected 48+48 bulk tetrahedra and eight PENTA6 interface elements");
      }
      meshSummary = currentMeshSummary;
      const result = await runCodeAsterCohesiveCase({
        workspacePath: caseWorkspace,
        deck: {
          materialAGrid: "GM1", materialBGrid: "GM2", supportFaceGroup: "GM4", loadedFaceGroup: "GM5", cohesiveElementGroup: "GM6",
          materialA: { youngsModulusMPa: 2_000, poissonRatio: 0.3 },
          materialB: { youngsModulusMPa: 2_000, poissonRatio: 0.3 },
          modeILaw,
          modeI: { peakTractionMPa: 2.4, fractureEnergyNPerMm: 0.09, adherencePenalty: 0.00001 },
          interfaceNormalGlobal: [0, 0, 1], displacementDirectionGlobal: [0, 0, 1], prescribedDisplacementMm: 0.08, increments: 20,
        },
      });
      const displacement = result.result.displacementHistory;
      const reactions = result.result.reactionHistory;
      const states = result.result.interfaceStateHistory;
      const initialV3Max = states[0]?.variables.V3.max;
      const finalV3Max = states.at(-1)?.variables.V3.max;
      const expectedFinalV3 = modeILaw === "CZM_LIN_REG" ? 2 : 1;
      const peakReactionN = Math.max(...reactions.map((row) => Math.abs(row.zN)));
      const finalReactionN = Math.abs(reactions.at(-1)?.zN ?? Number.NaN);
      if (displacement.length !== 21 || Math.abs(displacement[0]!.maxMm) > 1e-9
        || Math.abs(displacement.at(-1)!.maxMm - 0.08) > 1e-9) {
        throw new Error(`${modeILaw} did not complete the 21-point zero-to-0.08 mm displacement ramp`);
      }
      if (initialV3Max !== 0 || finalV3Max === undefined || Math.abs(finalV3Max - expectedFinalV3) > 1e-8) {
        throw new Error(`${modeILaw} did not reach its expected final V3 state ${expectedFinalV3}; received ${finalV3Max}`);
      }
      if (!(peakReactionN > 0) || !(finalReactionN < peakReactionN * 0.2)) {
        throw new Error(`${modeILaw} did not show a descending post-peak reaction response`);
      }
      cases.push({
        modeILaw,
        displacementRows: displacement.length,
        displacementStartMm: displacement[0]!.maxMm,
        displacementEndMm: displacement.at(-1)!.maxMm,
        peakReactionN,
        finalReactionN,
        initialV3Max,
        finalV3Max,
        v3Interpretation: result.result.v3Interpretation,
      });
    }
    if (!meshSummary) throw new Error("Synthetic cohesive mesh summary was not captured");
    return {
      solverVersion: "15.02.00",
      completed: true,
      mesh: {
        materialATetrahedronCount: meshSummary.materialATetrahedronCount as number,
        materialBTetrahedronCount: meshSummary.materialBTetrahedronCount as number,
        interfaceTriangleCount: meshSummary.interfaceTriangleCount as number,
        cohesiveElementCount: meshSummary.cohesiveElementCount as number,
      },
      cases,
      scope: "Synthetic solver integration only; not physical material calibration, mesh convergence, or part-strength qualification.",
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runCodeAster17ThreeDimensionalTuronAcceptance(orthotropic = false): Promise<{
  solverVersion: string;
  completed: true;
  cohesiveElements: number;
  maxDamageV3: number;
  maxStateV5: number;
  resultArtifactBytes: number;
  bulkMaterial: "isotropic" | "orthotropic";
}> {
  const workspace = await mkdtemp(join(tmpdir(), "plasticity-czm-turon-3d-"));
  try {
    const generated = await runLocal("python3", [TURON_3D_ACCEPTANCE.pathname, workspace]);
    if (generated.code !== 0) throw new Error(`Could not generate the 3D CZM_TURON acceptance job: ${generated.output.slice(-4_000)}`);
    const meshSummary = JSON.parse(generated.output) as Record<string, unknown>;
    if (meshSummary.materialATetrahedronCount !== 48 || meshSummary.materialBTetrahedronCount !== 48
      || meshSummary.interfaceTriangleCount !== 8 || meshSummary.cohesiveElementCount !== 8) {
      throw new Error("The synthetic 3D CZM_TURON mesh did not contain the expected two material regions and eight cohesive elements");
    }
    const deckInput = codeAsterTuronDeckInputFromCalibration({
      etaBk: 2,
      pureModePeakTractionMPa: { modeI: orthotropic ? 0.5 : 2.4, modeII: orthotropic ? 0.4 : 2 },
      pureModeFractureEnergyNPerMm: { modeI: 0.02, modeII: 0.04 },
    }, {
      materialAGrid: "GM1",
      materialBGrid: "GM2",
      supportFaceGroup: "GM4",
      loadedFaceGroup: "GM5",
      cohesiveElementGroup: "GM6",
      materialA: { youngsModulusMPa: 2_000, poissonRatio: 0.3 },
      materialB: { youngsModulusMPa: 2_000, poissonRatio: 0.3 },
      ...(orthotropic ? {
        orthotropicMaterialA: {
          youngsModulus2MPa: 1_500, youngsModulus3MPa: 800, poissonRatio13: 0.2, poissonRatio23: 0.25,
          shearModulus12MPa: 600, shearModulus13MPa: 350, shearModulus23MPa: 300,
          orientation: { axis1DirectionGlobal: [0, 1, 0] as [number, number, number], axis2ReferenceDirectionGlobal: [-1, 0, 0] as [number, number, number], buildDirectionGlobal: [0, 0, 1] as [number, number, number] },
        },
        orthotropicMaterialB: {
          youngsModulus2MPa: 1_500, youngsModulus3MPa: 800, poissonRatio13: 0.2, poissonRatio23: 0.25,
          shearModulus12MPa: 600, shearModulus13MPa: 350, shearModulus23MPa: 300,
          orientation: { axis1DirectionGlobal: [0, 1, 0] as [number, number, number], axis2ReferenceDirectionGlobal: [-1, 0, 0] as [number, number, number], buildDirectionGlobal: [0, 0, 1] as [number, number, number] },
        },
      } : {}),
      stiffnessMPaPerMm: orthotropic ? 10_000 : 100_000,
      residualStiffnessRatio: 0.001,
      interfaceNormalGlobal: [0, 0, 1],
      prescribedDisplacementGlobalMm: [0, 0.01, 0.01],
      increments: 200,
    });
    const result = await runCodeAsterTuronCase({ workspacePath: workspace, deck: deckInput });
    return {
      solverVersion: result.solver.slice("Code_Aster ".length),
      completed: true,
      cohesiveElements: meshSummary.cohesiveElementCount as number,
      maxDamageV3: result.maxDamageV3,
      maxStateV5: result.maxStateV5,
      resultArtifactBytes: result.medBytes,
      bulkMaterial: orthotropic ? "orthotropic" : "isotropic",
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function runDocker(testCase: (typeof CASES)[number]): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  return runProcess("docker", [
    "run", "--rm", "--platform=linux/amd64", "--network=none", "--memory=2g", "--cpus=2", "--pids-limit=64", "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g,mode=1777", "--env", "HOME=/tmp/home",
    ...(testCase.image === IMAGE ? ["--user", "nobody", "--workdir", "/tmp/work"] : ["--user", "user", "--workdir", "/tmp"]),
    testCase.image, ...testCase.command(testCase.input),
  ]);
}

function runLocal(command: string, args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  return runProcess(command, args);
}

function runProcess(command: string, args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const capture = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-MAX_CAPTURE_BYTES); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, output }));
  });
}
