import { describe, expect, it } from "vitest";
import { fileTreeSourceKey } from "./useFileTree";

describe("fileTreeSourceKey", () => {
  it("distinguishes SSH sessions that use the same remote directory", () => {
    expect(
      fileTreeSourceKey({ kind: "sftp", sessionId: 200, root: "/" }),
    ).not.toBe(fileTreeSourceKey({ kind: "sftp", sessionId: 128, root: "/" }));
  });

  it("includes the remote root in the tree identity", () => {
    expect(
      fileTreeSourceKey({ kind: "sftp", sessionId: 1, root: "/" }),
    ).not.toBe(fileTreeSourceKey({ kind: "sftp", sessionId: 1, root: "/srv" }));
  });
});
