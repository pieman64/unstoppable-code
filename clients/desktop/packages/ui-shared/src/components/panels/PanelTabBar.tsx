import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type NamedExoticComponent,
  type ReactNode,
} from 'react';
import { CloseMediumIcon, PinIcon } from '../../icons/AppIcons';
import { DragAndDropObserver } from '../../panels/dnd-observer';
import { useHorizontalOverflowScroll } from '../../lib/useHorizontalOverflowScroll';
import type { PanelDropEdge, PanelTabModel } from '../../panels/registry-types';
import { RichHoverTooltip } from '../RichHoverTooltip';
import { Tooltip } from '../Tooltip';
import { PanelAddTabButton } from './PanelAddTabButton';
import {
  clearPanelTabDrag,
  hasActivePanelTabDrag,
  readPanelTabDrag,
  startPanelTabDrag,
} from './panel-dnd';
import { PanelTabLiveReorderContext } from './panel-tab-live-reorder-context';

/**
 * The optional add-tab affordance of a group's tab bar. The shared layer is
 * app-agnostic: it only renders the `+` button (and an app-supplied menu
 * node); the app owns what "add" means, which panel kinds exist, and the
 * open/closed state of its menu.
 */
export interface PanelTabBarAddTab {
  /** Accessible label + tooltip copy for the button (app-provided). */
  label: string;
  /** Invoked with the owning group id when the button is clicked. */
  onAddTab: (groupId: string) => void;
  /** Independent one-click chat creation affordance. */
  addChat?: { label: string; onAddChat: (groupId: string) => void };
  /** Independent repeat action for the active Browser or Terminal. */
  quickAdd?: { label: string; onQuickAdd: (groupId: string) => void };
  /** Suppresses the direct primary action when this group is not eligible. */
  hidePrimary?: boolean;
  /**
   * Set when the group is full (it holds the most tabs a row takes): every
   * add affordance renders disabled and explains why with this note.
   */
  fullNote?: string;
  /**
   * Optional second affordance rendered right after the `+`: opens the
   * app-supplied add-panel menu. Hosts whose `+` performs a direct action
   * (desktop: new chat) use this for everything else.
   */
  addPanel?: {
    /** Accessible label + tooltip copy for the button. */
    label: string;
    /** Invoked with the owning group id when the button is clicked. */
    onAddPanel: (groupId: string) => void;
    /** App-supplied menu node, rendered inside the button's anchored wrapper. */
    menu?: ReactNode;
  };
  /**
   * App-supplied menu, rendered inside the button's anchored wrapper
   * (`position: relative`) while open. Presence means "open" and drives
   * `aria-expanded`; the app owns the state and dismissal behavior.
   */
  menu?: ReactNode;
}

/**
 * - `classic`: underlined tabs at their content width (down to a floor) in a
 *   strip that scrolls horizontally once they overflow.
 * - `fill`: Chrome-style tiles that hug their content while they fit and then
 *   share the row, shrinking down to their icon and further until every tab
 *   fits. The strip never scrolls, so hosts cap how many tabs a user opens
 *   into a row.
 */
export type PanelTabStyle = 'classic' | 'fill';

export interface PanelTabBarProps {
  groupId: string;
  /** Tabs in display order. */
  tabs: readonly PanelTabModel[];
  /** The selected tab of the group, or `null` for an empty group. */
  activePanelId: string | null;
  /** Disables tab drag sources. */
  draggable?: boolean;
  /** Matches {@link PanelIntentCallbacks.onSelectTab}. */
  onSelectTab: (groupId: string, panelId: string) => void;
  /** Matches {@link PanelIntentCallbacks.onCloseTab}. */
  onCloseTab: (groupId: string, panelId: string) => void;
  /** Host-neutral intent to open a tab; never selects or moves focus. */
  onTabIntent?: (
    groupId: string,
    tab: PanelTabModel,
    phase: 'start' | 'end',
    source: 'pointer' | 'focus',
  ) => void;
  /**
   * Whether a tab may be closed from the strip. Omitted means every tab is
   * closable, which is the historical behaviour.
   *
   * Hosts that route closing through their own workflow (the portal closes a
   * bound chat pane via a chat-close command, refusing while the chat is
   * streaming or the session is disconnected) need the control to reflect
   * that. Without it the button rendered enabled and silently did nothing.
   */
  canCloseTab?: (tab: PanelTabModel) => boolean;
  /**
   * Matches {@link PanelIntentCallbacks.onReorderTab}: a same-group tab-strip
   * drop reorders the tab to its final index. Omitted, same-group strip drops
   * do nothing.
   */
  onReorderTab?: (groupId: string, panelId: string, toIndex: number) => void;
  /**
   * Matches {@link PanelIntentCallbacks.onMovePanel}: a cross-group tab-strip
   * drop merges the dragged tab into this group (`edge: 'center'`) at the
   * indicated final index. Omitted, the strip accepts only its own tabs: a
   * tab dragged in from another group shows no insertion indicator.
   */
  onMovePanel?: (
    panelId: string,
    targetGroupId: string,
    edge: PanelDropEdge,
    targetIndex?: number,
  ) => void;
  /**
   * Whether a tab dragged in from another group may merge into this one
   * (matches {@link PanelIntentCallbacks.canDropPanel} for `center`). A
   * refused tab gets no insertion indicator and its drop is ignored.
   * Omitted, every cross-group merge is offered.
   */
  canMovePanelHere?: (panelId: string, targetGroupId: string) => boolean;
  /**
   * Optional per-tab icon (e.g. from the app's panel registry).
   *
   * Hovering a classic tab normally hides this icon and reveals the close
   * button in its slot; a `fill` tab shows the button at its right end
   * instead. An icon that renders a LIVE status glyph (a streaming spinner)
   * sets {@link PANEL_TAB_BUSY_ATTRIBUTE} on itself or a descendant: the
   * close button is then withheld for as long as the work runs (and a classic
   * tab keeps the icon visible on hover). Closing stays available from the
   * tab's context menu.
   */
  renderTabIcon?: (tab: PanelTabModel) => ReactNode;
  /**
   * Optional per-tab label renderer. When provided, its result REPLACES the
   * plain `tab.title` text inside the label wrapper (which keeps the string
   * `title` tooltip attribute either way). Used by apps to render live
   * per-entity labels (dynamic titles, status spinners, unread markers).
   */
  renderTabLabel?: (tab: PanelTabModel) => ReactNode;
  /**
   * Optional per-tab trailing content (e.g. unsaved-changes dot, read-only
   * lock). Classic tabs render it between the label and the close button;
   * `fill` tabs float it in the close button's box, which takes its place on
   * hover. Return nothing (not an empty wrapper) when there is no indicator:
   * `fill` styles reserve the box only while the slot has content.
   */
  renderTabTrailing?: (tab: PanelTabModel) => ReactNode;
  /**
   * Optional plain-string title resolver used for the native hover tooltip
   * and the close button's accessible name. Apps provide it so those strings
   * match the friendly labels from {@link renderTabLabel} instead of the raw
   * view-model `tab.title` (which falls back to the panel kind id).
   */
  getTabTitle?: (tab: PanelTabModel) => string;
  /**
   * Optional per-tab RICH tooltip renderer. A non-null result REPLACES the
   * native `title` tooltip for that tab (rendered through the shared
   * {@link Tooltip}, attached to the non-interactive label span so no
   * interactive control nests inside the trigger); `null`/omitted keeps the
   * plain string tooltip. Accessible names and the close button's label
   * still come from {@link getTabTitle}.
   */
  renderTabTooltip?: (tab: PanelTabModel) => ReactNode | null;
  /**
   * Optional per-tab hover CARD: a preview of what a background tab holds.
   * A non-null result replaces that tab's native `title` tooltip (and any
   * {@link renderTabTooltip}) with a card that opens after the pointer rests
   * on the label, hanging under the whole tab. Never asked for the active
   * tab, whose content is already on screen, or for pinned tabs, which keep
   * their own tooltip. The content mounts only while the card is open.
   */
  renderTabHoverCard?: (tab: PanelTabModel) => ReactNode | null;
  /** Optional add-tab affordance; omitted, no `+` button renders. */
  addTab?: PanelTabBarAddTab;
  /** How the tabs lay out; see {@link PanelTabStyle}. Defaults to classic. */
  tabStyle?: PanelTabStyle;
  /**
   * Optional right-click handler for a tab. Fired from a `contextmenu`
   * listener on each tab (default prevented) with the owning group id, the
   * tab's panel id, and the event's viewport coordinates. Kept optional so the
   * shared layer stays app-agnostic: the app builds and positions the actual
   * menu (pin/unpin, close, close others/right/left/all). Omitted, right-click
   * falls through to the platform default.
   */
  onTabContextMenu?: (
    groupId: string,
    panelId: string,
    clientX: number,
    clientY: number,
  ) => void;
}

/**
 * Marker attribute an app-supplied leading icon sets on itself (or a
 * descendant) while its panel is doing live work. Panel CSS reads it through
 * `:has()` to withhold the hover close button while the work runs. Classic
 * tabs also keep the status glyph visible on hover instead of swapping in the
 * close button, so a running tab never loses its only progress signal to a
 * pointer resting on it. See {@link PanelTabBarProps.renderTabIcon}.
 */
export const PANEL_TAB_BUSY_ATTRIBUTE = 'data-panel-tab-busy';

const PanelTabStyleContext = createContext<PanelTabStyle>('classic');

/** A fill tile's floor while every tile fits at it (panels.css). */
const FILL_TILE_FLOOR_PX = 20;
/** The narrowest fill tile that still shows its whole 14px icon. */
const FILL_ICON_PX = 14;
/** The gap between fill tiles while they fit at their floor. */
const FILL_TILE_GAP_PX = 4;
/** A pinned fill tile at rest: square, as wide as the 28px tile is tall. */
const FILL_PINNED_TILE_PX = 28;

/**
 * The narrowest a selected fill tab gets while the row has room for it: the
 * line's insets, the tab number, and about eight characters of title, wider
 * than the 79px at which its close button still shows on hover.
 */
const FILL_ACTIVE_TILE_FLOOR_PX = 96;

/**
 * Sizes crowded fill tiles so every tab stays in the row. The selected tab
 * (when unpinned) is served first: it keeps up to 96px, as long as the
 * others can still show their icons. The others then get 20px tiles with
 * 4px gaps while they all fit; then narrower tiles, down to their 14px icon;
 * then narrower gaps, down to none; and only then tiles narrower than their
 * icon. Pinned tiles stay square until the others are down to their icons.
 * Written as CSS variables on the bar (with the pinned count and the pinned
 * tiles' floor, for the pinned strip's own floor), so a resize costs no
 * render.
 */
function applyFillTileFloor(
  bar: HTMLElement,
  pinnedCount: number,
  unpinnedCount: number,
  activeUnpinned: boolean,
): void {
  const view = bar.ownerDocument.defaultView;
  const barStyle = view?.getComputedStyle(bar);
  // Unset or unparsable lengths count as 0.
  const length = (value: string | undefined): number =>
    Number.parseFloat(value ?? '') || 0;
  // The row's width for tiles and the gaps between them. Fractional, unlike
  // `clientWidth`, so the room is never overstated by rounding.
  let room =
    bar.getBoundingClientRect().width -
    length(barStyle?.paddingLeft) -
    length(barStyle?.paddingRight);
  for (const child of Array.from(bar.children)) {
    if (child.classList.contains('canopy-panel-tab-strip-wrap')) {
      // Each strip's own end padding.
      const strip = child.querySelector('.canopy-panel-tab-strip');
      const stripStyle =
        strip === null ? undefined : view?.getComputedStyle(strip);
      room -=
        length(stripStyle?.paddingLeft) + length(stripStyle?.paddingRight);
      continue;
    }
    // The pinned divider and the add-tab button keep their size.
    const style = view?.getComputedStyle(child);
    room -=
      child.getBoundingClientRect().width +
      length(style?.marginLeft) +
      length(style?.marginRight);
  }
  // Pinned tiles stay square (as wide as the 28px tile is tall) while the
  // other tabs can still show whole icons and gaps beside them; they then
  // leave the row and the others share what is left. A row too crowded for
  // that shrinks them with the rest.
  const pinnedSquare =
    pinnedCount > 0 &&
    room -
      FILL_PINNED_TILE_PX * pinnedCount -
      FILL_TILE_GAP_PX * (pinnedCount - 1) >=
      FILL_ICON_PX * unpinnedCount +
        FILL_TILE_GAP_PX * Math.max(0, unpinnedCount - 1);
  if (pinnedSquare) {
    room -=
      FILL_PINNED_TILE_PX * pinnedCount + FILL_TILE_GAP_PX * (pinnedCount - 1);
  }
  const sharingPinned = pinnedSquare ? 0 : pinnedCount;
  const tiles = sharingPinned + unpinnedCount;
  const gaps = Math.max(0, sharingPinned - 1) + Math.max(0, unpinnedCount - 1);
  const reservesActive = activeUnpinned && unpinnedCount > 0;
  const others = reservesActive ? tiles - 1 : tiles;
  // The selected tab's share, while the others keep whole icons and gaps:
  // never more than 96px (it is a floor, not a width), and never less than
  // an even share of a crowded row.
  const activeFloor = reservesActive
    ? Math.min(
        FILL_ACTIVE_TILE_FLOOR_PX,
        Math.max(
          room - FILL_TILE_GAP_PX * gaps - FILL_ICON_PX * others,
          (room - FILL_TILE_GAP_PX * gaps) / tiles,
          0,
        ),
      )
    : FILL_ACTIVE_TILE_FLOOR_PX;
  const othersRoom = reservesActive ? room - activeFloor : room;
  let gap = FILL_TILE_GAP_PX;
  let floor = FILL_TILE_FLOOR_PX;
  if (others > 0) {
    floor = (othersRoom - gap * gaps) / others;
    if (floor < FILL_ICON_PX && gaps > 0) {
      gap = Math.min(
        FILL_TILE_GAP_PX,
        Math.max(0, (othersRoom - FILL_ICON_PX * others) / gaps),
      );
      floor = (othersRoom - gap * gaps) / others;
    }
    floor = Math.min(FILL_TILE_FLOOR_PX, Math.max(0, floor));
  }
  // Rounded down, so rounding never pushes the last tile out of the row.
  const px = (value: number): string => `${Math.floor(value * 100) / 100}px`;
  bar.style.setProperty('--canopy-panel-tab-floor', px(floor));
  bar.style.setProperty('--canopy-panel-tab-active-floor', px(activeFloor));
  bar.style.setProperty('--canopy-panel-tab-gap', px(gap));
  bar.style.setProperty('--canopy-panel-pinned-count', String(pinnedCount));
  bar.style.setProperty(
    '--canopy-panel-pinned-floor',
    px(pinnedSquare ? FILL_PINNED_TILE_PX : floor),
  );
}

/**
 * The style of the tab bar rendering the caller: app-supplied tab renderers
 * (icon, trailing) read it to match the bar they sit in. Anywhere outside a
 * tab bar, such as a collapsed group's icon strip, it reads `classic`.
 */
export function usePanelTabStyle(): PanelTabStyle {
  return useContext(PanelTabStyleContext);
}

const PanelTabPositionContext = createContext<number | null>(null);

/**
 * The 1-based place of the tab whose icon is rendering, counted across its
 * strip (fill tabs only). A strip holds at most `MAX_TABS_PER_GROUP` (20)
 * tabs, so this runs 1 to 20. `null` outside a fill tab's icon slot.
 */
export function usePanelTabPosition(): number | null {
  return useContext(PanelTabPositionContext);
}

/**
 * A tab's place in its strip, drawn in the icon slot in the title's own font
 * and size, a step quieter (tertiary ink). Centered in a fixed 16px square
 * that fits up to "20" at 13px (a strip holds at most 20 tabs), so the label
 * never moves; the digits keep the font's own proportional widths.
 */
export function PanelTabNumber({
  position,
}: {
  readonly position: number;
}): JSX.Element {
  return (
    <span
      className="inline-flex size-4 shrink-0 items-center justify-center leading-none fg-tertiary"
      data-testid="panel-tab-number"
    >
      {position}
    </span>
  );
}

/**
 * Supplies {@link usePanelTabStyle} to tab renderers drawn outside a tab bar
 * that should still match one (and to tests). Every tab bar provides its own.
 */
export function PanelTabStyleProvider({
  value,
  children,
}: {
  value: PanelTabStyle;
  children: ReactNode;
}): JSX.Element {
  return (
    <PanelTabStyleContext.Provider value={value}>
      {children}
    </PanelTabStyleContext.Provider>
  );
}

function CloseGlyph(): JSX.Element {
  // 14px to match `.canopy-panel-tab-icon`, the slot it covers on hover.
  return <CloseMediumIcon width={14} height={14} />;
}

function PinGlyph(): JSX.Element {
  return <PinIcon width={10} height={10} />;
}

/**
 * Reveals `tab` inside the horizontally scrollable strip (ChatTabBar's
 * scroll-into-view convention: mutate `scrollLeft` only, never scroll
 * ancestors, and align to the nearest edge).
 */
function scrollTabIntoView(
  container: HTMLDivElement,
  tab: HTMLDivElement,
): void {
  const containerRect = container.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  const tabLeft = tabRect.left - containerRect.left + container.scrollLeft;
  const tabRight = tabLeft + tabRect.width;
  const visibleLeft = container.scrollLeft;
  const visibleRight = visibleLeft + container.clientWidth;

  if (tabLeft < visibleLeft) {
    container.scrollLeft = tabLeft;
  } else if (tabRight > visibleRight) {
    container.scrollLeft = tabRight - container.clientWidth;
  }
}

/** Snapshot of the props the strip drop-target callbacks need (kept in a ref
 * so the one-shot observer always sees the latest render's values). */
interface TabStripDndSnapshot {
  groupId: string;
  tabs: readonly PanelTabModel[];
  onReorderTab?: (groupId: string, panelId: string, toIndex: number) => void;
  onMovePanel?: (
    panelId: string,
    targetGroupId: string,
    edge: PanelDropEdge,
    targetIndex?: number,
  ) => void;
  canMovePanelHere?: (panelId: string, targetGroupId: string) => boolean;
}

/** How long the pointer rests on a tab's label before its hover card opens. */
const TAB_HOVER_CARD_OPEN_DELAY_MS = 500;
/** The card hangs this far under the tab. */
const TAB_HOVER_CARD_GAP_PX = 8;

/** The card is placed against the whole tab, not just its label. */
function tabAroundLabel(trigger: HTMLElement): Element | null {
  return trigger.closest('[role="tab"]');
}

/**
 * A tab's label with its hover card: no native `title`, and a card that hangs
 * under the whole tab with their left edges lined up (or right edges, near
 * the window's right edge). The sidebar worktree card's delay and surface.
 * The trigger mounts its controller only once the pointer arrives, so a strip
 * of tabs costs nothing until one is hovered.
 */
function PanelTabTitleWithHoverCard({
  panelId,
  card,
  children,
}: {
  panelId: string;
  card: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <span className="canopy-panel-tab-title">
      <RichHoverTooltip
        content={card}
        dataTestId={`panel-tab-hover-card-${panelId}`}
        deferUntilInteraction
        openDelay={TAB_HOVER_CARD_OPEN_DELAY_MS}
        elevation="menu"
        surfacePadding="compact"
        surfaceClassName="w-70"
        triggerWrapperClassName="min-w-0 max-w-full"
        placement="below-start"
        placementGap={TAB_HOVER_CARD_GAP_PX}
        getPlacementAnchor={tabAroundLabel}
      >
        <span className="truncate">{children}</span>
      </RichHoverTooltip>
    </span>
  );
}

/**
 * The tab strip of a panel group. Roving-tabindex keyboard model:
 * ArrowLeft/ArrowRight move focus between tabs (wrapping), Enter/Space
 * select the focused tab.
 *
 * Classic tabs ({@link PanelTabStyle}): overflowing tabs scroll horizontally
 * (CSS, hidden scrollbar): vertical mouse-wheel deltas pan the strip, and the
 * active tab is kept scrolled into view on selection/insertion (both
 * ChatTabBar conventions); there is no overflow menu yet.
 *
 * Fill tabs: unpinned tabs hug their content while they fit; then the active
 * tab keeps its content width and the others share the rest, Chrome-style
 * (panels.css). The strip never scrolls, so every tab is always in view.
 * Closing a tab with the pointer holds the remaining unpinned tabs at their
 * widths until the pointer leaves the strip, so the next tab's close button
 * lands under the pointer, as in Chrome.
 *
 * Each tab is a `role="tab"` element (a div, not a `<button>`, because the
 * per-tab close affordance is a real button and buttons must not nest).
 *
 * Drag & drop (Phase 6): tabs are draggable — dragstart writes the tab's
 * identity into the panel-tab transfer singleton (never `dataTransfer`,
 * which is unreadable during dragover) and dragend clears it. The strip is a
 * drop target (via {@link DragAndDropObserver}, counter-based enter/leave):
 * dragover with an active panel-tab drag shows an insertion indicator at the
 * nearest tab boundary; drop either reorders within this group
 * ({@link PanelTabBarProps.onReorderTab}) or merges a tab from another group
 * (`onMovePanel(..., 'center')`).
 *
 * Fill tabs reorder live instead where the host offers it
 * ({@link PanelTabLiveReorderContext}); elsewhere they keep the marker.
 *
 * The optional add-tab button sits OUTSIDE the scrollable strip so it never
 * scrolls away with overflowing tabs, and so the app-supplied menu anchored
 * to it is not clipped by the strip's `overflow-x: auto`.
 */
function PanelTabBarComponent({
  groupId,
  tabs,
  activePanelId,
  draggable = true,
  onSelectTab,
  onCloseTab,
  onTabIntent,
  canCloseTab,
  onReorderTab,
  onMovePanel,
  canMovePanelHere,
  renderTabIcon,
  renderTabLabel,
  renderTabTrailing,
  getTabTitle,
  renderTabTooltip,
  renderTabHoverCard,
  addTab,
  tabStyle = 'classic',
  onTabContextMenu,
}: PanelTabBarProps): JSX.Element {
  const fill = tabStyle === 'fill';
  const [focusedPanelId, setFocusedPanelId] = useState<string | null>(null);
  const tabElementsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  // Two scroll strips, each with its own wheel/overflow/thumb hook: pinned
  // tabs render in a left-anchored, bounded strip; unpinned tabs own the
  // remaining space (the ChatTabBar split). The DnD observer, drop-indicator
  // math, and active-tab reveal address the FULL `tabs` array (pinned first),
  // regardless of which strip a tab renders in.
  const pinnedScroll = useHorizontalOverflowScroll<HTMLDivElement>();
  const unpinnedScroll = useHorizontalOverflowScroll<HTMLDivElement>();
  // Fill strips never scroll, so they take plain refs and the scroll hooks
  // never attach to them (no wheel panning, no overflow observers).
  const pinnedFillRef = useRef<HTMLDivElement>(null);
  const unpinnedFillRef = useRef<HTMLDivElement>(null);
  const pinnedStripRef = fill ? pinnedFillRef : pinnedScroll.ref;
  const unpinnedStripRef = fill ? unpinnedFillRef : unpinnedScroll.ref;

  const pinnedTabs = tabs.filter((tab) => tab.pinned === true);
  const unpinnedTabs = tabs.filter((tab) => tab.pinned !== true);
  const hasPinnedStrip = pinnedTabs.length > 0;
  const pinnedCount = pinnedTabs.length;
  const unpinnedCount = unpinnedTabs.length;
  const activeUnpinned = unpinnedTabs.some(
    (tab) => tab.panelId === activePanelId,
  );

  // Fill tiles shrink below their 20px floor when that is what it takes for
  // every tab to stay in the row (see `applyFillTileFloor`). The add button
  // takes room too, so its presence is a dependency.
  const barRef = useRef<HTMLDivElement>(null);
  const hasAddTab = addTab !== undefined;
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!fill || bar === null) {
      return undefined;
    }
    const update = (): void =>
      applyFillTileFloor(bar, pinnedCount, unpinnedCount, activeUnpinned);
    update();
    const view = bar.ownerDocument.defaultView;
    const observer =
      view && 'ResizeObserver' in view ? new view.ResizeObserver(update) : null;
    observer?.observe(bar);
    // The add-tab control and the pinned divider take room inside the bar:
    // one can grow (the quick-add button appears beside `+` when a browser
    // or terminal tab is selected) without the bar resizing.
    for (const child of Array.from(bar.children)) {
      if (!child.classList.contains('canopy-panel-tab-strip-wrap')) {
        observer?.observe(child);
      }
    }
    return (): void => {
      observer?.disconnect();
      bar.style.removeProperty('--canopy-panel-tab-floor');
      bar.style.removeProperty('--canopy-panel-tab-active-floor');
      bar.style.removeProperty('--canopy-panel-tab-gap');
      bar.style.removeProperty('--canopy-panel-pinned-count');
      bar.style.removeProperty('--canopy-panel-pinned-floor');
    };
  }, [fill, pinnedCount, unpinnedCount, activeUnpinned, hasAddTab]);

  // Drag state: which of OUR tabs is being dragged (styling only), and where
  // the insertion indicator sits (an index into `tabs`, `tabs.length` = end).
  const [draggingPanelId, setDraggingPanelId] = useState<string | null>(null);
  const [dropIndicatorIndex, setDropIndicatorIndex] = useState<number | null>(
    null,
  );

  // Latest-render snapshot for the strip observer (registered once per strip).
  const dndSnapshotRef = useRef<TabStripDndSnapshot>({
    groupId,
    tabs,
    onReorderTab,
    onMovePanel,
    canMovePanelHere,
  });
  dndSnapshotRef.current = {
    groupId,
    tabs,
    onReorderTab,
    onMovePanel,
    canMovePanelHere,
  };

  // Strip drop targets: one DragAndDropObserver per rendered strip (pinned +
  // unpinned). Each observer preventDefault()s dragover (required for `drop`)
  // and normalizes enter/leave with the counter trick. `insertionIndexAt`
  // walks the FULL tab list so a drop on either strip resolves a full-array
  // index; the store then clamps a reorder to the dragged tab's own partition.
  // Re-runs when the pinned strip mounts/unmounts (a tab was pinned/unpinned).
  useEffect(() => {
    const strips = [pinnedStripRef.current, unpinnedStripRef.current].filter(
      (element): element is HTMLDivElement => element !== null,
    );

    if (strips.length === 0) {
      return undefined;
    }

    const insertionIndexAt = (clientX: number): number => {
      const { tabs: currentTabs } = dndSnapshotRef.current;

      for (let index = 0; index < currentTabs.length; index++) {
        const element = tabElementsRef.current.get(currentTabs[index].panelId);

        if (!element) {
          continue;
        }

        const rect = element.getBoundingClientRect();

        if (clientX <= rect.left + rect.width / 2) {
          return index;
        }
      }

      return currentTabs.length;
    };

    const observers = strips.map(
      (strip) =>
        new DragAndDropObserver(strip, {
          onDragOver: (event): void => {
            if (!hasActivePanelTabDrag()) {
              return;
            }

            // Without a move intent the strip only reorders its own tabs,
            // and a merge the layout owner would refuse shows no indicator.
            const {
              groupId: stripGroupId,
              onMovePanel: move,
              canMovePanelHere: canMove,
            } = dndSnapshotRef.current;
            const dragged = readPanelTabDrag();

            if (
              dragged?.sourceGroupId !== stripGroupId &&
              (move === undefined ||
                (dragged !== null &&
                  canMove?.(dragged.panelId, stripGroupId) === false))
            ) {
              setDropIndicatorIndex(null);
              return;
            }

            setDropIndicatorIndex(insertionIndexAt(event.clientX));
          },
          onDragLeave: (): void => {
            setDropIndicatorIndex(null);
          },
          onDragEnd: (): void => {
            setDropIndicatorIndex(null);
          },
          onDrop: (event): void => {
            setDropIndicatorIndex(null);

            const dragged = readPanelTabDrag();

            if (!dragged) {
              return;
            }

            clearPanelTabDrag();

            const {
              groupId: targetGroupId,
              tabs: currentTabs,
              onReorderTab: reorder,
              onMovePanel: move,
              canMovePanelHere: canMove,
            } = dndSnapshotRef.current;

            const insertionIndex = insertionIndexAt(event.clientX);

            if (dragged.sourceGroupId !== targetGroupId) {
              if (canMove?.(dragged.panelId, targetGroupId) === false) {
                return;
              }
              // Cross-group strip drop: merge into this group at the exact
              // boundary advertised by the insertion indicator.
              move?.(dragged.panelId, targetGroupId, 'center', insertionIndex);
              return;
            }

            const fromIndex = currentTabs.findIndex(
              (tab) => tab.panelId === dragged.panelId,
            );

            if (fromIndex === -1) {
              return;
            }

            // The insertion index addresses the CURRENT array; removing the
            // tab first shifts later positions down by one (VS Code's
            // off-by-one fix), producing the final-array index the intent
            // contract wants. The store clamps it to the dragged tab's own
            // pinned/unpinned partition.
            const toIndex =
              insertionIndex > fromIndex ? insertionIndex - 1 : insertionIndex;

            if (toIndex !== fromIndex) {
              reorder?.(targetGroupId, dragged.panelId, toIndex);
            }
          },
        }),
    );

    return (): void => {
      for (const observer of observers) {
        observer.dispose();
      }
    };
  }, [hasPinnedStrip, pinnedStripRef, unpinnedStripRef]);

  // Fill tabs reorder live where the host offers it.
  const liveReorder = useContext(PanelTabLiveReorderContext)({
    fill,
    draggingPanelId,
    tabs,
    barRef,
    tabElementsRef,
    stripRef: dndSnapshotRef,
    setDropIndicatorIndex,
    getTabTitle,
  });

  // Reveal the active tab inside whichever overflowing strip renders it.
  // Returns `true` when the reveal is settled (scrolled, or there is nothing to
  // scroll) and `false` when it had to be deferred because the strip is not
  // laid out yet (0 width — `scrollTabIntoView` would compute a garbage offset
  // from a zero-size container).
  const revealActiveTab = (): boolean => {
    // Fill strips never scroll: every tab is already in view.
    if (fill || activePanelId === null) {
      return true;
    }

    const isActivePinned = pinnedTabs.some(
      (tab) => tab.panelId === activePanelId,
    );
    const activeStripTabs = isActivePinned ? pinnedTabs : unpinnedTabs;

    // A one-tab strip cannot overflow horizontally, so revealing it cannot
    // change scroll position. Avoid forcing layout for the common one-chat
    // workspace case, especially when many panel groups mount together.
    if (activeStripTabs.length <= 1) {
      return true;
    }

    const activeScroll = isActivePinned ? pinnedScroll : unpinnedScroll;
    const strip = activeScroll.ref.current;

    // The leading tab is already fully visible when the strip is at its
    // natural start. This is the common initial-mount state; measuring every
    // tab bar here otherwise forces a document-wide layout before paint.
    if (
      activeStripTabs[0]?.panelId === activePanelId &&
      strip?.scrollLeft === 0
    ) {
      return true;
    }

    // The hook's observer-backed state can trail the current DOM on first mount
    // or when an insertion crosses the overflow threshold. Check the cheap
    // scroll metrics synchronously so an off-screen active tab is still
    // revealed before paint, while avoiding expensive rect reads for the
    // overwhelmingly common fitting strip.
    const hasCurrentOverflow =
      strip !== null && strip.scrollWidth - strip.clientWidth > 1;
    if (!activeScroll.hasOverflow && !hasCurrentOverflow) {
      return true;
    }

    const activeTab = tabElementsRef.current.get(activePanelId);
    if (!activeTab) {
      return false;
    }

    if (!strip || strip.clientWidth === 0) {
      return false;
    }

    scrollTabIntoView(strip, activeTab);
    return true;
  };

  // Whether the synchronous (layout-effect) reveal settled this render, so the
  // post-paint fallback below can skip a redundant second scroll.
  const layoutRevealSettledRef = useRef(false);

  // Keep the active tab revealed: selection changes and tab insertions can
  // land on a tab scrolled out of the overflowing strip it renders in. The
  // synchronous layout effect covers the common case where the strip is
  // already laid out (tab selection/insertion), so the reveal lands before
  // paint with no flash.
  useLayoutEffect(() => {
    layoutRevealSettledRef.current = revealActiveTab();
  }, [
    activePanelId,
    tabs.length,
    fill,
    pinnedScroll.hasOverflow,
    pinnedScroll.ref,
    unpinnedScroll.hasOverflow,
    unpinnedScroll.ref,
  ]);

  // Post-paint fallback for worktree navigation: the grid host sizes each
  // group's leaf (and thus its tab strip) in its OWN layout effect, which React
  // runs AFTER this portaled child's layout effect. So on navigation the
  // synchronous reveal above measures a 0-width strip and defers. A passive
  // effect runs after the grid has laid out, so the active tab is revealed once
  // its strip has a real width. Skipped when the layout effect already settled
  // (common case) to avoid a redundant scroll. Keyed identically to the layout
  // effect, so it only fires on selection/insertion/mount — never on user
  // scrolling.
  useEffect(() => {
    if (!layoutRevealSettledRef.current) {
      layoutRevealSettledRef.current = revealActiveTab();
    }
  }, [
    activePanelId,
    tabs.length,
    fill,
    pinnedScroll.hasOverflow,
    pinnedScroll.ref,
    unpinnedScroll.hasOverflow,
    unpinnedScroll.ref,
  ]);

  const handleTabDragStart = (
    event: ReactDragEvent<HTMLDivElement>,
    panelId: string,
  ): void => {
    startPanelTabDrag({ panelId, sourceGroupId: groupId });
    setDraggingPanelId(panelId);

    // Native payload is metadata-only (in-process identity travels through
    // the transfer singleton). Guard: synthetic test events lack dataTransfer.
    const dataTransfer: DataTransfer | null = event.dataTransfer;

    if (dataTransfer) {
      dataTransfer.effectAllowed = 'move';
    }

    liveReorder.dragStart(event, panelId);
  };

  const handleTabDragEnd = (): void => {
    // Fallback clear for aborted drags; a handled drop already cleared it.
    clearPanelTabDrag();
    setDraggingPanelId(null);
    setDropIndicatorIndex(null);
    liveReorder.dragEnd();
  };

  // The roving-tabindex holder: the last keyboard/pointer-focused tab if it
  // still exists, else the active tab, else the first tab.
  const rovingPanelId =
    focusedPanelId !== null &&
    tabs.some((tab) => tab.panelId === focusedPanelId)
      ? focusedPanelId
      : (activePanelId ?? tabs[0]?.panelId ?? null);

  const focusTabAt = (index: number): void => {
    const tab = tabs[index];

    if (!tab) {
      return;
    }

    setFocusedPanelId(tab.panelId);
    tabElementsRef.current.get(tab.panelId)?.focus();
  };

  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    index: number,
  ): void => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const delta = event.key === 'ArrowLeft' ? -1 : 1;
      focusTabAt((index + delta + tabs.length) % tabs.length);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelectTab(groupId, tabs[index].panelId);
    }
  };

  // The dragged tab's own partition (null = not a same-group drag). Drop
  // indicators only show within that partition, and the pointer's insertion
  // index is clamped to the partition's boundary for display — matching where
  // the store's reorder clamp will actually place the tab.
  const draggedSectionPinned =
    draggingPanelId !== null
      ? tabs.find((tab) => tab.panelId === draggingPanelId)?.pinned === true
      : null;
  const displayDropIndex =
    dropIndicatorIndex === null
      ? null
      : draggedSectionPinned === true
        ? Math.min(dropIndicatorIndex, pinnedCount)
        : draggedSectionPinned === false
          ? Math.max(dropIndicatorIndex, pinnedCount)
          : dropIndicatorIndex;

  // A fill tab's content: one wrapping line of icon, then the label (with its
  // trailing content and the close button). As the tab narrows the label
  // wraps off the visible line, taking the close button with it, leaving the
  // icon alone and centered (panels.css).
  const renderFillTabContent = (
    tab: PanelTabModel,
    {
      icon,
      title,
      customTooltip,
      hoverCard,
      tabIsPinned,
      position,
    }: {
      icon: ReactNode;
      title: string;
      customTooltip: ReactNode;
      hoverCard: ReactNode;
      tabIsPinned: boolean;
      position: number;
    },
  ): JSX.Element => {
    const trailing = renderTabTrailing ? (
      // State indicators sit where the close button takes over on hover; an
      // icon-only pinned tile shows them on its corner instead (panels.css).
      <span className="canopy-panel-tab-trailing">
        {renderTabTrailing(tab)}
      </span>
    ) : null;

    if (tabIsPinned) {
      return (
        <>
          <span className="canopy-panel-tab-main">
            <span className="canopy-panel-tab-icon" aria-hidden="true">
              <PanelTabPositionContext.Provider value={position}>
                {icon ?? <PinGlyph />}
              </PanelTabPositionContext.Provider>
            </span>
          </span>
          {trailing}
        </>
      );
    }

    // The probe places the slot and hides it on a label too narrow to keep
    // text beside it; the slot carries the hover reveal, and its
    // `inline-flex` keeps it exactly the button's 24px box (panels.css). No
    // tooltip: the glyph is self-explanatory and its accessible name says
    // which tab.
    const closeControl =
      canCloseTab && !canCloseTab(tab) ? null : (
        <span className="canopy-panel-tab-close-probe">
          <span className="canopy-panel-tab-close-slot inline-flex">
            <button
              type="button"
              className="canopy-panel-tab-close"
              data-testid={`panel-tab-close-${tab.panelId}`}
              aria-label={`Close ${title}`}
              tabIndex={-1}
              onClick={(event: ReactMouseEvent<HTMLButtonElement>): void => {
                // Closing must not also select the tab. The remaining tabs
                // re-share the row at once; while it is crowded the last tab
                // stays at the end of the row, under the pointer.
                event.stopPropagation();
                onCloseTab(groupId, tab.panelId);
              }}
            >
              <CloseGlyph />
            </button>
          </span>
        </span>
      );

    return (
      <span className="canopy-panel-tab-main">
        {icon ? (
          <span className="canopy-panel-tab-icon" aria-hidden="true">
            <PanelTabPositionContext.Provider value={position}>
              {icon}
            </PanelTabPositionContext.Provider>
          </span>
        ) : null}
        {/* Label, trailing content, and close button share one wrapper: it
            holds the line's place for the label, and on hover makes room for
            the close button, which floats over its right end adding no width
            (panels.css). Tooltips follow the classic label's rules. */}
        <span className="canopy-panel-tab-label">
          {hoverCard !== null ? (
            <PanelTabTitleWithHoverCard panelId={tab.panelId} card={hoverCard}>
              {renderTabLabel ? renderTabLabel(tab) : tab.title}
            </PanelTabTitleWithHoverCard>
          ) : customTooltip !== null ? (
            // The trigger wrapper must shrink with the label (and grow from
            // its content, so the tab still hugs it), or a long title is cut
            // at the tab's edge instead of ending in an ellipsis.
            <Tooltip
              placement="top"
              label={customTooltip}
              allowShrink
              className="flex-auto"
            >
              <span className="canopy-panel-tab-title">
                {renderTabLabel ? renderTabLabel(tab) : tab.title}
              </span>
            </Tooltip>
          ) : (
            <span className="canopy-panel-tab-title" title={title}>
              {renderTabLabel ? renderTabLabel(tab) : tab.title}
            </span>
          )}
          {trailing}
          {closeControl}
        </span>
      </span>
    );
  };

  const renderTab = (tab: PanelTabModel): JSX.Element => {
    const fullIndex = tabs.findIndex((t) => t.panelId === tab.panelId);
    const isActive = tab.panelId === activePanelId;
    const tabIsPinned = tab.pinned === true;
    const icon = renderTabIcon?.(tab);
    const title = getTabTitle?.(tab) ?? tab.title;
    // A non-null custom tooltip REPLACES the native `title` tooltip (never
    // both, so tooltips can't double up); other tabs keep the plain string.
    const customTooltip = renderTabTooltip?.(tab) ?? null;
    // A hover card previews a tab you cannot see, so the active tab and the
    // icon-only pinned tiles (which keep their own tooltip) never get one.
    const hoverCard =
      isActive || tabIsPinned ? null : (renderTabHoverCard?.(tab) ?? null);

    const classNames = ['canopy-panel-tab'];

    // Pinned tabs render in the compact "collapsed" style: icon only, no label
    // or close button, with the full title surfaced in a rich hover tooltip.
    if (tabIsPinned) {
      classNames.push('canopy-panel-tab-pinned');
    }

    if (tab.panelId === draggingPanelId) {
      classNames.push('canopy-panel-tab-dragging');
    }

    // Insertion indicator: a marker on the boundary the drop would insert at,
    // suppressed outside the dragged tab's own partition (cross-partition
    // reorders are clamped away by the store). The end-of-section marker sits
    // on the last tab of the dragged section (pinned → pinnedCount, else the
    // whole array's end).
    const sameSection =
      draggedSectionPinned === null || draggedSectionPinned === tabIsPinned;
    if (sameSection && displayDropIndex !== null) {
      const sectionEndIndex =
        draggedSectionPinned === true ? pinnedCount : tabs.length;
      const sectionLastFullIndex = sectionEndIndex - 1;
      if (displayDropIndex === fullIndex) {
        classNames.push('canopy-panel-tab-drop-before');
      } else if (
        displayDropIndex === sectionEndIndex &&
        fullIndex === sectionLastFullIndex
      ) {
        classNames.push('canopy-panel-tab-drop-after');
      }
    }

    const tabElement = (
      <div
        key={tab.panelId}
        role="tab"
        className={classNames.join(' ')}
        data-testid={`panel-tab-${tab.panelId}`}
        data-panel-kind={tab.kind}
        data-active={isActive ? 'true' : 'false'}
        data-pinned={tabIsPinned ? 'true' : 'false'}
        data-group-id={groupId}
        aria-selected={isActive}
        // Icon-only pinned tabs have no visible text, so the title has to come
        // through as an accessible name.
        aria-label={tabIsPinned ? title : undefined}
        tabIndex={tab.panelId === rovingPanelId ? 0 : -1}
        draggable={draggable}
        ref={(element): void => {
          if (element) {
            tabElementsRef.current.set(tab.panelId, element);
          } else {
            tabElementsRef.current.delete(tab.panelId);
          }
        }}
        onClick={(): void => {
          setFocusedPanelId(tab.panelId);
          onSelectTab(groupId, tab.panelId);
        }}
        onKeyDown={(event): void => {
          handleTabKeyDown(event, fullIndex);
        }}
        onContextMenu={
          onTabContextMenu
            ? (event: ReactMouseEvent<HTMLDivElement>): void => {
                event.preventDefault();
                onTabContextMenu(
                  groupId,
                  tab.panelId,
                  event.clientX,
                  event.clientY,
                );
              }
            : undefined
        }
        // Hovering a tab comes before dragging it; a press with no hover
        // first (touch, pen) asks again.
        onPointerEnter={
          draggable || onTabIntent
            ? (event): void => {
                if (draggable) liveReorder.prepare?.(event);
                onTabIntent?.(groupId, tab, 'start', 'pointer');
              }
            : undefined
        }
        onPointerLeave={
          onTabIntent
            ? (): void => onTabIntent(groupId, tab, 'end', 'pointer')
            : undefined
        }
        onFocus={
          onTabIntent
            ? (event): void => {
                if (event.target === event.currentTarget)
                  onTabIntent(groupId, tab, 'start', 'focus');
              }
            : undefined
        }
        onBlur={
          onTabIntent
            ? (event): void => {
                if (event.target === event.currentTarget)
                  onTabIntent(groupId, tab, 'end', 'focus');
              }
            : undefined
        }
        onPointerDown={draggable ? liveReorder.prepare : undefined}
        onDragStart={(event): void => {
          if (!draggable) return;
          handleTabDragStart(event, tab.panelId);
        }}
        onDragEnd={(): void => {
          if (!draggable) return;
          handleTabDragEnd();
        }}
      >
        {fill ? (
          renderFillTabContent(tab, {
            icon,
            title,
            customTooltip,
            hoverCard,
            tabIsPinned,
            position: fullIndex + 1,
          })
        ) : tabIsPinned ? (
          // Compact icon-only pinned tab; falls back to the pin glyph when the
          // app provides no per-kind icon so the pill is never empty. The
          // `-main` wrapper carries the active underline.
          <span className="canopy-panel-tab-main">
            <span className="canopy-panel-tab-icon" aria-hidden="true">
              {icon ?? <PinGlyph />}
            </span>
          </span>
        ) : (
          <>
            {/* Icon + label share the `-main` wrapper so the active
                underline spans exactly that pair (not the trailing content
                or close button). */}
            <span className="canopy-panel-tab-main">
              {icon ? (
                <span className="canopy-panel-tab-icon" aria-hidden="true">
                  {icon}
                </span>
              ) : null}
              {/* The label wrapper keeps the string title attribute (tooltip
              fallback) even when an app label renderer replaces the plain
              text — unless the app supplies a RICH tooltip, which replaces
              the native one entirely. The rich tooltip is attached to the
              non-interactive label span (never the whole tab) so no
              interactive control nests inside the trigger. */}
              {hoverCard !== null ? (
                <PanelTabTitleWithHoverCard
                  panelId={tab.panelId}
                  card={hoverCard}
                >
                  {renderTabLabel ? renderTabLabel(tab) : tab.title}
                </PanelTabTitleWithHoverCard>
              ) : customTooltip !== null ? (
                <Tooltip placement="top" label={customTooltip}>
                  <span className="canopy-panel-tab-title">
                    {renderTabLabel ? renderTabLabel(tab) : tab.title}
                  </span>
                </Tooltip>
              ) : (
                <span className="canopy-panel-tab-title" title={title}>
                  {renderTabLabel ? renderTabLabel(tab) : tab.title}
                </span>
              )}
            </span>
            {renderTabTrailing ? renderTabTrailing(tab) : null}
            {canCloseTab && !canCloseTab(tab) ? null : (
              // The slot is the tab's own element: `.canopy-panel-tab-close-slot`
              // carries the absolute positioning and hover reveal, and the
              // `inline-flex` keeps it exactly the button's 24px box. The
              // rich tooltip's trigger wrapper sits inside it, so the button
              // keeps its geometry while gaining an instant tooltip instead
              // of the laggy native `title`.
              <span className="canopy-panel-tab-close-slot inline-flex">
                <Tooltip label={`Close ${title}`}>
                  <button
                    type="button"
                    className="canopy-panel-tab-close"
                    data-testid={`panel-tab-close-${tab.panelId}`}
                    aria-label={`Close ${title}`}
                    tabIndex={-1}
                    onClick={(
                      event: ReactMouseEvent<HTMLButtonElement>,
                    ): void => {
                      // Closing must not also select the tab.
                      event.stopPropagation();
                      onCloseTab(groupId, tab.panelId);
                    }}
                  >
                    <CloseGlyph />
                  </button>
                </Tooltip>
              </span>
            )}
          </>
        )}
      </div>
    );

    if (!tabIsPinned) {
      return tabElement;
    }

    // Rich hover tooltip (Collapsed-style): the app's kind icon plus the full
    // title, since the pinned pill itself shows only the icon. An app-supplied
    // rich tooltip takes precedence, so normal, pinned, and collapsed tabs of
    // a kind share the same tooltip content.
    return (
      <Tooltip
        key={tab.panelId}
        placement="top"
        // A fill tile shrinks with its strip; its trigger wrapper must too
        // (panels.css).
        {...(fill
          ? { allowShrink: true, className: 'canopy-panel-tab-pinned-trigger' }
          : {})}
        label={
          customTooltip ?? (
            <span className="canopy-panel-tab-pinned-tooltip">
              {renderTabIcon?.(tab) ? (
                <span className="canopy-panel-tab-icon" aria-hidden="true">
                  {renderTabIcon(tab)}
                </span>
              ) : null}
              <span>{renderTabLabel ? renderTabLabel(tab) : title}</span>
            </span>
          )
        }
      >
        {tabElement}
      </Tooltip>
    );
  };

  return (
    <PanelTabStyleProvider value={tabStyle}>
      <div
        ref={barRef}
        className="canopy-panel-tab-bar"
        data-tab-style={tabStyle}
      >
        {hasPinnedStrip ? (
          <div className="canopy-panel-tab-strip-wrap canopy-panel-tab-strip-wrap-pinned">
            {fill ? null : (
              <>
                <div
                  className="canopy-scroll-fade canopy-scroll-fade-start"
                  data-visible={pinnedScroll.showStartFade}
                  aria-hidden="true"
                />
                <div
                  className="canopy-scroll-fade canopy-scroll-fade-end"
                  data-visible={pinnedScroll.showEndFade}
                  aria-hidden="true"
                />
                <div
                  ref={pinnedScroll.thumbRef}
                  className="canopy-scroll-thumb"
                  data-overflow={pinnedScroll.hasOverflow}
                  data-revealed={pinnedScroll.isScrollbarRevealed}
                  aria-hidden="true"
                />
              </>
            )}
            <div
              ref={pinnedStripRef}
              className="canopy-panel-tab-strip"
              role="tablist"
              aria-orientation="horizontal"
              aria-label="Pinned tabs"
              data-testid={`panel-tab-strip-pinned-${groupId}`}
            >
              {pinnedTabs.map((tab) => renderTab(tab))}
            </div>
          </div>
        ) : null}
        {hasPinnedStrip && unpinnedTabs.length > 0 ? (
          <div className="canopy-panel-tab-pinned-divider" aria-hidden="true" />
        ) : null}
        <div className="canopy-panel-tab-strip-wrap canopy-panel-tab-strip-wrap-unpinned">
          {fill ? null : (
            <>
              <div
                className="canopy-scroll-fade canopy-scroll-fade-start"
                data-visible={unpinnedScroll.showStartFade}
                aria-hidden="true"
              />
              <div
                className="canopy-scroll-fade canopy-scroll-fade-end"
                data-visible={unpinnedScroll.showEndFade}
                aria-hidden="true"
              />
              <div
                ref={unpinnedScroll.thumbRef}
                className="canopy-scroll-thumb"
                data-overflow={unpinnedScroll.hasOverflow}
                data-revealed={unpinnedScroll.isScrollbarRevealed}
                aria-hidden="true"
              />
            </>
          )}
          <div
            ref={unpinnedStripRef}
            className="canopy-panel-tab-strip"
            role="tablist"
            aria-orientation="horizontal"
            data-testid={`panel-tab-strip-${groupId}`}
          >
            {unpinnedTabs.map((tab) => renderTab(tab))}
          </div>
        </div>
        {addTab ? (
          <PanelAddTabButton groupId={groupId} addTab={addTab} />
        ) : null}
      </div>
    </PanelTabStyleProvider>
  );
}

export const PanelTabBar: NamedExoticComponent<PanelTabBarProps> =
  memo(PanelTabBarComponent);
