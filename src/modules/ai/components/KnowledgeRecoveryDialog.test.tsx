import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeRecoveryDialog } from "./KnowledgeRecoveryDialog";

vi.mock("@/lib/sidecar-bridge", () => ({ invokeRpc: vi.fn() }));
import { invokeRpc } from "@/lib/sidecar-bridge";

const preview = {
  token: "local-preview-id",
  documents: [
    { url: "old.md", title: "已有中文整理", chunks: 2, status: "new", has_chinese: true, source_note: "旧整理资料，章节来源待核" },
    { url: "conflict.md", title: "不同版本", chunks: 1, status: "conflict", has_chinese: true, source_note: "旧整理资料，章节来源待核" },
    { url: "builtin.md", title: "内置教学资料", chunks: 1, status: "builtin", has_chinese: true, source_note: "旧整理资料，章节来源待核" },
  ],
  counts: { new: 1, duplicate: 0, conflict: 1, builtin: 1 },
};
const restored = { imported: 1, duplicate: 0, conflicts: 0, entries: 2, backup_path: "C:/local-backups/personal.db", source_backup_path: "C:/local-backups/source.db" };

function rpc(handler: (method: string, params: Record<string, unknown>) => unknown) {
  vi.mocked(invokeRpc).mockImplementation((async (method, params) => {
    if (Array.isArray(params)) throw new Error("Unexpected positional RPC parameters");
    return handler(method, params ?? {});
  }) as typeof invokeRpc);
}
function choosePath(path = "C:/local-backups/old.db") {
  fireEvent.change(screen.getByRole("textbox", { name: "旧知识库文件路径" }), { target: { value: path } });
}

beforeEach(() => { vi.mocked(invokeRpc).mockReset(); });

describe("knowledge restore preview UI", () => {
  it.each(["preview", "apply"])("keeps %s errors Chinese and redacts folded diagnostic details", async (stage) => {
    const sensitive = ["local", "only", "value"].join("-");
    rpc((method) => {
      if (method === (stage === "preview" ? "knowledge.recovery_preview" : "knowledge.recovery_apply")) throw new Error(`api_key=${sensitive} password=${sensitive}`);
      return preview;
    });
    render(<KnowledgeRecoveryDialog onClose={vi.fn()} onRecovered={vi.fn()} />);
    choosePath();
    fireEvent.click(screen.getByRole("button", { name: "预览内容" }));
    if (stage === "apply") fireEvent.click(await screen.findByRole("button", { name: "恢复选中的 1 篇" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(stage === "preview" ? "预览失败" : "恢复失败");
    expect(document.body.textContent).not.toContain(sensitive);
    const details = screen.getByText("技术详情（已脱敏）").closest("details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("REDACTED");
  });

  it("never applies before preview and only enables new document selections", async () => {
    rpc((method) => method === "knowledge.recovery_preview" ? preview : { ok: true });
    render(<KnowledgeRecoveryDialog onClose={vi.fn()} onRecovered={vi.fn()} />);
    expect((screen.getByRole("button", { name: "恢复选中的 0 篇" }) as HTMLButtonElement).disabled).toBe(true);
    choosePath();
    fireEvent.click(screen.getByRole("button", { name: "预览内容" }));
    expect(await screen.findByText("已有中文整理")).toBeTruthy();
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes[0].checked).toBe(true);
    expect(checkboxes[1].disabled).toBe(true);
    expect(checkboxes[2].disabled).toBe(true);
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.recovery_preview", { source_path: "C:/local-backups/old.db" });
    expect(vi.mocked(invokeRpc).mock.calls.some(([method]) => method === "knowledge.recovery_apply")).toBe(false);
  });

  it("applies only selected preview identities and shows retained backups", async () => {
    rpc((method) => method === "knowledge.recovery_preview" ? preview : method === "knowledge.recovery_apply" ? restored : { ok: true });
    const onRecovered = vi.fn();
    const onClose = vi.fn();
    render(<KnowledgeRecoveryDialog onClose={onClose} onRecovered={onRecovered} />);
    choosePath();
    fireEvent.click(screen.getByRole("button", { name: "预览内容" }));
    fireEvent.click(await screen.findByRole("button", { name: "恢复选中的 1 篇" }));
    expect(await screen.findByText("已恢复 1 篇文档")).toBeTruthy();
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.recovery_apply", { token: preview.token, urls: ["old.md"] });
    expect(screen.getByText(/C:\/local-backups\/personal.db/)).toBeTruthy();
    expect(screen.getByText(/C:\/local-backups\/source.db/)).toBeTruthy();
    expect(onRecovered).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /恢复选中的/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("invalidates a preview when its source path changes", async () => {
    rpc((method) => method === "knowledge.recovery_preview" ? preview : { ok: true });
    render(<KnowledgeRecoveryDialog onClose={vi.fn()} onRecovered={vi.fn()} />);
    choosePath();
    fireEvent.click(screen.getByRole("button", { name: "预览内容" }));
    await screen.findByText("已有中文整理");
    choosePath("C:/local-backups/another.db");
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.recovery_discard", { token: preview.token });
    expect(screen.queryByText("已有中文整理")).toBeNull();
    expect((screen.getByRole("button", { name: "恢复选中的 0 篇" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("discards a late preview after the dialog was unmounted", async () => {
    let resolve!: (value: typeof preview) => void;
    const pending = new Promise<typeof preview>((done) => { resolve = done; });
    rpc((method) => method === "knowledge.recovery_preview" ? pending : { ok: true });
    const onRecovered = vi.fn();
    const { unmount } = render(<KnowledgeRecoveryDialog onClose={vi.fn()} onRecovered={onRecovered} />);
    choosePath();
    fireEvent.click(screen.getByRole("button", { name: "预览内容" }));
    unmount();
    await act(async () => { resolve(preview); await pending; });
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.recovery_discard", { token: preview.token });
    expect(onRecovered).not.toHaveBeenCalled();
  });

  it("shows a failed apply in Chinese and requires a new preview", async () => {
    rpc((method) => {
      if (method === "knowledge.recovery_preview") return preview;
      if (method === "knowledge.recovery_apply") throw new Error("预览已过期");
      return { ok: true };
    });
    const onRecovered = vi.fn();
    render(<KnowledgeRecoveryDialog onClose={vi.fn()} onRecovered={onRecovered} />);
    choosePath();
    fireEvent.click(screen.getByRole("button", { name: "预览内容" }));
    fireEvent.click(await screen.findByRole("button", { name: "恢复选中的 1 篇" }));
    expect((await screen.findByRole("alert")).textContent).toContain("请重新预览");
    expect(screen.queryByText("已有中文整理")).toBeNull();
    expect(onRecovered).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: /恢复选中的/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
