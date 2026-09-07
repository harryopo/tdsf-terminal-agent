import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CheckmarkSquare02Icon, SquareIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect } from "react";
import type { Todo } from "../lib/todos";
import { useTodosStore } from "../store/todoStore";

type Props = { sessionId: string | null };

const EMPTY_TODOS: Todo[] = [];

/**
 * T3 规划-执行回环: completedAt（ISO 8601）→ 展示文案（"HH:MM"，跨天补日期）
 *
 * 解析失败 / 空值返回 null（不渲染时间戳）。
 */
function formatCompletedAt(completedAt?: string | null): string | null {
  if (!completedAt) return null;
  const date = new Date(completedAt);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const hm = `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return hm;
  const md = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
  return `${md} ${hm}`;
}

export function TodoStrip({ sessionId }: Props) {
  const hydrate = useTodosStore((s) => s.hydrate);
  const todos =
    useTodosStore((s) => (sessionId ? s.bySession[sessionId] : undefined)) ??
    EMPTY_TODOS;

  useEffect(() => {
    if (sessionId) void hydrate(sessionId);
  }, [sessionId, hydrate]);

  if (!sessionId || todos.length === 0) return null;

  const completed = todos.filter((t) => t.status === "completed").length;
  const current = todos.find((t) => t.status === "in_progress");
  const pct = Math.round((completed / todos.length) * 100);

  return (
    <section
      aria-label="任务清单"
      className="mx-2 mt-2 flex max-h-[38%] min-h-0 shrink-0 flex-col rounded-lg border border-border/60 bg-muted/45 px-3 py-2 shadow-sm"
    >
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-[11px] font-semibold tracking-wide text-foreground">
          任务清单
        </span>
        <Progress value={pct} className="h-1 flex-1" aria-label="任务进度" />
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {completed}/{todos.length}
        </span>
      </div>
      {current ? (
        <p
          data-testid="todo-current"
          className="mt-1.5 truncate text-[10.5px] text-muted-foreground"
        >
          <span className="mr-1 rounded bg-primary/10 px-1 py-0.5 font-medium text-primary">
            进行中
          </span>
          {current.title}
        </p>
      ) : null}
      <ScrollArea className="flex-1 min-h-0">
        <ul className="relative mt-2 flex flex-col gap-0.5 before:absolute before:bottom-3 before:left-[11px] before:top-3 before:w-px before:bg-border/70">
          {todos.map((t, index) => (
            <TodoRow key={t.id} todo={t} index={index} />
          ))}
        </ul>
      </ScrollArea>
    </section>
  );
}

function TodoRow({ todo, index }: { todo: Todo; index: number }) {
  const isInProgress = todo.status === "in_progress";
  const statusLabel =
    todo.status === "completed"
      ? "已完成"
      : isInProgress
        ? "进行中"
        : "待处理";
  // T3 规划-执行回环: 完成项显示完成时间小字（Python todo_write 自动维护
  // completedAt，ISO 8601；旧数据/未完成项无此字段不显示）
  const completedAtLabel =
    todo.status === "completed" ? formatCompletedAt(todo.completedAt) : null;
  const row = (
    <li
      className={cn(
        "relative flex items-start gap-2 rounded-md py-1.5 pl-8 pr-1.5 text-[11px] leading-snug transition-colors",
        isInProgress && "bg-primary/5",
        todo.status === "completed" && "opacity-75",
      )}
    >
      <span
        className={cn(
          "absolute left-1 top-1.5 z-10 inline-flex size-4 items-center justify-center rounded-full border bg-background",
          todo.status === "completed"
            ? "border-emerald-500/60 text-emerald-600 dark:text-emerald-400"
            : isInProgress
              ? "border-primary text-primary"
              : "border-border text-muted-foreground",
        )}
        aria-label={statusLabel}
      >
        {isInProgress ? (
          <Spinner className="size-2.5" />
        ) : (
          <HugeiconsIcon
            icon={
              todo.status === "completed" ? CheckmarkSquare02Icon : SquareIcon
            }
            size={10}
            strokeWidth={2}
          />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1",
          todo.status === "completed"
            ? "text-muted-foreground/70 line-through"
            : isInProgress
              ? "text-foreground"
              : "text-muted-foreground",
        )}
      >
        <span className="mr-1 font-mono text-[10px] text-muted-foreground/60">
          {String(index + 1).padStart(2, "0")}
        </span>
        {todo.title}
        {isInProgress && todo.description ? (
          <span className="mt-0.5 block text-[10px] text-muted-foreground">
            {todo.description}
          </span>
        ) : null}
      </span>
      {completedAtLabel && (
        <span
          data-testid="todo-completed-at"
          className="ml-auto shrink-0 self-center font-mono text-[9.5px] tabular-nums text-muted-foreground/50"
          title={`完成于 ${completedAtLabel}`}
        >
          {completedAtLabel}
        </span>
      )}
      <span className="shrink-0 self-center text-[9px] text-muted-foreground/60">
        {statusLabel}
      </span>
    </li>
  );

  if (!todo.description) return row;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{row}</TooltipTrigger>
        <TooltipContent side="left" className="max-w-xs text-[11px]">
          {todo.description}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
