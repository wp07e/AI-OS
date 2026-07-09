import type { BrandCardKey } from "./cards";

/**
 * Clickable example prompts shown in the AgentPanel when the brand AI is
 * active on a given card. The user clicks one to fill the input (they still
 * hit enter to send — this is user-initiated, not auto-seeded).
 *
 * Examples are concrete and varied so a user can see what kinds of asks the AI
 * handles on each card.
 */
export const BRAND_CARD_EXAMPLES: Record<BrandCardKey, string[]> = {
  identity: [
    "Write a brand voice for a specialty coffee roaster.",
    "Suggest a name for a minimalist skincare line.",
  ],
  colors: [
    "Pick three strong colors for a coffee brand.",
    "Suggest a dark, premium palette for a fintech startup.",
    "Build a warm, earthy palette with a punchy accent.",
  ],
  typography: [
    "Suggest a font pairing for a tech startup.",
    "Add Inter and Poppins to my font catalog.",
    "Recommend a serif/sans pairing for an editorial brand.",
  ],
  logo: [
    "Create a logo for a coffee brand.",
    "Make a minimalist wordmark for a studio called 'Northwind'.",
  ],
  photo: [
    "Generate a dark, moody background photo for a tech brand.",
    "Create a warm texture background for a coffee brand.",
  ],
  component: [
    "Design a set of badge components for a premium product.",
    "Make a geometric divider graphic.",
  ],
  icon: [
    "Create a 4-icon set for a coffee menu.",
    "Generate minimal line icons for a settings panel.",
  ],
};

/** A short, card-aware prompt shown as placeholder text in the input. */
export function brandInputPlaceholder(card: BrandCardKey | null): string {
  if (!card) return "Message the agent…";
  const label = card.charAt(0).toUpperCase() + card.slice(1);
  return `Ask the AI about your ${label}…`;
}
