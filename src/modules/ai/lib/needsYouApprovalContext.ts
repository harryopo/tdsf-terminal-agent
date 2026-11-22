import { createContext, useContext, type ReactNode } from "react";

// Presentation only: the owner still subscribes, hydrates and responds once.
export const NeedsYouApprovalContext = createContext<{
  registerTool: (toolCallId: string, toolName: string, slotId: string) => () => void;
  inline: { toolCallId: string; slotId: string; card: ReactNode } | null;
  fallback: ReactNode;
} | null>(null);

export function NeedsYouApprovalFallback() {
  return useContext(NeedsYouApprovalContext)?.fallback ?? null;
}
