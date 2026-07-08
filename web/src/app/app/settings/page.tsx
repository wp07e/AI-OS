"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Account settings. Currently exposes the Danger Zone: self-service account
 * deletion. Deleting an account is irreversible and fully purges the user
 * (container + workspace volume + all DB rows), so the confirm step requires
 * the user to type their username to enable the final button.
 */
export default function SettingsPage() {
  const router = useRouter();
  const [username, setUsername] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/me", { method: "GET" })
      .then((r) => r.json())
      .then((data: { user?: { username?: string } }) => {
        if (data.user?.username) setUsername(data.user.username);
      })
      .catch(() => {
        /* leave username null — delete stays disabled */
      });
  }, []);

  const canConfirm = username !== null && typed.trim() === username;

  async function confirmDelete() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch("/api/account", { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Failed (${res.status}).`);
        return;
      }
      router.replace("/login");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 overflow-y-auto p-6">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">Manage your account.</p>

      <div className="mt-8 overflow-hidden rounded-xl border border-red-500/30 bg-red-500/[0.04]">
        <div className="border-b border-red-500/20 px-4 py-3">
          <h2 className="text-sm font-semibold text-red-200">Danger Zone</h2>
        </div>
        <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-md">
            <p className="text-sm font-medium">Delete account</p>
            <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
              Permanently deletes your account, your container, and all of your
              files and workflow data. This cannot be undone.
            </p>
          </div>
          <button
            onClick={() => {
              setConfirmOpen(true);
              setError(null);
              setTyped("");
            }}
            className="shrink-0 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-200 transition hover:border-red-500/70 hover:bg-red-500/15"
          >
            Delete account
          </button>
        </div>
      </div>

      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => {
            if (!deleting) setConfirmOpen(false);
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-white/10 bg-[var(--card)] p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-red-200">
              Delete your account?
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">
              This permanently removes your account, your container, and all of
              your files and workflow data. You will be signed out immediately.
            </p>
            <p className="mt-4 text-xs text-[var(--muted)]">
              Type your username{" "}
              <code className="font-mono text-[var(--foreground)]">
                {username ?? "…"}
              </code>{" "}
              to confirm:
            </p>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={deleting}
              placeholder={username ?? ""}
              autoComplete="off"
              spellCheck={false}
              className="mt-2 w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm outline-none focus:border-red-500/50"
            />
            {error && (
              <p className="mt-3 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {error}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirmOpen(false)}
                disabled={deleting}
                className="rounded-lg px-3 py-1.5 text-sm text-[var(--muted)] transition hover:bg-white/5 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={!canConfirm || deleting}
                className="rounded-lg bg-red-500/90 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {deleting ? "Deleting…" : "Permanently delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
