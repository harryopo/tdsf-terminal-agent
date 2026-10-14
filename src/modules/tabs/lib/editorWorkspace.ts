import { useSpaces } from "@/modules/spaces";
import { LOCAL_WORKSPACE, type LocalWorkspaceEnv } from "@/modules/workspace";

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
