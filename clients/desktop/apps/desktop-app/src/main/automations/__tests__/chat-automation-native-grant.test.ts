import { chatAutomationToPipeline } from '@canopy/desktop-shared/lib/chat-automation-conversion';
import { normalizePipeline } from '@canopy/desktop-shared/pipelines/normalize-pipeline';
import type { PipelineHostActionCaller } from '@canopy/desktop-shared/node/pipelines/executor/types';
import type { Pipeline } from '@canopy/desktop-shared/types/pipeline';
import type {
  PipelineLocalMetadata,
  PipelineNativeGrant,
} from '../../pipelines/pipeline-local-metadata-store';
import {
  nativeGrantAuthority,
  nativeGrantContentHash,
  ownedPipelineAuthority,
  resolvePipelineNativeGrant,
  sameNativeGrantAuthority,
  withNativeGrantAuthority,
  type NativeGrantRunFacts,
} from '../chat-automation-native-grant';

const plugin = {
  type: 'skill' as const,
  source: { type: 'builtin' as const, id: 'app' },
  skill_name: 'review',
};
const agentOrigin = { projectId: 'ap', worktreeId: 'aw', chatId: 'ac' };
const agentAuthor = { chat: agentOrigin, recordedAt: '2026-11-01T00:00:00Z' };
const action = {
  type: 'worktree_prompt' as const,
  workspaceId: 'project-1',
  prompt: 'Review the branch',
  approvalMode: 'full-access' as const,
};
const { pipeline } = chatAutomationToPipeline({
  name: 'Nightly review',
  action,
  agentAuthor,
});
const grant: PipelineNativeGrant = {
  automationId: 'automation-1',
  pipelineRevision: 4,
  contentHash: nativeGrantContentHash(pipeline),
  approvalMode: 'full-access',
};
const caller: Pick<
  PipelineHostActionCaller,
  'executionId' | 'pipelineId' | 'agentOrigin' | 'initiator'
> = {
  executionId: 'exec-1',
  pipelineId: 'owned-1',
  agentOrigin,
  initiator: { kind: 'automation', automationId: 'automation-1' },
};

/** The run as the executor persists it: its snapshot read back as JSON. */
function persistedSnapshot(content: Pipeline): unknown {
  const parsed: unknown = JSON.parse(
    JSON.stringify(normalizePipeline(content, { defaultShell: 'bash' })),
  );
  return parsed;
}

function facts(
  overrides: {
    metadata?: PipelineLocalMetadata;
    stored?: { revision?: number; content: Pipeline } | undefined;
    execution?: Awaited<ReturnType<NativeGrantRunFacts['execution']>>;
  } = {},
): NativeGrantRunFacts {
  return {
    metadata: () =>
      overrides.metadata ?? {
        agentAuthor,
        ownerAutomationId: 'automation-1',
        nativeGrant: grant,
      },
    stored: () =>
      'stored' in overrides
        ? overrides.stored
        : { revision: 4, content: pipeline },
    execution: () =>
      Promise.resolve(
        'execution' in overrides
          ? overrides.execution
          : { pipelineId: 'owned-1', snapshot: persistedSnapshot(pipeline) },
      ),
    normalize: (content) =>
      normalizePipeline(content, { defaultShell: 'bash' }),
  };
}

describe('resolvePipelineNativeGrant (CAN-5479)', () => {
  it('honors the grant for its automation’s run of exactly the granted pipeline', async () => {
    await expect(resolvePipelineNativeGrant(caller, facts())).resolves.toEqual(
      grant,
    );
  });

  it('fails closed once anyone writes the pipeline (a new revision)', async () => {
    await expect(
      resolvePipelineNativeGrant(
        caller,
        facts({ stored: { revision: 5, content: pipeline } }),
      ),
    ).resolves.toBeUndefined();
  });

  it('fails closed when the stored content is not what was granted', async () => {
    const edited: Pipeline = { ...pipeline, name: 'Edited' };
    await expect(
      resolvePipelineNativeGrant(
        caller,
        facts({ stored: { revision: 4, content: edited } }),
      ),
    ).resolves.toBeUndefined();
  });

  it('fails closed when the run executed another definition', async () => {
    const executed: Pipeline = { ...pipeline, env: { EXTRA: '1' } };
    await expect(
      resolvePipelineNativeGrant(
        caller,
        facts({
          execution: {
            pipelineId: 'owned-1',
            snapshot: persistedSnapshot(executed),
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('never honors the grant in a child run', async () => {
    await expect(
      resolvePipelineNativeGrant(
        caller,
        facts({
          execution: {
            pipelineId: 'owned-1',
            parentExecutionId: 'parent-1',
            snapshot: persistedSnapshot(pipeline),
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('never honors the grant for another automation, or a stale owner', async () => {
    await expect(
      resolvePipelineNativeGrant(
        {
          ...caller,
          initiator: { kind: 'automation', automationId: 'automation-2' },
        },
        facts(),
      ),
    ).resolves.toBeUndefined();
    await expect(
      resolvePipelineNativeGrant(
        caller,
        facts({
          metadata: {
            agentAuthor,
            ownerAutomationId: 'automation-2',
            nativeGrant: grant,
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('reads nothing for a run no agent’s automation started', async () => {
    const read = facts();
    const metadata = jest.spyOn(read, 'metadata');
    for (const run of [
      { ...caller, agentOrigin: undefined },
      { ...caller, initiator: { kind: 'agent' as const, chat: agentOrigin } },
    ])
      await expect(
        resolvePipelineNativeGrant(run, read),
      ).resolves.toBeUndefined();
    expect(metadata).not.toHaveBeenCalled();
  });

  it('fails closed when the run can’t be read', async () => {
    await expect(
      resolvePipelineNativeGrant(caller, facts({ execution: undefined })),
    ).resolves.toBeUndefined();
    await expect(
      resolvePipelineNativeGrant(caller, {
        ...facts(),
        execution: () => Promise.reject(new Error('unreadable')),
      }),
    ).resolves.toBeUndefined();
  });
});

describe('native grant authority (CAN-5479)', () => {
  it('is what D11 refuses a new chat: approvals, plugins and an Orchestrator model', () => {
    expect(nativeGrantAuthority({ ...action, model: 'sonnet' })).toEqual({
      approvalMode: 'full-access',
    });
    expect(
      nativeGrantAuthority({
        type: 'app_advisor_prompt',
        prompt: 'x',
        model: 'gpt-5.5',
        plugins: [plugin],
        planMode: true,
      }),
    ).toEqual({ model: 'gpt-5.5', plugins: [plugin] });
    expect(
      nativeGrantAuthority({
        type: 'worktree_session_prompt',
        workspaceId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        prompt: 'x',
        approvalMode: 'full-access',
      }),
    ).toBeUndefined();
    expect(
      nativeGrantAuthority({ ...action, approvalMode: undefined, plugins: [] }),
    ).toBeUndefined();
  });

  // Local selections reach the send step through the automation's inputs,
  // which the content hash doesn't cover.
  it('names local plugin selections, normalized, and only when they choose something', () => {
    const selections = {
      collectionIds: ['col-1'],
      skillRefs: [],
      pluginRefs: [],
    };
    expect(
      nativeGrantAuthority({
        ...action,
        approvalMode: undefined,
        pluginSelections: { ...selections, bundleIds: ['col-1'] },
      }),
    ).toEqual({ pluginSelections: selections });
    expect(
      nativeGrantAuthority({
        ...action,
        approvalMode: undefined,
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      }),
    ).toBeUndefined();
    expect(
      sameNativeGrantAuthority(
        { pluginSelections: selections },
        { pluginSelections: { ...selections, collectionIds: ['col-2'] } },
      ),
    ).toBe(false);
    expect(
      withNativeGrantAuthority(
        {
          ...action,
          pluginSelections: { ...selections, collectionIds: ['x'] },
        },
        { pluginSelections: selections },
      ),
    ).toEqual({
      ...action,
      approvalMode: undefined,
      pluginSelections: selections,
    });
  });

  it('compares authority alone, with no authority as none', () => {
    expect(
      sameNativeGrantAuthority(grant, { approvalMode: 'full-access' }),
    ).toBe(true);
    expect(sameNativeGrantAuthority(undefined, {})).toBe(true);
    expect(sameNativeGrantAuthority(grant, { approvalMode: 'auto' })).toBe(
      false,
    );
    expect(sameNativeGrantAuthority(undefined, { plugins: [plugin] })).toBe(
      false,
    );
  });

  it('puts exactly the given authority on a chat action', () => {
    expect(
      withNativeGrantAuthority(
        { ...action, approvalMode: 'auto', plugins: [plugin], planMode: true },
        { approvalMode: 'full-access' },
      ),
    ).toEqual({ ...action, approvalMode: 'full-access', planMode: true });
    expect(
      withNativeGrantAuthority(
        { type: 'app_advisor_prompt', prompt: 'x', model: 'gpt-5.5' },
        undefined,
      ),
    ).toEqual({ type: 'app_advisor_prompt', prompt: 'x' });
  });

  it('takes an owned pipeline’s authority from its grant, else from a pipeline only a person wrote', () => {
    const edited = { ...action, approvalMode: 'auto' as const };
    expect(
      ownedPipelineAuthority(
        'automation-1',
        { agentAuthor, nativeGrant: grant },
        edited,
      ),
    ).toEqual({ approvalMode: 'full-access' });
    // An agent wrote it and nothing was granted: none.
    expect(
      ownedPipelineAuthority('automation-1', { agentAuthor }, edited),
    ).toBeUndefined();
    // Another automation's grant is no grant.
    expect(
      ownedPipelineAuthority(
        'automation-2',
        { agentAuthor, nativeGrant: grant },
        edited,
      ),
    ).toBeUndefined();
    expect(ownedPipelineAuthority('automation-1', {}, edited)).toEqual({
      approvalMode: 'auto',
    });
  });
});
