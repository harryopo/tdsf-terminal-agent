import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setTerminalOutputHighlightEnabled } from "@/modules/settings/store";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

const LEGEND = [
  { label: "选项、键、路径", color: "青色", token: "cyan", sample: "--help  /etc/ssh" },
  { label: "值、关键字", color: "紫色", token: "magenta", sample: "<FILE>  const" },
  { label: "字符串、成功", color: "绿色", token: "green", sample: '"ready"  SUCCESS' },
  { label: "数值、警告", color: "黄色", token: "yellow", sample: "200  WARN" },
  { label: "错误", color: "红色", token: "red", sample: "ERROR  FAILED" },
  { label: "地址", color: "蓝色", token: "blue", sample: "127.0.0.1:8080" },
  { label: "注释", color: "灰色", token: "bright-black", sample: "# configuration" },
];

export function UtilitiesSection() {
  const enabled = usePreferencesStore((s) => s.terminalOutputHighlightEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changeHighlight = async (value: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await setTerminalOutputHighlightEnabled(value);
    } catch {
      setError("保存失败，请重试。当前终端设置未确认更改。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title="实用功能" description="终端阅读辅助，更改后立即生效，无需重连。" />
      <div className="flex flex-col gap-2">
        <SettingRow title="彩色输出增强" description="为原本无色、可识别的选项、代码、配置与日志添加语义高亮，默认开启。">
          <Switch aria-label="彩色输出增强" checked={enabled} disabled={saving}
            onCheckedChange={(value) => void changeHighlight(value)} />
        </SettingRow>
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">
          关闭后仅移除 TDSF 的额外高亮；程序原生 ANSI 配色不受影响，也不会改变终端文字、复制内容或命令执行。
        </p>
      </div>

      <section aria-label="输出高亮配色说明" className="overflow-hidden rounded-xl border border-border/60">
        <div className="border-b border-border/60 px-4 py-3">
          <h2 className="text-sm font-medium">颜色对应什么？</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            以下为增强高亮的图例，色值跟随终端主题。程序自身的配色规则可能不同。
          </p>
        </div>
        <dl className="grid gap-px bg-border/40 sm:grid-cols-2">
          {LEGEND.map(({ label, color, token, sample }) => (
            <div key={token} className="flex flex-col gap-2 bg-card px-4 py-3">
              <dt className="flex items-center justify-between gap-2 text-xs font-medium">
                <span style={{ color: `var(--terminal-ansi-${token})` }}>{label}</span>
                <span className="text-[10px] font-normal text-muted-foreground">{color}系</span>
              </dt>
              <dd className="m-0 break-words font-mono text-xs text-muted-foreground">{sample}</dd>
            </div>
          ))}
        </dl>
      </section>
      <p className="text-xs leading-relaxed text-muted-foreground">
        颜色只帮助区分内容，不代表命令安全或任务已成功。提示符与正在输入的命令不在此增强范围内。
      </p>
    </div>
  );
}
