import type { Evidence, EvidenceStatus, EvidenceUnit, Material } from "./contracts.ts";
import type { FreeMoment, PointForce, SectionScenarioInput } from "./section-contracts.ts";
import { integrateSection, type SectionLoop } from "./section-geometry.ts";

type Vector3 = [number, number, number];

export interface SectionFixtureOptions {
  loops?: SectionLoop[];
  forceN?: Vector3;
  pointMm?: Vector3;
  freeMoments?: Vector3[];
  shearLimitMPa?: number | null;
  suitability?: Material["suitability"];
  effectiveSection?: Material["manufacturing"]["effectiveSection"];
  thinWallAssumption?: boolean;
}

export function sectionScenarioFixture(options: SectionFixtureOptions = {}): SectionScenarioInput {
  const loops = options.loops ?? [rectangleLoop(-5, -2, 10, 4)];
  const properties = integrateSection(loops);
  const evidence: Evidence[] = [];
  const assignments: Record<string, string> = {};
  const add = (path: string, value: number, unit: EvidenceUnit, status: EvidenceStatus = "measured"): string => {
    const id = `e-${path.replaceAll(/[^A-Za-z0-9]+/g, "-")}`;
    evidence.push({ id, label: `TEST ONLY ${path}`, status, unit, value, dependsOn: [] });
    assignments[path] = id;
    return id;
  };

  add("properties.areaMm2", properties.areaMm2, "mm2");
  add("properties.centroidLocalMm.x", properties.centroidLocalMm[0], "mm");
  add("properties.centroidLocalMm.y", properties.centroidLocalMm[1], "mm");
  add("properties.ixxMm4", properties.ixxMm4, "mm4");
  add("properties.iyyMm4", properties.iyyMm4, "mm4");
  add("properties.ixyMm4", properties.ixyMm4, "mm4");

  const force = options.forceN ?? [0, 0, 100];
  const point = options.pointMm ?? [0, 0, 0];
  const forceEvidenceIds: string[] = [];
  for (const [axis, value] of (["x", "y", "z"] as const).map((axis, index) => [axis, force[index]!] as const)) {
    forceEvidenceIds.push(add(`pointForces.load-1.forceN.${axis}`, value, "N", "assumed"));
  }
  for (const [axis, value] of (["x", "y", "z"] as const).map((axis, index) => [axis, point[index]!] as const)) {
    forceEvidenceIds.push(add(`pointForces.load-1.pointMm.${axis}`, value, "mm", "assumed"));
  }
  const pointForces: PointForce[] = [{ id: "load-1", forceN: force, pointMm: point, evidenceIds: forceEvidenceIds }];

  const freeMoments: FreeMoment[] = (options.freeMoments ?? []).map((momentNmm, index) => {
    const id = `moment-${index + 1}`;
    const evidenceIds = (["x", "y", "z"] as const).map((axis, component) =>
      add(`freeMoments.${id}.momentNmm.${axis}`, momentNmm[component]!, "Nmm", "assumed"));
    return { id, momentNmm, evidenceIds };
  });

  const tensileId = add("material.tensileLimitMPa", 10, "MPa", "sourced");
  const compressiveId = add("material.compressiveLimitMPa", 10, "MPa", "sourced");
  const materialEvidenceIds = [tensileId, compressiveId];
  const shearLimitMPa = options.shearLimitMPa === undefined ? 5 : options.shearLimitMPa;
  if (shearLimitMPa !== null) materialEvidenceIds.push(add("material.shearLimitMPa", shearLimitMPa, "MPa", "sourced"));
  const safetyId = add("safetyFactor", 2, "ratio", "assumed");

  return {
    kind: "planar-section",
    goal: "Synthetic planar section",
    method: "planar-section-resultants-v1",
    frame: { originMm: [0, 0, 0], normal: [0, 0, 1], xDirection: [1, 0, 0] },
    loops,
    properties,
    pointForces,
    freeMoments,
    material: {
      id: "synthetic-section-material",
      name: "TEST ONLY section material",
      evidenceIds: materialEvidenceIds,
      tensileLimitMPa: 10,
      compressiveLimitMPa: 10,
      ...(shearLimitMPa === null ? {} : { shearLimitMPa }),
      suitability: options.suitability ?? "matched",
      manufacturing: {
        printerId: "synthetic-printer",
        profileHash: "synthetic-profile",
        orientationDeg: [0, 0, 0],
        infillPercent: 100,
        temperatureC: 200,
        effectiveSection: options.effectiveSection ?? "solid",
      },
    },
    safetyFactor: 2,
    evidence,
    assignments,
    assumptions: [
      { code: "static-load", confirmed: true, evidenceIds: forceEvidenceIds },
      { code: "homogeneous-equivalent-section", confirmed: true, evidenceIds: materialEvidenceIds },
      { code: "section-resultants-represent-load-path", confirmed: true, evidenceIds: [...forceEvidenceIds, ...freeMoments.flatMap((moment) => moment.evidenceIds)] },
      ...(options.thinWallAssumption === undefined ? [] : [{ code: "THIN_WALLED_SINGLE_CELL_TORSION", confirmed: options.thinWallAssumption, evidenceIds: [] }]),
    ],
  };
}

export function rectangleLoop(x: number, y: number, width: number, height: number): SectionLoop {
  return { segments: [
    { kind: "line", start: [x, y], end: [x + width, y] },
    { kind: "line", start: [x + width, y], end: [x + width, y + height] },
    { kind: "line", start: [x + width, y + height], end: [x, y + height] },
    { kind: "line", start: [x, y + height], end: [x, y] },
  ] };
}

export function circleLoop(center: [number, number], radius: number): SectionLoop {
  return { segments: [{ kind: "arc", center, radius, startRadians: 0, sweepRadians: 2 * Math.PI }] };
}
