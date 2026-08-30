# 黑屏与显示问题排查

> 适用：应用窗口全黑/白屏但进程在跑、重启后偶发恢复又复发。本页记录根因与已实施的固化修复。

## 已知问题：WebView2 GPU 加速导致窗口黑屏

### 现象

- 应用启动后窗口**全黑**（或白屏），任务栏图标正常，进程存在
- 后端日志一切正常（sidecar ready、方法注册成功）——**不是应用代码问题**
- 重启有时恢复、有时不恢复，间歇性复发

### 根因

Windows 的 Tauri 应用使用 **WebView2** 渲染界面。WebView2 默认开启 GPU 硬件加速，在以下环境会**间歇性崩溃**（渲染进程挂掉 → 窗口黑屏）：

- 远程桌面（RDP）会话内运行
- 旧显卡驱动 / 集显驱动过旧
- 多 GPU（核显+独显）自动切换
- WebView2 的 GPU 缓存（GPUCache/ShaderCache）损坏

### 已实施的固化修复（2026-08-30）

[src-tauri/src/lib.rs](../../src-tauri/src/lib.rs) 在窗口创建前设置：

```rust
std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--disable-gpu");
```

即**默认禁用 GPU 硬件加速，强制软件渲染**。本应用的界面是 DOM 终端场景，软渲染性能足够，稳定性优先。此修复对 dev 与打包版同时生效，无需手动配置。

### 如果你想恢复硬件加速

1. 打开 `src-tauri/src/lib.rs`，注释掉上述 `set_var` 两行
2. 重新编译启动；若黑屏复发，按下面"手动应急"处理

### 手动应急（不重新编译）

PowerShell 带参数启动：

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--disable-gpu"
& "C:\...\tdsf-terminal-agent.exe"
```

### 清理 WebView2 缓存（黑屏反复时的第二手段）

```powershell
# 先退出应用
Remove-Item "$env:LOCALAPPDATA\com.tdsf.terminal-agent\EBWebView\GPUCache" -Recurse -Force
Remove-Item "$env:LOCALAPPDATA\com.tdsf.terminal-agent\EBWebView\ShaderCache" -Recurse -Force
```

### 其他排查手段

| 手段 | 命令/操作 | 说明 |
|------|----------|------|
| 验证前端本身是否正常 | 浏览器打开 `http://127.0.0.1:9300`（dev 模式） | 浏览器渲染正常 = 前端代码没问题，问题在 WebView2 层 |
| 升级 WebView2 Runtime | https://developer.microsoft.com/microsoft-edge/webview2/ | 老版本 Runtime 的 GPU 崩溃修复较多 |
| 更新显卡驱动 | 厂商官网 | 治本手段；更新后可尝试重新开启硬件加速 |
| 看 WebView2 版本 | `控制面板 → 程序 → Microsoft Edge WebView2 Runtime` | 建议保持最新 |

## 开发者诊断流程（黑屏复发时）

1. **后端日志**：sidecar ready / 方法注册正常 → 排除后端
2. **浏览器对照**：dev 模式下用浏览器访问 devUrl（默认 9300 端口），渲染正常 → 锁定 WebView2 层
3. **带 `--disable-gpu` 重启** → 恢复即确认 GPU 加速问题
4. **清 GPU 缓存**（见上）→ 排除缓存损坏
5. **升级 WebView2 Runtime / 显卡驱动** → 治本
