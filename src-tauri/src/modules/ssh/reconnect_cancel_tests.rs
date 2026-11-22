use super::*;
use std::future::Future;
use std::sync::atomic::Ordering;
use std::task::{Context, Poll, Waker};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

struct AbortOnDrop<T>(tokio::task::JoinHandle<T>);

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn accept_ssh_banner(
    listener: &tokio::net::TcpListener,
) -> tokio::io::BufReader<tokio::net::TcpStream> {
    loop {
        let (stream, _) = listener.accept().await.expect("loopback accept failed");
        let mut stream = tokio::io::BufReader::new(stream);
        let mut banner = Vec::new();
        let read = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            stream.read_until(b'\n', &mut banner),
        )
        .await;
        if matches!(read, Ok(Ok(n)) if n > 0 && banner.starts_with(b"SSH-")) {
            return stream;
        }
    }
}

fn make_session() -> Arc<SshSession<tauri::test::MockRuntime>> {
    Arc::new(super::tests::make_test_session::<tauri::test::MockRuntime>(
        false, false,
    ))
}

fn poll_once<F: Future>(future: &mut std::pin::Pin<Box<F>>) -> Poll<F::Output> {
    let mut context = Context::from_waker(Waker::noop());
    future.as_mut().poll(&mut context)
}

fn reconnect_config(
    app_handle: tauri::AppHandle<tauri::test::MockRuntime>,
    states: Arc<std::sync::Mutex<Vec<String>>>,
) -> SshReconnectConfig<tauri::test::MockRuntime> {
    SshReconnectConfig {
        app_handle,
        params: SshConnectParams {
            host: "127.0.0.1".to_string(),
            port: 1,
            user: "test-user".to_string(),
            auth: crate::modules::ssh::SshAuthMethod::PublicKey {
                private_key_path: String::new(),
                passphrase: None,
            },
        },
        cols: 80,
        rows: 24,
        term: "xterm".to_string(),
        on_data: Channel::new(|_| Ok(())),
        on_status: Channel::<SshStatusEvent>::new(move |body| {
            let event = body.deserialize::<serde_json::Value>().unwrap();
            states
                .lock()
                .unwrap()
                .push(event["state"].as_str().unwrap().to_string());
            Ok(())
        }),
        on_exit: Channel::new(|_| Ok(())),
        on_reconnected: None,
    }
}

#[tokio::test]
async fn close_wakes_a_supervisor_that_is_already_waiting() {
    let session = make_session();
    let mut supervisor = Box::pin(SshSession::reconnect_supervisor(Arc::clone(&session)));

    assert!(matches!(poll_once(&mut supervisor), Poll::Pending));
    session
        .close()
        .await
        .expect("closing the test session should succeed");

    assert!(matches!(poll_once(&mut supervisor), Poll::Ready(())));
}

#[tokio::test]
async fn close_publishes_user_intent_before_waiting_for_channel_lock() {
    let session = make_session();
    let _channel_lock = session.channel_write.lock().await;
    let mut close = Box::pin(session.close());

    assert!(matches!(poll_once(&mut close), Poll::Pending));
    assert!(session.user_closed.load(Ordering::Acquire));
    assert!(session.connection_closed.load(Ordering::Acquire));
    assert_eq!(session.state(), SshSessionState::Closed);
}

#[tokio::test(start_paused = true)]
async fn close_cancels_a_supervisor_in_backoff_without_advancing_time() {
    let session = make_session();
    let app = tauri::test::mock_app();
    let states = Arc::new(std::sync::Mutex::new(Vec::new()));
    session
        .enable_reconnect(reconnect_config(app.handle().clone(), states))
        .await;
    session
        .exited
        .read()
        .unwrap()
        .store(true, Ordering::Release);
    let mut supervisor = tokio::spawn(SshSession::reconnect_supervisor(Arc::clone(&session)));
    tokio::task::yield_now().await;
    assert_eq!(session.state(), SshSessionState::Reconnecting);

    session
        .close()
        .await
        .expect("closing the test session should succeed");
    let stopped =
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut supervisor).await;

    assert!(stopped.is_ok(), "close waited for the reconnect backoff");
}

#[tokio::test(start_paused = true)]
async fn received_exit_with_config_does_not_start_reconnecting() {
    let session = make_session();
    let app = tauri::test::mock_app();
    let states = Arc::new(std::sync::Mutex::new(Vec::new()));
    session
        .enable_reconnect(reconnect_config(app.handle().clone(), Arc::clone(&states)))
        .await;
    session
        .exited
        .read()
        .unwrap()
        .store(true, Ordering::Release);
    session
        .received_exit
        .lock()
        .await
        .store(true, Ordering::Release);

    let stopped = tokio::time::timeout(
        std::time::Duration::from_millis(100),
        SshSession::reconnect_supervisor(Arc::clone(&session)),
    )
    .await;

    assert!(
        stopped.is_ok(),
        "normal shell exit should stop the supervisor"
    );
    let states = states.lock().unwrap();
    assert!(!states.contains(&"reconnecting".to_string()));
    assert!(!states.contains(&"connecting".to_string()));
}

#[tokio::test]
async fn closed_session_rejects_reconnected_resources_without_connected_event() {
    let session = make_session();
    let app = tauri::test::mock_app();
    let states = Arc::new(std::sync::Mutex::new(Vec::new()));
    let config = reconnect_config(app.handle().clone(), Arc::clone(&states));
    session
        .close()
        .await
        .expect("closing the test session should succeed");

    let result = session
        .adopt_reconnected_session(
            super::tests::make_test_session::<tauri::test::MockRuntime>(false, false),
            &config,
        )
        .await;

    assert!(result.is_err(), "closed session accepted a new connection");
    assert_eq!(session.state(), SshSessionState::Closed);
    assert!(!states.lock().unwrap().contains(&"connected".to_string()));
}

#[tokio::test]
async fn close_during_resource_callback_prevents_connected_state() {
    let session = make_session();
    let app = tauri::test::mock_app();
    let states = Arc::new(std::sync::Mutex::new(Vec::new()));
    let callback_entered = Arc::new(tokio::sync::Notify::new());
    let callback_release = Arc::new(tokio::sync::Notify::new());
    let mut config = reconnect_config(app.handle().clone(), Arc::clone(&states));
    let entered = Arc::clone(&callback_entered);
    let release = Arc::clone(&callback_release);
    config.on_reconnected = Some(Arc::new(move || {
        let entered = Arc::clone(&entered);
        let release = Arc::clone(&release);
        Box::pin(async move {
            entered.notify_one();
            release.notified().await;
        })
    }));
    let adopting_session = Arc::clone(&session);
    let mut adoption = tokio::spawn(async move {
        adopting_session
            .adopt_reconnected_session(
                super::tests::make_test_session::<tauri::test::MockRuntime>(false, false),
                &config,
            )
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        callback_entered.notified(),
    )
    .await
    .expect("adoption did not reach the resource callback");

    session
        .close()
        .await
        .expect("closing during resource adoption should succeed");
    callback_release.notify_one();
    let result = tokio::time::timeout(std::time::Duration::from_secs(1), &mut adoption)
        .await
        .expect("resource adoption did not finish")
        .expect("resource adoption task panicked");

    assert!(
        result.is_err(),
        "adoption ignored close during its callback"
    );
    assert_eq!(session.state(), SshSessionState::Closed);
    assert!(!states.lock().unwrap().contains(&"connected".to_string()));
}

#[tokio::test]
async fn successful_adoption_runs_callback_before_connected_and_keeps_new_reader() {
    let session = make_session();
    let new_session = super::tests::make_test_session::<tauri::test::MockRuntime>(false, false);
    let new_reader = new_session.exited.read().unwrap().clone();
    let callback_done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let connected_observed_callback = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut config = reconnect_config(
        tauri::test::mock_app().handle().clone(),
        Arc::new(std::sync::Mutex::new(Vec::new())),
    );
    let callback_done_by_callback = Arc::clone(&callback_done);
    config.on_reconnected = Some(Arc::new(move || {
        let done = Arc::clone(&callback_done_by_callback);
        Box::pin(async move {
            done.store(true, Ordering::Release);
        })
    }));
    let callback_done_by_channel = Arc::clone(&callback_done);
    let connected_observed_callback_for_channel = Arc::clone(&connected_observed_callback);
    config.on_status = Channel::<SshStatusEvent>::new(move |body| {
        let event = body.deserialize::<serde_json::Value>().unwrap();
        if event["state"] == "connected" {
            connected_observed_callback_for_channel.store(
                callback_done_by_channel.load(Ordering::Acquire),
                Ordering::Release,
            );
        }
        Ok(())
    });

    let result = session
        .adopt_reconnected_session(new_session, &config)
        .await;

    assert!(result.is_ok());
    assert_eq!(session.state(), SshSessionState::Connected);
    assert!(!session.is_pty_exited());
    drop(new_reader);
    assert!(connected_observed_callback.load(Ordering::Acquire));
}

#[tokio::test]
async fn refused_loopback_connection_exhausts_six_real_attempts_once() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("loopback listener should bind");
    let port = listener.local_addr().unwrap().port();
    let server = AbortOnDrop(tokio::spawn(async move {
        loop {
            let (socket, _) = listener.accept().await.expect("loopback accept failed");
            drop(socket);
        }
    }));

    let session = make_session();
    let app = tauri::test::mock_app();
    let states = Arc::new(std::sync::Mutex::new(Vec::new()));
    let attempts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut config = reconnect_config(app.handle().clone(), Arc::clone(&states));
    config.params.port = port;
    let recorded_states = Arc::clone(&states);
    let recorded_attempts = Arc::clone(&attempts);
    config.on_status = Channel::<SshStatusEvent>::new(move |body| {
        let event = body.deserialize::<serde_json::Value>().unwrap();
        let state = event["state"].as_str().unwrap().to_string();
        if state == "connecting" {
            recorded_attempts
                .lock()
                .unwrap()
                .push(tokio::time::Instant::now());
        }
        recorded_states.lock().unwrap().push(state);
        Ok(())
    });
    session.enable_reconnect(config).await;
    session
        .exited
        .read()
        .unwrap()
        .store(true, Ordering::Release);
    let started_at = tokio::time::Instant::now();
    let mut supervisor = tokio::spawn(SshSession::reconnect_supervisor(Arc::clone(&session)));
    let completion = tokio::time::timeout(std::time::Duration::from_secs(90), async {
        for (index, delay) in [1_u64, 2, 4, 8, 16, 30].into_iter().enumerate() {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(delay + 5);
            loop {
                let count = attempts.lock().unwrap().len();
                if count > index {
                    break;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "supervisor did not make real connection attempt {}",
                    index + 1
                );
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            let times = attempts.lock().unwrap();
            let current = times[index];
            let expected_delay = std::time::Duration::from_secs(if index == 0 { 1 } else { delay });
            let from = if index == 0 {
                started_at
            } else {
                times[index - 1]
            };
            assert!(
                current.duration_since(from) >= expected_delay,
                "attempt {} started before its backoff elapsed",
                index + 1
            );
            assert!(
                current.duration_since(from) <= expected_delay + std::time::Duration::from_secs(2),
                "attempt {} exceeded its backoff by more than connection setup",
                index + 1
            );
            drop(times);
        }
        while session.state() != SshSessionState::Failed {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        (&mut supervisor).await.expect("supervisor task panicked");
    })
    .await;
    if completion.is_err() {
        supervisor.abort();
    }
    completion.expect("real retry exhaustion exceeded its 90 second bound");

    let states = states.lock().unwrap();
    assert_eq!(
        states
            .iter()
            .filter(|state| state.as_str() == "connecting")
            .count(),
        6
    );
    assert_eq!(
        states
            .iter()
            .filter(|state| state.as_str() == "failed")
            .count(),
        1
    );
    assert_eq!(session.state(), SshSessionState::Failed);
    drop(states);
    server.0.abort();
}

#[tokio::test]
async fn close_cancels_a_real_loopback_ssh_handshake_that_stops_at_banner() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("loopback listener should bind");
    let port = listener.local_addr().unwrap().port();
    let (handshake_tx, handshake_rx) = tokio::sync::oneshot::channel();
    let server = AbortOnDrop(tokio::spawn(async move {
        let _stream = accept_ssh_banner(&listener).await;
        let _ = handshake_tx.send(());
        std::future::pending::<()>().await;
    }));

    let session = make_session();
    let app = tauri::test::mock_app();
    let states = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut config = reconnect_config(app.handle().clone(), states);
    config.params.port = port;
    session.enable_reconnect(config).await;
    session
        .exited
        .read()
        .unwrap()
        .store(true, Ordering::Release);
    let mut supervisor = tokio::spawn(SshSession::reconnect_supervisor(Arc::clone(&session)));

    tokio::time::timeout(std::time::Duration::from_secs(4), handshake_rx)
        .await
        .expect("reconnect did not reach the loopback SSH banner exchange")
        .expect("loopback fixture stopped before the handshake");
    session
        .close()
        .await
        .expect("closing during the handshake should succeed");
    tokio::time::timeout(std::time::Duration::from_millis(200), &mut supervisor)
        .await
        .expect("close did not cancel the pending SSH handshake")
        .expect("supervisor task panicked");

    server.0.abort();
}

#[tokio::test]
async fn aborting_real_client_handshake_closes_its_loopback_socket() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("loopback listener should bind");
    let port = listener.local_addr().unwrap().port();
    let (kex_tx, kex_rx) = tokio::sync::oneshot::channel();
    let mut server = AbortOnDrop(tokio::spawn(async move {
        let mut stream = accept_ssh_banner(&listener).await;
        stream
            .get_mut()
            .write_all(b"SSH-2.0-TdsfFixture\r\n")
            .await?;
        let mut kex_byte = [0_u8; 1];
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            stream.read(&mut kex_byte),
        )
        .await??;
        let _ = kex_tx.send(());
        let mut remainder = Vec::new();
        let read = tokio::time::timeout(
            std::time::Duration::from_millis(250),
            stream.read_to_end(&mut remainder),
        )
        .await;
        Ok::<_, std::io::Error>(
            matches!(read, Ok(Ok(_)))
                || matches!(
                    read,
                    Ok(Err(ref error))
                        if matches!(error.kind(), std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted)
                ),
        )
    }));

    let app = tauri::test::mock_app();
    let client = tokio::spawn(SshClient::<tauri::test::MockRuntime>::connect(
        app.handle().clone(),
        SshConnectParams {
            host: "127.0.0.1".to_string(),
            port,
            user: "test-user".to_string(),
            auth: crate::modules::ssh::SshAuthMethod::PublicKey {
                private_key_path: String::new(),
                passphrase: None,
            },
        },
        None,
    ));
    tokio::time::timeout(std::time::Duration::from_secs(3), kex_rx)
        .await
        .expect("client did not reach key exchange")
        .expect("server stopped before key exchange");
    client.abort();
    assert!(client.await.is_err(), "client task was not cancelled");
    let peer_closed = tokio::time::timeout(std::time::Duration::from_secs(1), &mut server.0)
        .await
        .expect("loopback peer socket stayed open after client cancellation")
        .expect("loopback server task panicked")
        .expect("loopback server socket read failed");
    assert!(peer_closed, "loopback peer socket did not observe EOF");
}
