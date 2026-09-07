# Visible terminal execution channel

## Contract

Authorization and execution transport are independent. Observe, confirm, and
auto modes decide whether an operation is authorized. The execution channel
decides where an authorized SSH command runs: background SSH (the default) or
the selected visible SSH terminal. Teach mode remains a presentation mode; it
does not gain a separate execution path.

## Real execution path

1. `agentExecutionChannel` defaults to `background`; the only alternate value
   is `visible-terminal`.
2. After policy, approval, active-session, and durable-ledger checks, Python
   selects exactly one route: `ssh_command` or `visible_terminal_execute`.
3. The Rust sidecar asks the frontend owning the matching SSH PTY to type the
   command into that terminal. A missing or busy terminal, or a session mismatch,
   returns `unavailable`; it never silently falls back to background SSH.
4. The frontend matches the terminal OSC command block to the requested command
   and returns its exit code and redacted output. No exit code, user takeover,
   or wait expiry produces `indeterminate`, never a claimed success or failure.
5. Only one verifiable foreground execution may wait on a terminal leaf at a
   time, so separate tool calls cannot be reordered on one shell.

## Typewriter and timeout

- Typewriter mode changes only visible input pacing. Long commands preserve the
  exact bytes but have an adaptive total typing cap of about 900 ms.
- The execution timeout starts after the final Enter has been written, not while
  the command is still being typed.
- On timeout the agent does not send Ctrl-C and reports that the command may
  still be running. The user can keep waiting, inspect the terminal, or
  explicitly interrupt it.

## Intentionally not faked

The terminal emulator owns shell echo and command colors. This implementation
does not inject ANSI control bytes or overlay a blue fake command line, because
either could corrupt shell input or misrepresent an execution. Blue AI command
styling requires a supported terminal-renderer feature or a shell integration
that can be proven not to alter the submitted command; it is not part of this
transport change.

## Acceptance checklist

1. Background channel: one `uname -a` call runs only through background SSH.
2. Visible channel: with the matching idle SSH terminal open, one `uname -a`
   appears once in the terminal and produces one correlated tool result.
3. With no matching terminal, a session mismatch, or a busy terminal, the UI
   states that the command was not written and background SSH has no duplicate.
4. A long typewriter command is visibly entered but does not make its timeout
   begin before Enter.
5. A short-timeout `sleep 60` result says the process may still run and does
   not automatically send Ctrl-C.
