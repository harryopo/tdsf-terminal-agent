import type { PresenceState } from "@/lib/usePresence";
import { lazy, Suspense } from "react";
import type { AgentRunBridgeProps } from "./AgentRunBridge";
import type { SelectionAskAiProps } from "./SelectionAskAi";

const AgentRunBridgeInner = lazy(() =>
  import("./AgentRunBridge").then((m) => ({ default: m.AgentRunBridge })),
);

const AiMiniWindowInner = lazy(() =>
  import("./AiMiniWindow").then((m) => ({ default: m.AiMiniWindow })),
);

const AiInputBarConnectInner = lazy(() =>
  import("./AiInputBar").then((m) => ({ default: m.AiInputBarConnect })),
);

const SelectionAskAiInner = lazy(() =>
  import("./SelectionAskAi").then((m) => ({ default: m.SelectionAskAi })),
);

// TDSF 魔改: TdsfAgentPanel 用 lazy 包装，避免静态引入 @ai-sdk/chatRuntime
// 污染 main window 的 eager bundle graph（eager-budget.test.ts 守卫）
const TdsfAgentPanelInner = lazy(() =>
  import("./TdsfAgentPanel").then((m) => ({ default: m.TdsfAgentPanel })),
);

export function AgentRunBridge(props: AgentRunBridgeProps) {
  return (
    <Suspense fallback={null}>
      <AgentRunBridgeInner {...props} />
    </Suspense>
  );
}

export function AiMiniWindow({ state }: { state: PresenceState }) {
  return (
    <Suspense fallback={null}>
      <AiMiniWindowInner state={state} />
    </Suspense>
  );
}

export function AiInputBarConnect({ onAdd }: { onAdd: () => void }) {
  return (
    <Suspense fallback={null}>
      <AiInputBarConnectInner onAdd={onAdd} />
    </Suspense>
  );
}

export function SelectionAskAi(props: SelectionAskAiProps) {
  return (
    <Suspense fallback={null}>
      <SelectionAskAiInner {...props} />
    </Suspense>
  );
}

// TDSF 魔改: 导出 lazy 包装的 TdsfAgentPanel，App.tsx 用此组件避免 eager 加载
export function TdsfAgentPanel({ state }: { state: PresenceState }) {
  return (
    <Suspense fallback={null}>
      <TdsfAgentPanelInner state={state} />
    </Suspense>
  );
}
