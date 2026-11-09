// ---------------------------------------------------------------------------
// Hook primitives and helpers — mirrors the scripts pattern but trigger-based.
// ---------------------------------------------------------------------------

import type { AgentModelConfig, ChatTabPluginSelections } from './types';
import {
  normalizeConfiguredPrompt,
  type ConfiguredPromptReference,
} from '@canopy/protocol/configured-prompt-references';
import { APPROVAL_MODES, type ApprovalMode } from './types/approvals';
import {
  isChatTabPluginSelections,
  normalizePluginSelections,
} from './lib/plugin-selections-normalization';
import type { ChatModel } from '@canopy/execution-engine/types/chat-models';
import { isThinkingLevel } from '@canopy/execution-engine/thinking';
import type { ThinkingLevel } from '@canopy/execution-engine/types/thinking';
import {
  codexSpeedFastMode,
  isCodexSpeed,
  readCodexSpeedRecord,
  withCodexSpeed,
} from '@canopy/execution-engine/lib/codex-speed';
import {
  getShareablePluginRefKey,
  normalizeShareablePluginRef,
  type ShareablePluginRef,
} from './plugin-refs';
import {
  compareIndexedNames,
  parseWorkspaceRepoScopedValue,
  titleCaseIdentifier,
} from './lib/scoped-config-utils';
import { BRAND } from '@canopy/brand/current';
import { brandEnvCandidates } from '@canopy/execution-engine/brand/env';
import {
  normalizeCommandShellDefinition,
  type CommandShellDefinition,
} from './scripts';
import {
  HOOK_TRIGGER_DISPLAY_LABELS,
  hookTriggerIndex,
  isHookTriggerName,
  PR_HOOK_TRIGGERS,
  WORKTREE_HOOK_TRIGGERS,
  type HookTriggerName,
} from '@canopy/protocol/hook-triggers';

export type { HookTriggerName };
export { isHookTriggerName };

export interface CommandHookAction {
  type: 'command';
  command: string;
  shell?: CommandShellDefinition;
  /** Back this command with a writable workspace terminal. */
  interactive?: true;
}

export interface ChatHookAction {
  type: 'chat';
  prompt: string;
  /** Machine-local owner binding captured when the hook is enabled. */
  executionContext?: string;
  /** Machine-local binding stub; never executable or written to canopy.json. */
  localExecutionContextOverlay?: boolean;
  promptReferences?: ConfiguredPromptReference[];
  planMode?: boolean;
  /**
   * Marks the compact, machine-local copy retained during source-control
   * conversion solely to overlay runtime plugin selections onto a matching
   * source-controlled action. Never written to canopy.json.
   */
  localPluginSelectionOverlay?: boolean;
  /**
   * Stable identity for the source-controlled chat action that this local
   * selection overlay augments. Never written to canopy.json.
   */
  localPluginSelectionOverlayKey?: string;
  model?: ChatModel;
  /**
   * Chat model tuning. `speed` supports all three Codex speeds; an absent
   * speed (and absent legacy boolean) inherits the resolved default.
   */
  modelConfig?: AgentModelConfig;
  /** @deprecated Read only; normalized to modelConfig.thinkingLevel. */
  thinking?: ThinkingLevel;
  /** @deprecated Read only; legacy alias read after modelConfig.speed/fastMode. */
  codexFastMode?: boolean;
  /**
   * Approval mode for the chat launched by this hook. Absent falls back to
   * the worktree's resolved default approval mode.
   */
  approvalMode?: ApprovalMode;
  'if-command'?: string;
  /**
   * Optional list of portable plugin refs to inject into the chat created
   * by this hook. Only shareable skill and plugin refs are allowed; bundle
   * refs are rejected by the strict `canopy.json` parser because
   * `canopy.json` is source-controlled and portable.
   */
  plugins?: ShareablePluginRef[];
  /**
   * Full runtime selections for locally persisted hooks. Source-controlled
   * `canopy.json` rejects this field because Collections, installed sources,
   * and MCP configs may resolve machine-local credentials. Use the portable
   * `plugins` list in `canopy.json` instead.
   */
  pluginSelections?: ChatTabPluginSelections;
  /**
   * When `true`, this chat hook may run concurrently with other active chats
   * in the same worktree. When absent or `false`, the hook chat defers
   * (queues) until existing chat turns for that worktree finish. Only the
   * literal `true` value is persisted; absent and `false` values are omitted
   * from normalized JSON so unchecked UI saves do not churn `canopy.json`.
   */
  allowChatConcurrency?: boolean;
  /**
   * When `true`, the chat created by this hook is automatically archived as
   * soon as its agent turn finishes (it may be archived in an unread state).
   * When absent or `false`, the hook chat behaves like any other chat. Only the
   * literal `true` value is persisted; absent and `false` values are omitted
   * from normalized JSON so unchecked UI saves do not churn `canopy.json`.
   */
  autoArchive?: boolean;
}

export type PipelineHookSource = 'bundled' | 'local' | 'project' | 'curated';

export interface PipelineHookAction {
  executionContext?: string;
  /** Machine-local binding stub; never executable or written to canopy.json. */
  localExecutionContextOverlay?: boolean;
  type: 'pipeline';
  /**
   * Identifies which pipeline registry to look the action up against.
   * - `bundled`: `id` references a bundled or stored pipeline id.
   * - `curated`: `id` is the canonical `curated:<key>` catalog identity.
   * - `local`: `id` references a user-created local pipeline id (maps to
   *   `PipelineInfo.source === "user"` internally).
   * - `project`: `id` is a relative YAML path under the target repo's
   *   `.canopy/pipelines/` directory (e.g. `"review.yaml"` or
   *   `"ci/review.yaml"`). At execution time the relative path is converted
   *   to a `pipelineId` via `getProjectPipelineId(relativePath)`.
   */
  source: PipelineHookSource;
  id: string;
  /**
   * Optional pipeline inputs. Keys must be non-empty strings; values must be
   * strings and support `{{CANOPY_...}}` interpolation with the same set of
   * supported variables as chat prompts (see `interpolateHookTemplate`).
   */
  inputs?: Record<string, string>;
  /**
   * Pipeline hooks keep the legacy boolean authoring surface. `speed` is only
   * ever retained for an `ultrafast` request read from shared/persisted data,
   * so it is never dropped or downgraded: {@link pipelineHookUnsupportedSpeedError}
   * rejects it before any pipeline side effect.
   */
  modelConfig?: Pick<AgentModelConfig, 'speed' | 'fastMode'>;
  /** @deprecated Read only; normalized to modelConfig.fastMode. */
  codexFastMode?: boolean;
  /**
   * When `true`, this pipeline hook may run concurrently with other active
   * pipeline executions. When absent or `false`, the hook pipeline defers
   * (queues) until all active pipeline executions finish. Only the literal
   * `true` value is persisted; absent and `false` values are omitted from
   * normalized JSON so unchecked UI saves do not churn `canopy.json`.
   */
  allowPipelineConcurrency?: boolean;
}

export type HookAction =
  | CommandHookAction
  | ChatHookAction
  | PipelineHookAction;

export type HookValue = HookAction[] | null;

export type HookOverrides = Record<string, HookValue>;

export type HookInputMap = Record<string, HookAction[] | null | undefined>;

export type HookScope = 'project' | 'workspace-root' | 'workspace-repo';

export interface HookEnvVarDefinition {
  name: string;
  description: string;
}

const HOOK_ENV_SUFFIX_DEFINITIONS: HookEnvVarDefinition[] = [
  {
    name: 'WORKTREE_DATA_DIR',
    description: `Path to ${BRAND.displayName} data for the current worktree.`,
  },
  {
    name: 'WORKSPACE_ID',
    description: 'Project id for the current hook target.',
  },
  {
    name: 'WORKTREE_NAME',
    description: 'Animal-name id of the current worktree.',
  },
  {
    name: 'WORKTREE_PRECOMMIT_FAILURE_ERROR',
    description: `Underlying error text from a failed ${BRAND.displayName}-managed git commit.`,
  },
  {
    name: 'WORKTREE_PRECOMMIT_FAILURE_COMMIT_MESSAGE',
    description: `Commit message from the failed ${BRAND.displayName}-managed git commit attempt.`,
  },
  {
    name: 'WORKSPACE_CHILD_REPO_ID',
    description: 'Child repo id for project child-repo hooks when available.',
  },
  {
    name: 'PR_CURRENT_FILE',
    description: 'Path to the current PR snapshot JSON for this hook run.',
  },
  {
    name: 'PR_PREV_FILE',
    description: 'Path to the previous PR snapshot JSON when one exists.',
  },
  {
    name: 'PR_BRANCH',
    description: 'PR head branch name.',
  },
  {
    name: 'PR_BASE_BRANCH',
    description: 'PR base branch name.',
  },
  {
    name: 'PR_REPO_NAME',
    description: 'Repository name for the PR.',
  },
  {
    name: 'PR_REPO_OWNER',
    description: 'Repository owner or organization for the PR.',
  },
  {
    name: 'PR_NUMBER',
    description: 'Human-visible PR number.',
  },
  {
    name: 'PR_ID',
    description: 'Alias for the human-visible PR number.',
  },
  {
    name: 'PR_URL',
    description: 'GitHub URL for the PR.',
  },
  {
    name: 'PR_QUEUE_ENTRY_ID',
    description:
      'Merge queue entry id: the new entry when the PR enters the queue, the entry it left when removed.',
  },
  {
    name: 'PR_QUEUE_REMOVAL_REASON',
    description:
      'GitHub reason the PR was removed from the merge queue, such as failed_checks. Empty when GitHub reported none.',
  },
];

export const HOOK_ENV_VAR_DEFINITIONS: HookEnvVarDefinition[] =
  HOOK_ENV_SUFFIX_DEFINITIONS.flatMap((definition) =>
    brandEnvCandidates(definition.name).map((name, index) => ({
      name,
      description:
        index === 0
          ? definition.description
          : `${definition.description} Legacy compatibility alias.`,
    })),
  );

export const HOOK_ENV_VISIBLE_VAR_DEFINITIONS: HookEnvVarDefinition[] =
  HOOK_ENV_SUFFIX_DEFINITIONS.map((definition) => ({
    name: brandEnvCandidates(definition.name)[0] ?? definition.name,
    description: definition.description,
  }));

const SUPPORTED_HOOK_ENV_VAR_NAMES = new Set(
  HOOK_ENV_VAR_DEFINITIONS.map((definition) => definition.name),
);

const SUPPORTED_HOOK_PROMPT_VAR_NAMES = new Set<string>([
  ...Array.from(SUPPORTED_HOOK_ENV_VAR_NAMES),
  'CONDUCTOR_WORKSPACE_NAME',
]);

// ---------------------------------------------------------------------------
// Supported triggers and stable ordering
// ---------------------------------------------------------------------------

/**
 * Deterministic dispatch order for PR hook triggers.
 * When a poll produces multiple triggers for one repo, they run in this order.
 */
export const SUPPORTED_PR_HOOK_TRIGGERS = [
  ...PR_HOOK_TRIGGERS,
] satisfies readonly [HookTriggerName, ...HookTriggerName[]];

export const SUPPORTED_WORKTREE_HOOK_TRIGGERS = [
  ...WORKTREE_HOOK_TRIGGERS,
] satisfies readonly [HookTriggerName, ...HookTriggerName[]];

export const SUPPORTED_HOOK_TRIGGERS = [
  ...SUPPORTED_WORKTREE_HOOK_TRIGGERS,
  ...SUPPORTED_PR_HOOK_TRIGGERS,
] satisfies readonly [HookTriggerName, ...HookTriggerName[]];

// ---------------------------------------------------------------------------
// Trigger helpers
// ---------------------------------------------------------------------------

/**
 * Compare two trigger names for deterministic ordering.
 * Known triggers are sorted by the SUPPORTED_HOOK_TRIGGERS order;
 * unknown triggers are sorted lexicographically after known ones.
 */
export function compareTriggerNames(left: string, right: string): number {
  return compareIndexedNames(left, right, hookTriggerIndex);
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize a trigger name string. Returns undefined for empty/blank inputs.
 */
export function normalizeTriggerName(
  value: string | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Lenient normalization of in-memory / renderer-authored plugin refs.
 *
 * Drops obviously-empty entries (missing required name fields, null, or
 * undefined) so a half-built draft does not crash the editor, and dedupes
 * surviving entries by their canonical ref key.
 *
 * IMPORTANT: this helper is intentionally lenient. It must not be used as
 * the only line of defence when reading `canopy.json` from disk — the strict
 * `parseHookAction` parser in `src/main/lib/canopy-json.ts` must run first
 * and reject malformed or unsupported shapes (including bundle refs).
 */
function normalizeLenientHookPlugins(
  value: unknown,
): ShareablePluginRef[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const seen = new Set<string>();
  const normalized: ShareablePluginRef[] = [];

  for (const rawEntry of value) {
    try {
      const ref = normalizeShareablePluginRef(rawEntry);
      const key = getShareablePluginRefKey(ref);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      normalized.push(ref);
    } catch {
      // Drop malformed draft entries; the strict canopy.json parser rejects
      // invalid persisted data before it reaches this lenient normalizer.
    }
  }

  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Normalize a hook value (actions array or null).
 * Returns undefined if the value should be omitted (was undefined).
 */
export function normalizeHookValue(
  value: HookAction[] | null | undefined,
): HookAction[] | null | undefined {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return undefined;
  }
  const valid = value.flatMap((action): HookAction[] => {
    if (action.type === 'command') {
      if (typeof action.command !== 'string') {
        return [];
      }

      const command = action.command.trim();
      if (command.length === 0) {
        return [];
      }
      const normalized: CommandHookAction = { type: 'command', command };
      const shell = normalizeCommandShellDefinition(action.shell);
      if (shell !== undefined) {
        normalized.shell = shell;
      }
      if (action.interactive === true) {
        normalized.interactive = true;
      }
      return [normalized];
    }

    if (action.type === 'chat') {
      if (typeof action.prompt !== 'string') {
        return [];
      }

      const prompt = action.prompt.trim();
      if (prompt.length === 0) {
        return [];
      }

      const normalized: ChatHookAction = {
        type: 'chat',
        prompt,
      };
      if (action.promptReferences !== undefined) {
        try {
          const configured = normalizeConfiguredPrompt(
            action.prompt,
            action.promptReferences,
          );
          normalized.promptReferences = configured.promptReferences;
        } catch {
          return [];
        }
      }
      if (typeof action.planMode === 'boolean') {
        normalized.planMode = action.planMode;
      }

      if (action.localPluginSelectionOverlay === true) {
        normalized.localPluginSelectionOverlay = true;
      }
      if (typeof action.localPluginSelectionOverlayKey === 'string') {
        const overlayKey = action.localPluginSelectionOverlayKey.trim();
        if (overlayKey.length > 0) {
          normalized.localPluginSelectionOverlayKey = overlayKey;
        }
      }

      if (typeof action.model === 'string') {
        const model = action.model.trim();
        if (model.length > 0) {
          normalized.model = model;
        }
      }

      const modelConfig: AgentModelConfig = {};
      if (
        typeof action.modelConfig?.thinkingLevel === 'string' &&
        isThinkingLevel(action.modelConfig.thinkingLevel)
      ) {
        modelConfig.thinkingLevel = action.modelConfig.thinkingLevel;
      } else if (
        typeof action.thinking === 'string' &&
        isThinkingLevel(action.thinking)
      ) {
        modelConfig.thinkingLevel = action.thinking;
      }
      const chatSpeed: unknown = action.modelConfig?.speed;
      if (isCodexSpeed(chatSpeed)) {
        // Speed is authoritative; the legacy boolean is re-derived so Ultra
        // fast never persists as `fastMode: true`.
        modelConfig.speed = chatSpeed;
        modelConfig.fastMode = codexSpeedFastMode(chatSpeed);
      } else if (typeof action.modelConfig?.fastMode === 'boolean') {
        modelConfig.fastMode = action.modelConfig.fastMode;
      } else if (typeof action.codexFastMode === 'boolean') {
        modelConfig.fastMode = action.codexFastMode;
      }
      if (Object.keys(modelConfig).length > 0) {
        normalized.modelConfig = modelConfig;
      }

      if (
        typeof action.approvalMode === 'string' &&
        APPROVAL_MODES.includes(action.approvalMode)
      ) {
        normalized.approvalMode = action.approvalMode;
      }

      if (typeof action['if-command'] === 'string') {
        const ifCommand = action['if-command'].trim();
        if (ifCommand.length > 0) {
          normalized['if-command'] = ifCommand;
        }
      }

      const normalizedPlugins = normalizeLenientHookPlugins(action.plugins);
      if (normalizedPlugins) {
        normalized.plugins = normalizedPlugins;
      }

      if (isChatTabPluginSelections(action.pluginSelections)) {
        const pluginSelections = normalizePluginSelections(
          action.pluginSelections,
        );
        if (
          pluginSelections.collectionIds.length > 0 ||
          pluginSelections.skillRefs.length > 0 ||
          pluginSelections.pluginRefs.length > 0 ||
          (pluginSelections.mcpServerRefs?.length ?? 0) > 0
        ) {
          normalized.pluginSelections = pluginSelections;
        }
      }

      // Only the literal `true` value is preserved. Absent and `false`
      // values are omitted from normalized JSON so unchecked UI saves do
      // not churn `canopy.json`.
      if (action.allowChatConcurrency === true) {
        normalized.allowChatConcurrency = true;
      }

      // Same normalization contract as `allowChatConcurrency`: only the literal
      // `true` survives so unchecked saves do not churn `canopy.json`.
      if (action.autoArchive === true) {
        normalized.autoArchive = true;
      }

      // Machine-local: the strict canopy.json parser omits these fields.
      if (typeof action.executionContext === 'string')
        normalized.executionContext = action.executionContext;
      if (action.localExecutionContextOverlay === true)
        normalized.localExecutionContextOverlay = true;

      return [normalized];
    }

    if (action.type === 'pipeline') {
      if (!isPipelineHookSource(action.source)) {
        return [];
      }

      if (typeof action.id !== 'string') {
        return [];
      }
      const id = action.id.trim();
      if (id.length === 0) {
        return [];
      }

      const normalized: PipelineHookAction = {
        type: 'pipeline',
        source: action.source,
        id,
      };

      // Machine-local: node/lib/canopy-json.ts writeCanopyJson validates via parseHookAction, which omits executionContext.
      if (typeof action.executionContext === 'string')
        normalized.executionContext = action.executionContext;
      if (action.localExecutionContextOverlay === true)
        normalized.localExecutionContextOverlay = true;
      const normalizedInputs = normalizePipelineHookInputs(action.inputs);
      if (normalizedInputs) {
        normalized.inputs = normalizedInputs;
      }

      const pipelineSpeed = readCodexSpeedRecord(
        action.modelConfig,
        action.codexFastMode,
      );
      if (pipelineSpeed === 'ultrafast') {
        // Pipeline hooks cannot run Ultra fast yet. Retain the exact request
        // so execution rejects it explicitly instead of dropping it or
        // silently running Fast/Regular.
        normalized.modelConfig = withCodexSpeed(undefined, pipelineSpeed);
      } else if (pipelineSpeed !== undefined) {
        normalized.modelConfig = {
          fastMode: codexSpeedFastMode(pipelineSpeed),
        };
      }

      // Only the literal `true` value is preserved; absent and `false`
      // values are omitted from normalized JSON so unchecked UI saves do
      // not churn `canopy.json`.
      if (action.allowPipelineConcurrency === true) {
        normalized.allowPipelineConcurrency = true;
      }

      return [normalized];
    }

    return [];
  });
  return valid.length > 0 ? valid : undefined;
}

/**
 * Pipeline hooks keep boolean Fast mode authoring and cannot run Ultra fast.
 * Returns a user-facing rejection when a (shared or persisted) pipeline hook
 * requests Ultra fast; callers must reject before any pipeline side effect
 * rather than dropping the request or running at another speed.
 */
export function pipelineHookUnsupportedSpeedError(
  action: Pick<PipelineHookAction, 'modelConfig' | 'codexFastMode'>,
): string | undefined {
  return readCodexSpeedRecord(action.modelConfig, action.codexFastMode) ===
    'ultrafast'
    ? 'Workflow hooks do not support Ultra fast. Choose Regular or Fast.'
    : undefined;
}

/**
 * Produces the stable local-overlay identity for a chat hook action. Prompts
 * are source-controlled action identities; duplicate prompts are handled
 * fail-closed by the resolver rather than applying a selection ambiguously.
 */
export function getChatHookActionOverlayKey(action: ChatHookAction): string {
  return `chat:${action.prompt.trim()}`;
}

const PIPELINE_HOOK_SOURCES: readonly PipelineHookSource[] = [
  'bundled',
  'local',
  'project',
  'curated',
];

function isPipelineHookSource(value: unknown): value is PipelineHookSource {
  return (
    typeof value === 'string' &&
    PIPELINE_HOOK_SOURCES.some((source) => source === value)
  );
}

/**
 * Normalize pipeline hook inputs:
 *   - trims keys
 *   - drops empty keys
 *   - keeps only string values (drops anything else)
 *   - sorts keys alphabetically
 *
 * Returns `undefined` when the result has no entries so the caller can
 * omit the `inputs` field entirely.
 */
function normalizePipelineHookInputs(
  value: unknown,
): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries: Array<[string, string]> = [];
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (typeof rawKey !== 'string') {
      continue;
    }
    const key = rawKey.trim();
    if (key.length === 0) {
      continue;
    }
    if (typeof rawValue !== 'string') {
      continue;
    }
    entries.push([key, rawValue]);
  }

  if (entries.length === 0) {
    return undefined;
  }

  entries.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return Object.fromEntries(entries);
}

/**
 * Normalize a hook input map: trim keys, validate values, sort by trigger order.
 */
export function normalizeHookInputMap(
  hooks: HookInputMap | HookOverrides | undefined,
): HookOverrides | undefined {
  if (!hooks) {
    return undefined;
  }

  const normalizedEntries: Array<[string, HookValue]> = [];
  for (const [rawName, rawValue] of Object.entries(hooks)) {
    const triggerName = normalizeTriggerName(rawName);
    if (!triggerName) {
      continue;
    }
    const hookValue = normalizeHookValue(rawValue);
    if (hookValue === undefined) {
      continue;
    }
    normalizedEntries.push([triggerName, hookValue]);
  }

  normalizedEntries.sort((left, right) => {
    return compareTriggerNames(left[0], right[0]);
  });

  if (normalizedEntries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(normalizedEntries);
}

// ---------------------------------------------------------------------------
// Key helpers — scope-based composite keys mirroring scripts
// ---------------------------------------------------------------------------

/**
 * Create a composite key identifying a hook at a specific scope.
 */
export function createHookKey(
  scope: HookScope,
  triggerName: string,
  repoId?: string,
): string {
  if (scope === 'workspace-root') {
    return `workspace-root:${triggerName}`;
  }

  if (scope === 'workspace-repo') {
    if (!repoId) {
      throw new Error('repoId is required for workspace-repo hook keys');
    }
    return `workspace-repo:${repoId}:${triggerName}`;
  }

  return `project:${triggerName}`;
}

/**
 * Parse a composite hook key back into its parts.
 * Returns null if the key format is invalid.
 */
export function parseHookKey(
  hookKey: string,
): { scope: HookScope; triggerName: string; repoId?: string } | null {
  if (hookKey.startsWith('project:')) {
    const triggerName = hookKey.slice('project:'.length);
    if (triggerName.length === 0) {
      return null;
    }
    return {
      scope: 'project',
      triggerName,
    };
  }

  if (hookKey.startsWith('workspace-root:')) {
    const triggerName = hookKey.slice('workspace-root:'.length);
    if (triggerName.length === 0) {
      return null;
    }
    return {
      scope: 'workspace-root',
      triggerName,
    };
  }

  if (hookKey.startsWith('workspace-repo:')) {
    const parsed = parseWorkspaceRepoScopedValue(hookKey, 'workspace-repo:');
    if (!parsed) {
      return null;
    }
    return {
      scope: 'workspace-repo',
      repoId: parsed.repoId,
      triggerName: parsed.scopedValue,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Runnable hooks
// ---------------------------------------------------------------------------

export interface RunnableHookEntry {
  triggerName: string;
  actions: HookAction[];
}

/**
 * List all runnable hooks from a HookOverrides map.
 * Returns entries sorted by trigger order.
 */
export function listRunnableHooks(
  hooks: HookOverrides | undefined,
): RunnableHookEntry[] {
  if (!hooks) {
    return [];
  }

  const entries: RunnableHookEntry[] = [];
  for (const [triggerName, hookValue] of Object.entries(hooks)) {
    if (!Array.isArray(hookValue) || hookValue.length === 0) {
      continue;
    }
    entries.push({
      triggerName,
      actions: hookValue,
    });
  }

  entries.sort((left, right) =>
    compareTriggerNames(left.triggerName, right.triggerName),
  );
  return entries;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Get a human-readable display label for a trigger name.
 */
export function getHookTriggerDisplayName(triggerName: string): string {
  if (isHookTriggerName(triggerName)) {
    return HOOK_TRIGGER_DISPLAY_LABELS[triggerName];
  }

  return titleCaseIdentifier(triggerName);
}

/**
 * Get a short description of a hook action for display.
 */
export function getHookActionLabel(action: HookAction): string {
  if (action.type === 'command') {
    return action.command;
  }

  if (action.type === 'pipeline') {
    return `Workflow: ${action.source}/${action.id}`;
  }

  const [firstLine = action.prompt] = action.prompt
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return action['if-command']
    ? `Chat: ${firstLine} [if-command]`
    : `Chat: ${firstLine}`;
}

/**
 * Get a safe log label for persisted hook run output.
 */
export function getHookActionLogLabel(action: HookAction): string {
  if (action.type === 'command') {
    return action.command;
  }

  if (action.type === 'pipeline') {
    return `Workflow action (${action.source}/${action.id})`;
  }

  const baseLabel = action.model
    ? `Chat action (${action.model})`
    : 'Chat action';
  return action['if-command'] ? `${baseLabel} [if-command]` : baseLabel;
}

export function createCommandHookEnvVarToken(name: string): string {
  return `$${name}`;
}

export function createPromptHookEnvVarToken(name: string): string {
  return `{{${name}}}`;
}

/**
 * Interpolate `{{CANOPY_...}}` style placeholders in a template string.
 *
 * Used by both chat-prompt interpolation (`interpolateHookPrompt`) and
 * pipeline-input interpolation for pipeline hook actions. Both share the
 * same set of supported variable names defined by
 * `SUPPORTED_HOOK_PROMPT_VAR_NAMES`. Unsupported placeholders are left
 * intact so authors can see typos rather than have them silently expand
 * to empty strings.
 */
export function interpolateHookTemplate(
  value: string,
  env: Record<string, string | undefined>,
): string {
  return value.replace(
    /\{\{\s*([A-Z0-9_]+)\s*\}\}/g,
    (match: string, variableName: string): string => {
      if (!SUPPORTED_HOOK_PROMPT_VAR_NAMES.has(variableName)) {
        return match;
      }

      return env[variableName] ?? '';
    },
  );
}

/**
 * Backwards-compatible alias for chat-prompt callers. New code should use
 * `interpolateHookTemplate` directly.
 */
export function interpolateHookPrompt(
  prompt: string,
  env: Record<string, string | undefined>,
): string {
  return interpolateHookTemplate(prompt, env);
}
