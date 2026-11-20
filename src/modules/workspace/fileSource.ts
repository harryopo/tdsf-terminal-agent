import type { LocalWorkspaceEnv } from "./env";

export type FileSource = LocalWorkspaceEnv | { kind: "ssh"; sessionId: string };

export function fileSourceKey(source: FileSource | null): string | null {
  if (!source) return null;
  if (source.kind === "ssh") return `ssh:${source.sessionId}`;
  if (source.kind === "wsl") return `wsl:${source.distro}`;
  return "local";
}
