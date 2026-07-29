// TDSF 魔改 (P4-T4.1): 智能体设置 (启动命令/凭据/通知) — 全量中文化
// -----------------------------------------------------------------------------
// 涵盖:
//   - 默认 AI 智能体 (终端里默认唤起的 agent 名称)
//   - 启动命令 (各 agent 自定义启动参数)
//   - 通知策略
//   - 上下文压缩

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  AGENT_LAUNCHERS,
  type AgentLaunchCommands,
  type AgentLauncherId,
} from "@/modules/agents/lib/launcher";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setAgentLaunchCommands,
  setAgentNotifications,
  setDefaultWorkspaceEnv,
} from "@/modules/settings/store";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

const WORKSPACE_ENV_OPTIONS = [
  { value: "local", label: "本地 (local)" },
  { value: "container", label: "容器 (container)" },
  { value: "ssh", label: "SSH 远程" },
];

export function AgentsSection() {
  const agentLaunchCommands = usePreferencesStore((s) => s.agentLaunchCommands);
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
        <Label>智能体启动命令</Label>
        <p className="text-[11px] text-muted-foreground">
          每个智能体可独立配置启动命令 (例如 claude / codex / gemini / pi 等
          CLI)。 留空使用内置默认。
        </p>
        <div className="flex flex-col gap-1.5">
          {AGENT_LAUNCHERS.map((agent) => (
            <SettingRow
              key={agent.id}
              title={agent.label}
              description={`${agent.label} (${agent.id}) 的启动命令,默认: ${agent.defaultCommand}`}
            >
              <Input
                value={agentLaunchCommands?.[agent.id as AgentLauncherId] ?? ""}
                onChange={(e) => {
                  const next: Partial<AgentLaunchCommands> = {
                    ...(agentLaunchCommands ?? {}),
                    [agent.id]: e.target.value,
                  };
                  void setAgentLaunchCommands(next as AgentLaunchCommands);
                }}
                placeholder={`默认: ${agent.defaultCommand}`}
                className="h-7 w-72 font-mono text-[11.5px]"
              />
            </SettingRow>
          ))}
        </div>
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
