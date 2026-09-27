import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AnalysisClientError, type AnalysisClient } from "../codex/analysis-client.ts";
import type { AnalysisRequest, AnalysisResult } from "./contracts.ts";
import { analyzeRequest } from "./analyze.ts";
import { StrengthStore } from "./store.ts";

test("same request ID returns stored completion without a second paid call", async (context) => {
  const { store, client } = await harness(context, [{ observations: [], proposedMethod: null, questions: [], unsupportedConditions: [], designInterpretation: null }]);
  const first = await analyzeRequest(request("same"), store, client);
  const second = await analyzeRequest(request("same"), store, client);
  assert.equal(first.state, "completed");
  assert.deepEqual(second, first);
  assert.equal(client.calls, 1);
});

test("interrupted requests are not retried and a new ID is required", async (context) => {
  const cancelled = Object.assign(new Error("cancelled"), { code: "ANALYSIS_CANCELLED" });
  const { store, client } = await harness(context, [cancelled, { observations: [], proposedMethod: null, questions: [], unsupportedConditions: [], designInterpretation: null }]);
  const first = await analyzeRequest(request("old"), store, client);
  const duplicate = await analyzeRequest(request("old"), store, client);
  const replacement = await analyzeRequest(request("new"), store, client);
  assert.equal(first.state, "interrupted");
  assert.equal(duplicate.state, "interrupted");
  assert.equal(replacement.state, "completed");
  assert.equal(client.calls, 2);
});

test("Codex provider failure category is stored without persisting raw error text", async (context) => {
  const providerError = new AnalysisClientError("CODEX_TURN_FAILED", "Codex analysis turn ended as failed", {
    category: "rateLimitExceeded",
    httpStatusCode: 429,
    message: "Synthetic provider failure",
  });
  const { store, client } = await harness(context, [providerError]);
  const record = await analyzeRequest(request("provider-failure"), store, client);
  assert.equal(record.state, "failed");
  assert.equal(record.errorCode, "CODEX_TURN_FAILED");
  assert.deepEqual(record.failureDiagnostics, {
    category: "rateLimitExceeded",
    httpStatusCode: 429,
    message: "Synthetic provider failure",
  });
  assert.deepEqual(await store.readRequest("provider-failure"), record);
  assert.equal(JSON.stringify(record).includes("Codex analysis turn ended as failed"), false);
});

test("same ID with different analysis content is a conflict", async (context) => {
  const { store, client } = await harness(context, [{ observations: [], proposedMethod: null, questions: [], unsupportedConditions: [], designInterpretation: null }]);
  await analyzeRequest(request("same"), store, client);
  await assert.rejects(() => analyzeRequest({ ...request("same"), prompt: "changed" }, store, client), /conflict/i);
});

test("same request ID conflicts when an image at the same path has changed", async (context) => {
  const { store, client } = await harness(context, [{ observations: [], proposedMethod: null, questions: [], unsupportedConditions: [], designInterpretation: null }]);
  const imageRoot = await mkdtemp(join(tmpdir(), "plasticity-image-identity-"));
  context.after(() => rm(imageRoot, { recursive: true, force: true }));
  const imagePath = join(imageRoot, "sketch.png");
  await writeFile(imagePath, "first image bytes");
  const input = { ...request("same-image"), imagePaths: [imagePath] };

  const first = await analyzeRequest(input, store, client);
  const replay = await analyzeRequest(input, store, client);
  assert.deepEqual(replay, first);
  assert.equal(client.calls, 1);
  await writeFile(imagePath, "different image bytes");
  await assert.rejects(() => analyzeRequest(input, store, client), /conflict/i);
  assert.equal(client.calls, 1);
});

test("invalid multi-question analysis is rejected and never persisted as completed", async (context) => {
  const invalid = {
    observations: [],
    proposedMethod: null,
    questions: [
      { id: "q-load", question: "What load applies?", resolves: ["load"], reason: "Load is needed next." },
      { id: "q-material", question: "What material?", resolves: ["material"], reason: "Material is needed later." },
    ],
    unsupportedConditions: [],
    designInterpretation: null,
  };
  const { store, client } = await harness(context, [invalid as AnalysisResult]);
  const record = await analyzeRequest(request("multi-question"), store, client);
  assert.equal(record.state, "failed");
  assert.equal(record.errorCode, "INVALID_ANALYSIS_RESULT");
  assert.equal(client.calls, 1);
});

test("reference design analysis requires structured geometry intent and explicit scale confidence", async (context) => {
  const designInterpretation = {
    articleType: "bracket",
    functionalIntent: "Supports an enclosure from a vertical panel",
    scaleStatus: "unscaled",
    interfaces: [{ id: "mount", kind: "mounting", description: "Two visible fastener locations", confidence: "probable", evidenceIds: ["feature-holes"] }],
    featureCandidates: [{ id: "feature-holes", type: "hole", description: "Two mounting holes", confidence: "probable", evidenceIds: ["feature-holes"] }],
  };
  const { store, client } = await harness(context, [
    { observations: [{ id: "feature-holes", label: "Two visible round mounting features", status: "unknown", dependsOn: [] }], proposedMethod: null, questions: [{ id: "q-function", question: "What will the bracket support and how is it mounted?", resolves: ["functionalIntent", "mounting"], reason: "The load path is needed before choosing the section." }], unsupportedConditions: [], designInterpretation } as AnalysisResult,
    { observations: [], proposedMethod: null, questions: [], unsupportedConditions: [], designInterpretation: null },
    { observations: [
      { id: "scale", label: "No known scale marker in the image", status: "unknown", dependsOn: [] },
      { id: "width", label: "Inferred image width", status: "derived", unit: "mm", value: 35, dependsOn: [] },
    ], proposedMethod: null, questions: [], unsupportedConditions: [], designInterpretation } as AnalysisResult,
    { observations: [{ id: "bad-source", label: "Unsupported view reference", status: "unknown", sourceImageIndices: [2], dependsOn: [] }], proposedMethod: null, questions: [], unsupportedConditions: [], designInterpretation: { ...designInterpretation, interfaces: [{ ...designInterpretation.interfaces[0]!, evidenceIds: ["bad-source"] }], featureCandidates: [{ ...designInterpretation.featureCandidates[0]!, evidenceIds: ["bad-source"] }] } } as AnalysisResult,
    { observations: [{ id: "duplicate", label: "First claim", status: "unknown", dependsOn: [] }, { id: "duplicate", label: "Conflicting claim", status: "unknown", dependsOn: [] }], proposedMethod: null, questions: [], unsupportedConditions: [], designInterpretation: { ...designInterpretation, interfaces: [{ ...designInterpretation.interfaces[0]!, evidenceIds: ["duplicate"] }], featureCandidates: [{ ...designInterpretation.featureCandidates[0]!, evidenceIds: ["duplicate"] }] } } as AnalysisResult,
  ]);
  const designRequest = { ...request("design-reference"), analysisMode: "design-reference" as const, prompt: "Reconstruct this bracket from the attached unscaled sketch" };
  const completed = await analyzeRequest(designRequest, store, client);
  assert.equal(completed.state, "completed");
  assert.equal(completed.result?.designInterpretation?.scaleStatus, "unscaled");
  assert.equal(completed.result?.questions.length, 1);
  const missingDesign = await analyzeRequest({ ...designRequest, requestId: "missing-design" }, store, client);
  assert.equal(missingDesign.state, "failed");
  assert.equal(missingDesign.errorCode, "INVALID_ANALYSIS_RESULT");
  const inventedScale = await analyzeRequest({ ...designRequest, requestId: "invented-scale" }, store, client);
  assert.equal(inventedScale.state, "failed");
  assert.equal(inventedScale.errorCode, "INVALID_ANALYSIS_RESULT");
  const badImageIndex = await analyzeRequest({ ...designRequest, requestId: "bad-image-index", imagePaths: ["front.png"] }, store, client);
  assert.equal(badImageIndex.state, "failed");
  assert.equal(badImageIndex.errorCode, "INVALID_ANALYSIS_RESULT");
  const duplicateEvidenceIds = await analyzeRequest({ ...designRequest, requestId: "duplicate-evidence-ids" }, store, client);
  assert.equal(duplicateEvidenceIds.state, "failed");
  assert.equal(duplicateEvidenceIds.errorCode, "INVALID_ANALYSIS_RESULT");
});

test("dimensioned or calibrated references require every numeric geometry measurement to have its own traceable source", async (context) => {
  const dimensioned: NonNullable<AnalysisResult["designInterpretation"]> = {
    articleType: "mounting plate",
    functionalIntent: "A flat plate with two holes",
    scaleStatus: "dimensioned",
    interfaces: [],
    featureCandidates: [],
  };
  const dimensionedWithClaim = {
    ...dimensioned,
    interfaces: [{ id: "plate-width", kind: "other", description: "Overall width 80 mm", confidence: "clear", evidenceIds: ["overall-width"] }],
  } satisfies NonNullable<AnalysisResult["designInterpretation"]>;
  const unsupported = {
    observations: [], proposedMethod: null, questions: [], unsupportedConditions: [],
    designInterpretation: dimensioned,
  } as AnalysisResult;
  const supported = {
    observations: [{
      id: "overall-width", label: "Front-view overall width 80 mm", status: "measured",
      sourceImageIndices: [1], unit: "mm", value: 80, sourceLocator: "dimension line below front view", dependsOn: [],
    }],
    proposedMethod: null, questions: [], unsupportedConditions: [], designInterpretation: dimensionedWithClaim,
  } as AnalysisResult;
  const unsupportedAdditionalMeasurement = {
    observations: [
      { id: "overall-width", label: "Front-view overall width 80 mm", status: "measured", sourceImageIndices: [1], unit: "mm", value: 80, sourceLocator: "dimension line below front view", dependsOn: [] },
      { id: "hole-offset", label: "Estimated hole offset 12 mm", status: "measured", unit: "mm", value: 12, dependsOn: [] },
    ],
    proposedMethod: null, questions: [], unsupportedConditions: [], designInterpretation: dimensioned,
  } as AnalysisResult;
  const assumedAdditionalMeasurement = {
    observations: [
      { id: "overall-width", label: "Front-view overall width 80 mm", status: "measured", sourceImageIndices: [1], unit: "mm", value: 80, sourceLocator: "dimension line below front view", dependsOn: [] },
      { id: "assumed-thickness", label: "Assumed thickness 4 mm", status: "assumed", unit: "mm", value: 4, dependsOn: [] },
    ],
    proposedMethod: null, questions: [], unsupportedConditions: [], designInterpretation: dimensioned,
  } as AnalysisResult;
  const unstructuredAdditionalMeasurement = {
    observations: [
      { id: "overall-width", label: "Front-view overall width 80 mm", status: "measured", sourceImageIndices: [1], unit: "mm", value: 80, sourceLocator: "dimension line below front view", dependsOn: [] },
      { id: "hole-offset", label: "Estimated hole offset 12 mm", status: "unknown", dependsOn: [] },
    ],
    proposedMethod: null, questions: [], unsupportedConditions: [], designInterpretation: dimensioned,
  } as AnalysisResult;
  const imageMeasurementWithoutLocator = {
    observations: [{
      id: "hole-diameter", label: "Hole diameter 6 mm", status: "measured", sourceImageIndices: [1], unit: "mm", value: 6, dependsOn: [],
    }],
    proposedMethod: null, questions: [], unsupportedConditions: [], designInterpretation: dimensioned,
  } as AnalysisResult;
  const untraceableDimensionClaim = {
    ...supported,
    designInterpretation: {
      ...dimensioned,
      interfaces: [{ id: "mounting", kind: "mounting", description: "Hole offset 12 mm", confidence: "clear", evidenceIds: ["overall-width"] }],
    },
  } as AnalysisResult;
  const calibrated: NonNullable<AnalysisResult["designInterpretation"]> = {
    ...dimensioned,
    scaleStatus: "calibrated",
  };
  const userCalibrated = {
    observations: [{
      id: "known-ruler-length", label: "User confirms reference length 50 mm", status: "sourced",
      unit: "mm", value: 50, sourceLocator: "answer:q-scale", dependsOn: [],
    }],
    proposedMethod: null, questions: [], unsupportedConditions: [], designInterpretation: calibrated,
  } as AnalysisResult;
  const { store, client } = await harness(context, [unsupported, supported, unsupportedAdditionalMeasurement, assumedAdditionalMeasurement, unstructuredAdditionalMeasurement, imageMeasurementWithoutLocator, untraceableDimensionClaim, userCalibrated]);
  const requestWithImage = {
    ...request("dimensioned-no-basis"),
    analysisMode: "design-reference" as const,
    imagePaths: ["dimensioned-drawing.png"],
  };

  const missingBasis = await analyzeRequest(requestWithImage, store, client);
  assert.equal(missingBasis.state, "failed");
  assert.equal(missingBasis.errorCode, "INVALID_ANALYSIS_RESULT");

  const withBasis = await analyzeRequest({ ...requestWithImage, requestId: "dimensioned-with-basis" }, store, client);
  assert.equal(withBasis.state, "completed");
  assert.equal(withBasis.result?.designInterpretation?.scaleStatus, "dimensioned");

  const withoutTraceableAdditionalMeasurement = await analyzeRequest({
    ...requestWithImage,
    requestId: "dimensioned-with-untraceable-measurement",
  }, store, client);
  assert.equal(withoutTraceableAdditionalMeasurement.state, "failed");
  assert.equal(withoutTraceableAdditionalMeasurement.errorCode, "INVALID_ANALYSIS_RESULT");

  const withAssumedAdditionalMeasurement = await analyzeRequest({
    ...requestWithImage,
    requestId: "dimensioned-with-assumed-measurement",
  }, store, client);
  assert.equal(withAssumedAdditionalMeasurement.state, "failed");
  assert.equal(withAssumedAdditionalMeasurement.errorCode, "INVALID_ANALYSIS_RESULT");

  const withUnstructuredAdditionalMeasurement = await analyzeRequest({
    ...requestWithImage,
    requestId: "dimensioned-with-unstructured-measurement",
  }, store, client);
  assert.equal(withUnstructuredAdditionalMeasurement.state, "failed");
  assert.equal(withUnstructuredAdditionalMeasurement.errorCode, "INVALID_ANALYSIS_RESULT");

  const withImageMeasurementWithoutLocator = await analyzeRequest({
    ...requestWithImage,
    requestId: "dimensioned-image-measurement-without-locator",
  }, store, client);
  assert.equal(withImageMeasurementWithoutLocator.state, "failed");
  assert.equal(withImageMeasurementWithoutLocator.errorCode, "INVALID_ANALYSIS_RESULT");

  const withUntraceableDimensionClaim = await analyzeRequest({
    ...requestWithImage,
    requestId: "dimensioned-with-untraceable-claim",
  }, store, client);
  assert.equal(withUntraceableDimensionClaim.state, "failed");
  assert.equal(withUntraceableDimensionClaim.errorCode, "INVALID_ANALYSIS_RESULT");

  const withUserCalibration = await analyzeRequest({
    ...requestWithImage,
    requestId: "calibrated-from-answer",
    answers: [{ questionId: "q-scale", question: "What known dimension is shown?", answer: "That reference is 50 mm." }],
  }, store, client);
  assert.equal(withUserCalibration.state, "completed");
  assert.equal(withUserCalibration.result?.designInterpretation?.scaleStatus, "calibrated");
});

class FakeClient implements AnalysisClient {
  calls = 0;
  private readonly outcomes: (AnalysisResult | Error)[];
  constructor(outcomes: (AnalysisResult | Error)[]) { this.outcomes = outcomes; }
  async fingerprintImages(paths: string[]): Promise<string[]> {
    return await Promise.all(paths.map(async (path) => {
      try { return createHash("sha256").update(await readFile(path)).digest("hex"); }
      catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
          return createHash("sha256").update(`test-fixture:${path}`).digest("hex");
        }
        throw error;
      }
    }));
  }
  async run(): Promise<AnalysisResult> {
    const outcome = this.outcomes[this.calls++];
    if (outcome instanceof Error) throw outcome;
    if (!outcome) throw new Error("No fake outcome");
    return outcome;
  }
  async close(): Promise<void> {}
}

function request(id: string): AnalysisRequest {
  return { requestId: id, prompt: "analyze", imagePaths: [], evidence: [], answers: [] };
}

async function harness(context: test.TestContext, outcomes: (AnalysisResult | Error)[]): Promise<{ store: StrengthStore; client: FakeClient }> {
  const root = await mkdtemp(join(tmpdir(), "plasticity-analyze-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return { store: new StrengthStore(root), client: new FakeClient(outcomes) };
}
