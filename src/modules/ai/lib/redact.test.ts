import { describe, expect, it } from "vitest";
import { redactSensitive } from "./redact";

const SECRETS: Array<{ name: string; secret: string }> = [
  { name: "openai key", secret: "sk-proj-abcdefghijklmnopqrstuvwxyz012345" },
  { name: "anthropic key", secret: "sk-ant-abcdefghijklmnopqrstuvwxyz012345" },
  { name: "aws access key", secret: "AKIA1234567890ABCDEF" },
  { name: "github token", secret: `ghp_${"a".repeat(36)}` },
  { name: "github pat", secret: `github_pat_${"A".repeat(40)}` },
  { name: "google api key", secret: `AIza${"a".repeat(35)}` },
  { name: "slack token", secret: `xoxb-${"1".repeat(12)}` },
  { name: "stripe key", secret: `sk_live_${"a".repeat(24)}` },
  { name: "jwt", secret: "eyJabcdefgh.ZYXWVUTSR.qwertyuiop" },
];

describe("redactSensitive", () => {
  for (const { name, secret } of SECRETS) {
    it(`removes a ${name} from surrounding text`, () => {
      const out = redactSensitive(`prefix ${secret} suffix`);
      expect(out).not.toContain(secret);
      expect(out).toContain("<REDACTED");
      expect(out.startsWith("prefix ")).toBe(true);
      expect(out.endsWith(" suffix")).toBe(true);
    });
  }

  it("redacts a bearer token while keeping the header name", () => {
    const out = redactSensitive(
      "Authorization: Bearer abcdefghijklmnopqrstuvwx",
    );
    expect(out).not.toContain("abcdefghijklmnopqrstuvwx");
    expect(out).toContain("Authorization:");
  });

  it("redacts an assigned secret value but keeps the key name", () => {
    const out = redactSensitive('MY_SECRET_KEY="hunter2hunter2"');
    expect(out).toContain("MY_SECRET_KEY");
    expect(out).not.toContain("hunter2hunter2");
    expect(out).toContain("<REDACTED>");
  });

  it("redacts a password assignment", () => {
    const out = redactSensitive("DB_PASSWORD=p@ssw0rdlong");
    expect(out).not.toContain("p@ssw0rdlong");
    expect(out).toContain("DB_PASSWORD");
  });

  it("leaves non-sensitive text untouched", () => {
    const text = "just a normal log line with no secrets";
    expect(redactSensitive(text)).toBe(text);
  });

  it("redacts every secret when several appear together", () => {
    const input = `openai sk-proj-${"a".repeat(24)} and aws AKIA1234567890ABCDEF`;
    const out = redactSensitive(input);
    expect(out).not.toContain("AKIA1234567890ABCDEF");
    expect(out).not.toContain(`sk-proj-${"a".repeat(24)}`);
  });

  // ── TDSF 魔改 2026-08-28 (B1-G1): 对齐 nyaterm redaction.rs 的 3 个新模式 ──

  it("redacts a PEM private key block across lines", () => {
    const key = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA0123456789abcdef",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = redactSensitive(`id_rsa:\n${key}\ndone`);
    expect(out).not.toContain("MIIEpAIBAAKCAQEA0123456789abcdef");
    expect(out).toContain("<REDACTED:private-key>");
    expect(out).toContain("id_rsa:");
  });

  it("redacts an Authorization header value", () => {
    const out = redactSensitive(
      "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwx' http://x",
    );
    // 注：bearer 模式先命中长 token，authorization 模式兜底短 token/其他形式——
    // 断言只验证"值被移除 + 头名保留"，具体 kind 标签不敏感
    expect(out).not.toContain("abcdefghijklmnopqrstuvwx");
    expect(out).toContain("Authorization:");
    expect(out).toContain("<REDACTED");
  });

  it("redacts credentials embedded in a database URL", () => {
    const out = redactSensitive(
      "psql postgres://admin:s3cret@db.example.com:5432/app",
    );
    expect(out).not.toContain("admin:s3cret");
    expect(out).toContain("postgres://<REDACTED:db-url>@db.example.com:5432/app");
  });

  it("leaves intranet IPv4 addresses untouched (user decision 2026-08-28)", () => {
    const text = "ssh root@192.168.45.200 failed; try 10.0.0.5";
    expect(redactSensitive(text)).toBe(text);
  });
});
