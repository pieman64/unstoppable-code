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
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import type {
  ConfirmedProviderAuthEvent,
  ProviderAccountConnectSource,
} from '../auth/provider-auth-state';
import type { ConfirmedCursorAccountEvent } from '../cursor/connection';
import { getChatProjectsFilePath } from './paths';
import { readAllSidebarItems } from './sidebar-items';
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
    // Datadog exposes operation APIs rather than a counter/event API here.
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

  const promise = readAllSidebarItems().then(({ items }) => items);
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
  /**
   * Checklist item id for Getting Started sequence events (CAN-3013), so
   * delivery rate and click-through can be measured per step. A bounded enum
   * id like every other attribute here -- never notification copy.
   */
  itemId?: string;
  outcome: 'delivered' | 'suppressed' | 'clicked';
  reason?: string;
  destination?: string;
}): void {
  scheduleTelemetry(() => {
    emitTelemetryOperation(
      ACTIVATION_CAMPAIGN_OPERATION,
      [options.campaignId, options.itemId, options.outcome]
        .filter((part): part is string => part !== undefined)
        .join(':'),
      {
        campaign_id: options.campaignId,
        ...(options.itemId !== undefined ? { item_id: options.itemId } : {}),
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

/**
 * Emit a confirmed Claude, Codex, or Cursor sign-in (CAN-4015). Context carries
 * only the provider and how the sign-in came about; the account's email,
 * label, plan, and org must never reach instrumentation.
 */
export function recordProviderAccountConnectTelemetry(options: {
  provider: 'claude' | 'codex' | 'cursor';
  connectSource: ProviderAccountConnectSource;
}): void {
  const { provider, connectSource } = options;
  scheduleTelemetry(() => {
    emitTelemetryOperation(
      PROVIDER_ACCOUNT_CONNECT_OPERATION,
      `${provider}:${connectSource}`,
      { provider, connect_source: connectSource },
    );
    return Promise.resolve();
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
    });
  });
  const unsubscribeCursorAccount = feeds.subscribeCursorAccount((event) => {
    recordProviderAccountConnectTelemetry({
      provider: 'cursor',
      connectSource: event.connectSource,
    });
  });
  return (): void => {
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
