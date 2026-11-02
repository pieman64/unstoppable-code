import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import {
  buildTrustedAutoResume,
  claimTrustedChatResume,
} from './trusted-auto-resume';
import { getObservabilityService } from '../observability';
import {
  logMainProcessError,
  logMainProcessWarn,
} from './main-process-logging';
import { readChatTabsFile } from './chat-tabs-reader';
import {
  buildExistingTabDispatchOptions,
  sendWorktreeChatMessage,
} from '../services/chat-service';
import { getAllActiveSessionInfos } from '../agents/session-manager';
import {
  takePendingAuthResumesForMcpServer,
  takePendingAuthResumesForGitHub,
  isAuthResumeClaimCurrent,
  finishAuthResumeClaim,
  type PendingAuthResume,
} from './auth-failure-turn-stop';

/**
 * Outcome of trying to re-drive one turn that an authentication failure
 * stopped (CAN-1814 PR 6).
 *
 * `requires-explicit-retry` is a SUCCESSFUL, deliberate outcome, not an error:
 * it means the interrupted work was not provably safe to repeat, so the user
 * sends again themselves.
 */
export type AuthResumeStatus =
  | 'resumed'
  | 'requires-explicit-retry'
  | 'chat-busy'
  | 'dispatch-failed';

export interface ResumeChatAfterAuthRecoveryInput {
  pending: PendingAuthResume;
  /**
   * `auto` is Canopy deciding on the user's behalf and is gated on
   * {@link PendingAuthResume.autoResumeSafe}; `user` is an explicit retry and
   * is not.
   */
  trigger: 'auto' | 'user';
  getWindow: () => BrowserWindow | null;
}

function isChatBusy(pending: PendingAuthResume): boolean {
  return getAllActiveSessionInfos().some(
    (session) =>
      session.projectId === pending.target.projectId &&
      session.worktreeId === pending.target.worktreeId &&
      session.chatId === pending.target.chatId &&
      (session.turnActive || session.pendingMessageCount > 0),
  );
}

/**
 * Re-drive a stopped turn now that its blocked dependency is reconnected.
 *
 * The prompt comes from {@link computeUsageLimitResumePrompt}, the established
 * precedent for resuming an interrupted chat (`transient-error-retry-service`
 * and `ipc/usage-limited-chats` both use it): re-send the user's last message
 * when the turn died before the agent did anything, otherwise nudge with
 * `Continue`. Reusing it means a resumed auth failure and a resumed usage
 * limit behave identically, rather than being two hand-rolled prompts that
 * drift.
 *
 * Dispatched with `initiationSource: 'automation'` for the same reason the
 * usage-limit resume is: Canopy, not the user, decided to send it.
 */
/**
 * Record how a resume ended.
 *
 * Every outcome used to be invisible: the dispatch failure was swallowed by a
 * bare `catch {}` and the caller `void`ed the returned statuses, so a resume
 * that silently never happened was indistinguishable from one that was never
 * attempted (CAN-1814 review). Worktree/chat-scoped, so it belongs in
 * `diagnostics/session-events/`, not `app-events/`.
 */
function recordResumeOutcome(
  pending: PendingAuthResume,
  trigger: 'auto' | 'user',
  status: AuthResumeStatus,
  error?: unknown,
): void {
  const { projectId, worktreeId, chatId } = pending.target;
  try {
    getObservabilityService().recordSessionDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'auth_resume_outcome',
      sessionKey: `${projectId}:${worktreeId}:${chatId}`,
      projectId,
      worktreeId,
      chatId,
      providerType: 'unknown',
      authResumeStatus: status,
      authResumeTrigger: trigger,
      authResumeDependencyIds: [...pending.dependencyIds],
      ...(error !== undefined
        ? { error: error instanceof Error ? error.message : 'Unknown error' }
        : {}),
    });
  } catch (diagnosticError: unknown) {
    // Observability must never be the reason a recovery path fails.
    logMainProcessWarn(
      'Recording an auth-resume diagnostic failed',
      diagnosticError,
    );
  }
}

export async function resumeChatAfterAuthRecovery(
  input: ResumeChatAfterAuthRecoveryInput,
): Promise<AuthResumeStatus> {
  const { pending } = input;
  if (
    input.trigger === 'auto' &&
    (!pending.autoResumeSafe || !isAuthResumeClaimCurrent(pending))
  ) {
    recordResumeOutcome(pending, input.trigger, 'requires-explicit-retry');
    return 'requires-explicit-retry';
  }
  if (isChatBusy(pending)) {
    recordResumeOutcome(pending, input.trigger, 'chat-busy');
    return 'chat-busy';
  }

  const release = claimTrustedChatResume(pending.target);
  if (!release) {
    recordResumeOutcome(pending, input.trigger, 'chat-busy');
    return 'chat-busy';
  }
  const { projectId, worktreeId, chatId } = pending.target;
  try {
    const tabOptions = await buildExistingTabDispatchOptions(
      projectId,
      worktreeId,
      chatId,
    );
    const tabsFile = await readChatTabsFile(projectId, worktreeId, {
      chatIds: [chatId],
    });
    const tab = tabsFile.tabs.find((candidate) => candidate.id === chatId);
    if (!tab) throw new Error('The chat no longer exists.');
    if (input.trigger === 'auto' && !isAuthResumeClaimCurrent(pending)) {
      recordResumeOutcome(pending, input.trigger, 'requires-explicit-retry');
      return 'requires-explicit-retry';
    }
    if (isChatBusy(pending)) {
      recordResumeOutcome(pending, input.trigger, 'chat-busy');
      return 'chat-busy';
    }
    const resumePrompt = buildTrustedAutoResume(
      tab,
      'auth_recovery',
      pending.recordedAt,
    );
    await sendWorktreeChatMessage(
      {
        projectId,
        worktreeId,
        chatId,
        text: resumePrompt.text,
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
        userMessageId: randomUUID(),
        initiationSource: 'automation',
        autoResume: resumePrompt.autoResume,
        resumesInterruptedTurn: true,
        ...(resumePrompt.resendsUserMessage && resumePrompt.inputMode
          ? { inputMode: resumePrompt.inputMode }
          : {}),
        ...tabOptions,
      },
      { getWindow: input.getWindow },
    );
    recordResumeOutcome(pending, input.trigger, 'resumed');
    return 'resumed';
  } catch (error: unknown) {
    // A failed resume must never take down the OAuth settle path that called
    // it. The turn simply stays stopped and the user sends again — but it is
    // no longer silent: an empty `catch {}` here made a resume that never
    // happened look exactly like one that was never attempted (CAN-1814
    // review).
    logMainProcessError(
      `Resuming chat ${projectId}/${worktreeId}/${chatId} after authentication recovery failed`,
      error,
    );
    recordResumeOutcome(pending, input.trigger, 'dispatch-failed', error);
    return 'dispatch-failed';
  } finally {
    release();
  }
}

export interface ResumeAfterMcpOAuthInput {
  serverId: string;
  configId: string;
  getWindow: () => BrowserWindow | null;
}

/**
 * Resume every turn that this MCP server config stopped, now that its OAuth
 * login has settled successfully.
 *
 * Driven from the main-process OAuth settle listener rather than from the
 * renderer card, so a resume still happens if the user navigates away while
 * the browser leg is outstanding. Claiming is destructive
 * ({@link takePendingAuthResumesForMcpServer}), so a repeated settle event
 * cannot re-dispatch into a chat that already resumed.
 */
export async function resumeChatsAfterMcpOAuthSuccess(
  input: ResumeAfterMcpOAuthInput,
): Promise<AuthResumeStatus[]> {
  const claimed = takePendingAuthResumesForMcpServer(
    input.serverId,
    input.configId,
  );
  return resumeClaimedAuthResumes(claimed, input.getWindow);
}

/** Called only after the main-process credential resolver returns a token. */
export async function resumeChatsAfterGitHubLogin(input: {
  getWindow: () => BrowserWindow | null;
}): Promise<AuthResumeStatus[]> {
  const claimed = takePendingAuthResumesForGitHub();
  return resumeClaimedAuthResumes(claimed, input.getWindow);
}

async function resumeClaimedAuthResumes(
  claimed: PendingAuthResume[],
  getWindow: () => BrowserWindow | null,
): Promise<AuthResumeStatus[]> {
  const statuses: AuthResumeStatus[] = [];
  for (const pending of claimed) {
    try {
      statuses.push(
        await resumeChatAfterAuthRecovery({
          pending,
          trigger: 'auto',
          getWindow,
        }),
      );
    } finally {
      finishAuthResumeClaim(pending);
    }
  }
  return statuses;
}
