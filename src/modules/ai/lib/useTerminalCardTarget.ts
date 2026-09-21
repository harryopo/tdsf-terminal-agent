import { useMemo, useRef } from "react";
import { useChatStore } from "../store/chatStore";
import {
  driftMessage,
  targetDrift,
  type TerminalTarget,
} from "./commandCardTarget";

/**
 * 给"点一下才注入终端"的卡片用的归属守卫。
 *
 * 必须在**首次渲染**时取目标：懒取（点击时才取）等于没有守卫 —— 那正是 #91 第⑤条
 * 的形状（tab1 生成的卡切到 tab2 再点，命令打进 tab2）。
 */
export function useTerminalCardTarget() {
  const ref = useRef<TerminalTarget | null | undefined>(undefined);
  if (ref.current === undefined) {
    ref.current = useChatStore.getState().live.getActiveTerminalTarget();
  }
  const expected = ref.current;

  return useMemo(
    () => ({
      /** null = 可以注入；否则是给用户看的中文说明（由调用方决定 toast 还是行内错误）。 */
      blockReason(): string | null {
        const current =
          useChatStore.getState().live.getActiveTerminalTarget();
        const drift = targetDrift(expected, current);
        return drift && expected ? driftMessage(drift, expected) : null;
      },
    }),
    [expected],
  );
}
