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
    "Build step 1 of a bicycle wheel: create the rim as a torus (outer radius 0.4, minor radius 0.03). Delete the default Cube first. Take a viewport screenshot to verify.",
    "Build step 2: add the hub as a small cylinder in the center of the rim (radius 0.05, height 0.08). Take a viewport screenshot to verify.",
    "Build step 3: create one spoke as a thin cylinder connecting the hub to the rim at the 12 o'clock position. Take a viewport screenshot to verify the placement.",
    "Build step 4: duplicate the spoke around the wheel to create 12 evenly-spaced spokes. Take a viewport screenshot to verify.",
    "Build step 5: assemble the wheel — create an AssemblyRoot empty, parent the rim and hub to it, and parent all spokes to the hub. Use the parent_object tool. Take a viewport screenshot to verify.",
    "Build step 6: add materials — dark rubber for the rim, brushed metal for the hub and spokes. Take a viewport screenshot, then do a preview render to check the final look.",
  ],
};
