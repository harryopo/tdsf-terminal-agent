/**
 * snippets/lib/presets.ts — 内置预置片段（Linux 运维教学工具箱）
 *
 * 首次打开 Snippets 面板时自动种入 store；用户可编辑/删除，
 * 已删除的内置片段不会随重启复活（删除 id 记录见 snippetStore）。
 *
 * 设计约定：
 *   - id 统一 `preset-` 前缀（store 据此识别内置片段）
 *   - name/description 全中文（教学场景），command 保持可直接执行的 POSIX/Linux 语法
 *   - createdAt 用固定常量（种入时间一致，测试可复现）；非置顶列表按 createdAt
 *     降序排（新建在前），内置片段稳定靠后，插入使用不改变位置
 *   - {{var}} 变量片段插入时会弹确认 Dialog，天然适合带参数的敏感命令
 *
 * 面向场景：SSH 连接的 Linux 服务器（CentOS/RHEL 生态为主，命令通用化）。
 * 本地 Windows 终端插入这些命令不会执行成功——片段本质是 Linux 教学向。
 */
import type { Snippet } from "../types";

/** 内置片段统一创建时间（2025-01-01T00:00:00Z，仅用于排序基准） */
export const PRESET_CREATED_AT = 1735689600000;

/** 内置片段 id 前缀（store 删除逻辑据此识别） */
export const PRESET_ID_PREFIX = "preset-";

/** 组装内置片段（收敛公共字段，避免每条重复样板） */
function preset(
  id: string,
  name: string,
  command: string,
  description: string,
  tags: string[],
  variables?: { name: string; defaultValue?: string }[],
): Snippet {
  return {
    id: `${PRESET_ID_PREFIX}${id}`,
    name,
    command,
    description,
    tags,
    variables: variables ?? [],
    createdAt: PRESET_CREATED_AT,
    updatedAt: PRESET_CREATED_AT,
  };
}

/**
 * 内置预置片段清单。
 * 分组即 tags（面板标签 tab 一键过滤）：环境感知 / 状态监控 / 定时任务 / 日志排查 / 快捷操作
 */
export const PRESET_SNIPPETS: Snippet[] = [
  // === 环境感知：连上服务器先摸清硬件与系统 ===
  preset(
    "env-cpu",
    "CPU 信息",
    "lscpu",
    "查看 CPU 型号、架构、核心数、主频。连上新服务器第一步先摸清处理器底细。",
    ["环境感知"],
  ),
  preset(
    "env-disk-tree",
    "磁盘分区结构",
    "lsblk -f",
    "树状列出磁盘/分区及各分区文件系统类型（xfs/ext4/swap），装系统、挂盘前必看。",
    ["环境感知"],
  ),
  preset(
    "env-disk-usage",
    "磁盘用量",
    "df -hT",
    "查看各挂载点的总容量/已用/可用与文件系统类型，-h 人类可读单位。磁盘告警时先跑它。",
    ["环境感知"],
  ),
  preset(
    "env-mem",
    "内存用量",
    "free -h",
    "查看物理内存与交换分区（swap）用量。重点看 available 列，才是真正可分配的内存。",
    ["环境感知"],
  ),
  preset(
    "env-system",
    "系统版本信息",
    "hostnamectl",
    "一次性查看主机名、发行版版本、内核版本、架构。报障时先贴这个确认环境。",
    ["环境感知"],
  ),
  preset(
    "env-network",
    "网卡与 IP",
    "ip -br addr",
    "简洁列出所有网卡及其 IP 地址（-br 精简模式）。确认本机 IP、排查网络第一步。",
    ["环境感知"],
  ),

  // === 状态监控：服务器现在累不累、谁在吃资源 ===
  preset(
    "mon-top-proc",
    "资源占用 Top 进程",
    "ps aux --sort=-%cpu | head -15",
    "按 CPU 占用降序列出前 15 个进程快照。服务器卡顿时定位谁在吃资源。",
    ["状态监控"],
  ),
  preset(
    "mon-vmstat",
    "系统压力采样",
    "vmstat 1 5",
    "每 1 秒采样一次共 5 次：CPU、内存、swap 换入换出、IO 综合体检。si/so 持续非 0 说明内存吃紧。",
    ["状态监控"],
  ),
  preset(
    "mon-ports",
    "端口监听全景",
    "ss -tulpn",
    "列出所有 TCP/UDP 监听端口及对应进程。部署服务前确认端口没被占，安全排查也靠它。",
    ["状态监控"],
  ),
  preset(
    "mon-services",
    "运行中的服务",
    "systemctl list-units --type=service --state=running",
    "列出当前所有 running 状态的 systemd 服务。清点服务器上跑了哪些东西。",
    ["状态监控"],
  ),
  preset(
    "mon-failed",
    "失败的服务",
    "systemctl --failed",
    "列出启动失败/异常退出的服务。开机后例行检查，别等业务挂了才发现。",
    ["状态监控"],
  ),
  preset(
    "mon-users",
    "当前登录用户",
    "w",
    "查看谁登录在服务器上、在干什么（比 who 多显示负载与当前命令）。多用户服务器例行巡查。",
    ["状态监控"],
  ),

  // === 定时任务：crontab 与 systemd timer ===
  preset(
    "cron-list",
    "查看定时任务",
    "crontab -l",
    "列出当前用户的 crontab 定时任务（-l=list）。接手别人服务器先看有哪些定时活。",
    ["定时任务"],
  ),
  preset(
    "cron-edit",
    "编辑定时任务",
    "crontab -e",
    "编辑当前用户的 crontab（-e=edit），保存后自动加载生效。格式：分 时 日 月 周 命令。",
    ["定时任务"],
  ),
  preset(
    "cron-system",
    "系统级定时任务",
    "ls -l /etc/cron.daily /etc/cron.hourly /etc/cron.weekly",
    "查看系统级定时任务目录（每日/每小时/每周）。这些任务对所有用户生效，排障别漏。",
    ["定时任务"],
  ),
  preset(
    "cron-timers",
    "systemd 定时器",
    "systemctl list-timers --all",
    "列出所有 systemd timer 定时器及下次触发时间。新版 Linux 推荐用 timer 替代 crontab。",
    ["定时任务"],
  ),

  // === 日志排查：journalctl 三板斧 ===
  preset(
    "log-follow",
    "实时滚动日志",
    "journalctl -f",
    "实时跟踪追加的系统日志（-f=follow，类似 tail -f）。盯着服务重启/报错现场，Ctrl+C 退出。",
    ["日志排查"],
  ),
  preset(
    "log-errors",
    "本次开机错误日志",
    "journalctl -p err -b",
    "只看本次开机（-b）以来 err 级别及以上的日志，过滤噪音直奔错误。",
    ["日志排查"],
  ),
  preset(
    "log-lastb",
    "登录失败记录",
    "lastb -n 10",
    "查看最近 10 条登录失败记录（need root）。大量失败记录 = 有人在爆破你的 SSH。",
    ["日志排查"],
  ),

  // === 快捷操作：带 {{变量}} 的常用组合，插入时弹窗填参 ===
  preset(
    "ops-find-proc",
    "按名查进程",
    "ps aux | grep -i {{关键词}}",
    "按关键字模糊查找进程（-i 忽略大小写）。配合 kill/PID 定位，先查再杀不误伤。",
    ["快捷操作"],
    [{ name: "关键词", defaultValue: "nginx" }],
  ),
  preset(
    "ops-big-files",
    "全盘找大文件",
    "find / -type f -size +100M 2>/dev/null | head -20",
    "全盘搜索大于 100MB 的文件前 20 个（2>/dev/null 屏蔽权限报错）。磁盘爆满时找出元凶。",
    ["快捷操作"],
  ),
  preset(
    "ops-dir-size",
    "目录占用排行",
    "du -sh * | sort -rh | head -10",
    "统计当前目录下各项大小并从大到小排前 10。定位哪个目录最占空间。",
    ["快捷操作"],
  ),
  preset(
    "ops-top",
    "实时资源监控",
    "top",
    "交互式实时监控 CPU/内存/进程（q 退出，P 按 CPU 排序，M 按内存排序）。最经典的排查入口。",
    ["快捷操作"],
  ),
];

/**
 * 计算需要补种的内置片段（纯函数，供 hydrate 与单测复用）。
 * 规则：跳过已存在的 id（用户编辑过也不覆盖）；跳过用户显式删除过的 id（不复活）。
 */
export function computePresetsToSeed(
  existing: Snippet[],
  deletedPresetIds: readonly string[],
): Snippet[] {
  const existingIds = new Set(existing.map((s) => s.id));
  const deleted = new Set(deletedPresetIds);
  return PRESET_SNIPPETS.filter(
    (p) => !existingIds.has(p.id) && !deleted.has(p.id),
  );
}
