/** Renderer-only helper: no host imports or changes to native prototypes. */
export const NATIVE_BODY_BOUNDS = `function(kernel) {
  let evaluator;
  const supportsExtrema = typeof kernel?.Eval?.prototype?.Extremes === 'function';
  return (model, bodyType) => {
    if (!['Solid', 'Sheet'].includes(bodyType) || !supportsExtrema) {
      return { box: typeof model?.FindBox === 'function' ? model.FindBox() : null, method: 'native-box' };
    }
    const id = typeof model?.Id === 'function' ? model.Id() : NaN;
    if (!Number.isInteger(id) || id <= 0 || id > 2147483647) throw new Error('Native body identity unavailable for extrema');
    evaluator ??= new kernel.Eval(kernel.Context.Get());
    // Each topology needs a primary/secondary/tertiary direction triad.
    const directions = Float64Array.from([
      1,0,0, 0,1,0, 0,0,1, -1,0,0, 0,1,0, 0,0,1,
      0,1,0, 1,0,0, 0,0,1, 0,-1,0, 1,0,0, 0,0,1,
      0,0,1, 1,0,0, 0,1,0, 0,0,-1, 1,0,0, 0,1,0,
    ]);
    const result = evaluator.Extremes(Int32Array.from(Array(6).fill(id)), directions);
    const points = Array.from(result?.extremes ?? []);
    const errors = Array.from(result?.errors ?? []);
    if (result?.ok !== 6 || errors.length !== 6 || errors.some(code => code !== 0) ||
        points.length !== 18 || points.some(value => !Number.isFinite(value))) {
      throw new Error('Native body extrema evaluation failed');
    }
    const min = { x: points[3], y: points[10], z: points[17] };
    const max = { x: points[0], y: points[7], z: points[14] };
    if (['x', 'y', 'z'].some(axis => min[axis] > max[axis])) throw new Error('Native body extrema are inverted');
    return { box: { min, max }, method: 'native-extrema' };
  };
}`;
