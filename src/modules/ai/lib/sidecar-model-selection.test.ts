import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args: unknown) => ({ ok: true })),
  getKey: vi.fn(async () => "synthetic-test-key"),
  getCustomEndpointKey: vi.fn(async () => "synthetic-test-key"),
  pushRecentModel: vi.fn(async (_id: string) => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../lib/keyring", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/keyring")>();
  return {
    ...actual,
    getKey: mocks.getKey,
    getCustomEndpointKey: mocks.getCustomEndpointKey,
  };
});
vi.mock("../lib/modelPrefs", () => ({ pushRecentModel: mocks.pushRecentModel }));

import { useChatStore } from "../store/chatStore";
import {
  isSidecarConfigSynced,
  resetSidecarConfigSyncFlag,
  runSidecarConfigSyncNow,
} from "./sidecar-config-sync";

async function syncSelectedModel(): Promise<void> {
  const result = await runSidecarConfigSyncNow();
  expect(result.ok).toBe(true);
  mocks.invoke.mockClear();
}

function configuredModels(): string[] {
  return mocks.invoke.mock.calls.map(([, args]) => {
    const payload = args as {
      params: { config: { model: string } };
    };
    return payload.params.config.model;
  });
}

describe("chat model selection sidecar synchronization", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetSidecarConfigSyncFlag();
    useChatStore.setState({ selectedModelId: "deepseek-v4-flash" });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    resetSidecarConfigSyncFlag();
    useChatStore.setState({ selectedModelId: "deepseek-v4-flash" });
  });

  it("debounces a changed selection and configures only after 500ms", async () => {
    await syncSelectedModel();
    expect(isSidecarConfigSynced()).toBe(true);

    useChatStore.getState().setSelectedModelId("claude-sonnet-5");
    expect(isSidecarConfigSynced()).toBe(false);

    await vi.advanceTimersByTimeAsync(499);
    expect(mocks.invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(configuredModels()).toEqual(["claude-sonnet-5"]);
  });

  it("an immediate sync consumes the pending selection timer", async () => {
    await syncSelectedModel();

    useChatStore.getState().setSelectedModelId("claude-sonnet-5");
    expect(isSidecarConfigSynced()).toBe(false);
    const result = await runSidecarConfigSyncNow();
    expect(result.ok).toBe(true);

    await vi.advanceTimersByTimeAsync(500);

    expect(configuredModels()).toEqual(["claude-sonnet-5"]);
    expect(isSidecarConfigSynced()).toBe(true);
  });

  it("rapid selections configure only the last selected model", async () => {
    await syncSelectedModel();

    const select = useChatStore.getState().setSelectedModelId;
    select("claude-sonnet-5");
    select("deepseek-v4-flash");
    select("claude-sonnet-5");
    await vi.advanceTimersByTimeAsync(500);

    expect(configuredModels()).toEqual(["claude-sonnet-5"]);
  });

  it("selecting the current model does not schedule another sync", async () => {
    await syncSelectedModel();
    expect(isSidecarConfigSynced()).toBe(true);

    useChatStore.getState().setSelectedModelId("deepseek-v4-flash");
    await vi.advanceTimersByTimeAsync(500);

    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(isSidecarConfigSynced()).toBe(true);
  });
});
