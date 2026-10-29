import type { JSX } from 'react';
import { CognitionIcon } from '@canopy/ui-shared/icons/AppIcons';
import { MemoryExplorer } from '@/components/memory/MemoryExplorer';
import {
  PanelSection,
  useActivitySectionChrome,
} from '@/components/shared/panel-section';
import type { ActivitySectionRenderProps } from './activity-sections';

export function MemorySection({
  projectId,
  onEmptyChange,
}: ActivitySectionRenderProps & {
  onEmptyChange?: (empty: boolean) => void;
}): JSX.Element {
  const chrome = useActivitySectionChrome();
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
        <MemoryExplorer
          scope="workspace"
          projectId={projectId}
          hideWhenEmpty={onEmptyChange !== undefined}
          onEmptyChange={onEmptyChange}
        />
      </div>
    </PanelSection>
  );
}
