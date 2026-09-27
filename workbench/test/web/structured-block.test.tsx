// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StructuredBlock } from "../../src/shared/contracts.ts";
import { StructuredBlockView } from "../../src/web/forms/structured-block.tsx";

const block: StructuredBlock = {
  id: "block-1",
  projectId: "11111111-1111-4111-8111-111111111111",
  createdAt: "2026-09-20T00:00:00.000Z",
  type: "dimensions",
  title: "Контрольные размеры",
  rows: [{
    key: "width",
    label: "Overall width",
    value: 80,
    actual: 80,
    tolerance: 0.01,
    unit: "mm",
    source: "native-brep",
    confidence: "verified",
    status: "verified",
  }],
};

afterEach(cleanup);

describe("StructuredBlockView", () => {
  it("batches edited dimension cells only after explicit submission", async () => {
    const submit = vi.fn(async () => undefined);
    render(<StructuredBlockView block={block} onSubmit={submit} />);
    const input = screen.getByLabelText("Overall width");
    fireEvent.change(input, { target: { value: "82" } });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить размеры" }));
    expect(submit).toHaveBeenCalledWith({ blockId: "block-1", changes: [{ key: "width", value: 82 }] });
  });

  it("blocks values outside the published numeric constraints", () => {
    const submit = vi.fn(async () => undefined);
    render(<StructuredBlockView block={{ ...block, rows: [{ ...block.rows[0]!, input: { min: 75, max: 85, step: 0.1 } }] }} onSubmit={submit} />);
    fireEvent.change(screen.getByLabelText("Overall width"), { target: { value: "90" } });
    expect((screen.getByRole("button", { name: "Сохранить размеры" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/максимум 85/)).toBeTruthy();
  });

  it("blocks values that do not follow the published increment", () => {
    const submit = vi.fn(async () => undefined);
    render(<StructuredBlockView block={{ ...block, rows: [{ ...block.rows[0]!, input: { min: 75, max: 85, step: 0.1 } }] }} onSubmit={submit} />);
    fireEvent.change(screen.getByLabelText("Overall width"), { target: { value: "80.05" } });
    expect((screen.getByRole("button", { name: "Сохранить размеры" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/шаг 0.1/)).toBeTruthy();
  });

  it("links a dimension row back to its model geometry", () => {
    const focus = vi.fn();
    render(<StructuredBlockView block={{ ...block, rows: [{ ...block.rows[0]!, linkedEntities: [{ bodyId: 8, faceId: "face-2" }] }] }} activeGeometry={{ bodyId: 8, faceId: "face-2" }} onGeometryRequest={focus} />);
    const link = screen.getByRole("button", { name: "Overall width" });
    expect(link.closest("tr")?.className).toContain("linked-active");
    fireEvent.click(link);
    expect(focus).toHaveBeenCalledWith({ bodyId: 8, faceId: "face-2" });
  });
});
