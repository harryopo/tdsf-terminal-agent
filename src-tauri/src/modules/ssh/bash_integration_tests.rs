use super::{build_integration_commands, RemoteShellKind, BASH_INTEGRATION_SCRIPT};
use std::io::{Read, Write};
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
    let collect_pipe = |mut pipe: Box<dyn Read + Send>| {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            pipe.read_to_end(&mut bytes).expect("read bash output");
            bytes
        })
    };
    let stdout = collect_pipe(Box::new(child.stdout.take().expect("bash stdout")));
    let stderr = collect_pipe(Box::new(child.stderr.take().expect("bash stderr")));
    let (status, timed_out) = loop {
        if let Some(status) = child.try_wait().expect("poll bash process") {
            break (status, false);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            break (child.wait().expect("reap timed out bash"), true);
        }
        thread::sleep(Duration::from_millis(10));
    };
    let output = Output {
        status,
        stdout: stdout.join().expect("collect bash stdout"),
        stderr: stderr.join().expect("collect bash stderr"),
    };
    assert!(
        !timed_out,
        "bash did not exit before deadline; stdout={:?}, stderr={:?}",
        output.stdout, output.stderr
    );
    output
}

#[test]
fn command_output_larger_than_pipes_does_not_block_exit() {
    let mut command = Command::new(bash_program());
    command.args([
        "--noprofile",
        "--norc",
        "-c",
        "printf '%70000s' x; printf '%70000s' y >&2",
    ]);
    let output = run_command_with_deadline(&mut command);

    assert!(output.status.success());
    assert_eq!(output.stdout.len(), 70_000);
    assert_eq!(output.stderr.len(), 70_000);
    assert_eq!(output.stdout.last(), Some(&b'x'));
    assert_eq!(output.stderr.last(), Some(&b'y'));
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

#[derive(Debug, PartialEq, Eq)]
struct ContextReceipt {
    connection: String,
    shell: String,
    user: String,
    cwd: String,
}

fn decode_uri_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            assert!(
                index + 2 < bytes.len(),
                "incomplete URI percent escape: {value:?}"
            );
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).expect("ASCII percent hex");
            let byte = u8::from_str_radix(hex, 16).expect("valid URI percent escape");
            decoded.push(byte);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(decoded).expect("URI component should decode as UTF-8")
}

fn context_receipts(output: &[u8]) -> Vec<ContextReceipt> {
    let text = String::from_utf8_lossy(output);
    let prefix = "\u{1b}]633;P;TdsfContext=";
    text.split(prefix)
        .skip(1)
        .filter_map(|frame| {
            let fields = frame.split_once('\u{7}')?.0.split(';').collect::<Vec<_>>();
            (fields.len() == 4).then(|| ContextReceipt {
                connection: fields[0].to_owned(),
                shell: fields[1].to_owned(),
                user: decode_uri_component(fields[2]),
                cwd: decode_uri_component(fields[3]),
            })
        })
        .collect()
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
        lines.as_chunks::<2>().0.iter().all(|pair| pair.as_slice() == ["one", "two"]),
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
        lines.as_chunks::<2>().0.iter().all(|pair| pair.as_slice() == ["one", "two"]),
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

#[test]
fn context_receipt_is_stable_and_uri_decodes_user_and_special_cwd() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (_, _, launch_cmd) = create_files(&dir);
    let special_component = if cfg!(windows) {
        "目录%分号;换行"
    } else {
        "目录%分号;换行\n反斜杠\\目录\n"
    };
    let special_dir = dir.path().join(special_component);
    std::fs::create_dir(&special_dir).expect("create special working directory");
    let user_file = dir.path().join("receipt-user");
    let cwd_file = dir.path().join("receipt-cwd");
    let special_dir = if cfg!(windows) {
        shell_path(&special_dir)
    } else {
        special_dir.to_string_lossy().into_owned()
    };
    let user_file = shell_path(&user_file);
    let cwd_file = shell_path(&cwd_file);

    let output = run_interactive(
        &launch_cmd,
        &dir,
        &format!(
            "cd '{special_dir}'\nprintf '%s' \"$(id -un)\" > '{user_file}'\npwd -P > '{cwd_file}'; printf X >> '{cwd_file}'\nexit\n"
        ),
    );

    assert!(output.status.success(), "{:?}", output.stderr);
    let receipts = context_receipts(&output.stdout);
    assert!(
        !receipts.is_empty(),
        "missing TdsfContext receipt: {:?}",
        output.stdout
    );
    let output_text = String::from_utf8_lossy(&output.stdout);
    let receipt_position = output_text
        .find("\u{1b}]633;P;TdsfContext=")
        .expect("first context receipt");
    let done_position = output_text
        .find("\u{1b}]133;D;")
        .expect("first command completion marker");
    assert!(
        receipt_position < done_position,
        "context receipt must precede the first command completion marker"
    );
    assert!(
        receipts
            .iter()
            .all(|receipt| receipt.connection == "tdsf-test"),
        "connection context changed within one Bash instance: {receipts:?}"
    );
    assert!(
        receipts
            .iter()
            .all(|receipt| receipt.shell == receipts[0].shell),
        "shell instance changed within one Bash instance: {receipts:?}"
    );
    let expected_user = std::fs::read_to_string(user_file).expect("Bash user");
    let expected_cwd = std::fs::read_to_string(cwd_file)
        .expect("physical Bash cwd")
        .strip_suffix("\nX")
        .expect("cwd sentinel")
        .to_owned();
    assert!(
        receipts
            .iter()
            .any(|receipt| receipt.user == expected_user && receipt.cwd == expected_cwd),
        "decoded receipt did not preserve user and special cwd {expected_cwd:?}: {receipts:?}"
    );
}

#[test]
fn uri_encoder_preserves_newline_and_backslash_as_encoded_bytes() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (base, _, launch_cmd) = create_files(&dir);
    let output = run_interactive(
        &launch_cmd,
        &dir,
        &format!(
            r#"source "{base}.hooks.bash" || exit 93
value=$'line\nback\\slash'
printf 'ENCODED=%s\n' "$(_tdsf_uri_encode "$value")"
exit 0
"#
        ),
    );

    assert!(output.status.success(), "{:?}", output.stderr);
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("ENCODED=line%0Aback%5Cslash"),
        "newline or backslash was not percent-encoded: {:?}",
        output.stdout
    );
}

#[test]
fn interactive_child_gets_its_own_context_and_parent_receipt_returns_after_exit() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (base, _, launch_cmd) = create_files(&dir);
    let hooks = shell_file(&base, "hooks.bash");
    let output = run_interactive(
        &launch_cmd,
        &dir,
        &format!(
            "bash --noprofile --norc -i -c 'source \"{hooks}\" || exit 93; _tdsf_precmd; exit 0'\nprintf parent-returned\nexit\n"
        ),
    );

    assert!(output.status.success(), "{:?}", output.stderr);
    let receipts = context_receipts(&output.stdout);
    assert!(
        receipts.len() >= 3,
        "missing parent/child receipts: {receipts:?}"
    );
    let parent_shell = &receipts[0].shell;
    let child_index = receipts
        .iter()
        .position(|receipt| receipt.shell != *parent_shell)
        .expect("interactive child should have a distinct shell instance");
    assert!(
        receipts[child_index + 1..]
            .iter()
            .any(|receipt| receipt.shell == *parent_shell),
        "parent shell identity did not resume after child exit: {receipts:?}"
    );
    assert!(
        receipts
            .iter()
            .all(|receipt| receipt.connection == "tdsf-test"),
        "connection identity changed across nested shells: {receipts:?}"
    );
}
