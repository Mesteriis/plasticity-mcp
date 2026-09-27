import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import type { ManufacturingProfile, ManufacturingProfileRecord } from "../../shared/contracts.ts";

export interface ProfileRegistryOptions {
  crealityProfilesRoot?: string;
  crealityExecutable?: string;
  deviceInfoPath?: string;
  bambuStudioResourcesRoot?: string;
  bambuStudioExecutable?: string;
  orcaSlicerResourcesRoot?: string;
  orcaSlicerExecutable?: string;
  resolvedProfilesRoot?: string;
}

export interface ManufacturingProfileCatalog {
  profiles: ManufacturingProfile[];
  records: ManufacturingProfileRecord[];
  adapters: Array<{ id: "creality-print" | "orca-slicer" | "bambu-studio"; available: boolean; executable?: string }>;
}

const DEFAULT_CREality_ROOT = "/Applications/Creality Print.app/Contents/Resources/profiles/Creality";
const DEFAULT_CREality_EXECUTABLE = "/Applications/Creality Print.app/Contents/MacOS/CrealityPrint";
const APPLE_SILICON_CREality_ROOT = "/Applications/Creality Print (Apple Silicon).app/Contents/Resources/profiles/Creality";
const APPLE_SILICON_CREality_EXECUTABLE = "/Applications/Creality Print (Apple Silicon).app/Contents/MacOS/CrealityPrint";
const DEFAULT_BAMBU_RESOURCES = "/Applications/BambuStudio.app/Contents/Resources";
const DEFAULT_BAMBU_EXECUTABLE = "/Applications/BambuStudio.app/Contents/MacOS/BambuStudio";
const DEFAULT_ORCA_RESOURCES = "/Applications/OrcaSlicer.app/Contents/Resources";
const DEFAULT_ORCA_EXECUTABLE = "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer";

export async function discoverManufacturingProfiles(options: ProfileRegistryOptions = {}): Promise<ManufacturingProfileCatalog> {
  const crealityCandidates = options.crealityProfilesRoot || options.crealityExecutable
    ? [{ root: options.crealityProfilesRoot ?? DEFAULT_CREality_ROOT, executable: options.crealityExecutable ?? DEFAULT_CREality_EXECUTABLE }]
    : process.arch === "arm64"
      ? [
          { root: APPLE_SILICON_CREality_ROOT, executable: APPLE_SILICON_CREality_EXECUTABLE },
          { root: DEFAULT_CREality_ROOT, executable: DEFAULT_CREality_EXECUTABLE },
        ]
      : [{ root: DEFAULT_CREality_ROOT, executable: DEFAULT_CREality_EXECUTABLE }];
  const selectedCreality = await firstAvailable(crealityCandidates);
  const root = selectedCreality?.root ?? crealityCandidates[0]!.root;
  const executable = selectedCreality?.executable ?? crealityCandidates[0]!.executable;
  const machine = join(root, "machine", "Creality K1C 0.4 nozzle.json");
  const processProfile = join(root, "process", "0.20mm Standard @Creality K1C 0.4 nozzle.json");
  const crealityAvailable = await allExist([executable, machine, processProfile]);
  const profiles: ManufacturingProfile[] = [];

  if (crealityAvailable) {
    const [machineJson, processJson, filamentJson] = await Promise.all([
      readJson(machine), readJson(processProfile), readJson(join(root, "filament", "Generic PLA @Creality K1C 0.4 nozzle.json")).catch(() => undefined),
    ]);
    const host = options.deviceInfoPath ? await findK1cHost(options.deviceInfoPath) : undefined;
    const machineName = stringValue(machineJson, "name", machine.slice(machine.lastIndexOf("/") + 1, -".json".length));
    const processName = stringValue(processJson, "name", "0.20mm Standard");
    const filamentCandidates = await compatibleCrealityFilaments(root, machineName, machineJson.default_filament_profile);
    if (!filamentCandidates.length && filamentJson) {
      filamentCandidates.push({
        name: stringValue(filamentJson, "name", "Generic PLA"),
        path: join(root, "filament", "Generic PLA @Creality K1C 0.4 nozzle.json"),
        config: filamentJson,
      });
    }

    for (const candidate of filamentCandidates) {
      const materialName = candidate.name.replace(` @${machineName}`, "");
      const nominalInfillPercent = optionalPercentValue(processJson, "sparse_infill_density");
      const processStructure = extractProcessStructure(processJson);
      profiles.push({
        printer: {
          id: "creality-k1c-0.4",
          vendor: "Creality",
          model: stringValue(machineJson, "printer_model", "Creality K1C"),
          buildVolumeMm: [
            printableExtent(machineJson, 0, 220),
            printableExtent(machineJson, 1, 220),
            numberValue(machineJson, "printable_height", 250),
          ],
          nozzleDiameterMm: firstNumber(machineJson.nozzle_diameter, 0.4),
          nozzleMaterial: stringValue(machineJson, "nozzle_type", "brass"),
          connection: { kind: "moonraker", ...(host ? { host, port: 7125 } : {}) },
          source: host ? "verified-device" : "installed-slicer",
        },
        material: {
          id: `creality-k1c-0.4:${slug(materialName)}`,
          name: materialName,
          type: firstString(candidate.config.filament_type, "PLA"),
          vendor: firstString(candidate.config.filament_vendor, "Creality"),
          nozzleTemperatureC: numberValue(candidate.config, "nozzle_temperature", 220),
          bedTemperatureC: numberValue(candidate.config, "hot_plate_temp", 50),
          densityGcm3: numberValue(candidate.config, "filament_density", 1.25),
          maxVolumetricSpeedMm3s: numberValue(candidate.config, "filament_max_volumetric_speed", 14),
          source: "installed-slicer",
        },
        slicer: {
          id: `creality-print-k1c-0.20-standard:${slug(materialName)}`,
          slicer: "creality-print",
          name: processName,
          layerHeightMm: numberValue(processJson, "layer_height", 0.2),
          ...(nominalInfillPercent === undefined ? {} : { nominalInfillPercent }),
          ...processStructure,
          qualityTarget: inferQualityTarget(processName),
          supportsEnabled: booleanValue(processJson, "enable_support"),
          dimensionalScalePercent: percentValue(candidate.config, "filament_shrink", 100),
          holeCompensationMm: numberValue(processJson, "xy_hole_compensation", 0),
          machineConfigPath: machine,
          processConfigPath: processProfile,
          filamentConfigPath: candidate.path,
          source: "installed-slicer",
        },
      });
    }
  }

  const bambuStudioResourcesRoot = options.bambuStudioResourcesRoot ?? DEFAULT_BAMBU_RESOURCES;
  const bambuStudioExecutable = options.bambuStudioExecutable ?? DEFAULT_BAMBU_EXECUTABLE;
  const orcaSlicerResourcesRoot = options.orcaSlicerResourcesRoot ?? DEFAULT_ORCA_RESOURCES;
  const orcaSlicerExecutable = options.orcaSlicerExecutable ?? DEFAULT_ORCA_EXECUTABLE;
  const resolvedProfilesRoot = options.resolvedProfilesRoot ?? join(tmpdir(), "plasticity-mcp-resolved-profiles");
  const bambuProfiles = await discoverOrcaFamilyProfiles({
    resourcesRoot: bambuStudioResourcesRoot,
    slicer: "bambu-studio",
    resolvedRoot: join(resolvedProfilesRoot, "bambu-studio"),
  });
  const orcaProfiles = await discoverOrcaFamilyProfiles({
    resourcesRoot: orcaSlicerResourcesRoot,
    slicer: "orca-slicer",
    resolvedRoot: join(resolvedProfilesRoot, "orca-slicer"),
  });
  profiles.push(...bambuProfiles.profiles, ...orcaProfiles.profiles);

  return {
    profiles,
    records: [],
    adapters: [
      { id: "creality-print", available: crealityAvailable, ...(crealityAvailable ? { executable } : {}) },
      { id: "orca-slicer", available: await exists(orcaSlicerExecutable), ...(await exists(orcaSlicerExecutable) ? { executable: orcaSlicerExecutable } : {}) },
      { id: "bambu-studio", available: await exists(bambuStudioExecutable), ...(await exists(bambuStudioExecutable) ? { executable: bambuStudioExecutable } : {}) },
    ],
  };
}

async function firstAvailable(candidates: Array<{ root: string; executable: string }>): Promise<{ root: string; executable: string } | undefined> {
  for (const candidate of candidates) {
    const machine = join(candidate.root, "machine", "Creality K1C 0.4 nozzle.json");
    const processProfile = join(candidate.root, "process", "0.20mm Standard @Creality K1C 0.4 nozzle.json");
    if (await allExist([candidate.executable, machine, processProfile])) return candidate;
  }
  return undefined;
}

async function compatibleCrealityFilaments(
  profilesRoot: string,
  machineName: string,
  defaultReferences: unknown,
): Promise<Array<{ name: string; path: string; config: Record<string, unknown> }>> {
  const directory = join(profilesRoot, "filament");
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const defaults = new Set(profileStrings(defaultReferences));
  const filamentIndex = new Map<string, string>();
  const directConfigs = new Map<string, Record<string, unknown>>();
  const selectableNames = new Set<string>();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    try {
      const config = await readJson(path);
      const name = stringValue(config, "name", entry.name.slice(0, -".json".length));
      const compatible = Array.isArray(config.compatible_printers) && config.compatible_printers.includes(machineName);
      filamentIndex.set(name, path);
      directConfigs.set(name, config);
      if (compatible || defaults.has(name)) selectableNames.add(name);
    } catch {
      // Ignore malformed installed presets; other compatible materials remain available.
    }
  }

  const index: PresetIndex = { machine_list: new Map(), process_list: new Map(), filament_list: filamentIndex };
  const candidates: Array<{ name: string; path: string; config: Record<string, unknown> }> = [];
  for (const [name, path] of filamentIndex) {
    if (!selectableNames.has(name)) continue;
    try {
      const direct = directConfigs.get(name)!;
      const config = typeof direct.inherits === "string" || Array.isArray(direct.include)
        ? await resolvePreset("filament_list", name, index, new Set())
        : direct;
      if (!firstString(config.filament_type, "") || !Number.isFinite(Number(config.nozzle_temperature)) || !Number.isFinite(Number(config.hot_plate_temp))) continue;
      candidates.push({ name, path, config });
    } catch {
      // Broken inheritance chains are not usable printing profiles.
    }
  }
  return candidates;
}

interface OrcaFamilyDiscoveryOptions {
  resourcesRoot: string;
  slicer: "orca-slicer" | "bambu-studio";
  resolvedRoot: string;
}

type PresetKind = "machine_list" | "process_list" | "filament_list";
type PresetIndex = Record<PresetKind, Map<string, string>>;

async function discoverOrcaFamilyProfiles(options: OrcaFamilyDiscoveryOptions): Promise<{ profiles: ManufacturingProfile[] }> {
  const profilesRoot = join(options.resourcesRoot, "profiles");
  const profiles: ManufacturingProfile[] = [];
  const files = await readdir(profilesRoot, { withFileTypes: true }).catch(() => []);
  const vendorManifests = files.filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "OrcaFilamentLibrary.json");
  const globalFilamentManifest = await readJson(join(profilesRoot, "OrcaFilamentLibrary.json")).catch(() => undefined);
  const globalFilaments = globalFilamentManifest
    ? presetIndex(globalFilamentManifest.filament_list, join(profilesRoot, "OrcaFilamentLibrary"))
    : new Map<string, string>();

  for (const entry of vendorManifests) {
    const manifestPath = join(profilesRoot, entry.name);
    let manifest: Record<string, unknown>;
    try { manifest = await readJson(manifestPath); } catch { continue; }
    const vendorDirectory = join(profilesRoot, entry.name.slice(0, -".json".length));
    const machineIndex = presetIndex(manifest.machine_list, vendorDirectory);
    const processIndex = presetIndex(manifest.process_list, vendorDirectory);
    const vendorFilaments = presetIndex(manifest.filament_list, vendorDirectory);
    const filamentIndex = new Map([...globalFilaments, ...vendorFilaments]);
    const index: PresetIndex = { machine_list: machineIndex, process_list: processIndex, filament_list: filamentIndex };
    const vendorName = stringValue(manifest, "name", entry.name.slice(0, -".json".length));

    for (const [machineName, machinePath] of machineIndex) {
      let machine: Record<string, unknown>;
      try { machine = await readJson(machinePath); } catch { continue; }
      if (machine.type !== "machine" || typeof machine.printer_model !== "string") continue;
      const nozzleDiameterMm = firstNumber(machine.nozzle_diameter, NaN);
      const processReference = stringValue(machine, "default_print_profile", "");
      const processName = resolvePresetReference(processReference, processIndex, nozzleDiameterMm);
      const filamentNames = profileStrings(machine.default_filament_profile);
      if (!Number.isFinite(nozzleDiameterMm) || nozzleDiameterMm <= 0 || !processName || !filamentNames.length) continue;
      let fullMachine: Record<string, unknown>;
      let fullProcess: Record<string, unknown>;
      try {
        [fullMachine, fullProcess] = await Promise.all([
          resolvePreset("machine_list", machineName, index, new Set()),
          resolvePreset("process_list", processName, index, new Set()),
        ]);
      } catch { continue; }
      if (!compatibleWith(fullProcess, machineName)) continue;
      const buildVolume = bambuBuildVolume(fullMachine);
      const layerHeightMm = numberValue(fullProcess, "layer_height", layerHeightFromName(processName));
      if (!buildVolume || !Number.isFinite(layerHeightMm) || layerHeightMm <= 0) continue;

      for (const filamentName of filamentNames) {
        if (!filamentIndex.has(filamentName)) continue;
        try {
          const fullFilament = await resolvePreset("filament_list", filamentName, index, new Set());
          if (!compatibleWith(fullFilament, machineName)) continue;
          const materialName = stringValue(fullFilament, "name", filamentName);
          const type = profileString(fullFilament.filament_type, "");
          const materialVendor = profileString(fullFilament.filament_vendor, "Generic");
          const nozzleTemperatureC = firstNumber(fullFilament.nozzle_temperature, NaN);
          const bedTemperatureC = ["hot_plate_temp", "textured_plate_temp", "eng_plate_temp", "cool_plate_temp", "supertack_plate_temp"]
            .map((key) => firstNumber(fullFilament[key], NaN)).find(Number.isFinite) ?? NaN;
          if (!type || !Number.isFinite(nozzleTemperatureC) || !Number.isFinite(bedTemperatureC)) continue;
          const paths = await materializeResolvedProfiles(options.resolvedRoot, options.slicer, machineName, processName, filamentName, [fullMachine, fullProcess, fullFilament]);
          const id = `${options.slicer}:${slug(machineName)}:${slug(materialName)}:${slug(processName)}`;
          const densityGcm3 = finiteOptional(fullFilament.filament_density);
          const maxVolumetricSpeedMm3s = finiteOptional(fullFilament.filament_max_volumetric_speed);
          const nominalInfillPercent = options.slicer === "bambu-studio" ? undefined : optionalPercentValue(fullProcess, "sparse_infill_density");
          const processStructure = options.slicer === "bambu-studio" ? {} : extractProcessStructure(fullProcess);
          profiles.push({
            printer: {
              id: `${options.slicer}:${slug(machineName)}`,
              vendor: vendorName === "Bambulab" ? "Bambu Lab" : vendorName,
              model: machine.printer_model,
              buildVolumeMm: buildVolume.sizeMm,
              buildOriginMm: buildVolume.originMm,
              nozzleDiameterMm,
              source: "installed-slicer",
            },
            material: {
              id: `${options.slicer}:${slug(materialName)}`,
              name: materialName,
              type,
              vendor: materialVendor,
              nozzleTemperatureC,
              bedTemperatureC,
              ...(densityGcm3 ? { densityGcm3 } : {}),
              ...(maxVolumetricSpeedMm3s ? { maxVolumetricSpeedMm3s } : {}),
              source: "installed-slicer",
            },
            slicer: {
              id,
              slicer: options.slicer,
              name: processName,
              layerHeightMm,
              ...(nominalInfillPercent === undefined ? {} : { nominalInfillPercent }),
              ...processStructure,
              qualityTarget: inferQualityTarget(processName),
              ...(fullProcess.enable_support !== undefined ? { supportsEnabled: booleanValue(fullProcess, "enable_support") } : {}),
              dimensionalScalePercent: percentValue(fullFilament, "filament_shrink", 100),
              holeCompensationMm: numberValue(fullFilament, "xy_hole_compensation", 0),
              ...paths,
              source: "installed-slicer",
            },
          });
        } catch {
          // An incomplete, cyclic, or incompatible preset chain is not a usable printer profile.
        }
      }
    }
  }
  return { profiles };
}

function presetIndex(value: unknown, profilesRoot: string): Map<string, string> {
  const index = new Map<string, string>();
  if (!Array.isArray(value)) return index;
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.name !== "string" || typeof candidate.sub_path !== "string") continue;
    const relative = candidate.sub_path;
    const path = resolve(profilesRoot, relative);
    if (relative.startsWith("/") || path !== profilesRoot && !path.startsWith(`${resolve(profilesRoot)}${sep}`)) continue;
    index.set(candidate.name, path);
  }
  return index;
}

function resolvePresetReference(reference: string, index: Map<string, string>, nozzleDiameterMm: number): string | undefined {
  if (index.has(reference)) return reference;
  const suffix = /\s+\(\s*(\d+(?:\.\d+)?)\s*nozzle\s*\)$/i.exec(reference);
  if (!suffix || Math.abs(Number(suffix[1]) - nozzleDiameterMm) > 1e-6) return undefined;
  const unqualified = reference.slice(0, suffix.index).trimEnd();
  const matches = [...index.keys()].filter((name) => name === unqualified);
  return matches.length === 1 ? matches[0] : undefined;
}

async function resolvePreset(kind: PresetKind, name: string, index: PresetIndex, visiting: Set<string>): Promise<Record<string, unknown>> {
  if (visiting.size >= 32) throw new Error("Preset inheritance depth exceeds 32 profiles");
  const path = index[kind].get(name);
  if (!path) throw new Error(`Missing ${kind} preset: ${name}`);
  const key = `${kind}:${name}`;
  if (visiting.has(key)) throw new Error(`Cyclic preset inheritance: ${key}`);
  const chain = new Set(visiting).add(key);
  const preset = await readJson(path);
  const inherits = typeof preset.inherits === "string" ? preset.inherits : "";
  let resolved: Record<string, unknown> = inherits ? await resolvePreset(kind, inherits, index, chain) : {};
  const includes = Array.isArray(preset.include) ? preset.include.filter((item): item is string => typeof item === "string") : [];
  for (const included of includes) resolved = { ...resolved, ...await resolvePreset(kind, included, index, chain) };
  return { ...resolved, ...preset, inherits: undefined, include: undefined };
}

function compatibleWith(preset: Record<string, unknown>, machineName: string): boolean {
  const compatible = preset.compatible_printers;
  return !Array.isArray(compatible) || compatible.length === 0 || compatible.some((name) => name === machineName);
}

function bambuBuildVolume(machine: Record<string, unknown>): { sizeMm: [number, number, number]; originMm: [number, number, number] } | undefined {
  const area = machine.printable_area;
  const points = Array.isArray(area) ? area : typeof area === "string" ? area.split(",") : [];
  const coordinates = points.filter((point): point is string => typeof point === "string").map((point) => point.split("x").map(Number));
  const xs = coordinates.map((point) => point[0]).filter((value): value is number => Number.isFinite(value));
  const ys = coordinates.map((point) => point[1]).filter((value): value is number => Number.isFinite(value));
  const height = numberValue(machine, "printable_height", NaN);
  if (xs.length < 3 || ys.length < 3 || !Number.isFinite(height) || height <= 0) return undefined;
  return {
    sizeMm: [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), height],
    originMm: [Math.min(...xs), Math.min(...ys), numberValue(machine, "printable_z_min", 0)],
  };
}

async function materializeResolvedProfiles(
  root: string,
  slicer: string,
  machineName: string,
  processName: string,
  filamentName: string,
  resolved: Record<string, unknown>[],
): Promise<{ machineConfigPath: string; processConfigPath: string; filamentConfigPath: string }> {
  const directory = join(root, createHash("sha256").update(JSON.stringify([slicer, machineName, processName, filamentName, resolved])).digest("hex").slice(0, 24));
  await mkdir(directory, { recursive: true });
  const names = ["machine.json", "process.json", "filament.json"];
  const paths = await Promise.all(resolved.map(async (value, index) => {
    const path = join(directory, names[index]!);
    const contents = `${JSON.stringify(value, null, 2)}\n`;
    try { await writeFile(path, contents, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (!isAlreadyExists(error) || await readFile(path, "utf8") !== contents) throw error;
    }
    return path;
  }));
  return { machineConfigPath: paths[0]!, processConfigPath: paths[1]!, filamentConfigPath: paths[2]! };
}

function layerHeightFromName(name: string): number { return Number(/(?:^|\s)(\d+(?:\.\d+)?)mm\b/i.exec(name)?.[1] ?? NaN); }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64); }
function finiteOptional(value: unknown): number | undefined {
  const parsed = firstNumber(value, NaN);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
function profileString(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value;
  return firstString(value, fallback);
}
function isAlreadyExists(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"; }

async function findK1cHost(path: string): Promise<string | undefined> {
  if (!await exists(path)) return undefined;
  const data = await readJson(path);
  const groups = Array.isArray(data.groups) ? data.groups : [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.list)) continue;
    for (const device of group.list) {
      if (isRecord(device) && device.model === "K1C" && typeof device.address === "string") return device.address;
    }
  }
  return undefined;
}

function printableExtent(data: Record<string, unknown>, axis: 0 | 1, fallback: number): number {
  const area = data.printable_area;
  if (typeof area !== "string") return fallback;
  const coordinates = area.split(",").map((point) => point.split("x").map(Number));
  const values = coordinates.map((point) => point[axis]).filter((value): value is number => Number.isFinite(value));
  return values.length ? Math.max(...values) - Math.min(...values) : fallback;
}

async function allExist(paths: string[]): Promise<boolean> {
  return (await Promise.all(paths.map(exists))).every(Boolean);
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(() => true, () => false);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value)) throw new Error(`Profile is not a JSON object: ${path}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(data: Record<string, unknown>, key: string, fallback: string): string {
  return typeof data[key] === "string" && data[key] ? data[key] : fallback;
}

function numberValue(data: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(data[key]);
  return Number.isFinite(value) ? value : fallback;
}

function firstString(value: unknown, fallback: string): string {
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : fallback;
}

function profileStrings(value: unknown): string[] {
  const candidates = typeof value === "string" ? value.split(";") : Array.isArray(value) ? value.flatMap((item) => typeof item === "string" ? item.split(";") : []) : [];
  return [...new Set(candidates.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
}

function firstNumber(value: unknown, fallback: number): number {
  return Array.isArray(value) && Number.isFinite(Number(value[0])) ? Number(value[0]) : fallback;
}

function booleanValue(data: Record<string, unknown>, key: string): boolean {
  return data[key] === true || data[key] === 1 || data[key] === "1" || data[key] === "true";
}

function percentValue(data: Record<string, unknown>, key: string, fallback: number): number {
  const value = data[key];
  const parsed = Number(typeof value === "string" ? value.replace(/%$/, "") : value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalPercentValue(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  const parsed = Number(typeof value === "string" ? value.trim().replace(/%$/, "") : value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : undefined;
}

function optionalProfileString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 80 ? normalized : undefined;
}

function optionalIntegerValue(data: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = Number(data[key]);
  return Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

function extractProcessStructure(data: Record<string, unknown>) {
  const sparseInfillPattern = optionalProfileString(data, "sparse_infill_pattern");
  const wallLoops = optionalIntegerValue(data, "wall_loops", 0, 20);
  const topShellLayers = optionalIntegerValue(data, "top_shell_layers", 0, 100);
  const bottomShellLayers = optionalIntegerValue(data, "bottom_shell_layers", 0, 100);
  return {
    ...(sparseInfillPattern === undefined ? {} : { sparseInfillPattern }),
    ...(wallLoops === undefined ? {} : { wallLoops }),
    ...(topShellLayers === undefined ? {} : { topShellLayers }),
    ...(bottomShellLayers === undefined ? {} : { bottomShellLayers }),
  };
}

function inferQualityTarget(name: string): "draft" | "standard" | "fine" | "strong" | "custom" {
  const normalized = name.toLowerCase();
  if (normalized.includes("draft")) return "draft";
  if (normalized.includes("fine")) return "fine";
  if (normalized.includes("strong")) return "strong";
  if (normalized.includes("standard")) return "standard";
  return "custom";
}
