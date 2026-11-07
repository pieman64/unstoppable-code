import { Button, Heading, Surface } from '@canopy/ui-shared/components';
import {
  Fragment,
  useCallback,
  useState,
  type FocusEvent,
  type JSX,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CHAT_UNIT_LABEL_PLURAL } from '@canopy/protocol';
import { PageTitlebar } from '../shared/PageTitlebar';
import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';
import {
  deriveWorktreeMenuItems,
  SidebarRowFrame,
  type WorktreeMenuCallbacks,
} from '@canopy/ui-app';
import {
  ChatPreviewPopover,
  WorktreeActionsMenu,
  WorktreeRow,
  openWorktreeActionsMenuAt,
  worktreeActionsMenuButtonCount,
} from '@canopy/ui-shared/components';
import {
  ChevronDownIcon,
  DragHandleIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  DEFAULT_LEADING_PRIORITY_ENTRIES,
  DEMO_UNREAD_PREVIEW_ROWS,
  LEADING_PRIORITY_ITEMS,
  LEADING_PRIORITY_STORAGE_KEY,
  LEGEND_ENTRIES,
  NOT_PROMOTED_DIVIDER_ID,
  WORKTREE_STATE_GALLERY_SECTIONS,
  parseStoredLeadingPriority,
  sectionSlug,
  type WorktreeGalleryState,
} from './worktreeStateGalleryData';

/**
 * Dev-only reference page rendering the shared sidebar `WorktreeRow` in every
 * status the row can express, via direct props — including states that have no
 * runtime seeding seam (split-PR phases, setup phases, discovery). Reachable
 * from the sidebar More menu in dev and E2E builds only; the page itself stays
 * mounted-on-demand in all builds so navigation can never dead-end.
 */

const noop = (): void => {};

/**
 * The desktop sidebar's row commands, inert. Fed through the sidebar's own
 * `deriveWorktreeMenuItems`, so each row shows the same More menu and hover
 * buttons (Archive on a done row, Show on a hidden one) the real row does.
 */
const DEMO_MENU_CALLBACKS: WorktreeMenuCallbacks = {
  onTogglePinnedRequested: noop,
  onSetLabelRequested: noop,
  onBranchInfoRequested: noop,
  onLaunchRequested: noop,
  onDispatchPipelineRequested: noop,
  onCreateBranchRequested: noop,
  onToggleHiddenRequested: noop,
  onRemovalRequested: noop,
};

/** Fixed demo age, so the focused rows show their trailing age as live. */
const DEMO_LAST_ACTIVITY_AT = Date.now() - 3 * 60 * 60 * 1000;

function demoRowActions(
  state: WorktreeGalleryState,
  renameLabelAction: boolean,
): {
  node: JSX.Element;
  buttonCount: number;
} {
  const done = state.props.uiStatus === 'done';
  const menu = deriveWorktreeMenuItems(
    {
      subject: 'worktree',
      label: state.label,
      branch: `demo/${state.id}`,
      hidden: false,
      pinned: false,
      done,
      launchAvailable: true,
      launchRunning: false,
      pipelineAvailable: true,
      splitPrEligible: false,
      splitPrLocked: false,
      splitPrBlockers: [],
      addRepositoryAvailable: false,
      hasActiveSession: state.props.isStreaming === true,
      removalLockedBySplitPr: false,
      renameLabelAction,
    },
    {
      pipelines: 'execute',
      removal: { behavior: 'archive', presentation: 'archive' },
    },
    DEMO_MENU_CALLBACKS,
  );
  return {
    node: (
      <WorktreeActionsMenu
        items={menu.items}
        directActions={menu.directActions}
        accessibleLabel={`Actions for ${state.label}`}
        triggerTestId={`gallery-row-menu-${state.id}`}
      />
    ),
    buttonCount: worktreeActionsMenuButtonCount(menu),
  };
}

interface GalleryStateRowProps {
  state: WorktreeGalleryState;
  statusModel: 'classic' | 'focused';
  selected: boolean;
  onSelect: (id: string) => void;
}

function GalleryStateRow({
  state,
  statusModel,
  selected,
  onSelect,
}: GalleryStateRowProps): JSX.Element {
  // Mirrors WorktreeItem's unread wiring: hover/focus on the blue dot anchors
  // the real ChatPreviewPopover (here fed with sample rows instead of live
  // chat tails).
  const [unreadAnchorRect, setUnreadAnchorRect] = useState<DOMRect | null>(
    null,
  );
  const showUnreadPopover = useCallback(
    (target: HTMLElement): void =>
      setUnreadAnchorRect(target.getBoundingClientRect()),
    [],
  );
  const hideUnreadPopover = useCallback(
    (): void => setUnreadAnchorRect(null),
    [],
  );
  const handleUnreadMouseEnter = useCallback(
    (event: MouseEvent<HTMLSpanElement>): void =>
      showUnreadPopover(event.currentTarget),
    [showUnreadPopover],
  );
  const handleUnreadFocus = useCallback(
    (event: FocusEvent<HTMLSpanElement>): void =>
      showUnreadPopover(event.currentTarget),
    [showUnreadPopover],
  );
  const hasUnread = state.props.hasUnread === true;
  const unreadPopoverSlot =
    hasUnread && unreadAnchorRect ? (
      <ChatPreviewPopover
        anchorRect={unreadAnchorRect}
        rows={DEMO_UNREAD_PREVIEW_ROWS}
        heading={`Unread ${CHAT_UNIT_LABEL_PLURAL}`}
      />
    ) : undefined;
  // Early access (the focused status model): "Rename", as the sidebar reads.
  const actions = demoRowActions(state, statusModel === 'focused');
  return (
    <Fragment>
      {/* `sidebar-instant-interactions` zeroes descendant transitions, exactly
          like the real sidebar's <aside> wrapper — hover reveal is 0ms. The
          frame, menu, and hover buttons are the sidebar's own. */}
      <div
        data-testid={`gallery-row-${state.id}`}
        className="sidebar-instant-interactions min-w-0"
      >
        <SidebarRowFrame
          variant="bare"
          selected={selected}
          onClick={(): void => onSelect(state.id)}
          onContextMenu={(event): void => {
            if (
              openWorktreeActionsMenuAt(event.currentTarget, {
                x: event.clientX,
                y: event.clientY,
              })
            ) {
              event.preventDefault();
            }
          }}
        >
          <WorktreeRow
            branchLabel={state.label}
            branchName={`demo/${state.id}`}
            worktreeId={state.id}
            displayMode="list"
            textScale="sidebar"
            statusModel={statusModel}
            selected={selected}
            {...(statusModel === 'focused'
              ? { lastActivityAt: DEMO_LAST_ACTIVITY_AT }
              : {})}
            unreadPopoverSlot={unreadPopoverSlot}
            onUnreadIconMouseEnter={
              hasUnread ? handleUnreadMouseEnter : undefined
            }
            onUnreadIconMouseLeave={hasUnread ? hideUnreadPopover : undefined}
            onUnreadIconFocus={hasUnread ? handleUnreadFocus : undefined}
            onUnreadIconBlur={hasUnread ? hideUnreadPopover : undefined}
            actionChipSlot={actions.node}
            actionChipButtonCount={actions.buttonCount}
            {...state.props}
            dataTestId={`gallery-worktree-row-${state.id}`}
          />
        </SidebarRowFrame>
      </div>
      <p className="self-center text-xs leading-relaxed fg-secondary">
        {state.description}
      </p>
    </Fragment>
  );
}

function readStoredPriority(): string[] {
  try {
    return parseStoredLeadingPriority(
      window.localStorage.getItem(LEADING_PRIORITY_STORAGE_KEY),
    );
  } catch {
    return [...DEFAULT_LEADING_PRIORITY_ENTRIES];
  }
}

function persistPriority(entries: string[]): void {
  try {
    window.localStorage.setItem(
      LEADING_PRIORITY_STORAGE_KEY,
      JSON.stringify(entries),
    );
  } catch {
    // Dev-only convenience persistence; losing it is harmless.
  }
}

interface SortablePriorityRowProps {
  id: string;
  children: ReactNode;
}

/** Same sortable-row shape CustomizeSidebarModal uses. */
function SortablePriorityRow({
  id,
  children,
}: SortablePriorityRowProps): JSX.Element {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
      }}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}

function buildPriorityProposalText(entries: string[]): string {
  const dividerIndex = entries.indexOf(NOT_PROMOTED_DIVIDER_ID);
  const promoted = entries.slice(0, dividerIndex);
  const notPromoted = entries.slice(dividerIndex + 1);
  const lines = [
    'Leading icon priority proposal:',
    ...promoted.map(
      (id, index) => `${index + 1}. ${LEADING_PRIORITY_ITEMS[id]?.label ?? id}`,
    ),
    `Not promoted (subtitle only): ${
      notPromoted
        .map((id) => LEADING_PRIORITY_ITEMS[id]?.label ?? id)
        .join(', ') || '—'
    }`,
  ];
  return lines.join('\n');
}

/**
 * Drag-to-reorder proposal list for the leading-icon priority chain. This is
 * a design scratchpad: it persists to localStorage and can be copied as text,
 * but does NOT rewire `WorktreeRow` — the row's real chain stays in code
 * until a chosen order is implemented.
 */
function LeadingPriorityCard(): JSX.Element {
  const [entries, setEntries] = useState<string[]>(readStoredPriority);
  const [copied, setCopied] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = useCallback((event: DragEndEvent): void => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setEntries((current) => {
      const from = current.indexOf(String(active.id));
      const to = current.indexOf(String(over.id));
      if (from === -1 || to === -1) return current;
      const next = arrayMove(current, from, to);
      persistPriority(next);
      return next;
    });
  }, []);

  const handleReset = useCallback((): void => {
    const next = [...DEFAULT_LEADING_PRIORITY_ENTRIES];
    setEntries(next);
    persistPriority(next);
  }, []);

  const handleCopy = useCallback((): void => {
    void navigator.clipboard
      .writeText(buildPriorityProposalText(entries))
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Clipboard denied — nothing to do in a dev tool.
      });
  }, [entries]);

  const dividerIndex = entries.indexOf(NOT_PROMOTED_DIVIDER_ID);

  return (
    <Surface
      data-testid="leading-priority-list"
      variant="inset"
      padding="default"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <Heading level={2} variant="title">
            Leading icon priority
          </Heading>
          <p className="mt-1 text-xs leading-relaxed fg-secondary">
            Drag to build your proposed order. Items above the divider claim the
            leading slot (top wins); items below stay subtitle-only. This is a
            proposal tool — the row&apos;s real chain stays as implemented until
            an order is chosen and coded.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="compact"
            onClick={handleReset}
            data-testid="priority-reset"
          >
            Reset to implemented
          </Button>
          <Button
            variant="primary"
            size="compact"
            onClick={handleCopy}
            data-testid="priority-copy"
          >
            {copied ? 'Copied' : 'Copy order'}
          </Button>
        </div>
      </div>
      <div className="mt-3 max-w-xl">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={entries}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col gap-1">
              {entries.map((id, index) => {
                if (id === NOT_PROMOTED_DIVIDER_ID) {
                  return (
                    <SortablePriorityRow key={id} id={id}>
                      <Surface
                        variant="dashed"
                        size="small"
                        className="cursor-default"
                        data-testid="priority-not-promoted-divider"
                      >
                        <div className="flex items-center gap-2 px-3 py-2 text-xs font-normal fg-secondary">
                          <ChevronDownIcon size="sm" />
                          Not promoted (subtitle only)
                        </div>
                      </Surface>
                    </SortablePriorityRow>
                  );
                }
                const item = LEADING_PRIORITY_ITEMS[id];
                if (!item) return null;
                const rank = index < dividerIndex ? index + 1 : null;
                return (
                  <SortablePriorityRow key={id} id={id}>
                    <div
                      data-testid={`priority-row-${id}`}
                      className="flex cursor-default items-center gap-2.5 rounded-md px-3 py-2 text-s font-normal fg-primary hover:bg-secondary"
                    >
                      <span className="fg-quaternary">
                        <DragHandleIcon size={12} />
                      </span>
                      <span className="w-4 text-right text-xs tabular-nums fg-tertiary">
                        {rank ?? '·'}
                      </span>
                      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                        {item.icon}
                      </span>
                      <span className="min-w-0">
                        {item.label}
                        <span className="ml-2 text-xs fg-tertiary">
                          {item.description}
                        </span>
                      </span>
                    </div>
                  </SortablePriorityRow>
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </Surface>
  );
}

export function WorktreeStateGalleryPage(): JSX.Element {
  // Rows follow the same early-access switch as the real sidebar, so the page
  // shows the status model the user would see.
  const statusModel = useLabsExperimentEnabled('sidebar')
    ? 'focused'
    : 'classic';
  // Clicking a row selects it, as in the sidebar.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <section
      className="flex h-full flex-col"
      data-testid="page-worktree-states"
      data-status-model={statusModel}
    >
      <PageTitlebar />
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-12">
        <div className="mx-auto max-w-5xl space-y-8">
          <div className="space-y-2">
            <Heading level={1} variant="page">
              Worktree States
            </Heading>
            <p className="text-s fg-secondary">
              Every state the sidebar worktree row can express, rendered by the
              real shared component with direct props. Hover any row to see the
              trailing status cluster line up beside the action buttons. This
              page is only reachable in dev and E2E builds.
            </p>
            <p
              className="text-s fg-secondary"
              data-testid="worktree-states-model"
            >
              {statusModel === 'focused'
                ? 'Showing the focused status model. Turn off early access in Settings, Labs to see the classic rows.'
                : 'Showing the classic status model. Turn on early access in Settings, Labs to see the focused rows.'}
            </p>
          </div>

          <LeadingPriorityCard />

          <Surface
            data-testid="state-color-legend"
            variant="inset"
            padding="default"
          >
            <Heading level={2} variant="title">
              Color legend
            </Heading>
            <ul className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2 md:grid-cols-2">
              {LEGEND_ENTRIES.map((entry) => (
                <li key={entry.title} className="flex items-start gap-2.5">
                  <span
                    aria-hidden="true"
                    className={`mt-1 inline-flex h-4 w-4 shrink-0 items-center justify-center ${entry.toneClassName}`}
                  >
                    <span className="h-2 w-2 rounded-full bg-current" />
                  </span>
                  <span className="min-w-0 text-xs leading-relaxed">
                    <span className="font-medium fg-primary">
                      {entry.title}
                    </span>{' '}
                    <span className="fg-secondary">{entry.description}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Surface>

          {WORKTREE_STATE_GALLERY_SECTIONS.map((section) => (
            <Surface
              key={section.title}
              data-testid={`gallery-section-${sectionSlug(section.title)}`}
              variant="inset"
              padding="default"
            >
              <Heading level={2} variant="title">
                {section.title}
              </Heading>
              {section.description && (
                <p className="mt-1 text-xs leading-relaxed fg-secondary">
                  {section.description}
                </p>
              )}
              <div className="mt-3 grid grid-cols-[21.25rem_minmax(0,1fr)] items-center gap-x-8 gap-y-1.5">
                {section.states.map((state) => (
                  <GalleryStateRow
                    key={state.id}
                    state={state}
                    statusModel={statusModel}
                    selected={
                      selectedId === state.id || state.props.selected === true
                    }
                    onSelect={setSelectedId}
                  />
                ))}
              </div>
            </Surface>
          ))}
        </div>
      </div>
    </section>
  );
}
