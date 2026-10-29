import type { JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { AgentAssistantIcon } from '@canopy/ui-shared/icons/AppIcons';
import { useNavigationStore } from '@/stores/navigationStore';

/**
 * Banner shown on an `agent-prompt` step that is running (or ran) as a managed
 * Claude Code terminal worker (pipelines "Terminal" mode). The `workerId` is
 * published at worker launch on the still-`running` step, so the "View worker"
 * jump targets a live card while the step is in flight. If `workerId` is not yet
 * present we render the banner without the jump button rather than targeting an
 * undefined card.
 *
 * Rendered on the shared `Notice` surface; the glyph keeps the operational
 * `fg-info` ink because this is run state, not an intent.
 */
export function TerminalModeBanner({
  agentTerminalMode,
  workerId,
  workerQueued,
  onViewWorker,
}: {
  agentTerminalMode?: boolean;
  workerId?: string;
  workerQueued?: boolean;
  /**
   * Opens the worker. Defaults to the Workers page. Hosts supply their own
   * navigation; opening the worker never closes the detail by itself.
   */
  onViewWorker?: (workerId: string) => void;
}): JSX.Element | null {
  if (!agentTerminalMode) {
    return null;
  }
  return (
    <Notice
      intent="neutral"
      icon={
        <AgentAssistantIcon size={16} aria-hidden="true" className="fg-info" />
      }
      title={workerQueued ? 'Queued' : 'Running in terminal mode'}
      data-testid="pipeline-step-terminal-mode-banner"
      data-worker-queued={workerQueued ? 'true' : 'false'}
      {...(workerId !== undefined
        ? {
            actions: (
              <NoticeButton
                variant="secondary"
                onClick={() => {
                  if (onViewWorker) {
                    onViewWorker(workerId);
                  } else {
                    useNavigationStore.getState().openWorkers(workerId);
                  }
                }}
                data-testid="pipeline-step-view-worker-button"
              >
                View worker
              </NoticeButton>
            ),
          }
        : {})}
    >
      {workerQueued
        ? 'Waiting for an available Claude Code worker slot.'
        : 'This step runs as a managed Claude Code worker.'}
    </Notice>
  );
}
