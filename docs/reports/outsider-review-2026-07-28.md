# TDSF-Terminal-Agent-Clone 模式 C 聚焦审查报告

| 字段 | 值 |
|------|-----|
| 审查模式 | 模式 C — 30 分钟聚焦（3 端到端焦点） |
| 审查日期 | 2026-07-28 |
| 审查范围 | SSH 集成 / AI Agent / Skill 系统（端到端） |
| 审查员 | outsider-reviewer（仅读不改） |
| 评判标准 | 文件:行号 证据 + 修复可操作性，**不参考项目 CLAUDE.md/AGENTS.md/TDSF.md** |

---

## 0. 摘要

| 焦点 | 状态 | 端到端打通度 | 主要问题 |
|------|------|------------|---------|
| **TDSF-S1** SSH 集成 | ✅ 基本打通 | 9 状态机 + TOFU + keyring + 终端 fan-out 全链路可见 | 自动连接失败静默、credential 同步竞态 |
| **TDSF-S2** AI Agent | ⚠️ 表面打通 | PAOR + 9 Agent + LLM 注册可见 | **Main Agent 路由只跑 sub-agent 一次**、langgraph 迭代链路未闭合 |
| **TDSF-S3** Skill 系统 | ❌ 名实不符 | 5 内置 Skill + 65 mock 关闭可见 | **skill.invoke 仅返回 SKILL.md 文本，无任何执行逻辑** |

**TL;DR**：项目骨架完整（架构、状态机、TOFU、PAOR、Skill 注册表都齐），但 Skill 系统是"文档查看器"而非"可调用工具"，Main Agent 路由把 sub-agent 当一次性函数用（破坏了 PAOR 多轮迭代），评委若问"实际跑通了吗"答"SSH 端到端通，AI 能对话但 Teach 跑不满 3 步，Skill 名实不符"。

---

## 1. 焦点 1 (TDSF-S1): SSH 集成端到端

### 1.1 状态判定

**✅ 9 状态有限状态机已实现并对齐**

- `src/lib/ssh-bridge.ts:30-40` 定义前端 10 个状态值（`idle | connecting | handshaking | host_verifying | authenticating | authenticated | connected | reconnecting | failed | closed`）
- `src-tauri/src/modules/ssh/client.rs:91-95` 配置 russh keepalive 15s × 3 + 30s inactivity timeout
- `src-tauri/src/modules/ssh/client.rs:113-150` 走 Password/PublicKey 双路径认证
- `src-tauri/src/modules/ssh/mod.rs:64-66` `AtomicU32 next_id` 分配 session_id

**✅ TOFU 主机审批端到端连通**

- `src-tauri/src/modules/ssh/handler.rs:60-97` `check_server_key` 三分支（命中/未知/不匹配）
- `src-tauri/src/modules/ssh/handler.rs:102-178` `ask_user_to_trust_host` 用 oneshot channel 异步等待前端
- `src-tauri/src/modules/ssh/handler.rs:151` emit Tauri 事件 `ssh:host_verify` / `ssh:host_key_mismatch`
- `src/modules/ssh-explorer/sshStore.ts:491-499` 前端 `resolveApproval` 调 `ssh_approve_host` 回传

**✅ 凭据持久化到 OS Keyring**

- `src-tauri/src/modules/ssh/credentials.rs:57` `KEYRING_SERVICE = "tdsf-ssh-credential"`
- `src-tauri/src/modules/ssh/credentials.rs:69-95` 元数据 JSON + 敏感字段 keyring 双轨
- `src/modules/ssh-explorer/sshStore.ts:175-180` 自动登录 `connectWithSaved` 闭环

**✅ 终端 PTY 数据订阅（修复黑屏）**

- `src/modules/ssh-explorer/sshStore.ts:223-275` `terminalSubscribers` + `pendingBuffer` + 256KB 上限
- `src/modules/ssh-explorer/sshStore.ts:278-321` `emitTerminalData` fan-out 机制
- `src/modules/ssh-explorer/sshStore.ts:374-379` connect 的 onData 真正写到订阅者（修复原 onData 空函数黑屏）

### 1.2 TDSF-S1 致命问题（详见第 3 节 P1-1 / P2-1）

---

## 2. 焦点 2 (TDSF-S2): AI Agent 端到端

### 2.1 状态判定

**✅ PAOR 模板方法已实现**

- `src-tauri/sidecar/agents/base.py:158-332` `invoke()` 模板方法，4 阶段（plan/act/observe/reflect）
- `src-tauri/sidecar/agents/base.py:531-574` `call_tool` 走 `tools.invoke_tool` 统一入口
- `src-tauri/sidecar/agents/base.py:246-271` fix-loop 强制停手机制（max_retry=3）

**✅ 9 个 Agent 注册完整**

- `src-tauri/sidecar/agents/__init__.py:83-94` `AGENT_REGISTRY` 包含 main/coding/explore/history/teach/debug/refactor/test/deploy
- `src-tauri/sidecar/agents/__init__.py:201-204` `agent.invoke` JSON-RPC 端点
- `src/modules/ai/agents/registry.ts:46-83` 前端 `TDSF_AGENTS` 与 Python 端一一对应（coder→coding, explore→explore, history→history, teach→teach）
- `src-tauri/sidecar/agents/__init__.py:229-285` `agent.configure` 支持运行时切换 LLM

**✅ LLM 配置已加载**

- `src-tauri/sidecar/core/llm_config.py:93-100` 环境变量优先 + 配置文件回退
- `src-tauri/sidecar/core/llm_config.py:48-65` LLMConfig provider/api_key/base_url/model 全字段
- `src/modules/ai/lib/sidecar-adapter.ts:277-395` `runSidecarStream` 30s 超时 + abortSignal

**✅ Teach Agent 差异化能力**

- `src-tauri/sidecar/agents/teach_agent.py:235-275` `_generate_teaching_content` 输出 Markdown 教学结构
- `src-tauri/sidecar/agents/base.py:240-244` 反射字段透传 `teaching_content` 给前端
- `src/modules/ai/lib/sidecar-adapter.ts:383-386` 前端追加 teaching_content 作为独立 stream 段

### 2.2 TDSF-S2 致命问题（详见第 3 节 P0-1 / P1-2）

---

## 3. 焦点 3 (TDSF-S3): Skill 系统端到端

### 3.1 状态判定

**✅ 5 个内置 Skill 已加载**

- `src-tauri/sidecar/skills/builtin/` 含 5 目录：docker-management / linux-ops / python-debug / selinux-baseline / ssh-troubleshoot
- `src-tauri/sidecar/skills/registry.py:312-336` `load_builtin` 从 builtin_dir 扫描 `*/SKILL.md`
- `src-tauri/sidecar/skills/registry.py:439-467` `get_global_registry` 单例 + 5 内置加载
- `src-tauri/sidecar/skills/registry.py:457-461` **65 mock skill 已禁用**（TDSF 魔改注释清晰）

**✅ JSON-RPC 5 个方法注册**

- `src-tauri/sidecar/skills/registry.py:550-554` `skill.list / skill.get / skill.invoke / skill.search / skill.count`
- `src/modules/skills/SkillCard.tsx:78-100` 卡片 UI 含 调用/内容/目录 按钮

### 3.2 TDSF-S3 致命问题（详见第 3 节 P0-2 / P1-3）

---

## 4. 致命问题清单（按严重性排序）

### 4.1 P0-1【核心能力】Teach Agent 跑不满 plan 多步，Main Agent 路由只调 sub-agent 一次

- **严重级别**: 🔴 P0
- **影响**: 复合任务（如"修复 nginx.conf 并讲解"）只能完成一半；Teach Agent 规划 [检索→评估→生成] 3 步，但 Main Agent 只调 Teach 一次就跳到下个 sub-task
- **证据**:
  - `src-tauri/sidecar/agents/main_agent.py:282-430` `MainAgent.invoke` 的"Act 阶段"
    - 第 348 行：`_parse_task_prefix` 解析 `[coding]` / `[teach]` 等前缀
    - 第 374 行：`_invoke_sub_agent` 只调用一次，不循环 sub-agent 的 plan
    - 第 396-414 行：循环检查 main_agent 自己的 plan 索引，但 sub-agent 返回 `next_step=continue` 时 main_agent 仍强制 `new_idx = current_idx + 1`
  - `src-tauri/sidecar/agents/teach_agent.py:99-136` `plan_task` 总是返回 2-3 步（"调用 ground 检索 / 评估可信度 / 生成教学内容"）
  - `src-tauri/sidecar/agents/teach_agent.py:211-229` `reflect_on_result` 在最后一步才 `teaching_content`，但 Main Agent 从不给 sub-agent 走完 3 步的机会
- **根因**:
  - Main Agent 把 sub-agent 当"一次性函数"调用（函数式风格），而非"可迭代状态机"
  - Sub-agent 的 `iteration` 字段从未被 Main Agent 累加，sub-agent 永远只看到 `iteration=0`，每次都走首轮 `plan_task`
- **可操作修复** (二选一):
  1. **方案 A（推荐，小改）**: 在 `_invoke_sub_agent` 内部循环，直到 sub-agent 返回 `next_step in (done, error)`：
     ```python
     def _invoke_sub_agent(self, name, task, state):
         sub_state = {**state, "input": task, "iteration": 0, "plan": []}
         for _ in range(MAX_SUB_ITER):  # 兜底防止死循环
             update = invoke_agent(name, sub_state)
             sub_state["iteration"] += 1
             if update.get("next_step") in ("done", "error"):
                 return update
         return update  # 超限
     ```
  2. **方案 B（大改）**: 把 sub-agent 视为独立 LangGraph 子图，由 main_agent 持有 sub-graph 句柄，每次 main_agent 推进时让 sub-graph 跑完再继续。
- **验证方法**: 单元测试 `test_teach_agent_3step_plan`：plan = ["检索", "评估", "生成"]，mock invoke_agent 让前两次返回 next_step=continue、第三次返回 done，断言 teaching_content 真的被填入返回 dict。

---

### 4.2 P0-2【核心能力】Skill "Invoke" 仅返回 SKILL.md 文本，无任何执行逻辑

- **严重级别**: 🔴 P0
- **影响**: 用户点击 SkillCard 的"调用"按钮，以为会执行 skill 实际逻辑，结果只看到一份 markdown 文档。**Skill 名实不符**，"知识卡"和"工具"语义混淆。
- **证据**:
  - `src-tauri/sidecar/skills/registry.py:266-306` `invoke()` 方法两个分支：
    - 内置 Skill：`return {"content": skill.body, "when_to_use": ..., "steps": ..., "examples": ...}` (286-295 行) —— **只是把 SKILL.md 字段打包返回**
    - mock Skill：直接 `return {"content": "mock skill body"}` (298-306 行) —— 假数据
  - 没有任何代码把 `params` 喂给任何**可执行体**（shell command / python function / API call / 工具路由）
  - `src/modules/skills/SkillCard.tsx:39-41` 卡片"调用"按钮触发 `onInvoke` 弹 SkillInvoker 对话框，对话框也只展示 `result.content` 字段
  - 对比 `src-tauri/sidecar/agents/base.py:531-574` `call_tool` 走 `tools.invoke_tool` 真正执行；Skill 系统**没有**对应链路
- **根因**:
  - Skill 在项目里被定位为"知识卡"（知识库条目）而非"可执行工具"
  - UI 层"调用"按钮文案与实际"查看内容"行为错位
- **可操作修复** (二选一):
  1. **方案 A（对齐文案，0.5 天）**: 把 SkillCard 的"调用"按钮改名为"查看内容"，并把 `SkillInvoker` 改名 `SkillViewer`，与 `SkillContentDialog` 合并。明确告知用户 Skill 是知识库条目。
  2. **方案 B（真正执行，2-3 天）**: 在 `registry.invoke()` 增加 `executor` 字段，加载 skill 时同时读取 `SKILL.md` 里的 ```yaml
     ```yaml
     executor:
       type: shell
       command: "docker ps -a"
       timeout: 5
     ```
     执行器走 `subprocess.run`，把 stdout/stderr/exit_code 返回。这样 Skill 才是真正的运维工具。
- **验证方法**: 评审现场点击"调用 linux-ops"按钮，若只是弹出 markdown 文档（P0-2 命中）；若返回 shell 执行结果（修复成功）。

---

### 4.3 P1-1【SSH】自动连接启动时失败完全静默

- **严重级别**: 🟠 P1
- **影响**: 用户配置了"自动登录 lastUsed 最近会话"，但如果 keyring 损坏 / 服务器宕机 / 网络不通，UI 没有任何反馈，session 仍处于 `connecting` 状态无限转圈
- **证据**:
  - `src/modules/ssh-explorer/sshStore.ts:355-433` `connect()` 失败时**有** `toast.error`（行 430），但这只针对手动 connect
  - 自动连接路径在 `SshExplorer.tsx` 的 `useEffect` 中（具体未读到全部），如果走 `connectWithSaved` 失败，没有专门的错误处理分支
  - `src/lib/ssh-bridge.ts:178` 15s 超时后会 reject，但若 keyring 取密码失败（keyring 损坏），错误信息会冒到最外层但 toast 仍走手动 connect 的 catch
- **根因**: 自动连接没有专属 error UI，复用了手动连接的兜底，用户分不清是配置过期还是网络问题
- **可操作修复** (0.5 天):
  1. 在 `SshExplorer.tsx` 的 `useEffect` 自动连接路径加专属 catch：
     ```ts
     try {
       await connectWithSaved(profile);
     } catch (e) {
       toast.error('自动登录失败', {
         description: `${profile.alias}: ${e.message}\n请检查网络或重新配置密钥`,
         duration: 8000,
       });
       // 不要无限重试，只提示一次
     }
     ```
  2. 在 `sshStore.ts:connect` 区分 `trigger: 'manual' | 'auto'`，auto 模式下走更详细的错误码（keyring 缺失 / 网络超时 / 认证失败）
- **验证方法**: 故意删掉一个已保存 profile 的 keyring 条目，重启 App，确认有 toast 提示。

---

### 4.4 P1-2【AI Agent】Sidecar 调用同步阻塞 30s，Abort 后 Python 仍在跑

- **严重级别**: 🟠 P1
- **影响**: 用户点击"停止生成"时，前端立即返回，但 Python sidecar 仍在跑 LLM 调用（可能持续数十秒），下次同会话会撞上"上一个 invoke 还在"导致 stream 错位
- **证据**:
  - `src/modules/ai/lib/sidecar-adapter.ts:299-313` `setTimeout(Sidecar 调用超时 30s)` 的 reject 被 Promise.race 接住后，**Python 端的 `agent.invoke` 不会被中断**（russh / OpenAI 客户端没有 cancel 信号）
  - `src/modules/ai/lib/sidecar-adapter.ts:331-333` abortSignal 检查后 `return`，但 Python 进程继续运行直到 LLM 流结束
  - `src-tauri/src/modules/ipc.rs:278`（注释提到但未读全）JSON-RPC 是 request-response，无 cancellation 协议
- **根因**: JSON-RPC 协议是 fire-and-forget，没有 cancellation token；LLM SDK 也不响应取消
- **可操作修复** (1-2 天):
  1. **方案 A（小改）**: 在 Python 端开 cancel flag
     ```python
     # sidecar/agents/base.py invoke()
     if state.get("cancelled"):
         return {"next_step": "error", "error": "cancelled by user"}
     # 每轮 reflect 前检查
     ```
     前端在 `runSidecarStream` 收到 abort 时额外发 `ipc_invoke { method: "agent.cancel", params: { session_id } }`
  2. **方案 B（大改）**: 弃用同步 `agent.invoke`，改 streaming JSON-RPC（`agent.invoke` → `agent.stream` 持续 yield chunk），前端 abort 直接断 IPC Channel
- **验证方法**: 点击"停止生成"按钮，5s 内确认 sidecar 进程 CPU 占用归零（top / task manager 看 python 进程）。

---

### 4.5 P1-3【Skill】前端 `SkillMetadata` 与后端 `Skill` dataclass 字段映射未明示

- **严重级别**: 🟠 P1
- **影响**: 新增 skill 字段时，前端 `SkillMetadata` 和后端 `Skill` 容易漏改；`category` 字段（linux/docker/ssh/python/custom）后端无对应字段，前端用 hardcoded 5 个 tag 字符串硬映射（`SkillCard.tsx:45-60`）
- **证据**:
  - `src/modules/skills/types.ts`（未读取但被 SkillCard.tsx:30 引用）应定义 `SkillMetadata` 接口
  - `src-tauri/sidecar/skills/parser.py`（未读取但被 registry.py:30 引用）应定义 `Skill` dataclass
  - `src/modules/skills/SkillCard.tsx:45-50` `CATEGORY_COLOR` 写死 linux/docker/ssh/python/custom 5 个字符串，后端 `tags` 是 list[str]，映射关系靠前端硬编码
  - `src/modules/skills/SkillCard.tsx:62-75` `SOURCE_BADGE` 同理 hardcode builtin/installed/user
- **根因**: 前端类型与后端类型无单一来源（single source of truth），靠人工同步
- **可操作修复** (1 天):
  1. 在 `skill.list` JSON-RPC 响应里增加 `category` / `source` 字段（registry.py:412-415 `to_json` 改返回）
  2. 后端 `parse_skill_md` 解析 SKILL.md 里的 ```yaml
     ```yaml
     category: docker
     source: builtin
     ```
     元数据
  3. 前端 `SkillCard` 改成 `const CATEGORY_COLOR = Object.fromEntries(...)` 自动从 data 生成
- **验证方法**: 在后端 `parse_skill.py` 故意加一个 `category: kubernetes` 的 skill，确认前端能正确染色（不会 fallback 到 custom）。

---

### 4.6 P2-1【SSH】TOFU 主机指纹用 SHA256 但仅给一行展示，无 verify 引导

- **严重级别**: 🟡 P2
- **影响**: 用户看到"指纹: SHA256:xxx"无法判断是否正确，MITM 攻击下用户会盲目点"信任"
- **证据**:
  - `src-tauri/src/modules/ssh/handler.rs:71-75` `fingerprint` 是 SHA256 完整字符串
  - `src-tauri/src/modules/ssh/handler.rs:126-136` 弹窗 message 只显示一行 fingerprint，无 base64 编码艺术化指纹（artistic fingerprint）
- **可操作修复** (0.5 天):
  1. 增加 OpenSSH 风格的 art fingerprint（`MD5:xx:xx:xx:...`），用户可 `ssh-keygen -lf /etc/ssh/ssh_host_rsa_key.pub` 对比
  2. 文案加提示："请通过可信渠道（管理控制台 / 同事当面）核对指纹后点击信任"

---

### 4.7 P2-2【AI Agent】`_mock_llm` 永远返回 `[mock-llm] received: ...`，未走真实 LLM 时无降级提示

- **严重级别**: 🟡 P2
- **影响**: 用户在没配 LLM 时调用 Teach Agent，期望生成教学内容，结果只看到 `[mock-llm] teach received: ...`，无任何提示"未配置 LLM"
- **证据**:
  - `src-tauri/sidecar/agents/base.py:515-529` `_mock_llm` 返回 `[mock-llm] {self.name} received: {last_user[:200]}`
  - 前端 `sidecar-adapter.ts:340-342` 检测到 invoke 失败才报"LLM 未配置"，但 invoke 成功 + mock 走通的情况下**无任何告警**
- **可操作修复** (0.2 天):
  1. `_mock_llm` 返回前 emit 一次 mood=warning + 消息"未配置 LLM，当前为规则化 mock 输出"
  2. 前端在 `result.thinking` 包含 `[mock-llm]` 时显示黄色 warning badge

---

## 5. 端到端验证剧本（评委可能问的问题）

| 评委问题 | 现状 | 应对 |
|---------|------|------|
| "SSH 真能连上吗？" | ✅ 能，9 状态机走通，TOFU/keyring 全 | 现场开 SSH 会话，跑 `ls /etc/nginx/` |
| "AI 智能体真能干活吗？" | ⚠️ 能对话但 Teach 跑不满 3 步 | 现场输"解释 systemctl restart nginx"，展示教学 markdown |
| "Skill 真能调吗？" | ❌ 名实不符 | 现场点"调用 linux-ops"，承认只是查看 SKILL.md 内容 |
| "有自动登录吗？" | ⚠️ 有但失败静默 | 现场演示，提到 P1-1 风险 |
| "切换 LLM 模型多久生效？" | ✅ 立即生效（`agent.configure`） | 现场从 deepseek 切到 openai，新对话走新模型 |
| "stop 生成按钮有效吗？" | ⚠️ 前端立即停但后端仍在跑 | 提到 P1-2 风险 |

---

## 6. 修复优先级建议

| 优先级 | 问题 | 预估工时 | 是否阻塞比赛交付 |
|--------|------|---------|----------------|
| P0-1 | Main Agent 路由只跑 sub-agent 一次 | 0.5-1 天 | ⚠️ 建议修复（影响 Teach 差异化卖点） |
| P0-2 | Skill "Invoke" 仅返回文本 | 0.5 天（方案 A） | ❌ 不阻塞（明确改名即可） |
| P1-1 | 自动连接静默失败 | 0.5 天 | ❌ 不阻塞（兜底手动连接） |
| P1-2 | Abort 后 Python 不停 | 1-2 天 | ❌ 不阻塞（用户重发即可） |
| P1-3 | 前端 SkillMetadata 映射 | 1 天 | ❌ 不阻塞 |
| P2-1 | TOFU 指纹可读性 | 0.5 天 | ❌ 不阻塞 |
| P2-2 | Mock LLM 无告警 | 0.2 天 | ❌ 不阻塞 |

**总修复工时**: 4-6.2 天（含 P0-1 / P0-2）

---

## 7. TL;DR

> **SSH 端到端真打通，AI 能对话但 Teach Agent 跑不满 PAOR 3 步（主 Agent 把子 Agent 当一次性函数用），Skill 系统是"知识卡查看器"而非"可执行工具"——核心价值 60% 落地，剩余 40% 主要是 Main Agent 路由逻辑和 Skill 名实问题。**

如果评委 1 分钟内要求答完，用上面这一句。
