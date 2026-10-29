import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import type {
  ChatTabPluginSelections,
  WorkspaceReadinessIssue,
} from '@canopy/desktop-shared/types';
import { brand } from '@/lib/brand';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';

export type WorkspaceReadinessLaunchResult =
  | { ok: true; worktreeId: string; chatId: string }
  | { ok: false; message: string };

export interface LaunchWorkspaceReadinessFixOptions {
  /**
   * Whether the launcher navigates to the created chat itself. The New Task
   * Getting started's final repository-setup row keeps the default: launching
   * from onboarding is a hand-off into the fix chat. The Overview and the
   * workspace-settings surface both pass `false` — they stay put and own navigation through
   * {@link navigateToWorkspaceReadinessChat} / their own affordances.
   *
   * Note for default-navigation callers: the launcher navigates on success
   * BEFORE the trailing `sendMessage` settles, so the calling component may
   * unmount mid-launch. A post-navigation send failure surfaces as a system
   * error inside the launched chat's transcript, not through the caller's
   * error state.
   */
  navigateToChat?: boolean;
}

const activeLaunches = new Set<string>();

/**
 * Open a previously launched readiness chat. Mirrors the worktree-chat branch
 * of the Workers page link-target handler so both surfaces select the worktree,
 * hydrate its tabs, and activate the specific chat the same way.
 */
export async function navigateToWorkspaceReadinessChat(
  workspaceId: string,
  worktreeId: string,
  chatId: string,
): Promise<void> {
  const chatStore = useChatStore.getState();
  useNavigationStore.getState().navigate('main');
  chatStore.selectWorktree(workspaceId, worktreeId);
  const tabsLoaded = await chatStore.ensureSelectedWorktreeTabsLoaded();
  if (tabsLoaded) {
    chatStore.switchTab(chatId, { projectId: workspaceId, worktreeId });
  }
}

export function resolveWorkspaceReadinessWorktreeId(
  driftWorktreeId?: string,
  inspectedWorktreeId?: string,
): string | undefined {
  return driftWorktreeId ?? inspectedWorktreeId;
}

function withConfigSkill(
  selections: ChatTabPluginSelections | undefined,
): ChatTabPluginSelections {
  const normalized = normalizePluginSelections(selections);
  const skillName = `${brand.internalName}-config`;
  const hasSkill = normalized.skillRefs.some(
    (ref) =>
      ref.skillName === skillName &&
      (ref.sourceId === 'builtin:app' ||
        ref.sourceId === 'builtin/app' ||
        ref.sourceId === 'builtin'),
  );
  return {
    ...normalized,
    skillRefs: hasSkill
      ? normalized.skillRefs
      : [...normalized.skillRefs, { sourceId: 'builtin:app', skillName }],
  };
}

function launchKey(
  workspaceId: string,
  issue: WorkspaceReadinessIssue,
  baseWorktreeId?: string,
): string {
  return `${workspaceId}:${baseWorktreeId ?? 'reference'}:${issue.repoId ?? 'workspace'}:${issue.code}`;
}

export async function launchWorkspaceReadinessFix(
  workspaceId: string,
  issue: WorkspaceReadinessIssue,
  baseWorktreeId?: string,
  options?: LaunchWorkspaceReadinessFixOptions,
): Promise<WorkspaceReadinessLaunchResult> {
  const fixPrompt = issue.fixPrompt;
  if (fixPrompt === null) return { ok: false, message: issue.message };

  const key = launchKey(workspaceId, issue, baseWorktreeId);
  if (activeLaunches.has(key)) {
    return { ok: false, message: 'This recommendation is already starting.' };
  }

  const initialWorkspace = useProjectsStore
    .getState()
    .projects.find((project) => project.id === workspaceId);
  if (!initialWorkspace || initialWorkspace.type === 'cowork') {
    return {
      ok: false,
      message: 'Repository readiness is only available for Code projects.',
    };
  }

  activeLaunches.add(key);
  try {
    const projectsStore = useProjectsStore.getState();
    if (
      baseWorktreeId !== undefined &&
      initialWorkspace.type === 'multi-repo'
    ) {
      const health = await projectsStore.retryWorktreeHealthCheck(
        workspaceId,
        baseWorktreeId,
      );
      const missingRepos =
        health.issue?.repoIssues?.filter(
          (repoIssue) => repoIssue.code === 'missing-repository',
        ) ?? [];
      if (missingRepos.length > 0) {
        const repoNames = missingRepos
          .map((repoIssue) => repoIssue.repoName)
          .join(', ');
        return {
          ok: false,
          message: `This worktree excludes ${repoNames}. Add the missing ${
            missingRepos.length === 1 ? 'repository' : 'repositories'
          } before starting a readiness fix from it.`,
        };
      }
    }
    const created =
      baseWorktreeId === undefined
        ? await projectsStore.createWorktree(workspaceId, {
            suppressStartPage: true,
          })
        : await projectsStore.createWorktree(workspaceId, {
            baseWorktreeId,
            suppressStartPage: true,
          });
    if (!created) {
      return {
        ok: false,
        message: 'Could not create a worktree for this recommendation.',
      };
    }

    const workspace = useProjectsStore
      .getState()
      .projects.find((project) => project.id === workspaceId);
    if (!workspace || workspace.type === 'cowork') {
      return {
        ok: false,
        message: 'The Code project is no longer available.',
      };
    }

    const worktree = workspace.worktrees.find(
      (entry) => entry.id === created.id,
    );
    const target = { projectId: workspaceId, worktreeId: created.id };
    const chatStore = useChatStore.getState();
    await chatStore.loadAllWorktreeTabs([target]);

    const hydratedChat =
      useChatStore.getState().worktreeChats[`${workspaceId}/${created.id}`];
    const currentTab = hydratedChat?.tabs.find(
      (tab) => tab.id === hydratedChat.activeTabId,
    );
    chatStore.createTab({
      ...target,
      title: issue.title,
      replaceActiveEmpty: true,
      pluginSelections: withConfigSkill(currentTab?.pluginSelections),
      ...(issue.repoId ? { selectedRepoId: issue.repoId } : {}),
    });

    const configuredChat =
      useChatStore.getState().worktreeChats[`${workspaceId}/${created.id}`];
    const chatId = configuredChat?.activeTabId;
    if (!chatId) {
      return {
        ok: false,
        message: 'Could not create a chat for this recommendation.',
      };
    }

    if (options?.navigateToChat !== false) {
      useNavigationStore.getState().navigate('main');
    }
    await useChatStore
      .getState()
      .sendMessage(fixPrompt, undefined, { ...target, chatId }, undefined, {
        ...((worktree?.setupPhase ?? created.setupPhase) === 'git-pending'
          ? { queueForSetup: true }
          : {}),
        throwOnDispatchFailure: true,
      });
    return { ok: true, worktreeId: created.id, chatId };
  } catch (cause) {
    return {
      ok: false,
      message:
        cause instanceof Error
          ? cause.message
          : 'Could not launch the readiness agent.',
    };
  } finally {
    activeLaunches.delete(key);
  }
}
