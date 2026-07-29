// TDSF 魔改 (P4-T4.4): Skill 命令解析器
// -----------------------------------------------------------------------------
// 把 TdsfAgentPanel 输入框的 `/skill:<name> <args>` 前缀命令解析为结构化对象。
//
// 格式:
//   /skill:docker-management nginx 启动失败  → { name: "docker-management", args: "nginx 启动失败" }
//   /skill:ssh-troubleshoot                  → { name: "ssh-troubleshoot", args: "" }
//   /skill:selinux-baseline  AVC denied       → { name: "selinux-baseline", args: "AVC denied" }
//
// 不匹配的场景（返回 null）:
//   - 不以 "/skill:" 开头（如 "/skills:foo"、"skill:foo"、"#skill:foo"）
//   - 前缀后为空（"/skill:"）
//   - name 包含空白字符（"/skill:foo bar baz" 中 name="foo", args="bar baz"）

/** 命令前缀（严格大小写） */
const SKILL_CMD_PREFIX = "/skill:";

/** 解析结果 */
export interface ParsedSkillCommand {
  /** Skill 名称（不含前缀，不含空白） */
  name: string;
  /** 调用参数（name 之后的剩余文本，已 trim；可为空字符串） */
  args: string;
}

/**
 * 解析 `/skill:<name> <args>` 命令
 *
 * 前缀严格匹配 "/skill:"（大小写敏感），不匹配返回 null。
 * name 取第一段非空白字符；args 取 name 之后的剩余部分（trim）。
 *
 * @param text 用户输入
 * @returns 解析结果；不匹配返回 null
 */
export function parseSkillCommand(text: string): ParsedSkillCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(SKILL_CMD_PREFIX)) return null;
  const rest = trimmed.slice(SKILL_CMD_PREFIX.length);
  if (!rest) return null; // "/skill:" 后必须有 name
  // name = 第一段非空白字符；args = name 之后的剩余部分（trim）
  // 使用正则避免split+join造成的多次分配
  const match = rest.match(/^(\S+)\s*(.*)$/);
  if (!match) return null;
  const name = match[1];
  const args = match[2].trim();
  return { name, args };
}
