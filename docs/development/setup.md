# 开发环境

依赖声明以 [package.json](../../package.json)、[Cargo.toml](../../src-tauri/Cargo.toml) 和 [sidecar requirements](../../src-tauri/sidecar/requirements.txt)为准。使用 `packageManager` 指定的 pnpm，不复制其它 AI 的虚拟环境或构建缓存作为可复现性证明。

## Windows 开发

准备与项目兼容的 Node/pnpm、Rust、Python 和 Tauri Windows 构建环境。在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
python -m venv src-tauri/sidecar/.venv
src-tauri/sidecar/.venv/Scripts/python.exe -m pip install -r src-tauri/sidecar/requirements.txt
pnpm tauri:dev
```

这些是环境准备步骤，不是本文已经替你执行的操作。存在 `.venv` 时先核解释器与已安装版本，不直接覆盖共享环境。Python 版本范围见 sidecar 项目配置；本机 `pip freeze` 不取代依赖声明。

标准开发入口由 [Vite 配置](../../vite.config.ts)、[Tauri 配置](../../src-tauri/tauri.conf.json)和[开发配置](../../src-tauri/tauri.dev.conf.json)共同决定。生产实例不得开放开发调试端口。

## 构建与数据

- 构建目录、解释器、临时文件夹和工作树不要跨任务争写。
- 本机目录问题先定位具体拒绝的路径与操作；不关闭防护或整片删除缓存来尝试解决。
- 凭据通过应用配置；不写进仓库。知识库、运行数据与真实服务器配置不能拷入公开测试夹具。
- 本机专用 Cargo 输出配置可以保留为本地设置，不能作为所有开发者必备的绝对路径。

安装包构建是独立流程，运行项目的 `build:win` 前先确认授权、版本、依赖环境和候选源码。构建成功不等于覆盖升级、卸载或真实安装验收完成。
