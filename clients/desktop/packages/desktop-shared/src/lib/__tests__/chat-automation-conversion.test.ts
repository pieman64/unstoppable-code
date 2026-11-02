import {
  type AutomationAction,
  initClaudeModels,
  initCodexModels,
  type ScheduledActivity,
} from '../../types';
import { normalizePipeline } from '../../pipelines/normalize-pipeline';
import {
  type ChatAutomationAction,
  CHAT_AUTOMATION_JOB,
  chatAutomationToPipeline,
  convertibleChatAutomation,
  ownedPipelineToChatAction,
} from '../chat-automation-conversion';
import { validateAgentPipelineMutationPolicy } from '../agent-pipeline-policy';

type Activity = Pick<
  ScheduledActivity,
  | 'name'
  | 'action'
  | 'agentAuthor'
  | 'agentScheduledSend'
  | 'targetRequirement'
  | 'installedFrom'
>;

const reference = {
  kind: 'file' as const,
  textStart: 7,
  displayText: '@notes.md',
  root: { kind: 'workspace' as const },
  relativePath: 'notes.md',
};
const literalPrompt =
  'Review @notes.md for ${{ github.ref }} and ${{ inputs.x }}';
const portablePlugin = {
  type: 'skill' as const,
  source: { type: 'builtin' as const, id: 'app' },
  skill_name: 'review',
};
const agentAuthor = {
  chat: { projectId: 'p', worktreeId: 'w', chatId: 'c' },
  recordedAt: '2026-10-29T00:00:00.000Z',
};

// The interface mode follows the model's provider, read from the catalog.
beforeAll(() => {
  initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }]);
  initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
});

function activity(action: AutomationAction, name = 'Nightly review'): Activity {
  return { name, action };
}

const notCowork = (): boolean => false;
const cowork = (): boolean => true;

/** One converted case: its action and how its pipeline is checked. */
const CASES: Array<{
  label: string;
  action: ChatAutomationAction;
  isCowork: (id: string) => boolean;
  steps: string[];
  inputs: Record<string, string>;
}> = [
  {
    label: 'worktree_prompt into a new worktree',
    action: {
      type: 'worktree_prompt',
      workspaceId: 'project-1',
      baseBranch: 'main',
      sidebarGroupName: 'Nightly',
      prompt: literalPrompt,
      promptReferences: [reference],
      model: 'claude-sonnet-4-6',
      modelConfig: { thinkingLevel: 'high', speed: 'fast', fastMode: true },
      planMode: true,
      approvalMode: 'auto',
      interfaceMode: 'claude-code',
      plugins: [portablePlugin],
    },
    isCowork: notCowork,
    steps: [
      'builtin/create-worktree',
      'builtin/send-agent-message',
      'builtin/wait-for-agent-reply',
    ],
    inputs: { project_id: 'project-1', base_branch: 'main' },
  },
  {
    label: 'worktree_prompt stacked on a worktree',
    action: {
      type: 'worktree_prompt',
      workspaceId: 'project-1',
      baseWorktreeId: 'worktree-1',
      prompt: 'Continue',
    },
    isCowork: notCowork,
    steps: [
      'builtin/create-worktree',
      'builtin/send-agent-message',
      'builtin/wait-for-agent-reply',
    ],
    inputs: { project_id: 'project-1', base_task_id: 'worktree-1' },
  },
  {
    label: 'worktree_prompt on an existing branch',
    action: {
      type: 'worktree_prompt',
      workspaceId: 'project-1',
      existingBranch: 'feature/x',
      prompt: 'Continue',
    },
    isCowork: notCowork,
    steps: [
      'builtin/create-worktree',
      'builtin/send-agent-message',
      'builtin/wait-for-agent-reply',
    ],
    inputs: { project_id: 'project-1', existing_branch: 'feature/x' },
  },
  {
    label: 'worktree_prompt into an existing worktree',
    action: {
      type: 'worktree_prompt',
      workspaceId: 'project-1',
      existingWorktreeId: 'worktree-1',
      prompt: 'Continue',
      model: 'gpt-5.5',
    },
    isCowork: notCowork,
    steps: ['builtin/send-agent-message', 'builtin/wait-for-agent-reply'],
    inputs: { project_id: 'project-1', task_id: 'worktree-1' },
  },
  {
    label: 'standalone_prompt into a new Work Entry',
    action: {
      type: 'standalone_prompt',
      chatProjectId: 'cowork-1',
      sidebarGroupName: 'Notes',
      prompt: 'Organize notes',
      approvalMode: 'ask',
    },
    isCowork: cowork,
    steps: [
      'builtin/create-project-entry',
      'builtin/send-agent-message',
      'builtin/wait-for-agent-reply',
    ],
    inputs: { project_id: 'cowork-1' },
  },
  {
    label: 'standalone_prompt into an existing Work Entry',
    action: {
      type: 'standalone_prompt',
      chatProjectId: 'cowork-1',
      workEntryId: 'entry-1',
      prompt: 'Organize notes',
    },
    isCowork: cowork,
    steps: ['builtin/send-agent-message', 'builtin/wait-for-agent-reply'],
    inputs: { project_id: 'cowork-1', task_id: 'entry-1' },
  },
  {
    label: 'app_advisor_prompt into a new Work Entry',
    action: {
      type: 'app_advisor_prompt',
      sidebarGroupName: 'Reviews',
      prompt: 'Review the app',
      model: 'gpt-5.5',
      plugins: [portablePlugin],
    },
    isCowork: notCowork,
    steps: ['builtin/create-bot-entry', 'builtin/send-agent-message'],
    inputs: { bot_id: 'app_advisor' },
  },
  {
    label: 'app_advisor_prompt into an existing Work Entry',
    action: {
      type: 'app_advisor_prompt',
      workEntryId: 'entry-1',
      prompt: 'Review the app',
    },
    isCowork: notCowork,
    steps: ['builtin/send-agent-message'],
    inputs: { bot_id: 'app_advisor', task_id: 'entry-1' },
  },
  {
    label: 'worktree_session_prompt',
    action: {
      type: 'worktree_session_prompt',
      workspaceId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      prompt: 'Continue',
      model: 'gpt-5.5',
      planMode: false,
    },
    isCowork: notCowork,
    steps: ['builtin/send-agent-message', 'builtin/wait-for-agent-reply'],
    inputs: {
      project_id: 'project-1',
      task_id: 'worktree-1',
      chat_id: 'chat-1',
    },
  },
  {
    label: 'worktree_session_prompt into an Orchestrator chat',
    action: {
      type: 'worktree_session_prompt',
      workspaceId: 'app-advisor',
      worktreeId: 'entry-1',
      chatId: 'chat-1',
      prompt: 'Continue',
    },
    isCowork: notCowork,
    steps: ['builtin/send-agent-message'],
    inputs: { bot_id: 'app_advisor', task_id: 'entry-1', chat_id: 'chat-1' },
  },
];

describe('chatAutomationToPipeline (CAN-4551)', () => {
  it.each(CASES)('$label: a global pipeline the runner accepts', (row) => {
    const { pipeline, inputs } = chatAutomationToPipeline(activity(row.action));
    expect(pipeline.scope).toBe('global');
    expect(inputs).toEqual(row.inputs);
    const steps = pipeline.jobs[CHAT_AUTOMATION_JOB]?.steps ?? [];
    expect(steps.map((step) => step.uses)).toEqual(row.steps);
    expect(() => normalizePipeline(pipeline)).not.toThrow();
    // Every local ID is an input; none is written into the steps.
    const yaml = JSON.stringify(pipeline.jobs);
    for (const value of Object.values(inputs))
      if (value !== 'app_advisor') expect(yaml).not.toContain(`"${value}"`);
  });

  // CAN-4551 7c: what an agent's automation converts to passes the policy
  // its own pipeline writes pass.
  it.each(
    CASES.filter(
      (row) =>
        convertibleChatAutomation({ ...activity(row.action), agentAuthor })
          .convertible,
    ),
  )('$label: passes the agent pipeline policy', (row) => {
    const { pipeline } = chatAutomationToPipeline(activity(row.action));
    expect(validateAgentPipelineMutationPolicy(pipeline)).toBeNull();
  });

  it('keeps the prompt literal, and maps every setting onto the send step', () => {
    const [row] = CASES;
    const { pipeline } = chatAutomationToPipeline(activity(row.action));
    const send = pipeline.jobs[CHAT_AUTOMATION_JOB]?.steps.find(
      (step) => step.id === 'send',
    );
    expect(send?.with).toEqual({
      project_id: '${{ inputs.project_id }}',
      task_id: '${{ steps.worktree.outputs.task_id }}',
      text: literalPrompt,
      literal_text: 'true',
      text_references: JSON.stringify([reference]),
      model: 'claude-sonnet-4-6',
      thinking_effort: 'high',
      fast_mode: 'true',
      plan_mode: 'true',
      approval_mode: 'auto',
      plugins: JSON.stringify([portablePlugin]),
      interface_mode: 'claude-code',
      replace_empty_chat: 'true',
    });
  });

  function sendInputs(action: ChatAutomationAction): Record<string, unknown> {
    const { pipeline } = chatAutomationToPipeline(activity(action));
    return (
      pipeline.jobs[CHAT_AUTOMATION_JOB]?.steps.find(
        (step) => step.id === 'send',
      )?.with ?? {}
    );
  }

  it('drops a Claude interface mode for a non-Claude model, as the native send does', () => {
    expect(
      sendInputs({
        type: 'worktree_prompt',
        workspaceId: 'project-1',
        prompt: 'Review',
        model: 'gpt-5.5',
        interfaceMode: 'claude-code',
      }),
    ).not.toHaveProperty('interface_mode');
  });

  it.each<{ label: string; action: ChatAutomationAction }>([
    {
      label: 'an existing worktree',
      action: {
        type: 'worktree_prompt',
        workspaceId: 'project-1',
        existingWorktreeId: 'worktree-1',
        prompt: 'Continue',
      },
    },
    {
      label: 'an existing Cowork Work Entry',
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        workEntryId: 'entry-1',
        prompt: 'Continue',
      },
    },
    {
      label: 'an existing Orchestrator Work Entry',
      action: {
        type: 'app_advisor_prompt',
        workEntryId: 'entry-1',
        prompt: 'Continue',
      },
    },
  ])(
    'always starts a new chat in $label, with no settings too',
    ({ action }) => {
      expect(sendInputs(action)).toMatchObject({
        task_id: '${{ inputs.task_id }}',
        new_chat: 'true',
      });
    },
  );

  // A stacked worktree follows its root's group; the native action makes no
  // group call for it, and a group call would unstack it.
  it('makes no group call for a worktree stacked on another', () => {
    const { pipeline } = chatAutomationToPipeline(
      activity({
        type: 'worktree_prompt',
        workspaceId: 'project-1',
        baseWorktreeId: 'worktree-1',
        sidebarGroupName: 'Nightly',
        prompt: 'Continue',
      }),
    );
    const worktree = pipeline.jobs[CHAT_AUTOMATION_JOB]?.steps[0];
    expect(worktree?.with).toMatchObject({
      base_task_id: '${{ inputs.base_task_id }}',
    });
    expect(worktree?.with).not.toHaveProperty('group');
  });

  it('titles a new Orchestrator Work Entry with the automation name, within its limit', () => {
    const name = 'n'.repeat(250);
    const { pipeline } = chatAutomationToPipeline(
      activity({ type: 'app_advisor_prompt', prompt: 'Review' }, name),
    );
    const entry = pipeline.jobs[CHAT_AUTOMATION_JOB]?.steps[0];
    expect(entry?.with?.title).toBe(`${'n'.repeat(199)}…`);
  });
});

describe('convertibleChatAutomation (CAN-4551)', () => {
  it.each<{ label: string; activity: Activity; reason: string }>([
    {
      label: 'a pipeline action',
      activity: activity({
        type: 'worktree_pipeline',
        pipelineId: 'p',
        target: { kind: 'global' },
      }),
      reason: 'not_a_chat_action',
    },
    {
      label: 'the Home scheduled task',
      activity: activity({
        type: 'worktree_prompt',
        workspaceId: 'p',
        prompt: 'x',
        purpose: 'scheduled_task',
      }),
      reason: 'native_send',
    },
    {
      label: 'a usage-limit resume',
      activity: activity({
        type: 'worktree_session_prompt',
        workspaceId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        prompt: 'x',
        purpose: 'usage_limit_resume',
      }),
      reason: 'native_send',
    },
    {
      label: 'a legacy standalone chat',
      activity: activity({
        type: 'worktree_session_prompt',
        workspaceId: 'standalone-chat',
        worktreeId: 'w',
        chatId: 'c',
        prompt: 'x',
      }),
      reason: 'native_send',
    },
    {
      label: 'an agent-scheduled send',
      activity: {
        ...activity({
          type: 'worktree_session_prompt',
          workspaceId: 'p',
          worktreeId: 'w',
          chatId: 'c',
          prompt: 'x',
        }),
        agentScheduledSend: {
          version: 1,
          scheduledBy: { projectId: 'p', worktreeId: 'w', chatId: 'agent' },
        } as unknown as ScheduledActivity['agentScheduledSend'],
      },
      reason: 'native_send',
    },
    {
      label: 'attachments',
      activity: activity({
        type: 'worktree_session_prompt',
        workspaceId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        prompt: 'x',
        attachmentPaths: ['/tmp/a.png'],
      }),
      reason: 'composer_payload',
    },
    {
      label: 'voice input',
      activity: activity({
        type: 'worktree_session_prompt',
        workspaceId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        prompt: 'x',
        inputMode: 'voice',
      }),
      reason: 'composer_payload',
    },
    {
      label: 'local plugin selections',
      activity: activity({
        type: 'standalone_prompt',
        chatProjectId: 'c',
        prompt: 'x',
        pluginSelections: {
          collectionIds: ['col'],
          skillRefs: [],
          pluginRefs: [],
        },
      }),
      reason: 'local_plugin_selections',
    },
    {
      label: 'ultrafast speed',
      activity: activity({
        type: 'standalone_prompt',
        chatProjectId: 'c',
        prompt: 'x',
        modelConfig: { speed: 'ultrafast' },
      }),
      reason: 'unsupported_speed',
    },
    {
      // A global workflow has no target to restrict (CAN-4551).
      label: 'a run restriction',
      activity: {
        ...activity({
          type: 'standalone_prompt',
          chatProjectId: 'c',
          prompt: 'x',
        }),
        targetRequirement: { contexts: ['cowork'] },
      },
      reason: 'target_requirement',
    },
    {
      // The send step refuses a raw Agent model id, which the native send runs.
      label: 'an Agent model',
      activity: activity({
        type: 'standalone_prompt',
        chatProjectId: 'c',
        prompt: 'x',
        model: 'agent_model_reviewer',
      }),
      reason: 'agent_model',
    },
    {
      // The native send keeps the mode only for a Claude chat, and without a
      // model that is known only at run time.
      label: 'an interface mode with no model',
      activity: activity({
        type: 'worktree_prompt',
        workspaceId: 'project-1',
        prompt: 'x',
        interfaceMode: 'claude-code',
      }),
      reason: 'interface_mode_unresolved',
    },
    {
      label: 'an expression in an Orchestrator title',
      activity: activity(
        { type: 'app_advisor_prompt', prompt: 'x' },
        'Review ${{ inputs.x }}',
      ),
      reason: 'expression_text',
    },
    {
      // The create steps refuse `none` only at run time, so every run of the
      // converted automation would fail; the native send accepts it.
      label: 'a group named None',
      activity: activity({
        type: 'standalone_prompt',
        chatProjectId: 'c',
        prompt: 'x',
        sidebarGroupName: ' None ',
      }),
      reason: 'reserved_group_name',
    },
    {
      // The send step resolves a plugin reference without the provider and
      // harness the native send resolves it with, so the send would fail.
      label: 'a prompt that references a plugin',
      activity: activity({
        type: 'standalone_prompt',
        chatProjectId: 'c',
        prompt: '@review x',
        promptReferences: [
          {
            kind: 'plugin',
            textStart: 0,
            displayText: '@review',
            plugin: { kind: 'portable', ref: portablePlugin },
          },
        ],
      }),
      reason: 'plugin_reference',
    },
    {
      // Only the native prompt actions apply an installed package's overlay.
      label: 'an installed capability package',
      activity: {
        ...activity({
          type: 'app_advisor_prompt',
          prompt: 'x',
        }),
        installedFrom: {
          remoteId: 'share-1',
          contentHash: 'hash',
          installedAt: '2026-10-30T00:00:00.000Z',
          capabilityPackage: { version: 1, digest: 'sha256:package' },
        },
      },
      reason: 'installed_package',
    },
    {
      label: 'an agent-authored Orchestrator prompt with a model and plugins',
      activity: {
        ...activity({
          type: 'app_advisor_prompt',
          prompt: 'x',
          model: 'gpt-5.5',
          plugins: [portablePlugin],
        }),
        agentAuthor,
      },
      reason: 'agent_settings',
    },
    // D11 for a new chat: an agent-originated run chooses no plugins and no
    // approval mode, so these stay native.
    {
      label: 'an agent-authored Cowork prompt with plugins',
      activity: {
        ...activity({
          type: 'standalone_prompt',
          chatProjectId: 'c',
          prompt: 'x',
          plugins: [portablePlugin],
        }),
        agentAuthor,
      },
      reason: 'agent_settings',
    },
    {
      label: 'an agent-authored worktree prompt with an approval mode',
      activity: {
        ...activity({
          type: 'worktree_prompt',
          workspaceId: 'p',
          prompt: 'x',
          approvalMode: 'auto',
        }),
        agentAuthor,
      },
      reason: 'agent_settings',
    },
    {
      label: 'an agent-authored Cowork prompt that references a plugin',
      activity: {
        ...activity({
          type: 'standalone_prompt',
          chatProjectId: 'c',
          prompt: '@review x',
          promptReferences: [
            {
              kind: 'plugin',
              textStart: 0,
              displayText: '@review',
              plugin: { kind: 'portable', ref: portablePlugin },
            },
          ],
        }),
        agentAuthor,
      },
      reason: 'agent_settings',
    },
    {
      label:
        'an agent-authored session prompt that changes the chat’s settings',
      activity: {
        ...activity({
          type: 'worktree_session_prompt',
          workspaceId: 'p',
          worktreeId: 'w',
          chatId: 'c',
          prompt: 'x',
          approvalMode: 'full-access',
        }),
        agentAuthor,
      },
      reason: 'agent_settings',
    },
  ])('refuses $label', ({ activity: subject, reason }) => {
    expect(convertibleChatAutomation(subject)).toEqual({
      convertible: false,
      reason,
    });
    expect(() => chatAutomationToPipeline(subject)).toThrow(reason);
  });

  it('converts an agent-authored new chat, whose settings seed a chat it creates', () => {
    expect(
      convertibleChatAutomation({
        ...activity({
          type: 'standalone_prompt',
          chatProjectId: 'c',
          prompt: 'x',
          model: 'gpt-5.5',
        }),
        agentAuthor,
      }),
    ).toEqual({ convertible: true });
  });
});

describe('ownedPipelineToChatAction (CAN-4551)', () => {
  it.each(CASES)('$label: round-trips', (row) => {
    const { pipeline, inputs } = chatAutomationToPipeline(activity(row.action));
    const back = ownedPipelineToChatAction(pipeline, inputs, row.isCowork);
    expect(back).not.toBeNull();
    expect(chatAutomationToPipeline(activity(back ?? row.action))).toEqual(
      chatAutomationToPipeline(activity(row.action)),
    );
    expect(back?.prompt).toBe(row.action.prompt);
  });

  it('returns the original prompt byte for byte, expressions included', () => {
    const [row] = CASES;
    const { pipeline, inputs } = chatAutomationToPipeline(activity(row.action));
    const back = ownedPipelineToChatAction(pipeline, inputs, notCowork);
    expect(back?.prompt).toBe(literalPrompt);
    expect(back?.promptReferences).toEqual([reference]);
  });

  it('tells an existing Work Entry from an existing worktree by the project', () => {
    const { pipeline, inputs } = chatAutomationToPipeline(
      activity({
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        workEntryId: 'entry-1',
        prompt: 'x',
      }),
    );
    expect(ownedPipelineToChatAction(pipeline, inputs, cowork)?.type).toBe(
      'standalone_prompt',
    );
    expect(ownedPipelineToChatAction(pipeline, inputs, notCowork)?.type).toBe(
      'worktree_prompt',
    );
  });

  // CAN-4551: a top-level edit is a hand edit too; saving the chat would drop it.
  it.each(['env', 'defaults', 'description'])(
    'returns null when a hand edit added %s',
    (field) => {
      const [row] = CASES;
      const { pipeline, inputs } = chatAutomationToPipeline(
        activity(row.action),
      );
      expect(
        ownedPipelineToChatAction(
          {
            ...pipeline,
            [field]: field === 'description' ? 'Mine' : { A: '1' },
          },
          inputs,
          row.isCowork,
        ),
      ).toBeNull();
    },
  );

  it('returns null for a hand-edited pipeline', () => {
    const [row] = CASES;
    const { pipeline, inputs } = chatAutomationToPipeline(activity(row.action));
    const steps = pipeline.jobs[CHAT_AUTOMATION_JOB]?.steps ?? [];
    const edited = {
      ...pipeline,
      jobs: {
        [CHAT_AUTOMATION_JOB]: {
          steps: [...steps, { id: 'extra', run: 'echo hi' }],
        },
      },
    };
    expect(ownedPipelineToChatAction(edited, inputs, notCowork)).toBeNull();
    const retyped = {
      ...pipeline,
      jobs: {
        [CHAT_AUTOMATION_JOB]: {
          steps: steps.map((step) =>
            step.id === 'send'
              ? { ...step, with: { ...step.with, mode: 'steer' } }
              : step,
          ),
        },
      },
    };
    expect(ownedPipelineToChatAction(retyped, inputs, notCowork)).toBeNull();
    expect(
      ownedPipelineToChatAction(pipeline, { ...inputs, extra: 'x' }, notCowork),
    ).toBeNull();
  });
});
