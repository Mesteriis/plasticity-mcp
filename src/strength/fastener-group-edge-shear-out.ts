export interface FastenerGroupEdgeShearOutInput {
  thicknessMm: number;
  designAllowableMPa: number;
  qualified: boolean;
  fasteners: Array<{
    id: string;
    holeDiameterMm: number;
    centerToEdgesMm: { minX: number; maxX: number; minY: number; maxY: number };
  }>;
  demands: Array<{ id: string; resultantN: { x: number; y: number }; magnitudeN: number }>;
}

export interface FastenerGroupEdgeShearOutResult {
  status: "within-allowable" | "exceeds-allowable" | "conditional" | "unsupported";
  fasteners: Array<{
    id: string;
    demandN: number;
    axis?: "x" | "y";
    loadedEdge?: "+X" | "-X" | "+Y" | "-Y";
    centerToLoadedEdgeMm?: number;
    holeDiameterMm: number;
    edgeDistanceDiameterRatio?: number;
    netLigamentMm?: number;
    shearAreaMm2?: number;
    nominalShearOutStressMPa?: number;
    designAllowableMPa: number;
    utilization?: number;
    checkStatus: "within-allowable" | "exceeds-allowable" | "conditional" | "unsupported" | "not-loaded";
    issue?: string;
  }>;
  governing?: { fastenerId: string; utilization: number };
  issues: string[];
}

const AXIS_ALIGNMENT_RELATIVE_TOLERANCE = 1e-8;
const FORCE_TOLERANCE_N = 1e-10;

/** Applies the bounded two-plane loaded-edge formula only to axis-aligned per-fastener demands. */
export function calculateFastenerGroupEdgeShearOut(input: FastenerGroupEdgeShearOutInput): FastenerGroupEdgeShearOutResult {
  if (!Number.isFinite(input.thicknessMm) || input.thicknessMm <= 0) throw new Error("Plate thickness must be finite and positive");
  if (!Number.isFinite(input.designAllowableMPa) || input.designAllowableMPa <= 0) throw new Error("Shear-out design allowable must be finite and positive");
  if (input.fasteners.length === 0 || input.demands.length !== input.fasteners.length) throw new Error("Every exact plate fastener must have one matching load demand");

  const geometryById = new Map(input.fasteners.map((fastener) => [fastener.id, fastener]));
  const demandsById = new Map(input.demands.map((demand) => [demand.id, demand]));
  if (geometryById.size !== input.fasteners.length || demandsById.size !== input.demands.length) throw new Error("Fastener IDs must be unique");
  if (input.demands.some((demand) => !geometryById.has(demand.id)) || input.fasteners.some((fastener) => !demandsById.has(fastener.id))) {
    throw new Error("Native fastener identities do not match the group load demands");
  }

  const issues: string[] = [];
  let sawUnsupported = false;
  let sawConditional = false;
  let sawExceedance = false;
  const fasteners: FastenerGroupEdgeShearOutResult["fasteners"] = input.fasteners.map((geometry) => {
    const demand = demandsById.get(geometry.id)!;
    const vectorX = demand.resultantN.x;
    const vectorY = demand.resultantN.y;
    const magnitude = Math.hypot(vectorX, vectorY);
    if (![vectorX, vectorY, demand.magnitudeN, geometry.holeDiameterMm, ...Object.values(geometry.centerToEdgesMm)].every(Number.isFinite)
        || geometry.holeDiameterMm <= 0 || demand.magnitudeN < 0
        || Math.abs(magnitude - demand.magnitudeN) > Math.max(FORCE_TOLERANCE_N, demand.magnitudeN * 1e-8)) {
      throw new Error(`Fastener ${geometry.id} has inconsistent geometry or force-resultant evidence`);
    }
    const base = { id: geometry.id, demandN: demand.magnitudeN, holeDiameterMm: geometry.holeDiameterMm, designAllowableMPa: input.designAllowableMPa };
    if (magnitude <= FORCE_TOLERANCE_N) return { ...base, checkStatus: "not-loaded" as const };

    const xDominant = Math.abs(vectorX) >= Math.abs(vectorY);
    const primary = xDominant ? vectorX : vectorY;
    const transverse = xDominant ? vectorY : vectorX;
    if (Math.abs(transverse) > Math.max(FORCE_TOLERANCE_N, magnitude * AXIS_ALIGNMENT_RELATIVE_TOLERANCE)) {
      const issue = `Fastener ${geometry.id} has a non-axis-aligned in-plane demand; this two-plane rectangle edge model is unsupported.`;
      issues.push(issue);
      sawUnsupported = true;
      return { ...base, checkStatus: "unsupported" as const, issue };
    }

    const axis = xDominant ? "x" as const : "y" as const;
    const direction = primary > 0 ? 1 : -1;
    const edgeKey = axis === "x"
      ? direction > 0 ? "maxX" : "minX"
      : direction > 0 ? "maxY" : "minY";
    const loadedEdge = axis === "x" ? direction > 0 ? "+X" as const : "-X" as const : direction > 0 ? "+Y" as const : "-Y" as const;
    const centerToLoadedEdgeMm = geometry.centerToEdgesMm[edgeKey];
    const netLigamentMm = centerToLoadedEdgeMm - geometry.holeDiameterMm / 2;
    const edgeDistanceDiameterRatio = centerToLoadedEdgeMm / geometry.holeDiameterMm;
    if (!(centerToLoadedEdgeMm > geometry.holeDiameterMm / 2) || edgeDistanceDiameterRatio < 1.5) {
      const issue = `Fastener ${geometry.id} has e/d=${edgeDistanceDiameterRatio.toPrecision(5)} below the simplified two-plane shear-out method limit of 1.5.`;
      issues.push(issue);
      sawUnsupported = true;
      return {
        ...base, axis, loadedEdge, centerToLoadedEdgeMm, edgeDistanceDiameterRatio, netLigamentMm,
        checkStatus: "unsupported" as const, issue,
      };
    }

    const shearAreaMm2 = 2 * input.thicknessMm * netLigamentMm;
    const nominalShearOutStressMPa = demand.magnitudeN / shearAreaMm2;
    const utilization = nominalShearOutStressMPa / input.designAllowableMPa;
    if (![shearAreaMm2, nominalShearOutStressMPa, utilization].every(Number.isFinite)) throw new Error(`Fastener ${geometry.id} shear-out calculation overflowed`);
    const qualified = input.qualified && edgeDistanceDiameterRatio >= 2;
    const checkStatus = !qualified
      ? "conditional" as const
      : utilization > 1 ? "exceeds-allowable" as const : "within-allowable" as const;
    if (edgeDistanceDiameterRatio < 2) {
      sawConditional = true;
      issues.push(`Fastener ${geometry.id} has e/d=${edgeDistanceDiameterRatio.toPrecision(5)} below the nominal 2d edge-distance practice; review the result deliberately.`);
    }
    if (!input.qualified) sawConditional = true;
    if (checkStatus === "exceeds-allowable") {
      sawExceedance = true;
      issues.push(`Fastener ${geometry.id} two-plane edge shear-out utilization ${utilization.toPrecision(5)} exceeds the supplied factored allowable.`);
    } else if (utilization > 1) {
      issues.push(`Fastener ${geometry.id} calculated shear-out utilization exceeds 1, but the check remains conditional because its assumptions or material match are unconfirmed.`);
    }
    return {
      ...base, axis, loadedEdge, centerToLoadedEdgeMm, edgeDistanceDiameterRatio, netLigamentMm,
      shearAreaMm2, nominalShearOutStressMPa, utilization, checkStatus,
    };
  });

  const supported = fasteners.filter((fastener) => fastener.utilization !== undefined);
  const governingFastener = supported.reduce<(typeof supported)[number] | undefined>(
    (largest, candidate) => !largest || candidate.utilization! > largest.utilization! ? candidate : largest,
    undefined,
  );
  const status = sawExceedance ? "exceeds-allowable" as const
    : sawUnsupported ? "unsupported" as const
      : sawConditional || !governingFastener ? "conditional" as const
        : "within-allowable" as const;
  if (!input.qualified && !sawUnsupported) issues.push("At least one shear-out model assumption, material match, load model or allowable evidence is not fully confirmed.");
  return {
    status,
    fasteners,
    ...(governingFastener ? { governing: { fastenerId: governingFastener.id, utilization: governingFastener.utilization! } } : {}),
    issues,
  };
}
