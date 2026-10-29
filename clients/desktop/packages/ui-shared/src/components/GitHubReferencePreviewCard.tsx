import type { JSX, ReactNode } from 'react';
import type {
  GitHubItemPreview,
  GitHubPreview,
  GitHubRepositoryPreview,
} from '@canopy/protocol/reference-previews';
import { formatRelativeTime } from '../lib/format-relative-time';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { PersonIcon } from '../icons/AppIcons';
import { DisplayAvatar } from './DisplayAvatar';
import { GroupedDiffStats } from './GroupedDiffStats';
import { CometSpinner } from './CometSpinner';
import {
  PR_STATUS_LINES,
  prStatusLineKind,
  type WorktreeRowPrStatus,
} from './pr-status-glyph';

export type GitHubReferencePreviewCardView =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly preview: GitHubPreview;
      readonly checkedAt: number;
      /** A stale value is showing while it refreshes, or after a failed refresh. */
      readonly stale: boolean;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'disconnected' | 'unavailable' | 'failed';
    };

const UNAVAILABLE_COPY = {
  disconnected: 'Connect GitHub in Settings to preview this',
  unavailable: 'Preview unavailable',
  failed: "Couldn't reach GitHub",
} as const;

const ITEM_STATE_COPY = {
  open: 'Open',
  closed: 'Closed',
  merged: 'Merged',
} as const;

function itemFacts(preview: GitHubItemPreview): string[] {
  const isPull = preview.itemType === 'pull';
  const state =
    isPull && preview.draft && preview.state === 'open'
      ? 'Draft'
      : ITEM_STATE_COPY[preview.state];
  return [isPull ? 'Pull request' : 'Issue', state];
}

function repositoryFacts(preview: GitHubRepositoryPreview): string[] {
  const facts = ['Repository', preview.private ? 'Private' : 'Public'];
  if (preview.archived) facts.push('Archived');
  return facts;
}

/**
 * How a ready item card is laid out. `classic` is the label and title, body
 * excerpt, and facts line; `status` leads with the state pill, then the
 * title, then the author and the change size.
 */
export type GitHubReferencePreviewCardLayout = 'classic' | 'status';

/** The item as the sidebar's PR glyph reads it. */
function pullStatus(preview: GitHubItemPreview): WorktreeRowPrStatus {
  const open = preview.state === 'open';
  const pull = preview.pull;
  return {
    state: open && preview.draft ? 'draft' : preview.state,
    checkStatus: pull?.checks,
    reviewStatus: pull?.reviewDecision ?? undefined,
    hasConflicts: open && pull?.mergeable === 'conflicting',
    inMergeQueue: open && pull?.inMergeQueue === true,
  };
}

/** Line icons draw a 1.5px line at their 14px size. */
const CARD_ICON_STROKE_PX = 1.5;

/** Colored glyph and label, no badge: `Merge conflicts`, `Merged`, `Draft`. */
function StatusLabel({ preview }: { preview: GitHubItemPreview }): JSX.Element {
  if (preview.itemType === 'issue') {
    // No issue glyph in the icon set: the state reads as text alone.
    return (
      <span
        className="min-w-0 truncate fg-secondary"
        data-testid="github-reference-preview-status"
      >
        {ITEM_STATE_COPY[preview.state]}
      </span>
    );
  }
  const kind = prStatusLineKind(pullStatus(preview));
  const { label, Icon, ink } = PR_STATUS_LINES[kind];
  return (
    // Shrinks last-but-one: the repository gives way first, then the label
    // cuts off with "…", so the number and age always stay in the card.
    <span
      className={`inline-flex min-w-0 items-center gap-1 ${ink}`}
      data-testid="github-reference-preview-status"
      data-status={kind}
    >
      {Icon ? (
        <Icon
          size={14}
          drawnStrokeWidth={CARD_ICON_STROKE_PX}
          className="shrink-0"
        />
      ) : (
        <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
          <CometSpinner sizePx={12} />
        </span>
      )}
      <span className="truncate">{label}</span>
    </span>
  );
}

/** A quiet count on the card's footer, such as `42 files`. */
function FactChip({
  children,
  testId,
}: {
  children: ReactNode;
  testId: string;
}): JSX.Element {
  return (
    <span
      className="inline-flex h-5 shrink-0 items-center rounded-full bg-muted px-2 fg-secondary"
      data-testid={testId}
    >
      {children}
    </span>
  );
}

function StatusLayoutItemCard({
  preview,
  stale,
  checkedAt,
}: {
  preview: GitHubItemPreview;
  /** A cached value is showing: name when it was checked, not updated. */
  stale: boolean;
  checkedAt: number;
}): JSX.Element {
  const pull = preview.itemType === 'pull' ? preview.pull : undefined;
  const hasChanges = pull !== undefined && pull.additions + pull.deletions > 0;
  return (
    // The surface pads 12px by 8px. The extra inset here sets 14px of
    // drawn ink on every side: the 16px status row's glyph ink sits 2px
    // inside it, the chips' fill sits on the box edge.
    <div
      className="flex min-w-0 flex-col gap-2 px-0.5 pt-1 pb-1.5 text-xs"
      data-testid="github-reference-preview-card"
      data-layout="status"
    >
      <div className="flex h-4 min-w-0 items-center gap-1.5 fg-tertiary">
        <StatusLabel preview={preview} />
        <span
          className={`${REPLAY_BLOCK_CLASS} min-w-0 flex-1 truncate`}
          data-testid="github-reference-preview-repository"
        >
          {preview.repository}
        </span>
        <span className="shrink-0">#{preview.number}</span>
        <span className="shrink-0" data-testid="github-reference-preview-age">
          {formatRelativeTime(preview.updatedAt)}
        </span>
      </div>
      <p
        className={`${REPLAY_BLOCK_CLASS} line-clamp-2 break-words fg-primary`}
      >
        {preview.title}
      </p>
      {/* A cached card that couldn't refresh says so on its own line, so the
          header keeps the status whole. */}
      {stale && (
        <span
          className="-mt-1 text-2xs fg-tertiary"
          data-testid="github-reference-preview-checked"
        >
          Checked {formatRelativeTime(checkedAt)}
        </span>
      )}
      {(preview.author || pull) && (
        // The chips' 20px sets the row; without them, a 16px row keeps the
        // avatar's ink on the same 14px bottom inset.
        <div
          className={`flex min-w-0 items-center gap-2 ${pull ? 'h-5' : 'h-4'}`}
        >
          {preview.author && (
            <span className="flex min-w-0 flex-1 items-center gap-1 fg-secondary">
              <DisplayAvatar
                name={preview.author}
                image={preview.authorAvatarUrl}
                size="xs"
                fallback={
                  <PersonIcon
                    size={14}
                    drawnStrokeWidth={CARD_ICON_STROKE_PX}
                  />
                }
              />
              <span className={`${REPLAY_BLOCK_CLASS} truncate`}>
                {preview.author}
              </span>
            </span>
          )}
          {pull && (
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {hasChanges && (
                <FactChip testId="github-reference-preview-diff">
                  <GroupedDiffStats
                    insertions={pull.additions}
                    deletions={pull.deletions}
                    numerals="proportional"
                  />
                </FactChip>
              )}
              <FactChip testId="github-reference-preview-files">
                {pull.changedFiles === 1
                  ? '1 file'
                  : `${FILE_COUNT_FORMAT.format(pull.changedFiles)} files`}
              </FactChip>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const FILE_COUNT_FORMAT = new Intl.NumberFormat('en-US');

/** Informational hover card for one GitHub repository, issue, or pull request reference. */
export function GitHubReferencePreviewCard({
  label,
  view,
  layout = 'classic',
}: {
  /** Display identity: `#1234`, `owner/repo#1234`, or `owner/repo`. */
  label: string;
  view: GitHubReferencePreviewCardView;
  layout?: GitHubReferencePreviewCardLayout;
}): JSX.Element {
  if (view.status !== 'ready') {
    return (
      <div className="flex min-w-0 flex-col gap-0.5 text-xs" aria-live="polite">
        <span
          className={`${REPLAY_BLOCK_CLASS} font-mono text-2xs fg-secondary`}
        >
          {label}
        </span>
        <span className="fg-secondary">
          {view.status === 'loading'
            ? 'Loading preview…'
            : UNAVAILABLE_COPY[view.reason]}
        </span>
      </div>
    );
  }
  const { preview } = view;
  if (layout === 'status' && preview.kind === 'item') {
    return (
      <StatusLayoutItemCard
        preview={preview}
        stale={view.stale}
        checkedAt={view.checkedAt}
      />
    );
  }
  const facts =
    preview.kind === 'item' ? itemFacts(preview) : repositoryFacts(preview);
  return (
    <div
      className="flex min-w-0 flex-col gap-1 text-xs"
      data-testid="github-reference-preview-card"
    >
      {preview.kind === 'item' ? (
        // Inline flow, not flex: a long `owner/repo#1234` label wraps with the
        // title instead of squeezing it.
        <div className="min-w-0 break-words">
          <span
            className={`${REPLAY_BLOCK_CLASS} mr-1.5 font-mono text-2xs fg-secondary`}
          >
            {label}
          </span>
          <span className={`${REPLAY_BLOCK_CLASS} font-medium fg-primary`}>
            {preview.title}
          </span>
        </div>
      ) : (
        <div
          className={`${REPLAY_BLOCK_CLASS} min-w-0 break-words font-medium fg-primary`}
        >
          {preview.fullName}
        </div>
      )}
      {preview.description && (
        <p className={`${REPLAY_BLOCK_CLASS} line-clamp-3 fg-secondary`}>
          {preview.description}
        </p>
      )}
      <div className="truncate fg-secondary">
        {facts.join(' · ')}
        {preview.kind === 'item' && preview.author && (
          <>
            {' · by '}
            <span className={REPLAY_BLOCK_CLASS}>{preview.author}</span>
          </>
        )}
      </div>
      <div className="truncate text-2xs tabular-nums fg-tertiary">
        {view.stale
          ? `Checked ${formatRelativeTime(view.checkedAt)}`
          : `Updated ${formatRelativeTime(preview.updatedAt)}`}
      </div>
    </div>
  );
}
