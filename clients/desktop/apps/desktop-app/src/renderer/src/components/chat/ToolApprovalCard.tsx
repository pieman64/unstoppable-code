import { memo, useCallback, useRef, useState, type JSX } from 'react';
import {
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuLabel,
  FloatingMenu,
} from '@canopy/ui-shared';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  type ActionMenuItem,
} from '@canopy/ui-shared/components';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useChatStore } from '@/stores/chatStore';
import type {
  ApprovalRequestEvent,
  ApprovalPromptDecision,
  ApprovalRuleTarget,
} from '@canopy/desktop-shared/types';
import { formatTransferBytes } from '../browser/browserTransferFormat';
import { ApprovalContentModal } from './ApprovalContentModal';
import {
  previewApprovalContent,
  previewApprovalTargetLabel,
} from './approval-content-preview';
import {
  ChevronDownMediumIcon as AppCatalogChevronDownMediumIcon,
  CircleCheckIcon,
  EyeIcon,
  ShieldIcon,
} from '@canopy/ui-shared/icons/AppIcons';

export interface ToolApprovalCardProps {
  pending: ApprovalRequestEvent;
  /** Non-chat surfaces retain the same card and main-owned approval request. */
  onRespond?: (
    requestId: string,
    decision: ApprovalPromptDecision,
  ) => Promise<void>;
}

/** What the full-content modal shows when opened from the card or a menu. */
interface FullContentView {
  title: string;
  subtitle?: string;
  content: string;
}

/** Copy for the one payload field per request kind that can grow unbounded. */
interface ApprovalContentCopy {
  /** Card button label when the inline preview was cut. */
  viewFull: string;
  /** Modal title when opened from that button. */
  title: string;
}

const APPROVAL_CONTENT_COPY: Record<
  'command' | 'mcp' | 'tool' | 'file-write',
  ApprovalContentCopy
> = {
  command: { viewFull: 'View full command', title: 'Full command' },
  mcp: { viewFull: 'View full parameters', title: 'Full parameters' },
  tool: { viewFull: 'View full input', title: 'Full input' },
  'file-write': { viewFull: 'View full path', title: 'Full path' },
};

const RULE_TARGET_VIEW_TITLE = 'Rule target';
const RULE_TARGET_VIEW_SUBTITLE = 'Applies to every scoped option in this menu';

function describeApprovalTarget(target: ApprovalRuleTarget): string {
  switch (target.kind) {
    case 'command':
      return target.pattern;
    case 'file-write':
      return target.path;
    case 'mcp':
      return target.tool ? `${target.server}: ${target.tool}` : target.server;
    case 'network':
      return target.host;
    case 'tool':
      // The card names the specific skill, but a remembered Skill rule covers
      // every skill. Say so here so the two cannot be confused.
      return target.toolName === 'Skill'
        ? 'Skill (all skills)'
        : target.toolName;
    case 'browser-upload':
      return target.path ? `${target.origin}: ${target.path}` : target.origin;
    default:
      return '';
  }
}

interface ApprovalContentPreviewProps {
  content: string;
  copy: ApprovalContentCopy;
  onViewFull: (view: FullContentView) => void;
}

/**
 * Bounded preview of a request's variable-size payload (CAN-3001). The card
 * is docked at the bottom of the window with no scroll ancestor, so an
 * unbounded `<pre>` pushed the Allow/Deny row off-screen. The preview is cut
 * at a fixed line/character budget; the full text is only ever rendered in
 * `ApprovalContentModal`, which scrolls.
 */
function ApprovalContentPreview({
  content,
  copy,
  onViewFull,
}: ApprovalContentPreviewProps): JSX.Element {
  const preview = previewApprovalContent(content);
  return (
    <>
      <pre
        data-testid="tool-approval-content-preview"
        className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-fg-primary/[0.06] px-2 py-1.5 font-mono text-2xs fg-primary/80"
      >
        <code>
          {preview.text}
          {preview.truncated ? '…' : ''}
        </code>
      </pre>
      {preview.truncated && (
        <button
          type="button"
          data-testid="tool-approval-content-view-full"
          onClick={(): void =>
            onViewFull({ title: copy.title, content: content })
          }
          className="mt-1 text-2xs fg-accent underline-offset-2 transition hover:underline"
        >
          {copy.viewFull}
        </button>
      )}
    </>
  );
}

/**
 * The request's details: the command, path, parameters, or input the agent
 * asks to run. Each kind's root carries the session-replay block, so the
 * card's title and actions stay recorded while the tool input does not.
 */
function ApprovalDetails({
  details,
  onViewFull,
}: {
  details: ApprovalRequestEvent['details'];
  onViewFull: (view: FullContentView) => void;
}): JSX.Element {
  switch (details.kind) {
    case 'command':
      return (
        <div className={`${POSTHOG_REPLAY_BLOCK_CLASS} mt-1.5`}>
          <ApprovalContentPreview
            content={details.command}
            copy={APPROVAL_CONTENT_COPY.command}
            onViewFull={onViewFull}
          />
          {details.cwd && (
            <div className="mt-1 text-2xs fg-secondary">in {details.cwd}</div>
          )}
          {details.reason && (
            <div className="mt-1 text-2xs fg-secondary">{details.reason}</div>
          )}
        </div>
      );
    case 'file-write':
      return (
        <div
          className={`${POSTHOG_REPLAY_BLOCK_CLASS} mt-1.5 text-xs fg-primary/80`}
        >
          {details.path && (
            <ApprovalContentPreview
              content={details.path}
              copy={APPROVAL_CONTENT_COPY['file-write']}
              onViewFull={onViewFull}
            />
          )}
          {details.reason && (
            <div className="mt-1 text-2xs fg-secondary">{details.reason}</div>
          )}
        </div>
      );
    case 'mcp':
      return (
        <div
          className={`${POSTHOG_REPLAY_BLOCK_CLASS} mt-1.5 text-xs fg-primary/80`}
        >
          <code className="rounded bg-fg-primary/[0.06] px-1 py-0.5 font-mono text-2xs">
            {details.server}: {details.tool}
          </code>
          {details.paramsDisplay && (
            <div className="mt-1">
              <ApprovalContentPreview
                content={details.paramsDisplay}
                copy={APPROVAL_CONTENT_COPY.mcp}
                onViewFull={onViewFull}
              />
            </div>
          )}
          {details.reason && (
            <div className="mt-1 text-2xs fg-secondary">{details.reason}</div>
          )}
        </div>
      );
    case 'network':
      return (
        <div
          className={`${POSTHOG_REPLAY_BLOCK_CLASS} mt-1.5 text-xs fg-primary/80`}
        >
          <code className="rounded bg-fg-primary/[0.06] px-1 py-0.5 font-mono text-2xs">
            {details.host}
          </code>
          {details.reason && (
            <div className="mt-1 text-2xs fg-secondary">{details.reason}</div>
          )}
        </div>
      );
    case 'tool':
      return (
        <div
          className={`${POSTHOG_REPLAY_BLOCK_CLASS} mt-1.5 text-xs fg-primary/80`}
        >
          <code className="rounded bg-fg-primary/[0.06] px-1 py-0.5 font-mono text-2xs">
            {details.toolName}
          </code>
          {details.inputSummary && (
            <div className="mt-1">
              <ApprovalContentPreview
                content={details.inputSummary}
                copy={APPROVAL_CONTENT_COPY.tool}
                onViewFull={onViewFull}
              />
            </div>
          )}
          {details.reason && (
            <div className="mt-1 text-2xs fg-secondary">{details.reason}</div>
          )}
        </div>
      );
    case 'browser-upload':
      return (
        <div
          data-testid="tool-approval-upload-details"
          className="mt-1.5 text-xs fg-primary/80"
        >
          <ul className="max-h-24 space-y-0.5 overflow-y-auto">
            {details.files.map((file, index) => (
              <li
                key={`${index}:${file.displayPath}`}
                className="flex min-w-0 items-baseline gap-2"
              >
                <code className="min-w-0 truncate rounded bg-fg-primary/[0.06] px-1 py-0.5 font-mono text-2xs">
                  {file.displayPath}
                </code>
                <span className="shrink-0 text-2xs fg-secondary">
                  {formatTransferBytes(file.sizeBytes)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-1 text-2xs fg-secondary">
            To {details.origin}
            {details.topOrigin && details.topOrigin !== details.origin
              ? ` on ${details.topOrigin}`
              : ''}
          </div>
          {details.reason && (
            <div className="mt-1 text-2xs fg-secondary">{details.reason}</div>
          )}
        </div>
      );
    case 'browser-file-request':
      return (
        <div
          data-testid="tool-approval-file-request-details"
          className="mt-1.5 text-xs fg-primary/80"
        >
          {details.purpose && (
            <div className="whitespace-pre-wrap break-words">
              “{details.purpose}”
            </div>
          )}
          <div className="mt-1 text-2xs fg-secondary">
            For {details.origin}
            {details.topOrigin && details.topOrigin !== details.origin
              ? ` on ${details.topOrigin}`
              : ''}
          </div>
        </div>
      );
    default:
      return <></>;
  }
}

interface ApprovalMenuTargetHeaderProps {
  /** The suggested rule target the scoped options below will persist. */
  targetLabel: string;
  testIdPrefix: 'tool-approval-allow-menu' | 'tool-approval-deny-menu';
  onViewFull: () => void;
}

/**
 * The rule target, shown once per menu on a single truncated line. Inline
 * interpreter payloads keep the complete command as their pattern
 * (`suggestedCommandPattern`), so repeating it under every option row used
 * to make the dropdown itself several screens tall. When the line is cut, a
 * `View full` row opens the same modal the card uses.
 */
function ApprovalMenuTargetHeader({
  targetLabel,
  testIdPrefix,
  onViewFull,
}: ApprovalMenuTargetHeaderProps): JSX.Element {
  const preview = previewApprovalTargetLabel(targetLabel);
  return (
    <>
      <DropdownMenuLabel data-testid={`${testIdPrefix}-target`} mono>
        {/* The rule target is tool input: blocked from session replay. The
            unstyled inline span keeps the label's truncation; the menu
            options around it stay recorded. */}
        <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
          {preview.text}
          {preview.truncated ? '…' : ''}
        </span>
      </DropdownMenuLabel>
      {preview.truncated && (
        <DropdownMenuItem
          data-testid={`${testIdPrefix}-view-full`}
          onClick={onViewFull}
        >
          <DropdownMenuItemIcon>
            <EyeIcon />
          </DropdownMenuItemIcon>
          View full
        </DropdownMenuItem>
      )}
      <DropdownMenuDivider />
    </>
  );
}

function ChevronIcon(): JSX.Element {
  return (
    <AppCatalogChevronDownMediumIcon
      aria-hidden="true"
      width="10"
      height="10"
    />
  );
}

export const ToolApprovalCard = memo(function ToolApprovalCard({
  pending,
  onRespond,
}: ToolApprovalCardProps): JSX.Element {
  const respondInChat = useChatStore((s) => s.respondToApproval);
  const respondToApproval = onRespond ?? respondInChat;

  const [allowMenuOpen, setAllowMenuOpen] = useState(false);
  const [denyMenuOpen, setDenyMenuOpen] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [fullView, setFullView] = useState<FullContentView | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  /**
   * The Allow/Deny button cluster. Passed to both menus as their outside-press
   * boundary so a click on "Allow once" or "Deny" while a menu is open still
   * resolves the prompt in one click instead of being swallowed as the press
   * that dismissed the menu. The two menus close each other explicitly.
   */
  const actionsRef = useRef<HTMLDivElement>(null);
  const allowTriggerRef = useRef<HTMLButtonElement>(null);
  const denyTriggerRef = useRef<HTMLButtonElement>(null);

  const target = pending.suggestedTarget;
  const targetLabel = target ? describeApprovalTarget(target) : undefined;

  const closeFullView = useCallback((): void => setFullView(null), []);

  const toggleAllowMenu = useCallback((): void => {
    setDenyMenuOpen(false);
    setAllowMenuOpen((open) => !open);
  }, []);

  const toggleDenyMenu = useCallback((): void => {
    setAllowMenuOpen(false);
    setDenyMenuOpen((open) => !open);
  }, []);

  const viewFullTarget = useCallback((): void => {
    if (targetLabel === undefined) return;
    setAllowMenuOpen(false);
    setDenyMenuOpen(false);
    setFullView({
      title: RULE_TARGET_VIEW_TITLE,
      subtitle: RULE_TARGET_VIEW_SUBTITLE,
      content: targetLabel,
    });
  }, [targetLabel]);

  const allowOnce = useCallback((): void => {
    void respondToApproval(pending.requestId, {
      behavior: 'allow',
      scope: 'once',
    });
  }, [pending.requestId, respondToApproval]);

  const allowScoped = useCallback(
    (scope: 'session' | 'project' | 'global'): void => {
      if (!target) return;
      void respondToApproval(pending.requestId, {
        behavior: 'allow',
        scope,
        target,
      });
      setAllowMenuOpen(false);
    },
    [pending.requestId, respondToApproval, target],
  );

  const denyOnce = useCallback((): void => {
    void respondToApproval(pending.requestId, {
      behavior: 'deny',
      scope: 'once',
      ...(reason.trim() ? { message: reason.trim() } : {}),
    });
  }, [pending.requestId, reason, respondToApproval]);

  const denyScoped = useCallback(
    (scope: 'project' | 'global'): void => {
      if (!target) return;
      void respondToApproval(pending.requestId, {
        behavior: 'deny',
        scope,
        target,
        ...(reason.trim() ? { message: reason.trim() } : {}),
      });
      setDenyMenuOpen(false);
    },
    [pending.requestId, reason, respondToApproval, target],
  );

  const denyAndStop = useCallback((): void => {
    void respondToApproval(pending.requestId, {
      behavior: 'deny',
      scope: 'once',
      stopTurn: true,
      ...(reason.trim() ? { message: reason.trim() } : {}),
    });
    setDenyMenuOpen(false);
  }, [pending.requestId, reason, respondToApproval]);

  // Each menu's rows are variants of one decision (allow or deny), so they
  // share one icon and only the first row of the run shows it.
  const allowMenuItems: readonly ActionMenuItem[] = [
    {
      key: 'session',
      label: 'Allow for this chat',
      icon: <CircleCheckIcon />,
      onSelect: (): void => allowScoped('session'),
    },
    {
      key: 'project',
      label: 'Always in this project',
      icon: <CircleCheckIcon />,
      onSelect: (): void => allowScoped('project'),
    },
    {
      key: 'global',
      label: 'Always everywhere',
      icon: <CircleCheckIcon />,
      onSelect: (): void => allowScoped('global'),
    },
  ];
  const hasTarget = target !== undefined && targetLabel !== undefined;
  const denyMenuItems: readonly ActionMenuItem[] = [
    ...(hasTarget
      ? [
          {
            key: 'project',
            label: 'Never in this project',
            icon: <ShieldIcon />,
            onSelect: (): void => denyScoped('project'),
          },
          {
            key: 'global',
            label: 'Never everywhere',
            icon: <ShieldIcon />,
            onSelect: (): void => denyScoped('global'),
          },
        ]
      : []),
    {
      key: 'stop',
      label: 'Deny and stop',
      icon: <ShieldIcon />,
      onSelect: denyAndStop,
    },
  ];

  return (
    <div
      ref={cardRef}
      data-testid="tool-approval-card"
      tabIndex={-1}
      className="rounded-lg border border-line-attention/30 bg-warning/[0.06] px-4 py-3"
    >
      <div className="flex items-center gap-1.5">
        <div className="text-sm font-medium fg-primary">{pending.title}</div>
        {pending.subagentId && (
          <span
            data-testid="tool-approval-subagent-badge"
            className="rounded bg-fg-primary/[0.08] px-1.5 py-0.5 text-3xs font-medium fg-secondary"
          >
            Subagent request
          </span>
        )}
      </div>
      {pending.description && (
        <div
          className={`${POSTHOG_REPLAY_BLOCK_CLASS} mt-0.5 text-xs fg-secondary`}
        >
          {pending.description}
        </div>
      )}
      <ApprovalDetails details={pending.details} onViewFull={setFullView} />

      {pending.details.kind === 'browser-file-request' ? (
        // The user picks the files, so there is no rule to remember.
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={allowOnce}
            data-testid="tool-approval-choose-files"
            className="rounded bg-accent-subtle px-3 py-1.5 text-xs font-medium fg-accent transition hover:bg-accent-subtle/80"
          >
            {pending.details.multiple ? 'Choose files…' : 'Choose file…'}
          </button>
          <button
            type="button"
            onClick={denyOnce}
            data-testid="tool-approval-decline-files"
            className="rounded px-3 py-1.5 text-xs fg-secondary transition hover:bg-fg-primary/[0.06] hover:fg-primary/80"
          >
            Decline
          </button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div ref={actionsRef} className="flex flex-wrap items-center gap-2">
            <div className="relative flex">
              <button
                type="button"
                onClick={allowOnce}
                data-testid="tool-approval-allow"
                className="rounded-l bg-accent-subtle px-3 py-1.5 text-xs font-medium fg-accent transition hover:bg-accent-subtle/80"
              >
                Allow once
              </button>
              <button
                ref={allowTriggerRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={allowMenuOpen}
                aria-label="More allow options"
                onClick={toggleAllowMenu}
                className="rounded-r border-l border-line-accent/20 bg-accent-subtle px-1.5 py-1.5 fg-accent transition hover:bg-accent-subtle/80"
              >
                <ChevronIcon />
              </button>
              {/* Portaled and collision-clamped: the card sits at the bottom of
              the window, so an in-card popover opening downward ran behind
              the composer and off the viewport (CAN-3001). */}
              <FloatingMenu
                open={allowMenuOpen}
                onOpenChange={setAllowMenuOpen}
                anchorRef={allowTriggerRef}
                outsidePressBoundaryRef={actionsRef}
                placement="top-left"
                aria-label="Allow options"
                data-testid="tool-approval-allow-menu"
                className="min-w-55 max-w-80"
              >
                {target && targetLabel !== undefined ? (
                  <>
                    <ApprovalMenuTargetHeader
                      targetLabel={targetLabel}
                      testIdPrefix="tool-approval-allow-menu"
                      onViewFull={viewFullTarget}
                    />
                    <ActionMenuRowStyle>
                      <ActionMenuItems
                        items={allowMenuItems}
                        onSelect={(item): void => {
                          if (item.disabled || !item.onSelect) return;
                          item.onSelect();
                          setAllowMenuOpen(false);
                          allowTriggerRef.current?.focus({
                            preventScroll: true,
                          });
                        }}
                      />
                    </ActionMenuRowStyle>
                  </>
                ) : (
                  <DropdownMenuLabel>No additional options</DropdownMenuLabel>
                )}
              </FloatingMenu>
            </div>

            <div className="relative flex">
              <button
                type="button"
                onClick={denyOnce}
                data-testid="tool-approval-deny"
                className="rounded-l px-3 py-1.5 text-xs fg-secondary transition hover:bg-fg-primary/[0.06] hover:fg-primary/80"
              >
                Deny
              </button>
              <button
                ref={denyTriggerRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={denyMenuOpen}
                aria-label="More deny options"
                onClick={toggleDenyMenu}
                className="rounded-r px-1.5 py-1.5 fg-secondary transition hover:bg-fg-primary/[0.06] hover:fg-primary/80"
              >
                <ChevronIcon />
              </button>
              <FloatingMenu
                open={denyMenuOpen}
                onOpenChange={setDenyMenuOpen}
                anchorRef={denyTriggerRef}
                outsidePressBoundaryRef={actionsRef}
                placement="top-left"
                aria-label="Deny options"
                data-testid="tool-approval-deny-menu"
                className="min-w-55 max-w-80"
              >
                {target && targetLabel !== undefined && (
                  <>
                    <ApprovalMenuTargetHeader
                      targetLabel={targetLabel}
                      testIdPrefix="tool-approval-deny-menu"
                      onViewFull={viewFullTarget}
                    />
                  </>
                )}
                <ActionMenuRowStyle>
                  <ActionMenuItems
                    items={denyMenuItems}
                    onSelect={(item): void => {
                      if (item.disabled || !item.onSelect) return;
                      item.onSelect();
                      setDenyMenuOpen(false);
                      denyTriggerRef.current?.focus({ preventScroll: true });
                    }}
                  />
                </ActionMenuRowStyle>
              </FloatingMenu>
            </div>
          </div>

          <button
            type="button"
            onClick={(): void => setReasonOpen((open) => !open)}
            className="text-2xs fg-secondary underline-offset-2 transition hover:fg-primary/80 hover:underline"
          >
            {reasonOpen ? 'Hide reason' : 'Add a reason'}
          </button>
        </div>
      )}

      {reasonOpen && (
        <textarea
          value={reason}
          onChange={(e): void => setReason(e.target.value)}
          placeholder="Explain why (included in the response to the agent)…"
          rows={2}
          className={`${POSTHOG_REPLAY_BLOCK_CLASS} mt-2 w-full resize-y rounded border bg-fg-primary/[0.04] px-2 py-1.5 text-xs fg-primary placeholder:fg-secondary outline-none focus:border-line-accent/40`}
        />
      )}

      {fullView && (
        <ApprovalContentModal
          title={fullView.title}
          subtitle={fullView.subtitle}
          content={fullView.content}
          onClose={closeFullView}
          restoreFocusRef={cardRef}
        />
      )}
    </div>
  );
});
