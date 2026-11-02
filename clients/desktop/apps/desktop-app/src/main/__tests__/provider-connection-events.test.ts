import {
  type ProviderConnectionEvent,
  observeProviderConnection,
  resetProviderConnectionEventsForTests,
  subscribeProviderConnections,
  withProviderConnectionAttempt,
} from '../lib/provider-connection-events';

beforeEach(resetProviderConnectionEventsForTests);

it('separates an existing connection, a real change and repeated reads', () => {
  const listener = jest.fn<void, [ProviderConnectionEvent]>();
  const stop = subscribeProviderConnections(listener);
  const base = {
    provider: 'copilot',
    connectionMethod: 'native_login',
  } as const;
  observeProviderConnection({
    ...base,
    fingerprint: 'private-account-one',
    via: 'read',
  });
  observeProviderConnection({
    ...base,
    fingerprint: 'private-account-one',
    via: 'read',
  });
  observeProviderConnection({
    ...base,
    fingerprint: 'private-account-two',
    via: 'read',
  });
  expect(listener.mock.calls.map(([event]) => event)).toEqual([
    {
      provider: 'copilot',
      connectionMethod: 'native_login',
      connectSource: 'at_startup',
    },
    {
      provider: 'copilot',
      connectionMethod: 'native_login',
      connectSource: 'external_change',
    },
  ]);
  expect(JSON.stringify(listener.mock.calls)).not.toContain('private-account');
  stop();
});

it.each(['copilot', 'opencode', 'ollama', 'model_gateway'] as const)(
  'deduplicates %s setup and permits a reconnection after disconnect',
  (provider) => {
    const listener = jest.fn<void, [ProviderConnectionEvent]>();
    subscribeProviderConnections(listener);
    const base = {
      provider,
      connectionMethod: 'api_key',
      via: 'in_app',
    } as const;
    observeProviderConnection({ ...base, fingerprint: 'connected' });
    observeProviderConnection({ ...base, fingerprint: 'connected' });
    observeProviderConnection({ ...base, fingerprint: null });
    observeProviderConnection({ ...base, fingerprint: 'connected' });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith({
      provider,
      connectionMethod: 'api_key',
      connectSource: 'in_app',
    });
  },
);

it('replays only current baselines to a late telemetry subscriber', () => {
  observeProviderConnection({
    provider: 'opencode',
    connectionMethod: 'native_login',
    fingerprint: 'present',
    via: 'read',
  });
  const listener = jest.fn<void, [ProviderConnectionEvent]>();
  subscribeProviderConnections(listener);
  expect(listener).toHaveBeenCalledWith({
    provider: 'opencode',
    connectionMethod: 'native_login',
    connectSource: 'at_startup',
  });
});

it('a broken subscriber cannot break provider setup or other subscribers', () => {
  subscribeProviderConnections(() => {
    throw new Error('collector unavailable');
  });
  const listener = jest.fn<void, [ProviderConnectionEvent]>();
  subscribeProviderConnections(listener);
  expect(() =>
    observeProviderConnection({
      provider: 'ollama',
      connectionMethod: 'local',
      fingerprint: 'ready',
      via: 'in_app',
    }),
  ).not.toThrow();
  expect(listener).toHaveBeenCalledTimes(1);
});

it.each([
  [
    Object.assign(new Error('secret token'), { name: 'TimeoutError' }),
    'timeout',
  ],
  [Object.assign(new Error('private'), { name: 'AbortError' }), 'cancelled'],
  [Object.assign(new Error('private'), { code: 'ECONNREFUSED' }), 'network'],
  [
    Object.assign(new Error('private'), { code: 'ENOENT' }),
    'runtime_unavailable',
  ],
  [new Error('GitHub sign-in was declined.'), 'authentication'],
  [new Error("Couldn't connect to Ollama on 127.0.0.1:11534."), 'network'],
  [new Error('unrecognized private failure'), 'other'],
])(
  'emits a bounded failure and preserves the original rejection',
  async (error, reason) => {
    const listener = jest.fn<void, [ProviderConnectionEvent]>();
    subscribeProviderConnections(listener);
    await expect(
      withProviderConnectionAttempt('copilot', 'native_login', undefined, () =>
        Promise.reject(error),
      ),
    ).rejects.toBe(error);
    expect(listener).toHaveBeenCalledWith({
      provider: 'copilot',
      connectionMethod: 'native_login',
      connectSource: 'in_app',
      failureReason: reason,
    });
    expect(JSON.stringify(listener.mock.calls)).not.toMatch(
      /secret|private|declined/,
    );
  },
);

it('does not turn successful status reads into successful setup events', async () => {
  const listener = jest.fn<void, [ProviderConnectionEvent]>();
  subscribeProviderConnections(listener);
  await expect(
    withProviderConnectionAttempt('ollama', 'local', undefined, () =>
      Promise.resolve('unchanged'),
    ),
  ).resolves.toBe('unchanged');
  expect(listener).not.toHaveBeenCalled();
});

it('advances a loss-only metadata baseline without publishing a new connection', () => {
  const listener = jest.fn<void, [ProviderConnectionEvent]>();
  subscribeProviderConnections(listener);
  const base = {
    provider: 'opencode',
    connectionMethod: 'native_login',
    via: 'read',
  } as const;
  observeProviderConnection({ ...base, fingerprint: 'accounts-a-b' });
  listener.mockClear();
  const loss = { ...base, fingerprint: 'account-a', baselineOnly: true };
  observeProviderConnection(loss);
  observeProviderConnection({ ...base, fingerprint: 'account-a' });
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledWith({
    provider: 'opencode',
    connectionMethod: 'native_login',
    connectSource: 'at_startup',
  });
  listener.mockClear();
  const late = jest.fn<void, [ProviderConnectionEvent]>();
  subscribeProviderConnections(late);
  expect(late).toHaveBeenCalledWith({
    provider: 'opencode',
    connectionMethod: 'native_login',
    connectSource: 'at_startup',
  });
  observeProviderConnection({ ...base, fingerprint: 'account-c' });
  expect(listener.mock.calls.map(([event]) => event)).toEqual([
    {
      provider: 'opencode',
      connectionMethod: 'native_login',
      connectSource: 'external_change',
    },
  ]);
});
