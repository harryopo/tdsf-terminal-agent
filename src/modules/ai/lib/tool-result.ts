// UI result receipt is separate from the backend execution/risk verdict.
const resultLabels = new Map<string, string>([
  ["command_blocked", "已阻止"],
  ["rejected", "已拒绝"],
  ["cancelled", "已取消"],
  ["canceled", "已取消"],
  ["needs_approval", "待确认"],
  ["unavailable", "不可用"],
  ["stale_source", "来源已变化"],
  ["indeterminate", "结果未确认"],
  ["unmatched", "未匹配"],
  ["failed", "failed"],
  ["error", "failed"],
]);

export function getToolResultStatus(output: unknown): string | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const result = output as Record<string, unknown>;
  const status = typeof result.status === "string" ? result.status : "";
  if (resultLabels.has(status)) return status;
  return result.ok === false || result.success === false ? "failed" : null;
}

export function toolResultLabel(status: string): string {
  return resultLabels.get(status) ?? "failed";
}

// Old persisted SDK errors only retained this explicit prefix, not the payload.
// Display it without rewriting history or reconstructing missing output.
export function legacyToolResultStatus(errorText?: string): string | null {
  const status = /^\[([a-z_]+)\]/.exec(errorText ?? "")?.[1];
  return status && resultLabels.has(status) ? status : null;
}
