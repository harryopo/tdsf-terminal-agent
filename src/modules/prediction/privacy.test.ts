import { describe, expect, it } from "vitest";
import fixture from "../../../tests/fixtures/prediction/v1/synthetic-events.json";
import {
  MAX_COMMAND_BYTES,
  cwdKeyOf,
  digestKey,
  hasLeadingSpaceIntent,
  matchSensitiveRule,
  projectCommand,
  templateCommand,
} from "./privacy";

const NS = "ns-syn-bash-01";

/** 敏感形状一律运行时拼接，避免在源码/测试里出现整串可被扫描的字面量（总账红线 33）。 */
const PRIVATE_KEY_HEADER = ["-----BEGIN ", "OPENSSH PRIVATE KEY", "-----"].join("");
const AWS_KEY = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
const TOKEN_ASSIGNMENT = ["export API", "_KEY=", "abcdef123456"].join("");
const BEARER = ["curl -H ", '"Authorization: Bearer ', "abcdef123456", '"', " https://api.example.test"].join("");
const SSH_KEY_READ = ["cat ~/.ssh/", "id_rsa"].join("");
const SHADOW_READ = ["head /etc/", "shadow"].join("");

describe("F0 隐私投影", () => {
  it("普通命令可记录且可重放", () => {
    for (const command of [
      "pwd",
      "ls -la",
      "grep -i error syslog",
      "systemctl status httpd",
      "docker run -p 8080:80 nginx",
      "ssh -p 2222 app@example.test",
      "mysql -u root -e 'select 1'",
    ]) {
      const decision = projectCommand(command, NS);
      expect(decision.allowed, command).toBe(true);
      if (decision.allowed) {
        expect(decision.replayText, command).toBe(command);
        expect(decision.templated, command).toBe(false);
        expect(decision.commandKey).toMatch(/^[0-9a-f]{16}$/);
      }
    }
  });

  it("前导空格/制表符按用户意图不记录（先于 trim 判断）", () => {
    expect(hasLeadingSpaceIntent(" echo hidden")).toBe(true);
    expect(hasLeadingSpaceIntent("\techo hidden")).toBe(true);
    expect(hasLeadingSpaceIntent("echo visible")).toBe(false);
    expect(projectCommand(" echo hidden", NS)).toEqual({
      allowed: false,
      reason: "leading-space",
    });
  });

  it("空命令与超长命令被拒", () => {
    expect(projectCommand("", NS)).toEqual({ allowed: false, reason: "empty" });
    // 纯空白按“前导空格意图”先判，不会被 trim 成空命令。
    expect(projectCommand("   ", NS)).toEqual({
      allowed: false,
      reason: "leading-space",
    });
    const tooLong = "a".repeat(MAX_COMMAND_BYTES + 1);
    expect(projectCommand(tooLong, NS)).toEqual({
      allowed: false,
      reason: "too-long",
    });
  });

  it("已知凭据/口令形状整条拒收", () => {
    const samples = [
      PRIVATE_KEY_HEADER,
      AWS_KEY,
      TOKEN_ASSIGNMENT,
      BEARER,
      SSH_KEY_READ,
      SHADOW_READ,
      "cat .aws/credentials",
      "cat ~/.kube/config",
      `mysql -p${"secret"}`,
      `redis-cli -a ${"secret"}`,
      `sshpass -p ${"secret"} ssh host`,
      `some --password=${"secret"}`,
    ];
    for (const sample of samples) {
      expect(matchSensitiveRule(sample), sample).not.toBeNull();
      expect(projectCommand(sample, NS), sample).toEqual({
        allowed: false,
        reason: "sensitive",
      });
    }
  });

  it("home 路径与 URL 模板化后不可重放，但不能被当作真实命令插入", () => {
    const home = projectCommand("ls ~/project", NS);
    expect(home.allowed).toBe(true);
    if (home.allowed) {
      expect(home.template).toBe("ls <HOME>");
      expect(home.replayText).toBeNull();
      expect(home.templated).toBe(true);
    }

    const url = projectCommand("curl https://example.test/health", NS);
    expect(url.allowed).toBe(true);
    if (url.allowed) {
      expect(url.template).toBe("curl <URL>");
      expect(url.replayText).toBeNull();
    }
  });

  it("模板不做大小写/参数次序归一化", () => {
    const result = templateCommand("LS -LA ~/Project");
    expect(result.template).toBe("LS -LA <HOME>");
    expect(templateCommand("ls /var/log").templated).toBe(false);
  });

  it("摘要带 namespace 且稳定", () => {
    const a = digestKey("ns-a", "pwd");
    const b = digestKey("ns-a", "pwd");
    const c = digestKey("ns-b", "pwd");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("cwd 只以摘要入库，无 cwd 时为 null", () => {
    expect(cwdKeyOf("ns-a", null)).toBeNull();
    expect(cwdKeyOf("ns-a", "")).toBeNull();
    expect(cwdKeyOf("ns-a", "/srv/app")).toMatch(/^[0-9a-f]{16}$/);
    expect(cwdKeyOf("ns-a", "/srv/app")).not.toBe(cwdKeyOf("ns-b", "/srv/app"));
  });

  it("夹具中的隐私样例与实现一致", () => {
    const samples = (
      fixture as unknown as {
        privacySamples: { kind: string; command: string }[];
      }
    ).privacySamples;
    const byKind = (kind: string) =>
      samples.find((sample) => sample.kind === kind)!.command;

    const leading = projectCommand(byKind("leading-space"), NS);
    expect(leading).toEqual({ allowed: false, reason: "leading-space" });

    const templated = projectCommand(byKind("templated-home"), NS);
    expect(templated.allowed).toBe(true);
    if (templated.allowed) expect(templated.replayText).toBeNull();

    const blockedPath = projectCommand(byKind("blocked-path"), NS);
    expect(blockedPath.allowed).toBe(true);
  });
});
