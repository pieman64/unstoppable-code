import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import {
  Button,
  FloatingPickerMenu,
  PickerMenuFooter,
  PickerMenuList,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionLabel,
  PickerMenuOptionLeading,
  PickerMenuSearchHeader,
  PickerMenuSearchInput,
  PickerMenuState,
  PickerTrigger,
  PickerTriggerChevron,
  Tooltip,
  type WorkspaceKind,
} from '@canopy/ui-shared/components';
import {
  scrollPickerOptionIntoView,
  usePickerActiveScrollIntent,
} from '@canopy/ui-shared/lib';
import {
  ClearFilledIcon,
  PlusMediumIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { ProjectIcon } from './ProjectIcon';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

function getWorkspaceKind(item: SidebarItem): WorkspaceKind {
  if (item.type === 'multi-repo') return 'multi-repo';
  if (item.type === 'cowork') return 'cowork';
  return 'single-repo';
}

interface WorkspaceSwatchProps {
  item: SidebarItem;
}

function WorkspaceSwatch({ item }: WorkspaceSwatchProps): JSX.Element {
  const isTemporaryMultiRepo =
    item.type === 'multi-repo' && item.temporary === true;
  return (
    <ProjectIcon
      kind={getWorkspaceKind(item)}
      temporary={isTemporaryMultiRepo}
      color={item.color}
      repoPath={item.type === 'single-repo' ? item.repoPath : undefined}
    />
  );
}

export interface WorkspaceDropdownProps {
  workspaces: SidebarItem[];
  selectedWorkspaceId: string;
  onSelect: (workspaceId: string) => void;
  /**
   * Renders a trailing "New project" row below the workspace list when
   * provided. Omit to keep the dropdown as a plain workspace picker.
   */
  onAddWorkspace?: () => void;
  /** Label for the trailing add-workspace row. Defaults to `New project`. */
  addWorkspaceLabel?: string;
  /**
   * A project that does not exist yet but is the proposed destination, such
   * as a repository a pasted link would add. The trigger shows it with the
   * add-workspace row's label and icon, and that row reads as selected.
   * Display only: it never calls `onSelect`. Ignored while
   * `selectedWorkspaceId` names a workspace.
   */
  pendingWorkspace?: { title: string };
  /**
   * Prefix used to build stable `data-testid` hooks. Defaults to
   * `workspace-dropdown`; pass a call-site-specific prefix (e.g.
   * `home-workspace`) to preserve existing test ids.
   */
  testIdPrefix?: string;
  /**
   * Workspaces that stay selectable-by-value but are never offered as rows.
   *
   * The Home composer passes the default cowork workspace: it is a real
   * project and remains the resting destination for a chat with no project
   * context, but the sidebar presents it as the top-level Chats section
   * rather than a project, so offering it here invited people to "file" a
   * chat somewhere they then could not find (CAN-2363 follow-up).
   *
   * They are deliberately left in `workspaces` so the trigger can still name
   * the current selection — dropping them from that list entirely would send
   * the label through the `workspaces[0]` fallback and quietly show the
   * wrong project.
   */
  unlistedWorkspaceIds?: readonly string[];
  /**
   * Renders an unmatched `selectedWorkspaceId` as the placeholder instead of
   * falling back to the first workspace. Purely a display concern: callers
   * that want the trigger to read as "nothing chosen" pass an empty id plus
   * this flag, and keep whatever real id they like in their own state.
   */
  allowUnset?: boolean;
  /**
   * Renders a clear affordance over the trigger's leading swatch, revealed on
   * hover or focus. The dropdown only draws and reports it — the caller
   * decides what "cleared" selects, and omits this entirely when the current
   * selection has nothing to clear back to.
   */
  onClear?: () => void;
  /** Placeholder shown when no workspace is selected. */
  placeholder?: string;
  /** Placeholder shown in the typeahead search input. */
  searchPlaceholder?: string;
  /** Uses the borderless 32px capsule geometry shared by composer controls. */
  capsule?: boolean;
  /**
   * Increment to open the dropdown imperatively — the ⌥W keyboard shortcut
   * entry point (ECW-7984 follow-up). The value seen on mount is ignored, so
   * the picker never springs open on first render; only later changes open
   * it. Opening focuses the search input, from which ↑/↓ walk the list.
   */
  openSignal?: number;
  /**
   * Where keyboard focus goes once the picker closes, for both commit and
   * dismiss (ECW-7984 follow-up). Callers opened from a composer pass a
   * focus-the-composer callback so a ⌥W round trip returns the caret to the
   * prompt the user was writing. Omit it to keep the default combobox
   * behavior of restoring focus to the trigger button.
   */
  onRestoreFocus?: () => void;
}

/**
 * Shared workspace picker dropdown: a button showing the selected
 * workspace's kind badge + display name, expanding into a listbox of every
 * passed-in workspace. Originally extracted from the old Create Task modal,
 * which only ever passed eligible code workspaces; callers that want to
 * include cowork workspaces (e.g. the Home composer) can pass the full
 * sidebar list since {@link ProjectIcon} and
 * {@link getWorkspaceDisplayName} both already handle every
 * {@link SidebarItem} variant.
 */
export function WorkspaceDropdown({
  workspaces,
  selectedWorkspaceId,
  unlistedWorkspaceIds,
  allowUnset = false,
  onClear,
  onSelect,
  onAddWorkspace,
  addWorkspaceLabel = 'New project',
  pendingWorkspace,
  testIdPrefix = 'workspace-dropdown',
  placeholder = 'Select a project',
  searchPlaceholder = 'Search projects…',
  capsule = false,
  openSignal,
  onRestoreFocus,
}: WorkspaceDropdownProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState<number | null>(0);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const popupId = useId();
  const {
    markActiveOptionScrollIntent,
    clearActiveOptionScrollIntent,
    consumeActiveOptionScrollIntent,
  } = usePickerActiveScrollIntent();

  const matched = workspaces.find((w) => w.id === selectedWorkspaceId);
  // The first-workspace fallback serves callers that always carry a concrete
  // id; it must not fire where an empty id deliberately means "unchosen".
  const selected = allowUnset ? matched : (matched ?? workspaces[0]);
  const selectedDisplayName = selected
    ? getWorkspaceDisplayName(selected)
    : 'Untitled project';
  const pending = selected === undefined ? pendingWorkspace : undefined;

  // Selection above resolves against every workspace; only the offered rows
  // are narrowed, so an unlisted current selection still reads correctly.
  const listedWorkspaces = useMemo(
    () =>
      unlistedWorkspaceIds === undefined || unlistedWorkspaceIds.length === 0
        ? workspaces
        : workspaces.filter(
            (workspace) => !unlistedWorkspaceIds.includes(workspace.id),
          ),
    [workspaces, unlistedWorkspaceIds],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return listedWorkspaces;
    return listedWorkspaces.filter((workspace) =>
      getWorkspaceDisplayName(workspace).toLowerCase().includes(needle),
    );
  }, [listedWorkspaces, query]);

  const activeWorkspace =
    activeIndex === null ? undefined : filtered[activeIndex];

  // Imperative open (⌥W). Seeded with the mount-time value so the first
  // render never counts as a request; every later change opens the picker.
  const lastOpenSignalRef = useRef(openSignal);
  useEffect(() => {
    if (openSignal === undefined || openSignal === lastOpenSignalRef.current) {
      return;
    }
    lastOpenSignalRef.current = openSignal;
    setIsOpen(true);
  }, [openSignal]);

  // Reset the typeahead each time the picker opens, start the active row on
  // the current selection, and focus the search input.
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    const selectedIndex = listedWorkspaces.findIndex(
      (w) => w.id === selectedWorkspaceId,
    );
    // Target the restored row: this effect and the scroll effect below are
    // flushed together, so an untargeted intent would be consumed against the
    // stale `activeIndex` of 0 and the selected workspace would never scroll.
    markActiveOptionScrollIntent(
      selectedIndex >= 0 ? listedWorkspaces[selectedIndex]?.id : undefined,
    );
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    searchRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open-time snapshot only
  }, [isOpen, markActiveOptionScrollIntent]);

  // Keep the active row visible as the user arrows past the scroll edges.
  useEffect(() => {
    if (!isOpen || !activeWorkspace) return;
    if (!consumeActiveOptionScrollIntent(activeWorkspace.id)) return;
    scrollPickerOptionIntoView(
      listRef.current,
      activeWorkspace.id,
      'data-option-id',
    );
  }, [isOpen, activeWorkspace, consumeActiveOptionScrollIntent]);

  function openPicker(): void {
    setIsOpen(true);
  }

  function closePicker(focusButton = true): void {
    setIsOpen(false);
    if (onRestoreFocus) {
      onRestoreFocus();
      return;
    }
    if (focusButton) {
      buttonRef.current?.focus();
    }
  }

  /**
   * Escape dismissal returns focus to the trigger (standard combobox
   * behavior) and deliberately skips `onRestoreFocus` — the composer-restore
   * hook is for committed selections, and racing it against the trigger
   * focus made the Escape outcome timing-dependent.
   */
  function closePickerToTrigger(): void {
    setIsOpen(false);
    buttonRef.current?.focus();
  }

  function handleButtonKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'Escape' && isOpen) {
      event.preventDefault();
      closePickerToTrigger();
      return;
    }
    if (!isOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      openPicker();
    }
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePickerToTrigger();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (filtered.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      markActiveOptionScrollIntent();
      setActiveIndex((index) => {
        const currentIndex = index ?? (delta > 0 ? -1 : 0);
        return (currentIndex + delta + filtered.length) % filtered.length;
      });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (activeWorkspace) {
        handleSelect(activeWorkspace.id);
      }
    }
  }

  function handleSearchChange(value: string): void {
    setQuery(value);
    setActiveIndex(0);
  }

  function handleSelect(workspaceId: string): void {
    onSelect(workspaceId);
    closePicker();
  }

  function handleClear(event: MouseEvent<HTMLButtonElement>): void {
    // The clear control sits over the trigger, not inside it (a button may
    // not nest a button), so it must not also open the menu.
    event.stopPropagation();
    setIsOpen(false);
    onClear?.();
    // Clearing unmounts this very button (the caller's selection stops being
    // clearable), so focus would fall to `document.body`. Selections avoid
    // that by routing through `closePicker`; mirror it here or a keyboard
    // user loses the composer caret.
    if (onRestoreFocus) onRestoreFocus();
    else buttonRef.current?.focus();
  }

  function handleAddWorkspace(): void {
    setIsOpen(false);
    onAddWorkspace?.();
  }

  const clearable = onClear !== undefined && selected !== undefined;

  return (
    <div className="group/picker-trigger relative">
      <PickerTrigger
        ref={buttonRef}
        onClick={() => setIsOpen((open) => !open)}
        onKeyDown={handleButtonKeyDown}
        data-testid={`${testIdPrefix}-select`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? popupId : undefined}
        title={pending?.title}
        data-pending-workspace={pending ? 'true' : undefined}
        variant={capsule ? 'capsule' : 'field'}
        // With no swatch or plus to lead, the placeholder starts the capsule,
        // so it takes the text-first inset the composer's effort chip uses.
        textLead={capsule && !selected && !pending}
        // Pointing at the clear control seated over the swatch keeps the
        // chip's hover surface.
        wrapperHover={clearable}
        className={
          capsule ? 'max-w-52 justify-between' : 'w-full justify-between'
        }
      >
        <span className="flex min-w-0 items-center gap-2">
          {selected ? (
            <>
              <span
                className={
                  clearable
                    ? // Yields to the clear control that sits on top of it —
                      // on a coarse pointer that control is always shown, so
                      // the swatch stays hidden there rather than waiting for
                      // a hover that never comes.
                      'inline-flex pointer-coarse:opacity-0 pointer-fine:group-hover/picker-trigger:opacity-0 pointer-fine:group-focus-within/picker-trigger:opacity-0'
                    : 'inline-flex'
                }
              >
                <WorkspaceSwatch item={selected} />
              </span>
              <span
                className={`${POSTHOG_REPLAY_MASK_CLASS} truncate fg-primary`}
              >
                {selectedDisplayName}
              </span>
            </>
          ) : pending ? (
            <>
              <PlusMediumIcon size="sm" aria-hidden />
              <span className="truncate fg-primary">{addWorkspaceLabel}</span>
            </>
          ) : (
            <span className="fg-tertiary">{placeholder}</span>
          )}
        </span>
        <PickerTriggerChevron
          open={isOpen}
          variant={capsule ? 'capsule' : 'field'}
        />
      </PickerTrigger>

      {clearable && (
        // Centred over the swatch it replaces — the trigger's own horizontal
        // padding, which differs per variant, less half the 12px the 28px
        // button is wider than the 16px swatch. The holder places it and, on
        // a fine pointer, shows it only while the trigger is hovered or
        // focused; the tooltip wraps the button inside. It swaps with the
        // swatch instantly: no fade either way.
        <span
          className={`absolute top-1/2 inline-flex -translate-x-1.5 -translate-y-1/2 pointer-fine:opacity-0 pointer-fine:focus-within:opacity-100 pointer-fine:group-hover/picker-trigger:opacity-100 pointer-fine:group-focus-within/picker-trigger:opacity-100 ${
            capsule ? 'left-2.5' : 'left-2'
          }`}
        >
          <Tooltip
            label={
              <>
                Clear{' '}
                <span className={POSTHOG_REPLAY_MASK_CLASS}>
                  {selectedDisplayName}
                </span>
              </>
            }
            suppressed={isOpen}
          >
            <Button
              variant="ghost-quiet"
              size="sm"
              iconOnly
              onClick={handleClear}
              aria-label={`Clear ${selectedDisplayName}`}
              data-testid={`${testIdPrefix}-clear`}
            >
              <ClearFilledIcon size={16} aria-hidden="true" />
            </Button>
          </Tooltip>
        </span>
      )}

      <FloatingPickerMenu
        id={popupId}
        open={isOpen}
        onOpenChange={setIsOpen}
        anchorRef={buttonRef}
        placement="bottom-left"
        minimumWidth="18.5rem"
        maximumWidth="20.5rem"
        heightLimit={296}
        initialFocusRef={searchRef}
        role="dialog"
        aria-label="Choose project"
        data-testid={`${testIdPrefix}-popover`}
      >
        <PickerMenuSearchHeader>
          <PickerMenuSearchInput
            ref={searchRef}
            value={query}
            onChange={(event) => handleSearchChange(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={searchPlaceholder}
            data-testid={`${testIdPrefix}-search`}
            aria-label="Search projects"
            aria-controls={`${testIdPrefix}-listbox`}
            aria-activedescendant={
              activeWorkspace
                ? `${testIdPrefix}-option-${activeWorkspace.id}`
                : undefined
            }
          />
        </PickerMenuSearchHeader>

        <PickerMenuList
          ref={listRef}
          id={`${testIdPrefix}-listbox`}
          aria-label="Select project"
        >
          {filtered.length === 0 ? (
            // Nothing listed and nothing searched: "New project" below is the
            // whole menu, so no absence message above it.
            listedWorkspaces.length === 0 && !query.trim() ? null : (
              <PickerMenuState data-testid={`${testIdPrefix}-empty`}>
                No projects match
              </PickerMenuState>
            )
          ) : (
            filtered.map((workspace, index) => {
              const isSelected = workspace.id === selectedWorkspaceId;
              const isActive = index === activeIndex;
              return (
                <PickerMenuOption
                  key={workspace.id}
                  role="option"
                  id={`${testIdPrefix}-option-${workspace.id}`}
                  aria-selected={isSelected}
                  tabIndex={-1}
                  onClick={() => handleSelect(workspace.id)}
                  onMouseEnter={() => {
                    clearActiveOptionScrollIntent();
                    setActiveIndex(index);
                  }}
                  data-option-id={workspace.id}
                  data-testid={`${testIdPrefix}-option-${workspace.id}`}
                  active={isActive}
                  selected={isSelected}
                >
                  <PickerMenuOptionLeading tone="primary">
                    <WorkspaceSwatch item={workspace} />
                  </PickerMenuOptionLeading>
                  <PickerMenuOptionContent>
                    <PickerMenuOptionLabel>
                      <span className={POSTHOG_REPLAY_MASK_CLASS}>
                        {getWorkspaceDisplayName(workspace)}
                      </span>
                    </PickerMenuOptionLabel>
                  </PickerMenuOptionContent>
                  <PickerMenuOptionCheck selected={isSelected} />
                </PickerMenuOption>
              );
            })
          )}
        </PickerMenuList>

        {onAddWorkspace && (
          <PickerMenuFooter>
            <PickerMenuOption
              onClick={handleAddWorkspace}
              onMouseEnter={() => {
                clearActiveOptionScrollIntent();
                setActiveIndex(null);
              }}
              data-testid={`${testIdPrefix}-add`}
              tone="accent"
            >
              <PickerMenuOptionLeading>
                <PlusMediumIcon />
              </PickerMenuOptionLeading>
              <PickerMenuOptionContent>
                <PickerMenuOptionLabel>
                  {addWorkspaceLabel}
                </PickerMenuOptionLabel>
              </PickerMenuOptionContent>
              <PickerMenuOptionCheck selected={pending !== undefined} />
            </PickerMenuOption>
          </PickerMenuFooter>
        )}
      </FloatingPickerMenu>
    </div>
  );
}
