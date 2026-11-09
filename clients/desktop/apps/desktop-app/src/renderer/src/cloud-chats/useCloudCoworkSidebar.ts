import { useCallback, useEffect } from 'react';
import { create, useStore } from 'zustand';
import { useShallow } from 'zustand/shallow';
import {
  createCoreCoworkStore,
  type CoreCoworkProject,
  type CoreCoworkTask,
} from '@canopy/app-state/core-cowork';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { useCanopyDesktopCloudChatsEnabled } from '@/hooks/useCanopyDesktopCloudChatsEnabled';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  useWorkspaceContext,
  useWorkspaceContextStore,
} from '@/stores/workspaceContextStore';
import { openCloudChat } from './cloud-chat-selection';
import { cloudChatKey } from './cloud-ids';
import { createRelayCoreCoworkInvoker } from './relay-invoker';

/** The one cloud cowork store for this renderer; every sidebar mount shares it. */
export const cloudCoworkStore = createCoreCoworkStore();

/** Collapsed cloud projects by project key. Renderer memory only, never persisted. */
const useCloudProjectCollapse = create<{
  collapsed: Readonly<Record<string, true>>;
  toggle: (projectKey: string) => void;
}>()((set) => ({
  collapsed: {},
  toggle: (projectKey): void =>
    set(({ collapsed }) => {
      const { [projectKey]: wasCollapsed, ...rest } = collapsed;
      return {
        collapsed: wasCollapsed ? rest : { ...rest, [projectKey]: true },
      };
    }),
}));

export interface CloudCoworkSidebarEntry {
  readonly key: string;
  readonly worktreeId: string;
  /** The task's root chat, as a cloud chat key. */
  readonly chatKey: string;
  readonly title: string;
  readonly working: boolean;
  readonly hasPendingQuestion: boolean;
  readonly updatedAt: string;
}

/** A cloud project row: the cowork row's shape, marked as cloud. */
export interface CloudCoworkSidebarProject {
  readonly key: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly color?: string;
  readonly cloud: true;
  readonly collapsed: boolean;
  readonly entries: readonly CloudCoworkSidebarEntry[];
}

export type CloudCoworkSidebarModel =
  | { readonly status: 'disabled' }
  | { readonly status: 'offline'; readonly reconnect: () => void }
  | {
      readonly status: 'online';
      readonly projects: readonly CloudCoworkSidebarProject[];
      readonly toggleCollapsed: (projectKey: string) => void;
      /** Creates a task, then opens its root chat with `open`. */
      readonly createTask: (
        workspaceId: string,
        open: (chatKey: string) => void,
      ) => void;
      readonly openCloudChat: (chatKey: string) => void;
    };

/**
 * D8: a cloud project shows only in its owner's context. Personal lists
 * projects with no owning organization; an organization lists its own.
 */
export function cloudProjectsForContext(
  projects: readonly CoreCoworkProject[],
  tasksByProject: Readonly<Record<string, readonly CoreCoworkTask[]>>,
  context: WorkspaceContext,
  collapsed: Readonly<Record<string, true>> = {},
): CloudCoworkSidebarProject[] {
  return projects
    .filter((project) =>
      context.kind === 'personal'
        ? project.ownerOrganizationId === null
        : project.ownerOrganizationId?.toLowerCase() ===
          context.organizationId.toLowerCase(),
    )
    .map((project) => ({
      key: project.key,
      workspaceId: project.workspaceId,
      name: project.name,
      ...(project.color === undefined ? {} : { color: project.color }),
      cloud: true,
      collapsed: collapsed[project.key] === true,
      entries: (tasksByProject[project.key] ?? [])
        .filter((task) => task.state !== 'archived')
        .map((task) => ({
          key: task.key,
          worktreeId: task.worktreeId,
          chatKey: cloudChatKey(task.worktreeId),
          title: task.title,
          working: task.state === 'running' || task.state === 'queued',
          hasPendingQuestion: task.state === 'awaiting_user',
          updatedAt: task.updatedAt,
        })),
    }));
}

function connectCloudCowork(): void {
  if (typeof window === 'undefined' || !window.canopyCore) {
    cloudCoworkStore.getState().disconnect('offline');
    return;
  }
  void cloudCoworkStore
    .getState()
    .connect(createRelayCoreCoworkInvoker(window.canopyCore));
}

let mountedHosts = 0;
let connectedFor: string | null = null;

/** Mounts share one connection, opened per flag state and account. */
function syncConnection(enabled: boolean, accountEpoch: number): void {
  const key = enabled ? `on:${accountEpoch}` : 'off';
  if (connectedFor === key) return;
  connectedFor = key;
  if (enabled) connectCloudCowork();
  else cloudCoworkStore.getState().disconnect('disabled');
}

export function useCloudCoworkSidebar(): CloudCoworkSidebarModel {
  const enabled = useCanopyDesktopCloudChatsEnabled();
  const accountEpoch = useWorkspaceContextStore((s) => s.accountEpoch);
  const context = useWorkspaceContext();
  const collapsed = useCloudProjectCollapse((s) => s.collapsed);
  const toggleCollapsed = useCloudProjectCollapse((s) => s.toggle);
  const { status, projects, tasksByProject } = useStore(
    cloudCoworkStore,
    useShallow((s) => ({
      status: s.status,
      projects: s.projects,
      tasksByProject: s.tasksByProject,
    })),
  );

  useEffect(() => {
    mountedHosts += 1;
    syncConnection(enabled, accountEpoch);
    return (): void => {
      mountedHosts -= 1;
      if (mountedHosts === 0) {
        connectedFor = null;
        cloudCoworkStore.getState().disconnect('disabled');
      }
    };
  }, [enabled, accountEpoch]);

  const reconnect = useCallback((): void => {
    // An expired web session remints only on this user action (in main).
    void window.api.cloudChats
      .reconnect()
      .then((result) => {
        if (result.ok) connectCloudCowork();
      })
      .catch((error: unknown) => {
        reportClientAppError(error);
      });
  }, []);
  const createTask = useCallback(
    (workspaceId: string, open: (chatKey: string) => void): void => {
      void cloudCoworkStore
        .getState()
        .createTask(workspaceId)
        .then((task) => open(cloudChatKey(task.worktreeId)))
        .catch((error: unknown) => {
          reportClientAppError(error);
        });
    },
    [],
  );

  if (!enabled || status === 'disabled') return { status: 'disabled' };
  if (status === 'offline') return { status: 'offline', reconnect };
  return {
    status: 'online',
    projects: cloudProjectsForContext(
      projects,
      tasksByProject,
      context,
      collapsed,
    ),
    toggleCollapsed,
    createTask,
    openCloudChat,
  };
}
