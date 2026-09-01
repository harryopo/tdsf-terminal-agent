import { Button } from "@/components/ui/button";
import { useSpaces } from "@/modules/spaces";

/**
 * 工作区门控空态（用户钦定 2026-09-01）：
 * 未绑定工作区的会话 agent 不运行——选择/新建工作区并在其中新建对话。
 * Agent 按工作区隔离运行（环境感知/记忆沉淀/工具作用域都以工作区为界）。
 *
 * CTA 经 window 事件与 App 解耦（tdsf:spaces-create / tdsf:spaces-overview，
 * App 侧监听后打开 SpaceCreateDialog / SpaceSwitcher 总览）。
 */
export function WorkspaceGate() {
  const activeName = useSpaces((s) =>
    s.spaces.find((x) => x.id === s.activeId)?.name,
  );
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 py-10 text-center">
      <div>
        <p className="text-[14px] font-semibold tracking-tight">
          请先选择工作区
        </p>
        <p className="mt-2 max-w-[22rem] text-[11.5px] leading-relaxed text-muted-foreground">
          Agent 按工作区隔离运行：环境感知、工具作用域与长期工作记忆都以
          工作区为界。选择或新建一个工作区，并在其中新建对话后即可开始；
          同一工作区的不同对话共享历史记忆沉淀。
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={() =>
            window.dispatchEvent(new CustomEvent("tdsf:spaces-create"))
          }
        >
          新建工作区
        </Button>
        {activeName ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("tdsf:spaces-overview"))
            }
          >
            切换工作区（当前：{activeName}）
          </Button>
        ) : null}
      </div>
    </div>
  );
}
