import { type JSX, type ReactNode } from 'react';
import {
  CompletedRunsDisclosure as SharedCompletedRunsDisclosure,
  RunConfirmationCard,
} from '@canopy/ui-shared/components';

interface ActivityRunConfirmCardProps {
  /** Prompt copy rendered above the details slot. Caller supplies the
   * "Run <label>?" sentence so the displayed label can vary per section. */
  prompt: ReactNode;
  /** Section-specific details — script command preview, hook action list, … */
  details: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Thin desktop wrapper around the shared {@link RunConfirmationCard}.
 * Preserves the legacy export name used by Hooks and Scripts callers.
 */
export function ActivityRunConfirmCard({
  prompt,
  details,
  onConfirm,
  onCancel,
}: ActivityRunConfirmCardProps): JSX.Element {
  return (
    <RunConfirmationCard
      prompt={prompt}
      details={details}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

interface CompletedRunsDisclosureProps {
  /** Number of completed runs. Rendered in the disclosure label. */
  count: number;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}

/**
 * Thin desktop wrapper around the shared {@link SharedCompletedRunsDisclosure}.
 * Preserves the legacy export name used by Hooks and Scripts callers.
 */
export function CompletedRunsDisclosure({
  count,
  expanded,
  onToggle,
  children,
}: CompletedRunsDisclosureProps): JSX.Element {
  return (
    <SharedCompletedRunsDisclosure
      count={count}
      expanded={expanded}
      onToggle={onToggle}
    >
      {children}
    </SharedCompletedRunsDisclosure>
  );
}
