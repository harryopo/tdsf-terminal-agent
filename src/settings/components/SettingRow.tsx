import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type Props = {
  title: ReactNode;
  description?: string;
  children: React.ReactNode;
  className?: string;
};

export function SettingRow({ title, description, children, className }: Props) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 max-sm:basis-full">
        <span className="text-[12.5px] font-medium">{title}</span>
        {description ? (
          <span className="text-[10.5px] leading-relaxed text-muted-foreground">
            {description}
          </span>
        ) : null}
      </div>
      <div className="flex max-w-full shrink-0 items-center [&>*]:max-w-full">
        {children}
      </div>
    </div>
  );
}
