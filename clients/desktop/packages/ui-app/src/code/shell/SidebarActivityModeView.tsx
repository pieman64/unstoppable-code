'use client';

import { Heading, ErrorState } from '@canopy/ui-shared/components';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import type { CanopyCapabilities } from '@canopy/app-core';
import {
  SIDEBAR_ACTIVITY_UNREPLIED_PAGE_SIZE,
  useSidebarActivityModeStore,
  type SidebarActivityEntry,
} from '@canopy/app-state';
import { WorkEntryRow, WorktreeRow } from '@canopy/ui-shared/components';
import {
  deriveWorktreeUiStatus,
  type SnapshotWorktree,
} from './worktree-status';
import {
  isSidebarActivityAvailable,
  isSidebarActivityEntryMuted,
  type SidebarActivityHost,
} from './sidebar-activity-host';
import {
  SIDEBAR_MORE_LEAD_SELECTOR,
  SIDEBAR_VIEWPORT_SELECTOR,
} from './sidebar/sidebar-surfaces';

/** The fade ramp below the cut, matching the rail's Chats mask. */
const LEAD_MASK_EDGE_PX = 12;
const LEAD_MASK_START_VAR = '--sidebar-activity-mask-start';
const LEAD_MASK_END_VAR = '--sidebar-activity-mask-end';
const LEAD_MASK_IMAGE = `linear-gradient(to bottom, transparent var(${LEAD_MASK_START_VAR}), black var(${LEAD_MASK_END_VAR}))`;

/**
 * Cuts the Activity list at the bottom of a host rail's pinned More row as it
 * scrolls beneath it, the way the rail cuts its Chats rows under the Chats
 * header. That row is transparent on the macOS translucent sidebar, so paint
 * order cannot hide what passes under it; without the cut every row shows
 * straight through the nav.
 *
 * Geometry is measured only when layout changes; the scroll path reads
 * `scrollTop` and writes two vars, adding no forced layout to the rail's own
 * scroll sync. A surface with no pinned lead (the portal, whose nav sits
 * outside its scroller) gets no mask at all.
 */
function leadMaskRef(list: HTMLElement | null): (() => void) | undefined {
  const viewport = list?.closest<HTMLElement>(SIDEBAR_VIEWPORT_SELECTOR);
  const lead = viewport?.querySelector<HTMLElement>(SIDEBAR_MORE_LEAD_SELECTOR);
  if (
    !list ||
    !viewport ||
    !lead ||
    !(lead.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING)
  )
    return undefined;
  // Where the lead's bottom sits once stuck, from the scroller's top edge.
  let leadStuckBottom = 0;
  // The list's top in the scroller's content.
  let listContentTop = 0;
  const sync = (): void => {
    const { scrollTop } = viewport;
    const start =
      scrollTop > 0
        ? scrollTop + leadStuckBottom - listContentTop
        : -LEAD_MASK_EDGE_PX;
    list.style.setProperty(LEAD_MASK_START_VAR, `${start}px`);
    list.style.setProperty(LEAD_MASK_END_VAR, `${start + LEAD_MASK_EDGE_PX}px`);
  };
  const measure = (): void => {
    const stickyTop = Number.parseFloat(getComputedStyle(lead).top);
    leadStuckBottom =
      (Number.isFinite(stickyTop) ? stickyTop : 0) + lead.offsetHeight;
    listContentTop =
      list.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top -
      viewport.clientTop +
      viewport.scrollTop;
    sync();
  };
  measure();
  list.style.setProperty('mask-image', LEAD_MASK_IMAGE);
  list.style.setProperty('-webkit-mask-image', LEAD_MASK_IMAGE);
  viewport.addEventListener('scroll', sync, { passive: true });
  // The scroller's content box moves the list whenever anything above it
  // changes height (nav items, the lead itself).
  const observer =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
  for (const target of [viewport, viewport.firstElementChild, lead, list])
    if (target) observer?.observe(target);
  return () => {
    viewport.removeEventListener('scroll', sync);
    observer?.disconnect();
    for (const property of [
      'mask-image',
      '-webkit-mask-image',
      LEAD_MASK_START_VAR,
      LEAD_MASK_END_VAR,
    ])
      list.style.removeProperty(property);
  };
}

/**
 * Ends the Activity cycle when its capability goes away or the host session
 * changes. Mounted by every Activity control, so whichever one is on screen
 * enforces it.
 */
export function useSidebarActivityGate(
  host: SidebarActivityHost | undefined,
  capabilities: CanopyCapabilities,
): boolean {
  const enabled = useSidebarActivityModeStore((state) => state.enabled);
  const sessionKey = useSidebarActivityModeStore((state) => state.sessionKey);
  const disable = useSidebarActivityModeStore((state) => state.disable);
  const available = isSidebarActivityAvailable(capabilities, host);
  const hostSessionKey = host?.sessionKey;
  useEffect(() => {
    if (!enabled) return;
    if (!available || sessionKey !== hostSessionKey) disable();
  }, [available, disable, enabled, hostSessionKey, sessionKey]);
  return available && enabled && sessionKey === hostSessionKey;
}

interface SidebarActivityRowProps {
  readonly entry: SidebarActivityEntry;
  readonly index: number;
  readonly unread: boolean;
  readonly selected: boolean;
  readonly touch: boolean;
  readonly working: boolean;
  readonly awaitingApproval: boolean;
  readonly pipelineStatus: SnapshotWorktree['pipelineStatus'];
  readonly onOpen: (entry: SidebarActivityEntry) => void;
}

/**
 * One Activity row. Memoized on scalar live props, so an unread change
 * re-renders only the rows whose dot changed.
 */
const SidebarActivityRow = memo(function SidebarActivityRow({
  entry,
  index,
  unread,
  selected,
  touch,
  working,
  awaitingApproval,
  pipelineStatus,
  onOpen,
}: SidebarActivityRowProps): JSX.Element {
  const testId = `sidebar-activity-row-${entry.chatId}`;
  const lastActivityAt = entry.recencyAt ?? undefined;
  if (entry.kind === 'standalone-chat') {
    return (
      <li data-activity-row-index={index} data-activity-key={entry.key}>
        <WorkEntryRow
          title={entry.title}
          testId={testId}
          entryId={entry.chatId}
          hasUnread={unread}
          working={working}
          selected={selected}
          lastActivityAt={lastActivityAt}
          touchTarget={touch}
          disableSelectedPin
          onOpen={() => onOpen(entry)}
        />
      </li>
    );
  }
  const open = (): void => onOpen(entry);
  return (
    <li data-activity-row-index={index} data-activity-key={entry.key}>
      {/* The shared worktree row is a plain box; this wrapper gives it the
          button semantics and keyboard activation the tree's sortable
          wrapper gives it there. */}
      <div
        role="button"
        tabIndex={0}
        aria-current={selected ? 'true' : undefined}
        data-testid={testId}
        onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>): void => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          open();
        }}
        className="focus-ring rounded-row outline-none"
      >
        <WorktreeRow
          branchLabel={entry.title}
          worktreeIdSlot={`${entry.branchLabel} · ${entry.repositoryName}`}
          uiStatus={deriveWorktreeUiStatus({
            isStreaming: working,
            awaitingApproval,
            pipelineStatus,
            hasUnread: unread,
          })}
          isStreaming={working}
          awaitingApproval={awaitingApproval}
          pipelineStatus={pipelineStatus}
          textScale="sidebar"
          hasUnread={unread}
          selected={selected}
          lastActivityAt={lastActivityAt}
          touchTarget={touch}
          onClick={open}
        />
      </div>
    </li>
  );
});

interface SidebarActivitySectionProps {
  readonly name: 'unread' | 'drafts' | 'unreplied';
  readonly label: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

function SidebarActivitySection({
  name,
  label,
  children,
  footer,
}: SidebarActivitySectionProps): JSX.Element {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid={`sidebar-activity-section-${name}`}
      className="pb-3"
    >
      <div className="flex h-8 items-center px-2">
        <Heading level={2} variant="sidebar" id={headingId}>
          {label}
        </Heading>
      </div>
      {footer === undefined || footer === null ? (
        <ul className="flex flex-col gap-px">{children}</ul>
      ) : (
        <div className="flex flex-col gap-1">
          <ul className="flex flex-col gap-px">{children}</ul>
          {footer}
        </div>
      )}
    </section>
  );
}

export interface SidebarActivityModeViewProps {
  readonly host: SidebarActivityHost;
  readonly capabilities: CanopyCapabilities;
  readonly touch?: boolean;
  readonly liveSnapshot?: {
    readonly worktrees: readonly SnapshotWorktree[];
    readonly standaloneChats: readonly {
      readonly localId: string;
      readonly projectLocalId?: string;
      readonly hasActiveChat?: boolean;
    }[];
  };
}

/** The Activity list that replaces the workspace tree while Activity is on. */
export function SidebarActivityModeView({
  host,
  capabilities,
  touch = false,
  liveSnapshot,
}: SidebarActivityModeViewProps): JSX.Element {
  const status = useSidebarActivityModeStore((state) => state.status);
  const snapshot = useSidebarActivityModeStore((state) => state.snapshot);
  const unrepliedVisible = useSidebarActivityModeStore(
    (state) => state.unrepliedVisible,
  );
  const retry = useSidebarActivityModeStore((state) => state.retry);
  const showMore = useSidebarActivityModeStore((state) => state.showMore);
  const worktrees = useMemo(
    () =>
      new Map(
        (liveSnapshot?.worktrees ?? []).map((tree) => [
          JSON.stringify([tree.workspaceLocalId, tree.localId]),
          tree,
        ]),
      ),
    [liveSnapshot?.worktrees],
  );
  const chats = useMemo(
    () =>
      new Map(
        (liveSnapshot?.standaloneChats ?? []).map((chat) => [
          JSON.stringify([chat.projectLocalId, chat.localId]),
          chat,
        ]),
      ),
    [liveSnapshot?.standaloneChats],
  );
  const hostRef = useRef(host);
  hostRef.current = host;
  const onOpen = useCallback((entry: SidebarActivityEntry): void => {
    hostRef.current.onOpenChat(entry);
  }, []);
  const unrepliedListRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusIndexRef = useRef<number | null>(null);
  useEffect(() => {
    const index = pendingFocusIndexRef.current;
    if (index === null) return;
    pendingFocusIndexRef.current = null;
    // The exhausted Show more is gone; land on the first row it revealed
    // rather than dropping focus to the document.
    unrepliedListRef.current
      ?.querySelector<HTMLElement>(
        `[data-activity-row-index="${index}"] [tabindex="0"]`,
      )
      ?.focus();
  }, [unrepliedVisible]);

  if (status === 'loading' || status === 'idle') {
    return (
      <p
        role="status"
        data-testid="sidebar-activity-loading"
        className="px-3 py-2 text-s fg-secondary"
      >
        Loading activity…
      </p>
    );
  }
  if (status === 'error' || snapshot === null) {
    return (
      <ErrorState
        space="panel"
        message="Couldn't load activity."
        onRetry={retry}
        testId="sidebar-activity-error"
        retryTestId="sidebar-activity-retry"
      />
    );
  }

  const drafts = capabilities.chatDrafts === true ? snapshot.drafts : [];
  const unreplied = snapshot.unreplied.slice(0, unrepliedVisible);
  const remaining = snapshot.unreplied.length - unreplied.length;
  if (
    snapshot.unread.length === 0 &&
    drafts.length === 0 &&
    snapshot.unreplied.length === 0
  ) {
    return (
      <div
        data-testid="sidebar-activity-empty"
        className="flex flex-col items-center gap-1 px-3 py-6 text-center"
      >
        <p className="text-s fg-primary">No activity</p>
        <p className="text-xs fg-secondary">
          Unread, draft, and unreplied chats appear here
        </p>
      </div>
    );
  }

  const renderRows = (
    entries: readonly SidebarActivityEntry[],
  ): JSX.Element[] =>
    entries.map((entry, index) => (
      <SidebarActivityRow
        key={entry.key}
        entry={entry}
        index={index}
        // A muted space shows no dot, even on a row built before the mute.
        unread={
          host.unreadKeys.has(entry.key) &&
          !isSidebarActivityEntryMuted(host, entry)
        }
        selected={host.activeChatKey === entry.key}
        touch={touch}
        working={
          entry.kind === 'worktree-chat'
            ? worktrees.get(
                JSON.stringify([entry.workspaceLocalId, entry.worktreeLocalId]),
              )?.isStreaming === true
            : chats.get(JSON.stringify([entry.projectLocalId, entry.chatId]))
                ?.hasActiveChat === true
        }
        awaitingApproval={
          entry.kind === 'worktree-chat' &&
          worktrees.get(
            JSON.stringify([entry.workspaceLocalId, entry.worktreeLocalId]),
          )?.awaitingApproval === true
        }
        pipelineStatus={
          entry.kind === 'worktree-chat'
            ? worktrees.get(
                JSON.stringify([entry.workspaceLocalId, entry.worktreeLocalId]),
              )?.pipelineStatus
            : undefined
        }
        onOpen={onOpen}
      />
    ));

  return (
    <div data-testid="sidebar-activity" ref={leadMaskRef} className="pt-1">
      {snapshot.unread.length > 0 && (
        <SidebarActivitySection name="unread" label="Unread">
          {renderRows(snapshot.unread)}
        </SidebarActivitySection>
      )}
      {drafts.length > 0 && (
        <SidebarActivitySection name="drafts" label="Drafts">
          {renderRows(drafts)}
        </SidebarActivitySection>
      )}
      {snapshot.unreplied.length > 0 && (
        <div ref={unrepliedListRef}>
          <SidebarActivitySection
            name="unreplied"
            label="Unreplied"
            footer={
              remaining > 0 ? (
                <button
                  type="button"
                  onClick={(): void => {
                    if (remaining <= SIDEBAR_ACTIVITY_UNREPLIED_PAGE_SIZE)
                      pendingFocusIndexRef.current = unreplied.length;
                    showMore();
                  }}
                  aria-label={`Show more unreplied chats (${remaining} remaining)`}
                  data-testid="sidebar-activity-show-more"
                  className={`focus-ring flex w-full items-center rounded-md px-2 text-left text-s fg-secondary hover:bg-subtle hover:fg-primary ${touch ? 'min-h-11' : 'h-8'}`}
                >
                  Show more ({remaining})
                </button>
              ) : null
            }
          >
            {renderRows(unreplied)}
          </SidebarActivitySection>
        </div>
      )}
    </div>
  );
}

export interface SidebarActivityModeSwitchProps {
  readonly host: SidebarActivityHost | undefined;
  readonly capabilities: CanopyCapabilities;
  readonly touch?: boolean;
  readonly liveSnapshot?: SidebarActivityModeViewProps['liveSnapshot'];
  /** The workspace tree Activity replaces. */
  readonly tree: ReactNode;
  /** Called after Activity turns on or off, not on mount. */
  readonly onModeChange?: () => void;
}

/** Renders the Activity list in place of the tree while Activity is on. */
export function SidebarActivityModeSwitch({
  host,
  capabilities,
  touch,
  liveSnapshot,
  tree,
  onModeChange,
}: SidebarActivityModeSwitchProps): JSX.Element {
  const active = useSidebarActivityGate(host, capabilities);
  const onModeChangeRef = useRef(onModeChange);
  onModeChangeRef.current = onModeChange;
  const previousRef = useRef(active);
  useEffect(() => {
    if (previousRef.current === active) return;
    previousRef.current = active;
    onModeChangeRef.current?.();
  }, [active]);
  return active && host !== undefined ? (
    <SidebarActivityModeView
      host={host}
      capabilities={capabilities}
      touch={touch}
      liveSnapshot={liveSnapshot}
    />
  ) : (
    <>{tree}</>
  );
}
