//! 远程桌面（RDP）会话：IronRDP + Tauri 事件推送。
//!
//! 产品内最小闭环：
//! - `desktop_connect`：创建会话线程，连接 xrdp/RDP，逐帧推送 RGBA（base64）。
//! - `desktop_input`：键盘/鼠标事件转发。
//! - `desktop_close`：关闭会话。
//!
//! 说明：
//! - RdpClient::run 的 future 不是 Send，不能放进 tokio::spawn；用专用线程 +
//!   current-thread runtime（并加大栈，重连/大帧时 8MB 不够）。
//! - 凭据由前端传入，不落盘、不打印；后续应改为 secrets 引用。
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine as _;
use ironrdp_client::config::{ConfigBuilder, Destination};
use ironrdp_client::output_channel::output_channel;
use ironrdp_client::rdp::{RdpClient, RdpInputEvent, RdpOutputEvent};
use ironrdp_pdu::input::fast_path::{FastPathInputEvent, KeyboardFlags};
use ironrdp_pdu::input::mouse::{MousePdu, PointerFlags};
use serde::{Deserialize, Serialize};
use smallvec::smallvec;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, watch};

#[derive(Default)]
pub struct DesktopState {
    sessions: Mutex<HashMap<u32, SessionHandle>>,
    next_id: AtomicU32,
}

struct SessionHandle {
    input_tx: mpsc::Sender<RdpInputEvent>,
    close_tx: watch::Sender<bool>,
}

#[derive(Debug, Deserialize)]
pub struct DesktopConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

#[derive(Clone, Serialize)]
pub struct DesktopFrameEvent {
    pub session_id: u32,
    pub width: u16,
    pub height: u16,
    /// RGBA8888，base64。
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
        buttons: u8,
        down: bool,
    },
}

fn emit_error(app: &AppHandle, session_id: u32, message: impl Into<String>) {
    let _ = app.emit(
        "desktop-error",
        serde_json::json!({ "session_id": session_id, "message": message.into() }),
    );
}

async fn run_session(
    app: AppHandle,
    session_id: u32,
    params: DesktopConnectParams,
    mut input_rx: mpsc::Receiver<RdpInputEvent>,
    mut close_rx: watch::Receiver<bool>,
) -> Result<(), String> {
    let config = ConfigBuilder::new()
        .with_destination(Destination::from_parts(params.host, params.port))
        .with_username(params.username)
        .with_password(params.password)
        .with_platform(ironrdp_pdu::rdp::capability_sets::MajorPlatformType::WINDOWS)
        .with_client_name("tdsf-terminal-agent")
        .with_client_dir("")
        .with_client_build(0)
        .build()
        .map_err(|err| err.to_string())?;

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
                    let _ = input.try_send(event);
                }
            }
            event = receiver.recv() => {
                match event {
                    None => return Ok(()),
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
                        let _ = app.emit(
                            "desktop-frame",
                            DesktopFrameEvent {
                                session_id,
                                width: width.get(),
                                height: height.get(),
                                rgba_base64: encoded,
                            },
                        );
                    }
                    Some(RdpOutputEvent::ConnectionFailure(err)) => {
                        emit_error(&app, session_id, err.to_string());
                        return Err(err.to_string());
                    }
                    Some(_) => {}
                }
            }
        }
    }
}

/// 建立远程桌面会话，返回 session_id。
#[tauri::command]
pub async fn desktop_connect(
    app: AppHandle,
    state: State<'_, DesktopState>,
    params: DesktopConnectParams,
) -> Result<u32, String> {
    let session_id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    let (input_tx, input_rx) = mpsc::channel(64);
    let (close_tx, close_rx) = watch::channel(false);

    state
        .sessions
        .lock()
        .map_err(|_| "desktop state poisoned".to_string())?
        .insert(
            session_id,
            SessionHandle {
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
                    emit_error(&thread_app, session_id, err.to_string());
                    return;
                }
            };

            if let Err(err) = runtime.block_on(run_session(
                thread_app.clone(),
                session_id,
                params,
                input_rx,
                close_rx,
            )) {
                emit_error(&thread_app, session_id, err);
            }

            if let Some(state) = thread_app.try_state::<DesktopState>() {
                if let Ok(mut sessions) = state.sessions.lock() {
                    sessions.remove(&session_id);
                }
            }
        })
        .map_err(|err| err.to_string())?;

    Ok(session_id)
}

/// 转发键盘/鼠标事件到指定会话。
#[tauri::command]
pub fn desktop_input(
    state: State<'_, DesktopState>,
    session_id: u32,
    event: DesktopInputEvent,
) -> Result<(), String> {
    let sender = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "desktop state poisoned".to_string())?;
        sessions
            .get(&session_id)
            .map(|handle| handle.input_tx.clone())
            .ok_or_else(|| format!("desktop session {session_id} not found"))?
    };

    match event {
        DesktopInputEvent::Unicode { text } => {
            for ch in text.chars() {
                let pressed = RdpInputEvent::FastPath(smallvec![
                    FastPathInputEvent::UnicodeKeyboardEvent(
                        KeyboardFlags::empty(),
                        ch as u16
                    )
                ]);
                let released = RdpInputEvent::FastPath(smallvec![
                    FastPathInputEvent::UnicodeKeyboardEvent(
                        KeyboardFlags::RELEASE,
                        ch as u16
                    )
                ]);
                let _ = sender.try_send(pressed);
                let _ = sender.try_send(released);
            }
        }
        DesktopInputEvent::Key { code, pressed } => {
            let flags = if pressed {
                KeyboardFlags::empty()
            } else {
                KeyboardFlags::RELEASE
            };
            let _ = sender.try_send(RdpInputEvent::FastPath(smallvec![
                FastPathInputEvent::KeyboardEvent(flags, code)
            ]));
        }
        DesktopInputEvent::Mouse {
            x,
            y,
            buttons,
            down,
        } => {
            let mut flags = PointerFlags::MOVE;
            if buttons & 1 != 0 {
                flags |= PointerFlags::LEFT_BUTTON;
            }
            if buttons & 2 != 0 {
                flags |= PointerFlags::RIGHT_BUTTON;
            }
            if buttons & 4 != 0 {
                flags |= PointerFlags::MIDDLE_BUTTON_OR_WHEEL;
            }
            if down {
                flags |= PointerFlags::DOWN;
            }
            let _ = sender.try_send(RdpInputEvent::FastPath(smallvec![
                FastPathInputEvent::MouseEvent(MousePdu {
                    flags,
                    number_of_wheel_rotation_units: 0,
                    x_position: x,
                    y_position: y,
                })
            ]));
        }
    }

    Ok(())
}

/// 关闭远程桌面会话。
#[tauri::command]
pub fn desktop_close(state: State<'_, DesktopState>, session_id: u32) -> Result<(), String> {
    let close_tx = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "desktop state poisoned".to_string())?;
        sessions
            .get(&session_id)
            .map(|handle| handle.close_tx.clone())
            .ok_or_else(|| format!("desktop session {session_id} not found"))?
    };

    let _ = close_tx.send(true);
    // 给会话线程一个短暂窗口自行清理；句柄由线程结束时移除。
    std::thread::sleep(Duration::from_millis(20));
    Ok(())
}

/// 等待会话关闭（供测试/后续健康检查使用）。
pub async fn wait_closed(state: &DesktopState, session_id: u32) {
    loop {
        let alive = state
            .sessions
            .lock()
            .map(|sessions| sessions.contains_key(&session_id))
            .unwrap_or(false);
        if !alive {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}