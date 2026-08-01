# 高质量验收标准调研（无人值守开发版）

> **日期**：2026-08-01 · **背景**：Tauri 2 + React 19 + Python sidecar 桌面应用长期自主开发，用户质疑"全绿测试名存实亡"（本会话已发生 icon 运行时崩溃/mock 掩盖真实链路/环境残留污染）。
> **目的**：建立从"测试通过"到"运行态证据通过"的验收门禁体系。

---

## 1. 核心结论：为何"全绿但实际坏了"

| 根因 | 表现 | 本会话案例 |
|------|------|-----------|
| **mock 掩盖真实链路** | 单测测假 IPC/假后端，运行时真实调用崩 | icon 崩溃（TerminalSquareIcon 等 3 次）测试环境才暴露 |
| **环境残留污染** | 第二次运行与首次行为不同 | 端口 9300 残留 vite、terax 进程名冲突误杀 |
| **断言漂移** | 只查"没抛错"不查"结果对" | 孤儿测试是 bug 掩盖的假通过 |
| **运行态错误未检测** | console.error/未捕获异常无人看 | CDP 抓错是事后手段，无自动化 |

**对策主线**：验收门禁分层（L1-L5），每层独立工具 + 硬性标准 + 可审计证据；L4 运行态冒烟不可被 mock 绕过。

## 2. 五层门禁清单（无人值守落地版）

| 层 | 工具/手段 | 检查项 | 通过标准 | 失败处理 |
|---|-----------|--------|---------|---------|
| **L1 静态** | eslint(typescript-eslint strict) / tsc / clippy -D warnings / ruff / mypy strict | 类型/风格/未使用/危险模式；自定义规则固化历史事故 | **0 error + 0 warning** | 阻断；AI 修复后重跑 |
| **L2 单测** | Vitest / pytest | 纯逻辑/组件渲染（mock 仅限 UI 层）；覆盖率门槛 | 全绿；覆盖率 ≥ 阈值；变异测试防假测 | 阻断 |
| **L3 集成** | 真实进程：Rust IPC + Python sidecar 真实启动 + 契约测试 | IPC 契约一致/sidecar 可通信/文件真实落盘 | 不 mock 关键链路 | 阻断；输出契约 diff |
| **L4 运行态冒烟** | tauri-driver/WebDriver 或 Playwright 直驱 + 全局 console/pageerror 监听 | ①窗口出现 ②启动静默期后**零 console.error/未捕获异常** ③sidecar 心跳 ④核心交互 3-5 条 ⑤退出无孤儿进程 | 全部通过且错误收集器为空 | 阻断；保存证据包 |
| **L5 发布** | tauri build + 安装验证 + 安装后冒烟 | 安装包可生成/安装/启动 | 安装后 L4 核心项通过 | 回滚标记 |

**跨层规则**：证据可审计（每层出报告）、环境洁癖（临时目录/随机顺序）、失败即红（禁止"已知失败继续"）、时间盒（防挂死）、flaky 与真失败分离。

## 3. 冒烟用例（本应用核心路径）

启动 → 主窗口可见 → sidecar 健康握手 → 左侧栏各视图渲染 → 终端执行命令断言真实输出 → AI 面板打开 → 翻译浮层 → 无 console 错误 → 正常退出无孤儿进程。

## 4. 关键来源

- [Tauri Tests（WebDriver）](https://v2.tauri.app/develop/tests/) / [Mock Tauri APIs](https://v2.tauri.app/develop/tests/mocking/) / [sidecar 打包](https://v2.tauri.app/develop/sidecar/)
- [Playwright Best Practices](https://playwright.dev/docs/best-practices) / [Checkly 日志异常监控](https://www.checklyhq.com/blog/how-to-monitor-javascript-logs-and-exceptions-with-playwright/)
- [Testing Pyramid](https://getautonoma.com/blog/unit-vs-integration-vs-e2e-testing) / [Stryker 变异测试](https://stryker-mutator.io/docs/)
- [When Your Tests Pass But Your App Fails](https://medium.com/building-piper-morgan/when-your-tests-pass-but-your-app-fails-3b3d6f3aeff1)
- [tauri-driver macOS](https://github.com/tauri-apps/tauri/issues/7068) / [WebView2 CI](https://github.com/tauri-apps/tauri/issues/7024)

## 5. 落地计划

1. L1 固化：eslint 0-warning 门禁已生效；把"icon 导入验证/进程按 PID 操作"写入自定义规则与工作准则
2. L3 增强：Rust IPC 契约测试 + sidecar 启动握手测试
3. L4 冒烟：先做"应用启动 + CDP 零错误 + 核心交互"脚本（本机可跑），CI 化后补
4. 每轮开发收尾：L1+L2 必须全绿；涉及核心链路改动追加 L3/L4
