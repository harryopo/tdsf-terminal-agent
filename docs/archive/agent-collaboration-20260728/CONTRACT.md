# 多 Agent 开发协作契约

> ⚠️ **已废弃归档（2026-07-31）**：本契约及配套 `file-ownership.json` 建立于 2026-07-28，已被 `docs/MULTI-AGENT-WORKFLOW.md`（v2.0+）取代。现行协作规范以 **`docs/MULTI-AGENT-WORKFLOW.md`** 为唯一准绳（锁机制见其 §3.2 `docs/.agent-locks.md`）。本文件仅作历史留档，不再执行。
> 归档时 `file-ownership.json` 中仍残留 2 条 2026-07-28 的过期条目（1 条超期未释放声明 + 1 条 `src/modules/translate/` 目录锁，均超契约 2 小时僵尸阈值 ~72h），随本文件一并封存，不再具有约束力。

> 目的：防止多个 AI 对话/agent 同时开发时出现误删文件、同时修改、git 冲突。
> 所有 agent（Claude Code / Trae / Cursor / Codex 等）动工前必须先读此契约。

## 一、强制工作流（每次动工前必走）

```
1. git status                  # 确认工作区干净，无未提交冲突
2. git pull --rebase           # 拉取远端最新（若多人协作）
3. 查 file-ownership.json      # 声明本次要改的文件，检查是否与他人冲突
4. 声明文件归属                # 在 file-ownership.json 添加自己的 session_id + 文件列表
5. 修改代码                    # 只改声明过的文件
6. 五绿门禁                    # typecheck + lint + test + build:web + tauri:dev 实测（见 CLAUDE.md 第 4 节）
7. 提交并释放归属               # git commit 后从 file-ownership.json 移除自己的记录
```

## 二、文件归属表机制

文件：`.agent-collaboration/file-ownership.json`

每次动工前，agent 必须在此 JSON 中声明要修改的文件。同一文件不可被两个 agent 同时声明。

**声明格式**：

```json
{
  "claims": [
    {
      "session_id": "claude-code-20260728-001",
      "agent_name": "Claude Code",
      "task": "修复 agent 终端集成",
      "files": [
        "src/modules/ai/tools/terminal.ts",
        "src-tauri/src/modules/pty/mod.rs"
      ],
      "started_at": "2026-07-28T21:00:00+08:00",
      "expected_finish": "2026-07-28T22:00:00+08:00"
    }
  ]
}
```

**规则**：

- 若文件已被其他 session 声明，必须等待对方提交释放或协商
- 声明超过 2 小时未释放，视为僵尸声明，可强制接管（但需在 git commit message 注明）
- 同一目录下的文件尽量由同一 agent 处理，避免 eslint/格式化冲突

## 三、目录分区（按模块隔离）

为减少冲突，按目录划分 agent 职责边界：

| 目录                                           | 主责模块      | 备注                              |
| ---------------------------------------------- | ------------- | --------------------------------- |
| `src/modules/translate/`                     | 翻译模块对话  | 当前正在开发，其他 agent 禁止触碰 |
| `src/modules/ai/`                            | AI/Agent 对话 | agent 系统、工具调用              |
| `src-tauri/sidecar/agents/`                  | AI/Agent 对话 | Python agent 实现                 |
| `src-tauri/sidecar/skills/`                  | AI/Agent 对话 | skill 注册与调用                  |
| `src-tauri/sidecar/knowledge/`               | AI/Agent 对话 | 知识库                            |
| `src-tauri/src/modules/pty/`                 | 终端集成对话  | PTY 终端                          |
| `src-tauri/src/modules/ssh/`                 | 终端集成对话  | SSH 远程                          |
| `src/components/Terminal.tsx`                | 终端集成对话  | 终端 UI                           |
| `src-tauri/src/modules/sidecar.rs`           | AI/Agent 对话 | sidecar 进程管理                  |
| `src/settings/sections/TDSFPanelSection.tsx` | AI/Agent 对话 | 设置面板                          |
| `docs/reports/`                              | 所有对话      | 审计报告（只追加，不修改）        |

## 四、git 协作规则

1. **主分支保护**：`main` / `master` 分支禁止直接 push，必须走 PR
2. **feature 分支**：每个 agent 用独立 feature 分支，如 `feat/agent-terminal-integration`
3. **提交粒度**：一次 commit 只做一件事，message 用 conventional commit 格式
4. **冲突解决**：rebase 时遇冲突，优先保留对方代码，自己改的部分用 `git checkout --ours` 后重新评估
5. **禁止操作**：
   - `git push --force` 到主分支
   - `git reset --hard` 丢弃他人提交
   - `git clean -fd` 清理他人未跟踪文件
   - `git checkout .` 丢弃他人修改

## 五、五绿门禁（提交前必须全过）

> **唯一真源**：`CLAUDE.md` 第 4 节「五绿门禁（完成的唯一标准）」。本节命令清单与其保持一致，若有出入以 CLAUDE.md 为准。

```bash
pnpm typecheck     # tsc -p tsconfig.app.json && tsc -p tsconfig.node.json，0 错误
pnpm lint          # eslint . --max-warnings 0，0 错误 0 警告
pnpm test          # vitest run，全过
pnpm build:web     # tsc -p app + vite build，成功出 dist
pnpm tauri:dev     # 桌面端实测：窗口可见 + 能点击 + 目标功能真的工作
```

任一不通过禁止 commit。若测试因他人修改失败，先通知对方修复。

## 六、冲突应急处理

若发现文件被误删或冲突：

1. **立即停止修改**，不要继续编辑
2. `git status` 查看状态
3. `git stash` 暂存自己的修改
4. `git log --oneline -10` 查看最近提交
5. `git reflog` 查找丢失的提交
6. 协商后恢复：`git stash pop` 或 `git cherry-pick <hash>`

## 七、Agent 间通信

- 通过 `docs/reports/` 下的报告同步进度（只追加新文件，不修改他人文件，除非对质量更好）
- 通过 `.agent-collaboration/file-ownership.json` 同步文件归属
- 通过 git commit message 同步决策（如 `feat(agent): 添加终端执行工具，不触碰翻译模块`）
