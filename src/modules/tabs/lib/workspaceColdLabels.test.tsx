import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TabIcon } from "../TabBar";
import { labelFor } from "./tabLabel";
import type { Tab, TerminalTab } from "./useTabs";

function terminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 1,
    kind: "terminal",
    spaceId: "default",
    title: "shell",
    paneTree: { kind: "leaf", id: 2 },
    activeLeafId: 2,
    ...overrides,
  };
}

function iconMarkup(tab: Tab): string {
  const { container } = render(<TabIcon tab={tab} />);
  const svg = container.querySelector("svg");
  expect(svg).not.toBeNull();
  return svg!.outerHTML;
}

afterEach(cleanup);

describe("cold terminal labels inside workspaces", () => {
  it("keeps the default-space cold terminal as the start page", () => {
    expect(labelFor(terminalTab({ cold: true }))).toBe("开始");
  });

  it("uses the ordinary shell label for a cold workspace terminal", () => {
    expect(
      labelFor(
        terminalTab({
          spaceId: "workspace-1",
          cold: true,
          title: "shell",
          customTitle: "shell",
          cwd: "/home/alice/project",
        }),
      ),
    ).toBe("shell");

    expect(
      labelFor(
        terminalTab({
          spaceId: "workspace-1",
          cold: true,
          title: "terminal",
          cwd: "/home/alice/project",
        }),
      ),
    ).toBe("project");
  });

  it.each([
    ["local", "workspace-local"],
    ["WSL", "workspace-wsl"],
  ])("does not classify a deferred cold %s shell as the start page", (_kind, spaceId) => {
    expect(
      labelFor(
        terminalTab({
          spaceId,
          cold: true,
          title: "shell",
        }),
      ),
    ).toBe("shell");
  });

  it("preserves non-terminal titles and does not change tab identity or cold state", () => {
    const nonTerminal = {
      id: 9,
      kind: "editor",
      spaceId: "workspace-1",
      cold: true,
      title: "notes.md",
      path: "/home/alice/notes.md",
      dirty: false,
      preview: false,
    } satisfies Tab;
    const coldTerminal = terminalTab({
      id: 10,
      spaceId: "workspace-1",
      cold: true,
    });

    expect(labelFor(nonTerminal)).toBe("notes.md");
    expect(labelFor(coldTerminal)).toBe("shell");
    expect(coldTerminal).toMatchObject({ id: 10, cold: true });
  });

  it("uses the terminal icon for workspace cold tabs, while default cold keeps the start icon", () => {
    const workspaceCold = terminalTab({
      spaceId: "workspace-1",
      cold: true,
    });
    const workspaceWarm = terminalTab({
      spaceId: "workspace-1",
    });
    const defaultCold = terminalTab({ cold: true });

    expect(iconMarkup(workspaceCold)).toBe(iconMarkup(workspaceWarm));
    expect(iconMarkup(defaultCold)).not.toBe(iconMarkup(workspaceWarm));
  });
});
