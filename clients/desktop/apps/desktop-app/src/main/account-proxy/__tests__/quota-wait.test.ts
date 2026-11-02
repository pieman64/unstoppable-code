import type * as TimersModule from 'node:timers/promises';
jest.mock('node:timers/promises', () => {
  const actual = jest.requireActual<typeof TimersModule>(
    'node:timers/promises',
  );
  return {
    ...actual,
    setTimeout: (
      ms: number,
      value: unknown,
      options: { signal?: AbortSignal },
    ): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const abort = (): void => {
          clearTimeout(timer);
          reject(
            options.signal?.reason instanceof Error
              ? options.signal.reason
              : new Error('Cancelled'),
          );
        };
        const timer = setTimeout(() => {
          options.signal?.removeEventListener('abort', abort);
          resolve(value);
        }, ms);
        options.signal?.addEventListener('abort', abort, { once: true });
      }),
  };
});
import type { AccountProxyStatus } from '@canopy/desktop-shared/types/account-proxy';
import { getAccountProxyStatus } from '../service';
import {
  waitForAccountProxyCapacity,
  resetAccountProxyQuotaWaitsForTests,
  stopAccountProxyQuotaWaits,
} from '../quota-wait';
jest.mock('../service', () => ({ getAccountProxyStatus: jest.fn() }));
const readStatus = jest.mocked(getAccountProxyStatus);
function status(ready: boolean): AccountProxyStatus {
  return {
    available: true,
    connection: { id: 'proxy', kind: 'server', url: 'https://proxy.test' },
    state: 'connected',
    error: null,
    version: '8',
    accounts: [
      {
        authIndex: 'a',
        provider: 'codex',
        label: 'a',
        source: 'sign-in',
        fileName: 'a.json',
        planType: null,
        status: ready ? 'active' : 'cooling',
        statusMessage: null,
        availableAt: ready ? null : Date.now() + 50000,
        limits: [
          { id: 'weekly', usedPercent: 100, resetsAt: Date.now() + 50000 },
        ],
      },
    ],
    routing: null,
    routeClaude: true,
    routeCodex: true,
    keepChatOnOneAccount: true,
    refreshedAt: Date.now() + 1,
    local: {
      phase: 'not-installed',
      version: null,
      install: null,
      port: null,
      startWithApp: true,
      message: null,
    },
    signIn: null,
  };
}
beforeEach(() => {
  jest.useFakeTimers();
  resetAccountProxyQuotaWaitsForTests();
  readStatus.mockReset();
});
afterEach(() => {
  stopAccountProxyQuotaWaits();
  jest.useRealTimers();
});
it('detects an external reset while passive counters still show exhaustion', async () => {
  readStatus.mockImplementation(() => Promise.resolve(status(false)));
  const wait = waitForAccountProxyCapacity('codex', 'proxy', {});
  await jest.advanceTimersByTimeAsync(5000);
  readStatus.mockImplementation(() => Promise.resolve(status(true)));
  await jest.advanceTimersByTimeAsync(5000);
  await expect(wait).resolves.toBeUndefined();
  expect(readStatus).toHaveBeenCalledWith({ refresh: true, maxAgeMs: 30000 });
});
it('cancels a quota wait on caller cancellation and app shutdown', async () => {
  readStatus.mockImplementation(() => Promise.resolve(status(false)));
  const controller = new AbortController();
  const first = waitForAccountProxyCapacity(
    'codex',
    'proxy',
    {},
    controller.signal,
  );
  const rejected = expect(first).rejects.toBeDefined();
  await jest.advanceTimersByTimeAsync(1);
  controller.abort();
  await rejected;
  const second = waitForAccountProxyCapacity('codex', 'proxy', {});
  const stopped = expect(second).rejects.toThrow('shutting down');
  await jest.advanceTimersByTimeAsync(1);
  stopAccountProxyQuotaWaits();
  await stopped;
});
it('refuses connection replacement rather than switching billing', async () => {
  readStatus.mockResolvedValue({
    ...status(true),
    connection: { id: 'other', kind: 'server', url: 'https://other.test' },
  });
  await expect(
    waitForAccountProxyCapacity('codex', 'proxy', {}),
  ).rejects.toThrow('unavailable');
});

it('cancels one caller immediately without cancelling a shared management read', async () => {
  let release: (value: AccountProxyStatus) => void = () => undefined;
  const sharedRead = new Promise<AccountProxyStatus>((resolve) => {
    release = resolve;
  });
  readStatus.mockReturnValue(sharedRead);
  const controller = new AbortController();
  const first = waitForAccountProxyCapacity(
    'codex',
    'proxy',
    {},
    controller.signal,
  );
  const second = waitForAccountProxyCapacity('codex', 'proxy', {});
  let cancelled = false;
  const cancelledResult = first.catch(() => {
    cancelled = true;
  });
  let otherSettled = false;
  void second.then(() => {
    otherSettled = true;
  });
  try {
    controller.abort(new Error('Caller cancelled'));
    await jest.advanceTimersByTimeAsync(0);
    expect(cancelled).toBe(true);
    expect(otherSettled).toBe(false);
  } finally {
    release(status(true));
    await cancelledResult;
    await expect(second).resolves.toBeUndefined();
  }
});

it('stops waiting when the provider has no account that can serve it', async () => {
  readStatus.mockResolvedValue({ ...status(false), accounts: [] });
  await expect(
    waitForAccountProxyCapacity('claude', 'proxy', {}),
  ).rejects.toThrow(
    'The account proxy has no Claude accounts. Add one in Settings > Multi-account proxy, or turn off Use for Claude there.',
  );
  expect(readStatus).toHaveBeenCalledTimes(1);
});

it('keeps waiting through a failed refresh that reports no accounts', async () => {
  readStatus.mockResolvedValue({
    ...status(false),
    accounts: [],
    state: 'error',
    error: { code: 'unreachable', message: 'unreachable' },
  });
  let settled = false;
  const wait = waitForAccountProxyCapacity('codex', 'proxy', {}).finally(() => {
    settled = true;
  });
  await jest.advanceTimersByTimeAsync(5000);
  expect(settled).toBe(false);
  readStatus.mockResolvedValue(status(true));
  await jest.advanceTimersByTimeAsync(5000);
  await expect(wait).resolves.toBeUndefined();
});
