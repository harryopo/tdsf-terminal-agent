/**
 * windows-commands.ts — Windows 本地终端命令字典 (TDSF 2026-08-28)
 * -----------------------------------------------------------------------------
 * 本地终端运行在 Windows (pwsh/powershell/cmd)，与 SSH 的 Linux 环境不同，
 * 命令预测必须区分：本地预测 Windows 命令，SSH 预测 Linux 命令
 * （用户 2026-08-28 反馈：本地终端预测 Linux 命令输入了没用）。
 *
 * 数据组成：
 *   1. PowerShell 常用 cmdlet（动词-名词规范命名）
 *   2. cmd 外部命令（ipconfig/ping 等经典网络/系统工具）
 *   3. 跨平台开发工具（git/node/python 等本地也真实可用）
 * 描述为手编中文（教学场景）。
 * -----------------------------------------------------------------------------
 */

export interface WindowsCommandEntry {
  command: string;
  zh: string;
}

const WINDOWS_ZH: Record<string, string> = {
  // ── 文件与目录（PowerShell cmdlet）──────────────────────────────
  "Get-ChildItem": "列出目录内容（ls/dir 的 PowerShell 版）",
  "Get-Content": "读取文件内容（类似 cat）",
  "Set-Content": "写入文件内容",
  "Add-Content": "追加内容到文件",
  "Copy-Item": "复制文件或目录（类似 cp）",
  "Move-Item": "移动或重命名（类似 mv）",
  "Remove-Item": "删除文件/目录（类似 rm，-Recurse 删目录）",
  "New-Item": "创建文件/目录/注册表项",
  "Set-Location": "切换目录（=cd）",
  "Get-Location": "显示当前目录（=pwd）",
  "Get-Item": "获取文件/目录对象",
  "Get-ItemProperty": "读取对象属性（如注册表值）",
  "Test-Path": "判断路径是否存在",
  "Get-FileHash": "计算文件哈希（MD5/SHA256）",
  "Out-File": "输出重定向到文件",
  "Select-String": "文本搜索（PowerShell 版 grep）",
  "Compare-Object": "比较两个对象集合差异",
  "Get-ChildItem-Recursive": "",
  mkdir: "创建目录（New-Item 的别名）",
  rmdir: "删除目录",
  del: "删除文件（Remove-Item 别名）",
  copy: "复制文件（Copy-Item 别名）",
  move: "移动文件（Move-Item 别名）",
  ren: "重命名文件",
  cd: "切换目录",
  dir: "列出目录内容",
  cls: "清屏（=clear）",
  echo: "输出文本",
  type: "显示文件内容（cmd）",

  // ── 系统信息与进程 ────────────────────────────────────────────
  "Get-Process": "列出进程（类似 ps）",
  "Stop-Process": "结束进程（按名称/ID）",
  "Get-Service": "列出系统服务",
  "Start-Service": "启动服务",
  "Stop-Service": "停止服务",
  "Restart-Service": "重启服务",
  "Get-ComputerInfo": "获取系统信息",
  "Get-History": "查看命令历史",
  "Clear-History": "清空命令历史",
  "Get-Date": "显示日期时间",
  "Set-Date": "设置系统时间",
  "Get-PSDrive": "列出驱动器（含挂载）",
  "Get-Volume": "列出磁盘卷",
  "Get-EventLog": "读取事件日志",
  "Get-WinEvent": "读取 Windows 事件日志（新版）",
  tasklist: "列出进程（cmd 工具）",
  taskkill: "按 PID/名称结束进程",
  systeminfo: "显示系统详细信息",
  hostname: "显示主机名",
  ver: "显示 Windows 版本",
  whoami: "显示当前用户",
  env: "显示环境变量（pwsh）",
  "Get-Env": "读取环境变量",
  sc: "服务控制管理器（sc query/start/stop）",

  // ── 网络 ─────────────────────────────────────────────────────
  "Get-NetIPAddress": "查看 IP 地址配置",
  "Get-NetAdapter": "查看网络适配器",
  "Test-Connection": "PowerShell 版 ping",
  "Test-NetConnection": "测试端口/主机连通性（tnc）",
  "Invoke-WebRequest": "HTTP 请求（=curl/wget，别名 iwr）",
  "Invoke-RestMethod": "REST API 请求（别名 irm）",
  "Resolve-DnsName": "DNS 解析查询（=nslookup）",
  ipconfig: "查看/刷新网络配置（/flushdns /release /renew）",
  ping: "测试网络连通性（ICMP）",
  tracert: "路由跟踪（=traceroute）",
  nslookup: "DNS 查询",
  netstat: "查看端口/连接状态（-ano 查监听）",
  arp: "查看 ARP 缓存",
  route: "查看/修改路由表",
  netsh: "网络配置工具（wlan/防火墙/接口）",
  curl: "HTTP 客户端（Windows 10+ 内置真 curl）",
  ssh: "SSH 远程连接（Windows 10+ 内置 OpenSSH）",
  scp: "SSH 安全复制",
  sftp: "SSH 文件传输",
  wget: "下载工具（pwsh 里是 iwr 别名）",

  // ── 用户与权限 ───────────────────────────────────────────────
  "Get-LocalUser": "列出本地用户",
  "New-LocalUser": "创建本地用户",
  "Get-LocalGroup": "列出本地组",
  "Get-Acl": "获取对象 ACL 权限",
  "Set-Acl": "设置对象 ACL 权限",
  net: "用户/共享/服务管理（net user/share/start）",
  runas: "以其他用户身份运行",
  sudo: "以管理员运行（Windows 11 24H2+）",

  // ── 包管理与开发工具（本地真实可用）───────────────────────────
  "Get-Package": "列出已安装包",
  "Install-Module": "安装 PowerShell 模块",
  "Update-Help": "更新帮助文档",
  "Get-Help": "查看命令帮助（PowerShell 版 man）",
  "Get-Command": "查找命令（查某命令是否存在/类型）",
  "Get-Member": "查看对象成员（管道排错神器）",
  winget: "Windows 官方包管理器",
  choco: "Chocolatey 包管理器",
  scoop: "Scoop 包管理器",
  npm: "Node 包管理器",
  pnpm: "快速 Node 包管理器",
  node: "Node.js 运行时",
  python: "Python 解释器",
  pip: "Python 包管理器",
  git: "版本控制",
  code: "VS Code",
  docker: "容器运行时",
  cargo: "Rust 包管理器",
  rustc: "Rust 编译器",

  // ── 压缩与磁盘 ───────────────────────────────────────────────
  "Compress-Archive": "压缩为 zip",
  "Expand-Archive": "解压 zip",
  tar: "tar 归档（Windows 10+ 内置 bsdtar）",
  "Format-Volume": "格式化磁盘卷",
  "Optimize-Volume": "磁盘优化/碎片整理",
  "Repair-Volume": "修复磁盘卷（类似 chkdsk）",
  chkdsk: "检查磁盘错误",
  diskpart: "磁盘分区管理",
  compact: "NTFS 压缩",
  cipher: "EFS 加密/擦除",
  sfc: "系统文件检查器（sfc /scannow）",
  dism: "系统映像部署与修复",

  // ── 脚本与执行 ───────────────────────────────────────────────
  "Start-Process": "启动新进程",
  "Start-Job": "启动后台作业",
  "Wait-Job": "等待后台作业",
  "Receive-Job": "接收作业输出",
  "ForEach-Object": "管道逐项处理（%）",
  "Where-Object": "管道过滤（?）",
  "Sort-Object": "排序",
  "Group-Object": "分组",
  "Measure-Object": "统计（计数/求和/平均）",
  "Select-Object": "选取对象属性",
  "Write-Host": "输出到宿主（带颜色）",
  "Write-Output": "输出到管道",
  "Read-Host": "读取用户输入",
  "Invoke-Expression": "执行字符串命令（=eval，慎用）",
  "Start-Sleep": "暂停若干秒",
  powershell: "启动 Windows PowerShell",
  pwsh: "启动 PowerShell 7+",
  cmd: "启动 cmd 解释器",
  wsl: "Windows 子系统 Linux",
  reg: "注册表读写（cmd）",
  schtasks: "计划任务管理",
};

export const WINDOWS_COMMAND_LIST: WindowsCommandEntry[] = Object.entries(
  WINDOWS_ZH,
)
  .filter(([, zh]) => zh.length > 0)
  .map(([command, zh]) => ({ command, zh }));
