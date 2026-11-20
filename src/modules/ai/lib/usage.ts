import { invoke } from "@tauri-apps/api/core";

export type UsageSummary = {
  event_count: number;
  reported_event_count?: number;
  unknown_usage_count?: number;
  cancelled_count?: number;
  failed_count?: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cached_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  reasoning_tokens: number | null;
};

export type UsageEvent = Omit<
  UsageSummary,
  "event_count" | "reported_event_count" | "unknown_usage_count" | "cancelled_count" | "failed_count"
> & {
  event_id: string;
  call_id: string;
  attempt_id: string;
  revision: number;
  update_mode: "cumulative" | "delta";
  granularity: "model_call" | "invocation_aggregate";
  session_id: string;
  turn_id: string;
  provider: string;
  requested_model: string;
  resolved_model: string;
  status: string;
  started_at: string | null;
  completed_at: string;
  config_snapshot_id: string | null;
  error_category: string | null;
  covers_call_ids: string[];
};

export type UsageTrendPoint = UsageSummary & { date: string };

export type UsageQueryResult = {
  summary: UsageSummary;
  events: UsageEvent[];
  trend: UsageTrendPoint[];
  query?: {
    retention_policy?: string;
  };
};

export type UsageFilters = {
  sessionId?: string;
  provider?: string;
  model?: string;
  days?: number;
};

export function queryUsage(filters: UsageFilters = {}): Promise<UsageQueryResult> {
  return invoke<UsageQueryResult>("ipc_invoke", {
    method: "usage.summary",
    params: {
      ...(filters.sessionId ? { session_id: filters.sessionId } : {}),
      ...(filters.provider ? { provider: filters.provider } : {}),
      ...(filters.model ? { model: filters.model } : {}),
      days: filters.days ?? 90,
    },
  });
}

export type UsageLoadOutcome = {
  data: UsageQueryResult | null;
  error: string;
};

/** UI boundary: IPC failures become explicit state, never unhandled effect rejections. */
export async function queryUsageSafely(filters: UsageFilters = {}): Promise<UsageLoadOutcome> {
  try {
    return { data: await queryUsage(filters), error: "" };
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatTokenCount(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-US").format(value);
}

export type ModelUsageRow = {
  model: string;
  event_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
};

export function summarizeUsageModels(events: readonly UsageEvent[]): ModelUsageRow[] {
  const rows = new Map<string, ModelUsageRow>();
  for (const event of events) {
    const current = rows.get(event.resolved_model) ?? {
      model: event.resolved_model,
      event_count: 0,
      input_tokens: null,
      output_tokens: null,
    };
    current.event_count += 1;
    if (event.input_tokens !== null) {
      current.input_tokens = (current.input_tokens ?? 0) + event.input_tokens;
    }
    if (event.output_tokens !== null) {
      current.output_tokens = (current.output_tokens ?? 0) + event.output_tokens;
    }
    rows.set(event.resolved_model, current);
  }
  return [...rows.values()];
}

export function trendPoints(
  trend: readonly { input_tokens: number | null }[],
  width = 100,
  height = 80,
): string {
  if (trend.length === 0) return "";
  const known = trend
    .map((point, index) => ({ point, index }))
    .filter((entry) => entry.point.input_tokens !== null);
  if (known.length === 0) return "";
  const max = Math.max(...known.map((entry) => entry.point.input_tokens as number), 1);
  return known
    .map(({ point, index }) => {
      const value = point.input_tokens as number;
      const x = trend.length === 1 ? width / 2 : (index / (trend.length - 1)) * width;
      const y = 10 + (1 - value / max) * height;
      return `${x},${y}`;
    })
    .join(" ");
}

export const USAGE_CHANGED_EVENT = "tdsf://usage-changed";

export function notifyUsageChanged(sessionId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(USAGE_CHANGED_EVENT, {
    detail: { sessionId },
  }));
}