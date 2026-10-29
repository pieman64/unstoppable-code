import type { AgentProviderType } from '../../types';
import { isModelHarness } from '../../model-harnesses';
import type { ModelHarness } from '../../types/model-harnesses';
import {
  PROJECT_DISCOVERY_ACTION_TYPES,
  PROJECT_DISCOVERY_CURSOR_MAX,
  PROJECT_DISCOVERY_ID_MAX,
  PROJECT_DISCOVERY_PAGE_SIZE_DEFAULT,
  PROJECT_DISCOVERY_PAGE_SIZE_MAX,
  PROJECT_DISCOVERY_PREVIEW_MAX_CHARS,
  PROJECT_DISCOVERY_TEXT_MAX,
  incompatibleTaskFilter,
  isProjectDiscoveryActionType,
  parseProjectDiscoveryAction,
  projectDiscoveryActionSchema,
  projectsListActionSchema,
  projectsListTaskChatsActionSchema,
  projectsListTasksActionSchema,
} from '../project-discovery';
import type { ProjectRow, ProjectTaskRow } from '../project-discovery';

const actions = [
  { type: 'projects.list' },
  { type: 'projects.list_tasks', projectId: 'project' },
  { type: 'projects.list_task_chats', projectId: 'project' },
];

// Exhaustive against canonical unions, not an unchecked validation list.
const providers: Record<AgentProviderType, true> = {
  claude: true,
  codex: true,
  ollama: true,
  cursor: true,
  opencode: true,
  copilot: true,
};
const harnesses: Record<ModelHarness, true> = {
  claude: true,
  codex: true,
  cursor: true,
  opencode: true,
  copilot: true,
};

function assertType<T extends true>(value: T): void {
  expect(value).toBe(true);
}

describe('project discovery contracts', () => {
  it('pairs project and task discriminants with only their matching details', () => {
    assertType<
      ProjectRow extends
        | { type: 'code'; details: { kind: 'code' } }
        | { type: 'cowork'; details: { kind: 'cowork' } }
        ? true
        : false
    >(true);
    assertType<
      ProjectTaskRow extends
        | { kind: 'worktree'; details: { kind: 'worktree' } }
        | { kind: 'work_entry'; details: { kind: 'work_entry' } }
        ? true
        : false
    >(true);
  });

  it('exports bounded public constants', () => {
    expect(PROJECT_DISCOVERY_ACTION_TYPES).toEqual(
      actions.map(({ type }) => type),
    );
    expect(PROJECT_DISCOVERY_PAGE_SIZE_DEFAULT).toBe(50);
    expect(PROJECT_DISCOVERY_PAGE_SIZE_MAX).toBe(200);
    expect(PROJECT_DISCOVERY_TEXT_MAX).toBe(500);
    expect(PROJECT_DISCOVERY_PREVIEW_MAX_CHARS).toBe(1000);
    expect(PROJECT_DISCOVERY_ID_MAX).toBe(512);
    expect(PROJECT_DISCOVERY_CURSOR_MAX).toBe(2048);
  });

  it('applies projects.list defaults', () => {
    expect(projectsListActionSchema.parse(actions[0])).toEqual({
      type: 'projects.list',
      pageSize: 50,
      includeDefault: true,
      sort: 'name',
      order: 'asc',
    });
  });
  it('applies task list defaults', () => {
    expect(projectsListTasksActionSchema.parse(actions[1])).toEqual({
      type: 'projects.list_tasks',
      projectId: 'project',
      pageSize: 50,
      retentionStates: ['retained'],
      sort: 'last_activity',
      order: 'desc',
    });
  });
  it('applies chat list defaults', () => {
    expect(projectsListTaskChatsActionSchema.parse(actions[2])).toEqual({
      type: 'projects.list_task_chats',
      projectId: 'project',
      pageSize: 50,
      retentionStates: ['retained'],
      includeLastUserMessage: false,
      sort: 'last_activity',
      order: 'desc',
    });
  });
  it.each(actions)('preserves explicit overrides for $type', (action) => {
    expect(
      projectDiscoveryActionSchema.parse({
        ...action,
        pageSize: 200,
        order: 'asc',
        sort: 'created_at',
      }),
    ).toMatchObject({ pageSize: 200, order: 'asc', sort: 'created_at' });
  });

  describe.each(actions)('$type strict fields', (action) => {
    it.each([
      'activeTabId',
      'selected',
      'expectedUiRevision',
      'unknown',
      'worktreeId',
      'includeAllOrgs',
    ])('rejects %s', (key) => {
      expect(parseProjectDiscoveryAction({ ...action, [key]: true }).ok).toBe(
        false,
      );
    });
    it.each([0, 201, 1.5, -1, '50', null])(
      'rejects pageSize %p',
      (pageSize) => {
        expect(parseProjectDiscoveryAction({ ...action, pageSize }).ok).toBe(
          false,
        );
      },
    );
    it.each(['', '   ', 'x'.repeat(2049), 12, null])(
      'rejects cursor %p',
      (cursor) => {
        expect(parseProjectDiscoveryAction({ ...action, cursor }).ok).toBe(
          false,
        );
      },
    );
    it.each(['query', 'name'])('normalizes and bounds %s', (key) => {
      expect(
        projectDiscoveryActionSchema.parse({ ...action, [key]: '  Title  ' }),
      ).toHaveProperty(key, 'Title');
      for (const value of ['', '  ', 'x'.repeat(501), 12, null]) {
        expect(
          parseProjectDiscoveryAction({ ...action, [key]: value }).ok,
        ).toBe(false);
      }
      expect(
        parseProjectDiscoveryAction({ ...action, [key]: 'x'.repeat(500) }).ok,
      ).toBe(true);
    });
    it('does not rewrite an opaque cursor', () => {
      expect(
        projectDiscoveryActionSchema.parse({ ...action, cursor: ' opaque ' }),
      ).toHaveProperty('cursor', ' opaque ');
    });
    it('accepts inclusive page and cursor boundaries', () => {
      expect(
        parseProjectDiscoveryAction({
          ...action,
          pageSize: 1,
          cursor: 'x'.repeat(2048),
        }).ok,
      ).toBe(true);
    });
  });

  it.each([
    ['projects.list_tasks', 'projectId'],
    ['projects.list_task_chats', 'projectId'],
    ['projects.list_task_chats', 'taskId'],
  ])('validates %s %s', (type, key) => {
    const action = { type, projectId: 'project' };
    for (const value of ['', '  ', 'x'.repeat(513), 1, null]) {
      expect(parseProjectDiscoveryAction({ ...action, [key]: value }).ok).toBe(
        false,
      );
    }
    expect(
      projectDiscoveryActionSchema.parse({
        ...action,
        [key]: ' canonical-id ',
      }),
    ).toHaveProperty(key, 'canonical-id');
    expect(
      parseProjectDiscoveryAction({ ...action, [key]: 'x'.repeat(512) }).ok,
    ).toBe(true);
  });

  it.each([
    { type: 'projects.list', key: 'types', valid: ['code', 'cowork'] },
    { type: 'projects.list', key: 'purposes', valid: ['project', 'chats'] },
    {
      type: 'projects.list',
      key: 'readiness',
      valid: ['ready', 'pending', 'unavailable'],
    },
    { type: 'projects.list_tasks', key: 'statuses', valid: ['active', 'done'] },
    {
      type: 'projects.list_tasks',
      key: 'retentionStates',
      valid: ['retained', 'archived'],
    },
    {
      type: 'projects.list_task_chats',
      key: 'retentionStates',
      valid: ['retained', 'archived'],
    },
    {
      type: 'projects.list_task_chats',
      key: 'runtimeStates',
      valid: ['idle', 'running', 'queued', 'interrupted', 'error', 'unknown'],
    },
    {
      type: 'projects.list_task_chats',
      key: 'providerTypes',
      valid: Object.keys(providers),
    },
    {
      type: 'projects.list_task_chats',
      key: 'executionHarnesses',
      valid: Object.keys(harnesses),
    },
  ])(
    'rejects empty, duplicate, or invalid $key for $type',
    ({ type, key, valid }) => {
      const action =
        type === 'projects.list' ? { type } : { type, projectId: 'project' };
      expect(parseProjectDiscoveryAction({ ...action, [key]: valid }).ok).toBe(
        true,
      );
      for (const values of [
        [],
        [valid[0], valid[0]],
        ['unknown-value'],
        [null],
        'not-array',
      ]) {
        expect(
          parseProjectDiscoveryAction({ ...action, [key]: values }).ok,
        ).toBe(false);
      }
    },
  );

  it('validates providers independently and harnesses with the existing registry', () => {
    const candidates = [
      ...Object.keys(providers),
      'future-provider',
      'toString',
      '',
      1,
      null,
    ];
    for (const candidate of candidates) {
      expect(
        projectsListTaskChatsActionSchema.safeParse({
          ...actions[2],
          executionHarnesses: [candidate],
        }).success,
      ).toBe(isModelHarness(candidate));
      const isProvider =
        typeof candidate === 'string' &&
        Object.prototype.hasOwnProperty.call(providers, candidate);
      expect(
        projectsListTaskChatsActionSchema.safeParse({
          ...actions[2],
          providerTypes: [candidate],
        }).success,
      ).toBe(isProvider);
    }
  });

  it.each([
    { kind: 'personal' },
    { kind: 'organization', organizationId: ' organization-id ' },
  ])('accepts strict $kind owner', (owner) => {
    const result = projectsListActionSchema.parse({
      type: 'projects.list',
      owner,
    });
    expect(result.owner).toEqual(
      owner.kind === 'personal'
        ? owner
        : { kind: 'organization', organizationId: 'organization-id' },
    );
  });
  it.each([
    { kind: 'none' },
    { kind: 'organization' },
    { kind: 'organization', organizationId: '' },
    { kind: 'organization', organizationId: '  ' },
    { kind: 'organization', organizationId: 'x'.repeat(513) },
    { kind: 'personal', organizationId: 'not-personal' },
    { kind: 'organization', organizationId: 'org', selected: true },
    null,
  ])('rejects malformed owner %p', (owner) => {
    expect(
      parseProjectDiscoveryAction({ type: 'projects.list', owner }).ok,
    ).toBe(false);
  });

  it('reports precise code/cowork compatibility errors after project resolution', () => {
    expect(incompatibleTaskFilter({ pinned: false }, 'code')).toBe(
      'pinned is only supported for work_entry tasks in cowork projects.',
    );
    expect(incompatibleTaskFilter({ branchName: 'main' }, 'cowork')).toBe(
      'branchName is only supported for worktree tasks in code projects.',
    );
    expect(incompatibleTaskFilter({ pinned: true }, 'cowork')).toBeNull();
    expect(incompatibleTaskFilter({ branchName: 'main' }, 'code')).toBeNull();
    expect(incompatibleTaskFilter({}, 'code')).toBeNull();
    expect(incompatibleTaskFilter({}, 'cowork')).toBeNull();
    expect(
      projectsListTasksActionSchema.safeParse({
        ...actions[1],
        pinned: false,
        branchName: 'main',
      }).success,
    ).toBe(true);
  });

  it('returns parsed output or a concise first-issue path', () => {
    expect(parseProjectDiscoveryAction(actions[0])).toMatchObject({
      ok: true,
      action: { type: 'projects.list', pageSize: 50 },
    });
    const invalidId = parseProjectDiscoveryAction({
      ...actions[1],
      projectId: '',
    });
    expect(invalidId.ok).toBe(false);
    if (!invalidId.ok) expect(invalidId.message).toMatch(/^projectId: /);
    for (const input of [
      null,
      [],
      'projects.list',
      {},
      { type: 'bots.list' },
      { type: 'projects.list_tasks' },
      { type: 'projects.list_task_chats' },
    ]) {
      const parsed = parseProjectDiscoveryAction(input);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(typeof parsed.message).toBe('string');
    }
  });
  it.each(PROJECT_DISCOVERY_ACTION_TYPES)('recognizes %s', (type) => {
    expect(isProjectDiscoveryActionType(type)).toBe(true);
  });
  it.each([
    'projects.list_extra',
    'projects.read',
    'bots.list',
    '',
    ' projects.list',
  ])('does not recognize %s', (type) => {
    expect(isProjectDiscoveryActionType(type)).toBe(false);
  });
});
