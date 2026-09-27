import * as THREE from "three";

export function applySectionPlane(root: THREE.Object3D, plane: THREE.Plane | undefined): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      material.clippingPlanes = plane ? [plane] : [];
      material.needsUpdate = true;
    }
  });
}
