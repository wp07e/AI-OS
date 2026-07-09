/**
 * Curated catalog of common Canva fonts.
 *
 * The Canva MCP has no font-upload tool and no "list fonts" endpoint
 * (container/fixtures/README.md documents this hard constraint). So instead of
 * calling a font service, we ship a static seed list of ~50 popular fonts
 * that Canva supports out of the box. The user picks a subset (brand.fonts);
 * they can also add custom names with the understanding that Canva may
 * substitute a fallback if the family isn't in their account's catalog.
 *
 * Grouped by category purely for the picker UI. Names are spelled exactly as
 * Canva expects them so the carousel pipeline can pass them verbatim into the
 * generate-design prompt.
 */

export type FontCategory = "sans" | "serif" | "display" | "handwriting" | "mono";

export interface CatalogFont {
  name: string;
  category: FontCategory;
}

export const CANVA_FONT_CATALOG: CatalogFont[] = [
  // ── Sans-serif ──────────────────────────────────────────────────────
  { name: "Inter", category: "sans" },
  { name: "Montserrat", category: "sans" },
  { name: "Roboto", category: "sans" },
  { name: "Open Sans", category: "sans" },
  { name: "Poppins", category: "sans" },
  { name: "Lato", category: "sans" },
  { name: "Nunito", category: "sans" },
  { name: "Raleway", category: "sans" },
  { name: "Work Sans", category: "sans" },
  { name: "Manrope", category: "sans" },
  { name: "DM Sans", category: "sans" },
  { name: "Hind", category: "sans" },
  { name: "Mulish", category: "sans" },
  { name: "Karla", category: "sans" },

  // ── Serif ───────────────────────────────────────────────────────────
  { name: "Playfair Display", category: "serif" },
  { name: "Merriweather", category: "serif" },
  { name: "Lora", category: "serif" },
  { name: "PT Serif", category: "serif" },
  { name: "Cormorant Garamond", category: "serif" },
  { name: "Libre Baskerville", category: "serif" },
  { name: "EB Garamond", category: "serif" },
  { name: "Bitter", category: "serif" },

  // ── Display / headline ──────────────────────────────────────────────
  { name: "Oswald", category: "display" },
  { name: "Bebas Neue", category: "display" },
  { name: "Anton", category: "display" },
  { name: "Archivo Black", category: "display" },
  { name: "Abril Fatface", category: "display" },
  { name: "Righteous", category: "display" },
  { name: "Teko", category: "display" },
  { name: "Pacifico", category: "display" },
  { name: "Lobster", category: "display" },
  { name: "Cinzel", category: "display" },
  { name: "Prata", category: "display" },

  // ── Handwriting / script ────────────────────────────────────────────
  { name: "Dancing Script", category: "handwriting" },
  { name: "Sacramento", category: "handwriting" },
  { name: "Great Vibes", category: "handwriting" },
  { name: "Allura", category: "handwriting" },
  { name: "Satisfy", category: "handwriting" },
  { name: "Caveat", category: "handwriting" },
  { name: "Homemade Apple", category: "handwriting" },

  // ── Monospace ───────────────────────────────────────────────────────
  { name: "Roboto Mono", category: "mono" },
  { name: "Source Code Pro", category: "mono" },
  { name: "IBM Plex Mono", category: "mono" },
  { name: "JetBrains Mono", category: "mono" },
  { name: "Fira Code", category: "mono" },
  { name: "Space Mono", category: "mono" },
];

/** Fonts grouped by category, for rendering the picker in sections. */
export const FONTS_BY_CATEGORY: Record<FontCategory, string[]> = (
  CANVA_FONT_CATALOG.reduce(
    (acc, f) => {
      (acc[f.category] ||= []).push(f.name);
      return acc;
    },
    {} as Record<FontCategory, string[]>,
  )
);

export const FONT_CATEGORIES: FontCategory[] = ["sans", "serif", "display", "handwriting", "mono"];

/** Human label for a category, for the picker headings. */
export const FONT_CATEGORY_LABELS: Record<FontCategory, string> = {
  sans: "Sans-serif",
  serif: "Serif",
  display: "Display / Headline",
  handwriting: "Handwriting / Script",
  mono: "Monospace",
};

/** True if `name` appears in the curated catalog (case-insensitive). */
export function isKnownCanvaFont(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return CANVA_FONT_CATALOG.some((f) => f.name.toLowerCase() === lower);
}
