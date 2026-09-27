#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { call, parseAcceptanceArgs, stageImage, startMcp, type LiveMcp } from "./verify-strength-live.ts";

const HELP = `Usage:
  node scripts/verify-design-reference-to-native-live.ts --help
  node scripts/verify-design-reference-to-native-live.ts --target ID --allow-disposable-mutations --live-codex --output NEW_DIRECTORY --image /absolute/path/to/sketch.png

With no arguments or --help, this command performs no Codex calls and no CAD mutations.
Live mode requires an explicit empty Plasticity target, a real Codex turn and an explicit
disposable-mutation flag. It never derives model dimensions from the image.`;

const EXPECTED_GEOMETRY = {
  base: { originMm: [0, 0, 0], sizeMm: [80, 30, 4] },
  upright: { originMm: [0, 0, 4], sizeMm: [80, 4, 40] },
  overallSizeMm: [80, 30, 44],
} as const;

async function writeExclusive(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); } finally { await handle.close(); }
}

function vectorNear(actual: number[], expected: readonly number[], tolerance: number, label: string): void {
  assert.equal(actual.length, expected.length, `${label} axis count`);
  for (let axis = 0; axis < expected.length; axis += 1) {
    assert.ok(Math.abs(actual[axis]! - expected[axis]!) <= tolerance,
      `${label} axis ${axis}: expected ${expected[axis]}, got ${actual[axis]}`);
  }
}

async function main(): Promise<void> {
  const options = parseAcceptanceArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  if (!options.image) throw new Error("Live design-reference acceptance requires --image with an explicit sketch or photo");
  const output = resolve(options.output!);
  await mkdir(output, { mode: 0o700 });
  const initialEvidence: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    targetId: options.target!,
    workbenchUsed: false,
    image: null,
    analysisTurns: [],
    nativeModel: null,
    cleanup: null,
  };
  let live: LiveMcp | undefined;
  let initialDocumentToken: string | undefined;
  let latestRevision: string | undefined;
  let completedMutations = 0;
  let mutationOutcomeUncertain = false;
  let completed = false;
  let failure: string | undefined;

  try {
    const stagedImage = await stageImage(options.image, output);
    initialEvidence.image = { included: true, format: stagedImage.format, byteSize: stagedImage.byteSize };
    live = await startMcp(join(output, "strength-store"), output);

    const methods = await call(live.client, "plasticity_strength_methods", {});
    assert.equal(methods.analysis?.available, true, `Codex analysis unavailable: ${String(methods.analysis?.reason ?? "unknown")}`);
    const windows = await call(live.client, "plasticity_list_windows", {});
    assert.ok(windows.some((window: { targetId: string }) => window.targetId === options.target), "Explicit Plasticity target was not found");
    const initial = await call(live.client, "plasticity_connect", { targetId: options.target });
    assert.equal(initial.bodies.length, 0, "Refusing disposable model creation in a nonempty Plasticity document");
    initialDocumentToken = initial.documentToken;
    latestRevision = initial.revision;

    const designWorkflow = await live.client.readResource({ uri: "plasticity://design/reference-workflow" });
    assert.match(JSON.stringify(designWorkflow.contents), /do not convert pixels.*into measurements/i);
    assert.match(JSON.stringify(designWorkflow.contents), /after the next logical design package is accepted/i);
    const strengthWorkflow = await live.client.readResource({ uri: "plasticity://strength/workflow" });
    assert.match(JSON.stringify(strengthWorkflow.contents), /load path/i);

    const request = {
      prompt: "Inspect the attached synthetic unscaled bracket sketch. Separate visible evidence from unknown dimensions, do not infer millimetres, and ask at most one next decision-relevant question package about function, load path and mounting. This is image analysis only; do not propose CAD commands.",
      imagePaths: [stagedImage.path],
      evidence: [],
      answers: [] as { questionId: string; question: string; answer: string }[],
      analysisMode: "design-reference" as const,
    };
    const analysis = await call(live.client, "plasticity_analyze_design_reference", {
      ...request,
      requestId: "live-design-reference-image",
    }, 180_000);
    assert.equal(analysis.state, "completed", `Image analysis ended as ${analysis.state}`);
    assert.ok(analysis.result.designInterpretation, "Design-reference analysis must return a structured interpretation");
    assert.ok(["unscaled", "unknown"].includes(analysis.result.designInterpretation.scaleStatus),
      "An unscaled image must not become a dimensioned model");
    assert.ok(analysis.result.questions.length <= 1, "Each turn may return at most one question package");
    assert.equal(analysis.result.questions.length, 1, "The synthetic bracket image should require a functional clarification");
    assert.ok(analysis.result.observations.every((observation: { status: string; unit?: string }) =>
      !(observation.status === "measured" && observation.unit === "mm")),
    "Unscaled image analysis must not return measured millimeter values");
    initialEvidence.analysisTurns = [{
      mode: "design-reference",
      state: analysis.state,
      scaleStatus: analysis.result.designInterpretation.scaleStatus,
      observationCount: analysis.result.observations.length,
      measuredMillimeterObservationCount: 0,
      questionCount: analysis.result.questions.length,
    }];

    const confirmedGeometryAnswer = "This is only a geometry-only L-shaped test sample, not an in-service bracket. No leg is a fixed mounting face, no physical object is supported, and there is no mounting substrate, contact condition, applied force, or load path. Do not copy the sketch's undimensioned holes or triangular feature. Use only these explicit dimensions from my answer: base plate 80 × 30 × 4 mm; upright plate 80 × 4 × 40 mm, attached along its full 80 mm edge at the base's y=0 edge. The image is not the source of those dimensions. No strength or printability claim is requested. I explicitly approve this one disposable native CAD model.";
    let questions = analysis.result.questions as Array<{ id: string; question: string }>;
    let followupNumber = 0;
    while (questions.length > 0 && followupNumber < 3) {
      const question = questions[0]!;
      request.answers.push({ questionId: question.id, question: question.question, answer: confirmedGeometryAnswer });
      followupNumber += 1;
      const answerTurn = await call(live.client, "plasticity_analyze_design_reference", {
        ...request,
        requestId: `live-design-reference-answer-${followupNumber}`,
      }, 180_000);
      assert.equal(answerTurn.state, "completed", `Design-reference follow-up ended as ${answerTurn.state}`);
      assert.ok(answerTurn.result.designInterpretation, "Follow-up must retain a structured design interpretation");
      assert.ok(answerTurn.result.questions.length <= 1, "Follow-up may return at most one next question package");
      assert.ok(answerTurn.result.questions.every((next: { id: string }) => next.id !== question.id), "Follow-up repeated the previous question");
      (initialEvidence.analysisTurns as unknown[]).push({
        mode: "design-reference",
        state: answerTurn.state,
        scaleStatus: answerTurn.result.designInterpretation.scaleStatus,
        observationCount: answerTurn.result.observations.length,
        questionCount: answerTurn.result.questions.length,
        priorQuestionTextProvided: true,
        explicitDimensionAnswerProvided: true,
      });
      questions = answerTurn.result.questions;
    }
    assert.equal(questions.length, 0, "Do not create geometry while a decision-relevant question remains unanswered");

    const createBox = async (name: string, originMm: readonly number[], sizeMm: readonly number[]) => {
      mutationOutcomeUncertain = true;
      const state = await call(live!.client, "plasticity_create_box", {
        originMm: [...originMm],
        sizeMm: [...sizeMm],
        name,
        intent: "Explicitly approved disposable geometry-only design-reference acceptance",
        revision: latestRevision,
      });
      mutationOutcomeUncertain = false;
      latestRevision = state.revision;
      completedMutations += 1;
      return state;
    };

    const baseState = await createBox("Acceptance L-support base", EXPECTED_GEOMETRY.base.originMm, EXPECTED_GEOMETRY.base.sizeMm);
    assert.equal(baseState.bodies.length, 1);
    const baseId = baseState.bodies[0].id as number;
    const uprightState = await createBox("Acceptance L-support upright", EXPECTED_GEOMETRY.upright.originMm, EXPECTED_GEOMETRY.upright.sizeMm);
    assert.equal(uprightState.bodies.length, 2);
    const uprightId = uprightState.bodies.find((body: { id: number }) => body.id !== baseId)?.id as number | undefined;
    assert.ok(uprightId, "Upright plate body was not returned");

    mutationOutcomeUncertain = true;
    const united = await call(live.client, "plasticity_boolean", {
      targetIds: [baseId],
      toolIds: [uprightId],
      operation: "union",
      keepTools: false,
      intent: "Fuse the explicitly dimensioned L-support plates into one native Solid",
      revision: latestRevision,
    });
    mutationOutcomeUncertain = false;
    latestRevision = united.revision;
    completedMutations += 1;
    const state = await call(live.client, "plasticity_status", {});
    assert.equal(state.documentToken, initialDocumentToken);
    assert.equal(state.bodies.length, 1, "L-support package should produce one fused native body");
    assert.deepEqual(state.bodies[0].type, "Solid");
    assert.ok(state.bodies[0].boundsMm, "Fused body must expose native B-Rep bounds");
    const bounds = state.bodies[0].boundsMm as { min: number[]; max: number[] };
    vectorNear(bounds.min, [0, 0, 0], 0.01, "native minimum bounds");
    vectorNear(bounds.max, EXPECTED_GEOMETRY.overallSizeMm, 0.01, "native maximum bounds");
    const validation = await call(live.client, "plasticity_validate_bodies", { ids: [state.bodies[0].id], revision: state.revision });
    assert.equal(validation.measurementSource, "native-brep");
    assert.equal(validation.bodies.length, 1);
    assert.equal(validation.bodies[0].nativeValid, true);
    assert.equal(validation.bodies[0].closed, true);
    assert.equal(validation.bodies[0].printableSolid, true);

    initialEvidence.nativeModel = {
      explicitUserDimensionsMm: {
        base: EXPECTED_GEOMETRY.base.sizeMm,
        upright: EXPECTED_GEOMETRY.upright.sizeMm,
      },
      bodyCount: state.bodies.length,
      bodyType: state.bodies[0].type,
      measuredBoundsMm: { min: bounds.min, max: bounds.max },
      measurementSource: "native-brep",
      nativeValid: validation.bodies[0].nativeValid,
      closed: validation.bodies[0].closed,
      printableSolid: validation.bodies[0].printableSolid,
      strengthAndPrintabilityClaims: false,
      completedMutations,
    };

    let cleanupState = state;
    for (let index = 0; index < completedMutations; index += 1) {
      mutationOutcomeUncertain = true;
      cleanupState = await call(live.client, "plasticity_undo", {
        intent: "Restore explicitly selected empty document after disposable design-reference acceptance",
        revision: cleanupState.revision,
      });
      mutationOutcomeUncertain = false;
    }
    completedMutations = 0;
    const recovered = await call(live.client, "plasticity_status", {});
    assert.equal(recovered.documentToken, initialDocumentToken);
    assert.equal(recovered.bodies.length, 0, "Undo must restore the original empty test scene");
    initialEvidence.cleanup = { undoOperations: 3, restoredEmptyDocument: true, finalRevision: recovered.revision };
    initialEvidence.completedAt = new Date().toISOString();
    await writeExclusive(join(output, "evidence.json"), initialEvidence);
    completed = true;
    console.log(JSON.stringify({
      targetId: options.target,
      image: initialEvidence.image,
      analysisTurns: initialEvidence.analysisTurns,
      nativeModel: initialEvidence.nativeModel,
      cleanup: initialEvidence.cleanup,
      evidence: join(output, "evidence.json"),
    }, null, 2));
  } catch (error) {
    failure = (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, " ").slice(0, 1_000);
    throw error;
  } finally {
    if (!completed && live && initialDocumentToken && latestRevision && completedMutations > 0 && !mutationOutcomeUncertain) {
      try {
        const current = await call(live.client, "plasticity_status", {});
        if (current.documentToken !== initialDocumentToken || current.revision !== latestRevision) {
          initialEvidence.cleanup = { restoredEmptyDocument: false, reason: "Document identity or revision changed; automatic undo was refused" };
        } else {
          let restored = current;
          for (let index = 0; index < completedMutations; index += 1) {
            restored = await call(live.client, "plasticity_undo", {
              intent: "Restore disposable geometry after failed live design-reference acceptance",
              revision: restored.revision,
            });
          }
          const finalState = await call(live.client, "plasticity_status", {});
          initialEvidence.cleanup = {
            undoOperations: completedMutations,
            restoredEmptyDocument: finalState.documentToken === initialDocumentToken && finalState.bodies.length === 0,
          };
        }
      } catch (cleanupError) {
        initialEvidence.cleanup = { restoredEmptyDocument: false, reason: (cleanupError instanceof Error ? cleanupError.message : String(cleanupError)).replaceAll(/\s+/g, " ").slice(0, 500) };
      }
    } else if (!completed && mutationOutcomeUncertain) {
      initialEvidence.cleanup = { restoredEmptyDocument: false, reason: "A native mutation outcome is uncertain; automatic undo was refused" };
    } else if (!completed && initialDocumentToken) {
      initialEvidence.cleanup = { restoredEmptyDocument: true, undoOperations: 0 };
    }
    if (!completed && failure) {
      initialEvidence.failure = failure;
      await writeExclusive(join(output, "failure.json"), initialEvidence).catch(() => undefined);
    }
    await live?.client.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error((error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, " ").slice(0, 1_000));
    process.exitCode = 1;
  });
}
