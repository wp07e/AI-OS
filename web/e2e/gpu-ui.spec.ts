/**
 * GPU UI smoke tests — the UI surfaces of the 6 manual test cases.
 *
 * Drives a real Chromium against the booted next dev server (mocked vast via
 * AIOS_TEST_MOCK_VAST=1, see playwright.config.ts). These tests catch the
 * UI-only regressions the API integration suite can't: button labels on
 * remount, the AI prefill text, and the chat-disabled-during-delete behavior.
 *
 * Server-side state-machine correctness is covered by
 * src/__tests__/integration/gpu-lifecycle.test.ts (the fast gate). This file
 * is intentionally small — 3 focused UI assertions.
 */

import { test, expect } from "@playwright/test";
import { loginAndGo, createLane, selectLane, waitForPill } from "./_auth";

// ── Test 3 (UI): pill state survives a lane switch during release ───────────
//
// Your original bug: pressing Release, switching to another lane, then back,
// showed "Release GPU" again (as if the GPU were still ready) because the pill
// re-rendered off a stale value. The server-side fix (manual release writes
// `destroyed` synchronously) means a remount always polls fresh state. This
// test pins that: after the switch-back, the pill must NOT show "GPU Ready" or
// "Release GPU" — it shows either "Releasing…" (with the d6a4f27 sessionStorage
// override) or "GPU Released"/"Acquire GPU" (baseline). Both are correct; the
// regression is specifically reverting to a ready-looking state.

test("Test 3 UI: pill does not revert to Ready/Release GPU after a mid-release lane switch", async ({
  page,
}) => {
  await loginAndGo(page);
  const blender = await createLane(page, "blender");
  await selectLane(page, blender.title);
  // Auto-acquire fires on mount; wait for ready.
  await waitForPill(page, ["GPU Ready"], 30_000);

  // Press Release.
  await page.getByRole("button", { name: "Release GPU" }).click();

  // IMMEDIATELY switch to a different lane and back — the bug window.
  const video = await createLane(page, "video");
  await selectLane(page, video.title);
  // Give the unmount/remount a beat to settle.
  await page.waitForTimeout(300);
  await selectLane(page, blender.title);

  // After the remount + next poll, the pill must NOT claim ready.
  // (Either "Releasing…" with d6a4f27, or "GPU Released"/"Acquire GPU" on
  // baseline — both are correct. The bug is showing "GPU Ready"/"Release GPU".)
  await page.waitForFunction(
    () => {
      const els = Array.from(document.querySelectorAll("span, button"));
      const text = els.map((el) => (el.textContent ?? "").trim());
      // Wait until the ready-state claims are GONE.
      return !text.includes("GPU Ready") && !text.includes("Release GPU");
    },
    { timeout: 15_000 },
  );
});

// ── Test 3 (AI prefill): the silent context does not claim READY mid-release ─
//
// The conversation bug: the AI told you "Ready. RTX 4060 Ti…" while a release
// was in flight. The prefill is built server-side from the live lease row, so
// once the row is `destroyed` the prefill must not say "lease is READY". We
// assert by inspecting the lease GET response (which mirrors the row the
// prefill reads) right after Release, before the destroy completes.

test("Test 3 AI prefill: lease GET after Release does not report ready", async ({
  page,
}) => {
  await loginAndGo(page);
  const blender = await createLane(page, "blender");
  await selectLane(page, blender.title);
  await waitForPill(page, ["GPU Ready"], 30_000);

  // Fire the manual release via the API (deterministic; avoids the button's
  // local state race).
  const delRes = await page.request.delete(`/api/workspace/${blender.id}/blender/lease`);
  expect(delRes.ok()).toBeTruthy();

  // The GET polled by the UI (and the row the prefill reads) must NOT be ready.
  // The mock's destroy window is stretched to 1500ms by the config, so this
  // poll happens well within the in-flight window.
  const getRes = await page.request.get(`/api/workspace/${blender.id}/blender/lease`);
  expect(getRes.ok()).toBeTruthy();
  const body = await getRes.json();
  const state = body.lease?.state;
  expect(state).not.toBe("ready");
  // Manual release writes destroyed synchronously; flag is set.
  expect(body.lease?.manually_released).toBe(1);
});

// ── Test 6 (UI): chat input disabled during lane deletion ───────────────────
//
// You noted the trashcan spinner can sit for a long time and suggested the AI
// prompt be disabled until deletion completes. Today, AgentPanel gates the
// input on `chatActive = !!workflowInstanceId` — which stays true while the
// lane row still exists (i.e. during the delete request). So the input is
// currently NOT disabled during deletion. This test pins the gap: marked
// test.fixme, it surfaces the desired behavior without breaking the gate.

test.fixme("Test 6 UI: chat input is disabled while a lane is being deleted", async ({
  page,
}) => {
  await loginAndGo(page);
  const blender = await createLane(page, "blender");
  await selectLane(page, blender.title);
  await waitForPill(page, ["GPU Ready", "Starting GPU", "No GPU"], 30_000);

  // Click the trashcan. The WorkRail renders aria-label "Delete <title>".
  // (window.confirm is auto-accepted by Playwright by default.)
  // We don't await the click — we want to inspect the chat input DURING the
  // delete request. The mock destroy is 1500ms so there's a real window.
  void page.getByRole("button", { name: new RegExp(`Delete ${blender.title}`) }).click();

  // The chat input (textarea in AgentPanel) should be disabled while the
  // spinner is showing. Today it is NOT — that's the gap this test documents.
  const textarea = page.locator("textarea").first();
  await expect(textarea).toBeDisabled({ timeout: 2_000 });
});
