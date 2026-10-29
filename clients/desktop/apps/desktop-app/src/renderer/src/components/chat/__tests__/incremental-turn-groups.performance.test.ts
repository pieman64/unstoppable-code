import { buildLongChatMessages } from '@/__tests__/chat-performance-fixtures';
import { measureDurationMs } from '@/lib/perf-test-utils';
import {
  computeIncrementalTurnGroups,
  createEmptyTurnGroupCache,
} from '../incremental-turn-groups';

jest.setTimeout(15_000);

describe('computeIncrementalTurnGroups performance', () => {
  it('scales within a generous regression budget across long transcripts', () => {
    const mediumMessages = buildLongChatMessages({
      turns: 500,
      toolsPerTurn: 3,
      includeSubagents: true,
    });
    const largeMessages = buildLongChatMessages({
      turns: 2_000,
      toolsPerTurn: 5,
      includeSubagents: true,
    });

    const mediumCache = createEmptyTurnGroupCache();
    const largeCache = createEmptyTurnGroupCache();

    const mediumDurationMs = measureDurationMs(() => {
      const groups = computeIncrementalTurnGroups(
        'chat-medium',
        mediumMessages,
        undefined,
        mediumCache,
      );
      expect(groups.length).toBeGreaterThan(0);
    });
    const largeDurationMs = measureDurationMs(() => {
      const groups = computeIncrementalTurnGroups(
        'chat-large',
        largeMessages,
        undefined,
        largeCache,
      );
      expect(groups.length).toBeGreaterThan(0);
    });

    expect(mediumDurationMs).toBeLessThan(2_500);
    expect(largeDurationMs).toBeLessThan(8_000);
    // We intentionally do not assert on the raw `largeDurationMs /
    // mediumDurationMs` ratio: under Jest's parallel worker pool `medium` can
    // complete in single-digit ms on a warm core while `large` lands on a
    // loaded core, producing ratios that swing wildly between runs. The
    // absolute budgets above already catch super-linear regressions — an
    // O(n^2) blowup on the 10k-event fixture would exceed 8s long before the
    // ratio check would fire anyway.
  });

  it('keeps a single large command output manageable', () => {
    const messages = buildLongChatMessages({
      turns: 500,
      toolsPerTurn: 3,
      includeSubagents: true,
      commandOutputChars: 500_000,
    });

    const durationMs = measureDurationMs(() => {
      const groups = computeIncrementalTurnGroups(
        'chat-large-output',
        messages,
        undefined,
        createEmptyTurnGroupCache(),
      );
      expect(groups.length).toBeGreaterThan(0);
    });

    expect(durationMs).toBeLessThan(6_000);
  });
});
