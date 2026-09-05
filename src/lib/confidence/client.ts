// 会话证据状态客户端。
//
// 旧实现按模型回答里的关键词推断“来源/置信度”。那既不能证明模型真的
// 使用了该来源，也会在 sidecar 不可用时伪造结论。现在只消费后端记录的
// 实际工具完成事件，并明确把它表述为会话证据状态，不给模型文本打分。
import { invoke } from "@tauri-apps/api/core";

export type EvidenceTier = "unverified" | "grounded" | "verified";

export interface EvidenceSource {
  toolName: string;
  source?: string;
  timestamp?: number;
}

export interface EvidenceAssessment {
  /** 会话证据状态，不代表某段模型文本为真的概率。 */
  tier: EvidenceTier;
  source: "rpc" | "unavailable";
  reason: string;
  evidenceCount: number;
  sources: EvidenceSource[];
  scope: "session";
}

type EvidenceAssessmentPayload = {
  tier?: unknown;
  reason?: unknown;
  evidence_count?: unknown;
  sources?: unknown;
  scope?: unknown;
};

function unavailableAssessment(): EvidenceAssessment {
  return {
    tier: "unverified",
    source: "unavailable",
    reason: "证据服务不可用，未对回答文本作任何推断。",
    evidenceCount: 0,
    sources: [],
    scope: "session",
  };
}

function isTier(value: unknown): value is EvidenceTier {
  return value === "unverified" || value === "grounded" || value === "verified";
}

function parseSources(value: unknown): EvidenceSource[] | null {
  if (!Array.isArray(value)) return null;
  const sources: EvidenceSource[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const raw = item as Record<string, unknown>;
    if (typeof raw.tool_name !== "string" || !raw.tool_name) return null;
    sources.push({
      toolName: raw.tool_name,
      ...(typeof raw.source === "string" ? { source: raw.source } : {}),
      ...(typeof raw.timestamp === "number" ? { timestamp: raw.timestamp } : {}),
    });
  }
  return sources;
}

function parseAssessment(value: unknown): EvidenceAssessment | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as EvidenceAssessmentPayload;
  if (!isTier(payload.tier) || typeof payload.reason !== "string") return null;
  if (typeof payload.evidence_count !== "number" || payload.evidence_count < 0) {
    return null;
  }
  const sources = parseSources(payload.sources);
  if (!sources || payload.scope !== "session") return null;
  return {
    tier: payload.tier,
    source: "rpc",
    reason: payload.reason,
    evidenceCount: payload.evidence_count,
    sources,
    scope: "session",
  };
}

/**
 * Query evidence that the sidecar actually recorded for the active chat.
 *
 * A bad or unavailable response intentionally degrades to ``unverified``;
 * callers must never supply model prose as a fallback input.
 */
export async function assessSessionEvidence(
  sessionId: string | null,
): Promise<EvidenceAssessment> {
  if (!sessionId) return unavailableAssessment();
  try {
    const raw = await invoke<unknown>("ipc_invoke", {
      method: "evidence.assess",
      params: { session_id: sessionId },
    });
    return parseAssessment(raw) ?? unavailableAssessment();
  } catch {
    return unavailableAssessment();
  }
}
