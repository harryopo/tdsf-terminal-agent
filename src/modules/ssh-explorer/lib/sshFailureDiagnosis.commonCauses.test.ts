import { describe, expect, it } from "vitest";
import { diagnoseSshFailure } from "./sshFailureDiagnosis";

function causesFor(raw: string): string[] {
  return diagnoseSshFailure(raw).commonCauses;
}

describe("SSH 诊断的常见原因清单（2026-10-30 用户要求）", () => {
  it("网络阶段：给出关机 / 换 IP / 防火墙 / 网络 / sshd 五类常见原因", () => {
    const causes = causesFor("SSH 连接超时(10s): 服务器不可达或端口未开放");
    expect(causes.length).toBeGreaterThanOrEqual(3);
    expect(causes.join("\n")).toMatch(/关机|重启/);
    expect(causes.join("\n")).toMatch(/防火墙|安全组/);
    // 网络阶段不该混入认证类原因
    expect(causes.join("\n")).not.toMatch(/密码/);
  });

  it("认证阶段：说的是凭据/登录方式，不再提防火墙", () => {
    const causes = causesFor(
      "authentication failed for user root: Failure { remaining_methods: MethodSet([PublicKey]), partial_success: false }",
    );
    const text = causes.join("\n");
    expect(text).toMatch(/公钥|密码/);
    expect(text).not.toMatch(/防火墙|安全组/);
  });

  it("认不出的报错给保底自查建议，不硬猜阶段", () => {
    const causes = causesFor("完全没见过的报错 42");
    expect(causes.length).toBeGreaterThan(0);
    expect(causes.join("\n")).toMatch(/测试连接|sshd|日志/);
  });

  it("每条原因都是非空字符串（界面上不留空行）", () => {
    for (const raw of ["test timed out", "host key mismatch", "kex error", "auth failed"]) {
      for (const cause of causesFor(raw)) {
        expect(cause.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
