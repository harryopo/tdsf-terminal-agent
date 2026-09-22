// TDSF #102 收尾：SSH 工作区在会话失效时的左侧面板
// -----------------------------------------------------------------------------
// 代替"静默回退成本地文件树"。工作区的身份跨断线留着（#93），会话没了之后左侧原本
// 会列出本地 Windows 目录 —— 用户看到的正是"服务器工作区变成我的电脑"（资源管理器
// 串台）。这里明确说"这是哪台服务器、它现在没连上"，并就地给一个重连入口。
// 口径：重连只走 reconnectSshSpace 那一条路（保存过的凭据 + autoConnect），
// 本组件只负责状态呈现，不自己碰 sshStore。

import {
  CloudServerIcon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

type Props = {
  host: string;
  port: number;
  user: string;
  /**
   * 这台服务器已经有一条连接在建立（进入工作区时 #102 会自动重连一次）。
   * 此时按钮不出现：重复请求会被 reconnectSshSpace 的并发闸门吞掉并返回 null，
   * 面板就会把"还在连"谎报成"重连失败"。
   */
  connecting: boolean;
  /** 发起一次重连：resolve 新会话 id，连不上 resolve null（toast 由调用方负责）。 */
  onReconnect: () => Promise<string | null>;
};

export function SshExplorerOffline({
  host,
  port,
  user,
  connecting,
  onReconnect,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = busy || connecting;

  const handleClick = async () => {
    if (inFlight) return;
    setBusy(true);
    setFailed(false);
    try {
      const sessionId = await onReconnect();
      setFailed(sessionId === null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="explorer-ssh-offline"
      className="flex h-full min-h-0 flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <div className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
        <HugeiconsIcon
          icon={CloudServerIcon}
          size={14}
          strokeWidth={1.75}
          className="text-muted-foreground"
        />
        服务器未连接
      </div>
      <div className="font-mono text-[11px] text-muted-foreground">
        {user}@{host}:{port}
      </div>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        文件树需要这条 SSH 连接。这里不显示本地目录，是为了不让人误以为在看服务器。
      </p>
      {inFlight ? (
        <div
          data-testid="explorer-ssh-offline-connecting"
          className="mt-1 flex items-center gap-2 text-[12px] text-muted-foreground"
        >
          <HugeiconsIcon
            icon={Loading03Icon}
            size={13}
            strokeWidth={1.75}
            className="animate-spin"
          />
          正在重连…
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void handleClick()}
          data-testid="explorer-ssh-offline-reconnect"
          className="mt-1 rounded-md border border-border bg-card px-3 py-1.5 text-[12px] text-foreground transition-colors hover:bg-muted"
        >
          重新连接
        </button>
      )}
      {failed ? (
        <div
          data-testid="explorer-ssh-offline-failed"
          className="text-[11px] leading-relaxed text-destructive"
        >
          重连失败：确认服务器可达后再试一次，或在 SSH 面板重新登录。
        </div>
      ) : null}
    </div>
  );
}
