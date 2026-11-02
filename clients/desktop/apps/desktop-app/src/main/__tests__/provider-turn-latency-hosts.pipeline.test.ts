/**
 * Migration-streamed history: 64-byte text rows keep seeding bounded;
 * row counts remain 100/2,000/25,000.
 * Known production finding: App Advisor uses prompt_relocation rather than
 * phase 25's append path. Strict rewrite/read guards remain test.failing
 * pending the end-of-stack fix; flips when fixed.
 */
import type { PipelineHost } from './pipeline-harness/contracts';
import {
  ABSOLUTE_TIMING_OPT_IN,
  LATENCY_TEST_TIMEOUT_MS,
  assertNoReadGrowth,
  runLatencyAndFinish,
  type ProviderTurnLatencyRun,
} from './pipeline-harness/scenarios-latency';

// Split from the worktree latency file so the two run on separate Jest workers.
const OTHER_HOSTS: readonly PipelineHost[] = ['cowork', 'app-advisor'];

describe('real Claude provider-turn pipeline latency: Cowork and App Advisor hosts', () => {
  const otherHostBaselines: Partial<
    Record<PipelineHost, ProviderTurnLatencyRun>
  > = {};
  for (const host of OTHER_HOSTS) {
    // Canonical root turns stopped App Advisor's prompt relocation (phase 35c5a).
    it(
      `claude row 2000: ${host} host keeps provider handoff reads bounded`,
      async () => {
        otherHostBaselines[host] = await runLatencyAndFinish(host, 2_000);
      },
      LATENCY_TEST_TIMEOUT_MS,
    );
  }
  for (const host of OTHER_HOSTS) {
    const testCase = process.env[ABSOLUTE_TIMING_OPT_IN] !== '1' ? it.skip : it;
    testCase(
      `claude row 25000: ${host} opt-in large-history handoff stays bounded`,
      async () => {
        const largeRun = await runLatencyAndFinish(host, 25_000);
        assertNoReadGrowth(largeRun, otherHostBaselines[host]);
      },
      LATENCY_TEST_TIMEOUT_MS,
    );
  }
});
