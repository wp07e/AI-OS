import { NextResponse } from "next/server";
import { currentUser, logout } from "@/lib/auth";
import { db } from "@/lib/db";
import { purgeForUser } from "@/lib/docker";

export const runtime = "nodejs";
export const maxDuration = 60; // tearing down the container + volume can take a moment

/**
 * DELETE /api/account — self-service account deletion.
 *
 * Fully purges the authenticated user:
 *   - Tears down their Docker container and deletes their per-user workspace
 *     volume (all lane files, OpenCode state, cached Canva tokens).
 *   - Deletes the users row; ON DELETE CASCADE removes their sessions,
 *     containers, workflow_instances, and opencode_sessions rows.
 *   - Clears the current session cookie so the response leaves them logged out.
 *
 * Guard: the last remaining admin cannot delete their own account (would lock
 * everyone out of user management). Non-last admins and regular users can.
 */
export async function DELETE() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Never let the last admin remove themselves — there'd be no way to manage
  // users afterward.
  if (user.is_admin) {
    const { c } = db()
      .prepare("SELECT COUNT(*) AS c FROM users WHERE is_admin = 1")
      .get() as { c: number };
    if (c <= 1) {
      return NextResponse.json(
        {
          error:
            "You are the only admin. Promote another user to admin before deleting your account.",
        },
        { status: 400 },
      );
    }
  }

  // Tear down Docker resources (container + volume) before the DB delete.
  // purgeForUser logs and swallows Docker errors so a stuck resource never
  // blocks the account purge — the user must always be able to leave.
  await purgeForUser(user);

  db().prepare("DELETE FROM users WHERE id = ?").run(user.id);

  await logout();
  return NextResponse.json({ ok: true });
}
