import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { ManufacturingProfile, ManufacturingProfileRecord } from "../../src/shared/contracts.ts";
import { ArtifactStore } from "../../src/server/artifact-store.ts";
import { openDatabase } from "../../src/server/database.ts";
import { createWorkbenchServer } from "../../src/server/http-server.ts";
import { WorkbenchApiClient } from "../../src/server/mcp/client.ts";
import { createWorkbenchMcpServer } from "../../src/server/mcp/server.ts";
import { SqliteProjectStore } from "../../src/server/project-store.ts";

async function createHarness(context: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "plasticity-workbench-mcp-"));
  const database = openDatabase(join(root, "workbench.sqlite"));
  const projects = new SqliteProjectStore(database);
  const artifacts = new ArtifactStore(join(root, "artifacts"), database);
  const http = createWorkbenchServer({
    ownerToken: "a".repeat(43),
    projects,
    artifacts,
    config: { host: "127.0.0.1", port: 0, projectsRoot: join(root, "projects"), maxJsonBytes: 1024 * 1024 },
  });
  const address = await http.listen();
  const project = projects.create("Bracket", join(root, "projects", "bracket"));
  const server = createWorkbenchMcpServer(new WorkbenchApiClient(address.origin, "a".repeat(43)));
  const client = new Client({ name: "workbench-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const instructions = client.getInstructions() ?? "";
  assert.match(instructions, /Workbench is an optional review and manufacturing interface/i);
  assert.match(instructions, /Creality K1C with Creality Print or OrcaSlicer/i);
  assert.match(instructions, /Bambu Lab remains soon-only/i);
  assert.match(instructions, /Only submit a print job after the user explicitly confirms/i);
  assert.match(instructions, /Codex chat remains in Codex/i);
  context.after(async () => {
    await client.close();
    await server.close();
    await http.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  return { client, project };
}

function responseText(response: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = response.content as Array<{ type: string; text?: string }>;
  return content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function profile(vendor: string, model: string, slicer: ManufacturingProfile["slicer"]["slicer"], materialName: string, materialType: string): ManufacturingProfile {
  return {
    printer: { id: `${vendor}-${model}`, vendor, model, buildVolumeMm: [256, 256, 256], nozzleDiameterMm: 0.4, source: "installed-slicer" },
    material: { id: materialName, name: materialName, type: materialType, vendor, nozzleTemperatureC: 220, bedTemperatureC: 60, source: "installed-slicer" },
    slicer: { id: `${model}-standard`, slicer, name: "0.20mm Standard", layerHeightMm: 0.2, machineConfigPath: "/tmp/machine.json", processConfigPath: "/tmp/process.json", filamentConfigPath: "/tmp/filament.json", source: "installed-slicer" },
  };
}

test("initializes, lists review tools, and publishes a measurement table", async (context) => {
  const { client, project } = await createHarness(context);
  const listed = await client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === "workbench_list_projects"));
  assert.ok(listed.tools.some((tool) => tool.name === "workbench_create_project"));
  assert.ok(listed.tools.some((tool) => tool.name === "workbench_publish_model_version"));
  assert.ok(listed.tools.some((tool) => tool.name === "workbench_upload_project_artifact"));
  assert.ok(listed.tools.some((tool) => tool.name === "workbench_wait_for_feedback"));
  assert.ok(listed.tools.some((tool) => tool.name === "workbench_register_reference"));
  assert.ok(listed.tools.some((tool) => tool.name === "workbench_publish_construction_journal"));
  assert.ok(listed.tools.some((tool) => tool.name === "workbench_reconcile_print_submission"));
  assert.ok(listed.tools.some((tool) => tool.name === "workbench_slice_parts"));

  const response = await client.callTool({
    name: "workbench_publish_structured_block",
    arguments: {
      projectId: project.id,
      expectedRevision: 0,
      block: {
        type: "dimensions",
        title: "Контрольные размеры",
        rows: [{
          key: "width",
          label: "Overall width",
          value: 80,
          actual: 80,
          tolerance: 0.01,
          unit: "mm",
          source: "native-brep",
          confidence: "verified",
          status: "verified",
        }],
      },
    },
  });
  assert.equal(response.isError, undefined);
  assert.match(responseText(response), /"revision": 1/);

  const status = await client.callTool({
    name: "workbench_project_status",
    arguments: { projectId: project.id },
  });
  assert.match(responseText(status), /"revision": 1/);

  const created = await client.callTool({ name: "workbench_create_project", arguments: { name: "Second project" } });
  assert.equal(created.isError, undefined);
  const projects = await client.callTool({ name: "workbench_list_projects", arguments: {} });
  assert.match(responseText(projects), /Second project/);
});

test("searches manufacturing profiles by printer and material with bounded pagination", async (context) => {
  const profiles = [
    profile("Creality", "Creality K1C", "creality-print", "Generic PLA", "PLA"),
    profile("Bambu Lab", "Bambu Lab A1", "orca-slicer", "Bambu PLA Basic", "PLA"),
    profile("Bambu Lab", "Bambu Lab A1", "orca-slicer", "Bambu PETG HF", "PETG"),
    profile("Bambu Lab", "Bambu Lab P1S", "orca-slicer", "Bambu PETG HF", "PETG"),
    ...Array.from({ length: 25 }, (_, index) => profile("Other", `Other ${index}`, "orca-slicer", "Generic PLA", "PLA")),
  ];
  const registeredProfile = profile("Creality", "Creality K1C", "creality-print", "Generic PLA", "PLA");
  registeredProfile.slicer.layerHeightMm = 0.16;
  registeredProfile.slicer.nominalInfillPercent = 35;
  registeredProfile.slicer.sparseInfillPattern = "gyroid";
  registeredProfile.slicer.wallLoops = 4;
  registeredProfile.slicer.topShellLayers = 6;
  registeredProfile.slicer.bottomShellLayers = 7;
  registeredProfile.printer.connection = { kind: "moonraker", host: "192.168.1.41", port: 7125 };
  const records: ManufacturingProfileRecord[] = [{
    id: "record-k1c-pla-016",
    profile: registeredProfile,
    verification: "user-verified",
    profileHash: "a".repeat(64),
    configHashes: { machine: "b".repeat(64), process: "c".repeat(64), filament: "d".repeat(64) },
    createdAt: "2026-09-25T10:00:00.000Z",
  }];
  let slicedRequest: unknown;
  let registrationRequest: unknown;
  const fakeApi = {
    manufacturingProfiles: async () => ({
      profiles,
      records,
      adapters: [
        { id: "orca-slicer", available: true, executable: "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer" },
        { id: "creality-print", available: true, executable: "/Applications/Creality Print.app/Contents/MacOS/CrealityPrint" },
      ],
    }),
    registerManufacturingProfile: async (_projectId: string, registration: unknown) => {
      registrationRequest = registration;
      return records[0];
    },
    createSliceJob: async (projectId: string, request: unknown) => {
      slicedRequest = request;
      return {
        id: "slice-job-1", projectId, projectRevision: 3, sourceArtifactHash: "e".repeat(64),
        gcodeArtifactHash: "f".repeat(64), profileHash: "a".repeat(64), profile: registeredProfile,
        dfmReport: {}, summary: {
          layers: 3, depositionLayerZMm: [0.24, 0.42, 0.66],
          depositionLayerPathOrientations: [
            { layerIndex: 1, planarPathLengthMm: 100, principalDirectionDeg: 0, directionalConcentration: 1, curvedExtrusionMoves: 0, coverage: "complete-linear" },
            { layerIndex: 2, planarPathLengthMm: 80, principalDirectionDeg: 90, directionalConcentration: 0.7, curvedExtrusionMoves: 2, coverage: "partial-curved" },
            { layerIndex: 3, planarPathLengthMm: 60, principalDirectionDeg: null, directionalConcentration: 0, curvedExtrusionMoves: 0, coverage: "complete-linear" },
          ],
        }, state: "ready",
        createdAt: "2026-09-25T10:00:00.000Z", updatedAt: "2026-09-25T10:00:00.000Z",
      };
    },
    interfaceLayerHeights: async (_projectId: string, jobId: string, interfaceLayerIndices: number[]) => ({
      jobId, profileHash: "a".repeat(64), sourceArtifactHash: "e".repeat(64), gcodeArtifactHash: "f".repeat(64),
      layerCount: 3, coordinateFrame: "slicer-build", firstDepositionLayerZMm: 0.24,
      interfaces: interfaceLayerIndices.map((interfaceLayerIndex) => ({
        interfaceLayerIndex,
        depositionLayerZMm: [0.24, 0.42, 0.66][interfaceLayerIndex - 1],
        relativeOffsetMm: [0, 0.18, 0.42][interfaceLayerIndex - 1],
        depositionPathOrientation: [
          { layerIndex: 1, planarPathLengthMm: 100, principalDirectionDeg: 0, directionalConcentration: 1, curvedExtrusionMoves: 0, coverage: "complete-linear" },
          { layerIndex: 2, planarPathLengthMm: 80, principalDirectionDeg: 90, directionalConcentration: 0.7, curvedExtrusionMoves: 2, coverage: "partial-curved" },
          { layerIndex: 3, planarPathLengthMm: 60, principalDirectionDeg: null, directionalConcentration: 0, curvedExtrusionMoves: 0, coverage: "complete-linear" },
        ][interfaceLayerIndex - 1],
      })),
    }),
    layerPathOrientations: async (_projectId: string, jobId: string, layerIndices: number[]) => ({
      jobId, profileHash: "a".repeat(64), sourceArtifactHash: "e".repeat(64), gcodeArtifactHash: "f".repeat(64),
      layerCount: 3, coordinateFrame: "slicer-build",
      layers: layerIndices.map((layerIndex) => ({
        layerIndex,
        depositionLayerZMm: [0.24, 0.42, 0.66][layerIndex - 1],
        pathOrientation: [
          { layerIndex: 1, planarPathLengthMm: 100, principalDirectionDeg: 0, directionalConcentration: 1, curvedExtrusionMoves: 0, coverage: "complete-linear" },
          { layerIndex: 2, planarPathLengthMm: 80, principalDirectionDeg: 90, directionalConcentration: 0.7, curvedExtrusionMoves: 2, coverage: "partial-curved" },
          { layerIndex: 3, planarPathLengthMm: 60, principalDirectionDeg: null, directionalConcentration: 0, curvedExtrusionMoves: 0, coverage: "complete-linear" },
        ][layerIndex - 1],
      })),
    }),
  };
  const server = createWorkbenchMcpServer(fakeApi as unknown as WorkbenchApiClient);
  const client = new Client({ name: "profile-search-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => { await client.close(); await server.close(); });

  const selectedProfileRegistration = await client.callTool({
    name: "workbench_register_manufacturing_profile",
    arguments: {
      projectId: "fe0a2c3d-34a9-457e-ae72-75872aee4790",
      registration: {
        discoveredProfile: { printerId: registeredProfile.printer.id, materialId: registeredProfile.material.id, slicerId: registeredProfile.slicer.id },
        verification: "user-verified",
      },
    },
  });
  assert.equal(selectedProfileRegistration.isError, undefined);
  assert.deepEqual(registrationRequest, {
    discoveredProfile: { printerId: registeredProfile.printer.id, materialId: registeredProfile.material.id, slicerId: registeredProfile.slicer.id },
    verification: "user-verified",
  });
  assert.doesNotMatch(responseText(selectedProfileRegistration), /machineConfigPath|processConfigPath|filamentConfigPath|192\.168\.1\.41/);

  const defaultPage = await client.callTool({
    name: "workbench_manufacturing_profiles",
    arguments: { projectId: "fe0a2c3d-34a9-457e-ae72-75872aee4790" },
  });
  const defaultResult = JSON.parse(responseText(defaultPage)) as { profiles: ManufacturingProfile[]; totalCount: number; limit: number; hasMore: boolean; registeredProfileCount: number };
  assert.equal(defaultResult.totalCount, 29);
  assert.equal(defaultResult.limit, 20);
  assert.equal(defaultResult.profiles.length, 20);
  assert.equal(defaultResult.hasMore, true);
  assert.equal(defaultResult.registeredProfileCount, 1);

  const firstPage = await client.callTool({
    name: "workbench_manufacturing_profiles",
    arguments: { projectId: "fe0a2c3d-34a9-457e-ae72-75872aee4790", printerVendor: "bambu lab", printerModel: "A1", limit: 1 },
  });
  assert.equal(firstPage.isError, undefined);
  const first = JSON.parse(responseText(firstPage)) as { profiles: ManufacturingProfile[]; totalCount: number; hasMore: boolean; adapters: unknown[] };
  assert.equal(first.totalCount, 2);
  assert.equal(first.profiles.length, 1);
  assert.equal(first.profiles[0]?.material.type, "PLA");
  assert.equal(first.hasMore, true);
  assert.equal(first.adapters.length, 2);

  const secondPage = await client.callTool({
    name: "workbench_manufacturing_profiles",
    arguments: { projectId: "fe0a2c3d-34a9-457e-ae72-75872aee4790", slicer: "orca-slicer", material: "petg", limit: 1, offset: 1 },
  });
  const second = JSON.parse(responseText(secondPage)) as { profiles: ManufacturingProfile[]; totalCount: number; hasMore: boolean };
  assert.equal(second.totalCount, 2);
  assert.equal(second.profiles[0]?.printer.model, "Bambu Lab P1S");
  assert.equal(second.hasMore, false);

  const registered = await client.callTool({
    name: "workbench_manufacturing_profiles",
    arguments: { projectId: "fe0a2c3d-34a9-457e-ae72-75872aee4790", printerModel: "K1C", slicer: "creality-print" },
  });
  const registeredResult = JSON.parse(responseText(registered)) as {
    registeredProfiles: Array<{ profileHash: string; verification: string; profile: ManufacturingProfile }>;
  };
  assert.equal(registeredResult.registeredProfiles.length, 1);
  assert.equal(registeredResult.registeredProfiles[0]?.profileHash, "a".repeat(64));
  assert.equal(registeredResult.registeredProfiles[0]?.verification, "user-verified");
  assert.equal(registeredResult.registeredProfiles[0]?.profile.slicer.layerHeightMm, 0.16);
  assert.equal(registeredResult.registeredProfiles[0]?.profile.slicer.nominalInfillPercent, 35);
  assert.equal(registeredResult.registeredProfiles[0]?.profile.slicer.sparseInfillPattern, "gyroid");
  assert.equal(registeredResult.registeredProfiles[0]?.profile.slicer.wallLoops, 4);
  assert.equal(registeredResult.registeredProfiles[0]?.profile.slicer.topShellLayers, 6);
  assert.equal(registeredResult.registeredProfiles[0]?.profile.slicer.bottomShellLayers, 7);
  assert.doesNotMatch(responseText(registered), /machineConfigPath|processConfigPath|filamentConfigPath|\/tmp\/machine\.json|\/Applications\//);

  const sliced = await client.callTool({
    name: "workbench_slice_model",
    arguments: {
      projectId: "fe0a2c3d-34a9-457e-ae72-75872aee4790",
      request: { expectedRevision: 3, sourceArtifactHash: "e".repeat(64), profileHash: "a".repeat(64), dfm: { sizeMm: [20, 10, 3] } },
    },
  });
  assert.equal(sliced.isError, undefined);
  assert.deepEqual(slicedRequest, {
    expectedRevision: 3, sourceArtifactHash: "e".repeat(64), profileHash: "a".repeat(64), dfm: { sizeMm: [20, 10, 3] },
  });
  assert.match(responseText(sliced), /"depositionLayerZCount": 3/);
  assert.match(responseText(sliced), /"depositionLayerPathOrientationCount": 3/);
  assert.doesNotMatch(responseText(sliced), /"depositionLayerPathOrientations"/);
  assert.doesNotMatch(responseText(sliced), /machineConfigPath|processConfigPath|filamentConfigPath|\/Applications\/|192\.168\.1\.41/);

  const layerHeights = await client.callTool({
    name: "workbench_slicer_interface_heights",
    arguments: {
      projectId: "fe0a2c3d-34a9-457e-ae72-75872aee4790", jobId: "123e4567-e89b-42d3-a456-426614174000",
      interfaceLayerIndices: [1, 2],
    },
  });
  assert.equal(layerHeights.isError, undefined);
  assert.match(responseText(layerHeights), /"depositionLayerZMm": 0\.42/);
  assert.match(responseText(layerHeights), /"relativeOffsetMm": 0\.18/);
  assert.match(responseText(layerHeights), /"principalDirectionDeg": 90/);
  assert.match(responseText(layerHeights), /"coverage": "partial-curved"/);
  assert.doesNotMatch(responseText(layerHeights), /machineConfigPath|\/Applications\/|192\.168\.1\.41/);

  const layerPaths = await client.callTool({
    name: "workbench_slicer_layer_path_orientations",
    arguments: {
      projectId: "fe0a2c3d-34a9-457e-ae72-75872aee4790", jobId: "123e4567-e89b-42d3-a456-426614174000",
      layerIndices: [1, 2, 3],
    },
  });
  assert.equal(layerPaths.isError, undefined);
  assert.match(responseText(layerPaths), /"gcodeArtifactHash": "f{64}"/);
  assert.match(responseText(layerPaths), /"layerIndex": 3[\s\S]*?"principalDirectionDeg": null/);
  assert.match(responseText(layerPaths), /"depositionLayerZMm": 0\.66/);

  const invalid = await client.callTool({
    name: "workbench_manufacturing_profiles",
    arguments: { projectId: "fe0a2c3d-34a9-457e-ae72-75872aee4790", limit: 101 },
  });
  assert.equal(invalid.isError, true);
});

test("uploads only supported artifacts from inside the project workspace", async (context) => {
  const { client, project } = await createHarness(context);
  await mkdir(project.workspacePath, { recursive: true });
  await writeFile(join(project.workspacePath, "bracket.step"), "ISO-10303-21;\nEND-ISO-10303-21;\n");
  await writeFile(join(project.workspacePath, "..", "outside.step"), "outside");

  const uploaded = await client.callTool({
    name: "workbench_upload_project_artifact",
    arguments: { projectId: project.id, relativePath: "bracket.step" },
  });
  assert.equal(uploaded.isError, undefined);
  assert.match(responseText(uploaded), /"mediaType": "model\/step"/);
  const hash = /"hash": "([0-9a-f]{64})"/.exec(responseText(uploaded))?.[1];
  assert.ok(hash);

  const published = await client.callTool({
    name: "workbench_publish_model_version",
    arguments: {
      projectId: project.id,
      expectedRevision: 0,
      version: { plasticityDocumentToken: "document", plasticityRevision: "revision", stepArtifactHash: hash, measurements: [] },
    },
  });
  assert.equal(published.isError, undefined);

  const escaped = await client.callTool({
    name: "workbench_upload_project_artifact",
    arguments: { projectId: project.id, relativePath: "../outside.step" },
  });
  assert.equal(escaped.isError, true);
  assert.match(responseText(escaped), /escapes the project workspace/i);
});

test("registers and lists reference provenance through MCP", async (context) => {
  const { client, project } = await createHarness(context);
  const registered = await client.callTool({
    name: "workbench_register_reference",
    arguments: {
      projectId: project.id,
      expectedRevision: 0,
      reference: {
        label: "Official dimensional drawing",
        sourceKind: "official-documentation",
        format: "drawing-pdf",
        sourceUrl: "https://example.com/device-drawing.pdf",
        overallConfidence: "probable",
        dimensions: [{ key: "depth", label: "Depth", value: 12.4, unit: "mm", confidence: "verified", critical: true, sourceLocator: "page 2" }],
        sceneRole: "functional-envelope",
      },
    },
  });
  assert.equal(registered.isError, undefined);

  const listed = await client.callTool({ name: "workbench_references", arguments: { projectId: project.id } });
  assert.match(responseText(listed), /device-drawing\.pdf/);
  assert.match(responseText(listed), /"depth"/);
});

test("publishes and lists a persistent Plasticity construction journal", async (context) => {
  const { client, project } = await createHarness(context);
  const published = await client.callTool({
    name: "workbench_publish_construction_journal",
    arguments: {
      projectId: project.id,
      expectedRevision: 0,
      journal: {
        documentToken: "document-1",
        revision: "revision-2",
        syncStatus: "in-sync",
        entries: [{
          id: "3d5338f4-ff2a-47ce-a7bd-2309ae339889",
          operation: "create-box",
          intent: "Base plate",
          input: { sizeMm: [80, 40, 8] },
          documentToken: "document-1",
          beforeRevision: "revision-1",
          afterDocumentToken: "document-1",
          afterRevision: "revision-2",
          status: "completed",
          diff: { changed: true },
          error: null,
          occurredAt: "2026-09-20T10:00:00.000Z",
        }],
      },
    },
  });
  assert.equal(published.isError, undefined);

  const listed = await client.callTool({ name: "workbench_construction_journals", arguments: { projectId: project.id } });
  assert.match(responseText(listed), /create-box/);
  assert.match(responseText(listed), /Base plate/);
});

test("returns a structured revision conflict and never overwrites", async (context) => {
  const { client, project } = await createHarness(context);
  const publish = async (status: string) => await client.callTool({
    name: "workbench_publish_status",
    arguments: { projectId: project.id, expectedRevision: 0, status },
  });
  assert.equal((await publish("Modeling")).isError, undefined);
  const stale = await publish("Done");
  assert.equal(stale.isError, true);
  assert.match(responseText(stale), /revision_conflict/);
  assert.match(responseText(stale), /currentRevision.*1/s);
});

test("exposes the Plasticity review prompt and bounded feedback wait", async (context) => {
  const { client, project } = await createHarness(context);
  const prompts = await client.listPrompts();
  assert.ok(prompts.prompts.some((prompt) => prompt.name === "plasticity_workbench_review"));
  const prompt = await client.getPrompt({
    name: "plasticity_workbench_review",
    arguments: { projectId: project.id },
  });
  assert.match(JSON.stringify(prompt.messages), /export a new STEP/i);

  const feedback = await client.callTool({
    name: "workbench_wait_for_feedback",
    arguments: { projectId: project.id, afterSequence: 0, timeoutSeconds: 0 },
  });
  assert.match(responseText(feedback), /"timedOut": true/);
});
