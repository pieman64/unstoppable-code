import {
  manageIsolatedDelegationWorkspace,
  readIsolatedDelegationChanges,
  rollbackInterruptedDelegationApply,
} from '../agents/delegation/manage-workspace';
import {
  DelegationApplyError,
  type DelegationAppliedFile,
  type DelegationApplyJournal,
  type DelegationWorkspaceHooks,
  type StoredDelegation,
} from '@canopy/desktop-shared/node/delegation/broker';
import { createHash } from 'node:crypto';
import type { AgentSessionOptions } from '../agents/types';

jest.mock('../pipelines/config-paths', () => ({
  getBundledDelegationFileBrokerPath: (): string =>
    path.join(
      process.cwd(),
      '.cache/bin',
      `${process.platform}-${process.arch}`,
      process.platform === 'win32'
        ? 'canopy-file-broker.exe'
        : 'canopy-file-broker',
    ),
}));
let mockApprovalCheck: (check: {
  path?: string;
}) => Promise<{ decision: string }>;
let mockApprovalPolicyContextKey: string;
let mockApprovalProvider: string | undefined;
jest.mock('../approvals/approval-service', () => ({
  createApprovalSession: (options: { provider: string }): object => {
    mockApprovalProvider = options.provider;
    return {
      check: (check: { path?: string }): Promise<{ decision: string }> =>
        mockApprovalCheck(check),
      setMode: (): void => undefined,
      policyContextKey: (): string => mockApprovalPolicyContextKey,
      dispose: (): void => undefined,
    };
  },
}));
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
import { NativeDelegationFiles } from '@canopy/desktop-shared/node/delegation/file-access';
import {
  createIsolatedDelegationWorktree,
  discardIsolatedDelegationWorktree,
  isolatedDelegationChanges,
  materializeIsolatedDelegationBases,
  reconcileIsolatedDelegationWorktree,
} from '../agents/delegation/isolated-worktree';
import { observeDelegationWorkspace } from '../agents/delegation/workspace-observation';

let mockBatchCheckSubmoduleReply: string | undefined;
jest.mock('../agents/claude-process-host-runner', () => ({
  spawnClaudeCodeProcessOffMain: (
    options: SpawnOptions,
  ): ChildProcessWithoutNullStreams =>
    spawn(
      mockBatchCheckSubmoduleReply && options.args.includes('--batch-check')
        ? process.execPath
        : options.command,
      mockBatchCheckSubmoduleReply && options.args.includes('--batch-check')
        ? [
            '-e',
            `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(mockBatchCheckSubmoduleReply)}));`,
          ]
        : options.args,
      {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        stdio: 'pipe',
      },
    ),
}));
let directory: string;
function ownerFixture(): AgentSessionOptions {
  return {
    cwd: directory,
    projectId: 'p',
    worktreeId: 'w',
    chatId: 'c',
    approvalMode: 'full-access',
  };
}

function recordFixture(options: {
  childId: string;
  executionCwd: string;
  revision: string;
  parentHarnessId?: string;
}): StoredDelegation {
  return {
    version: 1,
    parent: {
      sessionKey: 'parent',
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      harnessId: options.parentHarnessId ?? 'claude',
      turnId: 'turn',
      toolCallId: 'call',
      runtimeGeneration: 1,
      depth: 0,
    },
    executionCwd: options.executionCwd,
    isolationRevision: options.revision,
    task: {
      modelId: 'reviewer',
      description: 'Apply isolated changes',
      prompt: 'Apply the retained file changes.',
      executionMode: 'background',
      contextPolicy: 'task_only',
      isolation: 'worktree',
      permissions: { writePaths: ['.'] },
    },
    callKey: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    createdAt: 1,
    deadlineAt: 2,
    state: {
      delegationId: options.childId,
      runGeneration: 1,
      sequence: 1,
      status: 'completed',
      outputTruncated: false,
    },
    launch: {
      version: 1,
      delegationId: options.childId,
      launchKey: 'a'.repeat(64),
      runGeneration: 1,
      phase: 'settled',
      terminalStatus: 'completed',
    },
    delivery: { status: 'unclaimed' },
  };
}

/** The receipt apply records for a file: sha256 of its JSON content. */
function appliedFile(
  file: string,
  content: string | null,
): DelegationAppliedFile {
  return {
    path: file,
    delegate: createHash('sha256')
      .update(JSON.stringify(content))
      .digest('hex'),
  };
}

function blobId(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

interface RecordedHooks extends DelegationWorkspaceHooks {
  /** Files from each atomic `applied` commit. */
  readonly commits: DelegationAppliedFile[][];
  readonly journals: Array<
    Omit<DelegationApplyJournal, 'operationId'> | undefined
  >;
}

function recordingHooks(
  onJournal?: (
    journal: Omit<DelegationApplyJournal, 'operationId'>,
  ) => Promise<void>,
): RecordedHooks {
  const commits: DelegationAppliedFile[][] = [];
  const journals: RecordedHooks['journals'] = [];
  return {
    commits,
    journals,
    approvalPending: (): Promise<void> => Promise.resolve(),
    awaitingUser: (): void => undefined,
    journal: async (journal): Promise<void> => {
      journals.push(journal);
      if (journal) await onJournal?.(journal);
    },
    applied: (files): Promise<void> => {
      commits.push([...files]);
      return Promise.resolve();
    },
  };
}

async function applyFailure(
  applying: Promise<void>,
): Promise<DelegationApplyError> {
  const error = await applying.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof DelegationApplyError))
    throw new Error('Expected a failed apply to report its detail');
  return error;
}

const git = async (args: string[]): Promise<string> =>
  (
    await promisify(execFile)('git', args, { cwd: directory, timeout: 10_000 })
  ).stdout.trim();
/** Commits files to the parent, as the delegate's starting revision. */
async function commitBase(files: Record<string, string>): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(directory, file)), {
      recursive: true,
    });
    await fs.writeFile(path.join(directory, file), text);
  }
  await git(['add', '--', ...Object.keys(files)]);
  await git([
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'base fixture',
  ]);
}
beforeEach(async () => {
  mockBatchCheckSubmoduleReply = undefined;
  mockApprovalCheck = (): Promise<{ decision: string }> =>
    Promise.resolve({ decision: 'allow' });
  mockApprovalPolicyContextKey = 'policy:0:0';
  mockApprovalProvider = undefined;
  directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'delegation-observation-'),
  );
  await git(['init', '--quiet']);
  await git(['config', 'user.name', 'Delegation Test']);
  await git(['config', 'user.email', 'delegation@example.test']);
  await fs.writeFile(path.join(directory, 'source.txt'), 'original');
  await git(['add', 'source.txt']);
  await git([
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});
// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(60_000);

it('uses the Cursor provider for a Cursor parent worktree approval session', async () => {
  const childId = 'cursor-child';
  const data = path.join(directory, 'delegation');
  const isolated = await createIsolatedDelegationWorktree(
    directory,
    path.join(data, 'worktrees', childId),
    new AbortController().signal,
  );
  const record = recordFixture({
    childId,
    executionCwd: isolated.cwd,
    revision: isolated.revision,
    parentHarnessId: 'cursor',
  });

  await manageIsolatedDelegationWorkspace({
    record,
    operation: 'discard',
    directory: data,
    owner: ownerFixture,
    getWindow: (): null => null,
    signal: new AbortController().signal,
    hooks: recordingHooks(),
  });

  expect(mockApprovalProvider).toBe('cursor');
});
it('reports the observed commit and clean/dirty state without activating repository fsmonitor commands', async () => {
  const head = await git(['rev-parse', 'HEAD']);
  const marker = path.join(directory, 'should-not-exist');
  const script = path.join(directory, '.git', 'untrusted-fsmonitor');
  await fs.writeFile(script, '#!/bin/sh\ntouch "' + marker + '"\n', {
    mode: 0o700,
  });
  await git(['config', 'core.fsmonitor', script]);
  const clean = await observeDelegationWorkspace(
    directory,
    new AbortController().signal,
  );
  expect(clean).toMatchObject({
    consistency: 'live_shared_worktree',
    headRevision: head,
    dirty: false,
  });
  await fs.writeFile(path.join(directory, 'source.txt'), 'parent edit');
  const dirty = await observeDelegationWorkspace(
    directory,
    new AbortController().signal,
  );
  expect(dirty).toMatchObject({ headRevision: head, dirty: true });
  expect(dirty.observedAt).toBeGreaterThanOrEqual(clean.observedAt);
  await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('reports unknown state for non-Git roots and already cancelled observations', async () => {
  await fs.rm(path.join(directory, '.git'), { recursive: true, force: true });
  expect(
    await observeDelegationWorkspace(directory, new AbortController().signal),
  ).toMatchObject({ headRevision: null, dirty: null });
  const abort = new AbortController();
  abort.abort();
  expect(
    await observeDelegationWorkspace(directory, abort.signal),
  ).toMatchObject({ headRevision: null, dirty: null });
});

it('creates opt-in isolation from HEAD, retains dirty parent work, disables checkout filters and discards only the owned child', async () => {
  await fs.writeFile(
    path.join(directory, '.gitattributes'),
    'source.txt filter=untrusted\n',
  );
  await git(['add', '.gitattributes']);
  await git([
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'attributes',
  ]);
  const marker = path.join(directory, 'filter-ran');
  await git([
    'config',
    'filter.untrusted.smudge',
    'touch "' + marker + '"; cat',
  ]);
  await fs.writeFile(path.join(directory, 'source.txt'), 'dirty parent');
  const destination = path.join(directory, 'owned', 'child');
  const signal = new AbortController().signal;
  const isolated = await createIsolatedDelegationWorktree(
    directory,
    destination,
    signal,
  );
  expect(isolated.revision).toBe(await git(['rev-parse', 'HEAD']));
  expect(await fs.readFile(path.join(isolated.cwd, 'source.txt'), 'utf8')).toBe(
    'original',
  );
  await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  await fs.writeFile(path.join(isolated.cwd, 'source.txt'), 'child edit');
  await discardIsolatedDelegationWorktree(directory, isolated.cwd, signal);
  await expect(fs.access(isolated.cwd)).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await fs.readFile(path.join(directory, 'source.txt'), 'utf8')).toBe(
    'dirty parent',
  );
});

it("lists a delegate's changes without running repository filters or listing ignored files", async () => {
  await fs.writeFile(
    path.join(directory, '.gitattributes'),
    'source.txt filter=untrusted\n',
  );
  await fs.writeFile(path.join(directory, '.gitignore'), 'build/\n');
  await git(['add', '.gitattributes', '.gitignore']);
  await git([
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'attributes',
  ]);
  const marker = path.join(directory, 'filter-ran');
  const signal = new AbortController().signal;
  const isolated = await createIsolatedDelegationWorktree(
    directory,
    path.join(directory, 'owned', 'listing-child'),
    signal,
  );
  for (const key of ['clean', 'process'])
    await git([
      'config',
      `filter.untrusted.${key}`,
      'touch "' + marker + '"; cat',
    ]);
  await fs.writeFile(path.join(isolated.cwd, 'source.txt'), 'child edit');
  await fs.writeFile(path.join(isolated.cwd, 'added.txt'), 'child file');
  await fs.mkdir(path.join(isolated.cwd, 'build'));
  await fs.writeFile(path.join(isolated.cwd, 'build', 'out.txt'), 'ignored');

  const changes = await isolatedDelegationChanges(
    isolated.cwd,
    isolated.revision,
    signal,
  );
  expect(changes).toEqual([{ path: 'added.txt' }, { path: 'source.txt' }]);
  await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  await discardIsolatedDelegationWorktree(directory, isolated.cwd, signal);
});

it('disables filters activated only by linked-worktree conditional config', async () => {
  await fs.writeFile(
    path.join(directory, '.gitattributes'),
    'source.txt filter=conditional\n',
  );
  await git(['add', '.gitattributes']);
  await git([
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'conditional attributes',
  ]);
  const marker = path.join(directory, 'conditional-filter-ran');
  const conditionalConfig = path.join(directory, 'linked-worktree.config');
  // Git config treats `\` inside quoted values as an escape; the filter's
  // shell accepts `/` separators on every platform.
  await fs.writeFile(
    conditionalConfig,
    `[filter "conditional"]\n\tsmudge = touch "${marker.split(path.sep).join('/')}"; cat\n`,
  );
  await git([
    'config',
    '--local',
    'includeIf.gitdir:**/.git/worktrees/**.path',
    conditionalConfig,
  ]);
  const destination = path.join(directory, 'owned', 'conditional-child');

  try {
    await createIsolatedDelegationWorktree(
      directory,
      destination,
      new AbortController().signal,
    );
    await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await discardIsolatedDelegationWorktree(
      directory,
      destination,
      new AbortController().signal,
    ).catch(() => undefined);
  }
});

it('discards an isolated checkout without following a link it contains', async () => {
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), 'delegation-outside-'),
  );
  try {
    await fs.writeFile(path.join(outside, 'canary.txt'), 'keep');
    const signal = new AbortController().signal;
    const isolated = await createIsolatedDelegationWorktree(
      directory,
      path.join(directory, 'owned', 'linked-child'),
      signal,
    );
    // A delegated child can create a junction (Windows) or symlink inside its
    // own checkout. Removal must unlink it, never delete through it.
    await fs.symlink(
      outside,
      path.join(isolated.cwd, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await discardIsolatedDelegationWorktree(directory, isolated.cwd, signal);
    await expect(fs.access(isolated.cwd)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await fs.readFile(path.join(outside, 'canary.txt'), 'utf8')).toBe(
      'keep',
    );
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});

it('discards a checkout whose root was replaced by a link without removing through it', async () => {
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), 'delegation-outside-'),
  );
  try {
    await fs.writeFile(path.join(outside, 'canary.txt'), 'keep');
    const signal = new AbortController().signal;
    const isolated = await createIsolatedDelegationWorktree(
      directory,
      path.join(directory, 'owned', 'replaced-root'),
      signal,
    );
    // A delegated process swaps its own checkout root for a link.
    await fs.rm(isolated.cwd, { recursive: true, force: true });
    await fs.symlink(
      outside,
      isolated.cwd,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await discardIsolatedDelegationWorktree(directory, isolated.cwd, signal);
    await expect(fs.lstat(isolated.cwd)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await fs.readFile(path.join(outside, 'canary.txt'), 'utf8')).toBe(
      'keep',
    );
    expect(await git(['worktree', 'list', '--porcelain'])).not.toContain(
      'replaced-root',
    );
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});

it('fails closed before checkout when a filter name cannot be disabled safely', async () => {
  await fs.writeFile(
    path.join(directory, '.gitattributes'),
    'source.txt filter=a=b\n',
  );
  await git(['add', '.gitattributes']);
  await git([
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'ambiguous filter',
  ]);
  const marker = path.join(directory, 'ambiguous-filter-ran');
  await git(['config', 'filter.a=b.smudge', 'touch "' + marker + '"; cat']);
  const destination = path.join(directory, 'owned', 'ambiguous-filter-child');
  try {
    await expect(
      createIsolatedDelegationWorktree(
        directory,
        destination,
        new AbortController().signal,
      ),
    ).rejects.toThrow(
      'Unsupported repository filter configuration for isolated checkout',
    );
    await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await discardIsolatedDelegationWorktree(
      directory,
      destination,
      new AbortController().signal,
    ).catch(() => undefined);
  }
});

it('does not retain workspace metadata when isolated worktree creation fails', async () => {
  const destination = path.join(directory, 'owned', 'blocked-child');
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, 'occupied'), 'do not remove');
  const retain = jest.fn((): Promise<void> => Promise.resolve());
  await expect(
    createIsolatedDelegationWorktree(
      directory,
      destination,
      new AbortController().signal,
      retain,
    ),
  ).rejects.toThrow();
  expect(retain).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(destination, 'occupied'), 'utf8')).toBe(
    'do not remove',
  );
});

it('journals isolated workspace ownership before registering the worktree', async () => {
  const destination = path.join(directory, 'owned', 'journaled-child');
  const registeredWhenRetained: boolean[] = [];
  const retain = jest.fn(async (): Promise<void> => {
    // Git prints worktree paths with `/` on Windows; compare resolved paths.
    const listed = (await git(['worktree', 'list', '--porcelain']))
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => path.resolve(line.slice('worktree '.length)));
    const expected = path.resolve(
      await fs.realpath(path.dirname(destination)),
      path.basename(destination),
    );
    registeredWhenRetained.push(
      listed.some((entry) =>
        process.platform === 'win32'
          ? entry.toLowerCase() === expected.toLowerCase()
          : entry === expected,
      ),
    );
  });

  try {
    await createIsolatedDelegationWorktree(
      directory,
      destination,
      new AbortController().signal,
      retain,
    );
    expect(registeredWhenRetained).toEqual([false, true]);
  } finally {
    await discardIsolatedDelegationWorktree(
      directory,
      destination,
      new AbortController().signal,
    ).catch(() => undefined);
  }
});

it('reconciles only the exact journaled worktree after a creation crash', async () => {
  const destination = path.join(directory, 'owned', 'crashed-child');
  const revision = await git(['rev-parse', '--verify', 'HEAD']);
  await git([
    'worktree',
    'add',
    '--no-checkout',
    '--detach',
    '--',
    destination,
    revision,
  ]);

  await reconcileIsolatedDelegationWorktree(
    directory,
    destination,
    await fs.realpath(destination),
    revision,
  );

  expect(await git(['worktree', 'list', '--porcelain'])).not.toContain(
    destination,
  );
  await expect(fs.access(destination)).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(
    reconcileIsolatedDelegationWorktree(
      directory,
      destination,
      path.join(directory, 'not-owned'),
      revision,
    ),
  ).rejects.toThrow('ownership does not match');
});

const itWithPosixGitWrapper = process.platform === 'win32' ? it.skip : it;

itWithPosixGitWrapper(
  'retains the creation journal when registered-worktree cleanup fails',
  async () => {
    await fs.writeFile(
      path.join(directory, '.gitattributes'),
      'source.txt filter=a=b\n',
    );
    await git(['add', '.gitattributes']);
    await git([
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'cleanup failure fixture',
    ]);
    await git(['config', 'filter.a=b.smudge', 'cat']);
    const destination = path.join(directory, 'owned', 'cleanup-failed-child');
    const realGit = (await promisify(execFile)('which', ['git'])).stdout.trim();
    const wrapper = path.join(directory, 'failing-remove-git.sh');
    await fs.writeFile(
      wrapper,
      `#!/bin/sh\ncase " $* " in\n  *" worktree remove "*) exit 71 ;;\nesac\nexec "${realGit}" "$@"\n`,
      { mode: 0o700 },
    );
    const retained: Array<
      { cwd: string; revision: string; ready: boolean } | undefined
    > = [];
    const previousGit = process.env.CANOPY_GIT_EXECUTABLE;
    process.env.CANOPY_GIT_EXECUTABLE = wrapper;
    try {
      await expect(
        createIsolatedDelegationWorktree(
          directory,
          destination,
          new AbortController().signal,
          (workspace): Promise<void> => {
            retained.push(workspace);
            return Promise.resolve();
          },
        ),
      ).rejects.toThrow('Unsupported repository filter configuration');
      const journal = retained[retained.length - 1];
      if (!journal) throw new Error('Missing retained creation journal');
      expect(journal.cwd).toContain('cleanup-failed-child');
      expect(journal.ready).toBe(false);
      expect(await git(['worktree', 'list', '--porcelain'])).toContain(
        destination,
      );
    } finally {
      if (previousGit === undefined) delete process.env.CANOPY_GIT_EXECUTABLE;
      else process.env.CANOPY_GIT_EXECUTABLE = previousGit;
      await git(['worktree', 'remove', '--force', '--', destination]).catch(
        () => undefined,
      );
    }
  },
);

itWithPosixGitWrapper(
  'removes an unregistered partial directory before clearing its journal',
  async () => {
    const destination = path.join(directory, 'owned', 'partial-child');
    const realGit = (await promisify(execFile)('which', ['git'])).stdout.trim();
    const wrapper = path.join(directory, 'partial-add-git.sh');
    await fs.writeFile(
      wrapper,
      `#!/bin/sh\ncase " $* " in\n  *" worktree add "*) for last do :; done; mkdir -p "$last"; exit 72 ;;\nesac\nexec "${realGit}" "$@"\n`,
      { mode: 0o700 },
    );
    const retained: Array<
      { cwd: string; revision: string; ready: boolean } | undefined
    > = [];
    const previousGit = process.env.CANOPY_GIT_EXECUTABLE;
    process.env.CANOPY_GIT_EXECUTABLE = wrapper;
    try {
      await expect(
        createIsolatedDelegationWorktree(
          directory,
          destination,
          new AbortController().signal,
          (workspace): Promise<void> => {
            retained.push(workspace);
            return Promise.resolve();
          },
        ),
      ).rejects.toThrow('Isolated workspace operation failed');
      expect(retained[retained.length - 1]).toBeUndefined();
      await expect(fs.access(destination)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await git(['worktree', 'list', '--porcelain'])).not.toContain(
        destination,
      );
    } finally {
      if (previousGit === undefined) delete process.env.CANOPY_GIT_EXECUTABLE;
      else process.env.CANOPY_GIT_EXECUTABLE = previousGit;
      await fs.rm(destination, { recursive: true, force: true });
    }
  },
);

itWithPosixGitWrapper(
  'removes a newly registered worktree when cancellation wins before add resolves',
  async () => {
    const destination = path.join(directory, 'owned', 'cancelled-child');
    const realGit = (await promisify(execFile)('which', ['git'])).stdout.trim();
    const wrapper = path.join(directory, 'delayed-git.sh');
    // A child can keep stdout open after the Git wrapper exits. Cleanup must
    // read the complete worktree listing before removing the directory.
    await fs.writeFile(
      wrapper,
      `#!/bin/sh\ncase " $* " in\n  *" worktree list "*) (sleep 0.1; exec "${realGit}" "$@") & exit 0 ;;\nesac\n"${realGit}" "$@"\nstatus=$?\ncase " $* " in\n  *" worktree add "*) while :; do :; done ;;\nesac\nexit $status\n`,
      { mode: 0o700 },
    );
    const previousGit = process.env.CANOPY_GIT_EXECUTABLE;
    process.env.CANOPY_GIT_EXECUTABLE = wrapper;
    const controller = new AbortController();
    try {
      const creating = createIsolatedDelegationWorktree(
        directory,
        destination,
        controller.signal,
      );
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (
          (await git(['worktree', 'list', '--porcelain'])).includes(destination)
        )
          break;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      expect(await git(['worktree', 'list', '--porcelain'])).toContain(
        destination,
      );
      controller.abort();
      await expect(creating).rejects.toThrow();
      expect(await git(['worktree', 'list', '--porcelain'])).not.toContain(
        destination,
      );
      await expect(fs.access(destination)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      if (previousGit === undefined) delete process.env.CANOPY_GIT_EXECUTABLE;
      else process.env.CANOPY_GIT_EXECUTABLE = previousGit;
      await git(['worktree', 'remove', '--force', '--', destination]).catch(
        () => undefined,
      );
    }
  },
);

// The native file boundary runs on macOS and Windows.
const itWithDelegationFileBoundary =
  process.platform === 'darwin' || process.platform === 'win32' ? it : it.skip;

itWithDelegationFileBoundary.each([false, true])(
  'applies isolated changes with expected-content protection (conflicting parent: %s) and retains them until explicit discard',
  async (conflict) => {
    const data = path.join(directory, 'delegation');
    const childId = 'owned-child';
    const isolated = await createIsolatedDelegationWorktree(
      directory,
      path.join(data, 'worktrees', childId),
      new AbortController().signal,
    );
    await fs.writeFile(path.join(isolated.cwd, 'source.txt'), 'child edit');
    if (conflict)
      await fs.writeFile(path.join(directory, 'source.txt'), 'parent edit');
    await fs.writeFile(
      path.join(directory, 'unrelated.txt'),
      'unrelated dirty file',
    );
    const owner = ownerFixture();
    const record = recordFixture({
      childId,
      executionCwd: isolated.cwd,
      revision: isolated.revision,
    });
    const hooks = recordingHooks();
    const options = {
      record,
      operation: 'apply' as const,
      directory: data,
      owner: (): AgentSessionOptions => owner,
      getWindow: (): null => null,
      signal: new AbortController().signal,
      hooks,
    };
    if (conflict) {
      await expect(
        manageIsolatedDelegationWorkspace(options),
      ).rejects.toThrow();
      expect(hooks.commits).toEqual([]);
    } else {
      await manageIsolatedDelegationWorkspace(options);
      expect(hooks.commits).toEqual([
        [appliedFile('source.txt', 'child edit')],
      ]);
      // A committed receipt makes a repeated explicit application a no-op,
      // even after the parent edits the file again.
      await fs.writeFile(path.join(directory, 'source.txt'), 'later edit');
      await manageIsolatedDelegationWorkspace({
        ...options,
        record: { ...record, appliedFiles: hooks.commits[0] },
      });
      expect(hooks.commits).toHaveLength(1);
      await fs.writeFile(path.join(directory, 'source.txt'), 'child edit');
    }
    expect(await fs.readFile(path.join(directory, 'source.txt'), 'utf8')).toBe(
      conflict ? 'parent edit' : 'child edit',
    );
    expect(
      await fs.readFile(path.join(isolated.cwd, 'source.txt'), 'utf8'),
    ).toBe('child edit');
    await manageIsolatedDelegationWorkspace({
      ...options,
      operation: 'discard',
    });
    await expect(fs.access(isolated.cwd)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      await fs.readFile(path.join(directory, 'unrelated.txt'), 'utf8'),
    ).toBe('unrelated dirty file');
  },
);

itWithDelegationFileBoundary(
  'applies changes the delegate committed in its own worktree',
  async () => {
    const data = path.join(directory, 'delegation');
    const childId = 'committed-child';
    const isolated = await createIsolatedDelegationWorktree(
      directory,
      path.join(data, 'worktrees', childId),
      new AbortController().signal,
    );
    await fs.writeFile(path.join(isolated.cwd, 'source.txt'), 'child edit');
    await fs.writeFile(path.join(isolated.cwd, 'added.txt'), 'child file');
    const childGit = (args: string[]): Promise<unknown> =>
      promisify(execFile)('git', args, { cwd: isolated.cwd, timeout: 10_000 });
    await childGit(['add', 'source.txt', 'added.txt']);
    await childGit([
      '-c',
      'user.name=Delegate',
      '-c',
      'user.email=delegate@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'child commit',
    ]);
    const hooks = recordingHooks();
    await manageIsolatedDelegationWorkspace({
      record: recordFixture({
        childId,
        executionCwd: isolated.cwd,
        revision: isolated.revision,
      }),
      operation: 'apply',
      directory: data,
      owner: ownerFixture,
      getWindow: (): null => null,
      signal: new AbortController().signal,
      hooks,
    });
    expect(await fs.readFile(path.join(directory, 'source.txt'), 'utf8')).toBe(
      'child edit',
    );
    expect(await fs.readFile(path.join(directory, 'added.txt'), 'utf8')).toBe(
      'child file',
    );
    expect(hooks.commits).toEqual([
      [
        appliedFile('added.txt', 'child file'),
        appliedFile('source.txt', 'child edit'),
      ],
    ]);
  },
);

itWithDelegationFileBoundary(
  'stops isolated apply when the parent session approval rules drift',
  async () => {
    const data = path.join(directory, 'delegation');
    const childId = 'rule-drift-child';
    await commitBase({ 'second.txt': 'before' });
    const isolated = await createIsolatedDelegationWorktree(
      directory,
      path.join(data, 'worktrees', childId),
      new AbortController().signal,
    );
    await fs.writeFile(path.join(isolated.cwd, 'source.txt'), 'first child');
    await fs.writeFile(path.join(isolated.cwd, 'second.txt'), 'second child');
    const owner = ownerFixture();
    owner.sessionApprovalRules = [];
    mockApprovalCheck = (): Promise<{ decision: string }> => {
      owner.sessionApprovalRules?.push({
        id: 'new-session-rule',
        behavior: 'allow',
        target: { kind: 'file-write', path: directory },
        createdAt: '2026-09-15T00:00:00.000Z',
        origin: 'prompt',
      });
      return Promise.resolve({ decision: 'allow' });
    };
    const hooks = recordingHooks();

    await expect(
      manageIsolatedDelegationWorkspace({
        record: recordFixture({
          childId,
          executionCwd: isolated.cwd,
          revision: isolated.revision,
        }),
        operation: 'apply',
        directory: data,
        owner: (): AgentSessionOptions => owner,
        getWindow: (): null => null,
        signal: new AbortController().signal,
        hooks,
      }),
    ).rejects.toMatchObject({
      failure: {
        reason: 'approval_denied',
        issues: [{ path: 'second.txt', reason: 'approval_denied' }],
      },
    });
    expect(hooks.commits).toEqual([]);
    expect(await fs.readFile(path.join(directory, 'source.txt'), 'utf8')).toBe(
      'original',
    );
    expect(await fs.readFile(path.join(directory, 'second.txt'), 'utf8')).toBe(
      'before',
    );
  },
);

itWithDelegationFileBoundary(
  'stops isolated apply when the parent approval mode changes during approval',
  async () => {
    const data = path.join(directory, 'delegation');
    const childId = 'approval-mode-drift-child';
    const isolated = await createIsolatedDelegationWorktree(
      directory,
      path.join(data, 'worktrees', childId),
      new AbortController().signal,
    );
    await fs.writeFile(path.join(isolated.cwd, 'source.txt'), 'child edit');
    const owner = ownerFixture();
    mockApprovalCheck = (): Promise<{ decision: string }> => {
      owner.approvalMode = 'ask';
      return Promise.resolve({ decision: 'allow' });
    };

    await expect(
      manageIsolatedDelegationWorkspace({
        record: recordFixture({
          childId,
          executionCwd: isolated.cwd,
          revision: isolated.revision,
        }),
        operation: 'apply',
        directory: data,
        owner: (): AgentSessionOptions => owner,
        getWindow: (): null => null,
        signal: new AbortController().signal,
        hooks: recordingHooks(),
      }),
    ).rejects.toMatchObject({
      failure: {
        reason: 'approval_denied',
        issues: [{ path: 'source.txt', reason: 'approval_denied' }],
      },
    });
    expect(await fs.readFile(path.join(directory, 'source.txt'), 'utf8')).toBe(
      'original',
    );
  },
);

itWithDelegationFileBoundary(
  'stops isolated apply when persisted approval rules change during approval',
  async () => {
    const data = path.join(directory, 'delegation');
    const childId = 'persisted-rule-drift-child';
    const isolated = await createIsolatedDelegationWorktree(
      directory,
      path.join(data, 'worktrees', childId),
      new AbortController().signal,
    );
    await fs.writeFile(path.join(isolated.cwd, 'source.txt'), 'child edit');
    mockApprovalCheck = (): Promise<{ decision: string }> => {
      mockApprovalPolicyContextKey = 'policy:1:0';
      return Promise.resolve({ decision: 'allow' });
    };
    const hooks = recordingHooks();

    await expect(
      manageIsolatedDelegationWorkspace({
        record: recordFixture({
          childId,
          executionCwd: isolated.cwd,
          revision: isolated.revision,
        }),
        operation: 'apply',
        directory: data,
        owner: ownerFixture,
        getWindow: (): null => null,
        signal: new AbortController().signal,
        hooks,
      }),
    ).rejects.toMatchObject({ failure: { reason: 'approval_denied' } });
    expect(hooks.commits).toEqual([]);
    expect(await fs.readFile(path.join(directory, 'source.txt'), 'utf8')).toBe(
      'original',
    );
  },
);

itWithDelegationFileBoundary.each([
  'plan mode',
  'session rules',
  'approval mode',
] as const)(
  'refuses isolated discard when parent %s changes during approval',
  async (policy) => {
    const data = path.join(directory, 'delegation');
    const childId = `discard-${policy.replace(' ', '-')}-child`;
    const isolated = await createIsolatedDelegationWorktree(
      directory,
      path.join(data, 'worktrees', childId),
      new AbortController().signal,
    );
    const owner = ownerFixture();
    owner.sessionApprovalRules = [];
    mockApprovalCheck = (): Promise<{ decision: string }> => {
      if (policy === 'plan mode') owner.planMode = true;
      else if (policy === 'approval mode') owner.approvalMode = 'ask';
      else
        owner.sessionApprovalRules?.push({
          id: 'new-discard-rule',
          behavior: 'deny',
          target: { kind: 'file-write', path: isolated.cwd },
          createdAt: '2026-09-15T00:00:00.000Z',
          origin: 'prompt',
        });
      return Promise.resolve({ decision: 'allow' });
    };

    await expect(
      manageIsolatedDelegationWorkspace({
        record: recordFixture({
          childId,
          executionCwd: isolated.cwd,
          revision: isolated.revision,
        }),
        operation: 'discard',
        directory: data,
        owner: (): AgentSessionOptions => owner,
        getWindow: (): null => null,
        signal: new AbortController().signal,
        hooks: recordingHooks(),
      }),
    ).rejects.toThrow('Discard was not authorized');
    await expect(fs.access(isolated.cwd)).resolves.toBeUndefined();
  },
);

itWithDelegationFileBoundary(
  'applies more than 64 explicitly approved changes in one batch',
  async () => {
    const data = path.join(directory, 'delegation');
    const childId = 'large-apply-child';
    const files = Array.from(
      { length: 65 },
      (_, index) => `batch-${index}.txt`,
    );
    await commitBase(Object.fromEntries(files.map((file) => [file, 'before'])));
    const isolated = await createIsolatedDelegationWorktree(
      directory,
      path.join(data, 'worktrees', childId),
      new AbortController().signal,
    );
    for (const file of files)
      await fs.writeFile(path.join(isolated.cwd, file), 'after');
    const hooks = recordingHooks();
    await manageIsolatedDelegationWorkspace({
      record: recordFixture({
        childId,
        executionCwd: isolated.cwd,
        revision: isolated.revision,
      }),
      operation: 'apply',
      directory: data,
      owner: ownerFixture,
      getWindow: (): null => null,
      signal: new AbortController().signal,
      hooks,
    });
    // One journal before the writes; one atomic commit after all of them.
    expect(hooks.journals).toHaveLength(1);
    expect(hooks.commits).toEqual([
      [...files].sort().map((file) => appliedFile(file, 'after')),
    ]);
    expect(
      await fs.readFile(path.join(directory, 'batch-64.txt'), 'utf8'),
    ).toBe('after');
  },
);

describe('isolated apply atomicity', () => {
  const parentText = (file: string): Promise<string> =>
    fs.readFile(path.join(directory, file), 'utf8');
  /** An isolated child of the committed parent, with `files` edited in its
   * worktree. `base` is committed first, as the child's starting copy. */
  async function isolatedChild(
    childId: string,
    files: Record<string, string>,
    base: Record<string, string> = {},
  ): Promise<{ data: string; cwd: string; record: StoredDelegation }> {
    if (Object.keys(base).length) await commitBase(base);
    const data = path.join(directory, 'delegation');
    const isolated = await createIsolatedDelegationWorktree(
      directory,
      path.join(data, 'worktrees', childId),
      new AbortController().signal,
    );
    for (const [file, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(isolated.cwd, file)), {
        recursive: true,
      });
      await fs.writeFile(path.join(isolated.cwd, file), text);
    }
    return {
      data,
      cwd: isolated.cwd,
      record: recordFixture({
        childId,
        executionCwd: isolated.cwd,
        revision: isolated.revision,
      }),
    };
  }
  function applyOptions(
    data: string,
    record: StoredDelegation,
    hooks: DelegationWorkspaceHooks = recordingHooks(),
    signal = new AbortController().signal,
  ): Parameters<typeof manageIsolatedDelegationWorkspace>[0] {
    return {
      record,
      operation: 'apply',
      directory: data,
      owner: ownerFixture,
      getWindow: (): null => null,
      signal,
      hooks,
    };
  }

  itWithDelegationFileBoundary(
    'applies nothing when a later change conflicts with the parent',
    async () => {
      const childId = 'atomic-conflict-child';
      const { data, record } = await isolatedChild(
        childId,
        { 'source.txt': 'first child', 'second.txt': 'second child\n' },
        { 'second.txt': 'base\n' },
      );
      await fs.writeFile(path.join(directory, 'second.txt'), 'parent edit\n');
      const hooks = recordingHooks();

      await expect(
        manageIsolatedDelegationWorkspace(applyOptions(data, record, hooks)),
      ).rejects.toThrow();
      expect(hooks.commits).toEqual([]);
      expect(hooks.journals).toEqual([]);
      expect(await parentText('source.txt')).toBe('original');
      expect(await parentText('second.txt')).toBe('parent edit\n');
    },
  );

  itWithDelegationFileBoundary(
    'reports every blocked file with its reason and the parent change',
    async () => {
      const childId = 'atomic-report-child';
      const { data, record } = await isolatedChild(
        childId,
        {
          'source.txt': 'first child',
          'second.txt': 'base\nsecond child\n',
          '.env.local': 'TOKEN=1\n',
          'outside.txt': 'not granted\n',
        },
        { 'second.txt': 'base\n' },
      );
      await fs.writeFile(
        path.join(directory, 'second.txt'),
        'base\nparent edit\n',
      );

      const pending = manageIsolatedDelegationWorkspace(
        applyOptions(data, {
          ...record,
          task: {
            ...record.task,
            permissions: {
              writePaths: ['source.txt', 'second.txt', '.env.local'],
            },
          },
        }),
      );
      const mentionsFollowUp: unknown = expect.stringContaining('follow_up');
      await expect(pending).rejects.toMatchObject({
        message:
          'Nothing was applied: .env.local is a protected file (and 2 more files).',
        failure: {
          reason: 'conflict',
          issues: [
            { path: '.env.local', reason: 'protected_path' },
            { path: 'outside.txt', reason: 'outside_write_grant' },
            {
              path: 'second.txt',
              reason: 'parent_changed',
              parentDiff: [
                '--- delegate/second.txt',
                '+++ parent/second.txt',
                '@@ -1,1 +1,2 @@',
                ' base',
                '+parent edit',
                '',
              ].join('\n'),
            },
          ],
          guidance: mentionsFollowUp,
        },
      });
      expect(await parentText('source.txt')).toBe('original');
    },
  );

  itWithDelegationFileBoundary(
    'reports binary and oversized parent files without reading them into the report',
    async () => {
      const childId = 'atomic-unreadable-child';
      const { data, record } = await isolatedChild(
        childId,
        { 'binary.dat': 'child text', 'large.txt': 'child text' },
        { 'binary.dat': 'base', 'large.txt': 'base' },
      );
      await fs.writeFile(
        path.join(directory, 'binary.dat'),
        Buffer.from([0, 1, 2]),
      );
      // One byte over the 32 MiB apply bound.
      await fs.writeFile(
        path.join(directory, 'large.txt'),
        Buffer.alloc(33_554_433, 'x'),
      );

      const error = await applyFailure(
        manageIsolatedDelegationWorkspace(applyOptions(data, record)),
      );
      expect(error.failure.issues).toEqual([
        { path: 'binary.dat', reason: 'not_text' },
        { path: 'large.txt', reason: 'too_large' },
      ]);
    },
  );

  itWithDelegationFileBoundary(
    'applies an isolated edit to a tracked file larger than 64 KiB',
    async () => {
      const base = `${'base line\n'.repeat(10_000)}`;
      await fs.writeFile(path.join(directory, 'large.txt'), base);
      await git(['add', 'large.txt']);
      await git([
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'large fixture',
      ]);
      const childId = 'large-file-child';
      const edited = `${base}child line\n`;
      const { data, record } = await isolatedChild(childId, {
        'large.txt': edited,
      });
      const hooks = recordingHooks();

      await manageIsolatedDelegationWorkspace(
        applyOptions(data, record, hooks),
      );
      expect(await parentText('large.txt')).toBe(edited);
      expect(hooks.journals).toHaveLength(1);
    },
  );

  itWithDelegationFileBoundary(
    'compares the parent with the checked-out starting copy, line endings included',
    async () => {
      await commitBase({ '.gitattributes': '*.txt text eol=crlf\n' });
      await commitBase({ 'crlf.txt': 'one\ntwo\n' });
      // The parent's checkout and the delegate's both use CRLF.
      await git(['rm', '--cached', '-q', 'crlf.txt']);
      await git(['add', 'crlf.txt']);
      await fs.rm(path.join(directory, 'crlf.txt'));
      await git(['checkout', '--', 'crlf.txt']);
      expect(await parentText('crlf.txt')).toBe('one\r\ntwo\r\n');
      const childId = 'crlf-child';
      const { data, record } = await isolatedChild(childId, {
        'crlf.txt': 'one\r\ntwo\r\nthree\r\n',
      });
      const hooks = recordingHooks();

      await manageIsolatedDelegationWorkspace(
        applyOptions(data, record, hooks),
      );
      expect(await parentText('crlf.txt')).toBe('one\r\ntwo\r\nthree\r\n');
    },
  );

  itWithDelegationFileBoundary(
    'writes back a file the delegate reverted after an earlier apply',
    async () => {
      const childId = 'revert-child';
      const { data, cwd, record } = await isolatedChild(childId, {
        'source.txt': 'child edit',
      });
      const hooks = recordingHooks();
      await manageIsolatedDelegationWorkspace(
        applyOptions(data, record, hooks),
      );
      expect(await parentText('source.txt')).toBe('child edit');
      const applied = hooks.commits[0];
      if (!applied) throw new Error('Expected the first apply to record');

      // A follow-up run undoes the edit; Git no longer lists the file.
      await fs.writeFile(path.join(cwd, 'source.txt'), 'original');
      await manageIsolatedDelegationWorkspace(
        applyOptions(data, { ...record, appliedFiles: applied }, hooks),
      );
      expect(await parentText('source.txt')).toBe('original');
      // Back at its starting copy, the file needs no receipt.
      expect(hooks.commits[1]).toEqual([]);
    },
  );

  itWithDelegationFileBoundary(
    'restores written files when the policy changes after the apply is journaled',
    async () => {
      const childId = 'revoked-child';
      const { data, record } = await isolatedChild(
        childId,
        { 'source.txt': 'first child', 'zsecond.txt': 'second child' },
        { 'zsecond.txt': 'before' },
      );
      const owner = ownerFixture();
      const hooks = recordingHooks(() => {
        owner.planMode = true;
        return Promise.resolve();
      });

      await expect(
        manageIsolatedDelegationWorkspace({
          ...applyOptions(data, record, hooks),
          owner: (): AgentSessionOptions => owner,
        }),
      ).rejects.toMatchObject({ failure: { reason: 'approval_denied' } });
      expect(await parentText('source.txt')).toBe('original');
      expect(await parentText('zsecond.txt')).toBe('before');
      expect(hooks.commits).toEqual([]);
      expect(hooks.journals.at(-1)).toBeUndefined();
    },
  );

  itWithDelegationFileBoundary(
    'keeps stored content while the journal clear is not durable',
    async () => {
      const childId = 'unclear-child';
      const { data, record } = await isolatedChild(
        childId,
        { 'source.txt': 'first child', 'zlocked/second.txt': 'second child' },
        { 'zlocked/second.txt': 'before' },
      );
      const locked = path.join(directory, 'zlocked');
      await fs.chmod(locked, 0o555);
      const hooks = {
        ...recordingHooks(),
        journal: (
          journal: Omit<DelegationApplyJournal, 'operationId'> | undefined,
        ): Promise<void> =>
          journal
            ? Promise.resolve()
            : Promise.reject(new Error('journal clear failed')),
      };
      try {
        await expect(
          manageIsolatedDelegationWorkspace(applyOptions(data, record, hooks)),
        ).rejects.toMatchObject({ failure: { reason: 'write_failed' } });
        expect(await parentText('source.txt')).toBe('original');
        // The record may still hold the journal, so its content stays.
        expect(
          await fs.readdir(path.join(data, 'apply-journal', childId)),
        ).toHaveLength(1);
      } finally {
        await fs.chmod(locked, 0o755);
      }
    },
  );

  itWithDelegationFileBoundary(
    'restores files it already wrote when a later write fails',
    async () => {
      const childId = 'atomic-rollback-child';
      const { data, record } = await isolatedChild(
        childId,
        { 'source.txt': 'first child', 'zlocked/second.txt': 'second child' },
        { 'zlocked/second.txt': 'before' },
      );
      const locked = path.join(directory, 'zlocked');
      // Reads still succeed; staging the replacement in this directory fails.
      await fs.chmod(locked, 0o555);
      const hooks = recordingHooks();
      try {
        await expect(
          manageIsolatedDelegationWorkspace(applyOptions(data, record, hooks)),
        ).rejects.toMatchObject({
          failure: {
            reason: 'write_failed',
            issues: [{ path: 'zlocked/second.txt', reason: 'write_failed' }],
          },
        });
        expect(await parentText('source.txt')).toBe('original');
        expect(await parentText('zlocked/second.txt')).toBe('before');
        // Journaled before the first write, cleared once both were restored.
        const storeRoot = path.join(data, 'apply-journal', childId);
        const inStoreRoot: unknown = expect.stringContaining(storeRoot);
        expect(hooks.journals).toEqual([
          {
            root: await fs.realpath(directory),
            store: inStoreRoot,
            files: [
              {
                path: 'source.txt',
                beforeBlob: blobId('original'),
                afterBlob: blobId('first child'),
              },
              {
                path: 'zlocked/second.txt',
                beforeBlob: blobId('before'),
                afterBlob: blobId('second child'),
              },
            ],
          },
          undefined,
        ]);
        expect(hooks.commits).toEqual([]);
        // The restored apply leaves no stored content behind.
        expect(await fs.readdir(storeRoot)).toEqual([]);
      } finally {
        await fs.chmod(locked, 0o755);
      }
    },
  );

  itWithDelegationFileBoundary(
    'writes nothing when a later approval is denied',
    async () => {
      const childId = 'atomic-denied-child';
      const { data, record } = await isolatedChild(
        childId,
        { 'source.txt': 'first child', 'third.txt': 'third child' },
        { 'third.txt': 'before' },
      );
      mockApprovalCheck = (check): Promise<{ decision: string }> =>
        Promise.resolve({
          decision: check.path?.endsWith('third.txt') ? 'deny' : 'allow',
        });
      const hooks = recordingHooks();

      await expect(
        manageIsolatedDelegationWorkspace(applyOptions(data, record, hooks)),
      ).rejects.toMatchObject({
        message:
          "Nothing was applied: the change to third.txt wasn't approved.",
        failure: {
          reason: 'approval_denied',
          issues: [{ path: 'third.txt', reason: 'approval_denied' }],
        },
      });
      expect(hooks.journals).toEqual([]);
      expect(await parentText('source.txt')).toBe('original');
      expect(await parentText('third.txt')).toBe('before');
    },
  );

  itWithDelegationFileBoundary(
    'journals every write before the first parent file changes',
    async () => {
      const childId = 'atomic-journal-child';
      const { data, record } = await isolatedChild(childId, {
        'source.txt': 'first child',
        'created.txt': 'created by child',
      });
      const seenAtJournal: Array<{ source: string; created: boolean }> = [];
      const hooks = recordingHooks(async () => {
        seenAtJournal.push({
          source: await parentText('source.txt'),
          created: await fs.access(path.join(directory, 'created.txt')).then(
            () => true,
            () => false,
          ),
        });
      });

      await manageIsolatedDelegationWorkspace(
        applyOptions(data, record, hooks),
      );
      expect(seenAtJournal).toEqual([{ source: 'original', created: false }]);
      expect(hooks.journals).toHaveLength(1);
      // The applied journal's stored content is removed with it.
      expect(
        await fs.readdir(path.join(data, 'apply-journal', childId)),
      ).toEqual([]);
      expect(hooks.commits).toEqual([
        [
          appliedFile('created.txt', 'created by child'),
          appliedFile('source.txt', 'first child'),
        ],
      ]);
      expect(await parentText('source.txt')).toBe('first child');
      expect(await parentText('created.txt')).toBe('created by child');
    },
  );

  itWithDelegationFileBoundary(
    'writes nothing and clears its journal when cancelled before the first write',
    async () => {
      const childId = 'atomic-cancel-child';
      const { data, record } = await isolatedChild(childId, {
        'source.txt': 'first child',
      });
      const controller = new AbortController();
      const hooks = recordingHooks(() => {
        controller.abort();
        return Promise.resolve();
      });

      await expect(
        manageIsolatedDelegationWorkspace(
          applyOptions(data, record, hooks, controller.signal),
        ),
      ).rejects.toMatchObject({ failure: { reason: 'cancelled' } });
      expect(hooks.journals.at(-1)).toBeUndefined();
      expect(await parentText('source.txt')).toBe('original');
    },
  );

  itWithDelegationFileBoundary(
    'applies after the delegate reconciles a reported parent change',
    async () => {
      const childId = 'atomic-retry-child';
      const {
        data,
        cwd,
        record: firstRun,
      } = await isolatedChild(childId, {
        'source.txt': 'child edit',
      });
      await fs.writeFile(path.join(directory, 'source.txt'), 'parent edit');

      const reported = await applyFailure(
        manageIsolatedDelegationWorkspace(applyOptions(data, firstRun)),
      );
      const showsParentEdit: unknown = expect.stringContaining('+parent edit');
      expect(reported.failure).toMatchObject({
        reason: 'conflict',
        issues: [
          {
            path: 'source.txt',
            reason: 'parent_changed',
            parentDiff: showsParentEdit,
          },
        ],
      });
      expect(await parentText('source.txt')).toBe('parent edit');

      // Retrying before the delegate changes its copy still reports it.
      const unchanged = await applyFailure(
        manageIsolatedDelegationWorkspace(
          applyOptions(data, { ...firstRun, applyLeases: reported.leases }),
        ),
      );
      expect(unchanged.failure.issues).toMatchObject([
        { path: 'source.txt', reason: 'parent_changed' },
      ]);
      expect(await parentText('source.txt')).toBe('parent edit');

      // A follow-up run folds the parent's edit into the delegate's copy.
      await fs.writeFile(path.join(cwd, 'source.txt'), 'parent + child edit');
      const hooks = recordingHooks();
      await manageIsolatedDelegationWorkspace(
        applyOptions(
          data,
          { ...firstRun, applyLeases: unchanged.leases },
          hooks,
        ),
      );
      expect(await parentText('source.txt')).toBe('parent + child edit');
      expect(hooks.commits).toEqual([
        [appliedFile('source.txt', 'parent + child edit')],
      ]);
    },
  );

  itWithDelegationFileBoundary(
    'keeps a reported parent file that changed again before the retry',
    async () => {
      const childId = 'atomic-stale-lease-child';
      const { data, cwd, record } = await isolatedChild(childId, {
        'source.txt': 'child edit',
      });
      await fs.writeFile(path.join(directory, 'source.txt'), 'parent edit');
      const reported = await applyFailure(
        manageIsolatedDelegationWorkspace(applyOptions(data, record)),
      );
      await fs.writeFile(path.join(directory, 'source.txt'), 'newer parent');
      await fs.writeFile(path.join(cwd, 'source.txt'), 'merged');

      const retried = await applyFailure(
        manageIsolatedDelegationWorkspace(
          applyOptions(data, { ...record, applyLeases: reported.leases }),
        ),
      );
      const showsNewerEdit: unknown = expect.stringContaining('+newer parent');
      expect(retried.failure.issues).toMatchObject([
        {
          path: 'source.txt',
          reason: 'parent_changed',
          parentDiff: showsNewerEdit,
        },
      ]);
      expect(await parentText('source.txt')).toBe('newer parent');
    },
  );

  itWithDelegationFileBoundary(
    'applies a later delegate version over the one an earlier apply wrote',
    async () => {
      const childId = 'atomic-resume-child';
      const { data, record } = await isolatedChild(childId, {
        'source.txt': 'second version',
      });
      // The parent still holds what the earlier apply wrote.
      await fs.writeFile(path.join(directory, 'source.txt'), 'first version');
      const hooks = recordingHooks();

      await manageIsolatedDelegationWorkspace(
        applyOptions(
          data,
          {
            ...record,
            appliedFiles: [appliedFile('source.txt', 'first version')],
          },
          hooks,
        ),
      );
      expect(await parentText('source.txt')).toBe('second version');
      expect(hooks.commits).toEqual([
        [appliedFile('source.txt', 'second version')],
      ]);
    },
  );

  itWithDelegationFileBoundary(
    'reports a parent version the delegate never held as a conflict',
    async () => {
      const childId = 'atomic-unknown-version-child';
      const { data, record } = await isolatedChild(childId, {
        'source.txt': 'second version',
      });
      await fs.writeFile(path.join(directory, 'source.txt'), 'first version');

      const error = await applyFailure(
        manageIsolatedDelegationWorkspace(applyOptions(data, record)),
      );
      expect(error.failure.issues).toMatchObject([
        { path: 'source.txt', reason: 'parent_changed' },
      ]);
      expect(await parentText('source.txt')).toBe('first version');
    },
  );

  itWithDelegationFileBoundary(
    'leaves a parent file alone when the delegate undid its own edit',
    async () => {
      const childId = 'atomic-undo-child';
      const { data, cwd, record } = await isolatedChild(childId, {
        'source.txt': 'child edit',
      });
      // The delegate restores its starting copy byte for byte.
      await fs.writeFile(path.join(cwd, 'source.txt'), 'original');
      await fs.writeFile(path.join(directory, 'source.txt'), 'parent edit');
      const hooks = recordingHooks();

      await manageIsolatedDelegationWorkspace(
        applyOptions(data, record, hooks),
      );
      expect(await parentText('source.txt')).toBe('parent edit');
      expect(hooks.journals).toEqual([]);
      expect(hooks.commits).toEqual([]);
    },
  );

  itWithDelegationFileBoundary(
    'restores a journal left by an earlier failed restoration before applying',
    async () => {
      const childId = 'atomic-stale-journal-child';
      const { data, record } = await isolatedChild(childId, {
        'source.txt': 'first child',
      });
      await fs.writeFile(path.join(directory, 'second.txt'), 'stale write');
      const hooks = recordingHooks();

      // Written by an earlier version, which kept the text in the journal.
      await manageIsolatedDelegationWorkspace(
        applyOptions(
          data,
          {
            ...record,
            applyJournal: {
              operationId: '00000000-0000-4000-8000-000000000001',
              root: await fs.realpath(directory),
              files: [
                { path: 'second.txt', before: 'before', after: 'stale write' },
              ],
            },
          },
          hooks,
        ),
      );
      expect(await parentText('second.txt')).toBe('before');
      expect(await parentText('source.txt')).toBe('first child');
      expect(hooks.journals[0]).toBeUndefined();
      expect(hooks.commits).toEqual([
        [appliedFile('source.txt', 'first child')],
      ]);
    },
  );

  itWithDelegationFileBoundary(
    'keeps a refused restore journaled and blocks the next apply',
    async () => {
      const childId = 'refused-journal-child';
      const { data, record } = await isolatedChild(childId, {
        'source.txt': 'first child',
      });
      const locked = path.join(directory, 'locked');
      await fs.mkdir(locked);
      await fs.writeFile(path.join(locked, 'held.txt'), 'stale write');
      const refused = {
        path: 'locked/held.txt',
        before: 'before',
        after: 'stale write',
      };
      const hooks = recordingHooks();
      await fs.chmod(locked, 0o555);
      await fs.chmod(path.join(locked, 'held.txt'), 0o444);
      try {
        await expect(
          manageIsolatedDelegationWorkspace(
            applyOptions(
              data,
              {
                ...record,
                applyJournal: {
                  operationId: '00000000-0000-4000-8000-000000000003',
                  root: await fs.realpath(directory),
                  files: [refused],
                },
              },
              hooks,
            ),
          ),
        ).rejects.toMatchObject({
          failure: {
            issues: [{ path: 'locked/held.txt', reason: 'not_restored' }],
          },
        });
        // The refused entry stays journaled; the new apply wrote nothing.
        expect(hooks.journals).toEqual([
          { root: await fs.realpath(directory), files: [refused] },
        ]);
        expect(hooks.commits).toEqual([]);
        expect(await parentText('source.txt')).not.toBe('first child');

        const restored = await rollbackInterruptedDelegationApply(
          {
            operationId: '00000000-0000-4000-8000-000000000004',
            root: await fs.realpath(directory),
            files: [refused],
          },
          { directory: data, delegationId: childId },
        );
        expect(restored.pendingJournal).toEqual({
          operationId: '00000000-0000-4000-8000-000000000004',
          root: await fs.realpath(directory),
          files: [refused],
        });
      } finally {
        await fs.chmod(path.join(locked, 'held.txt'), 0o644);
        await fs.chmod(locked, 0o755);
      }
    },
  );

  itWithDelegationFileBoundary(
    "lists an isolated delegate's changes with diffs for display",
    async () => {
      const childId = 'listing-child';
      const { data, cwd, record } = await isolatedChild(
        childId,
        {
          'source.txt': 'child edit\n',
          'added.txt': 'new file\n',
          '.env.local': 'TOKEN=1\n',
        },
        { 'removed.txt': 'gone\n' },
      );
      await fs.rm(path.join(cwd, 'removed.txt'));
      const parentBefore = await parentText('source.txt');

      const changes = await readIsolatedDelegationChanges({
        directory: data,
        delegationId: childId,
        revision: record.isolationRevision ?? '',
        signal: new AbortController().signal,
      });
      expect(changes).toEqual({
        files: [
          // Protected: listed, never read.
          { path: '.env.local', change: 'added' },
          {
            path: 'added.txt',
            change: 'added',
            diff: '--- /dev/null\n+++ b/added.txt\n@@ -0,0 +1,1 @@\n+new file\n',
          },
          {
            path: 'removed.txt',
            change: 'deleted',
            diff: '--- a/removed.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone\n',
          },
          {
            path: 'source.txt',
            change: 'modified',
            diff: '--- a/source.txt\n+++ b/source.txt\n@@ -1,1 +1,1 @@\n-original\n+child edit\n',
          },
        ],
      });
      // Reading changes never touches the parent.
      expect(await parentText('source.txt')).toBe(parentBefore);
    },
  );

  itWithDelegationFileBoundary(
    'lists and applies added files with long non-ASCII paths',
    async () => {
      const childId = 'unicode-child';
      const name = (seed: string): string => seed.repeat(80);
      const files = Object.fromEntries(
        ['甲', '乙', '丙'].map((seed) => [
          `${name('目')}/${name(seed)}.txt`,
          `${seed} content\n`,
        ]),
      );
      // Apply writes files into directories the parent already has.
      const { data, record } = await isolatedChild(childId, files, {
        [`${name('目')}/keep.txt`]: 'keep\n',
      });

      const { files: listed } = await readIsolatedDelegationChanges({
        directory: data,
        delegationId: childId,
        revision: record.isolationRevision ?? '',
        signal: new AbortController().signal,
      });
      expect(listed.map(({ path: file, change }) => [file, change])).toEqual(
        Object.keys(files)
          .sort()
          .map((file) => [file, 'added']),
      );
      await manageIsolatedDelegationWorkspace(applyOptions(data, record));
      for (const [file, text] of Object.entries(files))
        expect(await parentText(file)).toBe(text);
    },
  );

  itWithDelegationFileBoundary(
    'reports a changed submodule commit instead of skipping it',
    async () => {
      const source = path.join(
        directory,
        '..',
        `${path.basename(directory)}-sub`,
      );
      const run = (cwd: string, args: string[]): Promise<string> =>
        promisify(execFile)('git', args, { cwd, timeout: 10_000 }).then(
          ({ stdout }) => stdout.trim(),
        );
      const commit = (message: string): Promise<string> =>
        run(source, [
          '-c',
          'user.name=Delegation Test',
          '-c',
          'user.email=delegation@example.test',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '--quiet',
          '--allow-empty',
          '-m',
          message,
        ]).then(() => run(source, ['rev-parse', 'HEAD']));
      await fs.mkdir(source);
      await run(source, ['init', '--quiet']);
      const first = await commit('first');
      const second = await commit('second');
      try {
        await git([
          '-c',
          'protocol.file.allow=always',
          'submodule',
          'add',
          '--quiet',
          source,
          'sub',
        ]);
        await run(path.join(directory, 'sub'), ['checkout', '--quiet', first]);
        await git(['add', 'sub']);
        await commitBase({});
        const childId = 'submodule-child';
        const { data, cwd, record } = await isolatedChild(childId, {});
        // The delegate records a different submodule commit.
        await run(cwd, ['update-index', '--cacheinfo', `160000,${second},sub`]);

        const { files } = await readIsolatedDelegationChanges({
          directory: data,
          delegationId: childId,
          revision: record.isolationRevision ?? '',
          signal: new AbortController().signal,
        });
        expect(files).toEqual(
          expect.arrayContaining([{ path: 'sub', change: 'modified' }]),
        );
        const error = await applyFailure(
          manageIsolatedDelegationWorkspace(applyOptions(data, record)),
        );
        expect(error.failure.issues).toEqual(
          expect.arrayContaining([{ path: 'sub', reason: 'not_regular_file' }]),
        );
      } finally {
        await fs.rm(source, { recursive: true, force: true });
      }
    },
  );

  itWithDelegationFileBoundary(
    'lists and applies edits to files the index marks unchanged',
    async () => {
      const childId = 'flagged-child';
      const { data, cwd, record } = await isolatedChild(
        childId,
        {},
        {
          'assumed.txt': 'assumed\n',
          'skipped.txt': 'skipped\n',
          'removed.txt': 'removed\n',
          'sparse.txt': 'sparse\n',
          'same.txt': 'same\n',
        },
      );
      const run = (args: string[]): Promise<unknown> =>
        promisify(execFile)('git', args, { cwd, timeout: 10_000 });
      await run([
        'update-index',
        '--assume-unchanged',
        'assumed.txt',
        'removed.txt',
        'same.txt',
      ]);
      await run([
        'update-index',
        '--skip-worktree',
        'skipped.txt',
        'sparse.txt',
      ]);
      await fs.writeFile(path.join(cwd, 'assumed.txt'), 'assumed edit\n');
      await fs.writeFile(path.join(cwd, 'skipped.txt'), 'skipped edit\n');
      await fs.rm(path.join(cwd, 'removed.txt'));
      // Sparse checkout leaves a skip-worktree file absent on purpose.
      await fs.rm(path.join(cwd, 'sparse.txt'));

      const { files } = await readIsolatedDelegationChanges({
        directory: data,
        delegationId: childId,
        revision: record.isolationRevision ?? '',
        signal: new AbortController().signal,
      });
      expect(files.map(({ path: file, change }) => [file, change])).toEqual([
        ['assumed.txt', 'modified'],
        ['removed.txt', 'deleted'],
        ['skipped.txt', 'modified'],
      ]);
      await manageIsolatedDelegationWorkspace(applyOptions(data, record));
      expect(await parentText('assumed.txt')).toBe('assumed edit\n');
      expect(await parentText('skipped.txt')).toBe('skipped edit\n');
      expect(await parentText('sparse.txt')).toBe('sparse\n');
      await expect(
        fs.access(path.join(directory, 'removed.txt')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  itWithDelegationFileBoundary(
    'never reads a delegate copy whose file cannot get a diff',
    async () => {
      const childId = 'unread-child';
      // Starting copies past the listing's checkout total get no diff.
      const big = (seed: string): string => seed.repeat(7 * 1024 * 1024);
      const { data, record } = await isolatedChild(
        childId,
        { 'a.txt': big('A'), 'b.txt': big('B'), 'c.txt': big('C') },
        { 'a.txt': big('a'), 'b.txt': big('b'), 'c.txt': big('c') },
      );
      const read = jest.spyOn(NativeDelegationFiles.prototype, 'read');
      try {
        const { files } = await readIsolatedDelegationChanges({
          directory: data,
          delegationId: childId,
          revision: record.isolationRevision ?? '',
          signal: new AbortController().signal,
        });
        expect(files.map(({ path: file, change }) => [file, change])).toEqual([
          ['a.txt', 'modified'],
          ['b.txt', 'modified'],
          ['c.txt', 'modified'],
        ]);
        expect(files[2]).not.toHaveProperty('diff');
        expect(read.mock.calls.map(([file]) => file)).not.toContain('c.txt');
      } finally {
        read.mockRestore();
      }
    },
  );

  itWithDelegationFileBoundary(
    'keeps showing diffs after one file reaches its own diff limit',
    async () => {
      const childId = 'listing-budget-child';
      const big = Array.from({ length: 4000 }, (_, i) => `line ${i}\n`).join(
        '',
      );
      const { data, record } = await isolatedChild(
        childId,
        {
          'a-large.txt': big.replace(/line/g, 'edit'),
          'b-small.txt': 'small child\n',
        },
        { 'a-large.txt': big, 'b-small.txt': 'small\n' },
      );

      const { files } = await readIsolatedDelegationChanges({
        directory: data,
        delegationId: childId,
        revision: record.isolationRevision ?? '',
        signal: new AbortController().signal,
      });
      expect(files[0]).toMatchObject({
        path: 'a-large.txt',
        diffTruncated: true,
      });
      expect(files[1]).toMatchObject({
        path: 'b-small.txt',
        diff: expect.stringContaining('+small child') as unknown,
      });
    },
  );

  itWithDelegationFileBoundary(
    'lists a change of hundreds of thousands of lines without failing',
    async () => {
      const childId = 'listing-huge-child';
      const lines = (prefix: string): string =>
        Array.from({ length: 200_000 }, (_, i) => `${prefix}${i}\n`).join('');
      const { data, record } = await isolatedChild(
        childId,
        { 'huge.txt': lines('b') },
        { 'huge.txt': lines('a') },
      );

      const { files } = await readIsolatedDelegationChanges({
        directory: data,
        delegationId: childId,
        revision: record.isolationRevision ?? '',
        signal: new AbortController().signal,
      });
      expect(files).toEqual([
        expect.objectContaining({
          path: 'huge.txt',
          change: 'modified',
          diffTruncated: true,
        }),
      ]);
    },
  );

  itWithDelegationFileBoundary(
    'never writes a starting copy over the per-file or total limit',
    async () => {
      const childId = 'limits-child';
      const { data, cwd, record } = await isolatedChild(
        childId,
        {},
        {
          'a.txt': 'aaaa',
          'b.txt': 'bbbbbbbbbb',
          'c.txt': 'cccc',
          'd.txt': 'dd',
        },
      );
      const bases = path.join(data, 'bases-under-test');
      await fs.mkdir(bases, { recursive: true });

      const entries = await materializeIsolatedDelegationBases(
        cwd,
        record.isolationRevision ?? '',
        ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'missing.txt'],
        bases,
        new AbortController().signal,
        { fileBytes: 8, totalBytes: 9 },
      );
      expect(Object.fromEntries(entries)).toEqual({
        'a.txt': { kind: 'file', size: 4, checkedOut: true },
        // Over the per-file limit.
        'b.txt': { kind: 'file', size: 10, checkedOut: false },
        'c.txt': { kind: 'file', size: 4, checkedOut: true },
        // Past the total.
        'd.txt': { kind: 'file', size: 2, checkedOut: false },
      });
      expect((await fs.readdir(path.join(bases, 'files'))).sort()).toEqual([
        'a.txt',
        'c.txt',
      ]);
    },
  );

  itWithDelegationFileBoundary(
    'restores an interrupted apply from its stored content and keeps it until the journal clears',
    async () => {
      const data = path.join(directory, 'delegation');
      const childId = 'stored-journal-child';
      const store = path.join(data, 'apply-journal', childId, 'operation');
      await fs.mkdir(store, { recursive: true });
      const large = 'large parent line\n'.repeat(10_000);
      for (const content of [large, 'child edit', 'new file'])
        await fs.writeFile(path.join(store, blobId(content)), content);
      await fs.writeFile(path.join(directory, 'source.txt'), 'child edit');
      await fs.writeFile(path.join(directory, 'created.txt'), 'new file');

      const restored = await rollbackInterruptedDelegationApply(
        {
          operationId: '00000000-0000-4000-8000-000000000005',
          root: await fs.realpath(directory),
          store,
          files: [
            {
              path: 'source.txt',
              beforeBlob: blobId(large),
              afterBlob: blobId('child edit'),
            },
            {
              path: 'created.txt',
              beforeBlob: null,
              afterBlob: blobId('new file'),
            },
          ],
        },
        { directory: data, delegationId: childId },
      );
      expect(await parentText('source.txt')).toBe(large);
      await expect(
        fs.access(path.join(directory, 'created.txt')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(restored.pendingJournal).toBeUndefined();
      expect(restored.failure).toMatchObject({
        reason: 'interrupted',
        issues: [],
      });
      // The record still refers to the store until the broker clears the
      // journal durably; the next apply or discard removes it.
      expect(
        await fs.readdir(path.join(data, 'apply-journal', childId)),
      ).toEqual(['operation']);
    },
  );

  itWithDelegationFileBoundary.each(['changed', 'outside'] as const)(
    'keeps a journal entry whose stored content is %s',
    async (problem) => {
      const data = path.join(directory, 'delegation');
      const childId = `${problem}-journal-child`;
      const owned = path.join(data, 'apply-journal', childId, 'operation');
      const store =
        problem === 'outside' ? path.join(directory, 'elsewhere') : owned;
      await fs.mkdir(store, { recursive: true });
      await fs.writeFile(
        path.join(store, blobId('original')),
        problem === 'changed' ? 'tampered' : 'original',
      );
      await fs.writeFile(path.join(store, blobId('child edit')), 'child edit');
      await fs.writeFile(path.join(directory, 'source.txt'), 'child edit');
      const journal = {
        operationId: '00000000-0000-4000-8000-000000000006',
        root: await fs.realpath(directory),
        store,
        files: [
          {
            path: 'source.txt',
            beforeBlob: blobId('original'),
            afterBlob: blobId('child edit'),
          },
        ],
      };

      const restored = await rollbackInterruptedDelegationApply(journal, {
        directory: data,
        delegationId: childId,
      });
      expect(await parentText('source.txt')).toBe('child edit');
      expect(restored.pendingJournal).toEqual(journal);
      expect(restored.failure.issues).toEqual([
        { path: 'source.txt', reason: 'not_restored' },
      ]);
      await expect(fs.readdir(store)).resolves.toHaveLength(2);
    },
  );

  itWithDelegationFileBoundary(
    'restores an interrupted apply from its journal and keeps later edits',
    async () => {
      await fs.writeFile(path.join(directory, 'source.txt'), 'child edit');
      await fs.writeFile(path.join(directory, 'second.txt'), 'someone else');
      await fs.writeFile(path.join(directory, 'third.txt'), 'before');
      await fs.writeFile(path.join(directory, 'created.txt'), 'new file');

      const restored = await rollbackInterruptedDelegationApply(
        {
          operationId: '00000000-0000-4000-8000-000000000002',
          root: await fs.realpath(directory),
          files: [
            { path: 'source.txt', before: 'original', after: 'child edit' },
            { path: 'second.txt', before: 'before', after: 'child second' },
            { path: 'third.txt', before: 'before', after: 'child third' },
            { path: 'created.txt', before: null, after: 'new file' },
          ],
        },
        {
          directory: path.join(directory, 'delegation'),
          delegationId: 'child',
        },
      );
      expect(await parentText('source.txt')).toBe('original');
      expect(await parentText('second.txt')).toBe('someone else');
      expect(await parentText('third.txt')).toBe('before');
      await expect(
        fs.access(path.join(directory, 'created.txt')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(restored).toMatchObject({
        message:
          'Nothing was applied: the app stopped during the apply, and second.txt kept newer changes.',
        failure: {
          reason: 'interrupted',
          issues: [{ path: 'second.txt', reason: 'not_restored' }],
        },
      });
    },
  );
});

it.each([40, 64])(
  'classifies a Git submodule batch reply with a %i-character object ID without reading its content',
  async (length) => {
    mockBatchCheckSubmoduleReply = `${'b'.repeat(length)} submodule\n`;
    const bases = path.join(directory, 'bases');
    await fs.mkdir(bases);
    const entries = await materializeIsolatedDelegationBases(
      directory,
      'a'.repeat(length),
      ['sub'],
      bases,
      new AbortController().signal,
      { fileBytes: 1024, totalBytes: 1024 },
    );
    expect(entries.get('sub')).toEqual({ kind: 'other' });
    expect(await fs.readdir(bases)).toEqual([]);
  },
);
