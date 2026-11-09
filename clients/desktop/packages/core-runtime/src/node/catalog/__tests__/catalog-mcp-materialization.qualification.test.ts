import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKER_CATALOG_INSTRUCTION_DEFINITIONS,
  WORKER_CATALOG_QUERY_DEFINITIONS,
  catalogMaterializationSecretBindings,
  type CanopyCallerDescriptor,
  type CatalogMaterializationItemDescriptor,
  type CatalogMaterializationMcpServerDescriptor,
  type DelegationRecord,
  type ExecutionSecretBinding,
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
  executionSecretFingerprints,
  type ExecutionSecretRead,
  type ExecutionSecretReader,
} from '../../execution-secrets';
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
  type WorkerCatalogMcpServerInstall,
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

const ref = (char: string): string => `ssr1_${char.repeat(43)}`;
const [r1, r2, r3] = [ref('a'), ref('b'), ref('c')];
const canaries = new Map([
  [r1, 'secret-canary-mcp-1'],
  [r2, 'secret-canary-mcp-2'],
  [r3, 'secret-canary-mcp-3'],
]);

function mcp(
  serverId: string,
  secretRefs: string[],
  revision = 'v1',
): CatalogMaterializationMcpServerDescriptor {
  return {
    kind: 'mcp_server',
    entryId: `mcp_server:${serverId}/config`,
    serverId,
    configId: 'config',
    transport: 'stdio',
    binding: 'device',
    configRevision: catalogSha256(revision),
    secretRefs,
  };
}

/** The worker's MCP view; `pin` puts each value under its reference in a copy of a fixture record. */
class MemoryWorkerHost implements WorkerCatalogHost {
  readonly revisions = new Map<string, string>();
  lookups = 0;
  pins = 0;
  /** Holds every lookup until it resolves. */
  gate: Promise<void> | null = null;
  lookupPlugin(): Promise<null> {
    return Promise.resolve(null);
  }
  lookupSkill(): Promise<null> {
    return Promise.resolve(null);
  }
  async lookupMcpServer(
    serverId: string,
  ): Promise<WorkerCatalogMcpServerInstall | null> {
    this.lookups += 1;
    if (this.gate) await this.gate;
    const revision = this.revisions.get(serverId);
    if (revision === undefined) return null;
    return {
      configRevision: catalogSha256(revision),
      pin: (values) => {
        this.pins += 1;
        return {
          command: `${serverId}-server`,
          env: Object.fromEntries(values),
        };
      },
    };
  }
}

class CountingReader implements ExecutionSecretReader {
  readonly calls: (readonly ExecutionSecretBinding[])[] = [];
  /** Runs while the values are read, as a concurrent save would. */
  onRead: (() => void) | null = null;
  read(
    bindings: readonly ExecutionSecretBinding[],
  ): Promise<readonly ExecutionSecretRead[]> {
    this.calls.push(bindings);
    this.onRead?.();
    return Promise.resolve(
      bindings.map((binding): ExecutionSecretRead => {
        const value =
          binding.source.kind === 'stored-secret'
            ? canaries.get(binding.source.ref)
            : undefined;
        return value === undefined
          ? { status: 'missing' }
          : { status: 'ok', value };
      }),
    );
  }
}

class MemoryResolver implements CatalogMaterializationResolver {
  constructor(public resolution: CatalogMaterializationResolution) {}
  resolve(): Promise<CatalogMaterializationResolution> {
    return Promise.resolve(this.resolution);
  }
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
  reader: CountingReader;
  grants: ExecutionSecretGrants;
  handlers: WorkerCatalogHandlers;
  transport: LocalWorkerTransport;
  worker: ReturnType<typeof createCanopyDispatcher>;
  operations: OperationService;
  materializations: CoreCatalogMaterializations;
  /** Delegation records of every materialize dispatch, in order. */
  delegations: DelegationRecord[];
  /** Results and errors every dispatch returned, for the canary scan. */
  payloads: unknown[];
  /** Closes this core and opens another over the same ledger and worker (a reconnect). */
  reconnect(): CoreCatalogMaterializations;
  close(): void;
}

function harness(
  kind: 'direct' | 'bundled',
  ledgerPath: string,
  items: CatalogMaterializationItemDescriptor[],
): Harness {
  const host = new MemoryWorkerHost();
  const reader = new CountingReader();
  const grants = new ExecutionSecretGrants({ reader });
  const handlers = createWorkerCatalogHandlers({ host, secrets: grants });
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
  const delegations: DelegationRecord[] = [];
  const payloads: unknown[] = [];
  const services: OperationService[] = [];
  const resolver = new MemoryResolver(resolution(items));
  const core = (): {
    operations: OperationService;
    materializations: CoreCatalogMaterializations;
  } => {
    const operations = new OperationService({
      openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
    });
    services.push(operations);
    const localWorker = new LocalWorkerExecution({ operations, transport });
    const dispatch = localWorker.dispatch.bind(localWorker);
    localWorker.dispatch = async (request): ReturnType<typeof dispatch> => {
      const dispatched = await dispatch(request);
      delegations.push(dispatched.delegation);
      payloads.push(dispatched.result, dispatched.operation.error);
      return dispatched;
    };
    return {
      operations,
      materializations: new CoreCatalogMaterializations({
        operations,
        localWorker,
        resolver,
        secrets: grants,
      }),
    };
  };
  const first = core();
  return {
    host,
    reader,
    grants,
    handlers,
    transport,
    worker,
    delegations,
    payloads,
    ...first,
    reconnect: () => {
      for (const service of services) service.close();
      return core().materializations;
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

const audience = (
  materializationId: string,
): { operation: 'worker.catalog.materialize'; key: string } => ({
  operation: 'worker.catalog.materialize',
  key: materializationId,
});

/** True when no grant for this materialization is left to redeem. */
async function grantGone(
  grants: ExecutionSecretGrants,
  materializationId: string,
  bindings: readonly ExecutionSecretBinding[],
): Promise<boolean> {
  const error = await rejection(
    grants.redeem(
      { audience: audience(materializationId), bindings },
      new AbortController().signal,
    ),
  );
  return error.payload.code === 'worker.executionSecret.notGranted';
}

let root: string;
const scanned: unknown[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-4125-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('catalog MCP materialization (CAN-4125)', () => {
  describe.each(['direct', 'bundled'] as const)(
    'over the %s local worker',
    (kind) => {
      let h: Harness;
      const items = [mcp('b', [r3]), mcp('a', [r1, r2])];
      const bindings = catalogMaterializationSecretBindings(items);
      afterEach(() => {
        // Case 7 reads every ledger file and payload these cases leave.
        for (const file of readdirSync(root))
          scanned.push(readFileSync(join(root, file)).toString('latin1'));
        scanned.push(JSON.stringify(h.payloads));
        h.close();
      });

      it('redeems MCP secrets only from the grant staged for this materialization', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), items);
        h.host.revisions.set('a', 'v1');
        h.host.revisions.set('b', 'v1');
        const outcome = await h.materializations.materialize({
          scope,
          origin,
          owner,
        });
        scanned.push(JSON.stringify(outcome));
        expect(outcome.state).toBe('ready');
        expect(outcome.effectiveItems).toEqual([
          {
            entryId: 'mcp_server:a/config',
            kind: 'mcp_server',
            transport: 'stdio',
          },
          {
            entryId: 'mcp_server:b/config',
            kind: 'mcp_server',
            transport: 'stdio',
          },
        ]);
        expect(h.reader.calls).toEqual([bindings]);
        expect(
          h.handlers.reader
            .resolve(outcome.materializationId)
            ?.mcpServers.map((server) => server.server),
        ).toEqual([
          {
            command: 'a-server',
            env: { [r1]: 'secret-canary-mcp-1', [r2]: 'secret-canary-mcp-2' },
          },
          { command: 'b-server', env: { [r3]: 'secret-canary-mcp-3' } },
        ]);
        expect(h.delegations[0]?.secrets).toEqual(
          executionSecretFingerprints(bindings),
        );
      });

      it('a dispatch nobody staged redeems nothing', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), items);
        h.host.revisions.set('a', 'v1');
        h.host.revisions.set('b', 'v1');
        const { materializationId, fingerprint } =
          catalogMaterializationIdentity(items, scope);
        const error = await rejection(
          h.transport.instruction(
            'worker.catalog.materialize',
            {
              materializationId,
              scope,
              itemDescriptors: items,
              expectedFingerprint: fingerprint,
              secretGrantIds: [materializationId],
              _meta: { idempotencyKey: materializationId },
            },
            { metadata: { idempotencyKey: 'unstaged' } },
          ),
        );
        scanned.push(JSON.stringify(error.payload));
        expect(error.payload.code).toBe('worker.executionSecret.notGranted');
        expect(h.reader.calls).toHaveLength(0);
        const missing = await rejection(
          h.worker.query(
            'worker.catalog.materialization.get',
            { materializationId },
            { caller },
          ),
        );
        expect(missing.payload.code).toBe(
          'worker.catalog.materialization.notFound',
        );
      });

      it('secret grants that do not match are refused before anything is read', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), items);
        h.host.revisions.set('a', 'v1');
        h.host.revisions.set('b', 'v1');
        const send = (
          descriptors: CatalogMaterializationItemDescriptor[],
          secretGrantIds: string[] | undefined,
        ): Promise<CanopyOperationError> => {
          const { materializationId, fingerprint } =
            catalogMaterializationIdentity(descriptors, scope);
          return rejection(
            h.transport.instruction(
              'worker.catalog.materialize',
              {
                materializationId,
                scope,
                itemDescriptors: descriptors,
                expectedFingerprint: fingerprint,
                ...(secretGrantIds
                  ? {
                      secretGrantIds: secretGrantIds.map((id) =>
                        id === 'self' ? materializationId : id,
                      ),
                    }
                  : {}),
                _meta: { idempotencyKey: materializationId },
              },
              {
                metadata: {
                  idempotencyKey: `grants-${String(secretGrantIds)}`,
                },
              },
            ),
          );
        };
        for (const error of [
          await send(items, undefined),
          await send(items, ['other']),
          await send(items, ['self', 'self']),
          await send([mcp('a', [])], ['self']),
        ])
          expect(error.payload).toMatchObject({
            kind: 'invalid_argument',
            code: 'worker.catalog.invalidState',
          });
        expect(h.host.lookups).toBe(0);
        expect(h.reader.calls).toHaveLength(0);
      });

      it('a changed MCP configuration fails before any secret is read', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), items);
        h.host.revisions.set('a', 'v1');
        h.host.revisions.set('b', 'v2');
        const outcome = await h.materializations.materialize({
          scope,
          origin,
          owner,
        });
        scanned.push(JSON.stringify(outcome));
        expect(outcome.state).toBe('failed');
        expect(outcome.error).toMatchObject({
          code: 'worker.catalog.revisionConflict',
        });
        expect(h.reader.calls).toHaveLength(0);
        expect(
          await grantGone(h.grants, outcome.materializationId, bindings),
        ).toBe(true);
      });

      it('a configuration saved while its secrets are read fails instead of pinning them', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), items);
        h.host.revisions.set('a', 'v1');
        h.host.revisions.set('b', 'v1');
        const { host } = h;
        h.reader.onRead = (): void => {
          host.revisions.set('b', 'v2');
        };
        const outcome = await h.materializations.materialize({
          scope,
          origin,
          owner,
        });
        scanned.push(JSON.stringify(outcome));
        expect(outcome.state).toBe('failed');
        expect(outcome.error).toMatchObject({
          code: 'worker.catalog.revisionConflict',
        });
        expect(h.reader.calls).toHaveLength(1);
        expect(h.handlers.reader.resolve(outcome.materializationId)).toBeNull();
        expect(
          await grantGone(h.grants, outcome.materializationId, bindings),
        ).toBe(true);
      });

      it('a recheck mismatch keeps the redeemed values out of the stored record and the logs', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), items);
        h.host.revisions.set('a', 'v1');
        h.host.revisions.set('b', 'v1');
        const { host } = h;
        h.reader.onRead = (): void => {
          host.revisions.set('a', 'v2');
        };
        const logged: unknown[][] = [];
        const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
        const spies = methods.map((method) =>
          jest.spyOn(console, method).mockImplementation((...args) => {
            logged.push(args);
          }),
        );
        try {
          const outcome = await h.materializations.materialize({
            scope,
            origin,
            owner,
          });
          expect(outcome.state).toBe('failed');
          expect(h.reader.calls).toHaveLength(1);
          expect(h.host.pins).toBe(0);
          const record = await h.worker.query(
            'worker.catalog.materialization.get',
            { materializationId: outcome.materializationId },
            { caller },
          );
          expect(record).toMatchObject({ state: 'failed' });
          for (const text of [
            JSON.stringify(outcome),
            JSON.stringify(record),
            JSON.stringify(logged),
          ])
            for (const canary of canaries.values())
              expect(text.includes(canary)).toBe(false);
        } finally {
          for (const spy of spies) spy.mockRestore();
        }
      });

      it('a keyed replay never redeems again', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), items);
        h.host.revisions.set('a', 'v1');
        h.host.revisions.set('b', 'v1');
        const first = await h.materializations.materialize({
          scope,
          origin,
          owner,
        });
        const again = await h.reconnect().materialize({ scope, origin, owner });
        expect(again.state).toBe('ready');
        expect(again.effectiveItems).toEqual(first.effectiveItems);
        expect(h.reader.calls).toHaveLength(1);
      });

      it('a grant the worker does not redeem is always revoked', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), items);
        h.host.revisions.set('a', 'v1');
        h.host.revisions.set('b', 'v1');
        const first = await h.materializations.materialize({
          scope,
          origin,
          owner,
        });
        // The worker already holds the record, so this attempt stages a grant
        // it never redeems; the core revokes it when the attempt ends.
        await h.materializations.materialize({ scope, origin, owner });
        expect(h.reader.calls).toHaveLength(1);
        expect(
          await grantGone(h.grants, first.materializationId, bindings),
        ).toBe(true);
      });

      it('a call after a release that overtakes an attempt dispatches instead of refusing its grant', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), items);
        h.host.revisions.set('a', 'v1');
        h.host.revisions.set('b', 'v1');
        let open = (): void => undefined;
        h.host.gate = new Promise<void>((resolve) => {
          open = resolve;
        });
        const first = h.materializations.materialize({ scope, origin, owner });
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        const { materializationId } = catalogMaterializationIdentity(
          items,
          scope,
        );
        const released = h.materializations.release({
          materializationId,
          origin,
          owner,
        });
        const second = h.materializations.materialize({ scope, origin, owner });
        open();
        h.host.gate = null;
        await first;
        await released;
        const outcome = await second;
        scanned.push(JSON.stringify(outcome));
        expect(outcome.state).toBe('ready');
        expect(h.handlers.reader.resolve(materializationId)).not.toBeNull();
        expect(await grantGone(h.grants, materializationId, bindings)).toBe(
          true,
        );
      });

      it('materializing again after release serves a readable bundle', async () => {
        h = harness(kind, join(root, 'ledger.sqlite'), items);
        h.host.revisions.set('a', 'v1');
        h.host.revisions.set('b', 'v1');
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
        expect(h.handlers.reader.resolve(first.materializationId)).toBeNull();
        const again = await h.reconnect().materialize({ scope, origin, owner });
        expect(again.state).toBe('ready');
        expect(
          h.handlers.reader.resolve(again.materializationId),
        ).not.toBeNull();
        expect(h.reader.calls).toHaveLength(2);
      });
    },
  );

  it('no secret value reaches the ledger or a result', () => {
    expect(scanned.length).toBeGreaterThan(0);
    for (const text of scanned)
      for (const canary of canaries.values())
        expect(String(text).includes(canary)).toBe(false);
  });
});
