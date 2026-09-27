// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnnotationPanel } from "../../src/web/annotations/annotation-panel.tsx";

afterEach(cleanup);

describe("AnnotationPanel", () => {
  it("offers note and dimension tools and removes only the last draft explicitly", () => {
    const setTool = vi.fn();
    const removeLast = vi.fn();
    render(<AnnotationPanel tool="navigate" setTool={setTool} pending={[{ kind: "marker", anchor: { kind: "world", pointMm: [0, 0, 0] } }]} submitting={false} onRemoveLast={removeLast} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Заметка" }));
    expect(setTool).toHaveBeenCalledWith("note");
    expect(screen.getByRole("button", { name: "Размер" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Удалить последнюю" }));
    expect(removeLast).toHaveBeenCalledOnce();
  });
});
