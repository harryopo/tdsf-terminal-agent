# 语言服务器（LSP）说明

> 入口：设置 → 编辑器 → 语言服务器（LSP）。本页解释 LSP 是什么、有什么用、各服务器怎么安装。

## LSP 是什么

LSP = Language Server Protocol（语言服务器协议），由微软在开发 VS Code 时提出、现已成行业标准的协议。

- **语言服务器**：一个独立后台进程，懂某种编程语言的语法与项目结构（如 rust-analyzer 懂 Rust、pyright 懂 Python）
- **编辑器**（本项目内置的 CodeMirror）通过 LSP 协议向它提问，获得专业级的代码智能

一句话：**LSP 就是把"IDE 级别的代码理解能力"作为服务挂给编辑器用**。

## 有什么用

开启某个语言的 LSP 后，编辑器内可获得（取决于语言服务器支持程度）：

| 能力 | 说明 |
|------|------|
| 悬停文档 | 光标停在函数/类型上显示签名与文档 |
| 跳转定义 | 光标跳到符号定义处 |
| 实时诊断 | 语法/类型错误波浪线提示（不用编译就能发现） |
| 符号补全 | 基于项目真实符号的补全（区别于通用关键字补全） |

**典型场景**（本产品教学向）：编辑器里写 shell 脚本/Python 自动化脚本/配置文件时获得错误提示与补全，降低初学者试错成本。

## 当前支持的服务器与安装方法

设置页会自动扫描 PATH，显示每个服务器的状态：

| 语言 | 服务器 | 安装命令（任选其一） |
|------|--------|---------------------|
| TypeScript/JS | typescript-language-server | `npm i -g typescript typescript-language-server typescript` |
| Rust | rust-analyzer | 随 rustup 安装：`rustup component add rust-analyzer` |
| Python | pyright-langserver | `pip install pyright` 或 `npm i -g pyright` |
| Ruff（Python lint） | ruff | `pip install ruff` 或 `npm i -g @astral-sh/ruff` |
| Go | gopls | `go install golang.org/x/tools/gopls@latest` |
| C/C++ | clangd | 随 LLVM 安装包，或 `winget install LLVM.LLVM` |
| Zig | zls | 见 zls 官方仓库 Releases |

**状态说明**：

- 条目显示「未在 PATH 中找到」= 该语言服务器未安装或不在系统 PATH——按上表安装并重启应用即可被识别
- 绿点 + 完整路径 = 已找到，打开开关即可在该语言的编辑器中启用

## 注意事项

1. **按需开启**：只用到的语言开对应服务器即可，每个服务器都是一个常驻进程，全开会占内存
2. **工作区关联**：LSP 的"跳转定义/项目诊断"依赖工作区根目录——请先打开工作区（本地/WSL），单文件模式下能力有限
3. **自定义服务器**：点「添加自定义服务器」可配置不在列表中的语言服务器（填可执行文件路径与语言关联）
4. **远程（SSH）不受影响**：LSP 只作用于本地编辑器；编辑远程文件（SFTP）时补全基于已下载内容，不依赖远端服务器
