"use client";

import { useState, useEffect, useCallback } from "react";

interface User {
  id: number;
  username: string;
  displayName: string;
  isAdmin: boolean;
  createdAt: number;
}

export default function AdminPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add user form state
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSuccess, setAddSuccess] = useState<string | null>(null);

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/users");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to load users.");
        setUsers([]);
        return;
      }
      const data = await res.json();
      setUsers(data.users);
      setError(null);
    } catch {
      setError("Network error.");
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    setAddError(null);
    setAddSuccess(null);
    setAdding(true);

    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: newUsername,
          password: newPassword,
          displayName: newDisplayName || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setAddError(data.error ?? "Failed to create user.");
        return;
      }

      setAddSuccess(`User "${data.user.username}" created.`);
      setNewUsername("");
      setNewPassword("");
      setNewDisplayName("");
      fetchUsers();
    } catch {
      setAddError("Network error.");
    } finally {
      setAdding(false);
    }
  }

  async function handleDeleteUser(userId: number, username: string) {
    if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;

    try {
      const res = await fetch("/api/admin/users", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        alert(data.error ?? "Failed to delete user.");
        return;
      }

      fetchUsers();
    } catch {
      alert("Network error.");
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto p-6">
      <h1 className="text-xl font-semibold tracking-tight">User Management</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Create and manage user accounts for AI OS.
      </p>

      {/* ── Add User Form ── */}
      <div className="mt-6 rounded-xl border border-white/10 bg-[var(--card)]/80 p-6">
        <h2 className="text-sm font-semibold">Add New User</h2>

        <form onSubmit={handleAddUser} className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--muted)]">
                Username *
              </span>
              <input
                type="text"
                required
                minLength={3}
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none transition focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-400/30"
                placeholder="jdoe"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--muted)]">
                Password *
              </span>
              <input
                type="password"
                required
                minLength={6}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none transition focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-400/30"
                placeholder="Min 6 characters"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--muted)]">
                Display Name
              </span>
              <input
                type="text"
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none transition focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-400/30"
                placeholder="John Doe"
              />
            </label>
          </div>

          {addError && (
            <p className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {addError}
            </p>
          )}
          {addSuccess && (
            <p className="rounded-md bg-green-500/10 px-3 py-2 text-xs text-green-300">
              {addSuccess}
            </p>
          )}

          <button
            type="submit"
            disabled={adding}
            className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-500/20 transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {adding ? "Creating…" : "Create User"}
          </button>
        </form>
      </div>

      {/* ── User List ── */}
      <div className="mt-6 rounded-xl border border-white/10 bg-[var(--card)]/80 p-6">
        <h2 className="text-sm font-semibold">Users ({users.length})</h2>

        {loading && (
          <p className="mt-4 text-sm text-[var(--muted)]">Loading users…</p>
        )}

        {error && !loading && (
          <p className="mt-4 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}

        {!loading && !error && users.length === 0 && (
          <p className="mt-4 text-sm text-[var(--muted)]">No users found.</p>
        )}

        {!loading && users.length > 0 && (
          <div className="mt-4 space-y-2">
            {/* Header */}
            <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-3 px-3 text-xs font-medium text-[var(--muted)]">
              <span>Username</span>
              <span>Display Name</span>
              <span>Role</span>
              <span></span>
            </div>

            {users.map((user) => (
              <div
                key={user.id}
                className="grid grid-cols-[1fr_1fr_auto_auto] items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5"
              >
                <div>
                  <p className="text-sm font-medium">{user.username}</p>
                  <p className="text-xs text-[var(--muted)]">
                    Created {new Date(user.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <p className="truncate text-sm text-[var(--muted)]">
                  {user.displayName}
                </p>
                {user.isAdmin ? (
                  <span className="inline-flex items-center rounded bg-indigo-500/20 px-2 py-0.5 text-[10px] font-semibold text-indigo-300">
                    ADMIN
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded bg-white/5 px-2 py-0.5 text-[10px] font-medium text-[var(--muted)]">
                    USER
                  </span>
                )}
                {!user.isAdmin ? (
                  <button
                    onClick={() => {
                      if (deletingId === user.id) {
                        handleDeleteUser(user.id, user.username);
                        setDeletingId(null);
                      } else {
                        setDeletingId(user.id);
                        setTimeout(() => setDeletingId(null), 3000);
                      }
                    }}
                    className="rounded-lg px-2 py-1 text-xs text-red-300 transition hover:bg-red-500/10"
                  >
                    {deletingId === user.id ? "Confirm?" : "Delete"}
                  </button>
                ) : (
                  <span className="w-full text-right text-xs text-[var(--muted)]">
                    —
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
