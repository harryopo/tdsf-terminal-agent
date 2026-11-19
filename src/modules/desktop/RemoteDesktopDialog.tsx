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
import { Channel, invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { mapButton } from "./desktopInput";

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
const SCANCODES: Record<string, number> = {
  Escape: 0x01,
  Tab: 0x0f,
  Backspace: 0x0e,
  Enter: 0x1c,
  Control: 0x1d,
  Shift: 0x2a,
  Alt: 0x38,
  ArrowUp: 0x48,
  ArrowDown: 0x50,
  ArrowLeft: 0x4b,
  ArrowRight: 0x4d,
  Delete: 0x53,
  Home: 0x47,
  End: 0x4f,
  PageUp: 0x49,
  PageDown: 0x51,
};


export function RemoteDesktopDialog({ open, onOpenChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sessionRef = useRef<number | null>(null);
  const generationRef = useRef(1);
  const remoteSizeRef = useRef({ width: 0, height: 0 });
  const cancelledRef = useRef(false);

  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("13389");
  const [username, setUsername] = useState("tdsf-test");
  const [password, setPassword] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "error">(
    "idle",
  );
  const [error, setError] = useState("");

  const drawFrame = useCallback((frame: DesktopFrame) => {
    const canvas = canvasRef.current;
    if (!canvas || cancelledRef.current) return;
    if (frame.session_id !== sessionRef.current) return;
    if (canvas.width !== frame.width || canvas.height !== frame.height) {
      canvas.width = frame.width;
      canvas.height = frame.height;
    }
    remoteSizeRef.current = { width: frame.width, height: frame.height };
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

  const pollStatus = useCallback(async (id: number, generation: number) => {
    const started = Date.now();
    while (!cancelledRef.current && sessionRef.current === id && generationRef.current === generation) {
      try {
        const info = await invoke<SessionStatusInfo>("desktop_status", {
          sessionId: id,
          owner: OWNER,
          generation,
        });
        if (info.status === "connected") {
          setStatus("connected");
          return;
        }
        if (info.status === "failed" || info.status === "closed") {
          setStatus("error");
          setError(info.error ?? "连接已关闭");
          sessionRef.current = null;
          return;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
      if (Date.now() - started > 60_000) {
        setStatus("error");
        setError("连接超时（60s）");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }, []);

  const disconnect = useCallback(async () => {
    const id = sessionRef.current;
    const generation = generationRef.current;
    sessionRef.current = null;
    if (id !== null) {
      try {
        await invoke("desktop_close", { sessionId: id, owner: OWNER, generation });
      } catch {
        // 会话可能已结束
      }
    }
    setStatus("idle");
  }, []);

  const connect = useCallback(async () => {
    setError("");
    setStatus("connecting");
    cancelledRef.current = false;
    const generation = ++generationRef.current;
    try {
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
      sessionRef.current = id;
      void pollStatus(id, generation);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [host, port, username, password, fingerprint, drawFrame, pollStatus]);

  const sendInput = useCallback((event: Record<string, unknown>) => {
    const id = sessionRef.current;
    if (id === null) return;
    void invoke("desktop_input", {
      sessionId: id,
      owner: OWNER,
      generation: generationRef.current,
      event,
    }).catch(() => {});
  }, []);

  const sendKey = useCallback(
    (code: number, pressed: boolean) => {
      sendInput({ kind: "key", code, pressed });
    },
    [sendInput],
  );

  const sendUnicode = useCallback(
    (text: string) => {
      if (text.length > 0) sendInput({ kind: "unicode", text });
    },
    [sendInput],
  );

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
      sendInput({ kind: "mouse", x, y, button, down });
    },
    [sendInput],
  );

  const sendWheel = useCallback(
    (clientX: number, clientY: number, delta: number, element: HTMLCanvasElement) => {
      const remote = remoteSizeRef.current;
      if (remote.width === 0 || remote.height === 0) return;
      const rect = element.getBoundingClientRect();
      const x = Math.round(((clientX - rect.left) / rect.width) * remote.width);
      const y = Math.round(((clientY - rect.top) / rect.height) * remote.height);
      sendInput({ kind: "wheel", x, y, delta });
    },
    [sendInput],
  );

  const releaseAll = useCallback(() => {
    for (const code of [SCANCODES.Control, SCANCODES.Shift, SCANCODES.Alt]) {
      sendKey(code, false);
    }
    for (const button of [1, 2, 3]) {
      sendInput({ kind: "mouse", x: 0, y: 0, button, down: false });
    }
  }, [sendInput, sendKey]);

  useEffect(() => {
    cancelledRef.current = !open;
    if (!open) {
      const id = sessionRef.current;
      sessionRef.current = null;
      if (id !== null) {
        void invoke("desktop_close", {
          sessionId: id,
          owner: OWNER,
          generation: generationRef.current,
        }).catch(() => {});
      }
    }
  }, [open]);

  const handleOpenChange = (next: boolean) => {
    if (!next) void disconnect();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[1100px]">
        <DialogHeader>
          <DialogTitle>远程桌面（RDP）</DialogTitle>
          <DialogDescription>
            通过 IronRDP 连接到远端 RDP 服务。画面仅在当前应用内渲染，密码不落盘；证书默认严格校验，可填自签指纹。
          </DialogDescription>
        </DialogHeader>

        {status !== "connected" ? (
          <div className="grid grid-cols-[1fr_120px] gap-3 text-[12px]">
            <div className="space-y-1">
              <Label htmlFor="rdp-host">主机</Label>
              <Input id="rdp-host" value={host} onChange={(e) => setHost(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rdp-port">端口</Label>
              <Input id="rdp-port" value={port} onChange={(e) => setPort(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rdp-user">用户名</Label>
              <Input id="rdp-user" value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rdp-pass">密码</Label>
              <Input
                id="rdp-pass"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="col-span-2 space-y-1">
              <Label htmlFor="rdp-fp">证书指纹（可选，自签 SHA256 hex）</Label>
              <Input
                id="rdp-fp"
                value={fingerprint}
                onChange={(e) => setFingerprint(e.target.value)}
                placeholder="aa:bb:cc..."
              />
            </div>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border/60 bg-black">
            <canvas
              ref={canvasRef}
              tabIndex={0}
              className="mx-auto block max-h-[70vh] max-w-full outline-none"
              onKeyDown={(event) => {
                if (event.key.length === 1) {
                  sendUnicode(event.key);
                  event.preventDefault();
                  return;
                }
                const code = SCANCODES[event.key];
                if (code !== undefined) {
                  sendKey(code, true);
                  event.preventDefault();
                }
              }}
              onKeyUp={(event) => {
                const code = SCANCODES[event.key];
                if (code !== undefined) sendKey(code, false);
              }}
              onBlur={releaseAll}
              onMouseDown={(event) => {
                canvasRef.current?.focus();
                event.currentTarget.setPointerCapture(1);
                sendMouse(
                  event.clientX,
                  event.clientY,
                  mapButton(event.button),
                  true,
                  event.currentTarget,
                );
              }}
              onMouseUp={(event) => {
                event.currentTarget.releasePointerCapture(1);
                sendMouse(
                  event.clientX,
                  event.clientY,
                  mapButton(event.button),
                  false,
                  event.currentTarget,
                );
              }}
              onMouseMove={(event) => {
                const button = event.buttons === 0 ? 0 : mapButton(event.button);
                sendMouse(
                  event.clientX,
                  event.clientY,
                  button,
                  event.buttons !== 0,
                  event.currentTarget,
                );
              }}
              onWheel={(event) => {
                sendWheel(event.clientX, event.clientY, event.deltaY, event.currentTarget);
                event.preventDefault();
              }}
            />
          </div>
        )}

        {error ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          {status === "connected" ? (
            <Button type="button" variant="outline" onClick={() => void disconnect()} className="text-[12px]">
              断开
            </Button>
          ) : (
            <Button type="button" onClick={() => void connect()} disabled={status === "connecting"} className="text-[12px]">
              {status === "connecting" ? "连接中…" : "连接"}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} className="text-[12px]">
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}