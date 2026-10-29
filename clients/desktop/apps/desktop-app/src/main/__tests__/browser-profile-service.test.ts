import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  access,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { session } from 'electron';
import { createBrowserProfileCommands } from '../browser/browser-profile-commands';
import type { BrowserService } from '../browser/browser-service';
import { BrowserProfileService } from '../browser/browser-profile-service';
import * as profileServiceModule from '../browser/browser-profile-service';
import {
  prepareTaskBrowserRetirement,
  commitTaskBrowserRetirement,
  abortTaskBrowserRetirement,
  prepareWorkspaceBrowserRetirement,
  settleFailedTaskBrowserRetirement,
  retireRemovedBrowserTask,
  withBrowserTaskOwnerRemoval,
} from '../browser/browser-profile-lifecycle';
import type { BrowserSessionSnapshot } from '@canopy/desktop-shared/types/browser';
import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';

let mockNativeRoot: string;
const mockPermissionRequest = jest.fn();
const mockPermissionCheck = jest.fn();
const mockClearData = jest.fn(() => Promise.resolve());
const mockClearCache = jest.fn(() => Promise.resolve());
const mockDisposeViews = jest.fn(() => Promise.resolve());
const mockRetiredScratch = jest.fn(() => Promise.resolve());
const mockStagedGit = jest.fn((): Promise<unknown> => Promise.resolve(null));
jest.mock('../browser/browser-service-registry', () => ({
  getBrowserService: (): {
    disposeWorktreeViews: typeof mockDisposeViews;
    cleanupRetiredTaskScratch: typeof mockRetiredScratch;
  } => ({
    disposeWorktreeViews: mockDisposeViews,
    cleanupRetiredTaskScratch: mockRetiredScratch,
  }),
}));
jest.mock('../lib/archived-container-git', () => ({
  readArchivedGitStagedDescriptor: (): Promise<unknown> => mockStagedGit(),
}));
jest.mock('../browser/native-maintenance', () => ({
  clearRetiredBrowserSession: async (native: {
    clearData: () => Promise<void>;
    clearCache: () => Promise<void>;
  }): Promise<void> => {
    await native.clearData();
    await native.clearCache();
  },
}));
jest.mock('electron', () => ({
  app: { getPath: (): string => mockNativeRoot },
  session: {
    fromPartition: jest.fn((partition: string) => ({
      storagePath: `${mockNativeRoot}/Partitions/${partition.slice(8).toLowerCase()}`,
      setPermissionRequestHandler: mockPermissionRequest,
      setPermissionCheckHandler: mockPermissionCheck,
      webRequest: { onBeforeRequest: jest.fn() },
      clearData: mockClearData,
      clearCache: mockClearCache,
    })),
  },
}));

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(30_000);

describe('native browser profile authority', () => {
  let root: string;
  let dataRoot: string;
  let service: BrowserProfileService;
  const seed = async (path: string, value: unknown): Promise<void> => {
    await mkdir(dirname(join(dataRoot, path)), { recursive: true });
    await writeFile(join(dataRoot, path), JSON.stringify(value));
  };
  beforeEach(async () => {
    jest.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), 'browser-profile-service-'));
    dataRoot = join(root, 'data');
    mockNativeRoot = join(root, 'native');
    service = new BrowserProfileService(dataRoot, mockNativeRoot);
    jest
      .spyOn(profileServiceModule, 'getBrowserProfileService')
      .mockReturnValue(service);
    await seed('workspaces/index.json', {
      version: 1,
      workspaces: [
        { id: 'code', type: 'single-repo' },
        { id: 'cowork', type: 'cowork' },
      ],
    });
    await seed('workspaces/code/worktrees.json', {
      version: 1,
      worktrees: [
        { id: 'first', createdAt: '1' },
        { id: 'second', createdAt: '2' },
      ],
    });
    await seed('workspaces/cowork/work-entries.json', {
      version: 1,
      entries: [
        { id: 'first', createdAt: '3' },
        { id: 'second', createdAt: '4' },
      ],
    });
    await seed('app-workspaces/app-advisor/work-entries.json', {
      version: 1,
      entries: [
        { id: 'first', createdAt: '5' },
        { id: 'second', createdAt: '6' },
      ],
    });
  });
  afterEach(async () => {
    await service.purgeRetired();
    await rm(root, { recursive: true, force: true });
  });

  it('persists deletion previews and recovers a committed deletion across restart', async () => {
    const task = await service.resolve('code', 'first');
    const named = await service.repository.createNamed(randomUUID(), {
      displayName: 'Work',
    });
    const usage = {
      tabs: [
        {
          browserId: 'closed-code',
          projectId: 'code',
          worktreeId: 'first',
          runtimeGeneration: 1,
        },
        {
          browserId: 'closed-cowork',
          projectId: 'cowork',
          worktreeId: 'second',
          runtimeGeneration: 2,
        },
      ],
      defaults: [task.owner.scope],
    };
    const disposed = jest.fn().mockResolvedValue(undefined);
    const mark = jest
      .fn()
      .mockResolvedValue(undefined)
      .mockRejectedValueOnce(new Error('crash after retirement'));
    const browser = {
      profileUsage: () => Promise.resolve(usage),
      withProfileFence: async (
        _id: string,
        operation: () => Promise<unknown>,
      ) => operation(),
      disposeProfileViews: disposed,
      markProfileUnavailable: mark,
    } as unknown as BrowserService;
    const preview = await createBrowserProfileCommands(browser).previewDelete({
      profileId: named.profileId,
      expectedMetadataRevision: named.metadataRevision,
    });
    expect(preview.tabs).toHaveLength(2);
    const request = { operationId: randomUUID(), token: preview.token };
    await expect(
      createBrowserProfileCommands(browser).delete(request),
    ).rejects.toThrow('crash after retirement');
    await expect(service.repository.get(named.profileId)).rejects.toMatchObject(
      { code: 'profile_unavailable' },
    );
    const result = await createBrowserProfileCommands(browser).delete(request);
    expect(await createBrowserProfileCommands(browser).delete(request)).toEqual(
      result,
    );
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(await service.repository.get(task.profile.profileId)).toMatchObject({
      lifecycle: 'active',
    });
    await expect(
      createBrowserProfileCommands(browser).delete({
        ...request,
        token: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'operation_conflict' });
    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + 8 * 86400_000);
    try {
      await expect(
        createBrowserProfileCommands(browser).delete(request),
      ).rejects.toMatchObject({ code: 'operation_expired' });
      const compact = JSON.parse(
        await readFile(
          join(
            dataRoot,
            'browser-profile-commands',
            'delete',
            `${request.operationId}.json`,
          ),
          'utf8',
        ),
      ) as Record<string, unknown>;
      expect(compact).not.toHaveProperty('result');
      await expect(
        createBrowserProfileCommands(browser).delete({
          operationId: randomUUID(),
          token: request.token,
        }),
      ).rejects.toMatchObject({ code: 'operation_expired' });
      const oldPreview = JSON.parse(
        await readFile(
          join(
            dataRoot,
            'browser-profile-commands',
            'preview',
            `${request.token}.json`,
          ),
          'utf8',
        ),
      ) as Record<string, unknown>;
      expect(oldPreview).not.toHaveProperty('preview');
    } finally {
      clock.mockRestore();
    }
  });

  it('shares one named Session across owner kinds while keeping Task incarnations distinct', async () => {
    await service.ensureReady();
    const named = await service.repository.createNamed(randomUUID(), {
      displayName: 'Shared Work',
      allowEnable: true,
    });
    const resolutions = await Promise.all(
      ['code', 'cowork', 'app-advisor'].map((projectId) =>
        service.resolve(projectId, 'first', undefined, {
          actor: 'agent',
          selection: { kind: 'named', profileId: named.profileId },
        }),
      ),
    );
    expect(
      new Set(resolutions.map((value) => value.binding.taskIncarnationId)).size,
    ).toBe(3);
    const native = await service.acquireSession(resolutions[0]);
    for (const resolution of resolutions)
      expect(await service.acquireSession(resolution)).toBe(native);
    expect(jest.mocked(session).fromPartition).toHaveBeenCalledTimes(1);
    expect(mockPermissionRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects changed deletion usage without closing any profile views', async () => {
    const named = await service.repository.createNamed(randomUUID(), {
      displayName: 'Work',
    });
    const usage = jest.fn().mockResolvedValue({ tabs: [], defaults: [] });
    const disposed = jest.fn();
    const browser = {
      profileUsage: usage,
      withProfileFence: async (
        _id: string,
        operation: () => Promise<unknown>,
      ) => operation(),
      disposeProfileViews: disposed,
    } as unknown as BrowserService;
    const commands = createBrowserProfileCommands(browser);
    const preview = await commands.previewDelete({
      profileId: named.profileId,
      expectedMetadataRevision: named.metadataRevision,
    });
    usage.mockResolvedValue({
      tabs: [
        {
          browserId: 'new',
          projectId: 'code',
          worktreeId: 'first',
          runtimeGeneration: 1,
        },
      ],
      defaults: [],
    });
    await expect(
      commands.delete({ operationId: randomUUID(), token: preview.token }),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    expect(disposed).not.toHaveBeenCalled();
    expect(await service.repository.get(named.profileId)).toMatchObject({
      lifecycle: 'active',
    });
  });

  it.each(['code', 'cowork', 'app-advisor'])(
    'shares one Session only inside the same %s task and installs handlers once',
    async (projectId) => {
      const first = await service.resolve(projectId, 'first');
      const same = await service.resolve(projectId, 'first');
      const other = await service.resolve(projectId, 'second');
      expect(first.profile.profileId).toBe(same.profile.profileId);
      expect(other.profile.profileId).not.toBe(first.profile.profileId);
      expect(jest.mocked(session).fromPartition).not.toHaveBeenCalled();
      const native = await service.acquireSession(first);
      expect(await service.acquireSession(same)).toBe(native);
      expect(await service.acquireSession(other)).not.toBe(native);
      expect(jest.mocked(session).fromPartition).toHaveBeenCalledTimes(2);
      expect(mockPermissionRequest).toHaveBeenCalledTimes(2);
      expect(mockPermissionCheck).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['code', 'cowork', 'app-advisor'])(
    'enforces named enable for new %s bindings but preserves existing-tab use',
    async (projectId) => {
      const named = await service.repository.createNamed(randomUUID(), {
        displayName: 'Work',
      });
      const selection = { kind: 'named' as const, profileId: named.profileId };
      await expect(
        service.resolve(projectId, 'first', undefined, {
          selection,
          actor: 'agent',
        }),
      ).rejects.toMatchObject({ code: 'agent_enable_denied' });
      const user = await service.resolve(projectId, 'first', undefined, {
        selection,
      });
      expect(user.profile.profileId).toBe(named.profileId);
      const persisted = { profile: user.binding } as BrowserSessionSnapshot;
      await expect(
        service.resolve(projectId, 'first', persisted, {
          actor: 'agent',
          selection: { kind: 'task' },
        }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      const existing = await service.resolve(projectId, 'first', persisted, {
        actor: 'agent',
      });
      await expect(service.acquireSession(existing)).resolves.toBeDefined();
      const enabled = await service.repository.updateProfile(
        randomUUID(),
        named.profileId,
        named.metadataRevision,
        { allowEnable: true },
      );
      const pending = await service.resolve(projectId, 'second', undefined, {
        selection,
        actor: 'agent',
      });
      await service.repository.updateProfile(
        randomUUID(),
        named.profileId,
        enabled.metadataRevision,
        { allowEnable: false },
      );
      await expect(service.assertActive(pending)).rejects.toMatchObject({
        code: 'agent_enable_denied',
      });
      await expect(service.assertActive(existing)).resolves.toBeUndefined();
    },
  );

  it('enforces an enable-disabled default without silently allocating a Task profile', async () => {
    const named = await service.repository.createNamed(randomUUID(), {
      displayName: 'Work',
    });
    const scope = {
      kind: 'worktree' as const,
      projectId: 'code',
      worktreeId: 'first',
    };
    const slot = await service.repository.ensureSlot(scope, '1', randomUUID());
    await service.repository.setDefault(
      randomUUID(),
      scope,
      slot.incarnationId,
      slot.metadataRevision,
      { kind: 'named', profileId: named.profileId },
    );
    await expect(
      service.resolve('code', 'first', undefined, { actor: 'agent' }),
    ).rejects.toMatchObject({ code: 'agent_enable_denied' });
    expect(
      (await service.repository.getTask(scope))?.taskProfileId,
    ).toBeUndefined();
    expect(jest.mocked(session).fromPartition).not.toHaveBeenCalled();
  });

  it('rejects foreign or global scopes before opening native storage', async () => {
    await expect(service.resolve('code', 'missing')).rejects.toMatchObject({
      code: 'scope_unresolved',
    });
    await expect(service.resolve('cowork', 'home')).rejects.toMatchObject({
      code: 'scope_unresolved',
    });
    await expect(
      service.resolve('app-advisor', 'app-advisor'),
    ).rejects.toMatchObject({ code: 'scope_unresolved' });
    expect(jest.mocked(session).fromPartition).not.toHaveBeenCalled();
  });

  it.each(['cowork', 'app-advisor'])(
    'coordinates %s owner commit, failed removal, and fresh restore',
    async (projectId) => {
      const first = await service.resolve(projectId, 'first');
      await service.acquireSession(first);
      const prepared = await prepareTaskBrowserRetirement(projectId, 'first');
      expect(mockDisposeViews).toHaveBeenCalledWith(projectId, 'first');
      expect(mockClearData).not.toHaveBeenCalled();
      await abortTaskBrowserRetirement(prepared);
      expect(
        (await service.resolve(projectId, 'first')).profile.profileId,
      ).toBe(first.profile.profileId);
      await prepareTaskBrowserRetirement(projectId, 'first');
      const registry =
        projectId === 'app-advisor'
          ? 'app-workspaces/app-advisor/work-entries.json'
          : 'workspaces/cowork/work-entries.json';
      await seed(registry, { version: 1, entries: [] });
      await commitTaskBrowserRetirement(projectId, 'first');
      expect(mockClearData).toHaveBeenCalled();
      await seed(registry, {
        version: 1,
        entries: [{ id: 'first', createdAt: 'restored-owner' }],
      });
      const restored = await service.resolve(projectId, 'first');
      expect(restored.binding.taskIncarnationId).not.toBe(
        first.binding.taskIncarnationId,
      );
      expect(restored.partition).not.toBe(first.partition);
      await expect(
        service.resolve(projectId, 'first', {
          profile: first.binding,
        } as BrowserSessionSnapshot),
      ).rejects.toMatchObject({ code: 'scope_retired' });
    },
  );

  it('prepares retirement for a restored owner before any browser allocation', async () => {
    await service.resolve('cowork', 'first');
    await prepareTaskBrowserRetirement('cowork', 'first');
    await seed('workspaces/cowork/work-entries.json', {
      version: 1,
      entries: [],
    });
    await commitTaskBrowserRetirement('cowork', 'first');
    await seed('workspaces/cowork/work-entries.json', {
      version: 1,
      entries: [{ id: 'first', createdAt: 'restored-owner' }],
    });

    const operationId = await prepareTaskBrowserRetirement('cowork', 'first');

    expect(operationId).toEqual(expect.any(String));
    await expect(
      service.repository.getTask({
        kind: 'cowork_work_entry',
        workspaceId: 'cowork',
        workEntryId: 'first',
      }),
    ).resolves.toMatchObject({
      lifecycle: 'retirement_pending',
      ownerCreatedAt: 'restored-owner',
      retirementOperationId: operationId,
    });
  });

  it('reclaims named-profile scratch only after its Task owner commits retirement', async () => {
    const named = await service.repository.createNamed(randomUUID(), {
      displayName: 'Shared account',
    });
    const binding = await service.resolve('code', 'first', undefined, {
      selection: { kind: 'named', profileId: named.profileId },
    });
    expect(
      (await service.repository.getTask(binding.owner.scope))?.taskProfileId,
    ).toBeUndefined();
    const prepared = await prepareTaskBrowserRetirement('code', 'first');
    await abortTaskBrowserRetirement(prepared);
    expect(mockRetiredScratch).not.toHaveBeenCalled();
    await prepareTaskBrowserRetirement('code', 'first');
    await seed('workspaces/code/worktrees.json', {
      version: 1,
      worktrees: [{ id: 'second', createdAt: '2' }],
    });
    await commitTaskBrowserRetirement('code', 'first');
    expect(mockRetiredScratch).toHaveBeenCalledWith(
      binding.owner.scope,
      binding.binding.taskIncarnationId,
    );
    expect((await service.repository.get(named.profileId)).lifecycle).toBe(
      'active',
    );
  });

  it('keeps native data before Git commit and rolls forward a verified quarantine despite an archive error', async () => {
    const first = await service.resolve('code', 'first');
    await service.acquireSession(first);
    const prepared = await prepareTaskBrowserRetirement('code', 'first');
    expect(mockClearData).not.toHaveBeenCalled();
    mockStagedGit.mockResolvedValueOnce({ teardown: { phase: 'verified' } });
    await settleFailedTaskBrowserRetirement(prepared);
    expect(await service.repository.getTask(first.owner.scope)).toMatchObject({
      lifecycle: 'retired',
    });
    expect(mockClearData).toHaveBeenCalled();
  });

  it('keeps an uncertain crashed retirement fenced to its own task and lets its archive adopt it', async () => {
    const stuck = await service.resolve('code', 'first');
    await service.acquireSession(stuck);
    const other = await service.resolve('code', 'second');
    const operationId = await prepareTaskBrowserRetirement('code', 'first');
    // The initiating process crashed before Git quarantine, and the checkout
    // is gone while its registry row remains.
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    });
    try {
      const restarted = new BrowserProfileService(dataRoot, mockNativeRoot);
      jest
        .spyOn(profileServiceModule, 'getBrowserProfileService')
        .mockReturnValue(restarted);

      await expect(restarted.ensureReady()).resolves.toBeUndefined();
      await expect(restarted.resolve('code', 'second')).resolves.toMatchObject({
        profile: { profileId: other.profile.profileId },
      });
      await expect(restarted.resolve('code', 'first')).rejects.toMatchObject({
        code: 'scope_retired',
      });
      expect(
        await restarted.repository.getTask(stuck.owner.scope),
      ).toMatchObject({
        lifecycle: 'retirement_pending',
        retirementOperationId: operationId,
      });
      expect(mockClearData).not.toHaveBeenCalled();

      await expect(prepareTaskBrowserRetirement('code', 'first')).resolves.toBe(
        operationId,
      );
      await seed('workspaces/code/worktrees.json', {
        version: 1,
        worktrees: [{ id: 'second', createdAt: '2' }],
      });
      await commitTaskBrowserRetirement('code', 'first');
      expect(
        await restarted.repository.getTask(stuck.owner.scope),
      ).toMatchObject({ lifecycle: 'retired' });
      await restarted.purgeRetired();
    } finally {
      kill.mockRestore();
    }
  });

  it('retires only a failed import destination, and aborts when its owner removal fails', async () => {
    const source = await service.resolve('cowork', 'first');
    const destination = await service.resolve('cowork', 'second');
    await service.acquireSession(source);
    await service.acquireSession(destination);
    await expect(
      withBrowserTaskOwnerRemoval('cowork', 'second', () =>
        Promise.reject(new Error('row write failed')),
      ),
    ).rejects.toThrow('row write failed');
    expect(
      await service.repository.getTask(destination.owner.scope),
    ).toMatchObject({ lifecycle: 'active' });
    expect(mockClearData).not.toHaveBeenCalled();
    await withBrowserTaskOwnerRemoval('cowork', 'second', () =>
      seed('workspaces/cowork/work-entries.json', {
        version: 1,
        entries: [{ id: 'first', createdAt: '3' }],
      }),
    );
    expect(
      await service.repository.getTask(destination.owner.scope),
    ).toMatchObject({ lifecycle: 'retired' });
    expect(
      await service.repository.get(source.profile.profileId),
    ).toMatchObject({ lifecycle: 'active' });
    expect(mockClearData).toHaveBeenCalledTimes(1);
  });

  it('retires a removed owner from its own slot without reading every task slot', async () => {
    const removed = [
      await service.resolve('code', 'first'),
      await service.resolve('cowork', 'first'),
      await service.resolve('app-advisor', 'first'),
    ];
    const kept = await service.resolve('code', 'second');
    await seed('workspaces/code/worktrees.json', {
      version: 1,
      worktrees: [{ id: 'second', createdAt: '2' }],
    });
    await seed('workspaces/cowork/work-entries.json', {
      version: 1,
      entries: [{ id: 'second', createdAt: '4' }],
    });
    await seed('app-workspaces/app-advisor/work-entries.json', {
      version: 1,
      entries: [{ id: 'second', createdAt: '6' }],
    });
    // Every archive retires its owner while holding the metadata lease, and a
    // long-lived install keeps one slot per worktree it ever had.
    const listTaskSlots = jest.spyOn(service.repository, 'listTaskSlots');

    await retireRemovedBrowserTask('code', 'first');
    await retireRemovedBrowserTask('cowork', 'first');
    await retireRemovedBrowserTask('app-advisor', 'first');
    // An owner that still exists, and one that never had a slot, are left alone.
    await retireRemovedBrowserTask('code', 'second');
    await retireRemovedBrowserTask('code', 'never-opened');

    expect(listTaskSlots).not.toHaveBeenCalled();
    for (const resolution of removed)
      expect(
        await service.repository.getTask(resolution.owner.scope),
      ).toMatchObject({ lifecycle: 'retired' });
    expect(await service.repository.getTask(kept.owner.scope)).toMatchObject({
      lifecycle: 'active',
    });
  });

  it('snapshots unused entries before deleting a parent and keeps their jobs outside the removed directory', async () => {
    const prepared = await prepareWorkspaceBrowserRetirement('cowork');
    expect(prepared.map((entry) => entry.worktreeId).sort()).toEqual([
      'first',
      'second',
    ]);
    expect(jest.mocked(session).fromPartition).not.toHaveBeenCalled();
    await seed('workspaces/index.json', {
      version: 1,
      workspaces: [{ id: 'code', type: 'single-repo' }],
    });
    await rm(join(dataRoot, 'workspaces/cowork'), { recursive: true });
    for (const entry of prepared)
      await commitTaskBrowserRetirement('cowork', entry.worktreeId);
    expect(
      (await service.repository.listTaskSlots()).filter(
        (slot) => slot.lifecycle === 'retired',
      ),
    ).toHaveLength(2);
    expect(jest.mocked(session).fromPartition).not.toHaveBeenCalled();
  });

  it.each(['code', 'cowork', 'app-advisor'])(
    'W1 adopts legacy storage after metadata discovery for %s without creating a native Session',
    async (projectId) => {
      const partition = `persist:canopy-browser-${projectId}-first`;
      await mkdir(join(mockNativeRoot, 'Partitions', partition.slice(8)), {
        recursive: true,
      });
      const slot = await service.taskContext(projectId, 'first');
      expect(slot.taskProfileId).toBeUndefined();
      expect(jest.mocked(session).fromPartition).not.toHaveBeenCalled();
      const resolved = await service.resolve(projectId, 'first');
      expect(resolved.partition).toBe(partition);
    },
  );

  it('W1 adopts legacy storage after named-first selection', async () => {
    const partition = 'persist:canopy-browser-code-first';
    await mkdir(join(mockNativeRoot, 'Partitions', partition.slice(8)), {
      recursive: true,
    });
    const named = await service.repository.createNamed(randomUUID(), {
      displayName: 'Work',
    });
    await service.resolve('code', 'first', undefined, {
      selection: { kind: 'named', profileId: named.profileId },
    });
    expect((await service.resolve('code', 'first')).partition).toBe(partition);
  });

  it.each(['code', 'cowork', 'app-advisor'])(
    'W1 retains the unallocated legacy locator through discovery and retirement abort for %s',
    async (projectId) => {
      const partition = `persist:canopy-browser-${projectId}-first`;
      await mkdir(join(mockNativeRoot, 'Partitions', partition.slice(8)), {
        recursive: true,
      });
      await service.taskContext(projectId, 'first');
      const prepared = await prepareTaskBrowserRetirement(projectId, 'first');
      expect((await service.repository.getRetirements())[0]).toMatchObject({
        legacyPartition: partition,
      });
      expect(jest.mocked(session).fromPartition).not.toHaveBeenCalled();
      await abortTaskBrowserRetirement(prepared);
      expect((await service.resolve(projectId, 'first')).partition).toBe(
        partition,
      );
    },
  );

  it('W1 preserves legacy adoption after a precommit retirement abort without earlier discovery', async () => {
    const partition = 'persist:canopy-browser-code-first';
    await mkdir(join(mockNativeRoot, 'Partitions', partition.slice(8)), {
      recursive: true,
    });
    const prepared = await prepareTaskBrowserRetirement('code', 'first');
    await abortTaskBrowserRetirement(prepared);
    expect((await service.resolve('code', 'first')).partition).toBe(partition);
  });

  it.each(['code', 'cowork', 'app-advisor'])(
    'W1 startup retires proven unresolved legacy ownership after its %s registry owner disappears',
    async (projectId) => {
      const partition = `persist:canopy-browser-${projectId}-first`;
      const native = join(mockNativeRoot, 'Partitions', partition.slice(8));
      await mkdir(native, { recursive: true });
      await writeFile(join(native, 'sentinel'), 'original login');
      await service.taskContext(projectId, 'first');
      const registry =
        projectId === 'app-advisor'
          ? 'app-workspaces/app-advisor/work-entries.json'
          : `workspaces/${projectId}/${projectId === 'code' ? 'worktrees' : 'work-entries'}.json`;
      await seed(
        registry,
        projectId === 'code'
          ? { version: 1, worktrees: [] }
          : { version: 1, entries: [] },
      );
      const restarted = new BrowserProfileService(dataRoot, mockNativeRoot);
      await restarted.ensureReady();
      await restarted.purgeRetired();
      await expect(access(native)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(jest.mocked(session).fromPartition).not.toHaveBeenCalled();
    },
  );

  it('adopts a uniquely owned existing partition and keeps the binding across restart', async () => {
    const partition = 'persist:canopy-browser-code-first';
    await mkdir(join(mockNativeRoot, 'Partitions', partition.slice(8)), {
      recursive: true,
    });
    const resolved = await service.resolve('code', 'first');
    expect(resolved.partition).toBe(partition);
    const restarted = new BrowserProfileService(dataRoot, mockNativeRoot);
    const restored = await restarted.resolve('code', 'first', {
      profile: resolved.binding,
    } as BrowserSessionSnapshot);
    expect(restored.partition).toBe(partition);
    expect(restored.binding.runtimeGeneration).toBe(
      resolved.binding.runtimeGeneration + 1,
    );
    await restarted.purgeRetired();
  });

  it('preserves ambiguous legacy storage without allocating a Session', async () => {
    await seed('workspaces/index.json', {
      version: 1,
      workspaces: [
        { id: 'a-b', type: 'single-repo' },
        { id: 'a', type: 'cowork' },
      ],
    });
    await seed('workspaces/a-b/worktrees.json', {
      version: 1,
      worktrees: [{ id: 'c', createdAt: '1' }],
    });
    await seed('workspaces/a/work-entries.json', {
      version: 1,
      entries: [{ id: 'b-c', createdAt: '2' }],
    });
    const native = join(mockNativeRoot, 'Partitions', 'canopy-browser-a-b-c');
    await mkdir(native, { recursive: true });
    await writeFile(join(native, 'sentinel'), 'legacy data');
    await service.taskContext('a-b', 'c');
    await expect(service.resolve('a-b', 'c')).rejects.toMatchObject({
      code: 'recovery_required',
    });
    expect(await readFile(join(native, 'sentinel'), 'utf8')).toBe(
      'legacy data',
    );
    expect(jest.mocked(session).fromPartition).not.toHaveBeenCalled();
    await seed('workspaces/a-b/worktrees.json', { version: 1, worktrees: [] });
    const restarted = new BrowserProfileService(dataRoot, mockNativeRoot);
    await restarted.ensureReady();
    await restarted.purgeRetired();
    expect(await readFile(join(native, 'sentinel'), 'utf8')).toBe(
      'legacy data',
    );
    expect(await restarted.repository.getCleanupJobs()).toEqual([]);
  });

  it('does not interpret a missing workspace index as permission to retire existing profiles', async () => {
    const first = await service.resolve('code', 'first');
    await rm(join(dataRoot, 'workspaces/index.json'));
    const restarted = new BrowserProfileService(dataRoot, mockNativeRoot);
    await expect(restarted.ensureReady()).rejects.toMatchObject({
      code: 'recovery_required',
    });
    expect(await restarted.repository.getTask(first.owner.scope)).toMatchObject(
      { lifecycle: 'active' },
    );
    expect(await restarted.repository.getCleanupJobs()).toEqual([]);
    expect(mockClearData).not.toHaveBeenCalled();
  });

  it('allows deleting an unused workspace with no task registry without creating a native Session', async () => {
    await rm(join(dataRoot, 'workspaces/cowork/work-entries.json'));
    expect(await prepareWorkspaceBrowserRetirement('cowork')).toEqual([]);
    expect(jest.mocked(session).fromPartition).not.toHaveBeenCalled();
  });

  it('keeps a failed native-path validation failed on retry instead of exposing an unverified cached Session', async () => {
    const resolved = await service.resolve('code', 'first');
    jest.mocked(session).fromPartition.mockReturnValueOnce({
      storagePath: join(root, 'foreign-native-directory'),
      setPermissionRequestHandler: mockPermissionRequest,
      setPermissionCheckHandler: mockPermissionCheck,
    } as never);
    await expect(service.acquireSession(resolved)).rejects.toMatchObject({
      code: 'recovery_required',
    });
    await expect(service.acquireSession(resolved)).rejects.toMatchObject({
      code: 'recovery_required',
    });
  });

  it('retries session initialization after transient metadata storage contention', async () => {
    const resolved = await service.resolve('code', 'first');
    const recordNativePath = jest
      .spyOn(service.repository, 'recordNativePath')
      .mockRejectedValueOnce(
        new BrowserProfileError(
          'storage_unavailable',
          'Browser profile metadata is in use by another process.',
        ),
      );

    await expect(service.acquireSession(resolved)).rejects.toMatchObject({
      code: 'storage_unavailable',
    });
    await expect(service.acquireSession(resolved)).resolves.toBeDefined();
    expect(recordNativePath).toHaveBeenCalledTimes(2);
  });

  it('retries existing native session initialization after transient metadata storage contention', async () => {
    const resolved = await service.resolve('code', 'first');
    await mkdir(service.nativePath(resolved.partition), { recursive: true });
    const recordNativePath = jest
      .spyOn(service.repository, 'recordNativePath')
      .mockRejectedValueOnce(
        new BrowserProfileError(
          'storage_unavailable',
          'Browser profile metadata is in use by another process.',
        ),
      );

    await expect(
      service.existingSession(
        resolved.profile.profileId,
        resolved.profile.storageGeneration,
      ),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
    await expect(
      service.existingSession(
        resolved.profile.profileId,
        resolved.profile.storageGeneration,
      ),
    ).resolves.toBeDefined();
    expect(recordNativePath).toHaveBeenCalledTimes(2);
  });

  it('does not journal an unchanged active task slot on repeated context reads', async () => {
    const first = await service.taskContext('code', 'first');
    const ensureSlot = jest.spyOn(service.repository, 'ensureSlot');

    await expect(service.taskContext('code', 'first')).resolves.toEqual(first);
    expect(ensureSlot).not.toHaveBeenCalled();
  });

  it('does not journal an unchanged active task slot for named-profile resolution', async () => {
    const named = await service.repository.createNamed(randomUUID(), {
      displayName: 'Shared account',
    });
    const selection = { kind: 'named' as const, profileId: named.profileId };
    await service.resolve('code', 'first', undefined, { selection });
    const ensureSlot = jest.spyOn(service.repository, 'ensureSlot');

    await service.resolve('code', 'first', undefined, { selection });

    expect(ensureSlot).not.toHaveBeenCalled();
  });

  it('fails closed before purging a cleanup job whose partition is active', async () => {
    const active = await service.repository.createNamed(randomUUID(), {
      displayName: 'Active',
    });
    const partition = await service.repository.getNativePartition(
      active.profileId,
      active.storageGeneration,
    );
    const native = service.nativePath(partition);
    await mkdir(native, { recursive: true });
    await writeFile(join(native, 'sentinel'), 'active login');
    const catalogPath = join(dataRoot, 'browser-profiles', 'catalog.json');
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as {
      jobs: Record<string, unknown>;
    };
    const jobId = randomUUID();
    catalog.jobs[jobId] = {
      jobId,
      profileId: active.profileId,
      storageGeneration: active.storageGeneration,
      partition,
      createdAt: Date.now(),
      status: 'pending',
    };
    await writeFile(catalogPath, JSON.stringify(catalog));

    await service.purgeRetired();

    expect(await readFile(join(native, 'sentinel'), 'utf8')).toBe(
      'active login',
    );
    expect(service.cleanupErrors.get(jobId)).toMatch(/active|recovery/i);
    expect(mockClearData).not.toHaveBeenCalled();
  });

  it('lets retirement defeat a pending creation without clearing before owner commit', async () => {
    const resolved = await service.resolve('code', 'first');
    const retirementId = randomUUID();
    await service.repository.prepareRetirement(
      resolved.owner.scope,
      resolved.owner.createdAt,
      retirementId,
    );
    await expect(service.acquireSession(resolved)).rejects.toMatchObject({
      code: 'scope_retired',
    });
    expect(mockClearData).not.toHaveBeenCalled();
    expect(await service.repository.getCleanupJobs()).toEqual([]);
    // Another service must not interpret this live process's retirement as a crash.
    const other = new BrowserProfileService(dataRoot, mockNativeRoot);
    await expect(other.resolve('code', 'first')).rejects.toMatchObject({
      code: 'scope_retired',
    });
    await service.repository.abortRetirement(retirementId);
    expect((await service.resolve('code', 'first')).profile.profileId).toBe(
      resolved.profile.profileId,
    );
    await other.purgeRetired();
  });

  it('clears a retired loaded Session but defers directory removal until a fresh runtime', async () => {
    const resolved = await service.resolve('code', 'first');
    const native = await service.acquireSession(resolved);
    const nativePath = native.storagePath;
    if (!nativePath) throw new Error('Expected native storage path');
    await mkdir(nativePath, { recursive: true });
    await writeFile(join(nativePath, 'sentinel'), 'synthetic');
    const retirementId = randomUUID();
    await service.repository.prepareRetirement(
      resolved.owner.scope,
      resolved.owner.createdAt,
      retirementId,
    );
    await seed('workspaces/code/worktrees.json', {
      version: 1,
      worktrees: [{ id: 'second', createdAt: '2' }],
    });
    await service.repository.commitRetirement(retirementId, {
      kind: 'owner_removed',
      ownerOperationId: retirementId,
    });
    mockClearData.mockRejectedValueOnce(new Error('Busy native store'));
    await service.purgeRetired();
    expect(service.cleanupErrors.size).toBe(1);
    await service.purgeRetired();
    expect(service.cleanupErrors.size).toBe(0);
    expect(mockClearData).toHaveBeenCalled();
    expect(mockClearCache).toHaveBeenCalled();
    expect(await readFile(join(nativePath, 'sentinel'), 'utf8')).toBe(
      'synthetic',
    );
    expect(await service.repository.getCleanupJobs()).toHaveLength(1);
    const restarted = new BrowserProfileService(dataRoot, mockNativeRoot);
    await restarted.ensureReady();
    await restarted.purgeRetired();
    await expect(access(nativePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await restarted.repository.getCleanupJobs()).toEqual([]);
  });
});
