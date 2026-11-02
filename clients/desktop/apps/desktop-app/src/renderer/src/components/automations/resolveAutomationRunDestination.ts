/**
 * Resolve — and open — the thing an automation run actually produced
 * (ECW-8684). `AutomationRunResult` has carried the ids of the dispatched
 * chat turn / pipeline execution since the scheduler was written, with no
 * renderer consumer; this module is that consumer.
 *
 * Two halves on purpose:
 *  - {@link resolveAutomationRunDestination} is pure. It maps a run to a
 *    discriminated destination (or an explained `none`), so a row can decide
 *    whether to render a link at all without touching a store.
 *  - {@link openAutomationRunDestination} performs the navigation, checking
 *    that the target still exists before moving the user rather than
 *    navigating optimistically.
 */
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  type ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import { brandText } from '@/lib/brand';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { openPipelineExecutionPanel } from '@/lib/panels/open-pipeline-execution';

export type AutomationRunDestination =
  | {
      kind: 'app-advisor-chat';
      chatId: string;
      delegationId?: string;
      userMessageId?: string;
    }
  | {
      kind: 'cowork-chat';
      workspaceId: string;
      chatId: string;
      userMessageId?: string;
    }
  | {
      kind: 'worktree-chat';
      projectId: string;
      worktreeId: string;
      chatId: string;
      userMessageId?: string;
    }
  | {
      kind: 'pipeline-execution';
      executionId: string;
      projectId?: string;
      worktreeId?: string;
      /** The job to open at, instead of the run's summary. */
      jobId?: string;
    }
  | { kind: 'none'; reason: string };

export type OpenAutomationRunDestinationResult =
  | { ok: true }
  | { ok: false; error: string };

/** Short label for the affordance that opens a resolved destination. */
export function automationRunDestinationLabel(
  destination: AutomationRunDestination,
): string {
  switch (destination.kind) {
    case 'app-advisor-chat':
      return `Open in ${ORCHESTRATOR_LABEL}`;
    case 'cowork-chat':
    case 'worktree-chat':
      return 'Open chat';
    case 'pipeline-execution':
      return 'Open run';
    case 'none':
      return '';
  }
}

function noneReasonForRun(run: ScheduledActivityRun): string {
  switch (run.status) {
    case 'running':
      return 'Still running.';
    case 'missed':
      return `Missed while ${brandText.appName} was closed.`;
    case 'canceled':
      return 'Canceled before it started.';
    case 'skipped':
      return 'Skipped, so nothing was started.';
    case 'failure':
      return 'Failed before it started anything.';
    case 'success':
      return 'Nothing to open for this run.';
  }
}

/**
 * Pure mapping from a persisted run to what it produced. Result fields are
 * checked in the order the scheduler populates them: an App Advisor chat and a
 * cowork chat are distinguishable only by which id the action set.
 */
export function resolveAutomationRunDestination(
  run: ScheduledActivityRun,
): AutomationRunDestination {
  const result = run.result;
  if (!result) {
    return { kind: 'none', reason: noneReasonForRun(run) };
  }

  if (result.appAdvisorChatId) {
    return {
      kind: 'app-advisor-chat',
      chatId: result.appAdvisorChatId,
      ...(result.userMessageId ? { userMessageId: result.userMessageId } : {}),
    };
  }

  if (result.standaloneChatId) {
    const workspaceId = result.projectId ?? run.target?.workspaceId;
    if (!workspaceId) {
      return { kind: 'none', reason: 'Nothing to open for this run.' };
    }
    return {
      kind: 'cowork-chat',
      workspaceId,
      chatId: result.standaloneChatId,
      ...(result.userMessageId ? { userMessageId: result.userMessageId } : {}),
    };
  }

  if (result.chatId) {
    const projectId = result.projectId ?? run.target?.workspaceId;
    const worktreeId = result.worktreeId ?? run.target?.worktreeId;
    if (projectId === APP_ADVISOR_PROJECT_ID) {
      return {
        kind: 'app-advisor-chat',
        chatId: result.chatId,
        ...(result.userMessageId
          ? { userMessageId: result.userMessageId }
          : {}),
      };
    }
    if (!projectId || !worktreeId) {
      return { kind: 'none', reason: 'Nothing to open for this run.' };
    }
    return {
      kind: 'worktree-chat',
      projectId,
      worktreeId,
      chatId: result.chatId,
      ...(result.userMessageId ? { userMessageId: result.userMessageId } : {}),
    };
  }

  if (result.pipelineExecutionId) {
    const projectId = result.projectId;
    const worktreeId = result.worktreeId;
    return {
      kind: 'pipeline-execution',
      executionId: result.pipelineExecutionId,
      ...(projectId ? { projectId } : {}),
      ...(worktreeId ? { worktreeId } : {}),
    };
  }

  return { kind: 'none', reason: noneReasonForRun(run) };
}

const CHAT_UNAVAILABLE_REASON = 'That chat is no longer available.';
const PIPELINE_UNAVAILABLE_REASON =
  'That workflow execution is no longer available.';
const APP_ADVISOR_PREFLIGHT_ATTEMPTS = 5;
const APP_ADVISOR_PREFLIGHT_RETRY_MS = 250;

function waitForAppAdvisorChatMaterialization(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, APP_ADVISOR_PREFLIGHT_RETRY_MS);
  });
}

function worktreeExists(projectId: string, worktreeId: string): boolean {
  return useProjectsStore
    .getState()
    .projects.some(
      (project) =>
        project.id === projectId &&
        project.type !== 'cowork' &&
        project.worktrees.some((worktree) => worktree.id === worktreeId),
    );
}

async function pipelineExecutionExists(executionId: string): Promise<boolean> {
  try {
    return (
      (await usePipelineRunsStore
        .getState()
        .loadExecutionDetails(executionId)) !== null
    );
  } catch {
    return false;
  }
}

/**
 * Re-point a `worktree-chat` destination at the cowork arm when its project id
 * is actually a cowork workspace.
 *
 * `worktree_session_prompt` is the one wire type both workspace kinds share:
 * for cowork, the Work Entry id occupies the `worktreeId` slot (CLAUDE.md ->
 * "Cowork workspaces"). Its run result is therefore an undifferentiated
 * `{ projectId, worktreeId, chatId }` triple, which the pure mapper above can
 * only read as a worktree chat. Cowork workspaces have no worktrees, so
 * leaving it there makes `worktreeExists` / `openWorktreeChat` fail closed on
 * every cowork existing-chat run. The store read lives here rather than in the
 * pure mapper so that function stays store-free.
 */
function normalizeCoworkChatDestination(
  destination: AutomationRunDestination,
): AutomationRunDestination {
  if (destination.kind !== 'worktree-chat') return destination;
  const isCowork = useProjectsStore
    .getState()
    .projects.some(
      (project) =>
        project.id === destination.projectId && project.type === 'cowork',
    );
  if (!isCowork) return destination;
  return {
    kind: 'cowork-chat',
    workspaceId: destination.projectId,
    chatId: destination.chatId,
    ...(destination.userMessageId
      ? { userMessageId: destination.userMessageId }
      : {}),
  };
}

/**
 * Resolve whether a persisted destination still exists without navigating.
 * History rows use this before rendering their open affordance so deleted
 * chats and removed worktrees are explanatory text, not dead buttons.
 */
export async function resolveAvailableAutomationRunDestination(
  rawDestination: AutomationRunDestination,
): Promise<AutomationRunDestination> {
  const destination = normalizeCoworkChatDestination(rawDestination);
  switch (destination.kind) {
    case 'none':
      return destination;
    case 'worktree-chat': {
      if (!worktreeExists(destination.projectId, destination.worktreeId)) {
        return { kind: 'none', reason: CHAT_UNAVAILABLE_REASON };
      }
      try {
        const tabs = await window.api.chat.loadTabs({
          projectId: destination.projectId,
          worktreeId: destination.worktreeId,
        });
        return tabs.tabs.some((tab) => tab.id === destination.chatId)
          ? destination
          : { kind: 'none', reason: CHAT_UNAVAILABLE_REASON };
      } catch {
        return { kind: 'none', reason: CHAT_UNAVAILABLE_REASON };
      }
    }
    case 'cowork-chat': {
      const workspaceExists = useProjectsStore
        .getState()
        .projects.some(
          (project) =>
            project.id === destination.workspaceId && project.type === 'cowork',
        );
      if (!workspaceExists) {
        return { kind: 'none', reason: CHAT_UNAVAILABLE_REASON };
      }
      try {
        const resolved = await window.api.workEntries.resolveChat({
          projectId: destination.workspaceId,
          chatId: destination.chatId,
        });
        if (resolved.entryId !== null || resolved.archivedInEntryId !== null) {
          return destination;
        }
        const legacy = await window.api.standaloneChat.list(
          destination.workspaceId,
        );
        return legacy.chats.some((chat) => chat.id === destination.chatId)
          ? destination
          : { kind: 'none', reason: CHAT_UNAVAILABLE_REASON };
      } catch {
        return { kind: 'none', reason: CHAT_UNAVAILABLE_REASON };
      }
    }
    case 'app-advisor-chat': {
      // A quick-prompt run is persisted as successful after the Work Entry is
      // created but before the App Advisor renderer necessarily writes its
      // first chat tab. Keep the row in its checking state through that short
      // materialization window instead of permanently caching a transient miss.
      for (
        let attempt = 0;
        attempt < APP_ADVISOR_PREFLIGHT_ATTEMPTS;
        attempt += 1
      ) {
        try {
          const resolved = await window.api.workEntries.resolveChat({
            projectId: APP_ADVISOR_PROJECT_ID,
            chatId: destination.chatId,
          });
          if (
            resolved.entryId !== null ||
            resolved.archivedInEntryId !== null
          ) {
            return destination;
          }
          const legacy = await window.api.chat.loadArchives({
            projectId: APP_ADVISOR_PROJECT_ID,
            worktreeId: APP_ADVISOR_WORKTREE_ID,
          });
          if (legacy.some((chat) => chat.chatId === destination.chatId)) {
            return destination;
          }
        } catch {
          // A concurrent first write can briefly make either read unavailable.
        }
        if (attempt + 1 < APP_ADVISOR_PREFLIGHT_ATTEMPTS) {
          await waitForAppAdvisorChatMaterialization();
        }
      }
      return { kind: 'none', reason: CHAT_UNAVAILABLE_REASON };
    }
    case 'pipeline-execution': {
      const project = destination.projectId
        ? useProjectsStore
            .getState()
            .projects.find(
              (candidate) => candidate.id === destination.projectId,
            )
        : undefined;
      // A Cowork Work Entry fills the worktree slot and is not listed in the
      // projects store; opening the run verifies it.
      if (
        destination.projectId &&
        (!project ||
          (project.type !== 'cowork' &&
            destination.worktreeId &&
            !worktreeExists(destination.projectId, destination.worktreeId)))
      ) {
        return { kind: 'none', reason: PIPELINE_UNAVAILABLE_REASON };
      }
      return (await pipelineExecutionExists(destination.executionId))
        ? destination
        : { kind: 'none', reason: PIPELINE_UNAVAILABLE_REASON };
    }
  }
}

async function openWorktreeChat(
  destination: Extract<AutomationRunDestination, { kind: 'worktree-chat' }>,
): Promise<OpenAutomationRunDestinationResult> {
  const { projectId, worktreeId, chatId, userMessageId } = destination;
  const projects = useProjectsStore.getState().projects;
  const exists = projects.some(
    (project) =>
      project.id === projectId &&
      project.type !== 'cowork' &&
      project.worktrees.some((worktree) => worktree.id === worktreeId),
  );
  if (!exists) {
    return { ok: false, error: CHAT_UNAVAILABLE_REASON };
  }

  const chatStore = useChatStore.getState();
  try {
    await chatStore.loadTabsForTarget(projectId, worktreeId);
  } catch {
    return { ok: false, error: CHAT_UNAVAILABLE_REASON };
  }
  const key = `${projectId}/${worktreeId}`;
  const hydrated = useChatStore.getState().worktreeChats[key];
  if (!hydrated?.tabs.some((tab) => tab.id === chatId)) {
    return { ok: false, error: CHAT_UNAVAILABLE_REASON };
  }
  useChatStore.getState().switchTab(chatId, { projectId, worktreeId });
  const settled = useChatStore.getState().worktreeChats[key];
  if (
    settled?.activeTabId !== chatId ||
    !settled.tabs.some((tab) => tab.id === chatId)
  ) {
    return { ok: false, error: CHAT_UNAVAILABLE_REASON };
  }
  // Activity opens individual chats. Select the validated tab first so entering
  // its worktree cannot acknowledge a different, previously active chat.
  useNavigationStore.getState().navigate('main');
  useChatStore.getState().selectWorktree(projectId, worktreeId);
  if (userMessageId) {
    useNavigationStore.getState().openChatTurn({
      projectId,
      worktreeId,
      chatId,
      userMessageId,
    });
  }
  return { ok: true };
}

async function openCoworkChat(
  destination: Extract<AutomationRunDestination, { kind: 'cowork-chat' }>,
): Promise<OpenAutomationRunDestinationResult> {
  const { workspaceId, chatId, userMessageId } = destination;
  const exists = useProjectsStore
    .getState()
    .projects.some((project) => project.id === workspaceId);
  if (!exists) {
    return { ok: false, error: CHAT_UNAVAILABLE_REASON };
  }
  try {
    const switched = await useStandaloneChatStore
      .getState()
      .switchChatProject(workspaceId);
    if (!switched) {
      return { ok: false, error: CHAT_UNAVAILABLE_REASON };
    }
    // Resolves the owning Work Entry and selects entry + tab.
    const selected = await useStandaloneChatStore.getState().selectChat(chatId);
    if (!selected) {
      return { ok: false, error: CHAT_UNAVAILABLE_REASON };
    }
  } catch {
    return { ok: false, error: CHAT_UNAVAILABLE_REASON };
  }
  useNavigationStore.getState().navigate('chat');
  if (userMessageId) {
    useNavigationStore.getState().openChatTurn({
      projectId: workspaceId,
      chatId,
      userMessageId,
    });
  }
  return { ok: true };
}

async function openAppAdvisorChat(
  destination: Extract<AutomationRunDestination, { kind: 'app-advisor-chat' }>,
): Promise<OpenAutomationRunDestinationResult> {
  const appAdvisor = window.api?.appAdvisor;
  if (!appAdvisor?.openWindow) {
    return { ok: false, error: `${ORCHESTRATOR_LABEL} is unavailable.` };
  }
  try {
    // A renderer store value cannot cross the window boundary, so the turn id
    // rides along on the IPC payload and the popout re-raises it locally.
    await appAdvisor.openWindow({
      chatId: destination.chatId,
      focus: true,
      ...(destination.delegationId !== undefined
        ? { delegationId: destination.delegationId }
        : {}),
      ...(destination.userMessageId
        ? { userMessageId: destination.userMessageId }
        : {}),
    });
  } catch {
    return { ok: false, error: CHAT_UNAVAILABLE_REASON };
  }
  return { ok: true };
}

/**
 * Opens the run's own panel through the shared opener, which reads the run
 * and takes its owner from it: the exact Code worktree, or the Cowork Work
 * Entry that fills the worktree slot. A recorded result owner is a hint the
 * opener checks. Cowork pipeline automations (project only) and usage-limit
 * resumes (id only) carry no usable owner hint; the run itself decides, and a
 * run with no workspace opens in the compatibility view.
 */
async function openPipelineExecutionDestination(
  destination: Extract<
    AutomationRunDestination,
    { kind: 'pipeline-execution' }
  >,
): Promise<OpenAutomationRunDestinationResult> {
  const { executionId, projectId, worktreeId, jobId } = destination;
  const result = await openPipelineExecutionPanel({
    executionId,
    ...(projectId && worktreeId ? { owner: { projectId, worktreeId } } : {}),
    ...(jobId === undefined ? {} : { target: { jobId } }),
  });
  switch (result.status) {
    case 'applied':
    case 'ownerless':
      return { ok: true };
    case 'error':
      return {
        ok: false,
        error:
          result.code === 'not_found' || result.code === 'owner_missing'
            ? PIPELINE_UNAVAILABLE_REASON
            : result.message,
      };
  }
}

/** Open the chat named by a generic turn deep link, then request turn focus. */
export async function openChatTurnDestination(link: {
  projectId: string;
  worktreeId?: string;
  chatId: string;
  userMessageId: string;
}): Promise<OpenAutomationRunDestinationResult> {
  if (link.projectId === APP_ADVISOR_PROJECT_ID) {
    return await openAppAdvisorChat({
      kind: 'app-advisor-chat',
      chatId: link.chatId,
      userMessageId: link.userMessageId,
    });
  }
  if (link.worktreeId) {
    return await openWorktreeChat({
      kind: 'worktree-chat',
      projectId: link.projectId,
      worktreeId: link.worktreeId,
      chatId: link.chatId,
      userMessageId: link.userMessageId,
    });
  }
  return await openCoworkChat({
    kind: 'cowork-chat',
    workspaceId: link.projectId,
    chatId: link.chatId,
    userMessageId: link.userMessageId,
  });
}

/** Navigate to a resolved destination, verifying it still exists first. */
export async function openAutomationRunDestination(
  rawDestination: AutomationRunDestination,
): Promise<OpenAutomationRunDestinationResult> {
  const destination = normalizeCoworkChatDestination(rawDestination);
  switch (destination.kind) {
    case 'worktree-chat':
      return await openWorktreeChat(destination);
    case 'cowork-chat':
      return await openCoworkChat(destination);
    case 'app-advisor-chat':
      return await openAppAdvisorChat(destination);
    case 'pipeline-execution':
      return await openPipelineExecutionDestination(destination);
    case 'none':
      return { ok: false, error: destination.reason };
  }
}
