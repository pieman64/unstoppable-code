import { useEffect, useRef, useState, type JSX } from 'react';
import type { WorkspaceReadinessIssue } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { HomeSection, SuggestionRow } from '@canopy/ui-shared';
import { WrenchIcon } from '@canopy/ui-shared/icons/AppIcons';
import { launchWorkspaceReadinessFix } from '@/lib/workspaceReadinessLauncher';
import { workspaceReadinessIssueKey } from '@/lib/workspaceReadinessIssueKey';

/** Actionable project fixes survive independently of Getting started progress. */
export function HomeWorkspaceReadiness({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string;
  workspaceName?: string;
}): JSX.Element | null {
  const [issues, setIssues] = useState<WorkspaceReadinessIssue[]>([]);
  const [launching, setLaunching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void window.api.getWorkspaceReadiness({ workspaceId }).then(
      (result) => {
        if (!cancelled)
          setIssues(result.issues.filter((issue) => issue.fixPrompt !== null));
      },
      () => {
        /* An unavailable audit must not block Home or invent fixes. */
      },
    );
    return (): void => {
      cancelled = true;
      mounted.current = false;
    };
  }, [workspaceId]);

  const fix = async (issue: WorkspaceReadinessIssue): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    const key = workspaceReadinessIssueKey(issue);
    setLaunching(key);
    setError(null);
    try {
      const result = await launchWorkspaceReadinessFix(workspaceId, issue);
      if (!mounted.current) return;
      if (result.ok)
        setIssues((current) =>
          current.filter((entry) => workspaceReadinessIssueKey(entry) !== key),
        );
      else setError(result.message);
    } catch {
      if (mounted.current)
        setError('Could not start this project fix. Try again.');
    } finally {
      busy.current = false;
      if (mounted.current) setLaunching(null);
    }
  };

  if (issues.length === 0) return null;
  return (
    <HomeSection
      sectionId={`project-suggestions:${workspaceId}`}
      testId="home-workspace-readiness"
      title={
        workspaceName ? (
          <>
            Suggestions for{' '}
            <span className={POSTHOG_REPLAY_MASK_CLASS}>{workspaceName}</span>
          </>
        ) : (
          'Project suggestions'
        )
      }
    >
      <ul className="flex flex-col">
        {issues.map((issue) => (
          <li key={workspaceReadinessIssueKey(issue)}>
            <SuggestionRow
              icon={<WrenchIcon size={16} aria-hidden="true" />}
              data-testid={`home-readiness-fix-${issue.code}`}
              aria-label={
                launching === workspaceReadinessIssueKey(issue)
                  ? 'Starting fix'
                  : issue.title
              }
              disabled={launching !== null}
              onClick={(): void => {
                void fix(issue);
              }}
            >
              {issue.title}{' '}
              <span
                className={`text-xs fg-secondary ${POSTHOG_REPLAY_MASK_CLASS}`}
              >
                · {issue.repoName}
              </span>
            </SuggestionRow>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-xs fg-destructive">
          {error}
        </p>
      )}
    </HomeSection>
  );
}
