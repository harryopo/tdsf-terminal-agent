import { describe, expect, it } from "vitest";
import {
  BOOT_CHECK_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
  collectInstallBlockers,
  describeUpdateFailure,
  downloadConfirmCopy,
  formatBytes,
  shouldAutoCheck,
} from "./updateFacts";

describe("自动检查的节流", () => {
  it("从没查过 ⇒ 该查", () => {
    expect(shouldAutoCheck(1_000_000, null)).toBe(true);
  });

  it("刚查过 ⇒ 不查", () => {
    expect(shouldAutoCheck(1_000_000, 999_000)).toBe(false);
  });

  it("刚好满一天 ⇒ 该查（边界含）", () => {
    expect(
      shouldAutoCheck(1_000_000 + UPDATE_CHECK_INTERVAL_MS, 1_000_000),
    ).toBe(true);
  });

  it("差一秒不满一天 ⇒ 不查", () => {
    expect(
      shouldAutoCheck(1_000_000 + UPDATE_CHECK_INTERVAL_MS - 1, 1_000_000),
    ).toBe(false);
  });

  it("启动延迟必须晚于界面首屏，且远小于检查间隔（顺序别倒过来）", () => {
    expect(BOOT_CHECK_DELAY_MS).toBeLessThan(UPDATE_CHECK_INTERVAL_MS);
  });
});

describe("安装前的拒绝条件", () => {
  it("四类各出一条，且每条都说清该等什么", () => {
    const got = collectInstallBlockers({
      sidecarApprovals: 2,
      hostApprovals: 1,
      agentRunning: true,
      pendingExecutions: 3,
    });
    expect(got.map((b) => b.key)).toEqual([
      "sidecar-approvals",
      "host-approvals",
      "agent-running",
      "pending-executions",
    ]);
    expect(got[0].text).toContain("2 条");
    expect(got[3].text).toContain("3 条");
  });

  it("全零 ⇒ 一条都不该有（负向必须配正向：上一条证明它会给数）", () => {
    expect(
      collectInstallBlockers({
        sidecarApprovals: 0,
        hostApprovals: 0,
        agentRunning: false,
        pendingExecutions: 0,
      }),
    ).toEqual([]);
  });
});

describe("下载前的确认文案", () => {
  const copy = downloadConfirmCopy({ version: "1.0.2", bytes: 219_060_856 });

  it("必须说清体积（全量包，不是增量）", () => {
    expect(copy.description).toContain("209 MB");
    expect(copy.description).toContain("不是增量");
  });

  it("必须说清会重启、会断 SSH —— 应用突然消失不该让人以为坏了", () => {
    expect(copy.description).toContain("重启应用");
    expect(copy.description).toContain("SSH");
    expect(copy.description).toContain("终端标签页");
  });

  it("标题带上版本号", () => {
    expect(copy.title).toContain("1.0.2");
  });

  it("拿不到体积时不许编一个数", () => {
    const unknown = downloadConfirmCopy({ version: "1.0.2", bytes: null });
    expect(unknown.description).not.toMatch(/\d+\s*MB/);
    expect(unknown.description).toContain("体积较大");
  });

  it("界面按纯文本渲染 ⇒ 文案里不得出现 markdown 反引号", () => {
    const all = [copy.title, copy.description, copy.confirm, copy.cancel].join(
      "\n",
    );
    expect(all).not.toContain("`");
  });
});

describe("失败原因要分得开（不许把四种病糊成一句）", () => {
  it("清单还没发布（404）", () => {
    expect(describeUpdateFailure(new Error("HTTP status code: 404"))).toContain(
      "还没有正式发布过新版本",
    );
  });

  // 用户 2026-09-28 实测①：装着 0.9.0 点检查更新，界面甩出插件的英文原文
  // `Could not fetch a valid release JSON from the remote`（当时 v0.9.0 还是草稿）。
  it("远端解析不出版本（最新发布是草稿）⇒ 说清不是本机的问题", () => {
    const text = describeUpdateFailure(
      new Error("Could not fetch a valid release JSON from the remote"),
    );
    expect(text).toContain("远端还没有可解析的正式版本");
    expect(text).toContain("草稿");
    // 线索不许吞：原文仍然在
    expect(text).toContain("Could not fetch a valid release JSON");
  });

  it("这条新增的桶不许把网络故障一起吃掉", () => {
    // 真断网时插件报的是连接类错误，仍然该指去"检查网络"，而不是"等正式发布"
    expect(describeUpdateFailure(new Error("connection failed"))).toContain(
      "连不上更新服务器",
    );
  });

  it("网络不通", () => {
    expect(
      describeUpdateFailure(new Error("dns error: no records found")),
    ).toContain("连不上更新服务器");
  });

  it("签名校验不过 ⇒ 明确说没装", () => {
    const text = describeUpdateFailure(new Error("invalid signature"));
    expect(text).toContain("校验未通过");
    expect(text).toContain("已放弃安装");
  });

  it("本窗没有权限（设置在另一扇窗时会撞上）", () => {
    expect(
      describeUpdateFailure(new Error("updater.check not allowed")),
    ).toContain("主窗口");
  });

  it("认不出的错误原样带出，不吞线索", () => {
    const raw = "某种没见过的失败 abc123";
    expect(describeUpdateFailure(new Error(raw))).toContain(raw);
  });

  it("每个分桶都必须保留原始信息（只给结论会让下一手无从查起）", () => {
    for (const raw of [
      "HTTP status code: 404",
      "dns error: x",
      "invalid signature",
      "updater.check not allowed",
      "没见过的",
    ]) {
      expect(describeUpdateFailure(new Error(raw))).toContain(raw);
    }
  });
});

describe("体积显示", () => {
  it("MB 取整", () => {
    expect(formatBytes(219_060_856)).toBe("209 MB");
  });
  it("不到 1MB 用 KB", () => {
    expect(formatBytes(2048)).toBe("2 KB");
  });
  it("拿不到数字就说未知，不显示 0 MB", () => {
    expect(formatBytes(0)).toBe("未知大小");
    expect(formatBytes(Number.NaN)).toBe("未知大小");
  });
});
