import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { strengthToolResult } from "./mcp-response.ts";
import {
  analyzeMaterialInterfaceTestCurve,
  analyzeMixedModeMaterialInterfaceTestCurve,
  calculateInterfaceSpecimenStrengths,
  interfaceTestInputSchema,
  interfaceTestMcpInputSchema,
  interfaceTestMcpQuerySchema,
  interfaceTestQuerySchema,
  interfaceSpecimenStrengthMcpInputSchema,
  type InterfaceTestInput,
  type InterfaceTestRecord,
  type InterfaceTestStore,
} from "./interface-test.ts";
import { calibrateTuronCandidateFromInterfaceTests, turonPhysicalCalibrationInputSchema } from "./fem/code-aster-turon-physical-calibration.ts";
import { importInterfaceFractureCsv, interfaceFractureCsvInputSchema } from "./interface-fracture-csv.ts";
import { importInterfaceTensileCsv, interfaceTensileCsvInputSchema } from "./interface-tensile-csv.ts";
import { calculateDcbModeIEnergy, dcbModeIEnergyInputSchema } from "./dcb-mode-i-energy.ts";
import { importDcbModeIEnergyCsv, dcbModeIEnergyCsvInputSchema } from "./dcb-mode-i-energy-csv.ts";
import { calculateEnfModeIIEnergy, enfModeIIEnergyInputSchema } from "./enf-mode-ii-energy.ts";
import { calculateMmbModeIEnergy, mmbModeIEnergyInputSchema } from "./mmb-mode-i-ii-energy.ts";
import { importMmbModeIEnergyCsv, mmbModeIEnergyCsvInputSchema } from "./mmb-mode-i-ii-energy-csv.ts";
import { importEnfModeIIEnergyCsv, enfModeIIEnergyCsvInputSchema } from "./enf-mode-ii-energy-csv.ts";
import {
  dcbModeIEnergyQuerySchema,
  dcbModeIEnergyRecordInputSchema,
  DcbModeIEnergyTestStore,
} from "./dcb-mode-i-energy-store.ts";
import {
  enfModeIIEnergyQuerySchema,
  enfModeIIEnergyRecordInputSchema,
  EnfModeIIEnergyTestStore,
} from "./enf-mode-ii-energy-store.ts";
import {
  mmbModeIEnergyQuerySchema,
  mmbModeIEnergyRecordInputSchema,
  MmbModeIEnergyTestStore,
} from "./mmb-mode-i-ii-energy-store.ts";

type ToolAnnotations = { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
type RegisterTool = (
  name: string,
  config: { description: string; inputSchema: z.ZodType; annotations: ToolAnnotations },
  callback: (input: unknown) => Promise<{ content: [{ type: "text"; text: string }] }>,
) => unknown;

export function registerMaterialInterfaceTestTools(server: McpServer, store: InterfaceTestStore, dcbEnergyStore: DcbModeIEnergyTestStore, enfEnergyStore: EnfModeIIEnergyTestStore, mmbEnergyStore: MmbModeIEnergyTestStore): void {
  const registerTool = server.registerTool.bind(server) as unknown as RegisterTool;
  const persistent: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const readonly: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const tool = <T extends z.ZodType>(
    name: string,
    description: string,
    schema: T,
    annotations: ToolAnnotations,
    handler: (input: z.output<T>) => Promise<unknown>,
  ): void => {
    registerTool(name, { description, inputSchema: schema, annotations }, async (raw) =>
      strengthToolResult(await handler(schema.parse(raw) as z.output<T>)));
  };
  const toInternalInput = (input: z.output<typeof interfaceTestMcpInputSchema>): InterfaceTestInput => {
    const { materialProcess, ...test } = input;
    return interfaceTestInputSchema.parse({
      ...test,
      failureLocation: test.failureLocation === "printed-material" ? "material-a" : test.failureLocation,
      ...(test.specimenResults === undefined ? {} : {
        specimenResults: test.specimenResults.map((specimen) => ({
          ...specimen,
          failureLocation: specimen.failureLocation === "printed-material" ? "material-a" : specimen.failureLocation,
        })),
      }),
      interfaceKind: "same-material-layer",
      materialAProcess: materialProcess,
      materialBProcess: materialProcess,
    });
  };
  const toInternalQuery = (input: z.output<typeof interfaceTestMcpQuerySchema>) => {
    const { materialProcess, ...query } = input;
    return interfaceTestQuerySchema.parse({
      ...query,
      interfaceKind: "same-material-layer",
      materialAProcess: materialProcess,
      materialBProcess: materialProcess,
    });
  };
  const toSingleMaterialRecord = (record: InterfaceTestRecord) => {
    if (record.interfaceKind !== "same-material-layer"
      || canonicalJson(record.materialAProcess) !== canonicalJson(record.materialBProcess)) {
      throw new Error("This MCP supports physical interface evidence for one material and one print process only");
    }
    const { materialAProcess, materialBProcess: _materialBProcess, ...singleMaterialRecord } = record;
    return {
      ...singleMaterialRecord,
      failureLocation: record.failureLocation === "material-a" || record.failureLocation === "material-b"
        ? "printed-material"
        : record.failureLocation,
      ...(record.specimenResults === undefined ? {} : {
        specimenResults: record.specimenResults.map((specimen) => ({
          ...specimen,
          failureLocation: specimen.failureLocation === "material-a" || specimen.failureLocation === "material-b"
            ? "printed-material"
            : specimen.failureLocation,
        })),
      }),
      materialProcess: materialAProcess,
    };
  };

  tool(
    "plasticity_calculate_interface_specimen_strengths",
    "Calculate nominal peak stress for each directly loaded physical specimen as measured peak force in N divided by measured net cross-section in mm² (N/mm² = MPa). Preserves per-specimen failure location and hashed source locator; only specimens confirmed to fail at the printed interface contribute to the descriptive range, mean and sample standard deviation. Other failures remain individually visible and are excluded; no interface failures yields null summary values. These values are not local interface tractions, design allowables, statistically qualified bounds or a cohesive law.",
    interfaceSpecimenStrengthMcpInputSchema,
    readonly,
    async (input) => calculateInterfaceSpecimenStrengths({
      specimens: input.specimens.map((specimen) => ({
        ...specimen,
        failureLocation: specimen.failureLocation === "printed-material" ? "material-a" : specimen.failureLocation,
      })),
    }),
  );

  tool(
    "plasticity_calculate_dcb_mode_i_energy",
    "Calculate an exploratory Mode-I G_I-versus-crack-length curve from caller-selected DCB crack-growth observations using Modified Beam Theory (MBT). Provide the exact single-material print process, global layer-interface normal, test method, test protocol SHA-256/date, each specimen's measured width/length/arm thickness, at least three strictly increasing observed crack lengths, corresponding positive force and machine-compliance-corrected load-point displacement, source SHA-256 and per-point source locator. Explicitly attest quasi-static linear-elastic behavior. Rows with displacement/crack-length above 0.4 are rejected because large-displacement correction is not implemented. This is not a standards-conformance determination; ASTM D5528 states a scope for unidirectional fiber-reinforced polymer composites. It does not calculate a traction-separation curve, cohesive law, design allowable, or Creality material property; only specimens with caller-confirmed interface failure are marked eligible for same-material interlayer fracture evidence. The tool is read-only and does not persist tests.",
    dcbModeIEnergyInputSchema,
    readonly,
    async (input) => calculateDcbModeIEnergy(input),
  );
  tool(
    "plasticity_calculate_enf_mode_ii_energy",
    "Calculate an exploratory ENF Mode-II initiation energy from caller-supplied compliance-calibration results. For each specimen provide at least three distinct crack lengths and compliances taken from the inverse initial-linear force-displacement slope, using the same specimen support/loading fixture as the fracture run; provide the measured initial crack and peak force, exact one-material process, global interface normal and perpendicular global ENF shear direction, protocol hash/date, source SHA-256 and locator for each calibration and fracture input, plus explicit linear-elastic/quasi-static and calibration attestations. The tool fits C = A + m*a^3 and evaluates G_IIc = 3*m*Pc^2*a0^2/(2*b), retaining fit R-squared and each source. It does not interpret raw machine traces, correct compliance, determine ASTM validity, or claim ASTM D7905 conformity (that standard's scope is unidirectional carbon/glass fiber-reinforced laminates; printed PLA is outside the validated scope). This is a read-only exploratory energy estimate, not an R-curve, traction-separation law, cohesive parameter, design allowable or Creality material property; only caller-confirmed layer-interface failures are eligible for same-material interlayer fracture evidence.",
    enfModeIIEnergyInputSchema,
    readonly,
    async (input) => calculateEnfModeIIEnergy(input),
  );
  tool(
    "plasticity_calculate_mmb_mode_i_ii_energy",
    "Calculate an exploratory mixed-mode initiation-energy partition from manually measured MMB critical force, crack length, specimen/fixture geometry, exact one-material process, interface normal and interface-plane shear direction. Requires source hashes/locators for each specimen and measured flexural modulus plus orthotropic E11/E22/G13 evidence with an explicitly confirmed mapping (axis 1 = shear, axis 2 = in-plane transverse, axis 3 = interface normal). Requires the caller to confirm lever self-weight is measured negligible or counterbalanced. Uses the Reeder-Crews beam-theory equations to return Mode-I, Mode-II and total energy-release rates and the Mode-II energy fraction. It does not select initiation from raw test traces, establish ASTM D6671 conformity (printed PLA is outside that laminate standard's validated scope), infer a traction-separation law, qualify material, or authorize design/printing. Only confirmed interface failures are eligible as same-material interface-energy evidence; this read-only estimate is separate from the measured-curve registry and cohesive FEA.",
    mmbModeIEnergyInputSchema,
    readonly,
    async (input) => calculateMmbModeIEnergy(input),
  );
  tool(
    "plasticity_import_mmb_mode_i_ii_energy_csv",
    "Read-only preview of caller-selected physical MMB initiation forces in one explicitly mapped local UTF-8 CSV. Reads only a regular non-symlink file up to 16 MiB and 250,000 data records. For each specimen, map its ID and force columns/units/sign, then select the exact CSV record associated with the manually determined crack-initiation criterion and provide measured crack length, geometry, failure location, exact one-material process, sourced same-process flexural/orthotropic moduli, and confirmed material-axis mapping. The importer converts force units only, preserves the CSV SHA-256 and exact record locator, and returns the MMB energy-partition preview. It never selects a peak or identifies initiation from raw curves, and does not validate the MMB fixture or ASTM D6671 conformity. The preview does not register physical evidence, produce a traction-separation curve/cohesive law, qualify material, or authorize design/printing.",
    mmbModeIEnergyCsvInputSchema,
    readonly,
    async (input) => await importMmbModeIEnergyCsv(input),
  );
  tool(
    "plasticity_record_mmb_mode_i_ii_energy_test",
    "Persist an immutable caller-confirmed physical MMB initiation-energy partition for one exact single-material process, interface normal, in-plane shear axis, protocol and date. Requires traceable source evidence for the manually selected initiation force, specimen geometry, same-process flexural/orthotropic moduli and confirmed material axes, plus explicit observed failure location and initiation criterion. The server recomputes the exploratory Reeder-Crews estimate. This separate MMB energy registry is not a traction-separation registry or cohesive-FEA input; a calculated energy partition is not a cohesive law, peak traction, or design allowable.",
    mmbModeIEnergyRecordInputSchema,
    persistent,
    async (input) => await mmbEnergyStore.record(input),
  );
  tool(
    "plasticity_match_mmb_mode_i_ii_energy_test",
    "Find caller-confirmed physical MMB initiation-energy records only for an exact single-material process, interface normal, in-plane shear direction and protocol SHA-256. Returns no-match, matched or ambiguous evidence. Matching exploratory MMB energy is not a traction-separation curve, cohesive-law calibration or design allowable.",
    mmbModeIEnergyQuerySchema,
    readonly,
    async (query) => {
      const result = await mmbEnergyStore.match(query);
      return {
        status: result.status,
        source: result.source,
        selectedRecordId: result.selected?.id ?? null,
        records: result.records.map((record) => ({
          id: record.id,
          testedAt: record.input.testedAt,
          testMethod: record.input.testMethod,
          specimenCount: record.calculation.specimens.length,
          specimenSummaries: record.calculation.specimens.map((specimen) => ({
            specimenId: specimen.specimenId,
            initiationCriterion: specimen.initiationCriterion,
            failureLocation: specimen.failureLocation,
            eligibleForLayerInterfaceEvidence: specimen.eligibleForLayerInterfaceEvidence,
            modeIEnergyReleaseRateJPerM2: specimen.modeIEnergyReleaseRateJPerM2,
            modeIIEnergyReleaseRateJPerM2: specimen.modeIIEnergyReleaseRateJPerM2,
            modeIIModeMixFraction: specimen.modeIIModeMixFraction,
          })),
        })),
        reasons: result.reasons,
        limitations: ["This MMB registry stores exploratory initiation energy only; it is separate from measured traction-separation curves and is not consumed by cohesive FEA."],
      };
    },
  );
  tool(
    "plasticity_list_mmb_mode_i_ii_energy_tests",
    "List immutable caller-confirmed physical MMB initiation-energy records as compact summaries. Use plasticity_read_mmb_mode_i_ii_energy_test for all measured inputs, initiation criteria, source hashes/locators, moduli evidence and server-recomputed results. These are not cohesive laws and are not applied to FEA.",
    z.object({}).strict(),
    readonly,
    async () => ({
      source: "immutable-local-physical-mmb-mode-i-ii-energy-registry",
      records: (await mmbEnergyStore.list()).map((record) => ({
        id: record.id,
        materialProcess: record.input.materialProcess,
        interfaceNormalGlobal: record.input.interfaceNormalGlobal,
        interfaceShearDirectionGlobal: record.input.interfaceShearDirectionGlobal,
        testProtocolHash: record.input.testProtocolHash,
        testedAt: record.input.testedAt,
        testMethod: record.input.testMethod,
        specimenCount: record.calculation.specimens.length,
        eligibleSpecimenCount: record.calculation.specimens.filter((specimen) => specimen.eligibleForLayerInterfaceEvidence).length,
      })),
    }),
  );
  tool(
    "plasticity_read_mmb_mode_i_ii_energy_test",
    "Read one immutable physical MMB energy record including measured geometry, initiation criterion/force, source evidence, material-axis mapping, moduli, and the server-recomputed exploratory Mode-I/Mode-II partition. It is not a traction-separation law or cohesive-FEA input.",
    z.object({ recordId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    readonly,
    async ({ recordId }) => await mmbEnergyStore.read(recordId),
  );
  tool(
    "plasticity_import_enf_mode_ii_energy_csv",
    "Read-only preview of raw ENF Mode-II force/displacement data in one explicitly mapped local CSV. For each specimen, manually group at least three distinct compliance-calibration runs by specimen/run ID and crack length, then select the exact record numbers in each initial-linear force-displacement region. Also select the physical initiation/peak record from its fracture run; the tool never chooses a peak or finds a linear region for you. It fits displacement versus force for each selected calibration run, converts the resulting compliance and selected fracture force into the caller-specified units, preserves per-source SHA-256/record locators, and calculates an exploratory Mode-II initiation-energy preview. Explicitly map columns, units, signs, CSV formatting, same-material process, interface normal and in-plane shear direction; caller attestations do not independently verify machine-compliance handling, fixture identity, or failure location. It does not register a physical test or claim ASTM D7905 conformity, an R-curve, cohesive law or design allowable. Review every selected run and fit before any physical-evidence recording.",
    enfModeIIEnergyCsvInputSchema,
    readonly,
    async (input) => await importEnfModeIIEnergyCsv(input),
  );
  tool(
    "plasticity_record_enf_mode_ii_energy_test",
    "Persist an immutable caller-confirmed physical ENF Mode-II initiation-energy test for one exact single-material process, interface normal, in-plane shear direction, protocol and date. Requires compliance calibration from the same fixture and source SHA-256/locator for every calibration and fracture input; recomputes the exploratory C-a^3 energy result server-side. This independent Mode-II energy registry is not a traction-separation registry and is not used by cohesive FEA; do not treat G_IIc as a peak shear traction, cohesive stiffness, R-curve or design allowable.",
    enfModeIIEnergyRecordInputSchema,
    persistent,
    async (input) => await enfEnergyStore.record(input),
  );
  tool(
    "plasticity_match_enf_mode_ii_energy_test",
    "Find recorded physical ENF Mode-II initiation-energy tests only for an exact single-material print process, interface normal, in-plane shear direction and test-protocol SHA-256. Returns no-match, matched or ambiguous evidence. This exploratory energy match is not a traction-separation curve or cohesive FEA calibration.",
    enfModeIIEnergyQuerySchema,
    readonly,
    async (query) => {
      const result = await enfEnergyStore.match(query);
      return {
        status: result.status,
        source: result.source,
        selectedRecordId: result.selected?.id ?? null,
        records: result.records.map((record) => ({
          id: record.id,
          testedAt: record.input.testedAt,
          testMethod: record.input.testMethod,
          specimenCount: record.calculation.specimens.length,
          specimenSummaries: record.calculation.specimens.map((specimen) => ({
            specimenId: specimen.specimenId,
            failureLocation: specimen.failureLocation,
            eligibleForLayerInterfaceEvidence: specimen.eligibleForLayerInterfaceEvidence,
            energyReleaseRateJPerM2: specimen.energyReleaseRateJPerM2,
            complianceFitRSquared: specimen.complianceFitRSquared,
          })),
        })),
        reasons: result.reasons,
        limitations: ["This ENF Mode-II registry stores exploratory initiation energy only; it is separate from the material-interface traction-separation registry and is not consumed by cohesive FEA."],
      };
    },
  );
  tool(
    "plasticity_list_enf_mode_ii_energy_tests",
    "List immutable caller-confirmed physical ENF Mode-II energy records as compact summaries. Use plasticity_read_enf_mode_ii_energy_test for all calibration/fracture measurements, source hashes/locators and fit diagnostics. These are not cohesive laws and are not applied to FEA.",
    z.object({}).strict(),
    readonly,
    async () => ({
      source: "immutable-local-physical-enf-mode-ii-energy-registry",
      records: (await enfEnergyStore.list()).map((record) => ({
        id: record.id,
        materialProcess: record.input.materialProcess,
        interfaceNormalGlobal: record.input.interfaceNormalGlobal,
        interfaceShearDirectionGlobal: record.input.interfaceShearDirectionGlobal,
        testProtocolHash: record.input.testProtocolHash,
        testedAt: record.input.testedAt,
        testMethod: record.input.testMethod,
        specimenCount: record.calculation.specimens.length,
        eligibleSpecimenCount: record.calculation.specimens.filter((specimen) => specimen.eligibleForLayerInterfaceEvidence).length,
      })),
    }),
  );
  tool(
    "plasticity_read_enf_mode_ii_energy_test",
    "Read one immutable physical ENF Mode-II energy record including all compliance calibration runs, fracture inputs, source provenance, fit diagnostics, and the server-recomputed initiation-energy result. It is not a traction-separation law or cohesive FEA input.",
    z.object({ recordId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    readonly,
    async ({ recordId }) => await enfEnergyStore.read(recordId),
  );
  tool(
    "plasticity_import_dcb_mode_i_energy_csv",
    "Read-only preview of an explicitly mapped local DCB Mode-I raw force/displacement CSV. For every physically observed crack-growth point, the caller must select the exact CSV record number and supply its observed crack length; map the specimen, force and displacement columns, units, signs, delimiter and decimal separator explicitly. Converts only force/displacement units, retains the source SHA-256 and record locators, and calculates the same exploratory MBT G_I-versus-crack-length preview. It does not filter acquisition samples, infer crack growth, choose peaks, correct machine compliance, register a physical test or establish ASTM conformity, a cohesive law or a design allowable. Review the preview against the physical log, then call plasticity_record_dcb_mode_i_energy_test only after the physical test is confirmed.",
    dcbModeIEnergyCsvInputSchema,
    readonly,
    async (input) => await importDcbModeIEnergyCsv(input),
  );
  tool(
    "plasticity_record_dcb_mode_i_energy_test",
    "Persist an immutable physical DCB Mode-I energy-release test for one exact single-material process. Requires caller confirmation that all inputs are physical, the observed crack ran on the same-material layer interface, displacement is machine-compliance-corrected load-point displacement, and the test was quasi-static/linear-elastic. Recomputes the exploratory MBT curve server-side; records the protocol hash, date, global interface normal, per-specimen failure location and source evidence. This separate energy registry is not a traction-separation registry and is not read by cohesive FEA; do not use it as peak traction, cohesive stiffness, or a design allowable.",
    dcbModeIEnergyRecordInputSchema,
    persistent,
    async (input) => await dcbEnergyStore.record(input),
  );
  tool(
    "plasticity_match_dcb_mode_i_energy_test",
    "Find recorded physical DCB Mode-I energy tests only for an exact single-material printer/profile/process, global interface normal and test-protocol SHA-256. Returns no-match, matched or ambiguous evidence; a match is not a cohesive FEA calibration or design allowable.",
    dcbModeIEnergyQuerySchema,
    readonly,
    async (query) => {
      const result = await dcbEnergyStore.match(query);
      return {
        status: result.status,
        source: result.source,
        selectedRecordId: result.selected?.id ?? null,
        records: result.records.map((record) => ({
          id: record.id,
          testedAt: record.input.testedAt,
          testMethod: record.input.testMethod,
          specimenCount: record.calculation.specimens.length,
          specimenSummaries: record.calculation.specimens.map((specimen) => ({
            specimenId: specimen.specimenId,
            failureLocation: specimen.failureLocation,
            eligibleForLayerInterfaceEvidence: specimen.eligibleForLayerInterfaceEvidence,
            crackObservationCount: specimen.points.length,
            energyReleaseRateRangeJPerM2: [
              Math.min(...specimen.points.map((point) => point.energyReleaseRateJPerM2)),
              Math.max(...specimen.points.map((point) => point.energyReleaseRateJPerM2)),
            ],
          })),
        })),
        reasons: result.reasons,
        limitations: ["This is fracture-energy evidence only; the immutable physical interface strength / traction-separation registry and cohesive FEA do not consume these DCB energy records."],
      };
    },
  );
  tool(
    "plasticity_list_dcb_mode_i_energy_tests",
    "List immutable physical DCB Mode-I energy records as compact summaries. Use plasticity_read_dcb_mode_i_energy_test to retrieve full measured observations and MBT results for a selected record. These records are separate from traction-separation data and are not applied to cohesive FEA.",
    z.object({}).strict(),
    readonly,
    async () => ({
      source: "immutable-local-physical-dcb-mode-i-energy-registry",
      records: (await dcbEnergyStore.list()).map((record) => ({
        id: record.id,
        materialProcess: record.input.materialProcess,
        interfaceNormalGlobal: record.input.interfaceNormalGlobal,
        testProtocolHash: record.input.testProtocolHash,
        testedAt: record.input.testedAt,
        testMethod: record.input.testMethod,
        specimenCount: record.calculation.specimens.length,
        eligibleSpecimenCount: record.calculation.specimens.filter((specimen) => specimen.eligibleForLayerInterfaceEvidence).length,
      })),
    }),
  );
  tool(
    "plasticity_read_dcb_mode_i_energy_test",
    "Read one content-addressed physical DCB Mode-I energy record, including the retained source locators and derived MBT G_I versus crack-length results. This is not a traction-separation law or cohesive FEA input.",
    z.object({ recordId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    readonly,
    async ({ recordId }) => await dcbEnergyStore.read(recordId),
  );
  tool(
    "plasticity_import_interface_tensile_csv",
    "Read a caller-selected local UTF-8 CSV containing direct tensile-coupon force samples, find the maximum sampled tensile force for each explicitly listed specimen, and return a preview with source SHA-256 plus nominal force/area stress. The caller must map exact CSV headers, delimiter, decimal separator, force unit and force sign, and supply each specimen's measured net cross-section and observed failure location; none are inferred. Reads only a regular non-symlink file up to 16 MiB, leaves it unchanged, and does not register a physical test. This is a peak-strength screen only: it does not filter or compliance-correct machine data, create DCB/ENF/MMB traction-separation curves, estimate fracture energy or cohesive parameters, or establish an allowable. Review the preview and then explicitly call plasticity_record_material_interface_test to persist caller-attested physical evidence.",
    interfaceTensileCsvInputSchema,
    readonly,
    async (input) => await importInterfaceTensileCsv(input),
  );

  tool(
    "plasticity_import_interface_fracture_csv",
    "Read-only preview of per-specimen DCB Mode-I, ENF Mode-II or MMB mixed-mode traction-separation curves from a caller-selected local CSV. The caller must explicitly map specimen and measurement columns, units, decimal/delimiter settings, and attest that the input already contains physical compliance-corrected separations and tractions; raw force-displacement data are rejected. The importer checks complete measured curves, summarizes their peak and integrated work, and preserves the CSV SHA-256 plus exact record locators. It reads only a regular non-symlink UTF-8 file up to 16 MiB, does not alter the file, register a test, infer failure location, correct compliance, calculate a cohesive law, or establish a design allowable. Review specimen, fixture, process, failed interface and correction method before explicitly recording each accepted specimen with plasticity_record_material_interface_test.",
    interfaceFractureCsvInputSchema,
    readonly,
    async (input) => await importInterfaceFractureCsv(input),
  );

  tool(
    "plasticity_record_material_interface_test",
    "Store an immutable caller-attested physical test of a printed layer interface for one material and one exact print process shared by both sides. Supply one materialProcess with printer/material/profile/orientation/infill percentage and pattern/wall-loop/top-bottom-shell/nozzle-temperature/measured-layer-height identity, the global interface normal, test mode, load direction and a hashed specimen/fixture protocol. For a direct peak-strength series, attach one specimenResults entry per physical sample with measured peak force, net cross-section, individual failure location and traceable source; the selected representativeSpecimenId must match measuredPeakStrengthMPa and its evidence. Use plasticity_calculate_interface_specimen_strengths to derive nominal N/mm² = MPa values and descriptive sample statistics. A direct-strength record without a traction-separation curve must include these raw specimen results. For a curve-based fracture test, explicitly set fractureMethod to dcb-mode-i, enf-mode-ii or mmb-mixed-mode; loading direction and a free-text testMethod do not establish the fracture method. DCB requires normal-tension loading and a scalar curve, ENF requires interface-shear loading and a scalar curve, and MMB requires mixed-mode loading and a vector curve. When available, attach depositionPathEvidence from the actual sliced specimen G-code with matching profile, source/G-code hashes, per-layer road direction summaries and user-confirmed slicer-to-global axes; this is provenance only and is not converted into adhesion strength. Normal-tension loads must align with the interface normal; interface-shear loads must lie in its plane; mixed-mode loads must contain both components. Curves require source SHA-256 and locator, begin at zero, end at zero traction, and match the evidenced measured peak. This stores test evidence only: it does not derive design allowables or approve a design. Repeating identical data is idempotent.",
    interfaceTestMcpInputSchema,
    persistent,
    async (input) => {
      const result = await store.record(toInternalInput(input));
      return { ...result, record: toSingleMaterialRecord(result.record) };
    },
  );
  tool(
    "plasticity_match_material_interface_test",
    "Find physical layer-interface tests only for one exact printer/material/profile/orientation/infill percentage and pattern/wall-loop/top-bottom-shell/nozzle-temperature/measured-layer-height process, test mode, interface normal, load direction and hashed test protocol. Returns no-match, matched or ambiguous. Legacy records without the full process structure remain readable but cannot satisfy a new exact match. A match is experimental evidence only; it does not become a design allowable or a structural-analysis pass.",
    interfaceTestMcpQuerySchema,
    readonly,
    async (query) => {
      const result = await store.match(toInternalQuery(query));
      return {
        ...result,
        records: result.records.map(toSingleMaterialRecord),
        selected: result.selected ? toSingleMaterialRecord(result.selected) : null,
      };
    },
  );
  tool(
    "plasticity_list_material_interface_tests",
    "List immutable caller-attested same-material printed layer-interface test records with one exact print-process identity, setup, failure location and traceable measurement evidence, including full scalar pure-mode or vector mixed-mode traction-separation curves. Results are not automatically applied to static FEA or design checks.",
    z.object({}).strict(),
    readonly,
    async () => ({
      source: "immutable-local-physical-material-interface-test-registry",
      records: (await store.list())
        .filter((record) => record.interfaceKind === "same-material-layer"
          && canonicalJson(record.materialAProcess) === canonicalJson(record.materialBProcess))
        .map(toSingleMaterialRecord),
    }),
  );
  tool(
    "plasticity_analyze_material_interface_test_curve",
    "Summarize a stored, complete measured traction-separation curve only when its physical method is explicitly classified as DCB Mode I, ENF Mode II or MMB, consistently with its load mode. Pure-mode records report peak, first-segment stiffness and fracture energy; mixed-mode records report normal/tangential work, mode-mix energy fraction and resultant stiffness. Legacy curves without an explicit fracture method remain readable but are not analyzed. These are measured-curve summaries only, not qualified cohesive-law parameters or design allowables.",
    z.object({ recordId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    readonly,
    async ({ recordId }) => {
      const record = await store.read(recordId);
      const expectedMethod = record.testMode === "normal-tension" ? "dcb-mode-i"
        : record.testMode === "interface-shear" ? "enf-mode-ii" : "mmb-mixed-mode";
      if (record.fractureMethod !== expectedMethod) {
        throw new Error(`Cannot summarize this legacy traction-separation curve without explicit ${expectedMethod} physical-test classification`);
      }
      return {
        recordId,
        interfaceKind: record.interfaceKind,
        materialProcess: toSingleMaterialRecord(record).materialProcess,
        interfaceNormalGlobal: record.interfaceNormalGlobal,
        analysis: record.testMode === "mixed-mode"
          ? analyzeMixedModeMaterialInterfaceTestCurve(record)
          : analyzeMaterialInterfaceTestCurve(record),
      };
    },
  );
  tool(
    "plasticity_calibrate_turon_mixed_mode_law",
    "Fit a candidate Code_Aster CZM_TURON ETA_BK only from immutable measured Mode-I DCB, Mode-II ENF and at least two distinct-ratio MMB test records for one same-material printed-layer interface and its exact single print process; different-material bond tests are rejected. Each testMethod must explicitly identify DCB, ENF or MMB. Rejects missing curves, non-interface failure, conflicting exact-setup records or mismatched processes/interface normals. Returns measured pure-mode peak tractions and per-MMB energy residuals for engineering review. It does not identify the initial stiffness K, qualify a cohesive law, authorize FEA, establish a design allowable or approve a part.",
    turonPhysicalCalibrationInputSchema,
    readonly,
    async (input) => await calibrateTuronCandidateFromInterfaceTests(store, input),
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}
