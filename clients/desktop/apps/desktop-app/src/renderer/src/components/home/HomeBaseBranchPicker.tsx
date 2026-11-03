import { RichHoverTooltip } from '@/components/shared/RichHoverTooltip';
import { workspaceRepoPathForCreateFrom } from '@/lib/createFromSource';
import { extractIpcErrorMessage } from '@/lib/errors';
import {
  useHomeComposerStore,
  type HomeNewWorktreeBaseTarget,
} from '@/stores/homeComposerStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type { PullRequestSummary } from '@canopy/desktop-shared/types';
import {
  FloatingPickerMenu,
  PickerMenuList,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionDescription,
  PickerMenuOptionLabel,
  PickerMenuOptionLeading,
  PickerMenuOptionTrailing,
  PickerMenuSearchHeader,
  PickerMenuSearchInput,
  PickerMenuSkeleton,
  PickerMenuState,
  PickerMenuTab,
  PickerMenuTabList,
  PickerTrigger,
  PickerTriggerChevron,
  Tooltip,
} from '@canopy/ui-shared';
import {
  BranchIcon,
  GitPullRequestIcon,
  GlobeIcon,
  MacbookIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  scrollPickerOptionIntoView,
  usePickerActiveScrollIntent,
} from '@canopy/ui-shared/lib';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { useShallow } from 'zustand/shallow';
import {
  collapseBranchDuplicates,
  filterBranchesBySearch,
  getBranchProvenanceBadge,
  preserveBranchOption,
  type BranchOption,
} from '../worktree/branch-options';

type BasePickerTab = 'worktrees' | 'prs' | 'branches';
type BranchChoice = BranchOption & { hasBothRefs: boolean };

/** Local-only branch provenance tooltip. */
const LOCAL_BRANCH_TOOLTIP = 'Local branch';
/** Remote-only branch provenance tooltip. */
const REMOTE_BRANCH_TOOLTIP = 'Remote branch';

const TABS = [
  { id: 'worktrees', label: 'Worktrees', ariaLabel: 'Worktrees' },
  { id: 'prs', label: 'PRs', ariaLabel: 'Pull requests' },
  { id: 'branches', label: 'Branches', ariaLabel: 'Branches' },
] as const;

/** Early access: announced while a tab's skeleton rows stand in for it. */
const TAB_LOADING_LABELS: Record<BasePickerTab, string> = {
  worktrees: 'Loading worktrees',
  prs: 'Loading pull requests',
  branches: 'Loading branches',
};

/** Early access draws skeleton rows; otherwise develop's loading text. */
function PullRequestsLoading({ skeleton }: { skeleton: boolean }): JSX.Element {
  return skeleton ? (
    <PickerMenuSkeleton
      label={TAB_LOADING_LABELS.prs}
      data-testid="home-base-branch-picker-skeleton"
    />
  ) : (
    <PickerMenuState>Loading pull requests…</PickerMenuState>
  );
}

function targetKey(target: HomeNewWorktreeBaseTarget): string {
  if (target.kind === 'worktree') return `worktree:${target.worktreeId}`;
  if (target.kind === 'pr') return `pr:${target.number}`;
  return `branch:${target.branchName}:${target.isRemote ? 'remote' : 'local'}`;
}

function tabForTarget(target: HomeNewWorktreeBaseTarget): BasePickerTab {
  if (target.kind === 'worktree') return 'worktrees';
  if (target.kind === 'pr') return 'prs';
  return 'branches';
}

export function HomeBaseBranchPicker(): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<BasePickerTab>('branches');
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  // Early access: the tab whose rows are on screen. Each branch row mounts its
  // own tooltip, so a large repository's list is slow to render; the picker
  // opens on skeleton rows and swaps the list in once the menu has painted.

  const [renderedTab, setRenderedTab] = useState<BasePickerTab | null>(null);
  const { markActiveOptionScrollIntent, consumeActiveOptionScrollIntent } =
    usePickerActiveScrollIntent();
  const [pullRequests, setPullRequests] = useState<PullRequestSummary[]>([]);
  const [prState, setPrState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [prError, setPrError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const prRequestIdRef = useRef(0);
  const suppressNextTooltipFocusRef = useRef(false);

  const projects = useProjectsStore((state) => state.projects);
  const {
    workspaceId,
    branchTargets,
    newWorktreeBaseTarget,
    setNewWorktreeBaseTarget,
  } = useHomeComposerStore(
    useShallow((state) => ({
      workspaceId: state.workspaceId,
      branchTargets: state.branchTargets,
      newWorktreeBaseTarget: state.newWorktreeBaseTarget,
      setNewWorktreeBaseTarget: state.setNewWorktreeBaseTarget,
    })),
  );

  const project = useMemo(
    () => projects.find((candidate) => candidate.id === workspaceId) ?? null,
    [projects, workspaceId],
  );
  const repoPath = useMemo(
    () => (project ? workspaceRepoPathForCreateFrom(project) : null),
    [project],
  );
  const worktrees = useMemo(
    () => (project?.type === 'single-repo' ? project.worktrees : []),
    [project],
  );
  const branches = useMemo(() => {
    const discovered =
      branchTargets?.supported === true
        ? collapseBranchDuplicates(branchTargets.branches)
        : [];
    return preserveBranchOption(
      discovered,
      newWorktreeBaseTarget?.kind === 'branch'
        ? newWorktreeBaseTarget.branchName
        : null,
    );
  }, [branchTargets, newWorktreeBaseTarget]);
  const filteredWorktrees = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle
      ? worktrees.filter((worktree) =>
          worktree.branchName.toLowerCase().includes(needle),
        )
      : worktrees;
  }, [search, worktrees]);
  const filteredBranches = useMemo(
    () => filterBranchesBySearch(branches, search),
    [branches, search],
  );
  const branchChoices = useMemo(
    () =>
      filteredBranches.flatMap<BranchChoice>((branch) => {
        const hasBothRefs = branch.hasLocalRef && branch.hasRemoteRef;
        return hasBothRefs
          ? [
              {
                ...branch,
                isRemote: false,
                hasRemoteRef: false,
                hasBothRefs,
              },
              {
                ...branch,
                isRemote: true,
                hasLocalRef: false,
                hasBothRefs,
              },
            ]
          : [{ ...branch, hasBothRefs }];
      }),
    [filteredBranches],
  );
  const filteredPullRequests = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return pullRequests;
    return pullRequests.filter(
      (pr) =>
        String(pr.number).includes(needle) ||
        pr.title.toLowerCase().includes(needle) ||
        pr.authorLogin.toLowerCase().includes(needle),
    );
  }, [pullRequests, search]);

  useEffect(() => {
    prRequestIdRef.current += 1;
    setPullRequests([]);
    setPrState('idle');
    setPrError(null);
  }, [repoPath, workspaceId]);

  useEffect(() => {
    if (!open || activeTab !== 'prs' || !repoPath || prState !== 'idle') return;
    const requestId = ++prRequestIdRef.current;
    setPrState('loading');
    void window.api
      .listPullRequests({ repoPath })
      .then((response) => {
        if (prRequestIdRef.current !== requestId) return;
        setPullRequests(response.pullRequests.filter((pr) => !pr.isCrossRepo));
        setPrState('ready');
      })
      .catch((error: unknown) => {
        if (prRequestIdRef.current !== requestId) return;
        setPrError(extractIpcErrorMessage(error));
        setPrState('error');
      });
  }, [activeTab, open, prState, repoPath]);

  useEffect((): (() => void) | undefined => {
    if (!open || renderedTab === activeTab) return undefined;
    let secondFrame = 0;
    // Two frames: the first runs before the skeleton paints, the second after.
    const firstFrame = requestAnimationFrame((): void => {
      secondFrame = requestAnimationFrame((): void =>
        setRenderedTab(activeTab),
      );
    });
    return (): void => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [activeTab, open, renderedTab]);
  const rowsReady = renderedTab === activeTab;

  const options = useMemo(() => {
    if (!rowsReady) return [];
    if (activeTab === 'worktrees') {
      return filteredWorktrees.map((worktree) => ({
        key: `worktree:${worktree.id}`,
        target: {
          kind: 'worktree',
          worktreeId: worktree.id,
        } satisfies HomeNewWorktreeBaseTarget,
      }));
    }
    if (activeTab === 'prs') {
      return filteredPullRequests.map((pr) => ({
        key: `pr:${pr.number}`,
        target: {
          kind: 'pr',
          number: pr.number,
          title: pr.title,
          headRefName: pr.headRefName,
          url: pr.url,
        } satisfies HomeNewWorktreeBaseTarget,
      }));
    }
    return branchChoices.map((branch) => ({
      key: `branch:${branch.name}:${branch.isRemote ? 'remote' : 'local'}`,
      target: {
        kind: 'branch',
        branchName: branch.name,
        isRemote: branch.isRemote,
      } satisfies HomeNewWorktreeBaseTarget,
    }));
  }, [
    activeTab,
    branchChoices,
    filteredPullRequests,
    filteredWorktrees,
    rowsReady,
  ]);

  const activeOption = options[activeIndex];
  useEffect(() => setActiveIndex(0), [activeTab, search]);
  useEffect(() => {
    if (!open || !activeOption) return;
    if (!consumeActiveOptionScrollIntent(activeOption.key)) return;
    scrollPickerOptionIntoView(
      listRef.current,
      activeOption.key,
      'data-option-key',
    );
  }, [activeOption, open, consumeActiveOptionScrollIntent]);

  if (project?.type !== 'single-repo' || !newWorktreeBaseTarget) return null;

  const selectedKey = targetKey(newWorktreeBaseTarget);
  const selectedLabel =
    newWorktreeBaseTarget.kind === 'worktree'
      ? (worktrees.find(
          (worktree) => worktree.id === newWorktreeBaseTarget.worktreeId,
        )?.branchName ?? newWorktreeBaseTarget.worktreeId)
      : newWorktreeBaseTarget.kind === 'pr'
        ? `PR #${newWorktreeBaseTarget.number}`
        : newWorktreeBaseTarget.isRemote
          ? `origin/${newWorktreeBaseTarget.branchName}`
          : newWorktreeBaseTarget.branchName;
  const selectedIconKind: 'branch' | 'pr' =
    newWorktreeBaseTarget.kind === 'pr' ? 'pr' : 'branch';
  const placeholder =
    activeTab === 'worktrees'
      ? 'Search worktrees…'
      : activeTab === 'prs'
        ? 'Search pull requests…'
        : 'Search branches…';

  function selectTab(tab: BasePickerTab): void {
    setActiveTab(tab);
    setActiveIndex(0);
  }

  function restoreTriggerFocus(): void {
    suppressNextTooltipFocusRef.current = true;
    buttonRef.current?.focus();
  }

  function commit(target: HomeNewWorktreeBaseTarget): void {
    setNewWorktreeBaseTarget(target);
    setOpen(false);
    restoreTriggerFocus();
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      restoreTriggerFocus();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (options.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      markActiveOptionScrollIntent();
      setActiveIndex(
        (index) => (index + delta + options.length) % options.length,
      );
      return;
    }
    if (event.key === 'Enter' && activeOption) {
      event.preventDefault();
      commit(activeOption.target);
    }
  }

  return (
    <div data-testid="home-base-branch-picker" className="relative">
      <RichHoverTooltip
        dataTestId="home-base-branch-picker-tooltip"
        tone="inverse"
        surfaceClassName="w-max max-w-48"
        content={
          <div>
            <p className="text-xs font-medium">Base branch</p>
            <p className="mt-0.5 text-2xs leading-snug opacity-70">
              Branch, worktree, or pull request to create the new worktree from.
            </p>
          </div>
        }
      >
        <PickerTrigger
          ref={buttonRef}
          onFocus={(event) => {
            if (!suppressNextTooltipFocusRef.current) return;
            suppressNextTooltipFocusRef.current = false;
            event.stopPropagation();
          }}
          onClick={() => {
            const nextOpen = !open;
            setOpen(nextOpen);
            if (nextOpen) {
              setRenderedTab(null);
              setSearch('');
              setActiveTab(tabForTarget(newWorktreeBaseTarget));
              setActiveIndex(0);
            }
          }}
          data-testid="home-base-branch-picker-button"
          aria-label={`Select base branch, current selection ${selectedLabel}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? 'home-base-branch-picker-menu' : undefined}
          variant="capsule"
          className="max-w-52"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span
              className="flex items-center justify-center fg-tertiary"
              aria-hidden="true"
              data-testid={`home-base-branch-picker-selected-icon-${newWorktreeBaseTarget.kind}`}
              data-icon={selectedIconKind}
            >
              {selectedIconKind === 'pr' ? (
                <GitPullRequestIcon width={16} height={16} />
              ) : (
                <BranchIcon width={16} height={16} />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate fg-primary">
              {selectedLabel}
            </span>
          </span>
          <PickerTriggerChevron open={open} />
        </PickerTrigger>
      </RichHoverTooltip>

      <FloatingPickerMenu
        id="home-base-branch-picker-menu"
        open={open}
        onOpenChange={setOpen}
        anchorRef={buttonRef}
        placement="bottom-left"
        minimumWidth="18.5rem"
        heightLimit={384}
        initialFocusRef={searchRef}
        role="dialog"
        aria-modal="false"
        aria-label="Select base branch"
        data-testid="home-base-branch-picker-menu"
      >
        <PickerMenuSearchHeader>
          <PickerMenuSearchInput
            ref={searchRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={placeholder}
            aria-label={placeholder}
            aria-activedescendant={
              activeOption
                ? `home-base-branch-picker-option-${activeOption.key}`
                : undefined
            }
            data-testid="home-base-branch-picker-search"
          />
        </PickerMenuSearchHeader>
        <PickerMenuTabList aria-label="Base branch sources">
          {TABS.map((tab) => (
            <PickerMenuTab
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-label={tab.ariaLabel}
              active={activeTab === tab.id}
              tabIndex={activeTab === tab.id ? 0 : -1}
              onClick={() => selectTab(tab.id)}
              data-testid={`home-base-branch-picker-tab-${tab.id}`}
            >
              {tab.label}
            </PickerMenuTab>
          ))}
        </PickerMenuTabList>
        <PickerMenuList
          ref={listRef}
          id="home-base-branch-picker-options"
          aria-label="Base branch options"
          data-testid="home-base-branch-picker-list"
        >
          {!rowsReady && (
            <PickerMenuSkeleton
              label={TAB_LOADING_LABELS[activeTab]}
              data-testid="home-base-branch-picker-skeleton"
            />
          )}

          {rowsReady &&
            activeTab === 'worktrees' &&
            (filteredWorktrees.length === 0 ? (
              <PickerMenuState>No matching worktrees</PickerMenuState>
            ) : (
              filteredWorktrees.map((worktree) => {
                const key = `worktree:${worktree.id}`;
                const selected = selectedKey === key;
                return (
                  <PickerMenuOption
                    key={worktree.id}
                    role="option"
                    id={`home-base-branch-picker-option-${key}`}
                    aria-selected={selected}
                    active={activeOption?.key === key}
                    selected={selected}
                    data-option-key={key}
                    data-testid={`home-base-branch-picker-worktree-${worktree.id}`}
                    onClick={() =>
                      commit({ kind: 'worktree', worktreeId: worktree.id })
                    }
                  >
                    <PickerMenuOptionLeading>
                      <BranchIcon size="md" />
                    </PickerMenuOptionLeading>
                    <PickerMenuOptionContent>
                      <PickerMenuOptionLabel>
                        {worktree.branchName}
                      </PickerMenuOptionLabel>
                    </PickerMenuOptionContent>
                    <PickerMenuOptionCheck selected={selected} />
                  </PickerMenuOption>
                );
              })
            ))}

          {rowsReady &&
            activeTab === 'prs' &&
            (prState === 'loading' || prState === 'idle' ? (
              <PullRequestsLoading skeleton={true} />
            ) : prState === 'error' ? (
              <PickerMenuState>
                {prError ?? 'Could not load pull requests'}
              </PickerMenuState>
            ) : filteredPullRequests.length === 0 ? (
              <PickerMenuState>No matching pull requests</PickerMenuState>
            ) : (
              filteredPullRequests.map((pr) => {
                const key = `pr:${pr.number}`;
                const selected = selectedKey === key;
                return (
                  <PickerMenuOption
                    key={pr.number}
                    role="option"
                    id={`home-base-branch-picker-option-${key}`}
                    aria-selected={selected}
                    active={activeOption?.key === key}
                    selected={selected}
                    data-option-key={key}
                    data-testid={`home-base-branch-picker-pr-${pr.number}`}
                    onClick={() =>
                      commit({
                        kind: 'pr',
                        number: pr.number,
                        title: pr.title,
                        headRefName: pr.headRefName,
                        url: pr.url,
                      })
                    }
                  >
                    <PickerMenuOptionLeading>
                      <GitPullRequestIcon />
                    </PickerMenuOptionLeading>
                    <PickerMenuOptionContent>
                      <PickerMenuOptionLabel>
                        #{pr.number} {pr.title}
                      </PickerMenuOptionLabel>
                      <PickerMenuOptionDescription>
                        {/* Session replay blocks the author's login. */}
                        <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
                          {pr.authorLogin}
                        </span>
                      </PickerMenuOptionDescription>
                    </PickerMenuOptionContent>
                    <PickerMenuOptionCheck selected={selected} />
                  </PickerMenuOption>
                );
              })
            ))}

          {rowsReady &&
            activeTab === 'branches' &&
            (filteredBranches.length === 0 ? (
              <PickerMenuState>No matching branches</PickerMenuState>
            ) : (
              branchChoices.map((branch) => {
                const key = `branch:${branch.name}:${branch.isRemote ? 'remote' : 'local'}`;
                const selected = selectedKey === key;
                const provenance = getBranchProvenanceBadge(branch);
                return (
                  <PickerMenuOption
                    key={key}
                    role="option"
                    id={`home-base-branch-picker-option-${key}`}
                    aria-selected={selected}
                    active={activeOption?.key === key}
                    selected={selected}
                    data-option-key={key}
                    data-testid={`home-base-branch-picker-branch-${branch.name}${branch.hasBothRefs ? `-${branch.isRemote ? 'remote' : 'local'}` : ''}`}
                    onClick={() =>
                      commit({
                        kind: 'branch',
                        branchName: branch.name,
                        isRemote: branch.isRemote,
                      })
                    }
                  >
                    <PickerMenuOptionLeading>
                      <BranchIcon
                        size="md"
                        data-testid={`home-base-branch-picker-option-icon-branch-${branch.name}`}
                      />
                    </PickerMenuOptionLeading>
                    <PickerMenuOptionContent>
                      <PickerMenuOptionLabel>
                        {branch.isRemote
                          ? `origin/${branch.name}`
                          : branch.name}
                      </PickerMenuOptionLabel>
                    </PickerMenuOptionContent>
                    {selected ? (
                      <PickerMenuOptionCheck selected />
                    ) : (
                      provenance && (
                        <PickerMenuOptionTrailing
                          aria-label={
                            provenance === 'local'
                              ? LOCAL_BRANCH_TOOLTIP
                              : REMOTE_BRANCH_TOOLTIP
                          }
                          interactive
                        >
                          <Tooltip
                            label={
                              provenance === 'local'
                                ? LOCAL_BRANCH_TOOLTIP
                                : REMOTE_BRANCH_TOOLTIP
                            }
                            placement="right"
                            tone="inverse"
                          >
                            <span
                              className="inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:!h-4 [&>svg]:!w-4"
                              data-testid={
                                provenance === 'local'
                                  ? `home-base-branch-picker-local-badge-${branch.name}`
                                  : `home-base-branch-picker-remote-badge-${branch.name}`
                              }
                            >
                              {provenance === 'local' ? (
                                <MacbookIcon />
                              ) : (
                                <GlobeIcon />
                              )}
                            </span>
                          </Tooltip>
                        </PickerMenuOptionTrailing>
                      )
                    )}
                  </PickerMenuOption>
                );
              })
            ))}
        </PickerMenuList>
      </FloatingPickerMenu>
    </div>
  );
}
