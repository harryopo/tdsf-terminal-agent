/**
 * src/modules/ssh-explorer/randomart.test.ts
 * ----------------------------------------------------------------------
 * 验证 OpenSSH randomart 渲染与边界情况
 */
import { describe, expect, it } from "vitest";
import {
  fingerprintToBytes,
  formatFingerprint,
  generateRandomArt,
} from "./randomart";

describe("randomart", () => {
  it("生成固定输入的稳定输出 (视觉指纹)", () => {
    // 经典 OpenSSH demo fingerprint
    const fp = "SHA256:p2QMIyoB8nTPsScUPg3G7Z7Ih2Z6K8Q8F4p4K4K4K4K";
    const art = generateRandomArt(fp, "ssh-ed25519");
    expect(art).toContain("+--[ssh-ed25519]+");
    expect(art.split("\n").length).toBeGreaterThanOrEqual(11); // border + 9 rows + border
  });

  it("兼容 SHA256: 前缀", () => {
    const a = generateRandomArt("SHA256:abcdef", "ssh-rsa");
    const b = generateRandomArt("abcdef", "ssh-rsa");
    expect(a).toBe(b);
  });

  it("兼容 : 分隔的 hex", () => {
    const a = generateRandomArt("ab:cd:ef:12", "ssh-rsa");
    const b = generateRandomArt("abcdef12", "ssh-rsa");
    expect(a).toBe(b);
  });

  it("空指纹不报错", () => {
    const art = generateRandomArt("", "ssh-rsa");
    expect(art).toContain("+--[ssh-rsa]");
  });

  it("长 keyType 截断到 16 字符", () => {
    const art = generateRandomArt("abcdef", "ecdsa-sha2-nistp521");
    expect(art).toContain("+--[ecdsa-sha2-ni...]"); // 13+3=16 字符
  });

  it("fingerprintToBytes 反向解码", () => {
    const bytes = fingerprintToBytes("abcdef");
    expect(Array.from(bytes)).toEqual([0xab, 0xcd, 0xef]);
  });

  it("fingerprintToBytes 跳过无效字符", () => {
    const bytes = fingerprintToBytes("ab cd ef");
    expect(bytes.length).toBe(3);
  });

  it("formatFingerprint 在长串上每 4 字符插入空格", () => {
    const out = formatFingerprint("abcdefghijklmnop");
    expect(out).toBe("abcd efgh ijkl mnop");
  });

  it("formatFingerprint 保留 colons 形式", () => {
    const out = formatFingerprint("ab:cd:ef:12:34");
    expect(out).toBe("ab:cd:ef:12:34");
  });
});
