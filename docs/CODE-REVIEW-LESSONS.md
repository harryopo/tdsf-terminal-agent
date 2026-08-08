# AI 代码审查经验与开发规范（防再犯错红线）

> **位置**：`docs/CODE-REVIEW-LESSONS.md`
> **来源**：2026-08-04 ~ 2026-08-07 全方位代码审查（41 项发现）+ 4 批修复（净减 ~9500 行）+ 方案书集成度盘点
> **作用**：沉淀"审查 AI 代码的方法论"与"AI 生成代码的防再犯错规范"。接手者动工前必读；违反任一红线 = 前功尽弃风险。
> **配套**：CLAUDE.md（总纲）→ 本文件（质量红线细则）→ docs/DEV-JOURNAL.md（每篇复盘）→ docs/ROADMAP.md（规划）

---

## 0. 一句话总纲

> **审查报告的评级是启发式线索，不是最终判决；删/改任何代码前，必须沿数据流验证"谁在调用它"。**

本项目 4 批审查修复的最大教训：审查报告说的（russh Handle 实现了 Clone、agents/ 是冗余双系统）与代码事实（Handle 无 Clone、agents/ 是三层结构）**系统性不符**。报告是地图，实地勘探（grep + Read 全调用链）才算数。

---

## 1. AI 代码审查方法论（怎么审）

### 1.1 维度划分（multi-reviewer 并行）

| 维度 | 关注点 | 对应审查发现 |
|------|--------|------------|
| Security | 注入、路径遍历、脱敏、凭据 | Rust-M2（SFTP 路径遍历） |
| Performance | 锁、循环、重渲染、O(n) | Rust-C2/C3（持锁/async 锁）、FE 性能债 |
| Architecture | 结构侵蚀、冗余、死代码 | FE-C2（2367 行上帝组件）、Py-H1（双 Agent） |
| Testing | 盲区、假测试、断言缺失 | 前端 4 关键文件无测试 |

### 1.2 AI 代码六类系统性缺陷（识别清单）

| 缺陷类 | 定义 | 本项目实例 |
|--------|------|-----------|
| 过度工程化 | 不必要抽象/重写 | FE-H2（输入流里重写 cd 命令） |
| 幽灵代码 | 无调用者的死代码 | FE-C1（308KB v4.0.0）、Py-M5（幽灵方法） |
| 假注释/幽灵注释 | 注释与代码背离 | FE-H3（注释七级实际十级） |
| 错误吞噬 | broad except 静默 | Py-H4（212 处，实测大部分合理） |
| 结构侵蚀 | 单体膨胀/职责不分 | FE-C2（App 2367 行） |
| 并发不安全 | 竞态/持锁/错误锁类型 | Rust-C1/C2/C3 |

### 1.3 审查流程红线

1. **评级先行、实证后判**：Critical 发现先读全文件 + 全调用链再下结论，别直接按建议改
2. **搜索证据链**：删除候选代码前 `grep` 全仓找引用（含测试、doc、前端桥）
3. **严重度校准**：全局模式（如 212 处 broad except）要抽样实测分布，不能凭单点推断"严重"
4. **报告必须标注证据位置**：`文件:行号` + 一句话事实，无证据的发现不进报告
5. **区分"合理降级"与"真 bug"**：`logger.exception`（尽力注册）≠ silent 吞错

---

## 2. AI 代码质量红线（开发时防犯错）

### R1. 改动前先验证调用链（最高优先）

- 任何删除/重构/签名修改，先 `grep` 找全部调用点 + 读上下文
- 方法 async 化时，**同步测试必须同步改** `#[tokio::test]`（本项目 2 个测试因此漏改过）
- 反例（教训）：Rust-C3 迁移前穷尽盘点 11 处访问点，一次编译通过；第三批未盘点，E0597 反复

### R2. 结论必须实测，不轻信任何二手信息

- 不轻信：审查报告、JSDoc 旧契约、竞品 README、上游版本声称
- 反例（教训）：russh 0.61 的 `Handle` 实测**只有 Drop 没有 Clone**（审查报告声称"实现 Clone"）→ `h.clone()` 解析为 `&Handle` 的 Clone → E0597

### R3. 锁规范（async Rust 三不变量）

1. **async 上下文不跨 await 持锁**：持锁期间无 `.await`（double-check 模式的 cancellation-safe 不变量）
2. **对象不可 Clone → 缩锁范围**：锁内只做"创建资源"这一步，建好立即 `drop(guard)`，后续操作在锁外（channel 独立于 handle）
3. **锁迁移粒度匹配竞争强度**：
   - 真热路径（每命令必经的查表锁）→ `tokio::sync::RwLock/Mutex`
   - std 上下文（`spawn_blocking` 同步线程）→ **保留** `std::sync`（用 tokio 锁反而错）
   - 微秒临界区/有意设计（注释写明）→ 保留 + 注释说明理由
   - 冷路径（一次性初始化/独立线程）→ 保留
4. **poisoning 恢复**：`unwrap_or_else(|e| e.into_inner())`；迁移 tokio 锁后天然无 poisoning
5. **优先已有依赖**：迁移锁选 `tokio::sync`（已在依赖），不新增 parking_lot（遵守决策边界"新增依赖先问用户"）

### R4. 错误处理规范

- 不静默吞错：catch/except 必须有日志（debug 级也行）或明确降级注释
- 降级策略要显式：`logger.warning(f"... fallback: {e}")` 让"为什么降级"可追溯
- 兜底不是万能：`str()` 兜底、close 兜底等要补注释说明为何不可能抛

### R5. 不留幽灵代码

- 每写完一段，自问：谁调用它？没有调用者 → 删（或标注 `#[allow(dead_code)]` + 理由）
- 删除"疑似死代码"前 grep 验证：含 import、测试、字符串引用

### R6. 验证必须全量（五绿 + 全量测试）

- `cargo check` ≠ `cargo test`：集成测试 + doc test 是**独立编译单元**（本项目 4 个集成测试引用旧 crate 名，cargo test 从未全绿过直到第三批）
- 门禁列表：`pnpm typecheck / lint / test / build:web` + `cargo check / cargo test` + `pytest`
- 改动锁/签名后必须跑 `cargo test` 全量（含新增 tokio::test）

### R7. 编辑纪律

- **连续多次 Edit 同区域要逐次 Read 确认**：相同 `old_string` 用 `replace_all` 后再细化替换，曾造成重复行 + 悬空引用
- PowerShell 无 heredoc：git commit 用多个 `-m` 参数，不用 `<<'EOF'`

### R8. 文档同步（防再漂移）

- 功能完成 = 代码 + 测试 + 文档三件套；方案书声称的状态要与代码事实一致（本项目 §1.1"7 个工具"已过时为 13 个）
- 新功能/新能力落地后，回查方案书对应表格（§4.x）是否过时

### R9. 自动化验证按用户体验视角（用户 2026-08-08 定规）

- **禁止用内部调试对象/状态当验收标准**：`__TDSF_DBG__`、store 直接注入、内部变量（如 `showSshTerminalInWorkspace`）只是实现细节——内部状态"true"不代表用户界面真的渲染了
- **验收 = 用户看到的界面**：终端屏幕内容（xterm buffer 文本）、文件树 DOM、窗口标题、toast/对话框可见性；CDP 脚本模拟真实操作路径（点击按钮 → 填表单 → 提交 → 观察 UI），不走"注入状态"后门
- **不为自动化加缓存/后门**：不要为了测试方便给应用加调试缓存、跳过逻辑、特判分支——那会掩盖真实用户体验问题
- 反例（本会话教训）：曾用 `__TDSF_DBG__.showSshTerminalInWorkspace === true` 断言"SSH 终端正常"，实际用户界面未切换；正确做法是断言 xterm 屏幕出现远程 prompt / 窗口标题显示 `user@host`

---

## 3. 本项目血泪案例速查（报错 → 根因 → 解法）

| 案例 | 根因 | 解法 | 对应红线 |
|------|------|------|---------|
| E0597 生命周期 | russh Handle 无 Clone，`&Handle` clone 引用逃逸 | 锁内建 channel，立即 drop(guard) | R2/R3 |
| cargo test 全量从未过 | 集成测试引用 `terax_lib`（应为 `tdsf_terminal_agent_lib`） | 改 4 个 tests/*.rs + doc test import | R6 |
| 50 万次/秒卡死（历史） | useEffect 依赖自反循环 | 资源用 ref 存，别把 state 塞进依赖 | CLAUDE.md 红线 4 |
| Edit 重复行 | replace_all 后再细化替换 | 逐次 Read 确认 | R7 |
| 幽灵"双 Agent 冗余"误判 | 只看结构没看调用链 | 沿 `set_backend → invoke_agent → sidecar-adapter.ts` 数据流验证 | R1 |
| SFTP 孤儿 channel | check-then-insert TOCTOU | double-check 锁内 get+insert（锁内无 await） | R3 |

---

## 4. 审查修复成果基线（供后续对照）

- 审查报告：`docs/reports/CODE-REVIEW-2026-08-04.md`（41 项，全部有处置结论）
- 4 批修复：commit `bd007aa`（第一批）/ `1d95683`（第二批）/ `e9d9fa5`（第三批）/ `117b59d`（第四批）
- 修复成果：净减 ~9500 行；cargo test 首次全绿 351；pytest 1281；前端 test 896
- 方案书集成度盘点：`docs/方案书-v1.0.md` vs 现状差距（P1 HITL 四决策 / Strands teach 字段 / 工具 3 个 / 决策库 / 可信度接入主路径）——见 dev-state §37.29 与 ROADMAP
