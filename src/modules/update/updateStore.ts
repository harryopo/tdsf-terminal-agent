import { create } from "zustand";
import type { InstallBlocker } from "./updateFacts";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export type UpdateState = {
  phase: UpdatePhase;
  version: string | null;
  notes: string | null;
  /** 更新包字节数；下载前拿不到就是 null（文案不许编一个数） */
  bytes: number | null;
  received: number;
  error: string | null;
  /** 拒装时给出的原因，界面要逐条说清，不能只说"现在不能装" */
  blockers: InstallBlocker[];
  checkedAt: number | null;
  setPhase(phase: UpdatePhase): void;
  beginCheck(): void;
  markUpToDate(at: number): void;
  markAvailable(input: { version: string; notes: string | null; at: number }): void;
  markError(text: string): void;
  startDownload(bytes: number | null): void;
  noteTotalBytes(bytes: number): void;
  noteProgress(received: number): void;
  markDownloaded(): void;
  markInstalling(): void;
  refuseInstall(blockers: InstallBlocker[]): void;
};

export const useUpdateStore = create<UpdateState>((set) => ({
  phase: "idle",
  version: null,
  notes: null,
  bytes: null,
  received: 0,
  error: null,
  blockers: [],
  checkedAt: null,
  setPhase: (phase) => set({ phase }),
  beginCheck: () => set({ phase: "checking", error: null, blockers: [] }),
  markUpToDate: (at) =>
    set({ phase: "up-to-date", version: null, bytes: null, checkedAt: at }),
  markAvailable: ({ version, notes, at }) =>
    set({ phase: "available", version, notes, error: null, checkedAt: at }),
  markError: (text) => set({ phase: "error", error: text }),
  startDownload: (bytes) =>
    set({ phase: "downloading", bytes, received: 0, error: null }),
  noteTotalBytes: (bytes) => set({ bytes }),
  noteProgress: (received) => set({ received }),
  markDownloaded: () => set({ phase: "ready" }),
  markInstalling: () => set({ phase: "installing", blockers: [] }),
  refuseInstall: (blockers) => set({ phase: "ready", blockers }),
}));
