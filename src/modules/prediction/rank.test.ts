import { describe, expect, it } from "vitest";
import { rankComponents, rankV1 } from "./rank";

const DAY = 24 * 60 * 60 * 1000;

describe("rank-v1", () => {
  it("T：后继总数不足 2 时取 0", () => {
    expect(
      rankComponents({
        transitionCount: 1,
        transitionTotal: 1,
        frequency: 1,
        maxFrequency: 1,
        lastUsedAt: null,
        cwdCount: 0,
        totalCount: 1,
        now: 0,
      }).transition,
    ).toBe(0);
    expect(
      rankComponents({
        transitionCount: 1,
        transitionTotal: 2,
        frequency: 1,
        maxFrequency: 1,
        lastUsedAt: null,
        cwdCount: 0,
        totalCount: 1,
        now: 0,
      }).transition,
    ).toBe(0.5);
  });

  it("F：分母为 0 时取 0，归一化到合格池最大频次", () => {
    const zero = rankComponents({
      transitionCount: 0,
      transitionTotal: 0,
      frequency: 0,
      maxFrequency: 0,
      lastUsedAt: null,
      cwdCount: 0,
      totalCount: 0,
      now: 0,
    });
    expect(zero.frequency).toBe(0);
    const half = rankComponents({
      transitionCount: 0,
      transitionTotal: 0,
      frequency: 5,
      maxFrequency: 25,
      lastUsedAt: null,
      cwdCount: 0,
      totalCount: 5,
      now: 0,
    });
    expect(half.frequency).toBeGreaterThan(0);
    expect(half.frequency).toBeLessThan(1);
  });

  it("R：7 天半衰", () => {
    const fresh = rankComponents({
      transitionCount: 0,
      transitionTotal: 0,
      frequency: 1,
      maxFrequency: 1,
      lastUsedAt: 0,
      cwdCount: 0,
      totalCount: 1,
      now: 0,
    }).recency;
    const week = rankComponents({
      transitionCount: 0,
      transitionTotal: 0,
      frequency: 1,
      maxFrequency: 1,
      lastUsedAt: 0,
      cwdCount: 0,
      totalCount: 1,
      now: 7 * DAY,
    }).recency;
    expect(fresh).toBe(1);
    expect(week).toBeCloseTo(0.5, 6);
  });

  it("C：同 cwd 次数平滑", () => {
    const none = rankComponents({
      transitionCount: 0,
      transitionTotal: 0,
      frequency: 1,
      maxFrequency: 1,
      lastUsedAt: 0,
      cwdCount: 0,
      totalCount: 10,
      now: 0,
    }).cwd;
    const many = rankComponents({
      transitionCount: 0,
      transitionTotal: 0,
      frequency: 1,
      maxFrequency: 1,
      lastUsedAt: 0,
      cwdCount: 10,
      totalCount: 10,
      now: 0,
    }).cwd;
    expect(none).toBeCloseTo(1 / 12, 6);
    expect(many).toBeCloseTo(11 / 12, 6);
  });

  it("总分有界且在满分输入下接近 1", () => {
    const score = rankV1({
      transitionCount: 4,
      transitionTotal: 4,
      frequency: 25,
      maxFrequency: 25,
      lastUsedAt: 0,
      cwdCount: 25,
      totalCount: 25,
      now: 0,
    });
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThan(0.99);
  });
});
