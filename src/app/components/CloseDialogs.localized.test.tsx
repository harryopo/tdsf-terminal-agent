import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloseDialogs } from "./CloseDialogs";

type Props = ComponentProps<typeof CloseDialogs>;

function props(overrides: Partial<Props> = {}): Props {
  return {
    tabs: [
      {
        id: 1,
        spaceId: "test",
        kind: "editor",
        title: ".viminfo",
        path: "/tmp/.viminfo",
        dirty: true,
        preview: false,
      },
    ],
    pendingCloseTab: null,
    pendingTerminalCloseTab: null,
    pendingDeleteTabs: null,
    pendingAppClose: null,
    onCancelClose: vi.fn(),
    onConfirmClose: vi.fn(),
    onCancelTerminalClose: vi.fn(),
    onConfirmTerminalClose: vi.fn(),
    onCancelDeleteClose: vi.fn(),
    onConfirmDeleteClose: vi.fn(),
    onCancelAppClose: vi.fn(),
    onConfirmAppClose: vi.fn(),
    ...overrides,
  };
}

afterEach(cleanup);

describe("Chinese close confirmations", () => {
  it.each<[Partial<Props>, string, string, keyof Props, keyof Props]>([
    [
      { pendingCloseTab: 1 },
      "有未保存的更改",
      "放弃更改并关闭",
      "onConfirmClose",
      "onCancelClose",
    ],
    [
      { pendingTerminalCloseTab: 1 },
      "关闭终端？",
      "仍然关闭",
      "onConfirmTerminalClose",
      "onCancelTerminalClose",
    ],
    [
      { pendingDeleteTabs: [1] },
      "有未保存的更改",
      "放弃更改并关闭",
      "onConfirmDeleteClose",
      "onCancelDeleteClose",
    ],
    [
      { pendingAppClose: { dirtyEditors: 1, busyTerminal: true } },
      "退出 TDSF？",
      "仍然退出",
      "onConfirmAppClose",
      "onCancelAppClose",
    ],
  ])(
    "localizes each dialog and preserves actions: %s",
    (pending, title, action, confirm, cancel) => {
      const p = props(pending);
      render(<CloseDialogs {...p} />);
      expect(screen.getByRole("heading", { name: title })).toBeTruthy();
      expect(p[confirm]).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      expect(p[cancel]).toHaveBeenCalled();
      expect(p[confirm]).not.toHaveBeenCalled();
      cleanup();
      render(<CloseDialogs {...p} />);
      fireEvent.click(screen.getByRole("button", { name: action }));
      expect(p[confirm]).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [{ dirtyEditors: 1, busyTerminal: false }, "1 个文件有未保存的更改"],
    [{ dirtyEditors: 2, busyTerminal: true }, "2 个文件有未保存的更改"],
    [{ dirtyEditors: 0, busyTerminal: true }, "终端中仍有进程运行"],
  ])("explains the actual app close blocker: %s", (blocker, text) => {
    render(<CloseDialogs {...props({ pendingAppClose: blocker })} />);
    expect(screen.getByRole("alertdialog").textContent).toContain(text);
    expect(screen.getByRole("alertdialog").textContent).not.toMatch(
      /Unsaved|Cancel|Quit Anyway/,
    );
  });

  it("retains the filename and deleted file count", () => {
    render(<CloseDialogs {...props({ pendingDeleteTabs: [1] })} />);
    expect(screen.getByRole("alertdialog").textContent).toContain(".viminfo");
    expect(screen.getByRole("alertdialog").textContent).toContain(
      "文件已被删除",
    );
    cleanup();
    render(<CloseDialogs {...props({ pendingDeleteTabs: [1, 2] })} />);
    expect(screen.getByRole("alertdialog").textContent).toContain("2 个文件");
  });
});
