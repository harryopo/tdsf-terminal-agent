# Checklist: B1 Agent 安全基座

## 功能完整性

- [ ] G1 前端 redact 补 private-key / authorization / db-url 三模式（IP 明确不脱敏——用户钦定）
- [ ] G1 Python `_redact.py` + get_terminal_output 工具接入（Strands 路径不再裸奔）
- [ ] G2 三处 prompt 注入防伪造条款（Strands 主 agent + PAOR main_agent；无重复条款）
- [ ] G2 deny → lastBlockedCommand → getTerminalContext 注入链路（10 分钟过期）
- [ ] G3 失败块"AI 解释"手动按钮 + ErrorExplainCard 流式卡片
- [ ] G3 节流（同块一次 + 全局单飞行）+ teachAgentEnabled 开关控制
- [ ] G4 terminal.find 快捷键（Ctrl+Shift+F，不与 search.focus 的 Ctrl+F 冲突）
- [ ] G4 TerminalSearchBar（↑↓/大小写/Esc/无匹配提示/clearDecorations）
- [ ] F0 get_terminal_scrollback：修复落地 或 降级文案 + 留档（二选一闭环）

## 红线自查（CLAUDE.md）

- [ ] 未碰终端输入路径 / 未做命令改写（红线 9）
- [ ] useEffect 依赖无自反循环；新组件回调 useCallback / value useMemo（红线 4/5）
- [ ] zustand selector 不返回新引用（红线 6）
- [ ] catch 不静默吞错，降级有日志/注释（红线 4 精神）
- [ ] 删除/修改前 grep 全部调用点（红线 3.5-1）

## 门禁

- [ ] pnpm typecheck 0 错误
- [ ] pnpm lint --max-warnings 0
- [ ] pnpm test 全过
- [ ] pnpm build:web 成功
- [ ] pytest（sidecar 侧 _redact / 条款断言）全过

## 桌面实测（用户执行，spec §5）

- [ ] A1 凭据脱敏复述验证
- [ ] A2 deny 后 AI 如实报告（不编造）
- [ ] A3 失败块一键解释出卡片
- [ ] A4 Teach 关 → 按钮隐藏
- [ ] A5 终端 Ctrl+Shift+F 搜索全流程
- [ ] A6 编辑器 Ctrl+F 行为不回归
- [ ] A7 SSH 会话全链路 + 预测/翻译不回归

## 收尾

- [ ] git commit（全绿）
- [ ] DEV-JOURNAL §37.77 复盘
- [ ] ROADMAP（B1 勾选）+ dev-state 更新
