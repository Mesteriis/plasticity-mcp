import type { MethodId } from "./contracts.ts";

export interface MethodDescriptor {
  id: MethodId;
  version: string;
  requiredInputPaths: string[];
  assumptions: string[];
  exclusions: string[];
  sourceUrls: string[];
}

const SOURCES = {
  mit: "https://ocw.mit.edu/courses/2-002-mechanics-and-materials-ii-spring-2004/9aebe9fc6669d928aa716a5033cc9c9f_lab_1_s04.pdf",
  tudelft: "https://ocw.tudelft.nl/course-readings/axial-loaded-members-summary-key-formulas-2/",
  purdue: "https://www.purdue.edu/freeform/me323/wp-content/uploads/sites/2/2018/10/ME323_F18_Hw7_final.pdf",
  purdueCircle: "https://www.purdue.edu/freeform/me323/wp-content/uploads/sites/2/2020/03/HW5solution.pdf",
  nasaColumn: "https://ntrs.nasa.gov/api/citations/19930013915/downloads/19930013915.pdf",
  washington: "https://courses.washington.edu/me354a/salient.pdf",
  nasaPlate: "https://ntrs.nasa.gov/api/citations/19760066879/downloads/19760066879.pdf",
  nasaLargeDeflection: "https://ntrs.nasa.gov/citations/19790044251",
  mstTorsion: "https://web.mst.edu/jthomas/classes/2210/fe_review/guides/2013.07.26.pdf",
  uahTorsion: "https://www.uah.edu/images/administrative/student-success-center/resources/handouts/handouts_2019/mechanics_of_materials_axial_loads_and_torsion.pdf",
  nasaFastener: "https://ntrs.nasa.gov/citations/19900009424",
  nasaJoint: "https://ntrs.nasa.gov/citations/19960012183",
  nasaFastenerInteraction: "https://ntrs.nasa.gov/citations/20150002750",
  nasaThreadedFastenerStandard: "https://standards.nasa.gov/node/254",
  spirolInsertGuide: "https://www.spirol.com/assets/files/ins-threaded-inserts-design-guide-us.pdf",
  spirolHoleGuide: "https://www.spirol.com/resources/white-papers/how-to-design-the-proper-hole-for-heat-ultrasonic-inserts/",
  mitBeamBending: "https://ocw.mit.edu/courses/16-001-unified-engineering-materials-and-structures-fall-2021/mit16_001_f21_lec22lec23lec24.pdf",
  mitBeamStress: "https://ocw.mit.edu/courses/3-11-mechanics-of-materials-fall-1999/96d839b02e4a6c63cf8031800e89cccd_MIT3_11F99_bstress.pdf",
  cowperShear: "https://doi.org/10.1115/1.3625046",
} as const;

const METHODS: MethodDescriptor[] = [
  {
    id: "axial-rectangle-v1",
    version: "1.0.0",
    requiredInputPaths: [
      "lengthMm", "widthMm", "heightMm", "forceN", "material.youngMPa",
      "material.tensileLimitMPa", "safetyFactor", "maxDisplacementMm",
    ],
    assumptions: ["static-load", "linear-elastic", "homogeneous-equivalent-section"],
    exclusions: ["compression", "buckling", "holes", "variable section", "local load introduction"],
    sourceUrls: [SOURCES.tudelft, SOURCES.mit],
  },
  {
    id: "cantilever-tip-rectangle-v1",
    version: "1.0.0",
    requiredInputPaths: [
      "lengthMm", "widthMm", "heightMm", "forceN", "material.youngMPa",
      "material.tensileLimitMPa", "material.compressiveLimitMPa", "safetyFactor",
      "maxDisplacementMm",
    ],
    assumptions: [
      "static-load",
      "ideal-support",
      "linear-elastic",
      "homogeneous-equivalent-section",
      "negligible-shear-deformation",
      "no-lateral-instability",
    ],
    exclusions: ["distributed load", "multiple loads", "holes", "variable section", "torsion", "local load introduction"],
    sourceUrls: [SOURCES.mit, SOURCES.purdue],
  },
  {
    id: "simply-supported-plate-uniform-pressure-v1",
    version: "1.0.0",
    requiredInputPaths: [
      "lengthMm", "widthMm", "heightMm", "pressureMPa", "poissonRatio",
      "material.youngMPa", "material.tensileLimitMPa", "material.compressiveLimitMPa",
      "safetyFactor", "maxDisplacementMm",
    ],
    assumptions: [
      "static-load",
      "uniform-pressure",
      "ideal-simply-supported-four-edges",
      "linear-elastic",
      "homogeneous-isotropic-equivalent-plate",
      "thin-plate-kinematics",
    ],
    exclusions: [
      "clamped, free or compliant edges",
      "openings, ribs, bosses, curvature or varying thickness",
      "concentrated or partial pressure",
      "large-deflection membrane action",
      "buckling, local contact, joints, fatigue, creep and impact",
      "layer delamination and structural-code compliance",
    ],
    sourceUrls: [SOURCES.nasaPlate, SOURCES.nasaLargeDeflection],
  },
  {
    id: "euler-column-buckling-v1",
    version: "1.0.0",
    requiredInputPaths: [
      "lengthMm", "widthMm", "heightMm", "forceN", "effectiveLengthFactor",
      "material.youngMPa", "material.elasticLimitMPa", "material.compressiveLimitMPa", "safetyFactor",
    ],
    assumptions: [
      "static-load",
      "centred-axial-compression",
      "straight-prismatic-column",
      "ideal-effective-length-factor",
      "linear-elastic",
      "homogeneous-equivalent-section",
    ],
    exclusions: [
      "eccentricity, initial curvature and load-introduction bending",
      "inelastic or transition-region buckling",
      "local plate, shell, torsional or flexural-torsional buckling",
      "variable sections, holes, joints and intermediate restraints",
      "anisotropy, creep, fatigue, impact and structural-code compliance",
    ],
    sourceUrls: [SOURCES.nasaColumn, SOURCES.mit],
  },
  {
    id: "single-fastener-plate-v1",
    version: "1.0.0",
    requiredInputPaths: [
      "geometry.thicknessMm",
      "geometry.holeDiameterMm",
      "geometry.loadedEdgeDistanceMm",
      "geometry.oppositeEdgeDistanceMm",
      "geometry.grossWidthMm",
      "geometry.sideClearancesMm.0",
      "geometry.sideClearancesMm.1",
      "loadN",
      "material.bearingLimitMPa",
      "material.shearLimitMPa",
      "material.tensileLimitMPa",
      "safetyFactor",
    ],
    assumptions: [
      "static-in-plane-load",
      "single-fastener-load-path",
      "load-centered-through-thickness",
      "homogeneous-equivalent-plate",
      "nominal-bearing-contact",
    ],
    exclusions: [
      "fastener strength and combined loading",
      "preload, slip and clearance distribution",
      "fatigue, creep and impact",
      "plate bending, prying, pull-through, inserts and threads",
      "multiple-fastener interaction and structural-code compliance",
    ],
    sourceUrls: [SOURCES.nasaFastener, SOURCES.nasaJoint],
  },
  {
    id: "fastener-member-v1",
    version: "1.0.0",
    requiredInputPaths: [
      "geometry.nominalDiameterMm",
      "geometry.tensileStressAreaMm2",
      "geometry.shearAreaPerPlaneMm2",
      "geometry.shearPlaneCount",
      "loads.axialTensionN",
      "loads.transverseShearN",
      "material.tensileLimitMPa",
      "material.shearLimitMPa",
      "safetyFactor",
    ],
    assumptions: [
      "static-load",
      "single-fastener-load-known",
      "no-fastener-bending",
      "axial-load-collinear",
      "shear-plane-count-and-location-known",
      "axial-force-includes-applicable-preload",
      "interaction-criterion-accepted for combined loading",
    ],
    exclusions: [
      "fastener bending from joint gaps, shims or eccentricity",
      "joint slip, clamp preload loss and load redistribution",
      "thread stripping, insert pull-out and head pull-through",
      "joined-member failure, fatigue, vibration, creep, impact and corrosion",
      "multiple-fastener interaction and structural-code compliance",
    ],
    sourceUrls: [SOURCES.nasaFastener, SOURCES.nasaJoint, SOURCES.nasaFastenerInteraction],
  },
  {
    id: "tongue-root-transverse-v1",
    version: "1.0.0",
    requiredInputPaths: [
      "geometry.rootWidthMm", "geometry.rootThicknessMm", "geometry.leverArmMm", "loads.transverseForceN",
      "material.youngModulusMPa", "material.shearModulusMPa", "material.tensileAllowableMPa", "material.shearAllowableMPa",
      "shearCorrectionFactor", "safetyFactor", "maxDeflectionMm",
    ],
    assumptions: [
      "static-load", "ideal-fixed-root", "beam-kinematics-applicable", "point-load-at-known-lever-arm", "rectangular-prismatic-root",
      "linear-elastic-effective-properties", "root-stress-concentration-not-included",
    ],
    exclusions: [
      "groove wall bearing, splitting, contact pressure and engagement-length distribution",
      "root stress concentration, multiaxial failure and three-dimensional load introduction",
      "print anisotropy beyond supplied orientation-specific effective properties",
      "fatigue, creep, impact, temperature and whole-joint safety",
    ],
    sourceUrls: [SOURCES.mitBeamBending, SOURCES.mitBeamStress, SOURCES.cowperShear],
  },
  {
    id: "threaded-receiver-axial-v1",
    version: "1.0.0",
    requiredInputPaths: [
      "configuration.nominalDiameterMm",
      "configuration.pitchMm",
      "configuration.engagementMm",
      "configuration.completeThreadCount",
      "loads.axialTensionN",
      "capacity.internalThreadStripAllowableN",
      "capacity.externalThreadStripAllowableN",
      "capacity.fastenerTensileAllowableN",
      "safetyFactor",
    ],
    assumptions: [
      "static-axial-load",
      "worst-case-receiver-demand-known",
      "fully-formed-engaged-thread-count-known",
      "capacity-matches-thread-form-class-material-and-engagement",
      "axial-force-includes-applicable-preload",
      "no-prying-bending-or-transverse-load",
    ],
    exclusions: [
      "preload generation, torque scatter, separation and relaxation beyond supplied demand",
      "transverse shear, bearing, slip, prying, fastener bending and eccentricity",
      "nonuniform thread loading outside qualified allowables",
      "incomplete thread and blind-hole bottoming",
      "fatigue, vibration, galling, wear, corrosion, creep, impact and temperature",
      "receiver parent-part pullout, boss splitting and surrounding-member failure",
      "multiple-fastener distribution and structural-code compliance",
    ],
    sourceUrls: [SOURCES.nasaThreadedFastenerStandard, SOURCES.nasaFastener],
  },
  {
    id: "heat-set-insert-retention-v1",
    version: "1.0.0",
    requiredInputPaths: [
      "configuration.insertLengthMm",
      "configuration.threadPitchMm",
      "configuration.holeDiameterMm",
      "configuration.holeDepthMm",
      "demands.axialPulloutPerInsertN",
      "demands.torquePerInsertNmm",
      "capacity.pulloutN",
      "capacity.torqueOutNmm",
      "safetyFactor",
    ],
    assumptions: [
      "static-load",
      "worst-case-per-insert-demand-known",
      "insert-installed-flush",
      "screw-does-not-bottom-out",
      "installation-process-matches-qualification",
      "hole-boss-and-host-match-qualification",
    ],
    exclusions: [
      "combined pullout and torque interaction",
      "transverse shear, bearing, prying and host-part bending",
      "boss splitting, local cracking and layer delamination",
      "thread stripping and screw failure",
      "installation defects, fatigue, vibration, creep, impact and thermal cycling",
      "load distribution among multiple inserts and structural-code compliance",
    ],
    sourceUrls: [SOURCES.spirolInsertGuide, SOURCES.spirolHoleGuide],
  },
  {
    id: "fastener-group-elastic-in-plane-v1",
    version: "1.0.0",
    requiredInputPaths: [
      "fasteners[].xMm",
      "fasteners[].yMm",
      "load.forceXN",
      "load.forceYN",
      "load.applicationPointXmm",
      "load.applicationPointYmm",
      "load.freeMomentNmm",
    ],
    assumptions: [
      "static-in-plane-load",
      "rigid-attachment-member",
      "identical-fastener-in-plane-stiffness",
      "no-slip-or-clearance-redistribution",
      "fastener-points-represent-load-transfer-centers",
      "load-resultant-is-complete",
    ],
    exclusions: [
      "fastener, insert, thread and joined-member strength",
      "out-of-plane force, prying, flange bending and fastener bending",
      "preload, friction, slip, hole clearance and nonlinear redistribution",
      "unequal fastener stiffness and compliant attachment members",
      "fatigue, vibration, creep, impact and structural-code compliance",
    ],
    sourceUrls: [SOURCES.nasaFastener],
  },
  {
    id: "planar-section-resultants-v1",
    version: "1.3.0",
    requiredInputPaths: [
      "properties.areaMm2",
      "properties.ixxMm4",
      "properties.iyyMm4",
      "properties.ixyMm4",
      "material.tensileLimitMPa",
      "material.compressiveLimitMPa",
      "safetyFactor",
    ],
    assumptions: [
      "static-load",
      "homogeneous-equivalent-section",
      "section-resultants-represent-load-path",
    ],
    exclusions: [
      "torsional stress outside solid circles, concentric circular annuli and the exact uniform-thickness rectangular single cell",
      "torsional twist",
      "combined transverse shear and torsion",
      "direct shear outside solid rectangles, solid circles and concentric circular annuli",
      "local stress concentration",
      "deflection",
      "buckling",
      "fatigue and creep",
    ],
    sourceUrls: [SOURCES.mit, SOURCES.purdueCircle, SOURCES.washington, SOURCES.mstTorsion, SOURCES.uahTorsion, "https://ocw.mit.edu/courses/16-20-structural-mechanics-fall-2002/a58ea050460c29f7389ff55e084521ed_ho3.pdf"],
  },
];

export function listStrengthMethods(): MethodDescriptor[] {
  return METHODS.map((method) => ({
    ...method,
    requiredInputPaths: [...method.requiredInputPaths],
    assumptions: [...method.assumptions],
    exclusions: [...method.exclusions],
    sourceUrls: [...method.sourceUrls],
  }));
}

export function strengthMethod(id: MethodId): MethodDescriptor {
  const method = METHODS.find((candidate) => candidate.id === id);
  if (!method) throw new Error(`Unknown strength method: ${id}`);
  return method;
}
