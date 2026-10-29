import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createPlatformEndpointServices,
  evaluatePipeDescriptor,
  loadWindowsPipeSecurity,
  type WindowsPipeSecurity,
} from '../endpoints';

// Fake-native contract tests: they prove fail-closed wiring on every host and
// are not Windows security evidence (see windows-pipe-security.test.ts).
const USER = 'S-1-5-21-1-2-3-1001';
const OWNER_ONLY = { type: 0, flags: 0, mask: 0x0012019f, sid: USER };
const receipt = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    user: USER,
    owner: USER,
    protected: true,
    aces: [OWNER_ONLY],
    ...overrides,
  });
const address = {
  kind: 'named-pipe',
  path: '\\\\.\\pipe\\canopy-x-a',
} as const;

type Accept = (error: unknown, fd: unknown) => void;
function fakeNative(overrides: Partial<WindowsPipeSecurity> = {}): {
  readonly native: WindowsPipeSecurity;
  readonly closed: () => number;
  readonly accept: () => Accept | undefined;
} {
  let closes = 0;
  let onConnection: Accept | undefined;
  const server = {};
  const native: WindowsPipeSecurity = {
    userSid: () => USER,
    createServer: () => server,
    describe: () => receipt(),
    listen: (_server, callback) => {
      onConnection = callback;
    },
    close: () => {
      closes += 1;
    },
    ...overrides,
  };
  return { native, closed: () => closes, accept: () => onConnection };
}
const pipes = (
  native: WindowsPipeSecurity,
): ReturnType<typeof createPlatformEndpointServices> =>
  createPlatformEndpointServices('win32', { namedPipeSecurity: native });

describe('Windows pipe security contract (fake native)', () => {
  it.each<[string, string, string | null]>([
    ['owner-only', receipt(), null],
    ['malformed', '{"user":', 'receipt is malformed'],
    ['no identity', receipt({ user: null }), 'user identity is unknown'],
    [
      'foreign owner',
      receipt({ owner: 'S-1-5-32-544' }),
      'owned by another account',
    ],
    [
      'inheritable DACL',
      receipt({ protected: false }),
      'DACL inherits entries',
    ],
    ['empty DACL', receipt({ aces: [] }), 'DACL is not owner-only'],
    [
      'Everyone read',
      receipt({
        aces: [OWNER_ONLY, { ...OWNER_ONLY, sid: 'S-1-1-0', mask: 0x120089 }],
      }),
      'DACL is not owner-only',
    ],
    [
      'deny entry',
      receipt({ aces: [{ ...OWNER_ONLY, type: 1 }] }),
      'DACL is not owner-only',
    ],
    [
      'inherited flag',
      receipt({ aces: [{ ...OWNER_ONLY, flags: 16 }] }),
      'DACL is not owner-only',
    ],
    [
      'broader mask',
      receipt({ aces: [{ ...OWNER_ONLY, mask: 0x1f01ff }] }),
      'owner access mask differs',
    ],
  ])('classifies a %s receipt', (_name, text, expected) => {
    expect(evaluatePipeDescriptor(text)).toBe(expected);
  });

  it('reports in-use without closing anything', async () => {
    const fake = fakeNative({ createServer: () => null });
    expect(await pipes(fake.native).bind(address)).toEqual({ kind: 'in-use' });
    expect(fake.closed()).toBe(0);
  });

  it.each<[string, Partial<WindowsPipeSecurity>, string]>([
    [
      'an invalid server handle',
      { createServer: (): string => 'handle' },
      'unavailable',
    ],
    [
      'a non-private descriptor',
      { describe: (): string => receipt({ owner: 'S-1-1-0' }) },
      'Pipe access unverified.',
    ],
    [
      'a describe failure',
      {
        describe: (): never => {
          throw new Error('GetSecurityInfo failed');
        },
      },
      'GetSecurityInfo failed',
    ],
    [
      'a listen failure',
      {
        listen: (): never => {
          throw new Error('CreateThread failed');
        },
      },
      'CreateThread failed',
    ],
  ])(
    'fails closed on %s and releases the server',
    async (_name, overrides, message) => {
      const fake = fakeNative(overrides);
      await expect(pipes(fake.native).bind(address)).rejects.toThrow(message);
      expect(fake.closed()).toBe(overrides.createServer ? 0 : 1);
    },
  );

  it('keeps holding the pipe name after a native accept error until close', async () => {
    for (const [error, fd] of [
      ['ERROR_BROKEN_PIPE', null],
      [null, 'fd'],
    ]) {
      const fake = fakeNative();
      const bound = await pipes(fake.native).bind(address);
      if (bound.kind !== 'bound') throw new Error('Not bound');
      fake.accept()?.(error, fd);
      fake.accept()?.(null, 3);
      expect(fake.closed()).toBe(0);
      await bound.listener.close();
      expect(fake.closed()).toBe(1);
    }
  });

  it('closes the native server exactly once on listener close', async () => {
    const fake = fakeNative();
    const bound = await pipes(fake.native).bind(address);
    if (bound.kind !== 'bound') throw new Error('Not bound');
    await Promise.all([bound.listener.close(), bound.listener.close()]);
    fake.accept()?.(null, 3);
    expect(fake.closed()).toBe(1);
  });

  it('refuses a missing or non-addon module with fixed text', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pipe-addon-'));
    try {
      const bogus = path.join(directory, 'windows-pipe-security.node');
      expect(() => loadWindowsPipeSecurity(bogus)).toThrow(
        'Named pipe security is unavailable.',
      );
      await writeFile(bogus, 'not a shared object');
      expect(() => loadWindowsPipeSecurity(bogus)).toThrow(
        'Named pipe security is unavailable.',
      );
      expect(() => loadWindowsPipeSecurity('')).toThrow(
        'Named pipe security is unavailable.',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
