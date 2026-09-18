/**
 * autoTypeLedger.test.ts — 命令卡自动打字去重账本
 * -----------------------------------------------------------------------------
 * 覆盖两类原始缺陷（重挂重放 / 同批互踩）+ 代码审查 H2、M2 补的两条：
 *   H2：注入失败不能被永久记账，且记账要按会话分域，否则 `git status` 这类
 *       常见命令会在整个应用生命周期里再也不自动打字且无任何提示；
 *   批次边界：同一次宏任务内只放行一张卡，下一条流式增量（新的宏任务）可以正常打字。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetAutoTypeLedger,
  claimAutoType,
  markAutoTyped,
} from "./autoTypeLedger";

/** 让当前宏任务结束（批次边界复位）。 */
const nextBatch = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  __resetAutoTypeLedger();
});

describe("autoTypeLedger — 会话内去重", () => {
  it("已成功打字的命令，同一会话内重挂不再打字", () => {
    expect(claimAutoType("git status", "sess-A")).toBe(true);
    markAutoTyped("git status", "sess-A");
    expect(claimAutoType("git status", "sess-A")).toBe(false);
  });

  it("换到另一个会话，同一条命令可以重新自动打字（H2 回归）", async () => {
    expect(claimAutoType("git status", "sess-A")).toBe(true);
    markAutoTyped("git status", "sess-A");
    // 批次边界是"同一时刻只打一条"，与会话分域无关，先让本批结束
    await nextBatch();
    expect(claimAutoType("git status", "sess-B")).toBe(true);
  });

  it("注入失败（只 claim 未 mark）不会被永久烧毁，下一批仍可尝试", async () => {
    expect(claimAutoType("ls -la", "sess-A")).toBe(true);
    await nextBatch();
    expect(claimAutoType("ls -la", "sess-A")).toBe(true);
  });

  it("无会话上下文（activeSessionId=null）也照常工作，且与有会话的作用域互不影响", async () => {
    expect(claimAutoType("df -h", null)).toBe(true);
    markAutoTyped("df -h", null);
    expect(claimAutoType("df -h", null)).toBe(false);
    await nextBatch();
    expect(claimAutoType("df -h", "sess-A")).toBe(true);
  });

  it("空命令 / 纯空白不认领", async () => {
    expect(claimAutoType("", "sess-A")).toBe(false);
    expect(claimAutoType("   ", "sess-A")).toBe(false);
    await nextBatch();
    expect(claimAutoType("echo hi", "sess-A")).toBe(true);
  });
});

describe("autoTypeLedger — 同批互踩", () => {
  it("同一次宏任务内第二张卡被拒（两条命令不会拼进同一行）", () => {
    expect(claimAutoType("ls -la", "sess-A")).toBe(true);
    expect(claimAutoType("cd /tmp", "sess-A")).toBe(false);
  });

  it("被拒的卡不记账：批次结束后它还能被正常打字（手动 Run 之外仍有出路）", async () => {
    expect(claimAutoType("ls -la", "sess-A")).toBe(true);
    markAutoTyped("ls -la", "sess-A");
    expect(claimAutoType("cd /tmp", "sess-A")).toBe(false);
    await nextBatch();
    expect(claimAutoType("cd /tmp", "sess-A")).toBe(true);
  });
});
