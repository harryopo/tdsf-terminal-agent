import { describe, expect, it } from "vitest";
import { pendingFileSaves, trackFileSave } from "./pendingFileSaves";

describe("pending physical file saves", () => {
  it("filters source and directory boundaries, then forgets a completed write", async () => {
    let finish!: () => void;
    const task = new Promise<void>(r => { finish = r; });
    trackFileSave("source-a", "/srv/file", task);
    expect(pendingFileSaves("source-a", "/srv")).toEqual([task]);
    expect(pendingFileSaves("source-b", "/srv")).toEqual([]);
    expect(pendingFileSaves("source-a", "/sr")).toEqual([]);
    finish(); await task;
    expect(pendingFileSaves("source-a", "/srv")).toEqual([]);
  });

  it("forgets rejected work without swallowing its original error", async () => {
    let reject!: (e: Error) => void;
    const task = new Promise<void>((_, r) => { reject = r; });
    trackFileSave("source-a", "/failed", task);
    reject(new Error("write failed"));
    await expect(task).rejects.toThrow("write failed");
    expect(pendingFileSaves("source-a", "/failed")).toEqual([]);
  });
});
