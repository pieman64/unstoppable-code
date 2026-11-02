import {
  memo,
  useCallback,
  useEffect,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  AgentDelegationSnapshot,
  DelegationWorkspaceChanges,
} from '@canopy/protocol/delegation';
import { visibleDelegationPrompt } from '../../lib/delegation-display';
import { AgentBlockCard } from './AgentBlockCard';
import { DelegatedAgentCapabilities } from './DelegatedAgentCapabilities';
import { AgentCardOpenChatAction } from './AgentCardOpenChatAction';
import {
  DELEGATED_AGENT_CHANGES_FAILED_LABEL,
  DELEGATED_AGENT_CHANGES_RETRY_LABEL,
  DELEGATED_AGENT_DIFF_SHORTENED_LABEL,
  DELEGATED_AGENT_LOADING_CHANGES_LABEL,
  DELEGATED_AGENT_NO_CHANGES_LABEL,
  DELEGATED_AGENT_NO_DIFF_LABEL,
  DELEGATED_AGENT_QUEUED_LABEL,
  DELEGATED_AGENT_REFRESH_CHANGES_LABEL,
  DELEGATED_AGENT_SHOW_CHANGES_LABEL,
  DELEGATED_AGENT_STOP_ACCESSIBLE_LABEL,
  DELEGATED_AGENT_STOP_WITH_DESCENDANTS_LABEL,
  delegatedAgentChangesShownLabel,
  delegatedAgentQueueDetail,
  delegatedAgentStatusLabel,
  hasDelegatedAgentCapabilityEntries,
} from './delegated-agent-copy';
import { TaskStopButton } from './TaskStopButton';
import { ThinkingSpinner } from '../ThinkingSpinner';

/** Header status while the delegate's request waits in its parent's queue. */
export const DELEGATED_AGENT_WAITING_ON_PARENT_LABEL = 'Waiting for the parent';

const DELEGATION_METADATA_CLASSNAME =
  'space-y-2 px-2.5 py-2 text-3xs inset-ring-[length:var(--border-hairline)] inset-ring-line-base';

export interface DelegatedAgentCardProps {
  snapshot: AgentDelegationSnapshot;
  parentHarnessId: string;
  description: string;
  prompt: string;
  executionMode: 'foreground' | 'background';
  children?: ReactNode;
  onCopyNativeSessionId?: (id: string) => void;
  /** Opens this managed subagent's chat from its expanded details. */
  onOpenChat?: () => void;
  /**
   * Stops this delegation and the tasks it started. Resolves `true` once the
   * host accepted the stop, keeping the control in its working state until
   * the row settles; `false` or a rejection re-enables it (the host reports
   * the failure). Hosts that cannot stop a delegation omit it.
   */
  onStop?: () => Promise<boolean>;
  /** Whether tasks this delegation started are still queued or running. */
  hasLiveDescendants?: boolean;
  /**
   * Reads an isolated delegate's changes from its retained worktree. Hosts
   * that cannot read the worktree omit it.
   */
  onLoadChanges?: () => Promise<DelegationWorkspaceChanges>;
  /**
   * The host reports that this delegate's request to its parent is queued
   * and not yet claimed. A live card shows one status line; the request
   * itself is never rendered. Hosts without a delegation queue omit it.
   */
  waitingOnParent?: boolean;
}

type ChangesState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly changes: DelegationWorkspaceChanges }
  | { readonly kind: 'failed' };

/** An isolated delegate's changes, read from Git only when asked for. */
function DelegatedAgentChanges({
  load,
}: {
  load: () => Promise<DelegationWorkspaceChanges>;
}): JSX.Element {
  const [state, setState] = useState<ChangesState>({ kind: 'idle' });
  const read = useCallback((): void => {
    setState({ kind: 'loading' });
    load().then(
      (changes) => setState({ kind: 'loaded', changes }),
      () => setState({ kind: 'failed' }),
    );
  }, [load]);
  if (state.kind === 'loading')
    return (
      <p role="status" className="fg-secondary">
        {DELEGATED_AGENT_LOADING_CHANGES_LABEL}
      </p>
    );
  if (state.kind !== 'loaded')
    return (
      <div className="space-y-1">
        {state.kind === 'failed' && (
          <p className="fg-destructive">
            {DELEGATED_AGENT_CHANGES_FAILED_LABEL}
          </p>
        )}
        <button
          type="button"
          className="fg-secondary underline"
          data-testid="delegated-agent-show-changes"
          onClick={read}
        >
          {state.kind === 'failed'
            ? DELEGATED_AGENT_CHANGES_RETRY_LABEL
            : DELEGATED_AGENT_SHOW_CHANGES_LABEL}
        </button>
      </div>
    );
  const { files, omittedFiles } = state.changes;
  return (
    <div
      data-testid="delegated-agent-changes"
      className="space-y-1 fg-secondary"
    >
      {files.length ? null : <p>{DELEGATED_AGENT_NO_CHANGES_LABEL}</p>}
      {files.map((file) => (
        <details key={file.path} data-testid="delegated-change">
          <summary>
            {file.path} · {file.change}
          </summary>
          {file.diff ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap">
              {file.diff}
            </pre>
          ) : (
            <p>{DELEGATED_AGENT_NO_DIFF_LABEL}</p>
          )}
          {file.diffTruncated && <p>{DELEGATED_AGENT_DIFF_SHORTENED_LABEL}</p>}
        </details>
      ))}
      {omittedFiles ? (
        <p>{delegatedAgentChangesShownLabel(files.length)}</p>
      ) : null}
      <button type="button" className="underline" onClick={read}>
        {DELEGATED_AGENT_REFRESH_CHANGES_LABEL}
      </button>
    </div>
  );
}

export function delegatedAgentRouteMetadata(
  snapshot: AgentDelegationSnapshot,
): {
  selected: string;
  selectedId?: string;
  runtime: string;
  runtimeId?: string;
} {
  const route = snapshot.routeSnapshot;
  return {
    selected:
      route?.selectedModelLabel ??
      route?.selectedModelId ??
      snapshot.requestedModelId ??
      'Preparing model',
    ...(route?.selectedModelId ? { selectedId: route.selectedModelId } : {}),
    runtime: route?.runtimeModelLabel ?? route?.runtimeModelId ?? 'Preparing',
    ...(route?.runtimeModelId ? { runtimeId: route.runtimeModelId } : {}),
  };
}

/** Shared desktop and Portal presentation; native actions are explicitly supplied by the host. */
export const DelegatedAgentCard = memo(function DelegatedAgentCard({
  snapshot,
  parentHarnessId,
  description,
  prompt,
  executionMode,
  children,
  onCopyNativeSessionId,
  onOpenChat,
  onStop,
  hasLiveDescendants = false,
  onLoadChanges,
  waitingOnParent = false,
}: DelegatedAgentCardProps): JSX.Element {
  const route = snapshot.routeSnapshot;
  const live = snapshot.status === 'pending' || snapshot.status === 'running';
  const queued = snapshot.status === 'pending' && snapshot.phase === 'queued';
  const running = !queued && live;
  const [stopSent, setStopSent] = useState(false);
  // A settled row drops the control; a later follow-up run starts fresh.
  useEffect(() => {
    if (!live) setStopSent(false);
  }, [live]);
  const stopping = stopSent || snapshot.stopRequested?.status === 'accepted';
  const handleStop = useCallback((): void => {
    if (!onStop || stopping) return;
    setStopSent(true);
    onStop().then(
      (accepted) => {
        if (!accepted) setStopSent(false);
      },
      () => setStopSent(false),
    );
  }, [onStop, stopping]);
  const statusLabel = delegatedAgentStatusLabel(snapshot);
  const capabilities = snapshot.capabilities;
  const queueDetail = delegatedAgentQueueDetail(snapshot.queue);
  const { selected, selectedId, runtime, runtimeId } =
    delegatedAgentRouteMetadata(snapshot);
  const sameModel = selected === runtime && selectedId === runtimeId;
  // A direct child of this chat gains nothing from "Depth 1 · Parent: This
  // chat"; lineage is shown only for nested delegates.
  const nested =
    snapshot.parentDelegationId !== undefined || (snapshot.depth ?? 1) > 1;
  const sameThinking =
    route?.requestedThinkingLevel !== undefined &&
    route.requestedThinkingLevel === route.effectiveThinkingLevel;
  return (
    <section
      data-testid="chat-delegated-agent"
      data-delegation-id={snapshot.delegationId}
    >
      <AgentBlockCard
        dataTestId="agent-block-shared"
        subagentType={`${selected} · ${route?.harnessId ?? 'Preparing'}`}
        description={description || 'Delegated task'}
        prompt={visibleDelegationPrompt(prompt)}
        result={snapshot.finalText}
        runInBackground={executionMode === 'background'}
        isRunning={running}
        pendingSpinner={<ThinkingSpinner />}
        isError={
          snapshot.status === 'failed' ||
          snapshot.status === 'deadline_exceeded'
        }
        expandLabel="Expand delegated task"
        collapseLabel="Collapse delegated task"
        headerStatus={
          nested ? (
            <span
              data-testid="delegated-agent-lineage"
              className="min-w-0 truncate fg-secondary"
              title={
                snapshot.parentDelegationId
                  ? `Parent: ${snapshot.parentDescription ?? snapshot.parentDelegationId}`
                  : 'Parent: This chat'
              }
            >
              {`Depth ${snapshot.depth ?? 1} · Parent: ${snapshot.parentDescription ?? snapshot.parentDelegationId ?? 'This chat'}`}
            </span>
          ) : undefined
        }
        headerTrailing={
          snapshot.approvalPending ? (
            <span role="status" className="ml-auto shrink-0 fg-secondary">
              Awaiting approval
            </span>
          ) : waitingOnParent && live ? (
            <span
              data-testid="delegated-agent-waiting-on-parent"
              role="status"
              className="ml-auto shrink-0 fg-secondary"
            >
              {DELEGATED_AGENT_WAITING_ON_PARENT_LABEL}
            </span>
          ) : queued ? (
            <span
              data-testid="delegated-agent-queue-status"
              role="status"
              className="ml-auto shrink-0 fg-secondary"
            >
              {DELEGATED_AGENT_QUEUED_LABEL}
              {queueDetail ? (
                <span className="fg-tertiary"> · {queueDetail}</span>
              ) : null}
            </span>
          ) : !live && statusLabel ? (
            <span
              data-testid="delegated-agent-status"
              className="ml-auto shrink-0 fg-secondary"
            >
              {statusLabel}
            </span>
          ) : undefined
        }
        headerAction={
          onStop && live ? (
            <TaskStopButton
              stopping={stopping}
              onStop={handleStop}
              accessibleLabel={DELEGATED_AGENT_STOP_ACCESSIBLE_LABEL}
              title={
                hasLiveDescendants
                  ? DELEGATED_AGENT_STOP_WITH_DESCENDANTS_LABEL
                  : DELEGATED_AGENT_STOP_ACCESSIBLE_LABEL
              }
              dataTestId="delegated-agent-stop"
            />
          ) : undefined
        }
        metadata={
          <div
            data-testid="delegated-agent-metadata"
            className={DELEGATION_METADATA_CLASSNAME}
          >
            {onOpenChat ? (
              <AgentCardOpenChatAction onOpenChat={onOpenChat} />
            ) : null}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 fg-secondary">
              <dt>Model</dt>
              <dd>
                {selected} {selectedId ? <span>({selectedId})</span> : null}
              </dd>
              {!sameModel && (
                <>
                  <dt>Runtime model</dt>
                  <dd>
                    {runtime} {runtimeId ? <span>({runtimeId})</span> : null}
                  </dd>
                </>
              )}
              <dt>Harness</dt>
              <dd>
                {parentHarnessId} → {route?.harnessId ?? 'Preparing'}
              </dd>
              <dt>Execution</dt>
              <dd>{executionMode}</dd>
              {snapshot.resultIndex !== undefined && (
                <>
                  <dt>Result</dt>
                  <dd>{`Result ${snapshot.resultIndex}`}</dd>
                </>
              )}
              <dt>Workspace</dt>
              <dd>
                {snapshot.isolatedWorkspace
                  ? snapshot.workspaceDiscarded
                    ? 'Isolated · discarded'
                    : 'Isolated · retained'
                  : 'Shared with parent'}
              </dd>
              <dt>Permissions</dt>
              <dd>
                {snapshot.permissions?.writePaths.length
                  ? `Read/search and edits within: ${snapshot.permissions.writePaths.join(', ')}. Parent approvals apply.`
                  : 'Read and search'}
              </dd>
              {hasDelegatedAgentCapabilityEntries(capabilities) ? (
                <DelegatedAgentCapabilities summary={capabilities} />
              ) : null}
              {snapshot.control && (
                <>
                  <dt>Command</dt>
                  <dd>
                    {snapshot.control.operation.replace('_', ' ')} ·{' '}
                    {snapshot.control.status}
                    {snapshot.control.error
                      ? `: ${snapshot.control.error}`
                      : ''}
                  </dd>
                </>
              )}
              {!sameThinking && route?.requestedThinkingLevel && (
                <>
                  <dt>Requested thinking</dt>
                  <dd>{route?.requestedThinkingLevel}</dd>
                </>
              )}
              <dt>{sameThinking ? 'Thinking' : 'Effective thinking'}</dt>
              <dd>{route?.effectiveThinkingLevel ?? 'Not reported'}</dd>
              {snapshot.usage && (
                <>
                  <dt>Usage</dt>
                  <dd>
                    {snapshot.usage.inputTokens ?? 0} input ·{' '}
                    {snapshot.usage.outputTokens ?? 0} output
                    {snapshot.usage.costUsd !== undefined
                      ? ` · $${snapshot.usage.costUsd.toFixed(4)}`
                      : ''}
                  </dd>
                </>
              )}
            </dl>
            {snapshot.isolatedWorkspace &&
              !snapshot.workspaceDiscarded &&
              onLoadChanges && <DelegatedAgentChanges load={onLoadChanges} />}
            {snapshot.nativeSessionId && onCopyNativeSessionId && (
              <button
                type="button"
                className="fg-secondary underline"
                onClick={() => {
                  if (snapshot.nativeSessionId)
                    onCopyNativeSessionId(snapshot.nativeSessionId);
                }}
              >
                Copy native session ID
              </button>
            )}
            {snapshot.error && (
              <p className="fg-destructive">{snapshot.error.message}</p>
            )}
          </div>
        }
        subBlocks={children}
      />
    </section>
  );
});
