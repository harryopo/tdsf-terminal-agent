use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::{AppHandle, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::header::{HOST, ORIGIN, SEC_WEBSOCKET_PROTOCOL};
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_hdr_async, WebSocketStream};
use uuid::Uuid;

use super::{
    remove_session, set_status, DesktopConnectParams, DesktopState, SessionHandle, SessionStatus,
};

const ACCEPT_TIMEOUT: Duration = Duration::from_secs(15);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const IO_BUFFER_SIZE: usize = 16 * 1024;

#[derive(Serialize)]
pub struct VncConnection {
    pub session_id: u32,
    pub websocket_url: String,
}

fn allowed_origin(origin: &str) -> bool {
    matches!(
        origin,
        "tauri://localhost"
            | "http://tauri.localhost"
            | "https://tauri.localhost"
            | "http://localhost:9300"
            | "http://127.0.0.1:9300"
    )
}

fn forbidden() -> ErrorResponse {
    let mut response = ErrorResponse::new(Some("forbidden VNC bridge request".to_string()));
    *response.status_mut() = StatusCode::FORBIDDEN;
    response
}

fn handshake_callback(
    ticket: &str,
    expected_host: &str,
) -> impl FnOnce(&Request, Response) -> Result<Response, ErrorResponse> {
    let expected_path = format!("/{ticket}");
    let expected_host = expected_host.to_string();
    move |request, mut response| {
        let host_valid = request
            .headers()
            .get(HOST)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|host| host == expected_host);
        let origin_valid = request
            .headers()
            .get(ORIGIN)
            .and_then(|value| value.to_str().ok())
            .is_some_and(allowed_origin);
        let binary_protocol = request
            .headers()
            .get(SEC_WEBSOCKET_PROTOCOL)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|protocols| {
                protocols
                    .split(',')
                    .any(|protocol| protocol.trim() == "binary")
            });
        if request.uri().path() != expected_path || !host_valid || !origin_valid || !binary_protocol
        {
            return Err(forbidden());
        }
        response
            .headers_mut()
            .insert(SEC_WEBSOCKET_PROTOCOL, HeaderValue::from_static("binary"));
        Ok(response)
    }
}

async fn accept_websocket(
    listener: TcpListener,
    ticket: String,
    expected_host: String,
    close_rx: &mut watch::Receiver<bool>,
) -> Result<Option<WebSocketStream<TcpStream>>, String> {
    let accepted = tokio::select! {
        _ = close_rx.changed() => return Ok(None),
        result = timeout(ACCEPT_TIMEOUT, listener.accept()) => result,
    };
    let (stream, _) = accepted
        .map_err(|_| "VNC bridge accept timed out".to_string())?
        .map_err(|err| format!("VNC bridge accept failed: {err}"))?;

    let websocket = tokio::select! {
        _ = close_rx.changed() => return Ok(None),
        result = timeout(
            HANDSHAKE_TIMEOUT,
            accept_hdr_async(stream, handshake_callback(&ticket, &expected_host)),
        ) => result,
    };
    let websocket = websocket
        .map_err(|_| "VNC bridge WebSocket handshake timed out".to_string())?
        .map_err(|err| format!("VNC bridge WebSocket handshake failed: {err}"))?;
    Ok(Some(websocket))
}

async fn relay<S, F>(
    websocket: WebSocketStream<S>,
    target_host: String,
    target_port: u16,
    close_rx: &mut watch::Receiver<bool>,
    on_target_connected: F,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    F: FnOnce(),
{
    let connected = tokio::select! {
        _ = close_rx.changed() => return Ok(()),
        result = timeout(CONNECT_TIMEOUT, TcpStream::connect((target_host.as_str(), target_port))) => result,
    };
    let target = connected
        .map_err(|_| "VNC target connection timed out".to_string())?
        .map_err(|err| format!("VNC target connection failed: {err}"))?;
    on_target_connected();

    let (mut target_read, mut target_write) = target.into_split();
    let (mut websocket_write, mut websocket_read) = websocket.split();
    let mut buffer = [0_u8; IO_BUFFER_SIZE];
    loop {
        tokio::select! {
            _ = close_rx.changed() => break,
            read = target_read.read(&mut buffer) => {
                let count = read.map_err(|err| format!("VNC target read failed: {err}"))?;
                if count == 0 {
                    break;
                }
                websocket_write
                    .send(Message::binary(buffer[..count].to_vec()))
                    .await
                    .map_err(|err| format!("VNC WebSocket write failed: {err}"))?;
            }
            message = websocket_read.next() => {
                match message {
                    None | Some(Ok(Message::Close(_))) => break,
                    Some(Ok(Message::Binary(payload))) => {
                        target_write
                            .write_all(&payload)
                            .await
                            .map_err(|err| format!("VNC target write failed: {err}"))?;
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        websocket_write
                            .send(Message::Pong(payload))
                            .await
                            .map_err(|err| format!("VNC WebSocket pong failed: {err}"))?;
                    }
                    Some(Ok(Message::Text(_))) => {
                        return Err("VNC bridge accepts binary frames only".to_string());
                    }
                    Some(Ok(_)) => {}
                    Some(Err(err)) => return Err(format!("VNC WebSocket read failed: {err}")),
                }
            }
        }
    }
    let _ = websocket_write.close().await;
    let _ = target_write.shutdown().await;
    Ok(())
}

async fn run_bridge<F>(
    listener: TcpListener,
    ticket: String,
    target_host: String,
    target_port: u16,
    mut close_rx: watch::Receiver<bool>,
    on_target_connected: F,
) -> Result<(), String>
where
    F: FnOnce(),
{
    let expected_host = listener
        .local_addr()
        .map_err(|err| format!("VNC bridge address unavailable: {err}"))?
        .to_string();
    let Some(websocket) = accept_websocket(listener, ticket, expected_host, &mut close_rx).await?
    else {
        return Ok(());
    };
    relay(
        websocket,
        target_host,
        target_port,
        &mut close_rx,
        on_target_connected,
    )
    .await
}

#[tauri::command]
pub async fn vnc_connect(
    app: AppHandle,
    state: State<'_, DesktopState>,
    params: DesktopConnectParams,
) -> Result<VncConnection, String> {
    if params.owner.trim().is_empty() || params.generation == 0 {
        return Err("VNC owner/generation is required".to_string());
    }
    if !matches!(params.host.as_str(), "127.0.0.1" | "localhost" | "::1") {
        return Err("VNC target must be loopback through an approved tunnel".to_string());
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|err| format!("VNC loopback listener failed: {err}"))?;
    let address = listener
        .local_addr()
        .map_err(|err| format!("VNC loopback address unavailable: {err}"))?;
    let ticket = Uuid::new_v4().simple().to_string();
    let websocket_url = format!("ws://{address}/{ticket}");
    let session_id = state.next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let (close_tx, close_rx) = watch::channel(false);
    state
        .sessions
        .lock()
        .map_err(|_| "desktop state poisoned".to_string())?
        .insert(
            session_id,
            SessionHandle {
                owner: params.owner,
                generation: params.generation,
                status: SessionStatus::Pending,
                error: None,
                input_tx: None,
                close_tx,
            },
        );

    let task_app = app.clone();
    tokio::spawn(async move {
        let connected_app = task_app.clone();
        let result = run_bridge(
            listener,
            ticket,
            params.host,
            params.port,
            close_rx,
            move || set_status(&connected_app, session_id, SessionStatus::Connected, None),
        )
        .await;
        match result {
            Ok(()) => {
                set_status(&task_app, session_id, SessionStatus::Closed, None);
                remove_session(&task_app, session_id);
            }
            Err(error) => {
                set_status(&task_app, session_id, SessionStatus::Failed, Some(error));
            }
        }
    });

    Ok(VncConnection {
        session_id,
        websocket_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::client_async;
    use tokio_tungstenite::tungstenite::handshake::client::Request as ClientRequest;
    use tokio_tungstenite::tungstenite::http::header::{
        CONNECTION, SEC_WEBSOCKET_KEY, SEC_WEBSOCKET_VERSION, UPGRADE,
    };

    fn request(path: &str, host: &str, origin: &str) -> Request {
        Request::builder()
            .uri(path)
            .header(HOST, host)
            .header(ORIGIN, origin)
            .header(SEC_WEBSOCKET_PROTOCOL, "binary")
            .body(())
            .expect("handshake request")
    }

    #[test]
    fn handshake_requires_ticket_loopback_host_trusted_origin_and_binary_protocol() {
        let valid = |path: &str, host: &str, origin: &str| {
            let request = request(path, host, origin);
            handshake_callback("secret", "127.0.0.1:1234")(&request, Response::new(()))
        };
        assert!(valid("/secret", "127.0.0.1:1234", "http://tauri.localhost").is_ok());
        assert!(valid("/secret", "127.0.0.1:1234", "http://127.0.0.1:9300").is_ok());
        for (path, host, origin) in [
            ("/wrong", "127.0.0.1:1234", "http://tauri.localhost"),
            ("/secret", "127.0.0.1:9999", "http://tauri.localhost"),
            ("/secret", "127.0.0.1:1234", "https://untrusted.invalid"),
        ] {
            let response = valid(path, host, origin).expect_err("request must be rejected");
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
    }

    fn client_request(address: &std::net::SocketAddr, ticket: &str) -> ClientRequest {
        ClientRequest::builder()
            .uri(format!("ws://{address}/{ticket}"))
            .header(HOST, address.to_string())
            .header(ORIGIN, "http://tauri.localhost")
            .header(CONNECTION, "Upgrade")
            .header(UPGRADE, "websocket")
            .header(SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==")
            .header(SEC_WEBSOCKET_VERSION, "13")
            .header(SEC_WEBSOCKET_PROTOCOL, "binary")
            .body(())
            .expect("client handshake request")
    }

    #[tokio::test]
    async fn relays_binary_bytes_in_both_directions_without_parsing_rfb() {
        timeout(Duration::from_secs(5), async {
            let target_listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("target listener");
            let target_address = target_listener.local_addr().expect("target address");
            let target = tokio::spawn(async move {
                let (mut stream, _) = target_listener.accept().await.expect("target accepted");
                stream
                    .write_all(b"RFB 003.008\n")
                    .await
                    .expect("write banner");
                let mut received = [0_u8; 4];
                stream
                    .read_exact(&mut received)
                    .await
                    .expect("read client bytes");
                received
            });

            let bridge_listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bridge listener");
            let bridge_address = bridge_listener.local_addr().expect("bridge address");
            let (_close_tx, close_rx) = watch::channel(false);
            let bridge = tokio::spawn(run_bridge(
                bridge_listener,
                "secret".to_string(),
                target_address.ip().to_string(),
                target_address.port(),
                close_rx,
                || {},
            ));

            let stream = TcpStream::connect(bridge_address)
                .await
                .expect("connect bridge");
            let (mut websocket, response) =
                client_async(client_request(&bridge_address, "secret"), stream)
                    .await
                    .expect("WebSocket handshake");
            assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
            let banner = websocket
                .next()
                .await
                .expect("banner frame")
                .expect("banner result");
            match banner {
                Message::Binary(payload) => assert_eq!(payload.as_ref(), b"RFB 003.008\n"),
                _ => panic!("expected binary RFB banner"),
            }

            websocket
                .send(Message::binary(vec![1_u8, 2, 3, 4]))
                .await
                .expect("send client bytes");
            assert_eq!(target.await.expect("join target"), [1, 2, 3, 4]);
            bridge
                .await
                .expect("join bridge")
                .expect("clean relay shutdown");
        })
        .await
        .expect("VNC relay test timed out");
    }

    #[tokio::test]
    async fn close_reclaims_a_bridge_that_is_still_waiting_for_a_client() {
        timeout(Duration::from_secs(5), async {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bridge listener");
            let address = listener.local_addr().expect("bridge address");
            let (close_tx, close_rx) = watch::channel(false);
            let bridge = tokio::spawn(run_bridge(
                listener,
                "secret".to_string(),
                "127.0.0.1".to_string(),
                5900,
                close_rx,
                || {},
            ));
            close_tx.send(true).expect("close bridge");
            bridge.await.expect("join bridge").expect("close is clean");
            assert!(
                TcpStream::connect(address).await.is_err(),
                "listener must be reclaimed"
            );
        })
        .await
        .expect("VNC close test timed out");
    }

    #[tokio::test]
    async fn ten_pending_connect_close_cycles_reclaim_every_listener() {
        for round in 0..10 {
            timeout(Duration::from_secs(5), async {
                let listener = TcpListener::bind("127.0.0.1:0")
                    .await
                    .expect("bridge listener");
                let address = listener.local_addr().expect("bridge address");
                let (close_tx, close_rx) = watch::channel(false);
                let bridge = tokio::spawn(run_bridge(
                    listener,
                    format!("secret-{round}"),
                    "127.0.0.1".to_string(),
                    5900,
                    close_rx,
                    || {},
                ));
                close_tx.send(true).expect("close bridge");
                bridge.await.expect("join bridge").expect("close is clean");
                assert!(
                    TcpStream::connect(address).await.is_err(),
                    "round {round} left a listener behind"
                );
            })
            .await
            .expect("VNC repeated close test timed out");
        }
    }
}