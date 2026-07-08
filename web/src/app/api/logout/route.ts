import { NextResponse } from "next/server";
import { currentUser, logout } from "@/lib/auth";
import { stopForUser } from "@/lib/docker";

export const runtime = "nodejs";
export const maxDuration = 60; // `docker compose down` can take a few seconds

export async function POST() {
  const user = await currentUser();

  // Stop the per-user container on logout so its process is killed and the
  // port/container footprint is released. The container is STOPPED, not removed
  // — the same container (same Docker container ID) resumes in place on the
  // user's next login, with all its data preserved in the workspace volume.
  // No-op if there's no row (e.g. failed launch) — stopForUser returns early.
  // Fire-and-forget: logout must not be blocked by (or fail because of) a
  // stuck `compose stop`. Errors are logged server-side, not surfaced, since
  // the user is leaving regardless.
  if (user) {
    stopForUser(user.id).catch((err) =>
      console.error("[logout] stopForUser failed", err),
    );
  }

  await logout();
  return NextResponse.json({ ok: true });
}
