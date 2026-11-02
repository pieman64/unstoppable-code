import {
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import type { DailyCreditDripPreferenceSaveResult } from '@canopy/protocol/billing';
import {
  captureDailyCreditGrantAccount,
  clearDailyCreditGrantStatus,
  getLastDailyCreditGrantStatus,
  recordDailyCreditGrantFromBalance,
  recordDailyCreditGrantFromSave,
  resetDailyCreditGrantTelemetryForTests,
} from '../lib/daily-credit-grant-telemetry';

const mockPeekAccount = jest.fn();
let mockAccountChange: (() => void) | undefined;
jest.mock('../lib/canopy-cloud-account-store', () => ({
  peekCanopyCloudAccount: (): unknown => mockPeekAccount(),
  subscribeCanopyCloudAccountChanges: (listener: () => void): (() => void) => {
    mockAccountChange = listener;
    return () => undefined;
  },
}));

jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  startDesktopOperation: jest.fn(),
  succeedDesktopOperation: jest.fn(),
}));

let mockCaptureState: { readonly enabled: boolean } | undefined;
const mockForwardedContexts: Array<Record<string, unknown>> = [];
let mockCaptureListener: (() => void) | undefined;
jest.mock('../lib/posthog-operation-capture-gate', () => ({
  getPostHogOperationCaptureState: (): typeof mockCaptureState =>
    mockCaptureState,
  subscribePostHogOperationCaptureChanges: (
    listener: () => void,
  ): (() => void) => {
    mockCaptureListener = listener;
    return () => undefined;
  },
}));

function applyCapture(enabled: boolean): void {
  if (mockCaptureState?.enabled === enabled) return;
  mockCaptureState = { enabled };
  mockCaptureListener?.();
}

const flushScheduledTelemetry = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

// 2026-07-09 12:00 PDT; the Pacific day rolls at 07:00 UTC.
const NOON_PT = new Date('2026-07-09T19:00:00.000Z');
const NEXT_PT_DAY = new Date('2026-07-10T07:30:00.000Z');

function emitted(): Array<Record<string, unknown>> {
  const calls = jest.mocked(succeedDesktopOperation).mock.calls;
  return calls.map(([name, options]) => {
    expect(name).toBe('canopy.daily_credit_grant');
    return { ...(options?.context ?? {}) };
  });
}

function saveResult(
  overrides: Partial<DailyCreditDripPreferenceSaveResult>,
): DailyCreditDripPreferenceSaveResult {
  return {
    enabled: true,
    decidedAt: '2026-07-09T19:00:00.000Z',
    capCredits: 10,
    balanceCredits: 10,
    granted: 0,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCaptureState = { enabled: true };
  mockForwardedContexts.length = 0;
  jest.mocked(succeedDesktopOperation).mockImplementation((_name, options) => {
    if (mockCaptureState?.enabled)
      mockForwardedContexts.push({ ...options?.context });
  });
  mockPeekAccount.mockReturnValue({ account: { id: 'account-a' } });
  resetDailyCreditGrantTelemetryForTests();
});

describe('daily credit grant telemetry (CAN-4633)', () => {
  it('reports a balance-read grant with its amount, paired start and finish', async () => {
    recordDailyCreditGrantFromBalance(
      { dailyDripOutcome: 'granted', dailyDripGrantedCredits: 10 },
      NOON_PT,
    );
    await flushScheduledTelemetry();

    expect(emitted()).toEqual([
      {
        grant_status: 'granted',
        grant_amount: 10,
        grant_source: 'balance_read',
      },
    ]);
    const start = jest.mocked(startDesktopOperation).mock.calls[0];
    const finish = jest.mocked(succeedDesktopOperation).mock.calls[0];
    expect(start?.[1]?.operationKey).toBe(finish?.[1]?.operationKey);
  });

  it('reports a block with its reason and no amount', async () => {
    recordDailyCreditGrantFromBalance(
      { dailyDripOutcome: 'blocked', dailyDripBlockedReason: 'network_limit' },
      NOON_PT,
    );
    await flushScheduledTelemetry();

    expect(emitted()).toEqual([
      {
        grant_status: 'blocked',
        grant_blocked_reason: 'network_limit',
        grant_source: 'balance_read',
      },
    ]);
  });

  it('reports each status once per Pacific day, and again the next day', async () => {
    const blocked = {
      dailyDripOutcome: 'blocked',
      dailyDripBlockedReason: 'network_unidentified',
    };
    recordDailyCreditGrantFromBalance(blocked, NOON_PT);
    recordDailyCreditGrantFromBalance(blocked, NOON_PT);
    recordDailyCreditGrantFromBalance({ dailyDripOutcome: 'at_cap' }, NOON_PT);
    recordDailyCreditGrantFromBalance(blocked, NEXT_PT_DAY);
    await flushScheduledTelemetry();

    expect(emitted().map((context) => context.grant_status)).toEqual([
      'blocked',
      'at_cap',
      'blocked',
    ]);
  });

  it('treats a different block reason as a new status', async () => {
    recordDailyCreditGrantFromBalance(
      { dailyDripOutcome: 'blocked', dailyDripBlockedReason: 'network_limit' },
      NOON_PT,
    );
    recordDailyCreditGrantFromBalance(
      {
        dailyDripOutcome: 'blocked',
        dailyDripBlockedReason: 'network_unidentified',
      },
      NOON_PT,
    );
    await flushScheduledTelemetry();

    expect(emitted().map((context) => context.grant_blocked_reason)).toEqual([
      'network_limit',
      'network_unidentified',
    ]);
  });

  it('does not repeat a grant it already reported as already granted', async () => {
    recordDailyCreditGrantFromSave(saveResult({ granted: 10 }), NOON_PT);
    recordDailyCreditGrantFromBalance(
      { dailyDripOutcome: 'already_granted' },
      NOON_PT,
    );
    await flushScheduledTelemetry();

    expect(emitted()).toEqual([
      {
        grant_status: 'granted',
        grant_amount: 10,
        grant_source: 'opt_in_save',
      },
    ]);
  });

  it('reports a blocked turn-on save, and ignores a turn-off or unknown outcome', async () => {
    recordDailyCreditGrantFromSave(
      saveResult({ granted: 0, blockedReason: 'network_limit' }),
      NOON_PT,
    );
    recordDailyCreditGrantFromSave(saveResult({ enabled: false }), NOON_PT);
    recordDailyCreditGrantFromSave(saveResult({ granted: 0 }), NOON_PT);
    await flushScheduledTelemetry();

    expect(emitted()).toEqual([
      {
        grant_status: 'blocked',
        grant_blocked_reason: 'network_limit',
        grant_source: 'opt_in_save',
      },
    ]);
  });

  it('ignores an older server or a malformed balance body', async () => {
    recordDailyCreditGrantFromBalance({ credits: 3 }, NOON_PT);
    recordDailyCreditGrantFromBalance(
      { dailyDripOutcome: 'surprise' },
      NOON_PT,
    );
    recordDailyCreditGrantFromBalance(null, NOON_PT);
    recordDailyCreditGrantFromBalance(
      {
        dailyDripOutcome: 'blocked',
        dailyDripBlockedReason: 'someone_else',
      },
      NOON_PT,
    );
    recordDailyCreditGrantFromBalance(
      { dailyDripOutcome: 'granted', dailyDripGrantedCredits: -1 },
      NOON_PT,
    );
    await flushScheduledTelemetry();

    expect(emitted()).toEqual([
      { grant_status: 'blocked', grant_source: 'balance_read' },
      { grant_status: 'granted', grant_source: 'balance_read' },
    ]);
  });

  it('remembers the latest status for turn telemetry until cleared', () => {
    expect(getLastDailyCreditGrantStatus()).toBeUndefined();
    recordDailyCreditGrantFromBalance(
      { dailyDripOutcome: 'blocked', dailyDripBlockedReason: 'network_limit' },
      NOON_PT,
    );
    // A repeated status is not re-reported but stays the latest.
    recordDailyCreditGrantFromBalance(
      { dailyDripOutcome: 'blocked', dailyDripBlockedReason: 'network_limit' },
      NOON_PT,
    );
    expect(getLastDailyCreditGrantStatus()).toBe('blocked');
    recordDailyCreditGrantFromSave(saveResult({ enabled: false }), NOON_PT);
    expect(getLastDailyCreditGrantStatus()).toBe('not_opted_in');
    clearDailyCreditGrantStatus();
    expect(getLastDailyCreditGrantStatus()).toBeUndefined();
  });
});

describe('account isolation', () => {
  it.each(['balance', 'save'])(
    'ignores a late %s result after sign-out and sign-in to the same account',
    async (source) => {
      const scope = captureDailyCreditGrantAccount();
      mockPeekAccount.mockReturnValue(null);
      mockAccountChange?.();
      mockPeekAccount.mockReturnValue({ account: { id: 'account-a' } });
      mockAccountChange?.();
      if (source === 'balance') {
        recordDailyCreditGrantFromBalance(
          { dailyDripOutcome: 'blocked' },
          NOON_PT,
          scope,
        );
      } else {
        recordDailyCreditGrantFromSave(
          saveResult({ granted: 10 }),
          NOON_PT,
          scope,
        );
      }
      await flushScheduledTelemetry();
      expect(getLastDailyCreditGrantStatus()).toBeUndefined();
      expect(emitted()).toEqual([]);
    },
  );

  it('does not reset deduplication on a same-account metadata refresh', async () => {
    recordDailyCreditGrantFromBalance({ dailyDripOutcome: 'blocked' }, NOON_PT);
    await flushScheduledTelemetry();
    mockAccountChange?.();
    recordDailyCreditGrantFromBalance({ dailyDripOutcome: 'blocked' }, NOON_PT);
    await flushScheduledTelemetry();
    expect(emitted()).toHaveLength(1);
  });

  it('forgets the prior account status without needing another balance load', async () => {
    recordDailyCreditGrantFromBalance({ dailyDripOutcome: 'blocked' }, NOON_PT);
    await flushScheduledTelemetry();
    expect(getLastDailyCreditGrantStatus()).toBe('blocked');
    mockPeekAccount.mockReturnValue(null);
    mockAccountChange?.();
    expect(getLastDailyCreditGrantStatus()).toBeUndefined();
  });

  it('reports the new account first attempt on the same Pacific day', async () => {
    recordDailyCreditGrantFromBalance({ dailyDripOutcome: 'blocked' }, NOON_PT);
    await flushScheduledTelemetry();
    mockPeekAccount.mockReturnValue({ account: { id: 'account-b' } });
    mockAccountChange?.();
    expect(getLastDailyCreditGrantStatus()).toBeUndefined();
    recordDailyCreditGrantFromBalance({ dailyDripOutcome: 'blocked' }, NOON_PT);
    await flushScheduledTelemetry();
    expect(emitted()).toHaveLength(2);
  });

  it('drops deferred telemetry if the account changes before it emits', async () => {
    recordDailyCreditGrantFromBalance(
      { dailyDripOutcome: 'granted', dailyDripGrantedCredits: 10 },
      NOON_PT,
    );
    mockPeekAccount.mockReturnValue({ account: { id: 'account-b' } });
    mockAccountChange?.();
    await flushScheduledTelemetry();
    expect(emitted()).toEqual([]);
  });
});

describe('startup capture readiness', () => {
  it('holds a startup grant until capture is installed, preserving its amount exactly once', async () => {
    mockCaptureState = undefined;
    recordDailyCreditGrantFromBalance(
      { dailyDripOutcome: 'granted', dailyDripGrantedCredits: 10 },
      NOON_PT,
    );
    await flushScheduledTelemetry();
    expect(mockForwardedContexts).toEqual([]);
    expect(getLastDailyCreditGrantStatus()).toBe('granted');

    applyCapture(true);
    recordDailyCreditGrantFromBalance(
      { dailyDripOutcome: 'already_granted' },
      NOON_PT,
    );
    applyCapture(true);
    await flushScheduledTelemetry();
    expect(mockForwardedContexts).toEqual([
      {
        grant_status: 'granted',
        grant_amount: 10,
        grant_source: 'balance_read',
      },
    ]);
  });

  it('keeps the original opt-in grant and latest status across repeated startup reads', async () => {
    mockCaptureState = undefined;
    recordDailyCreditGrantFromSave(saveResult({ granted: 10 }), NOON_PT);
    recordDailyCreditGrantFromBalance(
      { dailyDripOutcome: 'granted', dailyDripGrantedCredits: 20 },
      NOON_PT,
    );
    recordDailyCreditGrantFromBalance(
      { dailyDripOutcome: 'already_granted' },
      NOON_PT,
    );
    applyCapture(true);
    await flushScheduledTelemetry();
    expect(mockForwardedContexts).toEqual([
      {
        grant_status: 'granted',
        grant_amount: 10,
        grant_source: 'opt_in_save',
      },
    ]);
    expect(getLastDailyCreditGrantStatus()).toBe('already_granted');
  });

  it('discards a startup observation when the first snapshot explicitly disables capture', async () => {
    mockCaptureState = undefined;
    recordDailyCreditGrantFromBalance(
      { dailyDripOutcome: 'granted', dailyDripGrantedCredits: 10 },
      NOON_PT,
    );
    applyCapture(false);
    applyCapture(true);
    await flushScheduledTelemetry();
    expect(mockForwardedContexts).toEqual([]);
    recordDailyCreditGrantFromBalance(
      { dailyDripOutcome: 'already_granted' },
      NOON_PT,
    );
    await flushScheduledTelemetry();
    expect(mockForwardedContexts).toEqual([
      { grant_status: 'already_granted', grant_source: 'balance_read' },
    ]);
  });

  it('does not retain observations made while capture is explicitly disabled', async () => {
    applyCapture(false);
    recordDailyCreditGrantFromBalance(
      { dailyDripOutcome: 'granted', dailyDripGrantedCredits: 10 },
      NOON_PT,
    );
    applyCapture(true);
    await flushScheduledTelemetry();
    expect(mockForwardedContexts).toEqual([]);
  });

  it('discards startup observations after switching accounts', async () => {
    mockCaptureState = undefined;
    recordDailyCreditGrantFromBalance(
      { dailyDripOutcome: 'granted', dailyDripGrantedCredits: 10 },
      NOON_PT,
    );
    mockPeekAccount.mockReturnValue({ account: { id: 'account-b' } });
    mockAccountChange?.();
    applyCapture(true);
    await flushScheduledTelemetry();
    expect(mockForwardedContexts).toEqual([]);
  });

  it('rechecks a changed account before flushing even without an account notification', async () => {
    mockCaptureState = undefined;
    recordDailyCreditGrantFromBalance({ dailyDripOutcome: 'blocked' }, NOON_PT);
    mockPeekAccount.mockReturnValue({ account: { id: 'account-b' } });
    applyCapture(true);
    await flushScheduledTelemetry();
    expect(mockForwardedContexts).toEqual([]);
    expect(getLastDailyCreditGrantStatus()).toBeUndefined();
  });

  it('keeps only the latest Pacific day while waiting for startup capture', async () => {
    mockCaptureState = undefined;
    recordDailyCreditGrantFromBalance(
      { dailyDripOutcome: 'granted', dailyDripGrantedCredits: 10 },
      NOON_PT,
    );
    recordDailyCreditGrantFromBalance(
      { dailyDripOutcome: 'at_cap' },
      NEXT_PT_DAY,
    );
    applyCapture(true);
    await flushScheduledTelemetry();
    expect(mockForwardedContexts).toEqual([
      { grant_status: 'at_cap', grant_source: 'balance_read' },
    ]);
  });

  it('drops a deferred grant across a capture off/on cycle', async () => {
    recordDailyCreditGrantFromBalance(
      { dailyDripOutcome: 'granted', dailyDripGrantedCredits: 10 },
      NOON_PT,
    );
    applyCapture(false);
    applyCapture(true);
    await flushScheduledTelemetry();
    expect(mockForwardedContexts).toEqual([]);
  });
});
