import {
  CORE_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_IMPORT_INSTRUCTION_DEFINITIONS,
  CoreWorkspaceCreateResultSchema,
  CoreWorkspaceImportParamsSchema,
  CoreWorkspaceImportResultSchema,
} from '../index';

const _meta = { idempotencyKey: 'key-1' };

describe('core.workspace.import (#2, W7b-3)', () => {
  it('is its own registry, outside the composed and web-served ones', () => {
    expect(Object.keys(CORE_WORKSPACE_IMPORT_INSTRUCTION_DEFINITIONS)).toEqual([
      'core.workspace.import',
    ]);
    expect(Object.keys(CORE_INSTRUCTION_DEFINITIONS)).not.toContain(
      'core.workspace.import',
    );
    expect(
      Object.keys(CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS),
    ).not.toContain('core.workspace.import');
    expect(
      CORE_WORKSPACE_IMPORT_INSTRUCTION_DEFINITIONS['core.workspace.import'],
    ).toMatchObject({
      idempotency: 'keyed',
      requiredGrants: ['core.workspace.write'],
    });
  });

  it.each([
    { kind: 'local_picker_selection', selectionId: 'sel-1' },
    { kind: 'git_url', value: 'https://github.com/acme/app.git' },
    { kind: 'git_url', value: 'SSH://git@example.com/acme/app' },
    { kind: 'git_url', value: 'git@github.com:acme/app.git' },
    { kind: 'provider_project', value: 'project-1' },
  ])('takes the %o source', (source) => {
    expect(
      CoreWorkspaceImportParamsSchema.safeParse({ source, name: 'App', _meta })
        .success,
    ).toBe(true);
  });

  it.each([
    '/Users/me/app',
    'file:///Users/me/app',
    '--upload-pack=x',
    'C:\\repo',
    'git@host',
  ])('refuses the %s remote, which is no http(s), ssh or scp form', (value) => {
    expect(
      CoreWorkspaceImportParamsSchema.safeParse({
        source: { kind: 'git_url', value },
        name: 'App',
        _meta,
      }).success,
    ).toBe(false);
  });

  it('carries no owner, organization, path or key-less form (B7)', () => {
    const base = {
      source: { kind: 'git_url', value: 'https://example.com/a.git' },
      name: 'App',
    };
    expect(CoreWorkspaceImportParamsSchema.safeParse(base).success).toBe(false);
    for (const extra of [
      { ownerOrganizationId: 'org-1' },
      { owner: { type: 'organization' } },
      { repoPath: '/tmp/a' },
    ])
      expect(
        CoreWorkspaceImportParamsSchema.safeParse({ ...base, ...extra, _meta })
          .success,
      ).toBe(false);
    expect(
      CoreWorkspaceImportParamsSchema.safeParse({
        ...base,
        targetId: null,
        _meta,
      }).success,
    ).toBe(true);
    expect(
      CoreWorkspaceImportParamsSchema.safeParse({
        ...base,
        name: 'n'.repeat(257),
        _meta,
      }).success,
    ).toBe(false);
  });

  it('answers an open operation reference', () => {
    expect(
      CoreWorkspaceImportResultSchema.safeParse({
        operationId: 'op-1',
        kind: 'core.workspace.import',
        status: 'completed',
        workspaceId: 'app',
      }).success,
    ).toBe(true);
    expect(
      CoreWorkspaceImportResultSchema.safeParse({
        operationId: 'op-1',
        kind: 'core.workspace.import',
        status: 'succeeded',
      }).success,
    ).toBe(false);
  });

  it("shares #1's codes, the keyed ones included", () => {
    const parser =
      (error: {
        safeParse: (value: unknown) => { success: boolean };
      }): ((code: string) => boolean) =>
      (code) =>
        error.safeParse({
          kind: 'failed_precondition',
          message: 'Refused.',
          code,
          retry: { kind: 'never' },
        }).success;
    const keyed = [
      'core.workspace.idempotencyKeyReused',
      'core.workspace.requestInProgress',
      'core.workspace.recoveryRequired',
      'core.workspace.outcomeExpired',
    ];
    for (const error of [
      CORE_WORKSPACE_IMPORT_INSTRUCTION_DEFINITIONS['core.workspace.import']
        .error,
      CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS['core.workspace.create']
        .error,
    ]) {
      const parse = parser(error);
      for (const code of ['core.workspace.invalidState', ...keyed])
        expect(parse(code)).toBe(true);
      expect(parse('core.workspace.readOnly')).toBe(false);
    }
  });
});

describe('core.workspace.create result (D-2, W7b-3)', () => {
  const workspace = {
    workspaceId: 'app',
    name: 'App',
    kind: 'single_repo',
    temporary: false,
    repositories: [],
  };

  it('omits the revisions and times a host lacks', () => {
    expect(
      CoreWorkspaceCreateResultSchema.safeParse({ workspace, operation: null })
        .success,
    ).toBe(true);
  });

  it('still validates them when present, and stays closed', () => {
    const full = {
      ...workspace,
      settingsRevision: 1,
      revision: 1,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    };
    expect(
      CoreWorkspaceCreateResultSchema.safeParse({
        workspace: full,
        operation: null,
      }).success,
    ).toBe(true);
    for (const bad of [
      { revision: -1 },
      { createdAt: '2026-11-01' },
      { path: '/tmp/app' },
    ])
      expect(
        CoreWorkspaceCreateResultSchema.safeParse({
          workspace: { ...full, ...bad },
          operation: null,
        }).success,
      ).toBe(false);
  });
});
