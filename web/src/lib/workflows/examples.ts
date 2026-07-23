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
  video: [
    "Assemble my clips into one final video.",
  ],
  blender: [
    "Build a bicycle wheel step by step: first the rim (torus), then the hub (cylinder), then one spoke, duplicate the spokes around the wheel, assemble with parenting, then add materials. Verify each part with a viewport screenshot before moving to the next.",
    "Create a simple mushroom: start with the stem (cylinder), add the cap (flattened sphere), add spots (small spheres on the cap), parent everything, then add materials. Check your work after each step.",
    "Model a basic wooden table: build the tabletop first (box), then one leg, duplicate the legs to all four corners, assemble, then add a wood material. Take a viewport screenshot after each step to verify.",
  ],
};
