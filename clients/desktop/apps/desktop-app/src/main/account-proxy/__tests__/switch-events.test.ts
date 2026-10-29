const mockAccounts = new Map<
  string,
  { label: string; provider: string; status: string }
>();
jest.mock('../service', () => ({
  findAccountProxyAccount: (authIndex: string): unknown =>
    mockAccounts.get(authIndex) ?? null,
}));

import {
  recordAccountProxyResponse,
  resetAccountProxyAttributionForTests,
} from '../attribution';
import {
  watchAccountProxySwitches,
  type AccountProxySwitchEvent,
} from '../switch-events';

const SAM = 'a1f3c2d4a1f3c2d4';
const OPS = '9b07e1aa9b07e1aa';

function respond(sessionId: string, authIndex: string): void {
  recordAccountProxyResponse({
    sessionId,
    connectionId: 'conn-1',
    traceHeader: `20261012204400-${authIndex}-0001`,
    lookupAccount: () => null,
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('account proxy switch events', () => {
  beforeEach(() => {
    resetAccountProxyAttributionForTests();
    mockAccounts.clear();
    mockAccounts.set(SAM, {
      label: 'sam@example.com',
      provider: 'claude',
      status: 'active',
    });
    mockAccounts.set(OPS, {
      label: 'ops@example.com',
      provider: 'claude',
      status: 'cooling',
    });
  });

  it('emits a line when the chat moves to another account', async () => {
    const events: AccountProxySwitchEvent[] = [];
    const stop = watchAccountProxySwitches(
      'proj/wt/chat',
      (event) => {
        events.push(event);
      },
      () => 1_000,
    );
    respond('proj/wt/chat', OPS);
    respond('proj/wt/chat', OPS);
    // Another chat moving is not this chat's line.
    respond('proj/wt/other', OPS);
    respond('proj/wt/other', SAM);
    respond('proj/wt/chat', SAM);
    await flush();

    expect(events).toEqual([
      {
        type: 'canopy_account_proxy_switch',
        sourceEventId: 'account-proxy-switch:1000:1',
        timestamp: 1_000,
        account: 'sam@example.com',
        previousAccount: 'ops@example.com',
        // The account it left is cooling down: it reached a limit.
        previousAtLimit: true,
        provider: 'claude',
      },
    ]);

    stop();
    respond('proj/wt/chat', OPS);
    await flush();
    expect(events).toHaveLength(1);
  });

  it('names accounts the last list did not include', async () => {
    mockAccounts.clear();
    const events: AccountProxySwitchEvent[] = [];
    watchAccountProxySwitches('chat', (event) => {
      events.push(event);
    });
    respond('chat', SAM);
    respond('chat', OPS);
    await flush();
    expect(events).toEqual([
      expect.objectContaining({
        account: 'Account 9b07e1aa',
        previousAccount: 'Account a1f3c2d4',
      }),
    ]);
    expect(events[0]).not.toHaveProperty('previousAtLimit');
  });

  it('keeps counting when emitting fails', async () => {
    const emit = jest.fn(() => Promise.reject(new Error('session closed')));
    watchAccountProxySwitches('chat', emit);
    respond('chat', SAM);
    respond('chat', OPS);
    respond('chat', SAM);
    await flush();
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
