//! 可视教学打字机（TDSF B2 / 方案书 v3.1 §4.8 / spec: add-agent-trust-modes Task 7）
//! ============================================================================
//!
//! Agent 命令获批后的"逐字教学演示"注入：在 Rust 写入端按人味节奏逐字符写
//! PTY / SSH channel，由远端 readline echo 自然形成逐字视觉（前端 xterm.js
//! 零改动）。整段模式 = 现有 write_all 原路径（send），逐字 = 本模块（send -h），
//! 与调研结论一致：同一通道的两种节奏。
//!
//! ## 算法出处（expect `human_write()` 源码级取证，非文档转述）
//!
//! Weibull 逆变换采样：`U ~ Uniform(0,1)`，`t = alpha·(-ln U)^(1/shape)`。
//! 词尾转换（词内 → 标点/空格）用更大的 alpha_eow 模拟打字员迟疑；
//! min/max 截断防极端值；首字符零延迟。经典参数 `{0.1, 0.3, 1, 0.05, 2}`
//! 被 expect 文档评价为 "emulates fast and consistent typist"。
//! gsc（教学演示同类工具）实测"等间隔打字完全不自然"→ 随机性是硬要求。
//!
//! ## 8 项注意事项的分工（§4.8.2）
//!
//! 1. 清行等 prompt      → 调用方命令（`pty_write_human` / `ssh_write_human`）：
//!                          pump 前写 `\x03` + 固定 300ms 等待（Rust 侧无
//!                          OSC 133 block 状态，采用简单超时等待的最小实现）
//! 2. 控制字符禁令       → `sanitize_typing_text`：剥 `\t` 与转义序列，
//!                          只允许可打印字符 + `\r`；多字节整块写
//! 3. 随机延迟           → `weibull_delay`（本模块内置，禁止匀速）
//! 4. `!` 告警 / sudo 降级 → `sanitize_typing_text` 告警 + `is_sudo_password_risk`
//!                          （echo 关闭视觉无效 → 整段注入交还用户输密码）
//! 5. 用户按键停 pump    → 调用方 should_stop 闭包（pty_write / ssh_write
//!                          每次用户键盘写入 bump 会话计数器，pump 轮询）
//! 6. 等上条 133;D       → 调用方串行（当前场景单命令注入，Agent 侧逐条
//!                          审批天然串行；多次注入由调用方保证）
//! 7. russh 背压         → channel `data_bytes` 自带 SSH 流控窗口（写侧阻塞
//!                          至窗口可用），逐字低速模式天然无压力
//! 8. >200 字符走整段    → 前端调用前判断（useAiLiveBridge）

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::Emitter;

/// expect 经典参数：平均字符间隔 0.1s
pub const DEFAULT_ALPHA: f64 = 0.1;
/// expect 经典参数：词尾转换平均间隔 0.3s（模拟词尾迟疑）
pub const DEFAULT_ALPHA_EOW: f64 = 0.3;
/// expect 经典参数：Weibull 形状参数（1.0 = 指数分布，纯随机到达）
pub const DEFAULT_SHAPE: f64 = 1.0;
/// expect 经典参数：单次延迟下限 0.05s
pub const DEFAULT_MIN: f64 = 0.05;
/// expect 经典参数：单次延迟上限 2.0s
pub const DEFAULT_MAX: f64 = 2.0;

/// 速度倍率范围（设置页滑杆 0.2×~5×，与 spec 一致）
pub const SPEED_MIN: f64 = 0.2;
pub const SPEED_MAX: f64 = 5.0;

/// 延迟 sleep 的切片粒度：长停顿切成 50ms 小片轮询 should_stop，
/// 保证用户中途按键后 ≤50ms 内停止 pump（接管体验的关键）。
const STOP_POLL_SLICE: Duration = Duration::from_millis(50);

/// pump 前写 \x03 清行后等新 prompt 的时长（8 项之 1）。
/// Rust 侧无 OSC 133 block 状态（block 流水账在前端 xterm 解析层），
/// 无法精确等待 133;A —— 采用任务书允许的最小实现：固定超时等待，
/// 覆盖 shell 处理 Ctrl-C 并重绘 prompt 的典型耗时。
const PROMPT_SETTLE_DELAY: Duration = Duration::from_millis(300);

/// 打字机事件（跟随 session.rs AGENT_EVENT 的 emit 惯例）
pub const HUMAN_TYPING_EVENT: &str = "terminal:human_typing";

/// 词尾判定：空格或 ASCII 标点 = 停顿点（对齐 expect 的 IsPunct/IsSpace；
/// 教学命令以 ASCII 为主，`_` 也计入标点，与 Tcl ispunct 一致）
fn is_break_char(ch: char) -> bool {
    ch.is_whitespace() || ch.is_ascii_punctuation()
}

/// Weibull 逆变换采样：本字符写入前的延迟。
///
/// - `prev_char = None`（首字符）→ 零延迟（立刻开始，别让用户等）
/// - 词内 → 标点/空格转换 → 用 `alpha_eow`（词尾停顿，人味的关键细节）
/// - `t = alpha·(-ln U)^(1/shape)`，min/max 截断
pub fn weibull_delay(
    alpha: f64,
    alpha_eow: f64,
    shape: f64,
    min: f64,
    max: f64,
    prev_char: Option<char>,
    ch: char,
) -> Duration {
    let Some(prev) = prev_char else {
        return Duration::ZERO;
    };
    let alpha = if !is_break_char(prev) && is_break_char(ch) {
        alpha_eow
    } else {
        alpha
    };
    // 非法形状参数降级为指数分布（shape=1），防除零/负数幂
    let shape = if shape.is_finite() && shape > 0.0 {
        shape
    } else {
        1.0
    };
    // rand 的 f64 采样是 [0,1)；-ln(0)=+inf，压到最小正数防炸
    // （rand 0.10：random() 在 RngExt trait 上）
    use rand::RngExt;
    let u: f64 = rand::rng().random();
    let u = if u <= 0.0 { f64::MIN_POSITIVE } else { u };
    let t = alpha * (-u.ln()).powf(1.0 / shape);
    let t = t.clamp(min.max(0.0), max.max(min.max(0.0)));
    Duration::from_secs_f64(t)
}

/// 输入净化：返回 (净化文本, 告警列表)。
///
/// 规则（8 项之 2 / 4）：
/// - 剥 `\t`（会触发 readline 补全 / fzf 菜单）
/// - 剥 ESC 转义序列（防御性：bracketed-paste 标记 `\x1b[200~`/`\x1b[201~`
///   会让 zsh 把其中的 `\r` 当字面量，绝不能包进打字流）
/// - 只保留可打印字符；`\n`/`\r` 统一为 `\r`（shell 回车；多行命令逐行
///   执行 = 真实人打行为），其他控制字符丢弃
/// - 含 `!` → 告警（交互式 bash history expansion 会真实展开）
pub fn sanitize_typing_text(text: &str) -> (String, Vec<String>) {
    let mut warnings = Vec::new();
    if text.contains('!') {
        warnings.push(
            "命令含 \"!\"，交互式 shell 的历史展开（history expansion）会真实触发，已照原样注入，请留意结果".to_string(),
        );
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // 丢弃整个转义序列：吃掉到字母/`~` 结束符为止（CSI 最终字节），
            // 最坏情况整段丢弃也不至于把半个序列写进 shell
            for term in chars.by_ref() {
                if term.is_ascii_alphabetic() || term == '~' {
                    break;
                }
            }
            continue;
        }
        if c == '\t' {
            continue;
        }
        if c == '\n' || c == '\r' {
            // 折叠连续换行，统一为单个回车
            if !out.ends_with('\r') {
                out.push('\r');
            }
            continue;
        }
        if c.is_control() {
            continue;
        }
        out.push(c);
    }
    (out, warnings)
}

/// 密码场景检测（8 项之 4 的降级策略）：
/// 命令含 `sudo`（除 `sudo -n`）→ 打字机视觉无效（echo 关闭），整段注入
/// 后交还用户输密码。按 `;`/`&`/`|`/换行拆段逐段判定，覆盖复合命令。
pub fn is_sudo_password_risk(text: &str) -> bool {
    text.split(|c: char| c == ';' || c == '&' || c == '|' || c == '\n' || c == '\r')
        .any(|seg| {
            let seg = seg.trim_start();
            // `sudo` 必须是独立词（排除 `sudoers` 等以 sudo 开头的词）
            if !(seg == "sudo" || seg.starts_with("sudo ")) {
                return false;
            }
            let rest = seg["sudo".len()..].trim_start();
            // `sudo -n`（非交互免密探测）不触发降级；裸 `sudo` 也会要密码
            !rest.starts_with("-n")
        })
}

/// pump 结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HumanTypeOutcome {
    /// 实际写入的字符数（多字节字符按 1 计）
    pub typed_chars: usize,
    /// true = 用户中途按键接管（pump 提前停止，剩余字符不写）
    pub stopped: bool,
}

/// human_type pump（expect `send -h` 的异步移植，PTY / SSH 双端共用）。
///
/// 逐字符写入：UTF-8 多字节字符整块写、延迟只插在完整字符之间（8 项之 2/9）。
/// `write` 是同步短临界区回调（std 锁内无 await，SSH 侧为 russh data_bytes
/// await）；`should_stop` 在每字符写前与 sleep 切片间轮询。
///
/// speed 为滑杆倍率（0.2~5.0），alpha/alpha_eow/min/max 全部等比缩放。
pub async fn human_type_write<W, Fut, S>(
    write: W,
    text: &str,
    speed: f64,
    should_stop: S,
) -> HumanTypeOutcome
where
    W: Fn(Vec<u8>) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
    S: Fn() -> bool,
{
    let (clean, _warnings) = sanitize_typing_text(text);
    // 非法倍率 clamp 到滑杆范围（防 0 除 / 负数）
    let speed = if speed.is_finite() {
        speed.clamp(SPEED_MIN, SPEED_MAX)
    } else {
        1.0
    };
    let alpha = DEFAULT_ALPHA / speed;
    let alpha_eow = DEFAULT_ALPHA_EOW / speed;
    let min = DEFAULT_MIN / speed;
    let max = DEFAULT_MAX / speed;

    let mut typed: usize = 0;
    let mut prev: Option<char> = None;
    let mut bytes_buf = [0u8; 4];
    for ch in clean.chars() {
        if should_stop() {
            return HumanTypeOutcome { typed_chars: typed, stopped: true };
        }
        // 首字符零延迟；延迟按 (prev, ch) 转换判定（对齐 expect：先迟疑再落键）
        let delay = weibull_delay(alpha, alpha_eow, DEFAULT_SHAPE, min, max, prev, ch);
        if !delay.is_zero() {
            let mut left = delay;
            while !left.is_zero() {
                if should_stop() {
                    return HumanTypeOutcome { typed_chars: typed, stopped: true };
                }
                let step = left.min(STOP_POLL_SLICE);
                tokio::time::sleep(step).await;
                left = left.saturating_sub(step);
            }
            // 长停顿结束后再查一次，防止把字符写进用户已接管的输入行
            if should_stop() {
                return HumanTypeOutcome { typed_chars: typed, stopped: true };
            }
        }
        let bytes = ch.encode_utf8(&mut bytes_buf).as_bytes().to_vec();
        if write(bytes).await.is_err() {
            // 会话已关闭 / 写失败：停止但不视为用户接管
            return HumanTypeOutcome { typed_chars: typed, stopped: false };
        }
        typed += 1;
        prev = Some(ch);
    }
    HumanTypeOutcome { typed_chars: typed, stopped: false }
}

/// 打字机事件载荷（start / end 两个 phase，前端状态条与 toast 消费）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanTypingEvent {
    /// "start" | "end"
    pub phase: &'static str,
    /// "pty" | "ssh"
    pub target: &'static str,
    /// pty id 或 ssh session_id
    pub id: u32,
    /// "human" = 逐字 pump；"fallback" = 整段降级（sudo / 重入）
    pub mode: &'static str,
    /// end 阶段：是否被用户按键打断
    pub stopped: bool,
    /// end 阶段：警告文案（`!` 告警 / sudo 降级提示）
    pub warning: Option<String>,
}

pub fn emit_human_typing(app: &tauri::AppHandle, event: HumanTypingEvent) {
    if let Err(e) = app.emit(HUMAN_TYPING_EVENT, &event) {
        log::warn!("[human_type] emit {HUMAN_TYPING_EVENT} failed: {e}");
    }
}

/// Tauri 命令返回值（前端分流 / toast 消费）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HumanTypeReport {
    /// "human" = 逐字 pump 已在后台启动（结束走 HUMAN_TYPING_EVENT end）
    /// "fallback" = 已整段立即写入（sudo 场景 / pump 重入）
    pub mode: &'static str,
    pub stopped: bool,
    pub warning: Option<String>,
}

/// pty / ssh 两端共用的 pump 编排信号句柄
pub struct HumanTypingGuard {
    /// 会话退出标志（pty: Session.exited / ssh: SshSession.exited）
    pub exited: Arc<AtomicBool>,
    /// 用户键盘写入计数（pty_write / ssh_write 每次调用 bump）
    pub user_seq: Arc<AtomicU64>,
    /// 打字机重入闸门
    pub typing_active: Arc<AtomicBool>,
}

/// 两端共用的人味注入编排：sudo 降级判定 → 重入闸门 → start 事件 →
/// 清行等 prompt → spawn 后台 pump → end 事件。
///
/// `write` 为该端的具体写入实现（pty writer / russh data_bytes）；
/// pump 在 tauri async runtime 后台运行，本函数立即返回。
pub async fn write_human_common<W, Fut>(
    app: &tauri::AppHandle,
    target: &'static str,
    id: u32,
    guard: HumanTypingGuard,
    write: W,
    text: String,
    speed: f64,
) -> Result<HumanTypeReport, String>
where
    W: Fn(Vec<u8>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<(), String>> + Send,
{
    let (clean, warnings) = sanitize_typing_text(&text);
    let bang_warning = warnings.into_iter().next();

    // 8 项之 4 降级策略：sudo（非 -n）→ 整段注入 + 交还用户输密码
    if is_sudo_password_risk(&clean) {
        let warning = Some(
            "命令含 sudo：密码输入不会回显，已整段注入，请自行输入密码".to_string(),
        );
        write(clean.into_bytes())
            .await
            .map_err(|e| format!("[human_type] {target} id={id} fallback write failed: {e}"))?;
        emit_human_typing(
            app,
            HumanTypingEvent {
                phase: "end",
                target,
                id,
                mode: "fallback",
                stopped: false,
                warning: warning.clone(),
            },
        );
        return Ok(HumanTypeReport {
            mode: "fallback",
            stopped: false,
            warning: bang_warning.or(warning),
        });
    }

    // 重入闸门：已有 pump 在跑 → 降级整段（命令原样快速送达，不静默丢弃）
    if guard
        .typing_active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        log::warn!("[human_type] {target} id={id} typing already active, fallback to instant");
        write(clean.into_bytes())
            .await
            .map_err(|e| {
                format!("[human_type] {target} id={id} reentrant fallback write failed: {e}")
            })?;
        emit_human_typing(
            app,
            HumanTypingEvent {
                phase: "end",
                target,
                id,
                mode: "fallback",
                stopped: false,
                warning: None,
            },
        );
        return Ok(HumanTypeReport { mode: "fallback", stopped: false, warning: bang_warning });
    }

    emit_human_typing(
        app,
        HumanTypingEvent {
            phase: "start",
            target,
            id,
            mode: "human",
            stopped: false,
            warning: None,
        },
    );

    // 8 项之 5：stop 信号基线 —— 之后任何 pty_write/ssh_write（用户键盘）
    // 都会 bump user_seq，pump 检测到 ≠ seq0 即停，交还控制权。
    let seq0 = guard.user_seq.load(Ordering::Acquire);
    let stop_exited = guard.exited.clone();
    let stop_seq = guard.user_seq.clone();
    let should_stop = move || {
        stop_exited.load(Ordering::Acquire) || stop_seq.load(Ordering::Acquire) != seq0
    };

    let app_for_task = app.clone();
    // bang_warning 同时被 pump 任务与返回值消费，clone 一份进任务
    let task_bang_warning = bang_warning.clone();
    tauri::async_runtime::spawn(async move {
        // 8 项之 1：清行并等 prompt（PROMPT_SETTLE_DELAY，见常量注释）。
        if let Err(e) = write(b"\x03".to_vec()).await {
            log::warn!("[human_type] {target} id={id} clear-line failed: {e}");
        }
        tokio::time::sleep(PROMPT_SETTLE_DELAY).await;

        let outcome = human_type_write(write, &clean, speed, should_stop).await;
        if outcome.stopped {
            log::info!(
                "[human_type] {target} id={id} interrupted by user after {} chars",
                outcome.typed_chars
            );
        } else {
            log::info!("[human_type] {target} id={id} typed {} chars", outcome.typed_chars);
        }
        emit_human_typing(
            &app_for_task,
            HumanTypingEvent {
                phase: "end",
                target,
                id,
                mode: "human",
                stopped: outcome.stopped,
                warning: task_bang_warning,
            },
        );
        // 释放重入闸门
        guard.typing_active.store(false, Ordering::Release);
    });

    Ok(HumanTypeReport { mode: "human", stopped: false, warning: bang_warning })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn weibull_first_char_zero_delay() {
        let d = weibull_delay(0.1, 0.3, 1.0, 0.05, 2.0, None, 'a');
        assert_eq!(d, Duration::ZERO);
    }

    #[test]
    fn weibull_delays_within_min_max() {
        // 1000 次采样全部落在 [min, max] 截断内
        let mut prev = Some('x');
        for ch in "hello world".chars() {
            for _ in 0..1000 {
                let d = weibull_delay(0.1, 0.3, 1.0, 0.05, 2.0, prev, ch);
                let secs = d.as_secs_f64();
                assert!((0.05..=2.0).contains(&secs), "delay {secs} out of range");
            }
            prev = Some(ch);
        }
    }

    #[test]
    fn weibull_eow_pause_larger_than_intra_word() {
        // 词尾转换（h→空格）平均延迟应显著大于词内（平均 0.1 vs 0.3，shape=1）
        let eow_mean = mean_delay(Some('h'), ' ');
        let intra_mean = mean_delay(Some('h'), 'e');
        assert!(
            eow_mean > intra_mean * 1.5,
            "eow {eow_mean} should exceed intra-word {intra_mean} by 1.5x"
        );
    }

    fn mean_delay(prev: Option<char>, ch: char) -> f64 {
        let n = 4000;
        let mut sum = 0.0;
        for _ in 0..n {
            sum += weibull_delay(0.1, 0.3, 1.0, 0.001, 10.0, prev, ch).as_secs_f64();
        }
        sum / n as f64
    }

    #[test]
    fn sanitize_strips_tab_and_escapes() {
        let (out, _) = sanitize_typing_text("ls\t-al\x1b[200~echo\x1b[201~ hi");
        assert_eq!(out, "ls-alecho hi");
    }

    #[test]
    fn sanitize_keeps_printable_and_normalizes_newline() {
        let (out, _) = sanitize_typing_text("yum install httpd -y\n");
        assert_eq!(out, "yum install httpd -y\r");
        // 连续换行折叠为单个 \r
        let (out2, _) = sanitize_typing_text("a\n\r\nb");
        assert_eq!(out2, "a\rb");
    }

    #[test]
    fn sanitize_drops_other_control_chars() {
        // BEL(\x07) + 退格(\x08) 等控制字符直接丢弃
        let (out, _) = sanitize_typing_text("ab\x07\x08cd");
        assert_eq!(out, "abcd");
        // ESC + 字母/`~` 结束的转义序列整体丢弃（\x1bc 是 RIS 全复位序列）：
        // 防御性剥除 SGR 色彩等装饰序列，绝不写进 shell 输入流
        let (out2, _) = sanitize_typing_text("\x1b[31mred\x1b[0m");
        assert_eq!(out2, "red");
    }

    #[test]
    fn sanitize_warns_on_bang() {
        let (_, w) = sanitize_typing_text("echo hello!");
        assert_eq!(w.len(), 1);
        let (_, w2) = sanitize_typing_text("echo ok");
        assert!(w2.is_empty());
    }

    #[test]
    fn sudo_detection() {
        assert!(is_sudo_password_risk("sudo apt install nginx"));
        assert!(is_sudo_password_risk("cd /tmp && sudo dnf upgrade"));
        assert!(is_sudo_password_risk("ls; sudo systemctl restart nginx"));
        assert!(is_sudo_password_risk("sudo cat /etc/shadow"));
        // `sudo -n`（非交互免密探测）不触发降级
        assert!(!is_sudo_password_risk("sudo -n systemctl status nginx"));
        // 非 sudo 命令 / 含 sudo 字样的词不算
        assert!(!is_sudo_password_risk("apt install nginx"));
        assert!(!is_sudo_password_risk("echo sudoers file"));
    }

    #[tokio::test]
    async fn pump_writes_all_chars_in_order() {
        let written: Arc<std::sync::Mutex<Vec<u8>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let w = written.clone();
        let outcome = human_type_write(
            move |bytes: Vec<u8>| {
                let w = w.clone();
                async move {
                    w.lock().unwrap().extend_from_slice(&bytes);
                    Ok(())
                }
            },
            "yum install httpd -y\n",
            SPEED_MAX, // 5×：单测加速（min/speed = 10ms）
            || false,
        )
        .await;
        assert_eq!(outcome.typed_chars, "yum install httpd -y\r".chars().count());
        assert!(!outcome.stopped);
        assert_eq!(
            String::from_utf8(written.lock().unwrap().clone()).unwrap(),
            "yum install httpd -y\r"
        );
    }

    #[tokio::test]
    async fn pump_stops_on_user_input() {
        // 模拟用户在第 3 个字符写入后按键接管 → pump 提前停止，剩余字符不写
        let counter = Arc::new(AtomicUsize::new(0));
        let wc = counter.clone();
        let sc = counter.clone();
        let outcome = human_type_write(
            move |bytes: Vec<u8>| {
                let wc = wc.clone();
                async move {
                    wc.fetch_add(bytes.len(), Ordering::SeqCst);
                    Ok(())
                }
            },
            "systemctl status nginx.service",
            SPEED_MAX,
            move || sc.load(Ordering::SeqCst) >= 3,
        )
        .await;
        assert!(outcome.stopped);
        assert_eq!(outcome.typed_chars, 3);
    }
}
