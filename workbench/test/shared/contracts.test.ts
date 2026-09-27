import assert from "node:assert/strict";
import test from "node:test";

import {
  annotationBatchSchema,
  modelVersionInputSchema,
  referenceInputSchema,
  structuredBlockInputSchema,
} from "../../src/shared/schemas.ts";

test("rejects an annotation without an immutable model version", () => {
  const result = annotationBatchSchema.safeParse({
    expectedRevision: 4,
    annotations: [
      {
        kind: "note",
        text: "move this",
        anchor: { kind: "world", pointMm: [1, 2, 3] },
      },
    ],
  });

  assert.equal(result.success, false);
});

test("distinguishes native measurements from display meshes", () => {
  const parsed = modelVersionInputSchema.parse({
    plasticityDocumentToken: "doc-1",
    plasticityRevision: "doc-1|8|3|0|21:55",
    stepArtifactHash: "a".repeat(64),
    measurements: [
      {
        key: "width",
        label: "Width",
        value: 80,
        unit: "mm",
        source: "native-brep",
        confidence: "verified",
        status: "verified",
      },
    ],
  });

  assert.equal(parsed.measurements[0]?.source, "native-brep");
});

test("rejects dimension tables with untyped rows", () => {
  const result = structuredBlockInputSchema.safeParse({
    type: "dimensions",
    title: "Critical dimensions",
    rows: [{ arbitrary: true }],
  });

  assert.equal(result.success, false);
});

test("accepts only HTTP(S) source links rendered by the Workbench", () => {
  const result = referenceInputSchema.safeParse({
    label: "Unsafe source",
    sourceKind: "official-documentation",
    format: "other",
    sourceUrl: "javascript:alert(1)",
    overallConfidence: "probable",
    dimensions: [],
    sceneRole: "functional-envelope",
  });

  assert.equal(result.success, false);
});
