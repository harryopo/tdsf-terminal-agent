// 编辑器行为的唯一设置入口；持久化键与执行逻辑保持不变。
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  AUTO_SAVE_DELAY_MAX,
  AUTO_SAVE_DELAY_MIN,
  type EditorFormatter,
  setEditorAutoSave,
  setEditorAutoSaveDelay,
  setEditorCustomFormatCommand,
  setEditorFontSize,
  setEditorFormatOnSave,
  setEditorFormatter,
  setEditorWordWrap,
  setVimMode,
  TERMINAL_FONT_SIZES,
} from "@/modules/settings/store";
import { SettingRow } from "../components/SettingRow";
import { LspServersGroup } from "../components/LspServersGroup";
import { SectionHeader } from "../components/SectionHeader";

const FORMATTER_OPTIONS: { value: EditorFormatter; label: string }[] = [
  { value: "lsp", label: "LSP 服务器" },
  { value: "biome", label: "Biome" },
  { value: "prettier", label: "Prettier" },
  { value: "ruff", label: "Ruff (Python)" },
  { value: "rustfmt", label: "rustfmt (Rust)" },
  { value: "gofmt", label: "gofmt (Go)" },
  { value: "clang-format", label: "clang-format (C/C++)" },
  { value: "shfmt", label: "shfmt (Shell)" },
  { value: "zigfmt", label: "zigfmt (Zig)" },
  { value: "custom", label: "自定义命令" },
];

export function EditorSection() {
  const vimMode = usePreferencesStore((s) => s.vimMode);
  const editorFontSize = usePreferencesStore((s) => s.editorFontSize);
  const editorWordWrap = usePreferencesStore((s) => s.editorWordWrap);
  const editorAutoSave = usePreferencesStore((s) => s.editorAutoSave);
  const editorAutoSaveDelay = usePreferencesStore((s) => s.editorAutoSaveDelay);
  const editorFormatOnSave = usePreferencesStore((s) => s.editorFormatOnSave);
  const editorFormatter = usePreferencesStore((s) => s.editorFormatter);
  const editorCustomFormatCommand = usePreferencesStore(
    (s) => s.editorCustomFormatCommand,
  );
  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="编辑器"
        description="字体、换行、保存与格式化，以及语言服务器。"
      />

      {/* === 编辑器 === */}
      <div className="flex flex-col gap-2">
        <Label>编辑器</Label>
        <SettingRow
          title="字体大小"
          description={`当前 ${editorFontSize}px。范围 8-32。`}
        >
          <Select
            value={String(editorFontSize)}
            onValueChange={(v) => void setEditorFontSize(Number(v))}
          >
            <SelectTrigger className="h-7 w-24 text-[11.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_FONT_SIZES.map((s) => (
                <SelectItem key={s} value={String(s)}>
                  {s}px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="自动换行"
          description="编辑器内文本超过视区宽度时自动换行。"
        >
          <Switch
            checked={editorWordWrap}
            onCheckedChange={(v) => void setEditorWordWrap(v)}
          />
        </SettingRow>
        <SettingRow
          title="Vim 模式"
          description="启用 Vim 按键绑定（hjkl/操作符/寄存器等）。"
        >
          <Switch
            checked={vimMode}
            onCheckedChange={(v) => void setVimMode(v)}
          />
        </SettingRow>
        <SettingRow
          title="自动保存"
          description="停止输入后自动保存（默认 1 秒）。关闭此开关后需要 Ctrl/Cmd+S 手动保存。"
        >
          <div className="flex items-center gap-3">
            <Switch
              checked={editorAutoSave}
              onCheckedChange={(v) => void setEditorAutoSave(v)}
            />
            {editorAutoSave && (
              <Input
                type="number"
                min={AUTO_SAVE_DELAY_MIN}
                max={AUTO_SAVE_DELAY_MAX}
                value={editorAutoSaveDelay}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) void setEditorAutoSaveDelay(n);
                }}
                className="h-7 w-20 text-[11.5px]"
              />
            )}
          </div>
        </SettingRow>
        <SettingRow
          title="保存时格式化"
          description="保存文件时自动调用所选格式化工具。"
        >
          <div className="flex items-center gap-3">
            <Switch
              checked={editorFormatOnSave}
              onCheckedChange={(v) => void setEditorFormatOnSave(v)}
            />
            <Select
              value={editorFormatter}
              onValueChange={(v) =>
                void setEditorFormatter(v as EditorFormatter)
              }
            >
              <SelectTrigger className="h-7 w-36 text-[11.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FORMATTER_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SettingRow>
        {editorFormatter === "custom" && (
          <SettingRow
            title="自定义格式化命令"
            description="Shell 命令模板,使用 {file} 表示带引号的文件路径。例如: prettier --write {file}"
          >
            <Input
              value={editorCustomFormatCommand}
              onChange={(e) =>
                void setEditorCustomFormatCommand(e.target.value)
              }
              placeholder="prettier --write {file}"
              className="h-7 w-72 font-mono text-[11.5px]"
            />
          </SettingRow>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label>语言服务器 (LSP)</Label>
        <LspServersGroup />
      </div>

      <div className="flex flex-col gap-2">
        <Label>提示</Label>
        <p className="text-[11px] text-muted-foreground">
          通过 LSP
          协议,编辑器可获得代码补全、跳转定义、悬浮文档、引用查找、重命名等高级能力。
          已安装的 LSP 服务器会按文件类型自动启用。
        </p>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}
