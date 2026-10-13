import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useSshStore, type SshSessionInfo } from "./sshStore";
import { SshCarapaceBadge } from "./SshCarapaceBadge";
import { SshIntegrationBadge } from "./SshIntegrationBadge";

const seams = vi.hoisted(() => ({
  getContext: vi.fn(),
  restore: vi.fn(),
  install: vi.fn(),
}));

vi.mock("@/modules/terminal/lib/useTerminalSession", () => ({
  getSshIntegrationContext: seams.getContext,
  restoreSshIntegration: seams.restore,
}));

vi.mock("@/lib/param-complete-client", () => ({
  installRemoteCarapace: seams.install,
}));

const sessionId = "zoom-test-session";
const session: SshSessionInfo = {
  id: sessionId,
  rustSessionId: 200,
  params: {
    host: "server.test",
    port: 22,
    user: "fixture",
    cols: 80,
    rows: 24,
    term: "xterm-256color",
  },
  state: "connected",
  connectedAt: 1,
  handle: {
    id: 200,
    write: vi.fn().mockResolvedValue(undefined),
    resize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  },
};

let savedPreferences: ReturnType<typeof usePreferencesStore.getState>;
let savedSshState: ReturnType<typeof useSshStore.getState>;

beforeEach(() => {
  seams.getContext.mockReset().mockReturnValue({
    connectionId: "0123456789abcdef0123456789abcdef",
    bashHooksPath: "/fixture/hooks.bash",
  });
  seams.restore
    .mockReset()
    .mockResolvedValue({ user: "fixture", cwd: "/home/fixture" });
  seams.install.mockReset().mockResolvedValue(true);

  savedPreferences = usePreferencesStore.getState();
  savedSshState = useSshStore.getState();
  usePreferencesStore.setState({
    ...savedPreferences,
    zoomLevel: 1,
    sshRemoteCarapacePrompt: true,
  });
  useSshStore.setState({
    ...savedSshState,
    activeSessionId: sessionId,
    sessions: [session],
    remoteCarapaceBySession: { [sessionId]: "missing" },
  });
});

afterEach(() => {
  cleanup();
  usePreferencesStore.setState(savedPreferences, true);
  useSshStore.setState(savedSshState, true);
});

function buttons() {
  render(
    <div>
      <SshIntegrationBadge leafId={4} sessionId={sessionId} active />
      <SshCarapaceBadge sessionId={sessionId} />
    </div>,
  );
  return {
    integration: screen.getByRole("button", { name: "终端集成" }),
    carapace: screen.getByTitle("启用远端动态补全"),
  };
}

describe("SSH badge zoom hit targets", () => {
  it.each([
    [1, 24],
    [0.9, 27],
    [0.5, 48],
    [1.5, 24],
  ])("renders literal square targets at zoom %s", (zoom, size) => {
      act(() => usePreferencesStore.setState({ zoomLevel: zoom }));
      const { integration, carapace } = buttons();
      for (const button of [integration, carapace]) {
        expect(button.style.width).toBe(`${size}px`);
        expect(button.style.height).toBe(`${size}px`);
      }
      expect(integration.style.right).toBe(`${size + 16}px`);
      expect(carapace.className).toContain("right-2");
  });

  it("updates both mounted hit targets when the real preferences store zoom changes", () => {
    const { integration, carapace } = buttons();
    expect(integration.style.width).toBe("24px");
    expect(carapace.style.width).toBe("24px");

    act(() => usePreferencesStore.setState({ zoomLevel: 0.5 }));

    expect(integration.style.width).toBe("48px");
    expect(integration.style.height).toBe("48px");
    expect(integration.style.right).toBe("64px");
    expect(carapace.style.width).toBe("48px");
    expect(carapace.style.height).toBe("48px");
    expect(carapace.className).toContain("right-2");
  });

  it("keeps the hit target rectangular and paints the circular badge on its child span", () => {
    const { integration, carapace } = buttons();
    for (const button of [integration, carapace]) {
      expect(button.className).not.toMatch(/(?:^|\s)rounded-full(?:\s|$)/);
      expect(button.className).not.toMatch(/(?:^|\s)border(?:\s|\/)/);
      expect(button.className).not.toMatch(/(?:^|\s)bg-background(?:\S*)/);
      const circle = button.firstElementChild;
      expect(circle?.tagName).toBe("SPAN");
      expect(circle?.className).toContain("rounded-full");
      expect(circle?.className).toContain("size-full");
    }
  });

  it("preserves connected/active, missing-carapace, and prompt preference gates", () => {
    const { rerender } = render(
      <SshIntegrationBadge leafId={4} sessionId={sessionId} active={false} />,
    );
    expect(screen.queryByRole("button", { name: "终端集成" })).toBeNull();
    act(() =>
      useSshStore.setState({ sessions: [{ ...session, state: "closed" }] }),
    );
    rerender(<SshIntegrationBadge leafId={4} sessionId={sessionId} active />);
    expect(screen.queryByRole("button", { name: "终端集成" })).toBeNull();
    act(() => useSshStore.setState({ sessions: [session] }));
    rerender(<SshIntegrationBadge leafId={4} sessionId={sessionId} active />);
    expect(screen.getByRole("button", { name: "终端集成" })).toBeTruthy();

    const { unmount } = render(<SshCarapaceBadge sessionId={sessionId} />);
    expect(screen.getByTitle("启用远端动态补全")).toBeTruthy();
    act(() =>
      useSshStore.setState({
        remoteCarapaceBySession: { [sessionId]: "installed" },
      }),
    );
    expect(screen.queryByTitle("启用远端动态补全")).toBeNull();
    act(() =>
      useSshStore.setState({
        remoteCarapaceBySession: { [sessionId]: "missing" },
      }),
    );
    act(() => usePreferencesStore.setState({ sshRemoteCarapacePrompt: false }));
    expect(screen.queryByTitle("启用远端动态补全")).toBeNull();
    act(() => usePreferencesStore.setState({ sshRemoteCarapacePrompt: true }));
    act(() =>
      useSshStore.setState({ sessions: [{ ...session, rustSessionId: null }] }),
    );
    expect(screen.queryByTitle("启用远端动态补全")).toBeNull();
    unmount();
  });

  it("opens both badges read-only without restoring integration or installing carapace", () => {
    const { integration, carapace } = buttons();
    fireEvent.click(integration);
    expect(
      screen.getByText(/文件与后台工具仍使用原 SSH 认证身份/),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "恢复当前终端集成" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(seams.getContext).toHaveBeenCalledWith(4);
    expect(seams.restore).not.toHaveBeenCalled();

    fireEvent.click(carapace);
    expect(screen.getByText(/远端服务器未安装 carapace/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "安装" })).toBeTruthy();
    expect(seams.install).not.toHaveBeenCalled();
  });
});
