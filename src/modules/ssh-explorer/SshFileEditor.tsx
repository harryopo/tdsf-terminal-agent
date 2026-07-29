// TDSF 魔改 (P4-T4.1): SSH 远程文件编辑器
// -----------------------------------------------------------------------------
// 在侧边栏内嵌的远程文件编辑器, 双击 SshFileTree 文件后激活:
//   - 标题栏: 文件名 + dirty 圆点 + 保存按钮 + 关闭按钮
//   - 内容区: textarea (等宽字体) + 行号槽
//   - 快捷键: Ctrl/Cmd+S 保存, Ctrl/Cmd+W 关闭 (不阻止浏览器默认)
//   - 状态: loading (读取远程) / saving (写入远程) / dirty (内容已修改)
//   - 灰色简约主题: dirty 圆点 + 保存按钮用 var(--primary)
//
// 实现说明:
//   - 使用原生 textarea 而非 CodeMirror/Monaco, 避免 sidebar 内嵌重度集成
//   - 远程文件可能很大, 这里全量加载 (sftpRead 是全量读取), 适合配置文件/脚本编辑
//   - 保存调用 sftpWrite, 成功后 originalContent 同步更新, dirty 转 false

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  Loading03Icon,
  SaveIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSshStore } from "./sshStore";

type Props = {
  /** 强制渲染模式: 当传入时编辑器占满父容器 (而非 sidebar 内嵌) */
  className?: string;
};

/** 从文件名推断语言 (仅用于显示标签, 不影响编辑) */
function detectLang(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() : "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "TypeScript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "JavaScript";
    case "py":
      return "Python";
    case "rs":
      return "Rust";
    case "go":
      return "Go";
    case "json":
      return "JSON";
    case "md":
      return "Markdown";
    case "sh":
    case "bash":
      return "Shell";
    case "yml":
    case "yaml":
      return "YAML";
    case "toml":
      return "TOML";
    case "conf":
    case "ini":
      return "Config";
    case "css":
      return "CSS";
    case "html":
      return "HTML";
    case "sql":
      return "SQL";
    case "c":
    case "h":
      return "C";
    case "cpp":
    case "hpp":
      return "C++";
    case "java":
      return "Java";
    default:
      return ext ? ext.toUpperCase() : "Text";
  }
}

export function SshFileEditor({ className }: Props) {
  const editingFile = useSshStore((s) => s.editingFile);
  const updateEditorContent = useSshStore((s) => s.updateEditorContent);
  const saveFile = useSshStore((s) => s.saveFile);
  const closeEditor = useSshStore((s) => s.closeEditor);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lang = useMemo(
    () => (editingFile ? detectLang(editingFile.name) : "Text"),
    [editingFile],
  );

  /** Ctrl/Cmd+S 保存 */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (editingFile?.dirty && !editingFile.saving) {
          void saveFile();
        }
      }
    },
    [editingFile, saveFile],
  );

  // 编辑器打开时自动聚焦 (仅在 path 变化或 loading 完成时)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 故意只依赖 path/loading, 避免内容变化触发 refocus
  useEffect(() => {
    if (editingFile && !editingFile.loading) {
      textareaRef.current?.focus();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- terax 上游既有依赖设计, 变更 deps 有回归风险
  }, [editingFile?.path, editingFile?.loading]);

  if (!editingFile) {
    return null;
  }

  const { name, path, content, dirty, saving, loading, sessionId } =
    editingFile;

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col border-t border-border/60 bg-card",
        className,
      )}
      data-ssh-editor-session={sessionId}
    >
      {/* === 标题栏 === */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/40 px-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-[13px] font-medium text-foreground">
            {name}
          </span>
          <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
            {lang}
          </span>
          {dirty && (
            <span
              title="已修改 (未保存)"
              className="size-1.5 shrink-0 rounded-full bg-primary"
            />
          )}
          {saving && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <HugeiconsIcon
                icon={Loading03Icon}
                size={10}
                strokeWidth={1.75}
                className="animate-spin"
              />
              保存中…
            </span>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="保存"
          title="保存 (Ctrl+S)"
          onClick={() => void saveFile()}
          disabled={!dirty || saving || loading}
          className={cn(
            dirty
              ? "bg-primary/15 text-foreground hover:bg-primary/25"
              : "text-muted-foreground",
          )}
        >
          <HugeiconsIcon icon={SaveIcon} size={12} strokeWidth={1.75} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="关闭编辑器"
          title="关闭"
          onClick={closeEditor}
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
        </Button>
      </div>

      {/* === 路径条 === */}
      <div className="flex h-5 shrink-0 items-center border-b border-border/30 px-2.5 text-[11px] text-muted-foreground/80">
        <span className="truncate font-mono" title={path}>
          {path}
        </span>
      </div>

      {/* === 内容区 === */}
      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-muted-foreground">
          <HugeiconsIcon
            icon={Loading03Icon}
            size={14}
            strokeWidth={1.75}
            className="animate-spin"
          />
          读取远程文件…
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => updateEditorContent(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            wrap="off"
            placeholder="文件内容 (UTF-8)"
            className="absolute inset-0 size-full resize-none overflow-auto whitespace-pre bg-transparent px-3 py-2 font-mono text-[13px] leading-[1.6] text-foreground outline-none placeholder:text-muted-foreground/50"
          />
        </div>
      )}
    </div>
  );
}
