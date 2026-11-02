import { Button } from '@canopy/ui-shared/components';
import type { JSX, ReactNode } from 'react';
import { ErrorBanner, LoadingPlaceholder } from '../shared/StatusBlocks';

export interface EntityEditModalFooterProps {
  isCreate: boolean;
  saving: boolean;
  canSave: boolean;
  confirmDelete: boolean;
  onConfirmDeleteStart: () => void;
  onConfirmDeleteCancel: () => void;
  onDelete: () => void;
  onClose: () => void;
  onSave: () => void;
}

interface EntityEditModalContentProps {
  loading: boolean;
  error: string;
  bodyClassName?: string;
  footerProps: EntityEditModalFooterProps;
  children: ReactNode;
}

export function EntityEditModalContent({
  loading,
  error,
  bodyClassName = 'flex flex-1 min-h-0 flex-col gap-4 px-5 pb-5',
  footerProps,
  children,
}: EntityEditModalContentProps): JSX.Element {
  return (
    <>
      <div className={bodyClassName}>
        {loading && <LoadingPlaceholder />}

        {!loading && children}

        <ErrorBanner error={error} />
      </div>

      {!loading && <EntityEditModalFooter {...footerProps} />}
    </>
  );
}

export function EntityEditModalFooter({
  isCreate,
  saving,
  canSave,
  confirmDelete,
  onConfirmDeleteStart,
  onConfirmDeleteCancel,
  onDelete,
  onClose,
  onSave,
}: EntityEditModalFooterProps): JSX.Element {
  return (
    <div className="flex items-center justify-between border-t px-5 py-3">
      <div>
        {!isCreate && !confirmDelete && (
          <Button
            variant="ghost-destructive"
            size="compact"
            onClick={onConfirmDeleteStart}
            disabled={saving}
          >
            Delete
          </Button>
        )}
        {!isCreate && confirmDelete && (
          <span className="inline-flex items-center gap-2">
            <span className="text-xs fg-secondary">Are you sure?</span>
            <Button
              variant="destructive"
              size="compact"
              onClick={onDelete}
              disabled={saving}
            >
              Confirm
            </Button>
            <Button size="compact" onClick={onConfirmDeleteCancel}>
              Cancel
            </Button>
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button size="compact" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="compact"
          onClick={onSave}
          disabled={!canSave}
        >
          {saving ? 'Saving\u2026' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
