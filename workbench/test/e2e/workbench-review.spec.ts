import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { expect, test, type Page } from "playwright/test";

test.use({ trace: "off" });

async function ownerToken(): Promise<string> {
  return (await readFile(resolve("test-results/workbench-data/owner-token"), "utf8")).trim();
}

async function ownerHeaders(): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await ownerToken()}` };
}

async function openOwnerPage(page: Page): Promise<void> {
  await page.goto(`/#owner=${await ownerToken()}`);
  await expect.poll(() => new URL(page.url()).hash).toBe("");
}

test("creates and opens a persistent review project", async ({ page, request }) => {
  const response = await request.post("/api/projects", { data: { name: "K1C bracket review" }, headers: await ownerHeaders() });
  expect(response.status()).toBe(201);
  const project = await response.json() as { id: string };
  await openOwnerPage(page);
  await page.goto(`/?project=${project.id}`);
  await expect(page.getByRole("heading", { name: "K1C bracket review" })).toBeVisible();
  await expect(page.getByText("Модель ещё не опубликована")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Подготовка к печати" })).toBeVisible();
  await expect(page.getByLabel("Сообщение агенту")).toHaveCount(0);
});

test("creates a project from the mobile navigation without horizontal overflow", async ({ page }) => {
  const name = `Крепление K1C ${randomUUID().slice(0, 8)}`;
  await page.setViewportSize({ width: 390, height: 844 });
  await openOwnerPage(page);
  await page.getByRole("button", { name: "Новый проект" }).click();
  const dialog = page.getByRole("dialog", { name: "Новый проект" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Название проекта").fill(name);
  await dialog.getByRole("button", { name: "Создать проект" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Проекты" }).getByRole("button", { name: new RegExp(name) })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("explains how to open an owner session", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Нет доступа к проектам");
  await expect(page.getByRole("button", { name: "Новый проект" })).toHaveCount(0);
});

test("exchanges a one-time tablet pairing link without retaining its code", async ({ page, request }) => {
  const created = await request.post("/api/projects", { data: { name: "Tablet annotations" }, headers: await ownerHeaders() });
  const project = await created.json() as { id: string };
  const issued = await request.post(`/api/projects/${project.id}/pairings`, { data: { role: "annotate", ttlMs: 60_000 }, headers: await ownerHeaders() });
  const pairing = await issued.json() as { url: string; raw?: string };
  expect(pairing.raw).toBeUndefined();
  await page.goto(pairing.url);
  await expect(page.getByRole("heading", { name: "Tablet annotations" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Новый проект" })).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.has("code")).toBe(false);
});

test("revokes an active tablet session from the Mac", async ({ page, request, browser }) => {
  const created = await request.post("/api/projects", { data: { name: "Revocable tablet" }, headers: await ownerHeaders() });
  const project = await created.json() as { id: string };
  const issued = await request.post(`/api/projects/${project.id}/pairings`, { data: { role: "annotate", ttlMs: 60_000 }, headers: await ownerHeaders() });
  const pairing = await issued.json() as { url: string };
  const tablet = await browser.newPage();
  await tablet.goto(pairing.url);
  await expect(tablet.getByRole("heading", { name: "Revocable tablet" })).toBeVisible();

  await openOwnerPage(page);
  await page.goto(`/?project=${project.id}`);
  await page.getByRole("button", { name: "Поделиться" }).click();
  await expect(page.getByText("Планшет · annotate")).toBeVisible();
  await page.locator(".pairing-sessions > div").filter({ hasText: "Планшет · annotate" }).getByRole("button", { name: "Отозвать" }).click();
  await expect(page.getByText("Планшет · annotate")).toHaveCount(0);
  const active = await request.get(`/api/projects/${project.id}/pairings`, { headers: await ownerHeaders() });
  expect((await active.json()) as Array<{ kind: string }>).not.toContainEqual(expect.objectContaining({ kind: "session" }));
  await tablet.close();
});
