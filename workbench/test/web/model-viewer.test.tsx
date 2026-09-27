// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelVersion } from "../../src/shared/contracts.ts";
import type { OcctResult } from "../../src/web/model/model-scene.ts";
import { ModelViewer } from "../../src/web/model/model-viewer.tsx";

function version(number: number, name: string): ModelVersion {
  return {
    id: `22222222-2222-4222-8222-22222222222${number}`,
    projectId: "11111111-1111-4111-8111-111111111111",
    number,
    plasticityDocumentToken: "doc",
    plasticityRevision: `rev-${number}`,
    stepArtifactHash: String(number).repeat(64),
    measurements: [],
    bodyMappings: [{ bodyId: number, name, meshIndex: 0 }],
    createdAt: "2026-09-20T00:00:00.000Z",
  };
}

const good: OcctResult = {
  success: true,
  meshes: [{ name: "Bracket", attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } }, index: { array: [0, 1, 2] }, brep_faces: [] }],
};

afterEach(cleanup);

describe("ModelViewer", () => {
  it("keeps the current model when the next STEP conversion fails", async () => {
    const first = version(1, "Bracket");
    const second = version(2, "Changed bracket");
    render(<ModelViewer versions={[first, second]} initial={first} importer={async (candidate) => {
      if (candidate.id === second.id) throw new Error("broken STEP");
      return good;
    }} />);
    expect(await screen.findByText("Bracket")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Версия 2" }));
    await waitFor(() => expect(screen.getByText(/не удалось подготовить 3D-представление/i)).toBeTruthy());
    expect(screen.getByText("Bracket")).toBeTruthy();
  });

  it("reports the version selected for review and annotations", async () => {
    const first = version(1, "Bracket");
    const second = version(2, "Changed bracket");
    const changed = vi.fn();
    render(<ModelViewer versions={[first, second]} initial={first} importer={async () => good} onVersionChange={changed} />);
    await screen.findByText("Bracket");
    fireEvent.click(screen.getByRole("button", { name: "Версия 2" }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith(second));
  });

  it("exposes working review controls for named views and body display", async () => {
    const first = version(1, "Bracket");
    render(<ModelViewer versions={[first]} initial={first} importer={async () => good} />);
    expect(await screen.findByRole("button", { name: "Выбрать Bracket" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Спереди" }));
    expect(screen.getByRole("button", { name: "Спереди" }).className).toContain("active");
    fireEvent.click(screen.getByRole("button", { name: "Сечение Z" }));
    expect(screen.getByRole("button", { name: "Сечение Z" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Скрыть Bracket" }));
    expect(screen.getByRole("button", { name: "Показать Bracket" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Прозрачность Bracket" }));
    expect(screen.getByRole("button", { name: "Прозрачность Bracket" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("loads the selected project's initial version after a project switch", async () => {
    const first = version(1, "Bracket");
    const second = { ...version(2, "Enclosure"), projectId: "44444444-4444-4444-8444-444444444444" };
    const view = render(<ModelViewer versions={[first]} initial={first} importer={async (candidate) => ({ ...good, meshes: [{ ...good.meshes[0]!, name: candidate.id === second.id ? "Enclosure" : "Bracket" }] })} />);
    expect(await screen.findByRole("button", { name: "Выбрать Bracket" })).toBeTruthy();
    view.rerender(<ModelViewer versions={[second]} initial={second} importer={async () => ({ ...good, meshes: [{ ...good.meshes[0]!, name: "Enclosure" }] })} />);
    expect(await screen.findByRole("button", { name: "Выбрать Enclosure" })).toBeTruthy();
  });
});
