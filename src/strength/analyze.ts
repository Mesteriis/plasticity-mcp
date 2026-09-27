import { AnalysisClientError, type AnalysisClient } from "../codex/analysis-client.ts";
import type { AnalysisRequest, AnalysisResult } from "./contracts.ts";
import { analysisResultSchema } from "./schemas.ts";
import { inputHash, type RequestRecord, StrengthStore } from "./store.ts";

export async function analyzeRequest(
  request: AnalysisRequest,
  store: StrengthStore,
  client: AnalysisClient,
  signal?: AbortSignal,
): Promise<RequestRecord> {
  let imageHashes: string[] = [];
  let fingerprintError: unknown;
  try {
    imageHashes = await client.fingerprintImages(request.imagePaths, signal);
  } catch (error) {
    fingerprintError = error;
  }
  const hash = inputHash({
    request,
    imageHashes,
    ...(fingerprintError === undefined ? {} : { fingerprintErrorCode: analysisErrorCode(fingerprintError) }),
  });
  if (!(await store.beginRequest(request.requestId, hash))) return store.readRequest(request.requestId);
  try {
    if (fingerprintError !== undefined) throw fingerprintError;
    const rawResult = await client.run(request, {
      timeoutMs: 120_000,
      expectedImageHashes: imageHashes,
      ...(signal === undefined ? {} : { signal }),
    });
    const parsed = analysisResultSchema.safeParse(rawResult);
    if (!parsed.success) {
      throw Object.assign(new Error(`Analysis result failed validation: ${parsed.error.message}`), { code: "INVALID_ANALYSIS_RESULT" });
    }
    const result = parsed.data as AnalysisResult;
    const imageEvidence = [...request.evidence, ...result.observations];
    if (imageEvidence.some((item) => item.sourceImageIndices?.some((index) => index > request.imagePaths.length))) {
      throw Object.assign(new Error("Evidence references an image index that was not supplied in this request"), { code: "INVALID_ANALYSIS_RESULT" });
    }
    if (request.analysisMode !== "design-reference" && result.designInterpretation !== null) {
      throw Object.assign(new Error("Strength analysis must not include a CAD design interpretation"), { code: "INVALID_ANALYSIS_RESULT" });
    }
    if (request.analysisMode === "design-reference") {
      if (!result.designInterpretation || result.proposedMethod !== null) {
        throw Object.assign(new Error("Design reference analysis must include a structured interpretation and no strength method"), { code: "INVALID_ANALYSIS_RESULT" });
      }
      const allEvidence = [...request.evidence, ...result.observations];
      const evidenceIds = new Set(allEvidence.map((item) => item.id));
      if (evidenceIds.size !== allEvidence.length) {
        throw Object.assign(new Error("Design reference evidence IDs must be unique across supplied and returned observations"), { code: "INVALID_ANALYSIS_RESULT" });
      }
      const evidenceById = new Map(allEvidence.map((item) => [item.id, item]));
      const claims = [...result.designInterpretation.interfaces, ...result.designInterpretation.featureCandidates];
      if (claims.some((claim) => claim.evidenceIds.length === 0 || claim.evidenceIds.some((id) => !evidenceIds.has(id)))) {
        throw Object.assign(new Error("Design interpretation claims must reference supplied or returned observation IDs"), { code: "INVALID_ANALYSIS_RESULT" });
      }
      const answeredQuestionIds = request.answers.map((answer) => answer.questionId);
      const freeTextClaims = [result.designInterpretation.articleType, result.designInterpretation.functionalIntent];
      if (freeTextClaims.some(containsNumericGeometryMeasurement) || claims.some((claim) =>
        hasUnsupportedClaimMeasurement(claim.description, claim.evidenceIds, evidenceById, answeredQuestionIds))) {
        throw Object.assign(new Error("Numeric geometry claims must be linked to traceable structured measurements through evidence IDs"), { code: "INVALID_ANALYSIS_RESULT" });
      }
      if (result.observations.some((item) => hasUnstructuredGeometryMeasurement(item, answeredQuestionIds))) {
        throw Object.assign(new Error("Numeric geometry measurements in observation labels must also be structured and traceable"), { code: "INVALID_ANALYSIS_RESULT" });
      }
      if ((result.designInterpretation.scaleStatus === "unscaled" || result.designInterpretation.scaleStatus === "unknown") &&
          result.observations.some(hasNumericGeometryMeasurement)) {
        throw Object.assign(new Error("An unscaled design reference cannot contain measured millimeter values"), { code: "INVALID_ANALYSIS_RESULT" });
      }
      if ((result.designInterpretation.scaleStatus === "dimensioned" || result.designInterpretation.scaleStatus === "calibrated") &&
          result.observations.some((item) => hasNumericGeometryMeasurement(item) && !hasTraceableGeometryMeasurement(item, answeredQuestionIds))) {
        throw Object.assign(new Error("Every numeric geometry measurement in a dimensioned or calibrated design reference must have its own traceable source"), { code: "INVALID_ANALYSIS_RESULT" });
      }
      if ((result.designInterpretation.scaleStatus === "dimensioned" || result.designInterpretation.scaleStatus === "calibrated") &&
          !hasTraceableScaleBasis([...request.evidence, ...result.observations], answeredQuestionIds)) {
        throw Object.assign(new Error("A dimensioned or calibrated design reference requires a traceable numeric millimeter measurement"), { code: "INVALID_ANALYSIS_RESULT" });
      }
    }
    const completed: RequestRecord = { id: request.requestId, inputHash: hash, state: "completed", result };
    await store.finishRequest(completed);
  } catch (error) {
    const errorCode = analysisErrorCode(error);
    const interrupted = errorCode === "ANALYSIS_CANCELLED" || errorCode === "ANALYSIS_TIMEOUT" || errorCode === "CODEX_TURN_INTERRUPTED";
    const failureDiagnostics = error instanceof AnalysisClientError ? error.failureDiagnostics : undefined;
    await store.finishRequest({
      id: request.requestId,
      inputHash: hash,
      state: interrupted ? "interrupted" : "failed",
      errorCode,
      ...(failureDiagnostics === undefined ? {} : { failureDiagnostics }),
    });
  }
  return store.readRequest(request.requestId);
}

function hasTraceableScaleBasis(evidence: AnalysisRequest["evidence"], answeredQuestionIds: string[]): boolean {
  return evidence.some((item) => {
    if ((item.status !== "measured" && item.status !== "sourced") || item.unit !== "mm" || (item.value === undefined && item.range === undefined)) return false;
    if (item.value !== undefined ? item.value <= 0 : (item.range?.[0] ?? 0) <= 0) return false;
    return hasTraceableGeometryMeasurement(item, answeredQuestionIds);
  });
}

function hasNumericGeometryMeasurement(item: AnalysisRequest["evidence"][number]): boolean {
  return item.unit !== undefined && ["mm", "mm2", "mm4"].includes(item.unit) &&
    (item.value !== undefined || item.range !== undefined);
}

function hasTraceableGeometryMeasurement(item: AnalysisRequest["evidence"][number], answeredQuestionIds: string[]): boolean {
  if (!hasNumericGeometryMeasurement(item) || (item.status !== "measured" && item.status !== "sourced")) return false;
  const answerLocators = new Set(answeredQuestionIds.map((id) => `answer:${id}`));
  const citesImage = (item.sourceImageIndices?.length ?? 0) > 0 && item.sourceLocator !== undefined;
  const citesExternalSource = item.sourceUrl !== undefined && item.sourceHash !== undefined && item.sourceLocator !== undefined;
  const citesUserAnswer = item.sourceLocator !== undefined && answerLocators.has(item.sourceLocator);
  return citesImage || citesExternalSource || citesUserAnswer;
}

function hasUnstructuredGeometryMeasurement(item: AnalysisRequest["evidence"][number], answeredQuestionIds: string[]): boolean {
  for (const mention of numericGeometryMeasurements(item.label)) {
    if (!evidenceMatchesMeasurement(item, mention, answeredQuestionIds)) return true;
  }
  return false;
}

function containsNumericGeometryMeasurement(text: string): boolean {
  return numericGeometryMeasurements(text).length > 0;
}

function hasUnsupportedClaimMeasurement(
  text: string,
  evidenceIds: string[],
  evidenceById: Map<string, AnalysisRequest["evidence"][number]>,
  answeredQuestionIds: string[],
): boolean {
  return numericGeometryMeasurements(text).some((mention) =>
    !evidenceIds.some((id) => {
      const evidence = evidenceById.get(id);
      return evidence !== undefined && evidenceMatchesMeasurement(evidence, mention, answeredQuestionIds);
    })
  );
}

function numericGeometryMeasurements(text: string): Array<{ value: number; unit: "mm" | "mm2" | "mm4" }> {
  const dimensionPattern = /(?:^|[^\d.])([+-]?\d+(?:[.,]\d+)?)\s*(mm2|mm4|mm|mm²|mm⁴)(?=$|[^a-z])/giu;
  return [...text.matchAll(dimensionPattern)].map((match) => ({
    value: Number(match[1]!.replace(",", ".")),
    unit: match[2]!.toLowerCase().replace("²", "2").replace("⁴", "4") as "mm" | "mm2" | "mm4",
  }));
}

function evidenceMatchesMeasurement(
  item: AnalysisRequest["evidence"][number],
  mention: { value: number; unit: "mm" | "mm2" | "mm4" },
  answeredQuestionIds: string[],
): boolean {
  const matchesStructuredValue = item.unit === mention.unit && (
    item.value !== undefined
      ? Math.abs(item.value - mention.value) <= Math.max(1e-6, Math.abs(mention.value) * 1e-6)
      : item.range !== undefined && item.range[0] <= mention.value && mention.value <= item.range[1]
  );
  return matchesStructuredValue && hasTraceableGeometryMeasurement(item, answeredQuestionIds);
}

function analysisErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return "ANALYSIS_FAILED";
}
