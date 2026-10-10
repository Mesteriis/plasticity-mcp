import assert from "node:assert/strict";
import { test } from "node:test";

import { mutationOutcomeIsUncertain, PlasticityRuntime } from "./runtime.ts";
import type { CdpClient } from "../cdp/client.ts";

test("does not classify native validation text containing closed as a transport failure", () => {
  assert.equal(mutationOutcomeIsUncertain(new Error("Plasticity command failed: Profile must be a closed Wire")), false);
});

test("classifies CDP timeout and closed-connection failures as uncertain", () => {
  assert.equal(mutationOutcomeIsUncertain(new Error("CDP request timed out: Runtime.callFunctionOn")), true);
  assert.equal(mutationOutcomeIsUncertain(new Error("CDP connection is closed")), true);
  assert.equal(mutationOutcomeIsUncertain(new Error("CDP connection closed before the request completed")), true);
});

test("reconnects to Plasticity and reacquires its live editor and native bindings", async () => {
  let generation = 0;
  const editorIds: string[] = [];
  const constructorIds: string[] = [];
  const closed: number[] = [];
  const failMethod: string[] = [];
  const makeClient = (failedMethod?: string): CdpClient => {
    const index = closed.length;
    closed.push(0);
    return {
      async send(method: string, params: Record<string, unknown> = {}) {
        if (method === "Runtime.enable") {
          if (method === failedMethod) throw new Error(`Replacement ${method} failed`);
          return {};
        }
        if (method === "Runtime.evaluate") {
          if (method === failedMethod) throw new Error(`Replacement ${method} failed`);
          generation += 1;
          return { result: { objectId: `handler-${generation}` } };
        }
        if (method === "Runtime.getProperties") {
          const objectId = params.objectId;
          const current = generation;
          if (objectId === `handler-${current}`) return { result: [], internalProperties: [{ name: "[[Scopes]]", value: { objectId: `scopes-${current}` } }] };
          if (objectId === `scopes-${current}`) return { result: [
            { name: "0", value: { objectId: `closure-${current}` } },
            { name: "1", value: { objectId: `native-${current}` } },
          ] };
          if (objectId === `closure-${current}`) return { result: [{ name: "editor", value: { objectId: `editor-${current}` } }] };
          if (objectId === `native-${current}`) return { result: [{ name: "Vector3", value: { objectId: `Vector3-${current}` } }] };
          throw new Error(`Unexpected object: ${String(objectId)}`);
        }
        if (method === "Runtime.releaseObject") return {};
        if (method === "Runtime.callFunctionOn") {
          editorIds.push(String(params.objectId));
          const args = params.arguments as Array<{ objectId?: string }>;
          constructorIds.push(String(args[0]?.objectId));
          return { result: { value: "read-result" } };
        }
        throw new Error(`Unexpected CDP method: ${method}`);
      },
      close() { closed[index] = (closed[index] ?? 0) + 1; },
    } as unknown as CdpClient;
  };
  const client = makeClient();
  const RuntimeConstructor = PlasticityRuntime as unknown as new (client: CdpClient, target: { id: string; title: string; webSocketDebuggerUrl: string }, editorId: string, connectClient: (url: string) => Promise<CdpClient>) => PlasticityRuntime;
  const runtime = new RuntimeConstructor(client, { id: "window-1", title: "Part", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/1" }, "stale-editor", async () => makeClient(failMethod.shift()));

  await runtime.reconnect();
  assert.equal(await runtime.readNative("function (Vector3) { return 'ok'; }", ["Vector3"]), "read-result");
  assert.equal(await runtime.readNative("function (Vector3) { return 'ok'; }", ["Vector3"]), "read-result");
  failMethod.push("Runtime.evaluate");
  await assert.rejects(runtime.reconnect(), /Replacement Runtime.evaluate failed/);
  assert.equal(await runtime.readNative("function (Vector3) { return 'ok'; }", ["Vector3"]), "read-result");
  await runtime.reconnect();
  assert.equal(await runtime.readNative("function (Vector3) { return 'ok'; }", ["Vector3"]), "read-result");

  assert.deepEqual(editorIds, ["editor-1", "editor-1", "editor-1", "editor-2"]);
  assert.deepEqual(constructorIds, ["Vector3-1", "Vector3-1", "Vector3-1", "Vector3-2"]);
  assert.equal(closed[2], 1, "failed replacement client should close once");
});

test("reads a body version's native topology once and reuses it until the body changes", async () => {
  const calls = { FindBox: 0, GetFaces: 0, GetEdges: 0 };
  const point = (x: number, y: number, z: number) => ({ x, y, z });
  class Solid {}
  class Plane {}
  const makeItem = () => {
    const vertex = { Id: () => 7, GetPoint: () => point(0, 0, 0), GetEdges: () => undefined, GetFaces: () => undefined };
    const face = {
      Id: () => 101,
      FindMidpoint: () => ({ position: point(0.001, 0, 0), normal: point(0, 0, 1) }),
      GetSurface: () => ({ surface: new Plane() }),
      GetEdges: () => ({ Size: () => 1, Get: () => edge }),
      GetRadius: () => NaN,
      GetBlendRadius: () => NaN,
      IsPlanar: () => true,
    };
    const edge = {
      Id: () => 201,
      GetPointAndTangent: () => ({ position: point(0, 0, 0), tangent: point(1, 0, 0) }),
      FindLength: () => ({ length: 0.002 }),
      GetCurve: () => ({ curve: {} }),
      IsCircle: () => false,
      IsLine: () => true,
      GetFaces: () => ({ Size: () => 1, Get: () => face }),
      GetVertices: () => ({ left: vertex, right: undefined }),
    };
    const box = { min: point(0, 0, 0), max: point(0.002, 0.001, 0) };
    const views = (entityId: number, versionId: string) => ({ versionIds: [versionId], get: () => ({ entityId, getBoundingBox: () => box }) });
    return {
      view: Object.assign(new Solid(), { high: { faces: views(101, "11"), edges: views(201, "12") } }),
      model: {
        FindBox() { calls.FindBox += 1; return box; },
        GetFaces() { calls.GetFaces += 1; return { Size: () => 1, Get: () => face }; },
        GetEdges() { calls.GetEdges += 1; return { Size: () => 1, Get: () => edge }; },
      },
    };
  };
  const geometryModel = new Map([[21, makeItem()]]);
  const unit = point(0, 0, 1);
  const plane = { name: "Top", p: point(0, 0, 0), n: unit, x: point(1, 0, 0), y: point(0, 1, 0) };
  const editor = {
    planes: { snapshot: () => ({ ids: new Map(), planes: [] }) },
    viewports: [],
    geo: { geometryModel, automatics: new Set() },
    db: {
      version: 1,
      lookupStableId: (versionId: number) => (versionId === 21 || versionId === 22 ? 5 : undefined),
      nodes: {
        item2key: () => 1,
        getName: () => "Plate",
        getMaterialId: () => 0,
        isVisible: () => true,
        isHidden: () => false,
        isLocked: () => false,
      },
      empties: { snapshot: () => ({ empties: [], infos: [] }) },
      groups: { snapshot: () => ({ groupIds: [], children: [], currentGroupId: 0 }) },
    },
    materials: { list: () => [] },
    measurements: { snapshot: () => ({ repo: { measurements: [] } }) },
    document: { uuid: "document-1" },
    history: { undoStack: [], redoStack: [] },
  };
  const natives: Record<string, unknown> = {
    ConstructionPlaneDatabase: { Top: plane, Bottom: plane, Left: plane, Right: plane, Front: plane, Back: plane },
    Vector3: class {},
    Quaternion: class {},
  };
  const client = {
    async send(method: string, params: Record<string, unknown> = {}) {
      assert.equal(method, "Runtime.callFunctionOn");
      const args = (params.arguments as Array<{ objectId?: string }>).map((arg) => natives[String(arg.objectId)]);
      const execute = new Function(`return (${String(params.functionDeclaration)})`)() as (...values: unknown[]) => unknown;
      return { result: { value: JSON.parse(JSON.stringify(execute.apply(editor, args))) } };
    },
    close() {},
  } as unknown as CdpClient;
  const RuntimeConstructor = PlasticityRuntime as unknown as new (client: CdpClient, target: { id: string; title: string; webSocketDebuggerUrl: string }, editorId: string) => PlasticityRuntime;
  const runtime = new RuntimeConstructor(client, { id: "window-1", title: "Part", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/1" }, "editor");
  const bindings = (runtime as unknown as { bindings: Map<string, string> }).bindings;
  for (const name of Object.keys(natives)) bindings.set(name, name);

  const first = await runtime.getState();
  const second = await runtime.getState();
  assert.deepEqual(calls, { FindBox: 1, GetFaces: 1, GetEdges: 1 });
  assert.deepEqual(second.bodies, first.bodies);
  assert.equal(first.bodies[0]?.faces[0]?.id, "11");
  assert.deepEqual(first.bodies[0]?.edges[0]?.faceIds, ["11"]);
  assert.deepEqual(first.bodies[0]?.boundsMm, { min: [0, 0, 0], max: [2, 1, 0] });

  editor.db.nodes.getName = () => "Renamed plate";
  const renamed = await runtime.getState();
  assert.equal(renamed.bodies[0]?.name, "Renamed plate");
  assert.deepEqual(calls, { FindBox: 1, GetFaces: 1, GetEdges: 1 });

  const item = geometryModel.get(21)!;
  geometryModel.clear();
  geometryModel.set(22, item);
  await runtime.getState();
  assert.deepEqual(calls, { FindBox: 2, GetFaces: 2, GetEdges: 2 }, "a new versionId on the same view rereads the topology");

  geometryModel.set(22, makeItem());
  await runtime.getState();
  assert.deepEqual(calls, { FindBox: 3, GetFaces: 3, GetEdges: 3 }, "a new view rereads the topology");
});
