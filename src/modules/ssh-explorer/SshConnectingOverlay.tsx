// TDSF 魔改 (2026-08-09): SSH 连接进度界面
// -----------------------------------------------------------------------------
// 用户反馈："资源管理器没加载好终端就不显示"——真相是 SSH 握手期间 (connecting →
// connected) 终端区域显示空状态引导页 (NoTerminalEmptyState)，用户误以为终端卡住。
// 改为在 SSH 连接过程中显示美观的进度界面，让用户明确知道"正在连接"而非"坏了"。
//
// 设计：居中卡片，5 步进度指示器 (TCP → 握手 → 主机验证 → 认证 → 终端)，
// 当前步骤 amber 脉冲动画，已完成步骤 primary 色 + checkmark。
// 不使用 AI 味渐变，遵循项目设计语言 (CSS 变量 + shadcn token)。

import type { SshSessionStateValue } from "@/store/runtime";
import { stateLabel } from "./SshStatusDot";
import { CloudServerIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Fragment } from "react";
import { cn } from "@/lib/utils";

type Props = {
  host: string;
  port: number;
  user: string;
  state: SshSessionStateValue;
};

/** SSH 连接 5 个步骤标签（顺序对应 SSH 状态机） */
const STEPS = ["建立连接", "SSH 握手", "验证主机", "身份认证", "启动终端"] as const;

/** 将 SSH 状态映射为当前步骤索引 (0-4)，5 表示全部完成 */
function activeStepIndex(state: SshSessionStateValue): number {
  switch (state) {
    case "connecting":
      return 0;
    case "handshaking":
      return 1;
    case "host_verifying":
      return 2;
    case "authenticating":
      return 3;
    case "authenticated":
      return 4;
    case "connected":
      return 5; // 全部完成（此时 SshTerminalHost 应已接管渲染）
    case "reconnecting":
      return 0; // 重连从头开始
    default:
      return 0;
  }
}

export function SshConnectingOverlay({ host, port, user, state }: Props) {
  const current = activeStepIndex(state);
  const currentLabel = stateLabel(state);

  return (
    <div
      data-testid="ssh-connecting-overlay"
      className="flex h-full min-h-0 items-center justify-center bg-background/95 backdrop-blur-sm"
    >
      <div className="flex w-full max-w-[480px] flex-col items-center px-6 py-10">
        {/* 标题区：服务器图标 + 连接信息 */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="relative flex size-16 items-center justify-center rounded-2xl border border-border/50 bg-card/80 shadow-[inset_0_1px_0_0_color-mix(in_srgb,var(--color-foreground)_6%,transparent)]">
            <HugeiconsIcon
              icon={CloudServerIcon}
              size={28}
              strokeWidth={1.5}
              className="text-muted-foreground"
            />
            {/* 连接中扩散环 */}
            <div className="absolute inset-0 rounded-2xl border-2 border-amber-500/30 animate-ping" />
          </div>
          <div className="space-y-1 text-center">
            <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
              正在连接到 SSH 服务器
            </h2>
            <p className="text-[12px] text-muted-foreground">
              <span className="font-medium text-foreground/80">
                {user}@{host}
              </span>
              <span className="text-muted-foreground/60">:{port}</span>
            </p>
          </div>
        </div>

        {/* 5 步进度指示器 */}
        <div className="w-full">
          <div className="flex items-center">
            {STEPS.map((label, i) => {
              const isLast = i === STEPS.length - 1;
              const status =
                i < current ? "done" : i === current ? "active" : "pending";
              return (
                <Fragment key={i}>
                  <div className="z-10 flex flex-col items-center gap-2">
                    <div
                      className={cn(
                        "flex size-7 items-center justify-center rounded-full border-2 transition-all duration-300",
                        status === "done" &&
                          "border-primary bg-primary text-primary-foreground",
                        status === "active" &&
                          "border-amber-500 bg-amber-500/10",
                        status === "pending" &&
                          "border-border bg-background",
                      )}
                    >
                      {status === "done" && (
                        <HugeiconsIcon
                          icon={Tick02Icon}
                          size={13}
                          strokeWidth={2.5}
                        />
                      )}
                      {status === "active" && (
                        <>
                          <div className="size-2.5 rounded-full bg-amber-500" />
                          <div className="absolute rounded-full border-2 border-amber-500/40 animate-ping" />
                        </>
                      )}
                      {status === "pending" && (
                        <div className="size-2 rounded-full bg-muted-foreground/25" />
                      )}
                    </div>
                    <span
                      className={cn(
                        "whitespace-nowrap text-[10px] font-medium transition-colors",
                        status === "done" && "text-foreground/60",
                        status === "active" &&
                          "text-amber-600 dark:text-amber-400",
                        status === "pending" && "text-muted-foreground/40",
                      )}
                    >
                      {label}
                    </span>
                  </div>
                  {!isLast && (
                    <div
                      className={cn(
                        "mx-1 h-[2px] flex-1 rounded-full transition-colors duration-500",
                        i < current ? "bg-primary/40" : "bg-border",
                      )}
                    />
                  )}
                </Fragment>
              );
            })}
          </div>
        </div>

        {/* 当前状态描述 */}
        <div className="mt-8 flex items-center gap-2 rounded-full border border-border/50 bg-card/50 px-4 py-1.5">
          <div className="size-2 rounded-full bg-amber-500 animate-pulse" />
          <span className="text-[11px] font-medium text-muted-foreground">
            {currentLabel}...
          </span>
        </div>
      </div>
    </div>
  );
}
