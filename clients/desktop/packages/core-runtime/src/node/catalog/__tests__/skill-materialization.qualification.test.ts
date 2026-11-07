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
import { LocalWorkerExecution, OperationService } from '../../operations';
import { OperationLedger } from '../../operations/ledger';
import {
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
  readonly plugins = new Map<string, WorkerCatalogPluginInstall>();
  readonly skills = new Map<string, WorkerCatalogSkillInstall>();
  lookups = 0;
  lookupPlugin(
    marketplaceId: string,
    pluginName: string,
  ): Promise<WorkerCatalogPluginInstall | null> {
    this.lookups += 1;
    return Promise.resolve(
      this.plugins.get(`${marketplaceId}/${pluginName}`) ?? null,
    );
  }
  lookupSkill(
    sourceId: string,
    skillName: string,
  ): Promise<WorkerCatalogSkillInstall | null> {
    this.lookups += 1;
    return Promise.resolve(this.skills.get(`${sourceId}/${skillName}`) ?? null);
  }
}

class MemoryResolver implements CatalogMaterializationResolver {
  constructor(public resolution: CatalogMaterializationResolution) {}
  resolve(): Promise<CatalogMaterializationResolution> {
    return Promise.resolve(this.resolution);
  }
}

function skill(
  name: string,
  revision = 'v1',
): CatalogMaterializationItemDescriptor {
  return {
    kind: 'skill',
    entryId: `skill:custom:app/${name}`,
    sourceId: 'custom:app',
    skillName: name,
    skillRevision: catalogSha256(revision),
  };
}

function skillInstall(dir: string, revision = 'v1'): WorkerCatalogSkillInstall {
  return {
    skillRevision: catalogSha256(revision),
    sourceDir: dir,
    canonicalSourceDir: `${dir}-canonical`,
    skillMdPath: `${dir}/SKILL.md`,
  };
}

const plugin: CatalogMaterializationItemDescriptor = {
  kind: 'plugin',
  entryId: 'plugin:market/p',
  marketplaceId: 'market',
  pluginName: 'p',
  providers: ['claude'],
  pluginRevision: catalogSha256('v1'),
};

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
  materializations: CoreCatalogMaterializations;
  resolver: MemoryResolver;
  close(): void;
}

function harness(
  kind: 'direct' | 'bundled',
  ledgerPath: string,
  items: CatalogMaterializationItemDescriptor[],
): Harness {
  const host = new MemoryWorkerHost();
  const handlers = createWorkerCatalogHandlers({ host });
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
  const operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  const resolver = new MemoryResolver(resolution(items));
  const materializations = new CoreCatalogMaterializations({
    operations,
    localWorker: new LocalWorkerExecution({ operations, transport }),
    resolver,
  });
  return {
    host,
    handlers,
    transport,
    materializations,
    resolver,
    close: (): void => {
      operations.close();
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
  root = mkdtempSync(join(tmpdir(), 'can-4124-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('skill materialization (CAN-4124)', () => {
  describe.each(['direct', 'bundled'] as const)(
    'over the %s local worker',
    (kind) => {
      let h: Harness;
      afterEach(() => h.close());

      it('skill items are part of the identity', () => {
        h = harness(kind, join(root, 'ledger.sqlite'), []);
        const first = catalogMaterializationIdentity(
          [skill('a'), skill('b')],
          scope,
        );
        expect(
          catalogMaterializationIdentity([skill('b'), skill('a')], scope),
        ).toEqual(first);
        expect(
          catalogMaterializationIdentity([skill('a', 'v2'), skill('b')], scope)
            .materializationId,
        ).not.toBe(first.materializationId);
        expect(
          catalogMaterializationIdentity([plugin, skill('a')], scope)
            .materializationId,
        ).not.toBe(
          catalogMaterializationIdentity([plugin], scope).materializationId,
        );
      });

      it('materializes a skill once and pins its directories', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), [skill('a')]);
        h.host.skills.set('custom:app/a', skillInstall('/skills/a'));
        const first = await h.materializations.materialize({
          scope,
          origin,
          owner,
        });
        expect(first.state).toBe('ready');
        expect(first.effectiveItems).toEqual([
          { entryId: 'skill:custom:app/a', kind: 'skill' },
        ]);
        const pinned = {
          sourceDir: '/skills/a',
          canonicalSourceDir: '/skills/a-canonical',
          skillMdPath: '/skills/a/SKILL.md',
        };
        expect(
          h.handlers.reader.resolve(first.materializationId)?.skills[0],
        ).toMatchObject(pinned);

        h.host.skills.set('custom:app/a', skillInstall('/skills/moved'));
        await expect(
          h.materializations.materialize({ scope, origin, owner }),
        ).resolves.toMatchObject({
          materializationId: first.materializationId,
          state: 'ready',
          effectiveItems: first.effectiveItems,
        });
        expect(
          h.handlers.reader.resolve(first.materializationId)?.skills[0],
        ).toMatchObject(pinned);
      });

      it('a changed skill fails the whole materialization', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), [plugin, skill('a')]);
        h.host.plugins.set('market/p', {
          pluginRevision: catalogSha256('v1'),
          roots: { claude: '/plugins/p', codex: null },
        });
        h.host.skills.set('custom:app/a', skillInstall('/skills/a', 'v2'));
        const outcome = await h.materializations.materialize({
          scope,
          origin,
          owner,
        });
        expect(outcome.state).toBe('failed');
        expect(outcome.error).toMatchObject({
          code: 'worker.catalog.revisionConflict',
        });
        expect(outcome.effectiveItems).toEqual([]);
        expect(h.handlers.reader.resolve(outcome.materializationId)).toBeNull();
      });

      it('a missing skill is left out with a diagnostic', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), [skill('a')]);
        const outcome = await h.materializations.materialize({
          scope,
          origin,
          owner,
        });
        expect(outcome.state).toBe('ready');
        expect(outcome.effectiveItems).toEqual([]);
        expect(
          outcome.diagnostics.filter(
            (diagnostic) => diagnostic.code === 'worker.catalog.itemMissing',
          ),
        ).toEqual([
          {
            entryId: 'skill:custom:app/a',
            code: 'worker.catalog.itemMissing',
            severity: 'error',
            message: 'This skill is not installed on this device.',
          },
        ]);
      });

      it('the worker refuses malformed skill descriptors', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), []);
        const { materializationId, fingerprint } =
          catalogMaterializationIdentity([skill('a')], scope);
        const dispatch = (item: Record<string, unknown>): Promise<unknown> =>
          h.transport.instruction(
            'worker.catalog.materialize',
            {
              materializationId,
              scope,
              itemDescriptors: [item],
              expectedFingerprint: fingerprint,
              _meta: { idempotencyKey: materializationId },
            },
            { metadata: { idempotencyKey: 'direct' } },
          );
        const extra = await rejection(dispatch({ ...skill('a'), extra: true }));
        expect(extra.payload.kind).toBe('invalid_argument');
        const badRevision = await rejection(
          dispatch({ ...skill('a'), skillRevision: 'sha256:abc' }),
        );
        expect(badRevision.payload.kind).toBe('invalid_argument');
        expect(h.host.lookups).toBe(0);
      });
    },
  );
});
