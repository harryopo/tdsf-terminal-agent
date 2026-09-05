import type { OsFamily } from "@/lib/os-family";
import { remoteOsFamilyLabel } from "./remoteOsFamilyLabel";

export type RemoteOsBadgeInfo = {
  family: OsFamily;
  prettyName: string;
};

export function RemoteOsBadge({ info }: { info: RemoteOsBadgeInfo | null }) {
  const label = info ? remoteOsFamilyLabel(info.family) : null;
  if (!label) return null;

  return (
    <span
      data-testid="remote-os-badge"
      title={info?.prettyName || `Remote os-release family: ${label}`}
      className="flex shrink-0 cursor-default items-center rounded-sm border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
    >
      {label}
    </span>
  );
}
