"use client";

import { createContext, useContext } from "react";

/**
 * Allows a workflow canvas to signal that a background generation is running,
 * so the AgentPanel can disable its chat input to prevent interference (e.g.
 * the user asking the agent to assemble while a clip is still generating).
 *
 * The Video Studio uses this because its generation runs fire-and-forget via a
 * deterministic script — the agent chat is unaware of it, so without this
 * signal the user could trigger conflicting actions through chat.
 *
 * Other workflows (carousel) don't need this because their generation flows
 * through the agent chat itself (chat.busy already gates the input).
 */

export interface GenerationBusyValue {
  /** True when a background generation script is running. */
  busy: boolean;
  /** Human-readable reason shown in the disabled input. */
  reason?: string;
}

export const GenerationBusyContext = createContext<GenerationBusyValue>({ busy: false });

export function useGenerationBusy(): GenerationBusyValue {
  return useContext(GenerationBusyContext);
}
