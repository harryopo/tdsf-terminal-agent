// TDSF 魔改 (P4-T4.3): teach-trigger 单测
// =============================================================================
//
// 测试覆盖：
//   1. 降频逻辑（默认 1/3 触发）：前 2 次不触发，第 3 次触发
//   2. disabled 状态：teachAgentEnabled=false 时永不触发
//   3. 计数器重置：resetTeachCounter 后从 0 重新计数
//   4. 空命令跳过：空白命令不计数、不触发
//   5. threshold=1：每条命令都触发
//   6. threshold=2：第 2/4/6 次触发
//   7. sidecar 错误静默吞掉：不弹 toast
//   8. recordSubmittedCommand / getLastSubmittedCommand 读写
//
// Mock 策略：
//   - runSidecarStream: async generator yielding text-delta + finish
//   - usePreferencesStore: 对象 with getState() 返回可配置的偏好
//   - toast: vi.fn() 记录调用
//   - invoke: vi.fn() 返回 Promise.resolve（MD 写入不实际执行）
//   - homeDir/join: 返回固定字符串路径
//
// 注意：vi.mock 工厂会被 hoist 到文件顶部执行，因此工厂中引用的所有
// 变量必须通过 vi.hoisted() 声明，否则会触发 TDZ（ReferenceError:
// Cannot access 'xxx' before initialization）。

import { beforeEach, describe, expect, it, vi } from "vitest";

// === Mock 配置（vi.hoisted 保证 vi.mock 工厂中引用的变量已初始化）============
const mocks = vi.hoisted(() => ({
  /** 可变的偏好状态（每个 case 通过 setPrefs 修改） */
  prefsBox: {
    current: { teachAgentEnabled: true, teachThreshold: 3 } as {
      teachAgentEnabled: boolean;
      teachThreshold: number;
    },
  },
  /** runSidecarStream 的 mock 行为切换：默认 yield 一段讲解文本 */
  yieldBox: {
    current: "text" as "text" | "error" | "empty",
  },
  /** 记录 runSidecarStream 调用参数 */
  sidecarCalls: [] as { agentId: string; input: string }[],
  /** toast.info 的 mock */
  toastInfo: vi.fn(),
}));

vi.mock("@/modules/ai/lib/sidecar-adapter", () => ({
  runSidecarStream: vi.fn(async function* (opts: {
    agentId: string;
    input: string;
  }) {
    mocks.sidecarCalls.push({ agentId: opts.agentId, input: opts.input });
    if (mocks.yieldBox.current === "error") {
      yield { type: "error" as const, error: "sidecar unavailable" };
      return;
    }
    if (mocks.yieldBox.current === "empty") {
      yield { type: "finish" as const, id: "test" };
      return;
    }
    yield { type: "text-delta" as const, id: "out", delta: "讲解内容" };
    yield { type: "finish" as const, id: "test" };
  }),
}));

vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => mocks.prefsBox.current,
  },
}));

vi.mock("sonner", () => ({
  toast: {
    info: mocks.toastInfo,
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    // fs_read_file 返回 text 类型空内容 / fs_write_file 返回 mtime
    return { kind: "text", content: "", size: 0, mtime: 0 };
  }),
}));

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: async () => "/home/testuser",
  join: async (...parts: string[]) => parts.join("/"),
}));

// === 导入待测模块（mock 生效后）==============================================

import {
  _getCommandCountForTest,
  _setCommandCountForTest,
  appendToTeachHistory,
  clearTeachHistory,
  getLastSubmittedCommand,
  notifyCommandExecuted,
  recordSubmittedCommand,
  resetTeachCounter,
} from "./teach-trigger";

// === 测试工具 ===============================================================

function setPrefs(enabled: boolean, threshold: number): void {
  mocks.prefsBox.current = {
    teachAgentEnabled: enabled,
    teachThreshold: threshold,
  };
}

beforeEach(() => {
  // 每个用例前重置所有状态
  setPrefs(true, 3);
  mocks.yieldBox.current = "text";
  mocks.sidecarCalls.length = 0;
  mocks.toastInfo.mockClear();
  resetTeachCounter();
  recordSubmittedCommand("");
});

// === 测试用例 ===============================================================

describe("teach-trigger 降频逻辑", () => {
  it("默认 threshold=3：前 2 次不触发，第 3 次触发", async () => {
    setPrefs(true, 3);

    await notifyCommandExecuted("ls", "/home");
    expect(mocks.sidecarCalls).toHaveLength(0);
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(_getCommandCountForTest()).toBe(1);

    await notifyCommandExecuted("pwd", "/home");
    expect(mocks.sidecarCalls).toHaveLength(0);
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(_getCommandCountForTest()).toBe(2);

    await notifyCommandExecuted("whoami", "/home");
    expect(mocks.sidecarCalls).toHaveLength(1);
    // v3.1: teach 子 agent 已删除（方案书 §4.1），讲解请求走唯一入口 main
    expect(mocks.sidecarCalls[0]).toEqual({
      agentId: "main",
      input: "explain: whoami",
    });
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1);
    expect(_getCommandCountForTest()).toBe(3);
  });

  it("threshold=1：每条命令都触发", async () => {
    setPrefs(true, 1);

    await notifyCommandExecuted("ls", "/home");
    expect(mocks.sidecarCalls).toHaveLength(1);
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1);

    await notifyCommandExecuted("pwd", "/home");
    expect(mocks.sidecarCalls).toHaveLength(2);
    expect(mocks.toastInfo).toHaveBeenCalledTimes(2);
  });

  it("threshold=2：第 2/4 次触发", async () => {
    setPrefs(true, 2);

    await notifyCommandExecuted("ls", "/home");
    expect(mocks.sidecarCalls).toHaveLength(0);

    await notifyCommandExecuted("pwd", "/home");
    expect(mocks.sidecarCalls).toHaveLength(1);

    await notifyCommandExecuted("date", "/home");
    expect(mocks.sidecarCalls).toHaveLength(1);

    await notifyCommandExecuted("uptime", "/home");
    expect(mocks.sidecarCalls).toHaveLength(2);
  });

  it("threshold=5：第 5 次触发", async () => {
    setPrefs(true, 5);

    for (let i = 1; i <= 4; i++) {
      await notifyCommandExecuted(`cmd${i}`, "/home");
    }
    expect(mocks.sidecarCalls).toHaveLength(0);

    await notifyCommandExecuted("cmd5", "/home");
    expect(mocks.sidecarCalls).toHaveLength(1);
  });

  it("连续 6 条命令（threshold=3）：第 3、6 次触发", async () => {
    setPrefs(true, 3);

    for (let i = 1; i <= 6; i++) {
      await notifyCommandExecuted(`cmd${i}`, "/home");
    }
    expect(mocks.sidecarCalls).toHaveLength(2);
    expect(mocks.sidecarCalls[0].input).toBe("explain: cmd3");
    expect(mocks.sidecarCalls[1].input).toBe("explain: cmd6");
  });
});

describe("teach-trigger disabled 状态", () => {
  it("teachAgentEnabled=false：永不触发、不计数", async () => {
    setPrefs(false, 3);

    for (let i = 0; i < 10; i++) {
      await notifyCommandExecuted(`cmd${i}`, "/home");
    }
    expect(mocks.sidecarCalls).toHaveLength(0);
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    // disabled 时不计数（isTeachEnabled 检查在计数前返回）
    expect(_getCommandCountForTest()).toBe(0);
  });

  it("运行时切换 enabled→disabled 后停止触发", async () => {
    setPrefs(true, 3);
    await notifyCommandExecuted("ls", "/home"); // count=1
    await notifyCommandExecuted("pwd", "/home"); // count=2

    setPrefs(false, 3);
    await notifyCommandExecuted("whoami", "/home"); // disabled，不计数
    expect(mocks.sidecarCalls).toHaveLength(0);
    expect(_getCommandCountForTest()).toBe(2);

    // 重新启用后从 2 继续计数，下一条触发
    setPrefs(true, 3);
    await notifyCommandExecuted("date", "/home"); // count=3 → 触发
    expect(mocks.sidecarCalls).toHaveLength(1);
  });
});

describe("teach-trigger 计数器重置", () => {
  it("resetTeachCounter 后从 0 重新计数", async () => {
    setPrefs(true, 3);
    await notifyCommandExecuted("ls", "/home"); // count=1
    await notifyCommandExecuted("pwd", "/home"); // count=2

    resetTeachCounter();
    expect(_getCommandCountForTest()).toBe(0);

    // 重置后需要再 3 条才触发
    await notifyCommandExecuted("a", "/home"); // 1
    await notifyCommandExecuted("b", "/home"); // 2
    await notifyCommandExecuted("c", "/home"); // 3 → 触发
    expect(mocks.sidecarCalls).toHaveLength(1);
    expect(mocks.sidecarCalls[0].input).toBe("explain: c");
  });

  it("clearTeachHistory 重置计数器", async () => {
    setPrefs(true, 3);
    await notifyCommandExecuted("ls", "/home");
    await notifyCommandExecuted("pwd", "/home");
    expect(_getCommandCountForTest()).toBe(2);

    await clearTeachHistory();
    expect(_getCommandCountForTest()).toBe(0);
  });
});

describe("teach-trigger 空命令跳过", () => {
  it("空字符串不计数、不触发", async () => {
    setPrefs(true, 3);
    await notifyCommandExecuted("", "/home");
    expect(mocks.sidecarCalls).toHaveLength(0);
    expect(_getCommandCountForTest()).toBe(0);
  });

  it("纯空白不计数、不触发", async () => {
    setPrefs(true, 3);
    await notifyCommandExecuted("   \t\n  ", "/home");
    expect(mocks.sidecarCalls).toHaveLength(0);
    expect(_getCommandCountForTest()).toBe(0);
  });

  it("命令首尾空白会被 trim 后传入 sidecar", async () => {
    setPrefs(true, 1);
    await notifyCommandExecuted("  ls -la  ", "/home");
    expect(mocks.sidecarCalls[0].input).toBe("explain: ls -la");
  });
});

describe("teach-trigger sidecar 错误静默吞掉", () => {
  it("sidecar yield error 时不弹 toast", async () => {
    setPrefs(true, 1);
    mocks.yieldBox.current = "error";

    await notifyCommandExecuted("ls", "/home");
    expect(mocks.sidecarCalls).toHaveLength(1);
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });

  it("sidecar yield 空讲解时不弹 toast", async () => {
    setPrefs(true, 1);
    mocks.yieldBox.current = "empty";

    await notifyCommandExecuted("ls", "/home");
    expect(mocks.sidecarCalls).toHaveLength(1);
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });

  it("toast.info 收到讲解内容 + description", async () => {
    setPrefs(true, 1);
    mocks.yieldBox.current = "text";

    await notifyCommandExecuted("ls", "/home");
    expect(mocks.toastInfo).toHaveBeenCalledTimes(1);
    const [msg, opts] = mocks.toastInfo.mock.calls[0];
    expect(msg).toBe("讲解内容");
    expect(opts).toHaveProperty("description", "cmd: ls");
    expect(opts).toHaveProperty("duration", 5000);
  });
});

describe("recordSubmittedCommand / getLastSubmittedCommand", () => {
  it("读写最近一次提交的命令文本", () => {
    expect(getLastSubmittedCommand()).toBe("");
    recordSubmittedCommand("git status");
    expect(getLastSubmittedCommand()).toBe("git status");
    recordSubmittedCommand("ls -la /etc");
    expect(getLastSubmittedCommand()).toBe("ls -la /etc");
  });
});

describe("appendToTeachHistory", () => {
  it("调用 fs_write_file 写入 MD（不抛错）", async () => {
    // invoke 已 mock 为返回 {kind:"text",content:"",size:0,mtime:0}
    // appendToTeachHistory 内部会先 read（返回空）再 write
    await expect(
      appendToTeachHistory("ls", "/home", "讲解"),
    ).resolves.toBeUndefined();
  });

  it("写入失败时静默吞掉（不抛错）", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("disk full"),
    );
    await expect(
      appendToTeachHistory("ls", "/home", "讲解"),
    ).resolves.toBeUndefined();
  });
});

describe("_setCommandCountForTest / _getCommandCountForTest", () => {
  it("直接设置/读取计数器值", () => {
    _setCommandCountForTest(5);
    expect(_getCommandCountForTest()).toBe(5);
    _setCommandCountForTest(0);
    expect(_getCommandCountForTest()).toBe(0);
  });
});
