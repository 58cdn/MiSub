# User-level detector installation

This PR provides inspectable Linux/macOS installation management for a locally available, verified detector executable. Package distribution remains paused. Installation copies the current executable into a private user-owned directory and records a manifest and service description; it does not pair, create credentials or start a process.

Explicit start/stop/status commands use the current user's service manager. Linux uses systemd user units without enable, WantedBy, root services or linger. macOS keeps its plist in the private installation directory and loads it explicitly, outside the automatic Login/LaunchAgents directories. No system proxy, TUN, public listener, elevation or security-setting change is involved.

Reinstallation preserves a validated private config and requires the process to be stopped; uninstall removes only manifest-owned installation files after verifying their paths and preserves the private config. Existing files, symlinks, unknown modifications and concurrent operations fail safely. Service launch arguments contain a config path, never its credential contents. Status distinguishes a running process from server connectivity. Runtime network retries remain bounded and authentication failures stop.

Acceptance uses temporary files and fake command runners. Native CI checks platform-specific syntax and lifecycle fixtures without registering services or enabling login startup. Real installation, pairing and service execution on user devices are separate explicit operations. Windows installation is a subsequent PR.
