import type { Tab } from "@/modules/tabs/lib/useTabs";

export function explorerSessionIdForTab(
  activeTab: Tab | null | undefined,
  terminalSessionId: string | null,
  spaceSessionId: string | null,
): string | null {
  if (activeTab?.kind === "terminal") return terminalSessionId;
  if (activeTab?.kind === "editor") return activeTab.remote?.sessionId ?? null;
  return spaceSessionId;
}
