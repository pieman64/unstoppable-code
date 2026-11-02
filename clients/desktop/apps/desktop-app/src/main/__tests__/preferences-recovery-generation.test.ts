import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  ApprovalDefaults,
  ApprovalRule,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import type * as paths from '../lib/paths';
import type * as PreferencesStore from '../lib/preferences-store';
import type * as RuleSources from '../approvals/approval-rule-sources';
import type * as ModeResolution from '../lib/approval-mode-resolution';
import type * as ApprovalService from '../approvals/approval-service';
import type * as ApprovalsPersistence from '../lib/approvals-persistence';

// CAN-5154 (CAN-4469 F1 PR8): recovery restores last-good only when the
// generation record proves it current. Each "restart" loads a fresh module
// graph over the same files.

// Each restart imports the approval graph afresh; that can exceed 5 s on a
// loaded host.
jest.setTimeout(30_000);

let mockPreferencesPath: string;
jest.mock('../lib/paths', () => ({
  ...jest.requireActual<typeof paths>('../lib/paths'),
  getPreferencesFilePath: (): string => mockPreferencesPath,
}));

interface App {
  store: typeof PreferencesStore;
  rules: typeof RuleSources;
  modes: typeof ModeResolution;
  approvals: typeof ApprovalService;
  persistence: typeof ApprovalsPersistence;
}

const open = fs.open;
const rename = fs.rename;
const readFile = fs.readFile;
const WORKSPACE_ID = 'ws-generation';
const FULL_ACCESS: ApprovalDefaults = {
  worktree: 'full-access',
  cowork: 'full-access',
  appAdvisor: 'full-access',
};
const ASK: ApprovalDefaults = {
  worktree: 'ask',
  cowork: 'ask',
  appAdvisor: 'ask',
};

function rule(
  id: string,
  behavior: 'allow' | 'deny',
  pattern: string,
): ApprovalRule {
  return {
    id,
    behavior,
    origin: 'settings',
    createdAt: '2026-10-31T00:00:00.000Z',
    target: { kind: 'command', pattern },
  };
}

const allowTest = rule('allow-test', 'allow', 'npm test *');
const denyRemove = rule('deny-remove', 'deny', 'rm -rf *');
/** Written by a build before CAN-5154: no `generation`. */
const legacyLastGood = JSON.stringify({
  version: 1,
  preferences: { globalApprovalRules: [allowTest] },
});

let root: string;
let dataRoot: string;
let app: App | undefined;
let trace: string[];
let failingWrites: Set<string>;
let failDirSyncAfterRenameOf: string | null;
let failNextDirSync: boolean;
let mainReadError: string | null;
let generationReadError: string | null;
let lastGoodReadError: string | null;
const inheritedDataDir = process.env.CANOPY_DATA_DIR;

const lastGoodPath = (): string => join(root, 'preferences.last-good.json');
const generationPath = (): string => join(root, 'preferences.generation.json');

/** `.<name>.<pid>.<uuid>.tmp` → `<name>` */
function tempTarget(path: string): string | null {
  return /^\.(.+)\.\d+\.[0-9a-f-]{36}\.tmp$/.exec(basename(path))?.[1] ?? null;
}

function installFaults(): void {
  jest.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    const target = typeof path === 'string' ? tempTarget(path) : null;
    if (flags === 'wx' && target !== null) {
      const fault = Array.from(failingWrites).find((name: string) =>
        target.startsWith(name),
      );
      if (fault !== undefined)
        throw Object.assign(new Error(`injected ${fault} write`), {
          code: 'EIO',
        });
    }
    const handle = await open(path, flags, mode);
    const sync = handle.sync.bind(handle);
    if (flags === 'wx' && target !== null) {
      handle.sync = async (): Promise<void> => {
        await sync();
        trace.push(`sync ${target}`);
      };
    } else if (path === root && (flags === 'r' || flags === 'r+')) {
      handle.sync = async (): Promise<void> => {
        if (failNextDirSync) {
          failNextDirSync = false;
          trace.push('dir-sync failed');
          throw Object.assign(new Error('flush failed'), { code: 'EIO' });
        }
        await sync();
        trace.push('dir-sync');
      };
    }
    return handle;
  });
  jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    await rename(from, to);
    const name = basename(String(to));
    trace.push(`rename ${name}`);
    if (
      failDirSyncAfterRenameOf !== null &&
      name.startsWith(failDirSyncAfterRenameOf)
    ) {
      failDirSyncAfterRenameOf = null;
      failNextDirSync = true;
    }
  });
  jest.spyOn(fs, 'readFile').mockImplementation((...args) => {
    if (args[0] === mockPreferencesPath && mainReadError !== null)
      return Promise.reject(
        Object.assign(new Error('injected read'), { code: mainReadError }),
      );
    if (args[0] === generationPath() && generationReadError !== null)
      return Promise.reject(
        Object.assign(new Error('injected read'), {
          code: generationReadError,
        }),
      );
    if (args[0] === lastGoodPath() && lastGoodReadError !== null)
      return Promise.reject(
        Object.assign(new Error('injected read'), { code: lastGoodReadError }),
      );
    return readFile(...args);
  });
}

/**
 * A fresh process over the same files; faults are not carried over. Without
 * `flush`, the old process's pending writes stand in for a crash.
 */
async function restart({ flush = true } = {}): Promise<App> {
  if (app && flush) await app.store.flushPreferencesWrites();
  failingWrites.clear();
  mainReadError = null;
  generationReadError = null;
  lastGoodReadError = null;
  jest.resetModules();
  app = {
    store: await import('../lib/preferences-store'),
    rules: await import('../approvals/approval-rule-sources'),
    modes: await import('../lib/approval-mode-resolution'),
    approvals: await import('../approvals/approval-service'),
    persistence: await import('../lib/approvals-persistence'),
  };
  return app;
}

async function commit(
  current: App,
  patch: (latest: PreferencesData) => Partial<PreferencesData>,
): Promise<void> {
  await current.store.updatePreferencesFile(patch);
  await current.store.flushPreferencesWrites();
}

async function inventory(): Promise<Record<string, string>> {
  const entries = (await fs.readdir(root)).sort();
  return Object.fromEntries(
    await Promise.all(
      entries.map(
        async (name): Promise<[string, string]> => [
          name,
          (await readFile(join(root, name))).toString('base64'),
        ],
      ),
    ),
  );
}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** Temporary files the writers create from here on. */
function recordCreatedFiles(): string[] {
  const created: string[] = [];
  const installed = jest.mocked(fs.open).getMockImplementation();
  jest.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    if (flags === 'wx') created.push(String(path));
    if (installed === undefined) return open(path, flags, mode);
    return installed(path, flags, mode);
  });
  return created;
}

/** The record and main both carry `generation`, written durably. */
async function expectStamped(
  generation: number,
  rules: ApprovalRule[],
): Promise<void> {
  await app?.store.flushPreferencesWrites();
  expect(trace).toEqual(
    expect.arrayContaining([
      'sync preferences.generation.json',
      'rename preferences.generation.json',
      'sync preferences.json',
      'rename preferences.json',
    ]),
  );
  expect(await json(generationPath())).toEqual({ version: 1, generation });
  expect(await json(mockPreferencesPath)).toMatchObject({
    generation,
    preferences: { globalApprovalRules: rules },
  });
}

async function evaluate(
  current: App,
  command: string,
  mode: 'full-access' | 'ask' = 'full-access',
): Promise<string> {
  const session = current.approvals.createApprovalSession({
    sessionKey: `generation-${mode}-${command}`,
    projectId: WORKSPACE_ID,
    worktreeId: 'wt-1',
    chatId: 'chat-1',
    provider: 'claude',
    workspaceRoot: dataRoot,
    mode,
    sessionRules: [],
    getWindow: () => null,
    trackChatTurn: false,
  });
  try {
    return (await session.evaluate?.({ kind: 'command', command })) ?? 'none';
  } finally {
    session.dispose();
  }
}

async function worktreeDefault(current: App): Promise<string> {
  return (await current.modes.readApprovalPreferencesForSurface('worktree'))
    .defaults.worktree;
}

/** Degraded authority (P8): Ask, no allows, refused writes. */
async function expectDegraded(
  current: App,
  denies: ApprovalRule[] = [],
): Promise<void> {
  expect(await current.rules.readGlobalApprovalRuleTier()).toEqual({
    rules: denies,
    unreadable: true,
  });
  expect(await worktreeDefault(current)).toBe('ask');
  expect(await evaluate(current, 'npm test unit')).toBe('prompt');
  await expect(
    current.store.updatePreferencesFile(() => ({ sidebarCollapsed: true })),
  ).rejects.toMatchObject({ code: 'PREFERENCES_RECOVERY_REQUIRED' });
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'preferences-generation-'));
  dataRoot = await fs.mkdtemp(join(tmpdir(), 'preferences-generation-data-'));
  process.env.CANOPY_DATA_DIR = dataRoot;
  mockPreferencesPath = join(root, 'preferences.json');
  trace = [];
  failingWrites = new Set();
  failDirSyncAfterRenameOf = null;
  failNextDirSync = false;
  mainReadError = null;
  generationReadError = null;
  lastGoodReadError = null;
  app = undefined;
  installFaults();
  const current = await restart();
  await current.persistence.writeWorkspaceApprovals(WORKSPACE_ID, {
    version: 1,
    rules: [],
  });
});

afterEach(async () => {
  await app?.store.flushPreferencesWrites();
  jest.restoreAllMocks();
  app?.store.resetPreferencesLoadErrorForTests();
  app = undefined;
  if (inheritedDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = inheritedDataDir;
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(dataRoot, { recursive: true, force: true });
});

describe('CAN-5154 generation record', () => {
  it('durably records each generation before main is replaced', async () => {
    const current = app ?? (await restart());
    await commit(current, () => ({ sidebarCollapsed: true }));
    trace = [];
    await commit(current, () => ({ sidebarCollapsed: false }));
    expect(await json(generationPath())).toEqual({ version: 1, generation: 2 });
    for (const path of [mockPreferencesPath, lastGoodPath()])
      expect(await json(path)).toMatchObject({ version: 1, generation: 2 });
    const at = (event: string): number => trace.indexOf(event);
    expect(at('sync preferences.generation.json')).toBeGreaterThanOrEqual(0);
    expect(at('sync preferences.generation.json')).toBeLessThan(
      at('rename preferences.generation.json'),
    );
    // The record's folder flush lands before main's install.
    expect(
      trace.indexOf('dir-sync', at('rename preferences.generation.json')),
    ).toBeLessThan(at('rename preferences.json'));
  });

  it('does not replace main when the record write has an unknown outcome', async () => {
    const current = app ?? (await restart());
    await commit(current, () => ({ globalApprovalRules: [allowTest] }));
    const before = await readFile(mockPreferencesPath, 'utf8');
    trace = [];
    failDirSyncAfterRenameOf = 'preferences.generation.json';
    await expect(
      current.store.updatePreferencesFile(() => ({ globalApprovalRules: [] })),
    ).rejects.toMatchObject({ name: 'StorageOutcomeUnknownError' });
    expect(await readFile(mockPreferencesPath, 'utf8')).toBe(before);
    expect(trace).not.toContain('rename preferences.json');
    expect(await current.rules.readGlobalApprovalRuleTier()).toEqual({
      rules: [allowTest],
      unreadable: false,
    });
  });

  it('continues past a record that a downgrade left ahead of main', async () => {
    const current = app ?? (await restart());
    await fs.writeFile(
      generationPath(),
      JSON.stringify({ version: 1, generation: 7 }),
    );
    await fs.writeFile(
      mockPreferencesPath,
      JSON.stringify({ version: 1, preferences: { sidebarCollapsed: true } }),
    );
    await commit(current, () => ({ worktreePanelPercent: 40 }));
    expect(await json(mockPreferencesPath)).toMatchObject({ generation: 8 });
    expect(await json(generationPath())).toEqual({ version: 1, generation: 8 });
  });

  it.each(['main', 'record', 'last-good'])(
    'refuses a save, writing nothing, when the %s holds the last safe generation',
    async (holder) => {
      let current = app ?? (await restart());
      await commit(current, () => ({ globalApprovalRules: [allowTest] }));
      const saturate = async (path: string): Promise<void> => {
        const document: unknown = JSON.parse(await readFile(path, 'utf8'));
        await fs.writeFile(
          path,
          JSON.stringify(
            Object.assign({}, document, {
              generation: Number.MAX_SAFE_INTEGER,
            }),
          ),
        );
      };
      if (holder === 'main') await saturate(mockPreferencesPath);
      if (holder === 'record') await saturate(generationPath());
      if (holder === 'last-good') {
        // Last-good sets the floor only when the record is unreadable.
        await saturate(lastGoodPath());
        await fs.writeFile(generationPath(), '{torn');
      }

      current = await restart();
      const before = await inventory();
      await expect(
        current.store.updatePreferencesFile(() => ({
          globalApprovalRules: [],
        })),
      ).rejects.toMatchObject({ code: 'PREFERENCES_GENERATION_EXHAUSTED' });
      await current.store.flushPreferencesWrites();
      expect(await inventory()).toEqual(before);
      expect(await current.rules.readGlobalApprovalRuleTier()).toEqual({
        rules: [allowTest],
        unreadable: false,
      });
    },
  );

  it.each([
    { generation: 2 ** 60, label: 'unsafe' },
    { generation: '3', label: 'a string' },
    { generation: -1, label: 'negative' },
  ])(
    "refuses a save, writing nothing, when main's generation is $label",
    async ({ generation }) => {
      let current = app ?? (await restart());
      await commit(current, () => ({ globalApprovalRules: [allowTest] }));
      await fs.writeFile(
        mockPreferencesPath,
        JSON.stringify({
          version: 1,
          generation,
          preferences: { globalApprovalRules: [allowTest] },
        }),
      );

      current = await restart();
      const before = await inventory();
      await expect(
        current.store.updatePreferencesFile(() => ({
          globalApprovalRules: [],
        })),
      ).rejects.toMatchObject({ code: 'PREFERENCES_GENERATION_UNKNOWN' });
      await current.store.flushPreferencesWrites();
      expect(await inventory()).toEqual(before);
    },
  );
});

describe('CAN-5154 stale last-good is never restored', () => {
  it.each(['deleted', 'emptied'])(
    'A1: a revoked allow stays revoked after main is %s and last-good is stale',
    async (loss) => {
      let current = app ?? (await restart());
      await commit(current, () => ({ globalApprovalRules: [allowTest] }));
      failingWrites.add('preferences.last-good.json');
      await commit(current, () => ({ globalApprovalRules: [] }));
      expect(await readFile(lastGoodPath(), 'utf8')).toContain(allowTest.id);
      if (loss === 'deleted') await fs.unlink(mockPreferencesPath);
      else await fs.writeFile(mockPreferencesPath, '');

      current = await restart();
      const before = await inventory();
      await current.store.readPreferencesFile();
      expect(current.store.peekPreferencesLoadError()).not.toBeNull();
      expect(await inventory()).toEqual(before);
      await expectDegraded(current);
      current.store.acknowledgePreferencesLoadError();
      await expectDegraded(current);
      expect(await inventory()).toEqual(before);

      current = await restart();
      await expectDegraded(current);
      expect(await inventory()).toEqual(before);
    },
  );

  it('C-X1: corrupt main with stale last-good restores nothing and stays degraded across acknowledgement and restarts', async () => {
    let current = app ?? (await restart());
    await commit(current, () => ({
      approvalDefaults: FULL_ACCESS,
      globalApprovalRules: [allowTest],
    }));
    failingWrites.add('preferences.last-good.json');
    await commit(current, () => ({
      approvalDefaults: ASK,
      globalApprovalRules: [],
    }));
    const corrupt = '{"version":1,"generation":2,"preferences":{"approvalDef';
    await fs.writeFile(mockPreferencesPath, corrupt);

    current = await restart();
    const before = await inventory();
    expect(await current.store.readPreferencesFile()).toMatchObject({
      globalApprovalRules: [allowTest],
    });
    expect(current.store.peekPreferencesLoadError()).toMatchObject({
      reason: 'parse',
      backupPath: undefined,
      restoredFromPath: lastGoodPath(),
    });
    await expectDegraded(current);
    current.store.acknowledgePreferencesLoadError();
    await expectDegraded(current);

    current = await restart();
    await expectDegraded(current);
    expect(await readFile(mockPreferencesPath, 'utf8')).toBe(corrupt);
    expect(await inventory()).toEqual(before);
  });

  it('C-X1-ctl: corrupt main with a current last-good is restored with nothing lost', async () => {
    let current = app ?? (await restart());
    await commit(current, () => ({ approvalDefaults: FULL_ACCESS }));
    await commit(current, () => ({
      approvalDefaults: ASK,
      globalApprovalRules: [denyRemove],
    }));
    await fs.writeFile(mockPreferencesPath, '{"version":1,"prefer');

    current = await restart();
    await current.store.readPreferencesFile();
    expect(current.store.peekPreferencesLoadError()).toMatchObject({
      restoredFromPath: lastGoodPath(),
    });
    expect(await json(mockPreferencesPath)).toMatchObject({
      generation: 2,
      preferences: { globalApprovalRules: [denyRemove] },
    });

    current = await restart();
    expect(await worktreeDefault(current)).toBe('ask');
    expect(await current.rules.readGlobalApprovalRuleTier()).toEqual({
      rules: [denyRemove],
      unreadable: false,
    });
    expect(current.store.peekPreferencesLoadError()).toBeNull();
  });

  it('C-R2: one EIO on main with a stale last-good writes nothing, and the deny rule and Ask survive restart', async () => {
    let current = app ?? (await restart());
    await commit(current, () => ({ approvalDefaults: FULL_ACCESS }));
    failingWrites.add('preferences.last-good.json');
    await commit(current, (latest) => ({
      approvalDefaults: ASK,
      globalApprovalRules: [...latest.globalApprovalRules, denyRemove],
    }));

    current = await restart();
    const before = await inventory();
    mainReadError = 'EIO';
    expect((await current.rules.readGlobalApprovalRuleTier()).unreadable).toBe(
      true,
    );
    await current.store.readPreferencesFile();
    expect(await worktreeDefault(current)).toBe('ask');
    expect(await inventory()).toEqual(before);

    current = await restart();
    expect(await current.rules.readGlobalApprovalRuleTier()).toEqual({
      rules: [denyRemove],
      unreadable: false,
    });
    expect(await worktreeDefault(current)).toBe('ask');
    expect(await evaluate(current, 'rm -rf build')).toBe('deny');
  });

  it('C-R2w: while main stays unreadable the newer deny falls to a prompt, never an allow', async () => {
    let current = app ?? (await restart());
    await commit(current, () => ({ approvalDefaults: FULL_ACCESS }));
    failingWrites.add('preferences.last-good.json');
    await commit(current, (latest) => ({
      approvalDefaults: ASK,
      globalApprovalRules: [...latest.globalApprovalRules, denyRemove],
    }));

    current = await restart();
    mainReadError = 'EIO';
    await current.store.readPreferencesFile();
    expect(await evaluate(current, 'rm -rf build')).toBe('prompt');
    expect(await worktreeDefault(current)).toBe('ask');
  });

  it('C-R4b: a revocation whose last-good refresh failed survives a later EIO and then main loss', async () => {
    let current = app ?? (await restart());
    await commit(current, () => ({ globalApprovalRules: [allowTest] }));
    failingWrites.add('preferences.last-good.json');
    await commit(current, () => ({ globalApprovalRules: [] }));

    current = await restart();
    const before = await inventory();
    mainReadError = 'EIO';
    await current.store.readPreferencesFile();
    await expectDegraded(current);
    expect(await inventory()).toEqual(before);

    current = await restart();
    expect(await evaluate(current, 'npm test unit', 'ask')).toBe('prompt');
    expect(await current.rules.readGlobalApprovalRuleTier()).toEqual({
      rules: [],
      unreadable: false,
    });
    await fs.unlink(mockPreferencesPath);

    current = await restart();
    await current.store.readPreferencesFile();
    await expectDegraded(current);
    await expect(fs.stat(mockPreferencesPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('C-R4: a revocation queued behind a held recovery lands after it and stays', async () => {
    let current = app ?? (await restart());
    await commit(current, () => ({ globalApprovalRules: [allowTest] }));
    await fs.writeFile(mockPreferencesPath, '{"version":1,"prefer');

    current = await restart();
    trace = [];
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const traced = jest.mocked(fs.rename).getMockImplementation();
    jest.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (to === mockPreferencesPath && !trace.includes('held')) {
        trace.push('held');
        reached.resolve();
        await release.promise;
      }
      await traced?.(from, to);
    });
    const recovery = current.store.readPreferencesFile();
    await reached.promise;
    const revocation = current.store.updatePreferencesFile(() => ({
      globalApprovalRules: [],
    }));
    release.resolve();
    expect(await recovery).toMatchObject({ globalApprovalRules: [allowTest] });
    await revocation;
    expect(
      trace.filter((event) => event === 'rename preferences.json'),
    ).toHaveLength(2);
    await current.store.flushPreferencesWrites();
    for (const path of [mockPreferencesPath, lastGoodPath()])
      expect(await json(path)).toMatchObject({
        generation: 2,
        preferences: { globalApprovalRules: [] },
      });

    current = await restart();
    expect(await evaluate(current, 'npm test unit', 'ask')).toBe('prompt');
    expect(await current.rules.readGlobalApprovalRuleTier()).toEqual({
      rules: [],
      unreadable: false,
    });
  });

  it('C-MR1: an Ask restriction whose last-good refresh failed survives a later EIO and restart', async () => {
    let current = app ?? (await restart());
    await commit(current, () => ({ approvalDefaults: FULL_ACCESS }));
    failingWrites.add('preferences.last-good.json');
    await commit(current, (latest) => ({
      approvalDefaults: { ...latest.approvalDefaults, worktree: 'ask' },
    }));
    expect(await json(lastGoodPath())).toMatchObject({
      preferences: { approvalDefaults: { worktree: 'full-access' } },
    });

    current = await restart();
    mainReadError = 'EIO';
    expect(await worktreeDefault(current)).toBe('ask');

    current = await restart();
    expect(await worktreeDefault(current)).toBe('ask');
    expect(current.store.peekPreferencesLoadError()).toBeNull();
  });
});

describe('CAN-5154 O5 and T1: missing main', () => {
  it('restores a missing main when the record matches last-good', async () => {
    let current = app ?? (await restart());
    await commit(current, () => ({ globalApprovalRules: [allowTest] }));
    await fs.unlink(mockPreferencesPath);

    current = await restart();
    await current.store.readPreferencesFile();
    expect(await json(mockPreferencesPath)).toMatchObject({
      generation: 1,
      preferences: { globalApprovalRules: [allowTest] },
    });
    expect(await current.rules.readGlobalApprovalRuleTier()).toEqual({
      rules: [allowTest],
      unreadable: false,
    });
  });

  it.each([
    { record: 'unreadable', error: 'EIO' },
    { record: 'corrupt', error: null },
  ])(
    'keeps prompting without restoring when the record is $record',
    async ({ record, error }) => {
      let current = app ?? (await restart());
      await fs.writeFile(lastGoodPath(), legacyLastGood);
      if (record === 'corrupt') await fs.writeFile(generationPath(), '{torn');
      if (record === 'unreadable')
        await fs.writeFile(
          generationPath(),
          JSON.stringify({ version: 1, generation: 0 }),
        );

      current = await restart();
      generationReadError = error;
      const before = await inventory();
      await current.store.readPreferencesFile();
      expect(await inventory()).toEqual(before);
      await expectDegraded(current);
    },
  );

  it('T1: starts fresh with Full Access when main and last-good are both missing, even with a record', async () => {
    // Pins Mike's CAN-4469 T1 decision: the record is not existence proof.
    let current = app ?? (await restart());
    await commit(current, () => ({
      approvalDefaults: ASK,
      globalApprovalRules: [denyRemove],
    }));
    await fs.unlink(mockPreferencesPath);
    await fs.unlink(lastGoodPath());

    current = await restart();
    expect((await current.store.readPreferencesFileDetailed()).authority).toBe(
      'absent',
    );
    expect(await worktreeDefault(current)).toBe('full-access');
    await commit(current, () => ({ sidebarCollapsed: true }));
    expect(await json(mockPreferencesPath)).toMatchObject({ generation: 2 });
  });
});

describe('CAN-5154 legacy profiles: no record was ever written', () => {
  const legacyMain = (rules: ApprovalRule[]): string =>
    JSON.stringify({ version: 1, preferences: { globalApprovalRules: rules } });

  it.each(['missing', 'corrupt'])(
    'restores a legacy last-good over a %s main, and the first save retires it',
    async (state) => {
      let current = app ?? (await restart());
      await fs.writeFile(lastGoodPath(), legacyLastGood);
      if (state === 'corrupt')
        await fs.writeFile(mockPreferencesPath, '{"version":1,"prefer');

      current = await restart();
      await current.store.readPreferencesFile();
      expect(current.store.peekPreferencesLoadError()).toMatchObject({
        restoredFromPath: lastGoodPath(),
      });
      expect(await current.rules.readGlobalApprovalRuleTier()).toEqual({
        rules: [allowTest],
        unreadable: false,
      });
      await expect(fs.stat(generationPath())).rejects.toMatchObject({
        code: 'ENOENT',
      });

      expect(await current.store.stampPreferencesGeneration()).toBe('stamped');
      await current.store.flushPreferencesWrites();
      expect(await json(generationPath())).toEqual({
        version: 1,
        generation: 1,
      });
      for (const path of [mockPreferencesPath, lastGoodPath()])
        expect(await json(path)).toMatchObject({
          generation: 1,
          preferences: { globalApprovalRules: [allowTest] },
        });

      // Retired: strict O5 now refuses a last-good behind the record.
      failingWrites.add('preferences.last-good.json');
      await commit(current, () => ({ globalApprovalRules: [] }));
      await fs.unlink(mockPreferencesPath);
      current = await restart();
      await current.store.readPreferencesFile();
      await expectDegraded(current);
    },
  );

  it.each([
    {
      evidence: 'last-good carries a generation',
      arrange: async (current: App): Promise<void> => {
        await commit(current, () => ({ globalApprovalRules: [allowTest] }));
        await fs.unlink(mockPreferencesPath);
      },
    },
    {
      evidence: 'main carries a generation',
      arrange: async (): Promise<void> => {
        await fs.writeFile(lastGoodPath(), legacyLastGood);
        await fs.writeFile(
          mockPreferencesPath,
          JSON.stringify({ version: 1, generation: 3 }),
        );
      },
    },
    {
      evidence: 'main carries an unsafe generation',
      arrange: async (): Promise<void> => {
        await fs.writeFile(lastGoodPath(), legacyLastGood);
        await fs.writeFile(
          mockPreferencesPath,
          JSON.stringify({ version: 1, generation: 2 ** 60 }),
        );
      },
    },
    {
      evidence: 'last-good carries an invalid generation',
      arrange: async (): Promise<void> => {
        await fs.writeFile(
          lastGoodPath(),
          JSON.stringify({
            version: 1,
            generation: '3',
            preferences: { globalApprovalRules: [allowTest] },
          }),
        );
      },
    },
  ])(
    'refuses when the record was written and lost: $evidence',
    async ({ arrange }) => {
      let current = app ?? (await restart());
      await arrange(current);
      await fs.rm(generationPath(), { force: true });

      current = await restart();
      const before = await inventory();
      await current.store.readPreferencesFile();
      expect(await inventory()).toEqual(before);
      await expectDegraded(current);
      expect(await current.store.stampPreferencesGeneration()).toBe('degraded');
      expect(await inventory()).toEqual(before);
    },
  );

  it('stamps a readable legacy main without changing its preferences', async () => {
    let current = app ?? (await restart());
    await fs.writeFile(mockPreferencesPath, legacyMain([denyRemove]));

    current = await restart();
    expect(await current.store.stampPreferencesGeneration()).toBe('stamped');
    await current.store.flushPreferencesWrites();
    expect(await json(generationPath())).toEqual({ version: 1, generation: 1 });
    expect(await json(mockPreferencesPath)).toMatchObject({
      generation: 1,
      preferences: { globalApprovalRules: [denyRemove] },
    });
    expect(await current.store.stampPreferencesGeneration()).toBe('present');
    expect(await json(generationPath())).toEqual({ version: 1, generation: 1 });
  });

  it('writes nothing for a fresh profile (T1)', async () => {
    const current = app ?? (await restart());
    const before = await inventory();
    expect(await current.store.stampPreferencesGeneration()).toBe('fresh');
    expect(await inventory()).toEqual(before);
  });

  it("the stamp's own read refusing recovery latches and writes nothing", async () => {
    let current = app ?? (await restart());
    await commit(current, () => ({ globalApprovalRules: [allowTest] }));
    await fs.unlink(mockPreferencesPath);
    await fs.unlink(generationPath());

    current = await restart();
    const before = await inventory();
    expect(await current.store.stampPreferencesGeneration()).toBe('degraded');
    expect(await inventory()).toEqual(before);
    await expectDegraded(current);
  });

  it('keeps queued user saves in order and skips once a save recorded first', async () => {
    let current = app ?? (await restart());
    await fs.writeFile(mockPreferencesPath, legacyMain([]));

    current = await restart();
    const first = current.store.updatePreferencesFile(() => ({
      worktreePanelPercent: 41,
    }));
    const stamp = current.store.stampPreferencesGeneration();
    const second = current.store.updatePreferencesFile(() => ({
      sidebarCollapsed: true,
    }));
    await Promise.all([first, second]);
    expect(await stamp).toBe('present');
    await current.store.flushPreferencesWrites();
    expect(await json(generationPath())).toEqual({ version: 1, generation: 2 });
    expect(await json(mockPreferencesPath)).toMatchObject({
      generation: 2,
      preferences: { worktreePanelPercent: 41, sidebarCollapsed: true },
    });
  });

  it('retries a failed stamp in the background until a save lands', async () => {
    let current = app ?? (await restart());
    await fs.writeFile(mockPreferencesPath, legacyMain([denyRemove]));

    current = await restart();
    failingWrites.add('preferences.generation.json');
    const delays: number[] = [];
    const outcome = await current.store.startPreferencesGenerationStamp(
      (delayMs) => {
        delays.push(delayMs);
        if (delays.length === 3) failingWrites.clear();
        return Promise.resolve(true);
      },
    );
    expect(outcome).toBe('stamped');
    expect(delays).toEqual([30_000, 30_000, 60_000]);
    expect(await json(generationPath())).toEqual({ version: 1, generation: 1 });
  });

  it('stops retrying once recovery is latched', async () => {
    let current = app ?? (await restart());
    await fs.writeFile(lastGoodPath(), legacyLastGood);
    await fs.writeFile(generationPath(), '{torn');

    current = await restart();
    await current.store.readPreferencesFile();
    const delays: number[] = [];
    expect(
      await current.store.startPreferencesGenerationStamp((delayMs) => {
        delays.push(delayMs);
        return Promise.resolve(true);
      }),
    ).toBe('degraded');
    expect(delays).toEqual([30_000]);
  });

  it('waits off the startup path and stops at quit without writing', async () => {
    let current = app ?? (await restart());
    await fs.writeFile(mockPreferencesPath, legacyMain([]));

    current = await restart();
    const before = await inventory();
    const run = current.store.startPreferencesGenerationStamp();
    expect(current.store.startPreferencesGenerationStamp()).toBe(run);
    current.store.stopPreferencesGenerationStamp();
    expect(await run).toBe('stopped');
    expect(await inventory()).toEqual(before);
  });

  it('keeps retrying when the record landed but main did not', async () => {
    let current = app ?? (await restart());
    await fs.writeFile(mockPreferencesPath, legacyMain([denyRemove]));

    current = await restart();
    failingWrites.add('preferences.json');
    let attempts = 0;
    const outcome = await current.store.startPreferencesGenerationStamp(() => {
      attempts += 1;
      if (attempts === 3) failingWrites.clear();
      return Promise.resolve(true);
    });
    expect(outcome).toBe('stamped');
    expect(attempts).toBe(3);
    // Each failed attempt still advanced the record.
    expect(await json(generationPath())).toEqual({ version: 1, generation: 3 });
    expect(await json(mockPreferencesPath)).toMatchObject({
      generation: 3,
      preferences: { globalApprovalRules: [denyRemove] },
    });
  });

  it.each([
    { probe: 'the record read', path: generationPath },
    {
      probe: 'the preferences file check',
      path: (): string => mockPreferencesPath,
    },
  ])(
    'a quit during $probe, before the attempt is queued, queues nothing',
    async ({ path }) => {
      let current = app ?? (await restart());
      await fs.writeFile(mockPreferencesPath, legacyMain([]));

      current = await restart();
      const before = await inventory();
      const probed = path();
      const stop = (target: unknown): void => {
        if (target === probed) current.store.stopPreferencesGenerationStamp();
      };
      // The queued save reads main first; the probes before it do not.
      let mainReads = 0;
      jest.spyOn(fs, 'readFile').mockImplementation((...args) => {
        stop(args[0]);
        if (args[0] === mockPreferencesPath) mainReads += 1;
        return readFile(...args);
      });
      const stat = fs.stat;
      jest.spyOn(fs, 'stat').mockImplementation((...args) => {
        stop(args[0]);
        return stat(...args);
      });
      const created = recordCreatedFiles();
      const run = current.store.startPreferencesGenerationStamp(() =>
        Promise.resolve(true),
      );
      expect(await run).toBe('stopped');
      await current.store.flushPreferencesWrites();
      expect(mainReads).toBe(0);
      expect(created).toEqual([]);
      expect(await inventory()).toEqual(before);
    },
  );

  it.each([
    { ahead: 'writes nothing', patch: null, outcome: 'stamped' },
    { ahead: 'saves first', patch: {}, outcome: 'present' },
  ])(
    'a quit while the attempt waits behind a save that $ahead lets it end as $outcome',
    async ({ patch, outcome }) => {
      let current = app ?? (await restart());
      await fs.writeFile(mockPreferencesPath, legacyMain([denyRemove]));

      current = await restart();
      const gate = Promise.withResolvers<void>();
      const aheadReached = Promise.withResolvers<void>();
      const ahead = current.store.updatePreferencesFileWithPrevious(
        async () => {
          aheadReached.resolve();
          await gate.promise;
          return patch;
        },
      );
      // From here only the stamp's probes touch the files.
      await aheadReached.promise;
      const created = recordCreatedFiles();
      // The stamp queues right after its last probe, a stat of main.
      const queued = Promise.withResolvers<void>();
      const stat = fs.stat;
      jest.spyOn(fs, 'stat').mockImplementation(async (...args) => {
        const stats = await stat(...args);
        if (args[0] === mockPreferencesPath) setImmediate(queued.resolve);
        return stats;
      });
      const run = current.store.startPreferencesGenerationStamp(() =>
        Promise.resolve(true),
      );
      await queued.promise;
      current.store.stopPreferencesGenerationStamp();
      gate.resolve();
      await ahead;
      expect(await run).toBe(outcome);
      await expectStamped(1, [denyRemove]);
      // One save wrote the record: the stamp or the save ahead, never both.
      expect(
        created.filter(
          (path) => tempTarget(path) === basename(generationPath()),
        ),
      ).toHaveLength(1);
    },
  );

  // Outside the queue the record is read once and main is not read.
  it.each([
    { step: "the queued save's read of main", target: 'main', nth: 1 },
    { step: 'the queued recheck', target: 'record', nth: 2 },
    { step: 'the generation step', target: 'record', nth: 3 },
  ])('a quit during $step lets the save complete', async ({ target, nth }) => {
    let current = app ?? (await restart());
    await fs.writeFile(mockPreferencesPath, legacyMain([denyRemove]));

    current = await restart();
    const path = target === 'main' ? mockPreferencesPath : generationPath();
    let reads = 0;
    jest.spyOn(fs, 'readFile').mockImplementation((...args) => {
      if (args[0] === path && ++reads === nth)
        current.store.stopPreferencesGenerationStamp();
      return readFile(...args);
    });
    const run = current.store.startPreferencesGenerationStamp(() =>
      Promise.resolve(true),
    );
    expect(await run).toBe('stamped');
    expect(reads).toBeGreaterThanOrEqual(nth);
    await expectStamped(1, [denyRemove]);
  });

  it("a quit during the record writer's preflight lets the save complete", async () => {
    let current = app ?? (await restart());
    await fs.writeFile(mockPreferencesPath, legacyMain([denyRemove]));

    current = await restart();
    const stat = fs.stat;
    jest.spyOn(fs, 'stat').mockImplementation((...args) => {
      if (args[0] === generationPath())
        current.store.stopPreferencesGenerationStamp();
      return stat(...args);
    });
    const run = current.store.startPreferencesGenerationStamp(() =>
      Promise.resolve(true),
    );
    expect(await run).toBe('stamped');
    await expectStamped(1, [denyRemove]);
  });

  it("quit's flush waits for an attempt already in flight", async () => {
    let current = app ?? (await restart());
    await fs.writeFile(mockPreferencesPath, legacyMain([denyRemove]));

    current = await restart();
    // Hold the queued recheck, the save's second record read.
    const reached = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    let recordReads = 0;
    jest.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      if (args[0] === generationPath()) {
        recordReads += 1;
        if (recordReads === 2) {
          reached.resolve();
          await held.promise;
        }
      }
      return readFile(...args);
    });
    const run = current.store.startPreferencesGenerationStamp(() =>
      Promise.resolve(true),
    );
    await reached.promise;
    current.store.stopPreferencesGenerationStamp();
    let flushed = false;
    const flush = current.store.flushPreferencesWrites().then(() => {
      flushed = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(flushed).toBe(false);
    held.resolve();
    await flush;
    // Durable by the time the flush resolves.
    expect(await json(generationPath())).toEqual({ version: 1, generation: 1 });
    expect(await json(mockPreferencesPath)).toMatchObject({ generation: 1 });
    expect(await run).toBe('stamped');
  });

  it('queues no attempt after a quit stops a failing one', async () => {
    let current = app ?? (await restart());
    await fs.writeFile(mockPreferencesPath, legacyMain([]));

    current = await restart();
    const before = await inventory();
    failingWrites.add('preferences.generation.json');
    let recordWrites = 0;
    const installed = jest.mocked(fs.open).getMockImplementation();
    jest.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (
        flags === 'wx' &&
        tempTarget(String(path)) === basename(generationPath())
      ) {
        recordWrites += 1;
        current.store.stopPreferencesGenerationStamp();
      }
      if (installed === undefined) return open(path, flags, mode);
      return installed(path, flags, mode);
    });
    let waits = 0;
    const run = current.store.startPreferencesGenerationStamp(() => {
      waits += 1;
      return Promise.resolve(true);
    });
    expect(await run).toBe('stopped');
    await current.store.flushPreferencesWrites();
    expect({ waits, recordWrites }).toEqual({ waits: 1, recordWrites: 1 });
    expect(await inventory()).toEqual(before);
  });

  it('a stop releases the run, so the next start begins a new one', async () => {
    let current = app ?? (await restart());
    await fs.writeFile(mockPreferencesPath, legacyMain([]));

    current = await restart();
    const stalled = current.store.startPreferencesGenerationStamp(
      () => new Promise<boolean>(() => undefined),
    );
    current.store.stopPreferencesGenerationStamp();
    const next = current.store.startPreferencesGenerationStamp(() =>
      Promise.resolve(true),
    );
    expect(next).not.toBe(stalled);
    expect(await next).toBe('stamped');
  });

  it('saves again when main lags the record, as after a downgrade', async () => {
    let current = app ?? (await restart());
    await commit(current, () => ({ globalApprovalRules: [allowTest] }));
    // An older build saves without a generation and leaves the record.
    await fs.writeFile(mockPreferencesPath, legacyMain([denyRemove]));
    await fs.writeFile(lastGoodPath(), legacyMain([denyRemove]));

    current = await restart();
    expect(await current.store.stampPreferencesGeneration()).toBe('stamped');
    await current.store.flushPreferencesWrites();
    for (const path of [mockPreferencesPath, lastGoodPath()])
      expect(await json(path)).toMatchObject({
        generation: 2,
        preferences: { globalApprovalRules: [denyRemove] },
      });
    expect(await current.store.stampPreferencesGeneration()).toBe('present');
  });
});

describe('CAN-5154 record and refresh edge cases', () => {
  it('an unreadable record during a save after a downgrade does not make a stale last-good current', async () => {
    let current = app ?? (await restart());
    await commit(current, () => ({ globalApprovalRules: [allowTest] }));
    // The newer app reached generation 5 with the allow.
    const lastGood = await readFile(lastGoodPath(), 'utf8');
    expect(lastGood).toContain('"generation": 1,');
    await fs.writeFile(
      lastGoodPath(),
      lastGood.replace('"generation": 1,', '"generation": 5,'),
    );
    await fs.writeFile(
      generationPath(),
      JSON.stringify({ version: 1, generation: 5 }),
    );
    // An older app revoked it; its last-good refresh failed.
    await fs.writeFile(
      mockPreferencesPath,
      JSON.stringify({ version: 1, preferences: { globalApprovalRules: [] } }),
    );

    current = await restart();
    generationReadError = 'EIO';
    failingWrites.add('preferences.last-good.json');
    await commit(current, () => ({ sidebarCollapsed: true }));
    await fs.unlink(mockPreferencesPath);

    current = await restart();
    await current.store.readPreferencesFile();
    await expectDegraded(current);
  });

  /** A newer app reached generation 5 with the allow; an older one revoked it. */
  async function arrangeNewerLastGood(
    current: App,
    record: 'unreadable' | 'missing',
  ): Promise<string> {
    await commit(current, () => ({ globalApprovalRules: [allowTest] }));
    const newer = (await readFile(lastGoodPath(), 'utf8')).replace(
      '"generation": 1,',
      '"generation": 5,',
    );
    await fs.writeFile(lastGoodPath(), newer);
    if (record === 'unreadable')
      await fs.writeFile(
        generationPath(),
        JSON.stringify({ version: 1, generation: 5 }),
      );
    else await fs.unlink(generationPath());
    await fs.writeFile(
      mockPreferencesPath,
      JSON.stringify({ version: 1, preferences: { globalApprovalRules: [] } }),
    );
    return newer;
  }

  it.each(['unreadable', 'missing'] as const)(
    'refuses a save, writing nothing, when the record is %s and last-good fails to read',
    async (record) => {
      let current = app ?? (await restart());
      await arrangeNewerLastGood(current, record);

      current = await restart();
      if (record === 'unreadable') generationReadError = 'EIO';
      lastGoodReadError = 'EIO';
      const before = await inventory();
      await expect(
        current.store.updatePreferencesFile(() => ({ sidebarCollapsed: true })),
      ).rejects.toMatchObject({ code: 'PREFERENCES_GENERATION_UNKNOWN' });
      await current.store.flushPreferencesWrites();
      expect(await inventory()).toEqual(before);

      // Once last-good reads again, the save lands above it.
      lastGoodReadError = null;
      await commit(current, () => ({ sidebarCollapsed: true }));
      expect(await json(mockPreferencesPath)).toMatchObject({ generation: 6 });
    },
  );

  it.each([
    { record: 'unreadable', generation: '"5"', label: 'a string' },
    { record: 'missing', generation: String(2 ** 60), label: 'unsafe' },
  ] as const)(
    "refuses a save, writing nothing, when the record is $record and last-good's generation is $label",
    async ({ record, generation }) => {
      let current = app ?? (await restart());
      const newer = await arrangeNewerLastGood(current, record);
      await fs.writeFile(
        lastGoodPath(),
        newer.replace('"generation": 5,', `"generation": ${generation},`),
      );

      current = await restart();
      if (record === 'unreadable') generationReadError = 'EIO';
      const before = await inventory();
      await expect(
        current.store.updatePreferencesFile(() => ({ sidebarCollapsed: true })),
      ).rejects.toMatchObject({ code: 'PREFERENCES_GENERATION_UNKNOWN' });
      await current.store.flushPreferencesWrites();
      expect(await inventory()).toEqual(before);
    },
  );

  it('saves past a torn last-good, which recovery never restores', async () => {
    // A torn last-good stays torn until a write replaces it (CAN-4407).
    let current = app ?? (await restart());
    const newer = await arrangeNewerLastGood(current, 'unreadable');
    await fs.writeFile(lastGoodPath(), newer.slice(0, 40));

    current = await restart();
    generationReadError = 'EIO';
    failingWrites.add('preferences.last-good.json');
    await commit(current, () => ({ sidebarCollapsed: true }));
    expect(await json(mockPreferencesPath)).toMatchObject({ generation: 1 });
    await fs.unlink(mockPreferencesPath);

    current = await restart();
    await current.store.readPreferencesFile();
    await expectDegraded(current);
  });

  it('a crash while the last-good refresh is in flight leaves a last-good recovery refuses', async () => {
    let current = app ?? (await restart());
    await commit(current, () => ({ globalApprovalRules: [allowTest] }));
    const held = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const traced = jest.mocked(fs.rename).getMockImplementation();
    jest.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (to === lastGoodPath()) {
        reached.resolve();
        await held.promise;
      }
      await traced?.(from, to);
    });
    await current.store.updatePreferencesFile(() => ({
      globalApprovalRules: [],
    }));
    await reached.promise;
    await fs.unlink(mockPreferencesPath);
    jest.mocked(fs.rename).mockImplementation(async (from, to) => {
      await traced?.(from, to);
    });
    const crashed = current;
    current = await restart({ flush: false });
    await current.store.readPreferencesFile();
    await expectDegraded(current);
    held.resolve();
    await crashed.store.flushPreferencesWrites();
  });

  it('recovery in the same process after an outcome-unknown revocation refuses the older last-good', async () => {
    const current = app ?? (await restart());
    await commit(current, () => ({ globalApprovalRules: [allowTest] }));
    failDirSyncAfterRenameOf = 'preferences.json';
    await expect(
      current.store.updatePreferencesFile(() => ({ globalApprovalRules: [] })),
    ).rejects.toMatchObject({ name: 'StorageOutcomeUnknownError' });
    await fs.writeFile(mockPreferencesPath, '{torn');
    await current.store.readPreferencesFile();
    await expectDegraded(current);
  });
});

describe('CAN-5154 A2 durable recovery evidence', () => {
  it('keeps a corrupt main and its deny when last-good is missing and the backup install fails', async () => {
    let current = app ?? (await restart());
    await commit(current, () => ({ globalApprovalRules: [denyRemove] }));
    await fs.unlink(lastGoodPath());
    const corrupt = `{"version":1,"preferences":{"globalApprovalRules":[${JSON.stringify(denyRemove)}],`;
    await fs.writeFile(mockPreferencesPath, corrupt);

    current = await restart();
    failingWrites.add('preferences.backup-');
    const before = await inventory();
    await current.store.readPreferencesFile();
    expect(await inventory()).toEqual(before);
    expect(await readFile(mockPreferencesPath, 'utf8')).toBe(corrupt);
    await expectDegraded(current);
  });

  it('content- and folder-syncs the backup before main is replaced', async () => {
    let current = app ?? (await restart());
    await commit(current, () => ({ globalApprovalRules: [allowTest] }));
    await fs.writeFile(mockPreferencesPath, '{torn');

    current = await restart();
    trace = [];
    await current.store.readPreferencesFile();
    const backupRename = trace.findIndex((event) =>
      event.startsWith('rename preferences.backup-'),
    );
    const backupSync = trace.findIndex((event) =>
      event.startsWith('sync preferences.backup-'),
    );
    const mainRename = trace.indexOf('rename preferences.json');
    expect(backupSync).toBeGreaterThanOrEqual(0);
    expect(backupSync).toBeLessThan(backupRename);
    const backupFolderSync = trace.indexOf('dir-sync', backupRename);
    expect(backupFolderSync).toBeGreaterThan(backupRename);
    expect(backupFolderSync).toBeLessThan(mainRename);
    expect(current.store.peekPreferencesLoadError()?.backupPath).toEqual(
      expect.stringContaining('preferences.backup-'),
    );
  });

  it('does not replace main when the backup install has an unknown outcome', async () => {
    let current = app ?? (await restart());
    await commit(current, () => ({ globalApprovalRules: [allowTest] }));
    await fs.writeFile(mockPreferencesPath, '{torn');

    current = await restart();
    trace = [];
    failDirSyncAfterRenameOf = 'preferences.backup-';
    await current.store.readPreferencesFile();
    expect(trace).toContain('dir-sync failed');
    expect(trace).not.toContain('rename preferences.json');
    expect(await readFile(mockPreferencesPath, 'utf8')).toBe('{torn');
    expect(current.store.peekPreferencesLoadError()).toMatchObject({
      backupPath: undefined,
      restoredFromPath: lastGoodPath(),
    });
    await expectDegraded(current);
  });
});
