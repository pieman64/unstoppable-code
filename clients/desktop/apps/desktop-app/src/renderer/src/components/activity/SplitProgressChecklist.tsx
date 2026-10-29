import { type JSX } from 'react';
import {
  ProgressChecklist,
  type ProgressChecklistBadge,
} from '@canopy/ui-shared/components';
import type { SplitProgressView } from '@/lib/split-progress';

/** Renders a `SplitProgressView` as a badged progress checklist. */
export function SplitProgressChecklist({
  view,
}: {
  view: SplitProgressView;
}): JSX.Element {
  const badge: ProgressChecklistBadge =
    view.terminal === 'error'
      ? { label: 'Failed', tone: 'error' }
      : view.terminal === 'cancelled'
        ? { label: 'Cancelled', tone: 'error' }
        : view.terminal === 'done'
          ? { label: 'Split complete', tone: 'success' }
          : { label: 'Splitting', tone: 'progress' };
  return (
    <ProgressChecklist steps={view.rows} error={view.errorText} badge={badge} />
  );
}
