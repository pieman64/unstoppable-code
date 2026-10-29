import {
  buildCombinedTriggerRows,
  filterPipelineInfosByExecutionScope,
  filterTriggerRowsByExecutionScope,
  shouldIncludeSharedRows,
} from '../pipelineTriggerRows';
import type {
  Pipeline,
  PipelineExecutionScope,
  PipelineData,
  PipelineInfo,
  PipelineTriggerType,
} from '@canopy/desktop-shared/types/pipeline';

const EMPTY_PIPELINE: Pipeline = {
  name: '',
  description: '',
  on: 'dispatch',
  jobs: {},
};

function makeLocalPipeline(args: {
  id: string;
  name: string;
  source: PipelineInfo['source'];
  description?: string;
  scopes?: PipelineExecutionScope[];
}): PipelineData {
  const info: PipelineInfo = {
    id: args.id,
    name: args.name,
    filename: `${args.id}.yaml`,
    description: args.description ?? '',
    icon: '',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    source: args.source,
    readonly: args.source === 'bundled',
    ...(args.scopes ? { scopes: args.scopes } : {}),
  };
  return { info, content: EMPTY_PIPELINE };
}

function makeSharedInfo(args: {
  remoteId: string;
  name: string;
  description?: string;
  triggerTypes?: PipelineTriggerType[];
}): PipelineInfo {
  return {
    id: `shared:canopy-cloud:${args.remoteId}`,
    name: args.name,
    filename: '',
    description: args.description ?? '',
    icon: '',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    source: 'shared',
    readonly: false,
    serverId: 'canopy-cloud',
    remoteId: args.remoteId,
    triggerTypes: args.triggerTypes ?? ['dispatch'],
    canUpdate: true,
    canDelete: true,
  };
}

describe('shouldIncludeSharedRows', () => {
  it('includes shared rows for the all and shared filters', () => {
    expect(shouldIncludeSharedRows('all')).toBe(true);
    expect(shouldIncludeSharedRows('shared')).toBe(true);
  });

  it('excludes shared rows for local-only filters', () => {
    expect(shouldIncludeSharedRows('bundled')).toBe(false);
    expect(shouldIncludeSharedRows('user')).toBe(false);
    expect(shouldIncludeSharedRows('project')).toBe(false);
  });
});

describe('buildCombinedTriggerRows', () => {
  const local1 = makeLocalPipeline({
    id: 'p-1',
    name: 'Local Custom',
    source: 'user',
  });
  const local2 = makeLocalPipeline({
    id: 'p-2',
    name: 'Local Bundled',
    source: 'bundled',
  });
  const local3 = makeLocalPipeline({
    id: 'p-3',
    name: 'Local Project',
    source: 'project',
  });

  const sharedA1 = makeSharedInfo({
    remoteId: 'remote-a1',
    name: 'Shared A1',
  });
  const sharedA2 = makeSharedInfo({
    remoteId: 'remote-a2',
    name: 'Shared A2',
  });
  const sharedB1 = makeSharedInfo({
    remoteId: 'remote-b1',
    name: 'Shared B1',
  });

  const sharedRows: PipelineInfo[] = [sharedA1, sharedA2, sharedB1];

  it('all: blends local then shared rows in their natural order', () => {
    const rows = buildCombinedTriggerRows({
      localPipelines: [local1, local2],
      sharedRows,
      sourceFilter: 'all',
      searchQuery: '',
      triggerType: 'dispatch',
    });
    expect(rows.map((r) => r.info.id)).toEqual([
      'p-1',
      'p-2',
      'shared:canopy-cloud:remote-a1',
      'shared:canopy-cloud:remote-a2',
      'shared:canopy-cloud:remote-b1',
    ]);
    expect(rows.map((r) => r.kind)).toEqual([
      'local',
      'local',
      'shared',
      'shared',
      'shared',
    ]);
  });

  it('excludes disabled local and shared pipelines via disabledIds', () => {
    const rows = buildCombinedTriggerRows({
      localPipelines: [local1, local2],
      sharedRows,
      sourceFilter: 'all',
      searchQuery: '',
      triggerType: 'dispatch',
      disabledIds: new Set(['p-2', 'shared:canopy-cloud:remote-a2']),
    });
    expect(rows.map((r) => r.info.id)).toEqual([
      'p-1',
      'shared:canopy-cloud:remote-a1',
      'shared:canopy-cloud:remote-b1',
    ]);
  });

  it('treats an absent disabledIds set as nothing disabled', () => {
    const rows = buildCombinedTriggerRows({
      localPipelines: [local1, local2, local3],
      sharedRows: [],
      sourceFilter: 'all',
      searchQuery: '',
      triggerType: 'dispatch',
    });
    expect(rows.map((r) => r.info.id)).toEqual(['p-1', 'p-2', 'p-3']);
  });

  it('shared: returns empty array (renderer uses SharedPipelineSelector instead)', () => {
    const rows = buildCombinedTriggerRows({
      localPipelines: [local1, local2],
      sharedRows,
      sourceFilter: 'shared',
      searchQuery: '',
      triggerType: 'dispatch',
    });
    expect(rows).toEqual([]);
  });

  it('bundled: only local bundled rows; never shared', () => {
    const rows = buildCombinedTriggerRows({
      localPipelines: [local1, local2, local3],
      sharedRows,
      sourceFilter: 'bundled',
      searchQuery: '',
      triggerType: 'dispatch',
    });
    expect(rows.map((r) => r.info.id)).toEqual(['p-2']);
    expect(rows.every((r) => r.kind === 'local')).toBe(true);
  });

  it('user (Custom): only local user rows; never shared', () => {
    const rows = buildCombinedTriggerRows({
      localPipelines: [local1, local2, local3],
      sharedRows,
      sourceFilter: 'user',
      searchQuery: '',
      triggerType: 'dispatch',
    });
    expect(rows.map((r) => r.info.id)).toEqual(['p-1']);
  });

  it('project: only local project rows; never shared', () => {
    const rows = buildCombinedTriggerRows({
      localPipelines: [local1, local2, local3],
      sharedRows,
      sourceFilter: 'project',
      searchQuery: '',
      triggerType: 'dispatch',
    });
    expect(rows.map((r) => r.info.id)).toEqual(['p-3']);
  });

  it('all: applies in-memory search to local rows; shared rows pass through (server-side filtered)', () => {
    const rows = buildCombinedTriggerRows({
      localPipelines: [local1, local2, local3],
      sharedRows,
      sourceFilter: 'all',
      searchQuery: 'custom',
      triggerType: 'dispatch',
    });
    // Only "Local Custom" matches the local filter; the helper trusts the
    // sharedRows content because the hook filters them server-side via
    // `setFilters({ q })`.
    expect(rows.map((r) => r.info.id)).toEqual([
      'p-1',
      'shared:canopy-cloud:remote-a1',
      'shared:canopy-cloud:remote-a2',
      'shared:canopy-cloud:remote-b1',
    ]);
  });

  it('all with no shared rows loaded: returns only locals', () => {
    const rows = buildCombinedTriggerRows({
      localPipelines: [local1],
      sharedRows: [],
      sourceFilter: 'all',
      searchQuery: '',
      triggerType: 'dispatch',
    });
    expect(rows.map((r) => r.info.id)).toEqual(['p-1']);
  });

  it('all with no locals but shared rows: returns shared rows only', () => {
    const rows = buildCombinedTriggerRows({
      localPipelines: [],
      sharedRows,
      sourceFilter: 'all',
      searchQuery: '',
      triggerType: 'dispatch',
    });
    expect(rows.map((r) => r.info.id)).toEqual([
      'shared:canopy-cloud:remote-a1',
      'shared:canopy-cloud:remote-a2',
      'shared:canopy-cloud:remote-b1',
    ]);
  });

  it('shared rows missing remoteId are skipped defensively', () => {
    const malformed: PipelineInfo = {
      ...sharedA1,
      remoteId: undefined,
    };
    const rows = buildCombinedTriggerRows({
      localPipelines: [],
      sharedRows: [malformed],
      sourceFilter: 'all',
      searchQuery: '',
      triggerType: 'dispatch',
    });
    expect(rows).toEqual([]);
  });

  it('search matches against description as well as name', () => {
    const withDesc = makeLocalPipeline({
      id: 'p-desc',
      name: 'Foo',
      source: 'user',
      description: 'Tooling for build',
    });
    const rows = buildCombinedTriggerRows({
      localPipelines: [withDesc, local2],
      sharedRows: [],
      sourceFilter: 'all',
      searchQuery: 'tooling',
      triggerType: 'dispatch',
    });
    expect(rows.map((r) => r.info.id)).toEqual(['p-desc']);
  });

  it('all: excludes shared rows that explicitly lack the requested trigger type', () => {
    const planOnly = makeSharedInfo({
      remoteId: 'remote-plan',
      name: 'Plan Only',
      triggerTypes: ['plan_ready'],
    });
    const dualTrigger = makeSharedInfo({
      remoteId: 'remote-dual',
      name: 'Dual Trigger',
      triggerTypes: ['dispatch', 'plan_ready'],
    });

    const rows = buildCombinedTriggerRows({
      localPipelines: [],
      sharedRows: [planOnly, dualTrigger],
      sourceFilter: 'all',
      searchQuery: '',
      triggerType: 'dispatch',
    });

    expect(rows.map((r) => r.info.id)).toEqual([
      'shared:canopy-cloud:remote-dual',
    ]);
  });
});

describe('filterTriggerRowsByExecutionScope', () => {
  const legacy = makeLocalPipeline({
    id: 'legacy',
    name: 'Legacy (no scope)',
    source: 'user',
  });
  const directory = makeLocalPipeline({
    id: 'dir',
    name: 'Directory',
    source: 'user',
    scopes: ['directory'],
  });
  const worktreeOnly = makeLocalPipeline({
    id: 'wt',
    name: 'Worktree only',
    source: 'user',
    scopes: ['worktree'],
  });
  const globalOnly = makeLocalPipeline({
    id: 'glob',
    name: 'Global only',
    source: 'user',
    scopes: ['global'],
  });

  function rowsFor(scope: PipelineExecutionScope): string[] {
    const rows = buildCombinedTriggerRows({
      localPipelines: [legacy, directory, worktreeOnly, globalOnly],
      sharedRows: [],
      sourceFilter: 'all',
      searchQuery: '',
    });
    return filterTriggerRowsByExecutionScope(rows, scope).map((r) => r.info.id);
  }

  it('worktree surface lists worktree, directory, and legacy no-scope rows', () => {
    // Critically: legacy + directory rows must NOT vanish from a worktree
    // surface (the backwards-compat guarantee). Global-only stays hidden.
    expect(rowsFor('worktree')).toEqual(['legacy', 'dir', 'wt']);
  });

  it('directory surface hides worktree-only rows but keeps legacy/directory', () => {
    expect(rowsFor('directory')).toEqual(['legacy', 'dir']);
  });

  it('global surface lists only global rows', () => {
    expect(rowsFor('global')).toEqual(['glob']);
  });
});

describe('filterPipelineInfosByExecutionScope', () => {
  const infos: PipelineInfo[] = [
    makeLocalPipeline({ id: 'legacy', name: 'Legacy', source: 'shared' }).info,
    makeLocalPipeline({
      id: 'wt',
      name: 'Worktree',
      source: 'shared',
      scopes: ['worktree'],
    }).info,
  ];

  it('keeps legacy no-scope rows on a worktree surface', () => {
    expect(
      filterPipelineInfosByExecutionScope(infos, 'worktree').map((i) => i.id),
    ).toEqual(['legacy', 'wt']);
  });

  it('hides worktree-only rows on a directory surface', () => {
    expect(
      filterPipelineInfosByExecutionScope(infos, 'directory').map((i) => i.id),
    ).toEqual(['legacy']);
  });
});

describe('curated metadata rows', () => {
  const curated: PipelineInfo = {
    ...makeSharedInfo({ remoteId: 'review', name: 'Curated review' }),
    source: 'curated',
    id: 'curated:review',
    scopes: ['directory'],
    triggerTypes: ['task_ready'],
    readonly: true,
  };
  const options = {
    localPipelines: [],
    sharedRows: [],
    curatedRows: [curated],
    sourceFilter: 'all' as const,
    searchQuery: '',
    triggerType: 'task_ready' as const,
  };
  it('includes undownloaded metadata, scoped as ordinary directory pipelines', () => {
    const rows = buildCombinedTriggerRows(options);
    expect(rows).toEqual([{ kind: 'curated', info: curated }]);
    expect(filterTriggerRowsByExecutionScope(rows, 'worktree')).toEqual(rows);
    expect(filterTriggerRowsByExecutionScope(rows, 'global')).toEqual([]);
  });
  it('applies source, trigger, search and hidden filters without content', () => {
    expect(
      buildCombinedTriggerRows({ ...options, sourceFilter: 'curated' }),
    ).toHaveLength(1);
    expect(
      buildCombinedTriggerRows({ ...options, sourceFilter: 'bundled' }),
    ).toEqual([]);
    expect(
      buildCombinedTriggerRows({ ...options, triggerType: 'dispatch' }),
    ).toEqual([]);
    expect(
      buildCombinedTriggerRows({ ...options, searchQuery: 'missing' }),
    ).toEqual([]);
    expect(
      buildCombinedTriggerRows({
        ...options,
        disabledIds: new Set(['curated:review']),
      }),
    ).toEqual([]);
  });
});
