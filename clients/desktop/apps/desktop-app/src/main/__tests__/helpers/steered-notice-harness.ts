/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatQueueTarget,
  ChatQueueUpdatedEvent,
  ChatSendMessageRequest,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import {
  CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
  initClaudeModels,
  initModelAliases,
  initModelHarnessAssignments,
  initOllamaModels,
} from '@canopy/desktop-shared/types';
import type {
  ChatInputAdmission,
  ChatInputDeliveryEvent,
  ChatSteeringCapabilities,
} from '@canopy/protocol/portal';
import type { AgentSession } from '../../agents/types';
import { drainCurrentSessionEvents } from '../../agents/session-event-router';
import { installDelegationLifecycle } from '../../agents/delegation/lifecycle';
import { subscribeSteeringEligibility } from '../../agents/steering-eligibility-events';
import type { ChatQueueServiceDependencies } from '../../services/chat-queue-service';
import { ChatQueueService } from '../../services/chat-queue-service';
import {
  ChatStateService,
  resetChatStateServiceForTests,
} from '../../services/chat-state-service';
import { ChatStateV2Repository } from '../../services/chat-state-v2-repository';
import { getChatTurnOwnership } from '../../services/chat-turn-ownership';
import type { ChatScopeKey } from '../../services/chat-state-contracts';
import type { DispatchWorktreeChatTurnOptions } from '../../lib/worktree-chat-turn';
import { dispatchWorktreeChatTurn } from '../../lib/worktree-chat-turn';
import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import type { TurnEnded, TurnStarted } from '@canopy/protocol/canopy-core';
import {
  flushTurnState,
  turnEnded,
  turnStarted,
} from './turn-lifecycle-events';

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const CHAT_ID = 'chat-1';
const MODEL = 'claude-sonnet-4-6';
const FIXED_NOW = 1_792_000_000_000;

export interface FakeSteeringAttempt {
  text: string;
  attemptId: string;
  rowId: string;
}

interface SentMessage {
  text: string;
  userMessageId?: string;
}

interface ScheduledTask {
  handle: ReturnType<typeof setTimeout>;
  callback: () => void;
  delayMs: number;
  ran: boolean;
}

/** Queue timers are held until the test flushes them, preserving event order. */
class ControlledQueueScheduler {
  private readonly tasks: ScheduledTask[] = [];

  public schedule(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> {
    // The queue receives a real handle, so its clearTimeout calls still cancel
    // work. The placeholder itself never invokes the scheduled callback.
    const handle = setTimeout(() => undefined, 60_000);
    this.tasks.push({ handle, callback, delayMs, ran: false });
    return handle;
  }

  public flushDue(): number {
    let count = 0;
    for (const task of this.tasks) {
      if (task.ran || task.delayMs > 0 || !task.handle.hasRef()) continue;
      task.ran = true;
      clearTimeout(task.handle);
      task.callback();
      count += 1;
    }
    return count;
  }

  public clearAll(): void {
    for (const task of this.tasks) {
      if (!task.ran) clearTimeout(task.handle);
      task.ran = true;
    }
  }

  public pendingDueCount(): number {
    return this.tasks.filter(
      (task) => !task.ran && task.delayMs <= 0 && task.handle.hasRef(),
    ).length;
  }
}

/** A controllable Claude transport that routes every event through main. */
export class FakeClaudeSession implements AgentSession {
  public readonly steeringAttempts: FakeSteeringAttempt[] = [];
  public readonly sentMessages: SentMessage[] = [];
  public isForeground = false;
  public activeRoot: string | undefined;

  /** Where the session reports turn lifecycle, as the Claude adapter does. */
  public lifecycle: ((event: TurnStarted | TurnEnded) => void) | undefined;

  private onEvent: ((data: unknown) => void | Promise<void>) | undefined;
  private disposed = false;
  private lifecycleSequence = 0;
  /** The root whose start this session reported and hasn't ended. */
  private reportedRoot: string | undefined;

  public attach(onEvent: (data: unknown) => void | Promise<void>): void {
    this.onEvent = onEvent;
  }

  private reportTurn(type: 'start' | 'end', rootId: string): void {
    // Like the adapter: a turn opens with its first frame when none runs, and
    // an end only closes the turn the session is running.
    if (
      type === 'start'
        ? this.reportedRoot !== undefined
        : this.reportedRoot !== rootId
    )
      return;
    this.reportedRoot = type === 'start' ? rootId : undefined;
    const fields = {
      sequence: ++this.lifecycleSequence,
      // Named so each turn's canonical timer is `<row>:timer`.
      turnId: rootId,
      atMs: FIXED_NOW,
      userMessageIds: [rootId],
    };
    const chat = {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
    };
    this.lifecycle?.(
      type === 'start'
        ? turnStarted(chat, fields)
        : turnEnded(chat, {
            ...fields,
            ...(this.disposed || !this.isForeground
              ? { outcome: 'cancelled', source: 'abort-fallback' }
              : {}),
          }),
    );
  }

  private endActiveTurn(): void {
    if (this.reportedRoot !== undefined)
      this.reportTurn('end', this.reportedRoot);
  }

  public reset(): void {
    this.steeringAttempts.length = 0;
    this.sentMessages.length = 0;
    this.isForeground = false;
    this.activeRoot = undefined;
    this.reportedRoot = undefined;
    this.disposed = false;
    this.onEvent = undefined;
  }

  public sendMessage(text: string, options?: { userMessageId?: string }): void {
    this.sentMessages.push({
      text,
      ...(options?.userMessageId
        ? { userMessageId: options.userMessageId }
        : {}),
    });
    this.isForeground = true;
    this.activeRoot = options?.userMessageId;
    if (this.activeRoot !== undefined)
      this.reportTurn('start', this.activeRoot);
  }

  public getSteeringCapabilities(): ChatSteeringCapabilities {
    return {
      provider: 'claude',
      generation: 'g1',
      steer: true,
      withdraw: true,
      interrupt: true,
    };
  }

  public submitSteeringInput(
    text: string,
    attemptId: string,
    clientUserMessageId: string,
  ): Promise<ChatInputAdmission> {
    this.steeringAttempts.push({
      text,
      attemptId,
      rowId: clientUserMessageId,
    });
    return Promise.resolve({ kind: 'accepted', attemptId });
  }

  public async emitAssistant(rootId: string, text: string): Promise<void> {
    this.reportTurn('start', rootId);
    await this.emit({
      type: 'assistant',
      message: {
        id: `assistant-${rootId}`,
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
      canopy_turn_user_message_id: rootId,
    });
  }

  public async emitToolUse(rootId: string, toolUseId: string): Promise<void> {
    this.reportTurn('start', rootId);
    await this.emit({
      type: 'assistant',
      message: {
        id: `tool-use-${toolUseId}`,
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'Read',
            input: { file_path: `/fixture/${toolUseId}.txt` },
          },
        ],
      },
      canopy_turn_user_message_id: rootId,
    });
  }

  public async emitToolResult(
    rootId: string,
    toolUseId: string,
  ): Promise<void> {
    this.reportTurn('start', rootId);
    await this.emit({
      type: 'user',
      message: {
        id: `tool-result-${toolUseId}`,
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: `result for ${toolUseId}`,
            is_error: false,
          },
        ],
      },
      canopy_turn_user_message_id: rootId,
    });
  }

  public async emitResult(rootId: string): Promise<void> {
    // The CLI has ended the turn before main observes its queued terminal. A
    // late result of a superseded root ends nothing the session runs.
    this.reportTurn('start', rootId);
    if (this.reportedRoot === rootId) {
      this.reportTurn('end', rootId);
      this.isForeground = false;
      this.activeRoot = undefined;
    }
    await this.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Turn completed',
      canopy_turn_user_message_id: rootId,
    });
  }

  public async emitPickup(
    attempt: FakeSteeringAttempt,
    options: { startsTurn: boolean },
  ): Promise<void> {
    this.isForeground = options.startsTurn;
    this.activeRoot = options.startsTurn ? attempt.rowId : undefined;
    // The turn's lifecycle opens with its first frame, not the pickup event.
    const event: ChatInputDeliveryEvent = {
      type: 'canopy_input_delivery',
      provider: 'claude',
      generation: 'g1',
      attemptId: attempt.attemptId,
      phase: 'picked-up',
      startsTurn: options.startsTurn,
      userMessageId: attempt.rowId,
    };
    await this.emit(event);
  }

  public setPlanMode(_enabled: boolean): Promise<void> {
    void _enabled;
    return Promise.resolve();
  }

  public setApprovalMode(mode: 'ask' | 'auto' | 'full-access'): Promise<void> {
    this.appliedApprovalMode = mode;
    return Promise.resolve();
  }

  /** Turn-start authority narrows a steer to the mode the session applied. */
  public getAppliedApprovalMode(): 'ask' | 'auto' | 'full-access' {
    return this.appliedApprovalMode;
  }

  private appliedApprovalMode: 'ask' | 'auto' | 'full-access' = 'ask';

  public setThinkingLevel(_level: string): Promise<void> {
    void _level;
    return Promise.resolve();
  }

  public setModel(_model: string): Promise<void> {
    void _model;
    return Promise.resolve();
  }

  public cancel(): Promise<void> {
    this.isForeground = false;
    this.endActiveTurn();
    this.activeRoot = undefined;
    return Promise.resolve();
  }

  public destroy(): Promise<void> {
    this.disposed = true;
    this.isForeground = false;
    this.endActiveTurn();
    this.activeRoot = undefined;
    return Promise.resolve();
  }

  public isDisposed(): boolean {
    return this.disposed;
  }

  public getProviderSessionId(): string {
    return 'fake-claude-session';
  }

  private async emit(data: unknown): Promise<void> {
    if (!this.onEvent) throw new Error('Fake Claude session is not routed yet');
    await this.onEvent(data);
  }
}

export interface QueueRuntimeWrite {
  turnActive: boolean;
  activeTurnUserMessageId?: string;
  queuedMessageIds: readonly string[];
}

export class SteeredNoticeHarness {
  public readonly scope: ChatScopeKey = {
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
  };

  public readonly target: ChatQueueTarget = {
    ...this.scope,
    chatId: CHAT_ID,
  };

  public readonly queueRuntimeWrites: QueueRuntimeWrite[] = [];
  public readonly dispatchedRequests: ChatSendMessageRequest[] = [];

  public readonly service: ChatStateService;
  public readonly queue: ChatQueueService;
  public readonly fakeSession: FakeClaudeSession;

  private readonly tempDir: string;
  private readonly repository: ChatStateV2Repository;
  private readonly scheduler = new ControlledQueueScheduler();
  private readonly pendingHostPersists = new Set<Promise<void>>();
  private readonly pendingDispatches = new Set<Promise<void>>();
  private readonly unsubscribeSteering: () => void;
  private nextId = 1;
  private disposed = false;

  private constructor(fakeSession: FakeClaudeSession) {
    this.fakeSession = fakeSession;
    this.tempDir = mkdtempSync(join(tmpdir(), 'canopy-steered-notice-'));
    const paths = {
      tabs: join(this.tempDir, 'chats.json'),
      archives: join(this.tempDir, 'archives.json'),
      journal: join(this.tempDir, 'journal.jsonl'),
    };
    this.repository = new ChatStateV2Repository({
      resolvePaths: () => paths,
    });
    this.service = new ChatStateService({
      repository: this.repository,
      now: () => FIXED_NOW,
      createId: () => this.createId(),
      inputSession: async () => this.fakeSession,
      onInputPickup: async () => undefined,
      authorizeSend: async () => undefined,
      cleanupSession: async () => undefined,
      recordDiagnostic: () => undefined,
    });
    getChatTurnOwnership().resetScopesForTests();
    resetChatStateServiceForTests(this.service);
    fakeSession.lifecycle = (event) => this.service.observeTurnLifecycle(event);

    const dependencies: ChatQueueServiceDependencies = {
      steerGenerated: (
        request,
        origin,
        queuedIds,
        allowSteering,
        canSteerNow,
        claimed,
      ) =>
        this.service.inputDelivery.steerGenerated(
          request,
          queuedIds,
          origin,
          allowSteering,
          canSteerNow,
          claimed,
        ),
      steerQueuedGenerated: (
        request,
        origin,
        queuedIds,
        canSteerNow,
        claimed,
      ) =>
        this.service.inputDelivery.steerQueuedGenerated(
          request,
          queuedIds,
          origin,
          canSteerNow,
          claimed,
        ),
      dispatch: (request, origin, _fromQueue) => {
        void _fromQueue;
        return this.trackDispatch(request, origin);
      },
      beginTurnPreparation: () => ({
        cancelled: false,
        finish: () => undefined,
      }),
      cancel: async () => undefined,
      settleCancelledTurn: () => undefined,
      hasActiveProviderTurn: () => this.fakeSession.isForeground,
      getActiveProviderPluginSelections: () => normalizePluginSelections({}),
      getActiveProviderPluginDefaultsRevision: () => 0,
      getCurrentPluginDefaultsRevision: () => 0,
      drainProviderEvents: (target) => drainCurrentSessionEvents(target),
      hasBackgroundWork: () => false,
      hasPendingProviderContinuation: () => false,
      hasPendingUserDecision: () => false,
      persistRuntime: (
        target,
        queuedMessageIds,
        turnActive,
        mutation,
        queuedMessages,
        activeTurnUserMessageId,
        inFlight,
      ) => {
        this.queueRuntimeWrites.push({
          turnActive,
          ...(activeTurnUserMessageId ? { activeTurnUserMessageId } : {}),
          queuedMessageIds: [...queuedMessageIds],
        });
        const persistence = this.service.reconcileHostQueue(
          target,
          queuedMessageIds,
          turnActive,
          mutation,
          queuedMessages,
          activeTurnUserMessageId,
          inFlight,
        );
        this.pendingHostPersists.add(persistence);
        void persistence.then(
          () => this.pendingHostPersists.delete(persistence),
          () => this.pendingHostPersists.delete(persistence),
        );
        return persistence;
      },
      hasCommittedMessage: (target, userMessageId) =>
        this.service.hasTranscriptMessage(target, target.chatId, userMessageId),
      isCanonicalTurnOpen: (target, turnUserMessageId) =>
        this.service.isTurnOpen(target, target.chatId, turnUserMessageId),
      broadcast: () => undefined,
      createId: () => this.createId(),
      now: () => FIXED_NOW,
      schedule: (callback, delayMs) =>
        this.scheduler.schedule(callback, delayMs),
    };
    this.queue = new ChatQueueService(dependencies);
    this.unsubscribeSteering = subscribeSteeringEligibility((sessionKey) => {
      this.queue.notifySteeringEligibility(sessionKey);
    });
  }

  public static async create(
    fakeSession: FakeClaudeSession,
  ): Promise<SteeredNoticeHarness> {
    initClaudeModels([
      { id: 'opus[1m]', label: 'Opus 1M' },
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    ]);
    initOllamaModels([]);
    initModelAliases({ 'claude-sonnet-4-6': 'sonnet' });
    initModelHarnessAssignments({ revision: 0, assignments: [] });
    const harness = new SteeredNoticeHarness(fakeSession);
    await harness.service.command({
      schemaVersion: 1,
      commandId: 'create-chat',
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      command: {
        type: 'chat.create_tab',
        tabId: CHAT_ID,
        title: 'Steered notice integration',
        providerType: 'claude',
        model: MODEL,
      },
    });
    installDelegationLifecycle({
      shutdown: async () => undefined,
      revoke: async () => undefined,
      closeScope: async (_target) => {
        void _target;
      },
      isDeliveryActive: (_target, deliveryId) =>
        harness.activeDelegationDeliveries.has(deliveryId),
      claimDelivery: (_target, deliveryId) =>
        harness.activeDelegationDeliveries.has(deliveryId),
      releaseDelivery: () => undefined,
      retireDelivery: (_target, deliveryId) => {
        harness.activeDelegationDeliveries.delete(deliveryId);
      },
    });
    return harness;
  }

  private readonly activeDelegationDeliveries = new Set<string>();

  public async startRootTurn(userMessageId: string): Promise<void> {
    await this.queue.submit(
      this.request(userMessageId, `Root prompt ${userMessageId}`),
      'desktop',
    );
  }

  public async submitNotice(
    kind: 'watcher' | 'delegation',
    userMessageId: string,
  ): Promise<void> {
    if (kind === 'watcher') {
      await this.queue.submit(
        {
          ...this.request(userMessageId, `Watcher notice ${userMessageId}`),
          initiationSource: 'automation',
          watcherFired: { kind: 'Command completed' },
          hiddenContext: {
            kind: 'canopy-watcher-event',
            text: 'A command completed in the watched workspace.',
          },
        },
        'desktop',
      );
      return;
    }
    this.activeDelegationDeliveries.add(userMessageId);
    await this.queue.submit(
      {
        ...this.request(userMessageId, `Delegation request ${userMessageId}`),
        initiationSource: 'automation',
        managedDelegationDeliveryId: userMessageId,
        internalRow: {
          kind: 'delegation-request',
          delegationId: 'delegation-1',
          displayLine: 'A delegated agent needs a response.',
        },
      },
      'desktop',
    );
  }

  public async submitOrdinary(userMessageId: string): Promise<void> {
    await this.queue.submit(
      this.request(userMessageId, `Typed prompt ${userMessageId}`),
      'desktop',
    );
  }

  public async steerQueued(
    expectedRowIds: readonly string[] = ['watcher-1', 'delegation-1'],
  ): Promise<FakeSteeringAttempt[]> {
    this.queue.notifySteeringEligibility(
      `${PROJECT_ID}/${WORKTREE_ID}/${CHAT_ID}`,
    );
    for (let pass = 0; pass < 100; pass += 1) {
      this.scheduler.flushDue();
      await this.flushTurnEvents();
      const rows = await this.deliveryRows();
      if (
        expectedRowIds.every((rowId) =>
          rows.some((row) => row.id === rowId && row.attempts.length > 0),
        )
      ) {
        return [...this.fakeSession.steeringAttempts];
      }
    }
    throw new Error(
      `Generated queue rows did not receive ledger-backed attempts: ${JSON.stringify(
        await this.deliveryRows(),
      )}`,
    );
  }

  public async pickup(userMessageId: string): Promise<void> {
    const attempt = this.fakeSession.steeringAttempts.find(
      (candidate) => candidate.rowId === userMessageId,
    );
    if (!attempt)
      throw new Error(`No captured steering attempt for ${userMessageId}`);
    await this.fakeSession.emitPickup(attempt, { startsTurn: true });
  }

  public async runNoticeTurn(userMessageId: string): Promise<void> {
    await this.pickup(userMessageId);
    await this.emitNoticeOutput(userMessageId);
  }

  public async emitNoticeOutput(userMessageId: string): Promise<void> {
    await this.fakeSession.emitAssistant(
      userMessageId,
      `${userMessageId} assistant output`,
    );
    await this.fakeSession.emitToolUse(userMessageId, `${userMessageId}-tool`);
    await this.fakeSession.emitToolResult(
      userMessageId,
      `${userMessageId}-tool`,
    );
    await this.fakeSession.emitResult(userMessageId);
  }

  /**
   * Mirror the ordinary Stop ownership sequence for focused race tests:
   * cancelChatTurn invalidates queue work before inputDelivery.stop suspends
   * and increments the ledger epoch while cancelling/draining the session;
   * stopChatTurn then applies the untagged cancelled terminal and canonical
   * cancellation result. The optional hook pauses inside provider cleanup,
   * after the epoch is advanced. The real IPC and session recreation are not
   * exercised by this fixture.
   */
  public async stopTurn(
    duringProviderCleanup: () => Promise<void> = async () => undefined,
  ): Promise<void> {
    this.queue.invalidatePendingInputOperations(this.target);
    await this.service.inputDelivery.stop(this.target, async () => {
      await this.fakeSession.cancel();
      await duringProviderCleanup();
      await drainCurrentSessionEvents(this.target);
    });
    this.queue.onTurnTerminal(this.target, 'cancelled');
    await this.service.ingestProviderEvent({
      ...this.scope,
      chatId: CHAT_ID,
      mutationId: `${CHAT_ID}:manual-stop:${this.createId()}`,
      data: {
        type: 'result',
        is_error: false,
        result: 'Cancelled',
      },
    });
    await this.flushTurnEvents();
  }

  public async readTranscript(): Promise<PersistedChatMessage[]> {
    const state = await this.service.getState(this.scope);
    return (
      state.tabsFile.tabs.find((tab) => tab.id === CHAT_ID)?.messages ?? []
    );
  }

  public async readRuntime(): Promise<
    Awaited<ReturnType<ChatStateService['getState']>>['runtimeByChatId'][string]
  > {
    const state = await this.service.getState(this.scope);
    return state.runtimeByChatId[CHAT_ID];
  }

  public async queueState(): Promise<{
    isTurnActive: boolean;
    snapshots: ChatQueueUpdatedEvent[];
    runtime: Awaited<ReturnType<SteeredNoticeHarness['readRuntime']>>;
  }> {
    return {
      isTurnActive: this.queue.isTurnActive(this.target),
      snapshots: this.queue.getWorktreeSnapshots(PROJECT_ID, WORKTREE_ID),
      runtime: await this.readRuntime(),
    };
  }

  public dispatchedIds(): string[] {
    return this.dispatchedRequests.map((request) => request.userMessageId);
  }

  public async waitForGateRelease(): Promise<void> {
    for (let pass = 0; pass < 100; pass += 1) {
      await this.flushTurnEvents();
      if (!this.queue.isTurnActive(this.target)) return;
    }
    throw new Error('The host queue gate did not release after the terminal');
  }

  public async waitForQuiescence(): Promise<void> {
    let previousState = '';
    for (let pass = 0; pass < 100; pass += 1) {
      await Promise.allSettled([...this.pendingDispatches]);
      await this.flushTurnEvents();
      const ranScheduled = this.scheduler.flushDue();
      await this.flushTurnEvents();
      const runtime = await this.readRuntime();
      const state = JSON.stringify({
        dispatched: this.dispatchedIds(),
        sent: this.fakeSession.sentMessages,
        attempts: this.fakeSession.steeringAttempts,
        status: runtime?.status,
        activeTurn: runtime?.activeTurn,
        pendingDue: this.scheduler.pendingDueCount(),
      });
      if (
        state === previousState &&
        ranScheduled === 0 &&
        this.scheduler.pendingDueCount() === 0
      ) {
        return;
      }
      previousState = state;
    }
    throw new Error('The steered-notice harness did not reach quiescence');
  }

  /**
   * Cleanup follows the epoch/ledger Stop seam. TODO for a Stop-specific
   * scenario: mirror cancelChatTurn's session-recreation and IPC terminal
   * settlement as well as this fake-session cancellation.
   */
  public async stop(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.invalidatePendingInputOperations(this.target);
    const activeRoot = this.fakeSession.activeRoot;
    await this.service.inputDelivery.stop(this.target, async () => {
      await this.fakeSession.cancel();
      // A cleanup-only terminal lets the real routed turn closure release its
      // event barriers before Jest tears the test environment down.
      if (activeRoot) await this.fakeSession.emitResult(activeRoot);
      await drainCurrentSessionEvents(this.target);
    });
    this.queue.onTurnTerminal(this.target, 'cancelled', activeRoot);
    this.scheduler.clearAll();
    await this.flushTurnEvents();
    await Promise.allSettled([...this.pendingDispatches]);
    await this.waitForHostPersists();
  }

  public async dispose(): Promise<void> {
    await this.stop();
    this.unsubscribeSteering();
    this.scheduler.clearAll();
    await this.waitForHostPersists();
    await this.repository.drainAll();
    resetChatStateServiceForTests();
    installDelegationLifecycle({
      shutdown: async () => undefined,
      revoke: async () => undefined,
      closeScope: async () => undefined,
      isDeliveryActive: () => false,
      claimDelivery: () => false,
      releaseDelivery: () => undefined,
      retireDelivery: () => undefined,
    });
    rmSync(this.tempDir, { recursive: true, force: true });
  }

  private request(userMessageId: string, text: string): ChatSendMessageRequest {
    return {
      ...this.target,
      userMessageId,
      text,
      providerType: 'claude',
      executionHarness: 'claude',
      model: MODEL,
      initiationSource: 'user',
    };
  }

  private async deliveryRows() {
    const state = await this.service.getState(this.scope);
    const tab = state.tabsFile.tabs.find(
      (candidate) => candidate.id === CHAT_ID,
    );
    return tab?.inputDelivery?.rows ?? [];
  }

  private async dispatchWorktreeRequest(
    request: ChatSendMessageRequest,
    origin: 'desktop' | 'portal',
  ): Promise<void> {
    void origin;
    this.dispatchedRequests.push(request);
    const hidden = request.internalRow !== undefined;
    const userMessage: PersistedChatMessage = {
      id: request.userMessageId,
      role: 'user',
      ...(hidden ? { hidden: true } : {}),
      timestamp: FIXED_NOW,
      blocks: [{ type: 'text', text: request.text }],
      inputMode: request.inputMode ?? 'typed',
      ...(request.watcherFired !== undefined
        ? { watcherFired: request.watcherFired }
        : {}),
    };
    await this.service.ingestProviderEvent({
      ...this.scope,
      chatId: CHAT_ID,
      mutationId: `${CHAT_ID}:${request.userMessageId}:user-prompt`,
      providerType: request.providerType ?? 'claude',
      turnUserMessageId: request.userMessageId,
      data: {
        type: 'canopy_user_prompt',
        ...(hidden ? { canopy_hidden: true } : {}),
        original_text: request.text,
        provider: request.providerType ?? 'claude',
        canopy_turn_user_message_id: request.userMessageId,
        canopy_persisted_messages: [userMessage],
      },
    });

    let acceptedPrompt: Promise<boolean> | undefined;
    const dispatchOptions: DispatchWorktreeChatTurnOptions = {
      ...request,
      planMode: false,
      // Branch naming is a non-turn side effect and is intentionally absent
      // from this deterministic integration fixture.
      skipBranchNaming: true,
      getWindow: () => null,
      onTurnAccepted: (): void => {
        acceptedPrompt = this.service.ingestProviderEvent({
          ...this.scope,
          chatId: CHAT_ID,
          mutationId: `${CHAT_ID}:${request.userMessageId}:accepted`,
          providerType: request.providerType ?? 'claude',
          turnUserMessageId: request.userMessageId,
          data: {
            type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
            canopy_turn_user_message_id: request.userMessageId,
          },
        });
      },
      // Mirrors chat-service.ts's production precommit adapter in
      // dispatchLocalWorktreeChatMessageNow (the host-queued dispatcher).
      onBeforeChatEvent: (event) =>
        this.service.ingestProviderEventWithResult({
          projectId: event.projectId,
          worktreeId: event.worktreeId,
          chatId: event.chatId,
          data: event.data,
          mutationId: `${request.chatId}:${request.userMessageId}:provider:${event.sequenceNamespace}:${event.sequence}`,
          ...(request.providerType
            ? { providerType: request.providerType }
            : {}),
          ...(event.turnUserMessageId
            ? { turnUserMessageId: event.turnUserMessageId }
            : {}),
          ...(event.onCommitQueued
            ? { onCommitQueued: event.onCommitQueued }
            : {}),
        }),
    };
    await dispatchWorktreeChatTurn(dispatchOptions);
    if (!acceptedPrompt)
      throw new Error(`Turn ${request.userMessageId} was never accepted`);
    await acceptedPrompt;
  }

  private async trackDispatch(
    request: ChatSendMessageRequest,
    origin: 'desktop' | 'portal',
  ): Promise<void> {
    const dispatch = this.dispatchWorktreeRequest(request, origin);
    this.pendingDispatches.add(dispatch);
    try {
      await dispatch;
    } finally {
      this.pendingDispatches.delete(dispatch);
    }
  }

  private createId(): string {
    const id = `harness-${this.nextId}`;
    this.nextId += 1;
    return id;
  }

  private async flushTurnEvents(): Promise<void> {
    await drainCurrentSessionEvents(this.target);
    // Commit observed lifecycle, as the handoff's fallback timer would.
    await flushTurnState(this.service);
    for (let pass = 0; pass < 4; pass += 1) await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  private async waitForHostPersists(): Promise<void> {
    for (
      let pass = 0;
      pass < 100 && this.pendingHostPersists.size > 0;
      pass += 1
    ) {
      await Promise.allSettled([...this.pendingHostPersists]);
      await Promise.resolve();
    }
  }
}

export async function createSteeredNoticeHarness(
  fakeSession: FakeClaudeSession,
): Promise<SteeredNoticeHarness> {
  return SteeredNoticeHarness.create(fakeSession);
}
