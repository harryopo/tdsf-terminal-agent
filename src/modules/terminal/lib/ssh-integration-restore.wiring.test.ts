import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("SSH restoration production seams", () => {
  it("guards the real leaf without queueing input or clearing the user line", () => {
    const text = readFileSync("src/modules/terminal/lib/useTerminalSession.ts", "utf8");
    expect(text.includes("export function restoreSshIntegration(")).toBe(true);
    expect(text.includes("isUserLineDirty(leafId)")).toBe(true);
    expect(text.includes("s.restoreCancel")).toBe(true);
    expect(text.includes("signal: controller.signal")).toBe(true);
    expect(text.includes("s.remoteContext?.connectionId === expectedConnectionId")).toBe(true);
  });
  it("only mounts the shortcut on the visible focused SSH pane", () => {
    const text = readFileSync("src/modules/terminal/PaneTreeView.tsx", "utf8");
    expect(text.includes("<SshIntegrationBadge")).toBe(true);
    expect(text.includes("active={paneProps.visible && paneProps.focused}")).toBe(true);
  });
  it("labels the file connection using the actual SFTP source session", () => {
    const text = readFileSync("src/modules/explorer/FileExplorer.tsx", "utf8");
    expect(text.includes('<SshFileIdentity sessionId={fsSource.sessionId} />')).toBe(true);
  });
});
