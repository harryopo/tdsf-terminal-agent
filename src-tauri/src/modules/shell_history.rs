// modules/shell_history.rs — TDSF shell 历史读取 (T-P2-10.5)
// ============================================================================
// 职责:
//   - 自动检测当前 shell 类型 (Windows: powershell / Linux/Mac: $SHELL)
//   - 读取 shell history 文件并解析为命令列表
//   - 返回 ShellHistoryInfo (shell 类型 + 文件路径 + 命令列表)
//
// 各 shell history 文件路径:
//   - bash:       ~/.bash_history
//   - zsh:        ~/.zsh_history
//   - fish:       ~/.local/share/fish/fish_history
//   - powershell: ~/.config/powershell/PSReadLine/ConsoleHost_history.txt
//                 (Windows: ~/Documents/PowerShell/PSReadLine/ConsoleHost_history.txt)
//
// 解析策略:
//   - Rust 端只做"读取 + 行分割", 不做格式解析
//   - 复杂格式解析 (zsh `: ts:dur;cmd` / fish YAML) 留给前端 TS 处理
//   - Rust 端按原始行返回, 前端调用 parseShellHistory 按类型分发解析
//   - 设计取舍: Rust 端逻辑简单 + 可测试, 复杂解析逻辑放 TS 端易迭代
//
// Tauri 命令:
//   - read_shell_history: 自动检测 + 读取 + 返回 ShellHistoryInfo
// ============================================================================

use std::fs;
use std::path::PathBuf;

use serde::Serialize;

// ============================================================================
// ShellType — shell 类型枚举
// ============================================================================

/// Shell 类型 (与前端 ShellType 联合类型对齐)
///
/// 序列化为 lowercase 字符串, 与 TS 端 `'bash' | 'zsh' | 'fish' | 'powershell' | 'unknown'` 对齐
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellType {
    Bash,
    Zsh,
    Fish,
    Powershell,
    Unknown,
}

// ============================================================================
// ShellHistoryInfo — 返回给前端的 shell history 信息
// ============================================================================

/// Shell history 读取结果
///
/// 前端通过 `invoke('read_shell_history')` 获取,
/// 用于初始化 CompletionEngine.loadHistory(commands)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellHistoryInfo {
    /// 当前检测到的 shell 类型
    pub shell_type: ShellType,
    /// history 文件绝对路径 (不存在则为空字符串)
    pub history_path: String,
    /// 原始命令列表 (按文件顺序, 旧 → 新)
    /// 注: 仅做行分割, 未做 zsh/fish 格式解析 (前端解析)
    pub commands: Vec<String>,
}

// ============================================================================
// shell 类型检测
// ============================================================================

/// 从环境变量 $SHELL 检测当前 shell 类型 (Unix)
///
/// - $SHELL=/bin/bash → Bash
/// - $SHELL=/bin/zsh  → Zsh
/// - $SHELL=.../fish → Fish
/// - 未设置 / 未知  → Unknown
pub fn detect_shell_type() -> ShellType {
    let shell = std::env::var("SHELL").unwrap_or_default();
    if shell.is_empty() {
        // Windows 无 $SHELL 环境变量, 默认 powershell
        if cfg!(target_os = "windows") {
            return ShellType::Powershell;
        }
        return ShellType::Unknown;
    }

    // 取 basename (例如 /bin/bash → bash)
    let basename = PathBuf::from(&shell)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    match basename.as_str() {
        "bash" => ShellType::Bash,
        "zsh" => ShellType::Zsh,
        "fish" => ShellType::Fish,
        // Windows powershell 在 $SHELL 不会出现, 但 pwsh 可能
        "pwsh" | "powershell" => ShellType::Powershell,
        _ => ShellType::Unknown,
    }
}

// ============================================================================
// history 文件路径定位
// ============================================================================

/// 返回当前 shell 的 history 文件路径
///
/// 查找顺序:
///   1. 按检测到的 shell 类型, 拼接标准路径
///   2. 文件不存在时返回空 PathBuf (调用方判断)
pub fn locate_history_file(shell_type: ShellType) -> PathBuf {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return PathBuf::new(),
    };

    let path = match shell_type {
        ShellType::Bash => home.join(".bash_history"),
        ShellType::Zsh => home.join(".zsh_history"),
        ShellType::Fish => home.join(".local").join("share").join("fish").join("fish_history"),
        ShellType::Powershell => {
            // Windows 优先用 ~/.config/powershell (PS7+), 兜底用 ~/Documents/PowerShell (PS5)
            let ps7_path = home
                .join(".config")
                .join("powershell")
                .join("PSReadLine")
                .join("ConsoleHost_history.txt");
            if ps7_path.exists() {
                return ps7_path;
            }
            // PS5 路径 (Windows Documents 文件夹, 非英文 Windows 可能为其他名称)
            home.join("Documents")
                .join("PowerShell")
                .join("PSReadLine")
                .join("ConsoleHost_history.txt")
        }
        ShellType::Unknown => return PathBuf::new(),
    };

    path
}

// ============================================================================
// history 文件读取
// ============================================================================

/// 读取 shell history 文件并返回原始命令列表
///
/// 流程:
///   1. 检测 shell 类型 (detect_shell_type)
///   2. 定位 history 文件路径 (locate_history_file)
///   3. 读取文件内容并按行分割
///   4. 返回 ShellHistoryInfo
///
/// 错误处理:
///   - 文件不存在: 返回 ShellHistoryInfo (commands 为空, 不报错)
///   - 读取失败: 返回 Err (含错误信息)
///   - shell 未知: commands 为空
pub fn read_shell_history_internal() -> Result<ShellHistoryInfo, String> {
    let shell_type = detect_shell_type();
    let history_path = locate_history_file(shell_type);

    // 文件不存在: 返回空命令列表 (非错误)
    let path_str = history_path.to_string_lossy().to_string();
    if history_path.as_os_str().is_empty() || !history_path.exists() {
        return Ok(ShellHistoryInfo {
            shell_type,
            history_path: path_str,
            commands: Vec::new(),
        });
    }

    // 读取文件内容
    let content = fs::read_to_string(&history_path)
        .map_err(|e| format!("read history file failed: {}", e))?;

    // 按行分割 (保留末尾换行, 与前端 parseShellHistory 配合)
    // 注: 不做 trim, 前端解析器各自处理行尾
    let commands: Vec<String> = content.lines().map(|s| s.to_string()).collect();

    Ok(ShellHistoryInfo {
        shell_type,
        history_path: path_str,
        commands,
    })
}

// ============================================================================
// Tauri 命令
// ============================================================================

/// read_shell_history: 读取当前 shell 的 history 文件
///
/// 前端调用:
///   ```typescript
///   const info = await invoke<ShellHistoryInfo>('read_shell_history');
///   // info.shellType, info.historyPath, info.commands
///   ```
///
/// 返回:
///   - Ok(ShellHistoryInfo): 即使文件不存在也返回 Ok (commands 为空)
///   - Err(String): 文件存在但读取失败 (权限/IO 错误)
#[tauri::command]
pub async fn read_shell_history() -> Result<ShellHistoryInfo, String> {
    read_shell_history_internal()
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_shell_type_returns_known_or_unknown() {
        // 仅验证返回值是 5 种之一 (依赖运行环境的 $SHELL 变量)
        let st = detect_shell_type();
        assert!(matches!(
            st,
            ShellType::Bash | ShellType::Zsh | ShellType::Fish | ShellType::Powershell | ShellType::Unknown
        ));
    }

    #[test]
    fn test_locate_history_file_returns_path_for_known_shell() {
        // 已知 shell 类型应返回非空路径
        let bash_path = locate_history_file(ShellType::Bash);
        assert!(!bash_path.as_os_str().is_empty());
        assert!(bash_path.to_string_lossy().ends_with(".bash_history"));

        let zsh_path = locate_history_file(ShellType::Zsh);
        assert!(zsh_path.to_string_lossy().ends_with(".zsh_history"));

        let fish_path = locate_history_file(ShellType::Fish);
        assert!(fish_path.to_string_lossy().ends_with("fish_history"));

        // Unknown 应返回空路径
        let unknown_path = locate_history_file(ShellType::Unknown);
        assert!(unknown_path.as_os_str().is_empty());
    }

    #[test]
    fn test_read_shell_history_internal_returns_ok() {
        // 应该返回 Ok, 即使 history 文件不存在 (commands 为空)
        let result = read_shell_history_internal();
        assert!(result.is_ok());
        let info = result.unwrap();
        assert!(info.commands.len() >= 0); // 仅验证不 panic
    }

    #[test]
    fn test_shell_type_serializes_lowercase() {
        // 序列化为 lowercase 字符串, 与 TS 端 ShellType 联合类型对齐
        let json = serde_json::to_string(&ShellType::Bash).unwrap();
        assert_eq!(json, "\"bash\"");
        let json = serde_json::to_string(&ShellType::Powershell).unwrap();
        assert_eq!(json, "\"powershell\"");
        let json = serde_json::to_string(&ShellType::Unknown).unwrap();
        assert_eq!(json, "\"unknown\"");
    }
}
