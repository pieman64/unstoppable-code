import { memo, useRef, useState, type JSX, type ReactNode } from 'react';
import { getDocument } from '@canopy/ui-shared/panels';
import {
  INLINE_CHIP_CLASS,
  INLINE_CHIP_ICON_CLASS,
  RichHoverTooltip,
} from '@canopy/ui-shared/components';
import { SkillIcon } from '@canopy/ui-shared/icons';
import type { InvocableMentionTarget } from '@/lib/invocableMentionIndex';
import { useInvocableMentionContent } from '@/hooks/useInvocableMentionContent';
import { InvocableDetailsModal } from './InvocableDetailsModal';

const DESCRIPTION_LIMIT = 200;

/** The chip itself: the tooltip's wrapper has no box (`contents`). */
function chipInsideTrigger(trigger: HTMLElement): Element | null {
  return trigger.firstElementChild;
}

function truncateDescription(description: string): string {
  const normalized = description.trim().replace(/\s+/g, ' ');
  if (normalized.length <= DESCRIPTION_LIMIT) return normalized;
  return `${normalized.slice(0, DESCRIPTION_LIMIT).trimEnd()}...`;
}

interface InvocableMentionProps {
  target: InvocableMentionTarget;
  children: ReactNode;
}

export const InvocableMention = memo(function InvocableMention({
  target,
  children,
}: InvocableMentionProps): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { content, loading } = useInvocableMentionContent(target, detailsOpen);

  const description = truncateDescription(
    content?.description || target.entry.description,
  );

  return (
    <>
      {/* The whole chip opens the details, like every other chip in prose.
          The preview is portaled out of the transcript's and composer's
          replay blocks: the skill's name and description are recorded. */}
      <RichHoverTooltip
        content={
          <span className="block text-xs">
            <span className="block truncate font-medium fg-primary">
              {target.label}
            </span>
            {description ? (
              <span className="mt-1 block fg-secondary">{description}</span>
            ) : null}
          </span>
        }
        surfacePadding="card"
        surfaceClassName="w-72"
        triggerDisplay="contents"
        getPlacementAnchor={chipInsideTrigger}
      >
        <button
          ref={triggerRef}
          type="button"
          className={INLINE_CHIP_CLASS}
          aria-label={`Open ${target.label} details`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setDetailsOpen(true);
          }}
        >
          <SkillIcon aria-hidden="true" className={INLINE_CHIP_ICON_CLASS} />
          {children}
        </button>
      </RichHoverTooltip>

      {detailsOpen && typeof document !== 'undefined' ? (
        <InvocableDetailsModal
          target={target}
          content={content}
          loading={loading}
          ownerDocument={getDocument(triggerRef.current)}
          onClose={() => setDetailsOpen(false)}
        />
      ) : null}
    </>
  );
});
