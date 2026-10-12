# Windows native detector

The native target is `windows-amd64`, using the pinned Mihomo v1.19.32 compatible build (`GOAMD64=v1`). The detector requires Windows 10 / Windows Server 2016 or later. Windows ARM64 and older Windows versions are outside this target.

## Running and pairing

Use an absolute local configuration path inside a dedicated private directory. Pairing creates the final directory if its parent already exists; an existing directory must already satisfy the private ACL policy. For example, a new `%LOCALAPPDATA%\MiSubProbe` directory can hold the configuration:

Windows package distribution is not yet available. These commands require an already available, trusted build with this functionality. The older `probe-v0.1.0` binaries do not support device pairing.

```powershell
.\misub-probe-windows-amd64.exe --pair --server https://misub.example --pair-window PUBLIC_WINDOW_ID --config "$env:LOCALAPPDATA\MiSubProbe\probe.json"
.\misub-probe-windows-amd64.exe --check-config --config "$env:LOCALAPPDATA\MiSubProbe\probe.json"
.\misub-probe-windows-amd64.exe --config "$env:LOCALAPPDATA\MiSubProbe\probe.json"
```

Browser approval and one-use redemption follow the [device-pairing protocol](detector-pairing.md). Pairing exits after saving the configuration. It does not start the core or claim tasks. `--check-config` only validates the local configuration; `--self-test` verifies and executes the embedded core's version command without contacting MiSub or a provider.

The file path is an argument; the token, device secret and node credentials are not. Core stdout and stderr are discarded because upstream diagnostics can contain sensitive data.

## User-level installation management

Run the client as an ordinary user, without elevation. Management commands are mutually exclusive and are separate from pairing and first execution:

```powershell
.\misub-probe-windows-amd64.exe --install
.\misub-probe-windows-amd64.exe --status --json
.\misub-probe-windows-amd64.exe --start
.\misub-probe-windows-amd64.exe --stop
.\misub-probe-windows-amd64.exe --reinstall
.\misub-probe-windows-amd64.exe --uninstall
```

Installation copies the invoking local executable into `%LOCALAPPDATA%\MiSubProbe\install`, records private hashes and a process description, and exits. It does not download a replacement, pair, create credentials or start a process. The default config is `%LOCALAPPDATA%\MiSubProbe\probe.json`; `--install --config <absolute path>` can record a different private config outside the managed tree. Pair separately, then explicitly run `--start`. Config validation must pass before any managed process starts. The installation commands do not create a Windows service, scheduled task, startup entry or PATH modification.

Successful install/reinstall/status show an inspected executable path; JSON status exposes `executablePath`. Quoted text is a path display, not a PowerShell command. To find the installed executable after removing the original file, inspect the fixed `%LOCALAPPDATA%\MiSubProbe\install\manifest.json`: `current` selects the corresponding `<current>\misub-probe.exe`. Invoke that path with PowerShell's normal quoting and call operator. The manifest contains no token. Hashes verify local consistency; they are not a publisher signature.

`--start` creates a hidden detector process with a clean environment and no inherited console or handles. A temporary kill-on-close Job Object is assigned atomically by `CreateProcess` through `STARTUPINFOEX` and `PROC_THREAD_ATTRIBUTE_JOB_LIST`. Before resuming the child, the launcher records its PID, process creation time, full executable path and user SID in private `runtime.json`. The child verifies that record and the installation before becoming ready. Only after the ready signal does the launcher clear its temporary job's kill-on-close setting and relinquish ownership. A launcher crash before this handoff cannot leave a suspended orphan. The child retains a file lease for its identity record while running. These values identify a local process; they are not hardware attestation. Publication, readiness, handoff and cancellation failures reclaim the newly created process rather than silently retrying.

Ready and stop signals use session-local Windows Event objects with protected DACLs granting event access only to the current user and SYSTEM. They expose no TCP port and carry no credential. Starting and stopping require the same user's Windows login session. Before sending a stop request, the client opens and verifies the process's PID, creation time, image and SID. PID reuse never causes the replacement process to be stopped. Graceful cancellation has a 25-second deadline; on expiry, the same verified process handle is terminated and observed exiting. The detector owns its core Job Objects, so its exit terminates contained core descendants. Unknown runtime records, unavailable private events or identity conflicts fail closed.

`--status` reads local state only: a running PID does not prove MiSub connectivity or completed diagnostics, and `connectivity` remains `not_checked`. Authentication rejection stops a running detector; transient network failures reuse its existing identity and configured bounded polling. No management command configures automatic restart or login startup.

Stop before reinstall or uninstall. Reinstall preserves the config and every previous generation while publishing the new generation atomically, then remains stopped. Reinstalling from the currently installed executable is supported. Eight generations are retained at most. Uninstall verifies owned files before deletion and preserves config and the server identity; revoke that identity separately in the site's detector manager when retiring it.

Windows cannot delete an executable that is currently running. If uninstall is invoked from any managed generation, it returns `installation_uninstall_requires_another_trusted_executable` before deleting anything. Run uninstall from another already trusted local copy outside the installation tree. No delayed-delete helper, scheduled task or unknown download is used. Interrupted removal can resume when only known owned files are missing; unknown files, changed files, junctions or unsafe ACLs require inspection and are not recursively removed.

## Private files

Configuration, extracted executable and per-task files use Windows ACLs, independent of POSIX mode bits. Newly created private objects have an explicit current-user owner and a protected DACL granting full access only to that user and SYSTEM. Existing objects are validated through their open handles. An unsafe existing ACL is rejected rather than changed.

Each directory component is opened with reparse-point inspection and held without delete sharing. This prevents ancestor renames and junction substitution while the operation is in progress. Private files must be ordinary disk files with the expected owner and DACL. UNC/device paths, alternate data streams, reserved device names, trailing spaces/dots and unclean paths are rejected. The initial implementation accepts local absolute paths up to 240 characters on volumes supporting persistent ACLs.

Pairing preflight checks private-file creation, flush and hard-link support before requesting an identity. Saving writes and flushes a randomly named private file, then publishes it with a handle-relative link that fails if the destination exists. Concurrent writers have one winner. Temporary names are removed, and a failed or uncertain save retains the existing pairing recovery instruction to revoke and pair again. This provides complete-file publication without overwrite; it does not claim power-loss durability of filesystem metadata.

## Process containment

A Windows-specific launcher creates an unnamed, non-inherited Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. `CreateProcess` atomically assigns Mihomo to this job using `STARTUPINFOEX` and `PROC_THREAD_ATTRIBUTE_JOB_LIST`, with `CREATE_SUSPENDED` and `CREATE_NO_WINDOW`. Membership is verified before its primary thread resumes. Unsupported attribute APIs or membership failures terminate safely with no uncontained fallback. No breakaway flags are set. The core's job retains kill-on-close throughout execution; it is not handed off like the outer detector's startup job.

Cancellation terminates the job and waits for its processes to exit before cleaning task files. Closing the detector process also closes its job handle, terminating associated core descendants. Task cleanup uses held directory roots and does not recursively follow a replacement pathname. The process environment contains only the system directory and private home/temporary paths. The core receives no inherited console or handles.

The core configuration retains loopback-only listeners, authentication, disabled TUN and DNS interception, and the selected-node route. Starting a detector is not evidence that it is connected to MiSub or that a real node has passed a check.

## Locked archive

The official release tag resolves to source commit `88dcbf7f1614a67c3b36b848ee3592dfa92ada36`. These asset properties were verified; `kernel-lock.json` pins the names, hashes and executable size:

| Item | Value |
| --- | --- |
| Archive | `mihomo-windows-amd64-compatible-v1.19.32.zip` |
| Archive bytes | `22525067` |
| Archive SHA256 | `974a4d7ad69aed27aa2e8f91d61113573c14dadb14562c63e58effabf59816f0` |
| Sole executable | `mihomo-windows-amd64-compatible.exe` |
| Executable bytes | `61276672` |
| Executable SHA256 | `04f8d7fc2b314771e1ecbf15951d59f0e1cb7914503c88cfb6972ff6a824e314` |

The build and runtime verify the archive and executable independently. ZIP extraction accepts exactly the locked regular entry, enforces its size, and checks an amd64 PE executable rather than a DLL. It does not extract arbitrary archive paths.

## Acceptance and distribution

Native tests cover ACL rejection, concurrent publication, junction rejection, held directories, hidden processes, environment isolation, job assignment failure, descendant cancellation, detector crash and temporary-file cleanup. The embedded-core fixtures exercise only local loopback proxy/TLS servers, including selected-node routing and refusal to fall back to direct access. Python archive fixtures run without network access.

Installation fixtures additionally cover private runtime publication, foreign files, stopped-only reinstall/uninstall, private Event conflicts and broad ACL rejection, PID reuse and image/SID mismatches, readiness cancellation, self-uninstall preflight and interrupted removal. Crash fixtures force the launcher to exit before resume, verify that successful handoff survives launcher exit, and reclaim children when handoff fails. Core startup has a matching owner-crash fixture. Process tests run short-lived copies of the compiled test executable; they do not execute a configured detector or register a persistent service.

Windows CI must run the native fixture suite, `go test -race`, `go vet`, the CGO-disabled executable build and `--self-test`. The race detector requires a compatible MinGW-w64 compiler; a cross-compile alone does not establish Windows acceptance.

Local tests do not register a service, scheduled task or startup entry, request elevation, change the system proxy/firewall/TUN, or test actual node credentials. A ZIP build is separate from release approval. Binary artifact upload and public release remain behind the existing manual distribution gate while matching-source and dependency-notice work is incomplete; see [hardening and distribution evidence](detector-hardening.md).

Sources: [Mihomo release](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.32), [pinned build matrix](https://github.com/MetaCubeX/mihomo/blob/88dcbf7f1614a67c3b36b848ee3592dfa92ada36/.github/workflows/build.yml), [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew), [CreateEventExW](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-createeventexw), [GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes), [QueryFullProcessImageNameW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew), [Go race detector requirements](https://go.dev/doc/articles/race_detector).
