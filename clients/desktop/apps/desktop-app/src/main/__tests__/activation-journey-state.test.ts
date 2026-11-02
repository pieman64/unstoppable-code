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
  latchCampaignSuppressed,
  releaseDeliveryFailures,
  unlatchCampaignDeliveryFailure,
  readActivationJourneyState,
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

describe('retired checklist history', () => {
  it('retains only valid legacy send timestamps across an ordinary save', async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        gettingStarted: {
          steps: {
            'start-chat': {
              sentAt: '2026-01-01T00:00:00.000Z',
              clickedAt: 'old',
              suppressedReason: 'quiet-hours',
            },
            'create-account': { sentAt: 'invalid' },
            unknown: { sentAt: '2026-01-02T00:00:00.000Z' },
          },
          suppressedReason: 'checklist-dismissed',
        },
      }),
    );
    await recordActivity('2026-01-03T00:00:00.000Z');
    await drainActivationJourneyWrites();
    const state = await readActivationJourneyState();
    expect(state.gettingStarted).toEqual({
      steps: {
        'start-chat': { sentAt: '2026-01-01T00:00:00.000Z' },
      },
    });
    expect(JSON.parse(mockWriteFile.mock.lastCall?.[1] ?? '{}')).toHaveProperty(
      'gettingStarted',
      state.gettingStarted,
    );
  });
});

it('retains the ordinary campaign delivery-failure hold until an event after the daily window', async () => {
  const at = '2026-10-20T00:00:00.000Z';
  await latchCampaignSent('activation-mobile', at);
  await unlatchCampaignDeliveryFailure('activation-mobile', at);
  expect(
    (await releaseDeliveryFailures('2026-10-20T01:00:00.000Z', 86400000))
      .changed,
  ).toBe(false);
  expect(
    (await readActivationJourneyState()).campaigns['activation-mobile']
      ?.suppressedReason,
  ).toBe('delivery-failed');
  expect(
    (await releaseDeliveryFailures('2026-10-21T01:00:00.000Z', 86400000))
      .changed,
  ).toBe(true);
  expect(
    (await readActivationJourneyState()).campaigns['activation-mobile']
      ?.suppressedReason,
  ).toBeUndefined();
});
