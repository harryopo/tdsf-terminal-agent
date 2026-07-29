/**
 * RiskEngine ConfirmDialog — 二次确认组件（基于 TDSF AlertDialog）
 * -----------------------------------------------------------------------------
 * 用法：
 *   <RiskConfirmDialog
 *     assessment={assessment}
 *     command="rm -rf /tmp/foo"
 *     onConfirm={() => submitToLeaf(leafId, command)}
 *     onCancel={() => setPendingCommand(null)}
 *   />
 *
 * 视觉：
 *   - 复用 TDSF 原生 AlertDialog 风格（primary 按钮）
 *   - 风险等级用 Badge 颜色区分：L3 high=橙 / L4 deny=红
 *   - 描述用中文 + 规则名 + 风险等级
 */
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import type { RiskAssessment } from "./types";

interface Props {
  assessment: RiskAssessment;
  command: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  onCancel?: () => void;
}

const LEVEL_BADGE: Record<
  RiskAssessment["level"],
  {
    label: string;
    variant: "default" | "secondary" | "destructive" | "outline";
  }
> = {
  safe: { label: "L0 Safe", variant: "outline" },
  low: { label: "L1 Low", variant: "secondary" },
  medium: { label: "L2 Medium", variant: "default" },
  high: { label: "L3 High", variant: "destructive" },
  deny: { label: "L4 Deny", variant: "destructive" },
};

export function RiskConfirmDialog({
  assessment,
  command,
  open,
  onOpenChange,
  onConfirm,
  onCancel,
}: Props) {
  const badge = LEVEL_BADGE[assessment.level];
  const isDeny = assessment.level === "deny";

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-2xl">
        <AlertDialogHeader>
          <div className="flex items-center gap-2">
            <AlertDialogTitle>
              {isDeny ? "系统拒绝执行" : "高危命令确认"}
            </AlertDialogTitle>
            <Badge variant={badge.variant} className="font-mono">
              {badge.label}
            </Badge>
          </div>
          <AlertDialogDescription className="space-y-3 pt-2">
            <p className="text-foreground">
              {isDeny
                ? "此命令命中黑名单规则，RiskEngine 直接拒绝执行。"
                : "此命令命中高危规则，需要您确认后才会执行。"}
            </p>

            <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/40 p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>命中规则：</span>
                <code className="font-mono text-foreground">
                  {assessment.ruleName ?? "—"}
                </code>
              </div>
              <div className="text-xs text-muted-foreground">
                {assessment.description}
              </div>
            </div>

            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
              <div className="text-xs text-muted-foreground">待执行命令：</div>
              <pre className="mt-1 overflow-x-auto rounded bg-background/60 p-2 font-mono text-xs">
                <code>{command}</code>
              </pre>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isDeny}
            className={isDeny ? "" : "bg-amber-600 hover:bg-amber-700"}
          >
            {isDeny ? "已拒绝" : "仍然执行"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
