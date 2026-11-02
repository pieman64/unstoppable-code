import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDelegationStorage } from '@canopy/desktop-shared/node/delegation/storage';
import {
  readDelegationLifetimeBaseline,
  writeDelegationLifetimeBaseline,
} from '@canopy/desktop-shared/node/delegation/lifetime-baseline';
import { ManagedDelegationLifetimeService } from '../agents/delegation/service';
import {
  configureManagedDelegationLifetimeService,
  configureManagedDelegationReaders,
  createManagedDelegationSession,
  extendManagedDelegationLifetimeLimit,
  readManagedDelegationRootsForUser,
  readManagedDelegationTreeForUser,
  shutdownManagedDelegations,
  updateManagedDelegationLifetimeLimit,
} from '../agents/delegation/service';
import { closeDelegationScope } from '../agents/delegation/lifecycle';
import { loadDelegationRecoveryMutations } from '../agents/delegation/recovery';
import {
  baseTask,
  createBrokerHarness,
  rootParent,
  MemoryDelegationStorage,
  flushBroker,
} from '@canopy/desktop-shared/node/delegation/__tests__/broker-harness';
import { routeFixture } from '@canopy/desktop-shared/node/delegation/__tests__/fixtures';
import type { StoredDelegation } from '@canopy/desktop-shared/node/delegation/broker';
import type { AgentSessionOptions } from '../agents/types';
import { DelegationRouteRuntime } from '../agents/delegation/route-runtime';
jest.setTimeout(60_000);
jest.mock('node:fs/promises', () => {
  const actual: typeof FsPromises = jest.requireActual('node:fs/promises');
  return { ...actual, open: jest.fn(actual.open), rm: jest.fn(actual.rm) };
});
const realFs = jest.requireActual<typeof FsPromises>('node:fs/promises');
const heldGates = new Set<() => void>();
function releaseGates(): void {
  heldGates.forEach((release) => release());
  heldGates.clear();
}

let mockRoot = '';
let mockSavedSetting = 1024;
jest.mock('../lib/paths', () => ({
  ...jest.requireActual<object>('../lib/paths'),
  getWorktreeDataDir: (projectId: string, worktreeId: string): string =>
    join(mockRoot, projectId, worktreeId),
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: (): string => mockRoot || '/fixture/worktree',
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFileDetailed: (): Promise<object> =>
    Promise.resolve({
      preferences: { managedDelegationLifetimeLimit: mockSavedSetting },
      authority: 'ok',
    }),
  readPreferencesFile: (): Promise<object> =>
    Promise.resolve({ managedDelegationLifetimeLimit: mockSavedSetting }),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: (): Promise<null> => Promise.resolve(null),
  subscribeCanopyCloudAccountChanges: (): (() => void) => () => undefined,
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): object => ({
    subscribe: (): (() => void) => () => undefined,
  }),
}));

function fixtureId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}
function record(index: number): StoredDelegation {
  return {
    version: 1,
    parent: rootParent,
    task: baseTask,
    route: routeFixture({ capabilities: ['read', 'progress', 'resume'] }),
    callKey: index.toString(16).padStart(64, '0'),
    requestHash: 'b'.repeat(64),
    createdAt: index + 1,
    state: {
      delegationId: fixtureId(index),
      runGeneration: 1,
      sequence: 1,
      status: 'completed',
      outputTruncated: false,
      finishedAt: index + 2,
      nativeSessionId: `native-${index}`,
      transcript: [],
    },
    launch: {
      version: 1,
      delegationId: fixtureId(index),
      runGeneration: 1,
      launchKey: index.toString(16).padStart(64, '0'),
      phase: 'settled',
      terminalStatus: 'completed',
      nativeSessionId: `native-${index}`,
    },
    delivery: { status: 'suppressed', reason: 'automatic_delivery_removed' },
  };
}

async function seed(
  storage: FileDelegationStorage,
  count: number,
  directory: string,
): Promise<void> {
  await storage.prepareDirectory();
  await storage.commit(record(0));
  for (let index = 0; index < count; index++)
    await writeFile(
      join(directory, `${fixtureId(index)}.json`),
      JSON.stringify(record(index)),
      { mode: 0o600 },
    );
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  heldGates.add(release);
  return { promise, release };
}

describe('host lifetime policy and private baseline owner', () => {
  let directory: string;
  let storage: FileDelegationStorage;
  let retained: number;
  let active: boolean;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'delegation-lifetime-'));
    storage = new FileDelegationStorage(join(directory, 'delegation'));
    retained = 1024;
    active = true;
  });
  afterEach(async () => {
    releaseGates();
    jest.restoreAllMocks();
    jest.mocked(fs.open).mockImplementation(realFs.open);
    jest.mocked(fs.rm).mockImplementation(realFs.rm);
    await rm(directory, { recursive: true, force: true });
  });
  function owner(
    service = new ManagedDelegationLifetimeService({ measuredCap: 3072 }),
  ): ReturnType<ManagedDelegationLifetimeService['createOwner']> {
    return service.createOwner({
      storage,
      retained: () => retained,
      active: () => active,
    });
  }
  async function baselineBytes(): Promise<string> {
    return readFile(
      join(directory, 'delegation', 'lifetime-baseline.json'),
      'utf8',
    );
  }

  it.each([
    [undefined, 1024],
    [512, 512],
    [1024, 1024],
    [2048, 2048],
    [4096, 1024],
    ['1024', 1024],
    [null, 1024],
    [NaN, 1024],
    [Infinity, 1024],
    [512.5, 1024],
  ])('normalizes %p under the constructor cap', async (value, expected) => {
    const service = new ManagedDelegationLifetimeService({ measuredCap: 3072 });
    service.update(value);
    const policyOwner = owner(service);
    await policyOwner.initialize();
    expect(policyOwner.policy()).toMatchObject({
      kind: 'available',
      limit: expected,
    });
  });

  it('keeps the production default and cap at 512', async () => {
    const policyOwner = owner(new ManagedDelegationLifetimeService());
    await policyOwner.initialize();
    expect(policyOwner.policy()).toEqual({
      kind: 'available',
      limit: 512,
      extension: 'at_cap',
    });
    expect(await policyOwner.extendLifetimeLimit()).toEqual({
      ok: false,
      reason: 'at_cap',
    });
  });

  it('extends C35 once per filled allowance and clamps at the cap', async () => {
    const policyOwner = owner();
    await policyOwner.initialize();
    expect(await policyOwner.extendLifetimeLimit()).toEqual({
      ok: true,
      baseline: 1024,
      effectiveLimit: 2048,
      retained: 1024,
    });
    expect(await baselineBytes()).toBe('{"version":1,"baseline":1024}');
    expect(await policyOwner.extendLifetimeLimit()).toEqual({
      ok: false,
      reason: 'no_increase',
    });
    retained = 2048;
    expect(await policyOwner.extendLifetimeLimit()).toEqual({
      ok: true,
      baseline: 2048,
      effectiveLimit: 3072,
      retained: 2048,
    });
    retained = 3072;
    expect(await policyOwner.extendLifetimeLimit()).toEqual({
      ok: false,
      reason: 'at_cap',
    });
  });

  it('uses the lowered setting live and reloads a baseline below retained on restart', async () => {
    const service = new ManagedDelegationLifetimeService({ measuredCap: 3072 });
    const policyOwner = owner(service);
    await policyOwner.initialize();
    await policyOwner.extendLifetimeLimit();
    retained = 2048;
    service.update(512);
    expect(policyOwner.policy()).toEqual({
      kind: 'available',
      limit: 1536,
      extension: 'possible',
    });
    expect(await policyOwner.extendLifetimeLimit()).toEqual({
      ok: true,
      baseline: 2048,
      effectiveLimit: 2560,
      retained: 2048,
    });
    retained = 3000;
    const restarted = owner(service);
    await restarted.initialize();
    expect(restarted.policy()).toEqual({
      kind: 'available',
      limit: 2560,
      extension: 'possible',
    });
  });

  it('serializes concurrent extensions without granting twice', async () => {
    const policyOwner = owner();
    await policyOwner.initialize();
    const commit = jest.spyOn(storage, 'commitWithOutcome');
    expect(
      await Promise.all([
        policyOwner.extendLifetimeLimit(),
        policyOwner.extendLifetimeLimit(),
      ]),
    ).toEqual([
      { ok: true, baseline: 1024, effectiveLimit: 2048, retained: 1024 },
      { ok: false, reason: 'no_increase' },
    ]);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('publishes only confirmed baseline and the latest setting during a held commit', async () => {
    const service = new ManagedDelegationLifetimeService({ measuredCap: 3072 });
    const policyOwner = owner(service);
    await policyOwner.initialize();
    const held = gate();
    const entered = gate();
    const realCommit = storage.commitWithOutcome.bind(storage);
    jest
      .spyOn(storage, 'commitWithOutcome')
      .mockImplementationOnce(async (record) => {
        entered.release();
        await held.promise;
        return realCommit(record);
      });
    const extension = policyOwner.extendLifetimeLimit();
    await entered.promise;
    expect(policyOwner.policy()).toEqual({
      kind: 'available',
      limit: 1024,
      extension: 'possible',
    });
    service.update(512);
    expect(policyOwner.policy()).toEqual({
      kind: 'available',
      limit: 512,
      extension: 'possible',
    });
    held.release();
    expect(await extension).toEqual({
      ok: true,
      baseline: 1024,
      effectiveLimit: 1536,
      retained: 1024,
    });
    expect(policyOwner.policy()).toEqual({
      kind: 'available',
      limit: 1536,
      extension: 'none',
    });
  });

  it('keeps the old baseline on a proven pre-rename failure', async () => {
    const policyOwner = owner();
    await policyOwner.initialize();
    jest.spyOn(storage, 'commitWithOutcome').mockResolvedValueOnce({
      outcome: 'not_written',
      error: new Error('before rename'),
    });
    expect(await policyOwner.extendLifetimeLimit()).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(policyOwner.policy()).toEqual({
      kind: 'available',
      limit: 1024,
      extension: 'possible',
    });
    expect(
      await readDelegationLifetimeBaseline(
        new FileDelegationStorage(join(directory, 'delegation')),
      ),
    ).toBe(0);
  });

  it.each(['before_rename', 'directory_sync', 'cleanup'])(
    'reconciles the actual private write failure at %s and restart bytes',
    async (phase) => {
      const policyOwner = owner();
      await policyOwner.initialize();
      const failure = new Error(phase);
      if (phase === 'before_rename') {
        jest
          .mocked(fs.open)
          .mockImplementation((...args) =>
            args[1] === 'wx' ? Promise.reject(failure) : realFs.open(...args),
          );
      } else if (phase === 'directory_sync') {
        const handle = await realFs.open(join(directory, 'delegation'), 'r');
        jest.spyOn(handle, 'sync').mockRejectedValueOnce(failure);
        jest
          .mocked(fs.open)
          .mockImplementation((...args) =>
            args[0] === join(directory, 'delegation') && args[1] === 'r'
              ? Promise.resolve(handle)
              : realFs.open(...args),
          );
      } else {
        jest.mocked(fs.rm).mockRejectedValueOnce(failure);
      }
      try {
        // After the rename, the re-read confirms the new file, so the reply
        // matches the published limit; before it, nothing changed.
        expect(await policyOwner.extendLifetimeLimit()).toEqual(
          phase === 'before_rename'
            ? { ok: false, reason: 'unavailable' }
            : {
                ok: true,
                baseline: 1024,
                effectiveLimit: 2048,
                retained: 1024,
              },
        );
      } finally {
        jest.mocked(fs.open).mockImplementation(realFs.open);
        jest.mocked(fs.rm).mockImplementation(realFs.rm);
      }
      expect(policyOwner.policy()).toMatchObject({
        kind: 'available',
        limit: phase === 'before_rename' ? 1024 : 2048,
      });
      const restarted = owner();
      await restarted.initialize();
      expect(restarted.policy()).toMatchObject({
        kind: 'available',
        limit: phase === 'before_rename' ? 1024 : 2048,
      });
      expect(
        await readDelegationLifetimeBaseline(
          new FileDelegationStorage(join(directory, 'delegation')),
        ),
      ).toBe(phase === 'before_rename' ? 0 : 1024);
    },
  );

  it.each(['new', 'old', 'other', 'unreadable'])(
    'reconciles an uncertain write against the %s file and acknowledges only a confirmed one',
    async (file) => {
      const policyOwner = owner();
      await policyOwner.initialize();
      const realCommit = storage.commitWithOutcome.bind(storage);
      const heldRead = gate();
      const enteredRead = gate();
      const realRead = storage.read.bind(storage);
      const commit = jest
        .spyOn(storage, 'commitWithOutcome')
        .mockImplementationOnce(async (record) => {
          if (file === 'new') await realCommit(record);
          if (file === 'other')
            await writeDelegationLifetimeBaseline(
              new FileDelegationStorage(join(directory, 'delegation')),
              7,
            );
          if (file === 'unreadable')
            await writeFile(
              join(directory, 'delegation', 'lifetime-baseline.json'),
              '{',
              { mode: 0o600 },
            );
          jest
            .spyOn(storage, 'read')
            .mockImplementationOnce(async (name, parse) => {
              enteredRead.release();
              await heldRead.promise;
              return realRead(name, parse);
            });
          return { outcome: 'uncertain', error: new Error('after rename') };
        });
      const extension = policyOwner.extendLifetimeLimit();
      // The race has a bounded observer instead of waiting forever for a missing re-read.
      await Promise.race([enteredRead.promise, extension]);
      expect(policyOwner.policy()).toEqual({
        kind: 'unavailable',
        reason: 'uncertain',
      });
      heldRead.release();
      expect(await extension).toEqual(
        file === 'new'
          ? { ok: true, baseline: 1024, effectiveLimit: 2048, retained: 1024 }
          : { ok: false, reason: 'unavailable' },
      );
      if (file === 'new') {
        expect(policyOwner.policy()).toEqual({
          kind: 'available',
          limit: 2048,
          extension: 'none',
        });
        expect(await policyOwner.extendLifetimeLimit()).toEqual({
          ok: false,
          reason: 'no_increase',
        });
      } else if (file === 'old') {
        expect(policyOwner.policy()).toEqual({
          kind: 'available',
          limit: 1024,
          extension: 'possible',
        });
      } else {
        expect(policyOwner.policy()).toEqual({
          kind: 'unavailable',
          reason: 'uncertain',
        });
        expect(await policyOwner.extendLifetimeLimit()).toEqual({
          ok: false,
          reason: 'unavailable',
        });
      }
      expect(commit).toHaveBeenCalledTimes(1);
    },
  );

  it('does not write a queued extension after scope retirement', async () => {
    const policyOwner = owner();
    await policyOwner.initialize();
    const held = gate();
    const entered = gate();
    const realCommit = storage.commitWithOutcome.bind(storage);
    const commit = jest
      .spyOn(storage, 'commitWithOutcome')
      .mockImplementationOnce(async (record) => {
        entered.release();
        await held.promise;
        return realCommit(record);
      });
    const first = policyOwner.extendLifetimeLimit();
    await entered.promise;
    retained = 2048;
    const queued = policyOwner.extendLifetimeLimit();
    active = false;
    held.release();
    await first;
    expect(await queued).toEqual({ ok: false, reason: 'unavailable' });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('keeps an unreadable baseline unavailable and ignores pending-only files', async () => {
    await storage.prepareDirectory();
    await writeFile(
      join(directory, 'delegation', '.lifetime-baseline.pending'),
      '{"version":1,"baseline":2000}',
      { mode: 0o600 },
    );
    const pending = owner();
    await pending.initialize();
    expect(pending.policy()).toMatchObject({ kind: 'available', limit: 1024 });
    await writeFile(
      join(directory, 'delegation', 'lifetime-baseline.json'),
      '{',
      { mode: 0o600 },
    );
    const unreadable = owner();
    await unreadable.initialize();
    expect(unreadable.policy()).toEqual({
      kind: 'unavailable',
      reason: 'unreadable',
    });
    expect(await unreadable.extendLifetimeLimit()).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });
});

describe('actorless extension and real retained readers', () => {
  const scope = { projectId: 'project', worktreeId: 'worktree' };
  let restoreService: () => void;
  let restoreReaders: () => void;
  let runs: string;
  let storage: FileDelegationStorage;
  beforeEach(async () => {
    mockSavedSetting = 1024;
    mockRoot = await mkdtemp(join(tmpdir(), 'delegation-host-lifetime-'));
    runs = join(mockRoot, 'project', 'worktree', 'delegation', 'runs');
    storage = new FileDelegationStorage(runs);
    restoreService = configureManagedDelegationLifetimeService(
      new ManagedDelegationLifetimeService({ measuredCap: 3072 }),
    );
    restoreReaders = configureManagedDelegationReaders({});
  });
  afterEach(async () => {
    releaseGates();
    await closeDelegationScope(scope);
    restoreReaders();
    restoreService();
    jest.restoreAllMocks();
    await rm(mockRoot, { recursive: true, force: true });
  });

  function attach(): ReturnType<typeof createManagedDelegationSession> {
    const options: AgentSessionOptions = {
      ...scope,
      chatId: 'chat',
      cwd: '/fixture/worktree',
      managedDelegationLifetimeLimit: 1024,
    };
    return createManagedDelegationSession({
      harness: 'claude',
      sessionKey: 'project/worktree/chat',
      currentOptions: () => options,
      currentTurn: () => 'turn',
      getWindow: () => null,
    });
  }

  async function statusRead(): Promise<unknown> {
    const service = await import('../agents/delegation/service');
    const read = Reflect.get(service, 'getManagedDelegationLifetimeStatus');
    // The previous user-facing path initializes an actor; pin that behavior as red.
    return typeof read === 'function'
      ? read(scope)
      : extendManagedDelegationLifetimeLimit(scope);
  }

  it('observes a dormant scope without a window, actor recovery or any directory creation', async () => {
    const prepare = jest.spyOn(
      FileDelegationStorage.prototype,
      'prepareDirectory',
    );
    const commit = jest.spyOn(FileDelegationStorage.prototype, 'commit');
    const createOwner = jest.spyOn(
      ManagedDelegationLifetimeService.prototype,
      'createOwner',
    );
    const status = await statusRead();
    await expect(
      fs.stat(join(mockRoot, 'project', 'worktree', 'delegation')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(status).toEqual({
      kind: 'available',
      occupied: 0,
      retained: 0,
      limit: 1024,
      cap: 3072,
      atLimit: false,
      canExtend: false,
      atCap: false,
      refusedChatIds: [],
    });
    // The read may validate the private directory, but never in creating mode.
    expect(
      prepare.mock.calls.every(([options]) => options?.create === false),
    ).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    expect(createOwner).not.toHaveBeenCalled();
  });

  it('reports a corrupt dormant registry as read_failed rather than zero or recovery', async () => {
    await fs.mkdir(runs, { recursive: true, mode: 0o700 });
    await writeFile(join(runs, 'bad.json'), '{', { mode: 0o600 });
    expect(await statusRead()).toEqual({
      kind: 'error',
      reason: 'read_failed',
    });
  });

  it('distinguishes unreadable baseline policy from counting errors', async () => {
    const dir = join(mockRoot, 'project', 'worktree', 'delegation');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, 'lifetime-baseline.json'), '{', { mode: 0o600 });
    expect(await statusRead()).toEqual({
      kind: 'unavailable',
      reason: 'unreadable',
    });
  });

  it('does not serve a cached available count after a dormant scope is deleted', async () => {
    expect(await statusRead()).toMatchObject({
      kind: 'available',
      occupied: 0,
    });
    await rm(mockRoot, { recursive: true, force: true });
    expect(await statusRead()).toEqual({
      kind: 'error',
      reason: 'scope_unavailable',
    });
  });

  it('extends without a root or window and shares its actor with concurrent session attachment', async () => {
    await seed(storage, 1, runs);
    const resolve = jest
      .spyOn(DelegationRouteRuntime.prototype, 'resolve')
      .mockRejectedValue(
        new Error('Provider launch forbidden in this fixture'),
      );
    const held = gate();
    const entered = gate();
    const createOwner = jest.spyOn(
      ManagedDelegationLifetimeService.prototype,
      'createOwner',
    );
    // Invoked below with the intercepted instance via .call(this, record).
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const realCommit = FileDelegationStorage.prototype.commitWithOutcome;
    jest
      .spyOn(FileDelegationStorage.prototype, 'commitWithOutcome')
      .mockImplementation(async function (this: FileDelegationStorage, record) {
        if ('name' in record && record.name === 'lifetime-baseline.json') {
          entered.release();
          await held.promise;
        }
        return realCommit.call(this, record);
      });
    const extension = extendManagedDelegationLifetimeLimit(scope);
    try {
      await Promise.race([entered.promise, extension]);
      expect(createOwner).toHaveBeenCalledTimes(1);
      const attaching = attach();
      held.release();
      expect(await extension).toEqual({
        ok: true,
        baseline: 1,
        effectiveLimit: 1025,
        retained: 1,
      });
      const session = await attaching;
      expect(createOwner).toHaveBeenCalledTimes(1);
      expect(resolve).not.toHaveBeenCalled();
      session.detach();
    } finally {
      held.release();
      await extension;
    }
  });

  it('keeps broker, recovery, tree and roots readable after lowering below retained and restarting', async () => {
    await seed(storage, 1025, runs);
    await writeDelegationLifetimeBaseline(
      new FileDelegationStorage(
        join(mockRoot, 'project', 'worktree', 'delegation'),
      ),
      512,
    );
    mockSavedSetting = 512;
    updateManagedDelegationLifetimeLimit(512);
    const session = await attach();
    const totalDecoded = await storage.load();
    expect(totalDecoded).toHaveLength(1025);
    expect(
      await readManagedDelegationTreeForUser({ ...scope, chatId: 'chat' }),
    ).toHaveLength(1000);
    expect(await readManagedDelegationRootsForUser(scope)).toEqual([
      expect.objectContaining({ chatId: 'chat', total: 1025 }),
    ]);
    const loaded = jest.spyOn(FileDelegationStorage.prototype, 'load');
    expect(
      await loadDelegationRecoveryMutations(
        scope,
        { version: 1, tabs: [], activeTabId: '' },
        { version: 1, archived: [] },
        { readMetadata: undefined },
      ),
    ).toEqual([]);
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(await loaded.mock.results[0]?.value).toHaveLength(1025);
    session.detach();
    await closeDelegationScope(scope);
    const restarted = await attach();
    expect(await extendManagedDelegationLifetimeLimit(scope)).toEqual({
      ok: true,
      baseline: 1025,
      effectiveLimit: 1537,
      retained: 1025,
    });
    restarted.detach();
    // Two broker starts over 1,025 records; allow for a loaded host.
  }, 180_000);

  it.each(['close', 'shutdown'])(
    'drains a held write and refuses queued extensions during %s',
    async (operation) => {
      await seed(storage, 1, runs);
      const entered = gate();
      const held = gate();
      // Invoked below with the intercepted instance via .call(this, record).
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const realCommit = FileDelegationStorage.prototype.commitWithOutcome;
      const commit = jest
        .spyOn(FileDelegationStorage.prototype, 'commitWithOutcome')
        .mockImplementation(async function (
          this: FileDelegationStorage,
          record,
        ) {
          if ('name' in record && record.name === 'lifetime-baseline.json') {
            entered.release();
            await held.promise;
          }
          return realCommit.call(this, record);
        });
      const first = extendManagedDelegationLifetimeLimit(scope);
      try {
        await Promise.race([entered.promise, first]);
        const second = extendManagedDelegationLifetimeLimit(scope);
        const closing =
          operation === 'close'
            ? closeDelegationScope(scope)
            : shutdownManagedDelegations();
        held.release();
        expect(await first).toEqual({
          ok: true,
          baseline: 1,
          effectiveLimit: 1025,
          retained: 1,
        });
        expect(await second).toEqual({ ok: false, reason: 'unavailable' });
        await closing;
        expect(
          commit.mock.calls.filter(
            ([record]) =>
              'name' in record && record.name === 'lifetime-baseline.json',
          ),
        ).toHaveLength(1);
      } finally {
        held.release();
        await first;
      }
    },
  );
});

describe('host policy with the real broker and FakeRunner', () => {
  it.each([
    [1024, 3072],
    [512, 2560],
  ] as const)(
    'counts actual retained identities for both C35 extensions with the second setting %i',
    async (secondSetting, expected) => {
      const directory = await mkdtemp(join(tmpdir(), 'delegation-c35-'));
      const storage = new MemoryDelegationStorage();
      const service = new ManagedDelegationLifetimeService({
        measuredCap: 3072,
      });
      const baseline = new FileDelegationStorage(directory);
      const actors: Array<ReturnType<typeof createBrokerHarness>> = [];
      const makeActor = async (): Promise<
        ReturnType<ManagedDelegationLifetimeService['createOwner']>
      > => {
        const policyOwner = service.createOwner({
          storage: baseline,
          retained: () => actor.broker.retainedCount(),
          active: () => true,
        });
        await policyOwner.initialize();
        const actor = createBrokerHarness(
          { lifetimePolicy: () => policyOwner.policy() },
          storage,
        );
        actors.push(actor);
        await actor.broker.initialize();
        return policyOwner;
      };
      try {
        for (let index = 0; index < 1024; index++)
          storage.records.set(fixtureId(index), record(index));
        const first = await makeActor();
        expect(await first.extendLifetimeLimit()).toEqual({
          ok: true,
          baseline: 1024,
          effectiveLimit: 2048,
          retained: 1024,
        });
        expect(await first.extendLifetimeLimit()).toEqual({
          ok: false,
          reason: 'no_increase',
        });
        await first.close();
        await actors[0]?.broker.close();
        for (let index = 1024; index < 2048; index++)
          storage.records.set(fixtureId(index), record(index));
        service.update(secondSetting);
        const second = await makeActor();
        expect(await second.extendLifetimeLimit()).toEqual({
          ok: true,
          baseline: 2048,
          effectiveLimit: expected,
          retained: 2048,
        });
        expect(storage.records.size).toBe(2048);
        expect(await readDelegationLifetimeBaseline(baseline)).toBe(2048);
        await second.close();
        await actors[1]?.broker.close();
        for (let index = 2048; index < expected; index++)
          storage.records.set(fixtureId(index), record(index));
        const filled = await makeActor();
        const last = actors[2];
        if (!last) throw new Error('Expected filled broker');
        expect(last.broker.retainedCount()).toBe(expected);
        expect(await last.broker.spawn(rootParent, baseTask)).toMatchObject({
          ok: false,
          error: { code: 'lifetime_limit_reached', retryable: false },
        });
        if (secondSetting === 1024)
          expect(await filled.extendLifetimeLimit()).toEqual({
            ok: false,
            reason: 'at_cap',
          });
        await filled.close();
        for (const actor of actors) expect(actor.runner.starts).toHaveLength(0);
      } finally {
        for (const actor of actors) await actor.broker.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('extends from retained records only while a distinct admission is held before insertion', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'delegation-admission-extension-'),
    );
    const baseline = new FileDelegationStorage(directory);
    await writeDelegationLifetimeBaseline(baseline, 1024);
    const storage = new MemoryDelegationStorage();
    for (let index = 0; index < 2047; index++)
      storage.records.set(fixtureId(index), record(index));
    const service = new ManagedDelegationLifetimeService({ measuredCap: 3072 });
    const policyOwner = service.createOwner({
      storage: baseline,
      retained: () => broker.retainedCount(),
      active: () => true,
    });
    await policyOwner.initialize();
    const held = gate();
    const entered = gate();
    const { broker } = createBrokerHarness(
      {
        lifetimePolicy: () => policyOwner.policy(),
        resolveRoute: async () => {
          entered.release();
          await held.promise;
          return { ok: true, value: routeFixture() };
        },
      },
      storage,
    );
    await broker.initialize();
    const admission = broker.spawn(rootParent, baseTask);
    try {
      await Promise.race([entered.promise, admission]);
      expect(broker.retainedCount()).toBe(2047);
      expect(await policyOwner.extendLifetimeLimit()).toEqual({
        ok: true,
        baseline: 2047,
        effectiveLimit: 3071,
        retained: 2047,
      });
      held.release();
      expect(await admission).toMatchObject({ ok: true });
      expect(broker.retainedCount()).toBe(2048);
      expect(await readDelegationLifetimeBaseline(baseline)).toBe(2047);
    } finally {
      held.release();
      await admission;
      await policyOwner.close();
      await broker.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [512, 512, false],
    [1024, 512, true],
    [1024, 1024, false],
  ] as const)(
    'uses the cap-aware default with no saved setting under cap %i at count %i',
    async (cap, count, accepted) => {
      const directory = await mkdtemp(
        join(tmpdir(), 'delegation-host-broker-'),
      );
      const storage = new MemoryDelegationStorage();
      for (let index = 0; index < count; index++)
        storage.records.set(fixtureId(index), record(index));
      const service = new ManagedDelegationLifetimeService({
        measuredCap: cap,
      });
      const policyOwner = service.createOwner({
        storage: new FileDelegationStorage(directory),
        retained: () => broker.retainedCount(),
        active: () => true,
      });
      await policyOwner.initialize();
      const { broker, runner } = createBrokerHarness(
        {
          lifetimePolicy: () => policyOwner.policy(),
          resolveRoute: () =>
            Promise.resolve({
              ok: true,
              value: routeFixture({
                capabilities: ['read', 'progress', 'resume'],
              }),
            }),
        },
        storage,
      );
      await broker.initialize();
      try {
        expect(broker.retainedCount()).toBe(count);
        expect(await broker.spawn(rootParent, baseTask)).toMatchObject(
          accepted
            ? { ok: true }
            : {
                ok: false,
                error: { code: 'lifetime_limit_reached', retryable: false },
              },
        );
        await flushBroker();
        expect(runner.starts).toHaveLength(accepted ? 1 : 0);
        await writeFile(join(directory, 'lifetime-baseline.json'), '{', {
          mode: 0o600,
        });
        await policyOwner.initialize();
        expect(
          await broker.spawn(
            { ...rootParent, toolCallId: 'unreadable' },
            baseTask,
          ),
        ).toMatchObject({
          ok: false,
          error: { code: 'lifetime_limit_reached', retryable: false },
        });
        // A retained follow-up bypasses lifetime admission and launches only the fake adapter.
        expect(
          await broker.message(
            { ...rootParent, toolCallId: 'follow' },
            {
              delegationId: fixtureId(0),
              operation: 'follow_up',
              message: 'Continue',
            },
          ),
        ).toMatchObject({ ok: true });
        expect(broker.retainedCount()).toBe(accepted ? count + 1 : count);
      } finally {
        await broker.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
