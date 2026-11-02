import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FAIL_CLOSED_MESSAGE } from '@canopy/protocol/approvals';
import type {
  ApprovalPromptDecision,
  ApprovalRule,
  ApprovalRuleScope,
} from '@canopy/desktop-shared/types';
import {
  createApprovalSession,
  type ApprovalSessionHandle,
} from '../approvals/approval-service';
import { DelegationNativePolicy } from '../agents/delegation/native-policy';
import { narrowsFileWriteRules } from '../approvals/rule-revisions';
import {
  addWorkspaceApprovalRule,
  getWorkspaceApprovalsFilePath,
  readWorkspaceApprovals,
  removeWorkspaceApprovalRule,
  writeWorkspaceApprovals,
} from '../lib/approvals-persistence';
import {
  flushPreferencesWrites,
  resetPreferencesLoadErrorForTests,
  updatePreferencesFile,
} from '../lib/preferences-store';
import { createPreferencesGenerationPath } from '../lib/preferences-file-paths';
import type * as paths from '../lib/paths';

let mockPreferencesPath: string;
jest.mock('../lib/paths', () => ({
  ...jest.requireActual<typeof paths>('../lib/paths'),
  getPreferencesFilePath: (): string => mockPreferencesPath,
}));

const mockRequestApprovalFromRenderer = jest.fn<
  Promise<ApprovalPromptDecision>,
  [unknown]
>();
jest.mock('../approvals/prompt-bridge', () => ({
  requestApprovalFromRenderer: (
    options: unknown,
  ): Promise<ApprovalPromptDecision> =>
    mockRequestApprovalFromRenderer(options),
}));

jest.mock('../observability', () => ({
  getObservabilityService: (): { recordSessionDiagnostic: () => void } => ({
    recordSessionDiagnostic: (): void => undefined,
  }),
}));

/**
 * CAN-4469 P4 and D-release against the real approvals and preferences
 * writers: no reader in the process applies a saved widening before it is
 * durable, a save in flight hides the rules it may remove, and Stop withdraws
 * only the action, never a rule whose save started.
 */
const WORKSPACE_ID = 'ws-durable-barrier';
const allowEcho: ApprovalRule = {
  id: 'allow-echo',
  behavior: 'allow',
  origin: 'prompt',
  createdAt: '2026-10-31T00:00:00.000Z',
  target: { kind: 'command', pattern: 'echo *' },
};
const denySourceWrites: ApprovalRule = {
  id: 'deny-source-writes',
  behavior: 'deny',
  origin: 'settings',
  createdAt: '2026-10-31T00:00:00.000Z',
  target: { kind: 'file-write', path: 'src/file.ts' },
};
const open = fs.open;
const rename = fs.rename;
const inheritedDataDir = process.env.CANOPY_DATA_DIR;
let root: string;
let dataRoot: string;
const sessions: ApprovalSessionHandle[] = [];
/** Released after each test, so a failure cannot leave a save held. */
const heldFlushReleases: Array<() => void> = [];

function session(
  chatId: string,
  workspaceRoot = dataRoot,
): ApprovalSessionHandle {
  const handle = createApprovalSession({
    sessionKey: `durable-barrier-${chatId}`,
    projectId: WORKSPACE_ID,
    worktreeId: 'wt-1',
    chatId,
    provider: 'claude',
    workspaceRoot,
    mode: 'ask',
    sessionRules: [],
    getWindow: () => null,
    trackChatTurn: false,
  });
  sessions.push(handle);
  return handle;
}

function evaluate(
  handle: ApprovalSessionHandle,
  command: string,
): Promise<string> {
  return (
    handle.evaluate?.({ kind: 'command', command }) ??
    Promise.resolve('missing')
  );
}

const workspaceFolder = (): string =>
  dirname(getWorkspaceApprovalsFilePath(WORKSPACE_ID));

/**
 * Holds the next flush of `folder`, the step that makes a save durable. With
 * `installed`, the first flush after `installed` is renamed into place.
 */
function holdNextFlushOf(
  folder: string,
  installed?: string,
): {
  reached: Promise<void>;
  release: () => void;
} {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let renamed = installed === undefined;
  const renameSpy = jest
    .spyOn(fs, 'rename')
    .mockImplementation(async (source, target) => {
      await rename(source, target);
      if (target === installed) renamed = true;
    });
  const spy = jest
    .spyOn(fs, 'open')
    .mockImplementation(async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      if (renamed && path === folder && (flags === 'r' || flags === 'r+')) {
        spy.mockRestore();
        renameSpy.mockRestore();
        const sync = handle.sync.bind(handle);
        handle.sync = async (): Promise<void> => {
          reached.resolve();
          await released.promise;
          return sync();
        };
      }
      return handle;
    });
  const release = (): void => released.resolve();
  heldFlushReleases.push(release);
  return { reached: reached.promise, release };
}

/**
 * Holds the next save of `scope`'s rules once its file is in place. A
 * preferences save refreshes last-good in the same folder off its write
 * queue, so that refresh lands first and the hold catches the save, not the
 * refresh.
 */
async function holdNextSaveOf(scope: 'project' | 'global'): Promise<{
  reached: Promise<void>;
  release: () => void;
}> {
  await flushPreferencesWrites();
  return scope === 'project'
    ? holdNextFlushOf(workspaceFolder())
    : holdNextFlushOf(root, mockPreferencesPath);
}

/** Holds a preferences save at its generation record, before main changes. */
async function holdNextGenerationRecord(): Promise<{
  reached: Promise<void>;
  release: () => void;
}> {
  await flushPreferencesWrites();
  return holdNextFlushOf(
    root,
    createPreferencesGenerationPath(mockPreferencesPath),
  );
}

function saveRules(
  scope: 'project' | 'global',
  rules: ApprovalRule[],
): Promise<unknown> {
  return scope === 'project'
    ? writeWorkspaceApprovals(WORKSPACE_ID, { version: 1, rules })
    : updatePreferencesFile(() => ({ globalApprovalRules: rules }));
}

/** A delegated child of the session's chat, writing inside `src`. */
function delegatedChild(
  approval: ApprovalSessionHandle,
  cwd: string,
  mode: 'ask' | 'full-access',
): DelegationNativePolicy {
  return new DelegationNativePolicy({
    cwd,
    writePaths: ['src'],
    mode: () => mode,
    signal: new AbortController().signal,
    delegationId: 'child',
    allowed: () => Promise.resolve(true),
    writable: () => true,
    approval,
    emit: () => Promise.resolve(),
  });
}

function settledFlag(promise: Promise<unknown>): () => boolean {
  let settled = false;
  void promise.finally(() => {
    settled = true;
  });
  return () => settled;
}

async function letPendingWorkRun(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The rules the scope's file holds on disk. */
async function savedRules(scope: ApprovalRuleScope): Promise<unknown> {
  const parsed: unknown = JSON.parse(
    await fs.readFile(
      scope === 'project'
        ? getWorkspaceApprovalsFilePath(WORKSPACE_ID)
        : mockPreferencesPath,
      'utf8',
    ),
  );
  if (!isRecord(parsed)) return undefined;
  if (scope === 'project') return parsed.rules;
  return isRecord(parsed.preferences)
    ? parsed.preferences.globalApprovalRules
    : undefined;
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'durable-barrier-prefs-'));
  dataRoot = await fs.mkdtemp(join(tmpdir(), 'durable-barrier-data-'));
  mockPreferencesPath = join(root, 'preferences.json');
  process.env.CANOPY_DATA_DIR = dataRoot;
  resetPreferencesLoadErrorForTests();
  mockRequestApprovalFromRenderer.mockReset();
  await fs.writeFile(
    mockPreferencesPath,
    JSON.stringify({ version: 1, preferences: { globalApprovalRules: [] } }),
  );
  await writeWorkspaceApprovals(WORKSPACE_ID, { version: 1, rules: [] });
});

afterEach(async () => {
  for (const release of heldFlushReleases.splice(0)) release();
  for (const handle of sessions.splice(0)) handle.dispose();
  // Lets a released workspace save finish before its folder is removed.
  await readWorkspaceApprovals(WORKSPACE_ID);
  await flushPreferencesWrites();
  jest.restoreAllMocks();
  resetPreferencesLoadErrorForTests();
  if (inheritedDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = inheritedDataDir;
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(dataRoot, { recursive: true, force: true });
});

describe('a rule save in flight', () => {
  it('stops a cached project allow from authorizing while its removal saves', async () => {
    await addWorkspaceApprovalRule(WORKSPACE_ID, allowEcho);
    const handle = session('chat-1');
    expect(await evaluate(handle, 'echo hi')).toBe('allow');

    const flush = holdNextFlushOf(workspaceFolder());
    const removal = removeWorkspaceApprovalRule(WORKSPACE_ID, allowEcho.id);
    await flush.reached;
    expect(await savedRules('project')).toEqual([]);
    const during = evaluate(handle, 'echo hi');
    const settled = settledFlag(during);
    await letPendingWorkRun();
    expect(settled()).toBe(false);

    flush.release();
    await removal;
    expect(await during).toBe('prompt');
  });

  it('stops a cached global allow from authorizing while its removal saves', async () => {
    await updatePreferencesFile(() => ({ globalApprovalRules: [allowEcho] }));
    const handle = session('chat-1');
    expect(await evaluate(handle, 'echo hi')).toBe('allow');

    const flush = await holdNextSaveOf('global');
    const removal = updatePreferencesFile(() => ({ globalApprovalRules: [] }));
    await flush.reached;
    expect(await savedRules('global')).toEqual([]);
    const during = evaluate(handle, 'echo hi');
    const settled = settledFlag(during);
    await letPendingWorkRun();
    expect(settled()).toBe(false);

    flush.release();
    await removal;
    expect(await during).toBe('prompt');
  });

  it('stops a cached global allow from authorizing while its removal records its generation (CAN-5154)', async () => {
    await updatePreferencesFile(() => ({ globalApprovalRules: [allowEcho] }));
    const handle = session('chat-1');
    expect(await evaluate(handle, 'echo hi')).toBe('allow');

    const flush = await holdNextGenerationRecord();
    const removal = updatePreferencesFile(() => ({ globalApprovalRules: [] }));
    await flush.reached;
    // Main is not replaced until the record is durable.
    expect(await savedRules('global')).toEqual([
      expect.objectContaining({ id: allowEcho.id }),
    ]);
    const during = evaluate(handle, 'echo hi');
    const settled = settledFlag(during);
    await letPendingWorkRun();
    expect(settled()).toBe(false);

    flush.release();
    await removal;
    expect(await during).toBe('prompt');
  });
});

describe('Stop during a remembered decision save (D-release)', () => {
  it.each([
    ['project', 'allow'],
    ['project', 'deny'],
    ['global', 'allow'],
    ['global', 'deny'],
  ] as const)(
    'keeps the %s %s rule, withdraws the action, and other chats use it once durable',
    async (scope, behavior) => {
      mockRequestApprovalFromRenderer.mockResolvedValueOnce({
        behavior,
        scope,
        target: { kind: 'command', pattern: 'echo *' },
      });
      const owner = session('chat-owner');
      const other = session('chat-other');
      expect(await evaluate(other, 'echo hi')).toBe('prompt');

      const flush = await holdNextSaveOf(scope);
      const ownerCheck = owner.check(
        { kind: 'command', command: 'echo hi' },
        {
          title: 'Run command',
          details: { kind: 'command', command: 'echo hi' },
        },
      );
      await flush.reached;
      // Not durable yet: the other chat neither applies the rule nor answers
      // from its cached tier.
      const otherDuring = evaluate(other, 'echo hi');
      const otherSettled = settledFlag(otherDuring);
      owner.invalidatePending?.();
      await letPendingWorkRun();
      expect(otherSettled()).toBe(false);
      flush.release();

      await expect(ownerCheck).resolves.toEqual({
        decision: 'deny',
        message: FAIL_CLOSED_MESSAGE,
      });
      expect(await otherDuring).toBe(behavior);
      expect(await evaluate(other, 'echo hi')).toBe(behavior);
      expect(await savedRules(scope)).toEqual([
        expect.objectContaining({
          behavior,
          target: { kind: 'command', pattern: 'echo *' },
        }),
      ]);
      // The owner's chat keeps the rule too, and is not asked again.
      expect(await evaluate(owner, 'echo hi')).toBe(behavior);
      expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(1);
    },
  );
});

describe('a save that may revoke a file-write grant', () => {
  const allowSource: ApprovalRule = {
    ...denySourceWrites,
    id: 'allow-source',
    behavior: 'allow',
  };
  it.each([
    ['drops a file-write allow', [allowSource], [], true],
    ['adds a file-write deny', [], [denySourceWrites], true],
    [
      'replaces a file-write allow by an equal one',
      [allowSource],
      [{ ...allowSource, id: 'again' }],
      false,
    ],
    ['adds a file-write allow', [], [allowSource], false],
    ['changes only command rules', [allowEcho], [], false],
    ['replaces an unknown file', undefined, [], true],
  ] as const)('%s: %s', (_case, previous, next, narrows) => {
    expect(narrowsFileWriteRules(previous, next)).toBe(narrows);
  });
});

describe('a delegated child while a restricting rule save is in flight', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), 'durable-barrier-child-')),
    );
    await fs.mkdir(join(cwd, 'src'));
    await fs.writeFile(join(cwd, 'src/file.ts'), 'before');
  });
  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it.each(['project', 'global'] as const)(
    'does not reuse an approval while the %s allow it rests on is being removed',
    async (scope) => {
      await saveRules(scope, [allowEcho]);
      const child = delegatedChild(session('chat-1', cwd), cwd, 'ask');
      // Claude's PreToolUse hook and canUseTool both ask about one call.
      const ask = (): Promise<boolean> =>
        child.authorize('Bash', { command: 'echo hi' }, 'call-1');
      await expect(ask()).resolves.toBe(true);

      const flush = await holdNextSaveOf(scope);
      const removal = saveRules(scope, []);
      await flush.reached;
      expect(await savedRules(scope)).toEqual([]);
      const during = ask();

      flush.release();
      await removal;
      await expect(during).resolves.toBe(false);
      await expect(ask()).resolves.toBe(false);
    },
  );

  it.each(['project', 'global'] as const)(
    'stops an open write profile while a %s deny inside its grant saves, and revokes it',
    async (scope) => {
      const child = delegatedChild(session('chat-1', cwd), cwd, 'full-access');
      await expect(child.prepareCodexSandboxWrites()).resolves.toEqual([
        join(cwd, 'src'),
      ]);
      expect(child.codexSandboxWritesNarrowing()).toBe(false);
      // The runner rechecks the grants at once when this key changes.
      const keyBefore = child.policyContextKey();

      const flush = await holdNextSaveOf(scope);
      const restriction = saveRules(scope, [denySourceWrites]);
      await flush.reached;
      // Native-safe commands write without asking, so the runner stops the
      // turn now rather than when the save settles.
      expect(child.codexSandboxWritesNarrowing()).toBe(true);
      expect(child.policyContextKey()).not.toBe(keyBefore);
      const keyDuring = child.policyContextKey();
      // The recheck does not answer from the tier the save is replacing.
      const recheck = child.codexSandboxWritesRevoked();
      const settled = settledFlag(recheck);
      await letPendingWorkRun();
      expect(settled()).toBe(false);

      flush.release();
      await restriction;
      expect(child.codexSandboxWritesNarrowing()).toBe(false);
      expect(child.policyContextKey()).not.toBe(keyDuring);
      await expect(recheck).resolves.toBe(true);
      await expect(child.prepareCodexSandboxWrites()).resolves.toEqual([]);
    },
  );

  it('stops an open write profile while a global deny records its generation (CAN-5154)', async () => {
    const child = delegatedChild(session('chat-1', cwd), cwd, 'full-access');
    await expect(child.prepareCodexSandboxWrites()).resolves.toEqual([
      join(cwd, 'src'),
    ]);
    const keyBefore = child.policyContextKey();

    const flush = await holdNextGenerationRecord();
    const restriction = saveRules('global', [denySourceWrites]);
    await flush.reached;
    expect(await savedRules('global')).toEqual([]);
    expect(child.codexSandboxWritesNarrowing()).toBe(true);
    expect(child.policyContextKey()).not.toBe(keyBefore);
    const keyDuring = child.policyContextKey();
    const recheck = child.codexSandboxWritesRevoked();
    const settled = settledFlag(recheck);
    await letPendingWorkRun();
    expect(settled()).toBe(false);

    flush.release();
    await restriction;
    expect(child.codexSandboxWritesNarrowing()).toBe(false);
    expect(child.policyContextKey()).not.toBe(keyDuring);
    await expect(recheck).resolves.toBe(true);
    await expect(child.prepareCodexSandboxWrites()).resolves.toEqual([]);
  });

  it('does not reuse an approval while the global allow it rests on records its removal (CAN-5154)', async () => {
    await saveRules('global', [allowEcho]);
    const child = delegatedChild(session('chat-1', cwd), cwd, 'ask');
    const ask = (): Promise<boolean> =>
      child.authorize('Bash', { command: 'echo hi' }, 'call-1');
    await expect(ask()).resolves.toBe(true);

    const flush = await holdNextGenerationRecord();
    const removal = saveRules('global', []);
    await flush.reached;
    expect(await savedRules('global')).toEqual([
      expect.objectContaining({ id: allowEcho.id }),
    ]);
    // Answered while the record is held: the key changed when the save began.
    const during = ask();
    await letPendingWorkRun();

    flush.release();
    await removal;
    await expect(during).resolves.toBe(false);
    await expect(ask()).resolves.toBe(false);
  });

  it.each(['project', 'global'] as const)(
    'leaves an open write profile running while a %s save only widens',
    async (scope) => {
      const child = delegatedChild(session('chat-1', cwd), cwd, 'full-access');
      await expect(child.prepareCodexSandboxWrites()).resolves.toEqual([
        join(cwd, 'src'),
      ]);

      const flush = await holdNextSaveOf(scope);
      const widening = saveRules(scope, [
        allowEcho,
        { ...denySourceWrites, id: 'allow-source', behavior: 'allow' },
      ]);
      await flush.reached;
      expect(child.codexSandboxWritesNarrowing()).toBe(false);

      flush.release();
      await widening;
      await expect(child.codexSandboxWritesRevoked()).resolves.toBe(false);
    },
  );
});
