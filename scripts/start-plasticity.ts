import { ensurePlasticityCdp } from "../src/plasticity/launcher.ts";

try {
  const targets = await ensurePlasticityCdp();
  console.log(JSON.stringify({ status: "available", targets }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
