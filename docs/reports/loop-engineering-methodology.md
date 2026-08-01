# 循环工程范式（自主开发执行规范）

> **日期**：2026-08-01 · **目的**：无人值守长期自主开发的执行方法论。
> **配套**：`docs/reports/release-gate-research-2026-08-01.md`（L1-L5 验收门禁）、`docs/ROADMAP.md`（任务）、`docs/DEV-JOURNAL.md`（沉淀）。

---

## 1. 核心循环

```
Plan → Research → Implement → Verify → Review → 收尾
 │        │           │          │         │        │
 │   调研存 md      TDD 写码   L1-L4 门禁  simplify/  三件事
 │   (skill 优先)   最小改动    全绿才过   code-review  (commit/
 │                                          skill      journal/
 └────────────────────────── 全绿 + 审查通过 ────────── roadmap)
                否则回到 Implement（systematic-debugging）
```

## 2. 每轮纪律（防偷懒）

1. **先问价值**：这个任务用户真实价值是什么？低价值/重复劳动不做（不为了开发而开发）
2. **先想最优解**：30 秒思考——复用现有/上级目录资产？调研结论？避免重复造轮子
3. **调研先行**：未知领域必须调研（网上 + 本地 + 上级目录三路），调研结论存 `docs/reports/`
4. **Skill 优先**：匹配的 skill 必须激活（subagent-driven-development / simplify / code-review / systematic-debugging / frontend-ui 等）
5. **验收不偷懒**：L1（tsc/eslint 0 warning）+ L2（vitest/pytest 全绿）+ L3（关键链路真实进程）+ L4（应用启动 CDP 零错误）——**禁止"测试过了就提交"**
6. **审查**：每轮代码改动用 simplify/code-review skill 过一遍（质量/复用/安全/可维护）
7. **收尾三件事**：commit（全绿门禁）→ DEV-JOURNAL 复盘 → ROADMAP+dev-state 更新

## 3. 稳定化红线（本会话事故固化）

- **新图标导入前必须 node ESM 验证存在性**（`import * as icons` + typeof）
- **杀进程只按 PID**（不按进程名批量杀——terax 误杀教训）
- **测试环境隔离**：conftest/临时目录防污染（审计链/知识库已有）
- **测试断言验证业务结果**而非"没抛错"；mock 只限 UI 层
- **每次验收按"清持久化 → 全新启动 → 冒烟路径"**执行

## 4. 门禁分层（详见 release-gate-research）

| 层 | 内容 | 通过标准 |
|----|------|---------|
| L1 静态 | tsc/eslint/ruff/clippy | 0 error 0 warning |
| L2 单测 | vitest/pytest | 全绿 + 覆盖率趋势 |
| L3 集成 | Rust IPC + sidecar 真实启动 + 契约 | 关键链路不 mock |
| L4 运行态 | 应用启动 + CDP 零 console 错误 + 核心交互 | 错误收集器为空 |
| L5 发布 | tauri build + 安装 + 安装后冒烟 | 安装后可启动 |

## 5. 执行节奏

- 每轮一个任务单元（大小适中：1 个功能点或 1 组相关修复）
- 每 5 轮一次全面回归 + 文档同步
- 阻塞 >2 次 → 停下质疑架构（systematic-debugging Phase 4.5），不硬闯
