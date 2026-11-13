import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { CwdBreadcrumb } from "./CwdBreadcrumb";

const cwd = "/根目录/父目录/目录甲/目录乙/当前目录";

function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

function expectExpandedHitTarget(button: HTMLElement) {
  const classes = button.className.split(/\s+/);
  expect(classes).toContain("min-h-6");
  expect(classes).toContain("min-w-6");
  expect(button.closest('[data-slot="breadcrumb-list"]')?.classList.contains("py-0.5")).toBe(true);

  const positionedPseudo = classes.find((name) => /^(before|after):absolute$/.test(name));
  expect(classes).toContain("relative");
  expect(positionedPseudo).toBeDefined();
  const pseudo = positionedPseudo?.split(":")[0];
  expect(
    classes.some(
      (name) =>
        name.startsWith(`${pseudo}:-inset-`) ||
        name.startsWith(`${pseudo}:inset-`),
    ),
  ).toBe(true);
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(["子目录"]);
});

afterEach(() => cleanup());

describe("CwdBreadcrumb accessible navigation", () => {
  it("exposes the current path as a current, enabled native button", () => {
    render(<CwdBreadcrumb cwd={cwd} home={null} onCd={vi.fn()} />);

    const current = screen.getByRole("button", { name: `浏览子目录：${cwd}` });
    expect(current.tagName).toBe("BUTTON");
    expect(current.getAttribute("aria-disabled")).not.toBe("true");
    expect(current.getAttribute("aria-current")).toBe("page");
  });

  it("names the root path and hidden-directory entry in Chinese", () => {
    render(<CwdBreadcrumb cwd={cwd} home={null} onCd={vi.fn()} />);

    expect(screen.getByRole("button", { name: "根目录 /" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "显示隐藏目录" })).toBeTruthy();
  });

  it("keeps the current, root, and hidden-directory controls at minimum target size with positioned expansion", () => {
    render(<CwdBreadcrumb cwd={cwd} home={null} onCd={vi.fn()} />);

    expectExpandedHitTarget(screen.getByRole("button", { name: `浏览子目录：${cwd}` }));
    expectExpandedHitTarget(screen.getByRole("button", { name: "根目录 /" }));
    expectExpandedHitTarget(screen.getByRole("button", { name: "显示隐藏目录" }));
  });

  it("navigates to the root and loads and selects a child from the real current-directory menu", async () => {
    const onCd = vi.fn();
    render(<CwdBreadcrumb cwd={cwd} home={null} onCd={onCd} />);

    fireEvent.click(screen.getByRole("button", { name: "根目录 /" }));
    expect(onCd).toHaveBeenCalledWith("/");

    openMenu(screen.getByRole("button", { name: `浏览子目录：${cwd}` }));
    const child = await screen.findByRole("menuitem", { name: "子目录" });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("list_subdirs", expect.objectContaining({ path: cwd })),
    );
    fireEvent.click(child);

    expect(onCd).toHaveBeenLastCalledWith(`${cwd}/子目录`);
  });

  it("opens the hidden-directory menu and navigates to its selected parent", async () => {
    const onCd = vi.fn();
    render(<CwdBreadcrumb cwd={cwd} home={null} onCd={onCd} />);

    openMenu(screen.getByRole("button", { name: "显示隐藏目录" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "目录甲" }));

    expect(onCd).toHaveBeenCalledWith("/根目录/父目录/目录甲");
  });
});
