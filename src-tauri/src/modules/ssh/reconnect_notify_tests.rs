use super::*;
use std::future::Future;
use std::sync::atomic::Ordering;
use std::task::{Context, Poll, Waker};
use std::time::Duration;

fn make_session(exited: bool) -> Arc<SshSession<tauri::test::MockRuntime>> {
    Arc::new(super::tests::make_test_session::<tauri::test::MockRuntime>(
        false, exited,
    ))
}

fn poll_once<F: Future>(future: &mut std::pin::Pin<Box<F>>) -> Poll<F::Output> {
    let mut context = Context::from_waker(Waker::noop());
    future.as_mut().poll(&mut context)
}

#[tokio::test]
async fn supervisor_returns_when_reader_exited_before_it_started_waiting() {
    let session = make_session(true);
    let notify = session.exited_notify.lock().await.clone();
    notify.notify_waiters();

    let result = tokio::time::timeout(
        Duration::from_millis(150),
        SshSession::reconnect_supervisor(Arc::clone(&session)),
    )
    .await;

    assert!(
        result.is_ok(),
        "supervisor missed the reader's earlier exit"
    );
}

#[tokio::test]
async fn supervisor_returns_when_user_closed_before_notification_wait() {
    let session = make_session(false);
    session
        .close()
        .await
        .expect("test session close should succeed");
    let notify = session.exited_notify.lock().await.clone();
    notify.notify_waiters();

    let result = tokio::time::timeout(
        Duration::from_millis(150),
        SshSession::reconnect_supervisor(Arc::clone(&session)),
    )
    .await;

    assert!(result.is_ok(), "supervisor missed the user's earlier close");
}

#[tokio::test]
async fn live_reader_waits_until_its_exit_notification() {
    let session = make_session(false);
    let notify = session.exited_notify.lock().await.clone();
    let mut supervisor = Box::pin(SshSession::reconnect_supervisor(Arc::clone(&session)));

    assert!(matches!(poll_once(&mut supervisor), Poll::Pending));

    session
        .exited
        .read()
        .unwrap()
        .store(true, Ordering::Release);
    notify.notify_waiters();

    assert!(matches!(poll_once(&mut supervisor), Poll::Ready(())));
}

#[tokio::test]
async fn old_reader_notification_does_not_wake_supervisor_for_current_reader() {
    let session = make_session(false);
    let old_notify = session.exited_notify.lock().await.clone();
    let current_notify = Arc::new(tokio::sync::Notify::new());
    *session.exited_notify.lock().await = Arc::clone(&current_notify);
    let mut supervisor = Box::pin(SshSession::reconnect_supervisor(Arc::clone(&session)));

    assert!(matches!(poll_once(&mut supervisor), Poll::Pending));

    old_notify.notify_waiters();
    assert!(matches!(poll_once(&mut supervisor), Poll::Pending));

    session
        .exited
        .read()
        .unwrap()
        .store(true, Ordering::Release);
    current_notify.notify_waiters();
    assert!(matches!(poll_once(&mut supervisor), Poll::Ready(())));
}
