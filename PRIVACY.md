# Privacy and data handling

TDSF Terminal Agent is a desktop Linux operations workbench. It does not send
product analytics or telemetry to the project maintainers by default.

## Data stored on the Windows computer

- Application settings, workspaces, conversation metadata, local knowledge
  indexes, operational logs, and the active model configuration are stored in
  the current user's application-data directories.
- User-installed skills are stored under `%USERPROFILE%\.tdsf\skills`.
- Saved SSH passwords and private-key passphrases use Windows Credential
  Manager. Non-secret SSH profile metadata is stored in the application-data
  directory.
- Model credentials are stored locally and are provided to the Python sidecar
  when the selected model is used. Protect the Windows account and its local
  application-data directory accordingly.

## Network connections

The application makes network connections only for features the user enables:

- model requests go to the provider or custom endpoint selected in Settings;
- SSH and SFTP connections go directly to hosts configured by the user;
- opening project or issue links uses the system browser;
- WebView2 may be downloaded by the installer when it is not already present.

The configured model provider can receive the conversation, selected workspace
context, and tool results required to answer the request. Review terminal output
and attached files before sending sensitive information to a cloud model.

## Updates and deletion

Version 1.0 does not perform automatic update checks. New installers are
published through GitHub Releases. Uninstalling the application does not
automatically delete user-created workspaces, skills, or application data;
remove those directories and saved Windows credentials manually if a complete
local reset is required.
