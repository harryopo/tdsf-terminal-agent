// TDSF 魔改 (P4-T4.1): SSH 文件传输任务列表
// -----------------------------------------------------------------------------
// 展示当前 SSH 会话的文件传输任务 (上传/下载):
//   - 方向图标 (↑ upload / ↓ download)
//   - 远程路径 + 本地路径
//   - 进度条 (transferred / total)
//   - 状态: pending / transferring / done / error
//   - 移除按钮 (done/error 后可手动清除)
//
// 实现说明:
//   - 当前为展示型组件, 任务由 SshExplorer 工具栏的上传按钮 + 编辑器下载按钮触发
//   - 任务状态由 useSshStore.transferTasks 维护
//   - 未来可扩展为实时进度 (需 Rust 端 SFTP 流式读写 + Channel 进度推送)
// TDSF 魔改 P0-1: 修复 React "getSnapshot should be cached" + "Maximum update depth" 无限循环
// 根因: useSshStore((s) => s.transferTasks.filter(...)) 每次都返回新数组引用,
//       触发 useSyncExternalStore 的 snapshot 变化检测 → 无限重渲染。
// 修复: 改用 useMemo 派生过滤结果, 只订阅 transferTasks 数组本身。

import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo } from "react";
import { type SshTransferTask, useSshStore } from "./sshStore";

type Props = {
  sessionId: string;
};

/** 格式化字节 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`;
}

/** 单个任务行 */
function TaskRow({ task }: { task: SshTransferTask }) {
  const removeTransferTask = useSshStore((s) => s.removeTransferTask);
  const isUp = task.direction === "upload";
  const pct =
    task.total && task.total > 0
      ? Math.min(100, Math.round((task.transferred / task.total) * 100))
      : null;

  return (
    <div className="group flex items-center gap-2 px-2.5 py-1.5 text-[12px] hover:bg-accent/40">
      <HugeiconsIcon
        icon={isUp ? ArrowUp01Icon : ArrowDown01Icon}
        size={12}
        strokeWidth={1.75}
        className={cn("shrink-0", isUp ? "text-primary" : "text-sky-500")}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium text-foreground">
            {task.remotePath.split("/").pop() || task.remotePath}
          </span>
          {task.status === "transferring" && (
            <HugeiconsIcon
              icon={Loading03Icon}
              size={10}
              strokeWidth={1.75}
              className="animate-spin text-muted-foreground"
            />
          )}
          {task.status === "done" && (
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              size={10}
              strokeWidth={1.75}
              className="text-primary"
            />
          )}
          {task.status === "error" && (
            <HugeiconsIcon
              icon={CancelCircleIcon}
              size={10}
              strokeWidth={1.75}
              className="text-destructive"
            />
          )}
        </div>
        <div className="truncate text-[11px] text-muted-foreground/80">
          {isUp ? "↑ " : "↓ "}
          {task.localPath}
        </div>
        {task.error && (
          <div className="truncate text-[11px] text-destructive/80">
            {task.error}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {pct !== null && task.status === "transferring" && (
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {pct}%
          </span>
        )}
        {task.total && task.status !== "pending" ? (
          <span className="text-[10px] tabular-nums text-muted-foreground/70">
            {formatBytes(task.transferred)}/{formatBytes(task.total)}
          </span>
        ) : null}
        {(task.status === "done" || task.status === "error") && (
          <button
            type="button"
            aria-label="移除任务"
            title="移除"
            onClick={() => removeTransferTask(task.id)}
            className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={1.75} />
          </button>
        )}
      </div>
    </div>
  );
}

export function SshFileTransfer({ sessionId }: Props) {
  // TDSF 魔改 P0-1: 只订阅 transferTasks 数组本身 (引用稳定),
  // 用 useMemo 派生过滤结果, 避免每次 selector 返回新数组导致无限重渲染。
  const allTasks = useSshStore((s) => s.transferTasks);
  const tasks = useMemo(
    () => allTasks.filter((t) => t.sessionId === sessionId),
    [allTasks, sessionId],
  );

  if (tasks.length === 0) return null;

  return (
    <div className="border-t border-border/40 bg-card/50">
      <div className="flex h-6 items-center gap-1.5 px-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        传输任务 ({tasks.length})
      </div>
      <div className="max-h-32 overflow-y-auto pb-1">
        {tasks.map((t) => (
          <TaskRow key={t.id} task={t} />
        ))}
      </div>
    </div>
  );
}
