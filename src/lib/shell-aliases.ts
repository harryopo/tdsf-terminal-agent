/**
 * shell-aliases.ts — Linux shell 常用别名/缩写命令数据集 (TDSF 2026-08-28)
 * -----------------------------------------------------------------------------
 * 背景（用户反馈）：输入 `ll` 预测不到，弹出的是 fuzzy 噪音 `ollama`。
 * Fig specs 不收录 shell 别名（官方 #110：alias 由运行时从 shell 读取展开），
 * tldr 也不收录 rc 别名（style guide 只允许命令本身的别名页）→ 静态表是
 * 唯一方案。
 *
 * 数据来源（2026-08-28 深度调研，来源 URL 见 docs/DEV-JOURNAL §37.70）：
 *   - A 发行版开箱预定义：Ubuntu .bashrc / RHEL colorls.sh 等事实性条目
 *   - B oh-my-zsh git 插件（MIT）+ bash 社区流行写法（gs 与 gst 双收录）
 *   - C bash-it（MIT）/ 运维教学高频别名
 *   - grml（GPL v2）仅提炼事实性映射，未拷贝文本
 *
 * 字段：alias → 展开命令（expand，教学用）→ 中文解释（zh，弹窗展示）
 * -----------------------------------------------------------------------------
 */

export interface ShellAliasEntry {
  alias: string;
  /** 展开的完整命令（教学用） */
  expand: string;
  /** 中文解释（弹窗展示） */
  zh: string;
}

export const SHELL_ALIASES: ShellAliasEntry[] = [
  // ── A. 发行版开箱预定义（Ubuntu .bashrc / RHEL 默认）─────────────────
  { alias: "ll", expand: "ls -alF", zh: "详细列表（含隐藏文件/权限/类型符）" },
  { alias: "la", expand: "ls -A", zh: "列出全部（含隐藏，不含 . 和 ..）" },
  { alias: "l", expand: "ls -CF", zh: "分栏列表 + 类型标记（/ 目录 * 可执行）" },
  { alias: "l.", expand: "ls -d .*", zh: "仅显示隐藏文件" },
  { alias: "ls", expand: "ls --color=auto", zh: "彩色文件列表（发行版默认别名）" },
  { alias: "grep", expand: "grep --color=auto", zh: "搜索结果高亮（发行版默认别名）" },
  { alias: "fgrep", expand: "fgrep --color=auto", zh: "固定字符串搜索 + 高亮" },
  { alias: "egrep", expand: "egrep --color=auto", zh: "扩展正则搜索 + 高亮" },
  { alias: "which", expand: "which --read-alias", zh: "查命令位置（RHEL 默认，可识别别名）" },
  { alias: "vi", expand: "vim", zh: "用 vim 代替 vi（RHEL 默认别名）" },
  { alias: "rm", expand: "rm -i", zh: "删除前询问（RHEL 默认，防误删）" },
  { alias: "cp", expand: "cp -i", zh: "覆盖前询问（RHEL 默认）" },
  { alias: "mv", expand: "mv -i", zh: "覆盖前询问（RHEL 默认）" },
  { alias: "alert", expand: "notify-send", zh: "长任务完成后弹桌面通知（Ubuntu 默认）" },

  // ── B. oh-my-zsh git 插件（MIT）+ 社区流行写法 ───────────────────────
  { alias: "g", expand: "git", zh: "git 本体" },
  { alias: "gst", expand: "git status", zh: "查看仓库状态（oh-my-zsh 标准）" },
  { alias: "gs", expand: "git status", zh: "查看仓库状态（社区流行写法）" },
  { alias: "ga", expand: "git add", zh: "暂存文件" },
  { alias: "gaa", expand: "git add --all", zh: "暂存全部变更" },
  { alias: "gc", expand: "git commit -v", zh: "提交（带 diff 复核）" },
  { alias: "gcmsg", expand: "git commit -m", zh: "带消息提交" },
  { alias: "gca", expand: "git commit -v -a", zh: "暂存全部并提交" },
  { alias: "gco", expand: "git checkout", zh: "切换分支/检出" },
  { alias: "gcb", expand: "git checkout -b", zh: "新建并切换分支" },
  { alias: "gb", expand: "git branch", zh: "分支列表" },
  { alias: "gba", expand: "git branch -a", zh: "分支列表（含远程）" },
  { alias: "gd", expand: "git diff", zh: "差异对比" },
  { alias: "gf", expand: "git fetch", zh: "拉取远程更新" },
  { alias: "gl", expand: "git pull", zh: "拉取并合并" },
  { alias: "gp", expand: "git push", zh: "推送到远程" },
  { alias: "gr", expand: "git remote", zh: "远程仓库管理" },
  { alias: "grv", expand: "git remote -v", zh: "远程仓库详情" },
  { alias: "glg", expand: "git log --stat", zh: "提交日志（含变更统计）" },
  { alias: "glo", expand: "git log --oneline --decorate", zh: "提交日志（单行）" },
  { alias: "glog", expand: "git log --oneline --graph", zh: "提交日志（图形化）" },
  { alias: "gsta", expand: "git stash", zh: "暂存工作现场" },
  { alias: "gstp", expand: "git stash pop", zh: "恢复暂存的工作现场" },
  { alias: "gstl", expand: "git stash list", zh: "暂存列表" },

  // ── C. bash-it（MIT）/ 运维教学高频 ─────────────────────────────────
  { alias: "..", expand: "cd ..", zh: "返回上一级目录" },
  { alias: "...", expand: "cd ../..", zh: "返回上两级目录" },
  { alias: "h", expand: "history", zh: "命令历史" },
  { alias: "j", expand: "jobs -l", zh: "后台任务列表" },
  { alias: "psg", expand: "ps -ef | grep", zh: "按名称查进程（运维高频）" },
  { alias: "ports", expand: "ss -tlnp", zh: "端口监听清单" },
  { alias: "cls", expand: "clear", zh: "清屏" },
  { alias: "update", expand: "sudo apt update && sudo apt upgrade", zh: "系统更新（Debian 系）" },
  { alias: "md", expand: "mkdir", zh: "建目录（DOS 习惯写法）" },
  { alias: "rd", expand: "rmdir", zh: "删空目录（DOS 习惯写法）" },
  { alias: "da", expand: "du -sch", zh: "目录总大小统计（grml 流行写法）" },
];
