# 源码分析报告：Aider（终端优先与 git 沙箱回滚，Apache-2.0）

> 分析时间：2026-07-19
> 源码版本：HEAD（`--depth 1` clone，无完整 git 历史）
> 分析目的：为 tdsf-linux-desktop v0.9.2（Electron + React + TS + Ant Design 5 的 Linux 运维 AI 桌面助手）Agent 架构设计提供借鉴
> 分析者：tdsf-linux-desktop 资深源码分析师
> 仓库路径：`d:\ai\linux教学一体\opensource-reference\aider\`

---

## 0. 摘要

Aider 是一个**终端优先**的 AI 结对编程助手，Apache-2.0 许可，由 Paul Gauthier 主导，PyPI 累计下载 6.8M+，OpenRouter 平台 Top 20 消费者，每周处理 15B tokens，最新版本自编写比例 88%。核心由 ~30 个 Python 模块构成，全部位于 `aider/aider/` 子目录。

本报告基于对以下核心文件的**真实源码阅读**：
- 项目根：`README.md`、`LICENSE.txt`（确认 Apache-2.0）、`pyproject.toml`
- 编辑器核心：`aider/coders/` 下全部 38 个文件中的 8 个关键 coder（`base_coder.py`、`architect_coder.py`、`editblock_coder.py`、`wholefile_coder.py`、`udiff_coder.py`、`patch_coder.py`、`ask_coder.py`、`__init__.py`）+ 5 个 prompts
- git 集成：`aider/repo.py`（完整 622 行）
- 命令系统：`aider/commands.py`（关键段 ~300 行）
- RepoMap：`aider/repomap.py`（关键段 ~600 行）
- 模型管理：`aider/models.py`（关键段 ~700 行）
- Linting：`aider/linter.py`（完整 269 行）
- Voice：`aider/voice.py`（完整 187 行）
- Watch：`aider/watch.py`（完整 318 行）
- 主入口：`aider/main.py`（关键段 ~100 行）
- IO：`aider/io.py`（关键段）
- Diff 工具：`aider/diffs.py`（完整 128 行）
- 命令执行：`aider/run_cmd.py`（完整 130 行）
- 异常：`aider/exceptions.py`（完整 113 行）
- 模型预设：`aider/resources/model-settings.yml`（共 **357** 个模型条目）

**对 tdsf-linux-desktop 的关键借鉴点（P0）**：
1. **git 沙箱回滚机制** —— 用 `aider_commit_hashes` 集合标记"本会话产生的提交"，`/undo` 只回滚这些提交，杜绝误伤用户提交。运维场景可降级为 `git stash + checkpoint commit`，每步执行前自动 checkpoint，回滚即 `git reset --hard <checkpoint>`。
2. **Architect mode（planner + editor 分离）** —— `architect_coder.py` 仅 48 行，用强模型规划、用便宜模型执行，与 Kilo Code 的 Plan/Code 模式理念一致但更轻量。运维 Agent 可直接借鉴"planner 出指令 + editor 出脚本 + 人工审批"三段式。
3. **反射式命令系统** —— `commands.py` 中所有 `cmd_xxx` 方法自动成为 `/xxx` 命令，无需注册。TS 项目可用装饰器 + Reflect Metadata 实现同款机制。
4. **dirty commit 前置** —— `check_for_dirty_commit()` 在编辑前把未提交的文件先 commit 一次，保证 `/undo` 能干净回滚。运维 Agent 在改主机配置前同样应先 snapshot。

**P1**：RepoMap（PageRank + tree-sitter）思想可改造为"运维主机拓扑图"（主机+服务+依赖作为节点）；多 edit format 思想可改造为"运维脚本编辑策略"。

**P2/不建议借鉴**：Voice support（依赖 sounddevice/PortAudio，TS 侧 Electron 可直接用 Web Audio API 重写）；Watch 模式（watchfiles Python 库，TS 侧 chokidar 即可）；linting 用 tree-sitter（运维脚本验证用 `bash -n` + `shellcheck` 更直接）。

**关键约束提示**：Aider 是 Python 项目，依赖 `litellm`、`gitpython`、`tree-sitter`、`networkx`、`pydub`、`sounddevice`、`watchfiles`、`prompt_toolkit`、`diskcache`、`grep_ast` 等 Python 生态库。**tdsf-linux-desktop 是 TS 项目，禁止引入 Python 进程通信**，本报告所有借鉴建议都给出 TS 等价实现路径。

---

## 1. 项目概览

### 1.1 基本信息（来源：`README.md` + `pyproject.toml` + `LICENSE.txt`）

| 属性 | 值 |
|---|---|
| 项目名 | `aider-chat`（PyPI 包名） |
| 主入口 | `aider = "aider.main:main"`（见 `pyproject.toml:27`） |
| License | Apache-2.0（`LICENSE.txt:2-3` 确认） |
| Python 版本 | `>=3.10,<3.15`（`pyproject.toml:20`） |
| 构建系统 | setuptools + setuptools_scm（动态版本） |
| 主页 | https://github.com/Aider-AI/aider |
| PyPI 安装量 | 6.8M+（README 徽章） |
| 每周 tokens | 15B（README 徽章） |
| 自编写比例 | 88%（最新 release，README "Singularity" 徽章） |

### 1.2 特性清单（来源：`README.md:40-101`）

| 特性 | 文件锚点 | 对 tdsf 价值 |
|---|---|---|
| Cloud + local LLMs | `aider/models.py` | 高 |
| Maps your codebase（RepoMap） | `aider/repomap.py` | 高 |
| 100+ 代码语言（tree-sitter） | `aider/queries/` | 中 |
| Git integration（自动 commit + undo） | `aider/repo.py` | **极高** |
| Use in your IDE（watch 模式） | `aider/watch.py` | 中 |
| Images & web pages | `aider/scrape.py` | 低 |
| Voice-to-code | `aider/voice.py` | 低（可选） |
| Linting & testing | `aider/linter.py` + `aider/coders/base_coder.py:1599-1623` | 高 |
| Copy/paste to web chat | `aider/copypaste.py` | 低 |

### 1.3 项目目录结构（来源：LS 探索）

```
aider/
├── aider/                          ← 核心源码
│   ├── coders/                     ← 编辑器核心（38 个文件）
│   │   ├── __init__.py             ← Coder 工厂注册（14 个 coder）
│   │   ├── base_coder.py           ← Coder 基类（~2500 行，最核心）
│   │   ├── architect_coder.py      ← Architect mode（48 行，planner+editor）
│   │   ├── editblock_coder.py      ← SEARCH/REPLACE 模式（657 行）
│   │   ├── wholefile_coder.py      ← 整文件模式（144 行）
│   │   ├── udiff_coder.py          ← unified diff 模式（428 行）
│   │   ├── patch_coder.py          ← V4A patch 模式（706 行）
│   │   ├── ask_coder.py            ← ask 模式（仅 9 行）
│   │   ├── *_prompts.py            ← 各模式 prompts
│   │   ├── search_replace.py       ← SEARCH/REPLACE 解析
│   │   └── shell.py                ← shell 命令 prompt
│   ├── queries/                    ← tree-sitter tags 查询（30+ 语言）
│   ├── resources/
│   │   ├── model-settings.yml      ← 357 个模型预设
│   │   └── model-metadata.json     ← 模型元数据缓存
│   ├── commands.py                 ← 命令系统（~1700 行，43 个命令）
│   ├── repo.py                     ← git 集成（622 行）
│   ├── repomap.py                  ← RepoMap（~860 行）
│   ├── models.py                   ← 模型管理（~1300 行）
│   ├── linter.py                   ← Linting（269 行）
│   ├── voice.py                    ← Voice（187 行）
│   ├── watch.py                    ← Watch 模式（318 行）
│   ├── io.py                       ← 输入输出
│   ├── main.py                     ← 主入口
│   ├── sendchat.py                 ← LLM 调用辅助
│   ├── exceptions.py               ← 异常分类（24 种 LLM 异常）
│   ├── diffs.py                    ← diff 工具
│   ├── run_cmd.py                  ← 命令执行（pexpect + subprocess）
│   └── ... 其他辅助模块
├── pyproject.toml
├── LICENSE.txt                     ← Apache-2.0
└── README.md
```

---

## 2. 整体架构图

### 2.1 启动流程（来源：`aider/main.py:451` `main()` + `:973-1007` `Coder.create()`）

```
用户终端
   │
   ▼
[aider CLI 入口] ──> main.py:main(argv)
   │
   ├──> args.py:get_parser()           ← 构建 argparse（~600 行参数定义，未深入阅读）
   ├──> 加载 .env / .aider.conf.yml
   ├──> models.Model(model_name)       ← 加载模型（含 weak/editor 模型链）
   ├──> repo.GitRepo(io, fnames, ...)  ← 定位 git 仓库根
   ├──> commands.Commands(io, coder)   ← 命令系统
   ├──> history.ChatSummary(...)       ← 历史摘要器
   ├──> Coder.create(                  ← 工厂方法，按 edit_format 选择 Coder 子类
   │       main_model, edit_format,
   │       io, repo, fnames,
   │       auto_commits, dirty_commits,
   │       auto_lint, auto_test, ...)
   │   └── 遍历 coders.__all__，匹配 edit_format
   │       返回 EditBlockCoder / WholeFileCoder / UnifiedDiffCoder /
   │             PatchCoder / ArchitectCoder / AskCoder / ...
   │
   ├──> (可选) FileWatcher(coder, gitignores)    ← watch 模式
   ├──> (可选) ClipboardWatcher(coder.io)        ← copy-paste 模式
   │
   ▼
[coder.run() 主循环] (base_coder.py:876)
   │
   └──> while True:
          ├──> io.get_input(...)            ← 读用户输入（含 / 命令补全）
          ├──> preproc_user_input(inp)
          │    ├──> if inp 是命令: commands.run(inp)
          │    └──> else: check_for_file_mentions(inp)
          ├──> run_one(user_message)        ← base_coder.py:924
          │    ├──> init_before_message()    ← 记录 commit_before_message
          │    ├──> send_message(inp)        ← base_coder.py:1419
          │    │    ├──> format_messages()   ← 拼 chat_chunks（repo+files+chat）
          │    │    ├──> send(messages)      ← 调 litellm 流式
          │    │    ├──> apply_updates()     ← 子类实现：解析 + 写文件
          │    │    ├──> auto_commit(edited) ← 沙箱 commit
          │    │    ├──> lint_edited(edited) ← auto_lint
          │    │    ├──> run_shell_commands() ← shell 命令（带审批）
          │    │    └──> cmd_test(test_cmd)  ← auto_test
          │    └──> (ArchitectCoder 特殊) reply_completed()
          │         └──> 创建 editor_coder，用 editor_model 执行 content
          └──> show_undo_hint()              ← 提示 /undo 可用
```

### 2.2 模块依赖（高层）

```
              ┌──────────────┐
              │   main.py    │
              └──────┬───────┘
                     │
        ┌────────────┼────────────┬─────────────┐
        ▼            ▼            ▼             ▼
   ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌──────────┐
   │  args   │  │ models  │  │  repo   │  │ commands │
   │  .py    │  │  .py    │  │  .py    │  │   .py    │
   └─────────┘  └────┬────┘  └────┬────┘  └────┬─────┘
                     │            │             │
                     │     ┌──────┘             │
                     ▼     ▼                    │
                ┌────────────────┐              │
                │  coders/       │◀─────────────┘
                │  base_coder.py │
                └──────┬─────────┘
                       │
          ┌────────────┼────────────┬──────────┐
          ▼            ▼            ▼          ▼
     ┌─────────┐ ┌─────────┐  ┌─────────┐ ┌─────────┐
     │ repomap │ │ linter  │  │  voice  │ │  watch  │
     │  .py    │ │  .py    │  │  .py    │ │  .py    │
     └─────────┘ └─────────┘  └─────────┘ └─────────┘
```

---

## 3. git 沙箱回滚机制（核心）

> 这是 Aider 最值得 tdsf-linux-desktop 借鉴的机制。源码主要在 `aider/repo.py` + `aider/commands.py:553-655` + `aider/coders/base_coder.py:1577-1624, 2175-2419`。

### 3.1 commit 时机策略

Aider 把 commit 分为三类，每类有独立的触发点和参数：

| commit 类型 | 触发点 | 代码锚点 | aider_edits 标志 |
|---|---|---|---|
| **auto-commit**（AI 编辑后） | `send_message` 中 `apply_updates()` 成功后 | `base_coder.py:1585-1589` | `True` |
| **dirty-commit**（编辑前先存档） | `allowed_to_edit()` 发现目标文件 dirty | `base_coder.py:2175-2189, 2411-2419` | `False` |
| **lint-commit**（lint 修复后） | `lint_edited()` 完成后 | `base_coder.py:1599-1601` | `True` |
| **手动 commit** | 用户输入 `/commit` | `commands.py:337-354` | `False` |

关键代码（`base_coder.py:1585-1601`）：

```python
edited = self.apply_updates()

if edited:
    self.aider_edited_files.update(edited)
    saved_message = self.auto_commit(edited)              # ① auto-commit
    ...
if edited and self.auto_lint:
    lint_errors = self.lint_edited(edited)
    self.auto_commit(edited, context="Ran the linter")    # ② lint-commit
    ...
```

### 3.2 auto-commit 实现

`base_coder.py:2375-2395`：

```python
def auto_commit(self, edited, context=None):
    if not self.repo or not self.auto_commits or self.dry_run:
        return
    if not context:
        context = self.get_context_from_history(self.cur_messages)
    try:
        res = self.repo.commit(fnames=edited, context=context, aider_edits=True, coder=self)
        if res:
            self.show_auto_commit_outcome(res)
            commit_hash, commit_message = res
            return self.gpt_prompts.files_content_gpt_edits.format(
                hash=commit_hash, message=commit_message,
            )
        return self.gpt_prompts.files_content_gpt_no_edits
    except ANY_GIT_ERROR as err:
        self.io.tool_error(f"Unable to commit: {str(err)}")
```

`show_auto_commit_outcome`（`base_coder.py:2397-2403`）的核心动作：

```python
def show_auto_commit_outcome(self, res):
    commit_hash, commit_message = res
    self.last_aider_commit_hash = commit_hash
    self.aider_commit_hashes.add(commit_hash)        # ★ 关键：记录到"本会话提交集合"
    self.last_aider_commit_message = commit_message
    if self.show_diffs:
        self.commands.cmd_diff()
```

`aider_commit_hashes` 是一个 `set()`，初始化在 `base_coder.py:349`，记录"本次 chat 会话中由 aider 产生的所有 commit hash"。这是 `/undo` 安全回滚的核心依据。

`repo.py:131-318` 的 `commit()` 方法做了大量归因（attribution）逻辑：
- `--attribute-author`：把 author 名改为 `"User Name (aider)"`
- `--attribute-committer`：把 committer 名改为 `"User Name (aider)"`
- `--attribute-co-authored-by`：加 `Co-authored-by: aider (<model>) <aider@aider.chat>` trailer
- `aider_edits=True` 与 `aider_edits=False` 走不同归因分支（详见 `repo.py:170-200` 的 docstring）

commit message 由弱模型生成（`repo.py:326-373` `get_commit_message`）：

```python
def get_commit_message(self, diffs, context, user_language=None):
    ...
    for model in self.models:                    # ★ 用 weak_model 优先，失败回退到 main_model
        with WaitingSpinner(f"Generating commit message with {model.name}"):
            ...
            num_tokens = model.token_count(messages)
            max_tokens = model.info.get("max_input_tokens") or 0
            if max_tokens and num_tokens > max_tokens:
                continue                          # 弱模型装不下就跳到主模型
            commit_message = model.simple_send_with_retries(messages)
            if commit_message:
                break
```

### 3.3 /undo 回滚命令

`commands.py:553-655` 的 `raw_cmd_undo` 是 Aider 安全回滚的核心，逻辑严密：

```python
def raw_cmd_undo(self, args):
    # ① 必须有 git repo
    if not self.coder.repo: ...

    # ② 必须有父提交（不能 undo 第一个 commit）
    last_commit = self.coder.repo.get_head_commit()
    if not last_commit or not last_commit.parents: ...

    # ③ ★ 关键安全闸门：只回滚 aider_commit_hashes 中记录的提交
    if last_commit_hash not in self.coder.aider_commit_hashes:
        self.io.tool_error("The last commit was not made by aider in this chat session.")
        self.io.tool_output(
            "You could try `/git reset --hard HEAD^` but be aware that this is a destructive command!"
        )
        return

    # ④ 不允许 undo merge commit（多父）
    if len(last_commit.parents) > 1: ...

    # ⑤ 检查 last_commit 涉及的所有文件：必须无未提交修改 + 必须在前一提交中存在
    for fname in changed_files_last_commit:
        if self.coder.repo.repo.is_dirty(path=fname): ...   # 拒绝
        try:
            prev_commit.tree[fname]
        except KeyError: ...                                  # 拒绝

    # ⑥ 检查是否已 push 到 origin（push 过的不允许 undo）
    if has_origin:
        if local_head == remote_head:
            self.io.tool_error("The last commit has already been pushed to the origin. Undoing is not possible.")
            return

    # ⑦ 逐文件 checkout 到 HEAD~1 版本
    for file_path in changed_files_last_commit:
        self.coder.repo.repo.git.checkout("HEAD~1", file_path)

    # ⑧ 软回退 HEAD（保留索引）
    self.coder.repo.repo.git.reset("--soft", "HEAD~1")
```

**核心设计原则**：
1. **白名单回滚** —— 只回滚本会话产生的提交（`aider_commit_hashes`），用户手动提交永远不会被 `/undo` 触及
2. **merge commit 保护** —— 多父提交拒绝回滚
3. **dirty file 保护** —— 涉及文件如果有未提交修改，拒绝回滚
4. **新文件保护** —— 如果文件在前一提交不存在（新创建的），拒绝回滚
5. **已 push 保护** —— 已推送到 origin 的提交拒绝回滚
6. **逐文件 checkout + 软 reset** —— 不是粗暴 `git reset --hard`，而是逐文件 `git checkout HEAD~1 -- <file>` 后 `git reset --soft HEAD~1`，最大限度保留工作区状态

### 3.4 dirty commit 处理

`base_coder.py:2175-2189`：

```python
def check_for_dirty_commit(self, path):
    if not self.repo: return
    if not self.dirty_commits: return
    if not self.repo.is_dirty(path): return
    self.io.tool_output(f"Committing {path} before applying edits.")
    self.need_commit_before_edits.add(path)          # 加入待 commit 集合
```

`base_coder.py:2411-2419`：

```python
def dirty_commit(self):
    if not self.need_commit_before_edits: return
    if not self.dirty_commits: return
    if not self.repo: return
    self.repo.commit(fnames=self.need_commit_before_edits, coder=self)
    return True
```

`dirty_commit()` 在 `send_message` 之前被调用（`base_coder.py` 中 `need_commit_before_edits` 在 `allowed_to_edit` 中累积）。其设计动机见注释（`base_coder.py:2183`）：

> `# We need a committed copy of the file in order to /undo, so skip this`

**即**：如果用户对一个 dirty 文件让 aider 编辑，必须先把 dirty 状态固化成一个 commit，否则 `/undo` 没有干净的"前一版本"可回滚。

### 3.5 git 配置检测

`repo.py:62-126` 的 `GitRepo.__init__`：
- 用 `git.Repo(fname, search_parent_directories=True)` 向上查找仓库根
- 支持多 repo 检测：如果传入文件分属多个 repo，报错并 raise FileNotFoundError
- 支持 `subtree_only` 模式（只允许在当前子树下操作）
- 支持 `.aiderignore` 文件（pathspec GitWildMatchPattern）
- `aider_ignore_ts` + `aider_ignore_last_check` 实现 1 秒粒度的 ignore 文件 mtime 缓存

### 3.6 借鉴建议：tdsf-linux-desktop 的运维命令回滚

**Aider 模型 vs 运维场景的差异**：

| 维度 | Aider | tdsf 运维 |
|---|---|---|
| 修改对象 | 本地代码文件 | 远程主机配置（systemd unit / nginx.conf / sysctl / crontab ...） |
| 回滚粒度 | 单文件 git diff | 主机配置快照（文件 + 服务状态） |
| 风险等级 | 中（代码错误可重新编辑） | **高**（运维错误可能导致服务中断） |
| 审批要求 | 默认自动执行 | **必须人工审批**（硬约束） |

**三层回滚方案（按落地难度递增）**：

#### 方案 A（P0，立即可落地）：远程主机 git 沙箱

在每台被管主机上为 `/etc`、`/usr/local/bin`、`/opt/<app>/conf` 等关键目录初始化 git 仓库（或统一一个 root 仓库），tdsf Agent 每次执行前：

```typescript
// 伪代码：tdsf Agent 沙箱
class HostSandbox {
  async beforeEdit(host: Host, files: string[]): Promise<CheckpointRef> {
    // 1. SFTP 上传当前文件到 host:/tmp/<checkpoint>/.prev/
    // 2. 在 host 上 git add + commit（如果主机有 git 仓库）
    // 3. 记录 checkpoint = { host, commitHash, files, ts }
    return checkpoint;
  }

  async rollback(checkpoint: CheckpointRef): Promise<void> {
    // 1. 在 host 上 git checkout <commitHash> -- <files>
    // 2. 重启受影响的服务
    // 3. 验证服务健康
  }
}
```

**TS 等价实现路径**：
- `aider/repo.py` 的 `GitRepo` → tdsf 的 `HostGitSandbox` 类（用 `ssh2` 或 `node-ssh` 执行远程 git 命令）
- `aider_commit_hashes` → `Map<hostId, Set<checkpointRef>>`，只回滚本会话产生的 checkpoint
- `/undo` → tdsf UI 的"回滚最近一次操作"按钮，强制人工确认

#### 方案 B（P1，中期）：ZFS/Btrfs 快照

对于支持 ZFS/Btrfs 的主机，每步执行前 `zfs snapshot pool/dataset@tdsf-<ts>`，回滚即 `zfs rollback`。优势：文件系统级一致快照，可回滚整个 dataset。劣势：需要主机预先配置 ZFS/Btrfs。

#### 方案 C（P2，长期）：etcd/Consul 配置版本化

所有运维变更走 etcd/Consul KV（带版本号），文件由配置渲染生成。回滚即回退到前一版本 KV。优势：集中式版本控制，跨主机一致。劣势：需要重构配置管理流程。

**人工审批闸门**（硬约束落地）：

```typescript
// 每个 Agent 步骤必须经过此闸门
async function approveGate(action: AgentAction): Promise<ApprovedAction> {
  const diff = await renderDiff(action.beforeState, action.afterState);
  const rollbackHint = await renderRollbackHint(action.checkpoint);
  
  // UI 弹窗显示：变更内容 + 回滚方案 + 风险评级
  const decision = await showApprovalDialog({
    title: `审批：${action.title}`,
    diff,
    rollbackHint,
    riskLevel: action.riskLevel,
    buttons: ['批准执行', '拒绝', '修改后重试'],
  });
  
  if (decision === '拒绝') throw new ActionRejectedError();
  if (decision === '修改后重试') return retryWithEdit();
  return action;
}
```

---

## 4. RepoMap（仓库结构理解）

> 源码：`aider/repomap.py`（~860 行）+ `aider/queries/tree-sitter-language-pack/*.scm`（30+ 语言）

### 4.1 树状结构生成

`repomap.py:748-784` 的 `to_tree()` 把排序后的 tags 渲染为树状文本：

```python
def to_tree(self, tags, chat_rel_fnames):
    if not tags: return ""
    cur_fname = None
    lois = None
    output = ""
    dummy_tag = (None,)                # 哨兵，触发最后一个文件输出
    for tag in sorted(tags) + [dummy_tag]:
        this_rel_fname = tag[0]
        if this_rel_fname in chat_rel_fnames:
            continue                    # ★ 跳过用户当前在聊的文件（已在上下文）
        if this_rel_fname != cur_fname:
            if lois is not None:
                output += "\n" + cur_fname + ":\n"
                output += self.render_tree(cur_abs_fname, cur_fname, lois)
                lois = None
            elif cur_fname:
                output += "\n" + cur_fname + "\n"   # 无 tags 的文件只列名
            if type(tag) is Tag:
                lois = []
                cur_abs_fname = tag.fname
            cur_fname = this_rel_fname
        if lois is not None:
            lois.append(tag.line)
    output = "\n".join([line[:100] for line in output.splitlines()]) + "\n"
    return output
```

`render_tree()`（`repomap.py:710-746`）用 `grep_ast.TreeContext` 渲染：只显示 lines_of_interest（def/ref 所在行）+ 必要的父作用域上下文，类似 IDE 的 "outline + 局部代码" 视图。

### 4.2 重要性评分

`repomap.py:365-574` 的 `get_ranked_tags()` 是核心算法：

**步骤 1：tree-sitter 提取 tags**（`repomap.py:279-363` `get_tags_raw`）

```python
def get_tags_raw(self, fname, rel_fname):
    lang = filename_to_lang(fname)
    language = get_language(lang)
    parser = get_parser(lang)
    query_scm = get_scm_fname(lang)             # 加载 .scm 查询文件
    code = self.io.read_text(fname)
    tree = parser.parse(bytes(code, "utf-8"))
    captures = self._run_captures(Query(language, query_scm), tree.root_node)
    for node, tag in all_nodes:
        if tag.startswith("name.definition."):
            kind = "def"                         # 定义
        elif tag.startswith("name.reference."):
            kind = "ref"                         # 引用
        yield Tag(rel_fname, fname, node.text.decode("utf-8"), kind, node.start_point[0])
    # 回退：如果只有 def 没有 ref（如 cpp），用 pygments 补 ref
    if "ref" not in saw and "def" in saw:
        lexer = guess_lexer_for_filename(fname, code)
        tokens = [t[1] for t in lexer.get_tokens(code) if t[0] in Token.Name]
        for token in tokens:
            yield Tag(rel_fname, fname, token, "ref", -1)
```

**步骤 2：构建引用图 + PageRank**（`repomap.py:365-574`）

```python
def get_ranked_tags(self, chat_fnames, other_fnames, mentioned_fnames, mentioned_idents, progress=None):
    import networkx as nx
    defines = defaultdict(set)      # ident → {rel_fname, ...}
    references = defaultdict(list)  # ident → [rel_fname, ...]
    personalization = dict()         # PageRank 个性化向量

    # 1. 扫描所有文件，收集 def/ref
    for fname in fnames:
        rel_fname = self.get_rel_fname(fname)
        current_pers = 0.0
        if fname in chat_fnames:
            current_pers += personalize           # ★ chat 中的文件加个性化权重
            chat_rel_fnames.add(rel_fname)
        if rel_fname in mentioned_fnames:
            current_pers = max(current_pers, personalize)
        # ... mentioned_idents 匹配路径组件
        if current_pers > 0:
            personalization[rel_fname] = current_pers

        tags = list(self.get_tags(fname, rel_fname))
        for tag in tags:
            if tag.kind == "def":
                defines[tag.name].add(rel_fname)
                definitions[(rel_fname, tag.name)].add(tag)
            elif tag.kind == "ref":
                references[tag.name].append(rel_fname)

    # 2. 构建有向多重图
    G = nx.MultiDiGraph()
    for ident in idents:                            # 同时被定义和引用的 ident
        definers = defines[ident]
        mul = 1.0
        is_snake = ("_" in ident) and any(c.isalpha() for c in ident)
        is_kebab = ("-" in ident) and any(c.isalpha() for c in ident)
        is_camel = any(c.isupper() for c in ident) and any(c.islower() for c in ident)
        if ident in mentioned_idents: mul *= 10     # 用户提到的 ident 加权
        if (is_snake or is_kebab or is_camel) and len(ident) >= 8: mul *= 10   # 长 ident 更独特
        if ident.startswith("_"): mul *= 0.1        # 私有标识符降权
        if len(defines[ident]) > 5: mul *= 0.1      # 在 >5 个文件中定义的降权（如通用 helper）

        for referencer, num_refs in Counter(references[ident]).items():
            for definer in definers:
                use_mul = mul
                if referencer in chat_rel_fnames:
                    use_mul *= 50                   # ★ chat 中文件引用的 ident 大幅加权
                num_refs = math.sqrt(num_refs)      # 平方根降频，避免高频引用主导
                G.add_edge(referencer, definer, weight=use_mul * num_refs, ident=ident)

    # 3. PageRank
    ranked = nx.pagerank(G, weight="weight", personalization=personalization, dangling=personalization)

    # 4. 把 rank 分摊到每条边 → 每个 (file, ident) 定义点
    ranked_definitions = defaultdict(float)
    for src in G.nodes:
        src_rank = ranked[src]
        total_weight = sum(data["weight"] for _src, _dst, data in G.out_edges(src, data=True))
        for _src, dst, data in G.out_edges(src, data=True):
            data["rank"] = src_rank * data["weight"] / total_weight
            ranked_definitions[(dst, data["ident"])] += data["rank"]

    # 5. 按 rank 降序输出 tags
    ranked_tags = []
    for (fname, ident), rank in sorted(ranked_definitions.items(), reverse=True):
        if fname in chat_rel_fnames: continue       # chat 文件已在上下文，跳过
        ranked_tags += list(definitions.get((fname, ident), []))
    return ranked_tags
```

**关键加权规则**（影响重要性评分）：
- chat 中的文件作为 referencer：×50
- 用户提到的 ident：×10
- 长 ident（snake/kebab/camel 且 ≥8 字符）：×10
- 私有 ident（`_` 开头）：×0.1
- 定义在 >5 个文件中的 ident：×0.1
- 高频引用：sqrt 降频

### 4.3 token budget 控制

`repomap.py:629-706` 的 `get_ranked_tags_map_uncached`：

```python
def get_ranked_tags_map_uncached(self, chat_fnames, other_fnames, max_map_tokens, ...):
    ranked_tags = self.get_ranked_tags(chat_fnames, other_fnames, ...)
    num_tags = len(ranked_tags)
    lower_bound = 0
    upper_bound = num_tags
    best_tree = None
    best_tree_tokens = 0

    middle = min(int(max_map_tokens // 25), num_tags)
    while lower_bound <= upper_bound:
        tree = self.to_tree(ranked_tags[:middle], chat_rel_fnames)
        num_tokens = self.token_count(tree)
        pct_err = abs(num_tokens - max_map_tokens) / max_map_tokens
        ok_err = 0.15
        if (num_tokens <= max_map_tokens and num_tokens > best_tree_tokens) or pct_err < ok_err:
            best_tree = tree
            best_tree_tokens = num_tokens
            if pct_err < ok_err:
                break
        if num_tokens < max_map_tokens:
            lower_bound = middle + 1
        else:
            upper_bound = middle - 1
        middle = int((lower_bound + upper_bound) // 2)
    return best_tree
```

**二分搜索 token budget**：用二分查找逼近 `max_map_tokens`，允许 15% 误差。`token_count`（`repomap.py:89-101`）对长文本用采样估算（每 100 行采样 1 行 ×100 估算），避免逐字符 tokenize 的开销。

`get_repo_map`（`repomap.py:103-167`）的动态调整：
- 当 chat_files 为空时，给整个 repo 更大视图（`max_map_tokens * map_mul_no_files`，默认 8 倍）
- 上限为 `max_context_window - 4096`（保留 padding）

### 4.4 缓存

- **tags 缓存**：diskcache 持久化到 `.aider.tags.cache.v4/`，key = fname，value = `{mtime, data}`，文件 mtime 不变即命中（`repomap.py:233-264`）
- **map 缓存**：内存 `self.map_cache = {}`，key = (chat_fnames, other_fnames, max_tokens, mentioned_*), TTL 由 `refresh` 参数控制（`auto`/`files`/`manual`/`always`）
- **SQLite 错误降级**：如果 diskcache 损坏，自动重建；重建失败降级为 `dict()` 内存缓存（`repomap.py:177-215`）

### 4.5 借鉴建议：tdsf-linux-desktop 的运维主机拓扑理解

**Aider RepoMap → tdsf HostMap** 的概念映射：

| Aider | tdsf |
|---|---|
| 文件 | 主机（host） |
| 函数/类定义 | 主机上的服务（systemd unit、docker container、进程） |
| 函数引用 | 服务依赖（A 依赖 B 的 API） |
| chat_files | 当前任务涉及的主机 |
| other_files | 同集群其他主机 |
| `mentioned_idents` | 用户在对话中提到的服务名/主机名 |
| max_map_tokens | max_map_tokens（运维场景可设 2k-4k） |

**实现路径**：

1. **数据采集层**：用 SSH 采集主机的 systemd unit 列表、docker ps、监听端口、进程树，构建"主机-服务-依赖"三元组
2. **图构建**：用 `networkx`（有 TS 移植版 `graphlib` 或 `cytoscape`）构建有向图，节点 = 主机，边 = "主机 A 的服务 X 依赖主机 B 的服务 Y"
3. **PageRank + 个性化**：用户当前选中的主机/personalization 加权，输出"拓扑摘要"作为 LLM 上下文
4. **token budget 二分**：同 Aider 算法

**降级方案**：如果不想引入 PageRank，可用更简单的"主机拓扑树 + 服务列表"文本摘要，配合用户选择的主机加权。

---

## 5. 多种 edit format

> Aider 支持 14 种 Coder 子类（见 `aider/coders/__init__.py:18-34`），其中 5 种是核心 edit format。

### 5.1 wholefile 模式（`wholefile_coder.py` + `wholefile_prompts.py`）

**核心思想**：让 LLM 输出整个文件的完整内容，用三反引号 fence 包裹，文件名在前一行。

**prompt 节选**（`wholefile_prompts.py:42-62`）：

```
To suggest changes to a file you MUST return the entire content of the updated file.
You MUST use this *file listing* format:

path/to/filename.js
{fence[0]}
// entire file content ...
// ... goes in between
{fence[1]}

*NEVER* skip, omit or elide content from a *file listing* using "..." or by adding comments like "... rest of code..."!
```

**解析逻辑**（`wholefile_coder.py:22-122` `get_edits`）：
- 逐行扫描，遇到 `fence[0]` 开始一个 block
- block 前一行作为 filename（处理 `**filename.py**`、`filename.py:`、`` `filename.py` `` 等变体）
- 单 chat 文件时省略 filename 也能识别
- 优先级：`block` > `saw` > `chat`（同名文件只取最高优先级的 edit）

**优点**：实现简单，对小文件友好，LLM 不需要学习特殊语法
**缺点**：大文件浪费 token；LLM 可能省略"无关"代码

### 5.2 editblock（search-replace）模式（`editblock_coder.py` + `editblock_prompts.py`）

**核心思想**：LLM 输出 SEARCH/REPLACE 块，SEARCH 部分必须精确匹配现有代码，REPLACE 部分是替换内容。

**prompt 节选**（`editblock_prompts.py:120-159`）：

```
Every *SEARCH/REPLACE block* must use this format:
1. The *FULL* file path alone on a line, verbatim.
2. The opening fence and code language, eg: {fence[0]}python
3. The start of search block: <<<<<<< SEARCH
4. A contiguous chunk of lines to search for in the existing source code
5. The dividing line: =======
6. The lines to replace into the source code
7. The end of the replace block: >>>>>>> REPLACE
8. The closing fence: {fence[1]}

Every *SEARCH* section must *EXACTLY MATCH* the existing file content, character for character.
```

**正则定义**（`editblock_coder.py:386-388`）：

```python
HEAD = r"^<{5,9} SEARCH>?\s*$"
DIVIDER = r"^={5,9}\s*$"
UPDATED = r"^>{5,9} REPLACE\s*$"
```

**匹配策略**（`editblock_coder.py:127-329`，从精确到模糊）：
1. `perfect_replace`：精确匹配（`perfect_or_whitespace`）
2. `replace_part_with_missing_leading_whitespace`：GPT 经常弄错缩进，统一去前导空白后匹配
3. `try_dotdotdots`：处理 LLM 用 `...` 省略代码的情况（按 `...` 切片分别匹配）
4. `replace_closest_edit_distance`：相似度 ≥0.8 的最近匹配（默认禁用）

**失败处理**（`editblock_coder.py:79-124`）：失败的块用 `find_similar_lines` 找最相似的代码段，作为"Did you mean..."附加到错误信息，让 LLM 自我修正。

**优点**：token 高效；只改必要部分；错误信息友好
**缺点**：LLM 需要学习语法；SEARCH 块要求精确匹配，对长代码块容易出错

### 5.3 udiff 模式（`udiff_coder.py` + `udiff_prompts.py`）

**核心思想**：LLM 输出 `diff -U0` 风格的 unified diff，但省略行号。

**prompt 节选**（`udiff_prompts.py:74-108`）：

```
Return edits similar to unified diffs that `diff -U0` would produce.
Start each hunk of changes with a `@@ ... @@` line.
Don't include line numbers like `diff -U0` does.
When editing a function, method, loop, etc use a hunk to replace the *entire* code block.
```

**解析逻辑**（`udiff_coder.py:312-400` `find_diffs` + `process_fenced_block`）：
- 只识别 ` ```diff ` 开头的 fence 块
- 解析 `--- a/path` / `+++ b/path` 头部
- 按 `@@ ... @@` 切分 hunks
- `hunk_to_before_after`（`udiff_coder.py:403-428`）：`-` 行入 before，`+` 行入 after，` ` 行入两者

**应用策略**（`udiff_coder.py:151-198` `apply_hunk`）：
1. `directly_apply_hunk`：直接 SEARCH/REPLACE 式应用
2. `make_new_lines_explicit`：如果 LLM 省略了部分上下文，用 `diff_lines` 补全
3. `apply_partial_hunk`：分段应用（preceding_context + changes + following_context）

**错误处理**：区分 `UnifiedDiffNoMatch`（找不到匹配）和 `UnifiedDiffNotUnique`（匹配不唯一）

### 5.4 patch 模式（`patch_coder.py` + `patch_prompts.py`）

**核心思想**：V4A diff 格式（类似 OpenAI Codex 的 apply_patch），用 `*** Begin Patch` / `*** End Patch` 包裹，支持 Add/Update/Delete/Move 四种动作。

**prompt 节选**（`patch_prompts.py:116-158`）：

```
Your entire response containing the patch MUST start with `*** Begin Patch` on a line by itself.
Your entire response containing the patch MUST end with `*** End Patch` on a line by itself.

For each file you need to modify, start with a marker line:
    *** [ACTION] File: [path/to/file]
Where `[ACTION]` is one of `Add`, `Update`, or `Delete`.

⇨ **Each file MUST appear only once in the patch.**
   Consolidate all changes for that file into the same block.

For `Update` actions:
1. Context lines: Include 3 lines of context *before* the change. These lines MUST start with a single space ` `.
2. Lines to remove: Preceded each line to be removed with a minus sign `-`.
3. Lines to add: Preceded each line to be added with a plus sign `+`.
4. Context lines: Include 3 lines of context *after* the change.

If 3 lines of context is insufficient to uniquely identify the snippet, use `@@ [CLASS_OR_FUNCTION_NAME]` markers.
```

**解析逻辑**（`patch_coder.py:290-410` `_parse_patch_text`）：
- 用 `find_context`（`patch_coder.py:59-93`）在原文件中定位上下文块，支持三级 fuzz：精确 → rstrip → strip（fuzz level 0/1/100）
- 支持 `*** End of File` 标记，定位到文件末尾
- `peek_next_section`（`patch_coder.py:96-191`）解析 context/-/+ 行

**应用逻辑**（`patch_coder.py:642-706` `_apply_update`）：
- chunks 按原始行号排序
- 逐 chunk 验证 del_lines 是否匹配实际文件内容
- 不匹配则 raise `DiffError`，附带 expected vs actual 对比

**优点**：支持 Add/Update/Delete/Move 全套操作；`@@` scope 标记可定位嵌套作用域；fuzz 容错
**缺点**：prompt 最长最复杂；LLM 学习成本高

### 5.5 architect / ask / help / context 模式

| 模式 | 文件 | edit_format | 行为 |
|---|---|---|---|
| **architect** | `architect_coder.py` | `"architect"` | planner 出指令，editor_coder 执行（详见 §6） |
| **ask** | `ask_coder.py`（9 行） | `"ask"` | 只问不改，不调用 `apply_edits` |
| **help** | `help_coder.py` | `"help"` | 回答使用帮助问题 |
| **context** | `context_coder.py` | `"context"` | 自动识别需要编辑的文件 |

`ask_coder.py` 全文：

```python
from .ask_prompts import AskPrompts
from .base_coder import Coder

class AskCoder(Coder):
    """Ask questions about code without making any changes."""
    edit_format = "ask"
    gpt_prompts = AskPrompts()
```

### 5.6 editor-* 子模式

为 Architect mode 服务，从 `__init__.py:6-8` 看：
- `EditorEditblockCoder`（`editor_editblock_coder.py`）：editor 用 search-replace 格式
- `EditorWholeFileCoder`（`editor_whole_coder.py`）：editor 用 whole 格式
- `EditorDiffFencedCoder`（`editor_diff_fenced_coder.py`）：editor 用 diff-fenced 格式

`models.py:640-644` 的自动推导：

```python
if not self.editor_edit_format:
    self.editor_edit_format = self.editor_model.edit_format
    if self.editor_edit_format in ("diff", "whole", "diff-fenced"):
        self.editor_edit_format = "editor-" + self.editor_edit_format
```

### 5.7 借鉴建议：tdsf-linux-desktop 的 SftpManager + Monaco diff 选择

**运维场景的"edit format"映射**：

| Aider edit format | tdsf 运维场景 |
|---|---|
| wholefile | 全量覆盖配置文件（小文件，如 `/etc/hostname`） |
| editblock (search-replace) | 局部修改大配置文件（如 `nginx.conf` 改 server 块） |
| udiff | 给用户展示变更预览（Monaco diff editor 原生支持 unified diff） |
| patch | 跨多文件批量变更（如同时改 `nginx.conf` + `php-fpm.conf`） |

**推荐落地组合**：

1. **默认：editblock（search-replace）** —— 运维配置文件多为结构化文本（INI/YAML/JSON/conf），SEARCH/REPLACE 块对 LLM 友好且 token 高效
2. **预览：udiff** —— 用 Monaco Diff Editor 直接渲染 unified diff，用户审批
3. **回滚：基于 §3 的 git 沙箱**

**TS 实现要点**：
- 在 `SftpManager` 中增加 `applySearchReplace(remotePath, search, replace)` 方法
- 用 `diff` npm 包生成 unified diff 给 Monaco 渲染
- 错误处理借鉴 `editblock_coder.py:79-124` 的 `find_similar_lines`：匹配失败时给 LLM 反馈"最相似的代码段"

---

## 6. Architect mode（planner + editor）

> 源码：`aider/coders/architect_coder.py`（48 行，全文）+ `aider/coders/architect_prompts.py`（40 行）

### 6.1 planner + editor 分离

`architect_coder.py` 全文：

```python
from .architect_prompts import ArchitectPrompts
from .ask_coder import AskCoder
from .base_coder import Coder


class ArchitectCoder(AskCoder):
    edit_format = "architect"
    gpt_prompts = ArchitectPrompts()
    auto_accept_architect = False

    def reply_completed(self):
        content = self.partial_response_content

        if not content or not content.strip():
            return

        # ① 人工审批闸门（除非 --auto-accept-architect）
        if not self.auto_accept_architect and not self.io.confirm_ask("Edit the files?"):
            return

        kwargs = dict()

        # ② editor_model 优先用 main_model.editor_model，否则回退到 main_model
        editor_model = self.main_model.editor_model or self.main_model

        kwargs["main_model"] = editor_model
        kwargs["edit_format"] = self.main_model.editor_edit_format    # ★ editor 用专门的 edit_format
        kwargs["suggest_shell_commands"] = False
        kwargs["map_tokens"] = 0                                       # ★ editor 不需要 repo map
        kwargs["total_cost"] = self.total_cost
        kwargs["cache_prompts"] = False
        kwargs["num_cache_warming_pings"] = 0
        kwargs["summarize_from_coder"] = False

        new_kwargs = dict(io=self.io, from_coder=self)
        new_kwargs.update(kwargs)

        # ③ 创建 editor_coder，用其 run(with_message=content) 直接执行
        editor_coder = Coder.create(**new_kwargs)
        editor_coder.cur_messages = []
        editor_coder.done_messages = []

        if self.verbose:
            editor_coder.show_announcements()

        editor_coder.run(with_message=content, preproc=False)

        # ④ 把 architect 的对话"撤回"，避免污染 editor 的上下文
        self.move_back_cur_messages("I made those changes to the files.")
        self.total_cost = editor_coder.total_cost
        self.aider_commit_hashes = editor_coder.aider_commit_hashes    # ★ commit 哈希继承
```

`architect_prompts.py` 关键 system prompt：

```
Act as an expert architect engineer and provide direction to your editor engineer.
Study the change request and the current code.
Describe how to modify the code to complete the request.
The editor engineer will rely solely on your instructions, so make them unambiguous and complete.
Explain all needed code changes clearly and completely, but concisely.
Just show the changes needed.

DO NOT show the entire updated function/file/etc!
```

**核心设计**：
1. **planner（architect）** 用强模型（如 claude-opus-4-7、gpt-5.5-pro），只输出自然语言指令，不写代码
2. **editor** 用便宜模型（如 claude-haiku-4-5、gpt-4o-mini），用 editor_edit_format 执行实际编辑
3. **planner 与 editor 上下文隔离** —— `editor_coder.cur_messages = []` + `done_messages = []`，editor 只看到 architect 输出的 content 作为唯一 user message
4. **commit 哈希继承** —— `aider_commit_hashes = editor_coder.aider_commit_hashes`，保证 `/undo` 能回滚 architect 触发的所有 commit
5. **人工审批闸门** —— 默认 `auto_accept_architect = False`，必须用户确认 `"Edit the files?"` 才执行

### 6.2 借鉴建议：对比 Kilo Code 的 Plan/Code 模式

**Kilo Code Plan/Code vs Aider Architect/Editor 对比**：

| 维度 | Aider Architect | Kilo Code Plan |
|---|---|---|
| planner 输出 | 自然语言指令 | 自然语言 + 文件清单 |
| editor 输入 | 仅 planner 的 content | plan + 完整文件上下文 |
| 上下文隔离 | 强（editor 清空 cur/done messages） | 弱（保留完整历史） |
| 模型分层 | 显式 `editor_model`（可独立配置） | 通常用同一模型 |
| 审批闸门 | 默认强制 | 可选 |
| commit 哈希 | 继承（保证 /undo 可用） | 无此概念 |
| repo map | planner 用，editor 不用 | 都用 |

**对 tdsf-linux-desktop 运维 Agent 的启示**：

运维场景的"planner + editor"应升级为"**planner + reviewer + executor**"三段式：

1. **planner**（强模型，如 claude-opus-4-7）：
   - 输入：用户需求 + HostMap + 当前主机状态
   - 输出：自然语言执行计划（"重启 nginx 前先 backup，改完语法检查，再 reload"）
   - 不写实际命令

2. **reviewer**（人工审批闸门，硬约束）：
   - 输入：planner 的计划 + editor 草拟的命令
   - 输出：批准 / 拒绝 / 修改建议
   - 强制 UI 弹窗，显示 diff + 回滚方案 + 风险评级

3. **executor**（便宜模型，如 claude-haiku-4-5）：
   - 输入：planner 的计划 + reviewer 批准
   - 输出：实际 shell 命令 / 配置文件 diff
   - 用 `editor-diff` 或 `editor-whole` 格式（运维场景简化为"全量覆盖"或"search-replace"）

**TS 落地**：

```typescript
class OpsArchitect {
  async plan(userReq: string, hostMap: HostMap): Promise<Plan> {
    const planner = new LLMClient({ model: 'claude-opus-4-7' });
    const content = await planner.chat([
      { role: 'system', content: ARCHITECT_SYSTEM_PROMPT },
      { role: 'user', content: `${userReq}\n\nHostMap:\n${hostMap.render()}` },
    ]);
    return { content, checkpoint: await this.snapshot() };
  }

  async review(plan: Plan): Promise<Decision> {
    // 硬约束：人工审批
    return await showApprovalDialog(plan);
  }

  async execute(plan: Plan, host: Host): Promise<Result> {
    const editor = new LLMClient({ model: 'claude-haiku-4-5' });
    const cmds = await editor.chat([
      { role: 'system', content: EDITOR_SYSTEM_PROMPT },
      { role: 'user', content: plan.content },
    ]);
    // executor 输出的命令再次人工审批（双层闸门）
    await showCommandApprovalDialog(cmds);
    return await this.sandbox.run(cmds, plan.checkpoint);
  }
}
```

---

## 7. 命令系统

> 源码：`aider/commands.py`（~1700 行，43 个命令）

### 7.1 内置命令清单

通过反射 `cmd_xxx` 方法自动注册（`commands.py:276-285` `get_commands`）。完整清单（来自 `commands.py` grep）：

| 命令 | 文件锚点 | 说明 |
|---|---|---|
| `/model` | `:87` | 切换主模型 |
| `/editor-model` | `:114` | 切换 editor 模型 |
| `/weak-model` | `:126` | 切换 weak 模型 |
| `/chat-mode` | `:138` | 切换 chat 模式（help/ask/code/architect/context） |
| `/models` | `:209` | 搜索可用模型 |
| `/web` | `:219` | 抓取网页转 markdown 加入对话 |
| `/commit` | `:337` | 提交 chat 外的编辑 |
| `/lint` | `:356` | 对 chat 内文件或 dirty 文件做 lint |
| `/clear` | `:411` | 清空 chat 历史 |
| `/reset` | `:439` | 丢弃所有文件 + 清空 chat |
| `/tokens` | `:445` | 报告 token 使用情况 |
| **`/undo`** | `:553` | **回滚最后一次 aider commit**（详见 §3.3） |
| `/diff` | `:657` | 显示自上一条消息以来的 diff |
| `/add` | `:799` | 添加文件到 chat |
| `/drop` | `:912` | 从 chat 移除文件 |
| `/git` | `:967` | 执行 git 命令（输出不入 chat） |
| `/test` | `:993` | 运行测试命令，非零退出则加入 chat |
| `/run` / `!` | `:1013` | 运行 shell 命令，可选加入 chat |
| `/exit` / `/quit` | `:1055` / `:1060` | 退出 |
| `/ls` | `:1064` | 列出所有已知文件 |
| `/help` | `:1119` | 显示帮助 |
| `/ask` | `:1182` | ask 模式 |
| `/code` | `:1186` | code 模式 |
| `/architect` | `:1190` | architect 模式 |
| `/context` | `:1194` | context 模式 |
| `/ok` | `:1198` | `/code Ok, please go ahead...` 的别名 |
| `/voice` | `:1252` | 录音转文字 |
| `/paste` | `:1278` | 粘贴图片或文本 |
| `/read-only` | `:1328` | 以只读模式添加文件 |
| `/map` | `:1418` | 打印当前 repo map |
| `/map-refresh` | `:1426` | 强制刷新 repo map |
| `/settings` | `:1432` | 打印当前设置 |
| `/load` | `:1465` | 从文件加载并执行命令 |
| `/save` | `:1497` | 保存当前 chat 的文件命令到文件 |
| `/multiline-mode` | `:1524` | 切换多行模式 |
| `/copy` | `:1528` | 复制最后一条消息到剪贴板 |
| `/report` | `:1555` | 打开 issue 报告 |
| `/editor` | `:1569` | 用 $EDITOR 编辑输入 |
| `/edit` | `:1576` | `/editor` 的别名 |
| `/think-tokens` | `:1580` | 设置 thinking tokens |
| `/reasoning-effort` | `:1615` | 设置 reasoning effort |
| `/copy-context` | `:1638` | 复制代码上下文到剪贴板 |

### 7.2 命令解析

`commands.py:255-332`：

```python
def is_command(self, inp):
    return inp[0] in "/!"              # / 开头是命令，! 开头是 /run 别名

def get_commands(self):
    commands = []
    for attr in dir(self):              # ★ 反射：所有 cmd_xxx 方法
        if not attr.startswith("cmd_"):
            continue
        cmd = attr[4:]
        cmd = cmd.replace("_", "-")     # cmd_undo → /undo
        commands.append("/" + cmd)
    return commands

def do_run(self, cmd_name, args):
    cmd_name = cmd_name.replace("-", "_")
    cmd_method = getattr(self, f"cmd_{cmd_name}", None)
    if not cmd_method: ...
    return cmd_method(args)

def matching_commands(self, inp):
    words = inp.strip().split()
    first_word = words[0]
    rest_inp = inp[len(words[0]):].strip()
    all_commands = self.get_commands()
    matching_commands = [cmd for cmd in all_commands if cmd.startswith(first_word)]
    return matching_commands, first_word, rest_inp

def run(self, inp):
    if inp.startswith("!"):
        return self.do_run("run", inp[1:])          # ! alias
    res = self.matching_commands(inp)
    if len(matching_commands) == 1:                  # 唯一前缀匹配
        return self.do_run(command, rest_inp)
    elif first_word in matching_commands:            # 精确匹配优先
        return self.do_run(command, rest_inp)
    elif len(matching_commands) > 1:
        self.io.tool_error(f"Ambiguous command: {', '.join(matching_commands)}")
```

**特性**：
- **反射注册** —— 加 `cmd_xxx` 方法即可扩展命令，无需修改注册表
- **前缀匹配** —— `/un` 自动匹配 `/undo`（如果唯一）
- **歧义检测** —— 多个匹配时报 "Ambiguous command"
- **`!` 别名** —— `!ls -la` 等价于 `/run ls -la`
- **Tab 补全** —— `completions_xxx` / `completions_raw_xxx` 方法提供补全（未深入阅读）

### 7.3 SwitchCoder 机制

`commands.py:30-34`：

```python
class SwitchCoder(Exception):
    def __init__(self, placeholder=None, **kwargs):
        self.kwargs = kwargs
        self.placeholder = placeholder
```

`/ask`、`/code`、`/architect`、`/context` 等模式切换命令通过抛出 `SwitchCoder` 异常中断当前循环，主循环捕获后用新参数重建 Coder（`base_coder.py:204` `clone()`）。这种"异常即控制流"的设计简化了模式切换的状态机。

### 7.4 借鉴建议

**反射式命令系统的 TS 实现**：

```typescript
// commands.ts
import 'reflect-metadata';

const COMMAND_METADATA = Symbol('command');

export function command(description: string) {
  return function (target: any, propertyKey: string) {
    Reflect.defineMetadata(COMMAND_METADATA, { description, name: propertyKey }, target, propertyKey);
  };
}

export class OpsCommands {
  @command('回滚最后一次运维操作')
  async undo(args: string): Promise<string> { /* ... */ }

  @command('列出当前主机的服务')
  async ls(args: string): Promise<string> { /* ... */ }

  @command('执行 shell 命令（带审批）')
  async run(args: string): Promise<string> { /* ... */ }
}

// 运行时反射收集命令
function getCommands(target: any): Command[] {
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(target))
    .filter(m => m !== 'constructor' && typeof target[m] === 'function');
  return methods.map(m => {
    const meta = Reflect.getMetadata(COMMAND_METADATA, target, m);
    return meta ? { name: `/${m}`, ...meta } : null;
  }).filter(Boolean);
}
```

**对 tdsf 运维 Agent 的命令设计**：

| 命令 | 等价 Aider | 运维语义 |
|---|---|---|
| `/undo` | `/undo` | 回滚最近一次运维操作（基于 §3 沙箱） |
| `/diff` | `/diff` | 显示主机配置变更 |
| `/commit` | `/commit` | 固化当前变更（不再可 /undo） |
| `/add <host>` | `/add <file>` | 把主机加入当前任务 |
| `/drop <host>` | `/drop <file>` | 移除主机 |
| `/map` | `/map` | 显示 HostMap |
| `/lint <file>` | `/lint` | 验证配置文件语法 |
| `/test <cmd>` | `/test` | 执行测试命令 |
| `/run <cmd>` | `/run` | 执行 shell（带审批） |
| `/save` / `/load` | `/save` / `/load` | 保存/恢复会话 |
| `/settings` | `/settings` | 显示当前配置 |

---

## 8. 模型管理

> 源码：`aider/models.py`（~1300 行）+ `aider/resources/model-settings.yml`（357 个模型）+ `aider/resources/model-metadata.json`

### 8.1 ModelInfo / ModelSettings

**ModelSettings 数据类**（`models.py:127-150`）：

```python
@dataclass
class ModelSettings:
    name: str
    edit_format: str = "whole"
    weak_model_name: Optional[str] = None
    use_repo_map: bool = False
    send_undo_reply: bool = False
    lazy: bool = False
    overeager: bool = False
    reminder: str = "user"                  # "user" / "sys" / None
    examples_as_sys_msg: bool = False
    extra_params: Optional[dict] = None
    cache_control: bool = False             # Anthropic prompt caching
    caches_by_default: bool = False
    use_system_prompt: bool = True
    use_temperature: Union[bool, float] = True
    streaming: bool = True
    editor_model_name: Optional[str] = None
    editor_edit_format: Optional[str] = None
    reasoning_tag: Optional[str] = None     # <thinking> tag
    remove_reasoning: Optional[str] = None  # deprecated alias
    system_prompt_prefix: Optional[str] = None
    accepts_settings: Optional[list] = None # thinking_tokens, reasoning_effort
```

**ModelInfoManager**（`models.py:161-274`）：
- 从 `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` 拉取模型元数据
- 24 小时 TTL 缓存到 `~/.aider/caches/model_prices_and_context_window.json`
- OpenRouter 模型额外从 `openrouter_manager` 获取，失败时降级到 scrape openrouter.ai 网页
- 提供 `max_input_tokens`、`max_output_tokens`、`input_cost_per_token`、`output_cost_per_token` 等关键字段

### 8.2 token cost 计算

`models.py:650-670` `token_count`：

```python
def token_count(self, messages):
    if type(messages) is list:
        try:
            return litellm.token_counter(model=self.name, messages=messages)
        except Exception as err:
            print(f"Unable to count tokens: {err}")
            return 0
    ...
```

`models.py:672-701` `token_count_for_image`：按 OpenAI 视觉 token 规则计算（缩放到 ≤2048，短边缩到 768，按 512×512 tile 切分，每 tile 170 tokens + 85 base）。

`base_coder.py` 中累计 cost（搜索 `total_cost` / `message_cost` 的实现未深入阅读，但 `models.py` 中 `simple_send_with_retries` 和 `send_with_retries` 在 `sendchat.py` 之外，可能位于 `llm.py`，未读）。

### 8.3 weak model / main model / editor model 分层

**三层模型架构**：

| 层 | 用途 | 配置 | 默认 |
|---|---|---|---|
| **main_model** | 主对话 + 编辑 | `--model` | `gpt-4o` |
| **weak_model** | commit message + 历史摘要 | `--weak-model` 或模型预设的 `weak_model_name` | 通常为 main 的弱版本 |
| **editor_model** | Architect mode 的 editor 步骤 | `--editor-model` 或模型预设的 `editor_model_name` | 通常 = main_model |

`models.py:603-620` `get_weak_model`：

```python
def get_weak_model(self, provided_weak_model_name):
    if provided_weak_model_name:
        self.weak_model_name = provided_weak_model_name
    if not self.weak_model_name:
        self.weak_model = self                 # ★ 无弱模型时用自己
        return
    if self.weak_model_name == self.name:
        self.weak_model = self
        return
    self.weak_model = Model(self.weak_model_name, weak_model=False)
    return self.weak_model
```

`models.py:622-623` `commit_message_models`：

```python
def commit_message_models(self):
    return [self.weak_model, self]              # ★ commit message 先试 weak，失败回退 main
```

这与 `repo.py:342-363` 的循环对应：先试 weak_model，token 装不下或失败则回退到 main_model。

`models.py:625-645` `get_editor_model` 类似，但额外处理 `editor_edit_format` 自动推导（`diff` → `editor-diff`）。

**max_chat_history_tokens 自动推导**（`models.py:355-358`）：

```python
max_input_tokens = self.info.get("max_input_tokens") or 0
# 1/16 of max_input_tokens, min 1k, max 8k
self.max_chat_history_tokens = min(max(max_input_tokens / 16, 1024), 8192)
```

### 8.4 模型预设规模

`aider/resources/model-settings.yml` 包含 **357 个模型条目**（grep 统计 `- name:` 出现 357 次）。覆盖：

- OpenAI：gpt-3.5/4/4o/4.1/5/5.5、o1/o3-mini 系列
- Anthropic：claude-2/3/3.5/3.7/4/4.5/4.6/4.7、sonnet/haiku/opus 全系列
- DeepSeek：deepseek-chat、deepseek-reasoner (r1)
- Google：gemini-2.5-pro、gemini-3-pro-preview、gemini-flash
- xAI：grok-3-beta
- OpenRouter：quasar-alpha、optimus-alpha
- 等等

`MODEL_ALIASES`（`models.py:99-123`）提供短别名：`sonnet` → `claude-sonnet-4-6`、`haiku` → `claude-haiku-4-5`、`opus` → `claude-opus-4-7`、`4o` → `gpt-4o`、`deepseek` → `deepseek/deepseek-chat` 等。

### 8.5 借鉴建议

**三层模型架构直接照搬**：

| Aider | tdsf 运维 |
|---|---|
| main_model | 主对话 + 运维指令生成（强模型） |
| weak_model | commit message + 历史摘要 + 简单分类（弱模型，省钱） |
| editor_model | Architect mode 的 executor（中等模型） |

**具体配置建议**：
- `main_model`：claude-opus-4-7 或 gpt-5.5-pro（用户可选）
- `weak_model`：claude-haiku-4-5 或 gpt-4o-mini（默认与 main 同 provider）
- `editor_model`：claude-sonnet-4-6（介于两者之间）

**TS 实现**：

```typescript
interface ModelConfig {
  name: string;
  editFormat: 'search-replace' | 'whole' | 'udiff' | 'patch';
  weakModelName?: string;
  editorModelName?: string;
  editorEditFormat?: string;
  useRepoMap?: boolean;
  useTemperature?: boolean | number;
  streaming?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  inputCostPerToken?: number;
  outputCostPerToken?: number;
}

const MODEL_PRESETS: Record<string, ModelConfig> = {
  'claude-opus-4-7': {
    name: 'claude-opus-4-7',
    editFormat: 'search-replace',
    weakModelName: 'claude-haiku-4-5',
    editorModelName: 'claude-sonnet-4-6',
    editorEditFormat: 'editor-diff',
    useRepoMap: true,
  },
  // ... 357 个预设
};
```

**BYOK + 本地模型双模式**：Aider 通过 `litellm` 支持 100+ provider，tdsf 可直接用 `@anthropic-ai/sdk` / `openai` npm 包，本地模型用 `ollama` HTTP API。

---

## 9. Linting 集成

> 源码：`aider/linter.py`（269 行）+ `aider/coders/base_coder.py:1599-1623, 1681-1696`

### 9.1 AST lint

`linter.py:201-231` `basic_lint`：

```python
def basic_lint(fname, code):
    """Use tree-sitter to look for syntax errors, display them with tree context."""
    lang = filename_to_lang(fname)
    if not lang: return
    # Tree-sitter linter is not capable of working with typescript #1132
    if lang == "typescript": return
    try:
        parser = get_parser(lang)
    except Exception as err:
        print(f"Unable to load parser: {err}")
        return
    tree = parser.parse(bytes(code, "utf-8"))
    try:
        errors = traverse_tree(tree.root_node)
    except RecursionError:
        print(f"Unable to lint {fname} due to RecursionError")
        return
    if not errors: return
    return LintResult(text="", lines=errors)
```

`linter.py:260-268` `traverse_tree`：

```python
def traverse_tree(node):
    errors = []
    if node.type == "ERROR" or node.is_missing:
        line_no = node.start_point[0]
        errors.append(line_no)
    for child in node.children:
        errors += traverse_tree(child)
    return errors
```

**Python 专属强化**（`linter.py:118-168` `py_lint` + `flake8_lint`）：

```python
def py_lint(self, fname, rel_fname, code):
    basic_res = basic_lint(rel_fname, code)              # tree-sitter
    compile_res = lint_python_compile(fname, code)       # compile() 内置
    flake_res = self.flake8_lint(rel_fname)              # flake8 fatal only
    text = ""
    lines = set()
    for res in [basic_res, compile_res, flake_res]:
        if not res: continue
        if text: text += "\n"
        text += res.text
        lines.update(res.lines)
    if text or lines:
        return LintResult(text, lines)

def flake8_lint(self, rel_fname):
    fatal = "E9,F821,F823,F831,F406,F407,F701,F702,F704,F706"   # 只查致命错误
    flake8_cmd = [sys.executable, "-m", "flake8", f"--select={fatal}", "--show-source", "--isolated", rel_fname]
    ...
```

**Python 三层 lint**：tree-sitter（语法）→ `compile()`（语义）→ flake8 E9/F 系列（致命运行时错误）。其他语言只有 tree-sitter 一层。

### 9.2 多语言支持

`aider/queries/tree-sitter-language-pack/` 包含 30+ 语言的 `.scm` 查询文件：arduino、bash、c、clojure、commonlisp、cpp、csharp、d、dart、elisp、elixir、elm、gleam、go、java、javascript、lua、matlab、ocaml、pony、properties、python、r、racket、ruby、rust、solidity、swift、udev。

`aider/queries/tree-sitter-languages/` 是 fallback，包含额外语言：c_sharp、fortran、haskell、hcl、julia、kotlin、php、ql、scala、typescript、zig。

### 9.3 lint 与编辑流程的集成

`base_coder.py:1599-1623`：

```python
if edited and self.auto_lint:
    lint_errors = self.lint_edited(edited)
    self.auto_commit(edited, context="Ran the linter")      # lint 修复后再 commit
    self.lint_outcome = not lint_errors
    if lint_errors:
        ok = self.io.confirm_ask("Attempt to fix lint errors?")
        if ok:
            self.reflected_message = lint_errors            # ★ 反馈给 LLM 让它修
            return
```

`base_coder.py:1681-1696` `lint_edited`：

```python
def lint_edited(self, fnames):
    res = ""
    for fname in fnames:
        if not fname: continue
        errors = self.linter.lint(self.abs_root_path(fname))
        if errors:
            res += "\n" + errors + "\n"
    if res:
        self.io.tool_warning(res)
    return res
```

`linter.py:82-116` `lint` 用 `tree_context`（grep_ast.TreeContext）渲染错误行 + 上下文，让 LLM 看到错误在代码中的位置。

### 9.4 借鉴建议：运维脚本验证

**Aider 模型 vs 运维场景**：

| Aider | tdsf 运维 |
|---|---|
| Python `compile()` | `bash -n` / `python -m py_compile` |
| flake8 E9/F8 | `shellcheck` / `pyflakes` |
| tree-sitter 语法 | `nginx -t` / `systemd-analyze verify` |
| tree_context 渲染 | Monaco Editor 高亮错误行 |

**TS 落地**：

```typescript
class OpsLinter {
  async lint(filePath: string, content: string): Promise<LintResult> {
    const ext = path.extname(filePath);
    switch (ext) {
      case '.sh':
      case '.bash':
        return await this.lintBash(filePath, content);
      case '.py':
        return await this.lintPython(filePath, content);
      case '.conf':
        return await this.lintNginx(filePath, content);
      case '.service':
        return await this.lintSystemd(filePath, content);
      case '.yml':
      case '.yaml':
        return await this.lintYaml(filePath, content);
      default:
        return { text: '', lines: [] };
    }
  }

  private async lintBash(filePath: string, content: string): Promise<LintResult> {
    // 1. 语法检查：bash -n
    const syntaxRes = await this.ssh.exec(`bash -n ${filePath}`);
    if (syntaxRes.exitCode !== 0) {
      const lines = this.parseBashError(syntaxRes.stdout);
      return { text: syntaxRes.stdout, lines };
    }
    // 2. 静态分析：shellcheck
    const checkRes = await this.ssh.exec(`shellcheck -f gcc ${filePath}`);
    if (checkRes.exitCode !== 0) {
      return { text: checkRes.stdout, lines: this.parseGccErrorFormat(checkRes.stdout) };
    }
    return { text: '', lines: [] };
  }

  private async lintNginx(filePath: string, content: string): Promise<LintResult> {
    const res = await this.ssh.exec(`nginx -t 2>&1`);
    if (res.exitCode !== 0) {
      return { text: res.stdout, lines: this.parseNginxError(res.stdout) };
    }
    return { text: '', lines: [] };
  }
}
```

**集成到 Agent 流程**（同 Aider）：

```typescript
// executor 完成后自动 lint，错误反馈给 LLM 修正
const edits = await executor.execute(plan);
const lintErrors = await linter.lintAll(edits);
if (lintErrors) {
  const fixApproved = await showLintFixDialog(lintErrors);
  if (fixApproved) {
    return await architect.fix(lintErrors);    // 反馈循环
  }
}
```

---

## 10. Voice support（可选）

> 源码：`aider/voice.py`（187 行，全文已读）

### 10.1 实现原理

`voice.py` 核心：

```python
class Voice:
    def __init__(self, audio_format="wav", device_name=None):
        import sounddevice as sd
        self.sd = sd
        devices = sd.query_devices()
        if device_name:
            # 按名称查找输入设备
            ...
        else:
            self.device_id = None
        self.audio_format = audio_format        # wav / mp3 / webm

    def callback(self, indata, frames, time, status):
        """每个音频块的回调（独立线程）"""
        rms = np.sqrt(np.mean(indata**2))       # 计算 RMS 用于音量条
        self.max_rms = max(self.max_rms, rms)
        self.min_rms = min(self.min_rms, rms)
        rng = self.max_rms - self.min_rms
        if rng > 0.001:
            self.pct = (rms - self.min_rms) / rng
        self.q.put(indata.copy())                # 入队待写入

    def raw_record_and_transcribe(self, history, language):
        self.q = queue.Queue()
        temp_wav = tempfile.mktemp(suffix=".wav")
        sample_rate = int(self.sd.query_devices(self.device_id, "input")["default_samplerate"])
        # 用 InputStream 录音，prompt 工具栏显示音量条
        with self.sd.InputStream(samplerate=sample_rate, channels=1, callback=self.callback, device=self.device_id):
            prompt(self.get_prompt, refresh_interval=0.1)
        # 写入 wav
        with sf.SoundFile(temp_wav, mode="x", samplerate=sample_rate, channels=1) as file:
            while not self.q.empty():
                file.write(self.q.get())
        # 大文件转 mp3
        if file_size > 24.9 * 1024 * 1024 and self.audio_format == "wav":
            use_audio_format = "mp3"
        # 调 OpenAI Whisper
        with open(filename, "rb") as fh:
            transcript = litellm.transcription(model="whisper-1", file=fh, prompt=history, language=language)
        return transcript.text
```

**依赖链**：
- `sounddevice`（Python 绑定 PortAudio）—— 录音
- `soundfile`（libsndfile）—— 写 wav
- `pydub`（FFmpeg）—— wav → mp3/webm 转码
- `litellm.transcription` —— 调 OpenAI Whisper API
- `numpy` —— RMS 计算
- `prompt_toolkit.shortcuts.prompt` —— 终端音量条 UI

**特点**：
- 终端内显示音量条（`░░░███░░░`）
- 录音文件 >25MB 自动转 mp3
- 用历史 chat 作为 Whisper 的 `prompt` 参数，提升专业术语识别准确率
- 支持指定输入设备（多麦克风场景）

### 10.2 借鉴建议

**Aider 方案对 tdsf 桌面应用的适用性**：

| Aider 依赖 | tdsf Electron 等价方案 |
|---|---|
| `sounddevice` + PortAudio | **Web Audio API**（`navigator.mediaDevices.getUserMedia`） |
| `soundfile` 写 wav | **MediaRecorder API**（原生 webm/opus） |
| `pydub` 转 mp3 | 浏览器原生 webm/opus 直接上传 Whisper |
| `prompt_toolkit` 音量条 | **React 组件** + Web Audio AnalyserNode |
| `litellm.transcription` | **OpenAI Node SDK** `openai.audio.transcriptions.create` |

**结论**：Aider 的 voice 实现依赖 Python 音频生态，**不建议照搬**。tdsf 作为 Electron 应用，直接用 Web Audio API + MediaRecorder + OpenAI Node SDK 重写更轻量，无需引入 Python 进程。

**TS 实现**（可选 P2）：

```typescript
class VoiceInput {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  async startRecording(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    this.chunks = [];
    this.recorder.ondataavailable = (e) => this.chunks.push(e.data);
    this.recorder.start();
  }

  async stopAndTranscribe(history?: string): Promise<string> {
    return new Promise((resolve) => {
      this.recorder!.onstop = async () => {
        const blob = new Blob(this.chunks, { type: 'audio/webm' });
        const formData = new FormData();
        formData.append('file', blob, 'audio.webm');
        formData.append('model', 'whisper-1');
        if (history) formData.append('prompt', history);
        const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: formData,
        });
        const { text } = await res.json();
        resolve(text);
      };
      this.recorder!.stop();
    });
  }
}
```

---

## 11. Watch 模式

> 源码：`aider/watch.py`（318 行，全文已读）+ `aider/watch_prompts.py`

### 11.1 文件监控

`watch.py` 核心用 `watchfiles` 库（Rust notify 后端）：

```python
class FileWatcher:
    ai_comment_pattern = re.compile(
        r"(?:#|//|--|;+) *(ai\b.*|ai\b.*|.*\bai[?!]?) *$", re.IGNORECASE
    )

    def __init__(self, coder, gitignores=None, verbose=False, analytics=None, root=None):
        self.coder = coder
        self.io = coder.io
        self.root = Path(root) if root else Path(coder.root)
        self.gitignore_spec = load_gitignores([Path(g) for g in self.gitignores] if gitignores else [])
        coder.io.file_watcher = self

    def filter_func(self, change_type, path):
        """watchfiles 的过滤器：只关注含 AI 注释的文件"""
        path_obj = Path(path)
        if not path_obj.is_absolute_to(self.root): return False
        if self.gitignore_spec and self.gitignore_spec.match_file(rel_path): return False
        if path_obj.is_file() and path_obj.stat().st_size > 1 * 1024 * 1024: return False  # >1MB 跳过
        try:
            comments, _, _ = self.get_ai_comments(str(path_obj))
            return bool(comments)
        except Exception:
            return False

    def watch_files(self):
        roots_to_watch = self.get_roots_to_watch()
        for changes in watch(*roots_to_watch, watch_filter=self.filter_func, stop_event=self.stop_event, ignore_permission_denied=True):
            if self.handle_changes(changes):
                return

    def get_ai_comments(self, filepath):
        """提取 AI 注释的行号、内容、动作标志"""
        line_nums, comments, has_action = [], [], None
        content = self.io.read_text(filepath, silent=True)
        for i, line in enumerate(content.splitlines(), 1):
            if match := self.ai_comment_pattern.search(line):
                comment = match.group(0).strip()
                if comment:
                    line_nums.append(i)
                    comments.append(comment)
                    comment_lower = comment.lower().lstrip("/#-;")
                    if comment_lower.startswith("ai!") or comment_lower.endswith("ai!"):
                        has_action = "!"           # 执行
                    elif comment_lower.startswith("ai?") or comment_lower.endswith("ai?"):
                        has_action = "?"           # 提问
        return line_nums, comments, has_action
```

`watch_prompts.py`：

```python
watch_code_prompt = """
I've written your instructions in comments in the code and marked them with "ai"
You can see the "AI" comments shown below (marked with █).
Find them in the code files I've shared with you, and follow their instructions.

After completing those instructions, also be sure to remove all the "AI" comments from the code too.
"""

watch_ask_prompt = """/ask
Find the "AI" comments below (marked with █) in the code files I've shared with you.
They contain my questions that I need you to answer and other instructions for you.
"""
```

**工作流**：
1. 用户在代码中加注释：`# ai! 修复这个 bug` 或 `// ai? 这个函数做什么的`
2. `FileWatcher` 检测到文件变化，用 `ai_comment_pattern` 正则匹配
3. `!` 结尾触发 code 模式（执行修改），`?` 结尾触发 ask 模式（回答问题）
4. 用 `TreeContext` 渲染带 █ 标记的代码上下文，作为 LLM 输入
5. `handle_changes` 调用 `io.interrupt_input()` 中断当前输入，触发 AI 处理

**gitignore 加载**（`watch.py:15-62` `load_gitignores`）：
- 默认忽略：`.aider*`、`.git`、`*~`、`*.bak`、`*.swp`、`.DS_Store`、`node_modules/`、`.venv/`、`*.log`、`.idea/`、`.vscode/`、`*.svg`、`*.pdf` 等
- 合并多个 `.gitignore` 文件
- 用 `pathspec.GitWildMatchPattern` 解析

### 11.2 借鉴建议

**Aider watch → tdsf 配置文件监控**：

运维场景的"AI 注释"对应"配置文件中的运维标记"，例如：

```bash
# /etc/nginx/nginx.conf
http {
    # tdsf! 优化这个 server 块的并发性能
    server {
        listen 80;
        ...
    }
}
```

**TS 实现**（用 `chokidar` 替代 `watchfiles`）：

```typescript
import chokidar from 'chokidar';
import { SftpManager } from './sftp';

class RemoteConfigWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private sftp: SftpManager;

  constructor(sftp: SftpManager) {
    this.sftp = sftp;
  }

  async start(host: Host, paths: string[]): Promise<void> {
    // 通过 SFTP 持续轮询远程文件 mtime（chokidar 不支持 SFTP）
    // 或在远程主机上跑 inotifywait + 推送到 tdsf
    this.watcher = chokidar.watch([], {
      persistent: true,
      ignored: /(^|[/\\])\../,  // 忽略隐藏文件
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });

    for (const p of paths) {
      this.watcher.add(p);
    }

    this.watcher.on('change', async (filePath) => {
      const content = await this.sftp.readFile(host, filePath);
      const aiComments = this.extractAiComments(content);
      if (aiComments.length > 0) {
        this.onAiCommentDetected(host, filePath, aiComments);
      }
    });
  }

  private extractAiComments(content: string): AiComment[] {
    const pattern = /(?:#|\/\/|--|;+)\s*(tdsf!?[^\n]*|[^\n]*\btdsf[!?]?)[^\n]*$/gim;
    const comments: AiComment[] = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(pattern);
      if (match) {
        const text = match[0].trim();
        const action = text.toLowerCase().endsWith('!') ? 'execute' : 'ask';
        comments.push({ line: i + 1, text, action });
      }
    }
    return comments;
  }
}
```

**注意**：远程主机文件监控比本地复杂得多，方案有：
1. **轮询 SFTP stat**（简单但延迟高，建议 5-10s）
2. **远程 inotifywait + WebSocket 推送**（实时但需在主机装 inotify-tools）
3. **远程 systemd path unit**（最干净，但需 systemd）

建议 P2 优先级，先实现本地配置文件监控（tdsf 自己的配置），远程监控作为后续增强。

---

## 12. 关键文件清单（带路径引用）

### 12.1 已精读文件

| 文件 | 行数 | 核心内容 |
|---|---|---|
| `aider/repo.py` | 622 | GitRepo 类、commit、/undo 支持、aider_ignore |
| `aider/commands.py`（关键段） | ~300 | 43 个命令、反射注册、SwitchCoder |
| `aider/coders/base_coder.py`（关键段） | ~600 | Coder 基类、auto_commit、dirty_commit、lint_edited、send_message |
| `aider/coders/architect_coder.py` | 48 | Architect mode 全文 |
| `aider/coders/editblock_coder.py` | 657 | SEARCH/REPLACE 解析与应用 |
| `aider/coders/wholefile_coder.py` | 144 | 整文件模式 |
| `aider/coders/udiff_coder.py` | 428 | unified diff 模式 |
| `aider/coders/patch_coder.py` | 706 | V4A patch 模式 |
| `aider/coders/ask_coder.py` | 9 | ask 模式 |
| `aider/coders/architect_prompts.py` | 40 | architect system prompt |
| `aider/coders/editblock_prompts.py` | 172 | SEARCH/REPLACE prompt |
| `aider/coders/wholefile_prompts.py` | 64 | wholefile prompt |
| `aider/coders/udiff_prompts.py` | 113 | udiff prompt |
| `aider/coders/patch_prompts.py` | 159 | V4A patch prompt |
| `aider/coders/__init__.py` | 34 | Coder 工厂注册 |
| `aider/repomap.py`（关键段） | ~600 | RepoMap、PageRank、tree-sitter、token budget |
| `aider/models.py`（关键段） | ~700 | Model、ModelSettings、ModelInfoManager、weak/editor 分层 |
| `aider/linter.py` | 269 | Linter、tree-sitter、flake8、tree_context |
| `aider/voice.py` | 187 | Voice 全文 |
| `aider/watch.py` | 318 | FileWatcher 全文 |
| `aider/watch_prompts.py` | 15 | watch prompts 全文 |
| `aider/diffs.py` | 128 | diff_partial_update、进度条 |
| `aider/run_cmd.py` | 130 | run_cmd（pexpect + subprocess） |
| `aider/exceptions.py` | 113 | 24 种 LLM 异常分类 |
| `aider/sendchat.py` | 60 | sanity_check_messages、ensure_alternating_roles |
| `aider/main.py`（关键段） | ~100 | main()、Coder.create 调用、FileWatcher 初始化 |
| `aider/io.py`（关键段） | ~100 | confirm_ask、tool_error、tool_output |
| `aider/coders/base_coder.py:125-205` | 80 | Coder.create 工厂方法 |
| `aider/resources/model-settings.yml`（grep） | - | 357 个模型预设 |

### 12.2 未深入阅读的文件（诚实标注）

| 文件 | 行数估计 | 未读原因 |
|---|---|---|
| `aider/args.py` | ~600 | argparse 参数定义，对本报告无核心价值 |
| `aider/analytics.py` | - | 使用统计上报，与借鉴无关 |
| `aider/copypaste.py` | - | 剪贴板监控，低优先级 |
| `aider/deprecated.py` | - | 弃用参数处理 |
| `aider/editor.py` | - | $EDITOR 集成 |
| `aider/format_settings.py` | - | 设置格式化 |
| `aider/gui.py` | - | 实验 GUI |
| `aider/help.py` / `aider/help_pats.py` | - | 帮助文档生成 |
| `aider/history.py`（仅 grep） | ~140 | ChatSummary 摘要器，已通过 grep 了解关键方法 |
| `aider/llm.py` | - | litellm 封装 |
| `aider/mdstream.py` | - | markdown 流式渲染 |
| `aider/onboarding.py` | - | OpenRouter OAuth 引导 |
| `aider/openrouter.py` | - | OpenRouter 模型管理 |
| `aider/prompts.py` | - | 通用 prompts |
| `aider/reasoning_tags.py` | - | thinking tag 处理 |
| `aider/report.py` | - | 异常上报 |
| `aider/scrape.py` | - | 网页抓取 |
| `aider/special.py` | - | 重要文件过滤 |
| `aider/urls.py` | - | URL 常量 |
| `aider/utils.py` | - | 工具函数 |
| `aider/versioncheck.py` | - | 版本检查 |
| `aider/waiting.py` | - | 等待动画 |
| `aider/coders/editblock_fenced_coder.py` 等 | - | edit_format 变种，与核心 4 种类似 |
| `aider/coders/editblock_func_coder.py` 等 | - | function-calling 变种 |
| `aider/coders/search_replace.py` | - | 被 udiff_coder 调用，未单独读 |
| `aider/coders/shell.py` | - | shell 命令 prompt 片段 |
| `aider/coders/chat_chunks.py` | - | ChatChunks 数据类 |

---

## 13. 借鉴清单

### 13.1 P0 优先级（立即可落地）

| # | 借鉴点 | 来源文件 | tdsf 落地方式 |
|---|---|---|---|
| 1 | **git 沙箱回滚 + aider_commit_hashes 白名单** | `repo.py:131-318`、`base_coder.py:2375-2419`、`commands.py:553-655` | `HostGitSandbox` 类，每步执行前 checkpoint commit，回滚仅限本会话产生的 checkpoint |
| 2 | **dirty commit 前置** | `base_coder.py:2175-2189, 2411-2419` | 改主机配置前先 commit 当前状态，保证回滚有"前一版本" |
| 3 | **Architect mode（planner + editor + 审批闸门）** | `architect_coder.py`（48 行）、`base_coder.py:125-205` Coder.create | 三段式：planner（强模型）→ reviewer（人工审批，硬约束）→ executor（弱模型） |
| 4 | **反射式命令系统** | `commands.py:255-332` | TS 装饰器 + Reflect Metadata，加 `@command()` 方法即扩展命令 |
| 5 | **editblock（search-replace）edit format** | `editblock_coder.py:127-329` | `SftpManager.applySearchReplace()`，匹配失败反馈"最相似代码段" |
| 6 | **三层模型分层（main/weak/editor）** | `models.py:329-645` | 主模型 + 弱模型（commit message/摘要）+ editor 模型（executor） |
| 7 | **lint 反馈循环** | `base_coder.py:1599-1623`、`linter.py` | 编辑后自动 lint，错误反馈给 LLM 修正，直至通过或用户放弃 |
| 8 | **人工审批闸门（硬约束）** | `architect_coder.py:17`、`base_coder.py:2450-2462` handle_shell_commands | 每步运维操作前强制 UI 审批，显示 diff + 回滚方案 + 风险评级 |

### 13.2 P1 优先级（中期落地）

| # | 借鉴点 | 来源文件 | tdsf 落地方式 |
|---|---|---|---|
| 9 | **RepoMap（PageRank + tree-sitter）→ HostMap** | `repomap.py:365-574` | 主机+服务+依赖图，PageRank 排序，token budget 二分 |
| 10 | **token budget 二分搜索** | `repomap.py:629-706` | HostMap 渲染时控制 token 数，避免超出上下文窗口 |
| 11 | **多 edit format 切换** | `coders/__init__.py`、`commands.py:138-208` cmd_chat_mode | 用户可选 wholefile/editblock/udiff，按文件大小自动推荐 |
| 12 | **udiff 用于变更预览** | `udiff_coder.py`、`diffs.py` | Monaco Diff Editor 渲染 unified diff，用户审批 |
| 13 | **commit message 自动生成（弱模型）** | `repo.py:326-373` | 运维操作后自动生成"变更说明"，弱模型节省成本 |
| 14 | **chat history 摘要** | `history.py`（grep）、`base_coder.py:1002-1038` | 长会话自动摘要，保留关键上下文 |
| 15 | **SwitchCoder 异常即控制流** | `commands.py:30-34` | 模式切换抛异常，主循环捕获重建 Agent |
| 16 | **aiderignore → 运维 ignore** | `repo.py:500-565` | `.tdsfignore` 文件，排除不应被 Agent 触碰的主机/路径 |
| 17 | **exception 分类（retry vs no-retry）** | `exceptions.py:13-57` | 24 种 LLM 异常分类，区分可重试与不可重试 |

### 13.3 P2 优先级（长期/可选）

| # | 借鉴点 | 来源文件 | tdsf 落地方式 |
|---|---|---|---|
| 18 | **Watch 模式（配置文件 AI 注释）** | `watch.py` | `# tdsf! 优化这里` 触发 Agent，chokidar 替代 watchfiles |
| 19 | **Voice support** | `voice.py` | Electron Web Audio API + Whisper，不引入 Python |
| 20 | **tree-sitter 多语言 lint** | `linter.py:201-231`、`queries/` | 运维场景用 `bash -n` / `shellcheck` / `nginx -t` 更直接，tree-sitter 作为补充 |
| 21 | **prompt caching（Anthropic）** | `models.py:140-141` | `cache_control: true`，长 system prompt 缓存 |
| 22 | **OpenRouter 模型自动发现** | `models.py:276-324`、`openrouter.py` | 拉取 OpenRouter 模型列表，自动适配新模型 |
| 23 | **diskcache 持久化** | `repomap.py:177-215` | HostMap 缓存持久化到本地 SQLite |
| 24 | **personalization 向量加权** | `repomap.py:519-525` | HostMap 中用户当前选中的主机/服务加权 |

### 13.4 不建议借鉴

| # | 项 | 原因 |
|---|---|---|
| A | **Python litellm 依赖** | tdsf 是 TS 项目，禁止 Python 进程通信；改用 `@anthropic-ai/sdk` / `openai` npm 包 |
| B | **gitpython 依赖** | TS 用 `simple-git` 或直接 `child_process.exec('git ...')` |
| C | **networkx PageRank** | TS 无原生等价物；可选 `graphlib`（无 PageRank）或 `cytoscape.js`（前端）或自己实现简易 PageRank |
| D | **prompt_toolkit 终端 UI** | tdsf 是 Electron 桌面应用，用 React + Ant Design 5 |
| E | **sounddevice + pydub** | Electron 用 Web Audio API + MediaRecorder |
| F | **watchfiles（Rust notify）** | TS 用 `chokidar` 即可 |
| G | **diskcache（SQLite）** | TS 用 `better-sqlite3` 或 `level` |
| H | **grep_ast.TreeContext** | TS 无等价物；运维场景用 Monaco Editor + 错误行高亮替代 |
| I | **flake8 E9/F8 检查** | Python 专属，运维场景用对应语言的 linter |
| J | **pexpect（PTY 交互）** | TS 远程执行用 `ssh2` / `node-ssh`，不需要 PTY |

---

## 14. 风险与注意事项

### 14.1 Python vs TS 不兼容提示

| 风险 | 说明 | 缓解措施 |
|---|---|---|
| **litellm 模型抽象层缺失** | Aider 用 litellm 统一 100+ provider，TS 无等价物 | tdsf 自己实现 provider 适配层，或用 Vercel AI SDK（@ai-sdk/anthropic、@ai-sdk/openai） |
| **tree-sitter Python 绑定** | Aider 用 `tree-sitter` + `tree-sitter-languages` / `tree-sitter-language-pack` | TS 用 `web-tree-sitter`（WASM 绑定），但 `.scm` 查询文件可直接复用 |
| **networkx PageRank** | TS 无原生 PageRank | 自己实现（~50 行）或用 `jsnetworkx`（已停止维护）或 `graphlib` |
| **gitpython** | Aider 用 gitpython 操作 git | TS 用 `simple-git` 或直接 child_process |
| **prompt_toolkit** | Aider 终端 UI | tdsf 用 React + Ant Design 5，UX 完全不同 |
| **litellm.transcription（Whisper）** | Aider 通过 litellm 调 Whisper | tdsf 直接调 OpenAI Node SDK |
| **diskcache** | Aider 持久化 tags cache | TS 用 `better-sqlite3` |
| **pathspec** | Aider 解析 .gitignore | TS 用 `ignore` npm 包 |

### 14.2 运维场景特有风险

| 风险 | 说明 | 缓解措施 |
|---|---|---|
| **远程操作不可逆** | 与代码编辑不同，运维操作（如 `rm -rf`、`systemctl stop`）可能无法回滚 | 强制 checkpoint + 双层审批 + 影响面预评估 |
| **网络分区** | SSH 连接中断可能导致操作状态不确定 | 幂等性设计 + 超时检测 + 重连后状态校验 |
| **权限提升** | 运维常需 sudo，风险高 | sudo 命令二次审批 + 操作日志 + 审计 trail |
| **多主机一致性** | 跨主机批量操作可能出现部分成功 | 两阶段提交（prepare + commit）+ 失败自动回滚已成功主机 |
| **服务影响** | reload/restart 可能短暂中断服务 | 维护窗口检查 + 灰度执行 + 健康检查 |
| **密钥泄露** | Agent 输出可能包含敏感信息 | 输出脱敏 + 不记录 secret 到日志 + RBAC |

### 14.3 Aider 设计中需警惕的反模式

| 反模式 | Aider 位置 | 是否适用 tdsf |
|---|---|---|
| **异常即控制流**（SwitchCoder） | `commands.py:30-34` | 可借鉴，TS 中用 throw Error 实现 |
| **隐式 auto-commit** | `base_coder.py:1585-1589` | **不适用** —— 运维场景必须显式审批，不能 auto-anything |
| **弱模型生成 commit message 失败静默** | `repo.py:365-367` | 运维场景 commit message 应记录操作语义，不应静默失败 |
| **tree-sitter 不支持 typescript** | `linter.py:211-212` | 运维脚本以 bash/python 为多，影响小 |
| **diskcache 损坏降级到内存** | `repomap.py:177-215` | 运维 HostMap 可接受，但需提示用户 |

### 14.4 合规与许可证

- **Aider License**：Apache-2.0（`LICENSE.txt:2-3` 确认），允许商业使用、修改、分发，只需保留 LICENSE 文件和 NOTICE
- **借鉴方式**：本报告所有借鉴均为**思想借鉴**（算法、架构、设计模式），不复制 Python 代码到 TS 项目，无许可证风险
- **若直接移植代码**：需在 tdsf 项目 NOTICE 中声明 "Includes code adapted from Aider (https://github.com/Aider-AI/aider) under Apache-2.0"

---

## 15. 参考资料

### 15.1 源码文件（绝对路径）

- 项目根：`d:\ai\linux教学一体\opensource-reference\aider\`
- 主入口：`d:\ai\linux教学一体\opensource-reference\aider\aider\main.py`
- git 集成：`d:\ai\linux教学一体\opensource-reference\aider\aider\repo.py`
- 命令系统：`d:\ai\linux教学一体\opensource-reference\aider\aider\commands.py`
- Coder 基类：`d:\ai\linux教学一体\opensource-reference\aider\aider\coders\base_coder.py`
- Architect mode：`d:\ai\linux教学一体\opensource-reference\aider\aider\coders\architect_coder.py`
- SEARCH/REPLACE：`d:\ai\linux教学一体\opensource-reference\aider\aider\coders\editblock_coder.py`
- wholefile：`d:\ai\linux教学一体\opensource-reference\aider\aider\coders\wholefile_coder.py`
- udiff：`d:\ai\linux教学一体\opensource-reference\aider\aider\coders\udiff_coder.py`
- patch：`d:\ai\linux教学一体\opensource-reference\aider\aider\coders\patch_coder.py`
- RepoMap：`d:\ai\linux教学一体\opensource-reference\aider\aider\repomap.py`
- 模型管理：`d:\ai\linux教学一体\opensource-reference\aider\aider\models.py`
- 模型预设：`d:\ai\linux教学一体\opensource-reference\aider\aider\resources\model-settings.yml`
- Linter：`d:\ai\linux教学一体\opensource-reference\aider\aider\linter.py`
- Voice：`d:\ai\linux教学一体\opensource-reference\aider\aider\voice.py`
- Watch：`d:\ai\linux教学一体\opensource-reference\aider\aider\watch.py`
- 异常：`d:\ai\linux教学一体\opensource-reference\aider\aider\exceptions.py`
- Diff：`d:\ai\linux教学一体\opensource-reference\aider\aider\diffs.py`
- 命令执行：`d:\ai\linux教学一体\opensource-reference\aider\aider\run_cmd.py`
- IO：`d:\ai\linux教学一体\opensource-reference\aider\aider\io.py`
- sendchat：`d:\ai\linux教学一体\opensource-reference\aider\aider\sendchat.py`
- Coder 工厂：`d:\ai\linux教学一体\opensource-reference\aider\aider\coders\__init__.py`
- tree-sitter 查询：`d:\ai\linux教学一体\opensource-reference\aider\aider\queries\tree-sitter-language-pack\`
- License：`d:\ai\linux教学一体\opensource-reference\aider\LICENSE.txt`
- pyproject：`d:\ai\linux教学一体\opensource-reference\aider\pyproject.toml`
- README：`d:\ai\linux教学一体\opensource-reference\aider\README.md`

### 15.2 输出报告

- 本报告：`d:\ai\linux教学一体\idea-to-dev-output\31-源码分析-Aider-终端优先与git沙箱回滚.md`

### 15.3 官方文档（外部链接）

- Aider 官网：https://aider.chat/
- Aider GitHub：https://github.com/Aider-AI/aider
- Aider 文档（git）：https://aider.chat/docs/git.html
- Aider 文档（repomap）：https://aider.chat/docs/repomap.html
- Aider 文档（edit formats）：https://aider.chat/docs/leaderboards/edit.html
- Aider 文档（architect）：https://aider.chat/2024/09/26/architect.html
- Aider 文档（lint/test）：https://aider.chat/docs/usage/lint-test.html
- Aider 文档（watch）：https://aider.chat/docs/usage/watch.html
- Aider 文档（voice）：https://aider.chat/docs/usage/voice.html
- Apache-2.0 许可证：https://www.apache.org/licenses/LICENSE-2.0

### 15.4 相关 tdsf-linux-desktop 文档（建议参考）

- 30-源码分析-Kilo-Code-Plan-Code分离与codebase-indexing.md（如有）
- 32-tdsf-Agent-架构设计（计划输出）

---

## 附录 A：Aider 核心算法速查

### A.1 /undo 安全回滚检查清单

```
□ 1. 有 git repo？
□ 2. 有父提交（不是首个 commit）？
□ 3. last_commit_hash ∈ aider_commit_hashes？（白名单）
□ 4. 不是 merge commit（单父）？
□ 5. 涉及的所有文件无未提交修改？
□ 6. 涉及的所有文件在前一提交中存在？
□ 7. 未 push 到 origin？
→ 全部通过 → 逐文件 git checkout HEAD~1 -- <file> + git reset --soft HEAD~1
```

### A.2 RepoMap PageRank 算法

```
输入：chat_fnames, other_fnames, mentioned_fnames, mentioned_idents
输出：排序后的 tags 列表

1. tree-sitter 解析每个文件，提取 (def|ref, ident, line) tags
2. 构建 defines: dict[ident, set[fname]] 和 references: dict[ident, list[fname]]
3. 构建 networkx.MultiDiGraph:
   for ident in (defines ∩ references):
     mul = 1.0
     if ident ∈ mentioned_idents: mul *= 10
     if (snake|kebab|camel) and len(ident) >= 8: mul *= 10
     if ident.startswith("_"): mul *= 0.1
     if len(defines[ident]) > 5: mul *= 0.1
     for referencer, num_refs in Counter(references[ident]):
       for definer in defines[ident]:
         use_mul = mul
         if referencer ∈ chat_rel_fnames: use_mul *= 50
         weight = use_mul * sqrt(num_refs)
         G.add_edge(referencer, definer, weight=weight, ident=ident)
4. personalization = {chat_fnames: 100/n, mentioned_fnames: 100/n, mentioned_idents 匹配: 100/n}
5. ranked = nx.pagerank(G, weight="weight", personalization=personalization)
6. 把 rank 分摊到每条边 → ranked_definitions[(dst, ident)] += src_rank * edge_weight / total_out_weight
7. 按 ranked_definitions 降序输出 tags
8. 二分搜索 middle 使 token_count(tree(ranked_tags[:middle])) ≈ max_map_tokens
```

### A.3 Architect mode 流程

```
user_message
    │
    ▼
[ArchitectCoder.send_message]（用 main_model，强模型）
    │
    ▼
partial_response_content（自然语言指令）
    │
    ▼
[reply_completed]
    │
    ├── auto_accept_architect? 否 → confirm_ask("Edit the files?") → 人工审批
    │
    ▼
[Coder.create(main_model=editor_model, edit_format=editor_edit_format, map_tokens=0, ...)]
    │
    ▼
[editor_coder.run(with_message=content)]
    │
    ├── editor_coder.cur_messages = []  # 上下文隔离
    ├── editor_coder.done_messages = []
    │
    ▼
[editor_coder.send_message]（用 editor_model，便宜模型）
    │
    ├── apply_updates() → auto_commit() → aider_commit_hashes.add(...)
    │
    ▼
[architect.move_back_cur_messages("I made those changes...")]
    │
    ▼
[architect.aider_commit_hashes = editor_coder.aider_commit_hashes]  # 哈希继承
```

---

**报告结束**

本报告基于对 Aider 源码的真实阅读，覆盖核心 27 个文件、~5000 行代码。所有借鉴建议均给出 TS 等价实现路径，遵守 tdsf-linux-desktop 硬约束（TS 原生、人工审批闸门、本地优先）。未深入阅读的文件已在 §12.2 诚实标注。
