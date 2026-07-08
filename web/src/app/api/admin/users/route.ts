import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db, type UserRow } from "@/lib/db";
import { purgeForUser } from "@/lib/docker";

export const runtime = "nodejs";

// ─── Helper: verify admin ─────────────────────────────────────────────────

async function requireAdmin(): Promise<{ user: { id: number; username: string } } | NextResponse> {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!user.is_admin) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  return { user: { id: user.id, username: user.username } };
}

// ─── GET /api/admin/users ─────────────────────────────────────────────────

export async function GET() {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;

  const users = db()
    .prepare("SELECT id, username, display_name, created_at, is_admin FROM users ORDER BY created_at")
    .all() as Array<{
    id: number;
    username: string;
    display_name: string | null;
    created_at: number;
    is_admin: number;
  }>;

  return NextResponse.json({
    users: users.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name ?? u.username,
      isAdmin: u.is_admin === 1,
      createdAt: u.created_at,
    })),
  });
}

// ─── POST /api/admin/users ────────────────────────────────────────────────

export async function POST(req: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await req.json().catch(() => ({}));
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");
  const displayName = String(body.displayName ?? "").trim() || username;

  if (!username) {
    return NextResponse.json({ error: "Username is required." }, { status: 400 });
  }
  if (username.length < 3) {
    return NextResponse.json({ error: "Username must be at least 3 characters." }, { status: 400 });
  }
  if (!password || password.length < 6) {
    return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 400 });
  }

  // Check for duplicate
  const existing = db().prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (existing) {
    return NextResponse.json({ error: "Username already exists." }, { status: 409 });
  }

  const { hashSync } = await import("bcryptjs");
  const hash = hashSync(password, 10);

  const defaultAvatarUrl = (name: string) =>
    `https://api.dicebear.com/9.x/notionists/svg?seed=${encodeURIComponent(name)}`;

  const result = db()
    .prepare(
      `INSERT INTO users (username, password_hash, display_name, avatar_url, is_admin, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    )
    .run(username, hash, displayName, defaultAvatarUrl(username), Date.now());

  return NextResponse.json({
    ok: true,
    user: { id: Number(result.lastInsertRowid), username, displayName },
  });
}

// ─── DELETE /api/admin/users ───────────────────────────────────────────────

export async function DELETE(req: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;

  const body = await req.json().catch(() => ({}));
  const userId = Number(body.userId);
  if (!userId) {
    return NextResponse.json({ error: "userId is required." }, { status: 400 });
  }

  // Prevent deleting self
  if (userId === admin.user.id) {
    return NextResponse.json({ error: "Cannot delete your own account." }, { status: 400 });
  }

  // Prevent deleting other admins
  const target = db().prepare("SELECT id, username, is_admin FROM users WHERE id = ?").get(userId) as
    | { id: number; username: string; is_admin: number }
    | undefined;
  if (!target) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }
  if (target.is_admin === 1) {
    return NextResponse.json({ error: "Cannot delete admin users." }, { status: 400 });
  }

  // Fully purge the user's footprint: tear down their container + workspace
  // volume, then delete the DB row (cascades to sessions/containers/workflows).
  // Without this, deleting a user leaks their Docker resources. purgeForUser
  // logs and swallows Docker errors so a stuck resource never blocks the delete.
  const targetRow = {
    id: target.id,
    username: target.username,
    // The remaining fields aren't used by purgeForUser (it only needs id +
    // username), but UserRow requires them to satisfy the type.
    password_hash: "",
    display_name: null,
    avatar_url: null,
    is_admin: target.is_admin,
    created_at: 0,
  } satisfies UserRow;
  await purgeForUser(targetRow);

  db().prepare("DELETE FROM users WHERE id = ?").run(userId);
  return NextResponse.json({ ok: true });
}
