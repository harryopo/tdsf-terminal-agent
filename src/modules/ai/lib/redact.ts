const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github-token", re: /\bgh[opsur]_[A-Za-z0-9]{36,}\b/g },
  { kind: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "slack-token", re: /\bxox[bpsare]-[A-Za-z0-9-]{10,}\b/g },
  {
    kind: "stripe-key",
    re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g,
  },
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  { kind: "bearer", re: /\bBearer\s+[A-Za-z0-9._-]{20,}/g },
  {
    kind: "env-assign",
    re: /\b((?:[A-Z][A-Z0-9_]*)?(?:API[_-]?KEY|SECRET(?:[_-]?KEY)?|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET)[A-Z0-9_]*)\s*[:=]\s*(["']?)([^\s"';|&]+)\2/gi,
  },
  // TDSF 魔改 2026-08-28 (B1-G1): 以下 3 模式语义对齐 nyaterm redaction.rs（MIT）。
  // 注意：内网 IP 不脱敏（用户钦定 2026-08-28）——教学场景 AI 需看到 IP 判断连通性。
  {
    kind: "private-key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    kind: "authorization",
    re: /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._-]+/gi,
  },
  {
    kind: "db-url",
    re: /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s@/]+@/gi,
  },
];

export function redactSensitive(text: string): string {
  let out = text;
  for (const { kind, re } of PATTERNS) {
    if (kind === "env-assign") {
      out = out.replace(
        re,
        (_m, name, q, _val) => `${name}=${q}<REDACTED>${q}`,
      );
    } else if (kind === "authorization") {
      out = out.replace(re, "Authorization: Bearer <REDACTED:authorization>");
    } else if (kind === "db-url") {
      out = out.replace(re, "$1://<REDACTED:db-url>@");
    } else {
      out = out.replace(re, `<REDACTED:${kind}>`);
    }
  }
  return out;
}
