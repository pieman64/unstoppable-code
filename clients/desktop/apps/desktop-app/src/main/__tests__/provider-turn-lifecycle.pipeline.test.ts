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
 * 1–7,12,13 and Codex rows 1–5,12,13. Deadlines use the harness logical clock.
 */
import {
  createScenarioEnvironment,
  defineLifecycleScenarios,
  disposeScenario,
  finishScenario,
  scenarioContext,
  SCENARIO_TEST_TIMEOUT_MS,
  startRoot,
} from './pipeline-harness/scenarios';
import {
  checkInvariants,
  formatViolations,
} from './pipeline-harness/invariants';
import type { PipelineTraceEvent } from './pipeline-harness/contracts';

defineLifecycleScenarios('worktree', [5, 6, 7, 8, 9, 10, 11]);

it(
  'detects an illegal intermediate transcript rewrite in a real basic-turn trace',
  async () => {
    const env = await createScenarioEnvironment('worktree', 'claude', {
      emulateClaudeRootReceipt: true,
    });
    try {
      const turn = await startRoot(env, 'corruption control prompt');
      await turn.complete();
      await finishScenario(env, [11, 17, 19], true, 1);
      const trace = env.harness.recorder.events;
      const selected = trace.find(
        (event) =>
          event.kind === 'transcript' &&
          event.previous &&
          event.previous.committedBytes > 0,
      );
      if (!selected || selected.kind !== 'transcript' || !selected.previous) {
        throw new Error(
          'Basic turn did not capture append-only transcript evidence',
        );
      }
      const previous = selected.previous;
      const corrupted: readonly PipelineTraceEvent[] = trace.map((event) =>
        event === selected
          ? {
              ...selected,
              previous: { ...previous, prefixSha256: '0'.repeat(64) },
            }
          : event,
      );
      const violations = checkInvariants(
        corrupted,
        scenarioContext(env.secrets),
      );
      const expectedSeqs: unknown = expect.arrayContaining([selected.seq]);
      expect(violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 17,
            seqs: expectedSeqs,
          }),
        ]),
      );
      const formatted = formatViolations(violations, corrupted);
      expect(formatted).toContain('Invariant 17:');
      expect(formatted).toContain(`seq=${selected.seq}`);
      expect(checkInvariants(trace, scenarioContext(env.secrets))).toEqual([]);
    } finally {
      await disposeScenario(env);
    }
  },
  SCENARIO_TEST_TIMEOUT_MS,
);
