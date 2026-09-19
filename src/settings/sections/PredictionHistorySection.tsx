// TDSF 2026-09-19 (P5): 「终端预测」设置区块
// -----------------------------------------------------------------------------
// 终端命令预测的历史是**内存态**的：只有两个来源 —— 启动时导入本地 shell 历史、
// 以及成功退出（exitCode 0）的终端命令块。因此"清空"必须与"不再自动导入"配套，
// 否则一重启就被 histfile 里的手误行重新灌满，清空等于没做。
//
// 红线：这里只清 TDSF 自己的预测历史，**绝不读写用户的 shell 历史文件**
// （~/.bash_history / ~/.zsh_history / pwsh ConsoleHost_history.txt 等）。
// -----------------------------------------------------------------------------

import { useState } from "react";
import { getSuggestEngine } from "@/lib/suggest-engine";
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
  const [counts, setCounts] = useState(() => readCounts());
  const [confirming, setConfirming] = useState(false);

  const clearHistory = () => {
    // 清空 = 内存预测历史归零 + 关掉自动导入（同一区块随时可改回）
    getSuggestEngine().clearHistory();
    void setPredictionImportShellHistory(false);
    setCounts(readCounts());
    setConfirming(false);
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="终端预测历史"
        description="命令预测按你实际敲过的命令补全候选；这份历史只存在本应用内存中。"
      />

      <div className="flex flex-col gap-2">
        <Label>当前容量</Label>
        <div className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2 text-[12px]">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">本地终端</span>
            <span className="font-mono tabular-nums">{counts.windows} 条</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">SSH 终端</span>
            <span className="font-mono tabular-nums">{counts.linux} 条</span>
          </div>
        </div>
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

/** 读两个环境的历史条数（引擎是单例，清空后重读即为 0） */
function readCounts(): { windows: number; linux: number } {
  const engine = getSuggestEngine();
  return {
    windows: engine.getHistory("windows").length,
    linux: engine.getHistory("linux").length,
  };
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}
