import {
  ARCHIVE_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol/ui-labels';
import { z } from 'zod';
import type {
  AppAdvisorWatcherDestination,
  AppAdvisorWatcherSummary,
} from '@canopy/desktop-shared/types';
import { getActiveDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { isAskUserDismissal } from '../lib/ask-user-outcomes';
import type {
  AdvisorRecordsActionHost,
  PersonConfirmation,
} from './advisor-records-actions';

/** `core.initiatedWork.watcher.delete`'s per-watcher outcomes, inside its report. */
const DeleteReportSchema = z.object({
  results: z.array(
    z.object({
      watcherId: z.string(),
      status: z.enum(['deleted', 'not_found', 'busy']),
    }),
  ),
});

function deleteOutcome(
  report: string,
  watcherId: string,
): 'deleted' | 'not_found' | 'busy' | undefined {
  let value: unknown;
  try {
    value = JSON.parse(report);
  } catch {
    return undefined;
  }
  const parsed = DeleteReportSchema.safeParse(value);
  return parsed.success
    ? parsed.data.results.find((entry) => entry.watcherId === watcherId)?.status
    : undefined;
}

/** The watcher service calls these actions make. */
interface WatcherService {
  list(): Promise<AppAdvisorWatcherSummary[]>;
  deleteWatcher(
    id: string,
    options: { notifySubscriber: boolean },
  ): Promise<boolean>;
}

/** This chat's AskUserQuestion, with each answer's provenance. */
export type RequestUserAnswers = (
  questions: Array<{
    question: string;
    options: string[];
    multiSelect?: boolean;
    allowOther?: boolean;
  }>,
) => Promise<
  Array<{ selectedOptions: string[]; answeredBy?: 'person' | 'agent' }>
>;

/**
 * The main owners App Advisor's Feed, watcher and archive actions use
 * (CAN-6007): the Ledger as the advisor chat, the watcher service, and the
 * `core.archive.*` operations as the advisor chat with one grant per call.
 */
export function mainAdvisorRecordsActionHost(options: {
  destination: AppAdvisorWatcherDestination;
  /** This tool call's key, shared by its retries. */
  callKey: string;
  requestUserAnswers: RequestUserAnswers;
}): AdvisorRecordsActionHost {
  const { destination, callKey } = options;
  const caller = (
    grant: CanopyCallerDescriptor['grants'][number],
  ): CanopyCallerDescriptor => ({
    principalId: 'local-desktop-user',
    clientInstanceId: `agent-action:${destination.chatId}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'mcp',
    grants: [grant],
  });
  const chat = {
    chatId: destination.chatId,
    displayName: ORCHESTRATOR_LABEL,
    authorDetails: {
      harness: null,
      model: null,
      thinkingEffort: null,
      mode: null,
      pipelineExecutionId: null,
      settingsRevision: null,
      unavailableReason: 'not_recorded' as const,
    },
  };
  const watchers = async (): Promise<WatcherService> =>
    (await import('./watchers')).getAppAdvisorWatcherService();
  return {
    chatId: destination.chatId,
    callKey,
    searchFeed: async (scope, params) =>
      (await import('../ipc/ledger')).searchLedgerEntriesAsChat(
        getActiveDesktopRuntime(),
        chat,
        scope,
        params,
      ),
    addFeedEntry: async (scope, requestKey, params) =>
      (await import('../ipc/ledger')).addLedgerEntryAsChat(
        getActiveDesktopRuntime(),
        chat,
        scope,
        requestKey,
        params,
      ),
    listWatchers: async () => (await watchers()).list(),
    deleteOwnWatcher: async (watcherId) => {
      const { deleteWatchersThroughCore } =
        await import('../canopy-tools/watcher-core-client');
      const result = await deleteWatchersThroughCore(destination, [watcherId], {
        invocationId: callKey,
      });
      if (result.isError)
        return { ok: false, reason: 'failed', message: result.text };
      // The delete reports each watcher's outcome inside a successful reply.
      switch (deleteOutcome(result.text, watcherId)) {
        case 'deleted':
          return { ok: true };
        case 'busy':
          return {
            ok: false,
            reason: 'busy',
            message: 'The watcher is firing right now. Try again shortly.',
          };
        case 'not_found':
          return {
            ok: false,
            reason: 'not_found',
            message: `Watcher ${watcherId} was not found.`,
          };
        default:
          return {
            ok: false,
            reason: 'failed',
            message: 'The watcher delete gave no result for this watcher.',
          };
      }
    },
    deleteWatcher: async (watcherId, notifySubscriber) =>
      (await watchers()).deleteWatcher(watcherId, { notifySubscriber }),
    confirm: async (question, labels): Promise<PersonConfirmation> => {
      let answers: Awaited<ReturnType<RequestUserAnswers>>;
      try {
        answers = await options.requestUserAnswers([
          {
            question,
            options: [labels.confirm, labels.decline],
            multiSelect: false,
            allowOther: false,
          },
        ]);
      } catch (error) {
        // A dismissal declines; any failure to ask someone fails closed.
        return isAskUserDismissal(error) ? 'declined' : 'no_person';
      }
      const answer = answers[0];
      // Only a person's answer confirms; an agent's or one of unknown origin
      // never does.
      if (answer?.answeredBy !== 'person') return 'no_person';
      return answer.selectedOptions.includes(labels.confirm)
        ? 'confirmed'
        : 'declined';
    },
    listArchive: (workspaceId) =>
      getActiveDesktopRuntime().query(
        'core.archive.container.list',
        { workspaceId },
        { caller: caller(ARCHIVE_GRANTS.read) },
      ),
    readArchivedChat: (workspaceId, archiveId, chatId, limit) =>
      getActiveDesktopRuntime().query(
        'core.archive.chat.get',
        { workspaceId, archiveId, chatId, limit },
        { caller: caller(ARCHIVE_GRANTS.read) },
      ),
    setArchiveLocked: async (workspaceId, archiveId, locked) => {
      const idempotencyKey = `app-advisor-action:${callKey}:archive-lock`;
      const { container } = await getActiveDesktopRuntime().instruction(
        'core.archive.container.update',
        { workspaceId, archiveId, locked, _meta: { idempotencyKey } },
        {
          caller: caller(ARCHIVE_GRANTS.write),
          metadata: { idempotencyKey },
        },
      );
      return container;
    },
    restoreArchive: async (workspaceId, archiveId) => {
      const [
        { projectedWorkspaceLifecycleCommands },
        { restoreArchivedContainer },
      ] = await Promise.all([
        import('../canopy-runtime/workspace-lifecycle-dispatch'),
        import('../lib/archived-container-restore'),
      ]);
      // The window's Restore: core.archive.container.restore over the same
      // owner, as the advisor chat with only core.archive.write.
      return projectedWorkspaceLifecycleCommands({
        dispatcher: getActiveDesktopRuntime(),
        caller: caller(ARCHIVE_GRANTS.write),
      }).restoreArchive({ workspaceId, containerId: archiveId }, () =>
        restoreArchivedContainer(workspaceId, archiveId),
      );
    },
  };
}
