// 远程桌面（RDP）对话框：IronRDP 帧经 Tauri 事件推到 Canvas。
//
// 产品内最小闭环：
// - 表单建立会话（host/port/user/password，密码仅内存）
// - `desktop-frame` 事件（RGBA base64）绘制到 Canvas
// - 键盘/鼠标经 `desktop_input` 转发
// - 关闭时 `desktop_close`
//
// 已知限制（后续迭代）：中文 IME、缩放/全屏、断线恢复、剪贴板、音频。
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
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

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

interface DesktopError {
  session_id: number;
  message: string;
}

/** 常用键的 RDP scancode（US 布局，非扩展）。 */
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
  const remoteSizeRef = useRef({ width: 0, height: 0 });

  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("13389");
  const [username, setUsername] = useState("tdsf-test");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "error">(
    "idle",
  );
  const [error, setError] = useState("");

  const drawFrame = useCallback((frame: DesktopFrame) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
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

  useEffect(() => {
    if (!open) return;
    let unlistenFrame: UnlistenFn | undefined;
    let unlistenError: UnlistenFn | undefined;
    void (async () => {
      unlistenFrame = await listen<DesktopFrame>("desktop-frame", (event) => {
        if (event.payload.session_id === sessionRef.current) {
          drawFrame(event.payload);
        }
      });
      unlistenError = await listen<DesktopError>("desktop-error", (event) => {
        if (event.payload.session_id === sessionRef.current) {
          setStatus("error");
          setError(event.payload.message);
        }
      });
    })();
    return () => {
      unlistenFrame?.();
      unlistenError?.();
    };
  }, [open, drawFrame]);

  const disconnect = useCallback(async () => {
    const id = sessionRef.current;
    sessionRef.current = null;
    if (id !== null) {
      try {
        await invoke("desktop_close", { sessionId: id });
      } catch {
        // 会话可能已结束
      }
    }
    setStatus("idle");
  }, []);

  const connect = useCallback(async () => {
    setStatus("connecting");
    setError("");
    try {
      const id = await invoke<number>("desktop_connect", {
        params: {
          host,
          port: Number(port),
          username,
          password,
        },
      });
      sessionRef.current = id;
      setStatus("connected");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [host, port, username, password]);

  const sendKey = useCallback((code: number, pressed: boolean) => {
    const id = sessionRef.current;
    if (id === null) return;
    void invoke("desktop_input", {
      sessionId: id,
      event: { kind: "key", code, pressed },
    }).catch(() => {});
  }, []);

  const sendUnicode = useCallback((text: string) => {
    const id = sessionRef.current;
    if (id === null || text.length === 0) return;
    void invoke("desktop_input", {
      sessionId: id,
      event: { kind: "unicode", text },
    }).catch(() => {});
  }, []);

  const sendMouse = useCallback(
    (
      clientX: number,
      clientY: number,
      buttons: number,
      down: boolean,
      element: HTMLCanvasElement,
    ) => {
      const id = sessionRef.current;
      const remote = remoteSizeRef.current;
      if (id === null || remote.width === 0 || remote.height === 0) return;
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
      void invoke("desktop_input", {
        sessionId: id,
        event: { kind: "mouse", x, y, buttons, down },
      }).catch(() => {});
    },
    [],
  );

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      void disconnect();
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[1100px]">
        <DialogHeader>
          <DialogTitle>远程桌面（RDP）</DialogTitle>
          <DialogDescription>
            通过 IronRDP 连接到远端 RDP 服务。画面仅在当前应用内渲染，密码不落盘。
          </DialogDescription>
        </DialogHeader>

        {status !== "connected" ? (
          <div className="grid grid-cols-[1fr_120px] gap-3 text-[12px]">
            <div className="space-y-1">
              <Label htmlFor="rdp-host">主机</Label>
              <Input
                id="rdp-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="127.0.0.1"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rdp-port">端口</Label>
              <Input
                id="rdp-port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="13389"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rdp-user">用户名</Label>
              <Input
                id="rdp-user"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
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
                if (code !== undefined) {
                  sendKey(code, false);
                }
              }}
              onMouseDown={(event) => {
                canvasRef.current?.focus();
                const buttons =
                  (event.buttons & 1 ? 1 : 0) |
                  (event.buttons & 2 ? 2 : 0) |
                  (event.buttons & 4 ? 4 : 0);
                sendMouse(event.clientX, event.clientY, buttons, true, event.currentTarget);
              }}
              onMouseUp={(event) => {
                const buttons =
                  (event.buttons & 1 ? 1 : 0) |
                  (event.buttons & 2 ? 2 : 0) |
                  (event.buttons & 4 ? 4 : 0);
                sendMouse(event.clientX, event.clientY, buttons, false, event.currentTarget);
              }}
              onMouseMove={(event) => {
                if (event.buttons === 0) return;
                const buttons =
                  (event.buttons & 1 ? 1 : 0) |
                  (event.buttons & 2 ? 2 : 0) |
                  (event.buttons & 4 ? 4 : 0);
                sendMouse(event.clientX, event.clientY, buttons, true, event.currentTarget);
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
            <Button
              type="button"
              variant="outline"
              onClick={() => void disconnect()}
              className="text-[12px]"
            >
              断开
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => void connect()}
              disabled={status === "connecting"}
              className="text-[12px]"
            >
              {status === "connecting" ? "连接中…" : "连接"}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="text-[12px]"
          >
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}