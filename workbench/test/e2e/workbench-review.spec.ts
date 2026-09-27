import { expect, test } from "playwright/test";

test("creates and opens a persistent review project", async ({ page, request }) => {
  const response = await request.post("/api/projects", { data: { name: "K1C bracket review" } });
  expect(response.status()).toBe(201);
  const project = await response.json() as { id: string };
  await page.goto(`/?project=${project.id}`);
  await expect(page.getByRole("heading", { name: "K1C bracket review" })).toBeVisible();
  await expect(page.getByText("Модель ещё не опубликована")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Подготовка к печати" })).toBeVisible();
  await expect(page.getByLabel("Сообщение агенту")).toHaveCount(0);
});

test("exchanges a one-time tablet pairing link without retaining its code", async ({ page, request }) => {
  const created = await request.post("/api/projects", { data: { name: "Tablet annotations" } });
  const project = await created.json() as { id: string };
  const issued = await request.post(`/api/projects/${project.id}/pairings`, { data: { role: "annotate", ttlMs: 60_000 } });
  const pairing = await issued.json() as { url: string; raw?: string };
  expect(pairing.raw).toBeUndefined();
  await page.goto(pairing.url);
  await expect(page.getByRole("heading", { name: "Tablet annotations" })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.has("code")).toBe(false);
});

test("revokes an active tablet session from the Mac", async ({ page, request, browser }) => {
  const created = await request.post("/api/projects", { data: { name: "Revocable tablet" } });
  const project = await created.json() as { id: string };
  const issued = await request.post(`/api/projects/${project.id}/pairings`, { data: { role: "annotate", ttlMs: 60_000 } });
  const pairing = await issued.json() as { url: string };
  const tablet = await browser.newPage();
  await tablet.goto(pairing.url);
  await expect(tablet.getByRole("heading", { name: "Revocable tablet" })).toBeVisible();

  await page.goto(`/?project=${project.id}`);
  await page.getByRole("button", { name: "Поделиться" }).click();
  await expect(page.getByText("Планшет · annotate")).toBeVisible();
  await page.locator(".pairing-sessions > div").filter({ hasText: "Планшет · annotate" }).getByRole("button", { name: "Отозвать" }).click();
  await expect(page.getByText("Планшет · annotate")).toHaveCount(0);
  const active = await request.get(`/api/projects/${project.id}/pairings`);
  expect((await active.json()) as Array<{ kind: string }>).not.toContainEqual(expect.objectContaining({ kind: "session" }));
  await tablet.close();
});
