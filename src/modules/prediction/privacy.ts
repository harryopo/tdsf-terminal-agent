/**
 * F0 隐私投影 v1（冻结候选，2026-11-12）
 * -----------------------------------------------------------------------------
 * 设计真源：01-开发方案书 §4.2 记录规则、§4.3 隐私/存储/降级、§7 安全接线。
 *
 * 职责：在命令进入学习库之前做**单点投影**——判断是否可记录、生成带 namespace 的
 * 摘要 key、生成用于统计关联的模板、决定是否可重放。后端必须用同一规则再校验一次；
 * 命中敏感信息整条丢弃，不做"占位后仍可插入"的候选。
 *
 * 明确边界：
 * - 这里是尽力而为的正则过滤，不是安全保证；它防的是已知凭据/口令形状误入库。
 * - `<HOME>`/`<URL>` 等占位符只用于统计，**绝不能**作为真实命令插入（replayText=null）。
 * - 摘要可被猜测，不是加密或匿名保证；原始路径只在当前会话使用。
 */

export const MAX_COMMAND_BYTES = 8192;

export type PrivacyRejectReason =
  | "leading-space"
  | "empty"
  | "too-long"
  | "sensitive";

export type PrivacyDecision =
  | {
      allowed: true;
      commandKey: string;
      template: string;
      replayText: string | null;
      templated: boolean;
    }
  | { allowed: false; reason: PrivacyRejectReason };

type SensitiveRule = {
  name: string;
  test: RegExp;
};

/**
 * 已知凭据/口令形状。注意：测试与源码**不得**写出整串真实凭据字面量
 * （总账红线 33：GitHub 密钥扫描会命中注释里的整串）。AWS 前缀在这里两段拼接。
 */
const AWS_ACCESS_KEY = new RegExp("AK" + "IA[0-9A-Z]{16}");
const AWS_SESSION_KEY = new RegExp("AS" + "IA[0-9A-Z]{16}");

const SENSITIVE_RULES: SensitiveRule[] = [
  {
    name: "private-key-header",
    test: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  },
  {
    name: "shadow-file",
    test: /(^|[\s"'=])\/etc\/(shadow|gshadow)(\s|$|["'])/,
  },
  {
    name: "ssh-private-key-path",
    test: /(^|[\s"'=])(~|\/home\/[^/\s]+\/\.ssh\/|\/root\/\.ssh\/)[^\s"']*id_(rsa|dsa|ecdsa|ed25519)/,
  },
  {
    name: "aws-credentials-file",
    test: /\.aws\/credentials|\.aws\/config/,
  },
  {
    name: "kube-config",
    test: /\.kube\/config/,
  },
  {
    name: "env-file-read",
    test: /(^|[\s;|&])(cat|head|tail|less|more|source|\.)\s+[^\s;|&]*\.env(\s|$|;|\|)/,
  },
  {
    name: "aws-access-key",
    test: AWS_ACCESS_KEY,
  },
  {
    name: "aws-session-key",
    test: AWS_SESSION_KEY,
  },
  {
    name: "bearer-token",
    test: /Authorization:\s*Bearer\s+\S+/i,
  },
  {
    name: "password-flag",
    test: /(^|\s)(--password|--passwd)[=\s]+\S+/i,
  },
  {
    name: "token-assignment",
    test: /\b(API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|SECRET[_-]?KEY|PASSWORD|PASSWD)\s*=\s*["']?[^\s"']{6,}/i,
  },
  {
    name: "curl-userinfo",
    test: /\bcurl\b[^\n]*\s-u\s+\S+:\S+/,
  },
  {
    name: "sshpass",
    test: /\bsshpass\s+-p\s*\S+/,
  },
  {
    name: "mysql-password",
    test: /\bmysql\b[^\n]*\s-p\S+/,
  },
  {
    name: "redis-auth",
    test: /\bredis-cli\b[^\n]*\s-a\s+\S+/,
  },
];

/**
 * 前导空格是用户明确的“不记录”意图：必须在 trim 之前判断。
 * 返回 true 表示该行按用户意图不进入学习。
 */
export function hasLeadingSpaceIntent(raw: string): boolean {
  return raw.length > 0 && (raw[0] === " " || raw[0] === "\t");
}

/** 命中已知敏感形状时返回规则名；未命中返回 null。 */
export function matchSensitiveRule(raw: string): string | null {
  for (const rule of SENSITIVE_RULES) {
    if (rule.test.test(raw)) return rule.name;
  }
  return null;
}

/** 64 位 FNV-1a 摘要（带 namespace，等值匹配用；不是加密）。 */
export function digestKey(namespaceId: string, text: string): string {
  const payload = `${namespaceId}\u0000${text}`;
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const ch of payload) {
    hash ^= BigInt(ch.codePointAt(0) ?? 0);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** cwd 也只以摘要形式入库；无可靠 cwd 时返回 null（相关特征项按 0 计）。 */
export function cwdKeyOf(
  namespaceId: string,
  cwd: string | null | undefined,
): string | null {
  if (!cwd) return null;
  return digestKey(namespaceId, `cwd:${cwd}`);
}

type TemplateResult = {
  template: string;
  templated: boolean;
};

/**
 * 生成统计用模板：只替换会暴露身份/来源的片段（home 路径、URL）。
 * 不做参数归一化（大小写、引号、参数次序保持原样）。
 */
export function templateCommand(raw: string): TemplateResult {
  let templated = false;
  let template = raw.replace(
    /(^|[\s"'=])(~\/[^\s"']*|\/home\/[^/\s]+\/[^\s"']*)/g,
    (_match, lead: string) => {
      templated = true;
      return `${lead}<HOME>`;
    },
  );
  template = template.replace(/https?:\/\/\S+/g, () => {
    templated = true;
    return "<URL>";
  });
  return { template, templated };
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * 命令投影入口。调用顺序固定：前导空格 → 空 → 长度 → 敏感 → 模板/摘要。
 * 返回 allowed=false 时调用方必须整条丢弃，并断开转移（不能跳过中间事件造邻接）。
 */
export function projectCommand(
  raw: string,
  namespaceId: string,
): PrivacyDecision {
  if (hasLeadingSpaceIntent(raw)) {
    return { allowed: false, reason: "leading-space" };
  }
  const text = raw.trim();
  if (text.length === 0) return { allowed: false, reason: "empty" };
  if (utf8ByteLength(text) > MAX_COMMAND_BYTES) {
    return { allowed: false, reason: "too-long" };
  }
  if (matchSensitiveRule(text)) {
    return { allowed: false, reason: "sensitive" };
  }
  const { template, templated } = templateCommand(text);
  return {
    allowed: true,
    commandKey: digestKey(namespaceId, text),
    template,
    replayText: templated ? null : text,
    templated,
  };
}
