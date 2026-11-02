'use client';

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  Button,
  DelayedLoadingPlaceholder,
  Markdown,
  SettingsTableSkeleton,
  useCopyToClipboard,
} from '@canopy/ui-shared/components';
import {
  AlertTriangle,
  Bot,
  Check,
  ClipboardCheck,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  History,
  Link2,
  ListChecks,
  MessageSquare,
  ShareIcon,
  Workflow,
} from '@canopy/ui-shared/icons/AppIcons';
import type {
  AgentSessionFeedItem,
  FeedItem,
  PipelineRunFeedItem,
  PlanApprovedFeedItem,
  PlanSharedFeedItem,
  PlanUpdatedFeedItem,
  PrMergedFeedItem,
  PrOpenedFeedItem,
  RunFailedFeedItem,
  RunSharedFeedItem,
  WorktreeStartedFeedItem,
  WorktreeSummaryHistoryEntry,
  WorktreeUpdatedFeedItem,
} from '@canopy/protocol';
import type { OrganizationMember } from '@canopy/protocol/settings/organization';
import {
  SettingsLink,
  useSettingsClient,
  useSettingsHost,
  useSettingsPrivacy,
} from '../host';
import { getWorktreeSummaryHistory } from './team-api';
import {
  formatActor,
  formatCostUsd,
  formatDurationMs,
  formatRelativeTime,
  formatTokens,
} from './feed-format';
import { MemberAvatar } from './MemberAvatar';
import { memberProfileHref } from './profile-links';

/**
 * Whether feed actors link to their organization member profile. A personal
 * organization has no member profiles, so its feed renders actors as text.
 */
const FeedActorProfileLinksContext = createContext(true);
export const FeedActorProfileLinksProvider =
  FeedActorProfileLinksContext.Provider;

interface FeedItemCardProps {
  item: FeedItem;
  orgId: string;
  /** Highlight + scroll target when the card is the permalink anchor. */
  highlighted?: boolean;
  /**
   * The org member matching `item.actor.userId`, when resolvable. Drives the
   * avatar image + initials; `null`/absent falls back to the actor's
   * `displayName` (or `'?'`) so removed/unknown actors still render a placeholder.
   */
  member?: OrganizationMember | null;
}

/**
 * Dispatches a hydrated {@link FeedItem} to its per-type card. Every card shares
 * the {@link FeedCardShell} chrome (icon, title, attribution, relative time, and
 * a copy-permalink affordance) so the feed reads consistently.
 */
function FeedItemCardImpl({
  item,
  orgId,
  highlighted = false,
  member = null,
}: FeedItemCardProps): JSX.Element {
  switch (item.type) {
    case 'pr_opened':
      return (
        <PrOpenedCard
          item={item}
          orgId={orgId}
          highlighted={highlighted}
          member={member}
        />
      );
    case 'pr_merged':
      return (
        <PrMergedCard
          item={item}
          orgId={orgId}
          highlighted={highlighted}
          member={member}
        />
      );
    case 'plan_approved':
      return (
        <PlanApprovedCard
          item={item}
          orgId={orgId}
          highlighted={highlighted}
          member={member}
        />
      );
    case 'plan_shared':
      return (
        <PlanSharedCard
          item={item}
          orgId={orgId}
          highlighted={highlighted}
          member={member}
        />
      );
    case 'plan_updated':
      return (
        <PlanUpdatedCard
          item={item}
          orgId={orgId}
          highlighted={highlighted}
          member={member}
        />
      );
    case 'run_shared':
      return (
        <RunSharedCard
          item={item}
          orgId={orgId}
          highlighted={highlighted}
          member={member}
        />
      );
    case 'worktree_started':
      return (
        <WorktreeStartedCard
          item={item}
          orgId={orgId}
          highlighted={highlighted}
          member={member}
        />
      );
    case 'worktree_updated':
      return (
        <WorktreeUpdatedCard
          item={item}
          orgId={orgId}
          highlighted={highlighted}
          member={member}
        />
      );
    case 'agent_session':
      return (
        <AgentSessionCard
          item={item}
          orgId={orgId}
          highlighted={highlighted}
          member={member}
        />
      );
    case 'pipeline_run':
      return (
        <PipelineRunCard
          item={item}
          orgId={orgId}
          highlighted={highlighted}
          member={member}
        />
      );
    case 'run_failed':
      return (
        <RunFailedCard
          item={item}
          orgId={orgId}
          highlighted={highlighted}
          member={member}
        />
      );
  }
}

/**
 * `mergeLiveFeedItem` preserves the object reference of every unchanged item, so
 * a default shallow comparator lets settled cards bail out of re-render while the
 * live SSE stream rebuilds the list array. Only the changed row (and its inner
 * typed card and markdown body re-renders, instead of the whole visible feed.
 */
export const FeedItemCard = memo(FeedItemCardImpl);
FeedItemCard.displayName = 'FeedItemCard';

// ---------------------------------------------------------------------------
// Shared chrome.
// ---------------------------------------------------------------------------

/** Joins class names, dropping empty ones so no stray whitespace appears. */
function joinClassNames(...classNames: readonly string[]): string {
  return classNames.filter((className) => className !== '').join(' ');
}

interface FeedCardShellProps {
  item: FeedItem;
  orgId: string;
  highlighted: boolean;
  icon: JSX.Element;
  /** Resolved org member for the actor, when available (drives the avatar). */
  member?: OrganizationMember | null;
  /** The bold lead line, e.g. "merged PR #42". */
  title: ReactNode;
  /** Optional internal route rendered next to the title. */
  internalLink?: { href: string; label: string };
  /** Optional external link rendered next to the title. */
  externalLink?: { href: string; label: string };
  /** Emphasized treatment for notification-worthy items (run failures). */
  tone?: 'default' | 'danger';
  children?: ReactNode;
}

function FeedCardShell({
  item,
  orgId,
  highlighted,
  icon,
  member = null,
  title,
  internalLink,
  externalLink,
  tone = 'default',
  children,
}: FeedCardShellProps): JSX.Element {
  const actorLinked =
    useContext(FeedActorProfileLinksContext) && item.actor.displayName !== null;
  const { blockClassName } = useSettingsPrivacy();
  const toneClasses =
    tone === 'danger'
      ? 'border-line-destructive/40 bg-destructive/5'
      : 'bg-card';
  const highlightClasses = highlighted
    ? 'ring-2 ring-line-accent ring-offset-2 ring-offset-base'
    : '';
  // `content-visibility:auto` skips layout/paint for off-screen cards so the
  // feed stays responsive as the list grows. Known trade-off: Chromium's
  // find-in-page (Ctrl/Cmd+F) can't match text inside a card until it has been
  // laid out, so a search may miss content in cards that are still off-screen.
  // Accepted here over the sustained render cost; revisit if full-feed text
  // search becomes a hard requirement (it would need true virtualization).
  // `contain-intrinsic-size: auto 280px` caches each card's real height after
  // first paint and only estimates for never-rendered cards; 280px is a closer
  // guess for tall summary cards than 200px, which reduces first-paint scroll
  // drift when the permalink anchor scrolls into view.
  return (
    <article
      id={`feed-item-${item.id}`}
      data-testid="feed-item"
      data-feed-item-id={item.id}
      data-feed-item-type={item.type}
      className={`scroll-mt-24 rounded-xl border p-4 [content-visibility:auto] [contain-intrinsic-size:auto_280px] ${toneClasses} ${highlightClasses}`}
    >
      <div className="flex items-start gap-3">
        <span
          className={joinClassNames('relative mt-0.5 shrink-0', blockClassName)}
          data-testid="feed-item-avatar"
        >
          {actorLinked ? (
            <SettingsLink
              href={memberProfileHref(orgId, item.actor.userId)}
              data-testid="feed-actor-avatar-link"
              aria-label={`View ${formatActor(item.actor)}'s profile`}
              className="block rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-focus"
            >
              <MemberAvatar
                name={member?.name ?? item.actor.displayName ?? ''}
                image={member?.image ?? null}
                size={32}
              />
            </SettingsLink>
          ) : (
            <MemberAvatar
              name={member?.name ?? item.actor.displayName ?? ''}
              image={member?.image ?? null}
              size={32}
            />
          )}
          <span
            className={`absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full ring-2 ring-card [&>svg]:h-3 [&>svg]:w-3 ${
              tone === 'danger'
                ? 'bg-destructive fg-emphasis'
                : 'bg-secondary fg-accent'
            }`}
            aria-hidden="true"
          >
            {icon}
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-s">
            {actorLinked ? (
              <SettingsLink
                href={memberProfileHref(orgId, item.actor.userId)}
                data-testid="feed-actor-link"
                className={joinClassNames(
                  'font-medium fg-primary hover:underline',
                  blockClassName,
                )}
              >
                {formatActor(item.actor)}
              </SettingsLink>
            ) : (
              <span
                className={joinClassNames(
                  'font-medium fg-primary',
                  blockClassName,
                )}
              >
                {formatActor(item.actor)}
              </span>
            )}
            <span className={joinClassNames('fg-primary', blockClassName)}>
              {title}
            </span>
            {internalLink && (
              <SettingsLink
                href={internalLink.href}
                className="inline-flex items-center gap-1 fg-accent hover:underline"
              >
                {internalLink.label}
              </SettingsLink>
            )}
            {externalLink && (
              <a
                href={externalLink.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 fg-accent hover:underline"
              >
                {externalLink.label}
                <ExternalLink size={12} />
              </a>
            )}
          </div>
          {children && (
            <div
              className={joinClassNames(
                'mt-2 text-s fg-secondary',
                blockClassName,
              )}
            >
              {children}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <time className="text-xs fg-secondary" dateTime={item.occurredAt}>
            {formatRelativeTime(item.occurredAt)}
          </time>
          <CopyPermalinkButton orgId={orgId} itemId={item.id} />
        </div>
      </div>
    </article>
  );
}

interface CopyPermalinkButtonProps {
  orgId: string;
  itemId: string;
}

function CopyPermalinkButton({
  orgId,
  itemId,
}: CopyPermalinkButtonProps): JSX.Element {
  const { copied, copy: copyText } = useCopyToClipboard();
  const host = useSettingsHost();

  const copy = async (): Promise<void> => {
    // Permalinks always name the web feed, even when copied from desktop.
    const origin = host.webOrigin();
    // A rejected write (permissions / insecure context) stays quiet.
    await copyText(
      `${origin}/organization/${orgId}/feed/${encodeURIComponent(itemId)}`,
    );
  };

  // The same capsule in both states, so focus stays on it: the circle with
  // the link glyph, then the labelled "Copied" confirmation.
  return copied ? (
    <Button
      variant="secondary"
      size="compact"
      onClick={() => void copy()}
      data-testid="feed-item-copy-link"
      aria-label="Copy link to this activity"
      title="Copy link to this activity"
    >
      <ClipboardCheck size={13} />
      Copied
    </Button>
  ) : (
    <Button
      variant="ghost"
      size="compact"
      iconOnly
      onClick={() => void copy()}
      data-testid="feed-item-copy-link"
      aria-label="Copy link to this activity"
      title="Copy link to this activity"
    >
      <Link2 size={13} />
    </Button>
  );
}

/** A small inline metric chip, e.g. "+120 / -8". */
function MetaChip({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-secondary px-1.5 py-0.5 text-xs font-medium fg-primary">
      {children}
    </span>
  );
}

function MetaRow({ children }: { children: ReactNode }): JSX.Element {
  return <div className="mt-2 flex flex-wrap gap-1.5">{children}</div>;
}

// Resolve the destination for a merged-PR plan chip. A shared plan takes
// precedence over an implemented plan; a plan with neither id renders as a
// plain, non-linked chip.
function planChipHref(item: PrMergedFeedItem): string | null {
  if (item.sharedPlanId) {
    return `/plans/${encodeURIComponent(item.sharedPlanId)}`;
  }
  if (item.planId) {
    return `/plans/implemented/${encodeURIComponent(item.planId)}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-type cards.
// ---------------------------------------------------------------------------

interface TypedCardProps<T extends FeedItem> {
  item: T;
  orgId: string;
  highlighted: boolean;
  member?: OrganizationMember | null;
}

function PrOpenedCard({
  item,
  orgId,
  highlighted,
  member,
}: TypedCardProps<PrOpenedFeedItem>): JSX.Element {
  return (
    <FeedCardShell
      item={item}
      orgId={orgId}
      highlighted={highlighted}
      member={member}
      icon={<GitPullRequest size={16} />}
      title={
        <>
          opened a pull request in{' '}
          <span className="font-medium fg-primary">{item.repoName}</span>
        </>
      }
      externalLink={{ href: item.prUrl, label: `#${item.prNumber}` }}
    >
      <p className="font-medium fg-primary">{item.title}</p>
      {item.branchName && (
        <p className="mt-0.5 truncate font-mono text-xs">{item.branchName}</p>
      )}
      <MetaRow>
        <MetaChip>checks: {item.checkStatus}</MetaChip>
        <MetaChip>review: {item.reviewStatus}</MetaChip>
        {item.hasConflicts && <MetaChip>conflicts</MetaChip>}
        {item.commentCount > 0 && (
          <MetaChip>
            {item.commentCount} comment{item.commentCount === 1 ? '' : 's'}
          </MetaChip>
        )}
      </MetaRow>
      {item.summary && <p className="mt-2">{item.summary}</p>}
    </FeedCardShell>
  );
}

function PrMergedCard({
  item,
  orgId,
  highlighted,
  member,
}: TypedCardProps<PrMergedFeedItem>): JSX.Element {
  const cost = formatCostUsd(item.totalCostUsd);
  const tokens = formatTokens(item.totalTokens);
  const planHref = planChipHref(item);
  return (
    <FeedCardShell
      item={item}
      orgId={orgId}
      highlighted={highlighted}
      member={member}
      icon={<GitMerge size={16} />}
      title={
        <>
          merged a pull request in{' '}
          <span className="font-medium fg-primary">{item.repoName}</span>
        </>
      }
      externalLink={{ href: item.prUrl, label: `#${item.prNumber}` }}
    >
      <p className="font-medium fg-primary">{item.title}</p>
      {item.branchName && (
        <p className="mt-0.5 truncate font-mono text-xs">{item.branchName}</p>
      )}
      <MetaRow>
        {(item.additions !== null || item.deletions !== null) && (
          <MetaChip>
            <span className="fg-success">+{item.additions ?? 0}</span>
            <span className="fg-destructive">−{item.deletions ?? 0}</span>
          </MetaChip>
        )}
        {item.changedFiles !== null && (
          <MetaChip>
            {item.changedFiles} file{item.changedFiles === 1 ? '' : 's'}
          </MetaChip>
        )}
        {cost && <MetaChip>{cost}</MetaChip>}
        {tokens && <MetaChip>{tokens} tokens</MetaChip>}
        {item.models.map((m) => (
          <MetaChip key={m}>{m}</MetaChip>
        ))}
        {item.planTitle &&
          (planHref ? (
            <SettingsLink href={planHref} className="hover:underline">
              <MetaChip>
                <span className="max-w-64 truncate">
                  plan: {item.planTitle}
                </span>
              </MetaChip>
            </SettingsLink>
          ) : (
            <MetaChip>
              <span className="max-w-64 truncate">plan: {item.planTitle}</span>
            </MetaChip>
          ))}
      </MetaRow>
      {item.runUrl && (
        <a
          href={item.runUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-xs fg-accent hover:underline"
        >
          View run
          <ExternalLink size={11} />
        </a>
      )}
      {item.summary && <p className="mt-2">{item.summary}</p>}
    </FeedCardShell>
  );
}

function PlanApprovedCard({
  item,
  orgId,
  highlighted,
  member,
}: TypedCardProps<PlanApprovedFeedItem>): JSX.Element {
  return (
    <FeedCardShell
      item={item}
      orgId={orgId}
      highlighted={highlighted}
      member={member}
      icon={<ListChecks size={16} />}
      title="started implementing a plan"
      internalLink={{
        href: `/plans/implemented/${encodeURIComponent(item.planId)}`,
        label: 'View plan',
      }}
    >
      <p className="font-medium fg-primary">{item.title}</p>
      {(item.reviewStatus || item.planVersion !== null) && (
        <MetaRow>
          {item.reviewStatus && <MetaChip>{item.reviewStatus}</MetaChip>}
          {item.planVersion !== null && (
            <MetaChip>v{item.planVersion}</MetaChip>
          )}
        </MetaRow>
      )}
    </FeedCardShell>
  );
}

function PlanSharedCard({
  item,
  orgId,
  highlighted,
  member,
}: TypedCardProps<PlanSharedFeedItem>): JSX.Element {
  return (
    <FeedCardShell
      item={item}
      orgId={orgId}
      highlighted={highlighted}
      member={member}
      icon={<ShareIcon size={16} />}
      title="shared a plan"
      internalLink={{
        href: `/plans/${encodeURIComponent(item.sharedPlanId)}`,
        label: 'View plan',
      }}
    >
      <p className="font-medium fg-primary">{item.title}</p>
    </FeedCardShell>
  );
}

function PlanUpdatedCard({
  item,
  orgId,
  highlighted,
  member,
}: TypedCardProps<PlanUpdatedFeedItem>): JSX.Element {
  return (
    <FeedCardShell
      item={item}
      orgId={orgId}
      highlighted={highlighted}
      member={member}
      icon={<MessageSquare size={16} />}
      title="updated a shared plan"
      internalLink={{
        href: `/plans/${encodeURIComponent(item.sharedPlanId)}`,
        label: 'View plan',
      }}
    >
      <p className="font-medium fg-primary">{item.title}</p>
      {item.remoteRevisionNumber !== null && (
        <MetaRow>
          <MetaChip>revision {item.remoteRevisionNumber}</MetaChip>
        </MetaRow>
      )}
    </FeedCardShell>
  );
}

function RunSharedCard({
  item,
  orgId,
  highlighted,
  member,
}: TypedCardProps<RunSharedFeedItem>): JSX.Element {
  const cost = formatCostUsd(item.totalCostUsd);
  return (
    <FeedCardShell
      item={item}
      orgId={orgId}
      highlighted={highlighted}
      member={member}
      icon={<ShareIcon size={16} />}
      title="shared a session"
      internalLink={{
        href: `/runs/${encodeURIComponent(item.sharedRunId)}`,
        label: 'View session',
      }}
    >
      <p className="font-medium fg-primary">{item.title}</p>
      <MetaRow>
        <MetaChip>
          {item.turnCount} turn{item.turnCount === 1 ? '' : 's'}
        </MetaChip>
        <MetaChip>{item.status}</MetaChip>
        {item.toolUseCount > 0 && (
          <MetaChip>
            {item.toolUseCount} tool call{item.toolUseCount === 1 ? '' : 's'}
          </MetaChip>
        )}
        {item.model && <MetaChip>{item.model}</MetaChip>}
        {cost && <MetaChip>{cost}</MetaChip>}
      </MetaRow>
    </FeedCardShell>
  );
}

function WorktreeStartedCard({
  item,
  orgId,
  highlighted,
  member,
}: TypedCardProps<WorktreeStartedFeedItem>): JSX.Element {
  return (
    <FeedCardShell
      item={item}
      orgId={orgId}
      highlighted={highlighted}
      member={member}
      icon={<Check size={16} />}
      title={
        item.workspaceName ? (
          <>
            started work in{' '}
            <span className="font-medium fg-primary">{item.workspaceName}</span>
          </>
        ) : (
          'started a new worktree'
        )
      }
    >
      <p className="truncate font-mono text-xs">{item.branchName}</p>
    </FeedCardShell>
  );
}

const WORKTREE_SUMMARY_PROSE_CLASSES =
  'prose prose-sm [--tw-prose-body:var(--fg-primary)] dark:prose-invert max-w-none break-words prose-p:my-0.5 prose-pre:my-1.5 prose-pre:overflow-x-auto prose-pre:bg-fg-primary/[0.06] prose-pre:fg-primary/80 prose-code:fg-accent prose-code:before:content-none prose-code:after:content-none prose-headings:fg-primary prose-a:fg-accent prose-strong:fg-primary prose-li:my-0.5';

/**
 * The desktop flattens structured `WorktreeSummaryData` into a single string via
 * `mapWorktreeSummaryToText()` in `packages/desktop-shared/src/lib/telemetry-mapping.ts`,
 * which emits the title on the first line followed by the description + highlights.
 * We recover that structure by splitting on the first newline. If the desktop
 * serialization order ever changes, this split must change too.
 */
function splitWorktreeSummary(summary: string): {
  title: string;
  body: string;
} {
  const trimmed = summary.trim();
  const newlineIdx = trimmed.indexOf('\n');
  if (newlineIdx === -1) return { title: trimmed, body: '' };
  return {
    title: trimmed.slice(0, newlineIdx).trim(),
    body: trimmed.slice(newlineIdx + 1).trim(),
  };
}

function WorktreeUpdatedCard({
  item,
  orgId,
  highlighted,
  member,
}: TypedCardProps<WorktreeUpdatedFeedItem>): JSX.Element {
  const { title, body } = item.summary
    ? splitWorktreeSummary(item.summary)
    : { title: '', body: '' };

  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Parse markdown only when the body text changes, not when local
  // expanded/overflows state toggles (which still re-renders this card).
  const renderedBody = useMemo(() => <Markdown>{body}</Markdown>, [body]);

  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node || !body) {
      setOverflows(false);
      return;
    }
    // Measure overflow while clamped so short summaries skip the toggle.
    if (!expanded) {
      setOverflows(node.scrollHeight > node.clientHeight + 1);
    }
  }, [body, expanded]);

  return (
    <FeedCardShell
      item={item}
      orgId={orgId}
      highlighted={highlighted}
      member={member}
      icon={<Bot size={16} />}
      title="updated a worktree"
    >
      <p className="truncate font-mono text-xs">{item.branchName}</p>
      {title && <p className="mt-1.5 font-semibold fg-primary">{title}</p>}
      {body && (
        <>
          <div
            ref={bodyRef}
            className={`mt-1 ${WORKTREE_SUMMARY_PROSE_CLASSES} ${
              expanded ? '' : 'line-clamp-3'
            }`}
          >
            {renderedBody}
          </div>
          {(overflows || expanded) && (
            <button
              type="button"
              data-settings-control="link"
              onClick={() => setExpanded((prev) => !prev)}
              className="mt-1 text-xs fg-accent hover:underline"
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </>
      )}
      {item.summary && (
        <WorktreeSummaryHistory orgId={orgId} itemId={item.id} />
      )}
    </FeedCardShell>
  );
}

type SummaryHistoryStatus = 'idle' | 'loading' | 'loaded' | 'error';

/**
 * On-demand "History" disclosure under a {@link WorktreeUpdatedCard}. The live
 * card advances in place, so the full snapshot timeline is fetched lazily the
 * first time the viewer expands it — keeping the feed page payload lean. Entries
 * arrive newest-first; each row reuses {@link splitWorktreeSummary} for the same
 * title/body split as the live card.
 */
function WorktreeSummaryHistory({
  orgId,
  itemId,
}: {
  orgId: string;
  itemId: string;
}): JSX.Element {
  const client = useSettingsClient();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SummaryHistoryStatus>('idle');
  const [entries, setEntries] = useState<WorktreeSummaryHistoryEntry[]>([]);
  // Keyset cursor for the next page; null once the timeline is exhausted.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // Lightweight flag for a "Load more" fetch. Unlike the full-panel `'loading'`
  // status, this keeps the already-rendered entries visible while paging.
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  // Synchronous in-flight gate. `open`/`status` in the callback closure are
  // stale until React re-renders, so two fast clicks could both observe
  // `status === 'idle'` and start duplicate fetches. The ref is updated
  // synchronously and reset in `finally`, so a transient error still allows a
  // later retry. Shared with `loadMore` so a click cannot overlap the initial
  // fetch or another in-flight page.
  const fetchInFlightRef = useRef(false);

  const toggle = useCallback(async (): Promise<void> => {
    const next = !open;
    setOpen(next);
    if (!next) {
      // Clear any stale paging error so reopening starts in a clean state
      // while keeping the already-loaded entries intact.
      setLoadMoreFailed(false);
      return;
    }
    if (status !== 'idle' || fetchInFlightRef.current) {
      return;
    }
    fetchInFlightRef.current = true;
    setStatus('loading');
    try {
      const response = await getWorktreeSummaryHistory(client, orgId, itemId);
      setEntries(response.entries);
      setNextCursor(response.nextCursor);
      setStatus('loaded');
    } catch {
      setStatus('error');
    } finally {
      fetchInFlightRef.current = false;
    }
  }, [client, open, status, orgId, itemId]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (
      status !== 'loaded' ||
      nextCursor === null ||
      fetchInFlightRef.current
    ) {
      return;
    }
    fetchInFlightRef.current = true;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    try {
      const response = await getWorktreeSummaryHistory(client, orgId, itemId, {
        cursor: nextCursor,
      });
      setEntries((prev) => [...prev, ...response.entries]);
      setNextCursor(response.nextCursor);
    } catch {
      // Keep the already-loaded entries visible; surface a retryable message.
      setLoadMoreFailed(true);
    } finally {
      fetchInFlightRef.current = false;
      setLoadingMore(false);
    }
  }, [client, status, nextCursor, orgId, itemId]);

  return (
    <div className="mt-2">
      <Button
        type="button"
        variant="secondary"
        size="compact"
        data-settings-control="disclosure"
        onClick={() => void toggle()}
        data-testid="feed-summary-history-toggle"
        aria-expanded={open}
      >
        <History size={12} />
        {open ? 'Hide history' : 'History'}
      </Button>
      {open && (
        <div
          data-testid="feed-summary-history-panel"
          className="mt-2 border-l pl-3"
        >
          {status === 'loading' && (
            <DelayedLoadingPlaceholder>
              <SettingsTableSkeleton rows={2} />
            </DelayedLoadingPlaceholder>
          )}
          {status === 'error' && (
            <p className="text-xs fg-destructive">
              Couldn&apos;t load history.
            </p>
          )}
          {status === 'loaded' && entries.length === 0 && (
            <p className="text-xs fg-secondary">No earlier versions.</p>
          )}
          {status === 'loaded' && entries.length > 0 && (
            <ol className="flex flex-col gap-3">
              {entries.map((entry) => {
                const { title, body } = splitWorktreeSummary(entry.summary);
                return (
                  <li
                    key={entry.id}
                    data-testid="feed-summary-history-entry"
                    className="flex flex-col gap-0.5"
                  >
                    <time
                      dateTime={entry.generatedAt}
                      className="text-2xs fg-secondary"
                    >
                      {formatRelativeTime(entry.generatedAt)}
                    </time>
                    {title && (
                      <p className="text-s font-medium fg-primary">{title}</p>
                    )}
                    {body && (
                      <p className="whitespace-pre-line text-xs fg-secondary line-clamp-4">
                        {body}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {status === 'loaded' && nextCursor !== null && (
            <Button
              variant="secondary"
              size="compact"
              onClick={() => void loadMore()}
              data-testid="feed-summary-history-load-more"
              disabled={loadingMore}
              aria-busy={loadingMore}
              aria-label="Load more history"
              className="mt-3"
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          )}
          {status === 'loaded' && loadMoreFailed && (
            <p className="mt-2 text-xs fg-destructive">
              Couldn&apos;t load more. Try again.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function AgentSessionCard({
  item,
  orgId,
  highlighted,
  member,
}: TypedCardProps<AgentSessionFeedItem>): JSX.Element {
  const cost = formatCostUsd(item.totalCostUsd);
  return (
    <FeedCardShell
      item={item}
      orgId={orgId}
      highlighted={highlighted}
      member={member}
      icon={<Bot size={16} />}
      title="ran an agent session"
    >
      <MetaRow>
        <MetaChip>
          {item.turnCount} turn{item.turnCount === 1 ? '' : 's'}
        </MetaChip>
        <MetaChip>{item.latestStatus}</MetaChip>
        {item.toolUseCount !== null && (
          <MetaChip>
            {item.toolUseCount} tool call{item.toolUseCount === 1 ? '' : 's'}
          </MetaChip>
        )}
        {item.latestModel && <MetaChip>{item.latestModel}</MetaChip>}
        {cost && <MetaChip>{cost}</MetaChip>}
      </MetaRow>
    </FeedCardShell>
  );
}

function PipelineRunCard({
  item,
  orgId,
  highlighted,
  member,
}: TypedCardProps<PipelineRunFeedItem>): JSX.Element {
  const duration = formatDurationMs(item.runDurationMs);
  return (
    <FeedCardShell
      item={item}
      orgId={orgId}
      highlighted={highlighted}
      member={member}
      icon={<Workflow size={16} />}
      title={
        <>
          ran workflow{' '}
          <span className="font-medium fg-primary">{item.pipelineName}</span>
        </>
      }
    >
      <MetaRow>
        <MetaChip>{item.status}</MetaChip>
        {duration && <MetaChip>{duration}</MetaChip>}
        {item.stepCount !== null && (
          <MetaChip>
            {item.stepCount} step{item.stepCount === 1 ? '' : 's'}
          </MetaChip>
        )}
        {item.agentStepCount !== null && item.agentStepCount > 0 && (
          <MetaChip>{item.agentStepCount} agent</MetaChip>
        )}
        {item.retryCount !== null && item.retryCount > 0 && (
          <MetaChip>
            {item.retryCount} retr{item.retryCount === 1 ? 'y' : 'ies'}
          </MetaChip>
        )}
      </MetaRow>
    </FeedCardShell>
  );
}

function RunFailedCard({
  item,
  orgId,
  highlighted,
  member,
}: TypedCardProps<RunFailedFeedItem>): JSX.Element {
  return (
    <FeedCardShell
      item={item}
      orgId={orgId}
      highlighted={highlighted}
      member={member}
      tone="danger"
      icon={<AlertTriangle size={16} />}
      title={
        <>
          had a run fail:{' '}
          <span className="font-medium fg-primary">{item.label}</span>
        </>
      }
    >
      <MetaRow>
        <MetaChip>{item.status}</MetaChip>
        {item.model && <MetaChip>{item.model}</MetaChip>}
      </MetaRow>
    </FeedCardShell>
  );
}
