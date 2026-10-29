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
          <button
            type="button"
            onClick={onConfirmDeleteStart}
            disabled={saving}
            className="focus-ring rounded-lg px-3 py-1.5 text-xs font-medium fg-destructive hover:bg-destructive-subtle transition-colors disabled:opacity-50"
          >
            Delete
          </button>
        )}
        {!isCreate && confirmDelete && (
          <span className="inline-flex items-center gap-2">
            <span className="text-xs fg-secondary">Are you sure?</span>
            <button
              type="button"
              onClick={onDelete}
              disabled={saving}
              className="focus-ring rounded-lg px-3 py-1.5 text-xs font-medium fg-emphasis bg-destructive hover:bg-destructive/90 transition-colors disabled:opacity-50"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={onConfirmDeleteCancel}
              className="focus-ring rounded-lg px-3 py-1.5 text-xs font-medium fg-secondary hover:fg-primary hover:bg-secondary transition-colors"
            >
              Cancel
            </button>
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onClose}
          className="focus-ring rounded-lg px-4 py-2 text-s font-medium fg-secondary hover:fg-primary hover:bg-secondary transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave}
          className="focus-ring inline-flex items-center rounded-lg bg-accent px-4 py-2 text-s font-medium fg-emphasis disabled:opacity-60"
        >
          {saving ? 'Saving\u2026' : 'Save'}
        </button>
      </div>
    </div>
  );
}
