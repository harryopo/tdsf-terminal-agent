import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { SshCredentialProfile } from "@/lib/ssh-bridge";
import { useSshStore } from "@/modules/ssh-explorer/sshStore";
import { __resetReconnectGuard, reconnectSshSpace } from "./openSpaceShell";
import type { SpaceMeta } from "./store";
import { useSpaces } from "./useSpaces";

const mocks = vi.hoisted(() => ({ sshConnect: vi.fn() }));
vi.mock("@/lib/ssh-bridge", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/ssh-bridge")>(),
  sshConnect: mocks.sshConnect,
  sshCredentialsGetSecret: vi.fn(async () => "fixture-value"),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));

const env = { kind: "ssh", host: "server.test", port: 22, user: "dev", label: "server" } as const;
const profile: SshCredentialProfile = {
  id: "profile", alias: "test", host: env.host, port: env.port, user: env.user,
  auth: { type: "password" }, lastUsed: 0, createdAt: 0,
};
const space: SpaceMeta = {
  id: "ssh-a", name: "SSH A", root: null, env, createdAt: 1, updatedAt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetReconnectGuard();
  useSpaces.setState({ activeId: space.id, spaces: [space] });
  useSshStore.setState({ sessions: [], activeSessionId: null, savedConnections: [profile] });
  mocks.sshConnect.mockReset();
});

describe("workspace reconnect diagnostics", () => {
  it("reports the active workspace failure once with the parsed cause", async () => {
    mocks.sshConnect.mockRejectedValueOnce(new Error("Connection refused"));
    const report = vi.fn();

    expect(await reconnectSshSpace(space.id, env, report)).toBeNull();
    expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      stuckAt: "network",
      raw: "Connection refused",
    }));
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it.each(["switch", "replace-endpoint", "already-connected"] as const)(
    "drops a late failure after %s",
    async (change) => {
      let fail!: (error: Error) => void;
      mocks.sshConnect.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
      const report = vi.fn();
      const pending = reconnectSshSpace(space.id, env, report);
      await vi.waitFor(() => expect(mocks.sshConnect).toHaveBeenCalledTimes(1));

      if (change === "switch") {
        useSpaces.setState({ activeId: "ssh-b", spaces: [space, { ...space, id: "ssh-b" }] });
      } else if (change === "replace-endpoint") {
        useSpaces.setState({ spaces: [{ ...space, env: { ...env, port: 2222 } }] });
      } else {
        const previous = useSshStore.getState().sessions[0]!;
        useSshStore.setState({ sessions: [
          previous, { ...previous, id: "recovered", rustSessionId: 8, state: "connected" },
        ] });
        useSpaces.setState({ spaces: [{ ...space, env: { ...env, sessionId: "recovered" } }] });
      }

      fail(new Error("Connection refused"));
      expect(await pending).toBeNull();
      expect(report).not.toHaveBeenCalled();
    },
  );
});
