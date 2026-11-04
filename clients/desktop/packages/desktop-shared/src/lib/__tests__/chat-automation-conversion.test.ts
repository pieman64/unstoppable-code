import {
  type AutomationAction,
  initClaudeModels,
  initCodexModels,
  type ScheduledActivity,
} from '../../types';
import { normalizePipeline } from '../../pipelines/normalize-pipeline';
import { parseSendAgentMessageInputs } from '../../pipelines/host-send-agent-message';
import { interpolateExpression } from '../../node/pipelines/executor/expression-evaluator';
import { buildExpressionContext } from '../../node/pipelines/executor/execution-context';
import {
  type ChatAutomationAction,
  CHAT_AUTOMATION_JOB,
  CHAT_AUTOMATION_MODEL_ALIAS,
  chatAutomationToPipeline,
  convertibleChatAutomation,
  ownedPipelineToChatAction,
} from '../chat-automation-conversion';
import { validateAgentPipelineMutationPolicy } from '../agent-pipeline-policy';
import { normalizePluginSelections } from '../plugin-selections-normalization';

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
const pluginReference = {
  kind: 'plugin' as const,
  textStart: 0,
  displayText: '@review',
  plugin: { kind: 'portable' as const, ref: portablePlugin },
};
// Stored normalized, so the round trip returns them as they were.
const localSelections = normalizePluginSelections({
  collectionIds: ['col'],
  skillRefs: [{ sourceId: 'custom:app', skillName: 'mine' }],
  pluginRefs: [],
});
const attachmentPath = '/data/attachments/worktree-1/shot.png';
const composerPayload = {
  attachmentPaths: [attachmentPath],
  attachmentPromptContexts: [
    { attachmentPath, promptKind: 'linear-ticket' as const },
  ],
  fileReferences: [
    { displayPath: 'src/a.ts', absolutePath: '/repo/src/a.ts', textStart: 3 },
  ],
  inputMode: 'voice' as const,
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
  name?: string;
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
  // CAN-5479: shapes that used to stay native.
  {
    label: 'worktree_session_prompt with attachments and voice input',
    action: {
      type: 'worktree_session_prompt',
      workspaceId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      prompt: 'Look at this',
      ...composerPayload,
    },
    isCowork: notCowork,
    steps: ['builtin/send-agent-message', 'builtin/wait-for-agent-reply'],
    inputs: {
      project_id: 'project-1',
      task_id: 'worktree-1',
      chat_id: 'chat-1',
      attachment_paths: JSON.stringify(composerPayload.attachmentPaths),
      attachment_prompt_contexts: JSON.stringify(
        composerPayload.attachmentPromptContexts,
      ),
      file_references: JSON.stringify(composerPayload.fileReferences),
      input_mode: 'voice',
    },
  },
  {
    label: 'standalone_prompt with local plugin selections',
    action: {
      type: 'standalone_prompt',
      chatProjectId: 'cowork-1',
      prompt: 'Organize notes',
      pluginSelections: localSelections,
    },
    isCowork: cowork,
    steps: [
      'builtin/create-project-entry',
      'builtin/send-agent-message',
      'builtin/wait-for-agent-reply',
    ],
    inputs: {
      project_id: 'cowork-1',
      plugin_selections: JSON.stringify(localSelections),
    },
  },
  {
    label: 'standalone_prompt at Ultra fast',
    action: {
      type: 'standalone_prompt',
      chatProjectId: 'cowork-1',
      prompt: 'Organize notes',
      model: 'gpt-5.5',
      modelConfig: { speed: 'ultrafast', fastMode: false },
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
    label: 'standalone_prompt with an Agent',
    action: {
      type: 'standalone_prompt',
      chatProjectId: 'cowork-1',
      prompt: 'Organize notes',
      model: 'agent_model_reviewer',
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
    label: 'worktree_prompt with an interface mode and no model',
    action: {
      type: 'worktree_prompt',
      workspaceId: 'project-1',
      prompt: 'Review',
      interfaceMode: 'claude-code',
    },
    isCowork: notCowork,
    steps: [
      'builtin/create-worktree',
      'builtin/send-agent-message',
      'builtin/wait-for-agent-reply',
    ],
    inputs: { project_id: 'project-1' },
  },
  {
    label: 'app_advisor_prompt with expressions in its title and group',
    name: 'Review ${{ inputs.x }} and ${{ github.ref }}}}',
    action: {
      type: 'app_advisor_prompt',
      sidebarGroupName: 'Team ${{ env.HOME }}',
      prompt: 'Review the app',
    },
    isCowork: notCowork,
    steps: ['builtin/create-bot-entry', 'builtin/send-agent-message'],
    inputs: { bot_id: 'app_advisor' },
  },
  {
    label: 'standalone_prompt into a group named None',
    action: {
      type: 'standalone_prompt',
      chatProjectId: 'cowork-1',
      sidebarGroupName: ' None ',
      prompt: 'Organize notes',
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
    label: 'standalone_prompt that references a plugin',
    action: {
      type: 'standalone_prompt',
      chatProjectId: 'cowork-1',
      prompt: '@review the notes',
      promptReferences: [pluginReference],
    },
    isCowork: cowork,
    steps: [
      'builtin/create-project-entry',
      'builtin/send-agent-message',
      'builtin/wait-for-agent-reply',
    ],
    inputs: { project_id: 'cowork-1' },
  },
];

/** A case's activity, with its own name when it has one. */
function caseActivity(row: (typeof CASES)[number]): Activity {
  return activity(row.action, row.name);
}

describe('chatAutomationToPipeline (CAN-4551)', () => {
  it.each(CASES)('$label: a global pipeline the runner accepts', (row) => {
    const { pipeline, inputs } = chatAutomationToPipeline(caseActivity(row));
    expect(pipeline.scope).toBe('global');
    expect(inputs).toEqual(row.inputs);
    const steps = pipeline.jobs[CHAT_AUTOMATION_JOB]?.steps ?? [];
    expect(steps.map((step) => step.uses)).toEqual(row.steps);
    expect(() => normalizePipeline(pipeline)).not.toThrow();
    // Every local ID is an input; none is written into the steps.
    const yaml = JSON.stringify(pipeline.jobs);
    for (const value of Object.values(inputs))
      if (value !== 'app_advisor') expect(yaml).not.toContain(`"${value}"`);
    // The send step's inputs parse as the runner will parse them.
    const send = pipeline.jobs[CHAT_AUTOMATION_JOB]?.steps.find(
      (step) => step.id === 'send',
    );
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(send?.with ?? {}))
      values[key] =
        typeof value === 'string'
          ? value.replace(
              /^\$\{\{ (inputs|steps\.\w+\.outputs)\.(\w+) \}\}$/,
              (_match, _scope: string, name: string) =>
                inputs[name] ?? 'task-1',
            )
          : '';
    expect(parseSendAgentMessageInputs(values).ok).toBe(true);
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
    const { pipeline } = chatAutomationToPipeline(caseActivity(row));
    expect(validateAgentPipelineMutationPolicy(pipeline)).toBeNull();
  });

  // The send step refuses any file references on an agent's run, even none,
  // so an empty list converts to no input rather than '[]'.
  it('omits an empty file reference list, which an agent’s run would refuse', () => {
    const subject = {
      ...activity({
        type: 'worktree_session_prompt',
        workspaceId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        prompt: 'Continue',
        fileReferences: [],
      }),
      agentAuthor,
    };
    expect(convertibleChatAutomation(subject).convertible).toBe(true);
    expect(chatAutomationToPipeline(subject).inputs).not.toHaveProperty(
      'file_references',
    );
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

  // CAN-5479: local values are automation inputs, as target IDs are.
  it('reads local plugin selections and a composer payload from automation inputs', () => {
    expect(
      sendInputs({
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        prompt: 'x',
        pluginSelections: localSelections,
      }),
    ).toMatchObject({ plugin_selections: '${{ inputs.plugin_selections }}' });
    expect(
      sendInputs({
        type: 'worktree_session_prompt',
        workspaceId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        prompt: 'x',
        ...composerPayload,
      }),
    ).toMatchObject({
      attachment_paths: '${{ inputs.attachment_paths }}',
      attachment_prompt_contexts: '${{ inputs.attachment_prompt_contexts }}',
      file_references: '${{ inputs.file_references }}',
      input_mode: '${{ inputs.input_mode }}',
    });
  });

  it('runs an Agent through a model alias the automation maps to it', () => {
    const converted = chatAutomationToPipeline(
      activity({
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        prompt: 'x',
        model: 'agent_model_reviewer',
      }),
    );
    expect(converted.pipeline.model_aliases).toEqual([
      { id: CHAT_AUTOMATION_MODEL_ALIAS, name: 'Chat agent' },
    ]);
    expect(converted.modelAliasPreferences).toEqual({
      [CHAT_AUTOMATION_MODEL_ALIAS]: {
        mode: 'agent',
        agent_id: 'agent_model_reviewer',
      },
    });
    const send = converted.pipeline.jobs[CHAT_AUTOMATION_JOB]?.steps.find(
      (step) => step.id === 'send',
    );
    expect(send?.with?.model).toBe(CHAT_AUTOMATION_MODEL_ALIAS);
    // The local Agent id stays out of the YAML.
    expect(JSON.stringify(converted.pipeline)).not.toContain(
      'agent_model_reviewer',
    );
  });

  it('sends Ultra fast as speed, and keeps fast_mode for Regular and Fast', () => {
    const ultrafast = sendInputs({
      type: 'standalone_prompt',
      chatProjectId: 'cowork-1',
      prompt: 'x',
      modelConfig: { speed: 'ultrafast', fastMode: false },
    });
    expect(ultrafast).toMatchObject({ speed: 'ultrafast' });
    expect(ultrafast).not.toHaveProperty('fast_mode');
    expect(
      sendInputs({
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        prompt: 'x',
        modelConfig: { speed: 'standard', fastMode: false },
      }),
    ).toMatchObject({ fast_mode: 'false' });
  });

  it('keeps an interface mode with no model, for the run to decide', () => {
    expect(
      sendInputs({
        type: 'worktree_prompt',
        workspaceId: 'project-1',
        prompt: 'Review',
        interfaceMode: 'claude-code',
      }),
    ).toMatchObject({ interface_mode: 'claude-code' });
  });

  // The create steps interpolate their title and group once: each escaped
  // `${{` comes out as written, and nothing in the name is evaluated.
  it('escapes expressions in a title and group so they run as written', () => {
    const name = 'Review ${{ inputs.x }} and ${{ github.ref }}}}';
    const group = 'Team ${{ env.HOME }}';
    const { pipeline } = chatAutomationToPipeline(
      activity(
        { type: 'app_advisor_prompt', sidebarGroupName: group, prompt: 'x' },
        name,
      ),
    );
    const entry = pipeline.jobs[CHAT_AUTOMATION_JOB]?.steps[0];
    const context = buildExpressionContext({
      inputs: { x: 'EVALUATED' },
      env: { HOME: 'EVALUATED' },
    });
    const title = entry?.with?.title;
    const groupInput = entry?.with?.group;
    if (typeof title !== 'string' || typeof groupInput !== 'string')
      throw new Error('missing title or group');
    expect(interpolateExpression(title, context)).toBe(name);
    expect(interpolateExpression(groupInput, context)).toBe(group);
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
      // Only an automation's own native send may start a chat on a pinned
      // route; a converted run's chat creation refuses it.
      label: 'a pinned Agent route',
      activity: activity({
        type: 'standalone_prompt',
        chatProjectId: 'c',
        prompt: 'x',
        model: 'agent_model_reviewer@claude-sonnet-4-6',
      }),
      reason: 'agent_route',
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
      // D11: an agent's run takes no plugins through a prompt reference.
      reason: 'agent_settings',
    },
    {
      // D11: an agent's send into an existing chat changes no plugins, and
      // the send step refuses plugin_selections there on every run.
      label: 'an agent-authored session prompt with local plugin selections',
      activity: {
        ...activity({
          type: 'worktree_session_prompt',
          workspaceId: 'p',
          worktreeId: 'w',
          chatId: 'c',
          prompt: 'x',
          pluginSelections: {
            collectionIds: ['col'],
            skillRefs: [],
            pluginRefs: [],
          },
        }),
        agentAuthor,
      },
      reason: 'agent_settings',
    },
    // D11 for an existing chat: a send into it changes no authority, and no
    // grant carries one (CAN-5479), so these stay native.
    {
      label: 'an agent-authored session prompt that references a plugin',
      activity: {
        ...activity({
          type: 'worktree_session_prompt',
          workspaceId: 'p',
          worktreeId: 'w',
          chatId: 'c',
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

  // CAN-5479: a valid run restriction is the action's own single context, so
  // the converter ignores it; desktop main checks it before dropping it.
  it('converts an automation with a run restriction', () => {
    expect(
      convertibleChatAutomation({
        ...activity({
          type: 'standalone_prompt',
          chatProjectId: 'c',
          prompt: 'x',
        }),
        targetRequirement: { contexts: ['cowork'] },
      }),
    ).toEqual({ convertible: true });
  });
  // CAN-5479: an agent's automation keeps the settings its native action
  // set, through the native grant main records with its pipeline.
  it.each([
    {
      label: 'Orchestrator prompt with a model and plugins',
      action: {
        type: 'app_advisor_prompt' as const,
        prompt: 'x',
        model: 'gpt-5.5',
        plugins: [portablePlugin],
      },
      settings: { model: 'gpt-5.5', plugins: JSON.stringify([portablePlugin]) },
    },
    {
      label: 'Cowork prompt with plugins',
      action: {
        type: 'standalone_prompt' as const,
        chatProjectId: 'c',
        prompt: 'x',
        plugins: [portablePlugin],
      },
      settings: { plugins: JSON.stringify([portablePlugin]) },
    },
    {
      label: 'worktree prompt with full access',
      action: {
        type: 'worktree_prompt' as const,
        workspaceId: 'p',
        prompt: 'x',
        approvalMode: 'full-access' as const,
      },
      settings: { approval_mode: 'full-access' },
    },
  ])(
    'converts an agent-authored $label, keeping its settings (CAN-5479)',
    ({ action, settings }) => {
      const subject = { ...activity(action), agentAuthor };
      expect(convertibleChatAutomation(subject)).toEqual({
        convertible: true,
      });
      const send = chatAutomationToPipeline(subject).pipeline.jobs[
        CHAT_AUTOMATION_JOB
      ]?.steps.find((step) => step.uses === 'builtin/send-agent-message');
      expect(send?.with).toMatchObject(settings);
    },
  );

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

  // CAN-5479: main applies the install's package to the generated send step.
  it('converts an installed capability package', () => {
    const installed: Activity = {
      ...activity({ type: 'app_advisor_prompt', prompt: 'x' }),
      installedFrom: {
        remoteId: 'share-1',
        contentHash: 'hash',
        installedAt: '2026-10-30T00:00:00.000Z',
        capabilityPackage: { version: 1, digest: 'sha256:package' },
      },
    };
    expect(convertibleChatAutomation(installed)).toEqual({
      convertible: true,
    });
  });
});

describe('ownedPipelineToChatAction (CAN-4551)', () => {
  it.each(CASES)('$label: round-trips', (row) => {
    const converted = chatAutomationToPipeline(caseActivity(row));
    const back = ownedPipelineToChatAction(
      converted.pipeline,
      converted.inputs,
      row.isCowork,
      converted.modelAliasPreferences,
    );
    expect(back).not.toBeNull();
    expect(
      chatAutomationToPipeline(
        activity(back ?? row.action, converted.pipeline.name),
      ),
    ).toEqual(converted);
    expect(back?.prompt).toBe(row.action.prompt);
  });

  // CAN-5479: every carried setting comes back as it was stored.
  it.each(CASES.filter((row) => row.action.type !== 'worktree_prompt'))(
    '$label: returns the action as stored',
    (row) => {
      const converted = chatAutomationToPipeline(caseActivity(row));
      expect(
        ownedPipelineToChatAction(
          converted.pipeline,
          converted.inputs,
          row.isCowork,
          converted.modelAliasPreferences,
        ),
      ).toEqual(row.action);
    },
  );

  it('returns the automation name an escaped Orchestrator title stands for', () => {
    const name = 'Review ${{ inputs.x }}';
    const action: ChatAutomationAction = {
      type: 'app_advisor_prompt',
      sidebarGroupName: 'Team ${{ env.HOME }}',
      prompt: 'x',
    };
    const { pipeline, inputs } = chatAutomationToPipeline(
      activity(action, name),
    );
    // The pipeline is renamed with the automation; the title keeps the name.
    expect(
      ownedPipelineToChatAction(
        { ...pipeline, name: 'Other' },
        inputs,
        notCowork,
      ),
    ).toEqual(action);
  });

  it('returns null when the Agent preference was changed or dropped', () => {
    const converted = chatAutomationToPipeline(
      activity({
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        prompt: 'x',
        model: 'agent_model_reviewer',
      }),
    );
    expect(
      ownedPipelineToChatAction(converted.pipeline, converted.inputs, cowork),
    ).toBeNull();
    expect(
      ownedPipelineToChatAction(converted.pipeline, converted.inputs, cowork, {
        [CHAT_AUTOMATION_MODEL_ALIAS]: { mode: 'inline', base: 'gpt-5.5' },
      }),
    ).toBeNull();
  });

  it('returns null when a value input was edited', () => {
    const converted = chatAutomationToPipeline(
      activity({
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        prompt: 'x',
        pluginSelections: localSelections,
      }),
    );
    expect(
      ownedPipelineToChatAction(
        converted.pipeline,
        { ...converted.inputs, plugin_selections: '{"collectionIds":["x"]}' },
        cowork,
      ),
    ).toBeNull();
    expect(
      ownedPipelineToChatAction(
        converted.pipeline,
        { project_id: 'cowork-1' },
        cowork,
      ),
    ).toBeNull();
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
