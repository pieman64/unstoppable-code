const mockReadFile = jest.fn<Promise<string>, [string, string]>();
const mockWriteFile = jest.fn<Promise<void>, [string, string, string]>();
const mockMkdir = jest.fn<Promise<void>, [string, { recursive: boolean }]>();
const mockRename = jest.fn<Promise<void>, [string, string]>();
const mockUnlink = jest.fn<Promise<void>, [string]>();
const mockSync = jest.fn<Promise<void>, []>();

jest.mock('node:fs/promises', () => ({
  mkdir: (path: string, options: { recursive: boolean }): Promise<void> =>
    mockMkdir(path, options),
  readFile: (path: string, encoding: string): Promise<string> =>
    mockReadFile(path, encoding),
  writeFile: (
    path: string,
    contents: string,
    encoding: string,
  ): Promise<void> => mockWriteFile(path, contents, encoding),
  rename: (from: string, to: string): Promise<void> => mockRename(from, to),
  unlink: (path: string): Promise<void> => mockUnlink(path),
  // Atomic write path: open -> writeFile -> sync -> close -> rename. The
  // handle mock records through `mockWriteFile` so existing assertions on
  // written contents keep working.
  open: (path: string): Promise<unknown> =>
    Promise.resolve({
      writeFile: (contents: string, encoding: string): Promise<void> =>
        mockWriteFile(path, contents, encoding),
      sync: (): Promise<void> => mockSync(),
      close: (): Promise<void> => Promise.resolve(),
    }),
}));

// Mirrors the real `getActivationJourneyFilePath()` shape
// (`<dataDir>/activation-journey.json`) so assertions pin the filename and
// parent directory the production helper resolves.
const mockDataDir = '/mock/data-dir';
const mockFilePath = `${mockDataDir}/activation-journey.json`;

jest.mock('../lib/paths', () => ({
  getActivationJourneyFilePath: (): string => mockFilePath,
}));

import {
  assignHoldout,
  latchActivationSignal,
  latchCampaignSent,
  drainActivationJourneyWrites,
  clearSequenceSuppressed,
  latchCampaignSuppressed,
  releaseDeliveryFailures,
  unlatchCampaignDeliveryFailure,
  latchSequenceStepClicked,
  latchSequenceStepSent,
  latchSequenceStepSuppressed,
  latchSequenceSuppressed,
  readActivationJourneyState,
  unlatchSequenceStepDeliveryFailure,
  recordActivity,
  recordFirstOpen,
  resetActivationJourneyStateForTests,
} from '../notifications/campaigns/journey-state';

function enoent(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error('ENOENT');
  error.code = 'ENOENT';
  return error;
}

async function flushWrites(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  resetActivationJourneyStateForTests();
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockRename.mockResolvedValue(undefined);
  mockUnlink.mockResolvedValue(undefined);
  mockSync.mockResolvedValue(undefined);
  mockReadFile.mockRejectedValue(enoent());
});

describe('readActivationJourneyState', () => {
  it('returns empty defaults when the file is missing', async () => {
    const state = await readActivationJourneyState();
    expect(state).toEqual({
      firstOpenAt: null,
      lastActiveAt: null,
      holdout: null,
      campaigns: {},
      signals: {},
      gettingStarted: { steps: {} },
    });
  });

  it('returns empty defaults for corrupt JSON', async () => {
    mockReadFile.mockResolvedValue('{not json');
    const state = await readActivationJourneyState();
    expect(state.firstOpenAt).toBeNull();
    expect(state.campaigns).toEqual({});
  });

  it('returns empty defaults for an unknown version', async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: 999,
        firstOpenAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    const state = await readActivationJourneyState();
    expect(state.firstOpenAt).toBeNull();
  });

  it('drops campaign entries with unknown ids or reasons', async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        firstOpenAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: null,
        holdout: false,
        campaigns: {
          'activation-marketplace': { suppressedReason: 'expired' },
          'not-a-campaign': { sentAt: '2026-01-01T00:00:00.000Z' },
          'activation-mobile': { suppressedReason: 'not-a-reason' },
        },
      }),
    );
    const state = await readActivationJourneyState();
    expect(state.campaigns['activation-marketplace']?.suppressedReason).toBe(
      'expired',
    );
    expect(Object.keys(state.campaigns)).toEqual([
      'activation-marketplace',
      'activation-mobile',
    ]);
    expect(
      state.campaigns['activation-mobile']?.suppressedReason,
    ).toBeUndefined();
  });
});

describe('recordFirstOpen', () => {
  it('records the anchor exactly once', async () => {
    const first = await recordFirstOpen('2026-01-01T00:00:00.000Z');
    const second = await recordFirstOpen('2026-02-02T00:00:00.000Z');
    expect(first.changed).toBe(true);
    expect(first.state.firstOpenAt).toBe('2026-01-01T00:00:00.000Z');
    expect(second.changed).toBe(false);
    expect(second.state.firstOpenAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('persists the anchor atomically to the resolved file path', async () => {
    await recordFirstOpen('2026-01-01T00:00:00.000Z');
    await flushWrites();
    expect(mockMkdir).toHaveBeenCalledWith(mockDataDir, { recursive: true });
    // Write-and-rename: a torn write would make the reader fall back to empty
    // state and discard every send latch.
    const [tempPath, contents] = mockWriteFile.mock.calls[0];
    expect(tempPath).toMatch(
      /^\/mock\/data-dir\/activation-journey\.json\..*\.tmp$/,
    );
    expect(mockSync).toHaveBeenCalled();
    expect(mockRename).toHaveBeenCalledWith(tempPath, mockFilePath);
    const parsed: unknown = JSON.parse(contents);
    expect(parsed).toMatchObject({
      version: 1,
      firstOpenAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('removes the temp file and keeps the old state when the write fails', async () => {
    mockWriteFile.mockRejectedValueOnce(new Error('ENOSPC'));
    await recordFirstOpen('2026-01-01T00:00:00.000Z');
    await flushWrites();
    expect(mockRename).not.toHaveBeenCalled();
    expect(mockUnlink).toHaveBeenCalled();
  });
});

describe('recordActivity', () => {
  it('advances lastActiveAt on each call', async () => {
    await recordActivity('2026-01-01T00:00:00.000Z');
    const second = await recordActivity('2026-01-01T01:00:00.000Z');
    expect(second.state.lastActiveAt).toBe('2026-01-01T01:00:00.000Z');
  });

  it('throttles rapid samples so focus churn does not hit the disk', async () => {
    await recordActivity('2026-01-01T00:00:00.000Z');
    // Flush the first write before clearing, or its async tail lands after
    // the clear and the assertion below reads it as a throttle failure.
    await flushWrites();
    mockWriteFile.mockClear();
    const soon = await recordActivity('2026-01-01T00:00:30.000Z');
    await flushWrites();
    expect(soon.changed).toBe(false);
    expect(soon.state.lastActiveAt).toBe('2026-01-01T00:00:00.000Z');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('records once the throttle window has passed', async () => {
    await recordActivity('2026-01-01T00:00:00.000Z');
    const later = await recordActivity('2026-01-01T00:01:01.000Z');
    expect(later.changed).toBe(true);
    expect(later.state.lastActiveAt).toBe('2026-01-01T00:01:01.000Z');
  });

  it('never moves lastActiveAt backwards', async () => {
    await recordActivity('2026-01-01T05:00:00.000Z');
    const stale = await recordActivity('2026-01-01T01:00:00.000Z');
    expect(stale.changed).toBe(false);
    expect(stale.state.lastActiveAt).toBe('2026-01-01T05:00:00.000Z');
  });
});

describe('assignHoldout', () => {
  it('assigns once and never re-rolls', async () => {
    const first = await assignHoldout(true);
    const second = await assignHoldout(false);
    expect(first.state.holdout).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.state.holdout).toBe(true);
  });
});

describe('latchActivationSignal', () => {
  it('records the first observation and keeps it', async () => {
    const first = await latchActivationSignal(
      'first-task-submitted',
      '2026-01-01T00:00:00.000Z',
    );
    const later = await latchActivationSignal(
      'first-task-submitted',
      '2026-06-01T00:00:00.000Z',
    );
    expect(first.changed).toBe(true);
    expect(later.changed).toBe(false);
    // The earliest observation wins: a re-observation must not make a
    // long-active user look freshly activated.
    expect(later.state.signals['first-task-submitted']).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('drops unknown signal names on read', async () => {
    resetActivationJourneyStateForTests();
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        firstOpenAt: null,
        lastActiveAt: null,
        holdout: null,
        campaigns: {},
        signals: { 'mobile-paired': '2026-01-01T00:00:00.000Z', bogus: 'x' },
      }),
    );
    const state = await readActivationJourneyState();
    expect(Object.keys(state.signals)).toEqual(['mobile-paired']);
  });
});

describe('campaign latches', () => {
  it('latches a send and refuses to re-latch', async () => {
    const first = await latchCampaignSent(
      'activation-marketplace',
      '2026-01-01T00:00:00.000Z',
    );
    const second = await latchCampaignSent(
      'activation-marketplace',
      '2026-01-02T00:00:00.000Z',
    );
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.state.campaigns['activation-marketplace']?.sentAt).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('does not let a suppression overwrite a completed send', async () => {
    await latchCampaignSent(
      'activation-marketplace',
      '2026-01-01T00:00:00.000Z',
    );
    const suppressed = await latchCampaignSuppressed(
      'activation-marketplace',
      'expired',
      '2026-01-02T00:00:00.000Z',
    );
    expect(suppressed.changed).toBe(false);
    expect(
      suppressed.state.campaigns['activation-marketplace']?.suppressedReason,
    ).toBeUndefined();
  });

  it('serializes concurrent latches without dropping any', async () => {
    await Promise.all([
      latchCampaignSent('activation-marketplace', '2026-01-01T00:00:00.000Z'),
      latchCampaignSuppressed(
        'activation-mobile',
        'not-eligible',
        '2026-01-01T00:00:00.000Z',
      ),
      latchCampaignSuppressed(
        'activation-first-task',
        'holdout',
        '2026-01-01T00:00:00.000Z',
      ),
    ]);
    const state = await readActivationJourneyState();
    expect(state.campaigns['activation-marketplace']?.sentAt).toBeDefined();
    expect(state.campaigns['activation-mobile']?.suppressedReason).toBe(
      'not-eligible',
    );
    expect(state.campaigns['activation-first-task']?.suppressedReason).toBe(
      'holdout',
    );
  });

  it('keeps in-memory state authoritative when a write fails', async () => {
    mockWriteFile.mockRejectedValue(new Error('disk full'));
    await latchCampaignSent(
      'activation-marketplace',
      '2026-01-01T00:00:00.000Z',
    );
    await flushWrites();
    const state = await readActivationJourneyState();
    expect(state.campaigns['activation-marketplace']?.sentAt).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });
});

describe('getting started sequence latches (CAN-3013)', () => {
  const NOW = '2026-01-02T00:00:00.000Z';
  const LATER = '2026-01-03T00:00:00.000Z';

  it('reads a file written before the sequence existed as an empty sequence', async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        firstOpenAt: NOW,
        lastActiveAt: null,
        holdout: null,
        campaigns: { 'activation-mobile': { sentAt: NOW } },
        signals: {},
      }),
    );
    const state = await readActivationJourneyState();
    expect(state.gettingStarted).toEqual({ steps: {} });
    // The pre-existing latch must survive: losing it would re-fire a campaign.
    expect(state.campaigns['activation-mobile']?.sentAt).toBe(NOW);
  });

  it('latches a step send once and persists it', async () => {
    expect((await latchSequenceStepSent('start-chat', NOW)).changed).toBe(true);
    expect((await latchSequenceStepSent('start-chat', LATER)).changed).toBe(
      false,
    );
    await drainActivationJourneyWrites();

    const written: unknown = JSON.parse(
      mockWriteFile.mock.calls.at(-1)?.[1] ?? '{}',
    );
    expect(written).toMatchObject({
      gettingStarted: { steps: { 'start-chat': { sentAt: NOW } } },
    });
  });

  it('does not let a suppression overwrite a step that sent', async () => {
    await latchSequenceStepSent('start-chat', NOW);
    const result = await latchSequenceStepSuppressed(
      'start-chat',
      'not-eligible',
      LATER,
    );
    expect(result.changed).toBe(false);
  });

  it('clears the sequence-level block when a step sends', async () => {
    await latchSequenceSuppressed('quiet-hours', NOW);
    expect((await latchSequenceSuppressed('quiet-hours', LATER)).changed).toBe(
      false,
    );
    await latchSequenceStepSent('create-account', LATER);

    const state = await readActivationJourneyState();
    expect(state.gettingStarted?.suppressedReason).toBeUndefined();
    // Tomorrow's quiet-hours block is a new funnel event, not a duplicate.
    expect((await latchSequenceSuppressed('quiet-hours', LATER)).changed).toBe(
      true,
    );
  });

  it('counts a repeat dismissal once the block was cleared', async () => {
    // Restore -> (not yet due) -> re-dismiss: without the clear, the second
    // dismissal dedupes against the first and emits no funnel event.
    await latchSequenceSuppressed('checklist-dismissed', NOW);
    expect((await clearSequenceSuppressed()).changed).toBe(true);
    expect((await clearSequenceSuppressed()).changed).toBe(false);
    expect(
      (await readActivationJourneyState()).gettingStarted?.suppressedReason,
    ).toBeUndefined();
    expect(
      (await latchSequenceSuppressed('checklist-dismissed', LATER)).changed,
    ).toBe(true);
  });

  it('releases delivery-failed holds only once they are old enough', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    await latchCampaignSent('activation-marketplace', NOW);
    await unlatchCampaignDeliveryFailure('activation-marketplace', NOW);
    await latchSequenceStepSent('start-chat', NOW);
    await unlatchSequenceStepDeliveryFailure('start-chat', NOW);

    // Too young: the focus-anchor write must not re-ask a denied OS.
    const soon = new Date(Date.parse(NOW) + 60_000).toISOString();
    expect((await releaseDeliveryFailures(soon, DAY)).changed).toBe(false);
    const held = await readActivationJourneyState();
    expect(held.campaigns['activation-marketplace']?.suppressedReason).toBe(
      'delivery-failed',
    );
    expect(held.gettingStarted?.steps['start-chat']?.suppressedReason).toBe(
      'delivery-failed',
    );

    // Old enough: both sides release together.
    const later = new Date(Date.parse(NOW) + DAY).toISOString();
    expect((await releaseDeliveryFailures(later, DAY)).changed).toBe(true);
    const released = await readActivationJourneyState();
    expect(
      released.campaigns['activation-marketplace']?.suppressedReason,
    ).toBeUndefined();
    expect(
      released.gettingStarted?.steps['start-chat']?.suppressedReason,
    ).toBeUndefined();
    // Other reasons are not touched.
    await latchCampaignSuppressed('activation-mobile', 'quiet-hours', later);
    expect((await releaseDeliveryFailures(later, DAY)).changed).toBe(false);
  });

  it('unlatches only a step that is currently latched as sent', async () => {
    expect(
      (await unlatchSequenceStepDeliveryFailure('start-chat', NOW)).changed,
    ).toBe(false);
    await latchSequenceStepSent('start-chat', NOW);
    const result = await unlatchSequenceStepDeliveryFailure(
      'start-chat',
      LATER,
    );
    expect(result.changed).toBe(true);
    expect(result.state.gettingStarted?.steps['start-chat']).toMatchObject({
      suppressedReason: 'delivery-failed',
    });
  });

  it('records a click once', async () => {
    expect((await latchSequenceStepClicked('start-chat', NOW)).changed).toBe(
      true,
    );
    expect((await latchSequenceStepClicked('start-chat', LATER)).changed).toBe(
      false,
    );
  });

  it('drops a step id the checklist no longer defines', async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        firstOpenAt: NOW,
        lastActiveAt: null,
        holdout: null,
        campaigns: {},
        signals: {},
        gettingStarted: {
          steps: {
            'run-pipeline': { sentAt: NOW },
            'start-chat': { sentAt: NOW },
          },
        },
      }),
    );
    const state = await readActivationJourneyState();
    expect(Object.keys(state.gettingStarted?.steps ?? {})).toEqual([
      'start-chat',
    ]);
  });
});
