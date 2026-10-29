/**
 * `@canopy/ui-app` holds the write-once feature components for the unified
 * Code-tab and home-screen UI, rendered by both the desktop renderer and the
 * web portal.
 *
 * Convention: components that use hooks/state are client components and carry a
 * top-of-file `'use client'` directive (a no-op on desktop, required by Next on
 * web). Browser-safe: depends only on `@canopy/app-core`, `@canopy/app-state`,
 * `@canopy/ui-shared`, `@canopy/ui-rich`, `@canopy/protocol`, and React — never
 * Electron, Node, Prisma, Next, or `window.api`.
 *
 * Ships the `CapabilityGate` primitive, the shared Code-tab `ChatPanel` (with
 * its presentational parts), and the shared `FileViewer`/`DiffViewer`.
 * Remaining feature panels (ActivityPanel, Overview, shell/sidebar) arrive in
 * later tickets.
 */
export * from './capability';
export {
  CHAT_VISUAL_TEST_IDS,
  ChatVisualHostProvider,
  useChatVisualHost,
  type ChatVisualHost,
  type ChatVisualOwner,
} from './code/chat-visual-host';
export {
  ChatVisualBlock,
  type ChatVisualBlockProps,
} from './code/ChatVisualBlock';
export {
  ChatVisualSourceButton,
  type ChatVisualSourceButtonProps,
} from './code/ChatVisualSourceButton';
export {
  ChatVisualDialog,
  type ChatVisualDialogProps,
} from './code/ChatVisualDialog';
export {
  ChatVisualsPanel,
  type ChatVisualsPanelProps,
} from './code/ChatVisualsPanel';
export {
  collectChatVisualOwners,
  publishChatVisuals,
  requestChatVisualReveal,
  useChatVisualsPublisher,
  type ChatVisualReveal,
  type ChatVisualsSource,
} from './code/chat-visuals-source';
export {
  CHAT_VISUALS_PANEL_KIND,
  CHAT_VISUALS_PANEL_TITLE,
  openChatVisualsPanel,
  rebindChatVisualsPanel,
  type OpenChatVisualsPanelRequest,
} from './code/panels/chat-visuals-panel-open';
export {
  ChatVisualDocumentCache,
  chatVisualDocumentCache,
  readVisualRanges,
  verifyVisualDocument,
  VISUAL_RANGE_LIMIT,
  VISUAL_CACHE_BYTE_BUDGET,
  type VisualRangeReader,
  type VisualRangeResponse,
} from './code/chat-visual-reader';
export * from './code/shell/sidebar/sidebar-item-groups-model';
export {
  McpWorkspaceDefaultsSection,
  type McpWorkspaceDefaultsChoice,
  type McpWorkspaceDefaultsSectionProps,
} from './capability/McpWorkspaceDefaultsSection';
export {
  PipelineReadDetail,
  type PipelineReadDetailProps,
} from './pipelines/PipelineReadDetail';
export {
  PipelineRunDefinitionUsed,
  type PipelineRunDefinitionUsedProps,
} from './pipelines/PipelineRunDefinitionUsed';
export {
  GitHubWorkflowRunRow,
  githubWorkflowJobDagStatus,
  githubWorkflowRunRowStatus,
  githubWorkflowRunRowTitle,
  type GitHubWorkflowRunRowData,
  type GitHubWorkflowRunRowJob,
  type GitHubWorkflowRunRowProps,
  type GitHubWorkflowRunRowState,
  type GitHubWorkflowRunRowStatus,
} from './code/activity/github/GitHubWorkflowRunRow';
export { githubWorkflowJobTiers } from './code/activity/github/github-workflow-job-tiers';
export {
  GITHUB_PLACEHOLDER_JOB_PREFIX,
  githubWorkflowDefinitionTiers,
  githubWorkflowGraphDepths,
  type GitHubWorkflowDefinitionTiers,
  type GitHubWorkflowRunRowGraph,
  type GitHubWorkflowRunRowGraphJob,
} from './code/activity/github/github-workflow-definition-tiers';
export {
  ChatPanel,
  type ChatPanelProps,
  type ChatPanelSendContext,
  type ChatComposerSendOptions,
  type ChatComposerTypeaheadProps,
  type ChatComposerHostControls,
  type ChatTranscriptHostControls,
} from './code/ChatPanel';
export {
  ChatTranscript,
  type ChatTranscriptProps,
} from './code/ChatTranscript';
export { ChatComposer, type ChatComposerProps } from './code/ChatComposer';
export {
  ChatMessageView,
  type ChatMessageViewProps,
} from './code/ChatMessageView';
export {
  ChatMessageAuthorProvider,
  type ChatMessageAuthor,
  type ChatMessageAuthorResolver,
} from './code/ChatMessageAuthorContext';
export {
  ChatPartView,
  type ChatPartViewProps,
  AskUserQuestionInteractionProvider,
  DeliverableInteractionProvider,
  TurnWorkingStatusProvider,
  useAskUserQuestionInteraction,
  useTurnWorkingStatus,
  type AskUserQuestionInteraction,
  type AskUserQuestionRequestStatus,
  type DeliverableInteraction,
  type DeliverableRef,
} from './code/ChatPartView';
export {
  ChatToolResultPart,
  readChatToolResultVisual,
  type ChatToolResultPartProps,
} from './code/ChatToolResultPart';
export {
  TranscriptFileLinkInteractionProvider,
  TRANSCRIPT_FILE_LINK_MARKDOWN_OPTIONS,
  useTranscriptProseOptions,
  type FileLinkLineLocation,
  type TranscriptFileLinkInteraction,
} from './code/TranscriptFileLinks';
export { TurnGroupView, type TurnGroupViewProps } from './code/TurnGroupView';
export {
  FileViewer,
  type FileViewerProps,
  type FileEditorSlot,
  type FileLineReveal,
  type FileContentScrollBinding,
  type FileDocumentBytesResult,
  type FileDocumentRenderFailure,
  type FileRichDocumentSlot,
} from './code/file/FileViewer';
export {
  FileReadOnlyCode,
  type FileReadOnlyCodeProps,
} from './code/file/FileReadOnlyCode';
export { DiffViewer, type DiffViewerProps } from './code/file/DiffViewer';
export {
  FindableFileViewer,
  type FindableFileViewerProps,
} from './find/FindableFileViewer';
export {
  FileMarkdownPreview,
  type FileMarkdownPreviewProps,
} from './code/file/FileMarkdownPreview';
export {
  FileHtmlPreview,
  buildSandboxedHtmlSrcDoc,
  type FileHtmlPreviewProps,
} from './code/file/FileHtmlPreview';
export {
  FrontmatterBlock,
  type FrontmatterBlockProps,
} from './code/file/FrontmatterBlock';
export {
  MarkdownFrontmatterContent,
  type MarkdownFrontmatterContentProps,
  type FrontmatterValue,
} from './code/file/MarkdownFrontmatterContent';
export { parseFrontmatterAndBody } from './code/file/frontmatter';
export {
  UnifiedDiffView,
  type UnifiedDiffViewProps,
} from './code/file/UnifiedDiffView';
export {
  resolveFileRenderKind,
  fileExtension,
  fileRenderKindForMediaType,
  isRichDocumentRenderKind,
  type FileRenderKind,
  type RichDocumentRenderKind,
} from './code/file/file-kind';
export { toDiffFileStatus } from './code/file/diff-status';
export {
  ActivityPanel,
  ACTIVITY_POINTER_DRAG_ACTIVATION_CONSTRAINT,
  type ActivityPanelProps,
  type ActivityPanelHostActions,
  type ScriptsSectionHostModel,
  type HooksSectionHostModel,
  type ChangedFilesSectionHostModel,
  type ActivityPanelSectionOverride,
  type ActivityPanelExtraSection,
  ActivitySectionBody,
  getActivitySectionDescriptor,
  type ActivitySectionBodyProps,
  type ActivitySectionMenuDescriptor,
  type ActivitySectionPresenceInput,
  // `activitySectionPresenceIds` / `activitySectionRenders` /
  // `activitySectionHasContent` are deliberately NOT re-exported here. They are
  // the per-section internals of the panel-level predicate below, used by this
  // package's own tests through the module directly; hosts ask the rail-level
  // question, and a barrel export with no caller is just public API to keep
  // compatible.
  activityPanelHasContent,
} from './code/activity/ActivityPanel';
export {
  changedFilesHeaderHasContent,
  changedFilesHeaderSubtitle,
  type ChangedFilesHeaderInput,
} from './code/activity/changed-files-header';
export {
  SortableSection,
  type SortableSectionProps,
} from './code/activity/SortableSection';
export { FilesTab, type FilesTabProps } from './code/activity/FilesTab';
export {
  SummarySectionBody,
  type SummarySectionBodyProps,
  type SummarySectionBodyRepo,
  type SummarySectionBodySummary,
} from './code/activity/SummarySectionBody';
export {
  TodoSectionBody,
  type TodoSectionBodyItem,
  type TodoSectionBodyProps,
} from './code/activity/TodoSectionBody';
export { BackgroundTasksList } from './code/activity/BackgroundTasksList';
export {
  backgroundTasksHeaderChrome,
  type BackgroundTaskDetail,
  type BackgroundTaskHostActions,
  type BackgroundTasksSectionHostModel,
} from './code/activity/background-tasks-section';
export {
  McpServersSectionBody,
  type McpServersSectionBodyProps,
  type McpServersSectionItem,
} from './code/activity/McpServersSectionBody';
export {
  ScriptsSectionBody,
  type ScriptsSectionBodyProps,
  type ScriptsSectionEntry,
  type ScriptsSectionLifecycle,
  type ScriptsSectionRun,
  type ScriptsSectionRunStatus,
  type ScriptsSectionScript,
  type ScriptsSectionTarget,
  type ScriptsSectionWorkspaceLifecycleGroup,
} from './code/activity/scripts/ScriptsSectionBody';
export {
  RunOutputModal,
  type RunOutputModalProps,
  type RunOutputStatus,
} from './code/activity/scripts/RunOutputModal';
export {
  ScriptOutputModal,
  type ScriptOutputModalProps,
} from './code/activity/scripts/ScriptOutputModal';
export {
  HooksSectionBody,
  type HooksSectionAction,
  type HooksSectionActionType,
  type HooksSectionBodyProps,
  type HooksSectionEntry,
  type HooksSectionHook,
  type HooksSectionRun,
  type HooksSectionRunStatus,
  type HooksSectionTarget,
  type HooksSectionUnconfiguredWatcher,
} from './code/activity/hooks/HooksSectionBody';
export {
  FailedPendingExecutionCard,
  FailedQueuedHookPipelineCard,
  HookTriggerBadge,
  PendingExecutionCard,
  QueuedHookPipelineCard,
  type FailedPendingExecutionCardEntry,
  type FailedPendingExecutionCardProps,
  type FailedQueuedHookPipelineCardProps,
  type FailedQueuedPipelineCardEntry,
  type PendingExecutionCardEntry,
  type PendingExecutionCardProps,
  type PipelineHookTriggerSource,
  type QueuedHookPipelineCardProps,
  type QueuedPipelineCardEntry,
} from './code/activity/pipeline/PipelineQueuedCards';
// Only the tree row (which composes the Active/Completed rows internally)
// is public API today; the portal-adoption brick widens this deliberately
// when it consumes more.
export {
  FollowUpButton,
  InputRequiredBadge,
  isPipelineExecutionActiveStatus,
  PipelineRunStatusPill,
  PipelineRunTreeRow,
  PlanModifiedBadge,
  type ActiveRunRowProps,
  type CompletedRunRowProps,
  type PipelineRunBreadcrumbEntry,
  type PipelineRunExecutionState,
  type PipelineRunJobDefinition,
  type PipelineRunJobGroup,
  type PipelineRunJobResult,
  type PipelineRunPauseResponse,
  type PipelineRunRenderSlot,
  type PipelineRunStatus,
  type PipelineRunSummary,
  type PipelineRunTreeRowProps,
} from './code/activity/pipeline/PipelineRunRows';
export {
  PipelineRunsSectionBody,
  type PipelineRunsSectionBodyProps,
} from './code/activity/pipeline/PipelineRunsSectionBody';
// The shared run DETAIL surface (CAN-3020). The web portal hosts it inside a
// full-viewport `DialogModal`; desktop adopts it at CAN-1965.
export {
  PipelineRunDetail,
  type PipelineRunDetailLog,
  type PipelineRunDetailProps,
  type PipelineRunDetailStepSelection,
} from './code/activity/pipeline/PipelineRunDetail';
export {
  buildPipelineRunDetailJobs,
  flattenPipelineRunDetailSteps,
  pipelineRunDetailStatusClassName,
  pipelineRunStepKey,
  type PipelineRunDetailJob,
  type PipelineRunDetailJobGroup,
  type PipelineRunDetailPauseCheckpoint,
  type PipelineRunDetailPauseField,
  type PipelineRunDetailStep,
  type PipelineRunDetailStepEntry,
  type PipelineRunDetailVariant,
  type PipelineRunDetailVariantGroup,
  type PipelineRunDetailView,
} from './code/activity/pipeline/PipelineRunDetailModel';
export {
  PipelineRunPauseForm,
  type PipelineRunPauseFormProps,
} from './code/activity/pipeline/PipelineRunPauseForm';
export { pipelinePauseInputHeading } from './code/activity/pipeline/pipeline-pause-input-heading';
export {
  PipelineRunStepTree,
  type PipelineRunStepTreeProps,
  type PipelineRunStepTreeSelection,
} from './code/activity/pipeline/PipelineRunStepTree';
export {
  ChangedFilesSection,
  type ChangedFileRow,
  type ChangedFilesSectionProps,
} from './code/activity/sections/ChangedFilesSection';
export {
  PullRequestSection,
  type PullRequestSectionProps,
} from './code/activity/sections/PullRequestSection';
export {
  PullRequestSectionBody,
  PullRequestRepoDetail,
  type PullRequestSectionBodyProps,
  type PullRequestSectionRepo,
  type PullRequestSectionPrStatus,
  type PullRequestSectionPrState,
  type PullRequestSectionCheckStatus,
  type PullRequestSectionCheckDetail,
  type PullRequestSectionReviewStatus,
  type PullRequestSectionLabel,
  type PullRequestSectionCreationStep,
  type PullRequestSectionCreationProgress,
} from './code/activity/PullRequestSectionBody';
export {
  ItemListSection,
  type ItemListSectionProps,
  type ActivityListItem,
} from './code/activity/sections/ItemListSection';
export {
  CodeShell,
  type CodeShellProps,
  type CodeShellRegions,
  type CodeShellTestId,
  type CodeShellTestIds,
} from './code/shell/CodeShell';
export {
  WorktreeSidebar,
  type WorktreeSidebarProps,
} from './code/shell/WorktreeSidebar';
export {
  WorkspacesSidebarSections,
  type WorkspacesSidebarSectionsProps,
  type SidebarAdditionalProject,
  type WorkspacesSidebarSectionsTestIds,
  type WorkspacesSidebarSelection,
  type WorkspaceSectionSlotContext,
  type CoworkWorkspaceSlotContext,
  type ArchivedWorktreeEntry,
  type WorktreeRowSlotContext,
  type WorkspaceDndWrapperContext,
  type WorktreeDndWrapperContext,
  type WorkspaceDialogTriggerContext,
  type WorktreeDialogTriggerContext,
  type WorktreePopoverSlotContext,
  type WorkspaceBranchGrouping,
  type UseWorktreeRowOverrides,
  type WorktreeRowOverrideKey,
  type WorktreeRowOverrides,
  pickWorktreeRowOverrides,
} from './code/shell/WorkspacesSidebarSections';
export {
  PendingProjectRow,
  PendingProjectRows,
  type SidebarPendingProject,
} from './code/shell/PendingProjectRow';
export { useProjectListPagination } from './code/shell/sidebar/useProjectListPagination';
export {
  CHATS_SECTION_VISIBLE_ENTRIES,
  SidebarSurface,
  type SidebarSurfaceProps,
  type SidebarSurfaceSnapshot,
  type SidebarSurfaceTestIds,
  type SidebarSelection,
  type SidebarPipelineEntry,
  type SidebarChatSearchHost,
  type SidebarNavItemAction,
} from './code/shell/SidebarSurface';
export {
  isSidebarActivityAvailable,
  prepareSidebarActivityLoader,
  type SidebarActivityHost,
  type SidebarActivityHostInventory,
} from './code/shell/sidebar-activity-host';
export {
  SidebarActivityModeToggle,
  type SidebarActivityModeToggleProps,
} from './code/shell/SidebarActivityModeToggle';
export {
  SidebarActivityModeSwitch,
  SidebarActivityModeView,
  useSidebarActivityGate,
  type SidebarActivityModeSwitchProps,
  type SidebarActivityModeViewProps,
} from './code/shell/SidebarActivityModeView';
export {
  SidebarGuestProjectsCard,
  type SidebarGuestProjectsCardProps,
} from './code/shell/SidebarGuestProjectsCard';
export {
  SidebarAccountFooter,
  SidebarPersonAvatar,
  SidebarAccountRow,
  type SidebarAccountAttention,
  type SidebarAccountFooterProps,
  type SidebarAccountIdentity,
  type SidebarAccountIdentityTone,
  type SidebarPersonAvatarProps,
  type SidebarAccountRowProps,
} from './code/shell/SidebarAccountFooter';
export {
  SidebarRemoteControlSubtitle,
  sidebarRemoteControlSubtitleLabel,
  type SidebarRemoteControlStatus,
  type SidebarRemoteControlSubtitleProps,
} from './code/shell/SidebarAccountSubtitle';
export {
  getSidebarNavItemDefs,
  type SidebarNavItemDef,
  type SidebarNavItemKey,
} from './code/shell/sidebar-nav-items';
export {
  buildSidebarChatSearchCandidates,
  filterSidebarChatSearchResults,
  type SidebarChatSearchInventory,
  type SidebarChatSearchResult,
  type SidebarChatSearchWorktreeChat,
} from './code/shell/sidebar-chat-search-model';
export {
  CreateWorkspaceDialog,
  type CreateWorkspaceDialogProps,
  type CreateWorkspaceDialogTestIds,
} from './code/shell/CreateWorkspaceDialog';
export {
  firstVisibleWorkspaceId,
  visibleWorkspaceCount,
  workspaceColor,
} from './code/shell/sidebar-model';
export {
  isWorktreeDone,
  snapshotWorkspaceMatchesContext,
  type WorkspaceSectionsSnapshot,
} from './code/shell/workspace-sections-model';
// Shared worktree top bar (CAN-1485): the component value plus its locked
// public types. The transport slice locked the type surface; the frontend
// slice authored the component body and exports it here for the portal mount.
export {
  WorktreeTopBar,
  type WorktreeTopBarPinnedAction,
  type WorktreeTopBarProps,
  type WorktreeTopBarScriptHostActions,
} from './code/shell/WorktreeTopBar';
export {
  SHARED_WITH_YOU_SECTION_LABEL,
  SidebarList,
  SidebarRowFrame,
  SidebarSection,
  type SidebarDensity,
  type SidebarListProps,
  type SidebarRowFrameProps,
  type SidebarRowFrameVariant,
  type SidebarSectionProps,
} from './code/shell/sidebar';
// Bulk worktree selection and removal (CAN-3975).
export {
  batchActionAvailability,
  worktreeRemovalBlockedReason,
  type WorktreeBatchActionAvailability,
  type WorktreeBatchAvailabilityRow,
  type WorktreeRemovalBlockInputs,
} from './code/shell/worktree-menu-items';
export {
  isWorktreeSelectable,
  useWorktreeBatchRemoval,
  useWorktreeSelection,
  type GetWorktreeBatchRemovalFacts,
  type RemoveWorktreeInBatch,
  type WorktreeBatchItem,
  type WorktreeBatchLocalWork,
  type WorktreeBatchRemovalFacts,
  type WorktreeBatchRemovalMode,
  type WorktreeBatchRemovalOptions,
  type WorktreeBatchRemovalUiState,
  type WorktreeSelection,
} from './code/shell/sidebar';
export {
  deriveWorktreeMenuItems,
  foldWorktreeMenuIntoMore,
  WorktreeGroupingMenuIcon,
  type WorktreeGroupingActionKind,
  type WorktreeMenuCallbacks,
} from './code/shell/worktree-menu-items';
export {
  getWorktreeBranchChoiceHint,
  getWorktreeDeleteLabels,
  type WorktreeDeleteLabels,
  type WorktreeRemovalMode,
} from './code/shell/worktree-removal-labels';
export {
  deriveWorktreeUiStatus,
  isTreeLayout,
  orderedWorkspaces,
  workspaceLayout,
  worktreesForWorkspace,
  type WorktreeUiStatus,
  type SnapshotWorkspace,
  type SnapshotWorktree,
  type SidebarWorkspace,
  type WorkspaceVisibilitySnapshot,
} from './code/shell/worktree-status';
export {
  Overview,
  OverviewSectionHeader,
  type OverviewProps,
  type OverviewSectionHeaderProps,
} from './home/Overview';
export { OverviewCard, type OverviewCardProps } from './home/OverviewCard';
export {
  PanelGridSurface,
  type PanelAddTabMenuRenderProps,
  type PanelGridSurfaceProps,
  type PanelGridSurfaceServices,
} from './code/panels/PanelGridSurface';
export {
  splitDirectionToDropEdge,
  splitGroupMovingActiveTab,
} from './code/panels/split-active-tab';
export {
  getPanelCommand,
  isPanelCommandAvailable,
  PANEL_COMMANDS,
  PANEL_SHORTCUT_BINDINGS,
  runPanelCommand,
  type PanelCommand,
  type PanelCommandId,
  type PanelShortcutBinding,
} from './code/panels/panel-commands';
export {
  findPanelByInstanceKey,
  getAuxPanelLayoutOwnerKey,
  getPanelGridController,
  getPanelInstanceKey,
  getPanelLayoutViewModel,
  isAuxPanelLayoutKey,
  isSingletonPanelKind,
  makeAuxPanelLayoutKey,
  makeWorktreePanelKey,
  setPanelLeafDocumentResolver,
  usePanelGridController,
  usePanelLayoutStore,
  usePanelLayoutViewModel,
  type AdoptLayoutTabsOptions,
  type DefaultLayoutDescriptor,
  type DefaultLayoutGroupSeed,
  type PanelGridController,
  type PanelGroupState,
  type PanelInstanceLocation,
  type PanelLeafDocumentResolver,
  type PanelLayoutState,
  type PanelTabDescriptor,
  type SplitGroupSeed,
  type WorktreePanelLayout,
} from './code/panels/panel-layout-store';
export * from './code/shell/SidebarPlanSubtitle';
export * from './feedback/FeedbackDialog';

export {
  ChatMessageAttachments,
  ChatAssetImage,
  type ChatAssetImageReference,
  type ChatAssetImageSource,
  ChatMessageAttachmentInteractionProvider,
  useChatMessageAttachmentInteraction,
  type ChatMessageAttachmentInteraction,
  type ChatMessageAttachmentsProps,
} from './code/ChatMessageAttachments';
export {
  SidebarContextRow,
  SidebarContextGlyph,
  SidebarContextMenuItems,
  buildOrganizationOptions,
  type SidebarContextMenuItemsProps,
  type SidebarContextOrgScopedActions,
  type SidebarContextRowProps,
} from './code/shell/SidebarContextRow';
export {
  resolveSidebarContextActions,
  sidebarContextSwitcherAvailable,
  type SidebarContextActions,
} from './code/shell/sidebar-context-actions';
export {
  SidebarAccountMenuHeader,
  type SidebarAccountMenuHeaderProps,
} from './code/shell/SidebarAccountMenuHeader';
export {
  SidebarCreateOrganizationMenuItem,
  SidebarFeedMenuItem,
  SidebarInviteTeamMenuItem,
  SidebarStatisticsMenuItem,
  invitableOrganization,
  organizationCreatePath,
  organizationSettingsPath,
} from './code/shell/AccountMenuActivityItem';
export {
  CONTEXT_CARRYOVER_LINGER_MS,
  activitySourceOf,
  contextActivityItemsFromSnapshot,
  contextCarryoverDeadline,
  contextCarryoverProjection,
  contextKeysWithUpdates,
  contextUpdateKey,
  isForeignActivityUpdate,
  observeContextCarryover,
  startContextCarryover,
  type ContextActivityItem,
  type ContextActivitySnapshot,
  type ContextActivitySource,
  type ContextCarryoverState,
} from './code/shell/context-updates';

export type {
  FilesTabMutations,
  FilesTabSearch,
} from './code/activity/FilesTab';
export { FilesTabActionMenu } from './code/activity/FilesTabActionMenu';
export type {
  FilesTabMenuAction,
  FilesTabActionTarget,
  FilesTabActionMenuProps,
} from './code/activity/FilesTabActionMenu';
export {
  DEFAULT_FILE_TREE_MENU_LABELS,
  FileTreeContextMenu,
  deriveFileTreeMenuItems,
} from './code/activity/FileTreeContextMenu';
export type {
  FileTreeContextMenuProps,
  FileTreeMenuKey,
  FileTreeMenuLabels,
  FileTreeMenuOptions,
  FileTreeMenuTargetKind,
} from './code/activity/FileTreeContextMenu';
export * from './code/activity/files-tab-search';
export * from './code/activity/files-tab-inline-editor';

export {
  buildComposerOverflowMenuItems,
  defaultChatPlaceholder,
  getSlashCommandInsertText,
  resolveComposerThinking,
  resolveModelOptionProviderType,
  resolvePortalExecutionHarness,
  resolveUsageIndicatorIsCodex,
  toUsageIndicatorUsage,
  type ComposerOverflowMenuArgs,
} from './code/composer/composer-helpers';
export {
  cloneComposerDraft,
  composerDraftContentEquals,
  createComposerDraftHolder,
  EMPTY_COMPOSER_DRAFT,
  useComposerDraftHolder,
  useComposerDraftRestoration,
  type ComposerDraftHolder,
  type ComposerDraftRestorationOptions,
  type ComposerDraftSnapshot,
} from './code/composer/composer-draft';
export {
  CommandsPopup,
  type CommandsPopupProps,
} from './code/composer/CommandsPopup';
export { DirectoryPickerHeading } from './code/composer/DirectoryPickerHeading';
export {
  PortalDirectoryPicker,
  type DirectoryPickerOption,
} from './code/composer/PortalDirectoryPicker';
export {
  PortalModelPicker,
  type PortalModelPickerProps,
} from './code/composer/PortalModelPicker';
export {
  PendingAttachmentRow,
  type PendingAttachmentChip,
} from './code/composer/pending-attachment-row';
export {
  countPortalPluginSelections,
  PORTAL_PLUGINS_MCP_NEEDS_RECONNECTING_LABEL,
  PORTAL_PLUGINS_MCP_NOT_SIGNED_IN_LABEL,
  PORTAL_PLUGINS_PROJECT_DEFAULT_LABEL,
  PortalPluginsPicker,
  type AccountMcpEntryComponentProps,
  type AccountMcpSeam,
  type AddMarketplaceConfirmation,
  type AddMarketplaceDialogComponent,
  type AddMarketplaceSeam,
  type PortalPluginsPickerProps,
} from './code/composer/PortalPluginsPicker';
export {
  MoveProjectToOrganizationDialog,
  moveProjectToOrganizationErrorMessage,
  type MoveProjectToOrganizationDialogProps,
  type MoveProjectToOrganizationError,
  type MoveProjectToOrganizationOption,
} from './org-projects/MoveProjectToOrganizationDialog';
export {
  OrgRepositoryOwnerNotice,
  orgRepositoryOwnerNoticeCopy,
  orgRepositoryOwnerSwitchFailure,
  type OrgRepositoryOwnerNoticeCopy,
  type OrgRepositoryOwnerNoticeCopyInput,
  type OrgRepositoryOwnerNoticeProps,
} from './org-projects/OrgRepositoryOwnerNotice';
export {
  OrgContextEmptyState,
  type OrgContextEmptyStatePlanMissing,
  type OrgContextEmptyStateProps,
} from './org-projects/OrgContextEmptyState';
export {
  DraftComposerEditor,
  type DraftComposerEditorProps,
} from './code/composer/DraftComposerEditor';
export {
  LinearReferencePreview,
  useLinearTeamCatalog,
  type LinearReferencePreviewProps,
} from './code/LinearReferencePreview';
export {
  GitHubReferencePreview,
  useGitHubOriginRepository,
  useGitHubPreviewConnected,
  type GitHubReferencePreviewProps,
} from './code/GitHubReferencePreview';
