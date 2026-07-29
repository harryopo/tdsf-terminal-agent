// TDSF 魔改 (P4-T4.1): Teach Agent 设置 (OSC 7 教学触发) — 全量中文化
// -----------------------------------------------------------------------------
// 涵盖:
//   - Teach Agent 启用开关 (默认开启)
//   - 降频阈值 (1/2/3/5)
//   - 触发说明

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
  setTeachAgentEnabled,
  setTeachThreshold,
  TEACH_THRESHOLD_PRESETS,
} from "@/modules/settings/store";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

const THRESHOLD_LABEL: Record<number, string> = {
  1: "每条命令都触发",
  2: "每 2 条触发一次",
  3: "每 3 条触发一次 (推荐)",
  5: "每 5 条触发一次 (低干扰)",
};

export function TeachSection() {
  const teachAgentEnabled = usePreferencesStore((s) => s.teachAgentEnabled);
  const teachThreshold = usePreferencesStore((s) => s.teachThreshold);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Teach Agent (教学智能体)"
        description="通过 OSC 7 协议检测命令执行,周期性弹出教学提示,辅助新手学习 Linux。"
      />

      <div className="flex flex-col gap-2">
        <Label>启用与频率</Label>
        <SettingRow
          title="启用 Teach Agent"
          description="开启后,智能体会按阈值周期性讲解你刚运行的命令。教学提示可一键关闭。"
        >
          <Switch
            checked={teachAgentEnabled}
            onCheckedChange={(v) => void setTeachAgentEnabled(v)}
          />
        </SettingRow>
        <SettingRow
          title="降频阈值"
          description="每执行 N 条命令触发一次教学。阈值越小教学越频繁,适合入门；阈值越大干扰越少。"
        >
          <Select
            value={String(teachThreshold)}
            onValueChange={(v) => void setTeachThreshold(Number(v))}
          >
            <SelectTrigger className="h-7 w-56 text-[11.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TEACH_THRESHOLD_PRESETS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {THRESHOLD_LABEL[n]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>原理</Label>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Teach Agent 通过读取终端发送的 OSC 7
          转义序列,识别工作目录变化,从而推断用户执行的命令。 配合 LangGraph
          状态机 + 风险评估引擎,在用户执行高危命令（如{" "}
          <code className="rounded bg-muted px-1 py-0.5">rm -rf</code>
          ）前主动提示风险, 在执行新命令时讲解用法,实现"边用边学"的 Linux
          教学体验。
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
