import type { WorkflowType } from "./registry";

/**
 * Clickable example prompts shown in the AgentPanel when a workflow lane is
 * active and the conversation is empty. The user clicks one to fill the input
 * (they still hit enter to send — this is user-initiated, not auto-seeded).
 *
 * Examples are concrete and varied so a user can see what kinds of asks the AI
 * handles for each workflow type.
 */
export const WORKFLOW_EXAMPLES: Record<WorkflowType, string[]> = {
  carousel: [
    "Create 5 Instagram slides about coffee culture.",
    "Generate a carousel from my brand brief.",
    "Make a 10-slide product feature carousel.",
    "Design a carousel for a weekend sale event.",
    "Create a 4-page presentation about our brand.",
    "Design an Instagram post series for our new product.",
  ],
};
