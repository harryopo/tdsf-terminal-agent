# Bash 命令解析库调研：用于危险命令识别（替代手写正则）

> **调研目标**：为 `tdsf-linux-desktop/src/main/core/risk-engine.ts` 寻找成熟的 Bash 解析库，替代当前完全基于正则的 5 级风险分级方案，解决正则无法处理命令拼接绕过、变量展开、子进程替换等高级 Bash 语法的问题。
>
> **调研时间**：2026-07-18
> **约束**：必须是 Node.js 原生可用，不能引入 Python/Go 运行时依赖（可使用 WASM）。

---

## 一、各库对比表

| 库名 | 安装方式 | 维护状态 | API 易用性 | Electron 可行性 | 总评 |
|---|---|---|---|---|---|
| **bashlex** (Python) | `pip install bashlex` | 活跃，GitHub ~400★ | 输出 AST，支持命令名/参数/重定向/管道 | ❌ 不可行，需 Python 运行时 | 不推荐 |
| **tree-sitter-bash** (原生) | `npm i tree-sitter tree-sitter-bash` | 极活跃，1.1千万周下载，190 dependents | 输出 CST，能识别所有 Bash 语法 | ⚠️ 需 node-gyp 编译，跨平台需 electron-rebuild | 备选 |
| **tree-sitter-bash** (WASM) | `npm i web-tree-sitter tree-sitter-bash` | 极活跃，2千万周下载，1135 dependents | 同上，无需原生编译 | ✅ 完美，零原生编译 | **首选** |
| **bash-parser** (vorpaljs) | `npm i bash-parser` | ❌ 已废弃，最后发布 2017 | 输出 AST，支持基本语法 | ✅ 纯 JS | 不推荐 |
| **@ericcornelissen/bash-parser** | `npm i @ericcornelissen/bash-parser` | ⚠️ 已宣布 2025-12-31 停止支持 | 同上 | ✅ 纯 JS | 不推荐 |
| **@banyudu/bash-parser** | `npm i @banyudu/bash-parser` | 活跃，但周下载仅 10 | 同上 | ✅ 纯 JS | 不推荐 |
| **unbash** | `npm i unbash` | 极活跃，v3.0.0 一个月前发布，430 万周下载 | 输出 AST，TypeScript 原生，零依赖 | ✅ 完美，零原生编译 | **强备选** |
| **mvdan-sh** (GopherJS 转译) | `npm i mvdan-sh` | ❌ 已废弃 3 年，包体 1.5MB | Go API 风格，可用但笨重 | ⚠️ 包大，已废弃 | 不推荐 |
| **sh-syntax** (mvdan-sh 的 WASM 版) | `npm i sh-syntax` | 活跃，v0.5.8 一年前发布，25.8 万周下载 | 输出 AST，支持 print | ✅ WASM 无需原生编译 | 备选 |
| **shellcheck** (Haskell 二进制) | `apt install shellcheck` / 下载二进制 | 极活跃，事实标准 | CLI 工具，无 Node API | ❌ 需外部二进制 | 不推荐 |

### 1.1 bashlex（Python 库）

- **安装**：`pip install bashlex`
- **维护**：活跃，但 GitHub star 数较低（约 400），社区规模小
- **API**：Python 原生，`bashlex.parse('rm -rf /')` 输出 AST，能识别命令名、参数、重定向、管道、子进程替换
- **Electron 可行性**：❌ 不可行
  - 没有 Node.js binding
  - 只能通过 `child_process.spawn('python', ['-c', '...'])` 子进程调用
  - Electron 应用需捆绑 Python 运行时（约 30-100MB），违背"无 Python 依赖"约束
  - 跨平台打包复杂，Windows/macOS/Linux 行为不一致
- **结论**：**直接排除**

### 1.2 tree-sitter-bash（两种 binding）

tree-sitter 是 GitHub Atom 团队开发的增量解析框架，已成为业界事实标准。Bash 语法由 `tree-sitter-bash` 提供。它有两种 Node.js binding，差异显著：

#### 1.2.1 原生 binding（`tree-sitter` npm 包）

- **安装**：`npm install tree-sitter tree-sitter-bash`
- **维护**：极活跃，`tree-sitter` 包周下载 1150 万，`tree-sitter-bash` 周下载 1140 万，190 dependents
- **API**：
  ```js
  const Parser = require('tree-sitter');
  const Bash = require('tree-sitter-bash');
  const parser = new Parser();
  parser.setLanguage(Bash);
  const tree = parser.parse('rm -rf / | sudo dd of=/dev/sda');
  console.log(tree.rootNode.toString()); // 完整 CST
  ```
- **能识别**：command name、arguments、redirects、pipes、subshell、command substitution `$(...)`、process substitution `<(...)`、heredoc、变量展开 `${...}`、`[[ ]]`、`(( ))`、case/for/while/if 全部控制流
- **Electron 可行性**：⚠️ 需注意
  - **需要 node-gyp 原生编译**：Windows 需 Visual Studio Build Tools + Python 3.12+；macOS 需 Xcode CLT；Linux 需 gcc/make
  - **Electron 集成**：需 `electron-rebuild` 或 `@electron/rebuild` 重新编译针对 Electron ABI 的二进制
  - **跨平台分发**：需为 win32-x64 / darwin-arm64 / linux-x64 等组合分别提供预编译 .node 文件（prebuild）
  - **已知痛点**：用户机器无编译环境时安装失败率较高，electron-builder 需配置 `asarUnpack: ["**/*.node"]`

#### 1.2.2 WASM binding（`web-tree-sitter` npm 包）⭐

- **安装**：`npm install web-tree-sitter tree-sitter-bash`
- **维护**：极活跃，`web-tree-sitter` 周下载 2040 万，1135 dependents，最新版 0.26.11（2 天前发布）
- **API**：
  ```js
  const { Parser, Language } = require('web-tree-sitter');
  await Parser.init();
  const Bash = await Language.load('node_modules/tree-sitter-bash/tree-sitter-bash.wasm');
  const parser = new Parser();
  parser.setLanguage(Bash);
  const tree = parser.parse('rm -rf /');
  console.log(tree.rootNode.toString());
  ```
- **Electron 可行性**：✅ 完美
  - **零原生编译**：纯 WASM，无需 node-gyp / Visual Studio / Xcode
  - **跨平台一致**：win32/darwin/linux 同一份 .wasm 文件
  - **分发简单**：仅一个 .wasm 文件（约 200KB），随 npm 包附带，无需 electron-rebuild
  - **性能优秀**：WASM 在 V8 中接近原生速度，单条命令解析 < 1ms
  - **Claude Code 事实采用**：见 §2.1

### 1.3 shell-parse / bash-parser 系列（纯 JS）

`bash-parser` 最初 fork 自 `js-shell-parse`，使用 jison 文法生成器，纯 JS 实现。多个 fork 状态如下：

| 包名 | 最后发布 | 周下载 | 状态 |
|---|---|---|---|
| `bash-parser` (vorpaljs) | 2017-06 | ~50 | ❌ 已废弃 8 年 |
| `@ericcornelissen/bash-parser` | 2 年前 | 4.2 万 | ⚠️ 已宣布 2025-12-31 EOL |
| `@banyudu/bash-parser` | 1 个月前 | 10 | ⚠️ 个人 fork，使用极少 |
| `@isdk/bash-parser` | 2 年前 | ~5 | ⚠️ Deno 专用，不适用 Node |

- **API 易用性**：输出 AST，节点类型有 `Script`、`Command`、`Word`、`Pipeline`、`AndOr`、`Redirect` 等，比 tree-sitter 的 CST 更"语义化"
- **能识别**：命令名、参数、管道、重定向、变量展开、命令替换；**不能识别**：Bash 4+ 扩展（`coproc`、`${ cmd; }`）、部分 extglob
- **危险模式识别能力**：基本够用，但缺乏对复杂 Bash 5.x 语法的支持
- **Electron 可行性**：✅ 纯 JS，无原生编译
- **结论**：**因维护状态差，整体不推荐**。如必须用纯 JS 方案，应选 `unbash`

### 1.4 mvdan-sh（Go 库）的两种 Node.js 形态

mvdan-sh 是 Go 生态最权威的 shell parser/formatter/interpreter（7.6k★），支持 POSIX/Bash/mksh。两种 Node.js 形态：

#### 1.4.1 GopherJS 转译版（`mvdan-sh` npm 包）

- **状态**：❌ 已废弃 3 年（最后发布 2022 年），npm 页面明确标注 deprecated，指向 GitHub issue #1145
- **包体**：1.51 MB（未压缩），加载慢
- **API**：Go 风格（`syntax.NewParser()`、`parser.Parse()`、`syntax.Walk()`），不符合 JS 习惯
- **结论**：**不可用**

#### 1.4.2 WASM 版（`sh-syntax` npm 包）⭐

- **安装**：`npm install sh-syntax`
- **维护**：活跃，v0.5.8 一年前发布，周下载 25.8 万，6 dependents
- **API**：
  ```js
  import { parse, print } from 'sh-syntax';
  const ast = await parse("rm -rf /");
  const newText = await print(ast, { originalText: "rm -rf /" });
  ```
- **能识别**：基于 mvdan/sh，Bash 支持最完整（POSIX/Bash/mksh/Bats 全方言）
- **Electron 可行性**：✅ WASM，跨平台
- **性能**：单次解析 ~18ms（M1 Max），比 web-tree-sitter 慢约 10-20 倍（因为 WASM 包大、初始化重）
- **优点**：Bash 语法支持最权威、内置 formatter 可用于"规范化命令后再检测"
- **缺点**：API 异步、初始化重、包体大（WASM ~1MB+）
- **结论**：**备选方案**，适合对语法覆盖度要求极致的场景

### 1.5 新发现：unbash（纯 TypeScript）⭐

调研中意外发现的高质量纯 JS 库：

- **安装**：`npm install unbash`
- **维护**：极活跃，v3.0.0 一个月前发布，周下载 **430 万**，7 dependents
- **作者**：webpro-nl（知名开源作者，`release-it`、`npm-check-updates` 维护者）
- **包体**：53KB minified / 13KB gzipped，零依赖
- **API**：
  ```ts
  import { parse } from "unbash";
  const ast = parse('if [ -f "$1" ]; then cat "$1"; fi');
  // 返回结构化 AST，TypeScript 原生类型
  ```
- **能识别**：Bash 5.3 `${ cmd; }`、`[[ ]]`、`(( ))`、extglob、process substitution、coproc、herestrings、C-style for、select 等
- **特性**：
  - 同步 API（比 sh-syntax 的异步更易用）
  - 容错解析，从不抛异常，收集错误到 AST
  - 结构化 word parts、parameter expansions、arithmetic expressions
- **Electron 可行性**：✅ 完美，零依赖纯 TS，可直接打包进主进程
- **vs tree-sitter-bash**：unbash 输出 AST（语义节点），tree-sitter 输出 CST（含所有标点 token）；unbash 更适合"识别危险模式"，tree-sitter 更适合"语法高亮/编辑器"
- **性能**：在 short/medium 命令上比 tree-sitter-bash WASM 快 8-16 倍
- **结论**：**强备选**，是 tree-sitter-bash WASM 之外的另一个优秀选择

---

## 二、业界危险命令识别方案调研

### 2.1 Claude Code（Anthropic 官方）— 业界标杆

通过反编译 `claude-code` CLI 包（多个开源分析项目已确认）发现，Claude Code 采用 **三层防御**：

| 层级 | 实现 | 文件 |
|---|---|---|
| L1 权限规则 | 用户配置 `allow`/`deny`/`ask` 规则，glob 匹配 | `src/utils/permissions/permissions.ts` (~500 LOC) |
| L2 危险模式 | 正则黑名单 + Zsh 防绕过 | `src/utils/permissions/dangerousPatterns.ts` (~300 LOC) |
| L3 AST 分析 | **tree-sitter-bash 解析** + shell-quote fallback | `src/utils/bash/ast.ts` |
| L4 ML 分类器 | `bashClassifier` 基于历史模式 + 语义意图分类 | `src/utils/permissions/bashClassifier.ts` (~400 LOC) |
| L5 破坏性警告 | `DESTRUCTIVE_PATTERNS` 强制人工确认 | `src/tools/BashTool/destructiveCommandWarning.ts` (~150 LOC) |
| L6 Bash 安全 | 拦截命令替换 `$(...)`、进程替换 `<(...)`、Zsh `=cmd`、`zmodload` 等 | `src/tools/BashTool/bashSecurity.ts` (~300 LOC) |

**核心代码示例**（来自 `destructiveCommandWarning.ts`）：
```ts
const DESTRUCTIVE_PATTERNS = [
  { pattern: /\bgit\s+reset\s+--hard\b/, warning: 'may discard uncommitted changes' },
  { pattern: /\bgit\s+push\b[^;&|\n]*[ \t](--force|--force-with-lease|-f)\b/, warning: 'may overwrite remote history' },
  // rm -rf 严谨正则：防 rm -rf、rm -fr、rm -r -f 等所有组合
  { pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/, warning: 'may recursively force-remove files' },
  { pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, warning: 'may drop or truncate database objects' },
  { pattern: /\bDELETE\s+FROM\s+\w+[ \t]*(;|"|'|\n|$)/i, warning: 'may delete all rows' },
  { pattern: /\bkubectl\s+delete\b/, warning: 'may delete Kubernetes resources' },
  { pattern: /\bterraform\s+destroy\b/, warning: 'may destroy Terraform infrastructure' },
];

const COMMAND_SUBSTITUTION_PATTERNS = [
  { pattern: /<\(/, message: 'process substitution <()' },
  { pattern: />\(/, message: 'process substitution >()' },
  { pattern: /(?:^|[\s;&|])=[a-zA-Z_]/, message: 'Zsh equals expansion (=cmd)' }, // 防止 =curl 绕过 curl 拦截
  { pattern: /\$\(/, message: '$() command substitution' },
];
```

**关键启示**：
- Claude Code **同时使用** tree-sitter AST 和正则——AST 用于语义理解（如"这条命令读还是写"），正则用于精确黑名单
- 即便是 Anthropic 这种顶级团队，也没有完全抛弃正则，而是 **AST + 正则 + ML** 三层叠加
- 默认拦截 `curl`/`wget`（防 prompt injection 通过 URL 拉取恶意脚本）

### 2.2 shellcheck / bashate

#### shellcheck
- **定位**：Haskell 写的 Bash 静态分析 linter，主要检测**编码坏习惯**（未引号变量、`ls` 遍历、`cd` 不检查返回值等），**不是**专为危险命令检测设计
- **能力**：能识别 `rm -rf $VAR`（SC2115）、`eval` 滥用（SC2294）等部分危险模式，但**不识别** `chmod 777 /`、fork bomb、`dd of=/dev/sda` 等运维场景危险
- **集成方式**：CLI 工具，需通过 `child_process.spawn('shellcheck', [...])` 调用，**需要外部二进制**
- **Electron 可行性**：❌ 不友好
  - 需为每个目标平台捆绑 shellcheck 二进制（Win/Mac/Linux 各 5-10MB）
  - 增加打包体积和签名复杂度
  - 无 Node.js 原生 API
- **结论**：**不推荐**作为主方案，可作为补充（如果将来需要更深入的脚本审计）

#### bashate
- OpenStack 的 Bash linter，主要做代码风格（行长度、缩进），**完全不检测危险命令**
- **结论**：**不适用**

### 2.3 业界已有的"危险命令黑名单"开源方案

调研发现 5 个可直接参考的开源黑名单项目，规则可复用：

| 项目 | 平台 | 规则数 | 维护 | 价值 |
|---|---|---|---|---|
| **@sureshsankaran/destructive-check-plugin** | OpenCode 插件 | ~45 条 | 5 个月前 | ⭐⭐⭐⭐⭐ 规则最全，分类清晰（CRITICAL/HIGH/MEDIUM） |
| **pi-command-guard** | pi 扩展 | 14 类 | 10 天前 | ⭐⭐⭐⭐ 规则精炼，含 fork bomb、reverse shell |
| **Kiro Yolo** | VSCode 扩展 | ~10 类 | 活跃 | ⭐⭐⭐ 默认 denylist，含 `del /f /s /q` Win 支持 |
| **deputy** (R) | R 包 | ~20 类 | 活跃 | ⭐⭐⭐ 含混淆检测（base64/hex/quote splitting） |
| **bashrs** (Rust) | Rust linter | 396 条规则 | 极活跃 | ⭐⭐⭐⭐⭐ SEC001-SEC008 安全规则集，参考价值极高 |

#### 2.3.1 推荐吸收的黑名单规则（综合上述项目）

```
【CRITICAL — 直接阻止】
- rm -rf / | rm -rf ~ | rm -rf $HOME | rm -rf /*
- rm --no-preserve-root
- mkfs.* | mkswap
- dd if=* of=/dev/*
- chmod 777 / | chown -R * /
- :(){ :|:& };:  (fork bomb)
- shutdown | reboot | halt | poweroff | init 0
- wipefs -a
- curl * | sh | wget * | bash  (pipe to shell)
- nc -e | nc -c  (reverse shell)
- > /etc/passwd | > /etc/shadow | > /etc/sudoers
- chmod u+s /bin/*  (setuid 提权)

【HIGH — 强制确认】
- rm -rf <any>  |  rm -fr <any>
- chmod 777 <any>  |  chown <user> <system-path>
- git push --force | git push -f | git push --force-with-lease
- git reset --hard
- git clean -f | git clean -fd
- DROP TABLE | DROP DATABASE | DROP SCHEMA
- TRUNCATE TABLE
- DELETE FROM <table>  (无 WHERE)
- kubectl delete <resource>
- terraform destroy
- kill -9 -1 | killall *
- iptables -F | ufw reset
- npm cache clean --force
- docker system prune -a | docker rm -f
- aws s3 rm --recursive
- :(){ ... };:  (任何 fork bomb 变种)
- eval "$(curl ...)" | eval "$(wget ...)"
- sudo rm | sudo chmod | sudo dd

【MEDIUM — 需确认】
- sudo <any>
- systemctl stop | service stop
- systemctl restart
- sed -i  (原地编辑)
- cp -f | mv (覆盖)
- > ~/.bashrc | > ~/.ssh/authorized_keys  (覆写敏感配置)
- apt/yum/dnf install | remove | purge
- mount | umount
- sysctl -w
- crontab -r  (清空 cron)
- userdel | groupdel | passwd | usermod
```

### 2.4 AI IDE 危险命令识别做法对比

| IDE / 工具 | 识别方式 | 是否开源 | 是否用 AST |
|---|---|---|---|
| **Claude Code** | tree-sitter-bash AST + 正则黑名单 + ML 分类器 + OS 沙箱 | 部分开源（CLI 包可反编译） | ✅ tree-sitter |
| **Cursor** | 规则黑名单 + 用户审批（未公开细节） | ❌ 闭源 | 未知 |
| **GitHub Copilot Workspace** | 命令预览 + 用户审批（无自动拦截） | ❌ 闭源 | ❌ |
| **Aider** | 简单正则 + 用户确认 | ✅ 开源 | ❌ 纯正则 |
| **Continue.dev** | 用户配置 rules + 审批 | ✅ 开源 | ❌ |
| **OpenCode + destructive-check-plugin** | 纯正则黑名单 | ✅ 开源 | ❌ 纯正则 |
| **Kiro Yolo** | 纯正则 denylist | ✅ 开源 | ❌ 纯正则 |
| **Amazon Q CLI** | 简单确认（被供应链攻击过） | ❌ 闭源 | 未知 |

**结论**：Claude Code 是唯一公开使用 AST 解析的方案，其他工具基本停留在正则黑名单阶段。采用 AST 方案将使本项目在技术上对标 Claude Code，领先于其他开源方案。

---

## 三、推荐方案

### 3.1 主推方案：`web-tree-sitter` + `tree-sitter-bash`（WASM）

#### 理由

1. **业界事实标准**：Claude Code 实际采用方案，技术路线已被验证
2. **零原生编译**：WASM 无需 node-gyp，无需 Visual Studio/Xcode，Electron 打包简单
3. **跨平台一致**：win32/darwin/linux 同一份 .wasm 文件，无 ABI 兼容问题
4. **维护极度活跃**：周下载 2000 万+，1135 dependents，2 天前刚发布新版
5. **语法覆盖完整**：Bash 全语法（含 5.x 扩展），CST 节点类型丰富（`command`、`pipeline`、`redirected_statement`、`process_substitution`、`command_substitution`、`variable_assignment` 等）
6. **性能优秀**：单条命令解析 < 1ms，可同步调用
7. **TypeScript 类型定义完善**：`tree-sitter.d.ts` 提供完整类型

#### 实施要点

```ts
// src/main/core/bash-parser.ts
import { Parser, Language } from 'web-tree-sitter';
import * as path from 'path';

let initialized = false;
let parser: Parser | null = null;

async function ensureInitialized() {
  if (initialized) return;
  await Parser.init();
  const wasmPath = path.join(
    __dirname,
    '../node_modules/tree-sitter-bash/tree-sitter-bash.wasm'
  );
  const Bash = await Language.load(wasmPath);
  parser = new Parser();
  parser.setLanguage(Bash);
  initialized = true;
}

export async function parseBash(cmd: string) {
  await ensureInitialized();
  return parser!.parse(cmd).rootNode;
}
```

#### AST 节点查询示例（识别 `rm -rf` 危险模式）

```ts
// 遍历 AST 找到所有 command 节点
function findDangerousCommands(rootNode: any): Danger[] {
  const dangers: Danger[] = [];
  const walk = (node: any) => {
    if (node.type === 'command') {
      const cmdName = node.child(0)?.text;        // rm
      const flags = node.children
        .filter(c => c.type === 'word' && c.text.startsWith('-'))
        .map(c => c.text);                         // ['-rf']
      const args = node.children
        .filter(c => c.type === 'word' && !c.text.startsWith('-') && c.text !== cmdName)
        .map(c => c.text);                         // ['/']

      if (cmdName === 'rm' && /r.*f|f.*r/.test(flags.join(''))) {
        if (args.some(a => a === '/' || a === '/*' || a === '~' || a === '$HOME')) {
          dangers.push({ level: 'CRITICAL', reason: '递归删除根目录/家目录' });
        } else {
          dangers.push({ level: 'HIGH', reason: '递归强制删除' });
        }
      }
    }
    // 检测命令替换 $(...)，防止绕过
    if (node.type === 'command_substitution') {
      dangers.push({ level: 'MEDIUM', reason: '命令替换，可能用于绕过检测' });
    }
    // 检测进程替换 <(...)
    if (node.type === 'process_substitution') {
      dangers.push({ level: 'HIGH', reason: '进程替换，高级绕过手法' });
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  };
  walk(rootNode);
  return dangers;
}
```

### 3.2 备选方案：`unbash`

#### 适用场景
- 希望完全零依赖、纯 TypeScript
- 不需要 CST 那么细粒度的 token 信息，只要语义 AST
- 包体敏感（unbash 13KB gzipped vs web-tree-sitter ~200KB）

#### 理由
1. 纯 TypeScript，类型友好
2. 同步 API，集成更简单
3. 性能在短命令上比 tree-sitter WASM 快 8-16 倍
4. 维护极度活跃（430 万周下载）
5. 输出 AST 比 CST 更"语义化"，写危险模式匹配代码更直观

#### 风险
- 项目较新（v3.0.0），生态规模不及 tree-sitter
- 不支持增量解析（本项目不需要）
- 文档不如 tree-sitter 完整

### 3.3 不推荐方案

| 方案 | 不推荐原因 |
|---|---|
| bashlex + Python 子进程 | 引入 Python 运行时，违背约束 |
| tree-sitter 原生 binding | 需 node-gyp 编译，Electron 分发复杂 |
| bash-parser 系列 | 维护状态差，已废弃或 EOL |
| mvdan-sh (GopherJS) | 已废弃 3 年 |
| sh-syntax (WASM) | 可用但初始化重、API 异步、包体大，不如 web-tree-sitter |
| shellcheck 二进制 | 需外部二进制，非 Node 原生 |

### 3.4 实施建议（针对当前 `risk-engine.ts`）

当前 `risk-engine.ts` 完全基于正则，存在以下已知缺陷（正则无法处理）：

1. **命令拼接绕过**：`rm -rf /tmp/x && rm -rf /` — 当前正则只检测整体字符串，可能漏判
2. **变量展开**：`TARGET=/; rm -rf $TARGET` — 正则看不到 `$TARGET` 的值
3. **命令替换**：`eval "$(echo rm -rf /)"` — 正则被字符串包裹后失效
4. **Base64 混淆**：`$(echo "cm0gLXIgZiAv" | base64 -d)` — 正则完全失效
5. **进程替换**：`rm -rf <(ls /)` — 高级绕过手法
6. **引号拼接**：`r""m -rf /` — 正则匹配 `rm` 失败

#### 建议的三层架构（对标 Claude Code）

```
L0 — AST 解析层（新增）
   └─ web-tree-sitter 解析为 CST
   └─ 遍历提取所有 command_name、arguments、redirects、pipes、substitutions

L1 — 语义规则层（重构现有正则为 AST 规则）
   └─ 基于 AST 节点类型匹配（而非字符串正则）
   └─ 例：if node.type === 'command' && node.name === 'rm' && hasFlag('rf') → HIGH
   └─ 自动覆盖命令拼接（每个 command 节点独立判断）

L2 — 兜底正则层（保留现有正则）
   └─ 对 AST 解析失败的命令（如语法错误）做正则兜底
   └─ 对 Base64/hex 混淆等 AST 无法处理的模式做正则检测

L3 — 人工确认层（沿用现有）
   └─ HIGH 及以上风险等级 → 弹窗确认
```

#### 渐进式迁移策略

1. **Phase 1**（1-2 天）：引入 `web-tree-sitter` + `tree-sitter-bash`，在 `risk-engine.ts` 中新增 `parseBashAST()` 函数，**不替换**现有正则，仅作为日志输出
2. **Phase 2**（3-5 天）：将 CRITICAL_PATTERNS 中的 `rm -rf /`、`chmod 777 /`、`dd if=` 等核心规则改为 AST 匹配，正则作为 fallback
3. **Phase 3**（2-3 天）：新增 AST 专属规则（命令替换检测、进程替换检测、变量赋值追踪），覆盖正则无法处理的绕过场景
4. **Phase 4**（1-2 天）：性能基准测试，确保单命令评估 < 5ms

### 3.5 最终推荐

**主方案**：`web-tree-sitter` + `tree-sitter-bash`（WASM 版本）
- 装包：`npm install web-tree-sitter tree-sitter-bash`
- 理由：对标 Claude Code、零原生编译、生态最成熟、维护最活跃

**应急备选**：`unbash`
- 装包：`npm install unbash`
- 触发条件：若 web-tree-sitter 在 Electron 主进程出现 WASM 加载问题（极低概率）

**黑名单规则来源**：吸收 `@sureshsankaran/destructive-check-plugin` + `pi-command-guard` + `bashrs SEC001-SEC008` 规则集，覆盖 14 大类危险模式

---

## 四、参考链接

### 库
- tree-sitter-bash: https://www.npmjs.com/package/tree-sitter-bash
- web-tree-sitter: https://www.npmjs.com/package/web-tree-sitter
- unbash: https://www.npmjs.com/package/unbash
- sh-syntax: https://www.npmjs.com/package/sh-syntax
- bash-parser: https://www.npmjs.com/package/bash-parser
- mvdan-sh: https://www.npmjs.com/package/mvdan-sh
- bashlex: https://github.com/idank/bashlex

### 业界方案
- Claude Code Safety & Sandboxing: https://y-agent.github.io/inside-claude-code/06-safety-sandbox.html
- Claude Code CLI 安全架构分析: https://pjt3591oo.github.io/cladue-code-analysis/security
- Claude Code BashTool 源码: https://deepwiki.com/openclaudecode/openclaudecode/3.2-shell-tools:-bash-and-powershell
- @sureshsankaran/destructive-check-plugin: https://www.npmjs.com/package/@sureshsankaran/destructive-check-plugin
- pi-command-guard: https://www.npmjs.com/package/pi-command-guard
- Kiro Yolo: https://marketplace.visualstudio.com/items?itemName=CarlosEduardoLino.kiro-yolo
- deputy (R) hook_block_dangerous_bash: https://jameshwade.github.io/deputy/reference/hook_block_dangerous_bash.html
- bashrs Linter Rules: https://paiml.github.io/bashrs/reference/rules.html
- ShellCheck: https://www.shellcheck.net/

### 当前项目相关文件
- `tdsf-linux-desktop/src/main/core/risk-engine.ts`（待重构，当前正则方案）
- `tdsf-linux-desktop/src/main/core/rule-engine.ts`
- `tdsf-linux-desktop/tests/core/risk-engine.test.ts`
- `tdsf-linux-desktop/_legacy-python/test_safety.py`（Python 版历史方案，可参考规则）
