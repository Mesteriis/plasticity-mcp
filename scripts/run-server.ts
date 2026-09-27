import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { delimiter } from "node:path";

import { createAnalysisClient } from "../src/codex/analysis-client.ts";
import { resolveAnalysisProfile, resolveReferenceSearchProfile } from "../src/codex/analysis-profile.ts";
import { createReferenceSearchClient } from "../src/codex/reference-search-client.ts";
import { createServer, PlasticitySession, strengthDependenciesForSession } from "../src/server.ts";
import { StrengthStore } from "../src/strength/store.ts";
import { FemReportStore } from "../src/strength/fem/fem-report-store.ts";
import { PrintedThreadQualificationStore } from "../src/printing/thread-qualification.ts";

const session = new PlasticitySession();
const executable = process.env.PLASTICITY_CODEX_EXECUTABLE ?? "codex";
const profile = await resolveAnalysisProfile(executable);
const referenceSearchProfile = await resolveReferenceSearchProfile(executable);
const analysis = profile.available
  ? await createAnalysisClient(profile.profile, {
    executable,
    assetRoot: process.env.PLASTICITY_STRENGTH_ASSET_ROOT ?? process.cwd(),
    ...(process.env.PLASTICITY_STRENGTH_IMAGE_ROOTS ? {
      trustedImageRoots: process.env.PLASTICITY_STRENGTH_IMAGE_ROOTS.split(delimiter).filter(Boolean),
    } : {}),
  })
  : null;
const referenceSearch = referenceSearchProfile.available
  ? await createReferenceSearchClient(referenceSearchProfile.profile, {
    executable,
    cwd: process.env.PLASTICITY_STRENGTH_ASSET_ROOT ?? process.cwd(),
  })
  : null;
const store = process.env.PLASTICITY_STRENGTH_ROOT
  ? new StrengthStore(process.env.PLASTICITY_STRENGTH_ROOT)
  : new StrengthStore();
const strength = strengthDependenciesForSession(session, {
  store,
  femReports: new FemReportStore(process.env.PLASTICITY_STRENGTH_ROOT),
  analysis,
  ...(profile.available ? {} : { analysisUnavailableReason: profile.reason }),
  referenceSearch,
  ...(referenceSearchProfile.available ? {} : { referenceSearchUnavailableReason: referenceSearchProfile.reason }),
});
const threadQualifications = process.env.PLASTICITY_THREAD_QUALIFICATION_ROOT
  ? new PrintedThreadQualificationStore(process.env.PLASTICITY_THREAD_QUALIFICATION_ROOT)
  : new PrintedThreadQualificationStore();
const server = createServer(session, strength, threadQualifications);
const transport = new StdioServerTransport();
await server.connect(transport);

let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await server.close();
};
process.once("SIGINT", () => { void close().finally(() => process.exit(130)); });
process.once("SIGTERM", () => { void close().finally(() => process.exit(143)); });
