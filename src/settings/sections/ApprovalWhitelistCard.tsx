// Task 5 (2026-08-29): 审批白名单管理卡片（方案书 v3.1 §4.6 免确认记忆三级）
// -----------------------------------------------------------------------------
// 项目白名单持久化于 Python Sidecar（$TDSF_DATA_DIR/agent_whitelist.json），
// 经 memory.whitelist.list / .add / .remove JSON-RPC 管理。
// 安全语义：deny 硬底线（内置黑名单）永远优先于白名单；allow 规则对 L4 与
// 危险构造命令不生效——UI 文案如实提示。

import { useCallback, useEffect, useState } from "react";
import { invokeRpc } from "@/lib/sidecar-bridge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";

type WhitelistDecision = "allow" | "ask" | "deny";

type WhitelistRule = {
  pattern: string;
  decision: WhitelistDecision;
  created_at: string;
};

const DECISION_OPTIONS: Array<{ value: WhitelistDecision; label: string }> = [
  { value: "allow", label: "自动放行" },
  { value: "ask", label: "每次询问" },
  { value: "deny", label: "禁止执行" },
];

const DECISION_BADGE: Record<WhitelistDecision, string> = {
  allow: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  ask: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  deny: "bg-destructive/15 text-destructive",
};

const DECISION_LABEL: Record<WhitelistDecision, string> = {
  allow: "放行",
  ask: "询问",
  deny: "拒绝",
};

export function ApprovalWhitelistCard() {
  const [rules, setRules] = useState<WhitelistRule[]>([]);
  const [pattern, setPattern] = useState("");
  const [decision, setDecision] = useState<WhitelistDecision>("allow");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await invokeRpc<{ ok?: boolean; rules?: WhitelistRule[] }>(
        "memory.whitelist.list",
      );
      setRules(Array.isArray(r?.rules) ? r.rules : []);
      setError(null);
    } catch {
      setError("无法读取白名单：AI 引擎未运行或处于浏览器预览模式");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onAdd = async () => {
    const p = pattern.trim();
    if (!p || busy) return;
    setBusy(true);
    try {
      await invokeRpc("memory.whitelist.add", { pattern: p, decision });
      setPattern("");
      await refresh();
    } catch {
      setError("添加规则失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (p: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await invokeRpc("memory.whitelist.remove", { pattern: p });
      await refresh();
    } catch {
      setError("删除规则失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* 添加行 */}
      <div className="flex items-center gap-1.5">
        <Input
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onAdd();
          }}
          placeholder="命令匹配规则，如 systemctl status *"
          className="h-7 flex-1 font-mono text-[11.5px]"
        />
        <Select
          value={decision}
          onValueChange={(v) => setDecision(v as WhitelistDecision)}
        >
          <SelectTrigger className="h-7 w-28 text-[11.5px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DECISION_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="default"
          onClick={() => void onAdd()}
          disabled={!pattern.trim() || busy}
          className="h-7 shrink-0 text-[11px]"
        >
          添加
        </Button>
      </div>

      {error && (
        <p className="text-[11px] text-destructive">{error}</p>
      )}

      {/* 规则列表 */}
      {rules.length === 0 ? (
        <p className="text-[11px] italic text-muted-foreground/60">
          暂无规则——Agent 请求执行命令时将逐条请求确认。
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {rules.map((r) => (
            <div
              key={r.pattern}
              className="flex items-center gap-2 rounded border border-border/50 bg-muted/20 px-2 py-1.5"
            >
              <span
                className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                  DECISION_BADGE[r.decision] ?? DECISION_BADGE.ask,
                )}
              >
                {DECISION_LABEL[r.decision] ?? r.decision}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                {r.pattern}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void onRemove(r.pattern)}
                disabled={busy}
                className="h-6 shrink-0 gap-1 px-1.5 text-[10px] text-destructive hover:text-destructive"
                title={`删除规则 ${r.pattern}`}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
                删除
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
