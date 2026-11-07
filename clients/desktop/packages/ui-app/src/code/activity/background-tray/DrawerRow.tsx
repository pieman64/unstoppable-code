'use client';

import {
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useId,
  useRef,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  Button,
  DrawerInspectorAction,
  Tooltip,
  useShimmerPhase,
  SpinnerStyleProvider,
} from '@canopy/ui-shared/components';
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { revealInList } from './drawer-layout';

import { DrawerRowPresentationContext } from './drawer-presentation';
import { Divider } from '@canopy/ui-shared/components';

const DETAIL_FADE_MASK =
  'linear-gradient(to right, black calc(100% - 24px), transparent)';

/** A detail too long for the row (a long job strip) fades out at its end
 * instead of cutting a glyph in half. */
function RowDetail({
  children,
  compact = false,
}: {
  readonly children: ReactNode;
  readonly compact?: boolean;
}): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = (): void =>
      setOverflowing(node.scrollWidth > node.clientWidth);
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    // The strip grows inside its wrapper without resizing the row.
    for (const child of node.querySelectorAll(':scope > *, :scope > * > *'))
      observer.observe(child);
    return (): void => observer.disconnect();
  }, []);
  return (
    <span
      ref={ref}
      className={`min-w-0 truncate text-xs fg-tertiary ${compact ? '' : 'flex-1'}`}
      data-overflowing={overflowing ? 'true' : undefined}
      style={
        overflowing
          ? { maskImage: DETAIL_FADE_MASK, WebkitMaskImage: DETAIL_FADE_MASK }
          : undefined
      }
    >
      {children}
    </span>
  );
}

function InspectorReveal({
  animate,
  children,
}: {
  readonly animate: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (
      !animate ||
      !node ||
      typeof node.animate !== 'function' ||
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    )
      return;
    const animation = node.animate(
      [
        { opacity: 0, transform: 'translateY(-3px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      { duration: 160, easing: 'cubic-bezier(0.215,0.61,0.355,1)' },
    );
    return (): void => animation.cancel();
  }, [animate]);
  return (
    <div ref={ref} className="flex flex-col gap-2">
      {children}
    </div>
  );
}

export interface DrawerRowInspector {
  readonly open: boolean;
  readonly onToggle: () => void;
  /** Rendered only while open. */
  readonly render: () => ReactNode;
  readonly footer?: ReactNode;
}

export interface DrawerRowProps {
  /** `data-tray-row`: the row's kind and id. */
  readonly rowKey: string;
  readonly testId: string;
  readonly glyph: ReactNode;
  readonly name: ReactNode;
  /** What the item is doing now; hidden while its inspector is open. */
  readonly detail?: ReactNode;
  /** State follows the subtitle and precedes watcher indicators. */
  readonly status?: ReactNode;
  /** Diff statistics or legacy elapsed time. */
  readonly trailing?: ReactNode;
  /** The row's one action, outside its toggle. */
  readonly action?: ReactNode;
  /** Navigation uses the header unless a primary action already occupies it. */
  readonly openAction?: {
    readonly label: string;
    readonly onClick: () => void;
  };
  /** Independent header control before the timestamp, outside the disclosure button. */
  readonly headerAccessory?: ReactNode;
  readonly attention?: boolean;
  /**
   * Work in progress: the glyph is the work's kind and the name shimmers,
   * instead of a spinner.
   */
  readonly running?: boolean;
  /** Present when the row opens an inspector in place. */
  readonly inspector?: DrawerRowInspector;
  readonly listRef: RefObject<HTMLDivElement | null>;
  readonly topInset: number;
}

/**
 * One row of the background drawer (D6), in the compact queue row's style so
 * both drawer tabs read as one list: 36px, the name in the primary ink, what
 * it is doing now and its time one step down in the tertiary ink, and one
 * action in a column every row shares, so the times line up. The leading
 * slot shows where the work stands; on hover a row with an inspector shows
 * the disclosure chevron there instead, and an open row keeps it pointing
 * down. Rows nest in the drawer's 4px inset with 16px corners; the drag
 * handle's 11px start inset puts every glyph on one centre line.
 */
export function DrawerRow({
  rowKey,
  testId,
  glyph,
  name,
  detail,
  status,
  trailing,
  action,
  openAction,
  headerAccessory,
  attention = false,
  running = false,
  inspector,
  listRef,
  topInset,
}: DrawerRowProps): JSX.Element {
  const presentation = useContext(DrawerRowPresentationContext);
  const modal = presentation === 'modal';
  const redesigned = presentation !== 'legacy';
  const nameId = useId();
  const navigation = presentation === 'legacy' ? undefined : openAction;
  const navigationInHeader = navigation !== undefined && (modal || !action);
  const linkRow = navigation !== undefined && !inspector && !action && !modal;
  const headerAction = navigationInHeader ? (
    <Tooltip label={navigation.label}>
      <Button
        variant="ghost-overlay"
        size="compact"
        iconOnly
        aria-label={navigation.label}
        data-testid="background-tray-row-open"
        onClick={navigation.onClick}
      >
        <ArrowUpRightIcon size={14} />
      </Button>
    </Tooltip>
  ) : (
    action
  );
  const [animateDetails, setAnimateDetails] = useState(false);
  const actionGroup =
    redesigned && navigation && action ? (
      <span className="flex items-center gap-1">
        <Button
          variant="ghost-overlay"
          size="compact"
          data-testid="background-tray-row-open"
          onClick={navigation.onClick}
        >
          {navigation.label}
        </Button>
        {action}
      </span>
    ) : (
      headerAction
    );
  const inspectorId = useId();
  const ref = useRef<HTMLLIElement>(null);
  const open = inspector?.open === true;
  const hasFooter = Boolean(
    inspector?.footer || (navigation && !navigationInHeader && !redesigned),
  );
  // The clean chat look's live-step shimmer, in step with every other row.
  const shimmering = running && !open;
  const shimmerStyle = useShimmerPhase(shimmering);
  useEffect(() => {
    const list = listRef.current;
    const row = ref.current;
    if (modal || !open || !list || !row) return;
    revealInList(list, row, topInset);
    // An inspector that grows later (workflow progress arriving) stays whole.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() =>
      revealInList(list, row, topInset),
    );
    observer.observe(row);
    return (): void => observer.disconnect();
  }, [listRef, open, topInset, modal]);
  const leading = open ? (
    // Open, the row already has the fill, so hovering the header (it closes
    // the row) lifts its ink instead.
    <ChevronDownIcon size={14} aria-hidden="true" className="fg-tertiary" />
  ) : inspector ? (
    <>
      <span className="flex group-hover/row:hidden group-focus-within/row:hidden">
        {glyph}
      </span>
      <span className="hidden fg-tertiary group-hover/row:flex group-focus-within/row:flex">
        <ChevronRightIcon size={14} aria-hidden="true" />
      </span>
    </>
  ) : (
    glyph
  );
  const legacyContent = (
    <>
      <span
        aria-hidden="true"
        className="flex w-3.5 shrink-0 justify-center fg-tertiary"
      >
        {leading}
      </span>
      <span
        className={`min-w-0 truncate ${
          modal || detail === undefined ? 'flex-1' : 'max-w-1/2 shrink-0'
        } ${
          modal
            ? 'fg-primary'
            : open
              ? 'fg-secondary group-hover/header:fg-primary'
              : shimmering
                ? 'canopy-text-shimmer-strong'
                : 'fg-primary'
        }`}
        style={shimmerStyle}
      >
        {name}
      </span>
      {!modal &&
        detail !== undefined &&
        // The open inspector shows it in full.
        (open ? (
          <span className="min-w-0 flex-1" />
        ) : (
          <RowDetail>{detail}</RowDetail>
        ))}
      {!headerAccessory && trailing !== undefined && (
        <span className="shrink-0 text-xs tabular-nums fg-tertiary">
          {trailing}
        </span>
      )}
    </>
  );
  const content = redesigned ? (
    <>
      <span
        aria-hidden="true"
        className="flex w-3.5 shrink-0 justify-center fg-tertiary"
      >
        {leading}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        <span
          id={nameId}
          className={`min-w-0 truncate ${open ? 'fg-secondary' : shimmering ? 'canopy-text-shimmer-strong' : 'fg-primary'}`}
          style={shimmerStyle}
        >
          {name}
        </span>
        {detail !== undefined && <RowDetail compact>{detail}</RowDetail>}
        {status !== undefined && (
          <span
            className="inline-flex min-w-0 shrink-0 items-center gap-2.5 text-xs fg-tertiary"
            style={{ WebkitTextFillColor: 'currentColor' }}
            data-testid="background-tray-inline-status"
          >
            <span aria-hidden="true">·</span>
            <span className="truncate">{status}</span>
          </span>
        )}
        {headerAccessory && (
          <span className="pointer-events-auto relative z-10 inline-flex shrink-0 items-center gap-2.5 text-xs fg-tertiary">
            <span aria-hidden="true">·</span>
            {headerAccessory}
          </span>
        )}
      </span>
      {trailing !== undefined && (
        <span className="shrink-0 text-xs tabular-nums fg-tertiary">
          {trailing}
        </span>
      )}
    </>
  ) : (
    legacyContent
  );
  // Waiting on the user, the row rests on the fill (hover steps up to
  // muted); the glyph carries the attention ink, so the fill stays neutral.
  const fill = open
    ? 'bg-subtle'
    : modal
      ? ''
      : attention
        ? 'bg-subtle hover:bg-muted'
        : inspector || navigation || action
          ? 'hover:bg-subtle'
          : '';
  return (
    <SpinnerStyleProvider value="comet">
      <li
        ref={ref}
        className={`group/row flex flex-col ${modal ? 'rounded-lg' : 'rounded-drawer-row'} ${fill}`}
        data-tray-row={rowKey}
        data-testid={testId}
      >
        {/* The action ends 4px from the row's end, as from its top and bottom. */}
        <div
          className={`relative flex h-9 min-w-0 items-center text-s ${modal && !open ? 'rounded-lg hover:bg-subtle' : ''} ${modal && !navigationInHeader ? 'pr-3' : presentation === 'legacy' ? 'gap-3 pr-1' : 'gap-2.5 pr-1'}`}
        >
          {inspector || linkRow ? (
            <>
              {/* With nothing to unfold, the whole row is its way out (a pull
                request opens on GitHub): the button lies under the row's
                content, and controls in the row sit above it. */}
              <button
                type="button"
                className={`focus-visible:outline focus-visible:outline-1 focus-visible:outline-fg-quaternary focus-visible:-outline-offset-1 outline-none ${
                  inspector && !redesigned
                    ? `group/header flex h-9 min-w-0 flex-1 items-center gap-2.5 text-left ${modal ? 'rounded-lg pl-3' : 'rounded-drawer-row pl-2.75'}`
                    : 'absolute inset-0 rounded-drawer-row'
                }`}
                aria-labelledby={redesigned ? nameId : undefined}
                aria-expanded={inspector ? open : undefined}
                aria-controls={inspector && open ? inspectorId : undefined}
                onClick={(event): void => {
                  if (!inspector) {
                    navigation?.onClick();
                    return;
                  }
                  setAnimateDetails(modal && event.detail > 0);
                  inspector.onToggle();
                }}
                data-testid={
                  inspector
                    ? 'background-tray-row-toggle'
                    : 'background-tray-row-open'
                }
              >
                {inspector && !redesigned ? (
                  content
                ) : !redesigned ? (
                  <span className="sr-only">
                    {name}, {navigation?.label}
                  </span>
                ) : null}
              </button>
              {(!inspector || redesigned) && (
                <div className="pointer-events-none flex h-9 min-w-0 flex-1 items-center gap-2.5 pl-2.75">
                  {content}
                </div>
              )}
            </>
          ) : (
            <div className="flex h-9 min-w-0 flex-1 items-center gap-2.5 pl-2.75">
              {content}
            </div>
          )}
          {!redesigned && headerAccessory && (
            <>
              <span className="relative shrink-0">{headerAccessory}</span>
              {trailing !== undefined && (
                <span className="shrink-0 text-xs tabular-nums fg-tertiary">
                  {trailing}
                </span>
              )}
            </>
          )}
          {/* One action column, so the times line up whichever icon action a
            row has, or none; a labeled action (Resume) widens its own row. */}
          {linkRow ? (
            <span
              aria-hidden="true"
              className="pointer-events-none flex w-7 shrink-0 justify-center fg-tertiary"
            >
              {/* The whole row is the link, as View completed's is. */}
              <ChevronRightIcon size={14} />
            </span>
          ) : (
            (!modal || navigationInHeader) && (
              <span
                className={`relative z-10 flex shrink-0 items-center justify-end ${presentation === 'legacy' ? 'w-14' : 'min-w-7'}`}
              >
                {actionGroup}
              </span>
            )
          )}
        </div>
        {open && inspector && (
          <div
            id={inspectorId}
            // Indented to the name: 11px inset, 14px glyph, 10px gap.
            className={`flex flex-col gap-2 text-s fg-tertiary ${modal ? 'px-3 pb-2' : `pl-8.75 pr-1 ${presentation === 'legacy' ? 'pb-1' : 'pb-2'}`}`}
            data-testid="background-tray-inspector"
          >
            {presentation === 'legacy' && (
              <Divider aria-hidden className="mb-1 mr-9.5" />
            )}
            <InspectorReveal animate={animateDetails}>
              {inspector.render()}
              {hasFooter && (
                <InspectorFooter
                  action={navigationInHeader ? undefined : navigation}
                >
                  {inspector.footer}
                </InspectorFooter>
              )}
            </InspectorReveal>
          </div>
        )}
      </li>
    </SpinnerStyleProvider>
  );
}

/** Expanded metadata sits below the title, before any separated detail content. */
export function InspectorSubtitle({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const presentation = useContext(DrawerRowPresentationContext);
  return (
    <div
      data-testid="background-tray-subtitle"
      className={`min-w-0 text-xs fg-tertiary ${presentation === 'modal' ? 'ml-6' : 'mr-9.5'}`}
    >
      {children}
    </div>
  );
}

/** Only actual lists or output get a divider; metadata-only cards do not. */
export function InspectorSection({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const presentation = useContext(DrawerRowPresentationContext);
  if (presentation === 'legacy') return <>{children}</>;
  return (
    <div
      className="flex flex-col gap-2"
      data-testid="background-tray-inspector-section"
    >
      {children}
    </div>
  );
}

/** One footer layout for agent, run and PR actions on both hosts. */
export function InspectorFooter({
  children,
  action,
}: {
  readonly children?: ReactNode;
  readonly action?: { readonly label: string; readonly onClick: () => void };
}): JSX.Element {
  const modal = useContext(DrawerRowPresentationContext) === 'modal';
  // Beside footer text the action ends at the time column; alone, it sits
  // under the names above it rather than floating at the row's end.
  const leading = modal || children == null;
  return (
    <div
      className={`mt-2 flex items-center gap-3 text-xs ${leading ? '' : 'mr-9.5 justify-end'}`}
    >
      {children}
      {action && (
        <InspectorOpenAction
          placement={leading ? 'block' : 'footer'}
          label={action.label}
          onClick={action.onClick}
        />
      )}
    </div>
  );
}

/** An inspector's way into the detail both hosts have (output, run, details). */
export function InspectorOpenAction({
  label,
  onClick,
  placement = 'block',
}: {
  readonly placement?: 'block' | 'footer';
  readonly label: string;
  readonly onClick: () => void;
}): JSX.Element {
  // The rows' quiet capsule, its label lined up with the text above it.
  return (
    <div className="flex flex-wrap items-center">
      <DrawerInspectorAction
        alignment={placement === 'footer' ? 'trailing' : 'leading'}
        onClick={onClick}
        data-testid="background-tray-inspector-open"
      >
        {label}
      </DrawerInspectorAction>
    </div>
  );
}
