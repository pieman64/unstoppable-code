import type { CanopyCapabilities } from '@canopy/app-core';

/** What the shell edits. Each kind supplies its own section content. */
export type WorkflowEditKind = 'pipeline' | 'automation';

/** The shell's sections, in tab order. The draft spans all three. */
export type WorkflowEditSection = 'definition' | 'trigger' | 'runs';

export const WORKFLOW_EDIT_SECTIONS: readonly WorkflowEditSection[] = [
  'definition',
  'trigger',
  'runs',
];

export const WORKFLOW_EDIT_SECTION_LABELS: Readonly<
  Record<WorkflowEditSection, string>
> = {
  definition: 'Definition',
  trigger: 'Trigger',
  runs: 'Runs',
};

/** The header's actions. `toggle` is the enable switch. */
export type WorkflowEditActionId =
  | 'save'
  | 'run'
  | 'share'
  | 'duplicate'
  | 'delete'
  | 'toggle';

/**
 * The actions the shell's More menu holds, in menu order. Run, Share and the
 * primary action stay buttons; these are rarer, and Delete sits last, below
 * a divider.
 */
export const WORKFLOW_EDIT_MENU_ACTIONS = [
  'toggle',
  'duplicate',
  'delete',
] as const satisfies readonly WorkflowEditActionId[];

export type WorkflowEditMenuActionId =
  (typeof WORKFLOW_EDIT_MENU_ACTIONS)[number];

export interface WorkflowEditActionState {
  readonly visible: boolean;
  readonly disabled: boolean;
  /** Why a visible action is disabled, when the user can do something about it. */
  readonly reason?: string;
}

/** The save-state text beside the name. */
export type WorkflowEditSaveState =
  | 'new'
  | 'read-only'
  | 'unsaved'
  | 'saving'
  | 'saved';

/** `null`: a saved item shows no save-state text. */
export const WORKFLOW_EDIT_SAVE_STATE_LABELS: Readonly<
  Record<WorkflowEditSaveState, string | null>
> = {
  new: 'New',
  'read-only': 'Read-only',
  unsaved: 'Unsaved changes',
  saving: 'Saving…',
  saved: null,
};

export interface WorkflowEditPlanInput {
  readonly kind: WorkflowEditKind;
  readonly readOnly: boolean;
  readonly dirty: boolean;
  readonly saving: boolean;
  /** Never saved. */
  readonly draft: boolean;
  /** The form or editor reports it can be submitted. */
  readonly canSubmit: boolean;
  /** Pipelines: the user's own definition. Automations pass `true`. */
  readonly userOwned: boolean;
  /** Defaults to `true`. `false` hides Share (resume automations). */
  readonly shareable?: boolean;
  /** Defaults to `true`. `false` hides Run. */
  readonly runnable?: boolean;
  /** Defaults to `true`. `false` hides Delete (shared pipelines you can't delete). */
  readonly deletable?: boolean;
  readonly capabilities: Pick<CanopyCapabilities, 'pipelines' | 'automations'>;
}

export interface WorkflowEditPlan {
  /** The accent action at the end of the action bar. */
  readonly primary: 'save' | 'duplicate';
  readonly saveState: WorkflowEditSaveState;
  /**
   * The item holds unsaved edits. A new draft with edits is dirty although
   * its save state stays `new`; a read-only item never is.
   */
  readonly dirty: boolean;
  readonly actions: Readonly<
    Record<WorkflowEditActionId, WorkflowEditActionState>
  >;
}

export const WORKFLOW_EDIT_RUN_DIRTY_REASON = 'Save to run the latest changes';
export const WORKFLOW_EDIT_SHARE_DIRTY_REASON =
  'Save to share the latest changes';
export const WORKFLOW_EDIT_DUPLICATE_DIRTY_REASON =
  'Save to duplicate the latest changes';
export const WORKFLOW_EDIT_RUN_DRAFT_REASON = 'Save it first to run it';
export const WORKFLOW_EDIT_SHARE_DRAFT_REASON = 'Save it first to share it';

const HIDDEN: WorkflowEditActionState = { visible: false, disabled: true };

/**
 * A visible action that acts on the saved version: disabled while a save
 * runs, and while dirty with `dirtyReason`, so it never acts on the draft.
 * A never-saved draft has no saved version yet, so the action stays in place
 * with `draftReason` instead of appearing only after the first save.
 */
function savedVersionAction(
  input: WorkflowEditPlanInput,
  dirtyReason: string,
  draftReason?: string,
): WorkflowEditActionState {
  if (input.saving) return { visible: true, disabled: true };
  if (input.draft && draftReason !== undefined) {
    return { visible: true, disabled: true, reason: draftReason };
  }
  if (input.dirty) {
    return { visible: true, disabled: true, reason: dirtyReason };
  }
  return { visible: true, disabled: false };
}

function canRunKind(input: WorkflowEditPlanInput): boolean {
  return input.kind === 'pipeline'
    ? input.capabilities.pipelines === 'execute'
    : input.capabilities.automations === true;
}

function resolveSaveState(input: WorkflowEditPlanInput): WorkflowEditSaveState {
  if (input.readOnly) return 'read-only';
  if (input.saving) return 'saving';
  if (input.draft) return 'new';
  if (input.dirty) return 'unsaved';
  return 'saved';
}

/**
 * Which header actions a pipeline or automation shows, and which of them are
 * available, from the item's state and the host's capabilities (CAN-4072).
 * The shell renders exactly this; it never branches on the host.
 *
 * Capabilities gate Run only. A host that cannot edit an item passes
 * `readOnly`, which is what hides Save, Delete and the toggle.
 */
export function resolveWorkflowEditPlan(
  input: WorkflowEditPlanInput,
): WorkflowEditPlan {
  const { kind, readOnly, draft } = input;

  // A never-saved draft can be saved while clean; a saved item only once it
  // has changes.
  const save: WorkflowEditActionState = readOnly
    ? HIDDEN
    : {
        visible: true,
        disabled: input.saving || !input.canSubmit || (!draft && !input.dirty),
      };

  const duplicateVisible = readOnly
    ? true
    : kind === 'pipeline' && !input.userOwned && !draft;
  const duplicate = duplicateVisible
    ? savedVersionAction(input, WORKFLOW_EDIT_DUPLICATE_DIRTY_REASON)
    : HIDDEN;

  // Run and Share keep their place on a draft, so the bar's shape does not
  // change on the first save; only what can never apply is hidden.
  const run =
    !readOnly && input.runnable !== false && canRunKind(input)
      ? savedVersionAction(
          input,
          WORKFLOW_EDIT_RUN_DIRTY_REASON,
          WORKFLOW_EDIT_RUN_DRAFT_REASON,
        )
      : HIDDEN;

  const share =
    (readOnly && kind === 'automation') || input.shareable === false
      ? HIDDEN
      : savedVersionAction(
          input,
          WORKFLOW_EDIT_SHARE_DIRTY_REASON,
          WORKFLOW_EDIT_SHARE_DRAFT_REASON,
        );

  const remove: WorkflowEditActionState =
    draft || readOnly || input.deletable === false
      ? HIDDEN
      : { visible: true, disabled: input.saving };

  // A draft has nothing to turn on or off yet; an automation draft sets
  // Enabled in its form, saved with the rest.
  const toggle: WorkflowEditActionState =
    readOnly || draft ? HIDDEN : { visible: true, disabled: input.saving };

  return {
    primary: readOnly ? 'duplicate' : 'save',
    saveState: resolveSaveState(input),
    dirty: !readOnly && input.dirty,
    actions: { save, run, share, duplicate, delete: remove, toggle },
  };
}
