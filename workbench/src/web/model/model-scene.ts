import * as THREE from "three";

import type { ModelVersion } from "../../shared/contracts.ts";

export interface OcctMesh {
  name?: string;
  color?: number[];
  attributes: {
    position: { array: ArrayLike<number> };
    normal?: { array: ArrayLike<number> };
  };
  index: { array: ArrayLike<number> };
  brep_faces?: Array<{ first: number; last: number; color?: number[] }>;
}

export interface OcctResult {
  success: boolean;
  meshes: OcctMesh[];
}

export interface SceneBody {
  mesh: THREE.Mesh;
  bodyId?: number;
  faceIds: string[];
  meshIndex: number;
}

export interface ModelScene {
  root: THREE.Group;
  bodies: SceneBody[];
  bounds: THREE.Box3;
  dispose(): void;
}

const MAX_TRIANGLES = 10_000_000;

export function buildSceneFromOcct(result: OcctResult, version: ModelVersion): ModelScene {
  if (!result.success) throw new Error("OpenCascade could not read this STEP file");
  const root = new THREE.Group();
  const bodies: SceneBody[] = [];
  let triangleTotal = 0;
  for (const [meshIndex, source] of result.meshes.entries()) {
    const positions = Float32Array.from(source.attributes.position.array);
    if (positions.length % 3 !== 0 || positions.some((value) => !Number.isFinite(value))) throw new Error("STEP mesh has invalid positions");
    const indices = Uint32Array.from(source.index.array);
    if (indices.length % 3 !== 0) throw new Error("STEP mesh index count is invalid");
    if (indices.some((index) => index * 3 >= positions.length)) throw new Error("STEP mesh index points outside vertex data");
    triangleTotal += indices.length / 3;
    if (triangleTotal > MAX_TRIANGLES) throw new Error(`STEP display mesh exceeds ${MAX_TRIANGLES} triangles`);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    if (source.attributes.normal) {
      const normals = Float32Array.from(source.attributes.normal.array);
      if (normals.length === positions.length && !normals.some((value) => !Number.isFinite(value))) geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    }
    if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingBox();
    const defaultColor = toColor(source.color, 0xaeb7bb);
    const materials: THREE.MeshStandardMaterial[] = [new THREE.MeshStandardMaterial({ color: defaultColor, metalness: 0.05, roughness: 0.62 })];
    addFaceGroups(geometry, source, materials, defaultColor);
    const mesh = new THREE.Mesh(geometry, materials);
    const mapping = version.bodyMappings?.find((item) => item.meshIndex === meshIndex);
    mesh.name = mapping?.name ?? source.name ?? `Body ${meshIndex + 1}`;
    mesh.userData = { modelVersionId: version.id, meshIndex, bodyId: mapping?.bodyId };
    root.add(mesh);
    bodies.push({ mesh, ...(mapping?.bodyId === undefined ? {} : { bodyId: mapping.bodyId }), faceIds: mapping?.faceIds ?? [], meshIndex });
  }
  const bounds = new THREE.Box3().setFromObject(root);
  return { root, bodies, bounds, dispose: () => {
    for (const body of bodies) {
      body.mesh.geometry.dispose();
      const materials = Array.isArray(body.mesh.material) ? body.mesh.material : [body.mesh.material];
      for (const material of materials) material.dispose();
    }
    root.clear();
  } };
}

function addFaceGroups(
  geometry: THREE.BufferGeometry,
  source: OcctMesh,
  materials: THREE.MeshStandardMaterial[],
  defaultColor: THREE.Color,
): void {
  const faces = source.brep_faces ?? [];
  const triangleCount = source.index.array.length / 3;
  let triangle = 0;
  for (const [faceIndex, face] of faces.entries()) {
    if (!Number.isInteger(face.first) || !Number.isInteger(face.last) || face.first < triangle || face.last < face.first || face.last >= triangleCount) {
      throw new Error(`STEP face ${faceIndex} has an invalid triangle range`);
    }
    if (triangle < face.first) geometry.addGroup(triangle * 3, (face.first - triangle) * 3, 0);
    materials.push(new THREE.MeshStandardMaterial({ color: toColor(face.color, defaultColor), metalness: 0.05, roughness: 0.62 }));
    geometry.addGroup(face.first * 3, (face.last - face.first + 1) * 3, faceIndex + 1);
    triangle = face.last + 1;
  }
  if (triangle < triangleCount) geometry.addGroup(triangle * 3, (triangleCount - triangle) * 3, 0);
  if (faces.length === 0) geometry.addGroup(0, triangleCount * 3, 0);
}

function toColor(value: number[] | undefined, fallback: number | THREE.Color): THREE.Color {
  if (!value || value.length < 3) return fallback instanceof THREE.Color ? fallback.clone() : new THREE.Color(fallback);
  return new THREE.Color(value[0]!, value[1]!, value[2]!);
}
