import assert from "node:assert/strict";
import test from "node:test";

import { findSplitInterfaces, parseWorkbenchCrealityMcpLiveArgs, selectLayerIndicesForOrientationAcceptance, validateWorkbenchInputPath } from "../../scripts/verify-workbench-creality-mcp-live.ts";

test("Workbench slicer MCP live acceptance defaults to Creality help and accepts explicit slicer profiles", () => {
  assert.deepEqual(parseWorkbenchCrealityMcpLiveArgs([]), { help: true, batchParts: 1, slicer: "creality-print" });
  assert.deepEqual(parseWorkbenchCrealityMcpLiveArgs([
    "--input", "/tmp/box.stl",
    "--output", "/tmp/new-run",
    "--executable", "/Applications/Creality Print/Contents/MacOS/CrealityPrint",
    "--resources-root", "/Applications/Creality Print/Contents/Resources",
    "--slicer", "orca-slicer",
    "--printer-vendor", "Bambu Lab",
    "--printer-model", "Bambu Lab A1",
    "--material", "Bambu PLA Basic",
    "--batch-parts", "2",
  ]), {
    help: false,
    batchParts: 2,
    input: "/tmp/box.stl",
    output: "/tmp/new-run",
    executable: "/Applications/Creality Print/Contents/MacOS/CrealityPrint",
    resourcesRoot: "/Applications/Creality Print/Contents/Resources",
    slicer: "orca-slicer",
    printerVendor: "Bambu Lab",
    printerModel: "Bambu Lab A1",
    material: "Bambu PLA Basic",
  });
});

test("Workbench Creality MCP live acceptance requires the complete adapter configuration", () => {
  assert.throws(() => parseWorkbenchCrealityMcpLiveArgs(["--input", "/tmp/box.stl"]), /Provide exactly one of --input or --plasticity-target/u);
  assert.throws(() => parseWorkbenchCrealityMcpLiveArgs(["--input"]), /requires a value/u);
  assert.throws(() => parseWorkbenchCrealityMcpLiveArgs(["--slicer", "unknown"]), /--slicer must be/u);
  assert.throws(() => parseWorkbenchCrealityMcpLiveArgs(["--batch-parts", "1"]), /--batch-parts must be/u);
  assert.throws(() => parseWorkbenchCrealityMcpLiveArgs(["--invalid"]), /Unknown argument/u);
});

test("Workbench live acceptance accepts an explicitly selected Plasticity target and rejects ambiguous input modes", () => {
  assert.deepEqual(parseWorkbenchCrealityMcpLiveArgs([
    "--plasticity-target", "window-123",
    "--output", "/tmp/new-run",
    "--executable", "/Applications/Creality Print/Contents/MacOS/CrealityPrint",
    "--resources-root", "/Applications/Creality Print/Contents/Resources",
  ]), {
    help: false,
    batchParts: 1,
    plasticityTarget: "window-123",
    output: "/tmp/new-run",
    executable: "/Applications/Creality Print/Contents/MacOS/CrealityPrint",
    resourcesRoot: "/Applications/Creality Print/Contents/Resources",
    slicer: "creality-print",
  });
  assert.throws(() => parseWorkbenchCrealityMcpLiveArgs([
    "--input", "/tmp/box.stl", "--plasticity-target", "window-123",
    "--output", "/tmp/new-run", "--executable", "/tmp/slicer", "--resources-root", "/tmp/resources",
  ]), /Provide exactly one/u);
  assert.deepEqual(parseWorkbenchCrealityMcpLiveArgs([
    "--plasticity-target", "window-123", "--split-native", "--split-joint", "tongue-and-groove",
    "--output", "/tmp/new-run",
    "--executable", "/Applications/Creality Print/Contents/MacOS/CrealityPrint",
    "--resources-root", "/Applications/Creality Print/Contents/Resources",
  ]), {
    help: false,
    batchParts: 1,
    plasticityTarget: "window-123",
    splitNative: true,
    splitJoint: "tongue-and-groove",
    output: "/tmp/new-run",
    executable: "/Applications/Creality Print/Contents/MacOS/CrealityPrint",
    resourcesRoot: "/Applications/Creality Print/Contents/Resources",
    slicer: "creality-print",
  });
  assert.throws(() => parseWorkbenchCrealityMcpLiveArgs(["--input", "/tmp/box.stl", "--split-native"]), /--split-native requires/u);
  assert.deepEqual(parseWorkbenchCrealityMcpLiveArgs([
    "--plasticity-target", "window-123", "--split-native", "--split-joint", "dovetail",
    "--output", "/tmp/new-run", "--executable", "/tmp/slicer", "--resources-root", "/tmp/resources",
  ]).splitJoint, "dovetail");
  assert.deepEqual(parseWorkbenchCrealityMcpLiveArgs([
    "--plasticity-target", "window-123", "--split-native", "--split-joint", "alignment-pins",
    "--output", "/tmp/new-run", "--executable", "/tmp/slicer", "--resources-root", "/tmp/resources",
  ]).splitJoint, "alignment-pins");
  assert.deepEqual(parseWorkbenchCrealityMcpLiveArgs([
    "--plasticity-target", "window-123", "--split-native", "--split-joint", "screws-and-inserts",
    "--output", "/tmp/new-run", "--executable", "/tmp/slicer", "--resources-root", "/tmp/resources",
  ]).splitJoint, "screws-and-inserts");
  assert.throws(() => parseWorkbenchCrealityMcpLiveArgs(["--plasticity-target", "window-123", "--split-native", "--split-joint", "invalid"]), /--split-joint must be/u);
});

test("layer-path acceptance requests every layer when the solver can consume the full stack", () => {
  assert.deepEqual(selectLayerIndicesForOrientationAcceptance(25), Array.from({ length: 25 }, (_, index) => index + 1));
  assert.deepEqual(selectLayerIndicesForOrientationAcceptance(34), [1, 17, 34]);
});

test("slicer acceptance accepts 3MF for Orca family and keeps Creality on STL", () => {
  assert.doesNotThrow(() => validateWorkbenchInputPath("/tmp/box.stl", "creality-print"));
  assert.doesNotThrow(() => validateWorkbenchInputPath("/tmp/box.3MF", "orca-slicer"));
  assert.doesNotThrow(() => validateWorkbenchInputPath("/tmp/box.3mf", "bambu-studio"));
  assert.throws(() => validateWorkbenchInputPath("/tmp/box.3mf", "creality-print"), /only supports.*STL/u);
  assert.throws(() => validateWorkbenchInputPath("/tmp/box.step", "orca-slicer"), /must be.*STL or 3MF/u);
});

test("native split interfaces identify only face-sharing neighbor pairs with a directed assembly axis", () => {
  const bounds = (min: [number, number, number], max: [number, number, number]) => ({ min, max });
  const interfaces = findSplitInterfaces([
    { id: 21, boundsMm: bounds([0, 0, 0], [10, 20, 5]) },
    { id: 22, boundsMm: bounds([10, 0, 0], [20, 20, 5]) },
    { id: 23, boundsMm: bounds([20, 0, 0], [30, 20, 5]) },
    { id: 24, boundsMm: bounds([30, 30, 0], [40, 40, 5]) },
  ]);
  assert.deepEqual(interfaces.map(({ lowerBodyId, upperBodyId, seamAxis, baseCenterMm, axis }) => ({ lowerBodyId, upperBodyId, seamAxis, baseCenterMm, axis })), [
    { lowerBodyId: 21, upperBodyId: 22, seamAxis: 0, baseCenterMm: [10, 10, 2.5], axis: [1, 0, 0] },
    { lowerBodyId: 22, upperBodyId: 23, seamAxis: 0, baseCenterMm: [20, 10, 2.5], axis: [1, 0, 0] },
  ]);
  assert.equal(interfaces[0]!.tongueWidthMm, 10);
  assert.equal(interfaces[0]!.tongueThicknessMm, 1);
});
