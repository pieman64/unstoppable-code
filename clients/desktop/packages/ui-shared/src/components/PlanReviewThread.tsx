import {
  useEffect,
  useRef,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { AgentIcon } from '../icons/AgentIcon';
import { WarningIcon } from '../icons/AppIcons';
import { ChevronDownIcon } from '../icons/ChevronDownIcon';
import { ChevronRightIcon } from '../icons/ChevronRightIcon';
import { PencilIcon } from '../icons/PencilIcon';
import { TrashIcon } from '../icons/TrashIcon';
import {
  formatPlanCommentTime,
  planCommentAvatarColor,
  planCommentInitials,
  type PlanReviewAuthorKind,
} from '../lib/plan-comments';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { Button } from './Button';
import { RichHoverTooltip } from './RichHoverTooltip';
import { Tooltip } from './Tooltip';

// ---------------------------------------------------------------------------
// Shared, display-only plan review (comment thread) primitives — a GitHub
// pull-request-review-style experience reused by the desktop renderer and the
// web plan page. Everything here is callback-driven and free of data fetching,
// stores, window.api, Next, Prisma, Electron, and Node.
//
// Surface differences (markdown vs plain text, staged-draft edit/delete on
// desktop, text-anchor selection on web) are injected via slots/props so the
// two surfaces share one visual language without coupling their behavior.
// ---------------------------------------------------------------------------

export interface PlanReviewAuthor {
  /** Display name shown next to the avatar. */
  name: string;
  kind: PlanReviewAuthorKind;
  /** Marks the comment as authored by the signed-in viewer. */
  isYou?: boolean;
  /** Stable key for the deterministic avatar color (user id, else the name). */
  colorKey?: string;
}

export interface CommentAvatarProps {
  author: PlanReviewAuthor;
  compact?: boolean;
}

/** Round initials avatar (or an agent glyph), masking the thread spine. */
export function CommentAvatar({
  author,
  compact = false,
}: CommentAvatarProps): JSX.Element {
  const dimension = compact ? 'h-5 w-5 text-3xs' : 'h-6 w-6 text-3xs';
  if (author.kind === 'agent') {
    return (
      <span
        aria-hidden="true"
        className={`flex ${dimension} shrink-0 items-center justify-center rounded-full bg-fg-primary/[0.08] fg-secondary ring-2 ring-card`}
      >
        <AgentIcon width={compact ? 11 : 13} height={compact ? 11 : 13} />
      </span>
    );
  }
  const color = planCommentAvatarColor(author.colorKey ?? author.name);
  const style: CSSProperties = {
    backgroundColor: color.backgroundColor,
    color: color.color,
  };
  // A person's initials: replay records a same-size box.
  return (
    <span
      aria-hidden="true"
      style={style}
      className={`${REPLAY_BLOCK_CLASS} flex ${dimension} shrink-0 items-center justify-center rounded-full font-semibold uppercase ring-2 ring-card`}
    >
      {planCommentInitials(author.name)}
    </span>
  );
}

export interface PlanReviewCommentProps {
  author: PlanReviewAuthor;
  /** ISO timestamp; rendered as a relative label with an absolute tooltip. */
  timestamp?: string;
  /** Rendered comment body (markdown element on web, markdown/text elsewhere). */
  children: ReactNode;
  /** Trailing controls (e.g. desktop staged-draft edit/delete via
   * {@link PlanReviewCommentActions}). */
  actions?: ReactNode;
  /**
   * Marks the comment as not yet sent to the agent. Renders the shared
   * "Not sent" badge (chip shape, warning color, warning icon) after the
   * author/time header — the single canonical treatment for both the Plan
   * Explore and Code Review surfaces, so neither surface needs to build its
   * own badge markup. Unrelated to a plan's `Pending` review status.
   */
  pending?: boolean;
  compact?: boolean;
  dataTestId?: string;
}

/** A single comment row: avatar gutter, author + time header, then the body. */
export function PlanReviewComment({
  author,
  timestamp,
  children,
  actions,
  pending = false,
  compact = false,
  dataTestId,
}: PlanReviewCommentProps): JSX.Element {
  const time = timestamp ? formatPlanCommentTime(timestamp) : null;
  return (
    <li className="relative flex gap-2.5" data-testid={dataTestId}>
      <CommentAvatar author={author} compact={compact} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-x-2 gap-y-0.5">
          {/* A person's name is blocked from replay; an agent's is recorded. */}
          <span
            className={`${author.kind === 'agent' ? '' : `${REPLAY_BLOCK_CLASS} `}truncate text-xs font-semibold fg-primary`}
          >
            {author.name}
          </span>
          {author.isYou && (
            <span className="rounded-full bg-fg-primary/[0.06] px-1.5 py-px text-3xs font-medium fg-secondary">
              you
            </span>
          )}
          {author.kind === 'agent' && (
            <span className="rounded-full bg-fg-primary/[0.06] px-1.5 py-px text-3xs font-medium fg-secondary">
              agent
            </span>
          )}
          {time && (
            <time
              dateTime={timestamp}
              title={time.absolute}
              className="text-2xs fg-secondary"
            >
              {time.relative}
            </time>
          )}
          {pending && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning-subtle px-1.5 py-px text-3xs font-medium fg-warning">
              <WarningIcon size={12} exactSize />
              Not sent
            </span>
          )}
          {actions && (
            <div className="ml-auto flex items-center">{actions}</div>
          )}
        </div>
        <div
          className={`mt-0.5 break-words fg-primary ${
            compact ? 'text-xs' : 'text-s'
          }`}
        >
          {children}
        </div>
      </div>
    </li>
  );
}

export interface PlanReviewCommentActionsProps {
  onEdit: () => void;
  onDelete: () => void;
  /** Test ID for the edit button. Omit to leave the hook off (e.g. when a
   * surface intentionally reuses one static id across cards). */
  editTestId?: string;
  /** Test ID for the delete button. */
  deleteTestId?: string;
}

/**
 * Edit/delete icon-button pair for an unsubmitted (staged) comment's
 * `actions` slot. Single source of truth for the affordance both the Plan
 * Explore document panel and the Code Review tray/popover cards use, so the
 * two surfaces never drift on markup, icons, or hover/focus treatment.
 */
export function PlanReviewCommentActions({
  onEdit,
  onDelete,
  editTestId,
  deleteTestId,
}: PlanReviewCommentActionsProps): JSX.Element {
  return (
    <>
      <Tooltip label="Edit unsubmitted comment">
        <button
          type="button"
          onClick={onEdit}
          aria-label="Edit comment"
          data-testid={editTestId}
          className="focus-ring rounded-md p-0.5 fg-secondary hover:bg-secondary hover:fg-primary"
        >
          <PencilIcon width={13} height={13} />
        </button>
      </Tooltip>
      <Tooltip label="Delete unsubmitted comment">
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete comment"
          data-testid={deleteTestId}
          className="focus-ring rounded-md p-0.5 fg-secondary hover:bg-secondary hover:fg-destructive"
        >
          <TrashIcon width={13} height={13} />
        </button>
      </Tooltip>
    </>
  );
}

export interface PlanReviewThreadReference {
  /** Anchored quote / passage the thread is attached to. */
  text: string;
  /** True when the anchored passage no longer matches the plan content. */
  outdated?: boolean;
  /** Optional leading icon (e.g. plan-document vs diagram source). */
  icon?: ReactNode;
  /** Accessible label for the leading icon. */
  iconLabel?: string;
  /** Optional origin badge displayed alongside the reference. */
  badge?: ReactNode;
  /**
   * When provided, the reference text renders as a button that invokes this on
   * click (e.g. jump to the anchored file/line in a diff viewer). Omit for a
   * plain, non-interactive label.
   */
  onActivate?: () => void;
  /** Accessible label / tooltip for the activatable reference. */
  activateLabel?: string;
}

export interface PlanReviewThreadProps {
  status: 'open' | 'resolved';
  commentCount: number;
  /** The anchored reference; omit for a general (unanchored) comment. */
  reference?: PlanReviewThreadReference;
  /** Renders a chevron toggle in the header when provided. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Highlighted state (e.g. desktop active-thread sync with the document). */
  active?: boolean;
  compact?: boolean;
  /** Comment rows (`PlanReviewComment`). Hidden while collapsed. */
  children: ReactNode;
  /** Composer + resolve action rendered at the thread footer. */
  footer?: ReactNode;
  dataTestId?: string;
  /** Extra data-* attributes (e.g. desktop's `data-comment-card`). */
  dataAttributes?: Record<string, string>;
}

/**
 * A review conversation card: a header summarizing status + the anchored
 * reference, a connected stack of comments, and a footer slot for the reply
 * composer. Collapsing shows the header alone (used for resolved/outdated).
 */
export function PlanReviewThread({
  status,
  commentCount,
  reference,
  collapsed = false,
  onToggleCollapsed,
  active = false,
  compact = false,
  children,
  footer,
  dataTestId,
  dataAttributes,
}: PlanReviewThreadProps): JSX.Element {
  const resolved = status === 'resolved';
  return (
    <div
      data-testid={dataTestId}
      {...dataAttributes}
      className={`overflow-hidden rounded-lg border bg-card transition-colors ${
        active ? 'border-line-accent/60 ring-1 ring-line-accent/40' : ''
      }`}
    >
      <div
        className={`flex items-center gap-2 border-b bg-fg-primary/[0.02] px-3 ${
          compact ? 'py-1.5' : 'py-2'
        }`}
      >
        {onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            data-testid={dataTestId ? `${dataTestId}-toggle` : undefined}
            className="focus-ring -ml-1 shrink-0 rounded p-0.5 fg-secondary hover:fg-primary"
          >
            {collapsed ? (
              <ChevronRightIcon width={14} height={14} />
            ) : (
              <ChevronDownIcon width={14} height={14} />
            )}
          </button>
        )}
        <span
          className={`flex shrink-0 items-center gap-1 text-2xs font-semibold ${
            resolved ? 'fg-success' : 'fg-secondary'
          }`}
        >
          <span
            aria-hidden="true"
            className={`inline-block h-2 w-2 rounded-full ${
              resolved ? 'bg-success' : 'bg-fg-success-strong'
            }`}
          />
          {resolved ? 'Resolved' : 'Open'}
        </span>
        <span className="shrink-0 text-2xs fg-secondary">
          · {commentCount} {commentCount === 1 ? 'comment' : 'comments'}
        </span>
        {reference?.badge}
        {reference?.icon && (
          <span
            className="shrink-0 fg-secondary"
            aria-label={reference.iconLabel}
            title={reference.iconLabel}
          >
            {reference.icon}
          </span>
        )}
        {reference ? (
          reference.onActivate ? (
            <RichHoverTooltip
              content={reference.activateLabel ?? reference.text}
              triggerWrapperClassName="min-w-0 flex-1"
              surfaceClassName="w-max max-w-96"
              surfacePadding="compact"
            >
              <button
                type="button"
                onClick={reference.onActivate}
                aria-label={reference.activateLabel ?? reference.text}
                className="focus-ring w-full min-w-0 truncate text-left text-2xs italic fg-secondary/90 transition-colors hover:fg-primary hover:underline"
              >
                {reference.text}
              </button>
            </RichHoverTooltip>
          ) : (
            <span className="min-w-0 flex-1 truncate text-2xs italic fg-secondary/90">
              {reference.text}
            </span>
          )
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {reference?.outdated && (
          <span className="shrink-0 rounded-full border border-line-attention bg-warning-subtle px-1.5 py-0.5 text-3xs font-medium fg-warning">
            outdated
          </span>
        )}
      </div>
      {!collapsed && (
        <div className={compact ? 'px-3 py-2.5' : 'px-3.5 py-3'}>
          <ThreadSpine compact={compact}>{children}</ThreadSpine>
          {footer && <div className="mt-3">{footer}</div>}
        </div>
      )}
    </div>
  );
}

/** Wraps the comment rows with a subtle vertical spine behind the avatars. */
function ThreadSpine({
  compact,
  children,
}: {
  compact: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="relative">
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute top-3 bottom-3 w-px bg-line-base/70 ${
          compact ? 'left-2.25' : 'left-2.75'
        }`}
      />
      <ul className={`relative flex flex-col ${compact ? 'gap-3' : 'gap-3.5'}`}>
        {children}
      </ul>
    </div>
  );
}

export interface PlanCommentComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Leading avatar for the signed-in viewer. */
  viewer?: PlanReviewAuthor;
  placeholder?: string;
  submitLabel?: string;
  /** Disables the submit button (e.g. empty input or in-flight write). */
  submitDisabled?: boolean;
  /** Optional secondary action on the left (e.g. Resolve / Reopen). */
  secondaryAction?: {
    label: string;
    onClick: () => void;
    dataTestId?: string;
  };
  compact?: boolean;
  autoFocus?: boolean;
  inputTestId?: string;
  submitTestId?: string;
}

/**
 * Compact reply composer: an auto-growing textarea (Enter to send, Shift+Enter
 * for a newline) with a primary submit and an optional quieter secondary action
 * (Resolve/Reopen), mirroring GitHub's inline reply affordance.
 */
export function PlanCommentComposer({
  value,
  onChange,
  onSubmit,
  viewer,
  placeholder = 'Reply… (Enter to send, Shift+Enter for a new line)',
  submitLabel = 'Reply',
  submitDisabled,
  secondaryAction,
  compact = false,
  autoFocus = false,
  inputTestId,
  submitTestId,
}: PlanCommentComposerProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const disabled = submitDisabled ?? value.trim().length === 0;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) {
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      if (!disabled) {
        onSubmit();
      }
    }
  };

  return (
    <div className="flex gap-2.5">
      {viewer && <CommentAvatar author={viewer} compact={compact} />}
      <div className="min-w-0 flex-1 rounded-lg border bg-base focus-within:border-line-focus">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          autoFocus={autoFocus}
          data-testid={inputTestId}
          placeholder={placeholder}
          className={`block max-h-48 w-full resize-none bg-transparent px-2.5 py-2 fg-primary outline-none ${
            compact ? 'text-xs' : 'text-s'
          }`}
        />
        <div className="flex items-center justify-end gap-2 border-t px-2 py-1.5">
          {secondaryAction && (
            <Button
              variant="ghost"
              size="compact"
              onClick={secondaryAction.onClick}
              data-testid={secondaryAction.dataTestId}
              className="mr-auto"
            >
              {secondaryAction.label}
            </Button>
          )}
          <Button
            variant="primary"
            size="compact"
            onClick={onSubmit}
            disabled={disabled}
            data-testid={submitTestId}
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
