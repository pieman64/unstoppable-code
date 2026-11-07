import { useCallback, useId, useRef, useState, type JSX } from 'react';
import {
  COMPOSER_ROW_MENU_GAP,
  FLOATING_PICKER_GAP,
  FloatingMenu,
  PickerTrigger,
  DirectoryPickerOptionRow,
  RichHoverTooltip,
} from '@canopy/ui-shared';
import {
  ChevronDownMediumIcon,
  FolderIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { DirectoryPickerHeading } from '@canopy/ui-app';
import {
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
} from '@canopy/desktop-shared/types';
import { ComposerIconButton } from '../shared/ComposerIconButton';

export interface DirectoryPickerOption {
  id: string;
  name: string;
}

interface DirectoryPickerProps {
  /**
   * Currently selected repo id. `undefined` is equivalent to
   * `WORKSPACE_ROOT_REPO_ID` and renders as "Project root".
   */
  currentRepoId: string | undefined;
  /** Child repos in the workspace (workspace root is added automatically). */
  childRepos: DirectoryPickerOption[];
  /** Locked once a session has started — picker becomes a non-interactive label. */
  disabled?: boolean;
  /**
   * When true, the picker is disabled because the chat session has started and
   * the cwd is bound to the live session. Surface a lock explanation in the
   * tooltip so the user knows a new chat is required to change it.
   */
  sessionLocked?: boolean;
  hideLabel?: boolean;
  /** Uses the shared composer control geometry. */
  capsule?: boolean;
  /**
   * Sits in the settings row under the chat composer, beside effort: the
   * row's chevronless trigger (folder glyph, then the name, which truncates
   * as the row narrows) and its menu over the trigger. Wins over `capsule`
   * and `hideLabel`.
   */
  statusRow?: boolean;
  onSelect: (repoId: string | undefined) => void;
}

export function DirectoryPicker({
  currentRepoId,
  childRepos,
  disabled = false,
  sessionLocked = false,
  hideLabel = false,
  capsule = false,
  statusRow = false,
  onSelect,
}: DirectoryPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);

  const effectiveId = currentRepoId ?? WORKSPACE_ROOT_REPO_ID;
  const currentName =
    effectiveId === WORKSPACE_ROOT_REPO_ID
      ? WORKSPACE_ROOT_REPO_NAME
      : (childRepos.find((repo) => repo.id === effectiveId)?.name ??
        effectiveId);

  const handleSelect = useCallback(
    (repoId: string): void => {
      onSelect(repoId === WORKSPACE_ROOT_REPO_ID ? undefined : repoId);
      setOpen(false);
    },
    [onSelect],
  );

  const tooltipContent = (
    <>
      <p className="text-xs font-medium fg-primary">Working directory</p>
      <p className="mt-1 text-xs fg-secondary">
        The chat session runs in{' '}
        <span className="fg-primary">{currentName}</span>. It can affect which
        project-based agent commands and skills are discovered.
      </p>
      {sessionLocked && (
        <p className="mt-2 text-xs fg-secondary">
          Locked while this session is active — start a new chat to change it.
        </p>
      )}
    </>
  );

  const legacyTriggerClass = disabled
    ? 'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs fg-secondary/70 cursor-not-allowed'
    : 'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs fg-secondary transition-colors hover:bg-subtle hover:fg-primary';

  const triggerContents = (
    <>
      <FolderIcon size="sm" />
      {!hideLabel && <span className="truncate">{currentName}</span>}
      {!disabled && (
        <ChevronDownMediumIcon size="sm" className={capsule ? '' : 'ml-0.5'} />
      )}
    </>
  );

  const triggerProps = {
    onClick: (): void => {
      if (disabled) return;
      setOpen((prev) => !prev);
    },
    disabled,
    'aria-label': `Select working directory, current ${currentName}`,
    'aria-haspopup': 'listbox' as const,
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
  };

  return (
    <div className={statusRow ? 'relative min-w-0' : 'relative'}>
      {/* On the tooltip layer, so composer toolbars that clip overflow
          cannot cut it off; hidden while the menu is open. */}
      <RichHoverTooltip
        content={tooltipContent}
        suppressed={open}
        surfacePadding="card"
        surfaceClassName="w-64"
        triggerWrapperClassName={statusRow ? 'min-w-0 max-w-full' : ''}
      >
        {statusRow ? (
          <PickerTrigger
            ref={triggerRef}
            data-testid="chat-directory-picker"
            textTrail
            className="max-w-full"
            {...triggerProps}
          >
            {/* The model picker's glyph: secondary ink, 6px before the name. */}
            <FolderIcon size="sm" className="mr-0.5 shrink-0 fg-secondary" />
            <span className="min-w-0 truncate fg-primary">{currentName}</span>
          </PickerTrigger>
        ) : capsule ? (
          <ComposerIconButton
            ref={triggerRef}
            capsule
            wide={hideLabel}
            autoWidth={!hideLabel}
            className={hideLabel ? undefined : 'max-w-48'}
            {...triggerProps}
          >
            {triggerContents}
          </ComposerIconButton>
        ) : (
          <button
            ref={triggerRef}
            type="button"
            className={legacyTriggerClass}
            {...triggerProps}
          >
            {triggerContents}
          </button>
        )}
      </RichHoverTooltip>

      <FloatingMenu
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="top-left"
        // In the settings row it opens 4px over its trigger, 8px left of the
        // trigger's edge, like the effort panel beside it.
        {...(statusRow
          ? { gap: COMPOSER_ROW_MENU_GAP, alignOffset: -8 }
          : { gap: FLOATING_PICKER_GAP })}
        heightLimit={224}
        interaction="listbox"
        role="listbox"
        aria-label="Working directory options"
        data-testid="chat-directory-menu"
        className="w-56"
      >
        <DirectoryGroup
          currentId={effectiveId}
          options={[
            { id: WORKSPACE_ROOT_REPO_ID, name: WORKSPACE_ROOT_REPO_NAME },
            ...childRepos,
          ]}
          onSelect={handleSelect}
        />
      </FloatingMenu>
    </div>
  );
}

function DirectoryGroup({
  currentId,
  options,
  onSelect,
}: {
  currentId: string;
  options: DirectoryPickerOption[];
  onSelect: (repoId: string) => void;
}): JSX.Element {
  return (
    <div>
      <DirectoryPickerHeading />
      {options.map((option) => (
        <DirectoryPickerOptionRow
          key={option.id}
          name={option.name}
          selected={option.id === currentId}
          onSelect={(): void => {
            onSelect(option.id);
          }}
        />
      ))}
    </div>
  );
}
