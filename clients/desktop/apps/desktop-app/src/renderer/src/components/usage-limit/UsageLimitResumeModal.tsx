import {
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useShallow } from 'zustand/shallow';
import { DialogModal, getModelCatalogProviderLabel } from '@canopy/ui-shared';
import type {
  UsageLimitedSessionGroup,
  UsageLimitedSessionItem,
  UsageLimitedSessionTarget,
} from '@canopy/desktop-shared/types';
import {
  isProviderlessResumePromptOrigin,
  useUsageLimitResumePromptStore,
} from '@/stores/usageLimitResumePromptStore';
import { clearResumedChatUsageLimitBanner } from '@/stores/chatStore';
import { useResumeQueueStore } from '@/stores/resumeQueueStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { isWorkspaceIdInContext } from '@/lib/contextScope';
import {
  linkedPersonalWorkspaceIdsForContext,
  useLinkedPersonalWorkspacesStore,
} from '@/stores/linkedPersonalWorkspacesStore';
import { installUsageLimitResumeTestApi } from '@/lib/usage-limit/test-api';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import { useProjectsStore } from '@/stores/projectsStore';
import { ProjectIcon } from '../shared/ProjectIcon';
import { filterSessionGroupsByWorkspace } from './usageLimitResumeScope';
import { BranchIcon as AppCatalogBranchIcon } from '@canopy/ui-shared/icons/AppIcons';

const REFRESH_INTERVAL_MS = 30_000;
const LOAD_ERROR = 'Couldn’t load interrupted sessions.';

function targetKey(
  target: UsageLimitedSessionItem | UsageLimitedSessionTarget,
): string {
  return target.kind === 'chat'
    ? `chat:${target.projectId}/${target.worktreeId}/${target.chatId}`
    : `pipeline:${target.executionId}`;
}

interface WorktreeSubgroup {
  worktreeId: string;
  worktreeName: string;
  sessions: UsageLimitedSessionItem[];
}

/** Group a code workspace's chats by worktree, preserving encounter order. */
function groupSessionsByWorktree(
  sessions: UsageLimitedSessionItem[],
): WorktreeSubgroup[] {
  const byWorktree = new Map<string, WorktreeSubgroup>();
  for (const session of sessions) {
    const worktreeId = session.worktreeId ?? 'workspace';
    const existing = byWorktree.get(worktreeId);
    if (existing) {
      existing.sessions.push(session);
    } else {
      byWorktree.set(worktreeId, {
        worktreeId,
        worktreeName: session.worktreeName || worktreeId,
        sessions: [session],
      });
    }
  }
  return Array.from(byWorktree.values());
}

/** Checkbox that also renders the indeterminate (partial-selection) state. */
function TriStateCheckbox({
  checked,
  indeterminate,
  onChange,
  testId,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
  testId: string;
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      data-testid={testId}
      checked={checked}
      onChange={onChange}
    />
  );
}

/** Subscribe only to the icon's repository path, not live worktree status. */
function ResumeWorkspaceIcon({
  group,
}: {
  group: UsageLimitedSessionGroup;
}): JSX.Element | null {
  const repoPath = useProjectsStore((state) => {
    const project = state.projects.find(
      (candidate) => candidate.id === group.workspaceId,
    );
    return project?.type === 'single-repo' ? project.repoPath : undefined;
  });
  return group.workspaceType ? (
    <ProjectIcon
      kind={group.workspaceType}
      color={group.workspaceColor}
      repoPath={repoPath}
      size="sm"
    />
  ) : null;
}

/**
 * Mounted once in App.tsx. Initial loading selects every interrupted session;
 * focus and periodic refreshes keep the loaded list in place, retain valid
 * choices, and leave newly discovered sessions unchecked. Confirmation queues
 * the selected targets. An empty scoped result closes the prompt.
 */
function UsageLimitResumeModalContent(): JSX.Element | null {
  const isOpen = useUsageLimitResumePromptStore((s) => s.isOpen);
  const provider = useUsageLimitResumePromptStore((s) => s.provider);
  const origin = useUsageLimitResumePromptStore((s) => s.origin);
  const authentication = useUsageLimitResumePromptStore(
    (s) => s.authentication,
  );
  const close = useUsageLimitResumePromptStore((s) => s.close);
  const context = useSidebarScopingContext();
  const linkedIds = useLinkedPersonalWorkspacesStore((state) =>
    linkedPersonalWorkspaceIdsForContext(state, context),
  );

  const [loadedGroups, setGroups] = useState<UsageLimitedSessionGroup[] | null>(
    null,
  );
  // Status polling replaces project objects frequently. Only publish a change
  // here when a loaded session actually enters or leaves the Home scope.
  const visibleSessionKeys = useProjectsStore(
    useShallow((state) => {
      const scoped =
        origin === 'home'
          ? filterSessionGroupsByWorkspace(loadedGroups ?? [], (workspaceId) =>
              isWorkspaceIdInContext(
                workspaceId,
                state.projects,
                context,
                linkedIds,
              ),
            )
          : (loadedGroups ?? []);
      return scoped.flatMap((group) => group.sessions.map(targetKey));
    }),
  );
  const groups = useMemo(() => {
    if (loadedGroups === null || origin !== 'home') return loadedGroups;
    const visible = new Set(visibleSessionKeys);
    return loadedGroups
      .map((group) => ({
        ...group,
        sessions: group.sessions.filter((session) =>
          visible.has(targetKey(session)),
        ),
      }))
      .filter((group) => group.sessions.length > 0);
  }, [loadedGroups, origin, visibleSessionKeys]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const closePrompt = useCallback((): void => {
    if (
      origin === 'authentication' &&
      authentication?.phase === 'verification-failed'
    ) {
      void window.api.codexLogin
        .cancel()
        .then(close)
        .catch(() =>
          setError("Couldn't finish cancelling sign-in. Try again."),
        );
      return;
    }
    close();
  }, [authentication?.phase, close, origin]);

  const isSubmitting = useEffectEvent((): boolean => submitting);
  const closeLoadedPrompt = useEffectEvent((): void => closePrompt());

  // E2E hook: lets a Playwright spec open this modal through the same store
  // the real account-change trigger uses, without needing a real provider
  // CLI login. Hard-gated on __CANOPY_E2E__; inert (installer returns
  // undefined) outside E2E builds.
  useEffect(() => installUsageLimitResumeTestApi(), []);

  useEffect(() => {
    if (!isOpen || (!provider && !isProviderlessResumePromptOrigin(origin))) {
      setGroups(null);
      setSelected(new Set());
      setError(null);
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let snapshot: string | undefined;
    setGroups(null);
    setError(null);
    const refresh = async (): Promise<void> => {
      if (inFlight || isSubmitting()) return;
      inFlight = true;
      let result: UsageLimitedSessionGroup[];
      try {
        if (typeof window.api.listUsageLimitedIdleSessions === 'function') {
          result = await window.api.listUsageLimitedIdleSessions(
            origin === 'authentication' && authentication?.attemptId
              ? { authenticationAttemptId: authentication.attemptId }
              : origin === 'app-restart'
                ? { resumeReason: 'app_shutdown' }
                : origin === 'home'
                  ? {}
                  : { provider: provider ?? 'claude' },
          );
        } else {
          const legacyGroups = await window.api.listUsageLimitedIdleChats({
            provider: provider ?? 'claude',
          });
          result = legacyGroups.map((group) => ({
            groupId: group.workspaceId,
            groupKind: 'workspace',
            workspaceId: group.workspaceId,
            workspaceName: group.workspaceName,
            workspaceType: group.workspaceType,
            workspaceColor: group.workspaceColor,
            sessions: group.chats.map((chat) => ({
              ...chat,
              kind: 'chat' as const,
            })),
          }));
        }
        if (cancelled || isSubmitting()) return;
        const nextSnapshot = JSON.stringify(result);
        if (snapshot !== nextSnapshot) {
          const keys = new Set(
            result.flatMap((group) => group.sessions.map(targetKey)),
          );
          const initialLoad = snapshot === undefined;
          setGroups(result);
          setSelected((current) => {
            // Select everything on initial load. Subsequent discoveries require
            // a deliberate choice; preserve both checks and unchecks by identity.
            if (initialLoad) return keys;
            const next = new Set(
              Array.from(current).filter((key) => keys.has(key)),
            );
            return next.size === current.size ? current : next;
          });
          snapshot = nextSnapshot;
        }
        setError((current) => (current === LOAD_ERROR ? null : current));
      } catch {
        if (cancelled) return;
        if (snapshot === undefined) {
          setError((current) => current ?? LOAD_ERROR);
          setGroups([]);
        }
      } finally {
        inFlight = false;
      }
    };
    const requestRefresh = (): void => {
      void refresh();
    };
    requestRefresh();
    const interval = window.setInterval(requestRefresh, REFRESH_INTERVAL_MS);
    window.addEventListener('focus', requestRefresh);

    return (): void => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', requestRefresh);
    };
    // Submission state is read through an Effect Event so starting a resume
    // does not restart the request or replace the pending selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, provider, origin, loadAttempt, authentication?.attemptId]);

  useEffect(() => {
    if (isOpen && groups !== null && groups.length === 0 && !error) {
      closeLoadedPrompt();
    }
    // Effect Events read the latest dismissal policy without retriggering the
    // effect when authentication verification changes for the same attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, groups, error]);

  const allSessions = useMemo<UsageLimitedSessionItem[]>(
    () => (groups ?? []).flatMap((group) => group.sessions),
    [groups],
  );
  const selectedCount = allSessions.filter((session) =>
    selected.has(targetKey(session)),
  ).length;
  const allSelected = selectedCount > 0 && selectedCount === allSessions.length;

  useCurrentUiStateReporter('usageLimit.resumeModal', {
    open: isOpen,
    origin,
    ...(provider ? { provider } : {}),
    loading: isOpen && groups === null,
    submitting,
    groupCount: groups?.length ?? 0,
    chatCount: allSessions.filter((session) => session.kind === 'chat').length,
    pipelineCount: allSessions.filter((session) => session.kind === 'pipeline')
      .length,
    selectedCount,
    error,
  });

  if (!isOpen || (!provider && !isProviderlessResumePromptOrigin(origin))) {
    return null;
  }

  const providerLabel = getModelCatalogProviderLabel(provider ?? 'claude');
  const subtitle =
    origin === 'authentication'
      ? authentication?.account?.authenticated
        ? `Resume work paused while signing in with ${authentication.account.accountLabel ?? 'your current Codex account'}.`
        : 'Work paused for Codex sign-in. Verify an account before resuming.'
      : origin === 'home'
        ? 'Resume chats and pipelines interrupted by an application stop, a usage limit, or an authentication issue.'
        : origin === 'app-restart'
          ? 'Resume chats and pipelines paused when the application stopped.'
          : origin === 'usage-review'
            ? allSessions.some((session) =>
                session.kind === 'chat'
                  ? session.resumeReason === 'app_shutdown'
                  : session.resumeReasons?.includes('app_shutdown'),
              )
              ? `Resume sessions interrupted by an application stop, a ${providerLabel} usage limit, or an authentication issue.`
              : `Resume sessions interrupted by a ${providerLabel} usage limit or authentication issue.`
            : `You switched ${providerLabel} accounts. Resume sessions that were interrupted on the previous account.`;
  if (groups === null) {
    return (
      <DialogModal
        onClose={closePrompt}
        maxWidth="lg"
        title="Resume interrupted sessions"
        subtitle={subtitle}
      >
        <div className="px-5 py-8 text-s fg-secondary">
          Loading interrupted sessions…
        </div>
      </DialogModal>
    );
  }
  if (error && groups.length === 0) {
    return (
      <DialogModal
        onClose={closePrompt}
        maxWidth="lg"
        title="Resume interrupted sessions"
        subtitle={subtitle}
      >
        <div className="px-5 py-5">
          <p className="text-s fg-destructive">{error}</p>
          <div className="mt-4 flex justify-end gap-3">
            <button type="button" onClick={closePrompt}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => setLoadAttempt((value) => value + 1)}
            >
              Retry
            </button>
          </div>
        </div>
      </DialogModal>
    );
  }

  const toggleSession = (session: UsageLimitedSessionItem): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      const key = targetKey(session);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleSessions = (sessions: UsageLimitedSessionItem[]): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      const keys = sessions.map((session) => targetKey(session));
      const allSelectedNow = keys.every((key) => next.has(key));
      for (const key of keys) {
        if (allSelectedNow) next.delete(key);
        else next.add(key);
      }
      return next;
    });

  const toggleWorkspace = (group: UsageLimitedSessionGroup): void =>
    toggleSessions(group.sessions);

  const triState = (
    sessions: UsageLimitedSessionItem[],
  ): { checked: boolean; indeterminate: boolean } => {
    const keys = sessions.map((session) => targetKey(session));
    const count = keys.filter((key) => selected.has(key)).length;
    return {
      checked: keys.length > 0 && count === keys.length,
      indeterminate: count > 0,
    };
  };

  const toggleAll = (): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      const keys = allSessions.map(targetKey);
      const allSelectedNow = keys.every((key) => prev.has(key));
      for (const key of keys) {
        if (allSelectedNow) next.delete(key);
        else next.add(key);
      }
      return next;
    });

  const confirm = async (): Promise<void> => {
    const selectedSessions = allSessions.filter((session) =>
      selected.has(targetKey(session)),
    );
    const targets: UsageLimitedSessionTarget[] = selectedSessions.map(
      (session) =>
        session.kind === 'chat'
          ? {
              kind: 'chat',
              projectId: session.projectId,
              worktreeId: session.worktreeId,
              chatId: session.chatId,
            }
          : {
              kind: 'pipeline',
              executionId: session.executionId,
              statusReasonIds: session.statusReasonIds,
            },
    );
    setSubmitting(true);
    setError(null);
    try {
      if (typeof window.api.enqueueResumeQueue === 'function') {
        const snapshot = await window.api.enqueueResumeQueue({
          targets,
          ...(authentication?.attemptId
            ? { authenticationAttemptId: authentication.attemptId }
            : {}),
        });
        useResumeQueueStore.getState().apply(snapshot);
        useResumeQueueStore.getState().open();
        close();
        return;
      }
      let failedKeys: Set<string>;
      if (typeof window.api.resumeUsageLimitedSessions === 'function') {
        const response = await window.api.resumeUsageLimitedSessions({
          targets,
          ...(authentication?.attemptId
            ? { authenticationAttemptId: authentication.attemptId }
            : {}),
        });
        failedKeys = new Set(
          response.failedTargets.map(({ target }) => targetKey(target)),
        );
      } else {
        const chatTargets = targets
          .filter((target) => target.kind === 'chat')
          .map(({ projectId, worktreeId, chatId }) => ({
            projectId,
            worktreeId,
            chatId,
          }));
        const response = await window.api.resumeUsageLimitedChats({
          targets: chatTargets,
        });
        failedKeys = new Set(
          response.failedTargets.map(
            (target) =>
              `chat:${target.projectId}/${target.worktreeId}/${target.chatId}`,
          ),
        );
      }
      for (const target of targets) {
        if (!failedKeys.has(targetKey(target)) && target.kind === 'chat') {
          clearResumedChatUsageLimitBanner({
            projectId: target.projectId,
            worktreeId: target.worktreeId,
            chatId: target.chatId,
          });
        }
      }
      if (failedKeys.size === 0) {
        close();
        return;
      }
      setGroups((current) =>
        (current ?? [])
          .map((group) => ({
            ...group,
            sessions: group.sessions.filter((session) =>
              failedKeys.has(targetKey(session)),
            ),
          }))
          .filter((group) => group.sessions.length > 0),
      );
      setSelected(failedKeys);
      setError('Some sessions could not be resumed. Try again.');
    } catch (error: unknown) {
      reportRendererConsoleError('Failed to resume interrupted sessions', {
        error,
      });
      setError('Some sessions could not be resumed. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const renderSessionRow = (
    session: UsageLimitedSessionItem,
    indentClass: string,
  ): JSX.Element => (
    <label
      key={targetKey(session)}
      className={`${indentClass} flex items-start gap-2 py-1 text-s`}
    >
      <input
        type="checkbox"
        data-testid={
          session.kind === 'chat'
            ? `usage-limit-resume-chat-${session.chatId}`
            : `usage-limit-resume-pipeline-${session.executionId}`
        }
        checked={selected.has(targetKey(session))}
        onChange={(): void => toggleSession(session)}
      />
      <span className="min-w-0">
        <span className="block truncate">
          {session.kind === 'chat' ? session.chatTitle : session.pipelineName}
        </span>
        <span className="block text-3xs fg-secondary">
          {session.kind === 'chat' ? 'Chat' : 'Pipeline'}
        </span>
        {(
          session.kind === 'chat'
            ? session.resumeReason === 'app_shutdown'
            : session.resumeReasons?.includes('app_shutdown')
        ) ? (
          <span className="block text-xs fg-secondary">
            Application stopped
          </span>
        ) : null}
        {session.kind === 'pipeline' ? (
          <span className="block text-xs fg-secondary">
            {session.pausedStepCount} paused step
            {session.pausedStepCount === 1 ? '' : 's'}
            {session.modelLabels.length
              ? ` · ${session.modelLabels.join(', ')}`
              : ''}
            {session.otherBlockingReasonCount
              ? ` · Also blocked by ${session.otherBlockingReasonCount} other issue${session.otherBlockingReasonCount === 1 ? '' : 's'}`
              : ''}
          </span>
        ) : null}
      </span>
    </label>
  );

  return (
    <DialogModal
      onClose={closePrompt}
      maxWidth="lg"
      title="Resume interrupted sessions"
      subtitle={subtitle}
    >
      <div data-testid="usage-limit-resume-modal" className="flex flex-col">
        {origin === 'authentication' &&
          authentication?.phase === 'verification-failed' && (
            <div className="px-5 py-4 text-s" role="alert">
              <p>{authentication.error}</p>
              <button
                type="button"
                className="mt-2 fg-accent"
                onClick={(): void => {
                  void window.api.codexLogin
                    .retryVerification()
                    .then((state) =>
                      useUsageLimitResumePromptStore
                        .getState()
                        .updateAuthentication(state),
                    );
                }}
              >
                Retry verification
              </button>
            </div>
          )}
        {origin === 'authentication' &&
          authentication?.phase === 'complete' &&
          !authentication.account?.authenticated && (
            <p className="px-5 py-4 text-s fg-secondary">
              Codex is signed out. Sign in before resuming this work.
            </p>
          )}
        <div className="flex items-center justify-between border-b px-5 py-2">
          <button
            type="button"
            data-testid="usage-limit-resume-select-all"
            onClick={toggleAll}
            className="text-xs fg-secondary hover:fg-primary"
          >
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
        </div>
        <div className="max-h-[50vh] overflow-y-auto px-5 py-2">
          {error ? (
            <p className="mb-2 text-xs fg-destructive">{error}</p>
          ) : null}
          {groups.map((group) => {
            const workspaceState = triState(group.sessions);
            return (
              <div key={group.groupId} className="mb-3">
                <label className="flex items-center gap-2 py-1 font-medium">
                  <TriStateCheckbox
                    testId={`usage-limit-resume-workspace-${group.groupId}`}
                    checked={workspaceState.checked}
                    indeterminate={workspaceState.indeterminate}
                    onChange={(): void => toggleWorkspace(group)}
                  />
                  <ResumeWorkspaceIcon group={group} />
                  <span className="truncate">{group.workspaceName}</span>
                </label>
                {group.workspaceType === 'cowork'
                  ? group.sessions.map((session) =>
                      renderSessionRow(session, 'ml-6'),
                    )
                  : groupSessionsByWorktree(group.sessions).map((worktree) => {
                      const worktreeState = triState(worktree.sessions);
                      return (
                        <div key={worktree.worktreeId} className="ml-6">
                          <label className="flex items-center gap-2 py-1 text-s fg-secondary">
                            <TriStateCheckbox
                              testId={`usage-limit-resume-worktree-${group.groupId}-${worktree.worktreeId}`}
                              checked={worktreeState.checked}
                              indeterminate={worktreeState.indeterminate}
                              onChange={(): void =>
                                toggleSessions(worktree.sessions)
                              }
                            />
                            <AppCatalogBranchIcon
                              aria-hidden="true"
                              width="12"
                              height="12"
                              className="shrink-0 opacity-70"
                            />
                            <span className="truncate">
                              {worktree.worktreeName}
                            </span>
                          </label>
                          {worktree.sessions.map((session) =>
                            renderSessionRow(session, 'ml-12'),
                          )}
                        </div>
                      );
                    })}
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-end gap-3 border-t px-5 py-3">
          <button
            type="button"
            data-testid="usage-limit-resume-cancel"
            onClick={closePrompt}
            className="rounded-md px-3 py-1.5 text-s fg-secondary hover:fg-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="usage-limit-resume-confirm"
            disabled={
              selectedCount === 0 ||
              submitting ||
              (origin === 'authentication' &&
                (authentication?.phase !== 'complete' ||
                  !authentication.account?.authenticated))
            }
            onClick={(): void => {
              void confirm();
            }}
            className="rounded-md bg-accent px-3 py-1.5 text-s font-medium fg-emphasis disabled:opacity-50"
          >
            {submitting
              ? 'Adding to queue…'
              : `Resume ${selectedCount} session${selectedCount === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </DialogModal>
  );
}

export const UsageLimitResumeModal = memo(UsageLimitResumeModalContent);
