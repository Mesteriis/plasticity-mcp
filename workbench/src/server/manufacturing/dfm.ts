import type { DfmAxis, DfmInput, DfmProtectedZone, DfmReport, ManufacturingProfile, Vector3Mm } from "../../shared/contracts.ts";
import { dfmInputSchema, manufacturingProfileSchema } from "../../shared/schemas.ts";

export function assessPrintability(rawInput: DfmInput, rawProfile: ManufacturingProfile): DfmReport {
  const input = dfmInputSchema.parse(rawInput);
  const profile = manufacturingProfileSchema.parse(rawProfile);
  const margin = input.split?.bedMarginMm ?? 0;
  const usableBuildVolumeMm = profile.printer.buildVolumeMm.map((value) => value - margin * 2) as Vector3Mm;
  if (usableBuildVolumeMm.some((value) => value <= 0)) throw new Error("Bed margin leaves no usable build volume");
  const candidates = orientations(input.sizeMm)
    .map(({ rotationDeg, sizeMm, contactArea, bedYawDeg }) => {
      const fits = sizeMm.every((value, index) => value <= usableBuildVolumeMm[index]!);
      const segmentCounts = sizeMm.map((value, index) => Math.ceil(value / usableBuildVolumeMm[index]!)) as [number, number, number];
      const partCount = segmentCounts.reduce((product, count) => product * count, 1);
      const score = (fits ? 1_000_000_000 : -partCount * 1_000_000) + contactArea - sizeMm[2] * 10 - bedYawDeg * 0.001;
      return { rotationDeg, sizeMm, score, fits, segmentCounts, partCount };
    })
    .sort((left, right) => right.score - left.score);
  const best = candidates[0]!;
  assertProtectedZonesWithinBounds(input.split?.protectedZones ?? [], best.sizeMm);
  if (best.fits && input.split?.cutOffsetsMm !== undefined) {
    throw new Error("Explicit cut offsets require a split plan; the selected orientation already fits the printer");
  }
  const findings: DfmReport["findings"] = [];
  if (!best.fits) findings.push({
    code: "outside-build-volume", severity: "error",
    message: `Деталь ${formatSize(best.sizeMm)} мм не помещается в область ${formatSize(profile.printer.buildVolumeMm)} мм. Требуется разбиение.`,
  });
  const splitPlan = best.fits ? undefined : createSplitPlan(best.sizeMm, usableBuildVolumeMm, best.segmentCounts, input, profile);
  if (splitPlan?.cutConflicts.length) findings.push({
    code: "split-cut-through-protected-zone",
    severity: "warning",
    message: `Разрезы пересекают ${splitPlan.cutConflicts.length} защищённую зону. Перепроверьте смещения швов по указанному источнику до изменения CAD.`,
  });
  if (splitPlan && !splitPlan.joint) findings.push({
    code: "split-joint-required", severity: "warning",
    message: `План содержит ${splitPlan.partCount} частей. Перед изменением CAD выберите тип соединения и зазор.`,
  });
  if (splitPlan?.joint && splitPlan.joint !== "flat" && splitPlan.clearanceMm === null) findings.push({
    code: "joint-clearance-required", severity: "warning",
    message: `Для соединения ${splitPlan.joint} нет проверенного зазора в профиле материала.`,
  });
  const minimumWall = profile.printer.nozzleDiameterMm * 2;
  if (input.minimumWallMm !== undefined && input.minimumWallMm < minimumWall) findings.push({
    code: "thin-wall", severity: "warning",
    message: `Минимальная стенка ${input.minimumWallMm} мм меньше рекомендуемых ${minimumWall} мм для сопла ${profile.printer.nozzleDiameterMm} мм.`,
    measured: input.minimumWallMm, limit: minimumWall, unit: "mm",
  });
  const minimumHole = profile.printer.nozzleDiameterMm * 2;
  if (input.minimumHoleDiameterMm !== undefined && input.minimumHoleDiameterMm < minimumHole) findings.push({
    code: "small-hole", severity: "warning",
    message: `Отверстие ${input.minimumHoleDiameterMm} мм потребует компенсации или рассверливания.`,
    measured: input.minimumHoleDiameterMm, limit: minimumHole, unit: "mm",
  });
  if (input.maximumOverhangDeg !== undefined && input.maximumOverhangDeg > 50) findings.push({
    code: "overhang-support", severity: "warning",
    message: `Свес ${input.maximumOverhangDeg}° может потребовать поддержки.`,
    measured: input.maximumOverhangDeg, limit: 50, unit: "deg",
  });
  if (findings.length === 0) findings.push({
    code: "basic-dfm-pass", severity: "info", message: "Базовые ограничения выбранного профиля соблюдены.",
  });
  return {
    printable: best.fits && !findings.some((finding) => finding.severity === "error"),
    orientation: { rotationDeg: best.rotationDeg, sizeMm: best.sizeMm, score: best.score },
    needsSplit: !best.fits,
    profileCompensation: {
      dimensionalScalePercent: profile.slicer.dimensionalScalePercent ?? 100,
      holeCompensationMm: profile.slicer.holeCompensationMm ?? 0,
      jointClearanceMm: profile.material.jointClearanceMm ?? null,
      supportsEnabled: profile.slicer.supportsEnabled ?? null,
    },
    ...(splitPlan ? { splitPlan } : {}),
    findings,
  };
}

function orientations([x, y, z]: Vector3Mm): Array<{ rotationDeg: Vector3Mm; sizeMm: Vector3Mm; contactArea: number; bedYawDeg: number }> {
  const axial = [
    { rotationDeg: [0, 0, 0], sizeMm: [x, y, z] },
    { rotationDeg: [90, 0, 0], sizeMm: [x, z, y] },
    { rotationDeg: [0, 90, 0], sizeMm: [z, y, x] },
    { rotationDeg: [0, 0, 90], sizeMm: [y, x, z] },
    { rotationDeg: [90, 0, 90], sizeMm: [y, z, x] },
    { rotationDeg: [0, 90, 90], sizeMm: [z, x, y] },
  ] as Array<{ rotationDeg: Vector3Mm; sizeMm: Vector3Mm }>;
  return axial.flatMap(({ rotationDeg, sizeMm }) => {
    const [width, depth, height] = sizeMm;
    const contactArea = width * depth;
    return Array.from({ length: 901 }, (_, step) => {
      const bedYawDeg = step / 10;
      const radians = bedYawDeg * Math.PI / 180;
      const cosine = Math.abs(Math.cos(radians));
      const sine = Math.abs(Math.sin(radians));
      return {
        rotationDeg: [rotationDeg[0], rotationDeg[1], rotationDeg[2] + bedYawDeg] as Vector3Mm,
        sizeMm: [width * cosine + depth * sine, width * sine + depth * cosine, height] as Vector3Mm,
        contactArea,
        bedYawDeg,
      };
    });
  });
}

function formatSize(size: Vector3Mm): string {
  return size.map((value) => Number(value.toFixed(2))).join(" × ");
}

function createSplitPlan(
  sizeMm: Vector3Mm,
  usableBuildVolumeMm: Vector3Mm,
  segmentCounts: [number, number, number],
  input: DfmInput,
  profile: ManufacturingProfile,
): NonNullable<DfmReport["splitPlan"]> {
  const axes: readonly DfmAxis[] = ["x", "y", "z"];
  const explicitCuts = input.split?.cutOffsetsMm;
  const expectedCutAxes = axes.filter((_, index) => segmentCounts[index]! > 1);
  if (explicitCuts && (explicitCuts.length !== expectedCutAxes.length
    || expectedCutAxes.some((axis) => !explicitCuts.some((entry) => entry.axis === axis)))) {
    throw new Error(`Explicit split offsets must define every split axis exactly once: ${expectedCutAxes.join(", ") || "no axes require splitting"}`);
  }
  const cutOffsetsMm = axes.flatMap((axis, index) => {
    const count = segmentCounts[index]!;
    if (count <= 1) return [];
    const requested = explicitCuts?.find((entry) => entry.axis === axis)?.offsetsMm;
    const offsetsMm = requested ?? Array.from({ length: count - 1 }, (_, cut) => segmentSizeForAxis(sizeMm[index]!, count) * (cut + 1));
    if (offsetsMm.length !== count - 1) throw new Error(`Split axis ${axis} requires exactly ${count - 1} cut offsets`);
    const sortedOffsets = [...offsetsMm].sort((left, right) => left - right);
    if (sortedOffsets.some((offset, cut) => offset <= 0 || offset >= sizeMm[index]! || (cut > 0 && offset - sortedOffsets[cut - 1]! <= 1e-9))) {
      throw new Error(`Split axis ${axis} offsets must be distinct, strictly ordered positions inside the part bounds`);
    }
    const offsetBounds = [0, ...sortedOffsets, sizeMm[index]!];
    const segmentLengths = offsetBounds.slice(1).map((end, cut) => end - offsetBounds[cut]!);
    if (segmentLengths.some((length) => length > usableBuildVolumeMm[index]! + 1e-6)) {
      throw new Error(`Explicit split offsets on ${axis} leave a segment larger than the usable build volume`);
    }
    return [{ axis, offsetsMm: sortedOffsets.map((offset) => Number(offset.toFixed(6))) }];
  });
  const protectedZones = input.split?.protectedZones ?? [];
  const cutConflicts = cutOffsetsMm.flatMap(({ axis, offsetsMm }) => offsetsMm.flatMap((cutOffsetMm) => protectedZones
    .filter((zone) => zone.axis === axis && cutOffsetMm >= zone.minMm - 1e-9 && cutOffsetMm <= zone.maxMm + 1e-9)
    .map((zone) => ({ zoneId: zone.id, sourceId: zone.sourceId, axis, cutOffsetMm, zoneMinMm: zone.minMm, zoneMaxMm: zone.maxMm }))));
  const maximumSegmentSizeMm = axes.map((axis, index) => {
    const cuts = cutOffsetsMm.find((entry) => entry.axis === axis)?.offsetsMm ?? [];
    const bounds = [0, ...cuts, sizeMm[index]!];
    return Math.max(...bounds.slice(1).map((end, cut) => end - bounds[cut]!));
  }) as Vector3Mm;
  const segmentSizeMm = sizeMm.map((value, axis) => value / segmentCounts[axis]!) as Vector3Mm;
  return {
    orientedSizeMm: sizeMm,
    usableBuildVolumeMm,
    segmentCounts,
    cutOffsetsMm,
    segmentSizeMm,
    maximumSegmentSizeMm,
    partCount: segmentCounts.reduce((product, count) => product * count, 1),
    joint: input.split?.joint ?? null,
    clearanceMm: input.split?.clearanceMm ?? profile.material.jointClearanceMm ?? null,
    jointOptions: ["flat", "alignment-pins", "tongue-and-groove", "dovetail", "screws-and-inserts"],
    cutOffsetsSource: explicitCuts ? "explicit" : "balanced",
    protectedZones,
    cutConflicts,
  };
}

function segmentSizeForAxis(sizeMm: number, count: number): number {
  return sizeMm / count;
}

function assertProtectedZonesWithinBounds(zones: DfmProtectedZone[], sizeMm: Vector3Mm): void {
  const axes: readonly DfmAxis[] = ["x", "y", "z"];
  for (const zone of zones) {
    const axisIndex = axes.indexOf(zone.axis);
    if (zone.maxMm > sizeMm[axisIndex]! + 1e-9) {
      throw new Error(`Protected zone ${zone.id} extends beyond oriented ${zone.axis} bounds`);
    }
  }
}
