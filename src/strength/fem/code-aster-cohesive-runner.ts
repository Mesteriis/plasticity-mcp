import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { buildCodeAsterCohesiveDeck, type CodeAsterCohesiveDeckInput } from "./code-aster-cohesive-deck.ts";
import { assessCohesiveMeshResolution, type CohesiveMeshResolutionAssessment } from "./cohesive-mesh-resolution.ts";
import { parseCodeAsterCohesiveResults, type CodeAsterCohesiveResults } from "./code-aster-cohesive-results.ts";

const CODE_ASTER_IMAGE = "scimulate/code_aster:15.2@sha256:b4a2bf82ef4c52a719187bb6b3c7f6d0ac512da7a66a8bada4bf0c857b104810";
const CODE_ASTER_17_IMAGE = "simvia/code_aster@sha256:d8d19ea91989eac0d38195bc5795c54c69f530f7196f53d67697ffa57c9106d5";
const ASTER_17 = "/opt/spack/opt/spack/linux-zen2/code-aster-17.4.0-ecm2bfgr5obydotnlte6xilvggppqnap";
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const MAX_INTERFACE_STATE_ROWS = 500_000;
const SOLVER_TIMEOUT_MS = 10 * 60 * 1000;

export interface RunCodeAsterCohesiveCaseRequest {
  workspacePath: string;
  deck: CodeAsterCohesiveDeckInput;
  signal?: AbortSignal;
}

export interface RunCodeAsterCohesiveCaseResult {
  solver: "Code_Aster 15.2.0" | "Code_Aster 17.4.0";
  imageDigest: string;
  result: CodeAsterCohesiveResults;
  meshResolution: CohesiveMeshResolutionAssessment;
  limitations: string[];
  diagnostics: string[];
}

export async function runCodeAsterCohesiveCase(request: RunCodeAsterCohesiveCaseRequest): Promise<RunCodeAsterCohesiveCaseResult> {
  if (request.signal?.aborted) throw new Error("Code_Aster cohesive job was cancelled before start");
  const workspace = await realpath(resolve(request.workspacePath));
  const meshPath = join(workspace, "cohesive.msh");
  const actualMeshPath = await realpath(meshPath);
  if (dirname(actualMeshPath) !== workspace) throw new Error("Cohesive mesh must be a regular file directly inside the job workspace");
  await access(actualMeshPath, constants.R_OK);
  await access(workspace, constants.W_OK);
  if (/[:,]/.test(workspace)) throw new Error("Code_Aster workspace path must not contain Docker mount delimiters ':' or ','");

  const deck = buildCodeAsterCohesiveDeck(request.deck);
  const meshText = await readFile(actualMeshPath, "utf8");
  const cohesiveElementIds = readCohesiveElementIds(meshText);
  const meshResolution = assessCohesiveMeshResolution(meshText, request.deck, request.deck.modeI);
  assertCohesiveResultTableSize(cohesiveElementIds.length, request.deck.increments);
  const generatedFiles = ["cohesive.comm", "cohesive.export", "result1.txt", "result2.txt", "result3.txt"];
  for (const file of generatedFiles) {
    try {
      await access(join(workspace, file));
      throw new Error(`Refusing to overwrite existing cohesive solver artifact: ${file}`);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  await writeFile(join(workspace, "cohesive.comm"), deck.commandFile, { flag: "wx", mode: 0o600 });
  await writeFile(join(workspace, "cohesive.export"), deck.exportFile, { flag: "wx", mode: 0o600 });
  const solverVersion = request.deck.orthotropicMaterialA ? "17.4" : "15.2";
  const processOutput = await executeDocker(workspace, solverVersion, request.signal);
  assertCodeAsterCohesiveRunSucceeded(processOutput.code, processOutput.stdout, processOutput.stderr);
  const [displacementTable, reactionTable, stateVariableTable] = await Promise.all([
    readGeneratedResult(workspace, "result1.txt"),
    readGeneratedResult(workspace, "result2.txt"),
    readGeneratedResult(workspace, "result3.txt"),
  ]);
  const result = parseCodeAsterCohesiveResults({
    displacementTable, reactionTable, stateVariableTable, cohesiveElementIds,
    displacementComponent: deck.displacementComponent,
    displacementScale: deck.displacementScale,
    allowSolverRenumberedElementIds: solverVersion === "17.4",
    modeILaw: deck.modeILaw,
  });
  const expectedResultVersion = solverVersion === "17.4" ? "17.04.00" : "15.02.00";
  if (result.solverVersion !== expectedResultVersion) throw new Error(`Expected Code_Aster ${solverVersion} result tables; received ${result.solverVersion}`);
  return {
    solver: solverVersion === "17.4" ? "Code_Aster 17.4.0" : "Code_Aster 15.2.0",
    imageDigest: (solverVersion === "17.4" ? CODE_ASTER_17_IMAGE : CODE_ASTER_IMAGE).split("@")[1]!,
    result,
    meshResolution,
    limitations: [
      ...deck.limitations,
      ...(meshResolution.status === "below-indicative-five-element-screen"
        ? ["The interface mesh falls below the indicative five-element process-zone screening estimate for at least one adjoining material; refine and validate convergence before interpreting this solver response."]
        : []),
    ],
    diagnostics: `${processOutput.stdout}\n${processOutput.stderr}`.split(/\r?\n/).filter((line) => /<A>_/.test(line)).slice(-20),
  };
}

export function assertCohesiveResultTableSize(elementCount: number, increments: number): void {
  if (!Number.isSafeInteger(elementCount) || elementCount < 1
    || !Number.isSafeInteger(increments) || increments < 2 || increments > 250
    || elementCount * (4 * increments + 1) > MAX_INTERFACE_STATE_ROWS) {
    throw new Error(`Cohesive state output would be too large; the solver is capped at ${MAX_INTERFACE_STATE_ROWS} element/increment rows`);
  }
}

export function assertCodeAsterCohesiveRunSucceeded(exitCode: number | null, stdout: string, stderr: string): void {
  const output = `${stdout}\n${stderr}`;
  if (exitCode !== 0) throw new Error(`Code_Aster container exited with code ${exitCode ?? "unknown"}: ${failureDiagnostic(output)}`);
  const exitCodes = [...output.matchAll(/EXECUTION_CODE_ASTER_EXIT_\d+=(\d+)/g)].map((match) => match[1]);
  if (exitCodes.length === 0) throw new Error("Code_Aster output is missing the solver success marker");
  if (exitCodes.at(-1) !== "0") throw new Error(`Code_Aster reported exit code ${exitCodes.at(-1)}`);
  if (/<(?:F|S)>_/i.test(output)) throw new Error("Code_Aster output contains a fatal or severe diagnostic");
}

function failureDiagnostic(output: string): string {
  const lines = output.split(/\r?\n/);
  const matches = lines.flatMap((line, index) => /<(?:F|S)>_|ERREUR|NO_CONVERGENCE|ABNORMAL_ABORT|EXECUTION_CODE_ASTER_EXIT/i.test(line) ? [index] : []);
  const selected = new Set<number>();
  for (const index of matches) {
    for (let nearby = Math.max(0, index - 3); nearby <= Math.min(lines.length - 1, index + 4); nearby += 1) selected.add(nearby);
  }
  const excerpt = [...selected].sort((left, right) => left - right).map((index) => lines[index]!).join("\n");
  return (excerpt || output.slice(-4_000)).slice(-8_000);
}

async function executeDocker(workspace: string, solverVersion: "15.2" | "17.4", signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (signal?.aborted) throw new Error("Code_Aster cohesive job was cancelled before start");
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  return await new Promise((resolveJob, reject) => {
    const child = spawn("docker", buildCodeAsterDockerArgs(workspace, uid, gid, solverVersion), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const terminate = () => {
      child.kill("SIGTERM");
      const forceKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceKill.unref();
    };
    const abort = () => terminate();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; terminate(); }, SOLVER_TIMEOUT_MS);
    timeout.unref();
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-MAX_CAPTURE_BYTES); });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-MAX_CAPTURE_BYTES); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new Error("Code_Aster cohesive job was cancelled"));
      else if (timedOut) reject(new Error("Code_Aster cohesive job timed out"));
      else resolveJob({ code, stdout, stderr });
    });
  });
}

export function buildCodeAsterDockerArgs(workspace: string, uid: number, gid: number, solverVersion: "15.2" | "17.4" = "15.2"): string[] {
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0 || /[:,]/.test(workspace)) {
    throw new Error("Code_Aster container identity or workspace path is invalid");
  }
  const common = [
    "run", "--rm", "--platform=linux/amd64", "--network=none", "--memory=2g", "--cpus=2", "--pids-limit=64", "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777", "--env", "HOME=/tmp/home", "--env", "LOGNAME=aster", "--env", "USER=aster",
    "--user", `${uid}:${gid}`, "--mount", `type=bind,src=${workspace},dst=/tmp/work`, "--workdir", "/tmp/work",
  ];
  return solverVersion === "17.4"
    ? [...common, CODE_ASTER_17_IMAGE, "/bin/bash", "-lc", `source /opt/activate.sh && mkdir -p /tmp/home /tmp/mplconfig && ${ASTER_17}/bin/run_aster cohesive.export`]
    : [...common, CODE_ASTER_IMAGE, "/opt/aster/15.2/bin/run_aster", "cohesive.export"];
}

async function readGeneratedResult(workspace: string, filename: string): Promise<string> {
  const path = await realpath(join(workspace, filename));
  if (dirname(path) !== workspace || relative(workspace, path).startsWith(`..${sep}`)) {
    throw new Error(`Code_Aster result escaped the workspace: ${filename}`);
  }
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > 128 * 1024 * 1024) throw new Error(`Code_Aster result is not a supported regular file or exceeds 128 MiB: ${filename}`);
  return await readFile(path, "utf8");
}

function readCohesiveElementIds(meshText: string): number[] {
  const lines = meshText.split(/\r?\n/);
  const start = lines.indexOf("$Elements");
  if (start < 0) throw new Error("Code_Aster cohesive mesh is missing its Gmsh element section");
  const count = Number(lines[start + 1]);
  if (!Number.isSafeInteger(count) || count < 1 || start + count + 2 > lines.length) {
    throw new Error("Code_Aster cohesive mesh has an invalid element count");
  }
  const elementIds: number[] = [];
  for (const line of lines.slice(start + 2, start + 2 + count)) {
    const fields = line.trim().split(/\s+/);
    if (fields[1] !== "6") continue;
    const elementId = Number(fields[0]);
    if (!Number.isSafeInteger(elementId) || elementId <= 0) throw new Error("Cohesive mesh contains an invalid PENTA6 element ID");
    elementIds.push(elementId);
  }
  if (elementIds.length === 0 || new Set(elementIds).size !== elementIds.length) {
    throw new Error("Cohesive mesh must contain unique PENTA6 interface elements");
  }
  return elementIds;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
