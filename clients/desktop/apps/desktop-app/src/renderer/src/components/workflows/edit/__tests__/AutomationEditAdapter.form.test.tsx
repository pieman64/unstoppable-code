/**
 * @jest-environment jsdom
 *
 * The automation form inside the Workflows edit shell (CAN-4072), moved from
 * the Automations page suite when the form modal was replaced: Definition and
 * Trigger fields, the payloads Save sends, cron and If Command generation,
 * replay privacy, chat-authored payloads and Personal/organization scoping.
 */
import { act, createElement, type ReactElement } from 'react';
import type { ConfigurationChatComposerProps } from '@/components/shared/ConfigurationChatComposer.types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { useAutomationsStore } from '@/stores/automationsStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useLinkedPersonalWorkspacesStore } from '@/stores/linkedPersonalWorkspacesStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  activity,
  codeProject,
  coworkProject,
  installAutomationEditEnvironment,
  setFieldValue,
} from './automationEditHarness';

jest.mock('@/components/settings/AuthLoginModal', () => ({
  AuthLoginModal: (): null => null,
}));

// Editor interactions are covered by ConfigurationChatComposer tests and the
// Electron flows; this suite pins what the form hands it and saves from it.
let mockComposerProps: ConfigurationChatComposerProps | undefined;
jest.mock('@/components/shared/ConfigurationChatComposer', () => ({
  ConfigurationChatComposer: (
    props: ConfigurationChatComposerProps,
  ): ReactElement => {
    mockComposerProps = props;
    return createElement('textarea', {
      'data-testid': props.dataTestId,
      'data-context': JSON.stringify(props.context),
      'data-additional-plugins': JSON.stringify(props.value.plugins),
      value: props.value.prompt,
      readOnly: props.readOnly,
      onChange: (event: { target: { value: string } }) =>
        props.onChange({ ...props.value, prompt: event.target.value }),
    });
  },
}));

const env = installAutomationEditEnvironment();

function seed(...activities: ScheduledActivity[]): void {
  useAutomationsStore.setState({ activities });
}

function query(testId: string): HTMLElement | null {
  return env.byTestId(testId);
}

function button(testId: string): HTMLButtonElement {
  const element = query(testId);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`missing button ${testId}`);
  }
  return element;
}

async function save(): Promise<void> {
  await env.click('automations-form-submit');
}

async function pickWorkspaceOption(name: string): Promise<void> {
  await act(async () => {
    query('automations-form-workspace')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await Promise.resolve();
  });
  await act(async () => {
    const portaledOptions = document.body.querySelectorAll('[role="option"]');
    const workspaceOption = Array.from(portaledOptions).find((option) =>
      option.textContent?.includes(name),
    );
    workspaceOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mockComposerProps = undefined;
  localStorage.removeItem('canopy.automations.triggeredSort');
});

describe('AutomationEditAdapter form — Definition', () => {
  it('explicitly resets a local pipeline declaration after switching to App Advisor and clears it in the update', async () => {
    seed({
      ...activity({
        action: {
          type: 'worktree_pipeline',
          workspaceId: 'workspace-1',
          pipelineId: 'stored-pipeline',
          pipelineSource: 'user',
        },
      }),
      targetRequirement: { contexts: ['worktree'] },
    });
    env.render();
    await env.openEdit('activity-1');
    await env.click('automations-form-action-type-app_advisor');
    await env.type('automations-form-prompt', 'Review today.');

    expect(query('automations-form-target-reset')).not.toBeNull();
    await env.click('automations-form-target-reset');
    await save();

    expect(env.updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'activity-1',
        targetRequirement: null,
        action: expect.objectContaining({
          type: 'app_advisor_prompt',
        }) as unknown,
      }),
    );
  });

  it('records the form frame in session replay', async () => {
    env.render();
    await env.openDraft();

    const shell = env.shell();
    const body = env
      .section('definition')
      ?.querySelector('[data-testid="automations-form-body"]');
    expect(
      body?.querySelector('[data-testid="automations-form-name"]'),
    ).not.toBe(null);
    expect(shell?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    expect(body?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    expect(body?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });

  it('blocks only pipeline input values in session replay, keeping their keys recorded', async () => {
    seed(
      activity({
        id: 'activity-inputs',
        name: 'Pipeline with inputs',
        action: {
          type: 'worktree_pipeline',
          workspaceId: 'workspace-1',
          pipelineId: 'review',
          pipelineName: 'Review',
          pipelineSource: 'project',
          inputs: { prompt: 'Fix the flaky tests' },
        },
      }),
    );
    env.render();
    await env.openEdit('activity-inputs');

    const inputs = query('automations-form-pipeline-inputs');
    expect(inputs).not.toBeNull();
    expect(inputs?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
    const blocked = Array.from(
      inputs?.querySelectorAll(`.${POSTHOG_REPLAY_BLOCK_CLASS}`) ?? [],
    ).map((node) => node.textContent);
    expect(blocked).toEqual(['Fix the flaky tests']);
    expect(inputs?.textContent).toContain('prompt');
  });

  it('shows and hides action-specific fields as the selected action type changes', async () => {
    env.render();
    await env.openDraft();
    // A new draft runs a pipeline with no project; these start from App Advisor.
    await env.click('automations-form-action-type-app_advisor');

    // A rich composer contains buttons; a native label would implicitly
    // activate its first button when the non-labelable editor is clicked.
    expect(query('automations-form-prompt')?.closest('label')).toBeNull();

    // Default action is App Advisor: prompt + customize, no workspace select.
    expect(query('automations-form-prompt')).toBeInstanceOf(
      HTMLTextAreaElement,
    );
    expect(query('automations-form-workspace')).toBeNull();
    expect(query('automations-form-customize-toggle')).toBeNull();

    // Switch to Workspace: only the workspace select shows. The follow-up
    // config (Chat | Pipeline pill, prompt, base worktree) stays hidden until
    // a workspace is picked.
    await env.click('automations-form-action-type-workspace');
    expect(query('automations-form-workspace')).toBeInstanceOf(
      HTMLButtonElement,
    );
    expect(query('automations-form-workspace-action-mode')).toBeNull();
    expect(query('automations-form-prompt')).toBeNull();
    expect(query('automations-form-base-worktree')).toBeNull();

    // Picking the code workspace reveals the pill (Chat default), the base
    // worktree field, and the prompt with its customize controls.
    await pickWorkspaceOption('Canopy');
    expect(
      query('automations-form-workspace-action-mode-chat')?.getAttribute(
        'aria-pressed',
      ),
    ).toBe('true');
    expect(query('automations-form-base-worktree')).toBeInstanceOf(
      HTMLButtonElement,
    );
    expect(document.body.textContent).toContain('Project default');
    expect(query('automations-form-interface-mode')).toBeInstanceOf(
      HTMLDivElement,
    );
    expect(query('automations-form-prompt')?.getAttribute('data-context')).toBe(
      JSON.stringify({
        kind: 'workspace',
        workspaceId: 'workspace-1',
        target: { kind: 'baseline' },
      }),
    );

    // A blocked chat draft disables Save in the shell header.
    await act(async () => {
      mockComposerProps?.onValidityChange?.({ valid: false });
      mockComposerProps?.onPendingChange?.(true);
      await Promise.resolve();
    });
    expect(button('automations-form-submit').disabled).toBe(true);

    // ...but must not prevent saving a pipeline configuration. Toggle
    // Pipeline mode: the prompt disappears, the pipeline picker shows.
    await env.click('automations-form-workspace-action-mode-pipeline');
    expect(query('automations-form-prompt')).toBeNull();
    expect(query('automations-form-workspace')).toBeInstanceOf(
      HTMLButtonElement,
    );
    expect(query('automations-form-pipeline')).toBeInstanceOf(
      HTMLButtonElement,
    );
    expect(button('automations-form-submit').disabled).toBe(false);

    await pickWorkspaceOption('Canopy');
    expect(env.container().textContent).toContain(
      'Select a dispatch workflow and configure its inputs.',
    );
    expect(query('automations-form-base-worktree')).toBeInstanceOf(
      HTMLButtonElement,
    );

    // Pick the cowork workspace while in Pipeline mode: base worktree hides,
    // the pipeline picker stays (directory-scoped run at the cowork root).
    await pickWorkspaceOption('Notes');
    expect(query('automations-form-base-worktree')).toBeNull();
    expect(query('automations-form-pipeline')).toBeInstanceOf(
      HTMLButtonElement,
    );

    // Toggle Chat with the cowork workspace selected: standalone prompt form.
    await env.click('automations-form-workspace-action-mode-chat');
    expect(query('automations-form-prompt')).toBeInstanceOf(
      HTMLTextAreaElement,
    );
    expect(query('automations-form-pipeline')).toBeNull();
    expect(query('automations-form-base-worktree')).toBeNull();
  });

  it('shows sidebar group only for new-chat App Advisor and project prompts', async () => {
    env.render();
    await env.openDraft();
    // A new draft runs a pipeline with no project; these start from App Advisor.
    await env.click('automations-form-action-type-app_advisor');

    const groupPicker = (): HTMLElement | null =>
      query('automations-form-sidebar-group');
    expect(groupPicker()).toBeInstanceOf(HTMLButtonElement);

    await env.click('automations-form-run-in-existing_chat');
    expect(groupPicker()).toBeNull();

    await env.click('automations-form-run-in-new_chat');
    expect(groupPicker()).toBeInstanceOf(HTMLButtonElement);

    await env.click('automations-form-action-type-workspace');
    expect(groupPicker()).toBeNull();
    await pickWorkspaceOption('Canopy');
    expect(groupPicker()).toBeInstanceOf(HTMLButtonElement);

    await env.click('automations-form-workspace-action-mode-pipeline');
    expect(groupPicker()).toBeNull();

    await pickWorkspaceOption('Notes');
    await env.click('automations-form-workspace-action-mode-chat');
    expect(groupPicker()).toBeInstanceOf(HTMLButtonElement);
  });

  it('passes selected activity plugins as explicit additions to the composer', async () => {
    seed(
      activity({
        id: 'activity-with-plugin',
        action: {
          type: 'app_advisor_prompt',
          prompt: 'Summarize the plan.',
          plugins: [
            {
              type: 'skill',
              source: { type: 'builtin', id: 'app' },
              skill_name: 'canopy-config',
            },
          ],
        },
      }),
    );
    env.render();
    await env.openEdit('activity-with-plugin');

    expect(
      JSON.parse(
        query('automations-form-prompt')?.getAttribute(
          'data-additional-plugins',
        ) ?? 'null',
      ),
    ).toEqual([
      {
        type: 'skill',
        source: { type: 'builtin', id: 'app' },
        skill_name: 'canopy-config',
      },
    ]);
  });

  it('disables the pipeline picker while a new cowork root is resolving', async () => {
    let resolveArchiveRoot: (path: string) => void = () => undefined;
    const archiveRoot = new Promise<string>((resolve) => {
      resolveArchiveRoot = resolve;
    });
    jest
      .mocked(window.api.homeGetCoworkRoot)
      .mockImplementation(({ workspaceId }) =>
        workspaceId === 'cowork-2'
          ? archiveRoot
          : Promise.resolve('/cowork/notes-root'),
      );
    useProjectsStore.setState({
      projects: [
        ...useProjectsStore.getState().projects,
        coworkProject('cowork-2', 'Archive'),
      ],
    });

    env.render();
    await env.openDraft();
    await env.click('automations-form-action-type-workspace');
    await pickWorkspaceOption('Notes');
    await env.click('automations-form-workspace-action-mode-pipeline');
    const pipelineButton = button('automations-form-pipeline');
    expect(pipelineButton.disabled).toBe(false);

    await pickWorkspaceOption('Archive');
    expect(pipelineButton.disabled).toBe(true);

    await act(async () => {
      resolveArchiveRoot('/cowork/archive-root');
      await archiveRoot;
      await Promise.resolve();
    });
    expect(pipelineButton.disabled).toBe(false);
  });

  it('hides the worktree prompt interface-mode control when Claude TUI chats are disabled', async () => {
    const snapshot = getDefaultFeatureFlagSnapshot('ready');
    useFeatureFlagsStore.setState({
      snapshot: {
        ...snapshot,
        values: {
          ...snapshot.values,
          [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats.key]: false,
        },
        status: 'ready',
        initialized: true,
      },
    });

    env.render();
    await env.openDraft();
    await env.click('automations-form-action-type-workspace');
    // The customize controls only appear once a code workspace is selected.
    await pickWorkspaceOption('Canopy');

    expect(query('automations-form-base-worktree')).not.toBeNull();
    expect(query('automations-form-interface-mode')).toBeNull();
    expect(env.container().textContent).not.toContain('Claude Code mode');
  });
});

describe('AutomationEditAdapter form — Trigger', () => {
  it('renders the cron validation and next-trigger preview', async () => {
    env.render();
    await env.openDraft();
    await env.showSection('trigger');

    const trigger = env.section('trigger');
    expect(trigger?.textContent).toContain('Next trigger:');
    await env.type('automations-form-cron', '* * * * * *');
    expect(trigger?.textContent).toContain('must have exactly 5 fields');
  });

  it('generates a cron expression from natural language and handles retry', async () => {
    env.render();
    await env.openDraft();
    await env.showSection('trigger');

    await env.click('automations-form-cron-assistant');
    const naturalLanguageInput = env.input(
      'automations-form-cron-natural-language',
    );
    await act(async () => {
      setFieldValue(naturalLanguageInput, 'Every Monday at 2:30pm');
      await Promise.resolve();
    });
    await act(async () => {
      naturalLanguageInput.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(env.generateCronMock).toHaveBeenCalledWith({
      description: 'Every Monday at 2:30pm',
    });
    expect(env.input('automations-form-cron').value).toBe('30 14 * * 1');
    expect(query('automations-form-cron-natural-language')).toBeNull();

    env.generateCronMock.mockResolvedValueOnce({
      ok: false,
      error: 'Could not parse schedule.',
    });
    await env.click('automations-form-cron-assistant');
    await env.type(
      'automations-form-cron-natural-language',
      'whenever it feels right',
    );
    await env.click('automations-form-cron-generate');
    expect(query('automations-form-cron-generation-warning')).toBeInstanceOf(
      HTMLElement,
    );

    await env.click('automations-form-cron-generation-try-again');
    expect(query('automations-form-cron-natural-language')).toBeInstanceOf(
      HTMLInputElement,
    );
  });

  it('preserves benign Definition edits while applying generated If Command output', async () => {
    let resolveGenerateIfCommand:
      | ((
          value: { ok: true; command: string } | { ok: false; error: string },
        ) => void)
      | undefined;
    env.generateIfCommandMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGenerateIfCommand = resolve;
      }),
    );
    env.render();
    await env.openDraft();
    await env.showSection('trigger');

    await env.click('automations-form-if-command-toggle');
    await env.click('automations-form-if-command-assistant');
    await env.type(
      'automations-form-if-command-natural-language',
      'Run only when ready',
    );
    await env.click('automations-form-if-command-generate');

    // The Definition section stays mounted behind the Trigger tab.
    const nameInput = env.input('automations-form-name');
    await act(async () => {
      setFieldValue(nameInput, 'Edited while generating');
      await Promise.resolve();
    });
    await act(async () => {
      resolveGenerateIfCommand?.({
        ok: true,
        command: 'test -f ~/ready-to-run.txt',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(nameInput.value).toBe('Edited while generating');
    expect(env.input('automations-form-if-command').value).toBe(
      'test -f ~/ready-to-run.txt',
    );
  });

  it('keeps Definition edits made while a cron expression generates', async () => {
    let resolveGenerateCron:
      | ((value: { ok: true; expression: string }) => void)
      | undefined;
    env.generateCronMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGenerateCron = resolve;
      }),
    );
    env.render();
    await env.openDraft();
    await env.showSection('trigger');

    await env.click('automations-form-cron-assistant');
    await env.type('automations-form-cron-natural-language', 'Every Monday');
    await env.click('automations-form-cron-generate');

    const nameInput = env.input('automations-form-name');
    await act(async () => {
      setFieldValue(nameInput, 'Edited while generating');
      await Promise.resolve();
    });
    await act(async () => {
      resolveGenerateCron?.({ ok: true, expression: '30 14 * * 1' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(nameInput.value).toBe('Edited while generating');
    expect(env.input('automations-form-cron').value).toBe('30 14 * * 1');
  });

  it('drops an If Command generation still running when Save starts', async () => {
    let resolveGenerateIfCommand:
      | ((value: { ok: true; command: string }) => void)
      | undefined;
    env.generateIfCommandMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveGenerateIfCommand = resolve;
      }),
    );
    seed(activity());
    env.render();
    await env.openEdit('activity-1', 'trigger');

    await env.click('automations-form-if-command-toggle');
    await env.click('automations-form-if-command-assistant');
    await env.type(
      'automations-form-if-command-natural-language',
      'Run only when ready',
    );
    await env.click('automations-form-if-command-generate');
    await env.type('automations-form-cron', '15 10 * * 1');
    await save();
    expect(env.updateMock).toHaveBeenCalledTimes(1);
    expect(env.shell()?.getAttribute('data-dirty')).toBe('false');

    await act(async () => {
      resolveGenerateIfCommand?.({
        ok: true,
        command: 'test -f ~/ready-to-run.txt',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(env.input('automations-form-if-command').value).toBe('');
    expect(env.shell()?.getAttribute('data-dirty')).toBe('false');
  });

  it('saves the schedule and If Command from the Trigger section', async () => {
    seed(activity());
    env.render();
    await env.openEdit('activity-1', 'trigger');
    await env.type('automations-form-cron', '15 10 * * 1');
    await save();

    expect(env.updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'activity-1',
        schedule: expect.objectContaining({
          kind: 'cron',
          expression: '15 10 * * 1',
          timezone: 'local',
        }) as unknown,
      }),
    );
  });
});

describe('AutomationEditAdapter form — Save payloads', () => {
  it('submits update and create requests from the form', async () => {
    seed(activity({ id: 'activity-1', name: 'Morning review' }));
    env.render();
    await env.openEdit('activity-1');
    expect(env.input('automations-form-name').value).toBe('Morning review');
    await env.type('automations-form-name', 'Updated review');
    await save();
    expect(env.updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'activity-1',
        name: 'Updated review',
      }),
    );

    await env.click('workflow-edit-back');
    await env.openDraft();
    // A new draft runs a pipeline with no project; these start from App Advisor.
    await env.click('automations-form-action-type-app_advisor');
    await env.type('automations-form-name', 'New digest');
    await env.type('automations-form-prompt', 'Summarize today.');
    await save();
    expect(env.createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'New digest',
        action: { type: 'app_advisor_prompt', prompt: 'Summarize today.' },
      }),
    );
  });

  it('keeps a chat-authored session prompt payload readonly while leaving its Run-in destination editable (CAN-2937)', async () => {
    seed(
      activity({
        id: 'session-activity',
        name: 'Triggered chat follow-up',
        enabled: true,
        schedule: {
          kind: 'one_time',
          runAt: '2099-01-01T10:00:00.000Z',
          timezone: 'local',
        },
        nextRunAt: '2099-01-01T10:00:00.000Z',
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'workspace-1',
          worktreeId: 'base-worktree',
          chatId: 'chat-1',
          prompt: 'Follow up later.',
          fileReferences: [
            {
              displayPath: 'src/old.ts',
              absolutePath: '/repo/src/old.ts',
              repoName: 'repo-a',
            },
          ],
          attachmentPaths: ['/tmp/old.png'],
          attachmentPromptContexts: [
            {
              attachmentPath: '/tmp/old.png',
              promptKind: 'in-app-browser-resource',
            },
          ],
          inputMode: 'voice',
          purpose: 'scheduled_send',
          workspaceName: 'Canopy',
          worktreeName: 'main',
          chatTitle: 'Implementation chat',
        },
      }),
    );
    env.render();
    await env.openEdit('session-activity');

    // The Run-in selector replaces the blanket readonly target card: the
    // destination is the one thing this form may re-point for a
    // composer-authored send, so Save is shown for it now.
    expect(query('automations-form-worktree-session-target')).toBeNull();
    expect(query('automations-form-run-in')).toBeInstanceOf(HTMLDivElement);
    expect(
      query('automations-form-run-in-existing_chat')?.getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
    expect(query('automations-form-chat-target')).toBeInstanceOf(
      HTMLDivElement,
    );
    expect(
      query('automations-form-action-type-worktree_session_prompt'),
    ).toBeNull();
    expect(query('automations-form-submit')).toBeInstanceOf(HTMLButtonElement);
    expect(query('automations-form-session-payload')).toBeNull();
    expect(env.input('automations-form-name').readOnly).toBe(true);
    expect(env.input('automations-form-prompt').readOnly).toBe(true);
    expect(
      button('automations-form-workspace-action-mode-pipeline').disabled,
    ).toBe(true);
    // The More menu turns the saved send on or off, as the list row does;
    // it never edits the payload.
    await env.click('workflow-edit-more');
    expect(query('automations-form-enabled')?.getAttribute('role')).toBe(
      'menuitem',
    );
    await env.click('workflow-edit-more');

    // The schedule of a chat-authored send is read-only in Trigger.
    await env.showSection('trigger');
    expect(query('automations-form-schedule-readonly')).toBeInstanceOf(
      HTMLDivElement,
    );
    expect(query('automations-form-cron')).toBeNull();
    await env.showSection('definition');

    await env.click('automations-form-run-in-new_chat');
    expect(env.input('automations-form-prompt').readOnly).toBe(true);
    expect(query('automations-form-run-in-attachment-warning')).toBeInstanceOf(
      HTMLParagraphElement,
    );
    expect(query('automations-form-customize-toggle')).toBeNull();
    expect(env.updateMock).not.toHaveBeenCalled();

    // A new automation never offers the chat-authored action type.
    await env.click('workflow-edit-back');
    await env.click('workflows-unsaved-discard');
    await env.openDraft();
    expect(
      query('automations-form-action-type-worktree_session_prompt'),
    ).toBeNull();
  });

  it('keeps a form-authored existing-chat automation fully editable', async () => {
    seed(
      activity({
        id: 'form-authored-session',
        name: 'Editable follow-up',
        schedule: {
          kind: 'cron',
          expression: '15 10 * * 1',
          timezone: 'local',
        },
        ifCommand: 'test -f ready.txt',
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'workspace-1',
          worktreeId: 'base-worktree',
          chatId: 'chat-1',
          prompt: 'Continue the review.',
        },
      }),
    );
    env.render();
    await env.openEdit('form-authored-session');

    expect(env.input('automations-form-name').readOnly).toBe(false);
    expect(env.input('automations-form-prompt').readOnly).toBe(false);
    await env.click('workflow-edit-more');
    expect(button('automations-form-enabled').disabled).toBe(false);
    await env.click('workflow-edit-more');

    await env.showSection('trigger');
    expect(query('automations-form-schedule-kind')).toBeInstanceOf(
      HTMLDivElement,
    );
    expect(query('automations-form-cron')).toBeInstanceOf(HTMLInputElement);
    expect(query('automations-form-if-command-section')).toBeInstanceOf(
      HTMLDivElement,
    );
  });

  it('does not save from the unsaved-changes prompt while Definition blocks Save', async () => {
    seed(activity());
    env.render();
    await env.openEdit('activity-1');
    await env.type('automations-form-name', 'Renamed review');
    await act(async () => {
      mockComposerProps?.onValidityChange?.({ valid: false });
      await Promise.resolve();
    });
    expect(button('automations-form-submit').disabled).toBe(true);

    await env.click('workflow-edit-back');
    await env.click('workflows-unsaved-save');

    expect(env.updateMock).not.toHaveBeenCalled();
    expect(query('workflows-unsaved-dialog')).toBeNull();
    expect(useNavigationStore.getState().workflowEdit?.kind).toBe('automation');
    expect(env.shell()?.getAttribute('data-dirty')).toBe('true');
    expect(query('automations-form-error')).not.toBeNull();

    // Fixing the blocking field clears the message.
    await act(async () => {
      mockComposerProps?.onValidityChange?.({ valid: true });
      await Promise.resolve();
    });
    expect(query('automations-form-error')).toBeNull();
  });
});

describe('AutomationEditAdapter form — Personal/organization scoping (CAN-3448)', () => {
  const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ORG_OWNER = {
    type: 'organization' as const,
    organizationId: ORG,
    projectId: '11111111-1111-4111-8111-111111111111',
    instanceId: '22222222-2222-4222-8222-222222222222',
    bindingGeneration: 0,
  };
  const personalChatsActivity = activity({
    id: 'personal-chats',
    name: 'Personal digest',
    enabled: false,
    action: {
      type: 'standalone_prompt',
      chatProjectId: 'chats',
      prompt: 'Digest my notes.',
    },
  });
  const orgActivity = activity({
    id: 'org-release',
    name: 'Org release check',
    action: {
      type: 'worktree_prompt',
      workspaceId: 'org-project',
      prompt: 'Check the release.',
    },
  });

  function seedContext(
    flag: boolean,
    context:
      | { kind: 'personal' }
      | { kind: 'organization'; organizationId: string },
  ): void {
    const snapshot = getDefaultFeatureFlagSnapshot();
    snapshot.values[CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key] = flag;
    useFeatureFlagsStore.setState({ snapshot });
    useWorkspaceContextStore.setState({
      state: {
        context,
        revision: 1,
        organizations: [{ id: ORG, name: 'Acme', role: 'MEMBER' }],
      },
      hydrated: true,
    });
  }

  beforeEach(() => {
    env.updateMock.mockResolvedValue({
      ok: true,
      activity: personalChatsActivity,
    });
    seed(personalChatsActivity, orgActivity);
    useStandaloneChatStore.setState({
      chatProjects: [{ id: 'chats', name: 'Chats', createdAt: '2026-05-27' }],
      chatProjectsLoaded: true,
    });
    useProjectsStore.setState({
      projects: [
        coworkProject('chats', 'Chats'),
        codeProject('org-project', 'Org Project', { owner: ORG_OWNER }),
      ],
    });
    useLinkedPersonalWorkspacesStore.setState({ ids: [] });
  });

  afterEach(() => {
    useWorkspaceContextStore.setState({ hydrated: false });
  });

  async function openProjectPicker(): Promise<string[]> {
    env.render();
    await env.openDraft();
    await env.click('automations-form-action-type-workspace');
    await env.click('automations-form-workspace');
    return Array.from(document.body.querySelectorAll('[role="option"]')).map(
      (option) => option.textContent ?? '',
    );
  }

  it('offers only in-context projects in the Project picker', async () => {
    seedContext(true, { kind: 'organization', organizationId: ORG });
    const options = await openProjectPicker();
    expect(options.some((label) => label.includes('Org Project'))).toBe(true);
    expect(options.some((label) => label.includes('Chats'))).toBe(false);
  });

  it('offers every project while org projects are off', async () => {
    seedContext(false, { kind: 'organization', organizationId: ORG });
    const options = await openProjectPicker();
    expect(options.some((label) => label.includes('Org Project'))).toBe(true);
    expect(options.some((label) => label.includes('Chats'))).toBe(true);
  });

  it('keeps a saved out-of-context target selected, explains it, and saves it unchanged', async () => {
    seedContext(true, { kind: 'organization', organizationId: ORG });
    env.render();
    await env.openEdit('personal-chats');

    expect(query('automations-form-workspace')?.textContent).toContain('Chats');
    expect(query('automations-form-context-note')?.textContent).toContain(
      'Chats is in Personal, so turning this automation on runs it there.',
    );
    // Save needs an edit; the target is not one of them.
    await env.type('automations-form-name', 'Personal digest (renamed)');
    await save();

    expect(env.updateMock).toHaveBeenCalledTimes(1);
    const [request] = env.updateMock.mock.calls[0];
    expect(request.id).toBe('personal-chats');
    expect(request.action).toMatchObject({
      type: 'standalone_prompt',
      chatProjectId: 'chats',
    });
  });

  it('says the account is not a member of the organization a saved target is in', async () => {
    seedContext(true, { kind: 'personal' });
    useWorkspaceContextStore.setState({
      state: { context: { kind: 'personal' }, revision: 1, organizations: [] },
      hydrated: true,
    });
    env.render();
    await env.openEdit('org-release');

    expect(query('automations-form-context-note')?.textContent).toContain(
      "Org Project is in an organization you're not a member of. Ask for access to turn this automation on or run it.",
    );
  });

  it('shows a refused save inside the open shell', async () => {
    seedContext(true, { kind: 'organization', organizationId: ORG });
    const refusal =
      "Chats is in an organization you're not a member of. Ask for access, then turn this automation on.";
    env.updateMock.mockResolvedValue({ ok: false, error: refusal });
    env.render();
    await env.openEdit('personal-chats');
    await env.type('automations-form-name', 'Personal digest (renamed)');
    await save();

    expect(env.shell()).not.toBeNull();
    expect(useNavigationStore.getState().workflowEdit?.kind).toBe('automation');
    expect(query('automations-form-error')?.textContent).toBe(refusal);
    expect(env.shell()?.getAttribute('data-dirty')).toBe('true');
  });
});
