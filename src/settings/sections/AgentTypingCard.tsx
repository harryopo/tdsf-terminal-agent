// TDSF B2 (2026-08-29): 可视教学打字机设置（spec: add-agent-trust-modes Task 7）
// -----------------------------------------------------------------------------
// 涵盖:
//   - 打字模式开关（逐字打字机 / 整段注入）
//   - 速度滑杆（0.2×~5×，实时显示当前倍率）
//
// 原理说明：Agent 命令获批后由 Rust 写入端（human_type pump，expect
// send_human Weibull 算法）逐字符写 PTY/SSH channel，远端回显天然形成
// 逐字打字视觉。sudo/密码场景自动降级整段注入；演示中按任意键接管。

import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  coerceAgentTypingSpeed,
  setAgentTypingMode,
  setAgentTypingSpeed,
  type AgentTypingMode,
} from "@/modules/settings/store";
import { SettingRow } from "../components/SettingRow";

const MODE_OPTIONS: Array<{
  value: AgentTypingMode;
  label: string;
  desc: string;
}> = [
  {
    value: "instant",
    label: "整段注入",
    desc: "命令一次性写入终端，立即执行（默认，专家/长命令推荐）",
  },
  {
    value: "human",
    label: "逐字演示",
    desc: "按人味节奏逐字敲入终端，学生全程可见；任意按键可接管",
  },
];

/** 速度倍率 → 演示文案（80 字符命令的典型耗时，expect 经典参数估算） */
function speedHint(speed: number): string {
  // 平均字符间隔 ≈ (0.1~0.3)s / speed，80 字符 ≈ 80×0.15/speed + 词尾停顿
  const sec = Math.round((80 * 0.18) / speed);
  if (speed >= 3) return "快速（约数秒 / 80 字符）";
  if (speed <= 0.5) return "慢速教学（约 1 分钟 / 80 字符）";
  return `约 ${sec}~${sec + 8} 秒 / 80 字符`;
}

export function AgentTypingCard() {
  const agentTypingMode = usePreferencesStore((s) => s.agentTypingMode);
  const agentTypingSpeed = usePreferencesStore((s) => s.agentTypingSpeed);

  return (
    <div className="flex flex-col gap-2">
      <SettingRow
        title="打字模式"
        description="Agent 批准执行命令时，如何写入当前终端。"
      >
        <Select
          value={agentTypingMode}
          onValueChange={(v) => void setAgentTypingMode(v as AgentTypingMode)}
        >
          <SelectTrigger className="h-7 w-56 text-[11.5px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        title="演示速度"
        description={`${speedHint(agentTypingSpeed)}。当前倍率 ${agentTypingSpeed.toFixed(1)}×。`}
      >
        <div className="flex w-56 items-center gap-2">
          <Slider
            value={[agentTypingSpeed]}
            min={0.2}
            max={5}
            step={0.1}
            disabled={agentTypingMode !== "human"}
            onValueChange={(v) => {
              const next = coerceAgentTypingSpeed(v[0] ?? 1);
              void setAgentTypingSpeed(next);
            }}
          />
          <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
            {agentTypingSpeed.toFixed(1)}×
          </span>
        </div>
      </SettingRow>
    </div>
  );
}
