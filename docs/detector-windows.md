# Windows detector implementation

Add Windows amd64 support using the verified fixed Mihomo 1.19.32 archive, native private-file ACL checks and explicit user-level lifecycle commands. No Windows support is advertised until native CI passes. Package distribution remains paused.

The build verifies both the upstream archive and the sole extracted PE executable. Private config, temporary core files and installation metadata use restricted owner ACLs, reject reparse points and unsafe path substitutions, and publish without implicit overwrite. POSIX permission bits are not treated as an ACL guarantee.

Core children launch without visible windows. A Windows job object contains the child before it runs and terminates its process tree when the detector cancels or closes. Native loopback fixture tests verify routing and cancellation, while job/ACL tests use temporary files and processes only.

User installation preserves configuration and uses explicit start/stop/status/uninstall/reinstall. No administrator service, scheduled task, registry startup, inbound rule, system proxy, TUN, signing credential or security setting is created by repository acceptance. Any supported local background process is under the current user and must have a verifiable identity before stopping it; PID alone is insufficient.

Integration follows the Linux/macOS lifecycle PR. Native CI performs the Windows build, ACL, process-containment, fixture and smoke checks. Real sensitive-node checks, real user installation, code signing and release publication remain separate operational actions.
