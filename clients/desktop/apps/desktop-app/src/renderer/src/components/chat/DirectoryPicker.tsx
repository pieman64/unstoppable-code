import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import { createPortal } from 'react-dom';
import {
  COMPOSER_ROW_MENU_GAP,
  FLOATING_PICKER_GAP,
  FloatingMenu,
  PickerTrigger,
} from '@canopy/ui-shared';
import {
  CheckIcon,
  ChevronDownMediumIcon,
  FolderIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { getDocument, getWindow } from '@canopy/ui-shared/panels';
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

const TOOLTIP_WIDTH = 256; // w-64
const TOOLTIP_GAP = 6;
const VIEWPORT_PADDING = 8;

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
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const tooltipId = useId();
  const menuId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

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

  // The tooltip lives in a portal because composer toolbar containers clip
  // overflow, which would otherwise clip it.
  useLayoutEffect(() => {
    if (!tooltipVisible || open) {
      setTooltipPosition(null);
      return;
    }
    const anchorEl = containerRef.current;
    if (!anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const tooltipEl = tooltipRef.current;
    const height = tooltipEl ? tooltipEl.offsetHeight : 0;
    const preferredTop = rect.top - TOOLTIP_GAP - height;
    const fallbackTop = rect.bottom + TOOLTIP_GAP;
    const top = preferredTop >= VIEWPORT_PADDING ? preferredTop : fallbackTop;
    const maxLeft = Math.max(
      VIEWPORT_PADDING,
      getWindow(anchorEl).innerWidth - TOOLTIP_WIDTH - VIEWPORT_PADDING,
    );
    const left = Math.min(Math.max(VIEWPORT_PADDING, rect.left), maxLeft);
    setTooltipPosition({ top, left });
  }, [tooltipVisible, open, sessionLocked, currentName]);

  // Hide the tooltip the moment the menu opens.
  useEffect(() => {
    if (open) setTooltipVisible(false);
  }, [open]);

  const legacyTriggerClass = disabled
    ? 'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs fg-secondary/70 cursor-not-allowed'
    : 'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs fg-secondary transition hover:bg-subtle hover:fg-primary';

  const triggerContents = (
    <>
      <FolderIcon width={capsule ? 16 : 13} height={capsule ? 16 : 13} />
      {!hideLabel && <span className="truncate">{currentName}</span>}
      {!disabled && (
        <ChevronDownMediumIcon
          width={capsule ? 12 : 8}
          height={capsule ? 12 : 8}
          className={capsule ? '' : 'ml-0.5'}
        />
      )}
    </>
  );

  const triggerProps = {
    onClick: (): void => {
      if (disabled) return;
      setOpen((prev) => !prev);
    },
    onFocus: (): void => {
      if (!open) setTooltipVisible(true);
    },
    onBlur: (): void => setTooltipVisible(false),
    disabled,
    'aria-label': `Select working directory, current ${currentName}`,
    'aria-haspopup': 'listbox' as const,
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    'aria-describedby': tooltipVisible && !open ? tooltipId : undefined,
  };

  return (
    <div
      ref={containerRef}
      className={statusRow ? 'relative min-w-0' : 'relative'}
      onMouseEnter={() => {
        if (!open) setTooltipVisible(true);
      }}
      onMouseLeave={() => setTooltipVisible(false)}
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
          <FolderIcon
            width={16}
            height={16}
            className="mr-0.5 shrink-0 fg-secondary"
          />
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

      {tooltipVisible &&
        !open &&
        createPortal(
          <div
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            className="pointer-events-none rounded-md bg-popover p-3 shadow-tooltip"
            style={{
              position: 'fixed',
              width: TOOLTIP_WIDTH,
              zIndex: 'var(--z-index-tooltip)',
              ...(tooltipPosition
                ? { top: tooltipPosition.top, left: tooltipPosition.left }
                : { visibility: 'hidden', top: 0, left: 0 }),
            }}
          >
            <p className="text-xs font-medium fg-primary">Working directory</p>
            <p className="mt-1 text-xs fg-secondary">
              The chat session runs in{' '}
              <span className="fg-primary">{currentName}</span>. It can affect
              which project-based agent commands and skills are discovered.
            </p>
            {sessionLocked && (
              <p className="mt-2 text-xs fg-secondary">
                Locked while this session is active — start a new chat to change
                it.
              </p>
            )}
          </div>,
          getDocument(containerRef.current).body,
        )}

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
        <button
          key={option.id}
          type="button"
          role="option"
          aria-selected={option.id === currentId}
          onMouseDown={(e): void => {
            e.preventDefault();
          }}
          onClick={(): void => {
            onSelect(option.id);
          }}
          className="focus-ring flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-s fg-primary/80 transition-colors hover:bg-subtle focus-visible:bg-subtle"
        >
          <span className="w-4 text-center">
            {option.id === currentId ? (
              <CheckIcon width={12} height={12} />
            ) : null}
          </span>
          <span className="truncate">{option.name}</span>
        </button>
      ))}
    </div>
  );
}
