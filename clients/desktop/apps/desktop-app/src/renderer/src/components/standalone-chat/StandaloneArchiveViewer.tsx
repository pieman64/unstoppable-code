import { TranscriptPagingControls } from '@canopy/ui-shared/components';
import { installTranscriptPage } from '@/stores/chat/transcript-pages';
import type { ChatTranscriptPageRequest } from '@canopy/desktop-shared/types';
import {
  lazy,
  Suspense,
  useCallback,
  useState,
  useEffect,
  useRef,
  type JSX,
} from 'react';
import { Markdown } from '@canopy/ui-shared/components';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { dismissPageLikeViewers } from '@/lib/dismissPageLikeViewers';
import type { ChatTab } from '@/stores/chatStore';
import type { StandaloneChatMeta } from '@canopy/desktop-shared/types';
import { LoadingSpinner } from '../shared/loading/spinners/LoadingSpinner';
import { getStandaloneChatDisplayLabel } from './chat-label';
import { focusChatTextarea } from './focusChatTextarea';
import { Tooltip } from '@canopy/ui-shared';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  ArchiveBoxIcon as AppCatalogArchiveBoxIcon,
  PlusIcon as AppCatalogPlusIcon,
} from '@canopy/ui-shared/icons/AppIcons';

const ChatMessageList = lazy(() =>
  import('../chat/ChatMessageList').then((m) => ({
    default: m.ChatMessageList,
  })),
);

function formatDate(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

interface StandaloneArchiveViewerProps {
  transcriptScope?: ChatTranscriptPageRequest;
  summary: string | null;
  meta: StandaloneChatMeta | null;
  tab: ChatTab | null;
  legacySummaryOnly: boolean;
}

export function StandaloneArchiveViewer({
  summary,
  meta,
  tab: initialTab,
  transcriptScope,
  legacySummaryOnly,
}: StandaloneArchiveViewerProps): JSX.Element {
  const [tab, setTab] = useState(initialTab);
  const [loading, setLoading] = useState(false);
  const pageInFlight = useRef(false);
  const [turnPageId, setTurnPageId] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setTab(initialTab);
    pageInFlight.current = false;
    setTurnPageId(null);
    setLoading(false);
    setError(false);
    const lease = generation;
    return (): void => {
      lease.current++;
    };
  }, [initialTab, transcriptScope]);
  // Memoized so the transcript rows (memoized on their `onLoadHistory` prop)
  // keep a stable callback across unrelated viewer re-renders.
  const loadPage = useCallback(
    async (older: boolean, turnId?: string): Promise<void> => {
      if (!tab || !transcriptScope) return;
      // A turn outside the loaded window walks the global history cursor.
      const knownTurn = turnId
        ? tab.transcriptWindow?.turns?.find((turn) => turn.id === turnId)
        : undefined;
      const before = knownTurn
        ? knownTurn.before
        : tab.transcriptWindow?.before;
      if (older && before === undefined) return;
      if (pageInFlight.current) return;
      pageInFlight.current = true;
      const current = ++generation.current;
      setTurnPageId(turnId ?? null);
      setLoading(true);
      setError(false);
      try {
        const page = await window.api.chat.getTranscriptPage({
          view: 'turns',
          ...(knownTurn ? { turnId } : {}),
          ...transcriptScope,
          ...(older
            ? {
                before,
                transcriptRevision: tab.transcriptWindow?.transcriptRevision,
              }
            : {}),
        });
        if (current === generation.current)
          setTab(installTranscriptPage(tab, page, older));
      } catch {
        if (current === generation.current) setError(true);
      } finally {
        if (current === generation.current) {
          pageInFlight.current = false;
          setLoading(false);
        }
      }
    },
    [tab, transcriptScope],
  );
  const loadTurn = useCallback(
    (id: string): Promise<void> => loadPage(true, id),
    [loadPage],
  );
  const resumeArchivedChat = useStandaloneChatStore(
    (s) => s.resumeArchivedChat,
  );
  const startNewChat = useStandaloneChatStore((s) => s.startNewChat);
  const archiveChatId = meta?.id ?? tab?.id ?? null;

  const handleResume = useCallback(() => {
    if (archiveChatId) {
      // Resuming lands in a live chat: leave the page-like archive surfaces
      // (including the "Archived and deleted" overview beneath this legacy
      // viewer) the same way sidebar navigation does.
      dismissPageLikeViewers();
      void resumeArchivedChat(archiveChatId);
    }
  }, [archiveChatId, resumeArchivedChat]);

  const handleNewChat = useCallback(() => {
    dismissPageLikeViewers();
    void startNewChat();
    focusChatTextarea();
  }, [startNewChat]);

  const archiveTitle = getStandaloneChatDisplayLabel({
    customTitle: tab?.customTitle ?? meta?.customTitle,
    title: meta?.title,
    description: meta?.description,
    liveTitle: tab?.title,
    fallback: 'Archived chat',
  });

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs fg-secondary">
              <AppCatalogArchiveBoxIcon width="14" height="14" />
              <span>Archived chat</span>
            </div>
            <div
              className={`${POSTHOG_REPLAY_MASK_CLASS} mt-1 text-sm font-medium fg-primary`}
            >
              {archiveTitle}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Tooltip label="New chat">
              <button
                type="button"
                onClick={handleNewChat}
                data-testid="standalone-archive-new-chat"
                className="rounded p-1.5 text-xs fg-secondary hover:bg-fg-primary/[0.06] hover:fg-primary"
                aria-label="New chat"
              >
                <AppCatalogPlusIcon width="14" height="14" />
              </button>
            </Tooltip>
            <button
              type="button"
              onClick={handleResume}
              disabled={!archiveChatId}
              className="rounded-md bg-accent-subtle px-2.5 py-1 text-xs font-medium fg-accent hover:bg-accent-subtle/80"
            >
              Resume as new chat
            </button>
          </div>
        </div>
        {meta && (
          <div className="mb-5 flex flex-wrap gap-x-4 gap-y-1 text-xs fg-secondary">
            <span>Created {formatDate(meta.createdAt)}</span>
            {meta.archivedAt && (
              <span>Archived {formatDate(meta.archivedAt)}</span>
            )}
          </div>
        )}
        {tab ? (
          // `ChatMessageList` renders an `absolute inset-0` scroller inside a
          // `relative flex-1` root, so it only has height inside a flex column
          // with a resolved height. A plain `min-h` block collapses that
          // scroller to 0px and the transcript renders invisibly, so give it an
          // explicit flex-column height here.
          <div className="flex h-[min(70vh,800px)] min-h-80 flex-col overflow-hidden rounded-xl border bg-base/60">
            <Suspense
              fallback={
                <div className="flex min-h-80 items-center justify-center">
                  <LoadingSpinner tone="secondary" />
                </div>
              }
            >
              <ChatMessageList
                pagingControls={
                  <TranscriptPagingControls
                    needsLoad={Boolean(
                      tab?.transcript && tab.transcriptWindow?.view !== 'turns',
                    )}
                    hasEarlier={tab.transcriptWindow?.before !== undefined}
                    loading={loading && turnPageId === null}
                    suspended={loading}
                    error={
                      error && turnPageId === null
                        ? "Couldn't load archived messages."
                        : null
                    }
                    onLoadEarlier={() => void loadPage(true)}
                    onReload={() => void loadPage(false)}
                  />
                }
                transcriptTurns={tab?.transcriptWindow?.turns}
                onLoadTurn={loadTurn}
                turnPageId={turnPageId}
                turnLoading={loading}
                turnError={error ? "Couldn't load archived messages." : null}
                targetOverride={transcriptScope}
                standaloneHistory={transcriptScope?.standaloneHistory}
                messages={tab.messages}
                queuedMessages={[]}
                chatId={tab.id}
                agentUsage={tab.agentUsage}
                turnDiffs={tab.turnDiffs}
                onClearQueuedMessage={() => undefined}
              />
            </Suspense>
          </div>
        ) : summary ? (
          <div
            data-testid="standalone-archive-summary"
            className={`${POSTHOG_REPLAY_BLOCK_CLASS} prose prose-sm [--tw-prose-body:var(--fg-primary)] dark:prose-invert max-w-none break-words prose-p:my-0.5 prose-pre:my-1.5 prose-pre:bg-fg-primary/[0.06] prose-pre:fg-primary/80 prose-code:fg-success prose-code:before:content-none prose-code:after:content-none prose-headings:fg-primary prose-a:fg-accent prose-strong:fg-primary prose-li:my-0.5`}
          >
            <Markdown>{summary}</Markdown>
          </div>
        ) : (
          <div className="py-8 text-center text-sm fg-secondary">
            {legacySummaryOnly
              ? 'No summary available for this archived chat.'
              : 'Archived chat is unavailable.'}
          </div>
        )}
      </div>
    </div>
  );
}
