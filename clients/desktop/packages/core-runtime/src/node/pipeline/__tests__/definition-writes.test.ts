import {
  PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS,
  PIPELINE_DEFINITION_QUERY_DEFINITIONS,
  PIPELINE_GRANTS,
  type CanopyCallerDescriptor,
  type PipelineDefinitionDeleteResult,
  type PipelineDefinitionUpsertParams,
  type PipelineDefinitionUpsertResult,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import type { CanopyDispatcher } from '../../../runtime/types';
import { createCorePipelineDefinitionHandlers } from '../core-pipeline-definitions';
import {
  createPipelineDefinitionService,
  PipelineDefinitionSourceError,
  type PipelineDefinitionSourceDocument,
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
}

/** An in-memory user store with the compare-and-swap a host writer keeps. */
function memoryWriter(): PipelineDefinitionWritePort & {
  stored: Map<string, Stored>;
  writes: PipelineDefinitionWrite[];
} {
  const stored = new Map<string, Stored>();
  const writes: PipelineDefinitionWrite[] = [];
  let next = 0;
  const conflict = (id: string): PipelineDefinitionSourceError =>
    new PipelineDefinitionSourceError(
      'core.pipeline.revisionConflict',
      `Workflow changed since it was loaded: ${id}`,
    );
  return {
    stored,
    writes,
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

function setup(
  options: {
    noWriter?: boolean;
    setEnabled?: (id: string, enabled: boolean) => Promise<void>;
  } = {},
): {
  dispatcher: WriteDispatcher;
  store: ReturnType<typeof memoryWriter>;
  disabled: Set<string>;
} {
  const store = memoryWriter();
  const disabled = new Set<string>();
  const service = createPipelineDefinitionService({
    ports: [],
    writer: options.noWriter ? undefined : store,
    disabledDefinitionIds: () => Promise.resolve(new Set(disabled)),
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
    load: () => Promise.resolve(service),
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
    store.stored.set('missing', { revision: 0, text: VALID });
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
});
