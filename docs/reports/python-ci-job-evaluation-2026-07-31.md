# CI 增加 Python 检查作业评估（2026-07-31）

> 背景：better-harness 发现 `python-sidecar-test-route-broken` 的修复任务之一。
> 本次已完成：`package.json` 的 `test:python` 指向 `src-tauri/sidecar`（本地验证 1280 passed / 37.46s），
> `.gitignore` 中旧 `python-sidecar/` 条目已替换为 `src-tauri/sidecar/` 对应路径。
> 本文档只做「是否在 ci.yml 增加 Python 作业」的评估，未改动 ci.yml。

## 一、现状

- `.github/workflows/ci.yml` 现有 4 个作业：`frontend`（pnpm lint/typecheck/test/build）、`rust`、`rust-platforms`（win/mac 矩阵）、`coverage`（Rust llvm-cov）。**无任何 Python 作业**。
- Python 代码位于 `src-tauri/sidecar/`，是 30 天窗口内变更最热的区域（主入口 9 次提交），拥有 38 个测试文件、1280 个测试。
- `src-tauri/sidecar/pyproject.toml` 已备齐完整工具链配置：pytest（`testpaths = ["tests"]`、asyncio auto）、coverage（`fail_under = 80`）、ruff、mypy，且声明 `requires-python >= 3.11`、dev extras（pytest/pytest-asyncio/pytest-cov/ruff/mypy）。
- 本地全量测试耗时约 37 秒（Windows），CI Linux runner 预期相近。

## 二、结论：建议增加，且成本很低

理由：

1. **门禁缺口最大的地方**：变更最热的核心目前唯一的检查是本地手动 `pnpm test:python`，CI 完全不设防；而 TS 侧与 Rust 侧都有完整 CI 门禁，Python 是三语言栈中唯一裸奔的一侧。
2. **配置已就绪**：pyproject.toml 的 pytest/ruff/mypy 配置齐全，CI 作业只需装依赖后调用，无需新增任何配置文件。
3. **耗时可接受**：1280 个测试约 40 秒，加依赖安装（可缓存）总耗时预计 2-4 分钟，与现有 frontend 作业量级相当，且各作业并行不拉长关键路径。

## 三、建议的作业形态（供后续实施参考）

```yaml
  python:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: src-tauri/sidecar
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
          cache: pip
          cache-dependency-path: src-tauri/sidecar/requirements.txt

      - name: Install dependencies
        run: |
          pip install -r requirements.txt
          pip install pytest pytest-asyncio pytest-cov ruff

      - name: Ruff lint (advisory)
        run: ruff check .
        continue-on-error: true

      - name: Pytest
        run: python -m pytest -v --tb=short
```

## 四、实施注意事项（先决风险，实施时逐条确认）

1. **依赖安装是最大不确定项**：`requirements.txt` 含 langgraph/langchain/chromadb 等重依赖，在干净的 CI 环境中安装可能较慢（首跑 2-5 分钟）或有平台差异；建议首次以 PR 试跑确认，必要时用 `continue-on-error: true` 先行观察一个窗口再转硬门禁。
2. **测试对外部服务的依赖**：本地 1280 个测试全通过，但本地环境可能带有 CI 没有的状态（如已有模型配置、数据库文件）。pyproject 已标记 `integration`/`e2e` markers，若 CI 首跑失败，可先用 `-m "not integration and not e2e"` 收窄为纯单元测试门禁。
3. **mypy 与 coverage 不建议首批纳入**：`fail_under = 80` 与 mypy 严格化都可能在 CI 上首跑即红；建议先只上 pytest（硬）+ ruff（advisory），稳定后再逐步加码。
4. **与 release.yml 的关系**：本评估只涉及 ci.yml 的 PR/push 门禁，不涉及发布链路的 sidecar 打包。

## 五、验证记录（本次修复）

| 项目 | 结果 |
| --- | --- |
| `pnpm test:python` | ✅ 1280 passed, 1 warning, 37.46s（在 `src-tauri/sidecar` 收集执行） |
| `.gitignore` 无 `python-sidecar` 残留 | ✅ `Select-String python-sidecar` 零命中 |
| 新路径 ignore 规则生效 | ✅ `git check-ignore` 确认 `data/`、`.coverage`、`skills/auto-generated/` 均命中 |
| 测试内容与业务代码 | ✅ 未改动 |
