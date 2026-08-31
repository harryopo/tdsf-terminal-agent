// TDSF 魔改 (P2 代码片段管理, 方案书 v1.1 §5): 片段插入确认对话框（变量解析）
// -----------------------------------------------------------------------------
// 流程: 用户点击片段"插入"→ 有变量时弹出本对话框:
//   - 内置变量 {{cwd}}: 自动解析为当前活动终端目录（只读展示）
//   - 自定义变量 {{name}}: 输入框（预填 defaultValue）
//   - 实时预览插值后的最终命令（mono 字体）
//   - 确认 → onInsertCommand(final)

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { TerminalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { BUILTIN_VARS, type Snippet } from "./types";
import { collectPlaceholders, interpolate } from "./lib/snippetStore";

interface Props {
  snippet: Snippet;
  /** 当前活动终端 cwd（{{cwd}} 自动解析值，可为空） */
  currentCwd?: string;
  /** 插入命令到当前活动终端，返回是否成功 */
  onInsertCommand: (cmd: string) => boolean;
  onOpenChange: (open: boolean) => void;
}

export function SnippetRunDialog({
  snippet,
  currentCwd,
  onInsertCommand,
  onOpenChange,
}: Props) {
  // 以命令中实际占位符为准，逐一定义输入状态
  const placeholders = useMemo(() => collectPlaceholders(snippet.command), [snippet.command]);
  const customVars = useMemo(
    () =>
      placeholders.filter(
        (p) => !(BUILTIN_VARS as readonly string[]).includes(p),
      ),
    [placeholders],
  );
  const hasCwd = placeholders.includes("cwd");

  // 自定义变量值（初始化 = defaultValue）
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const p of customVars) {
      init[p] = snippet.variables.find((v) => v.name === p)?.defaultValue ?? "";
    }
    return init;
  });

  // 最终命令: 自定义变量 + 内置 cwd 合并插值
  const finalCommand = useMemo(() => {
    const all: Record<string, string> = { ...values };
    if (hasCwd && currentCwd) all.cwd = currentCwd;
    return interpolate(snippet.command, all);
  }, [snippet.command, values, hasCwd, currentCwd]);

  // 还有未填的自定义变量 → 插入前提示
  const missingVars = customVars.filter((p) => !values[p]?.trim());
  const canInsert = missingVars.length === 0;

  const setValue = useCallback((name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  const handleInsert = () => {
    if (!canInsert) return;
    const ok = onInsertCommand(finalCommand);
    if (ok) {
      onOpenChange(false);
    } else {
      toast.error("没有活动的终端，无法插入片段");
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{snippet.name}</DialogTitle>
          {snippet.description && (
            <DialogDescription>{snippet.description}</DialogDescription>
          )}
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* 变量输入区 */}
          {placeholders.length > 0 && (
            <div className="flex flex-col gap-2.5 rounded-md border border-border/60 bg-muted/20 p-3">
              {hasCwd && (
                <div className="grid gap-1">
                  <Label className="text-[11px] text-muted-foreground">
                    内置变量{" "}
                    <code className="rounded bg-muted px-1 font-mono">
                      {"{{cwd}}"}
                    </code>{" "}
                    — 当前目录（自动）
                  </Label>
                  <p className="truncate font-mono text-[11px] text-foreground/80">
                    {currentCwd || "（未知，插入后保留占位符）"}
                  </p>
                </div>
              )}
              {customVars.map((name) => (
                <div key={name} className="grid gap-1">
                  <Label
                    htmlFor={`snippet-run-${name}`}
                    className="text-[11px] text-muted-foreground"
                  >
                    变量{" "}
                    <code className="rounded bg-muted px-1 font-mono">
                      {"{{"}
                      {name}
                      {"}}"}
                    </code>
                  </Label>
                  <Input
                    id={`snippet-run-${name}`}
                    value={values[name] ?? ""}
                    onChange={(e) => setValue(name, e.target.value)}
                    placeholder={`填写 ${name} 的值`}
                    className="font-mono text-[12px]"
                    autoFocus={customVars[0] === name}
                    data-testid={`snippet-run-input-${name}`}
                  />
                </div>
              ))}
            </div>
          )}

          {/* 最终命令预览 */}
          <div className="grid gap-1.5">
            <Label className="text-[11px] text-muted-foreground">
              即将插入的命令
            </Label>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/60 bg-background p-2.5 font-mono text-[11.5px] leading-relaxed text-foreground">
              {finalCommand}
            </pre>
            <p className="flex items-center gap-1 text-[10.5px] text-muted-foreground/80">
              <HugeiconsIcon
                icon={TerminalIcon}
                size={11}
                strokeWidth={1.75}
                className="shrink-0"
              />
              插入后将自动聚焦到当前活动终端
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleInsert}
            disabled={!canInsert}
            className={cn(!canInsert && "opacity-60")}
            data-testid="snippet-run-insert"
          >
            插入终端
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
