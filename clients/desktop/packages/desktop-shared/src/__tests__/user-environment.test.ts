import {
  compareEnvironmentDefinitions,
  createDefaultEnvironmentConfig,
  DEFAULT_ENVIRONMENT_IDS,
  DEFAULT_ENVIRONMENT_ID_SET,
  DEFAULT_ENVIRONMENT_KIND_ORDER,
  DEFAULT_USER_ENVIRONMENT,
  getDefaultEnvironmentIdForKind,
  getDefaultEnvironmentIdForRuntime,
  getEnvironmentSortOrder,
  getEnvironmentUsage,
  isReservedUserEnvironmentKey,
  isValidUserEnvironmentKey,
  normalizeEnvironmentConfig,
  normalizeUserEnvironment,
  normalizeUserEnvironmentEntries,
  parseBulkEnvironment,
  resolveEnvironmentForRuntime,
  resolveEnvironmentVariables,
  serializeBulkEnvironment,
  toAppliedUserEnvironment,
  validateEnvironmentConfig,
  validateEnvironmentConfigUpdate,
} from '../lib/user-environment';
import type {
  EnvironmentConfigData,
  EnvironmentDefinition,
} from '../types/user-environment';

describe('isValidUserEnvironmentKey', () => {
  it.each([
    ['FOO', true],
    ['_foo', true],
    ['my_var_2', true],
    ['', false],
    ['1FOO', false],
    ['has space', false],
    ['has-dash', false],
    ['ünicode', false],
  ])('returns %s for %p', (key, expected) => {
    expect(isValidUserEnvironmentKey(key)).toBe(expected);
  });
});

describe('isReservedUserEnvironmentKey', () => {
  it('reserves PATH', () => {
    expect(isReservedUserEnvironmentKey('PATH')).toBe(true);
  });

  it('does not reserve user-defined keys', () => {
    expect(isReservedUserEnvironmentKey('FOO')).toBe(false);
    expect(isReservedUserEnvironmentKey('NODE_OPTIONS')).toBe(false);
  });
});

describe('parseBulkEnvironment', () => {
  it('parses KEY=VALUE lines', () => {
    expect(parseBulkEnvironment('FOO=bar\nBAZ=qux')).toEqual([
      { key: 'FOO', value: 'bar' },
      { key: 'BAZ', value: 'qux' },
    ]);
  });

  it('ignores comments and blank lines', () => {
    const text = ['# comment', '', '  ', 'FOO=bar', '# trailing'].join('\n');
    expect(parseBulkEnvironment(text)).toEqual([{ key: 'FOO', value: 'bar' }]);
  });

  it('strips an optional `export ` prefix', () => {
    expect(parseBulkEnvironment('export FOO=bar')).toEqual([
      { key: 'FOO', value: 'bar' },
    ]);
  });

  it('strips matching surrounding quotes from values', () => {
    expect(parseBulkEnvironment('FOO="bar baz"\nQ=\'spaced value\'')).toEqual([
      { key: 'FOO', value: 'bar baz' },
      { key: 'Q', value: 'spaced value' },
    ]);
  });

  it('preserves intentional whitespace in values', () => {
    expect(parseBulkEnvironment('FOO=  bar  \nQUOTED="  baz  "')).toEqual([
      { key: 'FOO', value: '  bar  ' },
      { key: 'QUOTED', value: '  baz  ' },
    ]);
  });

  it('preserves embedded `=` characters in the value', () => {
    expect(parseBulkEnvironment('CONN_STR=user=foo;pwd=bar')).toEqual([
      { key: 'CONN_STR', value: 'user=foo;pwd=bar' },
    ]);
  });

  it('drops malformed lines without raising', () => {
    expect(parseBulkEnvironment('noequals\n=novalue\nFOO=bar')).toEqual([
      { key: 'FOO', value: 'bar' },
    ]);
  });

  it('keeps the last occurrence when keys are duplicated', () => {
    expect(parseBulkEnvironment('FOO=1\nFOO=2\nFOO=3')).toEqual([
      { key: 'FOO', value: '3' },
    ]);
  });

  it('handles CRLF line endings', () => {
    expect(parseBulkEnvironment('FOO=bar\r\nBAZ=qux')).toEqual([
      { key: 'FOO', value: 'bar' },
      { key: 'BAZ', value: 'qux' },
    ]);
  });

  it('preserves empty values', () => {
    expect(parseBulkEnvironment('FOO=')).toEqual([{ key: 'FOO', value: '' }]);
  });
});

describe('serializeBulkEnvironment', () => {
  it('joins entries with newlines', () => {
    expect(
      serializeBulkEnvironment([
        { key: 'FOO', value: 'bar' },
        { key: 'BAZ', value: 'qux' },
      ]),
    ).toBe('FOO=bar\nBAZ=qux');
  });

  it('returns an empty string for no entries', () => {
    expect(serializeBulkEnvironment([])).toBe('');
  });
});

describe('normalizeUserEnvironmentEntries', () => {
  it('drops invalid keys', () => {
    expect(
      normalizeUserEnvironmentEntries([
        { key: 'FOO', value: 'bar' },
        { key: '1bad', value: 'x' },
        { key: '', value: 'x' },
        { key: 'OK_2', value: 'y' },
      ]),
    ).toEqual([
      { key: 'FOO', value: 'bar' },
      { key: 'OK_2', value: 'y' },
    ]);
  });

  it('drops reserved keys', () => {
    expect(
      normalizeUserEnvironmentEntries([
        { key: 'PATH', value: '/should/be/ignored' },
        { key: 'FOO', value: 'bar' },
      ]),
    ).toEqual([{ key: 'FOO', value: 'bar' }]);
  });

  it('coerces non-string values to empty strings', () => {
    expect(
      normalizeUserEnvironmentEntries([{ key: 'FOO', value: 123 }]),
    ).toEqual([{ key: 'FOO', value: '' }]);
  });

  it('deduplicates with last-occurrence-wins', () => {
    expect(
      normalizeUserEnvironmentEntries([
        { key: 'FOO', value: 'a' },
        { key: 'FOO', value: 'b', secret: true },
      ]),
    ).toEqual([{ key: 'FOO', value: 'b', secret: true }]);
  });

  it('preserves only true secret flags', () => {
    expect(
      normalizeUserEnvironmentEntries([
        { key: 'PUBLIC', value: 'one', secret: false },
        { key: 'SECRET', value: 'two', secret: true },
      ]),
    ).toEqual([
      { key: 'PUBLIC', value: 'one' },
      { key: 'SECRET', value: 'two', secret: true },
    ]);
  });
});

describe('normalizeUserEnvironment', () => {
  it('returns defaults for an unknown shape', () => {
    expect(normalizeUserEnvironment(null)).toEqual({
      uiMode: DEFAULT_USER_ENVIRONMENT.uiMode,
      variables: [],
    });
    expect(normalizeUserEnvironment('not-an-object')).toEqual({
      uiMode: DEFAULT_USER_ENVIRONMENT.uiMode,
      variables: [],
    });
  });

  it('keeps a valid uiMode and rejects unknown modes', () => {
    expect(
      normalizeUserEnvironment({ uiMode: 'bulk', variables: [] }).uiMode,
    ).toBe('bulk');
    expect(
      normalizeUserEnvironment({ uiMode: 'nope', variables: [] }).uiMode,
    ).toBe('key-value');
  });

  it('normalizes nested variables', () => {
    expect(
      normalizeUserEnvironment({
        uiMode: 'bulk',
        variables: [
          { key: 'FOO', value: 'bar' },
          { key: '1bad', value: 'skipped' },
        ],
      }),
    ).toEqual({
      uiMode: 'bulk',
      variables: [{ key: 'FOO', value: 'bar' }],
    });
  });
});

describe('toAppliedUserEnvironment', () => {
  it('drops reserved keys defensively', () => {
    expect(
      toAppliedUserEnvironment([
        { key: 'PATH', value: '/should/be/ignored' },
        { key: 'FOO', value: 'bar' },
      ]),
    ).toEqual({ FOO: 'bar' });
  });

  it('returns an empty record for no entries', () => {
    expect(toAppliedUserEnvironment([])).toEqual({});
  });
});

describe('DEFAULT_ENVIRONMENT_IDS', () => {
  it('uses stable string ids for the four protected defaults', () => {
    expect(DEFAULT_ENVIRONMENT_IDS).toEqual({
      overall: 'default-overall',
      canopy: 'default-canopy',
      agent: 'default-agent',
      pipeline: 'default-pipeline',
    });
  });

  it('lets callers test membership via the precomputed set', () => {
    expect(DEFAULT_ENVIRONMENT_ID_SET.has('default-overall')).toBe(true);
    expect(DEFAULT_ENVIRONMENT_ID_SET.has('default-canopy')).toBe(true);
    expect(DEFAULT_ENVIRONMENT_ID_SET.has('default-agent')).toBe(true);
    expect(DEFAULT_ENVIRONMENT_ID_SET.has('default-pipeline')).toBe(true);
    expect(DEFAULT_ENVIRONMENT_ID_SET.has('custom-env')).toBe(false);
  });

  it('resolves runtime → default id', () => {
    expect(getDefaultEnvironmentIdForRuntime('canopy')).toBe('default-canopy');
    expect(getDefaultEnvironmentIdForRuntime('agent')).toBe('default-agent');
    expect(getDefaultEnvironmentIdForRuntime('pipeline')).toBe(
      'default-pipeline',
    );
  });

  it('resolves kind → default id (including the overall root)', () => {
    expect(getDefaultEnvironmentIdForKind('overall')).toBe('default-overall');
    expect(getDefaultEnvironmentIdForKind('canopy')).toBe('default-canopy');
    expect(getDefaultEnvironmentIdForKind('agent')).toBe('default-agent');
    expect(getDefaultEnvironmentIdForKind('pipeline')).toBe('default-pipeline');
  });
});

describe('DEFAULT_ENVIRONMENT_KIND_ORDER', () => {
  it('keeps protected default environments in display order', () => {
    expect(DEFAULT_ENVIRONMENT_KIND_ORDER).toEqual([
      'overall',
      'canopy',
      'agent',
      'pipeline',
    ]);
  });
});

describe('createDefaultEnvironmentConfig', () => {
  it('seeds the four protected default environments', () => {
    const data = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    expect(data.version).toBe(2);
    expect(data.environments.map((environment) => environment.id)).toEqual([
      'default-overall',
      'default-canopy',
      'default-agent',
      'default-pipeline',
    ]);
    expect(data.environments.map((environment) => environment.name)).toEqual([
      'Overall',
      'Canopy',
      'Agents',
      'Pipelines',
    ]);
    expect(data.globalRuntimes).toEqual({
      canopy: 'default-canopy',
      agent: 'default-agent',
      pipeline: 'default-pipeline',
    });
    expect(data.workspaceAssignments).toEqual([]);
  });
});

describe('compareEnvironmentDefinitions', () => {
  it('sorts seeded defaults before custom environments in protected order', () => {
    const now = '2026-01-01T00:00:00.000Z';
    const defaults = createDefaultEnvironmentConfig(now).environments;
    const customEnvironment: EnvironmentDefinition = {
      id: 'aaa-custom',
      name: 'AAA Custom',
      parentId: null,
      isDefault: false,
      uiMode: 'key-value' as const,
      variables: [],
      createdAt: now,
      updatedAt: now,
    };
    const sorted = [
      customEnvironment,
      defaults[3],
      defaults[1],
      defaults[2],
      defaults[0],
    ].sort(compareEnvironmentDefinitions);

    expect(sorted.map((environment) => environment.name)).toEqual([
      'Overall',
      'Canopy',
      'Agents',
      'Pipelines',
      'AAA Custom',
    ]);
    expect(defaults.map(getEnvironmentSortOrder)).toEqual([0, 1, 2, 3]);
  });

  it('sorts custom environments by name after seeded defaults', () => {
    const now = '2026-01-01T00:00:00.000Z';
    const defaults = createDefaultEnvironmentConfig(now).environments;
    const betaEnvironment: EnvironmentDefinition = {
      id: 'beta',
      name: 'Beta',
      parentId: null,
      isDefault: false,
      uiMode: 'key-value' as const,
      variables: [],
      createdAt: now,
      updatedAt: now,
    };
    const alphaEnvironment: EnvironmentDefinition = {
      id: 'alpha',
      name: 'Alpha',
      parentId: null,
      isDefault: false,
      uiMode: 'key-value' as const,
      variables: [],
      createdAt: now,
      updatedAt: now,
    };

    const sorted = [betaEnvironment, defaults[0], alphaEnvironment].sort(
      compareEnvironmentDefinitions,
    );

    expect(sorted.map((environment) => environment.name)).toEqual([
      'Overall',
      'Alpha',
      'Beta',
    ]);
  });
});

describe('normalizeEnvironmentConfig', () => {
  it('falls back to defaults for an unknown shape', () => {
    const data = normalizeEnvironmentConfig(null, '2026-01-01T00:00:00.000Z');
    expect(data.environments).toHaveLength(4);
    expect(data.globalRuntimes.canopy).toBe('default-canopy');
  });

  it('breaks parent cycles by clearing parentId on cyclic environments', () => {
    const now = '2026-01-01T00:00:00.000Z';
    const raw = {
      version: 2,
      environments: [
        ...createDefaultEnvironmentConfig(now).environments,
        {
          id: 'a',
          name: 'A',
          parentId: 'b',
          isDefault: false,
          uiMode: 'key-value',
          variables: [],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'b',
          name: 'B',
          parentId: 'a',
          isDefault: false,
          uiMode: 'key-value',
          variables: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
      globalRuntimes: {
        canopy: 'default-canopy',
        agent: 'default-agent',
        pipeline: 'default-pipeline',
      },
      workspaceAssignments: [],
    };
    const data = normalizeEnvironmentConfig(raw, now);
    const a = data.environments.find((environment) => environment.id === 'a');
    const b = data.environments.find((environment) => environment.id === 'b');
    expect(a?.parentId).toBeNull();
    expect(b?.parentId).toBeNull();
  });

  it('preserves project assignment identifiers verbatim', () => {
    const now = '2026-01-01T00:00:00.000Z';
    const data = normalizeEnvironmentConfig(
      {
        ...createDefaultEnvironmentConfig(now),
        workspaceAssignments: [
          {
            workspaceId: ' workspace-1 ',
            runtimes: { agent: 'default-agent' },
            updatedAt: now,
          },
        ],
      },
      now,
    );

    expect(data.workspaceAssignments).toEqual([
      {
        workspaceId: ' workspace-1 ',
        runtimes: { agent: 'default-agent' },
        updatedAt: now,
      },
    ]);
  });

  it('drops project assignments with no runtime overrides after normalization', () => {
    const now = '2026-01-01T00:00:00.000Z';
    const data = normalizeEnvironmentConfig(
      {
        ...createDefaultEnvironmentConfig(now),
        workspaceAssignments: [
          {
            workspaceId: 'workspace-1',
            runtimes: {
              canopy: null,
              agent: 'missing-environment',
              pipeline: null,
            },
            updatedAt: now,
          },
          {
            workspaceId: 'workspace-2',
            runtimes: { pipeline: 'default-pipeline' },
            updatedAt: now,
          },
        ],
      },
      now,
    );

    expect(data.workspaceAssignments).toEqual([
      {
        workspaceId: 'workspace-2',
        runtimes: { pipeline: 'default-pipeline' },
        updatedAt: now,
      },
    ]);
  });
});

describe('resolveEnvironmentVariables', () => {
  it('merges inherited variables with child overrides', () => {
    const now = '2026-01-01T00:00:00.000Z';
    const data: EnvironmentConfigData = {
      version: 2,
      environments: [
        ...createDefaultEnvironmentConfig(now).environments.map(
          (environment) =>
            environment.id === 'default-overall'
              ? {
                  ...environment,
                  variables: [{ key: 'BASE', value: 'overall' }],
                }
              : environment,
        ),
        {
          id: 'custom',
          name: 'Custom',
          parentId: 'default-overall',
          isDefault: false,
          uiMode: 'key-value',
          variables: [
            { key: 'BASE', value: 'override' },
            { key: 'EXTRA', value: 'yes' },
          ],
          createdAt: now,
          updatedAt: now,
        },
      ],
      globalRuntimes: {
        canopy: 'default-canopy',
        agent: 'default-agent',
        pipeline: 'default-pipeline',
      },
      workspaceAssignments: [],
    };

    const resolved = resolveEnvironmentVariables(data, 'custom');
    expect(resolved.environmentId).toBe('custom');
    expect(resolved.applied).toEqual({ BASE: 'override', EXTRA: 'yes' });
    expect(resolved.publicApplied).toEqual({
      BASE: 'override',
      EXTRA: 'yes',
    });
    expect(resolved.secretApplied).toEqual({});
    expect(resolved.inheritedEnvironmentIds).toEqual(['default-overall']);
  });

  it('routes secret child overrides to secretApplied', () => {
    const now = '2026-01-01T00:00:00.000Z';
    const base = createDefaultEnvironmentConfig(now);
    const data: EnvironmentConfigData = {
      ...base,
      environments: [
        ...base.environments.map((environment) =>
          environment.id === 'default-overall'
            ? {
                ...environment,
                variables: [
                  { key: 'API_TOKEN', value: 'parent-secret', secret: true },
                  { key: 'PUBLIC_FLAG', value: 'yes' },
                ],
              }
            : environment,
        ),
        {
          id: 'custom',
          name: 'Custom',
          parentId: 'default-overall',
          isDefault: false,
          uiMode: 'key-value',
          variables: [
            { key: 'API_TOKEN', value: 'child-secret', secret: true },
            { key: 'PUBLIC_FLAG', value: 'override' },
          ],
          createdAt: now,
          updatedAt: now,
        },
      ],
    };

    const resolved = resolveEnvironmentVariables(data, 'custom');
    expect(resolved.publicApplied).toEqual({ PUBLIC_FLAG: 'override' });
    expect(resolved.secretApplied).toEqual({ API_TOKEN: 'child-secret' });
    expect(resolved.applied).toEqual({
      PUBLIC_FLAG: 'override',
      API_TOKEN: 'child-secret',
    });
  });
});

describe('resolveEnvironmentForRuntime', () => {
  it('uses project overrides when present and falls back to globals otherwise', () => {
    const now = '2026-01-01T00:00:00.000Z';
    const data: EnvironmentConfigData = {
      version: 2,
      environments: createDefaultEnvironmentConfig(now).environments,
      globalRuntimes: {
        canopy: 'default-canopy',
        agent: 'default-agent',
        pipeline: 'default-pipeline',
      },
      workspaceAssignments: [
        {
          workspaceId: 'ws1',
          runtimes: { canopy: 'default-overall' },
          updatedAt: now,
        },
      ],
    };
    expect(
      resolveEnvironmentForRuntime(data, {
        workspaceId: 'ws1',
        runtime: 'canopy',
      }).environmentId,
    ).toBe('default-overall');
    expect(
      resolveEnvironmentForRuntime(data, {
        workspaceId: 'ws1',
        runtime: 'agent',
      }).environmentId,
    ).toBe('default-agent');
    expect(
      resolveEnvironmentForRuntime(data, { runtime: 'pipeline' }).environmentId,
    ).toBe('default-pipeline');
  });
});

describe('validateEnvironmentConfig', () => {
  it('approves the seeded default config', () => {
    const data = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    expect(validateEnvironmentConfig(data)).toEqual({ ok: true });
  });

  it('rejects cycles in inheritance', () => {
    const now = '2026-01-01T00:00:00.000Z';
    const base = createDefaultEnvironmentConfig(now);
    const data: EnvironmentConfigData = {
      ...base,
      environments: [
        ...base.environments,
        {
          id: 'a',
          name: 'A',
          parentId: 'b',
          isDefault: false,
          uiMode: 'key-value',
          variables: [],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'b',
          name: 'B',
          parentId: 'a',
          isDefault: false,
          uiMode: 'key-value',
          variables: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    expect(validateEnvironmentConfig(data).ok).toBe(false);
  });

  it('rejects PATH variables', () => {
    const now = '2026-01-01T00:00:00.000Z';
    const base = createDefaultEnvironmentConfig(now);
    const data: EnvironmentConfigData = {
      ...base,
      environments: base.environments.map((environment) =>
        environment.id === 'default-overall'
          ? {
              ...environment,
              variables: [{ key: 'PATH', value: '/usr/bin' }],
            }
          : environment,
      ),
    };
    expect(validateEnvironmentConfig(data).ok).toBe(false);
  });
});

describe('validateEnvironmentConfigUpdate', () => {
  it('allows deleting an environment when the next payload also clears its assignment', () => {
    const now = '2026-01-01T00:00:00.000Z';
    const base = createDefaultEnvironmentConfig(now);
    const assigned = {
      id: 'assigned',
      name: 'Assigned',
      parentId: null,
      isDefault: false,
      uiMode: 'key-value' as const,
      variables: [],
      createdAt: now,
      updatedAt: now,
    };
    const previous: EnvironmentConfigData = {
      ...base,
      environments: [...base.environments, assigned],
      workspaceAssignments: [
        {
          workspaceId: 'workspace-1',
          runtimes: { agent: 'assigned' },
          updatedAt: now,
        },
      ],
    };
    const next: EnvironmentConfigData = {
      ...base,
      workspaceAssignments: [],
    };

    expect(validateEnvironmentConfigUpdate(previous, next)).toEqual({
      ok: true,
    });
  });

  it('allows deleting a parent environment when the next payload also removes its children', () => {
    const now = '2026-01-01T00:00:00.000Z';
    const base = createDefaultEnvironmentConfig(now);
    const parent = {
      id: 'parent',
      name: 'Parent',
      parentId: null,
      isDefault: false,
      uiMode: 'key-value' as const,
      variables: [],
      createdAt: now,
      updatedAt: now,
    };
    const child = {
      id: 'child',
      name: 'Child',
      parentId: 'parent',
      isDefault: false,
      uiMode: 'key-value' as const,
      variables: [],
      createdAt: now,
      updatedAt: now,
    };
    const previous: EnvironmentConfigData = {
      ...base,
      environments: [...base.environments, parent, child],
    };
    const next: EnvironmentConfigData = {
      ...base,
      environments: base.environments,
    };

    expect(validateEnvironmentConfigUpdate(previous, next)).toEqual({
      ok: true,
    });
  });

  it('rejects deleting an environment that remains assigned in the next payload', () => {
    const now = '2026-01-01T00:00:00.000Z';
    const base = createDefaultEnvironmentConfig(now);
    const assigned = {
      id: 'assigned',
      name: 'Assigned',
      parentId: null,
      isDefault: false,
      uiMode: 'key-value' as const,
      variables: [],
      createdAt: now,
      updatedAt: now,
    };
    const previous: EnvironmentConfigData = {
      ...base,
      environments: [...base.environments, assigned],
      workspaceAssignments: [
        {
          workspaceId: 'workspace-1',
          runtimes: { agent: 'assigned' },
          updatedAt: now,
        },
      ],
    };
    const next: EnvironmentConfigData = {
      ...previous,
      environments: base.environments,
    };

    expect(validateEnvironmentConfigUpdate(previous, next)).toEqual({
      ok: false,
      message:
        'Assigned environments cannot be deleted. Remove its runtime assignments first.',
    });
  });

  it('rejects deleting a parent environment that remains referenced in the next payload', () => {
    const now = '2026-01-01T00:00:00.000Z';
    const base = createDefaultEnvironmentConfig(now);
    const parent = {
      id: 'parent',
      name: 'Parent',
      parentId: null,
      isDefault: false,
      uiMode: 'key-value' as const,
      variables: [],
      createdAt: now,
      updatedAt: now,
    };
    const child = {
      id: 'child',
      name: 'Child',
      parentId: 'parent',
      isDefault: false,
      uiMode: 'key-value' as const,
      variables: [],
      createdAt: now,
      updatedAt: now,
    };
    const previous: EnvironmentConfigData = {
      ...base,
      environments: [...base.environments, parent, child],
    };
    const next: EnvironmentConfigData = {
      ...base,
      environments: [...base.environments, child],
    };

    expect(validateEnvironmentConfigUpdate(previous, next)).toEqual({
      ok: false,
      message:
        'Parent environments cannot be deleted while another environment inherits from them.',
    });
  });

  it('allows deleting an unused non-default environment', () => {
    const now = '2026-01-01T00:00:00.000Z';
    const base = createDefaultEnvironmentConfig(now);
    const previous: EnvironmentConfigData = {
      ...base,
      environments: [
        ...base.environments,
        {
          id: 'unused',
          name: 'Unused',
          parentId: null,
          isDefault: false,
          uiMode: 'key-value',
          variables: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
    };

    expect(validateEnvironmentConfigUpdate(previous, base)).toEqual({
      ok: true,
    });
  });
});

describe('getEnvironmentUsage', () => {
  it('reports global, project, and parent usage', () => {
    const now = '2026-01-01T00:00:00.000Z';
    const base = createDefaultEnvironmentConfig(now);
    const data: EnvironmentConfigData = {
      ...base,
      environments: [
        ...base.environments,
        {
          id: 'child',
          name: 'Child',
          parentId: 'default-overall',
          isDefault: false,
          uiMode: 'key-value',
          variables: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
      workspaceAssignments: [
        {
          workspaceId: 'ws1',
          runtimes: { agent: 'child' },
          updatedAt: now,
        },
      ],
    };
    const usage = getEnvironmentUsage(data, [
      { id: 'ws1', name: 'Workspace One' },
    ]);
    expect(usage).toContainEqual({
      environmentId: 'default-canopy',
      kind: 'global-runtime',
      runtime: 'canopy',
    });
    expect(usage).toContainEqual({
      environmentId: 'child',
      kind: 'workspace-runtime',
      runtime: 'agent',
      workspaceId: 'ws1',
      workspaceName: 'Workspace One',
    });
    expect(usage).toContainEqual({
      environmentId: 'default-overall',
      kind: 'parent',
      childEnvironmentId: 'child',
    });
  });
});
