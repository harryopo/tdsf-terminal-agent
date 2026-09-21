import type { WorkspaceEnv } from "@/modules/workspace";
import { LazyStore } from "@tauri-apps/plugin-store";

export type SpaceMeta = {
  id: string;
  name: string;
  root: string | null;
  env: WorkspaceEnv;
  /** Opt-in accent, index into SPACE_COLORS. Undefined = theme primary. */
  color?: number;
  createdAt: number;
  updatedAt: number;
};

const STORE_PATH = "tdsf-spaces.json";
const KEY_SPACES = "spaces";
const KEY_ACTIVE = "activeId";
const STATE_PREFIX = "state:";
const stateKey = (id: string) => `${STATE_PREFIX}${id}`;

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 500 });

export type LoadedSpaces = {
  spaces: SpaceMeta[];
  activeId: string | null;
};

export async function loadAll(): Promise<LoadedSpaces> {
  const entries = await store.entries();
  let spaces: SpaceMeta[] = [];
  let activeId: string | null = null;
  for (const [k, v] of entries) {
    if (k === KEY_SPACES) spaces = (v as SpaceMeta[]) ?? [];
    else if (k === KEY_ACTIVE) activeId = (v as string | null) ?? null;
    // #96 之后 `state:*` 是历史遗留键：老用户盘上还在，读回来只会污染清单，
    // 所以在这里明确跳过（不是"没实现"，是不再消费）。
  }
  return { spaces, activeId };
}

export async function saveSpacesList(spaces: SpaceMeta[]): Promise<void> {
  await store.set(KEY_SPACES, spaces);
}

/**
 * #64: the space list is shared by every window in the process, so a window
 * must patch what is actually on disk rather than its own boot snapshot —
 * otherwise a rename in one window silently deletes a space the other window
 * just created. Reads go through the backend store, which is the single
 * in-process source of truth.
 */
export async function readSpaces(): Promise<SpaceMeta[]> {
  const current = (await store.get(KEY_SPACES)) as SpaceMeta[] | undefined;
  return current ?? [];
}

export async function saveActiveId(id: string | null): Promise<void> {
  await store.set(KEY_ACTIVE, id);
}

/**
 * #96：删掉工作区时顺带清掉它可能残留的 `state:*` 旧键。
 * 新数据不再写这个键，这里只负责把老用户盘上的遗留收走。
 */
export async function deleteSpaceData(id: string): Promise<void> {
  await store.delete(stateKey(id));
}

export function newSpaceId(): string {
  return `sp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
