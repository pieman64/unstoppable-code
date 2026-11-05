/**
 * Chat automation conversion (CAN-4551, step 7a): a chat automation's action
 * as an automation-owned global pipeline built from the host steps, and back.
 *
 * Browser-safe; it reads only the model catalog, to keep a Claude interface
 * mode for a Claude model alone. Conversion is lossless or refused: an action
 * whose settings the steps can't carry exactly stays native. Every local ID,
 * attachment, Agent and local plugin selection is a pipeline input or an
 * automation model or plugin collection preference, never a YAML literal:
 * local plugin selections are the automation's preferences for a plugin
 * collection the YAML names with no defaults. The prompt stays literal
 * in the YAML (`literal_text`), so sharing, which strips input values, keeps
 * it. A run restriction isn't converted: a valid one is the chat action's own
 * single context, which desktop main checks before it drops it (CAN-5479).
 */
import { APP_ADVISOR_BOT_ID } from '@canopy/agent-actions/families/bots/actions';
import type {
  AgentModelConfig,
  ApprovalMode,
  AutomationAction,
  ChatInterfaceMode,
  ChatTabPluginSelections,
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
import type {
  Pipeline,
  PipelineAgentModelAliasPreference,
  PipelineInputDef,
  PipelinePluginCollectionPreference,
  Step,
} from '../types/pipeline';
import { parseAgentRouteModelId } from '@canopy/protocol/agents';
import type { ConfiguredPromptReference } from '@canopy/protocol/configured-prompt-references';
import type {
  ChatAttachmentPromptContext,
  FileReference,
} from '@canopy/agent-transcript/types';
import { parseSendAgentMessageInputs } from '../pipelines/host-send-agent-message';
import { normalizePluginSelections } from './plugin-selections-normalization';

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

/**
 * The automation input that keeps a composer scheduled send's `purpose`
 * through conversion (CAN-5479).
 */
const SCHEDULED_SEND_INPUT = 'purpose';

/** A Work Entry title is at most this long (`create-bot-entry`). */
const ENTRY_TITLE_MAX = 200;

/**
 * The model alias an Agent model converts to: the send step can't name an
 * Agent model id, so the automation's model preferences map the alias to the
 * Agent, and the local Agent id stays out of the YAML.
 */
export const CHAT_AUTOMATION_MODEL_ALIAS = 'chat_model';

/**
 * The plugin collection local plugin selections convert to: the YAML names
 * it with no defaults, and the automation's plugin collection preferences
 * hold the selections, so they stay out of the YAML (CAN-5479).
 */
export const CHAT_AUTOMATION_PLUGIN_COLLECTION = 'chat_plugins';

/** The automation's plugin collection preferences for its owned pipeline. */
export type ChatAutomationPluginCollectionPreferences = Record<
  string,
  PipelinePluginCollectionPreference
>;

/** The automation's model preferences for its owned pipeline's alias. */
export type ChatAutomationModelAliasPreferences = Record<
  string,
  PipelineAgentModelAliasPreference
>;

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
  /**
   * A D4 send (a usage-limit resume or an agent's scheduled send), the Home
   * scheduled task or a legacy standalone chat.
   */
  | 'native_send'
  /** Settings D11 refuses for a run an agent's automation starts. */
  | 'agent_settings'
  /**
   * A pinned Agent route, which only the automation's own native send may
   * start a chat on (CAN-5379).
   */
  | 'agent_route';

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

/**
 * An expression that evaluates to `${{`. Create steps interpolate their title
 * and group once, so each `${{` written as this comes out as written.
 */
const ESCAPED_EXPRESSION = "${{ '${{' }}";

/** Text a create step interpolates to `text`, exactly. */
function escapeExpressions(text: string): string {
  return text.split(EXPRESSION).join(ESCAPED_EXPRESSION);
}

function unescapeExpressions(text: string): string {
  return text.split(ESCAPED_EXPRESSION).join(EXPRESSION);
}

function hasLocalPluginSelections(action: ChatAutomationAction): boolean {
  const selections = action.pluginSelections;
  if (!selections) return false;
  return (
    selections.collectionIds.length > 0 ||
    (selections.bundleIds?.length ?? 0) > 0 ||
    selections.skillRefs.length > 0 ||
    selections.pluginRefs.length > 0 ||
    (selections.mcpServerRefs?.length ?? 0) > 0 ||
    (selections.mcpHttpAuthPreferences?.length ?? 0) > 0 ||
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
  // D4, the Home scheduled task and legacy standalone chats (5c-1, 5c-2). A
  // person's composer scheduled send converts (CAN-5479), keeping its
  // `purpose` as an automation input so the edit form still treats it as
  // composer-authored.
  if (action.type === 'worktree_session_prompt') {
    if (
      action.purpose === 'usage_limit_resume' ||
      activity.agentScheduledSend !== undefined ||
      action.workspaceId === STANDALONE_CHAT_PROJECT_ID
    )
      return refuse('native_send');
  }
  if (action.type === 'worktree_prompt' && action.purpose === 'scheduled_task')
    return refuse('native_send');
  if (action.model !== undefined && parseAgentRouteModelId(action.model))
    return refuse('agent_route');
  // D11: a send into an existing chat changes no authority (local plugin
  // selections included), and an agent's run takes no plugins through a
  // prompt reference or a file reference nothing contains. A chat an agent's automation creates keeps the plugins,
  // approval mode and Orchestrator model its native action set (CAN-5479):
  // main records them as the owned pipeline's native grant, and honors them
  // only for that automation's run of that exact revision.
  if (activity.agentAuthor !== undefined) {
    if (
      action.promptReferences?.some((reference) => reference.kind === 'plugin')
    )
      return refuse('agent_settings');
    if (
      action.type === 'worktree_session_prompt' &&
      (setsAuthority(action) ||
        hasLocalPluginSelections(action) ||
        (action.fileReferences?.length ?? 0) > 0)
    )
      return refuse('agent_settings');
  }
  return { convertible: true };
}

/**
 * Whether the native send could keep a Claude interface mode: for a Claude
 * model, and for no model or an Agent that inherits one, where the default
 * model decides at run time (desktop main resolves it then).
 */
function mayKeepInterfaceMode(model: string | undefined): boolean {
  if (model === undefined) return true;
  const known = resolveKnownModel(model);
  const provider = known === undefined ? undefined : getProviderForModel(known);
  return provider === undefined ? isAgentModel(model) : provider === 'claude';
}

/** The send step's settings inputs for an action. */
function settingsInputs(action: ChatAutomationAction): Record<string, string> {
  const config = action.modelConfig;
  const thinking =
    config?.thinkingLevel ??
    ('thinking' in action ? action.thinking : undefined);
  // `fast_mode` carries Regular and Fast, as it always has; only Ultra fast
  // needs `speed`.
  const ultrafast = config?.speed === 'ultrafast';
  const fastMode = ultrafast
    ? undefined
    : config?.speed !== undefined
      ? config.speed === 'fast'
      : config?.fastMode;
  // The native send drops the mode for a chat that isn't Claude's.
  const interfaceMode: ChatInterfaceMode | undefined =
    action.type === 'worktree_prompt' && mayKeepInterfaceMode(action.model)
      ? action.interfaceMode
      : undefined;
  return {
    ...(action.model !== undefined
      ? {
          model: isAgentModel(action.model)
            ? CHAT_AUTOMATION_MODEL_ALIAS
            : action.model,
        }
      : {}),
    ...(thinking !== undefined ? { thinking_effort: thinking } : {}),
    ...(fastMode !== undefined ? { fast_mode: String(fastMode) } : {}),
    ...(ultrafast ? { speed: 'ultrafast' } : {}),
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

/**
 * Send step inputs whose values are local, so they are automation inputs, as
 * target IDs are: a session prompt's composer payload (absolute attachment
 * paths, their prompt contexts, legacy file references and voice input).
 */
const VALUE_INPUTS = [
  'attachment_paths',
  'attachment_prompt_contexts',
  'file_references',
  'input_mode',
] as const;

/** The automation inputs the send step reads with `VALUE_INPUTS`. */
function valueInputs(action: ChatAutomationAction): Record<string, string> {
  const values: Record<string, string> = {};
  if (action.type !== 'worktree_session_prompt') return values;
  if (action.attachmentPaths !== undefined)
    values.attachment_paths = JSON.stringify(action.attachmentPaths);
  if (action.attachmentPromptContexts !== undefined)
    values.attachment_prompt_contexts = JSON.stringify(
      action.attachmentPromptContexts,
    );
  // None sends as no input: an agent's run refuses any file references.
  if ((action.fileReferences?.length ?? 0) > 0)
    values.file_references = JSON.stringify(action.fileReferences);
  if (action.inputMode !== undefined) values.input_mode = action.inputMode;
  return values;
}

/**
 * The automation's preferences for its plugin collection: the action's local
 * selections, exactly as the preference store keeps them. None when it
 * selects nothing.
 */
function pluginCollectionPreferences(
  action: ChatAutomationAction,
): ChatAutomationPluginCollectionPreferences | undefined {
  if (!action.pluginSelections || !hasLocalPluginSelections(action))
    return undefined;
  const {
    collectionIds,
    skillRefs,
    pluginRefs,
    mcpServerRefs,
    mcpHttpAuthPreferences,
    unresolvedCapabilities,
  } = normalizePluginSelections(action.pluginSelections);
  return {
    [CHAT_AUTOMATION_PLUGIN_COLLECTION]: {
      disabledDefaultKeys: [],
      extraSelections: {
        collectionIds,
        skillRefs,
        pluginRefs,
        mcpServerRefs: mcpServerRefs ?? [],
        mcpHttpAuthPreferences: mcpHttpAuthPreferences ?? [],
        ...(unresolvedCapabilities !== undefined
          ? { unresolvedCapabilities }
          : {}),
      },
    },
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
  const values: Record<string, string> = {};
  for (const name of Object.keys(valueInputs(action)))
    values[name] = input(name);
  return {
    id: STEP.send,
    uses: 'builtin/send-agent-message',
    with: {
      ...target,
      ...textInputs(action),
      ...settingsInputs(action),
      ...(pluginCollectionPreferences(action) !== undefined
        ? { plugin_collection_id: CHAT_AUTOMATION_PLUGIN_COLLECTION }
        : {}),
      ...values,
      ...(options.replaceEmptyChat ? { replace_empty_chat: 'true' } : {}),
      ...(options.newChat ? { new_chat: 'true' } : {}),
    },
  };
}

/** The automation's name, cut to the step's limit, then escaped. */
function entryTitle(name: string): string {
  const title = name.trim();
  return escapeExpressions(
    title.length > ENTRY_TITLE_MAX
      ? `${title.slice(0, ENTRY_TITLE_MAX - 1)}…`
      : title,
  );
}

/** A create step's `group`, escaped; a stacked worktree takes none. */
function groupInput(name: string | undefined): Record<string, string> {
  return name !== undefined ? { group: escapeExpressions(name) } : {};
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
              ...(action.baseWorktreeId === undefined
                ? groupInput(action.sidebarGroupName)
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
              ...groupInput(action.sidebarGroupName),
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
              ...groupInput(action.sidebarGroupName),
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
          // No step reads it; the edit form does, to keep a composer's send
          // read-only, so the reverse restores it (CAN-5479).
          ...(action.purpose === 'scheduled_send'
            ? { [SCHEDULED_SEND_INPUT]: action.purpose }
            : {}),
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
 * and model preferences for it. Throws for an activity
 * `convertibleChatAutomation` refuses.
 */
export function chatAutomationToPipeline(activity: ConvertibleActivity): {
  pipeline: Pipeline;
  inputs: Record<string, string>;
  modelAliasPreferences?: ChatAutomationModelAliasPreferences;
  pluginCollectionPreferences?: ChatAutomationPluginCollectionPreferences;
} {
  const verdict = convertibleChatAutomation(activity);
  if (!verdict.convertible)
    throw new Error(`This automation can't convert (${verdict.reason}).`);
  const { action } = activity;
  if (!isChatAutomationAction(action))
    throw new Error("This automation can't convert (not_a_chat_action).");
  const built = steps(activity, action);
  const inputs = { ...built.inputs, ...valueInputs(action) };
  const agent = isAgentModel(action.model) ? action.model : undefined;
  const plugins = pluginCollectionPreferences(action);
  return {
    pipeline: {
      name: activity.name,
      scope: 'global',
      on: dispatchInputs(Object.keys(inputs)),
      ...(agent !== undefined
        ? {
            model_aliases: [
              { id: CHAT_AUTOMATION_MODEL_ALIAS, name: 'Chat agent' },
            ],
          }
        : {}),
      ...(plugins !== undefined
        ? {
            plugin_collections: [
              {
                id: CHAT_AUTOMATION_PLUGIN_COLLECTION,
                name: 'Chat plugins',
                defaults: [],
              },
            ],
          }
        : {}),
      jobs: { [CHAT_AUTOMATION_JOB]: { steps: built.steps } },
    },
    inputs,
    ...(agent !== undefined
      ? {
          modelAliasPreferences: {
            [CHAT_AUTOMATION_MODEL_ALIAS]: { mode: 'agent', agent_id: agent },
          },
        }
      : {}),
    ...(plugins !== undefined ? { pluginCollectionPreferences: plugins } : {}),
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

/** The Agent an automation's model preferences map the chat alias to. */
function aliasAgent(
  pipeline: Pipeline,
  preferences: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (
    !pipeline.model_aliases?.some(
      (alias) => alias.id === CHAT_AUTOMATION_MODEL_ALIAS,
    )
  )
    return undefined;
  const preference: unknown = preferences?.[CHAT_AUTOMATION_MODEL_ALIAS];
  if (typeof preference !== 'object' || preference === null) return undefined;
  const mode: unknown = Reflect.get(preference, 'mode');
  const agentId: unknown = Reflect.get(preference, 'agent_id');
  return mode === 'agent' && typeof agentId === 'string' ? agentId : undefined;
}

/** The local selections an automation's plugin collection preferences hold. */
function collectionSelections(
  preferences: Readonly<Record<string, unknown>> | undefined,
): ChatTabPluginSelections | undefined {
  const preference: unknown = preferences?.[CHAT_AUTOMATION_PLUGIN_COLLECTION];
  if (typeof preference !== 'object' || preference === null) return undefined;
  const extras: unknown = Reflect.get(preference, 'extraSelections');
  if (typeof extras !== 'object' || extras === null) return undefined;
  const { mcpServerRefs, mcpHttpAuthPreferences, ...selections } =
    normalizePluginSelections(extras);
  // The store keeps an empty list; the action had none.
  return {
    ...selections,
    ...((mcpServerRefs?.length ?? 0) > 0 ? { mcpServerRefs } : {}),
    ...((mcpHttpAuthPreferences?.length ?? 0) > 0
      ? { mcpHttpAuthPreferences }
      : {}),
  };
}

/** The action fields the send step carries, through the step's own parser. */
function sendFields(
  send: Record<string, string>,
  inputs: Readonly<Record<string, string>>,
  pluginPreferences: Readonly<Record<string, unknown>> | undefined,
): {
  prompt: string;
  promptReferences?: ConfiguredPromptReference[];
  model?: string;
  modelConfig?: AgentModelConfig;
  planMode?: boolean;
  approvalMode?: ApprovalMode;
  plugins?: ShareablePluginRef[];
  pluginSelections?: ChatTabPluginSelections;
  interfaceMode?: ChatInterfaceMode;
  attachmentPaths?: string[];
  attachmentPromptContexts?: ChatAttachmentPromptContext[];
  fileReferences?: FileReference[];
  inputMode?: 'typed' | 'voice';
} | null {
  const values: Record<string, string> = { ...send };
  for (const [key, placeholder] of Object.entries(TARGET_PLACEHOLDERS))
    if (key in values) values[key] = placeholder;
  // A value input reads its automation input, exactly as generated.
  for (const name of VALUE_INPUTS) {
    if (!(name in values)) continue;
    const value = inputs[name];
    if (values[name] !== input(name) || value === undefined) return null;
    values[name] = value;
  }
  const parsed = parseSendAgentMessageInputs(values);
  if (!parsed.ok || parsed.value.text.kind !== 'inline') return null;
  const { pluginCollectionId } = parsed.value;
  const settings = { ...parsed.value.settings };
  if (pluginCollectionId !== undefined) {
    const selections = collectionSelections(pluginPreferences);
    if (
      pluginCollectionId !== CHAT_AUTOMATION_PLUGIN_COLLECTION ||
      selections === undefined
    )
      return null;
    settings.pluginSelections = selections;
  }
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
    ...(settings.speed !== undefined
      ? { speed: settings.speed, fastMode: settings.speed === 'fast' }
      : {}),
  };
  const composer = parsed.value;
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
    ...(settings.pluginSelections !== undefined
      ? { pluginSelections: settings.pluginSelections }
      : {}),
    ...(settings.interfaceMode !== undefined
      ? { interfaceMode: settings.interfaceMode }
      : {}),
    ...(composer.attachmentPaths !== undefined
      ? { attachmentPaths: composer.attachmentPaths }
      : {}),
    ...(composer.attachmentPromptContexts !== undefined
      ? { attachmentPromptContexts: composer.attachmentPromptContexts }
      : {}),
    ...(composer.fileReferences !== undefined
      ? { fileReferences: composer.fileReferences }
      : {}),
    ...(composer.inputMode !== undefined
      ? { inputMode: composer.inputMode }
      : {}),
  };
}

/** The candidate action and name an owned pipeline's shape describes. */
function candidate(
  pipeline: Pipeline,
  inputs: Readonly<Record<string, string>>,
  isCoworkProject: (projectId: string) => boolean,
  modelAliasPreferences: Readonly<Record<string, unknown>> | undefined,
  pluginCollectionPreferences: Readonly<Record<string, unknown>> | undefined,
): { name: string; action: AutomationAction } | null {
  const job = pipeline.jobs[CHAT_AUTOMATION_JOB];
  if (!job) return null;
  const [first] = job.steps;
  const send = stringWith(job.steps.find((step) => step.id === STEP.send));
  const firstWith = stringWith(first);
  if (!first || !send || !firstWith) return null;
  const fields = sendFields(send, inputs, pluginCollectionPreferences);
  if (!fields) return null;
  if (fields.model === CHAT_AUTOMATION_MODEL_ALIAS) {
    const agent = aliasAgent(pipeline, modelAliasPreferences);
    if (agent === undefined) return null;
    fields.model = agent;
  }
  const {
    interfaceMode,
    attachmentPaths,
    attachmentPromptContexts,
    fileReferences,
    inputMode,
    ...common
  } = fields;
  const composer = {
    ...(attachmentPaths !== undefined ? { attachmentPaths } : {}),
    ...(attachmentPromptContexts !== undefined
      ? { attachmentPromptContexts }
      : {}),
    ...(fileReferences !== undefined ? { fileReferences } : {}),
    ...(inputMode !== undefined ? { inputMode } : {}),
  };
  // Only a session prompt carries a composer payload.
  if (
    first.uses !== 'builtin/send-agent-message' &&
    Object.keys(composer).length > 0
  )
    return null;
  const group =
    firstWith.group !== undefined
      ? { sidebarGroupName: unescapeExpressions(firstWith.group) }
      : {};
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
        name:
          firstWith.title !== undefined
            ? unescapeExpressions(firstWith.title)
            : name,
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
            ...composer,
            ...(inputs[SCHEDULED_SEND_INPUT] === 'scheduled_send'
              ? { purpose: 'scheduled_send' as const }
              : {}),
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
  /** The automation's `modelAliasPreferences`, which name its Agent. */
  modelAliasPreferences?: Readonly<Record<string, unknown>>,
  /** The automation's `pluginCollectionPreferences`, which hold its plugins. */
  pluginCollectionPreferences?: Readonly<Record<string, unknown>>,
): ChatAutomationAction | null {
  const found = candidate(
    pipeline,
    inputs,
    isCoworkProject,
    modelAliasPreferences,
    pluginCollectionPreferences,
  );
  if (!found || !isChatAutomationAction(found.action)) return null;
  const activity = { name: found.name, action: found.action };
  if (!convertibleChatAutomation(activity).convertible) return null;
  const regenerated = chatAutomationToPipeline(activity);
  // The pipeline's name is the automation's own; everything else must match,
  // so any hand edit (a step, env, defaults, a model or plugin collection
  // preference) keeps the pipeline as it is.
  return sameJson(regenerated.pipeline, {
    ...pipeline,
    name: regenerated.pipeline.name,
  }) &&
    sameJson(regenerated.inputs, inputs) &&
    sameJson(
      regenerated.modelAliasPreferences ?? {},
      modelAliasPreferences ?? {},
    ) &&
    sameJson(
      regenerated.pluginCollectionPreferences ?? {},
      pluginCollectionPreferences ?? {},
    )
    ? found.action
    : null;
}
