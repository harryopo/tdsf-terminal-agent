export const DEFAULT_AGENT_COMMAND_COLOR = "#5b8cff";

export function coerceAgentCommandColor(value: unknown): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toLowerCase()
    : DEFAULT_AGENT_COMMAND_COLOR;
}
