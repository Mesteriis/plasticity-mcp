import type { OrthotropicFactoredAllowables, OrthotropicTsaiWuCriterion, StoredFemReport } from "./fem-report-store.ts";
import type { MaterialCouponProcess } from "../material-qualification.ts";

export interface StaticStressAllowableScreen {
  kind: "raw-peak-von-mises-to-factored-allowable-screen";
  allowableMPa: number;
  allowableEvidence: NonNullable<StoredFemReport["input"]["factoredVonMisesAllowableEvidence"]>;
  allowableBasis: string;
  interpretation: "diagnostic-only-no-strength-pass";
  overallStatus: "all-sampled-peaks-at-or-below-allowable" | "at-least-one-sampled-peak-above-allowable";
  cases: Array<{
    name: string;
    status: "all-sampled-peaks-at-or-below-allowable" | "at-least-one-sampled-peak-above-allowable";
    maximumSampledUtilization: number;
    samples: Array<{
      meshSizeMm: number;
      meshSha256: string;
      maximumVonMisesMPa: number;
      utilization: number;
      status: "at-or-below-allowable" | "above-allowable";
    }>;
  }>;
  limitations: string[];
}

export interface StaticStressAllowableScreenCaseInput {
  name: string;
  samples: Array<{ meshSizeMm: number; meshSha256: string; maximumVonMisesMPa: number }>;
}

type OrthotropicAllowableValues = Omit<OrthotropicFactoredAllowables, "evidence" | "basis">;
type TensorComponentExtrema = Record<"sxx" | "syy" | "szz" | "sxy" | "sxz" | "syz", { minimumMPa: number; maximumMPa: number }>;

export interface StaticOrthotropicMaximumStressScreen {
  kind: "raw-peak-orthotropic-maximum-stress-screen";
  criterion: "maximum-normal-stress-and-maximum-shear-stress";
  basis: "material-local";
  factoredAllowables: OrthotropicFactoredAllowables;
  interpretation: "diagnostic-only-no-strength-pass";
  overallStatus: "all-sampled-peaks-at-or-below-allowable" | "at-least-one-sampled-peak-above-allowable";
  cases: Array<{
    name: string;
    status: "all-sampled-peaks-at-or-below-allowable" | "at-least-one-sampled-peak-above-allowable";
    maximumSampledUtilization: number;
    samples: Array<{
      meshSizeMm: number;
      meshSha256: string;
      maximumUtilization: number;
      governingComponent: string;
      governingStressMPa: number;
      governingAllowableMPa: number;
      status: "at-or-below-allowable" | "above-allowable";
    }>;
  }>;
  limitations: string[];
}

export interface StaticOrthotropicTsaiWuScreen {
  kind: "orthotropic-tsai-wu-3d-proportional-load-factor-screen";
  process: MaterialCouponProcess;
  criterion: OrthotropicTsaiWuCriterion;
  interpretation: "diagnostic-only-no-strength-pass";
  overallStatus: "all-sampled-indices-below-one" | "at-least-one-sampled-index-at-or-above-one";
  cases: Array<{
    name: string;
    status: "all-sampled-indices-below-one" | "at-least-one-sampled-index-at-or-above-one";
    samples: Array<{
      meshSizeMm: number;
      meshSha256: string;
      maximumFailureIndex: number;
      maximumFailureIndexLocation: NonNullable<StoredFemReport["calculation"]["maximumVonMisesLocation"]>;
      minimumLoadFactorToIndexOne: number | null;
      minimumLoadFactorLocation: NonNullable<StoredFemReport["calculation"]["maximumVonMisesLocation"]> | null;
    }>;
  }>;
  limitations: string[];
}

export interface OrthotropicStressScreenSample {
  meshSizeMm: number;
  meshSha256: string;
  components: TensorComponentExtrema;
}

export function buildOrthotropicMaximumStressScreen(
  allowables: OrthotropicAllowableValues | undefined,
  evidence: OrthotropicFactoredAllowables["evidence"] | undefined,
  basis: string | undefined,
  sourceCases: Array<{ name: string; samples: OrthotropicStressScreenSample[] }>,
): StaticOrthotropicMaximumStressScreen | null {
  if (!allowables || !evidence || !basis) return null;
  const shearPeak = (component: string, minimumMPa: number, maximumMPa: number, allowableMPa: number) => {
    const stressMPa = Math.abs(minimumMPa) >= Math.abs(maximumMPa) ? minimumMPa : maximumMPa;
    return { component, stressMPa, allowableMPa, value: Math.abs(stressMPa) / allowableMPa };
  };
  const cases = sourceCases.map((loadCase) => {
    const samples = loadCase.samples.map((sample) => {
      const utilizations = [
        { component: "Sxx tension", stressMPa: sample.components.sxx.maximumMPa, allowableMPa: allowables.xTensionMPa, value: Math.max(0, sample.components.sxx.maximumMPa) / allowables.xTensionMPa },
        { component: "Sxx compression", stressMPa: sample.components.sxx.minimumMPa, allowableMPa: allowables.xCompressionMPa, value: Math.abs(sample.components.sxx.minimumMPa) / allowables.xCompressionMPa },
        { component: "Syy tension", stressMPa: sample.components.syy.maximumMPa, allowableMPa: allowables.yTensionMPa, value: Math.max(0, sample.components.syy.maximumMPa) / allowables.yTensionMPa },
        { component: "Syy compression", stressMPa: sample.components.syy.minimumMPa, allowableMPa: allowables.yCompressionMPa, value: Math.abs(sample.components.syy.minimumMPa) / allowables.yCompressionMPa },
        { component: "Szz tension", stressMPa: sample.components.szz.maximumMPa, allowableMPa: allowables.zTensionMPa, value: Math.max(0, sample.components.szz.maximumMPa) / allowables.zTensionMPa },
        { component: "Szz compression", stressMPa: sample.components.szz.minimumMPa, allowableMPa: allowables.zCompressionMPa, value: Math.abs(sample.components.szz.minimumMPa) / allowables.zCompressionMPa },
        shearPeak("Sxy shear", sample.components.sxy.minimumMPa, sample.components.sxy.maximumMPa, allowables.xyShearMPa),
        shearPeak("Sxz shear", sample.components.sxz.minimumMPa, sample.components.sxz.maximumMPa, allowables.xzShearMPa),
        shearPeak("Syz shear", sample.components.syz.minimumMPa, sample.components.syz.maximumMPa, allowables.yzShearMPa),
      ];
      const governing = utilizations.reduce((maximum, current) => current.value > maximum.value ? current : maximum);
      if (!Number.isFinite(governing.value)) throw new Error("Orthotropic FEA stress-to-allowable utilization is outside the finite numeric range");
      return {
        meshSizeMm: sample.meshSizeMm,
        meshSha256: sample.meshSha256,
        maximumUtilization: governing.value,
        governingComponent: governing.component,
        governingStressMPa: governing.stressMPa,
        governingAllowableMPa: governing.allowableMPa,
        status: governing.value > 1 ? "above-allowable" as const : "at-or-below-allowable" as const,
      };
    });
    const maximumSampledUtilization = Math.max(...samples.map((sample) => sample.maximumUtilization));
    return {
      name: loadCase.name,
      status: maximumSampledUtilization > 1
        ? "at-least-one-sampled-peak-above-allowable" as const
        : "all-sampled-peaks-at-or-below-allowable" as const,
      maximumSampledUtilization,
      samples,
    };
  });
  return {
    kind: "raw-peak-orthotropic-maximum-stress-screen",
    criterion: "maximum-normal-stress-and-maximum-shear-stress",
    basis: "material-local",
    factoredAllowables: { ...allowables, evidence, basis },
    interpretation: "diagnostic-only-no-strength-pass",
    overallStatus: cases.some((loadCase) => loadCase.status === "at-least-one-sampled-peak-above-allowable")
      ? "at-least-one-sampled-peak-above-allowable"
      : "all-sampled-peaks-at-or-below-allowable",
    cases,
    limitations: [
      "This is a componentwise maximum-stress screen against nine supplied, already factored directional allowables in the material-local frame; the server does not derive allowables or interaction terms.",
      "This treats the printed body as one homogeneous orthotropic continuum; it does not model individual layer interfaces, delamination or joints between different materials. Z-tension and XZ/YZ allowables may reflect matched interlayer test data, but this component screen does not resolve interface failure.",
      "It does not account for multiaxial interaction, nonlinear response, buckling, fatigue, stress concentrations, uncertainty or load/support validity; a below-allowable result does not establish part strength.",
      "Integration-point mesh samples are diagnostic and do not prove convergence. This screen never grants strengthPass or printApproved.",
    ],
  };
}

export function buildStressAllowableScreen(
  allowableMPa: number | undefined,
  allowableEvidence: StaticStressAllowableScreen["allowableEvidence"] | undefined,
  allowableBasis: string | undefined,
  sourceCases: StaticStressAllowableScreenCaseInput[],
): StaticStressAllowableScreen | null {
  if (allowableMPa === undefined || !allowableEvidence || !allowableBasis) return null;
  const cases = sourceCases.map((loadCase) => {
    const samples = loadCase.samples.map((sample) => {
      const utilization = sample.maximumVonMisesMPa / allowableMPa;
      if (!Number.isFinite(utilization)) throw new Error("Static FEA stress-to-allowable utilization is outside the finite numeric range");
      return {
        ...sample,
        utilization,
        status: utilization > 1 ? "above-allowable" as const : "at-or-below-allowable" as const,
      };
    });
    const maximumSampledUtilization = Math.max(...samples.map((sample) => sample.utilization));
    return {
      name: loadCase.name,
      status: maximumSampledUtilization > 1
        ? "at-least-one-sampled-peak-above-allowable" as const
        : "all-sampled-peaks-at-or-below-allowable" as const,
      maximumSampledUtilization,
      samples,
    };
  });
  const overallStatus = cases.some((loadCase) => loadCase.status === "at-least-one-sampled-peak-above-allowable")
    ? "at-least-one-sampled-peak-above-allowable" as const
    : "all-sampled-peaks-at-or-below-allowable" as const;
  return {
    kind: "raw-peak-von-mises-to-factored-allowable-screen",
    allowableMPa,
    allowableEvidence,
    allowableBasis,
    interpretation: "diagnostic-only-no-strength-pass",
    overallStatus,
    cases,
    limitations: [
      "This compares raw mesh integration-point peak stress with the supplied factored design allowable; the allowable must already include the chosen design factors.",
      "An exceedance flags a sampled analysis result; a below-allowable result does not establish strength, because stress concentrations, discretization error, support/load validity, buckling, fatigue, nonlinear behavior and material anisotropy are not resolved by this screen.",
      "Mesh-level samples are not proof of convergence, and this screen never grants strengthPass or printApproved.",
    ],
  };
}

export function buildStaticStressAllowableScreen(report: StoredFemReport): StaticStressAllowableScreen | null {
  const allowableMPa = report.input.factoredVonMisesAllowableMPa;
  const allowableEvidence = report.input.factoredVonMisesAllowableEvidence;
  const allowableBasis = report.input.factoredVonMisesAllowableBasis;
  const cases = (report.cases ?? [{
    name: "default",
    calculation: report.calculation,
    meshLevels: [{
      meshSizeMm: report.mesh.meshSizeMm,
      meshSha256: report.mesh.meshSha256 ?? "",
      calculation: report.calculation,
    }],
  }]).map((loadCase) => {
    const caseMeshSha256 = "meshSha256" in loadCase ? loadCase.meshSha256 : undefined;
    const levels = loadCase.meshLevels?.length
      ? loadCase.meshLevels
      : [{ meshSizeMm: report.mesh.meshSizeMm, meshSha256: caseMeshSha256 ?? report.mesh.meshSha256 ?? "", calculation: loadCase.calculation }];
    return {
      name: loadCase.name,
      samples: levels.map((level) => ({
        meshSizeMm: level.meshSizeMm,
        meshSha256: level.meshSha256,
        maximumVonMisesMPa: level.calculation.maximumVonMisesMPa,
      })),
    };
  });
  return buildStressAllowableScreen(allowableMPa, allowableEvidence, allowableBasis, cases);
}

export function buildStaticOrthotropicStressScreen(report: StoredFemReport): StaticOrthotropicMaximumStressScreen | null {
  const factoredAllowables = "orthotropicMaterial" in report.input ? report.input.orthotropicMaterial?.factoredAllowables : undefined;
  if (!factoredAllowables) return null;
  const cases = (report.cases ?? [{
    name: "default",
    calculation: report.calculation,
    meshLevels: [{ meshSizeMm: report.mesh.meshSizeMm, meshSha256: report.mesh.meshSha256 ?? "", calculation: report.calculation }],
  }]).map((loadCase) => {
    const caseMeshSha256 = "meshSha256" in loadCase ? loadCase.meshSha256 : undefined;
    const levels = loadCase.meshLevels?.length
      ? loadCase.meshLevels
      : [{ meshSizeMm: report.mesh.meshSizeMm, meshSha256: caseMeshSha256 ?? report.mesh.meshSha256 ?? "", calculation: loadCase.calculation }];
    return {
      name: loadCase.name,
      samples: levels.map((level) => {
        const components = level.calculation.stressTensorComponentExtrema;
        if (!components) throw new Error("Orthotropic FEA report is missing local stress tensor component extrema");
        if (level.calculation.stressCoordinateBasis !== "material-local") throw new Error("Directional maximum-stress screening requires one homogeneous material-local frame; per-layer frame results need a layer-aware criterion");
        return { meshSizeMm: level.meshSizeMm, meshSha256: level.meshSha256, components };
      }),
    };
  });
  const { evidence, basis, ...allowableValues } = factoredAllowables;
  return buildOrthotropicMaximumStressScreen(allowableValues, evidence, basis, cases);
}

export function buildStaticOrthotropicTsaiWuScreen(report: StoredFemReport): StaticOrthotropicTsaiWuScreen | null {
  const orthotropic = "orthotropicMaterial" in report.input ? report.input.orthotropicMaterial : undefined;
  const process = orthotropic?.process;
  const criterion = orthotropic?.tsaiWuCriterion;
  if (!criterion) return null;
  if (!process) throw new Error("Stored Tsai-Wu data is missing its exact single-material print process");
  const cases = (report.cases ?? [{
    name: "default",
    calculation: report.calculation,
    meshLevels: [{ meshSizeMm: report.mesh.meshSizeMm, meshSha256: report.mesh.meshSha256 ?? "", calculation: report.calculation }],
  }]).map((loadCase) => {
    const caseMeshSha256 = "meshSha256" in loadCase ? loadCase.meshSha256 : undefined;
    const levels = loadCase.meshLevels?.length
      ? loadCase.meshLevels
      : [{ meshSizeMm: report.mesh.meshSizeMm, meshSha256: caseMeshSha256 ?? report.mesh.meshSha256 ?? "", calculation: loadCase.calculation }];
    const samples = levels.map((level) => {
      const result = level.calculation.orthotropicTsaiWu;
      if (!result) throw new Error("Stored FEA result is missing the requested per-integration-point Tsai-Wu screen");
      return {
        meshSizeMm: level.meshSizeMm,
        meshSha256: level.meshSha256,
        ...result,
      };
    });
    const exceeded = samples.some((sample) => sample.maximumFailureIndex >= 1);
    return {
      name: loadCase.name,
      status: exceeded ? "at-least-one-sampled-index-at-or-above-one" as const : "all-sampled-indices-below-one" as const,
      samples,
    };
  });
  return {
    kind: "orthotropic-tsai-wu-3d-proportional-load-factor-screen",
    process,
    criterion,
    interpretation: "diagnostic-only-no-strength-pass",
    overallStatus: cases.some((loadCase) => loadCase.status === "at-least-one-sampled-index-at-or-above-one")
      ? "at-least-one-sampled-index-at-or-above-one"
      : "all-sampled-indices-below-one",
    cases,
    limitations: [
      "This evaluates the measured 3D Tsai-Wu surface at each local material-frame integration-point tensor; the interaction matrix and strengths must come from the exact saved single-material process.",
      "The proportional load factor scales one named linear-elastic load case uniformly; it is not a factor of safety for changing load mixtures.",
      "The continuum remains homogeneous and does not resolve individual roads, discrete layer interfaces, delamination, nonlinear behavior, buckling, fatigue, uncertainty, support validity or mesh convergence.",
      "A sampled index below one is diagnostic only and does not establish whole-part strength, a strengthPass or print approval.",
    ],
  };
}
