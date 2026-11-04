/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BackgroundTray, backgroundTrayCounts } from '../BackgroundTray';
import { ComposerWorkDrawer } from '../../../ComposerWorkDrawer';
import {
  githubPullRequestBackgroundTrayRun,
  type BackgroundTrayRun,
} from '../RunRow';
import { renderToStaticMarkup } from 'react-dom/server';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  GitPullRequestIcon,
  GitMergeQueueIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
} from '@canopy/ui-shared/icons/AppIcons';
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});
const run = (
  id: string,
  status: BackgroundTrayRun['status'],
  kind: BackgroundTrayRun['kind'] = 'pipeline',
): BackgroundTrayRun => ({
  id,
  kind,
  name: id,
  status,
  startedAt: null,
  dag: {
    tiers: [['one']],
    jobs: { one: { jobId: 'one', name: 'Research', status: 'success' } },
  },
  question: null,
  repository: null,
});
describe('grouped background work', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const click = (id: string): void => {
    act(() =>
      document
        .querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
        ?.click(),
    );
  };
  it.each([
    ['succeeded', 'Succeeded'],
    ['failed', 'Failed'],
    ['cancelled', 'Cancelled'],
  ] as const)(
    'retains the outcome of a timed %s run in its disclosure text',
    (status, label) => {
      const startedAt = Date.UTC(2026, 9, 29, 12);
      act(() =>
        root.render(
          <BackgroundTray
            presentation="grouped"
            chatId="chat"
            tasks={[]}
            runs={[
              run('active', 'running'),
              {
                ...run('finished', status),
                startedAt,
                dag: {
                  tiers: [['one']],
                  jobs: {
                    one: {
                      jobId: 'one',
                      name: 'Research',
                      status: 'success',
                      completedAt: new Date(startedAt + 65_000).toISOString(),
                    },
                  },
                },
              },
            ]}
          />,
        ),
      );
      click('composer-work-drawer-toggle');
      click('background-tray-completed');
      const disclosure = document.querySelector(
        '[role="dialog"] [data-testid="background-tray-row-toggle"]',
      );
      expect(disclosure?.textContent).toContain('1m 5s');
      expect(disclosure?.textContent).toContain(label);
    },
  );
  it('separates watched runs and opens completed jobs in the shared modal', () => {
    act(() =>
      root.render(
        <BackgroundTray
          presentation="grouped"
          chatId="chat"
          tasks={[]}
          runs={[
            run('active', 'running'),
            run('watch', 'running', 'github'),
            run('finished', 'succeeded'),
          ]}
        />,
      ),
    );
    click('composer-work-drawer-toggle');
    expect(
      container.querySelector('[data-work-group="Watching"]')?.textContent,
    ).toContain('watch');
    expect(
      container.querySelector('[data-work-group="Running"]')?.textContent,
    ).toContain('active');
    expect(
      container.querySelector('[data-work-group="Running"]')?.textContent,
    ).not.toContain('watch');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    click('background-tray-completed');
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Completed work');
    const toggle = dialog?.querySelector<HTMLButtonElement>(
      '[data-testid="background-tray-row-toggle"]',
    );
    act(() => toggle?.click());
    expect(dialog?.textContent).toContain('Research');
    expect(
      dialog?.querySelector('[data-testid="background-tray-run-jobs"]'),
    ).not.toBeNull();
    act(() =>
      dialog?.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click(),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('keeps the full pending question readable when expanded without host actions', () => {
    const question =
      'Approve the migration plan before applying it.\nConfirm which repository and branch should receive the changes, and whether to run the complete validation suite.';
    act(() =>
      root.render(
        <BackgroundTray
          presentation="grouped"
          chatId="chat"
          tasks={[]}
          runs={[{ ...run('question', 'needs-input'), question }]}
        />,
      ),
    );
    click('composer-work-drawer-toggle');
    const row = container.querySelector(
      '[data-testid="background-tray-run-question"]',
    );
    const toggle = row?.querySelector<HTMLButtonElement>(
      '[data-testid="background-tray-row-toggle"]',
    );
    expect(row?.textContent).toContain(question);
    act(() => toggle?.click());
    const inspector = row?.querySelector(
      '[data-testid="background-tray-inspector"]',
    );
    expect(inspector?.textContent).toContain(question);
    act(() => toggle?.click());
    expect(row?.textContent).toContain(question);
  });
  it.each([
    ['open', null, GitPullRequestIcon],
    ['open', { position: 2 }, GitMergeQueueIcon],
    ['merged', null, GitMergeIcon],
    ['closed', null, GitPullRequestClosedIcon],
  ] as const)(
    'uses the PR lifecycle icon for %s with queue %j',
    (state, queue, Icon) => {
      act(() =>
        root.render(
          <BackgroundTray
            presentation="grouped"
            chatId="chat"
            tasks={[]}
            runs={[
              run('active', 'running'),
              githubPullRequestBackgroundTrayRun('pr-icon', {
                repository: 'acme/api',
                number: 12,
                state,
                queue,
                baseRefName: 'develop',
              }),
            ]}
          />,
        ),
      );
      click('composer-work-drawer-toggle');
      const expected = document.createElement('div');
      expected.innerHTML = renderToStaticMarkup(
        <Icon size={14} aria-hidden="true" />,
      );
      expect(
        document.querySelector(
          '[data-testid="background-tray-run-pr-icon"] svg',
        )?.innerHTML,
      ).toBe(expected.querySelector('svg')?.innerHTML);
    },
  );
  it('separates pull requests from watched workflow runs and counts them independently', () => {
    act(() =>
      root.render(
        <BackgroundTray
          presentation="grouped"
          chatId="chat"
          tasks={[]}
          runs={[
            run('pull-request', 'running', 'github-pr'),
            run('workflow', 'running', 'github'),
          ]}
        />,
      ),
    );
    click('composer-work-drawer-toggle');
    expect(
      container.querySelector('[data-work-group="Pull requests"]')?.textContent,
    ).toContain('pull-request');
    expect(
      container.querySelector('[data-work-group="Watching"]')?.textContent,
    ).toContain('workflow');
    expect(
      container.querySelector('[data-work-group="Watching"]')?.textContent,
    ).not.toContain('pull-request');
    expect(
      container.querySelector('[data-testid="composer-work-drawer-toggle"]')
        ?.textContent,
    ).toContain('Pull requests1');
  });
  it.each(['open', 'merged', 'closed'] as const)(
    'keeps a lone %s PR in Pull requests without a completed-work entry',
    (state) => {
      act(() =>
        root.render(
          <BackgroundTray
            presentation="grouped"
            chatId="chat"
            tasks={[]}
            runs={[
              githubPullRequestBackgroundTrayRun('pull-request', {
                repository: 'acme/api',
                number: 12,
                state,
                queue: null,
                baseRefName: 'develop',
              }),
            ]}
          />,
        ),
      );
      expect(
        container.querySelector('[data-testid="composer-work-drawer-toggle"]')
          ?.textContent,
      ).toContain('Pull requests1');
      click('composer-work-drawer-toggle');
      expect(
        container.querySelector('[data-work-group="Pull requests"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-work-group="Watching"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="background-tray-completed"]'),
      ).toBeNull();
    },
  );
  it.each(['grouped', 'tab'] as const)(
    'keeps all PR states out of completed history through the %s adapter',
    (presentation) => {
      const prs = [
        githubPullRequestBackgroundTrayRun('open-pr', {
          repository: 'acme/api',
          number: 1,
          state: 'open',
          queue: null,
          baseRefName: 'develop',
        }),
        githubPullRequestBackgroundTrayRun('queued-pr', {
          repository: 'acme/api',
          number: 2,
          state: 'open',
          queue: { position: 1 },
          baseRefName: 'develop',
        }),
        githubPullRequestBackgroundTrayRun('merged-pr', {
          repository: 'acme/api',
          number: 3,
          state: 'merged',
          queue: null,
          baseRefName: 'develop',
        }),
        githubPullRequestBackgroundTrayRun('closed-pr', {
          repository: 'acme/api',
          number: 4,
          state: 'closed',
          queue: null,
          baseRefName: 'develop',
        }),
      ];
      const runs = [
        ...prs,
        run('pipeline-done', 'succeeded'),
        run('workflow-done', 'completed', 'github'),
      ];
      const counts = backgroundTrayCounts({ tasks: [], runs });
      act(() =>
        root.render(
          <BackgroundTray
            presentation={presentation}
            chatId="chat"
            tasks={[]}
            runs={runs}
            renderWithDetails={
              presentation === 'tab'
                ? (_surface, detail, sections): JSX.Element => (
                    <>
                      <ComposerWorkDrawer
                        queuedCount={0}
                        background={{
                          count: counts.items,
                          needsYou: counts.needsYou,
                          running: counts.running,
                          watching: counts.watching,
                          pullRequests: counts.pullRequests,
                          sections,
                        }}
                      />
                      {detail}
                    </>
                  )
                : undefined
            }
          />,
        ),
      );
      click('composer-work-drawer-toggle');
      expect(
        container.querySelector('[data-testid="composer-work-drawer-toggle"]')
          ?.textContent,
      ).toContain('Pull requests4');
      const section = container.querySelector(
        '[data-work-group="Pull requests"]',
      );
      for (const pr of prs)
        expect(
          section?.querySelector(
            `[data-testid="background-tray-run-${pr.id}"]`,
          ),
        ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="background-tray-completed"]')
          ?.textContent,
      ).toBe('View completed 2');
      click('background-tray-completed');
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog?.querySelectorAll('[data-tray-row]')).toHaveLength(2);
      expect(dialog?.textContent).toContain('pipeline-done');
      expect(dialog?.textContent).toContain('workflow-done');
      for (const pr of prs)
        expect(
          dialog?.querySelector(`[data-testid="background-tray-run-${pr.id}"]`),
        ).toBeNull();
    },
  );
  it.each(['grouped', 'tab'] as const)(
    'keeps completed history open as work finishes through the %s adapter',
    (presentation) => {
      const render = (running: boolean, watching: boolean): void => {
        act(() =>
          root.render(
            <BackgroundTray
              presentation={presentation}
              renderWithDetails={
                presentation === 'tab'
                  ? (_surface, detail, sections): JSX.Element => (
                      <>
                        <ComposerWorkDrawer
                          queuedCount={0}
                          background={{
                            count: Number(running) + Number(watching),
                            needsYou: 0,
                            running: Number(running),
                            watching: Number(watching),
                            sections,
                          }}
                        />
                        {detail}
                      </>
                    )
                  : undefined
              }
              chatId="chat"
              tasks={[]}
              runs={[
                run('finished', 'succeeded'),
                run('active', running ? 'running' : 'succeeded'),
                run('watch', watching ? 'running' : 'succeeded', 'github'),
              ]}
            />,
          ),
        );
      };
      render(true, true);
      click('composer-work-drawer-toggle');
      click('background-tray-completed');
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      render(false, true);
      expect(document.querySelector('[role="dialog"]')).toBe(dialog);
      render(false, false);
      expect(
        container.querySelector('[data-testid="composer-work-drawer"]'),
      ).toBeNull();
      expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    },
  );
  it('keeps watcher management beside the timestamp in collapsed and expanded runs', () => {
    act(() =>
      root.render(
        <BackgroundTray
          presentation="grouped"
          chatId="chat"
          tasks={[]}
          runs={[run('watched', 'running')]}
          renderRunWatcher={() => (
            <button data-testid="test-watcher">Watchers 1</button>
          )}
        />,
      ),
    );
    click('composer-work-drawer-toggle');
    const watcher = container.querySelector('[data-testid="test-watcher"]');
    expect(watcher).not.toBeNull();
    click('background-tray-row-toggle');
    expect(
      container.querySelectorAll('[data-testid="test-watcher"]'),
    ).toHaveLength(1);
    expect(
      watcher?.closest('[data-testid="background-tray-inspector"]'),
    ).toBeNull();
    expect(watcher?.parentElement?.closest('button')).toBeNull();
    click('background-tray-row-toggle');
    expect(
      container.querySelectorAll('[data-testid="test-watcher"]'),
    ).toHaveLength(1);
  });

  it('shows only the newest five tool steps in an agent inspector', () => {
    act(() =>
      root.render(
        <BackgroundTray
          presentation="grouped"
          chatId="chat"
          tasks={[]}
          agents={[
            {
              id: 'agent',
              kind: 'codex',
              title: 'Review',
              status: 'running',
              activity: null,
              startedAt: null,
              prompt: null,
              meta: null,
              taskId: null,
              canStop: false,
              target: null,
              steps: Array.from({ length: 7 }, (_, index) => ({
                id: String(index),
                toolName: 'Read',
                input: JSON.stringify({ file_path: `step-${index}.ts` }),
              })),
            },
          ]}
        />,
      ),
    );
    click('composer-work-drawer-toggle');
    click('background-tray-row-toggle');
    const steps = container.querySelectorAll(
      '[data-testid="background-tray-agent-steps"] li',
    );
    expect(steps).toHaveLength(5);
    expect(steps[0]?.textContent).toContain('step-2.ts');
    expect(steps[4]?.textContent).toContain('step-6.ts');
  });

  it('keeps Watching management inside the expanded inspector rather than its header', () => {
    act(() =>
      root.render(
        <BackgroundTray
          presentation="grouped"
          chatId="chat"
          tasks={[]}
          runs={[run('external', 'running', 'github')]}
          renderRunWatcher={() => (
            <button data-testid="test-watcher">Manage watching</button>
          )}
        />,
      ),
    );
    click('composer-work-drawer-toggle');
    expect(container.querySelector('[data-testid="test-watcher"]')).toBeNull();
    click('background-tray-row-toggle');
    const watcher = container.querySelector('[data-testid="test-watcher"]');
    expect(watcher).not.toBeNull();
    expect(
      watcher?.closest('[data-testid="background-tray-inspector"]'),
    ).not.toBeNull();
  });

  it('starts completed work collapsed independently of the running inspector', () => {
    const render = (status: BackgroundTrayRun['status']): void => {
      act(() =>
        root.render(
          <BackgroundTray
            presentation="grouped"
            chatId="chat"
            tasks={[]}
            runs={[run('same-run', status), run('other-active', 'running')]}
          />,
        ),
      );
    };
    render('running');
    click('composer-work-drawer-toggle');
    click('background-tray-row-toggle');
    expect(
      container.querySelector('[data-testid="background-tray-run-jobs"]'),
    ).not.toBeNull();
    render('succeeded');
    click('background-tray-completed');
    const dialog = document.querySelector('[role="dialog"]');
    expect(
      dialog?.querySelector('[data-testid="background-tray-run-jobs"]'),
    ).toBeNull();
    act(() =>
      dialog
        ?.querySelector<HTMLButtonElement>(
          '[data-testid="background-tray-row-toggle"]',
        )
        ?.click(),
    );
    expect(
      dialog?.querySelector('[data-testid="background-tray-run-jobs"]'),
    ).not.toBeNull();
  });
  it('expands and collapses completed sections independently', () => {
    act(() =>
      root.render(
        <BackgroundTray
          presentation="grouped"
          chatId="chat"
          tasks={[]}
          runs={[
            run('active', 'running'),
            run('first', 'succeeded'),
            run('second', 'succeeded'),
          ]}
        />,
      ),
    );
    click('composer-work-drawer-toggle');
    click('background-tray-completed');
    const dialog = document.querySelector('[role="dialog"]');
    const first = dialog?.querySelector<HTMLButtonElement>(
      '[data-tray-row="run:first"] [data-testid="background-tray-row-toggle"]',
    );
    const second = dialog?.querySelector<HTMLButtonElement>(
      '[data-tray-row="run:second"] [data-testid="background-tray-row-toggle"]',
    );
    act(() => first?.click());
    act(() => second?.click());
    expect(first?.getAttribute('aria-expanded')).toBe('true');
    expect(second?.getAttribute('aria-expanded')).toBe('true');
    expect(
      dialog?.querySelectorAll('[data-testid="background-tray-run-jobs"]'),
    ).toHaveLength(2);
    act(() => first?.click());
    expect(first?.getAttribute('aria-expanded')).toBe('false');
    expect(second?.getAttribute('aria-expanded')).toBe('true');
    expect(
      dialog?.querySelectorAll('[data-testid="background-tray-run-jobs"]'),
    ).toHaveLength(1);
  });
  it.each(['pipeline', 'github-pr', 'github'] as const)(
    'opens %s from the row without an expanded footer CTA',
    (kind) => {
      const onOpen = jest.fn();
      act(() =>
        root.render(
          <BackgroundTray
            presentation="grouped"
            chatId="chat"
            tasks={[]}
            runs={[{ ...run('no-jobs', 'running', kind), dag: null }]}
            onOpenRun={onOpen}
          />,
        ),
      );
      click('composer-work-drawer-toggle');
      expect(
        container.querySelector('[data-testid="background-tray-row-open"]'),
      ).not.toBeNull();
      click('background-tray-row-open');
      expect(onOpen).toHaveBeenCalledWith('no-jobs');
      expect(
        container.querySelector('[data-testid="background-tray-inspector"]'),
      ).toBeNull();
      click('background-tray-row-toggle');
      expect(
        container.querySelector(
          '[data-testid="background-tray-inspector-open"]',
        ),
      ).toBeNull();
    },
  );
  it('opens a pull request from its row, which shows only the pull request', () => {
    const onOpen = jest.fn();
    act(() =>
      root.render(
        <BackgroundTray
          presentation="grouped"
          chatId="chat"
          tasks={[]}
          runs={[
            githubPullRequestBackgroundTrayRun('pr', {
              repository: 'example/canopy',
              number: 6940,
              state: 'open',
              baseRefName: 'develop',
              queue: { position: 2 },
            }),
          ]}
          onOpenRun={onOpen}
        />,
      ),
    );
    click('composer-work-drawer-toggle');
    const row = container.querySelector(
      '[data-testid="background-tray-run-pr"]',
    );
    expect(row?.textContent).not.toContain('example/canopy');
    expect(row?.textContent).not.toContain('into develop');
    expect(row?.textContent).toContain('In merge queue');
    expect(
      row?.querySelector('[data-testid="background-tray-row-toggle"]'),
    ).toBeNull();
    click('background-tray-row-open');
    expect(onOpen).toHaveBeenCalledWith('pr');
    expect(
      container.querySelector('[data-testid="background-tray-inspector"]'),
    ).toBeNull();
  });
  it('labels Resume, with Open run beside it, in the paused run’s time column', () => {
    const onOpen = jest.fn();
    const onResume = jest.fn();
    act(() =>
      root.render(
        <BackgroundTray
          presentation="grouped"
          chatId="chat"
          tasks={[]}
          runs={[
            { ...run('deploy', 'paused'), startedAt: Date.now() - 65_000 },
          ]}
          onOpenRun={onOpen}
          onResumeRun={onResume}
        />,
      ),
    );
    click('composer-work-drawer-toggle');
    const row = container.querySelector(
      '[data-testid="background-tray-run-deploy"]',
    );
    const resume = row?.querySelector(
      '[data-testid="background-tray-run-deploy-resume"]',
    );
    const open = row?.querySelector('[data-testid="background-tray-row-open"]');
    // Not the same › as View completed: both actions say what they do.
    // Screen readers tell the two actions, and the rows, apart.
    expect(resume?.textContent).toBe('Resume deploy');
    expect(open?.textContent).toBe('Open run deploy');
    // The labels take the time's place, so the other rows' times stay put.
    expect(row?.textContent).not.toContain('1m 5s');
    click('background-tray-row-toggle');
    expect(
      container.querySelector('[data-testid="background-tray-inspector-open"]'),
    ).toBeNull();
    click('background-tray-row-open');
    expect(onOpen).toHaveBeenCalledWith('deploy');
    click('background-tray-run-deploy-resume');
    expect(onResume).toHaveBeenCalledWith('deploy');
  });
  it('keeps run titles out of recorded attributes on the drawer’s labeled actions', () => {
    act(() =>
      root.render(
        <BackgroundTray
          presentation="grouped"
          chatId="chat"
          tasks={[]}
          runs={[
            { ...run('deploy', 'paused'), name: 'Private deploy' },
            { ...run('plan', 'needs-input'), name: 'Private plan' },
          ]}
          onOpenRun={jest.fn()}
          onResumeRun={jest.fn()}
          onRespondRun={jest.fn()}
        />,
      ),
    );
    click('composer-work-drawer-toggle');
    // Session replay records attributes verbatim and masks only text.
    const labels = Array.from(
      container.querySelectorAll('[aria-label]'),
      (element) => element.getAttribute('aria-label') ?? '',
    );
    expect(labels.filter((label) => label.includes('Private'))).toEqual([]);
    // The run's name still reaches a screen reader, as masked text.
    for (const id of [
      'background-tray-run-deploy-resume',
      'background-tray-run-plan-respond',
    ]) {
      const button = container.querySelector(`[data-testid="${id}"]`);
      expect(
        button?.querySelector(`.${REPLAY_MASK_CLASS}`)?.textContent,
      ).toMatch(/^Private /);
    }
  });
  it('labels Answer on a run awaiting input', () => {
    act(() =>
      root.render(
        <BackgroundTray
          presentation="grouped"
          chatId="chat"
          tasks={[]}
          runs={[run('review', 'needs-input')]}
          onRespondRun={jest.fn()}
        />,
      ),
    );
    click('composer-work-drawer-toggle');
    expect(
      container.querySelector(
        '[data-testid="background-tray-run-review-respond"]',
      )?.textContent,
    ).toBe('Answer review');
  });
  it('uses View as the only way to open a run awaiting input', () => {
    const onOpen = jest.fn();
    act(() =>
      root.render(
        <BackgroundTray
          presentation="grouped"
          chatId="chat"
          tasks={[]}
          runs={[run('review', 'needs-input')]}
          onRespondRun={onOpen}
          onOpenRun={onOpen}
        />,
      ),
    );
    click('composer-work-drawer-toggle');
    click('background-tray-row-toggle');
    expect(
      container.querySelector('[data-testid="background-tray-inspector-open"]'),
    ).toBeNull();
    click('background-tray-run-review-respond');
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('review');
  });
  it('keeps Stop in the header and uses a footer only when Open cannot fit there', () => {
    const onOpen = jest.fn();
    const onStop = jest.fn();
    act(() =>
      root.render(
        <BackgroundTray
          presentation="grouped"
          chatId="chat"
          tasks={[]}
          runs={[{ ...run('busy', 'running'), dag: null }]}
          onOpenRun={onOpen}
          onStopRun={onStop}
        />,
      ),
    );
    click('composer-work-drawer-toggle');
    expect(
      container.querySelector('[data-testid="background-tray-row-open"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="background-tray-run-busy-stop"]'),
    ).not.toBeNull();
    click('background-tray-row-toggle');
    click('background-tray-inspector-open');
    expect(onOpen).toHaveBeenCalledWith('busy');
    expect(onStop).not.toHaveBeenCalled();
  });
  it.each(['run', 'job'] as const)(
    'closes completed history when navigating to a %s',
    (destination) => {
      const onOpenRun = jest.fn();
      const onRunJobClick = jest.fn();
      act(() =>
        root.render(
          <BackgroundTray
            presentation="grouped"
            chatId="chat"
            tasks={[]}
            runs={[run('active', 'running'), run('finished', 'succeeded')]}
            onOpenRun={onOpenRun}
            onRunJobClick={onRunJobClick}
          />,
        ),
      );
      click('composer-work-drawer-toggle');
      click('background-tray-completed');
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      if (destination === 'job') {
        act(() =>
          dialog
            ?.querySelector<HTMLButtonElement>(
              '[data-testid="background-tray-row-toggle"]',
            )
            ?.click(),
        );
      }
      act(() =>
        dialog
          ?.querySelector<HTMLButtonElement>(
            destination === 'run'
              ? '[data-testid="background-tray-row-open"]'
              : '[data-job-id="one"]',
          )
          ?.click(),
      );
      if (destination === 'run') {
        expect(onOpenRun).toHaveBeenCalledWith('finished');
        expect(onRunJobClick).not.toHaveBeenCalled();
      } else {
        expect(onRunJobClick).toHaveBeenCalledWith('finished', 'one');
        expect(onOpenRun).not.toHaveBeenCalled();
      }
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(
        container.querySelector('[data-testid="composer-work-drawer"]'),
      ).not.toBeNull();
    },
  );
  it('keeps completed history without a hide action and restores focus when the last run leaves', async () => {
    const onDismiss = jest.fn();
    const props = {
      presentation: 'grouped' as const,
      chatId: 'chat',
      tasks: [],
      onDismissRun: onDismiss,
    };
    act(() =>
      root.render(
        <BackgroundTray
          {...props}
          runs={[run('active', 'running'), run('finished', 'succeeded')]}
        />,
      ),
    );
    click('composer-work-drawer-toggle');
    click('background-tray-completed');
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[role="dialog"] [data-testid="background-tray-row-toggle"]',
        )
        ?.click(),
    );
    expect(
      document.querySelector(
        '[data-testid="background-tray-run-finished-dismiss"]',
      ),
    ).toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();
    await act(async () => {
      root.render(
        <BackgroundTray {...props} runs={[run('active', 'running')]} />,
      );
      await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="composer-work-drawer-toggle"]'),
    );
  });
  it('hides completed-only work while its records remain in the chat', () => {
    act(() =>
      root.render(
        <BackgroundTray
          presentation="grouped"
          chatId="chat"
          tasks={[]}
          runs={[run('finished', 'succeeded')]}
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="composer-work-drawer"]'),
    ).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
