import { workspaceReadinessIssueKey } from '@/lib/workspaceReadinessIssueKey';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type { WorkspaceReadinessIssue } from '@canopy/desktop-shared/types';
import { CheckIcon, WrenchIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  launchWorkspaceReadinessFix,
  navigateToWorkspaceReadinessChat,
} from '@/lib/workspaceReadinessLauncher';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { Button, LoadingSpinner } from '../shared';

interface WorkspaceReadinessRecommendationsProps {
  workspaceId: string;
  worktreeId?: string;
  /**
   * Dismiss the host surface. Called when the user opens a launched chat, not
   * when one is started: launching keeps this surface open so several
   * recommendations can be fixed in one visit.
   */
  onViewConversation: () => void;
}

type LoadState = 'loading' | 'ready' | 'error';

interface LaunchedReadinessChat {
  worktreeId: string;
  chatId: string;
}

export function WorkspaceReadinessRecommendations({
  workspaceId,
  worktreeId,
  onViewConversation,
}: WorkspaceReadinessRecommendationsProps): JSX.Element {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [issues, setIssues] = useState<WorkspaceReadinessIssue[]>([]);
  const [launchingKey, setLaunchingKey] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  /** Chats launched from this surface, keyed like `launchingKey`. */
  const [launchedChats, setLaunchedChats] = useState<
    Record<string, LaunchedReadinessChat>
  >({});
  const loadGeneration = useRef(0);
  const targetKey = `${workspaceId}:${worktreeId ?? 'reference'}`;
  const targetKeyRef = useRef(targetKey);
  targetKeyRef.current = targetKey;

  const load = useCallback(async (): Promise<void> => {
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    setLoadState('loading');
    try {
      const response = await window.api.getWorkspaceReadiness({
        workspaceId,
        worktreeId,
      });
      if (loadGeneration.current !== generation) return;
      setIssues(response.issues);
      setLoadState('ready');
    } catch {
      if (loadGeneration.current !== generation) return;
      setLoadState('error');
    }
  }, [workspaceId, worktreeId]);

  useEffect(() => {
    void load();
    return (): void => {
      loadGeneration.current += 1;
    };
  }, [load]);

  useEffect(() => {
    setLaunchingKey(null);
    setLaunchError(null);
  }, [targetKey]);

  const groupedIssues = useMemo(() => {
    const groups = new Map<string, WorkspaceReadinessIssue[]>();
    for (const issue of issues) {
      const existing = groups.get(issue.repoName) ?? [];
      existing.push(issue);
      groups.set(issue.repoName, existing);
    }
    return Array.from(groups.entries());
  }, [issues]);

  const handleFix = async (issue: WorkspaceReadinessIssue): Promise<void> => {
    if (launchingKey !== null) return;
    const launchTargetKey = targetKey;
    const key = `${launchTargetKey}:${issue.code === 'recovery-required' ? workspaceReadinessIssueKey(issue) : `${issue.repoId ?? 'project'}:${issue.code}`}`;
    if (launchedChats[key]) return;
    setLaunchingKey(key);
    setLaunchError(null);
    // Stay open so the remaining recommendations can be started too; the
    // launched chat stays reachable through "View conversation".
    const result = await launchWorkspaceReadinessFix(
      workspaceId,
      issue,
      worktreeId,
      { navigateToChat: false },
    );
    if (targetKeyRef.current !== launchTargetKey) return;
    if (result.ok) {
      setLaunchedChats((current) => ({
        ...current,
        [key]: { worktreeId: result.worktreeId, chatId: result.chatId },
      }));
    } else {
      setLaunchError(result.message);
    }
    setLaunchingKey(null);
  };

  const handleView = async (launched: LaunchedReadinessChat): Promise<void> => {
    // Dismiss first so the chat is not opened behind this surface.
    onViewConversation();
    await navigateToWorkspaceReadinessChat(
      workspaceId,
      launched.worktreeId,
      launched.chatId,
    );
  };

  const ready = loadState === 'ready' && issues.length === 0;
  const launchedChatCount = Object.keys(launchedChats).filter((key) =>
    key.startsWith(`${targetKey}:`),
  ).length;
  useCurrentUiStateReporter('workspaceReadiness.settings', {
    surface: 'settings',
    workspaceId,
    ...(worktreeId ? { worktreeId } : {}),
    status: loadState,
    issueCount: issues.length,
    launching: launchingKey !== null,
    launchedChatCount,
    errorVisible: loadState === 'error' || launchError !== null,
  });
  return (
    <section
      className="rounded-lg border bg-secondary/10 p-4"
      data-testid="workspace-readiness-recommendations"
    >
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
            ready
              ? 'bg-success-subtle fg-success'
              : 'bg-accent-subtle fg-accent'
          }`}
        >
          {ready ? (
            <CheckIcon width={15} height={15} />
          ) : (
            <WrenchIcon width={15} height={15} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-s font-medium fg-primary">
            Repository readiness
          </h3>
          {loadState === 'loading' && (
            <div className="mt-1 flex items-center gap-2 text-xs fg-secondary">
              <LoadingSpinner />
              <span>Checking repository readiness…</span>
            </div>
          )}
          {ready && (
            <p className="mt-1 text-xs fg-secondary">
              This Code project has setup and launch scripts, hooks, and shared
              agent instructions in place.
            </p>
          )}
          {loadState === 'error' && (
            <div className="mt-1 flex items-center gap-2">
              <p className="text-xs fg-destructive">
                Couldn’t check repository readiness.
              </p>
              <Button size="sm" variant="ghost" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          )}
        </div>
      </div>

      {loadState === 'ready' && groupedIssues.length > 0 && (
        <div className="mt-4 space-y-4">
          {groupedIssues.map(([repoName, repoIssues]) => (
            <div key={repoName}>
              <h4 className="mb-2 text-xs font-medium fg-secondary">
                {repoName}
              </h4>
              <div className="space-y-2">
                {repoIssues.map((issue) => {
                  const key = `${targetKey}:${issue.code === 'recovery-required' ? workspaceReadinessIssueKey(issue) : `${issue.repoId ?? 'project'}:${issue.code}`}`;
                  const isLaunching = launchingKey === key;
                  const launched = launchedChats[key];
                  return (
                    <div
                      key={key}
                      className="flex items-center justify-between gap-4 rounded-lg border bg-base px-3 py-3"
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-medium fg-primary">
                          {issue.title}
                        </div>
                        <div className="mt-1 text-xs fg-secondary">
                          {issue.message}
                        </div>
                      </div>
                      {issue.fixPrompt === null ? null : launched ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void handleView(launched)}
                        >
                          View conversation
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={launchingKey !== null}
                          onClick={() => void handleFix(issue)}
                        >
                          {isLaunching ? 'Starting…' : 'Fix in new worktree'}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {launchError && (
        <p className="mt-3 text-xs fg-destructive">{launchError}</p>
      )}
    </section>
  );
}
