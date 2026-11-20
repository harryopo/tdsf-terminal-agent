import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  commitModelGeneration,
  DEFAULT_MODEL_GENERATION,
  previewGenerationCapabilities,
  type ModelConfigureReceipt,
  type ModelGenerationPreferences,
} from "@/modules/ai/lib/modelGeneration";
import {
  resolveSidecarTarget,
  runSidecarConfigSyncNow,
} from "@/modules/ai/lib/sidecar-config-sync";
import { DEFAULT_MODEL_ID } from "@/modules/ai/config";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setModelGeneration,
  setShowReasoning,
} from "@/modules/settings/store";
import { useEffect, useMemo, useState } from "react";

const CONTROL_CLASS =
  "h-8 min-w-0 flex-1 rounded-md border border-border/60 bg-background px-2 text-[12px] text-foreground outline-none focus:border-foreground/40 disabled:cursor-not-allowed disabled:opacity-50";

function draftFrom(value: ModelGenerationPreferences) {
  return {
    temperature: value.temperature === null ? "" : String(value.temperature),
    maxTokens: value.maxTokens === null ? "" : String(value.maxTokens),
    thinking: value.thinking,
    reasoningEffort: value.reasoningEffort,
  };
}

export function GenerationSettings({ modelId = DEFAULT_MODEL_ID }: { modelId?: string }) {
  const saved = usePreferencesStore((state) => state.modelGeneration);
  const showReasoning = usePreferencesStore((state) => state.showReasoning);
  const preferences = usePreferencesStore((state) => state);
  const target = useMemo(
    () => resolveSidecarTarget(modelId, preferences),
    [modelId, preferences],
  );
  const preview = target
    ? previewGenerationCapabilities(target.provider, target.model, target.baseURL)
    : null;
  const [draft, setDraft] = useState(() => draftFrom(saved));
  const [receipt, setReceipt] = useState<ModelConfigureReceipt | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(draftFrom(saved)), [saved]);

  const save = async () => {
    setSaving(true);
    setError("");
    const candidate: ModelGenerationPreferences = {
      temperature: draft.temperature.trim() === "" ? null : Number(draft.temperature),
      maxTokens: draft.maxTokens.trim() === "" ? null : Number(draft.maxTokens),
      thinking: draft.thinking,
      reasoningEffort: draft.reasoningEffort,
    };
    const result = await commitModelGeneration(
      candidate,
      saved,
      setModelGeneration,
      runSidecarConfigSyncNow,
      setModelGeneration,
    );
    if (result.ok) {
      setReceipt(result.receipt ?? null);
    } else {
      setError(result.detail || "保存失败，已回滚");
      setDraft(draftFrom(saved));
    }
    setSaving(false);
  };

  const capabilities = receipt?.capabilities ?? preview;
  const reasoningStyle = capabilities?.reasoning_parameter_style ?? "unknown";
  const reasoningUnknown = reasoningStyle === "unknown" || reasoningStyle === "none";
  const temperatureUnsupported = capabilities?.supports_temperature === false;
  const thinkingOffUnsupported = capabilities?.supports_thinking_off === false;
  const effortUnsupported = !capabilities?.supported_efforts?.length;

  return (
    <section aria-labelledby="generation-settings-title" className="flex flex-col gap-3">
      <div>
        <h2 id="generation-settings-title" className="text-[13px] font-medium">生成与思考</h2>
        <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
          稳定运维建议温度 0.1；这不是逐字确定性的保证。空值表示 Provider 默认，0 是合法显式值。
        </p>
      </div>
      <div className="grid gap-3 rounded-lg border border-border/60 bg-card/60 p-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          温度（0–2，留空为默认）
          <input
            aria-label="温度"
            className={CONTROL_CLASS}
            inputMode="decimal"
            value={draft.temperature}
            disabled={saving || temperatureUnsupported}
            onChange={(event) => setDraft({ ...draft, temperature: event.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          输出上限（正整数，留空为默认）
          <input
            aria-label="输出上限"
            className={CONTROL_CLASS}
            inputMode="numeric"
            value={draft.maxTokens}
            disabled={saving}
            onChange={(event) => setDraft({ ...draft, maxTokens: event.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          思考参数
          <Select
            value={draft.thinking}
            disabled={saving || reasoningUnknown}
            onValueChange={(value) => setDraft({
              ...draft,
              thinking: value as ModelGenerationPreferences["thinking"],
            })}
          >
            <SelectTrigger aria-label="思考参数" className="h-8 w-full text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="provider_default">Provider 默认</SelectItem>
              <SelectItem value="on">开启</SelectItem>
              <SelectItem value="off" disabled={thinkingOffUnsupported}>关闭</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          思考深度
          <Select
            value={draft.reasoningEffort}
            disabled={saving || reasoningUnknown || effortUnsupported}
            onValueChange={(value) => setDraft({
              ...draft,
              reasoningEffort: value as ModelGenerationPreferences["reasoningEffort"],
            })}
          >
            <SelectTrigger aria-label="思考深度" className="h-8 w-full text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="provider_default">Provider 默认</SelectItem>
              <SelectItem value="low">低</SelectItem>
              <SelectItem value="medium">中</SelectItem>
              <SelectItem value="high">高</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </div>
      {reasoningUnknown && (
        <p className="text-[11px] text-muted-foreground">
          当前端点的高级 reasoning 能力未知，不发送相关字段；不提供任意 providerOptions 透传。
        </p>
      )}
      {temperatureUnsupported && (
        <p className="text-[11px] text-muted-foreground">当前模型不支持温度参数，保存时会省略。</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? "保存中…" : "保存生成参数"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={() => setDraft(draftFrom(DEFAULT_MODEL_GENERATION))}
        >
          恢复稳定运维默认值
        </Button>
      </div>
      {error && <p role="alert" className="text-[11px] text-destructive">{error}；旧配置未视为已生效。</p>}
      {receipt?.turn_snapshot && (
        <div className="rounded-md bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
          配置代次 {receipt.turn_snapshot.configGeneration ?? "—"} · 快照 {receipt.turn_snapshot.configSnapshotId ?? "—"}
          {receipt.warnings?.length ? ` · ${receipt.warnings.length} 项未应用` : " · 回执已确认"}
        </div>
      )}
      <div className="flex items-start justify-between gap-4 border-t border-border/40 pt-3">
        <div>
          <p className="text-[12px]">显示 Provider 已返回的思考内容</p>
          <p className="mt-0.5 text-[10.5px] leading-4 text-muted-foreground">
            仅控制展示；不会停止推理、计费或日志，也不会触发模型重建。
          </p>
        </div>
        <Switch
          aria-label="显示思考内容"
          checked={showReasoning}
          onCheckedChange={(checked) => void setShowReasoning(checked)}
        />
      </div>
    </section>
  );
}