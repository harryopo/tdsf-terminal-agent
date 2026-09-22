/**
 * SshExplorerOffline.test.tsx —— #102 收尾：服务器工作区断话时左侧该说什么、能干什么
 *
 * 这个面板存在的理由：会话失效时左侧原本静默回退成本地文件树（用户报的"资源管理器
 * 串台"），而且除了 toast 之外没有任何重连入口。所以判据分两层：
 * ① 说清"是哪台、现在没连上"，并且**不**列出本地目录；
 * ② 就地能重连，且不能把"还在连"谎报成"重连失败"——重复点击会被 reconnectSshSpace
 *    的并发闸门吞掉（返回 null），面板若照单显示失败就是假信息。
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SshExplorerOffline } from "./SshExplorerOffline";

const base = {
  host: "10.0.0.8",
  port: 22,
  user: "root",
  connecting: false,
};

function renderPanel(
  over: typeof base & { onReconnect: () => Promise<string | null> },
) {
  return render(
    <SshExplorerOffline
      host={over.host}
      port={over.port}
      user={over.user}
      connecting={over.connecting}
      onReconnect={over.onReconnect}
    />,
  );
}

describe("SshExplorerOffline", () => {
  it("说清是哪台服务器，并给出重连入口", () => {
    renderPanel({ ...base, onReconnect: vi.fn() });
    expect(screen.getByText("root@10.0.0.8:22")).toBeTruthy();
    expect(screen.getByTestId("explorer-ssh-offline-reconnect")).toBeTruthy();
  });

  it("已经有一条连接在建立 → 不出现按钮，改说'正在重连…'", () => {
    // 配对：上面那条就是 connecting=false 时按钮确实在，防"元素压根没渲染"式假绿。
    renderPanel({ ...base, connecting: true, onReconnect: vi.fn() });
    expect(screen.queryByTestId("explorer-ssh-offline-reconnect")).toBeNull();
    expect(screen.getByTestId("explorer-ssh-offline-connecting")).toBeTruthy();
  });

  it("重连失败（resolve null）→ 明说失败，并且还能再点一次", async () => {
    const onReconnect = vi.fn().mockResolvedValue(null);
    renderPanel({ ...base, onReconnect });
    await act(async () => {
      fireEvent.click(screen.getByTestId("explorer-ssh-offline-reconnect"));
    });
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("explorer-ssh-offline-failed")).toBeTruthy();
    expect(screen.getByTestId("explorer-ssh-offline-reconnect")).toBeTruthy();
  });

  // #110：旧文案写"或在 SSH 面板重新登录"，而独立的 SSH 连接面板早就没有入口了
  // （侧栏视图枚举里没有 "ssh"，见 ROADMAP #109）—— 指一条不存在的路等于没说。
  it("失败文案只指界面上真有的入口，不许提「SSH 面板」", async () => {
    const onReconnect = vi.fn().mockResolvedValue(null);
    renderPanel({ ...base, onReconnect });
    await act(async () => {
      fireEvent.click(screen.getByTestId("explorer-ssh-offline-reconnect"));
    });
    const text = screen.getByTestId("explorer-ssh-offline-failed").textContent ?? "";
    expect(text).not.toContain("SSH 面板");
    expect(text).toContain("新建工作区");
  });

  it("重连成功 → 不报失败（成功由连接订阅接管改回远端树）", async () => {
    const onReconnect = vi.fn().mockResolvedValue("s-new");
    renderPanel({ ...base, onReconnect });
    await act(async () => {
      fireEvent.click(screen.getByTestId("explorer-ssh-offline-reconnect"));
    });
    expect(screen.queryByTestId("explorer-ssh-offline-failed")).toBeNull();
  });

  it("请求还在飞的时候连点两次，只发一次连接", async () => {
    let release: (v: string | null) => void = () => {};
    const onReconnect = vi.fn().mockImplementation(
      () => new Promise<string | null>((resolve) => (release = resolve)),
    );
    renderPanel({ ...base, onReconnect });
    const button = () => screen.getByTestId("explorer-ssh-offline-reconnect");
    fireEvent.click(button());
    // 第一次点击把 busy 立起来之后，按钮应让位给"正在重连…"，也就没有第二次入口
    expect(screen.queryByTestId("explorer-ssh-offline-reconnect")).toBeNull();
    await act(async () => {
      release("s-new");
    });
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("服务器地址里的端口跟着工作区身份走（不是写死的 22）", () => {
    renderPanel({ ...base, port: 2222, onReconnect: vi.fn() });
    expect(screen.getByText("root@10.0.0.8:2222")).toBeTruthy();
  });
});
