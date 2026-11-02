# Script and hook goldens (CAN-5062)

These suites pin today's script and hook behavior before Phase 4 moves it into
core and worker code (the CAN-4070 rule: capture behavior, then move it). They
were written against unchanged production code at `develop` `f43429baa9` and need no
test seam. CAN-4153, CAN-4143, CAN-4144, CAN-4146 and CAN-5074 run against them.

| File                             | Pins                                                                                                                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `script-resolver.golden.test.ts` | Script source resolution for single-repo, workspace-root and workspace-repo targets over real config files, the ten source kinds, `conductor.json` fallbacks, disabled layers, config-file candidates and the source-info layer labels |
| `script-runner.golden.test.ts`   | Shell selection on Linux, macOS and Windows, exit codes, spawn errors, output truncation, timeouts, stop, abort, the forced kill, the drain on worktree removal, the archive and Auto Delete fences, and interactive PTY outcomes      |
| `hook-runner.golden.test.ts`     | Per-target queue order, action sequencing, chat if-command outcomes, workflow action outcomes, the archive fence and cancellation by repo target, worktree, hook key and app shutdown                                                  |
| `hook-gates.golden.test.ts`      | The paused gate on automatic hooks, the split lock, the active-PR requirement for manual runs, and the owner gate on organization execution-context overlays                                                                           |
| `hook-chat-queue.golden.test.ts` | Hook chat start and queueing per worktree, the queued placeholder, edits to a queued chat, cancel and force                                                                                                                            |

## What CI runs

Root Jest runs these on Linux in PR CI, through `--findRelatedTests` when a
covered module changes, and in the full merge-queue suite. They do not depend
on the host OS: Windows and macOS shell selection, and the attached spawn on
Windows, are exercised by setting `process.platform`, with the process, path
lookup, Git Bash lookup and kill primitives mocked. Nothing here runs a real
shell, PowerShell, `cmd.exe` or `taskkill`, and real process-group and
Windows tree kills are not exercised. The resolver suite reads real files in a
temporary directory.

## Behavior worth knowing

- `workspace-hook-disabled` and `none` are declared source kinds that the
  resolver never produces: a null top-level manifest script fails config
  validation. `toScriptOverrides` still maps `workspace-hook-disabled` to null.
- In the source-info layers, a script found only in a fallback config file is
  marked overridden once a higher-priority config file exists, so
  `conductor.json` becomes the active layer. This matches resolution, which
  reads only the first config file that exists.
- Queued hook runs are registered for stop requests as soon as they are
  enqueued, so repo-target, worktree and shutdown stops abort them directly.
  The per-target cancellation generation gives the same result for every
  existing caller; the goldens pin that outcome, not the counter.
- Enqueuing a hook chat on an idle worktree that already has a queued chat
  drains the queue at once, and any finished hook chat start drains every
  unblocked worktree.

## Changing a golden

Change an expectation only for an intended behavior change, and name it in
the PR. A ticket that moves the code keeps the expectations and points the
calls at the new owner.
