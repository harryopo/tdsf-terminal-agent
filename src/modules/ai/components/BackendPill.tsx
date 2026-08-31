/**
 * BackendPill — 后端类型指示器（Critical-2 可观测性收尾）
 * =============================================================================
 *
 * 显示当前 Agent 后端是 Strands（绿）还是 LangGraph（黄），
 * 若 Strands 启动失败回退 LangGraph 则显示降级（红）+ tooltip 显示原因。
 *
 * 数据来源：
 *   1. 启动时调 `sidecar.health` JSON-RPC 拉初始状态
 *   2. 监听 `sidecar:backend_status` 事件实时更新（Strands 注入三路径推送）
 *
 * 字段契约（与 sidecar/main.py `_backend_status` 对齐）：
 *   - backend_type:        "strands" | "langgraph"
 *   - backend_activated:   bool（Strands 适配层是否真实激活）
 *   - strands_available:   bool（strands 包是否可导入）
 *   - rust_bridge_active:  bool（rust_bridge 是否注入）
 *   - llm_configured:      bool（LLMConfig 是否配置 api_key）
 *   - fallback_reason:     string | null（Strands 启动失败时的异常信息）
 *   - activate_time:       float（激活/降级时间戳）
 *   - agents_count?:       int（仅 sidecar.health 返回）
 *   - agents_list?:        string[]（仅 sidecar.health 返回）
 *   - uptime_seconds?:     float（仅 sidecar.health 返回）
 *
 * 配色规则：
 *   - Strands 激活（backend_type=strands & backend_activated）→ 绿色 emerald
 *   - LangGraph 正常（backend_type=langgraph & 无 fallback_reason）→ 黄色 amber
 *   - 降级（fallback_reason 非空）→ 红色 rose + pulse 动画
 *   - 加载中（初始 null）→ 灰色 muted + ping 动画
 *
 * 挂载位置：StatusBar 中 MockLLMWarning 与 AgentStatusPill 之间。
 * =============================================================================
 */

import { useEffect, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { invokeRpc, subscribe } from "@/lib/sidecar-bridge";

/** 后端状态（与 sidecar/main.py _backend_status 字段对齐） */
export interface BackendStatus {
  backend_type: "strands" | "langgraph";
  backend_activated: boolean;
  strands_available: boolean;
  rust_bridge_active: boolean;
  llm_configured: boolean;
  fallback_reason: string | null;
  activate_time: number;
  // 仅 sidecar.health 返回的扩展字段
  agents_count?: number;
  agents_list?: string[];
  uptime_seconds?: number;
  python_version?: string;
  platform?: string;
}

/** 后端显示态：从 BackendStatus 派生颜色/标签/tooltip */
type DisplayState = {
  /** 圆点颜色 tailwind class */
  dotColor: string;
  /** 标签颜色 tailwind class */
  labelColor: string;
  /** 背景色 tailwind class */
  bgColor: string;
  /** 短标签（显示在 pill 内） */
  label: string;
  /** 是否有 pulse 动画（降级时） */
  pulse: boolean;
  /** tooltip 标题（一行，人类可读） */
  tooltipTitle: string;
  /** tooltip 次要信息（可空：运行时长/降级原因等） */
  tooltipDetail: string | null;
};

/**
 * 拼接 tooltip 副行：运行时长。
 * 注意：不再显示 agents_count——sidecar.health 的该字段来自 LangGraph
 * fallback 的 AGENT_REGISTRY（顶层 agents/ 遗产注册表），Strands 激活时
 * 它与真实引擎无关（2026-08-31 用户质疑"9 个智能体是真的吗"，实测确认
 * 是误导数据，移除显示；字段本身保留给后端调试）。
 */
function buildDetail(status: BackendStatus): string | null {
  return status.uptime_seconds ? `已运行 ${Math.floor(status.uptime_seconds)}s` : null;
}

/** 从 BackendStatus 派生显示态 */
function deriveDisplay(status: BackendStatus | null): DisplayState {
  // 加载中：未知状态
  if (!status) {
    return {
      dotColor: "bg-muted-foreground",
      labelColor: "text-muted-foreground",
      bgColor: "bg-card/40",
      label: "Backend…",
      pulse: false,
      tooltipTitle: "正在查询后端状态…",
      tooltipDetail: null,
    };
  }

  // 降级：Strands 启动失败回退 LangGraph（原因保留，排障关键）
  if (status.fallback_reason) {
    return {
      dotColor: "bg-rose-500",
      labelColor: "text-rose-600 dark:text-rose-400",
      bgColor: "bg-rose-500/10",
      label: "Degraded",
      pulse: true,
      tooltipTitle: "Strands 启动失败，已降级 LangGraph",
      tooltipDetail: status.fallback_reason,
    };
  }

  // Strands 真实激活
  if (status.backend_type === "strands" && status.backend_activated) {
    return {
      dotColor: "bg-emerald-500",
      labelColor: "text-emerald-600 dark:text-emerald-400",
      bgColor: "bg-emerald-500/10",
      label: "Strands",
      pulse: false,
      tooltipTitle: "Strands 引擎已激活",
      tooltipDetail: status.llm_configured
        ? buildDetail(status)
        : ["LLM 未配置", buildDetail(status)].filter(Boolean).join(" · "),
    };
  }

  // LangGraph 正常模式
  return {
    dotColor: "bg-amber-500",
    labelColor: "text-amber-600 dark:text-amber-400",
    bgColor: "bg-amber-500/10",
    label: "LangGraph",
    pulse: false,
    tooltipTitle: "LangGraph 引擎（默认 PAOR）",
    tooltipDetail: buildDetail(status),
  };
}

/**
 * BackendPill — 后端类型指示器
 *
 * 启动时拉 sidecar.health，之后监听 sidecar:backend_status 实时更新。
 * 无 props，自管理状态。挂载到 StatusBar 即可工作。
 *
 * 时序说明（P0-C 修复）:
 *   Python main() 流程: register_business_methods（在此推送 backend_status）
 *                       → send_notification("ready") → 进入主循环。
 *   即 backend_status 事件在 ready 之前推送。若 BackendPill 挂载时 sidecar
 *   还在 starting，isRunning() 会返回 false 导致旧代码 IIFE 提前返回，
 *   且 backend_status 事件可能早于 subscribe 完成而丢失 → 永远卡 loading。
 *
 *   修复: 不再用 isRunning() 守卫，直接调 sidecar.health（失败就 catch）；
 *         监听 sidecar:ready 事件触发重取（覆盖 sidecar 后启动的场景）；
 *         监听 sidecar:backend_status 实时更新。
 */
export function BackendPill() {
  const [status, setStatus] = useState<BackendStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const unlistens: Array<() => void> = [];

    // 拉取 sidecar.health 的内联函数（可被多处调用：初始 + ready 后重取）
    const fetchHealth = async () => {
      if (cancelled) return;
      try {
        const result = await invokeRpc<BackendStatus>("sidecar.health", {});
        if (!cancelled) {
          setStatus(result);
        }
      } catch (e) {
        // sidecar 未就绪 / 方法未注册 / 超时等：等 ready 事件后重试
        // 开发期暴露错误便于排查，生产环境静默（等待 ready 事件重取）
        if (!cancelled) {
          console.warn(
            "[BackendPill] sidecar.health failed, will retry on sidecar:ready",
            e,
          );
        }
      }
    };

    // 1. 立即尝试拉取（sidecar 可能已就绪）
    void fetchHealth();

    // 2. 监听 sidecar:ready：sidecar 启动完成后重取初始状态
    //    （覆盖 BackendPill 挂载早于 sidecar ready 的时序场景）
    // P1-NEW-v2-4 修复 (2026-07-30): then 回调内检查 cancelled，
    // 若组件已卸载则立即 un() 取消订阅，避免 Tauri listener 泄漏。
    // （subscribe 返回 Promise<UnlistenFn>，cleanup 是同步的无法 await，
    //   若不在 then 内检查 cancelled，卸载后 push 的 unlisten 永不调用）
    subscribe("ready", () => {
      if (cancelled) return;
      void fetchHealth();
    }).then((un) => {
      if (cancelled) {
        un();
      } else {
        unlistens.push(un);
      }
    });

    // 3. 监听 sidecar:backend_status：Strands 注入三路径实时推送
    subscribe("backend_status", (payload) => {
      if (cancelled) return;
      const p = payload as Partial<BackendStatus>;
      // 事件 payload 是 _backend_status 字段（无 agents_count/uptime 等扩展字段）
      // 保留上一次的扩展字段（来自 sidecar.health）
      setStatus((prev) => ({
        backend_type: p.backend_type ?? prev?.backend_type ?? "langgraph",
        backend_activated: p.backend_activated ?? prev?.backend_activated ?? false,
        strands_available: p.strands_available ?? prev?.strands_available ?? false,
        rust_bridge_active: p.rust_bridge_active ?? prev?.rust_bridge_active ?? false,
        llm_configured: p.llm_configured ?? prev?.llm_configured ?? false,
        fallback_reason: p.fallback_reason ?? prev?.fallback_reason ?? null,
        activate_time: p.activate_time ?? prev?.activate_time ?? 0,
        agents_count: prev?.agents_count,
        agents_list: prev?.agents_list,
        uptime_seconds: prev?.uptime_seconds,
        python_version: prev?.python_version,
        platform: prev?.platform,
      }));
    }).then((un) => {
      if (cancelled) {
        un();
      } else {
        unlistens.push(un);
      }
    });

    return () => {
      cancelled = true;
      unlistens.forEach((un) => un());
    };
  }, []);

  const display = deriveDisplay(status);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="backend-pill"
          className={cn(
            "flex shrink-0 cursor-default items-center gap-1 rounded-full px-2 py-0.5",
            "text-[10.5px] font-medium",
            display.bgColor,
            display.labelColor,
          )}
        >
          {/* 状态圆点：降级时 pulse 动画 */}
          <span className="relative flex size-1.5 items-center justify-center">
            {display.pulse && (
              <span
                className={cn(
                  "absolute inline-flex size-full rounded-full opacity-60 animate-ping",
                  display.dotColor,
                )}
              />
            )}
            <span
              className={cn(
                "relative inline-flex size-1.5 rounded-full",
                display.dotColor,
              )}
            />
          </span>
          <span className="max-w-[5rem] truncate">{display.label}</span>
        </span>
      </TooltipTrigger>
      {/* 主题化弹层：bg-popover 跟随明暗主题（深色主题 = 黑底），覆盖默认反色方案。
          flex-col 纵排覆盖默认 inline-flex items-center（否则标题/副行被挤成
          同一行横排、基线错位——2026-08-31 用户反馈）。 */}
      <TooltipContent
        side="top"
        className="max-w-72 flex-col items-start gap-0 border border-border bg-popover px-3 py-2 text-popover-foreground shadow-md"
      >
        <p className="text-[11px] font-medium leading-snug">
          {display.tooltipTitle}
        </p>
        {display.tooltipDetail && (
          <p className="mt-0.5 break-words text-[10.5px] leading-snug text-muted-foreground">
            {display.tooltipDetail}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
