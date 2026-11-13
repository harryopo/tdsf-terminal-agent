// 智能体通知、可视执行与审批设置。
import { Switch } from "@/components/ui/switch";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setAgentNotifications } from "@/modules/settings/store";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";
import { AgentTypingCard } from "./AgentTypingCard";
import { ApprovalWhitelistCard } from "./ApprovalWhitelistCard";

export function AgentsSection() {
  const agentNotifications = usePreferencesStore((s) => s.agentNotifications);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="智能体"
        description="通知、可视执行与审批白名单。"
      />

      <div className="flex flex-col gap-2">
        <Label>全局</Label>
        <SettingRow title="通知" description="智能体完成后弹系统通知。">
          <Switch
            checked={agentNotifications}
            onCheckedChange={(v) => void setAgentNotifications(v)}
          />
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
