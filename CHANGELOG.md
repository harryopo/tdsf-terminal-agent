# Changelog

## 1.0.2

Signed automatic updates on Windows, plus security fixes.

- Released builds check GitHub Releases for a newer version at start-up and at
  most once per day; the result appears in the status bar.
- Downloading and installing stays user-initiated: the package size is shown
  first, and the update signature is verified before installation.
- Installing is refused while an approval is waiting or a turn is still
  running; otherwise the agent turn, SSH sessions, terminals, language servers
  and the bundled sidecar are closed out first, so an update does not leave
  background processes behind.
- Reading credential files is no longer treated as a harmless read-only action:
  `cat ~/.ssh/id_rsa`, `head /etc/shadow` and equivalents now require approval,
  on both the SSH command path and the Python path.
- Tool output that reaches the model is redacted for known secret shapes, and
  the configured API key is no longer written to disk in plaintext.

## 1.0.0

Initial Windows x64 competition release.

- Strands-only Linux operations Agent with visible terminal execution.
- Local, WSL, and SSH workspaces with remote browsing and editing.
- Auto, confirm, observe, and teaching interaction modes.
- Command prediction, terminal translation, skills, snippets, and local
  knowledge retrieval.
- Windows current-user NSIS installer with a bundled Python sidecar.

Automatic updates are not enabled in this release. Download future installers
from GitHub Releases and verify the published SHA-256 checksum.
