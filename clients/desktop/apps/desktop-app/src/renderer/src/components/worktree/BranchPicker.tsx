import { Button, FloatingMenu, ListRow } from '@canopy/ui-shared/components';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { ErrorBanner } from '@canopy/ui-shared/components';
import type { BranchEntry } from '@canopy/desktop-shared/types';
import {
  collapseBranchDuplicates,
  filterBranchesBySearch,
  getBranchProvenanceBadge,
  type BranchOption,
} from './branch-options';
import { resolveBranchPickerBaseSelection } from './branch-picker-base-selection';
import { Tooltip } from '@canopy/ui-shared';
import {
  FormField,
  SearchField,
  TextInput,
} from '@canopy/ui-shared/components';
import {
  PlusIcon as AppCatalogPlusIcon,
  ChevronLeftMediumIcon as AppCatalogChevronLeftMediumIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { Badge } from '@canopy/ui-shared/components';

interface BranchPickerProps {
  projectId: string;
  worktreeId: string;
  repoId?: string;
  currentBranch: string;
  baseBranch?: string | null;
  onBranchSwitched: (newBranch: string) => void;
  onBranchCreated: (newBranch: string, baseBranch: string) => void;
  onClose: () => void;
}

type PickerView = 'list' | 'create';

export function BranchPicker({
  projectId,
  worktreeId,
  repoId,
  currentBranch,
  baseBranch,
  onBranchSwitched,
  onBranchCreated,
  onClose,
}: BranchPickerProps): JSX.Element {
  const [view, setView] = useState<PickerView>('list');
  const [branches, setBranches] = useState<BranchEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [switching, setSwitching] = useState<string | null>(null);

  // Create branch state
  const [newBranchName, setNewBranchName] = useState('');
  const [newBaseBranch, setNewBaseBranch] = useState('');
  const [newBaseBranchIsRemote, setNewBaseBranchIsRemote] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [showBasePicker, setShowBasePicker] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const newBranchInputRef = useRef<HTMLInputElement>(null);
  const baseBranchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Fetch branches on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.api
      .listBranches({ projectId, worktreeId, repoId })
      .then((response) => {
        if (cancelled) return;
        const initialBaseSelection = resolveBranchPickerBaseSelection(
          response.branches,
          baseBranch,
          response.defaultBranch,
        );
        setBranches(response.branches);
        setNewBaseBranch(initialBaseSelection.name);
        setNewBaseBranchIsRemote(initialBaseSelection.isRemote);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : 'Failed to load branches',
        );
        setLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [projectId, worktreeId, repoId, baseBranch]);

  // Focus search input when list view opens
  useEffect(() => {
    if (view === 'list' && !loading) {
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [view, loading]);

  // Focus new branch input when create view opens
  useEffect(() => {
    if (view === 'create') {
      setTimeout(() => newBranchInputRef.current?.focus(), 0);
    }
  }, [view]);

  // Filter branches: hide remote entries when a same-name local exists
  const filteredBranches = useMemo(() => {
    return filterBranchesBySearch(collapseBranchDuplicates(branches), search);
  }, [branches, search]);

  const localBranches = useMemo(
    () => filteredBranches.filter((b) => b.hasLocalRef),
    [filteredBranches],
  );

  const remoteBranches = useMemo(
    () => filteredBranches.filter((b) => !b.hasLocalRef && b.hasRemoteRef),
    [filteredBranches],
  );

  const handleSwitch = useCallback(
    async (branch: BranchEntry) => {
      if (branch.isCurrent || branch.isUsedByWorktree) return;
      setSwitching(branch.name);
      setError(null);
      try {
        const response = await window.api.switchBranch({
          projectId,
          worktreeId,
          branchName: branch.name,
          isRemote: branch.isRemote,
          repoId,
        });
        if (response.success) {
          onBranchSwitched(response.branchName);
        }
      } catch (err: unknown) {
        setError(
          err instanceof Error ? err.message : 'Failed to switch branch',
        );
      } finally {
        setSwitching(null);
      }
    },
    [projectId, worktreeId, repoId, onBranchSwitched],
  );

  const handleCreate = useCallback(async () => {
    const trimmedName = newBranchName.trim();
    if (!trimmedName) return;
    setCreating(true);
    setCreateError(null);
    try {
      const response = await window.api.createBranch({
        projectId,
        worktreeId,
        newBranchName: trimmedName,
        baseBranch: newBaseBranch,
        baseBranchIsRemote: newBaseBranchIsRemote,
        repoId,
      });
      if (response.success) {
        onBranchCreated(response.branchName, newBaseBranch);
      }
    } catch (err: unknown) {
      setCreateError(
        err instanceof Error ? err.message : 'Failed to create branch',
      );
    } finally {
      setCreating(false);
    }
  }, [
    projectId,
    worktreeId,
    repoId,
    newBranchName,
    newBaseBranch,
    newBaseBranchIsRemote,
    onBranchCreated,
  ]);

  // Base branch picker filter for the create view
  const baseFilteredBranches = useMemo(() => {
    if (!showBasePicker) return [];
    return filterBranchesBySearch(
      collapseBranchDuplicates(branches),
      newBaseBranch,
    );
  }, [branches, newBaseBranch, showBasePicker]);

  const renderBranchItem = (branch: BranchOption): JSX.Element => {
    const isSwitching = switching === branch.name;
    const isDisabled = branch.isCurrent || branch.isUsedByWorktree;
    const provenanceBadge = getBranchProvenanceBadge(branch);

    return (
      <Tooltip
        key={`${branch.isRemote ? 'remote' : 'local'}-${branch.name}`}
        label={
          branch.isUsedByWorktree
            ? 'Used by another worktree'
            : branch.isCurrent
              ? 'Current branch'
              : `Switch to ${branch.name}`
        }
        disabled={!branch.isUsedByWorktree && !branch.isCurrent}
        className="w-full"
      >
        <ListRow
          disabled={isDisabled || isSwitching}
          selected={branch.isCurrent}
          aria-current={branch.isCurrent ? 'true' : undefined}
          onClick={() => void handleSwitch(branch)}
          trailing={
            branch.isCurrent ||
            branch.isUsedByWorktree ||
            provenanceBadge ||
            isSwitching ? (
              <span className="flex items-center gap-2">
                {branch.isCurrent && <Badge>current</Badge>}
                {branch.isUsedByWorktree && !branch.isCurrent && (
                  <Badge tone="warning">in use</Badge>
                )}
                {provenanceBadge && <Badge>{provenanceBadge}</Badge>}
                {isSwitching && <span>switching…</span>}
              </span>
            ) : undefined
          }
        >
          <span className="font-mono">{branch.name}</span>
        </ListRow>
      </Tooltip>
    );
  };

  return (
    <div className="mt-1 w-full rounded-lg bg-card shadow-lg">
      {view === 'list' && (
        <>
          {/* Search input */}
          <div className="border-b p-2">
            <SearchField
              ref={searchInputRef}
              value={search}
              onValueChange={setSearch}
              onEscapeEmpty={onClose}
              aria-label="Search branches"
              placeholder={`Search branches (on ${currentBranch})…`}
            />
          </div>

          {/* Branch list */}
          <div ref={listRef} className="max-h-60 overflow-y-auto p-1">
            {loading && (
              <div className="flex items-center justify-center py-4">
                <span className="text-xs fg-secondary">Loading branches…</span>
              </div>
            )}

            {!loading && filteredBranches.length === 0 && (
              <div className="py-3 text-center text-xs fg-secondary">
                {search ? 'No matching branches' : 'No branches found'}
              </div>
            )}

            {!loading && localBranches.length > 0 && (
              <div>
                <div className="px-2 py-1 text-3xs font-semibold fg-secondary">
                  Local
                </div>
                {localBranches.map(renderBranchItem)}
              </div>
            )}

            {!loading && remoteBranches.length > 0 && (
              <div className={localBranches.length > 0 ? 'mt-1' : ''}>
                <div className="px-2 py-1 text-3xs font-semibold fg-secondary">
                  Remote
                </div>
                {remoteBranches.map(renderBranchItem)}
              </div>
            )}
          </div>

          {/* Error display */}
          {error && (
            <div className="border-t px-2 py-1.5">
              <ErrorBanner error={error} className="" />
            </div>
          )}

          {/* New branch option */}
          <div className="border-t p-1">
            <ListRow
              onClick={() => {
                setView('create');
                setCreateError(null);
              }}
              icon={<AppCatalogPlusIcon width="16" height="16" />}
            >
              New branch…
            </ListRow>
          </div>
        </>
      )}

      {view === 'create' && (
        <div className="p-3">
          <div className="mb-2 flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="compact"
              iconOnly
              onClick={() => {
                setView('list');
                setCreateError(null);
              }}
              aria-label="Back to branch list"
            >
              <AppCatalogChevronLeftMediumIcon width="14" height="14" />
            </Button>
            <span className="text-xs font-semibold fg-primary">
              Create new branch
            </span>
          </div>

          {/* Branch name input */}
          <div className="space-y-2">
            <FormField label="Branch name" error={createError}>
              {(control) => (
                <TextInput
                  {...control}
                  ref={newBranchInputRef}
                  density="compact"
                  mono
                  type="text"
                  value={newBranchName}
                  onChange={(e) => {
                    setNewBranchName(e.target.value);
                    setCreateError(null);
                  }}
                  onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter') {
                      void handleCreate();
                    } else if (e.key === 'Escape') {
                      setView('list');
                      setCreateError(null);
                    }
                  }}
                  placeholder="feature/my-branch"
                  disabled={creating}
                />
              )}
            </FormField>

            {/* Base branch input */}
            <div className="relative">
              <FormField label="From base branch">
                {(control) => (
                  <TextInput
                    {...control}
                    ref={baseBranchInputRef}
                    density="compact"
                    mono
                    type="text"
                    value={newBaseBranch}
                    onChange={(e) => {
                      const nextBaseSelection =
                        resolveBranchPickerBaseSelection(
                          branches,
                          e.target.value,
                          null,
                        );
                      setNewBaseBranch(nextBaseSelection.name);
                      setNewBaseBranchIsRemote(nextBaseSelection.isRemote);
                      setShowBasePicker(true);
                    }}
                    onFocus={() => setShowBasePicker(true)}
                    onBlur={() => {
                      // Delay to allow click on picker item
                      setTimeout(() => setShowBasePicker(false), 150);
                    }}
                    onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                      if (e.key === 'Escape') {
                        setShowBasePicker(false);
                      }
                    }}
                    disabled={creating}
                  />
                )}
              </FormField>
              {/* Suggestions while typing: focus stays in the field, and the
                  shared menu layer places and dismisses the list. */}
              <FloatingMenu
                open={showBasePicker && baseFilteredBranches.length > 0}
                onOpenChange={setShowBasePicker}
                anchorRef={baseBranchInputRef}
                interaction="manual"
                openOnArrowKeys={false}
                // Any press outside closes the suggestions and still does
                // what it says: Create, Cancel, the other field, or the
                // dialog around the picker (its Close, tabs and rows).
                outsidePressSwallowsClick={false}
                heightLimit={160}
                role="listbox"
                aria-label="Base branches"
                className="w-[var(--floating-menu-anchor-width)] overflow-y-auto"
              >
                {baseFilteredBranches.map((b) => {
                  const provenanceBadge = getBranchProvenanceBadge(b);
                  return (
                    <ListRow
                      key={`base-${b.isRemote ? 'remote' : 'local'}-${b.name}`}
                      role="option"
                      aria-selected={b.name === newBaseBranch}
                      selected={b.name === newBaseBranch}
                      tabIndex={-1}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setNewBaseBranch(b.name);
                        setNewBaseBranchIsRemote(b.hasRemoteRef);
                        setShowBasePicker(false);
                      }}
                      trailing={provenanceBadge || undefined}
                    >
                      <span className="font-mono">{b.name}</span>
                    </ListRow>
                  );
                })}
              </FloatingMenu>
            </div>

            <div className="flex justify-end gap-1.5">
              <Button
                size="compact"
                onClick={() => {
                  setView('list');
                  setCreateError(null);
                }}
                disabled={creating}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="compact"
                disabled={creating || !newBranchName.trim()}
                onClick={() => void handleCreate()}
              >
                {creating ? 'Creating…' : 'Create'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
