import type { ForeignActivityProjection } from '@canopy/protocol/foreign-activity';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  CONTEXT_CARRYOVER_LINGER_MS,
  contextActivityItemsFromSnapshot,
  contextCarryoverDeadline,
  contextCarryoverProjection,
  contextKeysWithUpdates,
  observeContextCarryover,
  startContextCarryover,
  type ContextActivityItem,
  type ContextActivitySnapshot,
  type ContextCarryoverState,
} from '../context-updates';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PERSONAL: WorkspaceContext = { kind: 'personal' };
const ACME: WorkspaceContext = { kind: 'organization', organizationId: ORG_A };

function item(
  key: string,
  context: WorkspaceContext,
  state: { active?: boolean; unread?: boolean; source?: string } = {},
): ContextActivityItem {
  return {
    key,
    context,
    workspaceId: `${key}-workspace`,
    name: `${key} project`,
    active: state.active ?? false,
    unread: state.unread ?? false,
    ...(state.source === undefined ? {} : { source: state.source }),
  };
}

function keys(state: ContextCarryoverState, now: number): string[] {
  const updates: ReadonlySet<string> = contextKeysWithUpdates({
    groups: contextCarryoverProjection(state, now),
  });
  return Array.from(updates).sort();
}

describe('contextKeysWithUpdates (the shared definition of an update)', () => {
  it('keys a context when any of its workspaces is running, unread, or interrupted', () => {
    const workspace = {
      workspaceId: 'w',
      name: 'W',
      running: 0,
      unread: 0,
      interrupted: false,
      latestTarget: {
        source: 'chat' as const,
        operationId: 'op',
        workspaceId: 'w',
        worktreeId: 't',
        resultToken: null,
      },
      stopTargets: [],
    };
    const projection: Pick<ForeignActivityProjection, 'groups'> = {
      groups: [
        { context: PERSONAL, workspaces: [{ ...workspace, running: 1 }] },
        { context: ACME, workspaces: [{ ...workspace, unread: 2 }] },
        {
          context: { kind: 'organization', organizationId: ORG_B },
          workspaces: [{ ...workspace, interrupted: true }],
        },
        {
          context: { kind: 'organization', organizationId: 'lingering' },
          workspaces: [workspace],
        },
      ],
    };
    expect([...contextKeysWithUpdates(projection)].sort()).toEqual(
      ['personal', ORG_A, ORG_B].sort(),
    );
  });
});

describe('context carryover (portal mirror of the desktop ledger)', () => {
  it('carries work already running in another context when the epoch starts', () => {
    const state = startContextCarryover(
      PERSONAL,
      [
        item('org-run', ACME, { active: true }),
        item('personal-run', PERSONAL, { active: true }),
      ],
      0,
    );
    expect(keys(state, 0)).toEqual([ORG_A]);
    const [group] = contextCarryoverProjection(state, 0);
    expect(group?.workspaces[0]).toMatchObject({
      workspaceId: 'org-run-workspace',
      name: 'org-run project',
      running: 1,
      unread: 0,
      interrupted: false,
    });
  });

  it('never imports unread badges that predate the epoch', () => {
    const state = startContextCarryover(
      PERSONAL,
      [item('old', ACME, { unread: true })],
      0,
    );
    expect(keys(state, 0)).toEqual([]);
    expect(
      keys(
        observeContextCarryover(
          state,
          [item('old', ACME, { unread: true })],
          1,
        ),
        1,
      ),
    ).toEqual([]);
  });

  it('marks new unread attention after the epoch and drops it once read', () => {
    let state = startContextCarryover(PERSONAL, [item('chat', ACME)], 0);
    state = observeContextCarryover(
      state,
      [item('chat', ACME, { unread: true })],
      1,
    );
    expect(keys(state, 1)).toEqual([ORG_A]);
    state = observeContextCarryover(state, [item('chat', ACME)], 2);
    expect(keys(state, 2)).toEqual([]);
  });

  it('turns completed carried work into unread, or a silent 30 second linger', () => {
    let state = startContextCarryover(
      PERSONAL,
      [
        item('unread', ACME, { active: true }),
        item(
          'quiet',
          { kind: 'organization', organizationId: ORG_B },
          {
            active: true,
          },
        ),
      ],
      0,
    );
    expect(keys(state, 0)).toEqual([ORG_A, ORG_B].sort());
    state = observeContextCarryover(
      state,
      [
        item('unread', ACME, { unread: true }),
        item('quiet', { kind: 'organization', organizationId: ORG_B }),
      ],
      10,
    );
    // A lingering completion carries no dot of its own.
    expect(keys(state, 10)).toEqual([ORG_A]);
    expect(contextCarryoverDeadline(state, 10)).toBe(
      10 + CONTEXT_CARRYOVER_LINGER_MS,
    );
    expect(
      contextCarryoverDeadline(
        observeContextCarryover(
          state,
          [
            item('unread', ACME, { unread: true }),
            item('quiet', { kind: 'organization', organizationId: ORG_B }),
          ],
          10 + CONTEXT_CARRYOVER_LINGER_MS,
        ),
        10 + CONTEXT_CARRYOVER_LINGER_MS,
      ),
    ).toBeNull();
  });

  it('schedules the next unexpired linger once an earlier one has expired', () => {
    let state = startContextCarryover(
      PERSONAL,
      [
        item('early', ACME, { active: true }),
        item('late', ACME, { active: true }),
      ],
      0,
    );
    state = observeContextCarryover(
      state,
      [item('early', ACME), item('late', ACME, { active: true })],
      0,
    );
    state = observeContextCarryover(state, [item('early', ACME)], 10);
    // With no newer snapshot, the expired entry is still held in state.
    expect(contextCarryoverDeadline(state, CONTEXT_CARRYOVER_LINGER_MS)).toBe(
      10 + CONTEXT_CARRYOVER_LINGER_MS,
    );
  });

  it('shows a new unread result after a quiet completion has stopped lingering', () => {
    let state = startContextCarryover(
      PERSONAL,
      [item('quiet', ACME, { active: true })],
      0,
    );
    state = observeContextCarryover(state, [item('quiet', ACME)], 1);
    const later = 1 + CONTEXT_CARRYOVER_LINGER_MS;
    state = observeContextCarryover(
      state,
      [item('quiet', ACME, { unread: true })],
      later,
    );
    expect(keys(state, later)).toEqual([ORG_A]);
  });

  it('marks carried work that vanishes while running as interrupted until the linger expires', () => {
    let state = startContextCarryover(
      PERSONAL,
      [item('gone', ACME, { active: true })],
      0,
    );
    state = observeContextCarryover(state, [], 5);
    expect(keys(state, 5)).toEqual([ORG_A]);
    expect(
      contextCarryoverProjection(state, 5)[0]?.workspaces[0],
    ).toMatchObject({ running: 0, interrupted: true });
    expect(keys(state, 5 + CONTEXT_CARRYOVER_LINGER_MS)).toEqual([]);
  });

  it('drops a finished unread result whose row an authoritative snapshot no longer has', () => {
    let state = startContextCarryover(
      PERSONAL,
      [item('deleted', ACME, { active: true })],
      0,
    );
    state = observeContextCarryover(
      state,
      [item('deleted', ACME, { unread: true })],
      1,
    );
    expect(keys(state, 1)).toEqual([ORG_A]);
    // The chat was deleted: nothing left can clear its unread badge.
    state = observeContextCarryover(state, [], 2);
    expect(keys(state, 2)).toEqual([]);
    expect(state.entries.size).toBe(0);
  });

  it('reconciles each source only against its own authoritative leg', () => {
    const desktop = { active: true, source: 'remote-control' };
    let state = startContextCarryover(
      PERSONAL,
      [
        item('desk-run', ACME, desktop),
        item('desk-done', ACME, { active: true, source: 'remote-control' }),
        item('cloud-run', ACME, { active: true, source: 'cloud' }),
      ],
      0,
    );
    state = observeContextCarryover(
      state,
      [
        item('desk-run', ACME, desktop),
        item('desk-done', ACME, { unread: true, source: 'remote-control' }),
        item('cloud-run', ACME, { active: true, source: 'cloud' }),
      ],
      1,
    );
    // The desktop leg drops: only cloud rows arrive, and only cloud is
    // authoritative. Desktop carryover keeps its state rather than being
    // treated as vanished, and does not expire.
    state = observeContextCarryover(
      state,
      [item('cloud-run', ACME, { active: true, source: 'cloud' })],
      2,
      new Set(['cloud']),
    );
    const later = 2 + CONTEXT_CARRYOVER_LINGER_MS * 2;
    state = observeContextCarryover(
      state,
      [item('cloud-run', ACME, { source: 'cloud' })],
      later,
      new Set(['cloud']),
    );
    const workspaces = contextCarryoverProjection(state, later)[0]?.workspaces;
    expect(
      workspaces?.find((row) => row.workspaceId === 'desk-run-workspace'),
    ).toMatchObject({ running: 1, interrupted: false });
    expect(
      workspaces?.find((row) => row.workspaceId === 'desk-done-workspace'),
    ).toMatchObject({ unread: 1 });
    // The desktop leg returns without the run: now it is interrupted, and
    // the finished result it no longer lists is dropped.
    state = observeContextCarryover(
      state,
      [item('cloud-run', ACME, { source: 'cloud' })],
      later + 1,
      new Set(['cloud', 'remote-control']),
    );
    const back = contextCarryoverProjection(state, later + 1)[0]?.workspaces;
    expect(
      back?.find((row) => row.workspaceId === 'desk-run-workspace'),
    ).toMatchObject({ running: 0, interrupted: true });
    expect(
      back?.find((row) => row.workspaceId === 'desk-done-workspace'),
    ).toBeUndefined();
  });

  it('registers foreign work that starts after the epoch', () => {
    let state = startContextCarryover(PERSONAL, [item('late', ACME)], 0);
    expect(keys(state, 0)).toEqual([]);
    state = observeContextCarryover(
      state,
      [item('late', ACME, { active: true })],
      1,
    );
    expect(keys(state, 1)).toEqual([ORG_A]);
  });

  it('never tracks the selected context, and a new epoch discards old carryover', () => {
    let state = startContextCarryover(
      PERSONAL,
      [item('org', ACME, { active: true })],
      0,
    );
    state = observeContextCarryover(
      state,
      [
        item('org', ACME, { unread: true }),
        item('mine', PERSONAL, { active: true }),
      ],
      1,
    );
    expect(keys(state, 1)).toEqual([ORG_A]);
    // Switching to Acme: its finished unread result is not carried back, and
    // Personal's still-running work is registered for the new epoch.
    state = startContextCarryover(
      ACME,
      [
        item('org', ACME, { unread: true }),
        item('mine', PERSONAL, { active: true }),
      ],
      2,
    );
    expect(keys(state, 2)).toEqual(['personal']);
  });
});

describe('contextActivityItemsFromSnapshot', () => {
  const snapshot: ContextActivitySnapshot = {
    workspaces: [
      { localId: 'personal-ws', name: 'Notes', type: 'single-repo' },
      {
        localId: 'org-ws',
        name: 'Payments',
        type: 'single-repo',
        owner: {
          type: 'organization',
          organizationId: ORG_A,
          projectId: 'project',
        },
      },
      {
        localId: 'cloud-ws',
        name: 'Cloud',
        type: 'cowork',
        backend: 'cloud',
        owner: { type: 'cloud-organization', organizationId: ORG_B },
      },
      {
        localId: 'placeholder',
        name: 'Catalog',
        type: 'single-repo',
        placeholder: { projectId: 'p', state: 'ready-to-set-up' },
        owner: {
          type: 'organization',
          organizationId: ORG_A,
          projectId: 'p',
        },
      },
    ],
    worktrees: [
      {
        localId: 'streaming',
        workspaceLocalId: 'org-ws',
        branch: 'a',
        isStreaming: true,
      },
      { localId: 'busy', workspaceLocalId: 'org-ws', branch: 'b', busy: true },
      {
        localId: 'run',
        workspaceLocalId: 'org-ws',
        branch: 'c',
        isRunningRun: true,
      },
      {
        localId: 'pipeline',
        workspaceLocalId: 'personal-ws',
        branch: 'd',
        pipelineStatus: 'running',
      },
      {
        localId: 'unread',
        workspaceLocalId: 'cloud-ws',
        branch: 'e',
        hasUnread: true,
      },
      { localId: 'orphan', workspaceLocalId: 'missing', branch: 'f' },
    ],
    standaloneChats: [
      {
        localId: 'chat',
        projectLocalId: 'org-ws',
        title: 'Chat',
        hasActiveChat: true,
      },
      { localId: 'loose', projectLocalId: 'unknown', title: 'Loose' },
    ],
  };

  it('maps rows to activity items with the owning workspace context', () => {
    const items = contextActivityItemsFromSnapshot(snapshot);
    const byKey = Object.fromEntries(
      items.map((entry): [string, ContextActivityItem] => [entry.key, entry]),
    );
    expect(Object.keys(byKey).sort()).toEqual(
      [
        'chat:org-ws/chat',
        'worktree:cloud-ws/unread',
        'worktree:org-ws/busy',
        'worktree:org-ws/run',
        'worktree:org-ws/streaming',
        'worktree:personal-ws/pipeline',
      ].sort(),
    );
    expect(byKey['worktree:org-ws/streaming']).toMatchObject({
      source: 'remote-control',
      context: ACME,
      workspaceId: 'org-ws',
      name: 'Payments',
      active: true,
      unread: false,
    });
    expect(byKey['worktree:personal-ws/pipeline']).toMatchObject({
      context: PERSONAL,
      active: true,
    });
    expect(byKey['worktree:cloud-ws/unread']).toMatchObject({
      source: 'cloud',
      context: { kind: 'organization', organizationId: ORG_B },
      active: false,
      unread: true,
    });
    expect(byKey['chat:org-ws/chat']).toMatchObject({
      context: ACME,
      active: true,
    });
  });
});
