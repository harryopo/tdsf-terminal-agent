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
fn uri_encoding_preserves_utf8_with_signed_printf_ordinals() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (base, _, _) = create_files(&dir);
    let script = format!(
        r#"source "{base}.hooks.bash" || exit 93
trap - DEBUG
{}
builtin printf '\nTDSF_SIGNED_BYTE='
tdsf_test_byte=$'\347'
printf '%d' "'$tdsf_test_byte"
builtin printf '\nTDSF_BYTE_RESULT='
_tdsf_uri_encode $'\347\233\256\345\275\225% space'
builtin printf '\n'
"#,
        include_str!("fixtures/signed_octet_printf.bash")
    );
    let mut command = Command::new(bash_program());
    command
        .args(["--noprofile", "--norc", "-i", "-c", &script])
        .current_dir(dir.path())
        .env("HOME", dir.path())
        .env("TERM", "xterm-256color");
    let output = run_command_with_deadline(&mut command);
    assert!(output.status.success(), "{:?}", output.stderr);
    let stdout = String::from_utf8(output.stdout).expect("ASCII encoded result");
    assert!(stdout.contains("\nTDSF_SIGNED_BYTE=-25\n"));
    let encoded = stdout
        .split_once("\nTDSF_BYTE_RESULT=")
        .expect("encoder result marker")
        .1
        .trim();
    assert_eq!(encoded, "%E7%9B%AE%E5%BD%95%25%20space");
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
fn array_prompt_commands_do_not_claim_user_command_markers() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (_, _, launch_cmd) = create_files(&dir);
    std::fs::write(dir.path().join(".bashrc"), "PROMPT_COMMAND=(':' ':')\n")
        .expect("write user prompt array");
    let output = run_interactive(&launch_cmd, &dir, "printf TDSF_FIRST\nfalse\nexit\n");
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("TDSF_FIRST"), "the user command did not run");
    let commands: Vec<_> = text
        .split("\u{1b}]633;E;")
        .skip(1)
        .map(|frame| frame.split_once(';').expect("command nonce").0)
        .collect();
    assert_eq!(commands, ["printf TDSF_FIRST", "false", "exit"]);
    assert!(text.contains("\u{1b}]133;D;1\u{7}"), "nonzero status was lost");
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
// CORR-02 C3：完整单一简单命令必须在 133;D 之前上报 633;F;1;1。
fn unclaimed_bash_reports_complete_simple_command_before_exit_code() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (_, _, launch_cmd) = create_files(&dir);
    std::fs::write(dir.path().join(".bashrc"), "").expect("write clean user bashrc");

    let output = run_interactive(&launch_cmd, &dir, "printf TDSF_OK\nfalse\nexit 0\n");

    assert!(output.status.success(), "{:?}", output.stderr);
    let text = String::from_utf8_lossy(&output.stdout);
    let marker = text
        .find("\u{1b}]633;F;1;1;")
        .unwrap_or_else(|| panic!("complete line marker missing: {text:?}"));
    let done = text
        .find("\u{1b}]133;D;1\u{7}")
        .unwrap_or_else(|| panic!("nonzero status lost: {text:?}"));
    assert!(
        marker < done,
        "completeness marker must precede exit code: {text:?}"
    );
}

#[test]
// CORR-02 C3（ROOT 阻断 C3）：`printf ROOT_OK; missing` 的首段不得冒充整行；
// 段数=2 + 完整性=0 必须与真实退出码 127 一起到达。
fn compound_line_is_marked_incomplete_and_keeps_real_status() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (_, _, launch_cmd) = create_files(&dir);
    std::fs::write(dir.path().join(".bashrc"), "").expect("write clean user bashrc");

    let output = run_interactive(
        &launch_cmd,
        &dir,
        "printf ROOT_OK; __tdsf_missing_cmd_xyz\nexit 0\n",
    );

    assert!(output.status.success(), "{:?}", output.stderr);
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.contains("\u{1b}]633;E;printf ROOT_OK;"),
        "first fragment was not reported: {text:?}"
    );
    let marker = text
        .find("\u{1b}]633;F;2;0;")
        .unwrap_or_else(|| panic!("compound completeness marker missing: {text:?}"));
    let done = text
        .find("\u{1b}]133;D;127\u{7}")
        .unwrap_or_else(|| panic!("real exit status was lost: {text:?}"));
    assert!(
        marker < done,
        "completeness must be reported before the exit code: {text:?}"
    );
}

#[test]
// && 短路时只执行首段：段数仍是 1，但 history 校验必须识破整行不是单一命令。
fn short_circuit_compound_is_marked_incomplete() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (_, _, launch_cmd) = create_files(&dir);
    std::fs::write(dir.path().join(".bashrc"), "").expect("write clean user bashrc");

    let output = run_interactive(
        &launch_cmd,
        &dir,
        "grpe_tdsf_missing && echo never\nexit 0\n",
    );

    assert!(output.status.success(), "{:?}", output.stderr);
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.contains("\u{1b}]633;F;1;0;"),
        "short-circuit line was not marked incomplete: {text:?}"
    );
}

#[test]
// 管道：多个简单命令段 + 退出码属于最后一段，必须标记为不完整。
fn pipeline_is_marked_incomplete() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (_, _, launch_cmd) = create_files(&dir);
    std::fs::write(dir.path().join(".bashrc"), "").expect("write clean user bashrc");

    let output = run_interactive(&launch_cmd, &dir, "printf x | cat\nexit 0\n");

    assert!(output.status.success(), "{:?}", output.stderr);
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.contains("\u{1b}]633;F;2;0;"),
        "pipeline was not marked incomplete: {text:?}"
    );
}

#[test]
// HISTCONTROL=ignorespace：本轮未进入 history → 不能证明原文完整。
fn history_filtered_command_is_marked_incomplete() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (_, _, launch_cmd) = create_files(&dir);
    std::fs::write(dir.path().join(".bashrc"), "HISTCONTROL=ignorespace\n")
        .expect("write user bashrc");

    let output = run_interactive(&launch_cmd, &dir, "   false\nexit 0\n");

    assert!(output.status.success(), "{:?}", output.stderr);
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.contains("\u{1b}]633;F;1;0;"),
        "history-filtered line was treated as complete: {text:?}"
    );
}

#[test]
// HISTIGNORE 排除当前命令：同上，必须降级为不完整。
fn history_ignored_command_is_marked_incomplete() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (_, _, launch_cmd) = create_files(&dir);
    std::fs::write(dir.path().join(".bashrc"), "HISTIGNORE='false*'\n")
        .expect("write user bashrc");

    let output = run_interactive(&launch_cmd, &dir, "false\nexit 0\n");

    assert!(output.status.success(), "{:?}", output.stderr);
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.contains("\u{1b}]633;F;1;0;"),
        "HISTIGNORE line was treated as complete: {text:?}"
    );
}

#[test]
// 用户 HISTTIMEFORMAT 不能破坏完整性校验（只在函数内临时清空）。
fn history_timestamp_format_keeps_completeness_evidence() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (_, _, launch_cmd) = create_files(&dir);
    std::fs::write(
        dir.path().join(".bashrc"),
        "HISTTIMEFORMAT='%F %T '\n",
    )
    .expect("write user bashrc");

    let output = run_interactive(&launch_cmd, &dir, "false\nexit 0\n");

    assert!(output.status.success(), "{:?}", output.stderr);
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.contains("\u{1b}]633;F;1;1;"),
        "HISTTIMEFORMAT broke completeness validation: {text:?}"
    );
}

#[test]
// 用户 PROMPT_COMMAND 数组里的命令不得被算作同一输入行的片段。
fn user_prompt_array_does_not_create_fragments() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (_, _, launch_cmd) = create_files(&dir);
    std::fs::write(dir.path().join(".bashrc"), "PROMPT_COMMAND=(':' ':')\n")
        .expect("write user prompt array");

    let output = run_interactive(&launch_cmd, &dir, "printf TDSF_FIRST\nfalse\nexit 0\n");

    assert!(output.status.success(), "{:?}", output.stderr);
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("TDSF_FIRST"), "the user command did not run");
    assert!(
        !text.contains("\u{1b}]633;F;2;"),
        "prompt hooks were counted as command fragments: {text:?}"
    );
    assert!(
        text.matches("\u{1b}]633;F;1;1;").count() >= 2,
        "user commands lost their completeness markers: {text:?}"
    );
}

#[test]
// 用户已占用 DEBUG trap：产品降级，不得伪造任何 E/F 标记。
fn user_debug_trap_degrades_without_fabricated_line_markers() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (_, _, launch_cmd) = create_files(&dir);
    std::fs::write(dir.path().join(".bashrc"), "trap ':' DEBUG\n")
        .expect("write user debug trap");

    let output = run_interactive(&launch_cmd, &dir, "false\nexit 0\n");

    assert!(output.status.success(), "{:?}", output.stderr);
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        !text.contains("\u{1b}]633;E;"),
        "degraded shell fabricated a command marker: {text:?}"
    );
    assert!(
        !text.contains("\u{1b}]633;F;"),
        "degraded shell fabricated a completeness marker: {text:?}"
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
}

#[test]
// CORR-03 P0 / ROOT CAP-01：超长命令的上报文本一旦被截断，完整性必须降为 0；
// 截断不能与 `633;F;1;1` 同时出现（否则 512 字符之外的内容被当成可信原文）。
fn overlong_command_is_truncated_and_marked_incomplete() {
    let dir = tempfile::tempdir().expect("temporary HOME");
    let (_, _, launch_cmd) = create_files(&dir);
    std::fs::write(dir.path().join(".bashrc"), "").expect("write clean user bashrc");

    let long = "A".repeat(600);
    let output = run_interactive(&launch_cmd, &dir, &format!("printf %s {long}\nexit 0\n"));

    assert!(output.status.success(), "{:?}", output.stderr);
    let text = String::from_utf8_lossy(&output.stdout);
    let echo_prefix = "\u{1b}]633;E;";
    let e_pos = text
        .find(&format!("{echo_prefix}printf"))
        .unwrap_or_else(|| panic!("long command echo missing: {text:?}"));
    let payload = &text[e_pos + echo_prefix.len()..];
    let e_end = payload
        .find('\u{7}')
        .unwrap_or_else(|| panic!("E terminator missing: {text:?}"));
    let e_body = &payload[..e_end];
    let reported = e_body.rsplit_once(';').map(|(cmd, _)| cmd).unwrap_or(e_body);
    assert!(
        reported.len() <= 512,
        "reported command must stay within the 512-char bound, got {}",
        reported.len()
    );
    let f_pos = payload
        .find("\u{1b}]633;F;")
        .unwrap_or_else(|| panic!("completeness marker missing: {text:?}"));
    let f_line = &payload[f_pos..];
    assert!(
        f_line.starts_with("\u{1b}]633;F;1;0;"),
        "truncated command must report incomplete: {f_line:?}"
    );
}

// CORR-03 P0：控制字符清洗降级不在此处构造。
// 交互 bash 从 stdin 读行时，readline 会把 BEL/ESC 等控制字符当作编辑命令吞掉，
// `$BASH_COMMAND` 里根本不会出现这些字符（实测 `\a echo hi` 读成 `echo hi`），
// 因此该路径无法用 stdin 复现。真实触发场景是 bracketed paste（PTY 原样插入），
// 由 `.ai/test-runs/corr03-20261120-a1/probes/probe-capture-limits.sh` 在真实
// rcfile + PTY 下验证；shell 内的 `_tdsf_lossy` 分支保留为防御性降级。
