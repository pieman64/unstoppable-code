'use client';

import {
  memo,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '@canopy/ui-shared/icons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

export interface AgentActivitySectionProps {
  /**
   * Create/update artifact cards. They are compact, so the section packs more
   * per row as its container grows.
   */
  readonly artifactItems?: readonly ReactNode[];
  /** Pipeline run rows, full width below the artifact cards. */
  readonly pipelineRunItems?: readonly ReactNode[];
  /** Watched GitHub workflow run rows, full width at the end. */
  readonly githubRunItems?: readonly ReactNode[];
  readonly variant: 'active' | 'completed';
  readonly defaultExpanded?: boolean;
}

const EMPTY_ITEMS: readonly ReactNode[] = [];

/**
 * A turn's agent activity: its capability tiles and the runs placed in it.
 * Background agents, tasks and live runs are the composer's background
 * drawer's. Hosts supply the cards; this owns the header, collapse, count
 * and the replay-blocked item list.
 */
export const AgentActivitySection = memo(function AgentActivitySection({
  artifactItems = EMPTY_ITEMS,
  pipelineRunItems = EMPTY_ITEMS,
  githubRunItems = EMPTY_ITEMS,
  variant,
  defaultExpanded = true,
}: AgentActivitySectionProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const previousDefaultExpanded = useRef(defaultExpanded);
  useEffect(() => {
    if (previousDefaultExpanded.current === defaultExpanded) return;
    previousDefaultExpanded.current = defaultExpanded;
    setExpanded(defaultExpanded);
  }, [defaultExpanded]);
  const itemCount =
    artifactItems.length + pipelineRunItems.length + githubRunItems.length;
  if (itemCount === 0) return null;
  return (
    <section
      // The box's 20px corners are its 12px cards' corners plus the 8px
      // inset, so the two curves stay concentric.
      className={
        variant === 'active'
          ? '@container mx-auto w-full max-w-[var(--chat-composer-shell-width)] chat-width-transition shrink-0 border-t bg-base px-4 py-2'
          : '@container rounded-2xl border bg-fg-primary/[0.02] p-2'
      }
      data-testid={`agent-activity-${variant}`}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} agent activity`}
        >
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          <span className="text-s font-medium fg-primary">Agent activity</span>
          <span className="text-xs fg-secondary">
            {itemCount} {itemCount === 1 ? 'item' : 'items'}
          </span>
        </button>
      </div>
      {expanded ? (
        // The items are conversation content (artifacts, runs): blocked from
        // session replay. The header stays recorded.
        <div
          className={`${REPLAY_BLOCK_CLASS} mt-2 space-y-2 ${variant === 'active' ? 'max-h-[min(240px,35vh)]' : 'max-h-80'} overflow-y-auto`}
          data-testid="agent-activity-items"
        >
          {artifactItems.length > 0 ? (
            <div
              className="grid grid-cols-1 gap-2 @[400px]:grid-cols-2 @[640px]:grid-cols-3 @[880px]:grid-cols-4 @[1120px]:grid-cols-5 @[1360px]:grid-cols-6"
              data-testid="agent-activity-artifact-items"
            >
              {artifactItems}
            </div>
          ) : null}
          {pipelineRunItems.length > 0 ? (
            <div
              className="space-y-2"
              data-testid="agent-activity-pipeline-run-items"
            >
              {pipelineRunItems}
            </div>
          ) : null}
          {githubRunItems.length > 0 ? (
            <div
              className="space-y-2"
              data-testid="agent-activity-github-run-items"
            >
              {githubRunItems}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
});
