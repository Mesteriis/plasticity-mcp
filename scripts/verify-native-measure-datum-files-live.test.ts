import assert from "node:assert/strict";
import { test } from "node:test";

import { isolatedAcceptanceEnvironment, parseNativeMeasureDatumFilesAcceptanceArgs } from "./verify-native-measure-datum-files-live.ts";

test("native measure-datum-files acceptance is inert by default and with help", () => {
  assert.deepEqual(parseNativeMeasureDatumFilesAcceptanceArgs([]), { help: true, allowDisposableMutations: false, case: "bounds" });
  assert.equal(parseNativeMeasureDatumFilesAcceptanceArgs(["--help"]).help, true);
});

test("native measure-datum-files acceptance requires an explicit disposable target, mutation guard, and output", () => {
  assert.throws(() => parseNativeMeasureDatumFilesAcceptanceArgs(["--target", "window"]), /allow-disposable-mutations/u);
  assert.throws(() => parseNativeMeasureDatumFilesAcceptanceArgs(["--target", "window", "--allow-disposable-mutations"]), /--output/u);
  assert.deepEqual(parseNativeMeasureDatumFilesAcceptanceArgs(["--target", "window", "--allow-disposable-mutations", "--output", "/tmp/evidence"]), {
    help: false, case: "bounds", target: "window", allowDisposableMutations: true, output: "/tmp/evidence",
  });
});

test("native measure-datum-files acceptance rejects incomplete and unknown arguments", () => {
  assert.throws(() => parseNativeMeasureDatumFilesAcceptanceArgs(["--unknown"]), /Unknown argument/u);
  assert.throws(() => parseNativeMeasureDatumFilesAcceptanceArgs(["--target"]), /requires a value/u);
  assert.throws(() => parseNativeMeasureDatumFilesAcceptanceArgs(["--output"]), /requires a value/u);
});

test("catalog acceptance selects only known cases", () => {
  assert.throws(() => parseNativeMeasureDatumFilesAcceptanceArgs(["--help", "--case", "unknown"]), /Unknown catalog case/u);
  assert.throws(() => parseNativeMeasureDatumFilesAcceptanceArgs(["--case"]), /requires a value/u);
  assert.equal(parseNativeMeasureDatumFilesAcceptanceArgs(["--help", "--case", "save-open"]).case, "save-open");
  assert.equal(parseNativeMeasureDatumFilesAcceptanceArgs(["--help", "--case", "saved-plane-frames"]).case, "saved-plane-frames");
  assert.equal(parseNativeMeasureDatumFilesAcceptanceArgs(["--help", "--case", "step-provenance-geometry"]).case, "step-provenance-geometry");
});

test("acceptance scopes every persistent store and excludes unrelated runtime overrides", () => {
  const env = isolatedAcceptanceEnvironment("/tmp/acceptance", { PATH: "/bin", HOME: "/home/test", PLASTICITY_CDP_URL: "http://127.0.0.1:1234", NODE_OPTIONS: "private-preload", PLASTICITY_REFERENCE_ROOT: "/private/live-references", PLASTICITY_CONSTRUCTION_HISTORY_ROOT: "/private/live-history" });
  assert.equal(env.PLASTICITY_CDP_URL, "http://127.0.0.1:1234");
  assert.equal(env.PLASTICITY_REFERENCE_ROOT, "/tmp/acceptance/references");
  assert.equal(env.PLASTICITY_CONSTRUCTION_HISTORY_ROOT, "/tmp/acceptance/history");
  assert.equal(env.PLASTICITY_REFERENCE_ARTIFACT_ROOT, "/tmp/acceptance/reference-artifacts");
  assert.equal(env.PLASTICITY_THREAD_QUALIFICATION_ROOT, "/tmp/acceptance/thread-qualifications");
  assert.equal(env.NODE_OPTIONS, undefined);
});
