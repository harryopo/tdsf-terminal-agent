// 删除确认弹窗（全应用唯一的删除确认外观）
// -----------------------------------------------------------------------------
// #166 ③（2026-09-28 用户实测）：「删除的时候应该弹出一个确认删除的窗口，当前做的太丑了，
// 再优化一下，变为那种大气顶级设计……再加点动效」。
// 在此之前仓里有三种删除确认长相：已保存服务器是列表底部一条红色横条（视线要从正在点的行
// 移到底部）、文件树右键是菜单项文案变成 "Click again to confirm"（第一次点不删、菜单还留着，
// 看起来像没反应）、片段面板是一副 Dialog 但没说清"删完会留下什么"。同一种动作三种长相，
// 按产品界面的规矩就一定是有一种是错的 —— 这里收成一处。
//
// 设计取向：
// - 危险感来自"说清要消失的是哪一条"，不是红底红字糊满一屏。红色只落在图标徽章与真正
//   会执行删除的那颗按钮上。
// - 居中版式 + 两颗等宽按钮（sm 尺寸下 AlertDialogFooter 自带 grid-cols-2），
//   与 HostApprovalDialog 同一套语言。
// - 动效只表达状态：徽章一次性扩散环（这一步不可逆）+ 事实行错峰淡入。无回弹、无循环，
//   reduced-motion 下延迟一并归零（见 animations.css 末尾那条注释）。

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

export type DeleteConfirmation = {
  /** 被删对象的类型，出现在标题里：「已保存的服务器」「文件」 */
  subject: string;
  /** 对象的名字或路径 —— 这扇窗的主语 */
  name: string;
  /** 一句影响范围：删完会怎样、**不会**怎样 */
  impact: string;
  /** 可选事实行（地址、端口、大小），用来确认"我要删的就是这条" */
  facts?: { label: string; value: string }[];
};

export function ConfirmDeleteDialog({
  request,
  busy = false,
  onOpenChange,
  onConfirm,
}: {
  request: DeleteConfirmation | null;
  /** 删除在飞：按钮禁用且不接受关闭，免得关掉的窗和已发出的删除各说一半 */
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(next) => {
        if (!next && !busy) onOpenChange(false);
      }}
    >
      {/* 宽度必须带上和基础类同样的变体前缀，否则 tailwind-merge 两条都保留、
          按特异性仍是 base 的 max-w-xs(320px) 赢（#124 实测过这条） */}
      <AlertDialogContent
        size="sm"
        data-testid="confirm-delete-dialog"
        className="max-h-[85vh] overflow-y-auto data-[size=sm]:max-w-[26rem]"
      >
        <AlertDialogHeader>
          <AlertDialogMedia
            aria-hidden
            className="animate-confirm-badge bg-destructive/12 text-destructive"
          >
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.75} />
          </AlertDialogMedia>

          <AlertDialogTitle>删除{request?.subject}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <p className="text-[13px] leading-relaxed">
              <span className="break-all font-medium text-foreground">
                {request?.name}
              </span>
              {request ? ` —— ${request.impact}` : ""}
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {request?.facts?.length ? (
          <dl className="grid gap-1 rounded-lg bg-muted/50 px-3 py-2.5 text-[12px]">
            {request.facts.map((fact, i) => (
              <div
                key={fact.label}
                className="animate-confirm-rise flex items-baseline justify-between gap-3"
                style={{ animationDelay: `${120 + i * 60}ms` }}
              >
                <dt className="shrink-0 text-muted-foreground">{fact.label}</dt>
                <dd className="min-w-0 break-all text-right font-mono">
                  {fact.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            data-testid="confirm-delete-action"
            onClick={(event) => {
              // 受控弹窗：不让 Radix 顺手关掉，删除成功与否由调用方决定何时关
              event.preventDefault();
              onConfirm();
            }}
          >
            {busy ? "删除中…" : "删除"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
