import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as DirectoryFlush from '@canopy/core-platform/directory-flush';
import type {
  ApprovalCheck,
  ApprovalMode,
  ApprovalRule,
} from '@canopy/desktop-shared/types';
import {
  addWorkspaceApprovalRule,
  getWorkspaceApprovalsFilePath,
  writeWorkspaceApprovals,
} from '../../lib/approvals-persistence';
import { getPreferencesFilePath } from '../../lib/paths';
import { updatePreferencesFile } from '../../lib/preferences-store';
import { markGlobalApprovalRulesChanged } from '../rule-revisions';
import { createApprovalSession } from '../approval-service';
import { isApprovalPolicyWithin } from '../approval-policy-dominance';
import {
  effectiveApprovalPolicy,
  type ApprovalPolicySource,
} from '../effective-approval-policy';

const mockFlushDirectory = jest.fn<Promise<'flushed'>, [string]>();
jest.mock('@canopy/core-platform/directory-flush', () => {
  const actual = jest.requireActual<typeof DirectoryFlush>(
    '@canopy/core-platform/directory-flush',
  );
  return {
    ...actual,
    flushDirectory: (folder: string): Promise<'flushed'> =>
      mockFlushDirectory(folder),
  };
});
const { flushDirectory: realFlushDirectory } = jest.requireActual<
  typeof DirectoryFlush
>('@canopy/core-platform/directory-flush');

const WORKSPACE = 'ws-effective';
let base: string;
let repoA: string;
let repoB: string;

const rule = (
  behavior: 'allow' | 'deny',
  target: ApprovalRule['target'],
  id = `${behavior}-${JSON.stringify(target)}`,
): ApprovalRule => ({
  id,
  behavior,
  target,
  createdAt: '2026-01-01T00:00:00.000Z',
  origin: 'prompt',
});

const chat = (
  root: string,
  mode: ApprovalMode = 'ask',
  sessionRules: readonly ApprovalRule[] = [],
): ApprovalPolicySource => ({
  projectId: WORKSPACE,
  worktreeId: 'wt-1',
  mode,
  sessionRules,
  workspaceRoot: root,
});

/** What the chat's own approval session decides, without prompting. */
async function decides(
  source: ApprovalPolicySource,
  check: ApprovalCheck,
): Promise<string> {
  const session = createApprovalSession({
    sessionKey: `effective-${Math.random()}`,
    projectId: source.projectId,
    worktreeId: source.worktreeId,
    chatId: 'chat',
    provider: 'claude',
    workspaceRoot: source.workspaceRoot ?? '',
    mode: source.mode,
    sessionRules: [...source.sessionRules],
    getWindow: () => null,
    trackChatTurn: false,
  });
  try {
    return (await session.evaluate?.(check)) ?? 'missing';
  } finally {
    session.dispose();
  }
}

const write = (file: string): ApprovalCheck => ({
  kind: 'file-write',
  path: file,
});

beforeEach(async () => {
  mockFlushDirectory.mockReset().mockImplementation(realFlushDirectory);
  await writeWorkspaceApprovals(WORKSPACE, { version: 1, rules: [] });
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'effective-policy-')));
  repoA = path.join(base, 'wt-1', 'repo-a');
  repoB = path.join(base, 'wt-1', 'repo-b');
  mkdirSync(path.join(repoA, 'deploy'), { recursive: true });
  mkdirSync(path.join(repoB, 'deploy'), { recursive: true });
});

afterEach(async () => {
  rmSync(base, { recursive: true, force: true });
  rmSync(path.dirname(getWorkspaceApprovalsFilePath(WORKSPACE)), {
    recursive: true,
    force: true,
  });
  await updatePreferencesFile(() => ({ globalApprovalRules: [] }));
  markGlobalApprovalRulesChanged();
});

describe('effective approval policy', () => {
  it.each(['workspace', 'global'] as const)(
    'refuses an Ask target in another repository whose %s grant allows a write the caller is asked about',
    async (tier) => {
      const grant = rule('allow', { kind: 'file-write', path: 'deploy/**' });
      if (tier === 'workspace') {
        await addWorkspaceApprovalRule(WORKSPACE, grant);
      } else {
        await updatePreferencesFile(() => ({ globalApprovalRules: [grant] }));
        markGlobalApprovalRulesChanged();
      }
      const target = path.join(repoB, 'deploy', 'config.ts');
      await expect(decides(chat(repoA), write(target))).resolves.toBe('prompt');
      await expect(decides(chat(repoB), write(target))).resolves.toBe('allow');

      const [caller, other] = await Promise.all([
        effectiveApprovalPolicy(chat(repoA)),
        effectiveApprovalPolicy(chat(repoB)),
      ]);
      expect(isApprovalPolicyWithin(other, caller)).toBe(false);
      expect(isApprovalPolicyWithin(caller, caller)).toBe(true);
    },
  );

  it('accepts a target in the same root under the same workspace grant', async () => {
    await addWorkspaceApprovalRule(
      WORKSPACE,
      rule('allow', { kind: 'file-write', path: 'deploy/**' }),
    );
    const [caller, other] = await Promise.all([
      effectiveApprovalPolicy(chat(repoA)),
      effectiveApprovalPolicy(chat(repoA)),
    ]);
    expect(isApprovalPolicyWithin(other, caller)).toBe(true);
  });

  it('resolves every file rule to an absolute path in its chat root', async () => {
    await addWorkspaceApprovalRule(
      WORKSPACE,
      rule('deny', { kind: 'file-write', path: 'deploy/**' }),
    );
    const policy = await effectiveApprovalPolicy(
      chat(repoA, 'ask', [
        rule('allow', { kind: 'file-write', path: './deploy/config.ts' }),
      ]),
    );
    expect(
      policy?.rules.map((entry) => [
        entry.tier,
        entry.behavior,
        entry.anchored.target,
      ]),
    ).toEqual([
      [
        'session',
        'allow',
        {
          kind: 'file-write',
          path: path.join(repoA, 'deploy', 'config.ts'),
        },
      ],
      [
        'project',
        'deny',
        { kind: 'file-write', path: `${path.join(repoA, 'deploy')}/**` },
      ],
    ]);
  });

  it('lists every policy file the session asks about, absolute in its volume case', async () => {
    mkdirSync(path.dirname(getPreferencesFilePath()), { recursive: true });
    const dataDir = realpathSync(path.dirname(getPreferencesFilePath()));
    const policy = await effectiveApprovalPolicy(chat(repoA));
    const fold = (file: string): string =>
      policy?.pathCaseInsensitive ? file.toLowerCase() : file;
    expect(policy?.protectedFileWritePaths).toEqual(
      expect.arrayContaining(
        [
          'preferences.json',
          'preferences.last-good.json',
          'preferences.generation.json',
          'preferences.backup-*.json',
          'migrations.json',
          'migrations.last-good.json',
          'migrations.damaged-*.json',
        ].map((name) => fold(path.join(dataDir, name))),
      ),
    );
  });

  it('refuses a caller deny the target does not hold at the same absolute path', async () => {
    await addWorkspaceApprovalRule(
      WORKSPACE,
      rule('deny', { kind: 'file-write', path: 'deploy/**' }),
    );
    const [caller, other] = await Promise.all([
      effectiveApprovalPolicy(chat(repoA)),
      effectiveApprovalPolicy(chat(repoB)),
    ]);
    // Each denies its own deploy folder; repo-a's is unprotected in repo-b.
    expect(isApprovalPolicyWithin(other, caller)).toBe(false);
  });

  it('refuses command grants held in another root, and accepts them in the same one', async () => {
    const npmTest = rule('allow', { kind: 'command', pattern: 'npm test' });
    await addWorkspaceApprovalRule(WORKSPACE, npmTest);
    const [caller, same, sibling] = await Promise.all([
      effectiveApprovalPolicy(chat(repoA)),
      effectiveApprovalPolicy(chat(repoA)),
      effectiveApprovalPolicy(chat(repoB)),
    ]);
    expect(isApprovalPolicyWithin(same, caller)).toBe(true);
    expect(isApprovalPolicyWithin(sibling, caller)).toBe(false);
  });

  it('refuses an Auto target outside an Auto caller root, and accepts one inside it', async () => {
    const [caller, inside, sibling] = await Promise.all([
      effectiveApprovalPolicy(chat(path.join(base, 'wt-1'), 'auto')),
      effectiveApprovalPolicy(chat(repoA, 'auto')),
      effectiveApprovalPolicy(chat(path.join(base, 'wt-2'), 'auto')),
    ]);
    expect(isApprovalPolicyWithin(inside, caller)).toBe(true);
    expect(isApprovalPolicyWithin(sibling, caller)).toBe(false);
  });

  // CAN-5153: an unconfirmed save asks, but no deny either version holds softens.
  it('keeps denying what a project deny covers while a later save is unconfirmed', async () => {
    const deployDeny = rule('deny', { kind: 'file-write', path: 'deploy/**' });
    const docsAllow = rule('allow', { kind: 'file-write', path: 'docs/**' });
    await addWorkspaceApprovalRule(WORKSPACE, deployDeny);
    const folder = path.dirname(getWorkspaceApprovalsFilePath(WORKSPACE));
    mockFlushDirectory.mockImplementation(async (flushed) => {
      if (flushed === folder) {
        mockFlushDirectory.mockImplementation(realFlushDirectory);
        throw Object.assign(new Error('flush failed'), { code: 'EIO' });
      }
      return realFlushDirectory(flushed);
    });
    await expect(
      addWorkspaceApprovalRule(WORKSPACE, docsAllow),
    ).rejects.toThrow('Failed to persist project approval rule');

    for (const mode of ['ask', 'auto'] as const) {
      await expect(
        decides(chat(repoA, mode), write(path.join(repoA, 'deploy', 'x.ts'))),
      ).resolves.toBe('deny');
      await expect(
        decides(chat(repoA, mode), write(path.join(repoA, 'docs', 'x.md'))),
      ).resolves.toBe('prompt');
    }
  });

  it('cannot resolve a chat without a root or with an unreadable rule tier', async () => {
    await expect(
      effectiveApprovalPolicy({ ...chat(repoA), workspaceRoot: undefined }),
    ).resolves.toBeUndefined();
    const file = getWorkspaceApprovalsFilePath(WORKSPACE);
    mkdirSync(path.dirname(file), { recursive: true });
    await writeFile(file, '{ not json');
    await expect(effectiveApprovalPolicy(chat(repoA))).resolves.toBeUndefined();
    const caller = await effectiveApprovalPolicy(chat(repoA));
    expect(isApprovalPolicyWithin(caller, caller)).toBe(false);
  });
});
