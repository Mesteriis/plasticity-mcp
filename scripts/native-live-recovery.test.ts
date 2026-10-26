import assert from "node:assert/strict";
import test from "node:test";
import { permitsNativeFailureRecovery } from "./native-live-recovery.ts";
import { isolatedAcceptanceEnvironment } from "./verify-native-measure-datum-files-live.ts";

test("uncertain native outcomes prohibit automatic recovery, including nested transport failure", () => {
  for (const message of ["Request timed out", "timeout", "outcome uncertain", "CDP disconnected", "connection closed", "transport error", "socket failure", "cancelled", "aborted"]) {
    assert.equal(permitsNativeFailureRecovery(new Error(message)), false);
  }
  assert.equal(permitsNativeFailureRecovery(new Error("native failure", { cause: new Error("transport closed") })), false);
  assert.equal(permitsNativeFailureRecovery(Object.assign(new Error("write failed"), { code: "EPIPE" })), false);
  for (const unknown of [null, {}, "failed", new Error("")]) assert.equal(permitsNativeFailureRecovery(unknown), false);
  assert.equal(permitsNativeFailureRecovery(new Error("Known numeric assertion failed")), true);
});

test("native qualification stores are isolated and unrelated credentials are not inherited", () => {
  const env = isolatedAcceptanceEnvironment("/tmp/synthetic-qualification", { PATH: "/usr/bin", HOME: "/synthetic-home", TOKEN: "must-not-inherit", PLASTICITY_STRENGTH_ROOT: "/existing-data", PLASTICITY_CDP_URL: "http://127.0.0.1:9999" });
  assert.equal(env.TOKEN, undefined);
  assert.equal(env.PLASTICITY_CDP_URL, "http://127.0.0.1:9999");
  for (const [key, value] of Object.entries(env)) if (key.endsWith("_ROOT")) assert(value.startsWith("/tmp/synthetic-qualification"));
});
