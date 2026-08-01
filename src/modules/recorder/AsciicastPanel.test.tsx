/**
 * AsciicastPanel.test.tsx — asciicast 录制回放面板测试（P2-2）
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   1. 空状态提示（无录制时）
 *   2. 待保存录制显示保存区（预填文件名）
 *   3. 保存调用 fs_write_file
 *   4. 录制列表渲染（fs_read_dir 过滤 .cast）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AsciicastPanel } from "./AsciicastPanel";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";

const CAST = JSON.stringify({
  version: 2,
  width: 80,
  height: 24,
  events: [[0.1, "o", "ls\n"]],
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("AsciicastPanel — 录制回放面板", () => {
  it("无录制时显示空态提示", () => {
    vi.mocked(invoke).mockResolvedValue([]);
    render(<AsciicastPanel open onOpenChange={() => {}} home="/home/u" pendingRecording={null} />);
    expect(screen.getByText(/暂无录制/)).toBeTruthy();
  });

  it("待保存录制显示保存区并预填文件名", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    render(
      <AsciicastPanel
        open
        onOpenChange={() => {}}
        home="/home/u"
        pendingRecording={{ name: "rec-1.cast", content: CAST }}
      />,
    );
    expect(screen.getByText(/新录制待保存/)).toBeTruthy();
    expect(screen.getByText("保存")).toBeTruthy();
  });

  it("保存调用 fs_write_file 到 recordings 目录", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    render(
      <AsciicastPanel
        open
        onOpenChange={() => {}}
        home="/home/u"
        pendingRecording={{ name: "rec-1.cast", content: CAST }}
      />,
    );
    fireEvent.click(screen.getByText("保存"));
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("fs_write_file", {
        path: "/home/u/.tdsf-data/recordings/rec-1.cast",
        content: CAST,
      });
    });
  });

  it("录制列表只显示 .cast 文件并渲染条目", async () => {
    vi.mocked(invoke).mockResolvedValue([
      { name: "demo.cast", path: "/home/u/.tdsf-data/recordings/demo.cast", size: 1234 },
      { name: "notes.txt", path: "/home/u/notes.txt", size: 99 },
    ]);
    render(<AsciicastPanel open onOpenChange={() => {}} home="/home/u" pendingRecording={null} />);
    expect(await screen.findByText("demo.cast")).toBeTruthy();
    expect(screen.queryByText("notes.txt")).toBeNull();
    expect(screen.getByText("回放")).toBeTruthy();
  });
});
