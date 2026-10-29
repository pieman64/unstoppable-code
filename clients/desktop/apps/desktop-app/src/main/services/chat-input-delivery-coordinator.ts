import type { WatcherDeliveryIngressCheck } from '@canopy/desktop-shared/lib/chat-watcher-contracts';
import {
  revalidateAgentSenderRequest,
  revalidateAgentSteeringActor,
  isAgentSenderContextError,
  AgentSenderContextError,
  agentSendTargetReadiness,
} from '../agent-messaging/sender-context';
import { browserHandoffs } from '../browser/browser-handoffs';
import {
  capturePresentationTurn,
  presentationChatKey,
  recordPresentationTurn,
  resolvePresentationSource,
} from '../canopy-tools/presentation-state';
import { inputRequestMatchesSettings } from '@canopy/desktop-shared/chat-input-delivery';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import type {
  ChatInputDeliveryEvent,
  ChatSteeringCapabilities,
} from '@canopy/protocol/portal';
import type {
  ChatCommandEnvelope,
  ChatCommandResult,
  ChatCoreMutation,
  ChatSendMessageRequest,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { ChatScopeKey } from './chat-state-repository';
import type { AgentSession } from '../agents/types';
import { buildSubmittedMessageText } from '../lib/chat-submitted-message';
import {
  resolveActivePlanSystemInstruction,
  withActivePlanInstruction,
} from '../lib/active-plan-instruction';
import { resolveAgentAttachmentsDir } from '../lib/agent-attachments';
import { isModelBlockedByStoredPolicy } from '../lib/model-policy-state';
import { resolveAiCreditsScopeOwner } from '../agents/work-owner';
import { buildAutomationInfoMessage } from './automation-info-message';
import type { ChatStateV2Repository } from './chat-state-v2-repository';
import { watcherDeliveryAuthorityGeneration } from './watcher-delivery-authority';
import {
  inputSettingsKey,
  isInputLedger,
  observeInputDelivery,
  restoreInputLedger,
  type InputLedger,
  type InputRow,
} from './chat-input-delivery-state';

type Target = ChatScopeKey & { chatId: string };
type Receipt = {
  commandId: string;
  outcome: 'applied';
  entityId: string;
  agentSteeringActor?: Extract<
    ChatCommandEnvelope['command'],
    { type: 'chat.steer_queued_message' }
  >['agentSteeringActor'];
};
type SessionLookup = (target: Target) => Promise<AgentSession | undefined>;
type InputDeliveryRepository = Pick<
  ChatStateV2Repository,
  'getRevision' | 'getState' | 'transactWith'
>;

export type WatcherSteeringResult =
  | { status: 'fallback' }
  /** `submitted` when this call handed the input to the provider. */
  | { status: 'handled'; submitted?: true }
  | { status: 'requeue'; rowId: string; epoch: number };

class RefusedSteerSettlementError extends Error {
  public readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'RefusedSteerSettlementError';
    this.cause = cause;
  }
}

function materializePickedUpMessage(
  row: InputRow,
  pickedUpAttempt: InputRow['attempts'][number] | undefined,
  event: ChatInputDeliveryEvent,
): PersistedChatTab['messages'][number] {
  const payload = pickedUpAttempt?.payloadSnapshot ?? row.payload;
  return {
    id: row.id,
    role: 'user',
    userMessageSource: payload.agentSent
      ? 'agent'
      : payload.watcherFired
        ? 'watcher'
        : 'human',
    ...(payload.agentSent ? { agentSent: payload.agentSent } : {}),
    // A delegate's message to its root chat stays hidden, as it does when it
    // is dispatched as an ordinary queued turn.
    ...(row.payload.managedDelegationDeliveryId ? { hidden: true } : {}),
    timestamp: pickedUpAttempt?.pickedUpAt ?? row.createdAt,
    ...(row.payload.watcherFired
      ? { watcherFired: row.payload.watcherFired }
      : {}),
    blocks: [
      ...(payload.fileReferences?.length
        ? [
            {
              type: 'file_references' as const,
              references: payload.fileReferences,
            },
          ]
        : []),
      {
        type: 'text',
        text: pickedUpAttempt?.displayText ?? row.text,
        steering: {
          startsTurn:
            event.startsTurn === true && event.turnRootAccepted !== false,
          rootUserMessageId: pickedUpAttempt?.rootUserMessageId,
        },
      },
    ],
    ...(payload.attachmentPaths
      ? { attachmentPaths: payload.attachmentPaths }
      : {}),
    ...(payload.attachmentPromptContexts
      ? { attachmentPromptContexts: payload.attachmentPromptContexts }
      : {}),
    ...(payload.inputMode ? { inputMode: payload.inputMode } : {}),
  };
}

export type InputPickupObserver = (
  target: Target,
  row: InputRow,
  event: ChatInputDeliveryEvent,
) => Promise<void>;

export class ChatInputDeliveryCoordinator {
  private readonly handoffsByAttempt = new Map<string, string[]>();
  private readonly suspended = new Map<string, number>();
  private readonly activeActions = new Set<string>();
  private readonly queueRestorations = new Map<string, Promise<void>>();
  constructor(
    private readonly repository: InputDeliveryRepository,
    private readonly sessionFor: SessionLookup,
    private readonly authorize: (
      target: ChatScopeKey & { tab: PersistedChatTab },
    ) => Promise<void>,
    private readonly onPickup: InputPickupObserver,
    private readonly checkWatcherIngress: (
      request: ChatSendMessageRequest,
    ) => ReturnType<WatcherDeliveryIngressCheck>,
  ) {}

  private key(target: Target): string {
    return JSON.stringify([target.projectId, target.worktreeId, target.chatId]);
  }

  private async restoreQueueContinuation(
    target: Target,
    row: InputRow,
    epoch: number,
  ): Promise<void> {
    const queueIntent = row.queueIntent;
    if (!queueIntent) return;
    const restorationKey = `${this.key(target)}:${row.id}:${queueIntent.commandId}`;
    const existing = this.queueRestorations.get(restorationKey);
    if (existing) {
      await existing;
      return;
    }
    const restoration = (async (): Promise<void> => {
      const currentLedger = (await this.tab(target)).inputDelivery;
      if (!isInputLedger(currentLedger) || currentLedger.epoch !== epoch) {
        throw new Error('Stop or Interrupt superseded this message action');
      }
      const currentRow = currentLedger.rows.find(
        (candidate) => candidate.id === row.id,
      );
      if (currentRow?.state === 'queued' && !currentRow.queueIntent) return;
      if (
        currentRow?.state !== 'cancelled' ||
        currentRow.queueIntent?.commandId !== queueIntent.commandId
      ) {
        throw new Error('The input is no longer available to queue');
      }
      // Lazy by design: the queue service constructs this coordinator, so a
      // static reverse import would create an initialization cycle. The
      // packaged Electron main build exercises this local import path.
      const { getChatQueueService } = await import('./chat-queue-service');
      await getChatQueueService().restoreWithdrawnInput(
        currentRow.payload,
        currentRow.id,
        {
          commandId: queueIntent.commandId,
          outcome: 'applied',
          entityId: currentRow.id,
        },
        epoch,
        currentRow.origin,
      );
    })();
    this.queueRestorations.set(restorationKey, restoration);
    try {
      await restoration;
    } finally {
      if (this.queueRestorations.get(restorationKey) === restoration) {
        this.queueRestorations.delete(restorationKey);
      }
    }
  }
  isSuspended(target: Target): boolean {
    return (this.suspended.get(this.key(target)) ?? 0) > 0;
  }

  private async tab(target: Target): Promise<PersistedChatTab> {
    const state = await this.repository.getState(target);
    const tab = state.tabsFile.tabs.find(
      (candidate) =>
        candidate.id === target.chatId && candidate.kind !== 'file',
    );
    if (!tab) throw new Error('Chat is no longer available');
    return tab;
  }

  private async tabIncludingArchived(
    target: Target,
  ): Promise<PersistedChatTab> {
    const state = await this.repository.getState(target);
    const liveTab = state.tabsFile.tabs.find(
      (candidate) =>
        candidate.id === target.chatId && candidate.kind !== 'file',
    );
    const tab =
      liveTab ??
      state.archivesFile.archived.find(
        (entry) => entry.tab.id === target.chatId,
      )?.tab;
    if (!tab) throw new Error('Chat is no longer available');
    return tab;
  }

  private async update(
    target: Target,
    change: (
      ledger: InputLedger,
      tab: PersistedChatTab,
      rootUserMessageId: string | undefined,
    ) => InputLedger,
    receipt?: Receipt,
    extra: ChatCoreMutation[] = [],
  ): Promise<void> {
    await this.repository.transactWith(
      target,
      (current) => {
        const liveTab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === target.chatId,
        );
        const archived = liveTab
          ? undefined
          : current.archivesFile.archived.find(
              (entry) => entry.tab.id === target.chatId,
            );
        const tab = liveTab ?? archived?.tab;
        if (!tab) throw new Error('Chat is no longer available');
        if (
          tab.inputDelivery !== undefined &&
          !isInputLedger(tab.inputDelivery)
        )
          throw new Error(
            'This message history requires a newer application version',
          );
        const ledger = tab.inputDelivery ?? { version: 1, epoch: 0, rows: [] };
        const next = change(
          ledger,
          tab,
          current.runtimeByChatId[target.chatId]?.activeTurn?.userMessageId,
        );
        if (next === ledger && !receipt && extra.length === 0) return [];
        if (archived)
          return [
            {
              type: 'archive.upserted',
              entry: { ...archived, tab: { ...tab, inputDelivery: next } },
            },
          ];
        return [
          {
            type: 'tab.metadata_patched',
            tabId: target.chatId,
            patch: { inputDelivery: next },
          },
          ...extra,
        ];
      },
      {
        source: receipt ? 'renderer-command' : 'provider',
        mutationId: receipt?.commandId ?? randomUUID(),
        ...(receipt ? { commandResult: receipt } : {}),
        chatIds: [target.chatId],
      },
    );
  }

  private async prepare(
    request: ChatSendMessageRequest,
    session?: AgentSession,
  ): Promise<string> {
    if (
      request.agentSent ||
      request.agentSenderProvenance ||
      request.hiddenContext?.kind === 'agent-sender-context'
    )
      await revalidateAgentSenderRequest(request);
    if (
      request.agentSendSetup &&
      (await agentSendTargetReadiness(request)) === 'pending'
    )
      throw new AgentSenderContextError(
        'target_not_ready',
        'The target task is still being set up.',
      );
    const attachmentBaseDir = resolveAgentAttachmentsDir(
      request.projectId,
      request.worktreeId,
    );
    // A steered input bypasses the dispatch funnel, so it resolves the active
    // plan captured with it here. Resolution never throws.
    const activePlanInstruction = await resolveActivePlanSystemInstruction({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      activePlan: request.activePlan,
    });
    const text = buildSubmittedMessageText({
      ...request,
      pendingSystemInstructions: withActivePlanInstruction(
        request.pendingSystemInstructions,
        activePlanInstruction,
      ),
      attachmentBaseDir,
      cwd: session?.getSteeringWorkingDirectory?.(),
    });
    // Assets are never silently omitted or replaced with a path that no longer exists.
    await Promise.all(
      (request.attachmentPaths ?? []).map((path) => access(path)),
    );
    return request.hiddenContext?.text
      ? `${request.hiddenContext.text}\n\n${text}`
      : text;
  }

  /**
   * Steers a host-generated input (a fired watcher or a delegate's message to
   * its root chat) into the active turn. Retries share the durable delivery
   * identity, including cancelled inputs.
   */
  async steerWatcher(
    request: ChatSendMessageRequest,
    queuedIds: () => string[],
    origin: 'desktop' | 'portal',
    allowSteering: boolean,
  ): Promise<WatcherSteeringResult> {
    const tab = await this.tab(request);
    if (tab.inputDelivery?.rows.some((row) => row.id === request.userMessageId))
      return { status: 'handled' };
    const session = await this.sessionFor(request);
    if (
      !allowSteering ||
      !session?.getSteeringCapabilities?.().steer ||
      !session.submitSteeringInput ||
      session.isDisposed?.() ||
      !inputRequestMatchesSettings(request, tab)
    )
      return { status: 'fallback' };
    const epoch = tab.inputDelivery?.epoch ?? 0;
    let claimed = false;
    let sent: boolean;
    try {
      sent = await this.steerQueued(
        request,
        queuedIds,
        {
          commandId: `watcher-steer-${request.userMessageId}`,
          outcome: 'applied',
          entityId: request.chatId,
        },
        () => {
          claimed = true;
        },
        origin,
        'requeue',
      );
    } catch (error) {
      if (error instanceof RefusedSteerSettlementError) throw error;
      // A durable attempt is never retried as a full turn after ambiguous I/O.
      // Before admission, a turn ending during preparation can safely fall back.
      const latest = await this.tab(request);
      if (
        latest.inputDelivery?.rows.some(
          (row) => row.id === request.userMessageId,
        )
      )
        return { status: 'handled' };
      if (
        !claimed &&
        !this.isSuspended(request) &&
        (latest.inputDelivery?.epoch ?? 0) === epoch &&
        !session.getSteeringCapabilities?.().steer
      )
        return { status: 'fallback' };
      throw error;
    }
    const latest = await this.tab(request);
    if (
      !sent &&
      !this.isSuspended(request) &&
      latest.inputDelivery?.epoch === epoch &&
      latest.inputDelivery.rows.some(
        (row) => row.id === request.userMessageId && row.state === 'cancelled',
      )
    )
      return { status: 'requeue', rowId: request.userMessageId, epoch };
    return sent
      ? { status: 'handled', submitted: true }
      : { status: 'handled' };
  }

  /** Returns false only when this attempt was definitively never sent. */
  async steerQueued(
    request: ChatSendMessageRequest,
    queuedIds: () => string[],
    receipt: Receipt,
    claimed: () => void,
    origin: 'desktop' | 'portal' = 'desktop',
    ordinaryFallback: 'restore' | 'requeue' = 'restore',
  ): Promise<boolean> {
    const handoffsAtSend = browserHandoffs.captureOrigin({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      chatTabId: request.chatId,
    });
    if (this.isSuspended(request))
      throw new Error('The chat is stopping or interrupting');
    const tab = await this.tab(request);
    const workOwner = await resolveAiCreditsScopeOwner({
      kind: 'work',
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      chatId: request.chatId,
    });
    if (
      await isModelBlockedByStoredPolicy(request.model ?? tab.model, workOwner)
    )
      throw new Error('This model is blocked by your organization policy.');
    await this.authorize({ ...request, tab });
    const session = await this.sessionFor(request);
    const caps = session?.getSteeringCapabilities?.();
    if (!session?.submitSteeringInput || !caps?.steer || session.isDisposed?.())
      throw new Error('Steering is unavailable for the current session');
    if (!inputRequestMatchesSettings(request, tab))
      throw new Error(
        'The queued message uses different settings. Keep it queued to send with those settings.',
      );
    const settingsKey = inputSettingsKey(tab);
    const initialEpoch = tab.inputDelivery?.epoch ?? 0;
    const text = await this.prepare(request, session);
    const attemptId = randomUUID();
    const now = Date.now();
    let epoch = 0;
    await this.repository.transactWith(
      request,
      (current) => {
        const latest = current.tabsFile.tabs.find(
          (t) => t.id === request.chatId,
        );
        if (
          !latest ||
          inputSettingsKey(latest) !== settingsKey ||
          this.isSuspended(request) ||
          session.isDisposed?.()
        )
          throw new Error(
            'Chat settings or execution changed. The message remains queued.',
          );
        if (
          latest.inputDelivery !== undefined &&
          !isInputLedger(latest.inputDelivery)
        )
          throw new Error('Unsupported message history version');
        const ledger = latest.inputDelivery ?? {
          version: 1 as const,
          epoch: 0,
          rows: [],
        };
        if (ledger.epoch !== initialEpoch)
          throw new Error('Stop or Interrupt superseded the steering request');
        if (
          ledger.rows.some(
            (row) => row.id === request.userMessageId && row.state !== 'queued',
          )
        )
          throw new Error('This message already has a delivery attempt');
        epoch = ledger.epoch;
        const previous = ledger.rows.find(
          (row) => row.id === request.userMessageId,
        );
        const row: InputRow = {
          id: request.userMessageId,
          revision: (previous?.revision ?? 0) + 1,
          createdAt: previous?.createdAt ?? now,
          state: 'sending',
          text: request.text,
          payload: request,
          settingsKey,
          origin,
          currentAttemptId: attemptId,
          attempts: [
            ...(previous?.attempts ?? []),
            {
              id: attemptId,
              generation: caps.generation,
              provider: caps.provider,
              createdAt: now,
              submittedText: text,
              displayText: request.text,
              payloadSnapshot: structuredClone(request),
              rootUserMessageId:
                current.runtimeByChatId[request.chatId]?.activeTurn
                  ?.userMessageId,
            },
          ],
        };
        return [
          {
            type: 'tab.metadata_patched',
            tabId: request.chatId,
            patch: {
              inputDelivery: {
                ...ledger,
                rows: [...ledger.rows.filter((r) => r.id !== row.id), row],
              },
            },
          },
          {
            type: 'runtime.patched',
            chatId: request.chatId,
            runtime: {
              ...(current.runtimeByChatId[request.chatId] ?? {
                status: 'streaming',
              }),
              queuedMessageIds: queuedIds(),
            },
          },
        ];
      },
      {
        source: 'renderer-command',
        mutationId: receipt.commandId,
        commandResult: receipt,
        chatIds: [request.chatId],
      },
    );
    claimed(); // The queue may restore on failure only before this durable boundary.
    return this.submit(
      request,
      session,
      request.userMessageId,
      attemptId,
      epoch,
      text,
      ordinaryFallback,
      receipt.agentSteeringActor,
      handoffsAtSend,
    );
  }

  private async submit(
    target: Target,
    session: AgentSession,
    rowId: string,
    attemptId: string,
    epoch: number,
    text: string,
    ordinaryFallback: 'restore' | 'requeue' = 'restore',
    steeringActor?: Receipt['agentSteeringActor'],
    capturedHandoffs?: string[],
  ): Promise<boolean> {
    const presentationOrigin = {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatTabId: target.chatId,
    };
    const handoffsAtSend =
      capturedHandoffs ?? browserHandoffs.captureOrigin(presentationOrigin);
    let tab = await this.tab(target);
    let row = tab.inputDelivery?.rows.find(
      (candidate) => candidate.id === rowId,
    );
    // Preparation, durable admission and the final snapshot can all outlive
    // watcher authority. Revalidate at the last awaited provider boundary.
    if (row?.payload.watcherFired && row.payload.watcherDeliveryId) {
      const authority = watcherDeliveryAuthorityGeneration();
      const check = await this.checkWatcherIngress(row.payload);
      if (check.allowed) {
        // Stop or a settings change can land during authorization.
        tab = await this.tab(target);
        row = tab.inputDelivery?.rows.find(
          (candidate) => candidate.id === rowId,
        );
      }
      // An access, account or owner change during authorization or the
      // re-read makes the decision stale. Hold so the queue reauthorizes.
      const heldReason = !check.allowed
        ? check.reason
        : watcherDeliveryAuthorityGeneration() !== authority
          ? 'runtime_unavailable'
          : undefined;
      if (heldReason) {
        try {
          const restored = await this.restoreRejectedAsOrdinary(
            target,
            rowId,
            attemptId,
            epoch,
            heldReason,
            ordinaryFallback,
          );
          if (!restored)
            await this.markNeverSent(target, rowId, attemptId, heldReason);
        } catch (error) {
          throw new RefusedSteerSettlementError(error);
        }
        return false;
      }
    }
    // The steering agent may have lost access while delivery was prepared.
    if (steeringActor) {
      const authority = watcherDeliveryAuthorityGeneration();
      let allowed = true;
      try {
        await revalidateAgentSteeringActor(steeringActor, target.projectId);
        tab = await this.tab(target);
        row = tab.inputDelivery?.rows.find(
          (candidate) => candidate.id === rowId,
        );
      } catch (error) {
        if (!isAgentSenderContextError(error)) throw error;
        allowed = false;
      }
      if (!allowed || watcherDeliveryAuthorityGeneration() !== authority) {
        try {
          const restored = await this.restoreRejectedAsOrdinary(
            target,
            rowId,
            attemptId,
            epoch,
            'agent_send:not_found',
            ordinaryFallback,
          );
          if (!restored)
            await this.markNeverSent(
              target,
              rowId,
              attemptId,
              'agent_send:not_found',
            );
        } catch (error) {
          throw new RefusedSteerSettlementError(error);
        }
        // Report the refusal to the steering caller rather than a steer.
        throw new AgentSenderContextError(
          'not_found',
          'The target chat is not available.',
        );
      }
    }
    if (row?.payload.agentSenderProvenance) {
      try {
        const authority = watcherDeliveryAuthorityGeneration();
        await revalidateAgentSenderRequest(row.payload);
        tab = await this.tab(target);
        row = tab.inputDelivery?.rows.find(
          (candidate) => candidate.id === rowId,
        );
        if (watcherDeliveryAuthorityGeneration() !== authority)
          throw new AgentSenderContextError(
            'owner_context_unavailable',
            'Agent send authority changed during delivery.',
          );
      } catch (error) {
        if (!isAgentSenderContextError(error)) throw error;
        await this.markNeverSent(
          target,
          rowId,
          attemptId,
          `agent_send:${error.code === 'authorization_conflict' ? 'owner_boundary' : error.code}`,
        );
        return false;
      }
    }
    if (
      this.isSuspended(target) ||
      !isInputLedger(tab.inputDelivery) ||
      tab.inputDelivery.epoch !== epoch ||
      !session.submitSteeringInput
    ) {
      await this.markNeverSent(
        target,
        rowId,
        attemptId,
        'Submission was superseded by Stop or Interrupt',
      );
      return false;
    }
    const caps = session.getSteeringCapabilities?.();
    if (
      !caps?.steer ||
      session.isDisposed?.() ||
      row?.settingsKey !== inputSettingsKey(tab) ||
      row?.currentAttemptId !== attemptId ||
      row?.attempts.find((attempt) => attempt.id === attemptId)?.generation !==
        caps.generation
    ) {
      await this.markNeverSent(
        target,
        rowId,
        attemptId,
        'The active session no longer accepts steering',
      );
      return false;
    }
    // No await between final epoch/capability check and provider handoff.
    let result: Awaited<
      ReturnType<NonNullable<AgentSession['submitSteeringInput']>>
    >;
    if (handoffsAtSend.length)
      this.handoffsByAttempt.set(attemptId, handoffsAtSend);
    try {
      result = await session.submitSteeringInput(text, attemptId, rowId);
    } catch {
      await this.observe(target, {
        type: 'canopy_input_delivery',
        provider: caps.provider,
        generation: caps.generation,
        attemptId,
        phase: 'unknown',
      });
      return true;
    }

    if (result.kind === 'rejected') {
      this.handoffsByAttempt.delete(attemptId);
      try {
        if (result.fallback === 'ordinary') {
          const restored = await this.restoreRejectedAsOrdinary(
            target,
            rowId,
            attemptId,
            epoch,
            result.reason,
            ordinaryFallback,
          );
          if (restored) return false;
        }
        await this.markNeverSent(target, rowId, attemptId, result.reason);
        return false;
      } catch (error) {
        throw new RefusedSteerSettlementError(error);
      }
    }

    if (result.kind === 'accepted' && row) {
      this.handoffsByAttempt.delete(attemptId);
      const source = resolvePresentationSource(
        row.payload,
        row.origin === 'portal' ? 'portal' : 'user',
      );
      if (source === 'user' || source === 'portal') {
        for (const id of handoffsAtSend) browserHandoffs.release(id);
      } else if (source === 'automation' || source === 'hook') {
        const active = capturePresentationTurn(presentationOrigin);
        recordPresentationTurn(
          presentationChatKey(presentationOrigin),
          active?.turnId ?? rowId,
          source,
        );
      }
    }
    await this.observe(target, {
      type: 'canopy_input_delivery',
      provider: caps.provider,
      generation: caps.generation,
      attemptId,
      phase: result.kind === 'accepted' ? 'accepted' : 'unknown',
    });
    return true;
  }

  private async restoreRejectedAsOrdinary(
    target: Target,
    rowId: string,
    attemptId: string,
    epoch: number,
    reason: string,
    ordinaryFallback: 'restore' | 'requeue',
  ): Promise<boolean> {
    const fallback: { row?: InputRow } = {};
    await this.update(target, (ledger, tab) => {
      const row = ledger.rows.find((candidate) => candidate.id === rowId);
      if (
        !row ||
        ledger.epoch !== epoch ||
        this.isSuspended(target) ||
        !inputRequestMatchesSettings(row.payload, tab)
      ) {
        return ledger;
      }
      if (row.currentAttemptId !== attemptId || row.state !== 'sending') {
        return ledger;
      }
      const cancelled: InputRow = {
        ...row,
        revision: row.revision + 1,
        state: 'cancelled',
        reason: `${reason}. Falling back to ordinary delivery.`,
      };
      fallback.row = cancelled;
      return {
        ...ledger,
        rows: ledger.rows.map((candidate) =>
          candidate.id === rowId ? cancelled : candidate,
        ),
      };
    });
    if (!fallback.row) return false;
    if (ordinaryFallback === 'requeue') return true;
    const { getChatQueueService } = await import('./chat-queue-service');
    await getChatQueueService().restoreWithdrawnInput(
      fallback.row.payload,
      fallback.row.id,
      undefined,
      epoch,
      fallback.row.origin,
    );
    return true;
  }

  private async markNeverSent(
    target: Target,
    rowId: string,
    attemptId: string,
    reason: string,
  ): Promise<void> {
    this.handoffsByAttempt.delete(attemptId);
    await this.update(target, (ledger) => ({
      ...ledger,
      rows: ledger.rows.map((row) =>
        row.id === rowId &&
        row.currentAttemptId === attemptId &&
        row.state === 'sending'
          ? { ...row, revision: row.revision + 1, state: 'cancelled', reason }
          : row,
      ),
    }));
  }

  async observe(
    target: Target,
    event: ChatInputDeliveryEvent,
  ): Promise<boolean> {
    let matched = false;
    const pickup: { row?: InputRow } = {};
    const restoredQueuePickup: { rowId?: string } = {};
    const queueContinuation: { row?: InputRow; epoch?: number } = {};
    const rootEpoch = event.startsTurn
      ? (await this.tabIncludingArchived(target)).inputDelivery?.epoch
      : undefined;
    const capabilities = event.startsTurn
      ? await this.capabilities(target)
      : undefined;
    let committedEvent = event;
    const commit = await this.repository.transactWith(
      target,
      (current) => {
        const liveTab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === target.chatId,
        );
        const archived = liveTab
          ? undefined
          : current.archivesFile.archived.find(
              (entry) => entry.tab.id === target.chatId,
            );
        const tab = liveTab ?? archived?.tab;
        if (!tab || !isInputLedger(tab.inputDelivery)) return [];
        const acceptsRoot =
          event.startsTurn === true &&
          event.turnRootAccepted !== false &&
          rootEpoch === tab.inputDelivery.epoch &&
          !this.isSuspended(target);
        const effectiveEvent =
          event.startsTurn === true && !acceptsRoot
            ? { ...event, turnRootAccepted: false }
            : event;
        committedEvent = effectiveEvent;
        const next = observeInputDelivery(
          tab.inputDelivery,
          effectiveEvent,
          Date.now(),
        );
        const row = next.rows.find((candidate) =>
          candidate.attempts.some(
            (attempt) =>
              attempt.id === event.attemptId &&
              attempt.generation === event.generation &&
              attempt.provider === event.provider,
          ),
        );
        const pickedUpAttempt = row?.attempts.find(
          (attempt) => attempt.id === event.attemptId,
        );
        matched =
          pickedUpAttempt?.pickedUpAt !== undefined &&
          event.phase === 'picked-up';
        if (matched) pickup.row = row;
        if (matched && pickedUpAttempt?.withdrawnAt !== undefined && row) {
          restoredQueuePickup.rowId = row.id;
        }
        if (
          !archived &&
          event.phase === 'withdrawn' &&
          row?.state === 'cancelled' &&
          row.queueIntent
        ) {
          queueContinuation.row = row;
          queueContinuation.epoch = row.queueIntent.epoch ?? next.epoch;
        }
        if (next === tab.inputDelivery) return [];
        const pickedUpPayload =
          pickedUpAttempt?.payloadSnapshot ?? row?.payload;
        const consumed = pickedUpPayload?.pendingSystemInstructions ?? [];
        const remaining = tab.pendingSystemInstructions?.filter(
          (instruction) =>
            !consumed.some(
              (sent) =>
                sent.id === instruction.id && sent.text === instruction.text,
            ),
        );
        const shouldConsumeInstructions =
          matched &&
          remaining !== undefined &&
          remaining.length !== tab.pendingSystemInstructions?.length;
        const shouldMaterialize =
          matched &&
          row &&
          !tab.messages.some((message) => message.id === row.id);
        // An automation-initiated input that starts its own turn carries the
        // same start banner as an ordinary automation turn.
        const automationBanner =
          shouldMaterialize && acceptsRoot
            ? buildAutomationInfoMessage(pickedUpPayload, row.id, tab.messages)
            : null;
        const newAutomationBanner =
          automationBanner &&
          !tab.messages.some((message) => message.id === automationBanner.id)
            ? automationBanner
            : null;
        if (archived) {
          const messages = shouldMaterialize
            ? [
                ...tab.messages,
                ...(newAutomationBanner ? [newAutomationBanner] : []),
                materializePickedUpMessage(
                  row,
                  pickedUpAttempt,
                  effectiveEvent,
                ),
              ]
            : tab.messages;
          const archivedTab = {
            ...tab,
            inputDelivery: next,
            messages,
            ...(shouldConsumeInstructions
              ? { pendingSystemInstructions: remaining }
              : {}),
          };
          return [
            {
              type: 'archive.upserted',
              entry: {
                ...archived,
                tab: archivedTab,
                turnCount: messages.filter((message) => message.role === 'user')
                  .length,
              },
            },
          ];
        }
        const mutations: ChatCoreMutation[] = [
          {
            type: 'tab.metadata_patched',
            tabId: target.chatId,
            patch: { inputDelivery: next },
          },
        ];
        if (shouldMaterialize) {
          if (shouldConsumeInstructions) {
            mutations.push({
              type: 'tab.metadata_patched',
              tabId: target.chatId,
              patch: { pendingSystemInstructions: remaining },
            });
          }
          if (newAutomationBanner)
            mutations.push({
              type: 'message.upserted',
              chatId: target.chatId,
              message: newAutomationBanner,
            });
          mutations.push({
            type: 'message.upserted',
            chatId: target.chatId,
            message: materializePickedUpMessage(
              row,
              pickedUpAttempt,
              effectiveEvent,
            ),
          });
          if (acceptsRoot) {
            mutations.push({
              type: 'message.upserted',
              chatId: target.chatId,
              message: {
                id: `${row.id}:timer`,
                // `system` is the turn-timer role every other producer writes,
                // and both display predicates (`reorderMessagesForDisplay`,
                // `groupIntoTurns`) require it. An `assistant` timer is not
                // recognized as one: it never floats to the end of its turn
                // and never closes a turn group, so the pickup rendered as a
                // loose "Working…" row wedged between the steer and its answer.
                role: 'system',
                timestamp: Date.now(),
                blocks: [
                  {
                    type: 'turn_timer',
                    startedAt: Date.now(),
                    completedAt: null,
                  },
                ],
              },
            });
            mutations.push({
              type: 'runtime.patched',
              chatId: target.chatId,
              runtime: {
                status: 'streaming',
                steeringCapabilities: capabilities,
                queuedMessageIds:
                  current.runtimeByChatId[target.chatId]?.queuedMessageIds ??
                  [],
                ...(current.runtimeByChatId[target.chatId]?.queuedMessages
                  ? {
                      queuedMessages:
                        current.runtimeByChatId[target.chatId]?.queuedMessages,
                    }
                  : {}),
                activeTurn: { userMessageId: row.id, startedAt: Date.now() },
                lastActivityAt: Date.now(),
              },
            });
          }
        }
        return mutations;
      },
      {
        source: 'provider',
        mutationId: `input:${event.generation}:${event.attemptId}:${event.phase}`,
        chatIds: [target.chatId],
      },
    );
    if (commit.applied && matched && pickup.row) {
      const source = resolvePresentationSource(
        pickup.row.payload,
        pickup.row.origin === 'portal' ? 'portal' : 'user',
      );
      const handoffsAtSend = this.handoffsByAttempt.get(event.attemptId) ?? [];
      this.handoffsByAttempt.delete(event.attemptId);
      if (source === 'user' || source === 'portal') {
        for (const id of handoffsAtSend) browserHandoffs.release(id);
      }
      if (
        committedEvent.startsTurn &&
        committedEvent.turnRootAccepted !== false
      ) {
        recordPresentationTurn(
          presentationChatKey({
            projectId: target.projectId,
            worktreeId: target.worktreeId,
            chatTabId: target.chatId,
          }),
          pickup.row.id,
          resolvePresentationSource(
            pickup.row.payload,
            pickup.row.origin === 'portal' ? 'portal' : 'user',
          ),
        );
      }
      await this.onPickup(target, pickup.row, committedEvent);
    }
    if (commit.applied && restoredQueuePickup.rowId) {
      const { getChatQueueService } = await import('./chat-queue-service');
      await getChatQueueService().consumeRestoredInput(
        target,
        restoredQueuePickup.rowId,
      );
    }
    if (queueContinuation.row && queueContinuation.epoch !== undefined) {
      await this.restoreQueueContinuation(
        target,
        queueContinuation.row,
        queueContinuation.epoch,
      );
    }
    return commit.applied && matched;
  }

  async capabilities(
    target: Target,
  ): Promise<ChatSteeringCapabilities | undefined> {
    const session = await this.sessionFor(target);
    return session && !session.isDisposed?.()
      ? session.getSteeringCapabilities?.()
      : undefined;
  }

  async recover(target: Target): Promise<void> {
    const session = await this.sessionFor(target);
    const liveGeneration =
      session && !session.isDisposed?.()
        ? session.getSteeringCapabilities?.().generation
        : undefined;
    await this.update(target, (ledger) =>
      restoreInputLedger(ledger, liveGeneration),
    );
  }

  async stop(target: Target, operation: () => Promise<void>): Promise<void> {
    const key = this.key(target);
    this.suspended.set(key, (this.suspended.get(key) ?? 0) + 1);
    try {
      try {
        // Provider cleanup must still run if the session disappears while
        // Stop is taking ownership of the delivery ledger.
        const capabilities = await this.capabilities(target).catch(
          () => undefined,
        );
        await this.update(target, (ledger) => ({
          ...ledger,
          epoch: ledger.epoch + 1,
          rows: ledger.rows.map((row) => {
            const attempt = row.attempts.find(
              (candidate) => candidate.id === row.currentAttemptId,
            );
            if (
              row.state === 'pending' &&
              capabilities?.withdraw === false &&
              attempt?.admittedAt !== undefined &&
              attempt.pickedUpAt === undefined
            ) {
              return {
                ...row,
                revision: row.revision + 1,
                state: 'uncertain' as const,
                reason:
                  'The turn was stopped before pickup could be confirmed. This message will not be resent automatically.',
              };
            }
            return row.state === 'editing'
              ? {
                  ...row,
                  revision: row.revision + 1,
                  state: 'cancelled',
                  editResubmits: false,
                }
              : row;
          }),
        }));
      } finally {
        await operation();
      }
    } finally {
      const remaining = (this.suspended.get(key) ?? 1) - 1;
      if (remaining) this.suspended.set(key, remaining);
      else this.suspended.delete(key);
    }
  }

  async action(envelope: ChatCommandEnvelope): Promise<ChatCommandResult> {
    const command = envelope.command;
    if (command.type !== 'chat.input_delivery_action')
      throw new Error('Invalid delivery action');
    const target = {
      projectId: envelope.projectId,
      worktreeId: envelope.worktreeId,
      chatId: command.chatId,
    };
    const actionKey = `${this.key(target)}:${command.rowId}`;
    if (this.activeActions.has(actionKey) || this.isSuspended(target))
      throw new Error('Another message action is in progress');
    this.activeActions.add(actionKey);
    try {
      const tab = await this.tab(target);
      const ledger = tab.inputDelivery;
      if (!isInputLedger(ledger))
        throw new Error('Message history is unavailable');
      let row = ledger.rows.find((r) => r.id === command.rowId);
      const resumesInterruptedQueue =
        command.action === 'queue' &&
        row?.state === 'cancelled' &&
        row.queueIntent?.commandId === envelope.commandId;
      if (
        !row ||
        (row.revision !== command.rowRevision && !resumesInterruptedQueue)
      )
        throw new Error(
          'The message changed. Review its current status before trying again.',
        );
      if (row.dismissedAt !== undefined)
        throw new Error(
          'This action is unavailable for the current message status',
        );
      const epoch = ledger.epoch;
      let actionRevision = row.revision;
      if (
        row.payload.projectId !== target.projectId ||
        row.payload.worktreeId !== target.worktreeId ||
        row.payload.chatId !== target.chatId ||
        row.payload.userMessageId !== row.id
      )
        throw new Error('This message belongs to another chat');
      const session =
        command.action === 'dismiss'
          ? undefined
          : await this.sessionFor(target);
      const receipt: Receipt = {
        commandId: envelope.commandId,
        outcome: 'applied',
        entityId: command.rowId,
      };
      let receiptCommitted = false;
      const replace = async (
        change: (
          r: InputRow,
          rootUserMessageId: string | undefined,
        ) => InputRow,
        commandReceipt?: Receipt,
      ): Promise<void> => {
        await this.update(
          target,
          (current, _tab, rootUserMessageId) => {
            if (current.epoch !== epoch || this.isSuspended(target))
              throw new Error(
                'Stop or Interrupt superseded this message action',
              );
            const currentRow = current.rows.find((r) => r.id === command.rowId);
            if (!currentRow || currentRow.revision !== actionRevision)
              throw new Error(
                'The message changed before this action could complete',
              );
            actionRevision++;
            return {
              ...current,
              rows: current.rows.map((r) =>
                r.id === command.rowId
                  ? {
                      ...change(r, rootUserMessageId),
                      revision: r.revision + 1,
                    }
                  : r,
              ),
            };
          },
          commandReceipt,
        );
      };
      if (command.action === 'dismiss' && row.state === 'uncertain') {
        await replace((r) => ({ ...r, dismissedAt: Date.now() }), receipt);
      } else if (
        ['cancel', 'queue', 'edit'].includes(command.action) &&
        (row.state === 'pending' ||
          (command.action === 'queue' && row.state === 'cancelling'))
      ) {
        const attempt = row.attempts.find(
          (a) => a.id === row?.currentAttemptId,
        );
        const caps = session?.getSteeringCapabilities?.();
        if (
          !attempt ||
          !session?.withdrawSteeringInput ||
          !caps?.withdraw ||
          caps.generation !== attempt.generation
        )
          throw new Error('This session cannot safely withdraw the message');
        if (row.state === 'pending') {
          const commitBeforeWithdrawal = command.action !== 'queue';
          await replace(
            (r) => ({
              ...r,
              state: 'cancelling',
              ...(command.action === 'queue'
                ? {
                    queueIntent: {
                      commandId: envelope.commandId,
                      epoch,
                    },
                  }
                : {}),
            }),
            commitBeforeWithdrawal ? receipt : undefined,
          );
          receiptCommitted = commitBeforeWithdrawal;
        }
        const outcome = await session.withdrawSteeringInput(attempt.id);
        if (outcome.kind !== 'withdrawn') {
          await this.observe(target, {
            type: 'canopy_input_delivery',
            provider: attempt.provider,
            generation: attempt.generation,
            attemptId: attempt.id,
            phase: outcome.kind === 'picked-up' ? 'picked-up' : 'unknown',
          });
          if (!receiptCommitted) {
            const observed = (await this.tab(target)).inputDelivery?.rows.find(
              (candidate) => candidate.id === command.rowId,
            );
            if (observed) actionRevision = observed.revision;
            await this.update(
              target,
              (current) => ({
                ...current,
                rows: current.rows.map((candidate) =>
                  candidate.id === command.rowId
                    ? {
                        ...candidate,
                        revision: candidate.revision + 1,
                        queueIntent: undefined,
                      }
                    : candidate,
                ),
              }),
              receipt,
            );
          }
          return {
            commandId: envelope.commandId,
            revision: await this.repository.getRevision(target),
            outcome: 'applied',
          };
        }
        await this.observe(target, {
          type: 'canopy_input_delivery',
          provider: attempt.provider,
          generation: attempt.generation,
          attemptId: attempt.id,
          phase: 'withdrawn',
        });
        if (command.action === 'queue') {
          const observedLedger = (await this.tab(target)).inputDelivery;
          const observedRow = isInputLedger(observedLedger)
            ? observedLedger.rows.find(
                (candidate) => candidate.id === command.rowId,
              )
            : undefined;
          if (observedRow?.state === 'cancelled' && observedRow.queueIntent) {
            await this.restoreQueueContinuation(
              target,
              observedRow,
              observedRow.queueIntent.epoch ?? observedLedger?.epoch ?? epoch,
            );
          }
        }
        // Lazy by design: the queue service constructs this coordinator, so a
        // static reverse import would create an initialization cycle. The
        // packaged Electron main build exercises this local import path.
        const { getChatQueueService } = await import('./chat-queue-service');
        getChatQueueService().releaseInputOwnership(target);
        const current = (await this.tab(target)).inputDelivery;
        row = current?.rows.find((r) => r.id === command.rowId);
        if (row) actionRevision = row.revision;
        if (command.action === 'queue' && row?.state === 'queued')
          receiptCommitted = true;
        else if (!row || row.state !== 'cancelled')
          throw new Error('Withdrawal was superseded by provider pickup');
        if (command.action === 'edit')
          await replace((r) => ({
            ...r,
            state: 'editing',
            draft: r.text,
            editResubmits: true,
          }));
      } else if (command.action === 'edit' && row.state === 'cancelled') {
        await replace(
          (r) => ({
            ...r,
            state: 'editing',
            draft: r.draft ?? r.text,
            editResubmits: false,
          }),
          receipt,
        );
      } else if (command.action === 'close-editor' && row.state === 'editing') {
        await replace(
          (r) => ({
            ...r,
            state: 'cancelled',
            draft: command.text ?? r.draft,
            editResubmits: false,
          }),
          receipt,
        );
      } else if (command.action === 'save-draft' && row.state === 'editing') {
        await replace(
          (r) => ({ ...r, draft: command.text ?? r.draft }),
          receipt,
        );
      } else if (
        command.action === 'save' &&
        row.state === 'editing' &&
        !row.editResubmits
      ) {
        await replace(
          (r) => ({
            ...r,
            state: 'cancelled',
            text: command.text ?? r.draft ?? r.text,
            payload: { ...r.payload, text: command.text ?? r.draft ?? r.text },
            draft: undefined,
          }),
          receipt,
        );
      } else if (
        !(
          ['resend', 'resend-original', 'save', 'queue'].includes(
            command.action,
          ) && ['cancelled', 'editing'].includes(row.state)
        )
      ) {
        throw new Error(
          'This action is unavailable for the current message status',
        );
      }
      if (command.action === 'queue' && !receiptCommitted) {
        const queuedRequest = {
          ...row.payload,
          text: row.draft ?? row.text,
        };
        await this.prepare(queuedRequest, session);
        // Host queue insertion is handled through its canonical persistence hook.
        // Keep the reverse queue import lazy to avoid the coordinator/queue
        // initialization cycle; the packaged Electron main build covers it.
        const { getChatQueueService } = await import('./chat-queue-service');
        await getChatQueueService().restoreWithdrawnInput(
          queuedRequest,
          command.rowId,
          receiptCommitted ? undefined : receipt,
          epoch,
          row.origin,
        );
      } else if (
        command.action === 'resend' ||
        command.action === 'resend-original' ||
        (command.action === 'save' && row.editResubmits)
      ) {
        const latest = await this.tab(target);
        if (inputSettingsKey(latest) !== row.settingsKey)
          throw new Error(
            'Chat settings changed. The message is retained; use Queue to send it with its saved settings.',
          );
        const request = {
          ...row.payload,
          text:
            command.action === 'resend-original'
              ? row.text
              : (command.text ?? row.draft ?? row.text),
        };
        const workOwner = await resolveAiCreditsScopeOwner({
          kind: 'work',
          projectId: target.projectId,
          worktreeId: target.worktreeId,
          chatId: target.chatId,
        });
        if (
          await isModelBlockedByStoredPolicy(
            request.model ?? latest.model,
            workOwner,
          )
        )
          throw new Error('This model is blocked by your organization policy.');
        await this.authorize({ ...target, tab: latest });
        const text = await this.prepare(request, session);
        if (
          !session?.getSteeringCapabilities?.().steer ||
          session.isDisposed?.()
        ) {
          const runtime = (await this.repository.getState(target))
            .runtimeByChatId[target.chatId];
          if (
            runtime &&
            ['starting', 'streaming', 'awaiting_input', 'completing'].includes(
              runtime.status,
            )
          )
            throw new Error(
              'The active session cannot accept this message. Use Queue.',
            );
          // Queue ownership transfer and drain use the same atomic persistence
          // path as Move to queued, including when the chat is already idle.
          // Keep the reverse queue import lazy to avoid the coordinator/queue
          // initialization cycle; the packaged Electron main build covers it.
          const { getChatQueueService } = await import('./chat-queue-service');
          await getChatQueueService().restoreWithdrawnInput(
            request,
            command.rowId,
            receipt,
            epoch,
            row.origin,
          );
        } else {
          const caps = session.getSteeringCapabilities();
          const attemptId = randomUUID();
          await replace(
            (r, rootUserMessageId) => ({
              ...r,
              state: 'sending',
              text: request.text,
              payload: request,
              draft: undefined,
              queueIntent: undefined,
              currentAttemptId: attemptId,
              attempts: [
                ...r.attempts,
                {
                  id: attemptId,
                  generation: caps.generation,
                  provider: caps.provider,
                  createdAt: Date.now(),
                  submittedText: text,
                  displayText: request.text,
                  payloadSnapshot: structuredClone(request),
                  rootUserMessageId,
                },
              ],
            }),
            receipt,
          );
          await this.submit(
            target,
            session,
            command.rowId,
            attemptId,
            epoch,
            text,
          );
        }
      }
      return {
        commandId: envelope.commandId,
        revision: await this.repository.getRevision(target),
        outcome: 'applied',
        entityId: command.rowId,
      };
    } finally {
      this.activeActions.delete(actionKey);
    }
  }
}
