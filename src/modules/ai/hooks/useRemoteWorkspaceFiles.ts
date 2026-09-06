import { sftpList } from "@/lib/sftp-bridge";
import { useEffect, useState } from "react";

export type RemoteWorkspaceFilesState = {
  files: string[];
  indexing: boolean;
  truncated: boolean;
  error: string | null;
};

type CacheEntry = Omit<RemoteWorkspaceFilesState, "indexing" | "error"> & {
  fetchedAt: number;
};

const CACHE_TTL_MS = 60_000;
const MAX_FILES = 500;
const MAX_DIRECTORIES = 160;
const MAX_DEPTH = 4;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();

function cacheKey(sessionId: number, root: string): string {
  return `${sessionId}:${root}`;
}

function relativePath(root: string, absolutePath: string): string | null {
  const normalizedRoot = root === "/" ? "/" : root.replace(/\/+$/, "");
  if (normalizedRoot === "/") return absolutePath.replace(/^\/+/, "") || null;
  if (!absolutePath.startsWith(`${normalizedRoot}/`)) return null;
  return absolutePath.slice(normalizedRoot.length + 1) || null;
}

async function fetchFiles(sessionId: number, root: string): Promise<CacheEntry> {
  const key = cacheKey(sessionId, root);
  const pending = inflight.get(key);
  if (pending) return pending;

  const request = (async () => {
    const files: string[] = [];
    const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
    let directories = 0;
    let truncated = false;

    while (queue.length > 0 && files.length < MAX_FILES) {
      const next = queue.shift();
      if (!next) break;
      const entries = await sftpList(sessionId, next.path);
      for (const entry of entries) {
        if (entry.isSymlink) continue;
        if (entry.isFile) {
          const relative = relativePath(root, entry.path);
          if (relative) files.push(relative);
          if (files.length >= MAX_FILES) {
            truncated = true;
            break;
          }
        } else if (entry.isDir) {
          if (next.depth >= MAX_DEPTH || directories >= MAX_DIRECTORIES) {
            truncated = true;
            continue;
          }
          queue.push({ path: entry.path, depth: next.depth + 1 });
          directories += 1;
        }
      }
    }
    if (queue.length > 0) truncated = true;

    const entry: CacheEntry = {
      files: files.sort((a, b) => a.localeCompare(b)),
      truncated,
      fetchedAt: Date.now(),
    };
    cache.set(key, entry);
    return entry;
  })().finally(() => inflight.delete(key));

  inflight.set(key, request);
  return request;
}

export function useRemoteWorkspaceFiles(
  workspaceRoot: string | null,
  sessionId: number | null,
  enabled: boolean,
): RemoteWorkspaceFilesState {
  const key = workspaceRoot && sessionId != null ? cacheKey(sessionId, workspaceRoot) : null;
  const [state, setState] = useState<RemoteWorkspaceFilesState>({
    files: [],
    indexing: false,
    truncated: false,
    error: null,
  });

  useEffect(() => {
    if (!workspaceRoot || sessionId == null || !key) {
      setState({ files: [], indexing: false, truncated: false, error: null });
      return;
    }

    const cached = cache.get(key);
    if (cached) {
      setState({ ...cached, indexing: false, error: null });
      if (Date.now() - cached.fetchedAt < CACHE_TTL_MS || !enabled) return;
    }
    if (!enabled) return;

    let cancelled = false;
    setState((previous) => ({ ...previous, indexing: true, error: null }));
    fetchFiles(sessionId, workspaceRoot)
      .then((entry) => {
        if (!cancelled) setState({ ...entry, indexing: false, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const detail = error instanceof Error ? error.message : String(error);
        setState((previous) => ({ ...previous, indexing: false, error: detail }));
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, key, sessionId, workspaceRoot]);

  return state;
}
