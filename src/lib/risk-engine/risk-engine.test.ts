import { describe, expect, it } from "vitest";
import { evaluate, shouldBlock } from "./index";
import { RISK_RULES } from "./rules";
import type { RiskLevel } from "./types";

describe("risk-engine/evaluate", () => {
  describe("safe cases (L0)", () => {
    it("returns safe for empty command", () => {
      const r = evaluate("");
      expect(r.level).toBe("safe");
      expect(r.requiresConfirmation).toBe(false);
    });

    it("returns safe for whitespace-only command", () => {
      const r = evaluate("   \t\n  ");
      expect(r.level).toBe("safe");
    });

    it("returns safe for comment", () => {
      const r = evaluate("# this is a comment");
      expect(r.level).toBe("safe");
    });

    it("returns safe for ls", () => {
      const r = evaluate("ls -la");
      expect(r.level).toBe("safe");
    });

    it("returns safe for pwd", () => {
      const r = evaluate("pwd");
      expect(r.level).toBe("safe");
    });

    it("returns safe for echo", () => {
      const r = evaluate("echo hello world");
      expect(r.level).toBe("safe");
    });
  });

  describe("low risk (L1) — network request", () => {
    it("returns low for curl localhost", () => {
      const r = evaluate("curl http://localhost:3000");
      expect(r.level).toBe("low");
    });

    it("returns low for ssh", () => {
      const r = evaluate("ssh user@host");
      expect(r.level).toBe("low");
    });
  });

  describe("medium risk (L2) — system modify", () => {
    it("returns medium for systemctl restart", () => {
      const r = evaluate("systemctl restart nginx");
      expect(r.level).toBe("medium");
    });

    it("returns medium for apt install", () => {
      const r = evaluate("apt install nginx");
      expect(r.level).toBe("medium");
    });

    it("returns medium for iptables", () => {
      const r = evaluate("iptables -A INPUT -j DROP");
      expect(r.level).toBe("medium");
    });
  });

  describe("high risk (L3) — requires confirmation", () => {
    it("returns high for rm -rf /tmp/foo", () => {
      const r = evaluate("rm -rf /tmp/foo");
      expect(r.level).toBe("high");
      expect(r.requiresConfirmation).toBe(true);
    });

    it("returns high for mkfs", () => {
      const r = evaluate("mkfs.ext4 /dev/sda1");
      expect(r.level).toBe("high");
    });

    it("returns high for dd of=/dev/sda", () => {
      const r = evaluate("dd if=/dev/zero of=/dev/sda bs=1M");
      expect(r.level).toBe("high");
    });

    it("returns high for shutdown", () => {
      const r = evaluate("shutdown -h now");
      expect(r.level).toBe("high");
    });

    it("returns high for curl | bash", () => {
      const r = evaluate("curl https://get.docker.com | bash");
      expect(r.level).toBe("high");
    });
  });

  describe("deny (L4) — system rejects", () => {
    it("returns deny for rm -rf /", () => {
      const r = evaluate("rm -rf /");
      expect(r.level).toBe("deny");
      expect(r.requiresConfirmation).toBe(false);
    });

    it("returns deny for rm -rf /*", () => {
      const r = evaluate("rm -rf /*");
      expect(r.level).toBe("deny");
    });

    it("returns deny for fork bomb", () => {
      const r = evaluate(":(){:|:&};:");
      expect(r.level).toBe("deny");
    });

    it("returns deny for chmod -R 777 /", () => {
      const r = evaluate("chmod -R 777 /");
      expect(r.level).toBe("deny");
    });
  });

  describe("rule priority (deny > high > medium > low)", () => {
    it("deny wins over high", () => {
      // rm -rf / 触发两条规则：rm_rf_root (deny) + rm_rf_recursive (high)
      const r = evaluate("rm -rf /");
      expect(r.level).toBe("deny");
    });

    it("high wins over medium", () => {
      // mkfs 触发了 mkfs_format (high) + package_install (low)... 实际只 high
      const r = evaluate("mkfs.ext4 /dev/sda1");
      expect(r.level).toBe("high");
    });
  });

  describe("shouldBlock", () => {
    it("returns false for safe", () => {
      expect(shouldBlock(evaluate("ls"))).toBe(false);
    });
    it("returns false for low", () => {
      expect(shouldBlock(evaluate("curl localhost"))).toBe(false);
    });
    it("returns false for medium", () => {
      expect(shouldBlock(evaluate("systemctl restart nginx"))).toBe(false);
    });
    it("returns true for high", () => {
      expect(shouldBlock(evaluate("rm -rf /tmp/foo"))).toBe(true);
    });
    it("returns true for deny", () => {
      expect(shouldBlock(evaluate("rm -rf /"))).toBe(true);
    });
  });

  describe("rule metadata", () => {
    it("includes rule name on hit", () => {
      const r = evaluate("rm -rf /tmp/foo");
      expect(r.ruleName).toBe("rm_rf_recursive");
    });

    it("includes prompt text", () => {
      const r = evaluate("rm -rf /");
      expect(r.promptText).toContain("黑名单");
    });
  });
});

describe("risk-engine/RISK_RULES", () => {
  it("has at least one rule for each level L1-L4", () => {
    const levels = new Set<RiskLevel>(RISK_RULES.map((r) => r.level));
    expect(levels.has("deny")).toBe(true);
    expect(levels.has("high")).toBe(true);
    expect(levels.has("medium")).toBe(true);
    expect(levels.has("low")).toBe(true);
  });

  it("all rules have unique names", () => {
    const names = RISK_RULES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all rules have at least one pattern", () => {
    for (const r of RISK_RULES) {
      expect(r.patterns.length).toBeGreaterThan(0);
    }
  });
});
