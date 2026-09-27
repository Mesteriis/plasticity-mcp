import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ManufacturingProfile } from "../shared/contracts.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { resolveWorkbenchConfig } from "./config.ts";
import { openDatabase } from "./database.ts";
import { ProjectEventHub } from "./event-hub.ts";
import { createWorkbenchServer } from "./http-server.ts";
import { PairingService } from "./pairing.ts";
import { SqliteProjectStore } from "./project-store.ts";
import { ManufacturingJobStore } from "./manufacturing/store.ts";
import { ManufacturingService } from "./manufacturing/service.ts";
import { discoverManufacturingProfiles } from "./manufacturing/profile-registry.ts";
import { ManufacturingProfileStore } from "./manufacturing/profile-store.ts";
import { CrealityPrintSlicer, OrcaFamilySlicer, type SlicerAdapter } from "./manufacturing/slicer.ts";
import { MoonrakerPrinter, type PrinterAdapter } from "./manufacturing/printer.ts";

const config = resolveWorkbenchConfig({
  env: process.env,
  args: process.argv.slice(2),
  cwd: process.cwd(),
  home: homedir(),
});
const database = openDatabase(join(config.projectsRoot, "workbench.sqlite"));
const projects = new SqliteProjectStore(database);
const artifacts = new ArtifactStore(join(config.projectsRoot, ".artifacts"), database);
const pairing = new PairingService(database);
const manufacturingCatalog = await discoverManufacturingProfiles({
  ...(process.env.CREALITY_PRINT_RESOURCES_ROOT
    ? { crealityProfilesRoot: join(process.env.CREALITY_PRINT_RESOURCES_ROOT, "profiles", "Creality") }
    : {}),
  ...(process.env.CREALITY_PRINT_EXECUTABLE ? { crealityExecutable: process.env.CREALITY_PRINT_EXECUTABLE } : {}),
  deviceInfoPath: join(homedir(), "Library/Application Support/Creality/Creality Print/7.0/deviceInfo.json"),
  ...(process.env.BAMBU_STUDIO_RESOURCES_ROOT ? { bambuStudioResourcesRoot: process.env.BAMBU_STUDIO_RESOURCES_ROOT } : {}),
  ...(process.env.BAMBU_STUDIO_EXECUTABLE ? { bambuStudioExecutable: process.env.BAMBU_STUDIO_EXECUTABLE } : {}),
  ...(process.env.ORCA_SLICER_RESOURCES_ROOT ? { orcaSlicerResourcesRoot: process.env.ORCA_SLICER_RESOURCES_ROOT } : {}),
  ...(process.env.ORCA_SLICER_EXECUTABLE ? { orcaSlicerExecutable: process.env.ORCA_SLICER_EXECUTABLE } : {}),
  resolvedProfilesRoot: join(config.projectsRoot, ".resolved-manufacturing-profiles"),
});
const crealityAdapter = manufacturingCatalog.adapters.find((adapter) => adapter.id === "creality-print" && adapter.available);
const slicers = new Map<ManufacturingProfile["slicer"]["slicer"], SlicerAdapter>();
if (crealityAdapter?.executable) slicers.set("creality-print", new CrealityPrintSlicer(crealityAdapter.executable));
for (const id of ["orca-slicer", "bambu-studio"] as const) {
  const adapter = manufacturingCatalog.adapters.find((candidate) => candidate.id === id && candidate.available);
  if (adapter?.executable) slicers.set(id, new OrcaFamilySlicer(id, adapter.executable));
}
const printers = new Map<NonNullable<ManufacturingProfile["printer"]["connection"]>["kind"], PrinterAdapter>([
  ["moonraker", new MoonrakerPrinter()],
]);
const manufacturing = new ManufacturingService(
  new ManufacturingJobStore(database),
  projects,
  artifacts,
  manufacturingCatalog,
  new ManufacturingProfileStore(database, join(config.projectsRoot, ".manufacturing-profiles")),
  slicers,
  printers,
);
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../../dist");
const service = createWorkbenchServer({ projects, artifacts, pairing, config, webRoot, manufacturing });
const events = new ProjectEventHub(service.server, projects, pairing);
const address = await service.listen();

process.stdout.write(`${address.origin}\n`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await events.close();
  await service.close();
  database.close();
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
