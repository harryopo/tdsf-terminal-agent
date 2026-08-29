// TDSF 魔改 (P4-T4.1): 智能体设置 (凭据/通知) — 全量中文化
// -----------------------------------------------------------------------------
// 涵盖:
//   - 默认 AI 智能体 (终端里默认唤起的 agent 名称)
//   - 通知策略
//   - 上下文压缩

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
  setAgentNotifications,
  setDefaultWorkspaceEnv,
} from "@/modules/settings/store";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";
import { AgentTypingCard } from "./AgentTypingCard";
import { ApprovalWhitelistCard } from "./ApprovalWhitelistCard";

const WORKSPACE_ENV_OPTIONS = [
  { value: "local", label: "本地 (local)" },
  { value: "container", label: "容器 (container)" },
  { value: "ssh", label: "SSH 远程" },
];

export function AgentsSection() {
  const agentNotifications = usePreferencesStore((s) => s.agentNotifications);
  const defaultWorkspaceEnv = usePreferencesStore((s) => s.defaultWorkspaceEnv);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="智能体"
        description="配置默认 AI 智能体、启动命令与通知策略。"
      />

      <div className="flex flex-col gap-2">
        <Label>全局</Label>
        <SettingRow title="通知" description="智能体完成后弹系统通知。">
          <Switch
            checked={agentNotifications}
            onCheckedChange={(v) => void setAgentNotifications(v)}
          />
        </SettingRow>
        <SettingRow
          title="默认工作区环境"
          description="新开标签页时默认使用的工作区环境。"
        >
          <Select
            value={defaultWorkspaceEnv}
            onValueChange={(v) => void setDefaultWorkspaceEnv(v)}
          >
            <SelectTrigger className="h-7 w-40 text-[11.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WORKSPACE_ENV_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>可视执行演示</Label>
        {/* TDSF B2 (2026-08-29): 可视教学打字机（逐字/整段 + 速度滑杆） */}
        <AgentTypingCard />
      </div>

      <div className="flex flex-col gap-2">
        <Label>审批白名单</Label>
        <ApprovalWhitelistCard />
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
