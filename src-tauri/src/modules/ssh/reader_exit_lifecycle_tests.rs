use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

fn make_session(exited: bool) -> SshSession<tauri::test::MockRuntime> {
    super::tests::make_test_session::<tauri::test::MockRuntime>(false, exited)
}

fn reader_flag(session: &SshSession<tauri::test::MockRuntime>) -> Arc<AtomicBool> {
    session.exited.read().unwrap().clone()
}

#[test]
fn swapping_reader_flag_keeps_new_reader_live_when_temporary_drops() {
    let session = make_session(true);
    let temporary = make_session(false);

    session.swap_reader_exit_flag(&temporary);

    assert!(!session.is_pty_exited());
    drop(temporary);
    assert!(!session.is_pty_exited());
}

#[test]
fn swapping_reader_flag_preserves_an_exit_already_seen_by_the_new_reader() {
    let session = make_session(false);
    let temporary = make_session(true);

    session.swap_reader_exit_flag(&temporary);

    assert!(session.is_pty_exited());
    drop(temporary);
    assert!(session.is_pty_exited());
}

#[test]
fn old_reader_flag_does_not_mark_session_exited_but_current_reader_does() {
    let session = make_session(true);
    let temporary = make_session(false);
    let old_reader = reader_flag(&session);
    let current_reader = reader_flag(&temporary);

    session.swap_reader_exit_flag(&temporary);
    old_reader.store(true, Ordering::Release);
    assert!(!session.is_pty_exited());

    current_reader.store(true, Ordering::Release);
    assert!(session.is_pty_exited());
}

#[test]
fn human_typing_guard_tracks_only_the_current_reader_flag() {
    let session = make_session(true);
    let temporary = make_session(false);
    let old_reader = reader_flag(&session);
    let current_reader = reader_flag(&temporary);

    session.swap_reader_exit_flag(&temporary);
    let guard = session.human_typing_guard();

    assert!(Arc::ptr_eq(&guard.exited, &current_reader));
    old_reader.store(true, Ordering::Release);
    assert!(!guard.exited.load(Ordering::Acquire));

    current_reader.store(true, Ordering::Release);
    assert!(guard.exited.load(Ordering::Acquire));
}
