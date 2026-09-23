// SSH 主机身份确认框（TOFU / 密钥已变更）
// -----------------------------------------------------------------------------
// 2026-09-23 从 SshExplorer.tsx 搬出来单独成文件：App.tsx 顶层常驻渲染它
// （P1-6 起就不依赖 ssh 视图挂载），而 SshExplorer 那片面板的去留还挂在 #109 上等用户拍。
// 寄生在一个可能被整片删掉的文件里，等于给"删面板"这件事埋雷 —— 搬出来两边都干净。
//
// 排版按用户 2026-09-23 给的参考图重排：图标+标题 → 情形说明 → 主机/算法/指纹的
// 表格式对齐 → 编号「可能原因」→ 核对命令（可一键复制）。
// 文案不在这里手写，唯一来源是 ./lib/hostKeyGuidance。

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { HostApprovalRequest } from "@/lib/ssh-bridge";
import { cn } from "@/lib/utils";
import {
  Alert02Icon,
  Copy01Icon,
  InformationCircleIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { hostKeyGuidance } from "./lib/hostKeyGuidance";
import { generateRandomArt } from "./randomart";

const COPY_RESET_MS = 1500;

export function HostApprovalDialog({
  request,
  onApprove,
  onReject,
}: {
  request: HostApprovalRequest | null;
  onApprove: () => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const [handling, setHandling] = useState(false);
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  // 换一条审批请求时把"已复制"状态清掉，否则下一条会顶着上一条的绿勾
  useEffect(() => {
    setCopied(false);
  }, [request?.approvalId]);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const copyVerifyCommand = async () => {
    if (!request || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(hostKeyGuidance(request).verifyCommand);
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(
        () => setCopied(false),
        COPY_RESET_MS,
      );
    } catch {
      // 剪贴板被系统拒绝时什么都不做：命令本身就在屏幕上，用户可以手抄
    }
  };

  const handle = (fn: () => Promise<void>) => async () => {
    setHandling(true);
    try {
      await fn();
    } finally {
      setHandling(false);
    }
  };

  if (!request) {
    return (
      <AlertDialog open={false}>
        <AlertDialogContent />
      </AlertDialog>
    );
  }

  const g = hostKeyGuidance(request);

  return (
    <AlertDialog open>
      {/* 覆盖宽度必须带上和基础类同样的变体前缀：AlertDialogContent 的基础类是
          `data-[size=default]:sm:max-w-md`，只写 `sm:max-w-lg` 时 tailwind-merge 认为
          两者变体不同、都保留，最后按特异性仍是 448px 赢（实测过）。
          高度同样必须显式设上限：基础类没有 max-h，加了「可能原因」后实测长到 787px。 */}
      <AlertDialogContent className="max-h-[85vh] overflow-y-auto data-[size=default]:sm:max-w-[42rem]">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2.5">
            <span
              aria-hidden
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-lg",
                g.danger
                  ? "bg-destructive/15 text-destructive"
                  : "bg-muted text-foreground/70",
              )}
            >
              <HugeiconsIcon
                icon={g.danger ? Alert02Icon : InformationCircleIcon}
                size={18}
                strokeWidth={1.75}
              />
            </span>
            {g.title}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <p className="text-[13px] leading-relaxed">{g.summary}</p>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* 内容区限高可滚：可能原因 + 命令 + 指纹一起放时曾经顶满整窗 */}
        <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
          {request.fingerprint ? (
            <pre
              className="overflow-x-auto rounded-md border border-border/40 bg-muted/40 px-2.5 py-1.5 font-mono text-[10px] leading-tight text-foreground/80"
              data-testid="ssh-host-randomart"
              role="img"
              aria-label="OpenSSH 艺术指纹"
            >
              {generateRandomArt(
                request.fingerprint,
                request.keyType ?? "ssh-ed25519",
              )}
            </pre>
          ) : null}

          <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1.5 rounded-md bg-muted/60 px-3 py-2.5 text-[12px]">
            <dt className="text-muted-foreground">主机</dt>
            <dd className="break-all font-mono">
              {request.host}:{request.port}
            </dd>
            <dt className="text-muted-foreground">算法</dt>
            <dd className="break-all font-mono">{request.keyType ?? "未知"}</dd>
            <dt className="text-muted-foreground">SHA256 指纹</dt>
            <dd className="break-all font-mono">{request.fingerprint}</dd>
          </dl>

          <section className="space-y-1.5">
            <h3 className="text-[12px] font-medium">可能原因（按常见程度排）</h3>
            <ol className="space-y-1 text-[12px] leading-relaxed text-muted-foreground">
              {g.causes.map((cause, i) => (
                <li key={cause} className="flex gap-2">
                  <span className="shrink-0 tabular-nums">{i + 1}.</span>
                  <span>{cause}</span>
                </li>
              ))}
            </ol>
          </section>

          <section className="space-y-1.5">
            <h3 className="text-[12px] font-medium">怎么核对</h3>
            <p className="text-[11px] text-muted-foreground">{g.verifyNote}</p>
            <div className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/40 px-2.5 py-1.5">
              <code
                data-testid="ssh-host-verify-command"
                className="min-w-0 flex-1 break-all font-mono text-[11px]"
              >
                {g.verifyCommand}
              </code>
              <button
                type="button"
                onClick={() => void copyVerifyCommand()}
                aria-label="复制核对命令"
                className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/60 px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <HugeiconsIcon
                  icon={copied ? Tick02Icon : Copy01Icon}
                  size={12}
                  strokeWidth={1.75}
                />
                {copied ? "已复制" : "复制"}
              </button>
            </div>
          </section>
        </div>

        <AlertDialogFooter>
          {/* 两个按钮显式同尺寸：AlertDialogCancel/Action 默认都是 size=default(h-9)，
              但主要按钮文案比次会长，靠 min-w 让它们宽度也别差得太随意 */}
          <AlertDialogCancel
            disabled={handling}
            onClick={handle(onReject)}
            className="h-9 min-w-[6.5rem]"
          >
            {g.rejectLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={handling}
            variant={g.danger ? "destructive" : "default"}
            onClick={handle(onApprove)}
            className="h-9 min-w-[9rem]"
          >
            {g.approveLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
