import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitCloneProgressUpdate } from '../lib/git-clone-progress';

let fakeGit = '';
let resolveGitExecutable: (() => Promise<string>) | undefined;
jest.mock('../lib/git-executable', () => ({
  getResolvedGitExecutableForSpawn: (): Promise<string> =>
    resolveGitExecutable?.() ?? Promise.resolve(fakeGit),
}));

import { cloneRepoWithLiveProgress } from '../lib/git';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

function writeFakeGit(root: string, body: string): string {
  const path = join(root, 'git');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describePosix('cloneRepoWithLiveProgress', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clone-live-progress-'));
    resolveGitExecutable = undefined;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('asks git for progress and reports parsed updates', async () => {
    const argsLog = join(root, 'args.log');
    fakeGit = writeFakeGit(
      root,
      [
        `printf '%s\\n' "$*" > '${argsLog}'`,
        `printf "Cloning into 'repo'...\\n" >&2`,
        `printf 'Receiving objects:  10%% (1/10), 1.00 MiB | 1.00 MiB/s\\r' >&2`,
        `printf 'Receiving objects: 100%% (10/10), 5.00 MiB | 2.00 MiB/s, done.\\n' >&2`,
        `printf 'Resolving deltas: 100%% (4/4), done.\\n' >&2`,
        'exit 0',
      ].join('\n'),
    );
    const updates: GitCloneProgressUpdate[] = [];

    await cloneRepoWithLiveProgress('https://example.com/repo.git', '/dest', {
      onProgress: (update) => updates.push(update),
    });

    expect(readFileSync(argsLog, 'utf8').trim()).toBe(
      'clone --progress -- https://example.com/repo.git /dest',
    );
    expect(updates.map((update) => [update.phase, update.percent])).toEqual([
      ['receiving', 10],
      ['receiving', 100],
      ['resolving', 100],
    ]);
    expect(updates[1].received).toBe('5.00 MiB');
  });

  it('fails with the explanatory stderr lines, not progress noise', async () => {
    fakeGit = writeFakeGit(
      root,
      [
        `printf "Cloning into 'repo'...\\n" >&2`,
        `printf 'Receiving objects:  10%% (1/10)\\r' >&2`,
        `printf "fatal: repository 'https://example.com/repo.git/' not found\\n" >&2`,
        'exit 128',
      ].join('\n'),
    );

    await expect(
      cloneRepoWithLiveProgress('https://example.com/repo.git', '/dest', {
        onProgress: () => undefined,
      }),
    ).rejects.toThrow(
      "fatal: repository 'https://example.com/repo.git/' not found",
    );
  });

  it('redacts remote credentials echoed by git stderr', async () => {
    fakeGit = writeFakeGit(
      root,
      [
        `printf "fatal: repository 'https://token@host/org/repo.git/' not found\\n" >&2`,
        'exit 128',
      ].join('\n'),
    );
    await expect(
      cloneRepoWithLiveProgress('https://token@host/org/repo.git', '/dest', {
        onProgress: () => undefined,
      }),
    ).rejects.toThrow(
      "fatal: repository 'https://host/org/repo.git/' not found",
    );
  });

  it('does not start git when cancelled during executable resolution', async () => {
    const argsLog = join(root, 'started.log');
    fakeGit = writeFakeGit(root, `touch '${argsLog}'`);
    const lookup = deferredExecutable();
    resolveGitExecutable = (): Promise<string> => lookup.promise;
    const controller = new AbortController();
    const pending = cloneRepoWithLiveProgress(
      'https://example.com/repo.git',
      '/dest',
      {
        signal: controller.signal,
        onProgress: () => undefined,
      },
    );
    controller.abort();
    lookup.resolve(fakeGit);
    await expect(pending).rejects.toThrow('Clone cancelled');
    expect(() => readFileSync(argsLog)).toThrow();
  });

  it('stops git and its child processes when aborted', async () => {
    const childPidFile = join(root, 'child.pid');
    fakeGit = writeFakeGit(
      root,
      [
        'sleep 30 &',
        `echo $! > '${childPidFile}'`,
        `printf 'Receiving objects:   1%% (1/100)\\r' >&2`,
        'wait',
      ].join('\n'),
    );
    const controller = new AbortController();
    const pending = cloneRepoWithLiveProgress(
      'https://example.com/repo.git',
      '/dest',
      {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      },
    );

    await expect(pending).rejects.toThrow('Clone cancelled');
    const childPid = Number(readFileSync(childPidFile, 'utf8').trim());
    const deadline = Date.now() + 5_000;
    while (isAlive(childPid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(isAlive(childPid)).toBe(false);
  });
});

function deferredExecutable(): {
  promise: Promise<string>;
  resolve: (value: string) => void;
} {
  let resolve: (value: string) => void = () => undefined;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
