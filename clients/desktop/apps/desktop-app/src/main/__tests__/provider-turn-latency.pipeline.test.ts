/**
 * Migration-streamed history: 64-byte text rows keep seeding bounded;
 * row counts remain 100/2,000/25,000.
 * Known production finding: App Advisor uses prompt_relocation rather than
 * phase 25's append path. Strict rewrite/read guards remain test.failing
 * pending the end-of-stack fix; flips when fixed.
 */
import {
  LATENCY_TEST_TIMEOUT_MS,
  assertNoReadGrowth,
  runLatencyAndFinish,
  type ProviderTurnLatencyRun,
} from './pipeline-harness/scenarios-latency';

describe('real Claude provider-turn pipeline latency: worktree host', () => {
  let smallWorktreeRun: ProviderTurnLatencyRun | undefined;
  it(
    'claude row 100: worktree handoff baseline with nine measured turns',
    async () => {
      smallWorktreeRun = await runLatencyAndFinish('worktree', 100);
    },
    LATENCY_TEST_TIMEOUT_MS,
  );
  it(
    'claude row 25000: worktree handoff remains bounded after streaming migration',
    async () => {
      const largeRun = await runLatencyAndFinish('worktree', 25_000);
      assertNoReadGrowth(largeRun, smallWorktreeRun);
    },
    LATENCY_TEST_TIMEOUT_MS,
  );
});
