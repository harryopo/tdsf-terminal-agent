use super::{build_integration_commands, RemoteShellKind, BASH_INTEGRATION_SCRIPT};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::TempDir;

fn bash_program() -> PathBuf {
    #[cfg(windows)]
    {
        let git_bash = PathBuf::from(r"C:\Program Files\Git\bin\bash.exe");
        if git_bash.is_file() {
            return git_bash;
        }
    }
    PathBuf::from("bash")
}

fn shell_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn temp_base(dir: &TempDir) -> String {
    shell_path(&dir.path().join("tdsf-test"))
}

fn run_command_with_deadline(command: &mut Command) -> Output {
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start bash command");
    finish_with_deadline(child)
}

fn run_write_command(write_cmd: &str, dir: &TempDir) -> Output {
    let mut command = Command::new(bash_program());
    command
        .args(["--noprofile", "--norc", "-s"])
        .current_dir(dir.path())
        .env("HOME", dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .expect("start bash to create integration files");
    child
        .stdin
        .take()
        .expect("bash stdin")
        .write_all(write_cmd.as_bytes())
        .expect("send integration write command to bash");
    finish_with_deadline(child)
}

fn finish_with_deadline(mut child: Child) -> Output {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if child.try_wait().expect("poll bash process").is_some() {
            return child.wait_with_output().expect("collect bash output");
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let output = child.wait_with_output().expect("reap timed out bash");
            panic!(
                "bash did not exit before deadline; stdout={:?}, stderr={:?}",
                output.stdout, output.stderr
            );
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn run_interactive(launch_cmd: &str, dir: &TempDir, input: &str) -> Output {
    let mut child = Command::new(bash_program())
        .args(["-c", launch_cmd])
        .current_dir(dir.path())
        .env("HOME", dir.path())
        .env("TERM", "xterm-256color")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start integration bash");
    child
        .stdin
        .take()
        .expect("bash stdin")
        .write_all(input.as_bytes())
        .expect("send commands to integration bash");
    finish_with_deadline(child)
}

fn create_files(dir: &TempDir) -> (String, String, String) {
    let base = temp_base(dir);
    let (write_cmd, launch_cmd) =
        build_integration_commands(RemoteShellKind::Bash, &base).expect("build bash commands");
    let output = run_write_command(&write_cmd, dir);
    assert!(
        output.status.success(),
        "write command failed: stdout={:?}, stderr={:?}",
        output.stdout,
        output.stderr
    );
    (base.clone(), format!("{base}.bash"), launch_cmd)
}

fn shell_file(base: &str, suffix: &str) -> String {
    format!("{base}.{suffix}")
}

#[test]
fn builder_writes_hooks_as_a_separate_sourceable_file() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (base, entry, _) = create_files(&dir);
    let hooks = shell_file(&base, "hooks.bash");

    assert!(Path::new(&entry).is_file(), "startup entry was not written");
    assert!(
        Path::new(&hooks).is_file(),
        "pure hooks file was not written"
    );
    let contents = std::fs::read_to_string(&hooks).expect("read hooks file");
    assert_eq!(contents, BASH_INTEGRATION_SCRIPT);
}

#[test]
fn sourcing_pure_hooks_does_not_load_the_users_bashrc() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (base, _, _) = create_files(&dir);
    let marker = dir.path().join("bashrc-loaded");
    std::fs::write(
        dir.path().join(".bashrc"),
        format!("printf loaded >> '{}'\n", shell_path(&marker)),
    )
    .expect("write user bashrc");

    let source_hooks = format!("source \"{base}.hooks.bash\" || exit 93");
    let mut command = Command::new(bash_program());
    command
        .args(["--noprofile", "--norc", "-i", "-c", &source_hooks])
        .current_dir(dir.path())
        .env("HOME", dir.path())
        .env("TERM", "xterm-256color");
    let output = run_command_with_deadline(&mut command);

    assert!(output.status.success(), "{:?}", output.stderr);
    assert!(!marker.exists(), "pure hooks sourced the user's .bashrc");
}

#[test]
fn startup_loads_user_rc_once_and_repeated_hooks_keep_prompt_state() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (base, _, launch_cmd) = create_files(&dir);
    let count = dir.path().join("bashrc-count");
    let trace = dir.path().join("prompt-trace");
    std::fs::write(
        dir.path().join(".bashrc"),
        format!(
            "printf x >> '{}'\nPS1='USER_PROMPT>'\nPROMPT_COMMAND=\"printf 'tick\\n' >> '{}'\"\n",
            shell_path(&count),
            shell_path(&trace)
        ),
    )
    .expect("write user bashrc");

    let output = run_interactive(
        &launch_cmd,
        &dir,
        &format!(
            "source \"{base}.hooks.bash\" || exit 93\nsource \"{base}.hooks.bash\" || exit 93\nprintf 'PS1=%s\\n' \"$PS1\"\nexit\n"
        ),
    );

    assert!(output.status.success(), "{:?}", output.stderr);
    assert_eq!(std::fs::read_to_string(count).unwrap(), "x");
    assert!(String::from_utf8_lossy(&output.stdout).contains("PS1=USER_PROMPT>"));
    let ticks = std::fs::read_to_string(trace).expect("user prompt command trace");
    assert_eq!(
        ticks.lines().count(),
        4,
        "prompt command count changed: {ticks:?}"
    );
    assert!(ticks.lines().all(|line| line == "tick"), "{ticks:?}");
}

#[test]
fn string_prompt_command_runs_in_its_original_order() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (_, _, launch_cmd) = create_files(&dir);
    let trace = shell_path(&dir.path().join("prompt-trace"));
    std::fs::write(
        dir.path().join(".bashrc"),
        format!("PROMPT_COMMAND=\"printf 'one\\n' >> '{trace}'; printf 'two\\n' >> '{trace}'\"\n"),
    )
    .expect("write user bashrc");

    let output = run_interactive(&launch_cmd, &dir, ":\nexit\n");
    assert!(output.status.success(), "{:?}", output.stderr);
    let lines: Vec<_> = std::fs::read_to_string(dir.path().join("prompt-trace"))
        .expect("prompt trace")
        .lines()
        .map(str::to_owned)
        .collect();
    assert!(lines.len() >= 4, "{lines:?}");
    assert_eq!(
        lines.len() % 2,
        0,
        "incomplete prompt-command pair: {lines:?}"
    );
    assert!(
        lines.chunks_exact(2).all(|pair| pair == ["one", "two"]),
        "{lines:?}"
    );
}

#[test]
fn array_prompt_command_runs_in_its_original_order() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (_, _, launch_cmd) = create_files(&dir);
    let trace = shell_path(&dir.path().join("prompt-trace"));
    std::fs::write(
        dir.path().join(".bashrc"),
        format!(
            "PROMPT_COMMAND=(\"printf 'one\\n' >> '{trace}'\" \"printf 'two\\n' >> '{trace}'\")\n"
        ),
    )
    .expect("write user bashrc");

    let output = run_interactive(&launch_cmd, &dir, ":\nexit\n");
    assert!(output.status.success(), "{:?}", output.stderr);
    let lines: Vec<_> = std::fs::read_to_string(dir.path().join("prompt-trace"))
        .expect("prompt trace")
        .lines()
        .map(str::to_owned)
        .collect();
    assert!(lines.len() >= 4, "{lines:?}");
    assert_eq!(
        lines.len() % 2,
        0,
        "incomplete prompt-command pair: {lines:?}"
    );
    assert!(
        lines.chunks_exact(2).all(|pair| pair == ["one", "two"]),
        "{lines:?}"
    );
}

#[test]
fn existing_debug_trap_survives_hooks_and_extdebug_prompt_cycles() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (_, _, launch_cmd) = create_files(&dir);
    let trace = shell_path(&dir.path().join("debug-trace"));
    std::fs::write(
        dir.path().join(".bashrc"),
        format!("shopt -s extdebug\ntrap \"printf user-debug >> '{trace}'\" DEBUG\n"),
    )
    .expect("write user bashrc");

    let output = run_interactive(
        &launch_cmd,
        &dir,
        ":\nprintf 'FINAL_TRAP='; trap -p DEBUG\nexit\n",
    );
    assert!(output.status.success(), "{:?}", output.stderr);
    let debug =
        std::fs::read_to_string(dir.path().join("debug-trace")).expect("existing DEBUG trap ran");
    assert!(!debug.is_empty());
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.contains("user-debug"),
        "existing DEBUG trap was removed: {text:?}"
    );
    assert!(
        !text.contains("_tdsf_preexec"),
        "TDSF reinstalled DEBUG under extdebug: {text:?}"
    );
}

#[test]
fn existing_debug_trap_survives_hooks_without_extdebug() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (_, _, launch_cmd) = create_files(&dir);
    let trace = shell_path(&dir.path().join("debug-trace"));
    std::fs::write(
        dir.path().join(".bashrc"),
        format!("trap \"printf user-debug >> '{trace}'\" DEBUG\n"),
    )
    .expect("write user bashrc");

    let output = run_interactive(
        &launch_cmd,
        &dir,
        "printf 'FINAL_TRAP='; trap -p DEBUG\nexit\n",
    );

    assert!(output.status.success(), "{:?}", output.stderr);
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.contains("user-debug"),
        "existing DEBUG trap was removed: {text:?}"
    );
    assert!(
        !text.contains("_tdsf_preexec"),
        "TDSF replaced the existing DEBUG trap: {text:?}"
    );
    assert!(!std::fs::read_to_string(dir.path().join("debug-trace"))
        .expect("debug trace")
        .is_empty());
}

#[test]
fn unclaimed_debug_hook_reports_escaped_commands_and_nonzero_status() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (_, _, launch_cmd) = create_files(&dir);
    std::fs::write(dir.path().join(".bashrc"), "").expect("write clean user bashrc");

    let output = run_interactive(&launch_cmd, &dir, "printf '%s' 'a;b\\c'\nfalse\nexit 0\n");

    assert!(output.status.success(), "{:?}", output.stderr);
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.contains("\u{1b}]633;E;printf '%s' 'a\\x3bb\\\\c';"),
        "command echo or escaping was missing: {text:?}"
    );
    assert!(
        text.contains("\u{1b}]133;C\u{7}"),
        "command start marker was missing: {text:?}"
    );
    assert!(
        text.contains("\u{1b}]133;D;1\u{7}"),
        "nonzero command status marker was missing: {text:?}"
    );
}

#[test]
// ':' is a valid no-op DEBUG trap, so the test can inspect the real trap table.
fn noninteractive_hooks_do_not_install_prompt_or_debug_handlers() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (base, _, _) = create_files(&dir);
    let script = format!(
        "PROMPT_COMMAND=user_prompt; trap ':' DEBUG; source \"{base}.hooks.bash\" || exit 93; printf 'guard=%s pc=%s\\n' \"${{__TDSF_OSC133_GUARD-unset}}\" \"$PROMPT_COMMAND\"; trap -p DEBUG"
    );
    let mut command = Command::new(bash_program());
    command
        .args(["--noprofile", "--norc", "-c", &script])
        .current_dir(dir.path())
        .env("HOME", dir.path())
        .env("TERM", "xterm-256color");
    let output = run_command_with_deadline(&mut command);

    assert!(output.status.success(), "{:?}", output.stderr);
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("guard=unset pc=user_prompt"), "{text:?}");
    assert!(
        text.contains("trap -- ':' DEBUG"),
        "DEBUG trap changed: {text:?}"
    );
}

#[test]
// ':' is a valid no-op DEBUG trap, so the test can inspect the real trap table.
fn dumb_terminal_does_not_install_prompt_or_debug_handlers() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (base, _, _) = create_files(&dir);
    let script = format!(
        "PROMPT_COMMAND=user_prompt; trap ':' DEBUG; source \"{base}.hooks.bash\" || exit 93; printf 'guard=%s pc=%s\\n' \"${{__TDSF_OSC133_GUARD-unset}}\" \"$PROMPT_COMMAND\"; trap -p DEBUG"
    );
    let mut command = Command::new(bash_program());
    command
        .args(["--noprofile", "--norc", "-i", "-c", &script])
        .current_dir(dir.path())
        .env("HOME", dir.path())
        .env("TERM", "dumb");
    let output = run_command_with_deadline(&mut command);

    assert!(output.status.success(), "{:?}", output.stderr);
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("guard=unset pc=user_prompt"), "{text:?}");
    assert!(
        text.contains("trap -- ':' DEBUG"),
        "DEBUG trap changed: {text:?}"
    );
}

#[test]
fn extdebug_without_a_user_trap_does_not_gain_a_tdsf_debug_trap() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (_, _, launch_cmd) = create_files(&dir);
    let snapshot = shell_path(&dir.path().join("debug-trap"));
    std::fs::write(dir.path().join(".bashrc"), "shopt -s extdebug\n").expect("write user bashrc");

    let output = run_interactive(
        &launch_cmd,
        &dir,
        &format!("trap -p DEBUG > '{snapshot}'\nexit\n"),
    );

    assert!(output.status.success(), "{:?}", output.stderr);
    assert!(
        std::fs::read_to_string(snapshot)
            .expect("read DEBUG trap snapshot")
            .is_empty(),
        "TDSF installed a DEBUG trap while extdebug was active"
    );
}

#[test]
fn child_source_and_exit_preserves_parent_files_then_parent_exit_removes_only_them() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (base, entry, launch_cmd) = create_files(&dir);
    let hooks = shell_file(&base, "hooks.bash");
    let sibling = dir.path().join("tdsf-test.keep");
    std::fs::write(&sibling, "keep").expect("write unrelated sibling");

    let child = format!("bash --noprofile --norc -i -c 'source \"{hooks}\" || exit 93; exit 0'");
    let parent_check = format!(
        "{child}\nchild_status=$?\nif [ \"$child_status\" -ne 0 ]; then echo CHILD_FAILED; exit \"$child_status\"; fi\necho CHILD_SUCCEEDED\nif [ -f '{entry}' ] && [ -f '{hooks}' ]; then echo PARENT_FILES_SURVIVED; fi\nexit\n"
    );
    let output = run_interactive(&launch_cmd, &dir, &parent_check);

    assert!(output.status.success(), "{:?}", output.stderr);
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("CHILD_SUCCEEDED"),
        "child did not successfully source hooks: {:?}",
        output.stdout
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("PARENT_FILES_SURVIVED"),
        "child exit removed parent files: {:?}",
        output.stdout
    );
    assert!(!Path::new(&entry).exists(), "parent EXIT left startup file");
    assert!(!Path::new(&hooks).exists(), "parent EXIT left hooks file");
    assert!(sibling.exists(), "cleanup removed a neighboring file");
}
