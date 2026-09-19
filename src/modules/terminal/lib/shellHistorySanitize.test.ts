/**
 * sanitizeShellHistory — shell 历史导入预测历史前的卫生过滤
 * -----------------------------------------------------------------------------
 * 用户 2026-09-19 反馈："有时候用户敲错命令也当成历史了"。
 * histfile 不区分成功与失败，整份导入等于把手误变成预测候选，
 * 所以在进引擎之前必须按"真实环境命令集 ∪ 字典"校验首词。
 * -----------------------------------------------------------------------------
 */
import { describe, expect, it } from "vitest";
import { sanitizeShellHistory } from "./completionInjection";

const KNOWN = new Set(["git", "ls", "systemctl", "docker", "kubectl"]);
const isKnown = (name: string) => KNOWN.has(name);

describe("sanitizeShellHistory", () => {
  it("keeps the first word of known commands (命中的命令保留首词)", () => {
    expect(
      sanitizeShellHistory(["git status -sb", "ls -la /tmp"], isKnown),
    ).toEqual(["git", "ls"]);
  });

  it("drops typos that exist in neither the dictionary nor the real environment (敲错的直接丢)", () => {
    expect(sanitizeShellHistory(["gitstaus -hb", "kpubctl get po"], isKnown)).toEqual([]);
  });

  it("strips sudo/doas before validating the real command name (先剥提权前缀再校验)", () => {
    expect(
      sanitizeShellHistory(
        ["sudo systemctl restart nginx", "sudo gitstaus"],
        isKnown,
      ),
    ).toEqual(["systemctl"]);
  });

  it("drops argument leftovers, control chars and one-letter noise (残行与控制字符)", () => {
    expect(
      sanitizeShellHistory(
        [
          "--force-with-lease", // 上一条命令的参数残行
          "/usr/bin/git commit", // 绝对路径不是命令名
          "l", // 单字符噪声
          "docker\x1b[0m ps", // 带控制字符
          "",
        ],
        isKnown,
      ),
    ).toEqual([]);
  });

  it("is a pure filter: same input twice gives the same output (纯函数、可重复)", () => {
    const lines = ["git push", "gitstaus"];
    expect(sanitizeShellHistory(lines, isKnown)).toEqual(
      sanitizeShellHistory(lines, isKnown),
    );
  });
});
