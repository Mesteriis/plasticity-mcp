import assert from "node:assert/strict";
import test from "node:test";

import { parseCodeAsterCzmAcceptance } from "./code-aster-czm-acceptance.ts";

const validOutput = [
  "Version 15.2.0 modifiée le 22/10/2020",
  " OK   NON_REGRESSION  displacement 4.6 4.6",
  " OK   NON_DEFINI      reaction 7.1 7.0",
  " OK   NON_REGRESSION  displacement 4.6 4.6",
  " OK   NON_REGRESSION  displacement 4.6 4.6",
  " OK   NON_REGRESSION  displacement 4.6 4.6",
  " OK   NON_REGRESSION  displacement 4.6 4.6",
  " OK   NON_REGRESSION  displacement 4.6 4.6",
  " OK   NON_REGRESSION  displacement 4.6 4.6",
  "EXECUTION_CODE_ASTER_EXIT_21=0",
  "Total                                6.07 2.24 8.31 6.87",
].join("\n");

test("parses a successful Code_Aster cohesive acceptance run", () => {
  assert.deepEqual(parseCodeAsterCzmAcceptance(validOutput), {
    solverVersion: "15.2.0",
    assertionCount: 8,
    elapsedSeconds: 6.87,
  });
});

test("rejects a failed Code_Aster run even when some reference checks passed", () => {
  assert.throws(() => parseCodeAsterCzmAcceptance(validOutput.replace("EXIT_21=0", "EXIT_21=3")), /exit code 3/);
});

test("rejects acceptance output with fatal diagnostics or too few checks", () => {
  assert.throws(() => parseCodeAsterCzmAcceptance(`${validOutput}\n<F>_FATAL`), /fatal or severe/);
  assert.throws(() => parseCodeAsterCzmAcceptance(validOutput.replaceAll(" OK   ", " XX   ")), /only 0 reference checks/);
  assert.throws(() => parseCodeAsterCzmAcceptance(validOutput, 9), /expected at least 9/);
  assert.throws(() => parseCodeAsterCzmAcceptance(validOutput, 0), /positive safe integer/);
});
