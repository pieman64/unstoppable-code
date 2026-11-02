import { useCallback, useState } from 'react';
import { saveWorkspacePrivateMemory } from '@/lib/privateMemory';
import { useProjectsStore } from '@/stores/projectsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

/** The fields every project row projects for Private memory. */
export interface PrivateMemoryProjection {
  readonly id: string;
  readonly privateMemory?: boolean;
  readonly privateMemoryManagedBy?: 'organization';
}

export interface PrivateMemoryDraft {
  /** What the toggle shows: the draft, or the inherited value when managed. */
  readonly checked: boolean;
  /** An organization owns the value; the control is read-only. */
  readonly managed: boolean;
  /** The managing organization's name, when this account can see it. */
  readonly organizationName: string | undefined;
  readonly dirty: boolean;
  /** Why the last save was refused, until the next change or save. */
  readonly error: string | null;
  readonly setChecked: (next: boolean) => void;
  /** Drop the draft and any error so the toggle follows the row again. */
  readonly reset: () => void;
  /**
   * Persist a changed draft. Resolves `false` when main refused it: the rows
   * have been reloaded by then and `error` says why.
   */
  readonly save: () => Promise<boolean>;
}

interface DraftState {
  readonly workspaceId: string | null;
  readonly draft: boolean | null;
  readonly error: string | null;
}

const EMPTY_STATE: DraftState = { workspaceId: null, draft: null, error: null };

/**
 * Draft state for one project's Private memory toggle, shared by the code,
 * multi-repo and Cowork settings dialogs.
 *
 * The draft is kept apart from the projected value: untouched, the toggle
 * follows the row, and a managed row always wins over a draft. A catalog
 * update that makes the value organization-managed while the dialog is open
 * therefore shows the inherited value as soon as the rows refresh. State is
 * keyed by project, so a draft never carries over to another project.
 */
export function usePrivateMemoryDraft(
  project: PrivateMemoryProjection | null,
): PrivateMemoryDraft {
  const [state, setState] = useState<DraftState>(EMPTY_STATE);
  const workspaceId = project?.id ?? null;
  const current = state.workspaceId === workspaceId ? state : EMPTY_STATE;
  const projected = project?.privateMemory === true;
  const managed = project?.privateMemoryManagedBy === 'organization';
  const checked = managed ? projected : (current.draft ?? projected);
  const dirty = !managed && checked !== projected;

  const organizationId = useProjectsStore((store): string | undefined => {
    if (workspaceId === null) return undefined;
    return store.projects.find((item) => item.id === workspaceId)?.owner
      ?.organizationId;
  });
  const organizationName = useWorkspaceContextStore(
    (store): string | undefined =>
      organizationId === undefined
        ? undefined
        : store.state.organizations.find(
            (organization) => organization.id === organizationId,
          )?.name,
  );

  const setChecked = useCallback(
    (next: boolean): void =>
      setState({ workspaceId, draft: next, error: null }),
    [workspaceId],
  );
  const reset = useCallback((): void => setState(EMPTY_STATE), []);
  const save = useCallback(async (): Promise<boolean> => {
    if (workspaceId === null || !dirty) return true;
    // A change made while this write is in flight is newer than it: keep it
    // as the draft so the next save writes it, instead of clearing it.
    const changedSince = (state: DraftState): boolean =>
      state.workspaceId === workspaceId &&
      state.draft !== null &&
      state.draft !== checked;
    try {
      await saveWorkspacePrivateMemory(workspaceId, checked);
      setState((previous) => (changedSince(previous) ? previous : EMPTY_STATE));
      return true;
    } catch (cause) {
      // The reloaded row is now the value to show, beside the reason.
      const error =
        cause instanceof Error ? cause.message : "Couldn't save Private memory";
      setState((previous) => ({
        workspaceId,
        draft: changedSince(previous) ? previous.draft : null,
        error,
      }));
      return false;
    }
  }, [checked, dirty, workspaceId]);

  return {
    checked,
    managed,
    organizationName,
    dirty,
    error: current.error,
    setChecked,
    reset,
    save,
  };
}
