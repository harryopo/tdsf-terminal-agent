import { afterEach, describe, expect, it, vi } from "vitest";

const { persistLoad, persistSave } = vi.hoisted(() => ({
  persistLoad: vi.fn(),
  persistSave: vi.fn(),
}));

vi.mock("../lib/todos", () => ({
  deleteTodos: vi.fn(),
  loadTodos: persistLoad,
  saveTodos: persistSave,
}));

import { useTodosStore } from "./todoStore";

const SESSION = "todo-live-wins";

afterEach(() => {
  useTodosStore.setState({ bySession: {}, hydrated: new Set() });
  persistLoad.mockReset();
  persistSave.mockReset();
});

describe("todoStore", () => {
  it("keeps a live sidecar update that arrives during persistence hydration", async () => {
    let resolveLoad: (todos: []) => void = () => undefined;
    persistLoad.mockReturnValue(
      new Promise<[]>((resolve) => {
        resolveLoad = resolve;
      }),
    );

    const hydrating = useTodosStore.getState().hydrate(SESSION);
    useTodosStore
      .getState()
      .setTodos(SESSION, [
        { id: "live", title: "真实任务", status: "in_progress" },
      ]);
    resolveLoad([]);
    await hydrating;

    expect(useTodosStore.getState().bySession[SESSION]).toEqual([
      { id: "live", title: "真实任务", status: "in_progress" },
    ]);
  });
});
