// TDSF 2026-09-19 (P5): 「终端预测」设置区块
// -----------------------------------------------------------------------------
// 终端命令预测的历史是**内存态**的：只有两个来源 —— 启动时导入本地 shell 历史、
// 以及成功退出（exitCode 0）的终端命令块。因此"清空"必须与"不再自动导入"配套，
// 否则一重启就被 histfile 里的手误行重新灌满，清空等于没做。
//
// 关键约束（真机实测换来的）：设置窗是独立 JS context，suggest-engine 在两边
// 各有一份实例。在这里 `getSuggestEngine().clearHistory()` 清的是设置窗自己那份
// 空引擎，主窗的候选一条都不会少。所以清空只能 emitTo 主窗，由主窗执行。
// 同理，本区块**不显示条数**——这里读到的数字与用户真正在用的那份无关，撒谎的
// 指标比没有指标更坏。
//
// 红线：这里只清 TDSF 自己的预测历史，**绝不读写用户的 shell 历史文件**
// （~/.bash_history / ~/.zsh_history / pwsh ConsoleHost_history.txt 等）。
// -----------------------------------------------------------------------------

import { useState } from "react";
import { emitTo } from "@tauri-apps/api/event";
import {
  MAIN_WINDOW_LABEL,
  PREDICTION_CLEAR_EVENT,
} from "@/lib/predictionEvents";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setPredictionImportShellHistory } from "@/modules/settings/store";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

export function PredictionHistorySection() {
  const importShellHistory = usePreferencesStore(
    (s) => s.predictionImportShellHistory,
  );
  const [confirming, setConfirming] = useState(false);
  const [sent, setSent] = useState(false);

  const clearHistory = () => {
    setConfirming(false);
    // 真正清的是主窗那份内存；浏览器预览（无 Tauri）下这条会 reject，安静忽略
    void emitTo(MAIN_WINDOW_LABEL, PREDICTION_CLEAR_EVENT).catch(() => undefined);
    void setPredictionImportShellHistory(false);
    setSent(true);
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="终端预测历史"
        description="命令预测按你实际敲过的命令补全候选；这份历史只存在应用运行内存里，退出即消失。"
      />

      <div className="flex flex-col gap-2">
        <Label>清空</Label>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          只清空本应用的预测历史，<strong>不会</strong>删除或改写 shell
          自己的历史文件（如 ~/.bash_history、~/.zsh_history、PowerShell
          ConsoleHost_history.txt）。
        </p>
        <Button
          variant={confirming ? "destructive" : "outline"}
          size="sm"
          className="w-fit"
          onClick={() => (confirming ? clearHistory() : setConfirming(true))}
          onBlur={() => setConfirming(false)}
        >
          {confirming ? "再次点击确认清空" : "清空预测历史"}
        </Button>
        {sent && (
          <p
            data-testid="prediction-clear-result"
            className="text-[11px] text-muted-foreground"
          >
            已清空当前会话的预测历史，并停止启动时导入（本会话新敲成功的命令仍会计入）。
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label>启动时导入</Label>
        <SettingRow
          title="导入本地 shell 历史"
          description="关闭后不再把 shell 历史读进预测候选；清空预测历史时会自动关掉它，避免重启被旧历史回填。本会话新敲成功的命令仍会计入。"
        >
          <Switch
            checked={importShellHistory}
            onCheckedChange={(v) => void setPredictionImportShellHistory(v)}
          />
        </SettingRow>
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
