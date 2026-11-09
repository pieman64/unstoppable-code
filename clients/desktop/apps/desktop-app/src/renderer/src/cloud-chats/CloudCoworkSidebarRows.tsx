import type { JSX } from 'react';
import { Cloud } from '@canopy/ui-shared/icons/AppIcons';
import {
  Button,
  ListRowStatic,
  SidebarFadePresence,
  WorkEntryRow,
  WorkspaceSectionHeader,
} from '@canopy/ui-shared/components';
import {
  useCloudCoworkSidebar,
  type CloudCoworkSidebarProject,
} from './useCloudCoworkSidebar';

function CloudCoworkProjectRow({
  project,
  onToggleCollapsed,
  onCreateTask,
  onOpenCloudChat,
}: {
  project: CloudCoworkSidebarProject;
  onToggleCollapsed: (projectKey: string) => void;
  onCreateTask: (workspaceId: string, open: (chatKey: string) => void) => void;
  onOpenCloudChat: (chatKey: string) => void;
}): JSX.Element {
  const { collapsed } = project;
  const testId = `sidebar-cloud-cowork-project-${project.workspaceId}`;
  return (
    <div className="mb-px" data-testid={testId}>
      <WorkspaceSectionHeader
        dataTestId={`${testId}-header`}
        name={project.name}
        colorHex={project.color}
        workspaceType="cowork"
        // The cloud marker: the shared header's backend pip.
        backend="cloud"
        worktreeCount={project.entries.length}
        countPresentation="hidden"
        textScale="sidebar"
        deferHoverActions
        canToggleCollapse
        inlineCollapseChevron
        showCollapseChevron={false}
        disableDrag
        collapsed={collapsed}
        onToggleCollapse={(): void => onToggleCollapsed(project.key)}
        onAdd={(): void => onCreateTask(project.workspaceId, onOpenCloudChat)}
      />
      {project.entries.length > 0 && (
        <SidebarFadePresence open={!collapsed} className="mt-px">
          <div className="flex flex-col gap-px">
            {project.entries.map((entry) => (
              <WorkEntryRow
                key={entry.key}
                title={entry.title}
                testId={`sidebar-cloud-cowork-entry-${entry.worktreeId}`}
                entryId={entry.key}
                working={entry.working}
                hasPendingQuestion={entry.hasPendingQuestion}
                onOpen={(): void => onOpenCloudChat(entry.chatKey)}
              />
            ))}
          </div>
        </SidebarFadePresence>
      )}
    </div>
  );
}

/**
 * Cloud cowork projects beside the local ones (CAN-4185), or one offline
 * row. Nothing renders while the flag is off. Rows come only from the cloud
 * cowork store, so no cloud id reaches a local store or IPC call.
 */
export function CloudCoworkSidebarRows({
  onOpenCloudChat,
}: {
  /** Defaults to the hook's handler until the cloud chat panel lands (CAN-5966). */
  onOpenCloudChat?: (chatKey: string) => void;
} = {}): JSX.Element | null {
  const model = useCloudCoworkSidebar();
  if (model.status === 'disabled') return null;
  if (model.status === 'offline')
    return (
      <ListRowStatic
        data-testid="sidebar-cloud-cowork-offline"
        icon={<Cloud />}
        description={
          <Button
            variant="link"
            onClick={model.reconnect}
            data-testid="sidebar-cloud-cowork-reconnect"
          >
            Reconnect
          </Button>
        }
      >
        Cloud chats are offline
      </ListRowStatic>
    );
  return (
    <div data-testid="sidebar-cloud-cowork">
      {model.projects.map((project) => (
        <CloudCoworkProjectRow
          key={project.key}
          project={project}
          onToggleCollapsed={model.toggleCollapsed}
          onCreateTask={model.createTask}
          onOpenCloudChat={onOpenCloudChat ?? model.openCloudChat}
        />
      ))}
    </div>
  );
}
