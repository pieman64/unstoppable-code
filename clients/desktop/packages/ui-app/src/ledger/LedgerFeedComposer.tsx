'use client';

import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type JSX,
} from 'react';
import type { LedgerFilePicker } from '@canopy/app-core';
import {
  ledgerDraftMovable,
  ledgerFeedDraft,
  type LedgerFeedComposerState,
  type LedgerFeedStore,
  type LedgerViewComposerState,
  type LedgerViewDraft,
  type LedgerViewOwnersState,
  type LedgerViewState,
  type LedgerViewStore,
  type LedgerViewStoreFor,
} from '@canopy/app-state';
import type {
  LedgerTaskViewScope,
  LedgerViewScope,
} from '@canopy/protocol/ledger-view';
import {
  LedgerEntryForm,
  LedgerTargetPicker,
  type LedgerTargetOption,
} from '@canopy/ui-shared/components';
import {
  LedgerDraftFileSearch,
  LedgerDraftOwnerPicker,
} from './LedgerDraftFields';
import { ledgerSaveProblemText } from './ledger-write-copy';

/**
 * One of this device's tasks a new entry can go to. A global (workflow) scope
 * is never one: only agents add to it.
 */
export interface LedgerFeedScopeOption {
  readonly scope: LedgerTaskViewScope;
  /** The worktree or task, as this device names it. */
  readonly label: string;
  /** Its project, shown beneath: one project's tasks may read alike. */
  readonly project: string;
}

const IDLE_OWNERS: LedgerViewOwnersState = {
  status: 'idle',
  candidates: [],
  problem: null,
};

const NO_TASK_REASON = 'Choose a task first.';

/** Part of a scope's view, when there is one; null while there is none. */
function useViewSlice<Slice>(
  view: LedgerViewStore | null,
  select: (state: LedgerViewState) => Slice,
): Slice | null {
  const subscribe = useCallback(
    (onChange: () => void): (() => void) =>
      view === null ? (): void => undefined : view.subscribe(onChange),
    [view],
  );
  return useSyncExternalStore(subscribe, () =>
    view === null ? null : select(view.getState()),
  );
}

function selectComposer(state: LedgerViewState): LedgerViewComposerState {
  return state.composer;
}

function selectOwners(state: LedgerViewState): LedgerViewOwnersState {
  return state.owners;
}

/** The draft state of the task the Feed's new entry went to, if any. */
function useLedgerViewComposer(
  view: LedgerViewStore | null,
): LedgerViewComposerState | null {
  return useViewSlice(view, selectComposer);
}

/**
 * The Feed's new entry draft, wherever it is held, and whether its form is
 * open (see `ledgerFeedDraft`). When the draft leaves its task's view while
 * the form is open, the form closes. If that view saved it, the Feed shows
 * new activity without opening or focusing the entry; if it was dropped or
 * replaced, the Feed goes back to its list.
 */
export function useLedgerFeedDraft(
  store: LedgerFeedStore,
  composer: LedgerFeedComposerState,
  scopeStore: LedgerViewStoreFor,
): { readonly heldDraft: LedgerViewDraft | null; readonly composing: boolean } {
  const targetView =
    composer.scope === null ? null : scopeStore(composer.scope);
  const heldDraft = ledgerFeedDraft(
    composer,
    useLedgerViewComposer(targetView),
  );
  useLayoutEffect(() => {
    const { scope, draftId } = composer;
    if (!composer.shown || scope === null || targetView === null) return;
    if (heldDraft !== null) return;
    store.getState().closeEntry();
    const view = targetView.getState();
    const saved = view.savedAdopted;
    if (saved === null || saved.adoptedId !== draftId) return;
    void store.getState().showNewActivity();
  }, [store, composer, heldDraft, targetView]);
  return { heldDraft, composing: composer.shown && heldDraft !== null };
}

export interface LedgerFeedComposerProps {
  readonly store: LedgerFeedStore;
  readonly scopeStore: LedgerViewStoreFor;
  /** Whether a scope's own view holds a draft, read without creating it. */
  readonly scopeHasDraft: (scope: LedgerViewScope) => boolean;
  readonly addableScopes: readonly LedgerFeedScopeOption[];
  readonly files?: LedgerFilePicker;
}

interface FeedTargetFieldsProps {
  readonly store: LedgerFeedStore;
  readonly scopeStore: LedgerViewStoreFor;
  readonly scopeHasDraft: (scope: LedgerViewScope) => boolean;
  readonly addableScopes: readonly LedgerFeedScopeOption[];
  readonly composer: LedgerFeedComposerState;
  readonly draft: LedgerViewDraft;
  /** The chosen task's view; null until a task is chosen. */
  readonly view: LedgerViewStore | null;
  readonly owners: LedgerViewOwnersState;
  readonly saving: boolean;
  /** Whether the draft can move to another project or task now. */
  readonly movable: boolean;
  readonly onChange: (patch: Partial<LedgerViewDraft>) => void;
}

/** Where the Feed's new entry goes: its project, task and owner, in order. */
function FeedTargetFields({
  store,
  scopeStore,
  scopeHasDraft,
  addableScopes,
  composer,
  draft,
  view,
  owners,
  saving,
  movable,
  onChange,
}: FeedTargetFieldsProps): JSX.Element {
  const id = useId();
  const { projectId, scope } = composer;
  const projects = useMemo((): LedgerTargetOption[] => {
    const byId = new Map<string, LedgerTargetOption>();
    for (const option of addableScopes) {
      if (!byId.has(option.scope.projectId)) {
        byId.set(option.scope.projectId, {
          id: option.scope.projectId,
          label: option.project,
        });
      }
    }
    return [...byId.values()];
  }, [addableScopes]);
  const projectTasks = addableScopes.filter(
    (option) => option.scope.projectId === projectId,
  );
  const tasks = projectTasks.map((option): LedgerTargetOption => {
    const chosen = option.scope.worktreeId === scope?.worktreeId;
    return {
      id: option.scope.worktreeId,
      label: option.label,
      ...(!chosen &&
      scopeHasDraft(option.scope) &&
      scopeStore(option.scope).getState().composer.draft !== null
        ? { unavailable: 'Has a draft' }
        : {}),
    };
  });
  // A send the Ledger may have recorded keeps the draft in its task.
  const moveBlocked =
    !movable && !saving
      ? { disabledReason: 'Save or cancel this draft before moving it.' }
      : {};
  return (
    // Each picker is a button named by its heading through `labelId`
    // (aria-labelledby), so the headings are plain text, not <label>s.
    <div data-testid="ledger-feed-target" className="flex flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span id={`${id}-project-label`} className="text-xs fg-secondary">
          Project
        </span>
        <LedgerTargetPicker
          id={`${id}-project`}
          labelId={`${id}-project-label`}
          options={projects}
          value={projectId}
          placeholder="Choose a project"
          disabled={!movable}
          {...moveBlocked}
          onSelect={(next) => {
            store.getState().chooseProject(next, scopeStore);
          }}
          data-testid="ledger-feed-target-project"
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span id={`${id}-task-label`} className="text-xs fg-secondary">
          Task
        </span>
        <LedgerTargetPicker
          id={`${id}-task`}
          labelId={`${id}-task-label`}
          options={tasks}
          value={scope?.worktreeId ?? null}
          placeholder={
            projectId === null ? 'Choose a project first' : 'Choose a task'
          }
          disabled={projectId === null || !movable}
          {...moveBlocked}
          onSelect={(worktreeId) => {
            const option = projectTasks.find(
              (candidate) => candidate.scope.worktreeId === worktreeId,
            );
            if (option !== undefined) {
              store.getState().chooseTask(option.scope, scopeStore);
            }
          }}
          data-testid="ledger-feed-target-task"
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span id={`${id}-owner`} className="text-xs fg-secondary">
          Owner
        </span>
        <LedgerDraftOwnerPicker
          labelId={`${id}-owner`}
          draft={draft}
          owners={owners}
          saving={saving}
          {...(view === null ? { disabledReason: NO_TASK_REASON } : {})}
          onOpen={() => {
            if (view !== null) void view.getState().loadOwners();
          }}
          onChange={onChange}
        />
      </div>
    </div>
  );
}

/**
 * The Feed's new entry. Where it goes comes first: a project, one of its
 * tasks, then the owner, as an automation chooses its chat. Any of them
 * changes while the person writes, and what they wrote stays; a task's own
 * draft keeps that task. The entry saves through the chosen task's view.
 */
export function LedgerFeedComposer({
  store,
  scopeStore,
  scopeHasDraft,
  addableScopes,
  files,
}: LedgerFeedComposerProps): JSX.Element | null {
  const composer = store((state) => state.composer);
  const { scope } = composer;
  const view = scope === null ? null : scopeStore(scope);
  const viewComposer = useLedgerViewComposer(view);
  const viewOwners = useViewSlice(view, selectOwners);

  const draft = ledgerFeedDraft(composer, viewComposer);
  if (draft === null) return null;

  const saving = viewComposer?.saving ?? false;
  const problem = viewComposer?.problem ?? null;
  const onChange = (patch: Partial<LedgerViewDraft>): void => {
    if (view === null) store.getState().updateDraft(patch);
    else view.getState().updateDraft(patch);
  };

  return (
    <div className="flex flex-col gap-3">
      <LedgerEntryForm
        value={draft}
        correctionOf={null}
        saving={saving}
        problem={problem === null ? null : ledgerSaveProblemText(problem)}
        targetControl={
          <FeedTargetFields
            store={store}
            scopeStore={scopeStore}
            scopeHasDraft={scopeHasDraft}
            addableScopes={addableScopes}
            composer={composer}
            draft={draft}
            view={view}
            owners={viewOwners ?? IDLE_OWNERS}
            saving={saving}
            movable={viewComposer === null || ledgerDraftMovable(viewComposer)}
            onChange={onChange}
          />
        }
        saveBlockedReason={view === null ? NO_TASK_REASON : null}
        fileSearch={
          files === undefined || scope === null ? undefined : (
            <LedgerDraftFileSearch
              files={files}
              scope={scope}
              draft={draft}
              saving={saving}
              onChange={onChange}
            />
          )
        }
        onChange={onChange}
        onSave={() => {
          if (view !== null) void view.getState().submitDraft();
        }}
        onDiscard={() => {
          if (saving) return;
          // Closed first, so the Feed reads the dropped draft as discarded.
          store.getState().closeEntry();
          view?.getState().discardDraft();
        }}
      />
    </div>
  );
}
