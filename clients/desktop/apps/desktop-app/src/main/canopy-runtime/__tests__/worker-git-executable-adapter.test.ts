// `worker.git.executable.get` on the desktop dispatcher over a virtual
// machine: the query is pure, the IPC projection runs the shared live
// detection whose effects apply once per probe, and a pure call never
// supersedes or duplicates a live one.
import type * as ChildProcessModule from 'node:child_process';
import { ChildProcess } from 'node:child_process';
import type * as FsPromisesModule from 'node:fs/promises';
import { join } from 'node:path';
import {
  WORKER_GIT_GRANTS,
  type CanopyCallerDescriptor,
  type WorkerGitExecutableGetParams,
} from '@canopy/protocol/canopy-core';
import type { CanopyQueryOptions } from '@canopy/core-runtime';
import type * as AdapterModule from '../worker-git-adapter';
import type * as DispatchModule from '../worker-git-dispatch';
import type * as GitExecutableModule from '../../lib/git-executable';
import type * as IpcModule from '../../ipc/git-executable';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { canopyPermissionDeniedError } from '@canopy/core-runtime';
import type { DesktopCanopyDispatcher } from '../desktop-runtime';

// The dispatcher imports terminal support, but Git detection never uses a PTY.
// Platform simulations must not load a native binary for the simulated host.
jest.mock('node-pty', () => ({
  spawn: (): never => {
    throw new Error('Git executable tests must not spawn a PTY');
  },
}));

type ExecCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

const mockHandlers = new Map<string, (event: unknown) => Promise<unknown>>();
jest.mock('node-pty', () => {
  throw new Error('Git executable tests must not load native node-pty');
});
jest.mock('../../terminal/worker-terminal', () => ({}));
jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown) => Promise<unknown>,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));

const mockExecFile = jest.fn<
  ChildProcess,
  [string, string[], unknown, ExecCallback]
>();
jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof ChildProcessModule>('node:child_process'),
  execFile: (
    file: string,
    args: string[],
    options: unknown,
    callback: ExecCallback,
  ): ChildProcess => mockExecFile(file, args, options, callback),
}));

const mockFiles = new Map<string, 'git' | 'not-git'>();
// Shaped like Node's own rejection, including the syscall.
function mockMissing(syscall: string, path: string): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`),
    { code: 'ENOENT', syscall, path },
  );
}
jest.mock('node:fs/promises', () => ({
  ...jest.requireActual<typeof FsPromisesModule>('node:fs/promises'),
  stat: (path: string): Promise<{ isFile(): boolean }> =>
    mockFiles.has(path)
      ? Promise.resolve({ isFile: () => true })
      : Promise.reject(mockMissing('stat', path)),
  realpath: (path: string): Promise<string> =>
    mockFiles.has(path)
      ? Promise.resolve(path)
      : Promise.reject(mockMissing('realpath', path)),
  access: (): Promise<void> => Promise.resolve(),
  mkdtemp: (): Promise<string> => Promise.resolve('/tmp/git-validation-test'),
  rm: (): Promise<void> => Promise.resolve(),
}));

const mockPrewarm = jest.fn<Promise<void>, [{ force?: boolean }?]>();
let mockLoginPath = '/usr/bin';
jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getLinuxProbeEnv: (): Record<string, string> => ({ PATH: '/probe/bin' }),
  getLoginShellPath: (): string => mockLoginPath,
  prewarmLoginShellPath: (options?: { force?: boolean }): Promise<void> =>
    mockPrewarm(options),
}));

const mockPreferences = { gitExecutablePath: '' };
const mockWritePreferences = jest.fn(
  (patch: { gitExecutablePath?: string }): Promise<void> => {
    if (typeof patch.gitExecutablePath === 'string')
      mockPreferences.gitExecutablePath = patch.gitExecutablePath;
    return Promise.resolve();
  },
);
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<{ gitExecutablePath: string }> =>
    Promise.resolve({ ...mockPreferences }),
  writePreferencesFile: (patch: {
    gitExecutablePath?: string;
  }): Promise<void> => mockWritePreferences(patch),
}));

interface Gate {
  promise: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['worker.filesystem.read', 'core.workspace.read'],
};
const gitCaller: CanopyCallerDescriptor = {
  ...caller,
  grants: [WORKER_GIT_GRANTS.read],
};
const params: WorkerGitExecutableGetParams = { scope: {}, recheck: false };

const originalPlatform = process.platform;
const originalArch = process.arch;
const originalEnv = { ...process.env };
let whereGit: string[];
let probeGates: Map<string, Gate>;
let probes: string[];

function setPlatform(platform: NodeJS.Platform, arch: string): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
}

interface Loaded {
  lib: typeof GitExecutableModule;
  adapter: typeof AdapterModule;
  dispatch: typeof DispatchModule;
  ipc: typeof IpcModule;
  runtime: DesktopCanopyDispatcher;
}

let loaded: Loaded | undefined;

async function load(): Promise<Loaded> {
  await jest.isolateModulesAsync(async () => {
    const { createDesktopRuntime } = await import('../desktop-runtime');
    loaded = {
      lib: await import('../../lib/git-executable'),
      adapter: await import('../worker-git-adapter'),
      dispatch: await import('../worker-git-dispatch'),
      ipc: await import('../../ipc/git-executable'),
      runtime: createDesktopRuntime(),
    };
  });
  if (!loaded) throw new Error('The desktop runtime did not load');
  return loaded;
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 20; index++)
    await new Promise((resolve) => setImmediate(resolve));
};

// A cold transform cache takes longer than a test's timeout to compile the
// desktop runtime graph, so compile it once up front.
beforeAll(async () => {
  await jest.isolateModulesAsync(async () => {
    await import('../desktop-runtime');
    await import('../../ipc/git-executable');
  });
}, 60_000);

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...originalEnv };
  for (const name of [
    'CANOPY_GIT_EXECUTABLE',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'LOCALAPPDATA',
  ])
    delete process.env[name];
  mockPreferences.gitExecutablePath = '';
  mockFiles.clear();
  mockLoginPath = '/usr/bin';
  whereGit = [];
  probeGates = new Map();
  probes = [];
  mockPrewarm.mockImplementation(() => Promise.resolve());
  mockExecFile.mockImplementation((file, args, _options, callback) => {
    void (async (): Promise<void> => {
      if (file === 'where.exe') {
        if (args[0] === 'git' && whereGit.length > 0)
          callback(null, `${whereGit.join('\r\n')}\r\n`, '');
        else callback(new Error('INFO: Could not find files'), '', '');
        return;
      }
      if (file === '/usr/bin/xcode-select') {
        callback(new Error('no developer tools'), '', '');
        return;
      }
      if (args[0] === '--version') {
        probes.push(file);
        await probeGates.get(file)?.promise;
        if (mockFiles.get(file) === 'git')
          callback(null, 'git version 2.47.1\n', '');
        else callback(null, 'usage: not-git\n', '');
        return;
      }
      callback(null, '', '');
    })();
    return new ChildProcess();
  });
});

afterEach(async () => {
  await loaded?.runtime.shutdown();
  loaded = undefined;
});

afterAll(() => {
  setPlatform(originalPlatform, originalArch);
  process.env = originalEnv;
});

describe('worker.git.executable.get on the desktop dispatcher', () => {
  beforeEach(() => setPlatform('win32', 'x64'));

  it('answers a dispatcher call without saving or publishing anything', async () => {
    whereGit = ['C:\\Git\\git.exe'];
    mockFiles.set('C:\\Git\\git.exe', 'git');
    const { runtime, dispatch } = await load();

    const pure = await runtime.query('worker.git.executable.get', params, {
      caller: gitCaller,
    });
    expect(pure).toEqual({
      platform: 'win32',
      required: true,
      ready: true,
      version: 'git version 2.47.1',
      source: 'auto-detected',
      wingetAvailable: false,
      checkedAt: expect.any(String) as unknown,
      issue: null,
    });
    expect(mockWritePreferences).not.toHaveBeenCalled();
    expect(process.env.CANOPY_GIT_EXECUTABLE).toBeUndefined();

    const projected = await dispatch.getGitExecutableStatus(runtime, caller, {
      recheck: false,
    });
    expect(projected).toMatchObject({
      ready: true,
      path: 'C:\\Git\\git.exe',
      source: 'auto-detected',
    });
    expect(mockWritePreferences.mock.calls).toEqual([
      [{ gitExecutablePath: 'C:\\Git\\git.exe' }],
    ]);
    expect(process.env.CANOPY_GIT_EXECUTABLE).toBe('C:\\Git\\git.exe');
  });

  it('previews a broken saved preference as the live detection reports it, without clearing it', async () => {
    mockPreferences.gitExecutablePath = 'C:\\Old\\git.exe';
    process.env.CANOPY_GIT_EXECUTABLE = 'C:\\Old\\git.exe';
    whereGit = ['C:\\Git\\git.exe'];
    mockFiles.set('C:\\Git\\git.exe', 'git');
    const { runtime, adapter } = await load();

    const pure = await runtime.query('worker.git.executable.get', params, {
      caller: gitCaller,
    });
    expect(mockPreferences.gitExecutablePath).toBe('C:\\Old\\git.exe');
    expect(process.env.CANOPY_GIT_EXECUTABLE).toBe('C:\\Old\\git.exe');
    expect(mockWritePreferences).not.toHaveBeenCalled();

    const { canonicalResult, legacyResult } =
      await adapter.queryGitExecutableForLegacyIpc(
        runtime,
        { recheck: false },
        { caller: gitCaller },
      );
    expect({ ...pure, checkedAt: null }).toEqual({
      ...canonicalResult,
      checkedAt: null,
    });
    expect(mockWritePreferences.mock.calls).toEqual([
      [{ gitExecutablePath: '' }],
      [{ gitExecutablePath: 'C:\\Git\\git.exe' }],
    ]);
    // The canonical result is the captured status without its path or message.
    expect(canonicalResult).toEqual({
      platform: legacyResult.platform,
      required: legacyResult.required,
      ready: legacyResult.ready,
      version: legacyResult.version,
      source: legacyResult.source,
      wingetAvailable: legacyResult.wingetAvailable,
      checkedAt: legacyResult.checkedAt,
      issue: null,
    });
  });

  it('lets a pure call share a running projected probe, whose effects apply once', async () => {
    whereGit = ['C:\\Git\\git.exe'];
    mockFiles.set('C:\\Git\\git.exe', 'git');
    const held = gate();
    probeGates.set('C:\\Git\\git.exe', held);
    const { runtime, dispatch } = await load();

    const projected = dispatch.getGitExecutableStatus(runtime, caller, {
      recheck: false,
    });
    await flush();
    const pure = runtime.query('worker.git.executable.get', params, {
      caller: gitCaller,
    });
    await flush();
    held.open();
    const [legacy, canonical] = await Promise.all([projected, pure]);

    expect(probes).toEqual(['C:\\Git\\git.exe']);
    expect(mockWritePreferences).toHaveBeenCalledTimes(1);
    expect(canonical.checkedAt).toBe(legacy.checkedAt);
  });

  it('runs a forced pure call as its own preview while a projected probe runs', async () => {
    whereGit = ['C:\\Git\\git.exe'];
    mockFiles.set('C:\\Git\\git.exe', 'git');
    const held = gate();
    probeGates.set('C:\\Git\\git.exe', held);
    const { runtime, dispatch } = await load();

    const projected = dispatch.getGitExecutableStatus(runtime, caller, {
      recheck: false,
    });
    await flush();
    const pure = runtime.query(
      'worker.git.executable.get',
      { scope: {}, recheck: true },
      { caller: gitCaller },
    );
    await flush();
    held.open();
    await Promise.all([projected, pure]);

    expect(probes).toEqual(['C:\\Git\\git.exe', 'C:\\Git\\git.exe']);
    expect(mockWritePreferences).toHaveBeenCalledTimes(1);
  });

  it('never lets a live caller join a preview', async () => {
    whereGit = ['C:\\Git\\git.exe'];
    mockFiles.set('C:\\Git\\git.exe', 'git');
    const held = gate();
    probeGates.set('C:\\Git\\git.exe', held);
    const { runtime, lib } = await load();

    const pure = runtime.query('worker.git.executable.get', params, {
      caller: gitCaller,
    });
    await flush();
    const spawn = lib.getResolvedGitExecutableForSpawn();
    await flush();
    held.open();
    await pure;

    expect(await spawn).toBe('C:\\Git\\git.exe');
    expect(probes).toEqual(['C:\\Git\\git.exe', 'C:\\Git\\git.exe']);
    expect(mockWritePreferences).toHaveBeenCalledTimes(1);
    expect(process.env.CANOPY_GIT_EXECUTABLE).toBe('C:\\Git\\git.exe');
  });

  it('denies a caller without worker.git.read before detecting', async () => {
    const { runtime } = await load();

    await expect(
      runtime.query('worker.git.executable.get', params, { caller }),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it.each([
    { authorityId: 'remote-desktop' },
    { targetId: 'in_process_worker' },
  ])('refuses scope %o before detecting', async (scope) => {
    const { runtime } = await load();

    await expect(
      runtime.query(
        'worker.git.executable.get',
        { scope, recheck: false },
        { caller: gitCaller },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it.each([
    IPC_CHANNELS.gitExecutableStatus,
    IPC_CHANNELS.gitExecutableRedetect,
  ])('refuses an untracked %s sender before detecting', async (channel) => {
    const { ipc, runtime } = await load();
    ipc.registerGitExecutableHandlers(() => null, {
      dispatcher: runtime,
      resolveCaller: (): never => {
        throw canopyPermissionDeniedError('Untrusted desktop IPC sender.');
      },
    });
    const handler = mockHandlers.get(channel);
    if (!handler) throw new Error(`${channel} was not registered`);

    await expect(handler({ sender: { id: 9 } })).rejects.toThrow(
      'Untrusted desktop IPC sender.',
    );
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('lets a refused projection finish the probe it claimed, once, before rejecting', async () => {
    whereGit = ['C:\\Git\\git.exe'];
    mockFiles.set('C:\\Git\\git.exe', 'git');
    const held = gate();
    probeGates.set('C:\\Git\\git.exe', held);
    const { dispatch, lib } = await load();
    const refusing: AdapterModule.WorkerGitDispatcher = {
      query: (): Promise<never> => Promise.reject(new Error('refused')),
    };

    const settled: string[] = [];
    const projected = dispatch
      .getGitExecutableStatus(refusing, caller, { recheck: true })
      .catch((error: unknown) => {
        settled.push('projection');
        throw error;
      });
    const spawn = lib.getResolvedGitExecutableForSpawn().then((path) => {
      settled.push('spawn');
      return path;
    });
    await flush();
    expect(settled).toEqual([]);
    held.open();

    await expect(projected).rejects.toThrow('refused');
    expect(await spawn).toBe('C:\\Git\\git.exe');
    expect(probes).toEqual(['C:\\Git\\git.exe']);
    expect(mockWritePreferences).toHaveBeenCalledTimes(1);
  });

  it('dispatches only the local scope, granting only worker.git.read', async () => {
    const { adapter, dispatch } = await load();
    const seen: Array<{ params: unknown; caller: CanopyCallerDescriptor }> = [];
    const recorder: AdapterModule.WorkerGitDispatcher = {
      query: (
        _name: string,
        queried: unknown,
        options: CanopyQueryOptions,
      ): Promise<never> => {
        seen.push({ params: queried, caller: options.caller });
        return Promise.reject(new Error('recorded'));
      },
    };

    await expect(
      dispatch.getGitExecutableStatus(recorder, caller, { recheck: true }),
    ).rejects.toThrow('recorded');
    // The projection claims the local detection before dispatch, so a scope
    // the host would refuse must never reach it.
    expect(seen).toEqual([
      { params: { scope: {}, recheck: true }, caller: gitCaller },
    ]);
    expect(adapter.desktopWorkerGitExecutableHost.authorityId).toBe(
      'local-desktop',
    );
  });
});

describe('Linux x64 previews', () => {
  beforeEach(() => setPlatform('linux', 'x64'));

  it('never supersede or publish over a running live detection', async () => {
    mockLoginPath = '/usr/local/bin';
    mockFiles.set('/usr/local/bin/git', 'git');
    const held = gate();
    mockPrewarm.mockImplementationOnce(() => held.promise);
    const { runtime, dispatch } = await load();

    const projected = dispatch.getGitExecutableStatus(runtime, caller, {
      recheck: false,
    });
    await flush();
    // Forced on Linux, so it runs its own preview instead of joining.
    const pure = await runtime.query(
      'worker.git.executable.get',
      { scope: {}, recheck: true },
      { caller: gitCaller },
    );
    expect(pure).toMatchObject({ ready: true, source: 'login-path' });
    expect(process.env.CANOPY_GIT_EXECUTABLE).toBeUndefined();
    held.open();

    expect(await projected).toMatchObject({
      ready: true,
      path: '/usr/local/bin/git',
      source: 'login-path',
    });
    expect(process.env.CANOPY_GIT_EXECUTABLE).toBe('/usr/local/bin/git');
    expect(mockWritePreferences).not.toHaveBeenCalled();
  });

  it('report a broken explicit choice with its issue and keep it', async () => {
    mockPreferences.gitExecutablePath = '/opt/git/bin/git';
    mockFiles.set('/opt/git/bin/git', 'not-git');
    const { runtime } = await load();

    await expect(
      runtime.query('worker.git.executable.get', params, {
        caller: gitCaller,
      }),
    ).resolves.toMatchObject({
      ready: false,
      source: 'not-found',
      issue: 'selected-unusable',
    });
    expect(mockPreferences.gitExecutablePath).toBe('/opt/git/bin/git');
  });
});

// `candidate-unusable` needs a candidate that exists; missing paths alone are
// `not-found`. The legacy message stays the last failure either way.
describe('macOS and Windows discovery issues', () => {
  async function detect(): Promise<{
    issue: string | null;
    error: string | undefined;
  }> {
    const { runtime, adapter } = await load();
    const { canonicalResult, legacyResult } =
      await adapter.queryGitExecutableForLegacyIpc(
        runtime,
        { recheck: false },
        { caller: gitCaller },
      );
    expect(canonicalResult.ready).toBe(false);
    return { issue: canonicalResult.issue, error: legacyResult.error };
  }

  it('reports not-found on macOS when every candidate is missing', async () => {
    setPlatform('darwin', 'arm64');

    await expect(detect()).resolves.toEqual({
      issue: 'not-found',
      error: "ENOENT: no such file or directory, realpath '/usr/local/bin/git'",
    });
    expect(probes).toEqual([]);
  });

  it('reports candidate-unusable on macOS when a candidate exists but fails', async () => {
    setPlatform('darwin', 'arm64');
    mockFiles.set('/opt/homebrew/bin/git', 'not-git');

    // The missing last candidate still supplies the message.
    await expect(detect()).resolves.toEqual({
      issue: 'candidate-unusable',
      error: "ENOENT: no such file or directory, realpath '/usr/local/bin/git'",
    });
    expect(probes).toEqual(['/opt/homebrew/bin/git']);
  });

  it('reports not-found on Windows when every install folder is missing', async () => {
    setPlatform('win32', 'x64');
    process.env.ProgramFiles = 'C:\\Program Files';

    await expect(detect()).resolves.toEqual({
      issue: 'not-found',
      error: `Git executable does not exist: ${join('C:\\Program Files', 'Git', 'bin', 'git.exe')}`,
    });
    expect(probes).toEqual([]);
  });

  it('reports candidate-unusable on Windows when a where.exe result fails', async () => {
    setPlatform('win32', 'x64');
    process.env.ProgramFiles = 'C:\\Program Files';
    whereGit = ['C:\\Tools\\git.exe'];
    mockFiles.set('C:\\Tools\\git.exe', 'not-git');

    await expect(detect()).resolves.toEqual({
      issue: 'candidate-unusable',
      error: `Git executable does not exist: ${join('C:\\Program Files', 'Git', 'bin', 'git.exe')}`,
    });
    expect(probes).toEqual(['C:\\Tools\\git.exe']);
  });

  it('reports candidate-unusable when a saved macOS path exists but fails', async () => {
    setPlatform('darwin', 'arm64');
    mockPreferences.gitExecutablePath = '/custom/bin/git';
    mockFiles.set('/custom/bin/git', 'not-git');

    await expect(detect()).resolves.toEqual({
      issue: 'candidate-unusable',
      error: "ENOENT: no such file or directory, realpath '/usr/local/bin/git'",
    });
    expect(mockPreferences.gitExecutablePath).toBe('');
  });

  it('reports not-found when a saved macOS path no longer exists', async () => {
    setPlatform('darwin', 'arm64');
    mockPreferences.gitExecutablePath = '/custom/bin/git';

    await expect(detect()).resolves.toEqual({
      issue: 'not-found',
      error: "ENOENT: no such file or directory, realpath '/usr/local/bin/git'",
    });
    expect(probes).toEqual([]);
  });

  it('reports candidate-unusable when a Windows override exists but fails', async () => {
    setPlatform('win32', 'x64');
    process.env.CANOPY_GIT_EXECUTABLE = 'C:\\Tools\\git.exe';
    mockFiles.set('C:\\Tools\\git.exe', 'not-git');

    await expect(detect()).resolves.toEqual({
      issue: 'candidate-unusable',
      error: undefined,
    });
    expect(process.env.CANOPY_GIT_EXECUTABLE).toBeUndefined();
  });

  it('reports candidate-unusable on macOS for a candidate that cannot be spawned', async () => {
    setPlatform('darwin', 'arm64');
    mockLoginPath = '/opt/tools/bin';
    mockFiles.set('/opt/tools/bin/git', 'git');
    const spawnMissing = Object.assign(
      new Error('spawn /opt/tools/bin/git ENOENT'),
      { code: 'ENOENT', syscall: 'spawn /opt/tools/bin/git' },
    );
    mockExecFile.mockImplementation((file, _args, _options, callback) => {
      if (file === '/opt/tools/bin/git') callback(spawnMissing, '', '');
      else callback(new Error('no developer tools'), '', '');
      return new ChildProcess();
    });

    await expect(detect()).resolves.toEqual({
      issue: 'candidate-unusable',
      error: "ENOENT: no such file or directory, realpath '/usr/local/bin/git'",
    });
  });

  it('reports not-found on Windows with no candidates at all', async () => {
    setPlatform('win32', 'x64');

    await expect(detect()).resolves.toEqual({
      issue: 'not-found',
      error: undefined,
    });
  });
});
