/**
 * Chat automation conversion (CAN-4551, step 7a): a chat automation's action
 * as an automation-owned global pipeline built from the host steps, and back.
 *
 * Browser-safe; it reads only the model catalog, to keep a Claude interface
 * mode for a Claude model alone. Conversion is lossless or refused: an action
 * whose settings the steps can't carry exactly stays native. Every local ID is a
 * pipeline input; the prompt stays literal in the YAML (`literal_text`), so
 * sharing, which strips input values, keeps it.
 */
import { APP_ADVISOR_BOT_ID } from '@canopy/agent-actions/families/bots/actions';
import type {
  AgentModelConfig,
  ApprovalMode,
  AutomationAction,
  ChatInterfaceMode,
  ScheduledActivity,
  ShareablePluginRef,
} from '../types';
import {
  APP_ADVISOR_PROJECT_ID,
  getProviderForModel,
  isAgentModel,
  resolveKnownModel,
  STANDALONE_CHAT_PROJECT_ID,
} from '../types';
import type { Pipeline, PipelineInputDef, Step } from '../types/pipeline';
import type { ConfiguredPromptReference } from '@canopy/protocol/configured-prompt-references';
import { parseSendAgentMessageInputs } from '../pipelines/host-send-agent-message';

/** The generated pipeline's only job. */
export const CHAT_AUTOMATION_JOB = 'chat';

const STEP = {
  worktree: 'worktree',
  entry: 'entry',
  send: 'send',
  reply: 'reply',
} as const;

/** The longest wait the reply step allows; the native watcher has no limit. */
const REPLY_TIMEOUT_MINUTES = '720';

/** A Work Entry title is at most this long (`create-bot-entry`). */
const ENTRY_TITLE_MAX = 200;

export type ChatAutomationAction = Extract<
  AutomationAction,
  {
    type:
      | 'worktree_prompt'
      | 'standalone_prompt'
      | 'app_advisor_prompt'
      | 'worktree_session_prompt';
  }
>;

export type ChatAutomationConversionRefusal =
  /** Not one of the four chat actions. */
  | 'not_a_chat_action'
  /** A D4 send, the Home scheduled task or a legacy standalone chat. */
  | 'native_send'
  /** Attachments, voice input or legacy file references. */
  | 'composer_payload'
  /** Local plugin selections, which a shareable step input can't carry. */
  | 'local_plugin_selections'
  /** A Codex speed the step's `fast_mode` can't express. */
  | 'unsupported_speed'
  /** An Agent model, which the send step's `model` can't name. */
  | 'agent_model'
  /** A run restriction, which a global workflow has no target to apply to. */
  | 'target_requirement'
  /** A title or group name the expression runner would evaluate. */
  | 'expression_text'
  /** A group named `none`, which the create steps refuse at run time. */
  | 'reserved_group_name'
  /**
   * A plugin prompt reference, which the send step resolves without the
   * provider the native send resolves it with.
   */
  | 'plugin_reference'
  /** An installed capability package, which the owned pipeline can't carry. */
  | 'installed_package'
  /**
   * An interface mode with no model: the native send keeps it only for a
   * Claude chat, which the default model decides at run time.
   */
  | 'interface_mode_unresolved'
  /** Settings D11 refuses for a run an agent's automation starts. */
  | 'agent_settings';

export type ChatAutomationConvertibility =
  | { convertible: true }
  | { convertible: false; reason: ChatAutomationConversionRefusal };

type ConvertibleActivity = Pick<
  ScheduledActivity,
  | 'name'
  | 'action'
  | 'agentAuthor'
  | 'agentScheduledSend'
  | 'targetRequirement'
  | 'installedFrom'
>;

const CHAT_ACTION_TYPES: ReadonlySet<AutomationAction['type']> = new Set<
  AutomationAction['type']
>([
  'worktree_prompt',
  'standalone_prompt',
  'app_advisor_prompt',
  'worktree_session_prompt',
]);

function isChatAutomationAction(
  action: AutomationAction,
): action is ChatAutomationAction {
  return CHAT_ACTION_TYPES.has(action.type);
}

const EXPRESSION = '${{';

function hasLocalPluginSelections(action: ChatAutomationAction): boolean {
  const selections = action.pluginSelections;
  if (!selections) return false;
  return (
    selections.collectionIds.length > 0 ||
    (selections.bundleIds?.length ?? 0) > 0 ||
    selections.skillRefs.length > 0 ||
    selections.pluginRefs.length > 0 ||
    (selections.mcpServerRefs?.length ?? 0) > 0 ||
    (selections.unresolvedCapabilities?.length ?? 0) > 0
  );
}

/** Whether the action sets what D11 treats as authority over a chat. */
function setsAuthority(action: ChatAutomationAction): boolean {
  return (
    action.model !== undefined ||
    action.approvalMode !== undefined ||
    action.planMode !== undefined ||
    (action.plugins?.length ?? 0) > 0
  );
}

/**
 * Whether the activity's action can become an owned pipeline. The refusals
 * stay native, so they keep today's behavior.
 */
export function convertibleChatAutomation(
  activity: ConvertibleActivity,
): ChatAutomationConvertibility {
  const refuse = (
    reason: ChatAutomationConversionRefusal,
  ): ChatAutomationConvertibility => ({ convertible: false, reason });
  const { action } = activity;
  if (!isChatAutomationAction(action)) return refuse('not_a_chat_action');
  // D4, the Home scheduled task and legacy standalone chats (5c-1, 5c-2).
  if (action.type === 'worktree_session_prompt') {
    if (
      action.purpose !== undefined ||
      activity.agentScheduledSend !== undefined ||
      action.workspaceId === STANDALONE_CHAT_PROJECT_ID
    )
      return refuse('native_send');
    if (
      (action.attachmentPaths?.length ?? 0) > 0 ||
      (action.attachmentPromptContexts?.length ?? 0) > 0 ||
      (action.fileReferences?.length ?? 0) > 0 ||
      action.inputMode === 'voice'
    )
      return refuse('composer_payload');
  }
  if (action.type === 'worktree_prompt' && action.purpose === 'scheduled_task')
    return refuse('native_send');
  if (hasLocalPluginSelections(action))
    return refuse('local_plugin_selections');
  if (action.modelConfig?.speed === 'ultrafast')
    return refuse('unsupported_speed');
  if (isAgentModel(action.model)) return refuse('agent_model');
  if (activity.targetRequirement !== undefined)
    return refuse('target_requirement');
  if (
    action.type === 'worktree_prompt' &&
    action.interfaceMode !== undefined &&
    action.model === undefined
  )
    return refuse('interface_mode_unresolved');
  if (
    (action.type === 'app_advisor_prompt' &&
      activity.name.includes(EXPRESSION)) ||
    (action.type !== 'worktree_session_prompt' &&
      action.sidebarGroupName?.includes(EXPRESSION) === true)
  )
    return refuse('expression_text');
  if (
    action.type !== 'worktree_session_prompt' &&
    action.sidebarGroupName?.trim().toLowerCase() === 'none'
  )
    return refuse('reserved_group_name');
  if (activity.installedFrom?.capabilityPackage !== undefined)
    return refuse('installed_package');
  if (activity.agentAuthor !== undefined) {
    // D11: an agent-originated run chooses no plugins (nor through a prompt
    // reference) and no approval mode for a chat it creates; an Orchestrator
    // chat also takes no model, and a send into an existing chat changes no
    // authority.
    if (
      (action.plugins?.length ?? 0) > 0 ||
      action.approvalMode !== undefined ||
      action.promptReferences?.some((reference) => reference.kind === 'plugin')
    )
      return refuse('agent_settings');
    if (action.type === 'app_advisor_prompt' && action.model !== undefined)
      return refuse('agent_settings');
    if (action.type === 'worktree_session_prompt' && setsAuthority(action))
      return refuse('agent_settings');
  }
  if (action.promptReferences?.some((reference) => reference.kind === 'plugin'))
    return refuse('plugin_reference');
  return { convertible: true };
}

function isClaudeModel(model: string | undefined): boolean {
  const known = model === undefined ? undefined : resolveKnownModel(model);
  return known !== undefined && getProviderForModel(known) === 'claude';
}

/** The send step's settings inputs for an action. */
function settingsInputs(action: ChatAutomationAction): Record<string, string> {
  const config = action.modelConfig;
  const thinking =
    config?.thinkingLevel ??
    ('thinking' in action ? action.thinking : undefined);
  const fastMode =
    config?.speed !== undefined ? config.speed === 'fast' : config?.fastMode;
  // The native send drops the mode for a chat that isn't Claude's.
  const interfaceMode: ChatInterfaceMode | undefined =
    action.type === 'worktree_prompt' && isClaudeModel(action.model)
      ? action.interfaceMode
      : undefined;
  return {
    ...(action.model !== undefined ? { model: action.model } : {}),
    ...(thinking !== undefined ? { thinking_effort: thinking } : {}),
    ...(fastMode !== undefined ? { fast_mode: String(fastMode) } : {}),
    ...(action.planMode !== undefined
      ? { plan_mode: String(action.planMode) }
      : {}),
    ...(action.approvalMode !== undefined
      ? { approval_mode: action.approvalMode }
      : {}),
    ...((action.plugins?.length ?? 0) > 0
      ? { plugins: JSON.stringify(action.plugins) }
      : {}),
    ...(interfaceMode !== undefined ? { interface_mode: interfaceMode } : {}),
  };
}

/** The prompt, kept literal so the runner never evaluates it. */
function textInputs(action: ChatAutomationAction): Record<string, string> {
  return {
    text: action.prompt,
    literal_text: 'true',
    ...((action.promptReferences?.length ?? 0) > 0
      ? { text_references: JSON.stringify(action.promptReferences) }
      : {}),
  };
}

const input = (name: string): string => `\${{ inputs.${name} }}`;
const output = (step: string, name: string): string =>
  `\${{ steps.${step}.outputs.${name} }}`;

function dispatchInputs(names: readonly string[]): Pipeline['on'] {
  const inputs: Record<string, PipelineInputDef> = {};
  for (const name of names) inputs[name] = { required: false };
  return { dispatch: { inputs } };
}

function replyStep(
  owner: Record<string, string>,
  taskId: string,
  chatId: string,
): Step {
  return {
    id: STEP.reply,
    uses: 'builtin/wait-for-agent-reply',
    with: {
      ...owner,
      task_id: taskId,
      chat_id: chatId,
      message_id: output(STEP.send, 'message_id'),
      reply_timeout_minutes: REPLY_TIMEOUT_MINUTES,
    },
  };
}

function sendStep(
  action: ChatAutomationAction,
  target: Record<string, string>,
  options: { replaceEmptyChat?: boolean; newChat?: boolean } = {},
): Step {
  return {
    id: STEP.send,
    uses: 'builtin/send-agent-message',
    with: {
      ...target,
      ...textInputs(action),
      ...settingsInputs(action),
      ...(options.replaceEmptyChat ? { replace_empty_chat: 'true' } : {}),
      ...(options.newChat ? { new_chat: 'true' } : {}),
    },
  };
}

function entryTitle(name: string): string {
  const title = name.trim();
  return title.length > ENTRY_TITLE_MAX
    ? `${title.slice(0, ENTRY_TITLE_MAX - 1)}…`
    : title;
}

function steps(
  activity: ConvertibleActivity,
  action: ChatAutomationAction,
): { steps: Step[]; inputs: Record<string, string> } {
  switch (action.type) {
    case 'worktree_prompt': {
      const project = { project_id: input('project_id') };
      if (action.existingWorktreeId !== undefined) {
        const taskId = input('task_id');
        return {
          inputs: {
            project_id: action.workspaceId,
            task_id: action.existingWorktreeId,
          },
          steps: [
            // An existing target's empty tab may be a person's draft, so the
            // native send always opened its own chat; so does each existing
            // Work Entry's below.
            sendStep(
              action,
              { ...project, task_id: taskId },
              { newChat: true },
            ),
            replyStep(project, taskId, output(STEP.send, 'chat_id')),
          ],
        };
      }
      const taskId = output(STEP.worktree, 'task_id');
      return {
        inputs: {
          project_id: action.workspaceId,
          ...(action.baseBranch !== undefined
            ? { base_branch: action.baseBranch }
            : {}),
          ...(action.existingBranch !== undefined
            ? { existing_branch: action.existingBranch }
            : {}),
          ...(action.baseWorktreeId !== undefined
            ? { base_task_id: action.baseWorktreeId }
            : {}),
        },
        steps: [
          {
            id: STEP.worktree,
            uses: 'builtin/create-worktree',
            with: {
              ...project,
              ...(action.baseBranch !== undefined
                ? { base_branch: input('base_branch') }
                : {}),
              ...(action.existingBranch !== undefined
                ? { existing_branch: input('existing_branch') }
                : {}),
              ...(action.baseWorktreeId !== undefined
                ? { base_task_id: input('base_task_id') }
                : {}),
              worktree_setup: 'run',
              // A stacked worktree follows its root's group, so the native
              // action makes no group call for it; one would unstack it.
              ...(action.sidebarGroupName !== undefined &&
              action.baseWorktreeId === undefined
                ? { group: action.sidebarGroupName }
                : {}),
            },
          },
          sendStep(
            action,
            { ...project, task_id: taskId },
            { replaceEmptyChat: true },
          ),
          replyStep(project, taskId, output(STEP.send, 'chat_id')),
        ],
      };
    }
    case 'standalone_prompt': {
      const project = { project_id: input('project_id') };
      if (action.workEntryId !== undefined) {
        const taskId = input('task_id');
        return {
          inputs: {
            project_id: action.chatProjectId,
            task_id: action.workEntryId,
          },
          steps: [
            sendStep(
              action,
              { ...project, task_id: taskId },
              { newChat: true },
            ),
            replyStep(project, taskId, output(STEP.send, 'chat_id')),
          ],
        };
      }
      const taskId = output(STEP.entry, 'task_id');
      return {
        inputs: { project_id: action.chatProjectId },
        steps: [
          {
            id: STEP.entry,
            uses: 'builtin/create-project-entry',
            with: {
              ...project,
              ...(action.sidebarGroupName !== undefined
                ? { group: action.sidebarGroupName }
                : {}),
            },
          },
          sendStep(
            action,
            { ...project, task_id: taskId },
            { replaceEmptyChat: true },
          ),
          replyStep(project, taskId, output(STEP.send, 'chat_id')),
        ],
      };
    }
    case 'app_advisor_prompt': {
      // The Orchestrator emits no reply events, so its run ends at the send.
      const bot = { bot_id: input('bot_id') };
      if (action.workEntryId !== undefined)
        return {
          inputs: { bot_id: APP_ADVISOR_BOT_ID, task_id: action.workEntryId },
          steps: [
            sendStep(
              action,
              { ...bot, task_id: input('task_id') },
              { newChat: true },
            ),
          ],
        };
      return {
        inputs: { bot_id: APP_ADVISOR_BOT_ID },
        steps: [
          {
            id: STEP.entry,
            uses: 'builtin/create-bot-entry',
            with: {
              ...bot,
              title: entryTitle(activity.name),
              ...(action.sidebarGroupName !== undefined
                ? { group: action.sidebarGroupName }
                : {}),
            },
          },
          sendStep(
            action,
            { ...bot, task_id: output(STEP.entry, 'task_id') },
            { replaceEmptyChat: true },
          ),
        ],
      };
    }
    case 'worktree_session_prompt': {
      const advisor = action.workspaceId === APP_ADVISOR_PROJECT_ID;
      const owner: Record<string, string> = advisor
        ? { bot_id: input('bot_id') }
        : { project_id: input('project_id') };
      const target: Record<string, string> = {
        ...owner,
        task_id: input('task_id'),
        chat_id: input('chat_id'),
      };
      return {
        inputs: {
          ...(advisor
            ? { bot_id: APP_ADVISOR_BOT_ID }
            : { project_id: action.workspaceId }),
          task_id: action.worktreeId,
          chat_id: action.chatId,
        },
        steps: advisor
          ? [sendStep(action, target)]
          : [
              sendStep(action, target),
              replyStep(owner, input('task_id'), input('chat_id')),
            ],
      };
    }
  }
}

/**
 * The owned pipeline for a convertible activity, and the automation's inputs
 * for it. Throws for an activity `convertibleChatAutomation` refuses.
 */
export function chatAutomationToPipeline(activity: ConvertibleActivity): {
  pipeline: Pipeline;
  inputs: Record<string, string>;
} {
  const verdict = convertibleChatAutomation(activity);
  if (!verdict.convertible)
    throw new Error(`This automation can't convert (${verdict.reason}).`);
  const { action } = activity;
  if (!isChatAutomationAction(action))
    throw new Error("This automation can't convert (not_a_chat_action).");
  const built = steps(activity, action);
  return {
    pipeline: {
      name: activity.name,
      scope: 'global',
      on: dispatchInputs(Object.keys(built.inputs)),
      jobs: { [CHAT_AUTOMATION_JOB]: { steps: built.steps } },
    },
    inputs: built.inputs,
  };
}

// ---------------------------------------------------------------------------
// The reverse: an owned pipeline back to its chat action.
// ---------------------------------------------------------------------------

/** Placeholders for the send step's targets, which hold expressions. */
const TARGET_PLACEHOLDERS: Readonly<Record<string, string>> = {
  project_id: 'project',
  bot_id: 'bot',
  task_id: 'task',
  chat_id: 'chat',
};

function stringWith(step: Step | undefined): Record<string, string> | null {
  if (!step) return null;
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(step.with ?? {})) {
    if (typeof value !== 'string') return null;
    values[key] = value;
  }
  return values;
}

/** The action fields the send step carries, through the step's own parser. */
function sendFields(send: Record<string, string>): {
  prompt: string;
  promptReferences?: ConfiguredPromptReference[];
  model?: string;
  modelConfig?: AgentModelConfig;
  planMode?: boolean;
  approvalMode?: ApprovalMode;
  plugins?: ShareablePluginRef[];
  interfaceMode?: ChatInterfaceMode;
} | null {
  const values: Record<string, string> = { ...send };
  for (const [key, placeholder] of Object.entries(TARGET_PLACEHOLDERS))
    if (key in values) values[key] = placeholder;
  const parsed = parseSendAgentMessageInputs(values);
  if (!parsed.ok || parsed.value.text.kind !== 'inline') return null;
  const { settings } = parsed.value;
  const modelConfig: AgentModelConfig = {
    ...(settings.thinkingEffort !== undefined
      ? { thinkingLevel: settings.thinkingEffort }
      : {}),
    ...(settings.fastMode !== undefined
      ? {
          speed: settings.fastMode ? 'fast' : 'standard',
          fastMode: settings.fastMode,
        }
      : {}),
  };
  return {
    prompt: parsed.value.text.text,
    ...(parsed.value.textReferences !== undefined
      ? { promptReferences: parsed.value.textReferences }
      : {}),
    ...(settings.model !== undefined ? { model: settings.model } : {}),
    ...(Object.keys(modelConfig).length > 0 ? { modelConfig } : {}),
    ...(settings.planMode !== undefined ? { planMode: settings.planMode } : {}),
    ...(settings.approvalMode !== undefined
      ? { approvalMode: settings.approvalMode }
      : {}),
    ...(settings.plugins !== undefined ? { plugins: settings.plugins } : {}),
    ...(settings.interfaceMode !== undefined
      ? { interfaceMode: settings.interfaceMode }
      : {}),
  };
}

/** The candidate action and name an owned pipeline's shape describes. */
function candidate(
  pipeline: Pipeline,
  inputs: Readonly<Record<string, string>>,
  isCoworkProject: (projectId: string) => boolean,
): { name: string; action: AutomationAction } | null {
  const job = pipeline.jobs[CHAT_AUTOMATION_JOB];
  if (!job) return null;
  const [first] = job.steps;
  const send = stringWith(job.steps.find((step) => step.id === STEP.send));
  const firstWith = stringWith(first);
  if (!first || !send || !firstWith) return null;
  const fields = sendFields(send);
  if (!fields) return null;
  const { interfaceMode, ...common } = fields;
  const group =
    firstWith.group !== undefined ? { sidebarGroupName: firstWith.group } : {};
  const name = pipeline.name;
  switch (first.uses) {
    case 'builtin/create-worktree':
      if (inputs.project_id === undefined) return null;
      return {
        name,
        action: {
          type: 'worktree_prompt',
          workspaceId: inputs.project_id,
          ...(inputs.base_branch !== undefined
            ? { baseBranch: inputs.base_branch }
            : {}),
          ...(inputs.existing_branch !== undefined
            ? { existingBranch: inputs.existing_branch }
            : {}),
          ...(inputs.base_task_id !== undefined
            ? { baseWorktreeId: inputs.base_task_id }
            : {}),
          ...group,
          ...common,
          ...(interfaceMode !== undefined ? { interfaceMode } : {}),
        },
      };
    case 'builtin/create-project-entry':
      if (inputs.project_id === undefined) return null;
      return {
        name,
        action: {
          type: 'standalone_prompt',
          chatProjectId: inputs.project_id,
          ...group,
          ...common,
        },
      };
    case 'builtin/create-bot-entry':
      // The title is the automation's name, cut to the step's limit.
      return {
        name: firstWith.title ?? name,
        action: { type: 'app_advisor_prompt', ...group, ...common },
      };
    case 'builtin/send-agent-message': {
      const taskId = inputs.task_id;
      if (taskId === undefined) return null;
      if (inputs.chat_id !== undefined)
        return {
          name,
          action: {
            type: 'worktree_session_prompt',
            workspaceId:
              inputs.bot_id !== undefined
                ? APP_ADVISOR_PROJECT_ID
                : (inputs.project_id ?? ''),
            worktreeId: taskId,
            chatId: inputs.chat_id,
            ...common,
          },
        };
      if (inputs.bot_id !== undefined)
        return {
          name,
          action: {
            type: 'app_advisor_prompt',
            workEntryId: taskId,
            ...common,
          },
        };
      if (inputs.project_id === undefined) return null;
      return isCoworkProject(inputs.project_id)
        ? {
            name,
            action: {
              type: 'standalone_prompt',
              chatProjectId: inputs.project_id,
              workEntryId: taskId,
              ...common,
            },
          }
        : {
            name,
            action: {
              type: 'worktree_prompt',
              workspaceId: inputs.project_id,
              existingWorktreeId: taskId,
              ...common,
              ...(interfaceMode !== undefined ? { interfaceMode } : {}),
            },
          };
    }
    default:
      return null;
  }
}

/** Structural equality for JSON-shaped values, ignoring key order. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    );
  }
  if (
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    left === null ||
    right === null
  )
    return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        sameJson(Reflect.get(left, key), Reflect.get(right, key)),
    )
  );
}

/**
 * The chat action an owned pipeline was generated from, or `null` when the
 * pipeline no longer has a shape the converter produces (a hand edit, for
 * example). The candidate is regenerated and must match exactly.
 * `isCoworkProject` tells an existing Work Entry from an existing worktree,
 * whose pipelines are the same.
 */
export function ownedPipelineToChatAction(
  pipeline: Pipeline,
  inputs: Readonly<Record<string, string>>,
  isCoworkProject: (projectId: string) => boolean,
): ChatAutomationAction | null {
  const found = candidate(pipeline, inputs, isCoworkProject);
  if (!found || !isChatAutomationAction(found.action)) return null;
  const activity = { name: found.name, action: found.action };
  if (!convertibleChatAutomation(activity).convertible) return null;
  const regenerated = chatAutomationToPipeline(activity);
  // The pipeline's name is the automation's own; everything else must match,
  // so any hand edit (a step, env, defaults) keeps the pipeline as it is.
  return sameJson(regenerated.pipeline, {
    ...pipeline,
    name: regenerated.pipeline.name,
  }) && sameJson(regenerated.inputs, inputs)
    ? found.action
    : null;
}
