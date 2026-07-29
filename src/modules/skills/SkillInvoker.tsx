// TDSF 魔改 (P4-T4.4): Skill 调用对话框
// -----------------------------------------------------------------------------
// 弹窗（shadcn Dialog）用于调用单个 skill：
//   - 显示 skill 名称 + 描述
//   - 输入框：args（多行 textarea）
//   - 调用按钮：primary 主色 + Spinner
//   - 输出区：流式展示（monospace 字体 + 滚动）+ 耗时
//
// 调用流程:
//   1. 用户输入 args，点击"调用 Skill"
//   2. 调用 store.invoke(name, args) → executor.invokeSkill → IPC skill.invoke
//   3. 流式追加输出到输出区（按字符切片模拟流式效果）
//   3. 完成后显示耗时，失败显示 toast.error

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { PlayIcon, SparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSkillsStore } from "./skillsStore";
import type { SkillExecution, SkillMetadata } from "./types";

interface Props {
  /** 要调用的 skill（null 时关闭） */
  skill: SkillMetadata | null;
  /** 关闭回调 */
  onOpenChange: (open: boolean) => void;
}

/** 流式输出的 chunk 大小（字符数） */
const STREAM_CHUNK_SIZE = 32;
/** 流式输出的 chunk 间隔（ms） */
const STREAM_CHUNK_DELAY_MS = 12;

export function SkillInvoker({ skill, onOpenChange }: Props) {
  const invoke = useSkillsStore((s) => s.invoke);
  const invokingSkill = useSkillsStore((s) => s.invokingSkill);
  const [args, setArgs] = useState("");
  const [output, setOutput] = useState("");
  const [result, setResult] = useState<SkillExecution | null>(null);
  const [streaming, setStreaming] = useState(false);
  const outputRef = useRef<HTMLDivElement | null>(null);

  const open = skill !== null;
  const isInvoking = invokingSkill === skill?.name || streaming;

  // 切换 skill 时重置状态（仅依赖 skillName 字符串，避免 skill 对象引用变化触发不必要重置）
  const skillName = skill?.name ?? "";
  useEffect(() => {
    if (skillName) {
      setArgs("");
      setOutput("");
      setResult(null);
      setStreaming(false);
    }
  }, [skillName]);

  // 输出更新时自动滚动到底部（output 是触发滚动的信号）
  // biome-ignore lint/correctness/useExhaustiveDependencies: output 用于触发 effect，effect 内部通过 ref 操作 DOM
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const handleInvoke = useCallback(async () => {
    if (!skill) return;
    setOutput("");
    setResult(null);
    setStreaming(true);
    try {
      // 调用 store.invoke（会触发 executor.invokeSkill + 写入历史）
      const res = await invoke(skill.name, args);
      setResult(res);

      // 流式追加输出（模拟 LLM 流式效果）
      const text = res.output;
      for (let i = 0; i < text.length; i += STREAM_CHUNK_SIZE) {
        setOutput(text.slice(0, i + STREAM_CHUNK_SIZE));
        await new Promise((r) => setTimeout(r, STREAM_CHUNK_DELAY_MS));
      }
      setOutput(text);

      if (res.success) {
        toast.success(`Skill "${skill.name}" 执行完成`, {
          description: `耗时 ${res.durationMs}ms`,
          duration: 3000,
        });
      } else {
        toast.error(`Skill "${skill.name}" 执行失败`, {
          description: res.output.slice(0, 120),
          duration: 3000,
        });
      }
    } finally {
      setStreaming(false);
    }
  }, [skill, args, invoke]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {/* TDSF 魔改: 标题图标改用 text-primary 语义色 */}
            <HugeiconsIcon
              icon={SparklesIcon}
              size={16}
              strokeWidth={1.75}
              className="text-primary"
            />
            <span className="font-mono">{skill?.name ?? ""}</span>
          </DialogTitle>
          <DialogDescription>
            {skill?.description ?? ""}
            {skill?.whenToUse ? (
              <span className="mt-1 block text-[11px] opacity-80">
                触发条件：{skill.whenToUse}
              </span>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {/* === 输入区 === */}
        <div className="space-y-1.5">
          <label
            htmlFor="skill-args-input"
            className="text-[11px] font-medium text-muted-foreground"
          >
            调用参数（可选，作为 input 传给 skill）
          </label>
          <Textarea
            id="skill-args-input"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder="例如：nginx 启动失败 / docker 容器退出 / ssh 连接超时"
            rows={3}
            maxLength={2000}
            disabled={isInvoking}
            className="resize-none text-[12px]"
            data-testid="skill-invoker-args"
          />
          <div className="flex justify-end text-[10px] text-muted-foreground">
            {args.length}/2000
          </div>
        </div>

        {/* === 输出区 === */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-muted-foreground">
              输出
            </span>
            {result && (
              <span
                className={cn(
                  "text-[10px] tabular-nums",
                  // TDSF 魔改: 成功状态使用 text-primary，失败保持 text-destructive
                  result.success ? "text-primary" : "text-destructive",
                )}
              >
                {result.success ? "成功" : "失败"} · {result.durationMs}ms
              </span>
            )}
          </div>
          <div
            ref={outputRef}
            className="h-48 overflow-auto rounded-md border border-border/60 bg-muted/40 p-2.5"
            data-testid="skill-invoker-output"
          >
            {output ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/90">
                {output}
                {/* TDSF 魔改: 流式光标改用 bg-primary 语义色 */}
                {streaming && (
                  <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-primary align-middle" />
                )}
              </pre>
            ) : (
              <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground/60">
                {isInvoking ? (
                  <span className="flex items-center gap-1.5">
                    <Spinner className="size-3" />
                    调用中...
                  </span>
                ) : (
                  "点击「调用 Skill」查看输出"
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isInvoking}
            className="text-[12px]"
          >
            关闭
          </Button>
          <Button
            type="button"
            onClick={() => void handleInvoke()}
            disabled={isInvoking || !skill}
            className={cn(
              // TDSF 魔改: 调用按钮使用 bg-primary 语义色
              "gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
            data-testid="skill-invoker-submit"
          >
            {isInvoking ? (
              <>
                <Spinner className="size-3" />
                调用中
              </>
            ) : (
              <>
                <HugeiconsIcon icon={PlayIcon} size={12} strokeWidth={2} />
                调用 Skill
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
