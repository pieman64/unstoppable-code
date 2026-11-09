import type { ModelHarness } from '@canopy/execution-engine/types/model-harnesses';
import type {
  AgentProviderType,
  ProjectOwnerContext,
  SharedRunMetadata,
  WorktreeData,
  WorktreeHealthIssue,
} from '../types';
import {
  firstIssueMessage,
  PROJECT_DISCOVERY_TYPES as PROJECT_DISCOVERY_ACTION_TYPES,
  projectDiscoveryActionSchema,
  type ProjectDiscoveryAction,
} from '@canopy/agent-actions/families/projects/actions';

// The schemas moved to the shared projects action family.
export {
  PROJECT_DISCOVERY_TYPES as PROJECT_DISCOVERY_ACTION_TYPES,
  PROJECT_DISCOVERY_CURSOR_MAX,
  PROJECT_DISCOVERY_ID_MAX,
  PROJECT_DISCOVERY_PAGE_SIZE_DEFAULT,
  PROJECT_DISCOVERY_PAGE_SIZE_MAX,
  PROJECT_DISCOVERY_PREVIEW_MAX_CHARS,
  PROJECT_DISCOVERY_TEXT_MAX,
  projectDiscoveryActionSchema,
  projectsListActionSchema,
  projectsListTaskChatsActionSchema,
  projectsListTasksActionSchema,
  type ProjectDiscoveryAction,
  type ProjectsListAction,
  type ProjectsListTaskChatsAction,
  type ProjectsListTasksAction,
} from '@canopy/agent-actions/families/projects/actions';

export type ProjectType = 'code' | 'cowork';
export type TaskKind = 'worktree' | 'work_entry';
export type TaskStatus = 'active' | 'done';
export type RetentionState = 'retained' | 'archived';
export type RuntimeState =
  | 'idle'
  | 'running'
  | 'queued'
  | 'interrupted'
  | 'error'
  | 'unknown';

export type PageResult<T> = {
  items: T[];
  returned: number;
  totalMatches: number;
  nextCursor: string | null;
  generatedAt: string;
  revision: string;
};

export type ProjectChatAddress = {
  projectId: string;
  taskId: string;
  chatId: string;
};

export type CodeProjectDetails = {
  kind: 'code';
  codeKind: 'single-repo' | 'multi-repo';
  temporary: boolean;
  sourceControlledConfigAvailable: boolean;
  repoCount: number;
  repos: {
    repoId: string;
    name: string;
    source: string;
    manifestUrl?: string;
  }[];
  alwaysShow: boolean;
  hasDefaultPluginSelections: boolean;
};

export type CoworkProjectDetails = {
  kind: 'cowork';
  defaultModel?: string;
  defaultPresetId?: string;
  presetCount: number;
  hasDefaultPluginSelections: boolean;
  archiveRetentionDays?: number;
};

type ProjectRowMetadata = {
  projectId: string;
  purpose: 'project' | 'chats';
  name: string;
  displayName: string;
  description?: string;
  createdAt?: string;
  lastActivityAt?: string;
  color?: string;
  isDefault: boolean;
  readiness: 'ready' | 'pending' | 'unavailable';
  owner: ProjectOwnerContext;
  countsAvailable: boolean;
  taskCount: number | null;
  activeTaskCount: number | null;
  doneTaskCount: number | null;
};

export type ProjectRow = ProjectRowMetadata &
  (
    | { type: 'code'; details: CodeProjectDetails }
    | { type: 'cowork'; details: CoworkProjectDetails }
  );

export type WorktreeTaskDetails = {
  kind: 'worktree';
  branchName: string;
  hidden: boolean;
  setupPhase: NonNullable<WorktreeData['setupPhase']>;
  pausedHookKeys: string[];
  trackedBaseBranch: string | null;
  trackedRepoBaseBranches: Record<string, string>;
  healthIssue: Pick<
    WorktreeHealthIssue,
    'code' | 'message' | 'checkedAt'
  > | null;
};

/**
 * Resource-policy-authorized projection only: keeps the run ID, canonical
 * share scope, share timestamp, and comment counters. Excludes team/org display
 * identities, collaborator identities, tokens, and host paths. The service
 * must authorize the run before projecting these fields.
 */
export type AuthorizedSharedRunSummary = Pick<
  SharedRunMetadata,
  | 'externalId'
  | 'shareScope'
  | 'sharedAt'
  | 'commentRevision'
  | 'unreadCommentCount'
>;

export type WorkEntryTaskDetails = {
  kind: 'work_entry';
  pinned: boolean;
  hasUserChanges: boolean;
  titleOverride: string | null;
  lastTouchedAt?: string;
  lastMessageAt?: string;
  providerType?: AgentProviderType;
  sharedRun?: AuthorizedSharedRunSummary;
};

type ProjectTaskRowMetadata = {
  projectId: string;
  taskId: string;
  title: string;
  status: TaskStatus;
  retentionState: RetentionState;
  createdAt: string;
  lastActivityAt?: string;
  chatCount: number;
  hasRunningChats: boolean | null;
};

export type ProjectTaskRow = ProjectTaskRowMetadata &
  (
    | { kind: 'worktree'; details: WorktreeTaskDetails }
    | { kind: 'work_entry'; details: WorkEntryTaskDetails }
  );

export type ChatSessionSummary = {
  state: 'expired' | 'active' | 'error' | 'idle';
  expired: boolean;
  readOnly: boolean;
  canHandOff: boolean;
  undeliveredMessagePresent: boolean;
  undeliveredMessageLength: number;
  undeliveredFileReferenceCount: number;
  undeliveredInputMode?: 'typed' | 'voice';
};

export type ChatMetadata = {
  title: string;
  description?: string;
  createdAt?: string;
  lastActivityAt?: string;
  messageCount?: number;
  retentionState: RetentionState;
  archivedAt?: string;
  runtimeState: RuntimeState;
  runtimeObservedAt: string;
  queuedMessageCount: number | null;
  providerType?: AgentProviderType;
  executionHarness?: ModelHarness;
  model?: string;
  hasPluginSelections?: boolean;
  session?: ChatSessionSummary;
  capabilities: {
    canRead: boolean;
    canSend: boolean;
    canWatch: boolean;
    canSteerQueuedMessage: boolean;
    unavailableReason?: string;
  };
  lastUserMessage?: {
    messageId: string;
    timestamp?: string;
    text: string;
    truncated: boolean;
  };
};

export type ProjectChatRow = ProjectChatAddress & ChatMetadata;
export type ProjectsListResult = PageResult<ProjectRow>;
export type ProjectsListTasksResult = PageResult<ProjectTaskRow> & {
  projectId: string;
  projectType: ProjectType;
};
export type ProjectsListTaskChatsResult = PageResult<ProjectChatRow> & {
  projectId: string;
  taskId?: string;
};

/** The service calls this after resolving and authorizing the project type. */
export function incompatibleTaskFilter(
  input: { pinned?: boolean; branchName?: string },
  projectType: ProjectType,
): string | null {
  if (projectType === 'code' && input.pinned !== undefined) {
    return 'pinned is only supported for work_entry tasks in cowork projects.';
  }
  if (projectType === 'cowork' && input.branchName !== undefined) {
    return 'branchName is only supported for worktree tasks in code projects.';
  }
  return null;
}

export function parseProjectDiscoveryAction(
  value: unknown,
):
  | { ok: true; action: ProjectDiscoveryAction }
  | { ok: false; message: string } {
  const parsed = projectDiscoveryActionSchema.safeParse(value);
  if (parsed.success) return { ok: true, action: parsed.data };
  return {
    ok: false,
    message: firstIssueMessage(
      parsed.error,
      'Invalid project discovery action',
    ),
  };
}

export function isProjectDiscoveryActionType(
  type: string,
): type is ProjectDiscoveryAction['type'] {
  return PROJECT_DISCOVERY_ACTION_TYPES.some(
    (actionType) => actionType === type,
  );
}
