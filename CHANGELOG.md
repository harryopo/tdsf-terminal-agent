# Changelog

Version numbering: `0.x` builds are pre-stable releases; `1.x` is reserved for the first
stable release.

## 0.9.0

Pre-stable Windows x64 build. It carries the capabilities of the earlier internal builds
plus the fixes listed below.

**Capabilities**

- Strands-only Linux operations agent with visible terminal execution.
- Local, WSL and SSH workspaces with remote file browsing and editing.
- Auto / confirm / observe / teaching interaction modes.
- Command prediction, terminal translation, skills, snippets and offline knowledge retrieval.
- Windows current-user NSIS installer with a bundled Python sidecar.

**Signed automatic updates**

- Released builds check GitHub Releases for a newer version at start-up and at most once per
  day; the result appears in the status bar.
- Downloading and installing stays user-initiated: the package size is shown first, and the
  update signature is verified before installation.
- Installing is refused while an approval is waiting or a turn is still running; otherwise the
  agent turn, SSH sessions, terminals, language servers and the bundled sidecar are closed out
  first, so an update does not leave background processes behind.

**Security**

- Reading credential files is no longer treated as a harmless read-only action:
  `cat ~/.ssh/id_rsa`, `head /etc/shadow` and equivalents now require approval, on both the
  SSH command path and the Python path.
- Tool output that reaches the model is redacted for known secret shapes, and the configured
  API key is no longer written to disk in plaintext.

**Interface**

- Remote parameter completion now has a settings entry: the servers you are connected to are
  listed with their install state, an install can be started from there, and a failed attempt
  reports the underlying error.
