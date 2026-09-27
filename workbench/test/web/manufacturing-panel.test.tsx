// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SliceJob } from "../../src/shared/contracts.ts";
import type { BrowserApi } from "../../src/web/api.ts";
import { ManufacturingPanel, printApprovalMessage } from "../../src/web/manufacturing/manufacturing-panel.tsx";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("print approval", () => {
  it("shows the exact artifact, project revision, estimates, and DFM warning set", () => {
    const job = {
      projectRevision: 7,
      sourceArtifactHash: "source-hash",
      gcodeArtifactHash: "gcode-hash",
      profile: {
        printer: { model: "Creality K1C" },
        material: { name: "PETG" },
        slicer: { name: "0.20 Functional" },
      },
      summary: { estimatedSeconds: 3661, filamentMassG: 12.34 },
      dfmReport: {
        findings: [{ code: "overhang-support", severity: "warning", message: "Нужна поддержка" }],
      },
    } as SliceJob;

    const message = printApprovalMessage(job);
    expect(message).toContain("gcode-hash");
    expect(message).toContain("source-hash");
    expect(message).toContain("Ревизия проекта: 7");
    expect(message).toContain("1 ч 2 мин");
    expect(message).toContain("12.3 г");
    expect(message).toContain("[warning] Нужна поддержка");
  });

  it("shows every sliced part and approves only the selected G-code", async () => {
    const job = (id: string, sourceArtifactHash: string, gcodeArtifactHash: string): SliceJob => ({
      id,
      projectId: "project",
      projectRevision: 0,
      sourceArtifactHash,
      gcodeArtifactHash,
      profile: {
        printer: { model: "Creality K1C" },
        material: { name: "PLA", type: "PLA" },
        slicer: { layerHeightMm: 0.2, name: "Standard" },
      },
      dfmReport: { findings: [] },
      state: "ready",
      createdAt: "2026-09-23T00:00:00.000Z",
      updatedAt: "2026-09-23T00:00:00.000Z",
    } as unknown as SliceJob);
    const approvePrint = vi.fn(async (_projectId: string, _jobId: string) => job("second", "source-b", "gcode-b"));
    const onRefresh = vi.fn(async () => {});
    const api = {
      manufacturingProfiles: vi.fn(async () => ({ profiles: [], adapters: [] })),
      approvePrint,
    } as unknown as BrowserApi;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => ";LAYER_CHANGE\nG1 X1 Y1 E1\n" })));
    render(<ManufacturingPanel
      api={api}
      projectId="project"
      jobs={[job("first", "source-a", "gcode-a"), job("second", "source-b", "gcode-b")]}
      onRefresh={onRefresh}
      onError={vi.fn()}
    />);

    expect(screen.getByText("Задание 2 · Creality K1C · PLA")).toBeTruthy();
    expect(screen.getByText("Задание 1 · Creality K1C · PLA")).toBeTruthy();
    const approvals = screen.getAllByRole("button", { name: "Подтвердить отправку на печать" });
    expect(approvals).toHaveLength(2);
    fireEvent.click(approvals[0]!);

    await waitFor(() => expect(approvePrint).toHaveBeenCalledWith("project", "second"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("gcode-b"));
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(approvePrint).toHaveBeenCalledOnce();
  });
});
