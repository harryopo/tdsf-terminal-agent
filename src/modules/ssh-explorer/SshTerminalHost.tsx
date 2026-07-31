/**
 * SshTerminalHost.tsx — TDSF 魔改 (#18): SSH 终端宿主组件，走本地 rendererPool
 * -----------------------------------------------------------------------------
 * 替代 SshTerminalPane.tsx（魔改另起的裸 xterm），让 SSH 终端成为真正的
 * TerminalPane leaf，由 useTerminalSession + rendererPool 统一渲染：
 *   - 自动获得与本地终端一致的主题/字体/字号/对比度
 *   - 自动继承 rendererPool 的保活（切 tab 用 visibility:hidden 不 dispose）
 *   - 与本地 leaf 不撞号（allocId 共享 useTabs.nextIdRef 计数器）
 *
 * 依赖倒置 transport seam：
 *   - openTransport 工厂由本组件提供，注入 useTerminalSession
 *   - 本地路径零改动（terminal 模块不反向依赖 ssh-explorer）
 *
 * SSH transport 实现：
 *   - onData = subscribeTerminalData(sessionId, cb)
 *     （sshStore 的 fan-out + 先到数据缓冲，修复"连接就绪早于组件挂载"竞态）
 *   - write/resize = session.handle.write/resize
 *     （handle 由 sshStore.connect 在 connect 成功后填充，可能晚于组件挂载；
 *      handleRef 同步最新值，write/resize 调用时读 ref，handle 未到则 no-op）
 *   - close = 只 unsubscribe 前端订阅，不断底层 SSH 连接
 *     （SFTP 文件树共用同一条 SSH 连接，断连会废掉 SFTP）
 *
 * 与本地终端的差异（remote=true 护栏）：
 *   - 跳过 pty_has_foreground_job/process invoke（无对应 Rust 命令）
 *   - kickPty 不做 SIGWINCH +1 bump（本地 ConPTY/Linux trick，远程不适用）
 *   - respawnSession 不本地重启（远端 shell 退出应由 sshStore 重连处理）
 *   - blocks=false（远端 shell 不一定有 OSC 133 shell integration）
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { TerminalPane } from "@/modules/terminal/TerminalPane";
import type { TerminalTransport } from "@/modules/terminal/lib/pty-bridge";
import { disposeSession } from "@/modules/terminal/lib/useTerminalSession";
import { useSshStore } from "./sshStore";

// TDSF 诊断 (Phase 2): 集中 OSC 7 cwd 同步调试日志，避免污染控制台。
// 通过 window.__TDSF_OSC7_LOG__ 收集，CDP 实测可读取。
type Osc7LogEntry = Record<string, unknown>;

declare global {
  interface Window {
    __TDSF_OSC7_LOG__?: Osc7LogEntry[];
  }
}

function getOsc7Log(): Osc7LogEntry[] | null {
  if (typeof window === "undefined") return null;
  if (!window.__TDSF_OSC7_LOG__) window.__TDSF_OSC7_LOG__ = [];
  return window.__TDSF_OSC7_LOG__;
}

type Props = {
  /** SSH 会话前端 UUID（sshStore.sessions[].id） */
  sessionId: string;
  /**
   * 分配稳定 leafId 的函数（来自 useTabs.allocId）。
   * 与本地 leaf 共享同一计数器，避免撞号；一次分配后在组件生命周期内不变。
   */
  allocId: () => number;
  /** 外层容器 className（border / rounded / overflow 等） */
  className?: string;
  /**
   * 2026-07-31 翻译模块修复: 挂载时上报分配的 leafId，让 App 层
   * captureActiveSelection 能感知 SSH 终端的 leafId（SSH 终端不在
   * tab.paneTree 里，tab.activeLeafId 指向本地终端，无法选中 SSH 文本）。
   */
  onLeafId?: (leafId: number) => void;
};

export function SshTerminalHost({ sessionId, allocId, className, onLeafId }: Props) {
  // 挂载时分配稳定 leafId，整个组件生命周期内不变（不放进 deps 防重订阅）
  const leafIdRef = useRef<number | null>(null);
  if (leafIdRef.current === null) {
    leafIdRef.current = allocId();
    // 上报给 App 层（用于翻译/AI 选中捕获）
    onLeafId?.(leafIdRef.current);
  }
  const leafId = leafIdRef.current;

  // 订阅 SSH 会话状态（用于诊断；onExit 走 PTY channel，不靠 state 派生）
  const session = useSshStore((s) =>
    s.sessions.find((it) => it.id === sessionId),
  );
  const subscribeTerminalData = useSshStore((s) => s.subscribeTerminalData);

  // handle 用 ref 持有最新值：handle 由 sshStore.connect 在 connect 成功后填充，
  // 可能晚于组件挂载；openTransport 闭包通过 ref 读最新 handle，避免拿 null。
  const handleRef = useRef(session?.handle ?? null);
  handleRef.current = session?.handle ?? null;

  // TDSF 修复 2026-07-31 (Phase 2): SSH 终端 OSC 7 解析后同步远程 cwd。
  // TerminalPane 的 onCwd 走 useTerminalSession → registerCwdHandler；对远程会话
  // 我们关闭 in-command 守卫，因此 SshTerminalHost 注入的 OSC 7 会被直接接收。
  const handleCwd = useCallback(
    (_leafId: number, cwd: string) => {
      const log = getOsc7Log();
      log?.push({ source: "SshTerminalHost.handleCwd", sessionId, cwd });
      useSshStore.getState().setCurrentPath(sessionId, cwd);
    },
    [sessionId],
  );

  // TDSF 修复 2026-07-31 (Phase 2): SSH 终端 cd cwd 同步兜底。
  // 远端 shell 未必配置了 OSC 7 shell integration；我们在本层拦截简单的
  // `cd <dir>` 命令，追加一个 printf 让远端 shell 主动发出 OSC 7 序列，
  // xterm 解析后触发 registerCwdHandler → SshTerminalHost.handleCwd →
  // sshStore.setCurrentPath，左侧远程资源管理器即可跟随刷新。
  const inputBufferRef = useRef("");

  // openTransport 工厂：构建 SSH transport 注入 useTerminalSession
  // 仅依赖 sessionId + subscribeTerminalData（都是稳定引用），不重创建
  const openTransport = useMemo(() => {
    return (h: {
      onData: (b: Uint8Array) => void;
      onExit: (c: number) => void;
    }): Promise<TerminalTransport> => {
      // 订阅 PTY 输出：sshStore 的 fan-out + 先到数据缓冲
      // （挂载即 flush 缓冲，修复"连接就绪早于组件挂载导致前 N 字节丢失"竞态）
      const unsubscribe = subscribeTerminalData(sessionId, h.onData);

      const transport: TerminalTransport = {
        // 字符串 id 与本地 PTY 数字 id 区分（日志/诊断用）
        id: sessionId,
        write: (data: string) => {
          const log = getOsc7Log();
          const handle = handleRef.current;
          // handle 还没到（连接中）或已断开：丢弃写入，避免抛错
          // （用户在 MOTD 之前的输入会进 pendingInput，由 useTerminalSession 在 pty 就绪后 flush）
          if (!handle) {
            log?.push({ source: "SshTerminalHost.transport.write", data, matched: false });
            return;
          }

          // 追加到行缓冲，用于识别完整的 cd 命令
          inputBufferRef.current += data;
          const buf = inputBufferRef.current;
          const crIndex = buf.search(/[\r\n]/);
          if (crIndex >= 0) {
            const line = buf.slice(0, crIndex).trim();
            inputBufferRef.current = buf.slice(crIndex + 1);
            const cdMatch = line.match(/^cd(?:\s+(.+))?$/);
            log?.push({ source: "SshTerminalHost.transport.write", data, line, matched: !!cdMatch });
            if (cdMatch) {
              const dir = (cdMatch[1] ?? "~").trim() || "~";
              // 仅拦截简单的 cd 参数（不含 shell 元字符），防止误改复合命令。
              if (!/[;&|`$(){}[\]<>!"\\]/.test(dir)) {
                // 让 shell 执行 cd 后发出 OSC 7；使用单引号包裹参数，避免简单空格问题。
                // 采用八进制转义 \\033 / \\007，兼容 bash/dash 等更多默认 shell，
                // 原 \\e / \\a 在 dash 等 shell 中不被识别。
                // TDSF 修复 2026-07-31: 用固定 host "localhost" + $PWD 构造 OSC 7 URL。
                // 实测 $HOSTNAME 在部分远端 shell 中未定义，导致 printf 输出不完整、
                // xterm 无法识别为有效 OSC 7；$PWD 在 cd 后立即更新且始终为绝对路径。
                const safeDir = dir.replace(/'/g, "'\\''");
                const osc7 = `cd '${safeDir}' && printf '\\033]7;file://localhost%s\\007' "$PWD"\r`;
                log?.push({
                  source: "SshTerminalHost.transport.write.cdRewrite",
                  osc7,
                  dir,
                  safeDir,
                });
                return handle.write(osc7);
              }
            }
          } else {
            log?.push({ source: "SshTerminalHost.transport.write", data, matched: false });
          }
          return handle.write(data);
        },
        resize: (cols: number, rows: number) => {
          const handle = handleRef.current;
          if (!handle) return;
          return handle.resize(cols, rows);
        },
        close: () => {
          // 关键：只 unsubscribe 前端订阅，不调 handle.close()
          // SFTP 文件树共用同一条 SSH 连接，断连会废掉 SFTP
          unsubscribe();
        },
      };
      return Promise.resolve(transport);
    };
  }, [sessionId, subscribeTerminalData]);

  // 卸载时清理 rendererPool slot + transport，避免泄漏
  // （TerminalPane 内部 useTerminalSession 的 effect cleanup 会先 detach，
  //   这里再 dispose 确保彻底清理；disposeSession 对已 disposed session 安全 no-op）
  useEffect(() => {
    return () => {
      if (leafIdRef.current !== null) {
        disposeSession(leafIdRef.current);
      }
    };
  }, []);

  return (
    <div className={className ?? "h-full w-full overflow-hidden"}>
      <TerminalPane
        leafId={leafId}
        visible={true}
        focused={true}
        blocks={false}
        openTransport={openTransport}
        remote={true}
        onCwd={handleCwd}
      />
    </div>
  );
}
