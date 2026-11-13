import { cn } from "@/lib/utils";
import { useState } from "react";

type Props = {
  time: string;
  label: string;
  source?: string;
  text: string;
  detail?: string;
  critical?: boolean;
};

/** Shared presentation only: journal events and runtime logs keep distinct sources. */
export function LogRecord({
  time,
  label,
  source,
  text,
  detail,
  critical,
}: Props) {
  const [open, setOpen] = useState(false);
  const expandable = text.length > 180 || !!detail;
  const heading = (
    <>
      <time className="w-[8ch] shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
        {time}
      </time>
      <span
        className={cn(
          "w-20 shrink-0 text-[11px] font-medium",
          critical ? "text-destructive" : "text-foreground",
        )}
      >
        {label}
      </span>
      <span className="min-w-0 flex-1">
        {source && (
          <span className="mb-1 block truncate font-mono text-[10px] text-muted-foreground">
            {source}
          </span>
        )}
        <span className="block whitespace-pre-wrap break-words text-[12px] leading-relaxed text-foreground/85">
          {text.length > 180 ? `${text.slice(0, 180)}…` : text || "（空）"}
        </span>
      </span>
    </>
  );
  const rowClass = "flex gap-3 py-3 pr-3 pl-4";
  return (
    <div
      data-log-record
      className="relative border-l border-border border-b border-b-border/50 last:border-b-0"
    >
      <span
        aria-hidden
        className={cn(
          "absolute -left-[3px] top-4 size-[5px] rounded-full",
          critical ? "bg-destructive" : "bg-muted-foreground/60",
        )}
      />
      {expandable ? (
        <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary
            className={cn(
              rowClass,
              "cursor-pointer list-none rounded-md hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden",
            )}
          >
            {heading}
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {open ? "收起" : "详情"}
            </span>
          </summary>
          {open && (
            <div className="mx-4 mb-3 space-y-3 rounded-lg border border-border/60 bg-muted/20 p-3 select-text">
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
                {text || "（空）"}
              </pre>
              {detail && (
                <pre className="border-t border-border/60 pt-3 whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-muted-foreground">
                  {detail}
                </pre>
              )}
            </div>
          )}
        </details>
      ) : (
        <div className={rowClass}>{heading}</div>
      )}
    </div>
  );
}
