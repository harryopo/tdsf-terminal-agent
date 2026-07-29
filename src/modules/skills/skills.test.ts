// TDSF 魔改 (P4-T4.4): Skill 系统单元测试
// -----------------------------------------------------------------------------
// 覆盖:
//   1. registry.inferCategory — tags → category 推断（5 个分支）
//   2. registry.dictToMetadata — SkillDict → SkillMetadata 转换（snake→camel）
//   3. registry.getBuiltinSkills — 5 个 builtin skill 完整性
//   4. registry.readEnabledState / writeEnabledState — localStorage 持久化
//   5. skillsStore.filterSkills — 按 tab + 搜索关键词筛选
//   6. skillCommand.parseSkillCommand — /skill:<name> <args> 解析
//
// 测试环境: vitest node 环境；通过 vi.stubGlobal 注入 window.localStorage mock

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dictToMetadata,
  getBuiltinSkills,
  inferCategory,
  readEnabledState,
  writeEnabledState,
} from "./registry";
import { parseSkillCommand } from "./skillCommand";
import { filterSkills } from "./skillsStore";
import type { SkillDict, SkillMetadata } from "./types";

// === localStorage mock =====================================================
// registry.ts 通过 window.localStorage 读写启用状态；
// node 环境下 window 不存在，用 Map 模拟一份。

const storage = new Map<string, string>();
const localStorageMock: Storage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => {
    storage.set(k, v);
  },
  removeItem: (k: string) => {
    storage.delete(k);
  },
  clear: () => {
    storage.clear();
  },
  key: (i: number) => Array.from(storage.keys())[i] ?? null,
  get length() {
    return storage.size;
  },
};

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("window", { localStorage: localStorageMock });
});

// ============================================================================
// inferCategory — tags → category 推断
// ============================================================================

describe("inferCategory", () => {
  it("tags 含 'docker' → docker", () => {
    expect(inferCategory(["docker", "container"])).toBe("docker");
  });

  it("tags 含 'container' → docker", () => {
    expect(inferCategory(["container", "devops"])).toBe("docker");
  });

  it("tags 含 'ssh' → ssh（即使含 docker 也优先 docker）", () => {
    // 优先级：docker > ssh > python > linux > custom
    expect(inferCategory(["ssh", "docker"])).toBe("docker");
    expect(inferCategory(["ssh", "network"])).toBe("ssh");
  });

  it("tags 含 'python' → python", () => {
    expect(inferCategory(["python", "debug"])).toBe("python");
  });

  it("tags 含 linux 关键词 → linux", () => {
    expect(inferCategory(["linux"])).toBe("linux");
    expect(inferCategory(["selinux", "security"])).toBe("linux");
    expect(inferCategory(["nginx", "systemd"])).toBe("linux");
    expect(inferCategory(["journalctl", "iptables"])).toBe("linux");
    expect(inferCategory(["ops"])).toBe("linux");
  });

  it("tags 大小写不敏感（'Docker' → docker）", () => {
    expect(inferCategory(["Docker", "Compose"])).toBe("docker");
    expect(inferCategory(["SSH"])).toBe("ssh");
    expect(inferCategory(["PYTHON"])).toBe("python");
  });

  it("tags 无匹配 → custom", () => {
    expect(inferCategory(["unknown", "random"])).toBe("custom");
    expect(inferCategory([])).toBe("custom");
  });
});

// ============================================================================
// dictToMetadata — SkillDict → SkillMetadata 转换
// ============================================================================

describe("dictToMetadata", () => {
  const baseDict: SkillDict = {
    name: "docker-management",
    description: "Docker 管理 Skill",
    version: "1.2.0",
    author: "TDSF",
    tags: ["docker", "container"],
    when_to_use: "用户请求处理 docker 容器问题",
    steps: "1. docker ps\n2. docker logs",
    examples: "示例 1：容器启动失败\n\n示例 2：清理镜像",
    body: "# Docker 管理 Skill\n## Steps\n...",
    file_path: "/skills/builtin/docker-management/SKILL.md",
  };

  it("snake_case 字段 → camelCase 字段", () => {
    const meta = dictToMetadata(baseDict);
    expect(meta.name).toBe("docker-management");
    expect(meta.description).toBe("Docker 管理 Skill");
    expect(meta.version).toBe("1.2.0");
    expect(meta.author).toBe("TDSF");
    expect(meta.tags).toEqual(["docker", "container"]);
    expect(meta.whenToUse).toBe("用户请求处理 docker 容器问题");
  });

  it("category 由 tags 推断", () => {
    expect(dictToMetadata(baseDict).category).toBe("docker");
    expect(
      dictToMetadata({ ...baseDict, tags: ["ssh", "network"] }).category,
    ).toBe("ssh");
    expect(
      dictToMetadata({ ...baseDict, tags: ["python", "debug"] }).category,
    ).toBe("python");
    expect(dictToMetadata({ ...baseDict, tags: ["unknown"] }).category).toBe(
      "custom",
    );
  });

  it("file_path 非空 → source = builtin", () => {
    expect(dictToMetadata(baseDict).source).toBe("builtin");
  });

  it("file_path 为 null → source = installed", () => {
    const meta = dictToMetadata({ ...baseDict, file_path: null });
    expect(meta.source).toBe("installed");
  });

  it("examples 按行拆分并过滤空行", () => {
    const meta = dictToMetadata(baseDict);
    expect(meta.examples).toEqual(["示例 1：容器启动失败", "示例 2：清理镜像"]);
  });

  it("examples 为空字符串 → 返回空数组", () => {
    const meta = dictToMetadata({ ...baseDict, examples: "" });
    expect(meta.examples).toEqual([]);
  });

  it("enabled 默认 true（localStorage 未写入时）", () => {
    expect(dictToMetadata(baseDict).enabled).toBe(true);
  });

  it("enabled 从 localStorage 读取（写入 false 后读到 false）", () => {
    writeEnabledState("docker-management", false);
    expect(dictToMetadata(baseDict).enabled).toBe(false);
  });
});

// ============================================================================
// getBuiltinSkills — 5 个 builtin skill 完整性
// ============================================================================

describe("getBuiltinSkills", () => {
  it("返回 5 个 builtin skill", () => {
    const skills = getBuiltinSkills();
    expect(skills).toHaveLength(5);
  });

  it("包含 5 个预期的 skill 名称", () => {
    const names = getBuiltinSkills()
      .map((s) => s.name)
      .sort();
    expect(names).toEqual(
      [
        "docker-management",
        "linux-ops",
        "python-debug",
        "selinux-baseline",
        "ssh-troubleshoot",
      ].sort(),
    );
  });

  it("所有 builtin skill 都有必填字段", () => {
    for (const s of getBuiltinSkills()) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.whenToUse.length).toBeGreaterThan(0);
      expect(s.examples.length).toBeGreaterThan(0);
      expect(s.source).toBe("builtin");
      expect(s.enabled).toBe(true);
      expect(s.version).toBe("1.0.0");
      expect(s.author).toBe("TDSF");
      expect(s.tags?.length).toBeGreaterThan(0);
    }
  });

  it("分类覆盖 docker / linux / python / ssh", () => {
    const cats = new Set(getBuiltinSkills().map((s) => s.category));
    expect(cats.has("docker")).toBe(true);
    expect(cats.has("linux")).toBe(true);
    expect(cats.has("python")).toBe(true);
    expect(cats.has("ssh")).toBe(true);
  });

  it("返回副本，修改不影响下次调用", () => {
    const a = getBuiltinSkills();
    a[0].name = "mutated";
    a[0].examples.push("fake-example");
    const b = getBuiltinSkills();
    expect(b[0].name).not.toBe("mutated");
    expect(b[0].examples).not.toContain("fake-example");
  });
});

// ============================================================================
// readEnabledState / writeEnabledState — localStorage 持久化
// ============================================================================

describe("readEnabledState / writeEnabledState", () => {
  it("未写入时默认 true", () => {
    expect(readEnabledState("any-skill")).toBe(true);
  });

  it("写入 false 后读到 false", () => {
    writeEnabledState("docker-management", false);
    expect(readEnabledState("docker-management")).toBe(false);
  });

  it("写入 true 后读到 true", () => {
    writeEnabledState("ssh-troubleshoot", true);
    expect(readEnabledState("ssh-troubleshoot")).toBe(true);
  });

  it("不同 skill 互不影响", () => {
    writeEnabledState("skill-a", false);
    writeEnabledState("skill-b", true);
    expect(readEnabledState("skill-a")).toBe(false);
    expect(readEnabledState("skill-b")).toBe(true);
    expect(readEnabledState("skill-c")).toBe(true); // 未写入
  });

  it("覆写同 skill 的状态", () => {
    writeEnabledState("skill-x", false);
    expect(readEnabledState("skill-x")).toBe(false);
    writeEnabledState("skill-x", true);
    expect(readEnabledState("skill-x")).toBe(true);
  });
});

// ============================================================================
// filterSkills — 按 tab + 搜索关键词筛选
// ============================================================================

describe("filterSkills", () => {
  const sampleSkills: SkillMetadata[] = [
    {
      name: "docker-management",
      description: "Docker 管理 Skill",
      category: "docker",
      whenToUse: "docker 容器问题",
      examples: [],
      source: "builtin",
      enabled: true,
      tags: ["docker", "container"],
    },
    {
      name: "ssh-troubleshoot",
      description: "SSH 故障排查",
      category: "ssh",
      whenToUse: "SSH 连接超时",
      examples: [],
      source: "builtin",
      enabled: true,
      tags: ["ssh", "network"],
    },
    {
      name: "python-debug",
      description: "Python 调试 Skill",
      category: "python",
      whenToUse: "Python 异常追踪",
      examples: [],
      source: "builtin",
      enabled: true,
      tags: ["python", "pdb"],
    },
  ];

  it("tab=all + 空搜索 → 返回全部", () => {
    expect(filterSkills(sampleSkills, "all", "")).toHaveLength(3);
  });

  it("tab=docker → 只返回 docker 分类", () => {
    const r = filterSkills(sampleSkills, "docker", "");
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe("docker-management");
  });

  it("tab=ssh → 只返回 ssh 分类", () => {
    expect(filterSkills(sampleSkills, "ssh", "")).toHaveLength(1);
  });

  it("tab=custom → 无匹配时返回空数组", () => {
    expect(filterSkills(sampleSkills, "custom", "")).toEqual([]);
  });

  it("搜索匹配 name", () => {
    const r = filterSkills(sampleSkills, "all", "docker");
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe("docker-management");
  });

  it("搜索匹配 description", () => {
    const r = filterSkills(sampleSkills, "all", "故障排查");
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe("ssh-troubleshoot");
  });

  it("搜索匹配 tags", () => {
    const r = filterSkills(sampleSkills, "all", "pdb");
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe("python-debug");
  });

  it("搜索大小写不敏感", () => {
    expect(filterSkills(sampleSkills, "all", "DOCKER")).toHaveLength(1);
    expect(filterSkills(sampleSkills, "all", "SSH")).toHaveLength(1);
  });

  it("tab + 搜索组合", () => {
    // tab=docker + 搜索"python" → 空（docker skill 不含 python 关键词）
    expect(filterSkills(sampleSkills, "docker", "python")).toEqual([]);
    // tab=docker + 搜索"docker" → 1
    expect(filterSkills(sampleSkills, "docker", "docker")).toHaveLength(1);
  });

  it("搜索空白字符 → 等同空搜索", () => {
    expect(filterSkills(sampleSkills, "all", "   ")).toHaveLength(3);
  });

  it("无匹配 → 返回空数组", () => {
    expect(filterSkills(sampleSkills, "all", "不存在的关键词")).toEqual([]);
  });
});

// ============================================================================
// parseSkillCommand — /skill:<name> <args> 解析
// ============================================================================

describe("parseSkillCommand", () => {
  it("解析 name + args", () => {
    expect(
      parseSkillCommand("/skill:docker-management nginx 启动失败"),
    ).toEqual({
      name: "docker-management",
      args: "nginx 启动失败",
    });
  });

  it("只解析 name（无 args）", () => {
    expect(parseSkillCommand("/skill:ssh-troubleshoot")).toEqual({
      name: "ssh-troubleshoot",
      args: "",
    });
  });

  it("name 后多个空白 → args 收敛为单空格", () => {
    expect(
      parseSkillCommand("/skill:python-debug    traceback    分析"),
    ).toEqual({
      name: "python-debug",
      args: "traceback    分析", // 内部空白保留，仅首尾 trim
    });
  });

  it("args 中含特殊字符（保留原样）", () => {
    expect(
      parseSkillCommand("/skill:selinux-baseline AVC denied /var/log"),
    ).toEqual({
      name: "selinux-baseline",
      args: "AVC denied /var/log",
    });
  });

  it("name 含连字符正常解析", () => {
    expect(parseSkillCommand("/skill:linux-ops systemctl status")).toEqual({
      name: "linux-ops",
      args: "systemctl status",
    });
  });

  it("前后空白被 trim", () => {
    expect(parseSkillCommand("  /skill:docker-management nginx  ")).toEqual({
      name: "docker-management",
      args: "nginx",
    });
  });

  it("不以 /skill: 开头 → 返回 null", () => {
    expect(parseSkillCommand("skill:docker-management")).toBeNull();
    expect(parseSkillCommand("#skill:docker-management")).toBeNull();
    expect(parseSkillCommand("@skill:docker-management")).toBeNull();
    expect(parseSkillCommand("/skills:docker-management")).toBeNull(); // 多了 s
    expect(parseSkillCommand("/Skill:docker-management")).toBeNull(); // 大小写
    expect(parseSkillCommand("docker-management")).toBeNull();
    expect(parseSkillCommand("")).toBeNull();
  });

  it("前缀后为空 → 返回 null", () => {
    expect(parseSkillCommand("/skill:")).toBeNull();
    expect(parseSkillCommand("/skill:   ")).toBeNull(); // 只有空白
  });

  it("普通对话文本 → 返回 null（不误识别）", () => {
    expect(parseSkillCommand("如何配置 nginx?")).toBeNull();
    expect(parseSkillCommand("/help")).toBeNull();
    expect(parseSkillCommand("@file /etc/hosts")).toBeNull();
  });
});
