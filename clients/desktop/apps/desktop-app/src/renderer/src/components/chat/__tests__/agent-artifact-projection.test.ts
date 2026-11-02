import type {
  AgentArtifactReceiptV1,
  AppAdvisorWatcherSummary,
  BackgroundProcess,
  GitHubWorkflowRunWatchProgress,
  PersistedChatMessage,
  PipelineRunArtifactReceiptV1,
} from '@canopy/desktop-shared/types';
import {
  createEmptyAgentArtifactProjectionCache,
  mergeAgentArtifactTurn,
  projectAgentArtifacts,
  projectAgentArtifactsWithCarry,
  refreshGitHubWorkflowRunReceipt,
  selectActiveAgentBlocks,
  selectWatchedCarryReceipts,
  selectWatchedGitHubWorkflowRuns,
  selectWatchedPipelineRuns,
} from '../agent-artifact-projection';
import { mergeToolResults } from '../message-transforms';
import {
  createAgentArtifactDedupeKey,
  isSameAgentArtifactCarryReceipt,
} from '@canopy/desktop-shared/lib/agent-artifacts';
import { projectAgentArtifactsWithCarry as projectSharedAgentArtifactsWithCarry } from '@canopy/desktop-shared/lib/agent-artifact-projection';

const now = '2026-08-04T12:00:00.000Z';

function skill(
  key: string,
  name: string,
  aliases?: string[],
): AgentArtifactReceiptV1 {
  return {
    version: 1,
    kind: 'skill',
    operation: 'skills.update',
    dedupeKey: key,
    ...(aliases ? { aliases } : {}),
    createdAt: now,
    source: 'installed',
    sourceId: 'custom',
    installedName: name,
    name,
    canUpdate: true,
    navigationTarget: {
      kind: 'installed_skill',
      sourceId: 'custom',
      skillName: name,
    },
  };
}

function run(executionId = 'exec-1'): PipelineRunArtifactReceiptV1 {
  return {
    version: 1,
    kind: 'pipeline_run',
    operation: 'pipeline.run',
    dedupeKey: createAgentArtifactDedupeKey(
      'pipeline_run',
      'execution',
      executionId,
    ),
    createdAt: now,
    executionId,
    pipelineId: 'pipe-1',
    pipelineName: 'Build',
    initialStatus: 'running',
    queuedAt: now,
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    navigationTarget: {
      kind: 'pipeline_execution',
      executionId,
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    },
  };
}

function transcript(
  receipts: unknown,
  options?: { error?: boolean; toolName?: string; input?: string },
): PersistedChatMessage[] {
  return [
    {
      id: 'turn-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Do it' }],
      timestamp: 1,
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'tool-1',
          toolName: options?.toolName ?? 'DispatchAction',
          input: options?.input ?? '{}',
        },
      ],
      timestamp: 2,
    },
    {
      id: 'result-1',
      role: 'assistant',
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'tool-1',
          toolName: options?.toolName ?? 'DispatchAction',
          output: JSON.stringify({
            ok: true,
            result: { agentArtifacts: receipts },
          }),
          isError: options?.error ?? false,
        },
      ],
      timestamp: 3,
    },
  ];
}

/**
 * One user turn whose dispatch call returns `receipts`. Every call builds
 * fresh message objects so cache reuse has to key on artifact-relevant
 * content rather than on message identity.
 */
function turn(
  ordinal: number,
  receipts: unknown,
  options?: { toolName?: string; toolUseId?: string },
): PersistedChatMessage[] {
  const toolName = options?.toolName ?? 'DispatchAction';
  const toolUseId = options?.toolUseId ?? `tool-${ordinal}`;
  return [
    {
      id: `turn-${ordinal}`,
      role: 'user',
      blocks: [{ type: 'text', text: `Ask ${ordinal}` }],
      timestamp: ordinal * 10,
    },
    {
      id: `assistant-${ordinal}`,
      role: 'assistant',
      blocks: [{ type: 'tool_use', toolUseId, toolName, input: '{}' }],
      timestamp: ordinal * 10 + 1,
    },
    {
      id: `result-${ordinal}`,
      role: 'assistant',
      blocks: [
        {
          type: 'tool_result',
          toolUseId,
          toolName,
          output: JSON.stringify({
            ok: true,
            result: { agentArtifacts: receipts },
          }),
          isError: false,
        },
      ],
      timestamp: ordinal * 10 + 2,
    },
  ];
}

function streamingTurn(ordinal: number, text: string): PersistedChatMessage[] {
  return [
    {
      id: `turn-${ordinal}`,
      role: 'user',
      blocks: [{ type: 'text', text: `Ask ${ordinal}` }],
      timestamp: ordinal * 10,
    },
    {
      id: `assistant-${ordinal}`,
      role: 'assistant',
      blocks: [{ type: 'text', text }],
      timestamp: ordinal * 10 + 1,
    },
  ];
}

function skillNames(
  receipts: readonly AgentArtifactReceiptV1[] | undefined,
): string[] | undefined {
  return receipts?.map((item) =>
    item.kind === 'skill' ? item.name : item.kind,
  );
}

describe('agent artifact projection cache', () => {
  it('keeps completed turn identities stable while a later turn streams', () => {
    const cache = createEmptyAgentArtifactProjectionCache();
    const first = projectAgentArtifactsWithCarry(
      [
        ...turn(1, [skill('canopy:skill:custom:a', 'a')]),
        ...turn(2, [run('exec-2')]),
        ...streamingTurn(3, 'Working'),
      ],
      undefined,
      cache,
    );
    const second = projectAgentArtifactsWithCarry(
      [
        ...turn(1, [skill('canopy:skill:custom:a', 'a')]),
        ...turn(2, [run('exec-2')]),
        ...streamingTurn(3, 'Working on it'),
      ],
      undefined,
      cache,
    );

    expect(first.byTurn['turn-1']).toHaveLength(1);
    expect(second.byTurn['turn-1']).toBe(first.byTurn['turn-1']);
    expect(second.byTurn['turn-2']).toBe(first.byTurn['turn-2']);
    expect(second.chatInitiatedPipelineRuns).toBe(
      first.chatInitiatedPipelineRuns,
    );
    expect(second.byTurn['turn-3']).toBeUndefined();
  });

  it('recomputes an edited turn and the later turns that consumed its tool owners', () => {
    const cache = createEmptyAgentArtifactProjectionCache();
    // Turn 2 carries a late result for turn 1's dispatch call, so its
    // projection depends on turn 1's tool owner as well as its own messages.
    const lateResult: PersistedChatMessage = {
      id: 'late-result-1',
      role: 'assistant',
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'tool-1',
          toolName: 'DispatchAction',
          output: JSON.stringify({
            ok: true,
            result: {
              agentArtifacts: [skill('canopy:skill:custom:late', 'late')],
            },
          }),
          isError: false,
        },
      ],
      timestamp: 25,
    };
    const baseline = projectAgentArtifactsWithCarry(
      [
        ...turn(1, [skill('canopy:skill:custom:a', 'a')]),
        ...turn(2, [skill('canopy:skill:custom:b', 'b')]),
        lateResult,
        ...streamingTurn(3, 'Working'),
      ],
      undefined,
      cache,
    );
    expect(skillNames(baseline.byTurn['turn-1'])).toEqual(['a', 'late']);

    // Editing turn 1's own result recomputes turn 1 only.
    const renamed = projectAgentArtifactsWithCarry(
      [
        ...turn(1, [skill('canopy:skill:custom:a', 'a-renamed')]),
        ...turn(2, [skill('canopy:skill:custom:b', 'b')]),
        lateResult,
        ...streamingTurn(3, 'Working'),
      ],
      undefined,
      cache,
    );
    expect(renamed.byTurn['turn-1']).not.toBe(baseline.byTurn['turn-1']);
    expect(skillNames(renamed.byTurn['turn-1'])).toEqual(['a-renamed', 'late']);
    expect(renamed.byTurn['turn-2']).toBe(baseline.byTurn['turn-2']);

    // Making turn 1's dispatch call unrecognized drops the late result that
    // turn 2 attributed to it, without touching turn 2's own artifacts.
    const unrecognized = projectAgentArtifactsWithCarry(
      [
        ...turn(1, [skill('canopy:skill:custom:a', 'a-renamed')], {
          toolName: 'Bash',
        }),
        ...turn(2, [skill('canopy:skill:custom:b', 'b')]),
        lateResult,
        ...streamingTurn(3, 'Working'),
      ],
      undefined,
      cache,
    );
    expect(unrecognized.byTurn['turn-1']).toBeUndefined();
    expect(unrecognized.byTurn['turn-2']).toBe(renamed.byTurn['turn-2']);
  });

  it('applies a changed carry to its owning turn only', () => {
    const cache = createEmptyAgentArtifactProjectionCache();
    const messages = [
      ...turn(1, [skill('canopy:skill:custom:a', 'a')]),
      ...turn(2, [skill('canopy:skill:custom:b', 'b')]),
    ];
    const carry = { 'turn-2': [run('exec-2')] };
    const first = projectAgentArtifactsWithCarry(messages, carry, cache);
    const second = projectAgentArtifactsWithCarry(
      messages,
      { ...carry, 'turn-2': [{ ...run('exec-2'), initialStatus: 'paused' }] },
      cache,
    );

    expect(second.byTurn['turn-1']).toBe(first.byTurn['turn-1']);
    expect(second.byTurn['turn-2']).not.toBe(first.byTurn['turn-2']);
    expect(second.byTurn['turn-2']?.map((item) => item.kind)).toEqual([
      'skill',
      'pipeline_run',
    ]);
  });
});

describe('agent artifact projection', () => {
  it('attributes receipts after a hidden delivery to the preceding visible turn', () => {
    const messages = transcript([run()]);
    messages.splice(1, 0, {
      id: 'hidden-delivery',
      role: 'user',
      hidden: true,
      blocks: [{ type: 'text', text: 'internal continuation' }],
      timestamp: 1.5,
    });

    const projected = projectAgentArtifacts(messages);
    expect(projected.byTurn['turn-1']).toHaveLength(1);
    expect(projected.byTurn['hidden-delivery']).toBeUndefined();
  });

  it('projects validated receipts and indexes chat-initiated runs', () => {
    const projected = projectAgentArtifacts(
      transcript([
        skill(
          createAgentArtifactDedupeKey('skill', 'installed', 'custom', 'one'),
          'one',
        ),
        run(),
      ]),
    );
    expect(projected.byTurn['turn-1']).toHaveLength(2);
    expect(projected.chatInitiatedPipelineRuns['exec-1']?.pipelineId).toBe(
      'pipe-1',
    );
  });

  it('ignores failures, malformed receipts, unknown versions, and unrelated tools', () => {
    expect(
      projectAgentArtifacts(transcript([run()], { error: true })).byTurn,
    ).toEqual({});
    expect(
      projectAgentArtifacts(transcript([{ ...run(), version: 2 }])).byTurn,
    ).toEqual({});
    expect(
      projectAgentArtifacts(transcript([run()], { toolName: 'Bash' })).byTurn,
    ).toEqual({});
  });

  it('ignores artifact receipts from foreign MCP dispatch tools', () => {
    expect(
      projectAgentArtifacts(
        transcript([run()], {
          toolName: 'mcp__foreign_namespace__DispatchAction',
        }),
      ),
    ).toEqual({ byTurn: {}, chatInitiatedPipelineRuns: {} });
  });

  it('projects singular early receipts and known legacy mutation responses', () => {
    const singularMessages = transcript([]);
    const singularResult = singularMessages[2]?.blocks[0];
    if (singularResult?.type !== 'tool_result')
      throw new Error('missing result');
    singularResult.output = JSON.stringify({
      ok: true,
      result: {
        artifactReceipt: skill(
          createAgentArtifactDedupeKey(
            'skill',
            'installed',
            'custom',
            'single',
          ),
          'single',
        ),
      },
    });
    const singularReceipt =
      projectAgentArtifacts(singularMessages).byTurn['turn-1']?.[0];
    if (singularReceipt?.kind !== 'skill')
      throw new Error('missing singular skill receipt');
    expect(singularReceipt.name).toBe('single');

    const legacyMessages = transcript([], {
      toolName: 'app_advisor_dispatch_action',
      input: JSON.stringify({
        action: {
          type: 'skills.create_custom',
          name: 'review',
          description: 'Reviews changes',
        },
      }),
    });
    const legacyResult = legacyMessages[2]?.blocks[0];
    if (legacyResult?.type !== 'tool_result') throw new Error('missing result');
    legacyResult.output = JSON.stringify({
      ok: true,
      result: { skill: { name: 'review' } },
    });
    expect(projectAgentArtifacts(legacyMessages).byTurn['turn-1']).toEqual([
      expect.objectContaining({
        kind: 'skill',
        operation: 'skills.create_custom',
        installedName: 'review',
        description: 'Reviews changes',
      }),
    ]);
  });

  it('projects a known legacy pipeline-run response without guessing missing fields', () => {
    const messages = transcript([], {
      input: JSON.stringify({ type: 'pipeline.run', repoId: 'repo-1' }),
    });
    const result = messages[2]?.blocks[0];
    if (result?.type !== 'tool_result') throw new Error('missing result');
    result.output = JSON.stringify({
      ok: true,
      result: {
        execution: {
          id: 'exec-legacy',
          pipelineId: 'pipe-1',
          name: 'Build',
          status: 'running',
          startedAt: now,
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      },
    });
    expect(
      projectAgentArtifacts(messages).chatInitiatedPipelineRuns['exec-legacy'],
    ).toEqual(
      expect.objectContaining({
        kind: 'pipeline_run',
        pipelineId: 'pipe-1',
        repoId: 'repo-1',
        createdAt: now,
      }),
    );
    expect(
      projectAgentArtifacts(messages).chatInitiatedPipelineRuns['exec-legacy']
        ?.createdAt,
    ).toBe(
      projectAgentArtifacts(messages).chatInitiatedPipelineRuns['exec-legacy']
        ?.createdAt,
    );
  });

  it('projects an App Advisor pipeline run from its legacy execution-state response', () => {
    const messages = transcript([], {
      toolName: 'mcp__canopy_app_advisor__DispatchAction',
      input: JSON.stringify({
        action: {
          type: 'pipeline.run',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          repoId: 'repo-1',
        },
      }),
    });
    const result = messages[2]?.blocks[0];
    if (result?.type !== 'tool_result') throw new Error('missing result');
    result.output = JSON.stringify({
      ok: true,
      result: {
        success: true,
        data: {
          id: 'exec-app-advisor',
          pipeline_id: 'pipe-1',
          pipeline_snapshot: { name: 'Build' },
          status: 'running',
          started_at: now,
          project_id: 'project-1',
          worktree_id: 'worktree-1',
        },
      },
    });

    expect(
      projectAgentArtifacts(messages).chatInitiatedPipelineRuns[
        'exec-app-advisor'
      ],
    ).toEqual(
      expect.objectContaining({
        kind: 'pipeline_run',
        pipelineId: 'pipe-1',
        pipelineName: 'Build',
        repoId: 'repo-1',
      }),
    );
  });

  it('projects legacy retry and resume execution responses as one-turn activity', () => {
    for (const operation of [
      'pipeline.execution_retry',
      'pipeline.execution_resume',
    ]) {
      const messages = transcript([], {
        input: JSON.stringify({ action: { type: operation } }),
      });
      const result = messages[2]?.blocks[0];
      if (result?.type !== 'tool_result') throw new Error('missing result');
      result.output = JSON.stringify({
        ok: true,
        result: {
          id: `exec-${operation}`,
          pipelineId: 'pipe-1',
          name: 'Build',
          status: 'running',
          startedAt: now,
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      });

      expect(projectAgentArtifacts(messages).byTurn['turn-1']).toEqual([
        expect.objectContaining({
          kind: 'pipeline_run',
          operation,
          pipelineId: 'pipe-1',
        }),
      ]);
    }
  });

  it('applies alias-aware latest-update-wins ordering without collapsing shared identities', () => {
    const first = skill(
      createAgentArtifactDedupeKey('skill', 'installed', 'custom', 'old'),
      'old',
    );
    const other = skill(
      createAgentArtifactDedupeKey('skill', 'installed', 'custom', 'other'),
      'other',
    );
    const renamed = skill(
      createAgentArtifactDedupeKey('skill', 'installed', 'custom', 'new'),
      'new',
      [first.dedupeKey],
    );
    const messages = transcript([first, other]);
    messages.push(
      {
        id: 'assistant-2',
        role: 'assistant',
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'tool-2',
            toolName: 'DispatchAction',
            input: '{}',
          },
        ],
        timestamp: 4,
      },
      {
        id: 'result-2',
        role: 'assistant',
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'tool-2',
            toolName: 'DispatchAction',
            output: JSON.stringify({
              ok: true,
              result: { agentArtifacts: [renamed] },
            }),
            isError: false,
          },
        ],
        timestamp: 5,
      },
    );
    expect(
      projectAgentArtifacts(messages).byTurn['turn-1']?.map(
        (item) => item.dedupeKey,
      ),
    ).toEqual([other.dedupeKey, renamed.dedupeKey]);
  });

  it('matches the shared projection Electron main uses for Portal links', () => {
    // CAN-3619: the renderer wrapper only adds instrumentation, so desktop
    // panels and Portal pipeline_run chat links attribute identically.
    const messages = transcript([run('exec-a'), run('exec-b')]);
    const carry = {
      'turn-1': [{ ...run('exec-c'), operation: 'pipeline.watch' as const }],
    };
    const cache = createEmptyAgentArtifactProjectionCache();
    const rendered = projectAgentArtifactsWithCarry(messages, carry, cache);

    expect(rendered).toEqual(
      projectSharedAgentArtifactsWithCarry(messages, carry),
    );
    expect(
      projectAgentArtifactsWithCarry(messages, carry, cache).byTurn['turn-1'],
    ).toBe(rendered.byTurn['turn-1']);
  });

  it('merges persisted carry without duplicating an originating run', () => {
    expect(mergeAgentArtifactTurn([run()], [run()])).toHaveLength(1);
    expect(
      projectAgentArtifactsWithCarry(transcript([run()]), { 'turn-1': [run()] })
        .byTurn['turn-1'],
    ).toHaveLength(1);
  });

  it('keeps watcher-carried run state authoritative over transcript state', () => {
    const projected = run();
    const carried = {
      ...run(),
      initialStatus: 'paused' as const,
      createdAt: '2026-08-04T12:05:00.000Z',
    };

    expect(mergeAgentArtifactTurn([projected], [carried])).toEqual([carried]);
  });

  it('carries watched runs regardless of which surface started them', () => {
    const destination = {
      projectId: 'advisor',
      worktreeId: 'entry',
      chatId: 'chat-1',
    };
    const watcher: AppAdvisorWatcherSummary = {
      id: 'watch-1',
      trigger: 'worktree_pipeline_completion',
      status: 'active',
      label: 'Build watcher',
      target: {
        kind: 'worktree_pipeline',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        pipelineId: 'pipe-1',
      },
      destination,
      createdAt: now,
    };
    expect(
      selectWatchedPipelineRuns(
        { 'exec-1': run() },
        [],
        [watcher],
        destination,
      ),
    ).toHaveLength(1);
    expect(
      selectWatchedPipelineRuns(
        { 'exec-1': run() },
        [
          {
            id: 'exec-1',
            pipeline_id: 'pipe-1',
            pipeline_name: 'Build',
            status: 'success',
            status_reasons: [],
            started_at: now,
            cwd: '/repo',
            project_id: 'project-1',
            worktree_id: 'worktree-1',
          },
        ],
        [watcher],
        destination,
      ),
    ).toHaveLength(0);
    expect(
      selectWatchedPipelineRuns(
        {},
        [
          {
            id: 'exec-external',
            pipeline_id: 'pipe-1',
            pipeline_name: 'External build',
            status: 'running',
            status_reasons: [],
            started_at: now,
            cwd: '/repo',
            project_id: 'project-1',
            worktree_id: 'worktree-1',
          },
        ],
        [watcher],
        destination,
      ),
    ).toEqual([
      expect.objectContaining({
        executionId: 'exec-external',
        pipelineName: 'External build',
        operation: 'pipeline.watch',
      }),
    ]);
    expect(
      selectWatchedPipelineRuns(
        { 'exec-1': run() },
        [],
        [{ ...watcher, status: 'delivery_failed' }],
        destination,
      ),
    ).toHaveLength(0);
    expect(
      selectWatchedPipelineRuns(
        { 'exec-1': run() },
        [],
        [{ ...watcher, destination: { ...destination, chatId: 'other' } }],
        destination,
      ),
    ).toHaveLength(0);
  });

  it('materializes a pinned watched execution from captured watcher details', () => {
    const destination = {
      projectId: 'advisor',
      worktreeId: 'entry',
      chatId: 'chat-1',
    };
    const watcher: AppAdvisorWatcherSummary = {
      id: 'watch-pinned',
      trigger: 'worktree_pipeline_completion',
      status: 'active',
      label: 'Pinned run',
      target: {
        kind: 'worktree_pipeline',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        executionId: 'exec-pinned',
        pipelineId: 'pipe-1',
        pipelineName: 'Build',
        executionStatus: 'paused',
        executionStartedAt: now,
      },
      destination,
      createdAt: now,
    };

    expect(selectWatchedPipelineRuns({}, [], [watcher], destination)).toEqual([
      expect.objectContaining({
        executionId: 'exec-pinned',
        initialStatus: 'paused',
        operation: 'pipeline.watch',
      }),
    ]);
  });
});

it('pins the latest active delegation generation after the parent settles and removes terminal children', () => {
  const child = (
    runGeneration: number,
    status: 'running' | 'completed',
  ): PersistedChatMessage => ({
    id: `child-${runGeneration}-${status}`,
    role: 'assistant',
    timestamp: runGeneration,
    blocks: [
      {
        type: 'delegated_agent_call',
        agentBlockId: `child-${runGeneration}-${status}`,
        delegationId: 'child',
        sequence: 0,
        parentTurnId: 'parent-turn',
        parentToolCallId: 'spawn-child',
        createdAt: runGeneration,
        selectedModelId: 'model',
        runtimeModelId: 'model',
        targetHarnessId: 'codex',
        runGeneration,
        status,
        parentHarnessId: 'codex',
        description: 'Review',
        prompt: 'Inspect source',
        executionMode: 'background',
        outputTruncated: false,
      },
    ],
  });
  const history: PersistedChatMessage[] = [
    child(1, 'completed'),
    child(2, 'running'),
    {
      id: 'parent-answer',
      role: 'assistant',
      timestamp: 3,
      blocks: [{ type: 'text', text: 'I will use the result when ready.' }],
    },
    child(1, 'completed'),
  ];
  expect(
    selectActiveAgentBlocks(
      mergeToolResults(history).map((message) => ({
        kind: 'standalone',
        message,
      })),
      [],
      'chat',
    ),
  ).toEqual([
    expect.objectContaining({
      delegationId: 'child',
      runGeneration: 2,
      status: 'running',
    }),
  ]);
  expect(
    selectActiveAgentBlocks(
      mergeToolResults([...history, child(2, 'completed')]).map((message) => ({
        kind: 'standalone',
        message,
      })),
      [],
      'chat',
    ),
  ).toEqual([]);
});

it('does not pin a running foreground managed delegation', () => {
  const history: PersistedChatMessage[] = [
    {
      id: 'foreground-child',
      role: 'assistant',
      timestamp: 1,
      blocks: [
        {
          type: 'delegated_agent_call',
          agentBlockId: 'foreground-child-block',
          delegationId: 'foreground-child',
          sequence: 0,
          parentTurnId: 'parent-turn',
          parentToolCallId: 'spawn-foreground-child',
          createdAt: 1,
          selectedModelId: 'model',
          runtimeModelId: 'model',
          targetHarnessId: 'codex',
          runGeneration: 1,
          status: 'running',
          parentHarnessId: 'codex',
          description: 'Review',
          prompt: 'Inspect source',
          executionMode: 'foreground',
          outputTruncated: false,
        },
      ],
    },
  ];

  expect(
    selectActiveAgentBlocks(
      mergeToolResults(history).map((message) => ({
        kind: 'standalone',
        message,
      })),
      [],
      'chat',
    ),
  ).toEqual([]);
});

it('pins a no-flag Claude Agent while its native background process is running', () => {
  const agent = {
    type: 'agent' as const,
    toolUseId: 'no-flag-native-agent',
    subagentType: 'Explore',
    description: 'Inspect the background task',
    prompt: 'Read the source',
    runInBackground: false,
    subBlocks: [],
  };
  const groups = [
    {
      kind: 'standalone' as const,
      message: {
        id: 'parent',
        role: 'assistant' as const,
        timestamp: 1,
        blocks: [agent],
      },
    },
  ];
  const process: BackgroundProcess = {
    id: 'native-agent',
    chatId: 'chat',
    toolUseId: agent.toolUseId,
    toolName: 'Agent',
    kind: 'agent',
    description: agent.description,
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    outputLines: [],
    canStop: true,
  };

  expect(selectActiveAgentBlocks(groups, [process], 'chat')).toEqual([agent]);
});

it('pins a no-flag Claude Agent from its async-launch result without native status', () => {
  const agent = {
    type: 'agent' as const,
    toolUseId: 'no-flag-async-agent',
    subagentType: 'Explore',
    description: 'Inspect the async task',
    prompt: 'Read the source',
    runInBackground: false,
    result: {
      output: 'Async agent launched successfully. agentId: abc123',
      isError: false,
    },
    subBlocks: [],
  };
  const groups = [
    {
      kind: 'standalone' as const,
      message: {
        id: 'parent',
        role: 'assistant' as const,
        timestamp: 1,
        blocks: [agent],
      },
    },
  ];

  expect(selectActiveAgentBlocks(groups, [], 'chat')).toEqual([agent]);
});

it('lets a terminal native task status override an async-launch result', () => {
  const agent = {
    type: 'agent' as const,
    toolUseId: 'completed-async-agent',
    subagentType: 'Explore',
    description: 'Inspect the completed task',
    prompt: 'Read the source',
    runInBackground: true,
    result: {
      output: 'Async agent launched successfully. agentId: abc123',
      isError: false,
    },
    subBlocks: [],
  };
  const groups = [
    {
      kind: 'standalone' as const,
      message: {
        id: 'parent',
        role: 'assistant' as const,
        timestamp: 1,
        blocks: [agent],
      },
    },
  ];
  const process: BackgroundProcess = {
    id: 'native-agent',
    chatId: 'chat',
    toolUseId: agent.toolUseId,
    toolName: 'Agent',
    kind: 'agent',
    description: agent.description,
    status: 'completed',
    startedAt: 1,
    updatedAt: 2,
    outputLines: [],
    canStop: false,
  };

  expect(selectActiveAgentBlocks(groups, [process], 'chat')).toEqual([]);
});

it('pins merged native and managed agent blocks with transcripts, scoped live status, and terminal removal', () => {
  const childText = { type: 'text' as const, text: 'Full child transcript' };
  const claude = {
    type: 'agent' as const,
    toolUseId: 'claude',
    subagentType: 'Explore',
    description: 'Review',
    prompt: 'Read',
    runInBackground: true,
    result: {
      output: 'Async agent launched successfully. agentId: abc123',
      isError: false,
    },
    subBlocks: [childText],
  };
  const codex = {
    type: 'codex_agent' as const,
    agentBlockId: 'codex',
    callId: 'spawn',
    status: 'completed' as const,
    senderThreadId: 'parent',
    receiverThreadIds: ['child'],
    prompt: 'Read',
    description: 'Review',
    displayName: 'Reviewer',
    agentsStates: { child: { status: 'running' as const } },
    subBlocks: [childText],
  };
  const groups = [
    {
      kind: 'standalone' as const,
      message: {
        id: 'parent',
        role: 'assistant' as const,
        timestamp: 1,
        blocks: [claude, codex],
      },
    },
  ];
  expect(selectActiveAgentBlocks(groups, [], 'chat')).toEqual([claude, codex]);
  const terminal = {
    id: 'claude',
    chatId: 'chat',
    toolUseId: 'claude',
    toolName: 'Agent',
    kind: 'agent' as const,
    description: 'Review',
    status: 'completed' as const,
    startedAt: 1,
    updatedAt: 2,
    outputLines: [],
    canStop: false,
  };
  expect(
    selectActiveAgentBlocks(groups, [{ ...terminal, chatId: 'other' }], 'chat'),
  ).toEqual([claude, codex]);
  expect(selectActiveAgentBlocks(groups, [terminal], 'chat')).toEqual([codex]);
  const completedGroups = [
    {
      ...groups[0],
      message: {
        ...groups[0].message,
        blocks: [
          {
            ...codex,
            agentsStates: { child: { status: 'completed' as const } },
          },
          claude,
        ],
      },
    },
  ];
  expect(selectActiveAgentBlocks(completedGroups, [terminal], 'chat')).toEqual(
    [],
  );
});

describe('GitHub workflow-run projection', () => {
  const destination = {
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
  };

  function progress(
    overrides: Partial<GitHubWorkflowRunWatchProgress> = {},
  ): GitHubWorkflowRunWatchProgress {
    return {
      repository: 'acme/api',
      runId: '101',
      runAttempt: 1,
      workflowName: 'CI',
      runNumber: 42,
      htmlUrl: 'https://github.com/acme/api/actions/runs/101',
      state: { kind: 'intermediate', status: 'in_progress' },
      startedAt: '2026-07-20T00:00:00.000Z',
      observedAt: '2026-07-20T00:00:05.000Z',
      jobs: [
        {
          jobId: '501',
          name: 'Build macOS',
          status: 'in_progress',
          conclusion: null,
          htmlUrl: 'https://github.com/acme/api/actions/runs/101/job/501',
          observedAt: '2026-07-20T00:00:05.000Z',
        },
      ],
      ...overrides,
    };
  }

  function githubWatcher(
    overrides: Partial<AppAdvisorWatcherSummary> = {},
    runs: GitHubWorkflowRunWatchProgress[] = [progress()],
  ): AppAdvisorWatcherSummary {
    return {
      id: 'gh-watch-1',
      trigger: 'github_workflow_runs_changed',
      status: 'active',
      label: 'CI workflow runs',
      target: {
        kind: 'github_workflow_runs',
        items: runs.map((run) => ({
          kind: 'workflow_run',
          repository: run.repository,
          runId: run.runId,
        })),
        notifyOn: {
          statuses: [],
          conclusions: [],
          jobConclusions: ['success'],
        },
        display: {
          repositories: ['acme/api'],
          sample: runs.map((run) => ({
            repository: run.repository,
            runId: run.runId,
            runAttempt: run.runAttempt,
          })),
        },
      },
      destination,
      createdAt: '2026-07-20T00:00:00.000Z',
      githubProgress: { runs },
      ...overrides,
    };
  }

  it('materializes one receipt per watched run for this chat only', () => {
    const receipts = selectWatchedGitHubWorkflowRuns(
      [
        githubWatcher(),
        githubWatcher({
          id: 'gh-other-chat',
          destination: { ...destination, chatId: 'other' },
        }),
        githubWatcher({ id: 'gh-failed', status: 'delivery_failed' }),
        githubWatcher({ id: 'gh-no-progress', githubProgress: undefined }),
      ],
      destination,
    );
    expect(receipts).toEqual([
      expect.objectContaining({
        kind: 'github_workflow_run',
        operation: 'github.watch',
        watcherId: 'gh-watch-1',
        repository: 'acme/api',
        runId: '101',
        runAttempt: 1,
        workflowName: 'CI',
        runNumber: 42,
        htmlUrl: 'https://github.com/acme/api/actions/runs/101',
        state: { kind: 'intermediate', status: 'in_progress' },
        observedAt: '2026-07-20T00:00:05.000Z',
        createdAt: '2026-07-20T00:00:00.000Z',
        jobs: [expect.objectContaining({ jobId: '501' })],
        navigationTarget: {
          kind: 'github_workflow_run',
          repository: 'acme/api',
          runId: '101',
          htmlUrl: 'https://github.com/acme/api/actions/runs/101',
        },
      }),
    ]);
  });

  it('keeps the most recently observed snapshot when two watchers follow one run', () => {
    const receipts = selectWatchedGitHubWorkflowRuns(
      [
        githubWatcher({ id: 'older' }),
        githubWatcher({ id: 'newer' }, [
          progress({
            observedAt: '2026-07-20T00:01:00.000Z',
            state: { kind: 'terminal', conclusion: 'success' },
          }),
        ]),
      ],
      destination,
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      watcherId: 'newer',
      state: { kind: 'terminal', conclusion: 'success' },
    });
  });

  it('refreshes a carried receipt from the live watcher and returns the same reference when unchanged', () => {
    const [receipt] = selectWatchedGitHubWorkflowRuns(
      [githubWatcher()],
      destination,
    );
    expect(refreshGitHubWorkflowRunReceipt(receipt, [githubWatcher()])).toBe(
      receipt,
    );
    expect(refreshGitHubWorkflowRunReceipt(receipt, [])).toBe(receipt);
    const refreshed = refreshGitHubWorkflowRunReceipt(receipt, [
      githubWatcher({ status: 'fired' }, [
        progress({
          observedAt: '2026-07-20T00:02:00.000Z',
          state: { kind: 'terminal', conclusion: 'failure' },
          jobs: [
            {
              jobId: '501',
              name: 'Build macOS',
              status: 'completed',
              conclusion: 'failure',
              htmlUrl: 'https://github.com/acme/api/actions/runs/101/job/501',
              observedAt: '2026-07-20T00:02:00.000Z',
            },
          ],
        }),
      ]),
    ]);
    expect(refreshed).not.toBe(receipt);
    expect(refreshed).toMatchObject({
      dedupeKey: receipt.dedupeKey,
      createdAt: receipt.createdAt,
      state: { kind: 'terminal', conclusion: 'failure' },
      jobs: [expect.objectContaining({ conclusion: 'failure' })],
    });
    // An older observation never regresses the card.
    expect(refreshGitHubWorkflowRunReceipt(refreshed, [githubWatcher()])).toBe(
      refreshed,
    );
  });

  it('selects the snapshot the run card shows when the fire history is newer', () => {
    const history = [
      githubWatcher({ status: 'firing' }, [
        progress({
          observedAt: '2026-07-20T00:02:00.000Z',
          state: { kind: 'terminal', conclusion: 'success' },
        }),
      ]),
    ];
    const [selected] = selectWatchedGitHubWorkflowRuns(
      [githubWatcher()],
      destination,
      history,
    );
    expect(selected).toMatchObject({
      state: { kind: 'terminal', conclusion: 'success' },
    });
    // The card refreshes over the same lists, so it has nothing newer to
    // record over the section's snapshot.
    expect(
      isSameAgentArtifactCarryReceipt(
        selected,
        refreshGitHubWorkflowRunReceipt(selected, [
          githubWatcher(),
          ...history,
        ]),
      ),
    ).toBe(true);
  });

  it('refreshes only from the originating watcher and pinned run attempt', () => {
    const [receipt] = selectWatchedGitHubWorkflowRuns(
      [githubWatcher()],
      destination,
    );
    const unrelated = githubWatcher({ id: 'gh-other-watcher' }, [
      progress({
        observedAt: '2026-07-20T00:03:00.000Z',
        state: { kind: 'terminal', conclusion: 'failure' },
      }),
    ]);
    const wrongAttempt = githubWatcher({ id: receipt.watcherId }, [
      progress({
        runAttempt: 2,
        observedAt: '2026-07-20T00:04:00.000Z',
        state: { kind: 'terminal', conclusion: 'cancelled' },
      }),
    ]);

    expect(
      refreshGitHubWorkflowRunReceipt(receipt, [unrelated, wrongAttempt]),
    ).toBe(receipt);
  });

  it('carries GitHub runs alongside watched pipeline runs', () => {
    const pipelineWatcher: AppAdvisorWatcherSummary = {
      id: 'watch-1',
      trigger: 'worktree_pipeline_completion',
      status: 'active',
      label: 'Build watcher',
      target: {
        kind: 'worktree_pipeline',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        pipelineId: 'pipe-1',
      },
      destination,
      createdAt: now,
    };
    const carried = selectWatchedCarryReceipts(
      { 'exec-1': run() },
      [],
      [pipelineWatcher, githubWatcher()],
      destination,
    );
    expect(carried.map((receipt) => receipt.kind)).toEqual([
      'pipeline_run',
      'github_workflow_run',
    ]);
    expect(mergeAgentArtifactTurn([skill('k', 'a')], carried)).toHaveLength(3);
  });
});
