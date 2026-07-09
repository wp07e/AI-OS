"use client";

import type { BrandKit } from "@/lib/brand/types";
import type { BrandCardKey } from "@/lib/brand/cards";

interface Props {
  brand: BrandKit;
  onOpen: (card: BrandCardKey) => void;
}

interface CardDef {
  key: BrandCardKey;
  title: string;
  hint: string;
  summary: (b: BrandKit) => string;
  icon: () => React.ReactNode;
  accent: string; // tailwind gradient classes
}

const CARDS: CardDef[] = [
  {
    key: "identity",
    title: "Identity",
    hint: "Brand name and voice/tone.",
    summary: (b) => (b.name ? `${b.name}${b.voice ? " · voice set" : ""}` : "Not set"),
    icon: IdentityIcon,
    accent: "from-indigo-500/20 to-indigo-500/5",
  },
  {
    key: "colors",
    title: "Colors",
    hint: "Role-keyed brand palette.",
    summary: (b) => `${Object.keys(b.colors).length} color${Object.keys(b.colors).length === 1 ? "" : "s"}`,
    icon: ColorIcon,
    accent: "from-rose-500/20 to-rose-500/5",
  },
  {
    key: "typography",
    title: "Typography",
    hint: "Font catalog + role mapping.",
    summary: (b) => `${b.fonts.length} font${b.fonts.length === 1 ? "" : "s"}`,
    icon: TypeIcon,
    accent: "from-sky-500/20 to-sky-500/5",
  },
  {
    key: "logo",
    title: "Logos",
    hint: "Primary brand marks.",
    summary: (b) => `${countAssets(b, "logo")} asset${countAssets(b, "logo") === 1 ? "" : "s"}`,
    icon: LogoIcon,
    accent: "from-amber-500/20 to-amber-500/5",
  },
  {
    key: "photo",
    title: "Photos",
    hint: "Backgrounds & imagery.",
    summary: (b) => `${countAssets(b, "photo")} asset${countAssets(b, "photo") === 1 ? "" : "s"}`,
    icon: PhotoIcon,
    accent: "from-emerald-500/20 to-emerald-500/5",
  },
  {
    key: "component",
    title: "Components",
    hint: "Pre-made graphic elements.",
    summary: (b) => `${countAssets(b, "component")} asset${countAssets(b, "component") === 1 ? "" : "s"}`,
    icon: ComponentIcon,
    accent: "from-violet-500/20 to-violet-500/5",
  },
  {
    key: "icon",
    title: "Icons",
    hint: "Symbol graphics.",
    summary: (b) => `${countAssets(b, "icon")} asset${countAssets(b, "icon") === 1 ? "" : "s"}`,
    icon: IconIcon,
    accent: "from-teal-500/20 to-teal-500/5",
  },
];

function countAssets(b: BrandKit, cat: string): number {
  return b.assets.filter((a) => a.category === cat).length;
}

/**
 * Landing grid of brand-kit cards. Each card opens an inner editing page.
 */
export function BrandCardGrid({ brand, onOpen }: Props) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {CARDS.map((card) => {
        const Icon = card.icon;
        return (
          <button
            key={card.key}
            onClick={() => onOpen(card.key)}
            className={
              "group flex flex-col items-start gap-2 rounded-xl border border-white/10 bg-gradient-to-br p-4 text-left transition hover:border-white/20 " +
              card.accent
            }
          >
            <span className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 bg-black/30 text-[var(--foreground)]">
              <Icon />
            </span>
            <span className="text-sm font-semibold text-[var(--foreground)]">{card.title}</span>
            <span className="text-[11px] text-[var(--muted)]">{card.hint}</span>
            <span className="mt-auto pt-1 text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]/70">
              {card.summary(brand)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── Card icons (inline SVG, matching the app's hand-built icon style) ─────────

function IdentityIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
    </svg>
  );
}
function ColorIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.43-.18-.83-.44-1.12-.29-.29-.44-.65-.44-1.12a1.64 1.64 0 0 1 1.67-1.67h1.99c3.05 0 5.57-2.5 5.57-5.55C22 6.01 17.46 2 12 2z" />
    </svg>
  );
}
function TypeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" y1="20" x2="15" y2="20" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  );
}
function LogoIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}
function PhotoIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  );
}
function ComponentIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <line x1="2" y1="17" x2="12" y2="22" />
      <line x1="22" y1="17" x2="12" y2="22" />
      <line x1="12" y1="12" x2="12" y2="22" />
    </svg>
  );
}
function IconIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}
