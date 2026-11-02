import {
  PIPELINE_DEFINITION_QUERY_DEFINITIONS,
  PIPELINE_GRANTS,
  type CanopyCallerDescriptor,
  type PipelineDefinitionValidateResult,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import type { CanopyDispatcher } from '../../../runtime/types';
import { CanopyOperationError } from '../../../runtime/errors';
import { createCorePipelineDefinitionHandlers } from '../core-pipeline-definitions';
import {
  createPipelineDefinitionService,
  pipelineDefinitionChecksum,
  pipelineDefinitionSourcesForId,
  PipelineDefinitionSourceError,
  type PipelineDefinitionSourceDocument,
  type PipelineDefinitionSourcePort,
} from '../definitions';

const VALID = [
  'pipeline:',
  '  name: Review',
  '  on: { plan_ready: {} }',
  '  scope: [worktree]',
  '  jobs:',
  '    build:',
  '      steps:',
  '        - run: echo ok',
  '',
].join('\n');
const UNKNOWN_DEPENDENCY = [
  'pipeline:',
  '  name: Broken',
  '  on: dispatch',
  '  jobs:',
  '    build:',
  '      needs: [missing]',
  '      steps:',
  '        - run: echo ok',
  '',
].join('\n');

function document(
  source: PipelineDefinitionSourceDocument['source'],
  definitionId: string,
  text = VALID,
): PipelineDefinitionSourceDocument {
  return {
    source,
    definitionId,
    name: definitionId,
    description: `${definitionId} description`,
    icon: '',
    readonly: source !== 'user',
    revision: 0,
    owner: source === 'user' ? 'personal' : null,
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: null,
    format: 'yaml',
    text,
  };
}

function port(
  sources: PipelineDefinitionSourcePort['sources'],
  documents: PipelineDefinitionSourceDocument[],
  options: { optional?: boolean; failList?: boolean } = {},
): PipelineDefinitionSourcePort {
  return {
    sources,
    optional: options.optional,
    list: () =>
      options.failList
        ? Promise.reject(new Error('catalog offline'))
        : Promise.resolve(documents),
    read: (source, definitionId) =>
      Promise.resolve(
        documents.find(
          (entry) =>
            entry.source === source && entry.definitionId === definitionId,
        ) ?? null,
      ),
  };
}

const caller: CanopyCallerDescriptor = {
  principalId: 'local-user',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'test',
  grants: [PIPELINE_GRANTS.read],
};

type DefinitionDispatcher = CanopyDispatcher<
  typeof PIPELINE_DEFINITION_QUERY_DEFINITIONS,
  Record<never, never>,
  Record<never, never>
>;

function dispatcherFor(
  ports: PipelineDefinitionSourcePort[],
): DefinitionDispatcher {
  const service = createPipelineDefinitionService({
    ports,
    disabledDefinitionIds: () => Promise.resolve(new Set(['bundled-off'])),
    servingTargetIds: ['in_process_worker'],
  });
  const handlers = createCorePipelineDefinitionHandlers({
    authorityId: 'local-desktop',
    load: () => Promise.resolve(service),
  });
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: PIPELINE_DEFINITION_QUERY_DEFINITIONS,
      instructions: {},
      streams: {},
    },
    handlers: { queries: handlers.queries, instructions: {}, streams: {} },
  });
}

describe('pipeline definition source precedence', () => {
  it('routes prefixed ids to their source and bare ids to user then bundled', () => {
    expect(pipelineDefinitionSourcesForId('curated:review')).toEqual([
      'curated',
    ]);
    expect(pipelineDefinitionSourcesForId('shared:canopy-cloud:abc')).toEqual([
      'shared',
    ]);
    expect(pipelineDefinitionSourcesForId('project--review.yaml')).toEqual([
      'project',
    ]);
    expect(pipelineDefinitionSourcesForId('review')).toEqual([
      'user',
      'bundled',
    ]);
  });

  it('reads a user definition before a bundled one with the same id', async () => {
    const dispatcher = dispatcherFor([
      port(
        ['bundled', 'user'],
        [document('bundled', 'review'), document('user', 'review')],
      ),
    ]);
    const { definition } = await dispatcher.query(
      'core.pipeline.definition.get',
      { definitionId: 'review' },
      { caller },
    );
    expect(definition).toMatchObject({
      source: 'user',
      owner: 'personal',
      checksum: pipelineDefinitionChecksum(VALID),
      triggerTypes: ['plan_ready'],
      executionScopes: ['worktree'],
      diagnostics: [],
    });
    expect(definition.normalized).toMatchObject({ name: 'Review' });
  });

  it('reports a stored definition that no longer validates instead of failing', async () => {
    const dispatcher = dispatcherFor([
      port(['user'], [document('user', 'broken', UNKNOWN_DEPENDENCY)]),
    ]);
    const { definition } = await dispatcher.query(
      'core.pipeline.definition.get',
      { definitionId: 'broken' },
      { caller },
    );
    expect(definition.normalized).toBeNull();
    expect(definition.diagnostics).toEqual([
      {
        severity: 'error',
        code: 'core.pipeline.definitionInvalid',
        message: 'Unknown job dependency "missing"',
      },
    ]);
  });

  it('answers a missing definition with the store message', async () => {
    const dispatcher = dispatcherFor([port(['bundled', 'user'], [])]);
    await expect(
      dispatcher.query(
        'core.pipeline.definition.get',
        { definitionId: 'missing' },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'not_found',
        code: 'core.pipeline.definitionNotFound',
        message: 'Workflow not found: missing',
      },
    });
  });

  it('needs a worktree scope only where a project source is served', async () => {
    await expect(
      dispatcherFor([port(['project'], [])]).query(
        'core.pipeline.definition.get',
        { definitionId: 'project--a.yaml' },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.pipeline.scopeInvalid' },
    });
    await expect(
      dispatcherFor([port(['user'], [])]).query(
        'core.pipeline.definition.get',
        { definitionId: 'project--a.yaml' },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.pipeline.definitionNotFound' },
    });
  });

  it('keeps a source failure typed with its message', async () => {
    const failing: PipelineDefinitionSourcePort = {
      sources: ['user'],
      list: () => Promise.resolve([]),
      read: () =>
        Promise.reject(
          new PipelineDefinitionSourceError(
            'core.pipeline.definitionUnreadable',
            'Workflow file not found: a.yaml',
          ),
        ),
    };
    const error: unknown = await dispatcherFor([failing])
      .query('core.pipeline.definition.get', { definitionId: 'a' }, { caller })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CanopyOperationError);
    expect(error).toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.pipeline.definitionUnreadable',
        message: 'Workflow file not found: a.yaml',
      },
    });
  });
});

describe('pipeline definition listing', () => {
  const ports = (): PipelineDefinitionSourcePort[] => [
    port(['curated'], [document('curated', 'curated:review')], {
      optional: true,
    }),
    port(
      ['bundled', 'user'],
      [
        document('user', 'mine'),
        document('bundled', 'bundled-on'),
        document('bundled', 'bundled-off'),
      ],
    ),
    port(['project'], [document('project', 'project--a.yaml')]),
  ];

  it('orders stores before checkout and account sources and reports enablement', async () => {
    const result = await dispatcherFor(ports()).query(
      'core.pipeline.definition.list',
      { scope: { workspaceId: 'ws', worktreeId: 'wt' } },
      { caller },
    );
    expect(
      result.items.map((item) => [item.definitionId, item.enabled]),
    ).toEqual([
      ['bundled-on', true],
      ['bundled-off', false],
      ['mine', true],
      ['project--a.yaml', true],
      ['curated:review', true],
    ]);
    expect(result.items[3].scope).toEqual({
      workspaceId: 'ws',
      worktreeId: 'wt',
    });
    expect(result.items[0].scope).toEqual({});
    expect(result).toMatchObject({ nextCursor: null, unavailableSources: [] });
  });

  it('skips project definitions without a worktree and filters and pages', async () => {
    const dispatcher = dispatcherFor(ports());
    const first = await dispatcher.query(
      'core.pipeline.definition.list',
      { enabled: true, limit: 2 },
      { caller },
    );
    expect(first.items.map((item) => item.definitionId)).toEqual([
      'bundled-on',
      'mine',
    ]);
    expect(first.nextCursor).toBe('2');
    const second = await dispatcher.query(
      'core.pipeline.definition.list',
      { enabled: true, limit: 2, cursor: '2' },
      { caller },
    );
    expect(second.items.map((item) => item.definitionId)).toEqual([
      'curated:review',
    ]);
    const queried = await dispatcher.query(
      'core.pipeline.definition.list',
      { query: 'MINE DESC', sources: ['user'] },
      { caller },
    );
    expect(queried.items.map((item) => item.definitionId)).toEqual(['mine']);
  });

  it('never lets an optional source hide the local ones, and fails on a required one', async () => {
    const degraded = await dispatcherFor([
      port(['curated'], [], { optional: true, failList: true }),
      port(['user'], [document('user', 'mine')]),
    ]).query('core.pipeline.definition.list', {}, { caller });
    expect(degraded.items.map((item) => item.definitionId)).toEqual(['mine']);
    expect(degraded.unavailableSources).toEqual(['curated']);
    await expect(
      dispatcherFor([port(['user'], [], { failList: true })]).query(
        'core.pipeline.definition.list',
        {},
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'unavailable', code: 'core.pipeline.sourceUnavailable' },
    });
  });

  it('refuses another authority before reading any source', async () => {
    await expect(
      dispatcherFor(ports()).query(
        'core.pipeline.definition.list',
        { scope: { authorityId: 'elsewhere' } },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        code: 'core.pipeline.targetUnavailable',
      },
    });
  });
});

describe('pipeline definition review regressions', () => {
  it('lists and reads stored display fields of any length', async () => {
    const long = {
      ...document('user', 'long'),
      name: 'n'.repeat(400),
      icon: 'i'.repeat(300),
    };
    const dispatcher = dispatcherFor([port(['user'], [long])]);
    const listed = await dispatcher.query(
      'core.pipeline.definition.list',
      {},
      { caller },
    );
    expect(listed.items[0].name).toHaveLength(400);
    const { definition } = await dispatcher.query(
      'core.pipeline.definition.get',
      { definitionId: 'long' },
      { caller },
    );
    expect(definition.icon).toHaveLength(300);
  });

  it('skips project definitions for a worktree without its workspace', async () => {
    const dispatcher = dispatcherFor([
      port(['user'], [document('user', 'mine')]),
      {
        sources: ['project'],
        list: (): Promise<never> =>
          Promise.reject(new Error('incomplete project scope')),
        read: (): Promise<never> =>
          Promise.reject(new Error('incomplete project scope')),
      },
    ]);
    const listed = await dispatcher.query(
      'core.pipeline.definition.list',
      { scope: { worktreeId: 'wt' } },
      { caller },
    );
    expect(listed.items.map((item) => item.definitionId)).toEqual(['mine']);
    await expect(
      dispatcher.query(
        'core.pipeline.definition.get',
        { definitionId: 'project--a.yaml', scope: { worktreeId: 'wt' } },
        { caller },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.pipeline.scopeInvalid' },
    });
  });
});

describe('pipeline definition trigger types', () => {
  const PUSH = VALID.replace('on: { plan_ready: {} }', 'on: push');

  it('lists and reads a stored definition with an unknown trigger', async () => {
    // As the store's backfill records it from the document.
    const recorded: PipelineDefinitionSourceDocument = Object.assign(
      document('user', 'push', PUSH),
      { triggerTypes: ['push'] },
    );
    const dispatcher = dispatcherFor([port(['user'], [recorded])]);
    const listed = await dispatcher.query(
      'core.pipeline.definition.list',
      {},
      { caller },
    );
    expect(listed.items[0].triggerTypes).toEqual([]);
    const { definition } = await dispatcher.query(
      'core.pipeline.definition.get',
      { definitionId: 'push' },
      { caller },
    );
    expect(definition.triggerTypes).toEqual([]);
    expect(definition.document).toBe(PUSH);
  });

  it('prefers a source checksum over hashing the document', async () => {
    const curated = {
      ...document('curated', 'curated:review'),
      checksum: 'sha256:reviewed',
    };
    const { definition } = await dispatcherFor([
      port(['curated'], [curated]),
    ]).query(
      'core.pipeline.definition.get',
      { definitionId: 'curated:review' },
      { caller },
    );
    expect(definition.checksum).toBe('sha256:reviewed');
  });
});

describe('pipeline definition validation', () => {
  const validate = (
    document: string | Record<string, unknown>,
    targetId: string | null = null,
  ): Promise<PipelineDefinitionValidateResult> =>
    dispatcherFor([]).query(
      'core.pipeline.definition.validate',
      { scope: {}, targetId, format: 'yaml', document },
      { caller },
    );

  it('normalizes a valid text or object document without running it', async () => {
    const text = await validate(VALID);
    expect(text).toMatchObject({ valid: true, diagnostics: [] });
    expect(text.normalized).toMatchObject({ scope: ['worktree'] });
    expect(
      await validate({
        pipeline: { name: 'x', on: 'dispatch', jobs: { a: { steps: [] } } },
      }),
    ).toMatchObject({ valid: true });
  });

  it('reports parse and normalization failures as diagnostics', async () => {
    expect(await validate('pipeline:\n  name: [unclosed\n')).toMatchObject({
      valid: false,
      normalized: null,
      diagnostics: [{ severity: 'error', code: 'core.pipeline.parseFailed' }],
    });
    expect(await validate(UNKNOWN_DEPENDENCY)).toMatchObject({
      valid: false,
      diagnostics: [
        {
          code: 'core.pipeline.definitionInvalid',
          message: 'Unknown job dependency "missing"',
        },
      ],
    });
  });

  it('validates for a served target only', async () => {
    expect(await validate(VALID, 'in_process_worker')).toMatchObject({
      valid: true,
    });
    await expect(validate(VALID, 'remote-target')).rejects.toMatchObject({
      payload: { code: 'core.pipeline.targetUnavailable' },
    });
  });

  it('denies a caller without the read grant before any handler runs', async () => {
    await expect(
      dispatcherFor([]).query(
        'core.pipeline.definition.validate',
        { scope: {}, targetId: null, format: 'yaml', document: VALID },
        { caller: { ...caller, grants: [] } },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
  });
});
