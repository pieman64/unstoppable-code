'use client';

import { useEffect, useRef, useState, type JSX } from 'react';
import {
  AGENT_ACTIVITY_STOP_ALL_CANCEL_LABEL,
  AGENT_ACTIVITY_STOP_ALL_CONFIRM_LABEL,
  AGENT_ACTIVITY_STOP_ALL_LABEL,
  DELEGATED_AGENT_STOPPING_LABEL,
  ExecutionActionButton,
  agentActivityStopAllPrompt,
  useSubagentsView,
} from '@canopy/ui-shared/components';

export interface StopAllDelegatesControlProps {
  liveDelegationIds: readonly string[];
  onStopAll: () => Promise<boolean>;
  /**
   * The resting action's visible caption. Defaults to `Stop all delegates`;
   * a toolbar short on room passes `Stop all`. The accessible name always
   * says `Stop all delegates`, and the confirm step names the count.
   */
  label?: string;
}

/**
 * Stop all delegates: a header action (Agent activity, the Subagents panel)
 * that asks inline before stopping, since the stop is irreversible and can
 * end several tasks. The confirm step's Stop all carries the destructive
 * chip. Under the Subagents view experiment it rests as a quiet ghost in
 * destructive ink, and Stopping… falls back to neutral ink; otherwise it
 * keeps the classic small destructive action.
 */
export function StopAllDelegatesControl({
  liveDelegationIds,
  onStopAll,
  label = AGENT_ACTIVITY_STOP_ALL_LABEL,
}: StopAllDelegatesControlProps): JSX.Element | null {
  const subagentsView = useSubagentsView();
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  // Delegations the accepted stop covered. They stay listed until they
  // settle; meanwhile the header reads Stopping… instead of offering Stop all
  // for work that is already being stopped.
  const [stoppedIds, setStoppedIds] = useState<ReadonlySet<string> | null>(
    null,
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const focusTargetRef = useRef<string | null>(null);
  const hasLive = liveDelegationIds.length > 0;
  const stoppingOnly =
    stoppedIds !== null && liveDelegationIds.every((id) => stoppedIds.has(id));

  useEffect(() => {
    if (!hasLive) setConfirming(false);
    if (stoppedIds && !liveDelegationIds.some((id) => stoppedIds.has(id))) {
      setStoppedIds(null);
    }
  }, [hasLive, liveDelegationIds, stoppedIds]);

  useEffect(() => {
    const testId = focusTargetRef.current;
    if (!testId) return;
    focusTargetRef.current = null;
    containerRef.current
      ?.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
      ?.focus();
  }, [confirming]);

  if (!hasLive) return null;

  const cancel = (): void => {
    focusTargetRef.current = 'agent-activity-stop-all';
    setConfirming(false);
  };
  const confirm = (): void => {
    if (sending) return;
    const covered = new Set(liveDelegationIds);
    setSending(true);
    // After a failure, focus returns to Stop all so the user can retry.
    const settle = (accepted: boolean): void => {
      if (accepted) setStoppedIds(covered);
      else focusTargetRef.current = 'agent-activity-stop-all';
      setSending(false);
      setConfirming(false);
    };
    onStopAll().then(settle, () => settle(false));
  };

  return (
    <div
      ref={containerRef}
      className="flex shrink-0 items-center gap-2"
      onKeyDown={(event): void => {
        if (confirming && !sending && event.key === 'Escape') {
          event.stopPropagation();
          cancel();
        }
      }}
    >
      {confirming ? (
        <div
          role="group"
          aria-label={agentActivityStopAllPrompt(liveDelegationIds.length)}
          className="flex items-center gap-2"
          data-testid="agent-activity-stop-all-confirmation"
        >
          <span className="text-xs fg-secondary">
            {agentActivityStopAllPrompt(liveDelegationIds.length)}
          </span>
          <ExecutionActionButton
            label={
              sending
                ? DELEGATED_AGENT_STOPPING_LABEL
                : AGENT_ACTIVITY_STOP_ALL_CONFIRM_LABEL
            }
            ariaLabel={
              sending
                ? DELEGATED_AGENT_STOPPING_LABEL
                : AGENT_ACTIVITY_STOP_ALL_CONFIRM_LABEL
            }
            variant="destructive-chip"
            disabled={sending}
            dataTestId="agent-activity-stop-all-confirm"
            stopKeyDownPropagation={false}
            onClick={confirm}
          />
          <ExecutionActionButton
            label={AGENT_ACTIVITY_STOP_ALL_CANCEL_LABEL}
            ariaLabel={AGENT_ACTIVITY_STOP_ALL_CANCEL_LABEL}
            disabled={sending}
            dataTestId="agent-activity-stop-all-cancel"
            stopKeyDownPropagation={false}
            onClick={cancel}
          />
        </div>
      ) : (
        <ExecutionActionButton
          label={stoppingOnly ? DELEGATED_AGENT_STOPPING_LABEL : label}
          ariaLabel={
            stoppingOnly
              ? DELEGATED_AGENT_STOPPING_LABEL
              : AGENT_ACTIVITY_STOP_ALL_LABEL
          }
          variant={
            !subagentsView
              ? 'destructive'
              : stoppingOnly
                ? 'ghost'
                : 'ghost-destructive'
          }
          disabled={stoppingOnly}
          dataTestId="agent-activity-stop-all"
          onClick={(): void => {
            focusTargetRef.current = 'agent-activity-stop-all-cancel';
            setConfirming(true);
          }}
        />
      )}
    </div>
  );
}
