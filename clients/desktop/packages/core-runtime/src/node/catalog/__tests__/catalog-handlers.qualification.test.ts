import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORE_CATALOG_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_QUERY_DEFINITIONS,
  CORE_CATALOG_SOURCE_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_SOURCE_QUERY_DEFINITIONS,
  emptyCatalogSelectionRefs,
  type CanopyCallerDescriptor,
  type CatalogEntry,
  type CatalogSelectionRefs,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import { OperationService } from '../../operations';
import { OperationLedger } from '../../operations/ledger';
import {
  CatalogMutationRuns,
  CatalogSelectionUnavailableError,
  catalogContentRevision,
  createCoreCatalogHandlers,
  type CatalogPluginTarget,
  type CatalogRefreshOutcome,
  type CatalogRefreshPlan,
  type CatalogSelectionRead,
  type CatalogSelectionScope,
  type CatalogSnapshotRead,
  type CatalogSourceRecord,
  type CoreCatalogHost,
} from '..';

const at = '2026-11-05T00:00:00.000Z';

function pluginEntry(
  name: string,
  availability: CatalogEntry['availability'],
): CatalogEntry {
  return {
    entryId: `plugin:m/${name}`,
    kind: 'plugin',
    name,
    description: '',
    source: 'plugin',
    content: {
      kind: 'plugin',
      manifest: {
        name,
        version: '',
        capabilities: [],
        dependencies: [],
      },
    },
    availability,
    revision: 0,
    createdAt: at,
    updatedAt: at,
  };
}

const ref = (name: string): { marketplaceId: string; pluginName: string } => ({
  marketplaceId: 'm',
  pluginName: name,
});

class MemoryCatalogHost implements CoreCatalogHost {
  entries: CatalogEntry[] = [
    pluginEntry('a', 'available'),
    pluginEntry('b', 'available'),
    pluginEntry('gone', 'missing'),
  ];
  global: CatalogSelectionRefs = {
    ...emptyCatalogSelectionRefs(),
    pluginRefs: [ref('a')],
  };
  chat: CatalogSelectionRead = {
    revision: 7,
    selections: {
      ...emptyCatalogSelectionRefs(),
      pluginRefs: [ref('a'), ref('gone')],
    },
    tombstones: { ...emptyCatalogSelectionRefs(), pluginRefs: [ref('b')] },
  };
  sources: CatalogSourceRecord[] = [
    {
      sourceId: 'git-source',
      displayName: 'owner/repo',
      locator: { kind: 'git', repository: 'owner/repo', ref: null },
      providers: ['claude', 'codex'],
      enabled: true,
      revision: 1,
      lastRefresh: { state: 'never' },
    },
  ];
  pluginTarget: CatalogPluginTarget = {
    entryId: 'plugin:m/a',
    marketplaceId: 'm',
    pluginName: 'a',
    install: 'external',
  };
  readError: Error | null = null;
  snapshotFailures = 0;
  listSourcesError: Error | null = null;
  refreshGate: Promise<void> = Promise.resolve();
  readonly calls = {
    replaceGlobalSelection: 0,
    replaceWorkspaceSelection: [] as Parameters<
      CoreCatalogHost['replaceWorkspaceSelection']
    >[0][],
    refreshSources: 0,
    installPlugin: 0,
  };

  snapshot(): Promise<CatalogSnapshotRead> {
    if (this.snapshotFailures > 0) {
      this.snapshotFailures -= 1;
      return Promise.reject(new Error('catalog cache busy'));
    }
    return Promise.resolve({
      entries: this.entries,
      refs: {
        ...emptyCatalogSelectionRefs(),
        pluginRefs: [ref('a'), ref('b'), ref('gone')],
      },
    });
  }

  readSelection(scope: CatalogSelectionScope): Promise<CatalogSelectionRead> {
    if (this.readError) return Promise.reject(this.readError);
    if (scope.kind === 'chat') return Promise.resolve(this.chat);
    if (scope.kind === 'workspace')
      return Promise.resolve({
        revision: 3,
        selections: emptyCatalogSelectionRefs(),
        tombstones: emptyCatalogSelectionRefs(),
      });
    return Promise.resolve({
      revision: catalogContentRevision(this.global),
      selections: this.global,
      tombstones: null,
    });
  }

  async replaceGlobalSelection(
    expectedRevision: number,
    refs: CatalogSelectionRefs,
  ): Promise<{ outcome: 'replaced' | 'conflict'; read: CatalogSelectionRead }> {
    this.calls.replaceGlobalSelection += 1;
    if (expectedRevision !== catalogContentRevision(this.global))
      return {
        outcome: 'conflict',
        read: await this.readSelection({ kind: 'global' }),
      };
    this.global = refs;
    return {
      outcome: 'replaced',
      read: await this.readSelection({ kind: 'global' }),
    };
  }

  replaceWorkspaceSelection(
    request: Parameters<CoreCatalogHost['replaceWorkspaceSelection']>[0],
  ): Promise<CatalogSelectionRead> {
    this.calls.replaceWorkspaceSelection.push(request);
    return Promise.resolve({
      revision: 4,
      selections: request.refs,
      tombstones: null,
    });
  }

  listSources(): Promise<CatalogSourceRecord[]> {
    if (this.listSourcesError) return Promise.reject(this.listSourcesError);
    return Promise.resolve(this.sources);
  }

  addGitSource(): Promise<CatalogSourceRecord> {
    return Promise.reject(new Error('not used'));
  }

  deleteSource(): Promise<{
    removedProviders: ('claude' | 'codex')[];
    alreadyAbsent: boolean;
  }> {
    return Promise.reject(new Error('not used'));
  }

  async refreshSources(
    plan: CatalogRefreshPlan,
  ): Promise<CatalogRefreshOutcome> {
    this.calls.refreshSources += 1;
    await this.refreshGate;
    return { refreshed: [...plan.updateSourceIds], failed: [] };
  }

  findPlugin(entryId: string): Promise<CatalogPluginTarget | null> {
    return Promise.resolve(
      entryId === this.pluginTarget.entryId ? this.pluginTarget : null,
    );
  }

  installPlugin(): Promise<void> {
    this.calls.installPlugin += 1;
    return Promise.resolve();
  }
}

const caller = (
  grant: CanopyCallerDescriptor['grants'][number],
): CanopyCallerDescriptor => ({
  principalId: 'p',
  clientInstanceId: 'c',
  authorityId: 'a',
  interfaceKind: 'desktop',
  grants: [grant],
});
const reader = caller('core.catalog.read');
const writer = caller('core.catalog.write');
const keyed = (key: string): { idempotencyKey: string } => ({
  idempotencyKey: key,
});

let root: string;
let operations: OperationService;
let host: MemoryCatalogHost;

let now = new Date('2026-11-05T00:00:00.000Z');

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the dispatcher type is inferred from its definitions
function compose() {
  const runs = new CatalogMutationRuns({ operations });
  const handlers = createCoreCatalogHandlers({ host, runs, clock: () => now });
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: {
        ...CORE_CATALOG_QUERY_DEFINITIONS,
        ...CORE_CATALOG_SOURCE_QUERY_DEFINITIONS,
      },
      instructions: {
        ...CORE_CATALOG_INSTRUCTION_DEFINITIONS,
        ...CORE_CATALOG_SOURCE_INSTRUCTION_DEFINITIONS,
      },
      streams: {},
    },
    handlers: { ...handlers, streams: {} },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-4123-'));
  const path = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(path),
  });
  host = new MemoryCatalogHost();
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('core.catalog handlers (CAN-4123)', () => {
  it('serves only the kinds it has and only available entries unless asked', async () => {
    const dispatcher = compose();
    await expect(
      dispatcher.query(
        'core.catalog.snapshot.get',
        { scope: {}, kinds: ['model'], includeUnavailable: false },
        { caller: reader },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });

    const available = await dispatcher.query(
      'core.catalog.snapshot.get',
      { scope: {}, kinds: [], includeUnavailable: false },
      { caller: reader },
    );
    expect(available.entries.map((entry) => entry.entryId)).toEqual([
      'plugin:m/a',
      'plugin:m/b',
    ]);
    const all = await dispatcher.query(
      'core.catalog.snapshot.get',
      { scope: {}, kinds: [], includeUnavailable: true },
      { caller: reader },
    );
    expect(all.entries.map((entry) => entry.entryId)).toContain(
      'plugin:m/gone',
    );

    host.entries = host.entries.map((entry) => ({
      ...entry,
      createdAt: '2026-11-06T00:00:00.000Z',
      updatedAt: '2026-11-06T00:00:00.000Z',
    }));
    now = new Date('2027-01-01T00:00:00.000Z');
    const again = await dispatcher.query(
      'core.catalog.snapshot.get',
      { scope: {}, kinds: [], includeUnavailable: false },
      { caller: reader },
    );
    expect(again.revision).toBe(available.revision);
    expect(again.generatedAt).not.toBe(available.generatedAt);
  });

  it('reads selections with unavailable and tombstoned ids', async () => {
    const dispatcher = compose();
    const chat = await dispatcher.query(
      'core.catalog.selection.get',
      { scope: { workspaceId: 'w', worktreeId: 't', chatId: 'c' } },
      { caller: reader },
    );
    expect(chat).toEqual({
      revision: 7,
      selectedItemIds: ['plugin:m/a', 'plugin:m/gone'],
      unavailableItemIds: ['plugin:m/gone'],
      tombstonedItemIds: ['plugin:m/b'],
    });
    await expect(
      dispatcher.query(
        'core.catalog.selection.get',
        { scope: { chatId: 'x' } },
        { caller: reader },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });

    host.readError = new CatalogSelectionUnavailableError();
    await expect(
      dispatcher.query(
        'core.catalog.selection.get',
        { scope: { workspaceId: 'w', worktreeId: 't', chatId: 'c' } },
        { caller: reader },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
  });

  it('replaces the global defaults under their revision and refuses a stale one', async () => {
    const dispatcher = compose();
    const read = await dispatcher.query(
      'core.catalog.selection.get',
      { scope: {} },
      { caller: reader },
    );
    const updated = await dispatcher.instruction(
      'core.catalog.selection.update',
      {
        scope: {},
        expectedRevision: read.revision,
        selectedItemIds: ['plugin:m/b'],
        _meta: keyed('k1'),
      },
      { caller: writer, metadata: keyed('k1') },
    );
    expect(updated.selectedItemIds).toEqual(['plugin:m/b']);
    expect(updated.revision).not.toBe(read.revision);
    expect(updated.materializationOperation).toBeNull();

    host.snapshotFailures = 1;
    host.readError = new CatalogSelectionUnavailableError();
    await expect(
      dispatcher.instruction(
        'core.catalog.selection.update',
        {
          scope: {},
          expectedRevision: read.revision,
          selectedItemIds: ['plugin:m/b'],
          _meta: keyed('k1'),
        },
        { caller: writer, metadata: keyed('k1') },
      ),
    ).resolves.toEqual(updated);
    host.snapshotFailures = 0;
    host.readError = null;

    await expect(
      dispatcher.instruction(
        'core.catalog.selection.update',
        {
          scope: {},
          expectedRevision: read.revision,
          selectedItemIds: ['plugin:m/a'],
          _meta: keyed('k2'),
        },
        { caller: writer, metadata: keyed('k2') },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.catalog.selection.revisionConflict',
        retry: { kind: 'after_refresh' },
      },
    });

    host.snapshotFailures = 1;
    const retried = {
      scope: {},
      expectedRevision: updated.revision,
      selectedItemIds: ['plugin:m/a'],
      _meta: keyed('k4'),
    };
    await expect(
      dispatcher.instruction('core.catalog.selection.update', retried, {
        caller: writer,
        metadata: keyed('k4'),
      }),
    ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
    const recovered = await dispatcher.instruction(
      'core.catalog.selection.update',
      retried,
      { caller: writer, metadata: keyed('k4') },
    );
    expect(recovered.selectedItemIds).toEqual(['plugin:m/a']);

    const calls = host.calls.replaceGlobalSelection;
    await expect(
      dispatcher.instruction(
        'core.catalog.selection.update',
        {
          scope: {},
          expectedRevision: recovered.revision,
          selectedItemIds: ['plugin:m/unknown'],
          _meta: keyed('k3'),
        },
        { caller: writer, metadata: keyed('k3') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(host.calls.replaceGlobalSelection).toBe(calls);
  });

  it('refuses chat writes and keeps workspace writes off the ledger', async () => {
    const dispatcher = compose();
    await expect(
      dispatcher.instruction(
        'core.catalog.selection.update',
        {
          scope: { workspaceId: 'w', worktreeId: 't', chatId: 'c' },
          expectedRevision: 7,
          selectedItemIds: [],
          _meta: keyed('k'),
        },
        { caller: writer, metadata: keyed('k') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });

    await dispatcher.instruction(
      'core.catalog.selection.update',
      {
        scope: { workspaceId: 'w' },
        expectedRevision: 3,
        selectedItemIds: ['plugin:m/a'],
        _meta: keyed('k'),
      },
      { caller: writer, metadata: keyed('k') },
    );
    expect(host.calls.replaceWorkspaceSelection).toEqual([
      expect.objectContaining({
        workspaceId: 'w',
        expectedRevision: 3,
        idempotencyKey: 'catalog-selection:k',
      }),
    ]);
    const { items } = await operations.list({
      kinds: ['core.catalog.selection.update'],
      limit: 10,
    });
    expect(items).toEqual([]);
  });

  it('admits a refresh, returns at once and replays its acknowledgement', async () => {
    const dispatcher = compose();
    let release = (): void => undefined;
    host.refreshGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const params = {
      sourceIds: ['git-source'],
      providers: ['claude', 'codex'] satisfies ('claude' | 'codex')[],
      mode: 'update_then_scan' as const,
      _meta: keyed('k'),
    };

    const ack = await dispatcher.instruction(
      'core.catalog.source.refresh',
      params,
      { caller: writer, metadata: keyed('k') },
    );
    const anyOperationId: unknown = expect.any(String);
    expect(ack).toEqual({
      operationId: anyOperationId,
      acceptedSources: ['git-source'],
      scanOnlySources: [],
    });
    const replay = await dispatcher.instruction(
      'core.catalog.source.refresh',
      params,
      { caller: writer, metadata: keyed('k') },
    );
    expect(replay).toEqual(ack);
    release();
    await operations.waitForTerminal(ack.operationId);
    expect(host.calls.refreshSources).toBe(1);

    host.listSourcesError = new Error('sources busy');
    await expect(
      dispatcher.instruction('core.catalog.source.refresh', params, {
        caller: writer,
        metadata: keyed('k'),
      }),
    ).resolves.toEqual(ack);
    host.listSourcesError = null;

    host.sources = [];
    const afterRemoval = await dispatcher.instruction(
      'core.catalog.source.refresh',
      params,
      { caller: writer, metadata: keyed('k') },
    );
    expect(afterRemoval).toEqual(ack);
    expect(host.calls.refreshSources).toBe(1);

    await expect(
      dispatcher.instruction(
        'core.catalog.source.refresh',
        { ...params, sourceIds: ['nope'], _meta: keyed('k2') },
        { caller: writer, metadata: keyed('k2') },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'not_found', code: 'core.catalog.sourceNotFound' },
    });
    const { items } = await operations.list({
      kinds: ['core.catalog.source.refresh'],
      limit: 10,
    });
    expect(items).toHaveLength(1);
  });

  it('installs a plugin once per key and refuses what cannot be installed', async () => {
    const dispatcher = compose();
    await expect(
      dispatcher.instruction(
        'core.catalog.plugin.install',
        {
          entryId: 'plugin:m/a',
          providers: ['claude', 'codex'],
          _meta: keyed('k1'),
        },
        { caller: writer, metadata: keyed('k1') },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.catalog.pluginNotInstallable' },
    });

    const install = (): Promise<unknown> =>
      dispatcher.instruction(
        'core.catalog.plugin.install',
        { entryId: 'plugin:m/a', providers: ['claude'], _meta: keyed('k2') },
        { caller: writer, metadata: keyed('k2') },
      );
    await expect(Promise.all([install(), install()])).resolves.toEqual([
      { entryId: 'plugin:m/a', providers: ['claude'] },
      { entryId: 'plugin:m/a', providers: ['claude'] },
    ]);
    expect(host.calls.installPlugin).toBe(1);
  });

  it('refuses calls without their grant', async () => {
    const dispatcher = compose();
    await expect(
      dispatcher.query(
        'core.catalog.selection.get',
        { scope: {} },
        { caller: writer },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    await expect(
      dispatcher.instruction(
        'core.catalog.plugin.install',
        { entryId: 'plugin:m/a', providers: ['claude'], _meta: keyed('k') },
        { caller: reader, metadata: keyed('k') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
  });
});
