import { routeAgentNotification } from "@/modules/agents/lib/route";
import type { AgentStatus } from "@/modules/agents/lib/types";
import { useWindowFocus } from "@/modules/agents/lib/useWindowFocus";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import { useEffect, useRef } from "react";
import { useChatStore } from "../store/chatStore";

const AGENT = "TDSF";

type RunStatus =
  | "idle"
  | "thinking"
  | "streaming"
  | "awaiting-approval"
  | "error";

function isBusy(s: RunStatus): boolean {
  return s === "thinking" || s === "streaming" || s === "awaiting-approval";
}

function liveStatus(s: RunStatus): AgentStatus | null {
  if (s === "awaiting-approval") return "waiting";
  if (s === "thinking" || s === "streaming") return "working";
  return null;
}

export function LocalAgentNotificationsBridge() {
  const status = useChatStore((s) => s.agentMeta.status) as RunStatus;
  const error = useChatStore((s) => s.agentMeta.error);
  const visible = useChatStore((s) => s.panelOpen || s.mini.open);
  const focused = useWindowFocus();

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const prev = useRef<RunStatus>(status);

  useEffect(() => {
    const live = liveStatus(status);
    useAgentStore
      .getState()
      .setLocalAgent(live ? { agent: AGENT, status: live } : null);

    const was = prev.current;
    prev.current = status;
    if (was === status) return;

    const fire = (
      kind: "attention" | "finished" | "error",
      title: string,
      body?: string,
    ) =>
      routeAgentNotification({
        source: "local",
        agent: AGENT,
        kind,
        title,
        body,
        focused: focusedRef.current,
        visible: visibleRef.current,
        allowToast: true,
        onActivate: () => useChatStore.getState().openPanel(),
      });

    // 文案跟着界面走中文（#110「报错要说人话」同一口径）：系统通知是**人不看窗口时
    // 唯一的入口**，一句英文标题等于让他去猜发生了什么。
    if (status === "awaiting-approval") {
      fire(
        "attention",
        "TDSF 需要你的确认",
        "有一条操作在等你批准才能继续",
      );
    } else if (status === "error") {
      fire("error", "TDSF 这一轮失败了", error ?? undefined);
    } else if (status === "idle" && isBusy(was)) {
      fire("finished", "TDSF 跑完了", "结果已经好了，可以看了");
    }
  }, [status, error]);

  return null;
}
