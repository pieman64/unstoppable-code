'use client';

import {
  memo,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import { SubagentViewTreeAction } from '@canopy/ui-shared/components';
import { ChevronDownIcon, ChevronRightIcon } from '@canopy/ui-shared/icons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

import { BackgroundTasksList } from '../activity/BackgroundTasksList';
import { StopAllDelegatesControl } from './StopAllDelegatesControl';
import type { BackgroundTaskHostActions } from '../activity/background-tasks-section';

export interface AgentActivitySectionProps {
  /** Agent and delegation cards, rendered first. */
  readonly agentItems?: readonly ReactNode[];
  /**
   * Create/update artifact cards. They are compact, so the section packs more
   * per row as its container grows.
   */
  readonly artifactItems?: readonly ReactNode[];
  /** Pipeline run rows, full width below the artifact cards. */
  readonly pipelineRunItems?: readonly ReactNode[];
  /** Watched GitHub workflow run rows, full width at the end. */
  readonly githubRunItems?: readonly ReactNode[];
  /**
   * Background tasks this turn launched. They count toward the header total;
   * `backgroundTaskActions` lists them. Without it they are counted but not
   * listed, so a host that cannot act on them still reports them.
   */
  readonly backgroundTasks?: readonly BackgroundTask[];
  /** Without host actions, tasks are counted but not listed. */
  readonly backgroundTaskActions?: BackgroundTaskHostActions;
  readonly variant: 'active' | 'completed';
  readonly defaultExpanded?: boolean;
  /**
   * Opens the subagent tree for the chat. Offered beside the header while the
   * section lists agent items.
   */
  readonly onViewSubagentTree?: () => void;
  /**
   * Managed delegations in this chat that are queued, starting or running, at
   * any depth. While non-empty (and `onStopAllDelegations` is supplied) the
   * header offers Stop all delegates.
   */
  readonly liveDelegationIds?: readonly string[];
  /**
   * Stops every live managed delegation in the chat. Resolves `true` once the
   * host accepted the stop; the host reports failures. Background tasks,
   * pipeline runs, GitHub runs and native subagents are never affected.
   */
  readonly onStopAllDelegations?: () => Promise<boolean>;
}

const EMPTY_ITEMS: readonly ReactNode[] = [];
const EMPTY_BACKGROUND_TASKS: readonly BackgroundTask[] = [];
const EMPTY_DELEGATION_IDS: readonly string[] = [];

/**
 * A turn's agent activity: its agents, artifacts, background tasks and runs.
 * Hosts supply the cards; this owns the header, collapse, count, Stop all
 * delegates and the replay-blocked item list.
 */
export const AgentActivitySection = memo(function AgentActivitySection({
  agentItems = EMPTY_ITEMS,
  artifactItems = EMPTY_ITEMS,
  pipelineRunItems = EMPTY_ITEMS,
  githubRunItems = EMPTY_ITEMS,
  backgroundTasks = EMPTY_BACKGROUND_TASKS,
  backgroundTaskActions,
  variant,
  defaultExpanded = true,
  onViewSubagentTree,
  liveDelegationIds = EMPTY_DELEGATION_IDS,
  onStopAllDelegations,
}: AgentActivitySectionProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const previousDefaultExpanded = useRef(defaultExpanded);
  useEffect(() => {
    if (previousDefaultExpanded.current === defaultExpanded) return;
    previousDefaultExpanded.current = defaultExpanded;
    setExpanded(defaultExpanded);
  }, [defaultExpanded]);
  const itemCount =
    agentItems.length +
    artifactItems.length +
    pipelineRunItems.length +
    githubRunItems.length +
    backgroundTasks.length;
  const hasItems = itemCount > 0;
  const hasAgentItems = agentItems.length > 0;
  const hasStopAll =
    liveDelegationIds.length > 0 && onStopAllDelegations !== undefined;
  if (!hasItems && !hasStopAll) return null;
  return (
    <section
      className={
        variant === 'active'
          ? '@container mx-auto w-full max-w-[var(--chat-composer-shell-width)] chat-width-transition shrink-0 border-t bg-base px-4 py-2'
          : '@container rounded-lg border bg-fg-primary/[0.02] p-2'
      }
      data-testid={`agent-activity-${variant}`}
    >
      <div className="flex items-center gap-2">
        {hasItems ? (
          <button
            type="button"
            className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} agent activity`}
          >
            {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
            <span className="text-sm font-medium fg-primary">
              Agent activity
            </span>
            <span className="text-xs fg-secondary">
              {itemCount} {itemCount === 1 ? 'item' : 'items'}
            </span>
          </button>
        ) : (
          <span className="min-w-0 flex-1 px-1 py-1 text-sm font-medium fg-primary">
            Agent activity
          </span>
        )}
        {hasAgentItems && onViewSubagentTree ? (
          <SubagentViewTreeAction onClick={onViewSubagentTree} />
        ) : null}
        {onStopAllDelegations ? (
          <StopAllDelegatesControl
            liveDelegationIds={liveDelegationIds}
            onStopAll={onStopAllDelegations}
          />
        ) : null}
      </div>
      {hasItems && expanded ? (
        // The items are conversation content (delegations, their prompts and
        // commands, artifacts, runs): blocked from session replay. The header
        // and its controls stay recorded.
        <div
          className={`${REPLAY_BLOCK_CLASS} mt-2 space-y-2 ${variant === 'active' ? 'max-h-[min(240px,35vh)]' : 'max-h-80'} overflow-y-auto`}
          data-testid="agent-activity-items"
        >
          {agentItems}
          {artifactItems.length > 0 ? (
            <div
              className="grid grid-cols-1 gap-2 @[400px]:grid-cols-2 @[640px]:grid-cols-3 @[880px]:grid-cols-4 @[1120px]:grid-cols-5 @[1360px]:grid-cols-6"
              data-testid="agent-activity-artifact-items"
            >
              {artifactItems}
            </div>
          ) : null}
          {backgroundTasks.length > 0 && backgroundTaskActions ? (
            <div
              className="space-y-2"
              data-testid="agent-activity-background-process-items"
            >
              <BackgroundTasksList
                tasks={backgroundTasks}
                actions={backgroundTaskActions}
              />
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
