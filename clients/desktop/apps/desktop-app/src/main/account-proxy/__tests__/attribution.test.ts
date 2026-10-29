import {
  forgetAccountProxySession,
  getAccountProxySessionAccounts,
  getAccountProxySessionUsage,
  onAccountProxyAccountChange,
  onAccountProxyResponse,
  recordAccountProxyResponse,
  resetAccountProxyAttributionForTests,
  type AccountProxyAccountLookup,
} from '../attribution';

const SAM = '20261012204400-a1f3c2d4a1f3c2d4-0001';
const TEAM_KEY = '20261012204500-e2a8f640e2a8f640-0002';

const lookupAccount: AccountProxyAccountLookup = (authIndex) =>
  authIndex === 'a1f3c2d4a1f3c2d4'
    ? { label: 'sam@example.com', provider: 'claude' }
    : null;

function record(
  sessionId: string,
  traceHeader: string | null,
  connectionId = 'conn-1',
): void {
  recordAccountProxyResponse({
    sessionId,
    connectionId,
    traceHeader,
    lookupAccount,
  });
}

describe('account proxy attribution', () => {
  beforeEach(() => {
    resetAccountProxyAttributionForTests();
  });

  it('counts the requests each account served for a session', () => {
    record('chat-1', SAM);
    record('chat-1', SAM);
    record('chat-2', TEAM_KEY);
    expect(getAccountProxySessionAccounts('chat-1')).toEqual([
      {
        connectionId: 'conn-1',
        authIndex: 'a1f3c2d4a1f3c2d4',
        label: 'sam@example.com',
        provider: 'claude',
        requests: 2,
        current: true,
      },
    ]);
  });

  it('marks the latest account and reports a move between accounts', () => {
    const changes: unknown[] = [];
    onAccountProxyAccountChange((change) => changes.push(change));
    record('chat-1', SAM);
    record('chat-1', SAM);
    record('chat-1', TEAM_KEY);
    expect(changes).toEqual([
      {
        sessionId: 'chat-1',
        authIndex: 'e2a8f640e2a8f640',
        previousAuthIndex: 'a1f3c2d4a1f3c2d4',
      },
    ]);
    // An account missing from the last list read keeps its id, no label.
    expect(getAccountProxySessionAccounts('chat-1')).toEqual([
      expect.objectContaining({ requests: 2, current: false }),
      {
        connectionId: 'conn-1',
        authIndex: 'e2a8f640e2a8f640',
        label: null,
        provider: null,
        requests: 1,
        current: true,
      },
    ]);
  });

  it('counts a response that cannot move the chat without reporting a move', () => {
    const changes: unknown[] = [];
    onAccountProxyAccountChange((change) => changes.push(change));
    record('chat-1', SAM);
    // A token count, or an attempt that failed, served by another account.
    recordAccountProxyResponse({
      sessionId: 'chat-1',
      connectionId: 'conn-1',
      traceHeader: TEAM_KEY,
      lookupAccount,
      movesChat: false,
    });
    record('chat-1', SAM);
    expect(changes).toEqual([]);
    expect(getAccountProxySessionAccounts('chat-1')).toEqual([
      expect.objectContaining({ authIndex: 'a1f3c2d4a1f3c2d4', current: true }),
      expect.objectContaining({
        authIndex: 'e2a8f640e2a8f640',
        requests: 1,
        current: false,
      }),
    ]);
  });

  it('names an account from a fresher list when the reader has one', () => {
    record('chat-1', TEAM_KEY);
    expect(
      getAccountProxySessionAccounts('chat-1', (_authIndex, connectionId) =>
        connectionId === 'conn-1'
          ? { label: 'Team key', provider: 'claude' }
          : null,
      ),
    ).toEqual([
      expect.objectContaining({ label: 'Team key', provider: 'claude' }),
    ]);
  });

  it('reports each account with the connection that served it', () => {
    record('chat-1', SAM, 'old-connection');
    // Another connection's list names other credentials under the same ids.
    const lookups: unknown[] = [];
    const accounts = getAccountProxySessionAccounts(
      'chat-1',
      (authIndex, connectionId) => {
        lookups.push([authIndex, connectionId]);
        return connectionId === 'new-connection'
          ? { label: 'ops@example.com', provider: 'codex' }
          : null;
      },
    );
    expect(lookups).toEqual([['a1f3c2d4a1f3c2d4', 'old-connection']]);
    expect(accounts).toEqual([
      {
        connectionId: 'old-connection',
        authIndex: 'a1f3c2d4a1f3c2d4',
        label: 'sam@example.com',
        provider: 'claude',
        requests: 1,
        current: true,
      },
    ]);
  });

  it('tells listeners about every response with the account it named', () => {
    const responses: unknown[] = [];
    onAccountProxyResponse((response) => responses.push(response));
    record('chat-1', SAM);
    record('chat-1', 'not-a-trace');
    record('ephemeral:helper:1', SAM);
    expect(responses).toEqual([
      {
        sessionId: 'chat-1',
        connectionId: 'conn-1',
        authIndex: 'a1f3c2d4a1f3c2d4',
        label: 'sam@example.com',
        provider: 'claude',
      },
    ]);
  });

  it('keeps a listener failure from stopping the count', () => {
    onAccountProxyResponse(() => {
      throw new Error('listener failed');
    });
    record('chat-1', SAM);
    expect(getAccountProxySessionAccounts('chat-1')).toHaveLength(1);
  });

  it('summarises a session for its audit entry', () => {
    expect(getAccountProxySessionUsage('step-1')).toBeNull();
    record('step-1', TEAM_KEY);
    record('step-1', SAM);
    record('step-1', SAM);
    expect(getAccountProxySessionUsage('step-1')).toEqual({
      connectionId: 'conn-1',
      accounts: [
        {
          authIndex: 'a1f3c2d4a1f3c2d4',
          label: 'sam@example.com',
          provider: 'claude',
          requests: 2,
        },
        { authIndex: 'e2a8f640e2a8f640', requests: 1 },
      ],
    });
  });

  it('starts over when a session moves to another connection', () => {
    record('chat-1', SAM, 'conn-1');
    record('chat-1', TEAM_KEY, 'conn-2');
    expect(getAccountProxySessionUsage('chat-1')).toEqual({
      connectionId: 'conn-2',
      accounts: [{ authIndex: 'e2a8f640e2a8f640', requests: 1 }],
    });
  });

  it('waits for a successful turn to name the account on a new connection', () => {
    const changes: unknown[] = [];
    onAccountProxyAccountChange((change) => changes.push(change));
    record('chat-1', SAM, 'conn-1');
    // A token count on the new connection: counted there, but the chat has
    // no current account on it yet.
    recordAccountProxyResponse({
      sessionId: 'chat-1',
      connectionId: 'conn-2',
      traceHeader: TEAM_KEY,
      lookupAccount,
      movesChat: false,
    });
    expect(getAccountProxySessionAccounts('chat-1')).toEqual([
      expect.objectContaining({
        connectionId: 'conn-2',
        authIndex: 'e2a8f640e2a8f640',
        current: false,
      }),
    ]);
    // Its first turn there names the account without reporting a move: the
    // account it left was another connection's.
    record('chat-1', SAM, 'conn-2');
    expect(changes).toEqual([]);
    expect(getAccountProxySessionAccounts('chat-1')).toEqual([
      expect.objectContaining({
        connectionId: 'conn-2',
        authIndex: 'e2a8f640e2a8f640',
        current: false,
      }),
      expect.objectContaining({
        connectionId: 'conn-2',
        authIndex: 'a1f3c2d4a1f3c2d4',
        current: true,
      }),
    ]);
  });

  it('ignores responses without a usable trace id', () => {
    record('chat-1', null);
    record('chat-1', 'not-a-trace');
    expect(getAccountProxySessionAccounts('chat-1')).toEqual([]);
  });

  it('forgets a session on request and keeps the oldest out when full', () => {
    record('chat-1', SAM);
    forgetAccountProxySession('chat-1');
    expect(getAccountProxySessionAccounts('chat-1')).toEqual([]);
    for (let index = 0; index <= 500; index += 1) {
      record(`chat-${String(index)}`, SAM);
    }
    expect(getAccountProxySessionAccounts('chat-0')).toEqual([]);
    expect(getAccountProxySessionAccounts('chat-500')).toHaveLength(1);
  });

  it('keeps a chat that is still working when short sessions fill up', () => {
    record('live-chat', SAM);
    for (let index = 0; index < 499; index += 1) {
      record(`pipeline:run:job:step-${String(index)}:1`, SAM);
    }
    // The chat's next turn makes it the most recent session again.
    record('live-chat', SAM);
    record('pipeline:run:job:last:1', SAM);
    expect(getAccountProxySessionAccounts('live-chat')).toHaveLength(1);
    expect(getAccountProxySessionAccounts('pipeline:run:job:step-0:1')).toEqual(
      [],
    );
  });

  it('does not record helper calls that nothing can look up', () => {
    record('ephemeral:helper:1234', SAM);
    expect(getAccountProxySessionAccounts('ephemeral:helper:1234')).toEqual([]);
  });
});
