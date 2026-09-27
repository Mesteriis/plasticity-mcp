import { describe, expect, it } from "vitest";

import { localUuid } from "../../src/web/uuid.ts";

describe("localUuid", () => {
  it("creates schema-compatible UUIDs without requiring crypto.randomUUID", () => {
    const first = localUuid();
    const second = localUuid();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });
});
