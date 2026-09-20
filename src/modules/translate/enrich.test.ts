/**
 * P6 翻译兜底的测试：增量词库、查词优先级、模型兜底客户端，以及
 * "生成文本只进展示层"这条红线。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearEnrichments,
  ENRICHMENT_LIMIT,
  listEnrichments,
  lookupEnrichments,
  putEnrichment,
} from "./enrichmentStore";
import { translateText } from "./translateApi";
import {
  ENRICH_SESSION_QUOTA,
  enrichQuotaLeft,
  enrichTerm,
  isEnrichableTerm,
  parseEnrichResponse,
  resetEnrichQuota,
} from "./enrichClient";

const generateText = vi.fn();
const getAllKeys = vi.fn();

vi.mock("ai", () => ({ generateText: (args: unknown) => generateText(args) }));
vi.mock("@/modules/ai/lib/keyring", () => ({
  getAllKeys: () => getAllKeys(),
  hasAnyKey: (keys: Record<string, string | null>) =>
    Object.values(keys).some(Boolean),
}));
vi.mock("@/modules/ai/lib/agent", () => ({
  buildLanguageModel: async () => ({ fake: "model" }),
}));
vi.mock("@/modules/ai/config", () => ({
  DEFAULT_MODEL_ID: "test-model",
  getModel: () => ({ provider: "openai", id: "test-model" }),
}));

beforeEach(() => {
  clearEnrichments();
  resetEnrichQuota();
  generateText.mockReset();
  getAllKeys.mockReset();
  getAllKeys.mockResolvedValue({ openai: "sk-test" });
});

describe("enrichmentStore（本地增量词库）", () => {
  it("写入后可查回，且带 exact 标记", () => {
    putEnrichment({
      word: "kubectlx",
      zh: "K8s 命令行工具",
      example: "kubectl get po",
    });
    expect(lookupEnrichments("kubectlx")).toEqual([
      {
        word: "kubectlx",
        zh: "K8s 命令行工具",
        example: "kubectl get po",
        exact: true,
      },
    ]);
  });

  it("大小写不敏感，同一个词重复补全只覆盖不追加", () => {
    putEnrichment({ word: "FooBar", zh: "旧释义" });
    putEnrichment({ word: "foobar", zh: "新释义" });
    expect(listEnrichments()).toHaveLength(1);
    expect(lookupEnrichments("FOOBAR")[0].zh).toBe("新释义");
  });

  it("空释义不写入；超过上限按先进先出截断", () => {
    putEnrichment({ word: "x1", zh: "   " });
    expect(listEnrichments()).toHaveLength(0);

    for (let i = 0; i < ENRICHMENT_LIMIT + 10; i++) {
      putEnrichment({ word: `w${i}`, zh: `释义${i}` });
    }
    const all = listEnrichments();
    expect(all).toHaveLength(ENRICHMENT_LIMIT);
    expect(lookupEnrichments("w0")).toEqual([]); // 最旧的先被丢
    expect(lookupEnrichments(`w${ENRICHMENT_LIMIT + 9}`).length).toBe(1);
  });
});

describe("查词优先级（离线词库 → 增量词库 → ECDICT → …）", () => {
  it("增量词库排在 ECDICT 之前", () => {
    // give 一定在 ECDICT 8 万条里；补一条自己的释义后应优先命中本地增量
    expect(translateText("give").entries[0].zh).not.toBe("喂给本地增量词库");
    putEnrichment({ word: "give", zh: "喂给本地增量词库" });
    expect(translateText("give").entries[0].zh).toBe("喂给本地增量词库");
  });

  it("命中结果仍然是结构完整的 TranslationResult（供卡片直接渲染）", () => {
    putEnrichment({ word: "glorp", zh: "瞎造的词" });
    const r = translateText("glorp");
    expect(r.success).toBe(true);
    expect(r.source).toBe("glorp");
    expect(r.target.length).toBeGreaterThan(0);
  });
});

describe("enrichClient（模型兜底）", () => {
  it("只接受“像词”的输入，路径 / 过长 / 带 shell 元字符的一律不发请求", () => {
    expect(isEnrichableTerm("kubectlx")).toBe(true);
    expect(isEnrichableTerm("git-stash")).toBe(true);
    expect(isEnrichableTerm("/etc/passwd")).toBe(false);
    expect(isEnrichableTerm("rm -rf /")).toBe(false);
    expect(isEnrichableTerm("a".repeat(80))).toBe(false);
    expect(isEnrichableTerm("2026")).toBe(false);
  });

  it("解析模型回复：容忍围栏与前后废话，空 zh / 坏 JSON 视为失败", () => {
    expect(
      parseEnrichResponse('{"zh":"容器编排平台","example":"kubectl get po"}'),
    ).toEqual({
      zh: "容器编排平台",
      example: "kubectl get po",
    });
    expect(parseEnrichResponse('```json\n{"zh":"释义"}\n```')).toEqual({
      zh: "释义",
      example: undefined,
    });
    expect(parseEnrichResponse('{"zh":""}')).toBeNull();
    expect(parseEnrichResponse("抱歉我不知道")).toBeNull();
  });

  it("用户点击后才调模型，成功后写入本地词库并返回词条", async () => {
    generateText.mockResolvedValue({ text: '{"zh":"K8s 命令行工具"}' });
    const res = await enrichTerm("kubectlx");
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    expect(res.ok && res.entries[0].zh).toBe("K8s 命令行工具");
    // 下一次查词无需再联网
    expect(translateText("kubectlx").entries[0].zh).toBe("K8s 命令行工具");
  });

  it("请求里不带终端上下文（prompt 只有那个词，避免整段内容外发）", async () => {
    generateText.mockResolvedValue({ text: '{"zh":"释义"}' });
    await enrichTerm("glorp");
    const args = generateText.mock.calls[0][0] as {
      prompt: string;
      system: string;
      maxRetries: number;
    };
    expect(args.prompt).toBe("glorp");
    expect(args.system).toContain("不要编造");
    expect(args.system).not.toContain("glorp");
    // #82：真的把 0 传给了 SDK（只扫源码的门禁证明不了运行时值）
    expect(args.maxRetries).toBe(0);
  });

  it("失败原因分得开：没配 Key / 模型没把握 / 调用报错，各说各的话", async () => {
    getAllKeys.mockResolvedValue({ openai: null });
    expect(await enrichTerm("glorp")).toEqual({ ok: false, reason: "no-key" });
    expect(generateText).not.toHaveBeenCalled();

    getAllKeys.mockResolvedValue({ openai: "sk-test" });
    generateText.mockResolvedValue({ text: '{"zh":""}' });
    expect(await enrichTerm("glorp2")).toEqual({
      ok: false,
      reason: "no-answer",
    });

    generateText.mockRejectedValue(new Error("429"));
    expect(await enrichTerm("glorp3")).toEqual({ ok: false, reason: "error" });
    expect(listEnrichments()).toHaveLength(0);
  });

  it("不像词的输入直接拒掉，一次费用都不产生", async () => {
    const res = await enrichTerm("rm -rf /");
    expect(res).toEqual({ ok: false, reason: "not-a-term" });
    expect(generateText).not.toHaveBeenCalled();
    expect(enrichQuotaLeft()).toBe(ENRICH_SESSION_QUOTA);
  });

  it("会话额度用尽后不再产生任何费用", async () => {
    generateText.mockResolvedValue({ text: '{"zh":"释义"}' });
    for (let i = 0; i < ENRICH_SESSION_QUOTA; i++) {
      expect((await enrichTerm(`term${i}`)).ok).toBe(true);
    }
    expect(enrichQuotaLeft()).toBe(0);
    expect(await enrichTerm("one-more")).toEqual({
      ok: false,
      reason: "no-quota",
    });
    expect(generateText).toHaveBeenCalledTimes(ENRICH_SESSION_QUOTA);
  });
});

describe("红线：生成释义只进展示层", () => {
  it("除翻译模块与 App 外，没有任何代码引用兜底客户端", async () => {
    const files = import.meta.glob("/src/**/*.{ts,tsx}", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;

    const offenders = Object.entries(files)
      .filter(
        ([path, src]) =>
          !path.includes("/modules/translate/") &&
          !path.endsWith("App.tsx") &&
          !path.includes(".test.") &&
          src.includes("enrichClient"),
      )
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it("兜底客户端不依赖终端 / SSH / sidecar 执行链路", () => {
    const src = (import.meta.glob("./enrichClient.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    })["./enrichClient.ts"] ?? "") as string;
    // 只看 import 的模块说明符：注释里出现"终端/sidecar"字样是正常的
    const specifiers = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    const forbidden = [
      "@tauri-apps/api",
      "@/modules/terminal",
      "@/modules/ssh",
      "@/modules/ai/tools",
      "@/lib/suggest-engine",
    ];
    expect(
      specifiers.filter((s) => forbidden.some((f) => s.startsWith(f))),
    ).toEqual([]);
  });
});
