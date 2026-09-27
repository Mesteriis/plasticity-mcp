import assert from "node:assert/strict";
import test from "node:test";

import { extractSingleCadArchiveMember } from "./cad-archive.ts";

const stepArchive = Buffer.from("UEsDBBQAAAAIAFIuOF0mTop5IwAAADAAAAAKAAAAbW9kZWwuc3RlcPMM9tc1NDA2MNY1MrTm8nB1dHENsuZy9XMJdnUG07qeKCoAUEsBAhQDFAAAAAgAUi44XSZOinkjAAAAMAAAAAoAAAAAAAAAAAAAAIABAAAAAG1vZGVsLnN0ZXBQSwUGAAAAAAEAAQA4AAAASwAAAAAA", "base64");
const parasolidArchive = Buffer.from("UEsDBBQAAAAIAFIuOF2OMCQOGQAAAIwAAAAJAAAAbW9kZWwueF9009IKcAxyDPb38XRR8PV3cfVRMOSqGCAAAFBLAQIUAxQAAAAIAFIuOF2OMCQOGQAAAIwAAAAJAAAAAAAAAAAAAACAAQAAAABtb2RlbC54X3RQSwUGAAAAAAEAAQA3AAAAQAAAAAAA", "base64");
const multipleStepArchive = Buffer.from("UEsDBBQAAAAIAH0uOF0nnxAjFwAAAB8AAAAIAAAAb25lLnN0ZXDzDPbXNTQwNjDWNTK05nL1c9H1RBYBAFBLAwQUAAAACAB9LjhdJ58QIxcAAAAfAAAABwAAAHR3by5zdHDzDPbXNTQwNjDWNTK05nL1c9H1RBYBAFBLAQIUAxQAAAAIAH0uOF0nnxAjFwAAAB8AAAAIAAAAAAAAAAAAAACAAQAAAABvbmUuc3RlcFBLAQIUAxQAAAAIAH0uOF0nnxAjFwAAAB8AAAAHAAAAAAAAAAAAAACAAT0AAAB0d28uc3RwUEsFBgAAAAACAAIAawAAAHkAAAAAAA==", "base64");
const unsafePathArchive = Buffer.from("UEsDBBQAAAAIAH0uOF0nnxAjFwAAAB8AAAAPAAAALi4vb3V0c2lkZS5zdGVw8wz21zU0MDYw1jUytOZy9XPR9UQWAQBQSwECFAMUAAAACAB9LjhdJ58QIxcAAAAfAAAADwAAAAAAAAAAAAAAgAEAAAAALi4vb3V0c2lkZS5zdGVwUEsFBgAAAAABAAEAPQAAAEQAAAAAAA==", "base64");

test("extracts and validates one deflated STEP member without writing archive paths", () => {
  const member = extractSingleCadArchiveMember(stepArchive, "step");
  assert.equal(member.memberPath, "model.step");
  assert.equal(member.extension, "step");
  assert.match(member.contents.toString("ascii"), /^ISO-10303-21;/u);
  assert.match(member.contents.toString("ascii"), /END-ISO-10303-21;\n?$/u);
});

test("extracts one STEP or Parasolid member only for the explicitly selected format", () => {
  const member = extractSingleCadArchiveMember(parasolidArchive, "parasolid-text");
  assert.equal(member.memberPath, "model.x_t");
  assert.equal(member.extension, "x_t");
  assert.equal(member.contents.subarray(0, 2).toString("ascii"), "**");
  assert.throws(() => extractSingleCadArchiveMember(parasolidArchive, "step"), /contains no STEP/u);
});

test("rejects CAD ZIP archives with multiple matching files instead of guessing", () => {
  assert.throws(() => extractSingleCadArchiveMember(multipleStepArchive, "step"), /multiple STEP/u);
});

test("rejects unsafe member paths, corrupt CRCs, and malformed ZIP input", () => {
  assert.throws(() => extractSingleCadArchiveMember(unsafePathArchive, "step"), /Unsafe CAD ZIP entry path/u);
  const corrupted = Buffer.from(stepArchive);
  corrupted[42] = corrupted[42]! ^ 0x40;
  assert.throws(() => extractSingleCadArchiveMember(corrupted, "step"), /decompress|CRC-32/u);
  assert.throws(() => extractSingleCadArchiveMember(Buffer.from("not a zip"), "step"), /end-of-central-directory/u);
});
