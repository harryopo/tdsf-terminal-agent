import { Button } from "@/components/ui/button";
import RFB from "@novnc/novnc";
import { useCallback, useEffect, useRef, useState } from "react";
import { unicodeKeysym, type VncKey, vncKeyForKeyboardEvent } from "./vnc-input";

interface Props {
  sessionId: number;
  url: string;
  username: string;
  password: string;
  onError: (message: string) => void;
}

export function VncDesktopView({ sessionId, url, username, password, onError }: Props) {
  const screenRef = useRef<HTMLDivElement | null>(null);
  const keyboardRef = useRef<HTMLTextAreaElement | null>(null);
  const rfbRef = useRef<RFB | null>(null);
  const readyRef = useRef(false);
  const pressedKeysRef = useRef(new Map<string, VncKey>());
  const composingRef = useRef(false);
  const skipTextInputRef = useRef(false);
  const skipTextResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const [ready, setReady] = useState(false);
  const [compositionPreview, setCompositionPreview] = useState<string | null>(null);

  const clearComposition = useCallback(() => {
    composingRef.current = false;
    skipTextInputRef.current = false;
    if (skipTextResetTimerRef.current !== null) {
      clearTimeout(skipTextResetTimerRef.current);
      skipTextResetTimerRef.current = null;
    }
    if (keyboardRef.current) keyboardRef.current.value = "";
    setCompositionPreview(null);
  }, []);

  const releaseKeys = useCallback(() => {
    for (const key of pressedKeysRef.current.values()) {
      rfbRef.current?.sendKey(key.keysym, key.code, false);
    }
    pressedKeysRef.current.clear();
    clearComposition();
  }, [clearComposition]);

  const sendText = useCallback((text: string) => {
    if (!readyRef.current) return;
    for (const character of text) {
      const keysym = unicodeKeysym(character);
      if (keysym !== null) rfbRef.current?.sendKey(keysym, undefined);
    }
  }, []);

  useEffect(() => {
    const target = screenRef.current;
    if (!target) return;
    let disposed = false;
    let failureReported = false;
    const reportFailure = (message: string) => {
      if (disposed || failureReported) return;
      failureReported = true;
      readyRef.current = false;
      onErrorRef.current(message);
    };
    const rfb = new RFB(target, url, {
      credentials: { username, password },
      wsProtocols: ["binary"],
    });
    rfb.scaleViewport = true;
    rfb.focusOnClick = true;
    rfbRef.current = rfb;

    const handleConnect = () => {
      if (disposed) return;
      failureReported = false;
      readyRef.current = true;
      setReady(true);
      keyboardRef.current?.focus({ preventScroll: true });
    };
    const handleDisconnect = (event: CustomEvent) => {
      readyRef.current = false;
      const detail = event.detail as { reason?: string } | undefined;
      reportFailure(detail?.reason ? `VNC 已断开：${detail.reason}` : "VNC 会话已断开");
    };
    const handleSecurityFailure = (event: CustomEvent) => {
      const detail = event.detail as { reason?: string } | undefined;
      reportFailure(detail?.reason ? `VNC 安全协商失败：${detail.reason}` : "VNC 安全协商失败");
    };
    rfb.addEventListener("connect", handleConnect);
    rfb.addEventListener("disconnect", handleDisconnect);
    rfb.addEventListener("securityfailure", handleSecurityFailure);

    return () => {
      disposed = true;
      releaseKeys();
      rfb.removeEventListener("connect", handleConnect);
      rfb.removeEventListener("disconnect", handleDisconnect);
      rfb.removeEventListener("securityfailure", handleSecurityFailure);
      rfb.disconnect();
      rfbRef.current = null;
      readyRef.current = false;
    };
  }, [releaseKeys, sessionId, url, username, password]);

  return (
    <div className="relative h-full w-full" data-testid="vnc-desktop">
      <div
        ref={screenRef}
        className="h-full w-full"
        aria-label="VNC 远程桌面画面"
        onMouseDown={() => keyboardRef.current?.focus({ preventScroll: true })}
      />
      <textarea
        ref={keyboardRef}
        aria-label="VNC 键盘输入"
        disabled={!ready}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="pointer-events-none absolute bottom-1 left-1 h-px w-px resize-none opacity-0"
        onCompositionStart={(event) => {
          if (skipTextResetTimerRef.current !== null) {
            clearTimeout(skipTextResetTimerRef.current);
            skipTextResetTimerRef.current = null;
          }
          composingRef.current = true;
          skipTextInputRef.current = false;
          event.currentTarget.value = "";
          setCompositionPreview("");
        }}
        onCompositionUpdate={(event) => setCompositionPreview(event.data)}
        onCompositionEnd={(event) => {
          const shouldCommit = composingRef.current;
          const text = event.data;
          clearComposition();
          if (!shouldCommit) return;
          skipTextInputRef.current = true;
          skipTextResetTimerRef.current = setTimeout(() => {
            skipTextInputRef.current = false;
            skipTextResetTimerRef.current = null;
          }, 0);
          if (text) sendText(text);
        }}
        onInput={(event) => {
          const native = event.nativeEvent as InputEvent;
          if (composingRef.current || native.isComposing || native.inputType.includes("Composition")) return;
          if (skipTextInputRef.current) {
            event.currentTarget.value = "";
            return;
          }
          if ((native.inputType === "insertText" || native.inputType === "insertFromPaste") && native.data) {
            event.currentTarget.value = "";
            sendText(native.data);
          }
        }}
        onKeyDown={(event) => {
          const composing = composingRef.current || event.nativeEvent.isComposing || event.key === "Process" || event.keyCode === 229;
          const mapping = vncKeyForKeyboardEvent(event.nativeEvent, composing);
          if (!mapping || !readyRef.current) return;
          event.preventDefault();
          pressedKeysRef.current.set(event.code, mapping);
          rfbRef.current?.sendKey(mapping.keysym, mapping.code, true);
        }}
        onKeyUp={(event) => {
          const mapping = pressedKeysRef.current.get(event.code);
          if (!mapping) return;
          event.preventDefault();
          pressedKeysRef.current.delete(event.code);
          rfbRef.current?.sendKey(mapping.keysym, mapping.code, false);
        }}
        onBlur={releaseKeys}
      />
      {!ready ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-muted-foreground">
          VNC 协议协商中…
        </div>
      ) : null}
      {compositionPreview !== null ? (
        <div className="pointer-events-none absolute bottom-2 left-1/2 max-w-[80%] -translate-x-1/2 rounded bg-background/90 px-2 py-1 text-[12px] text-foreground shadow">
          {compositionPreview || "IME 组合中…"}
        </div>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!ready}
        onClick={() => rfbRef.current?.sendCtrlAltDel()}
        className="absolute bottom-3 right-3 h-8 text-[11px] opacity-80 hover:opacity-100"
      >
        Ctrl+Alt+Del
      </Button>
    </div>
  );
}