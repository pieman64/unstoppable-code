import type { BrowserWindow } from 'electron';
import {
  getExecutionHarnessForModel,
  requireProviderForModel,
  IPC_CHANNELS,
  normalizeThinkingForProvider,
  resolveKnownModel,
  type AgentProviderType,
  type ChatModel,
  type ModelHarness,
  type ChatTabPluginSelections,
  type PersistedChatMessage,
  type PersistedChatTab,
  type PreferencesData,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { BUILTIN_PLUGIN_MARKETPLACE_ID } from '@canopy/desktop-shared/types/plugins';
import { sendToWindow } from './window-send';
import { dispatchWorktreeChatTurn } from './worktree-chat-turn';
import {
  commitProviderChatEvent,
  completePersistedChatTabTurn,
  emitChatDispatchFailure,
  removePersistedChatTab,
  upsertPersistedChatTab,
} from './chat-tab-dispatch-utils';
import { requireLaneAwareDefaultSelection } from './default-model-lane-resolver';
import { getChatStateService } from '../services/chat-state-service';
import { resolvePersistedApprovalMode } from './approval-mode-resolution';
import { newChatPluginDefaultsStamp } from '@canopy/desktop-shared/lib/effective-plugin-selections';

/** Plugin name of the bundled GitHub workflow plugin in the built-in marketplace. */
const BUILTIN_GH_PLUGIN_NAME = 'builtin-gh';

/**
 * The PR-status-bar agent flows backed by the bundled `builtin-gh` plugin.
 * Each maps to a `builtin-gh` skill invocation and a transcript marker block.
 */
export type BuiltinGhChatKind =
  | 'merge_conflict'
  | 'review_comment_triage'
  | 'ci_check_fix'
  | 'merge_queue';

interface BuiltinGhChatContext {
  repoName?: string;
  branchName?: string;
  prUrl?: string;
  prNumber?: number;
}

interface BuiltinGhChatKindConfig {
  /** Id prefix for generated chat/message ids. */
  idPrefix: string;
  /** `builtin-gh` skill invocation (including any flags), without the prefix. */
  skillCommand: (context: BuiltinGhChatContext) => string;
  title: (context: BuiltinGhChatContext) => string;
}

const KIND_CONFIG: Record<BuiltinGhChatKind, BuiltinGhChatKindConfig> = {
  merge_queue: {
    idPrefix: 'merge-queue',
    skillCommand: (context) => {
      if (
        !context.prUrl ||
        !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/[1-9]\d*$/.test(
          context.prUrl,
        )
      ) {
        throw new Error(
          'A valid GitHub pull request URL is required to start a merge queue chat.',
        );
      }
      return `merge-pr ${context.prUrl}`;
    },
    title: (context) =>
      context.repoName
        ? `Merge ${context.repoName} through the merge queue`
        : 'Merge through the merge queue',
  },
  merge_conflict: {
    idPrefix: 'merge-conflict',
    skillCommand: () => 'handle-merge-conflicts --push',
    title: (context) =>
      context.repoName
        ? `Resolve merge conflicts in ${context.repoName}`
        : 'Resolve merge conflicts',
  },
  review_comment_triage: {
    idPrefix: 'pr-comment-triage',
    skillCommand: () => 'handle-pr-comments',
    title: (context) =>
      context.repoName
        ? `Triage review comments in ${context.repoName}`
        : 'Triage review comments',
  },
  ci_check_fix: {
    idPrefix: 'ci-check-fix',
    skillCommand: () => 'handle-pr-checks --auto',
    title: (context) =>
      context.repoName
        ? `Fix failing CI checks in ${context.repoName}`
        : 'Fix failing CI checks',
  },
};

let generatedIdCounter = 0;

function nextGeneratedId(prefix: string, idPrefix: string): string {
  generatedIdCounter += 1;
  return `${prefix}-${idPrefix}-${Date.now()}-${generatedIdCounter}`;
}

/**
 * The prompt is a single skill invocation. Codex slash commands use `$`, while
 * Claude and Ollama use `/`.
 */
function buildPromptText(
  providerType: AgentProviderType,
  skillCommand: string,
): string {
  const prefix = providerType === 'codex' ? '$' : '/';
  return `${prefix}${BUILTIN_GH_PLUGIN_NAME}:${skillCommand}`;
}

function buildInitialMessages(args: {
  kind: BuiltinGhChatKind;
  idPrefix: string;
  context: BuiltinGhChatContext;
  userMessageId: string;
  promptText: string;
}): PersistedChatMessage[] {
  const timestamp = Date.now();
  return [
    {
      id: nextGeneratedId('msg', args.idPrefix),
      role: 'system',
      blocks: [
        {
          type: 'builtin_gh_chat_info',
          kind: args.kind,
          ...(args.context.repoName ? { repoName: args.context.repoName } : {}),
          ...(args.context.branchName
            ? { branchName: args.context.branchName }
            : {}),
          timestamp,
        },
      ],
      timestamp,
    },
    {
      id: args.userMessageId,
      role: 'user',
      blocks: [{ type: 'text', text: args.promptText }],
      timestamp,
    },
    {
      id: nextGeneratedId('msg', args.idPrefix),
      role: 'system',
      blocks: [{ type: 'turn_timer', startedAt: timestamp, completedAt: null }],
      timestamp,
    },
  ];
}

/**
 * The chat's own selection: the built-in `builtin-gh` plugin, force-enabled
 * because the prompt is a `builtin-gh` skill invocation. Project default
 * plugins are inherited live at each turn, not copied in.
 */
function builtinGhPluginSelections(): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [
      {
        marketplaceId: BUILTIN_PLUGIN_MARKETPLACE_ID,
        pluginName: BUILTIN_GH_PLUGIN_NAME,
      },
    ],
  };
}

async function resolveModelAndThinking(
  prefs: PreferencesData,
  // Parity with the spawn: this launcher dispatches a worktree chat turn for
  // `projectId`, so a Canopy Environments credential assigned to that workspace
  // must be visible to the selection too.
  projectId: string,
): Promise<{
  model: ChatModel;
  providerType: AgentProviderType;
  executionHarness: ModelHarness;
  thinkingLevel: ThinkingLevel;
}> {
  // Lane-aware, NOT `resolveOverallDefault`. This launcher passes its model to
  // `dispatchWorktreeChatTurn` EXPLICITLY, and central lane resolution there
  // only runs when `options.model === undefined` — so resolving the raw
  // preference here bypassed CAN-1929 entirely and a credits-only user kept
  // creating GitHub chats on the billing-unaware native default.
  const worktreeDefault = await requireLaneAwareDefaultSelection(
    prefs,
    'worktree',
    { workspaceId: projectId },
  );
  const model =
    resolveKnownModel(worktreeDefault.model) ?? worktreeDefault.model;
  const providerType = requireProviderForModel(model);
  const executionHarness = getExecutionHarnessForModel(model);
  if (!executionHarness) {
    throw new Error(
      `No execution harness is available for GitHub chat model "${model}"`,
    );
  }
  const thinkingLevel = normalizeThinkingForProvider(
    worktreeDefault.thinkingLevel,
    executionHarness,
  );
  return { model, providerType, executionHarness, thinkingLevel };
}

export interface LaunchBuiltinGhChatResult {
  chatId: string;
}

export interface LaunchBuiltinGhChatArgs {
  kind: BuiltinGhChatKind;
  projectId: string;
  worktreeId: string;
  selectedRepoId?: string;
  prefs: PreferencesData;
  context: BuiltinGhChatContext;
  getWindow: () => BrowserWindow | null;
}

/**
 * Creates a worktree chat using the user's defaults with the `builtin-gh`
 * plugin enabled, marks it with a source banner, and dispatches the
 * provider-specific skill invocation.
 */
async function launchBuiltinGhChatWithScopeLease(
  args: LaunchBuiltinGhChatArgs,
): Promise<LaunchBuiltinGhChatResult> {
  const config = KIND_CONFIG[args.kind];
  const skillCommand = config.skillCommand(args.context);
  const [modelSelection, approvalMode] = await Promise.all([
    resolveModelAndThinking(args.prefs, args.projectId),
    resolvePersistedApprovalMode(args.projectId, args.worktreeId),
  ]);
  const { model, providerType, executionHarness, thinkingLevel } =
    modelSelection;
  const chatId = nextGeneratedId('chat', config.idPrefix);
  const userMessageId = nextGeneratedId('msg', config.idPrefix);
  const pluginSelections = builtinGhPluginSelections();
  const promptText = buildPromptText(executionHarness, skillCommand);

  const tab: PersistedChatTab = {
    id: chatId,
    title: config.title(args.context),
    messages: buildInitialMessages({
      kind: args.kind,
      idPrefix: config.idPrefix,
      context: args.context,
      userMessageId,
      promptText,
    }),
    createdAt: new Date().toISOString(),
    thinkingLevel,
    model,
    providerType,
    executionHarness,
    approvalMode,
    pluginSelections,
    ...newChatPluginDefaultsStamp(args.projectId),
    ...(args.selectedRepoId ? { selectedRepoId: args.selectedRepoId } : {}),
  };

  await upsertPersistedChatTab({
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    tab,
    activateTab: true,
  });

  const delivered = sendToWindow(
    args.getWindow(),
    IPC_CHANNELS.chatHookTabStarted,
    {
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      chatId,
      tab,
      activateTab: true,
    },
  );
  if (!delivered) {
    await removePersistedChatTab({
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      chatId,
    });
    throw new Error(
      'This chat requires an active renderer window before it can start.',
    );
  }

  try {
    await dispatchWorktreeChatTurn({
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      chatId,
      userMessageId,
      text: promptText,
      planMode: false,
      thinkingLevel,
      model,
      providerType,
      executionHarness,
      approvalMode,
      pluginSelections,
      initiationSource: 'hook',
      ...(args.selectedRepoId ? { selectedRepoId: args.selectedRepoId } : {}),
      getWindow: args.getWindow,
      skipBranchNaming: true,
      onBeforeChatEvent: (event) =>
        commitProviderChatEvent({
          projectId: args.projectId,
          worktreeId: args.worktreeId,
          chatId,
          userMessageId,
          providerType,
          event,
        }),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await completePersistedChatTabTurn({
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      chatId,
    });
    await emitChatDispatchFailure({
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      chatId,
      errorMessage,
      getWindow: args.getWindow,
    });
    throw error;
  }

  return { chatId };
}

export async function launchBuiltinGhChat(
  args: LaunchBuiltinGhChatArgs,
): Promise<LaunchBuiltinGhChatResult> {
  return getChatStateService().runWithScopeActivity(
    { projectId: args.projectId, worktreeId: args.worktreeId },
    () => launchBuiltinGhChatWithScopeLease(args),
  );
}

type WrapperArgs = Omit<LaunchBuiltinGhChatArgs, 'kind'>;

/** Launch a chat that resolves GitHub merge conflicts, then commits and pushes. */
export async function launchMergeConflictResolutionChat(
  args: WrapperArgs,
): Promise<LaunchBuiltinGhChatResult> {
  return launchBuiltinGhChat({ ...args, kind: 'merge_conflict' });
}

/** Launch a chat that triages the PR's review comments. */
export async function launchPrCommentTriageChat(
  args: WrapperArgs,
): Promise<LaunchBuiltinGhChatResult> {
  return launchBuiltinGhChat({ ...args, kind: 'review_comment_triage' });
}

/** Launch a chat that diagnoses and fixes the PR's failing CI checks. */
export async function launchCiCheckFixChat(
  args: WrapperArgs,
): Promise<LaunchBuiltinGhChatResult> {
  return launchBuiltinGhChat({ ...args, kind: 'ci_check_fix' });
}

/** Launch the queue lifecycle skill for a freshly verified, explicit PR. */
export async function launchMergeQueueChat(
  args: WrapperArgs,
): Promise<LaunchBuiltinGhChatResult> {
  return launchBuiltinGhChat({ ...args, kind: 'merge_queue' });
}
