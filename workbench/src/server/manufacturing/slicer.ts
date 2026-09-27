import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

import type { DepositionLayerPathOrientation, ManufacturingProfile, SliceSummary } from "../../shared/contracts.ts";
import { manufacturingProfileSchema } from "../../shared/schemas.ts";

export interface SliceResult {
  gcode: Buffer;
  filename: string;
  summary: SliceSummary;
  log: string;
}

export interface SlicerAdapter {
  readonly id: ManufacturingProfile["slicer"]["slicer"];
  slice(
    sourcePath: string,
    sourceName: string,
    profile: ManufacturingProfile,
    jobDirectory: string,
  ): Promise<SliceResult>;
}

export type SlicerCommandRunner = (
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

export class CrealityPrintSlicer implements SlicerAdapter {
  readonly id = "creality-print" as const;
  private readonly executable: string;
  private readonly runCommand: SlicerCommandRunner;

  constructor(
    executable: string,
    runCommand: SlicerCommandRunner = defaultRunner(),
  ) {
    this.executable = executable;
    this.runCommand = runCommand;
  }

  async slice(
    sourcePath: string,
    sourceName: string,
    rawProfile: ManufacturingProfile,
    jobDirectory: string,
  ): Promise<SliceResult> {
    const profile = manufacturingProfileSchema.parse(rawProfile);
    if (profile.slicer.slicer !== "creality-print") throw new Error(`Unsupported slicer: ${profile.slicer.slicer}`);
    await mkdir(jobDirectory, { recursive: true });
    const extension = supportedExtension(sourceName);
    const inputPath = join(jobDirectory, `model${extension}`);
    const machinePath = join(jobDirectory, "machine.json");
    const processPath = join(jobDirectory, "process.json");
    const filamentPath = join(jobDirectory, "filament.json");
    const dataDirectory = join(jobDirectory, "slicer-data");
    await Promise.all([
      copyFile(sourcePath, inputPath),
      copyFile(profile.slicer.machineConfigPath, machinePath),
      copyFile(profile.slicer.processConfigPath, processPath),
      copyFile(profile.slicer.filamentConfigPath, filamentPath),
    ]);
    const outputDirectory = join(jobDirectory, "output");
    await mkdir(outputDirectory);
    await mkdir(dataDirectory);
    const args = [
      "--debug", "2",
      "--datadir", dataDirectory,
      "--load-settings", `${machinePath};${processPath}`,
      "--load-filaments", filamentPath,
      "--orient", "1",
      "--arrange", "1",
      "--ensure-on-bed",
      "--slice", "0",
      "--outputdir", outputDirectory,
      inputPath,
    ];
    const result = await this.runCommand(this.executable, args, { cwd: jobDirectory, timeoutMs: 5 * 60_000 });
    return await collectResult(outputDirectory, result);
  }
}

export class OrcaFamilySlicer implements SlicerAdapter {
  readonly id: "orca-slicer" | "bambu-studio";
  private readonly executable: string;
  private readonly runCommand: SlicerCommandRunner;

  constructor(
    id: "orca-slicer" | "bambu-studio",
    executable: string,
    runCommand: SlicerCommandRunner = defaultRunner(id === "orca-slicer" ? "OrcaSlicer" : "Bambu Studio"),
  ) {
    this.id = id;
    this.executable = executable;
    this.runCommand = runCommand;
  }

  async slice(
    sourcePath: string,
    sourceName: string,
    rawProfile: ManufacturingProfile,
    jobDirectory: string,
  ): Promise<SliceResult> {
    const profile = manufacturingProfileSchema.parse(rawProfile);
    if (profile.slicer.slicer !== this.id) throw new Error(`Unsupported slicer: ${profile.slicer.slicer}`);
    await mkdir(jobDirectory, { recursive: true });
    const extension = orcaSupportedExtension(sourceName);
    const inputPath = join(jobDirectory, `model${extension}`);
    const machinePath = join(jobDirectory, "machine.json");
    const processPath = join(jobDirectory, "process.json");
    const filamentPath = join(jobDirectory, "filament.json");
    const dataDirectory = join(jobDirectory, "slicer-data");
    await Promise.all([
      copyFile(sourcePath, inputPath),
      copyFile(profile.slicer.machineConfigPath, machinePath),
      copyFile(profile.slicer.processConfigPath, processPath),
      copyFile(profile.slicer.filamentConfigPath, filamentPath),
    ]);
    const outputDirectory = join(jobDirectory, "output");
    await mkdir(outputDirectory);
    await mkdir(dataDirectory);
    const args = [
      "--debug", "2",
      "--datadir", dataDirectory,
      "--load-settings", `${machinePath};${processPath}`,
      "--load-filaments", filamentPath,
      "--orient", "1",
      "--arrange", "1",
      "--ensure-on-bed",
      "--slice", "0",
      "--outputdir", outputDirectory,
      inputPath,
    ];
    const result = await this.runCommand(this.executable, args, { cwd: jobDirectory, timeoutMs: 5 * 60_000 });
    return await collectResult(outputDirectory, result);
  }
}

export function parseGcodeSummary(gcode: string): SliceSummary {
  const layers = captureNumber(gcode, /^; total layer number:\s*(\d+)/m);
  const depositionLayerZMm = parseDepositionLayerZMm(gcode, layers);
  const depositionLayerPathOrientations = parseDepositionLayerPathOrientations(gcode, layers);
  const filamentLengthMm = captureNumber(gcode, /^; filament used \[mm\] =\s*([\d.]+)/m);
  const filamentMassG = captureNumber(gcode, /^; filament used \[g\] =\s*([\d.]+)/m);
  const time = /^; estimated printing time \(normal mode\) =\s*(.+)$/m.exec(gcode)?.[1];
  const headerMin = coordinateTriple(gcode, "MIN");
  const headerMax = coordinateTriple(gcode, "MAX");
  const toolpathBounds = extrusionBounds(gcode);
  const objectBounds = orcaObjectBounds(gcode);
  const maxZ = captureNumber(gcode, /^; max_z_height:\s*([\d.]+)/m);
  const objectModelBounds = objectBounds && maxZ !== undefined
    ? { min: [objectBounds.min[0], objectBounds.min[1], 0] as [number, number, number], max: [objectBounds.max[0], objectBounds.max[1], maxZ] as [number, number, number] }
    : undefined;
  const headerBounds = headerMin && headerMax ? { min: headerMin, max: headerMax } : undefined;
  const estimatedBounds = toolpathBounds && maxZ !== undefined
    ? { min: [toolpathBounds.min[0], toolpathBounds.min[1], 0] as [number, number, number], max: [toolpathBounds.max[0], toolpathBounds.max[1], maxZ] as [number, number, number] }
    : toolpathBounds;
  const boundsMm = headerBounds ?? objectModelBounds ?? estimatedBounds;
  const boundsSource = headerBounds
    ? "slicer-header" as const
    : objectModelBounds
      ? "slicer-object-metadata" as const
      : toolpathBounds
        ? "extrusion-path-estimate" as const
        : undefined;
  return {
    ...(layers !== undefined ? { layers } : {}),
    ...(depositionLayerZMm ? { depositionLayerZMm } : {}),
    ...(depositionLayerPathOrientations ? { depositionLayerPathOrientations } : {}),
    ...(filamentLengthMm !== undefined ? { filamentLengthMm } : {}),
    ...(filamentMassG !== undefined ? { filamentMassG } : {}),
    ...(time ? { estimatedSeconds: parseDuration(time) } : {}),
    ...(boundsMm ? { boundsMm } : {}),
    ...(boundsSource ? { boundsSource } : {}),
    ...(toolpathBounds ? { toolpathBoundsMm: toolpathBounds } : {}),
  };
}

function parseDepositionLayerPathOrientations(gcode: string, expectedLayerCount: number | undefined): DepositionLayerPathOrientation[] | undefined {
  let absoluteAxes = true;
  let absoluteArcCenters = false;
  let absoluteExtrusion = true;
  let xyArcPlane = true;
  let previousExtrusion = 0;
  const position: [number, number, number] = [0, 0, 0];
  let activeLayer = false;
  let planarPathLengthMm = 0;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  let curvedExtrusionMoves = 0;
  let unsupportedCurvedExtrusionMoves = 0;
  let nurbsSplineBlockActive = false;
  let unsupportedSplineRecordedForLayer = false;
  const layers: DepositionLayerPathOrientation[] = [];

  const markUnsupportedSpline = (): void => {
    if (!activeLayer || unsupportedSplineRecordedForLayer) return;
    curvedExtrusionMoves += 1;
    unsupportedCurvedExtrusionMoves += 1;
    unsupportedSplineRecordedForLayer = true;
  };

  const finishLayer = (): void => {
    if (!activeLayer) return;
    if (nurbsSplineBlockActive) markUnsupportedSpline();
    const trace = xx + yy;
    const concentration = trace > 0
      ? Math.sqrt((xx - yy) ** 2 + 4 * xy ** 2) / trace
      : null;
    let direction: number | null = null;
    if (trace > 0 && concentration !== null && concentration > 1e-6) {
      const degrees = Math.atan2(2 * xy, xx - yy) * 90 / Math.PI;
      const roundedDegrees = Number((((degrees % 180) + 180) % 180).toFixed(6));
      direction = roundedDegrees >= 180 ? 0 : roundedDegrees;
    }
    layers.push({
      layerIndex: layers.length + 1,
      planarPathLengthMm: Number(planarPathLengthMm.toFixed(6)),
      principalDirectionDeg: direction,
      directionalConcentration: concentration === null ? null : Number(Math.min(1, concentration).toFixed(6)),
      curvedExtrusionMoves,
      coverage: unsupportedCurvedExtrusionMoves > 0
        ? "partial-curved"
        : curvedExtrusionMoves > 0
          ? "complete-planar"
          : planarPathLengthMm > 0
            ? "complete-linear"
            : "no-planar-extrusion",
    });
  };

  for (const rawLine of gcode.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (/^;\s*(?:LAYER_CHANGE|CHANGE_LAYER|LAYER:\s*\d+)\s*$/i.test(trimmed)) {
      finishLayer();
      activeLayer = true;
      planarPathLengthMm = 0;
      xx = 0;
      xy = 0;
      yy = 0;
      curvedExtrusionMoves = 0;
      unsupportedCurvedExtrusionMoves = 0;
      unsupportedSplineRecordedForLayer = false;
      if (nurbsSplineBlockActive) markUnsupportedSpline();
      continue;
    }
    const line = rawLine.split(";")[0]!.trim();
    const gCodes = [...line.matchAll(/(?:^|\s)G(\d+(?:\.\d+)?)(?=\s|$)/gi)].map((match) => Number(match[1]));
    for (const code of gCodes) {
      if (code === 90) absoluteAxes = true;
      else if (code === 91) absoluteAxes = false;
      else if (code === 90.1) absoluteArcCenters = true;
      else if (code === 91.1) absoluteArcCenters = false;
      else if (code === 17) xyArcPlane = true;
      else if (code === 18 || code === 19) xyArcPlane = false;
      else if (code === 5.2) {
        nurbsSplineBlockActive = true;
        markUnsupportedSpline();
      } else if (code === 5.3) {
        markUnsupportedSpline();
        nurbsSplineBlockActive = false;
      }
    }
    if (line === "M82") { absoluteExtrusion = true; continue; }
    if (line === "M83") { absoluteExtrusion = false; continue; }

    if (gCodes.includes(92)) {
      for (const [axis, index] of [["X", 0], ["Y", 1], ["Z", 2]] as const) {
        const value = new RegExp(`(?:^|\\s)${axis}\\s*(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+))`, "i").exec(line)?.[1];
        if (value !== undefined) position[index] = Number(value);
      }
      const extrusion = /(?:^|\s)E\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/i.exec(line)?.[1];
      if (extrusion !== undefined) previousExtrusion = Number(extrusion);
      continue;
    }

    const commandCode = [...gCodes].reverse().find((code) => [0, 1, 2, 3, 5, 5.1].includes(code));
    if (commandCode === undefined) continue;
    const values = new Map<string, number>();
    for (const match of line.matchAll(/(?:^|\s)([XYZEFIJPQR])\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/gi)) {
      values.set(match[1]!.toUpperCase(), Number(match[2]));
    }
    const extrusion = values.get("E");
    const isExtruding = extrusion !== undefined && (absoluteExtrusion ? extrusion > previousExtrusion : extrusion > 0);
    if (extrusion !== undefined && absoluteExtrusion) previousExtrusion = extrusion;

    const oldX = position[0];
    const oldY = position[1];
    for (const [axis, index] of [["X", 0], ["Y", 1], ["Z", 2]] as const) {
      const value = values.get(axis);
      if (value !== undefined) position[index] = absoluteAxes ? value : position[index] + value;
    }
    if (!activeLayer || !isExtruding) continue;

    const dx = position[0] - oldX;
    const dy = position[1] - oldY;
    const length = Math.hypot(dx, dy);
    if (commandCode === 2 || commandCode === 3) {
      curvedExtrusionMoves += 1;
      const usesCenterOffsets = values.has("I") || values.has("J");
      const arc = xyArcPlane && !(absoluteArcCenters && usesCenterOffsets)
        ? gcodeArcOrientationContribution(
          oldX, oldY, position[0], position[1], values.get("I"), values.get("J"),
          commandCode === 2, values.get("R"), values.has("P"),
        )
        : undefined;
      if (arc) {
        planarPathLengthMm += arc.pathLengthMm;
        xx += arc.xx;
        xy += arc.xy;
        yy += arc.yy;
      } else {
        unsupportedCurvedExtrusionMoves += 1;
      }
      continue;
    }
    if (commandCode === 5 || commandCode === 5.1) {
      if (length > 1e-9 || values.has("I") || values.has("J") || values.has("P") || values.has("Q") || values.has("R")) {
        curvedExtrusionMoves += 1;
        unsupportedCurvedExtrusionMoves += 1;
      }
      continue;
    }
    if (length <= 1e-9) continue;
    const unitX = dx / length;
    const unitY = dy / length;
    planarPathLengthMm += length;
    xx += length * unitX * unitX;
    xy += length * unitX * unitY;
    yy += length * unitY * unitY;
  }
  finishLayer();

  if (layers.length === 0 || (expectedLayerCount !== undefined && layers.length !== expectedLayerCount)) return undefined;
  return layers;
}

function gcodeArcOrientationContribution(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  i: number | undefined,
  j: number | undefined,
  clockwise: boolean,
  radiusParameter: number | undefined,
  hasUnsupportedSweepParameter: boolean,
): { pathLengthMm: number; xx: number; xy: number; yy: number } | undefined {
  if (hasUnsupportedSweepParameter) return undefined;
  if (radiusParameter !== undefined) {
    if (i !== undefined || j !== undefined) return undefined;
    return gcodeRadiusArcOrientationContribution(startX, startY, endX, endY, radiusParameter, clockwise);
  }
  if (i === undefined && j === undefined) return undefined;

  const centerX = startX + (i ?? 0);
  const centerY = startY + (j ?? 0);
  const startRadius = Math.hypot(startX - centerX, startY - centerY);
  const endRadius = Math.hypot(endX - centerX, endY - centerY);
  if (!(startRadius > 1e-9) || Math.abs(startRadius - endRadius) > Math.max(0.01, startRadius * 1e-3)) return undefined;

  const startAngle = Math.atan2(startY - centerY, startX - centerX);
  const endAngle = Math.atan2(endY - centerY, endX - centerX);
  const sweep = arcSweep(startAngle, endAngle, clockwise, startRadius, endX - startX, endY - startY, true);
  if (sweep === undefined) return undefined;
  return integrateCircularOrientation(startRadius, startAngle, sweep);
}

function gcodeRadiusArcOrientationContribution(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  signedRadius: number,
  clockwise: boolean,
): { pathLengthMm: number; xx: number; xy: number; yy: number } | undefined {
  const radius = Math.abs(signedRadius);
  const dx = endX - startX;
  const dy = endY - startY;
  const chord = Math.hypot(dx, dy);
  if (!(radius > 1e-9) || !(chord > 1e-9)) return undefined;

  const halfChord = chord / 2;
  const heightSquared = radius * radius - halfChord * halfChord;
  const tolerance = Math.max(1e-9, radius * radius * 1e-12);
  if (heightSquared < -tolerance) return undefined;
  const centerOffset = Math.sqrt(Math.max(0, heightSquared));
  const midpointX = (startX + endX) / 2;
  const midpointY = (startY + endY) / 2;
  const perpendicularX = -dy / chord;
  const perpendicularY = dx / chord;
  const centers = centerOffset <= 1e-9
    ? [[midpointX, midpointY] as const]
    : [
      [midpointX + perpendicularX * centerOffset, midpointY + perpendicularY * centerOffset] as const,
      [midpointX - perpendicularX * centerOffset, midpointY - perpendicularY * centerOffset] as const,
    ];
  const candidates: Array<{ startAngle: number; sweep: number }> = [];

  for (const [centerX, centerY] of centers) {
    const startAngle = Math.atan2(startY - centerY, startX - centerX);
    const endAngle = Math.atan2(endY - centerY, endX - centerX);
    const sweep = arcSweep(startAngle, endAngle, clockwise, radius, dx, dy, false);
    if (sweep === undefined) continue;
    const magnitude = Math.abs(sweep);
    const halfTurnTolerance = 1e-9;
    if (signedRadius > 0 ? magnitude <= Math.PI + halfTurnTolerance : magnitude >= Math.PI - halfTurnTolerance) {
      candidates.push({ startAngle, sweep });
    }
  }

  if (candidates.length === 0) return undefined;
  const selected = candidates.reduce((best, candidate) =>
    Math.abs(candidate.sweep) < Math.abs(best.sweep) ? candidate : best,
  );
  return integrateCircularOrientation(radius, selected.startAngle, selected.sweep);
}

function arcSweep(
  startAngle: number,
  endAngle: number,
  clockwise: boolean,
  radius: number,
  dx: number,
  dy: number,
  allowFullCircle: boolean,
): number | undefined {
  const tau = 2 * Math.PI;
  const sweepMagnitude = clockwise
    ? (startAngle - endAngle + tau) % tau
    : (endAngle - startAngle + tau) % tau;
  const sameEndpoint = Math.hypot(dx, dy) <= Math.max(1e-9, radius * 1e-9);
  const sweep = (clockwise ? -1 : 1) * (
    sweepMagnitude <= 1e-12 && sameEndpoint && allowFullCircle ? tau : sweepMagnitude
  );
  if (sweepMagnitude <= 1e-12 && sameEndpoint && !allowFullCircle) return undefined;
  return Math.abs(sweep) > 1e-12 ? sweep : undefined;
}

function integrateCircularOrientation(
  radius: number,
  startAngle: number,
  sweep: number,
): { pathLengthMm: number; xx: number; xy: number; yy: number } {
  const clockwise = sweep < 0;
  const tangentStart = startAngle + (clockwise ? -Math.PI / 2 : Math.PI / 2);
  const tangentEnd = tangentStart + sweep;
  const direction = Math.sign(sweep);
  const sineDoubleDelta = Math.sin(2 * tangentEnd) - Math.sin(2 * tangentStart);
  const sineSquareDelta = Math.sin(tangentEnd) ** 2 - Math.sin(tangentStart) ** 2;
  return {
    pathLengthMm: radius * Math.abs(sweep),
    xx: radius * direction * (sweep / 2 + sineDoubleDelta / 4),
    xy: radius * direction * sineSquareDelta / 2,
    yy: radius * direction * (sweep / 2 - sineDoubleDelta / 4),
  };
}

function parseDepositionLayerZMm(gcode: string, expectedLayerCount: number | undefined): number[] | undefined {
  let absoluteAxes = true;
  let absoluteExtrusion = true;
  let previousExtrusion = 0;
  let zPosition = 0;
  let activeLayer = false;
  let activeLayerHasExtrusion = false;
  let activeLayerZ: number | undefined;
  const layerHeights: number[] = [];

  const finishLayer = (): void => {
    if (!activeLayer) return;
    if (!activeLayerHasExtrusion || activeLayerZ === undefined) {
      layerHeights.push(Number.NaN);
      return;
    }
    layerHeights.push(activeLayerZ);
  };

  for (const rawLine of gcode.split(/\r?\n/)) {
    if (/^;\s*(?:LAYER_CHANGE|CHANGE_LAYER|LAYER:\s*\d+)\s*$/i.test(rawLine.trim())) {
      finishLayer();
      activeLayer = true;
      activeLayerHasExtrusion = false;
      activeLayerZ = undefined;
      continue;
    }
    const line = rawLine.split(";")[0]!.trim();
    if (line === "G90") { absoluteAxes = true; continue; }
    if (line === "G91") { absoluteAxes = false; continue; }
    if (line === "M82") { absoluteExtrusion = true; continue; }
    if (line === "M83") { absoluteExtrusion = false; continue; }

    const command = /^(G0?[0123])(?:\s|$)/.exec(line)?.[1];
    if (/^G92(?:\s|$)/.test(line)) {
      const e = /(?:^|\s)E\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/i.exec(line);
      if (e) previousExtrusion = Number(e[1]);
      const z = /(?:^|\s)Z\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/i.exec(line);
      if (z) zPosition = Number(z[1]);
      continue;
    }
    if (!command) continue;

    const values = new Map<string, number>();
    for (const match of line.matchAll(/(?:^|\s)([XYZEF])\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/gi)) {
      values.set(match[1]!.toUpperCase(), Number(match[2]));
    }
    const extrusion = values.get("E");
    const isExtruding = extrusion !== undefined && (absoluteExtrusion ? extrusion > previousExtrusion : extrusion > 0);
    if (extrusion !== undefined && absoluteExtrusion) previousExtrusion = extrusion;
    const z = values.get("Z");
    if (z !== undefined) zPosition = absoluteAxes ? z : zPosition + z;
    if (!activeLayer || activeLayerHasExtrusion || !isExtruding || (!values.has("X") && !values.has("Y"))) continue;
    activeLayerHasExtrusion = true;
    activeLayerZ = zPosition;
  }
  finishLayer();

  if (layerHeights.length < 2 || layerHeights.some((value) => !Number.isFinite(value) || value < 0)) return undefined;
  if (expectedLayerCount !== undefined && layerHeights.length !== expectedLayerCount) return undefined;
  for (let index = 1; index < layerHeights.length; index += 1) {
    if (layerHeights[index]! <= layerHeights[index - 1]! + 1e-6) return undefined;
  }
  return layerHeights;
}

function orcaObjectBounds(gcode: string): { min: [number, number]; max: [number, number] } | undefined {
  const min: [number, number] = [Infinity, Infinity];
  const max: [number, number] = [-Infinity, -Infinity];
  let validPolygonCount = 0;
  const polygonPattern = /\bPOLYGON\s*=\s*(\[\[[^\r\n]*?\]\])/g;
  const pointPattern = /\[\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*,\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*\]/g;
  for (const polygon of gcode.matchAll(polygonPattern)) {
    const points: Array<[number, number]> = [];
    for (const point of polygon[1]!.matchAll(pointPattern)) {
      const x = Number(point[1]);
      const y = Number(point[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      points.push([x, y]);
    }
    if (new Set(points.map(([x, y]) => `${x},${y}`)).size < 3) continue;
    for (const [x, y] of points) {
      min[0] = Math.min(min[0], x);
      min[1] = Math.min(min[1], y);
      max[0] = Math.max(max[0], x);
      max[1] = Math.max(max[1], y);
    }
    validPolygonCount += 1;
  }
  return validPolygonCount > 0 ? { min, max } : undefined;
}

function extrusionBounds(gcode: string): { min: [number, number, number]; max: [number, number, number] } | undefined {
  let absoluteAxes = true;
  let absoluteExtrusion = true;
  let absoluteArcCenters = false;
  let xyArcPlane = true;
  let started = false;
  let previousExtrusion = 0;
  const position: [number, number, number] = [0, 0, 0];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let unsupportedExtrudingArc = false;
  for (const rawLine of gcode.split(/\r?\n/)) {
    const line = rawLine.split(";")[0]!.trim();
    if (/^;\s*(?:LAYER_CHANGE|CHANGE_LAYER)\s*$/i.test(rawLine.trim())) started = true;
    if (line === "M82") { absoluteExtrusion = true; continue; }
    if (line === "M83") { absoluteExtrusion = false; continue; }
    const gCodes = [...line.matchAll(/(?:^|\s)G(\d+(?:\.\d+)?)(?=\s|$)/gi)].map((match) => Number(match[1]));
    for (const code of gCodes) {
      if (code === 90) absoluteAxes = true;
      else if (code === 91) absoluteAxes = false;
      else if (code === 90.1) absoluteArcCenters = true;
      else if (code === 91.1) absoluteArcCenters = false;
      else if (code === 17) xyArcPlane = true;
      else if (code === 18 || code === 19) xyArcPlane = false;
    }
    if (gCodes.includes(92)) {
      for (const match of line.matchAll(/(?:^|\s)([XYZEF])\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/gi)) {
        const axis = match[1]!.toUpperCase();
        const value = Number(match[2]);
        if (axis === "E") previousExtrusion = value;
        else if (axis !== "F") position["XYZ".indexOf(axis)] = value;
      }
      continue;
    }
    const code = [...gCodes].reverse().find((candidate) => [0, 1, 2, 3].includes(candidate));
    if (code === undefined) continue;
    const values = new Map<string, number>();
    for (const match of line.matchAll(/(?:^|\s)([XYZEFIJKR])\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/gi)) values.set(match[1]!.toUpperCase(), Number(match[2]));
    const e = values.get("E");
    const isExtruding = e !== undefined && (absoluteExtrusion ? e > previousExtrusion : e > 0);
    if (e !== undefined && absoluteExtrusion) previousExtrusion = e;
    const startX = position[0];
    const startY = position[1];
    for (const axis of ["X", "Y", "Z"] as const) {
      const value = values.get(axis);
      const axisIndex = "XYZ".indexOf(axis);
      if (value !== undefined) position[axisIndex] = absoluteAxes ? value : position[axisIndex]! + value;
    }
    if (started && isExtruding && ["X", "Y", "Z"].some((axis) => values.has(axis))) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis]!, position[axis]!);
        max[axis] = Math.max(max[axis]!, position[axis]!);
      }
      if (code === 2 || code === 3) {
        const arcBounds = xyArcPlane
          ? gcodeArcBounds(startX, startY, position[0], position[1], values.get("I"), values.get("J"), values.get("R"), code === 2, absoluteArcCenters)
          : undefined;
        if (arcBounds) {
          min[0] = Math.min(min[0]!, arcBounds.minX);
          min[1] = Math.min(min[1]!, arcBounds.minY);
          max[0] = Math.max(max[0]!, arcBounds.maxX);
          max[1] = Math.max(max[1]!, arcBounds.maxY);
        } else {
          unsupportedExtrudingArc = true;
        }
      }
    }
  }
  if (unsupportedExtrudingArc || min.some((value) => !Number.isFinite(value)) || max.some((value) => !Number.isFinite(value))) return undefined;
  return { min, max };
}

function gcodeArcBounds(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  i: number | undefined,
  j: number | undefined,
  signedRadius: number | undefined,
  clockwise: boolean,
  absoluteCenter: boolean,
): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
  if (signedRadius !== undefined && (i !== undefined || j !== undefined)) return undefined;

  let centers: Array<[number, number]>;
  let radius: number;
  if (signedRadius !== undefined) {
    radius = Math.abs(signedRadius);
    const dx = endX - startX;
    const dy = endY - startY;
    const chord = Math.hypot(dx, dy);
    if (!(radius > 1e-9) || !(chord > 1e-9)) return undefined;
    const heightSquared = radius * radius - (chord / 2) ** 2;
    if (heightSquared < -Math.max(1e-9, radius * radius * 1e-12)) return undefined;
    const height = Math.sqrt(Math.max(0, heightSquared));
    const midpointX = (startX + endX) / 2;
    const midpointY = (startY + endY) / 2;
    const normalX = -dy / chord;
    const normalY = dx / chord;
    centers = height <= 1e-9
      ? [[midpointX, midpointY]]
      : [[midpointX + normalX * height, midpointY + normalY * height], [midpointX - normalX * height, midpointY - normalY * height]];
  } else {
    if (i === undefined && j === undefined) return undefined;
    const centerX = absoluteCenter ? (i ?? startX) : startX + (i ?? 0);
    const centerY = absoluteCenter ? (j ?? startY) : startY + (j ?? 0);
    centers = [[centerX, centerY]];
    radius = Math.hypot(startX - centerX, startY - centerY);
    const endRadius = Math.hypot(endX - centerX, endY - centerY);
    if (!(radius > 1e-9) || Math.abs(radius - endRadius) > Math.max(0.01, radius * 1e-3)) return undefined;
  }

  const candidates = centers.flatMap(([centerX, centerY]) => {
    const startAngle = Math.atan2(startY - centerY, startX - centerX);
    const endAngle = Math.atan2(endY - centerY, endX - centerX);
    const sweep = arcSweep(startAngle, endAngle, clockwise, radius, endX - startX, endY - startY, signedRadius === undefined);
    if (sweep === undefined) return [];
    const magnitude = Math.abs(sweep);
    if (signedRadius !== undefined && (signedRadius > 0 ? magnitude > Math.PI + 1e-9 : magnitude < Math.PI - 1e-9)) return [];
    return [{ centerX, centerY, startAngle, sweep }];
  });
  if (candidates.length === 0) return undefined;
  const selected = signedRadius === undefined
    ? candidates[0]!
    : candidates.reduce((best, candidate) => Math.abs(candidate.sweep) < Math.abs(best.sweep) ? candidate : best);

  const xs = [startX, endX];
  const ys = [startY, endY];
  for (const angle of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    const directedSweep = clockwise
      ? -((selected.startAngle - angle + 2 * Math.PI) % (2 * Math.PI))
      : (angle - selected.startAngle + 2 * Math.PI) % (2 * Math.PI);
    if (Math.abs(directedSweep) > Math.abs(selected.sweep) + 1e-9) continue;
    xs.push(selected.centerX + radius * Math.cos(angle));
    ys.push(selected.centerY + radius * Math.sin(angle));
  }
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

function coordinateTriple(gcode: string, prefix: "MIN" | "MAX"): [number, number, number] | undefined {
  const values = (["X", "Y", "Z"] as const).map((axis) =>
    captureNumber(gcode, new RegExp(`^; ${prefix}${axis} =\\s*([\\d.-]+)`, "m")));
  return values.every((value) => value !== undefined) ? values as [number, number, number] : undefined;
}

function captureNumber(text: string, pattern: RegExp): number | undefined {
  const value = Number(pattern.exec(text)?.[1]);
  return Number.isFinite(value) ? value : undefined;
}

function parseDuration(value: string): number {
  const hours = Number(/(\d+)h/.exec(value)?.[1] ?? 0);
  const minutes = Number(/(\d+)m/.exec(value)?.[1] ?? 0);
  const seconds = Number(/(\d+)s/.exec(value)?.[1] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function supportedExtension(name: string): string {
  const extension = extname(name).toLowerCase();
  if (![".stl", ".obj", ".amf", ".xml"].includes(extension)) {
    throw new Error(`Creality Print 7.2 CLI input must be STL, OBJ, or AMF; received ${name}`);
  }
  return extension;
}

function orcaSupportedExtension(name: string): string {
  const extension = extname(name).toLowerCase();
  if (![".stl", ".3mf", ".obj", ".amf", ".xml"].includes(extension)) {
    throw new Error(`Orca/Bambu CLI input must be STL, 3MF, OBJ, or AMF; received ${name}`);
  }
  return extension;
}

async function collectResult(outputDirectory: string, command: { stdout: string; stderr: string }): Promise<SliceResult> {
  const files = (await readdir(outputDirectory)).filter((name) => name.toLowerCase().endsWith(".gcode"));
  if (files.length !== 1) throw new Error(`Slicer produced ${files.length} G-code files; expected exactly one`);
  const filename = files[0]!;
  const gcode = await readFile(join(outputDirectory, filename));
  if (gcode.byteLength === 0) throw new Error("Slicer produced an empty G-code file");
  return {
    gcode,
    filename,
    summary: parseGcodeSummary(gcode.toString("utf8")),
    log: `${command.stdout}\n${command.stderr}`.trim().slice(-20_000),
  };
}

const defaultRunner = (label = "Creality Print"): SlicerCommandRunner => async (executable, args, options) =>
  await new Promise((resolve, reject) => {
    execFile(executable, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${label} failed: ${error.message}\n${String(stdout).slice(-4_000)}\n${String(stderr).slice(-4_000)}`));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
