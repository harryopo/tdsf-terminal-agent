import type { ProviderId } from "@/modules/ai/config";
import {
  AppleIcon,
  ChatGptIcon,
  ClaudeIcon,
  ComputerIcon,
  CpuIcon,
  DeepseekIcon,
  FireIcon,
  FlashIcon,
  GlobeIcon,
  GoogleGeminiIcon,
  Grok02Icon,
  AiCloud01Icon,
  MistralIcon,
  Moon02Icon,
  PlugIcon,
  ServerStack01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

const ICON_BY_PROVIDER = {
  // TDSF 魔改 2026-08-28: 国产 provider 图标（hugeicons 无专属品牌图标，
  // 用语义近似图标代替：阿里=云 AI、智谱=星火 GLM、Kimi=月之暗面、豆包=火山）
  deepseek: DeepseekIcon,
  qwen: AiCloud01Icon,
  zhipu: SparklesIcon,
  moonshot: Moon02Icon,
  doubao: FireIcon,
  openai: ChatGptIcon,
  anthropic: ClaudeIcon,
  google: GoogleGeminiIcon,
  xai: Grok02Icon,
  cerebras: CpuIcon,
  groq: FlashIcon,
  mistral: MistralIcon,
  openrouter: GlobeIcon,
  "openai-compatible": PlugIcon,
  lmstudio: ComputerIcon,
  mlx: AppleIcon,
  ollama: ServerStack01Icon,
} as const satisfies Record<ProviderId, typeof ChatGptIcon>;

type Props = {
  provider: ProviderId;
  size?: number;
  className?: string;
};

export function ProviderIcon({ provider, size = 14, className }: Props) {
  return (
    <HugeiconsIcon
      icon={ICON_BY_PROVIDER[provider]}
      size={size}
      strokeWidth={1.75}
      className={className}
    />
  );
}
