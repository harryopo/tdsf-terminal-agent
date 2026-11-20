import { expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  entries: vi.fn(),
  set: vi.fn(async () => {}),
  get: vi.fn(async () => null),
  delete: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/plugin-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/plugin-store")>();
  return {
    ...actual,
    LazyStore: class extends actual.LazyStore {
      constructor(path: string, options?: ConstructorParameters<typeof actual.LazyStore>[1]) {
        super(path, options);
        if (path === "tdsf-sessions.json") Object.assign(this, storage);
      }
    },
  };
});

import { useChatStore } from "./chatStore";

it("keeps an unsaved conversation usable after a failed read without replacing history", async () => {
  storage.entries.mockRejectedValueOnce(new Error("Test storage read failed"));
  await useChatStore.getState().hydrateSessions();

  const recovered = useChatStore.getState();
  expect(recovered.sessionsHydrated).toBe(true);
  expect(recovered.activeSessionId).toBeTruthy();
  expect(storage.set).not.toHaveBeenCalled();

  const id = recovered.newSession();
  expect(useChatStore.getState().activeSessionId).toBe(id);
  expect(storage.set).not.toHaveBeenCalled();
});
