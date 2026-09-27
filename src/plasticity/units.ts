export function millimetersToMeters(value: number): number {
  assertFinite(value);
  return value / 1_000;
}

export function metersToMillimeters(value: number): number {
  assertFinite(value);
  return value * 1_000;
}

export function degreesToRadians(value: number): number {
  assertFinite(value);
  return (value * Math.PI) / 180;
}

function assertFinite(value: number): void {
  if (!Number.isFinite(value)) throw new Error("Value must be finite");
}
