import { USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  Copy01Icon,
  MinusSignIcon,
  SquareIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

type Props = {
  /** Render only the close button (used by the settings window). */
  closeOnly?: boolean;
};

export function WindowControls({ closeOnly = false }: Props) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!USE_CUSTOM_WINDOW_CONTROLS || closeOnly) return;
    // TDSF 魔改: dev 模式 (无 Tauri 运行时) 跳过 isMaximized / onResized
    if (!isTauriRuntime()) return;
    const w = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void w.isMaximized().then(setMaximized);
    void w
      .onResized(() => {
        void w.isMaximized().then(setMaximized);
      })
      .then((un) => {
        unlisten = un;
      });
    return () => unlisten?.();
  }, [closeOnly]);

  if (!USE_CUSTOM_WINDOW_CONTROLS) return null;

  // TDSF 魔改: dev 模式占位 (按钮渲染但 click noop, 避免 getCurrentWindow 在 onClick 时抛错)
  const tauriOk = isTauriRuntime();
  const w = tauriOk ? getCurrentWindow() : null;
  const noop = () => {
    if (typeof console !== "undefined") {
      console.debug("[WindowControls] dev mode, action skipped");
    }
  };

  return (
    <div className="flex h-full shrink-0 items-center gap-0.5 pr-1">
      {!closeOnly && (
        <>
          <CtlButton
            ariaLabel="Minimize"
            onClick={() => (w ? void w.minimize() : noop())}
          >
            <HugeiconsIcon icon={MinusSignIcon} size={12} strokeWidth={2} />
          </CtlButton>
          <CtlButton
            ariaLabel={maximized ? "Restore" : "Maximize"}
            onClick={() => (w ? void w.toggleMaximize() : noop())}
          >
            <HugeiconsIcon
              icon={maximized ? Copy01Icon : SquareIcon}
              size={12}
              strokeWidth={2}
            />
          </CtlButton>
        </>
      )}
      <CtlButton
        ariaLabel="Close"
        onClick={() => (w ? void w.close() : noop())}
        danger
      >
        <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={2} />
      </CtlButton>
    </div>
  );
}

function CtlButton({
  ariaLabel,
  onClick,
  children,
  danger,
}: {
  ariaLabel: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      className={cn(
        "grid size-7 place-items-center rounded-md text-muted-foreground transition-colors",
        danger
          ? "hover:bg-destructive/15 hover:text-destructive"
          : "hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
