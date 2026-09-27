import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { buildCodeAsterTuronDeck, type CodeAsterTuronDeckInput } from "./code-aster-turon-deck.ts";

const CODE_ASTER_17_IMAGE = "simvia/code_aster@sha256:d8d19ea91989eac0d38195bc5795c54c69f530f7196f53d67697ffa57c9106d5";
const ASTER_17 = "/opt/spack/opt/spack/linux-zen2/code-aster-17.4.0-ecm2bfgr5obydotnlte6xilvggppqnap";
const MED_VERIFIER = new URL("../../../scripts/fem/verify-turon-damage-med.py", import.meta.url);
const SOLVER_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_MED_BYTES = 128 * 1024 * 1024;
const MAX_DAMAGE_STEPS = 1_001;
const MAX_ELEMENT_STEP_ROWS = 500_000;

export interface RunCodeAsterTuronCaseRequest {
  workspacePath: string;
  deck: CodeAsterTuronDeckInput;
  signal?: AbortSignal;
}

export interface CodeAsterTuronDamageSnapshot {
  order: number;
  time: number;
  maxDamageV3: number;
  maxStateV5: number;
}

export interface RunCodeAsterTuronCaseResult {
  solver: "Code_Aster 17.4.0";
  imageDigest: string;
  finalTime: number;
  maxDamageV3: number;
  maxStateV5: number;
  damageHistory: CodeAsterTuronDamageSnapshot[];
  medSha256: string;
  medBytes: number;
  interpretation: "raw-mixed-mode-cohesive-solver-response";
  limitations: string[];
  diagnostics: string[];
}

export async function runCodeAsterTuronCase(
  request: RunCodeAsterTuronCaseRequest,
): Promise<RunCodeAsterTuronCaseResult> {
  if (request.signal?.aborted) throw new Error("Code_Aster Turon job was cancelled before start");
  const workspace = await realpath(resolve(request.workspacePath));
  if (/[:,]/.test(workspace)) throw new Error("Code_Aster workspace path must not contain Docker mount delimiters ':' or ','");

  const meshPath = await realpath(join(workspace, "cohesive.msh"));
  if (dirname(meshPath) !== workspace) throw new Error("Cohesive mesh must be a regular file directly inside the job workspace");
  await access(meshPath, constants.R_OK);
  await access(workspace, constants.W_OK);
  const meshStat = await stat(meshPath);
  if (!meshStat.isFile() || meshStat.size < 100 || meshStat.size > 64 * 1024 * 1024) {
    throw new Error("Cohesive mesh must be a regular file between 100 bytes and 64 MiB");
  }
  const meshText = await readFile(meshPath, "utf8");
  const cohesiveElementCount = countPenta6(meshText);
  if (cohesiveElementCount * (request.deck.increments + 1) > MAX_ELEMENT_STEP_ROWS) {
    throw new Error(`Cohesive state output would exceed ${MAX_ELEMENT_STEP_ROWS} element/step rows`);
  }

  const deck = buildCodeAsterTuronDeck(request.deck);
  const verifierPath = join(workspace, "verify-turon-damage-med.py");
  const commandPath = join(workspace, "turon3d.comm");
  const exportPath = join(workspace, "turon3d.export");
  const medPath = join(workspace, "result.med");
  await ensureDoesNotExist([verifierPath, commandPath, exportPath, medPath]);
  await Promise.all([
    copyFile(MED_VERIFIER.pathname, verifierPath, constants.COPYFILE_EXCL),
    writeFile(commandPath, deck.commandFile, { flag: "wx", mode: 0o600 }),
    writeFile(exportPath, deck.exportFile, { flag: "wx", mode: 0o600 }),
  ]);

  const processOutput = await executeDocker(workspace, request.signal);
  assertSuccessful(processOutput.code, processOutput.output);
  const medStat = await stat(medPath);
  if (!medStat.isFile() || medStat.size < 1_000 || medStat.size > MAX_MED_BYTES) {
    throw new Error(`Code_Aster 17.4 MED result must be a regular file between 1,000 bytes and ${MAX_MED_BYTES} bytes`);
  }
  const marker = processOutput.output.match(/TURON_DAMAGE_ACCEPTANCE=(\{[^\n]+\})/)?.[1];
  if (!marker) throw new Error("Code_Aster Turon result is missing the MED-derived damage history");
  const summary = parseCodeAsterTuronDamageSummary(JSON.parse(marker));
  const medBytes = await readFile(medPath);
  return {
    solver: "Code_Aster 17.4.0",
    imageDigest: CODE_ASTER_17_IMAGE.split("@")[1]!,
    finalTime: summary.finalTime,
    maxDamageV3: summary.maxDamageV3,
    maxStateV5: summary.maxStateV5,
    damageHistory: summary.damageHistory,
    medSha256: createHash("sha256").update(medBytes).digest("hex"),
    medBytes: medStat.size,
    interpretation: "raw-mixed-mode-cohesive-solver-response",
    limitations: deck.limitations,
    diagnostics: processOutput.output.split(/\r?\n/).filter((line) => /<A>_/.test(line)).slice(-20),
  };
}

async function ensureDoesNotExist(paths: string[]): Promise<void> {
  for (const path of paths) {
    try {
      await access(path);
      throw new Error(`Refusing to overwrite existing Turon solver artifact: ${path}`);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
}

function countPenta6(meshText: string): number {
  const lines = meshText.split(/\r?\n/);
  const start = lines.indexOf("$Elements");
  const end = lines.indexOf("$EndElements", start + 1);
  if (start < 0 || end <= start + 1) throw new Error("Cohesive mesh is missing its Gmsh element section");
  const count = Number(lines[start + 1]);
  const elements = lines.slice(start + 2, end);
  if (!Number.isSafeInteger(count) || count < 1 || elements.length !== count) {
    throw new Error("Cohesive mesh has an invalid Gmsh element count");
  }
  let cohesiveElements = 0;
  for (const line of elements) {
    const fields = line.trim().split(/\s+/);
    if (fields[1] !== "6") continue;
    const tagCount = Number(fields[2]);
    const id = Number(fields[0]);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(tagCount) || tagCount < 0
      || fields.length !== 3 + tagCount + 6) {
      throw new Error("Cohesive mesh contains a malformed PENTA6 element");
    }
    cohesiveElements += 1;
  }
  if (cohesiveElements < 1 || cohesiveElements > 500_000) throw new Error("Cohesive mesh must contain between 1 and 500,000 PENTA6 interface elements");
  return cohesiveElements;
}

export function parseCodeAsterTuronDamageSummary(value: unknown): {
  finalTime: number;
  maxDamageV3: number;
  maxStateV5: number;
  damageHistory: CodeAsterTuronDamageSnapshot[];
} {
  if (!isRecord(value) || !Array.isArray(value.damageHistory) || value.damageHistory.length < 2
    || value.damageHistory.length > MAX_DAMAGE_STEPS) {
    throw new Error("MED-derived Turon damage history has an invalid shape or step count");
  }
  const history: CodeAsterTuronDamageSnapshot[] = [];
  for (const [index, entry] of value.damageHistory.entries()) {
    if (!isRecord(entry) || !Number.isSafeInteger(entry.order) || !Number.isFinite(entry.time)
      || !Number.isFinite(entry.maxDamageV3) || !Number.isFinite(entry.maxStateV5)
      || (entry.maxDamageV3 as number) < -1e-8 || (entry.maxDamageV3 as number) > 1.000001
      || (entry.maxStateV5 as number) < -1e-8 || (entry.maxStateV5 as number) > 2.000001) {
      throw new Error(`MED-derived Turon damage entry ${index} contains invalid values`);
    }
    const snapshot = {
      order: entry.order as number,
      time: entry.time as number,
      maxDamageV3: entry.maxDamageV3 as number,
      maxStateV5: entry.maxStateV5 as number,
    };
    const previous = history.at(-1);
    if (previous && snapshot.order <= previous.order) {
      throw new Error("MED-derived Turon damage orders must increase strictly");
    }
    if (previous && snapshot.time < previous.time) {
      throw new Error("MED-derived Turon damage times must be nondecreasing");
    }
    history.push(snapshot);
  }
  const final = history.at(-1)!;
  if (final.maxDamageV3 <= 1e-6 || final.maxStateV5 < 1 || final.time < 1 - 1e-6) {
    throw new Error("MED-derived Turon response did not reach the requested final time with interface damage");
  }
  return { finalTime: final.time, maxDamageV3: final.maxDamageV3, maxStateV5: final.maxStateV5, damageHistory: history };
}

function assertSuccessful(exitCode: number | null, output: string): void {
  if (exitCode !== 0) throw new Error(`Code_Aster 17.4 container exited with code ${exitCode ?? "unknown"}: ${output.slice(-4_000)}`);
  if (/<(?:F|S)>_/i.test(output) || /<S>_NO_CONVERGENCE/.test(output)) {
    throw new Error(`Code_Aster 17.4 Turon run contains a severe diagnostic or non-convergence: ${output.slice(-4_000)}`);
  }
  if (!/EXECUTION_CODE_ASTER_EXIT_\d+=0/.test(output)) throw new Error("Code_Aster 17.4 output is missing its solver success marker");
}

async function executeDocker(workspace: string, signal?: AbortSignal): Promise<{ code: number | null; output: string }> {
  if (signal?.aborted) throw new Error("Code_Aster Turon job was cancelled before start");
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  return await new Promise((resolveJob, reject) => {
    const child = spawn("docker", [
      "run", "--rm", "--platform=linux/amd64", "--network=none", "--memory=2g", "--cpus=2", "--pids-limit=64", "--read-only",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=1g,mode=1777", "--env", "HOME=/tmp/home", "--env", "LOGNAME=aster", "--env", "USER=aster",
      "--user", `${uid}:${gid}`, "--mount", `type=bind,src=${workspace},dst=/tmp/work`, "--workdir", "/tmp/work", CODE_ASTER_17_IMAGE,
      "/bin/bash", "-lc", `source /opt/activate.sh && mkdir -p /tmp/home /tmp/mplconfig && ${ASTER_17}/bin/run_aster turon3d.export && python3 verify-turon-damage-med.py result.med`,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const terminate = () => {
      child.kill("SIGTERM");
      const forceKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceKill.unref();
    };
    const abort = () => terminate();
    const timeout = setTimeout(() => { timedOut = true; terminate(); }, SOLVER_TIMEOUT_MS);
    timeout.unref();
    const capture = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-MAX_CAPTURE_BYTES); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new Error("Code_Aster Turon job was cancelled"));
      else if (timedOut) reject(new Error("Code_Aster Turon job timed out"));
      else resolveJob({ code, output });
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
