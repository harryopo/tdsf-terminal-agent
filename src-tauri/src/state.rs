/**
 * state.rs — TDSF Terminal Agent 全局状态 (Tauri 2 风格)
 * -----------------------------------------------------------------------------
 * P0 阶段最小状态:
 *   - 启动时间
 *   - 当前主题 (前端驱动, 后端镜像保存)
 *   - 当前 Mood 状态
 *
 * 后续 P1-P3 阶段会追加:
 *   - SSH 多 host 池
 *   - Python Sidecar 句柄
 *   - Project Service 单一写入器
 *   - AI Provider 多模型路由
 */
use chrono::{DateTime, Utc};
use std::sync::Mutex;

pub struct AppState {
    /// 应用启动时间
    pub started_at: DateTime<Utc>,
    /// 当前主题 (前端驱动, 后端镜像)
    pub theme: Mutex<String>,
    /// 当前 Mood 状态 (P2 阶段真正使用)
    pub mood: Mutex<Mood>,
}

/// 7 状态 Mood (与前端 src/components/ThemePreview.tsx MOOD_STATES 保持一致)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mood {
    Idle,
    Thinking,
    Stream,
    Working,
    Waiting,
    Done,
    Error,
}

impl Mood {
    pub fn as_str(&self) -> &'static str {
        match self {
            Mood::Idle => "idle",
            Mood::Thinking => "thinking",
            Mood::Stream => "stream",
            Mood::Working => "working",
            Mood::Waiting => "waiting",
            Mood::Done => "done",
            Mood::Error => "error",
        }
    }
}

impl Default for Mood {
    fn default() -> Self {
        Mood::Idle
    }
}

impl AppState {
    pub fn new() -> Self {
        Self {
            started_at: Utc::now(),
            theme: Mutex::new("dark".to_string()),
            mood: Mutex::new(Mood::default()),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
