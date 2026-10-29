import { PassThrough } from 'node:stream';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  NativeDelegationFiles,
  delegationRelativePath,
  validDelegationPath,
  type DelegationHostOperatingSystem,
  type NativeAssetFileSnapshot,
} from '../file-access';

describe('delegation path validation', () => {
  it('rejects Win32 name aliases only on Windows', () => {
    for (const alias of [
      '.env ',
      '.git.',
      'src/.ssh./id',
      'ENVRC~1',
      'src/PROGRA~1/x.ts',
      'NUL',
      'con.txt',
      'src/COM1.log',
      'lpt9',
    ]) {
      expect(validDelegationPath(alias, false, 'win32')).toBe(false);
      // On POSIX these are ordinary distinct names; only the .env prefix rule applies.
      expect(validDelegationPath(alias, false, 'darwin')).toBe(
        !alias.startsWith('.env'),
      );
    }
    // Only COM1-9 and LPT1-9 are reserved; COM0 and LPT0 are ordinary names.
    for (const name of [
      'src/index.ts',
      'console.ts',
      'nullable.ts',
      'a.b/c',
      'COM0',
      'lpt0.txt',
    ])
      expect(validDelegationPath(name, false, 'win32')).toBe(true);
  });

  it('normalizes relative paths to / on every platform', () => {
    expect(
      delegationRelativePath('C:\\repo', 'C:\\repo\\src\\a.ts', path.win32),
    ).toBe('src/a.ts');
    expect(delegationRelativePath('/repo', '/repo/src/a.ts', path.posix)).toBe(
      'src/a.ts',
    );
    expect(
      validDelegationPath(
        delegationRelativePath('C:\\repo', 'C:\\repo\\src\\.env', path.win32),
        false,
        'win32',
      ),
    ).toBe(false);
  });
});

describe('original asset identity precision', () => {
  /** Opens a scripted helper that answers one asset read with `identity`. */
  async function readIdentity(
    identity: string,
    hostOs: DelegationHostOperatingSystem | undefined,
  ): Promise<Awaited<ReturnType<NativeDelegationFiles['readAsset']>>> {
    const stdout = new PassThrough();
    let exit: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    const response = Buffer.concat([
      Buffer.from(`1\t${identity}\n`),
      Buffer.from([0xa3]),
    ]);
    const opening = NativeDelegationFiles.open(
      {
        stdin: {
          write: () => {
            stdout.write(
              Buffer.concat([Buffer.from(`OK ${response.length}\n`), response]),
            );
            return true;
          },
          end: exit,
        },
        stdout,
        exited,
        terminate: exit,
      },
      new AbortController().signal,
      {},
      hostOs,
    );
    stdout.write('READY\n');
    const access = await opening;
    try {
      return await access.readAsset('image.png', 0);
    } finally {
      await access.close();
    }
  }

  it.each<{
    platform: DelegationHostOperatingSystem;
    identity: string;
    snapshot: NativeAssetFileSnapshot;
  }>([
    {
      platform: 'linux',
      identity:
        '9007199254740993:18014398509481985:1:1700000000:123456789:1700000000:123456790',
      snapshot: {
        device: '9007199254740993',
        inode: '18014398509481985',
        size: '1',
        modifiedNs: '1700000000123456789',
        changedNs: '1700000000123456790',
      },
    },
    {
      platform: 'linux',
      identity: '1:2:1:-1:999999999:0:1',
      snapshot: {
        device: '1',
        inode: '2',
        size: '1',
        modifiedNs: '-1',
        changedNs: '1',
      },
    },
    {
      platform: 'win32',
      identity: '1:4194304:1:1:133444736001234567:133444736001234568',
      snapshot: {
        device: '1',
        inode: '18014398509481985',
        size: '1',
        modifiedNs: '1700000000123456700',
        changedNs: '1700000000123456800',
      },
    },
  ])(
    'preserves the exact $platform identity $identity',
    async ({ platform, identity, snapshot }): Promise<void> => {
      const asset = await readIdentity(identity, platform);
      expect(asset.snapshot).toEqual(snapshot);
      expect(asset.bytes).toEqual(Buffer.from([0xa3]));
    },
  );

  it('fails closed when the launcher supplies no host platform', async () => {
    await expect(
      readIdentity('1:2:1:-1:999999999:0:1', undefined),
    ).rejects.toThrow('host platform');
  });
});

describe('original asset path colons', () => {
  /** Reads `relativePath` through a scripted helper; returns the requests it saw. */
  async function readAssetPath(
    relativePath: string,
    hostOs: DelegationHostOperatingSystem | undefined,
  ): Promise<{ requests: string[]; read: Promise<Buffer> }> {
    const stdout = new PassThrough();
    const requests: string[] = [];
    let exit: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    const identity =
      hostOs === 'win32' ? '1:2:3:1:4:5' : '1:2:1:1700000000:1:1700000000:2';
    const response = Buffer.concat([
      Buffer.from(`1\t${identity}\n`),
      Buffer.from([0xa3]),
    ]);
    const opening = NativeDelegationFiles.open(
      {
        stdin: {
          write: (chunk: string | Uint8Array) => {
            requests.push(String(chunk));
            stdout.write(
              Buffer.concat([Buffer.from(`OK ${response.length}\n`), response]),
            );
            return true;
          },
          end: exit,
        },
        stdout,
        exited,
        terminate: exit,
      },
      new AbortController().signal,
      {},
      hostOs,
    );
    stdout.write('READY\n');
    const access = await opening;
    const read = access
      .readAsset(relativePath, 0)
      .then((asset) => asset.bytes)
      .finally(() => access.close());
    return { requests, read };
  }

  it.each<DelegationHostOperatingSystem>(['darwin', 'linux'])(
    'reads %s names with a colon in the file or a directory',
    async (hostOs): Promise<void> => {
      for (const relativePath of [
        'reports/notes:2026.txt',
        'notes:2026/report.txt',
      ]) {
        const { requests, read } = await readAssetPath(relativePath, hostOs);
        await expect(read).resolves.toEqual(Buffer.from([0xa3]));
        expect(requests).toEqual([`A\t${relativePath}\t0\n`]);
      }
    },
  );

  it.each<DelegationHostOperatingSystem | undefined>(['win32', undefined])(
    'refuses drive and alternate stream names on host %s',
    async (hostOs): Promise<void> => {
      for (const relativePath of [
        'C:/secret.txt',
        'C:secret.txt',
        'reports/notes.txt:hidden',
        'reports:hidden/notes.txt',
        'notes.txt::$DATA',
      ]) {
        const { requests, read } = await readAssetPath(relativePath, hostOs);
        await expect(read).rejects.toThrow(
          'Invalid original asset range or path.',
        );
        expect(requests).toEqual([]);
      }
    },
  );
});

describe('native read-only delegation file boundary', () => {
  beforeAll(async () => {
    await promisify(execFile)(
      process.execPath,
      ['scripts/build-delegation-file-broker.mjs', '--host'],
      { timeout: 60_000, maxBuffer: 1_048_576 },
    );
  }, 65_000);
  it('still terminates and waits for the helper when closing its pipe throws', async () => {
    const stdout = new PassThrough();
    let exit: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    const terminate = jest.fn(() => exit());
    const opening = NativeDelegationFiles.open(
      {
        stdin: {
          write: () => true,
          end: () => {
            throw new Error('Pipe already disconnected');
          },
        },
        stdout,
        exited,
        terminate,
      },
      new AbortController().signal,
    );
    stdout.write('READY\n');
    const access = await opening;
    await expect(access.close()).resolves.toBeUndefined();
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  let temporary: string;
  let root: string;
  let outside: string;
  let processCwd: string;
  const handles: NativeDelegationFiles[] = [];

  async function open(
    signal = new AbortController().signal,
    fileBytes?: number,
    assetMode = false,
  ): Promise<NativeDelegationFiles> {
    const binary = path.join(
      process.cwd(),
      '.cache/bin',
      `${process.platform}-${process.arch}`,
      process.platform === 'win32'
        ? 'canopy-file-broker.exe'
        : 'canopy-file-broker',
    );
    // A separate working directory makes any name the helper resolves
    // against its cwd, instead of its pinned root, observable.
    const child = spawn(
      binary,
      assetMode
        ? [root, '--asset-readonly']
        : fileBytes === undefined
          ? [root]
          : [root, String(fileBytes)],
      {
        cwd: processCwd,
        env:
          process.platform === 'win32'
            ? { SystemRoot: process.env.SystemRoot }
            : {},
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    child.stderr.resume();
    child.stdin.on('error', () => undefined);
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => resolve());
    });
    const access = await NativeDelegationFiles.open(
      {
        stdin: child.stdin,
        stdout: child.stdout,
        exited,
        terminate: () => {
          child.kill();
        },
      },
      signal,
      fileBytes === undefined ? {} : { fileBytes },
      process.platform === 'win32' ? 'win32' : 'darwin',
    );
    handles.push(access);
    return access;
  }

  it('reads binary chunks above delegation limits without exposing writes', async () => {
    const bytes = Buffer.alloc(33_554_432 + 17, 0xa3);
    await fs.writeFile(path.join(root, 'binary.bin'), bytes);
    const access = await open(new AbortController().signal, 197_632, true);
    const first = await access.readAsset('binary.bin', 0);
    const snapshot = await fs.lstat(path.join(root, 'binary.bin'), {
      bigint: true,
    });
    expect(first.snapshot).toEqual({
      device: snapshot.dev.toString(),
      inode: snapshot.ino.toString(),
      size: snapshot.size.toString(),
      modifiedNs: snapshot.mtimeNs.toString(),
      changedNs: snapshot.ctimeNs.toString(),
    });
    const last = await access.readAsset('binary.bin', bytes.length - 17);
    expect(first.size).toBe(bytes.length);
    expect(first.bytes).toEqual(bytes.subarray(0, 196_608));
    expect(last.version).toBe(first.version);
    expect(last.bytes).toEqual(bytes.subarray(bytes.length - 17));
    await expect(access.write('new.txt', null, 'write')).rejects.toThrow();
    await expect(access.read('binary.bin')).rejects.toThrow();
    const handle = await fs.open(path.join(root, 'too-large.bin'), 'w');
    await handle.truncate(104_857_601);
    await handle.close();
    await expect(access.readAsset('too-large.bin', 0)).rejects.toThrow();
    await expect(
      access.readAsset('binary.bin', bytes.length + 1),
    ).rejects.toThrow();
    await fs.writeFile(path.join(root, 'binary.bin'), Buffer.alloc(17, 0xb4));
    expect((await access.readAsset('binary.bin', 0)).version).not.toBe(
      first.version,
    );
  });

  it('pins the asset root and rejects ancestor links and revoked sessions', async () => {
    await fs.writeFile(
      path.join(root, 'src/binary.bin'),
      Buffer.from([0, 1, 2]),
    );
    const controller = new AbortController();
    const access = await open(controller.signal, 197_632, true);
    const first = await access.readAsset('src/binary.bin', 0);
    await fs.rename(root, `${root}-original`);
    await fs.symlink(outside, root, 'junction');
    const pinned = await access.readAsset('src/binary.bin', 0);
    expect(pinned.bytes).toEqual(Buffer.from([0, 1, 2]));
    expect(pinned.version).toBe(first.version);
    expect(pinned.snapshot).toEqual(first.snapshot);
    await fs.rename(
      path.join(`${root}-original`, 'src'),
      path.join(`${root}-original`, 'old-src'),
    );
    await fs.symlink(outside, path.join(`${root}-original`, 'src'), 'junction');
    await expect(access.readAsset('src/secret', 0)).rejects.toThrow();
    for (const path of [
      '../secret',
      '/secret',
      'src/../secret',
      'src\\secret',
    ]) {
      await expect(access.readAsset(path, 0)).rejects.toThrow();
    }
    controller.abort();
    await expect(access.readAsset('old-src/binary.bin', 0)).rejects.toThrow();
    await access.close();
    await fs.rm(root);
    await fs.rename(`${root}-original`, root);
  });

  // Windows names cannot contain ':', so only POSIX hosts can exercise this.
  (process.platform === 'win32' ? it.skip : it)(
    'reads POSIX asset names with a colon in the file or a directory',
    async () => {
      await fs.mkdir(path.join(root, 'reports'), { recursive: true });
      await fs.mkdir(path.join(root, 'notes:2026'), { recursive: true });
      await fs.writeFile(
        path.join(root, 'reports/notes:2026.txt'),
        Buffer.from([4, 5, 6]),
      );
      await fs.writeFile(
        path.join(root, 'notes:2026/report.txt'),
        Buffer.from([7, 8]),
      );
      const access = await open(new AbortController().signal, 197_632, true);
      expect(
        (await access.readAsset('reports/notes:2026.txt', 0)).bytes,
      ).toEqual(Buffer.from([4, 5, 6]));
      expect(
        (await access.readAsset('notes:2026/report.txt', 0)).bytes,
      ).toEqual(Buffer.from([7, 8]));
      await expect(access.readAsset('../notes:2026.txt', 0)).rejects.toThrow();
    },
  );

  it('writes only expected content and rejects links, hard links and stale edits', async () => {
    const access = await open();
    const original = await fs.stat(path.join(root, 'src/source.ts'));
    const before = await access.read('src/source.ts');
    await access.write('src/source.ts', before, 'child edit');
    const replaced = await fs.stat(path.join(root, 'src/source.ts'));
    if (process.platform !== 'win32')
      expect(replaced.ino).not.toBe(original.ino);
    expect(await access.read('src/source.ts')).toBe('child edit');
    await expect(
      access.write('src/source.ts', before, 'stale edit'),
    ).rejects.toThrow();
    await access.write('created.txt', null, 'new file');
    await expect(
      access.write('created.txt', null, 'overwrite'),
    ).rejects.toThrow();
    await fs.symlink(path.join(outside, 'secret'), path.join(root, 'link'));
    await expect(
      access.write('link', 'PRIVATE_CANARY', 'bad'),
    ).rejects.toThrow();
    await fs.link(path.join(outside, 'secret'), path.join(root, 'hard'));
    await expect(
      access.write('hard', 'PRIVATE_CANARY', 'bad'),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(outside, 'secret'), 'utf8')).toBe(
      'PRIVATE_CANARY',
    );
    await access.write('created.txt', 'new file', null);
    await expect(fs.stat(path.join(root, 'created.txt'))).rejects.toThrow();
  });

  it('reads and writes files up to the bound the session was started with', async () => {
    const large = `${'line of source\n'.repeat(70_000)}`;
    await fs.writeFile(path.join(root, 'src/large.ts'), large);
    const bounded = await open();
    await expect(bounded.read('src/large.ts')).rejects.toThrow();
    const raised = await open(undefined, 4 * 1024 * 1024);
    expect(await raised.read('src/large.ts')).toBe(large);
    await raised.write('src/large.ts', large, `${large}// child\n`);
    expect(await fs.readFile(path.join(root, 'src/large.ts'), 'utf8')).toBe(
      `${large}// child\n`,
    );
    await expect(
      raised.write('src/large.ts', large, 'stale edit'),
    ).rejects.toThrow();
  });

  it('refuses a file bound the native helper does not accept', async () => {
    for (const fileBytes of [0, -1, 1.5, 33_554_433])
      await expect(
        NativeDelegationFiles.open(
          {
            stdin: { write: () => true, end: () => undefined },
            stdout: new PassThrough(),
            exited: new Promise<void>(() => undefined),
            terminate: () => undefined,
          },
          new AbortController().signal,
          { fileBytes },
        ),
      ).rejects.toThrow('Invalid delegated file bound.');
  });

  it('allows only one expected-missing writer to create a destination', async () => {
    const writers = await Promise.all(Array.from({ length: 8 }, () => open()));
    for (let index = 0; index < 20; index += 1) {
      const file = `raced-create-${index}.txt`;
      const results = await Promise.allSettled(
        writers.map((access, writer) =>
          access.write(file, null, `${writer}`.repeat(65_536)),
        ),
      );
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(await fs.readFile(path.join(root, file), 'utf8')).toMatch(
        /^(?:0|1|2|3|4|5|6|7)+$/,
      );
    }
  });

  beforeEach(async () => {
    temporary = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-files-')),
    );
    root = path.join(temporary, 'worktree');
    outside = path.join(temporary, 'outside');
    processCwd = path.join(temporary, 'process-cwd');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(outside);
    await fs.mkdir(processCwd);
    await fs.writeFile(
      path.join(root, 'src/source.ts'),
      'export function safe(): void {}\n// searchable finding\n',
    );
    await fs.writeFile(path.join(outside, 'secret'), 'PRIVATE_CANARY');
  });
  afterEach(async () => {
    await Promise.all(handles.splice(0).map((access) => access.close()));
    // Every write stays inside the pinned root; nothing lands in the helper's cwd.
    expect(await fs.readdir(processCwd)).toEqual([]);
    await fs.rm(temporary, { recursive: true, force: true });
  });

  it('reads, lists and searches bounded source files through the same native root', async () => {
    const access = await open();
    expect(await access.read('src/source.ts')).toContain(
      'export function safe',
    );
    expect(await access.list()).toEqual([{ path: 'src', directory: true }]);
    expect(await access.search('searchable')).toEqual({
      matches: [
        { path: 'src/source.ts', line: 2, text: '// searchable finding' },
      ],
      filesRead: 1,
      truncated: false,
    });
  });

  it('denies traversal, links, private state, alternate streams, binary and oversized files', async () => {
    await fs.symlink(
      outside,
      path.join(root, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await fs.link(path.join(outside, 'secret'), path.join(root, 'hard-link'));
    for (const file of [
      '.env',
      '.ENV.local',
      '.npmrc',
      'auth.json',
      'credentials',
      'private.pem',
      'private.key',
    ])
      await fs.writeFile(path.join(root, file), 'PRIVATE_CANARY');
    for (const directory of [
      '.git',
      '.claude',
      '.codex',
      '.ssh',
      '.aws',
      '.kube',
      '.config',
      '.canopy',
    ]) {
      await fs.mkdir(path.join(root, directory));
      await fs.writeFile(
        path.join(root, directory, 'secret'),
        'PRIVATE_CANARY',
      );
    }
    await fs.writeFile(path.join(root, 'oversized'), Buffer.alloc(65_537, 65));
    await fs.writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 2]));
    const access = await open();
    for (const file of [
      '../outside/secret',
      '/etc/passwd',
      'src//source.ts',
      'src\\source.ts',
      'src/source.ts:stream',
      'escape/secret',
      'hard-link',
      '.env',
      '.ENV.local',
      '.npmrc',
      'auth.json',
      'credentials',
      'private.pem',
      'private.key',
      'oversized',
      'binary',
      ...[
        '.git',
        '.claude',
        '.codex',
        '.ssh',
        '.aws',
        '.kube',
        '.config',
        '.canopy',
      ].map((directory) => `${directory}/secret`),
    ])
      await expect(access.read(file)).rejects.toThrow();
    expect(JSON.stringify(await access.search('PRIVATE_CANARY'))).not.toContain(
      'PRIVATE_CANARY',
    );
  });

  it('retains the original root handle after the selected directory is replaced', async () => {
    const access = await open();
    await fs.rename(root, path.join(temporary, 'original-worktree'));
    await fs.symlink(
      outside,
      root,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(await access.read('src/source.ts')).toContain('safe');
    await expect(access.read('secret')).rejects.toThrow();
  });

  it('rejects a replaced parent component and preserves normal reads afterward', async () => {
    const access = await open();
    await fs.rename(path.join(root, 'src'), path.join(root, 'original-src'));
    await fs.symlink(
      outside,
      path.join(root, 'src'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(access.read('src/secret')).rejects.toThrow();
    expect(await access.read('original-src/source.ts')).toContain('safe');
  });

  it('bounds matches and closes the native process on cancellation', async () => {
    const controller = new AbortController();
    const access = await open(controller.signal);
    await fs.writeFile(
      path.join(root, 'matches'),
      Array.from({ length: 200 }, () => 'needle').join('\n'),
    );
    const result = await access.search('needle', '', 3);
    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(true);
    controller.abort();
    await expect(access.read('src/source.ts')).rejects.toThrow();
    await access.close();
  });
});
