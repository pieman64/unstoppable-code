'use client';

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type Ref,
} from 'react';
import {
  ComposerDrawer,
  ComposerDrawerSection,
  Count,
  hasEscapeEnabledOverlay,
  OverlayScrollArea,
  StatusGlyph,
  SpinnerStyleProvider,
} from '@canopy/ui-shared/components';
import {
  ChevronDownIcon,
  ChevronTopMediumIcon,
} from '@canopy/ui-shared/icons/AppIcons';

import { DrawerRowPresentationContext } from './activity/background-tray/drawer-presentation';

export interface ComposerWorkDrawerSections {
  readonly needsYou: ReactNode;
  readonly running: ReactNode;
  readonly watching: ReactNode;
  readonly pullRequests?: ReactNode;
  readonly completed: ReactNode;
  readonly controls?: ReactNode;
  readonly viewportRef?: Ref<HTMLDivElement>;
  readonly onExpandedChange?: (expanded: boolean) => void;
}
export interface ComposerWorkDrawerBackground {
  readonly count: number;
  readonly needsYou: number;
  readonly running: number;
  readonly watching?: number;
  readonly pullRequests?: number;
  readonly panel?: ReactNode;
  readonly sections?: ComposerWorkDrawerSections;
  readonly viewportRef?: Ref<HTMLDivElement>;
  readonly onExpandedChange?: (expanded: boolean) => void;
}
export interface ComposerWorkDrawerProps {
  /** Explicit initial disclosure state, used by previews. Work never opens it. */
  readonly defaultExpanded?: boolean;
  readonly surface?: 'drawer' | 'section';
  readonly queuedCount: number;
  readonly queuedPanelRef?: Ref<HTMLDivElement>;
  readonly queuedPanel?: ReactNode;
  readonly background?: ComposerWorkDrawerBackground;
}
export function drawerReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
/** One clipped box grows upward; typography and the composer stay still. */
function DrawerReveal({
  expanded,
  animate,
  children,
}: {
  readonly expanded: boolean;
  readonly animate: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const motion = useRef<Animation | null>(null);
  const previous = useRef(expanded);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || previous.current === expanded) return;
    previous.current = expanded;
    // Scroll overflow can extend beyond the capped list (including its
    // positioned controls). Animate the laid-out content box, not that overflow.
    const contentHeight =
      contentRef.current?.getBoundingClientRect().height ?? 0;
    const running = motion.current?.playState === 'running';
    const from = running
      ? node.getBoundingClientRect().height
      : expanded
        ? 0
        : contentHeight;
    const opacity = running
      ? getComputedStyle(node).opacity
      : expanded
        ? '0'
        : '1';
    motion.current?.cancel();
    if (!animate || drawerReducedMotion() || typeof node.animate !== 'function')
      return;
    motion.current = node.animate(
      [
        { height: `${String(from)}px`, opacity },
        {
          height: `${String(expanded ? contentHeight : 0)}px`,
          opacity: expanded ? 1 : 0,
        },
      ],
      { duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }, [expanded, animate]);
  useEffect(() => (): void => motion.current?.cancel(), []);
  return (
    <div
      ref={ref}
      inert={!expanded}
      aria-hidden={!expanded}
      className="-mx-1 shrink-0 overflow-hidden"
      style={{ height: expanded ? 'auto' : 0, opacity: expanded ? 1 : 0 }}
    >
      <div ref={contentRef} className="flow-root px-1">
        {children}
      </div>
    </div>
  );
}

/** One shared grouped work list on desktop and web, above its summary row. */
export function ComposerWorkDrawer({
  defaultExpanded = false,
  surface = 'drawer',
  queuedCount,
  queuedPanelRef,
  queuedPanel,
  background,
}: ComposerWorkDrawerProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [animate, setAnimate] = useState(false);
  const onExpandedChange =
    background?.onExpandedChange ?? background?.sections?.onExpandedChange;
  useEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded, onExpandedChange]);
  const listId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const sectionRef = useRef<HTMLDivElement>(null);
  const sections = background?.sections;
  const needsYou = background?.needsYou ?? 0;
  const running = background?.running ?? 0;
  const watching = background?.watching ?? 0;
  const pullRequests = background?.pullRequests ?? 0;
  const hasWork =
    queuedCount + needsYou + running + watching + pullRequests > 0;
  useEffect(() => {
    const section = sectionRef.current;
    if (!expanded || !section) return;
    const ownerDocument = section.ownerDocument;
    const onKeyDown = (event: KeyboardEvent): void => {
      // Desktop portals its queue from the transcript. Observe DOM ancestry
      // after React's handlers, so nested controls can claim Escape first.
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        !(event.target instanceof Element) ||
        !section.contains(event.target) ||
        hasEscapeEnabledOverlay(ownerDocument) ||
        event.target.closest('[role="dialog"], [data-dragging]')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setAnimate(false);
      setExpanded(false);
      toggleRef.current?.focus();
    };
    ownerDocument.addEventListener('keydown', onKeyDown);
    return (): void => ownerDocument.removeEventListener('keydown', onKeyDown);
  }, [expanded, hasWork]);
  if (!hasWork) return null;
  const summary = [
    { label: 'Queued', count: queuedCount },
    { label: 'Running', count: running },
    { label: 'Pull requests', count: pullRequests },
    { label: 'Watching', count: watching },
  ].filter(({ count }) => count > 0);
  // Needs you ends the row beside other work; alone, it sits by its glyph
  // instead of leaving the glyph stranded at the other end.
  const needsYouLeading = needsYou > 0 && summary.length === 0;
  const needsYouLabel = (
    <span
      className={`inline-flex items-center gap-1.5 fg-warning-strong ${needsYouLeading ? '' : 'px-2.5'}`}
    >
      Needs you <span className="fg-quaternary">{needsYou}</span>
    </span>
  );
  const accessibleSummary = [
    ...summary,
    ...(needsYou > 0 ? [{ label: 'Needs you', count: needsYou }] : []),
  ]
    .map(({ label, count }) => `${label} ${String(count)}`)
    .join(', ');
  const section = (
    label: string,
    count: number,
    content: ReactNode,
    controls?: ReactNode,
    key = label,
  ): ReactNode =>
    count > 0 || content != null ? (
      <section key={key} aria-label={label} data-work-group={label}>
        <div className="flex min-h-7 flex-wrap items-center gap-1.5 pl-2.75 pr-1 text-xs fg-tertiary">
          <span className="inline-flex items-center gap-1.5">
            {label} <Count value={count} />
          </span>
          {controls && (
            <div className="ml-auto flex flex-wrap items-center gap-0">
              {controls}
            </div>
          )}
        </div>
        {content}
      </section>
    ) : null;
  const content = (
    <SpinnerStyleProvider value="comet">
      <DrawerRowPresentationContext.Provider value="drawer">
        <ComposerDrawerSection
          ref={sectionRef}
          data-testid={
            surface === 'section' ? 'composer-work-drawer' : undefined
          }
          data-chat-cancel-shortcut-ignore={expanded ? 'true' : undefined}
          className="flex min-w-0 flex-col"
        >
          <DrawerReveal expanded={expanded} animate={animate}>
            <OverlayScrollArea
              viewportRef={background?.viewportRef ?? sections?.viewportRef}
              viewportProps={{
                id: listId,
                'data-testid': 'composer-work-drawer-list',
              }}
              className="[--background-drawer-list-max:min(16.75rem,35vh)]"
              viewportClassName="max-h-[var(--background-drawer-list-max)] overflow-x-hidden"
              edgeFadeSize={6}
              edgeFadeTopSize={16}
              edgeFadeBottomInset={2}
            >
              <div className="flex flex-col gap-2 pb-1">
                {section(
                  'Needs you',
                  needsYou,
                  sections?.needsYou,
                  running === 0 ? sections?.controls : undefined,
                  // Keep the controls' owner mounted when running work starts
                  // waiting for approval (or resumes), even across Queued.
                  running === 0 ? 'execution-controls' : 'Needs you',
                )}
                {section(
                  'Queued',
                  queuedCount,
                  queuedCount > 0 ? (
                    <div
                      ref={queuedPanelRef}
                      data-testid="composer-work-drawer-queued"
                    >
                      {queuedPanel}
                    </div>
                  ) : null,
                )}
                {running > 0 &&
                  section(
                    'Running',
                    running,
                    sections ? (
                      <>
                        {sections.running}
                        {sections.completed}
                      </>
                    ) : (
                      background?.panel
                    ),
                    sections?.controls,
                    'execution-controls',
                  )}
                {section('Pull requests', pullRequests, sections?.pullRequests)}
                {section('Watching', watching, sections?.watching)}
              </div>
            </OverlayScrollArea>
            <div
              aria-hidden="true"
              className="-mx-1 mb-1 border-t border-line-tertiary"
            />
          </DrawerReveal>
          <button
            ref={toggleRef}
            type="button"
            aria-expanded={expanded}
            aria-controls={listId}
            aria-label={`${expanded ? 'Hide work' : 'Show work'}: ${accessibleSummary}`}
            data-testid="composer-work-drawer-toggle"
            className="focus-ring flex min-h-9 min-w-0 items-center gap-2.5 rounded-drawer-row py-1 pl-2.75 pr-1 text-left text-xs fg-secondary hover:bg-subtle"
            onClick={(event): void => {
              setAnimate(event.detail > 0);
              setExpanded((current) => !current);
            }}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2.5">
              {(running > 0 || needsYou > 0) && (
                <StatusGlyph
                  tone="state"
                  state={running > 0 ? 'running' : 'needs-you'}
                  size={14}
                  spinnerSize={10}
                />
              )}
              <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                {needsYouLeading && needsYouLabel}
                {summary.map(({ label, count }, index) => (
                  <span
                    key={label}
                    data-testid="composer-work-summary-item"
                    className="inline-flex items-center gap-2.5 whitespace-nowrap"
                  >
                    {index > 0 && (
                      <span
                        aria-hidden="true"
                        className="h-3 border-l border-line-primary"
                        style={{ borderLeftWidth: 1 }}
                      />
                    )}
                    <span className="inline-flex items-center gap-1.5">
                      {label}
                      <span className="fg-quaternary">{count}</span>
                    </span>
                  </span>
                ))}
              </span>
            </span>
            <span
              data-testid="composer-work-summary-attention"
              className="flex shrink-0 items-center"
            >
              {needsYou > 0 && !needsYouLeading && needsYouLabel}
              <span className="flex h-7 w-7 items-center justify-center">
                {expanded ? (
                  <ChevronDownIcon size={14} />
                ) : (
                  <ChevronTopMediumIcon size={14} />
                )}
              </span>
            </span>
          </button>
        </ComposerDrawerSection>
      </DrawerRowPresentationContext.Provider>
    </SpinnerStyleProvider>
  );
  return surface === 'section' ? (
    content
  ) : (
    <ComposerDrawer edge="top" data-testid="composer-work-drawer">
      {content}
    </ComposerDrawer>
  );
}
