import assert from "node:assert/strict";
import { test } from "node:test";

import type { CdpClient } from "../cdp/client.ts";
import { discoverStoreBindings, SELECT_EDITOR_PROTOTYPE, SELECT_NATIVE_ROOTS, SELECT_STORE_BINDINGS, SELECT_STORE_EDITOR } from "./native-discovery.ts";

const compile = (source: string): (...args: any[]) => any => Function(`return (${source})`)();

test("heap discovery rejects ambiguous editor constructors and instances", () => {
  class Editor { open() {} save() {} exec() {} }
  const select = compile(SELECT_EDITOR_PROTOTYPE);
  assert.equal(select.call([Editor]), Editor.prototype);
  assert.throws(() => select.call([Editor, Editor]), /ambiguous/);
  const editor = { geo: { read: { geometryModel: new Map() }, lookupStableId() {} }, nodes: {}, groups: {}, empties: {} };
  const instance = compile(SELECT_STORE_EDITOR);
  assert.equal(instance.call([{}, editor]), editor);
  assert.throws(() => instance.call([editor, editor]), /ambiguous/);
});

test("kernel discovery requires an actual unique namespace and complete live enum contracts", () => {
  const kernel = { Context: { Get() {} }, Eval: class {} };
  const valid = { Polyline: 0, NURBS: 1 };
  const wrong = { Polyline: 1, NURBS: 0 };
  const extended = { ...valid, Extra: 2 };
  const select = compile(SELECT_NATIVE_ROOTS);
  const result = select.call([wrong, extended, kernel, valid], { CurveType: valid });
  assert.equal(result.kernel, kernel);
  assert.equal(result.enums.CurveType, valid);
  assert.throws(() => select.call([kernel, { ...kernel }], {}), /ambiguous/);
  assert.equal(select.call([kernel, wrong], { CurveType: valid }).enums.CurveType, undefined);
});

test("binding selection uses the editor's real math types and canonical command registry", () => {
  class ConstructionPlaneDatabase {}
  class Vector3 {}
  class Quaternion {}
  class Matrix4 {}
  class Vector2 {}
  Object.assign(Vector2.prototype, { isVector2: true });
  class DuplicateFactory {}
  const duplicate = class DuplicateFactory {};
  class BoxFactory {}
  class SphereFactory {}
  class BridgeCurveFactory {}
  class DissolveEdgeFactory {}
  class DeleteRedundantTopologyCommand {}
  class CreateCommand {}
  class SolidBody {}
  class SheetBody {}
  const editor = { commands: { CreateCommand, DeleteRedundantTopologyCommand }, viewports: [{ camera: { position: new Vector3(), quaternion: new Quaternion(), matrixWorld: new Matrix4() } }] };
  const roots = { kernel: { SolidBody, SheetBody }, enums: { CurveType: { Polyline: 0 } } };
  const result = compile(SELECT_STORE_BINDINGS).call([ConstructionPlaneDatabase, Vector2, DuplicateFactory, duplicate, BoxFactory, SphereFactory, BridgeCurveFactory, DissolveEdgeFactory], editor, roots);
  assert.equal(result.Vector3, Vector3);
  assert.equal(result.Vector2, Vector2);
  assert.equal(result.Quaternion, Quaternion);
  assert.equal(result.BoxFactory, BoxFactory);
  assert.equal(result.CreateCommand, CreateCommand);
  assert.equal(result.PossiblyBooleanSphereFactory, SphereFactory);
  assert.equal(result.BridgeVertexFactory, BridgeCurveFactory);
  assert.equal(result.DeleteEdgeFactory, DissolveEdgeFactory);
  assert.equal(result.DeleteEdgeCommand, DeleteRedundantTopologyCommand);
  assert.equal(result.DuplicateFactory, undefined, "ambiguous factories must not be picked arbitrarily");
  assert.equal(result.kernel_Solid, SolidBody);
  assert.equal(result.pk_default.a, roots.kernel);
});

test("discovery frees temporary heap arrays but retains selected objects; failures free both groups", async () => {
  for (const fail of [false, true]) {
    const groups: string[] = [], released: string[] = [];
    let next = 0;
    const client = {
      async send(method: string, args: Record<string, unknown>) {
        if (typeof args.objectGroup === "string" && !groups.includes(args.objectGroup)) groups.push(args.objectGroup);
        if (method === "Runtime.releaseObjectGroup") { released.push(String(args.objectGroup)); return {}; }
        if (method === "Runtime.releaseObject") return {};
        if (method === "Runtime.getProperties") return { result: [{ name: "Vector3", value: { objectId: "vector" } }] };
        if (fail && method === "Runtime.callFunctionOn" && args.functionDeclaration === SELECT_NATIVE_ROOTS) return { exceptionDetails: { text: "kernel missing" } };
        return { result: { objectId: `object-${next++}` } };
      },
    } as unknown as CdpClient;
    if (fail) {
      await assert.rejects(discoverStoreBindings(client), /kernel missing/);
      assert.deepEqual(new Set(released), new Set(groups));
    } else {
      const result = await discoverStoreBindings(client);
      assert.equal(result.bindings.get("Vector3"), "vector");
      assert.equal(released.length, 1);
      assert.ok(released[0]?.includes("discovery"));
    }
  }
});
