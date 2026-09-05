import { describe, expect, it } from "vitest";
import { remoteOsFamilyLabel } from "./RemoteOsBadge";

describe("remoteOsFamilyLabel", () => {
  it("renders concise labels for machine-readable known families", () => {
    expect(remoteOsFamilyLabel("rhel")).toBe("RHEL");
    expect(remoteOsFamilyLabel("debian")).toBe("Debian");
    expect(remoteOsFamilyLabel("arch")).toBe("Arch");
    expect(remoteOsFamilyLabel("suse")).toBe("SUSE");
    expect(remoteOsFamilyLabel("alpine")).toBe("Alpine");
  });

  it("does not render an identification badge for unknown", () => {
    expect(remoteOsFamilyLabel("unknown")).toBeNull();
  });
});
