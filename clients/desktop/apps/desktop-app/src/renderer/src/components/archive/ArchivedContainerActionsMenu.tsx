import { useState, type JSX } from 'react';
import type { ArchivedContainerSummary } from '@canopy/desktop-shared/types';
import { ArchivedRowActionsMenu } from '@canopy/ui-shared/components';
import { DeleteConfirmModal } from '@/components/shared/DeleteConfirmModal';
import { getArchivedContainerState } from '@/lib/archivedContainerDisplay';
import { useArchivedContainerActions } from './useArchivedContainerActions';

export interface ArchivedContainerActionsMenuProps {
  summary: ArchivedContainerSummary;
  testIdPrefix: string;
  /**
   * Extra classes for the trigger. The shared menu defaults to the
   * wide-container always-visible set; hosts without room can override.
   */
  triggerClassName?: string;
}

/**
 * Desktop host for the shared archived-row ⋯ menu (overview rows). Wires the
 * per-container lifecycle actions and owns the permanent-delete confirmation
 * the shared menu only announces.
 */
export function ArchivedContainerActionsMenu({
  summary,
  testIdPrefix,
  triggerClassName,
}: ArchivedContainerActionsMenuProps): JSX.Element {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const archived = getArchivedContainerState(summary) === 'archived';
  const actions = useArchivedContainerActions(
    summary.projectId,
    summary.id,
    archived,
  );
  const busy = actions.changingState || actions.restoring || actions.deleting;

  return (
    <>
      <ArchivedRowActionsMenu
        itemName={summary.name}
        archived={archived}
        busy={busy}
        onRestore={() => void actions.restore()}
        onToggleState={() => void actions.setArchived(!archived)}
        onDeletePermanently={() => setConfirmingDelete(true)}
        testIdPrefix={testIdPrefix}
        {...(triggerClassName !== undefined ? { triggerClassName } : {})}
      />
      {confirmingDelete && (
        <DeleteConfirmModal
          title="Delete permanently?"
          message={
            <p className="text-s fg-secondary">
              Delete{' '}
              <span className="font-medium fg-primary">{summary.name}</span>?
              This permanently removes its chats and retained history and cannot
              be undone.
            </p>
          }
          confirmLabel="Delete permanently"
          pendingLabel="Deleting…"
          pending={actions.deleting}
          dataTestId={`${testIdPrefix}-delete-confirmation`}
          confirmTestId={`${testIdPrefix}-delete-confirm`}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => void actions.deletePermanently()}
        />
      )}
    </>
  );
}
