import { describe, expect, it } from "vitest";
import { commandSupportsFamily, isOsFamily } from "./os-family";

describe("Linux distribution family command filter", () => {
  it("only hides commands exclusive to another known family", () => {
    expect(commandSupportsFamily("apt", "debian")).toBe(true);
    expect(commandSupportsFamily("apt", "rhel")).toBe(false);
    expect(commandSupportsFamily("dnf", "debian")).toBe(false);
    expect(commandSupportsFamily("rpm", "suse")).toBe(true);
    expect(commandSupportsFamily("ssh", "alpine")).toBe(true);
  });

  it("fails open when the host family is unknown", () => {
    expect(commandSupportsFamily("apt", "unknown")).toBe(true);
    expect(commandSupportsFamily("dnf", "unknown")).toBe(true);
  });

  it("accepts only sidecar probe families", () => {
    expect(isOsFamily("debian")).toBe(true);
    expect(isOsFamily("unknown")).toBe(true);
    expect(isOsFamily("ubuntu")).toBe(false);
    expect(isOsFamily(null)).toBe(false);
  });
});
