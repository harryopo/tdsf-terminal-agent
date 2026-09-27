import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Download03Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { downloadConfirmCopy, formatBytes } from "@/modules/update/updateFacts";
import { useUpdateStore } from "@/modules/update/updateStore";

/** 只在"有话说"的时候占状态栏一格，平时不渲染（避免又一根常驻小尾巴）。 */
const VISIBLE = new Set(["available", "downloading", "ready", "error"]);

function chipLabel(input: {
  phase: string;
  version: string | null;
  bytes: number | null;
  received: number;
}): string {
  if (input.phase === "error") return "更新失败";
  if (input.phase === "downloading") {
    if (input.bytes && input.bytes > 0) {
      const pct = Math.min(99, Math.round((input.received / input.bytes) * 100));
      return `下载中 ${pct}%`;
    }
    return `下载中 ${formatBytes(input.received)}`;
  }
  if (input.phase === "ready") return "重启安装";
  return `可更新 ${input.version ?? ""}`.trim();
}

export function UpdateChip() {
  const phase = useUpdateStore((s) => s.phase);
  const version = useUpdateStore((s) => s.version);
  const bytes = useUpdateStore((s) => s.bytes);
  const received = useUpdateStore((s) => s.received);
  const error = useUpdateStore((s) => s.error);
  const blockers = useUpdateStore((s) => s.blockers);
  const [open, setOpen] = useState(false);

  if (!VISIBLE.has(phase)) return null;

  const copy = downloadConfirmCopy({ version: version ?? "", bytes });

  const startDownload = async () => {
    setOpen(false);
    const m = await import("../update/checkUpdate");
    await m.downloadHeldUpdate();
  };
  const startInstall = async () => {
    const m = await import("../update/installUpdate");
    const result = await m.installHeldUpdate();
    if (result.ok) setOpen(false);
  };
  const recheck = async () => {
    const m = await import("../update/checkUpdate");
    await m.runUpdateCheck({ force: true });
  };

  return (
    <>
      <button
        type="button"
        data-testid="update-chip"
        onClick={() => setOpen(true)}
        className={`flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[10.5px] font-medium ${
          phase === "error"
            ? "bg-destructive/15 text-destructive"
            : "bg-primary/15 text-primary"
        }`}
      >
        <HugeiconsIcon
          icon={phase === "error" ? Refresh01Icon : Download03Icon}
          size={11}
          strokeWidth={2}
        />
        <span>{chipLabel({ phase, version, bytes, received })}</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="update-dialog" className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {phase === "error"
                ? "更新没有完成"
                : phase === "ready"
                  ? "下载完成，可以安装"
                  : phase === "downloading"
                    ? `正在下载 ${version ?? ""}`
                    : copy.title}
            </DialogTitle>
            <DialogDescription className="break-words whitespace-normal">
              {phase === "error"
                ? (error ?? "未知错误")
                : phase === "downloading"
                  ? bytes && bytes > 0
                    ? `${formatBytes(received)} / ${formatBytes(bytes)}`
                    : `已下载 ${formatBytes(received)}`
                  : phase === "ready"
                    ? "安装会重启应用：当前 SSH 连接会断开，已打开的终端标签页会关闭。"
                    : copy.description}
            </DialogDescription>
          </DialogHeader>
          {blockers.length > 0 ? (
            <ul className="flex flex-col gap-1 text-[12px] text-destructive">
              {blockers.map((b) => (
                <li key={b.key}>{b.text}</li>
              ))}
            </ul>
          ) : null}
          <DialogFooter>
            {phase === "error" ? (
              <Button type="button" size="sm" onClick={() => void recheck()}>
                重试检查
              </Button>
            ) : null}
            {phase === "available" ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setOpen(false)}
                >
                  {copy.cancel}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void startDownload()}
                >
                  {copy.confirm}
                </Button>
              </>
            ) : null}
            {phase === "ready" ? (
              <Button type="button" size="sm" onClick={() => void startInstall()}>
                重启并安装
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
