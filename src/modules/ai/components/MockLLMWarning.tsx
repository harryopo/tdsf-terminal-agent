// TDSF 魔改 (Outsider Review P0-2 修复 2026-07-28): Mock LLM 警告
// -----------------------------------------------------------------------------
// 监听 Python sidecar 通过 event_bus 推送的 "mock_llm_active" 事件,
// 在 status bar 右侧实时显示红色告警 Pill.
//
// 触发场景 (Python agents/base.py._publish_mock_warning):
//   1. BaseAgent.llm_call is None (未注入真实 LLM) - 最常见配置错误
//   2. LLM 调用抛异常降级到 mock
//   3. 用户在前端清空 .tdsf-data/llm_config.json
//
// 设计要点:
//   - 一个 useEffect 订阅一次, 卸载时 unlisten
//   - 多 agent 同时告警时合并显示 (取最新一条)
//   - 告警点击 → 打开 Settings/Models 页面让用户配置真实 API Key
//   - 与 AgentStatusPill 风格保持一致 (size=11, text-[10.5px])

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

type MockLLMEvent = {
  agent: string;
  reason: "no_llm_config" | "llm_call_failed" | string;
  detail: string;
  timestamp: number;
};

const REASON_LABELS: Record<string, string> = {
  no_llm_config: "未配置 LLM",
  llm_call_failed: "LLM 调用失败降级",
};

const REASON_DESCRIPTIONS: Record<string, string> = {
  no_llm_config:
    "当前 Agent 没有注入真实的 LLM 调用函数. 请在 设置 → 模型 中配置 API Key, 或写入 .tdsf-data/llm_config.json.",
  llm_call_failed:
    "真实 LLM 调用失败, 已自动降级到 mock 响应. 检查 API Key 是否有效 / 网络是否可达.",
};

export function MockLLMWarning() {
  const [warning, setWarning] = useState<MockLLMEvent | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    // TDSF 魔改 2026-07-30 P1-c: 启动期补发历史 mock_llm_active 事件
    // ----------------------------------------------------------------
    // 之前只 listen 实时事件，但应用启动时 Python sidecar 早已在
    // BaseAgent.__init__ 构造时推送过 mock_llm_active（agents/base.py:179-185
    // "Bug 2" 修复：构造时立即推送，覆盖所有 Agent 路径），前端挂载晚于事件
    // 发射，导致启动期告警丢失，用户必须手动触发 Agent 调用才能看到红色 Pill。
    //
    // 补发策略：
    //   1. listen 实时事件（与原逻辑一致）
    //   2. 并行调 invokeRpc('event.history', { event_type, limit: 1 })
    //      拿最近 1 条 mock_llm_active 历史，applyEvent 补发到 UI
    //   3. timestamp 去重：latestTsRef 记录已应用过的最大 timestamp
    //      - listen 后到的旧 history 事件 ts < latestTsRef 直接丢弃
    //      - 反之 history 先返回、listen 后到的实时事件 ts >= latestTsRef 才覆盖
    //      避免竞态下 history 旧事件覆盖 listen 实时事件
    //   4. sidecar 未就绪 / 非 Tauri 环境（vitest）静默降级，不抛错
    const latestTsRef = { current: 0 };

    const applyEvent = (evt: MockLLMEvent | null | undefined) => {
      if (cancelled || !evt) return;
      const ts = typeof evt.timestamp === "number" ? evt.timestamp : 0;
      if (ts < latestTsRef.current) return;
      latestTsRef.current = ts;
      setWarning(evt);
    };

    const setup = async () => {
      // TDSF 魔改 2026-07-28: 监听 Tauri 事件桥 (后端通过 event_bus.publish("mock_llm_active", ...) 推送)
      // 复用 @tauri-apps/api/event 的 listen, 与 ssh:host_verify 等事件一致
      // v2026-07-30 P1-a 修复: 之前缺 "sidecar:" 前缀永远监听不到
      // Rust sidecar.rs:805 `format!("sidecar:{}", method)` 会给所有 Python 事件加前缀
      // Python 推 "mock_llm_active" → Rust emit "sidecar:mock_llm_active"
      // 前端必须 listen("sidecar:mock_llm_active", ...) 才能匹配
      const { listen } = await import("@tauri-apps/api/event");
      if (cancelled) return;

      const un = await listen<MockLLMEvent>("sidecar:mock_llm_active", (event) => {
        applyEvent(event.payload);
      });
      unlisten = un;

      // TDSF 魔改 2026-07-30 P1-c: 启动期补发历史 mock_llm_active 事件
      // ---------------------------------------------------------------
      // event.history 已在 sidecar/event_bus.py:598-601 注册为 JSON-RPC 方法,
      // 调用签名为 event.history(event_type: str, session_id: str|None, limit: int)
      // 返回 list[dict], 每个元素是 Event.to_dict() = {
      //   event_type, payload, session_id, timestamp, source
      // }
      // payload 内嵌 { agent, reason, detail, timestamp } 即 MockLLMEvent
      try {
        const { invokeRpc } = await import("@/lib/sidecar-bridge");
        const history = await invokeRpc<
          | Array<{
              event_type: string;
              payload: MockLLMEvent;
              session_id: string | null;
              timestamp: number;
              source: string | null;
            }>
          | null
        >("event.history", {
          event_type: "mock_llm_active",
          limit: 1,
        });
        if (cancelled || !Array.isArray(history) || history.length === 0) return;
        applyEvent(history[0]?.payload);
      } catch (e) {
        // sidecar 未就绪 / event.history RPC 不可用 / 非 Tauri 环境
        // (浏览器预览模式 / vitest)，静默降级，不影响 UI 渲染
        console.debug("[MockLLMWarning] event.history backfill failed:", e);
      }
    };

    void setup();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  if (!warning) return null;

  const label = REASON_LABELS[warning.reason] ?? "Mock LLM";
  const description = REASON_DESCRIPTIONS[warning.reason] ?? warning.detail;
  const tooltipText = `${description}\n\nAgent: ${warning.agent}\n详情: ${warning.detail}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => {
            // TDSF 魔改: 跳转到设置页配置 LLM
            // 触发 ai.open settings=models 事件, 让 settings 主页面打开
            void import("@tauri-apps/api/event").then(({ emit }) =>
              emit("navigate", { route: "settings", section: "models" }),
            );
          }}
          className="flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10.5px] font-medium text-red-700 transition-colors hover:bg-red-500/25 dark:text-red-400"
          data-testid="mock-llm-warning"
          aria-label="Mock LLM 告警 - 点击配置真实 API Key"
        >
          <HugeiconsIcon icon={Alert02Icon} size={11} strokeWidth={2} />
          <span>{label}</span>
          <span className="text-red-700/70 dark:text-red-400/70">
            · {warning.agent}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="max-w-72 text-[11px] leading-relaxed whitespace-pre-line"
      >
        {tooltipText}
      </TooltipContent>
    </Tooltip>
  );
}
