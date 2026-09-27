#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IMAGE = "plasticity-mcp-calculix:2.20";
const JOB = "uniaxial-patch";
const SHEAR_JOB = "pure-shear-patch";
const ORTHOTROPIC_JOB = "rotated-orthotropic-patch";
const YOUNGS_MODULUS_MPA = 2_000;
const POISSON_RATIO = 0.3;
const SHEAR_DISPLACEMENT_GRADIENT = 0.01;
const INPUT = `*HEADING
Analytical one-element uniaxial extension verification
*NODE
1,0,0,0
2,10,0,0
3,10,1,0
4,0,1,0
5,0,0,1
6,10,0,1
7,10,1,1
8,0,1,1
*ELEMENT,TYPE=C3D8,ELSET=EALL
1,1,2,3,4,5,6,7,8
*NSET,NSET=LEFT
1,4,5,8
*NSET,NSET=RIGHT
2,3,6,7
*MATERIAL,NAME=TEST
*ELASTIC
2000,0.3
*SOLID SECTION,ELSET=EALL,MATERIAL=TEST
*STEP
*STATIC
*BOUNDARY
LEFT,1,1,0.
1,2,3,0.
4,3,3,0.
RIGHT,1,1,0.5
*EL PRINT,ELSET=EALL
S
*NODE PRINT,NSET=RIGHT
U
*END STEP
`;

if (process.argv.slice(2).some((argument) => argument === "--help")) {
  console.log("Build the pinned CalculiX image first with npm run build:fem-solver, then run npm run accept:fem-solver.");
} else {
  await verify();
}

async function verify(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), "plasticity-fem-solver-acceptance-"));
  try {
    await writeFile(join(workDir, `${JOB}.inp`), INPUT, { flag: "wx", mode: 0o600 });
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
    const result = await run("docker", [
      "run", "--rm", "--network=none", "--memory=1g", "--cpus=2", "--pids-limit=64", "--read-only",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m",
      "--mount", `type=bind,src=${workDir},dst=/work`,
      "--workdir", "/work", "--user", `${uid}:${gid}`, IMAGE, "-i", JOB,
    ]);
    if (!result.stdout.includes("Job finished")) {
      throw new Error(`CalculiX did not finish the patch test: ${result.stderr.slice(-2_000)}`);
    }
    const report = await readFile(join(workDir, `${JOB}.dat`), "utf8");
    if (!/\b1\s+1\s+1\.000000E\+02\b/.test(report)) {
      throw new Error("CalculiX patch-test stress did not match the 100 MPa analytical result");
    }
    if (!/\b2\s+5\.000000E-01\b/.test(report)) {
      throw new Error("CalculiX patch-test displacement did not match the 0.5 mm analytical result");
    }
    await writeFile(join(workDir, `${SHEAR_JOB}.inp`), createPureShearPatchInput(), { flag: "wx", mode: 0o600 });
    const shearResult = await run("docker", [
      "run", "--rm", "--network=none", "--memory=1g", "--cpus=2", "--pids-limit=64", "--read-only",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m",
      "--mount", `type=bind,src=${workDir},dst=/work`,
      "--workdir", "/work", "--user", `${uid}:${gid}`, IMAGE, "-i", SHEAR_JOB,
    ]);
    if (!shearResult.stdout.includes("Job finished")) {
      throw new Error(`CalculiX pure-shear patch test did not finish: ${shearResult.stderr.slice(-2_000)}`);
    }
    const shearReport = await readFile(join(workDir, `${SHEAR_JOB}.dat`), "utf8");
    const shearStressMPa = YOUNGS_MODULUS_MPA / (2 * (1 + POISSON_RATIO)) * 2 * SHEAR_DISPLACEMENT_GRADIENT;
    const stressRows = tableRowsAfter(shearReport, "stresses (elem, integ.pnt.,sxx,syy,szz,sxy,sxz,syz)", 8);
    if (stressRows.length !== 64) throw new Error(`CalculiX pure-shear test returned ${stressRows.length} stress integration points instead of 64`);
    for (const [index, row] of stressRows.entries()) {
      assertNear(row[5]!, shearStressMPa, 1e-5, `pure-shear integration point ${index + 1} Sxy`);
      for (const component of [2, 3, 4, 6, 7]) {
        assertNear(row[component]!, 0, 1e-7, `pure-shear integration point ${index + 1} stress component ${component - 1}`);
      }
    }
    const centerNode = tableRowsAfter(shearReport, "displacements (vx,vy,vz)", 4).find((row) => row[0] === 14);
    if (!centerNode) throw new Error("CalculiX pure-shear report is missing the free center-node displacement");
    const expectedCenterDisplacement = SHEAR_DISPLACEMENT_GRADIENT * 0.5;
    assertNear(centerNode[1]!, expectedCenterDisplacement, 1e-9, "pure-shear center-node x displacement");
    assertNear(centerNode[2]!, expectedCenterDisplacement, 1e-9, "pure-shear center-node y displacement");
    assertNear(centerNode[3]!, 0, 1e-9, "pure-shear center-node z displacement");
    await writeFile(join(workDir, `${ORTHOTROPIC_JOB}.inp`), createRotatedOrthotropicPatchInput(), { flag: "wx", mode: 0o600 });
    const orthotropicResult = await run("docker", [
      "run", "--rm", "--network=none", "--memory=1g", "--cpus=2", "--pids-limit=64", "--read-only",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m",
      "--mount", `type=bind,src=${workDir},dst=/work`,
      "--workdir", "/work", "--user", `${uid}:${gid}`, IMAGE, "-i", ORTHOTROPIC_JOB,
    ]);
    if (!orthotropicResult.stdout.includes("Job finished")) {
      throw new Error(`CalculiX rotated-orthotropic patch test did not finish: ${orthotropicResult.stderr.slice(-2_000)}`);
    }
    const orthotropicReport = await readFile(join(workDir, `${ORTHOTROPIC_JOB}.dat`), "utf8");
    const orthotropicStressRows = tableRowsAfter(orthotropicReport, "stresses (elem, integ.pnt.,sxx,syy,szz,sxy,sxz,syz)", 8);
    if (orthotropicStressRows.length !== 8) {
      const start = orthotropicReport.indexOf("stresses (elem, integ.pnt.,sxx,syy,szz,sxy,sxz,syz)");
      throw new Error(`CalculiX orthotropic test returned ${orthotropicStressRows.length} C3D8 integration points instead of 8: ${orthotropicReport.slice(start, start + 1_000)}`);
    }
    for (const [index, row] of orthotropicStressRows.entries()) {
      assertNear(row[2]!, 20, 1e-5, `rotated orthotropic integration point ${index + 1} material-axis S11`);
      for (const component of [3, 4, 5, 6, 7]) {
        assertNear(row[component]!, 0, 1e-7, `rotated orthotropic integration point ${index + 1} material stress component ${component - 2}`);
      }
    }
    const orthotropicRightDisplacements = tableRowsAfter(orthotropicReport, "displacements (vx,vy,vz)", 4).filter((row) => [3, 4, 7, 8].includes(row[0]!));
    if (orthotropicRightDisplacements.length !== 4) throw new Error("CalculiX orthotropic report is missing right-face displacements");
    for (const [index, row] of orthotropicRightDisplacements.entries()) {
      assertNear(row[2]!, 0.1, 1e-9, `rotated orthotropic right-node ${index + 1} global Y displacement`);
    }
    console.log(JSON.stringify({
      ok: true,
      solver: "CalculiX 2.20",
      element: "C3D8",
      expectedStressMPa: 100,
      expectedDisplacementMm: 0.5,
      pureShear: {
        expectedSxyMPa: shearStressMPa,
        checkedIntegrationPoints: stressRows.length,
        expectedCenterDisplacementMm: [expectedCenterDisplacement, expectedCenterDisplacement, 0],
      },
      rotatedOrthotropic: {
        expectedMaterialAxis1StressMPa: 20,
        checkedIntegrationPoints: orthotropicStressRows.length,
        expectedRightFaceDisplacementMm: 0.1,
        materialAxis1GlobalDirection: [0, 1, 0],
      },
      containerNetwork: "disabled",
      evidence: "uniaxial extension, affine pure-shear, and rotated orthotropic patch tests",
    }, null, 2));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function createPureShearPatchInput(): string {
  const nodeId = (i: number, j: number, k: number): number => 1 + i + 3 * j + 9 * k;
  const nodes: string[] = [];
  const boundary: string[] = [];
  for (let k = 0; k <= 2; k += 1) {
    for (let j = 0; j <= 2; j += 1) {
      for (let i = 0; i <= 2; i += 1) {
        const id = nodeId(i, j, k);
        const x = i * 0.5;
        const y = j * 0.5;
        const z = k * 0.5;
        nodes.push(`${id}, ${x}, ${y}, ${z}`);
        if (i !== 1 || j !== 1 || k !== 1) {
          boundary.push(`${id}, 1, 1, ${SHEAR_DISPLACEMENT_GRADIENT * y}`);
          boundary.push(`${id}, 2, 2, ${SHEAR_DISPLACEMENT_GRADIENT * x}`);
          boundary.push(`${id}, 3, 3, 0.`);
        }
      }
    }
  }
  const elements: string[] = [];
  let elementId = 1;
  for (let k = 0; k < 2; k += 1) {
    for (let j = 0; j < 2; j += 1) {
      for (let i = 0; i < 2; i += 1) {
        elements.push(`${elementId}, ${nodeId(i, j, k)}, ${nodeId(i + 1, j, k)}, ${nodeId(i + 1, j + 1, k)}, ${nodeId(i, j + 1, k)}, ${nodeId(i, j, k + 1)}, ${nodeId(i + 1, j, k + 1)}, ${nodeId(i + 1, j + 1, k + 1)}, ${nodeId(i, j + 1, k + 1)}`);
        elementId += 1;
      }
    }
  }
  return `*HEADING
Analytical affine pure-shear patch verification
*NODE
${nodes.join("\n")}
*ELEMENT,TYPE=C3D8,ELSET=EALL
${elements.join("\n")}
*NSET,NSET=ALL_NODES,GENERATE
1, 27, 1
*MATERIAL,NAME=TEST
*ELASTIC
${YOUNGS_MODULUS_MPA}, ${POISSON_RATIO}
*SOLID SECTION,ELSET=EALL,MATERIAL=TEST
*STEP
*STATIC
*BOUNDARY
${boundary.join("\n")}
*EL PRINT,ELSET=EALL
S
*NODE PRINT,NSET=ALL_NODES
U
*END STEP
`;
}

function createRotatedOrthotropicPatchInput(): string {
  return `*HEADING
Analytical rotated orthotropic uniaxial patch verification
*NODE
1, 0, 0, 0
2, 1, 0, 0
3, 1, 10, 0
4, 0, 10, 0
5, 0, 0, 1
6, 1, 0, 1
7, 1, 10, 1
8, 0, 10, 1
*ELEMENT,TYPE=C3D8,ELSET=EALL
1, 1, 2, 3, 4, 5, 6, 7, 8
*NSET,NSET=LEFT
1, 2, 5, 6
*NSET,NSET=RIGHT
3, 4, 7, 8
*ORIENTATION,NAME=PRINT_AXES,SYSTEM=RECTANGULAR
0, 1, 0, 1, 1, 0
*MATERIAL,NAME=TEST
*ELASTIC,TYPE=ENGINEERING CONSTANTS
2000, 1000, 500, 0, 0, 0, 250, 150
100
*SOLID SECTION,ELSET=EALL,MATERIAL=TEST,ORIENTATION=PRINT_AXES
*STEP
*STATIC
*BOUNDARY
LEFT,2,2,0
1,1,1,0
1,3,3,0
2,3,3,0
RIGHT,2,2,0.1
*EL PRINT,ELSET=EALL
S
*NODE PRINT,NSET=RIGHT
U
*END STEP
`;
}

function tableRowsAfter(report: string, header: string, width: number): number[][] {
  const headerIndex = report.indexOf(header);
  if (headerIndex < 0) throw new Error(`CalculiX report is missing ${header}`);
  const rows: number[][] = [];
  for (const line of report.slice(headerIndex + header.length).split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/);
    const values = tokens.slice(0, width).map(Number);
    if (tokens.length >= width && values.every(Number.isFinite)) rows.push(values);
  }
  return rows;
}

function assertNear(actual: number, expected: number, tolerance: number, description: string): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${description} was ${actual}; expected ${expected} ± ${tolerance}`);
  }
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const maxBytes = 64 * 1024;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, 120_000);
    timeout.unref();
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-maxBytes); });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-maxBytes); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Command failed (${signal ?? code}): ${stderr.slice(-2_000)}`));
    });
  });
}
