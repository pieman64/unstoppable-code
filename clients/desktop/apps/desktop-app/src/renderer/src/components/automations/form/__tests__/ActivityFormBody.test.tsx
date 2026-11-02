/**
 * @jest-environment jsdom
 *
 * Uses the repo's createRoot + act jsdom convention; @testing-library/react
 * is not installed.
 *
 * Pins the contract a full-page host relies on: an untouched form is clean
 * (the state the body settles on after mount snapshots equal to the state it
 * was given), mount normalizations are reported as `mount`, and two bodies
 * (definition + trigger) can share one state.
 */
import { act, createRef, useState, type ReactElement } from 'react';
import type * as ReactModule from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ConfigurationChatComposerProps } from '@/components/shared/ConfigurationChatComposer.types';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useSidebarItemGroupsStore } from '@/stores/sidebarItemGroupsStore';
import {
  ActivityFormBody,
  type ActivityFormBodyHandle,
  type ActivityFormChangeMeta,
  type ActivityFormFieldGroup,
} from '../ActivityFormBody';
import {
  activityToFormState,
  automationDraftFromSeed,
  automationFormSnapshot,
  emptyFormState,
  type FormState,
} from '../automationFormState';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The real editor is covered by its own suite. This stand-in reproduces the
// normalization a rich editor can make on mount: it reports its value back
// once, with the model settings in the canonical shape the form passes it.
jest.mock('@/components/shared/ConfigurationChatComposer', () => {
  const react: typeof ReactModule = jest.requireActual('react');
  return {
    ConfigurationChatComposer: (
      props: ConfigurationChatComposerProps,
    ): ReactElement => {
      const propsRef = react.useRef(props);
      propsRef.current = props;
      react.useEffect(() => {
        propsRef.current.onChange({ ...propsRef.current.value });
      }, []);
      return react.createElement('textarea', {
        'data-testid': props.dataTestId,
        value: props.value.prompt,
        readOnly: props.readOnly,
        onChange: (event: { target: { value: string } }) =>
          props.onChange({ ...props.value, prompt: event.target.value }),
      });
    },
  };
});

// The picker is covered by its own suite; this stand-in shows where it would
// discover project pipelines.
jest.mock('@/components/activity/PipelineTriggerModal', () => {
  const react: typeof ReactModule = jest.requireActual('react');
  return {
    ...jest.requireActual<Record<string, unknown>>(
      '@/components/activity/PipelineTriggerModal',
    ),
    PipelineTriggerModal: (props: {
      cwd?: string;
      repoChoices?: ReadonlyArray<{ repoId: string }>;
      onRepoChange?: (repoId: string | undefined) => void;
    }): ReactElement =>
      react.createElement(
        'div',
        {
          'data-testid': 'pipeline-picker-stub',
          'data-cwd': props.cwd ?? '',
          'data-repo-ids': (props.repoChoices ?? [])
            .map((choice) => choice.repoId)
            .join(','),
        },
        react.createElement('button', {
          type: 'button',
          'data-testid': 'pipeline-picker-stub-choose-repo-b',
          onClick: () => props.onRepoChange?.('repo-b'),
        }),
      ),
  };
});

interface Report {
  state: FormState;
  meta: ActivityFormChangeMeta;
}

let container: HTMLDivElement;
let root: Root;

function Host({
  initial,
  groups,
  reports,
  showEnabledField,
}: {
  initial: FormState;
  groups: ActivityFormFieldGroup[];
  reports: Report[];
  showEnabledField?: boolean;
}): ReactElement {
  const [state, setState] = useState(initial);
  const projects = useProjectsStore((s) => s.projects);
  return (
    <>
      {groups.map((group) => (
        <ActivityFormBody
          key={group}
          fieldGroup={group}
          state={state}
          saving={false}
          projects={projects}
          showEnabledField={showEnabledField}
          onChange={(next, meta): void => {
            reports.push({ state: next, meta });
            setState(next);
          }}
        />
      ))}
    </>
  );
}

function activityLabeled(label: string): ScheduledActivity {
  const entry = ACTIVITIES.find(([candidate]) => candidate === label);
  if (!entry) throw new Error(`No activity labeled ${label}`);
  return entry[1];
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(
  initial: FormState,
  groups: ActivityFormFieldGroup[],
  options: { showEnabledField?: boolean } = {},
): Promise<Report[]> {
  const reports: Report[] = [];
  act(() => {
    root.render(
      <Host
        initial={initial}
        groups={groups}
        reports={reports}
        showEnabledField={options.showEnabledField}
      />,
    );
  });
  await flush();
  return reports;
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

function countTestId(id: string): number {
  return container.querySelectorAll(`[data-testid="${id}"]`).length;
}

function setFieldValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element),
    'value',
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function activity(overrides: Partial<ScheduledActivity>): ScheduledActivity {
  return {
    version: 1,
    id: 'activity-1',
    name: 'Morning review',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Summarize the plan.' },
    createdAt: '2026-05-27T00:00:00.000Z',
    updatedAt: '2026-05-27T00:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}

const ONE_TIME = {
  kind: 'one_time',
  runAt: '2099-01-02T09:30:00.000Z',
  timezone: 'local',
} as const;

const ACTIVITIES: Array<[string, ScheduledActivity]> = [
  ['App Advisor, new chat', activity({})],
  [
    'App Advisor, existing Work Entry',
    activity({
      action: {
        type: 'app_advisor_prompt',
        prompt: 'Check in',
        workEntryId: 'entry-1',
      },
    }),
  ],
  [
    'Cowork project chat',
    activity({
      action: {
        type: 'standalone_prompt',
        chatProjectId: 'cowork-1',
        prompt: 'Draft notes',
        sidebarGroupName: 'Daily',
      },
    }),
  ],
  [
    'worktree chat with settings',
    activity({
      ifCommand: 'test -f ready',
      targetRequirement: { contexts: ['worktree'] },
      action: {
        type: 'worktree_prompt',
        workspaceId: 'workspace-1',
        baseWorktreeId: 'base-worktree',
        prompt: '  Review the diff  ',
        model: 'claude-opus-4-1',
        modelConfig: { thinkingLevel: 'high', fastMode: true },
        planMode: true,
        approvalMode: 'ask',
        interfaceMode: 'canopy',
      },
    }),
  ],
  [
    'new chat in an existing worktree',
    activity({
      action: {
        type: 'worktree_prompt',
        workspaceId: 'workspace-1',
        existingWorktreeId: 'base-worktree',
        prompt: 'Continue',
      },
    }),
  ],
  [
    'worktree pipeline',
    activity({
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        pipelineId: 'review',
        pipelineName: 'Review',
        pipelineSource: 'user',
        inputs: { ticket: 'CAN-1' },
      },
    }),
  ],
  [
    'existing chat',
    activity({
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'workspace-1',
        worktreeId: 'base-worktree',
        chatId: 'chat-1',
        prompt: 'Keep going',
        modelConfig: { thinkingLevel: 'medium' },
      },
    }),
  ],
  [
    'chat-authored scheduled message',
    activity({
      action: {
        type: 'worktree_session_prompt',
        workspaceId: 'workspace-1',
        worktreeId: 'base-worktree',
        chatId: 'chat-1',
        prompt: 'Resume',
        purpose: 'scheduled_send',
        attachmentPaths: ['/tmp/a.png'],
      },
    }),
  ],
  [
    'App Advisor existing chat',
    activity({
      action: {
        type: 'worktree_session_prompt',
        workspaceId: APP_ADVISOR_PROJECT_ID,
        worktreeId: 'entry-1',
        chatId: 'chat-1',
        prompt: 'Follow up',
      },
    }),
  ],
  [
    'scheduled pipeline resume',
    activity({
      action: {
        type: 'pipeline_execution_resume',
        executionId: 'exec-1',
        statusReasonIds: [],
        provider: 'claude',
        purpose: 'usage_limit_resume',
        pipelineName: 'Release',
      },
    }),
  ],
  [
    'pipeline with no project',
    activity({
      executionContext: 'personal',
      action: {
        type: 'worktree_pipeline',
        target: { kind: 'global' },
        pipelineId: 'review',
        pipelineName: 'Review',
        pipelineSource: 'user',
      },
    }),
  ],
  [
    'pipeline in an existing task',
    activity({
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        target: { kind: 'task', taskId: 'base-worktree' },
        pipelineId: 'review',
        pipelineName: 'Review',
        pipelineSource: 'user',
      },
    }),
  ],
  [
    'pipeline in a cowork project folder',
    activity({
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'cowork-1',
        target: { kind: 'project' },
        pipelineId: 'review',
        pipelineName: 'Review',
        pipelineSource: 'user',
      },
    }),
  ],
];

const CASES: Array<[string, FormState]> = [
  ...ACTIVITIES.flatMap(
    ([label, entry]): Array<[string, FormState]> => [
      [`${label} (cron)`, activityToFormState(entry)],
      [
        `${label} (one-time)`,
        activityToFormState({ ...entry, schedule: ONE_TIME }),
      ],
    ],
  ),
  ['blank form', emptyFormState()],
  ['no seed', automationDraftFromSeed()],
  [
    'project worktree seed',
    automationDraftFromSeed({
      projectId: 'workspace-1',
      isCowork: false,
      existingWorktreeId: 'base-worktree',
    }),
  ],
  [
    'project seed without a worktree',
    automationDraftFromSeed({ projectId: 'workspace-1', isCowork: false }),
  ],
  [
    'Cowork seed',
    automationDraftFromSeed({ projectId: 'cowork-1', isCowork: true }),
  ],
];

beforeEach(() => {
  useFeatureFlagsStore.setState({
    snapshot: getDefaultFeatureFlagSnapshot(),
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      automations: {
        generateCron: jest.fn(),
        generateIfCommand: jest.fn(),
        resolveSharedPipelineInstallPin: jest.fn(),
      },
      chat: {
        loadTabs: jest.fn().mockResolvedValue({
          tabs: [{ id: 'chat-1', title: 'Chat', kind: 'chat' }],
        }),
      },
      workEntries: {
        list: jest
          .fn()
          .mockResolvedValue({ entries: [{ id: 'entry-1', title: 'Entry' }] }),
      },
      loadProjects: jest.fn().mockResolvedValue({ items: [] }),
      sidebarItemGroups: {
        list: jest.fn().mockResolvedValue([]),
        onChanged: jest.fn(() => (): void => undefined),
      },
      getWorktreePath: jest.fn().mockResolvedValue('/worktrees/base'),
      listWorktreeRepoEntries: jest.fn().mockResolvedValue([]),
      homeGetCoworkRoot: jest.fn().mockResolvedValue('/cowork/root'),
    },
  });
  useSidebarItemGroupsStore.setState({ byScope: {}, errors: {} });
  useProjectsStore.setState({
    projects: [
      {
        id: 'workspace-1',
        name: 'Canopy',
        worktrees: [{ id: 'base-worktree', branchName: 'main' }],
      },
      { id: 'cowork-1', name: 'Notes', type: 'cowork' },
    ],
  } as unknown as Parameters<typeof useProjectsStore.setState>[0]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('ActivityFormBody: an untouched form is clean', () => {
  it.each(CASES)('%s, all fields', async (_label, initial) => {
    const reports = await mount(initial, ['all']);
    expect(reports.every((report) => report.meta.origin === 'mount')).toBe(
      true,
    );
    const settled = reports.at(-1)?.state ?? initial;
    expect(automationFormSnapshot(settled)).toBe(
      automationFormSnapshot(initial),
    );
  });

  it.each(CASES)(
    '%s, definition and trigger bodies',
    async (_label, initial) => {
      const reports = await mount(initial, ['definition', 'trigger']);
      expect(reports.every((report) => report.meta.origin === 'mount')).toBe(
        true,
      );
      const settled = reports.at(-1)?.state ?? initial;
      expect(automationFormSnapshot(settled)).toBe(
        automationFormSnapshot(initial),
      );
    },
  );

  it('reports the prompt editor settling as a mount change', async () => {
    const reports = await mount(activityToFormState(ACTIVITIES[3][1]), ['all']);
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]?.meta).toEqual({ origin: 'mount' });
  });
});

describe('ActivityFormBody: edits', () => {
  it('reports typing as a user change that makes the form dirty', async () => {
    const initial = activityToFormState(ACTIVITIES[0][1]);
    const reports = await mount(initial, ['all']);
    const name = byTestId('automations-form-name');
    if (!(name instanceof HTMLInputElement)) throw new Error('No name field');
    act(() => {
      setFieldValue(name, 'Evening review');
    });
    const last = reports.at(-1);
    expect(last?.meta).toEqual({ origin: 'user' });
    expect(last?.state.name).toBe('Evening review');
    expect(automationFormSnapshot(last?.state ?? initial)).not.toBe(
      automationFormSnapshot(initial),
    );
  });

  it('reports a prompt edit after interaction as a user change', async () => {
    const reports = await mount(activityToFormState(ACTIVITIES[0][1]), [
      'definition',
    ]);
    const prompt = byTestId('automations-form-prompt');
    if (!(prompt instanceof HTMLTextAreaElement))
      throw new Error('No prompt field');
    act(() => {
      setFieldValue(prompt, 'Something else');
    });
    expect(reports.at(-1)).toMatchObject({
      meta: { origin: 'user' },
      state: { prompt: 'Something else' },
    });
  });
});

describe('ActivityFormBody: field groups', () => {
  it('splits the fields between a definition and a trigger body without duplicates', async () => {
    await mount(
      activityToFormState({ ...ACTIVITIES[3][1], ifCommand: 'true' }),
      ['definition', 'trigger'],
    );
    const bodies = container.querySelectorAll(
      '[data-testid="automations-form-body"]',
    );
    expect(
      Array.from(bodies).map((body) => body.getAttribute('data-field-group')),
    ).toEqual(['definition', 'trigger']);
    const [definition, trigger] = Array.from(bodies);
    for (const id of [
      'automations-form-name',
      'automations-form-enabled',
      'automations-form-action-type',
      'automations-form-prompt',
    ]) {
      expect(countTestId(id)).toBe(1);
      expect(definition?.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
    for (const id of [
      'automations-form-schedule-kind',
      'automations-form-cron',
      'automations-form-if-command-section',
    ]) {
      expect(countTestId(id)).toBe(1);
      expect(trigger?.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
  });

  it('hides Enabled when the host shows it', async () => {
    await mount(emptyFormState(), ['all'], { showEnabledField: false });
    expect(byTestId('automations-form-enabled')).toBeNull();
    expect(byTestId('automations-form-name')).not.toBeNull();
  });
});

describe('ActivityFormBody: submit', () => {
  it('reports availability and submits through its handle', async () => {
    const onSubmit = jest.fn();
    const availability: boolean[] = [];
    const handleRef = createRef<ActivityFormBodyHandle>();
    const state = activityToFormState(ACTIVITIES[0][1]);
    act(() => {
      root.render(
        <ActivityFormBody
          state={state}
          saving={false}
          projects={useProjectsStore.getState().projects}
          onChange={(): void => undefined}
          onSubmit={onSubmit}
          handleRef={handleRef}
          onSubmitAvailabilityChange={(canSubmit): void => {
            availability.push(canSubmit);
          }}
        />,
      );
    });
    expect(availability.at(-1)).toBe(true);
    await act(async () => {
      await handleRef.current?.submit();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('blocks submit while a pipeline model alias needs configuring', () => {
    const onSubmit = jest.fn();
    const availability: boolean[] = [];
    const handleRef = createRef<ActivityFormBodyHandle>();
    const state: FormState = {
      ...activityToFormState(ACTIVITIES[5][1]),
      pipelineModelAliases: [{ id: 'planner', name: 'Planner' }],
    };
    act(() => {
      root.render(
        <ActivityFormBody
          state={state}
          saving={false}
          projects={useProjectsStore.getState().projects}
          onChange={(): void => undefined}
          onSubmit={onSubmit}
          handleRef={handleRef}
          onSubmitAvailabilityChange={(canSubmit): void => {
            availability.push(canSubmit);
          }}
        />,
      );
    });
    expect(availability.at(-1)).toBe(false);
    expect(byTestId('automations-form-model-alias-error')).not.toBeNull();
  });

  it('blocks submit until an existing-chat destination resolves', async () => {
    const onSubmit = jest.fn();
    const handleRef = createRef<ActivityFormBodyHandle>();
    const state: FormState = {
      ...activityToFormState(ACTIVITIES[6][1]),
      worktreeSessionTarget: {
        workspaceId: 'workspace-1',
        worktreeId: 'missing-worktree',
        chatId: 'chat-1',
      },
    };
    act(() => {
      root.render(
        <ActivityFormBody
          state={state}
          saving={false}
          projects={useProjectsStore.getState().projects}
          onChange={(): void => undefined}
          onSubmit={onSubmit}
          handleRef={handleRef}
        />,
      );
    });
    await flush();
    expect(byTestId('automations-form-chat-target-error')).not.toBeNull();
    await act(async () => {
      await handleRef.current?.submit();
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('ActivityFormBody: pipeline destinations', () => {
  async function mountWithAvailability(initial: FormState): Promise<jest.Mock> {
    const availability = jest.fn();
    act(() => {
      root.render(
        <ActivityFormBody
          state={initial}
          saving={false}
          projects={useProjectsStore.getState().projects}
          onChange={jest.fn()}
          onSubmitAvailabilityChange={availability}
        />,
      );
    });
    await flush();
    return availability;
  }

  it('hides the project field and enables the picker with no project', async () => {
    await mount(automationDraftFromSeed(), ['all']);
    expect(
      byTestId('automations-form-action-type-global')?.getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
    expect(byTestId('automations-form-workspace')).toBeNull();
    expect(byTestId('automations-form-pipeline-target')).toBeNull();
    expect(byTestId('automations-form-global-owner')?.textContent).toContain(
      'Owner: Personal',
    );
    const picker = byTestId('automations-form-pipeline');
    expect(picker).toBeInstanceOf(HTMLButtonElement);
    expect(picker?.hasAttribute('disabled')).toBe(false);
    expect(picker?.textContent).toBe('Select workflow');
  });

  it('offers new worktree, existing worktree, and project folder on a code project', async () => {
    await mount(activityToFormState(activityLabeled('worktree pipeline')), [
      'all',
    ]);
    expect(
      Array.from(
        container.querySelectorAll<HTMLInputElement>(
          '[data-testid^="automations-form-pipeline-run-in-"]',
        ),
      ).map((radio) => [radio.value, radio.checked]),
    ).toEqual([
      ['new_worktree', true],
      ['task', false],
      ['project', false],
    ]);
    expect(byTestId('automations-form-base-worktree')).not.toBeNull();
  });

  it('enables the picker for the project folder of a code project with no worktrees', async () => {
    useProjectsStore.setState({
      projects: [
        {
          id: 'repo-2',
          name: 'Repo',
          type: 'single-repo',
          repoPath: '/repos/repo-2',
          worktrees: [],
        },
      ],
    } as unknown as Parameters<typeof useProjectsStore.setState>[0]);
    const projectFolder = activity({
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'repo-2',
        target: { kind: 'project' },
        pipelineId: 'review',
      },
    });
    await mount(activityToFormState(projectFolder), ['all']);
    expect(
      byTestId('automations-form-pipeline')?.hasAttribute('disabled'),
    ).toBe(false);
    expect(window.api.getWorktreePath).not.toHaveBeenCalled();
  });

  it("discovers a multi-repo project folder's pipelines in its selected repository", async () => {
    useProjectsStore.setState({
      projects: [
        {
          id: 'multi-1',
          name: 'Multi',
          type: 'multi-repo',
          sourceRepoPath: '/repos/root',
          repos: [{ id: 'repo-a', name: 'a', repoPath: '/repos/a' }],
          worktrees: [],
        },
      ],
    } as unknown as Parameters<typeof useProjectsStore.setState>[0]);
    const projectFolder = activity({
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'multi-1',
        target: { kind: 'project' },
        repoId: 'repo-a',
        pipelineId: 'review',
      },
    });
    await mount(activityToFormState(projectFolder), ['all']);
    const picker = byTestId('automations-form-pipeline');
    if (!(picker instanceof HTMLButtonElement)) throw new Error('No picker');
    act(() => {
      picker.click();
    });
    expect(byTestId('pipeline-picker-stub')?.getAttribute('data-cwd')).toBe(
      '/repos/a',
    );
  });

  it.each([
    ['without a source root', undefined, 'repo-a,repo-b'],
    ['with a source root', '/repos/root', '__workspace_root__,repo-a,repo-b'],
  ])(
    "offers a multi-repo project folder's repositories with no worktrees, %s",
    async (_label, sourceRepoPath, repoIds) => {
      useProjectsStore.setState({
        projects: [
          {
            id: 'multi-1',
            name: 'Multi',
            type: 'multi-repo',
            ...(sourceRepoPath ? { sourceRepoPath } : {}),
            repos: [
              { id: 'repo-a', name: 'a', repoPath: '/repos/a' },
              { id: 'repo-b', name: 'b', repoPath: '/repos/b' },
            ],
            worktrees: [],
          },
        ],
      } as unknown as Parameters<typeof useProjectsStore.setState>[0]);
      const projectFolder = activity({
        action: {
          type: 'worktree_pipeline',
          workspaceId: 'multi-1',
          target: { kind: 'project' },
          pipelineId: 'review',
        },
      });
      await mount(activityToFormState(projectFolder), ['all']);
      const picker = byTestId('automations-form-pipeline');
      if (!(picker instanceof HTMLButtonElement)) throw new Error('No picker');
      expect(picker.hasAttribute('disabled')).toBe(false);
      act(() => {
        picker.click();
      });
      expect(
        byTestId('pipeline-picker-stub')?.getAttribute('data-repo-ids'),
      ).toBe(repoIds);
      expect(window.api.listWorktreeRepoEntries).not.toHaveBeenCalled();
    },
  );

  it("discovers a multi-repo project folder's pipelines in the repository chosen in the picker", async () => {
    useProjectsStore.setState({
      projects: [
        {
          id: 'multi-1',
          name: 'Multi',
          type: 'multi-repo',
          repos: [
            { id: 'repo-a', name: 'a', repoPath: '/repos/a' },
            { id: 'repo-b', name: 'b', repoPath: '/repos/b' },
          ],
          worktrees: [],
        },
      ],
    } as unknown as Parameters<typeof useProjectsStore.setState>[0]);
    const projectFolder = activity({
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'multi-1',
        target: { kind: 'project' },
        pipelineId: 'review',
      },
    });
    await mount(activityToFormState(projectFolder), ['all']);
    const picker = byTestId('automations-form-pipeline');
    if (!(picker instanceof HTMLButtonElement)) throw new Error('No picker');
    act(() => {
      picker.click();
    });
    // With no saved repository and no source root, the first repository is
    // the one the picker preselects and main can run in.
    expect(byTestId('pipeline-picker-stub')?.getAttribute('data-cwd')).toBe(
      '/repos/a',
    );
    act(() => {
      byTestId('pipeline-picker-stub-choose-repo-b')?.click();
    });
    expect(byTestId('pipeline-picker-stub')?.getAttribute('data-cwd')).toBe(
      '/repos/b',
    );
  });

  it('waits for a task before discovering pipelines for an existing task', async () => {
    const task = activityToFormState(
      activity({
        action: {
          type: 'worktree_pipeline',
          workspaceId: 'workspace-1',
          target: { kind: 'task', taskId: 'base-worktree' },
          pipelineId: 'review',
        },
      }),
    );
    await mount({ ...task, pipelineTaskId: '' }, ['all']);
    expect(
      byTestId('automations-form-pipeline')?.hasAttribute('disabled'),
    ).toBe(true);
    expect(window.api.getWorktreePath).not.toHaveBeenCalled();
  });

  it('offers the project folder and an existing task on a cowork project', async () => {
    const legacyCowork = activity({
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'cowork-1',
        pipelineId: 'review',
      },
    });
    await mount(activityToFormState(legacyCowork), ['all']);
    expect(
      Array.from(
        container.querySelectorAll<HTMLInputElement>(
          '[data-testid^="automations-form-pipeline-run-in-"]',
        ),
      ).map((radio) => [radio.value, radio.checked]),
    ).toEqual([
      ['project', true],
      ['task', false],
    ]);
    expect(
      byTestId('automations-form-pipeline-project-helper')?.textContent,
    ).toBe('Runs in the project folder without creating a task.');
    expect(byTestId('automations-form-base-worktree')).toBeNull();
  });

  it('lists cowork Work Entries for an existing task', async () => {
    const coworkTask = activity({
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'cowork-1',
        target: { kind: 'task', taskId: 'entry-1' },
        pipelineId: 'review',
      },
    });
    await mount(activityToFormState(coworkTask), ['all']);
    expect(byTestId('automations-form-task')?.textContent).toContain('Entry');
    expect(byTestId('automations-form-task-stale')).toBeNull();
  });

  it('blocks save while the selected task is no longer available', async () => {
    const staleTask = activity({
      action: {
        type: 'worktree_pipeline',
        workspaceId: 'workspace-1',
        target: { kind: 'task', taskId: 'removed-worktree' },
        pipelineId: 'review',
      },
    });
    const availability = await mountWithAvailability(
      activityToFormState(staleTask),
    );
    expect(byTestId('automations-form-task-stale')?.textContent).toBe(
      'This task is no longer available. Choose another task.',
    );
    expect(availability).toHaveBeenLastCalledWith(false);
  });

  it('blocks save while the pipeline cannot be verified for no project', async () => {
    const availability = await mountWithAvailability(
      activityToFormState(activityLabeled('pipeline with no project')),
    );
    expect(availability).toHaveBeenLastCalledWith(false);
  });
});
