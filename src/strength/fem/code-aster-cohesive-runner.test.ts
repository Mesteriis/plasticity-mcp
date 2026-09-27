import assert from "node:assert/strict";
import test from "node:test";

import { assertCodeAsterCohesiveRunSucceeded, assertCohesiveResultTableSize, buildCodeAsterDockerArgs } from "./code-aster-cohesive-runner.ts";

const successLog = `Code_Aster 15.02.00
EXECUTION_CODE_ASTER_EXIT_18=0
<A>_ALARM numerical advisory`;

test("accepts only zero-exit Code_Aster jobs with a solver success marker and no fatal diagnostics", () => {
  assert.doesNotThrow(() => assertCodeAsterCohesiveRunSucceeded(0, successLog, ""));
  assert.throws(() => assertCodeAsterCohesiveRunSucceeded(0, "Code_Aster 15.02.00", ""), /missing the solver success marker/);
  assert.throws(() => assertCodeAsterCohesiveRunSucceeded(0, successLog.replace("EXIT_18=0", "EXIT_18=1"), ""), /reported exit code 1/);
  assert.throws(() => assertCodeAsterCohesiveRunSucceeded(0, `${successLog}\n<F>_FATAL`, ""), /fatal or severe diagnostic/);
  assert.throws(() => assertCodeAsterCohesiveRunSucceeded(3, successLog, ""), /container exited with code 3/);
  assert.throws(
    () => assertCodeAsterCohesiveRunSucceeded(1, "command setup\n<S>_NO_CONVERGENCE\nEXECUTION_CODE_ASTER_EXIT_18=1", ""),
    /command setup[\s\S]*NO_CONVERGENCE/,
  );
});

test("runs with the host UID while supplying a stable Linux login name for Code_Aster", () => {
  const args = buildCodeAsterDockerArgs("/tmp/cohesive-work", 501, 20);
  assert.equal(args[args.indexOf("--user") + 1], "501:20");
  assert.ok(args.includes("LOGNAME=aster"));
  assert.ok(args.includes("USER=aster"));
  assert.ok(args.includes("--network=none"));
  const v17 = buildCodeAsterDockerArgs("/tmp/cohesive-work", 501, 20, "17.4");
  assert.ok(v17.includes("simvia/code_aster@sha256:d8d19ea91989eac0d38195bc5795c54c69f530f7196f53d67697ffa57c9106d5"));
  assert.ok(v17.some((argument) => argument.includes("/opt/spack/opt/spack/linux-zen2/code-aster-17.4.0-ecm2bfgr5obydotnlte6xilvggppqnap/bin/run_aster cohesive.export")));
  assert.ok(v17.includes("--network=none"));
});

test("bounds cohesive state-table output before running large jobs", () => {
  assert.doesNotThrow(() => assertCohesiveResultTableSize(10, 10));
  assert.doesNotThrow(() => assertCohesiveResultTableSize(1, 250));
  assert.throws(() => assertCohesiveResultTableSize(1, 251), /too large/);
  assert.throws(() => assertCohesiveResultTableSize(100_000, 10), /too large/);
});
