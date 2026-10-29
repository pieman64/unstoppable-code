import { useEffect, useState, type JSX } from 'react';
import type { DelegationWorkspaceChanges } from '@canopy/protocol/delegation';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  Button,
  DialogModal,
  DELEGATED_AGENT_CHANGES_FAILED_LABEL,
  DELEGATED_AGENT_CHANGES_RETRY_LABEL,
  DELEGATED_AGENT_DIFF_SHORTENED_LABEL,
  DELEGATED_AGENT_LOADING_CHANGES_LABEL,
  DELEGATED_AGENT_NO_CHANGES_LABEL,
  DELEGATED_AGENT_NO_DIFF_LABEL,
  DELEGATED_AGENT_REFRESH_CHANGES_LABEL,
  delegatedAgentChangesShownLabel,
} from '@canopy/ui-shared/components';
import type { SubagentHostScope } from './subagent-scope';

export interface SubagentChangesTarget {
  readonly scope: SubagentHostScope;
  readonly delegationId: string;
  readonly revision: string;
  readonly title: string;
}

export interface SubagentChangesDialogProps {
  readonly target: SubagentChangesTarget | null;
  readonly onClose: () => void;
}

type ChangesState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly changes: DelegationWorkspaceChanges };

function ChangedFiles({
  changes,
  onRefresh,
}: {
  readonly changes: DelegationWorkspaceChanges;
  readonly onRefresh: () => void;
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-col gap-3 px-5 py-4">
      {changes.files.length === 0 ? (
        <p className="text-sm fg-secondary">
          {DELEGATED_AGENT_NO_CHANGES_LABEL}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {changes.files.map((file) => (
            <details
              key={file.path}
              data-testid="subagent-changed-file"
              className="min-w-0 rounded-md border px-3 py-2"
            >
              <summary className="cursor-pointer break-words text-sm fg-primary">
                <span className="font-mono">{file.path}</span>
                <span className="fg-tertiary"> · {file.change}</span>
              </summary>
              {file.diff ? (
                <pre
                  className={`${POSTHOG_REPLAY_BLOCK_CLASS} mt-2 max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-secondary p-3 font-mono text-xs fg-secondary`}
                >
                  {file.diff}
                </pre>
              ) : (
                <p className="mt-2 text-xs fg-secondary">
                  {DELEGATED_AGENT_NO_DIFF_LABEL}
                </p>
              )}
              {file.diffTruncated ? (
                <p className="mt-2 text-xs fg-tertiary">
                  {DELEGATED_AGENT_DIFF_SHORTENED_LABEL}
                </p>
              ) : null}
            </details>
          ))}
        </div>
      )}
      {changes.omittedFiles ? (
        <p className="text-xs fg-tertiary">
          {delegatedAgentChangesShownLabel(changes.files.length)}
        </p>
      ) : null}
      <div>
        <Button size="control" variant="secondary" onClick={onRefresh}>
          {DELEGATED_AGENT_REFRESH_CHANGES_LABEL}
        </Button>
      </div>
    </div>
  );
}

/** Shows the bounded diff list for an isolated managed delegate. */
export function SubagentChangesDialog({
  target,
  onClose,
}: SubagentChangesDialogProps): JSX.Element | null {
  const [state, setState] = useState<ChangesState>({ status: 'loading' });
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!target) return undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    void window.api.managedDelegation
      .changes({
        projectId: target.scope.projectId,
        worktreeId: target.scope.worktreeId,
        delegationId: target.delegationId,
        revision: target.revision,
      })
      .then((result): void => {
        if (cancelled) return;
        setState(
          result.ok
            ? { status: 'ready', changes: result.changes }
            : { status: 'failed' },
        );
      })
      .catch((): void => {
        if (!cancelled) setState({ status: 'failed' });
      });
    return (): void => {
      cancelled = true;
    };
  }, [retryCount, target]);

  if (!target) return null;

  const retry = (): void => setRetryCount((count) => count + 1);
  return (
    <DialogModal
      title={`Changes from ${target.title}`}
      onClose={onClose}
      maxWidth="4xl"
      dataTestId="subagent-changes-dialog"
    >
      {state.status === 'loading' ? (
        <p className="px-5 py-4 text-sm fg-secondary" role="status">
          {DELEGATED_AGENT_LOADING_CHANGES_LABEL}
        </p>
      ) : state.status === 'failed' ? (
        <div className="flex flex-col items-start gap-3 px-5 py-4" role="alert">
          <p className="text-sm fg-destructive">
            {DELEGATED_AGENT_CHANGES_FAILED_LABEL}
          </p>
          <Button size="control" variant="secondary" onClick={retry}>
            {DELEGATED_AGENT_CHANGES_RETRY_LABEL}
          </Button>
        </div>
      ) : (
        <ChangedFiles changes={state.changes} onRefresh={retry} />
      )}
    </DialogModal>
  );
}
