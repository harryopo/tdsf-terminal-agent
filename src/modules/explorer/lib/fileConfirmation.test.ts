/**
 * fileConfirmation.test.ts —— #166 ③ 的文案半边
 * -----------------------------------------------------------------------------
 * 删除确认最有价值的一句不是"确定吗"，而是**后果说对了没有**。
 * 判据对着实现写：本地 `fs_delete` 走 `std::fs::remove_file` / `remove_dir_all`，
 * 远端走 `fsb_delete`，两边都不进回收站；目录还会带走里面的内容。
 * 两句互为配对：只抬不降会把"删一个文件"说成"删一整棵树"，那是在吓唬人。
 */
import { describe, expect, it } from "vitest";

import { fileConfirmation } from "./fileConfirmation";

describe("fileConfirmation — 后果要说对", () => {
  it("文件夹：说清内容一并删除、不可恢复", () => {
    const c = fileConfirmation({ path: "/proj/src", name: "src", isDir: true });
    expect(c.subject).toBe("这个文件夹");
    expect(c.impact).toContain("一并删除");
    expect(c.impact).toContain("不进回收站");
  });

  it("文件：不许带上'内容一并删除'那句（删一个文件要说成删一棵树就是假事实）", () => {
    const c = fileConfirmation({
      path: "/proj/a.txt",
      name: "a.txt",
      isDir: false,
    });
    expect(c.subject).toBe("这个文件");
    expect(c.impact).not.toContain("一并删除");
    expect(c.impact).toContain("无法恢复");
  });

  it("路径进事实行 —— 树里同名文件靠它分辨，名字本身可能重复", () => {
    const c = fileConfirmation({
      path: "/proj/nested/deep/a.txt",
      name: "a.txt",
      isDir: false,
    });
    expect(c.facts).toEqual([{ label: "路径", value: "/proj/nested/deep/a.txt" }]);
    // 标题用短名，长路径不挤进标题（同 #111 那条"文本不许撑破弹窗"的口径）
    expect(c.name).toBe("a.txt");
  });
});
