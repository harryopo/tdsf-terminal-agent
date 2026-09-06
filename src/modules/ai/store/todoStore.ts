import { create } from "zustand";
import {
  deleteTodos as persistDelete,
  loadTodos as persistLoad,
  saveTodos as persistSave,
  type Todo,
} from "../lib/todos";

type TodosState = {
  /** Map of sessionId -> todos. */
  bySession: Record<string, Todo[]>;
  /** Set of sessionIds whose todos were hydrated. */
  hydrated: Set<string>;
  hydrate: (sessionId: string) => Promise<void>;
  setTodos: (sessionId: string, todos: Todo[]) => void;
  clearSession: (sessionId: string) => Promise<void>;
};

export const useTodosStore = create<TodosState>((set, get) => ({
  bySession: {},
  hydrated: new Set(),

  async hydrate(sessionId) {
    if (get().hydrated.has(sessionId)) return;
    const todos = await persistLoad(sessionId);
    set((s) => {
      // A live update received while storage loads is newer than disk.
      if (s.hydrated.has(sessionId)) return s;
      const nextHydrated = new Set(s.hydrated);
      nextHydrated.add(sessionId);
      return {
        bySession: { ...s.bySession, [sessionId]: todos },
        hydrated: nextHydrated,
      };
    });
  },

  setTodos(sessionId, todos) {
    set((s) => {
      const nextHydrated = new Set(s.hydrated);
      nextHydrated.add(sessionId);
      return {
        bySession: { ...s.bySession, [sessionId]: todos },
        hydrated: nextHydrated,
      };
    });
    void persistSave(sessionId, todos);
  },

  async clearSession(sessionId) {
    set((s) => {
      const next = { ...s.bySession };
      delete next[sessionId];
      const nextHydrated = new Set(s.hydrated);
      nextHydrated.delete(sessionId);
      return { bySession: next, hydrated: nextHydrated };
    });
    await persistDelete(sessionId);
  },
}));

export function getTodos(sessionId: string | null): Todo[] {
  if (!sessionId) return [];
  return useTodosStore.getState().bySession[sessionId] ?? [];
}
