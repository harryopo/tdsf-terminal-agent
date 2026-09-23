/**
 * #110 —— SSH 连接失败的文案判据。
 *
 * 用户 2026-09-22 实测：点进已有 SSH 工作区，toast 正文是 russh 的 Rust Debug 结构体
 * （`Failure { remaining_methods: MethodSet([PublicKey]), partial_success: false }`），
 * 读不出该做什么；而且里面还写着"可在 SSH 面板手动重试"——那个面板早就没有入口了（#109）。
 * 所以判据有两类：① 认得出的形状必须讲人话并指一个**真实存在**的入口；
 * ② 认不出的必须原样保留（不许为了文案好看把线索吞了）。
 */
import { describe, expect, it } from "vitest";
import { describeSshFailure } from "./sshErrorText";

/** 真机日志里的原文（192.168.45.128，sshd 关掉了密码登录） */
const KEY_ONLY =
  "authentication failed for user root: Failure { remaining_methods: MethodSet([PublicKey]), partial_success: false }";

describe("describeSshFailure", () => {
  it("服务器只接受密钥时，标题讲人话、正文指到真实入口", () => {
    const r = describeSshFailure(KEY_ONLY);
    expect(r.headline).toBe("服务器不接受密码登录");
    expect(r.description).toContain("公钥");
    expect(r.description).toContain("新建工作区");
  });

  it("标题与正文里不许再出现 Rust Debug 字样", () => {
    const r = describeSshFailure(KEY_ONLY);
    const both = `${r.headline} ${r.description}`;
    expect(both).not.toContain("MethodSet");
    expect(both).not.toContain("remaining_methods");
    expect(both).not.toContain("partial_success");
  });

  it("清单里仍有 password 时判成「密码不对」，不是「服务器不接受密码」", () => {
    const r = describeSshFailure(
      "authentication failed for user root: Failure { remaining_methods: MethodSet([PublicKey, Password]), partial_success: false }",
    );
    expect(r.headline).toBe("用户名或密码不对");
    expect(r.headline).not.toBe("服务器不接受密码登录");
  });

  it("方法清单有空格 / 大小写差异也认得", () => {
    const r = describeSshFailure(
      "Failure { remaining_methods: MethodSet([ publickey ]), partial_success: true }",
    );
    expect(r.headline).toBe("服务器不接受密码登录");
  });

  it("网络类失败说「连不上」，并保留原文", () => {
    const r = describeSshFailure("Connection refused (os error 10061)");
    expect(r.headline).toBe("连不上这台服务器");
    expect(r.description).toContain("Connection refused");
  });

  it("认不出的错误原样保留 —— 不许为了文案干净吞掉线索", () => {
    const weird = "some brand new russh error nobody has seen: code=42";
    const r = describeSshFailure(weird);
    expect(r.headline).toBe("SSH 连接失败");
    expect(r.description).toBe(weird);
  });

  it("空字符串不崩，仍给可显示的标题", () => {
    const r = describeSshFailure("");
    expect(r.headline).toBeTruthy();
    expect(typeof r.description).toBe("string");
  });

  // 用户 2026-09-23 实测：虚机重装导致主机密钥变更，russh 抛 `Unknown server key`，
  // 旧实现的 kex 正则里有一条贪心的 `unknown`，把它翻成了"多半是双方算法不兼容"。
  // 方向完全错 —— 用户会去改服务器的 KexAlgorithms，而该做的是核对指纹后点信任。
  describe("主机密钥未被信任 ≠ 算法不兼容", () => {
    it.each([
      ["russh error: Unknown server key", "Unknown server key"],
      [
        "host key mismatch for 192.168.45.128: host key has changed",
        "host key mismatch",
      ],
    ])("%s 走「主机密钥没被信任」桶", (raw) => {
      const r = describeSshFailure(raw);
      expect(r.headline).toBe("这台服务器的主机密钥没被信任");
      expect(r.headline).not.toBe("SSH 协议协商失败");
      // 必须给出可执行的下一步，且把原文留着（#110 口径：不许为了文案干净吞掉线索）
      expect(r.description).toContain("指纹");
      expect(r.description).toContain("信任并连接");
      expect(r.description).toContain(raw);
    });

    it("反向配对：真·算法不兼容仍然走 kex 桶，没被新桶顺手吃掉", () => {
      const r = describeSshFailure("kex algorithms unavailable");
      expect(r.headline).toBe("SSH 协议协商失败");
      expect(r.description).toContain("算法不兼容");
    });
  });

  it("文案里不许指向已经不存在的「SSH 面板」", () => {
    for (const raw of [
      KEY_ONLY,
      "authentication failed",
      "Connection refused",
      "kex algorithms unavailable",
      "whatever",
    ]) {
      const r = describeSshFailure(raw);
      expect(`${r.headline}${r.description}`).not.toContain("SSH 面板");
    }
  });
});
