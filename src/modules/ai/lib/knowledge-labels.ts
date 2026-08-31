/**
 * knowledge-labels.ts — 知识库 source / category 中文标签（共享映射）
 * -----------------------------------------------------------------------------
 * 双库方案 TDSF 2026-08-31：KnowledgeBrowser（知识浏览器）与 tool.tsx
 * （knowledge_search / knowledge_get_doc 工具卡片）共用同一份映射，
 * 单一真源防两处漂移。
 */

/** 17 官方文档源 → 中文名（副行小字；与 crawlers/registry.py 注册源一一对应） */
export const OFFICIAL_SOURCE_LABELS: Record<string, string> = {
  "nginx-docs": "Nginx 官方文档",
  "apache-docs": "Apache HTTP 文档",
  "mariadb-docs": "MariaDB 知识库",
  "redis-docs": "Redis 官方文档",
  "docker-docs": "Docker 官方文档",
  "kubernetes-docs": "Kubernetes 官方文档",
  "systemd-docs": "systemd 手册",
  "selinux-docs": "SELinux 指南",
  "iptables-docs": "netfilter 文档",
  "ssh-docs": "OpenSSH 手册",
  "bash-docs": "Bash 手册",
  "python-docs": "Python 官方文档",
  "rust-docs": "Rust 官方文档",
  "git-docs": "Git 官方文档",
  "dnf-docs": "DNF 手册",
  "firewalld-docs": "Firewalld 手册",
  archwiki: "Arch Wiki 指南",
  philosophy: "教学语料",
};

/** source 原始值 → 中文名（分组头副行 / 条目副行小字）；未知 *-docs 回退
 *  「<前缀> 文档」，其余原样显示。内置教学语料已剔除（个人语料改为手动
 *  导入），删 builtin-skills/builtin-docs/builtin-corpus 映射 */
export function sourceGroupLabel(source: string): string {
  const mapped = OFFICIAL_SOURCE_LABELS[source];
  if (mapped) return mapped;
  if (source === "imported-docs") return "导入文档";
  if (source === "session-case" || source.startsWith("case-"))
    return "会话沉淀";
  if (source.endsWith("-docs")) {
    return `${source.slice(0, -"-docs".length)} 文档`;
  }
  return source;
}

/** 6+1 分类 key → 中文组名（category_for 映射，后端 knowledge.sources.py） */
export const CATEGORY_LABELS: Record<string, string> = {
  "basic-ops": "基础概念",
  "cmd-tools": "命令与工具",
  "sys-admin": "系统管理",
  "net-remote": "网络与远程",
  security: "安全加固",
  services: "服务部署",
  "linux-philosophy": "Linux 哲学与命令对照",
};

/** category key → 中文组名；空/未知 → 「其他」 */
export function categoryGroupLabel(category: string | undefined): string {
  if (category && CATEGORY_LABELS[category]) return CATEGORY_LABELS[category];
  return "其他";
}
