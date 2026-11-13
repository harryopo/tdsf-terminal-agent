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
import {
  setPredictionImportShellHistory,
  setSshRemoteCarapacePrompt,
} from "@/modules/settings/store";
import { RemoteCarapaceCard } from "./RemoteCarapaceCard";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

export function PredictionHistorySection() {
  const importShellHistory = usePreferencesStore(
    (s) => s.predictionImportShellHistory,
  );
  const sshRemoteCarapacePrompt = usePreferencesStore(
    (s) => s.sshRemoteCarapacePrompt,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sent, setSent] = useState(false);

  const clearHistory = async () => {
    setConfirming(false);
    setBusy(true);
    setSent(false);
    setError(null);
    let dispatched = false;
    try {
      await emitTo(MAIN_WINDOW_LABEL, PREDICTION_CLEAR_EVENT);
      dispatched = true;
      await setPredictionImportShellHistory(false);
      setSent(true);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setError(
        dispatched
          ? `清空请求已发送，但关闭历史导入失败：${detail}`
          : `未能发送清空请求，请重试：${detail}`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="终端预测与补全"
        description="管理历史候选与服务器补全组件。静态命令和参数无需安装额外组件。"
      />

      <div className="rounded-xl border border-border/60 bg-card p-4 space-y-3">
        <SettingRow
          title="在 SSH 终端里提示装补全组件"
          description="某台服务器还没装这个组件时，在那格终端的右下角显示一个小图标，点开可以一键安装。关掉这里只是不再显示那个图标，下面这块入口照样能装。"
        >
          <Switch
            checked={sshRemoteCarapacePrompt}
            onCheckedChange={(v) => void setSshRemoteCarapacePrompt(v)}
          />
        </SettingRow>
        <div className="flex flex-col gap-1.5">
          <Label>远端补全组件</Label>
          <span className="text-[11px] leading-relaxed text-muted-foreground">
            不装也照常提示静态参数（命令词典与参数库）；装上才能提示这台机器上
            真实存在的分支、文件名与服务名 ——
            补全要在命令真正执行的那台机器上跑，
            本机这份看不到远端。装一次对该服务器上所有终端都有效。
          </span>
          <RemoteCarapaceCard />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>预测历史</Label>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          只清空本应用的预测历史，<strong>不会</strong>删除或改写 shell
          自己的历史文件（如 ~/.bash_history、~/.zsh_history、PowerShell
          ConsoleHost_history.txt）。
        </p>
        <Button
          variant={confirming ? "destructive" : "outline"}
          size="sm"
          className="w-fit"
          disabled={busy}
          onClick={() =>
            confirming ? void clearHistory() : setConfirming(true)
          }
          onBlur={() => setConfirming(false)}
        >
          {busy
            ? "正在发送…"
            : confirming
              ? "再次点击确认清空"
              : "清空预测历史"}
        </Button>
        {error && (
          <p role="alert" className="text-[11px] text-destructive">
            {error}
          </p>
        )}
        {sent && (
          <p
            data-testid="prediction-clear-result"
            className="text-[11px] text-muted-foreground"
          >
            清空请求已发送至主窗口，并已停止启动时导入；本会话新敲成功的命令仍会计入。
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
