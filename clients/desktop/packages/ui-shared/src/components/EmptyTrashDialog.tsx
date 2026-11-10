import { Stack } from './Stack';
import type { JSX, ReactNode } from 'react';
import { DialogModal } from './DialogModal';
import { HeaderActionButton } from './HeaderActionButton';
import { ArchivedStateIcon } from '../icons/ArchivedStateIcon';
import { TrashPermanentlyIcon } from '../icons/AppIcons';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';

export interface EmptyTrashItem {
  readonly id: string;
  readonly name: string;
  readonly trailing?: ReactNode;
}
export interface EmptyTrashDialogProps {
  readonly items: readonly EmptyTrashItem[];
  readonly summary?: ReactNode;
  /** Quiet rows retain a supporting hierarchy alongside disk-size metadata. */
  readonly itemTone?: 'default' | 'quiet';
  /** Workspace targets include every child chat and its retained history. */
  readonly includesWorkspaces?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly busy?: boolean;
}

export function EmptyTrashDialog({
  items,
  summary,
  itemTone = 'default',
  includesWorkspaces = false,
  onCancel,
  onConfirm,
  busy = false,
}: EmptyTrashDialogProps): JSX.Element {
  const count = items.length;
  const itemWord = count === 1 ? 'item' : 'items';
  return (
    <DialogModal
      onClose={busy ? (): void => undefined : onCancel}
      closeOnEscape={!busy}
      closeOnBackdrop={!busy}
      title="Empty trash?"
      titleId="archived-overview-empty-trash-title"
      maxWidth="sm"
      headerBorder={false}
      dataTestId="archived-overview-empty-trash-dialog"
    >
      <Stack gap="group">
        <p className="text-s fg-secondary">
          This permanently deletes {count} deleted {itemWord} and cannot be
          undone.{' '}
          {includesWorkspaces
            ? 'Selected workspaces include all their chats and retained history, including archived chats. Archived items outside those workspaces are not affected.'
            : 'Archived items are not affected.'}
        </p>
        <div
          className="max-h-56 grid grid-cols-1 content-start gap-0.5 overflow-y-auto rounded-md p-1 ring-1 ring-inset ring-line-base"
          data-testid="archived-overview-empty-trash-list"
        >
          {items.map((item) => (
            <div
              key={item.id}
              data-testid={`archived-overview-empty-trash-item-${item.id}`}
              className={`flex items-center gap-2 rounded px-2 py-1 text-xs ${itemTone === 'quiet' ? 'fg-primary/80' : 'fg-primary'}`}
            >
              <ArchivedStateIcon state="deleted" size="sm" />
              <span className={`${REPLAY_MASK_CLASS} min-w-0 flex-1 truncate`}>
                {item.name}
              </span>
              {item.trailing}
            </div>
          ))}
        </div>
        {summary}
        <div className="flex justify-end gap-2">
          <HeaderActionButton
            tone="neutral"
            onClick={onCancel}
            disabled={busy}
            data-testid="archived-overview-empty-trash-cancel"
          >
            Cancel
          </HeaderActionButton>
          <HeaderActionButton
            tone="destructive"
            onClick={onConfirm}
            disabled={busy || count === 0}
            data-testid="archived-overview-empty-trash-confirm"
          >
            <TrashPermanentlyIcon size="sm" aria-hidden="true" />
            {busy ? 'Deleting…' : `Delete ${count} ${itemWord} permanently`}
          </HeaderActionButton>
        </div>
      </Stack>
    </DialogModal>
  );
}
