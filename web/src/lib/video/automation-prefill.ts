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
    for (const clip of clips) {
      const idx = clip.index;
      const continuity = clip.continuity === "last_frame" ? "continue from last frame" : "new scene";
      const mode = clip.assetMode;
      const brandAssets = (clip.brandAssets as string[]) ?? [];
      const uploadedAssets = (clip.uploadedAssets as string[]) ?? [];
      const hint = clip.promptHint ? ` hint: "${clip.promptHint}"` : "";

      let assetDesc: string;
      if (mode === "ai") {
        assetDesc = "AI-created assets (generate your own to fit the story)";
      } else {
        const parts: string[] = [];
        if (brandAssets.length > 0) parts.push(`brand [${brandAssets.join(", ")}]`);
        if (uploadedAssets.length > 0) parts.push(`uploads [${uploadedAssets.join(", ")}]`);
        assetDesc = parts.join(", ") || "none";
      }

      lines.push(`- Clip ${idx}: ${continuity}, ${assetDesc}${hint}`);
    }
  }

  lines.push(``);
  lines.push(`(This context is silent — don't acknowledge or repeat it. Just execute the automation.)`);

  return lines.join("\n");
}
