import { useEffect, useRef, useState, type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import { DropdownMenuSurface } from '@canopy/ui-shared';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
  type ActionMenuItem,
} from '@canopy/ui-shared/components';
import { ChevronDownIcon } from '@canopy/ui-shared/icons';
import { GitCommitIcon } from '@canopy/ui-shared/icons/AppIcons';
import { DialogModal } from '@/components/shared/DialogModal';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  type BranchFromChoice,
  useBranchFromStore,
} from '@/stores/branchFromStore';

/**
 * The two ways to continue are variants of one choice (what happens to the
 * uncommitted changes), so they share one icon and only the first shows it.
 */
const CONTINUE_MENU_ITEMS: readonly ActionMenuItem<BranchFromChoice>[] = [
  { key: 'commit-first', label: 'Commit first', icon: <GitCommitIcon /> },
  { key: 'do-not-commit', label: 'Do not commit', icon: <GitCommitIcon /> },
];

export function BranchFromConfirmationModalHost(): JSX.Element | null {
  const pending = useBranchFromStore(useShallow((state) => state.pending));
  const resolveConfirmation = useBranchFromStore(
    (state) => state.resolveConfirmation,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMenuOpen(false);
  }, [pending]);

  useCurrentUiStateReporter(
    'worktree.branchFromModal',
    pending
      ? {
          open: true,
          confirmationId: pending.confirmationId,
          projectId: pending.projectId,
          worktreeId: pending.worktreeId,
          menuOpen,
        }
      : null,
  );

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (
        !(event.target instanceof Node) ||
        !menuRef.current?.contains(event.target)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return (): void => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
    };
  }, [menuOpen]);

  if (!pending) return null;

  const choose = (choice: BranchFromChoice): void => {
    setMenuOpen(false);
    resolveConfirmation(choice);
  };

  return (
    <DialogModal
      onClose={() => resolveConfirmation(null)}
      title="Uncommitted changes won't be carried over"
      maxWidth="md"
      dataTestId="branch-from-uncommitted-warning"
    >
      <div className="flex flex-col gap-4 px-5 pb-5">
        <p className="text-s fg-secondary">
          This worktree has uncommitted changes. They will remain here and will
          not be included in the new worktree unless you commit them first.
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => resolveConfirmation(null)}
            className="focus-ring rounded-md border bg-secondary px-3 py-1.5 text-xs font-medium fg-primary transition hover:bg-secondary/80"
          >
            Cancel
          </button>
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="focus-ring flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium fg-emphasis transition hover:bg-accent/90"
            >
              Continue
              <ChevronDownIcon
                width={12}
                height={12}
                aria-hidden="true"
                className={menuOpen ? 'rotate-180 transition' : 'transition'}
              />
            </button>
            {menuOpen && (
              <DropdownMenuSurface
                role="menu"
                className="absolute bottom-full right-0 z-dropdown mb-1 w-40"
              >
                <ActionMenuRowStyle>
                  <ActionMenuItems
                    items={CONTINUE_MENU_ITEMS}
                    onSelect={(item): void => choose(item.key)}
                  />
                </ActionMenuRowStyle>
              </DropdownMenuSurface>
            )}
          </div>
        </div>
      </div>
    </DialogModal>
  );
}
