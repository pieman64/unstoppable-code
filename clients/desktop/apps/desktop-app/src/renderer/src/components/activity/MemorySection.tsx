import { useMemo, type JSX } from 'react';
import { isLocalMemoryWorkspaceId } from '@canopy/desktop-shared/lib/local-memory-scope';
import { CognitionIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  MemoryPanel,
  type MemoryPanelScope,
} from '@canopy/ui-app/local-memory';
import {
  USER_MEMORY_SCOPE,
  notifyLocalMemory,
} from '@/client/ipc-local-memory-client';
import {
  PanelSection,
  useActivitySectionChrome,
} from '@/components/shared/panel-section';
import { useDesktopLocalMemoryClient } from '@/hooks/useDesktopLocalMemoryClient';
import { useProjectsStore } from '@/stores/projectsStore';
import type { ActivitySectionRenderProps } from './activity-sections';

export function MemorySection({
  projectId,
  onEmptyChange,
}: ActivitySectionRenderProps & {
  onEmptyChange?: (empty: boolean) => void;
}): JSX.Element {
  const chrome = useActivitySectionChrome();
  const client = useDesktopLocalMemoryClient();
  const project = useProjectsStore((state) =>
    state.projects.find((candidate) => candidate.id === projectId),
  );
  const projectName = project?.name ?? 'This project';
  // Private memory keeps this project's chats away from memories saved for
  // every project, so its panel lists only the project's own.
  const privateMemory = project?.privateMemory === true;
  const scopes = useMemo<MemoryPanelScope[]>(() => {
    if (!isLocalMemoryWorkspaceId(projectId)) return [USER_MEMORY_SCOPE];
    const workspace: MemoryPanelScope = {
      scope: { scope: 'workspace', workspaceId: projectId },
      label: projectName,
      savedFor: projectName,
    };
    return privateMemory ? [workspace] : [USER_MEMORY_SCOPE, workspace];
  }, [projectId, projectName, privateMemory]);
  return (
    <PanelSection icon={<CognitionIcon />} title="Memory" framelessBody="flex">
      <div
        data-testid="workspace-memory-section"
        className={
          chrome === 'frameless'
            ? 'flex min-h-0 flex-1 flex-col'
            : 'flex max-h-120 flex-col'
        }
      >
        <MemoryPanel
          // A different project is a different list: start it fresh.
          key={scopes.length === 2 ? `user+${projectId}` : String(projectId)}
          client={client}
          notify={notifyLocalMemory}
          scopes={scopes}
          showSettingsLink
          hideWhenEmpty={onEmptyChange !== undefined}
          onEmptyChange={onEmptyChange}
        />
      </div>
    </PanelSection>
  );
}
