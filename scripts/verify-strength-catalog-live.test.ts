import assert from "node:assert/strict";
import test from "node:test";
import { calculateSingleFastener } from "../src/strength/fastener-calculate.ts";
import { calculateFastenerMember } from "../src/strength/fastener-member-calculate.ts";
import { calculateInsertRetention } from "../src/strength/insert-retention-calculate.ts";
import { calculateTongueRoot } from "../src/strength/tongue-root-calculate.ts";
import { calculateFastenerGroupLoad } from "../src/strength/fastener-group-calculate.ts";
import { printedThreadQualificationInputSchema } from "../src/printing/thread-qualification.ts";
import { parseStrengthCatalogArgs, strengthScenarioCases, syntheticThreadFit } from "./verify-strength-catalog-live.ts";

test("remaining strength runner is inert and requires explicit disposable authorization", () => {
  assert.equal(parseStrengthCatalogArgs([]).help, true);
  const args = ["--target", "experimental", "--allow-disposable-mutations", "--case", "scenarios", "--output", "new-dir"];
  assert.equal(parseStrengthCatalogArgs(args).case, "scenarios");
  for (const flag of ["--target", "--allow-disposable-mutations", "--case", "--output"]) {
    const copy = [...args]; copy.splice(copy.indexOf(flag), flag === "--allow-disposable-mutations" ? 1 : 2);
    assert.throws(() => parseStrengthCatalogArgs(copy), /required|new directory/);
  }
  assert.throws(() => parseStrengthCatalogArgs(["--case", "physical"]), /must be/);
});

test("reviewed remaining calculation fixtures satisfy independent numeric gates", () => {
  const fns = [calculateSingleFastener, calculateFastenerMember, calculateInsertRetention, calculateTongueRoot, calculateFastenerGroupLoad];
  for (const [index, c] of strengthScenarioCases().entries()) {
    assert.match(c.input.goal, /SYNTHETIC SOFTWARE SCENARIO ONLY/);
    const result = fns[index]!(c.input);
    assert.doesNotThrow(() => c.gate({ result }));
  }
  const input = printedThreadQualificationInputSchema.parse(syntheticThreadFit());
  assert.match(input.notes!, /no physical fit tests/);
});
