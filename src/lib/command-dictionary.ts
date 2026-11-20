/**
 * command-dictionary.ts — Linux 命令中文字典 (TDSF 2026-08-09)
 * -----------------------------------------------------------------------------
 * 常用 Linux 命令 + 中文简述。
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
  lsblk: "列出块设备和挂载信息",
  blkid: "查看块设备文件系统标识",
  findmnt: "查看文件系统挂载关系",
  mountpoint: "检查路径是否为挂载点",
  fdisk: "管理磁盘分区表并查看分区",
  parted: "创建和调整磁盘分区",
  swapon: "启用交换分区或交换文件",
  swapoff: "停用交换分区或交换文件",
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
  readlink: "显示符号链接目标或规范路径",
  realpath: "转换为规范绝对路径",
  dirname: "提取路径中的目录部分",
  basename: "提取路径中的文件名部分",
  xargs: "将标准输入转换为命令参数",
  jq: "查询和处理 JSON 数据内容",
  yq: "查询和处理 YAML 数据内容",
  split: "按大小或行数拆分文件",
  truncate: "截断文件或调整文件大小",
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
  pkill: "按名称匹配并发送信号",
  pgrep: "按名称查找正在运行的进程 ID",
  pstree: "以树状结构显示进程关系",
  timeout: "限时运行命令并超时终止",
  watch: "定时重复执行命令并显示结果",
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
  nmcli: "查看和配置网络连接及设备",
  nmtui: "通过文本界面配置网络连接",
  networkctl: "查看和管理 systemd 网络状态",
  resolvectl: "查询和管理本机 DNS 解析",
  hostnamectl: "查看或设置主机名及系统信息",
  ethtool: "查看和配置网卡链路参数",
  arping: "通过 ARP 探测同网段主机",
  tracepath: "跟踪到目标主机的网络路径",
  mtr: "持续查看路由路径和网络丢包",
  nc: "建立网络连接并收发数据",
  nft: "查看和管理防火墙规则集",
  tcpdump: "抓包工具",
  iptables: "防火墙规则",
  "firewall-cmd": "配置 firewalld 防火墙规则",
  ufw: "防火墙管理（Ubuntu）",
  // 包管理
  apt: "包管理（Debian/Ubuntu）",
  "apt-get": "包管理（旧版）",
  dpkg: "包管理底层工具",
  yum: "包管理（CentOS 旧版）",
  dnf: "管理 RPM 系发行版软件包",
  rpm: "RPM 包管理",
  pip: "Python 包管理",
  npm: "Node.js 包管理",
  pnpm: "高效 Node 包管理",
  // 服务管理
  systemctl: "管理 systemd 服务",
  service: "管理服务（旧版）",
  journalctl: "查看系统日志",
  loginctl: "查看和管理登录会话",
  timedatectl: "查看和设置系统时间及时区",
  getenforce: "查看 SELinux 当前执行模式",
  setenforce: "切换 SELinux 强制或宽容模式",
  sestatus: "查看 SELinux 运行状态与策略",
  semanage: "管理 SELinux 策略及安全配置",
  restorecon: "恢复文件默认 SELinux 安全上下文",
  setfacl: "设置文件访问控制列表",
  getfacl: "查看文件访问控制列表",
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
  fastfetch: "显示系统信息与硬件概况",
  sftp: "通过 SSH 安全传输文件",
  podman: "管理容器镜像及运行状态",
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
