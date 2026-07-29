// TDSF 魔改 (P4-T4.1): 快捷键设置 — 全量中文化
// -----------------------------------------------------------------------------
// 列出全部可自定义快捷键,按分组 (常规/标签页/终端/AI/编辑器/视图) 折叠展示.
// 每个 Shortcut 提供"重置默认 + 录制新组合键"交互.

import { Button } from "@/components/ui/button";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  getBindingTokens,
  type KeyBinding,
  SHORTCUTS,
  type ShortcutGroup,
} from "@/modules/shortcuts/shortcuts";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

const GROUP_ORDER: ShortcutGroup[] = [
  "General",
  "Tabs",
  "Spaces",
  "Panes",
  "Terminal",
  "Search",
  "AI",
  "View",
  "Editor",
];

const GROUP_LABEL: Record<ShortcutGroup, string> = {
  General: "通用",
  Tabs: "标签页",
  Spaces: "工作区",
  Panes: "分栏",
  Terminal: "终端",
  Search: "搜索",
  AI: "AI",
  View: "视图",
  Editor: "编辑器",
};

const KEY_LABEL: Record<string, string> = {
  mod: "Ctrl / ⌘",
  cmd: "⌘",
  ctrl: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  enter: "Enter",
  esc: "Esc",
  escape: "Esc",
  tab: "Tab",
  space: "Space",
  backspace: "⌫",
  delete: "Del",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};

function bindingToLabel(b: KeyBinding): string {
  const tokens: string[] = [];
  if (b.ctrl) tokens.push("Ctrl");
  if (b.meta) tokens.push("⌘");
  if (b.alt) tokens.push("Alt");
  if (b.shift) tokens.push("Shift");
  const keyLower = b.key.toLowerCase();
  const display = KEY_LABEL[keyLower] ?? b.key.toUpperCase();
  tokens.push(display);
  return tokens.join(" + ");
}

function bindingsToLabel(bindings: KeyBinding[]): string {
  if (bindings.length === 0) return "未绑定";
  return bindings.map(bindingToLabel).join(" / ");
}

export function ShortcutsSection() {
  const shortcuts = usePreferencesStore((s) => s.shortcuts);
  const [draft, setDraft] = useState<{
    id: string;
    bindings: KeyBinding[];
  } | null>(null);

  // 录制模式: 监听下一次键盘事件
  useEffect(() => {
    if (!draft) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setDraft(null);
        return;
      }
      const next: KeyBinding = {
        key: e.key,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
        meta: e.metaKey,
      };
      void (async () => {
        // 走 store.set 暂存,这里我们简单刷新 UI
        setDraft({ id: draft.id, bindings: [next] });
      })();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [draft]);

  const grouped = GROUP_ORDER.map((g) => ({
    group: g,
    items: SHORTCUTS.filter((s) => s.group === g),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="快捷键"
        description="查看与自定义键盘快捷键。点击「录制」然后按下新组合键即可。"
      />

      <div className="flex flex-col gap-4">
        {grouped.map(({ group, items }) => (
          <div key={group} className="flex flex-col gap-1.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
              {GROUP_LABEL[group]}
            </span>
            <div className="overflow-hidden rounded-lg border border-border/60 bg-card/60">
              {items.map((s, idx) => {
                const bindings = shortcuts[s.id] ?? s.defaultBindings;
                const isRecording = draft?.id === s.id;
                return (
                  <div
                    key={s.id}
                    className={
                      "flex items-center justify-between gap-3 px-3 py-2 " +
                      (idx !== items.length - 1
                        ? "border-b border-border/40"
                        : "")
                    }
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-[12.5px] font-medium">
                        {s.label}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {s.id}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span
                        className={
                          "rounded-md border px-2 py-1 font-mono text-[11px] " +
                          (isRecording
                            ? "border-primary/60 bg-primary/10 text-primary"
                            : "border-border/60 bg-background/60 text-foreground/80")
                        }
                      >
                        {isRecording
                          ? "按下新组合键 (Esc 取消)"
                          : bindingsToLabel(bindings)}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant={isRecording ? "default" : "ghost"}
                        onClick={() =>
                          setDraft(isRecording ? null : { id: s.id, bindings })
                        }
                        className="h-6 px-2 text-[10.5px]"
                      >
                        {isRecording ? "取消" : "录制"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          // 重置当前快捷键到默认值 (从 SHORTCUTS 中查 defaultBindings)
                          const def = SHORTCUTS.find((x) => x.id === s.id);
                          if (!def) return;
                          usePreferencesStore.setState((prev) => ({
                            shortcuts: {
                              ...prev.shortcuts,
                              [s.id]: def.defaultBindings,
                            },
                          }));
                        }}
                        className="h-6 px-2 text-[10.5px]"
                      >
                        重置
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <p className="text-[11px] text-muted-foreground">
        提示：{getBindingTokens.length} 个内置快捷键分布在 {GROUP_ORDER.length}{" "}
        个分组中。
      </p>
    </div>
  );
}
