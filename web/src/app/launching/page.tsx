"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type Status = "launching" | "ready" | "error" | "none" | string;

export default function LaunchingPage() {
  const router = useRouter();
  const routerRef = useRef(router);
  const [status, setStatus] = useState<Status>("launching");
  const [message, setMessage] = useState<string | null>(null);

  // Keep routerRef in sync without writing during render (React anti-pattern).
  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  useEffect(() => {
    // React Strict Mode (Next.js dev default) mounts, unmounts, then remounts
    // every component to surface bugs. So this effect WILL run twice on mount.
    // We design around that:
    //   - The POST /api/launch is idempotent (reuses an existing container),
    //     so firing it twice is safe. We do NOT pass the abort signal to it —
    //     an abort there killed the request on the Strict-Mode unmount, which
    //     was the "AbortError: signal is aborted without reason" bug.
    //   - The abort signal is reserved for the poll loop, where cancellation
    //     on unmount is what we actually want.
    //   - No startedRef guard: such a guard would make mount #2 skip the retry
    //     that Strict Mode exists to test, leaving the aborted POST un-retried.
    console.log("[launch] effect mounted");
    let cancelled = false;
    const controller = new AbortController();

    async function launch() {
      // Triggers container creation (idempotent) if not already running.
      let postOk = false;
      try {
        console.log("[launch] POST /api/launch ...");
        const res = await fetch("/api/launch", { method: "POST" });
        console.log("[launch] POST response:", res.status, res.statusText);
        if (res.ok) {
          const body = await res.json().catch(() => ({}));
          console.log("[launch] POST body:", body);
          postOk = true;
        } else {
          const data = await res.json().catch(() => ({}));
          console.error("[launch] POST failed:", res.status, data);
          if (!cancelled) {
            setStatus("error");
            setMessage(data.error || `Launch failed (HTTP ${res.status}).`);
          }
          return;
        }
      } catch (e) {
        console.error("[launch] POST threw:", e);
        if (!cancelled) {
          setStatus("error");
          setMessage(
            e instanceof Error
              ? `Could not reach the server: ${e.message}.`
              : "Could not reach the server.",
          );
        }
        return;
      }

      if (!postOk || cancelled) return;
      console.log("[launch] POST ok, starting poll");
      poll();
    }

    async function poll() {
      const deadline = Date.now() + 180_000;
      // Bound transient GET failures so a permanent network/IO error surfaces
      // instead of silently looping until the 180s deadline.
      let consecutiveFailures = 0;
      const MAX_CONSECUTIVE_FAILURES = 5;
      let pollNum = 0;
      while (Date.now() < deadline && !cancelled) {
        pollNum++;
        try {
          const res = await fetch("/api/launch", {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
          });
          const data = await res.json().catch(() => ({})) as { status?: string; error?: string };
          console.log(`[launch] poll #${pollNum}:`, res.status, data);
          consecutiveFailures = 0;

          if (data.status === "ready") {
            console.log("[launch] ready! redirecting to /oauth");
            if (!cancelled) {
              setStatus("ready");
              setTimeout(() => routerRef.current.replace("/oauth"), 700);
            }
            return;
          }
          if (data.status === "error") {
            console.error("[launch] server reported error status");
            if (!cancelled) {
              setStatus("error");
              setMessage("Container failed to start. Check Docker is running.");
            }
            return;
          }
          // status === "none" (or anything other than "launching"): launch
          // never wrote a container row — the POST was lost or rejected. Don't
          // spin; surface it so the cause is visible.
          if (data.status !== "launching") {
            console.error("[launch] unexpected status:", data.status, "— bailing");
            if (!cancelled) {
              setStatus("error");
              setMessage(
                "Launch did not start. The server has no container record — check the server logs and confirm the Docker stack is running.",
              );
            }
            return;
          }
        } catch (e) {
          // AbortError happens on unmount (Strict Mode remount or navigation).
          // That's expected — just exit the loop quietly.
          if (controller.signal.aborted || cancelled) return;
          consecutiveFailures++;
          console.warn(`[launch] poll #${pollNum} failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, e);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            if (!cancelled) {
              setStatus("error");
              setMessage("Repeatedly failed to reach the server during launch.");
            }
            return;
          }
          /* transient — keep polling */
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      console.error("[launch] timed out after 180s");
      if (!cancelled) {
        setStatus("error");
        setMessage("Timed out waiting for container to become ready.");
      }
    }

    launch();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="flex flex-col items-center gap-6 text-center">
        <Spinner active={status === "launching"} />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {status === "ready" && "Environment ready"}
            {status === "launching" && "Spinning up your environment"}
            {status === "error" && "Something went wrong"}
          </h1>
          <p className="mt-1 max-w-xs text-sm text-[var(--muted)]">
            {status === "ready" && "Redirecting…"}
            {status === "launching" && "Provisioning your isolated AI container. This usually takes under a minute."}
            {status === "error" && (message ?? "Please try again.")}
          </p>
        </div>
        {status === "error" && (
          <button
            onClick={() => router.replace("/login")}
            className="rounded-lg border border-white/10 px-4 py-2 text-sm font-medium hover:bg-white/5"
          >
            Back to login
          </button>
        )}
      </div>
    </main>
  );
}

function Spinner({ active }: { active: boolean }) {
  return (
    <div className="relative h-20 w-20">
      <div
        className={`absolute inset-0 rounded-full border-2 border-white/10 ${
          active ? "animate-spin" : ""
        }`}
        style={{
          borderTopColor: "transparent",
          borderRightColor: active ? "#818cf8" : "transparent",
          animationDuration: "1.1s",
        }}
      />
      <div
        className={`absolute inset-2 rounded-full border-2 border-white/5 ${
          active ? "animate-spin" : ""
        }`}
        style={{
          borderTopColor: "transparent",
          borderLeftColor: active ? "#38bdf8" : "transparent",
          animationDuration: "1.6s",
          animationDirection: "reverse",
        }}
      />
      <div className="absolute inset-0 grid place-items-center">
        <div className="h-3 w-3 rounded-full bg-gradient-to-br from-indigo-400 to-sky-300 shadow-lg" />
      </div>
    </div>
  );
}
