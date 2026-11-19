//! 远程桌面（RDP）会话：IronRDP + 定向 Channel 帧 + 身份校验。
//!
//! 按 ROOT 复审要求收口：
//! - 显式 `CertificateValidation::Strict`，可配证书指纹例外；不再 accept-all。
//! - `owner + generation + session_id` 绑定；输入/关闭/状态查询均校验身份。
//! - 连接状态由真实后端事件驱动（Pending/Connected/Failed/Closed），支持 Pending 取消。
//! - 画面通过调用方 `Channel` 定向传输，不用全局事件广播。
//! - 输入有序背压，不丢 key-up/鼠标释放；非 BMP 字符用 UTF-16 code units。
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use ironrdp_client::config::{ConfigBuilder, Destination};
use ironrdp_client::output_channel::output_channel;
use ironrdp_client::rdp::{RdpClient, RdpInputEvent, RdpOutputEvent};
use ironrdp_pdu::input::fast_path::{FastPathInputEvent, KeyboardFlags};
use ironrdp_pdu::input::mouse::{MousePdu, PointerFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use smallvec::smallvec;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::sync::{mpsc, watch};

const INPUT_QUEUE_CAPACITY: usize = 32;
const INPUT_SEND_TIMEOUT_MS: u64 = 100;

#[derive(Default)]
pub struct DesktopState {
    sessions: Mutex<HashMap<u32, SessionHandle>>,
    next_id: AtomicU32,
}

struct SessionHandle {
    owner: String,
    generation: u64,
    status: SessionStatus,
    error: Option<String>,
    input_tx: mpsc::Sender<RdpInputEvent>,
    close_tx: watch::Sender<bool>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Pending,
    Connected,
    Failed,
    Closed,
}

#[derive(Clone, Serialize)]
pub struct SessionStatusInfo {
    pub status: SessionStatus,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DesktopConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    /// 调用窗口标识（不由远端生成）。
    pub owner: String,
    /// 调用代次，防止旧窗口/旧代次误操作。
    pub generation: u64,
    /// 可选：自签证书 SHA-256 指纹（hex，可含冒号/空格）。
    pub certificate_fingerprint: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct DesktopFrameEvent {
    pub session_id: u32,
    pub width: u16,
    pub height: u16,
    pub rgba_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DesktopInputEvent {
    Unicode { text: String },
    Key { code: u8, pressed: bool },
    Mouse {
        x: u16,
        y: u16,
        /// 1 左键、2 右键、3 中键、0 无按钮（hover）。
        button: u8,
        down: bool,
    },
    Wheel { x: u16, y: u16, delta: i16 },
}

fn fingerprint_hex(der: &[u8]) -> String {
    let digest = Sha256::digest(der);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn normalize_fingerprint(input: &str) -> String {
    input
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn map_mouse(x: u16, y: u16, button: u8, down: bool) -> RdpInputEvent {
    let mut flags = PointerFlags::MOVE;
    match button {
        1 => flags |= PointerFlags::LEFT_BUTTON,
        2 => flags |= PointerFlags::RIGHT_BUTTON,
        3 => flags |= PointerFlags::MIDDLE_BUTTON_OR_WHEEL,
        _ => {}
    }
    if down {
        flags |= PointerFlags::DOWN;
    }
    RdpInputEvent::FastPath(smallvec![FastPathInputEvent::MouseEvent(MousePdu {
        flags,
        number_of_wheel_rotation_units: 0,
        x_position: x,
        y_position: y,
    })])
}

fn unicode_events(text: &str) -> Vec<RdpInputEvent> {
    let mut events = Vec::new();
    for ch in text.chars() {
        let mut units = [0u16; 2];
        let encoded = ch.encode_utf16(&mut units);
        for unit in encoded.iter() {
            events.push(RdpInputEvent::FastPath(smallvec![
                FastPathInputEvent::UnicodeKeyboardEvent(KeyboardFlags::empty(), *unit)
            ]));
            events.push(RdpInputEvent::FastPath(smallvec![
                FastPathInputEvent::UnicodeKeyboardEvent(KeyboardFlags::RELEASE, *unit)
            ]));
        }
    }
    events
}

fn session_sender(
    state: &DesktopState,
    session_id: u32,
    owner: &str,
    generation: u64,
) -> Result<mpsc::Sender<RdpInputEvent>, String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "desktop state poisoned".to_string())?;
    let handle = sessions
        .get(&session_id)
        .ok_or_else(|| format!("desktop session {session_id} not found"))?;
    if handle.owner != owner || handle.generation != generation {
        return Err("desktop session owner/generation mismatch".to_string());
    }
    if handle.status == SessionStatus::Closed {
        return Err("desktop session is closed".to_string());
    }
    Ok(handle.input_tx.clone())
}

fn set_status(app: &AppHandle, session_id: u32, status: SessionStatus, error: Option<String>) {
    if let Some(state) = app.try_state::<DesktopState>() {
        if let Ok(mut sessions) = state.sessions.lock() {
            if let Some(handle) = sessions.get_mut(&session_id) {
                handle.status = status;
                handle.error = error;
            }
        }
    }
}

fn remove_session(app: &AppHandle, session_id: u32) {
    if let Some(state) = app.try_state::<DesktopState>() {
        if let Ok(mut sessions) = state.sessions.lock() {
            sessions.remove(&session_id);
        }
    }
}

async fn send_event(
    sender: &mpsc::Sender<RdpInputEvent>,
    event: RdpInputEvent,
) -> Result<(), String> {
    tokio::time::timeout(
        Duration::from_millis(INPUT_SEND_TIMEOUT_MS),
        sender.send(event),
    )
    .await
    .map_err(|_| "desktop input queue is full".to_string())
    .and_then(|res| res.map_err(|_| "desktop input channel closed".to_string()))
}

async fn run_session(
    app: AppHandle,
    session_id: u32,
    params: DesktopConnectParams,
    on_frame: Channel<DesktopFrameEvent>,
    mut input_rx: mpsc::Receiver<RdpInputEvent>,
    mut close_rx: watch::Receiver<bool>,
) -> Result<(), String> {
    let expected_fingerprint = params
        .certificate_fingerprint
        .as_deref()
        .map(normalize_fingerprint)
        .filter(|fp| !fp.is_empty());

    let mut builder = ConfigBuilder::new()
        .with_destination(Destination::from_parts(params.host, params.port))
        .with_username(params.username)
        .with_password(params.password)
        .with_platform(ironrdp_pdu::rdp::capability_sets::MajorPlatformType::WINDOWS)
        .with_client_name("tdsf-terminal-agent")
        .with_client_dir("")
        .with_client_build(0)
        // ROOT: 显式可信 TLS，不用默认 accept-all。
        .with_certificate_validation(ironrdp_tls::CertificateValidation::Strict);

    if let Some(expected) = expected_fingerprint {
        builder = builder.with_certificate_validation_callback(Arc::new(
            move |der, _endpoint, _error| {
                // 仅在指纹与显式信任值一致时放行自签证书；不匹配即拒绝。
                normalize_fingerprint(&fingerprint_hex(der)) == expected
            },
        ));
    }

    let config = builder.build().map_err(|err| err.to_string())?;
    let (sender, mut receiver) = output_channel(64);
    let client = RdpClient::new(config, sender);
    let input = client.input_sender();
    let mut run_fut = Box::pin(client.run());

    loop {
        tokio::select! {
            _ = &mut run_fut => {
                return Ok(());
            }
            changed = close_rx.changed() => {
                if changed.is_ok() && *close_rx.borrow() {
                    return Ok(());
                }
            }
            maybe_input = input_rx.recv() => {
                if let Some(event) = maybe_input {
                    // 有序背压由 desktop_input 的 send 控制；满队列显式失败，不静默丢键释放。
                    input
                        .try_send(event)
                        .map_err(|err| format!("rdp input queue full: {err:?}"))?;
                }
            }
            event = receiver.recv() => {
                match event {
                    None => return Ok(()),
                    Some(RdpOutputEvent::Connected) => {
                        set_status(&app, session_id, SessionStatus::Connected, None);
                    }
                    Some(RdpOutputEvent::Image { buffer, width, height }) => {
                        let mut rgba = Vec::with_capacity(buffer.len() * 4);
                        for px in buffer {
                            rgba.extend_from_slice(&[
                                (px & 0xFF) as u8,
                                ((px >> 8) & 0xFF) as u8,
                                ((px >> 16) & 0xFF) as u8,
                                0xFF,
                            ]);
                        }
                        let encoded = base64::engine::general_purpose::STANDARD.encode(rgba);
                        on_frame
                            .send(DesktopFrameEvent {
                                session_id,
                                width: width.get(),
                                height: height.get(),
                                rgba_base64: encoded,
                            })
                            .map_err(|err| err.to_string())?;
                        if let Some(state) = app.try_state::<DesktopState>() {
                            if let Ok(mut sessions) = state.sessions.lock() {
                                if let Some(handle) = sessions.get_mut(&session_id) {
                                    if handle.status == SessionStatus::Pending {
                                        handle.status = SessionStatus::Connected;
                                    }
                                }
                            }
                        }
                    }
                    Some(RdpOutputEvent::ConnectionFailure(err)) => {
                        let message = err.to_string();
                        set_status(&app, session_id, SessionStatus::Failed, Some(message.clone()));
                        return Err(message);
                    }
                    Some(_) => {}
                }
            }
        }
    }
}

/// 建立远程桌面会话。返回的 id 仅表示已排队，不等于已连接。
#[tauri::command]
pub async fn desktop_connect(
    app: AppHandle,
    state: State<'_, DesktopState>,
    params: DesktopConnectParams,
    on_frame: Channel<DesktopFrameEvent>,
) -> Result<u32, String> {
    if params.owner.trim().is_empty() {
        return Err("desktop owner is required".to_string());
    }
    if params.generation == 0 {
        return Err("desktop generation must be positive".to_string());
    }

    let session_id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    let (input_tx, input_rx) = mpsc::channel(INPUT_QUEUE_CAPACITY);
    let (close_tx, close_rx) = watch::channel(false);

    state
        .sessions
        .lock()
        .map_err(|_| "desktop state poisoned".to_string())?
        .insert(
            session_id,
            SessionHandle {
                owner: params.owner.clone(),
                generation: params.generation,
                status: SessionStatus::Pending,
                error: None,
                input_tx,
                close_tx,
            },
        );

    let thread_app = app.clone();
    std::thread::Builder::new()
        .name(format!("tdsf-rdp-{session_id}"))
        .stack_size(64 * 1024 * 1024)
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(err) => {
                    set_status(&thread_app, session_id, SessionStatus::Failed, Some(err.to_string()));
                    remove_session(&thread_app, session_id);
                    return;
                }
            };

            if let Err(err) = runtime.block_on(run_session(
                thread_app.clone(),
                session_id,
                params,
                on_frame,
                input_rx,
                close_rx,
            )) {
                set_status(&thread_app, session_id, SessionStatus::Failed, Some(err));
            } else {
                set_status(&thread_app, session_id, SessionStatus::Closed, None);
            }
            remove_session(&thread_app, session_id);
        })
        .map_err(|err| err.to_string())?;

    Ok(session_id)
}

/// 转发键盘/鼠标/滚轮事件，身份校验 + 有序背压。
#[tauri::command]
pub async fn desktop_input(
    state: State<'_, DesktopState>,
    session_id: u32,
    owner: String,
    generation: u64,
    event: DesktopInputEvent,
) -> Result<(), String> {
    let sender = session_sender(&state, session_id, &owner, generation)?;
    match event {
        DesktopInputEvent::Unicode { text } => {
            for event in unicode_events(&text) {
                send_event(&sender, event).await?;
            }
        }
        DesktopInputEvent::Key { code, pressed } => {
            let flags = if pressed {
                KeyboardFlags::empty()
            } else {
                KeyboardFlags::RELEASE
            };
            send_event(
                &sender,
                RdpInputEvent::FastPath(smallvec![FastPathInputEvent::KeyboardEvent(flags, code)]),
            )
            .await?;
        }
        DesktopInputEvent::Mouse {
            x,
            y,
            button,
            down,
        } => {
            send_event(&sender, map_mouse(x, y, button, down)).await?;
        }
        DesktopInputEvent::Wheel { x, y, delta } => {
            let mut flags = PointerFlags::VERTICAL_WHEEL;
            if delta < 0 {
                flags |= PointerFlags::WHEEL_NEGATIVE;
            }
            send_event(
                &sender,
                RdpInputEvent::FastPath(smallvec![FastPathInputEvent::MouseEvent(MousePdu {
                    flags,
                    number_of_wheel_rotation_units: delta,
                    x_position: x,
                    y_position: y,
                })]),
            )
            .await?;
        }
    }
    Ok(())
}

/// 关闭会话（支持 Pending 取消；关闭后旧画面/输入失效）。
#[tauri::command]
pub async fn desktop_close(
    state: State<'_, DesktopState>,
    session_id: u32,
    owner: String,
    generation: u64,
) -> Result<(), String> {
    let close_tx = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "desktop state poisoned".to_string())?;
        let handle = sessions
            .get(&session_id)
            .ok_or_else(|| format!("desktop session {session_id} not found"))?;
        if handle.owner != owner || handle.generation != generation {
            return Err("desktop session owner/generation mismatch".to_string());
        }
        handle.close_tx.clone()
    };

    let _ = close_tx.send(true);
    let app = state
        .sessions
        .lock()
        .map_err(|_| "desktop state poisoned".to_string())?;
    drop(app);
    Ok(())
}

/// 查询真实会话状态（由后端事件驱动，不由 connect 返回值推断）。
#[tauri::command]
pub fn desktop_status(
    state: State<'_, DesktopState>,
    session_id: u32,
    owner: String,
    generation: u64,
) -> Result<SessionStatusInfo, String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "desktop state poisoned".to_string())?;
    match sessions.get(&session_id) {
        Some(handle) => {
            if handle.owner != owner || handle.generation != generation {
                return Err("desktop session owner/generation mismatch".to_string());
            }
            Ok(SessionStatusInfo {
                status: handle.status,
                error: handle.error.clone(),
            })
        }
        None => Ok(SessionStatusInfo {
            status: SessionStatus::Closed,
            error: Some("session not found".to_string()),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mouse_release_keeps_button_identity() {
        let event = map_mouse(10, 20, 1, false);
        match event {
            RdpInputEvent::FastPath(events) => match &events[0] {
                FastPathInputEvent::MouseEvent(pdu) => {
                    assert!(pdu.flags.contains(PointerFlags::LEFT_BUTTON));
                    assert!(!pdu.flags.contains(PointerFlags::DOWN));
                    assert_eq!(pdu.x_position, 10);
                    assert_eq!(pdu.y_position, 20);
                }
                _ => panic!("unexpected event"),
            },
            _ => panic!("unexpected variant"),
        }
    }

    #[test]
    fn non_bmp_unicode_uses_utf16_code_units() {
        let events = unicode_events("A😀");
        // A: press+release；😀: surrogate pair，各 press+release
        assert_eq!(events.len(), 6);
    }

    #[test]
    fn fingerprint_is_normalized() {
        assert_eq!(normalize_fingerprint("AB:cd-ef"), "abcdef");
    }

    #[test]
    fn owner_and_generation_are_enforced() {
        let state = DesktopState::default();
        let (tx, _rx) = mpsc::channel(2);
        let (close_tx, _close_rx) = watch::channel(false);
        state.sessions.lock().unwrap().insert(
            7,
            SessionHandle {
                owner: "window-1".into(),
                generation: 3,
                status: SessionStatus::Pending,
                error: None,
                input_tx: tx,
                close_tx,
            },
        );
        assert!(session_sender(&state, 7, "window-1", 3).is_ok());
        assert!(session_sender(&state, 7, "window-2", 3).is_err());
        assert!(session_sender(&state, 7, "window-1", 4).is_err());
        assert!(session_sender(&state, 99, "window-1", 3).is_err());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn saturated_input_queue_returns_error() {
        let (tx, rx) = mpsc::channel(1);
        let first = map_mouse(0, 0, 0, false);
        tx.send(first).await.expect("first send");
        let second = map_mouse(0, 0, 0, false);
        let result = send_event(&tx, second).await;
        assert!(result.is_err());
        drop(rx);
    }
}