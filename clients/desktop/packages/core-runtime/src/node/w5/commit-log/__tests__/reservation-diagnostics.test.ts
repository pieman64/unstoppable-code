import {
  W5_RESERVATION_DIAGNOSTICS_MAX_BYTES,
  workspaceCreationDiagnosticsSchema,
} from '../reservation-diagnostics';

/*
 * Parity with the zod 4.3.6 schema this decoder replaced (CAN-4408): the same
 * inputs are accepted and refused, and an accepted value serializes to the
 * same bytes, so stored diagnostics_json is unchanged. Expected bytes were
 * recorded from zod 4.3.6 over this corpus.
 */

const base = {
  kind: 'local-workspace-create',
  workspaceId: 'w1',
  ownedPaths: [],
  phase: 'member-import',
};

const corpus: Record<string, unknown> = {
  reorderedAndExtraOuterKey: {
    phase: 'remote-clone',
    ownedPaths: ['/a'],
    extra: 1,
    workspaceId: 'w1',
    kind: 'local-workspace-create',
  },
  repoStepReordered: {
    ...base,
    repositories: [
      { path: '/p', status: 'started', owned: true, role: 'member', id: 'r1' },
    ],
  },
  repoStepExtraKey: {
    ...base,
    repositories: [
      { id: 'r1', role: 'member', status: 'started', owned: false, extra: 1 },
    ],
  },
  unownedWithPath: {
    ...base,
    repositories: [
      { id: 'r1', role: 'member', status: 'started', owned: false, path: '/x' },
    ],
  },
  undefinedOptional: {
    ...base,
    phase: 'source-initialization',
    repositories: undefined,
  },
  undefinedAction: {
    ...base,
    repositories: [
      {
        id: 'r1',
        role: 'source',
        status: 'completed',
        owned: true,
        path: '/p',
        action: undefined,
      },
    ],
  },
  nullAction: {
    ...base,
    repositories: [
      {
        id: 'r1',
        role: 'source',
        status: 'completed',
        owned: true,
        path: '/p',
        action: null,
      },
    ],
  },
  ownedMissingPath: {
    ...base,
    repositories: [
      { id: 'r1', role: 'member', status: 'started', owned: true },
    ],
  },
  ownedNotBoolean: {
    ...base,
    repositories: [
      { id: 'r1', role: 'member', status: 'started', owned: 'yes' },
    ],
  },
  idEmpty: { ...base, workspaceId: '' },
  idTooLong: { ...base, workspaceId: 'x'.repeat(257) },
  pathTooLong: { ...base, ownedPaths: ['p'.repeat(4097)] },
  tooManyPaths: {
    ...base,
    ownedPaths: Array.from({ length: 1025 }, () => 'p'),
  },
  multipleIssues: {
    kind: 'other',
    workspaceId: '',
    ownedPaths: 'x',
    phase: 'nope',
  },
  wrongTopType: 'string',
  nullInput: null,
};

const accepted: Record<string, string> = {
  reorderedAndExtraOuterKey:
    '{"kind":"local-workspace-create","workspaceId":"w1","ownedPaths":["/a"],"phase":"remote-clone"}',
  repoStepReordered:
    '{"kind":"local-workspace-create","workspaceId":"w1","ownedPaths":[],"phase":"member-import","repositories":[{"id":"r1","role":"member","status":"started","owned":true,"path":"/p"}]}',
  undefinedOptional:
    '{"kind":"local-workspace-create","workspaceId":"w1","ownedPaths":[],"phase":"source-initialization"}',
  undefinedAction:
    '{"kind":"local-workspace-create","workspaceId":"w1","ownedPaths":[],"phase":"member-import","repositories":[{"id":"r1","role":"source","status":"completed","owned":true,"path":"/p"}]}',
};

const refused = [
  'repoStepExtraKey',
  'unownedWithPath',
  'nullAction',
  'ownedMissingPath',
  'ownedNotBoolean',
  'idEmpty',
  'idTooLong',
  'pathTooLong',
  'tooManyPaths',
  'multipleIssues',
  'wrongTopType',
  'nullInput',
];

describe('workspace creation diagnostics decoder parity (CAN-4408)', () => {
  it('classifies every corpus case exactly once', () => {
    expect([...Object.keys(accepted), ...refused].sort()).toEqual(
      Object.keys(corpus).sort(),
    );
  });

  it.each(Object.entries(accepted))(
    '%s is accepted with the recorded bytes',
    (name, bytes) => {
      const parsed = workspaceCreationDiagnosticsSchema.safeParse(corpus[name]);
      expect(parsed.success).toBe(true);
      expect(parsed.success ? JSON.stringify(parsed.data) : null).toBe(bytes);
      expect(
        JSON.stringify(workspaceCreationDiagnosticsSchema.parse(corpus[name])),
      ).toBe(bytes);
    },
  );

  it.each(refused)('%s is refused', (name) => {
    expect(workspaceCreationDiagnosticsSchema.safeParse(corpus[name])).toEqual(
      expect.objectContaining({ success: false }),
    );
    expect(() =>
      workspaceCreationDiagnosticsSchema.parse(corpus[name]),
    ).toThrow();
  });

  // Inputs already in shape order, which zod 4.3.6 returned byte for byte.
  it.each([
    ['the longest workspace id', { ...base, workspaceId: 'x'.repeat(256) }],
    ['the longest owned path', { ...base, ownedPaths: ['p'.repeat(4096)] }],
    ['an empty owned path', { ...base, ownedPaths: [''] }],
    [
      'the most owned paths',
      { ...base, ownedPaths: Array.from({ length: 1024 }, () => 'p') },
    ],
    [
      'the most repositories',
      {
        ...base,
        repositories: Array.from({ length: 1024 }, () => ({
          id: 'r',
          role: 'member',
          status: 'started',
          owned: false,
        })),
      },
    ],
    [
      'an unowned repository with an action',
      {
        ...base,
        repositories: [
          {
            id: 'x'.repeat(256),
            role: 'source',
            status: 'completed',
            action: 'import',
            owned: false,
          },
        ],
      },
    ],
  ])('accepts %s unchanged', (_name, value) => {
    expect(
      JSON.stringify(workspaceCreationDiagnosticsSchema.parse(value)),
    ).toBe(JSON.stringify(value));
  });

  // zod kept these keys as undefined; the stored bytes are the same.
  it('omits optional keys given as undefined', () => {
    const top = workspaceCreationDiagnosticsSchema.parse(
      corpus.undefinedOptional,
    );
    const repository = workspaceCreationDiagnosticsSchema.parse(
      corpus.undefinedAction,
    ).repositories?.[0];
    expect(Object.keys(top)).not.toContain('repositories');
    expect(Object.keys(repository ?? {})).not.toContain('action');
  });

  it('keeps the 64 KiB stored diagnostics bound', () => {
    expect(W5_RESERVATION_DIAGNOSTICS_MAX_BYTES).toBe(65_536);
  });
});
