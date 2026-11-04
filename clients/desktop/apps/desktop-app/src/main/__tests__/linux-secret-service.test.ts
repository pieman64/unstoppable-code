import { execFileSync } from 'node:child_process';
import { getLinuxSecretServiceState } from '../lib/linux-secret-service';

// Exercise the real adapter; consumer suites use the shared synthetic provider.
jest.unmock('../lib/linux-secret-service');
jest.mock('node:child_process', () => ({ execFileSync: jest.fn() }));
jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getLinuxProbeEnv: (): Record<string, string> => ({
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  }),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
  logMainProcessError: jest.fn(),
}));

import {
  logMainProcessError,
  logMainProcessWarn,
} from '../lib/main-process-logging';

const execFileSyncMock = jest.mocked(execFileSync);
const ownerReply = "(':1.42',)\n";
const aliasReply =
  "(objectpath '/org/freedesktop/secrets/collection/login',)\n";
const unlockedReply = '(<false>,)\n';
const lockedReply = '(<true>,)\n';

function reply(...outputs: string[]): void {
  for (const output of outputs) execFileSyncMock.mockReturnValueOnce(output);
}

beforeEach(() => {
  jest.resetAllMocks();
  execFileSyncMock.mockImplementation(() => {
    throw new Error('Unexpected native probe');
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('observes unavailable, restored, locked, and unlocked in the same process', () => {
  execFileSyncMock.mockImplementationOnce(() => {
    throw Object.assign(new Error('NameHasNoOwner'), { code: 1 });
  });
  reply(ownerReply, aliasReply, unlockedReply);
  reply(ownerReply, aliasReply, lockedReply);
  reply(ownerReply, aliasReply, unlockedReply);

  expect(getLinuxSecretServiceState()).toBe('unavailable');
  expect(getLinuxSecretServiceState()).toBe('secure');
  expect(getLinuxSecretServiceState()).toBe('locked');
  expect(getLinuxSecretServiceState()).toBe('secure');
  expect(execFileSyncMock).toHaveBeenCalledTimes(10);
});

test('uses only bounded, noninteractive metadata calls pinned to the live unique owner', () => {
  reply(ownerReply, aliasReply, unlockedReply);
  expect(getLinuxSecretServiceState()).toBe('secure');

  const request = (
    destination: string,
    path: string,
    method: string,
    args: string[],
  ): string[] => [
    'call',
    '--session',
    '--dest',
    destination,
    '--object-path',
    path,
    '--method',
    method,
    '--timeout',
    '1',
    ...args,
  ];
  const options = {
    encoding: 'utf8',
    killSignal: 'SIGKILL',
    maxBuffer: 4096,
    env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  expect(execFileSyncMock.mock.calls).toEqual([
    [
      '/usr/bin/gdbus',
      request(
        'org.freedesktop.DBus',
        '/org/freedesktop/DBus',
        'org.freedesktop.DBus.GetNameOwner',
        ['org.freedesktop.secrets'],
      ),
      expect.objectContaining(options),
    ],
    [
      '/usr/bin/gdbus',
      request(
        ':1.42',
        '/org/freedesktop/secrets',
        'org.freedesktop.Secret.Service.ReadAlias',
        ['default'],
      ),
      expect.objectContaining(options),
    ],
    [
      '/usr/bin/gdbus',
      request(
        ':1.42',
        '/org/freedesktop/secrets/collection/login',
        'org.freedesktop.DBus.Properties.Get',
        ['org.freedesktop.Secret.Collection', 'Locked'],
      ),
      expect.objectContaining(options),
    ],
  ]);
  for (const [, , options] of execFileSyncMock.mock.calls) {
    expect(options?.timeout).toBeGreaterThan(0);
    expect(options?.timeout).toBeLessThanOrEqual(1500);
  }
});

test('shares one time budget across calls and stops when it is exhausted', () => {
  const now = jest.spyOn(performance, 'now');
  now
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(1000)
    .mockReturnValueOnce(1500);
  reply(ownerReply, aliasReply, unlockedReply);

  expect(getLinuxSecretServiceState()).toBe('unavailable');
  expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  expect(execFileSyncMock.mock.calls[0]?.[2]?.timeout).toBe(1500);
  expect(execFileSyncMock.mock.calls[1]?.[2]?.timeout).toBe(500);
});

test('does not cache either successful observations or provider identity', () => {
  reply(ownerReply, aliasReply, unlockedReply);
  reply(
    "(':1.99',)",
    "(objectpath '/org/freedesktop/secrets/collection/new',)",
    lockedReply,
  );
  expect(getLinuxSecretServiceState()).toBe('secure');
  expect(getLinuxSecretServiceState()).toBe('locked');
  expect(execFileSyncMock).toHaveBeenCalledTimes(6);
  expect(execFileSyncMock.mock.calls[4]?.[1]).toContain(':1.99');
  expect(execFileSyncMock.mock.calls[5]?.[1]).toEqual(
    expect.arrayContaining([
      ':1.99',
      '/org/freedesktop/secrets/collection/new',
    ]),
  );
});

test.each([
  '',
  '()',
  '(true,)',
  "('org.freedesktop.secrets',)",
  "(':1.42')",
  "(':1.42', 'extra')",
  "noise\n(':1.42',)",
])(
  'missing or malformed owner %p fails closed before contacting a provider',
  (output) => {
    reply(output);
    expect(getLinuxSecretServiceState()).toBe('unavailable');
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  },
);

test.each([
  '',
  '()',
  "(objectpath '/',)",
  "('/org/freedesktop/secrets/collection/login',)",
  "(objectpath 'relative/path',)",
  "(objectpath '/collection/bad-name',)",
  "(objectpath '/collection//login',)",
  "(objectpath '/collection/login/',)",
  "(objectpath '/collection/login', 'extra')",
])(
  'missing default alias or malformed collection %p fails closed',
  (output) => {
    reply(ownerReply, output, unlockedReply);
    expect(getLinuxSecretServiceState()).toBe('unavailable');
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  },
);

test.each([
  '',
  '()',
  '(false,)',
  "(<'false'>,)",
  '(<0>,)',
  '(<false>, <true>)',
  '(<false>,)\nnoise',
])('missing or malformed Locked property %p fails closed', (output) => {
  reply(ownerReply, aliasReply, output);
  expect(getLinuxSecretServiceState()).toBe('unavailable');
  expect(execFileSyncMock).toHaveBeenCalledTimes(3);
});

describe.each([0, 1, 2])('native call failure at stage %s', (stage) => {
  test.each([
    'ENOENT',
    'ETIMEDOUT',
    'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    'provider disappeared',
  ])(
    '%s fails closed without leaking diagnostics and permits a fresh retry',
    (code) => {
      const consoles = ['debug', 'error', 'info', 'log', 'warn'] as const;
      const logs = consoles.map((method) =>
        jest.spyOn(console, method).mockImplementation(() => {}),
      );
      reply(...[ownerReply, aliasReply].slice(0, stage));
      execFileSyncMock.mockImplementationOnce(() => {
        throw Object.assign(
          new Error('fixture-plaintext native-private-diagnostic'),
          {
            code,
            stdout: 'fixture-plaintext',
            stderr: 'native-private-diagnostic',
          },
        );
      });

      expect(getLinuxSecretServiceState()).toBe('unavailable');
      expect(execFileSyncMock).toHaveBeenCalledTimes(stage + 1);
      expect(logMainProcessWarn).not.toHaveBeenCalled();
      expect(logMainProcessError).not.toHaveBeenCalled();
      for (const log of logs) expect(log).not.toHaveBeenCalled();

      reply(ownerReply, aliasReply, unlockedReply);
      expect(getLinuxSecretServiceState()).toBe('secure');
    },
  );
});
