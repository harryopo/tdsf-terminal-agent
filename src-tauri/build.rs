//! build.rs — Tauri 项目构建脚本
//! ============================================================================
//! 主要任务:
//! 1. 调用 tauri_build::try_build() (处理 tauri.conf.json + 生成上下文代码)
//!    - 使用 WindowsAttributes::new_without_app_manifest() 禁用 tauri-build 默认 manifest
//!    - 由 build.rs 统一管理 manifest,避免主 bin 与测试二进制 manifest 不一致
//! 2. Windows 平台: 嵌入 ComCtl32 v6 manifest (启用 Visual Styles)
//!    - 通过 cargo:rustc-link-arg (所有目标) 添加 /MANIFESTINPUT
//!    - 主 bin + 测试二进制 + cdylib 都获得相同 manifest
//!
//! ## ComCtl32 v6 manifest 背景
//! Windows 默认加载 comctl32.dll v5 (经典灰界面),v6 (现代主题 + TaskDialog) 需要 manifest 启用。
//! Tauri (tao/wry/webview2-com) 使用 TaskDialogIndirect (v6 函数),无 manifest 时进程启动即崩溃:
//!   STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139)
//!
//! ## 为什么禁用 tauri-build 默认 manifest
//! tauri-build 通过 winres crate 生成 resource.lib (含 manifest + icon + version),
//! 通过 cargo:rustc-link 链接到主 bin。但 cargo test --lib 编译的测试二进制不链接 resource.lib,
//! 导致测试二进制无 manifest,启动即崩溃。
//! 解决方案: 禁用 tauri-build 的 manifest,统一由 build.rs 通过 /MANIFESTINPUT 添加,
//! 这样 cargo:rustc-link-arg 会应用到所有目标 (bin + lib test + cdylib)。

use tauri_build::{try_build, Attributes, WindowsAttributes};

fn main() {
    // 1. Tauri 标准构建 (禁用默认 manifest,由 build.rs 统一管理)
    //    注: window_icon 和 version_info 仍由 tauri-build 处理
    let attributes = Attributes::new()
        .windows_attributes(WindowsAttributes::new_without_app_manifest());
    if let Err(error) = try_build(attributes) {
        let error = format!("{error:#}");
        println!("{error}");
        std::process::exit(1);
    }

    // 2. Windows 专用: 嵌入 ComCtl32 v6 manifest (启用 Visual Styles)
    //    通过 cargo:rustc-link-arg 应用到所有目标 (bin + lib test + cdylib)
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        embed_comctl32_v6_manifest();
    }
}

/// 嵌入 ComCtl32 v6 manifest (启用 Visual Styles)
///
/// 通过 link.exe 的 /MANIFESTINPUT 参数将 manifest 嵌入到最终二进制 (RT_MANIFEST 资源)。
///
/// manifest 内容参考:
/// https://learn.microsoft.com/en-us/windows/win32/controls/cookbook-overview
fn embed_comctl32_v6_manifest() {
    // manifest XML 内容 (启用 ComCtl32 v6 + 常见控件 v6)
    // 内容与 tauri-build 默认 manifest 完全一致 (tauri-build-2.6.3/src/windows-app-manifest.xml)
    let manifest = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#;

    // 写入 manifest 文件到 OUT_DIR
    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR not set");
    let manifest_path = std::path::Path::new(&out_dir).join("app.manifest");
    std::fs::write(&manifest_path, manifest).expect("failed to write app.manifest");

    // 将 manifest 路径传递给链接器 (/MANIFESTINPUT)
    // 该参数让 link.exe 把 manifest 嵌入到最终二进制 (RT_MANIFEST 资源)
    //
    // 使用 cargo:rustc-link-arg (非 -bin/-lib) 应用到所有目标:
    // - 主 bin (tdsf-terminal-agent.exe)
    // - lib test 二进制 (cargo test --lib)
    // - cdylib (tdsf_terminal_agent_lib.dll)
    // - staticlib (tdsf_terminal_agent_lib.lib)
    let manifest_str = manifest_path.to_str().expect("manifest path not utf8");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest_str);
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTUAC:NO");
}
