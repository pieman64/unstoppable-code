import { isClaudeTurnLimitMessage } from '@canopy/agent-transcript';
import { deriveChatWorkflowCapabilities } from '@canopy/app-core';
import { UnresolvedCapabilitySelection } from '@canopy/ui-shared/components';
import { pickProvider } from '@/lib/pickProvider';
import { mergeChatPluginSelections } from '@/lib/chatPluginSelections';
import { useComposerMenu } from '@/hooks/useComposerMenu';
import {
  buildComposerCommands,
  getComposerAction,
} from '@/lib/composerCommands';
import { requestModelPickerOpen } from '@/lib/composerShortcutRequests';
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { QuestionPrompt, QuestionSkipButton } from './QuestionPrompt';
import { isTypingOutside } from './ComposerPrompt';
import {
  useComposerQuestionPrompt,
  type ComposerPendingQuestion,
  type ComposerQuestionDelivery,
} from './useComposerQuestionPrompt';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { useComposerQuestions } from './useComposerQuestions';
import { Editor, Node as SlateNode, type Descendant, Transforms } from 'slate';
import {
  resolveLaneForTarget,
  resolveTabDefaults,
  useChatStore as useLiveChatStore,
  useChatTabRenderState,
  type ChatRenderTarget,
  type PendingPlanExit,
} from '@/stores/chatStore';
import {
  useChatSurfaceScope,
  useChatSurfaceStore,
} from '@/stores/chat/surface-store';
import {
  approvalDefaultCacheKey,
  getApprovalDefaultsGeneration,
  subscribeApprovalDefaultsGeneration,
} from '@/stores/chat/approval-defaults';
import {
  useCancelRunningChatShortcut,
  useCancelShortcutConfirmationStore,
} from './useCancelRunningChatShortcut';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useResourceMonitorStore } from '@/stores/resourceMonitorStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';
import {
  getRendererBillingLaneFactsVersion,
  subscribeRendererBillingLaneFacts,
} from '@/stores/billingLaneRuntime';
import {
  getRendererModelFactsVersion,
  getRendererModelPolicy,
  subscribeRendererModelFacts,
} from '@/stores/modelPolicyRuntime';
import { useGlobalPluginDefaultsStore } from '@/stores/globalPluginDefaultsStore';
import {
  chatInheritsProjectDefaults,
  chatSurfaceUsesGlobalPluginDefaults,
  effectiveChatPluginSelections,
  splitChosenChatPluginSelections,
  type InheritedPluginLayers,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import {
  getProjectPluginDefaults,
  getProjectPluginTombstones,
} from '@/stores/chat/tab-utils';
import { inheritedDefaultLayers } from '@/lib/chatPluginEditing';
import { brandText } from '@/lib/brand';
import { isCoworkChatTarget } from '@/lib/cowork';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { resolveComposerWorkflowGates } from './composer-workflow-gates';
import {
  isChatAttachmentShortcutTarget,
  OPEN_CHAT_ATTACHMENTS_EVENT,
} from '@/lib/chatAttachmentShortcut';
import { useComposerActions } from '@/hooks/useComposerActions';
import { useComposerShortcutRequests } from '@/hooks/useComposerShortcutRequests';
import { DICTATION_SHORTCUT_LABEL } from '@/lib/keyboardShortcuts';
import type { ComposerShortcutScope } from '@/lib/composerShortcutRequests';
import { useCanopyClient } from '@canopy/app-state';
import { useTerminalComposerMode } from '@canopy/ui-app/code/composer/terminal-mode';
import { runCommandInTerminal } from '@canopy/ui-app/script-actions/run-command-in-terminal';
import {
  caretOnFirstLine,
  ScriptTypeaheadMenu,
  useScriptTypeahead,
} from '@canopy/ui-app/script-actions/typeahead';
import { desktopTerminalRunHost } from '@/lib/script-actions-terminal-host';
import { usePanelPlacement } from '@/lib/panels/panel-placement-context';
import {
  getWorktreeCacheKey,
  isFileIndexStale,
  useFileListStore,
} from '@/stores/fileListStore';
import { useShallow } from 'zustand/react/shallow';
import {
  DEFAULT_APPROVAL_DEFAULTS,
  DEFAULT_MODEL,
  DEFAULT_TERMINAL_DRAWER_HEIGHT,
  type ApprovalMode,
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type AgentProviderType,
  type AttachmentMeta,
  type AgentModelConfig,
  type ChatAttachmentPromptContext,
  type ChatModel,
  type ModelHarness,
  type ChatTabPluginSelections,
  type FileReference,
  type LinearTicketSearchResult,
  type ScheduledActivity,
  type SlashCommandData,
  clampThinkingLevelForModel,
  getAgentModelSelectionId,
  getEffectiveSupportedThinkingLevelsForModel,
  getProviderForModel,
  modelConfigForProviderSupportsFastMode,
  normalizeThinkingForUi,
  resolveOverallDefault,
  getModelDisplayName,
  isChatAttachmentPromptKind,
} from '@canopy/desktop-shared/types';
import { DEFAULT_VOICE_DICTATION_ENABLED } from '@canopy/desktop-shared/constants/preferences';
import { computeUsageLimitResumePrompt } from '@canopy/desktop-shared/lib/usage-limit-resume-prompt';
import { normalizeEpochMs } from '@canopy/desktop-shared/ai-credits-routing-state';
import {
  EMPTY_COMPLETION_RESUME_PROMPT,
  buildEmptyCompletionRetryPrompt,
  type EmptyCompletionRecoveryView,
} from '@/stores/chat/empty-completion';
import { EmptyCompletionRecoveryNotice } from './EmptyCompletionRecoveryNotice';
import { StoppedTurnResumeNotice } from './StoppedTurnResumeNotice';
import type {
  PipelineData,
  PipelineModelAliasPreference,
  PipelinePluginCollectionPreference,
  PipelinePreferenceLocator,
} from '@canopy/desktop-shared/types/pipeline';
import {
  resolveEffectiveProviderType,
  selectDiscoverySlashCommands,
} from '@/lib/chatDiscovery';
import { resolveDiscoveryProviderType } from '@/stores/chat/discovery';
import { ChatPluginsModal } from './ChatPluginsModal';
import { PlanDetectionBanner } from './PlanDetectionBanner';
import { SkillShareNudgeBanner } from './SkillShareNudgeBanner';
import { SkillSuggestionBannerHost } from './SkillSuggestionBannerHost';
import { AiCreditsRoutingStatusBanner } from './AiCreditsRoutingStatusBanner';
import { useEffectiveAiCreditsRouting } from '@/hooks/useEffectiveAiCreditsRouting';
import { OllamaConnectionBanner } from './OllamaConnectionBanner';
import { ModelGatewayKeyBanner } from './ModelGatewayKeyBanner';
import { ApprovalsUpgradeNotice } from './ApprovalsUpgradeNotice';
import { ToolApprovalDock } from './ToolApprovalDock';
import { AiCreditsUsageLimitBanner } from './AiCreditsUsageLimitBanner';
import { formatUsageLimitTimeLabel } from '@/lib/usage-limit-time-label';
import { NoBillingSourceBanner } from './NoBillingSourceBanner';
import { OrgLapsedBanner } from './OrgLapsedBanner';
import { TransientRetryBanner } from './TransientRetryBanner';
import { ScheduledAutomationsNotice } from './ScheduledAutomationsNotice';
import { TryItSignInBanner } from './TryItSignInBanner';
import {
  useAiCreditsBannerStore,
  useAiCreditsRoutingActive,
  useVisibleUsageLimitBanner,
  type ChatBannerTarget,
} from '@/stores/aiCreditsBannerStore';
import {
  isGatewayOnlyModel,
  resolveOrgGatewayOrganizationId,
} from '@canopy/desktop-shared/lib/gateway-model-availability';
import { openPendingPlanExit } from '@/lib/plans/open-tracked-plan';
import { PlanReadyPipelineModal } from './PlanReadyPipelineModal';
import { usePipelineRunWatcher } from '@/components/activity/usePipelineRunWatcher';
import { ModelPicker } from './ModelPicker';
import { ComposerControlHighlight } from '@/components/home/PlanModeHighlight';
import { notifyHomeTaskSent } from '@/components/home/onboarding-suggestions/sendEvents';
import { useOnboardingSuggestionSurfaces } from '@/stores/onboardingSuggestionSurfacesStore';
import {
  resolveChatBillingFramework,
  type ChatBillingResolution,
  type BillingFramework,
} from '@/lib/chatBillingFramework';
import { useProviderAvailability } from '@/hooks/useProviderAvailability';
import { useThinkingHarness } from './useThinkingHarness';
import { DirectoryPicker } from './DirectoryPicker';
import { UsageIndicator } from './UsageIndicator';
import { getSlashCommandInsertText } from '@/hooks/useSlashCommands';
import { useInvocableInventory } from '@/hooks/useInvocableInventory';
import {
  INVENTORY_ENABLE_ERROR_COPY,
  buildSlashInventoryCommands,
  flattenCollectionRefs,
  runInventorySelection,
  type CollectionEnabledRefs,
  inventoryRowNeedsResolution,
} from '@/lib/slashInvocableInventory';
import { createEmptySelections } from '@/lib/pluginSelections';
import {
  mergeAgentChatPluginSelections,
  stripAgentOnlyChatPluginSelections,
} from '@/lib/chatPluginSelections';
import { useStuckAgentTimer } from '@/hooks/useStuckAgentTimer';
import {
  ComposerEditor,
  type ComposerDensity,
  buildEditorValueFromMessage,
  createChatEditor,
  focusEditor,
  resetEditor,
  restoreEditorContent,
  serializeEditorValue,
  createEmptyValue,
} from '@canopy/ui-rich/editor';
import type {
  FileReferenceElement,
  SerializedFileReference,
} from '@canopy/ui-rich/types';
import { VoiceInputButton } from '../shared/VoiceInputButton';
import { VoiceDictationErrorModal } from '../shared/VoiceDictationErrorModal';
import { useVoiceTranscription } from '@/hooks/useVoiceTranscription';
import { useHoldToDictate } from '@/hooks/useHoldToDictate';
import { onVoiceDictationEnabledChanged } from '@/lib/voice/voice-dictation-pref';
import { createSlateVoiceTarget } from '@/lib/voice/insert-into-slate';
import { shouldMarkFinalTranscriptAsVoiceInput } from './dictation-input-mode';
import { shouldMaterializeCodexThread } from './codex-thread-materialization';
import { localPlatform } from '@/lib/local-platform';
import { shouldProbeVoiceSupport } from '@/lib/voice/voice-platform';
import {
  getCwdFromFileIndex,
  rewriteFileReferencesForCwd,
} from '@/lib/file-reference-paths';
import {
  EMPTY_ATTACHMENT_ITEMS,
  EMPTY_NOTE_ITEMS,
  EMPTY_PROMPT_ITEMS,
  searchWorkspaceItemMentions,
  searchFileMentions,
  type WorkspaceItemMentionSources,
} from '@/lib/fileMentionSearch';
import { missingMentionedPluginRefs } from '@canopy/desktop-shared/lib/plugin-mention';
import {
  expandPromptMentions,
  mergePromptAwareFileReferences,
} from '@/lib/promptMentionExpansion';
import { useWorkspaceItemsStore } from '@/stores/workspaceItemsStore';
import { AttachmentPillCarousel } from './AttachmentPillCarousel';
import { ScheduledSendChip } from './ScheduledSendChip';
import { ApprovalModePicker } from './ApprovalModePicker';
import { ComposerSendButton } from './ComposerSendButton';
import {
  PLAN_APPROVAL_BOX_CLASS,
  PLAN_APPROVAL_EDITOR_CONTAINER_CLASS,
  PlanApprovalPrompt,
  type PlanApprovalOption,
} from './PlanApprovalPrompt';
import { ChatDropOverlay } from './ChatDropOverlay';
import { useChatFileDrop } from './useChatFileDrop';
import { VoiceRecordingRow } from './VoiceRecordingRow';
import {
  type ComposerActionHandlers,
  runComposerAction,
  buildPlanReadyChip,
  buildQuestionReadyChip,
  COMPACT_CHIPS_BREAKPOINT_REM,
  COMPACT_CHIPS_HYSTERESIS_REM,
  buildChatComposerPlusItems,
  CHAT_COMPOSER_MIN_TEXT_WIDTH_PX,
  ComposerStatusRow,
  expandedComposerEditorContainerClassName,
  ONE_LINE_COMPOSER_BOX_STYLE,
  ONE_LINE_COMPOSER_CLASS_NAMES,
  TERMINAL_MODE_ERROR_SHELL_CLASS,
  TERMINAL_MODE_SHELL_CLASS,
  TerminalModeLabel,
  useAnimatedComposerBox,
  useOneLineComposer,
  VOICE_TAKE_EDITOR_CONTAINER_CLASS,
} from './ComposerLayout';
import { useClaudeTuiChatsEnabled } from '@/lib/claude-tui-chats';
import {
  resolveChatInterfaceModeOptions,
  type ChatInterfaceModeControl,
} from './chatInterfaceModes';
import { SelectionContextChips } from './SelectionContextChips';
import {
  appendSelectionContextBlocks,
  INSERT_CHAT_TEXT_EVENT,
  REVEAL_EDITOR_RANGE_EVENT,
  shouldHandleChatTextInsertion,
  stashPendingEditorRangeReveal,
  type EditorSelectionContext,
  type InsertChatTextDetail,
  type RevealEditorRangeDetail,
  type SelectionFreshness,
} from '@/lib/editorSelectionContext';
import type { ActiveComposerView } from './types';
import { computeColsRowsForPixels } from '@/lib/terminal-dimensions';
import { saveDraftForExistingTab } from '@/lib/chatDrafts';
import {
  findComposerDensityPanel,
  resolveComposerDensity,
} from '@/lib/composer-density';
import { extractIpcErrorMessage } from '@/lib/errors';
import {
  isEditorSelectionAtBoundary,
  type HistoryBoundary,
  type MessageHistoryNavigationState,
} from './message-history';
import {
  Button,
  ChatComposerToolbar,
  FLOATING_PICKER_GAP,
  Notice,
  NoticeButton,
  ConfirmDialog,
  ThinkingLevelPanelPicker,
  NoticeShapeProvider,
  CHAT_COMPOSER_SHELL_CLASS,
  nextCodexSpeed,
  buildPlanModeChip,
} from '@canopy/ui-shared';
import { ComposerNoticeStack } from '@canopy/ui-shared/components';
import { canContinueOnOtherHarness } from '@/lib/chatProviderLock';
import { hasPendingQuestionForChat } from '@/stores/chat/pending-questions';
import { isTabAiCreditsRouted } from '@/stores/chat/tab-utils';
import { tabRequestedCodexSpeed } from '@/stores/chat/codex-speed';
import { useContextualCodexSpeedControl } from '@/hooks/useContextualCodexSpeedControl';
import { useCodexSpeedDowngrade } from '@/hooks/useCodexSpeedDowngrade';
import { getDocument } from '@canopy/ui-shared/panels';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { useAutoModelRoutingAvailability } from '@/hooks/useAutoModelRouting';
import { chatAiCreditsScope } from '@/lib/aiCreditsScope';
import { useAutomationsStore } from '@/stores/automationsStore';
import { captureActivePlanContext } from '@/stores/activePlanStore';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { selectProviderUsageLimitResumeAt } from '@/lib/claudeUsageLimitResume';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { ScheduleMessageModal } from './ScheduleMessageModal';
import { WatcherManagementButton } from '@/components/watchers/WatcherManagementButton';
import { watchersForSubscriberDestination } from '@/components/watchers/watcherFilters';
import {
  ATTACHMENT_IMPORT_ERROR_MESSAGE,
  addPendingAttachmentsAndRefreshIndex,
  createClipboardAttachments,
  importChatAttachments,
} from '@/lib/chatAttachments';
import { stageLinearTicketAttachment } from '@/lib/linearTicketStaging';
import { ComposerPlusMenu } from '@/components/shared/ComposerPlusMenu';
import { dispatchBrowserViewBoundsInvalidated } from '@/lib/browserViewBounds';
import type { BillingLane } from '@canopy/desktop-shared/lib/default-model-lane';

interface PipelinePluginCollectionContext {
  preferences: Record<string, PipelinePluginCollectionPreference>;
  modelAliasPreferences?: Record<string, PipelineModelAliasPreference>;
  pipelinePreferenceLocator?: PipelinePreferenceLocator;
  modelConfig?: AgentModelConfig;
}

const COMPACT_TOOLBAR_BREAKPOINT_REM = 40;
const COMPACT_TOOLBAR_HYSTERESIS_REM = COMPACT_CHIPS_HYSTERESIS_REM;

const DEFAULT_TERMINAL_SPAWN_COLS = 80;
const DEFAULT_TERMINAL_SPAWN_ROWS = 24;

// Stable empty list so tabs without staged editor selections do not re-render
// the composer on unrelated store updates.
const NO_PENDING_SELECTIONS: readonly EditorSelectionContext[] = [];

// Lazy-loaded so the Linear ticket picker (and its debounced-search UI) only
// enters the chat chunk once a user actually opens the `+` menu's Linear row,
// following the same named-export lazy pattern App.tsx uses for its pages.
const LinearTicketPickerModal = lazy(() =>
  import('@/components/shared/linear/LinearTicketPickerModal').then((m) => ({
    default: m.LinearTicketPickerModal,
  })),
);

function getPendingPlanText(pendingExit: PendingPlanExit): string {
  const input = pendingExit.toolInput;
  return typeof input.plan === 'string'
    ? input.plan
    : JSON.stringify(input, null, 2);
}

/**
 * Inline-editing contract for a queued message. When provided, ChatInput
 * renders as an in-place editor instead of the live composer:
 *  - editor content is seeded from `initialText` + `initialFileReferences`,
 *  - tab drafts are not saved or restored,
 *  - attachments use the caller-managed local list rather than the tab's
 *    `pendingAttachments`,
 *  - the streaming/idle send button is hidden in favor of a Cancel/Save row
 *    rendered just outside the rounded composer container,
 *  - banners that only apply to the live composer (stuck-agent, plan-exit,
 *    stale session) are suppressed.
 */
export interface ChatInputEditingState {
  autoFocus?: boolean;
  initialText: string;
  initialFileReferences: FileReference[];
  attachments: AttachmentMeta[];
  onAddAttachments: (attachments: AttachmentMeta[]) => void;
  onRemoveAttachment: (absolutePath: string) => void;
  onCancel: () => void;
  onSave: (
    text: string,
    fileReferences: FileReference[],
    attachmentPaths: string[],
    attachmentPromptContexts: ChatAttachmentPromptContext[] | undefined,
    inputMode: 'typed' | 'voice',
    scheduledSendDraft: { runAt: string } | undefined,
  ) => void;
  scheduledSendDraft?: { runAt: string };
  scheduleEnabled?: boolean;
}

interface ChatInputProps {
  tab: ActiveComposerView | null;
  userMessageHistory?: readonly string[];
  beforeComposer?: ReactNode;
  /**
   * A Claude chat's interface modes (the app's chat, Auto, Claude Code),
   * offered under View in the + menu. Supplied by worktree chat panels in the
   * Canopy display surface; the terminal surface floats its own toggle.
   */
  interfaceModeControl?: ChatInterfaceModeControl;
  extraFileReferences?: FileReference[];
  editingState?: ChatInputEditingState;
  targetOverride?: { projectId: string; worktreeId: string; chatId: string };
  /**
   * Marks a `targetOverride` composer as a live persisted chat session rather
   * than a mirror/embedded surface. Code worktree, Cowork, and App Advisor
   * composers opt in so scheduled sends and usage-limit resume target their
   * existing chat; pipeline/plan/archive mirrors leave this disabled.
   */
  nativeSessionComposer?: boolean;
  /** Opt in only for the ordinary Code/worktree chat surface. */
  allowCursor?: boolean;
  /** Whether this mounted composer owns global composer shortcut requests. */
  composerShortcutsEnabled?: boolean;
  /** Owning document for shortcuts when rendered in a popped-out panel. */
  cancelShortcutOwnerDocument?: Document;
  /** Active chat-panel root used to reject Escape from sibling surfaces. */
  cancelShortcutTargetRootRef?: RefObject<HTMLElement | null>;
  hidePlanMode?: boolean;
  hideDirectoryPicker?: boolean;
  disableTerminalMode?: boolean;
  disableFileTypeahead?: boolean;
  /**
   * Skills forced on for this surface that the user cannot remove. Forwarded to
   * the plugins modal so matching rows render as locked. Used by the embedded
   * pipeline-editor chat drawer for its required brand-specific
   * pipeline-writing skill.
   */
  lockedSkillRefs?: { sourceId: string; skillName: string }[];
  onSendMessage?: (
    text: string,
    fileReferences?: FileReference[],
    inputMode?: 'typed' | 'voice',
    attachmentPaths?: string[],
    attachmentPromptContexts?: ChatAttachmentPromptContext[],
  ) => Promise<void>;
}

function attachmentPromptContextsFromMeta(
  attachments: readonly AttachmentMeta[],
): ChatAttachmentPromptContext[] | undefined {
  const contexts = attachments
    .filter(
      (
        attachment,
      ): attachment is AttachmentMeta & {
        promptKind: NonNullable<AttachmentMeta['promptKind']>;
      } => isChatAttachmentPromptKind(attachment.promptKind),
    )
    .map((attachment) => ({
      attachmentPath: attachment.absolutePath,
      promptKind: attachment.promptKind,
    }));
  return contexts.length > 0 ? contexts : undefined;
}

/** The composer's hint, worded like New task's. */
function getDefaultChatPlaceholder({
  fileTypeaheadEnabled,
  slashTypeaheadEnabled,
}: {
  fileTypeaheadEnabled: boolean;
  slashTypeaheadEnabled: boolean;
}): string {
  if (fileTypeaheadEnabled && slashTypeaheadEnabled) {
    return '@ to mention, / skills and commands';
  }
  if (fileTypeaheadEnabled) {
    return 'Send a message, @ to mention';
  }
  if (slashTypeaheadEnabled) {
    return 'Send a message, / skills and commands';
  }
  return 'Send a message…';
}

/**
 * App Advisor's questions answer and skip through its own store, which
 * resolves the waiting tool call at once.
 */
const APP_ADVISOR_QUESTION_DELIVERY: ComposerQuestionDelivery = {
  answer: (requestId, answers): Promise<void> => {
    const store = useAppAdvisorStore.getState();
    const [answer] = answers;
    if (answer) store.answerQuestion(requestId, answer);
    else store.dismissQuestion(requestId);
    return Promise.resolve();
  },
  dismiss: (requestId): Promise<void> => {
    useAppAdvisorStore.getState().dismissQuestion(requestId);
    return Promise.resolve();
  },
};

/** The default a new chat in `projectId` starts on, read when a pick lands. */
function chatDefaultModel(
  projectId: string | undefined,
  modelDefaults: Parameters<typeof resolveTabDefaults>[1],
): ChatModel | undefined {
  return projectId
    ? resolveTabDefaults(projectId, modelDefaults).model
    : undefined;
}

export const ChatInput = memo(function ChatInput({
  tab,
  userMessageHistory = [],
  beforeComposer,
  interfaceModeControl,
  extraFileReferences = [],
  editingState,
  targetOverride,
  nativeSessionComposer = false,
  allowCursor = false,
  composerShortcutsEnabled = true,
  cancelShortcutOwnerDocument,
  cancelShortcutTargetRootRef,
  hidePlanMode = false,
  hideDirectoryPicker = false,
  disableTerminalMode = false,
  disableFileTypeahead = false,
  lockedSkillRefs,
  onSendMessage,
}: ChatInputProps): JSX.Element {
  const useChatStore = useChatSurfaceStore(useLiveChatStore);
  const sandbox = useChatSurfaceScope()?.mode === 'sandbox';
  const isEditingQueued = editingState !== undefined;
  const editor = useMemo(() => createChatEditor(), []);
  const initialEditorValue = useMemo<Descendant[]>(
    () =>
      editingState
        ? buildEditorValueFromMessage(
            editingState.initialText,
            editingState.initialFileReferences,
          )
        : createEmptyValue(),
    // Only the initial render snapshot matters — re-mount the editor (via
    // ChatMessageList's keyed wrapper) to seed a different message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [value, setValue] = useState<Descendant[]>(() =>
    structuredClone(initialEditorValue),
  );
  const [, setSelectionRevision] = useState(0);
  const tabId = tab?.id;
  const modelPickerHighlightRef = useRef<HTMLDivElement>(null);
  const modelPickerHighlight = useOnboardingSuggestionSurfaces(
    (state) =>
      state.modelPickerHighlightTarget?.scope === 'chat' &&
      state.modelPickerHighlightTarget.chatId === tabId,
  );
  const messageHistoryNavigationRef =
    useRef<MessageHistoryNavigationState | null>(null);
  const historyNavigationProgrammaticChangeRef = useRef(false);
  const composerRootRef = useRef<HTMLDivElement | null>(null);

  const getDraftForSave = useCallback(
    (draftTabId: string | null, fallbackDraft: Descendant[]): Descendant[] => {
      const navigationState = messageHistoryNavigationRef.current;
      if (draftTabId !== null && navigationState?.tabId === draftTabId) {
        return navigationState.draft;
      }
      return fallbackDraft;
    },
    [],
  );

  const markHistoryNavigationProgrammaticChange = useCallback((): void => {
    historyNavigationProgrammaticChangeRef.current = true;
    window.setTimeout((): void => {
      historyNavigationProgrammaticChangeRef.current = false;
    }, 0);
  }, []);

  useEffect(() => {
    messageHistoryNavigationRef.current = null;
  }, [tabId]);

  // Save outgoing tab's draft and restore incoming tab's draft on tab switch.
  // Uses useLayoutEffect to prevent a flash of stale content before the swap.
  // A separate cleanup below saves the current draft when the composer
  // unmounts, such as when a file tab becomes active.
  const prevTabIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (isEditingQueued) {
      // Edit-mode editor is seeded from `editingState.initialText`; drafts
      // are intentionally untouched so the live composer below keeps its own.
      restoreEditorContent(editor, initialEditorValue);
      setValue(structuredClone(editor.children));
      prevTabIdRef.current = tab?.id ?? null;
      return;
    }

    const state = useChatStore.getState();
    const currentTabId = tab?.id ?? null;

    // Save outgoing tab's draft — but only if the tab still exists (it may
    // have been closed, in which case closeTab already cleared its draft).
    if (
      prevTabIdRef.current !== null &&
      prevTabIdRef.current !== currentTabId
    ) {
      saveDraftForExistingTab(
        state,
        prevTabIdRef.current,
        getDraftForSave(prevTabIdRef.current, editor.children),
      );
    }

    // Restore incoming tab's draft or reset
    if (currentTabId !== null) {
      const draft = state.getTabDraft(currentTabId);
      if (draft && draft.length > 0) {
        restoreEditorContent(editor, draft);
        setValue(structuredClone(editor.children));
      } else if (
        prevTabIdRef.current !== null &&
        prevTabIdRef.current !== currentTabId
      ) {
        resetEditor(editor);
        setValue(createEmptyValue());
      }
    } else {
      resetEditor(editor);
      setValue(createEmptyValue());
    }

    prevTabIdRef.current = currentTabId;
  }, [
    tab?.id,
    editor,
    getDraftForSave,
    isEditingQueued,
    initialEditorValue,
    useChatStore,
  ]);

  useLayoutEffect(() => {
    if (isEditingQueued) return undefined;
    return (): void => {
      saveDraftForExistingTab(
        useChatStore.getState(),
        prevTabIdRef.current,
        getDraftForSave(prevTabIdRef.current, editor.children),
      );
    };
  }, [editor, getDraftForSave, isEditingQueued, useChatStore]);

  useEffect(() => {
    const node = composerRootRef.current;
    if (!node || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    dispatchBrowserViewBoundsInvalidated();
    const observer = new ResizeObserver(() => {
      dispatchBrowserViewBoundsInvalidated();
    });
    observer.observe(node);
    return (): void => {
      observer.disconnect();
      dispatchBrowserViewBoundsInvalidated();
    };
  }, []);

  // Reset dictation mode whenever the user switches tabs so a voice-marked
  // draft does not accidentally follow the user into a different chat.
  useEffect(() => {
    dictationInputModeRef.current = 'typed';
  }, [tab?.id]);

  // Several composers can be mounted at once (split chat panels and MainPage
  // behind other pages). Document-level insert/focus events must only act on a
  // composer the user can actually see, otherwise one event would fan out into
  // every mounted editor.
  const isComposerVisible = useCallback((): boolean => {
    const node = composerRootRef.current;
    return node !== null && node.getClientRects().length > 0;
  }, []);

  const sendMessage = useChatStore((s) => s.sendMessage);
  const cancelSession = useChatStore((s) => s.cancelSession);
  const resumeStoppedTurn = useChatStore((s) => s.resumeStoppedTurn);
  // Escape-to-cancel confirmation (ECW-8986): the arming hook may live in a
  // separate tree (ChatContent with hideComposer), so the pending state is
  // read from the shared store, matched on this composer's chat identity.
  const cancelShortcutChatKey = useChatStore((s) => {
    if (targetOverride) {
      return `${targetOverride.projectId}/${targetOverride.worktreeId}/${targetOverride.chatId}`;
    }
    if (!tab || !s.selectedWorktree) return null;
    return `${s.selectedWorktree.projectId}/${s.selectedWorktree.worktreeId}/${tab.id}`;
  });
  const cancelShortcutArmed = useCancelShortcutConfirmationStore(
    (s) => s.armedChatKey !== null && s.armedChatKey === cancelShortcutChatKey,
  );
  const verifyStreamingTabs = useChatStore((s) => s.verifyStreamingTabs);
  const togglePlanMode = useChatStore((s) => s.togglePlanMode);
  const setSpeed = useChatStore((s) => s.setSpeed);
  const cycleThinkingLevel = useChatStore((s) => s.cycleThinkingLevel);
  const setThinkingLevel = useChatStore((s) => s.setThinkingLevel);
  const approvePlanExit = useChatStore((s) => s.approvePlanExit);
  const dismissPlanForPipeline = useChatStore((s) => s.dismissPlanForPipeline);
  const handleStaleSessionStartNew = useChatStore(
    (s) => s.handleStaleSessionStartNew,
  );
  const handleStaleSessionHandOff = useChatStore(
    (s) => s.handleStaleSessionHandOff,
  );
  const pendingPlanExits = useChatStore((s) => s.pendingPlanExits);
  const setModel = useChatStore((s) => s.setModel);
  const setModelSelectionMode = useChatStore((s) => s.setModelSelectionMode);
  const setTabApprovalMode = useChatStore((s) => s.setTabApprovalMode);
  const setModelAndWait = useChatStore((s) => s.setModelAndWait);
  const createTab = useChatStore((s) => s.createTab);
  const continueTabOnProvider = useChatStore((s) => s.continueTabOnProvider);
  const setSelectedRepoId = useChatStore((s) => s.setSelectedRepoId);
  const selectedWorktree = useChatStore((s) => s.selectedWorktree);
  const modelChangeKey = ((): string | undefined => {
    const selection = targetOverride ?? selectedWorktree;
    const chatId = targetOverride?.chatId ?? tab?.id;
    return selection && chatId
      ? `${selection.projectId}/${selection.worktreeId}/${chatId}`
      : undefined;
  })();
  const pendingModelChange = useChatStore(
    useShallow((s) =>
      modelChangeKey ? s.pendingModelChanges[modelChangeKey] : undefined,
    ),
  );
  const panelPlacement = usePanelPlacement();
  const openSettings = useNavigationStore((s) => s.openSettings);
  const addToast = useGitHubStore((s) => s.addToast);
  const enableAiCreditsRouting = useChatStore((s) => s.enableAiCreditsRouting);
  const selectBillingFramework = useChatStore((s) => s.selectBillingFramework);
  const setAiCreditsRoutingResetsAt = useChatStore(
    (s) => s.setAiCreditsRoutingResetsAt,
  );
  const setScheduledSendDraft = useChatStore((s) => s.setScheduledSendDraft);
  const automationsActivities = useAutomationsStore((s) => s.activities);
  const createAutomationActivity = useAutomationsStore((s) => s.createActivity);
  const setUsageLimitBanner = useAiCreditsBannerStore((s) => s.setUsageLimit);
  const setNoBillingSourceBanner = useAiCreditsBannerStore(
    (s) => s.setNoBillingSource,
  );
  const refreshProviderUsageSnapshot = useObservabilityStore(
    (s) => s.refreshProviderUsageSnapshot,
  );
  const slashCommandTarget = useMemo(() => {
    if (targetOverride) {
      return {
        projectId: targetOverride.projectId,
        worktreeId: targetOverride.worktreeId,
      };
    }
    return selectedWorktree;
  }, [selectedWorktree, targetOverride]);
  const watcherDestination = useMemo(() => {
    if (!tabId) return null;
    if (targetOverride) return targetOverride;
    if (!selectedWorktree) return null;
    // Cowork chats have no watcher destination — EXCEPT App Advisor, whose
    // entry-keyed chats are the primary watcher recipients.
    if (
      isCoworkChatTarget(selectedWorktree.projectId) &&
      selectedWorktree.projectId !== APP_ADVISOR_PROJECT_ID
    ) {
      return null;
    }
    const worktreeChat =
      useChatStore.getState().worktreeChats[
        `${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`
      ];
    if (!worktreeChat?.tabs.some((candidate) => candidate.id === tabId)) {
      return null;
    }
    return {
      projectId: selectedWorktree.projectId,
      worktreeId: selectedWorktree.worktreeId,
      chatId: tabId,
    };
  }, [selectedWorktree, tabId, targetOverride, useChatStore]);
  const chatInputWatchers = useAppAdvisorWatchersStore(
    useShallow((s) => {
      if (!watcherDestination) return [];
      return watchersForSubscriberDestination(s.watchers, watcherDestination);
    }),
  );

  useEffect(() => {
    const unsubscribe = useAppAdvisorWatchersStore.getState().subscribeBridge();
    const watchersStore = useAppAdvisorWatchersStore.getState();
    if (!watchersStore.hydrated && !watchersStore.loading) {
      void watchersStore.hydrate();
    }
    return unsubscribe;
  }, []);

  // Own the automations store from the chat surface so the usage-limit banner's
  // idempotency check and scheduled-message rows work without ever opening the
  // Automations page. `subscribeBridge` is safe to mount from multiple
  // components; the hydrated/loading guard avoids a duplicate initial list().
  useEffect(() => {
    const store = useAutomationsStore.getState();
    const unsubscribe = store.subscribeBridge();
    if (!store.hydrated && !store.loading) {
      void store.hydrate();
    }
    return unsubscribe;
  }, []);

  // Focus the editor whenever the selected worktree or active tab changes so
  // the user can start typing immediately after clicking a worktree in the
  // sidebar or creating/switching tabs.
  const worktreeKey = selectedWorktree
    ? `${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`
    : null;
  useEffect(() => {
    if (!worktreeKey) {
      return;
    }

    // Defer focus until after Slate has rendered its DOM nodes
    const animationFrameId = requestAnimationFrame(() => {
      if (!isComposerVisible() || editingState?.autoFocus === false) return;
      focusEditor(editor);
    });

    return (): void => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [
    worktreeKey,
    tab?.id,
    editor,
    isComposerVisible,
    editingState?.autoFocus,
  ]);

  useEffect(() => {
    const handler = (): void => {
      if (!isComposerVisible()) return;
      requestAnimationFrame(() => {
        focusEditor(editor);
      });
    };
    document.addEventListener('canopy:focus-chat-input', handler);
    return (): void => {
      document.removeEventListener('canopy:focus-chat-input', handler);
    };
  }, [editor, isComposerVisible]);

  // Listen for external file-reference insertion requests (e.g. @ mentions
  // from the workspace-item activity cards). The event carries
  // `detail.{displayPath, absolutePath, repoName?, kind?}` which are used to
  // insert a FileReferenceElement pill at the end of the current editor
  // content. `kind` tags note/prompt/attachment mentions for send-time
  // handling (prompt expansion).
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (
        e as CustomEvent<{
          displayPath: string;
          absolutePath: string;
          repoName?: string;
          kind?: string;
        }>
      ).detail;
      if (!detail?.displayPath) return;
      if (!isComposerVisible()) return;

      const end = Editor.end(editor, []);
      Transforms.select(editor, end);

      const node: FileReferenceElement = {
        type: 'file-reference',
        displayPath: detail.displayPath,
        absolutePath: detail.absolutePath,
        ...(detail.repoName ? { repoName: detail.repoName } : {}),
        ...(detail.kind ? { kind: detail.kind } : {}),
        children: [{ text: '' }],
      };
      Transforms.insertNodes(editor, node);
      Transforms.move(editor);
      Transforms.insertText(editor, ' ');

      setValue([...editor.children]);
      focusEditor(editor);
    };
    document.addEventListener('canopy:insert-file-reference', handler);
    return (): void => {
      document.removeEventListener('canopy:insert-file-reference', handler);
    };
  }, [editor, isComposerVisible]);

  // Listen for external plain-text insertion requests (for example file and
  // terminal selection toolbars). Targeted file requests route by chat tab;
  // untargeted terminal requests retain visible-composer-only behavior. Text
  // is appended with a blank line so selection blocks remain readable.
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<InsertChatTextDetail>).detail;
      const text = detail?.text;
      if (!text) return;
      const composerVisible = isComposerVisible();
      if (
        !shouldHandleChatTextInsertion(
          detail,
          tabId,
          composerVisible,
          isEditingQueued,
        )
      ) {
        return;
      }

      const end = Editor.end(editor, []);
      Transforms.select(editor, end);

      const hasContent = SlateNode.string(editor).trim().length > 0;
      const prefix = hasContent ? '\n\n' : '';
      Transforms.insertText(editor, `${prefix}${text}`);

      setValue([...editor.children]);
      detail.markHandled?.();
      if (composerVisible) {
        focusEditor(editor);
      }

      // The composer is `max-h-[200px] overflow-y-auto`; after appending a
      // chunk longer than that, the new text lives below the fold. Scroll
      // its scrollable ancestor to the bottom on the next frame so the user
      // can immediately see what was added.
      if (!composerVisible) return;
      requestAnimationFrame(() => {
        const editable = document.querySelector('[data-chat-textarea]');
        let scroller = editable?.parentElement ?? null;
        while (scroller && scroller !== document.body) {
          const style = window.getComputedStyle(scroller);
          if (
            (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            scroller.scrollHeight > scroller.clientHeight
          ) {
            scroller.scrollTop = scroller.scrollHeight;
            return;
          }
          scroller = scroller.parentElement;
        }
      });
    };
    document.addEventListener(INSERT_CHAT_TEXT_EVENT, handler);
    return (): void => {
      document.removeEventListener(INSERT_CHAT_TEXT_EVENT, handler);
    };
  }, [editor, isComposerVisible, isEditingQueued, tabId]);

  const canUsePlanMode = Boolean(
    !hidePlanMode &&
    selectedWorktree &&
    !isCoworkChatTarget(selectedWorktree.projectId),
  );
  const planMode = canUsePlanMode ? (tab?.planMode ?? false) : false;
  // Unlike plan mode, the approval-mode picker is available on every chat
  // surface, including cowork — Codex/Claude tool-approval prompts apply
  // there too.
  const approvalModeTarget = useMemo(() => {
    if (targetOverride) return targetOverride;
    if (!selectedWorktree || !tabId) return undefined;
    return {
      projectId: selectedWorktree.projectId,
      worktreeId: selectedWorktree.worktreeId,
      chatId: tabId,
    };
  }, [selectedWorktree, tabId, targetOverride]);
  const approvalDefaultForProject = useChatStore((s) => {
    const projectId =
      approvalModeTarget?.projectId ?? selectedWorktree?.projectId;
    const worktreeId =
      approvalModeTarget?.worktreeId ?? selectedWorktree?.worktreeId;
    return projectId
      ? s.approvalDefaultsCache[approvalDefaultCacheKey(projectId, worktreeId)]
      : undefined;
  });
  const approvalDefaultsGeneration = useSyncExternalStore(
    subscribeApprovalDefaultsGeneration,
    getApprovalDefaultsGeneration,
    getApprovalDefaultsGeneration,
  );
  const [approvalDefaultLookupResult, setApprovalDefaultLookupResult] =
    useState<{
      cacheKey: string;
      generation: number;
      mode: ApprovalMode;
    } | null>(null);
  const approvalDefaultTargetKey = approvalModeTarget
    ? approvalDefaultCacheKey(
        approvalModeTarget.projectId,
        approvalModeTarget.worktreeId,
      )
    : undefined;
  const settledApprovalDefault =
    approvalDefaultLookupResult?.cacheKey === approvalDefaultTargetKey &&
    approvalDefaultLookupResult?.generation === approvalDefaultsGeneration
      ? approvalDefaultLookupResult?.mode
      : undefined;

  useEffect(() => {
    if (!approvalModeTarget || tab?.approvalMode !== undefined) return;
    const cacheKey = approvalDefaultCacheKey(
      approvalModeTarget.projectId,
      approvalModeTarget.worktreeId,
    );
    if (cacheKey in useChatStore.getState().approvalDefaultsCache) return;
    let active = true;
    void useChatStore
      .getState()
      .fetchApprovalDefault(
        approvalModeTarget.projectId,
        approvalModeTarget.worktreeId,
      )
      .then((mode): void => {
        if (
          !active ||
          approvalDefaultsGeneration !== getApprovalDefaultsGeneration()
        ) {
          return;
        }
        setApprovalDefaultLookupResult({
          cacheKey,
          generation: approvalDefaultsGeneration,
          mode,
        });
      });
    return (): void => {
      active = false;
    };
  }, [
    approvalDefaultForProject,
    approvalDefaultsGeneration,
    approvalModeTarget,
    tab?.approvalMode,
  ]);
  // Display-only fallback for the brief window before the tab's stamped mode
  // or the cached surface default resolves. Derived from the single shared
  // product default so it cannot drift.
  //
  // It tracks the PRODUCT default, not what main will necessarily enforce: on
  // a degraded preferences read main fails closed to Ask while this still
  // shows Full Access, so the capsule can briefly read more permissive than
  // reality. That direction is deliberate — the send itself always goes
  // through main's fail-closed resolver, and flashing a stricter mode on every
  // normal open would be the more misleading of the two (CAN-3055).
  const approvalMode: ApprovalMode =
    tab?.approvalMode ??
    approvalDefaultForProject ??
    settledApprovalDefault ??
    DEFAULT_APPROVAL_DEFAULTS.worktree;
  const handleApprovalModeChange = useCallback(
    (mode: ApprovalMode): void => {
      void setTabApprovalMode(approvalModeTarget, mode).catch(() => {
        addToast('Failed to change approval mode.', 'error');
      });
    },
    [addToast, approvalModeTarget, setTabApprovalMode],
  );
  const thinkingLevel = tab?.thinkingLevel ?? 'high';
  const model = tab?.model;
  const fallbackModel = useChatStore(
    useShallow((s) => {
      if (tab?.model) {
        return tab.model;
      }

      const selection = targetOverride
        ? {
            projectId: targetOverride.projectId,
            worktreeId: targetOverride.worktreeId,
          }
        : s.selectedWorktree;
      if (!selection || !s.modelDefaults) {
        return DEFAULT_MODEL;
      }

      const isStandalone = isCoworkChatTarget(selection.projectId);
      const resolved = isStandalone
        ? resolveOverallDefault(
            s.modelDefaults.chatModelByProvider,
            s.modelDefaults.chatProvider,
          )
        : resolveOverallDefault(
            s.modelDefaults.worktreeModelByProvider,
            s.modelDefaults.worktreeProvider,
          );
      return resolved.model ?? DEFAULT_MODEL;
    }),
  );
  const selectedGatewayOrganizationId = resolveOrgGatewayOrganizationId(
    model ?? fallbackModel,
  );
  const providerType = tab?.providerType;
  const readOnly = tab?.readOnly ?? false;
  const staleSessionDetected = tab?.staleSessionDetected;
  const pluginSelections = tab?.pluginSelections;
  const tabDisabledGlobalPluginSelections = tab?.disabledGlobalPluginSelections;
  // A chat written before project defaults were live keeps its own selection
  // and inherits no project layer until main normalizes it.
  const tabInheritsProjectDefaults = chatInheritsProjectDefaults(
    tab ?? undefined,
  );
  // Worktree and cowork chats inherit project and global default plugins;
  // purpose-built surfaces keep only their explicit selections.
  const overlayProjectId =
    targetOverride?.projectId ?? selectedWorktree?.projectId;
  const overlayWorktreeId =
    targetOverride?.worktreeId ?? selectedWorktree?.worktreeId;
  const globalOverlayEligible =
    overlayProjectId !== undefined &&
    chatSurfaceUsesGlobalPluginDefaults(overlayProjectId);
  const globalPluginDefaults = useGlobalPluginDefaultsStore((state) =>
    globalOverlayEligible && state.hydrated ? state.selections : undefined,
  );
  const scopedProjectPluginDefaults = useChatStore((state) =>
    globalOverlayEligible && overlayWorktreeId !== undefined
      ? state.worktreeDefaultPlugins[`${overlayProjectId}/${overlayWorktreeId}`]
      : undefined,
  );
  const workspaceProjectPluginDefaults = useProjectsStore((state) =>
    globalOverlayEligible
      ? state.projects.find((project) => project.id === overlayProjectId)
          ?.defaultPluginSelections
      : undefined,
  );
  const projectPluginTombstones = useProjectsStore((state) =>
    globalOverlayEligible
      ? state.projects.find((project) => project.id === overlayProjectId)
          ?.disabledGlobalPluginSelections
      : undefined,
  );
  const projectPluginDefaults = useMemo(() => {
    const layer = tabInheritsProjectDefaults
      ? (scopedProjectPluginDefaults ?? workspaceProjectPluginDefaults)
      : undefined;
    return layer ? normalizePluginSelections(layer) : undefined;
  }, [
    scopedProjectPluginDefaults,
    tabInheritsProjectDefaults,
    workspaceProjectPluginDefaults,
  ]);
  const agentPluginSelections = useModelCatalogStore(
    useShallow((state) =>
      model
        ? state.snapshot?.agents?.find(
            (entry) => entry.id === getAgentModelSelectionId(model),
          )?.pluginSelections
        : undefined,
    ),
  );
  const previousAgentPluginSelectionsRef = useRef(agentPluginSelections);
  const displayedPluginSelections = useMemo(
    () =>
      globalPluginDefaults || projectPluginDefaults
        ? effectiveChatPluginSelections({
            local: pluginSelections,
            projectDefaults: projectPluginDefaults,
            global: globalPluginDefaults,
            projectTombstones: projectPluginTombstones,
            chatTombstones: tabDisabledGlobalPluginSelections,
          })
        : pluginSelections,
    [
      globalPluginDefaults,
      pluginSelections,
      projectPluginDefaults,
      projectPluginTombstones,
      tabDisabledGlobalPluginSelections,
    ],
  );
  const effectivePluginSelections = useMemo(
    () =>
      mergeAgentChatPluginSelections(
        displayedPluginSelections,
        agentPluginSelections,
      ),
    [agentPluginSelections, displayedPluginSelections],
  );
  const tabUsage = tab?.usage;
  const lastEventAt = tab?.lastEventAt;
  const tabDiscovery = tab?.discovery;
  const trackedPlanId = tab?.trackedPlanId;
  // This composer's chat in the composer's worktree. Its selectors run only
  // when this chat's tab changes, never for another chat's commit.
  const composerScope = targetOverride ?? selectedWorktree;
  const composerChatTarget: ChatRenderTarget | null =
    composerScope && tab
      ? {
          projectId: composerScope.projectId,
          worktreeId: composerScope.worktreeId,
          chatId: tab.id,
        }
      : null;
  const hasComposerChatId = !!tab?.id;
  const trackedPlanReviewStatus = useChatTabRenderState(
    composerChatTarget,
    ({ tab: storeTab }) =>
      hasComposerChatId ? storeTab?.trackedPlanReviewStatus : undefined,
  );
  const lockedProvider = tab?.lockedProvider;
  const lockedHarness = tab?.lockedHarness;
  const draftExecutionHarness = useChatTabRenderState(
    composerChatTarget,
    ({ tab: storeTab }) =>
      hasComposerChatId ? storeTab?.executionHarness : undefined,
  );
  const composerProjectId =
    targetOverride?.projectId ?? selectedWorktree?.projectId;
  const composerWorktreeId =
    targetOverride?.worktreeId ?? selectedWorktree?.worktreeId;
  const { questions: composerQuestions, onDeliveryChange } =
    useComposerQuestions(
      tab?.id,
      composerProjectId,
      composerWorktreeId,
      !isEditingQueued && !readOnly,
    );
  // An unanswered ask-user card leaves the tab at `'idle'` with a paused timer,
  // so the row-enable decision cannot see it from tab state alone. Subscribed
  // as a boolean rather than the map so the composer only re-renders when the
  // answer actually lands.
  const hasUnansweredQuestion = useChatStore((s) =>
    tab?.id === undefined ||
    composerProjectId === undefined ||
    composerWorktreeId === undefined
      ? false
      : hasPendingQuestionForChat(
          s.pendingQuestions,
          composerProjectId,
          composerWorktreeId,
          tab.id,
        ),
  );
  // Claude and Codex are the only continuable harnesses, so a locked chat has
  // exactly one cross-harness target.
  const continueTargetProvider: AgentProviderType | undefined =
    lockedProvider === 'claude'
      ? 'codex'
      : lockedProvider === 'codex'
        ? 'claude'
        : undefined;
  const continueEligibility = useMemo(() => {
    if (!continueTargetProvider) return undefined;
    // `lockedProvider` already encodes "this tab has conversation state", which
    // is the only thing `getLockedProvider` reads `messages` for.
    return canContinueOnOtherHarness(
      {
        messages: { length: 1 },
        // The existing active-composer selector projects only the count. This
        // keeps queued turns live without adding another store subscription and
        // tab scan to every mounted composer.
        queuedMessages: { length: tab?.queuedMessageCount ?? 0 },
        providerType: lockedProvider,
        ...(tab?.readOnly ? { readOnly: true } : {}),
        ...(tab?.status ? { status: tab.status } : {}),
        ...(tab?.interfaceMode ? { interfaceMode: tab.interfaceMode } : {}),
        ...(tab?.pendingPlanExit
          ? { pendingPlanExit: tab.pendingPlanExit }
          : {}),
        ...(hasUnansweredQuestion ? { hasUnansweredQuestion: true } : {}),
      },
      continueTargetProvider,
      composerProjectId,
    );
  }, [
    composerProjectId,
    continueTargetProvider,
    hasUnansweredQuestion,
    lockedProvider,
    tab?.interfaceMode,
    tab?.pendingPlanExit,
    tab?.queuedMessageCount,
    tab?.readOnly,
    tab?.status,
  ]);
  // Bind the pending continue to the chat it was opened FOR, not to whatever
  // chat happens to be active at confirm time. Not every surface remounts the
  // composer on a chat switch: Plan Explore and Pipeline Assistant render a
  // clickable `ChatTabBar` above a single unkeyed `ChatContent`, so switching
  // there is a prop change and this component (and its state) survives it.
  const [continuePick, setContinuePick] = useState<
    | { tabId: string; model: ChatModel; billingFramework?: BillingFramework }
    | undefined
  >(undefined);
  const [continueBusy, setContinueBusy] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);

  // Only honor the pending pick while its own chat is still the active one.
  const continueTargetModel =
    continuePick !== undefined && continuePick.tabId === tab?.id
      ? continuePick.model
      : undefined;

  // Owner of the work this composer bills (CAN-3463). AI Credits spill only
  // onto that owner's organization pool, so every credits read on this surface
  // (picker gating, Auto, banners, recovery) asks about this chat, not about
  // whichever org happens to be funded.
  const creditsProjectId =
    targetOverride?.projectId ?? selectedWorktree?.projectId;
  const creditsWorktreeId =
    targetOverride?.worktreeId ?? selectedWorktree?.worktreeId;
  const creditsChatId = targetOverride?.chatId ?? tabId;
  const creditsScope = useMemo(
    () =>
      chatAiCreditsScope(creditsProjectId, creditsWorktreeId, creditsChatId),
    [creditsProjectId, creditsWorktreeId, creditsChatId],
  );
  const autoRouting = useAutoModelRoutingAvailability(creditsScope);
  const autoRoutingProjectId =
    targetOverride?.projectId ?? selectedWorktree?.projectId;
  /**
   * Auto covers interactive chats only. The App Advisor, Pipeline Editor,
   * plan-explore, and code-review surfaces are Canopy-owned assistants with
   * their own model contracts — routing them per turn is explicitly out of
   * scope for V1, and main refuses to route them regardless.
   */
  const autoRoutingSurfaceEligible =
    autoRouting.offered &&
    tab !== null &&
    autoRoutingProjectId !== undefined &&
    autoRoutingProjectId !== APP_ADVISOR_PROJECT_ID &&
    autoRoutingProjectId !== PIPELINE_EDITOR_PROJECT_ID &&
    autoRoutingProjectId !== PLAN_EXPLORE_CHAT_PROJECT_ID &&
    autoRoutingProjectId !== CODE_REVIEW_CHAT_PROJECT_ID;
  const autoSelected = tab?.modelSelectionMode === 'auto';
  const handleSelectAuto = useCallback((): void => {
    void setModelSelectionMode('auto', targetOverride);
  }, [setModelSelectionMode, targetOverride]);
  const autoPickerOption = useMemo(() => {
    if (!autoRoutingSurfaceEligible) return undefined;
    return {
      selected: autoSelected,
      onSelect: handleSelectAuto,
      ...(autoRouting.unavailableReason
        ? { unavailableReason: autoRouting.unavailableReason }
        : {}),
      ...(autoRouting.unavailableAction
        ? { unavailableAction: autoRouting.unavailableAction }
        : {}),
    };
  }, [
    autoRouting.unavailableAction,
    autoRouting.unavailableReason,
    autoRoutingSurfaceEligible,
    autoSelected,
    handleSelectAuto,
  ]);

  const handleModelChange = useCallback(
    (
      nextModel: ChatModel,
      billingFramework?: BillingFramework,
      executionHarness?: ModelHarness,
    ): void => {
      // A pick from the other harness never reaches `setModel` (the main
      // process would refuse it anyway). It opens the continue dialog, which
      // creates a NEW chat on the target provider instead.
      // Match the dialog's own target rather than "anything but the locked
      // provider", so a row outside the continuable pair can never open a dialog
      // that names a provider the pick is not for.
      const sourceTabId = tab?.id;
      if (
        sourceTabId &&
        lockedProvider &&
        continueEligibility?.ok === true &&
        (executionHarness ??
          pickProvider(
            nextModel,
            chatDefaultModel(
              (targetOverride ?? selectedWorktree)?.projectId,
              useChatStore.getState().modelDefaults,
            ),
          )) === continueTargetProvider
      ) {
        setContinueError(null);
        setContinuePick({
          tabId: sourceTabId,
          model: nextModel,
          ...(billingFramework ? { billingFramework } : {}),
        });
        return;
      }
      // Picking a concrete model IS the exit from Auto (plan Key Decisions).
      // Cleared here as well as in main so the chip stops reading `Auto`
      // on the same frame as the pick rather than after the canonical patch
      // round-trips.
      void setModelSelectionMode('manual', targetOverride);
      if (billingFramework || executionHarness) {
        void setModelAndWait(
          nextModel,
          targetOverride,
          executionHarness,
          billingFramework,
        );
      } else {
        setModel(nextModel, targetOverride);
      }
    },
    [
      continueEligibility,
      continueTargetProvider,
      lockedProvider,
      setModel,
      setModelAndWait,
      setModelSelectionMode,
      tab?.id,
      targetOverride,
      selectedWorktree,
      useChatStore,
    ],
  );

  /**
   * `handleModelChange`, but it reports whether the change actually LANDED.
   *
   * Used only by the recovery flow, which closes a modal on the strength of
   * this call. `setModel` is fire-and-forget and main refuses a cross-provider
   * change on a locked chat, so the ordinary path cannot tell a landed change
   * from a dropped one — and closing the modal over a dropped one is the exact
   * silent dead end CAN-2349 exists to remove. `setModelAndWait` surfaces
   * main's `accepted` answer, which is authoritative for the ORIGINATING chat
   * regardless of which chat the picker is rendering by then.
   *
   * Opening the continue dialog counts as landed: the user gets a visible
   * surface that carries the pick forward, which is the opposite of a silent
   * drop even though no model changed on THIS chat.
   */
  const handleRecoveryCommit = useCallback(
    async (
      nextModel: ChatModel,
      billingFramework?: BillingFramework,
    ): Promise<boolean> => {
      const sourceTabId = tab?.id;
      if (
        sourceTabId &&
        lockedProvider &&
        continueEligibility?.ok === true &&
        pickProvider(
          nextModel,
          chatDefaultModel(
            (targetOverride ?? selectedWorktree)?.projectId,
            useChatStore.getState().modelDefaults,
          ),
        ) === continueTargetProvider
      ) {
        setContinueError(null);
        setContinuePick({
          tabId: sourceTabId,
          model: nextModel,
          ...(billingFramework ? { billingFramework } : {}),
        });
        return true;
      }
      // Resolve a CONCRETE target where we can prove one, so a chat switch
      // during an in-flight recovery cannot land the commit on whatever chat is
      // active by then — the cross-chat leak `recoveryModelChangeRef` and
      // `recoveryChatKey` exist to prevent.
      //
      // The MEMBERSHIP CHECK is load-bearing, not defensive. `selectedWorktree`
      // comes from the store while `sourceTabId` comes from the `tab` prop, and
      // those two can describe different chats: `PanelContentRoot` mounts
      // several layout keys, each with its own `PanelWorktreeContext`, so a
      // composer without `targetOverride` (`QueuedMessageEditor` renders one)
      // can belong to worktree A while the store's selection is B. Composing
      // `{B, tabOfA}` unchecked yields a target `getWorktreeChatContext`
      // resolves to B with `activeTab: undefined` — it does NOT bail — and
      // `changeModel` then reports success for a chat that does not exist,
      // closing the modal over a commit that landed nowhere. Falling back to
      // `undefined` restores the previous behavior, which at least always names
      // a real chat. Mirrors `watcherDestination` above.
      const target = ((): typeof targetOverride => {
        if (targetOverride) return targetOverride;
        if (!sourceTabId || !selectedWorktree) return undefined;
        const worktreeChat =
          useChatStore.getState().worktreeChats[
            `${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`
          ];
        return worktreeChat?.tabs.some(
          (candidate) => candidate.id === sourceTabId,
        )
          ? {
              projectId: selectedWorktree.projectId,
              worktreeId: selectedWorktree.worktreeId,
              chatId: sourceTabId,
            }
          : undefined;
      })();
      return billingFramework
        ? setModelAndWait(nextModel, target, undefined, billingFramework)
        : setModelAndWait(nextModel, target);
    },
    [
      continueEligibility,
      continueTargetProvider,
      lockedProvider,
      selectedWorktree,
      setModelAndWait,
      tab?.id,
      targetOverride,
      useChatStore,
    ],
  );

  /**
   * CAN-2349 case H — a cross-harness row that can NEVER be continued (an
   * Ollama pair). There is no transient state to wait out, so the picker offers
   * a fresh chat instead of refusing. Seed the model through `createTab`'s
   * `CreateTabTarget`: `setModel(nextModel, targetOverride)` captures the OLD
   * `chatId` on panel-targeted composers, and an async change-model IPC would
   * therefore update the source tab (or no-op) rather than the tab just made.
   *
   * Deliberately does NOT touch the current chat's model — that is the whole
   * difference between this and an ordinary pick, and the reason the picker
   * cannot just call `onModelChange`.
   */
  const handleStartNewChatWithModel = useCallback(
    (nextModel: ChatModel, billingFramework?: BillingFramework): void => {
      const target = targetOverride
        ? {
            projectId: targetOverride.projectId,
            worktreeId: targetOverride.worktreeId,
          }
        : selectedWorktree;
      if (!target) return;
      if (billingFramework)
        useChatStore.getState().rememberBillingFramework(billingFramework);
      createTab({ ...target, model: nextModel, modelExplicitlyChosen: true });
    },
    [createTab, selectedWorktree, targetOverride],
  );
  /**
   * Whether case H can actually deliver a new chat.
   *
   * `ModelPicker` derives `canStartNewChat` from `onStartNewChat !== undefined`
   * and clears its pending recovery BEFORE invoking the handler, so offering
   * the affordance without a resolvable target would close the modal and do
   * nothing — a dead click, on the one recovery branch with no async surface to
   * report the failure through. Withholding the prop instead lets the gate fall
   * back to the hard-disabled reason, which at least explains itself.
   */
  const canStartNewChatWithModel = Boolean(targetOverride ?? selectedWorktree);
  const closeContinueDialog = useCallback((): void => {
    setContinuePick(undefined);
    setContinueError(null);
  }, []);

  // Identifies the continue operation currently allowed to own the dialog's
  // state. A run whose token has been retired must not touch `continuePick`,
  // `continueError` or `continueBusy` on its way out, because by then those
  // belong to a different chat.
  const continueRunIdRef = useRef(0);

  // Hiding the pick on a chat switch is not enough on a surface that preserves
  // this component across the switch (Plan Explore and Pipeline Assistant): the
  // pick would still be sitting there, so switching BACK would resurrect the
  // dialog — with a stale error attached — long after the user moved on. Drop
  // it instead.
  //
  // Retiring the in-flight run matters just as much, and clearing the pick
  // alone does not do it. `continueBusy` and the pending callback outlive the
  // switch, so a dialog opened on the next chat would render already-busy
  // (Confirm dead, Cancel disabled) and then be closed, or shown the previous
  // chat's error, whenever the old request finally settled.
  //
  // Keyed off an actual change in tab identity rather than a dependency list:
  // putting `continueBusy` in deps would re-run this when the spinner clears
  // and wipe the very `continueError` the dialog just set.
  const activeComposerTabId = tab?.id;
  const lastComposerTabIdRef = useRef(activeComposerTabId);
  useEffect(() => {
    if (lastComposerTabIdRef.current === activeComposerTabId) return;
    lastComposerTabIdRef.current = activeComposerTabId;
    continueRunIdRef.current += 1;
    setContinuePick(undefined);
    setContinueError(null);
    setContinueBusy(false);
  }, [activeComposerTabId]);

  const handleConfirmContinue = useCallback((): void => {
    if (continueBusy || continuePick === undefined) return;
    // Re-check at confirm time: if the active chat moved on, the dialog is
    // already hidden and confirming must not continue the newly-selected chat.
    if (continuePick.tabId !== tab?.id) {
      setContinuePick(undefined);
      setContinueError(null);
      return;
    }
    const { tabId, model, billingFramework } = continuePick;
    const runId = continueRunIdRef.current + 1;
    continueRunIdRef.current = runId;
    setContinueBusy(true);
    setContinueError(null);
    void (async (): Promise<void> => {
      try {
        const result = await continueTabOnProvider(
          tabId,
          model,
          targetOverride,
          ...(billingFramework ? [billingFramework] : []),
        );
        if (result.status === 'created' && billingFramework) {
          useChatStore.getState().rememberBillingFramework(billingFramework);
        }
        // A retired run still created (or failed to create) its chat in the
        // store — that part is done and correct. It just no longer owns this
        // dialog, so it reports nothing rather than reporting to the wrong one.
        if (continueRunIdRef.current !== runId) return;
        if (result.status === 'failed') {
          // Keep the dialog open so the user sees why nothing happened. The
          // store creates no tab on failure, so there is nothing to roll back.
          setContinueError(result.message);
          return;
        }
        setContinuePick(undefined);
      } catch (error: unknown) {
        // `continueTabOnProvider` converts expected failures into a `failed`
        // result, so reaching here means something unexpected threw. Without
        // this the dialog would just stop spinning and silently do nothing.
        if (continueRunIdRef.current !== runId) return;
        setContinueError(extractIpcErrorMessage(error));
      } finally {
        if (continueRunIdRef.current === runId) setContinueBusy(false);
      }
    })();
  }, [
    continueBusy,
    continuePick,
    continueTabOnProvider,
    tab?.id,
    targetOverride,
  ]);
  const providerAvailability = useProviderAvailability(creditsScope);
  const selectedRepoId = tab?.selectedRepoId;
  const hasStartedSession = tab?.hasStartedSession ?? false;

  const livePendingAttachments = useChatTabRenderState(
    composerChatTarget,
    useShallow(
      ({ tab: currentTab }): AttachmentMeta[] =>
        currentTab?.pendingAttachments ?? [],
    ),
  );
  const pendingAttachments: AttachmentMeta[] = editingState
    ? editingState.attachments
    : livePendingAttachments;

  // Editor selections staged on this tab (CAN-1250). Queued-message editing
  // has no selection chips — chips belong to the live composer only.
  const livePendingSelections = useChatStore((s) =>
    tabId !== undefined ? s.pendingEditorSelections[tabId] : undefined,
  );
  const pendingSelections = isEditingQueued
    ? NO_PENDING_SELECTIONS
    : (livePendingSelections ?? NO_PENDING_SELECTIONS);
  // The chips row owns the (provider-bound) freshness subscription and reports
  // the latest map here for send-time serialization.
  const selectionFreshnessRef = useRef<Record<string, SelectionFreshness>>({});
  const handleSelectionFreshnessChange = useCallback(
    (freshness: Record<string, SelectionFreshness>): void => {
      selectionFreshnessRef.current = freshness;
    },
    [],
  );

  const handleRevealSelection = useCallback(
    (selection: EditorSelectionContext): void => {
      // Passive reveal (chip focused): highlight the range in any editor that
      // currently shows the file, without opening tabs or stealing panels.
      const detail: RevealEditorRangeDetail = {
        absolutePath: selection.absolutePath,
        startLine: selection.startLine,
        startColumn: selection.startColumn,
        endLine: selection.endLine,
        endColumn: selection.endColumn,
      };
      document.dispatchEvent(
        new CustomEvent(REVEAL_EDITOR_RANGE_EVENT, { detail }),
      );
    },
    [],
  );

  const handleOpenSelection = useCallback(
    (selection: EditorSelectionContext): void => {
      // Full open (chip activated): stash the reveal so a newly mounted or
      // still-loading editor picks it up, then open/activate the file tab.
      const detail: RevealEditorRangeDetail = {
        absolutePath: selection.absolutePath,
        startLine: selection.startLine,
        startColumn: selection.startColumn,
        endLine: selection.endLine,
        endColumn: selection.endColumn,
      };
      stashPendingEditorRangeReveal(detail);
      document.dispatchEvent(
        new CustomEvent(REVEAL_EDITOR_RANGE_EVENT, { detail }),
      );
      useChatStore.getState().openFileTab({
        absolutePath: selection.absolutePath,
        filename:
          selection.displayPath.split('/').pop() ?? selection.displayPath,
      });
    },
    [useChatStore],
  );

  const handleRemoveSelection = useCallback(
    (selectionId: string): void => {
      if (tabId === undefined) return;
      useChatStore.getState().removePendingEditorSelection(tabId, selectionId);
    },
    [tabId, useChatStore],
  );

  const effectiveProviderType = useMemo(
    () => resolveEffectiveProviderType(model, providerType),
    [model, providerType],
  );
  // Match the provider key used by discovery requests. Ollama on Claude
  // retains its local endpoint even though its execution harness is Claude.
  const discoveryProviderType = resolveDiscoveryProviderType({
    model,
    providerType: effectiveProviderType,
    executionHarness: lockedHarness ?? draftExecutionHarness,
  });
  const isAccountHarness =
    effectiveProviderType === 'cursor' ||
    effectiveProviderType === 'copilot' ||
    effectiveProviderType === 'opencode';
  // The exact speed requested for this chat's next turn (never a claim about
  // the turn in flight); the legacy boolean never outranks it.
  const storedSpeed = tab ? tabRequestedCodexSpeed(tab) : 'standard';
  const supportsFastMode = effectiveProviderType
    ? modelConfigForProviderSupportsFastMode(effectiveProviderType)
    : false;
  // Thinking controls follow the captured (locked) or effective execution
  // harness — a Codex-harnessed gateway/Ollama model shows Codex effort
  // semantics — while billing, fast-mode, and source-specific affordances
  // keep following the model's source provider.
  const thinkingHarness = useThinkingHarness({
    lockedHarness,
    executionHarness: draftExecutionHarness,
    model,
    effectiveProviderType,
  });
  const isCodex = thinkingHarness === 'codex';
  const normalizedThinkingLevel = normalizeThinkingForUi(thinkingLevel);
  // Capability lookups must follow the billing route the session executes
  // on: an AI-Credits-routed chat displays and cycles the gateway-advertised
  // set, not the model's native tiers.
  const aiCreditsRouted = tab ? isTabAiCreditsRouted(tab) : false;
  const supportedThinkingLevels = getEffectiveSupportedThinkingLevelsForModel(
    model,
    aiCreditsRouted,
    effectiveProviderType ?? 'claude',
    thinkingHarness,
  );
  // Tiers the model does not support display as the nearest lower supported
  // tier (e.g. `ultra` on non-Ultra models) while the canonical stored value
  // is preserved until the user cycles. Gateway-advertised supported levels
  // are honored through the hydrated model registry.
  const displayThinkingLevel = normalizeThinkingForUi(
    clampThinkingLevelForModel(
      normalizedThinkingLevel,
      model,
      thinkingHarness,
      aiCreditsRouted,
      supportedThinkingLevels,
    ),
  );
  // Speed availability follows this chat's actual route: its model, Auto
  // routing, captured harness, and billing lane. Only Codex chats read it.
  const speedControl = useContextualCodexSpeedControl({
    enabled: supportsFastMode,
    context:
      tab && composerProjectId && composerWorktreeId
        ? {
            kind: 'chat',
            projectId: composerProjectId,
            worktreeId: composerWorktreeId,
            chatId: tab.id,
          }
        : null,
    revalidationKey: JSON.stringify([
      lockedHarness ?? draftExecutionHarness,
      tab?.aiCreditsRouting,
      tab?.subscriptionBillingOverride,
    ]),
    route: {
      model,
      auto: autoSelected,
      capturedHarness: lockedHarness ?? draftExecutionHarness,
      aiCreditsRouted,
    },
  });
  // A model that cannot run Ultra fast steps the chat down to Fast (or
  // Regular) rather than holding a choice its next turn would be refused.
  const requestedSpeed = useCodexSpeedDowngrade({
    enabled: supportsFastMode,
    speed: storedSpeed,
    control: speedControl,
    apply: (next): void => void setSpeed(next, targetOverride),
  });
  const nextSpeed = nextCodexSpeed(requestedSpeed, speedControl.states);
  // Speed applies to the next turn; an active turn is never interrupted.
  // Regular → Fast → Ultra fast, where the route offers it.
  const cycleSpeed = useCallback((): void => {
    void setSpeed(nextSpeed, targetOverride);
  }, [setSpeed, nextSpeed, targetOverride]);
  // Live session pending exit (from global store) or restored from persistence
  const pendingExit: PendingPlanExit | null = useMemo(() => {
    if (!tab) return null;
    // Prefer the live session entry (has a real requestId for IPC)
    const fromStore = Object.values(pendingPlanExits).find(
      (pe) => pe.chatId === tab.id,
    );
    if (fromStore) return fromStore;
    // Fall back to persisted tab field (post-restart, no live session)
    if (tab.pendingPlanExit) {
      return {
        requestId: tab.pendingPlanExitRequestId ?? '',
        projectId: selectedWorktree?.projectId ?? '',
        worktreeId: selectedWorktree?.worktreeId ?? '',
        chatId: tab.id,
        source:
          tab.pendingPlanExit.source === 'codex' ||
          tab.pendingPlanExit.source === 'cursor' ||
          tab.pendingPlanExit.source === 'opencode'
            ? tab.pendingPlanExit.source
            : 'claude',
        toolInput: tab.pendingPlanExit,
      };
    }
    return null;
  }, [pendingPlanExits, selectedWorktree, tab]);

  // A waiting plan turns the composer into the plan-approval prompt.
  // Closing it (x, Escape) keeps the plan waiting: Plan's chip beside
  // + then reads "Plan ready" and reopens it. The choice is per plan request,
  // so the next plan asks again.
  const planRequestKey =
    pendingExit === null
      ? null
      : `${pendingExit.chatId}:${pendingExit.requestId}`;
  const [closedPlanRequestKey, setClosedPlanRequestKey] = useState<
    string | null
  >(null);
  const planWaiting =
    !hidePlanMode && !isEditingQueued && planRequestKey !== null;
  const planCardOpen = planWaiting && closedPlanRequestKey !== planRequestKey;
  const planReady = planWaiting && !planCardOpen;

  // A waiting question turns the composer into the question prompt, as a
  // plan does. Closing it (x, Escape) keeps the question waiting: the
  // "Question" chip beside + then reopens it. A question asks before a plan.
  // App Advisor asks through its own store rather than the chat's MCP
  // questions: its composer takes the question its chat asked, and one whose
  // chat is not in this Work Entry (or names none), so a question is never
  // out of sight; it answers through that store.
  const isAppAdvisorComposer = composerProjectId === APP_ADVISOR_PROJECT_ID;
  const appAdvisorEntryTabIds = useChatStore(
    useShallow((s): string[] =>
      isAppAdvisorComposer
        ? (s.worktreeChats[
            `${composerProjectId}/${composerWorktreeId ?? ''}`
          ]?.tabs.map((entry) => entry.id) ?? [])
        : [],
    ),
  );
  const appAdvisorQuestion = useAppAdvisorStore((s) =>
    isAppAdvisorComposer && !isEditingQueued && !readOnly
      ? s.pendingQuestions.find(
          (entry) =>
            entry.chatId === undefined ||
            entry.chatId === tab?.id ||
            !appAdvisorEntryTabIds.includes(entry.chatId),
        )
      : undefined,
  );
  const appAdvisorPending = useMemo(
    (): ComposerPendingQuestion | undefined =>
      appAdvisorQuestion
        ? {
            requestId: appAdvisorQuestion.requestId,
            questions: [appAdvisorQuestion.question],
          }
        : undefined,
    [appAdvisorQuestion],
  );
  const appAdvisorDelivery = useMemo(
    (): ComposerQuestionDelivery | undefined =>
      isAppAdvisorComposer ? APP_ADVISOR_QUESTION_DELIVERY : undefined,
    [isAppAdvisorComposer],
  );
  const activeQuestion: ComposerPendingQuestion | undefined =
    appAdvisorPending ?? composerQuestions[0];
  const questionPrompt = useComposerQuestionPrompt(
    activeQuestion,
    onDeliveryChange,
    appAdvisorDelivery,
  );
  const [closedQuestionRequestId, setClosedQuestionRequestId] = useState<
    string | null
  >(null);
  const questionPromptOpen =
    activeQuestion !== undefined &&
    closedQuestionRequestId !== activeQuestion.requestId;
  const questionReady = activeQuestion !== undefined && !questionPromptOpen;
  /** The composer box is asking something: a question or a plan. */
  const promptOpen = questionPromptOpen || planCardOpen;
  const questionPromptPlaceholder = questionPrompt.prompt.acceptsText
    ? questionPrompt.prompt.kind === 'text'
      ? (questionPrompt.prompt.question.placeholder ?? 'Type your answer')
      : 'Or type your own answer'
    : 'Send a message instead';

  // Awaiting plan approval is treated as turn-ended (no cancel button, no spinner)
  const isStreaming = tab?.status === 'streaming' && !pendingExit;
  const handleCancelRunningChat = useCallback((): void => {
    void cancelSession(targetOverride);
  }, [cancelSession, targetOverride]);
  useCancelRunningChatShortcut({
    enabled: isStreaming,
    // Only the active panel owns document-level composer shortcuts. Keeping
    // this separate from `enabled` prevents panel-focus handoffs from
    // disarming a still-running chat's confirmation.
    active: composerShortcutsEnabled && !isEditingQueued,
    onCancel: handleCancelRunningChat,
    chatKey: cancelShortcutChatKey,
    ownerDocument: cancelShortcutOwnerDocument,
    targetRootRef: cancelShortcutTargetRootRef,
  });

  const stuckMinutes = useStuckAgentTimer(
    isStreaming && tab?.hasActiveAgentStep !== true,
    lastEventAt,
    tab?.id,
  );

  const resourceGuardBlock = useResourceMonitorStore(
    useShallow((s) => {
      const snapshot = s.snapshot;
      if (!snapshot || snapshot.guards.chatTurns.blocked !== true) {
        return null;
      }
      const { chatTurns } = snapshot.guards;
      const memoryCritical = snapshot.pressure.level === 'critical';
      return {
        reason: memoryCritical ? 'memory' : 'concurrency',
        maxConcurrentTurns: chatTurns.maxConcurrentTurns,
      };
    }),
  );
  const isResourceGuardBlocked = resourceGuardBlock !== null;
  // Follows the "Sending paused" title on the same line: the cause, then
  // what lifts it.
  const resourceGuardMessage: string | null = resourceGuardBlock
    ? resourceGuardBlock.reason === 'memory'
      ? 'Memory pressure is high, so sends resume when active work finishes.'
      : resourceGuardBlock.maxConcurrentTurns !== null
        ? `${brandText.appName} is at its limit of ${String(resourceGuardBlock.maxConcurrentTurns)} concurrent chat turn${resourceGuardBlock.maxConcurrentTurns === 1 ? '' : 's'}, so wait for one to finish before sending another.`
        : 'Sends resume when active work finishes.'
    : null;

  const [pluginsModalOpen, setPluginsModalOpen] = useState(false);
  // Inherited default layers (project, global, and the globals the project
  // turned off) frozen when the plugins modal opens: display and the
  // save-time split must use the same snapshot, or a defaults change landing
  // mid-modal would misclassify entries (an added default would look turned
  // off, a removed one would get pinned as local). `null` = the chat does not
  // inherit defaults.
  const [pluginsModalInheritedLayers, setPluginsModalInheritedLayers] =
    useState<InheritedPluginLayers | null>(null);
  const openPluginsModal = useCallback(async (): Promise<void> => {
    // Retries a failed startup hydration and waits before mounting the picker.
    // Opening against an unhydrated empty overlay would render globally
    // supplied plugins unchecked and make unchecking them a silent no-op.
    const hydrated = await useGlobalPluginDefaultsStore.getState().hydrate();
    const defaultsStore = useGlobalPluginDefaultsStore.getState();
    if (globalOverlayEligible && (!hydrated || !defaultsStore.hydrated)) {
      addToast(
        'Could not load global plugin defaults. Try opening Plugins again.',
        'error',
      );
      return;
    }
    const projectDefaults =
      overlayProjectId !== undefined &&
      overlayWorktreeId !== undefined &&
      tabInheritsProjectDefaults
        ? getProjectPluginDefaults(
            overlayProjectId,
            overlayWorktreeId,
            useChatStore.getState().worktreeDefaultPlugins,
          )
        : undefined;
    const projectTombstones =
      overlayProjectId !== undefined
        ? getProjectPluginTombstones(overlayProjectId)
        : undefined;
    setPluginsModalInheritedLayers(
      globalOverlayEligible
        ? {
            ...(projectDefaults
              ? { projectDefaults: normalizePluginSelections(projectDefaults) }
              : {}),
            ...(defaultsStore.hydrated
              ? { global: defaultsStore.selections }
              : {}),
            ...(projectTombstones ? { projectTombstones } : {}),
          }
        : null,
    );
    setPluginsModalOpen(true);
  }, [
    addToast,
    globalOverlayEligible,
    overlayProjectId,
    overlayWorktreeId,
    tabInheritsProjectDefaults,
  ]);
  const [linearPickerOpen, setLinearPickerOpen] = useState(false);
  const [pipelineModalOpen, setPipelineModalOpen] = useState(false);
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [pipelineRunError, setPipelineRunError] = useState<string | null>(null);
  const [handoffLoading, setHandoffLoading] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  const setPluginSelections = useChatStore((s) => s.setPluginSelections);

  const lockedSkillKeys = useMemo(
    () =>
      new Set(
        (lockedSkillRefs ?? []).map(
          (ref) => `${ref.sourceId}/${ref.skillName}`,
        ),
      ),
    [lockedSkillRefs],
  );
  const hasPluginSelections =
    (effectivePluginSelections?.collectionIds?.length ?? 0) > 0 ||
    (effectivePluginSelections?.bundleIds?.length ?? 0) > 0 ||
    (effectivePluginSelections?.skillRefs ?? []).some(
      (ref) => !lockedSkillKeys.has(`${ref.sourceId}/${ref.skillName}`),
    ) ||
    (effectivePluginSelections?.pluginRefs?.length ?? 0) > 0 ||
    (effectivePluginSelections?.mcpServerRefs?.length ?? 0) > 0;

  const composerPopupAnchorRef = useRef<HTMLSpanElement>(null);
  const plusTriggerRef = useRef<HTMLButtonElement>(null);

  const tabDiscoveryLoading = useChatStore((s) => s.tabDiscoveryLoading);
  const refreshWorktreeTabDiscoveries = useChatStore(
    (s) => s.refreshWorktreeTabDiscoveries,
  );
  useEffect(() => {
    const previousAgentPluginSelections =
      previousAgentPluginSelectionsRef.current;
    if (previousAgentPluginSelections === agentPluginSelections) return;
    if (!slashCommandTarget || !tab) return;
    previousAgentPluginSelectionsRef.current = agentPluginSelections;

    refreshWorktreeTabDiscoveries(
      slashCommandTarget.projectId,
      slashCommandTarget.worktreeId,
    );
  }, [
    agentPluginSelections,
    refreshWorktreeTabDiscoveries,
    slashCommandTarget,
    tab,
  ]);
  const projects = useProjectsStore((s) => s.projects);
  const discoveryLoading = useProjectsStore((s) => s.discoveryLoading);
  const fetchFileIndex = useFileListStore((s) => s.fetchFileIndex);

  const childRepos = useMemo(() => {
    if (!selectedWorktree) return [];
    const project = projects.find((p) => p.id === selectedWorktree.projectId);
    if (!project || project.type !== 'multi-repo') return [];
    return project.repos.map((repo) => ({ id: repo.id, name: repo.name }));
  }, [projects, selectedWorktree]);
  const isMultiRepo = childRepos.length > 0;

  const { allCommands, isRefreshing } = useMemo(() => {
    if (!slashCommandTarget || isAccountHarness)
      return { allCommands: [], isRefreshing: false };

    const project = projects.find((p) => p.id === slashCommandTarget.projectId);
    const worktree =
      project && project.type !== 'cowork'
        ? project.worktrees.find((w) => w.id === slashCommandTarget.worktreeId)
        : undefined;
    const slashCommands = selectDiscoverySlashCommands({
      providerType: discoveryProviderType,
      tabDiscovery,
      worktreeDiscovery: worktree?.discovery,
    });

    const commands = [...(slashCommands ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    // Check per-tab loading first, then worktree-level loading.
    const tabLoading = tab ? tabDiscoveryLoading.has(tab.id) : false;
    const wtKey = `${slashCommandTarget.projectId}/${slashCommandTarget.worktreeId}`;
    const refreshing = tabLoading || discoveryLoading.has(wtKey);

    return {
      allCommands: commands,
      isRefreshing: refreshing,
    };
  }, [
    slashCommandTarget,
    tab,
    tabDiscovery,
    projects,
    discoveryProviderType,
    isAccountHarness,
    tabDiscoveryLoading,
    discoveryLoading,
  ]);

  // Prebuilt invocable-inventory cache for the execution harness. Read-only;
  // the menu never scans skill/plugin folders on open.
  const inventoryProviderType = thinkingHarness;
  const invocableInventory = useInvocableInventory(inventoryProviderType);

  // Flatten the tab's selected Collections into their enabled skill/plugin refs
  // so already-enabled (via a Collection) inventory rows can be excluded. Loaded
  // through the renderer-accessible collection configs; no file parsing here.
  const collectionIdsKey = (
    effectivePluginSelections?.collectionIds ?? []
  ).join('\n');
  const [collectionEnabledRefs, setCollectionEnabledRefs] =
    useState<CollectionEnabledRefs>({ skillRefs: [], pluginRefs: [] });
  useEffect(() => {
    const ids = collectionIdsKey ? collectionIdsKey.split('\n') : [];
    if (ids.length === 0) {
      setCollectionEnabledRefs({ skillRefs: [], pluginRefs: [] });
      return;
    }
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const configs = await Promise.all(
          ids.map((id) =>
            window.collections.loadCollection(id).catch(() => null),
          ),
        );
        if (cancelled) return;
        setCollectionEnabledRefs(flattenCollectionRefs(configs));
      } catch {
        if (!cancelled) {
          setCollectionEnabledRefs({ skillRefs: [], pluginRefs: [] });
        }
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [collectionIdsKey]);

  // Merge discovered and cached inventory rows for every composer entry point.
  const { typeaheadCommands } = useMemo(() => {
    const {
      discoveredCommands,
      promotedInventoryCommands,
      availableInventoryCommands,
    } = buildSlashInventoryCommands({
      entries: invocableInventory.entries,
      discoveredCommands: allCommands,
      selections: effectivePluginSelections,
      collectionRefs: collectionEnabledRefs,
      isDiscovering: isRefreshing,
    });
    const typeahead: SlashCommandData[] = [
      ...discoveredCommands,
      ...promotedInventoryCommands,
      ...availableInventoryCommands,
    ];
    return {
      typeaheadCommands: typeahead,
    };
  }, [
    invocableInventory.entries,
    allCommands,
    effectivePluginSelections,
    collectionEnabledRefs,
    isRefreshing,
  ]);

  const serializedDraft = useMemo(() => serializeEditorValue(value), [value]);
  const mergedFileReferences = useMemo(
    () =>
      mergePromptAwareFileReferences(
        serializedDraft.fileReferences,
        extraFileReferences,
      ),
    [extraFileReferences, serializedDraft.fileReferences],
  );

  // Terminal mode: when the first non-whitespace character of the draft is `!`,
  // the composer switches into a "send the rest of the line as a shell command"
  // mode. Standalone-chat projects have no worktree-scoped terminal drawer to
  // send the command into, so the mode is gated on a real worktree. The shared
  // hook parses the command and owns the send's error/reset behavior; the run
  // itself is wired below, once the terminal target is known.
  const terminalModeEnabled =
    !disableTerminalMode &&
    selectedWorktree !== null &&
    selectedWorktree !== undefined &&
    !isCoworkChatTarget(selectedWorktree.projectId) &&
    !readOnly;
  const runTerminalCommandRef = useRef<(command: string) => Promise<void>>(() =>
    Promise.reject(new Error('Terminal mode is not ready')),
  );
  const terminalCommandSentRef = useRef<() => void>(() => undefined);
  const runInTerminal = useCallback(
    (command: string): Promise<void> => runTerminalCommandRef.current(command),
    [],
  );
  const handleTerminalCommandSent = useCallback(
    (): void => terminalCommandSentRef.current(),
    [],
  );
  const terminalMode = useTerminalComposerMode({
    draftText: serializedDraft.text,
    enabled: terminalModeEnabled,
    runInTerminal,
    onSent: handleTerminalCommandSent,
  });
  const isTerminalMode = terminalMode.active;
  const terminalCommand = terminalMode.command;
  const composerCommands = useMemo(
    () =>
      buildComposerCommands(typeaheadCommands, {
        home: false,
        fast: supportsFastMode,
      }),
    [typeaheadCommands, supportsFastMode],
  );
  const slashTypeaheadEnabled = composerCommands.length > 0 || isRefreshing;

  const fileTypeaheadEnabled =
    Boolean(selectedWorktree) && !disableFileTypeahead;
  const fileListKey =
    fileTypeaheadEnabled && selectedWorktree
      ? getWorktreeCacheKey(
          selectedWorktree.projectId,
          selectedWorktree.worktreeId,
        )
      : null;
  const { fileIndexEntry, fileIndexLoading } = useFileListStore(
    useShallow((s) => ({
      fileIndexEntry: fileListKey ? s.indexCache[fileListKey] : undefined,
      fileIndexLoading: fileListKey ? s.indexLoading.has(fileListKey) : false,
    })),
  );
  const fileRepos = useMemo(
    () => fileIndexEntry?.data.repos ?? [],
    [fileIndexEntry],
  );

  // The `!` typeahead: approved repository scripts for the terminal-mode
  // draft. Selecting one only fills the box; the next Enter runs it.
  const replaceTerminalDraft = useCallback(
    (text: string): void => {
      messageHistoryNavigationRef.current = null;
      restoreEditorContent(editor, buildEditorValueFromMessage(text, []));
      setValue(structuredClone(editor.children));
      focusEditor(editor);
    },
    [editor],
  );
  const scriptTypeahead = useScriptTypeahead({
    available: terminalModeEnabled,
    terminalMode: isTerminalMode,
    projectId: slashCommandTarget?.projectId,
    worktreeId: slashCommandTarget?.worktreeId,
    selectedRepoId,
    multiRepo: fileRepos.length > 1,
    draftText: serializedDraft.text,
    caretOnFirstLine: caretOnFirstLine(editor.selection),
    replaceDraft: replaceTerminalDraft,
  });
  // Workspace items (notes/prompts/attachments) as extra `@` candidates.
  // Lazy-loaded per selection; prompt mentions expand at send time.
  // Scope to the composer's actual target: a `targetOverride` panel (cowork
  // work-entry chats and other embedded surfaces) may not match the globally
  // selected worktree, so prefer it just like `slashCommandTarget`. Without
  // this, cowork prompt @-mentions never expanded — the send-time
  // `expandPromptMentions` call keys off `mentionProjectId`, which was null/
  // mismatched for cowork panels and left the raw prompt path in the message.
  const mentionProjectId =
    targetOverride?.projectId ?? selectedWorktree?.projectId ?? null;
  const mentionWorktreeId =
    targetOverride?.worktreeId ?? selectedWorktree?.worktreeId ?? null;
  useEffect(() => {
    if (!fileTypeaheadEnabled || !mentionProjectId || !mentionWorktreeId) {
      return;
    }
    const store = useWorkspaceItemsStore.getState();
    void store.loadNotes(mentionProjectId);
    void store.loadPrompts(mentionProjectId);
    void store.loadAttachments(mentionProjectId, mentionWorktreeId);
  }, [fileTypeaheadEnabled, mentionProjectId, mentionWorktreeId]);
  const workspaceItemSources = useWorkspaceItemsStore(
    useShallow((s): WorkspaceItemMentionSources => {
      // Fallbacks must be the stable module-level empties: a fresh `[]` per
      // snapshot makes useShallow always see a change and loops the
      // useSyncExternalStore subscription (React max-update-depth crash).
      const attachmentsKey =
        mentionProjectId && mentionWorktreeId
          ? `${mentionProjectId}/${mentionWorktreeId}`
          : null;
      return {
        notes: mentionProjectId
          ? (s.notes[mentionProjectId] ?? EMPTY_NOTE_ITEMS)
          : EMPTY_NOTE_ITEMS,
        prompts: mentionProjectId
          ? (s.prompts[mentionProjectId] ?? EMPTY_PROMPT_ITEMS)
          : EMPTY_PROMPT_ITEMS,
        attachments: attachmentsKey
          ? (s.attachments[attachmentsKey] ?? EMPTY_ATTACHMENT_ITEMS)
          : EMPTY_ATTACHMENT_ITEMS,
      };
    }),
  );
  const workspaceItemSearch = useCallback(
    (query: string) => searchWorkspaceItemMentions(query, workspaceItemSources),
    [workspaceItemSources],
  );
  const composerMenu = useComposerMenu(editor, {
    enabled: !isTerminalMode && !readOnly,
    dollar: isCodex,
    // The scope is the composer's target only. A harness or provider switch
    // commits in main after the picker already reads the new model, so a `/`
    // typed in that window has Claude's rows open when the switch lands; the
    // rows re-project from `commands` for the new harness, whereas a scope
    // reset would dismiss the typed trigger and the menu would not return.
    scopeKey: `${slashCommandTarget?.projectId}/${slashCommandTarget?.worktreeId}/${tab?.id}`,
    onChange: () => setValue(structuredClone(editor.children)),
  });
  // The menu opened: list the inventory cache again so the backend can
  // re-check the inherited Cursor folders (home skills, the Cursor app's
  // plugin cache), which no Canopy mutation marks stale. Answered from the
  // cache; a change arrives as the usual inventory push.
  const composerMenuOpen = composerMenu.open;
  const reloadInvocableInventory = invocableInventory.reload;
  useEffect(() => {
    if (composerMenuOpen) void reloadInvocableInventory();
  }, [composerMenuOpen, reloadInvocableInventory]);
  const searchComposerFiles = useCallback(
    (query: string) =>
      fileTypeaheadEnabled
        ? [
            ...searchFileMentions(query, fileRepos, 50),
            ...workspaceItemSearch(query),
          ]
        : [],
    [fileTypeaheadEnabled, fileRepos, workspaceItemSearch],
  );
  const defaultChatPlaceholder = useMemo(
    () =>
      getDefaultChatPlaceholder({
        fileTypeaheadEnabled,
        slashTypeaheadEnabled,
      }),
    [fileTypeaheadEnabled, slashTypeaheadEnabled],
  );

  // -------------------------------------------------------------------------
  // Existing-session scheduled send + usage-limit resume
  // -------------------------------------------------------------------------

  // Genuine native persisted-chat target. Code worktree, Cowork, and App
  // Advisor composers all opt in explicitly when they render through a
  // `targetOverride`; embedded mirrors (pipeline editor, plan-explore, archived
  // transcripts) stay excluded. `workspaceId` in the automation action maps to
  // projectId for every supported context.
  const sessionChatTarget = useMemo<{
    projectId: string;
    worktreeId: string;
    chatId: string;
  } | null>(() => {
    if (editingState) return null;
    if (onSendMessage && !nativeSessionComposer) return null;
    if (targetOverride && !nativeSessionComposer) return null;
    const target = targetOverride
      ? targetOverride
      : tabId && selectedWorktree
        ? {
            projectId: selectedWorktree.projectId,
            worktreeId: selectedWorktree.worktreeId,
            chatId: tabId,
          }
        : null;
    if (!target) return null;
    const key = `${target.projectId}/${target.worktreeId}`;
    const wc = useChatStore.getState().worktreeChats[key];
    if (!wc?.tabs.some((candidate) => candidate.id === target.chatId)) {
      return null;
    }
    return target;
  }, [
    editingState,
    onSendMessage,
    targetOverride,
    nativeSessionComposer,
    tabId,
    selectedWorktree,
    useChatStore,
  ]);

  // Code-worktree-only actions remain scoped to real worktrees. Cowork and App
  // Advisor share scheduling, but do not gain worktree-specific plan detection
  // or the per-worktree "Just this time" routing override as a side effect.
  const worktreeChatTarget = useMemo(() => {
    if (!sessionChatTarget) return null;
    if (
      sessionChatTarget.projectId === APP_ADVISOR_PROJECT_ID &&
      sessionChatTarget.worktreeId === APP_ADVISOR_WORKTREE_ID
    ) {
      return null;
    }
    return isCoworkChatTarget(sessionChatTarget.projectId)
      ? null
      : sessionChatTarget;
  }, [sessionChatTarget]);

  // General chat target valid on EVERY surface (worktree, standalone, App
  // Advisor, pipeline editor, plan-explore). Unlike `worktreeChatTarget` this is
  // populated for `targetOverride` surfaces too, so shared banners keyed by
  // target (e.g. the AI Credits routing status) render everywhere (CAN-838).
  const modelDefaults = useChatStore((s) => s.modelDefaults);
  // CAN-1929 dead end: no (lane, model) pair is both payable and allowed by
  // org policy. Recomputed against `providerAvailability` because that is what
  // changes when the underlying lane facts settle — `resolveLaneForTarget`
  // itself reads the module-level runtime, not props.
  //
  // `resolveLaneForTarget` also reads module-level runtimes React cannot see —
  // the billing-lane availability written from an app-root effect, the policy
  // snapshot, and the model-registry/gateway-catalog hydration flags. None of
  // those move `providerAvailability` or `modelDefaults`, so the memo is
  // subscribed to their version counters as well; otherwise the banner stayed
  // stale through exactly the hydration that would have cleared it.
  //
  // The third argument is the same getter: these are module-level renderer
  // singletons with no server counterpart, and the static-markup render path
  // used by the component health tests requires it to be present.
  const laneFactsVersion = useSyncExternalStore(
    subscribeRendererBillingLaneFacts,
    getRendererBillingLaneFactsVersion,
    getRendererBillingLaneFactsVersion,
  );
  const modelFactsVersion = useSyncExternalStore(
    subscribeRendererModelFacts,
    getRendererModelFactsVersion,
    getRendererModelFactsVersion,
  );
  const noDispatchableModel = useMemo<{
    missing: 'billing-lane' | 'policy-allowance' | 'both';
    lanesNeeded: readonly BillingLane[];
    policyRestricted: boolean;
    hasPolicyAllowedLane: boolean;
  } | null>(() => {
    const projectId = targetOverride?.projectId ?? selectedWorktree?.projectId;
    if (!projectId) return null;
    const resolution = resolveLaneForTarget(
      projectId,
      useChatStore.getState().modelDefaults,
    );
    return resolution?.outcome === 'no-dispatchable-model'
      ? {
          missing: resolution.missing,
          lanesNeeded: resolution.lanesNeeded,
          hasPolicyAllowedLane: resolution.hasPolicyAllowedLane,
          // Whether an org model policy is ACTUALLY in force (CAN-2436).
          //
          // `missing` / `lanesNeeded` cannot answer this. The resolver derives
          // `lanesNeeded` from `policyAllowedLanes`, and a lane drops out of
          // that set either because policy blocked its candidates OR simply
          // because no candidate is runnable on it — a gateway-only default
          // leaves `['ai-credits']` with no org involved at all. The banner
          // uses that same shape to say "your organization only allows…", so
          // without this flag it invents an organization the user may not have.
          //
          // An empty policy set means no restriction: `isModelBlocked` tests
          // membership, so nothing is blocked and the dead end is about
          // billing, not allowance.
          policyRestricted: getRendererModelPolicy().size > 0,
        }
      : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    targetOverride,
    selectedWorktree,
    providerAvailability,
    modelDefaults,
    laneFactsVersion,
    modelFactsVersion,
  ]);
  // What an Agent that inherits the default would run on in this chat.
  const inheritedDefaultModel = useMemo((): ChatModel | undefined => {
    const projectId = targetOverride?.projectId ?? selectedWorktree?.projectId;
    return projectId
      ? resolveTabDefaults(projectId, modelDefaults).model
      : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    targetOverride,
    selectedWorktree,
    modelDefaults,
    laneFactsVersion,
    modelFactsVersion,
  ]);

  const bannerTarget = useMemo<ChatBannerTarget | null>(() => {
    if (editingState || (onSendMessage && !nativeSessionComposer)) return null;
    if (targetOverride) return targetOverride;
    if (!tabId || !selectedWorktree) return null;
    return {
      projectId: selectedWorktree.projectId,
      worktreeId: selectedWorktree.worktreeId,
      chatId: tabId,
    };
  }, [
    editingState,
    nativeSessionComposer,
    onSendMessage,
    targetOverride,
    tabId,
    selectedWorktree,
  ]);

  // Per-chat billing framework toggle for the model picker. Shown only when the
  // current model's provider has BOTH a native login and an AI Credits balance
  // (`nativeAuth && creditsEligible`); otherwise the single available framework
  // is chosen implicitly, exactly as before. The derived `value` prefers the
  // explicit per-tab bits, then falls back to the live routing-active signal so
  // the default is truthful when a global routing mode is silently routing.
  const billingRoutingActiveForChat = useAiCreditsRoutingActive(bannerTarget);
  const modelGatewayEnforced = useModelCatalogStore(
    (state) => state.modelGatewayEnforced,
  );
  const modelForBilling = model ?? fallbackModel;
  // A persisted model can disappear from the registry between launches. Keep
  // the composer renderable and prefer its persisted provider when available.
  const billingProvider =
    getProviderForModel(modelForBilling) ?? effectiveProviderType ?? 'claude';
  // Stored "just this time" routing stops after its reset time or a native
  // account change; main ignores it from then on, so the composer does too
  // (CAN-4200).
  const {
    inEffect: aiCreditsRoutingInEffect,
    accountChangedAt: billingAccountChangedAt,
  } = useEffectiveAiCreditsRouting(
    tab?.aiCreditsRouting,
    billingProvider === 'claude' || billingProvider === 'codex'
      ? billingProvider
      : undefined,
    bannerTarget,
  );
  // Which of the two "this turn cannot be paid for" banners owns the composer.
  // `OrgLapsedBanner` reports when it is speaking so `NoBillingSourceBanner`
  // stands down instead of stacking a purchase CTA on top of an explanation
  // that says to contact the org admin (CAN-2311 review round 3).
  const [orgLapseVisible, setOrgLapseVisible] = useState(false);
  // Single pure resolver drives BOTH the picker toggle and the AI Credits
  // banner, so they can never disagree. It locks the toggle (with a reason)
  // when only one billing framework is possible for this model + account, and
  // reports the effective framework plus `aiCreditsBannerVisible` — the
  // banner's own gate, deliberately narrower than `framework === 'ai-credits'`
  // because it also requires a native provider login. Applies streaming or idle.
  const billingResolution = useMemo<ChatBillingResolution>(
    () =>
      resolveChatBillingFramework({
        model: modelForBilling,
        provider: billingProvider,
        availability: providerAvailability[billingProvider],
        aiCreditsRoutingActive: aiCreditsRoutingInEffect,
        subscriptionBillingOverride: tab?.subscriptionBillingOverride ?? false,
        routingActiveForChat: billingRoutingActiveForChat,
        modelGatewayEnforced,
      }),
    [
      modelForBilling,
      billingProvider,
      providerAvailability,
      aiCreditsRoutingInEffect,
      tab?.subscriptionBillingOverride,
      billingRoutingActiveForChat,
      modelGatewayEnforced,
    ],
  );
  const billingControl = useMemo<
    | {
        value: 'subscription' | 'ai-credits';
        onChange: (framework: 'subscription' | 'ai-credits') => void;
        disabled?: boolean;
        lockedReason?: string;
        lockKind?: ChatBillingResolution['lockKind'];
        provider: AgentProviderType;
      }
    | undefined
  >(() => {
    if (!bannerTarget) return undefined;
    const { framework, toggleVisible, toggleDisabled, lockedReason, lockKind } =
      billingResolution;
    if (!toggleVisible || !framework) return undefined;
    const autoLaneLocked = autoSelected && hasStartedSession;
    return {
      value: framework,
      disabled: toggleDisabled || autoLaneLocked,
      provider: billingProvider,
      ...(autoLaneLocked
        ? { lockedReason: 'Start a new chat to change billing.' }
        : lockedReason
          ? { lockedReason }
          : {}),
      ...(lockKind ? { lockKind } : {}),
      onChange: (nextFramework): void => {
        selectBillingFramework(nextFramework, bannerTarget);
      },
    };
  }, [
    autoSelected,
    bannerTarget,
    billingProvider,
    billingResolution,
    hasStartedSession,
    selectBillingFramework,
  ]);

  // The routing card's "Switch to subscription" acts exactly like the picker's
  // subscription choice. Unlike the picker it ignores the Auto lane lock: a
  // started Auto chat's next turn runs on the subscription with its pinned
  // harness (CAN-4200).
  const handleSwitchToSubscription = useMemo(
    () =>
      bannerTarget &&
      billingResolution.toggleVisible &&
      !billingResolution.toggleDisabled
        ? (): void => selectBillingFramework('subscription', bannerTarget)
        : undefined,
    [
      bannerTarget,
      billingResolution.toggleDisabled,
      billingResolution.toggleVisible,
      selectBillingFramework,
    ],
  );

  useEffect(() => {
    if (!bannerTarget) return;
    const persistedBanner = tab?.llmProviderUsageLimitBanner;
    if (!persistedBanner) return;
    if (
      tab?.dismissedLlmProviderUsageLimitBannerKey ===
      persistedBanner.dismissKey
    ) {
      return;
    }
    setUsageLimitBanner(bannerTarget, {
      provider: persistedBanner.provider,
      ...(typeof persistedBanner.resetsAt === 'number'
        ? { resetsAt: persistedBanner.resetsAt }
        : {}),
    });
  }, [
    bannerTarget,
    setUsageLimitBanner,
    tab?.llmProviderUsageLimitBanner,
    tab?.dismissedLlmProviderUsageLimitBannerKey,
  ]);

  // Reload durability for the runtime no-billing-source banner (CAN-2413). The
  // live chat event is the primary path; this replays the per-tab flag the
  // transcript parser set, so a restart (or a tab hydrated from disk, or an E2E
  // seed) still shows the recovery banner instead of leaving a chat that cannot
  // send with no explanation above the composer.
  useEffect(() => {
    if (!bannerTarget) return;
    const persisted = tab?.aiCreditsNoBillingSource;
    if (!persisted) return;
    setNoBillingSourceBanner(bannerTarget, {
      provider: persisted.provider,
      detectedAt: persisted.detectedAt,
    });
  }, [bannerTarget, setNoBillingSourceBanner, tab?.aiCreditsNoBillingSource]);

  // Scheduled send + resume run through the Canopy composer: available for
  // native chats and `auto` terminal chats (the scheduled prompt is routed
  // into the managed terminal once its turn is idle). Hidden only for the
  // always-on `claude-code` terminal surface, which has no Canopy composer.
  // Account harnesses follow the shared workflow decision for their target.
  const workflowGateProjectId = (
    sessionChatTarget ??
    targetOverride ??
    selectedWorktree
  )?.projectId;
  const workflowGates = useMemo(
    () =>
      resolveComposerWorkflowGates({
        providerType: effectiveProviderType,
        interfaceMode: tab?.interfaceMode ?? 'canopy',
        projectId: workflowGateProjectId,
        capabilities: ipcCanopyClient.capabilities,
      }),
    [effectiveProviderType, tab?.interfaceMode, workflowGateProjectId],
  );
  const supportsScheduledSends = workflowGates.scheduledSends;

  const worktreeSessionNames = useMemo(() => {
    if (!sessionChatTarget) return null;
    const project = projects.find((p) => p.id === sessionChatTarget.projectId);
    const worktree =
      project && project.type !== 'cowork'
        ? project.worktrees.find((w) => w.id === sessionChatTarget.worktreeId)
        : undefined;
    return {
      workspaceName: project ? getWorkspaceDisplayName(project) : undefined,
      worktreeName: worktree?.branchName,
      chatTitle: tab?.title,
    };
  }, [projects, sessionChatTarget, tab?.title]);

  const buildWorktreeSessionDisplayFields = useCallback(
    (): {
      workspaceName?: string;
      worktreeName?: string;
      chatTitle?: string;
    } => ({
      ...(worktreeSessionNames?.workspaceName
        ? { workspaceName: worktreeSessionNames.workspaceName }
        : {}),
      ...(worktreeSessionNames?.worktreeName
        ? { worktreeName: worktreeSessionNames.worktreeName }
        : {}),
      ...(worktreeSessionNames?.chatTitle
        ? { chatTitle: worktreeSessionNames.chatTitle }
        : {}),
    }),
    [worktreeSessionNames],
  );

  // Usage-limit banner is served by the shared target-keyed store, fed
  // authoritatively by the main process for every chat surface (CAN-838).
  // Existing-session Schedule Resume is wired here; the rest of the banner
  // lives in the shared AiCreditsUsageLimitBanner component.
  const usageLimitBanner = useVisibleUsageLimitBanner(bannerTarget);
  const canScheduleUsageLimitResume =
    usageLimitBanner !== null &&
    sessionChatTarget !== null &&
    supportsScheduledSends;

  const matchesResumeAutomation = useCallback(
    (activity: ScheduledActivity): boolean => {
      if (!sessionChatTarget) return false;
      if (!activity.enabled) return false;
      const action = activity.action;
      if (action.type !== 'worktree_session_prompt') return false;
      if (action.purpose !== 'usage_limit_resume') return false;
      if (
        action.workspaceId !== sessionChatTarget.projectId ||
        action.worktreeId !== sessionChatTarget.worktreeId ||
        action.chatId !== sessionChatTarget.chatId
      ) {
        return false;
      }
      if (!activity.nextRunAt) return false;
      const next = new Date(activity.nextRunAt).getTime();
      return Number.isFinite(next) && next > Date.now();
    },
    [sessionChatTarget],
  );

  // Idempotency: an enabled future usage-resume automation already exists for
  // this chat. Drives the disabled state of "Schedule Resume" from store state.
  const existingResumeAutomation = useMemo(
    () => automationsActivities.find(matchesResumeAutomation),
    [automationsActivities, matchesResumeAutomation],
  );

  const [scheduleResumeInFlight, setScheduleResumeInFlight] = useState(false);
  const [scheduleResumeError, setScheduleResumeError] = useState<string | null>(
    null,
  );
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [scheduleSendError, setScheduleSendError] = useState<string | null>(
    null,
  );
  const [editingScheduledSendDraft, setEditingScheduledSendDraft] = useState<{
    runAt: string;
  } | null>(() => editingState?.scheduledSendDraft ?? null);

  // Worktree-only "just this time" routing: enable a per-session override so the
  // next turn on this worktree chat routes through AI Credits without changing
  // the persistent mode. Other surfaces rely on the shared banner's persistent
  // "Whenever my quota runs out" action instead. Global on/on-quota auto-routing
  // now lives in the main process, so the old renderer auto-enable effects were
  // removed as redundant (CAN-838).
  const handleUseAiCreditsJustThisTime = useCallback((): void => {
    if (!worktreeChatTarget) return;
    // The Codex transcript banner carries the app-server's epoch seconds.
    const resetsAt =
      typeof usageLimitBanner?.resetsAt === 'number'
        ? normalizeEpochMs(usageLimitBanner.resetsAt)
        : undefined;
    const activatedAt = enableAiCreditsRouting(
      {
        scope: 'session',
        ...(typeof resetsAt === 'number' ? { resetsAt } : {}),
      },
      worktreeChatTarget,
    );
    // Without a reset time the routing would only end on an account switch, so
    // look one up from the provider's usage snapshot. The click never waits on
    // it, and the store ignores the result if the routing has since changed
    // (CAN-4200).
    const provider = usageLimitBanner?.provider;
    if (
      typeof resetsAt === 'number' ||
      activatedAt === undefined ||
      !provider
    ) {
      return;
    }
    void refreshProviderUsageSnapshot(provider)
      .then((snapshot) => {
        const resumeAt = selectProviderUsageLimitResumeAt(snapshot, provider);
        const resumeAtMs = resumeAt ? Date.parse(resumeAt) : Number.NaN;
        if (!Number.isFinite(resumeAtMs) || resumeAtMs <= Date.now()) return;
        setAiCreditsRoutingResetsAt(
          { resetsAt: resumeAtMs, activatedAt },
          worktreeChatTarget,
        );
      })
      .catch(() => {});
  }, [
    enableAiCreditsRouting,
    refreshProviderUsageSnapshot,
    setAiCreditsRoutingResetsAt,
    usageLimitBanner?.provider,
    usageLimitBanner?.resetsAt,
    worktreeChatTarget,
  ]);

  // Empty-completion recovery (CAN-2307). Main flags a turn the provider
  // reported as complete while producing no visible output, and clears the
  // flag itself once late output reconciles the same turn or a new turn
  // starts — so neither action below has to retire the notice, and nothing
  // here ever fires without a click.
  // Reassembled from the composer view's three flat fields — see the note on
  // `ActiveComposerView.emptyCompletionTurnUserMessageId` for why they travel
  // flat and are only made into an object here.
  const emptyCompletionTurnId = tab?.emptyCompletionTurnUserMessageId;
  const stoppedTurnResumeUserMessageId = tab?.stoppedTurnResumeUserMessageId;
  const [turnLimitResumeBusy, setTurnLimitResumeBusy] = useState(false);
  const turnLimitResumeInFlight = useRef(false);
  const [turnLimitResumeError, setTurnLimitResumeError] = useState<
    string | null
  >(null);
  useEffect((): void => {
    setTurnLimitResumeError(null);
  }, [tab?.id, tab?.error]);
  const resumeTurnLimit = useCallback(async (): Promise<void> => {
    if (!sessionChatTarget || turnLimitResumeInFlight.current) return;
    turnLimitResumeInFlight.current = true;
    setTurnLimitResumeBusy(true);
    setTurnLimitResumeError(null);
    try {
      const rejected = (): void => {
        setTurnLimitResumeError('Could not resume this chat. Try again.');
      };
      await sendMessage('Continue', undefined, sessionChatTarget, 'typed', {
        composerAttachmentsReserved: true,
        onDispatchRejected: rejected,
        onPreDispatchRejected: rejected,
      });
    } catch {
      setTurnLimitResumeError('Could not resume this chat. Try again.');
    } finally {
      turnLimitResumeInFlight.current = false;
      setTurnLimitResumeBusy(false);
    }
  }, [sendMessage, sessionChatTarget]);

  const emptyCompletionRepeatsToolActivity =
    tab?.emptyCompletionRepeatsToolActivity === true;
  const emptyCompletionCanRetryPrompt =
    tab?.emptyCompletionCanRetryPrompt === true;
  const emptyCompletionRecovery = useMemo<
    EmptyCompletionRecoveryView | undefined
  >(
    () =>
      emptyCompletionTurnId
        ? {
            turnUserMessageId: emptyCompletionTurnId,
            repeatsToolActivity: emptyCompletionRepeatsToolActivity,
            canRetryPrompt: emptyCompletionCanRetryPrompt,
          }
        : undefined,
    [
      emptyCompletionCanRetryPrompt,
      emptyCompletionRepeatsToolActivity,
      emptyCompletionTurnId,
    ],
  );
  const [emptyCompletionBusy, setEmptyCompletionBusy] = useState(false);
  const [emptyCompletionError, setEmptyCompletionError] = useState<
    string | null
  >(null);

  // A new empty turn is a new problem; carrying the previous attempt's failure
  // line onto it would describe something that did not happen.
  useEffect(() => {
    setEmptyCompletionError(null);
  }, [emptyCompletionTurnId]);

  const dispatchEmptyCompletionRecovery = useCallback(
    async (mode: 'resume' | 'retry'): Promise<void> => {
      if (!sessionChatTarget || !emptyCompletionTurnId) return;
      if (mode === 'retry' && emptyCompletionRepeatsToolActivity) {
        setEmptyCompletionError(
          'Trying again is unavailable because it may repeat work that already ran. Try Resume.',
        );
        return;
      }
      setEmptyCompletionBusy(true);
      setEmptyCompletionError(null);
      try {
        if (mode === 'resume') {
          // The same session, nudged. The agent reads its own history first,
          // so whatever already ran is not issued a second time.
          await sendMessage(
            EMPTY_COMPLETION_RESUME_PROMPT,
            undefined,
            sessionChatTarget,
            'typed',
          );
          return;
        }
        // Read the prompt off the live store rather than the composer view:
        // the transcript may have grown since this render, and the turn's own
        // user message is the only correct source for a re-send.
        const key = `${sessionChatTarget.projectId}/${sessionChatTarget.worktreeId}`;
        const recoveryTab = useChatStore
          .getState()
          .worktreeChats[
            key
          ]?.tabs.find((candidate) => candidate.id === sessionChatTarget.chatId);
        const prompt = buildEmptyCompletionRetryPrompt(
          recoveryTab?.messages ?? [],
          emptyCompletionTurnId,
        );
        if (!prompt) {
          setEmptyCompletionError(
            'That message is no longer available to send again. Try Resume.',
          );
          return;
        }
        await sendMessage(
          prompt.text,
          prompt.fileReferences,
          sessionChatTarget,
          prompt.inputMode ?? 'typed',
          {
            ...(prompt.attachmentPaths?.length
              ? { attachmentPaths: prompt.attachmentPaths }
              : {}),
            ...(prompt.attachmentPromptContexts?.length
              ? {
                  attachmentPromptContexts: prompt.attachmentPromptContexts,
                }
              : {}),
          },
        );
      } catch {
        setEmptyCompletionError(
          mode === 'resume'
            ? 'Could not resume this chat.'
            : 'Could not send that message again.',
        );
      } finally {
        setEmptyCompletionBusy(false);
      }
    },
    [
      emptyCompletionRepeatsToolActivity,
      emptyCompletionTurnId,
      sendMessage,
      sessionChatTarget,
    ],
  );

  const handleScheduleResume = useCallback(async (): Promise<void> => {
    if (!sessionChatTarget) return;
    if (!usageLimitBanner) return;
    setScheduleResumeInFlight(true);
    setScheduleResumeError(null);
    try {
      const providerName =
        usageLimitBanner.provider === 'codex' ? 'Codex' : 'Claude';
      // If the last turn was just the user's message hitting the usage limit
      // before the agent did anything, resume by re-sending that message;
      // otherwise fall back to the plain "Continue" nudge.
      const key = `${sessionChatTarget.projectId}/${sessionChatTarget.worktreeId}`;
      const resumeTab = useChatStore
        .getState()
        .worktreeChats[
          key
        ]?.tabs.find((candidate) => candidate.id === sessionChatTarget.chatId);
      const resumePrompt = computeUsageLimitResumePrompt(
        resumeTab?.messages ?? [],
      );
      const snapshot = await refreshProviderUsageSnapshot(
        usageLimitBanner.provider,
      );
      const resumeAtIso = selectProviderUsageLimitResumeAt(
        snapshot,
        usageLimitBanner.provider,
      );
      if (!resumeAtIso) {
        if (
          useAutomationsStore
            .getState()
            .activities.some(matchesResumeAutomation)
        ) {
          return;
        }
        await sendMessage(
          resumePrompt.text,
          resumePrompt.fileReferences,
          sessionChatTarget,
          resumePrompt.inputMode ?? 'typed',
          {
            ...(resumePrompt.attachmentPaths?.length
              ? { attachmentPaths: resumePrompt.attachmentPaths }
              : {}),
            ...(resumePrompt.attachmentPromptContexts?.length
              ? {
                  attachmentPromptContexts:
                    resumePrompt.attachmentPromptContexts,
                }
              : {}),
          },
        );
        return;
      }
      // Re-check idempotency against the freshest store snapshot before create.
      if (
        useAutomationsStore.getState().activities.some(matchesResumeAutomation)
      ) {
        return;
      }
      const response = await createAutomationActivity({
        name: `Resume chat after ${providerName} usage reset`,
        schedule: { kind: 'one_time', runAt: resumeAtIso, timezone: 'local' },
        action: {
          type: 'worktree_session_prompt',
          workspaceId: sessionChatTarget.projectId,
          worktreeId: sessionChatTarget.worktreeId,
          chatId: sessionChatTarget.chatId,
          prompt: resumePrompt.text,
          ...(resumePrompt.fileReferences?.length
            ? { fileReferences: resumePrompt.fileReferences }
            : {}),
          ...(resumePrompt.attachmentPaths?.length
            ? { attachmentPaths: resumePrompt.attachmentPaths }
            : {}),
          ...(resumePrompt.attachmentPromptContexts?.length
            ? {
                attachmentPromptContexts: resumePrompt.attachmentPromptContexts,
              }
            : {}),
          inputMode: resumePrompt.inputMode ?? 'typed',
          purpose: 'usage_limit_resume',
          ...buildWorktreeSessionDisplayFields(),
        },
      });
      if (!response.ok) {
        setScheduleResumeError(response.error ?? 'Could not schedule resume.');
      }
    } catch {
      setScheduleResumeError('Could not schedule resume.');
    } finally {
      setScheduleResumeInFlight(false);
    }
  }, [
    buildWorktreeSessionDisplayFields,
    createAutomationActivity,
    matchesResumeAutomation,
    refreshProviderUsageSnapshot,
    sendMessage,
    usageLimitBanner,
    sessionChatTarget,
    useChatStore,
  ]);

  // Schedule button + pill are offered on live persisted-session composers and
  // on queued-message inline editors when the parent chat surface enables it.
  const showScheduleControls =
    supportsScheduledSends &&
    !isTerminalMode &&
    (isEditingQueued
      ? editingState.scheduleEnabled === true
      : sessionChatTarget !== null);
  // Unsupported account-harness drafts remain clearable without exposing
  // schedule editing.
  const showScheduledSendDraft =
    showScheduleControls || (nativeSessionComposer && isAccountHarness);
  const scheduledSendDraft = isEditingQueued
    ? editingScheduledSendDraft
    : (tab?.scheduledSendDraft ?? null);

  const handleClearScheduledSend = useCallback((): void => {
    setScheduleSendError(null);
    if (isEditingQueued) {
      setEditingScheduledSendDraft(null);
      return;
    }
    void setScheduledSendDraft(null, sessionChatTarget ?? undefined);
  }, [isEditingQueued, sessionChatTarget, setScheduledSendDraft]);

  const handleSaveSchedule = useCallback(
    (runAtIso: string): void => {
      setScheduleSendError(null);
      if (isEditingQueued) {
        setEditingScheduledSendDraft({ runAt: runAtIso });
        setScheduleModalOpen(false);
        return;
      }
      void setScheduledSendDraft(
        { runAt: runAtIso },
        sessionChatTarget ?? undefined,
      );
      setScheduleModalOpen(false);
    },
    [isEditingQueued, sessionChatTarget, setScheduledSendDraft],
  );

  const handleScheduledSend = useCallback(
    async (
      trimmedText: string,
      outboundReferences: SerializedFileReference[],
      runAtIso: string,
      stagedSelectionIds: readonly string[],
    ): Promise<void> => {
      if (!sessionChatTarget) return;
      if (!supportsScheduledSends) {
        setScheduleSendError(
          'This harness does not support scheduled messages. Choose another model or clear the schedule.',
        );
        return;
      }
      const inputMode = dictationInputModeRef.current;
      const cwd = getCwdFromFileIndex(fileRepos, selectedRepoId);
      const rewritten = rewriteFileReferencesForCwd(
        trimmedText,
        outboundReferences,
        cwd,
      );
      const userAttachmentPaths = pendingAttachments.map(
        (attachment) => attachment.absolutePath,
      );
      const revertAttachmentPath = tab?.pendingRevertAttachmentPath;
      const combinedAttachmentPaths = revertAttachmentPath
        ? [revertAttachmentPath, ...userAttachmentPaths]
        : userAttachmentPaths;
      const attachmentPromptContexts =
        attachmentPromptContextsFromMeta(pendingAttachments);
      setScheduleSendError(null);
      const response = await createAutomationActivity({
        name: 'Scheduled message',
        schedule: { kind: 'one_time', runAt: runAtIso, timezone: 'local' },
        action: {
          type: 'worktree_session_prompt',
          workspaceId: sessionChatTarget.projectId,
          worktreeId: sessionChatTarget.worktreeId,
          chatId: sessionChatTarget.chatId,
          prompt: rewritten.text,
          ...(rewritten.fileReferences.length > 0
            ? { fileReferences: rewritten.fileReferences }
            : {}),
          ...(combinedAttachmentPaths.length > 0
            ? { attachmentPaths: combinedAttachmentPaths }
            : {}),
          ...(attachmentPromptContexts ? { attachmentPromptContexts } : {}),
          inputMode,
          purpose: 'scheduled_send',
          ...buildWorktreeSessionDisplayFields(),
        },
      });
      if (!response.ok) {
        // Keep editor content, attachments, and schedule intact on failure.
        setScheduleSendError('Could not schedule message.');
        return;
      }
      // Success: clear editor draft, attachments, the synthetic revert
      // attachment, and the staged schedule — never sending immediately.
      dictationInputModeRef.current = 'typed';
      messageHistoryNavigationRef.current = null;
      resetEditor(editor);
      setValue(createEmptyValue());
      if (tabId) {
        useChatStore.getState().clearTabDraft(tabId);
      }
      useChatStore
        .getState()
        .clearScheduledSendComposerState(sessionChatTarget);
      const chatStore = useChatStore.getState();
      for (const selectionId of stagedSelectionIds) {
        chatStore.removePendingEditorSelection(
          sessionChatTarget.chatId,
          selectionId,
        );
      }
    },
    [
      buildWorktreeSessionDisplayFields,
      createAutomationActivity,
      editor,
      fileRepos,
      pendingAttachments,
      selectedRepoId,
      tab?.pendingRevertAttachmentPath,
      tabId,
      sessionChatTarget,
      supportsScheduledSends,
      useChatStore,
    ],
  );

  // Mirror the schedule-modal open state into the store so the App Advisor
  // current-UI snapshot can report it on the active chat. Cleared on unmount.
  useEffect(() => {
    useChatStore
      .getState()
      .setScheduledSendModalOpen(scheduleModalOpen && showScheduleControls);
    return (): void => {
      useChatStore.getState().setScheduledSendModalOpen(false);
    };
  }, [scheduleModalOpen, showScheduleControls, useChatStore]);

  useEffect(() => {
    if (!fileTypeaheadEnabled || !selectedWorktree || !composerMenu.open)
      return;
    if (isFileIndexStale(fileIndexEntry)) {
      void fetchFileIndex(
        selectedWorktree.projectId,
        selectedWorktree.worktreeId,
      );
    }
  }, [
    fetchFileIndex,
    fileIndexEntry,
    composerMenu.open,
    fileTypeaheadEnabled,
    selectedWorktree,
  ]);

  const syncEditorValue = useCallback(() => {
    setValue(structuredClone(editor.children));
  }, [editor]);

  // Live composer-content signal (CAN-1809): report emptiness flips so
  // empty-state affordances (suggested prompts) hide while a draft is in
  // progress. Cleared on unmount / tab change so stale tabs never read as
  // "has text".
  const composerSignalTabId = tab?.id ?? null;
  const hadComposerTextRef = useRef(false);
  useEffect(() => {
    if (composerSignalTabId === null) return;
    // Serialized emptiness: a draft holding only file-reference pills has no
    // plain text but is still content the user typed into the composer.
    const serialized = serializeEditorValue(editor.children);
    const hasText =
      serialized.text.trim().length > 0 || serialized.fileReferences.length > 0;
    if (hasText !== hadComposerTextRef.current) {
      hadComposerTextRef.current = hasText;
      useChatStore
        .getState()
        .setComposerTextPresent(composerSignalTabId, hasText);
    }
  }, [value, composerSignalTabId, editor, useChatStore]);
  useEffect(() => {
    if (composerSignalTabId === null) return;
    return (): void => {
      hadComposerTextRef.current = false;
      useChatStore
        .getState()
        .setComposerTextPresent(composerSignalTabId, false);
    };
  }, [composerSignalTabId, useChatStore]);

  useEffect(() => {
    if (!staleSessionDetected) {
      setHandoffLoading(false);
      setHandoffError(null);
    }
  }, [staleSessionDetected]);

  const selectHistoryBoundary = useCallback(
    (boundary: HistoryBoundary): void => {
      const point =
        boundary === 'start'
          ? Editor.start(editor, [])
          : Editor.end(editor, []);
      Transforms.select(editor, point);
    },
    [editor],
  );

  const replaceEditorTextFromHistory = useCallback(
    (nextText: string, boundary: HistoryBoundary): void => {
      markHistoryNavigationProgrammaticChange();
      resetEditor(editor);
      if (nextText) {
        Transforms.insertText(editor, nextText);
      }
      selectHistoryBoundary(boundary);
      syncEditorValue();
      focusEditor(editor);
    },
    [
      editor,
      markHistoryNavigationProgrammaticChange,
      selectHistoryBoundary,
      syncEditorValue,
    ],
  );

  const restoreHistoryDraft = useCallback(
    (draft: Descendant[]): void => {
      markHistoryNavigationProgrammaticChange();
      restoreEditorContent(editor, draft);
      selectHistoryBoundary('end');
      syncEditorValue();
      focusEditor(editor);
    },
    [
      editor,
      markHistoryNavigationProgrammaticChange,
      selectHistoryBoundary,
      syncEditorValue,
    ],
  );

  const handleMessageHistoryKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>): boolean => {
      if (
        !tabId ||
        userMessageHistory.length === 0 ||
        e.altKey ||
        e.ctrlKey ||
        e.metaKey ||
        e.shiftKey
      ) {
        return false;
      }

      if (e.key === 'ArrowUp') {
        if (!isEditorSelectionAtBoundary(editor, 'start')) {
          return false;
        }

        const activeState =
          messageHistoryNavigationRef.current?.tabId === tabId
            ? messageHistoryNavigationRef.current
            : null;
        const currentIndex =
          activeState !== null
            ? Math.min(activeState.index, userMessageHistory.length)
            : userMessageHistory.length;
        const nextIndex = Math.max(0, currentIndex - 1);
        const nextMessage = userMessageHistory[nextIndex];
        if (nextMessage === undefined) {
          return false;
        }

        e.preventDefault();
        messageHistoryNavigationRef.current = {
          tabId,
          index: nextIndex,
          draft: activeState?.draft ?? structuredClone(editor.children),
          draftInputMode:
            activeState?.draftInputMode ?? dictationInputModeRef.current,
        };
        dictationInputModeRef.current = 'typed';
        replaceEditorTextFromHistory(nextMessage, 'start');
        return true;
      }

      if (e.key === 'ArrowDown') {
        const activeState =
          messageHistoryNavigationRef.current?.tabId === tabId
            ? messageHistoryNavigationRef.current
            : null;
        if (activeState === null) {
          return false;
        }

        const isSelectionAtHistoryBoundary =
          isEditorSelectionAtBoundary(editor, 'end') ||
          isEditorSelectionAtBoundary(editor, 'start');
        if (!isSelectionAtHistoryBoundary) {
          return false;
        }

        const nextIndex = activeState.index + 1;
        if (nextIndex >= userMessageHistory.length) {
          e.preventDefault();
          messageHistoryNavigationRef.current = null;
          dictationInputModeRef.current = activeState.draftInputMode;
          restoreHistoryDraft(activeState.draft);
          return true;
        }

        const nextMessage = userMessageHistory[nextIndex];
        if (nextMessage === undefined) {
          return false;
        }

        e.preventDefault();
        messageHistoryNavigationRef.current = {
          ...activeState,
          index: nextIndex,
        };
        dictationInputModeRef.current = 'typed';
        replaceEditorTextFromHistory(nextMessage, 'end');
        return true;
      }

      return false;
    },
    [
      editor,
      replaceEditorTextFromHistory,
      restoreHistoryDraft,
      tabId,
      userMessageHistory,
    ],
  );

  // Voice dictation. Feature-detect on mount; the mic button is hidden when
  // on-device recognition is not available (no Swift helper, older macOS,
  // Linux/Windows, etc.) so there's no UI affordance to confuse the user.
  // The user can also disable it explicitly from Settings → Dictation.
  //
  // On platforms that never expose voice dictation (Windows, Linux), we skip
  // the IPC probe entirely and never load the preference, so the microphone
  // button is unreachable from this composer.
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceEnabledPref, setVoiceEnabledPref] = useState(
    DEFAULT_VOICE_DICTATION_ENABLED,
  );
  useEffect(() => {
    if (!shouldProbeVoiceSupport(localPlatform())) {
      setVoiceSupported(false);
      return;
    }
    let cancelled = false;
    const voiceApi = window.api.voice;
    if (!voiceApi) return;
    void voiceApi
      .isSupported()
      .then((result) => {
        if (!cancelled) setVoiceSupported(result.supported);
      })
      .catch(() => {
        if (!cancelled) setVoiceSupported(false);
      });
    void window.api
      .loadPreferences()
      .then((prefs) => {
        if (!cancelled) setVoiceEnabledPref(prefs.voiceDictationEnabled);
      })
      .catch(() => {
        // Leave default `true` in place so the mic stays visible if the
        // preference file is unreadable.
      });
    const unsubscribe = onVoiceDictationEnabledChanged((enabled) => {
      if (!cancelled) setVoiceEnabledPref(enabled);
    });
    return (): void => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // `dictationInputMode` tracks whether the next send was authored by the mic —
  // flips to 'voice' when the provider commits a final transcript, and back to
  // 'typed' on any keyboard input or after a send.
  const dictationInputModeRef = useRef<'typed' | 'voice'>('typed');
  const voiceTarget = useMemo(() => createSlateVoiceTarget(editor), [editor]);
  const voice = useVoiceTranscription({
    target: voiceTarget,
    destinationKey: cancelShortcutChatKey,
    onFinalCommitted: (transcribed): void => {
      if (shouldMarkFinalTranscriptAsVoiceInput(transcribed)) {
        dictationInputModeRef.current = 'voice';
      }
      // Final transcript changes the editor content — sync our local value.
      setValue(structuredClone(editor.children));
      focusEditor(editor);
    },
  });

  const terminalModeError = terminalMode.error;

  const estimateTerminalSpawnSize = useCallback((): {
    cols: number;
    rows: number;
  } => {
    const composerRect = dropContainerRef.current?.getBoundingClientRect();
    const computed =
      composerRect !== undefined
        ? computeColsRowsForPixels(
            Math.max(0, composerRect.width),
            DEFAULT_TERMINAL_DRAWER_HEIGHT,
          )
        : null;
    return (
      computed ?? {
        cols: DEFAULT_TERMINAL_SPAWN_COLS,
        rows: DEFAULT_TERMINAL_SPAWN_ROWS,
      }
    );
  }, []);

  // Terminal mode bypasses the chat queue: it spawns a fresh PTY and writes
  // the command directly, regardless of whether the agent is currently
  // streaming. After the editor resets, `isTerminalMode` flips back to false,
  // so the composer naturally returns to the streaming-aware UI (queue button
  // / queue placeholder if still streaming, normal send otherwise). A script
  // picked from the `!` typeahead runs its full body in its own repository and
  // package directory; a raw command runs its first line where the composer
  // points. Composer sends always start a new terminal.
  const canopyClient = useCanopyClient();
  runTerminalCommandRef.current = async (command: string): Promise<void> => {
    if (!slashCommandTarget) {
      throw new Error('Terminal mode needs a worktree');
    }
    const { projectId, worktreeId } = slashCommandTarget;
    const submission = await scriptTypeahead.resolveSubmission();
    const repoId =
      submission.kind === 'script' ? submission.selectedRepoId : selectedRepoId;
    const { cols, rows } = estimateTerminalSpawnSize();
    // Surface the terminal in the panel grid: expand it if collapsed, or
    // create a terminal panel (lower drawer) when none is open, so the
    // spawned command is actually visible.
    const host = desktopTerminalRunHost({
      projectId,
      worktreeId,
      panelPlacement,
      ownerDocument: dropContainerRef.current?.ownerDocument ?? document,
    });
    await runCommandInTerminal({
      client: canopyClient,
      spawn: {
        projectId,
        worktreeId,
        ...(repoId ? { selectedRepoId: repoId } : {}),
        ...(submission.kind === 'script' && submission.relativeCwd
          ? { relativeCwd: submission.relativeCwd }
          : {}),
        cols,
        rows,
      },
      command: submission.kind === 'script' ? submission.command : command,
      hydrate: host.hydrate,
      reveal: host.reveal,
    });
  };
  terminalCommandSentRef.current = (): void => {
    messageHistoryNavigationRef.current = null;
    resetEditor(editor);
    setValue(createEmptyValue());
    if (tabId) {
      useChatStore.getState().clearTabDraft(tabId);
    }
    dictationInputModeRef.current = 'typed';
    scriptTypeahead.reset();
    focusEditor(editor);
  };
  const sendTerminalCommand = terminalMode.send;
  const handleSendTerminalCommand = useCallback(async (): Promise<void> => {
    // A failure keeps the command in the box with the error in the mode
    // label's place; nothing is retried.
    await sendTerminalCommand();
  }, [sendTerminalCommand]);

  // Distinct drafts may be submitted while the previous send is awaiting
  // main-process admission. Keep their order without letting a repeated Enter
  // submit the same draft twice.
  const submittingDraftRevisionsRef = useRef(new Set<number>());
  const pendingSendRef = useRef<Promise<void>>(Promise.resolve());
  const draftRevisionRef = useRef(0);

  /**
   * Enable plugins for this chat the way the Plugins picker does: persist the
   * merged selections through `chat:update-plugins` (materializing a Codex
   * thread when needed) and mirror the response into the store. Shared by the
   * composer menu's plugin rows and by send, which re-enables any mentioned
   * plugin the user removed after dropping its pill. Resolves `false` on
   * failure after surfacing a toast; callers decide whether to continue.
   */
  const enablePluginsForChat = useCallback(
    async (refs: ChatTabPluginSelections['pluginRefs']): Promise<boolean> => {
      if (refs.length === 0) return true;
      // Not `watcherDestination`: that one is null for cowork chats by
      // design (they receive no watchers), but they do carry plugin
      // selections and must enable mentions like any other chat.
      const destination =
        targetOverride ??
        (selectedWorktree && tabId
          ? {
              projectId: selectedWorktree.projectId,
              worktreeId: selectedWorktree.worktreeId,
              chatId: tabId,
            }
          : null);
      if (!destination) return false;
      const currentTab = useChatStore
        .getState()
        .worktreeChats[
          `${destination.projectId}/${destination.worktreeId}`
        ]?.tabs.find((candidate) => candidate.id === destination.chatId);
      if (!currentTab) return false;
      // Merge into the tab's LIVE selections, not a render-time snapshot: a
      // second pick while the first round-trip is in flight must not drop
      // the first plugin.
      const next = mergeChatPluginSelections(
        currentTab.pluginSelections ?? createEmptySelections(),
        { ...createEmptySelections(), pluginRefs: refs },
      );
      try {
        const response = await window.api.chat.updatePlugins({
          ...destination,
          pluginSelections: next,
          materializeCodexThread: shouldMaterializeCodexThread({
            providerType: effectiveProviderType,
            executionHarness: currentTab?.executionHarness ?? thinkingHarness,
            sdkSessionId: currentTab?.sdkSessionId,
          }),
          expectedCurrentThreadId: currentTab?.sdkSessionId,
          ...(selectedRepoId ? { selectedRepoId } : {}),
        });
        setPluginSelections(
          response.pluginSelections,
          destination,
          response.deferredToolsAllowed,
          {
            runtimeAlreadyUpdated: true,
            ...(response.sdkSessionId
              ? { sdkSessionId: response.sdkSessionId }
              : {}),
          },
        );
        return true;
      } catch {
        addToast('Could not enable this plugin. Please try again.', 'error');
        return false;
      }
    },
    [
      targetOverride,
      selectedWorktree,
      tabId,
      effectiveProviderType,
      thinkingHarness,
      selectedRepoId,
      setPluginSelections,
      addToast,
    ],
  );

  const handleSend = useCallback(() => {
    // Slate mutates the editor tree before React commits the corresponding
    // `value` update. A queued-message Save can therefore run in the same
    // interaction window as the final edit and must read the live tree rather
    // than the previous render's memoized serialization.
    const currentDraft = editingState
      ? serializeEditorValue(editor.children)
      : serializedDraft;
    const { text } = currentDraft;
    const currentFileReferences = editingState
      ? mergePromptAwareFileReferences(
          currentDraft.fileReferences,
          extraFileReferences,
        )
      : mergedFileReferences;
    const trimmed = text.trim();
    if (
      questionPromptOpen &&
      !editingState &&
      questionPrompt.prompt.sendAnswers(text)
    ) {
      if (
        !questionPrompt.prompt.canSend(text) ||
        questionPrompt.busy !== null ||
        questionPrompt.disconnected
      )
        return;
      questionPrompt.prompt.send(text);
      resetEditor(editor);
      setValue(createEmptyValue());
      if (tabId) {
        useChatStore.getState().clearTabDraft(tabId);
      }
      return;
    }
    if (!trimmed) return;
    // Read the live intent as well as disabling the button: a keyboard send
    // can arrive in the same task as a model click, before React repaints.
    if (
      modelChangeKey &&
      useChatStore.getState().pendingModelChanges[modelChangeKey] &&
      !editingState &&
      !isTerminalMode
    )
      return;

    if (isResourceGuardBlocked && !editingState && !isTerminalMode) {
      // Banner above the composer explains why; bail silently so we never
      // surface the raw ResourceGuardError IPC text in the transcript.
      return;
    }
    const submittedDraftRevision = draftRevisionRef.current;
    if (submittingDraftRevisionsRef.current.has(submittedDraftRevision)) return;
    submittingDraftRevisionsRef.current.add(submittedDraftRevision);
    const submittedEditorValue = structuredClone(editor.children);
    // Snapshot selections before prompt expansion or scheduled-send creation
    // yields. Anything staged afterward belongs to the next message.
    const stagedSelections =
      !editingState && !isTerminalMode && tabId !== undefined
        ? (useChatStore.getState().pendingEditorSelections[tabId] ??
          NO_PENDING_SELECTIONS)
        : NO_PENDING_SELECTIONS;
    const stagedSelectionIds = stagedSelections.map(
      (selection) => selection.id,
    );
    const attachmentTarget =
      targetOverride ??
      (selectedWorktree && tabId
        ? { ...selectedWorktree, chatId: tabId }
        : undefined);
    // The target worktree's active plan, read at submit before anything
    // yields: a plan focused while this send waits belongs to the next one.
    const activePlan = captureActivePlanContext(
      targetOverride ?? selectedWorktree,
    );
    const submittedAttachments =
      !editingState && !isTerminalMode && !tab?.scheduledSendDraft?.runAt
        ? attachmentTarget
          ? (useChatStore
              .getState()
              .worktreeChats[
                `${attachmentTarget.projectId}/${attachmentTarget.worktreeId}`
              ]?.tabs.find((candidate) => candidate.id === attachmentTarget.chatId)
              ?.pendingAttachments ?? [])
          : pendingAttachments
        : [];
    const reserveComposerInputs =
      !editingState && !isTerminalMode && !tab?.scheduledSendDraft?.runAt;
    let submittedRevertAttachmentPath: string | undefined;
    if (reserveComposerInputs) {
      const chatStore = useChatStore.getState();
      submittedRevertAttachmentPath =
        chatStore.reservePendingRevertAttachment(attachmentTarget);
      for (const selectionId of stagedSelectionIds) {
        if (tabId) chatStore.removePendingEditorSelection(tabId, selectionId);
      }
      for (const attachment of submittedAttachments) {
        chatStore.removePendingAttachment(
          attachment.absolutePath,
          attachmentTarget,
        );
      }
    }
    let reservedInputsSettled = false;
    const restoreReservedInputs = (): void => {
      if (!reserveComposerInputs || reservedInputsSettled) return;
      reservedInputsSettled = true;
      const chatStore = useChatStore.getState();
      if (tabId) {
        for (const selection of stagedSelections) {
          chatStore.addPendingEditorSelection(tabId, selection);
        }
      }
      if (submittedAttachments.length > 0) {
        chatStore.addPendingAttachments(submittedAttachments, attachmentTarget);
      }
      if (submittedRevertAttachmentPath) {
        chatStore.restorePendingRevertAttachment(
          submittedRevertAttachmentPath,
          attachmentTarget,
        );
      }
    };

    const submission = pendingSendRef.current.then(async (): Promise<void> => {
      // Prompt @-mentions expand into the outgoing text before anything else
      // (path rewriting, scheduling, send); note/attachment mentions pass
      // through as pills. Skipped when no workspace scope is known.
      const expandedResult = mentionProjectId
        ? await expandPromptMentions(
            mentionProjectId,
            text,
            currentFileReferences,
          )
        : { text, fileReferences: [...currentFileReferences] };
      const expanded = {
        ...expandedResult,
        text: expandedResult.text.trim(),
      };

      // The model picker remains interactive while prompt mentions expand.
      // Re-read the live intent after that await so an in-flight send cannot
      // overtake a newer model selection.
      if (
        modelChangeKey &&
        useChatStore.getState().pendingModelChanges[modelChangeKey] &&
        !editingState &&
        !isTerminalMode
      ) {
        restoreReservedInputs();
        return;
      }

      // Staged editor selections (CAN-1250) ride the outgoing text as
      // structured blocks, tagged with their freshness at the moment of send.
      // Queued-message edits and terminal commands never carry them.
      expanded.text = appendSelectionContextBlocks(
        expanded.text,
        stagedSelections.map((selection) => ({
          selection,
          freshness: selectionFreshnessRef.current[selection.id] ?? 'checking',
        })),
      );

      if (editingState) {
        const inputMode = dictationInputModeRef.current;
        dictationInputModeRef.current = 'typed';
        const cwd = getCwdFromFileIndex(fileRepos, selectedRepoId);
        const rewritten = rewriteFileReferencesForCwd(
          expanded.text,
          expanded.fileReferences,
          cwd,
        );
        const attachmentPaths = editingState.attachments.map(
          (attachment) => attachment.absolutePath,
        );
        const attachmentPromptContexts = attachmentPromptContextsFromMeta(
          editingState.attachments,
        );
        editingState.onSave(
          rewritten.text,
          rewritten.fileReferences,
          attachmentPaths,
          attachmentPromptContexts,
          inputMode,
          editingScheduledSendDraft ?? undefined,
        );
        return;
      }

      if (isTerminalMode) {
        if (!terminalCommand) return;
        void handleSendTerminalCommand();
        return;
      }

      // Scheduled send: when a one-time schedule is staged on a supported live
      // chat, create a `worktree_session_prompt` automation instead of sending
      // now. The handler owns editor/attachment cleanup (only on success).
      const scheduledRunAt = tab?.scheduledSendDraft?.runAt;
      if (scheduledRunAt && sessionChatTarget) {
        await handleScheduledSend(
          expanded.text,
          expanded.fileReferences,
          scheduledRunAt,
          stagedSelectionIds,
        );
        return;
      }

      const inputMode = dictationInputModeRef.current;
      dictationInputModeRef.current = 'typed';
      messageHistoryNavigationRef.current = null;
      let clearedDraftRevision: number | undefined;
      // Prompt expansion is asynchronous while the composer remains editable.
      // Preserve any newer draft the user created while this send was waiting.
      if (draftRevisionRef.current === submittedDraftRevision) {
        resetEditor(editor);
        setValue(createEmptyValue());
        clearedDraftRevision = draftRevisionRef.current;
        if (tabId) {
          useChatStore.getState().clearTabDraft(tabId);
        }
      }

      const cwd = getCwdFromFileIndex(fileRepos, selectedRepoId);
      const rewritten = rewriteFileReferencesForCwd(
        expanded.text,
        expanded.fileReferences,
        cwd,
      );

      const outboundFileReferences =
        rewritten.fileReferences.length > 0
          ? rewritten.fileReferences
          : undefined;
      const attachmentPaths =
        submittedAttachments.length > 0 || submittedRevertAttachmentPath
          ? [
              ...(submittedRevertAttachmentPath
                ? [submittedRevertAttachmentPath]
                : []),
              ...submittedAttachments.map(
                (attachment) => attachment.absolutePath,
              ),
            ]
          : undefined;
      const attachmentPromptContexts =
        attachmentPromptContextsFromMeta(submittedAttachments);
      const removeStagedSelections = (): void => {
        if (
          reserveComposerInputs ||
          stagedSelectionIds.length === 0 ||
          tabId === undefined
        )
          return;
        const chatStore = useChatStore.getState();
        for (const selectionId of stagedSelectionIds) {
          chatStore.removePendingEditorSelection(tabId, selectionId);
        }
      };
      const restoreRejectedDraft = (): void => {
        restoreReservedInputs();
        if (
          clearedDraftRevision === undefined ||
          draftRevisionRef.current !== clearedDraftRevision
        ) {
          return;
        }
        restoreEditorContent(editor, submittedEditorValue);
        const restoredValue = structuredClone(editor.children);
        setValue(restoredValue);
        if (tabId) {
          useChatStore.getState().saveTabDraft(tabId, restoredValue);
        }
        focusEditor(editor);
      };
      const clearAcceptedSavedDraft = (): void => {
        if (!tabId) return;
        const chatStore = useChatStore.getState();
        const savedDraft = chatStore.getTabDraft(tabId);
        // A tab switch can save this already-submitted editor value while the
        // send waits behind an earlier one. Clear only that exact snapshot;
        // any newer draft in the same tab belongs to the next message.
        if (
          savedDraft &&
          JSON.stringify(savedDraft) === JSON.stringify(submittedEditorValue)
        ) {
          chatStore.clearTabDraft(tabId);
        }
      };
      // Mentioning a plugin means "use it": re-enable any `@plugin` pill whose
      // plugin was removed after the pill was dropped, before the turn starts,
      // so the agent is never told about a plugin it cannot load. A failed
      // re-enable is surfaced by toast and does not block the send.
      await enablePluginsForChat(
        missingMentionedPluginRefs(
          rewritten.fileReferences,
          effectivePluginSelections?.pluginRefs ?? [],
        ),
      );
      const acceptSend = (): void => {
        reservedInputsSettled = true;
        removeStagedSelections();
        clearAcceptedSavedDraft();
      };
      if (onSendMessage) {
        await onSendMessage(
          rewritten.text,
          outboundFileReferences,
          inputMode,
          attachmentPaths,
          attachmentPromptContexts,
        );
        acceptSend();
      } else {
        // The centered Getting Started checklist arms its example prompts
        // in this tab's composer (CAN-3031, CAN-3032); an accepted send from
        // this same tab is what completes them. Reported only once the
        // dispatch is accepted, so a rejected send completes nothing.
        const acceptNativeSend = (): void => {
          acceptSend();
          if (tabId) notifyHomeTaskSent({ kind: 'chat', chatId: tabId });
        };
        await sendMessage(
          rewritten.text,
          outboundFileReferences,
          targetOverride,
          inputMode,
          attachmentPaths || attachmentPromptContexts
            ? {
                ...(attachmentPaths ? { attachmentPaths } : {}),
                ...(attachmentPromptContexts
                  ? { attachmentPromptContexts }
                  : {}),
                ...(activePlan ? { activePlan } : {}),
                composerAttachmentsReserved: reserveComposerInputs,
                reservedRevertAttachmentPath: submittedRevertAttachmentPath,
                onDispatchAccepted: acceptNativeSend,
                onDispatchRejected: restoreReservedInputs,
                onPreDispatchRejected: restoreRejectedDraft,
              }
            : {
                ...(activePlan ? { activePlan } : {}),
                composerAttachmentsReserved: reserveComposerInputs,
                reservedRevertAttachmentPath: submittedRevertAttachmentPath,
                onDispatchAccepted: acceptNativeSend,
                onDispatchRejected: restoreReservedInputs,
                onPreDispatchRejected: restoreRejectedDraft,
              },
        );
      }
    });
    // A later draft must reach the host after this one, including when prompt
    // expansion or plugin activation took longer than the next key press.
    pendingSendRef.current = submission.catch(() => {
      restoreReservedInputs();
    });
    void submission.then(
      () => submittingDraftRevisionsRef.current.delete(submittedDraftRevision),
      () => submittingDraftRevisionsRef.current.delete(submittedDraftRevision),
    );
  }, [
    questionPromptOpen,
    questionPrompt.busy,
    questionPrompt.disconnected,
    questionPrompt.prompt,
    enablePluginsForChat,
    effectivePluginSelections,
    editingState,
    editingScheduledSendDraft,
    editor,
    extraFileReferences,
    fileRepos,
    handleScheduledSend,
    handleSendTerminalCommand,
    isResourceGuardBlocked,
    isTerminalMode,
    mentionProjectId,
    mergedFileReferences,
    pendingAttachments,
    selectedWorktree,
    modelChangeKey,
    selectedRepoId,
    sendMessage,
    serializedDraft,
    tab?.scheduledSendDraft?.runAt,
    tabId,
    targetOverride,
    terminalCommand,
    sessionChatTarget,
    onSendMessage,
    useChatStore,
  ]);

  // Dictation owns the box's bottom row while it runs (see VoiceRecordingRow).
  const voiceRecording =
    voice.state === 'connecting' || voice.state === 'listening';
  // Send from the recording row: stop the take, and send once its final words
  // have landed in the draft (the session reports idle after committing them).
  const sendAfterVoiceRef = useRef(false);
  useEffect(() => {
    // A take discarded on a chat switch must not send the incoming draft.
    sendAfterVoiceRef.current = false;
  }, [cancelShortcutChatKey]);
  const handleVoiceSend = useCallback((): void => {
    sendAfterVoiceRef.current = true;
    void voice.stop();
  }, [voice]);
  useEffect(() => {
    if (!sendAfterVoiceRef.current) return;
    if (voice.state === 'error') {
      sendAfterVoiceRef.current = false;
      return;
    }
    if (voice.state !== 'idle') return;
    sendAfterVoiceRef.current = false;
    handleSend();
  }, [voice.state, handleSend]);
  // The recording row replaces the microphone that had focus, so Escape
  // discards the take from anywhere in the window, not only the editor.
  useEffect(() => {
    if (!voiceRecording) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      dictationInputModeRef.current = 'typed';
      void voice.cancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => window.removeEventListener('keydown', onKeyDown);
  }, [voiceRecording, voice]);

  const handleSelectionChange = useCallback((): void => {
    setSelectionRevision((current) => current + 1);
  }, []);

  const handleEditorChange = useCallback(
    (newValue: Descendant[]): void => {
      // Caret movement has only set_selection operations. Programmatic
      // restore/reset swaps children directly and calls onChange with none.
      if (
        editor.operations.length === 0 ||
        editor.operations.some(
          (operation) => operation.type !== 'set_selection',
        )
      ) {
        draftRevisionRef.current += 1;
      }
      if (
        !historyNavigationProgrammaticChangeRef.current &&
        messageHistoryNavigationRef.current?.tabId === tabId
      ) {
        messageHistoryNavigationRef.current = null;
      }
      setValue([...newValue]);
    },
    [editor, tabId],
  );

  const editingAddAttachmentsRef = useRef(editingState?.onAddAttachments);
  editingAddAttachmentsRef.current = editingState?.onAddAttachments;

  const handleImportAttachments = useCallback(async () => {
    const attachmentTarget = targetOverride ?? selectedWorktree;
    if (!attachmentTarget) return;
    const attachments = await importChatAttachments(attachmentTarget, []);
    addPendingAttachmentsAndRefreshIndex(
      attachmentTarget,
      attachments,
      editingAddAttachmentsRef.current,
      targetOverride,
    );
  }, [selectedWorktree, targetOverride]);

  // ⌘/Ctrl+U (ECW-7984): the global shortcut handler identifies the active
  // chat explicitly so a split layout with multiple visible composers opens
  // exactly one attachment picker.
  useEffect(() => {
    const attachmentTarget =
      targetOverride ??
      (selectedWorktree && tabId
        ? {
            projectId: selectedWorktree.projectId,
            worktreeId: selectedWorktree.worktreeId,
            chatId: tabId,
          }
        : null);
    if (attachmentTarget === null) return undefined;

    const handler = (event: Event): void => {
      const detail: unknown = 'detail' in event ? event.detail : null;
      if (
        !isComposerVisible() ||
        !isChatAttachmentShortcutTarget(detail, attachmentTarget)
      ) {
        return;
      }
      void handleImportAttachments();
    };
    document.addEventListener(OPEN_CHAT_ATTACHMENTS_EVENT, handler);
    return (): void => {
      document.removeEventListener(OPEN_CHAT_ATTACHMENTS_EVENT, handler);
    };
  }, [
    handleImportAttachments,
    isComposerVisible,
    selectedWorktree,
    tabId,
    targetOverride,
  ]);

  // ⌥M / ⌥T (ECW-7984 follow-up). Unlike the ⌘U path above, which gates on
  // layout visibility, these match on the full chat identity the global
  // handler resolved from the store's ACTIVE tab — so exactly one composer
  // reacts even when several split panels are visible at once.
  const composerShortcutTarget = useMemo((): ComposerShortcutScope | null => {
    const scopeTarget = targetOverride ?? selectedWorktree;
    if (!scopeTarget || !tabId) {
      return null;
    }
    return {
      scope: 'chat',
      projectId: scopeTarget.projectId,
      worktreeId: scopeTarget.worktreeId,
      chatId: tabId,
    };
  }, [selectedWorktree, tabId, targetOverride]);

  useComposerActions(
    composerShortcutTarget,
    { plugins: () => void openPluginsModal() },
    !readOnly && editingState === undefined,
  );

  // Hold ⌃M to dictate (a tap leaves the take running hands-free).
  const holdToDictate = useHoldToDictate(voice);

  const handleCycleThinkingLevel = useCallback((): void => {
    cycleThinkingLevel(targetOverride);
  }, [cycleThinkingLevel, targetOverride]);

  const modelPickerOpenSignal = useComposerShortcutRequests({
    target: composerShortcutTarget,
    onCycleEffort: handleCycleThinkingLevel,
    ...(voiceSupported && voiceEnabledPref ? holdToDictate : {}),
    enabled:
      composerShortcutsEnabled &&
      !isTerminalMode &&
      !readOnly &&
      editingState === undefined,
  });

  // Mirrors `handleImportAttachments`'s target resolution and pending-sink
  // wiring exactly (including the editing-state override) so a staged Linear
  // ticket lands in the same place a picked file attachment would.
  const handleSelectLinearTicket = useCallback(
    async (ticket: LinearTicketSearchResult) => {
      const attachmentTarget = targetOverride ?? selectedWorktree;
      if (!attachmentTarget) return;
      await stageLinearTicketAttachment(
        attachmentTarget,
        ticket,
        (attachments) =>
          addPendingAttachmentsAndRefreshIndex(
            attachmentTarget,
            attachments,
            editingAddAttachmentsRef.current,
            targetOverride,
          ),
      );
    },
    [selectedWorktree, targetOverride],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const attachmentTarget = targetOverride ?? selectedWorktree;
      if (!attachmentTarget) return;
      const items = event.clipboardData?.items;
      if (!items) return;

      const filePaths: string[] = [];
      const blobFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (!file) continue;
          if ('path' in file && typeof file.path === 'string' && file.path) {
            filePaths.push(file.path);
          } else {
            blobFiles.push(file);
          }
        }
      }
      if (filePaths.length === 0 && blobFiles.length === 0) return;

      event.preventDefault();

      void createClipboardAttachments(blobFiles, 'clipboard-image')
        .then((clipboardItems) =>
          importChatAttachments(attachmentTarget, filePaths, clipboardItems),
        )
        .then((attachments) => {
          addPendingAttachmentsAndRefreshIndex(
            attachmentTarget,
            attachments,
            editingAddAttachmentsRef.current,
            targetOverride,
          );
        })
        .catch(() => {
          addToast(ATTACHMENT_IMPORT_ERROR_MESSAGE, 'error', undefined, {
            category: 'Chat',
          });
        });
    },
    [addToast, selectedWorktree, targetOverride],
  );

  const dropContainerRef = useRef<HTMLDivElement>(null);
  const selectedWorktreeRef = useRef(selectedWorktree);
  selectedWorktreeRef.current = selectedWorktree;
  const targetOverrideRef = useRef(targetOverride);
  targetOverrideRef.current = targetOverride;

  // Files dropped anywhere on the chat attach to this composer; the chat
  // dims while they are dragged over it. The queued-message editor keeps
  // drops on its own box for the message it edits.
  const fileDrop = useChatFileDrop({
    boxRef: dropContainerRef,
    rootRef: composerRootRef,
    enabled: !readOnly,
    ownBoxOnly: isEditingQueued,
    onDropFiles: (files): void => {
      const wt = targetOverrideRef.current ?? selectedWorktreeRef.current;
      if (!wt) return;

      const filePaths: string[] = [];
      const blobFiles: File[] = [];
      for (const file of files) {
        if ('path' in file && typeof file.path === 'string' && file.path) {
          filePaths.push(file.path);
        } else {
          blobFiles.push(file);
        }
      }

      void createClipboardAttachments(blobFiles, 'dropped-file')
        .then((clipboardItems) =>
          importChatAttachments(wt, filePaths, clipboardItems),
        )
        .then((attachments) => {
          addPendingAttachmentsAndRefreshIndex(
            wt,
            attachments,
            editingAddAttachmentsRef.current,
            targetOverrideRef.current,
          );
        })
        .catch(() => {
          addToast(ATTACHMENT_IMPORT_ERROR_MESSAGE, 'error', undefined, {
            category: 'Chat',
          });
        });
    },
  });

  const bottomRowRef = useRef<HTMLDivElement>(null);
  const [isCompact, setIsCompact] = useState(false);
  // A narrow box draws its chips small: Plan and watchers as icons, a
  // scheduled send as its time.
  const [chipsCompact, setChipsCompact] = useState(false);
  useLayoutEffect(() => {
    // Measure the composer box: on one line the toolbar row has no box of
    // its own (`display: contents`), so it cannot be observed.
    const el = dropContainerRef.current;
    if (!el) return;
    const updateCompactState = (width: number): void => {
      if (width <= 0) return;
      const rootFontSize = Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      const compactBreakpoint = COMPACT_TOOLBAR_BREAKPOINT_REM * rootFontSize;
      const compactHysteresis = COMPACT_TOOLBAR_HYSTERESIS_REM * rootFontSize;
      setIsCompact((prev) =>
        prev
          ? width < compactBreakpoint + compactHysteresis
          : width < compactBreakpoint,
      );
      const chipsBreakpoint = COMPACT_CHIPS_BREAKPOINT_REM * rootFontSize;
      setChipsCompact((prev) =>
        prev
          ? width < chipsBreakpoint + compactHysteresis
          : width < chipsBreakpoint,
      );
    };
    updateCompactState(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateCompactState(entry.contentRect.width);
    });
    observer.observe(el);
    const scaleObserver = new MutationObserver(() => {
      updateCompactState(el.getBoundingClientRect().width);
    });
    scaleObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-ui-scale'],
    });
    return (): void => {
      observer.disconnect();
      scaleObserver.disconnect();
    };
  }, [readOnly, tab?.id]);

  // One line by default; anything else that lives in the box (attachments,
  // selections) needs the full layout. Chips beside + (Plan, a scheduled
  // send, watchers) and the terminal mode label share the one line until
  // they leave the text too little room; then they take the row under it.
  const composerSideContentKey = [
    planReady ? 'plan-ready' : planMode ? 'plan' : '',
    showScheduledSendDraft && scheduledSendDraft
      ? `scheduled:${scheduledSendDraft.runAt}:${scheduleSendError ?? ''}`
      : '',
    !isEditingQueued && watcherDestination !== null
      ? `watchers:${chatInputWatchers.length}`
      : '',
    isTerminalMode
      ? `terminal:${terminalModeError ?? ''}:${scriptTypeahead.hint ?? ''}`
      : '',
    chipsCompact ? 'compact' : '',
  ].join('|');
  // Only chips can crowd the text. With none beside it, the one line keeps
  // its text slot however narrow it gets (the placeholder truncates), so a
  // panel still widening as it opens never flips the layout under typing.
  const composerHasSideChips =
    planMode ||
    planReady ||
    (showScheduledSendDraft && scheduledSendDraft !== null) ||
    (!isEditingQueued &&
      watcherDestination !== null &&
      chatInputWatchers.length > 0) ||
    isTerminalMode;
  const composerInline = useOneLineComposer({
    boxRef: dropContainerRef,
    hasDraftText: serializedDraft.text.length > 0,
    allowed:
      !isEditingQueued &&
      // A prompt lays out its own rows.
      !promptOpen &&
      // A take shows its words above the recording row.
      !voiceRecording &&
      pendingSelections.length === 0 &&
      pendingAttachments.length === 0 &&
      // Catalog selections awaiting setup get their own row above the text.
      !effectivePluginSelections?.unresolvedCapabilities?.length,
    draftRevision: value,
    minTextWidth: composerHasSideChips
      ? CHAT_COMPOSER_MIN_TEXT_WIDTH_PX
      : undefined,
    sideContentKey: composerSideContentKey,
  });
  // The selectors under the box keep their labels until that row runs out
  // of room, independently of the box's own narrow layout.
  const statusRowRef = useRef<HTMLDivElement>(null);
  // A Claude chat's interface modes, offered in the + menu under View.
  const claudeTuiChatsEnabled = useClaudeTuiChatsEnabled();
  const interfaceModeOptions =
    interfaceModeControl?.providerIsClaude && claudeTuiChatsEnabled
      ? resolveChatInterfaceModeOptions(interfaceModeControl)
      : undefined;
  useAnimatedComposerBox(
    dropContainerRef,
    `${String(readOnly)}:${tab?.id ?? ''}`,
  );

  const [composerDensity, setComposerDensity] =
    useState<ComposerDensity>('comfortable');
  useLayoutEffect(() => {
    if (isEditingQueued) {
      // The inline queued-message editor renders inside the transcript
      // content stack (QueuedMessageEditor via ChatMessageList), so its
      // composer-root parent is content-sized, not the panel/surface height.
      // Pin it to the full-size density instead of reacting to that
      // unrelated ancestor's height.
      setComposerDensity('comfortable');
      return undefined;
    }
    const node = composerRootRef.current;
    // The composer and the transcript column are siblings inside the
    // height-constrained `flex flex-col` wrapper that each ChatContent
    // caller provides (through ChatContent's `display: contents` root), so
    // that wrapper's height is the panel/surface height and does not change
    // when the composer shrinks — no measure→shrink→remeasure feedback loop.
    const panel = findComposerDensityPanel(node);
    if (!panel || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const applyHeight = (height: number): void => {
      setComposerDensity((prev) => resolveComposerDensity(height, prev));
    };
    applyHeight(panel.getBoundingClientRect().height);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      applyHeight(entry.contentRect.height);
    });
    observer.observe(panel);
    return (): void => {
      observer.disconnect();
    };
  }, [readOnly, tab?.id, isEditingQueued]);

  const handleApprove = useCallback(() => {
    if (pendingExit) {
      approvePlanExit(pendingExit.requestId);
    }
  }, [pendingExit, approvePlanExit]);

  // Open the pending plan's Plan panel beside this chat. The plan is created
  // from the pending text when its tracked id was never persisted (seeded tab
  // state), so the panel always has a plan to show.
  const handleExplorePlan = useCallback(async (): Promise<void> => {
    if (
      !pendingExit ||
      !pendingExit.projectId ||
      !pendingExit.worktreeId ||
      !trackedPlanId
    ) {
      return;
    }
    const { projectId, worktreeId } = pendingExit;
    try {
      await openPendingPlanExit(
        {
          projectId,
          worktreeId,
          chatId: pendingExit.chatId,
          source: pendingExit.source,
          content: getPendingPlanText(pendingExit),
        },
        trackedPlanId,
      );
    } catch (error: unknown) {
      addToast(
        error instanceof Error ? error.message : 'Failed to open plan',
        'error',
        undefined,
        { category: 'Chat', projectId, worktreeId },
      );
    }
  }, [pendingExit, trackedPlanId, addToast]);

  // The plan prompt moves the editor into its text row and back, so focus
  // follows it once the box has re-rendered.
  const focusEditorAfterPlanCardRef = useRef(false);
  const closePlanCard = useCallback((): void => {
    focusEditorAfterPlanCardRef.current = true;
    setClosedPlanRequestKey(planRequestKey);
  }, [planRequestKey]);
  const reopenPlanCard = useCallback((): void => {
    focusEditorAfterPlanCardRef.current = true;
    setClosedPlanRequestKey(null);
  }, []);
  const closeQuestionPrompt = useCallback((): void => {
    focusEditorAfterPlanCardRef.current = true;
    setClosedQuestionRequestId(activeQuestion?.requestId ?? null);
  }, [activeQuestion?.requestId]);
  const reopenQuestionPrompt = useCallback((): void => {
    focusEditorAfterPlanCardRef.current = true;
    setClosedQuestionRequestId(null);
  }, []);
  useEffect(() => {
    if (!focusEditorAfterPlanCardRef.current) return;
    focusEditorAfterPlanCardRef.current = false;
    focusEditor(editor);
  }, [planCardOpen, questionPromptOpen, editor]);

  // A prompt that shows (a question, its next step, or a waiting plan) puts
  // the cursor in the composer's input, ready for a typed answer or note. It
  // never takes focus from another field or terminal the user is typing in.
  const promptFocusKey = questionPromptOpen
    ? `question:${activeQuestion?.requestId ?? ''}:${questionPrompt.prompt.step}`
    : planCardOpen
      ? `plan:${planRequestKey ?? ''}`
      : null;
  // A question step with its own field focuses that field instead
  // (QuestionPrompt).
  const promptFocusesEditor =
    !questionPromptOpen || questionPrompt.prompt.kind !== 'field';
  useEffect(() => {
    if (promptFocusKey === null || !promptFocusesEditor) return;
    // The prompt moves the editor into its text row: wait for Slate to
    // render it there before focusing.
    const frame = requestAnimationFrame(() => {
      if (!isComposerVisible()) return;
      if (!isTypingOutside(composerRootRef.current)) focusEditor(editor);
    });
    return (): void => cancelAnimationFrame(frame);
  }, [promptFocusKey, promptFocusesEditor, editor, isComposerVisible]);

  const planReviewClosed =
    trackedPlanReviewStatus !== undefined &&
    trackedPlanReviewStatus !== 'pending';
  const {
    planImplementation: planImplementationAllowed,
    planPipeline: planPipelineAllowed,
  } = deriveChatWorkflowCapabilities({
    resolvedProvider:
      pendingExit?.source ??
      (typeof pendingExit?.toolInput.source === 'string'
        ? pendingExit.toolInput.source
        : 'claude'),
    interfaceMode: tab?.interfaceMode ?? 'canopy',
    target: 'worktree',
    capabilities: ipcCanopyClient.capabilities,
  });
  const planApprovalOptions: readonly PlanApprovalOption[] = [
    {
      label: planImplementationAllowed
        ? 'Yes, implement this plan'
        : 'Implementation unavailable',
      onSelect: handleApprove,
      disabled: planReviewClosed || !planImplementationAllowed,
      testId: 'chat-plan-implement',
    },
    ...(planPipelineAllowed
      ? [
          {
            label: 'Run it as a pipeline',
            onSelect: (): void => setPipelineModalOpen(true),
            disabled: planReviewClosed,
            testId: 'chat-plan-pipeline',
          },
        ]
      : []),
  ];

  const planPipelineWatcher = usePipelineRunWatcher(
    pendingExit?.projectId && pendingExit?.worktreeId
      ? {
          projectId: pendingExit.projectId,
          worktreeId: pendingExit.worktreeId,
        }
      : null,
  );

  const handlePipelineRun = useCallback(
    async (
      _pipelineId: string,
      pipeline: PipelineData,
      inputs: Record<string, string> | undefined,
      selectedRepoId: string | undefined,
      pluginCollectionContext: PipelinePluginCollectionContext,
    ): Promise<void> => {
      if (!pendingExit || !planPipelineAllowed) return;

      const planText = getPendingPlanText(pendingExit);

      let cwd = '';
      if (pendingExit.projectId && pendingExit.worktreeId) {
        cwd = await window.api.getWorktreePath({
          projectId: pendingExit.projectId,
          worktreeId: pendingExit.worktreeId,
          repoId: selectedRepoId,
        });
      }

      setPipelineRunning(true);
      setPipelineRunError(null);

      // Execute the pipeline and only dismiss plan approval on success
      let result: { success: boolean; error?: string; data?: { id?: string } };
      try {
        const appAdvisorPipelineWatchers =
          planPipelineWatcher.appAdvisorPipelineWatchers();
        result = await window.pipelines.execute(pipeline.content, {
          cwd,
          pipelineId: pipeline.info.id,
          pipelineFilePath:
            pipeline.info.source === 'project'
              ? pipeline.info.filePath
              : undefined,
          repoPath: pipeline.info.source === 'project' && cwd ? cwd : undefined,
          projectId: pendingExit.projectId,
          worktreeId: pendingExit.worktreeId,
          chatId: pendingExit.chatId,
          planId: trackedPlanId,
          eventName: 'plan_ready',
          eventData: {
            plan_ready: { plan_text: planText },
          },
          ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
          pluginCollectionPreferences: pluginCollectionContext.preferences,
          ...(pluginCollectionContext.modelAliasPreferences
            ? {
                modelAliasPreferences:
                  pluginCollectionContext.modelAliasPreferences,
              }
            : {}),
          modelConfig: pluginCollectionContext.modelConfig,
          ...(appAdvisorPipelineWatchers ? { appAdvisorPipelineWatchers } : {}),
          ...(pluginCollectionContext.pipelinePreferenceLocator
            ? {
                pipelinePreferenceLocator:
                  pluginCollectionContext.pipelinePreferenceLocator,
              }
            : {}),
          ...(pipeline.info.source === 'shared' &&
          pipeline.info.serverId &&
          pipeline.info.remoteId
            ? {
                sharedPipeline: {
                  serverId: pipeline.info.serverId,
                  remoteId: pipeline.info.remoteId,
                },
              }
            : {}),
        });
      } catch (err: unknown) {
        setPipelineRunning(false);
        setPipelineRunError(extractIpcErrorMessage(err));
        return;
      }

      setPipelineRunning(false);

      if (!result.success) {
        setPipelineRunError(result.error ?? 'Pipeline execution failed');
        return;
      }

      planPipelineWatcher.reset();
      dismissPlanForPipeline(pendingExit.requestId);
      setPipelineModalOpen(false);
    },
    [
      pendingExit,
      trackedPlanId,
      dismissPlanForPipeline,
      planPipelineWatcher,
      planPipelineAllowed,
    ],
  );

  const handleSelectCommand = useCallback(
    async (cmd: SlashCommandData): Promise<void> => {
      const insertSelection = (selected: typeof cmd): void => {
        composerMenu.consumeTrigger();
        Transforms.insertText(editor, getSlashCommandInsertText(selected));
      };
      if (
        ('disabledReason' in cmd && cmd.disabledReason !== undefined) ||
        readOnly
      )
        return;
      const action = getComposerAction(cmd);
      if (action) {
        const handlers: ComposerActionHandlers = {
          plugins: () => {
            void openPluginsModal();
          },
          attach: () => {
            void handleImportAttachments();
          },
          model: () => {
            if (composerShortcutTarget)
              requestModelPickerOpen(composerShortcutTarget);
          },
          thinking: handleCycleThinkingLevel,
          ...(pendingExit && planPipelineAllowed
            ? { pipeline: () => setPipelineModalOpen(true) }
            : {}),
          ...(canUsePlanMode
            ? { plan: () => togglePlanMode(targetOverride) }
            : {}),
          ...(supportsFastMode ? { fast: cycleSpeed } : {}),
          ...(showScheduleControls
            ? { schedule: () => setScheduleModalOpen(true) }
            : {}),
        };
        runComposerAction(action, {
          controller: composerMenu,
          handlers,
          syncDraft: syncEditorValue,
          onUnavailable: () =>
            addToast('This action is unavailable in this composer.', 'error'),
        });
        return;
      }
      const insertDiscovered = (): void => {
        insertSelection(cmd);
        syncEditorValue();
        focusEditor(editor);
      };

      // Available-to-enable rows: enable the underlying skill/plugin for this
      // chat (like the plugin picker), validate it live, then insert the
      // RESOLVED invocation text. Inherited rows take the same path for the
      // resolved id alone. Other discovered rows fall straight through.
      if (!inventoryRowNeedsResolution(cmd)) {
        insertDiscovered();
        return;
      }

      const showEnableError = (): void =>
        addToast(INVENTORY_ENABLE_ERROR_COPY, 'error', undefined, {
          category: 'Chat',
          ...(slashCommandTarget
            ? {
                projectId: slashCommandTarget.projectId,
                worktreeId: slashCommandTarget.worktreeId,
              }
            : {}),
          ...(tab ? { chatId: tab.id } : {}),
        });

      const entry = cmd.inventoryEntry;
      if (!entry || !slashCommandTarget || !tab || !inventoryProviderType) {
        showEnableError();
        return;
      }

      // The chat's checkout: Claude Code plugins installed for one
      // repository are inherited (and numbered) only there.
      const projectPath = await window.api
        .getWorktreePath({
          projectId: slashCommandTarget.projectId,
          worktreeId: slashCommandTarget.worktreeId,
          repoId: selectedRepoId,
        })
        .catch((): string => '');
      await runInventorySelection({
        entry,
        providerType: inventoryProviderType,
        currentSelections: effectivePluginSelections ?? createEmptySelections(),
        ...(tabDisabledGlobalPluginSelections
          ? { chatTombstones: tabDisabledGlobalPluginSelections }
          : {}),
        ...(projectPath ? { projectPath } : {}),
        deps: {
          prepareCodexCompatibilityPlugin: (marketplaceId, pluginName) =>
            window.plugins.prepareCodexCompatibilityPlugin(
              marketplaceId,
              pluginName,
            ),
          resolveSelection: (request) =>
            window.invocableInventory.resolveSelection(request),
          applySelections: (next) =>
            setPluginSelections(
              stripAgentOnlyChatPluginSelections(
                next,
                agentPluginSelections,
                pluginSelections,
              ),
              targetOverride,
            ),
          insertResolvedText: (insertText) => {
            // Reuse the trigger-range replacement with the resolved value.
            insertSelection({ ...cmd, insertText });
            syncEditorValue();
            focusEditor(editor);
          },
          onError: showEnableError,
          refreshInventory: () => {
            void invocableInventory.refresh();
          },
        },
      });
    },
    [
      readOnly,
      composerMenu,
      openPluginsModal,
      handleImportAttachments,
      composerShortcutTarget,
      handleCycleThinkingLevel,
      canUsePlanMode,
      togglePlanMode,
      supportsFastMode,
      cycleSpeed,
      showScheduleControls,
      planPipelineAllowed,
      pendingExit,
      addToast,
      editor,
      inventoryProviderType,
      effectivePluginSelections,
      invocableInventory,
      agentPluginSelections,
      pluginSelections,
      setPluginSelections,
      slashCommandTarget,
      syncEditorValue,
      selectedRepoId,
      tabDisabledGlobalPluginSelections,
      tab,
      targetOverride,
    ],
  );

  const handleCommandSelect = useCallback(
    (cmd: SlashCommandData) => {
      void handleSelectCommand(cmd);
    },
    [handleSelectCommand],
  );

  const handleCheckStatus = useCallback(async () => {
    await verifyStreamingTabs();
    const currentWorktree = targetOverride
      ? {
          projectId: targetOverride.projectId,
          worktreeId: targetOverride.worktreeId,
        }
      : useChatStore.getState().selectedWorktree;
    const currentTabId = tab?.id;
    if (!currentWorktree || !currentTabId) {
      return;
    }

    const currentKey = `${currentWorktree.projectId}/${currentWorktree.worktreeId}`;
    const currentTab = useChatStore
      .getState()
      .worktreeChats[
        currentKey
      ]?.tabs.find((candidate) => candidate.id === currentTabId);
    if (currentTab?.status !== 'streaming') {
      return;
    }

    try {
      await cancelSession(targetOverride);
    } catch {
      // cancel may fail if session already ended
    }
    if (onSendMessage) {
      void onSendMessage('Provide status update');
    } else {
      void sendMessage('Provide status update', undefined, targetOverride);
    }
  }, [
    cancelSession,
    onSendMessage,
    sendMessage,
    tab?.id,
    targetOverride,
    verifyStreamingTabs,
    useChatStore,
  ]);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // The `!` typeahead runs before send: Enter/Tab pick a script while it is
    // open, and an unmatched draft still sends raw.
    if (scriptTypeahead.handleKeyDown(e)) return;
    if (composerMenu.handleKeyDown(e)) return;
    // Cancel an active dictation session when the user hits Escape, and keep
    // any keystroke from staying marked as voice input.
    if (e.key === 'Escape' && voice.state !== 'idle') {
      e.preventDefault();
      dictationInputModeRef.current = 'typed';
      void voice.cancel();
      return;
    }
    if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') {
      dictationInputModeRef.current = 'typed';
    }

    if (!isEditingQueued && handleMessageHistoryKeyDown(e)) return;

    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) {
      e.preventDefault();
      handleSend();
    }
    // Cmd+Shift+Enter → approve plan exit (suppressed in edit-queued mode
    // since the plan-exit bar is hidden and Cancel/Save own the action row).
    if (
      !isEditingQueued &&
      e.key === 'Enter' &&
      e.shiftKey &&
      e.metaKey &&
      pendingExit
    ) {
      e.preventDefault();
      handleApprove();
    }
  };

  const handleStartNewSession = useCallback((): void => {
    setHandoffError(null);
    void handleStaleSessionStartNew().catch((err: unknown) => {
      setHandoffError(
        err instanceof Error ? err.message : 'Failed to start new session',
      );
    });
  }, [handleStaleSessionStartNew]);

  const handleHandOffSession = useCallback((): void => {
    if (handoffLoading) {
      return;
    }

    setHandoffLoading(true);
    setHandoffError(null);
    void handleStaleSessionHandOff()
      .catch((err: unknown) => {
        setHandoffError(
          err instanceof Error
            ? err.message
            : 'Failed to create handoff summary',
        );
      })
      .finally(() => {
        setHandoffLoading(false);
      });
  }, [handoffLoading, handleStaleSessionHandOff]);

  const showChatInputWatcherButton =
    !isEditingQueued &&
    watcherDestination !== null &&
    chatInputWatchers.length > 0;
  // Expanded, the editor sizes to its text like the one-line composer;
  // the density step only caps its height on short panels.
  const expandedEditorContainerClassName =
    expandedComposerEditorContainerClassName(composerDensity);
  const slateContainerClassName = `${expandedEditorContainerClassName}${
    voiceRecording ? ` ${VOICE_TAKE_EDITOR_CONTAINER_CLASS}` : ''
  }`;

  const voiceAvailable = voiceSupported && voiceEnabledPref;
  const renderVoiceButton = (primary: boolean): JSX.Element | null =>
    voiceAvailable ? (
      <VoiceInputButton
        state={voice.state}
        error={voice.error}
        onStart={(): void => void voice.start()}
        onStop={(): void => void voice.stop()}
        disabled={isTerminalMode || sandbox}
        capsule
        primary={primary}
        shortcut={DICTATION_SHORTCUT_LABEL}
      />
    ) : null;

  // Terminal mode keeps the default box and adds its dashed warning edge,
  // red while the last command could not be sent.
  const shellClasses = isTerminalMode
    ? `${CHAT_COMPOSER_SHELL_CLASS} ${
        terminalModeError === null
          ? TERMINAL_MODE_SHELL_CLASS
          : TERMINAL_MODE_ERROR_SHELL_CLASS
      }`
    : CHAT_COMPOSER_SHELL_CLASS;
  const containerClasses = promptOpen
    ? `${shellClasses} ${PLAN_APPROVAL_BOX_CLASS}`
    : composerInline
      ? `${shellClasses} ${ONE_LINE_COMPOSER_CLASS_NAMES.box}`
      : `${shellClasses} ${ONE_LINE_COMPOSER_CLASS_NAMES.expandedBox}`;

  const readOnlySessionActions = (
    <>
      <NoticeButton
        data-testid="read-only-start-new-session"
        onClick={handleStartNewSession}
        disabled={handoffLoading}
      >
        Start new session
      </NoticeButton>
      <NoticeButton
        data-testid="read-only-hand-off-session"
        onClick={handleHandOffSession}
        disabled={handoffLoading}
      >
        {handoffLoading ? 'Handing off…' : 'Hand off session'}
      </NoticeButton>
    </>
  );

  if (readOnly) {
    return (
      <div
        ref={composerRootRef}
        data-chat-composer-root
        className="relative z-30 mx-auto w-full max-w-[var(--chat-composer-shell-width)] chat-width-transition shrink-0 px-4 pb-4 pt-2"
      >
        {/* The banners above the composer, in place of the box. */}
        <NoticeShapeProvider shape="composer">
          {staleSessionDetected ? (
            <Notice
              intent="attention"
              title="This session can no longer be resumed"
              {...(handoffError ? { detail: handoffError } : {})}
              actions={readOnlySessionActions}
            >
              Your last message was not delivered.
            </Notice>
          ) : (
            <Notice
              intent="neutral"
              role="none"
              title="This session has been archived"
              {...(handoffError ? { detail: handoffError } : {})}
              actions={readOnlySessionActions}
            >
              Messages are read-only.
            </Notice>
          )}
        </NoticeShapeProvider>
      </div>
    );
  }

  // The editor and the controls around it, laid out by the box below: in
  // the box itself, or in the plan-approval prompt's text row.
  const composerEditor = (
    <ComposerEditor
      editor={editor}
      value={value}
      onChange={handleEditorChange}
      onSelectionChange={handleSelectionChange}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      monospace={isTerminalMode}
      density="minimal"
      className={
        composerInline || promptOpen
          ? ONE_LINE_COMPOSER_CLASS_NAMES.editor
          : undefined
      }
      containerClassName={
        promptOpen
          ? PLAN_APPROVAL_EDITOR_CONTAINER_CLASS
          : composerInline
            ? ONE_LINE_COMPOSER_CLASS_NAMES.editorContainer
            : slateContainerClassName
      }
      placeholder={
        voiceRecording
          ? 'Start talking…'
          : questionPromptOpen
            ? questionPromptPlaceholder
            : planCardOpen
              ? 'No, explain what to do differently'
              : isEditingQueued
                ? 'Edit queued message…'
                : isTerminalMode
                  ? '! shell command…'
                  : pendingExit
                    ? 'Enter your plan adjustments here…'
                    : isStreaming
                      ? 'Type to queue a follow-up message…'
                      : isAccountHarness
                        ? 'Send a message'
                        : defaultChatPlaceholder
      }
    />
  );
  const composerControls = voiceRecording ? (
    <VoiceRecordingRow
      readLevel={voice.readLevel}
      listeningSince={voice.listeningSince}
      onCancel={(): void => {
        dictationInputModeRef.current = 'typed';
        void voice.cancel();
      }}
      onStop={(): void => void voice.stop()}
      onSend={handleVoiceSend}
    />
  ) : (
    <ChatComposerToolbar
      dataTestId="chat-input-controls-row"
      capsuleLayout
      compact={isCompact}
      // In the plan prompt's text row the controls sit on its one line, as
      // on the one-line composer.
      inline={composerInline || promptOpen}
      rowRef={bottomRowRef}
      leadingSlot={
        <div
          // The prompt shows no +, but + stays mounted out of view: its menu
          // is the popup @, / and $ open over the box, there as here.
          className={
            promptOpen
              ? 'sr-only'
              : composerInline
                ? `relative shrink-0 ${ONE_LINE_COMPOSER_CLASS_NAMES.leading}`
                : 'relative shrink-0'
          }
          inert={promptOpen}
          data-chat-cancel-shortcut-ignore={
            composerMenu.open ? 'true' : undefined
          }
        >
          {/* Non-interactive anchor for composer submenus. `FloatingMenu` attaches an
                  ArrowDown/ArrowUp open listener to its anchor, so anchoring the
                  popup on the wrapper that CONTAINS the `+` button gave ArrowDown a
                  second meaning: the button's keydown bubbled to the wrapper and
                  opened both surfaces. This span shares the wrapper's box (so
                  placement is unchanged) without containing the trigger. */}
          <span
            ref={composerPopupAnchorRef}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
          />
          <ComposerPlusMenu
            onPickAttachment={(): void => void handleImportAttachments()}
            onPickLinear={() => setLinearPickerOpen(true)}
            disabled={isTerminalMode || sandbox}
            dataTestIdPrefix="chat-input"
            // The pickers' spacing: clear of the composer, like the
            // model and approval menus.
            gap={FLOATING_PICKER_GAP}
            triggerRef={plusTriggerRef}
            capsuleTrigger
            controller={composerMenu}
            searchFiles={searchComposerFiles}
            onSelectFile={(file) =>
              composerMenu.insertFile(file, fileRepos.length)
            }
            commands={composerCommands}
            pluginSelections={effectivePluginSelections}
            providerScope={effectiveProviderType ?? 'mixed'}
            onSelectPlugin={(ref, { label, enabled }) => {
              // The mention pill lands regardless of enablement state so
              // an already-enabled plugin can still be called out inline.
              composerMenu.insertPlugin({ ...ref, label });
              syncEditorValue();
              if (!enabled) void enablePluginsForChat([ref]);
            }}
            onSelectCommand={handleCommandSelect}
            isRefreshing={isRefreshing || fileIndexLoading}
            additionalItems={buildChatComposerPlusItems({
              onOpenPlugins: (): void => void openPluginsModal(),
              hasPluginSelections,
              ...(canUsePlanMode
                ? {
                    plan: {
                      on: planMode,
                      readOnly: workflowGates.planModeReadOnly,
                      disabled:
                        isTerminalMode || (isAccountHarness && isStreaming),
                      onToggle: (): void => togglePlanMode(targetOverride),
                    },
                  }
                : {}),
              ...(showScheduleControls
                ? { onSchedule: (): void => setScheduleModalOpen(true) }
                : {}),
              ...(interfaceModeOptions && interfaceModeControl
                ? {
                    interfaceModes: {
                      options: interfaceModeOptions,
                      onSelect: interfaceModeControl.onChange,
                    },
                  }
                : {}),
            })}
          />
        </div>
      }
      planMode={
        promptOpen
          ? undefined
          : questionReady
            ? buildQuestionReadyChip({
                compact: chipsCompact,
                onOpen: reopenQuestionPrompt,
              })
            : planReady
              ? buildPlanReadyChip({
                  compact: chipsCompact,
                  onOpen: reopenPlanCard,
                })
              : planMode
                ? buildPlanModeChip({
                    readOnly: workflowGates.planModeReadOnly,
                    compact: chipsCompact,
                    disabled:
                      isTerminalMode || (isAccountHarness && isStreaming),
                    onDisable: (): void => {
                      togglePlanMode(targetOverride);
                      focusEditor(editor);
                    },
                  })
                : undefined
      }
      scheduledSendSlot={
        !promptOpen && showScheduledSendDraft && scheduledSendDraft ? (
          <ScheduledSendChip
            runAt={scheduledSendDraft.runAt}
            error={scheduleSendError}
            editable={supportsScheduledSends}
            compact={chipsCompact}
            onEdit={(): void => setScheduleModalOpen(true)}
            onClear={handleClearScheduledSend}
          />
        ) : null
      }
      watchersSlot={
        !promptOpen && showChatInputWatcherButton && watcherDestination ? (
          <WatcherManagementButton
            watchers={chatInputWatchers}
            modalTitle="Chat watchers"
            modalEmptyMessage="No active watchers for this chat."
            ariaLabel="Manage chat watchers"
            dataTestId={`chat-input-watchers-${watcherDestination.chatId}`}
            icon="bigtop"
            tooltipTitle="WATCHING"
            appearance="composer-chip"
          />
        ) : null
      }
      terminalLabelSlot={
        isTerminalMode ? (
          <TerminalModeLabel
            error={terminalModeError}
            hint={scriptTypeahead.hint}
          />
        ) : null
      }
      trailingSlot={
        // Editing a queued message, Cancel and Save take send's place,
        // as capsules at send's height. Otherwise (the plan prompt's text
        // row too) the microphone sits beside the trailing action, and
        // with an empty draft it takes that place as the primary action
        // instead of a disabled send. A shell command is typed, not
        // dictated: no microphone.
        isEditingQueued && editingState ? (
          <>
            <Button
              size="md"
              variant="secondary"
              onClick={editingState.onCancel}
              data-testid="queued-message-edit-cancel"
            >
              Cancel
            </Button>
            <Button
              size="md"
              variant="primary"
              onClick={handleSend}
              data-testid="queued-message-edit-save"
              disabled={!serializedDraft.text.trim()}
            >
              Save
            </Button>
          </>
        ) : isTerminalMode ? (
          <ComposerSendButton
            kind="terminal"
            onRun={handleSend}
            disabled={!terminalCommand}
            failed={terminalModeError !== null}
          />
        ) : questionPromptOpen &&
          (questionPrompt.prompt.skips(serializedDraft.text) ||
            questionPrompt.prompt.sendAnswers(serializedDraft.text)) ? (
          // An open question owns the trailing action, even mid-turn: stop
          // returns once the question is closed (x or Esc).
          // Until something is answered, Skip takes send's place.
          <>
            {renderVoiceButton(false)}
            {questionPrompt.prompt.skips(serializedDraft.text) ? (
              <QuestionSkipButton
                busy={questionPrompt.busy}
                disabled={questionPrompt.disconnected}
                onSkip={questionPrompt.skip}
              />
            ) : (
              <ComposerSendButton
                kind="send"
                onSend={handleSend}
                disabled={
                  !questionPrompt.prompt.canSend(serializedDraft.text) ||
                  questionPrompt.busy !== null ||
                  questionPrompt.disconnected
                }
                pending={false}
                dataTestId="chat-question-send"
              />
            )}
          </>
        ) : isStreaming ? (
          <>
            {renderVoiceButton(false)}
            <ComposerSendButton
              kind="stop"
              onStop={(): void => void cancelSession(targetOverride)}
              pending={pendingModelChange !== undefined}
              armed={cancelShortcutArmed}
              shortcutReady={composerShortcutsEnabled}
            />
          </>
        ) : voiceAvailable &&
          !serializedDraft.text.trim() &&
          pendingModelChange === undefined ? (
          renderVoiceButton(true)
        ) : (
          <>
            {renderVoiceButton(false)}
            <ComposerSendButton
              kind="send"
              onSend={handleSend}
              disabled={!serializedDraft.text.trim() || isResourceGuardBlocked}
              pending={pendingModelChange !== undefined}
              {...(isResourceGuardBlocked
                ? {
                    blockedReason: resourceGuardMessage ?? 'Send message',
                  }
                : {})}
            />
          </>
        )
      }
    />
  );

  // A prompt's text row: the composer's own editor, microphone, and send.
  const promptTextRow = voiceRecording ? (
    <div className="flex min-w-0 flex-1 flex-col">
      {composerEditor}
      {composerControls}
    </div>
  ) : (
    <>
      {composerEditor}
      {composerControls}
    </>
  );

  return (
    <div
      ref={composerRootRef}
      data-chat-composer-root
      data-testid={isEditingQueued ? 'queued-message-editor' : undefined}
      data-composer-density={composerDensity}
      data-question-prompt={questionPromptOpen}
      // Under the controls row the panel edge sits as far from the controls
      // as the composer box does above them (8px each side).
      className={`relative z-30 mx-auto w-full max-w-[var(--chat-composer-shell-width)] chat-width-transition shrink-0 px-4 pt-2 ${
        isEditingQueued ? 'pb-4' : 'pb-2'
      }`}
    >
      {/*
        Guidance and its dismissal are owned by the hook, which resets them on
        every attempt. Keying dismissal on the error message here used to
        silence this modal permanently: a denied microphone reports the same
        string on every retry.
      */}
      <VoiceDictationErrorModal
        guidance={voice.errorGuidance}
        onDismiss={voice.dismissError}
      />
      {/* Composer notices: the shared stack owns their spacing and composer
          corners, and collapses when none render. Every notice is the shared
          `Notice` primitive. */}
      <ComposerNoticeStack data-testid="chat-input-notices">
        {/* Resource-guard warning (chat send blocked by memory pressure or concurrency cap) */}
        {!isEditingQueued && resourceGuardMessage && (
          <Notice
            intent="attention"
            title="Sending paused"
            data-testid="chat-input-resource-guard-warning"
            actions={
              <NoticeButton
                variant="secondary"
                onClick={(): void => openSettings('performance')}
                data-testid="chat-input-resource-guard-settings-link"
              >
                Open performance settings
              </NoticeButton>
            }
          >
            {resourceGuardMessage}
          </Notice>
        )}

        {/* Completed turn that produced nothing (CAN-2307). Sits above the
              stuck-agent warning: this one describes a turn that is already
              over, so it names the state the user is actually in. */}
        {!isEditingQueued &&
          sessionChatTarget !== null &&
          emptyCompletionRecovery !== undefined && (
            <EmptyCompletionRecoveryNotice
              recovery={emptyCompletionRecovery}
              busy={emptyCompletionBusy}
              error={emptyCompletionError}
              onResume={(): void => {
                void dispatchEmptyCompletionRecovery('resume');
              }}
              onRetry={(): void => {
                void dispatchEmptyCompletionRecovery('retry');
              }}
            />
          )}

        {!isEditingQueued &&
          sessionChatTarget !== null &&
          effectiveProviderType === 'claude' &&
          tab?.status === 'error' &&
          isClaudeTurnLimitMessage(tab.error) && (
            <Notice
              intent="destructive"
              title="Claude turn limit reached"
              data-testid="claude-turn-limit-notice"
              {...(turnLimitResumeError
                ? { detail: turnLimitResumeError }
                : {})}
              actions={
                <>
                  <NoticeButton
                    variant="primary"
                    disabled={turnLimitResumeBusy}
                    onClick={(): void => {
                      void resumeTurnLimit();
                    }}
                    data-testid="claude-turn-limit-resume"
                  >
                    Resume
                  </NoticeButton>
                  <NoticeButton onClick={(): void => openSettings('claude')}>
                    Claude settings
                  </NoticeButton>
                </>
              }
            >
              Resume to continue where Claude left off.
            </Notice>
          )}

        {/* Explicit Resume for a turn the user stopped (CAN-3137). */}
        {!isEditingQueued &&
          sessionChatTarget !== null &&
          stoppedTurnResumeUserMessageId !== undefined && (
            <StoppedTurnResumeNotice
              {...(tab?.stoppedTurnResumeError
                ? { error: tab.stoppedTurnResumeError }
                : {})}
              onResume={(): void => {
                void resumeStoppedTurn(sessionChatTarget);
              }}
            />
          )}

        {/* Stuck agent warning */}
        {!isEditingQueued && stuckMinutes !== null && (
          <Notice
            intent="attention"
            title={`No response for ${String(stuckMinutes)} ${
              stuckMinutes === 1 ? 'minute' : 'minutes'
            }`}
            data-testid="stuck-agent-warning"
            actions={
              <NoticeButton variant="secondary" onClick={handleCheckStatus}>
                Check status
              </NoticeButton>
            }
          >
            The agent might be stuck.
          </Notice>
        )}

        {/* Shared, universal AI Credits usage-limit + routing-status banners.
            Driven by the target-keyed store (fed authoritatively by the main
            process), so they render on every chat surface. Existing-session
            scheduling and code-worktree-only actions are passed independently.
            The usage-limit notice yields to the routing-status card whenever
            that card shows, so the two never offer and confirm credits at
            once (CAN-4757). */}
        {!isEditingQueued && (
          <>
            <AiCreditsUsageLimitBanner
              target={bannerTarget}
              aiCreditsCardVisible={billingResolution.aiCreditsBannerVisible}
              {...(worktreeChatTarget
                ? { onUseJustThisTime: handleUseAiCreditsJustThisTime }
                : {})}
              {...(canScheduleUsageLimitResume
                ? {
                    scheduleResume: {
                      onSchedule: (): void => {
                        void handleScheduleResume();
                      },
                      inFlight: scheduleResumeInFlight,
                      disabled: existingResumeAutomation !== undefined,
                      error: scheduleResumeError,
                      scheduledForLabel: formatUsageLimitTimeLabel(
                        existingResumeAutomation?.nextRunAt,
                      ),
                    },
                  }
                : {})}
            />
            <TransientRetryBanner target={bannerTarget} />
            <AiCreditsRoutingStatusBanner
              target={bannerTarget}
              active={billingResolution.aiCreditsBannerVisible}
              turnActive={isStreaming}
              {...(billingProvider === 'claude' || billingProvider === 'codex'
                ? { provider: billingProvider }
                : {})}
              {...(handleSwitchToSubscription
                ? { onSwitchToSubscription: handleSwitchToSubscription }
                : {})}
              {...(billingAccountChangedAt !== undefined
                ? { accountChangedAt: billingAccountChangedAt }
                : {})}
            />
            <OllamaConnectionBanner target={bannerTarget} />
            {/* An org gateway the member has no working key for. Reads its own
                state rather than the target-keyed store: nothing has failed at
                runtime yet — the point is to catch it BEFORE the first turn. */}
            <ModelGatewayKeyBanner
              selectedGatewayOrganizationId={selectedGatewayOrganizationId}
            />
            <ApprovalsUpgradeNotice />
            {/* An org whose trial ended stops funding its members the moment it
                lapses (CAN-2311). Names the specific org, and stays silent when
                a healthy org or a personal balance still covers the turn.

                Rendered BEFORE the generic no-billing-source banner because the
                two describe the same dead end for a member of a lapsed org (the
                lapse zeroes the org credit pool), with different next actions.
                The one that names the cause wins the composer while it is up;
                the generic self-serve remedies below take over as soon as it is
                dismissed or the org is restored. */}
            <OrgLapsedBanner
              provider={billingProvider}
              target={bannerTarget}
              nativeAuth={providerAvailability[billingProvider].nativeAuth}
              availabilityLoading={
                providerAvailability[billingProvider].loading
              }
              onVisibleChange={setOrgLapseVisible}
            />
            {/* Neither a native login nor spendable credits: nothing can pay for
                the next turn, and the raw provider `Please run /login` names only
                one of the two remedies. Surfaces both up front (ECW-9091). */}
            {/* `target` feeds the runtime path: a turn that already died on an
                empty credit balance shows the banner even when the derived
                pre-flight condition says the user is fine (CAN-2413).
                `gatewayOnlyModel` uses the same helper as the billing toggle's
                `lockKind: 'gateway-only-model'`, so the banner and the toggle
                never disagree about whether a native login is a remedy. */}
            <NoBillingSourceBanner
              provider={billingProvider}
              availability={providerAvailability[billingProvider]}
              orgLapseVisible={orgLapseVisible}
              target={bannerTarget}
              gatewayOnlyModel={isGatewayOnlyModel(modelForBilling)}
              effectiveBillingFramework={billingResolution.framework ?? null}
              noDispatchableModel={noDispatchableModel}
            />
          </>
        )}

        {/* Plan detection banner */}
        {!isEditingQueued && worktreeChatTarget && (
          <PlanDetectionBanner
            projectId={worktreeChatTarget.projectId}
            worktreeId={worktreeChatTarget.worktreeId}
            chatId={worktreeChatTarget.chatId}
          />
        )}

        {/* Suggests sharing a skill or plugin this chat keeps using. Session
              target so Cowork chats are covered too. */}
        {!isEditingQueued && sessionChatTarget && (
          <SkillShareNudgeBanner
            projectId={sessionChatTarget.projectId}
            worktreeId={sessionChatTarget.worktreeId}
            chatId={sessionChatTarget.chatId}
            streaming={isStreaming}
            isComposerVisible={isComposerVisible}
          />
        )}

        {/* A guest Try it chat whose capability needs an account. */}
        {!isEditingQueued && sessionChatTarget ? (
          <TryItSignInBanner
            target={sessionChatTarget}
            unresolvedCapabilities={
              effectivePluginSelections?.unresolvedCapabilities ?? []
            }
          />
        ) : null}

        {/* Offers to turn a request the user keeps repeating into a skill. */}
        {!isEditingQueued && sessionChatTarget && (
          <SkillSuggestionBannerHost
            projectId={sessionChatTarget.projectId}
            worktreeId={sessionChatTarget.worktreeId}
            chatId={sessionChatTarget.chatId}
            streaming={isStreaming}
            isComposerVisible={isComposerVisible}
          />
        )}

        {/* Recurring automations that target this chat. Session target, not
              the worktree target: Cowork and App Advisor chats schedule too. */}
        {!isEditingQueued && (
          <ScheduledAutomationsNotice target={sessionChatTarget} />
        )}
      </ComposerNoticeStack>

      {/* Docked tool-approval prompt(s) — replaces the previous in-transcript
          card mount. Renders above the composer for the active chat only;
          see `ToolApprovalDock.tsx` for the multi-approval navigation
          contract. */}
      {!isEditingQueued && bannerTarget && (
        <ToolApprovalDock
          projectId={bannerTarget.projectId}
          worktreeId={bannerTarget.worktreeId}
          chatId={bannerTarget.chatId}
        />
      )}

      {beforeComposer}

      <div
        ref={dropContainerRef}
        data-composer-layout={
          questionPromptOpen
            ? 'question'
            : planCardOpen
              ? 'plan-approval'
              : composerInline
                ? 'one-line'
                : 'full'
        }
        className={containerClasses}
        style={composerInline ? ONE_LINE_COMPOSER_BOX_STYLE : undefined}
        // Esc dismisses the `!` typeahead rather than stopping the turn.
        data-chat-cancel-shortcut-ignore={
          scriptTypeahead.open ? 'true' : undefined
        }
      >
        <span
          ref={composerMenu.anchorRef}
          aria-hidden
          className="pointer-events-none absolute inset-0"
        />
        {scriptTypeahead.enabled ? (
          <ScriptTypeaheadMenu
            typeahead={scriptTypeahead}
            anchorRef={composerMenu.anchorRef}
            boundaryRef={composerMenu.editorRef}
            returnFocusRef={composerMenu.editorRef}
            dataTestIdPrefix="chat-input-scripts"
          />
        ) : null}
        {/* The chat area dims while files are dragged over it. */}
        {fileDrop.dragging &&
          fileDrop.zone &&
          createPortal(<ChatDropOverlay />, fileDrop.zone)}
        <UnresolvedCapabilitySelection
          capabilities={effectivePluginSelections?.unresolvedCapabilities}
        />
        {/* Attachments lead the box, above the text: code selections first,
            then files, in one strip. */}
        {(pendingAttachments.length > 0 || pendingSelections.length > 0) && (
          <AttachmentPillCarousel
            leading={
              pendingSelections.length > 0 ? (
                <SelectionContextChips
                  selections={pendingSelections}
                  onReveal={handleRevealSelection}
                  onOpen={handleOpenSelection}
                  onRemove={handleRemoveSelection}
                  onFreshnessChange={handleSelectionFreshnessChange}
                />
              ) : undefined
            }
            attachments={pendingAttachments}
            onRemove={(absolutePath): void => {
              if (editingState) {
                editingState.onRemoveAttachment(absolutePath);
              } else {
                useChatStore
                  .getState()
                  .removePendingAttachment(absolutePath, targetOverride);
              }
            }}
          />
        )}

        {questionPromptOpen ? (
          <QuestionPrompt
            prompt={questionPrompt.prompt}
            busy={questionPrompt.busy}
            errorKind={questionPrompt.errorKind}
            disconnected={questionPrompt.disconnected}
            onRetry={questionPrompt.retry}
            onClose={closeQuestionPrompt}
          >
            {promptTextRow}
          </QuestionPrompt>
        ) : planCardOpen ? (
          <PlanApprovalPrompt
            options={planApprovalOptions}
            {...(trackedPlanId
              ? { onOpenPlan: (): void => void handleExplorePlan() }
              : {})}
            onClose={closePlanCard}
          >
            {promptTextRow}
          </PlanApprovalPrompt>
        ) : (
          <>
            {composerEditor}
            {composerControls}
          </>
        )}
      </div>

      {/* The queued-message editor edits text only and omits the row. */}
      {!isEditingQueued && (
        <ComposerStatusRow
          rowRef={statusRowRef}
          // The model and its effort lead the row and take its free width,
          // truncating as it narrows; the permission level and the usage
          // meter trail it at their own width.
          fill="start"
          start={
            <>
              <div
                ref={modelPickerHighlightRef}
                // Nothing on the row collapses: the model name truncates as
                // the row narrows, its icon folding away at the first ellipsis.
                className="flex min-w-0 items-center"
                aria-busy={pendingModelChange !== undefined}
                onClickCapture={(): void => {
                  if (modelPickerHighlight) {
                    useOnboardingSuggestionSurfaces.setState({
                      modelPickerHighlightTarget: null,
                    });
                  }
                }}
              >
                <ModelPicker
                  browserLayout="harnesses"
                  currentModel={
                    pendingModelChange?.model ?? model ?? fallbackModel
                  }
                  executionHarness={draftExecutionHarness}
                  onModelChange={handleModelChange}
                  {...(inheritedDefaultModel ? { inheritedDefaultModel } : {})}
                  allowCursor={allowCursor}
                  allowCopilot={allowCursor}
                  allowOpenCode={allowCursor}
                  {...(tab?.id ? { recoveryChatKey: tab.id } : {})}
                  onRecoveryCommit={handleRecoveryCommit}
                  {...(creditsScope ? { aiCreditsScope: creditsScope } : {})}
                  lockedProvider={lockedProvider}
                  lockedHarness={lockedHarness}
                  executionHarnessExplicitlyChosen={
                    tab?.executionHarnessExplicitlyChosen
                  }
                  lockedProviderBehavior={
                    continueEligibility?.ok === true ? 'continue' : 'disabled'
                  }
                  {...(continueEligibility &&
                  continueEligibility.ok === false &&
                  continueEligibility.code !== 'not-continuable'
                    ? { lockedProviderReason: continueEligibility.reason }
                    : {})}
                  providerAvailability={providerAvailability}
                  {...(autoPickerOption ? { auto: autoPickerOption } : {})}
                  {...(canStartNewChatWithModel
                    ? { onStartNewChat: handleStartNewChatWithModel }
                    : {})}
                  {...(billingControl ? { billing: billingControl } : {})}
                  capsule
                  // The menu sits over the row, left-aligned to the box.
                  allowTriggerShrink
                  foldTriggerIconWhenTight
                  foldTriggerIconOnTruncate
                  hideTriggerChevron
                  menuAlignRef={dropContainerRef}
                  menuAlignEdge="left"
                  // The composer already makes the chip's job plain.
                  triggerTooltip={null}
                  disabled={isTerminalMode}
                  openSignal={modelPickerOpenSignal}
                  onRestoreFocus={(): void => {
                    requestAnimationFrame(() => focusEditor(editor));
                  }}
                />
              </div>
              {modelPickerHighlight ? (
                <ComposerControlHighlight
                  target={modelPickerHighlightRef}
                  testId="chat-model-picker-highlight"
                />
              ) : null}
              {/* Tri-state contract: a model that declares an explicit empty
              supported set does not think at all, so the control is hidden
              entirely (matching the web composer's gating). An absent
              declaration already resolved to the provider fallback above. */}
              {supportedThinkingLevels.length > 0 ? (
                <ThinkingLevelPanelPicker
                  testId="chat-input-thinking-level-button"
                  // Every level the model declares, None and Low included;
                  // a stored level it lacks shows as its nearest lower one.
                  value={
                    supportedThinkingLevels.includes(thinkingLevel)
                      ? thinkingLevel
                      : displayThinkingLevel
                  }
                  supportedLevels={supportedThinkingLevels}
                  includeLow
                  onChange={(next): void => {
                    if (next !== undefined) {
                      void setThinkingLevel(next, targetOverride);
                    }
                  }}
                  disabled={isTerminalMode}
                  allowTriggerShrink
                  hideTriggerChevron
                  // Opens over its own trigger, 8px left of its edge.
                  menuAlignEdge="left"
                  menuAlignOffset={-8}
                  // Fast mode rides in the effort panel, for models that
                  // offer it; Ultra fast is its third, purple state.
                  {...(supportsFastMode
                    ? {
                        fastMode: {
                          on: requestedSpeed !== 'standard',
                          ultra: requestedSpeed === 'ultrafast',
                          disabled: isTerminalMode,
                          onToggle: cycleSpeed,
                        },
                      }
                    : {})}
                />
              ) : null}
              {/* Multi-repo projects: the folder the chat runs in, beside
                  effort. Its name truncates with the model's as the row
                  narrows. */}
              {isMultiRepo && !hideDirectoryPicker ? (
                <DirectoryPicker
                  currentRepoId={selectedRepoId}
                  childRepos={childRepos}
                  disabled={hasStartedSession || readOnly || isTerminalMode}
                  sessionLocked={hasStartedSession}
                  statusRow
                  onSelect={setSelectedRepoId}
                />
              ) : null}
            </>
          }
          end={
            <>
              <ApprovalModePicker
                mode={approvalMode}
                onChange={handleApprovalModeChange}
                disabled={isTerminalMode}
                hideTriggerIcon
                hideTriggerChevron
                menuAlignRef={dropContainerRef}
                menuAlignEdge="right"
              />
              <div className="shrink-0">
                <UsageIndicator
                  usage={tabUsage}
                  isCodex={isCodex}
                  isCursor={effectiveProviderType === 'cursor'}
                  model={model}
                  {...(effectiveProviderType
                    ? { providerType: effectiveProviderType }
                    : {})}
                  aiCreditsRouted={aiCreditsRouted}
                  subscriptionBillingOverride={
                    tab?.subscriptionBillingOverride === true
                  }
                  accountProxyRouted={tab?.accountProxyRouted}
                  alignRef={dropContainerRef}
                  {...(composerProjectId && composerWorktreeId && tab
                    ? {
                        contextTarget: {
                          projectId: composerProjectId,
                          worktreeId: composerWorktreeId,
                          chatId: tab.id,
                        },
                      }
                    : {})}
                />
              </div>
            </>
          }
        />
      )}

      {scheduleModalOpen && showScheduleControls && (
        <ScheduleMessageModal
          initialRunAt={scheduledSendDraft?.runAt}
          onCancel={(): void => setScheduleModalOpen(false)}
          onSave={handleSaveSchedule}
          ownerDocument={getDocument(composerRootRef.current)}
        />
      )}

      {pluginsModalOpen && (
        <ChatPluginsModal
          initial={
            pluginsModalInheritedLayers
              ? effectiveChatPluginSelections({
                  local: pluginSelections,
                  ...pluginsModalInheritedLayers,
                  chatTombstones: tabDisabledGlobalPluginSelections,
                })
              : (pluginSelections ?? {
                  collectionIds: [],
                  skillRefs: [],
                  pluginRefs: [],
                  mcpServerRefs: [],
                })
          }
          inheritedDefaults={
            pluginsModalInheritedLayers
              ? inheritedDefaultLayers(pluginsModalInheritedLayers)
              : undefined
          }
          onSave={async (
            selections: ChatTabPluginSelections,
            deferredToolsAllowed: boolean,
            appliedProjectDefaults?: ChatTabPluginSelections,
          ) => {
            const nextSelections = stripAgentOnlyChatPluginSelections(
              selections,
              agentPluginSelections,
              pluginSelections,
            );
            if (!watcherDestination) {
              throw new Error('Chat target is unavailable');
            }
            // The modal displayed the effective set (local ∪ surviving
            // inherited defaults) computed from the layers frozen at modal
            // open. Split the chosen set back into tab-local selections and
            // tombstones against that same snapshot: unchecked inherited
            // entries become durable chat-level rejections, entries the tab
            // already owned locally stay local, and tombstones derive from
            // the pre-strip chosen set so agent-locked stripping cannot
            // reject a default the user left checked.
            const currentChatTab = useChatStore
              .getState()
              .worktreeChats[
                `${watcherDestination.projectId}/${watcherDestination.worktreeId}`
              ]?.tabs.find((candidate) => candidate.id === watcherDestination.chatId);
            // A recommendation applied in the modal replaced the project
            // layer; its new defaults are inherited, not the chat's own.
            const inheritedLayers =
              pluginsModalInheritedLayers && appliedProjectDefaults
                ? {
                    ...pluginsModalInheritedLayers,
                    projectDefaults: appliedProjectDefaults,
                  }
                : (pluginsModalInheritedLayers ?? {});
            const { localSelections } = splitChosenChatPluginSelections({
              chosen: nextSelections,
              ...inheritedLayers,
              previousLocal: pluginSelections,
              previousTombstones: tabDisabledGlobalPluginSelections,
            });
            const { tombstones } = splitChosenChatPluginSelections({
              chosen: selections,
              ...inheritedLayers,
              previousTombstones: tabDisabledGlobalPluginSelections,
            });
            const response = await window.api.chat.updatePlugins({
              ...watcherDestination,
              pluginSelections: localSelections,
              ...(pluginsModalInheritedLayers
                ? { disabledGlobalPluginSelections: tombstones }
                : {}),
              deferredToolsAllowed,
              materializeCodexThread: shouldMaterializeCodexThread({
                providerType: effectiveProviderType,
                executionHarness:
                  currentChatTab?.executionHarness ?? thinkingHarness,
                sdkSessionId: currentChatTab?.sdkSessionId,
              }),
              expectedCurrentThreadId: currentChatTab?.sdkSessionId,
              ...(selectedRepoId ? { selectedRepoId } : {}),
            });
            setPluginSelections(
              response.pluginSelections,
              watcherDestination,
              response.deferredToolsAllowed,
              {
                runtimeAlreadyUpdated: true,
                ...(pluginsModalInheritedLayers
                  ? {
                      disabledGlobalPluginSelections:
                        response.disabledGlobalPluginSelections ?? tombstones,
                    }
                  : {}),
                ...(response.sdkSessionId
                  ? { sdkSessionId: response.sdkSessionId }
                  : {}),
              },
            );
            setPluginsModalOpen(false);
          }}
          onClose={() => setPluginsModalOpen(false)}
          projectId={
            selectedWorktree && !isCoworkChatTarget(selectedWorktree.projectId)
              ? selectedWorktree.projectId
              : undefined
          }
          worktreeId={
            selectedWorktree && !isCoworkChatTarget(selectedWorktree.projectId)
              ? selectedWorktree.worktreeId
              : undefined
          }
          repoId={selectedRepoId ?? undefined}
          effectiveProviderType={effectiveProviderType}
          lockedSkillRefs={lockedSkillRefs}
          lockedSelections={agentPluginSelections}
          // Managed account turns cannot reload their CLI mid-turn, so the
          // deferred-tools setting has no effect there.
          showDeferredToolsToggle={
            !isAccountHarness ||
            effectiveProviderType === 'copilot' ||
            effectiveProviderType === 'opencode'
          }
          deferredToolsAllowed={tab?.deferredToolsAllowed !== false}
          ownerDocument={getDocument(composerRootRef.current)}
        />
      )}

      {linearPickerOpen && (
        <Suspense fallback={null}>
          <LinearTicketPickerModal
            onSelect={(ticket): void => void handleSelectLinearTicket(ticket)}
            onClose={() => setLinearPickerOpen(false)}
            ownerDocument={getDocument(composerRootRef.current)}
          />
        </Suspense>
      )}

      {pipelineModalOpen &&
        planPipelineAllowed &&
        pendingExit &&
        createPortal(
          <PlanReadyPipelineModal
            projectId={pendingExit.projectId}
            worktreeId={pendingExit.worktreeId}
            onClose={() => {
              setPipelineModalOpen(false);
              setPipelineRunError(null);
              planPipelineWatcher.reset();
            }}
            onRun={handlePipelineRun}
            isRunning={pipelineRunning}
            runError={pipelineRunError}
            watcherRecipientGroups={planPipelineWatcher.recipientGroups}
            onWatcherSelectionChange={
              planPipelineWatcher.onWatcherSelectionChange
            }
          />,
          getDocument(composerRootRef.current).body,
        )}

      {/* Cross-harness continue confirmation. Hosted here rather than inside
          ModelPicker because the picker is shared with pipelines, hooks,
          automations, the Agent base-model modal and the Home composer, none of
          which have a chat to continue. Portaled through the composer root so a
          popped-out composer mounts it into its own document.

          The copy names the MODEL and nothing else. "Claude", "Codex" and
          "harness" are internal vocabulary; the model the user just clicked is
          the only name they have any reason to recognize, so the dialog is
          written entirely in terms of it. Keep provider labels out of here. */}
      {continueTargetModel !== undefined &&
        continueTargetProvider !== undefined &&
        lockedProvider !== undefined &&
        createPortal(
          <ConfirmDialog
            dataTestId="continue-on-provider-dialog"
            confirmTestId="continue-on-provider-confirm"
            title={`Start a new chat with ${getModelDisplayName(continueTargetModel)}?`}
            message={
              <span className="flex flex-col gap-2">
                <span>
                  {`This chat isn't compatible with ${getModelDisplayName(continueTargetModel)}, so ${brandText.appName} will start a new chat with it and bring over a summary of what you've done so far.`}
                </span>
                <span>
                  Your files aren't changed, and this chat stays open.
                </span>
              </span>
            }
            confirmLabel="Start new chat"
            busy={continueBusy}
            busyLabel="Setting up…"
            errorMessage={continueError}
            onConfirm={handleConfirmContinue}
            onCancel={closeContinueDialog}
          />,
          getDocument(composerRootRef.current).body,
        )}
    </div>
  );
});
