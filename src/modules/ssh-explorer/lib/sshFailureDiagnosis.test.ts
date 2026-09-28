/**
 * sshFailureDiagnosis.test.ts —— 2026-09-28 用户实测⑤
 * -----------------------------------------------------------------------------
 * 他要的是"分析到底是哪一步有问题，是服务器没开密码登录，还是什么原因"。
 * 输入全部用**真机 rust.log 里的原文**（192.168.45.128 那条认证失败、Rust 自己的
 * 超时 Display、russh 的 Unknown server key），不是照着想当然编的字符串。
 *
 * 两条最容易糊弄的地方各有一条判据：
 * ① 卡在后一步时，前面的步骤必须标"已通过"——这是能说的（russh 只在
 *    check_server_key 返回 Ok 之后才发认证），不说就是没把证据用掉；
 * ② 认不出的形状**不许**把任何一步说成通过了（一律 unknown），
 *    否则就是把猜的写成事实（#113②/#123 同族病）。
 */
import { describe, expect, it } from "vitest";
import { describeSshFailure } from "./sshErrorText";
import { diagnoseSshFailure } from "./sshFailureDiagnosis";

/** 他 2026-09-28 16:58:26 那条：服务器接受密码，但这次凭据被拒 */
const AUTH_REJECTED_BOTH =
  "authentication failed for user root: Failure { remaining_methods: MethodSet([PublicKey, Password]), partial_success: false }";

/** Ubuntu 默认 PermitRootLogin prohibit-password 的形状（#110 截图那条） */
const AUTH_NO_PASSWORD =
  "authentication failed for user root: Failure { remaining_methods: MethodSet([PublicKey]), partial_success: false }";

const state = (raw: string, key: string) =>
  diagnoseSshFailure(raw).stages.find((s) => s.key === key)?.state;

describe("认证失败：前三步必须标成已通过", () => {
  it("russh 走到认证就说明端口/握手/主机身份都过了", () => {
    const d = diagnoseSshFailure(AUTH_REJECTED_BOTH, {
      host: "192.168.45.128",
      port: 22,
      user: "root",
    });
    expect(d.stuckAt).toBe("auth");
    expect(state(AUTH_REJECTED_BOTH, "network")).toBe("passed");
    expect(state(AUTH_REJECTED_BOTH, "handshake")).toBe("passed");
    expect(state(AUTH_REJECTED_BOTH, "hostKey")).toBe("passed");
    // 认证之后的步骤不存在，但顺序上"没走到"的那一侧要留着判据（这里 auth 就是终点）
    expect(d.stages.map((s) => s.key)).toEqual([
      "network",
      "handshake",
      "hostKey",
      "auth",
    ]);
  });

  it("remaining_methods 原样带出来，回答『服务器有没有开密码登录』", () => {
    const d = diagnoseSshFailure(AUTH_REJECTED_BOTH);
    expect(d.serverMethods).toEqual(["PublicKey", "Password"]);
  });

  it("清单里没有 Password 时，卡住的这一步要说『没把密码列为可用方式』", () => {
    const auth = diagnoseSshFailure(AUTH_NO_PASSWORD).stages.find(
      (s) => s.key === "auth",
    );
    expect(auth?.note).toContain("没把「密码」列为可用方式");
    expect(auth?.note).not.toContain("重填密码");
  });

  it("清单里有 Password 时，说的是『拒绝了这一次提交的凭据』并带上用户名", () => {
    const auth = diagnoseSshFailure(AUTH_REJECTED_BOTH, {
      host: "192.168.45.128",
      port: 22,
      user: "root",
    }).stages.find((s) => s.key === "auth");
    expect(auth?.note).toContain("拒绝了这一次提交的凭据");
    expect(auth?.note).toContain("提交的用户名是 root");
  });
});

describe("前面几步失败：后面的步骤不许说通过", () => {
  it("端口不通 → 只有第一步失败，其余没走到", () => {
    const d = diagnoseSshFailure(
      "SSH 连接超时(10s): 服务器不可达或端口未开放",
      { host: "192.168.45.128", port: 22 },
    );
    expect(d.stuckAt).toBe("network");
    expect(state("SSH 连接超时(10s): 服务器不可达或端口未开放", "handshake")).toBe(
      "notReached",
    );
    // 正向配对：endpoint 真的进了文案，不是永远只写"目标地址"
    expect(
      diagnoseSshFailure("SSH 连接超时(10s): x", {
        host: "10.0.0.9",
        port: 2222,
      }).stages[0].note,
    ).toContain("10.0.0.9:2222");
  });

  it("主机身份没被信任 → 前两步通过、第三步失败、认证没走到", () => {
    const raw = "Unknown server key for host 192.168.45.128";
    expect(state(raw, "network")).toBe("passed");
    expect(state(raw, "handshake")).toBe("passed");
    expect(state(raw, "hostKey")).toBe("failed");
    expect(state(raw, "auth")).toBe("notReached");
  });

  it("协议协商失败 → 只说端口通了，不许说主机身份过了", () => {
    const raw = "russh error: kex negotiation failed";
    expect(state(raw, "network")).toBe("passed");
    expect(state(raw, "handshake")).toBe("failed");
    expect(state(raw, "hostKey")).toBe("notReached");
  });
});

describe("认不出的形状：老实说判不出来", () => {
  it("每一步都是 unknown，原始信息照原样给", () => {
    const d = diagnoseSshFailure("完全没见过的报错 42");
    expect(d.stuckAt).toBeNull();
    expect(d.stages.every((s) => s.state === "unknown")).toBe(true);
    expect(d.raw).toBe("完全没见过的报错 42");
  });
});

describe("人话部分不写第二份", () => {
  it("标题与『怎么办』逐字复用 #110 的唯一主人 describeSshFailure", () => {
    for (const raw of [
      AUTH_REJECTED_BOTH,
      AUTH_NO_PASSWORD,
      "SSH 连接超时(10s): 服务器不可达或端口未开放",
      "Unknown server key for host h",
      "没见过的形状",
    ]) {
      const d = diagnoseSshFailure(raw);
      const copy = describeSshFailure(raw);
      expect(d.headline).toBe(copy.headline);
      expect(d.description).toBe(copy.description);
    }
  });
});
