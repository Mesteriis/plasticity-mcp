import { join } from "node:path";

export function isolatedAcceptanceEnvironment(root: string, source: NodeJS.ProcessEnv): Record<string, string> {
  const inherited = Object.fromEntries(["PATH", "HOME", "TMPDIR"].flatMap(key => typeof source[key] === "string" ? [[key, source[key]!]] : []));
  return { ...inherited, PLASTICITY_CDP_URL: source.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223", PLASTICITY_STRENGTH_ROOT: root,
    PLASTICITY_REFERENCE_ROOT: join(root, "references"), PLASTICITY_REFERENCE_ARTIFACT_ROOT: join(root, "reference-artifacts"),
    PLASTICITY_CONSTRUCTION_HISTORY_ROOT: join(root, "history"), PLASTICITY_THREAD_QUALIFICATION_ROOT: join(root, "thread-qualifications") };
}
