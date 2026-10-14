# User-level detector installation

Distribution is currently paused: the site does not offer installation or online recovery commands for the old releases. Existing clients, configuration and server identities are preserved. The [one-command guide](detector-one-command-install.md) describes the flow available after a validated replacement release is enabled. This document covers advanced management of an existing verified local executable. Direct `--install` copies that executable and writes a private manifest; it does not download updates, pair, create credentials, contact MiSub or start a process. Direct `--pair` saves configuration, and `--start` starts an installed client. Local manifest hashes detect changed files; they do not authenticate the original executable's source.

## Commands

Run as an ordinary user. The examples use a local executable named `misub-probe`; replace it with the actual local path. Management commands are mutually exclusive and cannot be combined with pairing, diagnostic or execution flags.

| Command                                                         | Effect                                                                                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./misub-probe --install`                                       | Copy the current executable and write a private manifest and service description. Default config: `$HOME/.misub-probe/probe.json`.                      |
| `./misub-probe --install --config /absolute/private/probe.json` | Record an explicit absolute config path, outside the managed installation tree. The config may be created later by a separate pairing command.          |
| `./misub-probe --start`                                         | Validate installation and private config, then explicitly start the current user's service. Already running is idempotent.                              |
| `./misub-probe --stop`                                          | Stop the owned service and confirm it no longer has a running PID.                                                                                      |
| `./misub-probe --status --json`                                 | Read installed version, verified executable path, platform, process state, PID when available and registration state.                                   |
| `./misub-probe --reinstall`                                     | Require a stopped service and valid existing config, copy the invoking executable into a new generation and preserve the same config path and contents. |
| `./misub-probe --uninstall`                                     | Require a stopped service, unregister its temporary service entry and remove verified installation files. Preserve config and server identity.          |

Install first, complete [device pairing](detector-pairing-api.md) separately if no config exists, then run `--start` explicitly. Pairing saves config and exits. Each later start is another explicit action. Reinstall copies whichever executable is being invoked, so invoke the intended replacement version.

Successful install, reinstall and status display the installed executable path, and status JSON exposes `executablePath`. The text uses quoted string display for inspection; it is not a shell command. Invoke that path with your shell's normal quoting to manage the installation. PATH is not modified. If the original local executable is no longer available, inspect the fixed `$HOME/.misub-probe/install/manifest.json`: its `current` value identifies `$HOME/.misub-probe/install/<current>/misub-probe`. This manifest contains no token. Management validates the manifest and installed files before accepting an existing executable path as verified.

Reinstallation never changes the credential or automatically restarts the service. At most eight generations are retained. At this limit, explicitly stop and uninstall, then install the desired local executable; the config remains available. Uninstall does not revoke the detector identity in MiSub. Revoke it separately in the site's detector manager when retiring the device.

## Files and ownership

The fixed installation directory is `$HOME/.misub-probe/install`. Each generation contains `misub-probe` and its service description. Directories and executable files require mode `0700`; manifest, service description and lock require `0600`, owned by the current user. Config requires a private `0700` parent directory and `0600` regular file. Config cannot be located inside the installation tree. No credential contents enter service arguments, environment variables, manifests or status output.

Filesystem operations use rooted handles, validate ownership and reject symbolic links, unsafe ancestors, replacement paths, unknown files and modified owned files. Initial publication does not overwrite an existing manifest. Reinstall publishes a complete generation using an atomic manifest replacement. Mutations take an exclusive nonblocking lock. Uninstall deletes only exact validated entries, permits resuming a partially completed deletion and leaves the private directory and empty lock file. Conflicts require inspection; the client does not recursively remove an unfamiliar directory or repair permissions.

Linux executable paths support spaces, literal `$` and `%`. Quotes, backslashes and control characters in the executable path are rejected because systemd disallows them. Config argument quoting is separate. A root-owned or current-user-owned source executable is accepted only when it is a regular executable without group/world write permission.

## Service lifetime and status

Linux requires an available systemd user session. Explicit start uses a runtime link, daemon reload and start, with no `enable`, `WantedBy`, system service or linger. The service uses `Restart=no`, `KillMode=control-group`, a 20-second stop timeout and a private umask. The `ExecStart` `:` prefix disables environment substitution while literal percent signs are escaped. These behaviors follow the upstream [systemctl interface](https://github.com/systemd/systemd/blob/main/man/systemctl.xml) and [command parser](https://github.com/systemd/systemd/blob/v257/src/core/load-fragment.c#L847).

macOS requires the current user's GUI launchd domain. The plist remains in the private installation directory, outside automatically loaded LaunchAgents directories. Explicit start calls `bootstrap` then `kickstart`; stop calls `bootout`. `RunAtLoad` and `KeepAlive` are false, and process-group cleanup is retained. The [Apple plist reference](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5) documents these settings. Native CI reads the installed `launchctl help` for the modern commands. No fallback service is installed when a user session is unavailable.

Service commands use fixed absolute manager paths, argument arrays, bounded execution and sanitized errors. Foreign service definitions, persistent enablement, Linux drop-ins and unknown manager output fail closed. The macOS status parser recognizes specific top-level `launchctl print` fields; unrecognized output is an error. Service-manager command output is never forwarded to the terminal.

`--status` performs no network request. `connectivity` is always `not_checked`, and `autostart` is `not_configured`. A running PID does not prove server connectivity, successful pairing or completed diagnostics. Install reports process state `not_checked` because it does not contact the service manager. Unavailable managers and conflicts return an error, not a healthy state.

While a started detector remains alive, transient network failures retry at the configured 30–300-second poll interval with bounded HTTP requests and cancellation. It keeps its existing identity. HTTP 401/403 stops the process; it does not enroll again. Process crashes and logout/reboot do not trigger an installer-configured restart or login startup. No system proxy, TUN, public listener, elevation or security-setting change is performed by management commands.

## Validation boundary

Acceptance uses temporary directories, fake command runners and in-memory HTTP transports. It covers ownership, permissions, no-clobber publication, unknown files, config preservation, interrupted uninstall, command ordering, conflict handling, offline recovery and revocation. Native CI checks generated units with `systemd-analyze verify`, generated plists with `plutil -lint`, and command help without registering services. These checks do not establish that a real user service starts successfully on a specific device. Real installation, pairing and service execution remain separate explicit user operations. For Windows process management and private-file requirements, see the [native Windows guide](detector-windows.md).
