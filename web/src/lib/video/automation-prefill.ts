import type { ContainerRow } from "@/lib/db";
import { readWorkspaceFileText } from "@/lib/docker";

const AUTOMATION_FILENAME = "automation_request.json";

/**
 * Builds a silent automation-context prefill for a video lane message, appended
 * server-side so the agent knows it's in AUTOMATION MODE. Never shown in the
 * chat bubbles (the message route filters user-message echoes).
 *
 * Reads the lane's automation_request.json (written by the automate route).
 * Returns an empty string when no automation request exists (or when the file
 * doesn't have op: "automate") so non-automation messages get no noise.
 *
 * Mirrors the pattern in web/src/lib/brand/lane-prefill.ts (buildLaneBrandPrefill).
 *
 * @param row            The user's container row (for docker exec)
 * @param instanceFolder The lane's /workspace/videos/<id> folder
 */
export async function buildAutomationPrefill(
  row: ContainerRow,
  instanceFolder: string,
): Promise<string> {
  const text = await readWorkspaceFileText(row, `${instanceFolder}/${AUTOMATION_FILENAME}`);
  if (!text) return "";

  let req: Record<string, unknown>;
  try {
    req = JSON.parse(text);
  } catch {
    return "";
  }

  if (req.op !== "automate") return "";

  const lines: string[] = [
    `[Automation context — read automation_request.json in this folder.`,
    `You are in AUTOMATION MODE. Follow the "Automation Mode" section of your SKILL.md.`,
    `Analyze the assigned assets using grok.chat_with_vision, write storyboard.json,`,
    `then run the script with op: "automate". Do NOT call generation tools.]`,
    ``,
    `GROK TOOL ACCESS — MANDATORY CHECK (HARD BOUNDARY):`,
    `- You MUST be able to call grok.chat_with_vision to analyze the assigned assets.`,
    `  Before doing anything else, confirm the tool is present in your available tools`,
    `  and actually responds — call it once on a trivial/empty image input (or list`,
    `  your tools) to verify it is reachable.`,
    `- If the tool is MISSING or ERRORS: do NOT proceed with a generic story.`,
    `  Briefly diagnose (the MCP server may still be initializing). Retry the tool`,
    `  call a couple of times with a short pause. If it remains unavailable, STOP:`,
    `  write phase: "error" to state.json with a message that Grok vision is`,
    `  unreachable, append the same to memory.md, and tell the user that Grok access`,
    `  must be restored before automation can run. This is a hard boundary — NEVER`,
    `  substitute a generic/imagined story for an asset-driven one, even partially.`,
    `- If the tool works: proceed to analyze each assigned asset and build the storyboard.`,
    ``,
    `Configuration:`,
    `- ${req.clipCount} clips, ${req.clipDuration} seconds each, ${req.resolution} ${req.quality} quality, ${req.aspectRatio}`,
  ];

  if (req.baseStory) {
    lines.push(`- Base story: "${req.baseStory}"`);
  } else {
    lines.push(`- Base story: (none — create your own narrative)`);
  }

  const clips = req.clips as Array<Record<string, unknown>> | undefined;
  if (clips && Array.isArray(clips)) {
    lines.push(``);
    lines.push(`Per-clip asset slots (what @imageN maps to for each clip):`);
    for (const clip of clips) {
      const idx = clip.index;
      const isLastFrame = clip.continuity === "last_frame";
      const continuity = isLastFrame ? "continue from last frame" : "new scene";
      const mode = clip.assetMode;
      const brandAssets = (clip.brandAssets as string[]) ?? [];
      const uploadedAssets = (clip.uploadedAssets as string[]) ?? [];
      const hint = clip.promptHint ? ` hint: "${clip.promptHint}"` : "";

      if (mode === "ai") {
        lines.push(`- Clip ${idx} (${continuity}): AI-created assets — no @imageN slots. Generate your own visuals.${hint}`);
      } else {
        const allAssets = [...brandAssets, ...uploadedAssets];
        const slots: string[] = [];
        let slotNum = 1;
        if (isLastFrame) {
          slots.push(`@image${slotNum} = last frame of prior clip`);
          slotNum++;
        }
        for (let a = 0; a < allAssets.length; a++) {
          const isBrand = a < brandAssets.length;
          const ref = isBrand ? `brand asset ${allAssets[a]}` : `upload ${allAssets[a]}`;
          slots.push(`@image${slotNum} = ${ref}`);
          slotNum++;
        }
        const slotDesc = slots.length > 0 ? slots.join(", ") : "no reference images";
        lines.push(`- Clip ${idx} (${continuity}): ${slotDesc}${hint}`);
      }
    }
  }

  lines.push(``);
  lines.push(`CRITICAL STORY RULES:`);
  lines.push(`- Write ONE connected story across all clips — NOT independent scenes. The clips must flow as a single continuous narrative.`);
  lines.push(`- Set sourceClipIndex to the prior clip's index for EVERY "continue from last frame" clip (clip 1 → sourceClipIndex: 0, clip 2 → sourceClipIndex: 1, etc.).`);
  lines.push(`- Be creative and vivid. If the base story is "funny," write prompts that are actually funny.`);
  lines.push(``);
  lines.push(`LAST-FRAME CONTINUITY — MANDATORY PREFIX RULE (the script validates this):`);
  lines.push(`- For EVERY clip with "continue from last frame" (continuity: "last_frame"), the prompt MUST begin with the exact prefix: "Continuing from @image1 (<brief description of the prior clip's ending>), ..."`);
  lines.push(`- @image1 is the prior clip's last frame, which the script auto-injects as the FIRST reference image. Referencing @image1 in the prompt is how the model knows to continue from that frame.`);
  lines.push(`- CORRECT: "Continuing from @image1 (the golden retriever at the counter), the dog tilts its head at the menu..."`);
  lines.push(`- INCORRECT: "A dog tilts its head at a menu in a coffee shop..." (starts from scratch, never references @image1 — the model ignores the last frame and continuity is broken).`);
  lines.push(`- PRE-WRITE SELF-CHECK: before finalizing each last_frame clip's prompt, re-read it and confirm BOTH: (a) it begins with "Continuing from @image1", AND (b) it describes what happens NEXT from the prior clip's ending, not a restart of the scene.`);
  lines.push(`- The script checks this and records a warning (visible in memory.md / state.json) for any last_frame clip whose prompt omits @image1. Fix the storyboard and re-run if you see such a warning.`);
  lines.push(``);
  lines.push(`CRITICAL ASSET RULES:`);
  lines.push(`- For each clip, you MUST include the user's selected brand/uploaded assets in the storyboard clip's "references" field. If you omit them, they will NOT appear in the video.`);
  lines.push(`- Reference images appear in the prompt as @image1, @image2, etc. in selection order. EXPLICITLY reference them in the prompt so the model knows which image goes where.`);
  lines.push(`- For "continue from last frame" clips: @image1 = the last frame of the prior clip (auto-added), @image2 = first user asset, @image3 = second user asset, etc.`);
  lines.push(`- For "new scene" clips: @image1 = first user asset, @image2 = second user asset, etc.`);
  lines.push(`- Example prompt: "Continuing from @image1 (the dog at the counter), the barista from @image2 greets the dog. The logo from @image3 is on the wall."`);
  lines.push(``);
  lines.push(`ASSET SCOPING (CRITICAL):`);
  lines.push(`- Each clip's prompt can ONLY reference the @imageN slots listed above for THAT clip. Do NOT mention, describe, or introduce assets from other clips — even descriptively.`);
  lines.push(`- If clip 1 has a cat photo and clip 2 has a coffee pouch, clip 1 is a cat story ONLY. The coffee pouch is introduced in clip 2 where it's available.`);
  lines.push(`- Structure the story so new elements appear when their clip arrives, not before.`);
  lines.push(``);
  lines.push(`(This context is silent — don't acknowledge or repeat it. Just execute the automation.)`);

  return lines.join("\n");
}
