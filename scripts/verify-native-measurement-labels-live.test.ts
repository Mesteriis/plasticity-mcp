import assert from "node:assert/strict";
import test from "node:test";
import { parseMeasurementLabelsArgs } from "./verify-native-measurement-labels-live.ts";

test("HTML measurement acceptance is inert by default and requires all live guards", () => {
  assert.equal(parseMeasurementLabelsArgs([]).help, true);
  assert.equal(parseMeasurementLabelsArgs(["--help"]).help, true);
  const args = ["--target", "disposable", "--allow-disposable-mutations", "--output", "/tmp/evidence"];
  assert.equal(parseMeasurementLabelsArgs(args).target, "disposable");
  assert.throws(() => parseMeasurementLabelsArgs(args.slice(2)), /--target/);
  assert.throws(() => parseMeasurementLabelsArgs(args.filter(x => x !== "--allow-disposable-mutations")), /--allow-disposable-mutations/);
  assert.throws(() => parseMeasurementLabelsArgs(args.slice(0, 3)), /--output/);
  assert.throws(() => parseMeasurementLabelsArgs([...args, "--geometry-only"]), /cannot use/);
});

test("external window review retains explicit disposable mutation guards", () => {
  assert.throws(() => parseMeasurementLabelsArgs(["--window-review"]), /--target/);
  assert.equal(parseMeasurementLabelsArgs(["--target", "disposable", "--allow-disposable-mutations", "--output", "/tmp/review", "--window-review"]).windowReview, true);
});
