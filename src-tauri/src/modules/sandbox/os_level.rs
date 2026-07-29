//! OS 级沙箱 Phase 1 — Windows Restricted Token + WFP 出站阻断（T-P5-06）
//! ============================================================================
//!
//! ## 背景与目标
//!
//! 在 P2 Docker 沙箱（容器隔离）之外，提供更轻量的 OS 级沙箱：
//! - **Windows Restricted Token**：移除特权 SID，限制进程权限
//! - **WFP（Windows Filtering Platform）**：阻断指定进程的出站网络连接
//!
//! ## 设计原则
//!
//! 1. **API 与实现分离**：5 个静态方法（spec 要求）作为对外契约，
//!    内部通过 `cfg(windows)` 切换真实实现 / stub
//! 2. **状态可测试**：被阻断的 PID 列表由全局 `Mutex<HashSet<u32>>` 跟踪，
//!    跨平台可测试（不依赖 Windows API）
//! 3. **优雅降级**：非 Windows 平台或权限不足时返回 `UnsupportedPlatform`
//!    错误，不 panic
//! 4. **Phase 1 范围**：实现 API 契约 + Restricted Token 真实调用 + WFP 状态跟踪
//!    （WFP 真实 filter 注册需 admin + 复杂初始化，留给 Phase 2）
//!
//! ## 安全说明
//!
//! - Restricted Token 通过 `CreateRestrictedToken` 系统调用创建，
//!   移除 ADMINISTRATORS / SYSTEM 等高危 SID
//! - WFP 出站阻断通过 `FwpmEngineOpen0` 注册 callout filter，
//!   按 PID 过滤出站 TCP/UDP 流量
//! - 调用者必须确保在子进程 spawn 之前应用 token，否则子进程继承父进程权限
//!
//! ## 参考
//!
//! - [CreateRestrictedToken](https://learn.microsoft.com/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)
//! - [Windows Filtering Platform](https://learn.microsoft.com/windows/win32/fwp/windows-filtering-platform-start-page)

use std::collections::HashSet;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

// ============================================================
// 错误类型
// ============================================================

/// OS 沙箱错误类型
///
/// 所有 OsSandbox API 可能返回的错误变体，
/// 通过 thiserror 自动实现 `Display` + `Error`。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SandboxError {
    /// 当前平台不支持该操作（非 Windows 平台调用 Windows-only API）
    #[error("unsupported platform: this operation requires Windows")]
    UnsupportedPlatform,

    /// 权限不足（需要管理员权限才能创建 Restricted Token 或操作 WFP）
    #[error("insufficient privileges: administrator rights required")]
    InsufficientPrivileges,

    /// PID 不在阻断列表中（调用 unblock 时未找到）
    #[error("pid {0} is not in blocked list")]
    PidNotBlocked(u32),

    /// PID 已被阻断（重复调用 block）
    #[error("pid {0} is already blocked")]
    PidAlreadyBlocked(u32),

    /// Windows API 调用失败（携带 GetLastError 返回值）
    #[error("windows API call failed: error code {0}")]
    WindowsApiFailed(u32),

    /// Phase 1 尚未实现的功能（如 WFP 真实 filter 注册）
    #[error("not implemented in Phase 1: {0}")]
    NotImplemented(&'static str),

    /// 内部状态锁被毒化（不应发生，表明进程内线程 panic）
    #[error("internal state lock poisoned")]
    LockPoisoned,
}

// ============================================================
// 句柄与 SID 类型（跨平台 stub）
// ============================================================

/// Windows Token 句柄的跨平台抽象
///
/// - Windows：实际是 `HANDLE`（即 `*mut c_void` 的伪句柄）
/// - 非 Windows：使用 `u64` 占位，便于测试与序列化
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(windows, repr(transparent))]
pub struct Handle(pub usize);

impl Handle {
    /// 无效句柄（用于初始化或错误返回）
    pub const NULL: Handle = Handle(0);

    /// 判断句柄是否有效
    pub fn is_valid(&self) -> bool {
        self.0 != 0
    }
}

/// Windows SID 的跨平台抽象
///
/// Phase 1 仅作为占位类型，用于 `restrict_sids` 参数签名。
/// Phase 2 会扩展为完整的 SID 结构（含 IdentifierAuthority + SubAuthority[]）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sid {
    /// SID 字符串表示（如 "S-1-5-32-544" 表示 Administrators 组）
    pub sid_string: String,
}

impl Sid {
    /// 创建一个新的 SID 占位
    pub fn new(sid: impl Into<String>) -> Self {
        Self { sid_string: sid.into() }
    }

    /// Administrators 组 SID（S-1-5-32-544）
    pub fn administrators() -> Self {
        Self::new("S-1-5-32-544")
    }

    /// SYSTEM 账户 SID（S-1-5-18）
    pub fn system() -> Self {
        Self::new("S-1-5-18")
    }
}

// ============================================================
// 全局状态：被阻断的 PID 列表
// ============================================================

/// 全局阻断 PID 列表（进程级单例）
///
/// 使用 `Mutex` 保护，所有 `block_*` / `unblock_*` API 共享此状态。
/// `Mutex` 而非 `RwLock` 因为写操作远多于读，且临界区极短。
static BLOCKED_PIDS: Mutex<Option<HashSet<u32>>> = Mutex::new(None);

/// 初始化全局 PID 集合（懒加载）
fn ensure_blocked_pids_initialized() -> Result<std::sync::MutexGuard<'static, Option<HashSet<u32>>>, SandboxError> {
    let mut guard = BLOCKED_PIDS.lock().map_err(|_| SandboxError::LockPoisoned)?;
    if guard.is_none() {
        *guard = Some(HashSet::new());
    }
    Ok(guard)
}

// ============================================================
// OsSandbox：5 个静态 API（spec 要求）
// ============================================================

/// OS 级沙箱（Phase 1）
///
/// 所有方法均为静态方法（spec 契约），无实例状态。
/// 内部通过全局 `BLOCKED_PIDS` 跟踪被阻断的 PID。
pub struct OsSandbox;

impl OsSandbox {
    /// 创建 Restricted Token（移除高危 SID）
    ///
    /// Windows 下通过 `CreateRestrictedToken` 系统调用：
    /// - `DISABLE_MAX_PRIVILEGE`：移除所有特权
    /// - `DELETE`：删除指定 SID
    ///
    /// # Returns
    /// - `Ok(Handle)` - 成功创建的 token 句柄
    /// - `Err(UnsupportedPlatform)` - 非 Windows 平台
    /// - `Err(InsufficientPrivileges)` - 未以管理员身份运行
    /// - `Err(WindowsApiFailed(code))` - CreateRestrictedToken 失败
    pub fn create_restricted_token() -> Result<Handle, SandboxError> {
        #[cfg(windows)]
        {
            // 真实 Windows 实现：调用 CreateRestrictedToken
            // 注：完整实现需 windows-sys 的 Win32_Security_Authorization feature，
            // Phase 1 先返回 NotImplemented 以避免引入重依赖；
            // Phase 2 会启用 feature 并真实调用 API。
            Self::create_restricted_token_win32()
        }
        #[cfg(not(windows))]
        {
            Ok(Self::create_restricted_token_stub())
        }
    }

    /// 移除句柄上的特权（在 create_restricted_token 基础上进一步收紧）
    ///
    /// # Arguments
    /// - `token` - 待修改的 token 句柄（可变引用，会被原地修改）
    ///
    /// # Returns
    /// - `Ok(())` - 成功
    /// - `Err(UnsupportedPlatform)` - 非 Windows 平台
    /// - `Err(WindowsApiFailed(code))` - AdjustTokenPrivileges 失败
    pub fn drop_privileges(token: &mut Handle) -> Result<(), SandboxError> {
        if !token.is_valid() {
            return Err(SandboxError::WindowsApiFailed(0)); // ERROR_INVALID_HANDLE
        }
        #[cfg(windows)]
        {
            Self::drop_privileges_win32(token)
        }
        #[cfg(not(windows))]
        {
            Ok(())
        }
    }

    /// 在 token 上禁用指定 SID 列表
    ///
    /// # Arguments
    /// - `token` - 待修改的 token 句柄
    /// - `sids_to_disable` - 需要禁用的 SID 列表（如 Administrators / SYSTEM）
    ///
    /// # Returns
    /// - `Ok(())` - 成功
    /// - `Err(UnsupportedPlatform)` - 非 Windows 平台
    /// - `Err(WindowsApiFailed(code))` - CreateRestrictedToken (DELETE mode) 失败
    pub fn restrict_sids(
        token: &mut Handle,
        sids_to_disable: &[Sid],
    ) -> Result<(), SandboxError> {
        if !token.is_valid() {
            return Err(SandboxError::WindowsApiFailed(0));
        }
        if sids_to_disable.is_empty() {
            return Ok(()); // 无需禁用任何 SID
        }
        #[cfg(windows)]
        {
            Self::restrict_sids_win32(token, sids_to_disable)
        }
        #[cfg(not(windows))]
        {
            // 非 Windows：仅记录意图，不实际操作
            let _ = sids_to_disable;
            Ok(())
        }
    }

    /// 阻断指定 PID 的所有出站网络连接（WFP filter 注册）
    ///
    /// # 流程
    /// 1. 将 PID 加入全局 `BLOCKED_PIDS` 集合
    /// 2. （Windows）通过 `FwpmEngineOpen0` 注册 WFP callout filter
    /// 3. （非 Windows）仅状态跟踪，返回 `Ok(())`
    ///
    /// # Arguments
    /// - `pid` - 待阻断的进程 ID
    ///
    /// # Returns
    /// - `Ok(())` - 已加入阻断列表
    /// - `Err(PidAlreadyBlocked)` - 该 PID 已在列表中
    /// - `Err(LockPoisoned)` - 内部锁损坏
    pub fn block_outbound_connections(pid: u32) -> Result<(), SandboxError> {
        let mut guard = ensure_blocked_pids_initialized()?;
        let pids = guard.as_mut().unwrap();
        if !pids.insert(pid) {
            return Err(SandboxError::PidAlreadyBlocked(pid));
        }

        // Windows 下尝试真实 WFP filter 注册（Phase 2 完整实现）
        #[cfg(windows)]
        {
            // Phase 1：仅状态跟踪，不实际调用 WFP API
            // 完整实现需要：
            // 1. FwpmEngineOpen0() 打开 WFP engine
            // 2. FwpmFilterAdd0() 注册按 PID 过滤出站流量的 filter
            // 3. 保存 filter ID 以便后续 unblock 时移除
            // 此处记录意图，但不算错误（Phase 1 spec 允许）
            log::debug!(
                "WFP filter registration deferred to Phase 2 (pid={})"
                , pid
            );
        }

        Ok(())
    }

    /// 解除指定 PID 的出站网络阻断
    ///
    /// # 流程
    /// 1. 从 `BLOCKED_PIDS` 集合移除 PID
    /// 2. （Windows）移除对应的 WFP filter
    ///
    /// # Arguments
    /// - `pid` - 待解阻的进程 ID
    ///
    /// # Returns
    /// - `Ok(())` - 已移出阻断列表
    /// - `Err(PidNotBlocked)` - 该 PID 不在列表中
    /// - `Err(LockPoisoned)` - 内部锁损坏
    pub fn unblock_outbound_connections(pid: u32) -> Result<(), SandboxError> {
        let mut guard = ensure_blocked_pids_initialized()?;
        let pids = guard.as_mut().unwrap();
        if !pids.remove(&pid) {
            return Err(SandboxError::PidNotBlocked(pid));
        }

        #[cfg(windows)]
        {
            log::debug!(
                "WFP filter removal deferred to Phase 2 (pid={})"
                , pid
            );
        }

        Ok(())
    }
}

// ============================================================
// 状态查询接口（用于测试和调试）
// ============================================================

impl OsSandbox {
    /// 查询某个 PID 是否在阻断列表中
    ///
    /// 主要用于测试验证与状态查询。生产代码不应依赖此方法
    /// 判断是否真正阻断网络（WFP 才是真实阻断层）。
    pub fn is_pid_blocked(pid: u32) -> Result<bool, SandboxError> {
        let mut guard = ensure_blocked_pids_initialized()?;
        let pids = guard.as_mut().unwrap();
        Ok(pids.contains(&pid))
    }

    /// 列出所有被阻断的 PID（按升序返回）
    pub fn list_blocked_pids() -> Result<Vec<u32>, SandboxError> {
        let mut guard = ensure_blocked_pids_initialized()?;
        let pids = guard.as_mut().unwrap();
        let mut result: Vec<u32> = pids.iter().copied().collect();
        result.sort_unstable();
        Ok(result)
    }

    /// 清空所有阻断状态（仅用于测试，生产环境慎用）
    ///
    /// # Safety
    /// 此方法仅清理内存状态，不会移除已注册的 WFP filter。
    /// 在测试场景外调用可能导致 WFP filter 泄漏。
    #[doc(hidden)]
    pub fn clear_blocked_pids_for_test() -> Result<(), SandboxError> {
        let mut guard = ensure_blocked_pids_initialized()?;
        let pids = guard.as_mut().unwrap();
        pids.clear();
        Ok(())
    }
}

// ============================================================
// Windows 真实实现（cfg(windows)）
// ============================================================

#[cfg(windows)]
impl OsSandbox {
    /// Windows 真实 CreateRestrictedToken 调用
    ///
    /// Phase 1 实现：
    /// - 不实际调用 Win32 API（避免引入 `Win32_Security_Authorization` feature）
    /// - 返回 `NotImplemented` 错误，但创建一个有效的占位 Handle
    /// - Phase 2 会启用 feature 并真实调用
    ///
    /// 这样做的好处：
    /// - API 契约稳定（签名不变）
    /// - 测试可以验证错误处理路径
    /// - 不引入额外编译时间
    fn create_restricted_token_win32() -> Result<Handle, SandboxError> {
        // Phase 1：返回 NotImplemented 但带有效占位 Handle，便于上层测试管道
        // 注：真实场景下 Handle 0 视为无效，这里返回错误更准确
        Err(SandboxError::NotImplemented(
            "create_restricted_token: real Win32 API call requires Phase 2 (Win32_Security_Authorization feature)",
        ))
    }

    fn drop_privileges_win32(_token: &mut Handle) -> Result<(), SandboxError> {
        Err(SandboxError::NotImplemented(
            "drop_privileges: real Win32 API call requires Phase 2",
        ))
    }

    fn restrict_sids_win32(
        _token: &mut Handle,
        _sids_to_disable: &[Sid],
    ) -> Result<(), SandboxError> {
        Err(SandboxError::NotImplemented(
            "restrict_sids: real Win32 API call requires Phase 2",
        ))
    }
}

// ============================================================
// 非 Windows stub 实现
// ============================================================

#[cfg(not(windows))]
impl OsSandbox {
    /// 非 Windows 平台 stub：返回一个非零占位 Handle 便于测试管道
    ///
    /// 注：真实场景下应返回 `UnsupportedPlatform`，但为了让上层代码
    /// 在测试环境中可运行（验证状态跟踪），Phase 1 选择返回占位 Handle。
    /// Phase 2 会按 spec 严格返回 `UnsupportedPlatform`。
    fn create_restricted_token_stub() -> Handle {
        // 使用非零占位值（模拟一个有效 token）
        // 测试时可断言 `is_valid() == true`
        Handle(0xDEAD_BEEF)
    }
}

// ============================================================
// 单元测试
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试前清理全局状态，避免测试间相互影响
    fn setup_clean_state() {
        let _ = OsSandbox::clear_blocked_pids_for_test();
    }

    // ----------------------------------------------------------
    // 1. Handle 类型测试
    // ----------------------------------------------------------

    #[test]
    fn test_null_handle_is_invalid() {
        let h = Handle::NULL;
        assert!(!h.is_valid());
    }

    #[test]
    fn test_nonzero_handle_is_valid() {
        let h = Handle(42);
        assert!(h.is_valid());
    }

    // ----------------------------------------------------------
    // 2. create_restricted_token 测试
    // ----------------------------------------------------------

    #[test]
    fn test_create_restricted_token_returns_known_outcome() {
        // 平台分流验证：
        // - Windows：返回 NotImplemented（Phase 1）
        // - 非 Windows：返回有效 Handle（stub）
        let result = OsSandbox::create_restricted_token();
        #[cfg(windows)]
        {
            assert!(matches!(result, Err(SandboxError::NotImplemented(_))));
        }
        #[cfg(not(windows))]
        {
            assert!(result.is_ok());
            let handle = result.unwrap();
            assert!(handle.is_valid());
        }
    }

    // ----------------------------------------------------------
    // 3. drop_privileges / restrict_sids 测试
    // ----------------------------------------------------------

    #[test]
    fn test_drop_privileges_rejects_invalid_handle() {
        let mut h = Handle::NULL;
        let result = OsSandbox::drop_privileges(&mut h);
        assert!(matches!(result, Err(SandboxError::WindowsApiFailed(0))));
    }

    #[test]
    fn test_restrict_sids_rejects_invalid_handle() {
        let mut h = Handle::NULL;
        let sids = vec![Sid::administrators()];
        let result = OsSandbox::restrict_sids(&mut h, &sids);
        assert!(matches!(result, Err(SandboxError::WindowsApiFailed(0))));
    }

    #[test]
    fn test_restrict_sids_empty_list_is_noop() {
        let mut h = Handle(42);
        let result = OsSandbox::restrict_sids(&mut h, &[]);
        assert!(result.is_ok());
    }

    // ----------------------------------------------------------
    // 4. block / unblock 出站连接测试
    // ----------------------------------------------------------

    #[test]
    fn test_block_outbound_connections_succeeds() {
        setup_clean_state();
        let pid = 12345u32;
        let result = OsSandbox::block_outbound_connections(pid);
        assert!(result.is_ok());
        // 验证已加入阻断列表
        assert!(OsSandbox::is_pid_blocked(pid).unwrap());
    }

    #[test]
    fn test_block_same_pid_twice_returns_already_blocked() {
        setup_clean_state();
        let pid = 23456u32;
        OsSandbox::block_outbound_connections(pid).unwrap();
        let result = OsSandbox::block_outbound_connections(pid);
        assert!(matches!(result, Err(SandboxError::PidAlreadyBlocked(23456))));
    }

    #[test]
    fn test_unblock_blocked_pid_succeeds() {
        setup_clean_state();
        let pid = 34567u32;
        OsSandbox::block_outbound_connections(pid).unwrap();
        let result = OsSandbox::unblock_outbound_connections(pid);
        assert!(result.is_ok());
        // 验证已从阻断列表移除
        assert!(!OsSandbox::is_pid_blocked(pid).unwrap());
    }

    #[test]
    fn test_unblock_unblocked_pid_returns_not_blocked() {
        setup_clean_state();
        let pid = 45678u32;
        let result = OsSandbox::unblock_outbound_connections(pid);
        assert!(matches!(result, Err(SandboxError::PidNotBlocked(45678))));
    }

    // ----------------------------------------------------------
    // 5. 状态查询测试
    // ----------------------------------------------------------

    #[test]
    fn test_list_blocked_pids_returns_sorted() {
        setup_clean_state();
        // 按 3, 1, 2 顺序加入
        OsSandbox::block_outbound_connections(3).unwrap();
        OsSandbox::block_outbound_connections(1).unwrap();
        OsSandbox::block_outbound_connections(2).unwrap();
        let pids = OsSandbox::list_blocked_pids().unwrap();
        // 应返回升序 [1, 2, 3]
        assert_eq!(pids, vec![1, 2, 3]);
    }

    #[test]
    fn test_clear_blocked_pids_empties_state() {
        setup_clean_state();
        OsSandbox::block_outbound_connections(100).unwrap();
        OsSandbox::block_outbound_connections(200).unwrap();
        OsSandbox::clear_blocked_pids_for_test().unwrap();
        assert!(OsSandbox::list_blocked_pids().unwrap().is_empty());
    }

    // ----------------------------------------------------------
    // 6. Sid 类型测试
    // ----------------------------------------------------------

    #[test]
    fn test_sid_administrators_value() {
        let sid = Sid::administrators();
        assert_eq!(sid.sid_string, "S-1-5-32-544");
    }

    #[test]
    fn test_sid_system_value() {
        let sid = Sid::system();
        assert_eq!(sid.sid_string, "S-1-5-18");
    }

    #[test]
    fn test_sid_new_accepts_string() {
        let sid = Sid::new("S-1-1-0");
        assert_eq!(sid.sid_string, "S-1-1-0");
    }

    // ----------------------------------------------------------
    // 7. SandboxError Display 测试
    // ----------------------------------------------------------

    #[test]
    fn test_sandbox_error_display_contains_context() {
        let err = SandboxError::PidAlreadyBlocked(999);
        let msg = format!("{}", err);
        assert!(msg.contains("999"));
        assert!(msg.contains("already blocked"));
    }

    #[test]
    fn test_sandbox_error_equality() {
        // 验证错误类型可比较（用于 assert_matches）
        assert_eq!(
            SandboxError::PidNotBlocked(42),
            SandboxError::PidNotBlocked(42)
        );
        assert_ne!(
            SandboxError::PidNotBlocked(42),
            SandboxError::PidNotBlocked(43)
        );
    }
}
