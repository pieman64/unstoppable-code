import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitRepositoryWriteError } from '@canopy/core-runtime/node/git';
import { createGitWriteHostWith, gitWriteCommandFor } from '../git-write/host';

const posix = process.platform === 'win32' ? describe.skip : describe;
const environment = { PATH: '/usr/bin:/bin', HOME: '/tmp' };

/** The code a synchronous refusal carries. */
function refusalCode(refuse: () => unknown): string | undefined {
  try {
    refuse();
  } catch (error) {
    return error instanceof GitRepositoryWriteError ? error.code : undefined;
  }
  return undefined;
}

describe('Git write commands (CAN-4108)', () => {
  it('plans desktop argv with Git non-interactive switches added', () => {
    const plan = gitWriteCommandFor(
      'darwin',
      {
        kind: 'checkout-new-branch',
        name: 'feature',
        startPoint: 'origin/main',
      },
      environment,
    )('/usr/bin/git');
    expect(plan).toEqual({
      file: '/usr/bin/git',
      args: ['checkout', '-b', 'feature', 'origin/main'],
      env: {
        ...environment,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
      },
      timeoutMs: undefined,
    });
    expect(
      gitWriteCommandFor(
        'linux',
        { kind: 'fetch-origin-branch', branch: 'pr/1' },
        environment,
      )('/usr/bin/git'),
    ).toMatchObject({
      args: [
        'fetch',
        '--no-tags',
        'origin',
        'refs/heads/pr/1:refs/remotes/origin/pr/1',
      ],
      timeoutMs: 10_000,
    });
  });

  it.each([
    [
      { kind: 'rename-current-branch', name: 'renamed' },
      ['branch', '-m', 'renamed'],
    ],
    [{ kind: 'delete-branch', branch: 'old' }, ['branch', '-d', 'old']],
    [{ kind: 'force-delete-branch', branch: 'old' }, ['branch', '-D', 'old']],
    [
      { kind: 'delete-branch-ref', branch: 'old', tip: 'a'.repeat(40) },
      ['update-ref', '-d', 'refs/heads/old', 'a'.repeat(40)],
    ],
    [
      { kind: 'delete-branch-ref', branch: 'old', tip: 'b'.repeat(64) },
      ['update-ref', '-d', 'refs/heads/old', 'b'.repeat(64)],
    ],
  ])('plans the CAN-5516 ref command %o, unbounded', (write, args) => {
    expect(
      gitWriteCommandFor('linux', write, environment)('/usr/bin/git'),
    ).toMatchObject({ args, timeoutMs: undefined });
  });

  it.each([
    [{ kind: 'rename-current-branch', name: '-M' }],
    [{ kind: 'rename-current-branch', name: '' }],
    [{ kind: 'delete-branch', branch: '--remotes' }],
    [{ kind: 'force-delete-branch', branch: 'a\0b' }],
    [{ kind: 'delete-branch-ref', branch: 'old', tip: 'HEAD' }],
    [{ kind: 'delete-branch-ref', branch: 'old', tip: 'a'.repeat(39) }],
    [{ kind: 'delete-branch-ref', branch: 'old', tip: 'A'.repeat(40) }],
    [{ kind: 'delete-branch-ref', branch: 'old', tip: `${'a'.repeat(40)}^` }],
    [{ kind: 'delete-branch-ref', branch: '-d', tip: 'a'.repeat(40) }],
    [{ kind: 'checkout', branch: '-f' }],
    [{ kind: 'checkout', branch: '' }],
    [{ kind: 'checkout', branch: 'a\0b' }],
    [{ kind: 'checkout-new-branch', name: 'x', startPoint: '--orphan' }],
    [{ kind: 'local-branch', branch: 7 }],
    [{ kind: 'reset', branch: 'main' }],
    [null],
  ])('refuses %o before any selection', (write) => {
    expect(
      refusalCode(() => gitWriteCommandFor('darwin', write, environment)),
    ).toBe('invalid_request');
  });

  it('refuses every command on win32 (D10)', () => {
    expect(
      refusalCode(() =>
        gitWriteCommandFor('win32', { kind: 'status' }, environment),
      ),
    ).toBe('unsupported_command');
  });

  it('runs only an absolute selected Git', () => {
    const plan = gitWriteCommandFor('linux', { kind: 'status' }, environment);
    expect(refusalCode(() => plan('git'))).toBe('git_unavailable');
  });
});

describe('Git fetch and pull commands (CAN-5517)', () => {
  it.each([
    [{ kind: 'fetch-origin', prune: true }, ['fetch', '--prune', 'origin']],
    [{ kind: 'fetch-origin', prune: false }, ['fetch', 'origin']],
    [
      { kind: 'pull-fast-forward', branch: 'feature/a' },
      ['pull', '--ff-only', 'origin', 'feature/a'],
    ],
    [
      { kind: 'pull-rebase', branch: 'feature/a' },
      ['pull', '--rebase', '--autostash', 'origin', 'feature/a'],
    ],
    [
      { kind: 'rebase-state-path', name: 'rebase-merge' },
      ['rev-parse', '--git-path', 'rebase-merge'],
    ],
    [
      { kind: 'rebase-state-path', name: 'rebase-apply' },
      ['rev-parse', '--git-path', 'rebase-apply'],
    ],
    [{ kind: 'stash-list' }, ['stash', 'list']],
    [{ kind: 'porcelain-status' }, ['status', '--porcelain=v1']],
  ])(
    'plans %o as the desktop pull flow runs it, unbounded and non-interactive',
    (write, args) => {
      expect(
        gitWriteCommandFor('darwin', write, environment)('/usr/bin/git'),
      ).toEqual({
        file: '/usr/bin/git',
        args,
        env: {
          ...environment,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
        },
        timeoutMs: undefined,
      });
    },
  );

  it.each([
    [{ kind: 'fetch-origin' }],
    [{ kind: 'fetch-origin', prune: 'yes' }],
    [{ kind: 'pull-rebase', branch: '--exec=sh' }],
    [{ kind: 'pull-fast-forward', branch: '' }],
    [{ kind: 'pull-fast-forward', branch: 'a\0b' }],
    [{ kind: 'rebase-state-path', name: 'config' }],
    [{ kind: 'rebase-state-path', name: '../../etc' }],
  ])('refuses %o before any selection', (write) => {
    expect(
      refusalCode(() => gitWriteCommandFor('linux', write, environment)),
    ).toBe('invalid_request');
  });

  it('refuses fetch and pull on win32 (D10)', () => {
    for (const write of [
      { kind: 'fetch-origin', prune: true },
      { kind: 'pull-rebase', branch: 'main' },
    ])
      expect(
        refusalCode(() => gitWriteCommandFor('win32', write, environment)),
      ).toBe('unsupported_command');
  });
});

posix('Git write host', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'git-write-host-')));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A stand-in Git that records its argv, then runs `body`. */
  function fakeGit(body: string): string {
    const file = join(dir, 'fake-git');
    writeFileSync(
      file,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\n${body}\n`,
    );
    chmodSync(file, 0o755);
    return file;
  }

  it('runs a command in the trusted directory and answers its exit and stdout', async () => {
    const executable = fakeGit("printf ' M a.txt\\n'; exit 0");
    const host = createGitWriteHostWith(
      {
        os: process.platform === 'darwin' ? 'darwin' : 'linux',
        environment,
        selectExecutable: () => Promise.resolve(executable),
      },
      {},
    );
    await expect(host.port.run({ kind: 'status' }, dir)).resolves.toEqual({
      exitCode: 0,
      stdout: ' M a.txt\n',
    });
    expect(readFileSync(join(dir, 'argv'), 'utf8')).toBe(
      'status\n--porcelain\n--untracked-files=normal\n',
    );
    await expect(host.stop(new AbortController().signal)).resolves.toEqual({
      state: 'stopped',
    });
  });

  it("runs a command with the request's forwarded environment, never merged, prompts still off (CAN-5496)", async () => {
    const executable = fakeGit(
      `env | sort > "${dir}/env"; printf '%s %s' "$GIT_TERMINAL_PROMPT" "$GCM_INTERACTIVE" > "${dir}/switches"`,
    );
    const selections: AbortSignal[] = [];
    const host = createGitWriteHostWith(
      {
        os: process.platform === 'darwin' ? 'darwin' : 'linux',
        environment: { ...environment, DAEMON_ONLY: 'snapshot' },
        selectExecutable: (signal) => {
          selections.push(signal);
          return Promise.resolve(executable);
        },
      },
      {},
    );
    const childEnv = (): string => readFileSync(join(dir, 'env'), 'utf8');
    await host.port.run({ kind: 'checkout', branch: 'main' }, dir, {
      PATH: '/usr/bin:/bin',
      FORWARDED_ONLY: 'request',
      GIT_TERMINAL_PROMPT: '1',
      GCM_INTERACTIVE: 'always',
    });
    expect(childEnv()).toContain('FORWARDED_ONLY=request\n');
    expect(childEnv()).not.toContain('DAEMON_ONLY');
    expect(readFileSync(join(dir, 'switches'), 'utf8')).toBe('0 never');
    // The next request without one is back on the startup snapshot.
    await host.port.run({ kind: 'status' }, dir);
    expect(childEnv()).toContain('DAEMON_ONLY=snapshot\n');
    expect(childEnv()).not.toContain('FORWARDED_ONLY');
    // A value a child cannot hold is refused before selection or any spawn.
    rmSync(join(dir, 'argv'));
    await expect(
      host.port.run({ kind: 'status' }, dir, { BAD: 'a\0b' }),
    ).rejects.toEqual(new GitRepositoryWriteError('invalid_request'));
    expect(selections).toHaveLength(2);
    expect(() => readFileSync(join(dir, 'argv'))).toThrow();
  });

  it('lets a started checkout finish across stop, then refuses new commands', async () => {
    const executable = fakeGit(`sleep 0.3; echo done > "${dir}/finished"`);
    const host = createGitWriteHostWith(
      {
        os: process.platform === 'darwin' ? 'darwin' : 'linux',
        environment,
        selectExecutable: () => Promise.resolve(executable),
      },
      {},
    );
    const started = host.port.run({ kind: 'checkout', branch: 'main' }, dir);
    // Let selection finish so the child has spawned.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stopped = host.stop(new AbortController().signal);
    await expect(started).resolves.toEqual({ exitCode: 0, stdout: '' });
    await expect(stopped).resolves.toEqual({ state: 'stopped' });
    expect(readFileSync(join(dir, 'finished'), 'utf8')).toBe('done\n');
    await expect(
      host.port.run({ kind: 'checkout', branch: 'main' }, dir),
    ).rejects.toEqual(new GitRepositoryWriteError('stopped'));
  });

  it('reports a stop that a running command outlasts as unconfirmed, killing nothing', async () => {
    const executable = fakeGit(`sleep 0.5; echo done > "${dir}/finished"`);
    const host = createGitWriteHostWith(
      {
        os: process.platform === 'darwin' ? 'darwin' : 'linux',
        environment,
        selectExecutable: () => Promise.resolve(executable),
      },
      {},
    );
    const started = host.port.run({ kind: 'checkout', branch: 'main' }, dir);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const deadline = new AbortController();
    const stopped = host.stop(deadline.signal);
    deadline.abort();
    await expect(stopped).resolves.toEqual({ state: 'cleanup_unconfirmed' });
    await expect(started).resolves.toMatchObject({ exitCode: 0 });
    expect(readFileSync(join(dir, 'finished'), 'utf8')).toBe('done\n');
  });

  it('kills only the bounded fetch at its timeout', async () => {
    const executable = fakeGit('sleep 5');
    const host = createGitWriteHostWith(
      {
        os: process.platform === 'darwin' ? 'darwin' : 'linux',
        environment,
        selectExecutable: () => Promise.resolve(executable),
      },
      { fetchTimeoutMs: 150 },
    );
    await expect(
      host.port.run({ kind: 'fetch-origin-branch', branch: 'late' }, dir),
    ).rejects.toEqual(new GitRepositoryWriteError('timeout'));
  });

  it('answers a failed selection as Git unavailable, without running anything', async () => {
    const host = createGitWriteHostWith(
      {
        os: process.platform === 'darwin' ? 'darwin' : 'linux',
        environment,
        selectExecutable: () => Promise.reject(new Error('no git')),
      },
      {},
    );
    await expect(host.port.run({ kind: 'status' }, dir)).rejects.toEqual(
      new GitRepositoryWriteError('git_unavailable'),
    );
    await expect(host.port.run({ kind: 'status' }, 'relative')).rejects.toEqual(
      new GitRepositoryWriteError('invalid_request'),
    );
  });

  it('checks out a real branch with the real Git', async () => {
    const repo = join(dir, 'repo');
    const run = (...args: string[]): string =>
      execFileSync(
        'git',
        ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args],
        { cwd: repo, encoding: 'utf8' },
      ).trim();
    execFileSync('git', ['init', '-q', repo]);
    run('commit', '-q', '--allow-empty', '-m', 'init');
    run('branch', 'other');
    const git = execFileSync('/bin/sh', ['-c', 'command -v git'], {
      encoding: 'utf8',
    }).trim();
    const host = createGitWriteHostWith(
      {
        os: process.platform === 'darwin' ? 'darwin' : 'linux',
        environment: { PATH: process.env.PATH ?? '', HOME: dir },
        selectExecutable: () => Promise.resolve(git),
      },
      {},
    );
    await expect(
      host.port.run({ kind: 'checkout', branch: 'other' }, repo),
    ).resolves.toMatchObject({ exitCode: 0 });
    expect(run('symbolic-ref', '--short', 'HEAD')).toBe('other');
    await expect(
      host.port.run({ kind: 'local-branch', branch: 'missing' }, repo),
    ).resolves.toMatchObject({ exitCode: 1 });
  });
});
