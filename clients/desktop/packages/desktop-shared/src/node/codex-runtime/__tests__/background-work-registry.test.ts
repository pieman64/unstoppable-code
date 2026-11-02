import {
  createCodexBackgroundWorkRegistry,
  encodeCodexBackgroundWorkId,
  readAllCodexBackgroundTerminalPages,
  type CodexBackgroundReconciliationToken,
  type CodexBackgroundTerminalRecord,
} from '../background-work-registry';

function createRegistry(
  rootThreadId = 'root-thread',
): ReturnType<typeof createCodexBackgroundWorkRegistry> {
  return createCodexBackgroundWorkRegistry({
    rootThreadId: () => rootThreadId,
    newEpoch: () => 'epoch-1',
  });
}

function childStarted(
  threadId: string,
  parentThreadId = 'root-thread',
): Record<string, unknown> {
  return {
    thread: {
      id: threadId,
      parentThreadId,
      status: { type: 'active', activeFlags: [] },
      cwd: '/private/worktree',
      path: '/private/rollout.jsonl',
      preview: 'private child prompt',
    },
  };
}

function commandStarted(
  threadId: string,
  itemId: string,
  processId: string,
): Record<string, unknown> {
  return {
    threadId,
    turnId: 'turn-1',
    item: {
      type: 'commandExecution',
      id: itemId,
      processId,
      status: 'inProgress',
      command: 'private command text',
      cwd: '/private/worktree',
      osPid: 8102,
      cpuPercent: 98.5,
      rssKb: 42n,
    },
  };
}

describe('Codex native background work registry', () => {
  it('encodes identity tuples without delimiter collisions', () => {
    expect(encodeCodexBackgroundWorkId(['child', 'a:b'])).not.toBe(
      encodeCodexBackgroundWorkId(['child:a', 'b']),
    );
    expect(encodeCodexBackgroundWorkId(['terminal', 'a', 'b', 'c'])).toBe(
      JSON.stringify(['terminal', 'a', 'b', 'c']),
    );
  });

  it('tracks child threads, preserves unknown status, and retires only on its own idle', () => {
    const registry = createRegistry();
    registry.observe('thread/started', childStarted('child-thread'));

    expect(registry.snapshot().work).toEqual([
      {
        kind: 'child',
        id: encodeCodexBackgroundWorkId(['child', 'child-thread']),
        threadId: 'child-thread',
        parentThreadId: 'root-thread',
      },
    ]);

    registry.observe('thread/status/changed', {
      threadId: 'child-thread',
      status: { type: 'futureStatus', details: 'unrecognized' },
    });
    expect(registry.hasLiveWork()).toBe(true);

    registry.observe('thread/status/changed', {
      threadId: 'root-thread',
      status: { type: 'idle' },
    });
    expect(registry.hasLiveWork()).toBe(true);

    registry.observe('thread/status/changed', {
      threadId: 'child-thread',
      status: { type: 'idle' },
    });
    expect(registry.snapshot().work).toEqual([]);
  });

  it('reads parent lineage from real source.subAgent and source.subagent shapes', () => {
    const registry = createRegistry();
    const sources: Array<{ source: Record<string, unknown>; parent: string }> =
      [
        {
          source: {
            subAgent: { thread_spawn: { parent_thread_id: 'root-thread' } },
          },
          parent: 'root-thread',
        },
        {
          source: { subAgent: { parentThreadId: 'root-thread' } },
          parent: 'root-thread',
        },
        {
          source: {
            subagent: { threadSpawn: { parentThreadId: 'root-thread' } },
          },
          parent: 'root-thread',
        },
        {
          source: { subagent: { parent_thread_id: 'root-thread' } },
          parent: 'root-thread',
        },
      ];

    for (let index = 0; index < sources.length; index += 1) {
      const sourceEntry = sources[index];
      if (!sourceEntry) {
        continue;
      }
      const threadId = `source-child-${index}`;
      registry.observe('thread/started', {
        thread: {
          id: threadId,
          status: { type: 'active', activeFlags: [] },
          source: sourceEntry.source,
        },
      });
    }

    expect(registry.snapshot().work).toEqual(
      sources.map(({ parent }, index) => ({
        kind: 'child',
        id: encodeCodexBackgroundWorkId(['child', `source-child-${index}`]),
        threadId: `source-child-${index}`,
        parentThreadId: parent,
      })),
    );
  });

  it('tracks only root-thread descendants and revives a known child on active status', () => {
    const registry = createRegistry();
    registry.observe('thread/started', {
      thread: {
        id: 'child-thread',
        source: {
          subAgent: { thread_spawn: { parent_thread_id: 'root-thread' } },
        },
        status: { type: 'active' },
      },
    });
    registry.observe('thread/started', {
      thread: {
        id: 'grandchild-thread',
        source: { subagent: { parentThreadId: 'child-thread' } },
        status: { type: 'active' },
      },
    });
    registry.observe('thread/started', {
      thread: {
        id: 'unrelated-thread',
        source: { subAgent: { parentThreadId: 'unrelated-root' } },
        status: { type: 'active' },
      },
    });

    expect(registry.snapshot().work.map((work) => work.threadId)).toEqual([
      'child-thread',
      'grandchild-thread',
    ]);

    registry.observe('thread/status/changed', {
      threadId: 'child-thread',
      status: { type: 'idle' },
    });
    expect(registry.snapshot().work.map((work) => work.threadId)).toEqual([
      'grandchild-thread',
    ]);

    registry.observe('thread/status/changed', {
      threadId: 'child-thread',
      status: { type: 'active' },
    });
    expect(registry.snapshot().work.map((work) => work.threadId)).toEqual([
      'child-thread',
      'grandchild-thread',
    ]);
  });

  it('uses latest child-turn completion and never lets root turns settle a child', () => {
    const registry = createRegistry();
    registry.observe('thread/started', childStarted('child-thread'));
    registry.observe('turn/started', {
      threadId: 'child-thread',
      turn: { id: 'child-turn-1' },
    });
    registry.observe('turn/started', {
      threadId: 'child-thread',
      turn: { id: 'child-turn-2' },
    });

    registry.observe('turn/completed', {
      threadId: 'child-thread',
      turn: { id: 'child-turn-1', status: 'completed' },
    });
    expect(registry.snapshot().work).toEqual([
      expect.objectContaining({ kind: 'child', turnId: 'child-turn-2' }),
    ]);

    registry.observe('turn/completed', {
      threadId: 'root-thread',
      turn: { id: 'root-turn', status: 'completed' },
    });
    expect(registry.hasLiveWork()).toBe(true);

    registry.observe('turn/completed', {
      threadId: 'child-thread',
      turn: { id: 'child-turn-2', status: 'completed' },
    });
    expect(registry.snapshot().work).toEqual([]);
  });

  it('finishes a child on its turn completion when turn/started was not observed', () => {
    const registry = createRegistry();
    registry.observe('item/started', {
      threadId: 'root-thread',
      turnId: 'parent-turn',
      item: {
        type: 'collabAgentToolCall',
        id: 'spawn-item',
        tool: 'spawnAgent',
        receiverThreadIds: ['child-thread'],
      },
    });

    registry.observe('turn/completed', {
      threadId: 'child-thread',
      turn: { id: 'unobserved-child-turn', status: 'completed' },
    });

    expect(registry.snapshot().work).toEqual([]);
  });

  it('keeps an early child idle observation when a later spawn item registers it', () => {
    const registry = createRegistry();
    registry.observe('thread/status/changed', {
      threadId: 'child-before-spawn',
      status: { type: 'idle' },
    });
    registry.observe('item/started', {
      threadId: 'root-thread',
      turnId: 'parent-turn',
      item: {
        type: 'subAgentActivity',
        id: 'spawn-item',
        kind: 'started',
        agentThreadId: 'child-before-spawn',
      },
    });

    expect(registry.snapshot().work).toEqual([]);

    registry.observe('thread/status/changed', {
      threadId: 'child-before-spawn',
      status: { type: 'active' },
    });
    expect(registry.snapshot().work).toEqual([
      expect.objectContaining({
        kind: 'child',
        threadId: 'child-before-spawn',
      }),
    ]);
  });

  it('keeps an early child turn completion when a later spawn item registers it', () => {
    const registry = createRegistry();
    registry.observe('turn/completed', {
      threadId: 'child-before-spawn',
      turn: { id: 'child-turn', status: 'completed' },
    });
    registry.observe('item/started', {
      threadId: 'root-thread',
      turnId: 'parent-turn',
      item: {
        type: 'collabAgentToolCall',
        id: 'spawn-item',
        tool: 'spawnAgent',
        receiverThreadIds: ['child-before-spawn'],
      },
    });

    expect(registry.snapshot().work).toEqual([]);
  });

  it('keeps an early completed subagent activity ended when its spawn is registered later', () => {
    const registry = createRegistry();
    registry.observe('item/completed', {
      threadId: 'root-thread',
      turnId: 'parent-turn',
      item: {
        type: 'subAgentActivity',
        id: 'activity-item',
        kind: 'completed',
        agentThreadId: 'child-before-spawn',
      },
    });
    registry.observe('item/started', {
      threadId: 'root-thread',
      turnId: 'parent-turn',
      item: {
        type: 'subAgentActivity',
        id: 'activity-item',
        kind: 'started',
        agentThreadId: 'child-before-spawn',
      },
    });

    expect(registry.snapshot().work).toEqual([]);
  });

  it('tracks child-spawn evidence from subagent activity and collab spawn calls', () => {
    const registry = createRegistry();
    registry.observe('item/started', {
      threadId: 'root-thread',
      turnId: 'parent-turn',
      item: {
        type: 'subAgentActivity',
        id: 'activity-item',
        kind: 'started',
        agentThreadId: 'activity-child',
        agentPath: '/private/agent/path',
      },
    });
    registry.observe('item/started', {
      threadId: 'root-thread',
      turnId: 'parent-turn',
      item: {
        type: 'collabAgentToolCall',
        id: 'spawn-item',
        tool: 'spawnAgent',
        status: 'inProgress',
        receiverThreadIds: ['spawned-child'],
        prompt: 'private prompt text',
      },
    });

    expect(registry.snapshot().work).toEqual([
      {
        kind: 'child',
        id: encodeCodexBackgroundWorkId(['child', 'activity-child']),
        threadId: 'activity-child',
        parentThreadId: 'root-thread',
        spawnedByTurnId: 'parent-turn',
      },
      {
        kind: 'child',
        id: encodeCodexBackgroundWorkId(['child', 'spawned-child']),
        threadId: 'spawned-child',
        parentThreadId: 'root-thread',
        spawnedByTurnId: 'parent-turn',
        toolUseId: 'spawn-item',
      },
    ]);
  });

  it('observes completed collab spawn metadata and keeps completed subagent activity ended', () => {
    const registry = createRegistry();
    registry.observe('item/completed', {
      threadId: 'root-thread',
      turnId: 'parent-turn',
      item: {
        type: 'collabAgentToolCall',
        id: 'completed-spawn-item',
        tool: 'spawnAgent',
        status: 'completed',
        receiverThreadIds: ['collab-child'],
      },
    });
    registry.observe('item/completed', {
      threadId: 'root-thread',
      turnId: 'parent-turn',
      item: {
        type: 'subAgentActivity',
        id: 'completed-activity-item',
        kind: 'completed',
        agentThreadId: 'activity-child',
      },
    });

    expect(registry.snapshot().work).toEqual([
      expect.objectContaining({
        kind: 'child',
        threadId: 'collab-child',
        spawnedByTurnId: 'parent-turn',
        toolUseId: 'completed-spawn-item',
      }),
    ]);

    registry.observe('thread/status/changed', {
      threadId: 'activity-child',
      status: { type: 'idle' },
    });
    registry.observe('thread/status/changed', {
      threadId: 'collab-child',
      status: { type: 'idle' },
    });
    registry.observe('item/completed', {
      threadId: 'root-thread',
      turnId: 'parent-turn',
      item: {
        type: 'collabAgentToolCall',
        id: 'completed-spawn-item',
        tool: 'spawnAgent',
        status: 'completed',
        receiverThreadIds: ['collab-child'],
      },
    });
    registry.observe('item/completed', {
      threadId: 'root-thread',
      turnId: 'parent-turn',
      item: {
        type: 'subAgentActivity',
        id: 'completed-activity-item',
        kind: 'completed',
        agentThreadId: 'activity-child',
      },
    });

    expect(registry.snapshot().work).toEqual([]);
  });

  it('tracks terminals without leaking command, path, process metrics, or bigint fields', () => {
    const registry = createRegistry();
    registry.observe(
      'item/started',
      commandStarted('root-thread', 'item-1', 'process-1'),
    );

    const snapshot = registry.snapshot();
    expect(snapshot.work).toEqual([
      {
        kind: 'terminal',
        id: encodeCodexBackgroundWorkId([
          'terminal',
          'root-thread',
          'item-1',
          'process-1',
        ]),
        threadId: 'root-thread',
        itemId: 'item-1',
        processId: 'process-1',
        spawnedByTurnId: 'turn-1',
        foreground: true,
      },
    ]);
    expect(() => JSON.stringify(snapshot)).not.toThrow();
    expect(JSON.stringify(snapshot)).not.toContain('private command text');
    expect(JSON.stringify(snapshot)).not.toContain('/private/worktree');
    expect(JSON.stringify(snapshot)).not.toContain('8102');
    expect(JSON.stringify(snapshot)).not.toContain('rssKb');
  });

  it('marks a running command foreground until the turn that started it completes', () => {
    // Codex gives every command a processId at start, so a running command is
    // not background work while its own turn still waits on it.
    const registry = createRegistry();
    registry.observe(
      'item/started',
      commandStarted('root-thread', 'item-1', 'process-1'),
    );
    expect(registry.snapshot().work).toEqual([
      expect.objectContaining({ itemId: 'item-1', foreground: true }),
    ]);
    expect(registry.hasLiveWork()).toBe(true);

    const before = registry.snapshot().revision;
    registry.observe('turn/completed', {
      threadId: 'root-thread',
      turn: { id: 'other-turn', status: 'completed' },
    });
    expect(registry.snapshot().revision).toBe(before);
    expect(registry.snapshot().work[0]).toHaveProperty('foreground', true);

    registry.observe('turn/completed', {
      threadId: 'root-thread',
      turn: { id: 'turn-1', status: 'completed' },
    });
    expect(registry.snapshot().revision).toBe(before + 1);
    expect(registry.snapshot().work).toEqual([
      expect.not.objectContaining({ foreground: true }),
    ]);

    // A late start for an already-completed turn is background on arrival.
    registry.observe(
      'item/started',
      commandStarted('root-thread', 'item-2', 'process-2'),
    );
    expect(
      registry
        .snapshot()
        .work.find(
          (work) => work.kind === 'terminal' && work.itemId === 'item-2',
        ),
    ).not.toHaveProperty('foreground');
  });

  it('treats a listed terminal as background even when its start was foreground', () => {
    const registry = createRegistry();
    registry.observe(
      'item/started',
      commandStarted('root-thread', 'item-1', 'process-1'),
    );
    const token = registry.beginReconciliation('root-thread');
    registry.commitTerminalPages(token, [
      { threadId: 'root-thread', itemId: 'item-1', processId: 'process-1' },
    ]);

    expect(registry.snapshot().work).toEqual([
      expect.not.objectContaining({ foreground: true }),
    ]);
  });

  it('preserves the originating turn when a listed terminal follows a null-process command start', () => {
    const registry = createRegistry();
    registry.observe('item/started', {
      threadId: 'root-thread',
      turnId: 'originating-turn',
      item: {
        type: 'commandExecution',
        id: 'listed-command',
        processId: null,
        status: 'inProgress',
      },
    });
    const token = registry.beginReconciliation('root-thread');

    registry.commitTerminalPages(token, [
      {
        threadId: 'root-thread',
        itemId: 'listed-command',
        processId: 'listed-process',
      },
    ]);

    expect(registry.snapshot().work).toEqual([
      expect.objectContaining({
        kind: 'terminal',
        itemId: 'listed-command',
        processId: 'listed-process',
        spawnedByTurnId: 'originating-turn',
      }),
    ]);
  });

  it('clears pending child lifecycle and command turn evidence on epoch retirement', () => {
    const registry = createRegistry();
    registry.observe('thread/status/changed', {
      threadId: 'child-before-retire',
      status: { type: 'idle' },
    });
    registry.observe('item/started', {
      threadId: 'root-thread',
      turnId: 'turn-before-retire',
      item: {
        type: 'commandExecution',
        id: 'command-before-retire',
        processId: null,
        status: 'inProgress',
      },
    });
    registry.retireEpoch();

    registry.observe('item/started', {
      threadId: 'root-thread',
      turnId: 'parent-turn',
      item: {
        type: 'subAgentActivity',
        id: 'spawn-item',
        kind: 'started',
        agentThreadId: 'child-before-retire',
      },
    });
    const token = registry.beginReconciliation('root-thread');
    registry.commitTerminalPages(token, [
      {
        threadId: 'root-thread',
        itemId: 'command-before-retire',
        processId: 'listed-process',
      },
    ]);

    expect(registry.snapshot().work).toEqual([
      expect.objectContaining({
        kind: 'child',
        threadId: 'child-before-retire',
      }),
      expect.objectContaining({
        kind: 'terminal',
        itemId: 'command-before-retire',
        processId: 'listed-process',
      }),
    ]);
    expect(registry.snapshot().work[1]).not.toHaveProperty('spawnedByTurnId');
  });

  it('evicts least-recently-seen child and command item memories at their bounds', () => {
    const childRegistry = createRegistry();
    for (let index = 0; index < 256; index += 1) {
      childRegistry.observe('thread/status/changed', {
        threadId: `child-${index}`,
        status: { type: 'idle' },
      });
    }
    childRegistry.observe('thread/status/changed', {
      threadId: 'child-0',
      status: { type: 'idle' },
    });
    childRegistry.observe('thread/status/changed', {
      threadId: 'child-256',
      status: { type: 'idle' },
    });
    for (const childThreadId of ['child-1', 'child-0']) {
      childRegistry.observe('item/started', {
        threadId: 'root-thread',
        turnId: 'parent-turn',
        item: {
          type: 'subAgentActivity',
          id: `spawn-${childThreadId}`,
          kind: 'started',
          agentThreadId: childThreadId,
        },
      });
    }
    expect(childRegistry.snapshot().work).toEqual([
      expect.objectContaining({ kind: 'child', threadId: 'child-1' }),
    ]);

    const commandRegistry = createRegistry();
    const observeNullProcessCommand = (index: number): void => {
      commandRegistry.observe('item/started', {
        threadId: 'root-thread',
        turnId: `turn-${index}`,
        item: {
          type: 'commandExecution',
          id: `command-${index}`,
          processId: null,
          status: 'inProgress',
        },
      });
    };
    for (let index = 0; index < 4_096; index += 1) {
      observeNullProcessCommand(index);
    }
    observeNullProcessCommand(0);
    observeNullProcessCommand(4_096);
    const token = commandRegistry.beginReconciliation('root-thread');
    commandRegistry.commitTerminalPages(token, [
      {
        threadId: 'root-thread',
        itemId: 'command-0',
        processId: 'process-0',
      },
      {
        threadId: 'root-thread',
        itemId: 'command-1',
        processId: 'process-1',
      },
      {
        threadId: 'root-thread',
        itemId: 'command-4096',
        processId: 'process-4096',
      },
    ]);

    expect(commandRegistry.snapshot().work).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'command-0',
          spawnedByTurnId: 'turn-0',
        }),
        expect.objectContaining({ itemId: 'command-1' }),
        expect.objectContaining({
          itemId: 'command-4096',
          spawnedByTurnId: 'turn-4096',
        }),
      ]),
    );
    const evictedCommand = commandRegistry
      .snapshot()
      .work.find(
        (work) => work.kind === 'terminal' && work.itemId === 'command-1',
      );
    expect(evictedCommand).not.toHaveProperty('spawnedByTurnId');
  });

  it('removes completed terminals by thread and item identity', () => {
    const registry = createRegistry();
    registry.observe(
      'item/started',
      commandStarted('root-thread', 'item-1', 'process-1'),
    );
    registry.observe('item/completed', {
      threadId: 'root-thread',
      turnId: 'turn-1',
      item: { type: 'commandExecution', id: 'item-1', status: 'completed' },
    });

    expect(registry.hasLiveWork()).toBe(false);
  });

  it('does not replay a stale terminal start rejected during reconciliation', () => {
    const registry = createRegistry();
    registry.observe('item/completed', {
      threadId: 'root-thread',
      item: { type: 'commandExecution', id: 'item-1', status: 'completed' },
    });
    const token = registry.beginReconciliation('root-thread');
    registry.observe(
      'item/started',
      commandStarted('root-thread', 'item-1', 'process-1'),
    );
    expect(registry.snapshot().work).toEqual([]);

    registry.commitTerminalPages(token, []);

    expect(registry.snapshot().work).toEqual([]);
    expect(registry.hasLiveWork()).toBe(false);
  });

  it('keeps live work while any reconciliation is active and replaces only that thread', () => {
    const registry = createRegistry();
    registry.observe(
      'item/started',
      commandStarted('thread-a', 'known', 'process-a'),
    );
    registry.observe(
      'item/started',
      commandStarted('thread-b', 'other', 'process-b'),
    );
    const token = registry.beginReconciliation('thread-a');

    expect(registry.snapshot().reconciling).toBe(true);
    expect(registry.hasLiveWork()).toBe(true);
    expect(
      registry.commitTerminalPages(token, [
        {
          threadId: 'thread-a',
          itemId: 'from-page',
          processId: 'process-page',
        },
      ]),
    ).toBe(true);
    expect(registry.snapshot().work).toEqual([
      expect.objectContaining({
        kind: 'terminal',
        threadId: 'thread-a',
        itemId: 'from-page',
      }),
      expect.objectContaining({
        kind: 'terminal',
        threadId: 'thread-b',
        itemId: 'other',
      }),
    ]);
  });

  it('replays terminal starts and completions that race with reconciliation', () => {
    const registry = createRegistry();
    registry.observe(
      'item/started',
      commandStarted('root-thread', 'old', 'old-process'),
    );
    const token = registry.beginReconciliation('root-thread');
    registry.observe('item/completed', {
      threadId: 'root-thread',
      item: { type: 'commandExecution', id: 'old', status: 'completed' },
    });
    registry.observe(
      'item/started',
      commandStarted('root-thread', 'new', 'new-process'),
    );

    expect(
      registry.commitTerminalPages(token, [
        { threadId: 'root-thread', itemId: 'old', processId: 'old-process' },
        {
          threadId: 'root-thread',
          itemId: 'listed',
          processId: 'listed-process',
        },
      ]),
    ).toBe(true);
    expect(registry.snapshot().work).toEqual([
      expect.objectContaining({ kind: 'terminal', itemId: 'listed' }),
      expect.objectContaining({ kind: 'terminal', itemId: 'new' }),
    ]);
  });

  it('preserves known terminals after a failed or partial reconciliation', async () => {
    const registry = createRegistry();
    registry.observe(
      'item/started',
      commandStarted('root-thread', 'known', 'process-1'),
    );
    const token = registry.beginReconciliation('root-thread');

    let page = 0;
    const request = (): Promise<unknown> => {
      page += 1;
      return page === 1
        ? Promise.resolve({
            data: [{ itemId: 'partial', processId: 'process-partial' }],
            nextCursor: 'next-page',
          })
        : Promise.reject(new Error('page request failed'));
    };
    await expect(
      readAllCodexBackgroundTerminalPages(request, 'root-thread'),
    ).rejects.toThrow('page request failed');

    registry.failReconciliation(token);

    expect(registry.snapshot().reconciling).toBe(false);
    expect(registry.snapshot().work).toEqual([
      expect.objectContaining({ kind: 'terminal', itemId: 'known' }),
    ]);
  });

  it('retains terminal metadata and accepts an authoritative page after an earlier completion', () => {
    const registry = createRegistry();
    registry.observe(
      'item/started',
      commandStarted('root-thread', 'known', 'process-1'),
    );
    const token = registry.beginReconciliation('root-thread');
    expect(
      registry.commitTerminalPages(token, [
        { threadId: 'root-thread', itemId: 'known', processId: 'process-1' },
      ]),
    ).toBe(true);
    expect(registry.snapshot().work).toEqual([
      expect.objectContaining({
        kind: 'terminal',
        itemId: 'known',
        spawnedByTurnId: 'turn-1',
      }),
    ]);

    registry.observe('item/completed', {
      threadId: 'root-thread',
      item: { type: 'commandExecution', id: 'known', status: 'completed' },
    });
    const newerToken = registry.beginReconciliation('root-thread');
    expect(
      registry.commitTerminalPages(newerToken, [
        { threadId: 'root-thread', itemId: 'known', processId: 'process-1' },
      ]),
    ).toBe(true);

    expect(registry.snapshot().work).toEqual([
      expect.objectContaining({
        kind: 'terminal',
        itemId: 'known',
        processId: 'process-1',
      }),
    ]);
  });

  it('does not suppress an authoritative terminal page because of older completion history', () => {
    const registry = createRegistry();
    registry.observe(
      'item/started',
      commandStarted('root-thread', 'reused-item', 'process-1'),
    );
    registry.observe('item/completed', {
      threadId: 'root-thread',
      item: {
        type: 'commandExecution',
        id: 'reused-item',
        status: 'completed',
      },
    });

    const token = registry.beginReconciliation('root-thread');
    expect(
      registry.commitTerminalPages(token, [
        {
          threadId: 'root-thread',
          itemId: 'reused-item',
          processId: 'process-1',
        },
      ]),
    ).toBe(true);

    expect(registry.snapshot().work).toEqual([
      expect.objectContaining({
        kind: 'terminal',
        itemId: 'reused-item',
        processId: 'process-1',
      }),
    ]);
  });

  it('ignores stale epochs and superseded per-thread reconciliation tokens', () => {
    let epoch = 0;
    const registry = createCodexBackgroundWorkRegistry({
      rootThreadId: () => 'root-thread',
      newEpoch: () => `epoch-${epoch++}`,
    });
    const first = registry.beginReconciliation('thread-a');
    const superseding = registry.beginReconciliation('thread-a');
    expect(
      registry.commitTerminalPages(first, [
        { threadId: 'thread-a', itemId: 'stale', processId: 'stale-process' },
      ]),
    ).toBe(false);
    expect(
      registry.commitTerminalPages(superseding, [
        {
          threadId: 'thread-a',
          itemId: 'current',
          processId: 'current-process',
        },
      ]),
    ).toBe(true);

    const beforeRetire: CodexBackgroundReconciliationToken =
      registry.beginReconciliation('thread-b');
    registry.retireEpoch();
    expect(
      registry.commitTerminalPages(beforeRetire, [
        { threadId: 'thread-b', itemId: 'stale', processId: 'stale-process' },
      ]),
    ).toBe(false);
    expect(registry.snapshot()).toMatchObject({
      epoch: 'epoch-1',
      work: [],
      reconciling: false,
    });
  });

  it('emits immutable independent snapshots and isolates listener failures', () => {
    const registry = createRegistry();
    const badListener = jest.fn(() => {
      throw new Error('listener failure');
    });
    const firstSnapshots: object[] = [];
    const secondSnapshots: object[] = [];
    registry.subscribe((snapshot) => {
      firstSnapshots.push(snapshot);
    });
    registry.subscribe((snapshot) => {
      secondSnapshots.push(snapshot);
    });
    registry.subscribe(badListener);

    expect(() =>
      registry.observe('thread/started', childStarted('child-thread')),
    ).not.toThrow();
    expect(badListener).toHaveBeenCalledTimes(1);
    expect(firstSnapshots).toHaveLength(1);
    expect(secondSnapshots).toHaveLength(1);
    expect(firstSnapshots[0]).not.toBe(secondSnapshots[0]);
  });

  it('increments revisions only for real state changes and clears work on epoch retirement', () => {
    const registry = createRegistry();
    const initial = registry.snapshot();
    registry.observe('unrelated/notification', { threadId: 'root-thread' });
    expect(registry.snapshot().revision).toBe(initial.revision);

    registry.observe('thread/started', childStarted('child-thread'));
    const started = registry.snapshot();
    registry.observe('thread/started', childStarted('child-thread'));
    expect(registry.snapshot().revision).toBe(started.revision);

    registry.retireEpoch();
    const retired = registry.snapshot();
    expect(retired.work).toEqual([]);
    expect(retired.reconciling).toBe(false);
    expect(retired.revision).toBeGreaterThan(started.revision);
  });
});

describe('readAllCodexBackgroundTerminalPages', () => {
  it('reads every page and strips provider-only process data', async () => {
    const calls: Array<{ threadId: string; cursor?: string; limit?: number }> =
      [];
    const request = jest.fn(
      (params: { threadId: string; cursor?: string; limit?: number }) => {
        calls.push(params);
        if (!params.cursor) {
          return Promise.resolve({
            data: [
              {
                itemId: 'item-1',
                processId: 'process-1',
                command: 'private command',
                cwd: '/private/worktree',
                osPid: 123,
                cpuPercent: 2,
                rssKb: 99n,
              },
            ],
            nextCursor: 'cursor-1',
          });
        }
        return Promise.resolve({
          data: [{ itemId: 'item-2', processId: 'process-2' }],
          nextCursor: null,
        });
      },
    );

    const records = await readAllCodexBackgroundTerminalPages(
      request,
      'thread-1',
      { pageLimit: 25 },
    );

    expect(calls).toEqual([
      { threadId: 'thread-1', limit: 25 },
      { threadId: 'thread-1', cursor: 'cursor-1', limit: 25 },
    ]);
    expect(records).toEqual([
      { threadId: 'thread-1', itemId: 'item-1', processId: 'process-1' },
      { threadId: 'thread-1', itemId: 'item-2', processId: 'process-2' },
    ] satisfies CodexBackgroundTerminalRecord[]);
    expect(() => JSON.stringify(records)).not.toThrow();
    expect(JSON.stringify(records)).not.toContain('private command');
    expect(JSON.stringify(records)).not.toContain('/private/worktree');
  });

  it('throws for malformed pages, repeated cursors, and a page-limit overflow', async () => {
    await expect(
      readAllCodexBackgroundTerminalPages(
        () => Promise.resolve({ data: [], nextCursor: 42 }),
        'thread-1',
      ),
    ).rejects.toThrow();
    await expect(
      readAllCodexBackgroundTerminalPages(
        () =>
          Promise.resolve({
            data: [{ itemId: 'item', processId: 'process' }],
            nextCursor: 'same',
          }),
        'thread-1',
      ),
    ).rejects.toThrow();
    await expect(
      readAllCodexBackgroundTerminalPages(
        () => Promise.resolve({ data: [], nextCursor: 'next' }),
        'thread-1',
        { maxPages: 1 },
      ),
    ).rejects.toThrow();
  });

  it('rejects invalid page options and terminal records instead of returning partial results', async () => {
    await expect(
      readAllCodexBackgroundTerminalPages(
        () => Promise.resolve({ data: [], nextCursor: null }),
        'thread-1',
        {
          pageLimit: 0,
        },
      ),
    ).rejects.toThrow();
    await expect(
      readAllCodexBackgroundTerminalPages(
        () =>
          Promise.resolve({
            data: [{ itemId: 'item', processId: 5 }],
            nextCursor: null,
          }),
        'thread-1',
      ),
    ).rejects.toThrow();
  });
});
