import { useSpaces } from "@/modules/spaces";
import { LOCAL_WORKSPACE, type LocalWorkspaceEnv } from "@/modules/workspace";
import { fileSourceKey, type FileSource } from "@/modules/workspace/fileSource";

/** Old tabs may derive their source only from their own space, never the active one. */
export function editorWorkspace(tab: {
  spaceId: string;
  workspace?: LocalWorkspaceEnv | null;
}): LocalWorkspaceEnv | null {
  if (tab.workspace !== undefined) return tab.workspace;
  if (tab.spaceId === "default") return LOCAL_WORKSPACE;
  const env = useSpaces.getState().spaces.find(s => s.id === tab.spaceId)?.env;
  if (!env) return null;
  return env.kind === "ssh" ? LOCAL_WORKSPACE : env;
}

export function editorMatchesSource(tab: {
  spaceId: string;
  workspace?: LocalWorkspaceEnv | null;
  remote?: { sessionId: string } | null;
}, source: FileSource | null): boolean {
  const owner = tab.remote ? { kind: "ssh" as const, sessionId: tab.remote.sessionId } : editorWorkspace(tab);
  const key = fileSourceKey(source);
  return key !== null && key === fileSourceKey(owner);
}
