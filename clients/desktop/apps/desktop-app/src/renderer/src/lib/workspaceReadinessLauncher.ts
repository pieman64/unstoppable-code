import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import type {
  ChatTabPluginSelections,
  WorkspaceReadinessIssue,
} from '@canopy/desktop-shared/types';
import { reconcileWorkspaceReadinessLaunches } from '@/hooks/useWorkspaceReadinessLaunchReconciliation';
import { brand } from '@/lib/brand';
import { workspaceReadinessIssueKey } from '@/lib/workspaceReadinessIssueKey';
import { workspaceReadinessLaunchKey } from '@/lib/workspaceReadinessLaunches';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useWorkspaceReadinessLaunchStore } from '@/stores/workspaceReadinessLaunchStore';

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
  const hydratedChat =
    useChatStore.getState().worktreeChats[`${workspaceId}/${worktreeId}`];
  if (tabsLoaded && hydratedChat?.tabs.some((tab) => tab.id === chatId)) {
    useChatStore
      .getState()
      .switchTab(chatId, { projectId: workspaceId, worktreeId });
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

/**
 * Launches a readiness fix, or reopens the one already launched for the same
 * workspace, audit target and issue. Every entry point (Home, the Overview,
 * workspace settings and `workspace.start_readiness_fix`) goes through here,
 * so a retained launch record is reused instead of creating another worktree
 * and send.
 */
export async function launchWorkspaceReadinessFix(
  workspaceId: string,
  issue: WorkspaceReadinessIssue,
  baseWorktreeId?: string,
  options?: LaunchWorkspaceReadinessFixOptions,
): Promise<WorkspaceReadinessLaunchResult> {
  const fixPrompt = issue.fixPrompt;
  if (fixPrompt === null) return { ok: false, message: issue.message };

  const issueKey = workspaceReadinessIssueKey(issue);
  const key = workspaceReadinessLaunchKey(
    workspaceId,
    baseWorktreeId,
    issueKey,
  );
  const initialWorkspace = useProjectsStore
    .getState()
    .projects.find((project) => project.id === workspaceId);
  if (!initialWorkspace || initialWorkspace.type === 'cowork') {
    return {
      ok: false,
      message: 'Repository readiness is only available for Code projects.',
    };
  }

  // Only authoritative evidence retires a record; an incomplete inventory
  // keeps it, and the launch reopens that destination.
  reconcileWorkspaceReadinessLaunches();
  const retained = useWorkspaceReadinessLaunchStore.getState().records[key];
  if (retained) {
    if (options?.navigateToChat !== false) {
      await navigateToWorkspaceReadinessChat(
        workspaceId,
        retained.worktreeId,
        retained.chatId,
      );
    }
    return {
      ok: true,
      worktreeId: retained.worktreeId,
      chatId: retained.chatId,
    };
  }

  if (activeLaunches.has(key)) {
    return { ok: false, message: 'This recommendation is already starting.' };
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

    // Record the destination before navigating or sending: the caller may
    // unmount once navigation starts, and a failed send must still leave the
    // chat reachable instead of offering another launch.
    const launches = useWorkspaceReadinessLaunchStore.getState();
    launches.setSendPending(key, true);
    launches.recordLaunch({
      workspaceId,
      issueKey,
      issueCode: issue.code,
      ...(baseWorktreeId === undefined ? {} : { baseWorktreeId }),
      worktreeId: created.id,
      chatId,
      launchedAt: new Date().toISOString(),
    });
    try {
      if (options?.navigateToChat !== false) {
        useNavigationStore.getState().navigate('main');
      }
      await useChatStore
        .getState()
        .sendMessage(fixPrompt, undefined, { ...target, chatId }, undefined, {
          throwOnDispatchFailure: true,
        });
    } catch (cause) {
      useWorkspaceReadinessLaunchStore.getState().setSendFailed(key, true);
      throw cause;
    } finally {
      useWorkspaceReadinessLaunchStore.getState().setSendPending(key, false);
    }
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
