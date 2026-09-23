/**
 * hostKeyGuidance.test.ts —— 主机密钥确认框的文案判据
 *
 * 用户 2026-09-23 实测：他的虚机重装导致密钥变更，界面上只有一句"可能存在中间人攻击"，
 * 他不知道真正的原因（重装）该怎么确认。所以这条测试钉的不是"有没有吓唬用户"，而是
 * **有没有把最常见的原因排在前面、并且给出按算法对得上的核对命令**。
 */
import { describe, expect, it } from "vitest";
import { hostKeyGuidance, hostKeyVerifyCommand } from "./hostKeyGuidance";

describe("hostKeyGuidance — 两种情形各说各话", () => {
  it("密钥变更：标红、列重装等真实原因，中间人排最后但不省略", () => {
    const g = hostKeyGuidance({ isMismatch: true, keyType: "ssh-ed25519" });
    expect(g.title).toBe("主机密钥已变更");
    expect(g.danger).toBe(true);
    expect(g.causes.length).toBeGreaterThanOrEqual(3);
    // 最常见的原因必须排在头一条，否则用户只会去怀疑被攻击
    expect(g.causes[0]).toContain("重装");
    expect(g.causes[g.causes.length - 1]).toContain("中间人");
  });

  it("首次连接：不标红，也不吓人说中间人（本机没有可比对的基准）", () => {
    const g = hostKeyGuidance({ isMismatch: false, keyType: "ssh-ed25519" });
    expect(g.title).toBe("首次连接该主机");
    expect(g.danger).toBe(false);
    expect(g.causes.join(" ")).not.toContain("中间人");
  });

  it("两种情形都必须给出可执行的核对命令与说明", () => {
    for (const isMismatch of [true, false]) {
      const g = hostKeyGuidance({ isMismatch, keyType: "ssh-rsa" });
      expect(g.verifyCommand).toContain("ssh-keygen -lf");
      expect(g.verifyNote).toContain("服务器");
    }
  });
});

describe("hostKeyVerifyCommand — 文件名要跟着算法走", () => {
  it.each([
    ["ssh-ed25519", "ssh_host_ed25519_key.pub"],
    ["ssh-rsa", "ssh_host_rsa_key.pub"],
    ["ecdsa-sha2-nistp384", "ssh_host_ecdsa_key.pub"],
  ])("%s → %s", (keyType, file) => {
    expect(hostKeyVerifyCommand(keyType)).toBe(`ssh-keygen -lf /etc/ssh/${file}`);
  });

  it("算法不认识时退回通配，绝不编一个具体文件名", () => {
    expect(hostKeyVerifyCommand("ssh-unknown-thing")).toContain("ssh_host_*_key.pub");
    expect(hostKeyVerifyCommand(undefined)).toContain("ssh_host_*_key.pub");
  });
});
