'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  LINEAR_PREVIEW_CACHE_LIMITS,
  githubOriginKey,
  githubPreviewKey,
  githubTitleSlot,
  useCapabilities,
  useLinearPreviewStore,
  type GitHubRepositoryName,
  type ReferenceTitleSlot,
} from '@canopy/app-state';
import type {
  GitHubPreviewTarget,
  GitHubReferenceOrigin,
  ReferenceEnrichmentMode,
} from '@canopy/protocol/reference-previews';
import {
  chatMessageLinkUrlProps,
  InlineTextSkeleton,
  PREVIEW_CARD_SURFACE,
  RichHoverTooltip,
  usePrHoverCards,
  WordBoundaryTruncatedText,
} from '@canopy/ui-shared/components';
import {
  GitHubReferencePreviewCard,
  type GitHubReferencePreviewCardLayout,
  type GitHubReferencePreviewCardView,
} from '@canopy/ui-shared/components/GitHubReferencePreviewCard';
import { GitHubIcon } from '@canopy/ui-shared/icons/AppIcons';
import { useWatchWhileVisible } from './reference-preview-visibility';

const OPEN_DELAY_MS = 250;
const TITLE_MAX_WORDS = 5;
const NO_TITLE: ReferenceTitleSlot = { kind: 'none' };

/**
 * Whether the host holds a GitHub credential; `null` on hosts without the
 * capability. Checks the local scope once, and again after a GitHub reset.
 */
export function useGitHubPreviewConnected(enabled = true): boolean | null {
  const supported = useCapabilities().referencePreviews === true;
  const connected = useLinearPreviewStore((state) =>
    supported && enabled ? state.githubConnected : null,
  );
  const ensure = useLinearPreviewStore((state) => state.ensureGitHubConnection);
  const epoch = useLinearPreviewStore((state) => state.githubEpoch);
  useEffect(() => {
    if (supported && enabled) ensure();
  }, [enabled, ensure, epoch, supported]);
  return connected;
}

/**
 * The single repository a bare `#1234` in this origin refers to: `undefined`
 * while resolving, `null` for none, cowork, or a host without the capability.
 */
export function useGitHubOriginRepository(
  origin: GitHubReferenceOrigin | null,
): GitHubRepositoryName | null | undefined {
  const supported = useCapabilities().referencePreviews === true;
  const projectId = origin?.kind === 'worktree' ? origin.projectId : null;
  const worktreeId = origin?.kind === 'worktree' ? origin.worktreeId : null;
  const key =
    supported && projectId !== null && worktreeId !== null
      ? githubOriginKey({ kind: 'worktree', projectId, worktreeId })
      : null;
  const repository = useLinearPreviewStore(
    (state): GitHubRepositoryName | null | undefined =>
      key === null ? null : state.githubOrigins[key],
  );
  const [resolvedKey, setResolvedKey] = useState<string | null>(null);
  useEffect(() => {
    if (key !== null && repository !== undefined) setResolvedKey(key);
  }, [key, repository]);
  const ensure = useLinearPreviewStore((state) => state.ensureGitHubOrigin);
  useEffect(() => {
    if (key !== null && projectId !== null && worktreeId !== null) {
      ensure({ kind: 'worktree', projectId, worktreeId });
    }
  }, [ensure, key, projectId, worktreeId]);
  // Expiry removes the bare-number mapping without hiding qualified references.
  return repository === undefined && resolvedKey === key ? null : repository;
}

/** Mounted only while the card is open; hover and focus load immediately. */
function GitHubReferencePreviewContent({
  target,
  label,
  layout,
}: {
  target: GitHubPreviewTarget;
  label: string;
  layout: GitHubReferencePreviewCardLayout;
}): JSX.Element {
  const view = useLinearPreviewStore(
    (state) => state.githubViews[githubPreviewKey(target)],
  );
  const load = useLinearPreviewStore((state) => state.loadGitHub);
  const missing = view === undefined;
  const loadedRef = useRef(false);
  // Load on every open: the store serves fresh entries without a read and
  // refreshes stale or expired-negative ones. Load again if a reset clears
  // the view while the card is open.
  useEffect(() => {
    if (loadedRef.current && !missing) return;
    loadedRef.current = true;
    void load(target);
  }, [load, missing, target]);
  const cardView: GitHubReferencePreviewCardView =
    !view || view.status === 'loading'
      ? { status: 'loading' }
      : view.status === 'unavailable'
        ? view
        : {
            status: 'ready',
            preview: view.preview,
            checkedAt: view.checkedAt,
            stale:
              view.refreshing ||
              Date.now() - view.checkedAt > LINEAR_PREVIEW_CACHE_LIMITS.freshMs,
          };
  return (
    <GitHubReferencePreviewCard label={label} view={cardView} layout={layout} />
  );
}

/**
 * `[icon] label: Title` once the item resolves (a repository shows its
 * description). While a title is expected, the label and a text-free
 * placeholder reserve its width; a reference that can't resolve, or a
 * disconnected GitHub, keeps its original text. The title stays whole in the
 * DOM for selection and the accessible name; CSS crops it at five words or
 * the width, on a word boundary. Text without a URL keeps its text node.
 */
function GitHubReferenceLabel({
  target,
  label,
  expandTitle,
  bare,
  connected,
  children,
}: {
  target: GitHubPreviewTarget;
  label: string;
  expandTitle: boolean;
  bare: boolean;
  connected: boolean;
  children: ReactNode;
}): JSX.Element {
  // The title string, or the shared pending/none slot: a refreshed view with
  // the same title does not re-render the label.
  const expected = useLinearPreviewStore((state) => {
    if (!expandTitle) return null;
    const next = githubTitleSlot(state.githubViews[githubPreviewKey(target)]);
    return next.kind === 'title' ? next.title : next;
  });
  const resolved = useLinearPreviewStore(
    (state) =>
      expandTitle &&
      state.githubViews[githubPreviewKey(target)]?.status === 'ready',
  );
  // Without a credential no title will come; reserve nothing.
  const slot =
    typeof expected !== 'string' && expected?.kind === 'pending' && !connected
      ? NO_TITLE
      : expected;
  const title = typeof slot === 'string' ? slot : null;
  const pending =
    slot !== null && typeof slot !== 'string' && slot.kind === 'pending'
      ? slot
      : null;
  const shortened = !bare && (title !== null || pending !== null || resolved);
  return (
    <>
      <GitHubIcon
        width={13}
        height={13}
        aria-hidden="true"
        className="mr-0.5 inline-block shrink-0 align-text-bottom"
      />
      {shortened ? label : children}
      {title !== null && (
        <>
          {': '}
          <WordBoundaryTruncatedText
            text={title}
            maxWords={TITLE_MAX_WORDS}
            data-testid="github-reference-title"
            className="inline-block max-w-[min(40ch,100%)] align-bottom"
          />
        </>
      )}
      {pending && (
        // Same reservation as Linear: the margin stands in for `: `.
        <InlineTextSkeleton
          active={pending.reading}
          data-testid="github-reference-title-placeholder"
          className="ml-2 w-[min(36ch,100%)]"
        />
      )}
    </>
  );
}

const GeneratedReferenceLink = forwardRef<
  HTMLSpanElement,
  ComponentPropsWithoutRef<'span'> & { target: GitHubPreviewTarget }
>(function GeneratedReferenceLink({ target, children, ...triggerProps }, ref) {
  const load = useLinearPreviewStore((state) => state.loadGitHub);
  // The canonical URL once resolved, so the message menu offers the link
  // section; a refresh keeps the view `ready` (CAN-2632).
  const linkUrl = useLinearPreviewStore((state) => {
    const view = state.githubViews[githubPreviewKey(target)];
    return view?.status === 'ready' ? view.preview.url : null;
  });
  const openReference = (event: MouseEvent | KeyboardEvent): void => {
    const view = event.currentTarget.ownerDocument.defaultView ?? window;
    void load(target).then((preview) => {
      if (preview) view.open(preview.url, '_blank', 'noopener,noreferrer');
    });
  };
  // A selectable span keeps the label in copied prose; a button's label is
  // excluded from text selection.
  return (
    <span
      {...triggerProps}
      ref={ref}
      role="link"
      tabIndex={0}
      data-testid="github-reference"
      className="focus-ring cursor-pointer rounded-sm fg-accent hover:underline"
      onClick={openReference}
      onKeyDown={(event) => {
        if (event.key === 'Enter') openReference(event);
      }}
      {...chatMessageLinkUrlProps(linkUrl)}
    >
      {children}
    </span>
  );
});

export interface GitHubReferencePreviewProps {
  readonly target: GitHubPreviewTarget;
  /** Display ID for a generated label: `#12`, `owner/repo#12` or `owner/repo`. */
  readonly label: string;
  /** The URL as written; absent for `owner/repo#12` / `#12` text. */
  readonly href?: string;
  readonly mode?: ReferenceEnrichmentMode;
  /**
   * Replace the text with `[icon] label: title` once resolved; false keeps an
   * author-written link label. Default: true.
   */
  readonly expandTitle?: boolean;
  readonly children: ReactNode;
}

/**
 * A GitHub repository, issue or pull request reference in transcript prose:
 * an inline icon, a title resolved while the reference is visible, and a
 * hover/focus preview card. A URL stays an ordinary external link to what was
 * written; generated text opens the canonical URL GitHub returns. Hosts
 * without the capability render the text unchanged.
 */
export function GitHubReferencePreview({
  target,
  label,
  href,
  mode = 'replace',
  expandTitle = true,
  children,
}: GitHubReferencePreviewProps): JSX.Element {
  const supported = useCapabilities().referencePreviews === true;
  if (!supported || mode === 'off') {
    return href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <>{children}</>
    );
  }
  return (
    <SupportedGitHubReference
      target={target}
      label={label}
      href={href}
      mode={mode}
      expandTitle={expandTitle}
    >
      {children}
    </SupportedGitHubReference>
  );
}

function SupportedGitHubReference({
  target,
  label,
  href,
  mode = 'replace',
  expandTitle,
  children,
}: GitHubReferencePreviewProps & { expandTitle: boolean }): JSX.Element {
  const { owner, repository } = target;
  const number = target.kind === 'item' ? target.number : null;
  // Callers may rebuild the target each render; keep one per identity.
  const stableTarget = useMemo<GitHubPreviewTarget>(
    () =>
      number === null
        ? { kind: 'repository', owner, repository }
        : { kind: 'item', owner, repository, number },
    [number, owner, repository],
  );
  const connected = useGitHubPreviewConnected() === true;
  const watchGitHub = useLinearPreviewStore((state) => state.watchGitHub);
  // A GitHub reset drops every registration; register again.
  const epoch = useLinearPreviewStore((state) => state.githubEpoch);
  const triggerRef = useRef<HTMLElement | null>(null);
  const setTrigger = useCallback((element: HTMLElement | null): void => {
    triggerRef.current = element;
  }, []);
  useWatchWhileVisible(
    triggerRef,
    watchGitHub,
    stableTarget,
    epoch,
    connected && mode === 'replace',
  );
  const content =
    mode === 'hover' ? (
      children
    ) : (
      <GitHubReferenceLabel
        target={stableTarget}
        label={label}
        expandTitle={expandTitle}
        bare={href === undefined}
        connected={connected}
      >
        {children}
      </GitHubReferenceLabel>
    );
  const trigger = href ? (
    <a
      ref={setTrigger}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="github-reference"
    >
      {content}
    </a>
  ) : (
    <GeneratedReferenceLink ref={setTrigger} target={stableTarget}>
      {content}
    </GeneratedReferenceLink>
  );
  // Pull request cards: the status layout on the sidebar worktree card's
  // surface; off, the classic card on the tooltip's.
  const prHoverCards = usePrHoverCards();
  return (
    <RichHoverTooltip
      deferUntilInteraction
      resetKey={`${epoch}:${githubPreviewKey(stableTarget)}`}
      content={
        <GitHubReferencePreviewContent
          target={stableTarget}
          label={label}
          layout={prHoverCards ? 'status' : 'classic'}
        />
      }
      openDelay={OPEN_DELAY_MS}
      focusOpenDelay={0}
      dismissOnEscape
      {...(prHoverCards ? PREVIEW_CARD_SURFACE : { surfacePadding: 'card' })}
      surfaceClassName={
        prHoverCards ? undefined : 'w-80 max-w-[calc(100vw-16px)]'
      }
      triggerWrapperClassName="inline!"
    >
      {trigger}
    </RichHoverTooltip>
  );
}
