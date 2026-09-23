"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  claimAutoType,
  markAutoTyped,
} from "@/modules/ai/lib/autoTypeLedger";
import { useAutoTypeAllowed } from "@/modules/ai/lib/autoTypeProvenance";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  ArrowRight01Icon,
  CheckmarkCircle01Icon,
  CopyIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";
import { useTerminalCardTarget } from "@/modules/ai/lib/useTerminalCardTarget";
import { createContext, memo, useCallback, useContext, useEffect, useRef, useState } from "react";

import { Shimmer } from "./shimmer";
import { highlight, isHighlightable, type HighlightedNode } from "./chat-code-lezer";

// True while the parent message is still streaming from the model. During this
// phase code is rendered as plain text: highlighting partial code is wasted
// work, and hiding it would leave command-heavy answers looking empty.
const StreamingCtx = createContext(false);
export const ChatStreamingProvider = StreamingCtx.Provider;

const POSIX_SHELL = new Set([
  "bash",
  "sh",
  "zsh",
  "shell",
  "console",
  "shellscript",
]);
const WINDOWS_SHELL = new Set([
  "powershell",
  "pwsh",
  "ps1",
  "ps",
  "cmd",
  "bat",
  "batch",
]);
const SHELL_LANGS = new Set([...POSIX_SHELL, ...WINDOWS_SHELL]);

function shellPrompt(lang: string): string {
  if (WINDOWS_SHELL.has(lang)) return lang === "cmd" || lang === "bat" || lang === "batch" ? ">" : "PS>";
  return "$";
}

function normalizeLangLabel(raw: string): string {
  const lower = raw.toLowerCase();
  if (POSIX_SHELL.has(lower)) return "bash";
  if (lower === "pwsh" || lower === "ps1" || lower === "ps") return "powershell";
  if (lower === "bat" || lower === "batch") return "cmd";
  return lower || "text";
}

export type ChatCodeBlockProps = {
  code: string;
  lang: string | null;
};

export function ChatCodeBlock({ code, lang }: ChatCodeBlockProps) {
  const streaming = useContext(StreamingCtx);
  const label = normalizeLangLabel(lang ?? "");

  if (streaming) {
    return code ? (
      <StreamingCodeBlock code={code} lang={label} />
    ) : (
      <GeneratingPlaceholder label={label} />
    );
  }

  if (SHELL_LANGS.has(label)) {
    return <CommandCard code={code} lang={label} />;
  }

  return <FinalizedCodeBlock code={code} lang={label} />;
}

/**
 * 流式中的代码块：内容照常逐字渲染，但跳过语法高亮——
 * 对半截代码反复跑 Lezer 是白费，而藏起内容会让以命令为主的答案看起来一片空白。
 */
function StreamingCodeBlock({ code, lang }: { code: string; lang: string }) {
  return (
    <div className="not-prose my-2 overflow-hidden rounded-lg border border-border/50 bg-muted/30">
      <div className="flex items-center gap-2 border-b border-border/40 bg-muted/20 px-3 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {lang}
        </span>
        <span className="inline-block size-1.5 animate-pulse rounded-full bg-muted-foreground/60" />
      </div>
      <pre className="m-0 max-h-[40vh] overflow-auto whitespace-pre-wrap px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-foreground">
        {code}
      </pre>
    </div>
  );
}

function GeneratingPlaceholder({ label }: { label: string }) {
  return (
    <div className="not-prose my-2 flex items-center gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
      <span className="inline-block size-1.5 animate-pulse rounded-full bg-muted-foreground/60" />
      <Shimmer duration={1.2}>
        {label === "text" ? "Generating code…" : `Generating ${label}…`}
      </Shimmer>
    </div>
  );
}

function BlockChrome({
  label,
  code,
  children,
}: {
  label: string;
  code: string;
  children: React.ReactNode;
}) {
  return (
    <div className="not-prose my-2 overflow-hidden rounded-lg border border-border/50 bg-muted/30">
      <div className="flex items-center justify-between gap-2 border-b border-border/40 bg-muted/20 px-3 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <CopyButton text={code} />
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

function FinalizedCodeBlock({ code, lang }: { code: string; lang: string }) {
  if (!isHighlightable(lang)) {
    return (
      <BlockChrome label={lang} code={code}>
        <pre className="m-0 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-foreground">
          {code}
        </pre>
      </BlockChrome>
    );
  }
  return (
    <BlockChrome label={lang} code={code}>
      <HighlightedPre code={code} lang={lang} />
    </BlockChrome>
  );
}

const HighlightedPre = memo(function HighlightedPre({
  code,
  lang,
}: {
  code: string;
  lang: string;
}) {
  const [nodes, setNodes] = useState<HighlightedNode[] | null>(null);
  const cancelRef = useRef(false);

  useEffect(() => {
    cancelRef.current = false;
    let cancelled = false;
    highlight(code, lang)
      .then((result) => {
        if (cancelled || cancelRef.current) return;
        setNodes(result);
      })
      .catch(() => {
        if (cancelled) return;
        setNodes(null);
      });
    return () => {
      cancelled = true;
      cancelRef.current = true;
    };
  }, [code, lang]);

  if (!nodes) {
    return (
      <pre className="m-0 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-foreground">
        {code}
      </pre>
    );
  }

  return (
    <pre className="m-0 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-foreground">
      {nodes.map((node, i) =>
        node.kind === "break" ? (
          <span key={i}>{"\n"}</span>
        ) : (
          <span key={i} className={node.cls || undefined}>
            {node.value}
          </span>
        ),
      )}
    </pre>
  );
});

function CommandCard({ code, lang }: { code: string; lang: string }) {
  const isMultiline = code.includes("\n");
  const prompt = shellPrompt(lang);
  const [sent, setSent] = useState(false);
  const tRef = useRef<number>(0);
  const terminalGuard = useTerminalCardTarget();
  useEffect(() => () => window.clearTimeout(tRef.current), []);

  // 注入命令到活动终端。execute=true 追加 \n（打字并执行）；
  // execute=false 只把命令逐字打字到提示符，回车留给用户自己按。
  //
  // TDSF 修复 2026-09-18（深度体检 S-01，P0）：PTY 把**每一个** \n 当成回车，所以
  // 多行代码块走 execute=false 时，除最后一行外的每一行都会立刻真实执行 —— 既不经
  // 审批卡也不经风险闸门，正是 2026-09-03"确认模式没点确认就自动执行"的翻版，
  // 只是这次藏在"多行"这个没人测过的形态里（单行验证全绿也照样错）。
  // 因此非 execute 路径只接受单行；多行留给用户复制，或显式用 auto 模式执行。
  const inject = useCallback(
    (execute: boolean): boolean => {
      const store = useChatStore.getState();
      // #91 第⑤条：只打进这张卡生成时那条终端。用户切走后再点 Run，
      // 命令不该落到另一个 shell（#89 之后那可能是另一台机器）。
      const block = terminalGuard.blockReason();
      if (block) {
        toast.warning(block);
        return false;
      }
      // 剥掉除 \t / \n 以外的 C0 控制字符与 DEL：它们会污染 readline 与回显。
      const payload = Array.from(code)
        .filter((ch) => {
          const cp = ch.codePointAt(0) ?? 0;
          return cp === 9 || cp === 10 || (cp >= 32 && cp !== 127);
        })
        .join("");
      if (!execute && payload.includes("\n")) {
        toast.warning("多行命令不自动打字到终端：换行会被 shell 当成回车逐行执行", {
          description: "请点「复制」自己粘贴，或切到 auto 模式让它整段执行。",
        });
        return false;
      }
      const text = execute ? payload + "\n" : payload;
      const ok = store.live.injectIntoActivePty(text);
      if (!ok) return false;
      setSent(true);
      window.clearTimeout(tRef.current);
      tRef.current = window.setTimeout(() => setSent(false), 1500);
      return true;
    },
    [code, terminalGuard],
  );

  // 手动点 Run：沿用既有语义——偏好开启且非教学模式时打字并执行，
  // 教学模式下只粘贴（学生自己回车）。
  const onRunClick = () => {
    const store = useChatStore.getState();
    inject(
      usePreferencesStore.getState().agentAutoTypeCommands && !store.teach,
    );
  };

  // TDSF 2026-09-18（用户钦定"要写入命令就自动输出到终端，别让我点 Run"）:
  // 命令卡渲染后自动打字到活动终端。
  // TDSF 2026-09-23（#114，用户改口"只有在教学模式下才有命令建议"）：**收到只在教学模式**
  // ——非教学模式下 agent 要执行一律走 ssh_command 工具调用，聊天里有卡可追溯；
  // 代码块卡只展示，手动 Run 照旧。理由：终端里出现无法追溯到"哪一步"的无声写入。
  // 安全边界保留 2026-09-03 的教训（"确认模式没点确认就自动打字机执行"= 绕过
  // HITL 审批）：自动打字只写不回车，执行权在用户手上。autoFiredRef 保证每张卡只注入一次。
  //
  // TDSF 2026-09-21（用户实测"打开历史对话把旧命令又输一遍"）：再加一道出身闸门
  // ——只有本次运行里生成的消息才自动打字，读回来的历史消息不注入（手动 Run 照旧）。
  const autoFiredRef = useRef(false);
  const autoTypeAllowed = useAutoTypeAllowed();
  useEffect(() => {
    if (autoFiredRef.current) return;
    // 出身闸门：历史消息（从盘上读回来的）一律不注入。见 autoTypeProvenance。
    if (!autoTypeAllowed) return;
    const store = useChatStore.getState();
    if (!usePreferencesStore.getState().agentAutoTypeCommands) return;
    // #114 模式闸门：只在教学模式自动打字（放在 ledger 之前，非教学模式不占记账位）
    if (!store.teach) return;
    // 自动打字专用闸门：Private 终端 / 用户正在敲的半行 / 不在提示符 → 不注入。
    // 手动 Run 是用户明示动作，不走这里。
    const gate = store.live.canAutoTypeToActiveTerminal;
    if (gate && !gate()) return;
    // 重挂重放 / 同批互踩由 ledger 拦住：见 autoTypeLedger 注释。
    // 记账要等注入成功——冷标签没有渲染槽时注入会返回 false，若此刻就记账，
    // 常见命令（git status）会在整个应用生命周期里再也不自动打字且无提示。
    if (!claimAutoType(code, store.activeSessionId)) return;
    autoFiredRef.current = true;
    // teach 档恒定"只打字不回车"，所以这里永远是 false（执行权归学生）。
    if (inject(false)) {
      markAutoTyped(code, store.activeSessionId);
    }
  }, [autoTypeAllowed, code, inject]);

  return (
    <div className="not-prose my-2 overflow-hidden rounded-lg border border-border/50 bg-muted/40">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {normalizeLangLabel(lang)}
        </span>
        <div className="flex items-center gap-1">
          <RunInTerminalButton sent={sent} onRun={onRunClick} />
          <CopyButton text={code} />
        </div>
      </div>
      <div className="border-t border-border/40 bg-background/40">
        <pre
          className={cn(
            "m-0 overflow-x-auto px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground",
            isMultiline ? "whitespace-pre" : "whitespace-pre-wrap",
          )}
        >
          {code.split("\n").map((line, i) => (
            <span key={i} className="flex">
              <span className="mr-2 select-none text-muted-foreground/70">
                {prompt}
              </span>
              <span>{line}</span>
            </span>
          ))}
        </pre>
      </div>
    </div>
  );
}

function RunInTerminalButton({
  sent,
  onRun,
}: {
  sent: boolean;
  onRun: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={onRun}
      className="h-5 gap-1 px-1.5 text-[10px] font-medium text-muted-foreground hover:text-foreground"
      aria-label="Run in active terminal"
      title="Run in active terminal"
    >
      <HugeiconsIcon
        icon={sent ? TerminalIcon : ArrowRight01Icon}
        size={11}
        strokeWidth={1.75}
      />
      <span>{sent ? "Sent" : "Run"}</span>
    </Button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const tRef = useRef<number>(0);

  useEffect(() => () => window.clearTimeout(tRef.current), []);

  const onCopy = async () => {
    if (!navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      tRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* swallow */
    }
  };

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      onClick={onCopy}
      className="size-5 shrink-0 text-muted-foreground hover:text-foreground"
      aria-label="Copy code"
    >
      <HugeiconsIcon
        icon={copied ? CheckmarkCircle01Icon : CopyIcon}
        size={11}
        strokeWidth={1.75}
      />
    </Button>
  );
}
