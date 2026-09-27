import assert from "node:assert/strict";
import test from "node:test";

import { validateEvidence, validateSectionEvidence } from "./provenance.ts";
import { syntheticInput } from "./fixtures.test.ts";
import { sectionScenarioFixture } from "./section-fixtures.test.ts";

test("provenance reports stable duplicate, broken-reference and cycle codes", () => {
  const input = syntheticInput("axial-rectangle-v1");
  const invalid = {
    ...input,
    evidence: [
      ...input.evidence.map((item, index) => index === 0 ? { ...item, dependsOn: ["width", "missing"] } : index === 1 ? { ...item, dependsOn: ["length"] } : item),
      input.evidence[0]!,
    ],
  };
  assert.deepEqual(validateEvidence(invalid), [
    "DUPLICATE_EVIDENCE_ID:length",
    "BROKEN_DEPENDENCY:length:missing",
    "EVIDENCE_CYCLE:length",
  ]);
});

test("provenance validates assignment paths, references, units and values", () => {
  const input = syntheticInput("axial-rectangle-v1");
  const invalid = {
    ...input,
    widthMm: 11,
    assignments: { ...input.assignments, surprise: "missing", widthMm: "force" },
  };
  assert.deepEqual(validateEvidence(invalid), [
    "UNKNOWN_ASSIGNMENT_PATH:surprise",
    "BROKEN_ASSIGNMENT:surprise:missing",
    "ASSIGNMENT_UNIT_MISMATCH:widthMm:force",
    "ASSIGNMENT_VALUE_MISMATCH:widthMm:force",
  ]);
});

test("unknown evidence is retained without becoming a schema error", () => {
  const input = syntheticInput("axial-rectangle-v1");
  input.evidence.push({ id: "unknown-load-detail", label: "Unknown load detail", status: "unknown", dependsOn: [] });
  assert.deepEqual(validateEvidence(input), []);
});

test("section provenance covers every vector component and section property", () => {
  const input = sectionScenarioFixture({ freeMoments: [[1, 2, 3]] });
  assert.deepEqual(validateSectionEvidence(input), []);
  delete input.assignments["pointForces.load-1.forceN.x"];
  assert.deepEqual(validateSectionEvidence(input), ["MISSING_ASSIGNMENT:pointForces.load-1.forceN.x"]);
});
