import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKER_CATALOG_INSTRUCTION_DEFINITIONS,
  WORKER_CATALOG_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
  type CatalogMaterializationItemDescriptor,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../../runtime/errors';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import {
  createInProcessWorkerBinding,
  localWorkerTransportOf,
} from '../../../runtime/in-process-worker-binding';
import {
  createDirectLocalWorkerTransport,
  type LocalWorkerTransport,
} from '../../../runtime/local-worker-transport';
import { createWorkerExecutorReceipts } from '../../../runtime/worker-executor-receipts';
import { serializingWorkerPair } from '../../../runtime/__tests__/serializing-worker-pair';
import {
  ExecutionSecretGrants,
  refusingExecutionSecretSource,
} from '../../execution-secrets';
import { LocalWorkerExecution, OperationService } from '../../operations';
import { OperationLedger } from '../../operations/ledger';
import {
  CORE_CATALOG_MATERIALIZATION_KIND,
  CatalogSelectionUnavailableError,
  CoreCatalogMaterializations,
  catalogMaterializationIdentity,
  catalogSha256,
  createWorkerCatalogHandlers,
  type CatalogMaterializationResolution,
  type CatalogMaterializationResolver,
  type WorkerCatalogHandlers,
  type WorkerCatalogHost,
  type WorkerCatalogPluginInstall,
  type WorkerCatalogSkillInstall,
} from '..';

const caller: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'test-core',
  authorityId: 'authority',
  interfaceKind: 'daemon',
  grants: ['worker.catalog.read', 'worker.catalog.write'],
};
const instructions = WORKER_CATALOG_INSTRUCTION_DEFINITIONS;
const definitions = {
  queries: WORKER_CATALOG_QUERY_DEFINITIONS,
  instructions,
  streams: {},
};
const scope = { workspaceId: 'ws', worktreeId: 'wt', chatId: 'chat' };
const origin = { kind: 'client', sourceId: 'test' } as const;
const owner = { kind: 'system', id: 'test' } as const;

class MemoryWorkerHost implements WorkerCatalogHost {
  readonly installs = new Map<string, WorkerCatalogPluginInstall>();
  lookups = 0;
  lookupPlugin(
    marketplaceId: string,
    pluginName: string,
  ): Promise<WorkerCatalogPluginInstall | null> {
    this.lookups += 1;
    return Promise.resolve(
      this.installs.get(`${marketplaceId}/${pluginName}`) ?? null,
    );
  }

  lookupSkill(): Promise<WorkerCatalogSkillInstall | null> {
    return Promise.resolve(null);
  }

  lookupMcpServer(): Promise<null> {
    return Promise.resolve(null);
  }
}

class MemoryResolver implements CatalogMaterializationResolver {
  calls = 0;
  failure: Error | null = null;
  constructor(public resolution: CatalogMaterializationResolution) {}
  resolve(): Promise<CatalogMaterializationResolution> {
    this.calls += 1;
    return this.failure
      ? Promise.reject(this.failure)
      : Promise.resolve(this.resolution);
  }
}

function plugin(
  name: string,
  revision = 'v1',
  providers: ('claude' | 'codex')[] = ['claude'],
): CatalogMaterializationItemDescriptor {
  return {
    kind: 'plugin',
    entryId: `plugin:market/${name}`,
    marketplaceId: 'market',
    pluginName: name,
    providers,
    pluginRevision: catalogSha256(revision),
  };
}

function install(
  root: string,
  revision = 'v1',
  codex: WorkerCatalogPluginInstall['roots']['codex'] = null,
): WorkerCatalogPluginInstall {
  return {
    pluginRevision: catalogSha256(revision),
    roots: { claude: root, codex },
  };
}

function resolution(
  items: CatalogMaterializationItemDescriptor[],
): CatalogMaterializationResolution {
  return {
    selection: {
      revision: 1,
      selectedItemIds: items.map((item) => item.entryId),
    },
    items,
    deferred: [],
    unavailable: [],
    warnings: [],
  };
}

interface Harness {
  host: MemoryWorkerHost;
  handlers: WorkerCatalogHandlers;
  transport: LocalWorkerTransport;
  worker: ReturnType<typeof createCanopyDispatcher>;
  operations: OperationService;
  localWorker: LocalWorkerExecution;
  materializations: CoreCatalogMaterializations;
  resolver: MemoryResolver;
  /** Closes this core and opens another over the same ledger file and worker (a reconnect). */
  reconnect(): CoreCatalogMaterializations;
  close(): void;
}

function harness(
  kind: 'direct' | 'bundled',
  ledgerPath: string,
  items: CatalogMaterializationItemDescriptor[],
  options: {
    /** The worker's record limit. */
    maxRecords?: number;
    /** Holds a materialize reply after the worker has answered. */
    replyGate?: (materializationId: string) => Promise<void> | undefined;
  } = {},
): Harness {
  const { maxRecords, replyGate } = options;
  const host = new MemoryWorkerHost();
  const handlers = createWorkerCatalogHandlers({
    host,
    secrets: refusingExecutionSecretSource,
    ...(maxRecords !== undefined ? { maxRecords } : {}),
  });
  const receipts = createWorkerExecutorReceipts(instructions);
  const worker = createCanopyDispatcher({
    profile: kind === 'direct' ? 'core+worker' : 'worker',
    definitions,
    handlers: {
      queries: handlers.queries,
      instructions: receipts.wrap(handlers.instructions),
      streams: {},
    },
  });
  let transport: LocalWorkerTransport;
  let closeBinding = (): void => undefined;
  if (kind === 'direct')
    transport = createDirectLocalWorkerTransport({
      dispatcher: worker,
      instructions,
      caller,
      receipts,
    });
  else {
    const binding = createInProcessWorkerBinding({
      dispatcher: worker,
      definitions,
      caller,
      pair: serializingWorkerPair(),
      receipts,
    });
    transport = localWorkerTransportOf(binding, instructions);
    closeBinding = (): void => binding.close();
  }
  if (replyGate) {
    const inner = transport;
    transport = {
      ...inner,
      instruction: async (name, params, callOptions): Promise<unknown> => {
        const value = await inner.instruction(name, params, callOptions);
        if (
          name === 'worker.catalog.materialize' &&
          typeof params === 'object' &&
          params !== null &&
          'materializationId' in params &&
          typeof params.materializationId === 'string'
        )
          await replyGate(params.materializationId);
        return value;
      },
    };
  }
  const services: OperationService[] = [];
  const core = (
    resolver: CatalogMaterializationResolver,
  ): {
    operations: OperationService;
    localWorker: LocalWorkerExecution;
    materializations: CoreCatalogMaterializations;
  } => {
    const operations = new OperationService({
      openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
    });
    services.push(operations);
    const localWorker = new LocalWorkerExecution({ operations, transport });
    return {
      operations,
      localWorker,
      materializations: new CoreCatalogMaterializations({
        operations,
        localWorker,
        resolver,
        secrets: new ExecutionSecretGrants({
          reader: { read: () => Promise.resolve([]) },
        }),
      }),
    };
  };
  const resolver = new MemoryResolver(resolution(items));
  const first = core(resolver);
  return {
    host,
    handlers,
    transport,
    worker,
    resolver,
    ...first,
    reconnect: () => {
      for (const service of services) service.close();
      return core(resolver).materializations;
    },
    close: (): void => {
      for (const service of services) service.close();
      closeBinding();
      void worker.shutdown();
    },
  };
}

function rejection(promise: Promise<unknown>): Promise<CanopyOperationError> {
  return promise.then(
    () => {
      throw new Error('Expected a rejection');
    },
    (error: unknown) => {
      if (!(error instanceof CanopyOperationError)) throw error;
      return error;
    },
  );
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-4123-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('catalog materialization (CAN-4123)', () => {
  describe.each(['direct', 'bundled'] as const)(
    'over the %s local worker',
    (kind) => {
      let h: Harness;
      afterEach(() => h.close());

      it('the same selection content gives the same identity and any change gives a new one', () => {
        h = harness(kind, join(root, 'ledger.sqlite'), []);
        const a = plugin('a');
        const b = plugin('b');
        const first = catalogMaterializationIdentity([a, b], scope);
        expect(catalogMaterializationIdentity([b, a], scope)).toEqual(first);
        expect(
          catalogMaterializationIdentity([plugin('a', 'v2'), b], scope)
            .materializationId,
        ).not.toBe(first.materializationId);
        expect(
          catalogMaterializationIdentity([a, b], { ...scope, chatId: 'other' })
            .materializationId,
        ).not.toBe(first.materializationId);
      });

      it('the worker refuses descriptors that do not match their identity', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), []);
        h.host.installs.set('market/a', install('/plugins/a'));
        const { materializationId } = catalogMaterializationIdentity(
          [plugin('a')],
          scope,
        );
        const other = catalogMaterializationIdentity([plugin('b')], scope);
        const error = await rejection(
          h.transport.instruction(
            'worker.catalog.materialize',
            {
              materializationId,
              scope,
              itemDescriptors: [plugin('a')],
              expectedFingerprint: other.fingerprint,
              _meta: { idempotencyKey: materializationId },
            },
            { metadata: { idempotencyKey: 'direct' } },
          ),
        );
        expect(error.payload).toMatchObject({
          kind: 'invalid_argument',
          code: 'worker.catalog.invalidState',
        });
        expect(h.host.lookups).toBe(0);
      });

      it('materializes once per id and never rewrites it', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), [plugin('a')]);
        h.host.installs.set('market/a', install('/plugins/a'));
        const [first, second] = await Promise.all([
          h.materializations.materialize({ scope, origin, owner }),
          h.materializations.materialize({ scope, origin, owner }),
        ]);
        expect(first.state).toBe('ready');
        expect(second).toEqual(first);
        const dispatched = await h.operations.list({
          kinds: ['worker.catalog.materialize'],
          limit: 10,
        });
        expect(dispatched.items).toHaveLength(1);
        h.host.installs.set('market/a', install('/plugins/changed'));
        expect(
          await h.materializations.materialize({ scope, origin, owner }),
        ).toMatchObject({
          materializationId: first.materializationId,
          state: 'ready',
          effectiveItems: first.effectiveItems,
        });
        h.resolver.resolution = {
          ...h.resolver.resolution,
          selection: {
            revision: 2,
            selectedItemIds: ['plugin:market/a', 'skill:source/s'],
          },
          deferred: [{ entryId: 'skill:source/s', entryKind: 'mcp_server' }],
          warnings: ['A newer warning.'],
        };
        const reread = await h.materializations.materialize({
          scope,
          origin,
          owner,
        });
        expect(reread).toMatchObject({
          materializationId: first.materializationId,
          effectiveItems: first.effectiveItems,
          selection: { revision: 2 },
          deferred: [{ entryId: 'skill:source/s', entryKind: 'mcp_server' }],
        });
        expect(
          reread.diagnostics.filter(
            (diagnostic) =>
              diagnostic.code === 'core.catalog.resolutionWarning',
          ),
        ).toEqual([
          {
            entryId: null,
            code: 'core.catalog.resolutionWarning',
            severity: 'warning',
            message: 'A newer warning.',
          },
        ]);
        const again = await h.reconnect().materialize({ scope, origin, owner });
        expect(again.state).toBe('ready');
        expect(again.effectiveItems).toEqual(first.effectiveItems);
        expect(
          h.handlers.reader.resolve(first.materializationId)?.plugins[0]?.roots,
        ).toEqual({ claude: '/plugins/a' });
        expect(h.host.lookups).toBe(1);
      });

      it('a stale plugin revision fails the whole materialization and changes nothing else', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), [
          plugin('a'),
          plugin('b'),
        ]);
        h.host.installs.set('market/a', install('/plugins/a'));
        h.host.installs.set('market/b', install('/plugins/b', 'v2'));
        const outcome = await h.materializations.materialize({
          scope,
          origin,
          owner,
        });
        expect(outcome.state).toBe('failed');
        expect(outcome.error).toMatchObject({
          kind: 'conflict',
          code: 'worker.catalog.revisionConflict',
          retry: { kind: 'after_refresh', resource: 'core.catalog.snapshot' },
        });
        expect(outcome.effectiveItems).toEqual([]);
        expect(h.resolver.calls).toBe(1);
        expect(await h.operations.get(outcome.operationId)).toMatchObject({
          kind: CORE_CATALOG_MATERIALIZATION_KIND,
          status: 'failed',
        });
        expect(h.handlers.reader.resolve(outcome.materializationId)).toBeNull();
        const lookups = h.host.lookups;
        const retried = await h.materializations.materialize({
          scope,
          origin,
          owner,
        });
        expect(retried.state).toBe('failed');
        expect(retried.error).toMatchObject({
          code: 'worker.catalog.revisionConflict',
        });
        expect(h.host.lookups).toBe(lookups);
      });

      it('a failed materialization never evicts a ready one the core still serves', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), [plugin('a')], {
          maxRecords: 1,
        });
        h.host.installs.set('market/a', install('/plugins/a'));
        h.host.installs.set('market/b', install('/plugins/b', 'v2'));
        const ready = await h.materializations.materialize({
          scope,
          origin,
          owner,
        });
        h.resolver.resolution = resolution([plugin('b')]);
        const failed = await h.materializations.materialize({
          scope,
          origin,
          owner,
        });
        expect(failed.state).toBe('failed');
        expect(
          h.handlers.reader.resolve(ready.materializationId),
        ).not.toBeNull();
        expect(
          await h.worker.query(
            'worker.catalog.materialization.get',
            { materializationId: ready.materializationId },
            { caller },
          ),
        ).toMatchObject({ state: 'ready' });
      });

      it('a worker hit refreshes the record it answers with', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), [plugin('a')], {
          maxRecords: 2,
        });
        for (const name of ['a', 'b', 'c'])
          h.host.installs.set(`market/${name}`, install(`/plugins/${name}`));
        const first = await h.materializations.materialize({
          scope,
          origin,
          owner,
        });
        h.resolver.resolution = resolution([plugin('b')]);
        await h.materializations.materialize({ scope, origin, owner });
        const reconnected = h.reconnect();
        h.resolver.resolution = resolution([plugin('a')]);
        await reconnected.materialize({ scope, origin, owner });
        h.resolver.resolution = resolution([plugin('c')]);
        await reconnected.materialize({ scope, origin, owner });
        h.resolver.resolution = resolution([plugin('a')]);
        expect(
          await reconnected.materialize({ scope, origin, owner }),
        ).toMatchObject({ state: 'ready' });
        expect(
          h.handlers.reader.resolve(first.materializationId),
        ).not.toBeNull();
        expect(
          await h.worker.query(
            'worker.catalog.materialization.get',
            { materializationId: first.materializationId },
            { caller },
          ),
        ).toMatchObject({ state: 'ready' });
      });

      it('replies delivered after the worker evicted the bundle leave nothing stale', async () => {
        let open = (): void => undefined;
        const gate = new Promise<void>((resolve) => {
          open = resolve;
        });
        const a = catalogMaterializationIdentity([plugin('a')], scope);
        h = harness(kind, join(root, 'ledger.sqlite'), [plugin('a')], {
          maxRecords: 1,
          replyGate: (id) => (id === a.materializationId ? gate : undefined),
        });
        h.host.installs.set('market/a', install('/plugins/a'));
        h.host.installs.set('market/b', install('/plugins/b'));
        const pending = h.materializations.materialize({
          scope,
          origin,
          owner,
        });
        while (h.handlers.reader.resolve(a.materializationId) === null)
          await new Promise((resolve) => setImmediate(resolve));
        h.resolver.resolution = resolution([plugin('b')]);
        expect(
          await h.materializations.materialize({ scope, origin, owner }),
        ).toMatchObject({ state: 'ready' });
        expect(h.handlers.reader.resolve(a.materializationId)).toBeNull();
        open();
        await pending;
        h.resolver.resolution = resolution([plugin('a')]);
        expect(
          await h.materializations.materialize({ scope, origin, owner }),
        ).toMatchObject({ state: 'ready' });
        expect(h.handlers.reader.resolve(a.materializationId)).not.toBeNull();
      });

      it('a release that overtakes a materialize reply leaves nothing stale', async () => {
        let open = (): void => undefined;
        const gate = new Promise<void>((resolve) => {
          open = resolve;
        });
        h = harness(kind, join(root, 'ledger.sqlite'), [plugin('a')], {
          replyGate: () => gate,
        });
        h.host.installs.set('market/a', install('/plugins/a'));
        const { materializationId } = catalogMaterializationIdentity(
          [plugin('a')],
          scope,
        );
        const pending = h.materializations.materialize({
          scope,
          origin,
          owner,
        });
        while (h.handlers.reader.resolve(materializationId) === null)
          await new Promise((resolve) => setImmediate(resolve));
        expect(
          await h.materializations.release({
            materializationId,
            origin,
            owner,
          }),
        ).toEqual({ released: true });
        expect(h.handlers.reader.resolve(materializationId)).toBeNull();
        const again = h.materializations.materialize({ scope, origin, owner });
        open();
        const [first, second] = await Promise.all([pending, again]);
        expect(first).toMatchObject({ state: 'ready' });
        expect(second).toMatchObject({ state: 'ready' });
        expect(second.operationId).not.toBe(first.operationId);
        expect(h.handlers.reader.resolve(materializationId)).not.toBeNull();
        expect(h.host.lookups).toBe(2);
      });

      it('a plugin missing for one provider is left out of that provider with a diagnostic', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), [
          plugin('a', 'v1', ['claude', 'codex']),
        ]);
        h.host.installs.set('market/a', install('/plugins/a'));
        const outcome = await h.materializations.materialize({
          scope,
          origin,
          owner,
        });
        expect(outcome.state).toBe('ready');
        expect(outcome.effectiveItems).toEqual([
          { entryId: 'plugin:market/a', kind: 'plugin', providers: ['claude'] },
        ]);
        expect(
          outcome.diagnostics.filter(
            (diagnostic) =>
              diagnostic.code === 'worker.catalog.providerMissing',
          ),
        ).toEqual([
          {
            entryId: 'plugin:market/a',
            code: 'worker.catalog.providerMissing',
            severity: 'warning',
            message: 'This plugin is not installed for Codex.',
          },
        ]);
      });

      it('release makes the bundle unreadable', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), [plugin('a')]);
        h.host.installs.set('market/a', install('/plugins/a'));
        const outcome = await h.materializations.materialize({
          scope,
          origin,
          owner,
        });
        expect(
          h.handlers.reader.resolve(outcome.materializationId),
        ).not.toBeNull();
        expect(
          await h.materializations.release({
            materializationId: outcome.materializationId,
            origin,
            owner,
          }),
        ).toEqual({ released: true });
        expect(h.handlers.reader.resolve(outcome.materializationId)).toBeNull();
        expect(
          await h.worker.query(
            'worker.catalog.materialization.get',
            { materializationId: outcome.materializationId },
            { caller },
          ),
        ).toMatchObject({ state: 'released' });
      });

      it('materializing again after release gives a ready, readable materialization', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), [plugin('a')]);
        h.host.installs.set('market/a', install('/plugins/a'));
        const first = await h.materializations.materialize({
          scope,
          origin,
          owner,
        });
        await h.materializations.release({
          materializationId: first.materializationId,
          origin,
          owner,
        });
        const again = await h.materializations.materialize({
          scope,
          origin,
          owner,
        });
        expect(again.state).toBe('ready');
        expect(again.materializationId).toBe(first.materializationId);
        expect(again.operationId).not.toBe(first.operationId);
        expect(
          h.handlers.reader.resolve(again.materializationId)?.plugins[0]?.roots,
        ).toEqual({ claude: '/plugins/a' });
        expect(
          await h.worker.query(
            'worker.catalog.materialization.get',
            { materializationId: again.materializationId },
            { caller },
          ),
        ).toMatchObject({ state: 'ready' });
        expect(h.host.lookups).toBe(2);
      });

      it('an unreadable selection admits nothing', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), [plugin('a')]);
        const failure = new CatalogSelectionUnavailableError();
        h.resolver.failure = failure;
        await expect(
          h.materializations.materialize({ scope, origin, owner }),
        ).rejects.toBe(failure);
        const listed = await h.operations.list({
          kinds: [CORE_CATALOG_MATERIALIZATION_KIND],
          limit: 10,
        });
        expect(listed.items).toEqual([]);
        expect(h.host.lookups).toBe(0);
      });
    },
  );
});
