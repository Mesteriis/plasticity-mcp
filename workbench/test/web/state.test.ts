import { describe, expect, it } from "vitest";

import type { Project, WorkbenchEvent } from "../../src/shared/contracts.ts";
import { initialWorkbenchState, reduceWorkbenchState } from "../../src/web/state.ts";

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Bracket",
  workspacePath: "/tmp/bracket",
  revision: 0,
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
};

function event(sequence: number, revision: number): WorkbenchEvent {
  return {
    sequence,
    projectId: project.id,
    occurredAt: project.updatedAt,
    payload: { type: "project.updated", project: { ...project, revision } },
  };
}

describe("Workbench reducer", () => {
  it("applies a contiguous event and requests a refetch on a gap", () => {
    const loaded = reduceWorkbenchState(initialWorkbenchState, {
      type: "snapshot",
      project,
      events: [event(1, 0)],
    });
    const next = reduceWorkbenchState(loaded, { type: "event", event: event(2, 1) });
    expect(next.project?.revision).toBe(1);
    expect(next.needsRefetch).toBe(false);
    const gap = reduceWorkbenchState(next, { type: "event", event: event(4, 2) });
    expect(gap.project?.revision).toBe(1);
    expect(gap.needsRefetch).toBe(true);
  });

  it("preserves unsent drafts when a snapshot is refreshed", () => {
    const drafted = reduceWorkbenchState(initialWorkbenchState, {
      type: "draft",
      blockId: "block-1",
      key: "width",
      value: "82",
    });
    const refreshed = reduceWorkbenchState(drafted, { type: "snapshot", project, events: [] });
    expect(refreshed.drafts["block-1"]?.width).toBe("82");
  });

  it("keeps the authoritative snapshot revision while replaying older events", () => {
    const loaded = reduceWorkbenchState(initialWorkbenchState, {
      type: "snapshot",
      project: { ...project, revision: 5 },
      events: [event(1, 0)],
    });
    expect(loaded.project?.revision).toBe(5);
  });
});
