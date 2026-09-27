import { describe, expect, it } from "vitest";

import { parseLayers } from "../../src/web/manufacturing/gcode-preview.tsx";

describe("G-code preview", () => {
  it("keeps extrusion moves grouped by layer and ignores travel", () => {
    const layers = parseLayers([
      ";LAYER_CHANGE",
      "G1 X10 Y10 F30000",
      "G1 X20 Y10 E.4",
      "G1 X20 Y20 E.4",
      ";LAYER_CHANGE",
      "G1 X11 Y11 F30000",
      "G1 X19 Y11 E0.3",
    ].join("\n"));
    expect(layers).toHaveLength(2);
    expect(layers[0]).toHaveLength(2);
    expect(layers[1]).toHaveLength(1);
  });
});
