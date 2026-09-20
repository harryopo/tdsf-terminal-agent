import { usePreferencesStore } from "@/modules/settings/preferences";
import { parseWorkspaceScopeKey, type WorkspaceEnv } from "@/modules/workspace";
import { create } from "zustand";
import {
  deleteSpaceData,
  newSpaceId,
  readSpaces,
  type SpaceMeta,
  saveActiveId,
  saveSpacesList,
} from "./store";

type CreateInput = {
  id?: string;
  name: string;
  root: string | null;
  env?: WorkspaceEnv;
};

type State = {
  spaces: SpaceMeta[];
  activeId: string | null;
  hydrated: boolean;
  // Per-space active tab index loaded from disk, so persistence preserves it
  // for spaces the user never visits this session.
  initialActiveIndex: Record<string, number>;
  hydrate: (
    spaces: SpaceMeta[],
    activeId: string | null,
    initialActiveIndex?: Record<string, number>,
  ) => void;
  create: (input: CreateInput) => SpaceMeta;
  rename: (id: string, name: string) => void;
  setEnv: (id: string, env: WorkspaceEnv) => void;
  setRoot: (id: string, root: string | null) => void;
  setColor: (id: string, color: number | undefined) => void;
  reorder: (orderedIds: string[]) => void;
  remove: (id: string) => string | null;
  setActive: (id: string) => void;
};

/** Patch one space's fields against whatever list is currently stored. */
const patchSpace =
  (id: string, changes: Partial<SpaceMeta>) =>
  (current: SpaceMeta[]): SpaceMeta[] =>
    current.map((s) =>
      s.id === id ? { ...s, ...changes, updatedAt: Date.now() } : s,
    );

/** Reorder by the given ids; spaces this window never saw keep their order at the tail. */
const reorderBy =
  (orderedIds: string[]) =>
  (current: SpaceMeta[]): SpaceMeta[] => {
    const byId = new Map(current.map((s) => [s.id, s]));
    const next: SpaceMeta[] = [];
    for (const id of orderedIds) {
      const s = byId.get(id);
      if (s) {
        next.push(s);
        byId.delete(id);
      }
    }
    for (const s of current) {
      if (byId.has(s.id)) next.push(s);
    }
    return next;
  };

const withoutSpace =
  (id: string) =>
  (current: SpaceMeta[]): SpaceMeta[] =>
    current.filter((s) => s.id !== id);

export const useSpaces = create<State>((set, get) => {
  // Commits run one at a time: two mutations fired in the same tick must not
  // both read the pre-write list, or the second overwrites the first.
  let queue: Promise<void> = Promise.resolve();

  /**
   * #64: one process now owns several windows that all edit this list, so every
   * action applies its own mutation to the stored list instead of overwriting
   * it with this window's copy — a whole-array write from a stale view is what
   * made workspaces vanish. The optimistic `set` keeps the tab strip instant;
   * the merged result then replaces it so the windows converge.
   */
  const commit = (
    optimistic: SpaceMeta[],
    mutate: (current: SpaceMeta[]) => SpaceMeta[],
  ) => {
    set({ spaces: optimistic });
    queue = queue
      .then(async () => {
        const next = mutate(await readSpaces());
        await saveSpacesList(next);
        set({ spaces: next });
      })
      .catch((error: unknown) => {
        // 写盘失败必须出声：静默丢掉的是用户的工作区清单。
        console.error("[spaces] 保存工作区清单失败:", error);
      });
  };

  return {
    spaces: [],
    activeId: null,
    hydrated: false,
    initialActiveIndex: {},

    hydrate: (spaces, activeId, initialActiveIndex = {}) => {
      set({ spaces, activeId, initialActiveIndex, hydrated: true });
    },

    create: (input) => {
      const now = Date.now();
      const meta: SpaceMeta = {
        id: input.id ?? newSpaceId(),
        name: input.name,
        root: input.root,
        env:
          input.env ??
          parseWorkspaceScopeKey(
            usePreferencesStore.getState().defaultWorkspaceEnv,
          ),
        createdAt: now,
        updatedAt: now,
      };
      commit([...get().spaces, meta], (current) =>
        current.some((s) => s.id === meta.id) ? current : [...current, meta],
      );
      return meta;
    },

    rename: (id, name) => {
      commit(
        get().spaces.map((s) =>
          s.id === id ? { ...s, name, updatedAt: Date.now() } : s,
        ),
        patchSpace(id, { name }),
      );
    },

    setEnv: (id, env) => {
      commit(
        get().spaces.map((s) =>
          s.id === id ? { ...s, env, updatedAt: Date.now() } : s,
        ),
        patchSpace(id, { env }),
      );
    },

    setRoot: (id, root) => {
      commit(
        get().spaces.map((s) =>
          s.id === id ? { ...s, root, updatedAt: Date.now() } : s,
        ),
        patchSpace(id, { root }),
      );
    },

    setColor: (id, color) => {
      commit(
        get().spaces.map((s) =>
          s.id === id ? { ...s, color, updatedAt: Date.now() } : s,
        ),
        patchSpace(id, { color }),
      );
    },

    reorder: (orderedIds) => {
      commit(reorderBy(orderedIds)(get().spaces), reorderBy(orderedIds));
    },

    remove: (id) => {
      const prev = get();
      const spaces = prev.spaces.filter((s) => s.id !== id);
      let activeId = prev.activeId;
      if (activeId === id) activeId = spaces[0]?.id ?? null;
      commit(spaces, withoutSpace(id));
      if (activeId !== prev.activeId) set({ activeId });
      void deleteSpaceData(id);
      if (activeId !== prev.activeId) void saveActiveId(activeId);
      return activeId;
    },

    setActive: (id) => {
      if (get().activeId === id) return;
      set({ activeId: id });
      void saveActiveId(id);
    },
  };
});
