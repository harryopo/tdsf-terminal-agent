// SSH 连接失败诊断框（2026-09-28 用户实测⑤：「失败的话弹出来一个详细窗口，就像指纹验证一样，
// 分析到底是哪一步有问题，是服务器没开密码登录，还是什么原因」）
// -----------------------------------------------------------------------------
// 与 HostApprovalDialog 同一个形状：图标+标题 → 分步结论 → 怎么办 → 原始信息。
// 分步结构来自 ./lib/sshFailureDiagnosis（唯一主人），这里的文案只消费它的结论，
// 不另写一份失败解释（#110 的那份人话仍由 describeSshFailure 提供）。

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { Alert02Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SshDiagnosis } from "./lib/sshFailureDiagnosis";

export function SshFailureDiagnoseDialog({
  open,
  diagnosis,
  onClose,
}: {
  open: boolean;
  diagnosis: SshDiagnosis | null;
  onClose: () => void;
}) {
  if (!diagnosis) return null;

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onClose()}>
      {/* 变体前缀必须和基础类一致，否则覆盖不生效（#122 实测过这条 tailwind-merge 行为） */}
      <AlertDialogContent className="max-h-[70vh] overflow-y-auto data-[size=default]:sm:max-w-[36rem]">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-destructive/15 text-destructive"
            >
              <HugeiconsIcon icon={Alert02Icon} size={18} strokeWidth={1.75} />
            </span>
            {diagnosis.headline}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <p className="text-[13px] leading-relaxed">
              {diagnosis.stuckAt
                ? "下面按连接的实际顺序列出每一步，打勾的是已经走通的，红的是卡住的那一步。"
                : "这条失败我们认不出格式，所以不敢断言走到哪一步——下面把原始信息完整给你。"}
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
          <ol className="space-y-1.5" data-testid="ssh-diagnose-stages">
            {diagnosis.stages.map((stage) => (
              <li
                key={stage.key}
                data-testid={`ssh-diagnose-stage-${stage.key}`}
                data-state={stage.state}
                className={cn(
                  "flex items-start gap-2.5 rounded-md border px-3 py-2 text-[12px]",
                  stage.state === "failed"
                    ? "border-destructive/40 bg-destructive/10"
                    : stage.state === "passed"
                      ? "border-border/50 bg-muted/40"
                      : "border-border/30 opacity-70",
                )}
              >
                {stage.state === "passed" ? (
                  <HugeiconsIcon
                    aria-hidden
                    className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                    size={14}
                    strokeWidth={1.9}
                    icon={Tick02Icon}
                  />
                ) : stage.state === "failed" ? (
                  <HugeiconsIcon
                    aria-hidden
                    className="mt-0.5 shrink-0 text-destructive"
                    size={14}
                    strokeWidth={1.9}
                    icon={Alert02Icon}
                  />
                ) : (
                  <span
                    aria-hidden
                    className="mt-1 size-2.5 shrink-0 rounded-full border border-border"
                  />
                )}
                <span className="min-w-0">
                  <span
                    className={cn(
                      "block font-medium",
                      stage.state === "failed" && "text-destructive",
                    )}
                  >
                    {stage.label}
                    {stage.state === "passed" ? " · 已通过" : ""}
                    {stage.state === "failed" ? " · 卡在这里" : ""}
                  </span>
                  <span className="block text-muted-foreground">
                    {stage.note}
                  </span>
                </span>
              </li>
            ))}
          </ol>

          {diagnosis.serverMethods ? (
            <p
              className="rounded-md bg-muted/60 px-3 py-2 text-[12px]"
              data-testid="ssh-diagnose-methods"
            >
              服务器报告的可用登录方式：
              <span className="font-mono">
                {diagnosis.serverMethods.join(" / ")}
              </span>
            </p>
          ) : null}

          <section className="space-y-1.5">
            <h3 className="text-[12px] font-medium">怎么办</h3>
            <p
              className="text-[12px] leading-relaxed text-muted-foreground"
              data-testid="ssh-diagnose-action"
            >
              {diagnosis.description}
            </p>
          </section>

          <section className="space-y-1.5">
            <h3 className="text-[12px] font-medium">原始信息</h3>
            <pre
              data-testid="ssh-diagnose-raw"
              className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/40 bg-muted/40 px-2.5 py-1.5 font-mono text-[10px] leading-tight text-foreground/80"
            >
              {diagnosis.raw || "（没有拿到任何原始信息）"}
            </pre>
          </section>
        </div>

        <AlertDialogFooter>
          {/* Radix 的 AlertDialog 要求至少有一个 Action；这里只有"关闭"一个动作 */}
          <AlertDialogAction onClick={onClose} className="h-9 min-w-[6.5rem]">
            关闭
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
