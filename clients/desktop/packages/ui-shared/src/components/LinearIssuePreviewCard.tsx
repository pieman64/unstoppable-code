import type { JSX } from 'react';
import type { LinearIssuePreview } from '@canopy/protocol/reference-previews';
import { formatRelativeTime } from '../lib/format-relative-time';

export type LinearIssuePreviewCardView =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly preview: LinearIssuePreview;
      readonly checkedAt: number;
      /** A stale value is showing while it refreshes, or after a failed refresh. */
      readonly stale: boolean;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'disconnected' | 'unavailable' | 'failed';
    };

const UNAVAILABLE_COPY = {
  disconnected: 'Connect Linear in Settings to preview this issue',
  unavailable: 'Preview unavailable',
  failed: 'Couldn’t reach Linear',
} as const;

/** Informational hover card for one Linear issue reference. */
export function LinearIssuePreviewCard({
  identifier,
  view,
}: {
  identifier: string;
  view: LinearIssuePreviewCardView;
}): JSX.Element {
  if (view.status !== 'ready') {
    return (
      <div className="flex min-w-0 flex-col gap-0.5 text-xs" aria-live="polite">
        <span className="font-mono text-2xs fg-secondary">{identifier}</span>
        <span className="fg-secondary">
          {view.status === 'loading'
            ? 'Loading preview…'
            : UNAVAILABLE_COPY[view.reason]}
        </span>
      </div>
    );
  }
  const { preview } = view;
  const facts = [
    preview.status,
    preview.assignee ?? 'Unassigned',
    preview.project,
  ].filter((fact): fact is string => Boolean(fact));
  return (
    <div
      className="flex min-w-0 flex-col gap-1 text-xs"
      data-testid="linear-issue-preview-card"
    >
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 font-mono text-2xs fg-secondary">
          {preview.identifier}
        </span>
        <span className="min-w-0 break-words font-medium fg-primary">
          {preview.title}
        </span>
      </div>
      {preview.description && (
        <p className="line-clamp-3 fg-secondary">{preview.description}</p>
      )}
      <div className="truncate fg-secondary">{facts.join(' · ')}</div>
      <div className="truncate text-2xs tabular-nums fg-tertiary">
        {view.stale
          ? `Checked ${formatRelativeTime(view.checkedAt)}`
          : `Updated ${formatRelativeTime(preview.updatedAt)}`}
      </div>
    </div>
  );
}
