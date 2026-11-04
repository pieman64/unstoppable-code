import {
  PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS,
  PIPELINE_DEFINITION_QUERY_DEFINITIONS,
  PIPELINE_GRANTS,
  type CanopyCallerDescriptor,
  type PipelineDefinition,
  type PipelineDefinitionDeleteResult,
  type PipelineDefinitionDuplicateResult,
  type PipelineDefinitionImportParams,
  type PipelineDefinitionImportResult,
  type PipelineDefinitionUpsertParams,
  type PipelineDefinitionUpsertResult,
} from '@canopy/protocol/canopy-core';
import type { PipelinePackageManifestV1 } from '@canopy/protocol/pipelines';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import type { CanopyDispatcher } from '../../../runtime/types';
import {
  createCorePipelineDefinitionHandlers,
  type PipelineDefinitionReplayLedger,
  type PipelineDefinitionReplayStore,
} from '../core-pipeline-definitions';
import {
  createPipelineDefinitionService,
  PipelineDefinitionSourceError,
  type PipelineDefinitionCopy,
  type PipelineDefinitionInstall,
  type PipelineDefinitionRemote,
  type PipelineDefinitionService,
  type PipelineDefinitionSourceDocument,
  type PipelineDefinitionSourcePort,
  type PipelineDefinitionWrite,
  type PipelineDefinitionWritePort,
} from '../definitions';

const VALID = [
  'pipeline:',
  '  name: Review',
  '  on: dispatch',
  '  jobs:',
  '    build:',
  '      steps:',
  '        - run: echo ok',
  '',
].join('\n');
const UNKNOWN_DEPENDENCY = VALID.replace(
  '    build:\n',
  '    build:\n      needs: [missing]\n',
);

interface Stored {
  revision: number;
  text: string;
  name: string;
}

function storedDocument(
  id: string,
  entry: Stored,
): PipelineDefinitionSourceDocument {
  return {
    source: 'user',
    definitionId: id,
    name: entry.name,
    description: '',
    icon: '',
    readonly: false,
    revision: entry.revision,
    owner: 'personal',
    createdAt: null,
    updatedAt: null,
    format: 'yaml',
    text: entry.text,
  };
}

/** An in-memory user store with the compare-and-swap a host writer keeps. */
function memoryWriter(
  stored = new Map<string, Stored>(),
): PipelineDefinitionWritePort & {
  stored: Map<string, Stored>;
  writes: PipelineDefinitionWrite[];
  copies: PipelineDefinitionCopy[];
} {
  const writes: PipelineDefinitionWrite[] = [];
  const copies: PipelineDefinitionCopy[] = [];
  let next = 0;
  const conflict = (id: string): PipelineDefinitionSourceError =>
    new PipelineDefinitionSourceError(
      'core.pipeline.revisionConflict',
      `Workflow changed since it was loaded: ${id}`,
    );
  return {
    stored,
    writes,
    copies,
    copy: (copy): Promise<PipelineDefinitionSourceDocument> => {
      copies.push(copy);
      const entry = { revision: 1, text: copy.text, name: copy.name };
      stored.set(copy.definitionId, entry);
      return Promise.resolve(storedDocument(copy.definitionId, entry));
    },
    upsert: (write): Promise<PipelineDefinitionSourceDocument> => {
      writes.push(write);
      const id = write.definitionId ?? `created-${(next += 1)}`;
      const current = stored.get(id);
      if (write.definitionId !== null && !current)
        return Promise.reject(
          new PipelineDefinitionSourceError(
            'core.pipeline.definitionNotFound',
            `Workflow not found: ${id}`,
          ),
        );
      if (
        write.expectedRevision !== null &&
        write.expectedRevision !== (current?.revision ?? 0)
      )
        return Promise.reject(conflict(id));
      const entry = {
        revision: (current?.revision ?? 0) + 1,
        text: write.text ?? VALID,
        name: write.name,
      };
      stored.set(id, entry);
      return Promise.resolve({
        source: 'user',
        definitionId: id,
        name: write.name,
        description: write.description,
        icon: write.icon,
        readonly: false,
        revision: entry.revision,
        owner: 'personal',
        createdAt: null,
        updatedAt: null,
        format: 'yaml',
        text: entry.text,
      });
    },
    revision: (id): Promise<number | null> =>
      Promise.resolve(stored.get(id)?.revision ?? null),
    delete: (id, expectedRevision): Promise<number> => {
      const current = stored.get(id);
      if (!current)
        return Promise.reject(
          new PipelineDefinitionSourceError(
            'core.pipeline.definitionNotFound',
            `Workflow not found: ${id}`,
          ),
        );
      if (expectedRevision !== null && expectedRevision !== current.revision)
        return Promise.reject(conflict(id));
      stored.delete(id);
      return Promise.resolve(current.revision);
    },
  };
}

const writer: CanopyCallerDescriptor = {
  principalId: 'local-user',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'test',
  grants: [PIPELINE_GRANTS.read, PIPELINE_GRANTS.write],
};

type WriteDispatcher = CanopyDispatcher<
  typeof PIPELINE_DEFINITION_QUERY_DEFINITIONS,
  typeof PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS,
  Record<never, never>
>;

/** The memory store and a bundled definition, read as their sources do. */
function memoryPort(
  stored: Map<string, Stored>,
  readGate?: () => Promise<void>,
): PipelineDefinitionSourcePort {
  const bundled: PipelineDefinitionSourceDocument = {
    ...storedDocument('bundled-review', {
      revision: 0,
      text: VALID.replace('  name: Review', '  name: Review\n  readonly: true'),
      name: 'Bundled review',
    }),
    source: 'bundled',
    readonly: true,
    owner: null,
  };
  return {
    sources: ['user', 'bundled'],
    list: () =>
      Promise.resolve(
        Array.from(stored, ([id, entry]) => storedDocument(id, entry)),
      ),
    read: async (
      source,
      id,
    ): Promise<PipelineDefinitionSourceDocument | null> => {
      await readGate?.();
      if (source === 'bundled')
        return id === bundled.definitionId ? bundled : null;
      const entry = stored.get(id);
      return entry ? storedDocument(id, entry) : null;
    },
  };
}

/** A replay store that outlives the handlers, as a file does a process. */
function memoryReplays(): PipelineDefinitionReplayStore & {
  ledger: PipelineDefinitionReplayLedger;
  failSaves: boolean;
} {
  const replays = {
    ledger: { entries: [], expired: [] } as PipelineDefinitionReplayLedger,
    failSaves: false,
    load: (): Promise<PipelineDefinitionReplayLedger> =>
      Promise.resolve(structuredClone(replays.ledger)),
    save: (ledger: PipelineDefinitionReplayLedger): Promise<void> => {
      if (replays.failSaves) return Promise.reject(new Error('disk full'));
      replays.ledger = structuredClone(ledger);
      return Promise.resolve();
    },
  };
  return replays;
}

function setup(
  options: {
    noWriter?: boolean;
    setEnabled?: (id: string, enabled: boolean) => Promise<void>;
    stored?: Map<string, Stored>;
    disabled?: Set<string>;
    replays?: PipelineDefinitionReplayStore;
    disabledIds?: () => Promise<ReadonlySet<string>>;
    readGate?: () => Promise<void>;
    wrap?: (service: PipelineDefinitionService) => PipelineDefinitionService;
  } = {},
): {
  dispatcher: WriteDispatcher;
  store: ReturnType<typeof memoryWriter>;
  disabled: Set<string>;
} {
  const store = memoryWriter(options.stored);
  const disabled = options.disabled ?? new Set<string>();
  let copies = 0;
  const service = createPipelineDefinitionService({
    ports: [memoryPort(store.stored, options.readGate)],
    createDefinitionId: () => `copy-${(copies += 1)}`,
    writer: options.noWriter ? undefined : store,
    disabledDefinitionIds:
      options.disabledIds ??
      ((): Promise<Set<string>> => Promise.resolve(new Set(disabled))),
    setDefinitionEnabled:
      options.setEnabled ??
      ((id, enabled): Promise<void> => {
        if (enabled) disabled.delete(id);
        else disabled.add(id);
        return Promise.resolve();
      }),
  });
  const handlers = createCorePipelineDefinitionHandlers({
    authorityId: 'local-desktop',
    load: () => Promise.resolve(options.wrap?.(service) ?? service),
    replays: options.replays,
  });
  return {
    store,
    disabled,
    dispatcher: createCanopyDispatcher({
      profile: 'core',
      definitions: {
        queries: PIPELINE_DEFINITION_QUERY_DEFINITIONS,
        instructions: PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS,
        streams: {},
      },
      handlers: {
        queries: handlers.queries,
        instructions: handlers.instructions,
        streams: {},
      },
    }),
  };
}

function upsertParams(
  key: string,
  overrides: Partial<Omit<PipelineDefinitionUpsertParams, '_meta'>> = {},
): PipelineDefinitionUpsertParams {
  return {
    definitionId: null,
    expectedRevision: null,
    scope: {},
    source: 'user',
    name: 'Review',
    enabled: true,
    format: 'yaml',
    document: VALID,
    ...overrides,
    _meta: { idempotencyKey: key },
  };
}

function upsert(
  dispatcher: WriteDispatcher,
  params: PipelineDefinitionUpsertParams,
  caller = writer,
): Promise<PipelineDefinitionUpsertResult> {
  return dispatcher.instruction('core.pipeline.definition.upsert', params, {
    caller,
    metadata: { idempotencyKey: params._meta.idempotencyKey },
  });
}

function remove(
  dispatcher: WriteDispatcher,
  definitionId: string,
  expectedRevision: number | null,
  key: string,
): Promise<PipelineDefinitionDeleteResult> {
  return dispatcher.instruction(
    'core.pipeline.definition.delete',
    { definitionId, expectedRevision, _meta: { idempotencyKey: key } },
    { caller: writer, metadata: { idempotencyKey: key } },
  );
}

function duplicate(
  dispatcher: WriteDispatcher,
  sourceDefinitionId: string,
  key: string,
  name?: string,
): Promise<PipelineDefinitionDuplicateResult> {
  return dispatcher.instruction(
    'core.pipeline.definition.duplicate',
    {
      sourceDefinitionId,
      scope: {},
      ...(name === undefined ? {} : { name }),
      _meta: { idempotencyKey: key },
    },
    { caller: writer, metadata: { idempotencyKey: key } },
  );
}

function setEnabled(
  dispatcher: WriteDispatcher,
  definitionId: string,
  enabled: boolean,
  key: string,
): Promise<{ definitionId: string; enabled: boolean }> {
  return dispatcher.instruction(
    'core.pipeline.definition.setEnabled',
    { definitionId, enabled, _meta: { idempotencyKey: key } },
    { caller: writer, metadata: { idempotencyKey: key } },
  );
}

describe('pipeline definition writes', () => {
  it('creates and updates a user definition, raising its revision', async () => {
    const { dispatcher } = setup();
    const created = await upsert(dispatcher, upsertParams('create'));
    expect(created.definition).toMatchObject({
      source: 'user',
      name: 'Review',
      revision: 1,
      enabled: true,
      document: VALID,
      diagnostics: [],
    });
    const updated = await upsert(
      dispatcher,
      upsertParams('update', {
        definitionId: created.definition.definitionId,
        expectedRevision: 1,
        name: 'Renamed',
      }),
    );
    expect(updated.definition).toMatchObject({
      definitionId: created.definition.definitionId,
      name: 'Renamed',
      revision: 2,
    });
  });

  it('refuses a write or delete against a revision that moved on', async () => {
    const { dispatcher } = setup();
    const { definition } = await upsert(dispatcher, upsertParams('create'));
    await upsert(
      dispatcher,
      upsertParams('first', {
        definitionId: definition.definitionId,
        expectedRevision: 1,
      }),
    );
    const conflict = {
      payload: {
        kind: 'conflict',
        code: 'core.pipeline.revisionConflict',
        retry: { kind: 'after_refresh' },
      },
    };
    await expect(
      upsert(
        dispatcher,
        upsertParams('stale', {
          definitionId: definition.definitionId,
          expectedRevision: 1,
        }),
      ),
    ).rejects.toMatchObject(conflict);
    await expect(
      remove(dispatcher, definition.definitionId, 1, 'stale-delete'),
    ).rejects.toMatchObject(conflict);
    expect(
      await remove(dispatcher, definition.definitionId, 2, 'delete'),
    ).toEqual({
      definitionId: definition.definitionId,
      deleted: true,
      revision: 2,
    });
  });

  it('replays a committed write for its key and refuses the key for another payload', async () => {
    const { dispatcher, store } = setup();
    const first = await upsert(dispatcher, upsertParams('same'));
    expect(await upsert(dispatcher, upsertParams('same'))).toEqual(first);
    expect(store.writes).toHaveLength(1);
    await expect(
      upsert(dispatcher, upsertParams('same', { name: 'Other' })),
    ).rejects.toMatchObject({ payload: { kind: 'conflict' } });
  });

  it('frees the key of a failed write for a retry', async () => {
    const { dispatcher, store } = setup();
    const missing = upsertParams('retry', {
      definitionId: 'missing',
      expectedRevision: 0,
    });
    await expect(upsert(dispatcher, missing)).rejects.toMatchObject({
      payload: { code: 'core.pipeline.definitionNotFound' },
    });
    store.stored.set('missing', { revision: 0, text: VALID, name: 'Review' });
    expect((await upsert(dispatcher, missing)).definition.revision).toBe(1);
  });

  it('refuses an invalid document before the store sees it', async () => {
    const { dispatcher, store } = setup();
    await expect(
      upsert(
        dispatcher,
        upsertParams('invalid', { document: UNKNOWN_DEPENDENCY }),
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'invalid_argument',
        code: 'core.pipeline.definitionInvalid',
      },
    });
    await expect(
      upsert(dispatcher, upsertParams('unparsable', { document: 'a: [' })),
    ).rejects.toMatchObject({
      payload: { code: 'core.pipeline.definitionInvalid' },
    });
    expect(store.writes).toEqual([]);
  });

  it('refuses read-only sources and a host without a writer', async () => {
    const { dispatcher, store } = setup();
    for (const definitionId of [
      'curated:review',
      'shared:canopy-cloud:abc',
      'project--review.yaml',
    ])
      await expect(
        upsert(
          dispatcher,
          upsertParams(definitionId, { definitionId, expectedRevision: 0 }),
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'core.pipeline.definitionReadOnly',
        },
      });
    expect(store.writes).toEqual([]);
    await expect(
      upsert(setup({ noWriter: true }).dispatcher, upsertParams('none')),
    ).rejects.toMatchObject({
      payload: {
        code: 'core.pipeline.sourceUnavailable',
        retry: { kind: 'same_idempotency_key' },
      },
    });
  });

  it('records the enabled state a write asks for', async () => {
    const { dispatcher, disabled } = setup();
    const { definition } = await upsert(
      dispatcher,
      upsertParams('disabled', { enabled: false }),
    );
    expect(definition.enabled).toBe(false);
    expect(disabled.has(definition.definitionId)).toBe(true);
    const enabled = await upsert(
      dispatcher,
      upsertParams('enabled', {
        definitionId: definition.definitionId,
        expectedRevision: 1,
      }),
    );
    expect(enabled.definition.enabled).toBe(true);
    expect(disabled.size).toBe(0);
  });

  it('needs the write grant', async () => {
    const { dispatcher, store } = setup();
    await expect(
      upsert(dispatcher, upsertParams('denied'), {
        ...writer,
        grants: [PIPELINE_GRANTS.read],
      }),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(store.writes).toEqual([]);
  });

  it('refuses enablement a host cannot record before writing anything', async () => {
    const store = memoryWriter();
    const service = createPipelineDefinitionService({
      ports: [],
      writer: store,
    });
    await expect(
      service.upsert(
        {
          definitionId: null,
          expectedRevision: null,
          scope: {},
          source: 'user',
          name: 'Review',
          enabled: false,
          format: 'yaml',
          document: VALID,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.pipeline.sourceUnavailable' },
    });
    expect(store.writes).toEqual([]);
  });

  it('finishes a committed write on retry when recording enablement failed', async () => {
    let failures = 2;
    const { dispatcher, store, disabled } = setup({
      setEnabled: (id, enabled): Promise<void> => {
        if (failures-- > 0)
          return Promise.reject(new Error('preferences locked'));
        if (enabled) disabled.delete(id);
        else disabled.add(id);
        return Promise.resolve();
      },
    });
    const params = upsertParams('enable-retry', { enabled: false });
    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(upsert(dispatcher, params)).rejects.toMatchObject({
        payload: { retry: { kind: 'same_idempotency_key' } },
      });
    const { definition } = await upsert(dispatcher, params);
    expect(store.writes).toHaveLength(1);
    expect(store.stored.size).toBe(1);
    expect(definition).toMatchObject({ revision: 1, enabled: false });
    expect(await upsert(dispatcher, params)).toEqual({ definition });
  });

  it('refuses a key whose receipt has aged out instead of writing again', async () => {
    const { dispatcher, store } = setup();
    await upsert(dispatcher, upsertParams('first'));
    for (let index = 0; index < 256; index += 1)
      await upsert(dispatcher, upsertParams(`filler-${index}`));
    const before = store.writes.length;
    await expect(
      upsert(dispatcher, upsertParams('first')),
    ).rejects.toMatchObject({
      payload: { kind: 'failed_precondition', retry: { kind: 'never' } },
    });
    expect(store.writes).toHaveLength(before);
  });

  it('refuses a parsed document whose saved text would exceed the limit, before writing', async () => {
    const { dispatcher, store } = setup();
    await expect(
      upsert(
        dispatcher,
        upsertParams('oversized', {
          document: {
            pipeline: {
              name: 'Review',
              on: 'dispatch',
              jobs: {
                build: { steps: [{ run: 'x'.repeat(1_048_576) }] },
              },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'invalid_argument',
        code: 'core.pipeline.definitionInvalid',
      },
    });
    expect(store.writes).toEqual([]);
  });

  it('saves a parsed document as the YAML text it returns', async () => {
    const { dispatcher, store } = setup();
    const { definition } = await upsert(
      dispatcher,
      upsertParams('parsed', {
        document: {
          pipeline: {
            name: 'Review',
            on: 'dispatch',
            jobs: { build: { steps: [{ run: 'echo ok' }] } },
          },
        },
      }),
    );
    expect(store.writes[0]?.text).toBe(definition.document);
    expect(definition.document).toContain('pipeline:');
  });

  it('never lets a resumed older write overturn a newer enabled state', async () => {
    let failNext = true;
    const { dispatcher, disabled } = setup({
      setEnabled: (id, enabled): Promise<void> => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('preferences locked'));
        }
        if (enabled) disabled.delete(id);
        else disabled.add(id);
        return Promise.resolve();
      },
    });
    const { definition } = await upsert(dispatcher, upsertParams('create'));
    const older = upsertParams('older', {
      definitionId: definition.definitionId,
      expectedRevision: 1,
      enabled: false,
    });
    await expect(upsert(dispatcher, older)).rejects.toMatchObject({
      payload: { retry: { kind: 'same_idempotency_key' } },
    });
    await upsert(
      dispatcher,
      upsertParams('newer', {
        definitionId: definition.definitionId,
        expectedRevision: 2,
        enabled: true,
      }),
    );
    await upsert(dispatcher, older);
    expect(disabled.has(definition.definitionId)).toBe(false);
  });

  it('applies overlapping writes to one definition in order', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const { dispatcher, disabled } = setup({
      setEnabled: async (id, enabled): Promise<void> => {
        if (first) {
          first = false;
          await gate;
        }
        if (enabled) disabled.delete(id);
        else disabled.add(id);
      },
    });
    const { definition } = await upsert(dispatcher, upsertParams('create'));
    const id = definition.definitionId;
    const disabling = upsert(
      dispatcher,
      upsertParams('disable', { definitionId: id, enabled: false }),
    );
    const enabling = upsert(
      dispatcher,
      upsertParams('enable', { definitionId: id, enabled: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await Promise.all([disabling, enabling]);
    expect(disabled.has(id)).toBe(false);
  });

  it('copies a read-only definition as a user definition under the id core assigns', async () => {
    const { dispatcher, store } = setup();
    const { definition, sourceDefinitionId } = await duplicate(
      dispatcher,
      'bundled-review',
      'copy',
    );
    expect(sourceDefinitionId).toBe('bundled-review');
    expect(definition).toMatchObject({
      definitionId: 'copy-1',
      source: 'user',
      readonly: false,
      name: 'Bundled review (Copy)',
      revision: 1,
    });
    expect(definition.document).toContain('name: Bundled review (Copy)');
    expect(definition.document).not.toContain('readonly');
    expect(store.copies).toMatchObject([
      {
        definitionId: 'copy-1',
        origin: { source: 'bundled', definitionId: 'bundled-review' },
      },
    ]);
    expect(await duplicate(dispatcher, 'bundled-review', 'copy')).toEqual({
      definition,
      sourceDefinitionId,
    });
    expect(store.copies).toHaveLength(1);
  });

  it('names a copy as asked and refuses a missing source', async () => {
    const { dispatcher } = setup();
    const { definition: created } = await upsert(
      dispatcher,
      upsertParams('create'),
    );
    expect(
      (
        await duplicate(
          dispatcher,
          created.definitionId,
          'named',
          'Review again',
        )
      ).definition.name,
    ).toBe('Review again');
    await expect(
      duplicate(dispatcher, 'missing', 'missing'),
    ).rejects.toMatchObject({
      payload: { code: 'core.pipeline.definitionNotFound' },
    });
  });

  it('enables and disables a definition of any source', async () => {
    const { dispatcher, disabled } = setup();
    expect(
      await setEnabled(dispatcher, 'bundled-review', false, 'off'),
    ).toEqual({ definitionId: 'bundled-review', enabled: false });
    expect(disabled.has('bundled-review')).toBe(true);
    await setEnabled(dispatcher, 'curated:catalog-item', false, 'curated');
    expect(disabled.has('curated:catalog-item')).toBe(true);
    await setEnabled(dispatcher, 'bundled-review', true, 'on');
    expect(disabled.has('bundled-review')).toBe(false);
  });

  it('replays committed writes after a restart', async () => {
    const replays = memoryReplays();
    const stored = new Map<string, Stored>();
    const disabled = new Set<string>();
    const first = setup({ replays, stored, disabled });
    const created = await upsert(first.dispatcher, upsertParams('create'));
    const copied = await duplicate(first.dispatcher, 'bundled-review', 'copy');
    const toggled = await setEnabled(first.dispatcher, 'x', false, 'toggle');
    const removed = await remove(
      first.dispatcher,
      copied.definition.definitionId,
      1,
      'remove',
    );

    const restarted = setup({ replays, stored, disabled });
    expect(await upsert(restarted.dispatcher, upsertParams('create'))).toEqual(
      created,
    );
    expect(
      await setEnabled(restarted.dispatcher, 'x', false, 'toggle'),
    ).toEqual(toggled);
    expect(
      await remove(
        restarted.dispatcher,
        copied.definition.definitionId,
        1,
        'remove',
      ),
    ).toEqual(removed);
    expect(restarted.store.writes).toEqual([]);
    await expect(
      upsert(restarted.dispatcher, upsertParams('create', { name: 'Other' })),
    ).rejects.toMatchObject({ payload: { kind: 'conflict' } });
    // The copy has been deleted since, so its receipt cannot be answered.
    await expect(
      duplicate(restarted.dispatcher, 'bundled-review', 'copy'),
    ).rejects.toMatchObject({
      payload: { code: 'core.pipeline.definitionNotFound' },
    });
    expect(restarted.store.copies).toEqual([]);
  });

  it('refuses after a restart a receipt whose definition moved on, without writing', async () => {
    const replays = memoryReplays();
    const stored = new Map<string, Stored>();
    const first = setup({ replays, stored });
    const { definition } = await upsert(
      first.dispatcher,
      upsertParams('create'),
    );
    await upsert(
      first.dispatcher,
      upsertParams('edit', {
        definitionId: definition.definitionId,
        expectedRevision: 1,
      }),
    );
    const restarted = setup({ replays, stored });
    await expect(
      upsert(restarted.dispatcher, upsertParams('create')),
    ).rejects.toMatchObject({
      payload: { kind: 'failed_precondition', retry: { kind: 'never' } },
    });
    expect(restarted.store.writes).toEqual([]);
  });

  it('finishes enablement after a restart for a write that committed before failing', async () => {
    const replays = memoryReplays();
    const stored = new Map<string, Stored>();
    const disabled = new Set<string>();
    const first = setup({
      replays,
      stored,
      disabled,
      setEnabled: () => Promise.reject(new Error('preferences locked')),
    });
    const params = upsertParams('enable-later', { enabled: false });
    await expect(upsert(first.dispatcher, params)).rejects.toMatchObject({
      payload: { retry: { kind: 'same_idempotency_key' } },
    });
    const restarted = setup({ replays, stored, disabled });
    const { definition } = await upsert(restarted.dispatcher, params);
    expect(definition).toMatchObject({ revision: 1, enabled: false });
    expect(restarted.store.writes).toEqual([]);
    expect(stored.size).toBe(1);
  });

  it('refuses aged-out keys after a restart', async () => {
    const replays = memoryReplays();
    const stored = new Map<string, Stored>();
    const first = setup({ replays, stored });
    await setEnabled(first.dispatcher, 'x', false, 'first');
    for (let index = 0; index < 256; index += 1)
      await setEnabled(first.dispatcher, 'x', false, `filler-${index}`);
    const restarted = setup({ replays, stored });
    await expect(
      setEnabled(restarted.dispatcher, 'x', false, 'first'),
    ).rejects.toMatchObject({ payload: { kind: 'failed_precondition' } });
  });

  it('answers a committed write whose receipt could not be stored, and stores it with the next save', async () => {
    const replays = memoryReplays();
    const stored = new Map<string, Stored>();
    const { dispatcher, store } = setup({ replays, stored });
    replays.failSaves = true;
    const first = await upsert(dispatcher, upsertParams('unrecorded'));
    expect(first.definition.revision).toBe(1);
    expect(await upsert(dispatcher, upsertParams('unrecorded'))).toEqual(first);
    expect(store.writes).toHaveLength(1);
    expect(replays.ledger.entries).toHaveLength(0);
    replays.failSaves = false;
    await setEnabled(dispatcher, 'x', false, 'later');
    expect(replays.ledger.entries).toHaveLength(2);
    const restarted = setup({ replays, stored });
    expect(
      await upsert(restarted.dispatcher, upsertParams('unrecorded')),
    ).toEqual(first);
    expect(restarted.store.writes).toEqual([]);
  });

  it('never records an enabled state after a restart for a write that set none', async () => {
    const replays = memoryReplays();
    const stored = new Map<string, Stored>();
    const disabled = new Set<string>();
    const first = setup({ replays, stored, disabled });
    const { definition } = await upsert(
      first.dispatcher,
      upsertParams('create'),
    );
    disabled.add(definition.definitionId);
    let failRead = true;
    const failing = setup({
      replays,
      stored,
      disabled,
      disabledIds: (): Promise<ReadonlySet<string>> => {
        if (!failRead) return Promise.resolve(new Set(disabled));
        failRead = false;
        return Promise.reject(new Error('preferences locked'));
      },
    });
    const edit = upsertParams('edit', {
      definitionId: definition.definitionId,
      expectedRevision: 1,
      enabled: undefined,
    });
    await expect(upsert(failing.dispatcher, edit)).rejects.toMatchObject({
      payload: { retry: { kind: 'same_idempotency_key' } },
    });
    const restarted = setup({ replays, stored, disabled });
    expect((await upsert(restarted.dispatcher, edit)).definition).toMatchObject(
      { revision: 2, enabled: false },
    );
    expect(disabled.has(definition.definitionId)).toBe(true);
  });

  it('keeps a stored receipt through an overlapping save while its restoration fails', async () => {
    const replays = memoryReplays();
    const stored = new Map<string, Stored>();
    const first = setup({ replays, stored });
    const created = await upsert(first.dispatcher, upsertParams('create'));
    const id = created.definition.definitionId;
    const entry = stored.get(id);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const restarted = setup({ replays, stored, readGate: () => gate });
    const settled = upsert(restarted.dispatcher, upsertParams('create')).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    // Another write saves the ledger while the restoration waits.
    await setEnabled(restarted.dispatcher, 'x', false, 'overlap');
    stored.delete(id);
    release();
    expect(await settled).toMatchObject({
      payload: { code: 'core.pipeline.definitionNotFound' },
    });
    if (entry) stored.set(id, entry);
    const again = setup({ replays, stored });
    expect(await upsert(again.dispatcher, upsertParams('create'))).toEqual(
      created,
    );
    expect(again.store.writes).toEqual([]);
  });

  it('refuses after a restart a receipt whose enabled state changed since', async () => {
    const replays = memoryReplays();
    const stored = new Map<string, Stored>();
    const disabled = new Set<string>();
    const first = setup({ replays, stored, disabled });
    const params = upsertParams('create', { enabled: false });
    const { definition } = await upsert(first.dispatcher, params);
    await setEnabled(first.dispatcher, definition.definitionId, true, 'on');
    const restarted = setup({ replays, stored, disabled });
    await expect(upsert(restarted.dispatcher, params)).rejects.toMatchObject({
      payload: { kind: 'failed_precondition', retry: { kind: 'never' } },
    });
    expect(restarted.store.writes).toEqual([]);
  });

  it('keeps one copy when reading enablement fails, and copies on retry', async () => {
    let failRead = true;
    const disabled = new Set<string>();
    const { dispatcher, store } = setup({
      disabled,
      disabledIds: (): Promise<ReadonlySet<string>> => {
        if (!failRead) return Promise.resolve(new Set(disabled));
        failRead = false;
        return Promise.reject(new Error('preferences locked'));
      },
    });
    await expect(
      duplicate(dispatcher, 'bundled-review', 'copy'),
    ).rejects.toBeDefined();
    expect(store.copies).toEqual([]);
    const { definition } = await duplicate(
      dispatcher,
      'bundled-review',
      'copy',
    );
    expect(store.copies).toHaveLength(1);
    expect(definition.definitionId).toBe(store.copies[0]?.definitionId);
  });

  it('refuses after a restart an unfinished write a later enablement superseded', async () => {
    const replays = memoryReplays();
    const stored = new Map<string, Stored>();
    const disabled = new Set<string>();
    let failEnable = true;
    const first = setup({
      replays,
      stored,
      disabled,
      setEnabled: (id, enabled): Promise<void> => {
        if (failEnable) {
          failEnable = false;
          return Promise.reject(new Error('preferences locked'));
        }
        if (enabled) disabled.delete(id);
        else disabled.add(id);
        return Promise.resolve();
      },
    });
    const params = upsertParams('create', { enabled: false });
    await expect(upsert(first.dispatcher, params)).rejects.toMatchObject({
      payload: { retry: { kind: 'same_idempotency_key' } },
    });
    const id = Array.from(stored.keys())[0] ?? '';
    await setEnabled(first.dispatcher, id, true, 'on');
    await expect(upsert(first.dispatcher, params)).rejects.toMatchObject({
      payload: { kind: 'failed_precondition' },
    });
    const restarted = setup({ replays, stored, disabled });
    await expect(upsert(restarted.dispatcher, params)).rejects.toMatchObject({
      payload: { kind: 'failed_precondition' },
    });
    expect(disabled.has(id)).toBe(false);
  });

  it('refuses to copy a source that changed since its checksum was read', async () => {
    const { dispatcher, store } = setup();
    await expect(
      dispatcher.instruction(
        'core.pipeline.definition.duplicate',
        {
          sourceDefinitionId: 'bundled-review',
          scope: {},
          expectedChecksum: 'sha256:stale',
          _meta: { idempotencyKey: 'stale-copy' },
        },
        { caller: writer, metadata: { idempotencyKey: 'stale-copy' } },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.pipeline.revisionConflict' },
    });
    expect(store.copies).toEqual([]);
  });

  it('never lets a retry queued behind a newer enablement overturn it', async () => {
    const disabled = new Set<string>();
    let failNext = true;
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { dispatcher, store } = setup({
      disabled,
      setEnabled: async (id, enabled): Promise<void> => {
        if (failNext) {
          failNext = false;
          throw new Error('preferences locked');
        }
        await hold;
        if (enabled) disabled.delete(id);
        else disabled.add(id);
      },
    });
    const params = upsertParams('create', { enabled: false });
    await expect(upsert(dispatcher, params)).rejects.toMatchObject({
      payload: { retry: { kind: 'same_idempotency_key' } },
    });
    const id = Array.from(store.stored.keys())[0] ?? '';
    const enabling = setEnabled(dispatcher, id, true, 'on');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const retry = upsert(dispatcher, params).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await enabling;
    expect(await retry).toMatchObject({
      payload: { code: 'core.pipeline.revisionConflict' },
    });
    expect(disabled.has(id)).toBe(false);
  });

  it('never lets a restored enablement waiting on the lock overturn a newer one', async () => {
    const replays = memoryReplays();
    const stored = new Map<string, Stored>();
    const disabled = new Set<string>();
    let failNext = true;
    const first = setup({
      replays,
      stored,
      disabled,
      setEnabled: (id, enabled): Promise<void> => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('preferences locked'));
        }
        if (enabled) disabled.delete(id);
        else disabled.add(id);
        return Promise.resolve();
      },
    });
    const params = upsertParams('create', { enabled: false });
    await expect(upsert(first.dispatcher, params)).rejects.toMatchObject({
      payload: { retry: { kind: 'same_idempotency_key' } },
    });
    const id = Array.from(stored.keys())[0] ?? '';
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holdOnce = true;
    const restarted = setup({
      replays,
      stored,
      disabled,
      setEnabled: async (target, enabled): Promise<void> => {
        if (holdOnce) {
          holdOnce = false;
          await hold;
        }
        if (enabled) disabled.delete(target);
        else disabled.add(target);
      },
    });
    const enabling = setEnabled(restarted.dispatcher, id, true, 'on');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const replay = upsert(restarted.dispatcher, params).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await enabling;
    expect(await replay).toMatchObject({ payload: { kind: 'conflict' } });
    expect(disabled.has(id)).toBe(false);
  });

  it('never records a failed enablement a newer one overtook as replayable', async () => {
    const replays = memoryReplays();
    const stored = new Map<string, Stored>();
    const disabled = new Set<string>();
    let failNext = true;
    let overtaking: Promise<unknown> = Promise.resolve();
    const first: { dispatcher?: WriteDispatcher } = {};
    first.dispatcher = setup({
      replays,
      stored,
      disabled,
      setEnabled: (id, enabled): Promise<void> => {
        if (failNext) {
          failNext = false;
          if (first.dispatcher)
            overtaking = setEnabled(first.dispatcher, id, true, 'on');
          return Promise.reject(new Error('preferences locked'));
        }
        if (enabled) disabled.delete(id);
        else disabled.add(id);
        return Promise.resolve();
      },
      // The newer enabled state lands after the lock is released but before
      // the ledger sees the failure.
      wrap: (service) => ({
        ...service,
        upsert: async (params, signal): Promise<PipelineDefinition> => {
          try {
            return await service.upsert(params, signal);
          } catch (error) {
            await overtaking;
            throw error;
          }
        },
      }),
    }).dispatcher;
    const params = upsertParams('create', { enabled: false });
    await expect(upsert(first.dispatcher, params)).rejects.toBeDefined();
    const id = Array.from(stored.keys())[0] ?? '';
    expect(disabled.has(id)).toBe(false);
    const restarted = setup({ replays, stored, disabled });
    await expect(upsert(restarted.dispatcher, params)).rejects.toMatchObject({
      payload: { kind: 'failed_precondition', retry: { kind: 'never' } },
    });
    expect(disabled.has(id)).toBe(false);
  });

  it('keeps an edit queued behind a toggle resumable when its own enablement fails', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const { dispatcher, disabled } = setup({
      setEnabled: async (id, enabled): Promise<void> => {
        calls += 1;
        if (calls === 1) await hold;
        if (calls === 2) throw new Error('preferences locked');
        if (enabled) disabled.delete(id);
        else disabled.add(id);
      },
    });
    const { definition } = await upsert(dispatcher, upsertParams('create'));
    const id = definition.definitionId;
    const enabling = setEnabled(dispatcher, id, true, 'on');
    const edit = upsertParams('edit', {
      definitionId: id,
      expectedRevision: 1,
      enabled: false,
    });
    const editing = upsert(dispatcher, edit).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await enabling;
    expect(await editing).toMatchObject({
      payload: { retry: { kind: 'same_idempotency_key' } },
    });
    await expect(upsert(dispatcher, edit)).resolves.toMatchObject({
      definition: { definitionId: id, revision: 2, enabled: false },
    });
    expect(disabled.has(id)).toBe(true);
  });
});

// CAN-5076: curated and shared definitions install as user definitions
// through core, which reads the remote itself.
describe('pipeline definition imports', () => {
  const PACKAGED = VALID.replace('- run: echo ok', '- uses: project/review');
  const MANIFEST: PipelinePackageManifestV1 = {
    version: 1,
    pipelineContentHash: 'sha256:packaged',
    resources: [
      {
        id: 'project-review',
        kind: 'pipeline_action',
        displayName: 'project/review',
        sourceLabel: 'project/review',
        sourceVisibility: 'local',
        invocationKeys: ['project/review'],
        dependencyResourceIds: [],
        trees: [],
      },
    ],
    bindings: [
      {
        jobId: 'build',
        stepId: '__auto_step_0',
        resourceIds: ['project-review'],
      },
    ],
    environmentRequirements: [],
    totalFiles: 0,
    totalBytes: 0,
  };

  interface Remote {
    text: string;
    version: string;
    manifest?: PipelinePackageManifestV1;
  }

  function importSetup(remotes: Record<string, Remote>): {
    dispatcher: WriteDispatcher;
    store: ReturnType<typeof memoryWriter>;
    installs: PipelineDefinitionInstall[];
    prepared: string[];
  } {
    const store = memoryWriter();
    const installs: PipelineDefinitionInstall[] = [];
    const prepared: string[] = [];
    const remotePort: PipelineDefinitionSourcePort = {
      sources: ['curated', 'shared'],
      optional: true,
      list: () => Promise.resolve([]),
      read: () => Promise.resolve(null),
      remote: (
        source,
        definitionId,
      ): Promise<PipelineDefinitionRemote | null> => {
        const remote = remotes[definitionId];
        if (!remote) return Promise.resolve(null);
        return Promise.resolve({
          document: {
            ...storedDocument(definitionId, {
              revision: 0,
              text: remote.text,
              name: `Remote ${definitionId}`,
            }),
            source,
            readonly: true,
            owner: null,
          },
          remoteVersion: remote.version,
          packageManifest: (): Promise<
            PipelinePackageManifestV1 | undefined
          > => {
            prepared.push(definitionId);
            return Promise.resolve(remote.manifest);
          },
          install: (write): Promise<PipelineDefinitionSourceDocument> => {
            installs.push(write);
            const current = store.stored.get(write.definitionId);
            const entry = {
              revision: (current?.revision ?? 0) + 1,
              text: write.text,
              name: write.name,
            };
            store.stored.set(write.definitionId, entry);
            return Promise.resolve(storedDocument(write.definitionId, entry));
          },
        });
      },
    };
    let created = 0;
    const service = createPipelineDefinitionService({
      ports: [memoryPort(store.stored), remotePort],
      createDefinitionId: () => `installed-${(created += 1)}`,
      writer: store,
    });
    const handlers = createCorePipelineDefinitionHandlers({
      authorityId: 'local-desktop',
      load: () => Promise.resolve(service),
    });
    return {
      store,
      installs,
      prepared,
      dispatcher: createCanopyDispatcher({
        profile: 'core',
        definitions: {
          queries: PIPELINE_DEFINITION_QUERY_DEFINITIONS,
          instructions: PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS,
          streams: {},
        },
        handlers: {
          queries: handlers.queries,
          instructions: handlers.instructions,
          streams: {},
        },
      }),
    };
  }

  function install(
    dispatcher: WriteDispatcher,
    key: string,
    params: Partial<Omit<PipelineDefinitionImportParams, '_meta'>> & {
      remoteDefinitionId: string;
    },
  ): Promise<PipelineDefinitionImportResult> {
    return dispatcher.instruction(
      'core.pipeline.definition.import',
      {
        targetScope: {},
        expectedRemoteVersion: null,
        nameOverride: null,
        ...params,
        _meta: { idempotencyKey: key },
      },
      { caller: writer, metadata: { idempotencyKey: key } },
    );
  }

  it('installs a reviewed remote revision verbatim under the id core assigns, and replays its key', async () => {
    const { dispatcher, installs } = importSetup({
      'curated:review': { text: VALID, version: 'v1' },
    });
    const result = await install(dispatcher, 'add', {
      remoteDefinitionId: 'curated:review',
      expectedRemoteVersion: 'v1',
    });
    expect(result).toMatchObject({
      remoteDefinitionId: 'curated:review',
      remoteVersion: 'v1',
      definition: {
        definitionId: 'installed-1',
        source: 'user',
        readonly: false,
        revision: 1,
        name: 'Remote curated:review',
        document: VALID,
      },
    });
    expect(installs).toMatchObject([
      { definitionId: 'installed-1', replaces: false, text: VALID },
    ]);
    expect(
      await install(dispatcher, 'add', {
        remoteDefinitionId: 'curated:review',
        expectedRemoteVersion: 'v1',
      }),
    ).toEqual(result);
    expect(installs).toHaveLength(1);
  });

  it('refuses a remote that changed since it was reviewed before preparing its package', async () => {
    const { dispatcher, installs, prepared } = importSetup({
      'curated:review': { text: VALID, version: 'v2' },
    });
    await expect(
      install(dispatcher, 'stale', {
        remoteDefinitionId: 'curated:review',
        expectedRemoteVersion: 'v1',
      }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.pipeline.remoteVersionConflict',
      },
    });
    expect(prepared).toEqual([]);
    expect(installs).toEqual([]);
  });

  it('refuses a missing remote, a local id and an invalid document without installing', async () => {
    const { dispatcher, installs } = importSetup({
      'shared:canopy-cloud:broken': { text: UNKNOWN_DEPENDENCY, version: 'v1' },
    });
    await expect(
      install(dispatcher, 'missing', {
        remoteDefinitionId: 'shared:canopy-cloud:missing',
      }),
    ).rejects.toMatchObject({
      payload: { kind: 'not_found', code: 'core.pipeline.remoteNotFound' },
    });
    await expect(
      install(dispatcher, 'local', { remoteDefinitionId: 'bundled-review' }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    await expect(
      install(dispatcher, 'broken', {
        remoteDefinitionId: 'shared:canopy-cloud:broken',
      }),
    ).rejects.toMatchObject({
      payload: { code: 'core.pipeline.definitionInvalid' },
    });
    expect(installs).toEqual([]);
  });

  it("holds a curated revision to the catalog's package rule", async () => {
    const { dispatcher, installs } = importSetup({
      'curated:unbound': { text: PACKAGED, version: 'v1' },
      'curated:bound': { text: PACKAGED, version: 'v1', manifest: MANIFEST },
    });
    await expect(
      install(dispatcher, 'unbound', { remoteDefinitionId: 'curated:unbound' }),
    ).rejects.toMatchObject({
      payload: { code: 'core.pipeline.definitionInvalid' },
    });
    expect(installs).toEqual([]);
    await install(dispatcher, 'bound', { remoteDefinitionId: 'curated:bound' });
    expect(installs).toMatchObject([{ text: PACKAGED }]);
  });

  it('replaces a user definition with a share under its own name, and never a read-only one', async () => {
    const { dispatcher, installs } = importSetup({
      'shared:canopy-cloud:review': { text: VALID, version: 'v1' },
    });
    const { definition: existing } = await upsert(
      dispatcher,
      upsertParams('existing', { enabled: undefined }),
    );
    const { definition } = await install(dispatcher, 'replace', {
      remoteDefinitionId: 'shared:canopy-cloud:review',
      definitionId: existing.definitionId,
      nameOverride: 'Kept name',
    });
    expect(definition).toMatchObject({
      definitionId: existing.definitionId,
      name: 'Kept name',
      revision: 2,
    });
    expect(installs).toMatchObject([
      { definitionId: existing.definitionId, replaces: true },
    ]);
    await expect(
      install(dispatcher, 'read-only', {
        remoteDefinitionId: 'shared:canopy-cloud:review',
        definitionId: 'curated:review',
      }),
    ).rejects.toMatchObject({
      payload: { code: 'core.pipeline.definitionReadOnly' },
    });
  });

  it('installs a curated revision only as a new copy', async () => {
    const { dispatcher, installs } = importSetup({
      'curated:review': { text: VALID, version: 'v1' },
    });
    const { definition: existing } = await upsert(
      dispatcher,
      upsertParams('existing', { enabled: undefined }),
    );
    await expect(
      install(dispatcher, 'over', {
        remoteDefinitionId: 'curated:review',
        definitionId: existing.definitionId,
      }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(installs).toEqual([]);
  });
});
