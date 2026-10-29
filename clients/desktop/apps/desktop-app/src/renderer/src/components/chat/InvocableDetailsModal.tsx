import { useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { getDocument } from '@canopy/ui-shared/panels';
import {
  ShareActionButton,
  ShareAudienceLabel,
} from '@canopy/ui-shared/components';
import { MarkdownFrontmatterContent } from '@canopy/ui-app';
import { DialogModal } from '../shared';
import { useChatShareData } from '@/hooks/useChatShareData';
import type { InvocableMentionTarget } from '@/lib/invocableMentionIndex';
import type { InvocableMentionContent } from '@/lib/invocableMentionContent';
import { useInvocableMentionContent } from '@/hooks/useInvocableMentionContent';
import {
  pluginDisplayName,
  shareAudienceForTarget,
  shareTargetForEntry,
} from '@/lib/invocableShareTarget';
import {
  requestShare,
  useShareHostAvailable,
} from '@/stores/shareRequestStore';

interface InvocableDetailsModalProps {
  target: InvocableMentionTarget;
  content: InvocableMentionContent | null;
  loading: boolean;
  /** Document of the element that opened the details (a pop-out's own). */
  ownerDocument: Document;
  onClose: () => void;
}

/**
 * The details dialog a skill or command mention opens. When the item (or the
 * plugin that owns it) can be shared, the header carries the common Share
 * action and, once shared, who it is shared with.
 */
export function InvocableDetailsModal({
  target,
  content,
  loading,
  ownerDocument,
  onClose,
}: InvocableDetailsModalProps): JSX.Element {
  const hostAvailable = useShareHostAvailable();
  const data = useChatShareData(hostAvailable);
  const shareTarget = useMemo(
    () =>
      hostAvailable
        ? shareTargetForEntry(
            target.entry,
            data.installedSkills,
            data.marketplaces,
          )
        : null,
    [data.installedSkills, data.marketplaces, hostAvailable, target.entry],
  );
  const audience = useMemo(
    () => (shareTarget ? shareAudienceForTarget(shareTarget, data) : null),
    [data, shareTarget],
  );
  const shareName =
    shareTarget?.kind === 'plugin'
      ? pluginDisplayName(shareTarget, data.marketplaces)
      : (shareTarget?.name ?? target.label);

  const handleShare = (): void => {
    if (!shareTarget) return;
    // One modal at a time: the details dialog (its scrim and focus trap) goes
    // away before the share dialog is requested.
    onClose();
    requestShare(shareTarget, { source: 'mention_detail', ownerDocument });
  };

  const headerActions: ReactNode =
    shareTarget !== null ? (
      <>
        {audience?.status === 'shared' && audience.audience ? (
          <ShareAudienceLabel
            audience={audience.audience}
            teamName={audience.teamName}
            dataTestId="invocable-mention-detail-audience"
          />
        ) : null}
        <ShareActionButton
          placement="header"
          ariaLabel={`Share ${shareName}`}
          dataTestId="invocable-mention-detail-share"
          onClick={handleShare}
        />
      </>
    ) : undefined;

  return createPortal(
    <DialogModal
      onClose={onClose}
      ownerDocument={ownerDocument}
      title={content?.title || target.label}
      titleId="invocable-mention-detail-title"
      maxWidth="2xl"
      headerBorder={false}
      {...(headerActions ? { headerActions } : {})}
    >
      <div
        className={`${POSTHOG_REPLAY_BLOCK_CLASS} flex-1 overflow-y-auto px-5 pb-5`}
      >
        <MarkdownFrontmatterContent
          loading={loading && !content}
          error={content?.error ?? ''}
          content={content?.content ?? null}
          emptyText="This skill or command has no content."
        />
      </div>
    </DialogModal>,
    ownerDocument.body,
  );
}

interface InvocableDetailsButtonProps {
  target: InvocableMentionTarget;
  children: ReactNode;
}

/**
 * A skill name that opens its details, used by the transcript's
 * "Using skill" row. Hovering shows nothing; only a click opens the dialog.
 */
export function InvocableDetailsButton({
  target,
  children,
}: InvocableDetailsButtonProps): JSX.Element {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const { content, loading } = useInvocableMentionContent(target, open);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid="using-skill-details"
        aria-label={`Open ${target.label} details`}
        className="focus-ring rounded bg-fg-primary/[0.08] px-1 py-0.5 font-mono text-2xs hover:bg-fg-primary/[0.14]"
        onClick={() => setOpen(true)}
      >
        {children}
      </button>
      {open && typeof document !== 'undefined' ? (
        <InvocableDetailsModal
          target={target}
          content={content}
          loading={loading}
          ownerDocument={getDocument(buttonRef.current)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
