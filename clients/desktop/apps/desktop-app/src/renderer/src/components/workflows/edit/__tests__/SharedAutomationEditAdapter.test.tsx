/**
 * @jest-environment jsdom
 *
 * A shared automation that is not added yet, read-only in the Workflows edit
 * shell (CAN-4072): it loads the share, offers Duplicate as its one action,
 * and the duplicate opens as the user's own automation.
 */
import { act, createElement, type ReactElement } from 'react';
import type { SharedAutomationDetail } from '@canopy/protocol/automations';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { installAutomationEditEnvironment } from './automationEditHarness';

jest.mock('@/components/settings/AuthLoginModal', () => ({
  AuthLoginModal: (): null => null,
}));
jest.mock('@/components/shared/ConfigurationChatComposer', () => ({
  ConfigurationChatComposer: (): null => null,
}));

// The install dialog has its own suite, including `leaveDisabled`; here it
// only reports what it was opened with and how it ends.
interface InstallModalProps {
  readonly detail: SharedAutomationDetail;
  readonly leaveDisabled?: boolean;
  readonly onClose: () => void;
  readonly onDone: (activityId?: string) => void;
}
let mockInstallProps: InstallModalProps | null = null;
jest.mock('@/components/automations/InstallSharedAutomationModal', () => ({
  InstallSharedAutomationModal: (props: InstallModalProps): ReactElement => {
    mockInstallProps = props;
    return createElement('div', {
      'data-testid': 'install-automation-modal-stub',
      'data-remote-id': props.detail.id,
      'data-leave-disabled': String(props.leaveDisabled === true),
    });
  },
}));

const env = installAutomationEditEnvironment();

function sharedDetail(): SharedAutomationDetail {
  return {
    id: 'remote-1',
    name: 'Shared nightly digest',
    description: 'Summarizes the day.',
    triggerKind: 'cron',
    actionType: 'app_advisor_prompt',
    contentHash: 'a'.repeat(64),
    shareScope: 'team',
    owner: {
      type: 'team',
      id: 'team-1',
      name: 'Platform',
      organization: { id: 'org-1', name: 'Acme' },
    },
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    createdBy: { id: 'user-1', name: 'Alex', email: null },
    canUpdate: false,
    canDelete: false,
    automation: {
      version: 1,
      name: 'Shared nightly digest',
      description: 'Summarizes the day.',
      trigger: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
      action: {
        type: 'app_advisor_prompt',
        prompt: 'Summarize the day.',
        plugins: [],
      },
      hasRunCondition: false,
    },
  };
}

async function openShared(
  section?: 'definition' | 'trigger' | 'runs',
): Promise<void> {
  await act(async () => {
    useNavigationStore.getState().openWorkflowEdit({
      kind: 'shared-automation',
      remoteId: 'remote-1',
      ...(section !== undefined ? { section } : {}),
    });
    await Promise.resolve();
  });
  await env.settle();
}

beforeEach(() => {
  mockInstallProps = null;
  env.getSharedMock.mockResolvedValue(sharedDetail());
});

describe('SharedAutomationEditAdapter', () => {
  it('loads the share and shows it read-only with Duplicate as its one action', async () => {
    env.render();
    await openShared();

    expect(env.getSharedMock).toHaveBeenCalledWith('remote-1');
    const shell = env.shell();
    expect(shell?.getAttribute('data-kind')).toBe('automation');
    expect(shell?.getAttribute('data-readonly')).toBe('true');
    expect(shell?.getAttribute('data-dirty')).toBe('false');
    expect(env.byTestId('workflow-edit-save-state')?.textContent).toBe(
      'Read-only',
    );
    expect(env.byTestId('workflow-edit-name')?.textContent).toBe(
      'Shared nightly digest',
    );
    expect(env.section('definition')?.textContent).toContain(
      'Summarize the day.',
    );

    // Duplicate takes Save's place as the accent action.
    const duplicate = env.byTestId('shared-automation-duplicate');
    expect(duplicate?.className).toContain('bg-accent');
    for (const absent of [
      'automations-form-submit',
      'automations-form-enabled',
      'automation-details-share',
      'automation-details-delete',
      'automation-details-run-now',
      'workflow-edit-save',
      'workflow-edit-run',
      'workflow-edit-share',
      'workflow-edit-delete',
      'workflow-edit-toggle',
    ]) {
      expect(env.byTestId(absent)).toBeNull();
    }
    // Nothing to edit, so no form fields either.
    expect(env.byTestId('automations-form-name')).toBeNull();
  });

  it('shows the share’s schedule in Trigger and no runs yet in Runs', async () => {
    env.render();
    await openShared('trigger');
    expect(env.byTestId('shared-automation-schedule')?.textContent).toContain(
      '0 2 * * *',
    );

    await env.showSection('runs');
    expect(env.byTestId('workflow-edit-no-runs')?.textContent).toBe(
      'No runs yet',
    );
    expect(env.listRunsMock).not.toHaveBeenCalled();
  });

  it('shows the Library name while the share loads, and no Duplicate until it has', async () => {
    let resolveShared: (detail: SharedAutomationDetail) => void = () =>
      undefined;
    env.getSharedMock.mockReturnValue(
      new Promise((resolve) => {
        resolveShared = resolve;
      }),
    );
    env.render();
    await openShared();

    expect(env.byTestId('workflow-edit-name')?.textContent).toBe(
      'Shared digest',
    );
    expect(env.byTestId('shared-automation-duplicate')).toBeNull();

    await act(async () => {
      resolveShared(sharedDetail());
      await Promise.resolve();
    });
    await env.settle();
    expect(env.byTestId('shared-automation-duplicate')).not.toBeNull();
  });

  it('offers Try again when the share does not load', async () => {
    env.getSharedMock.mockRejectedValueOnce(new Error('Server unavailable.'));
    env.render();
    await openShared();

    expect(env.byTestId('automation-source-error')).not.toBeNull();
    const retry = Array.from(
      env.byTestId('automation-source-error')?.querySelectorAll('button') ?? [],
    ).find((candidate) => candidate.textContent === 'Try again');
    if (!retry) throw new Error('missing retry');
    await act(async () => {
      retry.click();
      await Promise.resolve();
    });
    await env.settle();

    expect(env.getSharedMock).toHaveBeenCalledTimes(2);
    expect(env.byTestId('automation-source-error')).toBeNull();
    expect(env.byTestId('shared-automation-duplicate')).not.toBeNull();
  });

  it('duplicates into a copy that stays off, then opens the copy ready to edit', async () => {
    env.render();
    await openShared();

    await env.click('shared-automation-duplicate');
    const modal = env.byTestId('install-automation-modal-stub');
    expect(modal?.getAttribute('data-remote-id')).toBe('remote-1');
    expect(modal?.getAttribute('data-leave-disabled')).toBe('true');

    const replaced = useNavigationStore.getState().workflowEditReplaceCount;
    await act(async () => {
      mockInstallProps?.onDone('copy-1');
      await Promise.resolve();
    });
    // The swap waits a tick, as a saved draft's does.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await env.settle();

    expect(useNavigationStore.getState().workflowEdit).toEqual({
      kind: 'automation',
      activityId: 'copy-1',
    });
    expect(useNavigationStore.getState().workflowEditReplaceCount).toBe(
      replaced + 1,
    );
    // The editable shell takes over; the copy is not in the store yet, so it
    // shows not found until the broadcast lands.
    expect(env.byTestId('install-automation-modal-stub')).toBeNull();
    expect(env.byTestId('workflow-edit-not-found')).not.toBeNull();
  });

  it('keeps the user where they went when they left before the copy was made', async () => {
    env.render();
    await openShared('trigger');
    await env.click('shared-automation-duplicate');
    const onDone = mockInstallProps?.onDone;

    act(() => {
      useNavigationStore.getState().closeWorkflowEdit();
    });
    await act(async () => {
      onDone?.('copy-1');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await env.settle();

    expect(useNavigationStore.getState().workflowEdit).toBeUndefined();
  });

  it('stays on the read-only share when the duplicate is cancelled', async () => {
    env.render();
    await openShared();

    await env.click('shared-automation-duplicate');
    await act(async () => {
      mockInstallProps?.onClose();
      await Promise.resolve();
    });
    await env.settle();

    expect(env.byTestId('install-automation-modal-stub')).toBeNull();
    expect(useNavigationStore.getState().workflowEdit).toEqual({
      kind: 'shared-automation',
      remoteId: 'remote-1',
    });
    expect(env.shell()?.getAttribute('data-readonly')).toBe('true');
  });

  it('leaves without asking and reports a read-only shell slice', async () => {
    env.render();
    await openShared();
    expect(
      useCurrentUiStateStore.getState().slices['workflows.editShell'],
    ).toEqual({
      kind: 'automation',
      id: 'remote-1',
      section: 'definition',
      dirty: false,
      readonly: true,
      draft: false,
    });

    await env.click('workflow-edit-back');
    expect(env.byTestId('workflows-unsaved-dialog')).toBeNull();
    expect(useNavigationStore.getState().workflowEdit).toBeUndefined();
  });
});
