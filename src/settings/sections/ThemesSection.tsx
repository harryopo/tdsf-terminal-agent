// TDSF 魔改 (P4-T4.1): 主题设置 (颜色/背景图) — 全量中文化
// -----------------------------------------------------------------------------
// 涵盖:
//   - 主题色板选择 (dracula / nord / tokyo-night / gruvbox 等)
//   - 背景图 (内置 / 自定义 / 透明度 / 模糊)
//   - 编辑器配色方案

import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  EDITOR_THEME_AUTO,
  EDITOR_THEME_LABELS,
  EDITOR_THEME_MODE,
  EDITOR_THEMES,
  type EditorThemePref,
  setBackgroundBlur,
  setBackgroundImageId,
  setBackgroundKind,
  setBackgroundOpacity,
  setEditorTheme,
  setThemeId,
} from "@/modules/settings/store";
import { listBuiltinThemes, type Theme } from "@/modules/theme";
import { useThemeFileEditing } from "@/modules/theme/useThemeFileEditing";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

const THEME_GROUPS: { label: string; items: Theme[] }[] = (() => {
  const all = listBuiltinThemes();
  const light: Theme[] = [];
  const dark: Theme[] = [];
  for (const t of all) {
    if (t.variants?.light) light.push(t);
    if (t.variants?.dark) dark.push(t);
  }
  return [
    { label: "深色", items: dark },
    { label: "浅色", items: light },
  ];
})();

export function ThemesSection() {
  const themeId = usePreferencesStore((s) => s.themeId);
  const editorTheme = usePreferencesStore((s) => s.editorTheme);
  const backgroundKind = usePreferencesStore((s) => s.backgroundKind);
  const backgroundImageId = usePreferencesStore((s) => s.backgroundImageId);
  const backgroundOpacity = usePreferencesStore((s) => s.backgroundOpacity);
  const backgroundBlur = usePreferencesStore((s) => s.backgroundBlur);

  const { availableImages, pickCustomImage, clearCustomImage } =
    useThemeFileEditing();

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="主题"
        description="应用主题色板、编辑器配色与背景图。"
      />

      {/* === 应用主题 === */}
      <div className="flex flex-col gap-2">
        <Label>应用主题</Label>
        {THEME_GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col gap-1.5">
            <span className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
              {group.label}
            </span>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
              {group.items.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => void setThemeId(t.id)}
                  className={
                    "flex h-16 items-center gap-2 rounded-lg border bg-card px-3 text-left transition-all " +
                    (themeId === t.id
                      ? "border-foreground/60 ring-1 ring-foreground/20"
                      : "border-border/60 hover:border-border")
                  }
                >
                  <div
                    aria-hidden
                    className="h-10 w-10 shrink-0 rounded-md border border-border/40"
                    style={{
                      background: `linear-gradient(135deg, var(--tdsf-theme-preview-from, #1f2937) 0%, var(--tdsf-theme-preview-to, #0f172a) 100%)`,
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-medium">
                      {t.name}
                    </div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">
                      {t.id}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* === 编辑器配色 === */}
      <div className="flex flex-col gap-2">
        <Label>编辑器配色</Label>
        <SettingRow
          title="编辑器配色方案"
          description="Monaco 编辑器使用的主题。"
        >
          <div className="flex flex-col items-end gap-1">
            <select
              value={editorTheme}
              onChange={(e) =>
                void setEditorTheme(e.target.value as EditorThemePref)
              }
              className="h-7 w-44 rounded-md border border-border/60 bg-card px-2 text-[11.5px]"
            >
              <option value={EDITOR_THEME_AUTO}>跟随应用主题</option>
              {EDITOR_THEMES.map((id) => (
                <option key={id} value={id}>
                  {EDITOR_THEME_LABELS[id]} ({EDITOR_THEME_MODE[id]})
                </option>
              ))}
            </select>
          </div>
        </SettingRow>
      </div>

      {/* === 背景图 === */}
      <div className="flex flex-col gap-2">
        <Label>背景图</Label>
        <SettingRow
          title="启用背景图"
          description="在主窗口与设置窗口底层铺一张图片,营造氛围。"
        >
          <Switch
            checked={backgroundKind === "image"}
            onCheckedChange={(v) =>
              void setBackgroundKind(v ? "image" : "none")
            }
          />
        </SettingRow>
        {backgroundKind === "image" && (
          <>
            <SettingRow
              title="背景图片"
              description="选择内置图片或加载本地图片 (建议宽屏 16:9/4:3)。"
            >
              <div className="flex flex-col items-end gap-2">
                <div className="grid grid-cols-4 gap-1.5">
                  {availableImages.map((img) => (
                    <button
                      key={img.id}
                      type="button"
                      onClick={() => void setBackgroundImageId(img.id)}
                      className={
                        "h-12 w-16 overflow-hidden rounded-md border-2 " +
                        (backgroundImageId === img.id
                          ? "border-foreground/60"
                          : "border-transparent opacity-70 hover:opacity-100")
                      }
                      style={{
                        backgroundImage: `url(${img.url})`,
                        backgroundSize: "cover",
                      }}
                      title={img.label}
                    />
                  ))}
                  <button
                    type="button"
                    onClick={async () => {
                      const id = await pickCustomImage();
                      if (id) await setBackgroundImageId(id);
                    }}
                    className="h-12 w-16 rounded-md border border-dashed border-border/60 text-[10px] text-muted-foreground hover:border-border"
                  >
                    自定义
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void clearCustomImage();
                      void setBackgroundImageId(null);
                    }}
                    className="h-12 w-16 rounded-md border border-border/40 text-[10px] text-muted-foreground hover:border-border"
                  >
                    清除
                  </button>
                </div>
              </div>
            </SettingRow>
            <SettingRow
              title="背景不透明度"
              description={`当前 ${Math.round(backgroundOpacity * 100)}%。`}
            >
              <div className="flex w-56 items-center gap-2">
                <Slider
                  min={0}
                  max={1}
                  step={0.05}
                  value={[backgroundOpacity]}
                  onValueChange={([v]) => void setBackgroundOpacity(v)}
                />
                <span className="w-10 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                  {Math.round(backgroundOpacity * 100)}%
                </span>
              </div>
            </SettingRow>
            <SettingRow
              title="背景模糊"
              description={`当前 ${backgroundBlur}px。`}
            >
              <div className="flex w-56 items-center gap-2">
                <Slider
                  min={0}
                  max={32}
                  step={1}
                  value={[backgroundBlur]}
                  onValueChange={([v]) => void setBackgroundBlur(v)}
                />
                <span className="w-10 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                  {backgroundBlur}px
                </span>
              </div>
            </SettingRow>
          </>
        )}
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
