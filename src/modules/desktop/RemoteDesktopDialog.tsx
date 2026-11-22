// 远程桌面（RDP）对话框：IronRDP 帧经定向 Channel 推到 Canvas。
//
// ROOT 复审收口：
// - owner + generation + sessionId 绑定，输入/关闭/状态查询同身份校验。
// - 连接状态由 desktop_status 轮询确认，不把 connect 返回 id 当作已连接。
// - mouseup 用 event.button 释放；pointer capture、失焦释放、hover/wheel 支持。
// - 组件关闭时退订/断开，Pending 也可取消。
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  ArrowExpand01Icon,
  ArrowShrink01Icon,
  ComputerIcon,
  Loading03Icon,
  Shield01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { accumulateWheel, fitDesktopSize, mapButton, mapScancode, withOwner } from "./desktopInput";
import { VncDesktopView } from "./VncDesktopView";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface DesktopFrame {
  session_id: number;
  width: number;
  height: number;
  rgba_base64: string;
}

type SessionStatus = "pending" | "connected" | "failed" | "closed";
interface SessionStatusInfo {
  status: SessionStatus;
  error?: string | null;
}

const OWNER = "desktop-dialog";

interface ActiveSession {
  id: number;
  generation: number;
  protocol: "rdp" | "vnc";
}

interface VncConnection {
  session_id: number;
  websocket_url: string;
}


export function RemoteDesktopDialog({ open, onOpenChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imeRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionRef = useRef<ActiveSession | null>(null);
  const generationRef = useRef(1);
  const remoteSizeRef = useRef({ width: 0, height: 0 });
  const cancelledRef = useRef(true);
  const mountedRef = useRef(false);
  const pressedKeysRef = useRef(new Set<string>());
  const pointerButtonsRef = useRef(new Map<number, Set<number>>());
  const lastPointerRef = useRef({ x: 0, y: 0 });
  const wheelRemainderRef = useRef({ x: 0, y: 0 });
  const compositionRef = useRef(false);
  const compositionEndedAtRef = useRef(0);
  const inputQueueRef = useRef<Promise<void>>(Promise.resolve());
  const inputPendingRef = useRef(0);

  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("13389");
  const [username, setUsername] = useState("tdsf-test");
  const [password, setPassword] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "error">(
    "idle",
  );
  const [error, setError] = useState("");
  const [remoteSize, setRemoteSize] = useState({ width: 0, height: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [scaleMode, setScaleMode] = useState<"fit" | "actual">("fit");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [protocol, setProtocol] = useState<"rdp" | "vnc">("rdp");
  const [vncUrl, setVncUrl] = useState("");

  const drawFrame = useCallback((frame: DesktopFrame) => {
    const canvas = canvasRef.current;
    if (!canvas || cancelledRef.current) return;
    if (frame.session_id !== sessionRef.current?.id) return;
    if (canvas.width !== frame.width || canvas.height !== frame.height) {
      canvas.width = frame.width;
      canvas.height = frame.height;
    }
    remoteSizeRef.current = { width: frame.width, height: frame.height };
    setRemoteSize((current) =>
      current.width === frame.width && current.height === frame.height
        ? current
        : { width: frame.width, height: frame.height },
    );
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const binary = atob(frame.rgba_base64);
    const image = ctx.createImageData(frame.width, frame.height);
    const length = Math.min(image.data.length, binary.length);
    for (let i = 0; i < length; i += 1) {
      image.data[i] = binary.charCodeAt(i);
    }
    ctx.putImageData(image, 0, 0);
  }, []);

  const expanded = isFullscreen || isExpanded;
  const workspaceVisible = status === "connected" || (protocol === "vnc" && status === "connecting" && vncUrl !== "");
  const displaySize = useMemo(
    () => (scaleMode === "fit" ? fitDesktopSize(remoteSize, viewportSize) : remoteSize),
    [remoteSize, scaleMode, viewportSize],
  );
  const scalePercent = remoteSize.width > 0
    ? Math.round((displaySize.width / remoteSize.width) * 100)
    : 100;

  useEffect(() => {
    if (status !== "connected") return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => {
      const rect = viewport.getBoundingClientRect();
      const next = { width: Math.floor(rect.width), height: Math.floor(rect.height) };
      setViewportSize((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [expanded, status]);

  useEffect(() => {
    const update = () => setIsFullscreen(document.fullscreenElement === dialogRef.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (isFullscreen || document.fullscreenElement === dialogRef.current) {
      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => undefined);
      }
      setIsFullscreen(false);
      return;
    }
    if (isExpanded) {
      setIsExpanded(false);
      return;
    }
    const dialog = dialogRef.current;
    if (dialog?.requestFullscreen) {
      try {
        await dialog.requestFullscreen();
        setIsFullscreen(true);
        setIsExpanded(false);
        return;
      } catch {
        setIsExpanded(true);
        return;
      }
    }
    setIsExpanded(true);
  }, [isExpanded, isFullscreen]);

  const closeSession = useCallback((session: ActiveSession) => {
    void invoke("desktop_close", {
      sessionId: session.id,
      owner: OWNER,
      generation: session.generation,
    }).catch(() => undefined);
  }, []);

  const handleVncError = useCallback((message: string) => {
    const session = sessionRef.current;
    if (session?.protocol !== "vnc") return;
    setStatus("error");
    setError(message);
    sessionRef.current = null;
    closeSession(session);
  }, [closeSession]);

  const pollStatus = useCallback(async (session: ActiveSession) => {
    const started = Date.now();
    const isCurrent = () =>
      !cancelledRef.current &&
      sessionRef.current === session &&
      generationRef.current === session.generation;
    while (isCurrent()) {
      try {
        const info = await invoke<SessionStatusInfo>("desktop_status", {
          sessionId: session.id,
          owner: OWNER,
          generation: session.generation,
        });
        if (!isCurrent()) return;
        if (info.status === "connected") {
          setStatus("connected");
        } else if (info.status === "failed" || info.status === "closed") {
          setStatus("error");
          setError(info.error ?? "连接已关闭");
          sessionRef.current = null;
          closeSession(session);
          return;
        } else if (Date.now() - started > 60_000) {
          setStatus("error");
          setError("连接超时（60s）");
          sessionRef.current = null;
          closeSession(session);
          return;
        }
      } catch (err) {
        if (!isCurrent()) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));
        sessionRef.current = null;
        closeSession(session);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }, [closeSession]);

  const disconnect = useCallback(async () => {
    cancelledRef.current = true;
    generationRef.current += 1;
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) closeSession(session);
    if (document.fullscreenElement === dialogRef.current) {
      await document.exitFullscreen().catch(() => undefined);
    }
    setIsFullscreen(false);
    setIsExpanded(false);
    setStatus("idle");
  }, [closeSession]);

  const connect = useCallback(async () => {
    const previous = sessionRef.current;
    sessionRef.current = null;
    if (previous) closeSession(previous);
    const generation = ++generationRef.current;
    cancelledRef.current = false;
    setError("");
    setStatus("connecting");
    remoteSizeRef.current = { width: 0, height: 0 };
    setRemoteSize({ width: 0, height: 0 });
    setScaleMode("fit");
    inputQueueRef.current = Promise.resolve();
    inputPendingRef.current = 0;
    setVncUrl("");
    try {
      let session: ActiveSession;
      if (protocol === "rdp") {
        const channel = new Channel<DesktopFrame>();
        channel.onmessage = drawFrame;
        const id = await invoke<number>("desktop_connect", {
          params: {
            host,
            port: Number(port),
            username,
            password,
            owner: OWNER,
            generation,
            certificate_fingerprint: fingerprint.trim() || null,
          },
          onFrame: channel,
        });
        session = { id, generation, protocol };
      } else {
        const connection = await invoke<VncConnection>("vnc_connect", {
          params: {
            host,
            port: Number(port),
            username,
            password,
            owner: OWNER,
            generation,
            certificate_fingerprint: null,
          },
        });
        session = { id: connection.session_id, generation, protocol };
        setVncUrl(connection.websocket_url);
      }
      if (cancelledRef.current || generationRef.current !== generation || !mountedRef.current) {
        closeSession(session);
        return;
      }
      sessionRef.current = session;
      void pollStatus(session);
    } catch (err) {
      if (cancelledRef.current || generationRef.current !== generation) return;
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [host, port, username, password, fingerprint, protocol, drawFrame, pollStatus, closeSession]);

  const sendInput = useCallback((event: Record<string, unknown>) => {
    const session = sessionRef.current;
    if (!session || session.protocol !== "rdp" || cancelledRef.current) return;
    const coalescible = event.kind === "mouse" && event.button === 0 && event.down === false;
    if (inputPendingRef.current >= 32) {
      if (coalescible) return;
      setError("输入队列已满，请稍候");
      return;
    }
    inputPendingRef.current += 1;
    inputQueueRef.current = inputQueueRef.current.then(async () => {
      if (cancelledRef.current || sessionRef.current !== session) return;
      try {
        await invoke("desktop_input", withOwner(session.id, OWNER, session.generation, event));
      } catch (err) {
        if (sessionRef.current !== session) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));
        sessionRef.current = null;
        closeSession(session);
      }
    }).finally(() => {
      inputPendingRef.current = Math.max(0, inputPendingRef.current - 1);
    });
  }, [closeSession]);

  const sendKey = useCallback(
    (mapping: { code: number; extended: boolean }, pressed: boolean) => {
      sendInput({ kind: "key", code: mapping.code, extended: mapping.extended, pressed });
    },
    [sendInput],
  );

  const sendUnicode = useCallback(
    (text: string) => {
      if (text.length > 0) sendInput({ kind: "unicode", text });
    },
    [sendInput],
  );

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (compositionRef.current || event.nativeEvent.isComposing || event.keyCode === 229) {
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" && Date.now() - compositionEndedAtRef.current < 80) {
      event.preventDefault();
      return;
    }
    const mapping = mapScancode(event.code);
    const modified = event.ctrlKey || event.altKey || event.metaKey;
    if (mapping && (modified || event.key.length !== 1)) {
      pressedKeysRef.current.add(event.code);
      sendKey(mapping, true);
      event.preventDefault();
      return;
    }
    if (event.key.length === 1 && !modified) {
      sendUnicode(event.key);
      event.preventDefault();
      return;
    }
    if (mapping) {
      pressedKeysRef.current.add(event.code);
      sendKey(mapping, true);
      event.preventDefault();
    }
  }, [sendKey, sendUnicode]);

  const handleKeyUp = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (compositionRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const mapping = mapScancode(event.code);
    if (mapping && pressedKeysRef.current.delete(event.code)) {
      sendKey(mapping, false);
      event.preventDefault();
    }
  }, [sendKey]);

  const sendMouse = useCallback(
    (
      clientX: number,
      clientY: number,
      button: number,
      down: boolean,
      element: HTMLCanvasElement,
    ) => {
      const remote = remoteSizeRef.current;
      if (remote.width === 0 || remote.height === 0) return;
      const rect = element.getBoundingClientRect();
      const x = Math.max(
        0,
        Math.min(
          remote.width - 1,
          Math.round(((clientX - rect.left) / rect.width) * remote.width),
        ),
      );
      const y = Math.max(
        0,
        Math.min(
          remote.height - 1,
          Math.round(((clientY - rect.top) / rect.height) * remote.height),
        ),
      );
      lastPointerRef.current = { x, y };
      sendInput({ kind: "mouse", x, y, button, down });
    },
    [sendInput],
  );

  const sendWheel = useCallback(
    (
      clientX: number,
      clientY: number,
      delta: number,
      deltaMode: number,
      horizontal: boolean,
      element: HTMLCanvasElement,
    ) => {
      const remote = remoteSizeRef.current;
      if (remote.width === 0 || remote.height === 0) return;
      const rect = element.getBoundingClientRect();
      const x = Math.round(((clientX - rect.left) / rect.width) * remote.width);
      const y = Math.round(((clientY - rect.top) / rect.height) * remote.height);
      const key = horizontal ? "x" : "y";
      const step = accumulateWheel(wheelRemainderRef.current[key], delta, deltaMode);
      wheelRemainderRef.current[key] = step.remainder;
      if (step.rotation !== 0) {
        sendInput({ kind: "wheel", x, y, delta: step.rotation, horizontal });
      }
    },
    [sendInput],
  );

  const releasePointer = useCallback((pointerId: number) => {
    const buttons = pointerButtonsRef.current.get(pointerId);
    if (!buttons) return;
    const { x, y } = lastPointerRef.current;
    for (const button of buttons) {
      sendInput({ kind: "mouse", x, y, button, down: false });
    }
    pointerButtonsRef.current.delete(pointerId);
  }, [sendInput]);

  const releaseAll = useCallback(() => {
    for (const code of pressedKeysRef.current) {
      const mapping = mapScancode(code);
      if (mapping) sendKey(mapping, false);
    }
    pressedKeysRef.current.clear();
    for (const pointerId of pointerButtonsRef.current.keys()) {
      releasePointer(pointerId);
    }
  }, [releasePointer, sendKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelledRef.current = true;
      generationRef.current += 1;
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) closeSession(session);
    };
  }, [closeSession]);

  useEffect(() => {
    cancelledRef.current = !open;
    if (!open) {
      generationRef.current += 1;
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) closeSession(session);
      if (document.fullscreenElement === dialogRef.current) {
        void document.exitFullscreen().catch(() => undefined);
      }
      setIsFullscreen(false);
      setIsExpanded(false);
    }
  }, [closeSession, open]);

  const handleOpenChange = (next: boolean) => {
    if (!next) void disconnect();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        ref={dialogRef}
        showCloseButton={false}
        data-testid="remote-desktop-dialog"
        className={cn(
          "overflow-hidden",
          workspaceVisible
            ? "flex h-[min(86vh,900px)] w-[min(1180px,calc(100vw-2rem))] flex-col gap-0 p-0 sm:max-w-[1180px]"
            : "sm:max-w-[760px]",
          expanded
            ? "left-0 top-0 h-[100dvh] w-screen max-w-none translate-x-0 translate-y-0 rounded-none sm:max-w-none"
            : "",
        )}
      >
        {!workspaceVisible ? (
          <>
            <DialogHeader className="flex-row items-center gap-3 pr-4">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
                <HugeiconsIcon icon={ComputerIcon} size={22} strokeWidth={1.7} />
              </div>
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <DialogTitle className="text-lg">远程桌面</DialogTitle>
                  <span className="rounded-md border border-border/70 bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-muted-foreground">
                    RDP
                  </span>
                </div>
                <DialogDescription className="text-[12px] leading-5">
                  在 TDSF 内安全连接并操作远端图形桌面，支持比例缩放与全屏显示。
                </DialogDescription>
              </div>
            </DialogHeader>

            <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
              <div className="mb-4 flex items-center justify-between">
                <span className="text-[12px] font-medium">连接信息</span>
                <span className="flex items-center gap-1.5 text-[10px] tracking-wide text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                  STRICT TLS
                </span>
              </div>
              <div className="mb-4 flex items-center gap-1 rounded-xl border border-border/70 bg-background/60 p-1">
                {(["rdp", "vnc"] as const).map((item) => (
                  <Button
                    key={item}
                    type="button"
                    variant="ghost"
                    aria-pressed={protocol === item}
                    onClick={() => {
                      setProtocol(item);
                      setPort(item === "rdp" ? "13389" : "15900");
                    }}
                    className={cn("h-8 flex-1 rounded-lg text-[12px] uppercase", protocol === item && "bg-secondary")}
                  >
                    {item}
                  </Button>
                ))}
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-x-3 gap-y-4 text-[12px]">
                <div className="space-y-1.5">
                  <Label htmlFor="rdp-host" className="text-muted-foreground">主机</Label>
                  <Input
                    id="rdp-host"
                    value={host}
                    onChange={(event) => setHost(event.target.value)}
                    className="bg-background/80"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rdp-port" className="text-muted-foreground">端口</Label>
                  <Input
                    id="rdp-port"
                    value={port}
                    onChange={(event) => setPort(event.target.value)}
                    className="bg-background/80 font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rdp-user" className="text-muted-foreground">用户名</Label>
                  <Input
                    id="rdp-user"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    className="bg-background/80"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rdp-pass" className="text-muted-foreground">密码</Label>
                  <Input
                    id="rdp-pass"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="bg-background/80"
                  />
                </div>
                {protocol === "rdp" ? (
                  <div className="col-span-2 space-y-1.5">
                    <Label htmlFor="rdp-fp" className="text-muted-foreground">
                      证书指纹 <span className="font-normal opacity-70">（自签证书必填）</span>
                    </Label>
                    <Input
                      id="rdp-fp"
                      value={fingerprint}
                      onChange={(event) => setFingerprint(event.target.value)}
                      placeholder="SHA256：aa:bb:cc..."
                      className="bg-background/80 font-mono text-[11px]"
                    />
                    <p className="text-[11px] leading-4 text-muted-foreground">
                      仅信任匹配指纹的自签证书；机构证书继续按系统信任链校验。
                    </p>
                  </div>
                ) : (
                  <p className="col-span-2 rounded-xl border border-border/60 bg-background/50 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
                    VNC 仅连接经授权 SSH 隧道映射的回环地址，桥接不接受远程网页或任意 TCP 目标。
                  </p>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border/70 bg-muted/30 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="size-2 shrink-0 rounded-full bg-emerald-500 shadow-[0_0_0_4px_color-mix(in_oklab,var(--color-emerald-500)_12%,transparent)]" />
                <DialogHeader className="gap-0">
                  <DialogTitle className="truncate font-mono text-[13px]">
                    {host}:{port}
                  </DialogTitle>
                  <DialogDescription className="text-[11px]">
                    {protocol.toUpperCase()} · {username} · {status === "connected" ? "已连接" : "协商中"}
                  </DialogDescription>
                </DialogHeader>
              </div>
              <div className="flex items-center gap-2">
                {protocol === "rdp" ? (
                  <>
                    <div className="flex items-center rounded-lg border border-border/70 bg-background/60 p-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        aria-pressed={scaleMode === "fit"}
                        onClick={() => setScaleMode("fit")}
                        className={cn("h-7 rounded-md px-2.5 text-[11px]", scaleMode === "fit" && "bg-secondary")}
                      >
                        适应窗口
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        aria-pressed={scaleMode === "actual"}
                        onClick={() => setScaleMode("actual")}
                        className={cn("h-7 rounded-md px-2.5 text-[11px]", scaleMode === "actual" && "bg-secondary")}
                      >
                        原始尺寸
                      </Button>
                    </div>
                    <span className="w-11 text-center font-mono text-[11px] text-muted-foreground">
                      {scalePercent}%
                    </span>
                  </>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void toggleFullscreen()}
                  className="h-8 gap-1.5 px-2.5 text-[11px]"
                >
                  <HugeiconsIcon icon={expanded ? ArrowShrink01Icon : ArrowExpand01Icon} size={14} />
                  {expanded ? "退出全屏" : "全屏"}
                </Button>
              </div>
            </div>

            <div className="min-h-0 flex-1 bg-neutral-950 p-3">
              <div
                ref={viewportRef}
                data-testid="desktop-viewport"
                className="h-full w-full overflow-auto rounded-xl border border-white/10 bg-[#080b10] shadow-inner"
              >
                <div className={cn(
                  "relative flex items-center justify-center",
                  protocol === "vnc" ? "h-full w-full" : "h-max min-h-full w-max min-w-full",
                )}>
                  {protocol === "vnc" && vncUrl ? (
                    <VncDesktopView
                      sessionId={sessionRef.current?.id ?? 0}
                      url={vncUrl}
                      username={username}
                      password={password}
                      onError={handleVncError}
                    />
                  ) : (
                    <>
                  <canvas
                    ref={canvasRef}
                    tabIndex={-1}
                    aria-label="远程桌面画面"
                    style={{
                      width: displaySize.width || 640,
                      height: displaySize.height || 360,
                    }}
                    className={cn(
                      "block shrink-0 bg-black outline-none",
                      remoteSize.width === 0 && "opacity-0",
                    )}
                    onPointerDown={(event) => {
                      imeRef.current?.focus({ preventScroll: true });
                      event.currentTarget.setPointerCapture(event.pointerId);
                      const button = mapButton(event.button);
                      const buttons = pointerButtonsRef.current.get(event.pointerId) ?? new Set<number>();
                      buttons.add(button);
                      pointerButtonsRef.current.set(event.pointerId, buttons);
                      sendMouse(event.clientX, event.clientY, button, true, event.currentTarget);
                      event.preventDefault();
                    }}
                    onPointerUp={(event) => {
                      const button = mapButton(event.button);
                      sendMouse(event.clientX, event.clientY, button, false, event.currentTarget);
                      const buttons = pointerButtonsRef.current.get(event.pointerId);
                      buttons?.delete(button);
                      if (buttons?.size === 0) pointerButtonsRef.current.delete(event.pointerId);
                      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                        event.currentTarget.releasePointerCapture(event.pointerId);
                      }
                    }}
                    onPointerMove={(event) => {
                      sendMouse(event.clientX, event.clientY, 0, false, event.currentTarget);
                    }}
                    onPointerCancel={(event) => releasePointer(event.pointerId)}
                    onLostPointerCapture={(event) => releasePointer(event.pointerId)}
                    onWheel={(event) => {
                      if (event.deltaY !== 0) {
                        sendWheel(event.clientX, event.clientY, event.deltaY, event.deltaMode, false, event.currentTarget);
                      }
                      if (event.deltaX !== 0) {
                        sendWheel(event.clientX, event.clientY, event.deltaX, event.deltaMode, true, event.currentTarget);
                      }
                      event.preventDefault();
                    }}
                    onContextMenu={(event) => event.preventDefault()}
                  />
                  <textarea
                    ref={imeRef}
                    aria-label="远程桌面文本输入"
                    data-testid="desktop-ime-input"
                    tabIndex={-1}
                    defaultValue=""
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className="pointer-events-none absolute left-0 top-0 size-px resize-none border-0 p-0 opacity-0"
                    onKeyDown={handleKeyDown}
                    onKeyUp={handleKeyUp}
                    onCompositionStart={() => {
                      compositionRef.current = true;
                    }}
                    onCompositionEnd={(event) => {
                      compositionRef.current = false;
                      compositionEndedAtRef.current = Date.now();
                      sendUnicode(event.data);
                      event.currentTarget.value = "";
                    }}
                    onBlur={releaseAll}
                    onPaste={(event) => {
                      sendUnicode(event.clipboardData.getData("text"));
                      event.preventDefault();
                    }}
                  />
                  {remoteSize.width === 0 ? (
                    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
                      <HugeiconsIcon icon={Loading03Icon} size={24} className="animate-spin" />
                      <p className="text-[12px]">正在接收远端画面</p>
                      <p className="font-mono text-[10px] opacity-60">IronRDP · waiting for first frame</p>
                    </div>
                  ) : null}
                    </>
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {error ? (
          <p className="mx-4 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
            {error}
          </p>
        ) : null}

        {workspaceVisible ? (
          <DialogFooter className="shrink-0 flex-row flex-wrap items-center justify-between gap-3 border-t border-border/70 px-4 py-2.5">
            <p className="font-mono text-[10px] text-muted-foreground">
              {protocol === "vnc"
                ? "noVNC · 自适应"
                : remoteSize.width > 0
                  ? `${remoteSize.width} × ${remoteSize.height}`
                  : "等待分辨率"}
              <span className="mx-2 opacity-40">/</span>
              点击画面后键盘直达远端
            </p>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={() => void disconnect()} className="h-8 text-[11px]">
                断开
              </Button>
              <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)} className="h-8 text-[11px]">
                关闭
              </Button>
            </div>
          </DialogFooter>
        ) : (
          <DialogFooter className="flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <HugeiconsIcon icon={Shield01Icon} size={14} />
              密码仅用于本次连接，不写入本地存储
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} className="text-[12px]">
                关闭
              </Button>
              <Button
                type="button"
                onClick={() => void connect()}
                disabled={status === "connecting"}
                className="min-w-24 gap-2 text-[12px]"
              >
                {status === "connecting" ? (
                  <HugeiconsIcon icon={Loading03Icon} size={14} className="animate-spin" />
                ) : null}
                {status === "connecting" ? "连接中…" : "连接"}
              </Button>
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}