# Windows background-service startup investigation

## Findings

The packaged Windows 1.19.0 and 1.20.0 failures were caused by the ACL on the
affected user's application-data directories. An unrelated local group had an
allow ACE on the data root and secure-storage directory, and runtime inherited
it. The daemon host's Windows secure-file policy correctly rejected the
additional principal before process creation. The connection layer then
reported only the generic `start_failed` reason, obscuring the preflight stage.

The local profile was repaired by removing only that unrelated ACE. The
owner-only runtime and existing child permissions were rechecked; no file
contents were changed. With an isolated owner-only profile, the installed
daemon started through the owned-child supervisor, connected over its secured
named pipe, reported health `ready`, and was terminated on shutdown. This does
not justify weakening ACL, process-ownership, or pipe-security checks.

## Diagnostic and retry changes

The host can now emit bounded diagnostics for runtime-directory validation,
Windows process-identity verification, owned-child spawn failure, and daemon
exit status. Diagnostics omit raw errors, stderr, environment, credentials,
SIDs, and filesystem paths. Observer exceptions do not change launch or
cleanup behavior. The desktop main process records these diagnostics in its
main log, with successful exits at info severity.

Focused tests cover packaged executable paths containing spaces, safe spawn
failure reporting, transient retry, daemon exit status, identity-verification
failure, cleanup, runtime-permission failure, and diagnostic redaction.

## Windows validation

- Windows ACL suite: 28 tests passed.
- Focused Jest run: 4 suites, 166 tests passed.
- `typecheck:public`, `build:public`, `setup:public`, and
  `start:public --smoke` passed on Windows.
- A separate isolated daemon health probe passed and verified owned-child
  cleanup.
- The full `test:public` wrapper fails before Jest on Windows because it invokes
  `pnpm.cmd` without a command interpreter (`spawnSync pnpm.cmd EINVAL`). A
  direct full Jest run also failed in an unrelated chat-state suite; the full
  suite did not complete cleanly.

## Scope and remaining checks

This exported source does not include the core-daemon entrypoint or release
packaging helpers, so it cannot produce a locally installable Windows
installer. Its `out/` directory is an unpackaged app build; file and folder
operations that require the daemon may not work in that build.

Code Integrity / Smart App Control logged blocks for Electron's
`dxcompiler.dll` and `conpty_console_list.node` in an unpackaged worktree build.
Those events do not establish that the packaged app or `unstoppable-coded.exe`
is blocked. Released binaries and helpers should be checked separately.

The normal installed-app startup after local ACL repair, file and folder
listing, repository inspection, the UI's Try again flow after a transient
failure, and macOS/Linux runtime checks remain to be verified.
