import {
  recordPostHogProviderConnection,
  recordPostHogShippingMilestone,
  readPostHogIdentityKey,
  recordPostHogInviteAcceptance,
  type PostHogShippingKind,
} from './anonymous-id';
import { randomUUID } from 'node:crypto';
import {
  subscribeProviderConnections,
  type ProviderConnectionEvent,
} from './provider-connection-events';
import { readFile } from 'node:fs/promises';
import {
  createDesktopInstrumentationOperationKey,
  type DesktopInstrumentationContext,
  type DesktopOperationName,
} from '@canopy/desktop-instrumentation';
import {
  COWORK_HOME_WORKTREE_ID,
  DEFAULT_CHAT_PROJECT_ID,
  type ChatProjectsFile,
  type PreferencesData,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import {
  isDesktopPostHogOperationCaptureEnabled,
  startDesktopOperation,
  succeedDesktopOperation,
  failDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import { validateAcquisitionContextValue } from '@canopy/desktop-instrumentation/acquisition-context';
import type {
  PairingTelemetryAttempt,
  PairingTelemetryContext,
} from '@canopy/desktop-instrumentation/pairing';
import { invitationReference } from './invitation-reference';
import type { ConfirmedProviderAuthEvent } from '../auth/provider-auth-state';
import type { ConfirmedCursorAccountEvent } from '../cursor/connection';
import { getChatProjectsFilePath } from './paths';
import { readSidebarItemsForTelemetry } from './sidebar-items';
import { loadHistoryIndex } from './standalone-history-index';
import {
  listWorkEntryIds,
  readWorkEntryChatCatalog,
} from './cowork-work-entries';
import {
  listAttachments,
  listNotes,
  listPrompts,
} from './standalone-workspace-files';

const ONBOARDING_PROFILE_OPERATION = 'canopy.onboarding_profile';
const WORKSPACE_CRUD_OPERATION = 'canopy.workspace_crud';
const WORKTREE_CRUD_OPERATION = 'canopy.worktree_crud';
const STANDALONE_PROJECT_CRUD_OPERATION = 'canopy.standalone_chat_project_crud';
const STANDALONE_FEATURE_OPERATION = 'canopy.standalone_chat_project_feature';
const ACTIVATION_CAMPAIGN_OPERATION = 'canopy.activation_campaign';
const PROVIDER_ACCOUNT_CONNECT_OPERATION = 'canopy.provider_account_connect';
const SKILL_SUGGESTION_OPERATION = 'canopy.skill_suggestion';
const TELEMETRY_TOTALS_CACHE_TTL_MS = 30_000;

type WorkspaceCrudAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'save'
  | 'convert'
  | 'promote';

type WorktreeCrudAction = 'create' | 'update' | 'archive' | 'delete' | 'repair';

type StandaloneProjectCrudAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'import'
  | 'export';

type StandaloneFeatureAction =
  | 'create_chat'
  | 'export_project'
  | 'resume_archive';

interface WorkspaceTotals {
  workspace_total: number;
  single_repo_workspace_total: number;
  multi_repo_workspace_total: number;
  temporary_workspace_total: number;
  worktree_total: number;
  workspace_worktree_total?: number;
  workspace_repo_total?: number;
  workspace_type?: 'single-repo' | 'multi-repo' | 'cowork' | 'unknown';
  workspace_is_temporary?: boolean;
}

interface StandaloneProjectTotals {
  standalone_project_total: number;
  standalone_chat_total: number;
  standalone_archived_chat_total: number;
  standalone_note_total: number;
  standalone_prompt_total: number;
  standalone_attachment_total: number;
  project_chat_total?: number;
  project_archived_chat_total?: number;
  project_note_total?: number;
  project_prompt_total?: number;
  project_attachment_total?: number;
}

interface StandaloneProjectCounts {
  chat_total: number;
  archived_chat_total: number;
  note_total: number;
  prompt_total: number;
  attachment_total: number;
}

interface CountedStandaloneProject {
  id: string;
  counts: StandaloneProjectCounts;
}

let workspaceItemsCache:
  | { expiresAt: number; promise: Promise<SidebarItem[]> }
  | undefined;
let standaloneProjectCountsCache:
  | { expiresAt: number; promise: Promise<CountedStandaloneProject[]> }
  | undefined;

function scheduleTelemetry(task: () => Promise<void>): void {
  const run = (): void => {
    void task().catch(() => {
      // Telemetry collection is best-effort and must never affect app behavior.
    });
  };

  setImmediate(run);
}

function emitTelemetryOperation(
  name: DesktopOperationName,
  seed: string,
  context: DesktopInstrumentationContext,
): void {
  try {
    const operationKey = createDesktopInstrumentationOperationKey(
      `${name}:${seed}:${Date.now()}`,
    );
    // Instrumentation exposes operation APIs rather than a counter/event API;
    // a finished product operation becomes one PostHog event.
    startDesktopOperation(name, { operationKey, context });
    succeedDesktopOperation(name, { operationKey, context });
  } catch {
    // Instrumentation must never affect the app path.
  }
}

async function readCachedSidebarItems(): Promise<SidebarItem[]> {
  const now = Date.now();
  if (workspaceItemsCache && workspaceItemsCache.expiresAt > now) {
    return workspaceItemsCache.promise;
  }

  const promise = readSidebarItemsForTelemetry().then(({ items }) => items);
  workspaceItemsCache = {
    expiresAt: now + TELEMETRY_TOTALS_CACHE_TTL_MS,
    promise,
  };
  promise.catch(() => {
    if (workspaceItemsCache?.promise === promise) {
      workspaceItemsCache = undefined;
    }
  });
  return promise;
}

function findWorkspace(
  items: SidebarItem[],
  workspaceId?: string,
): SidebarItem | undefined {
  return workspaceId
    ? items.find((item) => item.id === workspaceId)
    : undefined;
}

async function collectWorkspaceTotals(
  workspaceId?: string,
): Promise<WorkspaceTotals> {
  const items = await readCachedSidebarItems();
  const workspace = findWorkspace(items, workspaceId);
  const worktreeTotal = items.reduce(
    (total, item) =>
      total + (item.type === 'cowork' ? 0 : item.worktrees.length),
    0,
  );

  return {
    workspace_total: items.length,
    single_repo_workspace_total: items.filter(
      (item) => item.type === 'single-repo',
    ).length,
    multi_repo_workspace_total: items.filter(
      (item) => item.type === 'multi-repo',
    ).length,
    temporary_workspace_total: items.filter(
      (item) => item.type === 'multi-repo' && item.temporary === true,
    ).length,
    worktree_total: worktreeTotal,
    ...(workspace
      ? {
          workspace_worktree_total:
            workspace.type === 'cowork' ? 0 : workspace.worktrees.length,
          workspace_repo_total:
            workspace.type === 'multi-repo'
              ? workspace.repos.length
              : workspace.type === 'cowork'
                ? 0
                : 1,
          workspace_type: workspace.type,
          workspace_is_temporary:
            workspace.type === 'multi-repo' && workspace.temporary === true,
        }
      : workspaceId
        ? {
            workspace_worktree_total: 0,
            workspace_type: 'unknown' as const,
          }
        : {}),
  };
}

async function readStandaloneProjectIds(): Promise<string[]> {
  try {
    const raw = await readFile(getChatProjectsFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ChatProjectsFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.projects)) {
      return [DEFAULT_CHAT_PROJECT_ID];
    }

    const ids = new Set<string>([DEFAULT_CHAT_PROJECT_ID]);
    for (const project of parsed.projects) {
      if (project && typeof project.id === 'string' && project.id.trim()) {
        ids.add(project.id);
      }
    }
    return Array.from(ids);
  } catch {
    return [DEFAULT_CHAT_PROJECT_ID];
  }
}

async function collectStandaloneProjectCounts(
  projectId: string,
): Promise<StandaloneProjectCounts> {
  const [entryIds, legacyArchives, notes, prompts, attachments] =
    await Promise.all([
      listWorkEntryIds(projectId).catch(() => []),
      loadHistoryIndex(projectId).catch(() => []),
      listNotes(projectId).catch(() => []),
      listPrompts(projectId).catch(() => []),
      listAttachments(projectId).catch(() => []),
    ]);
  // Counts are catalog reads, not scope admission: the metadata-only
  // catalog never loads or migrates a Work Entry's chat scope, and entries
  // are read one at a time so a large workspace never spills every legacy
  // transcript to scratch at once.
  const chatIds = new Set<string>();
  const archiveIds = new Set(legacyArchives.map((archive) => archive.chatId));
  for (const entryId of [...entryIds, COWORK_HOME_WORKTREE_ID]) {
    const catalog = await readWorkEntryChatCatalog(projectId, entryId).catch(
      () => null,
    );
    for (const chatId of catalog?.liveChatIds ?? []) chatIds.add(chatId);
    for (const archive of catalog?.archives ?? []) {
      archiveIds.add(archive.chatId);
    }
  }

  return {
    chat_total: chatIds.size,
    archived_chat_total: archiveIds.size,
    note_total: notes.length,
    prompt_total: prompts.length,
    attachment_total: attachments.length,
  };
}

async function readCachedStandaloneProjectCounts(): Promise<
  CountedStandaloneProject[]
> {
  const now = Date.now();
  if (
    standaloneProjectCountsCache &&
    standaloneProjectCountsCache.expiresAt > now
  ) {
    return standaloneProjectCountsCache.promise;
  }

  const promise = readStandaloneProjectIds().then((projectIds) =>
    Promise.all(
      projectIds.map(async (id) => ({
        id,
        counts: await collectStandaloneProjectCounts(id),
      })),
    ),
  );
  standaloneProjectCountsCache = {
    expiresAt: now + TELEMETRY_TOTALS_CACHE_TTL_MS,
    promise,
  };
  promise.catch(() => {
    if (standaloneProjectCountsCache?.promise === promise) {
      standaloneProjectCountsCache = undefined;
    }
  });
  return promise;
}

async function collectStandaloneProjectTotals(
  projectId?: string,
): Promise<StandaloneProjectTotals> {
  const countedProjects = await readCachedStandaloneProjectCounts();
  const projectIds = countedProjects.map((entry) => entry.id);

  const selected = projectId
    ? countedProjects.find((entry) => entry.id === projectId)
    : undefined;

  return {
    standalone_project_total: projectIds.length,
    standalone_chat_total: countedProjects.reduce(
      (total, entry) => total + entry.counts.chat_total,
      0,
    ),
    standalone_archived_chat_total: countedProjects.reduce(
      (total, entry) => total + entry.counts.archived_chat_total,
      0,
    ),
    standalone_note_total: countedProjects.reduce(
      (total, entry) => total + entry.counts.note_total,
      0,
    ),
    standalone_prompt_total: countedProjects.reduce(
      (total, entry) => total + entry.counts.prompt_total,
      0,
    ),
    standalone_attachment_total: countedProjects.reduce(
      (total, entry) => total + entry.counts.attachment_total,
      0,
    ),
    ...(selected
      ? {
          project_chat_total: selected.counts.chat_total,
          project_archived_chat_total: selected.counts.archived_chat_total,
          project_note_total: selected.counts.note_total,
          project_prompt_total: selected.counts.prompt_total,
          project_attachment_total: selected.counts.attachment_total,
        }
      : projectId
        ? {
            project_chat_total: 0,
            project_archived_chat_total: 0,
            project_note_total: 0,
            project_prompt_total: 0,
            project_attachment_total: 0,
          }
        : {}),
  };
}

/**
 * Emit the onboarding profile answers (CAN-1009) when a preference save
 * changes them. Context carries only the bounded enum ids — the free-text
 * detail/intent preferences are user-authored content and must never reach
 * instrumentation (see docs/desktop-instrumentation.md privacy rules).
 */
export function recordOnboardingProfileTelemetry(options: {
  previous: Pick<PreferencesData, 'attributionSource' | 'profileRole'>;
  next: Pick<PreferencesData, 'attributionSource' | 'profileRole'>;
}): void {
  const attributionChanged =
    options.next.attributionSource !== undefined &&
    options.next.attributionSource !== options.previous.attributionSource;
  const roleChanged =
    options.next.profileRole !== undefined &&
    options.next.profileRole !== options.previous.profileRole;
  if (!attributionChanged && !roleChanged) {
    return;
  }
  const attributionSource = options.next.attributionSource;
  const profileRole = options.next.profileRole;
  scheduleTelemetry(() => {
    emitTelemetryOperation(
      ONBOARDING_PROFILE_OPERATION,
      `${attributionChanged ? attributionSource : ''}:${roleChanged ? profileRole : ''}`,
      {
        ...(attributionChanged && attributionSource !== undefined
          ? { attribution_source: attributionSource }
          : {}),
        ...(roleChanged && profileRole !== undefined
          ? { profile_role: profileRole }
          : {}),
      },
    );
    return Promise.resolve();
  });
}

/**
 * Emit an activation campaign outcome (CAN-1967). Context carries bounded
 * enum ids only — campaign id, outcome, suppression reason, destination page.
 * Notification copy is user-facing marketing text and must never reach
 * instrumentation (see docs/desktop-instrumentation.md privacy rules).
 */
export function recordActivationCampaignTelemetry(options: {
  campaignId: string;
  outcome: 'delivered' | 'suppressed' | 'clicked';
  reason?: string;
  destination?: string;
}): void {
  scheduleTelemetry(() => {
    emitTelemetryOperation(
      ACTIVATION_CAMPAIGN_OPERATION,
      `${options.campaignId}:${options.outcome}`,
      {
        campaign_id: options.campaignId,
        outcome: options.outcome,
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
        ...(options.destination !== undefined
          ? { destination: options.destination }
          : {}),
      },
    );
    return Promise.resolve();
  });
}

export interface GitShippingTelemetryInput {
  /** Internal workspace lookup only; never sent or used in operation keys. */
  projectId: string;
  source?: unknown;
  flow:
    | 'commit'
    | 'commit_and_push'
    | 'pull_request'
    | 'split_pr'
    | 'portal'
    | 'merge';
  repoCount: number;
}

/** Untrusted request attribution is metadata, never an authorization input. */
function normalizeGitShippingSource(
  source: unknown,
): 'manual' | 'chat' | 'pipeline' {
  return source === 'chat' || source === 'pipeline' ? source : 'manual';
}

function recordGitShippingTelemetry(
  kind: PostHogShippingKind,
  name: DesktopOperationName,
  options: GitShippingTelemetryInput,
): void {
  try {
    // Snapshot before scheduling; callers may continue with unrelated work.
    const { projectId, flow, repoCount } = options;
    const source = normalizeGitShippingSource(options.source);
    if (
      !Number.isSafeInteger(repoCount) ||
      repoCount <= 0 ||
      ![
        'commit',
        'commit_and_push',
        'pull_request',
        'split_pr',
        'portal',
        'merge',
      ].includes(flow)
    )
      return;
    scheduleTelemetry(async () => {
      if (!isDesktopPostHogOperationCaptureEnabled()) return;
      const totals = await collectWorkspaceTotals(projectId).catch(
        () => undefined,
      );
      const type = totals?.workspace_type;
      const workspaceType =
        type === 'single-repo' || type === 'multi-repo' || type === 'cowork'
          ? type
          : 'unknown';
      // Recheck after asynchronous lookup before consuming the durable claim.
      if (!isDesktopPostHogOperationCaptureEnabled()) return;
      const first = await recordPostHogShippingMilestone(kind).catch(
        () => undefined,
      );
      emitTelemetryOperation(name, randomUUID(), {
        source,
        workspace_type: workspaceType,
        flow,
        repo_count: repoCount,
        ...(first === undefined ? {} : { is_install_first: first }),
      });
    });
  } catch {
    // Scheduler and malformed input failures cannot change a git outcome.
  }
}

export function recordGitCommitTelemetry(
  options: GitShippingTelemetryInput,
): void {
  recordGitShippingTelemetry('commit', 'canopy.git_commit', options);
}

export function recordPullRequestOpenedTelemetry(
  options: GitShippingTelemetryInput,
): void {
  recordGitShippingTelemetry(
    'pull_request',
    'canopy.pull_request_open',
    options,
  );
}

export function recordPullRequestMergedTelemetry(
  options: GitShippingTelemetryInput,
): void {
  recordGitShippingTelemetry('merge', 'canopy.pull_request_merge', options);
}

/** A confirmed connection; startup observations only establish a baseline. */
export function recordProviderAccountConnectTelemetry(
  options: ProviderConnectionEvent,
): void {
  scheduleTelemetry(async () => {
    const { provider, connectionMethod, connectSource, failureReason } =
      options;
    if (failureReason) {
      emitTelemetryOperation('canopy.provider_account_connect_fail', provider, {
        provider,
        connection_method: connectionMethod,
        connect_source: connectSource,
        failure_reason: failureReason,
      });
      return;
    }
    const firstConnection = await recordPostHogProviderConnection(
      provider,
      connectSource === 'at_startup',
    ).catch(() => undefined);
    if (connectSource === 'at_startup') return;
    emitTelemetryOperation(
      PROVIDER_ACCOUNT_CONNECT_OPERATION,
      `${provider}:${connectSource}`,
      {
        provider,
        connect_source: connectSource,
        connection_method: connectionMethod,
        ...(firstConnection ?? {}),
      },
    );
  });
}

/**
 * Emit a repeat-task skill suggestion event (CAN-385) from main. Banner and
 * modal actions carry the occurrence count; a scan carries its outcome and
 * candidate count. Never prompts, titles, skill names or owners.
 */
export function recordSkillSuggestionTelemetry(
  options:
    | {
        action: 'shown' | 'dismissed' | 'accepted';
        occurrenceCount: number;
      }
    | { action: 'scan'; outcome: string; candidateCount: number },
): void {
  scheduleTelemetry(() => {
    emitTelemetryOperation(
      SKILL_SUGGESTION_OPERATION,
      options.action === 'scan' ? `scan:${options.outcome}` : options.action,
      options.action === 'scan'
        ? {
            action: 'scan',
            outcome: options.outcome,
            candidate_count: options.candidateCount,
          }
        : {
            action: options.action,
            occurrence_count: options.occurrenceCount,
          },
    );
    return Promise.resolve();
  });
}

/**
 * Records each confirmed sign-in from the provider auth and Cursor account
 * feeds. The subscribe functions are passed in to keep this module light;
 * the provider feed replays a sign-in confirmed before this subscribes.
 */
export function startProviderAccountConnectTelemetry(feeds: {
  subscribeProviderAuth: (
    listener: (event: ConfirmedProviderAuthEvent) => void,
  ) => () => void;
  subscribeCursorAccount: (
    listener: (event: ConfirmedCursorAccountEvent) => void,
  ) => () => void;
}): () => void {
  const unsubscribeProviderAuth = feeds.subscribeProviderAuth((event) => {
    recordProviderAccountConnectTelemetry({
      provider: event.provider,
      connectSource: event.connectSource,
      connectionMethod:
        event.status.accountKind === 'api_key' ? 'api_key' : 'native_login',
    });
  });
  const unsubscribeCursorAccount = feeds.subscribeCursorAccount((event) => {
    recordProviderAccountConnectTelemetry({
      provider: 'cursor',
      connectSource: event.connectSource,
      connectionMethod: 'native_login',
    });
  });
  const unsubscribeConnections = subscribeProviderConnections(
    recordProviderAccountConnectTelemetry,
  );
  return (): void => {
    unsubscribeConnections();
    unsubscribeProviderAuth();
    unsubscribeCursorAccount();
  };
}

export function recordWorkspaceCrudTelemetry(options: {
  action: WorkspaceCrudAction;
  workspaceId?: string;
  source?: string;
}): void {
  scheduleTelemetry(async () => {
    emitTelemetryOperation(
      WORKSPACE_CRUD_OPERATION,
      `${options.action}:${options.workspaceId ?? 'all'}:${options.source ?? ''}`,
      {
        action: options.action,
        ...(options.source ? { source: options.source } : {}),
        ...(await collectWorkspaceTotals(options.workspaceId)),
      },
    );
  });
}

export function recordWorktreeCrudTelemetry(options: {
  action: WorktreeCrudAction;
  workspaceId: string;
  source?: string;
}): void {
  scheduleTelemetry(async () => {
    emitTelemetryOperation(
      WORKTREE_CRUD_OPERATION,
      `${options.action}:${options.workspaceId}:${options.source ?? ''}`,
      {
        action: options.action,
        ...(options.source ? { source: options.source } : {}),
        ...(await collectWorkspaceTotals(options.workspaceId)),
      },
    );
  });
}

export function recordStandaloneProjectCrudTelemetry(options: {
  action: StandaloneProjectCrudAction;
  projectId?: string;
  chatDisposition?: string;
}): void {
  scheduleTelemetry(async () => {
    emitTelemetryOperation(
      STANDALONE_PROJECT_CRUD_OPERATION,
      `${options.action}:${options.projectId ?? 'all'}:${options.chatDisposition ?? ''}`,
      {
        action: options.action,
        ...(options.chatDisposition
          ? { chat_disposition: options.chatDisposition }
          : {}),
        ...(await collectStandaloneProjectTotals(options.projectId)),
      },
    );
  });
}

export function recordStandaloneFeatureTelemetry(options: {
  action: StandaloneFeatureAction;
  projectId: string;
  itemKind?: 'chat' | 'project';
  itemCount?: number;
  wasUpdate?: boolean;
}): void {
  scheduleTelemetry(async () => {
    emitTelemetryOperation(
      STANDALONE_FEATURE_OPERATION,
      `${options.action}:${options.projectId}:${options.itemKind ?? ''}`,
      {
        action: options.action,
        ...(options.itemKind ? { item_kind: options.itemKind } : {}),
        ...(typeof options.itemCount === 'number'
          ? { item_count: options.itemCount }
          : {}),
        ...(typeof options.wasUpdate === 'boolean'
          ? { was_update: options.wasUpdate }
          : {}),
        ...(await collectStandaloneProjectTotals(options.projectId)),
      },
    );
  });
}

export type InviteSendTelemetryInput =
  | {
      inviteType: 'organization';
      inviteId: string;
      recipientKind: 'email';
      sendSurface: 'invite_dialog' | 'members_tab';
      delivery?:
        | 'sent'
        | 'resent'
        | 'deferred-for-payment'
        | 'email-suppressed';
    }
  | {
      inviteType: 'teammate_share';
      /** Container identity; acceptance is per container, not per grant. */
      inviteId: string;
      grantId: string;
      recipientKind: 'member' | 'email';
      sendSurface: 'share_dialog';
      shareAudience: 'team' | 'organization' | 'public';
      containerType: 'WORKTREE' | 'COWORK' | 'CLOUD_CHAT';
    };

function validAcquisitionContext(
  name: DesktopOperationName,
  context: DesktopInstrumentationContext,
): boolean {
  return Object.entries(context).every(([key, value]) =>
    validateAcquisitionContextValue(name, key, value),
  );
}

function scheduleAcquisitionTask(task: () => void): void {
  scheduleTelemetry(() => Promise.resolve().then(task));
}

function scheduleAcquisitionOperation(
  name: DesktopOperationName,
  context: DesktopInstrumentationContext,
): void {
  if (
    !isDesktopPostHogOperationCaptureEnabled() ||
    !validAcquisitionContext(name, context)
  )
    return;
  scheduleAcquisitionTask(() => {
    if (!isDesktopPostHogOperationCaptureEnabled()) return;
    emitTelemetryOperation(name, randomUUID(), context);
  });
}

export function recordInviteSendTelemetry(
  input: InviteSendTelemetryInput,
): void {
  try {
    if (!isDesktopPostHogOperationCaptureEnabled()) return;
    const context: DesktopInstrumentationContext = {
      invite_type: input.inviteType,
      invite_ref: invitationReference(input.inviteType, input.inviteId),
      recipient_kind: input.recipientKind,
      send_surface: input.sendSurface,
      ...(input.inviteType === 'organization'
        ? input.delivery === undefined
          ? {}
          : { delivery: input.delivery }
        : {
            grant_ref: invitationReference(
              'teammate_share_grant',
              input.grantId,
            ),
            share_audience: input.shareAudience,
            container_type: input.containerType,
          }),
    };
    scheduleAcquisitionOperation('canopy.invite_send', context);
  } catch {
    /* Telemetry never changes a confirmed invitation. */
  }
}

export interface InviteAcceptTelemetryInput {
  inviteType: 'organization' | 'teammate_share';
  inviteId: string;
  acceptSurface: 'desktop_switcher' | 'desktop_share_accept';
  containerType?: 'WORKTREE' | 'COWORK' | 'CLOUD_CHAT';
}

let inviteAcceptanceOrder: Promise<void> = Promise.resolve();

export function recordInviteAcceptTelemetry(
  input: InviteAcceptTelemetryInput,
): void {
  try {
    if (!isDesktopPostHogOperationCaptureEnabled()) return;
    const context: DesktopInstrumentationContext = {
      invite_type: input.inviteType,
      invite_ref: invitationReference(input.inviteType, input.inviteId),
      accept_surface: input.acceptSurface,
      ...(input.inviteType === 'teammate_share' &&
      input.containerType !== undefined
        ? { container_type: input.containerType }
        : {}),
    };
    if (!validAcquisitionContext('canopy.invite_accept', context)) return;
    // Begin a read now, never identity creation. Fence deferred work against reset.
    const observedIdentity = readPostHogIdentityKey().catch(() => undefined);
    const observedAt = Date.now();
    scheduleTelemetry(async () => {
      const record = async (): Promise<void> => {
        if (!isDesktopPostHogOperationCaptureEnabled()) return;
        const key = await observedIdentity;
        if (key !== undefined && (await readPostHogIdentityKey()) !== key)
          return;
        if (!isDesktopPostHogOperationCaptureEnabled()) return;
        const milestone =
          key === undefined
            ? undefined
            : await recordPostHogInviteAcceptance(
                key,
                observedAt,
                isDesktopPostHogOperationCaptureEnabled,
              ).catch(() => undefined);
        if (!isDesktopPostHogOperationCaptureEnabled()) return;
        if (key !== undefined && (await readPostHogIdentityKey()) !== key)
          return;
        emitTelemetryOperation('canopy.invite_accept', randomUUID(), {
          ...context,
          ...milestone,
        });
      };
      const next = inviteAcceptanceOrder.then(record, record);
      inviteAcceptanceOrder = next.catch(() => undefined);
      await next;
    });
  } catch {
    /* Metadata, hashing and scheduling are all best effort. */
  }
}

export function recordOrganizationCreateTelemetry(input: {
  creationMethod: 'create' | 'promote_personal';
  inviteIncluded: boolean;
  projectCount: number;
}): void {
  try {
    scheduleAcquisitionOperation('canopy.organization_create', {
      creation_method: input.creationMethod,
      invite_included: input.inviteIncluded,
      project_count: input.projectCount,
    });
  } catch {
    /* Preserve the authoritative creation result. */
  }
}

export function startRemotePairingTelemetry(
  input: PairingTelemetryContext,
): PairingTelemetryAttempt | undefined {
  try {
    if (!isDesktopPostHogOperationCaptureEnabled()) return undefined;
    const context: DesktopInstrumentationContext = {
      pairing_kind: input.pairing_kind,
      pairing_entry: input.pairing_entry,
      peer_platform: input.peer_platform,
      ...(input.pairing_kind === 'phone_code' &&
      input.is_additional_device !== undefined
        ? { is_additional_device: input.is_additional_device }
        : {}),
    };
    if (!validAcquisitionContext('canopy.remote_pairing', context))
      return undefined;
    const operationKey = createDesktopInstrumentationOperationKey(randomUUID());
    let started = false;
    let ended = false;
    scheduleAcquisitionTask(() => {
      if (!isDesktopPostHogOperationCaptureEnabled()) return;
      startDesktopOperation('canopy.remote_pairing', { operationKey, context });
      started = true;
      emitTelemetryOperation(
        'canopy.remote_pairing_start',
        randomUUID(),
        context,
      );
    });
    return {
      end: (outcome): void => {
        if (ended) return;
        ended = true;
        try {
          if (
            !validateAcquisitionContextValue(
              'canopy.remote_pairing',
              'outcome',
              outcome,
            )
          )
            return;
          scheduleAcquisitionTask(() => {
            if (!started || !isDesktopPostHogOperationCaptureEnabled()) return;
            started = false;
            const options = { operationKey, context: { ...context, outcome } };
            if (outcome === 'approved')
              succeedDesktopOperation('canopy.remote_pairing', options);
            else
              failDesktopOperation(
                'canopy.remote_pairing',
                outcome === 'failed'
                  ? 'error'
                  : outcome === 'rejected' || outcome === 'declined'
                    ? 'other'
                    : 'abandoned',
                options,
              );
          });
        } catch {
          /* First terminal transition still wins when capture fails. */
        }
      },
    };
  } catch {
    return undefined;
  }
}
