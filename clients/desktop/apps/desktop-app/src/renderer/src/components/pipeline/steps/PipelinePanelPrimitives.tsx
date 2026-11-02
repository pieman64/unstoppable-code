import type { JSX, ReactNode } from 'react';
import { Button } from '@canopy/ui-shared/components';
import {
  DragHandleIcon as AppCatalogDragHandleIcon,
  CloseIcon as AppCatalogCloseIcon,
} from '@canopy/ui-shared/icons/AppIcons';

export function PipelineDragHandleIcon(): JSX.Element {
  return <AppCatalogDragHandleIcon width="14" height="14" />;
}

export function PipelineDetailPanelShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="h-full flex flex-col bg-card">
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <span className="text-s font-medium fg-primary truncate">{title}</span>
        <Button
          variant="ghost"
          size="compact"
          iconOnly
          onClick={onClose}
          aria-label="Close"
        >
          <AppCatalogCloseIcon width="16" height="16" />
        </Button>
      </div>

      <div className="flex-1 overflow-auto px-4 py-4 space-y-5">{children}</div>
    </div>
  );
}
