/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import {
  HooksSectionBody,
  type HooksSectionEntry,
  type HooksSectionRun,
} from '../hooks/HooksSectionBody';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const ENTRIES: readonly HooksSectionEntry[] = [
  {
    hook: {
      hookKey: 'workspace-repo:web:pr:create',
      triggerName: 'pr:create',
      label: 'Web App — PR Created',
      target: 'workspace-repo',
      repoId: 'web',
      repoName: 'Web App',
      actions: [{ type: 'command', label: 'npm test' }],
    },
    groupedLabel: 'PR Created',
    paused: true,
    runDisabled: false,
  },
  {
    hook: {
      hookKey: 'workspace-repo:web:pr:closed',
      triggerName: 'pr:closed',
      label: 'Web App — PR Closed',
      target: 'workspace-repo',
      repoId: 'web',
      repoName: 'Web App',
      actions: [{ type: 'chat', label: 'Chat: Summarize closure' }],
    },
    groupedLabel: 'PR Closed',
    paused: false,
    runDisabled: false,
  },
];

const COMPLETED_RUN: HooksSectionRun = {
  label: 'Web App — PR Created',
  status: 'stopped',
  outputLines: ['stopped'],
  exitCode: null,
  timedOut: false,
  durationMs: 1200,
  startedAt: 100,
};

describe('HooksSectionBody', () => {
  it('mirrors script terminal icons for default and interactive command hooks', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const commandEntry: HooksSectionEntry = {
      ...ENTRIES[0],
      hook: {
        ...ENTRIES[0].hook,
        target: 'project',
        actions: [{ type: 'command', label: 'npm test' }],
      },
    };

    act(() => {
      root.render(
        <HooksSectionBody
          identityKey="workspace/worktree"
          entries={[commandEntry]}
          runs={{}}
          unconfiguredWatchers={[]}
          onRun={() => Promise.resolve()}
        />,
      );
    });
    let run = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-hooks-run"]',
    );
    expect(run?.getAttribute('data-execution-action-button')).toBe('true');
    expect(
      run?.querySelector('[data-testid="default-hook-command-icon"]'),
    ).not.toBeNull();

    act(() => {
      root.render(
        <HooksSectionBody
          identityKey="workspace/worktree"
          entries={[
            {
              ...commandEntry,
              hook: {
                ...commandEntry.hook,
                actions: [
                  { type: 'command', label: 'read name', interactive: true },
                ],
              },
            },
          ]}
          runs={{}}
          unconfiguredWatchers={[]}
          onRun={() => Promise.resolve()}
        />,
      );
    });
    run = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-hooks-run"]',
    );
    expect(
      run?.querySelector('[data-testid="interactive-hook-command-icon"]'),
    ).not.toBeNull();
    expect(run?.getAttribute('aria-label')).toBe(
      'Run Web App — PR Created in terminal',
    );

    act(() => root.unmount());
    container.remove();
  });

  it('renders completed status copy for null, stopped, success, and numeric failures', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const runs: Readonly<Record<string, HooksSectionRun>> = {
      'failed-null': {
        ...COMPLETED_RUN,
        label: 'Failed without exit',
        status: 'failed',
      },
      stopped: {
        ...COMPLETED_RUN,
        label: 'Stopped run',
      },
      success: {
        ...COMPLETED_RUN,
        label: 'Successful run',
        status: 'success',
        exitCode: 0,
      },
      'failed-exit': {
        ...COMPLETED_RUN,
        label: 'Failed with exit',
        status: 'failed',
        exitCode: 7,
      },
    };

    act(() => {
      root.render(
        <HooksSectionBody
          identityKey="workspace/worktree"
          entries={[]}
          runs={runs}
          unconfiguredWatchers={[]}
        />,
      );
    });
    const completedToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-hooks-completed-toggle"]',
    );
    act(() => completedToggle?.click());

    expect(container.textContent).toContain('Failed without exitFailed · 1s');
    expect(container.textContent).toContain('Stopped runStopped · 1s');
    expect(container.textContent).toContain('Successful runSuccess · 1s');
    expect(container.textContent).toContain('Failed with exitExit 7 · 1s');

    act(() => root.unmount());
    container.remove();
  });

  it('groups entries, preserves paused manual runs, and expands completed cards', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onRun = jest.fn<Promise<void>, [HooksSectionEntry]>(() =>
      Promise.reject(new Error('Hook exploded')),
    );
    const onTogglePause = jest.fn();

    act(() => {
      root.render(
        <HooksSectionBody
          identityKey="workspace/worktree"
          entries={ENTRIES}
          runs={{ 'workspace-repo:web:pr:create': COMPLETED_RUN }}
          unconfiguredWatchers={[
            { key: 'trigger:pr:merged', label: 'PR Merged' },
          ]}
          onRun={onRun}
          onStop={jest.fn()}
          onTogglePause={onTogglePause}
          renderWatcherButton={(key): JSX.Element => (
            <button type="button">Watch {key}</button>
          )}
          renderSourceInfoButton={(): null => null}
          renderOutputModal={(): null => null}
        />,
      );
    });

    expect(
      container
        .querySelector('[data-testid="activity-hooks-body"]')
        ?.getAttribute('class'),
    ).toContain('space-y-3');
    const repoToggle = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('2 hooks'),
    );
    act(() => repoToggle?.click());
    const entries = container.querySelectorAll(
      '[data-testid="activity-hooks-entry"]',
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]?.querySelector('span')?.className).toContain(
      'line-through',
    );

    const runButtons = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="activity-hooks-run"]',
    );
    expect(runButtons[0]?.disabled).toBe(false);
    act(() => runButtons[0]?.click());
    expect(container.textContent).toContain('Run PR Created?');
    // The confirmation lists the hook's command, which replay blocks.
    const command = Array.from(container.querySelectorAll('pre')).find(
      (node) => node.textContent === 'npm test',
    );
    expect(command?.closest('.ph-no-capture')).not.toBeNull();
    const confirm = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Confirm',
    );
    await act(async () => {
      confirm?.click();
      await Promise.resolve();
    });
    expect(onRun).toHaveBeenCalledWith(ENTRIES[0]);
    expect(container.textContent).toContain('Hook exploded');

    const completedToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-hooks-completed-toggle"]',
    );
    act(() => completedToggle?.click());
    expect(container.textContent).toContain('Stopped · 1s');
    expect(container.textContent).toContain('PR Merged');

    act(() => root.unmount());
    container.remove();
  });

  it('auto-expands a running repo and routes stop and modal actions', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onStop = jest.fn();
    const running: HooksSectionRun = {
      ...COMPLETED_RUN,
      status: 'running',
      outputLines: ['running'],
    };

    act(() => {
      root.render(
        <HooksSectionBody
          identityKey="workspace/worktree"
          entries={ENTRIES}
          runs={{ 'workspace-repo:web:pr:create': running }}
          unconfiguredWatchers={[]}
          onRun={() => Promise.resolve()}
          onStop={onStop}
          onTogglePause={jest.fn()}
          renderWatcherButton={(): null => null}
          renderSourceInfoButton={(): null => null}
          renderOutputModal={(): null => null}
        />,
      );
    });

    const repoToggle = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('2 hooks'),
    );
    expect(repoToggle?.getAttribute('aria-expanded')).toBe('true');
    const stop = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Stop',
    );
    act(() => stop?.click());
    expect(onStop).toHaveBeenCalledWith('workspace-repo:web:pr:create');

    act(() => root.unmount());
    container.remove();
  });

  it('keeps interactive hook monitoring visible without readonly output controls', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onStop = jest.fn();
    const interactiveEntry: HooksSectionEntry = {
      ...ENTRIES[0],
      hook: {
        ...ENTRIES[0].hook,
        target: 'project',
        actions: [{ type: 'command', label: 'read name', interactive: true }],
      },
    };

    act(() => {
      root.render(
        <HooksSectionBody
          identityKey="workspace/worktree"
          entries={[interactiveEntry]}
          runs={{
            [interactiveEntry.hook.hookKey]: {
              ...COMPLETED_RUN,
              status: 'running',
              outputLines: ['terminal-only output'],
            },
          }}
          unconfiguredWatchers={[]}
          onRun={() => Promise.resolve()}
          onStop={onStop}
          renderOutputModal={(): null => null}
        />,
      );
    });

    expect(container.textContent).toContain(
      'Web App — PR Created · Running in terminal',
    );
    expect(container.textContent).not.toContain('terminal-only output');
    expect(container.querySelector('[aria-label="Enlarge output"]')).toBeNull();
    const stop = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Stop',
    );
    act(() => stop?.click());
    expect(onStop).toHaveBeenCalledWith(interactiveEntry.hook.hookKey);

    act(() => root.unmount());
    container.remove();
  });

  it('shows normal live output while a non-interactive action runs in a mixed hook', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const mixedEntry: HooksSectionEntry = {
      ...ENTRIES[0],
      hook: {
        ...ENTRIES[0].hook,
        target: 'project',
        actions: [
          { type: 'command', label: 'read name', interactive: true },
          { type: 'command', label: 'echo done' },
        ],
      },
    };
    const runningNonInteractiveAction: HooksSectionRun = {
      ...COMPLETED_RUN,
      status: 'running',
      outputLines: ['second action output'],
      activeActionIndex: 1,
    };

    act(() => {
      root.render(
        <HooksSectionBody
          identityKey="workspace/worktree"
          entries={[mixedEntry]}
          runs={{
            [mixedEntry.hook.hookKey]: runningNonInteractiveAction,
          }}
          unconfiguredWatchers={[]}
          onRun={() => Promise.resolve()}
          renderOutputModal={(): null => null}
        />,
      );
    });

    expect(container.textContent).toContain('second action output');
    expect(container.textContent).not.toContain('Running in terminal');
    expect(
      container.querySelector('[aria-label="Enlarge output"]'),
    ).not.toBeNull();

    act(() => root.unmount());
    container.remove();
  });
});
