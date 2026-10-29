import type * as CryptoModule from 'node:crypto';
import type * as WorkerThreads from 'node:worker_threads';
import type * as FsPromises from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
jest.mock('node:crypto', () => {
  const actual = jest.requireActual<typeof CryptoModule>('node:crypto');
  return { ...actual, createHash: jest.fn(actual.createHash) };
});
import {
  chmod,
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { c } from 'tar';
import {
  CursorRuntimeInstaller,
  type CursorRuntimeArtifact,
} from '../cursor/runtime-installer';
import { getCursorRuntimeTarget } from '@canopy/desktop-shared/lib/cursor-runtime-targets';
import { fingerprintCursorRuntime } from '@canopy/desktop-shared/node/cursor/runtime-fingerprint';
import { hashCursorRuntime } from '../cursor/runtime-hash';

let mockWorkerStarted: ((worker: WorkerThreads.Worker) => void) | undefined;
jest.mock('node:worker_threads', () => {
  const actual = jest.requireActual<typeof WorkerThreads>(
    'node:worker_threads',
  );
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        // Jest runs TypeScript sources, so the bundled worker file does not
        // exist here. Execute the worker's TypeScript entry through tsx with
        // the same worker data; production spawns the esbuild output.
        const [filename, options] = args;
        const bundled =
          typeof filename === 'string' &&
          filename.endsWith('cursor-runtime-hash-worker.js');
        super(
          bundled
            ? require.resolve('../cursor/runtime-hash-worker.ts')
            : filename,
          bundled ? { ...options, execArgv: ['--import', 'tsx'] } : options,
        );
        mockWorkerStarted?.(this);
      }
    },
  };
});

let root: string;
let archive: Buffer;
let artifact: CursorRuntimeArtifact;
const hash = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cursor-runtime-test-'));
  const fixture = join(root, 'fixture/dist-package');
  await mkdir(fixture, { recursive: true });
  await writeFile(join(fixture, 'cursor-agent'), '#!/bin/sh\necho pinned\n', {
    mode: 0o755,
  });
  await writeFile(join(fixture, 'node'), '#!/bin/sh\necho node\n', {
    mode: 0o755,
  });
  await c(
    { cwd: join(root, 'fixture'), file: join(root, 'fixture.tgz'), gzip: true },
    ['dist-package'],
  );
  archive = await readFile(join(root, 'fixture.tgz'));
  artifact = {
    version: 'test-pin',
    url: 'https://downloads.cursor.com/pinned.tgz',
    sha256: hash(archive),
    archiveBytes: archive.length,
    filesSha256: hash(
      JSON.stringify({
        'cursor-agent': hash('#!/bin/sh\necho pinned\n'),
        node: hash('#!/bin/sh\necho node\n'),
      }),
    ),
  };
});
afterEach(async () => {
  mockWorkerStarted = undefined;
  await rm(root, { recursive: true, force: true });
});
function installer(fetchArchive: typeof fetch): CursorRuntimeInstaller {
  const target = getCursorRuntimeTarget('darwin', 'arm64');
  if (!target) throw new Error('missing darwin-arm64 target');
  return new CursorRuntimeInstaller({
    root: join(root, 'managed'),
    artifact,
    target,
    fetchArchive,
  });
}
// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(30_000);

test('the CLI verifier computes the same digest as the desktop worker', async () => {
  // The CLI cannot load this worker bundle, so it hashes with a shared
  // implementation. Both must accept exactly the trees the pin accepts.
  const tree = join(root, 'fixture/dist-package');
  const executables = ['cursor-agent', 'node'];
  const desktop = await hashCursorRuntime(
    {
      path: tree,
      kind: 'directory',
      maxBytes: 800 * 1024 * 1024,
      maxEntries: 2_000,
      executables,
    },
    new AbortController().signal,
  );
  const shared = await fingerprintCursorRuntime(
    tree,
    executables,
    new AbortController().signal,
  );
  expect(shared).toBe(desktop);
  expect(shared).toBe(artifact.filesSha256);
});

test('status does not create directories or download; explicit installation is verified and reusable', async () => {
  const download = jest.fn(
    (): Promise<Response> =>
      Promise.resolve(new Response(new Uint8Array(archive))),
  );
  const runtime = installer(download);
  expect(await runtime.isInstalled()).toBe(false);
  expect(download).not.toHaveBeenCalled();
  expect(await readdir(root)).not.toContain('managed');
  const { command: binary } = await runtime.install(
    new AbortController().signal,
    () => {},
  );
  expect(binary).toBe(join(root, 'managed/test-pin/cursor-agent'));
  expect((await runtime.verify(new AbortController().signal)).command).toBe(
    binary,
  );
  await runtime.install(new AbortController().signal, () => {});
  expect(download).toHaveBeenCalledTimes(1);
});
test('rejects a changed archive before extraction and removes partial installation', async () => {
  const runtime = installer(
    (): Promise<Response> => Promise.resolve(new Response('wrong bytes')),
  );
  await expect(
    runtime.install(new AbortController().signal, () => {}),
  ).rejects.toThrow('verification');
  expect(await runtime.isInstalled()).toBe(false);
  expect(await readdir(join(root, 'managed'))).toEqual([]);
});
test.each(['extra.js', '__proto__'])(
  'detects changed executable bytes and extra runtime file %s instead of accepting a version label',
  async (extra) => {
    const runtime = installer(
      (): Promise<Response> =>
        Promise.resolve(new Response(new Uint8Array(archive))),
    );
    const { command: binary } = await runtime.install(
      new AbortController().signal,
      () => {},
    );
    await writeFile(binary, '#!/bin/sh\necho same-version-but-changed\n');
    await expect(runtime.verify(new AbortController().signal)).rejects.toThrow(
      'verification',
    );
    await writeFile(binary, '#!/bin/sh\necho pinned\n');
    await writeFile(join(root, 'managed/test-pin', extra), 'unexpected');
    await expect(runtime.verify(new AbortController().signal)).rejects.toThrow(
      'verification',
    );
  },
);
test('rejects unsafe redirect destinations before fetching them', async () => {
  const download = jest.fn(
    (): Promise<Response> =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'http://untrusted.invalid/archive' },
        }),
      ),
  );
  await expect(
    installer(download).install(new AbortController().signal, () => {}),
  ).rejects.toThrow('download');
  expect(download).toHaveBeenCalledTimes(1);
});
test('cancellation removes staging and leaves a reusable existing installation intact', async () => {
  const controller = new AbortController();
  const runtime = installer((): Promise<Response> => {
    controller.abort();
    return Promise.resolve(new Response(new Uint8Array(archive)));
  });
  await expect(runtime.install(controller.signal, () => {})).rejects.toThrow();
  expect(await runtime.isInstalled()).toBe(false);
  expect(await readdir(join(root, 'managed'))).toEqual([]);
});
test('rejects archive links even when download digest matches', async () => {
  const { symlink } = await import('node:fs/promises');
  await symlink('/tmp', join(root, 'fixture/dist-package/escape'));
  await c(
    { cwd: join(root, 'fixture'), file: join(root, 'linked.tgz'), gzip: true },
    ['dist-package'],
  );
  archive = await readFile(join(root, 'linked.tgz'));
  artifact.sha256 = hash(archive);
  artifact.archiveBytes = archive.length;
  await expect(
    installer(
      (): Promise<Response> =>
        Promise.resolve(new Response(new Uint8Array(archive))),
    ).install(new AbortController().signal, () => {}),
  ).rejects.toThrow('archive');
});

test('oversized downloads fail with no partial installation', async () => {
  artifact.archiveBytes = 1;
  await expect(
    installer(() =>
      Promise.resolve(new Response(new Uint8Array(archive))),
    ).install(new AbortController().signal, () => {}),
  ).rejects.toThrow('verification');
  expect(await readdir(join(root, 'managed'))).toEqual([]);
});
test('concurrent requests share a single verified installation', async () => {
  const download = jest.fn(() =>
    Promise.resolve(new Response(new Uint8Array(archive))),
  );
  const runtime = installer(download);
  const installed = await Promise.all([
    runtime.install(new AbortController().signal, () => {}),
    runtime.install(new AbortController().signal, () => {}),
  ]);
  expect(installed[0]).toBe(installed[1]);
  expect(download).toHaveBeenCalledTimes(1);
});
test('damaged runtimes are repaired on explicit reconnect', async () => {
  const download = jest.fn(() =>
    Promise.resolve(new Response(new Uint8Array(archive))),
  );
  const runtime = installer(download);
  const { command: binary } = await runtime.install(
    new AbortController().signal,
    () => {},
  );
  await writeFile(binary, 'damaged');
  await runtime.install(new AbortController().signal, () => {});
  expect(await readFile(binary, 'utf8')).toBe('#!/bin/sh\necho pinned\n');
  expect(download).toHaveBeenCalledTimes(2);
  expect(await readdir(join(root, 'managed'))).toEqual(['test-pin']);
});
test('private configuration disables updates and isolates global hooks without changing the parent environment', async () => {
  const { prepareCursorRuntimeEnvironment } =
    await import('@canopy/desktop-shared/node/cursor/runtime-environment');
  const original = {
    HOME: '/existing/user/home',
    CURSOR_CONFIG_DIR: '/existing/user/config',
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    NODE_OPTIONS: '--require unsafe',
    GH_TOKEN: 'ghp_secret',
    PATH: '/bin',
  };
  const env = await prepareCursorRuntimeEnvironment(
    join(root, 'private'),
    original,
  );
  expect(env.HOME).toBe(join(root, 'private/home'));
  expect(original.HOME).toBe('/existing/user/home');
  expect(env.PATH).toBe(original.PATH);
  expect(env.CURSOR_CONFIG_DIR).toBe(join(root, 'private/config'));
  expect(env.AGENT_CLI_CREDENTIAL_STORE).toBeUndefined();
  expect(env.NODE_OPTIONS).toBeUndefined();
  expect(env.GH_TOKEN).toBeUndefined();
  const file = join(root, 'private/config/cli-config.json');
  await writeFile(file, JSON.stringify({ channel: 'prod', model: 'auto' }));
  await prepareCursorRuntimeEnvironment(join(root, 'private'), original);
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
    channel: 'static',
    model: 'auto',
  });
  expect(await readdir(join(root, 'private/config'))).toEqual([
    'cli-config.json',
  ]);
  expect(original.CURSOR_CONFIG_DIR).toBe('/existing/user/config');
});

test('setup commands always disable background updates', async () => {
  const { runCursorRuntimeCommand } =
    await import('@canopy/desktop-shared/node/cursor/runtime-process');
  const binary = join(root, 'print-arguments');
  await writeFile(binary, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  const result = await runCursorRuntimeCommand(
    { command: binary, prefix: [] },
    ['--version'],
    process.env,
    new AbortController().signal,
  );
  expect(result).toEqual({
    code: 0,
    stdout: '--disable-auto-update\n--version\n',
  });
});
test('cancel drains the owned setup process before returning', async () => {
  const { runCursorRuntimeCommand } =
    await import('@canopy/desktop-shared/node/cursor/runtime-process');
  const binary = join(root, 'wait-for-cancel');
  await writeFile(
    binary,
    '#!/bin/sh\nprintf "%s\\n" "$$"\nsleep 60 &\nwait\n',
    { mode: 0o755 },
  );
  const controller = new AbortController();
  let pid = 0;
  await expect(
    runCursorRuntimeCommand(
      { command: binary, prefix: [] },
      [],
      process.env,
      controller.signal,
      (output) => {
        pid = Number(output.trim());
        controller.abort();
      },
    ),
  ).rejects.toThrow('stopped');
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
});
test('setup keeps only the tail of long-running output', async () => {
  const { runCursorRuntimeCommand } =
    await import('@canopy/desktop-shared/node/cursor/runtime-process');
  const binary = join(root, 'too-much-output');
  await writeFile(
    binary,
    "#!/bin/sh\nhead -c 40000 /dev/zero | tr '\\0' a\nprintf 'END\\n'\n",
    { mode: 0o755 },
  );
  const result = await runCursorRuntimeCommand(
    { command: binary, prefix: [] },
    [],
    process.env,
    new AbortController().signal,
  );
  expect(result.code).toBe(0);
  expect(result.stdout.length).toBeLessThanOrEqual(32 * 1024);
  expect(result.stdout.endsWith('END\n')).toBe(true);
});

test('missing runtime gives reconnect guidance without downloading or exposing paths', async () => {
  const download = jest.fn(() =>
    Promise.resolve(new Response(new Uint8Array(archive))),
  );
  const runtime = installer(download);
  await expect(runtime.verify(new AbortController().signal)).rejects.toThrow(
    'Cursor runtime verification failed. Reconnect Cursor to restore it.',
  );
  expect(download).not.toHaveBeenCalled();
});

test.each(['cursor-agent', 'node'])(
  'explicit reconnect repairs lost executable permission on %s',
  async (name) => {
    const download = jest.fn(() =>
      Promise.resolve(new Response(new Uint8Array(archive))),
    );
    const runtime = installer(download);
    await runtime.install(new AbortController().signal, () => {});
    const file = join(runtime.directory, name);
    await chmod(file, 0o600);
    await expect(runtime.verify(new AbortController().signal)).rejects.toThrow(
      'Reconnect Cursor',
    );
    if (name === 'cursor-agent')
      expect(await runtime.isInstalled()).toBe(false);
    await runtime.install(new AbortController().signal, () => {});
    await expect(access(file, constants.X_OK)).resolves.toBeUndefined();
    expect((await runtime.verify(new AbortController().signal)).command).toBe(
      join(runtime.directory, 'cursor-agent'),
    );
    expect(download).toHaveBeenCalledTimes(2);
  },
);

test('integrity verification does not hash runtime bytes on the calling thread', async () => {
  const runtime = installer(() =>
    Promise.resolve(new Response(new Uint8Array(archive))),
  );
  const { command: binary } = await runtime.install(
    new AbortController().signal,
    () => {},
  );
  jest.mocked(createHash).mockClear();
  expect((await runtime.verify(new AbortController().signal)).command).toBe(
    binary,
  );
  expect(createHash).not.toHaveBeenCalled();
});

test('cancelling an active verification drains its worker before returning', async () => {
  const runtime = installer(() =>
    Promise.resolve(new Response(new Uint8Array(archive))),
  );
  await runtime.install(new AbortController().signal, () => {});
  const controller = new AbortController();
  let worker: WorkerThreads.Worker | undefined;
  mockWorkerStarted = (started): void => {
    worker = started;
    started.once('online', () => controller.abort());
  };
  await expect(runtime.verify(controller.signal)).rejects.toThrow();
  expect(worker?.threadId).toBe(-1);
  mockWorkerStarted = undefined;
  expect(
    (await runtime.verify(new AbortController().signal)).command,
  ).toContain('cursor-agent');
});

test('cancelling queued verification never starts another worker', async () => {
  const runtime = installer(() =>
    Promise.resolve(new Response(new Uint8Array(archive))),
  );
  await runtime.install(new AbortController().signal, () => {});
  let count = 0;
  const controller = new AbortController();
  mockWorkerStarted = (): void => {
    count++;
  };
  const first = runtime.verify(new AbortController().signal);
  const queued = runtime.verify(controller.signal);
  controller.abort();
  await expect(queued).rejects.toThrow();
  await first;
  mockWorkerStarted = undefined;
  expect(count).toBe(1);
});

test('user-global Cursor and Claude hooks are absent from the child discovery namespace', async () => {
  const { prepareCursorRuntimeEnvironment } =
    await import('@canopy/desktop-shared/node/cursor/runtime-environment');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const userHome = join(root, 'user-home');
  await mkdir(join(userHome, '.cursor'), { recursive: true });
  await mkdir(join(userHome, '.claude'), { recursive: true });
  const marker = join(root, 'ambient-hook-ran');
  const hook = join(root, 'hook.cjs');
  await writeFile(
    hook,
    `require('fs').appendFileSync(${JSON.stringify(marker)}, 'ran\\n')`,
  );
  await writeFile(
    join(userHome, '.cursor/hooks.json'),
    JSON.stringify({ hook }),
  );
  await writeFile(
    join(userHome, '.claude/settings.json'),
    JSON.stringify({ hook }),
  );
  const discover = `
    const fs = require('fs'), path = require('path'), os = require('os');
    for (const file of ['.cursor/hooks.json', '.claude/settings.json']) {
      const location = path.join(os.homedir(), file);
      if (fs.existsSync(location)) require('child_process').execFileSync(process.execPath, [JSON.parse(fs.readFileSync(location, 'utf8')).hook]);
    }
  `;
  const original = { ...process.env, HOME: userHome };
  await run(process.execPath, ['-e', discover], { env: original });
  expect(await readFile(marker, 'utf8')).toBe('ran\nran\n');
  await rm(marker);
  const env = await prepareCursorRuntimeEnvironment(
    join(root, 'private'),
    original,
  );
  await run(process.execPath, ['-e', discover], { env });
  await expect(access(marker)).rejects.toThrow();
  expect(
    await readFile(join(userHome, '.cursor/hooks.json'), 'utf8'),
  ).toContain(hook);
});

test('system-wide hooks stop startup rather than being silently bypassed', async () => {
  const { prepareCursorRuntimeEnvironment } =
    await import('@canopy/desktop-shared/node/cursor/runtime-environment');
  const fs = jest.requireActual<typeof FsPromises>('node:fs/promises');
  const entry = await fs.lstat(root);
  const stat = jest.spyOn(fs, 'lstat').mockResolvedValueOnce(entry);
  try {
    await expect(
      prepareCursorRuntimeEnvironment(join(root, 'private'), process.env),
    ).rejects.toThrow('system-wide Cursor hooks');
    expect(stat.mock.calls[0][0]).toMatch(
      /Cursor[\\/]hooks.json|cursor[\\/]hooks.json/,
    );
  } finally {
    stat.mockRestore();
  }
});

test('a symlinked private cli-config.json is replaced instead of merged', async () => {
  const { prepareCursorRuntimeEnvironment } =
    await import('@canopy/desktop-shared/node/cursor/runtime-environment');
  const { symlink, lstat: lstatEntry } = await import('node:fs/promises');
  const privateRoot = join(root, 'private');
  await mkdir(join(privateRoot, 'config'), { recursive: true, mode: 0o700 });
  const outside = join(root, 'outside-config.json');
  await writeFile(outside, '{"channel":"prod","model":"external-marker"}');
  const file = join(privateRoot, 'config/cli-config.json');
  await symlink(outside, file);
  await prepareCursorRuntimeEnvironment(privateRoot, {
    PATH: process.env.PATH,
  });
  expect((await lstatEntry(file)).isSymbolicLink()).toBe(false);
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
    channel: 'static',
  });
  expect(await readFile(file, 'utf8')).not.toContain('external-marker');
  expect(await readFile(outside, 'utf8')).toContain('external-marker');
});

test('private HOME cannot redirect global discovery through an existing symlink', async () => {
  const { prepareCursorRuntimeEnvironment } =
    await import('@canopy/desktop-shared/node/cursor/runtime-environment');
  const { symlink } = await import('node:fs/promises');
  const target = join(root, 'user-home');
  await mkdir(target);
  await mkdir(join(root, 'private'));
  await symlink(target, join(root, 'private/home'));
  await expect(
    prepareCursorRuntimeEnvironment(join(root, 'private'), process.env),
  ).rejects.toThrow('private environment');
});

test.each([
  '',
  'config',
  'compile-cache',
  'data',
  'home/.config',
  'home/.local',
  'home/.local/share',
  'home/.cache',
])(
  'private runtime rejects a symlink at %s before using external state',
  async (relative) => {
    const { prepareCursorRuntimeEnvironment } =
      await import('@canopy/desktop-shared/node/cursor/runtime-environment');
    const { symlink } = await import('node:fs/promises');
    const privateRoot = join(root, 'private');
    const target = join(root, 'outside');
    await mkdir(target);
    const original = '{"channel":"prod","model":"external-marker"}';
    await writeFile(join(target, 'cli-config.json'), original);
    const redirect = join(privateRoot, relative);
    await mkdir(dirname(redirect), { recursive: true });
    await symlink(target, redirect);
    await expect(
      prepareCursorRuntimeEnvironment(privateRoot, {
        PATH: process.env.PATH,
      }).then(() => undefined),
    ).rejects.toThrow('private environment');
    expect(await readFile(join(target, 'cli-config.json'), 'utf8')).toBe(
      original,
    );
    expect(await readdir(target)).toEqual(['cli-config.json']);
  },
);

test.each(['global-file', 'key-value-overrides'])(
  'private runtime removes inherited Git configuration from %s',
  async (kind) => {
    const { prepareCursorRuntimeEnvironment } =
      await import('@canopy/desktop-shared/node/cursor/runtime-environment');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const config = join(root, 'external.gitconfig');
    const hookPath = join(root, 'external-hooks');
    await writeFile(config, `[core]\n\thooksPath = ${hookPath}\n`);
    const overrides: NodeJS.ProcessEnv =
      kind === 'global-file'
        ? { GIT_CONFIG_GLOBAL: config }
        : {
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'core.hooksPath',
            GIT_CONFIG_VALUE_0: hookPath,
          };
    const original = { ...process.env, ...overrides };
    const before = await run('git', ['config', '--get', 'core.hooksPath'], {
      cwd: root,
      env: original,
    });
    expect(before.stdout.trim()).toBe(hookPath);
    const env = await prepareCursorRuntimeEnvironment(
      join(root, 'private'),
      original,
    );
    for (const key of Object.keys(overrides)) expect(env[key]).toBeUndefined();
    await expect(
      run('git', ['config', '--get', 'core.hooksPath'], { cwd: root, env }),
    ).rejects.toMatchObject({ code: 1 });
    expect(original).toMatchObject(overrides);
  },
);

test('cancelling during extraction stops the unpack and leaves no orphaned stage', async () => {
  // A large enough archive that extraction is still in progress when the
  // abort fires from the 'installing' progress callback.
  const fixture = join(root, 'large/dist-package');
  await mkdir(fixture, { recursive: true });
  const manifest: Record<string, string> = {};
  for (let index = 0; index < 1_500; index++) {
    const name = `file-${index}.txt`;
    const content = `${index}\n`.padEnd(2_048, 'x');
    await writeFile(join(fixture, name), content);
    manifest[name] = hash(content);
  }
  await c(
    { cwd: join(root, 'large'), file: join(root, 'large.tgz'), gzip: true },
    ['dist-package'],
  );
  const large = await readFile(join(root, 'large.tgz'));
  const darwinTarget = getCursorRuntimeTarget('darwin', 'arm64');
  if (!darwinTarget) throw new Error('missing darwin-arm64 target');
  const runtime = new CursorRuntimeInstaller({
    root: join(root, 'managed'),
    target: darwinTarget,
    artifact: {
      version: 'large-pin',
      url: 'https://downloads.cursor.com/large.tgz',
      sha256: hash(large),
      archiveBytes: large.length,
      filesSha256: hash(JSON.stringify(manifest)),
    },
    fetchArchive: (): Promise<Response> =>
      Promise.resolve(new Response(new Uint8Array(large))),
  });
  const controller = new AbortController();
  await expect(
    runtime.install(controller.signal, (phase) => {
      if (phase === 'installing') setTimeout(() => controller.abort(), 10);
    }),
  ).rejects.toThrow();
  expect(controller.signal.aborted).toBe(true);
  expect(await readdir(join(root, 'managed'))).toEqual([]);
}, 120_000);

test('installs a Windows zip package and launches node.exe with index.js', async () => {
  const { buildZip } =
    await import('@canopy/desktop-shared/__tests__/helpers/zip-fixture');
  const { getCursorRuntimeTarget } =
    await import('@canopy/desktop-shared/lib/cursor-runtime-targets');
  const target = getCursorRuntimeTarget('win32', 'x64');
  if (!target) throw new Error('missing win32-x64 target');
  const zip = buildZip([
    { name: 'dist-package/node.exe', content: 'MZnode' },
    { name: 'dist-package/index.js', content: 'console.log(1)\n' },
  ]);
  const runtime = new CursorRuntimeInstaller({
    root: join(root, 'managed'),
    target,
    artifact: {
      version: 'test-pin',
      url: 'https://downloads.cursor.com/pinned.zip',
      sha256: hash(zip),
      archiveBytes: zip.length,
      filesSha256: hash(
        JSON.stringify({
          'index.js': hash('console.log(1)\n'),
          'node.exe': hash('MZnode'),
        }),
      ),
    },
    fetchArchive: (): Promise<Response> =>
      Promise.resolve(new Response(new Uint8Array(zip))),
  });
  const launch = await runtime.install(new AbortController().signal, () => {});
  // Windows ships no cursor-agent binary, so the launcher is the interpreter
  // plus its script rather than a single executable path.
  expect(launch.command).toBe(join(root, 'managed/test-pin/node.exe'));
  expect(launch.prefix).toEqual([join(root, 'managed/test-pin/index.js')]);
  expect(await runtime.isInstalled()).toBe(true);
  expect(await runtime.verify(new AbortController().signal)).toEqual(launch);
});

test('a launch prefix runs before the update flag so Windows reaches index.js', async () => {
  const { runCursorRuntimeCommand } =
    await import('@canopy/desktop-shared/node/cursor/runtime-process');
  const interpreter = join(root, 'print-arguments');
  await writeFile(interpreter, '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
    mode: 0o755,
  });
  const result = await runCursorRuntimeCommand(
    { command: interpreter, prefix: [join(root, 'index.js')] },
    ['--version'],
    process.env,
    new AbortController().signal,
  );
  expect(result.stdout).toBe(
    `${join(root, 'index.js')}\n--disable-auto-update\n--version\n`,
  );
});

test('isolates the Windows home variables the vendor CLI actually reads', async () => {
  const { prepareCursorRuntimeEnvironment } =
    await import('@canopy/desktop-shared/node/cursor/runtime-environment');
  const env = await prepareCursorRuntimeEnvironment(
    join(root, 'win-private'),
    {
      USERPROFILE: 'C:\\Users\\real',
      APPDATA: 'C:\\Users\\real\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\real\\AppData\\Local',
      PATH: 'C:\\Windows',
    },
    'win32',
  );
  const home = join(root, 'win-private/home');
  // Windows resolves the home directory through USERPROFILE/APPDATA, not HOME,
  // so setting only HOME would leave the vendor CLI reading the real profile.
  expect(env.USERPROFILE).toBe(home);
  expect(env.APPDATA).toBe(join(home, 'AppData/Roaming'));
  expect(env.LOCALAPPDATA).toBe(join(home, 'AppData/Local'));
  expect(env.PATH).toBe('C:\\Windows');
});

test('leaves Windows-only variables alone on POSIX hosts', async () => {
  const { prepareCursorRuntimeEnvironment } =
    await import('@canopy/desktop-shared/node/cursor/runtime-environment');
  const env = await prepareCursorRuntimeEnvironment(
    join(root, 'posix-private'),
    { HOME: '/real/home', USERPROFILE: '/should/not/matter' },
    // Deliberately not 'darwin': that branch realpaths the host's
    // ~/Library/Keychains, which does not exist on a Linux CI runner.
    'linux',
  );
  expect(env.HOME).toBe(join(root, 'posix-private/home'));
  expect(env.USERPROFILE).toBe('/should/not/matter');
});

test('strips blocked environment variables regardless of case for Windows', async () => {
  const { prepareCursorRuntimeEnvironment } =
    await import('@canopy/desktop-shared/node/cursor/runtime-environment');
  // Windows environment names are case-insensitive and CreateProcess resolves
  // them that way, so a lowercase name would otherwise reach the child.
  const env = await prepareCursorRuntimeEnvironment(
    join(root, 'case-private'),
    {
      node_options: '--require unsafe',
      gh_token: 'ghp_secret',
      GitHub_Token: 'ghp_other',
      git_config_global: '/tmp/evil',
      cursor_api_key: 'secret',
      PATH: 'C:\\Windows',
    },
    'win32',
  );
  expect(env.node_options).toBeUndefined();
  expect(env.gh_token).toBeUndefined();
  expect(env.GitHub_Token).toBeUndefined();
  expect(env.git_config_global).toBeUndefined();
  expect(env.cursor_api_key).toBeUndefined();
  expect(env.PATH).toBe('C:\\Windows');
});
