/**
 * error.rs — TDSF Terminal Agent 统一错误类型
 * -----------------------------------------------------------------------------
 * 错误码体系 (与前端 ApiError 保持一致):
 *   - Internal     (500) : 未预期错误
 *   - NotFound     (404) : 资源不存在
 *   - InvalidInput (400) : 用户输入校验失败
 *   - Permission   (403) : 权限拦截 (高危命令)
 *   - Timeout      (408) : 操作超时
 *   - Cancelled    (499) : 用户取消
 *   - Network      (502) : 网络/SSH 错误
 *   - RiskBlocked  (423) : 风险拦截 (4 层风控拒绝)
 */
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Internal,
    NotFound,
    InvalidInput,
    Permission,
    Timeout,
    Cancelled,
    Network,
    RiskBlocked,
}

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("[Internal] {0}")]
    Internal(String),

    #[error("[NotFound] {0}")]
    NotFound(String),

    #[error("[InvalidInput] {0}")]
    InvalidInput(String),

    #[error("[Permission] {0}")]
    Permission(String),

    #[error("[Timeout] {0}")]
    Timeout(String),

    #[error("[Cancelled] {0}")]
    Cancelled(String),

    #[error("[Network] {0}")]
    Network(String),

    #[error("[RiskBlocked] {0}")]
    RiskBlocked(String),

    #[error("[Pty] {0}")]
    Pty(String),
}

impl ApiError {
    pub fn code(&self) -> ErrorCode {
        match self {
            ApiError::Internal(_) => ErrorCode::Internal,
            ApiError::NotFound(_) => ErrorCode::NotFound,
            ApiError::InvalidInput(_) => ErrorCode::InvalidInput,
            ApiError::Permission(_) => ErrorCode::Permission,
            ApiError::Timeout(_) => ErrorCode::Timeout,
            ApiError::Cancelled(_) => ErrorCode::Cancelled,
            ApiError::Network(_) => ErrorCode::Network,
            ApiError::RiskBlocked(_) => ErrorCode::RiskBlocked,
            ApiError::Pty(_) => ErrorCode::Internal,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            ApiError::Internal(m)
            | ApiError::NotFound(m)
            | ApiError::InvalidInput(m)
            | ApiError::Permission(m)
            | ApiError::Timeout(m)
            | ApiError::Cancelled(m)
            | ApiError::Network(m)
            | ApiError::RiskBlocked(m)
            | ApiError::Pty(m) => m,
        }
    }
}

// 序列化输出 (前端可解析)
#[derive(Debug, Serialize)]
pub struct SerializedError {
    pub code: ErrorCode,
    pub message: String,
}

impl fmt::Display for SerializedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl From<ApiError> for SerializedError {
    fn from(err: ApiError) -> Self {
        SerializedError {
            code: err.code(),
            message: err.message().to_string(),
        }
    }
}

impl serde::Serialize for ApiError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        SerializedError::from(ApiError::Internal("".into())).serialize(serializer)
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
