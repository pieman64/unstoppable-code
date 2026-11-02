import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useCapabilities } from '@canopy/app-state';
import type {
  ScheduledActivity,
  WorkflowEditSection,
} from '@canopy/desktop-shared/types';
import {
  WorkflowEditShell,
  resolveWorkflowEditPlan,
  type UnsavedChangesSaveResult,
} from '@canopy/ui-app/workflows';
import {
  Button,
  Notice,
  NoticeButton,
  StartChatSummary,
} from '@canopy/ui-shared/components';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import type { AutomationDraftSeed } from '@/lib/workflows/edit-target';
import { startChatSummaryView } from '@/lib/workflows/start-chat-summary';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useAutomationChatTargetAvailability } from '../../automations/useAutomationChatTargetAvailability';
import {
  ActivityFormBody,
  type ActivityFormBodyHandle,
  type ActivityFormChangeMeta,
} from '../../automations/form/ActivityFormBody';
import {
  activityToFormState,
  automationDraftFromSeed,
  automationFormSnapshot,
  buildAutomationMutationRequest,
  type AutomationFormSection,
  type FormState,
} from '../../automations/form/automationFormState';
import { SHARED_PIPELINE_REVIEW_NEEDED_MESSAGE } from '../../automations/ReviewSharedPipelineChangeModal';
import type { AutomationsPageBodyApi } from '../../pages/AutomationsPage';
import { AutomationRunsSection } from './AutomationRunsSection';
import { replaceSavedDraft } from './replaceSavedDraft';
import { useWorkflowEditGuard } from './useWorkflowEditGuard';
import { WorkflowEditNotFound } from './WorkflowEditNotFound';

const NO_RUNS_YET = 'No runs yet';
const OWNED_PIPELINE_EDITED =
  'Its workflow was changed by hand, so you edit it there.';

/** Opens an automation's own pipeline, coming back to the automation. */
function openOwnedPipeline(pipelineId: string, activityId: string): void {
  useNavigationStore.getState().openWorkflowEdit({
    kind: 'pipeline',
    pipelineId,
    returnTo: { kind: 'automation', activityId },
  });
}
const DEFINITION_BLOCKS_SAVE = 'Fix the issues in Definition, then save.';
const LATEST_EDITS_UNSAVED =
  "Your latest edits aren't saved yet. Save again to keep them.";

/**
 * Why the last save or toggle failed. A blocking field names its
 * section and shows there; a refused request (`section: null`) shows above
 * the sections.
 */
interface AutomationEditError {
  readonly message: string;
  readonly section: AutomationFormSection | null;
  /** Set by a failed menu toggle, so a later successful one clears it. */
  readonly fromToggle?: true;
}

export type AutomationEditAdapterProps = {
  readonly targetKey: string;
  readonly section: WorkflowEditSection;
  readonly backLabel: string;
  readonly automations: AutomationsPageBodyApi;
} & (
  | { readonly kind: 'automation'; readonly activityId: string }
  | { readonly kind: 'automation-draft'; readonly seed?: AutomationDraftSeed }
);

function setSection(section: WorkflowEditSection): void {
  useNavigationStore.getState().setWorkflowEditSection(section);
}

function goBack(): void {
  useNavigationStore.getState().closeWorkflowEdit();
}

/**
 * One automation in the Workflows edit shell (CAN-4072): the form split into
 * Definition and Trigger over one draft, and the run history in Runs. A new
 * draft and a saved automation share this adapter; a draft that saves swaps
 * to its saved id without asking.
 */
export function AutomationEditAdapter(
  props: AutomationEditAdapterProps,
): JSX.Element {
  const { automations } = props;
  const activityId = props.kind === 'automation' ? props.activityId : null;
  const activity = useMemo(
    () =>
      activityId === null
        ? null
        : (automations.activities.find((entry) => entry.id === activityId) ??
          null),
    [activityId, automations.activities],
  );

  // The automation last shown. A workspace-context change empties the list
  // and loads it again; the open editor and its unsaved edits stay meanwhile.
  const [lastShown, setLastShown] = useState(activity);
  if (activity !== null && activity !== lastShown) setLastShown(activity);
  const shown =
    activity ??
    (automations.loading && lastShown?.id === activityId ? lastShown : null);

  if (activityId !== null && shown === null) {
    if (automations.loading) {
      return (
        <WorkflowEditNotFound
          kind="automation"
          loading
          backLabel={props.backLabel}
        />
      );
    }
    return (
      <WorkflowEditNotFound kind="automation" backLabel={props.backLabel} />
    );
  }
  return (
    <AutomationEditor
      key={props.targetKey}
      {...props}
      activity={shown}
      seed={props.kind === 'automation-draft' ? props.seed : undefined}
    />
  );
}

interface AutomationEditorProps {
  readonly targetKey: string;
  readonly section: WorkflowEditSection;
  readonly backLabel: string;
  readonly automations: AutomationsPageBodyApi;
  /** Null for a new draft. */
  readonly activity: ScheduledActivity | null;
  readonly seed?: AutomationDraftSeed;
}

function initialFormState(
  activity: ScheduledActivity | null,
  seed: AutomationDraftSeed | undefined,
): FormState {
  return activity
    ? activityToFormState(activity)
    : automationDraftFromSeed(seed);
}

function AutomationEditor({
  targetKey,
  section,
  backLabel,
  automations,
  activity,
  seed,
}: AutomationEditorProps): JSX.Element {
  const capabilities = useCapabilities();
  const projects = useProjectsStore((s) => s.projects);
  const createActivity = useAutomationsStore((s) => s.createActivity);
  const updateActivity = useAutomationsStore((s) => s.updateActivity);
  const deleteActivity = useAutomationsStore((s) => s.deleteActivity);
  const recentRuns = useAutomationsStore((s) => s.recentRuns);

  const [state, setState] = useState<FormState>(() =>
    initialFormState(activity, seed),
  );
  // The clean form. Mount normalizations move it along with the form, so a
  // freshly opened automation is never dirty.
  const [baseline, setBaseline] = useState<FormState>(state);
  const stateRef = useRef(state);
  stateRef.current = state;
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<AutomationEditError | null>(null);
  const [canSubmit, setCanSubmit] = useState(true);
  const canSubmitRef = useRef(canSubmit);
  canSubmitRef.current = canSubmit;
  // Once Definition stops blocking, its "fix the issues" message is stale.
  useEffect(() => {
    if (!canSubmit) return;
    setError((current) =>
      current?.message === DEFINITION_BLOCKS_SAVE ? null : current,
    );
  }, [canSubmit]);
  const [deleting, setDeleting] = useState(false);
  // The header toggle's write while it is in flight, resolving to its error
  // if it failed; a Save waits for it.
  const toggleRef = useRef<Promise<string | null> | null>(null);
  const definitionRef = useRef<ActivityFormBodyHandle>(null);
  const triggerRef = useRef<ActivityFormBodyHandle>(null);

  const draft = activity === null;
  const baselineSnapshot = useMemo(
    () => automationFormSnapshot(baseline),
    [baseline],
  );
  const dirty = automationFormSnapshot(state) !== baselineSnapshot;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Another surface changed the saved automation (the side panel's toggle,
  // another window, sync). A clean form follows it; local edits win.
  const lastActivityRef = useRef(activity);
  useEffect(() => {
    if (activity === null || lastActivityRef.current === activity) return;
    lastActivityRef.current = activity;
    if (dirtyRef.current) return;
    const next = activityToFormState(activity);
    setState(next);
    setBaseline(next);
  }, [activity]);

  const handleChange = useCallback(
    (next: FormState, meta: ActivityFormChangeMeta): void => {
      const clean =
        automationFormSnapshot(stateRef.current) ===
        automationFormSnapshot(baselineRef.current);
      stateRef.current = next;
      setState(next);
      if (meta.origin === 'mount' && clean) {
        // The ref moves now too, so a second normalization in this commit
        // still compares against the moved baseline.
        baselineRef.current = next;
        setBaseline(next);
      }
    },
    [],
  );

  const runSave = useCallback(async (): Promise<UnsavedChangesSaveResult> => {
    // A late If Command answer would make the saved form dirty again.
    triggerRef.current?.cancelPendingGenerations();
    // The Definition body blocks Save on checks only it can make (a pending
    // or invalid prompt, a chat that is gone). The unsaved-changes prompt
    // saves through here, so it honors them too.
    if (!canSubmitRef.current) {
      setError({ message: DEFINITION_BLOCKS_SAVE, section: 'definition' });
      if (section !== 'definition') setSection('definition');
      // Shown in Definition (above), not as the prompt's request error, so
      // it clears once Definition stops blocking.
      return { ok: false };
    }
    // A Save started while the toggle is writing `enabled` sends the toggled
    // value instead of reverting it.
    const toggling = toggleRef.current;
    const toggleError =
      toggling === null ? null : await toggling.catch(() => null);
    const current = stateRef.current;
    const built = buildAutomationMutationRequest(current);
    if (!built.ok) {
      setError({ message: built.error, section: built.section });
      // The blocking field is in the other section: show it.
      if (built.section !== section) setSection(built.section);
      return { ok: false, message: built.error };
    }
    // A toggle that failed while this save waited keeps its error.
    setError(
      toggleError === null
        ? null
        : { message: toggleError, section: null, fromToggle: true },
    );
    setSaving(true);
    const response =
      built.mode === 'create'
        ? await createActivity(built.request)
        : await updateActivity(built.request);
    setSaving(false);
    if (!response.ok) {
      setError({ message: response.error, section: null });
      return { ok: false, message: response.error };
    }
    setBaseline(current);
    baselineRef.current = current;
    const saved = response.activity;
    if (built.mode === 'create' && saved) {
      // The draft now has an id: same shell, no prompt, and the history
      // entry is replaced rather than pushed.
      replaceSavedDraft(targetKey, {
        kind: 'automation',
        activityId: saved.id,
      });
    }
    return { ok: true };
  }, [createActivity, section, targetKey, updateActivity]);

  // One save at a time. A second request while one is in flight (the
  // unsaved-changes prompt's Save, ⌘S) joins it, so a draft is never
  // created twice.
  const pendingSaveRef = useRef<Promise<UnsavedChangesSaveResult> | null>(null);
  const save = useCallback((): Promise<UnsavedChangesSaveResult> => {
    const inFlight = pendingSaveRef.current;
    if (inFlight !== null) {
      // The joined save wrote the form as it was when it started. On a saved
      // automation, edits made since are still unsaved, so a caller about to
      // leave must not. (A draft remounts as its saved automation instead.)
      return inFlight.then((result) =>
        result.ok &&
        automationFormSnapshot(stateRef.current) !==
          automationFormSnapshot(baselineRef.current)
          ? { ok: false, message: LATEST_EDITS_UNSAVED }
          : result,
      );
    }
    const pending = runSave().finally(() => {
      pendingSaveRef.current = null;
    });
    pendingSaveRef.current = pending;
    return pending;
  }, [runSave]);

  const discard = useCallback((): void => {
    setState(baselineRef.current);
  }, []);

  const guard = useWorkflowEditGuard({
    isDirty: dirty,
    save,
    discard,
    targetKey,
  });

  const handleSave = useCallback((): void => {
    // The Definition body runs its own checks first (a pending prompt
    // editor, an unresolved chat). Without it nothing in it can block.
    if (definitionRef.current) {
      void definitionRef.current.submit();
      return;
    }
    void save();
  }, [save]);

  const handleToggle = useCallback(
    (next: boolean): void => {
      if (activity === null) {
        setState((current) => ({ ...current, enabled: next }));
        return;
      }
      // Only `enabled` is written: other unsaved edits stay unsaved, and the
      // next Save keeps this toggle because the baseline moves with it.
      if (toggleRef.current !== null) return;
      toggleRef.current = updateActivity({ id: activity.id, enabled: next })
        .then((response): string | null => {
          if (!response.ok) {
            setError({
              message: response.error,
              section: null,
              fromToggle: true,
            });
            return response.error;
          }
          setError((current) => (current?.fromToggle ? null : current));
          // The refs move now, so a Save waiting on this write reads them.
          stateRef.current = { ...stateRef.current, enabled: next };
          baselineRef.current = { ...baselineRef.current, enabled: next };
          setState((current) => ({ ...current, enabled: next }));
          setBaseline((current) => ({ ...current, enabled: next }));
          return null;
        })
        .finally(() => {
          toggleRef.current = null;
        });
    },
    [activity, updateActivity],
  );

  // The shell confirms first, and shows a refusal in its confirmation.
  const handleDelete = useCallback(
    async (activityId: string): Promise<void> => {
      setDeleting(true);
      try {
        const response = await deleteActivity(activityId);
        if (!response.ok) throw new Error(response.error);
        // Nothing is left to save, so leaving never asks.
        setBaseline(stateRef.current);
        dirtyRef.current = false;
        guard.runWithoutNavigationGuard(goBack);
      } finally {
        setDeleting(false);
      }
    },
    [deleteActivity, guard],
  );

  const chatTarget = useAutomationChatTargetAvailability(activity);
  const runActive =
    activity !== null &&
    recentRuns.some(
      (run) => run.activityId === activity.id && run.status === 'running',
    );
  const running =
    activity !== null && automations.runningActivityId === activity.id;

  const plan = resolveWorkflowEditPlan({
    kind: 'automation',
    readOnly: false,
    dirty,
    saving: saving || deleting,
    draft,
    canSubmit,
    userOwned: true,
    shareable: activity?.action.type !== 'pipeline_execution_resume',
    capabilities,
  });
  const runAction = plan.actions.run;
  const planWithRun =
    runAction.visible &&
    !runAction.disabled &&
    (runActive || chatTarget.blocked)
      ? {
          ...plan,
          actions: {
            ...plan.actions,
            run: { ...runAction, disabled: true },
          },
        }
      : plan;

  useCurrentUiStateReporter('workflows.editShell', {
    kind: 'automation',
    ...(activity ? { id: activity.id } : {}),
    section,
    dirty,
    readonly: false,
    draft,
  });

  const name = state.name.trim() || (draft ? 'New automation' : 'Automation');
  // A save from the unsaved-changes prompt that failed shows here too.
  const shownError: AutomationEditError | null =
    error ?? (guard.error ? { message: guard.error, section: null } : null);

  const renderSection = (id: WorkflowEditSection): JSX.Element => {
    if (id === 'runs') {
      if (activity === null) {
        return (
          <p className="text-s fg-tertiary" data-testid="workflow-edit-no-runs">
            {NO_RUNS_YET}
          </p>
        );
      }
      return (
        <AutomationRunsSection activity={activity} automations={automations} />
      );
    }
    const fieldGroup = id === 'definition' ? 'definition' : 'trigger';
    // CAN-4551: a converted chat automation's Definition opens with the
    // workflow it runs as; a hand-edited workflow is changed there instead.
    const owned = id === 'definition' ? activity?.ownedPipeline : undefined;
    if (owned && activity && !owned.chatEditable) {
      return (
        <Notice
          intent="neutral"
          data-testid="start-chat-summary-hand-edited"
          actions={
            <NoticeButton
              data-testid="start-chat-summary-open-workflow"
              onClick={(): void =>
                openOwnedPipeline(owned.pipelineId, activity.id)
              }
            >
              Open workflow
            </NoticeButton>
          }
        >
          {OWNED_PIPELINE_EDITED}
        </Notice>
      );
    }
    const openWorkflow =
      owned && activity ? (
        <Button
          variant="secondary"
          size="compact"
          data-testid="start-chat-summary-open-workflow"
          onClick={(): void => openOwnedPipeline(owned.pipelineId, activity.id)}
        >
          Open workflow
        </Button>
      ) : undefined;
    const built = owned ? buildAutomationMutationRequest(state) : undefined;
    const summary =
      owned && activity
        ? startChatSummaryView(
            state.name,
            built?.ok && built.request.action
              ? built.request.action
              : activity.action,
            (projectId) => {
              const project = projects.find((entry) => entry.id === projectId);
              return project ? getWorkspaceDisplayName(project) : undefined;
            },
          )
        : null;
    const body = (
      <ActivityFormBody
        state={state}
        saving={saving}
        projects={projects}
        scope={automations.scope}
        error={shownError?.section === fieldGroup ? shownError.message : null}
        onChange={handleChange}
        onSubmit={async (): Promise<void> => {
          await save();
        }}
        fieldGroup={fieldGroup}
        // A saved automation turns on and off from the shell's menu; a draft
        // sets it here, saved with the rest.
        showEnabledField={draft}
        {...(id === 'definition'
          ? {
              handleRef: definitionRef,
              onSubmitAvailabilityChange: setCanSubmit,
            }
          : { handleRef: triggerRef })}
      />
    );
    return summary ? (
      <div className="flex flex-col gap-6">
        <StartChatSummary
          destination={summary.destination}
          steps={summary.steps}
          actions={openWorkflow}
        />
        {body}
      </div>
    ) : (
      body
    );
  };

  // A refused request is not about one field, so it shows above the
  // sections, whichever one is open.
  const requestError =
    shownError !== null && shownError.section === null ? (
      <Notice intent="destructive" data-testid="automations-form-error">
        {shownError.message}
      </Notice>
    ) : null;
  const reviewNotice = activity?.sharedPipelineReview ? (
    <Notice
      intent="attention"
      data-testid="automation-details-review-notice"
      actions={
        <NoticeButton
          variant="primary"
          onClick={(): void => void automations.runNow(activity)}
          data-testid="automation-details-review-pipeline"
        >
          Review
        </NoticeButton>
      }
    >
      {SHARED_PIPELINE_REVIEW_NEEDED_MESSAGE}
    </Notice>
  ) : null;
  const notices =
    requestError !== null || reviewNotice !== null ? (
      <>
        {requestError}
        {reviewNotice}
      </>
    ) : undefined;

  return (
    <WorkflowEditShell
      kind="automation"
      name={name}
      backLabel={backLabel}
      onBack={goBack}
      plan={planWithRun}
      section={section}
      onSectionChange={setSection}
      renderSection={renderSection}
      targetKey={targetKey}
      notices={notices}
      onSave={handleSave}
      // Run and Share stay in place on a draft, disabled until it is saved.
      onRun={(): void => {
        if (activity !== null) void automations.runNow(activity);
      }}
      onShare={(): void => {
        if (activity !== null) automations.share(activity);
      }}
      {...(activity !== null
        ? { onDelete: (): Promise<void> => handleDelete(activity.id) }
        : {})}
      enabled={state.enabled}
      onToggleEnabled={handleToggle}
      actionLabels={{
        run: 'Run now',
        save: draft ? 'Create automation' : 'Save',
      }}
      actionTestIds={{
        save: 'automations-form-submit',
        run: 'automation-details-run-now',
        share: 'automation-details-share',
        toggle: 'automations-form-enabled',
        delete: 'automation-details-delete',
      }}
      busyActions={{ save: saving, run: running }}
      unsavedPrompt={guard.prompt}
    />
  );
}
