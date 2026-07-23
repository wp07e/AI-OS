import type { WorkflowType } from "./registry";

/**
 * Clickable example prompts shown in the AgentPanel when a workflow lane is
 * active and the conversation is empty. The user clicks one to fill the input
 * (they still hit enter to send — this is user-initiated, not auto-seeded).
 *
 * Examples are concrete and varied so a user can see what kinds of asks the AI
 * handles for each workflow type.
 */

export interface BuildStep {
  /** Stable id for matching against sent messages and step tracking. */
  id: string;
  /** Short label for the stepper UI. */
  label: string;
  /** The full prompt text (also shown as the example button in empty state). */
  prompt: string;
  /**
   * A distinctive substring used to detect whether this step has been sent,
   * even if the user pasted/edited the text rather than clicking the button.
   */
  matchKey: string;
}

/**
 * The blender lane's build steps form an ordered progressive-build tutorial
 * (rim → hub → spoke → duplicate → assemble → materials). Clicking a step opts
 * the user into the tutorial stepper; sending an unrelated message opts out.
 */
export const BLENDER_BUILD_STEPS: BuildStep[] = [
  {
    id: "rim",
    label: "Rim",
    prompt: "Build step 1 of a bicycle wheel: create the rim as a torus — a wide, thin ring (think the outer hoop of a real bicycle wheel). Delete the default Cube first. Take a viewport screenshot to verify.",
    matchKey: "Build step 1",
  },
  {
    id: "hub",
    label: "Hub",
    prompt: "Build step 2: add the hub as a short, fat cylinder sitting in the center of the rim (much smaller than the rim, like the axle housing on a real wheel). Take a viewport screenshot to verify.",
    matchKey: "Build step 2",
  },
  {
    id: "spoke",
    label: "Spoke",
    prompt: "Build step 3: create one spoke as a long, thin cylinder bridging from the hub up to the rim at the 12 o'clock position. It should reach the rim without overlapping it. Take a viewport screenshot to verify the placement.",
    matchKey: "Build step 3",
  },
  {
    id: "duplicate-one",
    label: "Duplicate",
    prompt: "Build step 4: rotate-duplicate the spoke once to the next position (30 degrees clockwise, one twelfth of a full turn around the hub). Take a viewport screenshot to verify the new spoke is vertical, perpendicular to the hub, and not tilted or offset before continuing.",
    matchKey: "Build step 4",
  },
  {
    id: "duplicate-all",
    label: "Fan out",
    prompt: "Build step 5: now repeat that same rotation to fill the wheel with 12 evenly-spaced spokes total (the original plus 11 copies). Take a viewport screenshot to verify all spokes are straight and evenly spaced.",
    matchKey: "Build step 5",
  },
  {
    id: "assemble",
    label: "Assemble",
    prompt: "Build step 6: assemble the wheel — create an AssemblyRoot empty, parent the rim and hub to it, and parent all spokes to the hub. Use the parent_object tool. Take a viewport screenshot to verify.",
    matchKey: "Build step 6",
  },
  {
    id: "materials",
    label: "Materials",
    prompt: "Build step 7: add materials — dark rubber for the rim, brushed metal for the hub and spokes. Take a viewport screenshot, then do a preview render to check the final look.",
    matchKey: "Build step 7",
  },
];

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
  blender: BLENDER_BUILD_STEPS.map((s) => s.prompt),
};
