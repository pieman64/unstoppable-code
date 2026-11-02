import {
  ForeignActivityLedger,
  type ForeignActivityOperation,
} from '../foreign-activity-ledger';
import type { ExecutionEvent } from '@canopy/desktop-shared/types/pipeline';
import {
  foreignActivitySourceSnapshot,
  resetForeignActivitySources,
  publishForeignChatActivity,
  markForeignPipelineResultsSeen,
  publishForeignPipelineActivity,
  publishForeignPipelineQueueActivity,
  publishForeignScriptActivity,
  subscribeForeignActivitySources,
  type ForeignActivitySourceUpdate,
} from '../foreign-activity-sources';

import type { ScriptTrackingInfo } from '../../lib/script-runner';

let mockTrackedScripts: ScriptTrackingInfo[] = [];
const mockTrackedListeners = new Set<() => void>();
jest.mock('../../lib/script-runner', () => ({
  listTrackedShellScripts: (): ScriptTrackingInfo[] => mockTrackedScripts,
  subscribeTrackedScriptsChanged: (listener: () => void): (() => void) => {
    mockTrackedListeners.add(listener);
    return (): void => {
      mockTrackedListeners.delete(listener);
    };
  },
}));
function trackedSetup(): ScriptTrackingInfo {
  return {
    projectId: 'workspace',
    worktreeId: 'worktree',
    scriptKey: 'setup',
    logRef: {
      projectId: 'workspace',
      worktreeId: 'worktree',
      runId: 'setup-run',
      script: {
        target: 'project',
        lifecycle: 'setup',
        scriptKey: 'setup',
        scriptName: 'Setup',
        label: 'Setup',
        command: 'echo setup',
      },
    },
  };
}
function notifyTrackedScripts(): void {
  mockTrackedListeners.forEach((listener: () => void): void => listener());
}

function pipeline(
  id: string,
  status: ExecutionEvent['state']['status'],
): ExecutionEvent {
  return {
    executionId: id,
    type: status === 'running' ? 'execution.started' : 'execution.completed',
    timestamp: '2026-09-23T12:00:00Z',
    state: {
      version: 10,
      id,
      pipeline_id: 'pipeline',
      pipeline_snapshot: { name: 'Test', scope: ['directory'], jobs: {} },
      status,
      jobs: {},
      job_definitions: {},
      job_groups: {},
      started_at: '2026-09-23T12:00:00Z',
      completed_at: status === 'running' ? undefined : '2026-09-23T12:01:00Z',
      project_id: 'workspace',
      worktree_id: 'worktree',
      cwd: '/not-retained',
      env: {},
      inputs: {},
      status_reasons: [],
      pending_pauses: [],
    },
  };
}

function createLedger(): ForeignActivityLedger {
  const ledger = new ForeignActivityLedger(
    {
      subscribe: (listener): (() => void) =>
        subscribeForeignActivitySources((event): void =>
          listener({
            ...event,
            operation: { ...event.operation, context: { kind: 'personal' } },
          }),
        ),
      snapshot: (): {
        sequence: number;
        operations: ForeignActivityOperation[];
      } => {
        const snapshot = foreignActivitySourceSnapshot();
        return {
          ...snapshot,
          operations: snapshot.operations.map(
            (operation): ForeignActivityOperation => ({
              ...operation,
              context: { kind: 'personal' },
            }),
          ),
        };
      },
    },
    Date.now,
    (): string => 'epoch',
  );
  ledger.switchContext('account', {
    kind: 'organization',
    organizationId: 'org',
  });
  return ledger;
}

describe('foreign activity source adapters', (): void => {
  beforeEach((): void => {
    mockTrackedScripts = [];
    resetForeignActivitySources();
  });

  it('observes automatic setup scripts on tracked changes and settles their exit once', (): void => {
    const listener = jest.fn();
    const unsubscribe = subscribeForeignActivitySources(listener);
    try {
      mockTrackedScripts = [trackedSetup()];
      notifyTrackedScripts();
      expect(foreignActivitySourceSnapshot().operations).toEqual([
        {
          source: 'script',
          workspaceId: 'workspace',
          worktreeId: 'worktree',
          operationId: 'setup-run',
          active: true,
          resultToken: null,
          unreadToken: null,
        },
      ]);
      mockTrackedScripts = [];
      notifyTrackedScripts();
      expect(foreignActivitySourceSnapshot().operations).toEqual([
        {
          source: 'script',
          workspaceId: 'workspace',
          worktreeId: 'worktree',
          operationId: 'setup-run',
          active: false,
          resultToken: 'setup-run:exited',
          unreadToken: null,
        },
      ]);
      notifyTrackedScripts();
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it('settles an active script when it disappears from tracking', (): void => {
    const unsubscribe = subscribeForeignActivitySources(jest.fn());
    try {
      publishForeignScriptActivity({
        workspaceLocalId: 'workspace',
        worktreeLocalId: 'worktree',
        localId: 'setup-run',
        scriptId: 'setup',
        scriptKey: 'setup',
        scriptName: 'Setup',
        name: 'Setup',
        target: 'project',
        status: 'running',
      });
      notifyTrackedScripts();
      expect(foreignActivitySourceSnapshot().operations[0]).toMatchObject({
        active: false,
        resultToken: 'setup-run:exited',
        unreadToken: null,
      });
    } finally {
      unsubscribe();
    }
  });

  it('preserves the richer terminal script result while tracking catches up', (): void => {
    const listener = jest.fn();
    const unsubscribe = subscribeForeignActivitySources(listener);
    try {
      mockTrackedScripts = [trackedSetup()];
      publishForeignScriptActivity({
        workspaceLocalId: 'workspace',
        worktreeLocalId: 'worktree',
        localId: 'setup-run',
        scriptId: 'setup',
        scriptKey: 'setup',
        scriptName: 'Setup',
        name: 'Setup',
        target: 'project',
        status: 'failed',
        exitCode: 7,
      });
      const snapshot = foreignActivitySourceSnapshot();
      notifyTrackedScripts();
      mockTrackedScripts = [];
      notifyTrackedScripts();
      expect(foreignActivitySourceSnapshot()).toEqual(snapshot);
      expect(snapshot.operations[0]?.resultToken).toBe('setup-run:failed:7');
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('ignores hook scripts and scripts without log references', (): void => {
    const unsubscribe = subscribeForeignActivitySources(jest.fn());
    try {
      mockTrackedScripts = [
        { ...trackedSetup(), kind: 'hook' },
        { ...trackedSetup(), logRef: undefined },
      ];
      notifyTrackedScripts();
      expect(foreignActivitySourceSnapshot().operations).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('reconciles running scripts when subscribing, resubscribing and resetting', (): void => {
    mockTrackedScripts = [trackedSetup()];
    let unsubscribe = subscribeForeignActivitySources(jest.fn());
    try {
      expect(foreignActivitySourceSnapshot().operations[0]?.active).toBe(true);
      const second = subscribeForeignActivitySources(jest.fn());
      expect(mockTrackedListeners.size).toBe(1);
      second();
      resetForeignActivitySources();
      expect(foreignActivitySourceSnapshot().operations[0]?.active).toBe(true);
      unsubscribe();
      mockTrackedScripts = [];
      unsubscribe = subscribeForeignActivitySources(jest.fn());
      expect(foreignActivitySourceSnapshot().operations[0]?.resultToken).toBe(
        'setup-run:exited',
      );
    } finally {
      unsubscribe();
    }
  });
  it('suppresses 100 unchanged script chunk projections but publishes status changes', (): void => {
    const events: ForeignActivitySourceUpdate[] = [];
    const unsubscribe = subscribeForeignActivitySources((event): void => {
      events.push(event);
    });
    const sequence = foreignActivitySourceSnapshot().sequence;
    const run = {
      workspaceLocalId: 'workspace',
      worktreeLocalId: 'worktree',
      localId: 'chunks',
      scriptId: 'script',
      scriptKey: 'script',
      scriptName: 'script',
      name: 'Script',
      target: 'project' as const,
      status: 'running',
    };
    try {
      for (let index = 0; index < 100; index += 1)
        publishForeignScriptActivity({ ...run, outputTail: `chunk ${index}` });
      expect(events).toHaveLength(1);
      expect(foreignActivitySourceSnapshot().sequence).toBe(sequence + 1);
      publishForeignScriptActivity({ ...run, status: 'success', exitCode: 0 });
      expect(events).toHaveLength(2);
      expect(events[1]?.operation.active).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it('suppresses chat updates with an unchanged projection', (): void => {
    const input: Parameters<typeof publishForeignChatActivity>[0] = {
      projectId: 'workspace',
      worktreeId: 'worktree',
      tabs: [
        { id: 'chat', title: 'Chat', messages: [], createdAt: '2026-09-23' },
      ],
      runtimeByChatId: {
        chat: {
          status: 'streaming',
          activeTurn: { userMessageId: 'turn', startedAt: 1 },
          queuedMessageIds: [],
        },
      },
      removedTabIds: [],
    };
    const listener = jest.fn();
    const unsubscribe = subscribeForeignActivitySources(listener);
    try {
      publishForeignChatActivity(input);
      const sequence = foreignActivitySourceSnapshot().sequence;
      publishForeignChatActivity({
        ...input,
        tabs: input.tabs.map((tab) => ({ ...tab, title: 'Renamed' })),
      });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(foreignActivitySourceSnapshot().sequence).toBe(sequence);
    } finally {
      unsubscribe();
    }
  });

  it('publishes the first queued turn without an active turn', (): void => {
    publishForeignChatActivity({
      projectId: 'queued-workspace',
      worktreeId: 'worktree',
      tabs: [
        {
          id: 'queued-chat',
          title: 'Chat',
          messages: [],
          createdAt: '2026-09-23',
        },
      ],
      runtimeByChatId: {
        'queued-chat': { status: 'queued', queuedMessageIds: ['queued-first'] },
      },
      removedTabIds: [],
    });
    expect(
      foreignActivitySourceSnapshot().operations.find(
        (operation): boolean => operation.chatId === 'queued-chat',
      ),
    ).toMatchObject({ operationId: 'queued-first', active: true });
  });

  it.each(['next-head', 'empty-idle', 'empty-queued'] as const)(
    'removes a cancelled queued turn before publishing %s',
    (next): void => {
      const input: Parameters<typeof publishForeignChatActivity>[0] = {
        projectId: 'workspace',
        worktreeId: 'worktree',
        tabs: [
          { id: 'chat', title: 'Chat', messages: [], createdAt: '2026-09-23' },
        ],
        runtimeByChatId: {
          chat: { status: 'queued', queuedMessageIds: ['X', 'Y'] },
        },
        removedTabIds: [],
      };
      const events: ForeignActivitySourceUpdate[] = [];
      const unsubscribe = subscribeForeignActivitySources((event): void => {
        events.push(event);
      });
      try {
        publishForeignChatActivity(input);
        const original = foreignActivitySourceSnapshot().operations[0];
        input.runtimeByChatId = {
          chat: {
            status: next === 'empty-idle' ? 'idle' : 'queued',
            queuedMessageIds: next === 'next-head' ? ['Y'] : [],
          },
        };
        publishForeignChatActivity(input);
        expect(events[1]).toMatchObject({ operation: original, removed: true });
        expect(
          events.map((event) => [event.operation.operationId, event.removed]),
        ).toEqual(
          next === 'next-head'
            ? [
                ['X', false],
                ['X', true],
                ['Y', false],
              ]
            : [
                ['X', false],
                ['X', true],
              ],
        );
        expect(
          foreignActivitySourceSnapshot().operations.map((operation) => [
            operation.operationId,
            operation.active,
          ]),
        ).toEqual(next === 'next-head' ? [['Y', true]] : []);
      } finally {
        unsubscribe();
      }
    },
  );

  it('retains a dispatched queued turn as a terminal result', (): void => {
    const input: Parameters<typeof publishForeignChatActivity>[0] = {
      projectId: 'workspace',
      worktreeId: 'worktree',
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          messages: [],
          createdAt: '2026-09-23',
          unread: true,
          transcript: {
            format: 'complete-message-jsonl-v1',
            committedMessageCount: 2,
            committedByteLength: 100,
            transcriptRevision: 1,
            hasActiveSidecar: false,
          },
        },
      ],
      runtimeByChatId: { chat: { status: 'queued', queuedMessageIds: ['X'] } },
      removedTabIds: [],
    };
    publishForeignChatActivity(input);
    input.runtimeByChatId = {
      chat: {
        status: 'streaming',
        activeTurn: { userMessageId: 'X', startedAt: 1 },
        queuedMessageIds: [],
      },
    };
    publishForeignChatActivity(input);
    input.runtimeByChatId = { chat: { status: 'idle', queuedMessageIds: [] } };
    publishForeignChatActivity(input);
    expect(foreignActivitySourceSnapshot().operations).toEqual([
      {
        source: 'chat',
        workspaceId: 'workspace',
        worktreeId: 'worktree',
        chatId: 'chat',
        operationId: 'X',
        active: false,
        resultToken: 'X:1',
        unreadToken: 'X:1',
      },
    ]);
  });

  it('keeps consecutive queued turn identities separate from the previous terminal event', (): void => {
    const ledger = createLedger();
    const events: ForeignActivitySourceUpdate[] = [];
    const unsubscribe = subscribeForeignActivitySources((event): void => {
      events.push(event);
    });
    const input = {
      projectId: 'queued-workspace',
      worktreeId: 'worktree',
      tabs: [
        {
          id: 'consecutive-chat',
          title: 'Chat',
          messages: [],
          createdAt: '2026-09-23',
        },
      ],
      removedTabIds: [],
    };
    try {
      publishForeignChatActivity({
        ...input,
        runtimeByChatId: {
          'consecutive-chat': {
            status: 'streaming',
            activeTurn: { userMessageId: 'turn-one', startedAt: 1 },
            queuedMessageIds: [],
          },
        },
      });
      publishForeignChatActivity({
        ...input,
        runtimeByChatId: {
          'consecutive-chat': { status: 'idle', queuedMessageIds: [] },
        },
      });
      publishForeignChatActivity({
        ...input,
        runtimeByChatId: {
          'consecutive-chat': {
            status: 'queued',
            queuedMessageIds: ['turn-two'],
          },
        },
      });
      publishForeignChatActivity({
        ...input,
        runtimeByChatId: {
          'consecutive-chat': {
            status: 'streaming',
            activeTurn: { userMessageId: 'turn-two', startedAt: 2 },
            queuedMessageIds: [],
          },
        },
      });
      publishForeignChatActivity({
        ...input,
        runtimeByChatId: {
          'consecutive-chat': { status: 'idle', queuedMessageIds: [] },
        },
      });
      publishForeignChatActivity({
        ...input,
        runtimeByChatId: {
          'consecutive-chat': {
            status: 'queued',
            queuedMessageIds: ['turn-three'],
          },
        },
      });
      expect(
        events.map((event): [string, boolean] => [
          event.operation.operationId,
          event.operation.active,
        ]),
      ).toEqual([
        ['turn-one', true],
        ['turn-one', false],
        ['turn-two', true],
        ['turn-two', false],
        ['turn-three', true],
      ]);
      expect(
        ledger
          .entries()
          .filter(
            (entry): boolean => entry.operation.chatId === 'consecutive-chat',
          )
          .map((entry): [string, string] => [
            entry.operation.operationId,
            entry.state,
          ]),
      ).toEqual([
        ['turn-one', 'FOREIGN_COMPLETED_LINGER'],
        ['turn-two', 'FOREIGN_COMPLETED_LINGER'],
        ['turn-three', 'FOREIGN_ACTIVE'],
      ]);
    } finally {
      unsubscribe();
      ledger.dispose();
    }
  });

  it.each(['read', 'remove'] as const)(
    'clears earlier unread chat turns on tab %s after a later turn starts',
    (action): void => {
      const ledger = createLedger();
      const input: Parameters<typeof publishForeignChatActivity>[0] = {
        projectId: 'workspace',
        worktreeId: 'worktree',
        tabs: [
          { id: 'chat', title: 'Chat', messages: [], createdAt: '2026-09-23' },
        ],
        runtimeByChatId: {
          chat: {
            status: 'streaming',
            activeTurn: { userMessageId: 'turn-one', startedAt: 1 },
            queuedMessageIds: [],
          },
        },
        removedTabIds: [],
      };
      try {
        publishForeignChatActivity(input);
        input.tabs = input.tabs.map((tab): typeof tab => ({
          ...tab,
          unread: true,
          transcript: {
            format: 'complete-message-jsonl-v1',
            committedMessageCount: 2,
            committedByteLength: 100,
            transcriptRevision: 1,
            hasActiveSidecar: false,
          },
        }));
        input.runtimeByChatId = {
          chat: { status: 'idle', queuedMessageIds: [] },
        };
        publishForeignChatActivity(input);
        expect(ledger.entries()[0]?.state).toBe('FOREIGN_COMPLETED_UNREAD');
        input.runtimeByChatId = {
          chat: {
            status: 'streaming',
            activeTurn: { userMessageId: 'turn-two', startedAt: 2 },
            queuedMessageIds: [],
          },
        };
        publishForeignChatActivity(input);
        expect(ledger.entries()).toHaveLength(2);
        if (action === 'read') {
          input.tabs = input.tabs.map((tab): typeof tab => ({
            ...tab,
            unread: false,
          }));
        } else {
          input.tabs = [];
          input.removedTabIds = ['chat'];
        }
        publishForeignChatActivity(input);
        expect(
          ledger.entries().map((entry): string => entry.operation.operationId),
        ).toEqual(action === 'read' ? ['turn-two'] : []);
        expect(foreignActivitySourceSnapshot().operations).toHaveLength(
          action === 'read' ? 2 : 0,
        );
        const sequence = foreignActivitySourceSnapshot().sequence;
        publishForeignChatActivity(input);
        expect(foreignActivitySourceSnapshot().sequence).toBe(sequence);
      } finally {
        ledger.dispose();
      }
    },
  );

  it('bounds terminal turns of one chat while retaining its active turn', (): void => {
    const input: Parameters<typeof publishForeignChatActivity>[0] = {
      projectId: 'workspace',
      worktreeId: 'worktree',
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          messages: [],
          createdAt: '2026-09-23',
          unread: true,
        },
      ],
      runtimeByChatId: {},
      removedTabIds: [],
    };
    for (let index = 0; index <= 600; index += 1) {
      input.runtimeByChatId = {
        chat: {
          status: 'streaming',
          activeTurn: { userMessageId: `turn-${index}`, startedAt: index },
          queuedMessageIds: [],
        },
      };
      publishForeignChatActivity(input);
      if (index < 600) {
        input.runtimeByChatId = {
          chat: { status: 'idle', queuedMessageIds: [] },
        };
        publishForeignChatActivity(input);
      }
    }
    const snapshot = foreignActivitySourceSnapshot();
    expect(
      snapshot.operations.filter((operation): boolean => !operation.active),
    ).toHaveLength(500);
    expect(
      snapshot.operations.filter((operation): boolean => operation.active),
    ).toEqual([expect.objectContaining({ operationId: 'turn-600' })]);
    expect(
      snapshot.operations.some(
        (operation): boolean => operation.operationId === 'turn-0',
      ),
    ).toBe(false);
  });

  it('bounds terminal tombstones to 500 while retaining every active operation', (): void => {
    for (let index = 0; index < 510; index += 1)
      publishForeignPipelineActivity(
        pipeline(`bounded-active-${index}`, 'running'),
      );
    for (let index = 0; index < 600; index += 1)
      publishForeignPipelineActivity(
        pipeline(`bounded-terminal-${index}`, 'success'),
      );
    const snapshot = foreignActivitySourceSnapshot();
    expect(
      snapshot.operations.filter((operation): boolean => !operation.active)
        .length,
    ).toBeLessThanOrEqual(500);
    expect(
      snapshot.operations.filter((operation): boolean =>
        operation.operationId.startsWith('bounded-active-'),
      ),
    ).toHaveLength(510);
    expect(
      snapshot.operations.some(
        (operation): boolean => operation.operationId === 'bounded-terminal-0',
      ),
    ).toBe(false);
  });

  it('publishes an ordered removal for the oldest of 501 terminal operations', (): void => {
    const events: ForeignActivitySourceUpdate[] = [];
    const unsubscribe = subscribeForeignActivitySources((event): void => {
      events.push(event);
    });
    try {
      for (let index = 0; index < 501; index += 1)
        publishForeignPipelineActivity(
          pipeline(`eviction-${index}`, 'success'),
        );
      const removals = events.filter(
        (event): boolean => event.removed === true,
      );
      expect(removals).toHaveLength(1);
      expect(removals[0]?.operation).toEqual(events[0]?.operation);
      expect(removals[0]?.operation.operationId).toBe('eviction-0');
      expect(
        events.every(
          (event, index): boolean =>
            index === 0 || event.sequence > (events[index - 1]?.sequence ?? 0),
        ),
      ).toBe(true);
      expect(foreignActivitySourceSnapshot().operations).toHaveLength(500);
    } finally {
      unsubscribe();
    }
  });

  it('drops carried unread from the ledger when its terminal source is evicted', (): void => {
    const ledger = createLedger();
    try {
      publishForeignPipelineActivity(pipeline('evicted-unread', 'running'));
      publishForeignPipelineActivity(pipeline('evicted-unread', 'success'));
      // Terminal-only observations never enter the ledger, so its own 200-entry
      // bound cannot mask a missing source eviction notification.
      for (let index = 0; index < 499; index += 1)
        publishForeignPipelineActivity(
          pipeline(`eviction-${index}`, 'success'),
        );
      expect(ledger.entries()).toHaveLength(1);
      expect(ledger.entries()[0]?.state).toBe('FOREIGN_COMPLETED_UNREAD');
      publishForeignPipelineActivity(pipeline('eviction-499', 'success'));
      expect(ledger.entries()).toEqual([]);
    } finally {
      ledger.dispose();
    }
  });

  it('does not resurrect carried unread when an evicted terminal event repeats', (): void => {
    const ledger = createLedger();
    try {
      publishForeignPipelineActivity(pipeline('evicted-seen', 'running'));
      publishForeignPipelineActivity(pipeline('evicted-seen', 'success'));
      markForeignPipelineResultsSeen('workspace', 'worktree', ['evicted-seen']);
      for (let index = 0; index < 600; index += 1)
        publishForeignPipelineActivity(
          pipeline(`eviction-${index}`, 'success'),
        );
      publishForeignPipelineActivity(pipeline('evicted-seen', 'success'));
      expect(
        ledger
          .entries()
          .some(
            (entry): boolean => entry.operation.operationId === 'evicted-seen',
          ),
      ).toBe(false);
    } finally {
      ledger.dispose();
    }
  });

  it('does not resurrect read attention when a terminal pipeline event repeats', (): void => {
    publishForeignPipelineActivity(pipeline('read-pipeline', 'success'));
    markForeignPipelineResultsSeen('workspace', 'worktree', ['read-pipeline']);
    publishForeignPipelineActivity(pipeline('read-pipeline', 'success'));
    expect(
      foreignActivitySourceSnapshot().operations.find(
        (operation) => operation.operationId === 'read-pipeline',
      )?.unreadToken,
    ).toBeNull();
  });
  it.each(['cancelled', 'failed'] as const)(
    'tracks queued pipelines by reserved execution id through %s',
    (type): void => {
      const ledger = createLedger();
      const identity = {
        executionId: 'reserved-run',
        projectId: 'workspace',
        worktreeId: 'worktree',
      };
      try {
        publishForeignPipelineQueueActivity({ ...identity, type: 'queued' });
        expect(ledger.entries()).toMatchObject([
          {
            state: 'FOREIGN_ACTIVE',
            operation: {
              operationId: 'reserved-run',
              active: true,
              resultToken: null,
            },
          },
        ]);
        publishForeignPipelineQueueActivity({ ...identity, type });
        expect(ledger.entries()).toMatchObject([
          {
            state: 'FOREIGN_COMPLETED_UNREAD',
            operation: {
              active: false,
              resultToken: `reserved-run:${type}`,
              unreadToken: `reserved-run:${type}`,
            },
          },
        ]);
      } finally {
        ledger.dispose();
      }
    },
  );

  it('continues the queued operation when execution starts and ignores late admission', (): void => {
    const identity = {
      executionId: 'reserved-run',
      projectId: 'workspace',
      worktreeId: 'worktree',
    };
    publishForeignPipelineQueueActivity({ ...identity, type: 'queued' });
    const sequence = foreignActivitySourceSnapshot().sequence;
    publishForeignPipelineActivity(pipeline('reserved-run', 'running'));
    publishForeignPipelineQueueActivity({ ...identity, type: 'started' });
    expect(foreignActivitySourceSnapshot()).toMatchObject({
      sequence,
      operations: [
        expect.objectContaining({ operationId: 'reserved-run', active: true }),
      ],
    });
    publishForeignPipelineActivity(pipeline('reserved-run', 'success'));
    publishForeignPipelineQueueActivity({ ...identity, type: 'started' });
    expect(foreignActivitySourceSnapshot().operations).toEqual([
      expect.objectContaining({ operationId: 'reserved-run', active: false }),
    ]);
  });

  it('publishes removal for a queued pipeline', (): void => {
    const identity = {
      executionId: 'reserved-run',
      projectId: 'workspace',
      worktreeId: 'worktree',
    };
    const events: ForeignActivitySourceUpdate[] = [];
    const unsubscribe = subscribeForeignActivitySources((event): void => {
      events.push(event);
    });
    try {
      publishForeignPipelineQueueActivity({ ...identity, type: 'queued' });
      publishForeignPipelineQueueActivity({ ...identity, type: 'removed' });
      expect(foreignActivitySourceSnapshot().operations).toEqual([]);
      expect(events[1]).toMatchObject({
        removed: true,
        operation: { operationId: 'reserved-run' },
      });
    } finally {
      unsubscribe();
    }
  });

  it('captures pipeline identity and new completion tokens without content', (): void => {
    publishForeignPipelineActivity(pipeline('new-pipeline', 'running'));
    expect(
      foreignActivitySourceSnapshot().operations.find(
        (operation) => operation.operationId === 'new-pipeline',
      ),
    ).toMatchObject({ active: true, resultToken: null });
    publishForeignPipelineActivity(pipeline('new-pipeline', 'success'));
    const operation = foreignActivitySourceSnapshot().operations.find(
      (candidate) => candidate.operationId === 'new-pipeline',
    );
    expect(operation?.unreadToken).toBe(operation?.resultToken);
    expect(JSON.stringify(operation)).not.toContain('/not-retained');
  });
  it('tracks script run identities without treating script output as unread', (): void => {
    const run = {
      workspaceLocalId: 'workspace',
      worktreeLocalId: 'worktree',
      localId: 'script-run',
      scriptId: 'launch',
      scriptKey: 'launch',
      scriptName: 'launch',
      name: 'Private script name',
      target: 'project' as const,
      status: 'running',
      outputTail: 'Private output',
    };
    publishForeignScriptActivity(run);
    publishForeignScriptActivity({ ...run, status: 'success', exitCode: 0 });
    const operation = foreignActivitySourceSnapshot().operations.find(
      (candidate) => candidate.operationId === 'script-run',
    );
    expect(operation).toMatchObject({ active: false, unreadToken: null });
    expect(JSON.stringify(operation)).not.toContain('Private');
  });
  it('delivers monotonic sequences and removes subscriptions', (): void => {
    const sequences: number[] = [];
    const unsubscribe = subscribeForeignActivitySources((event): void => {
      sequences.push(event.sequence);
    });
    publishForeignPipelineActivity(pipeline('sequence', 'running'));
    publishForeignPipelineActivity(pipeline('sequence', 'success'));
    unsubscribe();
    publishForeignPipelineActivity(pipeline('sequence', 'success'));
    expect(sequences).toHaveLength(2);
    expect(sequences[1]).toBe((sequences[0] ?? 0) + 1);
  });
});
