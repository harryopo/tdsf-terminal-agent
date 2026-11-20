// A write can outlive its editor. Keep its physical owner until it settles.
const pending = new Set<{ sourceKey: string; path: string; task: Promise<unknown> }>();

export function trackFileSave(sourceKey: string | null, path: string, task: Promise<unknown>): void {
  if (sourceKey === null) return;
  const entry = { sourceKey, path, task };
  pending.add(entry);
  const release = () => { pending.delete(entry); };
  void task.then(release, release);
}

export function pendingFileSaves(sourceKey: string, root: string): Promise<unknown>[] {
  return [...pending].filter(entry => entry.sourceKey === sourceKey &&
    (entry.path === root || entry.path.startsWith(`${root}/`))).map(entry => entry.task);
}
