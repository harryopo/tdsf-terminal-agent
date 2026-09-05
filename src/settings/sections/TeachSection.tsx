import { Switch } from "@/components/ui/switch";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setTeachAgentEnabled } from "@/modules/settings/store";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

export function TeachSection() {
  const teachAgentEnabled = usePreferencesStore((s) => s.teachAgentEnabled);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Teach Agent (教学智能体)"
        description="教学模式由对话模式控制；这里仅控制失败命令的手动 AI 解释入口。"
      />

      <div className="flex flex-col gap-2">
        <Label>手动讲解</Label>
        <SettingRow
          title="启用手动错误讲解"
          description="在失败的终端命令块上显示“AI 解释”。必须由你点击，不会自动讲解、执行命令或写入教学历史。"
        >
          <Switch
            checked={teachAgentEnabled}
            onCheckedChange={(v) => void setTeachAgentEnabled(v)}
          />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>边界</Label>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          教学命令必须从教学模式中的命令卡发起，并在同一终端返回精确、脱敏的
          执行结果后，由你选择“基于结果继续讲解”。普通终端输出与知识库检索
          不会被自动转成教学内容。
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
