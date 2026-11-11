// CAN-6087: the synchronous (execFileSync) and asynchronous (execFile) gdbus
// drivers run one probe conversation, with the same calls and classification.
jest.unmock('../linux-secret-service');

const mockReplies = new Map<string, string>();
const mockCalls: { kind: 'sync' | 'async'; args: readonly string[] }[] = [];
let mockFailMethod: string | null = null;

function mockReply(args: readonly string[]): string {
  const method = args[args.indexOf('--method') + 1] ?? '';
  if (method === mockFailMethod) throw new Error('gdbus failed');
  return `${mockReplies.get(method) ?? ''}\n`;
}

jest.mock('node:child_process', () => ({
  execFileSync: (_file: string, args: readonly string[]): string => {
    mockCalls.push({ kind: 'sync', args });
    return mockReply(args);
  },
  execFile: (
    _file: string,
    args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string) => void,
  ): { stdin: { end: () => void } } => {
    mockCalls.push({ kind: 'async', args });
    setImmediate(() => {
      let stdout: string;
      try {
        stdout = mockReply(args);
      } catch (error) {
        callback(error instanceof Error ? error : new Error('gdbus'), '');
        return;
      }
      callback(null, stdout);
    });
    return { stdin: { end: (): void => undefined } };
  },
}));

import {
  getLinuxSecretServiceState,
  getLinuxSecretServiceStateAsync,
} from '../linux-secret-service';

function callsOf(kind: 'sync' | 'async'): (readonly string[])[] {
  return mockCalls.filter((call) => call.kind === kind).map(({ args }) => args);
}

beforeEach(() => {
  mockCalls.length = 0;
  mockFailMethod = null;
  mockReplies.clear();
  mockReplies.set('org.freedesktop.DBus.GetNameOwner', "(':1.42',)");
  mockReplies.set(
    'org.freedesktop.Secret.Service.ReadAlias',
    "(objectpath '/org/freedesktop/secrets/collection/login',)",
  );
});

it.each([
  ['(<false>,)', 'secure'],
  ['(<true>,)', 'locked'],
  ['(<unexpected>,)', 'unavailable'],
])('classifies Locked %s as %s on both drivers', async (reply, state) => {
  mockReplies.set('org.freedesktop.DBus.Properties.Get', reply);
  expect(getLinuxSecretServiceState()).toBe(state);
  await expect(getLinuxSecretServiceStateAsync()).resolves.toBe(state);
  const sync = callsOf('sync');
  expect(sync).toHaveLength(3);
  expect(callsOf('async')).toEqual(sync);
  // Both later calls are bound to the observed provider and collection.
  expect(sync[1]).toEqual(expect.arrayContaining(['--dest', ':1.42']));
  expect(sync[2]).toEqual(
    expect.arrayContaining([
      '--object-path',
      '/org/freedesktop/secrets/collection/login',
    ]),
  );
});

it('stops at an absent provider and classifies failed calls as unavailable', async () => {
  mockReplies.set('org.freedesktop.DBus.GetNameOwner', '');
  expect(getLinuxSecretServiceState()).toBe('unavailable');
  await expect(getLinuxSecretServiceStateAsync()).resolves.toBe('unavailable');
  expect(mockCalls).toHaveLength(2);

  mockReplies.set('org.freedesktop.DBus.GetNameOwner', "(':1.42',)");
  mockFailMethod = 'org.freedesktop.Secret.Service.ReadAlias';
  expect(getLinuxSecretServiceState()).toBe('unavailable');
  await expect(getLinuxSecretServiceStateAsync()).resolves.toBe('unavailable');
});
