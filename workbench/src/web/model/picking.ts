import * as THREE from "three";

import type { ModelScene } from "./model-scene.ts";

export interface ModelPick {
  modelVersionId: string;
  meshIndex: number;
  bodyId?: number;
  faceIndex?: number;
  faceId?: string;
  pointMm: [number, number, number];
}

export function pickModel(scene: ModelScene, camera: THREE.Camera, normalized: THREE.Vector2): ModelPick | undefined {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(normalized, camera);
  const hit = raycaster.intersectObjects(scene.bodies.map((body) => body.mesh), false)[0];
  if (!hit || !(hit.object instanceof THREE.Mesh)) return undefined;
  const body = scene.bodies.find((candidate) => candidate.mesh === hit.object);
  if (!body) return undefined;
  const groupIndex = hit.faceIndex == null ? undefined : groupForTriangle(hit.object.geometry, hit.faceIndex);
  const faceIndex = groupIndex === undefined || groupIndex === 0 ? undefined : groupIndex - 1;
  return {
    modelVersionId: String(hit.object.userData.modelVersionId),
    meshIndex: body.meshIndex,
    ...(body.bodyId === undefined ? {} : { bodyId: body.bodyId }),
    ...(faceIndex === undefined ? {} : { faceIndex }),
    ...(faceIndex === undefined || body.faceIds[faceIndex] === undefined ? {} : { faceId: body.faceIds[faceIndex] }),
    pointMm: [hit.point.x, hit.point.y, hit.point.z],
  };
}

function groupForTriangle(geometry: THREE.BufferGeometry, triangle: number): number | undefined {
  const indexOffset = triangle * 3;
  return geometry.groups.find((group) => indexOffset >= group.start && indexOffset < group.start + group.count)?.materialIndex;
}
