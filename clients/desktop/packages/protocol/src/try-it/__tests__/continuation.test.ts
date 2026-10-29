import { type TryItCapability } from '../index';
import {
  isTryItContinuation,
  resolveTryItSignInGate,
  resumeTryItContinuationAfterSetup,
  tryItCapabilityReadiness,
  TRY_IT_CONTINUATION_TTL_MS,
  tryItAccountMcpSelection,
  type TryItCapabilitySnapshot,
  type TryItContinuation,
} from '../continuation';

const nowMs = 1_800_000_000_000;
const capability: TryItCapability = {
  kind: 'mcp',
  sourceId: 'curated-mcp',
  catalogId: 'linear',
  name: 'Linear',
};
const other: TryItCapability = { ...capability, catalogId: 'github' };
const pending: TryItContinuation = {
  version: 1,
  sourceChatId: 'source-chat',
  sourceSessionId: 'guest-session',
  sourceAccountKey: 'guest:1',
  sourceRequestId: 'guest-turn',
  requestId: 'continuation-turn',
  capability,
  prompt: '  Summarize my issues.\nKeep this wording.  ',
  createdAtMs: nowMs,
  status: 'pending',
};
const bound: TryItContinuation = {
  ...pending,
  destinationAccountKey: 'account:1',
};

describe('account MCP selection', () => {
  const connected = {
    kind: 'CURATED' as const,
    serverKey: 'linear',
    configId: 'default',
    status: 'CONNECTED' as const,
  };
  it('matches the intended curated or custom identity, never an unrelated connection', () => {
    expect(tryItAccountMcpSelection(capability, [connected])).toEqual({
      serverId: 'linear',
      configId: 'default',
    });
    expect(tryItAccountMcpSelection(other, [connected])).toBeNull();
    expect(
      tryItAccountMcpSelection({ ...capability, sourceId: 'account-mcp' }, [
        connected,
      ]),
    ).toBeNull();
    expect(
      tryItAccountMcpSelection({ ...capability, sourceId: 'account-mcp' }, [
        { ...connected, kind: 'CUSTOM' },
      ]),
    ).toEqual({ serverId: 'linear', configId: 'default' });
  });
  it('refuses ambiguous, disabled, disconnected and malformed connections', () => {
    expect(
      tryItAccountMcpSelection(capability, [
        connected,
        { ...connected, configId: 'other' },
      ]),
    ).toBeNull();
    for (const row of [
      { ...connected, enabled: false },
      { ...connected, status: 'DISCONNECTED' as const },
      { ...connected, configId: '' },
    ]) {
      expect(tryItAccountMcpSelection(capability, [row])).toBeNull();
    }
  });
});

describe('continuation validation', () => {
  it('accepts the portable record and preserves the exact prompt', () => {
    const decoded: unknown = JSON.parse(JSON.stringify(pending));
    expect(isTryItContinuation(decoded, { nowMs })).toBe(true);
    if (!isTryItContinuation(decoded, { nowMs })) throw new Error('invalid');
    expect(decoded.prompt).toBe(pending.prompt);
  });

  it.each([
    null,
    [],
    {},
    { ...pending, version: 2 },
    { ...pending, sourceChatId: '' },
    { ...pending, sourceSessionId: ' ' },
    { ...pending, sourceAccountKey: '' },
    { ...pending, sourceRequestId: '' },
    { ...pending, requestId: 'guest-turn' },
    { ...pending, requestId: 'a\u0000b' },
    { ...pending, capability: { ...capability, sourceId: '' } },
    { ...pending, prompt: ' ' },
    { ...pending, prompt: 1 },
    { ...pending, createdAtMs: Number.NaN },
    { ...pending, createdAtMs: Number.POSITIVE_INFINITY },
    { ...pending, createdAtMs: -1 },
    { ...pending, createdAtMs: nowMs + 1 },
    { ...pending, status: 'unknown' },
    { ...pending, status: 'failed' },
    { ...pending, status: 'failed', failure: 'unknown' },
    { ...pending, failure: 'send-failed' },
    { ...pending, destinationAccountKey: '' },
    { ...bound, destinationChatId: '' },
    { ...pending, destinationChatId: 'replacement' },
    { ...pending, status: 'sending' },
    { ...pending, status: 'setup-required' },
    { ...bound, status: 'completed' },
    { ...pending, host: { path: '/unvalidated' } },
    { ...pending, path: '/not-portable' },
  ])('rejects malformed or unsafe persisted data %#', (value) => {
    expect(isTryItContinuation(value, { nowMs })).toBe(false);
  });

  it.each(['sending', 'setup-required'] as const)(
    'retains a bound %s record for recovery',
    (status) => {
      expect(isTryItContinuation({ ...bound, status }, { nowMs })).toBe(true);
    },
  );

  it.each([
    'authentication-cancelled',
    'authentication-failed',
    'handoff-blocked',
    'send-failed',
    'acceptance-uncertain',
    'capability-unavailable',
  ] as const)('preserves the recoverable failure %s', (failure) => {
    expect(
      isTryItContinuation({ ...bound, status: 'failed', failure }, { nowMs }),
    ).toBe(true);
  });

  it('expires after seven days without refreshing the creation timestamp', () => {
    expect(
      isTryItContinuation(pending, {
        nowMs: nowMs + TRY_IT_CONTINUATION_TTL_MS - 1,
      }),
    ).toBe(true);
    expect(
      isTryItContinuation(pending, {
        nowMs: nowMs + TRY_IT_CONTINUATION_TTL_MS,
      }),
    ).toBe(false);
    expect(isTryItContinuation(pending, { nowMs: Number.NaN })).toBe(false);
  });

  it('requires a host parser for every host extension', () => {
    const isHost = (value: unknown): value is { recreateChatId: string } =>
      typeof value === 'object' &&
      value !== null &&
      'recreateChatId' in value &&
      typeof value.recreateChatId === 'string' &&
      value.recreateChatId.length > 0;
    expect(
      isTryItContinuation(
        { ...pending, host: { recreateChatId: 'replacement' } },
        { nowMs, isHost },
      ),
    ).toBe(true);
    expect(
      isTryItContinuation(
        { ...pending, host: { recreateChatId: 12 } },
        { nowMs, isHost },
      ),
    ).toBe(false);
    expect(
      isTryItContinuation(
        { ...pending, host: {} },
        {
          nowMs,
          isHost: (_value: unknown): _value is never => {
            throw new Error('malformed host data');
          },
        },
      ),
    ).toBe(false);
  });

  it('completes only with the bound destination receipt', () => {
    const completed = {
      ...bound,
      status: 'completed',
      destinationChatId: 'replacement',
      receipt: {
        accountKey: 'account:1',
        chatId: 'replacement',
        requestId: 'continuation-turn',
      },
    };
    expect(isTryItContinuation(completed, { nowMs })).toBe(true);
    for (const receipt of [
      {},
      null,
      { ...completed.receipt, accountKey: 'account:2' },
      { ...completed.receipt, chatId: 'source-chat' },
      { ...completed.receipt, requestId: 'guest-turn' },
    ]) {
      expect(isTryItContinuation({ ...completed, receipt }, { nowMs })).toBe(
        false,
      );
    }
    expect(
      isTryItContinuation(
        {
          ...completed,
          destinationChatId: undefined,
          receipt: { ...completed.receipt, chatId: 'source-chat' },
        },
        { nowMs },
      ),
    ).toBe(true);
  });
});

describe('target capability readiness', () => {
  const selected = [{ capability, usable: true }];
  const cases: readonly [TryItCapabilitySnapshot, string][] = [
    [{ authoritative: false, selected }, 'unknown'],
    [{ authoritative: true }, 'unknown'],
    [{ authoritative: true, selected: [] }, 'unknown'],
    [{ authoritative: true, selected }, 'resolved'],
    [{ authoritative: true, unresolved: [capability] }, 'unresolved'],
    [
      {
        authoritative: true,
        selected,
        unavailable: [{ capability, reason: 'needs-account' }],
      },
      'needs-account',
    ],
    [
      {
        authoritative: true,
        selected,
        unavailable: [{ capability, reason: 'other' }],
      },
      'unavailable-other',
    ],
    [
      { authoritative: true, selected: [{ capability, usable: false }] },
      'unavailable-other',
    ],
    [{ authoritative: true, selected, unresolved: [capability] }, 'unresolved'],
    [
      {
        authoritative: true,
        selected,
        unresolved: [other],
        unavailable: [{ capability: other, reason: 'needs-account' }],
      },
      'resolved',
    ],
    [
      {
        authoritative: true,
        unresolved: [other],
        selected: [{ capability: other, usable: true }],
      },
      'unknown',
    ],
    [
      {
        authoritative: true,
        selected: [
          ...selected,
          { capability: { ...capability, name: 'Renamed' }, usable: false },
        ],
      },
      'unavailable-other',
    ],
  ];
  it.each(cases)('resolves snapshot %# as %s', (snapshot, expected) => {
    expect(tryItCapabilityReadiness(capability, snapshot)).toBe(expected);
  });

  it.each([
    { ...capability, kind: 'plugin' as const },
    { ...capability, sourceId: 'account-mcp' },
    other,
  ])('does not use another identity %#', (entry) => {
    expect(
      tryItCapabilityReadiness(capability, {
        authoritative: true,
        selected: [{ capability: entry, usable: true }],
      }),
    ).toBe('unknown');
  });
});

describe('sign-in gate precedence', () => {
  const guest: Parameters<typeof resolveTryItSignInGate>[0] = {
    account: 'guest',
    chatId: 'source-chat',
    capability,
    transcriptLoading: false,
    initialAttemptSettled: true,
    hasUserTurn: true,
    readiness: 'unresolved',
    authentication: 'idle',
  };
  const signedIn: typeof guest = {
    ...guest,
    account: 'signed-in',
    accountKey: 'account:1',
    continuation: bound,
  };

  it.each([
    { account: 'loading' as const },
    { transcriptLoading: true },
    { initialAttemptSettled: false },
    { hasUserTurn: false },
    { capability: null },
  ])('hides until provenance and the initial attempt are ready %#', (patch) => {
    expect(resolveTryItSignInGate({ ...guest, ...patch })).toBe('hidden');
  });

  it.each([
    ['unresolved', 'sign-in'],
    ['needs-account', 'sign-in'],
    ['resolved', 'hidden'],
    ['unavailable-other', 'hidden'],
    ['unknown', 'hidden'],
  ] as const)('gates guest readiness %s as %s', (readiness, expected) => {
    expect(resolveTryItSignInGate({ ...guest, readiness })).toBe(expected);
  });

  it.each([
    ['active', 'signing-in'],
    ['cancelled', 'retry'],
    ['failed', 'retry'],
    ['idle', 'sign-in'],
  ] as const)(
    'reflects authentication %s as %s',
    (authentication, expected) => {
      expect(resolveTryItSignInGate({ ...guest, authentication })).toBe(
        expected,
      );
    },
  );

  it.each([
    ['unresolved', 'setup-required'],
    ['needs-account', 'setup-required'],
    ['resolved', 'continuing'],
    ['unavailable-other', 'retry'],
    ['unknown', 'retry'],
  ] as const)(
    'keeps signed-in readiness %s visible as %s',
    (readiness, expected) => {
      expect(resolveTryItSignInGate({ ...signedIn, readiness })).toBe(expected);
    },
  );

  it('keeps conflicts and uncertain acceptance visible after sign-in', () => {
    for (const failure of ['handoff-blocked', 'acceptance-uncertain'] as const)
      expect(
        resolveTryItSignInGate({
          ...signedIn,
          readiness: 'resolved',
          continuation: { ...bound, status: 'failed', failure },
        }),
      ).toBe('retry');
    expect(resolveTryItSignInGate({ ...signedIn, continuation: pending })).toBe(
      'retry',
    );
  });

  it('shows a saved guest attempt only in its source account scope', () => {
    expect(
      resolveTryItSignInGate({
        ...guest,
        accountKey: pending.sourceAccountKey,
        continuation: pending,
      }),
    ).toBe('sign-in');
    expect(
      resolveTryItSignInGate({
        ...guest,
        accountKey: 'guest:2',
        continuation: pending,
      }),
    ).toBe('hidden');
  });

  it('shows reconciliation while readiness is still unknown', () => {
    expect(
      resolveTryItSignInGate({
        ...signedIn,
        readiness: 'unknown',
        reconciling: true,
      }),
    ).toBe('continuing');
    expect(
      resolveTryItSignInGate({
        ...signedIn,
        continuation: { ...bound, status: 'sending' },
      }),
    ).toBe('continuing');
  });

  it.each([
    { ...bound, sourceChatId: 'unrelated' },
    { ...bound, capability: other },
    { ...bound, destinationAccountKey: 'account:2' },
    { ...bound, status: 'completed' as const },
    null,
  ])('hides unrelated or completed continuations %#', (continuation) => {
    expect(resolveTryItSignInGate({ ...signedIn, continuation })).toBe(
      'hidden',
    );
  });

  it('follows the mapped replacement chat and preserves the setup handoff', () => {
    expect(
      resolveTryItSignInGate({
        ...signedIn,
        chatId: 'replacement',
        readiness: 'resolved',
        continuation: {
          ...bound,
          destinationChatId: 'replacement',
          status: 'setup-required',
        },
      }),
    ).toBe('setup-required');
  });
});

describe('setup recovery', () => {
  it('returns a pending copy without failure, preserving every other field', () => {
    const record: TryItContinuation<{ destination: string }> = {
      ...bound,
      destinationChatId: 'replacement',
      status: 'setup-required',
      failure: 'capability-unavailable',
      host: { destination: 'preserved' },
    };
    const resumed = resumeTryItContinuationAfterSetup(record);
    expect(resumed).toEqual({
      ...bound,
      destinationChatId: 'replacement',
      status: 'pending',
      host: { destination: 'preserved' },
    });
    expect(resumed).not.toHaveProperty('failure');
    expect(resumed).not.toBe(record);
    expect(record.status).toBe('setup-required');
    expect(
      isTryItContinuation(resumed, {
        nowMs,
        isHost: (value: unknown): value is { destination: string } =>
          typeof value === 'object' &&
          value !== null &&
          'destination' in value &&
          typeof value.destination === 'string',
      }),
    ).toBe(true);
    expect(resumeTryItContinuationAfterSetup(resumed)).toBe(resumed);
  });
  it.each(['pending', 'sending', 'failed', 'completed'] as const)(
    'leaves %s untouched',
    (status) => {
      const record = { ...bound, status };
      expect(resumeTryItContinuationAfterSetup(record)).toBe(record);
    },
  );
  it.each([
    ['idle', 'setup-required'],
    ['active', 'authorizing'],
    ['cancelled', 'retry'],
    ['failed', 'retry'],
  ] as const)(
    'maps setup %s to %s only inside setup gates',
    (setup, expected) => {
      const input: Parameters<typeof resolveTryItSignInGate>[0] = {
        account: 'signed-in',
        accountKey: 'account:1',
        chatId: 'source-chat',
        capability,
        transcriptLoading: false,
        initialAttemptSettled: true,
        hasUserTurn: true,
        readiness: 'unresolved',
        authentication: 'idle',
        continuation: { ...bound, status: 'setup-required' },
        setup,
      };
      expect(resolveTryItSignInGate(input)).toBe(expected);
      expect(
        resolveTryItSignInGate({
          ...input,
          account: 'guest',
          continuation: null,
        }),
      ).toBe('sign-in');
      expect(
        resolveTryItSignInGate({
          ...input,
          continuation: { ...bound, status: 'sending' },
        }),
      ).toBe('continuing');
      expect(
        resolveTryItSignInGate({
          ...input,
          continuation: { ...bound, status: 'failed' },
        }),
      ).toBe('retry');
      expect(
        resolveTryItSignInGate({
          ...input,
          continuation: { ...bound, status: 'completed' },
        }),
      ).toBe('hidden');
      expect(
        resolveTryItSignInGate({
          ...input,
          continuation: bound,
          readiness: 'resolved',
        }),
      ).toBe('continuing');
      expect(
        resolveTryItSignInGate({ ...input, accountKey: 'account:2' }),
      ).toBe('hidden');
    },
  );
});
