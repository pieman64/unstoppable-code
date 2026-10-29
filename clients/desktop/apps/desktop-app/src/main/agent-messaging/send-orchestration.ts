import { randomUUID } from 'node:crypto';
import {
  parseChatSendAction,
  type AgentSendAcceptanceFacts,
  type InlineChatWatcherReservation,
} from '@canopy/desktop-shared/lib/chat-send-actions';
import {
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type ChatCommandEnvelope,
  type ChatSendMessageRequest,
} from '@canopy/desktop-shared/types';
import {
  buildAgentSenderRequest,
  revalidateAgentSenderRequest,
  isAgentSenderContextError,
} from './sender-context';
import { resolveAuthorizedChat } from '../project-discovery/chat-target';
import type { BotChatAddress } from '@canopy/desktop-shared/lib/bot-discovery';
import type { ChatReadScope } from '../project-discovery/chat-target';
import type { PersistedChatTab } from '@canopy/desktop-shared/types';
import type { ProjectDiscoveryCaller } from '../project-discovery';
import { DiscoveryError } from '../project-discovery/errors';
import { getActiveDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import {
  createChatCommandDispatchOptions,
  dispatchTrustedChatCommand,
} from '../canopy-runtime/core-chat-command-adapter';
import { withLegacyChatMessageCommand } from '../canopy-runtime/core-chat-message-command-adapter';
import { getChatStateCommandPort } from '../ipc/chat-state';
import {
  withChatSendAdmission,
  type ChatSendAdmissionCheck,
} from '../services/chat-send-admission';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import type {
  AcceptedInputReceipt,
  AgentSendRefusalCode,
  ChatSendAction,
  InlineChatWatcherReservationPort,
} from '@canopy/desktop-shared/lib/chat-send-actions';
import type {
  AppAdvisorWatcherDestination,
  ApprovalMode,
} from '@canopy/desktop-shared/types';
import type { AppAdvisorToolRuntimeSurfaces } from '../app-advisor/runtime';
import type { AgentSenderRuntimeSource } from './sender-context';

/** The calling session, resolved only from a trusted main-process runtime. */
export type TrustedSendCaller =
  | { kind: 'project_root'; source: AgentSenderRuntimeSource }
  | { kind: 'app_advisor'; source: AgentSenderRuntimeSource };

/**
 * A message's approval admission: the check the chat state owner runs as the
 * message commits, and, after it refused, the typed refusal.
 */
export interface AgentSendAdmission {
  check: ChatSendAdmissionCheck;
  refusal(): AgentChatSendError | undefined;
}

export interface AgentChatSendContext {
  caller: TrustedSendCaller;
  /**
   * Root project sends: reads the target chat's approval admission before the
   * send, throwing a typed refusal, and checks it again as the message commits.
   */
  admission?: (target: ChatReadScope) => Promise<AgentSendAdmission>;
  /**
   * Root project creations: the approval mode a chat the agent creates in
   * this task starts in. With a first message, refuses before anything is
   * created a chat whose approvals that message's admission would refuse.
   */
  startAdmission?: (
    task: { workspaceId: string; worktreeId: string },
    firstMessage: boolean,
  ) => Promise<{ approvalMode: ApprovalMode }>;
  /** The originating root chat; inline watchers notify it, never the target. */
  watcherDestination: AppAdvisorWatcherDestination;
  toolUseId?: string;
  /** Window access for sends through the retained App Advisor path. */
  surfaces?: AppAdvisorToolRuntimeSurfaces;
  /** Injected in tests; defaults to the App Advisor watcher service. */
  watchers?: InlineChatWatcherReservationPort;
}

/** A typed refusal at acceptance; never a success receipt without identity. */
export class AgentChatSendError extends Error {
  constructor(
    readonly code: AgentSendRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentChatSendError';
  }
}

export function isAgentChatSendError(
  error: unknown,
): error is AgentChatSendError {
  return error instanceof AgentChatSendError;
}

/**
 * Sends one agent message to a project or bot chat with trusted sender
 * context, reserving inline completion watchers bound to the accepted input.
 * Project sends cross `core.chat.message.send`; bot sends use the retained
 * App Advisor trusted-send path. Never navigates.
 */
export async function dispatchAgentChatSend(
  action: ChatSendAction,
  context: AgentChatSendContext,
): Promise<AcceptedInputReceipt> {
  try {
    return await send(action, context);
  } catch (error) {
    if (isAgentSenderContextError(error)) {
      const hidden =
        error.code === 'owner_boundary' ||
        error.code === 'authorization_conflict';
      throw new AgentChatSendError(
        hidden ? 'not_found' : error.code,
        hidden ? 'The target chat is not available.' : error.message,
      );
    }
    if (error instanceof DiscoveryError)
      throw new AgentChatSendError(
        error.code === 'advisor_access_disabled'
          ? 'advisor_access_disabled'
          : 'not_found',
        'The target chat is not available.',
      );
    throw error;
  }
}

async function send(
  input: ChatSendAction,
  context: AgentChatSendContext,
): Promise<AcceptedInputReceipt> {
  const parsed = parseChatSendAction(input);
  if (!parsed.ok)
    throw new AgentChatSendError('validation_failed', parsed.message);
  const action = parsed.action;
  const source = await canonicalSource(context.caller.source);
  if (
    (context.caller.kind === 'app_advisor') !==
    (source.projectId === APP_ADVISOR_PROJECT_ID)
  )
    throw new AgentChatSendError(
      'validation_failed',
      'The trusted sender runtime is inconsistent.',
    );
  const caller: ProjectDiscoveryCaller =
    context.caller.kind === 'app_advisor'
      ? { kind: 'app_advisor', chatId: source.chatId }
      : { kind: 'project_agent', ...source };
  const target =
    action.type === 'projects.send_message'
      ? await resolveAuthorizedChat(
          {
            projectId: action.projectId,
            taskId: action.taskId,
            chatId: action.chatId,
          },
          caller,
        )
      : await resolveBotTarget(action, caller);
  // Matches discovery: an expired session is read-only (canSend: false).
  if (
    target.tab.readOnly ||
    target.tab.staleSessionDetected !== undefined ||
    target.tab.kind === 'file'
  )
    throw new AgentChatSendError(
      'not_found',
      'The target chat is not available.',
    );
  if (
    action.type === 'projects.send_message' &&
    target.projectType === 'cowork' &&
    action.queueForSetup !== undefined
  )
    throw new AgentChatSendError(
      'unsupported_action',
      'Setup queuing is only supported for code targets.',
    );
  if (
    source.projectId === target.scope.workspaceId &&
    source.worktreeId === target.scope.worktreeId &&
    source.chatId === target.scope.chatId
  )
    throw new AgentChatSendError(
      'unsupported_action',
      'A chat cannot send a message to itself.',
    );
  const admission =
    action.type === 'projects.send_message' && context.admission
      ? await context.admission(target.scope)
      : undefined;
  const userMessageId = randomUUID();
  const commandId = randomUUID();
  const fields = await buildAgentSenderRequest(
    source,
    userMessageId,
    target.scope.workspaceId,
  );
  const request: ChatSendMessageRequest = {
    projectId: target.scope.workspaceId,
    worktreeId: target.scope.worktreeId,
    chatId: target.scope.chatId,
    userMessageId,
    text: action.text,
    ...fields,
    ...(action.type === 'projects.send_message' && action.queueForSetup
      ? { agentSendSetup: { version: 1 as const } }
      : {}),
  };
  await revalidateAgentSenderRequest(request);
  const envelope: ChatCommandEnvelope = {
    schemaVersion: 1,
    commandId,
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    command: {
      type: 'chat.send_message',
      chatId: request.chatId,
      userMessageId,
      text: request.text,
      ...fields,
      ...(request.agentSendSetup
        ? { agentSendSetup: request.agentSendSetup }
        : {}),
    },
  };
  const port = getChatStateCommandPort();
  if (!port)
    throw new AgentChatSendError(
      'target_not_ready',
      'Chat command dispatch is unavailable.',
    );
  let acceptance: AgentSendAcceptanceFacts | undefined;
  const executionOptions = {
    onAgentSendAccepted: (facts: AgentSendAcceptanceFacts): void => {
      acceptance = facts;
    },
  };
  const watchers = action.watchers?.length
    ? (context.watchers ??
      (await import('../app-advisor/watchers')).getAppAdvisorWatcherService())
    : undefined;
  let reservation: InlineChatWatcherReservation | undefined;
  if (watchers) {
    const reserved = await watchers.reserveInlineChatWatchers({
      destination: context.watcherDestination,
      recipient: { kind: 'root' },
      createdByToolUseId: context.toolUseId,
      target: target.address,
      entries: action.watchers ?? [],
      acceptedInputId: userMessageId,
      commandId,
    });
    if (!reserved.ok)
      throw new AgentChatSendError(reserved.code, reserved.error);
    reservation = reserved.reservation;
  }
  let definitelyRefused = false;
  try {
    if (action.type === 'projects.send_message') {
      const dispatch = (): ReturnType<typeof dispatchTrustedChatCommand> =>
        dispatchTrustedChatCommand(envelope, {
          ...createChatCommandDispatchOptions(port, getActiveDesktopRuntime(), {
            principalId: 'local-desktop-user',
            clientInstanceId: 'agent-chat-send',
            authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
            interfaceKind: 'mcp',
            grants: ['core.chat.write'],
          }),
          executionOptions,
        });
      const result = admission
        ? await withChatSendAdmission(
            {
              projectId: request.projectId,
              worktreeId: request.worktreeId,
              chatId: request.chatId,
              userMessageId,
            },
            admission.check,
            dispatch,
          )
        : await dispatch();
      if (
        result.outcome !== 'applied' &&
        result.outcome !== 'already_applied'
      ) {
        definitelyRefused = true;
        throw (
          admission?.refusal() ??
          new AgentChatSendError(
            result.outcome === 'not_found' ? 'not_found' : 'target_not_ready',
            result.reason ?? 'The target refused this input.',
          )
        );
      }
    } else {
      const {
        buildExistingTabDispatchOptions,
        getRegisteredAppAdvisorSurfaces,
        sendWorktreeChatMessage,
      } = await import('../services/chat-service');
      // Root project callers have no Advisor window access of their own.
      const surfaces = context.surfaces ?? getRegisteredAppAdvisorSurfaces();
      const settings = await buildExistingTabDispatchOptions(
        request.projectId,
        request.worktreeId,
        request.chatId,
      );
      await withLegacyChatMessageCommand(
        envelope,
        () =>
          sendWorktreeChatMessage(
            { ...request, ...settings },
            {
              getWindow: surfaces?.getMainWindow,
              appAdvisorSurfaces: surfaces,
              preserveActiveTab: true,
            },
          ),
        undefined,
        executionOptions,
      );
    }
    if (!acceptance)
      acceptance = (await port.getCommandReceipt?.(envelope))
        ?.agentSendAcceptance;
    if (!acceptance)
      throw new Error(
        'Agent send acceptance could not be confirmed; do not resend this input.',
      );
  } catch (error) {
    if (!acceptance) {
      try {
        acceptance = (await port.getCommandReceipt?.(envelope))
          ?.agentSendAcceptance;
      } catch {
        /* Ambiguous acceptance keeps the reservation inert for recovery. */
      }
    }
    if (!acceptance) {
      if (
        reservation &&
        watchers &&
        (definitelyRefused || isAgentSenderContextError(error))
      )
        await watchers.cancelInlineChatWatchers(reservation.reservationId);
      throw error;
    }
  }
  const watcherReceipts =
    reservation && watchers
      ? await watchers.confirmInlineChatWatchers(
          reservation.reservationId,
          acceptance,
        )
      : [];
  const base = {
    address: target.address,
    acceptedAt: acceptance.acceptedAt,
    watcherReceipts,
  };
  if (acceptance.disposition === 'queued') {
    if (!acceptance.queuedMessageId)
      throw new Error('Queued acceptance is missing its host queue identity.');
    return {
      ...base,
      disposition: 'queued',
      queuedMessageId: acceptance.queuedMessageId,
      messageId: acceptance.acceptedInputId,
    };
  }
  return {
    ...base,
    disposition: 'started',
    messageId: acceptance.acceptedInputId,
  };
}

export async function canonicalSource(
  source: AgentSenderRuntimeSource,
): Promise<AgentSenderRuntimeSource> {
  const projectId = resolveCoworkWorkspaceId(
    source.projectId === STANDALONE_CHAT_PROJECT_ID
      ? source.worktreeId
      : source.projectId,
  );
  if (projectId === source.projectId) return source;
  const { resolveWorkEntryForChat } =
    await import('../lib/cowork-work-entries');
  const owner = await resolveWorkEntryForChat(projectId, source.chatId);
  if (!owner.entryId || owner.archivedInEntryId)
    throw new AgentChatSendError(
      'not_found',
      'The sender chat is not available.',
    );
  return { projectId, worktreeId: owner.entryId, chatId: source.chatId };
}

async function resolveBotTarget(
  action: Extract<ChatSendAction, { type: 'bots.send_message' }>,
  caller: ProjectDiscoveryCaller,
): Promise<{
  address: BotChatAddress;
  projectType: 'cowork';
  scope: ChatReadScope;
  tab: PersistedChatTab;
}> {
  const { requireBotAccess, readBotEntries } =
    await import('../project-discovery/bots/target');
  await requireBotAccess(caller);
  const { requireBot } = await import('../project-discovery/bots/registry');
  const bot = requireBot(action.botId);
  if (
    !(await readBotEntries(bot.botId)).some(
      (entry) => entry.id === action.taskId,
    )
  )
    throw new AgentChatSendError(
      'not_found',
      'The target chat is not available.',
    );
  const { readTaskRuntimeSnapshot } =
    await import('../project-discovery/runtime-state');
  const snapshot = await readTaskRuntimeSnapshot(bot.projectId, action.taskId);
  const tab = snapshot.tabsFile.tabs.find(
    (candidate) => candidate.id === action.chatId && candidate.kind !== 'file',
  );
  if (!tab)
    throw new AgentChatSendError(
      'not_found',
      'The target chat is not available.',
    );
  return {
    address: { botId: bot.botId, taskId: action.taskId, chatId: tab.id },
    projectType: 'cowork' as const,
    scope: {
      workspaceId: bot.projectId,
      worktreeId: action.taskId,
      chatId: tab.id,
    },
    tab,
  };
}
