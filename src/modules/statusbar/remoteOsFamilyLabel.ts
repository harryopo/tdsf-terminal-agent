import type { OsFamily } from "@/lib/os-family";

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
