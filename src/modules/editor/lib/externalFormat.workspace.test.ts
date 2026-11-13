import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { readFileText, runExternalFormatter } from "./externalFormat";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const workspaceA = { kind: "wsl", distro: "A" } as const;
const workspaceB = { kind: "wsl", distro: "B" } as const;
const originalWorkspace = useWorkspaceEnvStore.getState();

beforeEach(() => {
  vi.resetAllMocks();
  useWorkspaceEnvStore.setState({ env: workspaceA });
});
afterEach(() => useWorkspaceEnvStore.setState(originalWorkspace, true));

describe("external formatter workspace ownership", () => {
  it("uses the supplied workspace for formatter execution and readback", async () => {
    invokeMock.mockResolvedValueOnce({ stdout: "", stderr: "", exit_code: 0, timed_out: false });
    invokeMock.mockResolvedValueOnce({ kind: "text", content: "formatted", mtime: 7 });
    useWorkspaceEnvStore.setState({ env: workspaceB });
    await expect(runExternalFormatter("prettier", "/repo/file.ts", "", workspaceA)).resolves.toBeNull();
    await expect(readFileText("/repo/file.ts", workspaceA)).resolves.toEqual({ text: "formatted", mtime: 7 });
    expect(invokeMock.mock.calls.map(([, args]) => (args as { workspace: unknown }).workspace)).toEqual([
      workspaceA, workspaceA,
    ]);
  });

  it("preserves the legacy default to the current workspace", async () => {
    invokeMock.mockResolvedValueOnce({ stdout: "", stderr: "", exit_code: 0, timed_out: false });
    invokeMock.mockResolvedValueOnce({ kind: "text", content: "text", mtime: 1 });
    await runExternalFormatter("prettier", "/repo/file.ts");
    await readFileText("/repo/file.ts");
    expect(invokeMock.mock.calls.map(([, args]) => (args as { workspace: unknown }).workspace)).toEqual([
      workspaceA, workspaceA,
    ]);
  });
});
