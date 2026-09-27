import { describe, expect, it } from "vitest";

import type { ModelVersion } from "../../src/shared/contracts.ts";
import { buildSceneFromOcct, type OcctResult } from "../../src/web/model/model-scene.ts";

const version: ModelVersion = {
  id: "22222222-2222-4222-8222-222222222222",
  projectId: "11111111-1111-4111-8111-111111111111",
  number: 1,
  plasticityDocumentToken: "doc",
  plasticityRevision: "rev-1",
  stepArtifactHash: "a".repeat(64),
  measurements: [],
  bodyMappings: [{ bodyId: 7, name: "Bracket", meshIndex: 0, faceIds: ["face-a", "face-b"] }],
  createdAt: "2026-09-20T00:00:00.000Z",
};

const cube: OcctResult = {
  success: true,
  meshes: [{
    name: "Bracket",
    attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0] } },
    index: { array: [0, 1, 2, 1, 3, 2] },
    brep_faces: [{ first: 0, last: 0 }, { first: 1, last: 1 }],
  }],
};

describe("STEP scene", () => {
  it("maps OpenCascade face triangle ranges into pickable groups", () => {
    const scene = buildSceneFromOcct(cube, version);
    expect(scene.bodies[0]?.mesh.geometry.groups).toEqual([
      expect.objectContaining({ materialIndex: 1, start: 0, count: 3 }),
      expect.objectContaining({ materialIndex: 2, start: 3, count: 3 }),
    ]);
    expect(scene.bodies[0]?.faceIds).toEqual(["face-a", "face-b"]);
  });

  it("rejects invalid indices and excessive triangle counts", () => {
    const invalid: OcctResult = { success: true, meshes: [{ ...cube.meshes[0]!, index: { array: [0, 1, 99] } }] };
    expect(() => buildSceneFromOcct(invalid, version)).toThrow(/index/i);
  });
});
