"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BrandKit } from "@/lib/brand/types";
import { emptyBrandKit } from "@/lib/brand/types";

interface BrandApiResponse {
  brand: BrandKit;
}

/**
 * Loads + autosaves the brand kit.
 *
 * - `brand` is the current kit (empty defaults while loading).
 * - `update(partial)` shallow-merges into local state immediately (snappy UI)
 *   and debounces a PUT (~600ms) so field edits persist without a save button.
 *   `colors`, `color_usage`, `typography`, and `fonts` are replaced wholesale
 *   when passed — pass the full object, not a delta.
 * - `uploadAsset(file, category, label?)` POSTs multipart to /api/brand/assets.
 * - `deleteAsset(id)` DELETEs /api/brand/assets/<id>. Both reload the kit from
 *   the server response so the assets[] stays authoritative server-side.
 * - `reload()` re-GETs the kit.
 *
 * `saveState` reflects the pending autosave: "idle" | "saving" | "saved" |
 * "error", surfaced as a small indicator in the studio header.
 */
/**
 * @param agentBusy true while the brand agent is working on brand.json. While
 *   busy, the debounced autosave is paused (avoids clobbering the agent's
 *   concurrent writes), and when it transitions busy→idle the kit is reloaded
 *   from disk so the agent's changes surface in the UI.
 */
export function useBrandState(agentBusy = false) {
  const [brand, setBrand] = useState<BrandKit>(emptyBrandKit);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  // Debounce timer + the latest kit to send. Held in refs so `update` can stay
  // stable across renders.
  const kitRef = useRef<BrandKit>(brand);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveSeqRef = useRef(0); // guards against out-of-order save responses
  const agentBusyRef = useRef(agentBusy);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/brand", { cache: "no-store" });
      if (!res.ok) throw new Error(`/api/brand → ${res.status}`);
      const data = (await res.json()) as BrandApiResponse;
      setBrand(data.brand);
      kitRef.current = data.brand;
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
  }, [reload]);

  // Two-writer safety: the agent writes brand.json directly while the UI also
  // autosaves. While the agent is busy, pause UI autosave (it would clobber the
  // agent's in-flight changes). When it goes idle, reload so its changes show.
  useEffect(() => {
    const wasBusy = agentBusyRef.current;
    agentBusyRef.current = agentBusy;
    if (wasBusy && !agentBusy) {
      // busy → idle: the agent just finished; re-read the kit it wrote.
      reload();
    }
  }, [agentBusy, reload]);

  const flushSave = useCallback(async (kit: BrandKit) => {
    const seq = ++saveSeqRef.current;
    setSaveState("saving");
    try {
      const res = await fetch("/api/brand", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kit),
      });
      if (!res.ok) throw new Error(`/api/brand PUT → ${res.status}`);
      const data = (await res.json()) as BrandApiResponse;
      // Only adopt the response if no later save has raced in.
      if (seq === saveSeqRef.current) {
        kitRef.current = data.brand;
        setBrand(data.brand);
        setSaveState("saved");
        // Let the "saved" pill linger briefly, then go quiet.
        setTimeout(() => {
          if (seq === saveSeqRef.current) setSaveState("idle");
        }, 1500);
      }
    } catch {
      if (seq === saveSeqRef.current) setSaveState("error");
    }
  }, []);

  const update = useCallback(
    (partial: Partial<BrandKit>) => {
      setBrand((prev) => {
        const next = { ...prev, ...partial, lastUpdated: new Date().toISOString() };
        kitRef.current = next;
        // Skip the autosave PUT while the agent is writing brand.json — last
        // writer would win and we'd clobber the agent's changes. The local UI
        // state still updates for snappiness; the agent's reload on idle wins.
        if (agentBusyRef.current) return next;
        // Debounce the PUT; each edit resets the timer.
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => flushSave(next), 600);
        return next;
      });
    },
    [flushSave],
  );

  const uploadAsset = useCallback(
    async (file: File, category: "logo" | "photo" | "component" | "icon", label?: string) => {
      const form = new FormData();
      form.append("file", file);
      form.append("category", category);
      if (label) form.append("label", label);
      setSaveState("saving");
      const res = await fetch("/api/brand/assets", { method: "POST", body: form });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setSaveState("error");
        throw new Error(data.error ?? `upload failed (${res.status})`);
      }
      const data = (await res.json()) as BrandApiResponse;
      kitRef.current = data.brand;
      setBrand(data.brand);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1500);
    },
    [],
  );

  const deleteAsset = useCallback(async (id: string) => {
    setSaveState("saving");
    const res = await fetch(`/api/brand/assets/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      setSaveState("error");
      throw new Error(`delete failed (${res.status})`);
    }
    const data = (await res.json()) as BrandApiResponse;
    kitRef.current = data.brand;
    setBrand(data.brand);
    setSaveState("saved");
    setTimeout(() => setSaveState("idle"), 1500);
  }, []);

  return { brand, loading, error, saveState, update, reload, uploadAsset, deleteAsset };
}
