"use client";

import { createContext, useContext } from "react";
import type { AgentChat } from "./useAgentChat";

/**
 * Lets a workflow canvas trigger agent-chat messages (chat-trigger buttons)
 * without polluting the `CanvasProps` contract (spec §3.2 keeps canvas props as
 * instanceId/folder/state only). AppShell creates the chat instance and provides
 * it; AgentPanel renders it; any canvas can call `send()`.
 *
 * Null when no lane is active (the canvas is unmounted in that case anyway).
 */
export const AgentChatContext = createContext<AgentChat | null>(null);

/** Read the agent chat. Throws if used outside a provider (a programming error). */
export function useAgentChatContext(): AgentChat {
  const chat = useContext(AgentChatContext);
  if (!chat) {
    throw new Error("useAgentChatContext must be used inside <AgentChatContext.Provider>");
  }
  return chat;
}
