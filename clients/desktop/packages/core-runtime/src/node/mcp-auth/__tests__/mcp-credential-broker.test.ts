import { inspect } from 'node:util';
import {
  McpAuthorizationUnavailableError,
  McpCredentialBroker,
  McpCredentialCapacityError,
  type McpAuthorizationOutcome,
  type McpCredentialOwner,
  type McpCredentialRef,
  type McpUpstreamAuthorization,
} from '..';

interface Subject {
  scope: string;
}
type Resolve = (subject: Subject) => Promise<string | null> | string | null;

const UPSTREAM = 'https://mcp.example.test/mcp';
const CANARY = 'secret-canary';

interface Harness {
  broker: McpCredentialBroker<Subject>;
  queue: Resolve[];
  resolveCalls: Subject[];
  invalidations: [Subject, string, string][];
  advance: (ms: number) => void;
  failInvalidation: () => void;
}

function harness(options: { maxBindings?: number } = {}): Harness {
  const queue: Resolve[] = [];
  const resolveCalls: Subject[] = [];
  const invalidations: [Subject, string, string][] = [];
  let invalidateImpl = (): Promise<void> => Promise.resolve();
  let clock = 0;
  let next = 1;
  const owner: McpCredentialOwner<Subject> = {
    scopeOf: (subject) => subject.scope,
    resolve: async (subject) => {
      resolveCalls.push(subject);
      const step = queue.shift();
      if (step) return step(subject);
      return `secret-canary-token-${next++}`;
    },
    invalidate: async (subject, token, upstreamUrl) => {
      invalidations.push([subject, token, upstreamUrl]);
      await invalidateImpl();
    },
  };
  const broker = new McpCredentialBroker<Subject>({
    owner,
    now: (): number => clock,
    ...options,
  });
  return {
    broker,
    queue,
    resolveCalls,
    invalidations,
    advance: (ms: number): void => {
      clock += ms;
    },
    failInvalidation: (): void => {
      invalidateImpl = (): Promise<void> =>
        Promise.reject(new Error('invalidate failed'));
    },
  };
}

function authorize(
  broker: McpCredentialBroker<Subject>,
  credential: McpCredentialRef,
): Promise<McpAuthorizationOutcome> {
  return broker.authorize({
    credential,
    purpose: 'mcp.upstream.forward',
    upstreamUrl: UPSTREAM,
  });
}

async function authorized(
  broker: McpCredentialBroker<Subject>,
  credential: McpCredentialRef,
): Promise<McpUpstreamAuthorization> {
  const outcome = await authorize(broker, credential);
  if (outcome.status !== 'authorized') throw new Error('expected authorized');
  return outcome.authorization;
}

describe('MCP credential broker (CAN-4126)', () => {
  it('an authorization handle writes the bearer once and exposes no token', async () => {
    const { broker } = harness();
    const handle = await authorized(broker, broker.bind({ scope: 'a' }));
    const h1: Record<string, string> = {};
    const h2: Record<string, string> = { accept: 'application/json' };
    expect(handle.apply(h1)).toBe('applied');
    expect(h1.Authorization).toBe('Bearer secret-canary-token-1');
    expect(handle.apply(h2)).toBe('stale');
    expect(h2).toEqual({ accept: 'application/json' });
    expect(Object.keys(handle)).toEqual(['apply', 'rejected']);
    const opaque: unknown = handle;
    for (const text of [
      JSON.stringify(handle),
      String(opaque),
      inspect(handle, { depth: 5, showHidden: true }),
    ])
      expect(text).not.toContain(CANARY);
  });

  it('a handle older than 60 seconds is stale', async () => {
    const { broker, advance } = harness();
    const handle = await authorized(broker, broker.bind({ scope: 'a' }));
    advance(60_001);
    const headers: Record<string, string> = {};
    expect(handle.apply(headers)).toBe('stale');
    expect(headers).toEqual({});
  });

  it('revoking a scope stales every outstanding handle of that scope and no other', async () => {
    const { broker } = harness();
    const a1 = broker.bind({ scope: 'a' });
    const a2 = broker.bind({ scope: 'a' });
    const b = broker.bind({ scope: 'b' });
    const handles = [
      await authorized(broker, a1),
      await authorized(broker, a2),
      await authorized(broker, b),
    ];
    broker.revokeScope('a');
    expect(handles[0]?.apply({})).toBe('stale');
    expect(handles[1]?.apply({})).toBe('stale');
    expect(handles[2]?.apply({})).toBe('applied');
    expect((await authorized(broker, a1)).apply({})).toBe('applied');
  });

  it("a revocation during the owner's read never yields the revoked token", async () => {
    const { broker, queue, resolveCalls } = harness();
    const credential = broker.bind({ scope: 'a' });
    queue.push(
      () => {
        broker.revokeScope('a');
        return 'old';
      },
      () => 'new',
    );
    const headers: Record<string, string> = {};
    expect((await authorized(broker, credential)).apply(headers)).toBe(
      'applied',
    );
    expect(headers.Authorization).toBe('Bearer new');

    resolveCalls.length = 0;
    queue.push(
      () => {
        broker.revokeScope('a');
        return 'old';
      },
      () => {
        broker.revokeScope('a');
        return 'new';
      },
    );
    await expect(authorize(broker, credential)).resolves.toEqual({
      status: 'none',
    });
    expect(resolveCalls).toHaveLength(2);
  });

  it('an unknown, released or malformed reference authorizes none', async () => {
    const { broker, resolveCalls } = harness();
    const live = broker.bind({ scope: 'a' });
    const handle = await authorized(broker, live);
    resolveCalls.length = 0;
    const released = broker.bind({ scope: 'a' });
    broker.release(released);
    broker.release(live);
    const refs: unknown[] = [
      { credentialId: 'mcpc1_AAAAAAAAAAAAAAAAAAAAAA' },
      released,
      { credentialId: 'x' },
      {},
    ];
    for (const credential of refs)
      await expect(
        broker.authorize({
          credential: credential as McpCredentialRef,
          purpose: 'mcp.upstream.forward',
          upstreamUrl: UPSTREAM,
        }),
      ).resolves.toEqual({ status: 'none' });
    expect(resolveCalls).toHaveLength(0);
    expect(handle.apply({})).toBe('stale');
  });

  it('an unknown purpose authorizes none', async () => {
    const { broker, resolveCalls } = harness();
    const credential = broker.bind({ scope: 'a' });
    await expect(
      broker.authorize({
        credential,
        purpose: 'other' as never,
        upstreamUrl: UPSTREAM,
      }),
    ).resolves.toEqual({ status: 'none' });
    expect(resolveCalls).toHaveLength(0);
  });

  it('an owner failure is unavailable with a fixed message', async () => {
    const { broker, queue } = harness();
    const credential = broker.bind({ scope: 'a' });
    queue.push(() => {
      throw new Error('secret-canary-owner');
    });
    let caught: unknown;
    try {
      await authorize(broker, credential);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(McpAuthorizationUnavailableError);
    const error = caught as McpAuthorizationUnavailableError;
    expect(error.message).toBe(
      'MCP authorization is temporarily unavailable. Try again shortly.',
    );
    for (const text of [
      String(error),
      error.message,
      String(error.cause),
      JSON.stringify(error),
    ])
      expect(text).not.toContain(CANARY);
  });

  it('a rejection invalidates exactly the applied token once', async () => {
    const { broker, invalidations, failInvalidation } = harness();
    const subject = { scope: 'a' };
    const credential = broker.bind(subject);
    const handle = await authorized(broker, credential);
    await handle.rejected();
    expect(invalidations).toHaveLength(0);
    expect(handle.apply({})).toBe('applied');
    await handle.rejected();
    expect(invalidations).toEqual([
      [subject, 'secret-canary-token-1', UPSTREAM],
    ]);
    await handle.rejected();
    expect(invalidations).toHaveLength(1);

    failInvalidation();
    const failing = await authorized(broker, credential);
    expect(failing.apply({})).toBe('applied');
    await expect(failing.rejected()).resolves.toBeUndefined();
    expect(invalidations).toHaveLength(2);
  });

  it('bindings are capped and closing releases everything', async () => {
    const { broker } = harness({ maxBindings: 2 });
    const first = broker.bind({ scope: 'a' });
    broker.bind({ scope: 'b' });
    expect(() => broker.bind({ scope: 'c' })).toThrow(
      McpCredentialCapacityError,
    );
    broker.close();
    expect(broker.size).toBe(0);
    await expect(authorize(broker, first)).resolves.toEqual({
      status: 'none',
    });
    expect(() => broker.bind({ scope: 'a' })).toThrow(
      'MCP credential broker closed.',
    );
  });
});
