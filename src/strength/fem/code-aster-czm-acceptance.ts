export interface CodeAsterCzmAcceptance {
  solverVersion: string;
  assertionCount: number;
  elapsedSeconds: number;
}

export function parseCodeAsterCzmAcceptance(output: string, minimumReferenceAssertions = 8): CodeAsterCzmAcceptance {
  if (!Number.isSafeInteger(minimumReferenceAssertions) || minimumReferenceAssertions < 1) {
    throw new Error("minimumReferenceAssertions must be a positive safe integer");
  }
  const version = output.match(/Version\s+(\d+\.\d+\.\d+)\s+modifi[ée]e/i)?.[1];
  if (!version) throw new Error("Code_Aster acceptance output is missing the solver version");

  const exitCode = output.match(/EXECUTION_CODE_ASTER_EXIT_\d+=(\d+)/)?.[1];
  if (exitCode !== "0") throw new Error(`Code_Aster cohesive acceptance job failed with exit code ${exitCode ?? "missing"}`);

  if (/<(?:F|S)>_/i.test(output)) throw new Error("Code_Aster cohesive acceptance output contains a fatal or severe diagnostic");
  const assertionCount = [...output.matchAll(/^\s*OK\s+(?:NON_REGRESSION|NON_DEFINI)\b/gm)].length;
  if (assertionCount < minimumReferenceAssertions) throw new Error(`Code_Aster cohesive acceptance passed only ${assertionCount} reference checks; expected at least ${minimumReferenceAssertions}`);

  const elapsed = output.match(/Total\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+(\d+(?:\.\d+)?)/)?.[1];
  if (!elapsed) throw new Error("Code_Aster acceptance output is missing total elapsed time");

  return { solverVersion: version, assertionCount, elapsedSeconds: Number(elapsed) };
}
