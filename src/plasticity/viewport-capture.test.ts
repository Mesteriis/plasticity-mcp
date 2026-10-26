import assert from "node:assert/strict";
import test from "node:test";
import { NATIVE_VIEWPORT_CAPTURE } from "./viewport-capture.ts";

const capture = Function("document", `return (${NATIVE_VIEWPORT_CAPTURE})`)({ hidden: true });
function fixture() {
  const calls: string[] = [];
  const context = { isContextLost: () => false };
  const viewport = {
    needsRender: false, lastFrameNumber: 0,
    renderer: { isWebGLRenderer: true, getContext: () => context, info: { render: { frame: 2 } },
      domElement: { width: 100, height: 80, toDataURL: (_format: string) => { calls.push("encode"); return "data:image/png;base64,AQ=="; } } },
    setNeedsRender() { calls.push("request"); this.needsRender = true; },
    handleRender(time: number) { calls.push("draw"); this.renderer.info.render.frame += 2; this.lastFrameNumber = time; this.needsRender = false; },
  };
  const editor = { executor: { isBusy: false }, viewports: new Set([viewport]) };
  return { viewport, editor, calls };
}

test("viewport capture encodes synchronously only after a verified native frame, even if hidden", () => {
  const { editor, calls } = fixture();
  assert.deepEqual(capture.call(editor), { data: "AQ==", width: 100, height: 80, rendererHidden: true, freshFrame: true });
  assert.deepEqual(calls, ["request", "draw", "encode"]);
});

test("busy, ambiguous, unsupported, invalid-sized and lost-context viewports fail closed", () => {
  for (const configure of [
    (f: ReturnType<typeof fixture>) => { f.editor.executor.isBusy = true; },
    (f: ReturnType<typeof fixture>) => { f.editor.viewports.clear(); },
    (f: ReturnType<typeof fixture>) => { f.editor.viewports.add({ ...f.viewport }); },
    (f: ReturnType<typeof fixture>) => { f.viewport.renderer.isWebGLRenderer = false; },
    (f: ReturnType<typeof fixture>) => { f.viewport.renderer.getContext = () => ({ isContextLost: () => true }); },
    (f: ReturnType<typeof fixture>) => { f.viewport.renderer.domElement.width = 0; },
    (f: ReturnType<typeof fixture>) => { f.viewport.renderer.info.render.frame = NaN; },
  ]) {
    const f = fixture(); configure(f); assert.throws(() => capture.call(f.editor)); assert.deepEqual(f.calls, []);
  }
});

test("a stale, unfinished or lost native frame is never encoded", () => {
  for (const mode of ["counter", "time", "unfinished", "lost"]) {
    const f = fixture();
    f.viewport.handleRender = function(time) {
      if (mode !== "counter") this.renderer.info.render.frame += 1;
      if (mode !== "time") this.lastFrameNumber = time;
      if (mode !== "unfinished") this.needsRender = false;
      if (mode === "lost") this.renderer.getContext = () => ({ isContextLost: () => true });
    };
    assert.throws(() => capture.call(f.editor), /did not complete a fresh frame/);
    assert.deepEqual(f.calls, ["request"]);
  }
});


test("context loss during PNG encoding rejects the captured image", () => {
  const f = fixture();
  f.viewport.renderer.domElement.toDataURL = () => { f.viewport.renderer.getContext().isContextLost = () => true; return "data:image/png;base64,AQ=="; };
  assert.throws(() => capture.call(f.editor), /lost during capture/);
});
