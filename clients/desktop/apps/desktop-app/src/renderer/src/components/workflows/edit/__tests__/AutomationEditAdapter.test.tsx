/**
 * @jest-environment jsdom
 *
 * One automation in the Workflows edit shell (CAN-4072): the cross-cutting
 * rules for Back, Delete, the enable toggle, failed saves, external changes,
 * a missing item, a draft that saves, dirty-gated Run, and the Runs section.
 * The form fields themselves are pinned in `AutomationEditAdapter.form.test`.
 */
import { act, createElement, type ReactElement } from 'react';
import type {
  AutomationRunHistoryResponse,
  AutomationMutationResponse,
} from '@canopy/desktop-shared/types';
import type { ConfigurationChatComposerProps } from '@/components/shared/ConfigurationChatComposer.types';
import { WORKFLOW_EDIT_RUN_DIRTY_REASON } from '@canopy/ui-app/workflows';
import { useExecutionFeedStore } from '@/lib/workflows/execution-feed';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  activity,
  installAutomationEditEnvironment,
  run,
} from './automationEditHarness';

jest.mock('@/components/settings/AuthLoginModal', () => ({
  AuthLoginModal: (): null => null,
}));

jest.mock('@/components/shared/ConfigurationChatComposer', () => ({
  ConfigurationChatComposer: (
    props: ConfigurationChatComposerProps,
  ): ReactElement =>
    createElement('textarea', {
      'data-testid': props.dataTestId,
      value: props.value.prompt,
      readOnly: props.readOnly,
      onChange: (event: { target: { value: string } }) =>
        props.onChange({ ...props.value, prompt: event.target.value }),
    }),
}));

// The Share dialog has its own suite; here it only has to open.
jest.mock('@/components/automations/ShareAutomationModal', () => ({
  ShareAutomationModal: (props: { activity: { id: string } }): ReactElement =>
    createElement('div', {
      'data-testid': 'share-automation-modal',
      'data-activity-id': props.activity.id,
    }),
}));

// The pipeline picker and the pipeline's scopes come from the host; the
// target-requirement case picks a pipeline that runs in either project kind.
jest.mock('@/components/activity/PipelineTriggerModal', () => ({
  PipelineTriggerModal: (props: {
    onRun: (...args: unknown[]) => Promise<void>;
  }): ReactElement =>
    createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'pipeline-trigger-modal-pick',
        onClick: (): void => {
          void props.onRun(
            'release',
            {
              info: {
                id: 'release',
                name: 'Release',
                source: 'user',
                filename: 'release.yaml',
              },
              content: { model_aliases: [], plugin_collections: [] },
            },
            undefined,
            undefined,
            { preferences: {} },
          );
        },
      },
      'Pick',
    ),
}));
jest.mock('@/lib/automationTargets', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '@/lib/automationTargets',
  );
  return {
    ...actual,
    resolveAutomationPipelineScopes: jest.fn(() =>
      Promise.resolve({
        status: 'resolved',
        scopes: ['directory', 'worktree'],
      }),
    ),
  };
});

const env = installAutomationEditEnvironment();

function seed(...activities: ReturnType<typeof activity>[]): void {
  useAutomationsStore.setState({ activities });
}

function navigation(): ReturnType<typeof useNavigationStore.getState> {
  return useNavigationStore.getState();
}

function unsavedDialog(): HTMLElement | null {
  return env.byTestId('workflows-unsaved-dialog');
}

async function editName(value: string): Promise<void> {
  await env.type('automations-form-name', value);
}

/** The run rows a Runs section lists, by key, in display order. */
function runRowKeys(section: HTMLElement | null): string[] {
  return Array.from(
    section?.querySelectorAll<HTMLElement>(
      '[data-testid="workflows-run-row"]',
    ) ?? [],
  ).map((row) => row.dataset.runKey ?? '');
}

describe('AutomationEditAdapter — leaving', () => {
  it('asks before Back with unsaved edits and leaves on Discard', async () => {
    seed(activity());
    env.render();
    await env.openEdit('activity-1');
    expect(env.shell()?.getAttribute('data-dirty')).toBe('false');

    await editName('Renamed review');
    expect(env.shell()?.getAttribute('data-dirty')).toBe('true');

    await env.click('workflow-edit-back');
    expect(unsavedDialog()).not.toBeNull();
    expect(navigation().workflowEdit?.kind).toBe('automation');

    await env.click('workflows-unsaved-discard');
    expect(unsavedDialog()).toBeNull();
    expect(navigation().workflowEdit).toBeUndefined();
    expect(env.byTestId('workflows-tabs-stub')).not.toBeNull();
    expect(env.updateMock).not.toHaveBeenCalled();
  });

  it('leaves at once from a clean form', async () => {
    seed(activity());
    env.render();
    await env.openEdit('activity-1');

    await env.click('workflow-edit-back');
    expect(unsavedDialog()).toBeNull();
    expect(navigation().workflowEdit).toBeUndefined();
  });

  it('keeps the edits when the user keeps editing', async () => {
    seed(activity());
    env.render();
    await env.openEdit('activity-1');
    await editName('Renamed review');

    await env.click('workflow-edit-back');
    const close = document.querySelector(
      '[data-testid="workflows-unsaved-cancel"]',
    );
    if (!(close instanceof HTMLElement)) throw new Error('missing close');
    await act(async () => {
      close.click();
      await Promise.resolve();
    });
    await env.settle();

    expect(unsavedDialog()).toBeNull();
    expect(navigation().workflowEdit?.kind).toBe('automation');
    expect(env.input('automations-form-name').value).toBe('Renamed review');
  });

  it('asks before opening another item over unsaved edits', async () => {
    seed(activity(), activity({ id: 'activity-2', name: 'Evening digest' }));
    env.render();
    await env.openEdit('activity-1');
    await editName('Renamed review');

    await env.openEdit('activity-2');
    expect(unsavedDialog()).not.toBeNull();
    expect(navigation().workflowEdit).toEqual(
      expect.objectContaining({ activityId: 'activity-1' }),
    );

    await env.click('workflows-unsaved-discard');
    expect(navigation().workflowEdit).toEqual(
      expect.objectContaining({ activityId: 'activity-2' }),
    );
    expect(env.input('automations-form-name').value).toBe('Evening digest');
  });

  it('saves from the prompt, then leaves', async () => {
    seed(activity());
    env.render();
    await env.openEdit('activity-1');
    await editName('Renamed review');

    await env.click('workflow-edit-back');
    await env.click('workflows-unsaved-save');

    expect(env.updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'activity-1', name: 'Renamed review' }),
    );
    expect(unsavedDialog()).toBeNull();
    expect(navigation().workflowEdit).toBeUndefined();
  });
});

/** Picks a row from the shell's More menu, which closes after a pick. */
async function chooseMenuItem(testId: string): Promise<void> {
  await env.click('workflow-edit-more');
  await env.click(testId);
}

describe('AutomationEditAdapter — Delete', () => {
  it('confirms in a dialog and never asks about unsaved edits', async () => {
    seed(activity());
    env.render();
    await env.openEdit('activity-1');
    await editName('Renamed review');

    await chooseMenuItem('automation-details-delete');
    expect(env.deleteMock).not.toHaveBeenCalled();
    expect(env.byTestId('workflow-edit-delete-dialog')).not.toBeNull();

    await env.click('automation-details-delete-confirm');
    expect(env.deleteMock).toHaveBeenCalledWith({ id: 'activity-1' });
    expect(unsavedDialog()).toBeNull();
    expect(navigation().workflowEdit).toBeUndefined();
  });

  it('stays open and says why when the delete is refused', async () => {
    seed(activity());
    env.deleteMock.mockResolvedValue({
      ok: false,
      error: 'Activity is running.',
    });
    env.render();
    await env.openEdit('activity-1', 'runs');

    await chooseMenuItem('automation-details-delete');
    await env.click('automation-details-delete-confirm');

    expect(navigation().workflowEdit?.kind).toBe('automation');
    // The confirmation stays open with the refusal, so Delete can be retried.
    expect(env.byTestId('confirm-dialog-error')?.textContent).toBe(
      'Activity is running.',
    );
    expect(
      env
        .byTestId('automation-details-delete-confirm')
        ?.hasAttribute('disabled'),
    ).toBe(false);
  });

  it('keeps Delete off while a save runs', async () => {
    seed(activity());
    let finishSave: (response: AutomationMutationResponse) => void = () =>
      undefined;
    env.updateMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    env.render();
    await env.openEdit('activity-1');
    await editName('Renamed review');

    await env.click('automations-form-submit');
    await env.click('workflow-edit-more');
    expect(
      env.byTestId('automation-details-delete')?.hasAttribute('disabled'),
    ).toBe(true);

    finishSave({ ok: true, activity: activity({ name: 'Renamed review' }) });
    await env.settle();
    expect(
      env.byTestId('automation-details-delete')?.hasAttribute('disabled'),
    ).toBe(false);
  });
});

describe('AutomationEditAdapter — enable toggle', () => {
  it('writes only `enabled` while other edits stay unsaved, and Save keeps it', async () => {
    seed(activity({ enabled: true }));
    env.updateMock.mockResolvedValue({
      ok: true,
      activity: activity({ enabled: false }),
    });
    env.render();
    await env.openEdit('activity-1');
    await editName('Renamed review');

    await env.click('workflow-edit-more');
    expect(env.byTestId('automations-form-enabled')?.textContent).toBe(
      'Turn off',
    );

    await env.click('automations-form-enabled');
    expect(env.updateMock).toHaveBeenCalledTimes(1);
    expect(env.updateMock.mock.calls[0]?.[0]).toEqual({
      id: 'activity-1',
      enabled: false,
    });
    expect(env.byTestId('workflow-edit-enabled-state')?.textContent).toBe(
      'Off',
    );
    expect(env.shell()?.getAttribute('data-dirty')).toBe('true');
    expect(env.input('automations-form-name').value).toBe('Renamed review');

    await env.click('automations-form-submit');
    expect(env.updateMock).toHaveBeenCalledTimes(2);
    expect(env.updateMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        id: 'activity-1',
        name: 'Renamed review',
        enabled: false,
      }),
    );
    expect(env.shell()?.getAttribute('data-dirty')).toBe('false');
  });

  it('saves the toggled value when Save starts while the toggle is writing', async () => {
    seed(activity({ enabled: true }));
    let finishToggle: (response: AutomationMutationResponse) => void = () =>
      undefined;
    env.updateMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishToggle = resolve;
          }),
      )
      .mockResolvedValue({ ok: true, activity: activity({ enabled: false }) });
    env.render();
    await env.openEdit('activity-1');
    await editName('Renamed review');

    await chooseMenuItem('automations-form-enabled');
    await env.click('automations-form-submit');
    // The save waits for the toggle instead of sending the old value.
    expect(env.updateMock).toHaveBeenCalledTimes(1);

    finishToggle({ ok: true, activity: activity({ enabled: false }) });
    await env.settle();

    expect(env.updateMock).toHaveBeenCalledTimes(2);
    expect(env.updateMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ name: 'Renamed review', enabled: false }),
    );
    expect(env.shell()?.getAttribute('data-dirty')).toBe('false');
  });

  it('keeps the toggle’s error when a waiting Save goes ahead', async () => {
    seed(activity({ enabled: true }));
    let finishToggle: (response: AutomationMutationResponse) => void = () =>
      undefined;
    env.updateMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishToggle = resolve;
          }),
      )
      .mockResolvedValue({ ok: true, activity: activity({ enabled: true }) });
    env.render();
    await env.openEdit('activity-1');
    await editName('Renamed review');

    await chooseMenuItem('automations-form-enabled');
    await env.click('automations-form-submit');
    finishToggle({
      ok: false,
      error: 'The automation could not be turned off.',
    });
    await env.settle();

    // The save sends the value that stuck, and the toggle's failure stays.
    expect(env.updateMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ name: 'Renamed review', enabled: true }),
    );
    expect(env.byTestId('automations-form-error')?.textContent).toBe(
      'The automation could not be turned off.',
    );
  });

  it('clears a failed toggle’s error once a retry succeeds', async () => {
    seed(activity({ enabled: true }));
    env.updateMock
      .mockResolvedValueOnce({
        ok: false,
        error: 'The automation could not be turned off.',
      })
      .mockResolvedValue({ ok: true, activity: activity({ enabled: false }) });
    env.render();
    await env.openEdit('activity-1');

    await chooseMenuItem('automations-form-enabled');
    expect(env.byTestId('automations-form-error')?.textContent).toBe(
      'The automation could not be turned off.',
    );

    await chooseMenuItem('automations-form-enabled');
    expect(env.byTestId('automations-form-error')).toBeNull();
  });

  it('leaves a clean form clean after a toggle', async () => {
    seed(activity({ enabled: false }));
    env.render();
    await env.openEdit('activity-1');

    await chooseMenuItem('automations-form-enabled');
    expect(env.updateMock.mock.calls[0]?.[0]).toEqual({
      id: 'activity-1',
      enabled: true,
    });
    expect(env.shell()?.getAttribute('data-dirty')).toBe('false');
  });

  it('sets Enabled in the form on a draft without writing anything', async () => {
    env.render();
    await env.openDraft();
    // A draft has nothing to turn on or off yet: no menu, no Off state.
    expect(env.byTestId('workflow-edit-more')).toBeNull();
    expect(env.byTestId('workflow-edit-enabled-state')).toBeNull();
    const checked = (): boolean => {
      const field = env.byTestId('automations-form-enabled');
      if (field?.getAttribute('role') !== 'switch')
        throw new Error('no switch');
      return field.getAttribute('aria-checked') === 'true';
    };
    const before = checked();

    await env.click('automations-form-enabled');
    expect(env.updateMock).not.toHaveBeenCalled();
    expect(checked()).toBe(!before);
  });
});

describe('AutomationEditAdapter — failed saves', () => {
  it('drops the navigation, shows the error and stays dirty when the prompt’s save fails', async () => {
    seed(activity());
    env.updateMock.mockResolvedValue({
      ok: false,
      error: 'The project is in another organization.',
    });
    env.render();
    await env.openEdit('activity-1');
    await editName('Renamed review');

    await env.click('workflow-edit-back');
    await env.click('workflows-unsaved-save');

    expect(env.updateMock).toHaveBeenCalledTimes(1);
    expect(unsavedDialog()).toBeNull();
    expect(env.byTestId('automations-form-error')?.textContent).toBe(
      'The project is in another organization.',
    );
    expect(env.shell()?.getAttribute('data-dirty')).toBe('true');
    expect(navigation().workflowEdit?.kind).toBe('automation');
  });

  it('shows a refused save from any section', async () => {
    seed(activity());
    env.updateMock.mockResolvedValue({ ok: false, error: 'Refused.' });
    env.render();
    await env.openEdit('activity-1', 'trigger');
    await env.type('automations-form-cron', '0 10 * * *');

    await env.click('automations-form-submit');
    expect(env.section('trigger')?.hidden).toBe(false);
    expect(env.byTestId('automations-form-error')?.textContent).toBe(
      'Refused.',
    );
  });

  it('keeps edits made during an in-flight save when the prompt joins it', async () => {
    seed(activity());
    let finishUpdate: () => void = () => undefined;
    env.updateMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpdate = (): void => resolve({ ok: true });
        }),
    );
    env.render();
    await env.openEdit('activity-1');
    await editName('Renamed review');

    await env.click('automations-form-submit');
    await editName('Renamed again');
    await env.click('workflow-edit-back');
    await env.click('workflows-unsaved-save');
    await act(async () => {
      finishUpdate();
      await Promise.resolve();
    });
    await env.settle();

    // The joined save wrote the earlier name, so leaving would drop the
    // newer one: the shell stays, still dirty.
    expect(env.updateMock).toHaveBeenCalledTimes(1);
    expect(navigation().workflowEdit?.kind).toBe('automation');
    expect(env.shell()?.getAttribute('data-dirty')).toBe('true');
    expect(env.input('automations-form-name').value).toBe('Renamed again');
    expect(env.byTestId('automations-form-error')?.textContent).toBe(
      "Your latest edits aren't saved yet. Save again to keep them.",
    );
  });

  it('switches to the section that holds the blocking field', async () => {
    env.render();
    await env.openDraft();
    await env.showSection('trigger');

    // The draft has no prompt yet: Definition blocks the save.
    await env.click('automations-form-submit');
    expect(env.createMock).not.toHaveBeenCalled();
    expect(navigation().workflowEdit?.section).toBe('definition');
    expect(env.section('definition')?.hidden).toBe(false);
    expect(env.section('trigger')?.hidden).toBe(true);
    expect(
      env
        .section('definition')
        ?.querySelector('[data-testid="automations-form-error"]'),
    ).not.toBeNull();
  });

  it('switches to Trigger for an invalid schedule saved from Definition', async () => {
    seed(activity());
    env.render();
    await env.openEdit('activity-1', 'trigger');
    await env.type('automations-form-cron', '* * * * * *');
    await env.showSection('definition');

    await env.click('automations-form-submit');
    expect(env.updateMock).not.toHaveBeenCalled();
    expect(navigation().workflowEdit?.section).toBe('trigger');
    expect(
      env
        .section('trigger')
        ?.querySelector('[data-testid="automations-form-error"]')?.textContent,
    ).toContain('5 fields');
  });
});

describe('AutomationEditAdapter — external changes', () => {
  it('follows the store while clean', async () => {
    seed(activity());
    env.render();
    await env.openEdit('activity-1');

    await act(async () => {
      seed(activity({ name: 'Renamed elsewhere', enabled: false }));
      await Promise.resolve();
    });
    await env.settle();

    expect(env.input('automations-form-name').value).toBe('Renamed elsewhere');
    expect(env.byTestId('workflow-edit-enabled-state')?.textContent).toBe(
      'Off',
    );
    expect(env.shell()?.getAttribute('data-dirty')).toBe('false');
  });

  it('keeps local edits over a store change while dirty', async () => {
    seed(activity());
    env.render();
    await env.openEdit('activity-1');
    await editName('My edit');

    await act(async () => {
      seed(activity({ name: 'Renamed elsewhere' }));
      await Promise.resolve();
    });
    await env.settle();

    expect(env.input('automations-form-name').value).toBe('My edit');
    expect(env.shell()?.getAttribute('data-dirty')).toBe('true');

    await env.click('automations-form-submit');
    expect(env.updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'My edit' }),
    );
  });
});

// CAN-4551: a converted chat automation opens with the workflow it runs as.
describe('AutomationEditAdapter — converted chat automations', () => {
  it('summarizes the workflow over the chat form, and opens it', async () => {
    seed(
      activity({
        ownedPipeline: {
          pipelineId: 'owned-1',
          chatEditable: true,
          storedAction: {
            type: 'standalone_prompt',
            chatProjectId: 'storefront',
            prompt: 'x',
          },
        },
      }),
    );
    env.render();
    await env.openEdit('activity-1');

    expect(env.byTestId('start-chat-summary-destination')?.textContent).toBe(
      'Start chat in Orchestrator',
    );
    expect(env.byTestId('start-chat-summary-steps')?.textContent).toContain(
      'Send the prompt',
    );
    // Today's controls still edit the prompt and settings.
    expect(env.input('automations-form-name').value).toBe('Morning review');

    await env.click('start-chat-summary-open-workflow');
    expect(navigation().workflowEdit).toMatchObject({
      kind: 'pipeline',
      pipelineId: 'owned-1',
      returnTo: { kind: 'automation', activityId: 'activity-1' },
    });
  });

  it('sends a hand-edited workflow to its editor instead', async () => {
    seed(
      activity({
        action: {
          type: 'worktree_pipeline',
          target: { kind: 'global' },
          pipelineId: 'owned-1',
          pipelineSource: 'user',
          pipelineName: 'Morning review',
        },
        ownedPipeline: {
          pipelineId: 'owned-1',
          chatEditable: false,
          storedAction: {
            type: 'standalone_prompt',
            chatProjectId: 'storefront',
            prompt: 'x',
          },
        },
      }),
    );
    env.render();
    await env.openEdit('activity-1');

    expect(
      env.byTestId('start-chat-summary-hand-edited')?.textContent,
    ).toContain('Its workflow was changed by hand, so you edit it there.');
    expect(env.byTestId('start-chat-summary')).toBeNull();
  });

  it('keeps the form alone for an automation that owns nothing', async () => {
    seed(activity());
    env.render();
    await env.openEdit('activity-1');

    expect(env.byTestId('start-chat-summary')).toBeNull();
    expect(env.byTestId('start-chat-summary-hand-edited')).toBeNull();
  });
});

describe('AutomationEditAdapter — missing items', () => {
  it('shows not found with Back for a missing id', async () => {
    env.render();
    await env.openEdit('missing-activity');

    const notFound = env.byTestId('workflow-edit-not-found');
    expect(notFound?.getAttribute('data-loading')).toBe('false');
    expect(notFound?.textContent).toContain(
      'This automation no longer exists.',
    );
    expect(env.shell()).toBeNull();

    await env.click('workflow-edit-back');
    expect(navigation().workflowEdit).toBeUndefined();
  });

  it('keeps unsaved edits while the list reloads for a new workspace context', async () => {
    seed(activity());
    env.render();
    await env.openEdit('activity-1');
    await editName('Renamed review');

    // A context change empties the list and loads it again.
    await act(async () => {
      useAutomationsStore.setState({
        activities: [],
        hydrated: false,
        loading: true,
      });
      await Promise.resolve();
    });
    await act(async () => {
      useAutomationsStore.setState({
        activities: [activity()],
        hydrated: true,
        loading: false,
      });
      await Promise.resolve();
    });
    await env.settle();

    expect(env.input('automations-form-name').value).toBe('Renamed review');
    expect(env.shell()?.getAttribute('data-dirty')).toBe('true');
  });

  it('names the item Back returns to when the automation is missing', async () => {
    useAutomationsStore.setState({ hydrated: true, loading: false });
    env.render();
    await act(async () => {
      navigation().openWorkflowEdit({
        kind: 'automation',
        activityId: 'missing',
        returnTo: {
          kind: 'pipeline',
          pipelineId: 'review',
          section: 'trigger',
        },
      });
      await Promise.resolve();
    });
    await env.settle();

    expect(env.byTestId('workflow-edit-not-found')?.textContent).toContain(
      'Workflow',
    );
  });

  it('waits for the first load before calling it missing', async () => {
    useAutomationsStore.setState({ loading: true, hydrated: false });
    env.render();
    await env.openEdit('activity-1');
    expect(
      env.byTestId('workflow-edit-not-found')?.getAttribute('data-loading'),
    ).toBe('true');

    await act(async () => {
      useAutomationsStore.setState({
        loading: false,
        hydrated: true,
        activities: [activity()],
      });
      await Promise.resolve();
    });
    await env.settle();
    expect(env.byTestId('workflow-edit-not-found')).toBeNull();
    expect(env.input('automations-form-name').value).toBe('Morning review');
  });

  it('turns into not found, unguarded, when the item is deleted elsewhere', async () => {
    seed(activity());
    env.render();
    await env.openEdit('activity-1');
    await editName('Unsaved');

    await act(async () => {
      seed();
      await Promise.resolve();
    });
    await env.settle();
    expect(env.byTestId('workflow-edit-not-found')).not.toBeNull();

    await env.click('workflow-edit-back');
    expect(unsavedDialog()).toBeNull();
    expect(navigation().workflowEdit).toBeUndefined();
  });
});

describe('AutomationEditAdapter — drafts', () => {
  it('is not dirty right after it opens', async () => {
    env.render();
    await env.openDraft();
    expect(env.shell()?.getAttribute('data-kind')).toBe('automation');
    expect(env.shell()?.getAttribute('data-dirty')).toBe('false');
    expect(env.byTestId('workflow-edit-save-state')?.textContent).toBe('New');
    expect(env.byTestId('automations-form-submit')?.textContent).toContain(
      'Create automation',
    );

    // Nothing to ask about: Back leaves at once.
    await env.click('workflow-edit-back');
    expect(unsavedDialog()).toBeNull();
    expect(navigation().workflowEdit).toBeUndefined();
  });

  it('opens a seeded draft on its project without asking to save it', async () => {
    env.render();
    await env.openDraft({
      projectId: 'workspace-1',
      isCowork: false,
      existingWorktreeId: 'base-worktree',
    });
    expect(env.byTestId('automations-form-workspace')?.textContent).toContain(
      'Canopy',
    );
    expect(env.shell()?.getAttribute('data-dirty')).toBe('false');
  });

  it('becomes the saved automation without a prompt', async () => {
    const created = activity({ id: 'created-1', name: 'New digest' });
    env.createMock.mockImplementation(() => {
      // The main process broadcasts the new automation before answering.
      useAutomationsStore.setState({ activities: [created] });
      return Promise.resolve({ ok: true, activity: created });
    });
    env.render();
    await env.openDraft();
    // A new draft runs a pipeline with no project; these start from App Advisor.
    await env.click('automations-form-action-type-app_advisor');
    const replaced = navigation().workflowEditReplaceCount;
    await editName('New digest');
    await env.type('automations-form-prompt', 'Summarize today.');

    await env.click('automations-form-submit');
    expect(env.createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'New digest',
        action: { type: 'app_advisor_prompt', prompt: 'Summarize today.' },
      }),
    );
    // The swap waits a tick so a save from the prompt can navigate first.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await env.settle();

    expect(navigation().workflowEdit).toEqual({
      kind: 'automation',
      activityId: 'created-1',
    });
    expect(navigation().workflowEditReplaceCount).toBe(replaced + 1);
    expect(unsavedDialog()).toBeNull();
    expect(env.shell()?.getAttribute('data-dirty')).toBe('false');
    expect(env.byTestId('automations-form-submit')?.textContent).toContain(
      'Save',
    );
    expect(env.input('automations-form-name').value).toBe('New digest');
  });

  it('creates once when the prompt saves while a create is in flight', async () => {
    const created = activity({ id: 'created-1', name: 'New digest' });
    let finishCreate: () => void = () => undefined;
    env.createMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCreate = (): void => {
            useAutomationsStore.setState({ activities: [created] });
            resolve({ ok: true, activity: created });
          };
        }),
    );
    env.render();
    await env.openDraft();
    // A new draft runs a pipeline with no project; these start from App Advisor.
    await env.click('automations-form-action-type-app_advisor');
    await editName('New digest');
    await env.type('automations-form-prompt', 'Summarize today.');

    await env.click('automations-form-submit');
    await env.click('workflow-edit-back');
    await env.click('workflows-unsaved-save');
    await act(async () => {
      finishCreate();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await env.settle();

    expect(env.createMock).toHaveBeenCalledTimes(1);
  });

  it('passes a target requirement set on a new automation to the create request', async () => {
    env.render();
    await env.openDraft();
    await env.click('automations-form-action-type-workspace');
    await env.click('automations-form-workspace');
    const option = Array.from(
      document.body.querySelectorAll('[role="option"]'),
    ).find((candidate) => candidate.textContent?.includes('Canopy'));
    if (!(option instanceof HTMLElement)) throw new Error('missing option');
    await act(async () => {
      option.click();
      await Promise.resolve();
    });
    await env.settle();
    await env.click('automations-form-workspace-action-mode-pipeline');
    await env.click('automations-form-pipeline');
    await env.click('pipeline-trigger-modal-pick');
    await env.settle();

    // The pipeline runs in either kind; allow Code projects only.
    const cowork = env.byTestId('automations-form-target-cowork');
    if (!(cowork instanceof HTMLInputElement)) {
      throw new Error('missing target checkbox');
    }
    await act(async () => {
      cowork.click();
      await Promise.resolve();
    });
    await env.settle();

    await env.click('automations-form-submit');
    expect(env.createMock).toHaveBeenCalledTimes(1);
    expect(env.createMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        targetRequirement: { contexts: ['worktree'] },
        action: expect.objectContaining({
          type: 'worktree_pipeline',
          pipelineId: 'release',
        }) as unknown,
      }),
    );
  });
});

describe('AutomationEditAdapter — header actions', () => {
  it('disables Run with the reason while dirty and runs the saved version when clean', async () => {
    seed(activity());
    env.render();
    await env.openEdit('activity-1');

    await env.click('automation-details-run-now');
    expect(env.runNowMock).toHaveBeenCalledWith({ id: 'activity-1' });

    await editName('Renamed review');
    const run = env.byTestId('automation-details-run-now');
    expect(run?.getAttribute('aria-disabled')).toBe('true');
    expect(run?.getAttribute('aria-description')).toBe(
      WORKFLOW_EDIT_RUN_DIRTY_REASON,
    );
    await env.click('automation-details-run-now');
    expect(env.runNowMock).toHaveBeenCalledTimes(1);
  });

  it('keeps Run disabled while a run is active', async () => {
    seed(activity());
    useAutomationsStore.setState({ recentRuns: [run({ status: 'running' })] });
    env.render();
    await env.openEdit('activity-1');
    const button = env.byTestId('automation-details-run-now');
    if (!(button instanceof HTMLButtonElement)) throw new Error('missing run');
    expect(button.disabled).toBe(true);
  });

  it('keeps Run disabled while an existing-chat destination is gone', async () => {
    seed(
      activity({
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'workspace-missing',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          prompt: 'Continue',
        },
      }),
    );
    env.render();
    await env.openEdit('activity-1');
    const button = env.byTestId('automation-details-run-now');
    if (!(button instanceof HTMLButtonElement)) throw new Error('missing run');
    expect(button.disabled).toBe(true);
  });

  it('shows the shared-pipeline review and routes Run now and Review to it', async () => {
    const resolveSharedPipelineInstallPin = jest.fn().mockResolvedValue({
      installPin: {
        pipelineContentHash: 'b'.repeat(64),
        distributionMode: 'self_contained',
      },
      rawPipeline: 'name: Lint\njobs: {}\n',
    });
    Object.assign(window.api.automations, { resolveSharedPipelineInstallPin });
    seed(
      activity({
        action: {
          type: 'worktree_pipeline',
          workspaceId: 'workspace-1',
          pipelineId: 'shared:canopy-cloud:remote-1',
          pipelineName: 'Lint',
          pipelineSource: 'shared',
          sharedPipeline: { serverId: 'canopy-cloud', remoteId: 'remote-1' },
        },
        sharedPipelineReview: {
          detectedAt: '2026-05-27T00:00:00.000Z',
          remoteId: 'remote-1',
        },
      }),
    );
    env.render();
    await env.openEdit('activity-1', 'runs');

    expect(
      env.byTestId('automation-details-review-notice')?.textContent,
    ).toContain('take a look before it runs again');

    await env.click('automation-details-review-pipeline');
    expect(env.byTestId('shared-pipeline-review-modal')).not.toBeNull();
    expect(env.runNowMock).not.toHaveBeenCalled();
  });

  it('hides Share on a usage-limit resume, and keeps Run and Share disabled on a draft', async () => {
    seed(
      activity({
        action: {
          type: 'pipeline_execution_resume',
          executionId: 'execution-1',
          statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
          provider: 'claude',
          purpose: 'usage_limit_resume',
          pipelineName: 'Release',
        },
      }),
    );
    env.render();
    await env.openEdit('activity-1');
    expect(env.byTestId('automation-details-share')).toBeNull();
    await env.click('workflow-edit-more');
    expect(env.byTestId('automation-details-delete')).not.toBeNull();

    await env.openDraft();
    expect(
      env.byTestId('automation-details-share')?.getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      env.byTestId('automation-details-run-now')?.getAttribute('aria-disabled'),
    ).toBe('true');
    await env.click('automation-details-run-now');
    expect(env.runNowMock).not.toHaveBeenCalled();
    expect(env.byTestId('workflow-edit-more')).toBeNull();
    expect(env.byTestId('automation-details-delete')).toBeNull();
  });

  it('opens the Share dialog for a saved automation', async () => {
    seed(activity());
    env.render();
    await env.openEdit('activity-1');
    await env.click('automation-details-share');
    expect(
      env.byTestId('share-automation-modal')?.getAttribute('data-activity-id'),
    ).toBe('activity-1');
  });
});

describe('AutomationEditAdapter — Runs', () => {
  it('says there are no runs yet for a draft', async () => {
    env.render();
    await env.openDraft();
    await env.showSection('runs');
    expect(env.byTestId('workflow-edit-no-runs')?.textContent).toBe(
      'No runs yet',
    );
    expect(env.byTestId('automation-runs-section')).toBeNull();
    expect(env.listRunsMock).not.toHaveBeenCalled();
  });

  it("lists only this automation's runs, read from its own history", async () => {
    seed(
      activity({
        lastResult: {
          status: 'success',
          completedAt: '2026-05-27T00:00:05.000Z',
        },
      }),
      activity({ id: 'activity-2', name: 'Evening digest' }),
    );
    useAutomationsStore.setState({
      recentRuns: [
        run({ id: 'run-1' }),
        run({
          id: 'run-other',
          activityId: 'activity-2',
          activityName: 'Evening digest',
        }),
      ],
    });
    env.listRunsMock.mockResolvedValue({
      runs: [
        run({
          id: 'run-archived',
          scheduledFor: '2026-05-20T00:00:00.000Z',
          startedAt: '2026-05-20T00:00:00.000Z',
          completedAt: '2026-05-20T00:00:05.000Z',
        }),
      ],
      nextCursor: null,
      totalCount: 1,
    });
    env.render();
    await env.openEdit('activity-1', 'runs');

    const section = env.byTestId('automation-runs-section');
    expect(section).not.toBeNull();
    expect(env.listRunsMock).toHaveBeenCalledWith(
      expect.objectContaining({ activityId: 'activity-1' }),
    );
    expect(env.listRunsMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ activityId: 'activity-2' }),
    );
    expect(runRowKeys(section)).toEqual([
      'automation-run:run-1',
      'automation-run:run-archived',
    ]);
    expect(env.byTestId('workflow-edit-no-runs')).toBeNull();
  });

  it('selects the run a chat tile asked for, once it is listed', async () => {
    seed(activity());
    useAutomationsStore.setState({ recentRuns: [run({ id: 'run-1' })] });
    env.listRunsMock.mockResolvedValue({
      runs: [
        run({
          id: 'run-archived',
          scheduledFor: '2026-05-20T00:00:00.000Z',
          startedAt: '2026-05-20T00:00:00.000Z',
          completedAt: '2026-05-20T00:00:05.000Z',
        }),
      ],
      nextCursor: null,
      totalCount: 1,
    });
    env.render();
    await act(async () => {
      navigation().openAutomationEdit({
        activityId: 'activity-1',
        runId: 'run-archived',
      });
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(env.byTestId('automation-runs-section')).not.toBeNull();
    expect(navigation().workflowEdit).toMatchObject({ section: 'runs' });
    const selected = document.querySelector('[data-highlighted="true"]');
    expect(selected?.getAttribute('data-run-key')).toBe(
      'automation-run:run-archived',
    );
    expect(selected?.getAttribute('aria-current')).toBe('true');
    expect(navigation().pendingAutomationRunFocus).toBeUndefined();
  });

  it('keeps the requested run while a warm feed loads its history', async () => {
    seed(activity());
    useAutomationsStore.setState({ recentRuns: [run({ id: 'run-1' })] });
    useExecutionFeedStore.setState({ loaded: true, loading: false });
    let finishHistory: (
      response: AutomationRunHistoryResponse,
    ) => void = () => {
      throw new Error('History request has not started');
    };
    env.listRunsMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishHistory = resolve;
        }),
    );
    env.render();
    await act(async () => {
      navigation().openAutomationEdit({
        activityId: 'activity-1',
        runId: 'run-archived',
      });
      await Promise.resolve();
    });
    expect(env.listRunsMock).toHaveBeenCalled();
    expect(navigation().pendingAutomationRunFocus).toEqual({
      activityId: 'activity-1',
      runId: 'run-archived',
    });
    await act(async () => {
      finishHistory({
        runs: [run({ id: 'run-archived' })],
        nextCursor: null,
        totalCount: 1,
      });
      await Promise.resolve();
    });
    const selected = document.querySelector('[data-highlighted="true"]');
    expect(selected?.getAttribute('data-run-key')).toBe(
      'automation-run:run-archived',
    );
    expect(navigation().pendingAutomationRunFocus).toBeUndefined();
  });

  it('keeps run focus across older-history pages and a failed retry', async () => {
    seed(activity());
    useAutomationsStore.setState({ recentRuns: [run({ id: 'run-1' })] });
    useExecutionFeedStore.setState({ loaded: true, loading: false });
    env.listRunsMock
      .mockResolvedValueOnce({
        runs: [run({ id: 'run-page-one' })],
        nextCursor: 'page-two',
        totalCount: 3,
      })
      .mockRejectedValueOnce(new Error('History unavailable'))
      .mockResolvedValueOnce({
        runs: [run({ id: 'run-archived' })],
        nextCursor: null,
        totalCount: 3,
      });
    env.render();
    await act(async () => {
      navigation().openAutomationEdit({
        activityId: 'activity-1',
        runId: 'run-archived',
      });
      await Promise.resolve();
    });
    expect(navigation().pendingAutomationRunFocus?.runId).toBe('run-archived');
    await env.click('workflows-runs-load-more');
    expect(env.byTestId('workflows-runs-load-more-error')).not.toBeNull();
    expect(navigation().pendingAutomationRunFocus?.runId).toBe('run-archived');
    await env.click('workflows-runs-load-more');
    expect(env.listRunsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'page-two' }),
    );
    expect(
      document
        .querySelector('[data-highlighted="true"]')
        ?.getAttribute('data-run-key'),
    ).toBe('automation-run:run-archived');
    expect(navigation().pendingAutomationRunFocus).toBeUndefined();
  });

  it('reveals and focuses a requested run beyond the first 100 loaded rows', async () => {
    seed(activity());
    useAutomationsStore.setState({
      recentRuns: Array.from({ length: 100 }, (_, index) =>
        run({ id: `newer-${index}` }),
      ),
    });
    env.listRunsMock.mockResolvedValue({
      runs: [
        run({
          id: 'run-oldest',
          scheduledFor: '2026-01-01T00:00:00.000Z',
          startedAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
      nextCursor: null,
      totalCount: 101,
    });
    env.render();
    await act(async () => {
      navigation().openAutomationEdit({
        activityId: 'activity-1',
        runId: 'run-oldest',
      });
      await Promise.resolve();
    });
    const selected = document.querySelector('[data-highlighted="true"]');
    expect(selected?.getAttribute('data-run-key')).toBe(
      'automation-run:run-oldest',
    );
    expect(document.activeElement).toBe(selected);
    expect(navigation().pendingAutomationRunFocus).toBeUndefined();
  });

  it('focuses a requested non-interactive run already in the rendered batch', async () => {
    seed(activity());
    useAutomationsStore.setState({ recentRuns: [run({ id: 'run-visible' })] });
    env.render();
    await act(async () => {
      navigation().openAutomationEdit({
        activityId: 'activity-1',
        runId: 'run-visible',
      });
      await Promise.resolve();
    });
    const selected = document.querySelector('[data-highlighted="true"]');
    expect(selected?.getAttribute('data-run-key')).toBe(
      'automation-run:run-visible',
    );
    expect(document.activeElement).toBe(selected);
    expect(navigation().pendingAutomationRunFocus).toBeUndefined();
  });

  it('opens Runs without a selection when the run aged out of history', async () => {
    seed(activity());
    useAutomationsStore.setState({ recentRuns: [run({ id: 'run-1' })] });
    env.listRunsMock.mockResolvedValue({
      runs: [],
      nextCursor: null,
      totalCount: 0,
    });
    env.render();
    await act(async () => {
      navigation().openAutomationEdit({
        activityId: 'activity-1',
        runId: 'run-expired',
      });
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(env.byTestId('automation-runs-section')).not.toBeNull();
    expect(navigation().pendingAutomationRunFocus).toBeUndefined();
    expect(document.querySelector('[data-highlighted="true"]')).toBeNull();
  });

  it('shows run history only, not a recap of the definition', async () => {
    seed(activity({ ifCommand: 'test -f ready.txt' }));
    useAutomationsStore.setState({ recentRuns: [run()] });
    env.render();
    await env.openEdit('activity-1', 'runs');

    const section = env.section('runs');
    expect(env.byTestId('automation-runs-section')).not.toBeNull();
    for (const removed of [
      'automation-details-status',
      'automation-details-next-run',
      'automation-details-run-in',
      'automation-details-history',
      'automation-details-run-list',
    ]) {
      expect(env.byTestId(removed)).toBeNull();
    }
    expect(section?.textContent).not.toContain('Summarize the plan.');
    expect(section?.textContent).not.toContain('test -f ready.txt');
  });

  it('does not offer Open in Library, since the Library is behind the shell', async () => {
    seed(activity());
    useAutomationsStore.setState({ recentRuns: [run()] });
    env.render();
    await env.openEdit('activity-1', 'runs');

    const section = env.byTestId('automation-runs-section');
    expect(runRowKeys(section)).toEqual(['automation-run:run-1']);
    expect(
      section?.querySelector(
        '[data-testid="workflows-run-action-open-library"]',
      ),
    ).toBeNull();
    // Open in Library was the run's only other action, so no menu is left.
    expect(
      section?.querySelector('[data-testid="workflows-run-menu"]'),
    ).toBeNull();
  });

  it('says there are no runs yet for an automation that has never run', async () => {
    seed(activity());
    env.render();
    await env.openEdit('activity-1', 'runs');

    expect(env.byTestId('automation-runs-section')).not.toBeNull();
    expect(env.byTestId('workflow-edit-no-runs')?.textContent).toBe(
      'No runs yet',
    );
    expect(env.listRunsMock).not.toHaveBeenCalled();
  });

  it('cancels a cancellable run', async () => {
    seed(activity());
    useAutomationsStore.setState({
      recentRuns: [run({ status: 'running', cancellable: true })],
    });
    env.render();
    await env.openEdit('activity-1', 'runs');

    await env.click('workflows-run-action-cancel');
    expect(env.cancelRunMock).toHaveBeenCalledWith({ runId: 'run-1' });
  });

  it('keeps visited sections mounted and hidden', async () => {
    seed(activity());
    env.render();
    await env.openEdit('activity-1');
    await editName('Renamed review');
    await env.showSection('runs');

    expect(env.section('definition')?.hidden).toBe(true);
    expect(env.section('runs')?.hidden).toBe(false);
    await env.showSection('definition');
    expect(env.input('automations-form-name').value).toBe('Renamed review');
  });
});

describe('AutomationEditAdapter — App Advisor', () => {
  it('reports the shell slice for the open automation', async () => {
    seed(activity());
    env.render();
    await env.openEdit('activity-1', 'runs');
    expect(
      useCurrentUiStateStore.getState().slices['workflows.editShell'],
    ).toEqual({
      kind: 'automation',
      id: 'activity-1',
      section: 'runs',
      dirty: false,
      readonly: false,
      draft: false,
    });

    await env.openDraft();
    expect(
      useCurrentUiStateStore.getState().slices['workflows.editShell'],
    ).toEqual({
      kind: 'automation',
      section: 'definition',
      dirty: false,
      readonly: false,
      draft: true,
    });
  });
});
