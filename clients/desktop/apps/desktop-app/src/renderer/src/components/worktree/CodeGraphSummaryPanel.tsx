import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import type {
  CodeGraphIpcError,
  CodeGraphUiSummary,
  CodeGraphUiSummaryResponse,
} from '@canopy/desktop-shared/types';
import {
  CODE_GRAPH_SUMMARY_BUSY_MESSAGE,
  CODE_GRAPH_SUMMARY_PENDING_MESSAGE,
  CODE_GRAPH_SUMMARY_READ_FAILURE_MESSAGE,
  CodeGraphSummaryView,
} from '@canopy/ui-shared/components';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';

const FALLBACK_LOAD_ERROR = 'Could not load the Code Graph summary.';
const FALLBACK_BUILD_ERROR = 'Could not generate the Code Graph. Try again.';

/**
 * Browser-safe readiness reported to App Advisor. Values are closed unions
 * from the summary contract; never counts, messages, or paths.
 */
interface CodeGraphReadiness {
  snapshotState?: CodeGraphUiSummary['snapshotState'];
  buildState?: CodeGraphUiSummary['buildState'];
  readFailure?: CodeGraphIpcError['readFailure'];
}

function readinessOf(value: CodeGraphReadiness): CodeGraphReadiness {
  return {
    ...(value.snapshotState ? { snapshotState: value.snapshotState } : {}),
    ...(value.buildState ? { buildState: value.buildState } : {}),
    ...(value.readFailure ? { readFailure: value.readFailure } : {}),
  };
}

/**
 * Safe copy for a failed read. Structured readiness takes precedence over the
 * envelope message so a classified failure never surfaces backend detail.
 */
function loadFailureMessage(response: CodeGraphIpcError): string {
  if (response.snapshotState === 'summary-pending') {
    return CODE_GRAPH_SUMMARY_PENDING_MESSAGE;
  }
  switch (response.readFailure) {
    case 'busy':
    case 'queue-timeout':
    case 'execution-timeout':
      return CODE_GRAPH_SUMMARY_BUSY_MESSAGE;
    case 'worker-exit':
    case 'canceled':
    case 'invalid-response':
    case 'database-error':
      return CODE_GRAPH_SUMMARY_READ_FAILURE_MESSAGE;
    default:
      return response.message || FALLBACK_LOAD_ERROR;
  }
}

interface CodeGraphSummaryPanelProps {
  /** Loads the current summary for this scope (worktree or workspace shadow). */
  load: () => Promise<CodeGraphUiSummaryResponse>;
  /** Triggers a build/refresh; resolves with the refreshed summary. */
  build: () => Promise<CodeGraphUiSummaryResponse>;
  /**
   * Opens Settings → Code Graph. The host is responsible for closing its own
   * modal/dialog first so the settings overlay is visible.
   */
  onOpenSettings: () => void;
  /**
   * External "already building" signal (e.g. the worktree build-status store)
   * so the panel reflects a build started elsewhere and refreshes when it ends.
   */
  externalBuilding?: boolean;
  /** Bump to force a reload (e.g. when the host tab/modal (re)opens). */
  reloadToken?: number;
  testId?: string;
  /** Sanitized ownership metadata exposed to App Advisor while mounted. */
  advisorContext?: {
    scope: 'worktree' | 'workspace-shadow';
    workspaceId: string;
    worktreeId?: string;
  };
}

function isCodeGraphIpcError(
  value: CodeGraphUiSummaryResponse,
): value is CodeGraphIpcError {
  return 'ok' in value && value.ok === false;
}

/**
 * Desktop data wrapper for the shared Code Graph summary, embedded in Branch
 * Info and both workspace Settings modals. Owns the load/build lifecycle: it
 * loads the summary for its scope through the injected `load`, triggers builds
 * through the injected `build`, follows builds started elsewhere, and reports
 * sanitized status to App Advisor. The shared `CodeGraphSummaryView` renders
 * every state from props.
 *
 * Only safe, published summary data is rendered — never a local shadow
 * filesystem path.
 */
export function CodeGraphSummaryPanel({
  load,
  build,
  onOpenSettings,
  externalBuilding = false,
  reloadToken,
  testId = 'code-graph-summary',
  advisorContext,
}: CodeGraphSummaryPanelProps): JSX.Element {
  const [phase, setPhase] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [summary, setSummary] = useState<CodeGraphUiSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadFailureReadiness, setLoadFailureReadiness] =
    useState<CodeGraphReadiness | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

  const loadRef = useRef(load);
  loadRef.current = load;
  const buildRef = useRef(build);
  buildRef.current = build;
  const loadIdRef = useRef(0);
  const prevExternalBuilding = useRef(externalBuilding);

  // A reload keeps the current summary on screen while it is pending (the view
  // renders it with phase 'loading'). Every failed read clears it, so counts
  // from an earlier read are never presented after a failure.
  const runLoad = useCallback(async (): Promise<void> => {
    const id = ++loadIdRef.current;
    setPhase('loading');
    setBuildError(null);
    try {
      const response = await loadRef.current();
      if (id !== loadIdRef.current) {
        return;
      }
      if (isCodeGraphIpcError(response)) {
        setSummary(null);
        setLoadError(loadFailureMessage(response));
        setLoadFailureReadiness(readinessOf(response));
        setPhase('error');
      } else {
        setSummary(response);
        setLoadError(null);
        setLoadFailureReadiness(null);
        setPhase('loaded');
      }
    } catch {
      if (id !== loadIdRef.current) {
        return;
      }
      setSummary(null);
      setLoadError(FALLBACK_LOAD_ERROR);
      setLoadFailureReadiness(null);
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    void runLoad();
  }, [runLoad, reloadToken]);

  // When a build that started elsewhere finishes (externalBuilding true→false),
  // reload the summary so it reflects the freshly published graph.
  useEffect(() => {
    if (prevExternalBuilding.current && !externalBuilding) {
      void runLoad();
    }
    prevExternalBuilding.current = externalBuilding;
  }, [externalBuilding, runLoad]);

  const handleBuild = useCallback(async (): Promise<void> => {
    setBuilding(true);
    setBuildError(null);
    try {
      const response = await buildRef.current();
      if (isCodeGraphIpcError(response)) {
        // Preserve the previous summary; surface an inline, retryable error.
        setBuildError(
          response.snapshotState || response.readFailure
            ? loadFailureMessage(response)
            : response.message || FALLBACK_BUILD_ERROR,
        );
      } else {
        // A successful build publishes a newer snapshot than any read already
        // in flight. Those reads must not replace the build's summary.
        ++loadIdRef.current;
        setSummary(response);
        setLoadError(null);
        setLoadFailureReadiness(null);
        setPhase('loaded');
      }
    } catch {
      setBuildError(FALLBACK_BUILD_ERROR);
    } finally {
      setBuilding(false);
    }
  }, []);

  const handleRetry = useCallback((): void => {
    void runLoad();
  }, [runLoad]);

  const handleBuildClick = useCallback((): void => {
    void handleBuild();
  }, [handleBuild]);

  const isBuildingNow = building || externalBuilding;
  const readiness: CodeGraphReadiness = summary
    ? readinessOf(summary)
    : (loadFailureReadiness ?? {});
  useCurrentUiStateReporter(
    'codeGraph.detailPanel',
    advisorContext
      ? {
          ...advisorContext,
          phase,
          ...(summary
            ? { state: summary.state, enabled: summary.enabled }
            : {}),
          building: isBuildingNow,
          ...(summary ? { repositoryCount: summary.repositories.length } : {}),
          loadErrorVisible:
            phase === 'error' && readiness.snapshotState !== 'summary-pending',
          buildErrorVisible: buildError !== null,
          ...readiness,
        }
      : null,
  );

  return (
    <CodeGraphSummaryView
      phase={phase}
      summary={summary}
      loadErrorMessage={loadError ?? FALLBACK_LOAD_ERROR}
      loadSnapshotState={loadFailureReadiness?.snapshotState}
      buildErrorMessage={buildError}
      building={isBuildingNow}
      onRetry={handleRetry}
      onBuild={handleBuildClick}
      onOpenSettings={onOpenSettings}
      testId={testId}
    />
  );
}
