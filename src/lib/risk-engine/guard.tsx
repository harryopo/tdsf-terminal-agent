// TDSF 魔改: RiskEngine Guard 组件 (T2.2)
// -----------------------------------------------------------------------------
// 基于现有 RiskConfirmDialog 的薄包装层，提供 useRiskGuard hook 管理 L3/L4 拦截流程。
//
// 用法：
//   const guard = useRiskGuard({ leafId, onConfirm: (cmd) => submitToLeaf(leafId, cmd) });
//   guard.requestRiskCheck("rm -rf /tmp/foo");  // 触发评估 + 弹窗
//   <RiskGuardDialog {...guard.dialogProps} />
//
// 拦截策略：
//   - safe/low/medium → 静默放行（不弹窗）
//   - high (L3)       → 弹二次确认对话框，用户确认后才执行
//   - deny  (L4)      → 弹拒绝对话框，禁止执行（确认按钮禁用）
import { useCallback, useEffect, useState } from "react";
import { RiskConfirmDialog } from "./ConfirmDialog";
import { evaluateRisk, type RiskRpcAssessment } from "./riskClient";
import type { RiskAssessment } from "./types";

/** 拦截决策结果 */
export type RiskGuardDecision =
  | { kind: "pass"; assessment: RiskRpcAssessment } // 放行（safe/low/medium）
  | { kind: "confirm"; assessment: RiskRpcAssessment } // 需二次确认（high）
  | { kind: "deny"; assessment: RiskRpcAssessment }; // 拒绝（deny）

/** useRiskGuard 配置 */
interface UseRiskGuardOptions {
  /** 命令确认后执行的回调（实际写入 PTY） */
  onConfirm: (command: string) => void;
  /** 命令被拒绝/取消的回调（可选，用于日志或 UI 反馈） */
  onCancel?: (command: string) => void;
}

/** useRiskGuard 返回值 */
interface UseRiskGuardReturn {
  /** 当前待处理的命令（null 表示无拦截） */
  pendingCommand: string | null;
  /** 当前风险评估结果（pendingCommand 非空时有效） */
  pendingAssessment: RiskRpcAssessment | null;
  /** 弹窗是否打开 */
  open: boolean;
  /** 请求风险检查（异步）：返回决策结果，命中 L3+ 时打开弹窗 */
  requestRiskCheck: (command: string) => Promise<RiskGuardDecision>;
  /** 用户确认执行（点击"仍然执行"） */
  confirm: () => void;
  /** 用户取消（点击"取消"或关闭弹窗） */
  cancel: () => void;
  /** 传给 RiskGuardDialog 的 props */
  dialogProps: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    assessment: RiskAssessment;
    command: string;
    onConfirm: () => void;
    onCancel: () => void;
  };
}

/**
 * 风险拦截 hook：管理命令评估 + 弹窗状态。
 *
 * 流程：
 *   1. 调用方调 requestRiskCheck(cmd)
 *   2. 内部调 evaluateRisk(cmd)（Python RPC + fail-open）
 *   3. safe/low/medium → 返回 { kind: "pass" }，不弹窗
 *   4. high → 返回 { kind: "confirm" }，打开弹窗
 *   5. deny → 返回 { kind: "deny" }，打开弹窗（禁用确认按钮）
 *   6. 用户点击"仍然执行" → confirm() → 调 onConfirm(cmd)
 *   7. 用户点击"取消" → cancel() → 调 onCancel(cmd)
 */
export function useRiskGuard(options: UseRiskGuardOptions): UseRiskGuardReturn {
  const { onConfirm, onCancel } = options;
  const [pendingCommand, setPendingCommand] = useState<string | null>(null);
  const [pendingAssessment, setPendingAssessment] =
    useState<RiskRpcAssessment | null>(null);
  const [open, setOpen] = useState(false);

  const requestRiskCheck = useCallback(
    async (command: string): Promise<RiskGuardDecision> => {
      const assessment = await evaluateRisk(command);
      if (assessment.level === "high" || assessment.requiresConfirmation) {
        setPendingCommand(command);
        setPendingAssessment(assessment);
        setOpen(true);
        return { kind: "confirm", assessment };
      }
      if (assessment.level === "deny") {
        setPendingCommand(command);
        setPendingAssessment(assessment);
        setOpen(true);
        return { kind: "deny", assessment };
      }
      // safe/low/medium → 静默放行
      return { kind: "pass", assessment };
    },
    [],
  );

  const confirm = useCallback(() => {
    if (pendingCommand !== null) {
      onConfirm(pendingCommand);
    }
    setPendingCommand(null);
    setPendingAssessment(null);
    setOpen(false);
  }, [pendingCommand, onConfirm]);

  const cancel = useCallback(() => {
    if (pendingCommand !== null) {
      onCancel?.(pendingCommand);
    }
    setPendingCommand(null);
    setPendingAssessment(null);
    setOpen(false);
  }, [pendingCommand, onCancel]);

  // 默认 assessment（避免传 null 给对话框）
  const fallbackAssessment: RiskAssessment = {
    level: "safe",
    ruleName: null,
    description: "",
    requiresConfirmation: false,
    promptText: "",
  };

  return {
    pendingCommand,
    pendingAssessment,
    open,
    requestRiskCheck,
    confirm,
    cancel,
    dialogProps: {
      open,
      onOpenChange: (next: boolean) => {
        if (!next) cancel();
        else setOpen(true);
      },
      assessment: pendingAssessment ?? fallbackAssessment,
      command: pendingCommand ?? "",
      onConfirm: confirm,
      onCancel: cancel,
    },
  };
}

/**
 * RiskGuardDialog：基于 RiskConfirmDialog 的便捷包装。
 *
 * 直接传 useRiskGuard().dialogProps 即可使用。
 */
export function RiskGuardDialog(props: UseRiskGuardReturn["dialogProps"]) {
  // 当 assessment 为 safe fallback 时不开弹窗
  useEffect(() => {
    if (props.command === "" && props.open) {
      props.onOpenChange(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- terax 上游既有依赖设计, 变更 deps 有回归风险
  }, [props.command, props.open, props.onOpenChange]);

  return <RiskConfirmDialog {...props} />;
}
