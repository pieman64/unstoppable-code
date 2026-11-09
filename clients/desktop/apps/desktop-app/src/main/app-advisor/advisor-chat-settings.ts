import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import { BRAND } from '@canopy/brand/current';
import {
  chatSettingsResult,
  emptyChatTabPluginSelections,
  pluginSelectionsResult,
  tabUsesCodexSpeed,
  updatePluginSelection,
} from '@canopy/desktop-shared/lib/app-advisor-chat-reads';
import { withRequiredPipelineEditorSkill } from '@canopy/desktop-shared/lib/pipeline-editor-tools';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { codexSpeedFromFastMode } from '@canopy/execution-engine/lib/codex-speed';
import {
  COWORK_HOME_WORKTREE_ID,
  getProviderForModel,
  requireProviderForModel,
  type AppAdvisorAction,
  type AppAdvisorActionError,
  type AppAdvisorActionResponse,
  type AppAdvisorJson,
  type ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import {
  chatSettingsRoute,
  type ChatSettingsChange,
  type ChatSettingsGuard,
} from '../lib/chat-settings-route';
import {
  PIPELINE_ASSISTANT,
  resolveChatTarget,
  resolveScope,
  type AdvisorChatReadHost,
  type ChatTarget,
} from './advisor-chat-reads';

/*
 * CAN-5999 part 2: App Advisor's model, thinking, plan and speed changes, in
 * Electron main through core.chat.update and main's settings host. A change
 * the core route cannot make (the guards the Portal uses, CAN-4110 D7) is
 * presented through the main window's lease for model, plan and thinking,
 * and refused with its reason for fast mode and speed; with no lease every
 * one is refused. None is applied without the window when a guard fails.
 */

export const ADVISOR_CHAT_SETTING_ACTION_TYPES = [
  'worktree-chat.set_model',
  'worktree-chat.set_thinking_level',
  'worktree-chat.set_plan_mode',
  'worktree-chat.set_fast_mode',
  'worktree-chat.set_speed',
  'standalone-chat.set_model',
  'standalone-chat.set_thinking_level',
  'pipeline-assistant-chat.set_model',
  'pipeline-assistant-chat.set_thinking_level',
  'worktree-chat.update_plugin_selection',
  'worktree-chat.set_plugin_selections',
  'standalone-chat.update_plugin_selection',
  'standalone-chat.set_plugin_selections',
  'pipeline-assistant-chat.update_plugin_selection',
  'pipeline-assistant-chat.set_plugin_selections',
] as const;

const PLUGIN_SETTER_TYPES: ReadonlySet<string> = new Set([
  'worktree-chat.update_plugin_selection',
  'worktree-chat.set_plugin_selections',
  'standalone-chat.update_plugin_selection',
  'standalone-chat.set_plugin_selections',
  'pipeline-assistant-chat.update_plugin_selection',
  'pipeline-assistant-chat.set_plugin_selections',
]);

type PluginSetterAction = Extract<
  AppAdvisorAction,
  {
    type:
      | 'worktree-chat.update_plugin_selection'
      | 'worktree-chat.set_plugin_selections'
      | 'standalone-chat.update_plugin_selection'
      | 'standalone-chat.set_plugin_selections'
      | 'pipeline-assistant-chat.update_plugin_selection'
      | 'pipeline-assistant-chat.set_plugin_selections';
  }
>;

type ValueSetterAction = Exclude<AdvisorChatSettingAction, PluginSetterAction>;

function isPluginSetter(
  action: AdvisorChatSettingAction,
): action is PluginSetterAction {
  return PLUGIN_SETTER_TYPES.has(action.type);
}

type AdvisorChatSettingType =
  (typeof ADVISOR_CHAT_SETTING_ACTION_TYPES)[number];

export type AdvisorChatSettingAction = Extract<
  AppAdvisorAction,
  { type: AdvisorChatSettingType }
>;

export function isAdvisorChatSettingAction(action: {
  type: string;
}): action is AdvisorChatSettingAction {
  return ADVISOR_CHAT_SETTING_ACTION_TYPES.some((type) => type === action.type);
}

/** The lifecycle outcomes core.chat.update answers. */
export type ChatUpdateOutcome =
  | 'applied'
  | 'already_applied'
  | 'conflict'
  | 'not_found'
  | 'rejected';

/** The main owners these changes use; tests replace them. */
export interface AdvisorChatSettingsHost extends Pick<
  AdvisorChatReadHost,
  'readUiState' | 'readTabs' | 'locateCoworkChat'
> {
  isMainWindowOpen(): boolean;
  /** Whether the main window's lease serves App Advisor presentation. */
  hasPresentationLease(): Promise<boolean>;
  /** Applies the action in the main window through its lease. */
  presentInMainWindow(
    action: AdvisorChatSettingAction,
  ): Promise<AppAdvisorActionResponse>;
  /** One keyed core.chat.update as the advisor chat with core.chat.write. */
  updateChat(request: {
    projectId: string;
    worktreeId: string;
    action: unknown;
    idempotencyKey: string;
  }): Promise<{ outcome: ChatUpdateOutcome; reason?: string }>;
  /**
   * Applies committed plugin selections to the chat's live provider session
   * (applyChatPluginSelectionsUpdate), as the window's chat.updatePlugins does.
   * False when the session could not take them now; the commit stands and
   * the next session uses it. Never throws.
   */
  applyLivePluginSelections(request: {
    projectId: string;
    worktreeId: string;
    chatId: string;
    pluginSelections: ChatTabPluginSelections;
  }): Promise<boolean>;
  /** Restarts a Claude terminal after its settings changed; never throws. */
  restartTerminal(target: {
    projectId: string;
    worktreeId: string;
    chatId: string;
  }): Promise<void>;
}

export interface AdvisorChatSettingsCall {
  requestId: string;
  /** The idempotency key of this tool call's core write. */
  idempotencyKey: string;
}

type Outcome = Omit<AppAdvisorActionResponse, 'requestId'>;

function failure(error: AppAdvisorActionError): Outcome {
  return { ok: false, error };
}

const appName = BRAND.displayName;

/** The reason a change needs the window, when no window can take it. */
const GUARD_REASONS: Record<ChatSettingsGuard, AppAdvisorActionError> = {
  model_with_window: {
    code: 'surface_unavailable',
    message: `Model changes run in the ${appName} window while it is open, and it is not responding. Try again.`,
    retryable: true,
  },
  unsupported_provider: {
    code: 'surface_unavailable',
    message: `This model can only be chosen in the ${appName} window. Open it and try again.`,
    retryable: true,
  },
  file_tab: {
    code: 'invalid_target',
    message: 'The target tab is a file tab, not a chat transcript.',
  },
  read_only: {
    code: 'invalid_target',
    message: 'This chat is read-only.',
  },
  pending_plan: {
    code: 'surface_unavailable',
    message: `Turning plan mode off settles the pending plan in the ${appName} window. Open it and try again.`,
    retryable: true,
  },
  no_fast_mode: {
    code: 'invalid_target',
    message: 'Fast mode is only available for supported model providers.',
  },
  visible_terminal: {
    code: 'surface_unavailable',
    message: `This chat's Claude terminal relaunches in the ${appName} window, which is not responding. Try again.`,
    retryable: true,
  },
};

const ARCHIVED_STANDALONE: AppAdvisorActionError = {
  code: 'invalid_target',
  message:
    'Archived standalone chats are read-only. Restore the chat before applying mutations.',
};

/** The chat a setter names: a worktree chat, the Pipeline Assistant or a Cowork chat. */
async function resolveTarget(
  action: AdvisorChatSettingAction,
  host: AdvisorChatSettingsHost,
): Promise<ChatTarget | { error: AppAdvisorActionError }> {
  if (
    action.type === 'pipeline-assistant-chat.set_model' ||
    action.type === 'pipeline-assistant-chat.set_thinking_level' ||
    action.type === 'pipeline-assistant-chat.update_plugin_selection' ||
    action.type === 'pipeline-assistant-chat.set_plugin_selections'
  )
    return resolveChatTarget(PIPELINE_ASSISTANT, action.chatId, host);
  if (
    action.type === 'standalone-chat.set_model' ||
    action.type === 'standalone-chat.set_thinking_level' ||
    action.type === 'standalone-chat.update_plugin_selection' ||
    action.type === 'standalone-chat.set_plugin_selections'
  ) {
    const located = await host.locateCoworkChat(
      action.projectId,
      action.chatId,
    );
    if (located.archivedInEntryId !== null)
      return { error: ARCHIVED_STANDALONE };
    const target = await resolveChatTarget(
      {
        projectId: action.projectId,
        worktreeId: located.entryId ?? COWORK_HOME_WORKTREE_ID,
      },
      action.chatId,
      host,
    );
    if ('error' in target)
      return {
        error: {
          ...target.error,
          message: `Standalone chat ${action.chatId} in project ${action.projectId} could not be resolved: ${target.error.message}`,
        },
      };
    return target;
  }
  const scope = await resolveScope(action, host, true);
  if ('error' in scope) return scope;
  return resolveChatTarget(scope, action.chatId, host);
}

function settingsChange(action: ValueSetterAction): ChatSettingsChange {
  switch (action.type) {
    case 'worktree-chat.set_model':
    case 'standalone-chat.set_model':
    case 'pipeline-assistant-chat.set_model':
      return { kind: 'model', model: action.model };
    case 'worktree-chat.set_plan_mode':
      return { kind: 'plan', planMode: action.enabled };
    case 'worktree-chat.set_fast_mode':
    case 'worktree-chat.set_speed':
      return { kind: 'fast' };
    default:
      return { kind: 'thinking' };
  }
}

function coreAction(
  action: ValueSetterAction,
  tabId: string,
): Record<string, unknown> {
  switch (action.type) {
    case 'worktree-chat.set_model':
    case 'standalone-chat.set_model':
    case 'pipeline-assistant-chat.set_model':
      return {
        type: 'chat.set_model',
        tabId,
        model: action.model,
        providerType: requireProviderForModel(action.model),
        ...(action.type === 'worktree-chat.set_model' && action.executionHarness
          ? { executionHarness: action.executionHarness }
          : {}),
      };
    case 'worktree-chat.set_plan_mode':
      return {
        type: 'chat.patch_tab_settings',
        tabId,
        patch: { planMode: action.enabled },
      };
    case 'worktree-chat.set_fast_mode':
      return {
        type: 'chat.patch_tab_settings',
        tabId,
        patch: { modelConfig: { fastMode: action.enabled } },
      };
    case 'worktree-chat.set_speed':
      return {
        type: 'chat.patch_tab_settings',
        tabId,
        patch: { modelConfig: { speed: action.speed } },
      };
    default:
      return {
        type: 'chat.patch_tab_settings',
        tabId,
        patch: { modelConfig: { thinkingLevel: action.level } },
      };
  }
}

/** The renderer's own refusals, before any chat is read. */
function refusedUpfront(action: ValueSetterAction): Outcome | null {
  if (
    (action.type === 'worktree-chat.set_model' ||
      action.type === 'pipeline-assistant-chat.set_model') &&
    getProviderForModel(action.model) === 'cursor'
  )
    return failure({
      code: 'invalid_target',
      message:
        action.type === 'pipeline-assistant-chat.set_model'
          ? 'Cursor is not available in Pipeline Assistant.'
          : `Cursor is not available through ${ORCHESTRATOR_LABEL} model changes.`,
    });
  return null;
}

/** The renderer's refusals for a speed change on this chat. */
function refusedSpeed(
  action: ValueSetterAction,
  target: ChatTarget,
): Outcome | null {
  if (
    action.type === 'worktree-chat.set_fast_mode' &&
    !tabUsesCodexSpeed(target.tab)
  )
    return failure(GUARD_REASONS.no_fast_mode);
  if (action.type !== 'worktree-chat.set_speed') return null;
  if (!tabUsesCodexSpeed(target.tab))
    return failure({
      code: 'invalid_target',
      message: 'Speed is only available for Codex chats.',
    });
  // Auto cannot promise a model that offers Ultra fast.
  if (action.speed === 'ultrafast' && target.tab.modelSelectionMode === 'auto')
    return failure({
      code: 'invalid_target',
      message:
        'Ultra fast needs a specific model. Choose a model that offers Ultra fast, or choose Regular or Fast.',
    });
  return null;
}

function changedFields(
  action: ValueSetterAction,
): Record<string, AppAdvisorJson> {
  switch (action.type) {
    case 'worktree-chat.set_model':
    case 'standalone-chat.set_model':
    case 'pipeline-assistant-chat.set_model':
      return { model: action.model };
    case 'worktree-chat.set_plan_mode':
      return { planMode: action.enabled };
    case 'worktree-chat.set_fast_mode':
      return { speed: codexSpeedFromFastMode(action.enabled) };
    case 'worktree-chat.set_speed':
      return { speed: action.speed };
    default:
      return { thinkingLevel: action.level };
  }
}

/**
 * The action with the chat main checked, so the window applies it to that
 * chat rather than to whatever its selection shows by then.
 */
function pinnedAction(
  action: ValueSetterAction,
  target: ChatTarget,
): ValueSetterAction {
  switch (action.type) {
    case 'worktree-chat.set_model':
    case 'worktree-chat.set_thinking_level':
    case 'worktree-chat.set_plan_mode':
    case 'worktree-chat.set_fast_mode':
    case 'worktree-chat.set_speed':
      return {
        ...action,
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: target.chatId,
      };
    case 'pipeline-assistant-chat.set_model':
    case 'pipeline-assistant-chat.set_thinking_level':
      return { ...action, chatId: target.chatId };
    case 'standalone-chat.set_model':
    case 'standalone-chat.set_thinking_level':
      return action;
  }
}

async function present(
  action: ValueSetterAction,
  guard: ChatSettingsGuard,
  host: AdvisorChatSettingsHost,
): Promise<Outcome> {
  const guarded =
    action.type !== 'worktree-chat.set_fast_mode' &&
    action.type !== 'worktree-chat.set_speed';
  if (!guarded || guard === 'file_tab' || guard === 'read_only')
    return failure(GUARD_REASONS[guard]);
  if (!(await host.hasPresentationLease()))
    return failure(GUARD_REASONS[guard]);
  const presented = await host.presentInMainWindow(action);
  if (!presented.ok)
    return {
      ok: false,
      error: presented.error ?? GUARD_REASONS[guard],
    };
  const result =
    typeof presented.result === 'object' &&
    presented.result !== null &&
    !Array.isArray(presented.result)
      ? presented.result
      : {};
  return {
    ok: true,
    result: { ...result, presentedInMainWindow: true, guard },
  };
}

async function run(
  action: AdvisorChatSettingAction,
  host: AdvisorChatSettingsHost,
  call: AdvisorChatSettingsCall,
): Promise<Outcome> {
  const refused = isPluginSetter(action) ? null : refusedUpfront(action);
  if (refused) return refused;
  const target = await resolveTarget(action, host);
  if ('error' in target) return failure(target.error);
  // Every setter refuses these tabs before any route, the window included.
  if (target.tab.kind === 'file') return failure(GUARD_REASONS.file_tab);
  if (target.tab.readOnly === true) return failure(GUARD_REASONS.read_only);
  if (isPluginSetter(action))
    return runPluginSetter(action, target, host, call);
  const speedRefusal = refusedSpeed(action, target);
  if (speedRefusal) return speedRefusal;
  const route = chatSettingsRoute(
    settingsChange(action),
    target.tab,
    host.isMainWindowOpen(),
  );
  if (route.route === 'window')
    return present(pinnedAction(action, target), route.guard, host);
  const updated = await host.updateChat({
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    action: coreAction(action, target.chatId),
    idempotencyKey: call.idempotencyKey,
  });
  if (updated.outcome !== 'applied' && updated.outcome !== 'already_applied')
    return failure({
      code:
        updated.outcome === 'not_found'
          ? 'not_found'
          : updated.outcome === 'conflict'
            ? 'stale_ui_state'
            : 'invalid_target',
      message:
        updated.reason ??
        (action.type.endsWith('.set_model')
          ? 'The model or harness change was not accepted.'
          : 'The chat setting change was not accepted.'),
      ...(updated.outcome === 'conflict' ? { retryable: true } : {}),
    });
  if (
    action.type.endsWith('.set_model') ||
    action.type.endsWith('.set_thinking_level')
  )
    await host.restartTerminal({
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.chatId,
    });
  const refreshed = (
    await host.readTabs(target.projectId, target.worktreeId)
  )?.tabs.find((tab) => tab.id === target.chatId);
  return {
    ok: true,
    result: {
      ...chatSettingsResult({ ...target, tab: refreshed ?? target.tab }),
      ...changedFields(action),
    },
  };
}

/**
 * A plugin selection change: committed through core.chat.update against the
 * selections main read, then applied to the live provider session. Any
 * attached window refreshes the chat's slash commands from the commit.
 */
async function runPluginSetter(
  action: PluginSetterAction,
  target: ChatTarget,
  host: AdvisorChatSettingsHost,
  call: AdvisorChatSettingsCall,
): Promise<Outcome> {
  const requested =
    action.type.endsWith('.update_plugin_selection') && 'kind' in action
      ? updatePluginSelection(
          target.tab.pluginSelections ?? emptyChatTabPluginSelections(),
          action.kind,
          action.key,
          action.enabled,
        )
      : 'selections' in action
        ? action.selections
        : emptyChatTabPluginSelections();
  // The Pipeline Assistant always keeps its required skill.
  const selections =
    target.projectId === PIPELINE_ASSISTANT.projectId &&
    target.worktreeId === PIPELINE_ASSISTANT.worktreeId
      ? withRequiredPipelineEditorSkill(requested)
      : requested;
  const updated = await host.updateChat({
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    action: {
      type: 'chat.patch_tab_settings',
      tabId: target.chatId,
      patch: { pluginSelections: selections },
      // Always compared, so a concurrent edit to an empty selection conflicts.
      expectedPluginSelections: normalizePluginSelections(
        target.tab.pluginSelections,
      ),
    },
    idempotencyKey: call.idempotencyKey,
  });
  if (updated.outcome !== 'applied' && updated.outcome !== 'already_applied')
    return failure({
      code:
        updated.outcome === 'not_found'
          ? 'not_found'
          : updated.outcome === 'conflict'
            ? 'stale_ui_state'
            : 'invalid_target',
      message:
        updated.outcome === 'conflict'
          ? "The chat's plugins changed while this change was being made. Read them again and retry."
          : (updated.reason ?? 'The plugin selection change was not accepted.'),
      ...(updated.outcome === 'conflict' ? { retryable: true } : {}),
    });
  const liveSessionUpdated = await host.applyLivePluginSelections({
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.chatId,
    pluginSelections: selections,
  });
  const refreshed = (
    await host.readTabs(target.projectId, target.worktreeId)
  )?.tabs.find((tab) => tab.id === target.chatId);
  return {
    ok: true,
    result: {
      ...chatSettingsResult({ ...target, tab: refreshed ?? target.tab }),
      pluginSelections: pluginSelectionsResult(selections),
      liveSessionUpdated,
    },
  };
}

/** One of {@link ADVISOR_CHAT_SETTING_ACTION_TYPES}, in main. Never throws. */
export async function dispatchAdvisorChatSetting(
  action: AdvisorChatSettingAction,
  host: AdvisorChatSettingsHost,
  call: AdvisorChatSettingsCall,
): Promise<AppAdvisorActionResponse> {
  let outcome: Outcome;
  try {
    outcome = await run(action, host, call);
  } catch (error) {
    outcome = failure({
      code: 'execution_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return { ...outcome, requestId: call.requestId };
}
