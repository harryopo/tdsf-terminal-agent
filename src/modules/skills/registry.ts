// TDSF 魔改 (P4-T4.4): 前端 Skill 注册中心
// -----------------------------------------------------------------------------
// 职责:
//   1. 维护 5 个 builtin skill 的硬编码元数据（IPC 降级时使用）
//   2. 提供 SkillDict → SkillMetadata 转换（snake_case → camelCase + category 推断）
//   3. 维护本地启用状态（localStorage 持久化，与 Python 端 enabled 解耦）
//
// 降级策略:
//   当 Python sidecar 未运行或 skill.list 方法不存在时，loader.ts 调用
//   `getBuiltinSkills()` 返回硬编码的 5 个 builtin skill 元数据，不阻塞 UI。
//
// 分类推断规则（按 tags 优先级）:
//   - tags 含 "docker" → docker
//   - tags 含 "ssh" → ssh
//   - tags 含 "python" → python
//   - tags 含 "linux" / "selinux" / "nginx" / "systemd" → linux
//   - 其余 → custom

// TDSF 魔改: 引入 builtin SKILL.md 原文，让降级模式下也能预览 Skill 内容
import { BUILTIN_CONTENT_MAP } from "./builtinContent";
import type { SkillCategory, SkillDict, SkillMetadata } from "./types";

/** localStorage key（持久化启用状态） */
const ENABLED_STATE_STORAGE_KEY = "tdsf.skills.enabled";

/**
 * 5 个 builtin skill 的硬编码元数据（IPC 降级用）
 *
 * 与 src-tauri/sidecar/skills/builtin 下的 SKILL.md frontmatter 对齐。
 * 当 Python sidecar 不可用时，loader 返回此列表，让 UI 仍可展示。
 */
const BUILTIN_SKILLS: SkillMetadata[] = [
  {
    name: "docker-management",
    description: "Docker 管理 Skill，处理容器/镜像/网络/卷/Compose 等任务",
    category: "docker",
    whenToUse:
      "用户请求处理 docker 容器/镜像/网络/卷相关问题，或使用 docker-compose 编排服务",
    examples: [
      "示例：诊断容器退出码",
      "示例：清理悬挂镜像",
      "示例：compose 服务启动失败",
    ],
    source: "builtin",
    enabled: true,
    version: "1.0.0",
    author: "TDSF",
    tags: ["docker", "container", "devops", "compose"],
  },
  {
    name: "linux-ops",
    description:
      "Linux 运维 Skill，处理 nginx/systemd/journalctl/iptables 等常见运维任务",
    category: "linux",
    whenToUse:
      "用户请求处理 nginx / apache / systemd 服务相关问题，或需要查看 journalctl 系统日志、配置 iptables 防火墙规则",
    examples: [
      "示例 1：nginx 启动失败",
      "示例 2：iptables 防火墙规则",
      "示例 3：journalctl 查日志",
    ],
    source: "builtin",
    enabled: true,
    version: "1.0.0",
    author: "TDSF",
    tags: ["linux", "ops", "nginx", "systemd", "journalctl", "iptables"],
  },
  {
    name: "python-debug",
    description:
      "Python 调试 Skill，处理异常追踪、pdb 调试、性能分析、虚拟环境、依赖冲突等问题",
    category: "python",
    whenToUse:
      "用户报告 Python 异常/ traceback，或需要进行 pdb 调试、cProfile 性能分析、venv 虚拟环境管理、pip 依赖冲突排查",
    examples: [
      "示例：解析 traceback 定位异常",
      "示例：pdb 断点调试",
      "示例：pip 依赖冲突解决",
    ],
    source: "builtin",
    enabled: true,
    version: "1.0.0",
    author: "TDSF",
    tags: ["python", "debug", "pdb", "profiling", "venv", "pip"],
  },
  {
    name: "selinux-baseline",
    description:
      "SELinux 基线排查 Skill，处理 Enforcing/Permissive 切换、AVC denied、bool/label/fcontext 等问题",
    category: "linux",
    whenToUse:
      "用户报告 SELinux 相关问题（AVC denied / 模式切换 / 标签修复），或需要排查因 SELinux 策略导致的服务启动失败",
    examples: [
      "示例：AVC denied 排查",
      "示例：Enforcing/Permissive 切换",
      "示例：fcontext 修复文件标签",
    ],
    source: "builtin",
    enabled: true,
    version: "1.0.0",
    author: "TDSF",
    tags: ["selinux", "security", "avc", "label", "boolean"],
  },
  {
    name: "ssh-troubleshoot",
    description:
      "SSH 故障排查 Skill，处理连接超时/认证失败/known_hosts/密钥管理等问题",
    category: "ssh",
    whenToUse:
      "用户报告 SSH 连接超时/认证失败/known_hosts 冲突/密钥权限问题，或需要排查 sshd 配置、调试 SSH 连接",
    examples: [
      "示例：连接超时排查",
      "示例：认证失败排查",
      "示例：known_hosts 冲突处理",
    ],
    source: "builtin",
    enabled: true,
    version: "1.0.0",
    author: "TDSF",
    tags: ["ssh", "network", "auth", "troubleshooting"],
  },
];

/**
 * 从 tags 推断 Skill 分类
 *
 * 优先级：docker > ssh > python > linux（含 selinux/nginx/systemd）> custom
 *
 * @param tags Python 返回的 tags 列表
 * @returns 推断出的分类
 */
export function inferCategory(tags: string[]): SkillCategory {
  const lower = tags.map((t) => t.toLowerCase());
  if (lower.includes("docker") || lower.includes("container")) {
    return "docker";
  }
  if (lower.includes("ssh")) {
    return "ssh";
  }
  if (lower.includes("python")) {
    return "python";
  }
  const linuxHints = [
    "linux",
    "selinux",
    "nginx",
    "systemd",
    "journalctl",
    "iptables",
    "ops",
    "security",
  ];
  if (lower.some((t) => linuxHints.includes(t))) {
    return "linux";
  }
  return "custom";
}

/**
 * 把 Python SkillDict 转换为前端 SkillMetadata
 *
 * - 字段命名：snake_case → camelCase
 * - category：由 tags 推断
 * - source：file_path 非空 → builtin，否则视为 installed
 * - enabled：从 localStorage 读取（默认 true）
 * - examples：按行拆分（去掉空行）
 *
 * @param dict Python 返回的 SkillDict
 * @returns 前端 SkillMetadata
 */
export function dictToMetadata(dict: SkillDict): SkillMetadata {
  const examples = dict.examples
    ? dict.examples
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
    : [];

  return {
    name: dict.name,
    description: dict.description,
    category: inferCategory(dict.tags),
    whenToUse: dict.when_to_use,
    examples,
    source: dict.file_path ? "builtin" : "installed",
    enabled: readEnabledState(dict.name),
    version: dict.version,
    author: dict.author,
    tags: dict.tags,
    // TDSF 魔改: 透传 body 字段作为 SKILL.md 原文，供 SkillContentDialog 预览
    rawContent: dict.body ?? "",
    // TDSF 魔改: 透传 file_path，供 SkillCard / SkillContentDialog 的"打开目录"按钮调用
    filePath: dict.file_path ?? null,
  };
}

/**
 * 获取 builtin skill 硬编码元数据（IPC 降级用）
 *
 * 返回副本，避免外部修改内部状态。
 * TDSF 魔改: 同时从 BUILTIN_CONTENT_MAP 填充 rawContent 字段，让
 * SkillContentDialog 在 Python sidecar 不可用时也能预览 SKILL.md 完整内容。
 *
 * @returns 5 个 builtin skill 的元数据列表
 */
export function getBuiltinSkills(): SkillMetadata[] {
  return BUILTIN_SKILLS.map((s) => ({
    ...s,
    examples: [...s.examples],
    // TDSF 魔改: 填充 SKILL.md 原文，确保降级模式下 SkillContentDialog 也能渲染内容
    rawContent: BUILTIN_CONTENT_MAP[s.name] ?? "",
  }));
}

/**
 * 读取单个 skill 的启用状态（从 localStorage）
 *
 * 默认 true（首次访问视为启用）。
 *
 * @param name Skill 名称
 * @returns 是否启用
 */
export function readEnabledState(name: string): boolean {
  try {
    const raw = window.localStorage.getItem(ENABLED_STATE_STORAGE_KEY);
    if (!raw) return true;
    const map = JSON.parse(raw) as Record<string, boolean>;
    return map[name] ?? true;
  } catch {
    return true;
  }
}

/**
 * 写入单个 skill 的启用状态（持久化到 localStorage）
 *
 * @param name Skill 名称
 * @param enabled 是否启用
 */
export function writeEnabledState(name: string, enabled: boolean): void {
  try {
    const raw = window.localStorage.getItem(ENABLED_STATE_STORAGE_KEY);
    const map: Record<string, boolean> = raw
      ? (JSON.parse(raw) as Record<string, boolean>)
      : {};
    map[name] = enabled;
    window.localStorage.setItem(ENABLED_STATE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage 不可用（如隐私模式），忽略
  }
}
