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
- Model API keys use Windows Credential Manager and are provided to the Python
  sidecar when the selected model is used. Protect the Windows account and its
  local application-data directory accordingly.

## Network connections

Network connections include the following, depending on the features used:

- model requests go to the provider or custom endpoint selected in Settings;
- SSH and SFTP connections go directly to hosts configured by the user;
- opening project or issue links uses the system browser;
- the automatic update check requests the release manifest from GitHub Releases;
- downloading an update retrieves the signed package from GitHub Releases;
- WebView2 may be downloaded by the installer when it is not already present;
- webpage previews and user-initiated knowledge imports or crawling can contact
  the websites or sources selected by the user.

Local semantic retrieval falls back when its embedding model is not cached; it
does not initiate a first-use model download on that path. Remote completion
setup uploads the bundled component over the configured SSH/SFTP connection.

The configured model provider can receive the conversation, selected workspace
context, and tool results required to answer the request. Review terminal output
and attached files before sending sensitive information to a cloud model.

## Updates and deletion

Version 0.9.0 and later check GitHub Releases for a newer signed version after
start-up and at most once per day. That check retrieves a version manifest and
sends no conversation, terminal, file or identity data. Downloading and
installing an update always requires an explicit action in the app, and the
update package signature is verified before installation. Uninstalling the application does not
automatically delete user-created workspaces, skills, or application data;
remove those directories and saved Windows credentials manually if a complete
local reset is required.
