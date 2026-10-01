import { expect, it } from "vitest";
import { getToolResultStatus, legacyToolResultStatus, toolResultLabel } from "./tool-result";

it.each([null, undefined, "error", [], { status: "success", exit_code: 3 }, { status: "new-status" }])(
  "does not infer a business failure from %j",
  (result) => expect(getToolResultStatus(result)).toBeNull(),
);

it.each([{ ok: false }, { success: false }, { status: "success", ok: false }])(
  "retains explicit failure flags in %j",
  (result) => expect(getToolResultStatus(result)).toBe("failed"),
);

it("the reported unknown status is not reclassified by an outer failure flag", () => {
  expect(getToolResultStatus({ status: "indeterminate", ok: false })).toBe("indeterminate");
  expect(toolResultLabel("indeterminate")).toBe("结果未确认");
});

it.each(["boom", "[transport] boom", "details [indeterminate] boom"])(
  "does not guess a legacy business status from %s",
  (text) => expect(legacyToolResultStatus(text)).toBeNull(),
);

it("only recognizes the explicit legacy prefix without changing the stored text", () => {
  const text = "[rejected] 用户拒绝执行";
  expect(legacyToolResultStatus(text)).toBe("rejected");
  expect(toolResultLabel("rejected")).toBe("已拒绝");
  expect(text).toBe("[rejected] 用户拒绝执行");
});
