/**
 * Shared Playwright helpers: login + lane creation.
 *
 * Login hits POST /api/login which sets the aios_session cookie. We log in via
 * `page.request` so the cookie lands on the page's BrowserContext, and route
 * subsequent API calls through `page.request` too — Playwright's standalone
 * `request` fixture does NOT share cookies with `page`, which would cause 401s.
 */

import type { Page } from "@playwright/test";

export const TEST_USER = process.env.SEED_USERNAME ?? "tester";
export const TEST_PASS = process.env.SEED_PASSWORD ?? "tester123";

/** Log in via the API (sets the session cookie) and navigate to the app. */
export async function loginAndGo(page: Page): Promise<void> {
  const ok = await page.request.post("/api/login", {
    data: { username: TEST_USER, password: TEST_PASS },
  });
  if (!ok.ok()) {
    throw new Error(`login failed: ${ok.status()} ${await ok.text()}`);
  }
  await page.goto("/app");
}

/**
 * Create a workflow lane of the given type via the API (matches what the
 * WorkRail "New <type>" button does). Returns the new instance id. Uses the
 * page's request context so the session cookie applies.
 *
 * A unique title (timestamp suffix) is passed so the rail button can be
 * clicked unambiguously — otherwise stale lanes from prior runs (the dev
 * server is reused across Playwright runs) would match the generic
 * "New Blender" label and select the wrong lane.
 */
export async function createLane(
  page: Page,
  type: "blender" | "video" | "carousel",
): Promise<{ id: string; title: string }> {
  // The rail groups lanes under a section header per type. To make the click
  // deterministic we pass a distinctive title and match it exactly.
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const labelMap = { blender: "Blender", video: "Video", carousel: "Carousel" };
  const title = `${labelMap[type]} ${suffix}`;
  const res = await page.request.post("/api/workflows", { data: { type, title } });
  if (!res.ok()) {
    throw new Error(`createLane(${type}) failed: ${res.status()} ${await res.text()}`);
  }
  const body = await res.json();
  const id = body.instance?.id ?? body.id ?? body.instance_id;
  if (!id) throw new Error(`createLane(${type}) response had no instance id: ${JSON.stringify(body)}`);
  return { id, title };
}

/**
 * Select a lane in the WorkRail by clicking its title. Reloads the app first so
 * newly-created lanes appear in the rail (the rail list is fetched on app
 * mount).
 *
 * The WorkRail groups lanes under collapsible section headers (default: only
 * "carousel" is open). We must expand the section matching the lane type
 * (inferred from the title prefix) before clicking the lane button.
 */
export async function selectLane(page: Page, title: string): Promise<void> {
  await page.reload();
  await page.waitForLoadState("networkidle");
  // Expand the section. The header button text is the workflow label, e.g.
  // "Blender Studio". The lane title is prefixed with the type for uniqueness.
  const sectionLabel = title.startsWith("Blender")
    ? "Blender Studio"
    : title.startsWith("Video")
      ? "Video Studio"
      : "Carousel Studio";
  // The section header button contains the label + a chevron + a count badge.
  // Use the exact label to avoid matching the bottom "+ New workflow" buttons.
  await page.getByRole("button", { name: sectionLabel, exact: false }).first().click();
  // Now the lane button is visible. Match by exact title (the span inside the
  // button carries the title text).
  await page.getByRole("button", { name: title, exact: true }).click();
}

/** Poll until the lease pill shows one of the target labels (or timeout). */
export async function waitForPill(
  page: Page,
  targetLabels: string[],
  timeoutMs = 15_000,
): Promise<void> {
  await page.waitForFunction(
    (targets) => {
      // The pill label is a font-medium span; the button text is separate.
      const els = Array.from(document.querySelectorAll("span, button"));
      return targets.some((t) => els.some((el) => (el.textContent ?? "").trim() === t));
    },
    targetLabels,
    { timeout: timeoutMs },
  );
}
