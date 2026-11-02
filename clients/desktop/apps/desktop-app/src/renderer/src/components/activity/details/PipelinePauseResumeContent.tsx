import { RetryCountdown } from '@canopy/ui-shared';
import { useState, type JSX } from 'react';
import type {
  ExecutionState,
  PipelineStatusReason,
} from '@canopy/desktop-shared/types/pipeline';
import { ScheduleIcon } from '@canopy/ui-shared/icons';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { groupPipelineStatusReasons } from '@/lib/pipelineStatusReasons';
import {
  selectPipelineUsageLimitResumeAt,
  selectProviderUsageLimitResumeAt,
} from '@/lib/claudeUsageLimitResume';
import { PauseInputPanel } from '../PauseInputPanel';

interface StatusReasonPanelProps {
  executionId: string;
  reasons: ExecutionState['status_reasons'];
  pipelineName: string;
  executionStatus: ExecutionState['status'];
  transientRetry?: ExecutionState['transient_retry'];
}

function StatusReasonPanel({
  executionId,
  reasons,
  pipelineName,
  executionStatus,
  transientRetry,
}: StatusReasonPanelProps): JSX.Element | null {
  const resumeExecution = usePipelineRunsStore((s) => s.resumeExecution);
  const activities = useAutomationsStore((s) => s.activities);
  const createActivity = useAutomationsStore((s) => s.createActivity);
  const refreshProviderUsageSnapshot = useObservabilityStore(
    (s) => s.refreshProviderUsageSnapshot,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scheduleBusy, setScheduleBusy] = useState<'claude' | 'codex' | null>(
    null,
  );
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const activeReasons = reasons ?? [];
  const presentationReasons: PipelineStatusReason[] =
    activeReasons.length > 0
      ? activeReasons
      : [
          {
            id: 'legacy-action-pause',
            kind: 'action_paused',
            code: 'action_requested_pause',
            detected_at: new Date(0).toISOString(),
            source: {
              job_id: 'pipeline',
              step_id: 'action',
              attempt: 0,
              iteration: 0,
            },
          },
        ];

  const handleResume = async (): Promise<void> => {
    if (busy) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const reasonIds = activeReasons
        .filter(
          (reason) =>
            reason.kind !== 'input_required' && reason.kind !== 'action_paused',
        )
        .map((reason) => reason.id);
      const result = await resumeExecution(
        executionId,
        reasonIds.length > 0 ? { statusReasonIds: reasonIds } : {},
      );
      if (!result.success) {
        setError(result.error ?? 'Couldn’t resume this run.');
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Couldn’t resume this run.',
      );
    } finally {
      setBusy(false);
    }
  };
  const groups = groupPipelineStatusReasons(
    presentationReasons.filter(
      (reason) =>
        reason.kind !== 'input_required' && reason.kind !== 'action_paused',
    ),
  );
  if (groups.length === 0) return null;
  const usageProviders = Array.from(
    new Set(
      activeReasons
        .filter(
          (
            reason,
          ): reason is typeof reason & { provider: 'claude' | 'codex' } =>
            reason.kind === 'provider_usage_limit' &&
            (reason.provider === 'claude' || reason.provider === 'codex'),
        )
        .map((reason) => reason.provider),
    ),
  );
  const scheduleProvider = async (
    provider: 'claude' | 'codex',
  ): Promise<void> => {
    const providerReasons = activeReasons.filter(
      (reason) =>
        reason.kind === 'provider_usage_limit' && reason.provider === provider,
    );
    const reasonIds = providerReasons.map((reason) => reason.id).sort();
    if (reasonIds.length === 0) return;
    setScheduleBusy(provider);
    setScheduleError(null);
    try {
      const now = Date.now();
      const needsNativeProviderFallback = providerReasons.some((reason) => {
        const resetMs = reason.resets_at
          ? Date.parse(reason.resets_at)
          : Number.NaN;
        return (
          reason.account_scope === 'native' &&
          (!Number.isFinite(resetMs) || resetMs <= now)
        );
      });
      let nativeProviderFallback: string | null = null;
      if (needsNativeProviderFallback) {
        const snapshot = await refreshProviderUsageSnapshot(provider);
        nativeProviderFallback = selectProviderUsageLimitResumeAt(
          snapshot,
          provider,
          new Date(now),
        );
      }
      const runAt = selectPipelineUsageLimitResumeAt(
        providerReasons,
        nativeProviderFallback,
        new Date(now),
      );
      if (!runAt) {
        setScheduleError(
          'A future usage reset time is not available. Resume manually after switching accounts or when usage resets.',
        );
        return;
      }
      const providerName = provider === 'claude' ? 'Claude' : 'Codex';
      const response = await createActivity({
        name: `Resume workflow after ${providerName} usage reset`,
        schedule: { kind: 'one_time', runAt, timezone: 'local' },
        action: {
          type: 'pipeline_execution_resume',
          executionId,
          statusReasonIds: reasonIds,
          provider,
          purpose: 'usage_limit_resume',
          pipelineName,
        },
      });
      if (!response.ok) {
        setScheduleError(response.error ?? 'Couldn’t schedule this resume.');
      }
    } catch {
      setScheduleError('Couldn’t schedule this resume.');
    } finally {
      setScheduleBusy(null);
    }
  };
  const scheduledProviders = new Set(
    activities
      .filter((activity) => {
        const action = activity.action;
        if (
          !activity.enabled ||
          action.type !== 'pipeline_execution_resume' ||
          action.executionId !== executionId ||
          !activity.nextRunAt ||
          Date.parse(activity.nextRunAt) <= Date.now()
        ) {
          return false;
        }
        const currentIds = activeReasons
          .filter(
            (reason) =>
              reason.kind === 'provider_usage_limit' &&
              reason.provider === action.provider,
          )
          .map((reason) => reason.id)
          .sort();
        return (
          currentIds.length === action.statusReasonIds.length &&
          currentIds.every(
            (id, index) => id === [...action.statusReasonIds].sort()[index],
          )
        );
      })
      .map((activity) => {
        const action = activity.action;
        return action.type === 'pipeline_execution_resume'
          ? action.provider
          : null;
      })
      .filter((provider): provider is 'claude' | 'codex' => provider !== null),
  );

  // Scheduling a resume is the alternative; resuming now is the one
  // recommended action, so it renders as the primary button and sits last.
  const actionCount = usageProviders.length + 1;

  return (
    <Notice
      intent="attention"
      className="mb-4"
      title={executionStatus === 'running' ? 'Steps paused' : 'Run paused'}
      actionsPlacement={actionCount >= 3 ? 'below' : 'trailing'}
      actions={
        <>
          {usageProviders.map((provider) => {
            const scheduled = scheduledProviders.has(provider);
            const providerName = provider === 'claude' ? 'Claude' : 'Codex';
            const multiple = usageProviders.length > 1;
            return (
              <NoticeButton
                key={provider}
                variant="secondary"
                data-testid={`pipeline-recovery-schedule-${provider}`}
                disabled={scheduleBusy !== null || scheduled}
                onClick={() => void scheduleProvider(provider)}
              >
                <ScheduleIcon
                  width={14}
                  height={14}
                  aria-hidden="true"
                  className="shrink-0"
                />
                {scheduled
                  ? 'Resume scheduled'
                  : scheduleBusy === provider
                    ? 'Scheduling…'
                    : multiple
                      ? `Schedule ${providerName} resume`
                      : 'Schedule resume'}
              </NoticeButton>
            );
          })}
          <NoticeButton
            variant="primary"
            data-testid="pause-formless-resume"
            disabled={busy}
            onClick={() => void handleResume()}
          >
            {busy ? 'Resuming…' : 'Resume run'}
          </NoticeButton>
        </>
      }
    >
      {/* One flowing line after the title (design owner, 2026-09-17): each
          paused group is a sentence or two, not a stacked block. */}
      {transientRetry ? (
        <span role="status" data-testid="pipeline-transient-retry-status">
          <RetryCountdown {...transientRetry} />{' '}
        </span>
      ) : null}
      {groups.map((group) => (
        <span key={group.key}>
          {group.heading} {group.helper}
          {group.reasons.length > 1
            ? ` ${String(group.reasons.length)} paused steps need attention.`
            : ''}{' '}
        </span>
      ))}
      {error ? <span className="fg-destructive">{error} </span> : null}
      {scheduleError ? (
        <span className="fg-destructive">{scheduleError}</span>
      ) : null}
    </Notice>
  );
}

function hasResumableStatusReasons(state: ExecutionState): boolean {
  return Boolean(
    state.status_reasons?.some(
      (reason) =>
        reason.kind !== 'input_required' && reason.kind !== 'action_paused',
    ),
  );
}

/**
 * Pause questions and the run-level paused notice for one live execution.
 * Renders nothing for archived or running-without-pauses executions. Child
 * executions show pending input but never the run-level resume notice.
 */
export function PipelinePauseResumeContent({
  executionId,
  state,
  idScope,
}: {
  executionId: string;
  state: ExecutionState;
  /** Scopes pause-input DOM ids to one detail instance. */
  idScope: string;
}): JSX.Element | null {
  const hasPendingPauses = state.pending_pauses.length > 0;
  if (
    state.status !== 'paused' &&
    !hasPendingPauses &&
    !hasResumableStatusReasons(state)
  ) {
    return null;
  }
  return (
    <>
      {hasPendingPauses ? (
        <PauseInputPanel
          key={executionId}
          executionId={executionId}
          state={state}
          idScope={idScope}
        />
      ) : null}
      {state.parent_execution_id ? null : (
        <StatusReasonPanel
          executionId={executionId}
          reasons={state.status_reasons}
          pipelineName={state.pipeline_snapshot.name}
          executionStatus={state.status}
          transientRetry={state.transient_retry}
        />
      )}
    </>
  );
}
