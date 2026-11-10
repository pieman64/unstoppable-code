import type {
  AgentModelConfig,
  ApprovalMode,
  ConfiguredPromptReference,
  ChatTabPluginSelections,
  HookAction,
  HookInputMap,
  HookOverrides,
  PipelineHookSource,
  ThinkingLevel,
} from '@canopy/desktop-shared/types';
import type { CommandShellDefinition } from '@canopy/desktop-shared/scripts';
import {
  compareTriggerNames,
  normalizeHookInputMap,
  normalizeHookValue,
} from '@canopy/desktop-shared/hooks';
import type { ShareablePluginRef } from '@canopy/execution-engine/plugin-refs';

export type EditableHookActionDraft =
  | {
      type: 'command';
      command: string;
      shell?: CommandShellDefinition;
      interactive?: true;
    }
  | {
      type: 'chat';
      prompt: string;
      promptReferences?: ConfiguredPromptReference[];
      planMode?: boolean;
      approvalMode?: ApprovalMode;
      model?: string;
      modelConfig?: AgentModelConfig;
      /** @deprecated Normalized to modelConfig.thinkingLevel. */
      thinking?: ThinkingLevel;
      'if-command'?: string;
      plugins?: ShareablePluginRef[];
      pluginSelections?: ChatTabPluginSelections;
      localPluginSelectionOverlay?: boolean;
      localPluginSelectionOverlayKey?: string;
      /**
       * Mirrors `ChatHookAction.allowChatConcurrency`. Only the literal
       * `true` is preserved through the editable model — absent and `false`
       * are dropped so unchecked UI saves do not churn `canopy.json`.
       */
      allowChatConcurrency?: boolean;
      /**
       * Mirrors `ChatHookAction.autoArchive`. Only the literal `true` is
       * preserved through the editable model — absent and `false` are dropped
       * so unchecked UI saves do not churn `canopy.json`.
       */
      autoArchive?: boolean;
    }
  | {
      type: 'pipeline';
      source: PipelineHookSource;
      id: string;
      inputs?: Record<string, string>;
      modelConfig?: Pick<AgentModelConfig, 'fastMode'>;
      /**
       * Mirrors `PipelineHookAction.allowPipelineConcurrency`. Only the
       * literal `true` is preserved through the editable model — absent
       * and `false` are dropped so unchecked UI saves do not churn
       * `canopy.json`.
       */
      allowPipelineConcurrency?: boolean;
    };

export type EditableHookAction =
  | {
      uiId: string;
      type: 'command';
      command: string;
      shell?: CommandShellDefinition;
      interactive?: true;
    }
  | {
      uiId: string;
      type: 'chat';
      prompt: string;
      promptReferences?: ConfiguredPromptReference[];
      planMode?: boolean;
      approvalMode?: ApprovalMode;
      model?: string;
      modelConfig?: AgentModelConfig;
      /** @deprecated Normalized to modelConfig.thinkingLevel. */
      thinking?: ThinkingLevel;
      'if-command'?: string;
      plugins?: ShareablePluginRef[];
      pluginSelections?: ChatTabPluginSelections;
      localPluginSelectionOverlay?: boolean;
      localPluginSelectionOverlayKey?: string;
      /**
       * Mirrors `ChatHookAction.allowChatConcurrency`. Only the literal
       * `true` is preserved through the editable model — absent and `false`
       * are dropped so unchecked UI saves do not churn `canopy.json`.
       */
      allowChatConcurrency?: boolean;
      /**
       * Mirrors `ChatHookAction.autoArchive`. Only the literal `true` is
       * preserved through the editable model — absent and `false` are dropped
       * so unchecked UI saves do not churn `canopy.json`.
       */
      autoArchive?: boolean;
    }
  | {
      uiId: string;
      type: 'pipeline';
      source: PipelineHookSource;
      id: string;
      inputs?: Record<string, string>;
      modelConfig?: Pick<AgentModelConfig, 'fastMode'>;
      /**
       * Mirrors `PipelineHookAction.allowPipelineConcurrency`. Only the
       * literal `true` is preserved through the editable model — absent
       * and `false` are dropped so unchecked UI saves do not churn
       * `canopy.json`.
       */
      allowPipelineConcurrency?: boolean;
    };

/**
 * Renderer-side editable representation of hooks.
 * Maps trigger names to action arrays or null disable sentinels.
 */
export type EditableHooks = Record<string, EditableHookAction[] | null>;

let editableHookActionCounter = 0;

function createEditableHookActionId(): string {
  editableHookActionCounter += 1;
  return `hook-action-${editableHookActionCounter}`;
}

function buildEditableHookAction(
  action: EditableHookActionDraft,
  uiId?: string,
): EditableHookAction {
  const nextId = uiId ?? createEditableHookActionId();
  if (action.type === 'command') {
    const nextAction: EditableHookAction = {
      uiId: nextId,
      type: 'command',
      command: action.command,
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
    const nextAction: EditableHookAction = {
      uiId: nextId,
      type: 'pipeline',
      source: action.source,
      id: action.id,
    };
    if (action.inputs && Object.keys(action.inputs).length > 0) {
      nextAction.inputs = { ...action.inputs };
    }
    if (action.modelConfig && Object.keys(action.modelConfig).length > 0) {
      nextAction.modelConfig = { ...action.modelConfig };
    }
    if (action.allowPipelineConcurrency === true) {
      nextAction.allowPipelineConcurrency = true;
    }
    return nextAction;
  }

  const nextAction: EditableHookAction = {
    uiId: nextId,
    type: 'chat',
    prompt: action.prompt,
  };
  if (action.promptReferences?.length)
    nextAction.promptReferences = action.promptReferences;
  if (action.planMode !== undefined) nextAction.planMode = action.planMode;
  if (action.approvalMode !== undefined)
    nextAction.approvalMode = action.approvalMode;
  if (action.model) {
    nextAction.model = action.model;
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
  if (action['if-command'] !== undefined) {
    nextAction['if-command'] = action['if-command'];
  }
  if (action.plugins && action.plugins.length > 0) {
    nextAction.plugins = action.plugins;
  }
  if (action.pluginSelections) {
    nextAction.pluginSelections = action.pluginSelections;
  }
  if (action.localPluginSelectionOverlay === true) {
    nextAction.localPluginSelectionOverlay = true;
  }
  if (action.localPluginSelectionOverlayKey) {
    nextAction.localPluginSelectionOverlayKey =
      action.localPluginSelectionOverlayKey;
  }
  if (action.allowChatConcurrency === true) {
    nextAction.allowChatConcurrency = true;
  }
  if (action.autoArchive === true) {
    nextAction.autoArchive = true;
  }
  return nextAction;
}

function ensureEditableHookAction(
  action: EditableHookAction | EditableHookActionDraft,
): EditableHookAction {
  if ('uiId' in action) {
    return action;
  }

  return buildEditableHookAction(action);
}

function stripEditableHookAction(
  action: EditableHookAction,
): EditableHookActionDraft {
  if (action.type === 'command') {
    const nextAction: EditableHookActionDraft = {
      type: 'command',
      command: action.command,
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
      id: action.id,
    };
    if (action.inputs && Object.keys(action.inputs).length > 0) {
      nextAction.inputs = { ...action.inputs };
    }
    if (action.modelConfig && Object.keys(action.modelConfig).length > 0) {
      nextAction.modelConfig = { ...action.modelConfig };
    }
    if (action.allowPipelineConcurrency === true) {
      nextAction.allowPipelineConcurrency = true;
    }
    return nextAction;
  }

  const nextAction: EditableHookActionDraft = {
    type: 'chat',
    prompt: action.prompt,
  };
  if (action.promptReferences?.length)
    nextAction.promptReferences = action.promptReferences;
  if (action.planMode !== undefined) nextAction.planMode = action.planMode;
  if (action.approvalMode !== undefined)
    nextAction.approvalMode = action.approvalMode;
  if (action.model) {
    nextAction.model = action.model;
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
  if (action['if-command'] !== undefined) {
    nextAction['if-command'] = action['if-command'];
  }
  if (action.plugins && action.plugins.length > 0) {
    nextAction.plugins = action.plugins;
  }
  if (action.pluginSelections) {
    nextAction.pluginSelections = action.pluginSelections;
  }
  if (action.localPluginSelectionOverlay === true) {
    nextAction.localPluginSelectionOverlay = true;
  }
  if (action.localPluginSelectionOverlayKey) {
    nextAction.localPluginSelectionOverlayKey =
      action.localPluginSelectionOverlayKey;
  }
  if (action.allowChatConcurrency === true) {
    nextAction.allowChatConcurrency = true;
  }
  if (action.autoArchive === true) {
    nextAction.autoArchive = true;
  }
  return nextAction;
}

/**
 * Create an editable hooks map from a HookOverrides object.
 * Preserves runnable hooks and explicit null disables.
 */
export function createEditableHooks(
  hooks: HookOverrides | undefined,
): EditableHooks {
  const normalized = normalizeHookInputMap(hooks);
  if (!normalized) {
    return {};
  }

  const editable: EditableHooks = {};
  for (const [triggerName, value] of Object.entries(normalized)) {
    editable[triggerName] =
      value === null
        ? null
        : value.map((action) => buildEditableHookAction(action));
  }
  return editable;
}

/**
 * Get the action list for a specific trigger, returning an empty array if absent.
 */
export function getEditableHookActions(
  hooks: EditableHooks,
  triggerName: string,
): EditableHookAction[] {
  const value = hooks[triggerName];
  return Array.isArray(value) ? value : [];
}

/**
 * Returns whether the trigger is explicitly disabled in the editable model.
 */
export function isEditableHookDisabled(
  hooks: EditableHooks,
  triggerName: string,
): boolean {
  return hooks[triggerName] === null;
}

/**
 * Replace the entire action list for a trigger.
 * If the list becomes empty, the trigger entry is removed.
 */
export function setEditableHookActions(
  hooks: EditableHooks,
  triggerName: string,
  actions: Array<EditableHookAction | EditableHookActionDraft>,
): EditableHooks {
  const next: EditableHooks = { ...hooks };
  if (actions.length === 0) {
    delete next[triggerName];
  } else {
    next[triggerName] = actions.map((action) =>
      ensureEditableHookAction(action),
    );
  }
  return next;
}

/**
 * Add a single action to a trigger's action list.
 */
export function addEditableHookAction(
  hooks: EditableHooks,
  triggerName: string,
  action: EditableHookAction | EditableHookActionDraft,
): EditableHooks {
  const existing = getEditableHookActions(hooks, triggerName);
  return {
    ...hooks,
    [triggerName]: [...existing, ensureEditableHookAction(action)],
  };
}

/**
 * Explicitly disable or re-enable a trigger in the editable model.
 * Re-enabling removes the local sentinel and falls back to inheritance.
 */
export function setEditableHookDisabled(
  hooks: EditableHooks,
  triggerName: string,
  disabled: boolean,
): EditableHooks {
  if (disabled) {
    if (hooks[triggerName] === null) {
      return hooks;
    }

    return {
      ...hooks,
      [triggerName]: null,
    };
  }

  if (hooks[triggerName] === undefined) {
    return hooks;
  }

  const next: EditableHooks = { ...hooks };
  delete next[triggerName];
  return next;
}

/**
 * Remove an action at a specific index from a trigger's action list.
 * If the list becomes empty, the trigger entry is removed.
 */
export function removeEditableHookAction(
  hooks: EditableHooks,
  triggerName: string,
  index: number,
): EditableHooks {
  const existing = hooks[triggerName];
  if (!Array.isArray(existing) || index < 0 || index >= existing.length) {
    return hooks;
  }

  const updated = [...existing];
  updated.splice(index, 1);
  return setEditableHookActions(hooks, triggerName, updated);
}

/**
 * Move an action within a trigger's list from one index to another.
 */
export function moveEditableHookAction(
  hooks: EditableHooks,
  triggerName: string,
  fromIndex: number,
  toIndex: number,
): EditableHooks {
  const existing = hooks[triggerName];
  if (!Array.isArray(existing)) {
    return hooks;
  }
  if (
    fromIndex < 0 ||
    fromIndex >= existing.length ||
    toIndex < 0 ||
    toIndex >= existing.length ||
    fromIndex === toIndex
  ) {
    return hooks;
  }

  const updated = [...existing];
  const [moved] = updated.splice(fromIndex, 1);
  updated.splice(toIndex, 0, moved);
  return {
    ...hooks,
    [triggerName]: updated,
  };
}

/**
 * Replace a single action in a trigger's list.
 */
export function updateEditableHookAction(
  hooks: EditableHooks,
  triggerName: string,
  index: number,
  action: EditableHookAction | EditableHookActionDraft,
): EditableHooks {
  const existing = hooks[triggerName];
  if (!Array.isArray(existing) || index < 0 || index >= existing.length) {
    return hooks;
  }

  const updated = [...existing];
  const existingAction = updated[index];
  const nextAction =
    'uiId' in action
      ? action
      : buildEditableHookAction(action, existingAction?.uiId);
  updated[index] = nextAction;
  return {
    ...hooks,
    [triggerName]: updated,
  };
}

/**
 * Convert editable hooks back to a HookInputMap for IPC save calls.
 * Preserves null tombstones from raw overrides so that disabled inherited
 * hooks are not silently re-enabled when saving unrelated edits.
 */
export function toHookInputMap(
  hooks: EditableHooks,
  rawOverrides?: HookOverrides,
  includeDisabled = true,
): HookInputMap {
  const payload: HookInputMap = {};

  if (includeDisabled && rawOverrides) {
    for (const [triggerName, value] of Object.entries(rawOverrides)) {
      if (value === null) {
        payload[triggerName] = null;
      }
    }
  }

  for (const [triggerName, value] of Object.entries(hooks)) {
    if (value === null) {
      if (includeDisabled) {
        payload[triggerName] = null;
      }
      continue;
    }

    const normalizedActions: HookAction[] | null | undefined =
      normalizeHookValue(
        value.map((action) => stripEditableHookAction(action)),
      );
    if (normalizedActions && normalizedActions.length > 0) {
      payload[triggerName] = normalizedActions;
    }
  }

  return payload;
}

/**
 * Serialize hooks for dirty-state comparison.
 * Sorted by trigger order for deterministic comparisons.
 */
export function serializeHooks(hooks: EditableHooks): string {
  const entries = Object.entries(hooks).sort((left, right) =>
    compareTriggerNames(left[0], right[0]),
  );
  const serializedEntries: Array<[string, EditableHookActionDraft[] | null]> =
    entries.map(([triggerName, value]) => [
      triggerName,
      value === null
        ? null
        : value.map((action) => stripEditableHookAction(action)),
    ]);
  return JSON.stringify(serializedEntries);
}
