import { DEFAULT_SPACE_ID, type Tab } from "./useTabs";

export function isStartTab(t: Tab): boolean {
  return t.kind === "terminal" && t.cold === true && t.spaceId === DEFAULT_SPACE_ID;
}

/**
 * The label shown on a tab. Non-terminal tabs use their stored title; terminal
 * tabs prefer a user-set custom name, then fall back to the last segment of the
 * cwd. Keeping this pure makes the "custom name survives a cd" invariant
 * testable without rendering the bar.
 */
export function labelFor(t: Tab): string {
  if (t.kind === "editor") return t.title;
  if (t.kind === "preview") return t.title;
  if (t.kind === "markdown") return t.title;
  if (t.kind === "ai-diff") return t.title;
  if (t.kind === "git-diff") return t.title;
  if (t.kind === "git-history") return t.title;
  if (t.kind === "git-commit-file") return t.title;
  // Only the unowned cold placeholder is a start page; workspace shells can
  // remain cold until selected without changing their labels or spawning early.
  if (t.sshPending) return t.title;
  if (isStartTab(t)) return "开始";
  if (t.customTitle) return t.customTitle;
  if (!t.cwd) return t.title;
  const parts = t.cwd.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "/";
}
