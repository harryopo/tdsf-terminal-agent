// @vitest-environment node
import { createRequire } from "node:module";
import { expect, it } from "vitest";

type CompileSubnets = (
  subnets: string[],
) => (addr: string, index: number) => boolean;

const proxyAddr = createRequire(import.meta.url)("proxy-addr") as {
  compile: CompileSubnets;
};

it("does not trust unrelated IPv4 addresses for an IPv4-mapped /8", () => {
  expect(proxyAddr.compile(["::ffff:10.0.0.0/8"])("203.0.113.4", 0)).toBe(
    false,
  );
});

it("trusts IPv4 addresses inside an IPv4-mapped /104", () => {
  expect(proxyAddr.compile(["::ffff:10.0.0.0/104"])("10.20.30.40", 0)).toBe(
    true,
  );
});

it("does not trust unrelated IPv4 addresses for an IPv4-mapped /104", () => {
  expect(proxyAddr.compile(["::ffff:10.0.0.0/104"])("203.0.113.4", 0)).toBe(
    false,
  );
});
