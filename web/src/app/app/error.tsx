"use client";

/**
 * Next.js error boundary for the app shell. Catches render errors from the
 * canvas (e.g. unexpected state shapes) and shows a recovery UI instead of a
 * blank white screen. The user can retry without a full page reload.
 *
 * Per Next.js convention, this must be a client component and receives
 * { error, reset } — `reset` re-renders the error boundary's children.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-10 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-2xl border border-red-400/30 bg-red-500/10">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-red-300"
          aria-hidden
        >
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>
      <div>
        <p className="text-sm font-medium">Something went wrong</p>
        <p className="mt-1 max-w-sm text-xs text-[var(--muted)]">
          The workflow canvas hit an unexpected error. You can retry without losing
          your work — the agent session and files are unaffected.
        </p>
      </div>
      <button
        onClick={reset}
        className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2 text-xs font-semibold transition hover:bg-white/[0.06]"
      >
        Retry
      </button>
      {error.digest && (
        <p className="font-mono text-[10px] text-[var(--muted)]/60">error: {error.digest}</p>
      )}
    </div>
  );
}
