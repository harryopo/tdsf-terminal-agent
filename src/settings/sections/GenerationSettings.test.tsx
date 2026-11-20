import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODEL_GENERATION,
  type ModelGenerationPreferences,
} from "@/modules/ai/lib/modelGeneration";

const state: {
  value: {
    modelGeneration: ModelGenerationPreferences;
    showReasoning: boolean;
  };
} = vi.hoisted(() => ({
  value: {
    modelGeneration: {
      temperature: 0.2,
      maxTokens: null,
      thinking: "provider_default",
      reasoningEffort: "provider_default",
    },
    showReasoning: true,
  },
}));
const setGenerationMock = vi.hoisted(() => vi.fn());
const setShowReasoningMock = vi.hoisted(() => vi.fn());
const syncMock = vi.hoisted(() => vi.fn());

vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: (selector: (value: typeof state.value) => unknown) => selector(state.value),
}));
vi.mock("@/modules/settings/store", () => ({
  setModelGeneration: setGenerationMock,
  setShowReasoning: setShowReasoningMock,
}));
vi.mock("@/modules/ai/lib/sidecar-config-sync", async (importOriginal) => ({
  ...await importOriginal(),
  runSidecarConfigSyncNow: syncMock,
}));

import { GenerationSettings } from "./GenerationSettings";

beforeEach(() => {
  setGenerationMock.mockReset().mockResolvedValue(undefined);
  setShowReasoningMock.mockReset().mockResolvedValue(undefined);
  syncMock.mockReset();
  state.value = {
    modelGeneration: { ...DEFAULT_MODEL_GENERATION, temperature: 0.2 },
    showReasoning: true,
  };
});

describe("GenerationSettings", () => {
  it("showReasoning only changes display preference and never syncs the model", () => {
    render(<GenerationSettings />);
    fireEvent.click(screen.getByRole("switch", { name: "显示思考内容" }));
    expect(setShowReasoningMock).toHaveBeenCalledWith(false);
    expect(syncMock).not.toHaveBeenCalled();
    expect(setGenerationMock).not.toHaveBeenCalled();
  });

  it("rejects invalid input before persistence or RPC", async () => {
    render(<GenerationSettings />);
    fireEvent.change(screen.getByLabelText("温度"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "保存生成参数" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("temperature");
    expect(setGenerationMock).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("rolls back the previous preference when sidecar synchronization fails", async () => {
    syncMock
      .mockResolvedValueOnce({ ok: false, detail: "construct failed" })
      .mockResolvedValueOnce({ ok: true });
    render(<GenerationSettings />);
    fireEvent.change(screen.getByLabelText("温度"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "保存生成参数" }));

    await waitFor(() => expect(setGenerationMock).toHaveBeenCalledTimes(2));
    expect(setGenerationMock).toHaveBeenNthCalledWith(1, {
      ...DEFAULT_MODEL_GENERATION,
      temperature: 0,
    });
    expect(setGenerationMock).toHaveBeenNthCalledWith(2, {
      ...DEFAULT_MODEL_GENERATION,
      temperature: 0.2,
    });
    expect(screen.getByRole("alert")).toHaveTextContent("construct failed");
  });

  it("renders the actual requested/effective receipt after success", async () => {
    syncMock.mockResolvedValue({
      ok: true,
      receipt: {
        turn_snapshot: { configGeneration: 3, configSnapshotId: "snapshot-3" },
        warnings: [],
      },
    });
    render(<GenerationSettings />);
    fireEvent.click(screen.getByRole("button", { name: "保存生成参数" }));

    expect(await screen.findByText(/配置代次 3/)).toHaveTextContent("snapshot-3");
    expect(setGenerationMock).toHaveBeenCalledTimes(1);
  });
});