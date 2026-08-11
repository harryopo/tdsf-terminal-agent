/**
 * useSshLeafTransport.ts — TDSF 魔改 (2026-08-11): SSH 叶子终端的传输注入 hook
 * -----------------------------------------------------------------------------
 * 从 SshTerminalHost 提取（#18 → #21 分屏重构）：把「SSH 会话 ↔ TerminalPane」
 * 的 transport 工厂下沉为可复用 hook，供 PaneTreeView 的 SSH 叶子直接使用，
 * 使 SSH 终端成为真正的 leaf，与本地终端共用同一套 rendererPool / 保活 / 焦点。
 *
 * transport 行为（与原 SshTerminalHost 一致）：
 *   - onData = subscribeTerminalData(sessionId, cb)
 *     （sshStore 的 fan-out + 先到数据缓冲，修复"连接就绪早于组件挂载"竞态）
 *   - write/resize = session.handle.write/resize
 *     （handle 由 sshStore.connect 在 connect 成功后填充，可能晚于组件挂载；
 *      handleRef 同步最新值，write/resize 调用时读 ref，handle 未到则 no-op）
 *   - close = 只 unsubscribe 前端订阅，不断底层 SSH 连接
 *     （SFTP 文件树共用同一条 SSH 连接，断连会废掉 SFTP）
 */
import { useMemo, useRef } from "react";
import { getOsc7Log, useSshStore } from "@/modules/ssh-explorer/sshStore";
import type { TerminalTransport } from "./pty-bridge";

export function useSshLeafTransport(sessionId: string) {
  // 订阅 SSH 会话状态（handle 由 sshStore.connect 成功后填充，可能晚于挂载）
  const session = useSshStore((s) =>
    s.sessions.find((it) => it.id === sessionId),
  );

  // handle 用 ref 持有最新值：openTransport 闭包通过 ref 读最新 handle，避免拿 null
  const handleRef = useRef(session?.handle ?? null);
  handleRef.current = session?.handle ?? null;

  const subscribeTerminalData = useSshStore((s) => s.subscribeTerminalData);

  // openTransport 工厂：仅依赖 sessionId + subscribeTerminalData（稳定引用），不重创建
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
            log?.push({
              source: "useSshLeafTransport.transport.write",
              data,
              matched: false,
            });
            return;
          }
          // 输入原样透传（方案 A 后不再做任何行缓冲/命令改写，
          // 远端 shell 的注入钩子负责 OSC 7 cwd 上报）
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

  return { openTransport };
}
