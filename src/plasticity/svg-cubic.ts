export type SvgCubicPoint = [number, number];
export type SvgCubicBezier = [SvgCubicPoint, SvgCubicPoint, SvgCubicPoint, SvgCubicPoint];

export function isExactSvgCubicPolynomialDegree(degree: unknown, isRational: unknown): boolean {
  return isRational === false && Number.isInteger(degree) && (degree as number) >= 1 && (degree as number) <= 3;
}

export function fitSvgCubicBezier(samples: SvgCubicPoint[]): SvgCubicBezier {
  if (samples.length !== 4 || samples.some((point) => point.length !== 2 || !point.every(Number.isFinite))) {
    throw new Error("Native cubic Bezier fit requires four finite 2D samples at 0, 1/3, 2/3 and 1");
  }
  const [start, firstInterior, secondInterior, end] = samples;
  const firstResidual: SvgCubicPoint = [
    27 * firstInterior![0] - 8 * start![0] - end![0],
    27 * firstInterior![1] - 8 * start![1] - end![1],
  ];
  const secondResidual: SvgCubicPoint = [
    27 * secondInterior![0] - start![0] - 8 * end![0],
    27 * secondInterior![1] - start![1] - 8 * end![1],
  ];
  const firstControl: SvgCubicPoint = [
    (2 * firstResidual[0] - secondResidual[0]) / 18,
    (2 * firstResidual[1] - secondResidual[1]) / 18,
  ];
  const secondControl: SvgCubicPoint = [
    (2 * secondResidual[0] - firstResidual[0]) / 18,
    (2 * secondResidual[1] - firstResidual[1]) / 18,
  ];
  return [start!, firstControl, secondControl, end!];
}

export function evaluateSvgCubicBezier(controls: SvgCubicBezier, parameter: number): SvgCubicPoint {
  if (!Number.isFinite(parameter) || parameter < 0 || parameter > 1) throw new Error("SVG cubic Bezier parameter must be within [0, 1]");
  const [p0, p1, p2, p3] = controls;
  const inverse = 1 - parameter;
  const w0 = inverse * inverse * inverse;
  const w1 = 3 * inverse * inverse * parameter;
  const w2 = 3 * inverse * parameter * parameter;
  const w3 = parameter * parameter * parameter;
  return [
    w0 * p0[0] + w1 * p1[0] + w2 * p2[0] + w3 * p3[0],
    w0 * p0[1] + w1 * p1[1] + w2 * p2[1] + w3 * p3[1],
  ];
}

export function svgCubicBezierBoundsPoints(controls: SvgCubicBezier): SvgCubicPoint[] {
  const points: SvgCubicPoint[] = [controls[0], controls[3]];
  const component = (index: 0 | 1): number[] => controls.map((point) => point[index]);
  for (const axis of [0, 1] as const) {
    const [p0, p1, p2, p3] = component(axis);
    const a = -p0! + 3 * p1! - 3 * p2! + p3!;
    const b = 3 * p0! - 6 * p1! + 3 * p2!;
    const c = -3 * p0! + 3 * p1!;
    const qa = 3 * a;
    const qb = 2 * b;
    const qc = c;
    const scale = Math.max(1, Math.abs(qa), Math.abs(qb), Math.abs(qc));
    let roots: number[];
    if (Math.abs(qa) <= scale * 1e-14) {
      roots = Math.abs(qb) <= scale * 1e-14 ? [] : [-qc / qb];
    } else {
      const discriminant = qb * qb - 4 * qa * qc;
      if (discriminant < -scale * scale * 1e-14) roots = [];
      else if (Math.abs(discriminant) <= scale * scale * 1e-14) roots = [-qb / (2 * qa)];
      else {
        const root = Math.sqrt(discriminant);
        const q = -0.5 * (qb + Math.sign(qb || 1) * root);
        roots = [q / qa, qc / q];
      }
    }
    for (const parameter of roots) {
      if (parameter > 0 && parameter < 1) points.push(evaluateSvgCubicBezier(controls, parameter));
    }
  }
  return points;
}
