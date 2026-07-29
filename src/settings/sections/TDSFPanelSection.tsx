// TDSF 魔改 (P4-T4.1): TDSF 引擎设置 (LLM/后端/Skill 路径) — 全量中文化
// -----------------------------------------------------------------------------
// 涵盖:
//   - LLM API 配置 (provider / baseURL / apiKey / model)
//   - 后端 (Python sidecar) 日志查看
//   - Skill 路径 / 启用 builtin skill
//   - 知识库路径
//   - 重启 sidecar 按钮
//
// 数据通过 tauri::invoke('sidecar_get_llm_config') 等命令获取, 修改后调用
// 'sidecar_set_llm_config' 持久化到 .tdsf-data/llm_config.json, 然后点击
// "重启 Sidecar" 即可让 Rust 端 fix_loop 自动重启 Python 子进程加载新配置.

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { Alert01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

type LlmProvider = "openai" | "deepseek" | "anthropic" | "ollama" | "custom";

type LlmConfig = {
  provider: LlmProvider;
  base_url: string;
  api_key: string;
  model: string;
  temperature: number;
  max_tokens: number;
  system_prompt: string;
};

type SidecarStatus = {
  running: boolean;
  pid: number | null;
  uptime_seconds: number;
  log_path: string;
  last_error: string | null;
  config_loaded: boolean;
};

const PROVIDER_PRESET: Record<
  LlmProvider,
  { label: string; baseURL: string; models: string[] }
> = {
  openai: {
    label: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    models: [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4-turbo",
      "gpt-3.5-turbo",
      "o1-mini",
      "o1-preview",
    ],
  },
  deepseek: {
    label: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    models: [
      "deepseek-chat",
      "deepseek-reasoner",
      "deepseek-coder",
      "deepseek-v4-flash",
    ],
  },
  anthropic: {
    label: "Anthropic Claude",
    baseURL: "https://api.anthropic.com/v1",
    models: [
      "claude-3-5-sonnet-latest",
      "claude-3-5-haiku-latest",
      "claude-3-opus-latest",
    ],
  },
  ollama: {
    label: "Ollama (本地)",
    baseURL: "http://localhost:11434/v1",
    models: ["qwen2.5-coder:7b", "llama3.2:3b", "deepseek-coder:6.7b"],
  },
  custom: {
    label: "自定义 / OpenAI 兼容",
    baseURL: "",
    models: [],
  },
};

export function TDSFPanelSection() {
  const [config, setConfig] = useState<LlmConfig | null>(null);
  const [status, setStatus] = useState<SidecarStatus | null>(null);
  const [logTail, setLogTail] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [showKey, setShowKey] = useState(false);

  // 初始加载
  useEffect(() => {
    void (async () => {
      try {
        const cfg = (await invoke("sidecar_get_llm_config")) as LlmConfig;
        setConfig(cfg);
      } catch (e) {
        console.warn("加载 LLM 配置失败", e);
        setConfig({
          provider: "deepseek",
          base_url: PROVIDER_PRESET.deepseek.baseURL,
          api_key: "",
          model: "deepseek-v4-flash",
          temperature: 0.3,
          max_tokens: 4096,
          system_prompt: "",
        });
      }
      try {
        const s = (await invoke("sidecar_status")) as SidecarStatus;
        setStatus(s);
      } catch (e) {
        console.warn("获取 sidecar 状态失败", e);
      }
    })();
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = (await invoke("sidecar_status")) as SidecarStatus;
      setStatus(s);
      const tail = (await invoke("sidecar_log_tail", { lines: 60 })) as string;
      setLogTail(tail);
    } catch (e) {
      console.warn("刷新 sidecar 状态失败", e);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await invoke("sidecar_set_llm_config", { config });
      toast.success("LLM 配置已保存", {
        description: "点击「重启 Sidecar」让 Python 进程加载新配置。",
      });
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("保存失败", { description: msg });
    } finally {
      setSaving(false);
    }
  };

  const restart = async () => {
    try {
      await invoke("sidecar_restart");
      toast.success("Sidecar 已重启", { description: "新配置已生效。" });
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("重启失败", { description: msg });
    }
  };

  const switchProvider = (p: LlmProvider) => {
    if (!config) return;
    const preset = PROVIDER_PRESET[p];
    setConfig({
      ...config,
      provider: p,
      base_url: config.base_url || preset.baseURL,
      model: preset.models[0] ?? config.model,
    });
  };

  if (!config) {
    return (
      <div className="flex flex-col gap-4">
        <SectionHeader title="TDSF 引擎" description="加载配置中..." />
      </div>
    );
  }

  // TDSF 魔改 2026-07-28 (P2-2): Mock LLM 黄色告警
  // 条件: api_key 为空 或 sidecar 未加载配置 → Agent 实际用 mock LLM, 用户应明确知晓
  const hasApiKey = config.api_key.trim().length > 0;
  const isMockLlm = !hasApiKey || !status?.config_loaded;

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="TDSF 引擎"
        description="LLM 提供商、API 凭据、Sidecar 后端与日志查看。"
      />

      {/* === TDSF 魔改 (P2-2): Mock LLM 黄色告警条 ===
          - api_key 缺失或 sidecar.config_loaded=False 时高亮提示
          - 明确告诉用户"AI Agent 当前用假数据回答, 不是真 LLM"
          - 同时给出"立即去配置"按钮引导用户补全 API Key */}
      {isMockLlm && (
        <div
          className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-amber-700 dark:text-amber-300"
          role="alert"
          data-testid="mock-llm-banner"
        >
          <HugeiconsIcon
            icon={Alert01Icon}
            size={16}
            strokeWidth={2}
            className="mt-0.5 shrink-0 text-amber-500"
          />
          <div className="flex-1 space-y-0.5">
            <p className="text-[12px] font-semibold">
              当前为 Mock LLM — AI 回复由本地占位逻辑生成
            </p>
            <p className="text-[10.5px] leading-relaxed text-amber-700/80 dark:text-amber-300/80">
              {!hasApiKey
                ? "尚未配置 API Key, 所有 Agent 回复均为占位文本。请在下方填写 API Key 并点击「保存配置 + 重启 Sidecar」。"
                : "Sidecar 尚未加载新配置。请点击「重启 Sidecar」让 Python 进程读取最新 llm_config.json。"}
            </p>
          </div>
        </div>
      )}

      {/* === Sidecar 状态 === */}
      <div className="flex flex-col gap-2">
        <Label>Sidecar 后端</Label>
        <div className="rounded-lg border border-border/60 bg-card/60 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span
                  className={
                    "size-2 rounded-full " +
                    (status?.running ? "bg-emerald-500" : "bg-red-500")
                  }
                />
                <span className="text-[12.5px] font-medium">
                  {status?.running ? "运行中" : "未运行"}
                </span>
                {status?.pid && (
                  <span className="font-mono text-[10.5px] text-muted-foreground">
                    PID {status.pid}
                  </span>
                )}
                {status && (
                  <span className="font-mono text-[10.5px] text-muted-foreground">
                    已运行 {status.uptime_seconds}s
                  </span>
                )}
              </div>
              {status?.log_path && (
                <div className="font-mono text-[10.5px] text-muted-foreground">
                  日志: {status.log_path}
                </div>
              )}
              {status?.last_error && (
                <div className="font-mono text-[10.5px] text-destructive">
                  最近错误: {status.last_error}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void refresh()}
                className="h-7"
              >
                刷新状态
              </Button>
              <Button size="sm" onClick={() => void restart()} className="h-7">
                重启 Sidecar
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* === LLM 配置 === */}
      <div className="flex flex-col gap-2">
        <Label>LLM 配置</Label>
        <SettingRow title="提供商" description="选择 LLM 提供商。">
          <Select
            value={config.provider}
            onValueChange={(v) => switchProvider(v as LlmProvider)}
          >
            <SelectTrigger className="h-7 w-44 text-[11.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PROVIDER_PRESET) as LlmProvider[]).map((p) => (
                <SelectItem key={p} value={p}>
                  {PROVIDER_PRESET[p].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="Base URL"
          description="LLM API 的 base URL。OpenAI 兼容接口可填写第三方网关。"
        >
          <Input
            value={config.base_url}
            onChange={(e) => setConfig({ ...config, base_url: e.target.value })}
            placeholder="https://api.deepseek.com/v1"
            className="h-7 w-80 font-mono text-[11.5px]"
          />
        </SettingRow>
        <SettingRow
          title="API Key"
          description="从提供商控制台获取的 API 密钥。保存后写入 keyring。"
        >
          <div className="flex items-center gap-1">
            <Input
              type={showKey ? "text" : "password"}
              value={config.api_key}
              onChange={(e) =>
                setConfig({ ...config, api_key: e.target.value })
              }
              placeholder="sk-..."
              className="h-7 w-72 font-mono text-[11.5px]"
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setShowKey((v) => !v)}
              className="h-7 px-2 text-[10.5px]"
            >
              {showKey ? "隐藏" : "显示"}
            </Button>
          </div>
        </SettingRow>
        <SettingRow title="模型" description="要调用的具体模型 ID。">
          <div className="flex items-center gap-1">
            <Select
              value={config.model}
              onValueChange={(v) => setConfig({ ...config, model: v })}
            >
              <SelectTrigger className="h-7 w-56 text-[11.5px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_PRESET[config.provider].models.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={config.model}
              onChange={(e) => setConfig({ ...config, model: e.target.value })}
              placeholder="或手动输入"
              className="h-7 w-44 font-mono text-[11.5px]"
            />
          </div>
        </SettingRow>
        <SettingRow
          title="温度"
          description={`控制输出随机性。0=确定性,1=高多样性。当前 ${config.temperature.toFixed(2)}。`}
        >
          <Input
            type="number"
            step={0.05}
            min={0}
            max={2}
            value={config.temperature}
            onChange={(e) =>
              setConfig({ ...config, temperature: Number(e.target.value) })
            }
            className="h-7 w-24 text-[11.5px]"
          />
        </SettingRow>
        <SettingRow
          title="最大输出 Token"
          description={`单次 LLM 响应的最大 token 数。当前 ${config.max_tokens}。`}
        >
          <Input
            type="number"
            min={256}
            max={32768}
            value={config.max_tokens}
            onChange={(e) =>
              setConfig({ ...config, max_tokens: Number(e.target.value) })
            }
            className="h-7 w-28 text-[11.5px]"
          />
        </SettingRow>
        <SettingRow
          title="系统提示词"
          description="可附加一段全局系统提示,影响所有 LLM 调用。"
        >
          <textarea
            value={config.system_prompt}
            onChange={(e) =>
              setConfig({ ...config, system_prompt: e.target.value })
            }
            rows={4}
            className="min-h-[80px] w-full rounded-md border border-border/60 bg-background/60 px-2 py-1.5 font-mono text-[11.5px]"
            placeholder="例如: 你是一名专业的 Linux 系统管理员..."
          />
        </SettingRow>
        <div className="flex justify-end">
          <Button onClick={() => void save()} disabled={saving} className="h-7">
            {saving ? "保存中..." : "保存配置"}
          </Button>
        </div>
      </div>

      {/* === 后端日志 === */}
      <div className="flex flex-col gap-2">
        <Label>后端日志 (最近 60 行)</Label>
        <p className="text-[11px] text-muted-foreground">
          Sidecar 进程的标准输出/错误流,刷新获取最新内容。
        </p>
        <pre className="max-h-64 overflow-y-auto rounded-lg border border-border/60 bg-zinc-950 px-3 py-2 font-mono text-[10.5px] leading-relaxed text-zinc-200">
          {logTail || "(日志为空,Sidecar 尚未运行或未产生输出)"}
        </pre>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void refresh()}
            className="h-7"
          >
            刷新日志
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() =>
              status?.log_path && void openUrl(`file:///${status.log_path}`)
            }
            className="h-7"
            disabled={!status?.log_path}
          >
            在文件管理器中打开日志
          </Button>
        </div>
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
