/**
 * Desktop main's `send-agent-message` host step.
 *
 * Sends one message to a project or Orchestrator chat through the admitted
 * send path (`dispatchPipelineProjectBotAction`): the same orchestrations,
 * owner checks, approval admission and sender attribution agents use. It can
 * create the chat, queue behind a running turn, steer into it, or wait for a
 * code task's setup, and it applies per-turn settings (D2). It never writes a
 * chat itself.
 *
 * No double sends. Every ID the send uses is chosen and journaled before the
 * first dispatch, and a created chat is journaled before its first message is
 * sent, so a resumed attempt dispatches again with the same IDs and the chat
 * answers with the original receipt. Once the first dispatch may start, the
 * operation runs to completion whatever its callers do. Concurrent calls with
 * one idempotency key share a live operation. A job retry is a new attempt (a
 * new key) and sends a new message.
 *
 * Message text, file paths, pipeline names and chat titles are user data:
 * never logged, never echoed in errors and never journaled.
 */
import { randomUUID } from 'node:crypto';
import type {
  PipelineHostActionCaller,
  PipelineHostActionControls,
  PipelineHostActionResult,
} from '@canopy/desktop-shared/node/pipelines/executor/types';
import {
  PipelineHostRefusal,
  type PipelineHostFailureReason,
} from '@canopy/desktop-shared/pipelines/host-actions';
import {
  emptySendAgentMessageOutputs,
  parsePipelineChatSendRecord,
  SEND_AGENT_MESSAGE_AUTHORITY_INPUTS,
  type ResolvedSendAgentMessageInputs,
  type SendAgentMessageSettings,
  type SendAgentMessageSteerUnavailableReason,
} from '@canopy/desktop-shared/pipelines/host-send-agent-message';
import { acceptedInputReceiptSchema } from '@canopy/desktop-shared/lib/chat-send-actions';
import { interpolateAutomationIfCommandOutput } from '@canopy/desktop-shared/lib/automations';
import { mapConfiguredPromptText } from '@canopy/protocol/configured-prompt-references';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  getProviderForModel,
  hasAnySelections,
  resolveKnownModel,
  type AgentModelConfig,
  type AgentProviderType,
  type ChatSendAutomationDispatch,
  type ChatSendTurnOverride,
  type ChatTabPluginSelections,
  type FileReference,
  type WorkspaceType,
} from '@canopy/desktop-shared/types';
import { AGENT_MODEL_PREFIX } from '@canopy/desktop-shared/types/agent-models';
import type { PipelineChatSendRecord } from '@canopy/desktop-shared/types/pipeline';
import { z } from 'zod';
import { dispatchPipelineProjectBotAction } from '../agent-actions/desktop-project-bot-port';
import {
  pipelineTrustedCaller,
  type PipelineTrustedCaller,
} from '../agent-messaging/pipeline-caller';
import type { PipelineNewChatSeed } from '../agent-messaging/send-orchestration';
import type { PipelineSenderSource } from '../agent-messaging/sender-context';
import { ADVISOR_ACCESS_DISABLED_MESSAGE } from '../lib/app-advisor-project-agent-access';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import {
  logMainProcessError,
  logMainProcessWarn,
} from '../lib/main-process-logging';
import {
  abortError,
  DIFFERENT_INPUTS_MESSAGE,
  errorType,
  waitOrAbort,
} from './host-create-entry';
import {
  createSendFingerprint,
  readSendJournal,
  writeSendJournal,
  type SendJournalRecord,
} from './host-send-agent-message-state';
import {
  projectUnavailable,
  resolveTask,
  type PipelineHostOwnerCheck,
} from './host-task-resolution';

const LABEL = 'send-agent-message';

/** How long decision C waits before it looks for the message a second time. */
const TRANSCRIPT_RECHECK_MS = 250;

export interface SendAgentMessageHostDeps {
  assertTargetOwner: PipelineHostOwnerCheck;
  /** Injected in tests; defaults to `dispatchPipelineProjectBotAction`. */
  dispatch?: typeof dispatchPipelineProjectBotAction;
  /** Injected in tests; defaults to the chat-state service's transcript lookup. */
  hasTranscriptMessage?: (
    scope: { projectId: string; worktreeId: string },
    chatId: string,
    messageId: string,
  ) => Promise<boolean>;
  /** Injected in tests; the decision C re-check delay. */
  transcriptRecheckMs?: number;
}

/** The resolved target: where its tabs live, and how it is named. */
interface SendTarget {
  kind: 'project' | 'bot';
  /** The project or bot id. */
  id: string;
  taskId: string;
  /** Where the task's tabs and transcripts live. */
  tabsProjectId: string;
  workspaceType?: WorkspaceType;
  chatId?: string;
  /** Empty outputs with the target's ids set. */
  baseOutputs: Record<string, string>;
}

/** The port's response, read the way step 4 reads it. */
const portResponseSchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

type PortResponse = z.infer<typeof portResponseSchema>;

interface PortError {
  code: string;
  message: string;
}

type AcceptedInput = z.infer<typeof acceptedInputReceiptSchema>;

const creationReceiptSchema = z.object({
  address: z.union([
    z.object({ projectId: z.string(), taskId: z.string(), chatId: z.string() }),
    z.object({ botId: z.string(), taskId: z.string(), chatId: z.string() }),
  ]),
  chatCreated: z.boolean(),
  input: acceptedInputReceiptSchema.optional(),
});

const steeredReceiptSchema = z.object({
  queuedMessageId: z.string(),
  disposition: z.literal('steered'),
});

const CHAT_UNREADABLE_MESSAGE =
  "This step's earlier attempt couldn't be read. Check the chat before retrying.";

const TIMED_OUT_MESSAGE =
  'Timed out before the chat confirmed the message. Check the chat before retrying: a retry sends it again.';

const STEER_TIMED_OUT_MESSAGE =
  'Timed out while steering the message. The chat had already queued it.';

const STEER_FAILED_MESSAGE =
  "The message is queued, but it couldn't be steered into the running turn.";

const AGENT_AUTHORITY_MESSAGE =
  "Agent-started pipelines can't change an existing chat's model, plan mode, approval mode, or plugins.";

function failure(
  target: SendTarget,
  failureReason: PipelineHostFailureReason,
  error: string,
  outputs: Record<string, string> = {},
  chatSend?: PipelineChatSendRecord,
): PipelineHostActionResult {
  return {
    status: 'failure',
    failureReason,
    error,
    outputs: { ...target.baseOutputs, ...outputs },
    ...(chatSend !== undefined ? { chatSend } : {}),
  };
}

function chatNotInTask(chatId: string, taskId: string): string {
  return `Chat \`${chatId}\` isn't in task \`${taskId}\``;
}

/** A port refusal as a typed failure; anything unmapped throws. */
function mapRefusal(
  target: SendTarget,
  error: PortError,
  outputs: Record<string, string> = {},
  chatSend?: PipelineChatSendRecord,
): PipelineHostActionResult {
  const fail = (
    reason: PipelineHostFailureReason,
    message: string,
  ): PipelineHostActionResult =>
    failure(target, reason, message, outputs, chatSend);
  switch (error.code) {
    case 'not_found':
      // Worded like a missing target, so an owner boundary reveals nothing.
      if (target.chatId !== undefined) {
        return fail('not_found', chatNotInTask(target.chatId, target.taskId));
      }
      return fail(
        'not_found',
        target.kind === 'project'
          ? projectUnavailable(target.id)
          : `Bot \`${target.id}\` isn't available to this pipeline`,
      );
    case 'advisor_access_disabled':
      return fail('advisor_access_disabled', ADVISOR_ACCESS_DISABLED_MESSAGE);
    case 'owner_context_unavailable':
      return fail(
        'owner_context_unavailable',
        "This pipeline's owner can't be checked right now. Try again.",
      );
    case 'validation_failed':
    case 'invalid_payload':
      return fail('validation_failed', error.message);
    case 'invalid_target':
    case 'stale_ui_state':
    case 'missing_capability':
      return fail('target_not_ready', error.message);
    case 'in_progress':
      return fail(
        'target_not_ready',
        'An earlier attempt of this step is still running.',
      );
    case 'unsupported_action':
      return fail('unsupported_action', error.message);
    case 'authorization_conflict':
      return fail('authorization_conflict', error.message);
    case 'idempotency_conflict':
      return fail('authorization_conflict', DIFFERENT_INPUTS_MESSAGE);
    default:
      throw new Error(
        `${LABEL} failed with an unexpected ${error.code} refusal`,
      );
  }
}

/**
 * The target and the owner check, before any type-specific refusal, journal
 * read or dispatch. A cross-owner project reads like a missing one.
 */
async function resolveSendTarget(
  inputs: ResolvedSendAgentMessageInputs,
  caller: PipelineHostActionCaller,
  deps: SendAgentMessageHostDeps,
): Promise<SendTarget> {
  const requested = inputs.target;
  const { target } = await resolveTask(
    requested.kind === 'project'
      ? {
          kind: 'project',
          projectId: requested.projectId,
          taskId: requested.taskId,
        }
      : { kind: 'bot', botId: requested.botId, taskId: requested.taskId },
  );
  await deps.assertTargetOwner(caller, target);
  const { chatId } = requested;
  const chatOutputs: Record<string, string> =
    chatId !== undefined ? { chat_id: chatId } : {};
  const resolved: SendTarget =
    target.kind === 'project'
      ? {
          kind: 'project',
          id: target.projectId,
          taskId: requested.taskId,
          tabsProjectId: target.projectId,
          workspaceType: target.workspaceType,
          ...(chatId !== undefined ? { chatId } : {}),
          baseOutputs: {
            ...emptySendAgentMessageOutputs(),
            project_id: target.projectId,
            task_id: requested.taskId,
            ...chatOutputs,
          },
        }
      : {
          kind: 'bot',
          id: target.botId,
          taskId: target.taskId,
          tabsProjectId: APP_ADVISOR_PROJECT_ID,
          ...(chatId !== undefined ? { chatId } : {}),
          baseOutputs: {
            ...emptySendAgentMessageOutputs(),
            bot_id: target.botId,
            task_id: target.taskId,
            ...chatOutputs,
          },
        };
  if (resolved.kind === 'bot' && inputs.mode === 'steer') {
    throw new PipelineHostRefusal(
      'unsupported_action',
      "Orchestrator chats can't be steered",
    );
  }
  if (chatId !== undefined) {
    // An unreadable tabs file is an error, never proof the chat is missing.
    const { tabs } = await readChatTabsFile(
      resolved.tabsProjectId,
      resolved.taskId,
    );
    const tab = tabs.find(
      (candidate) =>
        candidate.id === chatId && (candidate.kind ?? 'chat') === 'chat',
    );
    if (!tab) {
      throw new PipelineHostRefusal(
        'not_found',
        chatNotInTask(chatId, resolved.taskId),
      );
    }
    if (tab.readOnly) {
      throw new PipelineHostRefusal(
        'unsupported_action',
        `Chat \`${chatId}\` is read-only`,
      );
    }
  }
  return resolved;
}

/** The sender title's source: the execution's trusted fields, never step inputs. */
function senderSource(
  caller: PipelineHostActionCaller,
  trusted: PipelineTrustedCaller,
): PipelineSenderSource {
  const pipelineId = caller.pipelineId ?? caller.executionId;
  const { initiator } = caller;
  return {
    executionId: trusted.executionId,
    pipelineId,
    stepId: trusted.stepId,
    pipelineName: caller.pipelineName || pipelineId,
    ...(initiator?.kind === 'automation'
      ? {
          automation: {
            automationId: initiator.automationId,
            automationName: initiator.automationName || initiator.automationId,
          },
        }
      : {}),
    owner: trusted.owner,
    ...(trusted.agentOrigin !== undefined
      ? { agentOrigin: trusted.agentOrigin }
      : {}),
  };
}

const AUTHORITY_SETTINGS: Record<
  (typeof SEND_AGENT_MESSAGE_AUTHORITY_INPUTS)[number],
  (settings: SendAgentMessageSettings) => boolean
> = {
  approval_mode: (settings) => settings.approvalMode !== undefined,
  model: (settings) => settings.model !== undefined,
  plan_mode: (settings) => settings.planMode !== undefined,
  plugins: (settings) => (settings.plugins?.length ?? 0) > 0,
};

function modelConfigOf(
  settings: SendAgentMessageSettings,
): AgentModelConfig | undefined {
  const config: AgentModelConfig = {
    ...(settings.thinkingEffort !== undefined
      ? { thinkingLevel: settings.thinkingEffort }
      : {}),
    ...(settings.fastMode !== undefined ? { fastMode: settings.fastMode } : {}),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}

function validation(message: string): PipelineHostRefusal {
  return new PipelineHostRefusal('validation_failed', message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What main resolves from the request before anything is sent. */
interface ResolvedSend {
  text: string;
  composition?: {
    fileReferences?: FileReference[];
    attachmentPaths?: string[];
  };
  turnOverride?: ChatSendTurnOverride;
  newChatSeed?: PipelineNewChatSeed;
  /** `replace_empty_chat` in a run an automation started. */
  reuseStarterChat?: true;
  /** `new_chat`: never the task's empty chat. */
  newChat?: true;
  /** The banner, usage source and presentation of a run an automation started. */
  automationDispatch?: ChatSendAutomationDispatch;
}

interface ResolvedSettings {
  turnOverride?: ChatSendTurnOverride;
  newChatSeed?: PipelineNewChatSeed;
  /** What the owner must be allowed to use. */
  selections?: ChatTabPluginSelections;
  model?: string;
}

/** An existing chat's per-turn override; refusals are worded for automations, so they read as validation. */
async function resolveExistingChat(
  target: SendTarget,
  chatId: string,
  settings: SendAgentMessageSettings,
  referencedPluginSelections: ChatTabPluginSelections | undefined,
): Promise<ResolvedSettings> {
  const [chatService, turn] = await Promise.all([
    import('../services/chat-service'),
    import('../agent-messaging/turn-override'),
  ]);
  let tab: Awaited<
    ReturnType<typeof chatService.buildExistingTabDispatchOptions>
  >;
  try {
    tab = await chatService.buildExistingTabDispatchOptions(
      target.tabsProjectId,
      target.taskId,
      chatId,
    );
  } catch (error) {
    if (error instanceof chatService.ExistingTabDispatchTargetNotFoundError) {
      throw new PipelineHostRefusal(
        'not_found',
        chatNotInTask(chatId, target.taskId),
      );
    }
    throw error;
  }
  const modelConfig = modelConfigOf(settings);
  let override: ChatSendTurnOverride;
  try {
    override = await turn.resolveChatTurnOverride(
      { projectId: target.tabsProjectId, worktreeId: target.taskId, chatId },
      tab,
      {
        ...(settings.model !== undefined ? { model: settings.model } : {}),
        ...(modelConfig ? { modelConfig } : {}),
        ...(settings.planMode !== undefined
          ? { planMode: settings.planMode }
          : {}),
        ...(settings.approvalMode !== undefined
          ? { approvalMode: settings.approvalMode }
          : {}),
        ...(settings.plugins?.length ? { plugins: settings.plugins } : {}),
      },
      referencedPluginSelections,
    );
    // A terminal chat refuses settings it would not apply. The port commits
    // the override before delivery, so this must run first (CAN-4549 parity).
    await chatService.assertTerminalChatAcceptsSettings(
      { projectId: target.tabsProjectId, worktreeId: target.taskId, chatId },
      {
        ...(override.resetRuntime
          ? {
              providerType: override.providerType,
              executionHarness: override.executionHarness,
            }
          : {}),
        ...(override.model !== undefined ? { model: override.model } : {}),
        ...(override.modelConfig ? { modelConfig: override.modelConfig } : {}),
        ...(override.planMode !== undefined
          ? { planMode: override.planMode }
          : {}),
        ...(override.approvalMode
          ? { approvalMode: override.approvalMode }
          : {}),
        ...(override.pluginSelections
          ? { pluginSelections: override.pluginSelections }
          : {}),
      },
    );
  } catch (error) {
    throw validation(messageOf(error));
  }
  return {
    // An empty override (`{ version: 1 }`) leaves the chat's own settings.
    ...(Object.keys(override).some((key) => key !== 'version')
      ? { turnOverride: override }
      : {}),
    ...(override.pluginSelections
      ? { selections: override.pluginSelections }
      : {}),
    ...(override.model !== undefined ? { model: override.model } : {}),
  };
}

/**
 * A run an automation started gives a new chat that names a model, but no
 * thinking level, the level its native send took (CAN-4551): the
 * Orchestrator's own level, else the target surface's default for that
 * model's provider. Otherwise the new chat takes the provider's generic one.
 */
async function withAutomationThinking(
  settings: SendAgentMessageSettings,
  caller: PipelineHostActionCaller,
  target: SendTarget,
): Promise<SendAgentMessageSettings> {
  if (
    caller.initiator?.kind !== 'automation' ||
    target.chatId !== undefined ||
    settings.model === undefined ||
    settings.thinkingEffort !== undefined
  )
    return settings;
  const model = resolveKnownModel(settings.model);
  const providerType =
    model === undefined ? undefined : getProviderForModel(model);
  if (providerType === undefined) return settings;
  const { readPreferencesFile } = await import('../lib/preferences-store');
  const preferences = await readPreferencesFile();
  const thinkingLevel =
    target.kind === 'bot'
      ? (preferences.appAdvisorThinkingLevel ??
        preferences.defaultChatModelByProvider?.[providerType]?.thinkingLevel)
      : (target.workspaceType === 'cowork'
          ? preferences.defaultChatModelByProvider
          : preferences.defaultWorktreeModelByProvider)?.[providerType]
          ?.thinkingLevel;
  return thinkingLevel === undefined
    ? settings
    : { ...settings, thinkingEffort: thinkingLevel };
}

/**
 * A run an automation started opens an Orchestrator chat with the
 * Orchestrator's default plugins under any it chooses, as its native send did
 * (CAN-4551); a chosen selection otherwise replaces the defaults.
 */
async function automationPluginDefaults(
  caller: PipelineHostActionCaller,
  target: SendTarget,
): Promise<ChatTabPluginSelections | undefined> {
  if (
    caller.initiator?.kind !== 'automation' ||
    target.kind !== 'bot' ||
    target.chatId !== undefined
  )
    return undefined;
  const { readPreferencesFile } = await import('../lib/preferences-store');
  const defaults = (await readPreferencesFile()).appAdvisorPluginSelections;
  return defaults && hasAnySelections(defaults) ? defaults : undefined;
}

/** A new chat's seed; the orchestration applies the agent-originated and bot seed rules. */
async function resolveNewChat(
  settings: SendAgentMessageSettings,
  referencedPluginSelections: ChatTabPluginSelections | undefined,
  pluginDefaults?: ChatTabPluginSelections,
): Promise<ResolvedSettings> {
  let model: string | undefined;
  let providerType: AgentProviderType | undefined;
  if (settings.model !== undefined) {
    model = resolveKnownModel(settings.model);
    if (model === undefined) {
      throw validation(`${LABEL} "model" isn't a model this app knows`);
    }
    // A known Agent whose base model is unavailable has no provider.
    providerType = getProviderForModel(model);
    if (providerType === undefined) {
      throw validation(`${LABEL} "model" isn't available right now`);
    }
    if (settings.interfaceMode !== undefined && providerType !== 'claude') {
      throw validation(
        `${LABEL} "interface_mode" applies only to Claude models`,
      );
    }
  }
  let selections: ChatTabPluginSelections | undefined;
  if (settings.plugins?.length || referencedPluginSelections) {
    const [{ resolveAutomationPromptPlugins }, { mergePluginSelections }] =
      await Promise.all([
        import('../agent-messaging/turn-override'),
        import('../lib/plugin-selection-utils'),
      ]);
    let direct: ChatTabPluginSelections | undefined;
    try {
      direct = await resolveAutomationPromptPlugins(
        pluginDefaults,
        settings.plugins,
        undefined,
      );
    } catch (error) {
      throw validation(messageOf(error));
    }
    selections = referencedPluginSelections
      ? mergePluginSelections(direct, referencedPluginSelections)
      : direct;
  }
  const modelConfig = modelConfigOf(settings);
  const seed: PipelineNewChatSeed = {
    ...(model !== undefined ? { model } : {}),
    ...(providerType !== undefined ? { providerType } : {}),
    ...(modelConfig ? { modelConfig } : {}),
    ...(settings.planMode !== undefined ? { planMode: settings.planMode } : {}),
    ...(settings.approvalMode !== undefined
      ? { approvalMode: settings.approvalMode }
      : {}),
    ...(selections ? { pluginSelections: selections } : {}),
    ...(settings.interfaceMode !== undefined
      ? { interfaceMode: settings.interfaceMode }
      : {}),
  };
  return {
    // Any seed setting forces a new chat; without one an empty chat is reused.
    ...(Object.keys(seed).length > 0 ? { newChatSeed: seed } : {}),
    ...(selections ? { selections } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

/**
 * A run an automation started sends as the automation's own chat actions did
 * (CAN-4551): the `automation_info` banner, the automation usage source, the
 * run's owner, and a scheduled run's chat staying behind the current tab.
 */
function automationRunDispatch(caller: PipelineHostActionCaller): {
  automationDispatch?: ChatSendAutomationDispatch;
} {
  const { initiator } = caller;
  if (initiator?.kind !== 'automation') return {};
  return {
    automationDispatch: {
      version: 1,
      automationName: initiator.automationName || initiator.automationId,
      presentation: initiator.background ? 'background' : 'foreground',
      executionContext: caller.executionContext ?? 'personal',
    },
  };
}

/**
 * In a run an automation started, its gate command's output goes into the
 * text's gate tokens, as the native chat actions do (CAN-4551). The text and
 * references map together, so a token inside a reference is left alone and
 * every reference moves with the text. The output is inserted as written,
 * never evaluated. Without a recorded output the tokens stay.
 */
function withGateOutput(
  inputs: ResolvedSendAgentMessageInputs,
  caller: PipelineHostActionCaller,
): ResolvedSendAgentMessageInputs {
  const { initiator } = caller;
  if (
    initiator?.kind !== 'automation' ||
    initiator.ifCommandOutput === undefined
  )
    return inputs;
  const output = initiator.ifCommandOutput;
  const mapped = mapConfiguredPromptText(
    inputs.text,
    inputs.textReferences,
    (text) => interpolateAutomationIfCommandOutput(text, output),
  );
  return {
    ...inputs,
    text: mapped.prompt,
    ...(mapped.promptReferences !== undefined
      ? { textReferences: mapped.promptReferences }
      : {}),
  };
}

/** Settings, references and plugin authorization; no effects. */
async function resolveSend(
  inputs: ResolvedSendAgentMessageInputs,
  caller: PipelineHostActionCaller,
  target: SendTarget,
  agentOriginated: boolean,
): Promise<ResolvedSend> {
  const { settings } = inputs;
  // D11: the orchestration's `changesAuthority` is the backstop, and also
  // catches plugins that `text_references` bring.
  if (
    agentOriginated &&
    target.chatId !== undefined &&
    SEND_AGENT_MESSAGE_AUTHORITY_INPUTS.some((input) =>
      AUTHORITY_SETTINGS[input](settings),
    )
  ) {
    throw new PipelineHostRefusal(
      'authorization_conflict',
      AGENT_AUTHORITY_MESSAGE,
    );
  }
  // Bot prompts resolve against the Orchestrator workspace, as automations do.
  const workspace =
    target.kind === 'project'
      ? { projectId: target.id, worktreeId: target.taskId }
      : {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: APP_ADVISOR_WORKTREE_ID,
        };
  let text = inputs.text;
  let fileReferences: FileReference[] | undefined;
  let referencedPluginSelections: ChatTabPluginSelections | undefined;
  if (inputs.textReferences?.length) {
    const { resolveConfiguredPrompt } =
      await import('../lib/configured-prompt-resolution');
    try {
      const resolved = await resolveConfiguredPrompt({
        ...workspace,
        prompt: inputs.text,
        promptReferences: inputs.textReferences,
      });
      text = resolved.prompt;
      fileReferences = resolved.fileReferences;
      referencedPluginSelections = resolved.referencedPluginSelections;
    } catch (error) {
      // Its messages can carry reference paths; log the type only.
      logMainProcessWarn(`[pipeline-host] ${LABEL} references unresolved`, {
        errorType: errorType(error),
      });
      throw validation(
        `${LABEL} "text_references" names a file or plugin that isn't available`,
      );
    }
  }
  const resolvedSettings =
    target.chatId !== undefined
      ? await resolveExistingChat(
          target,
          target.chatId,
          settings,
          referencedPluginSelections,
        )
      : await resolveNewChat(
          await withAutomationThinking(settings, caller, target),
          referencedPluginSelections,
          await automationPluginDefaults(caller, target),
        );

  const { selections, model } = resolvedSettings;
  const hasSelections =
    selections !== undefined && hasAnySelections(selections);
  if (hasSelections || model?.startsWith(AGENT_MODEL_PREFIX)) {
    const { authorizeBackgroundExecution } =
      await import('../services/background-execution-context');
    const decision = await authorizeBackgroundExecution(
      caller.executionContext,
      [
        {
          owner: undefined,
          requiresHostAuthorization: true,
          capabilities: {
            ...(hasSelections ? { selections } : {}),
            ...(model !== undefined ? { model } : {}),
          },
        },
      ],
      workspace,
    );
    if (!decision.allow) {
      throw new PipelineHostRefusal(
        'authorization_conflict',
        "This pipeline's owner can't use the requested plugins or Agent.",
      );
    }
  }

  const composition = {
    ...(fileReferences?.length ? { fileReferences } : {}),
    ...(inputs.attachments?.length
      ? { attachmentPaths: inputs.attachments }
      : {}),
  };
  return {
    text,
    ...(Object.keys(composition).length > 0 ? { composition } : {}),
    ...(inputs.replaceEmptyChat === true &&
    caller.initiator?.kind === 'automation'
      ? { reuseStarterChat: true }
      : {}),
    ...(inputs.newChat === true ? { newChat: true } : {}),
    ...automationRunDispatch(caller),
    ...(resolvedSettings.turnOverride
      ? { turnOverride: resolvedSettings.turnOverride }
      : {}),
    ...(resolvedSettings.newChatSeed
      ? { newChatSeed: resolvedSettings.newChatSeed }
      : {}),
  };
}

/** The accepted send: what both the outputs and the record are built from. */
interface Acceptance {
  chatId: string;
  chatCreated: boolean;
  input: AcceptedInput;
}

/** The receipt names the planned target, or the step fails loudly. */
function assertAddressed(
  target: SendTarget,
  address: { taskId: string; projectId?: string; botId?: string },
): void {
  const addressed =
    target.kind === 'project' ? address.projectId : address.botId;
  if (addressed !== target.id || address.taskId !== target.taskId) {
    logMainProcessError(`[pipeline-host] ${LABEL} sent elsewhere`, {
      expected: { id: target.id, taskId: target.taskId },
      actual: {
        projectId: address.projectId,
        botId: address.botId,
        taskId: address.taskId,
      },
    });
    throw new Error(`${LABEL} sent to a chat other than the one it planned`);
  }
}

function sendOutcome(
  target: SendTarget,
  record: SendJournalRecord,
  acceptance: Acceptance,
  state: PipelineChatSendRecord['state'],
  steerUnavailable?: SendAgentMessageSteerUnavailableReason,
): { outputs: Record<string, string>; chatSend: PipelineChatSendRecord } {
  const { input, chatId } = acceptance;
  const chatSend: PipelineChatSendRecord = {
    version: 1,
    address:
      target.kind === 'project'
        ? {
            kind: 'project',
            projectId: target.id,
            taskId: target.taskId,
            chatId,
          }
        : { kind: 'bot', botId: target.id, taskId: target.taskId, chatId },
    userMessageId: record.ids.userMessageId,
    ...(input.queuedMessageId !== undefined
      ? { queuedMessageId: input.queuedMessageId }
      : {}),
    state,
    chatCreated: acceptance.chatCreated,
    acceptedAt: input.acceptedAt,
    ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
  };
  const outputs = {
    ...target.baseOutputs,
    chat_id: chatId,
    state,
    chat_created: String(acceptance.chatCreated),
    message_id: input.messageId ?? record.ids.userMessageId,
    queued_message_id: input.queuedMessageId ?? '',
    turn_id: input.turnId ?? '',
    accepted_at: input.acceptedAt,
    steer_unavailable_reason: steerUnavailable ?? '',
  };
  return { outputs, chatSend };
}

function success(
  target: SendTarget,
  record: SendJournalRecord,
  acceptance: Acceptance,
  state: PipelineChatSendRecord['state'],
  steerUnavailable?: SendAgentMessageSteerUnavailableReason,
): PipelineHostActionResult {
  return {
    status: 'success',
    ...sendOutcome(target, record, acceptance, state, steerUnavailable),
  };
}

function readResponse(response: unknown, what: string): PortResponse {
  const parsed = portResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new Error(`${LABEL} got an unreadable ${what} result`);
  }
  return parsed.data;
}

function parsedResult<T>(
  schema: z.ZodType<T>,
  result: unknown,
  what: string,
): T {
  const parsed = schema.safeParse(result);
  if (!parsed.success) {
    throw new Error(`${LABEL} got an unreadable ${what} receipt`);
  }
  return parsed.data;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultHasTranscriptMessage(
  scope: { projectId: string; worktreeId: string },
  chatId: string,
  messageId: string,
): Promise<boolean> {
  const { isWorktreeChatMessageCommitted } =
    await import('../services/chat-service');
  return isWorktreeChatMessageCommitted({
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    chatId,
    userMessageId: messageId,
  });
}

/** The operation's accepted result, held while its `done` write lands. */
interface Settled {
  result?: PipelineHostActionResult;
  /** The queued send while its steer is in flight (decision E). */
  queued?: {
    outputs: Record<string, string>;
    chatSend: PipelineChatSendRecord;
  };
}

/** Records the terminal result; a failed write is logged and changes nothing. */
async function finalize(
  artifactsDir: string,
  record: SendJournalRecord,
  settled: Settled,
  result: PipelineHostActionResult,
): Promise<PipelineHostActionResult> {
  // A malformed record is never journaled; the executor refuses it as well.
  if (
    result.chatSend !== undefined &&
    parsePipelineChatSendRecord(result.chatSend) === undefined
  ) {
    throw new Error(`${LABEL} built an invalid send record`);
  }
  settled.result = result;
  record.phase = 'done';
  record.result = result;
  try {
    await writeSendJournal(artifactsDir, record);
  } catch (error) {
    logMainProcessWarn(`[pipeline-host] ${LABEL} could not record its result`, {
      errorType: errorType(error),
    });
  }
  return result;
}

/** The chat the journal names, for a result that never reached acceptance. */
function recordedChatOutputs(
  record: SendJournalRecord,
): Record<string, string> {
  return record.chatId !== undefined
    ? {
        chat_id: record.chatId,
        chat_created: String(record.chatCreated ?? false),
      }
    : {};
}

function newRecord(
  caller: PipelineHostActionCaller,
  fingerprint: string,
  target: SendTarget,
): SendJournalRecord {
  const creating = target.chatId === undefined;
  return {
    version: 1,
    idempotencyKey: caller.idempotencyKey,
    fingerprint,
    phase: creating ? 'creating' : 'sending',
    ids: {
      // UUIDs: OpenCode needs them.
      commandId: randomUUID(),
      userMessageId: randomUUID(),
      ...(creating
        ? { tabId: randomUUID(), createTabCommandId: randomUUID() }
        : {}),
      steerCommandId: randomUUID(),
    },
    ...(target.chatId !== undefined
      ? { chatId: target.chatId, chatCreated: false }
      : {}),
  };
}

type SendOutcome =
  | { kind: 'accepted'; acceptance: Acceptance }
  | { kind: 'refused'; result: PipelineHostActionResult; transient: boolean };

/** Refusals that can clear by themselves: not journaled, so a resume sends again. */
const TRANSIENT_REFUSALS: ReadonlySet<string> = new Set([
  'owner_context_unavailable',
  'stale_ui_state',
  'in_progress',
]);

function refused(target: SendTarget, error: PortError): SendOutcome {
  return {
    kind: 'refused',
    result: mapRefusal(target, error),
    transient: TRANSIENT_REFUSALS.has(error.code),
  };
}

/** Creates the chat with its first message, or sends to the given chat. */
async function dispatchSend(
  target: SendTarget,
  record: SendJournalRecord,
  resolved: ResolvedSend,
  source: PipelineSenderSource,
  deps: SendAgentMessageHostDeps,
  artifactsDir: string,
): Promise<SendOutcome> {
  const dispatch = deps.dispatch ?? dispatchPipelineProjectBotAction;
  const caller = { kind: 'pipeline' as const, source };
  const composition = resolved.composition
    ? { composition: resolved.composition }
    : {};
  const { ids } = record;
  if (target.chatId === undefined) {
    const response = readResponse(
      await dispatch(
        target.kind === 'project'
          ? {
              type: 'projects.create_task_chat',
              projectId: target.id,
              taskId: target.taskId,
              initialMessage: resolved.text,
            }
          : {
              type: 'bots.create_task_chat',
              botId: target.id,
              taskId: target.taskId,
              initialMessage: resolved.text,
            },
        caller,
        {
          ...composition,
          ...(resolved.newChatSeed
            ? { newChatSeed: resolved.newChatSeed }
            : {}),
          ...(resolved.reuseStarterChat ? { reuseStarterChat: true } : {}),
          ...(resolved.newChat ? { newChat: true } : {}),
          ...(resolved.automationDispatch
            ? { automationDispatch: resolved.automationDispatch }
            : {}),
          fixedIds: {
            commandId: ids.commandId,
            userMessageId: ids.userMessageId,
            ...(ids.tabId !== undefined ? { tabId: ids.tabId } : {}),
            ...(ids.reusedTab ? { reusedTab: ids.reusedTab } : {}),
            ...(ids.createTabCommandId !== undefined
              ? { createTabCommandId: ids.createTabCommandId }
              : {}),
          },
          // The orchestration awaits this before it sends the message, so a
          // replay always finds the chat it chose. A failed write stops the send
          // rather than open a window for a second message.
          onChatResolved: async ({ chatId, created }) => {
            record.ids.tabId = chatId;
            if (created) delete record.ids.reusedTab;
            else record.ids.reusedTab = true;
            record.chatId = chatId;
            record.chatCreated = created;
            record.phase = 'sending';
            await writeSendJournal(artifactsDir, record);
          },
        },
      ),
      'creation',
    );
    if (!response.ok) {
      return refused(target, response.error);
    }
    const receipt = parsedResult(
      creationReceiptSchema,
      response.result,
      'creation',
    );
    assertAddressed(target, receipt.address);
    if (!receipt.input) {
      throw new Error(`${LABEL} created a chat without sending its message`);
    }
    return {
      kind: 'accepted',
      acceptance: {
        chatId: receipt.address.chatId,
        chatCreated: receipt.chatCreated,
        input: receipt.input,
      },
    };
  }
  const chatId = target.chatId;
  const response = readResponse(
    await dispatch(
      target.kind === 'project'
        ? {
            type: 'projects.send_message',
            projectId: target.id,
            taskId: target.taskId,
            chatId,
            text: resolved.text,
            // A pipeline's message waits for a code task's setup.
            ...(target.workspaceType !== 'cowork'
              ? { queueForSetup: true }
              : {}),
          }
        : {
            type: 'bots.send_message',
            botId: target.id,
            taskId: target.taskId,
            chatId,
            text: resolved.text,
          },
      caller,
      {
        ...composition,
        ...(resolved.turnOverride
          ? { turnOverride: resolved.turnOverride }
          : {}),
        ...(resolved.automationDispatch
          ? { automationDispatch: resolved.automationDispatch }
          : {}),
        fixedIds: {
          commandId: ids.commandId,
          userMessageId: ids.userMessageId,
        },
      },
    ),
    'send',
  );
  if (!response.ok) {
    return refused(target, response.error);
  }
  const input = parsedResult(
    acceptedInputReceiptSchema,
    response.result,
    'send',
  );
  assertAddressed(target, input.address);
  return {
    kind: 'accepted',
    acceptance: { chatId, chatCreated: false, input },
  };
}

/** A steer's result; a transient refusal isn't journaled (see `TRANSIENT_REFUSALS`). */
interface SteerOutcome {
  result: PipelineHostActionResult;
  transient?: boolean;
}

/** Steers a queued message into the running turn; the state table's steer rows. */
async function steerQueued(
  target: SendTarget,
  record: SendJournalRecord,
  acceptance: Acceptance,
  queuedMessageId: string,
  source: PipelineSenderSource,
  deps: SendAgentMessageHostDeps,
  artifactsDir: string,
): Promise<SteerOutcome> {
  record.queuedMessageId = queuedMessageId;
  record.phase = 'steering';
  try {
    await writeSendJournal(artifactsDir, record);
  } catch (error) {
    // The replay redoes the send and the steer with the same IDs either way.
    logMainProcessWarn(
      `[pipeline-host] ${LABEL} could not record its queued message`,
      { errorType: errorType(error) },
    );
  }
  const dispatch = deps.dispatch ?? dispatchPipelineProjectBotAction;
  const steer = readResponse(
    await dispatch(
      {
        type: 'projects.steer_queued_message',
        projectId: target.id,
        taskId: target.taskId,
        chatId: acceptance.chatId,
        queuedMessageId,
      },
      { kind: 'pipeline', source },
      {
        fixedIds: {
          commandId: record.ids.commandId,
          userMessageId: record.ids.userMessageId,
          steerCommandId: record.ids.steerCommandId,
        },
      },
    ),
    'steer',
  );
  if (steer.ok) {
    parsedResult(steeredReceiptSchema, steer.result, 'steer');
    return { result: success(target, record, acceptance, 'steered') };
  }
  if (steer.error.code === 'missing_capability') {
    // D7: the message stays queued; that is not a failure.
    return {
      result: success(
        target,
        record,
        acceptance,
        'queued',
        'missing_capability',
      ),
    };
  }
  if (steer.error.code === 'not_found') {
    // Decision C: the turn may have taken the row between the send and the
    // steer, and its transcript write may still be landing.
    const hasMessage = deps.hasTranscriptMessage ?? defaultHasTranscriptMessage;
    const scope = {
      projectId: target.tabsProjectId,
      worktreeId: target.taskId,
    };
    const lookup = (): Promise<boolean> =>
      hasMessage(scope, acceptance.chatId, record.ids.userMessageId);
    let delivered = await lookup();
    if (!delivered) {
      await delay(deps.transcriptRecheckMs ?? TRANSCRIPT_RECHECK_MS);
      delivered = await lookup();
    }
    if (delivered) {
      return { result: success(target, record, acceptance, 'sent') };
    }
  }
  // The message was accepted before the steer failed: keep it on the result
  // so a delivered message is never hidden (decision E).
  const { outputs, chatSend } = sendOutcome(
    target,
    record,
    acceptance,
    'queued',
  );
  if (steer.error.code === 'not_found') {
    // The chat exists; the queued row is gone and the turn didn't take it.
    return {
      result: failure(
        target,
        'not_found',
        `The queued message isn't waiting in chat \`${acceptance.chatId}\` anymore`,
        outputs,
        chatSend,
      ),
    };
  }
  return {
    result: mapRefusal(target, steer.error, outputs, chatSend),
    transient: TRANSIENT_REFUSALS.has(steer.error.code),
  };
}

async function runOperation(
  inputs: ResolvedSendAgentMessageInputs,
  caller: PipelineHostActionCaller,
  deps: SendAgentMessageHostDeps,
  signal: AbortSignal,
  controls: PipelineHostActionControls,
  fingerprint: string,
): Promise<PipelineHostActionResult> {
  const { artifactsDir } = controls;
  const trusted = pipelineTrustedCaller(caller);
  const target = await resolveSendTarget(inputs, caller, deps);
  const source = senderSource(caller, trusted);

  const read = await readSendJournal(artifactsDir, caller.idempotencyKey);
  if (read.kind === 'corrupt') {
    throw new PipelineHostRefusal('target_not_ready', CHAT_UNREADABLE_MESSAGE);
  }
  if (read.kind === 'present') {
    if (read.record.fingerprint !== fingerprint) {
      throw new PipelineHostRefusal(
        'authorization_conflict',
        DIFFERENT_INPUTS_MESSAGE,
      );
    }
    if (read.record.phase === 'done') {
      // A journaled failure is not retried under the same key.
      if (read.record.result) return read.record.result;
      throw new PipelineHostRefusal(
        'target_not_ready',
        CHAT_UNREADABLE_MESSAGE,
      );
    }
  }
  // A resumed attempt keeps its IDs, so every dispatch below replays.
  const record =
    read.kind === 'present'
      ? read.record
      : newRecord(caller, fingerprint, target);

  const resolved = await resolveSend(
    withGateOutput(inputs, caller),
    caller,
    target,
    trusted.agentOrigin !== undefined,
  );

  const settled: Settled = {};
  controls.registerTimeoutFinalizer(async () => {
    if (settled.result) return settled.result;
    const journaled = await readSendJournal(
      artifactsDir,
      caller.idempotencyKey,
    );
    if (journaled.kind === 'present' && journaled.record.result) {
      return journaled.record.result;
    }
    if (settled.queued) {
      const { outputs, chatSend } = settled.queued;
      return failure(
        target,
        'target_not_ready',
        STEER_TIMED_OUT_MESSAGE,
        outputs,
        chatSend,
      );
    }
    return failure(
      target,
      'target_not_ready',
      TIMED_OUT_MESSAGE,
      recordedChatOutputs(record),
    );
  });

  if (read.kind === 'absent') {
    // The last signal check, against the caller that started the operation;
    // a caller that joins it shares that outcome. Once the IDs are on disk,
    // dispatch may start and the operation runs to completion whatever its
    // callers do.
    signal.throwIfAborted();
    await writeSendJournal(artifactsDir, record);
  }

  const sent = await dispatchSend(
    target,
    record,
    resolved,
    source,
    deps,
    artifactsDir,
  );
  if (sent.kind === 'refused') {
    // A chat the creation made before its message was refused is reported.
    const result: PipelineHostActionResult = {
      ...sent.result,
      outputs: { ...sent.result.outputs, ...recordedChatOutputs(record) },
    };
    // Nothing was sent; the journal keeps its IDs, so a resume replays them.
    if (sent.transient) return result;
    return finalize(artifactsDir, record, settled, result);
  }
  const { acceptance } = sent;
  const { input } = acceptance;
  // A chat that went idle before the send started the turn: no steer needed.
  if (input.disposition === 'started') {
    return finalize(
      artifactsDir,
      record,
      settled,
      success(target, record, acceptance, 'sent'),
    );
  }
  if (inputs.mode === 'queue') {
    return finalize(
      artifactsDir,
      record,
      settled,
      success(target, record, acceptance, 'queued'),
    );
  }
  // The steer can outlast the deadline; the message is already queued.
  settled.queued = sendOutcome(target, record, acceptance, 'queued');
  let steered: SteerOutcome;
  try {
    steered = await steerQueued(
      target,
      record,
      acceptance,
      input.queuedMessageId,
      source,
      deps,
      artifactsDir,
    );
  } catch (error) {
    // An unexpected steer error still reports the queued message (decision
    // E). The journal stays `steering`, so a resume steers again.
    logMainProcessWarn(`[pipeline-host] ${LABEL} steer failed`, {
      errorType: errorType(error),
    });
    const { outputs, chatSend } = settled.queued;
    return failure(
      target,
      'target_not_ready',
      STEER_FAILED_MESSAGE,
      outputs,
      chatSend,
    );
  }
  // A transient refusal leaves the journal `steering`: a resume steers again.
  if (steered.transient) return steered.result;
  return finalize(artifactsDir, record, settled, steered.result);
}

interface LiveOperation {
  fingerprint: string;
  result: Promise<PipelineHostActionResult>;
  /** The operation's timeout finalizer once registered; joiners share it. */
  shared: { finalizer?: () => Promise<PipelineHostActionResult> };
}

/** One live operation per idempotency key: concurrent callers share it. */
const liveOperations = new Map<string, LiveOperation>();

export async function runSendAgentMessageHostAction(
  inputs: ResolvedSendAgentMessageInputs,
  caller: PipelineHostActionCaller,
  deps: SendAgentMessageHostDeps,
  signal: AbortSignal,
  controls: PipelineHostActionControls | undefined,
): Promise<PipelineHostActionResult> {
  // Internal contract errors: no effects, not typed refusals.
  if (!controls) throw new Error(`${LABEL} needs host controls`);
  if (!caller.idempotencyKey) {
    throw new Error(`${LABEL} needs an idempotency key`);
  }
  if (signal.aborted) throw abortError();
  const key = caller.idempotencyKey;
  // The raised request (`text_file` already read) and the run's owner and
  // agent origin, before any main-side resolution.
  const fingerprint = createSendFingerprint({
    inputs,
    owner: caller.executionContext ?? 'personal',
    agentOrigin: caller.agentOrigin,
  });
  let operation = liveOperations.get(key);
  if (operation && operation.fingerprint !== fingerprint) {
    throw new PipelineHostRefusal(
      'authorization_conflict',
      DIFFERENT_INPUTS_MESSAGE,
    );
  }
  if (operation) {
    // A joiner's own deadline reports what the operation would. Before the
    // operation registers its finalizer, the runner's generic timeout stands.
    const { shared } = operation;
    controls.registerTimeoutFinalizer(() =>
      shared.finalizer
        ? shared.finalizer()
        : Promise.reject(new Error(`${LABEL} hadn't planned its send yet`)),
    );
  } else {
    const shared: LiveOperation['shared'] = {};
    const operationControls: PipelineHostActionControls = {
      ...controls,
      registerTimeoutFinalizer: (finalize) => {
        shared.finalizer = finalize;
        controls.registerTimeoutFinalizer(finalize);
      },
    };
    const created: LiveOperation = {
      fingerprint,
      shared,
      result: runOperation(
        inputs,
        caller,
        deps,
        signal,
        operationControls,
        fingerprint,
      ),
    };
    liveOperations.set(key, created);
    void created.result
      .catch(() => undefined)
      .finally(() => {
        if (liveOperations.get(key) === created) liveOperations.delete(key);
      });
    operation = created;
  }
  return waitOrAbort(operation.result, signal);
}
