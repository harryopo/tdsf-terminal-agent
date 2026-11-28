export const tasks = [
  {
    id: "files",
    number: "01",
    name: "文件系统",
    description: "目录与系统身份",
    goal: "确认当前位置、目录内容和 Linux 发行版。",
    steps: [
      {
        id: "files-pwd",
        command: "pwd",
        expect: /\/root/,
        heading: "先确认自己在哪里",
        body: "pwd 会打印当前工作目录。真实 Linux 的路径从根目录 / 开始。",
        meaning: "输出就是当前 shell 所在目录，不是网页预设的地址。",
        next: "输入 ls -la 查看当前目录，包括隐藏文件。"
      },
      {
        id: "files-ls",
        command: "ls -la",
        expect: /\s\.\.$/m,
        heading: "列出目录细节",
        body: "ls 用于列出目录；-l 显示权限、属主和大小，-a 包含隐藏文件。",
        meaning: "每一行都是一个真实目录项，权限位来自 Linux 文件系统。",
        next: "输入 cat /etc/os-release 查看发行版信息。"
      },
      {
        id: "files-os-release",
        command: "cat /etc/os-release",
        expect: /Buildroot 2013\.08\.1/,
        heading: "读取系统身份",
        body: "cat 会把文本文件连续输出。/etc/os-release 记录当前 Linux 发行版。",
        meaning: "这些字段来自镜像内的真实系统文件。",
        next: "文件系统检查完成，可以继续权限组。"
      }
    ]
  },
  {
    id: "permissions",
    number: "02",
    name: "权限",
    description: "用户与文件状态",
    goal: "确认当前用户，并读取一个系统文件的权限与账户记录。",
    steps: [
      {
        id: "permissions-id",
        command: "id",
        expect: /uid=0\(root\)/,
        heading: "查看当前用户",
        body: "id 会显示当前进程的用户名、用户 ID、组名和组 ID。",
        meaning: "这是 Linux 内核里的真实执行身份，不是网页账号。",
        next: "输入 ls -l /etc/passwd 查看文件权限。"
      },
      {
        id: "permissions-passwd-mode",
        command: "ls -l /etc/passwd",
        expect: /^-[rwx-]{9}\s+\d+\s+\S+\s+\S+\s+\d+.*\/etc\/passwd$/m,
        heading: "查看文件权限",
        body: "ls -l 的长列表把权限、链接数、属主、组和大小放在同一行。",
        meaning: "权限位来自真实文件系统，不是页面预设。",
        next: "输入 grep '^root:' /etc/passwd 查看 root 账户记录。"
      },
      {
        id: "permissions-root-record",
        command: "grep '^root:' /etc/passwd",
        expect: /root:x:0:0/,
        heading: "检索账户记录",
        body: "grep 从文本文件中筛选匹配行；这里查找以 root: 开头的账户记录。",
        meaning: "输出来自镜像内的 /etc/passwd。",
        next: "权限检查完成，可以继续系统状态组。"
      }
    ]
  },
  {
    id: "system",
    number: "03",
    name: "系统状态",
    description: "内核与运行读数",
    goal: "读取内核版本、最近内核消息和运行时间。",
    steps: [
      {
        id: "diagnostics-uname",
        command: "uname -a",
        expect: /i686/,
        heading: "查看内核信息",
        body: "uname -a 会输出内核名称、主机名、版本、架构等信息。",
        meaning: "架构来自 v86 客户机，不等于宿主浏览器或电脑的架构。",
        next: "输入 dmesg | tail -n 5 查看最近的内核消息。"
      },
      {
        id: "diagnostics-dmesg",
        command: "dmesg | tail -n 5",
        expect: /\[/,
        heading: "组合读取日志",
        body: "dmesg 输出内核日志；管道 | 把输出交给 tail，只保留最后 5 行。",
        meaning: "日志由客户机内核产生，不是前端合成文本。",
        next: "输入 uptime 查看系统运行时间。"
      },
      {
        id: "diagnostics-uptime",
        command: "uptime",
        expect: /load average/,
        heading: "查看运行时间",
        body: "uptime 会显示当前时间、系统运行时长、登录用户数和负载平均值。",
        meaning: "运行时长从客户机启动开始计算，重置后会回到基线。",
        next: "三组基础真机检查全部完成。下一步将把这些检查编成事故场景。"
      }
    ]
  }
];
