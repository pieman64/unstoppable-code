'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  isLiveSubagentStatus,
  subagentAncestors,
  subagentRecipients,
  subagentStatusLabel,
  ThinkingSpinner,
  type SubagentRecipient,
  type SubagentTree,
  type SubagentWorktreeSummaryState,
} from '@canopy/ui-shared';
import {
  Button,
  SUBAGENT_CHAT_LOADING_LABEL,
  SUBAGENT_CHAT_NOT_FOUND_LABEL,
  SUBAGENT_LOAD_OLDER_LABEL,
  SubagentBanner,
  SubagentDetailsGrid,
  type SubagentLineageTarget as SharedSubagentLineageTarget,
} from '@canopy/ui-shared';
import type { SubagentChangeTotals } from '@canopy/ui-shared';
import type {
  SubagentCommandResult,
  SubagentMessageRequest,
  SubagentMessageResult,
  SubagentNativeInterruptResult,
  SubagentLineageTarget,
  SubagentViewerCapabilities,
} from '../types';
import { subagentHasIsolatedChanges } from '../types';
import { SubagentComposer } from './SubagentComposer';
import { useFollowLatest } from './useFollowLatest';

/** Inputs required to render one shared subagent conversation panel. */
export interface SubagentChatPanelProps {
  /** The root chat's subagent tree, or null while the host loads it. */
  readonly tree: SubagentTree | null;
  /** Identity of the selected managed, provider-native, or workflow agent. */
  readonly subagentId: string;
  /** Host-derived capabilities that gate messaging, workflow, and worktree actions. */
  readonly capabilities: SubagentViewerCapabilities;
  /** Host-rendered transcript blocks, including any task/user bubbles. */
  readonly transcript: ReactNode;
  /** Whether older transcript items can be paged into view. */
  readonly hasOlder?: boolean;
  /** True while the host is loading earlier transcript items. */
  readonly loadingOlder?: boolean;
  /** Load older transcript items when the user selects Show earlier messages. */
  readonly onLoadOlder?: () => void;
  /** Whether the root chat's own agent is busy, for the recipient picker. */
  readonly rootChatBusy?: boolean;
  /** Managed delegate run mode displayed in Setup. */
  readonly executionMode?: 'foreground' | 'background';
  /** Optional change totals displayed in the banner facts line. */
  readonly changeTotals?: SubagentChangeTotals;
  /** Isolated worktree summary state, supplied by the host. */
  readonly worktree?: SubagentWorktreeSummaryState;
  /** The host's Cost section body; omit it when the subagent has no Cost section. */
  readonly costDetails?: ReactNode;
  /** Open or focus the root chat, a subagent chat, or a workflow lineage item. */
  readonly onOpenLineage: (target: SubagentLineageTarget) => void;
  /** Notify the host when the banner details are opened or closed. */
  readonly onDetailsExpandedChange?: (expanded: boolean) => void;
  /** Open the host's diff view for the isolated delegate. */
  readonly onShowChanges?: () => void;
  /** Open a workflow run in the host's workflow view. */
  readonly onOpenWorkflow?: (runId: string) => void;
  /** Send a follow-up, steer or interrupt operation to this managed subagent. */
  readonly onMessageSubagent?: (
    request: SubagentMessageRequest,
  ) => Promise<SubagentMessageResult>;
  /** Interrupt a provider-native subagent. */
  readonly onInterruptNative?: () => Promise<SubagentNativeInterruptResult>;
  /** Send to a parent/root recipient and open or focus that recipient's chat. */
  readonly onSendToRecipient?: (
    recipient: SubagentRecipient,
    text: string,
  ) => Promise<SubagentCommandResult>;
  /** Inject a deterministic operation identifier generator in tests. */
  readonly createOperationId?: () => string;
}

function detailsLayout(width: number): 'columns' | 'stacked' {
  return width >= 720 ? 'columns' : 'stacked';
}

/** Share of the panel the open details may cover before they scroll. */
const DETAILS_MAX_HEIGHT_RATIO = 0.5;
const DETAILS_MIN_MAX_HEIGHT = 160;

function detailsMaxHeight(panelHeight: number): number | undefined {
  if (panelHeight <= 0) return undefined;
  return Math.max(
    DETAILS_MIN_MAX_HEIGHT,
    Math.round(panelHeight * DETAILS_MAX_HEIGHT_RATIO),
  );
}

/**
 * Shared, host-agnostic subagent chat: sticky identity banner, transcript,
 * persistent local queue, and a capability-gated composer.
 */
export function SubagentChatPanel({
  tree,
  subagentId,
  capabilities,
  transcript,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  rootChatBusy = false,
  executionMode,
  changeTotals,
  worktree,
  costDetails,
  onOpenLineage,
  onDetailsExpandedChange,
  onShowChanges,
  onOpenWorkflow,
  onMessageSubagent,
  onInterruptNative,
  onSendToRecipient,
  createOperationId,
}: SubagentChatPanelProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState(0);
  const [panelHeight, setPanelHeight] = useState(0);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const node = tree?.nodes.get(subagentId);
  const ancestors = useMemo(
    () => (tree ? [...subagentAncestors(tree, subagentId)].reverse() : []),
    [tree, subagentId],
  );
  const recipients = useMemo(
    () => (tree ? subagentRecipients(tree, subagentId) : []),
    [tree, subagentId],
  );

  useEffect((): (() => void) | void => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries): void => {
      const entry = entries.find((candidate) => candidate.target === panel);
      if (!entry) return;
      setPanelWidth(entry.contentRect.width);
      setPanelHeight(entry.contentRect.height);
    });
    const rect = panel.getBoundingClientRect();
    setPanelWidth(rect.width);
    setPanelHeight(rect.height);
    observer.observe(panel);
    return (): void => observer.disconnect();
  }, []);
  const follow = useFollowLatest();

  if (!tree) {
    return (
      <div
        ref={panelRef}
        data-testid="subagent-chat-panel"
        className="flex min-h-0 flex-1 items-center justify-center"
        role="status"
        aria-busy="true"
      >
        <p className="text-xs fg-secondary">{SUBAGENT_CHAT_LOADING_LABEL}</p>
      </div>
    );
  }
  if (!node) {
    return (
      <div
        ref={panelRef}
        data-testid="subagent-chat-panel"
        className="flex min-h-0 flex-1 items-center justify-center"
        role="status"
      >
        <p className="text-xs fg-secondary">{SUBAGENT_CHAT_NOT_FOUND_LABEL}</p>
      </div>
    );
  }

  const isolatedManaged =
    node.kind === 'managed' &&
    node.workspace === 'isolated' &&
    capabilities.worktreeDetails &&
    worktree !== undefined;
  const workflowDetailsAction =
    capabilities.openWorkflow && onOpenWorkflow ? { onOpenWorkflow } : {};

  return (
    <div
      ref={panelRef}
      data-testid="subagent-chat-panel"
      // Chat keeps plain line breaks (see canopy-tokens-core.css).
      data-chat-window
      data-panel-width={panelWidth}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <SubagentBanner
        tree={tree}
        node={node}
        ancestors={ancestors}
        changeTotals={changeTotals}
        expanded={detailsExpanded}
        onToggle={(): void => {
          const expanded = !detailsExpanded;
          setDetailsExpanded(expanded);
          onDetailsExpandedChange?.(expanded);
        }}
        onOpenLineage={(target: SharedSubagentLineageTarget): void =>
          onOpenLineage(target)
        }
      >
        <SubagentDetailsGrid
          layout={detailsLayout(panelWidth)}
          maxHeight={detailsMaxHeight(panelHeight)}
          tree={tree}
          node={node}
          ancestors={ancestors}
          executionMode={executionMode}
          worktree={isolatedManaged ? worktree : undefined}
          cost={costDetails}
          onOpenLineage={(target: SharedSubagentLineageTarget): void =>
            onOpenLineage(target)
          }
          onShowChanges={
            isolatedManaged && subagentHasIsolatedChanges(node)
              ? onShowChanges
              : undefined
          }
          {...workflowDetailsAction}
        />
      </SubagentBanner>
      <div
        ref={follow.scrollerRef}
        data-testid="subagent-chat-scroll"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {hasOlder && onLoadOlder ? (
          <div className="mx-auto flex max-w-3xl justify-center px-4 pt-3">
            <Button
              size="compact"
              variant="ghost"
              disabled={loadingOlder}
              onClick={onLoadOlder}
              data-testid="subagent-chat-load-older"
            >
              {SUBAGENT_LOAD_OLDER_LABEL}
            </Button>
          </div>
        ) : null}
        <div
          ref={follow.contentRef}
          data-testid="subagent-chat-transcript"
          className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-5"
        >
          {transcript}
          {isLiveSubagentStatus(node.status) ? (
            <div
              role="status"
              data-testid="subagent-chat-working"
              className="flex items-center gap-2 text-xs fg-tertiary"
            >
              <ThinkingSpinner />
              <span className="sr-only">
                {subagentStatusLabel(node.status)}
              </span>
            </div>
          ) : null}
        </div>
      </div>
      <SubagentComposer
        rootChatId={tree.root.id}
        tree={tree}
        node={node}
        capabilities={capabilities}
        recipients={recipients}
        rootChatBusy={rootChatBusy}
        onMessageSubagent={onMessageSubagent}
        onInterruptNative={onInterruptNative}
        onSendToRecipient={onSendToRecipient}
        createOperationId={createOperationId}
      />
    </div>
  );
}
