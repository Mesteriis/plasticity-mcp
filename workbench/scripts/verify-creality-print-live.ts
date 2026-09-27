#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { discoverManufacturingProfiles } from "../src/server/manufacturing/profile-registry.ts";
import { CrealityPrintSlicer } from "../src/server/manufacturing/slicer.ts";

export interface CrealityPrintLiveOptions {
  help: boolean;
  input?: string;
  output?: string;
  executable?: string;
  resourcesRoot?: string;
}

export function parseCrealityPrintLiveArgs(argv: string[], environment: NodeJS.ProcessEnv = process.env): CrealityPrintLiveOptions {
  const options: CrealityPrintLiveOptions = {
    help: argv.length === 0,
    ...(environment.CREALITY_PRINT_EXECUTABLE ? { executable: environment.CREALITY_PRINT_EXECUTABLE } : {}),
    ...(environment.CREALITY_PRINT_RESOURCES_ROOT ? { resourcesRoot: environment.CREALITY_PRINT_RESOURCES_ROOT } : {}),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--input" || argument === "--output" || argument === "--executable" || argument === "--resources-root") {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a path`);
      if (argument === "--input") options.input = value;
      else if (argument === "--output") options.output = value;
      else if (argument === "--executable") options.executable = value;
      else options.resourcesRoot = value;
    } else throw new Error(`Unknown argument: ${String(argument)}`);
  }
  if (options.help) return options;
  if (!options.input || !options.output || !options.executable || !options.resourcesRoot) {
    throw new Error("Live Creality Print acceptance requires --input, --output, --executable, and --resources-root (or the matching CREALITY_PRINT_* environment variables)");
  }
  return options;
}

const HELP = `Usage:
  node workbench/scripts/verify-creality-print-live.ts --help
  node workbench/scripts/verify-creality-print-live.ts --input NATIVE_EXPORT.stl --output NEW_DIRECTORY --executable /path/to/CrealityPrint --resources-root /path/to/CrealityPrint.app/Contents/Resources

The input must be a new STL exported by Plasticity. The selected K1C profiles,
CLI data, and G-code are isolated under the new output directory. No printer is
contacted and no print is started.`;

async function main(): Promise<void> {
  const options = parseCrealityPrintLiveArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const input = resolve(options.input!);
  const output = resolve(options.output!);
  const executable = resolve(options.executable!);
  const resourcesRoot = resolve(options.resourcesRoot!);
  if (basename(input).toLowerCase().endsWith(".stl") === false) throw new Error("Live Creality Print acceptance requires a Plasticity-exported STL");
  await Promise.all([access(input), access(executable)]);
  const inputStats = await stat(input);
  if (!inputStats.isFile() || inputStats.size === 0) throw new Error("STL input must be a nonempty file");
  await mkdir(output, { recursive: false, mode: 0o700 });
  const catalog = await discoverManufacturingProfiles({
    crealityProfilesRoot: join(resourcesRoot, "profiles", "Creality"),
    crealityExecutable: executable,
    resolvedProfilesRoot: join(output, "resolved-profiles"),
  });
  const adapter = catalog.adapters.find((candidate) => candidate.id === "creality-print");
  if (!adapter?.available) throw new Error("The selected Creality Print executable or K1C profile files are incomplete");
  const profile = catalog.profiles.find((candidate) => candidate.slicer.slicer === "creality-print" && candidate.printer.model.toLowerCase().includes("k1c"));
  if (!profile) throw new Error("No compatible installed Creality K1C profile was discovered");

  const jobDirectory = join(output, "job");
  const result = await new CrealityPrintSlicer(executable).slice(input, basename(input), profile, jobDirectory);
  const gcodeHash = createHash("sha256").update(result.gcode).digest("hex");
  const summary = result.summary;
  if (summary.layers === undefined || summary.layers <= 0) throw new Error("Creality Print G-code is missing a positive layer count");
  if (!summary.boundsMm) throw new Error("Creality Print G-code does not report toolpath bounds");
  const actualSize = summary.boundsMm.max.map((value, axis) => value - summary.boundsMm!.min[axis]!);
  const expectedSize = [20, 10, 5];
  actualSize.forEach((value, axis) => {
    if (Math.abs(value - expectedSize[axis]!) > 0.02) throw new Error(`Sliced test box axis ${axis} measured ${value} mm; expected ${expectedSize[axis]} mm ± 0.02 mm`);
  });
  const outputPath = join(output, "evidence.json");
  const evidence = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    executable,
    executableArchitecture: process.arch,
    input: { path: input, bytes: inputStats.size, sha256: createHash("sha256").update(await readFile(input)).digest("hex") },
    profile: { printer: profile.printer, material: profile.material, slicer: profile.slicer },
    result: {
      path: join(jobDirectory, "output", result.filename),
      bytes: result.gcode.byteLength,
      sha256: gcodeHash,
      summary,
      measuredBoundsSizeMm: actualSize,
    },
    printerContacted: false,
    printStarted: false,
    completedAt: new Date().toISOString(),
  };
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ok: true, evidence: outputPath, gcode: evidence.result.path, layers: summary.layers, boundsSizeMm: actualSize }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error((error instanceof Error ? error.message : String(error)).slice(0, 4000)); process.exitCode = 1; });
}
