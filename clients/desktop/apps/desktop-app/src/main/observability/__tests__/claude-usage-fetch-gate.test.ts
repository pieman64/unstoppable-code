import {
  ClaudeUsageFetchGate,
  type ClaudeUsageFetchGateOutcome,
  type ClaudeUsageFetchGateResult,
} from '../claude-usage-fetch-gate';

type UsageResponse = {
  label: string;
  outcome: ClaudeUsageFetchGateOutcome;
};

interface GateHarness {
  gate: ClaudeUsageFetchGate<UsageResponse>;
  setNow: (value: number) => void;
}

function createGateHarness(
  options: { now?: number; random?: number } = {},
): GateHarness {
  let now = options.now ?? 1_000;
  const random = options.random ?? 0.5;
  const gate = new ClaudeUsageFetchGate<UsageResponse>({
    now: (): number => now,
    random: (): number => random,
  });

  return {
    gate,
    setNow: (value: number): void => {
      now = value;
    },
  };
}

function successfulResponse(label = 'usage'): UsageResponse {
  return { label, outcome: { status: 'success' } };
}

function failedResponse(
  options: {
    rateLimited?: boolean;
    retryAfter?: string | null;
  } = {},
): UsageResponse {
  return {
    label: 'failure',
    outcome: {
      status: 'failure',
      ...(options.rateLimited === undefined
        ? {}
        : { rateLimited: options.rateLimited }),
      ...(options.retryAfter === undefined
        ? {}
        : { retryAfter: options.retryAfter }),
    },
  };
}

function getOutcome(response: UsageResponse): ClaudeUsageFetchGateOutcome {
  return response.outcome;
}

const FRESHNESS_CASES: Array<[string, number]> = [
  ['interactive', 30_000],
  ['background', 180_000],
];

const INITIAL_NOW = Date.UTC(2026, 0, 1, 12);
const RETRY_AFTER_CASES: Array<[string, string, number]> = [
  ['120-second delta', '120', 120_000],
  [
    '120-second HTTP date',
    new Date(INITIAL_NOW + 120_000).toUTCString(),
    120_000,
  ],
  ['two-hour delta', '7200', 2 * 60 * 60 * 1_000],
  [
    'two-hour HTTP date',
    new Date(INITIAL_NOW + 2 * 60 * 60 * 1_000).toUTCString(),
    2 * 60 * 60 * 1_000,
  ],
];

function completedResult(
  result: ClaudeUsageFetchGateResult<UsageResponse>,
): Extract<ClaudeUsageFetchGateResult<UsageResponse>, { kind: 'completed' }> {
  if (result.kind !== 'completed') {
    throw new Error(`Expected completed result, received ${result.kind}`);
  }
  return result;
}

describe('ClaudeUsageFetchGate', () => {
  it('notifies once for a real 429, not joined reads or cooldown skips', async () => {
    const onRateLimited = jest.fn();
    const gate = new ClaudeUsageFetchGate<UsageResponse>({
      now: (): number => INITIAL_NOW,
      onRateLimited,
    });
    const read = (): Promise<UsageResponse> =>
      Promise.resolve(failedResponse({ rateLimited: true, retryAfter: '120' }));
    await Promise.all([
      gate.run('account-a', 0, read, getOutcome),
      gate.run('account-a', 0, read, getOutcome),
    ]);
    await gate.run('account-a', 0, read, getOutcome);
    expect(onRateLimited).toHaveBeenCalledTimes(1);
    expect(onRateLimited).toHaveBeenCalledWith({
      retryAt: INITIAL_NOW + 120_000,
      cooldownMs: 120_000,
    });
  });

  it('single-flights concurrent reads for the same account and returns the shared result', async () => {
    const { gate } = createGateHarness();
    let resolveRead: (response: UsageResponse) => void = () => {
      throw new Error('Read resolver was not initialized');
    };
    let reads = 0;
    const read = (): Promise<UsageResponse> => {
      reads += 1;
      return new Promise((resolve): void => {
        resolveRead = resolve;
      });
    };

    const first = gate.run('account-a', 30_000, read, getOutcome);
    const joined = gate.run('account-a', 180_000, read, getOutcome);
    await Promise.resolve();

    expect(joined).toBe(first);
    expect(reads).toBe(1);

    const response = successfulResponse('shared');
    resolveRead(response);
    const [firstResult, joinedResult] = await Promise.all([first, joined]);

    expect(firstResult).toEqual({
      kind: 'completed',
      value: response,
      startedAt: 1_000,
    });
    expect(joinedResult).toBe(firstResult);
  });

  it('single-flights callers without an account key', async () => {
    const { gate } = createGateHarness();
    let resolveRead: (response: UsageResponse) => void = () => {
      throw new Error('Read resolver was not initialized');
    };
    let reads = 0;
    const read = (): Promise<UsageResponse> => {
      reads += 1;
      return new Promise((resolve): void => {
        resolveRead = resolve;
      });
    };

    const first = gate.run(null, 0, read, getOutcome);
    const joined = gate.run(null, 0, read, getOutcome);
    await Promise.resolve();
    expect(joined).toBe(first);
    expect(reads).toBe(1);

    resolveRead(successfulResponse('anonymous'));
    await expect(first).resolves.toMatchObject({ kind: 'completed' });
    await expect(joined).resolves.toMatchObject({ kind: 'completed' });
  });

  it('keeps separate account reads independent', async () => {
    const { gate } = createGateHarness();
    let resolveFirstRead: (response: UsageResponse) => void = () => {
      throw new Error('First read resolver was not initialized');
    };
    let firstReads = 0;
    let secondReads = 0;
    const firstRead = (): Promise<UsageResponse> => {
      firstReads += 1;
      return new Promise((resolve): void => {
        resolveFirstRead = resolve;
      });
    };
    const secondRead = (): Promise<UsageResponse> => {
      secondReads += 1;
      return Promise.resolve(successfulResponse('second account'));
    };

    const first = gate.run('account-a', 0, firstRead, getOutcome);
    const second = gate.run('account-b', 0, secondRead, getOutcome);
    await Promise.resolve();

    await expect(second).resolves.toMatchObject({ kind: 'completed' });
    expect(firstReads).toBe(1);
    expect(secondReads).toBe(1);

    resolveFirstRead(successfulResponse('first account'));
    await expect(first).resolves.toMatchObject({ kind: 'completed' });
  });

  it.each(FRESHNESS_CASES)(
    'uses the supplied %s freshness window',
    async (_label, freshnessMs) => {
      const { gate, setNow } = createGateHarness();
      let reads = 0;
      const read = (): Promise<UsageResponse> => {
        reads += 1;
        return Promise.resolve(successfulResponse());
      };

      await expect(
        gate.run('account-a', freshnessMs, read, getOutcome),
      ).resolves.toMatchObject({
        kind: 'completed',
      });

      setNow(1_000 + freshnessMs - 1);
      await expect(
        gate.run('account-a', freshnessMs, read, getOutcome),
      ).resolves.toEqual({
        kind: 'fresh',
        lastSuccessAt: 1_000,
      });
      expect(reads).toBe(1);

      setNow(1_000 + freshnessMs);
      await expect(
        gate.run('account-a', freshnessMs, read, getOutcome),
      ).resolves.toMatchObject({
        kind: 'completed',
      });
      expect(reads).toBe(2);
    },
  );

  it('does not retain a completed usage result when freshness is disabled', async () => {
    const { gate } = createGateHarness();
    let reads = 0;
    const read = (): Promise<UsageResponse> => {
      reads += 1;
      return Promise.resolve(successfulResponse(`read-${reads}`));
    };

    const first = completedResult(
      await gate.run('account-a', 0, read, getOutcome),
    );
    const second = completedResult(
      await gate.run('account-a', 0, read, getOutcome),
    );

    expect(first.value.label).toBe('read-1');
    expect(second.value.label).toBe('read-2');
    expect(reads).toBe(2);
  });

  it('shares one computed Retry-After time with callers joining a 429 read', async () => {
    const initialNow = INITIAL_NOW;
    const { gate } = createGateHarness({ now: initialNow });
    let resolveRead: (response: UsageResponse) => void = () => {
      throw new Error('Read resolver was not initialized');
    };
    const read = (): Promise<UsageResponse> =>
      new Promise((resolve): void => {
        resolveRead = resolve;
      });

    const first = gate.run('account-a', 0, read, getOutcome);
    const joined = gate.run('account-a', 0, read, getOutcome);
    await Promise.resolve();
    const response = failedResponse({ rateLimited: true, retryAfter: '120' });
    resolveRead(response);

    const [firstResult, joinedResult] = await Promise.all([first, joined]);
    expect(firstResult).toEqual({
      kind: 'completed',
      value: response,
      startedAt: initialNow,
      retryAt: initialNow + 120_000,
    });
    expect(joinedResult).toBe(firstResult);
  });

  it.each(RETRY_AFTER_CASES)(
    'honors a %s rate-limit cooldown for every later caller',
    async (_label, retryAfter, delayMs) => {
      const initialNow = INITIAL_NOW;
      const { gate, setNow } = createGateHarness({ now: initialNow });
      const response = failedResponse({ rateLimited: true, retryAfter });
      const read = (): Promise<UsageResponse> => Promise.resolve(response);

      const completed = completedResult(
        await gate.run('account-a', 0, read, getOutcome),
      );
      expect(completed).toEqual({
        kind: 'completed',
        value: response,
        startedAt: initialNow,
        retryAt: initialNow + delayMs,
      });

      setNow(initialNow + 1);
      let blockedReads = 0;
      const shouldNotRead = (): Promise<UsageResponse> => {
        blockedReads += 1;
        return Promise.resolve(successfulResponse());
      };
      const [firstCooldown, secondCooldown] = await Promise.all([
        gate.run('account-a', 0, shouldNotRead, getOutcome),
        gate.run('account-a', 0, shouldNotRead, getOutcome),
      ]);

      expect(firstCooldown).toEqual({
        kind: 'cooldown',
        retryAt: initialNow + delayMs,
      });
      expect(secondCooldown).toEqual(firstCooldown);
      expect(blockedReads).toBe(0);
    },
  );

  it('floors short Retry-After values at ten seconds and caps long values at 24 hours', async () => {
    const initialNow = INITIAL_NOW;
    const { gate, setNow } = createGateHarness({ now: initialNow });
    const retryAfters = [
      '2',
      new Date(initialNow + 5_000).toUTCString(),
      '172801',
      new Date(initialNow + 48 * 60 * 60 * 1_000).toUTCString(),
    ];
    const expectedDelays = [
      10_000,
      10_000,
      24 * 60 * 60 * 1_000,
      24 * 60 * 60 * 1_000,
    ];

    for (let index = 0; index < retryAfters.length; index += 1) {
      setNow(initialNow);
      const retryAfter = retryAfters[index];
      const expectedDelay = expectedDelays[index];
      if (retryAfter === undefined || expectedDelay === undefined) {
        throw new Error('Retry-After test case was not initialized');
      }

      const response = failedResponse({ rateLimited: true, retryAfter });
      const completed = completedResult(
        await gate.run(
          `account-${index}`,
          0,
          (): Promise<UsageResponse> => Promise.resolve(response),
          getOutcome,
        ),
      );
      expect(completed.retryAt).toBe(initialNow + expectedDelay);
    }
  });

  it.each(['not a date', 'Thu, 01 Jan 2026 11:59:59 GMT'])(
    'falls back when Retry-After is invalid or past (%s)',
    async (retryAfter) => {
      const initialNow = Date.UTC(2026, 0, 1, 12);
      const { gate } = createGateHarness({ now: initialNow, random: 0.5 });
      const response = failedResponse({ rateLimited: true, retryAfter });

      const result = completedResult(
        await gate.run(
          'account-a',
          0,
          (): Promise<UsageResponse> => Promise.resolve(response),
          getOutcome,
        ),
      );

      expect(result.retryAt).toBe(initialNow + 60_000);
    },
  );

  it('uses deterministic exponential delays and permits a read at cooldown expiry', async () => {
    const { gate, setNow } = createGateHarness({ now: 1_000, random: 0.5 });
    const expectedDelays = [
      60_000, 120_000, 240_000, 480_000, 900_000, 900_000,
    ];
    let reads = 0;
    const read = (): Promise<UsageResponse> => {
      reads += 1;
      return Promise.resolve(failedResponse({ rateLimited: true }));
    };

    for (let attempt = 0; attempt < expectedDelays.length; attempt += 1) {
      const expectedDelay = expectedDelays[attempt];
      if (expectedDelay === undefined) {
        throw new Error('Fallback delay test case was not initialized');
      }

      const completed = completedResult(
        await gate.run('account-a', 0, read, getOutcome),
      );
      expect(completed.retryAt).toBe(completed.startedAt + expectedDelay);
      expect(reads).toBe(attempt + 1);

      if (
        completed.retryAt === undefined ||
        attempt === expectedDelays.length - 1
      ) {
        continue;
      }

      setNow(completed.retryAt - 1);
      await expect(gate.run('account-a', 0, read, getOutcome)).resolves.toEqual(
        { kind: 'cooldown', retryAt: completed.retryAt },
      );
      expect(reads).toBe(attempt + 1);

      setNow(completed.retryAt);
    }
  });

  it('does not treat a prior success as fresh after a newer forced read fails', async () => {
    const { gate } = createGateHarness({ now: 0 });
    let reads = 0;
    const read = (): Promise<UsageResponse> => {
      reads += 1;
      if (reads === 1) {
        return Promise.resolve(successfulResponse('initial'));
      }
      if (reads === 2) {
        return Promise.reject(new Error('network unavailable'));
      }
      return Promise.resolve(successfulResponse('retry'));
    };

    await expect(
      gate.run('account-a', 180_000, read, getOutcome),
    ).resolves.toMatchObject({ kind: 'completed' });
    await expect(gate.run('account-a', 0, read, getOutcome)).rejects.toThrow(
      'network unavailable',
    );

    await expect(
      gate.run('account-a', 30_000, read, getOutcome),
    ).resolves.toMatchObject({ kind: 'completed' });
    expect(reads).toBe(3);
  });

  it('applies the fallback jitter range and caps the cooldown at 15 minutes', async () => {
    const { gate: lowJitterGate } = createGateHarness({ random: 0 });
    const lowJitter = completedResult(
      await lowJitterGate.run(
        'account-a',
        0,
        (): Promise<UsageResponse> =>
          Promise.resolve(failedResponse({ rateLimited: true })),
        getOutcome,
      ),
    );
    expect(lowJitter.retryAt).toBe(1_000 + 48_000);

    const { gate: highJitterGate, setNow } = createGateHarness({ random: 1 });
    let lastRetryAt = 1_000;
    let lastDelay = 0;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      setNow(lastRetryAt);
      const result = completedResult(
        await highJitterGate.run(
          'account-a',
          0,
          (): Promise<UsageResponse> =>
            Promise.resolve(failedResponse({ rateLimited: true })),
          getOutcome,
        ),
      );
      if (result.retryAt === undefined) {
        throw new Error('Rate-limited response did not include a retry time');
      }
      lastRetryAt = result.retryAt;
      lastDelay = result.retryAt - result.startedAt;
      if (attempt === 1) {
        expect(result.retryAt - result.startedAt).toBe(72_000);
      }
    }

    expect(lastDelay).toBe(15 * 60 * 1_000);
  });

  it('resets the fallback 429 count after a successful read', async () => {
    const { gate, setNow } = createGateHarness({ random: 0 });
    const rateLimit = (): Promise<UsageResponse> =>
      Promise.resolve(failedResponse({ rateLimited: true }));
    const success = (): Promise<UsageResponse> =>
      Promise.resolve(successfulResponse());

    const first = completedResult(
      await gate.run('account-a', 0, rateLimit, getOutcome),
    );
    if (first.retryAt === undefined) {
      throw new Error('First rate-limit response did not include a retry time');
    }
    setNow(first.retryAt);

    const second = completedResult(
      await gate.run('account-a', 0, rateLimit, getOutcome),
    );
    if (second.retryAt === undefined) {
      throw new Error(
        'Second rate-limit response did not include a retry time',
      );
    }
    expect(second.retryAt - second.startedAt).toBe(96_000);
    setNow(second.retryAt);

    await expect(
      gate.run('account-a', 0, success, getOutcome),
    ).resolves.toMatchObject({
      kind: 'completed',
    });
    const afterSuccess = completedResult(
      await gate.run('account-a', 0, rateLimit, getOutcome),
    );

    if (afterSuccess.retryAt === undefined) {
      throw new Error(
        'Rate-limited response after success did not include a retry time',
      );
    }
    expect(afterSuccess.retryAt - afterSuccess.startedAt).toBe(48_000);
  });

  it('allows immediate retry after a 5xx failure', async () => {
    const { gate } = createGateHarness();
    let reads = 0;
    const serverFailure: UsageResponse = {
      label: 'HTTP 503',
      outcome: { status: 'failure' },
    };
    const read = (): Promise<UsageResponse> => {
      reads += 1;
      return Promise.resolve(
        reads === 1 ? serverFailure : successfulResponse('retried'),
      );
    };

    const first = completedResult(
      await gate.run('account-a', 0, read, getOutcome),
    );
    expect(first.retryAt).toBeUndefined();
    await expect(
      gate.run('account-a', 0, read, getOutcome),
    ).resolves.toMatchObject({
      kind: 'completed',
      value: successfulResponse('retried'),
    });
    expect(reads).toBe(2);
  });

  it('allows immediate retry after a rejected network read', async () => {
    const { gate } = createGateHarness();
    const networkError = new Error('network unavailable');
    let reads = 0;
    const read = (): Promise<UsageResponse> => {
      reads += 1;
      return reads === 1
        ? Promise.reject(networkError)
        : Promise.resolve(successfulResponse('retried'));
    };

    await expect(gate.run('account-a', 0, read, getOutcome)).rejects.toBe(
      networkError,
    );
    await expect(
      gate.run('account-a', 0, read, getOutcome),
    ).resolves.toMatchObject({
      kind: 'completed',
    });
    expect(reads).toBe(2);
  });
});
