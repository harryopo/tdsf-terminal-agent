/** Known Linux distribution families returned by the sidecar environment probe. */
export const OS_FAMILIES = [
  "rhel",
  "debian",
  "arch",
  "suse",
  "alpine",
  "unknown",
] as const;

export type OsFamily = (typeof OS_FAMILIES)[number];

const FAMILY_COMMANDS: Readonly<Record<string, readonly OsFamily[]>> = {
  "apt": ["debian"],
  "apt-cache": ["debian"],
  "apt-get": ["debian"],
  "aptitude": ["debian"],
  "dpkg": ["debian"],
  "dpkg-query": ["debian"],
  "netplan": ["debian"],
  "ufw": ["debian"],
  "dnf": ["rhel"],
  "firewall-cmd": ["rhel"],
  "subscription-manager": ["rhel"],
  "yum": ["rhel"],
  "apk": ["alpine"],
  "pacman": ["arch"],
  "zypper": ["suse"],
};

export function isOsFamily(value: unknown): value is OsFamily {
  return typeof value === "string" && (OS_FAMILIES as readonly string[]).includes(value);
}

/**
 * Only hide a static suggestion when the host family is known and the command
 * is exclusive to a different family. Unclassified commands remain visible.
 */
export function commandSupportsFamily(command: string, family: OsFamily): boolean {
  if (family === "unknown") return true;
  const supportedFamilies = FAMILY_COMMANDS[command.toLowerCase()];
  return !supportedFamilies || supportedFamilies.includes(family);
}
