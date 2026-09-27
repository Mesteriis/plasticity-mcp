import { discoverPlasticityTargets } from "../src/cdp/discovery.ts";

const endpoint = process.env.PLASTICITY_CDP_URL ?? "http://127.0.0.1:9223";

try {
  const targets = await discoverPlasticityTargets(endpoint);
  process.stdout.write(
    `${JSON.stringify({ endpoint, status: "available", targets }, null, 2)}\n`,
  );
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${JSON.stringify({ endpoint, status: "unavailable", error: message }, null, 2)}\n`,
  );
  process.exitCode = 1;
}
