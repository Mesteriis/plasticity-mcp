export type Vector3Mm = [number, number, number];
export type QuaternionXyzw = [number, number, number, number];
export interface BoundsMm { min: Vector3Mm; max: Vector3Mm }

export function quaternionFromXyzDegrees(rotationDeg: Vector3Mm): QuaternionXyzw {
  if (!rotationDeg.every(Number.isFinite)) throw new Error("Print orientation angles must be finite");
  const half = rotationDeg.map((angle) => angle * Math.PI / 360) as Vector3Mm;
  const [sx, sy, sz] = half.map(Math.sin) as Vector3Mm;
  const [cx, cy, cz] = half.map(Math.cos) as Vector3Mm;
  const qx: QuaternionXyzw = [sx, 0, 0, cx];
  const qy: QuaternionXyzw = [0, sy, 0, cy];
  const qz: QuaternionXyzw = [0, 0, sz, cz];
  return multiplyQuaternion(multiplyQuaternion(qz, qy), qx);
}

export function boundsCenter(bounds: BoundsMm): Vector3Mm {
  return bounds.min.map((value, axis) => (value + bounds.max[axis]!) / 2) as Vector3Mm;
}

export function unionBounds(bounds: BoundsMm[]): BoundsMm {
  if (bounds.length === 0) throw new Error("At least one bounded body is required");
  return {
    min: [0, 1, 2].map((axis) => Math.min(...bounds.map((item) => item.min[axis]!))) as Vector3Mm,
    max: [0, 1, 2].map((axis) => Math.max(...bounds.map((item) => item.max[axis]!))) as Vector3Mm,
  };
}

export function rotateBoundsAroundPivot(bounds: BoundsMm, pivot: Vector3Mm, quaternion: QuaternionXyzw): BoundsMm {
  const corners: Vector3Mm[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        corners.push(rotatePoint([x, y, z], pivot, quaternion));
      }
    }
  }
  return {
    min: [0, 1, 2].map((axis) => Math.min(...corners.map((corner) => corner[axis]!))) as Vector3Mm,
    max: [0, 1, 2].map((axis) => Math.max(...corners.map((corner) => corner[axis]!))) as Vector3Mm,
  };
}

export function rotatePoint(point: Vector3Mm, pivot: Vector3Mm, quaternion: QuaternionXyzw): Vector3Mm {
  const [qx, qy, qz, qw] = quaternion;
  const [x, y, z] = point.map((value, axis) => value - pivot[axis]!) as Vector3Mm;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  const rotated: Vector3Mm = [
    x + qw * tx + qy * tz - qz * ty,
    y + qw * ty + qz * tx - qx * tz,
    z + qw * tz + qx * ty - qy * tx,
  ];
  return rotated.map((value, axis) => value + pivot[axis]!) as Vector3Mm;
}

function multiplyQuaternion(left: QuaternionXyzw, right: QuaternionXyzw): QuaternionXyzw {
  const [x1, y1, z1, w1] = left;
  const [x2, y2, z2, w2] = right;
  return [
    w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
    w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
    w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
  ];
}
