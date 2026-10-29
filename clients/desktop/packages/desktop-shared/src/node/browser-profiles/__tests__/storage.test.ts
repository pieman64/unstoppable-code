import type * as NativeFs from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readProfileJson, writeProfileJson } from '../storage';

// Node built-ins are shared across Jest suites. Keep these fault-injection spies
// local so a prior suite's snapshot writer cannot hit them or add to their counts.
jest.mock('node:fs/promises', () => ({
  ...jest.requireActual<typeof NativeFs>('node:fs/promises'),
}));

const nativeFs = jest.requireActual<typeof NativeFs>('node:fs/promises');
const profileFs = jest.requireMock<typeof NativeFs>('node:fs/promises');

async function writeUnrelatedSnapshot(root: string): Promise<void> {
  const temporary = join(root, 'snapshot.json.tmp');
  const destination = join(root, 'snapshot.json');
  try {
    const handle = await nativeFs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile('{"snapshot":true}\n', 'utf8');
    } finally {
      await handle.close();
    }
    await nativeFs.rename(temporary, destination);
    expect(await nativeFs.readFile(destination, 'utf8')).toBe(
      '{"snapshot":true}\n',
    );
  } finally {
    await nativeFs.rm(temporary, { force: true });
    await nativeFs.rm(destination, { force: true });
  }
}

describe('profile metadata atomic replacement', () => {
  it('fails closed on malformed metadata instead of treating it as empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'profile-corruption-test-'));
    const target = join(root, 'record.json');
    await writeFile(target, '{not-json');
    try {
      await expect(readProfileJson(target)).rejects.toMatchObject({
        code: 'recovery_required',
      });
      await expect(readFile(target, 'utf8')).resolves.toBe('{not-json');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])(
    'retries one transient %s using the same complete sibling file',
    async (code) => {
      const root = await mkdtemp(join(tmpdir(), 'profile-rename-test-'));
      const target = join(root, 'record.json');
      const previous = { status: 'queued', retained: 'old receipt' };
      const next = { status: 'running', retained: 'new receipt' };
      await writeFile(target, JSON.stringify(previous));
      const rename = nativeFs.rename;
      const open = nativeFs.open;
      const writes: jest.SpyInstance[] = [];
      const openSpy = jest
        .spyOn(profileFs, 'open')
        .mockImplementation(async (...args) => {
          const handle = await open(...args);
          writes.push(jest.spyOn(handle, 'writeFile'));
          return handle;
        });
      const removeSpy = jest.spyOn(profileFs, 'rm');
      const renameSpy = jest
        .spyOn(profileFs, 'rename')
        .mockImplementation(async (source, destination) => {
          expect(destination).toBe(target);
          expect(await readProfileJson(target)).toEqual(previous);
          expect(JSON.parse(await readFile(source, 'utf8'))).toEqual(next);
          if (renameSpy.mock.calls.length === 1)
            throw Object.assign(
              new Error('Injected transient metadata rename denial'),
              { code },
            );
          await rename(source, destination);
        });
      try {
        // A prior suite can still flush a snapshot through the native module.
        await writeUnrelatedSnapshot(root);
        await expect(writeProfileJson(target, next)).resolves.toBeUndefined();
        expect(renameSpy).toHaveBeenCalledTimes(2);
        expect(renameSpy.mock.calls[1]).toEqual(renameSpy.mock.calls[0]);
        expect(openSpy).toHaveBeenCalledTimes(1);
        expect(openSpy).toHaveBeenCalledWith(
          renameSpy.mock.calls[0][0],
          'wx',
          0o600,
        );
        expect(writes).toHaveLength(1);
        expect(writes[0]).toHaveBeenCalledTimes(1);
        expect(
          removeSpy.mock.calls.filter(
            ([path]) => path === renameSpy.mock.calls[0][0],
          ),
        ).toEqual([]);
        expect(await readProfileJson(target)).toEqual(next);
        expect(await readdir(root)).toEqual(['record.json']);
      } finally {
        jest.restoreAllMocks();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['EPERM', 6],
    ['EACCES', 6],
    ['EBUSY', 6],
    ['ENOENT', 1],
    ['ENOSPC', 1],
  ] as const)(
    'bounds persistent %s at %i attempts and preserves the readable destination',
    async (code, attempts) => {
      const root = await mkdtemp(join(tmpdir(), 'profile-rename-test-'));
      const target = join(root, 'record.json');
      const previous = '{"status":"queued","retained":"original bytes"}\n';
      await writeFile(target, previous);
      await writeFile(join(root, 'unrelated.tmp'), 'unrelated evidence');
      const error = Object.assign(
        new Error('Injected persistent metadata rename denial'),
        { code },
      );
      const removeSpy = jest.spyOn(profileFs, 'rm');
      const openSpy = jest.spyOn(profileFs, 'open');
      const timerSpy = jest.spyOn(global, 'setTimeout');
      const renameSpy = jest
        .spyOn(profileFs, 'rename')
        .mockImplementation(async (source, destination) => {
          expect(destination).toBe(target);
          expect(await readFile(target, 'utf8')).toBe(previous);
          expect(JSON.parse(await readFile(source, 'utf8'))).toEqual({
            status: 'running',
          });
          throw error;
        });
      try {
        await writeUnrelatedSnapshot(root);
        // A separate cleanup can run while the filesystem spy is active.
        await rm(join(root, 'unrelated-scratch.tmp'), { force: true });
        await expect(
          writeProfileJson(target, { status: 'running' }),
        ).rejects.toBe(error);
        expect(await readFile(target, 'utf8')).toBe(previous);
        expect(await readdir(root)).toEqual(['record.json', 'unrelated.tmp']);
        expect(await readFile(join(root, 'unrelated.tmp'), 'utf8')).toBe(
          'unrelated evidence',
        );
        expect(
          removeSpy.mock.calls.filter(
            ([path]) => path === renameSpy.mock.calls[0][0],
          ),
        ).toEqual([[renameSpy.mock.calls[0][0], { force: true }]]);
        expect(openSpy).toHaveBeenCalledTimes(1);
        expect(renameSpy).toHaveBeenCalledTimes(attempts);
        expect(
          new Set(renameSpy.mock.calls.map(([source]) => source)).size,
        ).toBe(1);
        expect(timerSpy.mock.calls.map(([, delay]) => delay)).toEqual(
          attempts === 6 ? [50, 100, 150, 200, 250] : [],
        );
      } finally {
        jest.restoreAllMocks();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

function message(child: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, reject) => {
    let stderr = '';
    const capture = (chunk: Buffer): void => {
      stderr += chunk.toString();
    };
    const cleanup = (): void => {
      child.off('exit', exited);
      child.stderr?.off('data', capture);
    };
    const exited = (code: number | null): void => {
      cleanup();
      reject(new Error(`Lease test process exited ${code}: ${stderr}`));
    };
    child.stderr?.on('data', capture);
    child.once('exit', exited);
    child.once('message', (value) => {
      cleanup();
      resolveMessage(value as Record<string, unknown>);
    });
  });
}

it('serializes two cross-process reclaimers without replacing the winning live lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profile-lease-race-'));
  const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await once(dead, 'exit');
  const children: ChildProcess[] = [];
  try {
    await writeFile(
      join(root, 'writer.lock'),
      JSON.stringify({ pid: dead.pid, token: 'dead-owner' }),
    );
    const source = `
      const { withProfileWriter } = require(${JSON.stringify(resolve(__dirname, '../storage.ts'))});
      process.send({ ready: true });
      process.once('message', async () => {
        try {
          await withProfileWriter(${JSON.stringify(root)}, async () => {
            process.send({ acquired: true, pid: process.pid });
            await new Promise(resolve => process.once('message', resolve));
          });
          process.send({ released: true });
        } catch (error) {
          process.send({ rejected: true, code: error.code });
        }
        process.disconnect();
      });
    `;
    for (let i = 0; i < 2; i++) {
      const child = spawn(
        process.execPath,
        ['--require', 'tsx/cjs', '-e', source],
        {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      children.push(child);
      const ready = await message(child);
      expect(ready).toEqual({ ready: true });
    }
    const outcomes = children.map(message);
    children.forEach((child) => child.send('start'));
    const results = await Promise.all(outcomes);
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
    expect(results.filter((result) => result.rejected)).toHaveLength(1);
    const winner = results.findIndex((result) => result.acquired);
    const lease = JSON.parse(
      await readFile(join(root, 'writer.lock'), 'utf8'),
    ) as { pid: number };
    expect(lease.pid).toBe(children[winner].pid);
    const released = message(children[winner]);
    children[winner].send('release');
    expect(await released).toEqual({ released: true });
  } finally {
    children.forEach((child) => child.kill());
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
