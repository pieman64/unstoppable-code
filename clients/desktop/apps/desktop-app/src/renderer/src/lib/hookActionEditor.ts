import {
  createCommandHookEnvVarToken,
  createPromptHookEnvVarToken,
  HOOK_ENV_VISIBLE_VAR_DEFINITIONS,
  type PipelineHookSource,
  type HookEnvVarDefinition,
} from '@canopy/desktop-shared/hooks';
import type { CommandShellDefinition } from '@canopy/desktop-shared/scripts';
import {
  type AgentModelConfig,
  type ChatTabPluginSelections,
  hasAnySelections,
  THINKING_LEVELS,
  THINKING_UI_LEVELS,
  type ThinkingLevel,
  type ThinkingUiLevel,
} from '@canopy/desktop-shared/types';
import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import {
  getShareablePluginRefKey,
  type ShareablePluginRef,
} from '@canopy/desktop-shared/plugin-refs';
import type { PipelineInputDef } from '@canopy/execution-engine/types/pipeline';
import type {
  EditableHookAction,
  EditableHookActionDraft,
} from './editableHooks';
import { getTypedInputInitialValue } from './pipelineInputWidget';

export type HookActionFormAction = EditableHookAction | EditableHookActionDraft;
export type HookTextInsertionMode = 'command' | 'prompt';
export type ChatHookActionFormAction = Extract<
  HookActionFormAction,
  { type: 'chat' }
>;
export type PipelineHookActionFormAction = Extract<
  HookActionFormAction,
  { type: 'pipeline' }
>;

const PRECOMMIT_FAILURE_TRIGGER = 'worktree:precommit:failure';
const PRECOMMIT_FAILURE_VAR_SUFFIXES = [
  '_WORKTREE_PRECOMMIT_FAILURE_ERROR',
  '_WORKTREE_PRECOMMIT_FAILURE_COMMIT_MESSAGE',
] as const;
const PR_QUEUE_TRIGGERS: readonly string[] = [
  'pr:queue:entered',
  'pr:queue:removed',
];
const PR_QUEUE_VAR_SUFFIXES = [
  '_PR_QUEUE_ENTRY_ID',
  '_PR_QUEUE_REMOVAL_REASON',
] as const;
const PR_VAR_SUFFIX_MARKER = '_PR_';

export function getHookEnvVarDefinitionsForTrigger(
  triggerName: string,
): HookEnvVarDefinition[] {
  const isPrecommitFailure = triggerName === PRECOMMIT_FAILURE_TRIGGER;

  return HOOK_ENV_VISIBLE_VAR_DEFINITIONS.filter((definition) => {
    if (
      PRECOMMIT_FAILURE_VAR_SUFFIXES.some((suffix) =>
        definition.name.endsWith(suffix),
      )
    ) {
      return isPrecommitFailure;
    }
    if (
      PR_QUEUE_VAR_SUFFIXES.some((suffix) => definition.name.endsWith(suffix))
    ) {
      return PR_QUEUE_TRIGGERS.includes(triggerName);
    }
    if (definition.name.includes(PR_VAR_SUFFIX_MARKER)) {
      return !isPrecommitFailure;
    }
    return true;
  });
}

/**
 * Returns the UI-selectable thinking levels for the editor dropdown.
 *
 * The provider distinction was removed alongside the unified UI cycle (see
 * `THINKING_UI_LEVELS` in `@canopy/desktop-shared/types`), so the dropdown is now uniform
 * across providers.
 */
export function getThinkingOptions(): ThinkingUiLevel[] {
  return [...THINKING_UI_LEVELS];
}

export function buildCommandAction(
  command: string,
  uiId?: string,
  shell?: CommandShellDefinition,
  interactive?: boolean,
): HookActionFormAction {
  if (uiId) {
    const nextAction: HookActionFormAction = {
      uiId,
      type: 'command',
      command,
    };
    if (shell !== undefined) {
      nextAction.shell = shell;
    }
    if (interactive === true) {
      nextAction.interactive = true;
    }
    return nextAction;
  }

  const nextAction: HookActionFormAction = {
    type: 'command',
    command,
  };
  if (shell !== undefined) {
    nextAction.shell = shell;
  }
  if (interactive === true) {
    nextAction.interactive = true;
  }
  return nextAction;
}

export function updateCommandAction(
  action: Extract<HookActionFormAction, { type: 'command' }>,
  updates: {
    command?: string;
    shell?: CommandShellDefinition;
    interactive?: boolean;
  },
): HookActionFormAction {
  return buildCommandAction(
    'command' in updates && updates.command !== undefined
      ? updates.command
      : action.command,
    getActionUiId(action),
    'shell' in updates ? updates.shell : action.shell,
    'interactive' in updates ? updates.interactive : action.interactive,
  );
}

export function buildChatAction(
  prompt: string,
  model?: string,
  thinking?: ThinkingLevel,
  uiId?: string,
  ifCommand?: string,
  plugins?: ShareablePluginRef[],
  allowChatConcurrency?: boolean,
  modelConfig?: AgentModelConfig,
  autoArchive?: boolean,
  pluginSelections?: ChatTabPluginSelections,
): HookActionFormAction {
  const nextModelConfig: AgentModelConfig = {
    ...(modelConfig ?? {}),
    ...(modelConfig?.thinkingLevel === undefined && thinking
      ? { thinkingLevel: thinking }
      : {}),
  };

  if (uiId) {
    const nextAction: EditableHookAction = {
      uiId,
      type: 'chat',
      prompt,
    };
    if (model) {
      nextAction.model = model;
    }
    if (Object.keys(nextModelConfig).length > 0) {
      nextAction.modelConfig = nextModelConfig;
    }
    if (ifCommand !== undefined) {
      nextAction['if-command'] = ifCommand;
    }
    if (plugins && plugins.length > 0) {
      nextAction.plugins = plugins;
    }
    if (pluginSelections && hasAnySelections(pluginSelections)) {
      nextAction.pluginSelections = normalizePluginSelections(pluginSelections);
    }
    if (allowChatConcurrency === true) {
      nextAction.allowChatConcurrency = true;
    }
    if (autoArchive === true) {
      nextAction.autoArchive = true;
    }
    return nextAction;
  }

  const nextAction: EditableHookActionDraft = {
    type: 'chat',
    prompt,
  };
  if (model) {
    nextAction.model = model;
  }
  if (Object.keys(nextModelConfig).length > 0) {
    nextAction.modelConfig = nextModelConfig;
  }
  if (ifCommand !== undefined) {
    nextAction['if-command'] = ifCommand;
  }
  if (plugins && plugins.length > 0) {
    nextAction.plugins = plugins;
  }
  if (pluginSelections && hasAnySelections(pluginSelections)) {
    nextAction.pluginSelections = normalizePluginSelections(pluginSelections);
  }
  if (allowChatConcurrency === true) {
    nextAction.allowChatConcurrency = true;
  }
  if (autoArchive === true) {
    nextAction.autoArchive = true;
  }
  return nextAction;
}

export function updateChatAction(
  action: ChatHookActionFormAction,
  updates: {
    prompt?: string;
    ifCommand?: string;
    plugins?: ShareablePluginRef[];
    pluginSelections?: ChatTabPluginSelections;
    /**
     * Tri-state on update: `true` writes the field, `undefined` removes it,
     * and an absent key leaves any existing value untouched. We never write
     * the literal `false` — see the "omit absent/false values" decision in
     * the frontend plan.
     */
    allowChatConcurrency?: boolean;
    /** Tri-state, same contract as `allowChatConcurrency`. */
    autoArchive?: boolean;
  },
): HookActionFormAction {
  const nextPrompt =
    'prompt' in updates && updates.prompt !== undefined
      ? updates.prompt
      : action.prompt;
  const nextIfCommand =
    'ifCommand' in updates ? updates.ifCommand : action['if-command'];
  const nextPlugins = 'plugins' in updates ? updates.plugins : action.plugins;
  const nextPluginSelections =
    'pluginSelections' in updates
      ? updates.pluginSelections
      : action.pluginSelections;
  const nextAllowChatConcurrency =
    'allowChatConcurrency' in updates
      ? updates.allowChatConcurrency
      : action.allowChatConcurrency;
  const nextAutoArchive =
    'autoArchive' in updates ? updates.autoArchive : action.autoArchive;

  return preserveLocalPluginSelectionOverlay(
    action,
    buildChatAction(
      nextPrompt,
      action.model,
      action.modelConfig?.thinkingLevel ?? action.thinking,
      getActionUiId(action),
      nextIfCommand,
      nextPlugins,
      nextAllowChatConcurrency,
      action.modelConfig,
      nextAutoArchive,
      nextPluginSelections,
    ),
  );
}

function preserveLocalPluginSelectionOverlay(
  previousAction: ChatHookActionFormAction,
  nextAction: HookActionFormAction,
): HookActionFormAction {
  if (nextAction.type === 'chat') {
    if (previousAction.promptReferences !== undefined)
      nextAction.promptReferences = previousAction.promptReferences;
    if (previousAction.planMode !== undefined)
      nextAction.planMode = previousAction.planMode;
    if (previousAction.approvalMode !== undefined)
      nextAction.approvalMode = previousAction.approvalMode;
  }
  if (
    previousAction.localPluginSelectionOverlay !== true ||
    !previousAction.localPluginSelectionOverlayKey ||
    nextAction.type !== 'chat'
  ) {
    return nextAction;
  }

  return {
    ...nextAction,
    localPluginSelectionOverlay: true,
    localPluginSelectionOverlayKey:
      previousAction.localPluginSelectionOverlayKey,
  };
}

export function getActionUiId(
  action: HookActionFormAction,
): string | undefined {
  return 'uiId' in action ? action.uiId : undefined;
}

export function buildPipelineAction(
  source: PipelineHookSource,
  id: string,
  inputs?: Record<string, string>,
  uiId?: string,
  allowPipelineConcurrency?: boolean,
  modelConfig?: Pick<AgentModelConfig, 'fastMode'>,
): HookActionFormAction {
  if (uiId) {
    const nextAction: EditableHookAction = {
      uiId,
      type: 'pipeline',
      source,
      id,
    };
    if (inputs && Object.keys(inputs).length > 0) {
      nextAction.inputs = { ...inputs };
    }
    if (modelConfig && Object.keys(modelConfig).length > 0) {
      nextAction.modelConfig = { ...modelConfig };
    }
    if (allowPipelineConcurrency === true) {
      nextAction.allowPipelineConcurrency = true;
    }
    return nextAction;
  }

  const nextAction: EditableHookActionDraft = {
    type: 'pipeline',
    source,
    id,
  };
  if (inputs && Object.keys(inputs).length > 0) {
    nextAction.inputs = { ...inputs };
  }
  if (modelConfig && Object.keys(modelConfig).length > 0) {
    nextAction.modelConfig = { ...modelConfig };
  }
  if (allowPipelineConcurrency === true) {
    nextAction.allowPipelineConcurrency = true;
  }
  return nextAction;
}

export function updatePipelineAction(
  action: PipelineHookActionFormAction,
  updates: {
    source?: PipelineHookSource;
    id?: string;
    inputs?: Record<string, string>;
    /**
     * Tri-state on update: `true` writes the field, `undefined` removes it,
     * and an absent key leaves any existing value untouched. We never write
     * the literal `false` — see the "omit absent/false values" decision in
     * the frontend plan.
     */
    allowPipelineConcurrency?: boolean;
  },
): HookActionFormAction {
  const nextSource =
    'source' in updates && updates.source !== undefined
      ? updates.source
      : action.source;
  const nextId =
    'id' in updates && updates.id !== undefined ? updates.id : action.id;
  const nextInputs = 'inputs' in updates ? updates.inputs : action.inputs;
  const nextAllowPipelineConcurrency =
    'allowPipelineConcurrency' in updates
      ? updates.allowPipelineConcurrency
      : action.allowPipelineConcurrency;

  return buildPipelineAction(
    nextSource,
    nextId,
    nextInputs,
    getActionUiId(action),
    nextAllowPipelineConcurrency,
    action.modelConfig,
  );
}

function getRequiredTypedPipelineInputSeed(
  def: PipelineInputDef,
): string | undefined {
  if (def.required !== true) {
    return undefined;
  }

  const inputType = def.type ?? 'string';
  if (inputType !== 'boolean' && inputType !== 'choice') {
    return undefined;
  }

  const initialValue = getTypedInputInitialValue(def);
  return initialValue.length > 0 ? initialValue : undefined;
}

export function retainPipelineInputsForSelection(args: {
  currentInputs: Record<string, string> | undefined;
  nextDefs: Array<[string, PipelineInputDef]>;
}): Record<string, string> | undefined {
  const filteredInputs: Record<string, string> = {};

  for (const [key, def] of args.nextDefs) {
    const value = args.currentInputs?.[key];
    const requiredTypedSeed = getRequiredTypedPipelineInputSeed(def);
    if (value !== undefined) {
      if (value.length > 0) {
        filteredInputs[key] = value;
        continue;
      }
      if (requiredTypedSeed !== undefined) {
        filteredInputs[key] = requiredTypedSeed;
        continue;
      }
      if (def.required === true) {
        filteredInputs[key] = value;
      }
      continue;
    }

    if (requiredTypedSeed !== undefined) {
      filteredInputs[key] = requiredTypedSeed;
    }
  }

  return Object.keys(filteredInputs).length > 0 ? filteredInputs : undefined;
}

export function createBlankHookAction(
  type: EditableHookAction['type'],
): EditableHookActionDraft {
  if (type === 'chat') {
    return { type: 'chat', prompt: '' };
  }
  if (type === 'pipeline') {
    return { type: 'pipeline', source: 'bundled', id: '', inputs: {} };
  }
  return { type: 'command', command: '' };
}

export function parseActionType(value: string): EditableHookAction['type'] {
  if (value === 'chat') {
    return 'chat';
  }
  if (value === 'pipeline') {
    return 'pipeline';
  }
  return 'command';
}

function parseThinkingLevel(value: string): ThinkingLevel | undefined {
  const normalized = THINKING_LEVELS.find((level) => level === value);
  return normalized;
}

function withoutThinkingLevel(config: AgentModelConfig): AgentModelConfig {
  const next = { ...config };
  delete next.thinkingLevel;
  return next;
}

function withoutFastMode(config: AgentModelConfig): AgentModelConfig {
  const next = { ...config };
  delete next.fastMode;
  return next;
}

export function applyChatModelSelection(
  action: HookActionFormAction,
  nextModelValue: string,
): HookActionFormAction {
  if (action.type !== 'chat') {
    return action;
  }

  const nextModel = nextModelValue.trim();
  const resolvedModel = nextModel.length > 0 ? nextModel : undefined;
  return preserveLocalPluginSelectionOverlay(
    action,
    buildChatAction(
      action.prompt,
      resolvedModel,
      action.modelConfig?.thinkingLevel ?? action.thinking,
      getActionUiId(action),
      action['if-command'],
      action.plugins,
      action.allowChatConcurrency,
      action.modelConfig,
      action.autoArchive,
      action.pluginSelections,
    ),
  );
}

export function applyChatThinkingSelection(
  action: HookActionFormAction,
  nextThinkingValue: string,
): HookActionFormAction {
  if (action.type !== 'chat') {
    return action;
  }

  const parsed = parseThinkingLevel(nextThinkingValue.trim());
  const nextThinking = parsed ?? undefined;
  const restModelConfig = withoutThinkingLevel(action.modelConfig ?? {});
  const nextModelConfig = {
    ...restModelConfig,
    ...(nextThinking ? { thinkingLevel: nextThinking } : {}),
  };

  return preserveLocalPluginSelectionOverlay(
    action,
    buildChatAction(
      action.prompt,
      action.model,
      nextThinking,
      getActionUiId(action),
      action['if-command'],
      action.plugins,
      action.allowChatConcurrency,
      nextModelConfig,
      action.autoArchive,
      action.pluginSelections,
    ),
  );
}

export function applyChatFastModeSelection(
  action: HookActionFormAction,
  nextFastMode: boolean | undefined,
): HookActionFormAction {
  if (action.type !== 'chat') {
    return action;
  }

  const restModelConfig = withoutFastMode(action.modelConfig ?? {});
  const nextModelConfig = {
    ...restModelConfig,
    ...(typeof nextFastMode === 'boolean' ? { fastMode: nextFastMode } : {}),
  };

  return preserveLocalPluginSelectionOverlay(
    action,
    buildChatAction(
      action.prompt,
      action.model,
      nextModelConfig.thinkingLevel ?? action.thinking,
      getActionUiId(action),
      action['if-command'],
      action.plugins,
      action.allowChatConcurrency,
      nextModelConfig,
      action.autoArchive,
      action.pluginSelections,
    ),
  );
}

export function applyPipelineFastModeSelection(
  action: HookActionFormAction,
  nextFastMode: boolean | undefined,
): HookActionFormAction {
  if (action.type !== 'pipeline') {
    return action;
  }

  return buildPipelineAction(
    action.source,
    action.id,
    action.inputs,
    getActionUiId(action),
    action.allowPipelineConcurrency,
    typeof nextFastMode === 'boolean' ? { fastMode: nextFastMode } : undefined,
  );
}

/**
 * Replace the `plugins` array on a chat action with a new (already-validated)
 * portable ref list, deduplicated by canonical key. Drops the field entirely
 * when the resulting list is empty so editor state does not carry empty
 * arrays around.
 */
export function applyChatPlugins(
  action: HookActionFormAction,
  nextPlugins: ShareablePluginRef[],
): HookActionFormAction {
  if (action.type !== 'chat') {
    return action;
  }

  const seen = new Set<string>();
  const deduped: ShareablePluginRef[] = [];
  for (const ref of nextPlugins) {
    try {
      const key = getShareablePluginRefKey(ref);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(ref);
    } catch {
      // Skip malformed refs — they would fail strict canopy.json validation
      // anyway, so silently dropping here is safe.
    }
  }

  return updateChatAction(action, {
    plugins: deduped.length > 0 ? deduped : undefined,
  });
}

/** Replace the full runtime plugin selection set on a hook chat action. */
export function applyChatPluginSelections(
  action: HookActionFormAction,
  nextSelections: ChatTabPluginSelections,
): HookActionFormAction {
  if (action.type !== 'chat') {
    return action;
  }
  const normalized = normalizePluginSelections(nextSelections);
  return updateChatAction(action, {
    pluginSelections: hasAnySelections(normalized) ? normalized : undefined,
  });
}

const PIPELINE_HOOK_SOURCES: ReadonlySet<PipelineHookSource> =
  new Set<PipelineHookSource>(['bundled', 'local', 'project', 'curated']);

export function canAddHookAction(action: EditableHookActionDraft): boolean {
  if (action.type === 'chat') {
    return action.prompt.trim().length > 0;
  }
  if (action.type === 'pipeline') {
    return (
      PIPELINE_HOOK_SOURCES.has(action.source) && action.id.trim().length > 0
    );
  }
  return action.command.trim().length > 0;
}

export function trimHookActionDraft(
  action: EditableHookActionDraft,
): EditableHookActionDraft {
  if (action.type === 'command') {
    const nextAction: EditableHookActionDraft = {
      type: 'command',
      command: action.command.trim(),
    };
    if (action.shell !== undefined) {
      nextAction.shell = action.shell;
    }
    if (action.interactive === true) {
      nextAction.interactive = true;
    }
    return nextAction;
  }

  if (action.type === 'pipeline') {
    const nextAction: EditableHookActionDraft = {
      type: 'pipeline',
      source: action.source,
      id: action.id.trim(),
    };
    if (action.inputs && Object.keys(action.inputs).length > 0) {
      // Trim keys, drop blanks. Non-empty values are passed through as-is so
      // authors can preserve trailing/leading whitespace inside templates.
      const trimmedInputs: Record<string, string> = {};
      for (const [rawKey, rawValue] of Object.entries(action.inputs)) {
        if (typeof rawKey !== 'string') {
          continue;
        }
        const key = rawKey.trim();
        if (key.length === 0) {
          continue;
        }
        if (rawValue.length === 0) {
          continue;
        }
        trimmedInputs[key] = rawValue;
      }
      if (Object.keys(trimmedInputs).length > 0) {
        nextAction.inputs = trimmedInputs;
      }
    }
    if (action.modelConfig && Object.keys(action.modelConfig).length > 0) {
      nextAction.modelConfig = { ...action.modelConfig };
    }
    if (action.allowPipelineConcurrency === true) {
      nextAction.allowPipelineConcurrency = true;
    }
    return nextAction;
  }

  const nextModel = action.model?.trim();
  const nextAction: EditableHookActionDraft = {
    type: 'chat',
    prompt: action.prompt.trim(),
    ...(action.promptReferences?.length
      ? {
          promptReferences: action.promptReferences.map((ref) => ({
            ...ref,
            textStart:
              ref.textStart -
              (action.prompt.length - action.prompt.trimStart().length),
          })),
        }
      : {}),
    ...(action.planMode !== undefined ? { planMode: action.planMode } : {}),
    ...(action.approvalMode !== undefined
      ? { approvalMode: action.approvalMode }
      : {}),
  };
  if (nextModel && nextModel.length > 0) {
    nextAction.model = nextModel;
  }
  const modelConfig: AgentModelConfig = {
    ...(action.modelConfig ?? {}),
    ...(action.modelConfig?.thinkingLevel === undefined && action.thinking
      ? { thinkingLevel: action.thinking }
      : {}),
  };
  if (Object.keys(modelConfig).length > 0) {
    nextAction.modelConfig = modelConfig;
  }
  const nextIfCommand = action['if-command']?.trim();
  if (nextIfCommand && nextIfCommand.length > 0) {
    nextAction['if-command'] = nextIfCommand;
  }
  if (action.plugins && action.plugins.length > 0) {
    nextAction.plugins = action.plugins;
  }
  if (action.pluginSelections && hasAnySelections(action.pluginSelections)) {
    nextAction.pluginSelections = normalizePluginSelections(
      action.pluginSelections,
    );
  }
  // Only the literal `true` survives trimming — absent and `false` are
  // dropped so persisted JSON never carries a redundant `false`.
  if (action.allowChatConcurrency === true) {
    nextAction.allowChatConcurrency = true;
  }
  if (action.autoArchive === true) {
    nextAction.autoArchive = true;
  }
  return nextAction;
}

export function createHookEnvVarInsertion(
  mode: HookTextInsertionMode,
  variableName: string,
): string {
  return mode === 'command'
    ? createCommandHookEnvVarToken(variableName)
    : createPromptHookEnvVarToken(variableName);
}

export { insertTextAtSelection } from './textInsertion';
