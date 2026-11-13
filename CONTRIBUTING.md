# 参与 TDSF Terminal Agent 开发

欢迎提交可复现的缺陷、使用反馈、文档改进和范围明确的补丁。先从 [项目状态](docs/STATUS.md) 和 [架构地图](docs/architecture/README.md)了解已有能力与限制。

## 提交方式

1. 缺陷说明版本、环境、操作、预期与实际结果；日志先脱敏。
2. 大功能、跨模块重构、依赖或安全边界变更，先在 Issue 中讨论范围和方案。
3. 从当前代码基线建立独立分支；AI 分支默认使用 `codex/` 前缀。
4. 一个 PR 解决一个明确问题，解释行为变化、验证方式和剩余限制。
5. 维护者审阅后再整合；提交 PR 不等于批准部署、合并或发布。

三人团队按 [固定GitHub流程](docs/development/team-workflow.md)执行：每天及PR前同步main，使用日期/负责人/简述分支；组员提交后不合并，由队长与ROOT检查验证后决定。完整任务卡见 [模板](docs/development/task-template.md)。

## 开发准备

查看 [开发环境](docs/development/setup.md)。安装项目依赖后使用 `pnpm tauri:dev` 启动开发实例。Python sidecar 使用独立虚拟环境，不复制他人本机环境目录。

## 质量要求

- 保留必要测试、锁文件、许可证和构建资源；不提交缓存、凭据、私人知识库或原始对话日志。
- 先补能复现问题的回归，再修改实现；测试应检查可观察行为。
- 按 [测试检查](docs/development/testing.md)选择验证范围，PR 如实列出通过、失败、未执行与受阻。
- 终端/SSH/Agent 修改要说明目标归属、审批、取消、回显等影响；浏览器模拟不能替代原生验收。
- API、事件或用户行为改变时更新对应文档；新方案遵循 [版本规则](docs/development/documentation.md)。
- 代码/测试/脚本与 [更新说明](docs/updates/README.md)同PR提交。代码或决策分歧保留双方依据待商议，不静默取一方覆盖。

AI 或多工作树协作另读 [AGENTS.md](AGENTS.md) 与 [协作规范](docs/development/ai-collaboration.md)。安全问题按照 [SECURITY.md](SECURITY.md)处理，不在公开 Issue 中上传凭据或完整敏感日志。
