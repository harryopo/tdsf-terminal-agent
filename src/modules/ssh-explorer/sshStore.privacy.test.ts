import { afterEach, describe, expect, it } from "vitest";
import { useSshStore } from "./sshStore";

const diagnosticKey = "__TDSF_OSC7_LOG__";

afterEach(() => {
  Reflect.deleteProperty(window, diagnosticKey);
  useSshStore.setState({
    currentPathBySession: {},
    sessions: [],
    activeSessionId: null,
  });
});

describe("sshStore privacy", () => {
  it("updates each session path without appending diagnostic entries", () => {
    const diagnostic: unknown[] = [];
    Reflect.set(window, diagnosticKey, diagnostic);

    useSshStore.getState().setCurrentPath("session-a", "/home/a");
    useSshStore.getState().setCurrentPath("session-b", "/srv/b");

    expect(useSshStore.getState().currentPathBySession).toEqual({
      "session-a": "/home/a",
      "session-b": "/srv/b",
    });
    expect(diagnostic).toEqual([]);
  });
});
