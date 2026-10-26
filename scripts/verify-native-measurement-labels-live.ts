#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { discoverPlasticityTargets } from "../src/cdp/discovery.ts";
import { PlasticityRuntime } from "../src/plasticity/runtime.ts";
import { hydrateNativeState } from "./native-live-state.ts";
import { isolatedAcceptanceEnvironment } from "./verify-native-measure-datum-files-live.ts";
import { parseNativeTopologyDistanceAcceptanceArgs } from "./verify-native-topology-distance-live.ts";
import { hasSceneContentChanges, sanitizeEvidence } from "./verify-section-strength-live.ts";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function parseMeasurementLabelsArgs(argv: string[]) {
    const result = parseNativeTopologyDistanceAcceptanceArgs(argv);
    if (result.geometryOnly)
        throw new Error("HTML-label acceptance cannot use --geometry-only");
    return result;
}
const HELP = `Usage: npm run accept:native-measurement-labels -- --target ID --allow-disposable-mutations --output NEW_DIRECTORY
No arguments or --help do not connect or mutate. Requires an empty disposable document.
Checks actual HTML text/style/layout against native measurements and projected WebGL anchors,
camera/model changes, deletion, Undo/Redo and cleanup. WebGL PNGs exclude HTML labels;
this fixture does not claim rasterized HTML glyph or full-window acceptance.`;
async function main() {
    const options = parseMeasurementLabelsArgs(process.argv.slice(2));
    if (options.help) {
        console.log(HELP);
        return;
    }
    const output = resolve(options.output!);
    await mkdir(output, { recursive: false, mode: 0o700 });
    const evidence: any = { schemaVersion: 1, validationScope: "native-measurement-and-html-layout", startedAt: new Date().toISOString() };
    let client: Client | undefined;
    let state: any;
    let initial: any;
    try {
        const transport = new StdioClientTransport({ command: process.execPath, args: [join(projectRoot, "scripts/run-server.ts")], cwd: projectRoot, env: isolatedAcceptanceEnvironment(join(output, "stores"), process.env), stderr: "pipe" });
        client = new Client({ name: "plasticity-html-labels-live", version: "1.0.0" });
        await client.connect(transport);
        const windows = await call(client, "plasticity_list_windows", {});
        ensure(windows.some((w: any) => w.targetId === options.target), "Explicit target missing");
        initial = state = await call(client, "plasticity_connect", { targetId: options.target });
        empty(state);
        const initialLayout = await layout(options.target!);
        ensure(initialLayout.labels.length === 0 && initialLayout.managed === 0 && initialLayout.helpers === 0, "Initial document contains annotation overlays");
        const snapshot = await call(client, "plasticity_capture_snapshot", { label: "html-labels-initial-empty" });
        const mutate = async (name: string, args: Record<string, unknown>) => { state = await call(client!, name, { ...args, revision: state.revision }); return state; };
        await mutate("plasticity_create_box", { originMm: [0, 0, 0], sizeMm: [20, 10, 5] });
        const first = state.bodies[0];
        await mutate("plasticity_create_box", { originMm: [30, 0, 0], sizeMm: [2, 2, 2] });
        const second = state.bodies.find((b: any) => b.id !== first.id);
        const vertex = (b: any, p: number[]) => { const v = b.vertices.find((v: any) => v.positionMm.every((x: number, i: number) => Math.abs(x - p[i]!) < 1e-6)); ensure(v, "Native vertex missing"); return v; };
        const face = (z: number) => first.faces.find((f: any) => Math.abs(f.centerMm[2] - z) < 1e-6);
        const edge = first.edges.find((e: any) => e.centerMm.every((x: number, i: number) => Math.abs(x - [10, 0, 5][i]!) < 1e-6));
        ensure(edge, "Native edge missing");
        await call(client, "plasticity_set_view", { view: "isometric", fit: true });
        await mutate("plasticity_create_topology_distance_measurement", { first: { type: "face-center", bodyId: first.id, faceId: face(0).id }, second: { type: "face-center", bodyId: first.id, faceId: face(5).id }, name: "Thickness" });
        await mutate("plasticity_create_topology_distance_measurement", { first: { type: "face-center", bodyId: first.id, faceId: face(0).id }, second: { type: "edge-midpoint", bodyId: first.id, edgeId: edge.id }, name: "Mixed" });
        await mutate("plasticity_create_vertex_distance_measurement", { first: { bodyId: first.id, vertexId: vertex(first, [0, 0, 0]).id }, second: { bodyId: first.id, vertexId: vertex(first, [20, 0, 0]).id }, name: "Width" });
        await mutate("plasticity_create_vertex_distance_measurement", { first: { bodyId: first.id, vertexId: vertex(first, [20, 0, 0]).id }, second: { bodyId: second.id, vertexId: vertex(second, [30, 0, 0]).id }, name: "Moving" });
        // Native transforms may replace version/userData; IDs, not names, identify dimensions.
        const namesById = new Map<number, string>(state.measurements.map((m: any) => [m.id, m.name]));
        const movingId = state.measurements.find((m: any) => m.name === "Moving").id;
        const expected: Record<string, number> = { Thickness: 5, Mixed: Math.sqrt(50), Width: 20, Moving: 10 };
        evidence.phases = [];
        const check = async (phase: string, values: Record<string, number>) => {
            const listed = await call(client!, "plasticity_list_measurements", {});
            state = await call(client!, "plasticity_status", {});
            ensure(listed.measurements.length === Object.keys(values).length, "Unexpected measurement count");
            const capture = await call(client!, "plasticity_screenshot", { path: join(output, phase + "-webgl.png"), captureMode: "viewport" });
            ensure(capture.freshFrame === true, "Missing WebGL freshness proof");
            const observed = await layout(options.target!);
            evidence.lastObserved = { phase, values, measurements: listed.measurements, layout: observed };
            ensure(observed.labels.length === listed.measurements.length && observed.managed === listed.measurements.length, "HTML label/manager count mismatch");
            for (const measurement of listed.measurements) {
                const name = namesById.get(measurement.id);
                ensure(name !== undefined, "Unexpected native measurement identity");
                ensure(Math.abs(measurement.distanceMm - values[name]!) < 1e-6, "Native measurement did not update: " + name);
                const matches = observed.labels.filter((l: any) => l.versionId === String(measurement.versionId));
                ensure(matches.length === 1, "Missing or duplicate label");
                const label = matches[0];
                ensure(label.text === values[name]!.toFixed(2) + " mm", "Incorrect HTML label text");
                ensure(label.visible && label.inside && label.attached, "HTML label is outside its viewport or invisible");
                ensure(label.expected && Math.abs(label.left - label.expected.x) <= 0.5 && Math.abs(label.top - label.expected.y) <= 0.5, "HTML label anchor is stale after " + phase);
            }
            evidence.phases.push({ phase, values: { ...values }, nativeNames: listed.measurements.map((m: any) => ({ id: m.id, name: m.name })), layout: observed, capture: { captureMode: capture.captureMode, freshFrame: capture.freshFrame, rendererHidden: capture.rendererHidden } });
            delete evidence.lastObserved;
            return observed;
        };
        const beforeCamera = await check("created", expected);
        await call(client, "plasticity_set_view", { view: "top", fit: true });
        const afterCamera = await check("camera-top", expected);
        ensure(afterCamera.labels.some((l: any) => { const old = beforeCamera.labels.find((p: any) => p.versionId === l.versionId); return old && Math.hypot(l.left - old.left, l.top - old.top) > 1; }), "Camera change did not move any HTML anchor");
        await mutate("plasticity_move", { ids: [second.id], deltaMm: [5, 0, 0] });
        expected.Moving = 15;
        await check("model-moved", expected);
        await mutate("plasticity_undo", {});
        expected.Moving = 10;
        await check("move-undo", expected);
        await mutate("plasticity_redo", {});
        expected.Moving = 15;
        await check("move-redo", expected);
        await mutate("plasticity_delete_measurement", { id: movingId });
        delete expected.Moving;
        await check("deleted", expected);
        await mutate("plasticity_undo", {});
        expected.Moving = 15;
        await check("delete-undo", expected);
        ensure(state.measurements.some((m: any) => m.id === movingId), "Delete Undo changed measurement ID");
        await mutate("plasticity_redo", {});
        delete expected.Moving;
        await check("delete-redo", expected);
        for (const id of state.measurements.map((m: any) => m.id))
            await mutate("plasticity_delete_measurement", { id });
        await check("all-deleted", {});
        while (state.undoDepth > initial.undoDepth)
            await mutate("plasticity_undo", {});
        empty(state);
        const cleaned = await layout(options.target!);
        ensure(cleaned.labels.length === 0 && cleaned.managed === 0 && cleaned.helpers === 0, "Cleanup left orphan annotations");
        const changes = await call(client, "plasticity_changes_since", { snapshotId: snapshot.snapshotId });
        ensure(!hasSceneContentChanges(changes.diff), "Initial source snapshot not restored");
        const journal = await call(client, "plasticity_construction_journal", {});
        ensure(journal.durableSyncStatus === "in-sync", "Durable journal is out of sync");
        evidence.cleanup = { restoredEmpty: true, noOrphanLabels: true };
        evidence.completedAt = new Date().toISOString();
        await write(join(output, "evidence.json"), evidence);
        console.log(JSON.stringify({ ok: true, output }));
    }
    catch (error) {
        evidence.error = String(error instanceof Error ? error.message : error).slice(0, 2000);
        if (client && initial && state && !/timed out|timeout|uncertain/i.test(evidence.error))
            try {
                let current = await call(client, "plasticity_status", {});
                if (current.documentToken === initial.documentToken && current.revision === state.revision) {
                    for (let i = 0; i < 40 && current.undoDepth > initial.undoDepth; i++)
                        current = await call(client, "plasticity_undo", { revision: current.revision });
                    evidence.recovery = { restoredEmpty: current.bodies.length === 0 && current.measurements.length === 0 };
                }
            }
            catch { }
        await write(join(output, "failure.json"), evidence).catch(() => { });
        throw error;
    }
    finally {
        await client?.close().catch(() => { });
    }
}
async function layout(targetId: string): Promise<any> {
    const target = (await discoverPlasticityTargets(process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223")).find(t => t.id === targetId);
    ensure(target, "Selected target disappeared");
    const runtime = await PlasticityRuntime.connect(target);
    try {
        return await runtime.read(`function(){
    const views=Array.from(this.viewports);if(views.length!==1)throw Error('Ambiguous annotation viewport');const viewport=views[0];viewport.camera.updateMatrixWorld(true);
    const manager=this.__plasticityMcpDistanceOverlays??new Map();const rect=viewport.container.getBoundingClientRect();
    const labels=Array.from(document.querySelectorAll('[data-plasticity-mcp-distance]')).map(label=>{
      const versionId=label.dataset.plasticityMcpDistance;const tag=Array.from(manager.values()).find(t=>String(t.versionId)===versionId);
      const anchor=tag?.helper?.p1.clone().add(tag.helper.p2).multiplyScalar(.5).project(viewport.camera);const box=label.getBoundingClientRect();const style=getComputedStyle(label);
      return {versionId,text:label.textContent,left:parseFloat(label.style.left),top:parseFloat(label.style.top),expected:anchor?{x:(anchor.x+1)*viewport.container.clientWidth/2,y:(1-anchor.y)*viewport.container.clientHeight/2}:null,
        visible:style.display!=='none'&&style.visibility!=='hidden'&&box.width>0&&box.height>0,inside:box.left>=rect.left&&box.top>=rect.top&&box.right<=rect.right&&box.bottom<=rect.bottom,attached:viewport.container.contains(label),rect:{left:box.left,top:box.top,width:box.width,height:box.height}};
    });return {labels,managed:manager.size,helpers:this.helpers.scene.children.filter(h=>h.userData?.plasticityMcpMeasurementOverlay).length,rendererHidden:document.hidden};
  }`);
    }
    finally {
        runtime.close();
    }
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> { const result = await client.callTool({ name, arguments: args }); const content = (result.content as any[]).find(c => c.type === "text")?.text; ensure(typeof content === "string", "Missing tool text"); if (result.isError)
    throw Error(content); return await hydrateNativeState(JSON.parse(content), id => call(client, "plasticity_body_info", { id }), (offset, revision) => call(client, "plasticity_list_bodies", { bodyOffset: offset, bodyLimit: 100, expectedRevision: revision })); }
function empty(state: any) { ensure(state.bodies.length === 0 && state.regions.length === 0 && (state.measurements ?? []).length === 0 && (state.instances ?? []).length === 0 && (state.referenceMeshes ?? []).length === 0 && (state.sectionAnalyses ?? []).length === 0 && (state.groups ?? []).every((g: any) => g.id === 0), "Refusing annotations in a nonempty document"); }
function ensure(value: unknown, message: string): asserts value { if (!value)
    throw Error(message); }
async function write(path: string, value: unknown) { await writeFile(path, JSON.stringify(sanitizeEvidence(value), null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
    main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
