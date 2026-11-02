import type {
  AppAdvisorWatcherDestination,
  AppAdvisorWatcherSummary,
  PortalCommandEnvelope,
  PortalEntityEnvelope,
  PortalStateRequestPayload,
} from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { watchersForSubscriberDestination } from '@canopy/desktop-shared/lib/watcher-filters';
import {
  formatGitHubRunSampleLabel,
  githubWatcherTargetDisplay,
  triggerTitle,
  watcherOwnerDelegateDisplay,
  watcherStatusLabelWithFailure,
  watcherTargetDisplay,
} from '@canopy/desktop-shared/lib/watcher-display';
import {
  PortalWatcherDeletePayloadSchema,
  type PortalWatcherEntity,
  worktreeScopedParentLocalId,
} from '@canopy/protocol/portal';
import { getAppAdvisorWatcherService } from '../../app-advisor/watchers';
import {
  capturePortalEmissionContext,
  createPortalEvent,
  enqueuePortalEvent,
  isPortalEmissionContextCurrent,
  type PortalEmissionContext,
} from '../portal-event-bus';
import type { PortalAdapterContext } from './types';
import { isRecord } from './validation';

interface Subscription {
  destination: AppAdvisorWatcherDestination;
  emission: PortalEmissionContext;
  rows: Map<string, PortalWatcherEntity>;
}
// Only chats actually projected to this Portal session can publish watchers.
const subscriptions = new Map<string, Subscription>();

function destinationKey(destination: AppAdvisorWatcherDestination): string {
  return JSON.stringify([
    destination.projectId,
    destination.worktreeId,
    destination.chatId,
  ]);
}

export function projectPortalWatchers(
  watchers: AppAdvisorWatcherSummary[],
  destinations: readonly AppAdvisorWatcherDestination[],
): PortalWatcherEntity[] {
  const rows = new Map<string, PortalWatcherEntity>();
  for (const destination of destinations) {
    for (const watcher of watchersForSubscriberDestination(
      watchers,
      destination,
    )) {
      if (watcher.status !== 'active' && watcher.status !== 'delivery_failed')
        continue;
      const target = watcherTargetDisplay(watcher.target);
      const github = githubWatcherTargetDisplay(watcher.target);
      rows.set(watcher.id, {
        id: watcher.id,
        projectId: destination.projectId,
        worktreeId: destination.worktreeId,
        chatId: destination.chatId,
        trigger: watcher.trigger,
        targetKind: watcher.target.kind,
        status: watcher.status,
        createdAt: watcher.createdAt,
        ...(watcher.followUpInstruction === undefined
          ? {}
          : { followUpInstruction: watcher.followUpInstruction }),
        // Raw delivery errors can include local paths and service internals.
        ...(watcher.deliveryError
          ? {
              deliveryError: 'The watcher notification could not be delivered.',
            }
          : {}),
        display: {
          title: watcher.label || target.title,
          subtitle: triggerTitle(watcher.trigger),
          watching: target.title,
          watchingSubtitle: target.subtitle,
          status: watcherStatusLabelWithFailure(
            watcher.status,
            watcher.failureKind,
          ),
          details: target.details.filter(
            (detail) =>
              watcher.target.kind !== 'command_watch' ||
              detail.label !== 'Directory',
          ),
          ...(watcher.ownerDelegate
            ? {
                ownerDelegate: watcherOwnerDelegateDisplay(
                  watcher.ownerDelegate,
                ),
              }
            : {}),
          ...(github
            ? {
                github: {
                  subtitle: github.subtitle,
                  filters: github.filters,
                  samples: github.sample.map(formatGitHubRunSampleLabel),
                  totalCount: github.totalCount,
                },
              }
            : {}),
        },
      });
    }
  }
  return Array.from(rows.values()).sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

function envelope(row: PortalWatcherEntity): PortalEntityEnvelope {
  return {
    entityType: 'watcher',
    localId: row.id,
    parentLocalId: worktreeScopedParentLocalId(row.projectId, row.worktreeId),
    payload: row,
  };
}

export async function listPortalWatcherEntities(
  destinations: readonly AppAdvisorWatcherDestination[],
): Promise<PortalEntityEnvelope[]> {
  const emission = capturePortalEmissionContext();
  const watchers = destinations.length
    ? await getAppAdvisorWatcherService().list()
    : [];
  const rows = projectPortalWatchers(watchers, destinations);
  if (emission && isPortalEmissionContextCurrent(emission)) {
    for (const destination of destinations) {
      const matching = rows.filter(
        (row) => destinationKey(row) === destinationKey(destination),
      );
      subscriptions.set(destinationKey(destination), {
        destination,
        emission,
        rows: new Map(matching.map((row) => [row.id, row])),
      });
    }
  }
  return rows.map(envelope);
}

/** Use the same real-chat eligibility as ChatInput, including App Advisor entries. */
export async function listPortalWatchersForSnapshot(
  request: PortalStateRequestPayload,
  entities: readonly PortalEntityEnvelope[],
): Promise<PortalEntityEnvelope[]> {
  if (!['worktree', 'chat', 'app_advisor'].includes(request.scope)) return [];
  const destinations: AppAdvisorWatcherDestination[] = [];
  for (const entity of entities) {
    const payload = entity.payload;
    if (!isRecord(payload)) continue;
    if (
      entity.entityType === 'app_advisor_chat' &&
      typeof payload.workEntryId === 'string'
    ) {
      destinations.push({
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: payload.workEntryId,
        chatId: entity.localId,
      });
    } else if (
      entity.entityType === 'chat_summary' &&
      payload.scope === 'worktree' &&
      typeof payload.workspaceLocalId === 'string' &&
      typeof payload.worktreeLocalId === 'string'
    ) {
      destinations.push({
        projectId: payload.workspaceLocalId,
        worktreeId: payload.worktreeLocalId,
        chatId: entity.localId,
      });
    }
  }
  const selectedChat =
    request.scope === 'chat' ? request.target?.chatLocalId : undefined;
  const selected = selectedChat
    ? destinations.filter((destination) => destination.chatId === selectedChat)
    : destinations;
  const nextKeys = new Set(selected.map(destinationKey));
  for (const [key, subscription] of Array.from(subscriptions)) {
    const destination = subscription.destination;
    const replaced =
      request.scope === 'app_advisor'
        ? destination.projectId === APP_ADVISOR_PROJECT_ID &&
          (!request.target?.chatLocalId ||
            destination.chatId === request.target.chatLocalId)
        : destination.projectId === request.target?.workspaceLocalId &&
          destination.worktreeId === request.target?.worktreeLocalId &&
          (!selectedChat || destination.chatId === selectedChat);
    if (replaced && !nextKeys.has(key)) subscriptions.delete(key);
  }
  return listPortalWatcherEntities(selected);
}

/** Called with the same watchers-changed summary snapshot that desktop receives. */
export function emitPortalWatcherProjection(
  watchers: AppAdvisorWatcherSummary[],
): void {
  for (const [key, subscription] of Array.from(subscriptions)) {
    if (!isPortalEmissionContextCurrent(subscription.emission)) {
      subscriptions.delete(key);
      continue;
    }
    const rows = projectPortalWatchers(watchers, [subscription.destination]);
    const next = new Map(rows.map((row) => [row.id, row]));
    const changed = rows.filter(
      (row) =>
        JSON.stringify(subscription.rows.get(row.id)) !== JSON.stringify(row),
    );
    const removed = Array.from(subscription.rows.keys())
      .filter((id) => !next.has(id))
      .sort()
      .map((id) => ({
        entityType: 'watcher' as const,
        localId: id,
        parentLocalId: worktreeScopedParentLocalId(
          subscription.destination.projectId,
          subscription.destination.worktreeId,
        ),
      }));
    if (!changed.length && !removed.length) continue;
    const destination = subscription.destination;
    enqueuePortalEvent(
      createPortalEvent('portal.state.delta', {
        scope:
          destination.projectId === APP_ADVISOR_PROJECT_ID
            ? 'app_advisor'
            : 'chat',
        target:
          destination.projectId === APP_ADVISOR_PROJECT_ID
            ? { chatLocalId: destination.chatId }
            : {
                workspaceLocalId: destination.projectId,
                worktreeLocalId: destination.worktreeId,
                chatLocalId: destination.chatId,
              },
        entities: changed.map(envelope),
        ...(removed.length ? { removed } : {}),
        generatedAt: new Date().toISOString(),
      }),
    );
    subscription.rows = next;
  }
}

export function clearPortalWatcherProjection(): void {
  subscriptions.clear();
}

export async function handlePortalWatcherDelete(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const parsed = PortalWatcherDeletePayloadSchema.safeParse(command.payload);
  if (!parsed.success) {
    context.fail(command, 'invalid_payload', 'Invalid watcher delete request.');
    return;
  }
  if (!context.sessionId || context.canReadTranscripts?.() !== true) {
    context.fail(
      command,
      'forbidden',
      'This chat is not available in the paired session.',
    );
    return;
  }
  const { watcherId, notifySubscriber } = parsed.data;
  const subscriber = Array.from(subscriptions.values()).find(
    (subscription) =>
      isPortalEmissionContextCurrent(subscription.emission) &&
      subscription.rows.has(watcherId),
  );
  const unavailable = (): void =>
    context.fail(
      command,
      'not_found_or_firing',
      'Watcher not found or currently firing.',
    );
  if (!subscriber) {
    unavailable();
    return;
  }
  try {
    const service = getAppAdvisorWatcherService();
    const current = watchersForSubscriberDestination(
      await service.list(),
      subscriber.destination,
    );
    if (
      context.canReadTranscripts?.() !== true ||
      !isPortalEmissionContextCurrent(subscriber.emission)
    ) {
      context.fail(
        command,
        'forbidden',
        'This chat is not available in the paired session.',
      );
      return;
    }
    if (!current.some((watcher) => watcher.id === watcherId)) {
      unavailable();
      return;
    }
    const deleted = await service.deleteWatcher(watcherId, {
      notifySubscriber,
    });
    if (!deleted) {
      unavailable();
      return;
    }
    context.complete(command, { ok: true });
  } catch {
    context.fail(
      command,
      'execution_failed',
      'Could not delete the watcher. Try again.',
    );
  }
}
