import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import {
  FloatingPickerMenu,
  PickerMenuList,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionLabel,
  PickerMenuOptionLeading,
  PickerMenuOptionTrailing,
  PickerMenuSearchHeader,
  PickerMenuSearchInput,
  PickerMenuState,
  PickerTrigger,
  PickerTriggerChevron,
} from '@canopy/ui-shared';
import { BranchIcon } from '@canopy/ui-shared/icons/AppIcons';
import type { BranchEntry } from '@canopy/desktop-shared/types';
import {
  collapseBranchDuplicates,
  filterBranchesBySearch,
  findBranchPresence,
  getBranchProvenanceBadge,
  preserveBranchOption,
} from './branch-options';
import { LoadingIndicator } from '@canopy/ui-shared/components';

interface BaseBranchDropdownProps {
  projectId: string;
  worktreeId: string;
  repoId?: string;
  currentValue: string | null | undefined;
  disabled?: boolean;
  onChange: (
    branchName: string,
    presence: { existsLocally: boolean; existsInRemote: boolean },
  ) => void;
}

export function BaseBranchDropdown({
  projectId,
  worktreeId,
  repoId,
  currentValue,
  disabled = false,
  onChange,
}: BaseBranchDropdownProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<BranchEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const menuId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // Load branches when opened
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    window.api
      .listBranches({ projectId, worktreeId, repoId })
      .then((response) => {
        if (!cancelled) {
          setBranches(response.branches);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [open, projectId, worktreeId, repoId]);

  // Focus search when opened
  useEffect(() => {
    if (open) {
      setActiveIndex(0);
      setTimeout(() => searchRef.current?.focus(), 0);
    } else {
      setSearch('');
    }
  }, [open]);

  const collapsed = useMemo(
    () =>
      preserveBranchOption(
        collapseBranchDuplicates(branches),
        currentValue ?? null,
      ),
    [branches, currentValue],
  );

  const filtered = useMemo(
    () => filterBranchesBySearch(collapsed, search),
    [collapsed, search],
  );
  const activeBranch = filtered[activeIndex];

  useEffect(() => {
    setActiveIndex(0);
  }, [search]);

  useEffect(() => {
    if (!open || !activeBranch) return;
    const rows =
      listRef.current?.querySelectorAll<HTMLElement>('[data-branch-name]');
    rows?.forEach((row) => {
      if (row.dataset.branchName === activeBranch.name) {
        row.scrollIntoView?.({ block: 'nearest' });
      }
    });
  }, [activeBranch, open]);

  // Preserve current value even if it doesn't appear in the fetched list
  const displayValue = currentValue ?? 'none';

  const handleSelect = useCallback(
    (branchName: string) => {
      const presence = findBranchPresence(branches, branchName);
      onChange(branchName, {
        existsLocally: presence.hasLocalRef,
        existsInRemote: presence.hasRemoteRef,
      });
      setOpen(false);
      triggerRef.current?.focus();
    },
    [branches, onChange],
  );

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (filtered.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex(
        (index) => (index + delta + filtered.length) % filtered.length,
      );
      return;
    }
    if (event.key === 'Enter' && activeBranch) {
      event.preventDefault();
      handleSelect(activeBranch.name);
    }
  }

  return (
    <>
      <PickerTrigger
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => {
          if (!disabled) setOpen(!open);
        }}
        variant="field"
        mono
        tone="secondary"
        className="w-full justify-between"
        data-testid="base-branch-dropdown-trigger"
        aria-label={`Select base branch, current branch ${displayValue}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        <span className="truncate">{displayValue}</span>
        <PickerTriggerChevron open={open} />
      </PickerTrigger>

      <FloatingPickerMenu
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-left"
        heightLimit={240}
        initialFocusRef={searchRef}
        role="dialog"
        aria-modal="false"
        aria-label="Base branch selector"
        data-testid="base-branch-dropdown-menu"
      >
        <PickerMenuSearchHeader>
          <PickerMenuSearchInput
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search branches…"
            aria-label="Search branches"
            aria-controls={`${menuId}-options`}
            aria-activedescendant={
              activeBranch
                ? `${menuId}-option-${activeBranch.isRemote ? 'remote' : 'local'}-${activeBranch.name}`
                : undefined
            }
            onKeyDown={handleSearchKeyDown}
          />
        </PickerMenuSearchHeader>
        <PickerMenuList
          ref={listRef}
          id={`${menuId}-options`}
          aria-label="Base branch options"
        >
          {loading ? (
            <PickerMenuState>
              <LoadingIndicator text="Loading…" />
            </PickerMenuState>
          ) : filtered.length === 0 ? (
            <PickerMenuState>No branches found</PickerMenuState>
          ) : (
            filtered.map((branch, index) => {
              const provenanceBadge = getBranchProvenanceBadge(branch);
              const isSelected = branch.name === currentValue;
              return (
                <PickerMenuOption
                  key={`${branch.isRemote ? 'remote' : 'local'}-${branch.name}`}
                  role="option"
                  id={`${menuId}-option-${branch.isRemote ? 'remote' : 'local'}-${branch.name}`}
                  aria-selected={isSelected}
                  tabIndex={-1}
                  onClick={() => handleSelect(branch.name)}
                  onMouseEnter={() => setActiveIndex(index)}
                  data-branch-name={branch.name}
                  active={index === activeIndex}
                  selected={isSelected}
                >
                  <PickerMenuOptionLeading>
                    <BranchIcon size="md" />
                  </PickerMenuOptionLeading>
                  <PickerMenuOptionContent>
                    <PickerMenuOptionLabel>{branch.name}</PickerMenuOptionLabel>
                  </PickerMenuOptionContent>
                  {provenanceBadge && (
                    <PickerMenuOptionTrailing>
                      {provenanceBadge}
                    </PickerMenuOptionTrailing>
                  )}
                  <PickerMenuOptionCheck selected={isSelected} />
                </PickerMenuOption>
              );
            })
          )}
        </PickerMenuList>
      </FloatingPickerMenu>
    </>
  );
}
