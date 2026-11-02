/**
 * Real-host pipeline coverage (rows 8–11 are worktree-only).
 *
 * # | Scenario | Providers | Target invariants
 * 1 | Basic prompt/text/result | Claude, Codex | 11,17,19 (Claude only)
 * 2 | Acknowledged steer | Claude, Codex | 21
 * 3 | Refused generated steer sent once | Claude, Codex | 21
 * 4 | Generated watcher during foreground | Claude, Codex | 13,14
 * 5 | Monkey: drain barrier + slow commits | Claude, Codex | 13,14,15
 * 6 | Rat: two notices + terminal/Stop races | Claude | 13,15,19,21
 * 7 | Slow-commit steer settlement | Claude | 16,21
 * 8 | Native child + root terminal | Claude | 9,5
 * Codex row 8: not applicable; native-work tap observes Claude task events,
 * not Codex collab items.
 * 9 | Settings with live native work | Claude | 12,5
 * 10 | Server-request cancellation | Codex | 18
 * 11 | Watcher registration transport retry | Codex | 20
 * 12 | Self-started wake | Claude, Codex | 19 (Claude only),17
 * 13 | User Stop mid-turn | Claude, Codex | 15,12
 *
 * Rat unknown-attempt rollback: covered by the original unit test
 * (requires a fabricated attempt id); not representable by the real adapter.
 *
 * Worktree: every listed combination. Cowork/App Advisor: Claude rows
 * 1–7,12,13 and Codex rows 1–2. Deadlines use the harness logical clock.
 */
import { defineLifecycleScenarios } from './pipeline-harness/scenarios';

defineLifecycleScenarios('app-advisor');
