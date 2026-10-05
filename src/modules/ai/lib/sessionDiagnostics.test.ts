import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sidecar-bridge", () => ({ invokeRpc: vi.fn() }));

import { invokeRpc } from "@/lib/sidecar-bridge";
import {
  buildDiagnosticSnapshot, conversationSnapshot, exportDiagnosticSnapshot,
  diagnosticText, fetchSessionDiagnostics, type RunEvent,
} from "./sessionDiagnostics";

const log = (session_id = "chat-a", lines: RunEvent[] = []) => ({ ok: true, session_id, lines });
const evidence = [{ tool_name: "ssh_command", status: "success", detail: "ok", result: "ok", agent: "a", timestamp: 1 }];

beforeEach(() => vi.mocked(invokeRpc).mockReset());

describe("fetchSessionDiagnostics", () => {
  it("requests both sources for the explicit session id and preserves independent source errors", async () => {
    vi.mocked(invokeRpc).mockImplementation((method) => method === "debug.agent_log_tail"
      ? Promise.resolve(log("chat-a", [{ ts: 10, type: "tool_result", content: "done" }]))
      : Promise.resolve([{ tool_name: "ssh_command", status: "success" }]));

    const result = await fetchSessionDiagnostics("chat-a", 50);

    expect(invokeRpc).toHaveBeenNthCalledWith(1, "debug.agent_log_tail", { session_id: "chat-a", lines: 50 });
    expect(invokeRpc).toHaveBeenNthCalledWith(2, "evidence.list", { session_id: "chat-a" });
    expect(result.journal.status).toBe("ready");
    expect(result.evidence).toMatchObject({ status: "error" });
  });

  it.each([
    ["empty response session", "chat-a", log("")],
    ["ok false", "chat-a", { ok: false, session_id: "chat-a", lines: [] }],
    ["wrong session", "chat-a", log("chat-b")],
    ["invalid event", "chat-a", log("chat-a", [{ ts: NaN, type: "tool_call", content: "x" }])],
  ])("does not present %s as an empty successful journal", async (_name, sessionId, response) => {
    vi.mocked(invokeRpc).mockImplementation(async (method) => method === "debug.agent_log_tail" ? response : evidence);
    const result = await fetchSessionDiagnostics(sessionId as string);
    expect(result.journal.status).toBe("error");
  });

  it("rejects an empty explicit id before making an RPC", async () => {
    await expect(fetchSessionDiagnostics("")).rejects.toThrow();
    expect(invokeRpc).not.toHaveBeenCalled();
  });

  it("keeps a malformed/failed evidence source independent from a valid journal", async () => {
    vi.mocked(invokeRpc).mockImplementation(async (method) => method === "debug.agent_log_tail" ? log() : [{ nope: true }]);
    const result = await fetchSessionDiagnostics("chat-a");
    expect(result.journal).toEqual({ status: "ready", data: log() });
    expect(result.evidence.status).toBe("error");
  });
});

describe("diagnostic projection and export", () => {
  it("redacts nested JSON credentials and token strings", async () => {
    vi.mocked(invokeRpc).mockImplementation(async (method) => method === "debug.agent_log_tail"
      ? log("chat-a", [{ ts: 1, type: "tool_result", content: JSON.stringify({ nested: { access_token: "secret-token", ok: "yes" } }) }])
      : evidence);
    const result = await fetchSessionDiagnostics("chat-a");
    expect(result.journal.status).toBe("ready");
    if (result.journal.status === "ready") {
      expect(result.journal.data.lines[0].content).not.toContain("secret-token");
      expect(result.journal.data.lines[0].content).toContain("<REDACTED>");
    }
  });

  it("redacts space-separated YAML, assignment, CLI, and URL credentials while preserving safe fields", () => {
    const input = [
      'password: "first second"',
      'token: "first second"',
      'password: "first \\"second\\" third"',
      "password: 'first''second'",
      'API_KEY="two word secret"',
      "--api-key 'two word secret'",
      "https://user:pass@host.example/path",
      "status: healthy",
    ].join("\n");
    const output = diagnosticText(input);
    expect(output).toContain("password=<REDACTED>");
    expect(output).toContain("token: <REDACTED>");
    expect(output.match(/password=<REDACTED>/g)).toHaveLength(3);
    expect(output).not.toContain("second");
    expect(output).not.toContain("third");
    expect(output).toContain("API_KEY=<REDACTED>");
    expect(output).toContain("--api-key <REDACTED>");
    expect(output).toContain("https://<REDACTED:credentials>@host.example/path");
    expect(output).toContain("status: healthy");
  });

  it("projects conversation text only, excluding system, attachments, and reasoning", () => {
    const messages = [
      { id: "sys", role: "system", parts: [{ type: "text", text: "hidden system" }] },
      { id: "u", role: "user", parts: [{ type: "text", text: "question" }, { type: "file", url: "secret-file" }] },
      { id: "a", role: "assistant", parts: [{ type: "reasoning", text: "private reasoning" }, { type: "text", text: "answer" }] },
    ] as unknown as UIMessage[];
    const projected = conversationSnapshot(messages);
    expect(projected).toEqual([{ id: "u", role: "user", text: "question", text_truncated: false }, { id: "a", role: "assistant", text: "answer", text_truncated: false }]);
  });

  it("does not export an isolated high surrogate when truncation splits an emoji", () => {
    const projected = conversationSnapshot([
      { id: "emoji", role: "user", parts: [{ type: "text", text: `${"a".repeat(7999)}🙂` }] },
    ] as unknown as UIMessage[]);
    expect(projected[0].text_truncated).toBe(true);
    const last = projected[0].text.charCodeAt(projected[0].text.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it("builds a versioned snapshot for the same chat and exports that session id", async () => {
    const data = { sessionId: "chat-a", fetchedAt: "now", journal: { status: "ready", data: log() } as const, evidence: { status: "ready", data: evidence } as const };
    const messages = [{ id: "m", role: "user", parts: [{ type: "text", text: "hi" }] }] as unknown as UIMessage[];
    const snapshot = buildDiagnosticSnapshot(data, messages);
    expect(snapshot).toMatchObject({ schema_version: 1, session_id: "chat-a", conversation: [{ id: "m", text: "hi" }] });
    vi.mocked(invokeRpc).mockResolvedValue({ ok: true, path: "diagnostics/chat-a.json" });
    await expect(exportDiagnosticSnapshot(snapshot)).resolves.toBe("diagnostics/chat-a.json");
    expect(invokeRpc).toHaveBeenCalledWith("debug.export_session_diagnostics", { session_id: "chat-a", snapshot });
  });
});
