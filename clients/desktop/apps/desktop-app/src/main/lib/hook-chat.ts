import type { BrowserWindow } from 'electron';
import {
  buildShareablePluginDisplay,
  getExecutionHarnessForModel,
  requireProviderForModel,
  IPC_CHANNELS,
  isTerminalBackedInterfaceMode,
  resolveProviderModelConfig,
  type ResolvedAgentModelConfig,
  isInheritingAgentModel,
  resolveKnownModel,
  type AgentProviderType,
  type ApprovalMode,
  type CancelQueuedHookChatResponse,
  type ChatInterfaceMode,
  type ChatModel,
  type ModelHarness,
  type ChatTabPluginSelections,
  type ForceQueuedHookChatResponse,
  type FileReference,
  type ChatHookAction,
  type PersistedChatMessage,
  type PersistedChatTab,
  type PreferencesData,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import {
  codexSpeedFastMode,
  codexSpeedFromFastMode,
  readCodexSpeedRecord,
  type CodexSpeed,
} from '@canopy/desktop-shared/lib/codex-speed';
import type { ShareablePluginRef } from '@canopy/desktop-shared/plugin-refs';
import { resolvePipelineModelAlias } from '@canopy/desktop-shared/pipelines/normalize-pipeline';
import { readPreferencesFile } from '../lib/preferences-store';
import {
  readApprovalPreferencesForSurface,
  resolveApprovalMode,
  surfaceForChat,
} from './approval-mode-resolution';
import { readWorkspaceApprovals } from './approvals-persistence';
import { readWorkspaceApprovalsManifest } from './workspace-approvals-manifest';
import { resolveOptionalLaneAwareDefaultSelection } from '../lib/default-model-lane-resolver';
import {
  assertAgentRouteModel,
  formatInheritedAgentRoute,
} from '../agents/agent-default-model';
import { getEffectiveClaudeChatModePreferences } from './claude-tui-chats';
import { mergePluginSelections } from '../lib/plugin-selection-utils';
import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import { newChatPluginDefaultsStamp } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { sendToWindow } from './window-send';
import { dispatchWorktreeChatTurn } from './worktree-chat-turn';
import { runAdmittedDirectDispatch } from '../services/chat-queue-service';
import { getChatStateService } from '../services/chat-state-service';
import {
  hasActiveChatTurnsForWorktree,
  subscribeChatSessionActivity,
} from '../agents/session-manager';
import {
  loadShareablePluginCatalog,
  resolveShareablePluginRefs,
} from '../plugins/shareable-plugin-resolution';
import {
  commitProviderChatEvent,
  completePersistedChatTabTurn,
  emitChatDispatchFailure,
  removePersistedChatTab,
  upsertPersistedChatTab,
} from './chat-tab-dispatch-utils';
import { getClaudeTerminalSessionService } from '../integration/claude-terminal-session-service';
import { notifyCanonicalChatStarted } from '../services/active-chat-input';
import { resolveConfiguredPrompt } from './configured-prompt-resolution';
import { buildSubmittedMessageText } from './chat-submitted-message';
import { resolveWorktreeCwd } from './resolve-worktree';

let generatedIdCounter = 0;
const hookChatStartInProgressTargetKeys = new Set<string>();
const QUEUED_PROMPT_PREVIEW_MAX_LENGTH = 400;

interface PreparedHookChatLaunch {
  projectId: string;
  worktreeId: string;
  prompt: string;
  executionContext?: string;
  fileReferences?: FileReference[];
  triggerName: string;
  /**
   * When the hook fired. Shown by the "Chat initiated by … hook" banner on
   * both the queued placeholder and the started chat, so a queued launch does
   * not move the banner's time when it finally starts.
   */
  triggeredAt: number;
  getWindow: () => BrowserWindow | null;
  model: ChatModel;
  providerType: AgentProviderType;
  executionHarness: ModelHarness;
  modelConfig: ResolvedAgentModelConfig;
  /**
   * Requested Codex speed kept independently of the resolved config, so a
   * queued Codex → other provider → Codex model change restores it instead of
   * the provider default. Never an execution input for non-Codex harnesses.
   */
  retainedCodexSpeed?: CodexSpeed;
  thinkingLevel: ThinkingLevel;
  planMode: boolean;
  approvalMode?: ApprovalMode;
  /**
   * Persisted `defaultChatInterfaceMode` preference snapshot applied to the
   * hook-chat tab when the resolved model is Claude. `undefined` for Codex
   * and Ollama models — the managed Claude Code terminal experience is
   * Claude-specific.
   */
  interfaceMode?: ChatInterfaceMode;
  pluginSelections?: ChatTabPluginSelections;
  deferredToolsAllowed?: boolean;
  missingPluginDisplays: string[];
  chatId: string;
  userMessageId: string;
  /**
   * For multi-repo workspaces: the child repo whose checkout should be the
   * agent's cwd. Set when the hook fired on `target: 'workspace-repo'`.
   * Workspace-root and single-repo hooks leave this undefined.
   */
  selectedRepoId?: string;
  /**
   * Mirrors `ChatHookAction.autoArchive`. When `true`, the launched chat tab
   * carries the auto-archive marker so the renderer archives it once its turn
   * finishes.
   */
  autoArchive?: boolean;
}

interface QueuedHookChatEntry {
  queueId: string;
  prepared: PreparedHookChatLaunch;
  cancelled: boolean;
  startExposed: boolean;
  latestModelUpdateSequence: number;
  pendingModelUpdateCount: number;
  startCompletion?: Promise<void>;
}

const queuedHookChats: QueuedHookChatEntry[] = [];
const startingQueuedHookChats = new Map<string, QueuedHookChatEntry>();

function isQueuedHookChatCancelled(
  entry: QueuedHookChatEntry | undefined,
): boolean {
  return entry?.cancelled === true;
}

function nextGeneratedId(prefix: string): string {
  generatedIdCounter += 1;
  return `${prefix}-hook-${Date.now()}-${generatedIdCounter}`;
}

function buildInitialTitle(prompt: string): string {
  return prompt.slice(0, 40) + (prompt.length > 40 ? '...' : '');
}

function buildQueuedPromptPreview(prompt: string): string {
  const normalizedPrompt = prompt.trim();
  return (
    normalizedPrompt.slice(0, QUEUED_PROMPT_PREVIEW_MAX_LENGTH) +
    (normalizedPrompt.length > QUEUED_PROMPT_PREVIEW_MAX_LENGTH ? '...' : '')
  );
}

/**
 * The hook chat's own selections. Project defaults are not copied in; the
 * chat inherits them live at each turn.
 */
async function resolveHookChatPluginSelections(
  providerType: AgentProviderType,
  plugins: ShareablePluginRef[] | undefined,
  directSelections: ChatTabPluginSelections | undefined,
): Promise<{
  selections: ChatTabPluginSelections | undefined;
  missingDisplays: string[];
}> {
  const baseSelections = directSelections
    ? mergePluginSelections(
        undefined,
        normalizePluginSelections(directSelections),
      )
    : undefined;
  if (!plugins || plugins.length === 0) {
    return {
      selections: baseSelections,
      missingDisplays: [],
    };
  }

  const catalog = await loadShareablePluginCatalog();
  const matches = resolveShareablePluginRefs(plugins, catalog, {
    providerType,
  });
  const extraSelections: ChatTabPluginSelections = {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
    mcpHttpAuthPreferences: [],
  };
  const missingDisplays: string[] = [];

  for (const match of matches) {
    if (match.matchState !== 'matched') {
      missingDisplays.push(buildShareablePluginDisplay(match.ref).title);
      continue;
    }
    if (match.selection.kind === 'skill') {
      extraSelections.skillRefs.push({
        sourceId: match.selection.sourceId,
        skillName: match.selection.skillName,
      });
      continue;
    }
    extraSelections.pluginRefs.push({
      marketplaceId: match.selection.marketplaceId,
      pluginName: match.selection.pluginName,
    });
  }

  return {
    selections: mergePluginSelections(baseSelections, extraSelections),
    missingDisplays,
  };
}

function buildInitialMessages(
  prompt: string,
  userMessageId: string,
  triggerName: string,
  triggeredAt: number,
  missingPluginDisplays: string[],
  fileReferences?: FileReference[],
): PersistedChatMessage[] {
  const timestamp = Date.now();
  const unavailableText =
    missingPluginDisplays.length === 1
      ? `Hook plugin unavailable and was not enabled: ${missingPluginDisplays[0]}.`
      : missingPluginDisplays.length > 1
        ? `Some hook plugins were unavailable and were not enabled: ${missingPluginDisplays.join(', ')}.`
        : undefined;
  return [
    {
      id: nextGeneratedId('msg'),
      role: 'system',
      blocks: [{ type: 'hook_info', triggerName, timestamp: triggeredAt }],
      timestamp: triggeredAt,
    },
    ...(unavailableText
      ? [
          {
            id: nextGeneratedId('msg'),
            role: 'system' as const,
            blocks: [{ type: 'text' as const, text: unavailableText }],
            timestamp,
          },
        ]
      : []),
    {
      id: userMessageId,
      role: 'user',
      userMessageSource: 'hook',
      blocks: [
        ...(fileReferences?.length
          ? [{ type: 'file_references' as const, references: fileReferences }]
          : []),
        { type: 'text', text: prompt },
      ],
      timestamp,
    },
  ];
}

function buildHookChatTab(args: {
  projectId: string;
  chatId: string;
  prompt: string;
  executionContext?: string;
  fileReferences?: FileReference[];
  model: ChatModel;
  providerType: AgentProviderType;
  executionHarness: ModelHarness;
  thinkingLevel: ThinkingLevel;
  modelConfig: ResolvedAgentModelConfig;
  planMode: boolean;
  approvalMode?: ApprovalMode;
  interfaceMode?: ChatInterfaceMode;
  pluginSelections?: ChatTabPluginSelections;
  deferredToolsAllowed?: boolean;
  missingPluginDisplays: string[];
  userMessageId: string;
  triggerName: string;
  triggeredAt: number;
  selectedRepoId?: string;
  newChatStartedWatcherFiredAt?: string;
  autoArchive?: boolean;
}): PersistedChatTab {
  return {
    ...(args.executionContext === undefined
      ? {}
      : { executionContext: args.executionContext }),
    id: args.chatId,
    title: buildInitialTitle(args.prompt),
    messages: buildInitialMessages(
      args.prompt,
      args.userMessageId,
      args.triggerName,
      args.triggeredAt,
      args.missingPluginDisplays,
      args.fileReferences,
    ),
    createdAt: new Date().toISOString(),
    ...(args.newChatStartedWatcherFiredAt
      ? { newChatStartedWatcherFiredAt: args.newChatStartedWatcherFiredAt }
      : {}),
    thinkingLevel: args.thinkingLevel,
    modelConfig: args.modelConfig,
    model: args.model,
    providerType: args.providerType,
    executionHarness: args.executionHarness,
    ...(args.planMode ? { planMode: true } : {}),
    ...(args.approvalMode ? { approvalMode: args.approvalMode } : {}),
    ...(args.interfaceMode ? { interfaceMode: args.interfaceMode } : {}),
    ...(args.pluginSelections
      ? { pluginSelections: args.pluginSelections }
      : {}),
    ...newChatPluginDefaultsStamp(args.projectId),
    ...(typeof args.deferredToolsAllowed === 'boolean'
      ? { deferredToolsAllowed: args.deferredToolsAllowed }
      : {}),
    ...(args.selectedRepoId ? { selectedRepoId: args.selectedRepoId } : {}),
    ...(args.autoArchive === true ? { autoArchive: true } : {}),
  };
}

function buildQueuedHookChatTab(
  prepared: PreparedHookChatLaunch,
): PersistedChatTab {
  return {
    ...(prepared.executionContext === undefined
      ? {}
      : { executionContext: prepared.executionContext }),
    id: prepared.chatId,
    title: buildInitialTitle(prepared.prompt),
    messages: [],
    createdAt: new Date().toISOString(),
    thinkingLevel: prepared.thinkingLevel,
    modelConfig: prepared.modelConfig,
    model: prepared.model,
    providerType: prepared.providerType,
    executionHarness: prepared.executionHarness,
    ...(prepared.planMode ? { planMode: true } : {}),
    ...(prepared.approvalMode ? { approvalMode: prepared.approvalMode } : {}),
    ...(prepared.interfaceMode
      ? { interfaceMode: prepared.interfaceMode }
      : {}),
    ...(prepared.pluginSelections
      ? { pluginSelections: prepared.pluginSelections }
      : {}),
    ...newChatPluginDefaultsStamp(prepared.projectId),
    ...(typeof prepared.deferredToolsAllowed === 'boolean'
      ? { deferredToolsAllowed: prepared.deferredToolsAllowed }
      : {}),
    ...(prepared.selectedRepoId
      ? { selectedRepoId: prepared.selectedRepoId }
      : {}),
    ...(prepared.autoArchive === true ? { autoArchive: true } : {}),
  };
}

function findQueuedHookChatEntry(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): QueuedHookChatEntry | undefined {
  return queuedHookChats.find(
    (entry) =>
      entry.cancelled !== true &&
      entry.prepared.projectId === args.projectId &&
      entry.prepared.worktreeId === args.worktreeId &&
      entry.prepared.chatId === args.chatId,
  );
}

export function hasQueuedHookChat(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): boolean {
  return findQueuedHookChatEntry(args) !== undefined;
}

function getHookChatTargetKey(prepared: PreparedHookChatLaunch): string {
  return `${prepared.projectId}/${prepared.worktreeId}`;
}

function isHookChatStartInProgressForTarget(
  prepared: PreparedHookChatLaunch,
): boolean {
  return hookChatStartInProgressTargetKeys.has(getHookChatTargetKey(prepared));
}

function hasQueuedHookChatForTarget(prepared: PreparedHookChatLaunch): boolean {
  const targetKey = getHookChatTargetKey(prepared);
  return queuedHookChats.some(
    (entry) =>
      entry.cancelled !== true &&
      getHookChatTargetKey(entry.prepared) === targetKey,
  );
}

function resolveWorktreeProviderDefaultThinkingLevel(
  prefs: PreferencesData,
  providerType: AgentProviderType,
  fallback: ThinkingLevel,
): ThinkingLevel {
  const providerDefault = prefs.defaultWorktreeModelByProvider[providerType];
  return providerDefault?.thinkingLevel ?? fallback;
}

/** A non-Codex hook launch still retains the hook's explicit Codex speed. */
function readRetainedHookCodexSpeed(
  action: Pick<ChatHookAction, 'modelConfig' | 'codexFastMode'>,
): { retainedCodexSpeed?: CodexSpeed } {
  const speed = readCodexSpeedRecord(action.modelConfig, action.codexFastMode);
  return speed === undefined ? {} : { retainedCodexSpeed: speed };
}

async function persistHookChatTab(args: {
  projectId: string;
  worktreeId: string;
  tab: PersistedChatTab;
  activateTab: boolean;
}): Promise<void> {
  await upsertPersistedChatTab(args);
}

async function rollbackHookChatTab(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): Promise<void> {
  await removePersistedChatTab(args);
}

async function markHookChatDispatchFailed(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  errorMessage: string;
  getWindow: () => BrowserWindow | null;
}): Promise<void> {
  await completePersistedChatTabTurn(args);
  await emitChatDispatchFailure(args);
}

async function prepareHookChatLaunch(args: {
  projectId: string;
  worktreeId: string;
  action: ChatHookAction;
  prompt: string;
  interpolateText?: (text: string) => string;
  triggerName: string;
  getWindow: () => BrowserWindow | null;
  selectedRepoId?: string;
}): Promise<PreparedHookChatLaunch> {
  const triggeredAt = Date.now();
  const approvalSurface = surfaceForChat(args.projectId);
  const [approvalPreferences, workspaceApprovals, manifestApprovals] =
    await Promise.all([
      readApprovalPreferencesForSurface(approvalSurface),
      readWorkspaceApprovals(args.projectId),
      readWorkspaceApprovalsManifest(args.projectId),
    ]);
  const prefs = approvalPreferences.preferences;
  // Skipped ENTIRELY when the hook names its own model.
  //
  // Deferring only the throw was not enough: lane resolution awaits both native
  // auth probes, the AI Credits lookup, and policy evaluation. On a cold cache
  // the Claude probe alone can take ~20s and the Codex probe can spin up an
  // app-server process — all for a default this hook is never going to use. So
  // the branch happens BEFORE the await, not after it.
  // Hook actions share the pipeline model alias vocabulary ($default-codex,
  // $fast, $cheap) so shareable canopy.json hooks roll model upgrades in one
  // place. Resolve the alias before the known-model lookup; an unknown $-alias
  // throws its own descriptive error here.
  const rawExplicitModel = args.action.model?.trim();
  const explicitModel = rawExplicitModel
    ? resolvePipelineModelAlias(rawExplicitModel)
    : undefined;
  if (explicitModel) assertAgentRouteModel(explicitModel);
  const inheritingAgent =
    explicitModel && isInheritingAgentModel(explicitModel)
      ? explicitModel
      : undefined;
  const worktreeDefault =
    explicitModel && !inheritingAgent
      ? undefined
      : await resolveOptionalLaneAwareDefaultSelection(prefs, 'worktree', {
          // Parity with the spawn: this launch dispatches a worktree chat turn
          // for `args.projectId`, so a Canopy Environments credential assigned to
          // that workspace must be visible to the selection too.
          workspaceId: args.projectId,
        });
  const defaultModel = worktreeDefault?.requireModel().model;
  // The hook chat keeps the route an inheriting Agent resolved here.
  const requestedModel = inheritingAgent
    ? defaultModel && formatInheritedAgentRoute(inheritingAgent, defaultModel)
    : explicitModel || defaultModel;
  if (!requestedModel) {
    throw new Error('No dispatchable model is available (billing-lane).');
  }
  const model = resolveKnownModel(requestedModel);
  if (!model) {
    throw new Error(`Unsupported hook chat model "${requestedModel}"`);
  }

  const providerType = requireProviderForModel(model);
  const executionHarness = getExecutionHarnessForModel(model);
  if (!executionHarness) {
    throw new Error(
      `No execution harness is available for hook chat model "${model}"`,
    );
  }
  const modelConfig = resolveProviderModelConfig(
    executionHarness,
    {
      // Keyed on the NAMED model's provider, never the surface's preferred
      // one. Borrowing the preferred provider's level for a differently-
      // provided model overrides that provider's own configuration; dropping
      // the fallback altogether loses the level the user deliberately set for
      // the same provider (a `low` Claude default silently became `high`).
      thinkingLevel:
        args.action.thinking ??
        worktreeDefault?.selection?.thinkingLevel ??
        prefs.defaultWorktreeModelByProvider[providerType]?.thinkingLevel,
      modelConfig: args.action.modelConfig,
    },
    prefs.providerModelConfigDefaults,
  );
  const thinkingLevel = modelConfig.thinkingLevel;
  const chatId = nextGeneratedId('chat');
  const userMessageId = nextGeneratedId('msg');
  const { selections: pluginSelections, missingDisplays } =
    await resolveHookChatPluginSelections(
      executionHarness,
      args.action.plugins,
      args.action.pluginSelections,
    );
  // Hook chats running on Claude inherit the user's persisted default chat
  // interface mode so a hook that fires on a Claude model lands in whichever
  // surface (Canopy transcript or managed Claude Code terminal) the user has
  // chosen for new Claude chats. Codex and Ollama hooks ignore this — the
  // terminal experience is Claude-specific.
  const effectivePrefs = getEffectiveClaudeChatModePreferences(prefs);
  const interfaceMode =
    providerType === 'claude' &&
    effectivePrefs.defaultChatInterfaceMode !== 'canopy'
      ? effectivePrefs.defaultChatInterfaceMode
      : undefined;
  const approvalMode = resolveApprovalMode({
    hookMode: args.action.approvalMode,
    workspaceDefault: workspaceApprovals.defaultMode,
    canopyJsonDefault: manifestApprovals.defaultMode,
    surface: approvalSurface,
    defaults: approvalPreferences.defaults,
  });
  const resolvedPrompt = await resolveConfiguredPrompt({
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    providerType,
    executionHarness,
    selectedRepoId: args.selectedRepoId,
    prompt: args.prompt,
    promptReferences: args.action.promptReferences,
    interpolateText: args.interpolateText,
  });

  return {
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    prompt: resolvedPrompt.prompt,
    executionContext: args.action.executionContext ?? 'personal',
    fileReferences: resolvedPrompt.fileReferences,
    triggerName: args.triggerName,
    triggeredAt,
    getWindow: args.getWindow,
    model,
    providerType,
    executionHarness,
    modelConfig,
    ...(executionHarness === 'codex'
      ? { retainedCodexSpeed: modelConfig.speed }
      : readRetainedHookCodexSpeed(args.action)),
    thinkingLevel,
    planMode: args.action.planMode === true,
    approvalMode,
    pluginSelections: resolvedPrompt.referencedPluginSelections
      ? mergePluginSelections(
          pluginSelections,
          resolvedPrompt.referencedPluginSelections,
        )
      : pluginSelections,
    missingPluginDisplays: missingDisplays,
    chatId,
    userMessageId,
    ...(interfaceMode ? { interfaceMode } : {}),
    ...(args.selectedRepoId ? { selectedRepoId: args.selectedRepoId } : {}),
    ...(args.action.autoArchive === true ? { autoArchive: true } : {}),
  };
}

async function startPreparedHookChatWithScopeLease(
  prepared: PreparedHookChatLaunch,
  options: {
    activateTab: boolean;
    queuedEntry?: QueuedHookChatEntry;
  },
): Promise<void> {
  const newChatStartedAt = new Date().toISOString();
  const tab = buildHookChatTab({
    projectId: prepared.projectId,
    chatId: prepared.chatId,
    prompt: prepared.prompt,
    executionContext: prepared.executionContext,
    fileReferences: prepared.fileReferences,
    model: prepared.model,
    providerType: prepared.providerType,
    executionHarness: prepared.executionHarness,
    modelConfig: prepared.modelConfig,
    thinkingLevel: prepared.thinkingLevel,
    planMode: prepared.planMode,
    approvalMode: prepared.approvalMode,
    ...(prepared.interfaceMode
      ? { interfaceMode: prepared.interfaceMode }
      : {}),
    pluginSelections: prepared.pluginSelections,
    deferredToolsAllowed: prepared.deferredToolsAllowed,
    missingPluginDisplays: prepared.missingPluginDisplays,
    userMessageId: prepared.userMessageId,
    triggerName: prepared.triggerName,
    triggeredAt: prepared.triggeredAt,
    newChatStartedWatcherFiredAt: newChatStartedAt,
    ...(prepared.selectedRepoId
      ? { selectedRepoId: prepared.selectedRepoId }
      : {}),
    ...(prepared.autoArchive === true ? { autoArchive: true } : {}),
  });

  if (isQueuedHookChatCancelled(options.queuedEntry)) return;

  // Ordinary admission precedes the prompt's first effect (contracts §6).
  await runAdmittedDirectDispatch(
    {
      projectId: prepared.projectId,
      worktreeId: prepared.worktreeId,
      chatId: prepared.chatId,
    },
    prepared.userMessageId,
    async (authorization): Promise<boolean> => {
      await persistHookChatTab({
        projectId: prepared.projectId,
        worktreeId: prepared.worktreeId,
        tab,
        activateTab: options.activateTab,
      });

      if (isQueuedHookChatCancelled(options.queuedEntry)) {
        await rollbackHookChatTab({
          projectId: prepared.projectId,
          worktreeId: prepared.worktreeId,
          chatId: prepared.chatId,
        });
        return false;
      }
      // No await may appear between exposing the real tab and marking this flag:
      // cancelQueuedHookChat uses it as the atomic boundary between "still safe to
      // cancel the queued launch" and "the normal active-chat lifecycle owns it".
      if (options.queuedEntry) options.queuedEntry.startExposed = true;

      const startedDelivered = sendToWindow(
        prepared.getWindow(),
        IPC_CHANNELS.chatHookTabStarted,
        {
          projectId: prepared.projectId,
          worktreeId: prepared.worktreeId,
          chatId: prepared.chatId,
          tab,
          activateTab: options.activateTab,
        },
      );
      if (!startedDelivered) {
        await rollbackHookChatTab({
          projectId: prepared.projectId,
          worktreeId: prepared.worktreeId,
          chatId: prepared.chatId,
        });
        throw new Error(
          'Hook chat requires an active renderer window before it can start.',
        );
      }

      await notifyCanonicalChatStarted(
        prepared,
        prepared.userMessageId,
        newChatStartedAt,
      ).catch(() => undefined);

      try {
        if (
          prepared.providerType === 'claude' &&
          isTerminalBackedInterfaceMode(prepared.interfaceMode)
        ) {
          await getClaudeTerminalSessionService().launch(
            {
              projectId: prepared.projectId,
              worktreeId: prepared.worktreeId,
              chatId: prepared.chatId,
              initialPrompt: buildSubmittedMessageText({
                text: prepared.prompt,
                fileReferences: prepared.fileReferences,
                cwd: resolveWorktreeCwd(
                  prepared.projectId,
                  prepared.worktreeId,
                  prepared.selectedRepoId,
                ),
              }),
              interfaceMode: prepared.interfaceMode,
              cols: 80,
              rows: 24,
              ...(prepared.selectedRepoId
                ? { selectedRepoId: prepared.selectedRepoId }
                : {}),
            },
            {
              getWindow: prepared.getWindow,
              executionContext: prepared.executionContext,
            },
          );
          return false;
        }

        await dispatchWorktreeChatTurn({
          ...(authorization ? { authorization } : {}),
          projectId: prepared.projectId,
          worktreeId: prepared.worktreeId,
          chatId: prepared.chatId,
          userMessageId: prepared.userMessageId,
          text: prepared.prompt,
          ...(prepared.executionContext === undefined
            ? {}
            : { executionContext: prepared.executionContext }),
          fileReferences: prepared.fileReferences,
          planMode: prepared.planMode,
          approvalMode: prepared.approvalMode,
          modelConfig: prepared.modelConfig,
          thinkingLevel: prepared.thinkingLevel,
          model: prepared.model,
          providerType: prepared.providerType,
          executionHarness: prepared.executionHarness,
          pluginSelections: prepared.pluginSelections,
          deferredToolsAllowed: prepared.deferredToolsAllowed,
          ...(prepared.selectedRepoId
            ? { selectedRepoId: prepared.selectedRepoId }
            : {}),
          initiationSource: 'hook',
          getWindow: prepared.getWindow,
          skipBranchNaming: true,
          onBeforeChatEvent: (event) =>
            commitProviderChatEvent({
              projectId: prepared.projectId,
              worktreeId: prepared.worktreeId,
              chatId: prepared.chatId,
              userMessageId: prepared.userMessageId,
              providerType: prepared.providerType,
              event,
            }),
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        await markHookChatDispatchFailed({
          projectId: prepared.projectId,
          worktreeId: prepared.worktreeId,
          chatId: prepared.chatId,
          errorMessage,
          getWindow: prepared.getWindow,
        });
        throw error;
      }
      return true;
    },
  );
}

async function startPreparedHookChat(
  prepared: PreparedHookChatLaunch,
  options: {
    activateTab: boolean;
    queuedEntry?: QueuedHookChatEntry;
  },
): Promise<void> {
  return getChatStateService().runWithScopeActivity(
    {
      projectId: prepared.projectId,
      worktreeId: prepared.worktreeId,
    },
    () => startPreparedHookChatWithScopeLease(prepared, options),
  );
}

function queuePreparedHookChat(prepared: PreparedHookChatLaunch): void {
  const queueId = nextGeneratedId('queued');
  const startedDelivered = sendToWindow(
    prepared.getWindow(),
    IPC_CHANNELS.chatHookTabStarted,
    {
      projectId: prepared.projectId,
      worktreeId: prepared.worktreeId,
      chatId: prepared.chatId,
      tab: buildQueuedHookChatTab(prepared),
      activateTab: false,
      queuedMessage: {
        queueId,
        text: buildQueuedPromptPreview(prepared.prompt),
        reason: 'Waiting for active chat sessions to finish.',
        hookInfo: {
          triggerName: prepared.triggerName,
          timestamp: prepared.triggeredAt,
        },
      },
    },
  );
  if (!startedDelivered) {
    throw new Error(
      'Hook chat requires an active renderer window before it can start.',
    );
  }

  queuedHookChats.push({
    queueId,
    prepared,
    cancelled: false,
    startExposed: false,
    latestModelUpdateSequence: 0,
    pendingModelUpdateCount: 0,
  });
  scheduleDrain();
}

function scheduleDrain(): void {
  while (queuedHookChats[0]?.cancelled === true) {
    queuedHookChats.shift();
  }

  const blockedTargetKeys = new Set<string>();
  let nextEntry: QueuedHookChatEntry | undefined;
  let nextEntryIndex = -1;
  for (let index = 0; index < queuedHookChats.length; index += 1) {
    const entry = queuedHookChats[index];
    if (!entry || entry.cancelled === true) {
      continue;
    }

    const targetKey = getHookChatTargetKey(entry.prepared);
    if (blockedTargetKeys.has(targetKey)) {
      continue;
    }

    if (
      hookChatStartInProgressTargetKeys.has(targetKey) ||
      entry.pendingModelUpdateCount > 0 ||
      hasActiveChatTurnsForWorktree(
        entry.prepared.projectId,
        entry.prepared.worktreeId,
      )
    ) {
      blockedTargetKeys.add(targetKey);
      continue;
    }

    nextEntry = entry;
    nextEntryIndex = index;
    break;
  }

  if (!nextEntry || nextEntryIndex < 0) {
    return;
  }

  queuedHookChats.splice(nextEntryIndex, 1);

  hookChatStartInProgressTargetKeys.add(
    getHookChatTargetKey(nextEntry.prepared),
  );
  startingQueuedHookChats.set(nextEntry.queueId, nextEntry);
  const start = startPreparedHookChat(nextEntry.prepared, {
    activateTab: false,
    queuedEntry: nextEntry,
  });
  nextEntry.startCompletion = start;
  void start
    .catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[hook-chat] Failed to start queued hook chat:', error);
    })
    .finally(() => {
      // A cancelled start can fail while removing its persisted tab. Keep the
      // entry until cancellation confirms cleanup so the close can be retried.
      if (!nextEntry.cancelled) {
        startingQueuedHookChats.delete(nextEntry.queueId);
      }
      hookChatStartInProgressTargetKeys.delete(
        getHookChatTargetKey(nextEntry.prepared),
      );
      scheduleDrain();
    });
}

subscribeChatSessionActivity(scheduleDrain);

export async function cancelQueuedHookChat(
  queueId: string,
): Promise<CancelQueuedHookChatResponse> {
  const entryIndex = queuedHookChats.findIndex(
    (entry) => entry.queueId === queueId,
  );
  if (entryIndex < 0) {
    const startingEntry = startingQueuedHookChats.get(queueId);
    if (!startingEntry || startingEntry.startExposed) {
      return { cancelled: false };
    }
    startingEntry.cancelled = true;
    // A queued start may already have written its real tab. Acknowledge the
    // close only after that start observes cancellation and removes the tab;
    // otherwise a late canonical upsert can restore the closed tab.
    try {
      await startingEntry.startCompletion;
    } catch {
      // The start may fail after writing its tab, or while rolling that tab
      // back. Removal is idempotent and must finish before close is confirmed.
      // If removal also fails, retain the entry so another close can retry.
      await rollbackHookChatTab({
        projectId: startingEntry.prepared.projectId,
        worktreeId: startingEntry.prepared.worktreeId,
        chatId: startingEntry.prepared.chatId,
      });
    }
    startingQueuedHookChats.delete(queueId);
    return { cancelled: true };
  }

  const entry = queuedHookChats[entryIndex];
  if (!entry) {
    return { cancelled: false };
  }

  entry.cancelled = true;
  queuedHookChats.splice(entryIndex, 1);
  scheduleDrain();
  return { cancelled: true };
}

export async function forceQueuedHookChat(
  queueId: string,
): Promise<ForceQueuedHookChatResponse> {
  const entryIndex = queuedHookChats.findIndex(
    (entry) => entry.queueId === queueId,
  );
  if (entryIndex < 0) {
    return { forced: false };
  }

  const entry = queuedHookChats[entryIndex];
  if (!entry || entry.cancelled === true) {
    return { forced: false };
  }

  const targetKey = getHookChatTargetKey(entry.prepared);
  if (hookChatStartInProgressTargetKeys.has(targetKey)) {
    return { forced: false };
  }

  queuedHookChats.splice(entryIndex, 1);
  hookChatStartInProgressTargetKeys.add(targetKey);
  startingQueuedHookChats.set(entry.queueId, entry);
  try {
    const start = startPreparedHookChat(entry.prepared, {
      activateTab: false,
      queuedEntry: entry,
    });
    entry.startCompletion = start;
    await start;
    return { forced: entry.startExposed };
  } finally {
    if (!entry.cancelled) {
      startingQueuedHookChats.delete(entry.queueId);
    }
    hookChatStartInProgressTargetKeys.delete(targetKey);
    scheduleDrain();
  }
}

export function updateQueuedHookChatPlanMode(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  enabled: boolean;
}): void {
  const entry = findQueuedHookChatEntry(args);
  if (!entry) {
    return;
  }

  entry.prepared.planMode = args.enabled;
}

export function updateQueuedHookChatApprovalMode(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  mode: ApprovalMode;
}): void {
  const entry = findQueuedHookChatEntry(args);
  if (!entry) {
    return;
  }

  entry.prepared.approvalMode = args.mode;
}

export function updateQueuedHookChatThinkingLevel(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  level: ThinkingLevel;
}): void {
  const entry = findQueuedHookChatEntry(args);
  if (!entry) {
    return;
  }

  entry.prepared.thinkingLevel = args.level;
  entry.prepared.modelConfig = {
    ...entry.prepared.modelConfig,
    thinkingLevel: args.level,
  };
}

/**
 * Applies an interface-mode switch made on a queued hook chat's placeholder.
 * The queued launch decides between the managed Claude Code terminal and a
 * Canopy turn when it starts, and the started tab carries the same mode.
 */
export function updateQueuedHookChatInterfaceMode(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  interfaceMode: ChatInterfaceMode;
}): boolean {
  const entry = findQueuedHookChatEntry(args);
  if (!entry || entry.prepared.providerType !== 'claude') {
    return false;
  }

  entry.prepared.interfaceMode =
    args.interfaceMode === 'canopy' ? undefined : args.interfaceMode;
  return true;
}

/**
 * Applies a speed command made on a queued hook chat's placeholder. An exact
 * `speed` is authoritative; otherwise the legacy boolean command replaces the
 * speed (true → Fast, false → Regular, including `false` on Ultra fast).
 */
export function updateQueuedHookChatCodexFastMode(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  enabled: boolean;
  speed?: CodexSpeed;
}): void {
  const entry = findQueuedHookChatEntry(args);
  if (!entry) {
    return;
  }

  const speed = args.speed ?? codexSpeedFromFastMode(args.enabled);
  entry.prepared.retainedCodexSpeed = speed;
  if (entry.prepared.executionHarness !== 'codex') {
    // Non-Codex execution never requests a Codex speed; keep only the
    // retained request for a later switch back to Codex.
    return;
  }
  entry.prepared.modelConfig = {
    ...entry.prepared.modelConfig,
    speed,
    fastMode: codexSpeedFastMode(speed),
  };
}

export async function updateQueuedHookChatModel(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  model: ChatModel;
}): Promise<void> {
  const queuedEntry = findQueuedHookChatEntry(args);
  if (!queuedEntry) {
    return;
  }

  queuedEntry.pendingModelUpdateCount += 1;
  try {
    const requestSequence = queuedEntry.latestModelUpdateSequence + 1;
    queuedEntry.latestModelUpdateSequence = requestSequence;
    const nextProviderType = requireProviderForModel(args.model);
    const nextExecutionHarness = getExecutionHarnessForModel(args.model);
    if (!nextExecutionHarness) {
      throw new Error(
        `No execution harness is available for hook chat model "${args.model}"`,
      );
    }
    const harnessChanged =
      queuedEntry.prepared.executionHarness !== nextExecutionHarness;
    const prefs = await readPreferencesFile();
    const nextThinkingLevelBase = harnessChanged
      ? resolveWorktreeProviderDefaultThinkingLevel(
          prefs,
          nextExecutionHarness,
          queuedEntry.prepared.thinkingLevel,
        )
      : queuedEntry.prepared.thinkingLevel;
    // The retained request (not a non-Codex resolved `standard`) is the
    // speed source, so Codex → other provider → Codex keeps the user's
    // choice and a queued launch never silently changes speed.
    const retainedSpeed = queuedEntry.prepared.retainedCodexSpeed;
    const nextModelConfig = resolveProviderModelConfig(
      nextExecutionHarness,
      {
        thinkingLevel: nextThinkingLevelBase,
        modelConfig: {
          thinkingLevel: nextThinkingLevelBase,
          ...(retainedSpeed === undefined
            ? {}
            : {
                speed: retainedSpeed,
                fastMode: codexSpeedFastMode(retainedSpeed),
              }),
        },
      },
      prefs.providerModelConfigDefaults,
    );
    const currentEntry = findQueuedHookChatEntry(args);
    if (!currentEntry) {
      return;
    }
    if (currentEntry.latestModelUpdateSequence !== requestSequence) {
      return;
    }

    currentEntry.prepared.model = args.model;
    currentEntry.prepared.providerType = nextProviderType;
    currentEntry.prepared.executionHarness = nextExecutionHarness;
    currentEntry.prepared.modelConfig = nextModelConfig;
    currentEntry.prepared.thinkingLevel = nextModelConfig.thinkingLevel;
    if (nextExecutionHarness === 'codex') {
      currentEntry.prepared.retainedCodexSpeed = nextModelConfig.speed;
    }
  } finally {
    if (queuedEntry.pendingModelUpdateCount > 0) {
      queuedEntry.pendingModelUpdateCount -= 1;
    }
    scheduleDrain();
  }
}

export function updateQueuedHookChatPluginSelections(args: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  pluginSelections?: ChatTabPluginSelections;
  deferredToolsAllowed?: boolean;
}): void {
  const entry = findQueuedHookChatEntry(args);
  if (!entry) {
    return;
  }

  entry.prepared.pluginSelections = args.pluginSelections;
  if (typeof args.deferredToolsAllowed === 'boolean') {
    entry.prepared.deferredToolsAllowed = args.deferredToolsAllowed;
  }
}

type LaunchHookChatArgs = {
  projectId: string;
  worktreeId: string;
  action: ChatHookAction;
  prompt: string;
  interpolateText?: (text: string) => string;
  triggerName: string;
  getWindow: () => BrowserWindow | null;
  /**
   * For multi-repo workspaces: the child repo whose checkout should be the
   * agent's working directory. Set when the hook fired on a child repo
   * (`HookDescriptor.target === 'workspace-repo'`); leave undefined for
   * workspace-root and single-repo hooks.
   */
  selectedRepoId?: string;
};

async function launchHookChatWithScopeLease(
  args: LaunchHookChatArgs,
): Promise<void> {
  const prepared = await prepareHookChatLaunch(args);

  // Hook chats open in the background: the user stays on the tab they are
  // using, and a worktree they come back to reopens on the tab they left.
  if (args.action.allowChatConcurrency === true) {
    await startPreparedHookChat(prepared, { activateTab: false });
    return;
  }

  if (
    isHookChatStartInProgressForTarget(prepared) ||
    hasActiveChatTurnsForWorktree(prepared.projectId, prepared.worktreeId) ||
    hasQueuedHookChatForTarget(prepared)
  ) {
    queuePreparedHookChat(prepared);
    return;
  }

  hookChatStartInProgressTargetKeys.add(getHookChatTargetKey(prepared));
  try {
    await startPreparedHookChat(prepared, { activateTab: false });
  } finally {
    hookChatStartInProgressTargetKeys.delete(getHookChatTargetKey(prepared));
    scheduleDrain();
  }
}

export async function launchHookChat(args: LaunchHookChatArgs): Promise<void> {
  return getChatStateService().runWithScopeActivity(
    { projectId: args.projectId, worktreeId: args.worktreeId },
    () => launchHookChatWithScopeLease(args),
  );
}
