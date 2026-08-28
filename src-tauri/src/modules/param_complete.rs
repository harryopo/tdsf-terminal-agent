// modules/param_complete.rs — carapace 参数补全 (spec: add-carapace-param-completion T2)
// ============================================================================
// 职责:
//   - 解析打包内 carapace 二进制路径 (dev = CARGO_MANIFEST_DIR/bin, 生产 = resource dir/bin)
//   - spawn `carapace <cmd> export <tokens...> <current>` 子进程取动态参数候选
//     (协议实测: tokens 数组首项就是命令名本身, 由前端传入, Rust 不重复添加)
//   - stdout 单行 JSON {values:[{value,display,description,tag}]} → Vec<ParamCandidate>
//
// 设计取舍 (为什么这样做):
//   - 500ms 超时 + kill_on_drop(true): timeout 丢弃 future 时 Child 被 drop,
//     kill_on_drop 保证子进程被强杀, 避免孤儿 carapace 进程堆积
//   - 任何失败 (二进制缺失/spawn 失败/超时/非零退出/JSON 解析失败) 一律
//     log::warn! 单条 + 返回 Ok(空数组), 不给前端 Err —— 前端零成本降级到
//     Fig specs 静态参数层, 补全属增强功能不该让 UI 弹错误
//   - CARAPACE_SHELL=export: 强制 carapace 走机器可读的 JSON export 协议
//   - stderr 照常 piped 但只用于失败诊断日志, 不参与解析 (carapace 会往
//     stderr 写调试日志, 混入会污染)
//   - Linux 二进制只做路径计算不在 Windows 执行, 供 T6 SFTP 上传远端用
// ============================================================================

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[cfg(not(debug_assertions))]
use tauri::Manager;

/// carapace export 查询超时 (超过即强杀子进程, 静默降级空候选)
const TIMEOUT_MS: u64 = 500;

// ============================================================================
// CarapaceKind — 二进制种类
// ============================================================================

/// carapace 二进制种类
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CarapaceKind {
    /// Windows 本地二进制 (本地终端参数补全的执行体)
    LocalExe,
    /// linux amd64 二进制 (不在 Windows 执行, 仅供 T6 SFTP 上传远端 ~/.local/bin)
    LinuxAmd64,
}

impl CarapaceKind {
    /// 打包内相对 bin/ 的文件名 (与 src-tauri/bin/ 实际文件 + CHECKSUMS.txt 记录对齐)
    fn file_name(self) -> &'static str {
        match self {
            CarapaceKind::LocalExe => "carapace.exe",
            CarapaceKind::LinuxAmd64 => "carapace-linux-amd64",
        }
    }
}

// ============================================================================
// 路径解析 (dev / 生产双模式)
// ============================================================================

/// 由"根目录"拼出二进制路径: <root>/bin/<file>
///
/// dev 与生产拼装规则一致, 仅根不同: dev root = CARGO_MANIFEST_DIR,
/// 生产 root = Tauri resource dir (bundle.resources 含 "bin/", 打包时
/// 保持相对目录结构)。拆纯函数便于单测 (carapace_path 需要 AppHandle,
/// 测试里不好构造), dev/生产两模式共用同一份测试覆盖。
fn carapace_path_from_root(root: &std::path::Path, kind: CarapaceKind) -> PathBuf {
    root.join("bin").join(kind.file_name())
}

/// 解析 carapace 二进制绝对路径
///
/// - dev (`cargo tauri dev` = debug_assertions): 直接用编译期 CARGO_MANIFEST_DIR
/// - 生产 (tauri 打包): 经 Tauri path API 解析 resource dir 再拼 bin/<file>
///
/// Err 仅表示"路径系统层面拿不到"(如 resource dir 解析失败), 调用方应降级空候选
pub fn carapace_path(app: &tauri::AppHandle, kind: CarapaceKind) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app; // dev 模式用编译期路径, 不需要 resource dir
        Ok(carapace_path_from_root(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")),
            kind,
        ))
    }
    #[cfg(not(debug_assertions))]
    {
        let root = app.path().resource_dir().map_err(|e| e.to_string())?;
        Ok(carapace_path_from_root(&root, kind))
    }
}

// ============================================================================
// 数据结构
// ============================================================================

/// 返回给前端的单个参数候选
///
/// value 永不为空 (解析层已过滤); description/tag 可缺省
/// (tag 如 "local branches"/"flag", 前端可用于分组或样式)
#[derive(Debug, Clone, Serialize)]
pub struct ParamCandidate {
    pub value: String,
    pub description: Option<String>,
    pub tag: Option<String>,
}

/// carapace export 输出顶层结构 (宽松解析: 只取 values, 其余字段忽略)
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct CarapaceOutput {
    values: Vec<CarapaceValue>,
}

/// carapace 候选条目 (全 Option + default: 版本间字段增减不炸解析)
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct CarapaceValue {
    value: Option<String>,
    // display 目前前端不需要 (映射层只用 value/description/tag),
    // 保留解析是为了对齐上游 export 协议全字段, 版本升级时输出样例可对照
    #[allow(dead_code)]
    display: Option<String>,
    description: Option<String>,
    tag: Option<String>,
}

// ============================================================================
// 纯函数: 解析与过滤
// ============================================================================

/// 单个 token 安全检查: 禁 \0 / \n / \r
///
/// 为什么: \0 破坏 argv 边界 (Windows CreateProcess 按空分隔拼接命令行),
/// \n\r 可注入多行命令/伪造协议输出 —— 补全入参来自用户输入行, 必须设防
fn is_safe_token(s: &str) -> bool {
    !s.contains('\0') && !s.contains('\n') && !s.contains('\r')
}

/// 入参整体校验: cmd / tokens / current 任一含控制字符则拒绝 (返回空候选)
fn validate_inputs(cmd: &str, tokens: &[String], current: &str) -> bool {
    is_safe_token(cmd) && is_safe_token(current) && tokens.iter().all(|t| is_safe_token(t))
}

/// 解析 carapace export 的 stdout (单行 JSON) → 前端候选列表
///
/// - JSON 解析失败 → warn 单条 + 空列表 (调用方不再降级, 此函数兜底)
/// - value 为空/缺失的条目丢弃 (前端无法展示占位条目)
/// - carapace 已按当前词做前缀过滤, 这里不做二次过滤
fn parse_carapace_output(raw: &str) -> Vec<ParamCandidate> {
    let parsed: CarapaceOutput = match serde_json::from_str(raw.trim()) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[param_complete] carapace 输出 JSON 解析失败, 静默降级空候选: {e}");
            return Vec::new();
        }
    };
    let mut out = Vec::with_capacity(parsed.values.len());
    for v in parsed.values {
        let Some(value) = v.value.filter(|s| !s.is_empty()) else {
            continue;
        };
        out.push(ParamCandidate {
            value,
            description: v.description,
            tag: v.tag,
        });
    }
    out
}

// ============================================================================
// Tauri 命令
// ============================================================================

/// 参数动态补全: spawn 本地 carapace export 子进程取候选
///
/// argv 协议: [carapace_path, cmd, "export"] ++ tokens ++ [current]
/// (tokens 首项就是命令名本身, 前端传完整 token 列表, Rust 不重复添加;
///  current 为当前正在输入的词, 尾随空格场景传空串)
///
/// 失败语义: 任何错误 → log::warn! 单条 + Ok(vec![]), 永不返回 Err 给前端
#[tauri::command]
pub async fn param_complete(
    app: tauri::AppHandle,
    cmd: String,
    tokens: Vec<String>,
    current: String,
    cwd: Option<String>,
) -> Result<Vec<ParamCandidate>, String> {
    // 防注入面: 控制字符入参直接拒绝 (不记日志, 正常输入不会出现)
    if !validate_inputs(&cmd, &tokens, &current) {
        return Ok(Vec::new());
    }

    let exe = match carapace_path(&app, CarapaceKind::LocalExe) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[param_complete] carapace 路径解析失败, 静默降级空候选: {e}");
            return Ok(Vec::new());
        }
    };

    let mut command = tokio::process::Command::new(&exe);
    command.arg(&cmd).arg("export");
    for t in &tokens {
        command.arg(t);
    }
    command.arg(&current);
    // cwd 不传则继承当前进程目录; 传了但无效时 spawn 会失败, 走统一降级
    if let Some(dir) = &cwd {
        command.current_dir(dir);
    }
    command.env("CARAPACE_SHELL", "export");
    // stdin 关闭: carapace export 不读 stdin, 关掉防子进程意外挂起等输入
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    // 超时强杀的关键: timeout 到期丢弃 future → Child drop → 自动 kill
    command.kill_on_drop(true);

    let run = async {
        // 注意: 不加 mut — wait_with_output(self) 按值消费 Child
        let child = command.spawn()?;
        child.wait_with_output().await
    };
    match tokio::time::timeout(Duration::from_millis(TIMEOUT_MS), run).await {
        // 超时: future 已被 drop, kill_on_drop 已强杀子进程
        Err(_) => {
            log::warn!("[param_complete] carapace 500ms 超时已强杀, 静默降级空候选: cmd={cmd}");
            Ok(Vec::new())
        }
        Ok(Err(e)) => {
            log::warn!("[param_complete] carapace spawn/wait 失败, 静默降级空候选: {e}");
            Ok(Vec::new())
        }
        Ok(Ok(output)) => {
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                log::warn!(
                    "[param_complete] carapace 非零退出 ({}), 静默降级空候选: cmd={cmd} stderr={}",
                    output.status,
                    truncate_for_log(&stderr),
                );
                return Ok(Vec::new());
            }
            let stdout = String::from_utf8_lossy(&output.stdout);
            Ok(parse_carapace_output(&stdout))
        }
    }
}

/// 失败诊断日志用的 stderr 截断 (carapace 偶发往 stderr 写日志, 防刷屏)
fn truncate_for_log(s: &str) -> String {
    const MAX: usize = 200;
    let s = s.trim();
    if s.chars().count() <= MAX {
        return s.to_string();
    }
    let cut: String = s.chars().take(MAX).collect();
    format!("{cut}...(截断)")
}

// ============================================================================
// T6: 远端安装辅助命令 (前端 SshCarapaceBadge 一键安装链路)
// ============================================================================

/// 返回打包内 linux amd64 二进制的绝对路径 (供前端发起 sftp_upload_file)
///
/// 仅做路径解析, 不执行该二进制 (Windows 上无法运行 ELF)。
/// Err 时前端安装链路直接降级 false, 不重试。
#[tauri::command]
pub fn carapace_linux_path(app: tauri::AppHandle) -> Result<String, String> {
    carapace_path(&app, CarapaceKind::LinuxAmd64).map(|p| p.to_string_lossy().into_owned())
}

/// 上传本地文件到远端 (Rust 内部读盘 + SFTP 写, 不经前端 IPC 搬运大字节)
///
/// 为什么不用现有 sftp_write: 80MB 二进制若经前端中转, 要在 IPC 里序列化成
/// number[] 往返 (慢且占内存); 本命令在前端只传路径, 读盘与上传都在 Rust 完成。
/// 返回上传字节数, 供前端进度/校验展示。
#[tauri::command]
pub async fn sftp_upload_file(
    state: tauri::State<'_, crate::modules::ssh::SshState>,
    session_id: u32,
    local_path: String,
    remote_path: String,
) -> Result<u64, String> {
    let data = tokio::fs::read(&local_path).await.map_err(|e| {
        log::error!("[sftp_upload] 读本地文件失败: {local_path} err={e}");
        e.to_string()
    })?;
    let sftp = state.get_or_create_sftp(session_id).await?;
    sftp.write_file(&remote_path, &data).await.map_err(|e| {
        log::error!(
            "[sftp_upload] 写远端失败: id={session_id} path={remote_path} err={e}"
        );
        e
    })?;
    log::info!("[sftp_upload] 完成: id={session_id} {local_path} → {remote_path} ({} bytes)", data.len());
    Ok(data.len() as u64)
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------------
    // parse_carapace_output — 真实 carapace 输出样例 fixture
    // ------------------------------------------------------------------

    /// 真实样例: `carapace git export git checkout t` → 本地分支候选
    /// (v1.7.3 实测, value 为 t 前缀过滤后的分支名)
    #[test]
    fn parse_real_git_checkout_sample() {
        let raw = r#"{"version":"v1.7.3","messages":[],"noprefix":false,"nospace":false,"usage":"","values":[{"value":"terax-clone-v0","display":"terax-clone-v0","description":"","tag":"local branches"}]}"#;
        let got = parse_carapace_output(raw);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].value, "terax-clone-v0");
        // 真实输出里分支条目 description 为空串, tag 标注来源
        assert_eq!(got[0].description.as_deref(), Some(""));
        assert_eq!(got[0].tag.as_deref(), Some("local branches"));
    }

    /// 真实样例: `carapace git export git switch -` → 选项候选 (nospace=true)
    #[test]
    fn parse_real_git_switch_options_sample() {
        let raw = r#"{"version":"v1.7.3","messages":[],"noprefix":false,"nospace":true,"usage":"[--] <branch>","values":[{"value":"--conflict","display":"--conflict","description":"How to handle conflicting changes","tag":"flag"},{"value":"--create","display":"--create","description":"Create a new branch","tag":"flag"}]}"#;
        let got = parse_carapace_output(raw);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].value, "--conflict");
        assert_eq!(
            got[0].description.as_deref(),
            Some("How to handle conflicting changes")
        );
        assert_eq!(got[1].value, "--create");
        assert_eq!(got[1].tag.as_deref(), Some("flag"));
    }

    /// 空 values (carapace 无候选时): 返回空列表不报错
    #[test]
    fn parse_empty_values() {
        let raw = r#"{"version":"v1.7.3","messages":[],"noprefix":false,"nospace":false,"usage":"","values":[]}"#;
        assert!(parse_carapace_output(raw).is_empty());
    }

    /// 畸形 JSON (非 JSON / 截断 / values 类型错误) → 空列表兜底, 不 panic
    #[test]
    fn parse_malformed_json_returns_empty() {
        assert!(parse_carapace_output("not json at all").is_empty());
        assert!(parse_carapace_output(r#"{"values":[{"value":"cut"#).is_empty());
        assert!(parse_carapace_output(r#"{"values":"not-an-array"}"#).is_empty());
    }

    /// 宽松解析: 条目缺 value → 丢弃; 缺 description/tag → None 兜底
    #[test]
    fn parse_lenient_fields() {
        let raw = r#"{"values":[{"display":"no-value-entry"},{"value":"ok"},{"value":"","display":"empty-value"}]}"#;
        let got = parse_carapace_output(raw);
        // 只剩 "ok": 无 value 与空 value 的条目均被丢弃
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].value, "ok");
        assert_eq!(got[0].description, None);
        assert_eq!(got[0].tag, None);
    }

    /// 宽松解析: 顶层缺 values 字段 / 首尾空白不炸
    #[test]
    fn parse_missing_values_field_and_surrounding_whitespace() {
        assert!(parse_carapace_output(r#"{"version":"v1.7.3"}"#).is_empty());
        let raw = format!("  {}\n ", r#"{"values":[{"value":"main"}]}"#);
        let got = parse_carapace_output(&raw);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].value, "main");
    }

    // ------------------------------------------------------------------
    // 入参过滤 (防注入面)
    // ------------------------------------------------------------------

    #[test]
    fn validate_inputs_rejects_control_chars() {
        let ok = vec!["git".to_string(), "checkout".to_string()];
        assert!(validate_inputs("git", &ok, "ma"));

        // token 含换行 → 拒绝
        let bad_token = vec!["git".to_string(), "check\nout".to_string()];
        assert!(!validate_inputs("git", &bad_token, "ma"));
        // 命令名含 \r → 拒绝
        assert!(!validate_inputs("gi\r t", &ok, "ma"));
        // 当前词含 \n → 拒绝
        assert!(!validate_inputs("git", &ok, "ma\n-b"));
        // 当前词含 \0 → 拒绝
        assert!(!validate_inputs("git", &ok, "ma\0"));
    }

    #[test]
    fn validate_inputs_allows_empty_current() {
        // 尾随空格场景: current 为空串是合法输入
        let tokens = vec!["git".to_string(), "checkout".to_string()];
        assert!(validate_inputs("git", &tokens, ""));
    }

    // ------------------------------------------------------------------
    // 路径解析 (dev 真实路径 + 生产模拟 resource root)
    // ------------------------------------------------------------------

    /// dev 模式模拟: root = CARGO_MANIFEST_DIR → <manifest>/bin/<file>
    /// (carapace_path 的 dev 分支就是以 manifest dir 为 root 调本函数)
    #[test]
    fn dev_path_points_to_manifest_bin() {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        assert_eq!(
            carapace_path_from_root(manifest, CarapaceKind::LocalExe),
            manifest.join("bin").join("carapace.exe")
        );
        assert_eq!(
            carapace_path_from_root(manifest, CarapaceKind::LinuxAmd64),
            manifest.join("bin").join("carapace-linux-amd64")
        );
    }

    /// 生产模式模拟: resources "bin/" 保持相对目录结构 → <resource>/bin/<file>
    #[test]
    fn resource_root_resolution_keeps_bin_prefix() {
        let simulated = std::path::Path::new("C:/Program Files/TDSF Terminal Agent/resources");
        assert_eq!(
            carapace_path_from_root(simulated, CarapaceKind::LocalExe),
            simulated.join("bin").join("carapace.exe")
        );
        // linux 二进制同规则 (T6 上传用路径计算)
        assert_eq!(
            carapace_path_from_root(simulated, CarapaceKind::LinuxAmd64),
            simulated.join("bin").join("carapace-linux-amd64")
        );
    }

    #[test]
    fn kind_file_names_match_packaged_binaries() {
        // 与 src-tauri/bin/ 实际文件名 + CHECKSUMS.txt 记录对齐, 改名必须三处同步
        assert_eq!(CarapaceKind::LocalExe.file_name(), "carapace.exe");
        assert_eq!(CarapaceKind::LinuxAmd64.file_name(), "carapace-linux-amd64");
    }

    #[test]
    fn truncate_for_log_limits_length() {
        let long = "x".repeat(500);
        let cut = truncate_for_log(&long);
        assert!(cut.ends_with("...(截断)"));
        assert!(cut.chars().count() < 500);
        // 短日志原样通过
        assert_eq!(truncate_for_log("short"), "short");
    }
}
