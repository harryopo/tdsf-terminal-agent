import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import { explorerSessionIdForTab } from "./explorerSession";

const terminal = (sshSessionId: string | null): Tab =>
  ({ kind: "terminal", sshSessionId }) as Tab;

const remoteEditor = (sessionId: string): Tab =>
  ({ kind: "editor", remote: { sessionId } }) as Tab;

describe("explorerSessionIdForTab — Explorer follows the displayed tab", () => {
  it("keeps a remote preview on its originating tab session, not the Space anchor", () => {
    expect(
      explorerSessionIdForTab(remoteEditor("s-host-b"), "s-host-b", "s-host-a"),
    ).toBe("s-host-b");
  });

  it("does not substitute the terminal/Space session for a different remote editor session", () => {
    expect(
      explorerSessionIdForTab(remoteEditor("s-host-b"), "s-tab", "s-host-a"),
    ).toBe("s-host-b");
    expect(
      explorerSessionIdForTab(remoteEditor("s-disconnected"), null, "s-space"),
    ).toBe("s-disconnected");
  });

  it("keeps local editor and explicitly local terminal on the local Explorer", () => {
    expect(explorerSessionIdForTab({ kind: "editor" } as Tab, null, "s-space")).toBeNull();
    expect(explorerSessionIdForTab(terminal(null), null, "s-space")).toBeNull();
  });

  it("uses the active terminal session and preserves Space fallback for other tabs", () => {
    expect(explorerSessionIdForTab(terminal("s-tab"), "s-tab", "s-space")).toBe("s-tab");
    expect(explorerSessionIdForTab({ kind: "preview" } as Tab, null, "s-space")).toBe("s-space");
    expect(explorerSessionIdForTab(null, null, "s-space")).toBe("s-space");
  });

  it("wires App to the tested selector instead of the old terminal-only fallback", () => {
    const app = readFileSync(join(process.cwd(), "src/app/App.tsx"), "utf8");
    expect(app).toMatch(
      /explorerSessionIdForTab\s*\(\s*activeTab,\s*activeTabSshSessionId,\s*spaceSshSessionId\s*,?\s*\)/,
    );
    expect(app).not.toMatch(/activeTerminalTab\s*\?\s*activeTabSshSessionId\s*:\s*spaceSshSessionId/);
  });
});
