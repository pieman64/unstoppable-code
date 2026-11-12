import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCanopyDaemonHostLaunch } from '../daemon-host';

it('reports a failed packaged spawn and exit status, then permits a transient retry', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'daemon-diagnostic-')),
  );
  const executable =
    process.platform === 'win32'
      ? 'C:\\Program Files\\Unstoppable Code\\resources\\bin\\unstoppable-coded.exe'
      : '/opt/Unstoppable Code/resources/bin/unstoppable-coded';
  const events: unknown[] = [];
  let exit!: (value: { code: number | null; signal: string | null }) => void;
  const child = {
    pid: 4242,
    exited: new Promise<{ code: number | null; signal: string | null }>(
      (done) => {
        exit = done;
      },
    ),
    commit: jest.fn(),
    terminate: jest.fn(() => Promise.resolve()),
  };
  const spawn = jest
    .fn()
    .mockRejectedValueOnce(new Error('secret stdin, token, path and stderr'))
    .mockResolvedValue(child);
  const launch = createCanopyDaemonHostLaunch({
    dataRoot: root,
    runtimeMode: 'prod',
    platform: process.platform === 'win32' ? 'win32' : 'linux',
    executable,
    expectedEndpoint: { kind: 'pipe', path: '\\\\.\\pipe\\test' },
    environmentSource: {},
    supervision: {
      childEnvironment: () => ({}),
      inspectProcess: async () => ({ state: 'unverifiable' }),
    },
    ownedChildren: { spawn },
    prepareRuntime: async () => {
      await mkdir(join(root, 'runtime'), { recursive: true });
    },
    verifyPrivateFile: async () => {},
    onDiagnostic: (event) => {
      events.push(event);
    },
  });
  const signal = new AbortController().signal;
  try {
    const command = { executable, args: [], signal };
    await expect(launch.ports.supervisor.spawnDaemon(command)).rejects.toThrow(
      'Core executable could not be started.',
    );
    expect(events).toEqual([{ stage: 'owned-child-spawn' }]);
    const daemon = await launch.ports.supervisor.spawnDaemon(command);
    exit({ code: 1, signal: null });
    await daemon.exited;
    expect(events).toEqual([
      { stage: 'owned-child-spawn' },
      { stage: 'daemon-exit', code: 1 },
    ]);
    await expect(
      launch.ports.supervisor.inspectProcess(4242, signal),
    ).rejects.toThrow('Core process identity is unverifiable');
    expect(events).toContainEqual({ stage: 'process-identity' });
    await launch.ports.supervisor.terminateDaemon(daemon, signal);
    expect(child.terminate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(events)).not.toContain('secret');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('diagnostic observers cannot turn a launch failure into a different failure', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'daemon-diagnostic-')),
  );
  const events: unknown[] = [];
  const launch = createCanopyDaemonHostLaunch({
    dataRoot: root,
    runtimeMode: 'prod',
    platform: process.platform === 'win32' ? 'win32' : 'linux',
    executable: process.execPath,
    expectedEndpoint: { kind: 'pipe', path: 'unused' },
    environmentSource: {},
    supervision: {
      childEnvironment: () => ({}),
      inspectProcess: async () => ({ state: 'absent' }),
    },
    prepareRuntime: async () => {
      throw new Error('private permission failure');
    },
    verifyPrivateFile: async () => {},
    onDiagnostic: (event) => {
      events.push(event);
      throw new Error('observer');
    },
  });
  try {
    await expect(
      launch.ports.descriptor.read(new AbortController().signal),
    ).rejects.toThrow('Core runtime directory validation failed.');
    expect(events).toEqual([{ stage: 'runtime-directory' }]);
    expect(JSON.stringify(events)).not.toContain('private permission failure');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
