# ShellLab · 浏览器里的真实 Linux 演练场

赛道：Qoder 高校创造力大赛 · StudyHack 学习科研
作品状态：已公网发布（2026-11-28）
公网地址：https://shelllab-linux-swyzioy6s1k.qoder.website

> 当前 Qoder 订阅支持静态站点，不支持 Database/Functions。公网版保留完整 6 包 18 步与真实 Linux，学习进度仅保留在当前页面内存；升级套餐后可启用匿名云端进度。

ShellLab 让学习者在浏览器里启动一套隔离的 Buildroot Linux，通过真实命令输出练习文件系统、权限、磁盘、进程、网络与日志排障。它不是预写答案的终端模拟器，也不连接用户的电脑或服务器。

## 核心体验

- 真实运行：xterm.js 负责终端交互，v86 在浏览器内执行本地 Linux 镜像。
- 六组任务：6 个卡包、18 个步骤，覆盖基础检查与诊断思路。
- 即时解释：命令执行后显示中文解释、输出含义和下一小步。
- 卡包交互：选择任务卡包，弹出、折叠、左右停靠或随时恢复任务卡。
- 匿名进度：后端可用时通过 HttpOnly 会话保存学习进度；纯静态版保留当前页面内存进度，不需要注册账号。
- 安全边界：命令只在隔离客户机内执行；不读取本机文件，不连接真实 SSH。
- 可重复练习：保存客户机基线，一键重置环境；学习进度独立保留。

## 使用方法

1. 打开 ShellLab，等待 Linux 镜像启动。
2. 在 `login:` 后输入 `root`。这是镜像内账号，无需密码。
3. 点击“抽取任务卡”，选择一个卡包。
4. 点击“填入命令”，在真实终端按 Enter 执行；右侧查看解释和证据。
5. 完成步骤后继续下一张卡；点击“重置环境”可恢复客户机基线。

## 本地运行

需要 Node.js 20 或更高版本。

```bash
npm --prefix backend run dev:full
```

打开 `http://127.0.0.1:8080/`。本地服务使用内存存储，重启后匿名进度会清空。

只预览静态前端时，可在 `site/` 启动任意静态服务器。页面在接口不可用时会使用 `catalog.json` 的完整 6 包 18 步目录，学习进度仅保留在当前页面内存。

## 自动化验证

```bash
node --test site/tests/api-client.test.js site/tests/command-display.test.js site/tests/shell-session.test.js site/tests/v86-runtime.test.js site/tests/task-queue.test.js
npm --prefix backend test
node site/tests/fingerprint.mjs
```

当前本地验收覆盖：

- 前端单元测试 45/45。
- 后端自动化测试 18/18。
- 6 个卡包、18 个步骤真实通关。
- 50/50 次客户机重置。
- 命令回显、ANSI 分片、连续输入、延迟重置竞态、会话失败、移动端布局与本地回退零无效写入。

详细记录见 [验收清单](SHELLLAB-验收清单-2026-11-26.md) 和 [真实浏览器证据](evidence/v86-learning-e2e.json)。

## 部署结构

- `site/`：静态前端、本地运行时资产与完整静态任务目录。
- `backend/functions/`：Qoder Sites Function 入口、任务目录、匿名会话与进度 API。
- `backend/schema.sql`：匿名学习进度数据库结构。
- `backend/dev/`：本地 Node 服务与内存存储。
- `dist/`：发布用静态输出，由 `site/` 生成，不纳入 Git。

公网部署使用 Qoder Sites 静态站点。Function 与数据库代码已保留，但当前订阅套餐不能分配云端后端，因此公网版使用完整静态任务目录与页面内存进度；前端不会向不可用接口发送写入。

## 数据与安全

- 匿名会话令牌只以哈希形式入库，Cookie 使用 HttpOnly 与 SameSite=Lax。
- 数据库保存命令/输出哈希、判定结果、次数和时间，不保存原始终端输出。
- 写接口校验同源、请求大小、字段格式与幂等键。
- 客户机镜像为 Buildroot 2013.08.1、32 位 i686；它不是现代完整发行版，也不用于生产环境。
- 所有第三方资产及许可证记录见 [第三方声明](THIRD_PARTY_NOTICES.md)。

## 比赛材料

- [作品帖草稿](作品帖草稿-2026-11-28.md)
- [验收清单](SHELLLAB-验收清单-2026-11-26.md)
- [桌面卡包截图](evidence/shelllab-card-pack.png)
- [停靠任务卡截图](evidence/shelllab-task-panel-docked.png)
- [移动端截图](evidence/shelllab-card-pack-mobile.png)
- [真实通关截图](evidence/shelllab-v86-complete.png)
- [源码指纹](evidence/source-fingerprint.json)
