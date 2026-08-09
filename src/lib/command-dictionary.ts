/**
 * command-dictionary.ts — Linux 命令中文字典 (TDSF 2026-08-09)
 * -----------------------------------------------------------------------------
 * 180+ 常用 Linux 命令 + 中文翻译。
 * 用于 SSH 终端实时预测弹窗。
 *
 * 分类：文件操作 / 文本处理 / 系统信息 / 网络 / 包管理 / 服务管理 /
 *       用户权限 / 压缩 / 目录导航 / 进程管理 / 教学场景
 * -----------------------------------------------------------------------------
 */

export interface CommandDictEntry {
  command: string;
  zh: string;
}

/** 命令 → 中文翻译 映射表 */
const COMMAND_ZH: Record<string, string> = {
  // 文件操作
  ls: "列出目录内容",
  ll: "详细列表（别名）",
  la: "列出含隐藏文件",
  cp: "复制文件或目录",
  mv: "移动或重命名",
  rm: "删除文件",
  mkdir: "创建目录",
  rmdir: "删除空目录",
  touch: "创建空文件/更新时间戳",
  find: "搜索文件",
  ln: "创建链接",
  stat: "显示文件状态",
  file: "查看文件类型",
  tree: "树状显示目录",
  du: "查看磁盘占用",
  df: "查看文件系统空间",
  chmod: "修改权限",
  chown: "修改所有者",
  chgrp: "修改所属组",
  // 文本处理
  cat: "查看文件内容",
  head: "查看文件头部",
  tail: "查看文件尾部",
  less: "分页查看",
  more: "分页查看（简版）",
  grep: "文本搜索",
  sed: "流编辑器",
  awk: "文本处理工具",
  sort: "排序",
  uniq: "去重",
  wc: "统计行数/单词数",
  cut: "截取列",
  tr: "字符替换",
  tee: "输出到文件和屏幕",
  diff: "比较文件差异",
  vim: "Vim 编辑器",
  nano: "Nano 编辑器",
  // 系统信息
  uname: "查看系统信息",
  hostname: "查看主机名",
  uptime: "查看运行时间和负载",
  who: "查看登录用户",
  whoami: "查看当前用户名",
  id: "查看用户 ID 信息",
  date: "查看/设置日期",
  cal: "显示日历",
  free: "查看内存使用",
  top: "实时进程监控",
  htop: "交互式进程监控",
  ps: "查看进程列表",
  kill: "终止进程",
  killall: "按名称终止进程",
  lsof: "查看打开的文件",
  ulimit: "查看资源限制",
  // 网络
  ping: "测试网络连通性",
  curl: "HTTP 请求工具",
  wget: "下载文件",
  ssh: "远程登录",
  scp: "安全复制文件",
  rsync: "远程同步",
  netstat: "查看网络连接",
  ss: "查看套接字（现代版）",
  ifconfig: "查看网络接口",
  ip: "网络配置（现代版）",
  dig: "DNS 查询",
  nslookup: "DNS 查询（旧版）",
  traceroute: "路由追踪",
  tcpdump: "抓包工具",
  iptables: "防火墙规则",
  "firewall-cmd": "防火墙管理（CentOS）",
  ufw: "防火墙管理（Ubuntu）",
  // 包管理
  apt: "包管理（Debian/Ubuntu）",
  "apt-get": "包管理（旧版）",
  dpkg: "包管理底层工具",
  yum: "包管理（CentOS 旧版）",
  dnf: "包管理（CentOS 新版）",
  rpm: "RPM 包管理",
  pip: "Python 包管理",
  npm: "Node.js 包管理",
  pnpm: "高效 Node 包管理",
  // 服务管理
  systemctl: "管理 systemd 服务",
  service: "管理服务（旧版）",
  journalctl: "查看系统日志",
  docker: "容器管理",
  kubectl: "Kubernetes 管理",
  // 用户权限
  sudo: "以管理员执行",
  su: "切换用户",
  passwd: "修改密码",
  useradd: "添加用户",
  usermod: "修改用户",
  userdel: "删除用户",
  groupadd: "添加用户组",
  visudo: "编辑 sudo 权限",
  // 压缩
  tar: "打包/压缩",
  zip: "ZIP 压缩",
  unzip: "ZIP 解压",
  gzip: "gzip 压缩",
  gunzip: "gzip 解压",
  bzip2: "bzip2 压缩",
  // 目录导航
  cd: "切换目录",
  pwd: "显示当前目录",
  pushd: "压入目录栈",
  popd: "弹出目录栈",
  // 进程
  jobs: "查看后台任务",
  bg: "放后台运行",
  fg: "调到前台",
  nohup: "忽略挂断运行",
  // 其他
  echo: "输出文本",
  printf: "格式化输出",
  export: "设置环境变量",
  source: "执行脚本（别名 .）",
  alias: "设置别名",
  history: "查看命令历史",
  man: "查看帮助手册",
  which: "查找命令位置",
  whereis: "查找二进制/源码/手册",
  type: "查看命令类型",
  env: "查看环境变量",
  set: "查看/设置 Shell 变量",
  crontab: "定时任务",
  at: "一次性定时任务",
  // 教学场景
  bash: "Bash Shell",
  sh: "POSIX Shell",
  python3: "Python 3 解释器",
  git: "版本控制",
  make: "编译构建",
  gcc: "C 编译器",
};

/** 按命令名排序的数组（用于二分查找/前缀匹配） */
export const COMMAND_LIST: CommandDictEntry[] = Object.entries(COMMAND_ZH)
  .map(([command, zh]) => ({ command, zh }))
  .sort((a, b) => a.command.localeCompare(b.command));

/** 获取命令的中文翻译 */
export function getCommandZh(command: string): string {
  return COMMAND_ZH[command] ?? "";
}

/**
 * 前缀匹配搜索 — 返回最多 limit 条预测
 * 先精确前缀匹配，不足时模糊包含匹配补充
 */
export function predictCommands(prefix: string, limit: number = 5): CommandDictEntry[] {
  if (!prefix) return [];

  const lower = prefix.toLowerCase();

  // 第一轮：前缀精确匹配（按字母序）
  const prefixMatches = COMMAND_LIST.filter((e) =>
    e.command.toLowerCase().startsWith(lower),
  );

  if (prefixMatches.length >= limit) {
    return prefixMatches.slice(0, limit);
  }

  // 第二轮：包含匹配补充
  const remaining = limit - prefixMatches.length;
  const containMatches = COMMAND_LIST.filter(
    (e) =>
      !e.command.toLowerCase().startsWith(lower) &&
      e.command.toLowerCase().includes(lower),
  ).slice(0, remaining);

  return [...prefixMatches, ...containMatches];
}
