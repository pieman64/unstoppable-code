/**
 * @jest-environment jsdom
 */
import {
  MAX_SETUP_DURATION_MS,
  MAX_SETUP_DURATION_PROJECTS,
  readWorktreeSetupDuration,
  recordWorktreeSetupDuration,
  recordWorktreeSetupFromRow,
} from '../worktreeSetupDurations';

const STORAGE_KEY = 'canopy.worktreeSetupDurations.v1';

describe('worktreeSetupDurations', () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.restoreAllMocks();
  });

  it('round-trips the newest valid sample per project', () => {
    recordWorktreeSetupDuration('p1', 25_000, 1_000);
    recordWorktreeSetupDuration('p2', 40_000, 1_000);
    expect(readWorktreeSetupDuration('p1')).toBe(25_000);
    expect(readWorktreeSetupDuration('p2')).toBe(40_000);
    expect(readWorktreeSetupDuration('missing')).toBeNull();

    recordWorktreeSetupDuration('p1', 18_000, 2_000);
    expect(readWorktreeSetupDuration('p1')).toBe(18_000);
  });

  it('ignores a duplicate or out-of-order observation', () => {
    recordWorktreeSetupDuration('p1', 20_000, 5_000);
    // A replayed event arrives later with a longer duration but the same
    // or an older observation time.
    recordWorktreeSetupDuration('p1', 60_000, 5_000);
    recordWorktreeSetupDuration('p1', 60_000, 4_000);
    expect(readWorktreeSetupDuration('p1')).toBe(20_000);
  });

  it('rejects invalid durations', () => {
    for (const duration of [
      0,
      -1,
      Number.NaN,
      Infinity,
      MAX_SETUP_DURATION_MS,
    ]) {
      recordWorktreeSetupDuration('p1', duration, 1_000);
    }
    expect(readWorktreeSetupDuration('p1')).toBeNull();
  });

  it('skips malformed stored entries and keeps valid ones', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        projects: {
          good: { durationMs: 12_000, recordedAt: 1 },
          negative: { durationMs: -5, recordedAt: 1 },
          huge: { durationMs: MAX_SETUP_DURATION_MS + 1, recordedAt: 1 },
          text: { durationMs: '12000', recordedAt: 1 },
          missing: { recordedAt: 1 },
          nullish: null,
        },
      }),
    );
    expect(readWorktreeSetupDuration('good')).toBe(12_000);
    for (const id of ['negative', 'huge', 'text', 'missing', 'nullish']) {
      expect(readWorktreeSetupDuration(id)).toBeNull();
    }
  });

  it('reads malformed containers as empty', () => {
    for (const raw of ['not json', '[]', '{"projects":[]}', 'null']) {
      window.localStorage.setItem(STORAGE_KEY, raw);
      expect(readWorktreeSetupDuration('p1')).toBeNull();
    }
  });

  it('swallows storage read and write failures', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => recordWorktreeSetupDuration('p1', 10_000, 1)).not.toThrow();
    expect(readWorktreeSetupDuration('p1')).toBeNull();
  });

  it('evicts the oldest-recorded project past capacity', () => {
    for (let i = 0; i < MAX_SETUP_DURATION_PROJECTS; i += 1) {
      recordWorktreeSetupDuration(`p${i}`, 10_000, 1_000 + i);
    }
    recordWorktreeSetupDuration('newest', 10_000, 10_000);
    expect(readWorktreeSetupDuration('p0')).toBeNull();
    expect(readWorktreeSetupDuration('p1')).toBe(10_000);
    expect(readWorktreeSetupDuration('newest')).toBe(10_000);
  });

  describe('recordWorktreeSetupFromRow', () => {
    const createdAt = new Date(100_000).toISOString();

    it('records a git-pending row from createdAt to now', () => {
      recordWorktreeSetupFromRow(
        'p1',
        { createdAt, setupPhase: 'git-pending' },
        125_000,
      );
      expect(readWorktreeSetupDuration('p1')).toBe(25_000);
    });

    it('skips missing, ready, invalid and future rows', () => {
      recordWorktreeSetupFromRow('p1', undefined, 125_000);
      recordWorktreeSetupFromRow(
        'p1',
        { createdAt, setupPhase: 'git-ready' },
        125_000,
      );
      recordWorktreeSetupFromRow('p1', { createdAt }, 125_000);
      recordWorktreeSetupFromRow(
        'p1',
        { createdAt: 'not a date', setupPhase: 'git-pending' },
        125_000,
      );
      recordWorktreeSetupFromRow(
        'p1',
        { createdAt, setupPhase: 'git-pending' },
        50_000,
      );
      recordWorktreeSetupFromRow(
        'p1',
        { createdAt, setupPhase: 'git-pending' },
        100_000,
      );
      expect(readWorktreeSetupDuration('p1')).toBeNull();
    });
  });
});
