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
  const returnedThought = "returned thought fixture";
  const returnedMessages = () => [{
    id: "returned-message", role: "assistant", parts: [
      { type: "reasoning", text: returnedThought, providerMetadata: { vendor: { signature: "opaque signature fixture" } } },
      { type: "text", text: "returned answer fixture" },
      { type: "dynamic-tool", toolName: "ssh_command", toolCallId: "returned-call", state: "output-available",
        input: { command: "pwd", password: "input credential fixture" }, // secret-scan: fixture-line
        output: { status: "indeterminate", stdout: "/srv", exit_code: null }, providerMetadata: { hidden: "hidden SDK fixture" } },
      { type: "file", mediaType: "text/plain", url: "attachment private fixture" },
    ],
  }] as unknown as UIMessage[];

  it("shows recorded reasoning locally while still omitting injected context", async () => {
    vi.mocked(invokeRpc).mockImplementation(async (method) => method === "debug.agent_log_tail"
      ? log("chat-a", [
        { ts: 1, type: "reasoning", content: returnedThought },
        { ts: 2, type: "env_inject", content: "environment private fixture" },
      ]) : evidence);
    const result = await fetchSessionDiagnostics("chat-a");
    expect(result.journal.status).toBe("ready");
    if (result.journal.status !== "ready") throw new Error("Fixture journal failed");
    expect(result.journal.data.lines[0].content).toBe(returnedThought);
    expect(JSON.stringify(result)).not.toContain("environment private fixture");
  });

  it("projects only returned thought and public tool fields when details are requested", () => {
    const original = returnedMessages();
    const originalJson = JSON.stringify(original);
    const detailed = conversationSnapshot(original, 200, true);
    expect(detailed[0].text).toBe("returned answer fixture");
    expect(detailed[0].parts?.map((part) => part.kind)).toEqual(["reasoning", "tool"]);
    expect(detailed[0].parts?.[0].text).toBe(returnedThought);
    expect(JSON.parse(detailed[0].parts?.[1].text ?? "null")).toMatchObject({
      tool_name: "ssh_command", tool_call_id: "returned-call", state: "output-available",
      output: { status: "indeterminate", stdout: "/srv", exit_code: null },
    });
    const serialized = JSON.stringify(detailed);
    for (const hidden of ["opaque signature fixture", "hidden SDK fixture", "attachment private fixture", "input credential fixture"])
      expect(serialized).not.toContain(hidden);
    expect(serialized).toContain("<REDACTED>");
    expect(JSON.stringify(original)).toBe(originalJson);
  });

  it("keeps static tool inputs distinct from an output that never arrived", () => {
    const projected = conversationSnapshot([{
      id: "input-only", role: "assistant", parts: [{ type: "tool-ssh_command", toolCallId: "input-call", state: "input-available", input: { command: "pwd" } }],
    }] as unknown as UIMessage[], 200, true);
    const tool = JSON.parse(projected[0].parts?.[0].text ?? "null");
    expect(tool).toMatchObject({ tool_name: "ssh_command", tool_call_id: "input-call", state: "input-available" });
    expect(tool).not.toHaveProperty("output");
  });

  it("marks clipped returned content without splitting a UTF-16 surrogate pair", () => {
    const projected = conversationSnapshot([{
      id: "bounded", role: "assistant", parts: [
        { type: "reasoning", text: `${"a".repeat(7999)}🙂` },
        { type: "dynamic-tool", toolName: "reader", toolCallId: "long-call", state: "output-available", input: {}, output: "x".repeat(9000) },
      ],
    }] as unknown as UIMessage[], 200, true);
    expect(projected[0].parts).toHaveLength(2);
    for (const part of projected[0].parts ?? []) {
      expect(part.text_truncated).toBe(true);
      expect(part.text.length).toBeLessThanOrEqual(8000);
      const last = part.text.charCodeAt(part.text.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it("requires explicit reasoning export even for a detailed frozen snapshot", async () => {
    const data = { sessionId: "chat-a", fetchedAt: "now", journal: { status: "ready", data: log("chat-a", [
      { ts: 1, type: "reasoning", content: returnedThought },
      { ts: 2, type: "env_inject", content: "environment private fixture" },
    ]) } as const, evidence: { status: "ready", data: evidence } as const };
    const frozen = buildDiagnosticSnapshot(data, returnedMessages(), 200, true);
    expect(JSON.stringify(frozen.conversation)).toContain(returnedThought);
    vi.mocked(invokeRpc).mockResolvedValue({ ok: true, path: "diagnostics/returned.json" });
    await exportDiagnosticSnapshot(frozen);
    const defaultExport = vi.mocked(invokeRpc).mock.calls.at(-1)?.[1];
    expect(defaultExport).toMatchObject({ snapshot: { sources: { export_policy: { include_returned_reasoning: false } } } });
    expect(JSON.stringify(defaultExport)).not.toContain(returnedThought);
    expect(JSON.stringify(defaultExport)).toContain("returned-call");
    await exportDiagnosticSnapshot(frozen, true);
    const explicitExport = vi.mocked(invokeRpc).mock.calls.at(-1)?.[1];
    expect(explicitExport).toMatchObject({ snapshot: { sources: { export_policy: { include_returned_reasoning: true } } } });
    expect(JSON.stringify(explicitExport)).toContain(returnedThought);
    for (const hidden of ["environment private fixture", "opaque signature fixture", "input credential fixture"])
      expect(JSON.stringify(explicitExport)).not.toContain(hidden);
    expect(JSON.stringify(frozen.conversation)).toContain(returnedThought);
  });

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
