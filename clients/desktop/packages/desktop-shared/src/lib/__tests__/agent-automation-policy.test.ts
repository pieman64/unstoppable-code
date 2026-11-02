import type { AutomationAction, AutomationCreateRequest } from '../../types';
import {
  AGENT_SCHEDULED_SEND_EDIT_POLICY_ERROR,
  AGENT_AUTOMATION_OWNER_POLICY_ERROR,
  AGENT_AUTOMATION_IF_COMMAND_POLICY_ERROR,
  AGENT_AUTOMATION_SHARED_PIPELINE_PIN_POLICY_ERROR,
  AGENT_AUTOMATION_SESSION_AUTHORITY_POLICY_ERROR,
  PIPELINE_EXECUTION_RESUME_POLICY_ERROR,
  WORKTREE_SESSION_PROMPT_ACTION_CHANGE_POLICY_ERROR,
  WORKTREE_SESSION_PROMPT_CONVERSION_POLICY_ERROR,
  WORKTREE_SESSION_PROMPT_CREATE_POLICY_ERROR,
  WORKTREE_SESSION_PROMPT_RETARGET_POLICY_ERROR,
  agentAutomationTargetProject,
  validateAgentAutomationCreatePolicy,
  validateAgentAutomationRunPolicy,
  validateAgentAutomationUpdatePolicy,
} from '../agent-automation-policy';

const sessionAction: Extract<
  AutomationAction,
  { type: 'worktree_session_prompt' }
> = {
  type: 'worktree_session_prompt',
  workspaceId: 'workspace-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
  purpose: 'scheduled_send',
  prompt: 'Continue',
};

const normalAction: AutomationAction = {
  type: 'worktree_pipeline',
  workspaceId: 'workspace-1',
  pipelineId: 'pipeline-1',
};

const sharedPipelineAction: AutomationAction = {
  type: 'worktree_pipeline',
  workspaceId: 'workspace-1',
  pipelineId: 'shared:canopy-cloud:remote-1',
  pipelineSource: 'shared',
  sharedPipeline: {
    serverId: 'canopy-cloud',
    remoteId: 'remote-1',
    installPin: {
      pipelineContentHash: 'a'.repeat(64),
      distributionMode: 'definition_only',
      packageDigest: 'digest-a',
    },
  },
};

const resumeAction: AutomationAction = {
  type: 'pipeline_execution_resume',
  executionId: 'execution-1',
  statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
  provider: 'claude',
  purpose: 'usage_limit_resume',
  pipelineName: 'Release',
};

describe('agent automation policy', () => {
  it('directs session creation to the trusted project schedule action', () => {
    expect(WORKTREE_SESSION_PROMPT_CREATE_POLICY_ERROR).toContain(
      'projects.schedule_message',
    );
  });

  it('blocks agent action replacements on attributed schedules but allows lifecycle edits', () => {
    const check = (
      patch: Parameters<typeof validateAgentAutomationUpdatePolicy>[1],
    ): string | null =>
      validateAgentAutomationUpdatePolicy(
        sessionAction,
        patch,
        undefined,
        true,
      );
    expect(check({ action: { ...sessionAction, prompt: 'Changed' } })).toBe(
      AGENT_SCHEDULED_SEND_EDIT_POLICY_ERROR,
    );
    expect(check({ action: normalAction })).toBe(
      AGENT_SCHEDULED_SEND_EDIT_POLICY_ERROR,
    );
    expect(check({ enabled: false })).toBeNull();
    expect(check({ name: 'Renamed' })).toBeNull();
    expect(
      check({
        schedule: {
          kind: 'one_time',
          runAt: '2099-01-01T00:00:00Z',
          timezone: 'local',
        },
      }),
    ).toBeNull();
  });

  it('blocks direct session-prompt creation and permits normal creation', () => {
    expect(validateAgentAutomationCreatePolicy({ action: sessionAction })).toBe(
      WORKTREE_SESSION_PROMPT_CREATE_POLICY_ERROR,
    );
    expect(
      validateAgentAutomationCreatePolicy({
        action: normalAction,
      } satisfies Pick<AutomationCreateRequest, 'action'>),
    ).toBeNull();
  });

  it("blocks an agent from choosing a new automation's owner", () => {
    expect(
      validateAgentAutomationCreatePolicy({
        action: normalAction,
        executionContext: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      }),
    ).toBe(AGENT_AUTOMATION_OWNER_POLICY_ERROR);
    expect(
      validateAgentAutomationCreatePolicy({
        action: normalAction,
        executionContext: 'personal',
      }),
    ).toBe(AGENT_AUTOMATION_OWNER_POLICY_ERROR);
  });

  it('blocks agent-authored If Command gates while allowing them to be cleared', () => {
    expect(
      validateAgentAutomationCreatePolicy({
        action: normalAction,
        ifCommand: 'touch /tmp/agent-command',
      }),
    ).toBe(AGENT_AUTOMATION_IF_COMMAND_POLICY_ERROR);
    expect(
      validateAgentAutomationUpdatePolicy(normalAction, {
        ifCommand: 'touch /tmp/agent-command',
      }),
    ).toBe(AGENT_AUTOMATION_IF_COMMAND_POLICY_ERROR);
    expect(
      validateAgentAutomationUpdatePolicy(normalAction, { ifCommand: '' }),
    ).toBeNull();
    expect(
      validateAgentAutomationUpdatePolicy(
        normalAction,
        {
          schedule: {
            kind: 'cron',
            expression: '0 9 * * *',
            timezone: 'local',
          },
        },
        'existing command',
      ),
    ).toBe(AGENT_AUTOMATION_IF_COMMAND_POLICY_ERROR);
    expect(
      validateAgentAutomationUpdatePolicy(
        normalAction,
        { enabled: false },
        'existing command',
      ),
    ).toBeNull();
    expect(
      validateAgentAutomationUpdatePolicy(
        normalAction,
        {
          schedule: {
            kind: 'cron',
            expression: '0 9 * * *',
            timezone: 'local',
          },
          ifCommand: '',
        },
        'existing command',
      ),
    ).toBeNull();
  });

  it('blocks conversion to the protected action kind', () => {
    expect(
      validateAgentAutomationUpdatePolicy(normalAction, {
        action: sessionAction,
      }),
    ).toBe(WORKTREE_SESSION_PROMPT_CONVERSION_POLICY_ERROR);
  });

  it('blocks agents from removing, replacing, or escaping a shared-pipeline approval pin', () => {
    const withoutPin: AutomationAction = {
      ...sharedPipelineAction,
      sharedPipeline: {
        serverId: 'canopy-cloud',
        remoteId: 'remote-1',
      },
    };
    const replacedPin: AutomationAction = {
      ...sharedPipelineAction,
      sharedPipeline: {
        serverId: 'canopy-cloud',
        remoteId: 'remote-1',
        installPin: {
          pipelineContentHash: 'b'.repeat(64),
          distributionMode: 'definition_only',
        },
      },
    };
    const differentSharedPipeline: AutomationAction = {
      ...sharedPipelineAction,
      pipelineId: 'shared:canopy-cloud:remote-2',
      sharedPipeline: {
        serverId: 'canopy-cloud',
        remoteId: 'remote-2',
        installPin: {
          pipelineContentHash: 'a'.repeat(64),
          distributionMode: 'definition_only',
          packageDigest: 'digest-a',
        },
      },
    };

    for (const action of [
      withoutPin,
      replacedPin,
      normalAction,
      differentSharedPipeline,
    ]) {
      expect(
        validateAgentAutomationUpdatePolicy(sharedPipelineAction, { action }),
      ).toBe(AGENT_AUTOMATION_SHARED_PIPELINE_PIN_POLICY_ERROR);
    }
    expect(
      validateAgentAutomationUpdatePolicy(sharedPipelineAction, {
        action: {
          ...sharedPipelineAction,
          sharedPipeline: {
            serverId: 'canopy-cloud',
            remoteId: 'remote-1',
            installPin: {
              packageDigest: 'digest-a',
              distributionMode: 'definition_only',
              pipelineContentHash: 'a'.repeat(64),
            },
          },
        },
      }),
    ).toBeNull();
  });

  it('reserves pipeline-resume creation, retargeting, and execution for the trusted recovery flow', () => {
    expect(validateAgentAutomationCreatePolicy({ action: resumeAction })).toBe(
      PIPELINE_EXECUTION_RESUME_POLICY_ERROR,
    );
    expect(
      validateAgentAutomationUpdatePolicy(normalAction, {
        action: resumeAction,
      }),
    ).toBe(PIPELINE_EXECUTION_RESUME_POLICY_ERROR);
    expect(
      validateAgentAutomationUpdatePolicy(resumeAction, {
        action: normalAction,
      }),
    ).toBe(PIPELINE_EXECUTION_RESUME_POLICY_ERROR);
    expect(validateAgentAutomationRunPolicy(resumeAction)).toBe(
      PIPELINE_EXECUTION_RESUME_POLICY_ERROR,
    );
    expect(validateAgentAutomationRunPolicy(normalAction)).toBeNull();
    expect(
      validateAgentAutomationUpdatePolicy(resumeAction, { enabled: false }),
    ).toBeNull();
    expect(
      validateAgentAutomationUpdatePolicy(resumeAction, { enabled: true }),
    ).toBe(PIPELINE_EXECUTION_RESUME_POLICY_ERROR);
    expect(
      validateAgentAutomationUpdatePolicy(resumeAction, {
        schedule: {
          kind: 'cron',
          expression: '0 9 * * *',
          timezone: 'local',
        },
      }),
    ).toBe(PIPELINE_EXECUTION_RESUME_POLICY_ERROR);
  });

  it('blocks changing, retargeting, or repurposing a session prompt', () => {
    expect(
      validateAgentAutomationUpdatePolicy(sessionAction, {
        action: normalAction,
      }),
    ).toBe(WORKTREE_SESSION_PROMPT_ACTION_CHANGE_POLICY_ERROR);
    expect(
      validateAgentAutomationUpdatePolicy(sessionAction, {
        action: { ...sessionAction, chatId: 'chat-2' },
      }),
    ).toBe(WORKTREE_SESSION_PROMPT_RETARGET_POLICY_ERROR);
    expect(
      validateAgentAutomationUpdatePolicy(sessionAction, {
        action: { ...sessionAction, purpose: 'usage_limit_resume' },
      }),
    ).toBe(WORKTREE_SESSION_PROMPT_RETARGET_POLICY_ERROR);
  });

  it('blocks agent updates that change authority on an existing chat', () => {
    for (const action of [
      { ...sessionAction, approvalMode: 'full-access' as const },
      { ...sessionAction, planMode: false },
      { ...sessionAction, model: 'claude-sonnet-4-5' as const },
      { ...sessionAction, modelConfig: { thinkingLevel: 'high' as const } },
      {
        ...sessionAction,
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      },
      { ...sessionAction, plugins: [] },
    ]) {
      expect(
        validateAgentAutomationUpdatePolicy(sessionAction, { action }),
      ).toBe(AGENT_AUTOMATION_SESSION_AUTHORITY_POLICY_ERROR);
    }
  });

  it('blocks plugin prompt references added through a content edit', () => {
    expect(
      validateAgentAutomationUpdatePolicy(sessionAction, {
        action: {
          ...sessionAction,
          prompt: 'Use alpha-tool',
          promptReferences: [
            {
              kind: 'plugin',
              textStart: 4,
              displayText: 'alpha-tool',
              plugin: {
                kind: 'installed',
                marketplaceId: 'market',
                pluginName: 'alpha-tool',
              },
            },
          ],
        },
      }),
    ).toBe(AGENT_AUTOMATION_SESSION_AUTHORITY_POLICY_ERROR);
  });

  it('permits agent-created worktree prompts targeting an existing worktree', () => {
    // `existingWorktreeId` opens a NEW chat on an existing worktree — it is
    // not session injection, so it stays in the same policy class as every
    // other worktree_prompt.
    const existingWorktreeAction: AutomationAction = {
      type: 'worktree_prompt',
      workspaceId: 'workspace-1',
      existingWorktreeId: 'worktree-1',
      prompt: 'Implement leg 2 in place',
    };
    expect(
      validateAgentAutomationCreatePolicy({ action: existingWorktreeAction }),
    ).toBeNull();
    expect(
      validateAgentAutomationUpdatePolicy(normalAction, {
        action: existingWorktreeAction,
      }),
    ).toBeNull();
    expect(validateAgentAutomationRunPolicy(existingWorktreeAction)).toBeNull();
  });

  it('permits content, schedule, name, and disable patches', () => {
    expect(
      validateAgentAutomationUpdatePolicy(sessionAction, {
        action: { ...sessionAction, prompt: 'Updated' },
      }),
    ).toBeNull();
    expect(
      validateAgentAutomationUpdatePolicy(sessionAction, { enabled: false }),
    ).toBeNull();
    expect(validateAgentAutomationUpdatePolicy(normalAction, {})).toBeNull();
  });
});

describe('agentAutomationTargetProject pipeline destinations', () => {
  const base = { type: 'worktree_pipeline', pipelineId: 'p' } as const;
  it('reports a global pipeline as owned by no project', () => {
    expect(
      agentAutomationTargetProject({
        ...base,
        workspaceId: 'ws-1',
        target: { kind: 'global' },
      }),
    ).toEqual({ kind: 'global' });
  });

  it('reports a task destination with its task', () => {
    expect(
      agentAutomationTargetProject({
        ...base,
        workspaceId: 'ws-1',
        target: { kind: 'task', taskId: 'wt-1' },
      }),
    ).toEqual({ kind: 'project', projectId: 'ws-1', worktreeId: 'wt-1' });
    expect(
      agentAutomationTargetProject({ ...base, workspaceId: 'ws-1' }),
    ).toEqual({ kind: 'project', projectId: 'ws-1' });
    expect(agentAutomationTargetProject({ ...base })).toEqual({
      kind: 'unknown',
    });
  });
});

describe('agentAutomationTargetProject', () => {
  it('maps each action type to the project the owner rule checks', () => {
    expect(agentAutomationTargetProject(normalAction)).toEqual({
      kind: 'project',
      projectId: 'workspace-1',
    });
    expect(
      agentAutomationTargetProject({
        type: 'worktree_prompt',
        workspaceId: ' workspace-2 ',
        prompt: 'Run',
      }),
    ).toEqual({ kind: 'project', projectId: 'workspace-2' });
    expect(
      agentAutomationTargetProject({
        type: 'standalone_prompt',
        chatProjectId: 'cowork-default',
        prompt: 'Run',
      }),
    ).toEqual({ kind: 'project', projectId: 'cowork-default' });
    expect(agentAutomationTargetProject(sessionAction)).toEqual({
      kind: 'project',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
    expect(
      agentAutomationTargetProject({
        type: 'app_advisor_prompt',
        prompt: 'Summarize',
      }),
    ).toEqual({ kind: 'app_advisor' });
  });

  it('treats a pipeline resume without a project as unknown', () => {
    const resume: AutomationAction = {
      type: 'pipeline_execution_resume',
      executionId: 'execution-1',
      statusReasonIds: [],
      provider: 'claude',
      purpose: 'usage_limit_resume',
      pipelineName: 'Pipeline',
    };
    expect(agentAutomationTargetProject(resume)).toEqual({ kind: 'unknown' });
    expect(
      agentAutomationTargetProject({
        ...resume,
        projectId: 'workspace-3',
        worktreeId: 'worktree-3',
      }),
    ).toEqual({
      kind: 'project',
      projectId: 'workspace-3',
      worktreeId: 'worktree-3',
    });
  });
});
