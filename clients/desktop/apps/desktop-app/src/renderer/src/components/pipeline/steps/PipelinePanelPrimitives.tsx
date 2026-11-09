import type { JSX, ReactNode } from 'react';
import { Surface, Button } from '@canopy/ui-shared/components';
import { CloseIcon as AppCatalogCloseIcon } from '@canopy/ui-shared/icons/AppIcons';

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
    <Surface variant="panel" extent="parent" className="flex flex-col">
      <Surface variant="section" boundary="bottom" className="shrink-0">
        <div className="flex items-center justify-between px-4 py-3 shrink-0">
          <span className="text-s font-medium fg-primary truncate">
            {title}
          </span>
          <Button
            variant="ghost"
            size="compact"
            iconOnly
            onClick={onClose}
            aria-label="Close"
          >
            <AppCatalogCloseIcon size="sm" />
          </Button>
        </div>
      </Surface>

      <div className="flex flex-col flex-1 overflow-auto px-4 py-4 gap-5">
        {children}
      </div>
    </Surface>
  );
}
