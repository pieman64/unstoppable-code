import { useEffect, useState } from 'react';
import { extractIpcErrorMessage } from '@/lib/errors';

const WORKFLOW_AGENT_TRANSCRIPT_POLL_INTERVAL_MS = 2_000;

interface WorkflowAgentTranscriptState {
  readonly identity: string | null;
  readonly lines: readonly string[];
  readonly truncated: boolean;
  readonly initialPrompt?: string;
  readonly loading: boolean;
  readonly error: string | null;
}

export interface WorkflowAgentTranscriptResult {
  readonly lines: readonly string[];
  readonly truncated: boolean;
  readonly initialPrompt?: string;
  readonly loading: boolean;
  readonly error: string | null;
}

export interface UseWorkflowAgentTranscriptOptions {
  readonly transcriptDir: string | undefined;
  readonly agentId: string;
  readonly live: boolean;
  readonly enabled: boolean;
}

const EMPTY_STATE: WorkflowAgentTranscriptState = {
  identity: null,
  lines: [],
  truncated: false,
  loading: false,
  error: null,
};

function sameResponse(
  state: WorkflowAgentTranscriptState,
  lines: readonly string[],
  truncated: boolean,
  initialPrompt: string | undefined,
): boolean {
  return (
    state.lines.length === lines.length &&
    state.lines[state.lines.length - 1] === lines[lines.length - 1] &&
    state.truncated === truncated &&
    state.initialPrompt === initialPrompt
  );
}

/** Reads a workflow agent transcript, polling only while its agent is live. */
export function useWorkflowAgentTranscript({
  transcriptDir,
  agentId,
  live,
  enabled,
}: UseWorkflowAgentTranscriptOptions): WorkflowAgentTranscriptResult {
  const identity =
    enabled && transcriptDir && agentId.length > 0
      ? `${transcriptDir}\0${agentId}`
      : null;
  const [state, setState] = useState<WorkflowAgentTranscriptState>(EMPTY_STATE);

  useEffect((): (() => void) | void => {
    if (!identity || !transcriptDir || !agentId) {
      setState((current) =>
        current.identity === null && !current.loading ? current : EMPTY_STATE,
      );
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState((current) =>
      current.identity === identity
        ? current
        : { ...EMPTY_STATE, identity, loading: true },
    );

    const readTranscript = async (): Promise<void> => {
      try {
        const response = await window.api.activity.readWorkflowAgentTranscript({
          transcriptDir,
          agentId,
        });
        if (cancelled) return;
        const truncated = response.truncated === true;
        setState((current) => {
          if (
            current.identity === identity &&
            !current.loading &&
            current.error === null &&
            sameResponse(
              current,
              response.lines,
              truncated,
              response.initialPrompt,
            )
          ) {
            return current;
          }
          return {
            identity,
            lines: response.lines,
            truncated,
            ...(response.initialPrompt !== undefined
              ? { initialPrompt: response.initialPrompt }
              : {}),
            loading: false,
            error: null,
          };
        });
      } catch (error: unknown) {
        if (!cancelled) {
          const message = extractIpcErrorMessage(error);
          setState((current) =>
            current.identity === identity &&
            !current.loading &&
            current.error === message
              ? current
              : {
                  ...EMPTY_STATE,
                  identity,
                  loading: false,
                  error: message,
                },
          );
        }
      }

      if (live && !cancelled) {
        timer = setTimeout(
          () => void readTranscript(),
          WORKFLOW_AGENT_TRANSCRIPT_POLL_INTERVAL_MS,
        );
      }
    };

    void readTranscript();
    return (): void => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [agentId, identity, live, transcriptDir]);

  if (identity === null) return EMPTY_STATE;
  if (state.identity !== identity) {
    return {
      lines: [],
      truncated: false,
      loading: true,
      error: null,
    };
  }
  return {
    lines: state.lines,
    truncated: state.truncated,
    ...(state.initialPrompt !== undefined
      ? { initialPrompt: state.initialPrompt }
      : {}),
    loading: state.loading,
    error: state.error,
  };
}
