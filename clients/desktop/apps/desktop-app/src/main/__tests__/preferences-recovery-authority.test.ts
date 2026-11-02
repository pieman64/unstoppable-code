import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ApprovalRule } from '@canopy/desktop-shared/types';
import * as atomicFile from '@canopy/desktop-shared/node/lib/rename-with-retry';
import {
  acknowledgePreferencesLoadError,
  flushPreferencesWrites,
  peekPreferencesLoadError,
  readPreferencesFile,
  readPreferencesFileDetailed,
  readPreferencesFileForRenderer,
  readLatestPreferencesFile,
  resetPreferencesLoadErrorForTests,
  updatePreferencesFile,
} from '../lib/preferences-store';
import { readGlobalApprovalRuleTier } from '../approvals/approval-rule-sources';
import {
  createApprovalSession,
  type ApprovalSessionHandle,
} from '../approvals/approval-service';
import {
  addWorkspaceApprovalRule,
  getWorkspaceApprovalsFilePath,
  removeWorkspaceApprovalRule,
  writeWorkspaceApprovals,
} from '../lib/approvals-persistence';
import { getGlobalApprovalRulesRevision } from '../approvals/rule-revisions';
import {
  beginPendingApprovalDefaultWrite,
  readApprovalPreferencesForSurface,
  resolveApprovalMode,
} from '../lib/approval-mode-resolution';
import type * as paths from '../lib/paths';

let mockPreferencesPath: string;
jest.mock('../lib/paths', () => ({
  ...jest.requireActual<typeof paths>('../lib/paths'),
  getPreferencesFilePath: (): string => mockPreferencesPath,
}));

const open = fs.open;
const fsRename = fs.rename;
const readFile = fs.readFile;
const writeFile = fs.writeFile;
const grant: ApprovalRule = {
  id: 'R',
  behavior: 'allow',
  origin: 'prompt',
  createdAt: '2026-10-27T00:00:00.000Z',
  target: { kind: 'file-write', path: 'allowed/**' },
};
const good = JSON.stringify({
  version: 1,
  preferences: {
    sidebarCollapsed: true,
    worktreePanelPercent: 48,
    globalApprovalRules: [grant],
  },
});
let root: string;
let lastGoodPath: string;

const rejectFlush = (): Promise<void> =>
  Promise.reject(Object.assign(new Error('flush failed'), { code: 'EIO' }));

/**
 * Replaces `installed`'s folder flush once it is renamed into place. A save's
 * generation record is flushed in the same folder first (CAN-5154).
 */
function failFlushAfterInstallOf(
  installed: string,
  flush: () => Promise<void> = rejectFlush,
  { once = true }: { once?: boolean } = {},
): void {
  let armed = false;
  const renameSpy = jest
    .spyOn(fs, 'rename')
    .mockImplementation(async (source, target) => {
      await fsRename(source, target);
      if (target === installed) armed = true;
    });
  const openSpy = jest
    .spyOn(fs, 'open')
    .mockImplementation(async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      if (
        armed &&
        path === dirname(installed) &&
        (flags === 'r' || flags === 'r+')
      ) {
        if (once) {
          openSpy.mockRestore();
          renameSpy.mockRestore();
        }
        handle.sync = flush;
      }
      return handle;
    });
}

async function inventory(): Promise<Record<string, string>> {
  const entries = await fs.readdir(root);
  return Object.fromEntries(
    await Promise.all(
      entries
        .sort()
        .map(
          async (name): Promise<[string, string]> => [
            name,
            (await readFile(join(root, name))).toString('base64'),
          ],
        ),
    ),
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'preferences-recovery-'));
  mockPreferencesPath = join(root, 'preferences.json');
  lastGoodPath = join(root, 'preferences.last-good.json');
  resetPreferencesLoadErrorForTests();
});

afterEach(async () => {
  await flushPreferencesWrites();
  jest.restoreAllMocks();
  resetPreferencesLoadErrorForTests();
  await fs.rm(root, { recursive: true, force: true });
});

describe('CAN-4407 recovery evidence and subsequent writes', () => {
  it.each(['corrupt', 'unreadable'])(
    'retains a %s last-good failure even when that file disappears before inspection',
    async (state) => {
      await writeFile(lastGoodPath, state === 'corrupt' ? '{torn' : good);
      jest.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
        const value = await readFile(...args);
        if (args[0] === lastGoodPath) {
          await fs.unlink(lastGoodPath);
          if (state === 'unreadable') {
            throw Object.assign(new Error('read failed'), { code: 'EIO' });
          }
        }
        return value;
      });
      await readPreferencesFile();
      const afterExternalRemoval = await inventory();
      expect(peekPreferencesLoadError()).not.toBeNull();
      acknowledgePreferencesLoadError();
      expect((await readPreferencesFileDetailed()).authority).toBe(
        'unreadable',
      );
      const updater = jest.fn(() => ({ sidebarCollapsed: false }));
      await expect(updatePreferencesFile(updater)).rejects.toMatchObject({
        code: 'PREFERENCES_RECOVERY_REQUIRED',
      });
      expect(updater).not.toHaveBeenCalled();
      expect(await inventory()).toEqual(afterExternalRemoval);
    },
  );

  it('returns renderer fallback after acknowledgement without trying notification migration', async () => {
    await writeFile(
      lastGoodPath,
      JSON.stringify({
        version: 1,
        preferences: {
          sidebarCollapsed: true,
          osNotifications: { enabled: true },
        },
      }),
    );
    const rename = atomicFile.renameWithRetry;
    jest
      .spyOn(atomicFile, 'renameWithRetry')
      .mockImplementation(async (source, target) => {
        if (target === mockPreferencesPath)
          throw new Error('primary unavailable');
        return rename(source, target);
      });
    await readPreferencesFile();
    const before = await inventory();
    acknowledgePreferencesLoadError();
    await expect(readPreferencesFileForRenderer()).resolves.toMatchObject({
      sidebarCollapsed: true,
      osNotifications: { enabled: true },
    });
    expect(await inventory()).toEqual(before);
    expect((await readPreferencesFileDetailed()).authority).toBe('unreadable');
  });

  it('does not return authority from a read overtaken by failed recovery', async () => {
    await writeFile(mockPreferencesPath, good);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;
    jest.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      const value = await readFile(...args);
      if (args[0] === mockPreferencesPath && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return value;
    });
    const authority = readPreferencesFileDetailed();
    await entered.promise;
    await writeFile(mockPreferencesPath, '{torn');
    await readPreferencesFile();
    acknowledgePreferencesLoadError();
    release.resolve();
    expect((await authority).authority).toBe('unreadable');
  });

  it('authority reads never recover and cannot trust defaults after error acknowledgement', async () => {
    await writeFile(mockPreferencesPath, '{torn');
    await writeFile(lastGoodPath, good);
    const before = await inventory();
    expect(await readGlobalApprovalRuleTier()).toEqual({
      rules: [],
      unreadable: true,
    });
    acknowledgePreferencesLoadError();
    expect(
      (await readApprovalPreferencesForSurface('worktree')).defaults.worktree,
    ).toBe('ask');
    expect(await inventory()).toEqual(before);
  });

  describe('global deny rules while preferences authority is unreadable', () => {
    const WORKSPACE_ID = 'ws-unreadable-global-denies';
    const denyPush: ApprovalRule = {
      id: 'deny-push',
      behavior: 'deny',
      origin: 'settings',
      createdAt: '2026-10-27T00:00:00.000Z',
      target: { kind: 'command', pattern: 'git push *' },
    };
    const allowEcho: ApprovalRule = {
      id: 'allow-echo',
      behavior: 'allow',
      origin: 'settings',
      createdAt: '2026-10-27T00:00:00.000Z',
      target: { kind: 'command', pattern: 'echo *' },
    };
    const withRules = JSON.stringify({
      version: 1,
      preferences: { globalApprovalRules: [denyPush, allowEcho] },
    });
    const inheritedDataDir = process.env.CANOPY_DATA_DIR;
    let dataRoot: string;
    let session: ApprovalSessionHandle | undefined;

    beforeEach(async () => {
      dataRoot = await fs.mkdtemp(join(tmpdir(), 'unreadable-denies-'));
      process.env.CANOPY_DATA_DIR = dataRoot;
      await writeWorkspaceApprovals(WORKSPACE_ID, { version: 1, rules: [] });
    });

    afterEach(async () => {
      session?.dispose();
      session = undefined;
      if (inheritedDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = inheritedDataDir;
      await fs.rm(dataRoot, { recursive: true, force: true });
    });

    async function outcomes(
      order: 'push-first' | 'echo-first' = 'push-first',
    ): Promise<{ push: string; echo: string }> {
      session = createApprovalSession({
        sessionKey: 'unreadable-global-denies',
        projectId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        provider: 'claude',
        workspaceRoot: dataRoot,
        mode: 'full-access',
        sessionRules: [],
        getWindow: () => null,
        trackChatTurn: false,
      });
      const evaluate = (command: string): Promise<string | undefined> =>
        session?.evaluate?.({ kind: 'command', command }) ??
        Promise.resolve(undefined);
      if (order === 'echo-first') {
        const echo = (await evaluate('echo hi')) ?? 'missing';
        return { push: (await evaluate('git push origin')) ?? 'missing', echo };
      }
      return {
        push: (await evaluate('git push origin')) ?? 'missing',
        echo: (await evaluate('echo hi')) ?? 'missing',
      };
    }

    function failPrimaryRead(): void {
      jest.spyOn(fs, 'readFile').mockImplementation((...args) => {
        if (args[0] === mockPreferencesPath)
          return Promise.reject(
            Object.assign(new Error('denied'), { code: 'EACCES' }),
          );
        return readFile(...args);
      });
    }

    it('applies both rules from a readable primary', async () => {
      await writeFile(mockPreferencesPath, withRules);
      expect(await outcomes()).toEqual({ push: 'deny', echo: 'allow' });
    });

    it('applies no global rules to a genuinely absent profile', async () => {
      expect(await outcomes()).toEqual({ push: 'allow', echo: 'allow' });
      expect(await inventory()).toEqual({});
    });

    it.each([
      {
        name: 'unreadable primary',
        arrange: async (): Promise<void> => {
          await writeFile(mockPreferencesPath, withRules);
          failPrimaryRead();
        },
      },
      {
        name: 'unsupported primary',
        arrange: async (): Promise<void> => {
          await writeFile(
            mockPreferencesPath,
            '{"version":99,"preferences":{}}',
          );
        },
      },
      {
        name: 'corrupt primary before recovery',
        arrange: async (): Promise<void> => {
          await writeFile(mockPreferencesPath, '{torn');
        },
      },
      { name: 'missing primary', arrange: async (): Promise<void> => {} },
      {
        name: 'refused recovery latched after acknowledgement',
        arrange: async (): Promise<void> => {
          await writeFile(
            mockPreferencesPath,
            '{"version":99,"preferences":{}}',
          );
          await readPreferencesFile();
          acknowledgePreferencesLoadError();
        },
      },
      {
        name: 'failed recovery latched after acknowledgement',
        arrange: async (): Promise<void> => {
          await writeFile(mockPreferencesPath, '{torn');
          const rename = atomicFile.renameWithRetry;
          jest
            .spyOn(atomicFile, 'renameWithRetry')
            .mockImplementation(async (source, target) => {
              if (target === mockPreferencesPath)
                throw new Error('rename failed');
              return rename(source, target);
            });
          await readPreferencesFile();
          acknowledgePreferencesLoadError();
          // The latched fallback, not a later last-good, supplies the denies.
          await fs.unlink(lastGoodPath);
        },
      },
    ])(
      'still denies a last-good deny and never applies its allows: $name',
      async ({ arrange }) => {
        await writeFile(lastGoodPath, withRules);
        await arrange();
        const before = await inventory();

        expect(await outcomes()).toEqual({ push: 'deny', echo: 'prompt' });
        expect(await readGlobalApprovalRuleTier()).toEqual({
          rules: [denyPush],
          unreadable: true,
        });
        expect(await inventory()).toEqual(before);
      },
    );

    it('prompts for everything when no usable last-good exists', async () => {
      await writeFile(mockPreferencesPath, '{torn');
      await writeFile(lastGoodPath, '{also torn');
      const before = await inventory();
      expect(await outcomes()).toEqual({ push: 'prompt', echo: 'prompt' });
      expect(await inventory()).toEqual(before);
    });

    it.each([
      { recovery: 'succeeds', expected: { push: 'deny', echo: 'allow' } },
      { recovery: 'fails', expected: { push: 'deny', echo: 'prompt' } },
    ])(
      'settles on the post-recovery tier when recovery $recovery during the served read',
      async ({ recovery, expected }) => {
        await writeFile(mockPreferencesPath, '{torn');
        await writeFile(lastGoodPath, withRules);
        if (recovery === 'fails') {
          const rename = atomicFile.renameWithRetry;
          jest
            .spyOn(atomicFile, 'renameWithRetry')
            .mockImplementation(async (source, target) => {
              if (target === mockPreferencesPath)
                throw new Error('rename failed');
              return rename(source, target);
            });
        }
        let raced = false;
        jest.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
          if (args[0] === lastGoodPath && !raced) {
            raced = true;
            await readPreferencesFile();
          }
          return readFile(...args);
        });

        // The allow is evaluated first, so the race lands on the check whose
        // outcome differs between the stale unreadable tier and recovered state.
        expect(await outcomes('echo-first')).toEqual(expected);
        expect(raced).toBe(true);
      },
    );
  });

  describe('approval surface reads with unreadable authority', () => {
    const lastGood = JSON.stringify({
      version: 1,
      preferences: {
        sidebarCollapsed: true,
        mcpProxyPort: 45_678,
        rtkEnabled: false,
        preventClaudeNativeCaffeinate: false,
        defaultWorktreeProvider: 'claude',
        // Persistable but not a known runtime model: the runtime projection
        // must replace it exactly as readPreferencesFile() does.
        defaultWorktreeModelByProvider: {
          claude: { model: 'claude-retired-model', thinkingLevel: 'low' },
        },
        approvalDefaults: {
          worktree: 'auto',
          cowork: 'auto',
          appAdvisor: 'auto',
        },
      },
    });
    const launchValues = {
      sidebarCollapsed: true,
      mcpProxyPort: 45_678,
      rtkEnabled: false,
      preventClaudeNativeCaffeinate: false,
      defaultWorktreeProvider: 'claude',
    };
    const askEverywhere = { worktree: 'ask', cowork: 'ask', appAdvisor: 'ask' };

    it.each([
      { name: 'unreadable primary', primary: 'EACCES', latchFirst: false },
      { name: 'unreadable primary', primary: 'EACCES', latchFirst: true },
      {
        name: 'unsupported primary',
        primary: '{"version":99,"preferences":{}}',
        latchFirst: false,
      },
      {
        name: 'unsupported primary',
        primary: '{"version":99,"preferences":{}}',
        latchFirst: true,
      },
      { name: 'corrupt primary', primary: '{torn', latchFirst: false },
      { name: 'missing primary', primary: null, latchFirst: false },
    ])(
      'keeps last-good launch values and fails closed only on defaults: $name (latched first: $latchFirst)',
      async ({ primary, latchFirst }) => {
        if (primary !== null)
          await writeFile(
            mockPreferencesPath,
            primary === 'EACCES' ? good : primary,
          );
        await writeFile(lastGoodPath, lastGood);
        if (primary === 'EACCES')
          jest.spyOn(fs, 'readFile').mockImplementation((...args) => {
            if (args[0] === mockPreferencesPath)
              return Promise.reject(
                Object.assign(new Error('denied'), { code: 'EACCES' }),
              );
            return readFile(...args);
          });
        if (latchFirst) {
          await readPreferencesFile();
          acknowledgePreferencesLoadError();
        }
        const before = await inventory();

        const read = await readApprovalPreferencesForSurface('worktree');

        expect(read.preferences).toMatchObject(launchValues);
        expect(read.defaults).toEqual(askEverywhere);
        expect(await inventory()).toEqual(before);
        expect((await readPreferencesFileDetailed()).preferences).toMatchObject(
          { sidebarCollapsed: false, rtkEnabled: true },
        );
        // Same projection the rest of main reads (which may now recover).
        expect(read.preferences).toEqual(await readPreferencesFile());
      },
    );

    it('serves defaults with fail-closed approval defaults when last-good is unusable', async () => {
      await writeFile(mockPreferencesPath, '{torn');
      await writeFile(lastGoodPath, '{also torn');
      const before = await inventory();
      const read = await readApprovalPreferencesForSurface('cowork');
      expect(read.preferences).toMatchObject({
        sidebarCollapsed: false,
        worktreePanelPercent: 32,
      });
      expect(read.defaults).toEqual(askEverywhere);
      expect(await inventory()).toEqual(before);
      expect(read.preferences).toEqual(await readPreferencesFile());
    });

    it('serves the fallback latched while its last-good read was in flight', async () => {
      await writeFile(lastGoodPath, lastGood);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let held = false;
      jest.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
        const value = await readFile(...args);
        if (args[0] === lastGoodPath && !held) {
          held = true;
          entered.resolve();
          await release.promise;
        }
        return value;
      });
      const read = readApprovalPreferencesForSurface('worktree');
      await entered.promise;
      // A concurrent runtime read finds last-good torn and latches defaults.
      await writeFile(lastGoodPath, '{torn');
      const served = await readPreferencesFile();
      acknowledgePreferencesLoadError();
      const latched = await inventory();
      release.resolve();

      const result = await read;
      expect(result.preferences).toEqual(served);
      expect(result.preferences).toMatchObject({ rtkEnabled: true });
      expect(result.defaults).toEqual(askEverywhere);
      expect(await inventory()).toEqual(latched);
      await expect(
        updatePreferencesFile(() => ({ rtkEnabled: false })),
      ).rejects.toMatchObject({ code: 'PREFERENCES_RECOVERY_REQUIRED' });
    });

    it.each(['ENOENT', 'EIO'])(
      'fails closed when last-good %s after the missing-primary check',
      async (code) => {
        await writeFile(lastGoodPath, lastGood);
        jest.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
          if (args[0] === lastGoodPath) {
            await fs.unlink(lastGoodPath).catch(() => undefined);
            throw Object.assign(new Error(code), { code });
          }
          return readFile(...args);
        });
        const read = await readApprovalPreferencesForSurface('worktree');
        expect(read.defaults).toEqual(askEverywhere);
        expect(read.preferences).toMatchObject({ rtkEnabled: true });
        expect(await inventory()).toEqual({});
        expect(read.preferences).toEqual(await readPreferencesFile());
      },
    );

    it('waits for a refused same-surface write before serving the latched fallback', async () => {
      await writeFile(mockPreferencesPath, '{"version":99,"preferences":{}}');
      await writeFile(lastGoodPath, lastGood);
      await readPreferencesFile();
      acknowledgePreferencesLoadError();
      const before = await inventory();
      const end = beginPendingApprovalDefaultWrite('worktree');
      let settled = false;
      const read = readApprovalPreferencesForSurface('worktree').then((r) => {
        settled = true;
        return r;
      });
      await expect(
        updatePreferencesFile(() => ({
          approvalDefaults: {
            worktree: 'full-access',
            cowork: 'full-access',
            appAdvisor: 'full-access',
          },
        })),
      ).rejects.toMatchObject({ code: 'PREFERENCES_RECOVERY_REQUIRED' });
      expect(settled).toBe(false);
      end();
      const result = await read;
      expect(result.defaults).toEqual(askEverywhere);
      expect(result.preferences).toMatchObject(launchValues);
      expect(await inventory()).toEqual(before);
    });

    it('keeps product defaults for a genuinely absent profile', async () => {
      const read = await readApprovalPreferencesForSurface('worktree');
      expect(read.defaults.worktree).toBe('full-access');
      expect(await inventory()).toEqual({});
    });
  });

  it.each([
    '',
    '{torn',
    '{"version":1,"preferences":null}',
    '{"version":99,"preferences":{}}',
  ])(
    'preserves damaged primary %p without last-good, including after acknowledgement and update',
    async (primary) => {
      await writeFile(mockPreferencesPath, primary);
      const before = await inventory();
      const writes = jest.spyOn(fs, 'writeFile');
      await readPreferencesFile();
      expect(peekPreferencesLoadError()).not.toBeNull();
      expect(await inventory()).toEqual(before);
      expect(writes).not.toHaveBeenCalled();
      acknowledgePreferencesLoadError();
      expect((await readPreferencesFileDetailed()).authority).toBe(
        'unreadable',
      );
      await expect(
        updatePreferencesFile(() => ({ sidebarCollapsed: false })),
      ).rejects.toMatchObject({ code: 'PREFERENCES_RECOVERY_REQUIRED' });
      expect(await inventory()).toEqual(before);
    },
  );

  it.each(['missing', 'corrupt', 'unsupported', 'unreadable'])(
    'does not replace an absent primary when last-good is %s, unless both are absent',
    async (state) => {
      if (state !== 'missing')
        await writeFile(
          lastGoodPath,
          state === 'unsupported' ? '{"version":99}' : '{torn',
        );
      if (state === 'unreadable')
        jest.spyOn(fs, 'readFile').mockImplementation((...args) => {
          if (args[0] === lastGoodPath)
            return Promise.reject(
              Object.assign(new Error('denied'), { code: 'EACCES' }),
            );
          return readFile(...args);
        });
      const before = await inventory();
      await readPreferencesFile();
      expect(await inventory()).toEqual(before);
      expect((await readPreferencesFileDetailed()).authority).toBe(
        state === 'missing' ? 'absent' : 'unreadable',
      );
      if (state === 'missing') expect(peekPreferencesLoadError()).toBeNull();
      const update = updatePreferencesFile(() => ({ sidebarCollapsed: true }));
      if (state === 'missing') {
        await expect(update).resolves.toMatchObject({ sidebarCollapsed: true });
      } else {
        await expect(update).rejects.toMatchObject({
          code: 'PREFERENCES_RECOVERY_REQUIRED',
        });
        expect((await readPreferencesFileDetailed()).authority).toBe(
          'unreadable',
        );
        expect(await inventory()).toEqual(before);
      }
    },
  );

  it.each(['unreadable', 'unsupported'])(
    'keeps %s primary and available last-good intact during reads and later updates',
    async (state) => {
      await writeFile(
        mockPreferencesPath,
        state === 'unsupported' ? '{"version":99}' : good,
      );
      await writeFile(lastGoodPath, good);
      if (state === 'unreadable')
        jest.spyOn(fs, 'readFile').mockImplementation((...args) => {
          if (args[0] === mockPreferencesPath)
            return Promise.reject(
              Object.assign(new Error('denied'), { code: 'EACCES' }),
            );
          return readFile(...args);
        });
      const before = await inventory();
      await readPreferencesFile();
      await expect(
        updatePreferencesFile(() => ({ sidebarCollapsed: false })),
      ).rejects.toMatchObject({ code: 'PREFERENCES_RECOVERY_REQUIRED' });
      expect(await inventory()).toEqual(before);
      expect(await readGlobalApprovalRuleTier()).toMatchObject({
        unreadable: true,
        rules: [],
      });
    },
  );

  it.each(['corrupt', 'unsupported', 'unreadable'])(
    'preserves corrupt primary and %s last-good without attempting fallback writes',
    async (state) => {
      await writeFile(mockPreferencesPath, '{torn');
      await writeFile(
        lastGoodPath,
        state === 'unsupported' ? '{"version":99}' : good,
      );
      if (state === 'corrupt') await writeFile(lastGoodPath, '{also torn');
      if (state === 'unreadable')
        jest.spyOn(fs, 'readFile').mockImplementation((...args) => {
          if (args[0] === lastGoodPath)
            return Promise.reject(
              Object.assign(new Error('denied'), { code: 'EACCES' }),
            );
          return readFile(...args);
        });
      const before = await inventory();
      const writes = jest.spyOn(fs, 'writeFile');
      await readPreferencesFile();
      await expect(
        updatePreferencesFile(() => ({ sidebarCollapsed: false })),
      ).rejects.toMatchObject({ code: 'PREFERENCES_RECOVERY_REQUIRED' });
      expect(writes).not.toHaveBeenCalled();
      expect(await inventory()).toEqual(before);
    },
  );

  it.each(
    [
      'backup-write',
      'backup-rename',
      'primary-write',
      'primary-rename',
    ].flatMap((stage) =>
      [false, true].flatMap((missingPrimary) =>
        [false, true].map((updateFirst) => ({
          stage,
          missingPrimary,
          updateFirst,
        })),
      ),
    ),
  )(
    'preserves bytes after $stage failure (missing primary: $missingPrimary, update first: $updateFirst) and refuses later writes',
    async ({ stage, missingPrimary, updateFirst }) => {
      if (!missingPrimary) await writeFile(mockPreferencesPath, '{torn');
      await writeFile(lastGoodPath, good);
      const original = await inventory();
      const rename = atomicFile.renameWithRetry;
      const fails = (path: unknown): boolean =>
        typeof path === 'string' &&
        (stage.startsWith('backup')
          ? basename(path).includes('preferences.backup-')
          : basename(path) === 'preferences.json' ||
            basename(path).startsWith('.preferences.json.'));
      // The shared writer creates each sibling with `open`, then installs it.
      const writes = jest.spyOn(fs, 'open').mockImplementation((...args) => {
        if (stage.endsWith('write') && fails(args[0]))
          return Promise.reject(new Error(stage));
        return open(...args);
      });
      jest
        .spyOn(atomicFile, 'renameWithRetry')
        .mockImplementation(async (source, target) => {
          if (stage.endsWith('rename') && fails(target)) throw new Error(stage);
          return rename(source, target);
        });
      const initialUpdater = jest.fn(() => ({ sidebarCollapsed: false }));
      if (updateFirst) {
        await expect(
          updatePreferencesFile(initialUpdater),
        ).rejects.toMatchObject({ code: 'PREFERENCES_RECOVERY_REQUIRED' });
        expect(initialUpdater).not.toHaveBeenCalled();
      } else {
        await readPreferencesFile();
      }
      const failed = await inventory();
      expect(failed['preferences.json']).toBe(original['preferences.json']);
      expect(failed['preferences.last-good.json']).toBe(
        original['preferences.last-good.json'],
      );
      const backups = Object.keys(failed).filter((name) =>
        name.startsWith('preferences.backup-'),
      );
      expect(backups).toHaveLength(stage.startsWith('primary') ? 1 : 0);
      if (backups[0])
        expect(
          JSON.parse(await readFile(join(root, backups[0]), 'utf8')),
        ).toMatchObject(
          missingPrimary
            ? { originalContentUnavailable: true }
            : { rawContent: '{torn' },
        );
      expect(Object.keys(failed).some((name) => name.endsWith('.tmp'))).toBe(
        false,
      );
      expect(peekPreferencesLoadError()).toMatchObject({
        reason: missingPrimary ? 'read' : 'parse',
        backupPath: backups[0] ? join(root, backups[0]) : undefined,
      });
      expect(peekPreferencesLoadError()?.message).toEqual(
        expect.stringContaining(stage),
      );
      const attempts = writes.mock.calls.length;
      const updater = jest.fn(() => ({ sidebarCollapsed: false }));
      acknowledgePreferencesLoadError();
      await readPreferencesFile();
      expect(peekPreferencesLoadError()).toBeNull();
      expect((await readPreferencesFileDetailed()).authority).toBe(
        'unreadable',
      );
      await expect(updatePreferencesFile(updater)).rejects.toMatchObject({
        code: 'PREFERENCES_RECOVERY_REQUIRED',
      });
      expect(updater).not.toHaveBeenCalled();
      expect(writes).toHaveBeenCalledTimes(attempts);
      expect(await inventory()).toEqual(failed);
    },
  );

  it.each([undefined, '{torn', '{"version":99}'])(
    'keeps a supported primary authoritative without touching unusable last-good %p',
    async (lastGood) => {
      await writeFile(mockPreferencesPath, good);
      if (lastGood !== undefined) await writeFile(lastGoodPath, lastGood);
      const before = await inventory();
      const revision = getGlobalApprovalRulesRevision();
      expect(await readPreferencesFile()).toMatchObject({
        sidebarCollapsed: true,
        globalApprovalRules: [grant],
      });
      expect((await readPreferencesFileDetailed()).authority).toBe('ok');
      expect(peekPreferencesLoadError()).toBeNull();
      await updatePreferencesFile(() => null);
      expect(getGlobalApprovalRulesRevision()).toBe(revision);
      expect(await inventory()).toEqual(before);
      await updatePreferencesFile(() => ({ globalApprovalRules: [] }));
      expect(getGlobalApprovalRulesRevision()).toBeGreaterThan(revision);
      await flushPreferencesWrites();
      for (const path of [mockPreferencesPath, lastGoodPath]) {
        expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
          preferences: {
            globalApprovalRules: [],
            sidebarCollapsed: true,
            worktreePanelPercent: 48,
          },
        });
      }
    },
  );

  it('does not invalidate rules or latch recovery failure when an ordinary primary commit fails', async () => {
    await writeFile(mockPreferencesPath, good);
    await writeFile(lastGoodPath, good);
    const before = await inventory();
    const revision = getGlobalApprovalRulesRevision();
    const committed = jest.fn();
    const rename = atomicFile.renameWithRetry;
    const fault = jest
      .spyOn(atomicFile, 'renameWithRetry')
      .mockImplementation(async (source, target) => {
        if (target === mockPreferencesPath) throw new Error('commit failed');
        return rename(source, target);
      });
    await expect(
      updatePreferencesFile(() => ({ globalApprovalRules: [] }), committed),
    ).rejects.toThrow('commit failed');
    expect(committed).not.toHaveBeenCalled();
    expect(getGlobalApprovalRulesRevision()).toBe(revision);
    // Only the generation record moved ahead of the unchanged main.
    const { 'preferences.generation.json': record, ...afterFailure } =
      await inventory();
    expect(afterFailure).toEqual(before);
    expect(JSON.parse(Buffer.from(record, 'base64').toString())).toEqual({
      version: 1,
      generation: 1,
    });
    expect(peekPreferencesLoadError()).toBeNull();
    expect((await readPreferencesFileDetailed()).authority).toBe('ok');
    fault.mockRestore();
    await updatePreferencesFile(() => ({ globalApprovalRules: [] }), committed);
    expect(committed).toHaveBeenCalledTimes(1);
    expect(getGlobalApprovalRulesRevision()).toBeGreaterThan(revision);
    await flushPreferencesWrites();
    for (const path of [mockPreferencesPath, lastGoodPath]) {
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
        preferences: {
          globalApprovalRules: [],
          sidebarCollapsed: true,
          worktreePanelPercent: 48,
        },
      });
    }
  });

  // CAN-5153 D8: the new primary is visible, so no cache may outlive it.
  it('invalidates cached preferences and global rules when an installed primary loses its folder flush', async () => {
    await writeFile(mockPreferencesPath, good);
    await writeFile(lastGoodPath, good);
    await updatePreferencesFile(() => ({ worktreePanelPercent: 40 }));
    expect(await readLatestPreferencesFile()).toMatchObject({
      worktreePanelPercent: 40,
      globalApprovalRules: [grant],
    });
    const revision = getGlobalApprovalRulesRevision();
    const committed = jest.fn();
    failFlushAfterInstallOf(mockPreferencesPath, rejectFlush, {
      once: false,
    });
    await expect(
      updatePreferencesFile(
        () => ({ worktreePanelPercent: 52, globalApprovalRules: [] }),
        committed,
      ),
    ).rejects.toMatchObject({ name: 'StorageOutcomeUnknownError' });
    jest.restoreAllMocks();
    expect(committed).not.toHaveBeenCalled();
    expect(
      JSON.parse(await readFile(mockPreferencesPath, 'utf8')),
    ).toMatchObject({
      preferences: { worktreePanelPercent: 52, globalApprovalRules: [] },
    });
    expect(getGlobalApprovalRulesRevision()).toBeGreaterThan(revision);
    expect(await readLatestPreferencesFile()).toMatchObject({
      worktreePanelPercent: 52,
      globalApprovalRules: [],
    });
    // Recovery policy is unchanged (CAN-5154): nothing is latched.
    expect(peekPreferencesLoadError()).toBeNull();
  });

  it('keeps the global rule revision when an unknown-outcome write leaves the rules alone', async () => {
    await writeFile(mockPreferencesPath, good);
    await writeFile(lastGoodPath, good);
    await updatePreferencesFile(() => ({ worktreePanelPercent: 40 }));
    const revision = getGlobalApprovalRulesRevision();
    failFlushAfterInstallOf(mockPreferencesPath, rejectFlush, {
      once: false,
    });
    await expect(
      updatePreferencesFile(() => ({ worktreePanelPercent: 52 })),
    ).rejects.toMatchObject({ name: 'StorageOutcomeUnknownError' });
    jest.restoreAllMocks();
    expect(getGlobalApprovalRulesRevision()).toBe(revision);
    expect(await readLatestPreferencesFile()).toMatchObject({
      worktreePanelPercent: 52,
    });
  });

  it.each(['{torn', null])(
    'recovers %p from last-good without rewriting that evidence',
    async (primary) => {
      if (primary !== null) await writeFile(mockPreferencesPath, primary);
      await writeFile(lastGoodPath, good);
      const revision = getGlobalApprovalRulesRevision();
      expect(await readPreferencesFile()).toMatchObject({
        sidebarCollapsed: true,
        globalApprovalRules: [grant],
      });
      expect(getGlobalApprovalRulesRevision()).toBeGreaterThan(revision);
      expect(peekPreferencesLoadError()).not.toBeNull();
      expect(
        (await readApprovalPreferencesForSurface('worktree')).defaults.worktree,
      ).toBe('full-access');
      expect(await readFile(lastGoodPath, 'utf8')).toBe(good);
      const before = await inventory();
      await updatePreferencesFile(() => null);
      expect(await inventory()).toEqual(before);
      await updatePreferencesFile(() => ({ globalApprovalRules: [] }));
      expect(await readGlobalApprovalRuleTier()).toEqual({
        rules: [],
        unreadable: false,
      });
      expect(
        (await readPreferencesFileDetailed()).preferences.sidebarCollapsed,
      ).toBe(true);
      await flushPreferencesWrites();
      expect(JSON.parse(await readFile(lastGoodPath, 'utf8'))).toHaveProperty(
        'preferences.globalApprovalRules',
        [],
      );
    },
  );

  it('keeps distinct recovery evidence when two successful recoveries share a timestamp', async () => {
    jest
      .spyOn(Date.prototype, 'toISOString')
      .mockReturnValue('2026-10-27T00:00:00.000Z');
    await writeFile(lastGoodPath, good);
    await writeFile(mockPreferencesPath, '{first torn');
    await readPreferencesFile();
    const first = await inventory();
    await writeFile(mockPreferencesPath, '{second torn');
    await readPreferencesFile();
    const second = await inventory();
    const backups = Object.keys(second).filter((name) =>
      name.startsWith('preferences.backup-'),
    );
    expect(backups).toHaveLength(2);
    for (const name of Object.keys(first).filter((name) =>
      name.startsWith('preferences.backup-'),
    )) {
      expect(second[name]).toBe(first[name]);
    }
    expect(await readFile(lastGoodPath, 'utf8')).toBe(good);
  });

  it('O4: a passive supported primary and notice acknowledgement cannot clear failed recovery until restart', async () => {
    await writeFile(mockPreferencesPath, '{torn');
    await readPreferencesFile();
    acknowledgePreferencesLoadError();
    await writeFile(mockPreferencesPath, good);
    const repaired = await inventory();
    await expect(
      updatePreferencesFile(() => ({ globalApprovalRules: [] })),
    ).rejects.toMatchObject({ code: 'PREFERENCES_RECOVERY_REQUIRED' });
    expect((await readPreferencesFileDetailed()).authority).toBe('unreadable');
    expect(await inventory()).toEqual(repaired);
    // Reset only process-local state, retaining the repaired bytes on disk.
    resetPreferencesLoadErrorForTests();
    expect((await readPreferencesFileDetailed()).authority).toBe('ok');
    await expect(
      updatePreferencesFile(() => ({ globalApprovalRules: [] })),
    ).resolves.toMatchObject({
      globalApprovalRules: [],
      sidebarCollapsed: true,
    });
  });

  it('E3/Q-R4: queues a held torn-primary read before revocation instead of restoring its stale rules later', async () => {
    await writeFile(mockPreferencesPath, '{torn');
    await writeFile(lastGoodPath, good);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;
    const reads = jest
      .spyOn(fs, 'readFile')
      .mockImplementation(async (...args) => {
        const value = await readFile(...args);
        if (args[0] === mockPreferencesPath && !held) {
          held = true;
          entered.resolve();
          await release.promise;
        }
        return value;
      });
    const read = readPreferencesFile();
    await entered.promise;
    // The directory already exists; make queue entry deterministic without timers.
    jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const updater = jest.fn(() => ({ globalApprovalRules: [] }));
    const revoke = updatePreferencesFile(updater);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const readsBeforeRelease = reads.mock.calls.filter(
      ([file]) => file === mockPreferencesPath,
    ).length;
    release.resolve();
    await Promise.all([read, revoke]);
    expect(readsBeforeRelease).toBe(1);
    expect(
      JSON.parse(await readFile(mockPreferencesPath, 'utf8')),
    ).toHaveProperty('preferences.globalApprovalRules', []);
    expect((await readLatestPreferencesFile()).globalApprovalRules).toEqual([]);
    expect(await readGlobalApprovalRuleTier()).toEqual({
      rules: [],
      unreadable: false,
    });
    await flushPreferencesWrites();
    expect(JSON.parse(await readFile(lastGoodPath, 'utf8'))).toHaveProperty(
      'preferences.globalApprovalRules',
      [],
    );
  });

  describe('display fallback after refused or failed recovery', () => {
    const replacement = JSON.stringify({
      version: 1,
      preferences: { sidebarCollapsed: false, worktreePanelPercent: 10 },
    });

    function failPrimaryRead(code: string): void {
      jest.spyOn(fs, 'readFile').mockImplementation((...args) => {
        if (args[0] === mockPreferencesPath)
          return Promise.reject(Object.assign(new Error('denied'), { code }));
        return readFile(...args);
      });
    }

    function failRename(predicate: (target: string) => boolean): void {
      const rename = atomicFile.renameWithRetry;
      jest
        .spyOn(atomicFile, 'renameWithRetry')
        .mockImplementation(async (source, target) => {
          if (predicate(target)) throw new Error('rename failed');
          return rename(source, target);
        });
    }

    const isBackup = (path: string): boolean =>
      basename(path).startsWith('preferences.backup-');

    it.each([
      {
        name: 'unreadable primary',
        primary: good,
        arrange: (): void => failPrimaryRead('EACCES'),
        error: { reason: 'read', code: 'EACCES' },
        backup: false,
      },
      {
        name: 'unsupported primary',
        primary: '{"version":99,"preferences":{}}',
        arrange: (): void => undefined,
        error: { reason: 'version', actualVersion: 99 },
        backup: false,
      },
      {
        name: 'corrupt primary whose backup fails',
        primary: '{torn',
        arrange: (): void => failRename(isBackup),
        error: { reason: 'parse' },
        backup: false,
      },
      {
        name: 'corrupt primary whose restore fails',
        primary: '{torn',
        arrange: (): void => failRename((path) => path === mockPreferencesPath),
        error: { reason: 'parse' },
        backup: true,
      },
      {
        name: 'absent primary whose restore fails',
        primary: null,
        arrange: (): void => failRename((path) => path === mockPreferencesPath),
        error: { reason: 'read', code: 'ENOENT' },
        backup: true,
      },
    ])(
      'serves supported last-good for display, never authority: $name',
      async ({ primary, arrange, error, backup }) => {
        if (primary !== null) await writeFile(mockPreferencesPath, primary);
        await writeFile(lastGoodPath, good);
        const original = await inventory();
        arrange();

        expect(await readPreferencesFile()).toMatchObject({
          sidebarCollapsed: true,
          worktreePanelPercent: 48,
        });
        const failed = await inventory();
        const backups = Object.keys(failed).filter((name) =>
          name.startsWith('preferences.backup-'),
        );
        expect(backups).toHaveLength(backup ? 1 : 0);
        expect(
          Object.fromEntries(
            Object.entries(failed).filter(([name]) => !backups.includes(name)),
          ),
        ).toEqual(original);
        const details = peekPreferencesLoadError();
        expect(details).toMatchObject({
          ...error,
          restoredFromPath: lastGoodPath,
        });
        expect(details?.backupPath).toBe(
          backups[0] ? join(root, backups[0]) : undefined,
        );
        await expect(readPreferencesFileForRenderer()).resolves.toMatchObject({
          sidebarCollapsed: true,
          worktreePanelPercent: 48,
          __error: { restoredFromPath: lastGoodPath },
        });

        acknowledgePreferencesLoadError();
        if (primary === null || primary === '{torn')
          await writeFile(mockPreferencesPath, replacement);
        const replaced = await inventory();
        expect(await readPreferencesFile()).toMatchObject({
          sidebarCollapsed: true,
          worktreePanelPercent: 48,
        });
        expect(peekPreferencesLoadError()).toBeNull();
        const rendered = await readPreferencesFileForRenderer();
        expect(rendered).toMatchObject({
          sidebarCollapsed: true,
          worktreePanelPercent: 48,
        });
        expect(rendered.__error).toBeUndefined();
        expect((await readPreferencesFileDetailed()).authority).toBe(
          'unreadable',
        );
        expect(await readGlobalApprovalRuleTier()).toEqual({
          rules: [],
          unreadable: true,
        });
        expect(
          (await readApprovalPreferencesForSurface('worktree')).defaults
            .worktree,
        ).toBe('ask');
        const updater = jest.fn(() => ({ sidebarCollapsed: false }));
        await expect(updatePreferencesFile(updater)).rejects.toMatchObject({
          code: 'PREFERENCES_RECOVERY_REQUIRED',
        });
        expect(updater).not.toHaveBeenCalled();
        expect(await inventory()).toEqual(replaced);
      },
    );

    it.each([
      { primary: null, lastGood: '{torn' },
      { primary: null, lastGood: '{"version":99}' },
      { primary: null, lastGood: 'unreadable' },
      { primary: '{torn', lastGood: '{also torn' },
      { primary: '{"version":99,"preferences":{}}', lastGood: null },
      { primary: 'unreadable', lastGood: null },
    ])(
      'reports defaults without naming unusable last-good (primary $primary, last-good $lastGood)',
      async ({ primary, lastGood }) => {
        if (primary !== null)
          await writeFile(
            mockPreferencesPath,
            primary === 'unreadable' ? good : primary,
          );
        if (lastGood !== null)
          await writeFile(
            lastGoodPath,
            lastGood === 'unreadable' ? good : lastGood,
          );
        const unreadable =
          primary === 'unreadable'
            ? mockPreferencesPath
            : lastGood === 'unreadable'
              ? lastGoodPath
              : null;
        if (unreadable)
          jest.spyOn(fs, 'readFile').mockImplementation((...args) => {
            if (args[0] === unreadable)
              return Promise.reject(
                Object.assign(new Error('denied'), { code: 'EACCES' }),
              );
            return readFile(...args);
          });
        const before = await inventory();

        expect(await readPreferencesFile()).toMatchObject({
          sidebarCollapsed: false,
          worktreePanelPercent: 32,
          globalApprovalRules: [],
        });
        const details = peekPreferencesLoadError();
        expect(details).not.toBeNull();
        expect(details?.restoredFromPath).toBeUndefined();
        expect(details?.backupPath).toBeUndefined();
        expect(await inventory()).toEqual(before);
        expect((await readPreferencesFileDetailed()).authority).toBe(
          'unreadable',
        );
      },
    );
  });

  it('Q-R4b: a read waits for revocation last-good refresh before recovering a torn primary', async () => {
    await writeFile(mockPreferencesPath, good);
    await writeFile(lastGoodPath, good);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (
        typeof args[0] === 'string' &&
        args[0].includes('.preferences.last-good.json.')
      ) {
        entered.resolve();
        await release.promise;
      }
      return open(...args);
    });
    const revoke = updatePreferencesFile(() => ({ globalApprovalRules: [] }));
    await entered.promise;
    await writeFile(mockPreferencesPath, '{torn');
    const reads = jest.spyOn(fs, 'readFile');
    let recovered = false;
    const recovery = readPreferencesFile().then((value) => {
      recovered = true;
      return value;
    });
    const readsOf = (file: string): number =>
      reads.mock.calls.filter(([path]) => path === file).length;
    // Let the read reach the torn primary, then the wait for last-good.
    for (let turn = 0; turn < 200 && readsOf(mockPreferencesPath) === 0; turn++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    for (let turn = 0; turn < 20; turn++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    const primaryReadsWhileRefreshHeld = readsOf(mockPreferencesPath);
    const lastGoodReadsWhileRefreshHeld = readsOf(lastGoodPath);
    const recoveredWhileRefreshHeld = recovered;
    release.resolve();
    await Promise.all([revoke, recovery]);
    // The read did reach the torn primary, so it was held at last-good.
    expect(primaryReadsWhileRefreshHeld).toBeGreaterThan(0);
    expect(lastGoodReadsWhileRefreshHeld).toBe(0);
    expect(recoveredWhileRefreshHeld).toBe(false);
    for (const file of [mockPreferencesPath, lastGoodPath]) {
      expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
        preferences: {
          globalApprovalRules: [],
          sidebarCollapsed: true,
        },
      });
    }
    expect((await readLatestPreferencesFile()).globalApprovalRules).toEqual([]);
  });
});

// CAN-4469 D-release: a remembered grant whose save is unconfirmed is never
// applied in this process, even after the rule cache expires.
describe('CAN-5153 approval decisions after an unconfirmed save', () => {
  const WORKSPACE_ID = 'ws-unconfirmed-saves';
  const allowEcho: ApprovalRule = {
    id: 'allow-echo',
    behavior: 'allow',
    origin: 'prompt',
    createdAt: '2026-10-30T00:00:00.000Z',
    target: { kind: 'command', pattern: 'echo *' },
  };
  const denyPush: ApprovalRule = {
    id: 'deny-push',
    behavior: 'deny',
    origin: 'settings',
    createdAt: '2026-10-30T00:00:00.000Z',
    target: { kind: 'command', pattern: 'git push *' },
  };
  const allowLs: ApprovalRule = {
    id: 'allow-ls',
    behavior: 'allow',
    origin: 'prompt',
    createdAt: '2026-10-30T00:00:00.000Z',
    target: { kind: 'command', pattern: 'ls *' },
  };
  const inheritedDataDir = process.env.CANOPY_DATA_DIR;
  let dataRoot: string;
  let session: ApprovalSessionHandle;
  let now: number;

  const preferencesWith = (rules: ApprovalRule[]): string =>
    JSON.stringify({ version: 1, preferences: { globalApprovalRules: rules } });
  const evaluate = (command: string): Promise<string> =>
    session.evaluate?.({ kind: 'command', command }) ??
    Promise.resolve('missing');
  /** Every evaluation, also once the rule cache has expired. */
  async function outcomes(command: string): Promise<string[]> {
    const first = await evaluate(command);
    now += 60_000;
    return [first, await evaluate(command)];
  }
  /** The next flush of `folder` fails after its write is installed. */
  function failNextFlushOf(folder: string): void {
    const spy = jest
      .spyOn(fs, 'open')
      .mockImplementation(async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (path === folder && (flags === 'r' || flags === 'r+')) {
          spy.mockRestore();
          handle.sync = (): Promise<void> =>
            Promise.reject(
              Object.assign(new Error('flush failed'), { code: 'EIO' }),
            );
        }
        return handle;
      });
  }
  const workspaceFolder = (): string =>
    dirname(getWorkspaceApprovalsFilePath(WORKSPACE_ID));

  beforeEach(async () => {
    dataRoot = await fs.mkdtemp(join(tmpdir(), 'unconfirmed-saves-'));
    process.env.CANOPY_DATA_DIR = dataRoot;
    now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    await writeWorkspaceApprovals(WORKSPACE_ID, { version: 1, rules: [] });
    session = createApprovalSession({
      sessionKey: 'unconfirmed-saves',
      projectId: WORKSPACE_ID,
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      provider: 'claude',
      workspaceRoot: dataRoot,
      mode: 'ask',
      sessionRules: [],
      getWindow: () => null,
      trackChatTurn: false,
    });
  });

  afterEach(async () => {
    session.dispose();
    jest.restoreAllMocks();
    if (inheritedDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = inheritedDataDir;
    await fs.rm(dataRoot, { recursive: true, force: true });
  });

  it('does not apply a global grant until a later save is confirmed', async () => {
    await writeFile(mockPreferencesPath, preferencesWith([]));
    expect(await evaluate('echo hi')).toBe('prompt');
    failFlushAfterInstallOf(mockPreferencesPath);
    await expect(
      updatePreferencesFile(() => ({ globalApprovalRules: [allowEcho] })),
    ).rejects.toMatchObject({ name: 'StorageOutcomeUnknownError' });
    expect(
      JSON.parse(await readFile(mockPreferencesPath, 'utf8')),
    ).toMatchObject({ preferences: { globalApprovalRules: [allowEcho] } });
    expect(await outcomes('echo hi')).toEqual(['prompt', 'prompt']);
    expect(peekPreferencesLoadError()).toBeNull();

    await updatePreferencesFile(() => ({ worktreePanelPercent: 40 }));
    expect(await outcomes('echo hi')).toEqual(['allow', 'allow']);
  });

  it('does not apply a global grant read before its save is confirmed', async () => {
    await writeFile(mockPreferencesPath, preferencesWith([]));
    const readHeld = Promise.withResolvers<void>();
    const readReleased = Promise.withResolvers<void>();
    const readDone = Promise.withResolvers<void>();
    let holdNextRead = true;
    jest.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      if (args[0] !== mockPreferencesPath || !holdNextRead)
        return readFile(...args);
      holdNextRead = false;
      readHeld.resolve();
      await readReleased.promise;
      const value = await readFile(...args);
      readDone.resolve();
      return value;
    });
    // The read is past the preferences queue before the save is queued.
    const tier = readGlobalApprovalRuleTier();
    await readHeld.promise;
    const flushReached = Promise.withResolvers<void>();
    const flushReleased = Promise.withResolvers<void>();
    failFlushAfterInstallOf(mockPreferencesPath, async (): Promise<void> => {
      flushReached.resolve();
      await flushReleased.promise;
      throw Object.assign(new Error('flush failed'), { code: 'EIO' });
    });
    const save = updatePreferencesFile(() => ({
      globalApprovalRules: [allowEcho],
    }));
    await flushReached.promise;
    readReleased.resolve();
    await readDone.promise;
    flushReleased.resolve();
    await expect(save).rejects.toMatchObject({
      name: 'StorageOutcomeUnknownError',
    });
    expect((await tier).rules).toEqual([]);
  });

  it('neither revives a global allow nor drops a deny that an unconfirmed save removed', async () => {
    await writeFile(
      mockPreferencesPath,
      preferencesWith([allowEcho, denyPush, allowLs]),
    );
    expect(await evaluate('echo hi')).toBe('allow');
    failFlushAfterInstallOf(mockPreferencesPath);
    await expect(
      updatePreferencesFile(() => ({ globalApprovalRules: [allowLs] })),
    ).rejects.toMatchObject({ name: 'StorageOutcomeUnknownError' });
    expect(await outcomes('echo hi')).toEqual(['prompt', 'prompt']);
    expect(await outcomes('git push origin')).toEqual(['deny', 'deny']);
    // Held by both the confirmed and the unconfirmed rules.
    expect(await outcomes('ls src')).toEqual(['allow', 'allow']);
  });

  it('keeps the confirmed global rules live when a save fails before it installs', async () => {
    await writeFile(mockPreferencesPath, preferencesWith([allowEcho]));
    expect(await evaluate('echo hi')).toBe('allow');
    const revision = getGlobalApprovalRulesRevision();
    const spy = jest.spyOn(fs, 'open').mockImplementation((...args) => {
      if (String(args[0]).includes('.preferences.json.'))
        return Promise.reject(new Error('write failed'));
      return open(...args);
    });
    await expect(
      updatePreferencesFile(() => ({ globalApprovalRules: [] })),
    ).rejects.toThrow('write failed');
    spy.mockRestore();
    expect(getGlobalApprovalRulesRevision()).toBe(revision);
    expect(await outcomes('echo hi')).toEqual(['allow', 'allow']);
  });

  it('does not apply a project grant until a later save is confirmed', async () => {
    expect(await evaluate('echo hi')).toBe('prompt');
    failNextFlushOf(workspaceFolder());
    await expect(
      addWorkspaceApprovalRule(WORKSPACE_ID, allowEcho),
    ).rejects.toThrow('Failed to persist project approval rule');
    expect(
      JSON.parse(
        await readFile(getWorkspaceApprovalsFilePath(WORKSPACE_ID), 'utf8'),
      ),
    ).toMatchObject({ rules: [allowEcho] });
    expect(await outcomes('echo hi')).toEqual(['prompt', 'prompt']);

    await addWorkspaceApprovalRule(WORKSPACE_ID, allowLs);
    expect(await outcomes('echo hi')).toEqual(['allow', 'allow']);
    expect(await outcomes('ls src')).toEqual(['allow', 'allow']);
  });

  it('keeps the confirmed project rules live when a save fails before it installs', async () => {
    await addWorkspaceApprovalRule(WORKSPACE_ID, allowEcho);
    expect(await evaluate('echo hi')).toBe('allow');
    const spy = jest.spyOn(fs, 'open').mockImplementation((...args) => {
      if (String(args[0]).includes('.approvals.json.'))
        return Promise.reject(new Error('write failed'));
      return open(...args);
    });
    await expect(
      removeWorkspaceApprovalRule(WORKSPACE_ID, allowEcho.id),
    ).rejects.toThrow('Failed to persist project approval rule removal');
    spy.mockRestore();
    expect(await outcomes('echo hi')).toEqual(['allow', 'allow']);
  });
});

// CAN-4469 D-release: a default-mode change whose save is unconfirmed is not
// used for a new chat in this process.
describe('CAN-5153 approval defaults after an unconfirmed save', () => {
  const askEverywhere = {
    worktree: 'ask',
    cowork: 'ask',
    appAdvisor: 'ask',
  } as const;
  const preferencesWithDefaults = (defaults: object): string =>
    JSON.stringify({ version: 1, preferences: { approvalDefaults: defaults } });
  /** The mode a new worktree chat without a tab or project override gets. */
  async function newChatMode(): Promise<string> {
    const { defaults } = await readApprovalPreferencesForSurface('worktree');
    return resolveApprovalMode({ surface: 'worktree', defaults });
  }
  /** Saves a worktree default as the Settings handler does. */
  async function saveWorktreeDefault(
    mode: 'ask' | 'full-access',
  ): Promise<void> {
    const endPendingWrite = beginPendingApprovalDefaultWrite('worktree');
    try {
      await updatePreferencesFile((previous) => ({
        approvalDefaults: { ...previous.approvalDefaults, worktree: mode },
      }));
    } finally {
      endPendingWrite();
    }
  }
  function failNextPreferencesFlush(): void {
    failFlushAfterInstallOf(mockPreferencesPath);
  }

  it('keeps a new chat on the confirmed default until a later save is confirmed', async () => {
    await writeFile(
      mockPreferencesPath,
      preferencesWithDefaults(askEverywhere),
    );
    expect(await newChatMode()).toBe('ask');
    failNextPreferencesFlush();
    await expect(saveWorktreeDefault('full-access')).rejects.toMatchObject({
      name: 'StorageOutcomeUnknownError',
    });
    expect(
      JSON.parse(await readFile(mockPreferencesPath, 'utf8')),
    ).toMatchObject({
      preferences: { approvalDefaults: { worktree: 'full-access' } },
    });
    expect(await newChatMode()).toBe('ask');
    expect(peekPreferencesLoadError()).toBeNull();

    await updatePreferencesFile(() => ({ worktreePanelPercent: 40 }));
    expect(await newChatMode()).toBe('full-access');
  });

  it('applies an unconfirmed lowering of the default', async () => {
    await writeFile(
      mockPreferencesPath,
      preferencesWithDefaults({ ...askEverywhere, worktree: 'full-access' }),
    );
    failNextPreferencesFlush();
    await expect(saveWorktreeDefault('ask')).rejects.toMatchObject({
      name: 'StorageOutcomeUnknownError',
    });
    expect(await newChatMode()).toBe('ask');
  });

  it('keeps the first confirmed authority across two unconfirmed saves', async () => {
    await writeFile(
      mockPreferencesPath,
      preferencesWithDefaults(askEverywhere),
    );
    failNextPreferencesFlush();
    await expect(saveWorktreeDefault('full-access')).rejects.toMatchObject({
      name: 'StorageOutcomeUnknownError',
    });
    failNextPreferencesFlush();
    await expect(
      updatePreferencesFile((previous) => ({
        approvalDefaults: { ...previous.approvalDefaults, cowork: 'auto' },
        globalApprovalRules: [grant],
      })),
    ).rejects.toMatchObject({ name: 'StorageOutcomeUnknownError' });
    const { defaults } = await readApprovalPreferencesForSurface('cowork');
    expect(defaults).toEqual(askEverywhere);
    expect((await readGlobalApprovalRuleTier()).rules).toEqual([]);

    await updatePreferencesFile(() => ({ worktreePanelPercent: 40 }));
    expect(
      (await readApprovalPreferencesForSurface('cowork')).defaults,
    ).toEqual({ ...askEverywhere, worktree: 'full-access', cowork: 'auto' });
    expect((await readGlobalApprovalRuleTier()).rules).toEqual([grant]);
  });

  it('keeps the confirmed default when a save fails before it installs', async () => {
    await writeFile(
      mockPreferencesPath,
      preferencesWithDefaults({ ...askEverywhere, worktree: 'full-access' }),
    );
    const spy = jest.spyOn(fs, 'open').mockImplementation((...args) => {
      if (String(args[0]).includes('.preferences.json.'))
        return Promise.reject(new Error('write failed'));
      return open(...args);
    });
    await expect(saveWorktreeDefault('ask')).rejects.toThrow('write failed');
    spy.mockRestore();
    expect(await newChatMode()).toBe('full-access');
  });

  it('does not use an escalated default read before its save is confirmed', async () => {
    await writeFile(
      mockPreferencesPath,
      preferencesWithDefaults(askEverywhere),
    );
    const readHeld = Promise.withResolvers<void>();
    const readReleased = Promise.withResolvers<void>();
    const readDone = Promise.withResolvers<void>();
    let holdNextRead = true;
    jest.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      if (args[0] !== mockPreferencesPath || !holdNextRead)
        return readFile(...args);
      holdNextRead = false;
      readHeld.resolve();
      await readReleased.promise;
      const value = await readFile(...args);
      readDone.resolve();
      return value;
    });
    // The read starts before the save registers its barrier.
    const mode = newChatMode();
    await readHeld.promise;
    const flushReached = Promise.withResolvers<void>();
    const flushReleased = Promise.withResolvers<void>();
    failFlushAfterInstallOf(mockPreferencesPath, async (): Promise<void> => {
      flushReached.resolve();
      await flushReleased.promise;
      throw Object.assign(new Error('flush failed'), { code: 'EIO' });
    });
    const save = saveWorktreeDefault('full-access');
    await flushReached.promise;
    readReleased.resolve();
    await readDone.promise;
    flushReleased.resolve();
    await expect(save).rejects.toMatchObject({
      name: 'StorageOutcomeUnknownError',
    });
    expect(await mode).toBe('ask');
  });
});
