import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  serializeWorkspaceContext,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';
import type {
  ForeignActivityProjection,
  ForeignActivityStopRequest,
  ForeignActivityTarget,
} from '@canopy/protocol/foreign-activity';
import { getFeatureFlagService } from '../feature-flags';
import { getDataDir } from '../lib/paths';
import { writeFileAtomically } from '../lib/atomic-file';
import {
  readCanopyCloudAccountWithStatus,
  subscribeCanopyCloudAccountChanges,
} from '../lib/canopy-cloud-account-store';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { readWorkspaceConfigDetailed } from '../lib/workspace-persistence';
import { readWorkspaceIndexEntry } from '../lib/sidebar-items';
import {
  ForeignActivityLedger,
  type ForeignActivityOperation,
  type ForeignActivitySourceEvent,
} from './foreign-activity-ledger';
import {
  foreignActivitySourceSnapshot,
  publishForeignChatRetryActivity,
  resetForeignActivitySources,
  subscribeForeignActivitySources,
  type ForeignActivitySourceOperation,
  type ForeignActivitySourceUpdate,
} from './foreign-activity-sources';

export const FOREIGN_ACTIVITY_CHANGED_ERROR =
  'Activity changed. Open the project to continue.';
export const FOREIGN_ACTIVITY_INACTIVE_ERROR =
  'This operation is no longer active.';
export const FOREIGN_ACTIVITY_BUSY_ERROR = 'Chat is busy. Try Stop again.';

const operationSchema = z.object({
  source: z.enum(['chat', 'pipeline', 'script']),
  operationId: z.string(),
  workspaceId: z.string(),
  worktreeId: z.string(),
  chatId: z.string().optional(),
  context: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('personal') }),
    z.object({ kind: z.literal('organization'), organizationId: z.string() }),
  ]),
  active: z.boolean(),
  resultToken: z.string().nullable(),
  unreadToken: z.string().nullable(),
});
const fileSchema = z.object({
  version: z.literal(1),
  accountId: z.string(),
  epoch: z.string(),
  entries: z
    .array(
      z.object({
        operation: operationSchema,
        baselineToken: z.string().nullable(),
        state: z.enum([
          'FOREIGN_ACTIVE',
          'FOREIGN_COMPLETED_UNREAD',
          'FOREIGN_COMPLETED_LINGER',
        ]),
        changedAt: z.number().finite(),
        interrupted: z.boolean().optional(),
      }),
    )
    .max(10_000),
});

export function foreignActivityEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
  );
}
function key(operation: ForeignActivitySourceOperation): string {
  return JSON.stringify([
    operation.source,
    operation.workspaceId,
    operation.worktreeId,
    operation.chatId ?? operation.operationId,
  ]);
}
function targetOf(operation: ForeignActivityOperation): ForeignActivityTarget {
  return {
    source: operation.source,
    operationId: operation.operationId,
    workspaceId: operation.workspaceId,
    worktreeId: operation.worktreeId,
    chatId: operation.chatId,
    resultToken: operation.resultToken,
  };
}

/**
 * Serializes source delivery, context switches and device-only persistence.
 * Hydration removes restored entries with absent/malformed workspace ownership
 * or inaccessible current owners. Unreadable configs retain the existing ledger
 * reconciliation behavior: unread results survive; missing active work lingers
 * as Interrupted until authoritative activity arrives or the linger expires.
 */
export class ForeignActivityCarryoverService {
  private readonly operations = new Map<string, ForeignActivityOperation>();
  private readonly names = new Map<string, string>();
  private readonly sourceListeners = new Set<
    (event: ForeignActivitySourceEvent) => void
  >();
  private readonly listeners = new Set<
    (projection: ForeignActivityProjection) => void
  >();
  private readonly disposers: Array<() => void> = [];
  private readonly ledger = new ForeignActivityLedger(
    {
      subscribe: (listener): (() => void) => {
        this.sourceListeners.add(listener);
        return (): void => {
          this.sourceListeners.delete(listener);
        };
      },
      snapshot: (): {
        sequence: number;
        operations: ForeignActivityOperation[];
      } => ({
        sequence: this.ledgerSequence,
        operations: Array.from(this.operations.values()),
      }),
    },
    Date.now,
    randomUUID,
  );
  private sourceSequence = 0;
  // One source update can remove several operations from an unresolvable workspace.
  private ledgerSequence = 0;
  private projectionSequence = 0;
  private generation = 0;
  private accountId = '';
  private enabled = false;
  private closing = false;
  private chain: Promise<void> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  private initialized: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  private enqueue(task: () => Promise<void>): Promise<void> {
    if (this.closing) return this.chain;
    this.chain = this.chain.then(task).catch((): void => {
      /* Observation cannot break execution. */
    });
    return this.chain;
  }
  private filePath(): string {
    return join(getDataDir(), 'foreign-activity-ledger.json');
  }

  initialize(): Promise<void> {
    this.initialized ??= this.start();
    return this.initialized;
  }
  private async start(): Promise<void> {
    this.enabled = foreignActivityEnabled();
    let account = await readCanopyCloudAccountWithStatus({ cache: false });
    if (account.status !== 'ok')
      account = await readCanopyCloudAccountWithStatus({ cache: false });
    if (account.status === 'ok')
      this.accountId = account.entry?.account?.id ?? '';
    this.disposers.push(this.ledger.subscribe((): void => this.publish()));
    this.disposers.push(
      subscribeForeignActivitySources((event): void => {
        if (this.closing) return;
        const generation = this.generation;
        void this.enqueue(async (): Promise<void> => {
          if (generation === this.generation && foreignActivityEnabled())
            await this.accept(event);
        });
      }),
    );
    // Retry banners bypass chat commits. Defer the local import to avoid the
    // retry/session/chat-state initialization cycle, then observe state directly.
    const { subscribeTransientRetryActivity } =
      await import('../lib/transient-error-retry-service');
    this.disposers.push(
      subscribeTransientRetryActivity((...args): void => {
        if (this.closing) return;
        publishForeignChatRetryActivity(...args);
      }),
    );
    this.disposers.push(
      subscribeCanopyCloudAccountChanges((entry): void => {
        if (this.closing) return;
        this.adoptAccount(entry?.account?.id ?? '');
      }),
    );
    this.disposers.push(
      getWorkspaceContextService().subscribe((state): void => {
        if (this.closing) return;
        if (this.accountId === '') this.recoverAccount();
        if (!foreignActivityEnabled()) return;
        if (this.accountId === '') return;
        if (state.reason === 'organizations' || state.reason === 'departed') {
          for (const [key, operation] of Array.from(this.operations)) {
            if (!this.canRetainContext(operation.context)) {
              this.operations.delete(key);
              this.names.delete(operation.workspaceId);
            }
          }
          this.ledger.retainContexts((context): boolean =>
            this.canRetainContext(context),
          );
        }
        if (state.reason !== 'switch' && state.reason !== 'departed') {
          this.publish();
          return;
        }
        // Capture synchronously at the broadcast, before any metadata I/O. Events
        // queued after this callback belong after this authoritative snapshot.
        const snapshot = foreignActivitySourceSnapshot();
        const generation = this.generation;
        void this.enqueue(async (): Promise<void> => {
          if (generation !== this.generation) return;
          await this.loadSnapshot(snapshot);
          if (generation !== this.generation) return;
          this.ledger.switchContext(this.accountId, state.context);
        });
      }),
    );
    this.disposers.push(
      getFeatureFlagService().onSnapshotChanged((): void => {
        if (this.closing) return;
        const enabled = foreignActivityEnabled();
        if (enabled === this.enabled) return;
        this.enabled = enabled;
        this.generation += 1;
        const generation = this.generation;
        if (!enabled) {
          this.operations.clear();
          this.names.clear();
          this.ledger.purge();
          void this.enqueue(async (): Promise<void> => {
            await this.writes;
            await rm(this.filePath(), { force: true });
          });
          return;
        }
        if (this.accountId === '') {
          this.recoverAccount();
          return;
        }
        const snapshot = foreignActivitySourceSnapshot();
        const context = getWorkspaceContextService().getState().context;
        void this.enqueue(async (): Promise<void> => {
          if (generation !== this.generation) return;
          await this.loadSnapshot(snapshot);
          if (generation !== this.generation) return;
          this.ledger.switchContext(this.accountId, context);
        });
      }),
    );
    const snapshot = foreignActivitySourceSnapshot();
    const generation = this.generation;
    await this.enqueue(async (): Promise<void> => {
      if (generation !== this.generation) return;
      if (!foreignActivityEnabled() || !this.accountId) {
        if (!foreignActivityEnabled() || account.status === 'ok') {
          await this.writes;
          await rm(this.filePath(), { force: true });
        }
        return;
      }
      await this.restoreAccountEpoch(generation, snapshot);
    });
  }

  private async restoreAccountEpoch(
    generation: number,
    snapshot: ReturnType<typeof foreignActivitySourceSnapshot>,
  ): Promise<void> {
    if (generation !== this.generation || !foreignActivityEnabled()) return;
    await this.loadSnapshot(snapshot);
    const raw: unknown = await readFile(this.filePath(), 'utf8')
      .then((value): unknown => JSON.parse(value))
      .catch((): null => null);
    if (generation !== this.generation) return;
    const parsed = fileSchema.safeParse(raw);
    const context = getWorkspaceContextService().getState().context;
    if (!parsed.success || parsed.data.accountId !== this.accountId) {
      await this.openAccountEpoch(generation);
      return;
    }
    const retained = parsed.data.entries.filter((entry): boolean =>
      this.canRetainContext(entry.operation.context),
    );
    this.ledger.restore({ ...parsed.data, entries: retained }, context);
    await this.hydrate(
      retained.map((entry): ForeignActivityOperation => entry.operation),
    );
  }

  private adoptAccount(accountId: string): void {
    if (accountId === this.accountId) return;
    this.resetAccount(accountId);
    const generation = this.generation;
    void this.enqueue((): Promise<void> => this.openAccountEpoch(generation));
  }

  private resetAccount(accountId: string): void {
    this.accountId = accountId;
    this.generation += 1;
    resetForeignActivitySources();
    this.operations.clear();
    this.names.clear();
    this.ledger.purge();
  }

  private async openAccountEpoch(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    await this.writes;
    if (generation !== this.generation) return;
    await rm(this.filePath(), { force: true });
    if (generation !== this.generation) return;
    if (this.accountId && foreignActivityEnabled())
      this.ledger.switchContext(
        this.accountId,
        getWorkspaceContextService().getState().context,
      );
  }

  private recoverAccount(): void {
    const generation = this.generation;
    void this.enqueue(async (): Promise<void> => {
      if (generation !== this.generation || this.accountId !== '') return;
      const account = await readCanopyCloudAccountWithStatus({ cache: false });
      if (generation !== this.generation || account.status !== 'ok') return;
      const accountId = account.entry?.account?.id ?? '';
      if (accountId === '') return;
      this.accountId = accountId;
      this.generation += 1;
      await this.restoreAccountEpoch(
        this.generation,
        foreignActivitySourceSnapshot(),
      );
    });
  }

  private canRetainContext(context: WorkspaceContext): boolean {
    return (
      context.kind === 'personal' ||
      getWorkspaceContextService()
        .getState()
        .organizations.some(
          (organization): boolean => organization.id === context.organizationId,
        )
    );
  }

  private async resolveWorkspace(
    workspaceId: string,
  ): Promise<
    | { status: 'ok'; context: WorkspaceContext }
    | { status: 'invalid' | 'unreadable' | 'stale'; context: null }
  > {
    const generation = this.generation;
    const [read, entry] = await Promise.all([
      readWorkspaceConfigDetailed(workspaceId),
      readWorkspaceIndexEntry(workspaceId).catch((): null => null),
    ]);
    if (generation !== this.generation)
      return { status: 'stale', context: null };
    if (read.authority === 'unreadable')
      return { status: 'unreadable', context: null };
    if (read.authority === 'absent' || read.ownerMalformed)
      return { status: 'invalid', context: null };
    const config = read.config;
    this.names.set(workspaceId, entry?.name ?? 'Project');
    return {
      status: 'ok',
      context:
        config.owner?.type === 'organization'
          ? {
              kind: 'organization',
              organizationId: config.owner.organizationId,
            }
          : { kind: 'personal' },
    };
  }
  private async loadSnapshot(
    snapshot: ReturnType<typeof foreignActivitySourceSnapshot>,
  ): Promise<void> {
    const generation = this.generation;
    this.operations.clear();
    for (const source of snapshot.operations) {
      const { context } = await this.resolveWorkspace(source.workspaceId);
      if (generation !== this.generation) return;
      if (context !== null && this.canRetainContext(context))
        this.operations.set(key(source), { ...source, context });
    }
    this.sourceSequence = snapshot.sequence;
  }
  private async accept(event: ForeignActivitySourceUpdate): Promise<void> {
    if (event.sequence <= this.sourceSequence) return;
    const generation = this.generation;
    const { context } = await this.resolveWorkspace(
      event.operation.workspaceId,
    );
    if (generation !== this.generation) return;
    if (context === null || !this.canRetainContext(context)) {
      this.names.delete(event.operation.workspaceId);
      for (const [operationKey, operation] of Array.from(this.operations)) {
        if (operation.workspaceId !== event.operation.workspaceId) continue;
        this.operations.delete(operationKey);
        this.deliver({ ...event, operation, removed: true });
      }
      // The ledger can retain earlier chat turns beyond the latest live entry.
      for (const { operation } of this.ledger.entries()) {
        if (operation.workspaceId === event.operation.workspaceId)
          this.deliver({ ...event, operation, removed: true });
      }
      this.sourceSequence = event.sequence;
      return;
    }
    this.sourceSequence = event.sequence;
    const operation = { ...event.operation, context };
    if (event.removed) this.operations.delete(key(operation));
    else this.operations.set(key(operation), operation);
    this.deliver({ ...event, operation });
  }

  private deliver(event: ForeignActivitySourceEvent): void {
    const delivered = { ...event, sequence: ++this.ledgerSequence };
    for (const listener of Array.from(this.sourceListeners))
      listener(delivered);
  }

  private async hydrate(saved: ForeignActivityOperation[]): Promise<void> {
    const generation = this.generation;
    // Lazy local imports avoid a service/execution initialization cycle.
    const [
      { getChatStateService },
      { getAllActiveSessionInfos },
      { getActivePipelineExecutionHandles },
      { listTrackedShellScripts },
    ] = await Promise.all([
      import('./chat-state-service'),
      import('../agents/session-manager'),
      import('../pipelines/pipeline-execution-registry'),
      import('../lib/script-runner'),
    ]);
    if (generation !== this.generation) return;
    for (const operation of saved) {
      const resolved = await this.resolveWorkspace(operation.workspaceId);
      if (generation !== this.generation) return;
      if (resolved.status === 'unreadable' || resolved.status === 'stale')
        continue;
      const { context } = resolved;
      if (context === null || !this.canRetainContext(context)) {
        this.names.delete(operation.workspaceId);
        this.deliver({
          sequence: this.sourceSequence,
          operation,
          removed: true,
        });
        continue;
      }
      if (operation.source === 'chat' && operation.chatId !== undefined) {
        const snapshot = await getChatStateService().getState({
          projectId: operation.workspaceId,
          worktreeId: operation.worktreeId,
        });
        if (generation !== this.generation) return;
        if (!this.canRetainContext(context)) {
          this.names.delete(operation.workspaceId);
          this.deliver({
            sequence: this.sourceSequence,
            operation,
            removed: true,
          });
          continue;
        }
        const tab = snapshot.tabsFile.tabs.find(
          (candidate): boolean => candidate.id === operation.chatId,
        );
        const runtime = snapshot.runtimeByChatId[operation.chatId];
        const alive =
          runtime?.queuedMessageIds.includes(operation.operationId) ||
          (runtime?.activeTurn?.userMessageId === operation.operationId &&
            getAllActiveSessionInfos().some(
              (session): boolean =>
                session.projectId === operation.workspaceId &&
                session.worktreeId === operation.worktreeId &&
                session.chatId === operation.chatId &&
                session.turnActive,
            ));
        if (alive) {
          this.operations.set(key(operation), { ...operation, context });
          continue;
        }
        if (
          this.operations.get(key(operation))?.operationId ===
          operation.operationId
        )
          this.operations.delete(key(operation));
        if (
          tab?.transcript !== undefined &&
          !(
            tab.transcript.hasOrdinaryActiveRows ??
            tab.transcript.hasActiveSidecar
          )
        ) {
          const resultToken = `${operation.operationId}:${tab.transcript.transcriptRevision}`;
          const savedRevision = Number(
            operation.resultToken?.slice(
              operation.resultToken.lastIndexOf(':') + 1,
            ) ?? 0,
          );
          // Active turns retain the previous turn's token; compare revisions,
          // not turn ids, to avoid treating an unchanged transcript as completion.
          if (
            !operation.active ||
            tab.transcript.transcriptRevision > savedRevision
          ) {
            const completed = {
              ...operation,
              context,
              active: false,
              resultToken,
              unreadToken: tab.unread ? resultToken : null,
            };
            // Settle the saved turn without replacing a newer live turn in this chat.
            if (!this.operations.has(key(operation)))
              this.operations.set(key(operation), completed);
            this.deliver({
              sequence: this.sourceSequence,
              operation: completed,
            });
          }
        }
      } else if (
        operation.source === 'pipeline' &&
        getActivePipelineExecutionHandles().some(
          (handle): boolean => handle.id === operation.operationId,
        )
      )
        this.operations.set(key(operation), { ...operation, context });
      else if (
        operation.source === 'script' &&
        listTrackedShellScripts().some(
          (run): boolean => run.logRef?.runId === operation.operationId,
        )
      )
        this.operations.set(key(operation), { ...operation, context });
    }
    this.ledger.reconcile('chat', true);
    this.ledger.reconcile('pipeline', true);
    this.ledger.reconcile('script', true);
  }

  get(): ForeignActivityProjection {
    const groups = new Map<
      string,
      ForeignActivityProjection['groups'][number]
    >();
    const organizations = getWorkspaceContextService().getState().organizations;
    if (foreignActivityEnabled()) {
      const entries = this.ledger
        .entries()
        .sort(
          (left, right): number =>
            Number(right.state === 'FOREIGN_COMPLETED_UNREAD') -
              Number(left.state === 'FOREIGN_COMPLETED_UNREAD') ||
            Number(right.state === 'FOREIGN_ACTIVE') -
              Number(left.state === 'FOREIGN_ACTIVE') ||
            right.changedAt - left.changedAt,
        );
      for (const entry of entries) {
        const operation = entry.operation;
        if (
          operation.context.kind === 'organization' &&
          !organizations.some(
            (org): boolean =>
              operation.context.kind === 'organization' &&
              org.id === operation.context.organizationId,
          )
        )
          continue;
        const contextKey = serializeWorkspaceContext(operation.context);
        let group = groups.get(contextKey);
        if (group === undefined) {
          group = { context: operation.context, workspaces: [] };
          groups.set(contextKey, group);
        }
        let row = group.workspaces.find(
          (workspace): boolean =>
            workspace.workspaceId === operation.workspaceId,
        );
        if (row === undefined) {
          row = {
            workspaceId: operation.workspaceId,
            name: this.names.get(operation.workspaceId) ?? 'Project',
            running: 0,
            unread: 0,
            interrupted: false,
            latestTarget: targetOf(operation),
            stopTargets: [],
          };
          group.workspaces.push(row);
        }
        if (entry.state === 'FOREIGN_ACTIVE') {
          row.running += 1;
          row.stopTargets.push(targetOf(operation));
        }
        if (entry.state === 'FOREIGN_COMPLETED_UNREAD') row.unread += 1;
        if (entry.interrupted) row.interrupted = true;
      }
    }
    return {
      epoch: this.ledger.file().epoch,
      sequence: this.projectionSequence,
      groups: Array.from(groups.values()),
    };
  }
  private publish(persist = true): void {
    this.projectionSequence += 1;
    const projection = this.get();
    for (const listener of Array.from(this.listeners)) listener(projection);
    if (this.timer !== undefined) clearTimeout(this.timer);
    const lingering = this.ledger
      .entries()
      .filter((entry): boolean => entry.state === 'FOREIGN_COMPLETED_LINGER');
    if (lingering.length > 0) {
      const deadline = Math.min(
        ...lingering.map((entry): number => entry.changedAt + 30_000),
      );
      this.timer = setTimeout(
        (): void => this.publish(),
        Math.max(1, deadline - Date.now()),
      );
      this.timer.unref();
    }
    if (!persist || !foreignActivityEnabled()) return;
    const file = this.ledger.file();
    const generation = this.generation;
    this.writes = this.writes
      .then(async (): Promise<void> => {
        if (generation !== this.generation || file.accountId === '') return;
        await mkdir(getDataDir(), { recursive: true });
        await writeFileAtomically(
          this.filePath(),
          `${JSON.stringify(file)}\n`,
          { mode: 0o600 },
        );
      })
      .catch((): void => {
        /* Attention remains usable if local persistence fails. */
      });
  }
  subscribe(
    listener: (projection: ForeignActivityProjection) => void,
  ): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    this.shutdownPromise ??= (async (): Promise<void> => {
      await this.initialized;
      await this.whenIdle();
      this.dispose();
    })();
    await this.shutdownPromise;
  }
  dispose(): void {
    this.closing = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    this.ledger.dispose();
  }

  async whenIdle(): Promise<void> {
    await this.chain;
    await this.writes;
  }

  async stop(request: ForeignActivityStopRequest): Promise<void> {
    await this.whenIdle();
    if (!foreignActivityEnabled() || request.epoch !== this.ledger.file().epoch)
      throw new Error(FOREIGN_ACTIVITY_CHANGED_ERROR);
    const target = request.target;
    const entry = this.ledger
      .entries()
      .find(
        (candidate): boolean =>
          candidate.state === 'FOREIGN_ACTIVE' &&
          key(candidate.operation) ===
            key({ ...target, active: true, unreadToken: null }) &&
          candidate.operation.operationId === target.operationId,
      );
    if (entry === undefined) throw new Error(FOREIGN_ACTIVITY_INACTIVE_ERROR);
    // Use the exact existing execution controls; no new foreign execution authority.
    if (target.source === 'chat' && target.chatId !== undefined) {
      // Lazy local imports avoid the chat execution/service initialization cycle.
      const { getChatStateService } = await import('./chat-state-service');
      const chatTarget = {
        projectId: target.workspaceId,
        worktreeId: target.worktreeId,
        chatId: target.chatId,
      };
      const snapshot = await getChatStateService().getState(chatTarget);
      let runtime = snapshot.runtimeByChatId[target.chatId];
      if (runtime?.queuedMessageIds.includes(target.operationId)) {
        const { dispatchCanonicalChatCommand } = await import('../ipc/chat');
        const receipt = await dispatchCanonicalChatCommand({
          schemaVersion: 1,
          commandId: randomUUID(),
          projectId: chatTarget.projectId,
          worktreeId: chatTarget.worktreeId,
          command: {
            type: 'chat.cancel_queued_message',
            chatId: chatTarget.chatId,
            queuedMessageId: target.operationId,
          },
        });
        if (receipt.outcome === 'rejected')
          throw new Error(FOREIGN_ACTIVITY_BUSY_ERROR);
        if (
          receipt.outcome === 'applied' ||
          receipt.outcome === 'already_applied'
        )
          return;
        // Dispatch can move the queued message into an active turn during cancel.
        const latest = await getChatStateService().getState(chatTarget);
        runtime = latest.runtimeByChatId[target.chatId];
      }
      if (runtime?.activeTurn?.userMessageId === target.operationId) {
        const { stopChatTurn } = await import('../lib/chat-turn-stop');
        await stopChatTurn(chatTarget);
      } else {
        const { subscribeTransientRetryActivity } =
          await import('../lib/transient-error-retry-service');
        // Replay the live retry state, including retries awaiting dispatch.
        // The source adapter keeps retries under the latest original chat turn.
        const originalTurn = foreignActivitySourceSnapshot()
          .operations.reverse()
          .find(
            (operation): boolean =>
              operation.source === 'chat' &&
              operation.workspaceId === target.workspaceId &&
              operation.worktreeId === target.worktreeId &&
              operation.chatId === target.chatId,
          );
        let matchingRetry = false;
        const unsubscribe = subscribeTransientRetryActivity(
          (retry, active, retryUserMessageId): void => {
            if (
              active &&
              retry.projectId === target.workspaceId &&
              retry.worktreeId === target.worktreeId &&
              retry.chatId === target.chatId &&
              (originalTurn?.operationId === target.operationId ||
                retryUserMessageId === target.operationId)
            )
              matchingRetry = true;
          },
        );
        unsubscribe();
        if (!matchingRetry) throw new Error(FOREIGN_ACTIVITY_INACTIVE_ERROR);
        const { stopChatTurn } = await import('../lib/chat-turn-stop');
        await stopChatTurn(chatTarget);
      }
    } else if (target.source === 'pipeline') {
      const { getActiveExecutionHandle } =
        await import('../pipelines/pipeline-execution-registry');
      const handle = getActiveExecutionHandle(target.operationId);
      if (handle !== undefined) {
        await handle.cancel();
      } else {
        const { listQueuedHookPipelines, cancelQueuedHookPipeline } =
          await import('../lib/hook-pipeline');
        const queued = listQueuedHookPipelines().find(
          (invocation): boolean =>
            invocation.executionId === target.operationId &&
            invocation.projectId === target.workspaceId &&
            invocation.worktreeId === target.worktreeId,
        );
        if (queued === undefined)
          throw new Error(FOREIGN_ACTIVITY_INACTIVE_ERROR);
        if (!(await cancelQueuedHookPipeline(queued.queueId)))
          throw new Error(FOREIGN_ACTIVITY_BUSY_ERROR);
      }
    } else if (target.source === 'script') {
      const { listTrackedShellScripts, stopTrackedShellScriptRun } =
        await import('../lib/script-runner');
      const run = listTrackedShellScripts().find(
        (script): boolean =>
          script.logRef?.runId === target.operationId &&
          script.projectId === target.workspaceId &&
          script.worktreeId === target.worktreeId,
      );
      if (run?.logRef === undefined)
        throw new Error(FOREIGN_ACTIVITY_INACTIVE_ERROR);
      await stopTrackedShellScriptRun({ ...run, logRef: run.logRef });
    }
  }
}
let singleton: ForeignActivityCarryoverService | undefined;
export function getForeignActivityCarryoverService(): ForeignActivityCarryoverService {
  singleton ??= new ForeignActivityCarryoverService();
  return singleton;
}
