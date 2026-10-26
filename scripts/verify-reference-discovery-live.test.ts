import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertAllowedDiscoveryUrl, parseReferenceDiscoveryArgs, validateDiscoveryAssets } from "./verify-reference-discovery-live.ts";

const page = "https://dl.radxa.com/zero3/docs/hw/3w/";
function listing() {
  return { truncated: false, omittedQueryAssetCount: 0, assets: [
    { url: page + "radxa_zero_3w_3d_stp.zip", format: "step-archive", kind: "editable-cad" },
    { url: page + "0_zero_3w_pcba_20250213.x_t.zip", format: "parasolid-text", kind: "editable-cad" },
    { url: page + "radxa_zero_3w_product_brief.pdf", format: "pdf", kind: "dimensioned-document" },
  ] };
}

test("discovery help is inert and live cases require explicit consent, target and output", () => {
  assert.equal(parseReferenceDiscoveryArgs([]).help, true);
  const help = spawnSync(process.execPath, [new URL("./verify-reference-discovery-live.ts", import.meta.url).pathname], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /No args\/--help are inert/);
  const valid = ["--target", "experimental", "--allow-live", "--output", "new-output", "--case", "assets"];
  assert.equal(parseReferenceDiscoveryArgs(valid).case, "assets");
  for (const remove of ["--target", "--output", "--case", "--allow-live"]) {
    const args = [...valid]; const index = args.indexOf(remove);
    args.splice(index, remove === "--allow-live" ? 1 : 2);
    assert.throws(() => parseReferenceDiscoveryArgs(args), /required|new directory/);
  }
  assert.throws(() => parseReferenceDiscoveryArgs(["--case", "import"]), /status, assets or search/);
  assert.throws(() => parseReferenceDiscoveryArgs(["--page", page]), /Unknown argument/);
  assert.throws(() => parseReferenceDiscoveryArgs(["--target", "--allow-live"]), /requires a value/);
});

test("discovery URLs stay within explicit HTTPS domain boundaries", () => {
  for (const url of [page, "https://radxa.com/product", "https://docs.radxa.com:443/product"]) {
    assert.doesNotThrow(() => assertAllowedDiscoveryUrl(url, ["radxa.com"]));
  }
  for (const url of ["http://radxa.com/", "https://radxa.com:8443/", "https://user:pass@radxa.com/", "https://radxa.com.evil.example/", "https://evilradxa.com/", "https://example.com/?url=https://radxa.com/", "not a URL"]) {
    assert.throws(() => assertAllowedDiscoveryUrl(url, ["radxa.com"]));
  }
});

test("reviewed asset evidence distinguishes STEP archives and text Parasolid", () => {
  assert.doesNotThrow(() => validateDiscoveryAssets(listing()));
  const wrongFormat = listing(); wrongFormat.assets[0]!.format = "step";
  assert.throws(() => validateDiscoveryAssets(wrongFormat), /step-archive/);
  const missing = listing(); missing.assets.pop();
  assert.throws(() => validateDiscoveryAssets(missing), /PDF/);
  const wrongKind = listing(); wrongKind.assets[1]!.kind = "reference-mesh";
  assert.throws(() => validateDiscoveryAssets(wrongKind), /parasolid-text/);
});

test("asset evidence rejects truncation, duplicates and unsafe extra links", () => {
  assert.throws(() => validateDiscoveryAssets({ ...listing(), truncated: true }), /truncated/);
  assert.throws(() => validateDiscoveryAssets({ ...listing(), omittedQueryAssetCount: -1 }));
  const duplicate = listing(); duplicate.assets.push({ ...duplicate.assets[0]! });
  assert.throws(() => validateDiscoveryAssets(duplicate), /Duplicate/);
  for (const suffix of ["?token=secret", "#fragment"]) {
    const value = listing(); value.assets.push({ ...value.assets[0]!, url: page + "other.step" + suffix });
    assert.throws(() => validateDiscoveryAssets(value), /bearing asset/);
  }
  const escaped = listing(); escaped.assets.push({ ...escaped.assets[0]!, url: "https://example.com/extra.step" });
  assert.throws(() => validateDiscoveryAssets(escaped), /escaped/);
  assert.throws(() => validateDiscoveryAssets({ ...listing(), assets: Array.from({ length: 65 }, () => listing().assets[0]) }));
});
