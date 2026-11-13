# 依赖升级 + 生产审计修复交接文档（2026-11-02）

> 面向下一位接手的开发者（含 GPT 驱动的 agent）。本文只记录可核对的事实：分支、提交、真实命令输出、回滚步骤与已知风险。
>
> 本分支**不修改 main、不 force push、不合并、不关闭** Dependabot PR #38/#39/#40/#41。

## 1. 基本信息

| 项目 | 值 |
|---|---|
| 分支 | `chore/deps-audit-2026-11-02` |
| 基线 | `origin/main` @ `44c4fda6448f58a25cba19467f04d71141b350dc`（feat(site): hero switches to the split magazine layout） |
| 本地工作区 | `D:\ai\linux教学一体\tdsf-deps-audit-wt`（独立 worktree，主工作区未改动） |
| 创建方式 | 从 `origin/main` 新建分支，未切主工作区、未 stash 任何东西 |
| 工具链 | Node `v24.20.0`，pnpm `11.24.0`，cargo/rustc `1.98.0`，Windows 11 |
| 审计证据 | `D:\ai\linux教学一体\tdsf-deps-audit-before.json`（修复前 `pnpm audit --prod --json` 原始输出，未入库） |

## 2. 提交清单（一个依赖一个 commit）

按时间顺序：

| # | Commit | 类型 | 改动文件 | 一句话说明 |
|---|---|---|---|---|
| 1 | `9f338fdcdb7dcbf4a92a3df1735c434d65c42fef` | `fix(deps)` | `src-tauri/Cargo.lock` | rustls 0.23.45 → 0.23.46，按 #41 的 patch 原样采用；含 windows-sys 0.52→0.59 的 Cargo 重解析 |
| 2 | `f1f279c1347fdfe49c9da2a32e4191b37abf32db` | `fix(deps)` | `pnpm-lock.yaml` | undici 7.30.0 → 7.30.1（dev-only，经 shadcn 引入） |
| 3 | `091ec147925e17028acd432be408860a21be9037` | `fix(deps)` | `pnpm-lock.yaml` | fast-uri 3.1.8 → 3.1.9（dev-only，经 shadcn → MCP SDK → ajv 引入） |
| 4 | `651f8b312b7a669784cfbc01b0bff0027a49330c` | `feat(deps)` | `package.json`, `pnpm-lock.yaml` | happy-dom 20.14.6 → 21.0.4（major，仅 vitest 测试环境）；commit body 含 `BREAKING CHANGE` 说明 |
| 5 | `c46a4f0405b8f7a5eff7aed8f479c12d12c6405f` | `fix(deps)` | `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` | dompurify override 3.4.16 → 3.4.17、zod `^4.4.3` → `^4.6.7`，清零生产审计 |
| 6 | 本文件所在 commit | `docs(handoff)` | `docs/handoff/2026-11-02-deps-audit.md` | 交接记录（SHA 见 `git log -1 -- docs/handoff/2026-11-02-deps-audit.md`） |

分支总 diff（相对 `origin/main`）：4 个文件，+87 / −85。

## 3. 升级动机（对应 CVE / GHSA）

### 3.1 rustls 0.23.45 → 0.23.46（#41）

- `GHSA-vp88-798v-h67f`：客户端在 ECH 被服务端拒绝后，仍发送握手完成前缓冲的应用数据；**影响 0.23.44–0.23.45，本仓库原版本正好在受影响区间**。
- `GHSA-h2v8-394m-p7vv`：Brotli 证书解压可被攻击者放大到最多 1 GiB 内存。
- `GHSA-w44r-93j7-qv28`：未认证的 ServerHello 可污染 per-name KX hints。
- `GHSA-c8m5-c952-6cm4`：`Debug` 实现会打印 TLS 会话密钥材料。

补充：仓库源码没有直接调用 rustls（仅 `reqwest["rustls-tls"]` 与 `bollard["ssl"]` 间接使用），也未启用 Brotli/ECH 配置，所以多数漏洞不可直接触发，但 0.23.46 是官方修复版本。

Cargo.lock 中 5 个 crate 的 `windows-sys` 由 `0.52.0` 变为 `0.59.0`：`errno`、`rustix`、`tempfile`、`winapi-util`、`rustls-platform-verifier`。这 5 个 crate 的**版本号没有变**；它们各自声明 `>=0.52,<0.62`（`winapi-util` 为 `>=0.48,<=0.61`）的宽范围，因此这是 Cargo 重新解析的结果，不是 rustls 特性变化，也不是这 5 个 crate 升级。`cargo check --locked` 已通过。

### 3.2 undici 7.30.0 → 7.30.1（#40）

- `GHSA-qrxm-fqhp-jwvm`：TLS 1.2 换证重协商可使 Node 进程崩溃。
- `GHSA-2m5v-pch6-74hx`：`Agent` 的 JSON 克隆丢失函数型 TLS 选项（如 `checkServerIdentity`），导致证书校验绕过。
- `GHSA-4w7w-5xrc-9h26`：跨源重定向可污染共享缓存/泄露响应。
- `GHSA-xjj6-f33q-929c`：过多 `Content-Encoding` 造成未处理流错误/进程崩溃。
- 另有 SRI 大小写、EventSource 解析器内存、WebSocket PONG 背压等中危修复。

影响面：`package.json` 未声明 undici；依赖链为 `shadcn → @dotenvx/dotenvx → undici` 与 `shadcn → undici`，`shadcn` 在 `devDependencies`，**不进入发布产物**。

### 3.3 fast-uri 3.1.8 → 3.1.9（#39）

- `GHSA-w74x-v6f9-j3xg` / CVE-2026-110306：百分号编码 scheme 欺骗。
- `GHSA-wjr9-j795-jxcr` / CVE-2026-110180：域名主机规范化时的主机混淆。
- `GHSA-xhq7-xmqj-769h` / CVE-2026-110095：相对引用规范化错误。
- `GHSA-333x-w4r6-6crp` / CVE-2026-110725：后缀引用中的 scheme 注入。

影响面：`shadcn → @modelcontextprotocol/sdk → ajv@8.20.0 → fast-uri`，dev-only。

### 3.4 happy-dom 20.14.6 → 21.0.4（#38，major）

21.0.0 的破坏性变更：**默认关闭 CSS 文件加载与 iframe 页面加载**（SSRF 加固）；`disableCSSFileLoading` 废弃，新增 `enableCSSFileLoading` / `enableIframePageLoading`。21.0.4 另修复 ESM 编译器代码注入与 `data:` iframe 跨域隔离。

本项目影响评估：`vitest.config.ts` 用 `environment: 'happy-dom'`，但全仓无 `disableCSSFileLoading` / `enableCSSFileLoading` 使用；`src/modules/preview/PreviewPane.test.ts` 只对 JSX 源码做正则断言、不真实渲染 iframe；`src/lib/test-environment.security.test.ts` 只用 `new Window()` + `document.write`，不加载外部 CSS/iframe。**实测 2240 个测试全部通过，无需修改测试 setup。**

### 3.5 审计基线修复（dompurify / zod）

`pnpm audit --prod --audit-level high` 修复前报 4 条：

| 包 | 严重度 | GHSA | 修复版本 |
|---|---|---|---|
| dompurify | critical | GHSA-cg2g-xh64-v4q7（SAFE_FOR_TEMPLATES bypass） | ≥3.4.17 |
| dompurify | high | GHSA-mrv2-3pqr-j5jr（IN_PLACE hook 遗留事件处理器） | ≥3.4.17 |
| dompurify | low | GHSA-c6gr-qvv4-5v3f（SMIL attributeName 守卫） | ≥3.4.17 |
| zod | high | GHSA-mrhx-c7xc-m3w5（超大集合校验导致内存耗尽） | ≥4.6.6 |

处理方式：

- dompurify 是 `mermaid@11.17.2`（声明 `^3.3.3`）/ `streamdown@2.5.0 → mermaid` 的传递依赖。`pnpm-workspace.yaml` **原本就把 dompurify override 到 3.4.16**，恰好落在漏洞区间；本分支把该 override 改为 `3.4.17`。mermaid 只调用 `DOMPurify.sanitize`，公开 API 未变，无需改业务代码。
  - 注意：pnpm 11 下直接 `pnpm update dompurify` 会显示 "Already up to date"，因为 override 固定了版本；**必须改 `pnpm-workspace.yaml` 的 overrides**。
- zod 是直接依赖：`^4.4.3` → `^4.6.7`。`@ai-sdk/provider-utils@5.0.14` 与 `ai@7.0.40` 的 peer 都是 `zod: ^3.25.76 || ^4.1.8`，4.6.7 在范围内；升级后 typecheck/tests/build 均通过。
  - 4.6.6 上游说明包含 "check array/set/map size bounds before parsing elements" 的安全修复与 record 类型声明修复；4.6.7 的 GitHub release 页面只返回签名信息，未取到完整说明（见第 7 节）。

## 4. 真实验证记录

全部命令在 `D:\ai\linux教学一体\tdsf-deps-audit-wt` 执行。

### 4.1 安装与 lockfile

```powershell
pnpm install --frozen-lockfile
```

结果：`Already up to date`，退出码 0。首次安装时 `pnpm install --frozen-lockfile` 也通过（916 个包，lockfile 与 package.json 一致）。

> 环境备注：最初把 worktree 放在 `%TEMP%` 时，pnpm 在 store 注册项目符号链接时报 `EBUSY`（Windows 文件锁）。换到 `D:\ai\linux教学一体\tdsf-deps-audit-wt` 后正常。这是本机路径问题，不是仓库问题。

### 4.2 生产审计（前后对比）

修复前：

```powershell
pnpm audit --prod --audit-level high --registry=https://registry.npmjs.org/
# 4 vulnerabilities found
# Severity: 1 low | 2 high | 1 critical
# dompurify ×3（critical/high/low）+ zod ×1（high）
# 退出码 1
```

修复后：

```powershell
pnpm audit --prod --audit-level high --registry=https://registry.npmjs.org/
# No known vulnerabilities found
# 退出码 0
```

**4 条漏洞已清零。** 原始 JSON 证据：`D:\ai\linux教学一体\tdsf-deps-audit-before.json`。

### 4.3 前端检查

| 命令 | 结果 | 退出码 |
|---|---|---|
| `pnpm lint`（eslint . --max-warnings 0） | 无输出/无告警 | 0 |
| `pnpm typecheck`（tsc app + node） | 无错误 | 0 |
| `pnpm test`（vitest run） | **243 个测试文件、2240 个测试全部通过**，耗时 35.57s | 0 |
| `pnpm build`（tsc + vite build） | 构建成功，26.61s；仅有既存的 >500 kB chunk 体积告警 | 0 |

### 4.4 Rust 侧

```powershell
cd src-tauri
# 与 CI 相同：ci 不构建 PyInstaller sidecar，仅放占位目录
New-Item -ItemType Directory -Force sidecar\tdsf-sidecar
New-Item -ItemType File -Force sidecar\tdsf-sidecar\.ci-placeholder
cargo check --all-targets --locked
# Finished `dev` profile ... in 20.78s
# 退出码 0
```

说明：第一次 `cargo check` 失败于 `resource path sidecar\tdsf-sidecar doesn't exist`，这是 Tauri 打包资源校验，与本分支依赖改动无关；补上 CI 同款占位目录后通过。`.ci-placeholder` 已被 `.gitignore` 忽略，未提交。

### 4.5 额外发现（未处理）

```powershell
pnpm peers check
# ✕ unmet peer zod
#   Installed: 3.24.1
#   Wanted: ^3.25 || ^4.0 (@modelcontextprotocol/sdk@1.32.1)
#           ^3.25.28 || ^4 (zod-to-json-schema@3.25.2)
```

这是 **dev-only**（`shadcn → @modelcontextprotocol/sdk`）的既存问题，`origin/main` 的 lockfile 同样是 zod 3.24.1；本分支没有引入它，也没有修它（避免扩大改动范围）。应用生产侧 zod 已统一为 4.6.7。

## 5. 回滚方法

### 5.1 回滚单个依赖

在 main（或本分支）上逐个 revert 对应提交即可，顺序建议倒序：

```powershell
git revert c46a4f0405b8f7a5eff7aed8f479c12d12c6405f   # 审计修复（dompurify/zod）
git revert 651f8b312b7a669784cfbc01b0bff0027a49330c   # happy-dom 21
git revert 091ec147925e17028acd432be408860a21be9037   # fast-uri
git revert f1f279c1347fdfe49c9da2a32e4191b37abf32db   # undici
git revert 9f338fdcdb7dcbf4a92a3df1735c434d65c42fef   # rustls
```

revert 后执行 `pnpm install` 重新生成 node_modules，再跑第 4 节命令。

### 5.2 放弃整条分支（推荐的最安全方式）

因为分支从未合并、main 从未修改：

```powershell
# 1) 不合并 PR，直接关闭 draft PR（人工操作）
# 2) 删除远端分支
git push origin --delete chore/deps-audit-2026-11-02
# 3) 删除本地分支与 worktree
git worktree remove D:\ai\linux教学一体\tdsf-deps-audit-wt
git branch -D chore/deps-audit-2026-11-02
```

### 5.3 如果已经合并到 main

```powershell
# 找到合并提交
git log --merges --oneline -1
# 回滚整个合并（保留 main 其他历史）
git revert -m 1 <merge-commit-sha>
```

不要使用 `git reset --hard` 或 force push 修改 main 历史。

### 5.4 main 不受影响的保证

- 所有 6 个提交只存在于 `chore/deps-audit-2026-11-02`。
- `origin/main` 仍是 `44c4fda...`，未被触碰。
- 未执行 force push、未关闭 Dependabot PR、未改动主工作区未提交内容。
- 本次所有验证在独立 worktree 完成；worktree 内仅有被 `.gitignore` 忽略的 `node_modules`、`dist`、`target` 和 sidecar 占位目录。

## 6. 与 4 个 Dependabot PR 的对应关系

| Dependabot PR | 本分支对应提交 | 说明 |
|---|---|---|
| #41 rustls 0.23.45→0.23.46 | `9f338fd` | 直接采用 #41 的 Cargo.lock patch，内容等价 |
| #40 undici 7.30.0→7.30.1 | `f1f279c` | 直接采用 #40 的 lockfile patch |
| #39 fast-uri 3.1.8→3.1.9 | `091ec14` | 直接采用 #39 的 lockfile patch（其 base 较旧，但 patch 可干净应用） |
| #38 happy-dom 20.14.6→21.0.4 | `651f8b3` | 直接采用 #38 的 patch；本分支额外做了全量测试验证 |

**合并本 PR 之后的处置建议**：

1. 先合并本 PR（由人工决定，本次只开 draft）。
2. 在 #38/#39/#40/#41 各留一条评论：`Superseded by #<本 PR 编号>; the same versions are already on main with audit fixes`。
3. 关闭这 4 个 PR（**不要**再合并，否则会产生重复/冲突提交）。
4. 若 #41 的 windows-sys 重解析被后续 `cargo update` 改变，以 `Cargo.lock` 实际内容为准，不要手工回退。

## 7. 给 GPT 的交接注意事项

1. **不要 `cargo update` 全量更新**。rustls 这次只需要 `Cargo.lock` 的目标 patch；全量更新会引入额外的 windows-sys/其他依赖漂移。若必须更新，先看 `git diff src-tauri/Cargo.lock` 是否只包含预期包。
2. **dompurify 的版本由 `pnpm-workspace.yaml` 的 `overrides` 决定**，不是在 `package.json` 里。下次升级 dompurify 时改 override 再 `pnpm install --no-frozen-lockfile`；只跑 `pnpm update dompurify` 不会生效。
3. **zod 有两份**：生产侧 4.6.7（`package.json` 直接依赖），dev 侧 3.24.1（`shadcn → @modelcontextprotocol/sdk`）。`pnpm peers check` 会报后者的 unmet peer，这是既存问题；若要修，需要把 shadcn/MCP SDK 链路对齐到 zod ≥3.25，属于独立任务。
4. **happy-dom 21 的测试环境差异**：默认不加载外部 CSS 文件和 iframe 页面。若未来测试需要这两种能力，在创建 `Window`/测试 setup 时显式设置 `enableCSSFileLoading: true` / `enableIframePageLoading: true`，不要降回 20.x。
5. **验证必须带 `--registry=https://registry.npmjs.org/`**：本机 `.npmrc` 默认走 npmmirror，审计结论要以 npm 官方库为准；CI 也是这么做的。
6. **CI 的 `frontend` job 现在应能越过 audit 步骤**：之前它卡在 `pnpm audit --prod`，本分支已清零。其余 `python`/`rust`/`rust-test`/`coverage` 不受这些前端依赖影响。
7. **本地跑 `cargo check` 前先补 sidecar 占位目录**（见 4.4），否则会报 `resource path sidecar\tdsf-sidecar doesn't exist`，这是 Tauri 资源校验，不是编译错误。
8. **不要关闭/合并 #38/#39/#40/#41**，直到本 PR 合并后再按第 6 节处置。

## 8. 已知风险 / 未完成事项

- **4.6.7 release notes 未完整获取**：GitHub 的 v4.6.7 页面只返回签名信息。已用 4.6.6 的公开说明 + 本地 `pnpm typecheck` / `pnpm test` / `pnpm build` 全部通过作为兼容性证据；若需要更严格，可在合并前再查一次上游 changelog。
- **dompurify 3.4.17 的影响面基于 API 稳定性推断**：mermaid 只调用 `sanitize`，本分支未改业务代码；但未对 mermaid 渲染路径做手工 UI 验证（自动化测试覆盖了 mermaid-block 相关测试）。
- **未在 Linux/macOS 本地跑 Rust 测试**：`cargo check --locked` 在 Windows 通过；CI 的 `rust-test (windows-latest / macos-latest)` 会覆盖跨平台。rustls 只改 lockfile，风险低。
- **`pnpm peers check` 的 zod peer 告警未修**（见 4.5），属既存 dev-only 问题。
- **`docs/` 被 `.gitignore` 整体忽略**（仓库精简策略，`.gitignore` 第 141 行）。本文件是用 `git add -f` 强制入库的唯一例外；后续修改本文件后再次提交时仍需要 `git add -f docs/handoff/2026-11-02-deps-audit.md`。
- **build 的 >500 kB chunk 告警**为既存问题，与本分支无关。
- 本 PR 为 **draft**，未合并、未关闭任何 Dependabot PR。

## 9. 复现清单（最短路径）

```powershell
git fetch origin
git switch -c chore/deps-audit-2026-11-02 origin/main   # 或在独立 worktree 中检出
pnpm install --frozen-lockfile

pnpm audit --prod --audit-level high --registry=https://registry.npmjs.org/
pnpm lint
pnpm typecheck
pnpm test
pnpm build

cd src-tauri
New-Item -ItemType Directory -Force sidecar\tdsf-sidecar
New-Item -ItemType File -Force sidecar\tdsf-sidecar\.ci-placeholder
cargo check --all-targets --locked
```
