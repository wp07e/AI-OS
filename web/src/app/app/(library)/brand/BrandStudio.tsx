"use client";

import { useState } from "react";
import { useAgentChatContext } from "@/lib/hooks/AgentChatContext";
import { useBrandState } from "./useBrandState";
import { BrandCardGrid } from "./BrandCardGrid";
import { BrandCardPage } from "./BrandCardPage";
import { BrandIdentityPanel } from "./components/BrandIdentityPanel";
import { BrandColorsPanel } from "./components/BrandColorsPanel";
import { BrandTypographyPanel } from "./components/BrandTypographyPanel";
import { BrandAssetsPanel } from "./components/BrandAssetsPanel";
import type { BrandCardKey } from "@/lib/brand/cards";
import type { AssetCategory } from "@/lib/brand/types";

interface Props {
  /** Called when a card's Ask AI button is clicked; activates the agent panel. */
  onAskAI: (card: BrandCardKey) => void;
  /** Called when the open card changes (including back to null), so the shell
   *  can keep the agent transport's card context in sync. */
  onCardChange: (card: BrandCardKey | null) => void;
}

/**
 * The Brand library canvas, rendered in the center pane when the user selects
 * "Brand" in the WorkRail LIBRARIES section.
 *
 * Two-level navigation:
 *   - Landing: a grid of cards (Identity, Colors, Typography, Logos, Photos,
 *     Components, Icons). Each card shows a summary + opens an inner page.
 *   - Card page: an editor for that card's fields, with a back button and an
 *     "Ask AI" button that seeds the agent panel with card-specific context.
 *
 * Unlike workflow canvases, Brand is a shared one-per-user library (not a
 * workflow instance), so it doesn't take instanceId/folder props and doesn't
 * poll a state.json. It loads the kit via useBrandState and autosaves edits.
 */
export function BrandStudio({ onAskAI, onCardChange }: Props) {
  // The agent chat (AppShell targets the brand session when brand is active).
  // Used to pause UI autosave while the agent writes brand.json, and to reload
  // the kit when it finishes.
  const chat = useAgentChatContext();
  const { brand, loading, error, saveState, update, uploadAsset, deleteAsset } =
    useBrandState(chat.busy || !!chat.streaming);
  const [activeCard, setActiveCard] = useState<BrandCardKey | null>(null);

  // Keep the shell informed of the open card so the agent transport carries the
  // right per-card context. Lifted state lives in AppShell; this mirrors it.
  function openCard(card: BrandCardKey) {
    setActiveCard(card);
    onCardChange(card);
  }
  function closeCard() {
    setActiveCard(null);
    onCardChange(null);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {activeCard === null ? (
        <>
          {/* Shell-chrome sub-header for the landing grid */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-[var(--card)]/40 px-4 py-2">
            <h2 className="truncate text-xs font-semibold text-[var(--foreground)]">Brand Kit</h2>
            <SaveStatePill state={saveState} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl p-4">
              {loading ? (
                <LoadingState />
              ) : error ? (
                <ErrorState error={error} />
              ) : (
                <>
                  <p className="mb-3 text-xs text-[var(--muted)]">
                    Manage your brand identity, colors, typography, and assets. Each card can also ask the AI for help.
                  </p>
                  <BrandCardGrid brand={brand} onOpen={openCard} />
                </>
              )}
            </div>
          </div>
        </>
      ) : (
        <BrandCardPage
          card={activeCard}
          onBack={closeCard}
          onAskAI={(c) => onAskAI(c)}
        >
          {loading ? (
            <LoadingState />
          ) : error ? (
            <ErrorState error={error} />
          ) : (
            <CardContent
              card={activeCard}
              brand={brand}
              update={update}
              uploadAsset={uploadAsset}
              deleteAsset={deleteAsset}
            />
          )}
        </BrandCardPage>
      )}
    </div>
  );
}

/** Renders the right panel component for the active card. */
function CardContent({
  card,
  brand,
  update,
  uploadAsset,
  deleteAsset,
}: {
  card: BrandCardKey;
  brand: ReturnType<typeof useBrandState>["brand"];
  update: ReturnType<typeof useBrandState>["update"];
  uploadAsset: ReturnType<typeof useBrandState>["uploadAsset"];
  deleteAsset: ReturnType<typeof useBrandState>["deleteAsset"];
}) {
  switch (card) {
    case "identity":
      return <BrandIdentityPanel brand={brand} update={update} />;
    case "colors":
      return <BrandColorsPanel brand={brand} update={update} />;
    case "typography":
      return <BrandTypographyPanel brand={brand} update={update} />;
    case "logo":
    case "photo":
    case "component":
    case "icon":
      return (
        <BrandAssetsPanel
          brand={brand}
          uploadAsset={uploadAsset}
          deleteAsset={deleteAsset}
          onlyCategory={card as AssetCategory}
        />
      );
  }
}

function LoadingState() {
  return (
    <div className="flex flex-col items-center gap-3 py-16">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-white/10 border-t-indigo-400" />
      <p className="text-xs text-[var(--muted)]">Loading brand kit…</p>
    </div>
  );
}

function ErrorState({ error }: { error: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center">
      <p className="text-sm font-medium text-red-300">Couldn&apos;t load brand kit</p>
      <p className="max-w-sm text-xs text-[var(--muted)]">{error}</p>
      <p className="max-w-sm text-[11px] text-[var(--muted)]/70">
        Make sure your container is running. Brand data lives in your workspace.
      </p>
    </div>
  );
}

function SaveStatePill({ state }: { state: "idle" | "saving" | "saved" | "error" }) {
  if (state === "idle") return null;
  const map = {
    saving: { dot: "bg-indigo-400 animate-pulse", text: "Saving…", cls: "text-indigo-200 border-indigo-400/30 bg-indigo-500/10" },
    saved: { dot: "bg-emerald-400", text: "Saved", cls: "text-emerald-200 border-emerald-400/30 bg-emerald-500/10" },
    error: { dot: "bg-red-400", text: "Save failed", cls: "text-red-200 border-red-400/30 bg-red-500/10" },
  } as const;
  const s = map[state];
  return (
    <span className={"inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium " + s.cls}>
      <span className={"h-1.5 w-1.5 rounded-full " + s.dot} />
      {s.text}
    </span>
  );
}
