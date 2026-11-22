use super::*;

const BUDGET: Duration = Duration::from_secs(600);

fn signal(id: i64, seq: u64, phase: &str) -> Value {
    json!({"jsonrpc": "2.0", "method": AGENT_RPC_LIVENESS,
        "params": {"schema_version": 1, "rpc_request_id": id, "seq": seq, "phase": phase}})
}

async fn start_request(
    method: &str,
) -> (
    SidecarManager,
    i64,
    tokio::task::JoinHandle<SidecarResult<Value>>,
) {
    let manager = SidecarManager::new(PathBuf::from("unused-test-sidecar.py"));
    let (tx, mut rx) = tokio::sync::mpsc::channel(4);
    *manager.stdin_tx.lock().await = Some(tx);
    let sender = manager.clone();
    let method = method.to_owned();
    let task = tokio::spawn(async move {
        sender
            .send_request_with_timeout(&method, json!({}), BUDGET)
            .await
    });
    let wire: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
    tokio::task::yield_now().await;
    (manager, wire["id"].as_i64().unwrap(), task)
}

async fn deliver(manager: &SidecarManager, msg: Value) -> bool {
    handle_rpc_liveness(&msg, &mut *manager.pending_requests.lock().await)
}

async fn finish(manager: &SidecarManager, id: i64, result: Value) {
    let request = manager.pending_requests.lock().await.remove(&id).unwrap();
    request.response.send(result).unwrap();
}

#[tokio::test(start_paused = true)]
async fn real_manager_keeps_a_live_invoke_past_the_old_total_limit() {
    let (manager, id, task) = start_request("agent.invoke").await;
    for seq in 1..=3 {
        tokio::time::advance(Duration::from_secs(250)).await;
        let phase = if seq == 2 { "waiting_user" } else { "working" };
        assert!(deliver(&manager, signal(id, seq, phase)).await);
        tokio::task::yield_now().await;
        assert!(
            !task.is_finished(),
            "active request was cut off by total duration"
        );
    }
    let response = json!({"id": id, "result": {"output": "done"}});
    finish(&manager, id, response.clone()).await;
    assert_eq!(task.await.unwrap().unwrap(), response);
    assert!(manager.pending_requests.lock().await.is_empty());
}

#[tokio::test(start_paused = true)]
async fn missing_liveness_expires_and_retired_id_cannot_renew() {
    let (manager, id, task) = start_request("agent.invoke").await;
    tokio::time::advance(BUDGET + Duration::from_secs(1)).await;
    assert!(matches!(task.await.unwrap(), Err(SidecarError::RequestTimeout(d)) if d == BUDGET));
    assert!(manager.pending_requests.lock().await.is_empty());
    assert!(!deliver(&manager, signal(id, 1, "working")).await);
}

#[tokio::test(start_paused = true)]
async fn ordinary_rpc_keeps_absolute_timeout_even_with_valid_looking_signals() {
    let (manager, id, task) = start_request("knowledge.search").await;
    tokio::time::advance(Duration::from_secs(500)).await;
    assert!(!deliver(&manager, signal(id, 1, "working")).await);
    tokio::time::advance(Duration::from_secs(101)).await;
    assert!(matches!(
        task.await.unwrap(),
        Err(SidecarError::RequestTimeout(_))
    ));
    assert!(manager.pending_requests.lock().await.is_empty());
}

#[tokio::test(start_paused = true)]
async fn wrong_request_and_ordinary_notifications_do_not_renew() {
    let (manager, id, task) = start_request("agent.invoke").await;
    tokio::time::advance(Duration::from_secs(500)).await;
    assert!(!deliver(&manager, signal(id + 1, 1, "working")).await);
    let mut ping = signal(id, 1, "working");
    ping["method"] = json!("ping");
    assert!(!deliver(&manager, ping).await);
    tokio::time::advance(Duration::from_secs(101)).await;
    assert!(matches!(
        task.await.unwrap(),
        Err(SidecarError::RequestTimeout(_))
    ));
}

#[tokio::test(start_paused = true)]
async fn replayed_or_reordered_sequence_cannot_extend_the_budget() {
    let (manager, id, task) = start_request("agent.invoke").await;
    tokio::time::advance(Duration::from_secs(500)).await;
    assert!(deliver(&manager, signal(id, 2, "working")).await);
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(599)).await;
    assert!(!deliver(&manager, signal(id, 2, "waiting_user")).await);
    assert!(!deliver(&manager, signal(id, 1, "working")).await);
    tokio::time::advance(Duration::from_secs(2)).await;
    assert!(matches!(
        task.await.unwrap(),
        Err(SidecarError::RequestTimeout(_))
    ));
}

#[tokio::test(start_paused = true)]
async fn malformed_signals_are_rejected_before_they_touch_a_live_request() {
    let (manager, id, task) = start_request("agent.invoke").await;
    for (field, values) in [
        (
            "schema_version",
            vec![json!(true), json!("1"), json!(1.0), json!(2), Value::Null],
        ),
        (
            "rpc_request_id",
            vec![
                json!(true),
                json!("1"),
                json!(1.0),
                json!(-1),
                json!(u64::MAX),
                Value::Null,
            ],
        ),
        (
            "seq",
            vec![
                json!(true),
                json!("1"),
                json!(1.0),
                json!(-1),
                json!(0),
                Value::Null,
            ],
        ),
        ("phase", vec![json!("done"), json!(true), Value::Null]),
    ] {
        for value in values {
            let mut msg = signal(id, 1, "working");
            msg["params"][field] = value;
            assert!(
                !deliver(&manager, msg.clone()).await,
                "accepted malformed {msg}"
            );
        }
        let mut missing = signal(id, 1, "working");
        missing["params"].as_object_mut().unwrap().remove(field);
        assert!(!deliver(&manager, missing).await);
    }
    for (field, value) in [
        ("id", json!(3)),
        ("jsonrpc", json!("1.0")),
        ("params", json!([])),
    ] {
        let mut msg = signal(id, 1, "working");
        msg[field] = value;
        assert!(!deliver(&manager, msg).await);
    }
    assert!(deliver(&manager, signal(id, 1, "waiting_user")).await);
    finish(&manager, id, json!({"result": "unchanged"})).await;
    assert_eq!(task.await.unwrap().unwrap(), json!({"result": "unchanged"}));
}

#[tokio::test(start_paused = true)]
async fn two_requests_in_the_same_chat_do_not_share_liveness() {
    let manager = SidecarManager::new(PathBuf::from("unused.py"));
    let (tx, mut rx) = tokio::sync::mpsc::channel(4);
    *manager.stdin_tx.lock().await = Some(tx);
    let mut tasks = Vec::new();
    for _ in 0..2 {
        let sender = manager.clone();
        let task = tokio::spawn(async move {
            sender
                .send_request_with_timeout(
                    "agent.invoke",
                    json!({"state": {"session_id": "same-chat"}}),
                    BUDGET,
                )
                .await
        });
        let wire: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
        tasks.push((wire["id"].as_i64().unwrap(), task));
    }
    tokio::task::yield_now().await;
    let (second_id, second) = tasks.pop().unwrap();
    let (first_id, first) = tasks.pop().unwrap();
    assert_ne!(first_id, second_id);
    tokio::time::advance(Duration::from_secs(500)).await;
    assert!(deliver(&manager, signal(first_id, 1, "waiting_user")).await);
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(101)).await;
    assert!(matches!(
        second.await.unwrap(),
        Err(SidecarError::RequestTimeout(_))
    ));
    assert!(!first.is_finished());
    assert!(!deliver(&manager, signal(second_id, 2, "working")).await);
    finish(&manager, first_id, json!({"result": "first"})).await;
    assert_eq!(first.await.unwrap().unwrap(), json!({"result": "first"}));
    assert!(manager.pending_requests.lock().await.is_empty());
}

#[tokio::test(start_paused = true)]
async fn ready_response_wins_over_liveness_close_and_deadline() {
    let (manager, id, task) = start_request("agent.invoke").await;
    let response = json!({"id": id, "error": {"code": -1, "message": "test remote error"}});
    finish(&manager, id, response.clone()).await;
    tokio::time::advance(BUDGET).await;
    assert_eq!(task.await.unwrap().unwrap(), response);
    assert!(manager.pending_requests.lock().await.is_empty());
}

#[tokio::test(start_paused = true)]
async fn dropped_reply_sender_retires_request_without_waiting_for_timeout() {
    let (manager, id, task) = start_request("agent.invoke").await;
    manager.pending_requests.lock().await.remove(&id);
    assert!(matches!(task.await.unwrap(), Err(SidecarError::NotRunning)));
    assert!(!deliver(&manager, signal(id, 1, "working")).await);
}

#[tokio::test(start_paused = true)]
async fn failed_send_cleans_up_the_response_and_liveness_owner() {
    let manager = SidecarManager::new(PathBuf::from("unused.py"));
    assert!(matches!(
        manager
            .send_request_with_timeout("agent.invoke", json!({}), BUDGET)
            .await,
        Err(SidecarError::NotRunning)
    ));
    assert!(manager.pending_requests.lock().await.is_empty());
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    drop(rx);
    *manager.stdin_tx.lock().await = Some(tx);
    assert!(matches!(
        manager
            .send_request_with_timeout("agent.invoke", json!({}), BUDGET)
            .await,
        Err(SidecarError::StdinClosed)
    ));
    assert!(manager.pending_requests.lock().await.is_empty());
}

#[tokio::test(start_paused = true)]
async fn buffered_signal_uses_receive_time_not_late_consume_time() {
    let (reply_tx, reply_rx) = oneshot::channel();
    let (tx, rx) = watch::channel(RpcLiveness {
        seq: 0,
        received_at: tokio::time::Instant::now(),
    });
    tx.send_replace(RpcLiveness {
        seq: 1,
        received_at: tokio::time::Instant::now(),
    });
    tokio::time::advance(BUDGET + Duration::from_secs(1)).await;
    let before = tokio::time::Instant::now();
    assert!(matches!(
        wait_for_rpc_response(reply_rx, Some(rx), BUDGET).await,
        Err(SidecarError::RequestTimeout(_))
    ));
    assert_eq!(
        tokio::time::Instant::now(),
        before,
        "stale buffered lease gained another full window"
    );
    drop(reply_tx);
}

#[tokio::test(start_paused = true)]
async fn signal_received_after_expiry_does_not_revive_the_request() {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};
    let (reply_tx, reply_rx) = oneshot::channel();
    let (tx, rx) = watch::channel(RpcLiveness {
        seq: 0,
        received_at: tokio::time::Instant::now(),
    });
    let mut pending = HashMap::from([(
        42,
        PendingRequest {
            response: reply_tx,
            liveness: Some(tx),
            budget: BUDGET,
        },
    )]);
    let mut wait = Box::pin(wait_for_rpc_response(reply_rx, Some(rx), BUDGET));
    assert!(matches!(
        wait.as_mut().poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    tokio::time::advance(BUDGET + Duration::from_secs(1)).await;
    let before = tokio::time::Instant::now();
    assert!(!handle_rpc_liveness(
        &signal(42, 1, "working"),
        &mut pending
    ));
    assert!(matches!(wait.await, Err(SidecarError::RequestTimeout(_))));
    assert_eq!(tokio::time::Instant::now(), before);
    drop(pending);
}

#[tokio::test(start_paused = true)]
async fn coalesced_valid_lease_chain_survives_a_late_consumer() {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};
    let (reply_tx, reply_rx) = oneshot::channel();
    let (tx, rx) = watch::channel(RpcLiveness {
        seq: 0,
        received_at: tokio::time::Instant::now(),
    });
    let mut pending = HashMap::from([(
        42,
        PendingRequest {
            response: reply_tx,
            liveness: Some(tx),
            budget: BUDGET,
        },
    )]);
    let mut wait = Box::pin(wait_for_rpc_response(reply_rx, Some(rx), BUDGET));
    assert!(matches!(
        wait.as_mut().poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    for seq in 1..=2 {
        tokio::time::advance(Duration::from_secs(500)).await;
        assert!(handle_rpc_liveness(
            &signal(42, seq, "working"),
            &mut pending
        ));
    }
    // The consumer has not polled in 1000s, but each ingress gap was <600s.
    assert!(matches!(
        wait.as_mut().poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    pending
        .remove(&42)
        .unwrap()
        .response
        .send(json!({"result": "chain"}))
        .unwrap();
    assert_eq!(wait.await.unwrap(), json!({"result": "chain"}));
}

#[tokio::test(start_paused = true)]
async fn liveness_channel_coalesces_signals_instead_of_accumulating_a_queue() {
    let (manager, id, task) = start_request("agent.invoke").await;
    for seq in 1..=1000 {
        assert!(deliver(&manager, signal(id, seq, "working")).await);
    }
    let pending = manager.pending_requests.lock().await;
    assert_eq!(pending[&id].liveness.as_ref().unwrap().borrow().seq, 1000);
    assert_eq!(pending.len(), 1);
    drop(pending);
    finish(&manager, id, json!({"result": true})).await;
    assert_eq!(task.await.unwrap().unwrap(), json!({"result": true}));
}

#[test]
#[ignore = "wire fixture invoked only by the stdout-reader regression"]
fn emit_wire_fixture() {
    println!("{}", signal(42, 1, "waiting_user"));
    println!(
        "{}",
        json!({"jsonrpc": "2.0", "id": 42, "result": {"output": "fixture"}})
    );
}

#[tokio::test]
async fn real_stdout_reader_consumes_private_liveness_and_routes_original_response() {
    let mut fixture = tokio::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "modules::sidecar::liveness_tests::emit_wire_fixture",
            "--nocapture",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let (reply_tx, reply_rx) = oneshot::channel();
    let (lease_tx, lease_rx) = watch::channel(RpcLiveness {
        seq: 0,
        received_at: tokio::time::Instant::now(),
    });
    let pending = Arc::new(Mutex::new(HashMap::from([(
        42,
        PendingRequest {
            response: reply_tx,
            liveness: Some(lease_tx),
            budget: BUDGET,
        },
    )])));
    let reader = tokio::spawn(reader_task(
        fixture.stdout.take().unwrap(),
        Arc::new(RwLock::new(SidecarState::default())),
        pending.clone(),
        Arc::new(Mutex::new(None)),
        Arc::new(Mutex::new(None)),
    ));
    let response = timeout(Duration::from_secs(5), reply_rx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        response,
        json!({"jsonrpc": "2.0", "id": 42, "result": {"output": "fixture"}})
    );
    assert_eq!(
        lease_rx.borrow().seq,
        1,
        "real reader failed to route the private notification"
    );
    assert!(timeout(Duration::from_secs(5), fixture.wait())
        .await
        .unwrap()
        .unwrap()
        .success());
    timeout(Duration::from_secs(5), reader)
        .await
        .unwrap()
        .unwrap();
    assert!(pending.lock().await.is_empty());
}
