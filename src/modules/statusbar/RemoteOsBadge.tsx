import type { OsFamily } from "@/lib/os-family";

export type RemoteOsBadgeInfo = {
  family: OsFamily;
  prettyName: string;
};

export function remoteOsFamilyLabel(family: OsFamily): string | null {
  switch (family) {
    case "rhel":
      return "RHEL";
    case "debian":
      return "Debian";
    case "arch":
      return "Arch";
    case "suse":
      return "SUSE";
    case "alpine":
      return "Alpine";
    case "unknown":
      return null;
  }
}

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
