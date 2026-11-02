import { readIsolatedDelegationWorktreeSummary } from '../manage-workspace';
import type { ManagedDelegationWorktreeSummary } from '@canopy/protocol/delegation';
import type { StoredDelegation } from '@canopy/desktop-shared/node/delegation/broker';
import { DELEGATION_FILE_MAX_BYTES } from '@canopy/desktop-shared/node/delegation/file-access';
import {
  createIsolatedDelegationWorktree,
  isolatedDelegationWorktreeStats,
} from '../isolated-worktree';
import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

let mockHangGit = false;
let mockGitArguments: string[][] = [];
jest.setTimeout(20_000);

jest.mock('../../claude-process-host-runner', () => ({
  spawnClaudeCodeProcessOffMain: (
    options: SpawnOptions,
  ): ChildProcessWithoutNullStreams => {
    // CANOPY_GIT_EXECUTABLE may name git by absolute path.
    if (/^git(\.exe)?$/i.test(options.command.split(/[\\/]/).pop() ?? ''))
      mockGitArguments.push([...options.args]);
    const stdio: ['pipe', 'pipe', 'pipe'] = ['pipe', 'pipe', 'pipe'];
    const processOptions = {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio,
    };
    return mockHangGit
      ? spawn(
          process.execPath,
          ['-e', 'setInterval(() => {}, 1000)'],
          processOptions,
        )
      : spawn(options.command, options.args, processOptions);
  },
}));

const executeFile = promisify(execFile);
const childId = 'summary-child';
let directory: string;
let dataDirectory: string;
let isolated: { readonly cwd: string; readonly revision: string };
let record: StoredDelegation;

interface IsolatedWorkspace {
  readonly cwd: string;
  readonly revision: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await executeFile('git', args, {
    cwd,
    timeout: 10_000,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    },
  });
  return stdout.trim();
}

function recordFixture(workspace: IsolatedWorkspace): StoredDelegation {
  return {
    version: 1,
    parent: {
      sessionKey: 'parent',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      harnessId: 'claude',
      turnId: 'turn',
      toolCallId: 'call',
      runtimeGeneration: 1,
      depth: 0,
    },
    executionCwd: workspace.cwd,
    isolationBaseCwd: directory,
    isolationRevision: workspace.revision,
    task: {
      modelId: 'reviewer',
      description: 'Summarize isolated changes',
      prompt: 'Summarize the changes.',
      executionMode: 'background',
      contextPolicy: 'task_only',
      isolation: 'worktree',
      permissions: { writePaths: ['.'] },
    },
    callKey: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    createdAt: 1,
    state: {
      delegationId: childId,
      runGeneration: 1,
      sequence: 1,
      status: 'completed',
      outputTruncated: false,
    },
    launch: {
      version: 1,
      delegationId: childId,
      launchKey: 'a'.repeat(64),
      runGeneration: 1,
      phase: 'settled',
      terminalStatus: 'completed',
    },
    delivery: { status: 'unclaimed' },
  };
}

async function makeSummary(
  options: {
    readonly signal?: AbortSignal;
    readonly summaryRecord?: StoredDelegation;
    readonly summaryDirectory?: string;
  } = {},
): Promise<ManagedDelegationWorktreeSummary> {
  return readIsolatedDelegationWorktreeSummary({
    directory: options.summaryDirectory ?? dataDirectory,
    delegationId: childId,
    revision: isolated.revision,
    record: options.summaryRecord ?? record,
    signal: options.signal ?? new AbortController().signal,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

beforeEach(async () => {
  mockHangGit = false;
  mockGitArguments = [];
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-summary-'));
  dataDirectory = path.join(directory, 'delegations');
  await git(directory, ['init', '--quiet']);
  await git(directory, ['config', 'user.name', 'Delegation Test']);
  await git(directory, ['config', 'user.email', 'delegation@example.test']);
  await fs.writeFile(path.join(directory, 'modified.txt'), 'old\nkept\n');
  await fs.writeFile(path.join(directory, 'deleted.txt'), 'gone\nonce\n');
  await fs.writeFile(path.join(directory, 'rename-source.txt'), 'same\ntext\n');
  await fs.writeFile(
    path.join(directory, 'binary.bin'),
    Buffer.from([0, 1, 2]),
  );
  await git(directory, ['add', '.']);
  await git(directory, [
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'base subject',
  ]);
  isolated = await createIsolatedDelegationWorktree(
    directory,
    path.join(dataDirectory, 'worktrees', childId),
    new AbortController().signal,
  );
  record = recordFixture(isolated);
});

afterEach(async () => {
  mockHangGit = false;
  jest.useRealTimers();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('readIsolatedDelegationWorktreeSummary', () => {
  it('summarizes tracked, renamed, untracked, and binary changes with relative paths', async () => {
    await fs.writeFile(
      path.join(isolated.cwd, 'modified.txt'),
      'old\nnew one\nnew two\n',
    );
    await fs.unlink(path.join(isolated.cwd, 'deleted.txt'));
    await git(isolated.cwd, ['mv', 'rename-source.txt', 'renamed.txt']);
    await fs.writeFile(
      path.join(isolated.cwd, 'binary.bin'),
      Buffer.from([0, 1, 3]),
    );
    await fs.writeFile(path.join(isolated.cwd, 'added.txt'), 'new file\n');
    await git(isolated.cwd, [
      'add',
      'modified.txt',
      'deleted.txt',
      'binary.bin',
      'added.txt',
    ]);
    await git(isolated.cwd, [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'delegate changes',
    ]);
    await fs.writeFile(path.join(isolated.cwd, 'untracked.txt'), 'one\ntwo\n');

    const summary = await makeSummary();

    expect(summary).toEqual({
      delegationId: childId,
      checkout: 'retained',
      startingRevision: isolated.revision,
      startingSubject: 'base subject',
      filesChanged: 6,
      additions: 5,
      deletions: 3,
      commitsAhead: 1,
      untrackedFiles: 1,
      applyState: 'not_applied',
      topFiles: [
        {
          path: 'modified.txt',
          additions: 2,
          deletions: 1,
          status: 'modified',
        },
        { path: 'deleted.txt', additions: 0, deletions: 2, status: 'deleted' },
        {
          path: 'untracked.txt',
          additions: 2,
          deletions: 0,
          status: 'untracked',
        },
        { path: 'added.txt', additions: 1, deletions: 0, status: 'added' },
        { path: 'binary.bin', additions: 0, deletions: 0, status: 'modified' },
        { path: 'renamed.txt', additions: 0, deletions: 0, status: 'renamed' },
      ],
      truncated: false,
    });
    expect(
      summary.topFiles.every(({ path: file }) => !path.isAbsolute(file)),
    ).toBe(true);
  });

  it('orders the ten displayed files by churn and marks omitted files truncated', async () => {
    const expected: { path: string; additions: number }[] = [];
    for (let index = 0; index < 12; index += 1) {
      const file = `churn-${index}.txt`;
      await fs.writeFile(
        path.join(isolated.cwd, file),
        'line\n'.repeat(index + 1),
      );
      expected.push({ path: file, additions: index + 1 });
    }

    const summary = await makeSummary();

    expect(summary.filesChanged).toBe(12);
    expect(summary.additions).toBe(78);
    expect(summary.topFiles).toHaveLength(10);
    expect(
      summary.topFiles.map(({ path: file, additions }) => [file, additions]),
    ).toEqual(
      expected
        .sort(
          (left, right) =>
            right.additions - left.additions ||
            left.path.localeCompare(right.path),
        )
        .slice(0, 10)
        .map(({ path: file, additions }) => [file, additions]),
    );
    expect(summary.truncated).toBe(true);
  });

  it('batches literal pathspec arguments without splitting rename pairs', async () => {
    const longPaths = Array.from(
      { length: 50 },
      (_, index) =>
        `${'d'.repeat(120)}-${index}/file-${index}-${'f'.repeat(120)}.txt`,
    );
    for (const file of longPaths) {
      await fs.mkdir(path.dirname(path.join(isolated.cwd, file)), {
        recursive: true,
      });
      await fs.writeFile(path.join(isolated.cwd, file), 'one line\n');
    }
    await git(isolated.cwd, [
      'mv',
      'rename-source.txt',
      'rename-source-renamed.txt',
    ]);
    await fs.writeFile(
      path.join(isolated.cwd, 'rename-source-renamed.txt'),
      'same\ntext\nx\ny\n',
    );
    await git(isolated.cwd, ['add', '.']);
    await git(isolated.cwd, [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'many long paths',
    ]);

    const summary = await makeSummary();

    expect(summary.filesChanged).toBe(51);
    expect(summary.additions).toBe(52);
    expect(summary.topFiles[0]).toEqual({
      path: 'rename-source-renamed.txt',
      additions: 2,
      deletions: 0,
      status: 'renamed',
    });
    expect(summary.truncated).toBe(true);
  });

  it('returns zero summaries for missing and discarded checkouts', async () => {
    const missing = await makeSummary({
      summaryDirectory: path.join(directory, 'no-delegation-data'),
    });
    expect(missing).toMatchObject({
      checkout: 'missing',
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      commitsAhead: 0,
      untrackedFiles: 0,
      topFiles: [],
      truncated: false,
    });

    const discarded = await makeSummary({
      summaryRecord: { ...record, workspaceDiscarded: true },
    });
    expect(discarded).toMatchObject({
      checkout: 'discarded',
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      commitsAhead: 0,
      untrackedFiles: 0,
      applyState: 'discarded',
      topFiles: [],
      truncated: false,
    });
  });

  it('projects durable apply state without reading protected file content', async () => {
    await fs.writeFile(
      path.join(isolated.cwd, '.env.local'),
      'SECRET=must-not-be-read\n',
    );
    const applied = await makeSummary({
      summaryRecord: {
        ...record,
        control: {
          operationId: 'apply-operation',
          key: 'apply-key',
          requestHash: 'c'.repeat(64),
          operation: 'apply',
          status: 'completed',
        },
      },
    });
    expect(applied).toMatchObject({
      applyState: 'applied',
      filesChanged: 1,
      additions: 0,
      deletions: 0,
      untrackedFiles: 1,
      topFiles: [],
      truncated: true,
    });
    expect(JSON.stringify(applied)).not.toContain('must-not-be-read');

    const failed = await makeSummary({
      summaryRecord: {
        ...record,
        control: {
          operationId: 'failed-apply-operation',
          key: 'failed-apply-key',
          requestHash: 'd'.repeat(64),
          operation: 'apply',
          status: 'failed',
        },
      },
    });
    expect(failed.applyState).toBe('apply_failed');
  });

  it('limits rename scans to safe paths and omits oversized starting blobs', async () => {
    const repository = path.join(directory, 'bounded-repository');
    await fs.mkdir(repository);
    await git(repository, ['init', '--quiet']);
    await git(repository, ['config', 'user.name', 'Delegation Test']);
    await git(repository, ['config', 'user.email', 'delegation@example.test']);
    await fs.writeFile(
      path.join(repository, 'rename-source.txt'),
      'same\ntext\n',
    );
    const oversizedBasePath = path.join(repository, 'oversized-base.txt');
    const oversizedBase = await fs.open(oversizedBasePath, 'w');
    await oversizedBase.truncate(DELEGATION_FILE_MAX_BYTES + 1);
    await oversizedBase.close();
    await git(repository, ['add', '.']);
    await git(repository, [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'base with large blob',
    ]);
    const startingRevision = await git(repository, [
      'rev-parse',
      '--verify',
      'HEAD',
    ]);
    await fs.unlink(oversizedBasePath);
    await git(repository, ['mv', 'rename-source.txt', 'renamed-safe.txt']);
    await fs.writeFile(
      path.join(repository, 'renamed-safe.txt'),
      'same\ntext\nupdated\n',
    );
    await fs.writeFile(
      path.join(repository, '.env.local'),
      'SECRET=must-not-be-read\n',
    );
    await git(repository, ['add', '.env.local', 'renamed-safe.txt']);
    await git(repository, ['rm', '--quiet', 'oversized-base.txt']);
    await git(repository, [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'protected, oversized, and safe rename changes',
    ]);

    mockGitArguments = [];
    const summary = await isolatedDelegationWorktreeStats(
      repository,
      startingRevision,
      new AbortController().signal,
    );

    expect(summary).toMatchObject({
      filesChanged: 3,
      additions: 1,
      deletions: 0,
      untrackedFiles: 0,
      topFiles: [
        {
          path: 'renamed-safe.txt',
          additions: 1,
          deletions: 0,
          status: 'renamed',
        },
      ],
      truncated: true,
    });
    expect(JSON.stringify(summary)).not.toContain('must-not-be-read');
    const rawRenameArgs = mockGitArguments.filter(
      (args) => args.includes('--raw') && args.includes('--find-renames'),
    );
    expect(rawRenameArgs).toHaveLength(1);
    expect(rawRenameArgs[0]).toContain(':(literal)rename-source.txt');
    expect(rawRenameArgs[0]).toContain(':(literal)renamed-safe.txt');
    expect(rawRenameArgs.flat().join('\n')).not.toContain('.env.local');
    expect(rawRenameArgs.flat().join('\n')).not.toContain('oversized-base.txt');
  });

  it('sanitizes timed out and failed reads without leaking checkout paths', async () => {
    mockHangGit = true;
    const timedOut = await makeSummary({
      signal: AbortSignal.timeout(100),
    }).catch((error: unknown) => error);
    expect(timedOut).toMatchObject({
      message: 'Isolated workspace summary could not be read.',
    });
    expect(errorMessage(timedOut)).not.toContain(isolated.cwd);

    mockHangGit = false;
    await fs.rm(path.join(directory, '.git'), { recursive: true, force: true });
    const failedRead = await makeSummary().catch((error: unknown) => error);
    expect(failedRead).toMatchObject({
      message: 'Isolated workspace summary could not be read.',
    });
    expect(errorMessage(failedRead)).not.toContain(isolated.cwd);
  });

  it('rejects cancelled reads and mismatched record authority', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(makeSummary({ signal: controller.signal })).rejects.toThrow(
      'Isolated workspace summary could not be read.',
    );
    await expect(
      readIsolatedDelegationWorktreeSummary({
        directory: dataDirectory,
        delegationId: childId,
        revision: 'a'.repeat(40),
        record,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("The revision isn't this delegate's starting revision.");
  });
});
