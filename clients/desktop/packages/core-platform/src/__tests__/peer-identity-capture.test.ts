import {
  createPeerIdentityServices,
  daemonRequirement,
  launcherRequirement,
  peerCaptureFor,
} from '../peer-identity';
import * as ownedChild from '../supervision/owned-child';

it('carries the daemon native snapshot and the owned-child lineage separately', () => {
  const channel = { read: jest.fn(), write: jest.fn(), close: jest.fn() };
  const token = Buffer.alloc(32);
  const capture = { native: 'observed-daemon' };
  const captureGuest = jest.fn(() => ({ state: 'satisfied', capture }));
  const checkGuest = jest.fn();
  const peer = jest.spyOn(ownedChild, 'channelPeer').mockReturnValue({
    state: 'peer',
    pid: 42,
    pidversion: 7,
    token,
  });
  const load = jest.spyOn(process, 'dlopen').mockImplementation((module) => {
    Object.assign(module, {
      exports: {
        claimLauncherChannel: jest.fn(),
        channelRead: jest.fn(),
        channelWrite: jest.fn(),
        channelClose: jest.fn(),
        launcherEvidence: jest.fn(),
        checkGuest,
        captureGuest,
      },
    });
  });
  try {
    const required = daemonRequirement({
      team: 'ABCDE12345',
      identifier: 'com.example.daemon',
      build: { kind: 'cdhash', cdhash: 'a'.repeat(40) },
    });
    const services = createPeerIdentityServices({
      os: 'darwin',
      nativePath: '/test/native.node',
    });
    expect(services.captureDaemonEvidence(channel, required)).toEqual({
      ok: true,
      evidence: { role: 'daemon', pid: 42, pidversion: 7 },
    });
    expect(captureGuest).toHaveBeenCalledWith(token, required.text);
    expect(checkGuest).not.toHaveBeenCalled();
    expect(peerCaptureFor(channel)).toEqual({
      os: 'darwin',
      spawned: { pid: 42, pidversion: 7, unreaped: true },
      peer: capture,
    });
    expect(() => services.captureDaemonEvidence(channel, required)).toThrow(
      'Peer evidence was already captured for this channel.',
    );
    expect(captureGuest).toHaveBeenCalledTimes(1);
  } finally {
    load.mockRestore();
    peer.mockRestore();
  }
});

it('carries the native capture to admission without substituting expected identity', () => {
  const handle = {};
  const capture = Object.freeze({
    native: 'sentinel',
    signing: { buildId: 'observed-build' },
  });
  const load = jest.spyOn(process, 'dlopen').mockImplementation((module) => {
    Object.assign(module, {
      exports: {
        claimLauncherChannel: (): unknown => ({ state: 'channel', handle }),
        channelRead: (): null => null,
        channelWrite: (): number => 0,
        channelClose: (): boolean => true,
        launcherEvidence: (): unknown => ({
          state: 'launcher',
          pid: 42,
          pidversion: 7,
          capture,
        }),
        checkGuest: (): unknown => ({ state: 'satisfied' }),
      },
    });
  });
  try {
    const services = createPeerIdentityServices({
      os: 'darwin',
      nativePath: '/test/native.node',
    });
    const claimed = services.claimLauncherChannel();
    if (!claimed.ok) throw new Error('claim failed');
    expect(peerCaptureFor(claimed.channel)).toBeUndefined();
    services.captureLauncherEvidence(
      claimed.channel,
      launcherRequirement({
        team: 'ABCDE12345',
        identifier: 'com.example.app',
        buildId: 'expected-build',
      }),
    );
    expect(peerCaptureFor(claimed.channel)).toBe(capture);
    expect(
      peerCaptureFor({ read: jest.fn(), write: jest.fn(), close: jest.fn() }),
    ).toBeUndefined();
  } finally {
    load.mockRestore();
  }
});

it('uses exactly VA-2 requirement text without changing the standard builder contract', async () => {
  const { migrationLauncherRequirement, migrationDaemonRequirement } =
    await import('@canopy/core-runtime/node/vault');
  const { daemonRequirement } = await import('../peer-identity');
  const expected = {
    teamId: 'ABCDE12345',
    flavorId: 'com.example.app',
    secureMode: 'internal',
    buildId: 'b1',
  };
  expect(
    launcherRequirement(
      {
        team: expected.teamId,
        identifier: expected.flavorId,
        buildId: expected.buildId,
      },
      true,
    ).text,
  ).toBe(migrationLauncherRequirement(expected));
  const daemon = {
    teamId: expected.teamId,
    identifier: 'com.example.app.daemon',
    binding: {
      kind: 'entitlement' as const,
      key: 'com.example.build',
      value: 'b1',
    },
  };
  expect(
    daemonRequirement(
      {
        team: daemon.teamId,
        identifier: daemon.identifier,
        build: daemon.binding,
      },
      true,
    ).text,
  ).toBe(migrationDaemonRequirement(daemon));
});
