import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApprovalCheck, ApprovalRule } from '@canopy/desktop-shared/types';
import { seedEmptyApprovalRuleSources } from '../../__tests__/helpers/approval-rule-sources';
import {
  getDataDir,
  getMigrationsFilePath,
  getPreferencesFilePath,
} from '../../lib/paths';
import { updatePreferencesFile } from '../../lib/preferences-store';
import {
  createApprovalSession,
  type ApprovalSessionHandle,
} from '../approval-service';

const WORKSPACE_ID = 'ws-protected-policy-files';

function allow(target: ApprovalRule['target']): ApprovalRule {
  return {
    id: `allow-${JSON.stringify(target)}`,
    behavior: 'allow',
    target,
    createdAt: '2026-10-23T00:00:00.000Z',
    origin: 'settings',
  };
}

const write = (path: string): ApprovalCheck => ({ kind: 'file-write', path });
const command = (text: string): ApprovalCheck => ({
  kind: 'command',
  command: text,
});

describe('policy files a global data-directory allow cannot reach silently', () => {
  const inheritedDataDir = process.env.CANOPY_DATA_DIR;
  let root: string;
  let dataDir: string;
  let workspaceRoot: string;
  let session: ApprovalSessionHandle;

  beforeAll(async () => {
    // A private data directory: the broad global allow must not reach other
    // test files sharing this worker's directory.
    root = await realpath(
      await mkdtemp(join(tmpdir(), 'protected-policy-files-')),
    );
    process.env.CANOPY_DATA_DIR = join(root, 'data');
    await seedEmptyApprovalRuleSources([WORKSPACE_ID]);
    dataDir = getDataDir();
    await updatePreferencesFile(() => ({
      globalApprovalRules: [
        allow({ kind: 'file-write', path: `${dataDir}/**` }),
        allow({ kind: 'command', pattern: 'rm *' }),
        allow({ kind: 'command', pattern: 'cp payload *' }),
      ],
    }));
    await writeFile(join(dataDir, 'migrations.json'), '{"version":1}\n');
    await writeFile(join(dataDir, 'preferences.last-good.json'), '{}\n');
    await writeFile(
      join(dataDir, 'preferences.backup-2026-10-22T00-00-00-000Z.json'),
      '{}\n',
    );
    workspaceRoot = join(root, 'workspace');
    await mkdir(workspaceRoot);
    session = createApprovalSession({
      sessionKey: 'protected-policy-files',
      projectId: WORKSPACE_ID,
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      provider: 'claude',
      workspaceRoot,
      mode: 'ask',
      sessionRules: [],
      getWindow: () => null,
      trackChatTurn: false,
    });
  });

  afterAll(async () => {
    session.dispose();
    if (inheritedDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = inheritedDataDir;
    await rm(root, { recursive: true, force: true });
  });

  const evaluate = (check: ApprovalCheck): Promise<string | undefined> =>
    session.evaluate?.(check) ?? Promise.resolve(undefined);

  it('applies the allow to other data-directory files, so it is in force', async () => {
    await expect(evaluate(write(join(dataDir, 'notes.json')))).resolves.toBe(
      'allow',
    );
    await expect(
      evaluate(command(`rm ${join(dataDir, 'notes.json')}`)),
    ).resolves.toBe('allow');
  });

  it.each([
    ['preferences', (): string => getPreferencesFilePath()],
    [
      'last-good preferences',
      (): string => join(dataDir, 'preferences.last-good.json'),
    ],
    [
      'preferences generation record',
      (): string => join(dataDir, 'preferences.generation.json'),
    ],
    ['migrations ledger', (): string => getMigrationsFilePath()],
    [
      'last-good migrations ledger',
      (): string => join(dataDir, 'migrations.last-good.json'),
    ],
    [
      'kept damaged migrations ledger',
      (): string =>
        join(dataDir, 'migrations.damaged-2026-11-03T10-00-00-000Z-abc.json'),
    ],
    [
      'existing preferences backup',
      (): string =>
        join(dataDir, 'preferences.backup-2026-10-22T00-00-00-000Z.json'),
    ],
  ])('asks before writing or removing the %s file', async (_name, file) => {
    await expect(evaluate(write(file()))).resolves.toBe('prompt');
    await expect(evaluate(command(`rm ${file()}`))).resolves.toBe('prompt');
    await expect(evaluate(command(`cp payload ${file()}`))).resolves.toBe(
      'prompt',
    );
  });

  it('asks about a preferences backup created after the session started', async () => {
    await evaluate(write(join(dataDir, 'notes.json')));
    const later = join(
      dataDir,
      'preferences.backup-2026-10-23T09-30-00-000Z.json',
    );
    await expect(evaluate(write(later))).resolves.toBe('prompt');
    await writeFile(later, '{}\n');
    await expect(evaluate(write(later))).resolves.toBe('prompt');
    await expect(evaluate(command(`rm ${later}`))).resolves.toBe('prompt');
  });

  it('asks before a recursive forced removal of a folder holding them', async () => {
    const nested = join(dataDir, 'nested-copy');
    await mkdir(nested, { recursive: true });
    await expect(evaluate(command(`rm -rf ${nested}`))).resolves.toBe('allow');
    await expect(evaluate(command(`rm -rf ${dataDir}`))).resolves.toBe(
      'prompt',
    );
  });

  it('keeps a delegation grant below the data directory out of the protection', async () => {
    await expect(
      evaluate({
        kind: 'file-write',
        path: join(dataDir, 'workspaces', 'src'),
        isGrant: true,
      }),
    ).resolves.toBe('allow');
    await expect(
      evaluate({
        kind: 'file-write',
        path: `${dataDir}/*.json`,
        isGrant: true,
      }),
    ).resolves.toBe('prompt');
  });

  it('keeps asking about a policy file a dangling symlink replaced', async () => {
    const ledger = getMigrationsFilePath();
    await rm(ledger);
    await symlink(join(root, 'missing', 'migrations.json'), ledger);
    const later = createApprovalSession({
      sessionKey: 'protected-policy-files-dangling',
      projectId: WORKSPACE_ID,
      worktreeId: 'wt-1',
      chatId: 'chat-2',
      provider: 'claude',
      workspaceRoot,
      mode: 'ask',
      sessionRules: [],
      getWindow: () => null,
      trackChatTurn: false,
    });
    try {
      for (const check of [write(ledger), command(`rm ${ledger}`)]) {
        await expect(
          later.evaluate?.(check) ?? Promise.resolve(undefined),
        ).resolves.toBe('prompt');
      }
    } finally {
      later.dispose();
      await rm(ledger);
      await writeFile(ledger, '{"version":1}\n');
    }
  });
});
