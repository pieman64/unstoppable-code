import {
  normalizeOnboardingTipDismissals,
  type OnboardingTipDismissals,
} from '@canopy/protocol/onboarding-tips';
import { ipcTranscriptReadClient } from './ipc-transcript-read-client';
import { isVoiceDictationPlatform } from '@canopy/desktop-shared/platform-capabilities';
import { subscribeToChatEvents } from '@/lib/chatEventFanout';
import {
  parseWorkspaceContext,
  serializeWorkspaceContext,
} from '@canopy/protocol/workspace-context';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import type {
  AccountOrganizationSettingsApi,
  ActivitySectionId,
  CanopyApi,
  DesktopOrgProjectCatalogSnapshot,
  AgentModelConfig,
  FileTreeRoot,
  HookRunRequest,
  ScriptRunRequest,
  SidebarItem,
  TrackedPlanData,
  TrackedPlanReviewStatus,
  TrackedPlanSource,
  UpdateTrackedPlanRequest,
} from '@canopy/desktop-shared/types';
import {
  COWORK_HOME_WORKTREE_ID,
  isThinkingLevel,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import {
  createCursorAssistantPatchProjector,
  isCursorAssistantPatchEvent,
  isTerminalRuntimeChatEvent,
  runtimeChatEventToPortalMessage,
  type CursorAssistantPatchProjector,
} from '@canopy/desktop-shared/portal/runtime-chat-projection';
import { isRecord } from '@canopy/desktop-shared/portal/persisted-chat-projection';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { isCoworkChatTarget } from '@/lib/cowork';
import { extractIpcErrorMessage, extractIpcErrorName } from '@/lib/errors';
import { FileSaveConflictError } from '@canopy/app-core';
import { organizationOperationReply } from '@/lib/personal-organization-upgrade-port';
import {
  OrganizationInviteResultSchema,
  OrganizationInviteStatusSchema,
  PersonalOrganizationPromotionOutcomeSchema,
} from '@canopy/protocol/organizations';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import type {
  PortalDirectoryListing,
  PortalFilePreview,
  PortalFileIndex,
  PortalFileMutationResult,
  PortalFileReadPayload,
  PortalFileRoot,
  PortalHookRunPayload,
  PortalPipelineRunPayload,
  PortalPlanDetail,
  PortalPlanUpdatePayload,
  PortalScriptRunPayload,
} from '@canopy/protocol/portal';
import type {
  CanopyCapabilities,
  CanopyClient,
  ChatTabSettings,
  CommandMap,
  CommandName,
  DomainEventMap,
  DomainEventName,
  QueryMap,
  QueryName,
  SubscriptionFilter,
  Unsubscribe,
} from '@canopy/app-core';
import {
  ipcTerminalCommandHandlers,
  ipcTerminalQueryHandlers,
  ipcTerminalSubscribeHandlers,
} from './ipc-terminal-client';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type { MarketplaceSourcesClient } from '@canopy/app-core/client';
import { createIpcMarketplaceSourcesClient } from './ipc-marketplace-sources-client';
import {
  createCanopyCloudAccountIdSource,
  createDesktopSettingsClient,
} from './account-organization-settings-client';
import { registerHostedSettingsCanopyClient } from './hosted-settings-client-registry';

/**
 * The stored tip dismissals. A preferences file that failed to load rejects,
 * so the shared tips stay hidden instead of reappearing over defaults. So
 * does a host built before tips existed, which sends no dismissals field and
 * could never save one.
 */
async function loadOnboardingTipDismissals(): Promise<OnboardingTipDismissals> {
  const preferences = await window.api.loadPreferences();
  if (preferences.__error) {
    throw new Error('Preferences could not be loaded.');
  }
  if (!('onboardingTipsDismissed' in preferences)) {
    throw new Error('This host does not store onboarding tip dismissals.');
  }
  return normalizeOnboardingTipDismissals(preferences.onboardingTipsDismissed);
}

/**
 * Build the desktop capability set for a given platform. Desktop runs the full
 * local-first app, so everything is enabled except voice dictation, which is
 * macOS-only (`canopy-dictate` is not shipped on Windows). The web adapter
 * reports a relay-limited set (CAN-736).
 *
 * `nativeWorktreeOpen` is `true` because the native `OpenDropdown` IDE/Finder
 * behavior genuinely exists on desktop. `panelLayoutControls` is `false`: no
 * desktop panel-layout toggle ships yet (CAN-1485), so reporting `true` would
 * advertise a control that does not exist — a real toggle (P2) flips it on.
 * `ledger` is `true` because desktop reads each scope's Agent Ledger; whether
 * the Ledger is turned on is checked on every read.
 * `marketplaceOwnedAutomationShares` is `true`: desktop Marketplace lists and
 * manages the user's own automation shares ("Shared by me", CAN-3980).
 * `marketplaceOwnedShares` is `true`: every Marketplace tab lists the user's
 * own account shares through `createdBy=me` reads (CAN-4263).
 * `marketplaceSharedCollectionEdit` is `true`: the shared collection editor
 * picks members from the local catalog (CAN-4263).
 * `customSkillEdit` is `true`: a custom skill's Customize row opens the local
 * skill editor (CAN-4844).
 * `automations` and `watchers` are `true`: both run on the desktop, so the
 * Workflows page shows their rows, the Schedule tab and their actions
 * (CAN-3981).
 */
export function createDesktopCapabilities(
  platform: NodeJS.Platform,
  organizationOperations: Pick<
    CanopyCapabilities,
    | 'personalOrganizationUpgrade'
    | 'organizationInvites'
    | 'personalProjectConversion'
  > = {},
  hostedSettings: Pick<CanopyCapabilities, 'accountOrganizationSettings'> = {},
): CanopyCapabilities {
  return {
    sharedMultiRepo: true,
    githubConnection: true,
    localExecution: true,
    // Try it setup may open account OAuth in the in-app pane; the host also
    // requires the in-app browser itself, which a remote window lacks.
    embeddedOAuthBrowser: true,
    repoRulesImport: true,
    scriptActions: true,
    // Tip dismissals live in the desktop preferences (CAN-4904).
    onboardingTips: true,
    // Source list/detail and plugin installs run over `window.plugins`; the
    // shared gate still requires the wired `marketplaceSources` member.
    marketplaceSources: true,
    marketplaceSourcePluginInstall: true,
    marketplaceSourceAdd: true,
    // Payment forms stay in the browser; hosted settings hand off to it.
    inlineCheckout: false,
    // Hosted account and organization settings run through main's settings
    // bridge, so they are on only when the preload exposes it.
    accountOrganizationSettings:
      hostedSettings.accountOrganizationSettings === true,
    terminalPty: true,
    fileSystemAccess: 'read-write',
    voice: isVoiceDictationPlatform(platform),
    settingsScope: 'full',
    pipelines: 'execute',
    routing: 'in-memory',
    overviewNotifications: true,
    sidebarActivityMode: true,
    chatDrafts: true,
    chatVisuals: true,
    // Main grants sanitized writes only to trusted application documents.
    imageClipboard: true,
    nativeWorktreeOpen: true,
    // Fix, Resolve conflicts and Triage start agent chats from the header.
    worktreePrAgentHelpers: true,
    marketplaceOwnedAutomationShares: true,
    marketplaceOwnedShares: true,
    marketplaceSharedCollectionEdit: true,
    customSkillEdit: true,
    automations: true,
    watchers: true,
    workflowManagement: true,
    // Main owns plan proposals, deferred reloads, and split startup. The
    // shared derivation still applies each provider's own limits.
    chatWorkflows: {
      planMode: true,
      planReview: true,
      deferredCapabilities: true,
      independentFork: true,
      // `resumeUsageLimitedChats` resumes an app-closed turn in place.
      interruptedTurnResume: true,
    },
    panelLayoutControls: false,
    itemGrouping: false,
    workspaceRemoval: 'delete',
    // `worktree.create` / `worktree.update` run over IPC. Row identity and
    // activity sections keep the shared defaults, so neither is set.
    worktreeCreation: true,
    // `worktree.create` carries `baseWorktreeId` and `forkOpenTabs` (Branch from).
    worktreeBranching: true,
    worktreeMetadata: true,
    turnFeedback: true,
    // Install update emails (CAN-2334) go through the settings IPC pair,
    // which rejects without a signed-in non-guest account.
    installUpdateEmails: true,
    // Subagent viewer: Stop, the isolated worktree summary and changes,
    // messaging a managed delegate, and interrupting a native subagent all
    // run through the local managed-delegation and native-subagent IPC.
    delegationStop: true,
    delegationTranscriptReads: true,
    delegationBlockReads: true,
    delegationLifetimeStatusReads: true,
    delegationLifetimeLimitExtension: true,
    primaryContentReads: true,
    delegationWorktreeDetails: true,
    delegationMessaging: true,
    nativeSubagentInterrupt: true,
    ledger: true,
    // The Feed merges this device's Ledger with the mirror, and its own
    // entries change here.
    ledgerFeed: true,
    ledgerLocal: true,
    referencePreviews: true,
    backgroundTaskStop: true,
    lifecycleJournalQuarantine: true,
    // `worktree:discard-describe` / `worktree:discard` (CAN-5334).
    worktreeDiscard: true,
    // `workspace:delete-discard-describe` and the supersede field (CAN-5337).
    projectDeletionDiscard: true,
    // Observed cost reads over the `cost:*` IPC.
    costInsights: true,
    providerQuotas: true,
    // Repeat-task skill suggestions are detected and surfaced by main
    // (CAN-385); the flag and preference still gate what shows.
    skillSuggestions: true,
    // CAN-3706: promotion, invitations, and bringing local Personal projects
    // all run through main; the server authorizes each operation.
    personalOrganizationUpgrade:
      organizationOperations.personalOrganizationUpgrade === true,
    organizationInvites: organizationOperations.organizationInvites === true,
    personalProjectConversion:
      organizationOperations.personalProjectConversion === true,
  };
}

/** The preload's hosted settings bridge, when this window exposes one. */
function resolveSettingsBridge(): AccountOrganizationSettingsApi | null {
  if (typeof window === 'undefined') return null;
  const api: Partial<CanopyApi> | undefined = window.api;
  return api?.accountOrganizationSettings ?? null;
}

/** Resolve the renderer's platform, defaulting to a no-voice platform off-DOM. */
/** This computer's platform: the capabilities it reports run here. */
function resolveDesktopPlatform(): NodeJS.Platform {
  if (typeof window === 'undefined') return 'linux';
  return window.localPlatform ?? window.platform ?? 'linux';
}

type QueryHandlers = {
  [K in QueryName]: (
    args: QueryMap[K]['args'],
  ) => Promise<QueryMap[K]['result']>;
};
type CommandHandlers = {
  [K in CommandName]: (
    args: CommandMap[K]['args'],
  ) => Promise<CommandMap[K]['result']>;
};
type SubscribeHandlers = {
  [K in DomainEventName]: (
    handler: (event: DomainEventMap[K]) => void,
    filter?: SubscriptionFilter,
  ) => Unsubscribe;
};

const noopUnsubscribe: Unsubscribe = (): void => {
  // The desktop app is the local host; its link is always active, so there is
  // nothing to tear down.
};

function runtimeAssistantFallbackMessageId(
  chatId: string,
  data: unknown,
  turnSequence: number,
): string {
  if (isRecord(data)) {
    const turnUserMessageId = data.canopy_turn_user_message_id;
    if (typeof turnUserMessageId === 'string' && turnUserMessageId.length > 0) {
      return `${turnUserMessageId}:assistant`;
    }
  }
  return `${chatId}:desktop-turn-${String(turnSequence)}:assistant`;
}

/**
 * Exhaustive membership table for {@link ActivitySectionId}. Declared as a
 * `Record` keyed by the union so adding a new section id fails compilation
 * here until the table is extended — the wire `order` is `string[]`, and
 * unknown entries are filtered out (mirroring lenient persistence
 * normalization) instead of corrupting the persisted section order.
 */
const ACTIVITY_SECTION_ID_FLAGS: Record<ActivitySectionId, true> = {
  plugins: true,
  summary: true,
  'changed-files': true,
  'pull-request': true,
  'background-processes': true,
  plans: true,
  'pipeline-runs': true,
  cost: true,
  scripts: true,
  hooks: true,
  terminals: true,
  todo: true,
  'mcp-servers': true,
  memory: true,
  notes: true,
  prompts: true,
  attachments: true,
};

function isActivitySectionId(value: string): value is ActivitySectionId {
  return Object.prototype.hasOwnProperty.call(ACTIVITY_SECTION_ID_FLAGS, value);
}

/** Exhaustive membership table for {@link TrackedPlanSource}. */
const TRACKED_PLAN_SOURCE_FLAGS: Record<TrackedPlanSource, true> = {
  copilot: true,
  opencode: true,
  cursor: true,
  claude: true,
  codex: true,
  ollama: true,
  pipeline: true,
  imported: true,
  detected: true,
};

function isTrackedPlanSource(value: string): value is TrackedPlanSource {
  return Object.prototype.hasOwnProperty.call(TRACKED_PLAN_SOURCE_FLAGS, value);
}

/** Exhaustive membership table for {@link TrackedPlanReviewStatus}. */
const TRACKED_PLAN_REVIEW_STATUS_FLAGS: Record<TrackedPlanReviewStatus, true> =
  {
    pending: true,
    approved: true,
    dismissed: true,
  };

function isTrackedPlanReviewStatus(
  value: string,
): value is TrackedPlanReviewStatus {
  return Object.prototype.hasOwnProperty.call(
    TRACKED_PLAN_REVIEW_STATUS_FLAGS,
    value,
  );
}

async function loadDesktopWorkspace(workspaceId: string): Promise<SidebarItem> {
  const file = await window.api.loadProjects();
  const item = file.items.find((candidate) => candidate.id === workspaceId);
  if (!item) {
    throw new Error(`Project ${workspaceId} not found.`);
  }
  return item;
}

/**
 * Shared review UI renders these messages and matches "Scan again", so
 * Electron's `Error invoking remote method …` wrapper must not reach it.
 */
async function unwrapIpcError<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    throw new Error(extractIpcErrorMessage(error));
  }
}

/**
 * Mirror of the main-process `languageForPath` helper in
 * `files-service.ts`: the language hint is the lowercase file extension
 * (dotfiles like `.gitignore` have none), used by the shared file viewer to
 * pick a syntax highlighter.
 */
function languageForPath(pathValue: string): string | undefined {
  const basename = pathValue.split('/').pop() ?? pathValue;
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex <= 0) {
    return undefined;
  }
  const extension = basename.slice(dotIndex + 1).toLowerCase();
  return extension || undefined;
}

/**
 * Mirror of the main-process `versionFromStat` cookie
 * (`files-service.ts`) so previews produced by this adapter carry the same
 * opaque save-conflict version shape as the portal file service.
 */
function versionFrom(sizeBytes: number, modifiedAtMs: number): string {
  return `${Number(sizeBytes)}:${Math.round(Number(modifiedAtMs))}`;
}

/**
 * Join a file-root absolute path with a root-relative path, rejecting
 * traversal segments — mirroring the main-process `normalizeRelativePath`
 * rejection in `files-service.ts`. The main `readFileContent` IPC only
 * validates that the path is absolute, so this is the containment gate for
 * reads; writes are additionally contained main-side by
 * `ensureFileIsWithinAllowedRoots`. Symlink-aware realpath containment can
 * only live main-side and remains a follow-up there.
 */
function joinRootPath(rootAbsolutePath: string, relativePath: string): string {
  if (!relativePath) {
    return rootAbsolutePath;
  }
  const root = rootAbsolutePath.replace(/[\\/]+$/, '');
  return `${root}/${rootRelativeSegments(relativePath).join('/')}`;
}

/** The path's segments as `joinRootPath` joins them; `..` is rejected. */
function rootRelativeSegments(relativePath: string): string[] {
  const segments = relativePath
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    throw new Error(
      `Relative path "${relativePath}" escapes the file root and was rejected.`,
    );
  }
  return segments;
}

const localFileRootOverrides = new Map<string, FileTreeRoot>();

/**
 * Register a renderer-owned, read-only file root for a full file viewer that
 * is not part of the live worktree tree (currently archived attachments).
 *
 * The caller owns the lifetime and must invoke the returned cleanup. Writes
 * still go through the main-process worktree containment gate, and archive
 * viewers omit the editor entirely, so these roots are read-only by design.
 */
export function registerLocalFileRootOverride(root: FileTreeRoot): () => void {
  localFileRootOverrides.set(root.repoId, root);
  return (): void => {
    if (localFileRootOverrides.get(root.repoId) === root) {
      localFileRootOverrides.delete(root.repoId);
    }
  };
}

/**
 * Resolve the file root a portal file payload targets. `fileRootLocalId`
 * wins over `repoId` (matching the main-process `resolvePortalFileTarget`
 * contract); the desktop file-tree surfaces roots keyed by `repoId`, which is
 * the same id space the portal `fileRootLocalId` uses.
 */
async function resolveFileRoot(
  projectId: string,
  worktreeId: string,
  rootId: string | undefined,
): Promise<FileTreeRoot> {
  if (!rootId) {
    throw new Error('Either repoId or fileRootLocalId must be set.');
  }
  const override = localFileRootOverrides.get(rootId);
  if (override) {
    return override;
  }
  const { roots } = await window.api.getFileTreeRoots({
    projectId,
    worktreeId,
  });
  const root = roots.find((candidate) => candidate.repoId === rootId);
  if (!root) {
    throw new Error(`Unknown file root "${rootId}" for this worktree.`);
  }
  return root;
}

/**
 * Narrow the portal script-run payload onto the desktop's discriminated
 * `ScriptRunRequest` union, throwing when the required routing ids for the
 * requested target are missing (the portal wire shape keeps them optional).
 */
function toScriptRunRequest(args: PortalScriptRunPayload): ScriptRunRequest {
  if (args.target === 'project') {
    const projectId = args.projectId ?? args.workspaceId;
    const worktreeId = args.worktreeId;
    if (!projectId || !worktreeId) {
      throw new Error(
        'script.run requires projectId and worktreeId for project-target scripts.',
      );
    }
    return {
      target: 'project',
      scriptName: args.scriptName,
      projectId,
      worktreeId,
    };
  }
  const workspaceId = args.workspaceId ?? args.projectId;
  const worktreeId = args.worktreeId;
  if (!workspaceId || !worktreeId) {
    throw new Error(
      'script.run requires workspaceId and worktreeId for workspace-target scripts.',
    );
  }
  if (args.target === 'workspace-repo') {
    if (!args.repoId) {
      throw new Error(
        'script.run requires repoId for workspace-repo-target scripts.',
      );
    }
    return {
      target: 'workspace-repo',
      scriptName: args.scriptName,
      workspaceId,
      worktreeId,
      repoId: args.repoId,
    };
  }
  return {
    target: 'workspace-root',
    scriptName: args.scriptName,
    workspaceId,
    worktreeId,
  };
}

/** Same narrowing as {@link toScriptRunRequest} for the hook-run union. */
function toHookRunRequest(args: PortalHookRunPayload): HookRunRequest {
  if (args.target === 'project') {
    const projectId = args.projectId ?? args.workspaceId;
    const worktreeId = args.worktreeId;
    if (!projectId || !worktreeId) {
      throw new Error(
        'hook.run requires projectId and worktreeId for project-target hooks.',
      );
    }
    return {
      target: 'project',
      triggerName: args.triggerName,
      projectId,
      worktreeId,
    };
  }
  const workspaceId = args.workspaceId ?? args.projectId;
  const worktreeId = args.worktreeId;
  if (!workspaceId || !worktreeId) {
    throw new Error(
      'hook.run requires workspaceId and worktreeId for workspace-target hooks.',
    );
  }
  if (args.target === 'workspace-repo') {
    if (!args.repoId) {
      throw new Error(
        'hook.run requires repoId for workspace-repo-target hooks.',
      );
    }
    return {
      target: 'workspace-repo',
      triggerName: args.triggerName,
      workspaceId,
      worktreeId,
      repoId: args.repoId,
    };
  }
  return {
    target: 'workspace-root',
    triggerName: args.triggerName,
    workspaceId,
    worktreeId,
  };
}

/**
 * Mirror of the pipelines-service `normalizePortalModelConfig`: fold the
 * portal model config (plus the deprecated `codexFastModeEnabled`) into the
 * desktop `AgentModelConfig`, returning `undefined` when nothing is set.
 */
function toAgentModelConfig(
  args: PortalPipelineRunPayload,
): AgentModelConfig | undefined {
  const modelConfig: AgentModelConfig = {};
  if (isThinkingLevel(args.modelConfig?.thinkingLevel)) {
    modelConfig.thinkingLevel = args.modelConfig.thinkingLevel;
  }
  if (args.modelConfig?.speed !== undefined) {
    modelConfig.speed = args.modelConfig.speed;
    modelConfig.fastMode =
      args.modelConfig.fastMode ?? args.modelConfig.speed === 'fast';
  } else if (typeof args.modelConfig?.fastMode === 'boolean') {
    modelConfig.fastMode = args.modelConfig.fastMode;
  } else if (typeof args.codexFastModeEnabled === 'boolean') {
    modelConfig.fastMode = args.codexFastModeEnabled;
  }
  return Object.keys(modelConfig).length > 0 ? modelConfig : undefined;
}

/**
 * Mirror of the main-process plans-service `toPlanDetail` projection so the
 * shared Plans UI sees the same `PortalPlanDetail` shape regardless of
 * transport (`content` canonical, `body` retained for legacy consumers).
 */
function toPortalPlanDetail(plan: TrackedPlanData): PortalPlanDetail {
  return {
    workspaceLocalId: plan.projectId,
    worktreeLocalId: plan.worktreeId,
    planId: plan.id,
    title: plan.title,
    status: plan.reviewStatus,
    source: plan.source,
    updatedAt: plan.updatedAt,
    content: plan.content,
    body: plan.content,
    reviewStatus: plan.reviewStatus,
    approvedAt: plan.approvedAt ?? null,
    dismissedAt: plan.dismissedAt ?? null,
    hidden: plan.hidden,
    latestRevisionNumber: plan.latestRevisionNumber,
    revisionNumber: plan.latestRevisionNumber,
  };
}

/**
 * Mirror of the plans-service `toRequestedPlanDetail`: a pinned
 * `revisionNumber` returns that revision's Markdown or `null`, never the
 * latest in its place (CAN-5354).
 */
function toRequestedPortalPlanDetail(
  plan: TrackedPlanData,
  revisionNumber: number | undefined,
): PortalPlanDetail | null {
  const detail = toPortalPlanDetail(plan);
  if (
    revisionNumber === undefined ||
    revisionNumber === plan.latestRevisionNumber
  ) {
    return detail;
  }
  const revision = plan.revisions.find(
    (candidate) => candidate.revisionNumber === revisionNumber,
  );
  if (!revision) return null;
  return {
    ...detail,
    content: revision.content,
    body: revision.content,
    revisionNumber: revision.revisionNumber,
    source: revision.source,
    status: revision.reviewStatus,
    reviewStatus: revision.reviewStatus,
    approvedAt: revision.approvedAt ?? null,
    dismissedAt: revision.dismissedAt ?? null,
  };
}

/**
 * Narrow the wire `plan.update` payload onto the desktop
 * `UpdateTrackedPlanRequest`. The wire keeps `source`/`reviewStatus` as
 * plain strings; unknown values fail loudly instead of corrupting the
 * persisted plan.
 */
function toUpdateTrackedPlanRequest(
  args: PortalPlanUpdatePayload,
): UpdateTrackedPlanRequest {
  const request: UpdateTrackedPlanRequest = {
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    planId: args.planId,
    ...(args.content !== undefined ? { content: args.content } : {}),
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.linkedExecutionId !== undefined
      ? { linkedExecutionId: args.linkedExecutionId }
      : {}),
    ...(args.approvedAt !== undefined ? { approvedAt: args.approvedAt } : {}),
    ...(args.dismissedAt !== undefined
      ? { dismissedAt: args.dismissedAt }
      : {}),
    ...(args.hidden !== undefined ? { hidden: args.hidden } : {}),
  };
  if (args.source !== undefined) {
    if (!isTrackedPlanSource(args.source)) {
      throw new Error(`Unknown plan source "${args.source}".`);
    }
    request.source = args.source;
  }
  if (args.reviewStatus !== undefined) {
    if (!isTrackedPlanReviewStatus(args.reviewStatus)) {
      throw new Error(`Unknown plan review status "${args.reviewStatus}".`);
    }
    request.reviewStatus = args.reviewStatus;
  }
  return request;
}

/**
 * Read a file through the desktop `readFileContent` IPC and project the
 * response into the canonical {@link PortalFilePreview} service shape.
 */
async function readFilePreview(
  args: PortalFileReadPayload,
): Promise<PortalFilePreview> {
  const root = await resolveFileRoot(
    args.projectId,
    args.worktreeId,
    args.fileRootLocalId ?? args.repoId,
  );
  const absolutePath = joinRootPath(root.absolutePath, args.relativePath);
  const segments = rootRelativeSegments(args.relativePath);
  // A renderer-owned root (archived attachments) is not a catalog root.
  const catalogRoot = localFileRootOverrides.get(root.repoId) !== root;
  const response = await window.api.readFileContent({
    // Kept for hosts that predate `file` (remote control); newer ones read `file`.
    absolutePath,
    workspaceTarget: {
      projectId: args.projectId,
      worktreeId: args.worktreeId,
    },
    ...(catalogRoot &&
      segments.length > 0 && {
        file: { fileRootId: root.repoId, relativePath: segments.join('/') },
      }),
  });
  if (response.kind === 'missing') {
    throw new Error(`File not found: ${args.relativePath}`);
  }
  if (response.kind === 'image' || response.kind === 'unsupported') {
    throw new Error('Binary files cannot be read.');
  }
  const canonical = response.canonical;
  if (canonical) {
    return {
      workspaceLocalId: args.projectId,
      worktreeLocalId: args.worktreeId,
      fileRootLocalId: canonical.fileRootId,
      path: args.relativePath,
      content: response.content,
      language: languageForPath(args.relativePath),
      size: canonical.sizeBytes,
      version: canonical.version,
      truncated: canonical.truncated,
      modifiedAt: canonical.modifiedAt,
    };
  }
  // A host without the canonical read: renderer-owned roots, the sealed
  // viewer, or a remote-control host from before CAN-4099.
  return {
    workspaceLocalId: args.projectId,
    worktreeLocalId: args.worktreeId,
    fileRootLocalId: root.repoId,
    path: args.relativePath,
    content: response.content,
    language: languageForPath(args.relativePath),
    size: response.sizeBytes,
    version: versionFrom(response.sizeBytes, response.modifiedAtMs),
    truncated: response.truncated,
    modifiedAt: new Date(response.modifiedAtMs).toISOString(),
  };
}

/** List the desktop file-tree roots as portal {@link PortalFileRoot} rows. */
async function listPortalFileRoots(args: {
  projectId: string;
  worktreeId: string;
}): Promise<PortalFileRoot[]> {
  const { roots } = await window.api.getFileTreeRoots({
    projectId: args.projectId,
    worktreeId: args.worktreeId,
  });
  return roots.map((root) => ({
    workspaceLocalId: args.projectId,
    worktreeLocalId: args.worktreeId,
    fileRootLocalId: root.repoId,
    label: root.repoName,
    absolutePath: root.absolutePath,
  }));
}

/** List one directory as a portal {@link PortalDirectoryListing}. */
async function listPortalDirectory(args: {
  projectId: string;
  worktreeId: string;
  repoId: string;
  relativeDir: string;
}): Promise<PortalDirectoryListing> {
  const { entries } = await window.api.getFileTreeDirectory({
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    repoId: args.repoId,
    relativeDir: args.relativeDir,
  });
  return {
    workspaceLocalId: args.projectId,
    worktreeLocalId: args.worktreeId,
    fileRootLocalId: args.repoId,
    path: args.relativeDir,
    entries: entries.map((entry) => ({
      name: entry.name,
      path: entry.relativePath,
      type: entry.kind,
    })),
  };
}

/**
 * Resolve the `(projectId, worktreeId)` routing pair for a chat-tab-settings
 * persist. Standalone (cowork) chats key their tabs file per Work Entry
 * (the entry id occupies the worktreeId slot), reusing the worktree
 * `(projectId, worktreeId)` persistence plumbing.
 */
function resolveChatTabsRouting(
  args: CommandMap['chat.persistTabSettings']['args'],
): { projectId: string; worktreeId: string } {
  const projectId = args.workspaceLocalId;
  if (!projectId) {
    throw new Error(
      'chat.persistTabSettings requires workspaceLocalId to route to the chat tabs file on desktop.',
    );
  }
  let worktreeId = args.worktreeLocalId;
  if (args.scope === 'standalone' && !worktreeId) {
    // Callers should carry an explicit Work Entry id; when one is missing,
    // fall back to the currently active entry for this workspace, and only
    // then to the LEGACY-only `COWORK_HOME_WORKTREE_ID` (pre-Work-Entries
    // data keyed the single home worktree).
    const standaloneState = useStandaloneChatStore.getState();
    worktreeId =
      standaloneState.activeChatProjectId === projectId &&
      standaloneState.activeWorkEntryId !== null
        ? standaloneState.activeWorkEntryId
        : COWORK_HOME_WORKTREE_ID;
  }
  if (!worktreeId) {
    throw new Error(
      'chat.persistTabSettings requires worktreeLocalId for worktree-scoped chats on desktop.',
    );
  }
  return { projectId, worktreeId };
}

/**
 * Desktop implementation of {@link CanopyClient} over the Electron `window.api`
 * IPC bridge. Shared feature components consume it through `CanopyClientProvider`
 * (wired in CAN-737) and never touch `window.api` directly.
 *
 * Each query/command/domain-event is dispatched through an exhaustive, fully
 * typed handler registry (`{ [K in Name]: (args) => ... }`), which keeps the
 * generic method bodies sound without any `as` casts. Handlers map the neutral
 * portal payloads onto the existing desktop IPC surface; operations without a
 * clean existing IPC path stay rejected with an explanatory error until the
 * owning slice lands (see per-handler comments).
 */
export class IpcCanopyClient implements CanopyClient {
  openExternalUrl(url: string): void {
    void window.api.browser.openExternal({ url });
  }

  readonly transcripts = ipcTranscriptReadClient;
  readonly sharedMultiRepo: NonNullable<CanopyClient['sharedMultiRepo']> = {
    prepare: (params) => window.api.orgProjects.sharedMultiRepo.prepare(params),
    create: (params) => window.api.orgProjects.sharedMultiRepo.create(params),
    resume: (creationKey) =>
      window.api.orgProjects.sharedMultiRepo.create({ creationKey }),
    getCreation: (key) =>
      window.api.orgProjects.sharedMultiRepo.getCreation(key),
    listCreations: () => window.api.orgProjects.sharedMultiRepo.listCreations(),
    catalog: (organizationId) =>
      window.api.orgProjects.refresh({
        context: { kind: 'organization', organizationId },
      }),
    cancelSetup: async (_organizationId, projectId) => {
      await window.api.orgProjects.setupCancel({ projectId });
    },
  };
  readonly capabilities: CanopyCapabilities;

  /**
   * Write-through cache of the last settings persisted per chat this app
   * session. `chat.getTabSettings` args carry only `chatId` — no
   * workspace/worktree routing — so the desktop cannot locate the persisted
   * `ChatTabsFile` on disk from the query alone. Same-session reads are
   * served from here; cross-restart restore needs routing fields added to
   * the query contract (see the `chat.getTabSettings` handler).
   */
  private readonly sessionTabSettings = new Map<string, ChatTabSettings>();

  readonly settings?: AccountOrganizationSettingsClient;

  readonly marketplaceSources?: MarketplaceSourcesClient;

  constructor(
    capabilities: CanopyCapabilities = createDesktopCapabilities(
      resolveDesktopPlatform(),
      {},
      { accountOrganizationSettings: resolveSettingsBridge() !== null },
    ),
  ) {
    this.capabilities = capabilities;
    if (
      capabilities.marketplaceSources === true &&
      typeof window !== 'undefined' &&
      window.plugins
    ) {
      this.marketplaceSources = createIpcMarketplaceSourcesClient(
        window.plugins,
      );
    }
    const settingsBridge = resolveSettingsBridge();
    if (capabilities.accountOrganizationSettings === true && settingsBridge) {
      const accountIds = createCanopyCloudAccountIdSource(() =>
        window.api.loadCanopyCloudAccount(),
      );
      this.settings = createDesktopSettingsClient(
        settingsBridge,
        accountIds.get,
        { onUnauthenticated: accountIds.invalidate },
      );
    }
  }

  // Only available during synchronous change delivery: store reloads consume
  // main's already refreshed snapshot, while explicit refreshes still fetch.
  private readonly orgProjectBroadcasts = new Map<
    string,
    DesktopOrgProjectCatalogSnapshot
  >();

  private readonly queryHandlers: QueryHandlers = {
    'delegation.lifetimeStatus': (args) =>
      window.api.managedDelegation.getLifetimeStatus(args),
    // The bridge preserves typed error codes, so these skip unwrapIpcError.
    'scriptActions.list': (args) => window.api.scriptActions.list(args),
    'scriptActions.receipt': (args) => window.api.scriptActions.receipt(args),
    'repoRules.scan': (args) => unwrapIpcError(window.api.repoRules.scan(args)),
    'repoRules.status': (args) =>
      unwrapIpcError(window.api.repoRules.status(args)),
    'repoRules.preview': (args) =>
      unwrapIpcError(window.api.repoRules.preview(args)),
    'editorSetup.presence': (args) =>
      unwrapIpcError(window.api.editorSetup.presence(args)),
    'organization.inviteStatus': async (args) =>
      organizationOperationReply(
        OrganizationInviteStatusSchema,
        await window.api.personalOrganizationUpgrade.inviteStatus(args),
      ),
    ...ipcTerminalQueryHandlers,
    // Organization projects (CAN-2955): the main-owned catalog per context.
    'orgProjects.catalog': (args) => {
      const broadcast = this.orgProjectBroadcasts.get(
        serializeWorkspaceContext(args.context),
      );
      if (broadcast) return Promise.resolve(broadcast);
      return args.refresh === true
        ? window.api.orgProjects.refresh({
            context: args.context,
            force: true,
            ...(args.repositories === true ? { repositories: true } : {}),
          })
        : window.api.orgProjects.list({ context: args.context });
    },
    'workspaceContext.get': () => window.api.workspaceContext.get(),
    'personalOrganization.projects': () =>
      window.api.personalOrganizationUpgrade.listProjects(),
    'personalOrganization.operationStatus': (args) =>
      window.api.personalOrganizationUpgrade.status({
        operationId: args.operationId,
      }),
    'referencePreview.linearScope': () =>
      window.api.referencePreview.linearScope(),
    'referencePreview.linearIssue': (args) =>
      window.api.referencePreview.linearIssue(args),
    'referencePreview.linearTeams': () =>
      window.api.referencePreview.linearTeams(),
    'referencePreview.githubScope': () =>
      window.api.referencePreview.githubScope(),
    'referencePreview.githubOrigin': (args) =>
      window.api.referencePreview.githubOrigin(args),
    'referencePreview.github': (args) =>
      window.api.referencePreview.github(args),
    'session.snapshot': (args) => window.api.getDesktopSessionSnapshot(args),
    'file.read': (args) => readFilePreview(args),
    // A projection over `worker.filesystem.link.resolve` in transcript mode
    // (CAN-5038), through `file-reference:resolve`. Local desktop chat links
    // keep their own renderer-owned resolver; an older host answers `null`.
    'file.resolveLink': async (args) => {
      const resolved = await window.api.resolveFileReference({
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        baseFilePath: '',
        href: args.href,
        mode: 'transcript',
      });
      const canonical = resolved?.canonical;
      return canonical?.kind === 'file'
        ? {
            fileRootLocalId: canonical.fileRootId,
            relativePath: canonical.relativePath,
          }
        : null;
    },
    // Deferred: the desktop diff IPC (`activity.getFileDiff`) returns
    // old/new value pairs for a side-by-side renderer, not the unified
    // `patch` + changed-file summary `PortalDiffPayload` requires, and there
    // is no renderer-reachable IPC for the combined worktree patch. Bridging
    // this cleanly needs the main-process `readDiff` service exposed over
    // IPC, which is out of scope for a renderer-adapter-only change.
    'diff.read': () =>
      Promise.reject(
        new Error(
          'diff.read is not yet bridged on desktop; the file-viewer adopt slice provides the mapping.',
        ),
      ),
    'file.roots': (args) =>
      listPortalFileRoots({
        projectId: args.projectId,
        worktreeId: args.worktreeId,
      }),
    'file.index': async (args): Promise<PortalFileIndex> => {
      try {
        const index = await window.api.getFileIndex({
          projectId: args.projectId,
          worktreeId: args.worktreeId,
          purpose: 'file-explorer',
        });
        const repo = index.repos.find(
          (candidate): boolean => candidate.repoId === args.fileRootLocalId,
        );
        const needle = (args.q ?? '').toLowerCase();
        const matched = (repo?.files ?? []).filter((file): boolean =>
          file.relativePath.toLowerCase().includes(needle),
        );
        const limit = Math.max(0, Math.min(args.limit ?? 25_000, 25_000));
        return {
          fileRootLocalId: args.fileRootLocalId,
          paths: matched
            .slice(0, limit)
            .map((file): string => file.relativePath),
          truncated: repo?.truncated === true || matched.length > limit,
        };
      } catch (error) {
        throw new Error(extractIpcErrorMessage(error));
      }
    },
    'file.directory': (args) =>
      listPortalDirectory({
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        repoId: args.repoId,
        relativeDir: args.relativeDir,
      }),
    // Deferred to TS-05 (CAN-765, lazy scrollback): on desktop the whole
    // transcript is local, but chunking it into turn-aligned
    // `PortalChatHistoryChunk`s requires the main-process transcript
    // projector; no renderer-reachable IPC exposes that projection yet.
    'chat.history': () =>
      Promise.reject(
        new Error(
          'chat.history is not yet bridged on desktop; lazy scrollback (TS-05) provides the mapping.',
        ),
      ),
    'plan.get': async (args) => {
      const plan = await window.api.activity.plans.get({
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        planId: args.planId,
      });
      const detail = plan
        ? toRequestedPortalPlanDetail(plan, args.revisionNumber)
        : null;
      if (!detail) {
        throw new Error('Plan not found.');
      }
      return detail;
    },
    // The query args carry only `chatId`, so the persisted worktree
    // `ChatTabsFile` cannot be located on disk here (it is keyed by
    // `(projectId, worktreeId)`); serve the write-through session cache and
    // fall back to `null` — the contract's "nothing persisted yet" value.
    // Cross-restart restore needs the same optional scope/workspaceLocalId/
    // worktreeLocalId routing fields `chat.persistTabSettings` has.
    'chat.getTabSettings': (args) =>
      Promise.resolve(this.sessionTabSettings.get(args.chatId) ?? null),
    'workspace.claudeMd.get': (args) =>
      window.api.loadClaudeMd({ workspaceId: args.workspaceId }),
    'workspace.scripts.get': (args) =>
      window.api.readWorkspaceScripts({ workspaceId: args.workspaceId }),
    // App Advisor settings are already owned by the native modal on desktop;
    // this RPC exists specifically for the paired web relay.
    'appAdvisor.settings.get': () =>
      Promise.reject(
        new Error(
          'appAdvisor.settings.get is only available through the web portal relay.',
        ),
      ),
    // Turn-level ratings (CAN-1521). The main-process handler merges server
    // rows with still-pending outbox entries and resolves (never rejects).
    'turnFeedback.list': (args) =>
      window.api.listTurnFeedback({ clientChatId: args.clientChatId }),
    // Rejects when there is no real value, so the row shows a locked state.
    'account.installUpdateEmails.get': () =>
      window.api.loadInstallUpdateEmailPreference(),
    'onboardingTips.get': async () => ({
      dismissed: await loadOnboardingTipDismissals(),
    }),
  };

  private readonly commandHandlers: CommandHandlers = {
    'delegation.extendLifetimeLimit': (args) =>
      window.api.managedDelegation.extendLifetimeLimit(args),
    'providerUsage.refresh': async ({ provider }) => {
      await window.api.observability.refreshUsage(provider);
    },
    'repoRules.apply': (args) =>
      unwrapIpcError(window.api.repoRules.apply(args)),
    'scriptActions.rescan': (args) => window.api.scriptActions.rescan(args),
    'scriptActions.review': (args) => window.api.scriptActions.review(args),
    'scriptActions.setShortcut': (args) =>
      window.api.scriptActions.setShortcut(args),
    'scriptActions.setPinned': (args) =>
      window.api.scriptActions.setPinned(args),
    'scriptActions.enableShellAliasScan': (args) =>
      window.api.scriptActions.enableShellAliasScan(args),
    'sidebar.itemGroups.create': (args) =>
      window.api.sidebarItemGroups.create(args),
    'sidebar.itemGroups.update': (args) =>
      window.api.sidebarItemGroups.update(args),
    'sidebar.itemGroups.ungroup': (args) =>
      window.api.sidebarItemGroups.ungroup(args),
    'sidebar.itemGroups.moveItem': (args) =>
      window.api.sidebarItemGroups.moveItem(args),
    'sidebar.itemGroups.moveGroup': (args) =>
      window.api.sidebarItemGroups.moveGroup(args),

    ...ipcTerminalCommandHandlers,
    'orgProjects.setPreference': async (args) => {
      // The preference belongs to the context the row was listed in, which is
      // the context this window is looking at.
      await window.api.orgProjects.setPreference({
        context: useWorkspaceContextStore.getState().state.context,
        projectId: args.projectId,
        preference: args.preference,
      });
    },
    'orgProjects.setupStart': (args) => window.api.orgProjects.setupStart(args),
    'orgProjects.setupCancel': (args) =>
      window.api.orgProjects.setupCancel(args),
    'personalOrganization.upgrade': async (args) =>
      organizationOperationReply(
        PersonalOrganizationPromotionOutcomeSchema,
        await window.api.personalOrganizationUpgrade.promote(args),
      ),
    'personalOrganization.convertProjects': (args) =>
      window.api.personalOrganizationUpgrade.convert(args),
    'organization.invite': async (args) =>
      organizationOperationReply(
        OrganizationInviteResultSchema,
        await window.api.personalOrganizationUpgrade.invite({
          organizationId: args.organizationId,
          invite: args.invite,
        }),
      ),
    'workspaceContext.set': (args) =>
      window.api.workspaceContext.set({
        context: args.context,
        expectedRevision: args.expectedRevision,
      }),
    // Desktop has no relayed portal session to end, so this is a no-op.
    'session.end': () => Promise.resolve(),
    // Map the high-level settings convenience one-to-one onto a scoped,
    // revisioned command. The adapter never reads/merges/writes a tab snapshot.
    'chat.persistTabSettings': async (args) => {
      const { projectId, worktreeId } = resolveChatTabsRouting(args);
      const result = await window.api.chat.command({
        schemaVersion: 1,
        commandId: `renderer-chat-settings-${args.chatId}-${crypto.randomUUID()}`,
        projectId,
        worktreeId,
        command: {
          type: 'chat.patch_tab_settings',
          tabId: args.chatId,
          patch: {
            planMode: args.settings.planMode,
            proposalMode: args.settings.proposalMode,
            modelConfig: {
              thinkingLevel: args.settings.thinkingLevel,
            },
            pendingPlanExit: args.settings.pendingPlanExit ?? null,
          },
        },
      });
      if (
        result.outcome !== 'applied' &&
        result.outcome !== 'already_applied'
      ) {
        throw new Error(
          result.reason ??
            `chat.persistTabSettings was not applied (${result.outcome}).`,
        );
      }
      // Keep the same-session cache in sync so `chat.getTabSettings` (which
      // has no routing context) can serve the latest persisted settings.
      this.sessionTabSettings.set(args.chatId, args.settings);
    },
    'chat.queue.cancel': async (args) => {
      await window.api.chat.cancelQueuedMessage(args);
    },
    'chat.queue.edit': async (args) => {
      await window.api.chat.editQueuedMessage(args);
    },
    'chat.queue.force': async (args) => {
      await window.api.chat.forceQueuedMessage(args);
    },
    'chat.queue.steer': async (args) => {
      const result = await window.api.chat.command({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        command: {
          type: 'chat.steer_queued_message',
          chatId: args.chatId,
          queuedMessageId: args.entryId,
        },
      });
      if (!['applied', 'already_applied'].includes(result.outcome))
        throw new Error(result.reason ?? 'Steering could not be confirmed');
    },
    'chat.inputDelivery': async (args) => {
      const result = await window.api.chat.command({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        command: {
          type: 'chat.input_delivery_action',
          chatId: args.chatId,
          rowId: args.rowId,
          rowRevision: args.rowRevision,
          action: args.action,
          ...(args.text !== undefined ? { text: args.text } : {}),
        },
      });
      if (!['applied', 'already_applied'].includes(result.outcome))
        throw new Error(
          result.reason ?? 'The message action could not be confirmed',
        );
    },
    'chat.queue.set_edit_lock': async (args) => {
      await window.api.chat.setQueuedMessageEditLock(args);
    },
    // Resolve the target root, write through the desktop `saveFileContent`
    // IPC (which owns containment + conflict checks), and shape the post-write
    // stat into the re-read `PortalFilePreview` the store expects.
    'file.create': async (args): Promise<PortalFileMutationResult> => {
      try {
        const root = await resolveFileRoot(
          args.projectId,
          args.worktreeId,
          args.fileRootLocalId,
        );
        const target = { repoId: root.repoId, relativePath: args.relativePath };
        await window.api.mutateFileTree({
          projectId: args.projectId,
          worktreeId: args.worktreeId,
          operation: 'create-file',
          target,
        });
        return {
          fileRootLocalId: root.repoId,
          path: args.relativePath,
          kind: 'create',
        };
      } catch (error) {
        throw new Error(extractIpcErrorMessage(error));
      }
    },
    'file.mkdir': async (args): Promise<PortalFileMutationResult> => {
      try {
        const root = await resolveFileRoot(
          args.projectId,
          args.worktreeId,
          args.fileRootLocalId,
        );
        const target = { repoId: root.repoId, relativePath: args.relativePath };
        await window.api.mutateFileTree({
          projectId: args.projectId,
          worktreeId: args.worktreeId,
          operation: 'create-directory',
          target,
        });
        return {
          fileRootLocalId: root.repoId,
          path: args.relativePath,
          kind: 'mkdir',
        };
      } catch (error) {
        throw new Error(extractIpcErrorMessage(error));
      }
    },
    'file.rename': async (args): Promise<PortalFileMutationResult> => {
      try {
        const root = await resolveFileRoot(
          args.projectId,
          args.worktreeId,
          args.fileRootLocalId,
        );
        const target = { repoId: root.repoId, relativePath: args.relativePath };
        await window.api.mutateFileTree({
          projectId: args.projectId,
          worktreeId: args.worktreeId,
          operation: 'move',
          source: target,
          target: { repoId: root.repoId, relativePath: args.toRelativePath },
          conflict: 'error',
        });
        return {
          fileRootLocalId: root.repoId,
          path: args.toRelativePath,
          kind: 'rename',
          fromPath: args.relativePath,
        };
      } catch (error) {
        throw new Error(extractIpcErrorMessage(error));
      }
    },
    'file.delete': async (args): Promise<PortalFileMutationResult> => {
      try {
        const root = await resolveFileRoot(
          args.projectId,
          args.worktreeId,
          args.fileRootLocalId,
        );
        const target = { repoId: root.repoId, relativePath: args.relativePath };
        await window.api.mutateFileTree({
          projectId: args.projectId,
          worktreeId: args.worktreeId,
          operation: 'delete',
          target,
          useTrash: true,
        });
        return {
          fileRootLocalId: root.repoId,
          path: args.relativePath,
          kind: 'delete',
        };
      } catch (error) {
        throw new Error(extractIpcErrorMessage(error));
      }
    },
    'file.save': async (args) => {
      const root = await resolveFileRoot(
        args.projectId,
        args.worktreeId,
        args.fileRootLocalId ?? args.repoId,
      );
      const absolutePath = joinRootPath(root.absolutePath, args.relativePath);
      let response: Awaited<ReturnType<typeof window.api.saveFileContent>>;
      try {
        response = await window.api.saveFileContent({
          projectId: args.projectId,
          worktreeId: args.worktreeId,
          absolutePath,
          content: args.content,
          ...(args.expectedModifiedAtMs !== undefined
            ? { expectedModifiedAtMs: args.expectedModifiedAtMs }
            : {}),
        });
      } catch (error) {
        // Electron decorates invoke failures with the channel and error class.
        // Restore the typed stale-version refusal so the store can recover;
        // keep transport details out of every other user-facing error.
        if (extractIpcErrorName(error) === 'FileSaveConflictError') {
          throw new FileSaveConflictError(extractIpcErrorMessage(error));
        }
        throw new Error(extractIpcErrorMessage(error));
      }
      return {
        workspaceLocalId: args.projectId,
        worktreeLocalId: args.worktreeId,
        fileRootLocalId: root.repoId,
        path: args.relativePath,
        content: args.content,
        language: languageForPath(args.relativePath),
        size: response.sizeBytes,
        version: versionFrom(response.sizeBytes, response.modifiedAtMs),
        truncated: false,
        modifiedAt: new Date(response.modifiedAtMs).toISOString(),
      };
    },
    // Persist the workspace's activity-section order through the same
    // load → update → save sidebar-items round-trip the desktop
    // `projectsStore.reorderActivitySections` uses. Unknown section ids on
    // the wire are filtered out rather than persisted.
    'activity.setSectionOrder': async (args) => {
      const order = args.order.filter(isActivitySectionId);
      const file = await window.api.loadProjects();
      const items = file.items.map((item) =>
        item.id === args.workspaceLocalId && item.type !== 'cowork'
          ? { ...item, activitySectionOrder: order }
          : item,
      );
      await window.api.saveProjects(items);
    },
    'activity.stopBackgroundTask': (args) =>
      window.api.activity.stopBgProcess({
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        chatId: args.chatId,
        taskId: args.taskId,
      }),
    'workspace.create': async (args) => {
      const destinationDir = await window.api.getDefaultCloneDirectory();
      const workspace = await window.api.addWorkspaceFromRemote({
        remoteUrl: args.remoteUrl,
        destinationDir,
      });
      await window.api.invalidateDesktopSessionSnapshot();
      return { status: 'completed', workspaceId: workspace.id };
    },
    'workspace.update': async (args) => {
      await window.api.updateWorkspaceMetadata({
        workspaceId: args.workspaceId,
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.color !== undefined ? { color: args.color } : {}),
      });
      await window.api.invalidateDesktopSessionSnapshot();
    },
    'workspace.delete': async (args) => {
      const item = await loadDesktopWorkspace(args.workspaceId);
      // CAN-5337: the interrupted deletion the person confirmed superseding.
      const superseded =
        args.supersedeInterruptedDeletion !== undefined
          ? { supersedeInterruptedDeletion: args.supersedeInterruptedDeletion }
          : {};
      if (item.type === 'single-repo') {
        await window.api.deleteProject({
          projectId: args.workspaceId,
          ...superseded,
        });
      } else {
        // Multi-repo and cowork workspaces share the workspace deletion path.
        await window.api.deleteWorkspace({
          workspaceId: args.workspaceId,
          ...superseded,
        });
      }
      await window.api.invalidateDesktopSessionSnapshot();
    },
    'lifecycleJournal.inspect': () => window.api.inspectLifecycleJournal(),
    'lifecycleJournal.quarantine': (args) =>
      window.api.quarantineLifecycleJournalEntry(args),
    'worktree.discard.describe': (args) =>
      window.api.describeWorktreeDiscard({
        projectId: args.workspaceId,
        worktreeId: args.worktreeId,
      }),
    'worktree.discard': (args) =>
      window.api.discardWorktree({
        projectId: args.workspaceId,
        worktreeId: args.worktreeId,
        confirmation: args.confirmation,
      }),
    'workspace.delete.discard.describe': (args) =>
      window.api.describeProjectDeletionDiscard({
        workspaceId: args.workspaceId,
      }),
    'workspace.reorder': async (args) => {
      await window.api.reorderWorkspaces(args);
      await window.api.invalidateDesktopSessionSnapshot();
    },
    'worktree.create': async (args) => {
      const item = await loadDesktopWorkspace(args.workspaceId);
      if (item.type === 'cowork') {
        throw new Error('Cannot create a worktree in a cowork project.');
      }
      const existingWorktreeIds =
        args.existingWorktreeIds ??
        item.worktrees.map((worktree) => worktree.id);
      const created =
        item.type === 'multi-repo'
          ? await window.api.createWorkspaceWorktree({
              workspaceId: args.workspaceId,
              existingWorktreeIds,
              ...(args.baseWorktreeId
                ? { baseWorktreeId: args.baseWorktreeId }
                : {}),
            })
          : await window.api.createWorktree({
              projectId: args.workspaceId,
              repoPath: item.repoPath,
              existingWorktreeIds,
              ...(args.baseWorktreeId
                ? { baseWorktreeId: args.baseWorktreeId }
                : {}),
            });
      if ('needsRepair' in created && created.needsRepair) {
        throw new Error('The new worktree requires project repair.');
      }
      if (args.forkOpenTabs && args.baseWorktreeId) {
        try {
          const { forkOpenWorktreeState } =
            await import('@/lib/worktree-state-fork');
          await forkOpenWorktreeState({
            projectId: args.workspaceId,
            sourceWorktreeId: args.baseWorktreeId,
            destinationWorktreeId: created.id,
          });
        } catch (error: unknown) {
          // Creation has already committed. Report it as completed so a web
          // retry cannot create a duplicate worktree; the destination remains
          // usable with its normal empty-tab fallback.
          reportRendererConsoleError(
            'Failed to carry open tabs to portal-created branched worktree',
            { error },
          );
        }
      }
      await window.api.invalidateDesktopSessionSnapshot();
      return {
        status: 'completed',
        worktreeId: created.id,
        branchName: created.branchName,
      };
    },
    'worktree.update': async (args) => {
      let changed = false;
      try {
        if (args.label !== undefined) {
          await window.api.setWorktreeLabel({
            projectId: args.workspaceId,
            worktreeId: args.worktreeId,
            ...(args.label !== null ? { label: args.label } : {}),
          });
          changed = true;
        }
        if (args.hidden !== undefined) {
          await window.api.setWorktreeHidden({
            projectId: args.workspaceId,
            worktreeId: args.worktreeId,
            hidden: args.hidden,
          });
          changed = true;
        }
      } finally {
        if (changed) {
          await window.api
            .invalidateDesktopSessionSnapshot()
            .catch(() => undefined);
        }
      }
    },
    'worktree.archive': async (args) => {
      const item = await loadDesktopWorkspace(args.workspaceId);
      if (item.type === 'cowork') {
        throw new Error('Cannot archive a worktree in a cowork project.');
      }
      const target = item.worktrees.find(
        (worktree) => worktree.id === args.worktreeId,
      );
      if (!target) {
        throw new Error('Worktree to archive was not found.');
      }
      const remainingWorktreeOrder = item.worktrees
        .filter((worktree) => worktree.id !== args.worktreeId)
        .map((worktree) => worktree.id);
      const requestOrder = {
        remainingWorktreeOrder,
        expectedRemainingWorktreeOrder: remainingWorktreeOrder,
        ...(target.createdAt ? { expectedCreatedAt: target.createdAt } : {}),
      };
      if (item.type === 'multi-repo') {
        await window.api.archiveWorkspaceWorktree({
          workspaceId: args.workspaceId,
          worktreeId: args.worktreeId,
          ...requestOrder,
        });
      } else {
        await window.api.archiveWorktree({
          projectId: args.workspaceId,
          worktreeId: args.worktreeId,
          repoPath: item.repoPath,
          ...requestOrder,
        });
      }
      await window.api.invalidateDesktopSessionSnapshot();
    },
    'worktree.reorder': async (args) => {
      await window.api.reorderWorktrees(args);
      await window.api.invalidateDesktopSessionSnapshot();
    },
    'workspace.claudeMd.save': async (args) => {
      await window.api.saveClaudeMd(args);
      await window.api.invalidateDesktopSessionSnapshot();
    },
    'workspace.scripts.save': async (args) => {
      await window.api.mergeWorkspaceScripts(args);
      await window.api.invalidateDesktopSessionSnapshot();
    },
    'appAdvisor.settings.save': () =>
      Promise.reject(
        new Error(
          'appAdvisor.settings.save is only available through the web portal relay.',
        ),
      ),
    // Scripts / hooks map 1:1 onto the desktop run/stop IPC (the same
    // service functions the web relay's portal command adapters call). The
    // desktop invoke resolves when the run completes; run status still
    // streams to the UI via the script/hook event channels, so resolving
    // late keeps the fire-and-forget contract observable.
    'script.run': async (args) => {
      await window.api.runScript(toScriptRunRequest(args));
    },
    'script.cancel': async (args) => {
      await window.api.stopScript({
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        scriptKey: args.scriptKey,
      });
    },
    'hook.run': async (args) => {
      await window.api.runHook(toHookRunRequest(args));
    },
    'hook.cancel': async (args) => {
      await window.api.stopHook({
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        hookKey: args.hookKey,
      });
    },
    // Mirror of the main-process portal `runPipeline` flow over the
    // renderer-reachable `window.pipelines` API: resolve the worktree cwd,
    // discover the project pipeline by id, load its content, and execute.
    'pipeline.run': async (args) => {
      const { projectId, worktreeId } = args;
      if (!projectId || !worktreeId) {
        throw new Error(
          'pipeline.run requires projectId and worktreeId on desktop.',
        );
      }
      if (args.cwd) {
        // The main-process portal service resolves a relative `cwd` inside the
        // worktree with containment checks; the renderer cannot do that safely,
        // so explicit cwd overrides are rejected until a main-side IPC exists.
        throw new Error(
          'pipeline.run with an explicit cwd is not supported by the desktop adapter.',
        );
      }
      const cwd = await window.api.getWorktreePath({ projectId, worktreeId });
      const discovered = await window.pipelines.discoverProject(cwd);
      if (!discovered.success || !discovered.data) {
        throw new Error(discovered.error ?? 'Unable to discover pipelines.');
      }
      const info = discovered.data.find(
        (pipeline) => pipeline.id === args.pipelineId,
      );
      if (!info?.filePath) {
        throw new Error('Pipeline not found.');
      }
      const detail = await window.pipelines.get({
        id: info.id,
        cwd,
        filePath: info.filePath,
      });
      if (!detail.success || !detail.data) {
        throw new Error(detail.error ?? 'Unable to load pipeline.');
      }
      const modelConfig = toAgentModelConfig(args);
      const result = await window.pipelines.execute(detail.data.content, {
        cwd,
        pipelineId: args.pipelineId,
        pipelineFilePath: info.filePath,
        repoPath: cwd,
        projectId,
        worktreeId,
        ...(args.planId ? { planId: args.planId } : {}),
        ...(args.inputs && Object.keys(args.inputs).length > 0
          ? { inputs: args.inputs }
          : {}),
        ...(modelConfig ? { modelConfig } : {}),
      });
      if (!result.success) {
        throw new Error(result.error ?? 'Pipeline execution failed to start.');
      }
    },
    'pipeline.cancel': async (args) => {
      const result = await window.pipelines.cancelExecution(args.executionId);
      if (!result.success) {
        throw new Error(result.error ?? 'Unable to cancel pipeline execution.');
      }
    },
    // PR git actions. `commit_and_push` / `push` / `pull` map onto the
    // desktop GitHub IPC; `create` and `update_base_branch` are rejected
    // (see comments) until the desktop exposes IPC that honors the portal
    // payloads.
    'pr.action': async (args) => {
      const projectId = args.workspaceLocalId;
      const worktreeId = args.worktreeLocalId;
      switch (args.action) {
        case 'commit_and_push': {
          const repos = await window.api.listWorktreeRepoEntries({
            projectId,
            worktreeId,
          });
          const allowed = args.repoIds?.length ? new Set(args.repoIds) : null;
          const selected = allowed
            ? repos.filter((repo) => allowed.has(repo.repoId))
            : repos;
          const response = await window.api.github.commitAndPush({
            projectId,
            worktreeId,
            // Pin the caller's commit message to every targeted repo so the
            // backend uses it verbatim instead of generating one per repo.
            messages: selected.map((repo) => ({
              repoId: repo.repoId,
              repoName: repo.repoName,
              message: args.commitMessage,
            })),
            ...(args.repoIds?.length ? { repoIds: args.repoIds } : {}),
          });
          // The IPC reports per-repo failures in the response instead of
          // throwing; the portal main-service equivalent (`runPrAction`) is
          // fail-fast, so surface partial/total failure as a rejection here
          // to keep command semantics aligned across adapters.
          const failed = response.failedRepos.map(
            (repo) => `${repo.repoName}: ${repo.error}`,
          );
          const pendingAgents = response.agentResolutionRepos.map(
            (repo) => `${repo.repoName} (${repo.kind})`,
          );
          if (failed.length > 0 || pendingAgents.length > 0) {
            const parts: string[] = [];
            if (failed.length > 0) {
              parts.push(`failed repos — ${failed.join('; ')}`);
            }
            if (pendingAgents.length > 0) {
              parts.push(
                `repos pending agent conflict resolution — ${pendingAgents.join('; ')}`,
              );
            }
            throw new Error(
              `commit_and_push did not complete for all repos: ${parts.join(' | ')}`,
            );
          }
          return;
        }
        case 'push': {
          if (args.repoIds?.length) {
            // `PushOnlyRequest` has no repo scoping; failing loudly beats
            // silently pushing every repo in the worktree.
            throw new Error(
              'pr.action push with repo scoping is not supported by the desktop adapter.',
            );
          }
          await window.api.github.pushOnly({ projectId, worktreeId });
          return;
        }
        case 'pull': {
          if (args.repoIds?.length) {
            throw new Error(
              'pr.action pull with repo scoping is not supported by the desktop adapter.',
            );
          }
          await window.api.github.pull({ projectId, worktreeId });
          return;
        }
        case 'create':
          // Deferred: the desktop `githubCreatePr` IPC generates its own PR
          // title/body (AI-backed) and does not accept the explicit
          // title/body the portal contract requires be used verbatim.
          throw new Error(
            'pr.action create is not yet bridged on desktop; the desktop createPr IPC does not accept an explicit title/body.',
          );
        case 'update_base_branch':
          // Deferred: `githubUpdatePrBaseBranch` requires a `prNumber` the
          // portal payload does not carry, and no renderer-reachable IPC
          // returns the current PR status on demand to resolve it.
          throw new Error(
            'pr.action update_base_branch is not yet bridged on desktop; resolving the PR number requires a PR-status query IPC.',
          );
      }
    },
    // Deferred for the same reason as `pr.action` create: the desktop PR
    // creation IPC generates PR content itself instead of honoring the
    // portal payload's explicit title/body/draft fields.
    'pr.create': () =>
      Promise.reject(
        new Error(
          'pr.create is not yet bridged on desktop; the desktop createPr IPC does not accept an explicit title/body.',
        ),
      ),
    'pr.refresh': async (args) => {
      await window.api.github.requestPrStatusRefresh({
        projectId: args.workspaceLocalId,
        worktreeId: args.worktreeLocalId,
      });
    },
    'plan.update': async (args) => {
      const updated = await window.api.activity.plans.update(
        toUpdateTrackedPlanRequest(args),
      );
      if (!updated) {
        throw new Error('Plan not found.');
      }
    },
    // Turn-level thumbs up/down (CAN-1521). Both main-process handlers
    // resolve rather than reject — an unreachable cloud queues the rating in
    // the local outbox instead of failing the click.
    'turnFeedback.rate': async (args) => {
      const response = await window.api.rateTurnFeedback({
        clientUserMessageId: args.clientUserMessageId,
        // Required by the command contract, not defaulted: the main handler
        // rejects an empty `clientChatId`, so substituting `''` here would
        // turn a caller mistake into a silently discarded rating.
        clientChatId: args.clientChatId,
        rating: args.rating,
        ...(args.provider ? { provider: args.provider } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(args.eventType ? { eventType: args.eventType } : {}),
        ...(args.chatMode ? { chatMode: args.chatMode } : {}),
      });
      return response.feedbackId ? { feedbackId: response.feedbackId } : {};
    },
    'turnFeedback.clear': async (args) => {
      await window.api.clearTurnFeedback({
        clientUserMessageId: args.clientUserMessageId,
        ...(args.feedbackId ? { feedbackId: args.feedbackId } : {}),
      });
    },
    'account.installUpdateEmails.set': (args) =>
      window.api.saveInstallUpdateEmailPreference({ enabled: args.enabled }),
    // Main applies the update to the latest stored record inside the
    // serialized preferences write, so a Portal dismissal is never dropped.
    'onboardingTips.update': (update) =>
      window.api.updateOnboardingTips(update),
    'turnFeedback.detail': async (args) => {
      await window.api.submitTurnFeedbackDetail({
        clientUserMessageId: args.clientUserMessageId,
        ...(args.feedbackId ? { feedbackId: args.feedbackId } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
        ...(args.comment ? { comment: args.comment } : {}),
      });
    },
  };

  private readonly subscribeHandlers: SubscribeHandlers = {
    ...ipcTerminalSubscribeHandlers,
    'delegation.lifetimeChanged': (handler, filter) =>
      window.api.managedDelegation.onLifetimeChanged((event) => {
        if (
          (filter?.projectId !== undefined &&
            filter.projectId !== event.projectId) ||
          (filter?.worktreeId !== undefined &&
            filter.worktreeId !== event.worktreeId)
        ) {
          return;
        }
        handler({ ...event, occurredAt: new Date().toISOString() });
      }),
    'workspace-context.changed': (handler) =>
      window.api.workspaceContext.onChanged((broadcast) => {
        const { reason, ...state } = broadcast;
        handler({ occurredAt: new Date().toISOString(), state, reason });
      }),
    'org-projects.changed': (handler) =>
      window.api.orgProjects.onChanged((snapshot) => {
        const context = parseWorkspaceContext(snapshot.context);
        if (!context) return;
        this.orgProjectBroadcasts.set(snapshot.context, snapshot);
        try {
          handler({
            occurredAt: snapshot.fetchedAt,
            context,
            reason: 'catalog',
          });
        } finally {
          this.orgProjectBroadcasts.delete(snapshot.context);
        }
      }),
    'org-projects.setup-progress': (handler) =>
      window.api.orgProjects.onSetupProgress((progress) =>
        handler({ progress, occurredAt: progress.updatedAt }),
      ),
    'scriptActions.changed': (handler, filter) =>
      window.api.scriptActions.onChanged((context) => {
        if (
          (filter?.projectId !== undefined &&
            filter.projectId !== context.projectId) ||
          (filter?.worktreeId !== undefined &&
            filter.worktreeId !== context.worktreeId)
        )
          return;
        handler({ ...context, occurredAt: new Date().toISOString() });
      }),
    // The desktop app is the local host, so the link is always active: emit the
    // current status once and hand back a no-op unsubscribe. The filter is
    // intentionally ignored — connection status is global, not scoped.
    'connection.status': (handler) => {
      handler({ status: 'active', occurredAt: new Date().toISOString() });
      return noopUnsubscribe;
    },
    'session.snapshot-stale': (handler) =>
      window.api.onDesktopSessionSnapshotStale((): void => {
        handler({ occurredAt: new Date().toISOString() });
      }),
    'chat.message': (handler, filter) => {
      const turnSequenceByChat = new Map<string, number>();
      // Cursor streams patches against one assistant message per turn; fold
      // them per chat and drop the fold at the terminal event, since the
      // next turn's patches target fresh message ids.
      //
      // A turn that never reaches a terminal event (chat deleted mid-turn, a
      // hard failure path) retains its projector for the life of this
      // subscription — a real but narrow leak. This deliberately does NOT
      // cap the map with size-based (e.g. FIFO/LRU) eviction: unlike the
      // image cache in `lib/remote-image.ts`, an evicted entry here is not a
      // reusable cache miss — it is a currently-open chat's fold state. A
      // continuation patch after eviction can carry a full block (not just
      // `appendText`) at an in-range index against an empty `folded` map,
      // which `applyAssistantPatches` accepts and silently starts a fresh,
      // truncated message rather than rejecting it — so size-based eviction
      // trades a memory leak for silent transcript corruption on whichever
      // chat happens to occupy the oldest slot, active or not. No signal for
      // "this chat was deleted" or "this turn was aborted" reaches this
      // `onChatEvent` subscription today, so there is no lifecycle hook to
      // clear an orphaned entry correctly; adding one is out of this
      // change's scope. The map is still reset in full whenever this
      // subscription itself is torn down and re-created (e.g. store
      // dispose/re-activate), which bounds the leak to one subscription's
      // lifetime rather than the whole process.
      const cursorPatchesByChat = new Map<
        string,
        CursorAssistantPatchProjector
      >();
      return subscribeToChatEvents((event) => {
        const isCowork =
          event.worktreeId === COWORK_HOME_WORKTREE_ID ||
          isCoworkChatTarget(event.projectId);
        const scope =
          event.projectId === STANDALONE_CHAT_PROJECT_ID || isCowork
            ? 'standalone'
            : 'worktree';
        const workspaceLocalId =
          scope === 'worktree' || isCowork ? event.projectId : undefined;
        const worktreeLocalId = event.worktreeId;
        if (
          (filter?.projectId !== undefined &&
            filter.projectId !== event.projectId) ||
          (filter?.worktreeId !== undefined &&
            filter.worktreeId !== event.worktreeId) ||
          (filter?.workspaceLocalId !== undefined &&
            filter.workspaceLocalId !== workspaceLocalId) ||
          (filter?.worktreeLocalId !== undefined &&
            filter.worktreeLocalId !== worktreeLocalId) ||
          (filter?.chatLocalId !== undefined &&
            filter.chatLocalId !== event.chatId)
        ) {
          return;
        }

        const turnSequence = turnSequenceByChat.get(event.chatId) ?? 0;
        const chatKey = `${event.projectId}/${event.worktreeId}/${event.chatId}`;
        // Allocate a projector only for chats that actually stream Cursor
        // patches; every other provider's events never touch this map.
        let cursorPatches = cursorPatchesByChat.get(chatKey);
        if (!cursorPatches && isCursorAssistantPatchEvent(event.data)) {
          cursorPatches = createCursorAssistantPatchProjector({
            scope,
            workspaceLocalId,
            worktreeLocalId,
            chatId: event.chatId,
          });
          cursorPatchesByChat.set(chatKey, cursorPatches);
        }
        const message =
          cursorPatches?.apply(event.data) ??
          runtimeChatEventToPortalMessage({
            scope,
            workspaceLocalId,
            worktreeLocalId,
            chatId: event.chatId,
            data: event.data,
            fallbackMessageId: runtimeAssistantFallbackMessageId(
              event.chatId,
              event.data,
              turnSequence,
            ),
          });
        if (message) {
          const occurredAt = new Date().toISOString();
          handler({
            eventId: `${event.projectId}:${event.worktreeId}:${event.chatId}:${message.messageId}:${String(message.updatedAtMs ?? message.createdAtMs)}`,
            occurredAt,
            projectId: event.projectId,
            worktreeId: event.worktreeId,
            scope,
            workspaceLocalId,
            worktreeLocalId,
            chatId: event.chatId,
            message,
          });
        }
        if (isTerminalRuntimeChatEvent(event.data)) {
          turnSequenceByChat.set(event.chatId, turnSequence + 1);
          cursorPatchesByChat.delete(chatKey);
        }
      });
    },
  };

  query<K extends QueryName>(
    name: K,
    args: QueryMap[K]['args'],
  ): Promise<QueryMap[K]['result']> {
    return this.queryHandlers[name](args);
  }

  command<K extends CommandName>(
    name: K,
    args: CommandMap[K]['args'],
  ): Promise<CommandMap[K]['result']> {
    return this.commandHandlers[name](args);
  }

  subscribe<K extends DomainEventName>(
    name: K,
    handler: (event: DomainEventMap[K]) => void,
    filter?: SubscriptionFilter,
  ): Unsubscribe {
    return this.subscribeHandlers[name](handler, filter);
  }
}

/** Singleton desktop client injected into the renderer `CanopyClientProvider`. */
export const ipcCanopyClient: CanopyClient = new IpcCanopyClient();

// Hosted account and organization settings reach the settings client through
// this registration rather than importing this module (CAN-4386).
registerHostedSettingsCanopyClient(ipcCanopyClient);
