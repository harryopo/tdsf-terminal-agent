// TDSF 魔改 (P4-T4.1): 通用设置 (主题/资源管理器/终端/启动/SSH 凭据) — 全量中文化
// -----------------------------------------------------------------------------
// 涵盖:
//   - 外观模式 (浅色/深色/跟随系统)
//   - 界面缩放
//   - 资源管理器 (显示隐藏文件 / Git 装饰)
//   - 终端 (字体/光标/滚动/WebGL/字符间距/字体粗细/shell)
//   - 启动 (开机自启 / 恢复窗口)
//   - 智能体通知
//
// 每个 SettingRow 的 title/description 全部中文; 控件用 Switch/Select/Slider/Input 组件.

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  AUTO_SAVE_DELAY_MAX,
  AUTO_SAVE_DELAY_MIN,
  type AutocompleteTrigger,
  type EditorFormatter,
  setAgentNotifications,
  setAutocompleteTrigger,
  setAutostart,
  setEditorAutoSave,
  setEditorAutoSaveDelay,
  setEditorCustomFormatCommand,
  setEditorFontSize,
  setEditorFormatOnSave,
  setEditorFormatter,
  setEditorWordWrap,
  setExplorerGitDecorations,
  setRestoreWindowState,
  setServerMonitorInterval,
  SERVER_MONITOR_INTERVAL_PRESETS,
  setShowHidden,
  setTerminalCursorBlink,
  setTerminalFontFamily,
  setTerminalFontSize,
  setTerminalFontWeight,
  setTerminalLetterSpacing,
  setTerminalScrollback,
  setTerminalShell,
  setTerminalWebglEnabled,
  setTheme,
  setVimMode,
  setZoomLevel,
  TERMINAL_FONT_SIZES,
  TERMINAL_SCROLLBACK_PRESETS,
} from "@/modules/settings/store";
import {
  ComputerIcon,
  Moon02Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

const APPEARANCE = [
  { id: "system" as const, label: "跟随系统", icon: ComputerIcon },
  { id: "light" as const, label: "浅色", icon: Sun03Icon },
  { id: "dark" as const, label: "深色", icon: Moon02Icon },
];

const FONT_WEIGHTS = [
  { id: "normal", label: "常规" },
  { id: "500", label: "中等" },
  { id: "600", label: "半粗" },
  { id: "bold", label: "粗体" },
];

const SHELL_OPTIONS: { value: string; label: string; note?: string }[] = [
  { value: "", label: "自动检测 (跟随系统)" },
  { value: "pwsh.exe", label: "PowerShell 7 (pwsh)" },
  { value: "powershell.exe", label: "Windows PowerShell" },
  { value: "cmd.exe", label: "命令提示符 (CMD)" },
  { value: "wsl.exe", label: "WSL 默认发行版" },
  { value: "bash.exe", label: "Git Bash" },
  { value: "/bin/zsh", label: "Zsh (macOS/Linux)" },
  { value: "/bin/bash", label: "Bash (Linux)" },
];

const AUTOCOMPLETE_TRIGGER_OPTIONS: {
  value: AutocompleteTrigger;
  label: string;
}[] = [
  { value: "auto", label: "自动 (边输入边建议)" },
  { value: "manual", label: "手动 (按快捷键触发)" },
];

const SERVER_MONITOR_INTERVAL_OPTIONS = SERVER_MONITOR_INTERVAL_PRESETS.map(
  (ms) => ({
    value: ms,
    label:
      ms === 2000 ? "2 秒 (高频)" :
      ms === 3000 ? "3 秒 (推荐)" :
      ms === 5000 ? "5 秒" :
      "10 秒 (省电)",
  }),
);

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

export function GeneralSection() {
  const theme = usePreferencesStore((s) => s.theme);
  const zoomLevel = usePreferencesStore((s) => s.zoomLevel);
  const showHidden = usePreferencesStore((s) => s.showHidden);
  const explorerGitDecorations = usePreferencesStore(
    (s) => s.explorerGitDecorations,
  );
  const terminalFontFamily = usePreferencesStore((s) => s.terminalFontFamily);
  const terminalFontSize = usePreferencesStore((s) => s.terminalFontSize);
  const terminalFontWeight = usePreferencesStore((s) => s.terminalFontWeight);
  const terminalShell = usePreferencesStore((s) => s.terminalShell);
  const terminalLetterSpacing = usePreferencesStore(
    (s) => s.terminalLetterSpacing,
  );
  const terminalScrollback = usePreferencesStore((s) => s.terminalScrollback);
  const terminalCursorBlink = usePreferencesStore((s) => s.terminalCursorBlink);
  const terminalWebglEnabled = usePreferencesStore(
    (s) => s.terminalWebglEnabled,
  );
  const autostart = usePreferencesStore((s) => s.autostart);
  const restoreWindowState = usePreferencesStore((s) => s.restoreWindowState);
  const agentNotifications = usePreferencesStore((s) => s.agentNotifications);
  const serverMonitorInterval = usePreferencesStore(
    (s) => s.serverMonitorInterval,
  );
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
  const autocompleteTrigger = usePreferencesStore((s) => s.autocompleteTrigger);

  const [shellDraft, setShellDraft] = useState(terminalShell);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="通用"
        description="主题模式、终端行为、编辑器与启动选项。"
      />

      {/* === 外观 === */}
      <div className="flex flex-col gap-2">
        <Label>外观模式</Label>
        <div className="grid grid-cols-3 gap-2">
          {APPEARANCE.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => void setTheme(o.id)}
              className={
                "group flex h-20 flex-col items-center justify-center gap-1.5 rounded-lg border bg-card transition-all " +
                (theme === o.id
                  ? "border-foreground/60 ring-1 ring-foreground/20"
                  : "border-border/60 hover:border-border")
              }
            >
              <HugeiconsIcon icon={o.icon} size={18} strokeWidth={1.5} />
              <span className="text-[11.5px]">{o.label}</span>
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          主题、背景图与个性化设置请前往「主题」选项卡。
        </p>
      </div>

      {/* === 缩放 === */}
      <SettingRow
        title="界面缩放"
        description={`当前 ${Math.round(zoomLevel * 100)}%。调整后立即生效。`}
      >
        <div className="flex w-56 items-center gap-2">
          <Slider
            min={0.75}
            max={1.5}
            step={0.05}
            value={[zoomLevel]}
            onValueChange={([v]) => void setZoomLevel(v)}
          />
          <span className="w-12 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
            {Math.round(zoomLevel * 100)}%
          </span>
        </div>
      </SettingRow>

      {/* === 资源管理器 === */}
      <div className="flex flex-col gap-2">
        <Label>资源管理器</Label>
        <SettingRow
          title="显示隐藏文件"
          description="在文件资源管理器和搜索中包含点前缀文件（.env、.gitignore、.config 等）。"
        >
          <Switch
            checked={showHidden}
            onCheckedChange={(v) => void setShowHidden(v)}
          />
        </SettingRow>
        <SettingRow
          title="Git 装饰"
          description="在资源管理器中对修改过的文件着色，对 Git 忽略的项降亮。"
        >
          <Switch
            checked={explorerGitDecorations}
            onCheckedChange={(v) => void setExplorerGitDecorations(v)}
          />
        </SettingRow>
      </div>

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

      {/* === 终端 === */}
      <div className="flex flex-col gap-2">
        <Label>终端</Label>
        <SettingRow
          title="字体族"
          description="自定义终端字体族名称（留空使用默认 JetBrains Mono）。"
        >
          <Input
            value={terminalFontFamily}
            onChange={(e) => void setTerminalFontFamily(e.target.value)}
            placeholder="JetBrains Mono"
            className="h-7 w-56 font-mono text-[11.5px]"
          />
        </SettingRow>
        <SettingRow
          title="字体大小"
          description={`当前 ${terminalFontSize}px。范围 8-32。`}
        >
          <Select
            value={String(terminalFontSize)}
            onValueChange={(v) => void setTerminalFontSize(Number(v))}
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
        <SettingRow title="字体粗细" description="终端字符的粗细程度。">
          <Select
            value={terminalFontWeight}
            onValueChange={(v) => void setTerminalFontWeight(v)}
          >
            <SelectTrigger className="h-7 w-24 text-[11.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FONT_WEIGHTS.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="字符间距"
          description="字符间的额外水平间距（像素）。使用负值可收紧 Nerd Fonts 字体。"
        >
          <div className="flex w-56 items-center gap-2">
            <Slider
              min={-2}
              max={4}
              step={1}
              value={[terminalLetterSpacing]}
              onValueChange={([v]) => void setTerminalLetterSpacing(v)}
            />
            <span className="w-10 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
              {terminalLetterSpacing}px
            </span>
          </div>
        </SettingRow>
        <SettingRow
          title="光标闪烁"
          description="启用后终端光标会闪烁；关闭则保持静态方块/竖线。"
        >
          <Switch
            checked={terminalCursorBlink}
            onCheckedChange={(v) => void setTerminalCursorBlink(v)}
          />
        </SettingRow>
        <SettingRow
          title="WebGL 渲染"
          description="启用 WebGL 加速（推荐）。低端设备或显卡驱动异常时关闭可回退 Canvas。"
        >
          <Switch
            checked={terminalWebglEnabled}
            onCheckedChange={(v) => void setTerminalWebglEnabled(v)}
          />
        </SettingRow>
        <SettingRow
          title="滚动回溯"
          description={`终端保留的历史行数。当前 ${terminalScrollback.toLocaleString()} 行。`}
        >
          <Select
            value={String(terminalScrollback)}
            onValueChange={(v) => void setTerminalScrollback(Number(v))}
          >
            <SelectTrigger className="h-7 w-28 text-[11.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_SCROLLBACK_PRESETS.map((s) => (
                <SelectItem key={s} value={String(s)}>
                  {s.toLocaleString()} 行
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="集成终端 Shell"
          description="指定集成终端启动的 Shell。留空则自动检测。某些 shell 不支持命令块与目录跟踪。"
        >
          <div className="flex items-center gap-2">
            <Input
              value={shellDraft}
              onChange={(e) => setShellDraft(e.target.value)}
              onBlur={() => void setTerminalShell(shellDraft)}
              placeholder="自动检测"
              className="h-7 w-56 font-mono text-[11.5px]"
            />
            <Select
              value={shellDraft || "auto"}
              onValueChange={(v) => {
                const next = v === "auto" ? "" : v;
                setShellDraft(next);
                void setTerminalShell(next);
              }}
            >
              <SelectTrigger className="h-7 w-44 text-[11.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SHELL_OPTIONS.map((o) => (
                  <SelectItem key={o.value || "auto"} value={o.value || "auto"}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SettingRow>
      </div>

      {/* === 智能体与代码补全 === */}
      <div className="flex flex-col gap-2">
        <Label>智能体</Label>
        <SettingRow
          title="智能体通知"
          description="智能体完成后弹系统通知（即使窗口不在前台）。"
        >
          <Switch
            checked={agentNotifications}
            onCheckedChange={(v) => void setAgentNotifications(v)}
          />
        </SettingRow>
        <SettingRow
          title="代码补全触发方式"
          description="代码补全（AI 智能联想）的触发模式。"
        >
          <Select
            value={autocompleteTrigger}
            onValueChange={(v) =>
              void setAutocompleteTrigger(v as AutocompleteTrigger)
            }
          >
            <SelectTrigger className="h-7 w-56 text-[11.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTOCOMPLETE_TRIGGER_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </div>

      {/* === 服务器监控 === */}
      <div className="flex flex-col gap-2">
        <Label>服务器监控</Label>
        <SettingRow
          title="采集间隔"
          description="SSH 服务器实时监控的数据刷新间隔。间隔越短越实时，但对服务器负载越高。"
        >
          <Select
            value={String(serverMonitorInterval)}
            onValueChange={(v) => void setServerMonitorInterval(Number(v))}
          >
            <SelectTrigger className="h-7 w-56 text-[11.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SERVER_MONITOR_INTERVAL_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={String(o.value)}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </div>

      {/* === 启动 === */}
      <div className="flex flex-col gap-2">
        <Label>启动</Label>
        <SettingRow
          title="开机自启"
          description="系统启动时自动打开 TDSF Terminal Agent。"
        >
          <Switch
            checked={autostart}
            onCheckedChange={(v) => void setAutostart(v)}
          />
        </SettingRow>
        <SettingRow
          title="恢复窗口状态"
          description="重新启动时恢复上次的窗口大小、位置与已打开标签页。"
        >
          <Switch
            checked={restoreWindowState}
            onCheckedChange={(v) => void setRestoreWindowState(v)}
          />
        </SettingRow>
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            if (typeof window !== "undefined") {
              window.location.reload();
            }
          }}
        >
          重新加载应用以应用更改
        </Button>
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
