/**
 * completionInjection.throttle.test.ts — 参数预测的请求节流（#152，2026-09-27）
 * ----------------------------------------------------------------------------─
 * 修前的实测事实：一次 271 字符的输入打出 124 次 carapace 起停，每条都撞在 Rust 侧
 * 500ms 强杀线上 ⇒ **本地参数预测从来没有出过候选**。单独量过：一条
 * `carapace git export` 只要 ~190ms，而 20 条并发时每条涨到 474–599ms
 * —— 风暴本身就是超时的原因，所以修法不是把 500ms 调大。
 *
 * 判据按"人速打字"造现场（每键之间留 40ms 真实间隔）—— **同步 for 循环连打是无效的现场**：
 * 那种写法连 `setTimeout(0)` 都会合并成一条，摘掉节流窗口判据照样绿（第一版就踩了这个）。
 *
 * 三层节流各配判据 + 两条正向配对（只管并发不管送达 = 把功能改成永不显示）：
 *   ① 连打合并（debounce）；② 同一时刻只允许一条在飞，回来后按最新输入补打；
 *   ③ 改写/清空缓冲区的键（Enter / 接受预测）撤掉待跑的那次。
 *
 * Mock 策略：vi.mock('@tauri-apps/api/core')（与 param-complete-client.test.ts 同一套）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  completionKeyHandler,
  getCompletionState,
  initCompletionInjection,
  PREDICT_DEBOUNCE_MS,
  selectCompletionByIndex,
  setLeafEnvironment,
} from "./completionInjection";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve()) }));

type Candidate = { value: string; description?: string; tag?: string };

/** param_complete 的回复内容（按测试设定） */
let paramReply: Candidate[] = [];
/** gateMode=true 时请求挂在闸门上，由测试手动放行（用来验"不并发"） */
let gateMode = false;
let gates: Array<() => void> = [];

function paramCalls(): Array<Record<string, unknown>> {
  return vi
    .mocked(invoke)
    .mock.calls.filter(([m]) => m === "param_complete")
    .map(([, args]) => args as Record<string, unknown>);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 等过节流窗口，再留出让在飞 promise 落地并补打一次的时间 */
async function settle(): Promise<void> {
  await sleep(PREDICT_DEBOUNCE_MS + 60);
  await sleep(0);
}

function key(k: string, over: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    type: "keydown",
    key: k,
    keyCode: k.length === 1 ? k.charCodeAt(0) : 0,
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault: () => {},
    ...over,
  } as unknown as KeyboardEvent;
}

/** 同步连打（同一宏任务内）——只用来构造"缓冲区已成形"的前置状态 */
function type(text: string, leafId = 1): void {
  for (const ch of text) completionKeyHandler(leafId, key(ch));
}

/** 人速打字：每键之间留 gapMs（小于节流窗口 ⇒ 应当合并成一条请求） */
async function typeHuman(text: string, gapMs = 40, leafId = 1): Promise<void> {
  for (const ch of text) {
    completionKeyHandler(leafId, key(ch));
    await sleep(gapMs);
  }
}

beforeEach(async () => {
  // 用例间的隔离：上一条挂闸门未放行的请求会把在飞闸一直占住，下一条的更新只会
  // 排队 ⇒ 先放行遗留闸门，再用 Enter 把输入缓冲清回空行（缓冲活在模块作用域里，
  // 不清就会跨用例累加，测出来的 current 不是本条用例打的那几个字）。
  for (const open of gates) open();
  paramReply = [];
  gateMode = false;
  gates = [];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(((method: string) => {
    if (method !== "param_complete") return Promise.resolve([]);
    if (gateMode) {
      return new Promise<Candidate[]>((resolve) => {
        gates.push(() => resolve(paramReply));
      });
    }
    return Promise.resolve(paramReply);
  }) as typeof invoke);
  initCompletionInjection(() => null, () => {});
  setLeafEnvironment(1, "windows");
  completionKeyHandler(1, key("Enter"));
  await settle();
  // 清掉上面收尾过程可能留下的调用记录，本条用例从零计数
  vi.mocked(invoke).mockClear();
});

describe("#152 参数预测节流", () => {
  it("人速连打一串字符只发一条 param_complete（修前是每键一条）", async () => {
    await typeHuman("git checkout");
    await settle();
    expect(paramCalls()).toHaveLength(1);
    expect(paramCalls()[0].cmd).toBe("git");
  });

  it("正向配对：节流之后候选仍然要弹出来（不许把功能改成永不显示）", async () => {
    paramReply = [{ value: "checkout", description: "切换分支", tag: "subcommand" }];
    await typeHuman("git che");
    await settle();
    const state = getCompletionState();
    expect(state.visible).toBe(true);
    expect(state.items.some((i) => i.command === "checkout")).toBe(true);
  });

  it("一条在飞时不再起第二条，回来后按最新输入补打", async () => {
    gateMode = true;
    await typeHuman("git che");
    await settle();
    expect(paramCalls()).toHaveLength(1); // 第一条在飞（闸门未放行）

    await typeHuman("ckout");
    await settle();
    expect(paramCalls()).toHaveLength(1); // 关键：没有并发第二条

    gates[0](); // 放行第一条
    await settle();
    expect(paramCalls()).toHaveLength(2);
    expect(paramCalls()[1].current).toBe("checkout"); // 补打用的是最新输入
  });

  it("接受预测之后不再为这半行去问参数（缓冲区已被改写，旧的那次必须撤掉）", async () => {
    paramReply = [{ value: "--force", description: "强制", tag: "flag" }];
    await typeHuman("git che");
    await settle();
    expect(getCompletionState().visible).toBe(true);
    const before = paramCalls().length;

    type("ckout"); // 排上一次待跑更新
    selectCompletionByIndex(0); // 接受 --force：当前 token 被整段改写
    await settle();

    expect(paramCalls().length).toBe(before); // 没有拿改写中的半行再去请求
    expect(getCompletionState().visible).toBe(false);
  });

  it("Enter 之后不再发请求", async () => {
    await typeHuman("git che");
    completionKeyHandler(1, key("Enter"));
    await settle();
    expect(paramCalls()).toHaveLength(0);
  });

  it("纯空格没有参数段时不发请求", async () => {
    await typeHuman("   ");
    await settle();
    expect(paramCalls()).toHaveLength(0);
  });
});
