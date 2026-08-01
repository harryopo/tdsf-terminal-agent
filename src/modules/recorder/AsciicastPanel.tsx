/**
 * AsciicastPanel.tsx — asciicast 会话录制回放面板（P2-2）
 * -----------------------------------------------------------------------------
 * 录制（命令面板 record.start/stop）→ 保存 .cast 文件（asciicast v2）→
 * 回放（xterm 按时间轴重放）→ 教学复盘/导出。
 *
 * 文件位置：~/.tdsf-data/recordings/*.cast（fs_write_file/fs_read_dir/
 * fs_read_file 复用现有 Rust 命令，无新依赖）。
 *
 * 设计规范：UI 组件套（Dialog/Input/Button/Badge/Separator）+ Hugeicons
 * 图标，不使用 emoji。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import {
  ArrowLeft01Icon,
  RefreshIcon,
  PlayIcon,
  RecordIcon,
  SaveIcon,
  VideoReplayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Terminal as XTerm } from "@xterm/xterm";
import { toast } from "sonner";

// ============================================================================
// asciicast v2 类型
// ============================================================================

interface CastHeader {
  version: 2;
  width: number;
  height: number;
  timestamp?: number;
  env?: Record<string, string>;
}

type CastEvent = [number, string, string];

// ============================================================================
// 工具
// ============================================================================

function recordingsDir(home: string): string {
  return `${home}/.tdsf-data/recordings`;
}

interface CastFile {
  name: string;
  path: string;
  size: number;
}

async function listCasts(home: string): Promise<CastFile[]> {
  try {
    const dir = recordingsDir(home);
    const entries = await invoke<Array<{ name?: string; path?: string; size?: number }>>(
      "fs_read_dir",
      { path: dir },
    );
    return (entries ?? [])
      .filter((e) => (e.name ?? "").endsWith(".cast"))
      .map((e) => ({ name: e.name ?? "", path: e.path ?? "", size: e.size ?? 0 }))
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch {
    return [];
  }
}

async function saveCast(home: string, name: string, content: string): Promise<boolean> {
  try {
    await invoke("fs_write_file", {
      path: `${recordingsDir(home)}/${name}.cast`,
      content,
    });
    return true;
  } catch (e) {
    console.error("[asciicast] save failed:", e);
    return false;
  }
}

async function readCast(path: string): Promise<CastHeader & { events: CastEvent[] } | null> {
  try {
    const raw = await invoke<{ content?: string }>("fs_read_file", { path });
    const text = raw?.content ?? "";
    const parsed = JSON.parse(text);
    if (parsed.version !== 2 || !Array.isArray(parsed.events)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ============================================================================
// 组件
// ============================================================================

export function AsciicastPanel({
  open,
  onOpenChange,
  home,
  pendingRecording,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  home: string | null;
  /** 刚停止的录制（停止按钮触发时传入，预填保存区） */
  pendingRecording: { name: string; content: string } | null;
}) {
  const [casts, setCasts] = useState<CastFile[]>([]);
  const [saveName, setSaveName] = useState("");
  const [saved, setSaved] = useState(false);
  const [playing, setPlaying] = useState<CastFile | null>(null);

  const refresh = useCallback(() => {
    if (!home) return;
    void listCasts(home).then(setCasts);
  }, [home]);

  useEffect(() => {
    if (!open) return;
    // 打开时刷新列表 + 预填待保存录制
    if (pendingRecording) {
      setSaveName(pendingRecording.name.replace(/\.cast$/, ""));
      setSaved(false);
    }
    refresh();
  }, [open, pendingRecording, refresh]);

  const onSave = async () => {
    if (!home || !pendingRecording) return;
    const name = saveName.trim() || `recording-${Date.now()}`;
    const ok = await saveCast(home, name, pendingRecording.content);
    if (ok) {
      toast.success(`录制已保存：${name}.cast`);
      setSaved(true);
      refresh();
    } else {
      toast.error("保存失败（检查 ~/.tdsf-data/recordings 目录）");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[70vh] max-w-3xl flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-border/50 px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <HugeiconsIcon icon={VideoReplayIcon} size={15} strokeWidth={1.75} />
            会话录制回放
          </DialogTitle>
        </DialogHeader>

        {!playing ? (
          <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
            {/* 保存区 */}
            {pendingRecording && (
              <div className="rounded-lg border border-border/50 bg-card/40 p-3">
                <div className="mb-1.5 flex items-center gap-1.5">
                  <HugeiconsIcon
                    icon={RecordIcon}
                    size={12}
                    strokeWidth={1.75}
                    className="text-destructive"
                  />
                  <span className="text-[11.5px] font-medium text-foreground">
                    新录制待保存
                  </span>
                  <Badge variant="secondary" className="ml-auto text-[9.5px]">
                    asciicast v2
                  </Badge>
                </div>
                <div className="flex items-center gap-1.5">
                  <Input
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                    placeholder="录制文件名"
                    className="h-7 flex-1 text-[11px]"
                  />
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 gap-1.5 text-[11px]"
                    onClick={() => void onSave()}
                    disabled={saved}
                  >
                    <HugeiconsIcon icon={SaveIcon} size={12} strokeWidth={1.75} />
                    {saved ? "已保存" : "保存"}
                  </Button>
                </div>
                <div className="mt-1.5 text-[10px] text-muted-foreground/70">
                  {pendingRecording.content.length} 字节 · 保存到
                  ~/.tdsf-data/recordings/
                </div>
              </div>
            )}

            {/* 回放列表 */}
            <div className="flex items-center justify-between">
              <span className="text-[11.5px] font-medium text-foreground">
                已保存录制
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1 text-[10.5px]"
                onClick={refresh}
              >
                <HugeiconsIcon icon={RefreshIcon} size={11} strokeWidth={1.75} />
                刷新
              </Button>
            </div>
            {casts.length === 0 ? (
              <div className="py-6 text-center text-[11px] text-muted-foreground">
                暂无录制。命令面板 →「开始录制」→ 操作终端 →「停止录制并保存」。
              </div>
            ) : (
              <div className="space-y-1.5">
                {casts.map((c) => (
                  <div
                    key={c.name}
                    className="flex items-center gap-2 rounded-lg border border-border/50 bg-card/40 px-3 py-2"
                  >
                    <HugeiconsIcon
                      icon={VideoReplayIcon}
                      size={13}
                      strokeWidth={1.75}
                      className="shrink-0 text-muted-foreground"
                    />
                    <span className="flex-1 truncate font-mono text-[11px] text-foreground">
                      {c.name}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground/70">
                      {formatBytes(c.size)}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      className="h-6 gap-1 text-[10.5px]"
                      onClick={() => setPlaying(c)}
                    >
                      <HugeiconsIcon icon={PlayIcon} size={11} strokeWidth={1.75} />
                      回放
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <CastPlayer
            castFile={playing}
            onClose={() => setPlaying(null)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// CastPlayer — xterm 回放
// ============================================================================

function CastPlayer({
  castFile,
  onClose,
}: {
  castFile: CastFile;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const timerRef = useRef<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void readCast(castFile.path).then((cast) => {
      if (cancelled || !cast || !containerRef.current) {
        setLoading(false);
        return;
      }
      const term = new XTerm({
        cols: cast.width || 80,
        rows: cast.height || 24,
        fontSize: 12,
        convertEol: true,
        theme: { background: "#0b0e14" },
      });
      term.open(containerRef.current);
      termRef.current = term;

      // 时间轴回放
      let total = 0;
      for (const [delay] of cast.events) total += delay;
      let elapsed = 0;
      let idx = 0;
      const step = () => {
        if (cancelled || idx >= cast.events.length) {
          setPlaying(false);
          return;
        }
        const [delay, , data] = cast.events[idx];
        idx += 1;
        elapsed += delay;
        setProgress(total ? Math.min(1, elapsed / total) : 1);
        if (data) term.write(data);
        timerRef.current = window.setTimeout(step, delay * 1000);
      };
      setPlaying(true);
      timerRef.current = window.setTimeout(step, 50);
      setLoading(false);
    });
    return () => {
      cancelled = true;
      if (timerRef.current) window.clearTimeout(timerRef.current);
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, [castFile]);

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <span className="flex-1 truncate font-mono text-[11px] text-foreground">
          {castFile.name}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 text-[10.5px]"
          onClick={onClose}
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={11} strokeWidth={1.75} />
          返回列表
        </Button>
      </div>
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          加载录制…
        </div>
      ) : (
        <>
          <div ref={containerRef} className="min-h-0 flex-1 bg-[#0b0e14] p-2" />
          <div className="border-t border-border/50 px-3 py-1.5">
            <div className="h-1 overflow-hidden rounded-full bg-muted/40">
              <div
                className="h-full rounded-full bg-emerald-500/70 transition-all"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
            <div className="mt-1 text-center text-[9.5px] text-muted-foreground/60">
              {playing ? "回放中…" : "回放结束"}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
