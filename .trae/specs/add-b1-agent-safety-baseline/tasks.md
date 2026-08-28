# Tasks: B1 Agent 安全基座

> 依赖顺序：T1 → T2 → T5 调研 → T3/T4 可并行 → T6 门禁。
> 每个任务完成即跑该模块测试；全量门禁在 T6 统一跑。

## T1 G2 防伪造提示（先做——纯 prompt + 状态注入，成本最低收益高）

- [ ] T1.1 `useTerminalSession.ts`：cancelPendingRiskCommand / deny 分支写 `lastBlockedCommand`（模块级，含 command/reason/ts，10 分钟过期）
- [ ] T1.2 `useAiLiveBridge.ts` getTerminalContext 输出尾部追加 `[TDSF] 最近被拦截命令（未执行）: ...`（有值时；过期不追加）
- [ ] T1.3 条款注入：Strands `adapter.py` `_SUB_AGENT_SPECS` 主 agent system_prompt 末尾 + PAOR `main_agent.py` Constraints（若 base.py 拼接链已覆盖则不加第三处，防重复）
- [ ] T1.4 测试：lastBlockedCommand 注入格式/过期淘汰单测；sidecar pytest 条款存在性断言

## T2 G1 脱敏强化

- [ ] T2.1 `redact.ts` 追加 3 模式：private-key 块（跨行）/ authorization 头 / db-url 连接串；替换文案沿用 `<REDACTED:kind>` 风格
- [ ] T2.2 新建 `sidecar/strands_backend/tools/_redact.py`：对齐前端语义的最小正则集（密钥类/env-assign/私钥块/db-url/authorization）
- [ ] T2.3 `get_terminal_output.py` execute 返回前过 `_redact.redact_sensitive_text()`
- [ ] T2.4 测试：前端 redact.test.ts 补 3 模式断言；Python 侧 pytest 补 _redact 用例（含与前端一致的关键样本）

## T5 F0 get_terminal_scrollback 断链（调研→修或降级）

- [ ] T5.1 调研 DefaultRustBridge：sidecar→前端有无请求-响应往返能力（现有 send_notification 单向）
- [ ] T5.2a 能：前端 handler（listen 请求 → getTerminalContext → 回发）+ Python request_id/2s 超时 → get_terminal_output 真正出数据（记得过 _redact）
- [ ] T5.2b 不能/成本高：工具返回明确降级文案，DEV-JOURNAL 留档 P2

## T3 G4 终端搜索 UI（与 T4 可并行）

- [ ] T3.1 `shortcuts.ts` 加 `terminal.find`（Ctrl+Shift+F，group Terminal）
- [ ] T3.2 addon 注册表：useTerminalSession onSearchReady 回传的 SearchAddon 存 lid→addon（模块级 map，leaf 销毁清理）
- [ ] T3.3 新组件 `TerminalSearchBar.tsx`：输入框/↑↓/大小写/Esc 关闭/无匹配提示；findNext/findPrevious 直调 addon；关闭时 clearDecorations
- [ ] T3.4 接线：App.tsx useGlobalShortcuts handlers 加 terminal.find（激活 leaf 是终端时打开面板并 focus）；面板渲染位置=终端 pane 内
- [ ] T3.5 测试：快捷键注册断言；addon map 生命周期单测（如可测）

## T4 G3 报错解释（手动按钮）

- [ ] T4.1 `BlockOverlay.tsx` Toolbar 加"AI 解释"按钮（failed && teachEnabled；新 prop onExplainError，组件保持纯展示）
- [ ] T4.2 新组件 `ErrorExplainCard.tsx`：loading/流式/完成三态 + 复制/关闭/"在 AI 面板继续问"
- [ ] T4.3 链路：runSidecarStream({agentId:"teach", input:"explain-error:..."})；块文本尾部 2KB 过 redactSensitive
- [ ] T4.4 节流：同块一次 + 全局单飞行；teachAgentEnabled=false 不渲染按钮
- [ ] T4.5 测试：输入构造/redact 接入/节流逻辑单测；BlockOverlay 按钮条件渲染测试

## T6 门禁 + 收尾

- [ ] T6.1 全量：tsc / eslint 0 / vitest 全过 / build:web / pytest（sidecar 侧）
- [ ] T6.2 桌面实测清单（spec §5 A1-A7）交用户执行
- [ ] T6.3 收尾三件事：git commit + DEV-JOURNAL §37.77 + ROADMAP/dev-state 更新（B1 完成项勾选、B2 待拍板）
