// TDSF 魔改 (P2 代码片段管理, 方案书 v1.1 §5): 片段新建/编辑对话框
// -----------------------------------------------------------------------------
// 字段: name / command / description / tags（逗号分隔）
// variables 不手动维护——保存时从 command 自动提取 {{name}} 占位符，
// 保留已存在变量的 defaultValue，新增变量无默认值（派生数据，简单可靠）。

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
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { InformationCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useState } from "react";
import { collectPlaceholders } from "./lib/snippetStore";
import type { Snippet } from "./types";

interface Props {
  /** create = 新建；edit = 编辑已有片段 */
  mode: "create" | "edit";
  /** edit 模式下传入的片段 */
  snippet?: Snippet;
  onOpenChange: (open: boolean) => void;
  /** 保存回调（Panel 层分发 addSnippet / updateSnippet） */
  onSave: (data: {
    name: string;
    command: string;
    description?: string;
    tags: string[];
  }) => void;
}

export function SnippetEditorDialog({
  mode,
  snippet,
  onOpenChange,
  onSave,
}: Props) {
  const [name, setName] = useState(snippet?.name ?? "");
  const [command, setCommand] = useState(snippet?.command ?? "");
  const [description, setDescription] = useState(snippet?.description ?? "");
  const [tagsText, setTagsText] = useState(snippet?.tags.join(", ") ?? "");

  // 从命令实时提取占位符（展示提示用）
  const placeholders = useMemo(() => collectPlaceholders(command), [command]);

  const canSave = name.trim().length > 0 && command.trim().length > 0;

  const handleSave = () => {
    if (!canSave) return;
    const tags = tagsText
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    onSave({
      name: name.trim(),
      command: command.trim(),
      description: description.trim() || undefined,
      tags,
    });
    onOpenChange(false);
  };

  // ESC / 关闭时直接关闭（未保存内容丢弃）
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "新建代码片段" : "编辑代码片段"}
          </DialogTitle>
          <DialogDescription>
            收藏常用命令，插入终端时可填充变量占位符
            {" {{name}} "}。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="snippet-name" className="text-[11px] text-muted-foreground">
              名称
            </Label>
            <Input
              id="snippet-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如: 查看磁盘占用"
              autoFocus
              data-testid="snippet-editor-name"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="snippet-command" className="text-[11px] text-muted-foreground">
              命令
            </Label>
            <Textarea
              id="snippet-command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder='例如: df -h | grep -E "{{mount}}|^Filesystem"'
              rows={4}
              className="font-mono text-[12px]"
              data-testid="snippet-editor-command"
            />
            {placeholders.length > 0 && (
              <p className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
                <HugeiconsIcon
                  icon={InformationCircleIcon}
                  size={11}
                  strokeWidth={1.75}
                  className="shrink-0"
                />
                检测到变量:
                {placeholders.map((p) => (
                  <code key={p} className="rounded bg-muted px-1 font-mono">
                    {"{{"}
                    {p}
                    {"}}"}
                  </code>
                ))}
                <span className="text-muted-foreground/70">（插入时可填写）</span>
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label
              htmlFor="snippet-description"
              className="text-[11px] text-muted-foreground"
            >
              描述
            </Label>
            <Input
              id="snippet-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="可选，例如: 查看各挂载点磁盘使用率"
              data-testid="snippet-editor-description"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="snippet-tags" className="text-[11px] text-muted-foreground">
              标签
            </Label>
            <Input
              id="snippet-tags"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="可选，逗号分隔，例如: 磁盘, 运维"
              data-testid="snippet-editor-tags"
            />
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
            onClick={handleSave}
            disabled={!canSave}
            className={cn(!canSave && "opacity-60")}
            data-testid="snippet-editor-save"
          >
            {mode === "create" ? "创建" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
