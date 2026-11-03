import { z } from 'zod';
import { isSafePortableRelativePath } from '../../safe-relative-path';
import { isProjectStartPage } from '../../start-page';
import {
  CORE_GUARDED_SETTINGS_INSTRUCTION_DEFINITIONS,
  CORE_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS,
  CoreWorkspaceCoworkUpdateErrorSchema,
  CoreWorkspaceCoworkUpdateParamsSchema,
  CoreWorkspaceHooksUpdateParamsSchema,
  CoreWorkspacePluginsUpdateErrorSchema,
  CoreWorkspacePluginsUpdateParamsSchema,
  CoreWorkspaceRetentionUpdateParamsSchema,
  CoreWorktreeHooksSetPausedErrorSchema,
  CoreWorktreeHooksSetPausedParamsSchema,
  CoreWorktreeReorderErrorSchema,
  CoreWorktreeReorderParamsSchema,
  CoreWorktreeReorderResultSchema,
} from '../index';

const _meta = { idempotencyKey: 'key-1' };
const selections = { collectionIds: [], skillRefs: [], pluginRefs: [] };

describe('guarded W5 settings commands (CAN-5524)', () => {
  it('stay out of the composed registry, which needs a handler for each', () => {
    for (const name of Object.keys(
      CORE_GUARDED_SETTINGS_INSTRUCTION_DEFINITIONS,
    ))
      expect(Object.keys(CORE_INSTRUCTION_DEFINITIONS)).not.toContain(name);
  });

  it('require an idempotency key and reject unknown fields', () => {
    const params = {
      workspaceId: 'ws-1',
      patch: { archiveRetentionDays: 30 },
    };
    expect(
      CoreWorkspaceRetentionUpdateParamsSchema.safeParse({ ...params, _meta })
        .success,
    ).toBe(true);
    expect(
      CoreWorkspaceRetentionUpdateParamsSchema.safeParse(params).success,
    ).toBe(false);
    expect(
      CoreWorkspaceRetentionUpdateParamsSchema.safeParse({
        ...params,
        _meta,
        source: 'workspace_settings',
      }).success,
    ).toBe(false);
  });

  it('takes the desktop identifier charset', () => {
    for (const workspaceId of ['', 'WS-1', '-ws', 'ws/1'])
      expect(
        CoreWorkspacePluginsUpdateParamsSchema.safeParse({
          workspaceId,
          change: { kind: 'setDefaults', defaultPluginSelections: selections },
          _meta,
        }).success,
      ).toBe(false);
  });

  it('carries only the two user plugin changes', () => {
    const parse = (change: unknown): boolean =>
      CoreWorkspacePluginsUpdateParamsSchema.safeParse({
        workspaceId: 'ws-1',
        expectedRevision: 3,
        change,
        _meta,
      }).success;
    expect(
      parse({ kind: 'setDefaults', defaultPluginSelections: selections }),
    ).toBe(true);
    expect(
      parse({
        kind: 'selectRecommended',
        selections: [
          { kind: 'skill', sourceId: 'builtin:app', skillName: 'review' },
          { kind: 'plugin', marketplaceId: 'm', pluginName: 'p' },
        ],
        optOutKeys: ['a'],
        clearOptOutKeys: [],
      }),
    ).toBe(true);
    // Host sweeps, never wire changes.
    expect(parse({ kind: 'pruneMarketplace', marketplaceId: 'm' })).toBe(false);
    expect(parse({ kind: 'replaceMcpServerRefs', from: [], to: {} })).toBe(
      false,
    );
    // The legacy collection alias is read-only.
    expect(
      parse({
        kind: 'setDefaults',
        defaultPluginSelections: { ...selections, bundleIds: ['b'] },
      }),
    ).toBe(false);
  });

  it('bounds retention days as the desktop does', () => {
    const parse = (patch: unknown): boolean =>
      CoreWorkspaceRetentionUpdateParamsSchema.safeParse({
        workspaceId: 'ws-1',
        patch,
        _meta,
      }).success;
    expect(parse({ archiveRetentionDays: null, autoArchiveDays: null })).toBe(
      true,
    );
    expect(parse({ archiveRetentionDays: 0, autoArchiveDays: 1 })).toBe(true);
    expect(parse({ archiveRetentionDays: 36_500 })).toBe(true);
    expect(parse({ archiveRetentionDays: 36_501 })).toBe(false);
    expect(parse({ archiveRetentionDays: 1.5 })).toBe(false);
    expect(parse({ archiveRetentionDays: 7, autoArchiveDays: 0 })).toBe(false);
    // The archive retention is always set.
    expect(parse({ autoArchiveDays: 7 })).toBe(false);
  });

  it('keeps Cowork presentation and explicit plugin defaults out (A28′(a))', () => {
    const parse = (settings: unknown): boolean =>
      CoreWorkspaceCoworkUpdateParamsSchema.safeParse({
        workspaceId: 'ws-1',
        settings,
        _meta,
      }).success;
    expect(
      parse({
        description: 'd',
        defaultPresetId: 'p',
        presets: [{ id: 'p', name: 'P', pluginSelections: selections }],
        startPage: null,
      }),
    ).toBe(true);
    for (const field of [
      { name: 'Renamed' },
      { color: '#ffffff' },
      { alwaysShow: true },
      { defaultPluginSelections: selections },
    ])
      expect(parse(field)).toBe(false);
  });

  it('admits starter prompts and start pages as the desktop does', () => {
    const parse = (settings: unknown): boolean =>
      CoreWorkspaceCoworkUpdateParamsSchema.safeParse({
        workspaceId: 'ws-1',
        settings,
        _meta,
      }).success;
    const prompt = (id: string, text = 'Do it'): unknown => ({ id, text });
    expect(parse({ starterPrompts: [] })).toBe(true);
    expect(parse({ starterPrompts: [prompt('a'), prompt('b')] })).toBe(true);
    expect(parse({ starterPrompts: [prompt('a'), prompt('a')] })).toBe(false);
    expect(parse({ starterPrompts: [prompt(' ')] })).toBe(false);
    expect(parse({ starterPrompts: [prompt('a', '  ')] })).toBe(false);
    expect(
      parse({
        starterPrompts: Array.from({ length: 16 }, (_, index) =>
          prompt(`p${index}`),
        ),
      }),
    ).toBe(false);
    expect(parse({ startPage: { kind: 'url', url: 'https://x.test' } })).toBe(
      true,
    );
    expect(parse({ startPage: { kind: 'url', url: 'file:///x' } })).toBe(false);
    // A Cowork start page cannot inherit.
    expect(parse({ startPage: { kind: 'inherit' } })).toBe(false);
  });

  // Judged against the host's start page file rule (`isProjectStartPage`).
  const START_PAGE_FILE_PATHS = [
    'README.md',
    'docs/start.md',
    '.github/a.md',
    '...',
    '.a/..b/c..',
    'a b/c',
    'a\n/b',
    'a/..\n',
    '.. /x',
    'x'.repeat(4096),
    '../secret',
    'docs/../secret',
    'docs/..',
    '..',
    '.',
    './a',
    'a/./b',
    'a/.',
    '/absolute',
    'C:/secret',
    'c:secret',
    'a\\b',
    'a//b',
    'a/',
    '',
    'x'.repeat(4097),
    'a\n/..',
  ];

  it('admits only a safe relative start page file path', () => {
    const parse = (path: string): boolean =>
      CoreWorkspaceCoworkUpdateParamsSchema.safeParse({
        workspaceId: 'ws-1',
        settings: { startPage: { kind: 'file', repoId: 'repo-1', path } },
        _meta,
      }).success;
    expect(parse('docs/start.md')).toBe(true);
    for (const path of ['../secret', '/absolute', 'C:/secret', 'a\\b'])
      expect(parse(path)).toBe(false);
    for (const path of START_PAGE_FILE_PATHS)
      expect([path, parse(path)]).toEqual([
        path,
        isProjectStartPage({ kind: 'file', path }),
      ]);
    // Stricter than the host: a blank path is refused.
    expect(parse(' ')).toBe(false);
  });

  it('publishes the start page file path rule in its JSON Schema', () => {
    const settings = z.toJSONSchema(CoreWorkspaceCoworkUpdateParamsSchema, {
      io: 'input',
    }).properties?.settings;
    const startPage =
      typeof settings === 'object' ? settings.properties?.startPage : undefined;
    const file =
      typeof startPage === 'object' ? startPage.anyOf?.[0] : undefined;
    const path = typeof file === 'object' ? file.properties?.path : undefined;
    const pattern = typeof path === 'object' ? path.pattern : undefined;
    expect(typeof pattern).toBe('string');
    const matches = (value: string): boolean =>
      new RegExp(pattern ?? '', 'u').test(value);
    for (const value of START_PAGE_FILE_PATHS.filter(
      (candidate) => candidate.length <= 4096,
    ))
      expect([value, matches(value)]).toEqual([
        value,
        value.trim() !== '' && isSafePortableRelativePath(value),
      ]);
    expect(matches(' ')).toBe(false);
  });

  it('keeps chat and pipeline hook actions open and command actions closed', () => {
    const parse = (action: unknown): boolean =>
      CoreWorkspaceHooksUpdateParamsSchema.safeParse({
        workspaceId: 'ws-1',
        change: { kind: 'replace', hooks: { 'on-create': [action] } },
        _meta,
      }).success;
    expect(parse({ type: 'chat', prompt: 'p', provider: 'claude' })).toBe(true);
    expect(
      parse({ type: 'pipeline', source: 'local', id: 'x', inputs: {} }),
    ).toBe(true);
    expect(parse({ type: 'command', command: 'ls', cwd: '/tmp' })).toBe(false);
    expect(parse({ type: 'command', command: 'ls', interactive: false })).toBe(
      false,
    );
  });

  it('separates replacing the paused set from pausing named keys', () => {
    const parse = (change: unknown): boolean =>
      CoreWorktreeHooksSetPausedParamsSchema.safeParse({
        workspaceId: 'ws-1',
        worktreeId: 'wt-1',
        change,
        _meta,
      }).success;
    expect(parse({ kind: 'replace', pausedHookKeys: [] })).toBe(true);
    expect(parse({ kind: 'pause', hookKeys: ['k'] })).toBe(true);
    expect(parse({ kind: 'resume', pausedHookKeys: ['k'] })).toBe(false);
    expect(parse({ kind: 'replace', hookKeys: ['k'] })).toBe(false);
  });

  it('offers keyed retries only', () => {
    const error = {
      kind: 'unavailable',
      message: 'Busy.',
      code: 'core.workspace.requestInProgress',
    };
    expect(
      CoreWorkspacePluginsUpdateErrorSchema.safeParse({
        ...error,
        retry: { kind: 'same_idempotency_key' },
      }).success,
    ).toBe(true);
    expect(
      CoreWorkspacePluginsUpdateErrorSchema.safeParse({
        ...error,
        retry: { kind: 'same_request' },
      }).success,
    ).toBe(false);
  });

  it('moves one visible worktree and carries no group membership (A22(a))', () => {
    const move = {
      workspaceId: 'ws-1',
      activeWorktreeId: 'wt-1',
      overWorktreeId: 'wt-2',
    };
    const parse = (params: unknown): boolean =>
      CoreWorktreeReorderParamsSchema.safeParse(params).success;
    expect(parse({ ...move, _meta })).toBe(true);
    expect(parse({ ...move, expectedRevision: 0, _meta })).toBe(true);
    // The page's ids are opaque: bounds only, no desktop charset.
    expect(parse({ ...move, activeWorktreeId: 'WT_1', _meta })).toBe(true);
    expect(parse({ ...move, overWorktreeId: '', _meta })).toBe(false);
    expect(parse({ ...move, expectedRevision: -1, _meta })).toBe(false);
    expect(parse({ ...move, expectedRevision: 1.5, _meta })).toBe(false);
    // The key travels only in `_meta`, never beside the params.
    expect(parse(move)).toBe(false);
    expect(parse({ ...move, idempotencyKey: 'key-1' })).toBe(false);
    expect(parse({ ...move, idempotencyKey: 'key-1', _meta })).toBe(false);
    for (const extra of [
      { branchGroupingParentWorktreeId: 'wt-3' },
      { groupId: 'g-1' },
      { worktreeOrder: ['wt-2', 'wt-1'] },
    ])
      expect(parse({ ...move, ...extra, _meta })).toBe(false);
  });

  it('returns a closed, empty reorder result', () => {
    expect(CoreWorktreeReorderResultSchema.safeParse({}).success).toBe(true);
    expect(
      CoreWorktreeReorderResultSchema.safeParse({ worktreeOrder: [] }).success,
    ).toBe(false);
  });

  it('refuses a reorder under the page codes only', () => {
    const parse = (kind: string, code: string): boolean =>
      CoreWorktreeReorderErrorSchema.safeParse({
        kind,
        message: 'Refused.',
        code,
        retry: { kind: 'never' },
      }).success;
    expect(parse('not_found', 'core.worktree.notFound')).toBe(true);
    expect(parse('conflict', 'core.worktree.revisionConflict')).toBe(true);
    expect(parse('failed_precondition', 'core.worktree.readOnly')).toBe(true);
    expect(parse('failed_precondition', 'core.worktree.invalidState')).toBe(
      false,
    );
    expect(parse('unavailable', 'core.worktree.listUnavailable')).toBe(false);
  });

  it('pause hooks and reorder under the keyed worktree codes the lifecycle commands use', () => {
    const lifecycle =
      CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS['core.worktree.update']
        .error;
    for (const [code, kind, retry] of [
      ['core.worktree.idempotencyKeyReused', 'conflict', 'never'],
      [
        'core.worktree.requestInProgress',
        'unavailable',
        'same_idempotency_key',
      ],
      ['core.worktree.recoveryRequired', 'failed_precondition', 'never'],
      ['core.worktree.outcomeExpired', 'failed_precondition', 'never'],
    ] as const) {
      const error = { kind, message: 'Refused.', code, retry: { kind: retry } };
      expect(lifecycle.safeParse(error).success).toBe(true);
      expect(
        CoreWorktreeHooksSetPausedErrorSchema.safeParse(error).success,
      ).toBe(true);
      expect(CoreWorktreeReorderErrorSchema.safeParse(error).success).toBe(
        true,
      );
    }
  });

  it('reports refusals without a code of their own as invalidState', () => {
    const parse = (code: string): boolean =>
      CoreWorkspaceCoworkUpdateErrorSchema.safeParse({
        kind: 'failed_precondition',
        message: 'The Work Entries could not be stamped.',
        code,
        details: { reason: 'activity_unavailable' },
        retry: { kind: 'same_idempotency_key' },
      }).success;
    expect(parse('core.workspace.invalidState')).toBe(true);
    expect(parse('core.workspace.activityUnavailable')).toBe(false);
  });
});
