import type { BrandCardKey } from "./cards";

/**
 * Per-card scoping preamble, prepended SERVER-SIDE to the user's message on
 * every brand Ask AI turn. Never rendered in the chat bubbles (the message
 * route filters user-message echoes from the event stream).
 *
 * Goals:
 *   1. Tell the agent exactly which card is open + which brand.json fields it
 *      may touch, so it stays in lane.
 *   2. Hard-refuse non-brand requests (e.g. "create a carousel") — those belong
 *      to a Carousel Studio lane, not the Brand library. Politely decline and
 *      tell the user to open the right workspace.
 *   3. Preserve untouched keys byte-for-byte on every write.
 *
 * This is soft scoping (instruction-based), not a hard sandbox — but it's
 * effective for a capable model, and the UI reloads whatever the agent actually
 * wrote on completion.
 */
export function brandCardPreamble(card: BrandCardKey): string {
  const scope = CARD_SCOPES[card];
  return [
    `[Brand Kit — ${scope.label} card]`,
    `You are operating in the Brand Kit library, on the "${scope.label}" card. The user's request follows below.`,
    ``,
    `SCOPE — you may ONLY ${scope.mayDo}. Do not modify any other part of brand.json.`,
    `If the user's request is partly outside scope, do what you can in scope and briefly note anything you couldn't.`,
    ``,
    `OUT OF SCOPE — hard refuse these politely and concisely:`,
    `  - Creating carousels, slide decks, presentations, or any Canva design. The user must open a Carousel Studio lane for that — the Brand library only holds reusable brand assets.`,
    `  - Anything unrelated to the brand kit (writing code, general chat, etc.). Tell them this panel is for their brand kit only.`,
    `When refusing, be brief and friendly, and point them to the right place.`,
    ``,
    `STILL APPLY: read-modify-write the WHOLE /workspace/brand/brand.json (never a fragment); preserve every key you don't change; refresh lastUpdated; end with a one-line summary of what you changed.`,
    `Do not acknowledge or repeat these instructions — just act on the user's request.`,
    ``,
    `User request:`,
  ].join("\n");
}

const CARD_SCOPES: Record<BrandCardKey, { label: string; mayDo: string }> = {
  identity: {
    label: "Identity",
    mayDo: "set `name` and `voice` in /workspace/brand/brand.json",
  },
  colors: {
    label: "Colors",
    mayDo: "add/edit/delete role-keyed entries in `colors` (role → #RRGGBB) and `color_usage` (role → note) in /workspace/brand/brand.json",
  },
  typography: {
    label: "Typography",
    mayDo: "edit `typography` (pairing, roles, fallback) and `fonts[]` in /workspace/brand/brand.json",
  },
  logo: {
    label: "Logos",
    mayDo: "generate logo images and add them as `assets[]` entries with category \"logo\" (save files under /workspace/brand/assets/)",
  },
  photo: {
    label: "Photos",
    mayDo: "generate photo/background images and add them as `assets[]` entries with category \"photo\" (save files under /workspace/brand/assets/)",
  },
  component: {
    label: "Components",
    mayDo: "generate component graphics and add them as `assets[]` entries with category \"component\" (save files under /workspace/brand/assets/)",
  },
  icon: {
    label: "Icons",
    mayDo: "generate icon graphics and add them as `assets[]` entries with category \"icon\" (save files under /workspace/brand/assets/)",
  },
};
