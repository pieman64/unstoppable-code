import {
  CANOPY_INSTRUCTION_DEFINITIONS,
  CANOPY_QUERY_DEFINITIONS,
  CANOPY_STREAM_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_STREAM_DEFINITIONS,
  CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_COMMITTED_EVENT,
  CORE_WORKSPACE_EVENT_FAMILY,
  CORE_WORKSPACE_EVENT_NAMES,
  CORE_WORKSPACE_INVALIDATED_EVENT,
  CanopyEventNameSchema,
  CanopyEventSchema,
  CoreWorkspaceCommittedPayloadSchema,
  CoreWorkspaceInvalidatedPayloadSchema,
} from '../index';

describe('core.workspace commit events', () => {
  it('names events in the core.workspace family that no operation uses', () => {
    const operations = new Set(
      [
        CANOPY_QUERY_DEFINITIONS,
        CANOPY_INSTRUCTION_DEFINITIONS,
        CANOPY_STREAM_DEFINITIONS,
        CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
        CORE_TRANSPORT_STREAM_DEFINITIONS,
        CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS,
      ].flatMap((map) => Object.keys(map)),
    );
    for (const name of CORE_WORKSPACE_EVENT_NAMES) {
      expect(CanopyEventNameSchema.safeParse(name).success).toBe(true);
      expect(name.startsWith(`${CORE_WORKSPACE_EVENT_FAMILY}.`)).toBe(true);
      expect(operations.has(name)).toBe(false);
    }
  });

  it('accepts a desktop payload and a web payload built from changes alone', () => {
    const desktop = {
      commit: 'w5:7',
      changes: [
        { kind: 'index', revision: 3 },
        { kind: 'workspace', workspaceId: 'ws-1', revision: 9 },
      ],
      files: [{ kind: 'index' }, { kind: 'manifest', workspaceId: 'ws-1' }],
      publishedBy: 'desktop-window-1',
    };
    const web = {
      commit: 'web:42',
      changes: [
        {
          kind: 'worktree',
          workspaceId: 'ws-1',
          worktreeId: 'wt',
          revision: 1,
        },
      ],
    };
    for (const payload of [desktop, web]) {
      expect(CoreWorkspaceCommittedPayloadSchema.parse(payload)).toEqual(
        payload,
      );
      expect(
        CanopyEventSchema.safeParse({
          cursor: { daemonEpoch: 'runtime:e', sequence: 1 },
          eventId: 'runtime:e#1',
          name: CORE_WORKSPACE_COMMITTED_EVENT,
          scope: { workspaceId: 'ws-1' },
          occurredAt: '2026-10-31T00:00:00.000Z',
          payload,
        }).success,
      ).toBe(true);
    }
  });

  it('keeps additive fields and refuses unknown change kinds', () => {
    expect(
      CoreWorkspaceCommittedPayloadSchema.parse({
        commit: 'w5:1',
        changes: [],
        later: true,
      }),
    ).toMatchObject({ later: true });
    expect(
      CoreWorkspaceCommittedPayloadSchema.safeParse({
        commit: 'w5:1',
        changes: [{ kind: 'core.workspace.create', revision: 1 }],
      }).success,
    ).toBe(false);
    expect(
      CoreWorkspaceCommittedPayloadSchema.safeParse({
        commit: 'w5:1',
        changes: [],
        files: [{ kind: 'manifest', workspaceId: '' }],
      }).success,
    ).toBe(false);
  });

  it('carries a reason and never a success on invalidation', () => {
    expect(
      CoreWorkspaceInvalidatedPayloadSchema.parse({
        reason: 'recovered',
        commits: ['w5:4'],
      }),
    ).toEqual({ reason: 'recovered', commits: ['w5:4'] });
    expect(
      CoreWorkspaceInvalidatedPayloadSchema.safeParse({ reason: 'applied' })
        .success,
    ).toBe(false);
    expect(CORE_WORKSPACE_INVALIDATED_EVENT).toBe('core.workspace.invalidated');
  });
});
